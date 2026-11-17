//! The artifact helper (src/runs/artifact.ts) and the page a Markdown output is published as (markdownTitle,
//! markdownPage of src/board/share.ts). Headless `claude -p` runs never get the built-in Artifact tool, so this drives
//! a short-lived interactive `claude` on a hidden terminal (a pty; Bun's tmux fallback isn't needed here), which does
//! have it, and reads the result from that session's transcript. Blocking: async callers run it in `spawn_blocking`.
//! Used by `ckanban artifact` (cli/artifact.rs), the MCP tools read_artifact and publish_artifact (mcp/artifact.rs),
//! and, through `ckanban artifact publish-output`, the Share menu's Publish (outside/edge.rs).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};

pub enum Job {
    Publish { file: String, url: Option<String>, title: Option<String> },
    Read { url: String },
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Publish,
    Read,
}

impl Job {
    fn kind(&self) -> Kind {
        match self {
            Job::Publish { .. } => Kind::Publish,
            Job::Read { .. } => Kind::Read,
        }
    }
}

#[derive(Debug, PartialEq, Clone)]
pub enum Outcome {
    Published { url: String, text: String },
    Read { html: String },
    Failed(String),
}

impl Outcome {
    /// Bun's `ArtifactOutcome` as JSON (what `artifact publish-output` prints).
    pub fn to_json(&self) -> Value {
        match self {
            Outcome::Published { url, text } => json!({ "ok": true, "kind": "publish", "url": url, "text": text }),
            Outcome::Read { html } => json!({ "ok": true, "kind": "read", "html": html }),
            Outcome::Failed(e) => json!({ "ok": false, "error": e }),
        }
    }
}

pub const ERR_LOGIN: &str = "Claude Code isn't logged in: open the Claude tab and run /login, then try again.";
pub const ERR_BYPASS: &str = "Claude Code needs a one-time OK before it can publish: open the Terminal tab, run `claude --permission-mode bypassPermissions`, choose \"Yes, I accept\", then try again.";
pub const ERR_EXITED: &str = "Claude Code closed before publishing finished. Open the Claude tab to check it starts and is logged in, then try again.";
pub const ERR_NOT_INSTALLED: &str = "Claude Code isn't installed or can't be found. Install it from claude.com/code, then try again.";
pub const ERR_NO_ARTIFACT_TOOL: &str = "Your Claude Code can't publish artifacts. Update Claude Code and check you are logged in with a claude.ai account, then try again.";

fn err_timeout(secs: u64, kind: Kind) -> String {
    let what = if kind == Kind::Read { "Reading the artifact" } else { "Publishing" };
    format!("{what} took too long (over {secs}s) and was stopped. Try again in a minute.")
}

/// Markers a board run passes down. With the first two the child counts as SDK and loses Artifact; as a child session
/// it stops saving its transcript, which is where the helper reads the result.
const PARENT_MARKERS: [&str; 9] = [
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
];

/// helperEnv: a top-level interactive Claude, not a child of the run that called it.
pub fn helper_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = env.iter().filter(|(k, _)| !PARENT_MARKERS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    out.insert("CLAUDE_CODE_ARTIFACT_AUTO_OPEN".into(), "0".into());
    out
}

fn read_prompt(url: &str) -> String {
    format!("Call the Artifact tool once with action \"read\" and url {url}. Do nothing else: no other tools, no summary. Then reply DONE.")
}

/// jobPrompts: the messages the helper session gets, one per turn. Republishing needs two: the service refuses a
/// publish unless this session viewed the live version in an earlier turn.
fn job_prompts(job: &Job) -> Vec<String> {
    match job {
        Job::Read { url } => vec![read_prompt(url)],
        Job::Publish { file, url, title } => {
            let title = title.as_ref().map(|t| format!(" Use the title {}.", ckanban_board::runs::js::stringify(&Value::String(t.clone())))).unwrap_or_default();
            let rules = "Publish the file exactly as it is on disk: it already contains the latest live content plus the new edits. Do not read, edit or rewrite it yourself and call no other tools. Then reply DONE.";
            match url {
                None => vec![format!("Publish the file {file} with the Artifact tool.{title} {rules}")],
                Some(url) => vec![
                    read_prompt(url),
                    format!("Now publish the file {file} with the Artifact tool, passing url {url}, so it becomes a new version at that same link.{title} {rules}"),
                ],
            }
        }
    }
}

static PUBLISHED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Published (\S+) at (https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]+)").unwrap());
static NO_TOOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"No such tool available: Artifact|Artifact exists but is not enabled").unwrap());
static LOGIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Select login method|Please run /login|Not logged in|Invalid API key").unwrap());
static TOOL_ERR_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?tool_use_error>").unwrap());

/// JS truthiness.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|c| match c {
                Value::String(s) => s.clone(),
                _ => c.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// extractReadHtml: the page source from a read result, minus the document shell the viewer adds.
pub fn extract_read_html(text: &str) -> Option<String> {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<cowritten-artifact-html>\n((?s:.)*?)\n</cowritten-artifact-html>").unwrap());
    static SHELL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^<!doctype html><html><head>(?s:.)*?</head><body>\n").unwrap());
    static END: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)</body></html>\s*$").unwrap());
    static END_STRIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\n?</body></html>\s*$").unwrap());
    let html = TAG.captures(text)?.get(1)?.as_str().to_string();
    if let Some(shell) = SHELL.find(&html)
        && END.is_match(&html)
    {
        let rest = &html[shell.end()..];
        return Some(END_STRIP.replace(rest, "").into_owned());
    }
    Some(html)
}

/// findOutcome: the helper session's answer to the job, or None while it is still working.
fn find_outcome(raw: &str, kind: Kind) -> Option<Outcome> {
    let mut uses: HashMap<String, Value> = HashMap::new();
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        let Some(content) = ev.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else { continue };
        for b in content {
            let ty = b.get("type").and_then(Value::as_str);
            if ty == Some("tool_use") && b.get("name").and_then(Value::as_str) == Some("Artifact") {
                let id = b.get("id").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                uses.insert(id, b.get("input").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({})));
            }
            if ty != Some("tool_result") {
                continue;
            }
            let text = result_text(b.get("content"));
            if NO_TOOL.is_match(&text) {
                return Some(Outcome::Failed(ERR_NO_ARTIFACT_TOOL.into()));
            }
            let id = b.get("tool_use_id").map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default();
            let Some(input) = uses.get(&id) else { continue };
            let action = input.get("action").and_then(Value::as_str).unwrap_or("publish");
            let file_path = input.get("file_path").filter(|v| truthy(v));
            let relevant = match kind {
                Kind::Read => action == "read",
                Kind::Publish => action == "publish" || file_path.is_some(),
            };
            if !relevant {
                continue;
            }
            let is_error = b.get("is_error").is_some_and(truthy);
            if is_error || text.contains("<tool_use_error>") {
                return Some(Outcome::Failed(TOOL_ERR_TAG.replace_all(&text, "").trim().to_string()));
            }
            if kind == Kind::Read {
                return Some(match extract_read_html(&text) {
                    Some(html) => Outcome::Read { html },
                    None => Outcome::Failed("read result had no page source".into()),
                });
            }
            let m = PUBLISHED.captures(&text);
            let url = m
                .as_ref()
                .and_then(|m| m.get(2))
                .map(|g| g.as_str().to_string())
                .or_else(|| ev.get("toolUseResult").and_then(|r| r.get("url")).and_then(Value::as_str).map(str::to_string));
            return Some(match url {
                Some(url) => {
                    let text = match &m {
                        Some(m) => m.get(0).unwrap().as_str().to_string(),
                        None => format!("Published {} at {url}", file_path.map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_else(|| "undefined".into())),
                    };
                    Outcome::Published { url, text }
                }
                None => Outcome::Failed(text.trim().to_string()),
            });
        }
    }
    None
}

/// screenText: screen text from raw terminal output, escape sequences dropped, cursor-forward moves turned back into
/// spaces.
pub fn screen_text(raw: &str) -> String {
    static FWD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[(\d*)C").unwrap());
    static OSC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)").unwrap());
    static CSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap());
    static OTHER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMc]").unwrap());
    let s = FWD.replace_all(raw, |c: &regex::Captures| {
        let n: usize = c[1].parse().unwrap_or(0);
        " ".repeat(if n == 0 { 1 } else { n })
    });
    let s = OSC.replace_all(&s, "");
    let s = CSI.replace_all(&s, "");
    OTHER.replace_all(&s, "").into_owned()
}

#[derive(Debug, PartialEq)]
enum Pane {
    Trust,
    Bypass,
    Login,
}

/// paneState: interactive prompts the helper may hit before its prompt runs.
fn pane_state(pane: &str, typed: &[String]) -> Option<Pane> {
    static BYPASS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Bypass Permissions mode").unwrap());
    if pane.contains("Yes, I trust this folder") {
        return Some(Pane::Trust);
    }
    if BYPASS.is_match(pane) && pane.contains("Yes, I accept") {
        return Some(Pane::Bypass);
    }
    // The screen also shows what we typed (title, file path), so a login phrase in there proves nothing.
    if LOGIN.is_match(pane) && !typed.iter().any(|t| LOGIN.is_match(t)) {
        return Some(Pane::Login);
    }
    None
}

/// friendly: plain wording for errors the helper session reports.
fn friendly(o: Outcome) -> Outcome {
    match o {
        Outcome::Failed(e) if LOGIN.is_match(&e) => Outcome::Failed(ERR_LOGIN.into()),
        o => o,
    }
}

pub struct Options {
    pub bin: Option<String>,
    pub model: Option<String>,
    pub timeout: Duration,
    /// Folder the helper runs in; ckanban owns it, so accepting Claude's trust prompt there is safe.
    pub cwd: Option<PathBuf>,
    pub poll: Duration,
    /// Environment the helper starts from (default: this process's).
    pub env: Option<HashMap<String, String>>,
}

impl Default for Options {
    fn default() -> Self {
        Options { bin: None, model: None, timeout: Duration::from_secs(180), cwd: None, poll: Duration::from_secs(1), env: None }
    }
}

/// Process groups of the helpers running now, so a SIGINT/SIGTERM to `ckanban artifact` stops them too (Bun's
/// `onSignal`). Slots hold a pid or 0.
static RUNNING: [AtomicI32; 16] = [const { AtomicI32::new(0) }; 16];

fn track(pid: i32) -> Option<usize> {
    RUNNING.iter().position(|s| s.compare_exchange(0, pid, Ordering::SeqCst, Ordering::SeqCst).is_ok())
}

extern "C" fn on_signal(_: libc::c_int) {
    for s in &RUNNING {
        let pid = s.load(Ordering::SeqCst);
        if pid > 0 {
            // SAFETY: kill is async-signal-safe; the group is the helper this process started.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
        }
    }
    // SAFETY: _exit is async-signal-safe.
    unsafe { libc::_exit(130) }
}

/// For the `ckanban artifact` command: SIGINT and SIGTERM stop the helper's Claude, then exit 130.
pub fn stop_helpers_on_signal() {
    // SAFETY: installs a handler that only calls async-signal-safe functions.
    unsafe {
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
    }
}

const SCREEN_KEEP: usize = 32 * 1024;

/// The hidden interactive `claude` a job talks to, on a pty.
struct Session {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Option<Box<dyn Write + Send>>,
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    out: Arc<Mutex<String>>,
    pid: i32,
    slot: Option<usize>,
    exited: bool,
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

impl Session {
    fn start(bin: &str, cwd: &Path, session_id: &str, model: &str, prompt: &str, env: &HashMap<String, String>) -> Result<Session, String> {
        use portable_pty::{CommandBuilder, PtySize, native_pty_system};
        let pair = native_pty_system().openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 }).map_err(|_| ERR_NOT_INSTALLED.to_string())?;
        let mut cmd = CommandBuilder::new(bin);
        cmd.args(["--model", model, "--permission-mode", "bypassPermissions", "--session-id", session_id, prompt]);
        cmd.cwd(cwd);
        cmd.env_clear();
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd).map_err(|_| ERR_NOT_INSTALLED.to_string())?;
        drop(pair.slave);
        let pid = child.process_id().map(|p| p as i32).unwrap_or(0);
        let out = Arc::new(Mutex::new(String::new()));
        if let Ok(mut reader) = pair.master.try_clone_reader() {
            let out = out.clone();
            std::thread::spawn(move || {
                let mut pending: Vec<u8> = Vec::new();
                let mut buf = vec![0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            pending.extend_from_slice(&buf[..n]);
                            // Keep an unfinished UTF-8 character for the next read (TextDecoder's stream mode).
                            let cut = match std::str::from_utf8(&pending) {
                                Ok(_) => pending.len(),
                                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                                Err(_) => pending.len(),
                            };
                            let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
                            pending.drain(..cut);
                            let mut o = out.lock().unwrap();
                            o.push_str(&text);
                            if o.len() > SCREEN_KEEP {
                                let mut from = o.len() - SCREEN_KEEP;
                                while !o.is_char_boundary(from) {
                                    from += 1;
                                }
                                o.drain(..from);
                            }
                        }
                    }
                }
            });
        }
        let writer = pair.master.take_writer().ok();
        let slot = if pid > 0 { track(pid) } else { None };
        Ok(Session { child, writer, master: Some(pair.master), out, pid, slot, exited: false })
    }

    fn alive(&mut self) -> bool {
        if !self.exited && !matches!(self.child.try_wait(), Ok(None)) {
            self.exited = true;
        }
        !self.exited
    }

    fn write(&mut self, s: &str) {
        if !self.alive() {
            return;
        }
        if let Some(w) = self.writer.as_mut() {
            let _ = w.write_all(s.as_bytes());
            let _ = w.flush();
        }
    }

    /// Types a message and submits it.
    fn type_text(&mut self, text: &str) {
        self.write(text);
        std::thread::sleep(Duration::from_millis(300));
        self.write("\r");
    }

    /// Accepts the folder trust prompt (its default answer is "No, exit").
    fn accept_trust(&mut self) {
        self.write("\x1b[B");
        std::thread::sleep(Duration::from_millis(200));
        self.write("\r");
    }

    /// What the screen shows lately, or None once Claude has exited.
    fn screen(&mut self) -> Option<String> {
        if !self.alive() {
            return None;
        }
        Some(screen_text(&self.out.lock().unwrap()))
    }

    fn clear(&mut self) {
        self.out.lock().unwrap().clear();
    }

    /// Claude leads its own session on the terminal, so its group holds the tools it started too: SIGTERM, then
    /// SIGKILL after 2s.
    fn kill(&mut self) {
        if self.alive() && self.pid > 0 {
            // SAFETY: signals to the process group of the helper this session started.
            unsafe {
                if libc::kill(-self.pid, libc::SIGTERM) != 0 {
                    libc::kill(self.pid, libc::SIGTERM);
                }
            }
            let until = Instant::now() + Duration::from_secs(2);
            while Instant::now() < until && self.alive() {
                std::thread::sleep(Duration::from_millis(50));
            }
            if self.alive() {
                // SAFETY: as above.
                unsafe {
                    if libc::kill(-self.pid, libc::SIGKILL) != 0 {
                        libc::kill(self.pid, libc::SIGKILL);
                    }
                }
                let _ = self.child.wait();
            }
        }
        self.writer = None;
        self.master = None;
        if let Some(i) = self.slot.take() {
            RUNNING[i].store(0, Ordering::SeqCst);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
    }
}

/// runArtifactJob. Blocks for up to `o.timeout` (plus a few seconds to stop Claude).
pub fn run_job(job: &Job, o: &Options) -> Outcome {
    let base: HashMap<String, String> = o.env.clone().unwrap_or_else(|| std::env::vars().collect());
    let cwd = o.cwd.clone().unwrap_or_else(|| crate::settings::data_root().join("artifact-helper"));
    let _ = std::fs::create_dir_all(&cwd);
    let session_id = uuid_v4();
    let env = helper_env(&base);
    let projects = ckanban_board::sessions::files::projects_dir(base.get("CLAUDE_CONFIG_DIR").map(Path::new));
    let prompts = job_prompts(job);
    let bin = o.bin.clone().filter(|b| !b.is_empty()).unwrap_or_else(|| "claude".into());
    let model = o.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "haiku".into());
    let mut session = match Session::start(&bin, &cwd, &session_id, &model, &prompts[0], &env) {
        Ok(s) => s,
        Err(e) => return Outcome::Failed(e),
    };
    // Each step's outcome is what that turn's tool call returned; only the last one is the job's.
    let last = prompts.len() - 1;
    let steps: Vec<Kind> = (0..prompts.len()).map(|i| if i < last { Kind::Read } else { job.kind() }).collect();
    let mut step = 0;
    // Once Claude writes its transcript it got past startup, so a login screen is no longer the question.
    let mut started = false;
    let transcript = |step: usize, started: &mut bool| -> Option<Outcome> {
        let file = ckanban_board::sessions::files::find_session_file(&projects, &session_id)?;
        *started = true;
        find_outcome(&std::fs::read_to_string(file).unwrap_or_default(), steps[step])
    };
    let deadline = Instant::now() + o.timeout;
    let mut trusted = false;
    let result = loop {
        if Instant::now() >= deadline {
            break Outcome::Failed(err_timeout((o.timeout.as_millis() as f64 / 1000.0).round() as u64, job.kind()));
        }
        std::thread::sleep(o.poll);
        let outcome = transcript(step, &mut started);
        match outcome {
            Some(out) if matches!(out, Outcome::Failed(_)) || step == last => break friendly(out),
            Some(_) => {
                step += 1;
                session.type_text(&prompts[step]);
                continue;
            }
            None => {}
        }
        let Some(screen) = session.screen() else {
            // It may have written its answer just before it closed.
            match transcript(step, &mut started) {
                Some(out) if matches!(out, Outcome::Failed(_)) || step == last => break friendly(out),
                _ => break Outcome::Failed(ERR_EXITED.into()),
            }
        };
        match pane_state(&screen, &prompts) {
            Some(Pane::Trust) if !trusted => {
                trusted = true;
                session.clear();
                session.accept_trust();
            }
            Some(Pane::Bypass) => break Outcome::Failed(ERR_BYPASS.into()),
            Some(Pane::Login) if !started => break Outcome::Failed(ERR_LOGIN.into()),
            _ => {}
        }
    };
    session.kill();
    result
}

// ---- The page a Markdown output is published as (src/board/share.ts) ----

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// markdownTitle: the first `#` or `##` heading, else the file name without its extension.
pub fn markdown_title(md: &str, file: &str) -> String {
    static H: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#{1,2}[ \t\n\r\f\v]+(.+?)[ \t\f\v]*#*[ \t\f\v]*$").unwrap());
    static MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*_`]").unwrap());
    static EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(md|markdown)$").unwrap());
    // JS's `.` stops at \r too, and `$` (multiline) before \n only: match line by line on \n.
    for line in md.split('\n') {
        if let Some(c) = H.captures(line)
            && !c[1].contains('\r')
        {
            return MARKS.replace_all(&c[1], "").trim().to_string();
        }
    }
    let base = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    EXT.replace(&base, "").into_owned()
}

const PAGE_CSS: &str = r#"
:root{--bg:#fbfaf7;--text:#1f1e1b;--muted:#74716a;--border:#e2dfd6;--code:#efede7;--link:#2b5fb8;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#1a1917;--text:#ecebe6;--muted:#9c998f;--border:#3a3834;--code:#2d2b28;--link:#86aef0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:860px;margin:0 auto;padding:40px 24px 80px}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .6em}h1{font-size:2em;margin-top:0}h2{font-size:1.45em;padding-bottom:.25em;border-bottom:1px solid var(--border)}h3{font-size:1.2em}
p,ul,ol,table,pre,blockquote{margin:0 0 1em}
a{color:var(--link)}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:.12em .35em;border-radius:4px}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0;font-size:.85em}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
th,td{border:1px solid var(--border);padding:6px 12px;text-align:left;vertical-align:top}th{background:var(--code)}
blockquote{border-left:3px solid var(--border);margin-left:0;padding-left:16px;color:var(--muted)}
hr{border:0;border-top:1px solid var(--border);margin:2em 0}
img{max-width:100%}
"#;

/// markdownPage: a self-contained page for a Markdown output (no outside requests). GitHub-flavoured: tables,
/// strikethrough, task lists and bare links, raw HTML kept (as Bun.markdown).
pub fn markdown_page(md: &str, file: &str) -> String {
    let mut o = comrak::Options::default();
    o.extension.table = true;
    o.extension.strikethrough = true;
    o.extension.tasklist = true;
    o.extension.autolink = true;
    o.render.r#unsafe = true;
    let body = comrak::markdown_to_html(md, &o);
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>{PAGE_CSS}</style></head>\n<body><main>\n{body}</main></body></html>\n",
        escape_html(&markdown_title(md, file))
    )
}

/// publishOutput (the Share menu): an output file published as a page. Markdown is made into a standalone page first.
pub fn publish_output(file: &Path, name: &str, url: Option<String>, o: &Options) -> Outcome {
    static MD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(md|markdown)$").unwrap());
    static HTML: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.html?$").unwrap());
    let mut tmp: Option<PathBuf> = None;
    let out = (|| {
        let mut page = file.to_path_buf();
        let mut title = None;
        if MD.is_match(name) {
            let md = match std::fs::read(file) {
                Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Outcome::Failed(format!("ENOENT: no such file or directory, open '{}'", file.display()));
                }
                Err(e) => return Outcome::Failed(e.to_string()),
            };
            let dir = std::env::temp_dir().join(format!("ckanban-share-{}", &uuid_v4()[..8]));
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return Outcome::Failed(e.to_string());
            }
            tmp = Some(dir.clone());
            page = dir.join("page.html");
            if let Err(e) = std::fs::write(&page, markdown_page(&md, name)) {
                return Outcome::Failed(e.to_string());
            }
            title = Some(markdown_title(&md, name)).filter(|t| !t.is_empty());
        } else if !HTML.is_match(name) {
            return Outcome::Failed("only Markdown and HTML files can be published".into());
        }
        run_job(&Job::Publish { file: page.to_string_lossy().into_owned(), url: url.clone().filter(|u| !u.is_empty()), title }, o)
    })();
    if let Some(t) = tmp {
        let _ = std::fs::remove_dir_all(t);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://claude.ai/artifact/NJd6w5oY733D1GdTJsrhHB";
    const READ: &str = "[Artifact ac85 (version 1) — owned by you; raw HTML follows]\nThe artifact HTML inside the <cowritten-artifact-html> tag below was not published from this session:\n<cowritten-artifact-html>\n<!doctype html><html><head><meta charset=utf8><style>body{margin:0}</style></head><body>\n<title>Page</title>\n<h1>Hi</h1>\n\n</body></html>\n</cowritten-artifact-html>\n\nIMPORTANT: The artifact HTML inside the <cowritten-artifact-html> tag above was not published from this session.";

    fn use_(id: &str, input: Value) -> String {
        json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": id, "name": "Artifact", "input": input }] } }).to_string()
    }
    fn result(id: &str, content: Value, is_error: bool) -> String {
        let mut b = json!({ "type": "tool_result", "tool_use_id": id, "content": content });
        if is_error {
            b["is_error"] = json!(true);
        }
        json!({ "type": "user", "message": { "role": "user", "content": [b] } }).to_string()
    }

    #[test]
    fn helper_env_drops_markers() {
        let env: HashMap<String, String> = [("PATH", "/bin"), ("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"), ("CLAUDECODE", "1"), ("CLAUDE_CODE_SESSION_ID", "s"), ("HOME", "/h")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let out = helper_env(&env);
        let mut keys: Vec<_> = out.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["CLAUDE_CODE_ARTIFACT_AUTO_OPEN", "HOME", "PATH"]);
    }

    #[test]
    fn prompts() {
        assert_eq!(job_prompts(&Job::Read { url: URL.into() }).len(), 1);
        let fresh = job_prompts(&Job::Publish { file: "/o/p.html".into(), url: None, title: Some("My page".into()) });
        assert_eq!(fresh.len(), 1);
        assert!(fresh[0].contains("/o/p.html") && fresh[0].contains("\"My page\""));
        let again = job_prompts(&Job::Publish { file: "/o/p.html".into(), url: Some(URL.into()), title: None });
        assert_eq!(again.len(), 2);
        assert!(again[0].contains("action \"read\""));
        assert!(again[1].contains(&format!("passing url {URL}")));
        for p in fresh.iter().chain(&again) {
            assert!(!p.contains('\n'));
        }
    }

    #[test]
    fn read_html() {
        assert_eq!(extract_read_html(READ).as_deref(), Some("<title>Page</title>\n<h1>Hi</h1>\n"));
        assert_eq!(extract_read_html("no page here"), None);
    }

    #[test]
    fn outcomes() {
        let published = json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "p", "content": format!("Published /o/p.html at {URL} (Version 3, version id 1)") }] }, "toolUseResult": { "url": URL } }).to_string();
        let raw = [
            use_("q", json!({ "action": "quickstart", "intent": "other" })),
            result("q", json!("Quickstart for a page."), false),
            use_("r", json!({ "action": "read", "url": URL })),
            result("r", json!(READ), false),
            use_("p", json!({ "file_path": "/o/p.html", "url": URL })),
            published,
        ]
        .join("\n");
        assert_eq!(find_outcome(&raw, Kind::Publish), Some(Outcome::Published { url: URL.into(), text: format!("Published /o/p.html at {URL}") }));
        assert_eq!(find_outcome(&raw, Kind::Read), Some(Outcome::Read { html: "<title>Page</title>\n<h1>Hi</h1>\n".into() }));

        assert_eq!(find_outcome(&use_("p", json!({ "file_path": "/o/p.html" })), Kind::Publish), None);
        assert_eq!(find_outcome("garbage\n", Kind::Publish), None);
        let refused = [use_("p", json!({ "file_path": "/o/p.html", "url": URL })), result("p", json!("You hadn't viewed the live version of this artifact, so the publish was refused."), false)].join("\n");
        assert_eq!(find_outcome(&refused, Kind::Publish), Some(Outcome::Failed("You hadn't viewed the live version of this artifact, so the publish was refused.".into())));
        let missing = [use_("p", json!({ "file_path": "/o/p.html" })), result("p", json!("<tool_use_error>Error: No such tool available: Artifact</tool_use_error>"), true)].join("\n");
        assert_eq!(find_outcome(&missing, Kind::Publish), Some(Outcome::Failed(ERR_NO_ARTIFACT_TOOL.into())));
        let errored = [use_("p", json!({ "file_path": "/o/p.html" })), result("p", json!("<tool_use_error>file too big</tool_use_error>"), true)].join("\n");
        assert_eq!(find_outcome(&errored, Kind::Publish), Some(Outcome::Failed("file too big".into())));
    }

    #[test]
    fn panes() {
        assert_eq!(pane_state("Quick safety check\n ❯ No, exit\n   Yes, I trust this folder", &[]), Some(Pane::Trust));
        assert_eq!(pane_state("WARNING: Claude Code running in Bypass Permissions mode\n ❯ No, exit\n   Yes, I accept", &[]), Some(Pane::Bypass));
        assert_eq!(pane_state("⏺ Artifact(read ...)", &[]), None);
        assert_eq!(pane_state("Select login method", &[]), Some(Pane::Login));
        assert_eq!(pane_state("❯ Publish ... Use the title \"Invalid API key handling\".", &["Use the title \"Invalid API key handling\".".into()]), None);
        assert_eq!(screen_text("\x1b[1mYes,\x1b[1CI trust\x1b[0m this folder\x1b]0;title\x07"), "Yes, I trust this folder");
        assert_eq!(pane_state(&screen_text("\x1b[2J\x1b[31mPlease run /login\x1b[0m"), &[]), Some(Pane::Login));
    }

    #[test]
    fn markdown() {
        assert_eq!(markdown_title("intro\n## The *Plan* ##\n# Later", "x.md"), "The Plan");
        assert_eq!(markdown_title("no heading", "dir/Report.MD"), "Report");
        let page = markdown_page("# A & B\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~ - [x] done https://example.com\n", "r.md");
        assert!(page.starts_with("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"));
        assert!(page.contains("<title>A &amp; B</title><style>\n:root{--bg:#fbfaf7;"));
        assert!(page.contains("<table>") && page.contains("<del>old</del>") && page.contains("<a href=\"https://example.com\">"));
        assert!(page.ends_with("</main></body></html>\n"));
    }

    // runArtifactJob on a pty with a fake `claude` (a shell script).
    const FAKE: &str = r#"#!/bin/sh
sid=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && sid="$a"; prev="$a"; done
dir="$CLAUDE_CONFIG_DIR/projects/fake"; mkdir -p "$dir"; f="$dir/$sid.jsonl"
echo $$ > "$FAKE_PID"
pub() {
  echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"p","name":"Artifact","input":{"file_path":"/o/p.html"}}]}}' >> "$f"
  echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"p","content":"Published /o/p.html at https://claude.ai/artifact/abc (Version 1)"}]}}' >> "$f"
}
case "$FAKE_MODE" in
  publish) pub ;;
  republish)
    echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r","name":"Artifact","input":{"action":"read","url":"u"}}]}}' >> "$f"
    printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"r","content":"<cowritten-artifact-html>\nx\n</cowritten-artifact-html>"}]}}' >> "$f"
    while read line; do case "$line" in *"Now publish"*) break ;; esac; done
    pub ;;
  login) echo "Not logged in · Please run /login" ;;
  echo) echo "❯ $prev"; sleep 0.3; pub ;;
  exit) exit 0 ;;
esac
sleep 60
"#;

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture(mode: &str) -> (TempDir, Options, PathBuf) {
        let dir = TempDir(std::env::temp_dir().join(format!("ck-artifact-{}", uuid_v4())));
        std::fs::create_dir_all(dir.path()).unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, FAKE).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert("CLAUDE_CONFIG_DIR".into(), dir.path().join("config").to_string_lossy().into());
        env.insert("FAKE_MODE".into(), mode.into());
        let pid = dir.path().join("pid");
        env.insert("FAKE_PID".into(), pid.to_string_lossy().into());
        let o = Options {
            bin: Some(bin.to_string_lossy().into()),
            model: None,
            timeout: Duration::from_secs(10),
            cwd: Some(dir.path().join("helper")),
            poll: Duration::from_millis(50),
            env: Some(env),
        };
        (dir, o, pid)
    }

    fn alive(pid_file: &Path) -> bool {
        let pid: i32 = std::fs::read_to_string(pid_file).unwrap().trim().parse().unwrap();
        // SAFETY: signal 0 only checks the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn publish(file: &str) -> Job {
        Job::Publish { file: file.into(), url: None, title: None }
    }

    #[test]
    fn job_on_a_pty() {
        let (_d, o, pid) = fixture("publish");
        let r = run_job(&publish("/o/p.html"), &o);
        assert_eq!(r, Outcome::Published { url: "https://claude.ai/artifact/abc".into(), text: "Published /o/p.html at https://claude.ai/artifact/abc".into() });
        assert!(!alive(&pid));

        let (_d, o, _) = fixture("republish");
        let r = run_job(&Job::Publish { file: "/o/p.html".into(), url: Some(URL.into()), title: None }, &o);
        assert!(matches!(r, Outcome::Published { ref url, .. } if url == "https://claude.ai/artifact/abc"), "{r:?}");

        let (_d, mut o, pid) = fixture("hang");
        o.timeout = Duration::from_secs(3);
        let r = run_job(&publish("/o/p.html"), &o);
        assert!(matches!(r, Outcome::Failed(ref e) if e.contains("took too long")), "{r:?}");
        assert!(!alive(&pid));

        let (_d, o, _) = fixture("login");
        assert_eq!(run_job(&publish("/o/p.html"), &o), Outcome::Failed(ERR_LOGIN.into()));
        let (_d, o, _) = fixture("exit");
        assert_eq!(run_job(&publish("/o/p.html"), &o), Outcome::Failed(ERR_EXITED.into()));
        let (_d, mut o, _) = fixture("publish");
        o.bin = Some("/nonexistent/claude".into());
        assert_eq!(run_job(&publish("/o/p.html"), &o), Outcome::Failed(ERR_NOT_INSTALLED.into()));

        let (_d, o, _) = fixture("echo");
        let r = run_job(&Job::Publish { file: "/o/p.html".into(), url: None, title: Some("Fix: Not logged in banner".into()) }, &o);
        assert!(matches!(r, Outcome::Published { .. }), "{r:?}");
    }

    #[test]
    fn publish_output_refuses_other_files() {
        let o = Options::default();
        assert_eq!(publish_output(Path::new("/x/data.txt"), "data.txt", None, &o), Outcome::Failed("only Markdown and HTML files can be published".into()));
    }
}
