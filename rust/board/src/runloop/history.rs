//! Turning version history on for a board's folder once the tickets editing it in place have finished: the card's
//! "Turn on version history" link saves a request (`git::pending`) while they still run. The end of each run checks
//! it (`turn_on_when_free`, from `after_run` and the end of `recover`), never a timer over all tickets. While it is
//! being turned on, the folder is held (`State::switching`): `folder_busy` keeps tickets that would edit it in place
//! waiting and `start` refuses them, so nothing starts changing files during the first snapshot.

use std::path::Path;

use serde_json::Value;

use super::board::RunLoop;
use crate::git::pending;
use crate::git::repo::{self, RepoKind};
use crate::index::ticket::Tk;

/// What a start refused during the switch says on the card.
pub const SWITCHING: &str = "Version history is being turned on for this folder right now. This ticket can start in a moment.";

impl RunLoop {
    pub(super) fn board_path(&self, slug: &str) -> Option<String> {
        self.profile(slug).and_then(|p| p.get("path").and_then(Value::as_str).map(str::to_string)).filter(|p| !p.is_empty())
    }

    /// The boards whose folder is `path` (one in practice: two boards can't share a folder).
    fn boards_on(&self, path: &str) -> Vec<String> {
        self.boards().into_iter().filter(|s| self.board_path(s).as_deref() == Some(path)).collect()
    }

    /// Version history is being turned on for the board's folder now.
    pub fn switching(&self, slug: &str) -> bool {
        if self.state.lock().switching.is_empty() {
            return false;
        }
        self.board_path(slug).is_some_and(|p| self.state.lock().switching.contains(&p))
    }

    /// `t`'s run would edit a folder being switched in place: it waits (`folder_busy`) or isn't started (`start`).
    pub(super) fn held_by_switch(&self, slug: &str, t: &Tk) -> bool {
        !t.main && self.switching(slug) && self.runs_in_folder(slug, t) != Some(false)
    }

    /// The running tickets editing the folder at `path` in place, as (board, id): the rule of
    /// `POST /api/version-history` (any run of a ticket that doesn't have its own copy). Only the live runs.
    pub fn folder_editors(&self, path: &str) -> Vec<(String, String)> {
        self.running_tickets()
            .into_iter()
            .filter(|(slug, _)| self.board_path(slug).as_deref() == Some(path))
            .filter(|(slug, id)| self.get(slug, id).is_some_and(|t| self.runs_in_folder(slug, &t) != Some(false)))
            .collect()
    }

    /// Holds starts in the folder at `path`; false when it is held already.
    pub fn hold_folder(&self, path: &str) -> bool {
        let _g = self.decide.lock();
        self.state.lock().switching.insert(path.to_string())
    }

    /// Ends the hold: a waiting request is checked again first (so a Ready ticket doesn't take the folder before it),
    /// then the held tickets start and the running cards show the request's state.
    pub fn release_folder(&self, path: &str) {
        {
            let _g = self.decide.lock();
            self.state.lock().switching.remove(path);
            self.turn_on_when_free(path);
        }
        for slug in self.boards_on(path) {
            self.dispatch(&slug);
        }
        self.folder_cards_changed(path);
    }

    /// The cards working in the folder at `path` are sent again (their `folderShare.pending` changed): each running
    /// ticket's card, and the cards above it (a user's ticket whose hidden task runs isn't running itself, but its
    /// card shows the pill). Only the live runs, a handful.
    pub fn folder_cards_changed(&self, path: &str) {
        for slug in self.boards_on(path) {
            self.send_working_cards(&slug, None);
        }
    }

    /// The folder at `path` has a request and no ticket edits it in place now: hold it and turn version history on in
    /// the background, with the route's checks run again. True when it started. Blocking (quick: the live runs only).
    pub fn turn_on_when_free(&self, path: &str) -> bool {
        let _g = self.decide.lock();
        if self.shutting_down() || self.restart_pending() || !pending::is_pending(&self.root, path) {
            return false;
        }
        if self.state.lock().switching.contains(path) || !self.folder_editors(path).is_empty() {
            return false;
        }
        self.state.lock().switching.insert(path.to_string());
        let me = self.arc();
        let path = path.to_string();
        self.rt.spawn(async move {
            let r = repo::turn_on_checked(Path::new(&path)).await;
            let _ = tokio::task::spawn_blocking(move || me.switched(&path, r)).await;
        });
        true
    }

    /// After the board turned version history on (or failed to): the request is gone, a failure is told on the newest
    /// of the tickets that were sharing the folder, and the held tickets start.
    fn switched(&self, path: &str, r: Result<(repo::Enabled, RepoKind), (u16, String)>) {
        let req = pending::get(&self.root, path);
        pending::clear(&self.root, path);
        match r {
            Ok((_, kind)) => {
                for slug in self.boards_on(path) {
                    self.git.note_repo(&slug, kind);
                }
            }
            Err((status, e)) => {
                eprintln!("[board] couldn't turn on version history for {path}: {e}");
                let why = match status {
                    400 => "the program that keeps version history isn't installed on this computer".to_string(),
                    404 => "the folder doesn't exist any more".to_string(),
                    _ => e.strip_prefix("Couldn't turn on version history: ").unwrap_or(&e).to_string(),
                };
                if let Some((slug, id)) = self.newest_of(req.as_ref().map(pending::tickets_of).unwrap_or_default()) {
                    self.note(&slug, &id, &format!("Couldn't turn on version history for this folder after these tickets finished: {why}. You can try again from Board settings."));
                }
            }
        }
        self.release_folder(path);
    }

    /// The newest (by createdAt, then id) of these tickets that still exist.
    fn newest_of(&self, tickets: Vec<(String, String)>) -> Option<(String, String)> {
        let key = |t: &Tk| (t.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string(), t.id.clone());
        tickets.into_iter().filter_map(|(s, id)| self.get(&s, &id).map(|t| (key(&t), s))).max_by(|a, b| a.0.cmp(&b.0)).map(|((_, id), s)| (s, id))
    }

    /// After `recover`: requests saved before a restart whose folder is free now.
    pub(super) fn check_version_history_requests(&self) {
        for path in pending::folders(&self.root) {
            if self.boards_on(&path).is_empty() {
                continue;
            }
            self.turn_on_when_free(&path);
        }
    }

}
