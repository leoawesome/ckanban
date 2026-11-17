//! R12: board extras, ported from `src/board/learner.ts`, `learn.ts`, `lessons.ts`, `linker.ts`, `recall.ts`,
//! `mockups.ts`, `src/usage/ticket-usage.ts` and the team usage of `src/huddle/huddle-usage.ts`. `Extras` holds the
//! services; `routes.rs` answers `/learned`, `find-links`, a ticket's `usage` and `/api/team-usage` in board mode.

pub mod learn;
pub mod learner;
pub mod lessons;
pub mod linker;
pub mod mockups;
pub mod recall;
pub mod routes;
pub mod usage;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use futures_util::future::BoxFuture;
use parking_lot::Mutex;

use crate::core::Core;
use crate::runs::side_call::{SideCallInput, SideCallResult, SideCaller};

/// A side call (`SideCaller::call`), replaceable in tests.
pub type SideFn = Arc<dyn Fn(SideCallInput) -> BoxFuture<'static, SideCallResult> + Send + Sync>;

/// The real side caller.
pub fn side_caller() -> SideFn {
    let caller = Arc::new(SideCaller { bin: None, cwd: None, env: None });
    Arc::new(move |i| {
        let c = caller.clone();
        Box::pin(async move { c.call(i).await })
    })
}

pub struct Extras {
    pub root: PathBuf,
    pub learner: Arc<learner::Learner>,
    pub linker: Arc<linker::Linker>,
    pub run_logs: usage::RunLogIndex,
    pub claude_logs: usage::ClaudeLogIndex,
    pub huddles: usage::HuddleFiles,
    /// One recall index per board (R7a's run prompts call `recall`).
    recall: Mutex<HashMap<String, Arc<recall::RecallIndex>>>,
    comments: crate::index::links::Comments,
    core: Arc<Core>,
}

static LINKER: OnceLock<Arc<linker::Linker>> = OnceLock::new();

/// The board's parent suggestion for a ticket the user made (R2a's `suggest_parent` hook), in the background.
pub fn suggest_parent(slug: &str, id: &str) {
    let (Some(l), Ok(rt)) = (LINKER.get(), tokio::runtime::Handle::try_current()) else { return };
    let (l, slug, id) = (l.clone(), slug.to_string(), id.to_string());
    rt.spawn(async move { l.suggest(&slug, &id).await });
}

impl Extras {
    /// The extras on the board's core; `start` begins the learner's watching.
    pub fn new(core: &Arc<Core>, side: SideFn) -> Arc<Extras> {
        let root = core.root.clone();
        let now: Arc<dyn Fn() -> f64 + Send + Sync> = Arc::new(ckanban_core::time::now_ms);
        let learner = learner::Learner::new(
            &root,
            core.index.clone(),
            core.bus.clone(),
            learner::LearnerOptions {
                side: side.clone(),
                sessions: core.services.sessions.clone(),
                runs: core.services.runs.clone(),
                now: now.clone(),
                new_id: Arc::new(learner::new_id),
                settle_ms: std::env::var("CKANBAN_LEARN_SETTLE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(120_000),
                tidy_check_ms: 3_600_000,
            },
        );
        let linker = Arc::new(linker::Linker { index: core.index.clone(), tickets: core.tickets.clone(), side, now: now.clone() });
        Arc::new(Extras {
            learner,
            linker,
            run_logs: usage::RunLogIndex::new(),
            claude_logs: usage::ClaudeLogIndex::new(usage::claude_projects_dir(), 10_000.0, now),
            huddles: usage::HuddleFiles::new(&root),
            recall: Mutex::new(HashMap::new()),
            comments: Default::default(),
            root,
            core: core.clone(),
        })
    }

    /// Starts the learner and plugs the linker into ticket creation; both stop with the core.
    pub fn start(self: &Arc<Self>) {
        let _ = LINKER.set(self.linker.clone());
        self.learner.start();
        let l = self.learner.clone();
        self.core.on_stop("learner", move || l.stop());
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `Board.recall`: "What we did before" for a ticket's first prompt, the rules the board learned and the project's
    /// lessons a run in another folder can't see yet; "" for none (blocking: reads changed tickets' summaries).
    pub fn recall(&self, slug: &str, ticket: &serde_json::Map<String, serde_json::Value>) -> String {
        let idx = self.recall.lock().entry(slug.to_string()).or_insert_with(|| Arc::new(recall::RecallIndex::new())).clone();
        let list = self.core.index.list(slug);
        let tickets: Vec<recall::RecallTicket> = list.tickets.iter().map(|t| recall::RecallTicket::of(&t.json)).collect();
        let dir = ckanban_core::DataDir::new(&self.root);
        let summary = |id: &str| self.last_summary(&dir.ticket_dir(slug, id));
        // Bun counts its own comment writes; the file's size and time change with every one of them too.
        let stamp = |id: &str| {
            let f = dir.ticket_dir(slug, id).join("comments.jsonl");
            std::fs::metadata(f).map(|m| format!("{}:{:?}", m.len(), m.modified().ok())).unwrap_or_else(|_| "0".into())
        };
        let picked = recall::recall_text(&idx.pick(&recall::RecallQuery::of(ticket), &tickets, &summary, &stamp));
        let id = ticket.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
        let now = self.core.index.ticket(slug, id).map(|t| t.json.clone()).unwrap_or_else(|| ticket.clone());
        let folder = |k: &str| now.get(k).and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()).map(PathBuf::from);
        let lessons = match dir.profile(slug).and_then(|p| p.record.str("path").map(PathBuf::from)) {
            Some(project) => lessons::lessons_block(&project, folder("worktree").or_else(|| folder("workdir")).as_deref()),
            None => String::new(),
        };
        [picked, learn::learned_rules_block(&self.root, slug), lessons].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n")
    }

    /// `Store.lastAiSummary`: the newest Claude comment that isn't a board note.
    fn last_summary(&self, ticket_dir: &Path) -> Option<String> {
        const NOTES: [&str; 8] = [
            "Run failed", "Could not start", "Run stopped", "Planner stopped", "Started a fresh session", "Started a fresh chat",
            "Took over the session", "This ticket's Claude session is still open",
        ];
        self.comments.ai(ticket_dir).iter().rev().find(|(t, _)| !NOTES.iter().any(|n| t.starts_with(n))).map(|(t, _)| t.clone())
    }
}
