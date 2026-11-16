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
//! devices and terminal routes (R9, `ckanban_board::browsers::routes`); the team routes (R11b:
//! `/api/profiles/:p/huddle-presets`, `/huddle-templates`, `POST /squads`, `/huddle-notes`, after the same Host,
//! Origin and JSON type checks Bun makes).
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
use ckanban_board::team::{self, Team};
use ckanban_core::time::now_ms;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{CONTENT_TYPE, HOST, HeaderMap, ORIGIN};
use hyper::{Method, Request, Response, StatusCode};

use crate::mask;
use crate::passes;
use crate::proxy::{Body, plain, wants_upgrade};
use crate::routes::{local_host, query_param};

/// The Telegram front desk's header: its requests go through Bun's gate (as in routes.rs).
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// How long board mode waits for the data lock (an owner that is stopping lets go in a moment).
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// The largest request body the board's own routes read (a squad with every field full is well under 1 MB).
const MAX_BODY: usize = 8 << 20;

pub struct BoardMode {
    pub core: Arc<Core>,
    /// Teammates, squads and role notes (R11b).
    pub team: Arc<Team>,
    /// R9: devices, board browsers, named Chromes and the terminal.
    browsers: Arc<Browsers>,
    browser_routes: browsers::routes::RouteCtx,
    sessions: Arc<Sessions>,
    hooks: Arc<EventHooks>,
    git: Arc<GitRoutes>,
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
    let team = Arc::new(Team::new(root));
    let browser_routes = browsers::routes::RouteCtx {
        public_port,
        mask: mask.clone(),
        user_only: Arc::new(|h, peer| Box::pin(async move { crate::guard::user_only(&h, peer).await })),
    };
    let git = GitRoutes::new(root, public_port, mask, core.services.runs.clone());
    git::start_jobs(&core);
    Some(Arc::new(BoardMode { core, team, sessions, browsers, browser_routes, hooks, git, public_port, root: root.to_path_buf(), _lock: lock }))
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

    /// The team routes (`ckanban_board::team::routes`), or the request back when they don't take it. Bun's gate
    /// first, as `src/api/server.ts` runs it: the Host (403), the Origin of a change (403), then a JSON body type for
    /// POST, PATCH and PUT (415). Headers sent twice are joined, as Bun's `headers.get` does.
    #[allow(clippy::result_large_err)] // the request goes back whole, as `Native::answer` does
    pub async fn answer_team(&self, req: Request<Incoming>) -> Result<Response<Body>, Request<Incoming>> {
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) {
            return Err(req);
        }
        let path = req.uri().path();
        // A path Bun can't decode gets its "malformed URL" answer from Bun.
        let Some(parts) = path.strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        let method = req.method().as_str().to_string();
        if !team::routes::claims(&method, &parts) {
            return Err(req);
        }
        let host_ok = joined(h, HOST.as_str()).is_some_and(|host| ["localhost", "127.0.0.1"].iter().any(|l| host == format!("{l}:{}", self.public_port)));
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        let origin_ok = match joined(h, ORIGIN.as_str()) {
            None => true,
            Some(o) if o.is_empty() => true,
            Some(o) => ["localhost", "127.0.0.1"].iter().any(|l| o == format!("http://{l}:{}", self.public_port)),
        };
        if !host_ok || (mutation && !origin_ok) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let wants_body = matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT);
        let ctype = joined(h, CONTENT_TYPE.as_str()).unwrap_or_default();
        if wants_body && crate::js::trim(ctype.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
            return Ok(self.json(415, &serde_json::json!({ "error": "content-type must be application/json" }), false));
        }
        let has = |n: &str| h.get(n).is_some_and(|v| !v.as_bytes().is_empty());
        let from_run = has(RUN_HEADER) || has(HUDDLE_HEADER);
        let scope = query_param(req.uri().query().unwrap_or(""), "scope");
        let body: Bytes = if wants_body {
            match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) if e.is::<http_body_util::LengthLimitError>() => {
                    return Ok(self.json(413, &serde_json::json!({ "error": "request body too large" }), false));
                }
                Err(_) => return Ok(plain(StatusCode::BAD_REQUEST, "bad request")),
            }
        } else {
            Bytes::new()
        };
        let t = self.team.clone();
        let answer = tokio::task::spawn_blocking(move || {
            let call = team::routes::Call { method: &method, parts: &parts, scope, from_run, body: &body };
            team::routes::answer(&t, &call)
        })
        .await;
        Ok(match answer {
            Ok(a) => self.json(a.status, &a.value, a.success),
            Err(e) => self.json(500, &serde_json::json!({ "error": e.to_string() }), false),
        })
    }

    /// A JSON answer as Bun writes it (`JSON.stringify`); a success is masked with the saved keys (`ctx.json`).
    fn json(&self, status: u16, v: &serde_json::Value, success: bool) -> Response<Body> {
        let text = ckanban_core::datafile::to_text(v, ckanban_core::datafile::Layout::Compact);
        let text = if success { mask::mask_saved_json(&passes::current_secrets(&self.root), &text) } else { text };
        let mut r = Response::new(Full::new(Bytes::from(text)).map_err(|never| match never {}).boxed());
        *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        r.headers_mut().insert(CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
        r
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

/// A header as Bun's `headers.get` gives it: every value joined with ", "; None when it isn't sent.
fn joined(h: &HeaderMap, name: &str) -> Option<String> {
    let vals: Vec<String> = h.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
    (!vals.is_empty()).then(|| vals.join(", "))
}

/// The path parts after `/api/` as Bun splits them (`split("/").filter(Boolean)`, then `decodeURIComponent`); None
/// when one can't be decoded (Bun answers "malformed URL").
fn api_parts(rest: &str) -> Option<Vec<String>> {
    rest.split('/').filter(|p| !p.is_empty()).map(decode_component).collect()
}

/// `decodeURIComponent`: `%XX` bytes must make UTF-8, and a `%` must start one.
fn decode_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let (h, l) = (hex(*b.get(i + 1)?)?, hex(*b.get(i + 2)?)?);
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_parts_decode_like_bun() {
        assert_eq!(api_parts("profiles/my%20board//huddle-notes/_all/general"), Some(vec!["profiles".into(), "my board".into(), "huddle-notes".into(), "_all".into(), "general".into()]));
        assert_eq!(api_parts("profiles/a%2Fb/x"), Some(vec!["profiles".into(), "a/b".into(), "x".into()]));
        assert_eq!(api_parts("profiles/%zz"), None);
        assert_eq!(api_parts("profiles/%E2%82"), None);
        assert_eq!(api_parts("profiles/a+b"), Some(vec!["profiles".into(), "a+b".into()]));
    }

    #[test]
    fn repeated_headers_are_joined() {
        let mut h = HeaderMap::new();
        h.append(HOST, "localhost:1".parse().unwrap());
        h.append(HOST, "localhost:1".parse().unwrap());
        assert_eq!(joined(&h, "host").as_deref(), Some("localhost:1, localhost:1"));
        assert_eq!(joined(&h, "origin"), None);
    }
}
