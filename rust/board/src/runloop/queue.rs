//! The message queue (`src/board/board-queue.ts`): steering a live run, messages Claude hasn't read yet, sending,
//! editing and discarding a held message, a repeated form answer, and the Planning interview's start.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::{ActiveRun, RunError, RunLoop, corrupt, msg_id, msg_state, now_iso, obj, queued_of, ts};
use super::rules;
use super::types::ChatOptions;
use crate::index::ticket::Tk;
use crate::quickchat::text::localize_attachments;
use crate::runs::js;

impl RunLoop {
    /// `waiting`: messages Claude has not read yet.
    pub fn waiting(&self, slug: &str, id: &str) -> Vec<Map<String, Value>> {
        self.get(slug, id).map(|t| queued_of(&t).into_iter().filter(|m| msg_state(m) == "queued").collect()).unwrap_or_default()
    }

    /// `dropQueued`.
    pub fn drop_queued(&self, slug: &str, id: &str, ids: &[String]) -> Option<Arc<Tk>> {
        let ids: Vec<String> = ids.to_vec();
        self.tickets
            .update_with(slug, id, move |meta| {
                let q: Vec<Value> = meta.get("queued").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter(|m| !ids.iter().any(|i| m.get("id").and_then(Value::as_str) == Some(i))).collect();
                Ok(obj(json!({ "queued": q })))
            })
            .ok()
    }

    /// `steer`: hand a queued message to the live claude process; false when there is none to take it yet.
    pub(super) fn steer(&self, run: &Arc<ActiveRun>, msg: &Map<String, Value>) -> bool {
        let id = msg_id(msg).to_string();
        let b = |k: &str| js::truthy(msg.get(k));
        let slash = msg.get("slash").and_then(Value::as_str).map(str::to_string);
        let text_in = msg.get("text").and_then(Value::as_str).unwrap_or("");
        let dir = self.root.join("attachments");
        let handle = {
            let st = run.st.lock();
            if st.in_flight.iter().any(|(m, _)| *m == id) || st.prompt_msg_id.as_deref() == Some(&id) {
                return true;
            }
            st.handle.clone()
        };
        let text = if slash.is_some() {
            crate::quickchat::text::localize_urls(text_in, &dir)
        } else if b("peer") || b("hostWake") || b("followUp") {
            localize_attachments(text_in, &dir)
        } else {
            localize_attachments(&crate::prompts::chat::steer_prompt(text_in), &dir)
        };
        let Some(h) = handle else { return false };
        if !h.send(&text, slash.as_deref() == Some("local")) {
            return false;
        }
        if slash.as_deref() == Some("local") {
            self.drop_queued(&run.slug, &run.id, &[id]);
        } else {
            run.st.lock().in_flight.push((id, text));
        }
        let mut st = run.st.lock();
        if !b("peer") && !b("fromPlanner") && !b("hostWake") && !b("followUp") && slash.is_none() {
            st.user_steered = true;
        }
        if js::truthy(msg.get("telegram")) && st.telegram_from.is_none() {
            let spent = st.spend.clone().map(|s| super::once::spent_with(&s)).unwrap_or(0.0);
            st.telegram_from = Some(spent);
        }
        true
    }

    /// `delivered`: Claude echoed a user message back: it has read it, so it leaves the queue.
    pub(super) fn delivered(&self, run: &Arc<ActiveRun>, text: &str) {
        let msg = {
            let mut st = run.st.lock();
            match st.in_flight.iter().position(|(_, sent)| sent == text) {
                Some(i) => Some(st.in_flight.remove(i).0),
                None => st.prompt_msg_id.take(),
            }
        };
        if let Some(m) = msg {
            self.drop_queued(&run.slug, &run.id, &[m]);
        }
    }

    /// `held`: a queued message the user can still change.
    pub fn held(&self, slug: &str, id: &str, msg: &str) -> Result<Map<String, Value>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other("message not found"))?;
        let m = queued_of(&t).into_iter().find(|m| msg_id(m) == msg).ok_or_else(|| RunError::other("message not found"))?;
        if msg_state(&m) == "unsent" {
            return Ok(m);
        }
        if js::truthy(m.get("peer")) || self.is_running(slug, id) {
            return Err(RunError::conflict("message is already on its way to Claude"));
        }
        Ok(m)
    }

    /// `sendQueued`: a message left unsent by Stop, sent as if the user typed it now.
    pub fn send_queued(&self, slug: &str, id: &str, msg: &str) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other("message not found"))?;
        let m = queued_of(&t).into_iter().find(|m| msg_id(m) == msg).ok_or_else(|| RunError::other("message not found"))?;
        if msg_state(&m) != "unsent" {
            return Err(RunError::conflict("message is already on its way to Claude"));
        }
        self.drop_queued(slug, id, &[msg.to_string()]);
        let text = m.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        self.chat(slug, id, &text, ChatOptions::of_message(&m))
    }

    /// `discardQueued`.
    pub fn discard_queued(&self, slug: &str, id: &str, msg: &str) -> Result<Arc<Tk>, RunError> {
        self.held(slug, id, msg)?;
        let t = self.drop_queued(slug, id, &[msg.to_string()]).ok_or_else(|| RunError::other("message not found"))?;
        if t.is("slotWait") && self.waiting(slug, id).is_empty() {
            return Ok(self.tickets.cancel_slot_wait(slug, id)?);
        }
        Ok(t)
    }

    /// `editQueued`: fix a message Claude hasn't received yet; it keeps its place.
    pub fn edit_queued(&self, slug: &str, id: &str, msg: &str, text: &str) -> Result<Arc<Tk>, RunError> {
        if js::trim(text).is_empty() {
            return Err(RunError::other("message is empty"));
        }
        self.held(slug, id, msg)?;
        let (m, text) = (msg.to_string(), text.to_string());
        Ok(self.tickets.update_with(slug, id, move |meta| {
            let q: Vec<Value> = meta
                .get("queued")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|mut x| {
                    if x.get("id").and_then(Value::as_str) == Some(&m) {
                        x["text"] = Value::String(text.clone());
                    }
                    x
                })
                .collect();
            Ok(obj(json!({ "queued": q })))
        })?)
    }

    /// `repeatedAnswer`: the same form answer twice within a short time is sent once.
    pub(super) fn repeated_answer(&self, slug: &str, id: &str, t: &Tk, text: &str, opts: &ChatOptions) -> bool {
        if opts.peer || opts.host_wake || opts.follow_up || opts.from_planner || !text.starts_with(rules::ANSWER_PREFIX) {
            return false;
        }
        let key = RunLoop::key(slug, id);
        let now = self.now();
        let norm = js::trim(text).to_string();
        let mut st = self.state.lock();
        st.recent_answers.retain(|_, (_, at)| now - *at < rules::ANSWER_REPEAT_MS);
        let recent = st.recent_answers.get(&key).is_some_and(|(t, _)| *t == norm);
        if recent || queued_of(t).iter().any(|m| msg_state(m) == "queued" && m.get("text").and_then(Value::as_str).map(js::trim) == Some(norm.as_str())) {
            eprintln!("board: {slug}/{id}: the same form answer came again within {}s; sent once", rules::ANSWER_REPEAT_MS / 1000.0);
            return true;
        }
        st.recent_answers.insert(key, (norm, now));
        false
    }

    /// `autoRefine`: entering Planning starts the interview once, without a click.
    pub fn auto_refine(&self, slug: &str, id: &str) {
        let _g = self.decide.lock();
        let Some(t) = self.get(slug, id) else { return };
        if t.status != "planning" || t.is("refineStarted") || self.is_running(slug, id) || self.shutting_down() || corrupt(&t) {
            return;
        }
        if t.is("workdir") || (t.is("sessionStarted") && ts(&t, "sessionId").is_some_and(|s| self.session_exists(s))) {
            return;
        }
        if self.restart_pending() {
            self.patch_quiet(slug, id, obj(json!({ "refineStarted": true, "interrupted": { "at": now_iso(), "mode": "refine", "prompt": { "text": "" }, "held": true } })));
            return;
        }
        let chat = super::types::Chat { text: String::new(), mode: "refine".into(), ..Default::default() };
        self.start(slug, id, Some(chat), None);
    }
}
