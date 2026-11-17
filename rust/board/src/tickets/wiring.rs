//! The board steps already in Rust, plugged into the ticket writes (`BoardHooks`): copies of the folder (R6) and
//! browsers and terminal shells (R9). Everything else keeps its stand-in until its step lands; a later step adds its
//! piece here.
//!
//! Deleting copies of the folder follows plan 5.3: a ticket moved to Done has its copy cleaned up by R6's
//! `cleanup_worktree`, which only reports until `CKANBAN_RUST_DELETE=1`; a deleted ticket's copy is removed the same
//! way (reported only until then; the start-up sweep finds it later).

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
    pub root: PathBuf,
}

impl BoardHooks for Wired {
    fn after_update(&self, slug: &str, id: &str, new_status: Option<&str>, by_user: bool, was_running: bool) -> BoxFuture<'_, ()> {
        let (slug, id, done) = (slug.to_string(), id.to_string(), new_status == Some("done"));
        let status = new_status.map(str::to_string);
        Box::pin(async move {
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
        self.tickets.runs.is_running(slug, id)
    }
    fn is_running(&self, slug: &str, id: &str) -> bool {
        self.tickets.runs.is_running(slug, id)
    }
    fn holds_review(&self, slug: &str, id: &str) -> bool {
        self.families.get().is_none_or(|f| f.holds_review(slug, id))
    }
    fn chat(&self, _: &str, _: &str, _: &str) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async { Err(super::hooks::NOT_YET.to_string()) })
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
