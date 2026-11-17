//! The run loop plugged into the rest of the Rust board: `api::RunControl` (who runs; `LateRuns` lets the services
//! made before the loop ask it), R2b's `families::PlanRuns` (plan wakes, dispatch, the Planning interview), the run
//! half of the ticket writes' `BoardHooks` (`RunHooks`, used by `tickets::wiring::Wired`), and `api::BoardActions`
//! (what the Bun satellite asks of the board: Telegram messages and marks, comments).

use std::sync::{Arc, OnceLock};

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::board::{RunLoop, now_iso, obj, queued_of};
use super::rules::TELEGRAM_KEEP;
use super::types::{Chat, ChatOptions};
use crate::api::{BoardActions, Failure, RunControl};
use crate::families::PlanRuns;
use crate::tickets::hooks::RunState;

/// `RunControl` for services made before the run loop: answers "nothing running" until `set` is called.
#[derive(Default)]
pub struct LateRuns {
    runs: OnceLock<Arc<RunLoop>>,
}

impl LateRuns {
    pub fn new() -> Arc<LateRuns> {
        Arc::new(LateRuns::default())
    }
    pub fn set(&self, r: Arc<RunLoop>) {
        let _ = self.runs.set(r);
    }
    pub fn get(&self) -> Option<&Arc<RunLoop>> {
        self.runs.get()
    }
}

impl RunControl for LateRuns {
    fn is_running(&self, slug: &str, id: &str) -> bool {
        self.get().is_some_and(|r| r.is_running(slug, id))
    }
    fn running_key(&self, slug: &str, _id: &str) -> Option<String> {
        self.get().map(|r| r.running_key(slug))
    }
    fn holds_slot(&self, slug: &str, id: &str) -> bool {
        self.get().is_some_and(|r| r.holds_slot(slug, id))
    }
    fn start(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<(), Failure>> {
        let r = self.get().cloned();
        let (slug, id) = (slug.to_string(), id.to_string());
        Box::pin(async move {
            let Some(r) = r else { return Err("the board is still starting".into()) };
            match tokio::task::spawn_blocking(move || r.start(&slug, &id, None, None)).await {
                Ok(None) => Ok(()),
                Ok(Some(e)) => Err(e),
                Err(e) => Err(e.to_string()),
            }
        })
    }
    fn stop(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<(), Failure>> {
        let r = self.get().cloned();
        let (slug, id) = (slug.to_string(), id.to_string());
        Box::pin(async move {
            if let Some(r) = r {
                let _ = tokio::task::spawn_blocking(move || r.stop(&slug, &id)).await;
            }
            Ok(())
        })
    }
    fn chat(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), Failure>> {
        let r = self.get().cloned();
        let (slug, id, text) = (slug.to_string(), id.to_string(), text.to_string());
        Box::pin(async move {
            let Some(r) = r else { return Err("the board is still starting".into()) };
            match tokio::task::spawn_blocking(move || r.chat(&slug, &id, &text, ChatOptions::default())).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(e.message),
                Err(e) => Err(e.to_string()),
            }
        })
    }
    fn active_work(&self) -> Vec<String> {
        self.get().map(|r| r.busy_boards()).unwrap_or_default()
    }
    fn busy_boards(&self) -> Vec<String> {
        self.get().map(|r| r.busy_boards()).unwrap_or_default()
    }
    fn running_tickets(&self) -> Vec<(String, String)> {
        self.get().map(|r| r.running_tickets()).unwrap_or_default()
    }
    fn folder_wait(&self, slug: &str, ticket: &Value) -> bool {
        let Some(r) = self.get() else { return false };
        let Value::Object(m) = ticket else { return false };
        r.folder_wait(slug, &crate::index::ticket::Tk::from_json(m.clone(), false))
    }
}

/// R2b's plans call the loop through this. Each call runs on the caller's thread (a blocking one) unless it says
/// otherwise.
impl PlanRuns for RunLoop {
    fn wake(&self, slug: &str, id: &str, text: String, return_to: Option<String>) {
        let chat = Chat { text, mode: "act".into(), raw: true, return_to, ..Default::default() };
        if let Some(e) = self.start(slug, id, Some(chat), None) {
            eprintln!("[board] plan wake of {slug}/{id}: {e}");
        }
    }
    fn dispatch(&self, slug: &str) {
        RunLoop::dispatch(self, slug);
    }
    fn auto_fresh(&self, slug: &str, id: &str) {
        if let Some(t) = self.tickets.get(slug, id) {
            RunLoop::auto_fresh(self, slug, t);
        }
    }
    fn auto_refine(&self, slug: &str, id: &str) {
        RunLoop::auto_refine(self, slug, id);
    }
    fn notify(&self, title: &str, body: &str, slug: &str, id: &str) {
        // STAND-IN (R13/P1): the notifier's Mac banner lives in the satellite; logged until the edge carries it.
        eprintln!("[board] notify {slug}/{id}: {title}: {body}");
    }
}

/// The run half of the ticket writes' hooks (`tickets::wiring::Wired` calls these).
pub struct RunHooks {
    pub runs: Arc<RunLoop>,
}

impl RunHooks {
    pub fn run_state(&self, slug: &str, id: &str) -> RunState {
        let Some(r) = self.runs.run_of(slug, id) else { return RunState::default() };
        let st = r.st.lock();
        let chat = st.chat.as_ref();
        RunState {
            active: !st.stop_requested,
            chat_mode: chat.map(|c| c.mode.clone()),
            chat_user: chat.is_some_and(|c| c.user),
            chat_slash: chat.is_some_and(|c| c.slash.is_some()),
            chat_quiet: chat.is_some_and(|c| c.quiet),
            user_steered: st.user_steered,
        }
    }

    /// `requestSelfMove`.
    pub fn request_self_move(&self, slug: &str, id: &str, status: &str) -> bool {
        let Some(r) = self.runs.run_of(slug, id) else { return false };
        let s = self.run_state(slug, id);
        if !(s.active && ((s.chat_user && !s.chat_slash) || s.user_steered)) {
            return false;
        }
        r.st.lock().self_move = Some(status.to_string());
        true
    }

    /// The user moved a running ticket: its run stops and ends in `target`; waits for its end.
    pub fn stop_run(&self, slug: &str, id: &str, target: Option<&str>) -> BoxFuture<'static, ()> {
        let r = self.runs.run_of(slug, id);
        let runs = self.runs.clone();
        let target = target.map(str::to_string);
        Box::pin(async move {
            let Some(r) = r else { return };
            r.st.lock().target_status = target;
            let (rl, r2) = (runs.clone(), r.clone());
            let _ = tokio::task::spawn_blocking(move || rl.stop_run(&r2)).await;
            r.finished().await;
        })
    }

    /// A key card's answer goes to a new run (`board.chat(..., {nextRun: true})`).
    pub fn chat_next_run(&self, slug: &str, id: &str, text: &str) -> Result<(), String> {
        self.runs.chat(slug, id, text, ChatOptions { next_run: true, ..Default::default() }).map(|_| ()).map_err(|e| e.message)
    }

    /// `closeForm`: the user closes the open questions form without answering.
    pub fn closes_form(&self, slug: &str, id: &str, uuid: &str) -> Result<Map<String, Value>, (u16, String)> {
        let t = self.runs.tickets.get(slug, id).ok_or((404, format!("ticket {id} not found")))?;
        if self.runs.is_running(slug, id) {
            return Err((409, "Claude is working on this ticket; close the question once it has finished".into()));
        }
        if t.get("closedForms").and_then(|c| c.get(uuid)).is_some_and(|v| crate::runs::js::truthy(Some(v))) {
            return Ok(t.json.clone());
        }
        let open = t.s("sessionId").filter(|s| !s.is_empty()).and_then(|s| self.runs.sessions.summary(s)).and_then(|s| s.get("openFormId").and_then(Value::as_str).map(str::to_string));
        if open.as_deref() != Some(uuid) {
            return Err((409, "This question isn't the one waiting now; reload the page to see the latest question".into()));
        }
        let run = t.get("runEndedAt").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!(""));
        let u = uuid.to_string();
        let t = self
            .runs
            .tickets
            .update_with(slug, id, move |meta| {
                let mut c = meta.get("closedForms").and_then(Value::as_object).cloned().unwrap_or_default();
                c.insert(u, json!({ "at": now_iso(), "by": "user", "run": run }));
                Ok(obj(json!({ "closedForms": c })))
            })?;
        Ok(t.json.clone())
    }
}

/// What the Bun satellite asks of the board (`TelegramBoard` and the notifier's comments).
pub struct RunActions {
    pub runs: Arc<RunLoop>,
}

impl BoardActions for RunActions {
    fn chat_from_telegram(&self, slug: &str, id: &str, text: &str, from: Value) -> BoxFuture<'_, Result<bool, Failure>> {
        let runs = self.runs.clone();
        let (slug, id, text) = (slug.to_string(), id.to_string(), text.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || runs.chat_from_telegram(&slug, &id, &text, &from)).await.map_err(|e| e.to_string())?
        })
    }
    fn patch_telegram(&self, slug: &str, id: &str, patch: Value) -> Result<(), Failure> {
        if self.runs.tickets.get(slug, id).is_none() {
            return Ok(());
        }
        let mut p = Map::new();
        for k in ["telegramIn", "telegramOut", "telegramReport"] {
            if let Some(v) = patch.get(k) {
                p.insert(k.into(), v.clone());
            }
        }
        self.runs.patch(slug, id, p).map(|_| ()).map_err(|e| e.message)
    }
    fn drop_telegram_queued(&self) -> Result<usize, Failure> {
        Ok(self.runs.drop_telegram_queued())
    }
    fn add_comment(&self, slug: &str, id: &str, author: &str, text: &str) -> Result<(), Failure> {
        self.runs.tickets.store_comment(slug, id, author, text, None).map(|_| ()).map_err(|(_, e)| e)
    }
}

impl RunLoop {
    /// `chatFromTelegram`: the user's reply from Telegram, as if typed in the ticket's chat; false when that update
    /// was already sent.
    pub fn chat_from_telegram(&self, slug: &str, id: &str, text: &str, from: &Value) -> Result<bool, Failure> {
        let t = self.get(slug, id).ok_or_else(|| format!("ticket {id} not found"))?;
        let update = from.get("updateId").cloned().unwrap_or(Value::Null);
        let seen_in = t.get("telegramIn").and_then(Value::as_array).is_some_and(|a| a.iter().any(|m| m.get("updateId") == Some(&update)));
        let seen_q = queued_of(&t).iter().any(|m| m.get("telegram").and_then(|g| g.get("updateId")) == Some(&update));
        if seen_in || seen_q {
            return Ok(false);
        }
        let started_by_user = !self.is_running(slug, id);
        let tg = from.get("tg").cloned().unwrap_or(Value::Null);
        let opts = ChatOptions { telegram: Some(json!({ "updateId": update, "tg": tg })), ..Default::default() };
        let after = self.chat(slug, id, text, opts).map_err(|e| e.message)?;
        let at = now_iso();
        let now = self.get(slug, id).unwrap_or(after.clone());
        let mut list = now.get("telegramIn").and_then(Value::as_array).cloned().unwrap_or_default();
        let chat_id = from.get("chatId").cloned().unwrap_or(Value::Null);
        list.push(json!({ "updateId": update, "tg": tg, "chatId": chat_id, "at": at, "text": crate::runs::js::head16(text, 2000), "key": from.get("key").cloned().unwrap_or(Value::Null) }));
        let keep = list.len().saturating_sub(TELEGRAM_KEEP);
        self.patch(slug, id, obj(json!({ "telegramIn": list[keep..].to_vec(), "telegramReport": { "tg": tg, "chatId": chat_id, "at": at } }))).map_err(|e| e.message)?;
        if started_by_user {
            self.tickets.mark_started_by(slug, id, None);
        }
        if !text.starts_with('/') {
            self.user_replied(slug, id);
        }
        if after.tool && !(after.kind.as_deref() == Some("with_you")) {
            self.families.note_user_message(slug, id, text);
        }
        Ok(true)
    }

    /// `dropTelegramQueued`: messages from Telegram that wait in a queue and no run has been handed yet are dropped.
    pub fn drop_telegram_queued(&self) -> usize {
        let mut dropped = 0;
        for slug in self.boards() {
            let list = self.tickets.list(&slug);
            for t in list.tickets.iter() {
                let run = self.run_of(&slug, &t.id);
                let held: Vec<String> = run.as_ref().map(|r| {
                    let st = r.st.lock();
                    let mut v: Vec<String> = st.in_flight.iter().map(|(m, _)| m.clone()).collect();
                    v.extend(st.prompt_msg_id.clone());
                    v
                }).unwrap_or_default();
                let drop: Vec<String> = queued_of(t)
                    .iter()
                    .filter(|m| crate::runs::js::truthy(m.get("telegram")) && !held.iter().any(|h| m.get("id").and_then(Value::as_str) == Some(h)))
                    .map(|m| m.get("id").and_then(Value::as_str).unwrap_or("").to_string())
                    .collect();
                if drop.is_empty() {
                    continue;
                }
                dropped += drop.len();
                self.drop_queued(&slug, &t.id, &drop);
            }
        }
        dropped
    }
}
