//! Running what the board runs without Claude: an automation's check script (`runScript`, `scriptEnv`,
//! `ckanbanShim` of `src/integrations/script.ts`) and a one-time job's command (`runCommand` of
//! `src/schedules/jobs.ts`). Each runs in its own process group, killed with everything it started when it ends or
//! times out. Blocking: the caller is on a thread of its own or the blocking pool.

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::text::{Item, parse_items};

pub const SCRIPT_TIMEOUT_MS: u64 = 60_000;
/// Most output a check may print; more is an error, not a cut-off list.
pub const OUTPUT_MAX: usize = 1_000_000;
const STDERR_KEEP: usize = 4000;
/// Command output kept in a job's result.
const OUTPUT_KEEP: usize = 4096;

/// What one check printed, or why it failed.
#[derive(Debug, Clone)]
pub struct ScriptRun {
    pub items: Option<Vec<Item>>,
    pub error: Option<String>,
    pub stderr: String,
    pub duration_ms: f64,
}

/// `ckanbanShim`: the `ckanban` command scripts call, in `<data>/automation-bin` (first on their PATH). Bun's
/// satellite writes it at its start with its own command; Rust writes it (with this program, also the `ckanban`
/// CLI) only when it isn't there, so the two don't take turns rewriting it.
pub fn ckanban_shim(root: &Path) -> PathBuf {
    let dir = root.join("automation-bin");
    let file = dir.join("ckanban");
    if !file.exists() {
        let _ = std::fs::create_dir_all(&dir);
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "ckanban".into());
        let line = format!("#!/bin/sh\nexec '{}' \"$@\"\n", exe.replace('\'', "'\\''"));
        if std::fs::write(&file, line).is_ok() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755));
        }
    }
    dir
}

/// `scriptEnv`: a clean, small environment (not the server's, which may hold other secrets).
pub fn script_env(shim_dir: &Path, port: u16, token: &str, keys: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut set = |k: &str, v: String| match out.iter_mut().find(|(x, _)| x == k) {
        Some(e) => e.1 = v,
        None => out.push((k.to_string(), v)),
    };
    for k in ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TZ"] {
        if let Some(v) = std::env::var(k).ok().filter(|v| !v.is_empty()) {
            set(k, v);
        }
    }
    if std::env::var("HOME").ok().filter(|v| !v.is_empty()).is_none() {
        set("HOME", ckanban_core::home::home_dir().to_string_lossy().into_owned());
    }
    let path = std::env::var("PATH").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into());
    set("PATH", [shim_dir.to_string_lossy().into_owned(), path, "/opt/homebrew/bin".into(), "/usr/local/bin".into()].join(":"));
    for (k, v) in keys {
        set(k, v.clone());
    }
    set("CKANBAN_PORT", port.to_string());
    set("CKANBAN_CALL_TOKEN", token.to_string());
    out
}

/// Signals the process group the child leads (its pid is the group id). Only the group: once the child has been
/// waited for, its pid may belong to another process, while the group id stays the child's group's until it is empty.
fn kill_group(pid: u32, sig: i32) {
    // SAFETY: a plain signal send to the group this server started.
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
}

/// Reads a pipe up to `max` bytes in a thread; past that it notes `over` and drops the rest.
fn capped(mut r: impl Read + Send + 'static, max: usize) -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut over = false;
        let mut buf = [0u8; 64 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out.len() + n > max {
                        over = true;
                        let keep = max.saturating_sub(out.len());
                        out.extend_from_slice(&buf[..keep]);
                    } else {
                        out.extend_from_slice(&buf[..n]);
                    }
                }
            }
        }
        let _ = tx.send((out, over));
    });
    rx
}

/// Waits for the child up to `limit`; true when it ended.
fn wait_until(child: &mut Child, limit: Instant) -> Option<std::process::ExitStatus> {
    loop {
        if let Ok(Some(st)) = child.try_wait() {
            return Some(st);
        }
        if Instant::now() >= limit {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The exit code as Bun gives it (`128 + signal` when killed).
fn code_of(st: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    st.code().unwrap_or_else(|| 128 + st.signal().unwrap_or(0))
}

/// `runScript`: the script file with bash (`pipefail`), killed after `timeout_ms`.
pub fn run_script(file: &Path, cwd: &Path, env: &[(String, String)], timeout_ms: u64) -> ScriptRun {
    let started = Instant::now();
    let ms = |s: Instant| s.elapsed().as_millis() as f64;
    let cwd = if cwd.is_dir() { cwd.to_path_buf() } else { ckanban_core::home::home_dir() };
    let mut cmd = Command::new("/bin/bash");
    cmd.arg("-o").arg("pipefail").arg(file).current_dir(&cwd).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return ScriptRun { items: None, error: Some(format!("Could not start the check: {e}")), stderr: String::new(), duration_ms: 0.0 },
    };
    let pid = child.id();
    let out_rx = capped(child.stdout.take().expect("piped stdout"), OUTPUT_MAX + 1);
    let err_rx = capped(child.stderr.take().expect("piped stderr"), 256_000);
    let status = wait_until(&mut child, started + Duration::from_millis(timeout_ms));
    let timed_out = status.is_none();
    if timed_out {
        kill_group(pid, libc::SIGKILL);
    }
    let status = status.or_else(|| child.wait().ok());
    kill_group(pid, libc::SIGKILL);
    // A background child may keep the pipes open: don't wait for it long.
    let limit = Instant::now() + Duration::from_millis(1000);
    let out = out_rx.recv_timeout(limit.saturating_duration_since(Instant::now()));
    let err = err_rx.recv_timeout(limit.saturating_duration_since(Instant::now()));
    let (Ok((out, over)), Ok((err, _))) = (out, err) else {
        return ScriptRun {
            items: None,
            error: Some("The check's output didn't finish (a program it started kept it open)".into()),
            stderr: String::new(),
            duration_ms: ms(started),
        };
    };
    let err_text = String::from_utf8_lossy(&err).into_owned();
    let stderr = if crate::runs::js::len16(&err_text) > STDERR_KEEP { crate::runs::js::tail16(&err_text, STDERR_KEEP).to_string() } else { err_text };
    let duration_ms = ms(started);
    let last_line = crate::runs::js::trim(&stderr).split('\n').next_back().unwrap_or("").to_string();
    let fail = |e: String| ScriptRun { items: None, error: Some(e), stderr: stderr.clone(), duration_ms };
    if timed_out {
        return fail(format!("The check took longer than {} s and was stopped", (timeout_ms as f64 / 1000.0).round() as u64));
    }
    let code = status.as_ref().map(code_of).unwrap_or(1);
    if code != 0 {
        return fail(format!("The check failed (exit {code}){}", if last_line.is_empty() { String::new() } else { format!(": {last_line}") }));
    }
    if over {
        return fail("The check printed more than 1 MB: return fewer items".into());
    }
    match parse_items(&String::from_utf8_lossy(&out)) {
        Ok(items) => ScriptRun { items: Some(items), error: None, stderr, duration_ms },
        Err(e) => fail(e),
    }
}

/// Keeps only the last OUTPUT_KEEP bytes of what a command printed (`Tail`).
fn tail_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).into_owned();
    if text.len() <= OUTPUT_KEEP {
        return text;
    }
    let cut = &text.as_bytes()[text.len() - OUTPUT_KEEP..];
    String::from_utf8_lossy(cut).trim_start_matches('\u{fffd}').to_string()
}

/// A running job command: stop it (and what it started) now.
#[derive(Clone)]
pub struct Stopper {
    pid: u32,
}

impl Stopper {
    pub fn stop(&self) {
        let pid = self.pid;
        kill_group(pid, libc::SIGTERM);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            kill_group(pid, libc::SIGKILL);
        });
    }
}

/// `runCommand`: `/bin/sh -c command` in cwd in its own process group, killed after `timeout_sec`. `on_start` gets
/// a stopper (shutdown). The result is a job's `result`: `{exitCode, durationMs, output, timedOut, message?}`.
pub fn run_command(command: &str, cwd: &Path, env: &[(String, String)], timeout_sec: u64, on_start: impl FnOnce(Stopper)) -> Map<String, Value> {
    let started = Instant::now();
    let ms = |s: Instant| ckanban_core::jsnum::num(s.elapsed().as_millis() as f64);
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(command).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    // `inheritedEnv()`: the server's environment without a run's identity (not the board's run identity: a job
    // command is not a board run).
    for k in crate::runs::runner::RUN_IDENTITY_ENV {
        cmd.env_remove(k);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut res = Map::new();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            res.insert("exitCode".into(), Value::Null);
            res.insert("durationMs".into(), ms(started));
            res.insert("output".into(), "".into());
            res.insert("timedOut".into(), false.into());
            res.insert("message".into(), format!("could not start the command: {e}").into());
            return res;
        }
    };
    let pid = child.id();
    on_start(Stopper { pid });
    // stdout and stderr interleaved as they come, the end kept.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)].into_iter().flatten() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut p = pipe;
            let mut buf = [0u8; 16 * 1024];
            while let Ok(n) = p.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let mut kept: Vec<u8> = Vec::new();
    let mut take = |rx: &mpsc::Receiver<Vec<u8>>, until: Option<Instant>| loop {
        let got = match until {
            Some(u) => rx.recv_timeout(u.saturating_duration_since(Instant::now())).map_err(|_| ()),
            None => rx.try_recv().map_err(|_| ()),
        };
        match got {
            Ok(c) => {
                kept.extend_from_slice(&c);
                if kept.len() > OUTPUT_KEEP * 4 {
                    kept.drain(..kept.len() - OUTPUT_KEEP * 2);
                }
            }
            Err(()) => break,
        }
    };
    let limit = started + Duration::from_secs(timeout_sec);
    let mut timed_out = false;
    let status = loop {
        take(&rx, None);
        if let Ok(Some(st)) = child.try_wait() {
            break Some(st);
        }
        if Instant::now() >= limit {
            timed_out = true;
            Stopper { pid }.stop();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    // The shell is gone; anything it left running in the background goes too.
    kill_group(pid, libc::SIGKILL);
    take(&rx, Some(Instant::now() + Duration::from_millis(1000)));
    let code = status.as_ref().map(code_of).unwrap_or(1);
    res.insert("exitCode".into(), if timed_out { Value::Null } else { code.into() });
    res.insert("durationMs".into(), ms(started));
    res.insert("output".into(), tail_text(&kept).into());
    res.insert("timedOut".into(), timed_out.into());
    if timed_out {
        res.insert("message".into(), format!("stopped after {timeout_sec} s (time limit)").into());
    } else if code != 0 {
        res.insert("message".into(), format!("exited with code {code}").into());
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_print_items() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("c.sh");
        std::fs::write(&f, "echo '{\"id\":\"1\",\"title\":\"one\"}'\necho oops >&2\n").unwrap();
        let r = run_script(&f, d.path(), &script_env(d.path(), 1, "t", &[]), 5000);
        assert_eq!(r.items.unwrap().len(), 1);
        assert_eq!(r.stderr, "oops\n");
        std::fs::write(&f, "echo bad >&2; exit 3\n").unwrap();
        let r = run_script(&f, d.path(), &[], 5000);
        assert_eq!(r.error.as_deref(), Some("The check failed (exit 3): bad"));
        std::fs::write(&f, "sleep 5\n").unwrap();
        let r = run_script(&f, d.path(), &[], 300);
        assert_eq!(r.error.as_deref(), Some("The check took longer than 0 s and was stopped"));
    }

    #[test]
    fn commands_report_like_bun() {
        let d = tempfile::tempdir().unwrap();
        let r = run_command("echo hi; echo err >&2; exit 2", d.path(), &[("X".into(), "1".into())], 10, |_| {});
        assert_eq!(r.get("exitCode"), Some(&Value::from(2)));
        assert_eq!(r.get("message"), Some(&Value::from("exited with code 2")));
        assert!(r.get("output").and_then(Value::as_str).unwrap().contains("hi"));
        let r = run_command("sleep 5", d.path(), &[], 1, |_| {});
        assert_eq!(r.get("timedOut"), Some(&Value::Bool(true)));
        assert_eq!(r.get("exitCode"), Some(&Value::Null));
    }
}
