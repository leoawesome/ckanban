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

    /// The board's "One ticket at a time in my folder" setting (`folderTurns`, off unless the user turned it on).
    pub fn folder_turns(&self, slug: &str) -> bool {
        super::prompt::folder_turns_on(self.profile(slug).as_ref())
    }

    /// `folderBusy`: another ticket on the board edits the folder `t` would edit in place. Only on a board with
    /// "One ticket at a time in my folder" on: otherwise tickets share the folder, like several Claude Code windows.
    pub fn folder_busy(&self, slug: &str, t: &Tk) -> bool {
        if t.main || !self.folder_turns(slug) {
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

    /// The other tickets running in the board's folder in place at the same time as `t`'s run, for its card: None
    /// unless `t` runs and edits the folder in place on a board without "One ticket at a time in my folder".
    /// Only looks at the live runs (a handful), never at every ticket.
    pub fn folder_sharers(&self, slug: &str, t: &Tk) -> Option<Vec<Arc<Tk>>> {
        let run = self.run_of(slug, &t.id)?;
        if !self.run_may_edit(&run) || self.runs_in_folder(slug, t) == Some(false) || self.folder_turns(slug) {
            return None;
        }
        let others: Vec<Arc<Tk>> = self
            .runs_list()
            .into_iter()
            .filter(|r| r.slug == slug && r.id != t.id && self.run_may_edit(r))
            .filter_map(|r| self.get(slug, &r.id))
            .filter(|o| self.runs_in_folder(slug, o) != Some(false))
            .collect();
        (!others.is_empty()).then_some(others)
    }

    /// The card's `folderShare`: `{others, offer, path?}` when `t`'s run shares the folder with other running tickets.
    /// `offer`: the folder has no version history and `t` is the newest of those cards (it shows the offer to turn
    /// version history on, once).
    pub fn folder_share(&self, slug: &str, t: &Tk) -> Value {
        let Some(others) = self.folder_sharers(slug, t) else { return Value::Null };
        let no_history = matches!(self.git.repo_state(slug), Some(crate::git::repo::RepoKind::Plain | crate::git::repo::RepoKind::Empty));
        let offer = no_history && newest(t, &others);
        let mut v = json!({ "others": others.len(), "offer": offer });
        // The folder the offer turns version history on for (`POST /api/version-history` takes its path).
        if offer && let Some(p) = self.profile(slug).and_then(|p| p.get("path").cloned()) {
            v["path"] = p;
        }
        v
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

/// `t` is the newest ticket of the group (latest `createdAt`, then the larger id).
pub(crate) fn newest(t: &Tk, others: &[Arc<Tk>]) -> bool {
    let key = |x: &Tk| (x.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string(), x.id.clone());
    let mine = key(t);
    others.iter().all(|o| key(o) < mine)
}

#[cfg(test)]
mod tests {
    use parking_lot::Mutex;
    use serde_json::Map;
    use tokio::sync::watch;

    use super::super::board::{RunLoopDeps, RunLoopOptions, RunSt};
    use super::super::types::ChatOptions;
    use super::*;
    use crate::api::StandIn;
    use crate::core::{Core, Services};
    use crate::families::Families;
    use crate::git::landing::Git;
    use crate::git::ops::mem::MemBoard;

    struct Board {
        _d: tempfile::TempDir,
        core: Arc<Core>,
        runs: Arc<RunLoop>,
    }

    /// A board on a plain folder (no version history), its tickets editing it in place; `turns`: the board's
    /// "One ticket at a time in my folder" setting (None: never set).
    fn board(turns: Option<bool>) -> Board {
        let d = tempfile::tempdir().unwrap();
        let project = d.path().join("project");
        std::fs::create_dir_all(d.path().join("profiles/b/tickets")).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let mut profile = json!({ "name": "B", "slug": "b", "path": project, "workspace": "folder", "createdAt": "2026-11-01T00:00:00.000Z" });
        if let Some(on) = turns {
            profile["folderTurns"] = on.into();
        }
        std::fs::write(d.path().join("profiles/b/profile.json"), profile.to_string()).unwrap();
        let mem = MemBoard::default();
        mem.profiles.lock().push(profile);
        let core = Core::new(d.path(), Services::stand_ins());
        let git = Git::new(d.path(), Arc::new(mem));
        // A claude that doesn't exist: the runs these tests start end on their own; what counts is that they started.
        let runs = RunLoop::new(RunLoopDeps {
            root: d.path().to_path_buf(),
            tickets: core.tickets.clone(),
            bus: core.bus.clone(),
            families: Families::new(core.tickets.clone(), core.reads.clone()),
            git,
            sessions: Arc::new(StandIn),
            huddles: Arc::new(StandIn),
            browsers: None,
            devices: Arc::new(StandIn),
            satellite: Arc::new(StandIn),
            opts: RunLoopOptions::new("/nonexistent/claude-for-tests"),
        });
        Board { _d: d, core, runs }
    }

    fn ticket(b: &Board, title: &str, fields: Value) -> String {
        let mut m = Map::new();
        m.insert("title".into(), title.into());
        m.insert("body".into(), "".into());
        let id = b.core.tickets.create("b", m).unwrap().id.clone();
        b.core.tickets.patch("b", &id, fields.as_object().unwrap().clone()).unwrap();
        id
    }

    /// A ticket whose run is going now and edits the folder in place (its run never ends in the test).
    fn running(b: &Board, title: &str) -> String {
        let id = ticket(b, title, json!({ "status": "in_progress", "runCount": 1, "sessionStarted": true }));
        let run = Arc::new(ActiveRun { slug: "b".into(), id: id.clone(), no_edit: false, st: Mutex::new(RunSt::default()), done: watch::channel(false).0 });
        b.runs.state.lock().runs.insert(RunLoop::key("b", &id), run);
        id
    }

    /// The run started: `begin` stamped it (the run itself may have ended already).
    fn started(b: &Board, id: &str) -> bool {
        b.core.tickets.get("b", id).is_some_and(|t| t.is("runStartedAt"))
    }

    fn slot_wait(b: &Board, id: &str) -> bool {
        b.core.tickets.get("b", id).is_some_and(|t| t.is("slotWait"))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_folder_turns_two_ready_tickets_start_in_one_dispatch_pass() {
        let b = board(None);
        let one = ticket(&b, "One", json!({ "status": "ready", "order": 1 }));
        let two = ticket(&b, "Two", json!({ "status": "ready", "order": 2 }));
        let r = b.runs.clone();
        tokio::task::spawn_blocking(move || r.dispatch("b")).await.unwrap();
        assert!(started(&b, &one), "first ticket didn't start");
        assert!(started(&b, &two), "second ticket waited for the folder");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_folder_turns_the_second_ticket_waits_for_the_folder() {
        let b = board(Some(true));
        let busy = running(&b, "Busy");
        let next = ticket(&b, "Next", json!({ "status": "ready", "order": 1 }));
        let r = b.runs.clone();
        tokio::task::spawn_blocking(move || r.dispatch("b")).await.unwrap();
        assert!(!started(&b, &next), "it started while another ticket edits the folder");
        let t = b.core.tickets.get("b", &next).unwrap();
        assert!(b.runs.folder_wait("b", &t), "its card should say it waits for the folder");
        assert!(b.runs.folder_share("b", &b.core.tickets.get("b", &busy).unwrap()).is_null(), "no shared-folder pill when tickets take turns");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_folder_turns_a_chat_reply_does_not_queue_behind_another_ticket() {
        let b = board(Some(false));
        running(&b, "Busy");
        let other = ticket(&b, "Other", json!({ "status": "review", "outcome": "done", "runCount": 1, "sessionStarted": true }));
        let r = b.runs.clone();
        let o = other.clone();
        tokio::task::spawn_blocking(move || r.chat("b", &o, "go on", ChatOptions::default())).await.unwrap().unwrap();
        assert!(!slot_wait(&b, &other), "the reply queued for the folder");
        assert!(started(&b, &other), "the reply didn't start a run");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn with_folder_turns_a_chat_reply_queues_behind_another_ticket() {
        let b = board(Some(true));
        running(&b, "Busy");
        let other = ticket(&b, "Other", json!({ "status": "review", "outcome": "done", "runCount": 1, "sessionStarted": true }));
        let r = b.runs.clone();
        let o = other.clone();
        tokio::task::spawn_blocking(move || r.chat("b", &o, "go on", ChatOptions::default())).await.unwrap().unwrap();
        assert!(slot_wait(&b, &other), "the reply should wait for the folder");
        assert_eq!(b.core.tickets.get("b", &other).unwrap().s("lastActivity"), Some(rules::FOLDER_WAIT));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_shared_folder_count_names_the_other_running_tickets() {
        let b = board(None);
        let one = running(&b, "One");
        let lone = b.runs.folder_share("b", &b.core.tickets.get("b", &one).unwrap());
        assert!(lone.is_null(), "alone in the folder: no pill, got {lone}");
        let two = running(&b, "Two");
        let three = running(&b, "Three");
        // A main ticket's run doesn't edit files: it doesn't count.
        let main = ticket(&b, "Main", json!({ "main": true, "status": "in_progress" }));
        b.runs.state.lock().runs.insert(
            RunLoop::key("b", &main),
            Arc::new(ActiveRun { slug: "b".into(), id: main.clone(), no_edit: true, st: Mutex::new(RunSt::default()), done: watch::channel(false).0 }),
        );
        // An idle ticket in the folder doesn't count either.
        ticket(&b, "Idle", json!({ "status": "review", "runCount": 1 }));
        for id in [&one, &two, &three] {
            let v = b.runs.folder_share("b", &b.core.tickets.get("b", id).unwrap());
            assert_eq!(v["others"], json!(2), "{id}: {v}");
        }
        assert!(b.runs.folder_share("b", &b.core.tickets.get("b", &main).unwrap()).is_null());
        // A ticket working on its own copy shares nothing.
        b.core.tickets.patch("b", &three, json!({ "worktree": "/tmp/copy" }).as_object().unwrap().clone()).unwrap();
        assert_eq!(b.runs.folder_share("b", &b.core.tickets.get("b", &one).unwrap())["others"], json!(1));
        assert!(b.runs.folder_share("b", &b.core.tickets.get("b", &three).unwrap()).is_null());
    }

    #[test]
    fn the_newest_card_of_the_group_offers_version_history() {
        let tk = |id: &str, at: &str| Arc::new(Tk::from_json(json!({ "id": id, "createdAt": at }).as_object().unwrap().clone(), false));
        let a = tk("t_a", "2026-11-20T01:00:00.000Z");
        let b = tk("t_b", "2026-11-20T02:00:00.000Z");
        assert!(newest(&b, std::slice::from_ref(&a)));
        assert!(!newest(&a, std::slice::from_ref(&b)));
        let c = tk("t_c", "2026-11-20T02:00:00.000Z");
        assert!(newest(&c, &[a.clone(), b.clone()]), "same time: the larger id");
    }
}
