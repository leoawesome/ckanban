//! `ChatExtras`: "Say it simpler", "Help me understand" and the Context panel for tickets and quick chats, and the
//! ticket routes for them (Bun's `ticket-files.ts` `simplified`, `simplify`, `help` and `ticket-info.ts` `context`).
//! The ticket routes run inside `tickets::routes::Writes::answer`, after its gate, on a blocking thread; the ticket
//! exists. The quick chat ones are in `quickchat::routes`.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use serde_json::{Map, Value, json};

use super::context::{CONTEXT_TIMEOUT_MS, ContextOptions, ContextSpec, ContextUsage};
use super::explain::{self, HELP_KINDS, Helper};
use super::simplify::Simplifier;
use crate::bus::Bus;
use crate::extras::SideFn;
use crate::huddles::Huddles;
use crate::quickchat::service::QuickChats;
use crate::runloop::RunLoop;
use crate::runs::js;
use crate::sessions::service::Sessions;
use crate::tickets::routes::{Reply, Req, body_obj, user_only_refusal};
use crate::tickets::writer::{Refusal, Tickets, bad, block};

pub struct ChatExtras {
    pub tickets: Arc<Tickets>,
    pub sessions: Arc<Sessions>,
    pub huddles: Arc<Huddles>,
    pub chats: Arc<QuickChats>,
    pub simplifier: Arc<Simplifier>,
    pub helper: Arc<Helper>,
    pub contexts: Arc<ContextUsage>,
    runs: OnceLock<Arc<RunLoop>>,
}

/// The paths after `/api/profiles/:p/tickets/:id/` these routes take.
pub fn wanted(method: &str, rest: &[&str]) -> bool {
    matches!((method, rest), ("GET", ["simplified"]) | ("POST", ["simplify"]) | ("GET" | "POST", ["help" | "context"]))
}

impl ChatExtras {
    pub fn new(tickets: Arc<Tickets>, sessions: Arc<Sessions>, huddles: Arc<Huddles>, chats: Arc<QuickChats>, bus: Arc<Bus>, side: SideFn) -> Arc<Self> {
        let (t2, c2) = (tickets.clone(), chats.clone());
        let contexts = ContextUsage::new(ContextOptions {
            claude_bin: std::env::var("CKANBAN_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()),
            timeout_ms: CONTEXT_TIMEOUT_MS,
            // Saved next to the ticket's or chat's own files, only while it exists (a delete takes the file with it).
            file: Arc::new(move |key: &str| {
                let mut p = key.splitn(3, '/');
                let (kind, slug, id) = (p.next()?, p.next()?, p.next()?);
                if kind == "chat" {
                    c2.get(slug, id).is_some().then(|| c2.context_path(slug, id))
                } else {
                    t2.get(slug, id).is_some().then(|| t2.ticket_dir(slug, id).join("context.json"))
                }
            }),
            changed: Arc::new(move |key: &str| {
                let mut p = key.splitn(3, '/');
                let (Some(kind), Some(slug), Some(id)) = (p.next(), p.next(), p.next()) else { return };
                bus.emit_json(json!({ "type": "context.updated", "profile": slug, "kind": kind, "id": id }));
            }),
            max_background: 2,
        });
        let x = Arc::new(ChatExtras {
            tickets,
            sessions,
            huddles,
            chats,
            simplifier: Simplifier::new(side.clone()),
            helper: Helper::new(side),
            contexts,
            runs: OnceLock::new(),
        });
        let _ = x.chats.extras.set(Arc::downgrade(&x));
        x
    }

    /// The run loop: the ticket Context panel's spec and whether a ticket runs (recap). Also hooks the background
    /// Context checks after every run of a ticket and of a quick chat (`contextAfterRun`).
    pub fn set_runs(self: &Arc<Self>, runs: Arc<RunLoop>) {
        let me = self.clone();
        let r = runs.clone();
        runs.on_run_end(Arc::new(move |slug: &str, id: &str| {
            if let Some(s) = r.context_spec(slug, id) {
                me.contexts.schedule(&format!("ticket/{slug}/{id}"), s);
            }
        }));
        let me = self.clone();
        self.chats.on_run_end(Arc::new(move |slug: &str, id: &str| {
            if let Ok(Some(s)) = me.chats.context_spec(slug, id) {
                me.contexts.schedule(&format!("chat/{slug}/{id}"), s);
            }
        }));
        let _ = self.runs.set(runs);
    }

    fn ticket_file(&self, slug: &str, id: &str, name: &str) -> PathBuf {
        self.tickets.ticket_dir(slug, id).join(name)
    }

    /// `chatEntries`: chats left behind with "Send in a fresh chat" (no rewinding into them), each followed by a note,
    /// then the current chat. Blocking (reads transcripts).
    pub fn chat_entries(&self, t: &Map<String, Value>) -> Vec<Value> {
        let cache = &self.sessions.cache;
        let current = t.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(|s| cache.get(s)).map(|p| (*p.entries).clone()).unwrap_or_default();
        let earlier = t.get("earlierSessions").and_then(Value::as_array).cloned().unwrap_or_default();
        if earlier.is_empty() {
            return current;
        }
        let mut all = Vec::new();
        for s in &earlier {
            let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("");
            if let Some(p) = cache.get(sid) {
                for e in p.entries.iter() {
                    let mut e = e.clone();
                    if let Some(o) = e.as_object_mut() {
                        o.shift_remove("rewind");
                    }
                    all.push(e);
                }
            }
            all.push(json!({
                "uuid": format!("fresh-chat-{sid}"), "at": s.get("endedAt").cloned().unwrap_or(Value::Null), "role": "assistant", "kind": "board",
                "text": "Fresh chat from here: Claude no longer reads the messages above, but can look them up.",
            }));
        }
        all.extend(current);
        all
    }

    /// The current session's entries only (`sessions.get(t.sessionId)?.entries ?? []`).
    fn current_entries(&self, t: &Map<String, Value>) -> Vec<Value> {
        t.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(|s| self.sessions.cache.get(s)).map(|p| (*p.entries).clone()).unwrap_or_default()
    }

    /// `contextRoute`: GET answers the cached result; POST (the user only) checks now, shared with a check already
    /// running, and answers once it is over. `spec` Err: 409 with its text.
    pub fn context_route(
        &self,
        post: bool,
        user: impl FnOnce() -> bool,
        key: &str,
        spec: impl FnOnce() -> Result<Option<ContextSpec>, String>,
        session: impl FnOnce() -> Option<String>,
    ) -> Result<Value, Refusal> {
        if post {
            if !user() {
                return Err(user_only_refusal("Checking a chat's context"));
            }
            let s = spec().map_err(|e| (409, e))?;
            let sid = s.as_ref().map(|s| s.session_id.clone());
            if let Some(s) = s {
                block(self.contexts.refresh(key, s));
            }
            return Ok(self.contexts.view(key, sid.as_deref()));
        }
        Ok(self.contexts.view(key, session().as_deref()))
    }

    /// The ticket routes (`wanted`). Blocking.
    pub fn answer(&self, req: &Req, slug: &str, id: &str, rest: &[&str]) -> Result<Reply, Refusal> {
        let Some(tk) = self.tickets.get(slug, id) else { return Err((404, format!("ticket {id} not found"))) };
        let t = &tk.json;
        let m = req.method.as_str();
        match rest {
            ["context"] => {
                let user = || req.run.is_none() && !req.huddle && (req.user)();
                let runs = self.runs.get().cloned();
                let r2 = runs.clone();
                let v = self.context_route(
                    m == "POST",
                    user,
                    &format!("ticket/{slug}/{id}"),
                    || Ok(runs.and_then(|r| r.context_spec(slug, id))),
                    || r2.and_then(|r| r.context_session(slug, id)),
                )?;
                Ok(Reply::Json(200, v))
            }
            ["simplified"] => Ok(Reply::Json(200, self.simplifier.saved_in(&self.ticket_file(slug, id, "simplified.json"), &self.chat_entries(t)))),
            ["simplify"] => {
                if req.run.is_some() {
                    return Err((403, "Say it simpler is the user's click, not a board run's".into()));
                }
                let b = body_obj(req)?;
                let entries = self.chat_entries(t);
                let e = b.get("uuid").and_then(Value::as_str).and_then(|u| entries.iter().find(|x| x.get("uuid").and_then(Value::as_str) == Some(u)));
                let Some(e) = e else { return Err((404, "no such message in this ticket's conversation".into())) };
                let title = tk.title.clone();
                let v = block(self.simplifier.simplify_in(self.ticket_file(slug, id, "simplified.json"), self.ticket_file(slug, id, "side-spend.jsonl"), &title, e))?;
                Ok(Reply::Json(200, v))
            }
            ["help"] if m == "GET" => {
                let entries = self.current_entries(t);
                let file = self.ticket_file(slug, id, "help.json");
                Ok(Reply::Json(200, json!({ "cards": self.helper.cards(&file), "busy": self.helper.busy(&file), "recap": explain::recap_available(&entries) })))
            }
            ["help"] => {
                if req.run.is_some() {
                    return Err((403, "Help me understand is the user's click, not a board run's".into()));
                }
                let b = body_obj(req)?;
                let Some(kind) = b.get("kind").and_then(Value::as_str).and_then(|k| HELP_KINDS.into_iter().find(|x| *x == k)) else {
                    return Err(bad(format!("kind must be one of: {}", HELP_KINDS.join(", "))));
                };
                let entries = self.current_entries(t);
                let profile = ckanban_core::DataDir::new(self.tickets.root.clone()).profile(slug).map(|p| p.record.0).unwrap_or_default();
                let prompt = if kind == "recap" {
                    if !explain::recap_available(&entries) {
                        return Err(bad("nothing happened since your last message"));
                    }
                    let findings: Vec<Value> = self
                        .huddles
                        .list(slug, Some(id), false)
                        .iter()
                        .flat_map(|h| h.get("findings").and_then(Value::as_array).cloned().unwrap_or_default())
                        .collect();
                    let running = self.runs.get().is_some_and(|r| r.is_running(slug, id));
                    explain::recap_prompt(t, &entries, &findings, running)
                } else {
                    let path = PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
                    let diff = block(crate::git::routes::changes(&Value::Object(profile.clone()), &path, &Value::Object(t.clone()), false)).map_err(|e| (e.status, e.message))?;
                    if diff.files.is_empty() {
                        return Err(bad(diff.note.clone().unwrap_or_else(|| "this ticket has no changed files".into())));
                    }
                    explain::changes_prompt(t, &entries, &diff)
                };
                let str_of = |k: &str| t.get(k).and_then(Value::as_str).map(str::to_string);
                let cwd = str_of("worktree")
                    .or_else(|| str_of("workdir"))
                    .or_else(|| js::truthy(t.get("baseSha")).then(|| profile.get("path").and_then(Value::as_str).unwrap_or("").to_string()))
                    .map(PathBuf::from);
                let v = block(self.helper.ask(self.ticket_file(slug, id, "help.json"), self.ticket_file(slug, id, "side-spend.jsonl"), kind, prompt, cwd))?;
                Ok(Reply::Json(200, v))
            }
            _ => Err((404, "not found".into())),
        }
    }
}
