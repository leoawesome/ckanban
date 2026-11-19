//! The browser routes in board mode, as Bun answers them (`src/api/browsers.ts`, the ticket's `devices` action in
//! `src/api/ticket-info.ts`, the board's `shell` WebSocket in `src/api/profiles.ts` and `src/api/server.ts`):
//!
//! - `/api/board-browsers[...]`, `/api/browsers[...]`, `/api/devices[...]`: every method and sub-path (Bun's quirks
//!   included: a run is refused even on a board browsers path that doesn't exist; anything unmatched is 404).
//! - `POST /api/profiles/:p/tickets/:id/devices`: take_devices / release_devices from the ticket's own run.
//! - `GET /api/profiles/:p/shell[?ticket=<id>]`: the Terminal panel's WebSocket.
//!
//! Before each, the checks Bun's server makes first (`requestRefusal`: the Host, the Origin of a change; then a JSON
//! content type for POST, PATCH and PUT). Requests from the Telegram front desk are left to Bun's gate.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, CONTENT_TYPE, HeaderMap, HeaderValue, UPGRADE};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use regex::Regex;
use serde_json::{Value, json};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::Role;

use super::Browsers;
use super::devices::{TAKE_WAIT_MS, TakeResult};
use super::js;
use super::shell::{Shell, ShellEvent};

pub type Body = BoxBody<Bytes, hyper::Error>;

const RUN_HEADER: &str = "x-ckanban-run";
const HUDDLE_HEADER: &str = "x-ckanban-huddle-agent";
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
const LOCAL_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];
/// Larger request bodies are refused (Bun's own limit is far above anything these routes take).
const MAX_BODY: usize = 1024 * 1024;

static TICKET_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").unwrap());

/// What the server gives the routes: its port, how answers are masked, and who the user is.
#[derive(Clone)]
pub struct RouteCtx {
    pub public_port: u16,
    /// `maskSavedJson` over a JSON answer's text.
    pub mask: Arc<dyn Fn(&str) -> String + Send + Sync>,
    /// `userOnly`'s check of the caller (the headers and the user's own browser behind `peer_port`).
    pub user_only: Arc<dyn Fn(HeaderMap, u16) -> BoxFuture<'static, bool> + Send + Sync>,
}

/// The path after `/api/`, split and decoded like Bun's `parts`; None when it isn't an `/api/` path or doesn't decode.
fn parts(path: &str) -> Option<Vec<String>> {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.first() != Some(&"api") {
        return None;
    }
    segs[1..].iter().map(|s| percent_encoding::percent_decode_str(s).decode_utf8().ok().map(|c| c.into_owned())).collect()
}

/// Whether Rust answers this request in board mode.
pub fn owns(method: &Method, path: &str, headers: &HeaderMap) -> bool {
    if headers.contains_key(FRONT_DESK_HEADER) || !path.starts_with("/api/") {
        return false;
    }
    let Some(p) = parts(path) else { return false };
    match p.first().map(String::as_str) {
        Some("board-browsers" | "browsers" | "devices") => true,
        Some("profiles") => {
            (p.len() == 3 && p[2] == "shell" && method == Method::GET)
                || (p.len() == 5 && p[2] == "tickets" && p[4] == "devices" && method == Method::POST)
        }
        _ => false,
    }
}

/// A header as Bun reads it: every line joined with ", ".
fn header(h: &HeaderMap, name: &str) -> Option<String> {
    let all: Vec<String> = h.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
    if all.is_empty() { None } else { Some(all.join(", ")) }
}

/// `req.headers.get(name)` is a non-empty string.
fn has(h: &HeaderMap, name: &str) -> bool {
    header(h, name).is_some_and(|v| !v.is_empty())
}

fn local_origin(o: &str, port: u16) -> bool {
    LOCAL_HOSTS.iter().any(|h| o == format!("http://{h}:{port}"))
}

/// `requestRefusal` on the local listener: "forbidden" or None.
fn refused(h: &HeaderMap, method: &Method, port: u16) -> bool {
    let host = header(h, "host").unwrap_or_default();
    if !LOCAL_HOSTS.iter().any(|x| host == format!("{x}:{port}")) {
        return true;
    }
    let mutation = method != Method::GET && method != Method::HEAD;
    mutation && header(h, "origin").is_some_and(|o| !o.is_empty() && !local_origin(&o, port))
}

fn plain(status: StatusCode, text: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(text.to_string())).map_err(|n| match n {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

struct Http {
    status: u16,
    message: String,
}

fn http(status: u16, message: impl Into<String>) -> Http {
    Http { status, message: message.into() }
}

type Answer = Result<Response<Body>, Http>;

impl RouteCtx {
    fn json(&self, status: u16, v: &Value) -> Response<Body> {
        let text = (self.mask)(&serde_json::to_string(v).unwrap_or_else(|_| "null".into()));
        let mut r = Response::new(Full::new(Bytes::from(text)).map_err(|n| match n {}).boxed());
        *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        r
    }

    fn ok(&self, v: Value) -> Answer {
        Ok(self.json(200, &v))
    }

    /// `userOnly(req, what)`.
    async fn user_only(&self, h: &HeaderMap, peer_port: u16, what: &str) -> Result<(), Http> {
        if (self.user_only)(h.clone(), peer_port).await {
            return Ok(());
        }
        Err(http(
            403,
            format!("{what} is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board."),
        ))
    }
}

/// `body(req)`: the JSON body; 400 when it isn't JSON (an empty body included).
async fn body(req: Request<Incoming>) -> Result<Value, Http> {
    let bytes = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return Err(http(413, "request body too large")),
    };
    serde_json::from_slice(&bytes).map_err(|_| http(400, "invalid JSON body"))
}

/// `(await body(req)) ?? {}`.
async fn body_or_empty(req: Request<Incoming>) -> Result<Value, Http> {
    Ok(match body(req).await? {
        Value::Null => json!({}),
        v => v,
    })
}

/// `b[key]` of a body (undefined: None); a body that isn't an object has no keys.
fn field<'a>(b: &'a Value, key: &str) -> Option<&'a Value> {
    b.as_object().and_then(|m| m.get(key))
}

fn merge(mut v: Value, extra: Value) -> Value {
    if let (Some(m), Value::Object(e)) = (v.as_object_mut(), extra) {
        m.extend(e);
    }
    v
}

impl Browsers {
    /// Answers a request `owns` said is Rust's.
    pub async fn answer(self: &Arc<Self>, req: Request<Incoming>, peer_port: u16, ctx: &RouteCtx) -> Response<Body> {
        let h = req.headers();
        if refused(h, req.method(), ctx.public_port) {
            return plain(StatusCode::FORBIDDEN, "forbidden");
        }
        let m = req.method().clone();
        if matches!(m, Method::POST | Method::PATCH | Method::PUT) {
            let ty = header(h, "content-type").unwrap_or_default();
            if crate::prompts::js::trim(ty.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
                return ctx.json(415, &json!({ "error": "content-type must be application/json" }));
            }
        }
        let Some(p) = parts(req.uri().path()) else { return ctx.json(400, &json!({ "error": "malformed URL" })) };
        let r = match p[0].as_str() {
            "board-browsers" => self.board_browser_routes(req, &p, &m, peer_port, ctx).await,
            "browsers" => self.chrome_routes(req, &p, &m, ctx).await,
            "devices" => self.device_routes(req, &p, &m, ctx).await,
            _ if p.len() == 3 => self.shell_route(req, &p, ctx).await,
            _ => self.ticket_devices(req, &p, ctx).await,
        };
        r.unwrap_or_else(|e| ctx.json(e.status, &json!({ "error": e.message })))
    }

    async fn board_browser_routes(self: &Arc<Self>, req: Request<Incoming>, p: &[String], m: &Method, peer: u16, ctx: &RouteCtx) -> Answer {
        let bb = self.board_browsers.clone();
        let be = |e: super::board_browsers::BrowserError| http(e.status, e.message);
        if p.len() == 1 && m == Method::GET {
            return ctx.ok(self.browsers_view());
        }
        let id = p.get(1).cloned().unwrap_or_default();
        // A run's browser tools ask for this after its Chrome stopped mid-run: only a browser some run uses now.
        if p.len() == 3 && p[2] == "ensure" && m == Method::POST {
            if bb.get(&id).is_none() {
                return Err(http(404, "There is no board browser with that name."));
            }
            if bb.in_use(&id) == 0 {
                return Err(http(409, "Only a task using this browser can start it again."));
            }
            let port = bb.ensure(&id).await.map_err(be)?;
            return ctx.ok(json!({ "ok": true, "port": port }));
        }
        // A run's browser tools, on their first call and then now and then while they work: hold the browser for that
        // run and start it if needed. Only the secret the board gave that run's tools works (no user, phone or other
        // program can hold a browser this way).
        if p.len() == 3 && p[2] == "claim" && m == Method::POST {
            let b = body_or_empty(req).await?;
            let token = field(&b, "token").and_then(Value::as_str).unwrap_or("").to_string();
            let port = bb.claim(&token, &id).await.map_err(be)?;
            return ctx.ok(json!({ "ok": true, "port": port }));
        }
        // Everything else is the user's, from the board in a browser (checked before the route is matched).
        ctx.user_only(req.headers(), peer, "Changing board browsers").await?;
        let view = || self.browsers_view();
        if p.len() == 1 && m == Method::POST {
            let b = body_or_empty(req).await?;
            let added = bb.add(field(&b, "name").unwrap_or(&Value::Null)).await.map_err(be)?;
            return ctx.ok(merge(view(), json!({ "added": added.id })));
        }
        if p.len() == 2 && m == Method::PATCH {
            let b = body_or_empty(req).await?;
            bb.update(&id, field(&b, "name"), field(&b, "keepRunning"), field(&b, "startUrl")).map_err(be)?;
            return ctx.ok(view());
        }
        if p.len() == 2 && m == Method::DELETE {
            bb.remove(&id).await.map_err(be)?;
            return ctx.ok(view());
        }
        if p.len() == 3 && (p[2] == "open" || p[2] == "sign-in") && m == Method::POST {
            let b = body_or_empty(req).await?;
            let (opened, message) = bb.open_window(&id, field(&b, "url").unwrap_or(&Value::Null)).await.map_err(be)?;
            return ctx.ok(merge(view(), json!({ "opened": opened, "message": message })));
        }
        if p.len() == 3 && p[2] == "screen" && m == Method::POST {
            let (jpeg, site) = bb.screen(&id).await.map_err(be)?;
            let mut r = Response::new(Full::new(Bytes::from(jpeg)).map_err(|n| match n {}).boxed());
            let hs = r.headers_mut();
            hs.insert(CONTENT_TYPE, HeaderValue::from_static("image/jpeg"));
            hs.insert("cache-control", HeaderValue::from_static("no-store"));
            hs.insert("x-page-site", HeaderValue::from_str(&site.unwrap_or_default()).unwrap_or(HeaderValue::from_static("")));
            return Ok(r);
        }
        if p.len() == 3 && p[2] == "input" && m == Method::POST {
            let b = body(req).await?;
            let ev = if b.is_null() { json!({}) } else { b };
            bb.input(&id, &ev).await.map_err(be)?;
            return ctx.ok(json!({ "ok": true }));
        }
        if p.len() == 3 && p[2] == "close" && m == Method::POST {
            if bb.in_use(&id) > 0 {
                return Err(http(409, "A task is using this browser now. It closes by itself once the task is done."));
            }
            let closed = bb.close(&id, "asked by the user").await.map_err(be)?;
            let message = if closed { "Closed. Its logins are saved." } else { "Chrome is still closing. Try again in a minute." };
            return ctx.ok(merge(view(), json!({ "closed": closed, "message": message })));
        }
        Err(http(404, "not found"))
    }

    async fn chrome_routes(&self, req: Request<Incoming>, p: &[String], m: &Method, ctx: &RouteCtx) -> Answer {
        let ce = |e: super::chromes::ChromeError| http(e.status, e.message);
        if p.len() == 1 && m == Method::GET {
            return ctx.ok(self.browsers_view());
        }
        if has(req.headers(), RUN_HEADER) || has(req.headers(), HUDDLE_HEADER) {
            return Err(http(403, "only the user names or removes Chromes (More, Browsers)"));
        }
        let device_id = p.get(1).cloned().unwrap_or_default();
        if p.len() == 2 && m == Method::PATCH {
            let b = body_or_empty(req).await?;
            let Some(Value::String(name)) = field(&b, "name") else { return Err(http(400, "name must be text")) };
            self.chromes.rename(&device_id, name).map_err(ce)?;
            return ctx.ok(self.browsers_view());
        }
        if p.len() == 2 && m == Method::DELETE {
            self.chromes.remove(&device_id).map_err(ce)?;
            return ctx.ok(self.browsers_view());
        }
        Err(http(404, "not found"))
    }

    async fn device_routes(&self, req: Request<Incoming>, p: &[String], m: &Method, ctx: &RouteCtx) -> Answer {
        let de = |e: super::devices::DeviceError| http(e.status, e.message);
        if p.len() == 1 && m == Method::GET {
            return ctx.ok(self.device_views());
        }
        if has(req.headers(), RUN_HEADER) || has(req.headers(), HUDDLE_HEADER) {
            return Err(http(
                403,
                "only the user changes or frees devices (More, Devices); a run takes and lets go of its own with take_devices and release_devices",
            ));
        }
        let text = |v: Option<&Value>| match v {
            None | Some(Value::Null) => String::new(),
            Some(v) => js::string(v),
        };
        if p.len() == 1 && m == Method::POST {
            let b = body_or_empty(req).await?;
            let description = field(&b, "description").map(js::string);
            // Bun's Number(capacity), then clampCapacity's Number() again: the same as clamping the raw value.
            self.devices.upsert(&text(field(&b, "name")), description.as_deref(), field(&b, "capacity")).map_err(de)?;
            return ctx.ok(self.device_views());
        }
        let name = p.get(1).cloned().unwrap_or_default();
        if p.len() == 2 && m == Method::DELETE {
            self.devices.remove(&name).map_err(de)?;
            return ctx.ok(self.device_views());
        }
        if p.len() == 3 && p[2] == "free" && m == Method::POST {
            let b = body_or_empty(req).await?;
            self.devices.free(&name, &text(field(&b, "profile")), &text(field(&b, "id"))).map_err(de)?;
            return ctx.ok(self.device_views());
        }
        Err(http(404, "not found"))
    }

    /// `profileOr404`.
    fn board_of(&self, slug: &str) -> Result<Value, Http> {
        self.lookup.profile(slug).ok_or_else(|| http(404, format!("board {slug} not found")))
    }

    /// `POST /api/profiles/:p/tickets/:id/devices`: take_devices / release_devices.
    async fn ticket_devices(&self, req: Request<Incoming>, p: &[String], ctx: &RouteCtx) -> Answer {
        let (slug, id) = (&p[1], &p[3]);
        self.board_of(slug)?;
        if self.lookup.ticket(slug, id).is_none() {
            return Err(http(404, format!("ticket {id} not found")));
        }
        let caller = header(req.headers(), RUN_HEADER);
        if caller.as_deref() != Some(&format!("{slug}/{id}")) || has(req.headers(), HUDDLE_HEADER) {
            return Err(http(403, "only the ticket's own run takes or lets go of devices for it"));
        }
        let b = body_or_empty(req).await?;
        let de = |e: super::devices::DeviceError| http(e.status, e.message);
        match field(&b, "action").and_then(Value::as_str) {
            Some("take") => {
                let wait = match field(&b, "waitMs") {
                    Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()).map_or(TAKE_WAIT_MS, |x| x.clamp(0.0, TAKE_WAIT_MS)),
                    _ => TAKE_WAIT_MS,
                };
                let names = field(&b, "names").cloned().unwrap_or(Value::Null);
                let r = self.devices.take(slug, id, &names, wait).await.map_err(de)?;
                ctx.ok(match r {
                    TakeResult::Got { names } => json!({ "ok": true, "names": names }),
                    TakeResult::Waiting { names, place, used_by } => {
                        let used: Vec<Value> = used_by
                            .iter()
                            .map(|u| {
                                let mut m = u.to_json();
                                m.insert("title".into(), self.lookup.ticket(&u.slug, &u.id).and_then(|t| t.get("title").cloned()).unwrap_or(Value::Null));
                                Value::Object(m)
                            })
                            .collect();
                        json!({ "ok": false, "names": names, "place": place, "usedBy": used })
                    }
                })
            }
            Some("release") => {
                let released = self.devices.release(slug, id, field(&b, "names")).map_err(de)?;
                ctx.ok(json!({ "released": released }))
            }
            _ => Err(http(400, "action must be take or release")),
        }
    }

    /// `GET /api/profiles/:p/shell[?ticket=<id>]`: the WebSocket to the shell of the board folder, or of that ticket's
    /// copy of it.
    async fn shell_route(self: &Arc<Self>, mut req: Request<Incoming>, p: &[String], ctx: &RouteCtx) -> Answer {
        let slug = p[1].clone();
        let profile = self.board_of(&slug)?;
        let h = req.headers();
        let origin_ok = header(h, "origin").is_some_and(|o| !o.is_empty() && local_origin(&o, ctx.public_port));
        if !origin_ok {
            return Err(http(403, "forbidden"));
        }
        let q = req.uri().query().unwrap_or("").to_string();
        let param = |k: &str| query_param(&q, k);
        let dim = |k: &str, d: f64| {
            let n = param(k).map_or(0.0, |v| js::number(&json!(v)));
            let n = if n.is_nan() || n == 0.0 { d } else { n };
            n.clamp(1.0, 1000.0).floor() as u16
        };
        let (cols, rows) = (dim("cols", 80.0), dim("rows", 24.0));
        let board_path = PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
        let (cwd, folder) = match param("ticket").filter(|t| !t.is_empty()) {
            None => (board_path, None),
            Some(t) => {
                if !TICKET_RE.is_match(&t) {
                    return Err(http(400, "invalid ticket"));
                }
                let Some(ticket) = self.lookup.ticket(&slug, &t) else { return Err(http(404, "ticket not found")) };
                match ticket.get("worktree").and_then(Value::as_str).filter(|w| !w.is_empty() && std::path::Path::new(w).exists()) {
                    Some(w) => (PathBuf::from(w), Some(t)),
                    None => (board_path, None),
                }
            }
        };
        let key = header(req.headers(), "sec-websocket-key");
        let upgrade = header(req.headers(), "upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"))
            && header(req.headers(), "connection").is_some_and(|c| c.split(',').any(|t| t.trim().eq_ignore_ascii_case("upgrade")));
        let (true, Some(key)) = (upgrade, key) else { return Err(http(400, "expected a WebSocket upgrade")) };
        let on = hyper::upgrade::on(&mut req);
        let me = self.clone();
        tokio::spawn(async move {
            let Ok(up) = on.await else { return };
            let ws = WebSocketStream::from_raw_socket(TokioIo::new(up), Role::Server, None).await;
            me.serve_shell(ws, Tab { slug, folder, cwd, cols, rows }).await;
        });
        let mut r = Response::new(Full::new(Bytes::new()).map_err(|n| match n {}).boxed());
        *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let hs = r.headers_mut();
        hs.insert(UPGRADE, HeaderValue::from_static("websocket"));
        hs.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
        hs.insert("sec-websocket-accept", HeaderValue::from_str(&accept_key(key.as_bytes())).expect("base64 is a header value"));
        Ok(r)
    }

    /// One tab's terminal: joins the folder's shell, passes its output on, and takes input, resizes and restarts.
    async fn serve_shell<S>(self: Arc<Self>, mut ws: WebSocketStream<S>, mut tab: Tab)
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let mut joined = self.join_shell(&mut ws, &tab, false).await;
        loop {
            let event = async {
                match joined.as_mut().and_then(|j| j.rx.as_mut()) {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                e = event => {
                    let sent = match e {
                        Some(ShellEvent::Data(d)) => ws.send(Message::binary(d)).await,
                        Some(ShellEvent::Exit(code)) => ws.send(Message::text(json!({ "type": "exit", "code": code }).to_string())).await,
                        None => {
                            // The shell let go of this tab (it ended): only the tab's messages from now on.
                            if let Some(j) = joined.as_mut() { j.rx = None; }
                            Ok(())
                        }
                    };
                    if sent.is_err() { break; }
                }
                m = ws.next() => {
                    let text = match m {
                        None | Some(Err(_)) | Some(Ok(Message::Close(_))) => break,
                        Some(Ok(Message::Text(t))) => t.to_string(),
                        Some(Ok(Message::Binary(b))) => String::from_utf8_lossy(&b).into_owned(),
                        Some(Ok(_)) => continue,
                    };
                    let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                    let shell = joined.as_ref().map(|j| j.shell.clone());
                    match msg.get("type").and_then(Value::as_str) {
                        Some("input") => {
                            if let (Some(Value::String(d)), Some(s)) = (msg.get("data"), &shell) {
                                let (s, d) = (s.clone(), d.clone());
                                // A pty write can block when the shell doesn't read: never on the runtime's threads.
                                let _ = tokio::task::spawn_blocking(move || s.write(&d)).await;
                            }
                        }
                        Some("resize") => {
                            let dim = |k: &str, d: f64| {
                                let n = js::number(msg.get(k).unwrap_or(&Value::Null));
                                let n = if n.is_nan() || n == 0.0 { d } else { n };
                                n.clamp(1.0, 1000.0).floor() as u16
                            };
                            tab.cols = dim("cols", 80.0);
                            tab.rows = dim("rows", 24.0);
                            if let Some(s) = &shell { s.resize(tab.cols, tab.rows); }
                        }
                        Some("restart") => {
                            // Another tab may already have restarted it: then just join the new shell.
                            if ws.send(Message::text(json!({ "type": "reset" }).to_string())).await.is_err() { break; }
                            let current = self.shells.current(&tab.slug, tab.folder.as_deref());
                            let same = match (&current, &shell) { (Some(a), Some(b)) => Arc::ptr_eq(a, b), _ => false };
                            if let Some(j) = joined.take() { j.shell.unsubscribe(j.id); }
                            joined = self.join_shell(&mut ws, &tab, same).await;
                        }
                        _ => {}
                    }
                }
            }
        }
        if let Some(j) = joined {
            j.shell.unsubscribe(j.id);
        }
    }

    /// `attachShell`: the folder's shell (started if needed), its scrollback, and its end if it already ended.
    async fn join_shell<S>(&self, ws: &mut WebSocketStream<S>, tab: &Tab, restart: bool) -> Option<Joined>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let shells = self.shells.clone();
        let (slug, cwd, folder, cols, rows) = (tab.slug.clone(), tab.cwd.clone(), tab.folder.clone(), tab.cols, tab.rows);
        let got = tokio::task::spawn_blocking(move || shells.get(&slug, &cwd, cols, rows, restart, folder.as_deref())).await.unwrap_or_else(|e| Err(e.to_string()));
        let shell = match got {
            Ok(s) => s,
            Err(e) => {
                let _ = ws.send(Message::text(json!({ "type": "error", "message": e }).to_string())).await;
                return None;
            }
        };
        let (id, back, ended, rx) = shell.subscribe();
        if !back.is_empty() {
            let _ = ws.send(Message::binary(back)).await;
        }
        match ended {
            Some(code) => {
                let _ = ws.send(Message::text(json!({ "type": "exit", "code": code }).to_string())).await;
            }
            None => shell.resize(tab.cols, tab.rows),
        }
        Some(Joined { shell, id, rx: Some(rx) })
    }
}

struct Tab {
    slug: String,
    folder: Option<String>,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
}

struct Joined {
    shell: Arc<Shell>,
    id: u64,
    /// None once the shell ended and let go of this tab.
    rx: Option<tokio::sync::mpsc::UnboundedReceiver<ShellEvent>>,
}

/// `Sec-WebSocket-Accept` for a key (RFC 6455).
fn accept_key(key: &[u8]) -> String {
    use base64::Engine;
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(key);
    h.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

/// `URLSearchParams.get(name)`.
fn query_param(query: &str, name: &str) -> Option<String> {
    let dec = |s: &str| percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned();
    query.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (dec(k) == name).then(|| dec(v))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::{HOST, ORIGIN};

    #[test]
    fn which_requests_are_rust_s() {
        let none = HeaderMap::new();
        assert!(owns(&Method::GET, "/api/devices", &none));
        assert!(owns(&Method::POST, "/api/board-browsers/x/no-such-action", &none));
        assert!(owns(&Method::PATCH, "/api/browsers/dev%3Ahome.2", &none));
        assert!(owns(&Method::GET, "/api/profiles/b/shell", &none));
        assert!(!owns(&Method::POST, "/api/profiles/b/shell", &none));
        assert!(owns(&Method::POST, "/api/profiles/b/tickets/t_1/devices", &none));
        assert!(!owns(&Method::GET, "/api/profiles/b/tickets/t_1/devices", &none));
        assert!(!owns(&Method::GET, "/api/devicesx", &none));
        assert!(!owns(&Method::GET, "/api/profiles/b/tickets", &none));
        let mut desk = HeaderMap::new();
        desk.insert(FRONT_DESK_HEADER, HeaderValue::from_static("c1"));
        assert!(!owns(&Method::GET, "/api/devices", &desk));
        assert_eq!(parts("/api//browsers/dev%3Ahome.2").unwrap(), ["browsers", "dev:home.2"]);
        assert_eq!(accept_key(b"dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
        assert_eq!(query_param("cols=5000&rows=0&ticket=..%2Fx", "ticket").as_deref(), Some("../x"));
    }

    #[test]
    fn the_gate_like_bun() {
        let mut h = HeaderMap::new();
        h.insert(HOST, HeaderValue::from_static("127.0.0.1:7777"));
        assert!(!refused(&h, &Method::GET, 7777));
        h.insert(ORIGIN, HeaderValue::from_static("http://evil.example"));
        assert!(!refused(&h, &Method::GET, 7777));
        assert!(refused(&h, &Method::POST, 7777));
        h.insert(ORIGIN, HeaderValue::from_static("http://localhost:7777"));
        assert!(!refused(&h, &Method::POST, 7777));
        h.append(HOST, HeaderValue::from_static("127.0.0.1:7777"));
        assert!(refused(&h, &Method::GET, 7777));
    }
}
