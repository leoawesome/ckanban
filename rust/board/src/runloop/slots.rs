//! Runs, slots and dispatch (`src/board/board-devices.ts`) and the folder rules of `src/board/board-repo.ts`
//! (`runsInFolder`, `folderBusy`, `runMayEdit`, `folderWait`): who runs, who waits for the folder, what starts next.

use std::sync::Arc;

use serde_json::{Value, json};

use super::board::{ActiveRun, RunError, RunLoop, corrupt, now_iso, obj};
use super::rules;
use crate::index::ticket::Tk;

impl RunLoop {
    pub fn is_running(&self, slug: &str, id: &str) -> bool {
        self.state.lock().runs.contains_key(&RunLoop::key(slug, id))
    }

    /// `holdsSlot`: the ticket's run is a working run (see `takes_slot`).
    pub fn holds_slot(&self, slug: &str, id: &str) -> bool {
        match self.run_of(slug, id) {
            Some(r) => rules::takes_slot(r.st.lock().chat.as_ref(), r.no_edit),
            None => false,
        }
    }

    fn runs_list(&self) -> Vec<Arc<ActiveRun>> {
        self.state.lock().runs.values().cloned().collect()
    }

    /// `running`: working runs on the board.
    pub fn running_count(&self, slug: &str) -> usize {
        self.runs_list().iter().filter(|r| r.slug == slug && rules::takes_slot(r.st.lock().chat.as_ref(), r.no_edit)).count()
    }

    /// `runningKey`: the board's tickets with a run now, one string that changes when one starts or stops.
    pub fn running_key(&self, slug: &str) -> String {
        let mut ids: Vec<String> = self
            .runs_list()
            .iter()
            .filter(|r| r.slug == slug)
            .map(|r| format!("{}{}", r.id, if rules::takes_slot(r.st.lock().chat.as_ref(), r.no_edit) { "" } else { "~" }))
            .collect();
        ids.sort();
        ids.join(",")
    }

    /// Every ticket with a run now, as (board, ticket id).
    pub fn running_tickets(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self.runs_list().iter().map(|r| (r.slug.clone(), r.id.clone())).collect();
        v.sort();
        v
    }

    /// `isPeerRun`: the current run is a quiet reply to another session's message.
    pub fn is_peer_run(&self, slug: &str, id: &str) -> bool {
        self.run_of(slug, id).is_some_and(|r| r.st.lock().chat.as_ref().is_some_and(|c| c.quiet))
    }

    /// `runsInFolder` with the board's cached repo state.
    pub fn runs_in_folder(&self, slug: &str, t: &Tk) -> Option<bool> {
        self.git.runs_in_folder(slug, &Value::Object(t.json.clone()))
    }

    /// `runMayEdit`: not a main ticket's run, and not a Planning chat's (except a tool ticket's).
    fn run_may_edit(&self, r: &ActiveRun) -> bool {
        if r.no_edit {
            return false;
        }
        if !r.st.lock().chat.as_ref().is_some_and(|c| c.refine()) {
            return true;
        }
        self.get(&r.slug, &r.id).is_some_and(|t| t.tool)
    }

    /// `folderBusy`: another ticket on the board edits the folder `t` would edit in place.
    pub fn folder_busy(&self, slug: &str, t: &Tk) -> bool {
        if t.main {
            return false;
        }
        if self.runs_in_folder(slug, t) == Some(false) {
            return false;
        }
        for r in self.runs_list() {
            if r.slug != slug || r.id == t.id || !self.run_may_edit(&r) {
                continue;
            }
            if let Some(o) = self.get(slug, &r.id)
                && self.runs_in_folder(slug, &o) != Some(false)
            {
                return true;
            }
        }
        let list = self.tickets.list(slug);
        list.tickets.iter().any(|o| o.id != t.id && o.is("autoHuddle") && !self.is_running(slug, &o.id) && self.runs_in_folder(slug, o) != Some(false))
    }

    /// `folderWait`: for the card: it would start now but the folder is in use.
    pub fn folder_wait(&self, slug: &str, t: &Tk) -> bool {
        if self.is_running(slug, &t.id) {
            return false;
        }
        let parent_active = t.parent_id.as_deref().and_then(|p| self.get(slug, p)).is_some_and(|p| crate::index::attention::plan_active(&p));
        let next = t.status == "ready" || t.is("slotWait") || (t.status == "backlog" && !t.is("waitsForStart") && parent_active);
        next && self.folder_busy(slug, t)
    }

    /// `dispatch`: replies waiting for a slot first (oldest first), then Ready tickets in order.
    pub fn dispatch(&self, slug: &str) {
        let _g = self.decide.lock();
        if self.restart_pending() || self.shutting_down() {
            return;
        }
        let Some(profile) = self.profile(slug) else { return };
        if !profile.get("path").and_then(Value::as_str).is_some_and(|p| std::path::Path::new(p).exists()) {
            return;
        }
        let list = self.tickets.list(slug);
        let idle: Vec<Arc<Tk>> = list.tickets.iter().filter(|t| !corrupt(t) && !self.is_running(slug, &t.id)).cloned().collect();
        let mut waiting: Vec<Arc<Tk>> = idle.iter().filter(|t| t.is("slotWait")).cloned().collect();
        waiting.sort_by(|a, b| a.slot_wait.as_deref().unwrap_or("").cmp(b.slot_wait.as_deref().unwrap_or("")));
        for t in waiting {
            let Some(next) = self.waiting(slug, &t.id).into_iter().next() else {
                let _ = self.tickets.cancel_slot_wait(slug, &t.id);
                continue;
            };
            let from = t.get("slotWait").and_then(|s| s.get("from")).cloned().unwrap_or(Value::Null);
            let b = |k: &str| crate::runs::js::truthy(next.get(k));
            let chat = if b("peer") || b("hostWake") {
                rules::chat_for(&t.json, &next)
            } else if b("followUp") {
                rules::chat_for(from.as_object().unwrap_or(&Default::default()), &next)
            } else {
                let mut c = rules::chat_for(&t.json, &next);
                c.mode = "act".into();
                c.from = Some((from.get("status").and_then(Value::as_str).unwrap_or("").to_string(), from.get("outcome").cloned().unwrap_or(Value::Null)));
                c
            };
            if chat.act() && self.folder_busy(slug, &t) {
                continue;
            }
            if self.patch(slug, &t.id, obj(json!({ "slotWait": null }))).is_err() {
                continue;
            }
            self.start(slug, &t.id, Some(chat), Some(super::board::msg_id(&next).to_string()));
        }
        let mut ready: Vec<Arc<Tk>> = idle.iter().filter(|t| t.status == "ready").cloned().collect();
        ready.sort_by(|a, b| a.order.partial_cmp(&b.order).unwrap_or(std::cmp::Ordering::Equal));
        for t in ready {
            // Read again: an earlier start in this pass may have changed it.
            if self.is_running(slug, &t.id) {
                continue;
            }
            if self.folder_busy(slug, &t) {
                continue;
            }
            self.start(slug, &t.id, None, None);
        }
    }

    /// `waitForSlot`: the card waits in In Progress with its queued message(s) until `dispatch` starts it.
    pub fn wait_for_slot(&self, slug: &str, id: &str) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let slot_wait = t
            .get("slotWait")
            .filter(|v| crate::runs::js::truthy(Some(v)))
            .cloned()
            .unwrap_or_else(|| json!({ "at": now_iso(), "from": { "status": t.status, "outcome": t.get("outcome").cloned().unwrap_or(Value::Null) } }));
        self.patch(slug, id, obj(json!({ "status": "in_progress", "outcome": null, "error": null, "lastActivity": rules::FOLDER_WAIT, "slotWait": slot_wait })))
    }

    /// `stopWorkflow`: stop one workflow of the ticket's run and let the run go on (or the whole run, if Claude Code
    /// can't stop just the workflow).
    pub async fn stop_workflow(self: &Arc<Self>, slug: &str, id: &str, task_id: &str) -> Result<Value, RunError> {
        let r = self.run_of(slug, id);
        let handle = r.as_ref().and_then(|r| r.st.lock().handle.clone());
        let (Some(r), Some(h)) = (r, handle) else { return Err(RunError::other("this ticket isn't running")) };
        match h.stop_task(task_id).await {
            Ok(()) => {
                h.send(rules::WORKFLOW_STOPPED_TEXT, false);
                let me = self.clone();
                let (s, i) = (slug.to_string(), id.to_string());
                let _ = tokio::task::spawn_blocking(move || {
                    me.note(&s, &i, "Workflow stopped by user. The run goes on.");
                    me.emit_ticket(&s, &i);
                })
                .await;
                Ok(json!({ "stopped": "workflow" }))
            }
            Err(e) => {
                let me = self.clone();
                let _ = tokio::task::spawn_blocking(move || me.stop_run(&r)).await;
                Ok(json!({ "stopped": "run", "error": e }))
            }
        }
    }
}
