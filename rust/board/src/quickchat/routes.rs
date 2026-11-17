//! The quick chat routes in board mode (`/api/profiles/:p/chats...`, Bun's `src/api/chats.ts`): the list and its
//! pages, a new chat, one chat, rename, delete, a message, stop, the conversation and one tool call. Same answers,
//! statuses and order of checks as Bun (an unknown chat is 404 before the user check).
//!
//! Rewind, Undo rewind, Fork and Make ticket, the Context panel (`context`) and "Say it simpler" (`simplified`,
//! `simplify`) are R7b's (`crate::chat::quick`, `ChatExtras`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::index::CHAT_PAGE;
use super::service::{ChatError, QuickChats};
use crate::runs::js as rjs;
use crate::sessions::service::Sessions;
use crate::sessions::subagents::{self, AGENT_STEP_TAIL};
use crate::sessions::workflows;

/// What the routes read from a request. The server checked the Host, the Origin of a change and the JSON type.
#[derive(Debug, Clone)]
pub struct ChatReq {
    pub method: String,
    /// The path as sent (still percent-encoded).
    pub path: String,
    pub query: Option<String>,
    /// The body as JSON; Err(()) when it isn't JSON (Bun: 400 `invalid JSON body`); Ok(None) when not read (GET, DELETE).
    pub body: Result<Option<Value>, ()>,
}

/// An answer: status and JSON body; None for 204.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Option<Value>,
}

/// `userOnly` for this request: true when the user's own browser (or phone) sent it. Called only when needed.
pub type UserCheck = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = bool> + Send>> + Send>;

const WHAT: &str = "Quick chats";

/// `userOnly`'s refusal text.
pub fn refusal(what: &str) -> String {
    format!(
        "{what} is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board."
    )
}

fn reply(status: u16, body: Value) -> Reply {
    Reply { status, body: Some(body) }
}

fn err(status: u16, msg: impl Into<String>) -> Reply {
    reply(status, json!({ "error": msg.into() }))
}

fn from(e: ChatError) -> Reply {
    err(e.status, e.message)
}

/// The route parts after `/api` (decoded), when this is a quick chat route: `profiles`, slug, `chats`, ...
pub fn parts_of(path: &str) -> Option<Vec<String>> {
    let raw: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if raw.len() < 4 || raw[0] != "api" || raw[1] != "profiles" || raw[3] != "chats" {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() - 1);
    for p in &raw[1..] {
        // A malformed escape: Bun throws (500); the satellite has no quick chats, so it isn't handed on (400 here).
        out.push(percent_encoding::percent_decode_str(p).decode_utf8().ok()?.into_owned());
    }
    Some(out)
}

/// Whether the server should hand this request to the quick chat routes (cheap, no file read).
pub fn wanted(path: &str) -> bool {
    parts_of(path).is_some()
}

/// The methods whose body Bun reads on these routes (POST and PATCH).
pub fn reads_body(method: &str) -> bool {
    method == "POST" || method == "PATCH"
}

/// `URLSearchParams.get`: the first value of `key`, `+` as a space, percent-decoded.
fn query_get(q: Option<&str>, key: &str) -> Option<String> {
    let dec = |s: &str| percent_encoding::percent_decode_str(&s.replace('+', " ")).decode_utf8_lossy().into_owned();
    q?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (dec(k) == key).then(|| dec(v))
    })
}

/// `String(body?.text ?? "")`.
fn text_of(body: &Option<Value>) -> String {
    match body.as_ref().and_then(|b| b.get("text")) {
        None | Some(Value::Null) => String::new(),
        Some(v) => rjs::to_string(v),
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

fn later_task(what: &str, task: &str) -> Reply {
    err(501, format!("{what} isn't in the Rust board yet ({task}); turn board mode off to use it."))
}

impl QuickChats {
    /// Say it simpler and the Context panel (R7b), once board mode has made them.
    fn chat_extras(&self) -> Option<Arc<crate::chat::extras::ChatExtras>> {
        self.extras.get().and_then(std::sync::Weak::upgrade)
    }

    /// The answer to a quick chat route (`parts` from `parts_of`).
    pub async fn answer(self: &Arc<Self>, sessions: &Arc<Sessions>, req: ChatReq, user: UserCheck) -> Reply {
        let Some(parts) = parts_of(&req.path) else { return err(400, "bad path") };
        let m = req.method.as_str();
        let slug = parts[1].clone();
        let me = self.clone();
        let s1 = slug.clone();
        if !blocking(move || me.profile(&s1).is_some()).await.unwrap_or(false) {
            return err(404, format!("board {slug} not found"));
        }
        let body = || -> Result<Option<Value>, Reply> { req.body.clone().map_err(|()| err(400, "invalid JSON body")) };
        let q = req.query.as_deref();
        if parts.len() == 3 && m == "GET" {
            let me = self.clone();
            // No limit: every chat, for a page opened before the list came in pages.
            let Some(limit) = query_get(q, "limit") else {
                return blocking(move || {
                    let all = me.list(&slug);
                    reply(200, Value::Array(all.iter().map(|c| me.view(&slug, c)).collect()))
                })
                .await
                .unwrap_or_else(|| err(500, "list failed"));
            };
            let n = rjs::number_of_str(&limit);
            let n = if n == 0.0 || n.is_nan() { CHAT_PAGE } else { n };
            let before = query_get(q, "before");
            return blocking(move || {
                let (chats, next) = me.page(&slug, n, before.as_deref());
                reply(200, json!({ "chats": chats.iter().map(|c| me.view(&slug, c)).collect::<Vec<_>>(), "next": next }))
            })
            .await
            .unwrap_or_else(|| err(500, "list failed"));
        }
        // A new chat starts with its first message.
        if parts.len() == 3 && m == "POST" {
            if !user().await {
                return err(403, refusal(WHAT));
            }
            let b = match body() {
                Ok(b) => b,
                Err(r) => return r,
            };
            let me = self.clone();
            let text = text_of(&b);
            return blocking(move || me.send(&slug, None, &text)).await.map_or_else(|| err(500, "send failed"), |r| r.map_or_else(from, |v| reply(201, v)));
        }
        if parts.len() < 4 {
            return err(404, "not found");
        }
        let cid = parts[3].clone();
        let me = self.clone();
        let (s1, c1) = (slug.clone(), cid.clone());
        let Some(Some(chat)) = blocking(move || me.get(&s1, &c1)).await else { return err(404, "chat not found") };
        let sub = parts.get(4).map(String::as_str);
        match (parts.len(), sub, m) {
            (4, _, "GET") => reply(200, self.view(&slug, &chat)),
            // The Context panel: how much of Claude's memory the chat fills (GET cached, POST checks now).
            (5, Some("context"), "GET" | "POST") => {
                let Some(x) = self.chat_extras() else { return later_task("The Context panel", "R7b") };
                if m == "POST" && !user().await {
                    return err(403, refusal("Checking a chat's context"));
                }
                let key = format!("chat/{slug}/{cid}");
                let me = self.clone();
                let (s1, c1) = (slug.clone(), cid.clone());
                let spec = blocking(move || me.context_spec(&s1, &c1)).await.unwrap_or(Ok(None));
                if m == "POST" {
                    let s = match spec {
                        Ok(s) => s,
                        Err(e) => return err(409, e),
                    };
                    let sid = s.as_ref().map(|s| s.session_id.clone());
                    if let Some(s) = s {
                        x.contexts.refresh(&key, s).await;
                    }
                    return blocking(move || reply(200, x.contexts.view(&key, sid.as_deref()))).await.unwrap_or_else(|| err(500, "context failed"));
                }
                let sid = spec.ok().flatten().map(|s| s.session_id);
                blocking(move || reply(200, x.contexts.view(&key, sid.as_deref()))).await.unwrap_or_else(|| err(500, "context failed"))
            }
            (4, _, "PATCH") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                let b = match body() {
                    Ok(b) => b.unwrap_or(Value::Null),
                    Err(r) => return r,
                };
                let title = b.get("title").and_then(Value::as_str).map(str::to_string);
                let me = self.clone();
                blocking(move || me.rename(&slug, &cid, title.as_deref())).await.map_or_else(|| err(500, "rename failed"), |r| r.map_or_else(from, |v| reply(200, v)))
            }
            (4, _, "DELETE") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                match self.remove(&slug, &cid).await {
                    Ok(()) => Reply { status: 204, body: None },
                    Err(e) => from(e),
                }
            }
            (5, Some("messages"), "POST") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                let b = match body() {
                    Ok(b) => b,
                    Err(r) => return r,
                };
                let me = self.clone();
                let text = text_of(&b);
                blocking(move || me.send(&slug, Some(&cid), &text)).await.map_or_else(|| err(500, "send failed"), |r| r.map_or_else(from, |v| reply(200, v)))
            }
            (5, Some("stop"), "POST") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                self.stop(&slug, &cid);
                let me = self.clone();
                let v = blocking(move || {
                    let c = me.get(&slug, &cid).unwrap_or(chat);
                    me.view(&slug, &c)
                })
                .await;
                v.map_or_else(|| err(500, "stop failed"), |v| reply(200, v))
            }
            (5, Some("ticket"), "POST") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                let b = req.body.clone().ok().flatten().unwrap_or(Value::Null);
                let part_of = match b.get("partOf") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(p)) if !p.is_empty() => Some(p.clone()),
                    Some(_) => return err(400, "partOf must be a ticket id"),
                };
                let me = self.clone();
                blocking(move || {
                    if let Some(p) = &part_of
                        && !me.ticket_on_board(&slug, p)
                    {
                        return err(400, format!("ticket {p} not found (partOf)"));
                    }
                    match me.make_ticket(&slug, &cid, part_of.as_deref()) {
                        Ok((ticket, chat)) => reply(201, json!({ "ticket": ticket, "chat": chat })),
                        Err(e) => from(e),
                    }
                })
                .await
                .unwrap_or_else(|| err(500, "make ticket failed"))
            }
            (5, Some("rewind"), "GET" | "POST") => {
                // Rewind (chat only: quick chats never change files back), like a ticket's.
                let b = if m == "POST" {
                    if !user().await {
                        return err(403, refusal(WHAT));
                    }
                    match body() {
                        Ok(b) => b.unwrap_or(Value::Null),
                        Err(r) => return r,
                    }
                } else {
                    Value::Null
                };
                let uuid = if m == "POST" {
                    match b.get("uuid") {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => rjs::to_string(v),
                    }
                } else {
                    query_get(q, "uuid").unwrap_or_default()
                };
                let me = self.clone();
                let sessions = sessions.clone();
                let sid = chat.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                let get = m == "GET";
                blocking(move || {
                    let entries = sessions.cache.get(&sid).map(|p| (*p.entries).clone()).unwrap_or_default();
                    let Some(entry) = entries.iter().find(|e| e.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()) && rjs::truthy(e.get("rewind"))).cloned() else {
                        return err(404, "This message can't be rewound to.");
                    };
                    if get {
                        return reply(200, json!({ "blocked": me.rewind_blocked(&slug, &cid, false), "files": null, "filesReason": "quick-chat" }));
                    }
                    me.rewind_chat(&slug, &cid, &entry, &entries).map_or_else(from, |v| reply(200, v))
                })
                .await
                .unwrap_or_else(|| err(500, "rewind failed"))
            }
            (5, Some("rewind-undo"), "GET" | "POST") => {
                let me = self.clone();
                if m == "GET" {
                    let u = chat.get("rewindUndo").filter(|v| !v.is_null()).cloned();
                    return blocking(move || {
                        let messages = u.as_ref().and_then(|u| u.get("messages")).cloned().filter(|v| !v.is_null()).unwrap_or(json!(0));
                        reply(200, json!({ "available": u.is_some(), "blocked": me.undo_rewind_blocked(&slug, &cid, false), "messages": messages, "files": 0, "filesSaved": false }))
                    })
                    .await
                    .unwrap_or_else(|| err(500, "undo failed"));
                }
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                blocking(move || me.undo_rewind_chat(&slug, &cid).map_or_else(from, |v| reply(200, v))).await.unwrap_or_else(|| err(500, "undo failed"))
            }
            (5, Some("fork"), "POST") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                let b = match body() {
                    Ok(b) => b.unwrap_or(Value::Null),
                    Err(r) => return r,
                };
                let uuid = match b.get("uuid") {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => rjs::to_string(v),
                };
                let me = self.clone();
                let sessions = sessions.clone();
                let sid = chat.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                blocking(move || {
                    let entries = sessions.cache.get(&sid).map(|p| (*p.entries).clone()).unwrap_or_default();
                    let Some(entry) = entries.iter().find(|e| e.get("uuid").and_then(Value::as_str) == Some(uuid.as_str()) && rjs::truthy(e.get("rewind"))) else {
                        return err(404, "The chat can't be forked from this message.");
                    };
                    let text = entry.get("text").cloned().unwrap_or(Value::Null);
                    match me.fork_chat(&slug, &cid, &uuid) {
                        Ok(next) => reply(201, json!({ "id": next.get("id").cloned().unwrap_or(Value::Null), "text": text, "chat": next })),
                        Err(e) => from(e),
                    }
                })
                .await
                .unwrap_or_else(|| err(500, "fork failed"))
            }
            (5, Some("conversation"), "GET") => {
                let me = self.clone();
                let sessions = sessions.clone();
                let q = req.query.clone();
                blocking(move || me.conversation(&sessions, &slug, &cid, &chat, q.as_deref())).await.unwrap_or_else(|| err(500, "conversation failed"))
            }
            // "Say it simpler" for the chat's replies, like a ticket's.
            (5, Some("simplified"), "GET") => {
                let Some(x) = self.chat_extras() else { return later_task("Say it simpler", "R7b") };
                let sid = chat.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                let file = self.simplified_path(&slug, &cid);
                blocking(move || {
                    let entries = x.sessions.cache.get(&sid).map(|p| (*p.entries).clone()).unwrap_or_default();
                    reply(200, x.simplifier.saved_in(&file, &entries))
                })
                .await
                .unwrap_or_else(|| err(500, "simplified failed"))
            }
            (5, Some("simplify"), "POST") => {
                if !user().await {
                    return err(403, refusal(WHAT));
                }
                let Some(x) = self.chat_extras() else { return later_task("Say it simpler", "R7b") };
                let b = match body() {
                    Ok(b) => b,
                    Err(r) => return r,
                };
                let sid = chat.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                let uuid = b.as_ref().and_then(|b| b.get("uuid")).and_then(Value::as_str).map(str::to_string);
                let x2 = x.clone();
                let entry = blocking(move || {
                    let u = uuid?;
                    x2.sessions.cache.get(&sid)?.entries.iter().find(|e| e.get("uuid").and_then(Value::as_str) == Some(u.as_str())).cloned()
                })
                .await
                .flatten();
                let Some(e) = entry else { return err(404, "no such message in this chat") };
                let title = match self.view(&slug, &chat).get("title") {
                    None => "undefined".to_string(),
                    Some(v) => rjs::to_string(v),
                };
                match x.simplifier.simplify_in(self.simplified_path(&slug, &cid), self.side_spend_path(&slug, &cid), &title, &e).await {
                    Ok(v) => reply(200, v),
                    Err((status, msg)) => err(status, msg),
                }
            }
            (6, Some("tool"), "GET") => {
                let sessions = sessions.clone();
                let sid = chat.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                let tool = parts[5].clone();
                match blocking(move || sessions.cache.tool_detail(&sid, &tool)).await.flatten() {
                    Some(d) => reply(200, d),
                    None => err(404, "tool call not found"),
                }
            }
            _ => err(404, "not found"),
        }
    }

    /// The conversation, newest last, paged like a ticket's. Blocking (reads the transcript).
    fn conversation(&self, sessions: &Arc<Sessions>, slug: &str, cid: &str, chat: &Map<String, Value>, q: Option<&str>) -> Reply {
        let sid = chat.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let parsed = sessions.cache.get(sid);
        let empty = Arc::new(Vec::new());
        let all = parsed.as_ref().map_or(empty, |p| p.entries.clone());
        let len = all.len() as f64;
        let limit = query_get(q, "limit").map_or(f64::NAN, |v| rjs::number_of_str(&v));
        let limit = 500f64.min(1f64.max(if limit == 0.0 || limit.is_nan() { 100.0 } else { limit }));
        let before = query_get(q, "before").map_or(len, |v| rjs::number_of_str(&v));
        // Math.min/max with NaN give NaN; slice(NaN, NaN) is empty and the start goes out as null.
        let end = if before.is_nan() { f64::NAN } else { 0f64.max(len.min(before)) };
        let start = if end.is_nan() { f64::NAN } else { 0f64.max(end - limit) };
        let active = self.is_running(slug, cid);
        let now = ckanban_core::time::now_ms();
        let (a, b) = if end.is_nan() { (0, 0) } else { (start as usize, end as usize) };
        let entries: Vec<Value> = all[a.min(b)..b]
            .iter()
            .map(|e| {
                let Some(o) = e.as_object() else { return e.clone() };
                let mut o = o.clone();
                if let Some(w) = o.get("workflow").and_then(Value::as_object) {
                    let mut w = workflows::settle_workflow(w, active, now);
                    w.shift_remove("script");
                    w.shift_remove("scriptPath");
                    o.insert("workflow".into(), Value::Object(w));
                } else if let Some(ag) = o.get("agent").and_then(Value::as_object) {
                    let mut ag = subagents::settle_agent(ag, active, now);
                    if let Some(Value::Array(steps)) = ag.get_mut("steps") {
                        let cut = steps.len().saturating_sub(AGENT_STEP_TAIL);
                        steps.drain(..cut);
                    }
                    o.insert("agent".into(), Value::Object(ag));
                }
                Value::Object(o)
            })
            .collect();
        reply(200, json!({ "entries": entries, "start": ckanban_core::jsnum::num(start), "total": all.len() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_queries() {
        assert_eq!(parts_of("/api/profiles/ask/chats").unwrap(), ["profiles", "ask", "chats"]);
        assert_eq!(parts_of("/api/profiles/ask/chats/ab12/tool/tu_x").unwrap().len(), 6);
        assert!(parts_of("/api/profiles/ask/chat/search").is_none());
        assert!(parts_of("/api/profiles/ask").is_none());
        assert_eq!(query_get(Some("limit=1&before=a%7Cb%7Cc"), "before").as_deref(), Some("a|b|c"));
        assert_eq!(text_of(&Some(json!({"text": 5}))), "5");
        assert_eq!(text_of(&None), "");
    }
}
