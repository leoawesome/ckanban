//! The chat extras' ticket routes in board mode (`src/api/ticket-files.ts` commands, rewind, rewind-undo, fork;
//! `ticket-actions.ts` planning-command; `profiles.ts` the board's commands). They run inside
//! `tickets::routes::Writes::answer`, after its gate, on a blocking thread; the ticket exists.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::session_file;
use super::rewind;
use crate::runloop::RunLoop;
use crate::runloop::board::{RunError, ts};
use crate::tickets::routes::{Reply, Req, Writes, body_obj, user_only_refusal};
use crate::tickets::writer::{Refusal, block};

/// The paths after `/api/profiles/:p/tickets/:id/` these routes take.
pub fn wanted(method: &str, rest: &[&str]) -> bool {
    matches!(
        (method, rest),
        ("GET", ["commands"]) | ("GET" | "POST", ["rewind" | "rewind-undo"]) | ("POST", ["fork" | "planning-command"])
    )
}

fn query(req: &Req, key: &str) -> Option<String> {
    url::form_urlencoded::parse(req.query.trim_start_matches('?').as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned())
}

fn user_only(req: &Req, what: &str) -> Result<(), Refusal> {
    if req.run.is_some() || req.huddle || !(req.user)() { Err(user_only_refusal(what)) } else { Ok(()) }
}

fn run_err(e: RunError) -> Refusal {
    (e.status, e.message)
}

/// The rewindable entry `uuid` of the ticket's current session: (session id, entry, all entries).
fn rewind_entry(runs: &RunLoop, slug: &str, id: &str, uuid: &str) -> Option<(String, Value, Vec<Value>)> {
    let t = runs.tickets.get(slug, id)?;
    let sid = ts(&t, "sessionId")?.to_string();
    let entries = runs.sessions.entries(&sid);
    let e = entries.iter().find(|e| e.get("uuid").and_then(Value::as_str) == Some(uuid) && crate::runs::js::truthy(e.get("rewind")))?.clone();
    Some((sid, e, entries))
}

fn text_of(e: &Value, k: &str) -> String {
    e.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn answer(runs: &Arc<RunLoop>, w: &Writes, req: &Req, slug: &str, id: &str, rest: &[&str]) -> Result<Reply, Refusal> {
    let m = req.method.as_str();
    match rest {
        ["commands"] => Ok(Reply::Json(200, Value::Array(runs.commands(slug, id).iter().map(|c| c.view()).collect()))),
        ["planning-command"] => {
            let c = runs.planning_command(slug, id).map_err(|e| (400, e))?;
            Ok(Reply::Json(200, json!({ "command": c })))
        }
        ["rewind"] => {
            // Rewind: cut the chat before one of the user's messages and put the project files back as they were
            // then. GET ?uuid= says what would change; POST { uuid, files } does it. Only the user's click.
            if req.run.is_some() {
                return Err((403, "Rewind is the user's click, not a board run's".into()));
            }
            let b = if m == "POST" { body_obj(req)? } else { Map::new() };
            let uuid = if m == "POST" {
                match b.get("uuid") {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => crate::runs::js::to_string(v),
                }
            } else {
                query(req, "uuid").unwrap_or_default()
            };
            let Some((sid, entry, entries)) = rewind_entry(runs, slug, id, &uuid) else {
                return Err((404, "This message can't be rewound to.".into()));
            };
            let blocked = runs.rewind_blocked(slug, id, false);
            let dir = runs.rewind_dir(slug, id);
            let (text, at) = (text_of(&entry, "text"), text_of(&entry, "at"));
            if m == "GET" {
                let mut out = Map::new();
                out.insert("blocked".into(), blocked.map(Value::String).unwrap_or(Value::Null));
                out.extend(block(rewind::preview_rewind(dir.as_deref(), id, &text, &at)));
                return Ok(Reply::Json(200, Value::Object(out)));
            }
            if let Some(b) = blocked {
                return Err((409, b));
            }
            let file: PathBuf = session_file(&sid).ok_or_else(|| (404, "The conversation file is missing.".to_string()))?;
            let messages = rewind::messages_from(&entries, &uuid);
            let files = b.get("files") != Some(&Value::Bool(false));
            let _guard = runs.begin_rewind(slug, id).map_err(run_err)?;
            let me = runs.clone();
            let (s, i) = (slug.to_string(), id.to_string());
            let still = move || me.rewind_blocked(&s, &i, true);
            let r = block(rewind::apply_rewind(dir.as_deref(), id, &uuid, &text, &at, &file, files, &sid, &still)).map_err(|e| match e {
                rewind::RewindError::Refused(m) => (409, m),
                rewind::RewindError::Failed(m) => (500, m),
            })?;
            let mut undo = r.undo.clone();
            undo.insert("messages".into(), json!(messages));
            runs.rewound(slug, id, r.cut.empty, Some(undo)).map_err(run_err)?;
            let saved = r.restored == 0 || r.undo.get("before").is_some_and(|v| !v.is_null());
            Ok(Reply::Json(200, json!({ "text": text, "restored": r.restored, "messages": messages, "files": r.restored, "undo": true, "filesSaved": saved })))
        }
        ["rewind-undo"] => {
            // Undo the last rewind: the chat (and the files it changed back) as they were just before it.
            if req.run.is_some() {
                return Err((403, "Undo rewind is the user's click, not a board run's".into()));
            }
            if m == "POST" {
                user_only(req, "Undo rewind")?;
            }
            let b = if m == "POST" { body_obj(req)? } else { Map::new() };
            let files = if m == "POST" { b.get("files") != Some(&Value::Bool(false)) } else { query(req, "files").as_deref() != Some("0") };
            if m == "GET" {
                let t = runs.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
                let u = t.get("rewindUndo").filter(|v| !v.is_null());
                let blocked = runs.undo_rewind_blocked(slug, id, files, false);
                let num = |k: &str| u.and_then(|u| u.get(k)).cloned().filter(|v| !v.is_null()).unwrap_or(json!(0));
                let saved = u.and_then(|u| u.get("before")).is_some_and(|v| crate::runs::js::truthy(Some(v)));
                return Ok(Reply::Json(200, json!({ "available": u.is_some(), "blocked": blocked, "messages": num("messages"), "files": num("files"), "filesSaved": saved })));
            }
            let r = runs.undo_rewind(slug, id, files).map_err(run_err)?;
            Ok(Reply::Json(200, r))
        }
        ["fork"] => {
            // Fork from here: a new ticket like Branch whose chat ends just before this message of the user's.
            if req.run.is_some() {
                return Err((403, "Fork is the user's click, not a board run's".into()));
            }
            user_only(req, "Fork from here")?;
            let b = body_obj(req).unwrap_or_default();
            let uuid = match b.get("uuid") {
                None | Some(Value::Null) => String::new(),
                Some(v) => crate::runs::js::to_string(v),
            };
            let Some((_, entry, _)) = rewind_entry(runs, slug, id, &uuid) else {
                return Err((404, "The chat can't be forked from this message.".into()));
            };
            let (t, warning) = runs.fork_ticket(slug, id, &uuid).map_err(|e| if e.is_conflict() { (409, e.message) } else { (400, e.message) })?;
            Ok(Reply::Json(201, json!({ "id": t.id, "text": text_of(&entry, "text"), "ticket": w.view_pub(slug, &t), "warning": warning })))
        }
        _ => Err((404, "not found".into())),
    }
}

/// `GET /api/profiles/:p/commands`: skills and commands in the board's folder (the `/` picker of new ticket and
/// schedule descriptions).
pub fn board_commands(profile: &Map<String, Value>) -> Reply {
    let path = profile.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    let list = super::commands::list_commands(&path, std::slice::from_ref(&path));
    Reply::Json(200, Value::Array(list.iter().map(|c| c.view()).collect()))
}
