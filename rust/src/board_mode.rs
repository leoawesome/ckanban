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
//! Routes the Rust board answers itself (more with each task): `GET /api/events`; R1's reads from the ticket index
//! (`GET /api/profiles`, `/api/profiles/:p`, `/api/profiles/:p/tickets`, `/api/profiles/:p/tickets/:id`,
//! `/api/tickets`, `/api/inbox`); the session routes (R5: a ticket's conversation, tool, agent and workflow details,
//! chat search and read, the board folder's sessions); a ticket's outputs, the files its chat mentions, its Changes
//! tab, the board's Files panel, `detect-setup` and `/api/version-history` (R6, `ckanban_board::git::routes`); the browsers,
//! devices and terminal routes (R9, `ckanban_board::browsers::routes`); the ticket and board writes (R2a,
//! `ckanban_board::tickets::routes`: create, change, delete, move, comments, snooze, seen, the chat's cards, boards
//! POST/PATCH/DELETE, attachments, avatars, snippets).
//! Everything else goes on to the usage, spend, passes and agents routes, then to Bun, as in front mode.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use ckanban_board::browsers::{self, Browsers, FileLookup};
use ckanban_board::core::{Core, Services};
use ckanban_board::events::{self, EventHooks};
use ckanban_board::git::{self, routes::GitRoutes};
pub use ckanban_board::git::routes::Next;
use ckanban_board::lock::{self, BoardLock};
use ckanban_board::mode::{self, Decision};
use ckanban_board::satellite;
use ckanban_board::sessions::routes::{self as session_routes, HUDDLE_HEADER, RUN_HEADER};
use ckanban_board::sessions::service::Sessions;
use ckanban_board::tickets::routes::{self as write_routes, Reply, Writes};
use ckanban_board::tickets::wiring::{TicketOps, Wired};
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
    sessions: Arc<Sessions>,
    hooks: Arc<EventHooks>,
    git: Arc<GitRoutes>,
    /// R2a: the ticket and board writes.
    writes: Arc<Writes>,
    /// The pass store, for key cards (set once the satellite answers: it hears of the passes file changing).
    passes: Arc<std::sync::OnceLock<Arc<passes::Passes>>>,
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
    let sessions = Sessions::new(root, text_masker(root));
    let mut services = Services::stand_ins();
    services.sessions = sessions.clone();
    let browsers = Browsers::new(root, Arc::new(FileLookup::new(root)), services.sessions.clone());
    services.devices = browsers.clone();
    let core = Core::new(root, services);
    browsers.attach(core.bus.clone());
    browsers.set_linked(browsers::linked_from_index(core.index.clone(), browsers.lookup.clone()));
    if let Err(e) = core.start(Core::steps()).await {
        // Let go first: Bun's full mode takes the lock next.
        drop(lock);
        return fall_back(root, &e, crashes);
    }
    // The session watcher and the projects folder feed (R5): `session.updated` on the board's event stream.
    sessions.start(&core);
    if let Err(e) = mode::record_board(root, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    eprintln!("ckanban-rs: board mode: the Rust board owns this data folder; Bun runs as its satellite");
    // Board browsers adopted (Bun's Chromes included), their upkeep and the terminal watcher, in the background.
    browsers.start(&core);
    let mask = masker(root);
    let hooks = Arc::new(EventHooks { views: core.services.views.clone(), cut: core.services.cut.clone(), mask: mask.clone() });
    let browser_routes = browsers::routes::RouteCtx {
        public_port,
        mask: mask.clone(),
        user_only: Arc::new(|h, peer| Box::pin(async move { crate::guard::user_only(&h, peer).await })),
    };
    let git = GitRoutes::new(root, public_port, mask, core.services.runs.clone());
    git::start_jobs(&core);
    // R2a: ticket writes, with comments masked as they are saved and the steps already in Rust plugged in.
    core.tickets.set_mask(text_masker(root));
    let s = sessions.clone();
    core.tickets.on_written(move |slug, id| s.ticket_changed(slug, id));
    let landing = git::landing::Git::new(root, Arc::new(TicketOps { tickets: core.tickets.clone() }));
    core.tickets.set_hooks(Arc::new(Wired { git: Some(landing), browsers: Some(browsers.clone()), root: root.to_path_buf() }));
    let passes: Arc<std::sync::OnceLock<Arc<passes::Passes>>> = Arc::new(std::sync::OnceLock::new());
    let p = passes.clone();
    let save_keys: write_routes::SaveKeys = Arc::new(move |slug, keys| match p.get() {
        Some(p) => p.save_board_keys(slug, keys),
        None => Err((503, "the board is still starting; try again in a moment".into())),
    });
    let writes = Arc::new(Writes::new(core.tickets.clone(), core.reads.clone(), sessions.clone(), save_keys));
    Some(Arc::new(BoardMode {
        core,
        sessions,
        browsers,
        browser_routes,
        hooks,
        git,
        writes,
        passes,
        public_port,
        root: root.to_path_buf(),
        _lock: lock,
    }))
}

fn fall_back(root: &Path, reason: &str, crashes: Vec<String>) -> Option<Arc<BoardMode>> {
    eprintln!("ckanban-rs: board mode is off for this start, Bun runs the whole board: {reason}");
    if let Err(e) = mode::record_fallback(root, reason, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    None
}

/// The pass store's secrets, read again only when the passes file changes.
fn secrets_of(root: &Path) -> impl Fn() -> Arc<Vec<String>> + Send + Sync + 'static {
    let file = root.join(passes::PASSES_FILE);
    let root = root.to_path_buf();
    let cache: Mutex<Option<((Option<SystemTime>, u64), Arc<Vec<String>>)>> = Mutex::new(None);
    move || {
        let stamp = std::fs::metadata(&file).map(|m| (m.modified().ok(), m.len())).unwrap_or((None, 0));
        let mut c = cache.lock().unwrap_or_else(|p| p.into_inner());
        match &*c {
            Some((s, v)) if *s == stamp => v.clone(),
            _ => {
                let v = Arc::new(passes::current_secrets(&root));
                *c = Some((stamp, v.clone()));
                v
            }
        }
    }
}

/// `maskSaved` (plain text, a stored chat preview) with the pass store's secrets.
fn text_masker(root: &Path) -> Arc<dyn Fn(&str) -> String + Send + Sync> {
    let secrets = secrets_of(root);
    Arc::new(move |text: &str| {
        let mut out = text.to_string();
        for s in secrets().iter() {
            if out.contains(s.as_str()) {
                out = out.replace(s.as_str(), "***");
            }
        }
        out
    })
}

/// `maskSavedJson` with the pass store's secrets, read again only when the passes file changes.
fn masker(root: &Path) -> events::Mask {
    let secrets = secrets_of(root);
    Arc::new(move |text: &str| mask::mask_saved_json(&secrets(), text))
}

impl BoardMode {
    /// The answer when the Rust board answers this request itself; None: it goes on (Rust's other routes, then Bun).
    /// The event stream, and the board's read routes (R1: boards, ticket lists and scopes, one ticket, the command
    /// bar's rows, the Inbox), worked out on the blocking pool.
    pub async fn answer(&self, req: &Request<Incoming>) -> Option<Response<Body>> {
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || h.get_all(HOST).iter().count() > 1 {
            return None;
        }
        if req.method() != Method::GET {
            return None;
        }
        let path = req.uri().path().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        let events = path == "/api/events";
        if !events && !is_read_route(&path) {
            return None;
        }
        if !local_host(h, self.public_port) {
            return Some(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        if events {
            return Some(events::stream(&self.core.bus, self.hooks.clone(), events::PING_EVERY));
        }
        let reads = self.core.reads.clone();
        let (status, body) = tokio::task::spawn_blocking(move || reads.answer(&path, &query)).await.ok()??;
        let text = (self.hooks.mask)(&serde_json::to_string(&body).unwrap_or_else(|_| "null".into()));
        Some(json_text(status, text))
    }

    /// The session routes (R5), answered from Claude's transcripts; None: the request goes on (to Bun).
    pub async fn answer_sessions(&self, req: &Request<Incoming>) -> Option<Response<Body>> {
        let h = req.headers();
        let path = req.uri().path();
        if !session_routes::wanted(req.method().as_str(), path) {
            return None;
        }
        // Anything Bun's gate treats specially (the Telegram front desk, odd Host headers) stays with Bun.
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || h.get_all(HOST).iter().count() > 1 || !local_host(h, self.public_port) {
            return None;
        }
        let r = session_routes::Req {
            method: req.method().as_str().to_string(),
            path: path.to_string(),
            query: req.uri().query().map(str::to_string),
            run: h.get(RUN_HEADER).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()),
            huddle: h.contains_key(HUDDLE_HEADER),
        };
        let reply = self.sessions.answer(r).await?;
        let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Some(passes::json_answer(status, &reply.body, &passes::current_secrets(&self.root)))
    }

    /// The routes the Rust board answers that need the request itself (its body, an upgrade, the caller): the
    /// browsers, devices and terminal routes (R9). Err gives the request back: it goes on (Rust's other routes, then
    /// Bun).
    #[allow(clippy::result_large_err)]
    pub async fn answer_request(&self, req: Request<Incoming>, peer: std::net::SocketAddr) -> Result<Response<Body>, Request<Incoming>> {
        if browsers::routes::owns(req.method(), req.uri().path(), req.headers()) {
            return Ok(self.browsers.answer(req, peer.port(), &self.browser_routes).await);
        }
        if write_routes::wanted(req.method().as_str(), req.uri().path()) {
            return self.answer_write(req, peer).await;
        }
        Err(req)
    }

    /// The ticket and board writes (R2a). Bun's gate first (Host, the Origin of a change, a JSON body for POST, PATCH
    /// and PUT except uploads), then the route on the blocking pool; the answer masked like every JSON answer.
    #[allow(clippy::result_large_err)]
    async fn answer_write(&self, req: Request<Incoming>, peer: std::net::SocketAddr) -> Result<Response<Body>, Request<Incoming>> {
        use http_body_util::{BodyExt, Limited};
        use hyper::header::{CONTENT_TYPE, ORIGIN};
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || [HOST, ORIGIN, CONTENT_TYPE].iter().any(|n| h.get_all(n).iter().count() > 1) {
            return Err(req);
        }
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        if !local_host(h, self.public_port) || (mutation && !crate::routes::local_origin(h, self.public_port)) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let path = req.uri().path().to_string();
        let upload = req.method() == Method::POST && path == "/api/attachments";
        if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT) && !upload && !crate::routes::json_type(h) {
            return Ok(passes::json_answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, &serde_json::json!({ "error": "content-type must be application/json" }), &passes::current_secrets(&self.root)));
        }
        let header = |n: &str| h.get(n).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).filter(|v| !v.is_empty());
        let content_type = header("content-type").map(|t| t.split(';').next().unwrap_or("").trim().to_lowercase()).unwrap_or_default();
        let file_name = header("x-file-name").and_then(|n| ckanban_board::tickets::files::decode_uri_component(&n));
        let (run, huddle, source) = (header(RUN_HEADER), header(HUDDLE_HEADER).is_some(), header(write_routes::SOURCE_HEADER));
        let headers = h.clone();
        let method = req.method().as_str().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        // Uploads may be 25 MB; anything bigger is refused by the route (413) without reading it all.
        let limit = if upload { ckanban_board::tickets::files::MAX_ATTACHMENT_BYTES + 1 } else { 16 << 20 };
        let body = match Limited::new(req.into_body(), limit).collect().await {
            Ok(b) => b.to_bytes().to_vec(),
            Err(_) if upload => vec![0; limit],
            Err(_) => return Ok(passes::json_answer(StatusCode::PAYLOAD_TOO_LARGE, &serde_json::json!({ "error": "request body too large" }), &passes::current_secrets(&self.root))),
        };
        let port = peer.port();
        let user: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || ckanban_board::tickets::writer::block(crate::guard::user_only(&headers, port)));
        let r = write_routes::Req { method, path, query, run, huddle, source, content_type, file_name, body, user };
        let writes = self.writes.clone();
        let reply = match tokio::task::spawn_blocking(move || writes.answer(&r)).await {
            Ok(Some(reply)) => reply,
            Ok(None) => return Ok(plain(StatusCode::NOT_FOUND, "not found")),
            Err(e) => {
                eprintln!("ckanban-rs: a write route failed: {e}");
                Reply::Json(500, serde_json::json!({ "error": "internal error" }))
            }
        };
        Ok(match reply {
            Reply::Json(status, v) => {
                let text = (self.hooks.mask)(&serde_json::to_string(&v).unwrap_or_else(|_| "null".into()));
                json_text(status, text)
            }
            Reply::Empty(status) => {
                use http_body_util::Full;
                let mut r = Response::new(Full::new(bytes::Bytes::new()).map_err(|never| match never {}).boxed());
                *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::NO_CONTENT);
                r
            }
            Reply::File(file, headers) => match tokio::fs::read(&file).await {
                Ok(bytes) => {
                    use http_body_util::Full;
                    let mut r = Response::new(Full::new(bytes::Bytes::from(bytes)).map_err(|never| match never {}).boxed());
                    for (k, v) in headers {
                        if let (Ok(k), Ok(v)) = (hyper::header::HeaderName::from_bytes(k.as_bytes()), hyper::header::HeaderValue::from_str(&v)) {
                            r.headers_mut().insert(k, v);
                        }
                    }
                    r
                }
                Err(_) => json_text(404, r#"{"error":"attachment not found"}"#.into()),
            },
        })
    }

    /// The routes the Rust board answers that need a request's body or slow work (R6's files, outputs and Changes
    /// routes): the answer, or the request for the next routes (as it came) or for Bun (its body already read).
    pub async fn answer_async(&self, req: Request<Incoming>) -> Result<Response<Body>, Next> {
        self.git.answer(req).await
    }

    /// After the satellite answers: follow its event stream, give it the live state, and send it the board's events.
    pub async fn connect_satellite(&self, internal_port: u16, secret: &str, tell: tokio::sync::mpsc::UnboundedSender<String>) {
        if let Err(e) = satellite::follow(self.core.bus.clone(), internal_port, self.public_port, secret.to_string()).await {
            eprintln!("ckanban-rs: the satellite's event stream: {e}");
        }
        let s = &self.core.services;
        let snapshot = satellite::runtime_snapshot(&*s.runs, &*s.huddles, &*s.sessions, &boards(&self.root), &[]);
        let _ = tell.send(satellite::runtime_line(&snapshot));
        // The pass store for key cards: Bun hears of each change to the passes file on its stdin.
        let notify_tell = tell.clone();
        let notify: passes::Notify = Arc::new(move |file: &str| {
            let _ = notify_tell.send(format!("changed {file}\n"));
        });
        let _ = self.passes.set(Arc::new(passes::Passes::new(self.root.clone(), notify)));
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

/// Paths the board's read routes may answer (`ckanban_board::index::routes`); the rest of `/api/profiles/...` goes
/// on to Bun without a trip to the blocking pool.
fn is_read_route(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        ["api", "inbox", ..] | ["api", "tickets"] | ["api", "profiles"] | ["api", "profiles", _] => true,
        ["api", "profiles", _, "tickets"] | ["api", "profiles", _, "tickets", _] => true,
        _ => false,
    }
}

fn json_text(status: u16, text: String) -> Response<Body> {
    use http_body_util::{BodyExt, Full};
    let mut r = Response::new(Full::new(bytes::Bytes::from(text)).map_err(|never| match never {}).boxed());
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    r.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    r
}

/// The boards (folders under `profiles/`): a few names, read once at start.
fn boards(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root.join("profiles"))
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    out.sort();
    out
}
