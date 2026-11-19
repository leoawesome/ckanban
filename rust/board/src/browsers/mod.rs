//! R9: shared devices, board browsers, named Chromes and the terminal, ported from `src/browser/` (`devices.ts`,
//! `chromes.ts`, `board-browsers.ts`, `cdp.ts`, `sign-in-signs.ts`, `shell.ts`, `terminals.ts`) and their routes
//! (`src/api/browsers.ts`, the ticket's `/devices`, the board's `/shell` WebSocket). `Browsers` holds them all and is
//! the board's `api::DeviceInfo`.
//!
//! Bun's satellite never starts any of this in board mode (no board browsers' init or upkeep, no terminal watcher), and
//! the routes below are answered here, so `devices.json`, `browsers.json` and `board-browsers.json` have one writer.
//! Board browsers' Chromes are detached: the ones Bun started before the switch are adopted at start (`init`), and Bun
//! adopts Rust's after a switch back, from the same `board-browsers.json` and each Chrome's `DevToolsActivePort`.
//!
//! What this module needs from the board (a ticket's title and copy of the folder, a board's name, path and browser
//! picks) comes through `BoardLookup`: files read on demand (one ticket or board at a time). The terminal watcher's
//! list of linked tickets comes from the R1 index (`linked_from_index`, plugged in by the server).

pub mod board_browsers;
pub mod cdp;
pub mod chromes;
pub mod devices;
pub mod js;
pub mod routes;
pub mod shell;
pub mod sign_in;
pub mod terminals;

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ckanban_core::DataDir;
use ckanban_core::datafile::read_json;
use serde_json::{Value, json};

use crate::api::{DeviceInfo, SessionInfo};
use crate::bus::Bus;
use crate::core::Core;
use board_browsers::{BoardBrowsers, BrowserDeps};
use chromes::Chromes;
use devices::Devices;
use shell::ShellManager;
use terminals::{Linked, TerminalWatcher};

/// How often the terminal watcher looks for terminals with a ticket's session (`TerminalWatcher.start`).
const TERMINAL_POLL: Duration = Duration::from_secs(3);

/// What the browser routes read from the board: boards and single tickets, as Bun's JSON.
pub trait BoardLookup: Send + Sync {
    /// Every board's `profile.json`, oldest first (`listProfiles`).
    fn profiles(&self) -> Vec<Value>;
    fn profile(&self, slug: &str) -> Option<Value>;
    /// A ticket as the API sends it (`{...meta, body}`); a file that doesn't parse is Bun's placeholder.
    fn ticket(&self, slug: &str, id: &str) -> Option<Value>;
}

/// A board or ticket name that is one plain path segment (never `..`, a slash or empty).
pub fn safe_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains('/') && !s.contains('\\') && !s.contains('\0')
}

/// `BoardLookup` on the data folder's files, one board or ticket at a time.
pub struct FileLookup {
    dir: DataDir,
}

impl FileLookup {
    pub fn new(root: &Path) -> Self {
        FileLookup { dir: DataDir::new(root.to_path_buf()) }
    }
}

impl BoardLookup for FileLookup {
    fn profiles(&self) -> Vec<Value> {
        // A board is a folder under profiles/: a handful, read each time (small, fixed-size data).
        let Ok(rd) = std::fs::read_dir(self.dir.profiles_dir()) else { return Vec::new() };
        let mut out: Vec<Value> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter_map(|s| self.profile(&s)).collect();
        let created = |p: &Value| p.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string();
        out.sort_by_key(created);
        out
    }

    fn profile(&self, slug: &str) -> Option<Value> {
        if !safe_segment(slug) {
            return None;
        }
        read_json(&self.dir.profile_file(slug)).ok().flatten()
    }

    fn ticket(&self, slug: &str, id: &str) -> Option<Value> {
        if !safe_segment(slug) || !safe_segment(id) {
            return None;
        }
        match ckanban_core::ticket::read(&self.dir.ticket_file(slug, id)) {
            Ok(Some(Ok(t))) => Some(t.to_json()),
            Ok(Some(Err(e))) => Some(ckanban_core::ticket::Ticket::corrupt(id, &e, &ckanban_core::time::iso(ckanban_core::time::now_ms())).to_json()),
            _ => None,
        }
    }
}

pub struct Browsers {
    pub root: PathBuf,
    pub devices: Arc<Devices>,
    pub chromes: Arc<Chromes>,
    pub board_browsers: Arc<BoardBrowsers>,
    pub shells: Arc<ShellManager>,
    pub terminals: Arc<TerminalWatcher>,
    pub lookup: Arc<dyn BoardLookup>,
    bus: Arc<OnceLock<Arc<Bus>>>,
}

fn emit(bus: &OnceLock<Arc<Bus>>, v: Value) {
    if let Some(b) = bus.get() {
        b.emit_json(v);
    }
}

/// `ticket.updated` with the ticket as its file has it (the event stream adds the view).
fn emit_ticket(bus: &OnceLock<Arc<Bus>>, lookup: &dyn BoardLookup, slug: &str, id: &str) {
    if bus.get().is_none() {
        return;
    }
    if let Some(t) = lookup.ticket(slug, id) {
        emit(bus, json!({ "type": "ticket.updated", "profile": slug, "ticket": t }));
    }
}

impl Browsers {
    pub fn new(root: &Path, lookup: Arc<dyn BoardLookup>, sessions: Arc<dyn SessionInfo>) -> Arc<Self> {
        Self::with_deps(root, lookup, sessions, BrowserDeps::real())
    }

    pub fn with_deps(root: &Path, lookup: Arc<dyn BoardLookup>, sessions: Arc<dyn SessionInfo>, deps: BrowserDeps) -> Arc<Self> {
        let bus: Arc<OnceLock<Arc<Bus>>> = Arc::new(OnceLock::new());
        let (b, l) = (bus.clone(), lookup.clone());
        // Who holds or waits changed: those tickets' cards and the Devices screen (`devicesChanged`).
        let devices = Arc::new(Devices::new(
            root,
            Arc::new(move |owners: &[String]| {
                for o in owners {
                    if let Some((slug, id)) = o.split_once('/') {
                        emit_ticket(&b, &*l, slug, id);
                    }
                }
                emit(&b, json!({ "type": "devices.updated" }));
            }),
        ));
        let b = bus.clone();
        let changed = Arc::new(move || emit(&b, json!({ "type": "browsers.updated" })));
        let chromes = Arc::new(Chromes::new(root, changed.clone()));
        let board_browsers = BoardBrowsers::new(root, changed, deps);
        let (b, l) = (bus.clone(), lookup.clone());
        let terminals = TerminalWatcher::new(sessions, Arc::new(move |slug: &str, id: &str| emit_ticket(&b, &*l, slug, id)));
        Arc::new(Browsers {
            root: root.to_path_buf(),
            devices,
            chromes,
            board_browsers,
            shells: Arc::new(ShellManager::default()),
            terminals,
            lookup,
            bus,
        })
    }

    /// The board's bus, once the core is built: events go out from then on.
    pub fn attach(&self, bus: Arc<Bus>) {
        let _ = self.bus.set(bus);
    }

    /// Start (Bun's daemon start, full mode): adopt the board browsers' folders and the Chromes still running (Bun's
    /// included), start the keep-running ones and the upkeep timer, then the terminal watcher. In the background, as
    /// Bun does; stopped with the core (board browsers are left running, shells end).
    pub fn start(self: &Arc<Self>, core: &Arc<Core>) {
        let bb = self.board_browsers.clone();
        tokio::spawn(async move {
            bb.init().await;
            bb.start();
        });
        self.terminals.start(TERMINAL_POLL);
        let me = self.clone();
        core.on_stop("browsers", move || {
            me.terminals.stop();
            me.shells.kill_all();
            me.board_browsers.shutdown();
        });
    }

    /// `browsersView`: the named Chromes, the board's own browsers, and each board's choice.
    pub fn browsers_view(&self) -> Value {
        let mut m = self.chromes.view().to_json();
        let (mut own, chrome) = self.board_browsers.view();
        // Each holder's ticket title and board name, read by id (one small file each; a browser has few holders).
        for b in &mut own {
            let Some(hs) = b.get_mut("holders").and_then(Value::as_array_mut) else { continue };
            for h in hs.iter_mut() {
                let (Some(slug), Some(id)) = (h.get("slug").and_then(Value::as_str).map(str::to_string), h.get("id").and_then(Value::as_str).map(str::to_string)) else { continue };
                let title = self.lookup.ticket(&slug, &id).and_then(|t| t.get("title").cloned()).unwrap_or(Value::Null);
                let board = self.lookup.profile(&slug).and_then(|p| p.get("name").cloned()).unwrap_or_else(|| json!(slug));
                if let Some(o) = h.as_object_mut() {
                    o.insert("title".into(), title);
                    o.insert("board".into(), board);
                }
            }
        }
        m.insert("boardBrowsers".into(), Value::Array(own));
        m.insert("chrome".into(), chrome);
        let boards: Vec<Value> = self
            .lookup
            .profiles()
            .iter()
            .map(|p| {
                let mut b = serde_json::Map::new();
                for k in ["slug", "name"] {
                    if let Some(v) = p.get(k) {
                        b.insert(k.into(), v.clone());
                    }
                }
                b.insert("chrome".into(), p.get("chrome").cloned().unwrap_or(Value::Null));
                b.insert("browsers".into(), chromes::picks_json(&chromes::own_picks(Some(p))));
                Value::Object(b)
            })
            .collect();
        m.insert("boards".into(), Value::Array(boards));
        Value::Object(m)
    }

    /// `deviceViews`: every device, who uses it and who waits, with each ticket's title and board name.
    pub fn device_views(&self) -> Value {
        let who = |u: &devices::DeviceUser| {
            let mut m = u.to_json();
            let title = self.lookup.ticket(&u.slug, &u.id).and_then(|t| t.get("title").cloned()).unwrap_or(Value::Null);
            m.insert("title".into(), title);
            let board = self.lookup.profile(&u.slug).and_then(|p| p.get("name").cloned()).unwrap_or_else(|| json!(u.slug));
            m.insert("board".into(), board);
            Value::Object(m)
        };
        Value::Array(
            self.devices
                .views()
                .iter()
                .map(|v| {
                    let mut m = v.device.to_json();
                    m.insert("using".into(), Value::Array(v.using.iter().map(who).collect()));
                    m.insert("waiting".into(), Value::Array(v.waiting.iter().map(who).collect()));
                    Value::Object(m)
                })
                .collect(),
        )
    }

    /// The terminal watcher's linked tickets (board, ticket id, session id): R1's index plugs its listing in here.
    pub fn set_linked(&self, f: Linked) {
        self.terminals.set_linked(f);
    }
}

/// The terminal watcher's linked tickets from the board index (R1): every board's tickets with a session and a
/// working folder (Bun's `t.sessionId && t.workdir`). Called on a blocking thread every few seconds; the index keeps
/// each board's listing in memory, so this walks memory, not files.
pub fn linked_from_index(index: Arc<crate::index::Index>, lookup: Arc<dyn BoardLookup>) -> Linked {
    Arc::new(move || {
        let mut out = Vec::new();
        for p in lookup.profiles() {
            let Some(slug) = p.get("slug").and_then(Value::as_str) else { continue };
            for t in &index.list(slug).tickets {
                let truthy = |k: &str| t.json.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
                if let (Some(session), Some(_)) = (truthy("sessionId"), truthy("workdir")) {
                    out.push((slug.to_string(), t.id.clone(), session.to_string()));
                }
            }
        }
        out
    })
}

impl DeviceInfo for Browsers {
    fn terminal_open(&self, slug: &str, id: &str) -> bool {
        self.terminals.is_open(slug, id)
    }

    fn device_state(&self, slug: &str, id: &str) -> Option<Value> {
        self.devices.ticket_state(slug, id)
    }

    /// A run ended: its devices are freed and its board browsers let go (Bun's `releaseAll` and `release(key)`).
    fn release_all(&self, slug: &str, id: &str) {
        self.devices.release_all(slug, id);
        self.board_browsers.release(&format!("{slug}/{id}"));
    }

    /// The browsers a ticket's runs may use: its own, the nearest ticket above it with some, else the board's.
    fn browser_picks(&self, slug: &str, id: Option<&str>) -> Option<Value> {
        let profile = self.lookup.profile(slug);
        let picks = match id.and_then(|i| self.lookup.ticket(slug, i)) {
            None => chromes::own_picks(profile.as_ref()),
            Some(t) => {
                // The walk only needs the tickets above this one: read them one by one (at most 64 hops).
                let mut chain = vec![t.clone()];
                let mut cur = t.clone();
                for _ in 0..64 {
                    let Some(up) = cur.get("parentId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string) else { break };
                    if chain.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(&up)) {
                        break;
                    }
                    let Some(p) = self.lookup.ticket(slug, &up) else { break };
                    chain.push(p.clone());
                    cur = p;
                }
                chromes::resolve_browser_picks(&t, &chain, profile.as_ref())
            }
        };
        picks.map(|p| chromes::picks_json(&Some(p)))
    }
}
