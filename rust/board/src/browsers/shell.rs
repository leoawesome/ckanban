//! Interactive shells on a pseudo-terminal (port of `src/browser/shell.ts`): the board's Terminal panel. One shell per
//! folder (the board folder, and each ticket's own copy of it), kept across page reloads and ticket switches until
//! restarted, the board is deleted, its folder goes away or the board stops. Output is kept (up to 200 KB) so a
//! reconnecting tab replays it.
//!
//! The pty's output is read on its own thread (a blocking read), and the shell's end on another; nothing here runs on
//! the async runtime's threads except handing chunks to the connected tabs.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use regex::Regex;
use tokio::sync::mpsc;

const MAX_SCROLLBACK: usize = 200 * 1024;
/// `DEFAULT_UTF8_LOCALE` in `src/core/locale.ts`.
const DEFAULT_UTF8_LOCALE: &str = "en_US.UTF-8";

/// What a connected tab gets: output, or the shell's end with its exit code (None after a signal).
#[derive(Debug, Clone, PartialEq)]
pub enum ShellEvent {
    Data(Vec<u8>),
    Exit(Option<i64>),
}

struct Inner {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    listeners: Vec<(u64, mpsc::UnboundedSender<ShellEvent>)>,
    next: u64,
    /// None while it runs; Some(code) once it ended.
    exit: Option<Option<i64>>,
}

/// One interactive login shell on a pty.
pub struct Shell {
    inner: Mutex<Inner>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    pid: u32,
}

/// `withUtf8Locale`: a UTF-8 `LANG` unless the environment already sets one (or a non-UTF-8 `LC_ALL`).
pub fn needs_utf8_lang(lang: Option<&str>, lc_all: Option<&str>) -> bool {
    if lang.is_some_and(|l| l.to_lowercase().ends_with(".utf-8")) {
        return false;
    }
    let utf8 = Regex::new(r"(?i)utf-?8").unwrap();
    !lc_all.is_some_and(|l| !l.is_empty() && !utf8.is_match(l))
}

impl Shell {
    /// Starts `shell -l` in `cwd` (`$SHELL`, else zsh). Without a parent Claude session's or a board run's markers,
    /// so `claude` and `ckanban` work normally in it.
    pub fn spawn(cwd: &Path, cols: u16, rows: u16) -> Result<Arc<Shell>, String> {
        let mut shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
        if !Path::new(&shell).exists() {
            shell = "/bin/zsh".into();
        }
        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(&shell);
        cmd.arg("-l");
        cmd.cwd(cwd);
        for k in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CKANBAN_TICKET", "CKANBAN_SATELLITE"] {
            cmd.env_remove(k);
        }
        if needs_utf8_lang(std::env::var("LANG").ok().as_deref(), std::env::var("LC_ALL").ok().as_deref()) {
            cmd.env("LANG", DEFAULT_UTF8_LOCALE);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // The shell has its own copy; ours would keep the pty open after it ends.
        drop(pair.slave);
        let pid = child.process_id().unwrap_or(0);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let me = Arc::new(Shell {
            inner: Mutex::new(Inner { chunks: VecDeque::new(), bytes: 0, listeners: Vec::new(), next: 0, exit: None }),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            pid,
        });
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let r = me.clone();
        std::thread::Builder::new()
            .name("shell-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => r.push(&buf[..n]),
                    }
                }
                let _ = done_tx.send(());
            })
            .map_err(|e| e.to_string())?;
        let w = me.clone();
        std::thread::Builder::new()
            .name("shell-wait".into())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(s) if s.signal().is_none() => Some(i64::from(s.exit_code())),
                    _ => None,
                };
                // What the shell printed last reaches the tabs before its end (a child left behind may keep the pty
                // open: then don't wait for it).
                let _ = done_rx.recv_timeout(Duration::from_millis(500));
                let mut i = w.inner.lock();
                i.exit = Some(code);
                i.listeners.retain(|(_, tx)| tx.send(ShellEvent::Exit(code)).is_ok());
            })
            .map_err(|e| e.to_string())?;
        Ok(me)
    }

    fn push(&self, data: &[u8]) {
        let mut i = self.inner.lock();
        i.chunks.push_back(data.to_vec());
        i.bytes += data.len();
        while i.bytes > MAX_SCROLLBACK && i.chunks.len() > 1 {
            let first = i.chunks.pop_front().map_or(0, |c| c.len());
            i.bytes -= first;
        }
        i.listeners.retain(|(_, tx)| tx.send(ShellEvent::Data(data.to_vec())).is_ok());
    }

    pub fn exited(&self) -> bool {
        self.inner.lock().exit.is_some()
    }

    pub fn exit_code(&self) -> Option<Option<i64>> {
        self.inner.lock().exit
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Joins a tab: the output kept so far (oldest first), whether it already ended, and every event from now on, with
    /// nothing missed or sent twice in between. The id is for `unsubscribe`.
    pub fn subscribe(&self) -> (u64, Vec<u8>, Option<Option<i64>>, mpsc::UnboundedReceiver<ShellEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut i = self.inner.lock();
        i.next += 1;
        let id = i.next;
        let back: Vec<u8> = i.chunks.iter().flatten().copied().collect();
        if i.exit.is_none() {
            i.listeners.push((id, tx));
        }
        (id, back, i.exit, rx)
    }

    pub fn unsubscribe(&self, id: u64) {
        self.inner.lock().listeners.retain(|(i, _)| *i != id);
    }

    pub fn write(&self, data: &str) {
        if self.exited() {
            return;
        }
        if let Some(w) = self.writer.lock().as_mut() {
            let _ = w.write_all(data.as_bytes());
            let _ = w.flush();
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        if self.exited() || cols == 0 || rows == 0 {
            return;
        }
        if let Some(m) = self.master.lock().as_ref() {
            let _ = m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }

    /// Hangs up the shell and closes the pty.
    pub fn kill(&self) {
        if self.exited() {
            return;
        }
        if self.pid > 0 {
            // SAFETY: a signal to the shell this board started.
            unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGHUP) };
        }
        self.writer.lock().take();
        self.master.lock().take();
    }
}

/// One row of the process table.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub args: String,
}

static ROW_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(\d+)\s+(.*)$").unwrap());
static CLAUDE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|[\s/])claude(\s|$)|claude(-code)?/cli\.js").unwrap());

/// `isClaudeCommand` (`src/runs/claude.ts`).
pub fn is_claude_command(cmd: &str) -> bool {
    CLAUDE_RE.is_match(cmd)
}

/// `liveSessionMatch`: a claude command line with the session's id (or its title) in it.
pub fn live_session_match(commands: &[&str], id: &str, title: Option<&str>) -> bool {
    commands.iter().any(|c| is_claude_command(c) && (c.contains(id) || title.is_some_and(|t| !t.is_empty() && c.contains(t))))
}

/// `ps -axo pid=,ppid=,args=`; empty when it fails.
pub async fn process_table() -> Vec<ProcRow> {
    let out = tokio::process::Command::new("ps").args(["-axo", "pid=,ppid=,args="]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().await;
    let Ok(o) = out else { return Vec::new() };
    if !o.status.success() {
        return Vec::new();
    }
    parse_process_table(&String::from_utf8_lossy(&o.stdout))
}

pub fn parse_process_table(text: &str) -> Vec<ProcRow> {
    text.split('\n')
        .filter_map(|l| {
            let c = ROW_RE.captures(l)?;
            Some(ProcRow { pid: c[1].parse().ok()?, ppid: c[2].parse().ok()?, args: c[3].to_string() })
        })
        .collect()
}

/// The claude process with this session open that runs under one of `roots` (itself or a descendant).
pub fn session_process_under<'a>(rows: &'a [ProcRow], roots: &[u32], session_id: &str) -> Option<&'a ProcRow> {
    let parent: HashMap<u32, u32> = rows.iter().map(|r| (r.pid, r.ppid)).collect();
    let under = |pid: u32| {
        let mut p = Some(pid);
        let mut hops = 0;
        while let Some(x) = p.filter(|x| *x != 0) {
            if hops >= 64 {
                break;
            }
            if roots.contains(&x) {
                return true;
            }
            p = parent.get(&x).copied();
            hops += 1;
        }
        false
    };
    rows.iter().find(|r| live_session_match(&[&r.args], session_id, None) && under(r.pid))
}

/// Types /exit into Claude's prompt in the pty, then signals the process if it is still there (`closeSession`).
/// True once it is gone.
pub async fn close_session(shell: &Shell, pid: u32, grace: Duration) -> bool {
    let alive = |p: u32| super::board_browsers::pid_alive(p);
    async fn gone_within(pid: u32, wait: Duration, alive: &impl Fn(u32) -> bool) -> bool {
        let until = Instant::now() + wait;
        while alive(pid) {
            if Instant::now() >= until {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        true
    }
    // Ctrl+U clears anything typed in Claude's prompt; Enter goes separately so it isn't taken as part of a paste.
    shell.write("\x15/exit");
    tokio::time::sleep(Duration::from_millis(150)).await;
    shell.write("\r");
    if gone_within(pid, grace, &alive).await {
        return true;
    }
    for (sig, wait) in [(libc::SIGTERM, grace), (libc::SIGKILL, Duration::from_secs(1))] {
        // SAFETY: a signal to a claude process running in the board's own pty.
        unsafe { libc::kill(pid as libc::pid_t, sig) };
        if gone_within(pid, wait, &alive).await {
            return true;
        }
    }
    false
}

/// A ticket's Claude session open in one of the board's own ptys (the dock terminal).
pub struct OwnedSession {
    pub pid: u32,
    pub shell: Arc<Shell>,
}

impl OwnedSession {
    /// Ends it gracefully (/exit), then by signal. True once the process is gone.
    pub async fn close(&self) -> bool {
        close_session(&self.shell, self.pid, Duration::from_secs(5)).await
    }
}

type Spawn = Arc<dyn Fn(&Path, u16, u16) -> Result<Arc<Shell>, String> + Send + Sync>;

/// One shell per folder a board's Terminal panel works in (`ShellManager`): key the slug for the board folder,
/// `<slug>/<ticket id>` for a ticket's copy.
pub struct ShellManager {
    shells: Mutex<HashMap<String, (Arc<Shell>, PathBuf)>>,
    spawn: Spawn,
}

impl Default for ShellManager {
    fn default() -> Self {
        Self::new(Arc::new(Shell::spawn))
    }
}

impl ShellManager {
    pub fn new(spawn: Spawn) -> Self {
        ShellManager { shells: Mutex::new(HashMap::new()), spawn }
    }

    fn key(slug: &str, folder: Option<&str>) -> String {
        match folder {
            Some(f) => format!("{slug}/{f}"),
            None => slug.to_string(),
        }
    }

    /// The board's shell (no `folder`) or a ticket copy's, started when there is none; `restart` replaces it. Shells
    /// whose folder is gone (a removed ticket copy) are stopped first.
    pub fn get(&self, slug: &str, cwd: &Path, cols: u16, rows: u16, restart: bool, folder: Option<&str>) -> Result<Arc<Shell>, String> {
        let key = Self::key(slug, folder);
        let mut shells = self.shells.lock();
        Self::sweep(&mut shells);
        if let Some((s, at)) = shells.get(&key) {
            if !restart && at == cwd {
                return Ok(s.clone());
            }
            s.kill();
            shells.remove(&key);
        }
        let s = (self.spawn)(cwd, cols, rows)?;
        shells.insert(key, (s.clone(), cwd.to_path_buf()));
        Ok(s)
    }

    pub fn current(&self, slug: &str, folder: Option<&str>) -> Option<Arc<Shell>> {
        self.shells.lock().get(&Self::key(slug, folder)).map(|(s, _)| s.clone())
    }

    /// Stops a board's shells: its folder's and every ticket copy's.
    pub fn kill(&self, slug: &str) {
        let prefix = format!("{slug}/");
        self.shells.lock().retain(|k, (s, _)| {
            let mine = k == slug || k.starts_with(&prefix);
            if mine {
                s.kill();
            }
            !mine
        });
    }

    fn sweep(shells: &mut HashMap<String, (Arc<Shell>, PathBuf)>) {
        shells.retain(|k, (s, cwd)| {
            if !k.contains('/') || cwd.exists() {
                return true;
            }
            s.kill();
            false
        });
    }

    /// A Claude session running in one of the board's ptys (e.g. `claude --resume <id>` typed into the dock shell).
    pub async fn find_session(&self, session_id: &str) -> Option<OwnedSession> {
        let live: Vec<Arc<Shell>> = self.shells.lock().values().map(|(s, _)| s.clone()).filter(|s| !s.exited()).collect();
        if live.is_empty() {
            return None;
        }
        let rows = process_table().await;
        for s in live {
            if let Some(p) = session_process_under(&rows, &[s.pid()], session_id) {
                return Some(OwnedSession { pid: p.pid, shell: s });
            }
        }
        None
    }

    pub fn kill_all(&self) {
        for (s, _) in self.shells.lock().values() {
            s.kill();
        }
        self.shells.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn until_out(rx: &mut mpsc::UnboundedReceiver<ShellEvent>, out: &mut String, want: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Some(ShellEvent::Data(d))) => out.push_str(&String::from_utf8_lossy(&d)),
                Ok(Some(ShellEvent::Exit(c))) => out.push_str(&format!("<exit {c:?}>")),
                Ok(None) => return out.contains(want),
                Err(_) => {}
            }
            if out.contains(want) {
                return true;
            }
        }
        false
    }

    #[tokio::test]
    async fn a_shell_echoes_resizes_and_ends() {
        let d = tempfile::tempdir().unwrap();
        let m = ShellManager::default();
        let s = m.get("b", d.path(), 80, 24, false, None).unwrap();
        let (_, _, ended, mut rx) = s.subscribe();
        assert_eq!(ended, None);
        let mut out = String::new();
        s.write("echo ck-$((40+2)); stty size\n");
        assert!(until_out(&mut rx, &mut out, "ck-42").await, "{out}");
        assert!(until_out(&mut rx, &mut out, "24 80").await, "{out}");
        // The same folder gets the same shell; scrollback first.
        let again = m.get("b", d.path(), 80, 24, false, None).unwrap();
        assert!(Arc::ptr_eq(&s, &again));
        let (_, back, _, _) = again.subscribe();
        assert!(String::from_utf8_lossy(&back).contains("ck-42"));
        s.resize(100, 30);
        s.write("stty size; exit 3\n");
        assert!(until_out(&mut rx, &mut out, "<exit Some(3)>").await, "{out}");
        assert!(out.contains("30 100"));
        assert_eq!(s.exit_code(), Some(Some(3)));
        m.kill_all();
    }

    #[test]
    fn process_rows_and_sessions() {
        let rows = parse_process_table("  10     1 /bin/zsh -l\n  11    10 claude --resume abc-123\n  12     1 claude --resume abc-123\nbad\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(session_process_under(&rows, &[10], "abc-123").map(|r| r.pid), Some(11));
        assert_eq!(session_process_under(&rows, &[99], "abc-123"), None);
        assert!(is_claude_command("/usr/local/bin/claude -p"));
        assert!(!is_claude_command("claudette"));
        assert!(needs_utf8_lang(None, None));
        assert!(!needs_utf8_lang(Some("en_GB.UTF-8"), None));
        assert!(!needs_utf8_lang(None, Some("C")));
        assert!(needs_utf8_lang(Some("C"), Some("en_US.UTF-8")));
    }
}
