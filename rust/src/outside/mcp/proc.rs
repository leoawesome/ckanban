//! Running the `claude` CLI for the Connections window (`run`, `sessionStatuses`, `runLogin` of
//! `src/integrations/mcp.ts`): plain commands with a time limit, the probe session, and `claude mcp login` on a
//! pseudo-terminal. None of these block the async runtime; the terminal's blocking reads run on their own thread.

use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use super::parse::{RunOut, Session, parse_session_init, strip_ansi};

/// Called with everything a stream printed so far.
pub type OnOutput = Arc<dyn Fn(&str) + Send + Sync>;

/// Text decoded from chunks that may split a UTF-8 character (`TextDecoder` with `stream: true`).
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => self.pending.len(),
        };
        let out = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
        self.pending.drain(..valid);
        out
    }
}

/// `run`: a command with a time limit. A timeout gives code -1 and "timed out after Ns" without waiting for the
/// pipes (children of a killed CLI, e.g. MCP servers, can hold them open).
pub async fn run(bin: &str, args: &[String], timeout: Duration, cwd: &Path, on_stdout: Option<OnOutput>) -> RunOut {
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let stderr = if e.kind() == std::io::ErrorKind::NotFound {
                format!("Claude CLI not found ({bin}). Is Claude Code installed and on PATH?")
            } else {
                e.to_string()
            };
            return RunOut { code: -1, stderr, ..Default::default() };
        }
    };
    let out = Arc::new(Mutex::new(String::new()));
    let err = Arc::new(Mutex::new(String::new()));
    let read = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>, into: Arc<Mutex<String>>, cb: Option<OnOutput>| {
        tokio::spawn(async move {
            let Some(mut s) = stream else { return };
            let mut dec = Utf8Stream::default();
            let mut buf = vec![0u8; 8192];
            loop {
                match s.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = {
                            let mut t = into.lock();
                            t.push_str(&dec.push(&buf[..n]));
                            t.clone()
                        };
                        if let Some(cb) = &cb {
                            cb(&text);
                        }
                    }
                }
            }
        })
    };
    let r_out = read(child.stdout.take().map(|s| Box::new(s) as _), out.clone(), on_stdout);
    let r_err = read(child.stderr.take().map(|s| Box::new(s) as _), err.clone(), None);
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(status) => {
            let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
            let _ = r_out.await;
            let _ = r_err.await;
            RunOut { code, stdout: out.lock().clone(), stderr: err.lock().clone(), timed_out: false }
        }
        Err(_) => {
            terminate(child);
            r_out.abort();
            r_err.abort();
            RunOut { code: -1, stdout: out.lock().clone(), stderr: format!("timed out after {}s", (timeout.as_millis() as f64 / 1000.0).round() as u64), timed_out: true }
        }
    }
}

/// `sessionStatuses`: server statuses as a real Claude session sees them. `claude -p` stopped at its `init` event,
/// before any model call (the API address is a closed local port, hooks off, nothing saved). `mcp_config` holds
/// secrets: never logged. None when the session didn't report in time.
pub async fn session_statuses(bin: &str, cwd: &Path, mcp_config: Option<String>, timeout: Duration) -> Option<Session> {
    let mut cmd = Command::new(bin);
    cmd.args(["-p", "ok", "--output-format", "stream-json", "--verbose", "--tools", "", "--max-turns", "1", "--no-session-persistence", "--settings", r#"{"disableAllHooks":true}"#]);
    if let Some(cfg) = mcp_config {
        cmd.arg("--mcp-config").arg(cfg);
    }
    cmd.current_dir(cwd).env("ANTHROPIC_BASE_URL", "http://127.0.0.1:9").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let read = async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(init) = parse_session_init(&line) {
                return Some(init);
            }
        }
        None
    };
    // Don't wait for the stream to end after a timeout: children of the killed CLI can hold the pipe open.
    let found = tokio::time::timeout(timeout, read).await.ok().flatten();
    terminate(child);
    found
}

/// Bun's `p.kill()`: SIGTERM, so Claude can stop the MCP servers it started; SIGKILL (kill_on_drop) only if it is
/// still there 5 s later. The child is reaped in the background.
fn terminate(child: tokio::process::Child) {
    let mut child = child;
    if let Some(pid) = child.id() {
        // SAFETY: a plain signal to our own child's pid, which `child` still holds (not reaped yet).
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    tokio::spawn(async move {
        if tokio::time::timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    });
}

/// A running `claude mcp login` on a terminal: cancel it, or type a pasted address into it.
pub struct LoginProc {
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    exited: Mutex<bool>,
    pasted: Mutex<Vec<String>>,
}

impl LoginProc {
    pub fn kill(&self) {
        let _ = self.killer.lock().kill();
    }

    /// Types `s` (the caller adds the Enter); remembered so the address (it carries the sign-in code) is cut from
    /// error text.
    pub fn write(&self, s: &str) {
        if *self.exited.lock() {
            return;
        }
        self.pasted.lock().push(crate::js::trim(s).to_string());
        if let Some(w) = self.writer.lock().as_mut() {
            let _ = w.write_all(s.as_bytes());
            let _ = w.flush();
        }
    }
}

/// The last 64 KB of the terminal's output (Bun keeps the last 64 Ki UTF-16 units).
fn keep_tail(s: &mut String) {
    const MAX: usize = 64 * 1024;
    if s.len() > MAX {
        let mut cut = s.len() - MAX;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

/// `claude mcp login <name> --no-browser` on a pseudo-terminal (the CLI refuses to wait for the browser without
/// one). `started` gets the handle as soon as it runs; None from it means no terminal could be made, and the caller
/// falls back to `run`. The result's stdout is the terminal's text, escapes and pasted addresses cut.
pub async fn run_login(
    bin: &str,
    name: &str,
    cwd: &Path,
    timeout: Duration,
    on_output: OnOutput,
    started: impl FnOnce(Arc<LoginProc>),
) -> Option<RunOut> {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let pair = native_pty_system().openpty(PtySize { rows: 50, cols: 2000, pixel_width: 0, pixel_height: 0 }).ok()?;
    let mut cmd = CommandBuilder::new(bin);
    cmd.args(["mcp", "login", name, "--no-browser"]);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    let mut child = pair.slave.spawn_command(cmd).ok()?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().ok();
    let writer = pair.master.take_writer().ok();
    let proc = Arc::new(LoginProc {
        killer: Mutex::new(child.clone_killer()),
        writer: Mutex::new(writer),
        exited: Mutex::new(false),
        pasted: Mutex::new(Vec::new()),
    });
    let out = Arc::new(Mutex::new(String::new()));
    if let Some(mut reader) = reader {
        let (out, cb) = (out.clone(), on_output.clone());
        std::thread::spawn(move || {
            let mut dec = Utf8Stream::default();
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = {
                            let mut t = out.lock();
                            t.push_str(&dec.push(&buf[..n]));
                            keep_tail(&mut t);
                            t.clone()
                        };
                        cb(&text);
                    }
                }
            }
        });
    }
    started(proc.clone());
    let timed_out = Arc::new(Mutex::new(false));
    let timer = {
        let (proc, timed_out) = (proc.clone(), timed_out.clone());
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            *timed_out.lock() = true;
            proc.kill();
        })
    };
    let code = tokio::task::spawn_blocking(move || child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1)).await.unwrap_or(-1);
    *proc.exited.lock() = true;
    timer.abort();
    // The last output can arrive just after the exit.
    tokio::time::sleep(Duration::from_millis(50)).await;
    *proc.writer.lock() = None;
    drop(pair.master);
    let mut text = strip_ansi(&out.lock()).replace('\r', "");
    for s in proc.pasted.lock().iter().filter(|s| !s.is_empty()) {
        text = text.replace(s.as_str(), "[pasted address]");
    }
    let timed_out = *timed_out.lock();
    Some(RunOut { code, stdout: text, stderr: String::new(), timed_out })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_chunks() {
        let mut d = Utf8Stream::default();
        let b = "é✓".as_bytes();
        assert_eq!(d.push(&b[..1]), "");
        assert_eq!(d.push(&b[1..3]), "é");
        assert_eq!(d.push(&b[3..]), "✓");
    }

    #[tokio::test]
    async fn run_codes_output_and_timeouts() {
        let tmp = std::env::temp_dir();
        let r = run("/bin/sh", &["-c".into(), "echo out; echo err >&2; exit 3".into()], Duration::from_secs(5), &tmp, None).await;
        assert_eq!((r.code, r.stdout.as_str(), r.stderr.as_str()), (3, "out\n", "err\n"));
        let r = run("/bin/sh", &["-c".into(), "sleep 5".into()], Duration::from_millis(200), &tmp, None).await;
        assert_eq!((r.code, r.stderr.as_str(), r.timed_out), (-1, "timed out after 0s", true));
        let r = run("/nonexistent/claude", &[], Duration::from_secs(1), &tmp, None).await;
        assert_eq!(r.stderr, "Claude CLI not found (/nonexistent/claude). Is Claude Code installed and on PATH?");
    }

    #[tokio::test]
    async fn login_on_a_terminal_sees_a_tty_and_takes_a_paste() {
        let tmp = std::env::temp_dir().join(format!("ck-mcp-pty-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let bin = tmp.join("claude");
        std::fs::write(&bin, "#!/bin/sh\n[ -t 0 ] && echo tty\necho 'Open https://auth.example/x?code=1 to sign in'\nread line\necho \"got $line\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        let handle: Arc<Mutex<Option<Arc<LoginProc>>>> = Arc::new(Mutex::new(None));
        let h2 = handle.clone();
        // Pastes once the link is on the terminal. A busy machine can take seconds to start the script, so this waits on
        // the link itself with a long deadline (no fixed number of tries), and the login's own timeout is longer still.
        let paste = tokio::spawn(async move {
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            while std::time::Instant::now() < deadline {
                if s2.lock().contains("sign in") && h2.lock().is_some() {
                    h2.lock().as_ref().unwrap().write("http://localhost/cb?code=SECRET\r");
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            false
        });
        let cb: OnOutput = Arc::new(move |t: &str| *seen.lock() = t.to_string());
        let r = run_login(bin.to_str().unwrap(), "x", &tmp, Duration::from_secs(90), cb, |p| *handle.lock() = Some(p)).await.unwrap();
        assert!(paste.await.unwrap(), "the link never showed: {r:?}");
        assert_eq!(r.code, 0, "{r:?}");
        assert!(r.stdout.contains("tty"), "{r:?}");
        assert!(r.stdout.contains("got [pasted address]"), "{r:?}");
        assert!(!r.stdout.contains("SECRET"), "{r:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
