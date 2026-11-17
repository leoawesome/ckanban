//! A quick chat's Rewind (the chat only: quick chats never change files back), Undo rewind, Fork from here and Make
//! ticket (`src/chat/quickchat.ts`). Blocking: called from the routes' blocking threads.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::{fork_title, session_file};
use super::rewind::{self, RewindError};
use crate::quickchat::service::{ChatError, QuickChats};
use crate::quickchat::text::{TITLE_MAX, auto_title};
use crate::runs::js;
use crate::tickets::writer::block;

/// Makes the ticket for Make ticket: (board, title, body, partOf, the chat's session) → the new ticket's view, or
/// (status, message). Board mode builds it from the ticket writes and the run loop's link-session.
pub type MakeTicket = Arc<dyn Fn(&str, &str, &str, Option<&str>, &str) -> Result<Value, (u16, String)> + Send + Sync>;

const REWINDING: &str = "The chat is being rewound, undone or forked right now. Try again in a moment.";

fn key(slug: &str, id: &str) -> String {
    format!("{slug}/{id}")
}

fn fail<T>(status: u16, m: impl Into<String>) -> Result<T, ChatError> {
    Err(ChatError { status, message: m.into() })
}

fn s<'a>(c: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    c.get(k).and_then(Value::as_str)
}

/// The chat marked as being rewound until it drops.
pub struct QuickGuard {
    chats: Arc<QuickChats>,
    key: String,
}

impl Drop for QuickGuard {
    fn drop(&mut self) {
        self.chats.rewinding.lock().remove(&self.key);
    }
}

fn refused(e: RewindError, other: u16) -> ChatError {
    match e {
        RewindError::Refused(m) => ChatError { status: 409, message: m },
        RewindError::Failed(m) => ChatError { status: other, message: m },
    }
}

impl QuickChats {
    /// Board mode's Make ticket (`make_ticket_hook`).
    pub fn set_make_ticket(&self, f: MakeTicket) {
        *self.make_ticket.lock() = Some(f);
    }

    /// `rewindBlocked`: why the chat can't be rewound or forked right now (the same rules as a ticket's).
    pub fn rewind_blocked(&self, slug: &str, id: &str, held: bool) -> Option<String> {
        let Some(c) = self.get(slug, id) else { return Some("chat not found".into()) };
        let k = key(slug, id);
        if !held && self.rewinding.lock().contains(&k) {
            return Some(REWINDING.into());
        }
        if js::truthy(c.get("ticketId")) {
            return Some("This chat became a ticket. Continue it in the ticket's chat.".into());
        }
        if self.making.lock().contains(&k) {
            return Some("This chat is being made into a ticket.".into());
        }
        if self.is_running(slug, id) {
            return Some("Claude is working. Stop it or wait until it has replied.".into());
        }
        if c.get("pending").and_then(Value::as_array).is_some_and(|p| !p.is_empty()) {
            return Some("A message is still waiting to be sent. Try again once it has gone.".into());
        }
        None
    }

    /// `withRewind`'s start, checked under the chats' write lock so a message being sent can't slip in.
    fn begin_rewind(self: &Arc<Self>, slug: &str, id: &str) -> Result<QuickGuard, ChatError> {
        let _w = self.writes.lock();
        if let Some(b) = self.rewind_blocked(slug, id, false) {
            return fail(409, b);
        }
        let k = key(slug, id);
        self.rewinding.lock().insert(k.clone());
        Ok(QuickGuard { chats: self.clone(), key: k })
    }

    /// `rewind`: the chat cut back to the user's message (`entry`); `entries` the conversation as the UI shows it.
    pub fn rewind_chat(self: &Arc<Self>, slug: &str, id: &str, entry: &Value, entries: &[Value]) -> Result<Value, ChatError> {
        let _g = self.begin_rewind(slug, id)?;
        let c = self.get_or_404(slug, id)?;
        let sid = s(&c, "sessionId").unwrap_or("").to_string();
        let Some(file) = session_file(&sid) else { return fail(404, "The conversation file is missing.") };
        let uuid = entry.get("uuid").and_then(Value::as_str).unwrap_or("");
        let text = entry.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        let at = entry.get("at").and_then(Value::as_str).unwrap_or("");
        let messages = rewind::messages_from(entries, uuid);
        let me = self.clone();
        let (s2, i2) = (slug.to_string(), id.to_string());
        let still = move || me.rewind_blocked(&s2, &i2, true);
        let cid = s(&c, "id").unwrap_or(id).to_string();
        let r = block(rewind::apply_rewind(None, &cid, uuid, &text, at, &file, false, &sid, &still)).map_err(|e| refused(e, 400))?;
        let new_sid = r.cut.empty.then(crate::quickchat::text::random_uuid);
        let mut undo = r.undo;
        undo.insert("messages".into(), json!(messages));
        undo.insert("newSessionId".into(), new_sid.clone().map(Value::String).unwrap_or(Value::Null));
        let mut p = Map::new();
        p.insert("rewindUndo".into(), Value::Object(undo));
        if let Some(n) = new_sid {
            p.insert("sessionId".into(), json!(n));
            p.insert("started".into(), json!(false));
        }
        self.patch(slug, id, p);
        Ok(json!({ "text": text, "restored": 0, "messages": messages, "files": 0, "undo": true }))
    }

    /// `undoRewindBlocked`.
    pub fn undo_rewind_blocked(&self, slug: &str, id: &str, held: bool) -> Option<String> {
        if let Some(b) = self.rewind_blocked(slug, id, held) {
            return Some(b);
        }
        let c = self.get(slug, id)?;
        let u = c.get("rewindUndo").and_then(Value::as_object);
        let sid = s(&c, "sessionId");
        let u_sid = u.and_then(|u| u.get("sessionId")).and_then(Value::as_str);
        let started = sid != u_sid && (js::truthy(c.get("started")) || sid.is_some_and(|x| self.session_exists(x)));
        let file = u.and(u_sid).and_then(session_file);
        block(rewind::undo_blocked(u, file.as_deref(), (sid, started), false))
    }

    /// `undoRewind`: the chat as it was just before the last rewind.
    pub fn undo_rewind_chat(self: &Arc<Self>, slug: &str, id: &str) -> Result<Value, ChatError> {
        let _g = self.begin_rewind(slug, id)?;
        if let Some(b) = self.undo_rewind_blocked(slug, id, true) {
            return fail(409, b);
        }
        let c = self.get_or_404(slug, id)?;
        let u = c.get("rewindUndo").and_then(Value::as_object).cloned().unwrap_or_default();
        let u_sid = u.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(file) = session_file(&u_sid) else { return fail(409, "The chat from before the rewind is gone, so it can't come back.") };
        let me = self.clone();
        let (s2, i2) = (slug.to_string(), id.to_string());
        let still = move || me.rewind_blocked(&s2, &i2, true);
        let cid = s(&c, "id").unwrap_or(id).to_string();
        let mut r = block(rewind::apply_undo(&u, &file, &cid, false, &still)).map_err(|e| refused(e, 500))?;
        let mut p = obj(json!({ "rewindUndo": null }));
        if u.get("newSessionId").and_then(Value::as_str).is_some_and(|x| !x.is_empty()) {
            p.insert("sessionId".into(), json!(u_sid));
            p.insert("started".into(), json!(true));
        }
        self.patch(slug, id, p);
        r["filesReason"] = json!("unchanged");
        Ok(r)
    }

    /// `fork`: a new quick chat "<title> (fork)" whose conversation ends just before the user message `uuid`.
    pub fn fork_chat(&self, slug: &str, id: &str, uuid: &str) -> Result<Value, ChatError> {
        let Some(profile) = self.profile(slug) else { return fail(404, format!("board {slug} not found")) };
        if let Some(b) = self.rewind_blocked(slug, id, false) {
            return fail(409, b);
        }
        let c = self.get_or_404(slug, id)?;
        let sid = s(&c, "sessionId").unwrap_or("").to_string();
        let Some(file) = session_file(&sid) else { return fail(404, "The conversation file is missing.") };
        let raw = std::fs::read_to_string(&file).unwrap_or_default();
        let Some((text, cut)) = rewind::cut_session(&raw, uuid) else { return fail(400, "The chat can't be forked from this message.") };
        let now = crate::tickets::writer::now();
        let title_of = |x: &Map<String, Value>| match x.get("title").and_then(Value::as_str) {
            Some(t) => t.to_string(),
            None => auto_title(s(x, "firstMessage")),
        };
        let list = self.list(slug);
        let titles: Vec<String> = list.iter().map(|x| title_of(x)).collect();
        let title = fork_title(&title_of(&c), titles.iter().map(String::as_str), Some(TITLE_MAX));
        let mut next = obj(json!({
            "id": ckanban_core::atomic::new_id(), "sessionId": crate::quickchat::text::random_uuid(), "title": title, "firstMessage": null,
            "createdAt": now, "updatedAt": now, "started": false, "ticketId": null, "error": null,
        }));
        if !cut.empty {
            let path = profile.get("path").and_then(Value::as_str).unwrap_or("");
            let to = next.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            crate::runloop::branch::fork_session_text(&file, text, &sid, &to, path, path, &[]).map_err(|e| ChatError { status: 400, message: e })?;
            next.insert("started".into(), json!(true));
            next.insert("firstMessage".into(), c.get("firstMessage").cloned().unwrap_or(Value::Null));
        }
        let saved = self.save(slug, next);
        self.emit(slug, &saved);
        Ok(self.view(slug, &saved))
    }

    /// `makeTicket`: a Backlog ticket that continues this conversation; the chat takes no more messages.
    pub fn make_ticket(&self, slug: &str, id: &str, part_of: Option<&str>) -> Result<(Value, Value), ChatError> {
        let k = key(slug, id);
        if !self.making.lock().insert(k.clone()) {
            return fail(409, "This chat is already being made into a ticket.");
        }
        let out = self.make_ticket_now(slug, id, part_of);
        self.making.lock().remove(&k);
        out
    }

    fn make_ticket_now(&self, slug: &str, id: &str, part_of: Option<&str>) -> Result<(Value, Value), ChatError> {
        let c = self.get_or_404(slug, id)?;
        if js::truthy(c.get("frontDesk")) {
            return fail(409, "The Telegram front desk's chat can't become a ticket. Ask it to start the work: it makes a ticket for it.");
        }
        let maker = self.make_ticket.lock().clone();
        let Some(maker) = maker else { return fail(503, "the board is still starting; try again in a moment") };
        if let Some(t) = s(&c, "ticketId").filter(|t| !t.is_empty())
            && self.ticket_exists(slug, t)
        {
            return fail(409, "This chat is already a ticket.");
        }
        if self.is_running(slug, id) {
            return fail(409, "Claude is still replying. Wait for it to finish, or stop it, then try again.");
        }
        let sid = s(&c, "sessionId").unwrap_or("").to_string();
        if !js::truthy(c.get("started")) && !self.session_exists(&sid) {
            return fail(409, "Send Claude a message first.");
        }
        let title = match c.get("title").and_then(Value::as_str) {
            Some(t) => t.to_string(),
            None => auto_title(s(&c, "firstMessage")),
        };
        let first = js::trim(s(&c, "firstMessage").unwrap_or("")).to_string();
        let quoted = first.split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n");
        let body = if first.is_empty() {
            "Started from a quick chat with Claude on the board.".to_string()
        } else {
            format!("Started from a quick chat with Claude on the board.\n\nFirst message:\n\n{quoted}")
        };
        let ticket = maker(slug, &title, &body, part_of, &sid).map_err(|(status, message)| ChatError { status, message })?;
        let tid = ticket.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let chat = match self.patch(slug, id, obj(json!({ "ticketId": tid, "started": true }))) {
            Some(c) => c,
            None => {
                // Deleted meanwhile: the ticket stays, the chat is gone.
                let mut c2 = (*c).clone();
                c2.insert("ticketId".into(), json!(tid));
                c2.insert("started".into(), json!(true));
                Arc::new(c2)
            }
        };
        Ok((ticket, self.view(slug, &chat)))
    }

    /// `store.getTicket(slug, id)` exists (Make ticket's partOf check).
    pub fn ticket_on_board(&self, slug: &str, id: &str) -> bool {
        self.ticket_exists(slug, id)
    }

    fn ticket_exists(&self, slug: &str, id: &str) -> bool {
        !id.is_empty() && id != "." && id != ".." && !id.contains(['/', '\\', '\0']) && self.chats_dir(slug).parent().is_some_and(|p| p.join("tickets").join(id).join("ticket.md").exists())
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

/// Board mode's Make ticket over the ticket writes and the run loop (`board.createTicket`, `linkSession`,
/// `updateTicket`, `addComment`, the parent suggestion).
pub fn make_ticket_hook(runs: Arc<crate::runloop::RunLoop>, writes: Arc<crate::tickets::routes::Writes>) -> MakeTicket {
    Arc::new(move |slug: &str, title: &str, body: &str, part_of: Option<&str>, session: &str| {
        let tickets = runs.tickets.clone();
        let mut input = obj(json!({ "title": title, "body": body, "status": "backlog" }));
        if let Some(p) = part_of {
            input.insert("partOf".into(), json!(p));
        }
        let t = tickets.create(slug, input).map_err(|(_, m)| (400, m))?;
        let linked = block(runs.link_session(slug, &t.id, Some(session))).map_err(|e| e.message);
        let moved = linked.and_then(|_| tickets.update(slug, &t.id, &obj(json!({ "status": "backlog" })), false).map_err(|(_, m)| m));
        if let Err(m) = moved {
            let _ = tickets.delete(slug, &t.id);
            return Err((400, m));
        }
        tickets.note(slug, &t.id, "Made from a quick chat: its conversation with Claude continues in this ticket's chat.");
        if part_of.is_none() {
            crate::extras::suggest_parent(slug, &t.id);
        }
        let now = tickets.get(slug, &t.id).unwrap_or(t);
        Ok(writes.view_pub(slug, &now))
    })
}
