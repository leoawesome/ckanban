//! The helper's routes in board mode (from `src/api/notify.ts` and `ticket-info.ts`): `/api/messages...` (the
//! messages the board sent the user), `/api/helper...` (status and helper lines, settings, "What the helper knows
//! about you", taps), `/api/notify...` (notification settings, the test, Telegram pairing asked of the satellite),
//! `/api/push...` (phone push devices) and a ticket's `POST .../notify` (notify_user).

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::Helper;
use super::messages::{Cursor, as_tab, near_of, needs_shown, page_of, to_row};
use super::watch::TOOL_NO_NOTIFY;
use crate::runs::js;

pub struct Req {
    pub method: String,
    pub parts: Vec<String>,
    pub query: String,
    /// `x-ckanban-run` (the run's "<board>/<ticket>"), when a board run calls.
    pub run: Option<String>,
    pub huddle: bool,
    pub body: Vec<u8>,
    /// Came in on this Mac's listener (not phone access).
    pub local: bool,
    /// `userOnly(what)`: Ok when the caller is the user's own browser.
    pub user: UserCheck,
}

/// `userOnly(what)` for a route.
pub type UserCheck = Arc<dyn Fn(String) -> BoxFuture<'static, Result<(), (u16, String)>> + Send + Sync>;

pub type Answer = Result<Value, (u16, String)>;

/// Whether the helper answers this path (`/api/<parts>`).
pub fn claims(parts: &[String]) -> bool {
    match parts.first().map(String::as_str) {
        Some("messages" | "helper" | "notify" | "push") => true,
        Some("profiles") => parts.len() == 5 && parts[2] == "tickets" && parts[4] == "notify",
        _ => false,
    }
}

fn q(query: &str, k: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes()).find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
}

fn body(r: &Req) -> Result<Value, (u16, String)> {
    js::parse(&String::from_utf8_lossy(&r.body)).ok_or((400, "invalid JSON body".to_string()))
}

fn not_found() -> (u16, String) {
    (404, "not found".into())
}

fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// One request; None when the path isn't the helper's.
pub async fn answer(h: &Helper, r: &Req) -> Option<Answer> {
    if !claims(&r.parts) {
        return None;
    }
    Some(match r.parts[0].as_str() {
        "messages" => messages(h, r).await,
        "helper" => helper(h, r).await,
        "notify" => settings(h, r).await,
        "push" => push(h, r).await,
        _ => notify(h, r).await,
    })
}

async fn messages(h: &Helper, r: &Req) -> Answer {
    if r.run.is_some() {
        return Err((403, "board runs can't read the user's messages".into()));
    }
    let core = &h.core;
    let (p, m) = (&r.parts, r.method.as_str());
    if p.len() == 1 && m == "GET" {
        let tab = as_tab(q(&r.query, "tab").as_deref().or(Some("all")));
        let n = q(&r.query, "limit").map(|l| js::number_of_str(&l).floor()).unwrap_or(0.0);
        let limit = (if n.is_nan() || n == 0.0 { 30.0 } else { n }).clamp(1.0, 100.0) as usize;
        let cursor = |side: &str| -> Option<Cursor> {
            let at = q(&r.query, &format!("{side}At")).filter(|s| !s.is_empty())?;
            let id = q(&r.query, &format!("{side}Id")).filter(|s| !s.is_empty())?;
            ckanban_core::time::parse_date(&at).map(|_| Cursor { at, id })
        };
        let newest = core.lock().messages.list_newest(true);
        let needs = core.needs_you(&newest);
        let (rows, more) = page_of(&newest, tab, limit, cursor("before").as_ref(), cursor("after").as_ref(), &needs);
        let unread = core.lock().messages.unread();
        return Ok(json!({ "rows": rows.iter().map(|x| to_row(x, &needs)).collect::<Vec<_>>(), "hasMore": more, "needs": needs_shown(&newest, &needs), "unread": unread }));
    }
    if p.len() == 2 && p[1] == "read-all" && m == "POST" {
        let mut st = core.lock();
        let marked = st.messages.mark_all_read();
        return Ok(json!({ "marked": marked, "unread": st.messages.unread() }));
    }
    let msg = p.get(1).and_then(|id| core.message(&decode(id)));
    if p.len() == 2 && m == "GET" {
        let msg = msg.ok_or((404, "message not found".to_string()))?;
        return Ok(core.with_states(&msg));
    }
    if p.len() == 3 && p[2] == "near" && m == "GET" {
        let msg = msg.ok_or((404, "message not found".to_string()))?;
        let newest = core.lock().messages.list_newest(true);
        let needs = core.needs_you(&newest);
        let tab = as_tab(q(&r.query, "tab").as_deref().or(Some("all")));
        return Ok(near_of(&newest, &msg, tab, &needs, q(&r.query, "keep").as_deref()));
    }
    if p.len() == 3 && p[2] == "read" && m == "POST" {
        let msg = msg.ok_or((404, "message not found".to_string()))?;
        let read = core.lock().messages.mark_read(super::waits::rs(&msg, "id")).unwrap_or(msg);
        let unread = core.lock().messages.unread();
        return Ok(json!({ "message": core.with_states(&read), "unread": unread }));
    }
    if p.len() == 3 && (p[2] == "got-it" || p[2] == "not-urgent") && m == "POST" {
        let msg = msg.ok_or((404, "message not found".to_string()))?;
        (r.user)("Stopping reminders".into()).await?;
        let b = js::parse(&String::from_utf8_lossy(&r.body)).unwrap_or(Value::Null);
        let key = b.get("key").and_then(Value::as_str).map(str::to_string);
        let id = super::waits::rs(&msg, "id").to_string();
        let res = if p[2] == "got-it" { h.runner.got_it(&id, key.as_deref()) } else { h.runner.not_urgent(&id, key.as_deref()) }?;
        let after = core.message(&id);
        let mut out = res.as_object().cloned().unwrap_or_default();
        out.insert("message".into(), after.map(|a| core.with_states(&a)).unwrap_or(Value::Null));
        out.insert("unread".into(), core.lock().messages.unread().into());
        return Ok(Value::Object(out));
    }
    Err(not_found())
}

async fn helper(h: &Helper, r: &Req) -> Answer {
    if r.run.is_some() {
        return Err((403, "board runs can't use the helper's settings".into()));
    }
    let runner = &h.runner;
    let (p, m) = (&r.parts, r.method.as_str());
    if p.len() == 1 && m == "GET" {
        return Ok(runner.status().await);
    }
    if m != "GET" {
        (r.user)("Changing the helper".into()).await?;
    }
    let lines = || json!(runner.settings.get().feedback);
    match (p.get(1).map(String::as_str), p.len(), m) {
        (Some("settings"), 2, "POST") => {
            let b = body(r)?;
            runner.settings.update(&b).map_err(|e| (400, e))?;
            Ok(runner.status().await)
        }
        (Some("feedback"), 2, "GET") => Ok(json!({ "lines": lines() })),
        (Some("feedback"), 2, "POST") => {
            let b = body(r)?;
            let line = runner.settings.add_feedback(b.get("text"), "user").map_err(|e| (400, e))?;
            runner.feedback_added();
            Ok(json!({ "line": line, "lines": lines() }))
        }
        (Some("feedback"), 3, "DELETE") => {
            if !runner.settings.remove_feedback(&decode(&p[2])) {
                return Err((404, "line not found".into()));
            }
            (h.emit)(json!({ "type": "helper.updated" }));
            Ok(json!({ "lines": lines() }))
        }
        (Some("should-have-pinged"), 2, "POST") => {
            let b = body(r)?;
            let (Some(profile), Some(ticket)) = (b.get("profile").and_then(Value::as_str), b.get("ticketId").and_then(Value::as_str)) else {
                return Err((400, "profile and ticketId are required".into()));
            };
            let v = runner.should_have_pinged(profile, ticket)?;
            let mut out = v.as_object().cloned().unwrap_or_default();
            out.insert("lines".into(), lines());
            Ok(Value::Object(out))
        }
        (Some("practice"), 2, "POST") => runner.practice().await,
        (Some("notice-seen"), 2, "POST") => {
            runner.notice_seen();
            Ok(runner.status().await)
        }
        _ => Err(not_found()),
    }
}

fn notifications(h: &Helper) -> Result<&Arc<super::notify::Notify>, (u16, String)> {
    h.notify.get().ok_or((503, "notifications aren't ready yet".to_string()))
}

fn str_of<'a>(b: &'a Value, k: &str) -> Option<&'a str> {
    b.get(k).and_then(Value::as_str)
}

/// `/api/notify...`: where messages go is the user's channel, so runs can't read or change it.
async fn settings(h: &Helper, r: &Req) -> Answer {
    if r.run.is_some() {
        return Err((403, "board runs can't use notification settings".into()));
    }
    let n = notifications(h)?;
    let (p, m) = (&r.parts, r.method.as_str());
    if p.len() == 1 && m == "GET" {
        return Ok(n.state(r.local).await);
    }
    if p.len() == 1 && m == "POST" {
        let patch = body(r)?;
        // Where messages go (the web address, ntfy, the Telegram bot and its token) is the user's alone: a run's
        // shell or another program could point every message, full text included, at its own address.
        (r.user)("Changing notification settings".into()).await?;
        return n.update(&patch, r.local).await;
    }
    if p.get(1).map(String::as_str) == Some("test") && m == "POST" {
        let b = body(r)?;
        return Ok(n.test(str_of(&b, "profile"), r.local).await);
    }
    if p.len() == 3 && p[1] == "telegram" && p[2] == "pair" && m == "POST" {
        (r.user)("Pairing Telegram".into()).await?;
        // Whoever pairs gets to answer tickets from that chat: only this Mac, so a lost phone can't pair a new chat.
        if !r.local {
            return Err((403, super::notify::TG_PAIR_FROM_MAC.into()));
        }
        let b = body(r)?;
        return n.pair(str_of(&b, "board"), r.local).await;
    }
    if p.len() == 3 && p[1] == "telegram" && p[2] == "unpair" && m == "POST" {
        (r.user)("Unpairing Telegram".into()).await?;
        return n.unpair(r.local).await;
    }
    Err(not_found())
}

/// `/api/push...`: this device turns notifications on or off; the page's heartbeat says when its board is on screen.
/// Adding or removing a device is the user's own (a program that added its own address would get every message).
async fn push(h: &Helper, r: &Req) -> Answer {
    if r.run.is_some() {
        return Err((403, "board runs can't use notification settings".into()));
    }
    let n = notifications(h)?;
    let svc = n.channels.push.clone();
    let (p, m) = (&r.parts, r.method.as_str());
    if p.len() == 1 && m == "GET" {
        return tokio::task::spawn_blocking(move || json!({ "publicKey": svc.public_key(), "devices": svc.devices(), "dropped": svc.dropped() }))
            .await
            .map_err(|e| (500, e.to_string()));
    }
    let b = if m == "POST" { body(r)? } else { Value::Null };
    let endpoint = str_of(&b, "endpoint").unwrap_or("").to_string();
    match (p.get(1).map(String::as_str), m) {
        (Some("subscribe"), "POST") => {
            (r.user)("Turning notifications on".into()).await?;
            // On the board's own port: a browser on this Mac (phone access comes in on the remote listener).
            let (local, sub, label, replaces) = (r.local, b.get("subscription").cloned().unwrap_or(Value::Null), b.get("label").cloned(), str_of(&b, "replaces").map(str::to_string));
            let d = tokio::task::spawn_blocking(move || svc.subscribe(&sub, label.as_ref(), local, replaces.as_deref())).await.map_err(|e| (500, e.to_string()))?;
            let d = d.map_err(|e| (400, e))?;
            Ok(json!({ "id": d.get("id"), "label": d.get("label"), "createdAt": d.get("createdAt") }))
        }
        (Some("remove"), "POST") => {
            let key = str_of(&b, "id").map(str::to_string).unwrap_or(endpoint);
            if key.is_empty() {
                return Err((400, "id or endpoint is required".into()));
            }
            (r.user)("Turning notifications off".into()).await?;
            tokio::task::spawn_blocking(move || -> Answer {
                let removed = svc.remove(&key).map_err(|e| (500, e))?;
                Ok(json!({ "removed": removed, "devices": svc.devices() }))
            })
            .await
            .map_err(|e| (500, e.to_string()))?
        }
        (Some("visible"), "POST") => {
            if endpoint.is_empty() {
                return Err((400, "endpoint is required".into()));
            }
            let (visible, local) = (b.get("visible") == Some(&Value::Bool(true)), r.local);
            tokio::task::spawn_blocking(move || {
                svc.set_visible(&endpoint, visible);
                if local {
                    svc.mark_this_mac(&endpoint);
                }
            })
            .await
            .map_err(|e| (500, e.to_string()))?;
            Ok(json!({ "ok": true }))
        }
        (Some("test"), "POST") => {
            let Some(id) = str_of(&b, "id") else { return Err((400, "id is required".into())) };
            Ok(n.test_device(id, str_of(&b, "profile")).await)
        }
        _ => Err(not_found()),
    }
}

/// `POST /api/profiles/:p/tickets/:id/notify`: the ticket's own Claude sends the user a notification.
async fn notify(h: &Helper, r: &Req) -> Answer {
    if r.method != "POST" {
        return Err(not_found());
    }
    let (slug, id) = (decode(&r.parts[1]), decode(&r.parts[3]));
    // `profileOr404`, `ticketOr404` first, as Bun's ticket routes.
    if !h.core.board.has_profile(&slug) {
        return Err((404, format!("board {slug} not found")));
    }
    if h.core.board.ticket(&slug, &id).is_none() {
        return Err((404, format!("ticket {id} not found")));
    }
    if r.run.as_deref() != Some(format!("{slug}/{id}").as_str()) || r.huddle {
        return Err((403, "only the ticket's own Claude sends it a notification, from its run or chat".into()));
    }
    if let Some(t) = h.core.board.ticket(&slug, &id)
        && t.hidden_tool()
        && !(t.tool && t.kind.as_deref() == Some("with_you"))
    {
        return Err((403, TOOL_NO_NOTIFY.into()));
    }
    let b = js::parse(&String::from_utf8_lossy(&r.body)).ok_or((400, "invalid JSON body".to_string()))?;
    let b = if b.is_null() { json!({}) } else { b };
    let Some(message) = b.get("message").and_then(Value::as_str) else { return Err((400, "message is required".into())) };
    let urgent = match b.get("urgent") {
        None => false,
        Some(Value::Bool(u)) => *u,
        Some(_) => return Err((400, "urgent must be true or false".into())),
    };
    let why = match b.get("why") {
        None => None,
        Some(Value::String(w)) if js::len16(w) <= 300 => Some(w.as_str()),
        Some(_) => return Err((400, "why must be one line of text".into())),
    };
    h.watch.message(&slug, &id, message, urgent, why).await
}
