//! Board browsers (port of `src/browser/board-browsers.ts`, More → Browsers): real Google Chromes the board starts
//! itself, one per set of logins, each with its own data folder (`<data>/browsers/<id>/`), driven over its local
//! debugging port. A run gets each chosen browser as its own MCP server (`ckanban browser-mcp`, still Bun's command).
//!
//! Logins are only saved when Chrome quits cleanly, so the board never kills one: it asks Chrome to close over its
//! port (`Browser.close`) and waits. Chrome runs detached (its own session), so a daemon stop or restart, Bun's or
//! this one's, leaves it running, and the next daemon adopts it again from its `DevToolsActivePort` file (the port
//! must answer as that very Chrome and be bound to this Mac only). That is how the Rust board picks up the Chromes Bun
//! started before the switch, and how Bun picks up Rust's after a switch back: `board-browsers.json` (`running`) is
//! written in Bun's exact format, and either side checks each Chrome again before using it.
//!
//! Hidden (headless) browsers close after `IDLE_MS` without a run, unless "keep running" is on; those start with the
//! board and again if they die. The state sits behind one lock never held across an await; one start, close or
//! switch at a time per browser (`serial`).
//!
//! A run that picked a browser holds it only while it uses it: `grant` gives the run's tool server a secret, its first
//! browser call `claim`s the browser (starting it if needed), and the hold ends when the run ends (`release`) or after
//! `LEASE_IDLE_MS` with no browser call (`expire_leases`). Holds and secrets live in memory only.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use ckanban_core::datafile::{formats, read_json, write_json};
use ckanban_core::jskeys::order_map;
use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::cdp::{self, PORT_FILE, PageTarget, PortFile};
use super::js;
use super::sign_in::{self, ByAddress, PageSignIn};
use crate::prompts::js::{slice16, trim};

pub const BROWSERS_DIR: &str = "browsers";
/// Folders being removed go here first (outside `BROWSERS_DIR`, so they are never adopted again), then get deleted.
const REMOVED_DIR: &str = "browsers-removed";
const STATE_FILE: &str = "board-browsers.json";
/// Screenshots and other files a browser's tools save when no run folder is given.
pub const BROWSER_FILES_DIR: &str = "browser-files";

pub const IDLE_MS: f64 = 10.0 * 60_000.0;
/// A run lets go of a browser it hasn't called for this long (`LEASE_IDLE_MS`); its next call claims it again.
pub const LEASE_IDLE_MS: f64 = 5.0 * 60_000.0;
pub const TICK_MS: u64 = 30_000;
const START_TIMEOUT_MS: u64 = 30_000;
const CLOSE_TIMEOUT_MS: u64 = 30_000;
const POLL_MS: u64 = 200;
/// A keep-running browser that won't start waits this long (doubling, up to 30 minutes) before the next try.
const RETRY_BASE_MS: f64 = 60_000.0;
const NAME_MAX: usize = 40;
const WINDOW: &str = "1280,900";
/// A logged-out page must be seen this many ticks in a row before a signed-in site counts as logged out.
const OUT_TICKS: u32 = 2;
/// At most this many sites are remembered per browser.
const SITES_MAX: usize = 20;
const PROBE_TIMEOUT: Duration = Duration::from_millis(2000);
const INPUT_TIMEOUT: Duration = Duration::from_millis(8000);
const PROBES_PER_TICK: usize = 3;

static ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,47}$").unwrap());
static HEADLESS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^| )--headless(=| |$)").unwrap());
static LOOPBACK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(127\.0\.0\.1|\[::1\]|localhost):\d+$").unwrap());
static PLIST_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<key>CFBundleShortVersionString</key>\s*<string>(\d+)\.").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub struct BrowserError {
    pub status: u16,
    pub message: String,
}

fn err(status: u16, message: impl Into<String>) -> BrowserError {
    BrowserError { status, message: message.into() }
}

const NO_SUCH: &str = "There is no board browser with that name.";

pub fn valid_browser_id(v: &str) -> bool {
    ID_RE.is_match(v)
}

/// The MCP server name a run sees for a board browser (`serverName`).
pub fn server_name(id: &str) -> String {
    format!("browser-{id}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Hidden,
    Visible,
}

impl Mode {
    fn word(self) -> &'static str {
        match self {
            Mode::Hidden => "hidden",
            Mode::Visible => "visible",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignInCheck {
    /// "in" or "out".
    pub state: String,
    pub site: Option<String>,
    pub at: String,
}

/// One board browser as `board-browsers.json` keeps it, in Bun's key order.
#[derive(Debug, Clone, PartialEq)]
pub struct BoardBrowser {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub last_site: Option<(String, String)>,
    pub keep_running: bool,
    pub signed_in: bool,
    pub start_url: Option<String>,
    pub check: Option<SignInCheck>,
    /// Per site: "in" or "out"; None until the first sign-in look.
    pub sites: Option<Map<String, Value>>,
}

impl BoardBrowser {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("name".into(), json!(self.name));
        m.insert("createdAt".into(), json!(self.created_at));
        m.insert("lastUsedAt".into(), json!(self.last_used_at));
        m.insert("lastSite".into(), self.last_site.as_ref().map_or(Value::Null, |(s, a)| json!({ "site": s, "at": a })));
        m.insert("keepRunning".into(), json!(self.keep_running));
        m.insert("signedIn".into(), json!(self.signed_in));
        m.insert("startUrl".into(), json!(self.start_url));
        m.insert("check".into(), self.check.as_ref().map_or(Value::Null, |c| json!({ "state": c.state, "site": c.site, "at": c.at })));
        if let Some(s) = &self.sites {
            m.insert("sites".into(), Value::Object(order_map(s.clone())));
        }
        m
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Runtime {
    pub pid: Option<u32>,
    pub port: u16,
    pub path: String,
    pub mode: Mode,
    pub started_at: String,
}

impl Runtime {
    fn to_json(&self) -> Value {
        json!({ "pid": self.pid, "port": self.port, "path": self.path, "mode": self.mode.word(), "startedAt": self.started_at })
    }
    fn port_file(&self) -> PortFile {
        PortFile { port: self.port, path: self.path.clone() }
    }
}

/// Who listens on a port: the process, and whether it is a hidden Chrome.
#[derive(Debug, Clone, PartialEq)]
pub struct PortOwner {
    pub pid: u32,
    pub headless: bool,
}

type Fut<T> = BoxFuture<'static, T>;
type SpawnFn = Arc<dyn Fn(&[String]) -> Result<u32, String> + Send + Sync>;
type OwnerFn = Arc<dyn Fn(u16, PathBuf) -> Fut<Result<PortOwner, String>> + Send + Sync>;
type ProbeFn = Arc<dyn Fn(u16, String, &'static str) -> Fut<Option<Value>> + Send + Sync>;
/// Per browser: its lock and how many start, close or switch calls hold or wait for it.
type Ops = Mutex<HashMap<String, (Arc<tokio::sync::Mutex<()>>, usize)>>;

/// Everything that touches Chrome or the Mac, so tests can stand in for it (`BrowserDeps`).
#[derive(Clone)]
pub struct BrowserDeps {
    /// Google Chrome's binary, or None when it isn't installed.
    pub chrome_bin: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Starts Chrome detached (its own session: a daemon stop never takes it down); its pid.
    pub spawn: SpawnFn,
    /// Which process listens on the port: bound to this Mac only, and Chrome on this data folder.
    pub owner: OwnerFn,
    pub alive: Arc<dyn Fn(u32) -> bool + Send + Sync>,
    pub matches: Arc<dyn Fn(PortFile) -> Fut<bool> + Send + Sync>,
    pub close: Arc<dyn Fn(PortFile) -> Fut<Result<(), String>> + Send + Sync>,
    pub pages: Arc<dyn Fn(u16) -> Fut<Option<Vec<PageTarget>>> + Send + Sync>,
    /// Runs a read-only expression in a tab (the sign-in check); None when it fails.
    pub probe: ProbeFn,
    /// A daemon.log line. Never page contents or full addresses.
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// Chrome's major version, for the hidden browser's user agent.
    pub chrome_major: Arc<dyn Fn() -> Fut<Option<String>> + Send + Sync>,
    /// The board's clock (idle times), in ms.
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub idle_ms: f64,
    pub start_timeout_ms: u64,
    pub close_timeout_ms: u64,
    pub poll_ms: u64,
}

impl BrowserDeps {
    pub fn real() -> Self {
        BrowserDeps {
            chrome_bin: Arc::new(find_chrome),
            spawn: Arc::new(spawn_detached),
            owner: Arc::new(|port, dir| Box::pin(real_owner(port, dir))),
            alive: Arc::new(pid_alive),
            matches: Arc::new(|pf| Box::pin(async move { cdp::port_matches(&pf, Duration::from_secs(2)).await })),
            close: Arc::new(|pf| Box::pin(async move { cdp::request_browser_close(&pf).await.map_err(|e| e.0) })),
            pages: Arc::new(|port| Box::pin(cdp::list_pages(port, Duration::from_secs(2)))),
            probe: Arc::new(|port, target, expr| Box::pin(async move { cdp::evaluate_in_page(port, &target, expr, PROBE_TIMEOUT).await })),
            log: Arc::new(|line| println!("{line}")),
            chrome_major: Arc::new(|| Box::pin(real_chrome_major(find_chrome()))),
            now: Arc::new(ckanban_core::time::now_ms),
            idle_ms: IDLE_MS,
            start_timeout_ms: START_TIMEOUT_MS,
            close_timeout_ms: CLOSE_TIMEOUT_MS,
            poll_ms: POLL_MS,
        }
    }
}

/// `findChrome`: `CKANBAN_CHROME_BIN` (tests' stub), then the usual places.
pub fn find_chrome() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        std::env::var("CKANBAN_CHROME_BIN").ok().filter(|s| !s.is_empty()),
        Some("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string()),
        Some(format!("{home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
    ];
    candidates.into_iter().flatten().find(|p| Path::new(p).exists())
}

/// `kill(pid, 0)`: alive, or alive but not ours (EPERM).
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid > i32::MAX as u32 {
        return false;
    }
    // SAFETY: signal 0 only checks the process exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Starts Chrome in its own session, its output dropped; a thread waits for it so it never stays a zombie.
fn spawn_detached(argv: &[String]) -> Result<u32, String> {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    // SAFETY: setsid is async-signal-safe; nothing else runs between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

async fn output(argv: &[&str]) -> String {
    let run = tokio::process::Command::new(argv[0]).args(&argv[1..]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).output();
    match tokio::time::timeout(Duration::from_secs(10), run).await {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => String::new(),
    }
}

/// True when a ps command line has exactly `--user-data-dir=<dir>` (`hasDataDir`).
pub fn has_data_dir(cmd: &str, dir: &str) -> bool {
    let flag = format!("--user-data-dir={dir}");
    let b = cmd.as_bytes();
    let mut from = 0;
    while let Some(off) = cmd[from..].find(&flag) {
        let i = from + off;
        let end = i + flag.len();
        if (i == 0 || b[i - 1] == b' ') && (end == b.len() || b[end] == b' ' || b[end] == b'\n') {
            return true;
        }
        from = end;
    }
    false
}

/// lsof -F output's listeners (`parseListeners`).
pub fn parse_listeners(text: &str, port: u16) -> (Vec<u32>, Vec<String>) {
    let mut pids: Vec<u32> = Vec::new();
    let mut addrs = Vec::new();
    for line in text.split('\n') {
        if let Some(p) = line.strip_prefix('p') {
            let n = js::number(&json!(p));
            if n > 0.0 && n.fract() == 0.0 && !pids.contains(&(n as u32)) {
                pids.push(n as u32);
            }
        } else if let Some(a) = line.strip_prefix('n') {
            addrs.push(a.to_string());
        }
    }
    let suffix = format!(":{port}");
    (pids, addrs.into_iter().filter(|a| a.ends_with(&suffix)).collect())
}

pub fn loopback(addr: &str) -> bool {
    LOOPBACK_RE.is_match(addr)
}

async fn real_owner(port: u16, dir: PathBuf) -> Result<PortOwner, String> {
    let text = output(&["/usr/sbin/lsof", "-nP", "-a", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-Fpn"]).await;
    let (pids, addrs) = parse_listeners(&text, port);
    if pids.is_empty() || addrs.is_empty() {
        return Err("nothing listens on its port".into());
    }
    if pids.len() > 1 {
        return Err("more than one program listens on its port".into());
    }
    if !addrs.iter().all(|a| loopback(a)) {
        return Err("its port is open to other computers, not only this Mac".into());
    }
    let cmd = output(&["/bin/ps", "-ww", "-o", "command=", "-p", &pids[0].to_string()]).await;
    let cmd = cmd.trim();
    if !has_data_dir(cmd, &dir.to_string_lossy()) {
        return Err("its port belongs to another program".into());
    }
    Ok(PortOwner { pid: pids[0], headless: HEADLESS_RE.is_match(cmd) })
}

async fn real_chrome_major(bin: Option<String>) -> Option<String> {
    let bin = PathBuf::from(bin?);
    let plist = bin.parent()?.parent()?.join("Info.plist");
    let text = tokio::fs::read_to_string(plist).await.ok()?;
    PLIST_RE.captures(&text).map(|c| c[1].to_string())
}

/// A normal Mac Chrome user agent: the headless default says "HeadlessChrome", which some sites turn away.
pub fn user_agent(major: Option<&str>) -> String {
    format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36", major.unwrap_or("140"))
}

/// The argv that starts Chrome for one data folder (`chromeArgs`). No automation flag (sites distrust it).
pub fn chrome_args(bin: &str, dir: &str, mode: Mode, major: Option<&str>, url: Option<&str>) -> Vec<String> {
    let mut a = vec![
        bin.to_string(),
        format!("--user-data-dir={dir}"),
        "--remote-debugging-port=0".into(),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
    ];
    if mode == Mode::Hidden {
        a.extend(["--headless=new".to_string(), format!("--user-agent={}", user_agent(major)), format!("--window-size={WINDOW}")]);
    }
    a.push(url.unwrap_or("about:blank").to_string());
    a
}

/// "Fatt Interior WhatsApp" from "fatt-interior-whatsapp" (`nameFromId`).
pub fn name_from_id(id: &str) -> String {
    let words = |w: &str| -> Option<&'static str> {
        Some(match w {
            "whatsapp" => "WhatsApp",
            "linkedin" => "LinkedIn",
            "youtube" => "YouTube",
            "tiktok" => "TikTok",
            "github" => "GitHub",
            "x" => "X",
            _ => return None,
        })
    };
    let joined = id
        .split('-')
        .filter(|w| !w.is_empty())
        .map(|w| match words(w) {
            Some(x) => x.to_string(),
            None => {
                let mut c = w.chars();
                let first = c.next().map(|f| f.to_uppercase().collect::<String>()).unwrap_or_default();
                first + c.as_str()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    slice16(&joined, NAME_MAX).to_string()
}

/// `slugFor`: lowercase, accents taken off (NFKD), anything else a dash, at most 40 characters.
pub fn slug_for(name: &str) -> String {
    let low = name.to_lowercase();
    let nfkd: String = icu_normalizer::DecomposingNormalizerBorrowed::new_nfkd().normalize(&low).into_owned();
    let mut out = String::new();
    let mut dash = false;
    for c in nfkd.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let cut: String = trimmed.chars().take(40).collect();
    let cut = cut.trim_end_matches('-');
    if cut.is_empty() { "browser".into() } else { cut.to_string() }
}

fn clean_name(name: &Value) -> Result<String, BrowserError> {
    let Value::String(s) = name else { return Err(err(400, "Give the browser a name.")) };
    let clean = slice16(trim(&js::squash_spaces(s)), NAME_MAX).to_string();
    if clean.is_empty() {
        return Err(err(400, "Give the browser a name."));
    }
    Ok(clean)
}

/// `cleanStartUrl`: a web address (https added when it has no scheme), or None for null/"".
pub fn clean_start_url(v: &Value) -> Result<Option<String>, BrowserError> {
    let s = match v {
        Value::Null => return Ok(None),
        Value::String(s) if s.is_empty() => return Ok(None),
        Value::String(s) => trim(s).to_string(),
        _ => return Err(err(400, "The start page must be a web address.")),
    };
    let full = if js::has_scheme(&s) { s } else { format!("https://{s}") };
    match js::parse_url(&full) {
        Some(u) if u.scheme() == "https" || u.scheme() == "http" => Ok(Some(u.to_string())),
        _ => Err(err(400, "The start page must be a web address, like web.whatsapp.com.")),
    }
}

/// Who holds a browser, for the card's "Used now by": a task's run or a huddle helper working on a task.
#[derive(Debug, Clone, PartialEq)]
pub struct Holder {
    /// "task" or "huddle".
    pub kind: &'static str,
    pub slug: String,
    /// The ticket (a huddle's host ticket).
    pub id: String,
}

impl Holder {
    pub fn to_json(&self) -> Value {
        json!({ "kind": self.kind, "slug": self.slug, "id": self.id })
    }
}

/// A run's right to claim some browsers (`grant`), proven by its secret.
#[derive(Debug, Clone)]
struct Grant {
    token: String,
    ids: HashSet<String>,
    holder: Holder,
}

fn new_token() -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("random bytes");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Live state that isn't saved, plus the saved lists.
#[derive(Default)]
struct State {
    browsers: Vec<BoardBrowser>,
    /// Insertion order kept (Bun's object order).
    running: Vec<(String, Runtime)>,
    /// Per browser: the runs holding it now (lease key) and when each last made a browser call.
    leases: HashMap<String, HashMap<String, f64>>,
    /// Per lease key: the browsers that run may claim, with its secret (kept in memory only).
    grants: HashMap<String, Grant>,
    idle_since: HashMap<String, f64>,
    empty_ticks: HashMap<String, u32>,
    misses: HashMap<String, u32>,
    pending: HashSet<String>,
    errors: HashMap<String, String>,
    busy: HashMap<String, &'static str>,
    retry: HashMap<String, (f64, u32)>,
    checked_at: HashMap<String, String>,
    out_ticks: HashMap<String, u32>,
    login_tab: HashMap<String, String>,
}

impl State {
    fn get(&self, id: &str) -> Option<&BoardBrowser> {
        self.browsers.iter().find(|b| b.id == id)
    }
    fn get_mut(&mut self, id: &str) -> Option<&mut BoardBrowser> {
        self.browsers.iter_mut().find(|b| b.id == id)
    }
    fn rt(&self, id: &str) -> Option<&Runtime> {
        self.running.iter().find(|(k, _)| k == id).map(|(_, r)| r)
    }
    fn set_rt(&mut self, id: &str, rt: Runtime) {
        match self.running.iter_mut().find(|(k, _)| k == id) {
            Some(e) => e.1 = rt,
            None => self.running.push((id.to_string(), rt)),
        }
    }
    fn del_rt(&mut self, id: &str) {
        self.running.retain(|(k, _)| k != id);
    }
    fn in_use(&self, id: &str) -> usize {
        self.leases.get(id).map_or(0, HashMap::len)
    }
    fn to_json(&self) -> Value {
        let mut running = Map::new();
        for (k, r) in &self.running {
            running.insert(k.clone(), r.to_json());
        }
        json!({ "browsers": self.browsers.iter().map(|b| Value::Object(b.to_json())).collect::<Vec<_>>(), "running": Value::Object(order_map(running)) })
    }
}

fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

/// Told when a signed-in browser is seen logged out: (id, name, site).
pub type LoggedOut = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

pub struct BoardBrowsers {
    root: PathBuf,
    pub dir: PathBuf,
    state: Mutex<State>,
    /// One start, close or switch at a time per browser: a lock per browser and how many wait for it.
    ops: Ops,
    on_change: Arc<dyn Fn() + Send + Sync>,
    on_logged_out: Mutex<Option<LoggedOut>>,
    d: BrowserDeps,
    ticking: AtomicBool,
    stopped: AtomicBool,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl BoardBrowsers {
    pub fn new(root: &Path, on_change: Arc<dyn Fn() + Send + Sync>, deps: BrowserDeps) -> Arc<Self> {
        let state = load(&root.join(STATE_FILE));
        Arc::new(BoardBrowsers {
            root: root.to_path_buf(),
            dir: root.join(BROWSERS_DIR),
            state: Mutex::new(state),
            ops: Mutex::new(HashMap::new()),
            on_change,
            on_logged_out: Mutex::new(None),
            d: deps,
            ticking: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            timer: Mutex::new(None),
        })
    }

    pub fn set_on_logged_out(&self, f: LoggedOut) {
        *self.on_logged_out.lock() = Some(f);
    }

    /// The browser's data folder; never anything outside `browsers/`, whatever the id.
    pub fn folder(&self, id: &str) -> Result<PathBuf, BrowserError> {
        if !valid_browser_id(id) {
            return Err(err(400, "That isn't a board browser's id."));
        }
        Ok(self.dir.join(id))
    }

    /// Written under the lock (a small file), so the file order is the state order.
    fn save_locked(&self, s: &State) {
        let file = self.root.join(STATE_FILE);
        if let Err(e) = write_json(&file, &s.to_json(), formats::BOARD_BROWSERS) {
            eprintln!("board browsers: can't write {}: {e}", file.display());
        }
    }

    fn save(&self) {
        {
            let s = self.state.lock();
            self.save_locked(&s);
        }
        (self.on_change)();
    }

    pub fn get(&self, id: &str) -> Option<BoardBrowser> {
        self.state.lock().get(id).cloned()
    }

    pub fn ids(&self) -> Vec<String> {
        self.state.lock().browsers.iter().map(|b| b.id.clone()).collect()
    }

    pub fn in_use(&self, id: &str) -> usize {
        self.state.lock().in_use(id)
    }

    fn note(&self, id: &str, what: &str) {
        let label = self.state.lock().get(id).map(|b| format!("{} ({id})", b.name)).unwrap_or_else(|| id.to_string());
        (self.d.log)(&format!("[browsers] {label}: {what}"));
    }

    /// `{browsers: [...views], chrome: {installed, message}}` (`view`).
    pub fn view(&self) -> (Vec<Value>, Value) {
        let installed = (self.d.chrome_bin)().is_some();
        let s = self.state.lock();
        let list = s
            .browsers
            .iter()
            .map(|b| {
                let mut m = b.to_json();
                let state = s.busy.get(&b.id).copied().or_else(|| s.rt(&b.id).map(|r| r.mode.word())).unwrap_or("stopped");
                m.insert("state".into(), json!(state));
                let (sign, site, at) = match &b.check {
                    None => ("Not checked", Value::Null, Value::Null),
                    Some(c) => {
                        let at = s.rt(&b.id).and(s.checked_at.get(&b.id)).filter(|x| !x.is_empty()).cloned().unwrap_or_else(|| c.at.clone());
                        if c.state == "out" { ("Needs sign-in", json!(c.site), json!(at)) } else { ("Signed in", Value::Null, json!(at)) }
                    }
                };
                m.insert("signIn".into(), json!(sign));
                m.insert("signInSite".into(), site);
                m.insert("checkedAt".into(), at);
                m.insert("inUse".into(), json!(s.in_use(&b.id)));
                let mut keys: Vec<&String> = s.leases.get(&b.id).map(|l| l.keys().collect()).unwrap_or_default();
                keys.sort();
                let holders: Vec<Value> = keys.into_iter().filter_map(|k| s.grants.get(k)).map(|g| g.holder.to_json()).collect();
                m.insert("holders".into(), Value::Array(holders));
                m.insert("windowPending".into(), json!(s.pending.contains(&b.id)));
                m.insert("error".into(), json!(s.errors.get(&b.id)));
                m.insert("folder".into(), json!(self.dir.join(&b.id).to_string_lossy()));
                Value::Object(m)
            })
            .collect();
        let chrome = json!({
            "installed": installed,
            "message": if installed { Value::Null } else { json!("Board browsers need Google Chrome. Install it from google.com/chrome, then come back here.") },
        });
        (list, chrome)
    }

    /// One start, close or switch at a time per browser (`serial`).
    async fn serial<T>(self: &Arc<Self>, id: &str, f: impl std::future::Future<Output = T>) -> T {
        let lock = {
            let mut ops = self.ops.lock();
            let e = ops.entry(id.to_string()).or_insert_with(|| (Arc::new(tokio::sync::Mutex::new(())), 0));
            e.1 += 1;
            e.0.clone()
        };
        let out = {
            let _g = lock.lock().await;
            f.await
        };
        let mut ops = self.ops.lock();
        if let Some(e) = ops.get_mut(id) {
            e.1 -= 1;
            if e.1 == 0 {
                ops.remove(id);
            }
        }
        out
    }

    fn op_running(&self, id: &str) -> bool {
        self.ops.lock().contains_key(id)
    }

    // --- Startup -------------------------------------------------------------------------------------

    /// Adopts every folder in `browsers/` as a board browser, re-adopts Chromes still running from before a restart
    /// (Bun's or this board's), and starts the keep-running ones (`init`).
    pub async fn init(self: &Arc<Self>) {
        let _ = tokio::fs::create_dir_all(&self.dir).await;
        set_mode(&self.dir, 0o700);
        let mut names: Vec<String> = match std::fs::read_dir(&self.dir) {
            Ok(rd) => rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).filter_map(|e| e.file_name().into_string().ok()).collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        let mut changed = false;
        {
            let mut s = self.state.lock();
            let mut folders = HashSet::new();
            for name in names.iter().filter(|n| valid_browser_id(n)) {
                folders.insert(name.clone());
                if s.get(name).is_some() {
                    continue;
                }
                let dir = self.dir.join(name);
                s.browsers.push(BoardBrowser {
                    id: name.clone(),
                    name: name_from_id(name),
                    created_at: now_iso(),
                    last_used_at: None,
                    last_site: None,
                    keep_running: false,
                    // A folder with saved cookies was used and closed before: count it as signed in.
                    signed_in: dir.join("Default").join("Cookies").exists(),
                    start_url: name.contains("whatsapp").then(|| "https://web.whatsapp.com/".to_string()),
                    check: None,
                    sites: None,
                });
                changed = true;
            }
            // A browser whose folder is gone (removed by hand) is forgotten.
            let before = s.browsers.len();
            s.browsers.retain(|b| folders.contains(&b.id));
            if s.browsers.len() != before {
                changed = true;
            }
            let known: HashSet<String> = s.browsers.iter().map(|b| b.id.clone()).collect();
            s.running.retain(|(k, _)| known.contains(k));
        }
        for id in self.ids() {
            let was = self.state.lock().rt(&id).is_some();
            let live = self.adopt(&id).await;
            if live {
                let mode = self.state.lock().rt(&id).map(|r| r.mode);
                self.state.lock().idle_since.insert(id.clone(), (self.d.now)());
                self.note(&id, &format!("picked up again after the board started ({})", if mode == Some(Mode::Visible) { "window open" } else { "hidden" }));
            }
            if was != live {
                changed = true;
            }
        }
        if changed {
            self.save();
        }
        let keep: Vec<String> = {
            let s = self.state.lock();
            s.browsers.iter().filter(|b| b.keep_running && s.rt(&b.id).is_none()).map(|b| b.id.clone()).collect()
        };
        for id in keep {
            let me = self.clone();
            tokio::spawn(async move { me.keep_alive(&id).await });
        }
    }

    /// A Chrome on this folder that already runs: used when its port checks out (`adopt`). A port that fails a check
    /// is never used or closed by the board.
    async fn adopt(self: &Arc<Self>, id: &str) -> bool {
        let dir = self.dir.join(id);
        let pf = cdp::read_port_file(&dir).await;
        let pf = match pf {
            Some(pf) if (self.d.matches)(pf.clone()).await => pf,
            _ => {
                self.state.lock().del_rt(id);
                return false;
            }
        };
        match (self.d.owner)(pf.port, dir).await {
            Err(e) => {
                let mut s = self.state.lock();
                s.del_rt(id);
                s.errors.insert(id.to_string(), format!("Its Chrome is running but the board can't use it: {e}."));
                false
            }
            Ok(owner) => {
                let mut s = self.state.lock();
                let started_at = s.rt(id).map(|r| r.started_at.clone()).unwrap_or_else(now_iso);
                let mode = if owner.headless { Mode::Hidden } else { Mode::Visible };
                s.set_rt(id, Runtime { pid: Some(owner.pid), port: pf.port, path: pf.path, mode, started_at });
                true
            }
        }
    }

    /// The upkeep timer, every `TICK_MS`.
    pub fn start(self: &Arc<Self>) {
        let mut t = self.timer.lock();
        if t.is_some() {
            return;
        }
        let me = Arc::downgrade(self);
        *t = Some(tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_millis(TICK_MS));
            every.tick().await;
            loop {
                every.tick().await;
                let Some(me) = me.upgrade() else { return };
                me.tick().await;
            }
        }));
    }

    /// The board stops: board browsers are left running (detached), so no close can be cut short and no login is
    /// lost; the next daemon adopts them.
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(t) = self.timer.lock().take() {
            t.abort();
        }
    }

    // --- Start and close ----------------------------------------------------------------------------

    /// Running and checked, in any mode; started hidden otherwise. Its port (`ensure`).
    pub async fn ensure(self: &Arc<Self>, id: &str) -> Result<u16, BrowserError> {
        if self.get(id).is_none() {
            return Err(err(404, NO_SUCH));
        }
        self.serial(id, async {
            let has = self.state.lock().rt(id).is_some();
            if has && self.adopt(id).await
                && let Some(rt) = self.state.lock().rt(id) {
                    return Ok(rt.port);
                }
            self.launch(id, Mode::Hidden, None, "for a task").await.map(|r| r.port)
        })
        .await
    }

    /// `why`: plain words for daemon.log ("for a task", "keep running", "for sign-in").
    async fn launch(self: &Arc<Self>, id: &str, mode: Mode, url: Option<String>, why: &str) -> Result<Runtime, BrowserError> {
        // Removed while this waited its turn: never start Chrome on a folder being deleted.
        if self.get(id).is_none() {
            return Err(err(404, "This browser was removed in More, Browsers."));
        }
        let Some(bin) = (self.d.chrome_bin)() else {
            return Err(err(409, "Google Chrome isn't installed on this Mac. Board browsers need it: install it from google.com/chrome."));
        };
        let dir = self.folder(id)?;
        self.state.lock().busy.insert(id.to_string(), "starting");
        (self.on_change)();
        let r = self.launch_inner(id, mode, url, why, &bin, &dir).await;
        match &r {
            Ok(_) => {}
            Err(e) => {
                self.state.lock().errors.insert(id.to_string(), e.message.clone());
                self.note(id, &format!("could not start ({why}): {}", e.message));
            }
        }
        self.state.lock().busy.remove(id);
        self.save();
        r
    }

    async fn launch_inner(self: &Arc<Self>, id: &str, mode: Mode, url: Option<String>, why: &str, bin: &str, dir: &Path) -> Result<Runtime, BrowserError> {
        let _ = tokio::fs::create_dir_all(&self.dir).await;
        let _ = tokio::fs::create_dir_all(dir).await;
        set_mode(dir, 0o700);
        // Already running on this folder (outside the board, or not yet adopted): use it if it checks out.
        if self.adopt(id).await {
            self.state.lock().errors.remove(id);
            let rt = self.state.lock().rt(id).cloned().expect("adopted");
            self.note(id, &format!("already running outside the board: picked up ({}, {why})", if rt.mode == Mode::Visible { "window open" } else { "hidden" }));
            return Ok(rt);
        }
        if self.lock_holder(dir).is_some() {
            return Err(err(409, "This browser is already open outside the board. Quit that Chrome window, then try again."));
        }
        // A port file left from an earlier start would point at a dead or someone else's port.
        let _ = tokio::fs::remove_file(dir.join(PORT_FILE)).await;
        let major = (self.d.chrome_major)().await;
        let argv = chrome_args(bin, &dir.to_string_lossy(), mode, major.as_deref(), url.as_deref());
        let pid = (self.d.spawn)(&argv).map_err(|e| err(502, format!("Chrome couldn't start: {e}")))?;
        // Timeouts go by the real clock (now() is the board's, for idle times).
        let deadline = Instant::now() + Duration::from_millis(self.d.start_timeout_ms);
        let mut found = None;
        while Instant::now() < deadline {
            if let Some(pf) = cdp::read_port_file(dir).await
                && (self.d.matches)(pf.clone()).await {
                    found = Some(pf);
                    break;
                }
            if !(self.d.alive)(pid) {
                return Err(err(502, "Chrome closed right after it started. Try again; if it keeps happening, restart the Mac."));
            }
            tokio::time::sleep(Duration::from_millis(self.d.poll_ms)).await;
        }
        let Some(pf) = found else { return Err(err(504, "Chrome didn't start in time. Try again in a minute.")) };
        let owner = (self.d.owner)(pf.port, dir.to_path_buf()).await;
        let bad = match &owner {
            Err(e) => Some(e.clone()),
            Ok(o) if o.pid != pid => Some("another program answered on its port".to_string()),
            Ok(_) => None,
        };
        if let Some(why_not) = bad {
            // Ours by the port file, but not safe to use: close it cleanly and refuse.
            let _ = (self.d.close)(pf).await;
            self.wait_gone(Some(pid), dir).await;
            return Err(err(502, format!("Chrome started but the board won't use it: {why_not}.")));
        }
        let rt = Runtime { pid: Some(pid), port: pf.port, path: pf.path, mode, started_at: now_iso() };
        {
            let mut s = self.state.lock();
            s.set_rt(id, rt.clone());
            s.idle_since.insert(id.to_string(), (self.d.now)());
            s.errors.remove(id);
            s.retry.remove(id);
        }
        let opening = url.as_deref().map(|u| format!(", opening {}", sign_in::site_of(u).unwrap_or_else(|| "a blank page".into()))).unwrap_or_default();
        self.note(id, &format!("started {} ({why}){opening}", if mode == Mode::Visible { "with a window" } else { "hidden" }));
        Ok(rt)
    }

    /// The pid in Chrome's SingletonLock ("host-pid") when that Chrome still runs: the folder is in use.
    fn lock_holder(&self, dir: &Path) -> Option<u32> {
        let target = std::fs::read_link(dir.join("SingletonLock")).ok()?;
        let text = target.to_string_lossy().to_string();
        let n = js::number(&json!(text.rsplit('-').next().unwrap_or("")));
        (n > 0.0 && n.fract() == 0.0 && (self.d.alive)(n as u32)).then_some(n as u32)
    }

    async fn wait_gone(&self, pid: Option<u32>, dir: &Path) -> bool {
        let deadline = Instant::now() + Duration::from_millis(self.d.close_timeout_ms);
        while Instant::now() < deadline {
            let gone = match pid {
                Some(p) => !(self.d.alive)(p),
                None => self.lock_holder(dir).is_none(),
            };
            if gone {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(self.d.poll_ms * 2)).await;
        }
        false
    }

    /// Closes it cleanly (Browser.close over its checked port) and waits until Chrome is gone. Never kills.
    pub async fn close(self: &Arc<Self>, id: &str, why: &str) -> Result<bool, BrowserError> {
        self.serial(id, self.close_now(id, why)).await
    }

    /// The browser stopped: its last sign-in look is kept with its time, and the tick's notes go.
    fn stopped_now(s: &mut State, id: &str) {
        if let Some(at) = s.checked_at.remove(id)
            && let Some(c) = s.get_mut(id).and_then(|b| b.check.as_mut()) {
                c.at = at;
            }
        let prefix = format!("{id} ");
        s.out_ticks.retain(|k, _| !k.starts_with(&prefix));
        s.login_tab.retain(|k, _| !k.starts_with(&prefix));
    }

    async fn close_now(self: &Arc<Self>, id: &str, why: &str) -> Result<bool, BrowserError> {
        let dir = self.folder(id)?;
        let pf = cdp::read_port_file(&dir).await;
        let pf = match pf {
            Some(pf) if (self.d.matches)(pf.clone()).await => pf,
            _ => {
                if self.state.lock().rt(id).is_some() {
                    self.note(id, "already gone when the board went to close it");
                    {
                        let mut s = self.state.lock();
                        Self::stopped_now(&mut s, id);
                        s.del_rt(id);
                    }
                    self.save();
                }
                return Ok(true);
            }
        };
        let same = self.state.lock().rt(id).is_some_and(|r| r.port == pf.port && r.path == pf.path);
        if !same && !self.adopt(id).await {
            return Ok(false);
        }
        let pid = self.state.lock().rt(id).and_then(|r| r.pid);
        self.state.lock().busy.insert(id.to_string(), "closing");
        (self.on_change)();
        if (self.d.close)(pf).await.is_err() {
            {
                let mut s = self.state.lock();
                s.busy.remove(id);
                s.errors.insert(id.to_string(), "The board couldn't ask Chrome to close. It is left running; try again.".into());
            }
            (self.on_change)();
            return Ok(false);
        }
        let gone = self.wait_gone(pid, &dir).await;
        self.state.lock().busy.remove(id);
        if !gone {
            self.state.lock().errors.insert(id.to_string(), "Chrome is taking long to close. The board leaves it to finish and checks again.".into());
            self.note(id, &format!("asked to close ({why}) but still running after {}s", (self.d.close_timeout_ms as f64 / 1000.0).round()));
            (self.on_change)();
            return Ok(false);
        }
        self.note(id, &format!("closed ({why})"));
        {
            let mut s = self.state.lock();
            Self::stopped_now(&mut s, id);
            s.del_rt(id);
            s.errors.remove(id);
            s.empty_ticks.remove(id);
            if let Some(b) = s.get_mut(id)
                && b.last_site.is_some() {
                    b.signed_in = true;
                }
        }
        self.save();
        Ok(true)
    }

    // --- Runs ---------------------------------------------------------------------------------------

    /// A run (key: "slug/id", or a huddle helper's key) may use these browsers (`grant`): nothing starts and nothing
    /// is held yet. Its browser tools claim a browser with the secret returned here on their first call (`claim`).
    /// Browsers that don't exist are left out. Asking again for the same key keeps its secret.
    pub fn grant(&self, key: &str, ids: &[String], holder: Holder) -> String {
        let mut s = self.state.lock();
        let known: Vec<String> = ids.iter().filter(|id| s.get(id).is_some()).cloned().collect();
        let g = s.grants.entry(key.to_string()).or_insert_with(|| Grant { token: new_token(), ids: HashSet::new(), holder: holder.clone() });
        g.ids.extend(known);
        g.holder = holder;
        g.token.clone()
    }

    /// Google Chrome is on this Mac (board browsers can start).
    pub fn chrome_installed(&self) -> bool {
        (self.d.chrome_bin)().is_some()
    }

    /// A run's browser tools are about to use the browser (`claim`): held for that run from now (or still held, its
    /// idle clock reset) and started if needed; its port. Only the secret `grant` gave that run works. The first call
    /// waits for the browser to start; a browser that was idle or stopped is started again, never refused.
    pub async fn claim(self: &Arc<Self>, token: &str, id: &str) -> Result<u16, BrowserError> {
        let fresh = {
            let mut s = self.state.lock();
            let Some(key) = s.grants.iter().find(|(_, g)| !token.is_empty() && g.token == token).map(|(k, g)| (k.clone(), g.ids.contains(id))) else {
                return Err(err(403, "Only the browser tools of a task that picked this browser can use it."));
            };
            let (key, allowed) = key;
            if !allowed {
                return Err(err(403, "This task didn't pick this browser."));
            }
            if s.get(id).is_none() {
                return Err(err(404, NO_SUCH));
            }
            let now = (self.d.now)();
            let fresh = s.leases.entry(id.to_string()).or_default().insert(key.clone(), now).is_none();
            if fresh && let Some(b) = s.get_mut(id) {
                b.last_used_at = Some(now_iso());
            }
            fresh.then_some(key)
        };
        if let Some(key) = &fresh {
            self.note(id, &format!("claimed by {key}"));
            self.save();
        }
        match self.ensure(id).await {
            Ok(port) => Ok(port),
            Err(e) => {
                // It couldn't start: this run doesn't hold it (the card shouldn't name a task that can't use it).
                if let Some(key) = fresh {
                    self.let_go(id, &key);
                }
                Err(e)
            }
        }
    }

    /// Drops one run's hold on one browser (`let_go`); the last one out opens a window asked for meanwhile.
    fn let_go(self: &Arc<Self>, id: &str, key: &str) {
        let open = {
            let mut s = self.state.lock();
            let now = (self.d.now)();
            Self::drop_lease(&mut s, id, key, now, self.stopped.load(Ordering::SeqCst))
        };
        self.after_drop(open.into_iter().collect(), true);
    }

    /// Under the lock: `key` stops holding `id`. Returns `Some(id)` when it was the last holder and a window waits.
    fn drop_lease(s: &mut State, id: &str, key: &str, now: f64, stopped: bool) -> Option<String> {
        let set = s.leases.get_mut(id)?;
        if set.remove(key).is_none() || !set.is_empty() {
            return None;
        }
        s.leases.remove(id);
        s.idle_since.insert(id.to_string(), now);
        (s.pending.contains(id) && !stopped).then(|| id.to_string())
    }

    fn after_drop(self: &Arc<Self>, open: Vec<String>, changed: bool) {
        for id in open {
            let me = self.clone();
            tokio::spawn(async move {
                if let Err(e) = me.open_window(&id, &Value::Null).await {
                    eprintln!("board browser {id}: open window: {}", e.message);
                }
            });
        }
        if changed {
            (self.on_change)();
        }
    }

    /// The run is done with its browsers (`release`): its claims and its secret end, idle ones may close later, a
    /// window asked for meanwhile opens.
    pub fn release(self: &Arc<Self>, key: &str) {
        let mut open = Vec::new();
        let mut changed = false;
        {
            let mut s = self.state.lock();
            s.grants.remove(key);
            let now = (self.d.now)();
            let stopped = self.stopped.load(Ordering::SeqCst);
            let ids: Vec<String> = s.leases.iter().filter(|(_, l)| l.contains_key(key)).map(|(id, _)| id.clone()).collect();
            for id in ids {
                open.extend(Self::drop_lease(&mut s, &id, key, now, stopped));
                changed = true;
            }
        }
        self.after_drop(open, changed);
    }

    /// Runs that made no browser call for `LEASE_IDLE_MS` let go (`expire_leases`, each upkeep tick); their next call
    /// claims it again.
    pub fn expire_leases(self: &Arc<Self>) {
        let mut open = Vec::new();
        let mut gone = Vec::new();
        {
            let mut s = self.state.lock();
            let now = (self.d.now)();
            let stopped = self.stopped.load(Ordering::SeqCst);
            let idle: Vec<(String, String)> = s
                .leases
                .iter()
                .flat_map(|(id, l)| l.iter().filter(|(_, at)| now - **at >= LEASE_IDLE_MS).map(move |(k, _)| (id.clone(), k.clone())))
                .collect();
            for (id, key) in idle {
                open.extend(Self::drop_lease(&mut s, &id, &key, now, stopped));
                gone.push((id, key));
            }
        }
        for (id, key) in &gone {
            self.note(id, &format!("let go by {key} (no browser call for {} min)", (LEASE_IDLE_MS / 60_000.0).round()));
        }
        self.after_drop(open, !gone.is_empty());
    }

    // --- The user's actions -------------------------------------------------------------------------

    pub async fn add(self: &Arc<Self>, name: &Value) -> Result<BoardBrowser, BrowserError> {
        let clean = clean_name(name)?;
        let low = clean.to_lowercase();
        if self.state.lock().browsers.iter().any(|b| b.name.to_lowercase() == low) {
            return Err(err(409, format!("Another browser is already named \"{clean}\".")));
        }
        if (self.d.chrome_bin)().is_none() {
            return Err(err(409, "Board browsers need Google Chrome. Install it from google.com/chrome, then add one."));
        }
        let base = slug_for(&clean);
        let b = {
            let mut s = self.state.lock();
            let mut id = base.clone();
            let mut n = 2;
            while s.get(&id).is_some() || self.dir.join(&id).exists() {
                id = format!("{}-{n}", &base[..base.len().min(44)]);
                n += 1;
            }
            let _ = std::fs::create_dir_all(&self.dir);
            set_mode(&self.dir, 0o700);
            let folder = self.folder(&id)?;
            mkdir_private(&folder).map_err(|e| err(500, e.to_string()))?;
            let b = BoardBrowser {
                id,
                name: clean,
                created_at: now_iso(),
                last_used_at: None,
                last_site: None,
                keep_running: false,
                signed_in: false,
                start_url: None,
                check: None,
                sites: None,
            };
            s.browsers.push(b.clone());
            self.save_locked(&s);
            b
        };
        (self.on_change)();
        Ok(b)
    }

    pub fn update(self: &Arc<Self>, id: &str, name: Option<&Value>, keep_running: Option<&Value>, start_url: Option<&Value>) -> Result<BoardBrowser, BrowserError> {
        let (b, start) = {
            let mut s = self.state.lock();
            let Some(i) = s.browsers.iter().position(|b| b.id == id) else { return Err(err(404, NO_SUCH)) };
            if let Some(n) = name {
                let clean = clean_name(n)?;
                let low = clean.to_lowercase();
                if s.browsers.iter().enumerate().any(|(j, o)| j != i && o.name.to_lowercase() == low) {
                    return Err(err(409, format!("Another browser is already named \"{clean}\".")));
                }
                s.browsers[i].name = clean;
            }
            if let Some(u) = start_url {
                s.browsers[i].start_url = clean_start_url(u)?;
            }
            let mut start = false;
            if let Some(k) = keep_running {
                let Value::Bool(k) = k else { return Err(err(400, "Keep running must be on or off.")) };
                s.browsers[i].keep_running = *k;
                // Off: it closes once idle like any other. On: start it now (in the background).
                s.idle_since.insert(id.to_string(), (self.d.now)());
                start = *k && s.rt(id).is_none();
            }
            self.save_locked(&s);
            (s.browsers[i].clone(), start)
        };
        (self.on_change)();
        if start {
            let me = self.clone();
            let id = id.to_string();
            tokio::spawn(async move { me.keep_alive(&id).await });
        }
        Ok(b)
    }

    /// Removes the browser and its data folder with its logins (`remove`). Refused while a run uses it; a running
    /// Chrome is closed cleanly first. Only the browser's own folder is ever deleted.
    pub async fn remove(self: &Arc<Self>, id: &str) -> Result<(), BrowserError> {
        if self.get(id).is_none() {
            return Err(err(404, NO_SUCH));
        }
        if self.in_use(id) > 0 {
            return Err(err(409, "A task is using this browser now. Remove it once the task is done."));
        }
        let dir = self.folder(id)?;
        if !self.close(id, "removed by the user").await? {
            return Err(err(409, "Chrome is still closing. Try again in a minute."));
        }
        if self.in_use(id) > 0 {
            return Err(err(409, "A task started using this browser. Remove it once the task is done."));
        }
        {
            let mut s = self.state.lock();
            s.browsers.retain(|b| b.id != id);
            s.del_rt(id);
            s.pending.remove(id);
            s.errors.remove(id);
            self.save_locked(&s);
        }
        (self.on_change)();
        let Ok(st) = std::fs::symlink_metadata(&dir) else { return Ok(()) };
        if st.file_type().is_symlink() {
            let _ = std::fs::remove_file(&dir);
            return Ok(());
        }
        if !st.is_dir() {
            return Ok(());
        }
        // Moved out first (one quick rename), so it is gone from the list at once and never adopted again; the slow
        // delete of thousands of Chrome files runs in the background.
        let trash = self.root.join(REMOVED_DIR);
        let _ = std::fs::create_dir_all(&trash);
        set_mode(&trash, 0o700);
        let target = trash.join(format!("{id}-{}", (self.d.now)() as i64));
        std::fs::rename(&dir, &target).map_err(|e| err(500, e.to_string()))?;
        tokio::task::spawn_blocking(move || {
            if let Err(e) = std::fs::remove_dir_all(&target) {
                eprintln!("board browser: delete folder {}: {e}", target.display());
            }
        });
        Ok(())
    }

    /// Sign in / Open window (`openWindow`): a visible Chrome window on this Mac. A hidden browser is closed cleanly
    /// and started visible; while a run uses it the window opens once that run is done.
    pub async fn open_window(self: &Arc<Self>, id: &str, url: &Value) -> Result<(bool, String), BrowserError> {
        let Some(b) = self.get(id) else { return Err(err(404, NO_SUCH)) };
        let page = match url {
            Value::Null => None,
            Value::String(s) if s.is_empty() => None,
            v => clean_start_url(v)?,
        };
        if (self.d.chrome_bin)().is_none() {
            return Err(err(409, "Google Chrome isn't installed on this Mac. Board browsers need it: install it from google.com/chrome."));
        }
        const LATER: &str = "A task is using this browser now. Its window opens on this Mac once the task is done.";
        {
            let mut s = self.state.lock();
            if s.rt(id).map(|r| r.mode) != Some(Mode::Visible) && s.in_use(id) > 0 {
                s.pending.insert(id.to_string());
                drop(s);
                (self.on_change)();
                return Ok((false, LATER.into()));
            }
        }
        self.serial(id, async {
            self.state.lock().pending.remove(id);
            if self.state.lock().rt(id).is_some() && !self.adopt(id).await {
                self.state.lock().del_rt(id);
            }
            let rt = self.state.lock().rt(id).cloned();
            let b = self.get(id).unwrap_or(b);
            let start = page.clone().or(b.start_url.clone()).or(b.last_site.as_ref().map(|(s, _)| format!("https://{s}/")));
            if let Some(rt) = &rt {
                if rt.mode == Mode::Visible {
                    self.show_window(rt, page.as_deref()).await;
                    return Ok((true, "The window is open on this Mac.".to_string()));
                }
                if self.in_use(id) > 0 {
                    self.state.lock().pending.insert(id.to_string());
                    (self.on_change)();
                    return Ok((false, LATER.to_string()));
                }
                if !self.close_now(id, "to open it again with a window").await? {
                    return Err(err(409, "Chrome is still closing. Try again in a minute."));
                }
            }
            self.launch(id, Mode::Visible, start, "Open window, by the user").await?;
            self.state.lock().empty_ticks.remove(id);
            let signed = self.get(id).and_then(|b| b.check).is_some_and(|c| c.state == "in");
            Ok((
                true,
                if signed {
                    "The window is open on this Mac.".to_string()
                } else {
                    "The window is open on this Mac. Sign in to the sites this browser is for, then close the window.".to_string()
                },
            ))
        })
        .await
    }

    /// A visible browser already runs: open the page (or a blank tab when it has no window left) in it.
    async fn show_window(&self, rt: &Runtime, page: Option<&str>) {
        let pages = (self.d.pages)(rt.port).await;
        if page.is_none() && pages.is_some_and(|p| !p.is_empty()) {
            return;
        }
        let target = encode_uri_component(page.unwrap_or("about:blank"));
        let _ = cdp::http("PUT", rt.port, &format!("/json/new?{target}"), Duration::from_secs(3)).await;
    }

    // --- Upkeep -------------------------------------------------------------------------------------

    async fn keep_alive(self: &Arc<Self>, id: &str) {
        let Some(b) = self.get(id) else { return };
        if !b.keep_running || self.stopped.load(Ordering::SeqCst) || (self.d.chrome_bin)().is_none() {
            return;
        }
        let prev = self.state.lock().retry.get(id).copied();
        if let Some((at, _)) = prev
            && (self.d.now)() < at {
                return;
            }
        let r = self
            .serial(id, async {
                let has = self.state.lock().rt(id).is_some();
                if has && self.adopt(id).await {
                    return Ok(());
                }
                self.launch(id, Mode::Hidden, b.start_url.clone(), "keep running").await.map(|_| ())
            })
            .await;
        if let Err(e) = r {
            let fails = prev.map_or(0, |(_, f)| f) + 1;
            let wait = (RETRY_BASE_MS * 2f64.powi(fails as i32 - 1)).min(30.0 * 60_000.0);
            self.state.lock().retry.insert(id.to_string(), ((self.d.now)() + wait, fails));
            eprintln!("board browser {id}: keep running {}", e.message);
        }
    }

    /// Every `TICK_MS` (`tick`): notices Chromes that died or were quit, restarts keep-running ones, closes hidden ones
    /// idle for `IDLE_MS`, puts away visible ones whose window was closed, notes the last site and checks sign-in.
    pub async fn tick(self: &Arc<Self>) {
        if self.stopped.load(Ordering::SeqCst) || self.ticking.swap(true, Ordering::SeqCst) {
            return;
        }
        self.tick_now().await;
        self.ticking.store(false, Ordering::SeqCst);
    }

    async fn tick_now(self: &Arc<Self>) {
        self.expire_leases();
        let mut changed = false;
        for id in self.ids() {
            if self.op_running(&id) || self.state.lock().busy.contains_key(&id) {
                continue;
            }
            let Some(b) = self.get(&id) else { continue };
            let Some(rt) = self.state.lock().rt(&id).cloned() else {
                if b.keep_running {
                    self.keep_alive(&id).await;
                }
                continue;
            };
            if !(self.d.matches)(rt.port_file()).await {
                // A busy Mac can be slow to answer: only a dead process, or 3 checks in a row, counts as gone.
                let misses = self.state.lock().misses.get(&id).copied().unwrap_or(0) + 1;
                if rt.pid.is_some_and(|p| (self.d.alive)(p)) && misses < 3 {
                    self.state.lock().misses.insert(id.clone(), misses);
                    continue;
                }
                let dead = rt.pid.is_some_and(|p| !(self.d.alive)(p));
                self.note(&id, if dead { "stopped (quit on the Mac or crashed)" } else { "stopped answering on its port; the board counts it as stopped" });
                {
                    let mut s = self.state.lock();
                    s.misses.remove(&id);
                    Self::stopped_now(&mut s, &id);
                    s.del_rt(&id);
                    if let Some(x) = s.get_mut(&id)
                        && x.last_site.is_some() && dead {
                            x.signed_in = true;
                        }
                }
                changed = true;
                if b.keep_running {
                    self.keep_alive(&id).await;
                }
                continue;
            }
            self.state.lock().misses.remove(&id);
            let pages = (self.d.pages)(rt.port).await;
            let site = pages.as_ref().and_then(|p| p.iter().find_map(|x| sign_in::site_of(&x.url)));
            if let Some(site) = site {
                let mut s = self.state.lock();
                let now = (self.d.now)();
                if let Some(x) = s.get_mut(&id) {
                    let stale = match &x.last_site {
                        None => true,
                        Some((ls, at)) => *ls != site || ckanban_core::time::parse_date(at).is_some_and(|t| now - t > 10.0 * 60_000.0),
                    };
                    if stale {
                        x.last_site = Some((site, now_iso()));
                        changed = true;
                    }
                }
            }
            if let Some(p) = &pages
                && self.check_sign_in(&id, rt.port, p).await {
                    changed = true;
                }
            if self.in_use(&id) > 0 {
                self.state.lock().empty_ticks.remove(&id);
                continue;
            }
            if rt.mode == Mode::Hidden {
                let idle = (self.d.now)() - self.state.lock().idle_since.get(&id).copied().unwrap_or(0.0);
                if !b.keep_running && idle >= self.d.idle_ms {
                    let me = self.clone();
                    let id = id.clone();
                    let mins = (self.d.idle_ms / 60_000.0).round();
                    tokio::spawn(async move {
                        let id2 = id.clone();
                        me.serial(&id, async {
                            // A run may have started using it while this waited.
                            let hidden = me.state.lock().rt(&id2).is_some_and(|r| r.mode == Mode::Hidden);
                            if me.in_use(&id2) == 0 && hidden {
                                let _ = me.close_now(&id2, &format!("idle for {mins} min")).await;
                            }
                        })
                        .await;
                    });
                }
                continue;
            }
            // Visible with no window left (on a Mac, Chrome keeps running after its last window closes): put it away.
            if pages.as_ref().is_some_and(|p| p.is_empty()) {
                let n = {
                    let mut s = self.state.lock();
                    let n = s.empty_ticks.get(&id).copied().unwrap_or(0) + 1;
                    s.empty_ticks.insert(id.clone(), n);
                    n
                };
                if n >= 2 {
                    self.state.lock().empty_ticks.remove(&id);
                    let me = self.clone();
                    let id = id.clone();
                    let keep = b.keep_running;
                    let start_url = b.start_url.clone();
                    tokio::spawn(async move {
                        let id2 = id.clone();
                        me.serial(&id, async {
                            let visible = me.state.lock().rt(&id2).is_some_and(|r| r.mode == Mode::Visible);
                            if me.in_use(&id2) > 0 || !visible {
                                return;
                            }
                            if !matches!(me.close_now(&id2, "its window was closed").await, Ok(true)) {
                                return;
                            }
                            if keep {
                                let _ = me.launch(&id2, Mode::Hidden, start_url, "keep running, after its window was closed").await;
                            }
                        })
                        .await;
                    });
                }
            } else {
                self.state.lock().empty_ticks.remove(&id);
            }
        }
        if changed {
            self.save();
        }
    }

    /// The sign-in check of one running browser (`checkSignIn`): each tab's address and title, and for sites that keep
    /// their address when logged out one small read-only look inside the page. Never navigates, reloads, clicks or
    /// types. Returns whether the saved state changed.
    async fn check_sign_in(self: &Arc<Self>, id: &str, port: u16, pages: &[PageTarget]) -> bool {
        let mut seen: Vec<(String, PageSignIn, String)> = Vec::new();
        let mut probes = 0;
        for p in pages {
            let Some(site) = sign_in::site_of(&p.url) else { continue };
            let v = match sign_in::classify_by_address(&p.url, &p.title) {
                None => continue,
                Some(ByAddress::Known(v)) => v,
                Some(ByAddress::Probe) => {
                    if probes >= PROBES_PER_TICK {
                        continue;
                    }
                    probes += 1;
                    let host = js::parse_url(&p.url).map(|u| js::hostname(&u)).unwrap_or_default();
                    let Some(expr) = sign_in::page_probe(&host) else { continue };
                    sign_in::probe_answer((self.d.probe)(port, p.id.clone(), expr).await.as_ref())
                }
            };
            if v == PageSignIn::Unknown {
                continue;
            }
            // One site in several tabs: a signed-in tab wins (the login tab may be an old one).
            match seen.iter_mut().find(|(s, _, _)| *s == site) {
                Some(e) if e.1 != PageSignIn::In => {
                    e.1 = v;
                    e.2 = p.id.clone();
                }
                Some(_) => {}
                None => seen.push((site, v, p.id.clone())),
            }
        }
        let mut notes: Vec<String> = Vec::new();
        let mut alert: Option<(String, String, String)> = None;
        let changed = {
            let mut s = self.state.lock();
            // Stopped or restarted while this looked: what it saw is about a Chrome that is gone.
            if s.rt(id).map(|r| r.port) != Some(port) {
                return false;
            }
            let Some(b) = s.get(id).cloned() else { return false };
            let now = now_iso();
            let first = b.check.is_none();
            let mut sites = b.sites.clone().unwrap_or_default();
            let main_site = |site: &str| sign_in::has_probe(site) || b.start_url.as_deref().and_then(sign_in::site_of).as_deref() == Some(site);
            let mut changed = false;
            let mut any = false;
            let mut pending: HashSet<String> = HashSet::new();
            for (site, v, tab) in &seen {
                let watched = first || sites.contains_key(site) || main_site(site);
                if *v == PageSignIn::Out && !watched {
                    continue;
                }
                any = true;
                let key = format!("{id} {site}");
                let cur = sites.get(site).and_then(Value::as_str).map(str::to_string);
                if *v == PageSignIn::In {
                    s.out_ticks.remove(&key);
                    if cur.as_deref() != Some("in") {
                        if cur.as_deref() == Some("out") {
                            notes.push(format!("sign-in: signed in again on {site}"));
                        } else if b.check.as_ref().is_none_or(|c| c.state != "in") {
                            notes.push(format!("sign-in: signed in on {site}"));
                        }
                        sites.insert(site.clone(), json!("in"));
                        changed = true;
                    }
                    continue;
                }
                s.login_tab.insert(key.clone(), tab.clone());
                if cur.as_deref() == Some("out") {
                    continue;
                }
                if cur.as_deref() == Some("in") {
                    // Signed in before: the login page must stay OUT_TICKS looks (a page passing by isn't a logout).
                    let n = s.out_ticks.get(&key).copied().unwrap_or(0) + 1;
                    s.out_ticks.insert(key.clone(), n);
                    if n < OUT_TICKS {
                        pending.insert(site.clone());
                        continue;
                    }
                    s.out_ticks.remove(&key);
                    let main = main_site(site);
                    notes.push(format!("sign-in: was signed in, now needs sign-in on {site}{}", if main { "" } else { " (no alert: not the site this browser is for)" }));
                    if main {
                        alert = Some((b.id.clone(), b.name.clone(), site.clone()));
                    }
                } else {
                    notes.push(format!("sign-in: needs sign-in on {site}"));
                }
                sites.insert(site.clone(), json!("out"));
                changed = true;
            }
            // A site's login look that didn't come back this tick starts over.
            let prefix = format!("{id} ");
            s.out_ticks.retain(|k, _| !(k.starts_with(&prefix) && !pending.contains(&k[prefix.len()..])));
            let seen_out = |site: &str| seen.iter().any(|(x, v, _)| x == site && *v == PageSignIn::Out);
            s.login_tab.retain(|k, _| {
                let Some(site) = k.strip_prefix(&prefix) else { return true };
                sites.get(site).and_then(Value::as_str) == Some("out") && seen_out(site)
            });
            if !any && !changed {
                false
            } else {
                s.checked_at.insert(id.to_string(), now.clone());
                // Kept small: the oldest sites dropped past SITES_MAX; the sites it is for are never dropped.
                let keys: Vec<String> = order_map(sites.clone()).keys().filter(|k| !main_site(k)).cloned().collect();
                let drop_n = keys.len().saturating_sub(SITES_MAX);
                for k in &keys[..drop_n] {
                    sites.shift_remove(k);
                }
                let ordered = order_map(sites.clone());
                let out_site = ordered
                    .iter()
                    .find(|(k, v)| v.as_str() == Some("out") && sign_in::has_probe(k))
                    .or_else(|| ordered.iter().find(|(_, v)| v.as_str() == Some("out")))
                    .map(|(k, _)| k.clone());
                let next = match &out_site {
                    Some(site) => SignInCheck { state: "out".into(), site: Some(site.clone()), at: now.clone() },
                    None => SignInCheck { state: "in".into(), site: ordered.keys().next().cloned(), at: now.clone() },
                };
                let bm = s.get_mut(id).expect("checked above");
                bm.sites = Some(sites);
                if bm.check.as_ref().is_none_or(|c| c.state != next.state || c.site != next.site) {
                    bm.signed_in = next.state == "in";
                    bm.check = Some(next);
                    changed = true;
                }
                changed
            }
        };
        for n in notes {
            self.note(id, &n);
        }
        if let Some((bid, name, site)) = alert {
            let f = self.on_logged_out.lock().clone();
            match f {
                Some(f) => f(&bid, &name, Some(&site)),
                None => (self.d.log)(&format!("[browsers] {name} ({bid}): logged-out alert not sent (the helper isn't connected to the Rust board yet)")),
            }
        }
        changed
    }

    // --- Sign-in screen (More, Browsers, from a phone too) -----------------------------------------

    /// The tab the sign-in screen shows: the one seen on a login page, only while it runs and needs sign-in.
    async fn screen_tab(&self, id: &str) -> Result<(u16, String), BrowserError> {
        let (port, tab) = {
            let s = self.state.lock();
            let Some(b) = s.get(id) else { return Err(err(404, NO_SUCH)) };
            let rt = s.rt(id);
            if rt.is_none() || s.busy.contains_key(id) {
                return Err(err(409, "This browser isn't running now."));
            }
            let Some(c) = b.check.as_ref().filter(|c| c.state == "out") else { return Err(err(409, "This browser doesn't need sign-in now.")) };
            let tab = c.site.as_ref().and_then(|site| s.login_tab.get(&format!("{id} {site}")).cloned());
            (rt.unwrap().port, tab)
        };
        let pages = (self.d.pages)(port).await;
        match tab {
            Some(t) if pages.is_some_and(|p| p.iter().any(|x| x.id == t)) => Ok((port, t)),
            _ => Err(err(409, "The login page was closed. Wait a few seconds for the next check.")),
        }
    }

    /// A JPEG of the login tab, in memory only (never saved), and its site.
    pub async fn screen(&self, id: &str) -> Result<(Vec<u8>, Option<String>), BrowserError> {
        use base64::Engine;
        let (port, tab) = self.screen_tab(id).await?;
        let shot = cdp::page_call(port, &tab, &[("Page.captureScreenshot", json!({ "format": "jpeg", "quality": 70 }))], Duration::from_secs(5)).await;
        let data = shot.ok().and_then(|r| r.into_iter().next()).and_then(|v| v.get("data").and_then(Value::as_str).map(str::to_string));
        let Some(data) = data else { return Err(err(504, "The browser didn't send a picture of the page in time. Trying again…")) };
        let jpeg = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).unwrap_or_default();
        Ok((jpeg, self.get(id).and_then(|b| b.check).and_then(|c| c.site)))
    }

    /// A tap or typing on the sign-in screen, passed to the login tab (`input`): a click at a share of the picture's
    /// width and height, text typed at the cursor, or one of a few keys. Nothing else.
    pub async fn input(&self, id: &str, ev: &Value) -> Result<(), BrowserError> {
        let get = |k: &str| ev.get(k).filter(|_| ev.is_object());
        let share = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|_| v.is_some_and(Value::is_number)).is_some_and(|x| x.is_finite() && (0.0..=1.0).contains(&x));
        let ty = get("type").and_then(Value::as_str);
        let keys = |k: &str| -> Option<(&'static str, u32, Option<&'static str>)> {
            match k {
                "Enter" => Some(("Enter", 13, Some("\r"))),
                "Backspace" => Some(("Backspace", 8, None)),
                "Tab" => Some(("Tab", 9, None)),
                _ => None,
            }
        };
        if ty == Some("click") && !(share(get("x")) && share(get("y"))) {
            return Err(err(400, "A tap needs x and y between 0 and 1."));
        }
        if ty == Some("text") {
            let ok = get("text").and_then(Value::as_str).is_some_and(|t| !t.is_empty() && crate::prompts::js::len16(t) <= 200);
            if !ok {
                return Err(err(400, "Type up to 200 characters."));
            }
        }
        if ty == Some("key") && get("key").and_then(Value::as_str).and_then(keys).is_none() {
            return Err(err(400, "That key isn't one the sign-in screen sends."));
        }
        if !matches!(ty, Some("click" | "text" | "key")) {
            return Err(err(400, "Send a tap, text or a key."));
        }
        let (port, tab) = self.screen_tab(id).await?;
        // A hidden or background tab may hold input until it counts as focused; only for this one connection.
        let focus = ("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }));
        let late = || err(504, "The browser didn't take that in time. Try again.");
        match ty {
            Some("click") => {
                let m = cdp::page_call(port, &tab, &[("Page.getLayoutMetrics", json!({}))], Duration::from_secs(3)).await.map_err(|_| late())?;
                let vp = m.first().and_then(|m| m.get("cssVisualViewport")).ok_or_else(late)?;
                let w = vp.get("clientWidth").and_then(Value::as_f64).unwrap_or(0.0);
                let h = vp.get("clientHeight").and_then(Value::as_f64).unwrap_or(0.0);
                let x = js_round(get("x").and_then(Value::as_f64).unwrap_or(0.0) * w);
                let y = js_round(get("y").and_then(Value::as_f64).unwrap_or(0.0) * h);
                let at = |t: &str| json!({ "type": t, "x": x, "y": y, "button": "left", "clickCount": 1 });
                cdp::page_call(
                    port,
                    &tab,
                    &[
                        focus,
                        ("Input.dispatchMouseEvent", json!({ "type": "mouseMoved", "x": x, "y": y })),
                        ("Input.dispatchMouseEvent", at("mousePressed")),
                        ("Input.dispatchMouseEvent", at("mouseReleased")),
                    ],
                    INPUT_TIMEOUT,
                )
                .await
                .map_err(|_| late())?;
            }
            Some("text") => {
                cdp::page_call(port, &tab, &[focus, ("Input.insertText", json!({ "text": get("text") }))], INPUT_TIMEOUT).await.map_err(|_| late())?;
            }
            _ => {
                let key = get("key").and_then(Value::as_str).unwrap_or_default();
                let (code, vk, text) = keys(key).expect("checked above");
                let base = |t: &str, with_text: bool| {
                    let mut m = Map::new();
                    m.insert("type".into(), json!(t));
                    m.insert("key".into(), json!(key));
                    m.insert("code".into(), json!(code));
                    m.insert("windowsVirtualKeyCode".into(), json!(vk));
                    m.insert("nativeVirtualKeyCode".into(), json!(vk));
                    if with_text
                        && let Some(t) = text {
                            m.insert("text".into(), json!(t));
                        }
                    Value::Object(m)
                };
                cdp::page_call(
                    port,
                    &tab,
                    &[focus, ("Input.dispatchKeyEvent", base("keyDown", true)), ("Input.dispatchKeyEvent", base("keyUp", false))],
                    INPUT_TIMEOUT,
                )
                .await
                .map_err(|_| late())?;
            }
        }
        Ok(())
    }

    /// For tests: close every running board browser cleanly.
    pub async fn close_all(self: &Arc<Self>) {
        let ids: Vec<String> = self.state.lock().running.iter().map(|(k, _)| k.clone()).collect();
        futures_util::future::join_all(ids.iter().map(|id| self.close(id, "the board quit"))).await;
    }
}

/// `Math.round`.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `encodeURIComponent` (a lone surrogate, which throws in JavaScript, can't happen in Rust text).
fn encode_uri_component(s: &str) -> String {
    const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(s, KEEP).to_string()
}

fn set_mode(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}

/// `mkdir(dir, {mode: 0o700})`: fails when it exists.
fn mkdir_private(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(p)?;
    set_mode(p, 0o700);
    Ok(())
}

/// `board-browsers.json` as Bun reads it.
fn load(file: &Path) -> State {
    let mut s = State::default();
    let raw = match read_json(file) {
        Ok(Some(v)) => v,
        Ok(None) => return s,
        Err(e) => {
            eprintln!("board browsers: unreadable state {e}");
            return s;
        }
    };
    let str_of = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    if let Some(list) = raw.get("browsers").and_then(Value::as_array) {
        for b in list {
            let Some(id) = b.get("id").and_then(Value::as_str).filter(|i| valid_browser_id(i)) else { continue };
            let name = match b.get("name").and_then(Value::as_str) {
                Some(n) if !trim(n).is_empty() => slice16(n, NAME_MAX).to_string(),
                _ => name_from_id(id),
            };
            let created_at = match b.get("createdAt") {
                None | Some(Value::Null) => now_iso(),
                Some(v) => js::string(v),
            };
            let last_site = b.get("lastSite").filter(|l| super::devices::truthy(l)).and_then(|l| {
                let site = l.get("site")?.as_str()?.to_string();
                let at = match l.get("at") {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => js::string(v),
                };
                Some((site, at))
            });
            let check = b.get("check").filter(|c| super::devices::truthy(c)).and_then(|c| {
                let state = c.get("state")?.as_str().filter(|x| *x == "in" || *x == "out")?.to_string();
                let at = c.get("at")?.as_str()?.to_string();
                Some(SignInCheck { state, site: str_of(c.get("site")), at })
            });
            let sites = b.get("sites").filter(|x| super::devices::truthy(x) && x.is_object()).map(|x| {
                let all: Vec<(String, Value)> = order_map(x.as_object().cloned().unwrap_or_default())
                    .into_iter()
                    .filter(|(_, v)| v.as_str() == Some("in") || v.as_str() == Some("out"))
                    .collect();
                let skip = all.len().saturating_sub(SITES_MAX);
                all.into_iter().skip(skip).collect::<Map<String, Value>>()
            });
            s.browsers.push(BoardBrowser {
                id: id.to_string(),
                name,
                created_at,
                last_used_at: str_of(b.get("lastUsedAt")),
                last_site,
                keep_running: b.get("keepRunning") == Some(&Value::Bool(true)),
                signed_in: b.get("signedIn") == Some(&Value::Bool(true)),
                start_url: str_of(b.get("startUrl")),
                check,
                sites,
            });
        }
    }
    if let Some(run) = raw.get("running").and_then(Value::as_object) {
        for (id, r) in order_map(run.clone()) {
            if s.get(&id).is_none() {
                continue;
            }
            let int = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|x| x.fract() == 0.0 && v.is_some_and(Value::is_number));
            let Some(port) = int(r.get("port")) else { continue };
            let Some(path) = r.get("path").and_then(Value::as_str) else { continue };
            if !(0.0..=65535.0).contains(&port) {
                continue;
            }
            s.running.push((
                id,
                Runtime {
                    pid: int(r.get("pid")).filter(|p| *p >= 0.0 && *p <= u32::MAX as f64).map(|p| p as u32),
                    port: port as u16,
                    path: path.to_string(),
                    mode: if r.get("mode").and_then(Value::as_str) == Some("visible") { Mode::Visible } else { Mode::Hidden },
                    started_at: match r.get("startedAt") {
                        None | Some(Value::Null) => now_iso(),
                        Some(v) => js::string(v),
                    },
                },
            ));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deps with no Chrome at all: nothing answers, nothing starts.
    fn fake(started: Arc<Mutex<Vec<Vec<String>>>>) -> BrowserDeps {
        BrowserDeps {
            chrome_bin: Arc::new(|| Some("/stub/chrome".into())),
            spawn: Arc::new(move |argv| {
                started.lock().push(argv.to_vec());
                Ok(4_000_000)
            }),
            owner: Arc::new(|_, _| Box::pin(async { Err("nothing listens on its port".into()) })),
            alive: Arc::new(|_| false),
            matches: Arc::new(|_| Box::pin(async { false })),
            close: Arc::new(|_| Box::pin(async { Ok(()) })),
            pages: Arc::new(|_| Box::pin(async { None })),
            probe: Arc::new(|_, _, _| Box::pin(async { None })),
            log: Arc::new(|_| {}),
            chrome_major: Arc::new(|| Box::pin(async { None })),
            now: Arc::new(ckanban_core::time::now_ms),
            idle_ms: IDLE_MS,
            start_timeout_ms: 2000,
            close_timeout_ms: 500,
            poll_ms: 10,
        }
    }

    fn holder(id: &str) -> Holder {
        Holder { kind: "task", slug: "b".into(), id: id.into() }
    }

    /// A board with one browser whose Chrome already runs (adopted on its port file, nothing spawned), and a clock
    /// the test moves.
    async fn running_board(d: &Path, clock: Arc<Mutex<f64>>, started: Arc<Mutex<Vec<Vec<String>>>>) -> Arc<BoardBrowsers> {
        let dir = d.join("browsers/biz-whatsapp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(PORT_FILE), "53111\n/devtools/browser/0b5e5a6c-1111-2222-3333-444455556666\n").unwrap();
        std::fs::write(d.join("board-browsers.json"), r#"{"browsers":[{"id":"biz-whatsapp","name":"Biz WhatsApp","createdAt":"2026-11-01T10:00:00.000Z","lastUsedAt":null,"lastSite":null,"keepRunning":false,"signedIn":true,"startUrl":null,"check":null}],"running":{}}"#).unwrap();
        let mut deps = fake(started);
        // Asked to close, it is gone.
        let closed = Arc::new(AtomicBool::new(false));
        let (c1, c2, c3) = (closed.clone(), closed.clone(), closed);
        deps.matches = Arc::new(move |pf| {
            let up = !c1.load(Ordering::SeqCst);
            Box::pin(async move { up && pf.port == 53111 })
        });
        deps.close = Arc::new(move |_| {
            c2.store(true, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        });
        deps.owner = Arc::new(|_, _| Box::pin(async { Ok(PortOwner { pid: 777, headless: true }) }));
        deps.alive = Arc::new(move |pid| pid == 777 && !c3.load(Ordering::SeqCst));
        deps.now = Arc::new(move || *clock.lock());
        let bb = BoardBrowsers::new(d, Arc::new(|| {}), deps);
        bb.init().await;
        bb
    }

    #[tokio::test]
    async fn a_run_holds_a_browser_only_from_its_first_call_until_it_ends() {
        let d = tempfile::tempdir().unwrap();
        let clock = Arc::new(Mutex::new(1_000_000.0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let bb = running_board(d.path(), clock.clone(), started.clone()).await;
        let id = "biz-whatsapp";
        let token = bb.grant("b/t1", &[id.to_string()], holder("t1"));
        // Granted but never used: not held, so Open window wouldn't wait.
        assert_eq!(bb.in_use(id), 0);
        assert_eq!(bb.view().0[0]["holders"], json!([]));
        // Outside callers and other runs' secrets can't hold it.
        assert_eq!(bb.claim("", id).await.unwrap_err().status, 403);
        assert_eq!(bb.claim("not-the-secret", id).await.unwrap_err().status, 403);
        let other = bb.grant("b/t2", &[], holder("t2"));
        assert_eq!(bb.claim(&other, id).await.unwrap_err().status, 403);
        // The first browser call holds it and names the run.
        assert_eq!(bb.claim(&token, id).await.unwrap(), 53111);
        assert_eq!(bb.in_use(id), 1);
        assert_eq!(bb.view().0[0]["holders"], json!([{ "kind": "task", "slug": "b", "id": "t1" }]));
        // Asking again keeps the same secret.
        assert_eq!(bb.grant("b/t1", &[id.to_string()], holder("t1")), token);
        // The run ends: it lets go, and its secret stops working.
        bb.release("b/t1");
        assert_eq!(bb.in_use(id), 0);
        assert_eq!(bb.claim(&token, id).await.unwrap_err().status, 403);
        assert_eq!(bb.in_use(id), 0);
    }

    #[tokio::test]
    async fn an_idle_run_lets_go_and_its_next_call_holds_it_again() {
        let d = tempfile::tempdir().unwrap();
        let clock = Arc::new(Mutex::new(1_000_000.0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let bb = running_board(d.path(), clock.clone(), started.clone()).await;
        let id = "biz-whatsapp";
        let token = bb.grant("huddle:b/h1/qa", &[id.to_string()], Holder { kind: "huddle", slug: "b".into(), id: "t1".into() });
        bb.claim(&token, id).await.unwrap();
        // A call within the idle time keeps the hold.
        *clock.lock() += LEASE_IDLE_MS - 1.0;
        bb.claim(&token, id).await.unwrap();
        *clock.lock() += LEASE_IDLE_MS - 1.0;
        bb.expire_leases();
        assert_eq!(bb.in_use(id), 1);
        assert_eq!(bb.view().0[0]["holders"][0]["kind"], "huddle");
        // No call for the idle time: it lets go.
        *clock.lock() += 2.0;
        bb.expire_leases();
        assert_eq!(bb.in_use(id), 0);
        // Its next call holds it again: the hold ran out, the right to use it didn't. Nothing new was started.
        assert_eq!(bb.claim(&token, id).await.unwrap(), 53111);
        assert_eq!(bb.in_use(id), 1);
        assert!(started.lock().is_empty());
        bb.release("huddle:b/h1/qa");
        assert_eq!(bb.in_use(id), 0);
    }

    #[tokio::test]
    async fn open_window_waits_for_the_holder_then_opens() {
        let d = tempfile::tempdir().unwrap();
        let clock = Arc::new(Mutex::new(1_000_000.0));
        let started = Arc::new(Mutex::new(Vec::new()));
        let bb = running_board(d.path(), clock.clone(), started.clone()).await;
        let id = "biz-whatsapp";
        let token = bb.grant("b/t1", &[id.to_string()], holder("t1"));
        // Granted, never called: Open window doesn't wait (it goes ahead, and starts Chrome with a window).
        bb.claim(&token, id).await.unwrap();
        let (opened, msg) = bb.open_window(id, &Value::Null).await.unwrap();
        assert!(!opened, "{msg}");
        assert!(bb.view().0[0]["windowPending"].as_bool().unwrap());
        assert!(started.lock().is_empty(), "nothing taken from the run mid-task");
        // The run goes idle: the window it waited for opens (with a window, not hidden).
        *clock.lock() += LEASE_IDLE_MS;
        bb.expire_leases();
        for _ in 0..300 {
            if !started.lock().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let argv = started.lock().first().cloned().expect("the window was opened once the run let go");
        assert!(!argv.iter().any(|a| a.starts_with("--headless")));
    }

    #[test]
    fn names_slugs_and_addresses_like_bun() {
        assert_eq!(slug_for("  Work: WhatsApp!"), "work-whatsapp");
        assert_eq!(slug_for("Café Ünïcode"), "cafe-u-ni-code");
        assert_eq!(slug_for("!!!"), "browser");
        assert_eq!(name_from_id("fatt-interior-whatsapp"), "Fatt Interior WhatsApp");
        assert_eq!(clean_start_url(&json!("web.whatsapp.com")).unwrap(), Some("https://web.whatsapp.com/".into()));
        assert_eq!(clean_start_url(&json!("example.com/login")).unwrap(), Some("https://example.com/login".into()));
        assert_eq!(clean_start_url(&json!("ftp://example.com")).unwrap_err().status, 400);
        assert_eq!(clean_start_url(&json!(null)).unwrap(), None);
        assert!(clean_start_url(&json!("not a url at all://")).is_err());
        assert!(has_data_dir("chrome --user-data-dir=/a/b --x", "/a/b"));
        assert!(!has_data_dir("chrome --user-data-dir=/a/bc", "/a/b"));
        assert_eq!(parse_listeners("p12\nn127.0.0.1:9222\nn*:80\n", 9222), (vec![12], vec!["127.0.0.1:9222".to_string()]));
        assert!(loopback("[::1]:9222"));
        assert!(!loopback("*:9222"));
        let a = chrome_args("/c", "/d", Mode::Hidden, None, None);
        assert_eq!(a.last().unwrap(), "about:blank");
        assert!(a.contains(&"--headless=new".to_string()));
        assert_eq!(encode_uri_component("https://a.b/c?d=e f"), "https%3A%2F%2Fa.b%2Fc%3Fd%3De%20f");
    }

    #[tokio::test]
    async fn add_open_close_remove_without_chrome() {
        let d = tempfile::tempdir().unwrap();
        let started = Arc::new(Mutex::new(Vec::new()));
        let bb = BoardBrowsers::new(d.path(), Arc::new(|| {}), fake(started.clone()));
        bb.init().await;
        let b = bb.add(&json!("  Work   WhatsApp ")).await.unwrap();
        assert_eq!(b.id, "work-whatsapp");
        assert_eq!(bb.add(&json!("work whatsapp")).await.unwrap_err().status, 409);
        assert_eq!(bb.add(&json!("   ")).await.unwrap_err().status, 400);
        assert_eq!(bb.add(&json!("Work: WhatsApp!")).await.unwrap().id, "work-whatsapp-2");
        bb.remove("work-whatsapp-2").await.unwrap();
        let file: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("board-browsers.json")).unwrap()).unwrap();
        assert_eq!(file["running"], json!({}));
        // The stub "Chrome" is gone at once: 502, and the error shows on the browser.
        let e = bb.open_window("work-whatsapp", &json!("example.com/login")).await.unwrap_err();
        assert_eq!(e.status, 502);
        assert_eq!(started.lock()[0].last().unwrap(), "https://example.com/login");
        let (views, chrome) = bb.view();
        assert_eq!(chrome, json!({ "installed": true, "message": null }));
        assert_eq!(views[0]["state"], "stopped");
        assert_eq!(views[0]["error"], json!(e.message));
        assert_eq!(bb.screen("work-whatsapp").await.unwrap_err().status, 409);
        assert_eq!(bb.input("work-whatsapp", &json!({"type":"click","x":2,"y":0})).await.unwrap_err().status, 400);
        assert_eq!(bb.input("work-whatsapp", &json!({"type":"text","text":"hi"})).await.unwrap_err().status, 409);
        assert!(bb.close("work-whatsapp", "test").await.unwrap());
        // A run that may use it but hasn't called it holds nothing; a claim whose Chrome can't start doesn't hold it.
        let token = bb.grant("b/t1", &["work-whatsapp".to_string(), "gone".to_string()], holder("t1"));
        assert_eq!(bb.in_use("work-whatsapp"), 0);
        assert_eq!(bb.claim(&token, "work-whatsapp").await.unwrap_err().status, 502);
        assert_eq!(bb.in_use("work-whatsapp"), 0);
        assert_eq!(bb.claim(&token, "gone").await.unwrap_err().status, 403);
        bb.release("b/t1");
        bb.remove("work-whatsapp").await.unwrap();
        assert!(!d.path().join("browsers/work-whatsapp").exists());
        assert_eq!(bb.remove("work-whatsapp").await.unwrap_err().status, 404);
    }

    #[tokio::test]
    async fn init_adopts_folders_and_forgets_missing_ones() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("browsers/biz-whatsapp/Default")).unwrap();
        std::fs::write(d.path().join("browsers/biz-whatsapp/Default/Cookies"), "x").unwrap();
        std::fs::write(
            d.path().join("board-browsers.json"),
            r#"{"browsers":[{"id":"gone","name":"Gone"}],"running":{"gone":{"pid":1,"port":9,"path":"/devtools/browser/abcdefgh","mode":"hidden","startedAt":"x"}}}"#,
        )
        .unwrap();
        let bb = BoardBrowsers::new(d.path(), Arc::new(|| {}), fake(Arc::new(Mutex::new(Vec::new()))));
        bb.init().await;
        let b = bb.get("biz-whatsapp").unwrap();
        assert_eq!(b.name, "Biz WhatsApp");
        assert!(b.signed_in);
        assert_eq!(b.start_url.as_deref(), Some("https://web.whatsapp.com/"));
        assert!(bb.get("gone").is_none());
        let file: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("board-browsers.json")).unwrap()).unwrap();
        assert_eq!(file["running"], json!({}));
    }

    /// The switch to the Rust board: a Chrome Bun started (detached) is still running; Rust picks it up from Bun's
    /// `board-browsers.json` and the Chrome's port file, and writes `running` back in Bun's format for a switch back.
    #[tokio::test]
    async fn adopts_the_chromes_bun_left_running() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("browsers/biz-whatsapp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(PORT_FILE), "53111\n/devtools/browser/0b5e5a6c-1111-2222-3333-444455556666\n").unwrap();
        let bun = r#"{
  "browsers": [
    {
      "id": "biz-whatsapp",
      "name": "Biz WhatsApp",
      "createdAt": "2026-11-01T10:00:00.000Z",
      "lastUsedAt": null,
      "lastSite": null,
      "keepRunning": true,
      "signedIn": true,
      "startUrl": "https://web.whatsapp.com/",
      "check": null
    }
  ],
  "running": {
    "biz-whatsapp": {
      "pid": 777,
      "port": 53111,
      "path": "/devtools/browser/0b5e5a6c-1111-2222-3333-444455556666",
      "mode": "hidden",
      "startedAt": "2026-11-17T01:00:00.000Z"
    }
  }
}"#;
        std::fs::write(d.path().join("board-browsers.json"), bun).unwrap();
        let started = Arc::new(Mutex::new(Vec::new()));
        let mut deps = fake(started.clone());
        deps.matches = Arc::new(|pf| Box::pin(async move { pf.port == 53111 }));
        deps.owner = Arc::new(|_, _| Box::pin(async { Ok(PortOwner { pid: 777, headless: true }) }));
        deps.alive = Arc::new(|pid| pid == 777);
        let bb = BoardBrowsers::new(d.path(), Arc::new(|| {}), deps);
        bb.init().await;
        let (views, _) = bb.view();
        assert_eq!(views[0]["state"], "hidden");
        // Keep running and already running: nothing new starts.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(started.lock().is_empty());
        assert_eq!(bb.ensure("biz-whatsapp").await.unwrap(), 53111);
        // Unchanged state is left as Bun wrote it, byte for byte.
        assert_eq!(std::fs::read_to_string(d.path().join("board-browsers.json")).unwrap(), bun);
        bb.save();
        assert_eq!(std::fs::read_to_string(d.path().join("board-browsers.json")).unwrap(), bun);
    }

    #[tokio::test]
    async fn sign_in_check_follows_sites() {
        let d = tempfile::tempdir().unwrap();
        let mut deps = fake(Arc::new(Mutex::new(Vec::new())));
        let alerts = Arc::new(Mutex::new(Vec::<String>::new()));
        deps.probe = Arc::new(|_, _, _| Box::pin(async { Some(json!("out")) }));
        let bb = BoardBrowsers::new(d.path(), Arc::new(|| {}), deps);
        bb.add(&json!("Biz WhatsApp")).await.unwrap();
        let a = alerts.clone();
        bb.set_on_logged_out(Arc::new(move |_, _, site| a.lock().push(site.unwrap_or("").into())));
        bb.state.lock().set_rt("biz-whatsapp", Runtime { pid: Some(1), port: 9, path: "/devtools/browser/abcdefgh".into(), mode: Mode::Hidden, started_at: "x".into() });
        let page = |url: &str| PageTarget { id: "T1".into(), title: String::new(), url: url.into() };
        // First look: signed in.
        assert!(bb.check_sign_in("biz-whatsapp", 9, &[page("https://mail.example.com/inbox")]).await);
        assert_eq!(bb.get("biz-whatsapp").unwrap().check.unwrap().state, "in");
        // WhatsApp's page check says logged out; never seen in before: needs sign-in at once, no alert.
        assert!(bb.check_sign_in("biz-whatsapp", 9, &[page("https://web.whatsapp.com/")]).await);
        let c = bb.get("biz-whatsapp").unwrap().check.unwrap();
        assert_eq!((c.state.as_str(), c.site.as_deref()), ("out", Some("web.whatsapp.com")));
        assert!(alerts.lock().is_empty());
        let (views, _) = bb.view();
        assert_eq!(views[0]["signIn"], "Needs sign-in");
        // A port that changed meanwhile: nothing is kept.
        assert!(!bb.check_sign_in("biz-whatsapp", 10, &[page("https://web.whatsapp.com/")]).await);
    }
}
