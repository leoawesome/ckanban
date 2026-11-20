//! Claude Code's own sign-in, from the board (`/api/claude-signin*`): the strip at the top of the board and its
//! three-step sheet.
//! - The status: `claude auth status` (JSON `loggedIn`, `loginExpiresAt`, about 1 s, no network) runs in the
//!   background, at start, every 10 minutes, right after a sign-in and soon after a run shows a sign-in error; the
//!   answer is cached and requests only read the cache.
//! - The sign-in: `claude auth login --claudeai` on plain pipes. It prints `visit: <link>` and `Paste code here if
//!   prompted >`, reads one `CODE#STATE` line, then prints `Login successful.` (exit 0) or `Couldn't log in: ...`
//!   (exit 1). One at a time: a new start, Cancel or 10 minutes kill the old one. The Mac's browser is kept shut
//!   (`BROWSER` is a no-op). Start, paste and cancel are for the user only.
//! - The pasted code is written to the child's stdin and nowhere else: never logged, stored or sent back; the child's
//!   output is only matched, never shown.
//! - One phone notification when the sign-in will run out within 3 days (once per expiry date), and one when Claude is
//!   signed out (again only after a sign-in); what was sent is in `claude-signin.json`.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

use ckanban_core::time::{iso, now_ms, parse_date};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, watch};

use super::{Answer, Call, Emit};

/// Sends one notification to the user's phone and other channels: (title, body).
pub type Tell = Arc<dyn Fn(String, String) + Send + Sync>;

const DAY_MS: f64 = 86_400_000.0;
const TERMINAL: &str = "Open Terminal on the Mac and run: claude auth login";

fn missing() -> String {
    format!("The board couldn't find Claude Code on this Mac. {TERMINAL}")
}
fn unexpected() -> String {
    format!("Claude's sign-in didn't start the way the board expected. {TERMINAL}")
}
const REJECTED: &str = "Claude didn't accept that code. It may be incomplete, used already or from an older sign-in. Tap Start again for a new link.";
const TIMED_OUT: &str = "This sign-in was open for 10 minutes, so it stopped. Tap Start again for a new link.";
const REPLACED: &str = "This sign-in was replaced by a newer one (another tab or device started one). Tap Start again for a new link.";
const ENDED: &str = "This sign-in has ended. Tap Start again for a new link.";
const NOT_WHOLE: &str = "That isn't the whole code. Copy all of it, including the # in the middle.";

/// The sign-in link, only once something follows it (a link split across two reads isn't taken half).
static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(https://[^\s]*/oauth/authorize\?[^\s]+)\s").expect("link"));
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07").expect("ansi"));
/// Claude Code's own sign-in errors as a run's last message shows them (`signInError` in the web page).
static SIGN_IN_ERROR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)not logged in|please run /login|invalid api key|oauth token (has )?expired|authentication_error").expect("sign-in"));

pub struct Options {
    pub bin: String,
    /// How long a sign-in may stay open.
    pub timeout: Duration,
    /// How long `start` waits for the link before it answers.
    pub link_wait: Duration,
    /// How long `paste` waits for Claude's verdict before it answers (the sheet then follows the events).
    pub paste_wait: Duration,
    pub status_timeout: Duration,
    /// How often the status is checked.
    pub every: Duration,
    /// The yellow strip and its notification start this many days before the sign-in runs out.
    pub warn_days: f64,
}

impl Options {
    pub fn new() -> Self {
        Options {
            bin: std::env::var("CKANBAN_CLAUDE_BIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "claude".into()),
            timeout: Duration::from_secs(600),
            link_wait: Duration::from_secs(20),
            paste_wait: Duration::from_secs(45),
            status_timeout: Duration::from_secs(20),
            every: Duration::from_secs(600),
            warn_days: 3.0,
        }
    }
}

impl Default for Options {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Default, Debug)]
struct Status {
    checked_at: Option<f64>,
    logged_in: Option<bool>,
    expires_at: Option<String>,
}

struct Login {
    id: u64,
    /// "starting" (no link yet), "waiting" (for the code), "checking" (code sent), "done", "failed".
    state: &'static str,
    url: Option<String>,
    error: Option<String>,
    started_at: f64,
    stdin: Option<ChildStdin>,
    stop: Option<oneshot::Sender<()>>,
}

impl Login {
    fn json(&self, with_url: bool) -> Value {
        json!({
            "id": self.id,
            "state": self.state,
            "url": if with_url { self.url.clone().map(Value::String).unwrap_or(Value::Null) } else { Value::Null },
            "error": self.error,
            "startedAt": iso(self.started_at),
        })
    }
}

pub struct ClaudeSignIn {
    o: Options,
    /// The data folder (`claude-signin.json`).
    root: PathBuf,
    emit: Emit,
    tell: OnceLock<Tell>,
    status: Mutex<Status>,
    login: Mutex<Option<Login>>,
    next: AtomicU64,
    /// Bumped on every change of the sign-in, so `start` and `paste` can wait for the next one.
    changed: watch::Sender<u64>,
    checking: AtomicBool,
    /// A check was asked for while one ran: run again once it ends (a sign-in's check isn't lost to an older read).
    again: AtomicBool,
    /// When the last check was asked for after a run's sign-in error (at most one a minute).
    asked_at: Mutex<f64>,
}

/// The child's environment: the daemon's own (as `claude -p` runs get it, so the sign-in lands where the runs read
/// it) without the markers of a Claude session, which can make Claude take a fake code; the Mac's browser kept shut.
fn command(bin: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    for (k, _) in std::env::vars_os() {
        let k = k.to_string_lossy();
        if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") {
            cmd.env_remove(k.as_ref());
        }
    }
    // Claude Code opens its link with $BROWSER (checked on 2.1.328): a no-op keeps the Mac's browser shut.
    cmd.env("BROWSER", "/usr/bin/true");
    cmd.current_dir(ckanban_core::home::home_dir());
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd
}

/// The days left, rounded up (0 once it has run out).
fn days_left(expires_at: Option<&str>, now: f64) -> Option<f64> {
    let at = parse_date(expires_at?)?;
    Some(((at - now) / DAY_MS).ceil().max(0.0))
}

impl ClaudeSignIn {
    pub fn new(o: Options, root: PathBuf, emit: Emit) -> Arc<Self> {
        let (changed, _) = watch::channel(0);
        Arc::new(ClaudeSignIn {
            o,
            root,
            emit,
            tell: OnceLock::new(),
            status: Mutex::new(Status::default()),
            login: Mutex::new(None),
            // From the clock, so a sheet left open across a daemon restart can't match a new sign-in's number.
            next: AtomicU64::new(now_ms() as u64),
            changed,
            checking: AtomicBool::new(false),
            again: AtomicBool::new(false),
            asked_at: Mutex::new(f64::NEG_INFINITY),
        })
    }

    /// How the board sends the two notifications (set once by the board).
    pub fn set_tell(&self, tell: Tell) {
        let _ = self.tell.set(tell);
    }

    /// The status check: soon after start, then every `every`.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            loop {
                me.check().await;
                tokio::time::sleep(me.o.every).await;
            }
        });
    }

    /// A board event: a run whose last message is Claude Code's sign-in error asks for a check (at most once a
    /// minute). Only looks at the one event; never at other tickets.
    pub fn on_event(self: &Arc<Self>, ty: &str, body: &Value) {
        if ty != "session.updated" {
            return;
        }
        let last = &body["session"]["lastMessage"];
        if last["role"].as_str() == Some("user") || !last["text"].as_str().is_some_and(|t| SIGN_IN_ERROR.is_match(t)) {
            return;
        }
        let now = now_ms();
        {
            let mut at = self.asked_at.lock();
            if now - *at < 60_000.0 {
                return;
            }
            *at = now;
        }
        let me = self.clone();
        tokio::spawn(async move { me.check().await });
    }

    /// What the strip shows: `warning` is "signed-out", "expiring" or null.
    fn status_json(&self) -> Value {
        let s = self.status.lock().clone();
        let now = now_ms();
        let days = days_left(s.expires_at.as_deref(), now);
        let past = s.expires_at.as_deref().and_then(parse_date).is_some_and(|at| at <= now);
        let warning = match (s.logged_in, days) {
            (Some(false), _) => Some("signed-out"),
            (Some(true), _) if past => Some("signed-out"),
            (Some(true), Some(d)) if d <= self.o.warn_days => Some("expiring"),
            _ => None,
        };
        json!({
            "checked": s.checked_at.is_some(),
            "checkedAt": s.checked_at.map(iso),
            "loggedIn": s.logged_in,
            "expiresAt": s.expires_at,
            "daysLeft": days.map(|d| d as i64),
            "warning": warning,
        })
    }

    /// The answer of every route and the event: the status and the sign-in in progress (its link only for the user's
    /// own start and paste answers).
    fn state(&self, with_url: bool) -> Value {
        let login = self.login.lock().as_ref().map(|l| l.json(with_url)).unwrap_or(Value::Null);
        json!({ "status": self.status_json(), "login": login })
    }

    fn changed(&self) {
        self.changed.send_modify(|n| *n += 1);
        (self.emit)(json!({ "type": "claude-signin.updated", "state": self.state(false) }));
    }

    /// Runs `claude auth status` once (one at a time) and keeps the answer.
    pub async fn check(self: &Arc<Self>) {
        if self.checking.swap(true, Ordering::SeqCst) {
            self.again.store(true, Ordering::SeqCst);
            return;
        }
        loop {
            self.again.store(false, Ordering::SeqCst);
            if let Some((logged_in, expires_at)) = self.read_status().await {
                *self.status.lock() = Status { checked_at: Some(now_ms()), logged_in: Some(logged_in), expires_at };
                self.changed();
                self.maybe_tell().await;
            }
            if !self.again.load(Ordering::SeqCst) {
                break;
            }
        }
        self.checking.store(false, Ordering::SeqCst);
        // Asked for in the moment between the last look and the flag going down.
        if self.again.swap(false, Ordering::SeqCst) {
            Box::pin(self.check()).await;
        }
    }

    async fn read_status(&self) -> Option<(bool, Option<String>)> {
        let mut cmd = command(&self.o.bin, &["auth", "status"]);
        let child = cmd.spawn().ok()?;
        let out = tokio::time::timeout(self.o.status_timeout, child.wait_with_output()).await.ok()?.ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let start = text.find('{')?;
        let v: Value = serde_json::from_str(text[start..].trim_end()).ok()?;
        let logged_in = v.get("loggedIn")?.as_bool()?;
        let expires = v.get("loginExpiresAt").and_then(Value::as_str).filter(|s| parse_date(s).is_some()).map(str::to_string);
        Some((logged_in, expires))
    }

    /// The two notifications, each once: the coming expiry (per expiry date) and being signed out (until signed in).
    async fn maybe_tell(&self) {
        let st = self.status_json();
        let file = self.root.join("claude-signin.json");
        let f2 = file.clone();
        let mut told: Value = tokio::task::spawn_blocking(move || std::fs::read(&f2).ok().and_then(|b| serde_json::from_slice(&b).ok()))
            .await
            .ok()
            .flatten()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        let before = told.clone();
        let mut say: Option<(String, String)> = None;
        match st["warning"].as_str() {
            Some("signed-out") => {
                if told["signedOutTold"] != json!(true) {
                    told["signedOutTold"] = true.into();
                    say = Some(("Claude is signed out".into(), "Tasks can't run until you sign Claude back in. Open the board and tap Sign in.".into()));
                }
            }
            Some("expiring") => {
                told["signedOutTold"] = false.into();
                let at = st["expiresAt"].clone();
                if told["warnedFor"] != at {
                    told["warnedFor"] = at;
                    let d = st["daysLeft"].as_f64().unwrap_or(0.0);
                    let when = match d as i64 {
                        0 => "today".to_string(),
                        1 => "in 1 day".to_string(),
                        n => format!("in {n} days"),
                    };
                    say = Some((format!("Claude's sign-in runs out {when}"), "Open the board and tap Sign in to keep tasks running.".into()));
                }
            }
            _ => {
                if st["loggedIn"] == json!(true) {
                    told["signedOutTold"] = false.into();
                }
            }
        }
        if told != before {
            let text = serde_json::to_string(&told).unwrap_or_default();
            let _ = tokio::task::spawn_blocking(move || ckanban_core::atomic::atomic_write(&file, text)).await;
        }
        if let (Some((title, body)), Some(tell)) = (say, self.tell.get()) {
            tell(title, body);
        }
    }

    /// What one sheet sees of its own sign-in `id`: the sign-in when it is still the current one, else "replaced".
    fn state_of(&self, id: u64, with_url: bool) -> Value {
        let (mine, other) = {
            let g = self.login.lock();
            (g.as_ref().filter(|l| l.id == id).map(|l| l.json(with_url)), g.is_some())
        };
        let why = if other { REPLACED } else { ENDED };
        let login = mine.unwrap_or_else(|| json!({ "id": id, "state": "failed", "url": null, "error": why, "startedAt": null }));
        json!({ "status": self.status_json(), "login": login })
    }

    /// Stops the sign-in `id` (any, when None) if it is the current one (its task kills the child).
    fn stop_current(&self, id: Option<u64>) -> bool {
        let old = {
            let mut g = self.login.lock();
            if g.as_ref().is_some_and(|l| id.is_none_or(|id| l.id == id)) { g.take() } else { None }
        };
        match old {
            Some(mut l) => {
                if let Some(stop) = l.stop.take() {
                    let _ = stop.send(());
                }
                true
            }
            None => false,
        }
    }

    /// Changes the sign-in `id` if it is still the current one.
    fn update(&self, id: u64, f: impl FnOnce(&mut Login)) -> bool {
        let done = {
            let mut g = self.login.lock();
            match g.as_mut().filter(|l| l.id == id) {
                Some(l) => {
                    f(l);
                    true
                }
                None => false,
            }
        };
        if done {
            self.changed();
        }
        done
    }

    fn fail(&self, id: u64, error: String) {
        self.update(id, |l| {
            l.state = "failed";
            l.error = Some(error);
            l.stdin = None;
            l.stop = None;
        });
    }

    /// Waits until the sign-in `id` leaves `from` (or ends, or `max` passes).
    async fn wait_leaves(&self, id: u64, from: &str, max: Duration) {
        let mut rx = self.changed.subscribe();
        let _ = tokio::time::timeout(max, async {
            loop {
                let still = self.login.lock().as_ref().is_some_and(|l| l.id == id && l.state == from);
                if !still {
                    return;
                }
                if rx.changed().await.is_err() {
                    return;
                }
            }
        })
        .await;
    }

    /// Starts a new sign-in (the old one is stopped) and answers once its link is known.
    pub async fn begin(self: &Arc<Self>) -> Value {
        self.stop_current(None);
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let (stop_tx, stop_rx) = oneshot::channel();
        *self.login.lock() = Some(Login { id, state: "starting", url: None, error: None, started_at: now_ms(), stdin: None, stop: Some(stop_tx) });
        self.changed();
        let me = self.clone();
        tokio::spawn(async move { me.run(id, stop_rx).await });
        self.wait_leaves(id, "starting", self.o.link_wait).await;
        // Still no link: say so (the child is stopped).
        let late = self.login.lock().as_ref().is_some_and(|l| l.id == id && l.state == "starting");
        if late {
            if let Some(stop) = self.login.lock().as_mut().filter(|l| l.id == id).and_then(|l| l.stop.take()) {
                let _ = stop.send(());
            }
            self.fail(id, unexpected());
        }
        self.state_of(id, true)
    }

    async fn run(self: Arc<Self>, id: u64, mut stop: oneshot::Receiver<()>) {
        let mut cmd = command(&self.o.bin, &["auth", "login", "--claudeai"]);
        cmd.stdin(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return self.fail(id, if e.kind() == std::io::ErrorKind::NotFound { missing() } else { unexpected() });
            }
        };
        let stdin = child.stdin.take();
        if !self.update(id, |l| l.stdin = stdin) {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return;
        }
        // Both streams into one text (only matched, never shown or logged), a note on each chunk.
        let text = Arc::new(Mutex::new(String::new()));
        let (tx, mut rx) = mpsc::unbounded_channel::<()>();
        let mut readers = Vec::new();
        for s in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), child.stderr.take().map(|s| Box::new(s) as _)].into_iter().flatten() {
            let (text, tx) = (text.clone(), tx.clone());
            readers.push(tokio::spawn(async move {
                let mut s = s;
                let mut buf = vec![0u8; 4096];
                loop {
                    match s.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut t = text.lock();
                            if t.len() < 64 * 1024 {
                                t.push_str(&String::from_utf8_lossy(&buf[..n]));
                            }
                            drop(t);
                            let _ = tx.send(());
                        }
                    }
                }
            }));
        }
        drop(tx);
        let deadline = tokio::time::sleep(self.o.timeout);
        tokio::pin!(deadline);
        let mut reading = true;
        let code = loop {
            tokio::select! {
                _ = &mut stop => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return;
                }
                _ = &mut deadline => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return self.fail(id, TIMED_OUT.into());
                }
                st = child.wait() => break st.ok().and_then(|s| s.code()).unwrap_or(-1),
                got = rx.recv(), if reading => {
                    if got.is_none() {
                        reading = false;
                        continue;
                    }
                    let link = {
                        let t = text.lock();
                        LINK.captures(&ANSI.replace_all(&t, "")).map(|c| c[1].to_string())
                    };
                    if let Some(url) = link {
                        let mut set = false;
                        {
                            let mut g = self.login.lock();
                            if let Some(l) = g.as_mut().filter(|l| l.id == id && l.state == "starting") {
                                l.url = Some(url);
                                l.state = "waiting";
                                set = true;
                            }
                        }
                        if set {
                            self.changed();
                        }
                    }
                }
            }
        };
        // The last words can arrive just after the exit.
        for r in readers {
            let _ = tokio::time::timeout(Duration::from_secs(1), r).await;
        }
        let out = ANSI.replace_all(&text.lock(), "").into_owned();
        if code == 0 && out.contains("Login successful") {
            self.update(id, |l| {
                l.state = "done";
                l.error = None;
                l.stdin = None;
                l.stop = None;
            });
            self.check().await;
        } else if out.contains("Couldn't log in") {
            self.fail(id, REJECTED.into());
        } else {
            self.fail(id, unexpected());
        }
    }

    /// Types the pasted code into the waiting sign-in and waits for Claude's verdict. The code goes to the child's
    /// stdin only.
    pub async fn paste(&self, id: u64, raw: &str) -> Result<Value, Answer> {
        let code = raw.trim();
        if code.is_empty() {
            return Err(Answer::error(400, "Paste the code first."));
        }
        if !code.contains('#') || code.chars().any(char::is_whitespace) || code.len() > 4096 {
            return Err(Answer::error(400, NOT_WHOLE));
        }
        let taken = {
            let mut g = self.login.lock();
            g.as_mut().filter(|l| l.id == id && l.state == "waiting").and_then(|l| l.stdin.take())
        };
        let Some(mut stdin) = taken else {
            let replaced = self.login.lock().as_ref().is_some_and(|l| l.id != id);
            return Err(Answer::error(409, if replaced { REPLACED } else { ENDED }));
        };
        self.update(id, |l| l.state = "checking");
        let mut line = Vec::with_capacity(code.len() + 1);
        line.extend_from_slice(code.as_bytes());
        line.push(b'\n');
        let wrote = stdin.write_all(&line).await.is_ok() && stdin.flush().await.is_ok();
        line.iter_mut().for_each(|b| *b = 0);
        if !wrote {
            self.fail(id, unexpected());
            return Ok(self.state_of(id, false));
        }
        self.update(id, |l| l.stdin = Some(stdin));
        self.wait_leaves(id, "checking", self.o.paste_wait).await;
        Ok(self.state_of(id, false))
    }

    /// Cancel: stops the sign-in `id` and forgets it; a newer one (another device's) is left alone.
    pub fn cancel(&self, id: u64) {
        if self.stop_current(Some(id)) {
            self.changed();
        }
    }

    pub async fn answer(self: &Arc<Self>, c: &Call<'_>) -> Option<Answer> {
        if c.parts.first().map(String::as_str) != Some("claude-signin") {
            return None;
        }
        let sub = c.parts.get(1).map(String::as_str);
        Some(match (c.parts.len(), c.method, sub) {
            (1, "GET", _) => Answer::Json(200, self.state(false)),
            (2, "POST", Some("start")) => {
                if let Err(a) = (c.user)("Signing Claude in") {
                    return Some(a);
                }
                Answer::Json(200, self.begin().await)
            }
            (2, "POST", Some("paste")) => {
                if let Err(a) = (c.user)("Signing Claude in") {
                    return Some(a);
                }
                let b = match super::body_json(c.body) {
                    Ok(b) => b,
                    Err(a) => return Some(a),
                };
                let Some(id) = b.get("id").and_then(Value::as_u64) else { return Some(Answer::error(400, "id is required")) };
                match self.paste(id, b.get("code").and_then(Value::as_str).unwrap_or("")).await {
                    Ok(v) => Answer::Json(200, v),
                    Err(a) => a,
                }
            }
            (2, "POST", Some("cancel")) => {
                if let Err(a) = (c.user)("Signing Claude in") {
                    return Some(a);
                }
                let b = match super::body_json(c.body) {
                    Ok(b) => b,
                    Err(a) => return Some(a),
                };
                let Some(id) = b.get("id").and_then(Value::as_u64) else { return Some(Answer::error(400, "id is required")) };
                self.cancel(id);
                Answer::Json(200, self.state(false))
            }
            _ => Answer::error(404, "not found"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake(dir: &std::path::Path, script: &str) -> String {
        let bin = dir.join("claude");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin.to_string_lossy().into_owned()
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ck-claude-signin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const SCRIPT: &str = r#"#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then
  echo '{"loggedIn": false}'
  exit 1
fi
[ -n "$CLAUDECODE" ] && echo "leaked session env"
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=abc"
printf 'Paste code here if prompted > '
read line
if [ "$line" = "good#code" ]; then echo "Login successful."; exit 0; fi
echo "Couldn't log in: That code wasn't accepted."
exit 1
"#;

    fn sign(dir: &std::path::Path, script: &str) -> (Arc<ClaudeSignIn>, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let ev = events.clone();
        let o = Options { bin: fake(dir, script), link_wait: Duration::from_secs(5), paste_wait: Duration::from_secs(5), ..Options::new() };
        (ClaudeSignIn::new(o, dir.to_path_buf(), Arc::new(move |v| ev.lock().push(v))), events)
    }

    #[tokio::test]
    async fn start_paste_success_and_rejection() {
        let d = tmp("flow");
        let (s, events) = sign(&d, SCRIPT);
        let v = s.begin().await;
        assert_eq!(v["login"]["state"], "waiting", "{v}");
        assert_eq!(v["login"]["url"], "https://claude.com/cai/oauth/authorize?code=true&state=abc");
        // Without the # the code is refused before it reaches Claude.
        let id = v["login"]["id"].as_u64().unwrap();
        assert!(s.paste(id, "nohash").await.is_err());
        let v = s.paste(id, "good#code").await.unwrap();
        assert_eq!(v["login"]["state"], "done", "{v}");
        // Nothing the board sent out carries the code.
        assert!(!serde_json::to_string(&*events.lock()).unwrap().contains("good#code"));
        let v = s.begin().await;
        assert_eq!(v["login"]["state"], "waiting");
        let id = v["login"]["id"].as_u64().unwrap();
        let v = s.paste(id, "bad#code").await.unwrap();
        assert_eq!(v["login"]["state"], "failed");
        assert_eq!(v["login"]["error"], REJECTED);
        assert!(!serde_json::to_string(&v).unwrap().contains("bad#code"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_new_start_and_cancel_kill_the_old_child() {
        let d = tmp("kill");
        let script = SCRIPT.replace("[ -n \"$CLAUDECODE\" ]", "echo $$ >> \"$(dirname \"$0\")/pids\"\n[ -n \"$CLAUDECODE\" ]");
        let (s, _) = sign(&d, &script);
        let first = s.begin().await["login"]["id"].as_u64().unwrap();
        let v = s.begin().await;
        let second = v["login"]["id"].as_u64().unwrap();
        assert_eq!(second, first + 1);
        // The first sheet's Cancel and paste leave the newer sign-in alone.
        s.cancel(first);
        assert_eq!(s.state(false)["login"]["state"], "waiting");
        let Err(Answer::Json(409, e)) = s.paste(first, "good#code").await else { panic!("old paste not refused") };
        assert_eq!(e["error"], REPLACED);
        assert_eq!(s.state(false)["login"]["state"], "waiting");
        s.cancel(second);
        assert!(s.state(false)["login"].is_null());
        tokio::time::sleep(Duration::from_millis(300)).await;
        let pids = std::fs::read_to_string(d.join("pids")).unwrap();
        for pid in pids.lines() {
            let alive = std::process::Command::new("/bin/kill").args(["-0", pid]).status().unwrap().success();
            assert!(!alive, "child {pid} still running");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn missing_claude_and_odd_output_say_to_use_terminal() {
        let d = tmp("odd");
        let (s, _) = sign(&d, "#!/bin/sh\necho hello\nsleep 30\n");
        let v = s.begin().await;
        assert_eq!(v["login"]["state"], "failed");
        assert!(v["login"]["error"].as_str().unwrap().contains("claude auth login"));
        let o = Options { bin: d.join("nope").to_string_lossy().into_owned(), ..Options::new() };
        let s = ClaudeSignIn::new(o, d.clone(), Arc::new(|_| {}));
        let v = s.begin().await;
        assert_eq!(v["login"]["error"], missing());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn status_and_notifications_once() {
        let d = tmp("status");
        let soon = iso(now_ms() + 2.5 * DAY_MS);
        let script = format!("#!/bin/sh\ncat \"$(dirname \"$0\")/status\"\n");
        let (s, _) = sign(&d, &script);
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let t2 = told.clone();
        s.set_tell(Arc::new(move |title, _| t2.lock().push(title)));
        std::fs::write(d.join("status"), format!(r#"{{"loggedIn": true, "loginExpiresAt": "{soon}"}}"#)).unwrap();
        s.check().await;
        let st = s.status_json();
        assert_eq!((st["warning"].as_str(), st["daysLeft"].as_f64()), (Some("expiring"), Some(3.0)));
        s.check().await;
        std::fs::write(d.join("status"), r#"{"loggedIn": false}"#).unwrap();
        s.check().await;
        s.check().await;
        assert_eq!(s.status_json()["warning"], "signed-out");
        assert_eq!(*told.lock(), vec!["Claude's sign-in runs out in 3 days".to_string(), "Claude is signed out".to_string()]);
        let far = iso(now_ms() + 20.0 * DAY_MS);
        std::fs::write(d.join("status"), format!(r#"{{"loggedIn": true, "loginExpiresAt": "{far}"}}"#)).unwrap();
        s.check().await;
        assert!(s.status_json()["warning"].is_null());
        // Signed in on paper but the expiry has passed: red, not "runs out today".
        let past = iso(now_ms() - 1000.0);
        std::fs::write(d.join("status"), format!(r#"{{"loggedIn": true, "loginExpiresAt": "{past}"}}"#)).unwrap();
        s.check().await;
        assert_eq!(s.status_json()["warning"], "signed-out");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn the_macs_browser_stays_shut() {
        // A fake claude that opens its link the way Claude Code 2.1.328 does: with $BROWSER.
        let d = tmp("browser");
        let log = d.join("opened");
        let script = format!(
            "#!/bin/sh\n\"$BROWSER\" https://x/oauth/authorize?a=1 && echo \"browser $BROWSER\" >> '{0}'\n[ -n \"$CLAUDECODE$CLAUDE_CODE_ENTRYPOINT\" ] && echo leaked >> '{0}'\necho 'visit: https://x/oauth/authorize?a=1'\nread line\n",
            log.display()
        );
        let (s, _) = sign(&d, &script);
        let v = s.begin().await;
        assert_eq!(v["login"]["state"], "waiting", "{v}");
        s.cancel(v["login"]["id"].as_u64().unwrap());
        // BROWSER ran the no-op, and the board's Claude session variables didn't reach the child.
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "browser /usr/bin/true\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_sign_in_left_open_is_stopped() {
        let d = tmp("timeout");
        let script = SCRIPT.replace("[ -n \"$CLAUDECODE\" ]", "echo $$ > \"$(dirname \"$0\")/pid\"\n[ -n \"$CLAUDECODE\" ]");
        let o = Options { bin: fake(&d, &script), link_wait: Duration::from_secs(5), timeout: Duration::from_secs(3), ..Options::new() };
        let s = ClaudeSignIn::new(o, d.clone(), Arc::new(|_| {}));
        s.begin().await;
        // The stop comes 3 s after the start (time for a busy machine to start the script and
        // write its pid); a busy machine may take longer to report it.
        for _ in 0..200 {
            if s.state(false)["login"]["state"] == "failed" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let v = s.state(false);
        assert_eq!((v["login"]["state"].as_str(), v["login"]["error"].as_str()), (Some("failed"), Some(TIMED_OUT)));
        let pid = std::fs::read_to_string(d.join("pid")).unwrap();
        assert!(!std::process::Command::new("/bin/kill").args(["-0", pid.trim()]).status().unwrap().success());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn a_link_split_across_reads_is_taken_whole() {
        let d = tmp("split");
        let (s, _) = sign(&d, "#!/bin/sh\nprintf 'visit: https://claude.com/cai/oauth/authorize?code=true&st'\nsleep 0.3\nprintf 'ate=whole\\nPaste code here if prompted > '\nread line\n");
        let v = s.begin().await;
        assert_eq!(v["login"]["url"], "https://claude.com/cai/oauth/authorize?code=true&state=whole", "{v}");
        s.cancel(v["login"]["id"].as_u64().unwrap());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sign_in_errors_ask_for_a_check() {
        assert!(SIGN_IN_ERROR.is_match("Not logged in · Please run /login"));
        assert!(!SIGN_IN_ERROR.is_match("All done"));
        assert_eq!(days_left(Some("2026-01-04T00:00:00.000Z"), parse_date("2026-01-01T12:00:00.000Z").unwrap()), Some(3.0));
        assert_eq!(days_left(Some("2025-01-04T00:00:00.000Z"), parse_date("2026-01-01T12:00:00.000Z").unwrap()), Some(0.0));
    }
}
