//! The routes of R6 that board mode answers from files alone (no ticket is written): a ticket's outputs (list, serve,
//! Show in Finder, Copy file), the files a chat mentions (`find-files`, `file`), the Changes tab (`diff`), the board's
//! Files panel (`files`, `file`, `open-file`), `detect-setup` and `GET/POST /api/version-history`. Answers, errors and
//! headers are Bun's (`src/api/ticket-files.ts`, `profiles.ts`, `system.ts`).
//!
//! Anything unusual goes to the Bun satellite, which answers these routes from the same files: a request that isn't
//! from this Mac's board page (Bun's request gate decides), the front desk header, a malformed or odd path, a body
//! that isn't JSON where Bun would fail in its own way, a corrupt ticket file, publishing to claude.ai. The routes
//! that change tickets (`merge-into-main`, `land`, `branch`, `setup`, PR routes, `check-pr`) need the board's write
//! API and run loop and come with R2a/R7a, which call `landing::Git` and `pr`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited, StreamBody, combinators::BoxBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{CONTENT_TYPE, HOST, HeaderMap, HeaderName, HeaderValue, ORIGIN};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Map, Value, json};

use super::diff::{self, DiffError};
use super::files::{self, FileError};
use super::repo::{self, RepoKind};
use super::{setup, share};
use crate::api::RunControl;
use crate::events::Mask;

pub type Body = BoxBody<Bytes, hyper::Error>;

/// `RUN_HEADER`: board runs send it.
const RUN_HEADER: &str = "x-ckanban-run";
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
const LOCAL_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];
/// Bodies these routes take are small (a path, a list of paths); a bigger one goes to Bun.
const BODY_LIMIT: usize = 1 << 20;

/// What to do with a request these routes didn't answer.
pub enum Next {
    /// Not one of these routes: on to the other routes, as it came.
    Untouched(Request<Incoming>),
    /// One of these routes, but Bun answers it (its body already read).
    Bun(Request<Body>),
}

/// Which route a request is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    VersionHistory,
    BoardFiles { slug: String },
    BoardFile { slug: String },
    OpenFile { slug: String },
    DetectSetup { slug: String },
    Outputs { slug: String, id: String },
    Output { slug: String, id: String, name: String },
    FindFiles { slug: String, id: String },
    TicketFile { slug: String, id: String },
    Diff { slug: String, id: String },
}

/// `decodeURIComponent`, None when malformed (Bun answers 400 "malformed URL"; it is left to Bun).
fn decode(part: &str) -> Option<String> {
    // A "%" not followed by two hex digits is malformed for decodeURIComponent; percent_decode would keep it.
    let raw = part.as_bytes();
    for (i, b) in raw.iter().enumerate() {
        if *b == b'%' && !(raw.get(i + 1).is_some_and(u8::is_ascii_hexdigit) && raw.get(i + 2).is_some_and(u8::is_ascii_hexdigit)) {
            return None;
        }
    }
    String::from_utf8(percent_encoding::percent_decode_str(part).collect()).ok()
}

/// A board or ticket id that is one plain path segment.
fn plain_name(x: &str) -> bool {
    !x.is_empty() && x != "." && x != ".." && !x.contains(['/', '\\', '\0'])
}

/// The route of `method` and `path`, if it is one of these.
pub fn route_of(method: &Method, path: &str) -> Option<Route> {
    let post = method == Method::POST;
    let get = method == Method::GET;
    // Bun's server only routes paths that start with "/api/" (anything else is the UI's files).
    if !(post || get) || !path.starts_with("/api/") {
        return None;
    }
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(decode).collect::<Option<Vec<_>>>()?;
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    if parts.first() != Some(&"api") {
        return None;
    }
    let p = &parts[1..];
    if p == ["version-history"] {
        return Some(Route::VersionHistory);
    }
    if p.len() < 3 || p[0] != "profiles" || !plain_name(p[1]) {
        return None;
    }
    let slug = p[1].to_string();
    match (p.len(), p[2]) {
        (3, "files") if get => return Some(Route::BoardFiles { slug }),
        (3, "file") if get => return Some(Route::BoardFile { slug }),
        (3, "open-file") if post => return Some(Route::OpenFile { slug }),
        (3, "detect-setup") if post => return Some(Route::DetectSetup { slug }),
        _ => {}
    }
    if p.len() < 5 || p[2] != "tickets" || !plain_name(p[3]) {
        return None;
    }
    let id = p[3].to_string();
    match (p[4], p.len(), get) {
        ("outputs", 5, true) => Some(Route::Outputs { slug, id }),
        ("outputs", n, _) if n > 5 => Some(Route::Output { slug, id, name: p[5..].join("/") }),
        ("find-files", 5, false) => Some(Route::FindFiles { slug, id }),
        ("file", 5, true) => Some(Route::TicketFile { slug, id }),
        ("diff", 5, true) => Some(Route::Diff { slug, id }),
        _ => None,
    }
}

/// `URLSearchParams.get(name)`.
pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    let form = |x: &str| percent_encoding::percent_decode_str(&x.replace('+', " ")).decode_utf8_lossy().into_owned();
    query?.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (form(k) == name).then(|| form(v))
    })
}

fn header_str<'a>(h: &'a HeaderMap, name: impl hyper::header::AsHeaderName) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

/// `requestRefusal` on the local listener passes, and nothing makes Bun's answer special (front desk, repeated
/// headers). Otherwise the request goes to Bun, which refuses or answers it.
fn plain_local(h: &HeaderMap, method: &Method, port: u16) -> bool {
    let repeated = |n: &str| h.get_all(n).iter().count() > 1;
    if h.contains_key(FRONT_DESK_HEADER) || ["host", "origin", "content-type", RUN_HEADER].into_iter().any(repeated) {
        return false;
    }
    let Some(host) = header_str(h, HOST) else { return false };
    if !LOCAL_HOSTS.iter().any(|l| host == format!("{l}:{port}")) {
        return false;
    }
    if method != Method::GET {
        if let Some(o) = h.get(ORIGIN).filter(|o| !o.is_empty()) {
            if !o.to_str().is_ok_and(|o| LOCAL_HOSTS.iter().any(|l| o == format!("http://{l}:{port}"))) {
                return false;
            }
        }
        // Only JSON changes (Bun answers 415 otherwise).
        let ty = h.get(CONTENT_TYPE).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).unwrap_or_default();
        if ty.split(';').next().unwrap_or("").trim().to_lowercase() != "application/json" {
            return false;
        }
    }
    true
}

pub struct GitRoutes {
    root: PathBuf,
    port: u16,
    mask: Mask,
    runs: Arc<dyn RunControl>,
    /// Tells the board a folder's kind after version history was turned on (`board.noteRepo`), once R7a has a board.
    note_repo: Option<Arc<dyn Fn(&str, RepoKind) + Send + Sync>>,
    /// The Share menu's Publish (P2); None: the request goes on to Bun, as before.
    publisher: Option<Arc<super::publish::Publisher>>,
}

/// A refusal with Bun's `{error}` body (errors are not masked, as in Bun).
fn error(status: u16, message: &str) -> Response<Body> {
    let mut r = Response::new(full(serde_json::to_vec(&json!({ "error": message })).unwrap_or_default()));
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

fn full(b: Vec<u8>) -> Body {
    Full::new(Bytes::from(b)).map_err(|never| match never {}).boxed()
}

/// What a handler gives back.
enum Out {
    Json(u16, Value),
    Err(u16, String),
    File(PathBuf, bool),
    /// Bun answers it after all.
    Bun,
}

fn file_err(e: FileError) -> Out {
    Out::Err(e.status, e.message)
}

impl GitRoutes {
    pub fn new(root: &Path, port: u16, mask: Mask, runs: Arc<dyn RunControl>) -> Arc<GitRoutes> {
        Arc::new(GitRoutes { root: root.to_path_buf(), port, mask, runs, note_repo: None, publisher: None })
    }

    pub fn with_note_repo(mut self: Arc<Self>, f: Arc<dyn Fn(&str, RepoKind) + Send + Sync>) -> Arc<Self> {
        if let Some(me) = Arc::get_mut(&mut self) {
            me.note_repo = Some(f);
        }
        self
    }

    pub fn with_publisher(mut self: Arc<Self>, p: Arc<super::publish::Publisher>) -> Arc<Self> {
        if let Some(me) = Arc::get_mut(&mut self) {
            me.publisher = Some(p);
        }
        self
    }

    /// The answer, or what happens to the request next.
    pub async fn answer(&self, req: Request<Incoming>) -> Result<Response<Body>, Next> {
        let Some(route) = route_of(req.method(), req.uri().path()) else { return Err(Next::Untouched(req)) };
        if !plain_local(req.headers(), req.method(), self.port) {
            return Err(Next::Untouched(req));
        }
        // A body bigger than these routes take goes to Bun whole, before any of it is read.
        let declared = req.headers().get(hyper::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        if declared.is_some_and(|n| n > BODY_LIMIT as u64) {
            return Err(Next::Untouched(req));
        }
        let (mut parts, body) = req.into_parts();
        let bytes = if parts.method == Method::POST {
            match Limited::new(body, BODY_LIMIT).collect().await {
                Ok(c) => c.to_bytes(),
                // Too big without a length, or cut off: Bun answers from an empty body (and is told so).
                Err(_) => {
                    parts.headers.insert(hyper::header::CONTENT_LENGTH, HeaderValue::from(0u64));
                    parts.headers.remove(hyper::header::TRANSFER_ENCODING);
                    return Err(Next::Bun(Request::from_parts(parts, full(Vec::new()))));
                }
            }
        } else {
            Bytes::new()
        };
        let back = |parts: hyper::http::request::Parts, bytes: Bytes| Next::Bun(Request::from_parts(parts, full(bytes.to_vec())));
        // Read by the routes that take a body; a POST whose route ignores its body (share menu, detect-setup) never
        // looks at it, as in Bun.
        let body = (parts.method == Method::POST).then(|| serde_json::from_slice::<Value>(&bytes).map_err(|_| ()));
        let out = self.handle(&route, &parts.headers, parts.uri.query(), body).await;
        match out {
            Out::Json(status, v) => Ok(self.json(status, &v)),
            Out::Err(status, msg) => Ok(error(status, &msg)),
            Out::File(file, download) => Ok(raw_file(&file, download).await),
            Out::Bun => Err(back(parts, bytes)),
        }
    }

    fn json(&self, status: u16, v: &Value) -> Response<Body> {
        let text = (self.mask)(&serde_json::to_string(v).unwrap_or_default());
        let mut r = Response::new(full(text.into_bytes()));
        *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
        r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        r
    }

    fn data(&self) -> ckanban_core::home::DataDir {
        ckanban_core::home::DataDir::new(self.root.clone())
    }

    fn profile(&self, slug: &str) -> Option<Value> {
        self.data().profile(slug).map(|p| Value::Object(p.record.0))
    }

    /// The ticket's JSON; Err(Out::Bun) for a corrupt ticket file (Bun shows those its own way).
    fn ticket(&self, slug: &str, id: &str) -> Result<Option<Value>, Out> {
        let file = self.data().ticket_dir(slug, id).join("ticket.md");
        match ckanban_core::ticket::read(&file) {
            Ok(None) => Ok(None),
            Ok(Some(Ok(t))) => Ok(Some(t.to_json())),
            _ => Err(Out::Bun),
        }
    }

    fn outputs_dir(&self, slug: &str, id: &str) -> PathBuf {
        self.data().ticket_dir(slug, id).join("outputs")
    }

    async fn handle(&self, route: &Route, h: &HeaderMap, query: Option<&str>, body: Option<Result<Value, ()>>) -> Out {
        if *route == Route::VersionHistory {
            return self.version_history(query, body).await;
        }
        let slug = match route {
            Route::BoardFiles { slug }
            | Route::BoardFile { slug }
            | Route::OpenFile { slug }
            | Route::DetectSetup { slug }
            | Route::Outputs { slug, .. }
            | Route::Output { slug, .. }
            | Route::FindFiles { slug, .. }
            | Route::TicketFile { slug, .. }
            | Route::Diff { slug, .. } => slug.clone(),
            Route::VersionHistory => unreachable!(),
        };
        let Some(profile) = self.profile(&slug) else { return Out::Err(404, format!("board {slug} not found")) };
        let board_path = PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
        match route {
            Route::BoardFiles { .. } | Route::BoardFile { .. } => {
                let rel = query_param(query, "path").unwrap_or_default();
                let root = match self.panel_folder(&slug, &board_path, query_param(query, "ticket").as_deref()) {
                    Ok(r) => r,
                    Err(o) => return o,
                };
                let listing = matches!(route, Route::BoardFiles { .. });
                let r = tokio::task::spawn_blocking(move || {
                    if listing {
                        files::list_dir_page(&root, &rel).map(|(entries, more)| json!({ "path": rel, "entries": entries, "more": more }))
                    } else {
                        files::read_file_for_view(&root, &rel)
                    }
                })
                .await;
                match r {
                    Ok(Ok(v)) => Out::Json(200, v),
                    Ok(Err(e)) => file_err(e),
                    Err(e) => Out::Err(500, e.to_string()),
                }
            }
            Route::OpenFile { .. } => {
                let b = match need(body) {
                    Ok(b) => b,
                    Err(o) => return o,
                };
                let rel = js_string(b.get("path"));
                let ticket = b.get("ticket").and_then(Value::as_str).map(str::to_string);
                let root = match self.panel_folder(&slug, &board_path, ticket.as_deref()) {
                    Ok(r) => r,
                    Err(o) => return o,
                };
                let bin = std::env::var("CKANBAN_OPEN_BIN").ok().filter(|b| !b.is_empty());
                match tokio::task::spawn_blocking(move || files::open_with_system(&root, &rel, bin.as_deref())).await {
                    Ok(Ok(_)) => Out::Json(200, json!({ "ok": true })),
                    Ok(Err(e)) => file_err(e),
                    Err(e) => Out::Err(500, e.to_string()),
                }
            }
            Route::DetectSetup { .. } => Out::Json(200, setup::detect_setup(&board_path).await),
            _ => self.ticket_route(route, &slug, &profile, &board_path, h, query, body).await,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn ticket_route(&self, route: &Route, slug: &str, profile: &Value, board_path: &Path, h: &HeaderMap, query: Option<&str>, body: Option<Result<Value, ()>>) -> Out {
        let id = match route {
            Route::Outputs { id, .. } | Route::Output { id, .. } | Route::FindFiles { id, .. } | Route::TicketFile { id, .. } | Route::Diff { id, .. } => id.clone(),
            _ => unreachable!(),
        };
        let t = match self.ticket(slug, &id) {
            Ok(Some(t)) => t,
            Ok(None) => return Out::Err(404, format!("ticket {id} not found")),
            Err(o) => return o,
        };
        let outputs = self.outputs_dir(slug, &id);
        let post = body.is_some();
        match route {
            Route::Outputs { .. } => match tokio::task::spawn_blocking(move || files::list_outputs(&outputs)).await {
                Ok(Ok(list)) => Out::Json(200, Value::Array(list)),
                Ok(Err(e)) => Out::Err(500, e.to_string()),
                Err(e) => Out::Err(500, e.to_string()),
            },
            Route::Output { name, .. } => {
                // POST: the share menu; the user's alone, a board run has no business with the clipboard or Finder.
                if post && h.get(RUN_HEADER).is_some_and(|v| !v.is_empty()) {
                    return Out::Err(403, "sharing outputs is disabled inside a board run".into());
                }
                let (o, n) = (outputs.clone(), name.clone());
                let Ok(Some(file)) = tokio::task::spawn_blocking(move || files::output_path(&o, &n)).await else {
                    return Out::Err(404, "output not found".into());
                };
                if !post {
                    return Out::File(file, query_param(query, "download").as_deref() == Some("1"));
                }
                let r = match query_param(query, "action").as_deref() {
                    Some("reveal") => share::reveal_file(&file).await,
                    Some("copy") => share::copy_file_to_clipboard(&file).await,
                    // Publishing runs in the background (`startPublish`): the job answers 202.
                    Some("publish") => {
                        let Some(p) = &self.publisher else { return Out::Bun };
                        return match p.start(slug, &id, name, file) {
                            Ok(job) => Out::Json(202, job),
                            Err((status, e)) => Out::Err(status, e),
                        };
                    }
                    _ => return Out::Err(400, "action must be reveal, copy or publish".into()),
                };
                match r {
                    Ok(()) => Out::Json(200, json!({ "ok": true })),
                    Err(e) => Out::Err(e.status, e.message),
                }
            }
            Route::FindFiles { .. } => {
                let b = match need(body) {
                    Ok(b) => b,
                    Err(o) => return o,
                };
                // `(await body(req)).paths` on a null body is a TypeError in Bun: its own 500.
                if b.is_null() {
                    return Out::Bun;
                }
                let paths: Vec<String> = b
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).filter(|x| !x.trim().is_empty()).map(|x| x.trim().to_string()).take(200).collect())
                    .unwrap_or_default();
                let roots = files::file_roots(profile, &t, &outputs);
                let found = tokio::task::spawn_blocking(move || {
                    let home = ckanban_core::home::home_dir();
                    let mut found = Map::new();
                    for p in paths {
                        if let Some(f) = files::find_in_roots(&roots, &p, &home) {
                            found.insert(p, json!({ "root": f.root, "rel": f.rel }));
                        }
                    }
                    found
                })
                .await
                .unwrap_or_default();
                Out::Json(200, json!({ "found": found }))
            }
            Route::TicketFile { .. } => {
                let roots = files::file_roots(profile, &t, &outputs);
                let written = query_param(query, "path").unwrap_or_default();
                let found = tokio::task::spawn_blocking(move || files::find_in_roots(&roots, &written, &ckanban_core::home::home_dir())).await.ok().flatten();
                let Some(f) = found else { return Out::Err(404, "file not found in this ticket's folders".into()) };
                if query_param(query, "raw").as_deref() == Some("1") {
                    return Out::File(f.file, query_param(query, "download").as_deref() == Some("1"));
                }
                let (dir, rel) = (f.dir.clone(), f.rel.clone());
                match tokio::task::spawn_blocking(move || files::read_file_for_view(&dir, &rel)).await {
                    Ok(Ok(mut v)) => {
                        v["root"] = json!(f.root);
                        v["dir"] = json!(f.dir.to_string_lossy());
                        Out::Json(200, v)
                    }
                    Ok(Err(e)) => file_err(e),
                    Err(e) => Out::Err(500, e.to_string()),
                }
            }
            Route::Diff { .. } => {
                let w = query_param(query, "w").as_deref() == Some("1");
                match changes(profile, board_path, &t, w).await {
                    Ok(d) => Out::Json(200, d.to_json()),
                    Err(e) => Out::Err(e.status, e.message),
                }
            }
            _ => Out::Bun,
        }
    }

    /// `panelFolder`: the ticket's copy (`?ticket=`) while it exists, else the board folder.
    fn panel_folder(&self, slug: &str, board_path: &Path, ticket: Option<&str>) -> Result<PathBuf, Out> {
        // `if (!ticketId)`: an empty value is the board folder too.
        let Some(id) = ticket.filter(|t| !t.is_empty()) else { return Ok(board_path.to_path_buf()) };
        static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_-]{1,80}$").unwrap());
        if !RE.is_match(id) {
            return Err(Out::Err(400, "invalid ticket".into()));
        }
        let t = self.ticket(slug, id)?.ok_or_else(|| Out::Err(404, "ticket not found".into()))?;
        Ok(files::ticket_folder(board_path, id, t.get("worktree").and_then(Value::as_str)).0)
    }

    /// `GET/POST /api/version-history`: a folder's version history, and turning it on.
    async fn version_history(&self, query: Option<&str>, body: Option<Result<Value, ()>>) -> Out {
        let post = body.is_some();
        let b = match need(body) {
            Ok(b) => b,
            Err(o) => return o,
        };
        let path = if post {
            js_string(b.get("path"))
        } else {
            query_param(query, "path").unwrap_or_default()
        };
        if path.trim().is_empty() || !path.starts_with('/') {
            return Out::Err(400, "an absolute folder path is required".into());
        }
        let git = repo::git_installed().await;
        let dir = PathBuf::from(&path);
        if !post {
            let kind = if git && dir.exists() { json!(repo::repo_kind(&dir, true).await.as_str()) } else { Value::Null };
            return Out::Json(200, json!({ "git": git, "repo": kind }));
        }
        // "Cancel" under the card's pending line: the board no longer turns it on by itself.
        if b.get("cancel") == Some(&Value::Bool(true)) {
            if super::pending::clear(&self.root, &path) {
                self.blocking(move |r| r.folder_cards_changed(&path)).await;
            }
            return Out::Json(200, json!({ "pending": false }));
        }
        if !git {
            return Out::Err(400, "git isn't installed on this computer".into());
        }
        if !dir.exists() {
            return Out::Err(404, format!("folder does not exist: {path}"));
        }
        // No ticket may start editing the folder from here until it is on (or the request is saved): a ticket that
        // starts while the first snapshot is taken would leave half-done files in it.
        let p = path.clone();
        if !self.blocking(move |r| r.hold_folder(&p)).await {
            return Out::Err(409, "Version history is being turned on for this folder right now.".into());
        }
        let out = self.turn_on_or_wait(&path, &dir).await;
        self.blocking(move |r| r.release_folder(&path)).await;
        out
    }

    /// A run loop call that may wait for its lock or start runs, off the async threads.
    async fn blocking<R: Send + 'static>(&self, f: impl FnOnce(&dyn RunControl) -> R + Send + 'static) -> R
    where
        R: Default,
    {
        let runs = self.runs.clone();
        tokio::task::spawn_blocking(move || f(runs.as_ref())).await.unwrap_or_default()
    }

    /// The held part of `POST /api/version-history`: tickets editing the folder in place right now would leave
    /// half-done files in the first snapshot, so the board saves the request and turns it on once they have finished
    /// (`{pending: true}`); otherwise it is turned on now.
    async fn turn_on_or_wait(&self, path: &str, dir: &Path) -> Out {
        let boards: Vec<Value> = self.data().list_profiles().unwrap_or_default().into_iter().map(|p| Value::Object(p.record.0)).filter(|p| p.get("path").and_then(Value::as_str) == Some(path)).collect();
        // The board's one rule for a run editing the folder in place (the pill and "One ticket at a time" use it too).
        let p = path.to_string();
        let busy = self.blocking(move |r| r.folder_editors(&p)).await;
        if !busy.is_empty() {
            super::pending::set(&self.root, path, &crate::runloop::board::now_iso(), &busy);
            return Out::Json(202, json!({ "pending": true }));
        }
        let (r, kind) = match repo::turn_on_checked(dir).await {
            Ok(x) => x,
            Err((status, e)) => return Out::Err(status, e),
        };
        super::pending::clear(&self.root, path);
        if let Some(note) = &self.note_repo {
            for p in &boards {
                if let Some(slug) = p.get("slug").and_then(Value::as_str) {
                    note(slug, kind);
                }
            }
        }
        let mut v = r.to_json();
        v["repo"] = json!(kind.as_str());
        Out::Json(200, v)
    }
}

/// A route's JSON body (`await body(req)`): 400 "invalid JSON body" when it doesn't parse.
fn need(body: Option<Result<Value, ()>>) -> Result<Value, Out> {
    match body {
        Some(Ok(v)) => Ok(v),
        Some(Err(())) => Err(Out::Err(400, "invalid JSON body".into())),
        None => Ok(Value::Null),
    }
}

/// `String(x ?? "")`.
fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(x)) => x.clone(),
        Some(other) => other.to_string(),
    }
}

/// The Changes tab: the copy against where it started; a ticket working in the folder itself, the folder since its
/// first run; a main ticket, everything merged into its copy since it started.
pub async fn changes(profile: &Value, board_path: &Path, t: &Value, w: bool) -> Result<diff::TicketDiff, DiffError> {
    let get = |k: &str| t.get(k).and_then(Value::as_str).filter(|x| !x.is_empty());
    let worktree = get("worktree");
    if worktree.is_none() && get("workdir").is_none() {
        if let Some(sha) = get("baseSha") {
            return diff::folder_diff(board_path, sha, w).await;
        }
    }
    let Some(wt) = worktree else {
        return Err(DiffError { status: 404, message: "No version history for this folder, so changes can't be shown.".into() });
    };
    let wt = Path::new(wt);
    if ckanban_core::jsnum::truthy(t.get("main")) {
        if let Some(start) = get("startSha") {
            return diff::folder_diff(wt, start, w).await;
        }
    }
    let base = match profile.get("baseBranch").and_then(Value::as_str).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => repo::detect_base_branch(wt).await,
    };
    let pr_base = t.get("pr").and_then(|p| p.get("base")).and_then(Value::as_str);
    diff::ticket_diff(wt, &base, w, pr_base).await
}

/// `rawFile`: the file streamed as plain text in a sandbox (raster images as themselves), with a download name when
/// asked. A file that can't be opened any more is a 404.
async fn raw_file(file: &Path, download: bool) -> Response<Body> {
    let f = match tokio::fs::File::open(file).await {
        Ok(f) => f,
        Err(_) => return error(404, "output not found"),
    };
    let len = f.metadata().await.map(|m| m.len()).ok();
    let stream = futures_util::stream::unfold(f, |mut f| async move {
        use tokio::io::AsyncReadExt;
        let mut buf = vec![0u8; 64 * 1024];
        match f.read(&mut buf).await {
            Ok(0) | Err(_) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<_, hyper::Error>(Frame::data(Bytes::from(buf))), f))
            }
        }
    });
    let mut r = Response::new(StreamBody::new(stream).boxed());
    for (k, v) in files::raw_headers(file, download) {
        if let Ok(v) = HeaderValue::from_str(&v) {
            r.headers_mut().insert(HeaderName::from_static(k), v);
        }
    }
    if let Some(n) = len {
        r.headers_mut().insert(hyper::header::CONTENT_LENGTH, HeaderValue::from(n));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs as the route sees them: `running` edit the board folder; records holds and releases.
    struct FakeRuns {
        running: Vec<(String, String)>,
        log: parking_lot::Mutex<Vec<String>>,
    }

    impl RunControl for FakeRuns {
        fn is_running(&self, s: &str, i: &str) -> bool {
            self.running.iter().any(|(a, b)| a == s && b == i)
        }
        fn running_key(&self, _: &str, _: &str) -> Option<String> {
            None
        }
        fn holds_slot(&self, _: &str, _: &str) -> bool {
            false
        }
        fn start(&self, _: &str, _: &str) -> futures_util::future::BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn stop(&self, _: &str, _: &str) -> futures_util::future::BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn chat(&self, _: &str, _: &str, _: &str) -> futures_util::future::BoxFuture<'_, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn active_work(&self) -> Vec<String> {
            Vec::new()
        }
        fn busy_boards(&self) -> Vec<String> {
            Vec::new()
        }
        fn running_tickets(&self) -> Vec<(String, String)> {
            self.running.clone()
        }
        fn hold_folder(&self, p: &str) -> bool {
            self.log.lock().push(format!("hold {p}"));
            true
        }
        fn release_folder(&self, p: &str) {
            self.log.lock().push(format!("release {p}"));
        }
        fn folder_cards_changed(&self, p: &str) {
            self.log.lock().push(format!("cards {p}"));
        }
        fn folder_editors(&self, _: &str) -> Vec<(String, String)> {
            self.running.clone()
        }
    }

    #[tokio::test]
    async fn a_click_while_tickets_edit_the_folder_saves_a_request_and_cancel_clears_it() {
        if !repo::git_installed().await {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let project = root.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.to_string_lossy().to_string();
        std::fs::create_dir_all(root.join("profiles/b/tickets")).unwrap();
        std::fs::write(root.join("profiles/b/profile.json"), json!({ "name": "B", "slug": "b", "path": path, "workspace": "folder", "createdAt": "2026-11-01T00:00:00.000Z" }).to_string()).unwrap();
        let core = crate::core::Core::new(root, crate::core::Services::stand_ins());
        let mut m = serde_json::Map::new();
        m.insert("title".into(), "One".into());
        m.insert("body".into(), "".into());
        let id = core.tickets.create("b", m).unwrap().id.clone();
        let runs = Arc::new(FakeRuns { running: vec![("b".into(), id.clone())], log: Default::default() });
        let g = GitRoutes::new(root, 0, Arc::new(|s: &str| s.to_string()), runs.clone());
        let h = HeaderMap::new();
        let post = |v: Value| g.handle(&Route::VersionHistory, &h, None, Some(Ok(v)));
        match post(json!({ "path": path })).await {
            Out::Json(202, v) => assert_eq!(v, json!({ "pending": true })),
            _ => panic!("expected the request to be saved"),
        }
        assert!(super::super::pending::is_pending(root, &path));
        assert_eq!(super::super::pending::tickets_of(&super::super::pending::get(root, &path).unwrap()), vec![("b".to_string(), id.clone())]);
        assert!(!project.join(".git").exists(), "turned on while a ticket edits the folder");
        assert_eq!(*runs.log.lock(), vec![format!("hold {path}"), format!("release {path}")]);
        match post(json!({ "path": path, "cancel": true })).await {
            Out::Json(200, v) => assert_eq!(v, json!({ "pending": false })),
            _ => panic!("expected cancel to answer"),
        }
        assert!(!super::super::pending::is_pending(root, &path));
        assert_eq!(runs.log.lock().last().unwrap(), &format!("cards {path}"));
    }

    #[test]
    fn routes() {
        let g = Method::GET;
        let p = Method::POST;
        assert_eq!(route_of(&g, "/api/version-history"), Some(Route::VersionHistory));
        assert_eq!(route_of(&p, "/api/version-history"), Some(Route::VersionHistory));
        assert_eq!(route_of(&g, "/api/profiles/b/files"), Some(Route::BoardFiles { slug: "b".into() }));
        assert_eq!(route_of(&p, "/api/profiles/b/files"), None);
        assert_eq!(route_of(&p, "/api/profiles/b/open-file"), Some(Route::OpenFile { slug: "b".into() }));
        assert_eq!(route_of(&g, "/api/profiles/b/tickets/t1/outputs"), Some(Route::Outputs { slug: "b".into(), id: "t1".into() }));
        assert_eq!(
            route_of(&g, "/api/profiles/b/tickets/t1/outputs/sub/r%C3%A9.md"),
            Some(Route::Output { slug: "b".into(), id: "t1".into(), name: "sub/ré.md".into() })
        );
        assert_eq!(route_of(&p, "/api/profiles/b/tickets/t1/outputs"), None);
        assert_eq!(route_of(&p, "/api/profiles/b/tickets/t1/find-files"), Some(Route::FindFiles { slug: "b".into(), id: "t1".into() }));
        assert_eq!(route_of(&g, "/api/profiles/b/tickets/t1/diff"), Some(Route::Diff { slug: "b".into(), id: "t1".into() }));
        assert_eq!(route_of(&g, "/api/profiles/b/tickets/t1/conversation"), None);
        assert_eq!(route_of(&g, "/api/profiles/%2E%2E/files"), None);
        assert_eq!(route_of(&g, "/api/profiles/a%2Fb/files"), None);
        assert_eq!(route_of(&g, "/api/profiles/b/tickets/t1/file%"), None);
        assert_eq!(route_of(&Method::HEAD, "/api/profiles/b/files"), None);
        assert_eq!(route_of(&g, "//api/profiles/b/files"), None);
    }

    #[test]
    fn query_and_gate() {
        assert_eq!(query_param(Some("path=a+b%2Fc&x=1"), "path").as_deref(), Some("a b/c"));
        assert_eq!(query_param(Some("w=1"), "path"), None);
        let mut h = HeaderMap::new();
        h.insert(HOST, HeaderValue::from_static("127.0.0.1:7777"));
        assert!(plain_local(&h, &Method::GET, 7777));
        assert!(!plain_local(&h, &Method::GET, 7778));
        assert!(!plain_local(&h, &Method::POST, 7777), "a POST needs the JSON type");
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
        assert!(plain_local(&h, &Method::POST, 7777));
        h.insert(ORIGIN, HeaderValue::from_static("http://evil.example"));
        assert!(!plain_local(&h, &Method::POST, 7777));
        h.insert(ORIGIN, HeaderValue::from_static("http://localhost:7777"));
        assert!(plain_local(&h, &Method::POST, 7777));
        h.append(RUN_HEADER, HeaderValue::from_static(""));
        h.append(RUN_HEADER, HeaderValue::from_static("b/t1"));
        assert!(!plain_local(&h, &Method::POST, 7777), "two run headers: Bun joins them");
        h.remove(RUN_HEADER);
        h.insert(FRONT_DESK_HEADER, HeaderValue::from_static("x"));
        assert!(!plain_local(&h, &Method::POST, 7777));
    }
}
