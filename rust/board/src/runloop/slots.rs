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
        // Version history is being turned on there: every ticket that would edit it in place waits a moment.
        if self.held_by_switch(slug, t) {
            return true;
        }
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

    /// The live runs on the board with the tickets above each (nearest first), most a handful. In memory only: no
    /// folder or setting is read here, so a card that no run works for costs a few index lookups.
    fn run_chains(&self, slug: &str) -> Vec<Vec<Arc<Tk>>> {
        self.runs_list().into_iter().filter(|r| r.slug == slug).filter_map(|r| self.get(slug, &r.id)).map(|t| self.chain_of(slug, t)).collect()
    }

    /// `t` and the tickets above it (its main ticket, a feature above that...), nearest first.
    fn chain_of(&self, slug: &str, t: Arc<Tk>) -> Vec<Arc<Tk>> {
        let mut v = vec![t];
        while v.len() < 8 {
            let up = v.last().and_then(|x| x.parent_link()).map(|(p, _)| p.to_string());
            match up.and_then(|p| self.get(slug, &p)) {
                Some(u) if !v.iter().any(|x| x.id == u.id) => v.push(u),
                _ => break,
            }
        }
        v
    }

    /// The runs editing the board's folder in place now, as pieces of work: each run's chain and the card it works
    /// for (the nearest ticket in its chain the board shows). The rule of `POST /api/version-history` and
    /// `folder_editors`: any run of a ticket without its own copy, a main ticket's too (its runs can change files).
    /// None on a board with "One ticket at a time in my folder" on, or when nothing above 1 run edits it.
    fn folder_work(&self, slug: &str, chains: Vec<Vec<Arc<Tk>>>) -> Option<Vec<(Vec<Arc<Tk>>, String)>> {
        let work: Vec<(Vec<Arc<Tk>>, String)> = chains
            .into_iter()
            .filter(|c| self.runs_in_folder(slug, &c[0]) != Some(false))
            .map(|c| {
                let card = c.iter().find(|x| x.on_board()).unwrap_or(&c[c.len() - 1]).id.clone();
                (c, card)
            })
            .collect();
        if work.len() < 2 || self.folder_turns(slug) {
            return None;
        }
        Some(work)
    }

    /// The card's `folderShare`: `{others, offer, pending, path?}` when a run of its own piece of work (its own run,
    /// or a run of a task under it) edits the board's folder in place while a run of another piece of work does too.
    /// `others` counts those other pieces of work (other cards), so two user tickets each running a task read
    /// "1 other". `offer`: the folder has no version history and this is the newest of the sharing cards (it shows
    /// the offer to turn version history on, once). Only looks at the live runs, never at every ticket.
    pub fn folder_share(&self, slug: &str, t: &Tk) -> Value {
        if !t.on_board() {
            return Value::Null;
        }
        let chains = self.run_chains(slug);
        if !chains.iter().any(|c| c.iter().any(|x| x.id == t.id)) {
            return Value::Null;
        }
        let Some(work) = self.folder_work(slug, chains) else { return Value::Null };
        let Some(others) = share_count(&work, &t.id) else { return Value::Null };
        let no_history = matches!(self.git.repo_state(slug), Some(crate::git::repo::RepoKind::Plain | crate::git::repo::RepoKind::Empty));
        // The other cards that share the folder too: the newest of all of them shows the offer.
        let mut sharing: Vec<Arc<Tk>> = Vec::new();
        for x in work.iter().flat_map(|(c, _)| c.iter()) {
            if x.id != t.id && x.on_board() && !sharing.iter().any(|s| s.id == x.id) && share_count(&work, &x.id).is_some() {
                sharing.push(x.clone());
            }
        }
        let offer = no_history && newest(t, &sharing);
        let path = self.board_path(slug);
        // The board turns version history on by itself once these tickets have finished (the link was clicked).
        let pending = path.as_deref().is_some_and(|p| crate::git::pending::is_pending(&self.root, p));
        let mut v = json!({ "others": others, "offer": offer, "pending": pending });
        // The folder the offer (or its Cancel) is for (`POST /api/version-history` takes its path).
        if (offer || pending)
            && let Some(p) = path
        {
            v["path"] = p.into();
        }
        v
    }

    /// A run of `id` started or ended: the cards whose `folderShare` may have changed (the ones every run editing the
    /// folder in place works for, and `id`'s own) are sent again, so open pages show the pill appear, change or go.
    /// Nothing is sent when `id` doesn't edit the folder in place or no other run does.
    pub(super) fn share_changed(&self, slug: &str, id: &str) {
        let Some(t) = self.get(slug, id) else { return };
        if self.runs_in_folder(slug, &t) == Some(false) {
            return;
        }
        let mine = self.chain_of(slug, t);
        let others: Vec<Vec<Arc<Tk>>> = self.run_chains(slug).into_iter().filter(|c| c[0].id != id && self.runs_in_folder(slug, &c[0]) != Some(false)).collect();
        if others.is_empty() || self.folder_turns(slug) {
            return;
        }
        self.send_working_cards(slug, Some(mine));
    }

    /// Sends again every card the board's live runs work for (on the board: each run's ticket and the tickets above
    /// it), plus `extra` (a run that just ended), once each.
    pub(super) fn send_working_cards(&self, slug: &str, extra: Option<Vec<Arc<Tk>>>) {
        let mut sent: Vec<String> = Vec::new();
        for x in self.run_chains(slug).iter().flatten().chain(extra.iter().flatten()) {
            if x.on_board() && !sent.contains(&x.id) {
                sent.push(x.id.clone());
                self.emit_ticket(slug, &x.id);
            }
        }
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
/// How many other pieces of work share the folder with card `id`: None unless a run in its own family (a run whose
/// chain holds `id`) and a run of another piece of work both edit it in place.
fn share_count(work: &[(Vec<Arc<Tk>>, String)], id: &str) -> Option<usize> {
    let (mine, rest): (Vec<_>, Vec<_>) = work.iter().partition(|(c, _)| c.iter().any(|x| x.id == id));
    if mine.is_empty() {
        return None;
    }
    let mut cards: Vec<&str> = rest.iter().map(|(_, card)| card.as_str()).filter(|c| *c != id).collect();
    cards.sort_unstable();
    cards.dedup();
    (!cards.is_empty()).then_some(cards.len())
}

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
        // The views (what `ticket.updated` events carry) ask this run loop, as in board mode.
        let late = super::super::wiring::LateRuns::new();
        let mut services = Services::stand_ins();
        services.runs = late.clone();
        let core = Core::new(d.path(), services);
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
        late.set(runs.clone());
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
        // An idle ticket in the folder doesn't count either.
        ticket(&b, "Idle", json!({ "status": "review", "runCount": 1 }));
        for id in [&one, &two, &three] {
            let v = b.runs.folder_share("b", &b.core.tickets.get("b", id).unwrap());
            assert_eq!(v["others"], json!(2), "{id}: {v}");
        }
        // A ticket working on its own copy shares nothing.
        b.core.tickets.patch("b", &three, json!({ "worktree": "/tmp/copy" }).as_object().unwrap().clone()).unwrap();
        assert_eq!(b.runs.folder_share("b", &b.core.tickets.get("b", &one).unwrap())["others"], json!(1));
        assert!(b.runs.folder_share("b", &b.core.tickets.get("b", &three).unwrap()).is_null());
    }

    fn share(b: &Board, id: &str) -> Value {
        b.runs.folder_share("b", &b.core.tickets.get("b", id).unwrap())
    }

    /// A run that edits the folder in place, for an existing ticket (`main`: a main ticket's run).
    fn run_for(b: &Board, id: &str, main: bool) {
        let run = Arc::new(ActiveRun { slug: "b".into(), id: id.into(), no_edit: main, st: Mutex::new(RunSt::default()), done: watch::channel(false).0 });
        b.runs.state.lock().runs.insert(RunLoop::key("b", id), run);
    }

    /// A user's ticket (a main ticket, idle itself) and a hidden task under it whose run edits the folder in place.
    fn main_with_task(b: &Board, title: &str, created: &str) -> (String, String) {
        let main = ticket(b, title, json!({ "main": true, "status": "review", "createdAt": created }));
        let task = ticket(b, &format!("{title} task"), json!({ "tool": true, "partOf": main, "status": "in_progress", "runCount": 1 }));
        run_for(b, &task, false);
        (main, task)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn two_user_tickets_each_running_a_task_both_show_one_other() {
        let b = board(None);
        let (a, ta) = main_with_task(&b, "A", "2026-11-20T01:00:00.000Z");
        let (bb, tb) = main_with_task(&b, "B", "2026-11-20T02:00:00.000Z");
        b.runs.git.note_repo("b", crate::git::repo::RepoKind::Plain);
        let (va, vb) = (share(&b, &a), share(&b, &bb));
        assert_eq!(va["others"], json!(1), "{va}");
        assert_eq!(vb["others"], json!(1), "{vb}");
        // The offer goes to the newest of the cards the user sees, once.
        assert_eq!((va["offer"].clone(), vb["offer"].clone()), (json!(false), json!(true)));
        // The hidden tasks have no card: their main tickets show it.
        assert!(share(&b, &ta).is_null() && share(&b, &tb).is_null());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_main_tickets_own_run_in_the_folder_counts() {
        let b = board(None);
        let main = ticket(&b, "Main", json!({ "main": true, "status": "in_progress", "runCount": 1 }));
        run_for(&b, &main, true);
        let other = running(&b, "Other");
        assert_eq!(share(&b, &main)["others"], json!(1));
        assert_eq!(share(&b, &other)["others"], json!(1));
        // The version history route counts the same runs.
        assert_eq!(b.runs.folder_editors(&project(&b)).len(), 2);
        // A main ticket working in its own copy doesn't.
        b.core.tickets.patch("b", &main, json!({ "worktree": "/tmp/copy" }).as_object().unwrap().clone()).unwrap();
        assert!(share(&b, &other).is_null());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tasks_of_one_family_alone_do_not_share() {
        let b = board(None);
        let (main, _) = main_with_task(&b, "A", "2026-11-20T01:00:00.000Z");
        let second = ticket(&b, "A task 2", json!({ "tool": true, "partOf": main, "status": "in_progress", "runCount": 1 }));
        run_for(&b, &second, false);
        // The main ticket's own run too: still one piece of work.
        run_for(&b, &main, true);
        assert!(share(&b, &main).is_null(), "{}", share(&b, &main));
    }

    /// The views of the `ticket.updated` events sent while `f` runs, by ticket id (the last one each).
    async fn sent_views(b: &Board, f: impl FnOnce(&RunLoop) + Send + 'static) -> std::collections::HashMap<String, Value> {
        let mut rx = b.core.bus.subscribe();
        let r = b.runs.clone();
        tokio::task::spawn_blocking(move || f(&r)).await.unwrap();
        let mut out = std::collections::HashMap::new();
        while let Ok(e) = rx.try_recv() {
            if e.ty == "ticket.updated"
                && let Some(v) = b.core.services.views.view("b", &e.body["ticket"])
            {
                out.insert(v["id"].as_str().unwrap().to_string(), v);
            }
        }
        out
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_request_or_cancel_sends_every_sharing_card_with_its_folder_share() {
        let b = board(None);
        let (a, _) = main_with_task(&b, "A", "2026-11-20T01:00:00.000Z");
        let (bb, _) = main_with_task(&b, "B", "2026-11-20T02:00:00.000Z");
        let path = project(&b);
        crate::git::pending::set(&b.runs.root, &path, "2026-11-22T00:00:00.000Z", &[]);
        let p = path.clone();
        let sent = sent_views(&b, move |r| r.folder_cards_changed(&p)).await;
        for id in [&a, &bb] {
            let v = sent.get(id).unwrap_or_else(|| panic!("{id} wasn't sent: {:?}", sent.keys()));
            assert_eq!(v["folderShare"]["pending"], json!(true), "{id}: {}", v["folderShare"]);
            assert_eq!(v["folderShare"]["path"], json!(path));
        }
        crate::git::pending::clear(&b.runs.root, &path);
        let p = path.clone();
        let sent = sent_views(&b, move |r| r.folder_cards_changed(&p)).await;
        for id in [&a, &bb] {
            assert_eq!(sent[id]["folderShare"]["pending"], json!(false), "{id}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_end_of_a_sharing_run_sends_the_other_card_without_the_pill() {
        let b = board(None);
        let (a, _) = main_with_task(&b, "A", "2026-11-20T01:00:00.000Z");
        let (bb, tb) = main_with_task(&b, "B", "2026-11-20T02:00:00.000Z");
        let sent = sent_views(&b, move |r| {
            r.state.lock().runs.remove(&RunLoop::key("b", &tb));
            r.share_changed("b", &tb);
        })
        .await;
        assert_eq!(sent.get(&a).map(|v| v["folderShare"].clone()), Some(Value::Null), "A's card must lose the pill");
        assert_eq!(sent.get(&bb).map(|v| v["folderShare"].clone()), Some(Value::Null));
    }

    fn project(b: &Board) -> String {
        b._d.path().join("project").to_string_lossy().to_string()
    }

    /// Waits (up to 20 s) until the board's request for the project folder is gone.
    async fn request_settled(b: &Board) -> bool {
        for _ in 0..200 {
            if !crate::git::pending::is_pending(&b.runs.root, &project(b)) && !b.runs.switching("b") {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        false
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_request_waits_while_a_ticket_still_edits_the_folder_and_turns_on_after_the_last_run() {
        if !crate::git::repo::git_installed().await {
            return;
        }
        let b = board(None);
        let one = running(&b, "One");
        let two = running(&b, "Two");
        let path = project(&b);
        crate::git::pending::set(&b.runs.root, &path, "2026-11-22T00:00:00.000Z", &[("b".into(), one.clone()), ("b".into(), two.clone())]);
        let card = b.runs.folder_share("b", &b.core.tickets.get("b", &one).unwrap());
        assert_eq!(card["pending"], json!(true), "{card}");
        assert_eq!(card["path"], json!(path), "the Cancel link needs the folder: {card}");
        let r = b.runs.clone();
        assert!(!tokio::task::spawn_blocking(move || end_run_of(&r, &one)).await.unwrap(), "started while Two still edits the folder");
        assert!(crate::git::pending::is_pending(&b.runs.root, &path), "the request should still wait");
        assert!(!b._d.path().join("project/.git").exists());
        let r = b.runs.clone();
        let t = two.clone();
        assert!(tokio::task::spawn_blocking(move || end_run_of(&r, &t)).await.unwrap(), "didn't start once the folder was free");
        assert!(request_settled(&b).await, "the request never finished");
        assert!(b._d.path().join("project/.git").exists(), "version history wasn't turned on");
        assert!(b.core.tickets.comments("b", &two).is_empty(), "no comment when it worked");
    }

    fn project_of(r: &RunLoop) -> String {
        r.root.join("project").to_string_lossy().to_string()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_end_of_a_real_run_turns_version_history_on() {
        if !crate::git::repo::git_installed().await {
            return;
        }
        let b = board(None);
        // Its run ends at once (no claude): `after_run` checks the request.
        let one = ticket(&b, "One", json!({ "status": "ready", "order": 1 }));
        crate::git::pending::set(&b.runs.root, &project(&b), "2026-11-22T00:00:00.000Z", &[("b".into(), one.clone())]);
        let r = b.runs.clone();
        tokio::task::spawn_blocking(move || r.dispatch("b")).await.unwrap();
        assert!(started(&b, &one));
        assert!(request_settled(&b).await, "the request never finished");
        assert!(b._d.path().join("project/.git").exists(), "version history wasn't turned on after the run ended");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn while_it_is_turned_on_tickets_in_the_folder_wait() {
        let b = board(None);
        let next = ticket(&b, "Next", json!({ "status": "ready", "order": 1 }));
        let path = project(&b);
        assert!(b.runs.hold_folder(&path));
        assert!(!b.runs.hold_folder(&path), "a second hold must be refused");
        let r = b.runs.clone();
        tokio::task::spawn_blocking(move || r.dispatch("b")).await.unwrap();
        assert!(!started(&b, &next), "dispatch started a ticket during the switch");
        let r = b.runs.clone();
        let n = next.clone();
        let refused = tokio::task::spawn_blocking(move || r.start("b", &n, None, None)).await.unwrap();
        assert_eq!(refused.as_deref(), Some(super::super::history::SWITCHING));
        assert!(!b.runs.is_running("b", &next));
        let r = b.runs.clone();
        tokio::task::spawn_blocking(move || r.release_folder(&project_of(&r))).await.unwrap();
        assert!(started(&b, &next), "the held ticket didn't start after the switch");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_clears_the_request_and_nothing_turns_on() {
        let b = board(None);
        let one = running(&b, "One");
        let path = project(&b);
        crate::git::pending::set(&b.runs.root, &path, "2026-11-22T00:00:00.000Z", &[("b".into(), one.clone())]);
        assert!(crate::git::pending::clear(&b.runs.root, &path));
        assert_eq!(b.runs.folder_share("b", &b.core.tickets.get("b", &one).unwrap()), Value::Null, "alone: no pill");
        let r = b.runs.clone();
        assert!(!tokio::task::spawn_blocking(move || end_run_of(&r, &one)).await.unwrap());
        assert!(!b._d.path().join("project/.git").exists());
    }

    fn end_run_of(r: &RunLoop, id: &str) -> bool {
        r.state.lock().runs.remove(&RunLoop::key("b", id));
        r.turn_on_when_free(&project_of(r))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_turn_on_clears_the_request_and_tells_the_newest_ticket() {
        let b = board(None);
        let older = running(&b, "Older");
        let newer = running(&b, "Newer");
        b.core.tickets.patch("b", &older, json!({ "createdAt": "2026-11-20T01:00:00.000Z" }).as_object().unwrap().clone()).unwrap();
        b.core.tickets.patch("b", &newer, json!({ "createdAt": "2026-11-20T02:00:00.000Z" }).as_object().unwrap().clone()).unwrap();
        let path = project(&b);
        crate::git::pending::set(&b.runs.root, &path, "2026-11-22T00:00:00.000Z", &[("b".into(), older.clone()), ("b".into(), newer.clone())]);
        // The folder is gone (a file in its place): turning it on fails.
        std::fs::remove_dir_all(&path).unwrap();
        std::fs::write(&path, "not a folder").unwrap();
        let r = b.runs.clone();
        let (o, n) = (older.clone(), newer.clone());
        assert!(tokio::task::spawn_blocking(move || {
            r.state.lock().runs.remove(&RunLoop::key("b", &o));
            end_run_of(&r, &n)
        })
        .await
        .unwrap());
        assert!(request_settled(&b).await, "the request wasn't cleared");
        let c = b.core.tickets.comments("b", &newer);
        assert_eq!(c.len(), 1, "{c:?}");
        let text = c[0]["text"].as_str().unwrap();
        assert!(text.starts_with("Couldn't turn on version history for this folder after these tickets finished:"), "{text}");
        assert!(!text.contains("git"), "plain words: {text}");
        assert!(b.core.tickets.comments("b", &older).is_empty());
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
