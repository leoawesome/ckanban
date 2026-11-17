//! Phone access on and off (P2): `RemoteAccess` of `src/integrations/remote.ts` and the route of `src/api/remote.ts`.
//! `tailscale serve` sends https://<this Mac>.<tailnet>.ts.net to the phone access listener on 127.0.0.1; the request
//! gate (`ckanban_board::gate::request`) lets that host in only with the owner's Tailscale login, from `remote.json`.
//!
//! - `GET /api/remote`: the saved settings, the live Tailscale state while on, the check of Tailscale's link to the
//!   board (`checkServe`: put back when port 443 is empty), the QR code of the address and whether the caller is this Mac.
//! - `POST /api/remote {enabled}`: only on this Mac's listener and never from a board run; `on` points `tailscale serve`
//!   (HTTPS 443, tailnet only) at the phone listener and saves the login, `off` saves it off first, then removes the
//!   link only when it is the board's own.
//! - `watch`: the same link check soon after start and every 3 minutes while phone access is on (`watchServe`).
//!
//! `remote.json` is written as Bun writes it (`JSON.stringify(config, null, 2) + "\n"` through `remote.json.tmp`).
//! Tailscale is the binary in `CKANBAN_TAILSCALE` (tests point it at a stub), else the Mac app's own, else `tailscale`
//! on PATH; it runs in its own process group with `TAILSCALE_BE_CLI=1`.

#![allow(dead_code)]

mod qr;

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use ckanban_board::gate::remote::RemoteFile;
use ckanban_board::gate::request::RemoteConfig;
use ckanban_board::runs::js as bjs;
use ckanban_core::datafile::{Layout, to_text};
use ckanban_core::time::{iso, now_ms};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::{Answer, Call};

pub use qr::qr_svg;

const APP_CLI: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const HINT: &str = "Install Tailscale (https://tailscale.com/download) and sign in, then try again.";
const RUN_TIMEOUT: Duration = Duration::from_secs(30);
/// Status checks give up sooner: they only decide what the Phone access dialog shows.
const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// How often the board checks that Tailscale still sends the phone to it (`SERVE_CHECK_MS`).
pub const SERVE_CHECK: Duration = Duration::from_secs(180);
const FIRST_CHECK: Duration = Duration::from_secs(10);
/// Header on every answer of the phone access listener, so `on` never points serve at some other program.
const LISTENER_HEADER: &str = "x-ckanban-listener";

static ENABLE_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"To enable, visit:\s*(https://\S+)").unwrap());
static GUI_FAILED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Tailscale GUI failed to start").unwrap());
static ALREADY_OFF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)handler does not exist").unwrap());

/// What a Tailscale command printed.
#[derive(Debug, Clone, PartialEq)]
pub struct RunOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Bun's `RemoteError` (an answer with its status), or another failure (`other`: Bun rethrows those, a 500).
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteError {
    pub status: u16,
    pub message: String,
    pub other: bool,
}

impl RemoteError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        RemoteError { status, message: message.into(), other: false }
    }
}

/// `{serve, serveProblem}` of a link check; both None: not checked or unknown.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServeCheck {
    pub serve: Option<&'static str>,
    pub problem: Option<String>,
}

/// What `tailscale serve status --json` says about HTTPS port 443 (`ServeLink`).
#[derive(Debug, Clone, PartialEq)]
pub enum ServeLink {
    None,
    Proxy { target: String, funnel: bool },
    Other { funnel: bool },
}

impl ServeLink {
    fn funnel(&self) -> bool {
        match self {
            ServeLink::None => false,
            ServeLink::Proxy { funnel, .. } | ServeLink::Other { funnel } => *funnel,
        }
    }
}

/// `parseServe`: port 443 of `tailscale serve status --json`; None when that isn't the JSON Tailscale prints. `host`
/// (the board's MagicDNS name) picks the board's own entry; another app's foreground serve counts as another program's.
pub fn parse_serve(out: &str, host: Option<&str>) -> Option<ServeLink> {
    let s = bjs::parse(out)?;
    let s = match s {
        Value::Null => return Some(ServeLink::None),
        Value::Object(m) => m,
        _ => return None,
    };
    let host = host.filter(|h| !h.is_empty());
    let is443 = |k: &str| match host {
        Some(h) => k == format!("{h}:443"),
        None => k.ends_with(":443"),
    };
    let funnel_in = |c: &Value| c.get("AllowFunnel").and_then(Value::as_object).is_some_and(|m| m.iter().any(|(k, v)| k.ends_with(":443") && *v == Value::Bool(true)));
    let used_in = |c: &Value| {
        crate::js::truthy(c.get("TCP").and_then(|t| t.get("443"))) || c.get("Web").and_then(Value::as_object).is_some_and(|m| m.keys().any(|k| k.ends_with(":443")))
    };
    let fg: Vec<&Value> = match s.get("Foreground") {
        Some(Value::Object(m)) => m.values().collect(),
        Some(Value::Array(a)) => a.iter().collect(),
        _ => Vec::new(),
    };
    let whole = Value::Object(s.clone());
    let funnel = funnel_in(&whole) || fg.iter().any(|c| funnel_in(c));
    let web = s.get("Web").and_then(Value::as_object).and_then(|m| m.iter().find(|(k, _)| is443(k)).map(|(_, v)| v));
    let target = web.and_then(|w| w.get("Handlers")).and_then(|h| h.get("/")).and_then(|h| h.get("Proxy")).and_then(Value::as_str);
    if let Some(t) = target
        && !fg.iter().any(|c| used_in(c))
    {
        return Some(ServeLink::Proxy { target: t.to_string(), funnel });
    }
    if used_in(&whole) || fg.iter().any(|c| used_in(c)) || funnel {
        return Some(ServeLink::Other { funnel });
    }
    Some(ServeLink::None)
}

/// First lines of what Tailscale printed, for error messages.
fn excerpt(text: &str) -> String {
    crate::js::trim(text).split('\n').take(6).collect::<Vec<_>>().join("\n")
}

pub fn remote_url(host: &str) -> String {
    format!("https://{host}")
}

/// `tailscaleBin()`: CKANBAN_TAILSCALE, else the Mac app's own binary, else `tailscale` on PATH.
fn tailscale_bin() -> Option<PathBuf> {
    if let Some(own) = std::env::var_os("CKANBAN_TAILSCALE").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(own));
    }
    if Path::new(APP_CLI).exists() {
        return Some(PathBuf::from(APP_CLI));
    }
    which("tailscale")
}

/// `Bun.which(name)`: the first executable file of that name along PATH.
fn which(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

/// `tailscaleRunner`: runs one Tailscale command in its own process group; gives up after 30 s (code 124) and stops at
/// once when Tailscale prints the "To enable, visit:" link (code 1), ending the group either way.
async fn run_tailscale(bin: PathBuf, args: Vec<String>) -> Result<RunOut, RemoteError> {
    use tokio::io::AsyncReadExt;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&args)
        .env("TAILSCALE_BE_CLI", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn().map_err(|e| RemoteError { status: 500, message: format!("{}: {e}", bin.display()), other: true })?;
    let pid = child.id();
    let out = Arc::new(Mutex::new((Vec::<u8>::new(), Vec::<u8>::new())));
    let link = Arc::new(tokio::sync::Notify::new());
    let reader = |mut pipe: Box<dyn tokio::io::AsyncRead + Unpin + Send>, err: bool| {
        let (out, link) = (out.clone(), link.clone());
        tokio::spawn(async move {
            let mut buf = [0u8; 8192];
            loop {
                let n = match pipe.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut o = out.lock();
                if err { o.1.extend_from_slice(&buf[..n]) } else { o.0.extend_from_slice(&buf[..n]) }
                let both = format!("{}{}", String::from_utf8_lossy(&o.0), String::from_utf8_lossy(&o.1));
                if ENABLE_LINK.is_match(&both) {
                    link.notify_one();
                }
            }
        })
    };
    let r1 = child.stdout.take().map(|p| reader(Box::new(p), false));
    let r2 = child.stderr.take().map(|p| reader(Box::new(p), true));
    let end_group = || {
        if let Some(pid) = pid {
            unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
        }
    };
    let text = |o: &(Vec<u8>, Vec<u8>)| (String::from_utf8_lossy(&o.0).into_owned(), String::from_utf8_lossy(&o.1).into_owned());
    let done = async {
        let status = child.wait().await;
        if let Some(r) = r1 {
            let _ = r.await;
        }
        if let Some(r) = r2 {
            let _ = r.await;
        }
        status.ok().and_then(|s| s.code()).unwrap_or(-1)
    };
    tokio::select! {
        code = done => {
            let (stdout, stderr) = text(&out.lock());
            Ok(RunOut { code, stdout, stderr })
        }
        _ = link.notified() => {
            end_group();
            let (stdout, stderr) = text(&out.lock());
            Ok(RunOut { code: 1, stdout, stderr })
        }
        _ = tokio::time::sleep(RUN_TIMEOUT) => {
            end_group();
            let (stdout, mut stderr) = text(&out.lock());
            stderr.push_str(&format!("\n(gave up after {}s)", RUN_TIMEOUT.as_secs()));
            Ok(RunOut { code: 124, stdout, stderr })
        }
    }
}

/// Runs one Tailscale command: the real one, or a stand-in in tests.
pub type Runner = Arc<dyn Fn(Vec<String>) -> BoxFuture<'static, Result<RunOut, RemoteError>> + Send + Sync>;
/// `isPhoneListener(port)`.
pub type Probe = Arc<dyn Fn(u16) -> BoxFuture<'static, bool> + Send + Sync>;

/// The real runner: finds the binary at each call (as Bun's `findBin`).
pub fn default_runner() -> Runner {
    Arc::new(|args: Vec<String>| {
        async move {
            let Some(bin) = tailscale_bin() else { return Err(RemoteError::new(424, format!("tailscale CLI not found. {HINT}"))) };
            // Its own task: a status check that stops waiting after 3 s leaves the command to finish (or give up) alone.
            tokio::spawn(run_tailscale(bin, args)).await.unwrap_or_else(|e| Err(RemoteError { status: 500, message: e.to_string(), other: true }))
        }
        .boxed()
    })
}

/// `isPhoneListener`: the phone access listener answers on this loopback port (its `x-ckanban-listener` header).
pub fn default_probe() -> Probe {
    Arc::new(|port: u16| {
        async move {
            let Ok(client) = reqwest::Client::builder().no_proxy().timeout(CHECK_TIMEOUT).build() else { return false };
            match client.get(format!("http://127.0.0.1:{port}/api/remote")).send().await {
                Ok(r) => r.headers().get(LISTENER_HEADER).is_some_and(|v| v.as_bytes() == b"remote"),
                Err(_) => false,
            }
        }
        .boxed()
    })
}

type Checking = Shared<BoxFuture<'static, ServeCheck>>;

pub struct Phone {
    root: PathBuf,
    file: RemoteFile,
    /// The phone access listener's port; 0: none, so `on` refuses.
    port: u16,
    run: Runner,
    probe: Probe,
    last_visit: Mutex<Option<String>>,
    checking: Mutex<Option<Checking>>,
    /// What the last check logged, so a problem that stays is logged once.
    last_logged: Mutex<String>,
    /// The last QR code made (address, SVG): the dialog asks again and again for the same address.
    qr: Mutex<Option<(String, String)>>,
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Phone {
    pub fn new(root: PathBuf, port: u16) -> Arc<Phone> {
        Self::with(root, port, default_runner(), default_probe(), Arc::new(|line: &str| eprintln!("{line}")))
    }

    /// With a stand-in Tailscale, probe and log (tests).
    pub fn with(root: PathBuf, port: u16, run: Runner, probe: Probe, log: Arc<dyn Fn(&str) + Send + Sync>) -> Arc<Phone> {
        Arc::new(Phone {
            file: RemoteFile::new(&root),
            root,
            port,
            run,
            probe,
            last_visit: Mutex::new(None),
            checking: Mutex::new(None),
            last_logged: Mutex::new(String::new()),
            qr: Mutex::new(None),
            log,
        })
    }

    fn path(&self) -> PathBuf {
        self.root.join(ckanban_board::gate::remote::REMOTE_FILE)
    }

    pub fn config(&self) -> Option<RemoteConfig> {
        self.file.config()
    }

    /// Enabled settings, for the request check.
    pub fn active(&self) -> Option<RemoteConfig> {
        self.file.active()
    }

    /// A request came through phone access (`noteVisit`).
    pub fn note_visit(&self, at: String) {
        *self.last_visit.lock() = Some(at);
    }

    /// `status()`.
    pub fn status(&self) -> Map<String, Value> {
        let c = self.config();
        let on = self.active().is_some();
        let host = c.as_ref().map(|c| c.host.clone()).filter(|h| !h.is_empty());
        let mut m = Map::new();
        m.insert("enabled".into(), Value::Bool(on));
        m.insert("url".into(), host.as_deref().map(|h| Value::String(remote_url(h))).unwrap_or(Value::Null));
        m.insert("host".into(), c.as_ref().map(|c| Value::String(c.host.clone())).unwrap_or(Value::Null));
        m.insert("allowedLogin".into(), c.as_ref().map(|c| Value::String(c.allowed_login.clone())).unwrap_or(Value::Null));
        m.insert("lastVisit".into(), if on { self.last_visit.lock().clone().map(Value::String).unwrap_or(Value::Null) } else { Value::Null });
        m
    }

    /// `status()` plus the live Tailscale state when enabled. Never fails.
    pub async fn live_status(self: &Arc<Self>) -> Map<String, Value> {
        let mut st = self.status();
        if st.get("enabled") != Some(&Value::Bool(true)) {
            return st;
        }
        let r = tokio::time::timeout(CHECK_TIMEOUT, (self.run)(vec!["status".into(), "--json".into()])).await;
        let backend = match r {
            Ok(Ok(r)) if r.code == 0 => bjs::parse(&r.stdout).and_then(|v| v.get("BackendState").cloned()),
            _ => None,
        };
        let Some(Value::String(backend)) = backend else {
            st.insert("tailscale".into(), json!("unavailable"));
            return st;
        };
        if backend != "Running" {
            st.insert("tailscale".into(), json!("stopped"));
            st.insert("backendState".into(), Value::String(backend));
            return st;
        }
        let serve = self.check_serve().await;
        st.insert("tailscale".into(), json!("running"));
        st.insert("backendState".into(), json!("Running"));
        add_serve(&mut st, &serve);
        st
    }

    /// `checkServe`: one check at a time (callers meanwhile share it); never fails.
    pub fn check_serve(self: &Arc<Self>) -> Checking {
        let mut slot = self.checking.lock();
        if let Some(c) = &*slot {
            return c.clone();
        }
        let me = self.clone();
        let fut: BoxFuture<'static, ServeCheck> = async move {
            let out = me.serve_check().await;
            *me.checking.lock() = None;
            out
        }
        .boxed();
        let shared = fut.shared();
        *slot = Some(shared.clone());
        shared
    }

    fn note(&self, key: &str, line: &str) {
        let mut last = self.last_logged.lock();
        if key != *last {
            (self.log)(&format!("phone access: {line}"));
        }
        *last = key.to_string();
    }

    fn mine(&self, target: &str) -> bool {
        self.port != 0 && (target == format!("http://127.0.0.1:{}", self.port) || target == format!("http://localhost:{}", self.port))
    }

    async fn serve_check(&self) -> ServeCheck {
        let Some(c) = self.active() else { return ServeCheck::default() };
        let Some(link) = self.read_serve().await else { return ServeCheck::default() };
        if link != ServeLink::None && link.funnel() {
            self.note("public", "Tailscale has a public link (Funnel) on port 443; the board doesn't put itself there");
            return ServeCheck {
                serve: Some("public"),
                problem: Some("Tailscale has a public link (Funnel) on this Mac's https address, so the board stays off it. Turn off Funnel for port 443 in Tailscale, then press Turn off and Turn on here.".into()),
            };
        }
        if let ServeLink::Proxy { target, .. } = &link
            && self.mine(target)
        {
            if !self.last_logged.lock().is_empty() {
                self.note("", "Tailscale's link to the board is back");
            }
            return ServeCheck { serve: Some("ok"), problem: None };
        }
        if link != ServeLink::None {
            let (key, to) = match &link {
                ServeLink::Proxy { target, .. } => (format!("other {target}"), target.clone()),
                _ => ("other ".to_string(), "another program".to_string()),
            };
            self.note(&key, &format!("Tailscale's https port 443 goes to {to}, not the board; left as it is"));
            return ServeCheck {
                serve: Some("other"),
                problem: Some(format!(
                    "Tailscale's address for this Mac ({}) goes to another program, so your phone can't reach the board. Press Turn off, then Turn on, to point it back at the board.",
                    remote_url(&c.host)
                )),
            };
        }
        let missing = |why: &str| {
            self.note(&format!("missing {why}"), &format!("Tailscale's link to the board is missing and couldn't be put back: {why}"));
            ServeCheck {
                serve: Some("missing"),
                problem: Some(format!("Tailscale lost the link to the board and the board couldn't put it back ({why}). Press Turn off, then Turn on.")),
            }
        };
        let port = self.port;
        if port == 0 || !(self.probe)(port).await {
            let p = if port == 0 { "?".to_string() } else { port.to_string() };
            return missing(&format!("the board's phone listener isn't answering on 127.0.0.1:{p}"));
        }
        // Turned off while this check ran: leave it off.
        if self.active().is_none() {
            return ServeCheck::default();
        }
        if let Err(e) = self.tailscale(&["serve", "--bg", "--https=443", &format!("http://127.0.0.1:{port}")]).await {
            let first = excerpt(&e.message).split('\n').next().unwrap_or("").to_string();
            return missing(&first);
        }
        self.last_logged.lock().clear();
        (self.log)(&format!("phone access: Tailscale's link to the board was missing; put it back (https 443 -> 127.0.0.1:{port})"));
        ServeCheck { serve: Some("ok"), problem: None }
    }

    /// Port 443 as `tailscale serve status --json` reports it; None when Tailscale can't be asked or answers oddly.
    async fn read_serve(&self) -> Option<ServeLink> {
        let r = tokio::time::timeout(CHECK_TIMEOUT, (self.run)(vec!["serve".into(), "status".into(), "--json".into()])).await.ok()?.ok()?;
        if r.code != 0 || GUI_FAILED.is_match(&format!("{}{}", r.stdout, r.stderr)) {
            return None;
        }
        if crate::js::trim(&r.stdout).is_empty() {
            return None;
        }
        let host = self.config().map(|c| c.host);
        parse_serve(&r.stdout, host.as_deref())
    }

    fn write(&self, c: &RemoteConfig) -> Result<(), RemoteError> {
        let v = json!({ "enabled": c.enabled, "host": c.host, "allowedLogin": c.allowed_login, "updatedAt": c.updated_at });
        let file = self.path();
        let tmp = PathBuf::from(format!("{}.tmp", file.display()));
        let text = to_text(&v, Layout::Indent(2)) + "\n";
        std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &file)).map_err(|e| RemoteError { status: 500, message: e.to_string(), other: true })
    }

    async fn tailscale(&self, args: &[&str]) -> Result<String, RemoteError> {
        let r = (self.run)(args.iter().map(|s| s.to_string()).collect()).await?;
        let first = args.first().copied().unwrap_or("");
        if GUI_FAILED.is_match(&format!("{}{}", r.stdout, r.stderr)) {
            return Err(RemoteError::new(
                502,
                format!("tailscale {first} didn't run: Tailscale tried to open its app window instead. It said: {}", excerpt(&format!("{}\n{}", r.stderr, r.stdout))),
            ));
        }
        if r.code != 0 {
            if let Some(m) = ENABLE_LINK.captures(&format!("{}{}", r.stdout, r.stderr)) {
                return Err(RemoteError::new(424, format!("Tailscale Serve isn't enabled on your tailnet yet. Enable it at {} and try again.", &m[1])));
            }
            let msg = excerpt(if r.stderr.is_empty() { &r.stdout } else { &r.stderr });
            return Err(RemoteError::new(502, format!("tailscale {first} failed{}", if msg.is_empty() { String::new() } else { format!(": {msg}") })));
        }
        Ok(r.stdout)
    }

    /// This Mac's MagicDNS name and the signed-in user's login, from `tailscale status --json`.
    pub async fn identity(&self) -> Result<(String, String), RemoteError> {
        let out = self.tailscale(&["status", "--json"]).await?;
        let Some(s) = bjs::parse(&out) else {
            let said = excerpt(&out);
            return Err(RemoteError::new(
                502,
                format!("could not read `tailscale status --json`{}", if said.is_empty() { " (it printed nothing)".to_string() } else { format!(". Tailscale said: {said}") }),
            ));
        };
        let get = |v: &Value, k: &str| v.as_object().and_then(|m| m.get(k)).cloned();
        let state = get(&s, "BackendState");
        if state != Some(json!("Running")) {
            let shown = match state {
                None | Some(Value::Null) => "unknown".to_string(),
                Some(v) => bjs::to_string(&v),
            };
            return Err(RemoteError::new(424, format!("Tailscale is not connected (state: {shown}). {HINT}")));
        }
        let me = get(&s, "Self").unwrap_or(Value::Null);
        let text = |v: Option<Value>| match v {
            None | Some(Value::Null) => String::new(),
            Some(v) => bjs::to_string(&v),
        };
        let host = text(get(&me, "DNSName"));
        let host = host.strip_suffix('.').unwrap_or(&host).to_string();
        let uid = match get(&me, "UserID") {
            None => "undefined".to_string(),
            Some(v) => bjs::to_string(&v),
        };
        let login = text(get(&s, "User").and_then(|u| get(&u, &uid)).and_then(|u| get(&u, "LoginName")));
        if host.is_empty() {
            return Err(RemoteError::new(424, "this Mac has no MagicDNS name: turn on MagicDNS in the Tailscale admin console (DNS page)."));
        }
        if login.is_empty() {
            return Err(RemoteError::new(424, "could not find the signed-in Tailscale user (tagged devices are not supported)."));
        }
        Ok((host, login))
    }

    /// Point `tailscale serve` (HTTPS 443, tailnet only) at the phone listener and let the signed-in user in.
    pub async fn on(&self) -> Result<Map<String, Value>, RemoteError> {
        let (host, login) = self.identity().await?;
        let port = self.port;
        if port == 0 || !(self.probe)(port).await {
            let p = if port == 0 { "?".to_string() } else { port.to_string() };
            return Err(RemoteError::new(
                409,
                format!("the daemon's phone access listener isn't on 127.0.0.1:{p}: restart the daemon (`ckanban restart`) and try again; if the port is taken, set remotePort in ~/.claude-kanban/config.json"),
            ));
        }
        self.tailscale(&["serve", "--bg", "--https=443", &format!("http://127.0.0.1:{port}")]).await?;
        self.write(&RemoteConfig { enabled: true, host, allowed_login: login, updated_at: iso(now_ms()) })?;
        let mut st = self.status();
        st.insert("tailscale".into(), json!("running"));
        st.insert("backendState".into(), json!("Running"));
        Ok(st)
    }

    /// Remove the serve mapping and refuse the tailnet host again. Settings are kept (disabled) for the next `on`.
    pub async fn off(&self) -> Result<Map<String, Value>, RemoteError> {
        let c = self.config();
        // Disable first: even if tailscale fails below, the board stops letting the tailnet in.
        match &c {
            Some(c) => self.write(&RemoteConfig { enabled: false, updated_at: iso(now_ms()), ..c.clone() })?,
            None => {
                let _ = std::fs::remove_file(self.path());
            }
        }
        self.last_logged.lock().clear();
        // A link check that started before off ends first, so it can't put the link back after it.
        let running = self.checking.lock().clone();
        if let Some(c) = running {
            c.await;
        }
        let link = self.read_serve().await;
        let mine = matches!(&link, Some(ServeLink::Proxy { target, .. }) if self.mine(target));
        if link.is_some() && !mine {
            return Ok(self.status());
        }
        if let Err(e) = self.tailscale(&["serve", "--https=443", "off"]).await {
            if e.other {
                return Err(e);
            }
            if ALREADY_OFF.is_match(&e.message) {
                return Ok(self.status());
            }
            let mut st = self.status();
            st.insert("warning".into(), Value::String(e.message));
            return Ok(st);
        }
        Ok(self.status())
    }

    fn qr_of(&self, url: &str) -> String {
        if let Some((u, svg)) = &*self.qr.lock()
            && u == url
        {
            return svg.clone();
        }
        let svg = qr_svg(url);
        *self.qr.lock() = Some((url.to_string(), svg.clone()));
        svg
    }

    fn with_qr(&self, mut st: Map<String, Value>, local: bool) -> Value {
        let qr = st.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(|u| Value::String(self.qr_of(u))).unwrap_or(Value::Null);
        st.insert("qrSvg".into(), qr);
        st.insert("local".into(), Value::Bool(local));
        Value::Object(st)
    }

    /// `/api/remote` (src/api/remote.ts).
    pub async fn answer(self: &Arc<Self>, c: &Call<'_>) -> Option<Answer> {
        if c.parts.len() != 1 || c.parts[0] != "remote" {
            return None;
        }
        match c.method {
            "GET" => {
                let st = self.live_status().await;
                Some(Answer::Json(200, self.with_qr(st, c.local)))
            }
            "POST" => {
                if !c.local {
                    return Some(Answer::error(403, "phone access can only be changed on this Mac"));
                }
                if c.from_run {
                    return Some(Answer::error(403, "board runs can't change phone access"));
                }
                let b = match super::body_json(c.body) {
                    Ok(b) => b,
                    Err(a) => return Some(a),
                };
                let Some(Value::Bool(enabled)) = b.as_object().and_then(|m| m.get("enabled")).cloned() else {
                    return Some(Answer::error(400, "enabled must be true or false"));
                };
                let r = if enabled { self.on().await } else { self.off().await };
                Some(match r {
                    Ok(st) => Answer::Json(200, self.with_qr(st, true)),
                    Err(e) => Answer::error(e.status, e.message),
                })
            }
            _ => None,
        }
    }

    /// `watchServe`: while phone access is on, checks Tailscale's link soon after start and every 3 minutes, and puts
    /// it back when it went missing. Runs until the process ends.
    pub fn watch(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(FIRST_CHECK).await;
            let mut tick = tokio::time::interval(SERVE_CHECK);
            // The first tick is now: the check below is the first one.
            tick.tick().await;
            loop {
                if me.active().is_some() {
                    me.check_serve().await;
                }
                tick.tick().await;
            }
        });
    }
}

fn add_serve(st: &mut Map<String, Value>, s: &ServeCheck) {
    if let Some(serve) = s.serve {
        st.insert("serve".into(), json!(serve));
    }
    if let Some(p) = &s.problem {
        st.insert("serveProblem".into(), Value::String(p.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn parse_serve_like_bun() {
        assert_eq!(parse_serve("null", None), Some(ServeLink::None));
        assert_eq!(parse_serve("not json", None), None);
        assert_eq!(parse_serve("[1]", None), None);
        assert_eq!(parse_serve("{}", None), Some(ServeLink::None));
        let web = r#"{"Web":{"h.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7"}}}}}"#;
        assert_eq!(parse_serve(web, Some("h.ts.net")), Some(ServeLink::Proxy { target: "http://127.0.0.1:7".into(), funnel: false }));
        // Another host's 443 entry: still port 443 used, by another program.
        assert_eq!(parse_serve(web, Some("other.ts.net")), Some(ServeLink::Other { funnel: false }));
        let funnel = r#"{"AllowFunnel":{"h.ts.net:443":true},"Web":{"h.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7"}}}}}"#;
        assert_eq!(parse_serve(funnel, None), Some(ServeLink::Proxy { target: "http://127.0.0.1:7".into(), funnel: true }));
        assert_eq!(parse_serve(r#"{"TCP":{"443":{"TCPForward":"x"}}}"#, None), Some(ServeLink::Other { funnel: false }));
        let fg = r#"{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7"}}}},"Foreground":{"s":{"TCP":{"443":{}}}}}"#;
        assert_eq!(parse_serve(fg, None), Some(ServeLink::Other { funnel: false }));
        assert_eq!(parse_serve(r#"{"TCP":{"443":0}}"#, None), Some(ServeLink::None));
    }

    /// A Tailscale stand-in answering from a script of (args, out) and noting every call.
    fn fake(answers: Vec<(&'static str, RunOut)>) -> (Runner, Arc<Mutex<Vec<String>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let answers = Arc::new(Mutex::new(answers.into_iter().collect::<VecDeque<_>>()));
        let c = calls.clone();
        let run: Runner = Arc::new(move |args: Vec<String>| {
            let line = args.join(" ");
            c.lock().push(line.clone());
            let a = answers.clone();
            async move {
                let mut q = a.lock();
                let i = q.iter().position(|(k, _)| *k == line).unwrap_or_else(|| panic!("unexpected tailscale {line}"));
                Ok(q.remove(i).unwrap().1)
            }
            .boxed()
        });
        (run, calls)
    }

    fn ok(stdout: &str) -> RunOut {
        RunOut { code: 0, stdout: stdout.into(), stderr: String::new() }
    }

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ck-phone-{}-{}", std::process::id(), now_ms() as u64 + rand()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rand() -> u64 {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).unwrap();
        u32::from_le_bytes(b) as u64
    }

    const STATUS: &str = r#"{"BackendState":"Running","Self":{"DNSName":"mac.tail1.ts.net.","UserID":42},"User":{"42":{"LoginName":"me@example.com"}}}"#;

    fn phone(root: &Path, run: Runner, probe: bool) -> (Arc<Phone>, Arc<Mutex<Vec<String>>>) {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let l = logs.clone();
        let p = Phone::with(root.to_path_buf(), 4321, run, Arc::new(move |_| async move { probe }.boxed()), Arc::new(move |s: &str| l.lock().push(s.to_string())));
        (p, logs)
    }

    #[tokio::test]
    async fn on_writes_remote_json_like_bun_and_off_removes_only_the_boards_link() {
        let root = dir();
        let (run, calls) = fake(vec![
            ("status --json", ok(STATUS)),
            ("serve --bg --https=443 http://127.0.0.1:4321", ok("")),
            ("serve status --json", ok(r#"{"Web":{"mac.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4321"}}}}}"#)),
            ("serve --https=443 off", ok("")),
        ]);
        let (p, _) = phone(&root, run, true);
        let st = p.on().await.unwrap();
        assert_eq!(
            Value::Object(st),
            json!({"enabled": true, "url": "https://mac.tail1.ts.net", "host": "mac.tail1.ts.net", "allowedLogin": "me@example.com", "lastVisit": null, "tailscale": "running", "backendState": "Running"})
        );
        let text = std::fs::read_to_string(root.join("remote.json")).unwrap();
        assert!(text.starts_with("{\n  \"enabled\": true,\n  \"host\": \"mac.tail1.ts.net\",\n  \"allowedLogin\": \"me@example.com\",\n  \"updatedAt\": \""), "{text}");
        assert!(text.ends_with("\"\n}\n"));
        p.note_visit("2026-11-17T00:00:00.000Z".into());
        assert_eq!(p.status()["lastVisit"], json!("2026-11-17T00:00:00.000Z"));
        let st = p.off().await.unwrap();
        assert_eq!(st["enabled"], json!(false));
        assert!(!st.contains_key("warning"));
        assert_eq!(st["lastVisit"], Value::Null);
        assert!(std::fs::read_to_string(root.join("remote.json")).unwrap().contains("\"enabled\": false"));
        assert_eq!(calls.lock().last().unwrap(), "serve --https=443 off");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn off_leaves_another_programs_link_and_already_off_is_plain_off() {
        let root = dir();
        std::fs::write(root.join("remote.json"), r#"{"enabled":true,"host":"h.ts.net","allowedLogin":"a@b"}"#).unwrap();
        let (run, calls) = fake(vec![("serve status --json", ok(r#"{"TCP":{"443":{"x":1}}}"#))]);
        let (p, _) = phone(&root, run, true);
        assert!(!p.off().await.unwrap().contains_key("warning"));
        assert!(!calls.lock().iter().any(|c| c.contains("off")));
        std::fs::write(root.join("remote.json"), r#"{"enabled":true,"host":"h.ts.net","allowedLogin":"a@b"}"#).unwrap();
        let (run, _) = fake(vec![
            ("serve status --json", RunOut { code: 1, stdout: String::new(), stderr: "boom".into() }),
            ("serve --https=443 off", RunOut { code: 1, stdout: String::new(), stderr: "error: handler does not exist".into() }),
        ]);
        let (p, _) = phone(&root, run, true);
        assert!(!p.off().await.unwrap().contains_key("warning"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn live_status_puts_a_missing_link_back_and_reports_problems() {
        let root = dir();
        std::fs::write(root.join("remote.json"), r#"{"enabled":true,"host":"mac.tail1.ts.net","allowedLogin":"a@b"}"#).unwrap();
        let (run, calls) = fake(vec![
            ("status --json", ok(STATUS)),
            ("serve status --json", ok("null")),
            ("serve --bg --https=443 http://127.0.0.1:4321", ok("")),
            ("status --json", ok(STATUS)),
            ("serve status --json", ok(r#"{"Web":{"mac.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9"}}}}}"#)),
            ("status --json", ok(r#"{"BackendState":"Stopped"}"#)),
            ("status --json", ok("garbage")),
        ]);
        let (p, logs) = phone(&root, run, true);
        let st = p.live_status().await;
        assert_eq!(st["serve"], json!("ok"));
        assert_eq!(st["tailscale"], json!("running"));
        assert!(!st.contains_key("serveProblem"));
        assert!(calls.lock().contains(&"serve --bg --https=443 http://127.0.0.1:4321".to_string()));
        assert_eq!(logs.lock()[0], "phone access: Tailscale's link to the board was missing; put it back (https 443 -> 127.0.0.1:4321)");
        let st = p.live_status().await;
        assert_eq!(st["serve"], json!("other"));
        assert!(st["serveProblem"].as_str().unwrap().contains("another program"));
        assert_eq!(logs.lock()[1], "phone access: Tailscale's https port 443 goes to http://127.0.0.1:9, not the board; left as it is");
        let st = p.live_status().await;
        assert_eq!((st["tailscale"].clone(), st["backendState"].clone()), (json!("stopped"), json!("Stopped")));
        let st = p.live_status().await;
        assert_eq!(st["tailscale"], json!("unavailable"));
        assert!(!st.contains_key("backendState"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn on_refusals() {
        let root = dir();
        let (run, _) = fake(vec![("status --json", ok(r#"{"BackendState":"NeedsLogin"}"#))]);
        let (p, _) = phone(&root, run, true);
        let e = p.on().await.unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (424, "Tailscale is not connected (state: NeedsLogin). Install Tailscale (https://tailscale.com/download) and sign in, then try again."));
        let (run, _) = fake(vec![("status --json", ok(STATUS))]);
        let (p, _) = phone(&root, run, false);
        assert_eq!(p.on().await.unwrap_err().status, 409);
        let (run, _) = fake(vec![
            ("status --json", ok(STATUS)),
            ("serve --bg --https=443 http://127.0.0.1:4321", RunOut { code: 1, stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/serve?node=x\n".into(), stderr: String::new() }),
        ]);
        let (p, _) = phone(&root, run, true);
        let e = p.on().await.unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (424, "Tailscale Serve isn't enabled on your tailnet yet. Enable it at https://login.tailscale.com/f/serve?node=x and try again."));
        let (run, _) = fake(vec![("status --json", ok(""))]);
        let (p, _) = phone(&root, run, true);
        assert_eq!(p.on().await.unwrap_err().message, "could not read `tailscale status --json` (it printed nothing)");
        assert!(!root.join("remote.json").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_route_refuses_before_any_tailscale_command() {
        let root = dir();
        let (run, calls) = fake(vec![]);
        let (p, _) = phone(&root, run, true);
        let parts = vec!["remote".to_string()];
        let user = |_: &str| Ok(());
        let call = |method: &'static str, body: &'static [u8], local: bool, from_run: bool| Call { method, parts: &parts, query: "", body, local, from_run, user: &user };
        assert_eq!(p.answer(&call("POST", br#"{"enabled":true}"#, false, false)).await, Some(Answer::error(403, "phone access can only be changed on this Mac")));
        assert_eq!(p.answer(&call("POST", br#"{"enabled":true}"#, true, true)).await, Some(Answer::error(403, "board runs can't change phone access")));
        for b in [&b"{}"[..], br#"{"enabled":"yes"}"#, br#"{"enabled":1}"#] {
            let c = Call { method: "POST", parts: &parts, query: "", body: b, local: true, from_run: false, user: &user };
            assert_eq!(p.answer(&c).await, Some(Answer::error(400, "enabled must be true or false")));
        }
        assert_eq!(p.answer(&call("POST", b"{", true, false)).await, Some(Answer::error(400, "invalid JSON body")));
        assert_eq!(
            p.answer(&call("GET", b"", true, false)).await,
            Some(Answer::Json(200, json!({"enabled": false, "url": null, "host": null, "allowedLogin": null, "lastVisit": null, "qrSvg": null, "local": true})))
        );
        std::fs::write(root.join("remote.json"), r#"{"enabled":false,"host":"h.ts.net","allowedLogin":"a@b"}"#).unwrap();
        let Some(Answer::Json(200, v)) = p.answer(&call("GET", b"", false, false)).await else { panic!() };
        assert_eq!(v["url"], json!("https://h.ts.net"));
        assert!(v["qrSvg"].as_str().unwrap().starts_with("<svg version=\"1.1\""));
        assert_eq!(v["local"], json!(false));
        assert!(calls.lock().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_real_runner_ends_early_on_the_enable_link_and_reads_both_pipes() {
        let root = dir();
        let bin = root.join("ts");
        std::fs::write(&bin, "#!/bin/sh\nif [ \"$1\" = slow ]; then echo 'To enable, visit: https://x.example/a'; sleep 20; fi\necho \"out $TAILSCALE_BE_CLI\"; echo err >&2; exit 3\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let r = run_tailscale(bin.clone(), vec!["x".into()]).await.unwrap();
        assert_eq!(r, RunOut { code: 3, stdout: "out 1\n".into(), stderr: "err\n".into() });
        let t = std::time::Instant::now();
        let r = run_tailscale(bin, vec!["slow".into()]).await.unwrap();
        assert_eq!(r.code, 1);
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(r.stdout.contains("To enable"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
