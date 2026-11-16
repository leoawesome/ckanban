//! Board mode in the server (`docs/rust-port-board-plan.md` 3.1): decides at start whether the Rust board
//! (`ckanban-board`, `rust/board/`) owns the board this time, and holds it while it does. Off by default: without
//! `CKANBAN_RUST_BOARD=1` or `<data>/rust-board` holding `on`, nothing here runs and `ckanban-rs dev` is the front
//! server it was.
//!
//! On: take `<data>/board.lock`, start the Rust core, then start Bun as the satellite (`CKANBAN_SATELLITE=1`). If the
//! lock is held or the core can't start, or board mode ended uncleanly three times in 10 minutes, Bun runs the whole
//! board instead (full mode, as with board mode off) and the reason goes to this process's output (`daemon.log`
//! under launchd) and `<data>/rust-board-status.json`.
//!
//! Routes the Rust board answers itself (more with each task): `GET /api/events`; the browsers, devices and terminal
//! routes (R9, `ckanban_board::browsers::routes`). Everything else goes on to the
//! usage, spend, passes and agents routes, then to Bun, as in front mode.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use ckanban_board::browsers::{self, Browsers, FileLookup};
use ckanban_board::core::{Core, Services};
use ckanban_board::events::{self, EventHooks};
use ckanban_board::lock::{self, BoardLock};
use ckanban_board::mode::{self, Decision};
use ckanban_board::satellite;
use ckanban_core::time::now_ms;
use hyper::body::Incoming;
use hyper::header::HOST;
use hyper::{Method, Request, Response, StatusCode};

use crate::mask;
use crate::passes;
use crate::proxy::{Body, plain, wants_upgrade};
use crate::routes::local_host;

/// The Telegram front desk's header: its requests go through Bun's gate (as in routes.rs).
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// How long board mode waits for the data lock (an owner that is stopping lets go in a moment).
const LOCK_WAIT: Duration = Duration::from_secs(5);

pub struct BoardMode {
    pub core: Arc<Core>,
    /// R9: devices, board browsers, named Chromes and the terminal.
    browsers: Arc<Browsers>,
    browser_routes: browsers::routes::RouteCtx,
    hooks: Arc<EventHooks>,
    public_port: u16,
    root: PathBuf,
    _lock: BoardLock,
}

/// Board mode for this start, or None: Bun runs the whole board (off, or a fallback, already logged and recorded).
pub async fn prepare(root: &Path, public_port: u16) -> Option<Arc<BoardMode>> {
    let wanted = mode::wanted(std::env::var(mode::ENV).ok().as_deref(), root);
    let last = mode::read_status(root);
    let crashes = match mode::decide(&wanted, last.as_ref(), mode::switch_written(root), now_ms()) {
        Decision::Off => {
            mode::record_off(root);
            return None;
        }
        Decision::Fallback { reason, crashes } => return fall_back(root, &reason, crashes),
        Decision::Try { crashes } => crashes,
    };
    let r = root.to_path_buf();
    let taken = tokio::task::spawn_blocking(move || lock::take(&r, LOCK_WAIT)).await.unwrap_or_else(|e| Err(e.to_string()));
    let lock = match taken {
        Ok(l) => l,
        Err(e) => return fall_back(root, &e, crashes),
    };
    let mut services = Services::stand_ins();
    let browsers = Browsers::new(root, Arc::new(FileLookup::new(root)), services.sessions.clone());
    services.devices = browsers.clone();
    let core = Core::new(root, services);
    browsers.attach(core.bus.clone());
    if let Err(e) = core.start(Core::steps()).await {
        // Let go first: Bun's full mode takes the lock next.
        drop(lock);
        return fall_back(root, &e, crashes);
    }
    if let Err(e) = mode::record_board(root, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    eprintln!("ckanban-rs: board mode: the Rust board owns this data folder; Bun runs as its satellite");
    // Board browsers adopted (Bun's Chromes included), their upkeep and the terminal watcher, in the background.
    browsers.start(&core);
    let hooks = Arc::new(EventHooks { views: core.services.views.clone(), cut: core.services.cut.clone(), mask: masker(root) });
    let browser_routes = browsers::routes::RouteCtx {
        public_port,
        mask: hooks.mask.clone(),
        user_only: Arc::new(|h, peer| Box::pin(async move { crate::guard::user_only(&h, peer).await })),
    };
    Some(Arc::new(BoardMode { core, browsers, browser_routes, hooks, public_port, root: root.to_path_buf(), _lock: lock }))
}

fn fall_back(root: &Path, reason: &str, crashes: Vec<String>) -> Option<Arc<BoardMode>> {
    eprintln!("ckanban-rs: board mode is off for this start, Bun runs the whole board: {reason}");
    if let Err(e) = mode::record_fallback(root, reason, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    None
}

/// `maskSavedJson` with the pass store's secrets, read again only when the passes file changes.
fn masker(root: &Path) -> events::Mask {
    let file = root.join(passes::PASSES_FILE);
    let root = root.to_path_buf();
    let cache: Mutex<Option<((Option<SystemTime>, u64), Arc<Vec<String>>)>> = Mutex::new(None);
    Arc::new(move |text: &str| {
        let stamp = std::fs::metadata(&file).map(|m| (m.modified().ok(), m.len())).unwrap_or((None, 0));
        let secrets = {
            let mut c = cache.lock().unwrap_or_else(|p| p.into_inner());
            match &*c {
                Some((s, v)) if *s == stamp => v.clone(),
                _ => {
                    let v = Arc::new(passes::current_secrets(&root));
                    *c = Some((stamp, v.clone()));
                    v
                }
            }
        };
        mask::mask_saved_json(&secrets, text)
    })
}

impl BoardMode {
    /// The answer when the Rust board answers this request itself; None: it goes on (Rust's other routes, then Bun).
    pub fn answer(&self, req: &Request<Incoming>) -> Option<Response<Body>> {
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || h.get_all(HOST).iter().count() > 1 {
            return None;
        }
        if req.method() != Method::GET || req.uri().path() != "/api/events" {
            return None;
        }
        if !local_host(h, self.public_port) {
            return Some(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        Some(events::stream(&self.core.bus, self.hooks.clone(), events::PING_EVERY))
    }

    /// The routes the Rust board answers that need the request itself (its body, an upgrade, the caller): the
    /// browsers, devices and terminal routes (R9). Err gives the request back: it goes on (Rust's other routes, then
    /// Bun).
    #[allow(clippy::result_large_err)]
    pub async fn answer_request(&self, req: Request<Incoming>, peer: std::net::SocketAddr) -> Result<Response<Body>, Request<Incoming>> {
        if browsers::routes::owns(req.method(), req.uri().path(), req.headers()) {
            return Ok(self.browsers.answer(req, peer.port(), &self.browser_routes).await);
        }
        Err(req)
    }

    /// After the satellite answers: follow its event stream, give it the live state, and send it the board's events.
    pub async fn connect_satellite(&self, internal_port: u16, secret: &str, tell: tokio::sync::mpsc::UnboundedSender<String>) {
        if let Err(e) = satellite::follow(self.core.bus.clone(), internal_port, self.public_port, secret.to_string()).await {
            eprintln!("ckanban-rs: the satellite's event stream: {e}");
        }
        let s = &self.core.services;
        let snapshot = satellite::runtime_snapshot(&*s.runs, &*s.huddles, &*s.sessions, &boards(&self.root), &[]);
        let _ = tell.send(satellite::runtime_line(&snapshot));
        let views = s.views.clone();
        self.core.bus.on(move |e| {
            if let Some(line) = satellite::event_line(e, &*views) {
                let _ = tell.send(line);
            }
        });
    }

    /// Board mode ended with `code`: stop the core; a clean stop (0) is not counted as a crash.
    pub fn stop(&self, code: u8) {
        self.core.stop();
        mode::record_stop(&self.root, code == 0);
    }
}

/// The boards (folders under `profiles/`): a few names, read once at start.
fn boards(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root.join("profiles"))
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    out.sort();
    out
}
