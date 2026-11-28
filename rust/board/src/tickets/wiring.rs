//! The board steps already in Rust, plugged into the ticket writes (`BoardHooks`): copies of the folder (R6) and
//! browsers and terminal shells (R9). Everything else keeps its stand-in until its step lands; a later step adds its
//! piece here.
//!
//! Deleting copies of the folder follows plan 5.3: a ticket moved to Done has its copy cleaned up by R6's
//! `cleanup_worktree`; a deleted ticket's copy is removed the same way. Both only report with `CKANBAN_RUST_DELETE=0`
//! (then the start-up sweep finds the copy later).

use std::path::PathBuf;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::hooks::BoardHooks;
use super::writer::Tickets;
use crate::browsers::Browsers;
use crate::browsers::chromes::{browser_picks, chrome_setting, legacy_chrome, picks_from_legacy, picks_json};
use crate::dryrun;
use crate::git::landing::Git;

pub struct Wired {
    pub git: Option<Arc<Git>>,
    /// Families, plans and the feature status (R2b).
    pub families: Option<Arc<crate::families::Families>>,
    pub browsers: Option<Arc<Browsers>>,
    /// R11a: the huddles a ticket hosts.
    pub huddles: Option<Arc<crate::huddles::Huddles>>,
    pub root: PathBuf,
    /// The run loop's side (R7a).
    pub runs: Option<Arc<crate::runloop::wiring::RunHooks>>,
    /// R10: schedules (a schedule-delete card deletes one).
    pub schedules: Option<Arc<crate::schedules::Schedules>>,
    /// P1a: the helper (a helper-rule card's Add), set once board mode has made it.
    pub helper: Arc<std::sync::OnceLock<Arc<crate::helper::runner::HelperRunner>>>,
}

impl BoardHooks for Wired {
    /// A helper-rule card's Add (`ticket-cards.ts`): the line goes into "What the helper knows about you" unless it is
    /// there already (Ok(true)); a full list is refused, the user chooses what goes.
    fn helper_rule(&self, text: &str) -> futures_util::future::BoxFuture<'_, Result<bool, (u16, String)>> {
        let text = text.to_string();
        Box::pin(async move {
            if let Some(bad) = crate::sessions::cards::suggested_line_error(&text) {
                return Err((400, format!("This suggestion can't be added: {bad}.")));
            }
            let Some(h) = self.helper.get() else { return Err((503, "the helper isn't running".to_string())) };
            let key = |x: &str| crate::runs::js::trim(&crate::runs::js::squash_ws(x)).to_lowercase();
            let lines = h.settings.get().feedback;
            let already = lines.iter().any(|f| key(f.get("text").and_then(Value::as_str).unwrap_or("")) == key(&text));
            let max = crate::helper::settings::FEEDBACK_LINES_MAX;
            if !already && lines.len() >= max {
                return Err((409, format!("What the helper knows about you is full ({max} lines). Remove a line in Notifications, then tap Add again.")));
            }
            if !already {
                h.settings.add_feedback(Some(&Value::String(text)), "suggested").map_err(|e| (400, e))?;
                h.feedback_added();
            }
            Ok(already)
        })
    }
    fn remove_schedule(&self, slug: &str, id: &str) -> Result<Option<String>, String> {
        let Some(s) = &self.schedules else { return Err(format!("deleting a schedule is {}", super::hooks::NOT_YET)) };
        if s.files.get_schedule(slug, id).is_none() {
            return Ok(None);
        }
        s.remove_schedule(slug, id, &serde_json::Value::from("user")).map(Some).map_err(|(_, e)| e)
    }
    fn jobs_to_cancel(&self, slug: &str, ids: &[String], pick: &super::hooks::CancelJobs) -> Result<Vec<String>, (u16, String)> {
        match &self.schedules {
            Some(s) => s.jobs_to_cancel(slug, ids, pick),
            None if *pick == super::hooks::CancelJobs::None => Ok(Vec::new()),
            None => Err((400, format!("cancelling jobs is {}", super::hooks::NOT_YET))),
        }
    }
    fn cancel_jobs(&self, slug: &str, job_ids: &[String], titles: &std::collections::HashMap<String, String>, by: Option<&str>) -> Vec<Value> {
        let Some(s) = &self.schedules else { return Vec::new() };
        s.cancel_for_delete(slug, job_ids, titles, by).iter().map(|j| s.job_view(slug, j)).collect()
    }
    fn run_state(&self, slug: &str, id: &str) -> super::hooks::RunState {
        self.runs.as_ref().map(|r| r.run_state(slug, id)).unwrap_or_default()
    }

    fn request_self_move(&self, slug: &str, id: &str, status: &str) -> super::hooks::SelfMove {
        self.runs.as_ref().map_or(super::hooks::SelfMove::Refused, |r| r.request_self_move(slug, id, status))
    }

    fn stop_run(&self, slug: &str, id: &str, target: Option<&str>) -> BoxFuture<'_, ()> {
        match &self.runs {
            Some(r) => r.stop_run(slug, id, target),
            None => Box::pin(async {}),
        }
    }

    fn chat_next_run(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), String>> {
        let r = match &self.runs {
            Some(r) => r.chat_next_run(slug, id, text),
            None => Err(super::hooks::NOT_YET.to_string()),
        };
        Box::pin(async move { r })
    }

    fn link_session(&self, slug: &str, id: &str, session: &str) -> BoxFuture<'_, Result<(), String>> {
        let runs = self.runs.clone();
        let (slug, id, session) = (slug.to_string(), id.to_string(), session.to_string());
        Box::pin(async move {
            match runs {
                Some(r) => r.runs.link_session(&slug, &id, Some(&session)).await.map(|_| ()).map_err(|e| e.message),
                None => Err(format!("linking a session is {}", super::hooks::NOT_YET)),
            }
        })
    }

    fn closes_form(&self, slug: &str, id: &str, uuid: &str) -> Result<Map<String, Value>, (u16, String)> {
        match &self.runs {
            Some(r) => r.closes_form(slug, id, uuid),
            None => Err((409, format!("closing a question is {}", super::hooks::NOT_YET))),
        }
    }

    fn suggest_parent(&self, slug: &str, id: &str) {
        crate::extras::suggest_parent(slug, id);
    }
    fn fresh_for_work(&self, slug: &str, id: &str, choice: Option<bool>) {
        if let Some(f) = &self.families {
            f.runs_handle().fresh_for_work(slug, id, choice);
        }
    }
    fn after_update(&self, slug: &str, id: &str, new_status: Option<&str>, by_user: bool, was_running: bool) -> BoxFuture<'_, ()> {
        let (slug, id, done) = (slug.to_string(), id.to_string(), new_status == Some("done"));
        let status = new_status.map(str::to_string);
        Box::pin(async move {
            // Done: nothing will be rewound any more, so its saved copies of the folder go (R7b, in the background).
            if let (true, Some(r)) = (done, &self.runs)
                && let Some(t) = r.runs.tickets.get(&slug, &id)
            {
                r.runs.drop_rewind_copies(&slug, &t.json);
            }
            if let (true, Some(git)) = (done, &self.git)
                && let Err(e) = git.cleanup_worktree(&slug, &id).await
            {
                eprintln!("[board] cleaning up the copy of {slug}/{id}: {e}");
            }
            // Then Bun's order: a Planning interview, a stopped main ticket's plan resumed, Ready work, the plans.
            let Some(f) = self.families.clone() else { return };
            let _ = tokio::task::spawn_blocking(move || {
                let runs = f.runs_handle();
                if status.as_deref() == Some("planning") {
                    runs.auto_refine(&slug, &id);
                }
                let working = matches!(status.as_deref(), Some("ready" | "in_progress"));
                if by_user && working && f.tickets.get(&slug, &id).is_some_and(|t| t.main) {
                    f.resume_stopped_plan(&slug, &id, &format!("you moved it to {}", status.as_deref().unwrap_or("").replacen('_', " ", 1)));
                }
                let reordered_ready = f.tickets.get(&slug, &id).is_some_and(|t| t.status == "ready");
                if was_running || status.as_deref() == Some("ready") || reordered_ready {
                    runs.dispatch(&slug);
                }
                f.advance_plans(&slug);
            })
            .await;
        })
    }

    fn after_create(&self, slug: &str, id: &str, status: &str, has_parent: bool) {
        let Some(f) = &self.families else { return };
        let runs = f.runs_handle();
        if status == "ready" {
            runs.dispatch(slug);
        }
        if status == "planning" {
            runs.auto_refine(slug, id);
        }
        if has_parent {
            f.advance_plans(slug);
        }
    }

    fn after_delete(&self, slug: &str, _id: &str) {
        // A deleted task may have been what kept its main ticket's plan stuck.
        if let Some(f) = &self.families {
            f.advance_plans(slug);
        }
    }

    fn board_changed(&self, slug: &str) {
        if let Some(f) = &self.families {
            f.runs_handle().dispatch(slug);
        }
    }

    fn place_in_feature(&self, slug: &str, input: &mut Map<String, Value>) -> Result<(), String> {
        match &self.families {
            Some(f) => f.place_in_feature(slug, input),
            None => super::hooks::NoHooks.place_in_feature(slug, input),
        }
    }

    fn set_part_of(&self, slug: &str, id: &str, parent: Option<&str>) -> BoxFuture<'_, Result<(), String>> {
        // Worked out now (on the caller's blocking thread): the link writes the ticket, which runs these hooks again.
        let r = match &self.families {
            Some(f) => f.set_part_of(slug, id, parent, None, true).map(|_| ()),
            None => Err(format!("linking a ticket into a feature is {}", super::hooks::NOT_YET)),
        };
        Box::pin(async move { r })
    }

    fn new_step(&self, slug: &str, planner: &str, main: bool) -> bool {
        let Some(f) = &self.families else { return false };
        if main {
            f.unpark_main(slug, planner, "it made a new step, so its steps run again", false);
        }
        f.ensure_plan(slug, planner);
        f.advance_plans(slug);
        false
    }

    fn gather(&self, slug: &str, id: &str, items: &[(String, Option<String>)], new_group: Option<&str>) -> BoxFuture<'_, Result<Value, String>> {
        let r = match &self.families {
            Some(f) => f.gather(slug, id, items, new_group, None, false).map(|g| {
                json!({
                    "gathered": g.gathered.iter().map(|t| f.view(slug, t)).collect::<Vec<_>>(),
                    "movedUp": g.moved_up, "skipped": g.skipped,
                    "group": g.group.as_ref().map(|t| f.view(slug, t)).unwrap_or(Value::Null),
                })
            }),
            None => Err(format!("gather is {}", super::hooks::NOT_YET)),
        };
        Box::pin(async move { r })
    }

    fn remove_copies(&self, slug: &str, ticket: &Map<String, Value>) -> BoxFuture<'_, ()> {
        let wt = ticket.get("worktree").and_then(Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from);
        let id = ticket.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let slug = slug.to_string();
        if let Some(r) = &self.runs {
            r.runs.drop_rewind_copies(&slug, ticket);
        }
        Box::pin(async move {
            let (Some(wt), Some(git)) = (wt, &self.git) else { return };
            if !dryrun::deletes_on() {
                let mut m = Map::new();
                m.insert("board".into(), json!(slug));
                m.insert("ticket".into(), json!(id));
                m.insert("path".into(), json!(wt.to_string_lossy()));
                m.insert("action".into(), json!("remove"));
                dryrun::report(&self.root, "delete-ticket", m);
                return;
            }
            let Some(profile) = ckanban_core::DataDir::new(self.root.clone()).profile(&slug) else { return };
            git.remove_ticket_worktree(&Value::Object(profile.record.0), &wt).await;
        })
    }

    fn browsers(&self, browsers: Option<&Value>, chrome: Option<&Value>) -> Result<(Value, Value), (u16, String)> {
        let Some(b) = &self.browsers else { return Err((400, "choosing browsers is not in the Rust board yet".into())) };
        let known_chrome = |id: &str| b.chromes.get(id).is_some();
        let known_board = |id: &str| b.board_browsers.get(id).is_some();
        if let Some(list) = browsers {
            let picks = browser_picks(list, known_chrome, known_board).map_err(|e| (e.status, e.message))?;
            let chrome = legacy_chrome(picks.as_deref());
            return Ok((chrome.map(Value::String).unwrap_or(Value::Null), picks_json(&picks)));
        }
        let chrome = chrome_setting(chrome.unwrap_or(&Value::Null), known_chrome).map_err(|e| (e.status, e.message))?;
        let picks = picks_from_legacy(chrome.as_deref());
        Ok((chrome.map(Value::String).unwrap_or(Value::Null), picks_json(&picks)))
    }

    fn close_huddles(&self, slug: &str, id: &str) {
        if let Some(h) = &self.huddles {
            h.op(|h| h.close_for_ticket(slug, id, crate::huddles::model::DELETED));
        }
    }

    fn huddle_live(&self, slug: &str, id: &str) -> bool {
        use crate::huddles::model::s;
        self.huddles.as_ref().is_some_and(|h| {
            h.files.open(slug).iter().any(|x| s(x, "hostTicket") == id && s(x, "status") == "live" && x.get("auto").is_none_or(|a| a.is_null() || a == false))
        })
    }

    fn huddle_open(&self, slug: &str, id: &str) -> bool {
        use crate::huddles::model::s;
        self.huddles.as_ref().is_some_and(|h| h.files.open(slug).iter().any(|x| s(x, "hostTicket") == id && s(x, "status") != "closed"))
    }

    fn kill_shells(&self, slug: &str) {
        if let Some(b) = &self.browsers {
            b.shells.kill(slug);
        }
    }
}

/// R6's view of the board (`git::ops::BoardOps`) over the ticket writes.
pub struct TicketOps {
    pub tickets: Arc<Tickets>,
    /// R2b's families (a milestone is recorded in the feature's status), set once made.
    pub families: std::sync::OnceLock<Arc<crate::families::Families>>,
    /// The run loop (R7a): chat messages (send CI failures, resolve conflicts).
    pub runs: std::sync::OnceLock<Arc<crate::runloop::RunLoop>>,
}

impl crate::git::ops::BoardOps for TicketOps {
    fn profile(&self, slug: &str) -> Option<Value> {
        ckanban_core::DataDir::new(self.tickets.root().to_path_buf()).profile(slug).map(|p| Value::Object(p.record.0))
    }
    fn profiles(&self) -> Vec<Value> {
        ckanban_core::DataDir::new(self.tickets.root().to_path_buf()).list_profiles().unwrap_or_default().into_iter().map(|p| Value::Object(p.record.0)).collect()
    }
    fn save_profile(&self, profile: Value) {
        let Value::Object(map) = profile.clone() else { return };
        let slug = map.get("slug").and_then(Value::as_str).unwrap_or("").to_string();
        let data = ckanban_core::DataDir::new(self.tickets.root().to_path_buf());
        match (ckanban_core::home::Profile { record: ckanban_core::record::JsonRecord(map) }).save(&data) {
            Ok(()) => self.tickets.bus.emit_json(json!({ "type": "profile.updated", "slug": slug, "profile": profile })),
            Err(e) => eprintln!("[board] profile {slug}: {e}"),
        }
    }
    fn ticket(&self, slug: &str, id: &str) -> Option<Value> {
        self.tickets.get(slug, id).map(|t| Value::Object(t.json.clone()))
    }
    fn tickets(&self, slug: &str) -> Vec<Value> {
        self.tickets.list(slug).tickets.iter().map(|t| Value::Object(t.json.clone())).collect()
    }
    fn trim_candidates(&self, slug: &str) -> Vec<crate::git::trim::Candidate> {
        // The index's shared listing; only Done tickets are looked at further, nothing is cloned for the rest.
        self.tickets.list(slug).tickets.iter().filter(|t| t.status == "done").filter_map(|t| crate::git::trim::candidate(&t.json)).collect()
    }
    fn patch(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Result<Value, String> {
        self.tickets.patch(slug, id, patch).map(|t| Value::Object(t.json.clone())).map_err(|(_, e)| e)
    }
    fn move_to(&self, slug: &str, id: &str, status: &str) -> BoxFuture<'_, Result<(), String>> {
        let (slug, id) = (slug.to_string(), id.to_string());
        let mut p = Map::new();
        p.insert("status".into(), status.into());
        let t = self.tickets.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || t.update(&slug, &id, &p, false).map(|_| ()).map_err(|(_, e)| e)).await.map_err(|e| e.to_string())?
        })
    }
    fn comments(&self, slug: &str, id: &str) -> Vec<Value> {
        self.tickets.comments(slug, id)
    }
    fn add_comment(&self, slug: &str, id: &str, author: &str, text: &str) {
        if let Err((_, e)) = self.tickets.store_comment(slug, id, author, text, None) {
            eprintln!("[board] comment on {slug}/{id}: {e}");
        }
    }
    fn push_event(&self, slug: &str, id: &str, line: &str) {
        if let Some(f) = self.families.get() {
            f.push_event(slug, id, line);
        }
    }
    fn emit_ticket(&self, slug: &str, id: &str) {
        if let Some(t) = self.tickets.get(slug, id) {
            self.tickets.emit(slug, &t);
        }
    }
    fn main_of(&self, slug: &str, id: &str) -> Option<Value> {
        let t = self.tickets.get(slug, id)?;
        self.tickets.main_of(slug, &t).map(|m| Value::Object(m.json.clone()))
    }
    fn busy(&self, slug: &str, id: &str) -> bool {
        // A run, or an open huddle whose helpers may work in the ticket's copy (the sweep and the trim leave it).
        self.tickets.runs.is_running(slug, id) || self.tickets.hooks().huddle_open(slug, id)
    }
    fn is_running(&self, slug: &str, id: &str) -> bool {
        self.tickets.runs.is_running(slug, id)
    }
    fn holds_review(&self, slug: &str, id: &str) -> bool {
        self.families.get().is_none_or(|f| f.holds_review(slug, id))
    }
    fn chat(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<Value, String>> {
        let runs = self.runs.get().cloned();
        let (slug, id, text) = (slug.to_string(), id.to_string(), text.to_string());
        Box::pin(async move {
            let Some(r) = runs else { return Err(super::hooks::NOT_YET.to_string()) };
            tokio::task::spawn_blocking(move || r.chat(&slug, &id, &text, Default::default()).map(|t| Value::Object(t.json.clone())).map_err(|e| e.message))
                .await
                .map_err(|e| e.to_string())?
        })
    }
    fn session_exists(&self, session_id: &str) -> bool {
        crate::sessions::files::find_session_file(&crate::sessions::files::projects_dir(None), session_id).is_some()
    }
    fn record_milestone(&self, slug: &str, id: &str, text: &str, landed: &str) -> Result<(), String> {
        match self.families.get() {
            Some(f) => f.record_milestone(slug, id, text, landed),
            None => Err(super::hooks::NOT_YET.to_string()),
        }
    }
}

/// R11b's squad cards on tickets (`team::store::TicketCards`): a squad saved from a ticket chat's card marks it.
pub struct SquadCards {
    pub tickets: Arc<Tickets>,
}

impl crate::team::store::TicketCards for SquadCards {
    fn exists(&self, slug: &str, id: &str) -> bool {
        self.tickets.get(slug, id).is_some()
    }
    fn mark_saved(&self, slug: &str, id: &str, uuid: &str, state: Value) -> Result<(), String> {
        self.tickets.set_entry(slug, id, "squadCards", uuid, state).map(|_| ()).map_err(|(_, e)| e)
    }
}

#[cfg(test)]
mod merged_pr_tests {
    use super::*;
    use crate::core::{Core, Services};
    use crate::families::Families;
    use crate::git::ops::BoardOps;
    use serde_json::json;

    struct B {
        _d: tempfile::TempDir,
        core: Arc<Core>,
        fam: Arc<Families>,
        ops: TicketOps,
    }

    fn board() -> B {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("profiles/b/tickets")).unwrap();
        let profile = json!({ "name": "B", "slug": "b", "path": d.path().join("project"), "workspace": "folder", "createdAt": "2026-11-01T00:00:00.000Z" });
        std::fs::write(d.path().join("profiles/b/profile.json"), profile.to_string()).unwrap();
        let core = Core::new(d.path(), Services::stand_ins());
        let fam = Families::new(core.tickets.clone(), core.reads.clone());
        let ops = TicketOps { tickets: core.tickets.clone(), families: std::sync::OnceLock::new(), runs: std::sync::OnceLock::new() };
        let _ = ops.families.set(fam.clone());
        B { _d: d, core, fam, ops }
    }

    fn ticket(b: &B, fields: Value) -> String {
        let mut m = Map::new();
        m.insert("title".into(), "Customer enquiry".into());
        m.insert("body".into(), "".into());
        let id = b.core.tickets.create("b", m).unwrap().id.clone();
        b.core.tickets.patch("b", &id, fields.as_object().unwrap().clone()).unwrap();
        id
    }

    fn status(b: &B, id: &str) -> String {
        b.core.tickets.get("b", id).unwrap().status.clone()
    }

    fn merged_said(b: &B, id: &str) -> usize {
        b.ops.comments("b", id).iter().filter(|c| c["author"] == "ai" && c["text"] == "PR merged.").count()
    }

    async fn poll(b: &B, id: &str) {
        crate::git::pr::check_pr(&b.ops, "b", id, |_| Box::pin(async { Some("MERGED".to_string()) })).await;
    }

    const ENDED: &str = "2026-11-27T10:00:00.000Z";

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_merged_pr_keeps_a_ticket_that_asks_in_review_until_the_ask_closes() {
        let b = board();
        let id = ticket(&b, json!({ "status": "review", "outcome": "needs_input", "prUrl": "u1", "runEndedAt": ENDED }));
        assert!(b.fam.holds_review("b", &id));
        poll(&b, &id).await;
        poll(&b, &id).await;
        assert_eq!(status(&b, &id), "review");
        assert_eq!(merged_said(&b, &id), 1);
        // The user closed the question: the next poll moves it to Done, without a second "PR merged.".
        b.core.tickets.patch("b", &id, json!({ "closedForms": { "f1": { "run": ENDED } } }).as_object().unwrap().clone()).unwrap();
        assert!(!b.fam.holds_review("b", &id));
        poll(&b, &id).await;
        assert_eq!(status(&b, &id), "done");
        assert_eq!(merged_said(&b, &id), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_merged_pr_waits_for_a_blocked_or_failed_run_and_frees_once_answered() {
        let b = board();
        for outcome in ["blocked", "failed"] {
            let id = ticket(&b, json!({ "status": "review", "outcome": outcome, "prUrl": "u1" }));
            poll(&b, &id).await;
            assert_eq!(status(&b, &id), "review", "outcome {outcome}");
        }
        // Answered in chat: the next run ended done.
        let id = ticket(&b, json!({ "status": "review", "outcome": "needs_input", "prUrl": "u1" }));
        poll(&b, &id).await;
        assert_eq!(status(&b, &id), "review");
        b.core.tickets.patch("b", &id, json!({ "outcome": "done" }).as_object().unwrap().clone()).unwrap();
        poll(&b, &id).await;
        assert_eq!(status(&b, &id), "done");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_merged_pr_moves_a_ticket_with_nothing_pending_to_done() {
        let b = board();
        let id = ticket(&b, json!({ "status": "review", "outcome": "done", "prUrl": "u1" }));
        assert!(!b.fam.holds_review("b", &id));
        poll(&b, &id).await;
        assert_eq!(status(&b, &id), "done");
        assert_eq!(merged_said(&b, &id), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_done_ticket_that_asks_goes_back_to_review() {
        let b = board();
        let id = ticket(&b, json!({ "status": "done", "outcome": "needs_input", "runEndedAt": ENDED }));
        assert!(b.fam.unpark_asking("b", &id));
        assert_eq!(status(&b, &id), "review");
        assert!(b.ops.comments("b", &id).iter().any(|c| c["text"] == "Moved back from Done: it asks you a question."));
        // Once back, nothing more happens.
        assert!(!b.fam.unpark_asking("b", &id));
        // Done tickets that don't ask stay: a closed ask, a plain done, a blocked run.
        let closed = ticket(&b, json!({ "status": "done", "outcome": "needs_input", "runEndedAt": ENDED, "closedForms": { "f": { "run": ENDED } } }));
        let plain = ticket(&b, json!({ "status": "done", "outcome": "done" }));
        let blocked = ticket(&b, json!({ "status": "done", "outcome": "blocked" }));
        for x in [&closed, &plain, &blocked] {
            assert!(!b.fam.unpark_asking("b", x));
            assert_eq!(status(&b, x), "done");
        }
    }
}
