//! Named Chromes (port of `src/browser/chromes.ts`, More → Browsers): the user's Chromes connected through Claude in
//! Chrome, learned from runs (a `list_connected_browsers` result in a run's stream, `ChromeWatch`), named once by the
//! user and picked per board or ticket. Keyed by deviceId (Claude in Chrome's display names swap on reconnect).
//! Saved in `browsers.json`, one list for this Mac, written like Bun (`formats::BROWSERS`).
//!
//! Also the browser picks of boards and tickets (`BrowserPick`): checking a list from a request, the old single
//! `chrome` setting, and which picks apply to a ticket (its own, the ticket above it, the board's).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ckanban_core::datafile::{formats, read_json, write_json};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::js;
use crate::prompts::js::{slice16, trim};

/// A board's default or a ticket's pick: "ask" (ask which Chrome each time).
pub const ASK_CHROME: &str = "ask";
pub const NOTE_MAX: usize = 120;
const PICKS_MAX: usize = 10;
const NAME_MAX: usize = 40;
const CHROME_TOOLS: &str = "mcp__claude-in-chrome__";
const FILE: &str = "browsers.json";

static ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._:-]{1,100}$").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub struct ChromeError {
    pub status: u16,
    pub message: String,
}

fn err(status: u16, message: impl Into<String>) -> ChromeError {
    ChromeError { status, message: message.into() }
}

pub fn valid_chrome_id(v: &str) -> bool {
    ID_RE.is_match(v)
}

fn valid_id_value(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| valid_chrome_id(s))
}

/// One Chrome in `browsers.json`, in Bun's key order.
#[derive(Debug, Clone, PartialEq)]
pub struct ChromeBrowser {
    pub device_id: String,
    /// The user's name for it ("" until named).
    pub name: String,
    /// Claude in Chrome's own display name when last listed.
    pub label: String,
    pub os_platform: Option<String>,
    pub first_seen_at: String,
    pub last_seen_at: String,
    /// Last site a run opened on it: (site, at).
    pub hint: Option<(String, String)>,
}

impl ChromeBrowser {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("deviceId".into(), json!(self.device_id));
        m.insert("name".into(), json!(self.name));
        m.insert("label".into(), json!(self.label));
        if let Some(p) = &self.os_platform {
            m.insert("osPlatform".into(), json!(p));
        }
        m.insert("firstSeenAt".into(), json!(self.first_seen_at));
        m.insert("lastSeenAt".into(), json!(self.last_seen_at));
        m.insert("hint".into(), self.hint.as_ref().map_or(Value::Null, |(site, at)| json!({ "site": site, "at": at })));
        Value::Object(m)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChromesState {
    pub browsers: Vec<ChromeBrowser>,
    pub listed_at: Option<String>,
    pub connected: Vec<String>,
}

impl ChromesState {
    /// `{browsers, listedAt, connected}`: the file and the first three keys of the browsers view.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("browsers".into(), Value::Array(self.browsers.iter().map(ChromeBrowser::to_json).collect()));
        m.insert("listedAt".into(), self.listed_at.as_ref().map_or(Value::Null, |s| json!(s)));
        m.insert("connected".into(), json!(self.connected));
        m
    }
}

/// What a run is told about Claude in Chrome (`ChromeChoice`); None: nothing (the rule stays as it was).
#[derive(Debug, Clone, PartialEq)]
pub enum ChromeChoice {
    Device { device_id: String, name: String, note: Option<String> },
    Devices(Vec<(String, String, Option<String>)>),
    Ask(Vec<(String, String)>),
}

impl ChromeChoice {
    /// Bun's JSON shape (`{kind: "device", deviceId, name, note?}` ...), as the prompts read it.
    pub fn to_json(&self) -> Value {
        let item = |id: &str, name: &str, note: &Option<String>| {
            let mut m = Map::new();
            m.insert("deviceId".into(), json!(id));
            m.insert("name".into(), json!(name));
            if let Some(n) = note {
                m.insert("note".into(), json!(n));
            }
            m
        };
        match self {
            ChromeChoice::Device { device_id, name, note } => {
                let mut m = Map::new();
                m.insert("kind".into(), json!("device"));
                m.extend(item(device_id, name, note));
                Value::Object(m)
            }
            ChromeChoice::Devices(list) => {
                json!({ "kind": "devices", "list": list.iter().map(|(i, n, o)| Value::Object(item(i, n, o))).collect::<Vec<_>>() })
            }
            ChromeChoice::Ask(named) => {
                json!({ "kind": "ask", "named": named.iter().map(|(i, n)| json!({ "deviceId": i, "name": n })).collect::<Vec<_>>() })
            }
        }
    }
}

/// One browser a board or ticket chose (`BrowserPick`): kind "chrome" (id = deviceId), "board" (id = a board browser)
/// or "ask"; note says what it is for.
#[derive(Debug, Clone, PartialEq)]
pub struct BrowserPick {
    pub kind: String,
    pub id: Option<String>,
    pub note: Option<String>,
}

impl BrowserPick {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), json!(self.kind));
        if let Some(id) = &self.id {
            m.insert("id".into(), json!(id));
        }
        if let Some(n) = &self.note {
            m.insert("note".into(), json!(n));
        }
        Value::Object(m)
    }

    /// A saved pick as Bun reads it (no checks: Bun trusts its own files).
    pub fn from_json(v: &Value) -> Option<BrowserPick> {
        let kind = v.get("kind")?.as_str()?.to_string();
        Some(BrowserPick {
            kind,
            id: v.get("id").and_then(Value::as_str).map(str::to_string),
            note: v.get("note").and_then(Value::as_str).map(str::to_string),
        })
    }
}

pub fn picks_json(p: &Option<Vec<BrowserPick>>) -> Value {
    p.as_ref().map_or(Value::Null, |l| Value::Array(l.iter().map(BrowserPick::to_json).collect()))
}

/// A board's or ticket's `chrome` setting from a request (`chromeSetting`): a known deviceId, "ask", or None.
pub fn chrome_setting(v: &Value, known: impl Fn(&str) -> bool) -> Result<Option<String>, ChromeError> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) if s == ASK_CHROME => Ok(Some(ASK_CHROME.into())),
        Value::String(s) if valid_chrome_id(s) && known(s) => Ok(Some(s.clone())),
        _ => Err(err(400, "chrome must be the deviceId of a Chrome in More → Browsers, \"ask\", or null")),
    }
}

/// The old single setting as a list of one (`picksFromLegacy`).
pub fn picks_from_legacy(chrome: Option<&str>) -> Option<Vec<BrowserPick>> {
    match chrome {
        None | Some("") => None,
        Some(ASK_CHROME) => Some(vec![BrowserPick { kind: "ask".into(), id: None, note: None }]),
        Some(id) if valid_chrome_id(id) => Some(vec![BrowserPick { kind: "chrome".into(), id: Some(id.into()), note: None }]),
        Some(_) => None,
    }
}

/// What one board or ticket set itself (`ownPicks`): its list when it has one, else its old single setting.
pub fn own_picks(x: Option<&Value>) -> Option<Vec<BrowserPick>> {
    let x = x?;
    if let Some(Value::Array(list)) = x.get("browsers")
        && !list.is_empty() {
            return Some(list.iter().filter_map(BrowserPick::from_json).collect());
        }
    picks_from_legacy(x.get("chrome").and_then(Value::as_str))
}

/// The old field kept in step with a list (`legacyChrome`): its first Claude in Chrome pick.
pub fn legacy_chrome(picks: Option<&[BrowserPick]>) -> Option<String> {
    let p = picks?.iter().find(|x| x.kind == "ask" || x.kind == "chrome")?;
    if p.kind == "ask" { Some(ASK_CHROME.into()) } else { p.id.clone() }
}

/// A board's or ticket's browser list from a request (`browserPicks`): each id must be known; duplicates dropped;
/// null or an empty list is None.
pub fn browser_picks(v: &Value, known_chrome: impl Fn(&str) -> bool, known_board: impl Fn(&str) -> bool) -> Result<Option<Vec<BrowserPick>>, ChromeError> {
    let list = match v {
        Value::Null => return Ok(None),
        Value::Array(a) => a,
        _ => return Err(err(400, "browsers must be a list of {kind, id, note}, or null")),
    };
    if list.len() > PICKS_MAX {
        return Err(err(400, format!("at most {PICKS_MAX} browsers")));
    }
    let mut out: Vec<BrowserPick> = Vec::new();
    for raw in list {
        let kind = raw.get("kind");
        let note_v = raw.get("note");
        let note = match note_v {
            Some(Value::String(s)) => slice16(trim(&js::squash_spaces(s)), NOTE_MAX).to_string(),
            _ => String::new(),
        };
        if matches!(note_v, Some(v) if !v.is_null() && !v.is_string()) {
            return Err(err(400, "a browser's note must be text"));
        }
        let id = raw.get("id");
        let mut pick = match kind.and_then(Value::as_str) {
            Some("ask") => BrowserPick { kind: "ask".into(), id: None, note: None },
            Some("chrome") => match id.and_then(valid_id_value) {
                Some(i) if known_chrome(i) => BrowserPick { kind: "chrome".into(), id: Some(i.into()), note: None },
                _ => return Err(err(400, "That Chrome isn't in More, Browsers.")),
            },
            Some("board") => match id.and_then(Value::as_str) {
                Some(i) if known_board(i) => BrowserPick { kind: "board".into(), id: Some(i.into()), note: None },
                _ => return Err(err(400, "That board browser isn't in More, Browsers.")),
            },
            _ => return Err(err(400, "a browser's kind must be chrome, board or ask")),
        };
        if !note.is_empty() {
            pick.note = Some(note);
        }
        if out.iter().any(|o| o.kind == pick.kind && o.id == pick.id) {
            continue;
        }
        out.push(pick);
    }
    Ok(if out.is_empty() { None } else { Some(out) })
}

/// The tickets a walk up the family looks at: id, parentId, and the picks it set itself.
fn walk_up<'a, T>(start: &'a Value, all: &'a [Value], mut own: impl FnMut(&'a Value) -> Option<T>) -> Option<T> {
    let mut seen: Vec<&str> = Vec::new();
    let mut cur = Some(start);
    while let Some(t) = cur {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        if seen.contains(&id) {
            break;
        }
        if let Some(x) = own(t) {
            return Some(x);
        }
        seen.push(id);
        cur = match t.get("parentId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(up) => all.iter().find(|o| o.get("id").and_then(Value::as_str) == Some(up)),
            None => None,
        };
    }
    None
}

/// The browsers that apply to a ticket (`resolveBrowserPicks`): its own, else the nearest ticket above it that set
/// some, else the board's. None: nothing set anywhere.
pub fn resolve_browser_picks(t: &Value, all: &[Value], board: Option<&Value>) -> Option<Vec<BrowserPick>> {
    walk_up(t, all, |x| own_picks(Some(x))).or_else(|| own_picks(board))
}

/// The old single setting that applies to a ticket (`resolveChromeSetting`).
pub fn resolve_chrome_setting(t: &Value, all: &[Value], board_default: Option<&str>) -> Option<String> {
    walk_up(t, all, |x| x.get("chrome").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string))
        .or_else(|| board_default.filter(|s| !s.is_empty()).map(str::to_string))
}

pub struct Chromes {
    file: PathBuf,
    state: Mutex<ChromesState>,
    on_change: Arc<dyn Fn() + Send + Sync>,
}

fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

impl Chromes {
    pub fn new(root: &Path, on_change: Arc<dyn Fn() + Send + Sync>) -> Self {
        let file = root.join(FILE);
        let state = load(&file);
        Chromes { file, state: Mutex::new(state), on_change }
    }

    /// Written under the lock (a small file), told after.
    fn save(&self, s: &ChromesState) {
        if let Err(e) = write_json(&self.file, &Value::Object(s.to_json()), formats::BROWSERS) {
            eprintln!("chromes: can't write {}: {e}", self.file.display());
        }
    }

    pub fn view(&self) -> ChromesState {
        self.state.lock().clone()
    }

    pub fn get(&self, device_id: &str) -> Option<ChromeBrowser> {
        self.state.lock().browsers.iter().find(|b| b.device_id == device_id).cloned()
    }

    /// A run listed the connected browsers (`listed`): only Chromes on this Mac are kept.
    pub fn listed(&self, list: &[Value], at: Option<String>) {
        let at = at.unwrap_or_else(now_iso);
        {
            let mut s = self.state.lock();
            let local: Vec<&Value> =
                list.iter().filter(|b| b.get("deviceId").and_then(valid_id_value).is_some() && b.get("isLocal") != Some(&Value::Bool(false))).collect();
            for b in &local {
                let id = b["deviceId"].as_str().unwrap_or_default();
                let name = b.get("name").and_then(Value::as_str).filter(|s| !s.is_empty());
                let os = b.get("osPlatform").and_then(Value::as_str).filter(|s| !s.is_empty());
                if let Some(known) = s.browsers.iter_mut().find(|x| x.device_id == id) {
                    known.last_seen_at = at.clone();
                    if let Some(n) = name {
                        known.label = n.into();
                    }
                    if let Some(o) = os {
                        known.os_platform = Some(o.into());
                    }
                } else {
                    s.browsers.push(ChromeBrowser {
                        device_id: id.into(),
                        name: String::new(),
                        label: b.get("name").and_then(Value::as_str).unwrap_or("").into(),
                        os_platform: os.map(str::to_string),
                        first_seen_at: at.clone(),
                        last_seen_at: at.clone(),
                        hint: None,
                    });
                }
            }
            s.listed_at = Some(at.clone());
            s.connected = local.iter().map(|b| b["deviceId"].as_str().unwrap_or_default().to_string()).collect();
            self.save(&s);
        }
        (self.on_change)();
    }

    /// A run opened a site on this Chrome: the hint that tells the Chromes apart (`sawSite`).
    pub fn saw_site(&self, device_id: &str, site: &str, at: Option<String>) {
        let at = at.unwrap_or_else(now_iso);
        {
            let mut s = self.state.lock();
            let Some(b) = s.browsers.iter_mut().find(|b| b.device_id == device_id) else { return };
            if site.is_empty() {
                return;
            }
            if let Some((hs, hat)) = &b.hint {
                let ms = |x: &str| ckanban_core::time::parse_date(x).unwrap_or(f64::NAN);
                if hs == site && ms(&at) - ms(hat) < 60_000.0 {
                    return;
                }
            }
            b.hint = Some((site.into(), at));
            self.save(&s);
        }
        (self.on_change)();
    }

    pub fn rename(&self, device_id: &str, name: &str) -> Result<(), ChromeError> {
        {
            let mut s = self.state.lock();
            let Some(i) = s.browsers.iter().position(|b| b.device_id == device_id) else { return Err(err(404, "no such Chrome")) };
            let clean = slice16(trim(&js::squash_spaces(name)), NAME_MAX).to_string();
            let low = clean.to_lowercase();
            if !clean.is_empty() && s.browsers.iter().enumerate().any(|(j, o)| j != i && o.name.to_lowercase() == low) {
                return Err(err(409, format!("another Chrome is already named \"{clean}\"")));
            }
            s.browsers[i].name = clean;
            self.save(&s);
        }
        (self.on_change)();
        Ok(())
    }

    /// Forgets a Chrome (it comes back, unnamed, the next time a run lists it).
    pub fn remove(&self, device_id: &str) -> Result<(), ChromeError> {
        {
            let mut s = self.state.lock();
            let before = s.browsers.len();
            s.browsers.retain(|b| b.device_id != device_id);
            if s.browsers.len() == before {
                return Err(err(404, "no such Chrome"));
            }
            self.save(&s);
        }
        (self.on_change)();
        Ok(())
    }

    pub fn named(&self) -> Vec<(String, String)> {
        self.state.lock().browsers.iter().filter(|b| !b.name.is_empty()).map(|b| (b.device_id.clone(), b.name.clone())).collect()
    }

    fn shown_name(b: &ChromeBrowser) -> String {
        if !b.name.is_empty() {
            b.name.clone()
        } else if !b.label.is_empty() {
            b.label.clone()
        } else {
            "this Chrome".into()
        }
    }

    /// The Claude in Chrome part of a browser list (`choiceOf`).
    pub fn choice_of(&self, picks: Option<&[BrowserPick]>) -> Option<ChromeChoice> {
        let picks = picks?;
        if picks.iter().any(|p| p.kind == "ask") {
            return self.choice(Some(ASK_CHROME));
        }
        let list: Vec<(String, String, Option<String>)> = picks
            .iter()
            .filter(|p| p.kind == "chrome")
            .filter_map(|p| {
                let b = self.get(p.id.as_deref()?)?;
                Some((b.device_id.clone(), Self::shown_name(&b), p.note.clone().filter(|n| !n.is_empty())))
            })
            .collect();
        match list.len() {
            0 => None,
            1 => {
                let (device_id, name, note) = list.into_iter().next().unwrap();
                Some(ChromeChoice::Device { device_id, name, note })
            }
            _ => Some(ChromeChoice::Devices(list)),
        }
    }

    /// What a run is told from a single setting (`choice`).
    pub fn choice(&self, setting: Option<&str>) -> Option<ChromeChoice> {
        let setting = setting.filter(|s| !s.is_empty())?;
        if setting == ASK_CHROME {
            let named = self.named();
            return if named.is_empty() { None } else { Some(ChromeChoice::Ask(named)) };
        }
        let b = self.get(setting)?;
        Some(ChromeChoice::Device { device_id: b.device_id.clone(), name: Self::shown_name(&b), note: None })
    }
}

/// `browsers.json` as Bun reads it.
fn load(file: &Path) -> ChromesState {
    let Ok(Some(raw)) = read_json(file) else { return ChromesState::default() };
    if !raw.is_object() {
        return ChromesState::default();
    }
    let s = |v: Option<&Value>, or: &dyn Fn() -> String| match v {
        None | Some(Value::Null) => or(),
        Some(v) => js::string(v),
    };
    let browsers = raw
        .get("browsers")
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter(|b| b.get("deviceId").and_then(valid_id_value).is_some())
                .map(|b| {
                    let first = s(b.get("firstSeenAt"), &now_iso);
                    let first_raw = b.get("firstSeenAt").filter(|v| !v.is_null()).cloned();
                    ChromeBrowser {
                        device_id: b["deviceId"].as_str().unwrap_or_default().into(),
                        name: b.get("name").and_then(Value::as_str).map(|n| slice16(n, NAME_MAX).to_string()).unwrap_or_default(),
                        label: b.get("label").and_then(Value::as_str).unwrap_or("").into(),
                        os_platform: b.get("osPlatform").and_then(Value::as_str).map(str::to_string),
                        last_seen_at: s(b.get("lastSeenAt"), &|| first_raw.as_ref().map(js::string).unwrap_or_else(now_iso)),
                        first_seen_at: first,
                        hint: b.get("hint").filter(|h| devices_truthy(h)).and_then(|h| {
                            let site = h.get("site")?.as_str()?.to_string();
                            Some((site, s(h.get("at"), &String::new)))
                        }),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    ChromesState {
        browsers,
        listed_at: raw.get("listedAt").and_then(Value::as_str).map(str::to_string),
        connected: raw
            .get("connected")
            .and_then(Value::as_array)
            .map(|l| l.iter().filter_map(valid_id_value).map(str::to_string).collect())
            .unwrap_or_default(),
    }
}

fn devices_truthy(v: &Value) -> bool {
    super::devices::truthy(v)
}

/// `host()`: a web address's host without `www.`; None for anything but http(s).
fn host(url: &Value) -> Option<String> {
    let s = url.as_str()?;
    let full = if js::has_scheme(s) { s.to_string() } else { format!("https://{s}") };
    let u = js::parse_url(&full)?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let h = js::hostname(&u);
    let h = h.strip_prefix("www.").unwrap_or(&h).to_string();
    if h.is_empty() { None } else { Some(h) }
}

fn result_text(content: Option<&Value>) -> Vec<String> {
    match content {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).filter(|t| !t.is_empty()).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

static NOT_FOUND_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)not (found|connected)|error").unwrap());

/// Reads one run's stream-json for Claude in Chrome calls (`ChromeWatch`): list results go to `Chromes::listed`, sites
/// the run opens on the Chrome it uses become that Chrome's hint.
pub struct ChromeWatch {
    chromes: Arc<Chromes>,
    calls: HashMap<String, (String, Value)>,
    current: Option<String>,
}

impl ChromeWatch {
    pub fn new(chromes: Arc<Chromes>) -> Self {
        ChromeWatch { chromes, calls: HashMap::new(), current: None }
    }

    pub fn feed(&mut self, ev: &Value) {
        let Some(Value::Array(content)) = ev.get("message").and_then(|m| m.get("content")) else { return };
        let ty = ev.get("type").and_then(Value::as_str);
        if ty == Some("assistant") {
            for b in content {
                if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let Some(name) = b.get("name").and_then(Value::as_str) else { continue };
                if let Some(short) = name.strip_prefix(CHROME_TOOLS) {
                    let id = b.get("id").map(js::string).unwrap_or_else(|| "undefined".into());
                    self.calls.insert(id, (short.to_string(), b.get("input").cloned().filter(|v| !v.is_null()).unwrap_or(json!({}))));
                }
            }
            return;
        }
        if ty != Some("user") {
            return;
        }
        for b in content {
            if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let key = b.get("tool_use_id").map(js::string).unwrap_or_else(|| "undefined".into());
            let Some(call) = self.calls.remove(&key) else { continue };
            if b.get("is_error").is_some_and(devices_truthy) {
                continue;
            }
            self.result(&call.0, &call.1, &result_text(b.get("content")));
        }
    }

    fn result(&mut self, name: &str, input: &Value, texts: &[String]) {
        match name {
            "list_connected_browsers" => {
                for text in texts {
                    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(text) else { continue };
                    let items: Vec<Value> = list.into_iter().filter(|b| b.get("deviceId").and_then(valid_id_value).is_some()).collect();
                    self.chromes.listed(&items, None);
                    let local: Vec<&Value> = items.iter().filter(|b| b.get("isLocal") != Some(&Value::Bool(false))).collect();
                    let pick = local.iter().find(|b| b.get("inUse").is_some_and(devices_truthy)).copied().or(if local.len() == 1 { Some(local[0]) } else { None });
                    self.current = pick.and_then(|b| b["deviceId"].as_str()).map(str::to_string);
                    return;
                }
            }
            "select_browser" => {
                if let Some(id) = input.get("deviceId").and_then(valid_id_value)
                    && !texts.iter().any(|t| NOT_FOUND_RE.is_match(t)) {
                        self.current = Some(id.into());
                    }
            }
            "switch_browser" => self.current = None,
            "navigate" => {
                if let (Some(site), Some(cur)) = (input.get("url").and_then(host), self.current.as_deref()) {
                    self.chromes.saw_site(cur, &site, None);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chromes(dir: &Path) -> Arc<Chromes> {
        Arc::new(Chromes::new(dir, Arc::new(|| {})))
    }

    #[test]
    fn reads_and_writes_browsers_json_like_bun() {
        let d = tempfile::tempdir().unwrap();
        let text = r#"{"browsers":[{"deviceId":"dev-work-1","name":"Work","label":"Browser 1","osPlatform":"mac","firstSeenAt":"2026-11-01T10:00:00.000Z","lastSeenAt":"2026-11-01T10:00:00.000Z","hint":null},{"deviceId":"bad id"}],"listedAt":"x","connected":["dev-work-1","bad id"]}"#;
        std::fs::write(d.path().join("browsers.json"), text).unwrap();
        let c = chromes(d.path());
        let v = c.view();
        assert_eq!(v.browsers.len(), 1);
        assert_eq!(v.connected, ["dev-work-1"]);
        c.rename("dev-work-1", "  Home   one ").unwrap();
        let raw = std::fs::read_to_string(d.path().join("browsers.json")).unwrap();
        assert!(raw.starts_with("{\n  \"browsers\": [\n    {\n      \"deviceId\": \"dev-work-1\",\n      \"name\": \"Home one\""));
        assert!(!raw.ends_with('\n'));
        assert_eq!(c.rename("nope", "x").unwrap_err().status, 404);
        assert_eq!(c.remove("dev-work-1"), Ok(()));
        assert_eq!(c.remove("dev-work-1").unwrap_err().status, 404);
    }

    #[test]
    fn watch_learns_chromes_and_sites() {
        let d = tempfile::tempdir().unwrap();
        let c = chromes(d.path());
        let mut w = ChromeWatch::new(c.clone());
        let list = r#"[{"deviceId":"a1","name":"Browser 1","isLocal":true,"inUse":true},{"deviceId":"r1","isLocal":false}]"#;
        w.feed(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"u1","name":"mcp__claude-in-chrome__list_connected_browsers","input":{}}]}}));
        w.feed(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u1","content":[{"type":"text","text":list}]}]}}));
        assert_eq!(c.view().connected, ["a1"]);
        w.feed(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"u2","name":"mcp__claude-in-chrome__navigate","input":{"url":"www.mail.google.com/x"}}]}}));
        w.feed(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"u2","content":"ok"}]}}));
        assert_eq!(c.get("a1").unwrap().hint.unwrap().0, "mail.google.com");
    }

    #[test]
    fn picks_like_bun() {
        let yes = |_: &str| true;
        let p = browser_picks(&json!([{"kind":"board","id":"wa","note":"  for   customers "},{"kind":"board","id":"wa"},{"kind":"ask"}]), yes, yes).unwrap().unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].note.as_deref(), Some("for customers"));
        assert_eq!(browser_picks(&json!([]), yes, yes).unwrap(), None);
        assert_eq!(browser_picks(&json!("x"), yes, yes).unwrap_err().status, 400);
        assert_eq!(browser_picks(&json!([{"kind":"chrome","id":"x","note":5}]), yes, yes).unwrap_err().message, "a browser's note must be text");
        let all = vec![json!({"id":"m","browsers":[{"kind":"chrome","id":"c1"}]}), json!({"id":"t","parentId":"m"})];
        let r = resolve_browser_picks(&all[1], &all, Some(&json!({"chrome":"ask"}))).unwrap();
        assert_eq!(r[0].id.as_deref(), Some("c1"));
        assert_eq!(resolve_browser_picks(&json!({"id":"z"}), &all, Some(&json!({"chrome":"ask"}))).unwrap()[0].kind, "ask");
        assert_eq!(legacy_chrome(Some(&r)), Some("c1".into()));
        assert_eq!(resolve_chrome_setting(&json!({"id":"z"}), &all, Some("d")), Some("d".into()));
    }
}
