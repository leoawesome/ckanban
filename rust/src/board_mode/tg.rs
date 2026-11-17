//! P1c in the server: Telegram and the front desk run in the Rust board (`ckanban_board::telegram`).
//! - `connect_telegram`: made once the server has its routes and Bun (replays of held requests go through them).
//! - `desk_request`: every request with `x-ckanban-frontdesk` goes through the front desk's gate first (as Bun's
//!   `api()` does before any route); one that may go ahead is sent again to this server without the header, so every
//!   route (Rust's or Bun's) answers it as the request it is. `POST /api/telegram/front-desk/file` (send_file) is here.
//! - `notify_route`: Telegram pairing (`/api/notify/telegram/pair`, `/unpair`), and the satellite's
//!   `/api/notify` answers with Telegram's live state put in (the satellite keeps the rest of the notification
//!   settings until P1b).

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use ckanban_board::gate::request::{self, Listener};
use ckanban_board::sessions::routes::{HUDDLE_HEADER, RUN_HEADER};
use ckanban_board::telegram::{self, Telegram};
use futures_util::future::BoxFuture;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{CONTENT_TYPE, HOST};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Value, json};

use super::{BoardMode, FRONT_DESK_HEADER, MAX_BODY};
use crate::proxy::{Body, Proxy, full};
use crate::routes::Native;

/// `MAC_ONLY_LINE` of `src/helper/notify.ts`.
const MAC_ONLY_LINE: &str = "I can only reach you on this Mac";

/// What Telegram needs from the board (`ckanban_board::telegram::Env`).
struct TgEnv {
    board: std::sync::Weak<BoardMode>,
    native: Arc<Native>,
    proxy: Arc<Proxy>,
}

fn read_record(path: std::path::PathBuf) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|t| ckanban_board::runs::js::parse(&t)).filter(Value::is_object)
}

fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

impl telegram::Env for TgEnv {
    fn profile_path(&self, slug: &str) -> Option<String> {
        let b = self.board.upgrade()?;
        ckanban_core::DataDir::new(b.root.clone()).profile(slug).and_then(|p| p.record.0.get("path").and_then(Value::as_str).map(str::to_string))
    }
    fn schedule(&self, slug: &str, id: &str) -> Option<Value> {
        let b = self.board.upgrade()?;
        plain_id(id).then(|| read_record(b.root.join("profiles").join(slug).join("schedules").join(format!("{id}.json")))).flatten()
    }
    fn job(&self, slug: &str, id: &str) -> Option<Value> {
        let b = self.board.upgrade()?;
        plain_id(id).then(|| read_record(b.root.join("profiles").join(slug).join("jobs").join(format!("{id}.json")))).flatten()
    }
    fn chat_from_telegram(&self, slug: &str, id: &str, text: &str, from: Value) -> BoxFuture<'static, Result<bool, String>> {
        let b = self.board.upgrade();
        let (slug, id, text) = (slug.to_string(), id.to_string(), text.to_string());
        Box::pin(async move {
            let Some(b) = b else { return Err("the board is stopping".to_string()) };
            let runs = b.runs.clone();
            tokio::task::spawn_blocking(move || runs.chat_from_telegram(&slug, &id, &text, &from)).await.map_err(|e| e.to_string())?
        })
    }
    fn patch_telegram(&self, slug: &str, id: &str, patch: Value) {
        if let Some(b) = self.board.upgrade()
            && let Err(e) = b.actions.patch_telegram(slug, id, patch)
        {
            eprintln!("telegram: can't mark {slug}/{id}: {e}");
        }
    }
    fn drop_telegram_queued(&self) -> usize {
        self.board.upgrade().and_then(|b| b.actions.drop_telegram_queued().ok()).unwrap_or(0)
    }
    fn chats(&self) -> Option<Arc<ckanban_board::quickchat::QuickChats>> {
        self.board.upgrade().map(|b| b.chats.clone())
    }
    fn replay(&self, method: String, path: String, body: Value) -> BoxFuture<'static, (u16, Value)> {
        let (b, native, proxy) = (self.board.upgrade(), self.native.clone(), self.proxy.clone());
        Box::pin(async move {
            let Some(b) = b else { return (503, json!({ "error": "the board is stopping" })) };
            let res = b.replay(&json!({ "method": method, "path": path, "body": body }), &native, &proxy).await;
            let bytes = res.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();
            let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            (v.get("status").and_then(Value::as_u64).unwrap_or(500) as u16, v.get("body").cloned().unwrap_or(Value::Null))
        })
    }
}

impl BoardMode {
    /// Starts Telegram and the front desk (P1c): the bot, its hooks in the quick chats, the helper's settings writes.
    pub fn connect_telegram(self: &Arc<Self>, native: Arc<Native>, proxy: Arc<Proxy>) {
        let env = Arc::new(TgEnv { board: Arc::downgrade(self), native, proxy });
        let tg = Telegram::new(&self.root, self.helper.clone(), env);
        if self.telegram.set(tg.clone()).is_err() {
            return;
        }
        let _ = self.outside_sat.telegram.set(tg.clone());
        telegram::desk::plug(&tg);
        let t = tg.clone();
        let _ = self.helper.on_notify.set(Arc::new(move |before: &Value, after: &Value| t.settings_changed(before, after)));
        let stop = tg.start(self.core.bus.clone());
        self.core.on_stop("telegram", stop);
        // Waits closed at start-up, before Telegram ran.
        let early = std::mem::take(&mut self.helper_tell.lock().unwrap_or_else(|e| e.into_inner()).early_closed);
        if !early.is_empty() {
            let t = tg.clone();
            tokio::spawn(async move { t.waits_closed(early).await });
        }
    }

    pub(super) fn tg(&self) -> Option<Arc<Telegram>> {
        self.telegram.get().cloned()
    }

    /// A request with the front desk's header (after the request gate): refused, held for a Confirm tap, or sent on
    /// as the request it is, without the header.
    pub(super) async fn desk_request(self: &Arc<Self>, desk: String, req: Request<Incoming>, via: Listener) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let h = &parts.headers;
        if request::has(h, RUN_HEADER) || request::has(h, HUDDLE_HEADER) {
            return self.error(StatusCode::FORBIDDEN, "a board run can't also be the front desk");
        }
        // The front desk's runs are on this Mac: its header never comes in through phone access.
        if via == Listener::Remote {
            return self.error(StatusCode::FORBIDDEN, "This front desk identity isn't valid (the board restarted or the chat changed). Ask the user to send the message again.");
        }
        let bytes = match Limited::new(body, MAX_BODY).collect().await {
            Ok(b) => b.to_bytes(),
            Err(e) if e.is::<http_body_util::LengthLimitError>() => return self.error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
            Err(_) => return crate::proxy::plain(StatusCode::BAD_REQUEST, "bad request"),
        };
        let Some(tg) = self.tg() else { return self.error(StatusCode::SERVICE_UNAVAILABLE, "the front desk is still starting; ask again in a moment") };
        let path = parts.uri.path().to_string();
        let parse = |b: &Bytes| {
            let raw = String::from_utf8_lossy(b);
            if raw.is_empty() { Value::Null } else { ckanban_board::runs::js::parse(&raw).unwrap_or(Value::Null) }
        };
        if path == "/api/telegram/front-desk/file" && parts.method == Method::POST {
            let b = parse(&bytes);
            let p = b.get("path").map(ckanban_board::runs::js::to_string).filter(|_| b.get("path").is_some_and(|x| !x.is_null())).unwrap_or_default();
            let caption = b.get("caption").and_then(Value::as_str).unwrap_or("").to_string();
            let (status, v) = tg.desk_send_file(&desk, &p, &caption).await;
            return self.json_at(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), &v);
        }
        let b = if parts.method == Method::GET || parts.method == Method::HEAD { Value::Null } else { parse(&bytes) };
        if let Some((status, v)) = tg.desk_gate(&desk, parts.method.as_str(), &path, &b).await {
            return self.json_at(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), &v);
        }
        // Goes ahead: to this server again, as the same request without the header.
        let mut again = Request::from_parts(parts, full(bytes));
        again.headers_mut().remove(FRONT_DESK_HEADER);
        self.send_again(again).await
    }

    /// A request sent to this server again (on this Mac's listener, Host this Mac's), so every route answers it in
    /// `route()`'s order. Its caller is this server itself, which is never the user (`guard::user_only`).
    pub(super) async fn send_again(&self, req: Request<Body>) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let bytes = match Limited::new(body, MAX_BODY).collect().await {
            Ok(b) => b.to_bytes(),
            Err(_) => return crate::proxy::plain(StatusCode::BAD_REQUEST, "bad request"),
        };
        let target = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
        let mut rb = Request::builder().method(parts.method.clone()).uri(format!("http://127.0.0.1:{}{target}", self.public_port));
        for (k, v) in parts.headers.iter() {
            if k.as_str().eq_ignore_ascii_case(FRONT_DESK_HEADER) || k == HOST || matches!(k.as_str(), "connection" | "content-length" | "transfer-encoding") {
                continue;
            }
            rb = rb.header(k, v);
        }
        rb = rb.header(HOST, format!("127.0.0.1:{}", self.public_port));
        let Ok(again) = rb.body(Full::new(bytes)) else { return crate::proxy::plain(StatusCode::BAD_REQUEST, "bad request") };
        let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new()).build_http::<Full<Bytes>>();
        match client.request(again).await {
            Ok(res) => res.map(|b| b.boxed()),
            Err(e) => self.error(StatusCode::BAD_GATEWAY, &format!("the board didn't answer: {e}")),
        }
    }

    /// The satellite's `GET /api/notify` with Telegram's live state (`notifyView`); `local` as the caller is.
    async fn notify_view(&self, proxy: &Proxy, local: bool) -> Value {
        let rb = Request::builder().method(Method::GET).uri("/api/notify").header(HOST, format!("127.0.0.1:{}", self.public_port));
        let Ok(req) = rb.body(full(Bytes::new())) else { return Value::Null };
        // Asked as this Mac (a phone request's own Host is the tailnet's); `local` is set as the caller is.
        let peer = SocketAddr::from(([127, 0, 0, 1], 0));
        let res = proxy.forward(req, peer).await;
        let bytes = res.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();
        let mut v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut()
            && o.contains_key("local")
        {
            o.insert("local".into(), local.into());
        }
        self.patch_view(&mut v);
        v
    }

    /// Puts Telegram's live state into a notification settings view (the satellite has no bot).
    fn patch_view(&self, v: &mut Value) {
        let Some(tg) = self.tg() else { return };
        let st = tg.state();
        let t = tg.tg_settings();
        let Some(pt) = v.get_mut("telegram").and_then(Value::as_object_mut) else { return };
        for (k, from) in [("status", "state"), ("error", "error"), ("botName", "botName"), ("pairing", "pairing"), ("pairError", "pairError")] {
            pt.insert(k.into(), st.get(from).cloned().unwrap_or(Value::Null));
        }
        let token_set = !telegram::s(&t, "token").is_empty();
        let paired = telegram::chat_of(&t).is_some();
        let state = telegram::s(&st, "state").to_string();
        let name = t.get("chatName").and_then(Value::as_str).unwrap_or("your chat").to_string();
        let detail = if !token_set {
            "Not set up: make a bot with BotFather and paste its token.".to_string()
        } else if !paired {
            "Not paired yet: send the pairing code to your bot.".to_string()
        } else if let Some(e) = st.get("error").and_then(Value::as_str) {
            e.to_string()
        } else if telegram::b(&t, "takeMessages") {
            format!("Paired with {name}.")
        } else {
            let how = if ckanban_board::runs::js::truthy(t.get("lockedAt")) { "Locked from Telegram" } else { "Paused" };
            format!("Paired with {name}. {how}: not taking messages; alerts still arrive.")
        };
        let ready = token_set && paired && state != "error";
        if let Some(list) = v.get_mut("channels").and_then(Value::as_array_mut) {
            for c in list.iter_mut() {
                if c.get("name").and_then(Value::as_str) == Some("telegram") {
                    c["ready"] = ready.into();
                    c["detail"] = detail.clone().into();
                }
            }
            let phone_ready = list.iter().any(|c| c.get("name").and_then(Value::as_str) != Some("mac") && c.get("on") == Some(&Value::Bool(true)) && c.get("ready") == Some(&Value::Bool(true)));
            if let Some(o) = v.as_object_mut() {
                if o.contains_key("phoneReady") {
                    o.insert("phoneReady".into(), phone_ready.into());
                }
                if o.contains_key("reachLine") {
                    o.insert("reachLine".into(), if phone_ready { Value::Null } else { MAC_ONLY_LINE.into() });
                }
            }
        }
    }

    /// `/api/notify...` (Bun's order: after the other routes, before Bun), when `notify_claims` says so.
    pub(super) async fn notify_route(&self, req: Request<Body>, peer: SocketAddr, via: Listener, sent: Option<super::Sent>, proxy: &Proxy) -> Response<Body> {
        match self.notify_inner(req, peer, via, sent, proxy).await {
            Ok(r) | Err(r) => r,
        }
    }

    async fn notify_inner(&self, req: Request<Body>, peer: SocketAddr, via: Listener, sent: Option<super::Sent>, proxy: &Proxy) -> Result<Response<Body>, Response<Body>> {
        let path = req.uri().path().to_string();
        let m = req.method().clone();
        let pair = path == "/api/notify/telegram/pair" && m == Method::POST;
        let unpair = path == "/api/notify/telegram/unpair" && m == Method::POST;
        let view = !pair && !unpair;
        let h = req.headers().clone();
        let local = via == Listener::Local;
        if view {
            // The satellite answers; Telegram's live state goes in.
            let res = super::to_bun(req, peer, sent, proxy).await;
            let status = res.status();
            let bytes = res.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();
            let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) else {
                let mut r = Response::new(full(bytes));
                *r.status_mut() = status;
                r.headers_mut().insert(CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
                return Ok(r);
            };
            if status.is_success() {
                if path == "/api/notify/test" {
                    if let Some(st) = v.get_mut("state") {
                        self.patch_view(st);
                    }
                } else {
                    self.patch_view(&mut v);
                }
            }
            return Ok(self.json_at(status, &v));
        }
        if request::has(&h, RUN_HEADER) {
            return Ok(self.error(StatusCode::FORBIDDEN, "board runs can't use notification settings"));
        }
        let ctype = request::header_text(&h, CONTENT_TYPE.as_str());
        if !request::json_type(ctype.as_deref()) {
            return Ok(self.error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json"));
        }
        let bytes = match Limited::new(req.into_body(), MAX_BODY).collect().await {
            Ok(b) => b.to_bytes(),
            Err(_) => return Ok(self.error(StatusCode::BAD_REQUEST, "bad request")),
        };
        let what = if pair { "Pairing Telegram" } else { "Unpairing Telegram" };
        let allowed = if local { crate::guard::user_only(&h, peer.port()).await } else { crate::guard::headers_allow(&h) };
        if !allowed {
            return Ok(self.error(StatusCode::FORBIDDEN, &crate::guard::refusal(what)));
        }
        let tg = self.tg().expect("checked above");
        if unpair {
            if let Err(e) = tg.unpair() {
                return Ok(self.error(StatusCode::SERVICE_UNAVAILABLE, &e));
            }
            let v = self.notify_view(proxy, local).await;
            return Ok(self.json_at(StatusCode::OK, &v));
        }
        if !local {
            return Ok(self.error(StatusCode::FORBIDDEN, "Pair Telegram from the Mac."));
        }
        let b: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let board = b.get("board").and_then(Value::as_str).map(str::to_string);
        match tg.pair(board.as_deref()) {
            Ok((code, expires)) => {
                let state = self.notify_view(proxy, true).await;
                Ok(self.json_at(StatusCode::OK, &json!({ "code": code, "expiresAt": expires, "state": state })))
            }
            Err((status, e)) => Ok(self.error(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST), &e)),
        }
    }
}

/// The routes `notify_route` answers.
pub(super) fn notify_claims(m: &Method, path: &str) -> bool {
    pair_claims(m, path) || view_claims(m, path)
}

/// Pairing is Rust's alone: before Telegram runs it answers 503 rather than reach the satellite.
pub(super) fn pair_claims(m: &Method, path: &str) -> bool {
    m == Method::POST && matches!(path, "/api/notify/telegram/pair" | "/api/notify/telegram/unpair")
}

fn view_claims(m: &Method, path: &str) -> bool {
    (path == "/api/notify" && (m == Method::GET || m == Method::POST)) || (m == Method::POST && path == "/api/notify/test")
}
