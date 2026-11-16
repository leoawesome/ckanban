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
//! Every request in board mode goes through `handle` (R13), in Bun's order (`route()` and `api()` in
//! `src/api/server.ts`):
//! 1. the satellite's own calls (`/api/internal/...` with the edge header, `ckanban_board::gate::edge`);
//! 2. the request gate (`requestRefusal`: Host, and the Origin of a change; on the phone access listener phone access
//!    on, the tailnet host and the owner's login), a plain-text 403 as Bun sends it;
//! 3. the routes the Rust board answers (`GET /api/events`, the system routes), each with the Telegram front desk's
//!    gate (asked of the satellite) and the JSON-only rule first;
//! 4. on this Mac's listener the front's native routes (usage, spend, passes, agents), then Bun; on the phone access
//!    listener Bun, told it is a phone request. Bun checks the gate again on its side.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use bytes::Bytes;
use ckanban_board::core::{Core, Services};
use ckanban_board::events::{self, EventHooks};
use ckanban_board::gate::edge::{self, SATELLITE_HEADER, SatelliteClient};
use ckanban_board::gate::remote::RemoteFile;
use ckanban_board::gate::request::{self, FRONT_DESK_HEADER, HUDDLE_HEADER, LISTENER_HEADER, Listener, RUN_HEADER, Seen};
use ckanban_board::gate::{housekeeping, system, update::UpdateChecker};
use ckanban_board::lock::{self, BoardLock};
use ckanban_board::mode::{self, Decision};
use ckanban_board::runs::js;
use ckanban_board::runs::model_versions::ModelVersions;
use ckanban_board::satellite;
use ckanban_board::schedules::cron;
use ckanban_core::time::{iso, now_ms};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{CONTENT_TYPE, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Value, json};

use crate::mask;
use crate::passes;
use crate::proxy::{Body, Proxy, full, plain, wants_upgrade};
use crate::routes::Native;

/// How long board mode waits for the data lock (an owner that is stopping lets go in a moment).
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// The largest body the satellite's calls and the front desk's gate read (a front desk request is a small JSON).
const MAX_BODY: usize = 8 * 1024 * 1024;

pub struct BoardMode {
    pub core: Arc<Core>,
    hooks: Arc<EventHooks>,
    public_port: u16,
    remote_port: u16,
    root: PathBuf,
    secret: String,
    remote: RemoteFile,
    updates: UpdateChecker,
    /// `learnedVersions` for `claude/defaults` (`<data>/model-versions.json`; R7a's runs will share one).
    versions: ModelVersions,
    /// Lines to the satellite's stdin, once it runs (`connect_satellite`).
    tell: OnceLock<tokio::sync::mpsc::UnboundedSender<String>>,
    _lock: BoardLock,
}

/// Board mode for this start, or None: Bun runs the whole board (off, or a fallback, already logged and recorded).
/// `internal_port` and `secret` are the satellite's, for the calls the board makes to it.
pub async fn prepare(root: &Path, public_port: u16, remote_port: u16, internal_port: u16, secret: &str) -> Option<Arc<BoardMode>> {
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
    services.satellite = Arc::new(SatelliteClient::new(internal_port, public_port, secret));
    let core = Core::new(root, services);
    if let Err(e) = core.start(Core::steps()).await {
        // Let go first: Bun's full mode takes the lock next.
        drop(lock);
        return fall_back(root, &e, crashes);
    }
    if let Err(e) = mode::record_board(root, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    eprintln!("ckanban-rs: board mode: the Rust board owns this data folder; Bun runs as its satellite");
    // Start-up clean-ups, report-only (plan 5.3); the satellite skips its own.
    let r = root.to_path_buf();
    tokio::spawn(async move { housekeeping::at_start(&r).await });
    let hooks = Arc::new(EventHooks { views: core.services.views.clone(), cut: core.services.cut.clone(), mask: masker(root) });
    Some(Arc::new(BoardMode {
        core,
        hooks,
        public_port,
        remote_port,
        root: root.to_path_buf(),
        secret: secret.to_string(),
        remote: RemoteFile::new(root),
        updates: UpdateChecker::new(),
        versions: ModelVersions::new(Some(root.join("model-versions.json"))),
        tell: OnceLock::new(),
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

/// A route the Rust board answers itself (Bun's conditions on the decoded path parts, `src/api/system.ts`).
#[derive(Debug, Clone, PartialEq)]
pub enum Own {
    Events,
    Health,
    Version,
    Profile,
    CronPreview,
    ClaudeProjects,
    ClaudeDefaults,
    PickFolder,
}

/// `url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent)` for an `/api/` path; None when a part
/// doesn't decode (Bun answers that: 400 "malformed URL").
pub fn api_parts(path: &str) -> Option<Vec<String>> {
    let rest = path.strip_prefix("/api/")?;
    rest.split('/')
        .filter(|p| !p.is_empty())
        .map(decode_uri_component)
        .collect()
}

/// `decodeURIComponent`: None where JS throws (a `%` without two hex digits, bytes that aren't UTF-8).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let (h, l) = (b.get(i + 1).copied().and_then(hex)?, b.get(i + 2).copied().and_then(hex)?);
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Which own route a request is, if any.
pub fn own_route(method: &Method, path: &str) -> Option<Own> {
    let parts = api_parts(path)?;
    let p = |i: usize| parts.get(i).map(String::as_str);
    let get = *method == Method::GET;
    let post = *method == Method::POST;
    Some(match (p(0)?, p(1)) {
        ("health", _) if get => Own::Health,
        ("debug", Some("profile")) if post => Own::Profile,
        ("events", _) if get => Own::Events,
        ("version", _) if get => Own::Version,
        ("cron", Some("preview")) if get && parts.len() == 2 => Own::CronPreview,
        ("claude", Some("projects")) if get => Own::ClaudeProjects,
        ("claude", Some("defaults")) if get => Own::ClaudeDefaults,
        ("pick-folder", _) if post => Own::PickFolder,
        _ => return None,
    })
}

/// `URLSearchParams.get(name)` of a query.
fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// The text Bun's gate sends: 403, plain text.
fn refused(text: &str) -> Response<Body> {
    plain(StatusCode::FORBIDDEN, text)
}

impl BoardMode {
    fn secrets(&self) -> Vec<String> {
        passes::current_secrets(&self.root)
    }

    fn json(&self, status: StatusCode, v: &Value) -> Response<Body> {
        passes::json_answer(status, v, &self.secrets())
    }

    fn error(&self, status: StatusCode, msg: &str) -> Response<Body> {
        self.json(status, &json!({ "error": msg }))
    }

    /// Every request in board mode, from this Mac's listener (`via` Local) or the phone access listener (Remote).
    pub async fn handle(self: &Arc<Self>, req: Request<Incoming>, peer: SocketAddr, via: Listener, native: &Native, proxy: &Proxy) -> Response<Body> {
        let mut res = self.route(req, peer, via, native, proxy).await;
        if via == Listener::Remote {
            res.headers_mut().insert(LISTENER_HEADER, HeaderValue::from_static("remote"));
        }
        res
    }

    async fn route(self: &Arc<Self>, req: Request<Incoming>, peer: SocketAddr, via: Listener, native: &Native, proxy: &Proxy) -> Response<Body> {
        // 1. The satellite's calls (only on this Mac's listener, only with this start's secret).
        if via == Listener::Local
            && let Some(name) = req.uri().path().strip_prefix(edge::INTERNAL_PREFIX)
            && req.method() == Method::POST
            && req.headers().get(SATELLITE_HEADER).is_some_and(|v| edge::secret_matches(v.as_bytes(), &self.secret))
        {
            let name = name.to_string();
            return self.internal(&name, req, native, proxy).await;
        }
        // 2. The gate.
        let remote = self.remote.active();
        let seen = Seen::of(req.method().as_str(), req.headers());
        if let Some(why) = request::refusal(&seen, self.public_port, remote.as_ref(), via) {
            return refused(why);
        }
        // 3. Own routes.
        if !wants_upgrade(req.headers())
            && let Some(own) = own_route(req.method(), req.uri().path())
        {
            if via == Listener::Remote {
                self.note_visit();
            }
            return self.own(own, req.map(|b| b.boxed()), via).await;
        }
        // 4. Bun (and the front's native routes on this Mac).
        match via {
            Listener::Local => match native.answer(req, peer).await {
                Ok(res) => res,
                Err(req) => proxy.forward(req, peer).await,
            },
            Listener::Remote => proxy.forward_as(req.map(|b| b.boxed()), peer, &[(edge::VIA_HEADER, "remote")]).await,
        }
    }

    /// Phone access saw a visit (`noteVisit`): Bun keeps the time for `GET /api/remote`; requests it answers note
    /// it themselves.
    fn note_visit(&self) {
        if let Some(t) = self.tell.get() {
            let _ = t.send(format!("remote-visit {}\n", iso(now_ms())));
        }
    }

    /// An own route after the gate: the front desk's gate and the JSON-only rule first, as Bun's `api()` does.
    async fn own(self: &Arc<Self>, own: Own, req: Request<Body>, via: Listener) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let h = &parts.headers;
        if let Some(desk) = request::header_text(h, FRONT_DESK_HEADER) {
            if request::has(h, RUN_HEADER) || request::has(h, HUDDLE_HEADER) {
                return self.error(StatusCode::FORBIDDEN, "a board run can't also be the front desk");
            }
            let mut b = Value::Null;
            if parts.method != Method::GET && parts.method != Method::HEAD {
                match read_body(body).await {
                    Ok(bytes) => b = js::parse(&String::from_utf8_lossy(&bytes)).unwrap_or(Value::Null),
                    Err(e) => return self.error(StatusCode::BAD_REQUEST, &e),
                }
            }
            let ask = json!({ "desk": desk, "method": parts.method.as_str(), "path": parts.uri.path(), "body": b });
            match self.core.services.satellite.frontdesk_gate(ask).await {
                Ok(Some(held)) => {
                    let status = held.get("status").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::OK);
                    return self.json(status, held.get("body").unwrap_or(&Value::Null));
                }
                Ok(None) => {}
                Err(e) => return self.error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            }
        }
        let ctype = request::header_text(h, CONTENT_TYPE.as_str());
        if request::needs_json(parts.method.as_str()) && !request::json_type(ctype.as_deref()) {
            return self.error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json");
        }
        let query = parts.uri.query();
        match own {
            Own::Events => events::stream(&self.core.bus, self.hooks.clone(), events::PING_EVERY),
            Own::Health => self.json(StatusCode::OK, &system::health().await),
            Own::Version => self.json(StatusCode::OK, &self.updates.status().await),
            Own::CronPreview => {
                let expr = query_param(query, "expr");
                let v = tokio::task::spawn_blocking(move || cron::preview(expr.as_deref())).await.unwrap_or(Value::Null);
                self.json(StatusCode::OK, &v)
            }
            Own::ClaudeProjects => {
                let root = self.root.clone();
                let v = tokio::task::spawn_blocking(move || system::claude_projects(&root)).await.unwrap_or(Value::Array(vec![]));
                self.json(StatusCode::OK, &v)
            }
            Own::ClaudeDefaults => self.json(StatusCode::OK, &system::claude_defaults(&self.versions)),
            Own::PickFolder => self.json(StatusCode::OK, &system::pick_folder().await),
            Own::Profile => {
                let host = request::header_text(h, "host");
                let port = if via == Listener::Remote { 0 } else { self.remote_port };
                if via == Listener::Remote || !request::profile_allowed(request::has(h, RUN_HEADER), host.as_deref(), port) {
                    return self.error(StatusCode::FORBIDDEN, "profiles are taken from this Mac only");
                }
                match system::profile(query_param(query, "seconds").as_deref(), &self.root).await {
                    Ok(v) => self.json(StatusCode::OK, &v),
                    Err(e) => self.error(StatusCode::INTERNAL_SERVER_ERROR, &e),
                }
            }
        }
    }

    /// `/api/internal/<name>` from the satellite (the edge header checked).
    async fn internal(self: &Arc<Self>, name: &str, req: Request<Incoming>, native: &Native, proxy: &Proxy) -> Response<Body> {
        let b = match read_body(req.into_body().boxed()).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            Err(e) => return self.error(StatusCode::BAD_REQUEST, &e),
        };
        if name == "replay" {
            return self.replay(&b, native, proxy).await;
        }
        match edge::inbound(&*self.core.services.actions, name, &b).await {
            Some((status, v)) => {
                if !status.is_success() {
                    eprintln!("ckanban-rs: the satellite's {name}: {}", v.get("error").and_then(Value::as_str).unwrap_or(""));
                }
                self.json(status, &v)
            }
            None => self.error(StatusCode::NOT_FOUND, "not found"),
        }
    }

    /// A held front desk request after the user's Confirm, run as the user (Bun's `replay`: no gate, no front desk
    /// header): an own route here, else Bun with the confirmed mark. The answer is `{status, body}`.
    async fn replay(self: &Arc<Self>, b: &Value, native: &Native, proxy: &Proxy) -> Response<Body> {
        let method = b.get("method").and_then(Value::as_str).unwrap_or("GET");
        let path = b.get("path").and_then(Value::as_str).unwrap_or("/");
        let body = b.get("body").filter(|v| !v.is_null());
        let Ok(m) = Method::from_bytes(method.as_bytes()) else { return self.json(StatusCode::OK, &json!({ "status": 400, "body": { "error": "bad method" } })) };
        if !path.starts_with('/') {
            return self.json(StatusCode::OK, &json!({ "status": 404, "body": { "error": "not found" } }));
        }
        let mut rb = Request::builder().method(m.clone()).uri(path).header("host", format!("127.0.0.1:{}", self.public_port));
        let bytes = match body {
            Some(v) => {
                rb = rb.header("content-type", "application/json");
                Bytes::from(serde_json::to_vec(v).unwrap_or_default())
            }
            None => Bytes::new(),
        };
        let Ok(req) = rb.body(full(bytes)) else { return self.json(StatusCode::OK, &json!({ "status": 404, "body": { "error": "not found" } })) };
        let peer = SocketAddr::from(([127, 0, 0, 1], 0));
        let res = match own_route(&m, path) {
            Some(own) => self.own(own, req, Listener::Local).await,
            None => {
                let _ = native;
                proxy.forward_as(req, peer, &[(edge::CONFIRMED_HEADER, "1")]).await
            }
        };
        let status = res.status().as_u16();
        let text = match res.into_body().collect().await {
            Ok(c) => c.to_bytes(),
            Err(_) => Bytes::new(),
        };
        let data = serde_json::from_slice::<Value>(&text).unwrap_or(Value::Null);
        self.json(StatusCode::OK, &json!({ "status": status, "body": data }))
    }

    /// After the satellite answers: follow its event stream, give it the live state, and send it the board's events.
    pub async fn connect_satellite(&self, internal_port: u16, secret: &str, tell: tokio::sync::mpsc::UnboundedSender<String>) {
        if let Err(e) = satellite::follow(self.core.bus.clone(), internal_port, self.public_port, secret.to_string()).await {
            eprintln!("ckanban-rs: the satellite's event stream: {e}");
        }
        let s = &self.core.services;
        let snapshot = satellite::runtime_snapshot(&*s.runs, &*s.huddles, &*s.sessions, &boards(&self.root), &[]);
        let _ = tell.send(satellite::runtime_line(&snapshot));
        let _ = self.tell.set(tell.clone());
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

/// A body read whole, up to `MAX_BODY`.
async fn read_body(body: Body) -> Result<Bytes, String> {
    let limited = http_body_util::Limited::new(body, MAX_BODY);
    limited.collect().await.map(|c| c.to_bytes()).map_err(|e| format!("can't read the request body: {e}"))
}

/// The boards (folders under `profiles/`): a few names, read once at start.
fn boards(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root.join("profiles"))
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_routes_match_bun_conditions() {
        let g = Method::GET;
        let p = Method::POST;
        assert_eq!(own_route(&g, "/api/health"), Some(Own::Health));
        assert_eq!(own_route(&g, "/api//health/x"), Some(Own::Health));
        assert_eq!(own_route(&p, "/api/health"), None);
        assert_eq!(own_route(&g, "/api/events"), Some(Own::Events));
        assert_eq!(own_route(&g, "/api/version"), Some(Own::Version));
        assert_eq!(own_route(&g, "/api/version-history"), None);
        assert_eq!(own_route(&g, "/api/cron/preview"), Some(Own::CronPreview));
        assert_eq!(own_route(&g, "/api/cron/preview/x"), None);
        assert_eq!(own_route(&g, "/api/claude/projects"), Some(Own::ClaudeProjects));
        assert_eq!(own_route(&g, "/api/claude/defaults/x"), Some(Own::ClaudeDefaults));
        assert_eq!(own_route(&p, "/api/pick-folder"), Some(Own::PickFolder));
        assert_eq!(own_route(&p, "/api/debug/profile"), Some(Own::Profile));
        assert_eq!(own_route(&g, "/api/%68ealth"), Some(Own::Health));
        assert_eq!(own_route(&g, "/api/%zz/health"), None);
        assert_eq!(own_route(&g, "/health"), None);
        assert_eq!(own_route(&g, "/api/usage"), None);
        assert_eq!(decode_uri_component("a%2Fb%20").as_deref(), Some("a/b "));
        assert_eq!(decode_uri_component("%e2%82"), None);
        assert_eq!(decode_uri_component("%4"), None);
    }
}
