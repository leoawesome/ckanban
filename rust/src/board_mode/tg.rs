//! P1c in the server: Telegram and the front desk run in the Rust board (`ckanban_board::telegram`).
//! - `connect_telegram`: made once the server has its routes and Bun (replays of held requests go through them).
//! - `desk_request`: every request with `x-ckanban-frontdesk` goes through the front desk's gate first (as Bun's
//!   `api()` does before any route); one that may go ahead is sent again to this server without the header, so every
//!   route (Rust's or Bun's) answers it as the request it is. `POST /api/telegram/front-desk/file` (send_file) is here.
//! Settings' Telegram part (state, pairing, unpairing, a saved change) reaches it through `helper::notify`'s
//! `TelegramSide` (`helper::wired::RustTelegram`).

use std::sync::Arc;

use bytes::Bytes;
use ckanban_board::gate::request::{self, Listener};
use ckanban_board::sessions::routes::{HUDDLE_HEADER, RUN_HEADER};
use ckanban_board::telegram::{self, Telegram};
use futures_util::future::BoxFuture;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::HOST;
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Value, json};

use super::{BoardMode, FRONT_DESK_HEADER, MAX_BODY};
use crate::proxy::{Body, Proxy, full};
use crate::routes::Native;

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
}
