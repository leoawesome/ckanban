//! The board's side of Rewind, Undo rewind and Fork (`src/board/board-rewind.ts`, `withRewind`, `dropRewindCopies`
//! of `board.ts`, `forkTicket` of `board-tickets.ts`) and the Planning chat's terminal command (`planningCommand`).
//! Blocking: called from the routes' blocking threads.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::rewind::{self, RewindError};
use crate::index::ticket::Tk;
use crate::runloop::board::{RunError, obj, ts, uuid};
use crate::runloop::RunLoop;
use crate::tickets::writer::block;

/// One rewind, undo or fork of a ticket at a time: the ticket is marked while it lasts (`withRewind`).
pub struct RewindGuard {
    runs: Arc<RunLoop>,
    key: String,
}

impl Drop for RewindGuard {
    fn drop(&mut self) {
        self.runs.state.lock().rewinding.remove(&self.key);
    }
}

fn conflict_or(e: RewindError) -> RunError {
    match e {
        RewindError::Refused(m) => RunError::conflict(m),
        RewindError::Failed(m) => RunError::other(m),
    }
}

/// `forkTitle`: "<title> (fork)", then "(fork 2)"…; an earlier " (fork N)" dropped first.
pub fn fork_title<'a>(title: &str, taken: impl IntoIterator<Item = &'a str>, max: Option<usize>) -> String {
    static TAIL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\s*\(fork(?: \d+)?\)\s*$").unwrap());
    let stripped = crate::runs::js::trim(&TAIL.replace(title, "")).to_string();
    let base = if stripped.is_empty() { crate::runs::js::trim(title).to_string() } else { stripped };
    let used: std::collections::HashSet<String> = taken.into_iter().map(|t| crate::runs::js::trim(t).to_lowercase()).collect();
    let mut n = 1;
    loop {
        let tail = if n == 1 { " (fork)".to_string() } else { format!(" (fork {n})") };
        let tl = crate::runs::js::len16(&tail);
        let head = match max {
            Some(max) if crate::runs::js::len16(&base) + tl > max => {
                let keep = (max as i64 - tl as i64 - 1).max(1) as usize;
                format!("{}…", crate::runs::js::head16(&base, keep).trim_end_matches(crate::runs::js::is_ws))
            }
            _ => base.clone(),
        };
        let t = format!("{head}{tail}");
        if !used.contains(&t.to_lowercase()) {
            return t;
        }
        n += 1;
    }
}

impl RunLoop {
    /// `rewindDir`: the folder a ticket's Claude edits once it is known (its copy, a linked folder, or the project
    /// folder after the first run edited it in place); None before that.
    pub fn rewind_dir(&self, slug: &str, id: &str) -> Option<PathBuf> {
        let t = self.get(slug, id)?;
        let profile = self.profile(slug)?;
        if t.is("workdir") || t.is("worktree") {
            let d = t.get("workdir").filter(|v| !v.is_null()).or_else(|| t.get("worktree").filter(|v| !v.is_null()))?;
            return d.as_str().map(PathBuf::from);
        }
        t.is("baseSha").then(|| PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or("")))
    }

    /// `rewindBlocked`: why the chat can't be rewound right now. `held`: asked from inside a rewind (the mark is ours).
    pub fn rewind_blocked(&self, slug: &str, id: &str, held: bool) -> Option<String> {
        let Some(t) = self.get(slug, id) else { return Some("ticket not found".into()) };
        if !held && self.state.lock().rewinding.contains(&Self::key(slug, id)) {
            return Some(crate::runloop::rules::REWINDING.into());
        }
        if self.is_running(slug, id) {
            return Some("Claude is working. Stop it or wait until it has replied.".into());
        }
        if t.get("queued").and_then(Value::as_array).is_some_and(|q| !q.is_empty()) {
            return Some("A message is still waiting to be sent. Send or discard it first.".into());
        }
        if !t.is("workdir") && !t.is("worktree") && self.folder_busy(slug, &t) {
            return Some("Another ticket is editing this folder right now. Try again when it has finished.".into());
        }
        None
    }

    /// `withRewind`'s start: refused while another rewind or a run is under way; the ticket marked until the guard drops.
    /// Checked under the board's choice lock, so a message being sent finishes first and the next one waits.
    pub fn begin_rewind(self: &Arc<Self>, slug: &str, id: &str) -> Result<RewindGuard, RunError> {
        let _g = self.decide.lock();
        if let Some(b) = self.rewind_blocked(slug, id, false) {
            return Err(RunError::conflict(b));
        }
        let key = Self::key(slug, id);
        self.state.lock().rewinding.insert(key.clone());
        Ok(RewindGuard { runs: self.clone(), key })
    }

    /// `rewound`: the conversation was cut; with nothing left of it, the next message starts a new session.
    pub fn rewound(&self, slug: &str, id: &str, emptied: bool, undo: Option<Map<String, Value>>) -> Result<Arc<Tk>, RunError> {
        self.recoverable(slug, id)?;
        let sid = emptied.then(uuid);
        let undo = undo.map(|mut u| {
            u.insert("newSessionId".into(), sid.clone().map(Value::String).unwrap_or(Value::Null));
            Value::Object(u)
        });
        let mut p = match &sid {
            Some(s) => obj(json!({ "sessionId": s, "sessionStarted": false, "freshSession": true, "lastActivity": null })),
            None => obj(json!({ "lastActivity": null })),
        };
        p.insert("rewindUndo".into(), undo.unwrap_or(Value::Null));
        p.insert("lastActivityAt".into(), Value::Null);
        self.patch(slug, id, p)
    }

    /// `undoRewindBlocked`: why the last rewind can't be undone now, or None.
    pub fn undo_rewind_blocked(&self, slug: &str, id: &str, files: bool, held: bool) -> Option<String> {
        let Some(t) = self.get(slug, id) else { return Some("ticket not found".into()) };
        if let Some(b) = self.rewind_blocked(slug, id, held) {
            return Some(b);
        }
        let u = t.get("rewindUndo").and_then(Value::as_object);
        let sid = ts(&t, "sessionId");
        let u_sid = u.and_then(|u| u.get("sessionId")).and_then(Value::as_str);
        let started = sid.is_some() && sid != u_sid && (t.is("sessionStarted") || sid.is_some_and(|s| self.session_exists(s)));
        let file = u.and(u_sid).and_then(session_file);
        block(rewind::undo_blocked(u, file.as_deref(), (sid, started), files))
    }

    /// `undoRewind`: the last rewind undone (files unless `files` is false); the `UndoResult`.
    pub fn undo_rewind(self: &Arc<Self>, slug: &str, id: &str, files: bool) -> Result<Value, RunError> {
        let _guard = self.begin_rewind(slug, id)?;
        if let Some(b) = self.undo_rewind_blocked(slug, id, files, true) {
            return Err(RunError::conflict(b));
        }
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let u = t.get("rewindUndo").and_then(Value::as_object).cloned().unwrap_or_default();
        let u_sid = u.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        let file = session_file(&u_sid).ok_or_else(|| RunError::other("The chat from before the rewind is gone, so it can't come back."))?;
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        let still = move || me.rewind_blocked(&s, &i, true);
        let r = block(rewind::apply_undo(&u, &file, id, files, &still)).map_err(conflict_or)?;
        self.recoverable(slug, id)?;
        let mut p = obj(json!({ "rewindUndo": null, "lastActivity": null }));
        if u.get("newSessionId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
            p.extend(obj(json!({ "sessionId": u_sid, "sessionStarted": true, "freshSession": false })));
        }
        p.insert("lastActivityAt".into(), Value::Null);
        self.patch(slug, id, p)?;
        Ok(r)
    }

    /// `dropRewindCopies`: the ticket's saved copies for Rewind, wherever its Claude worked. Report-only unless deletes
    /// are on (plan 5.3), like the other cleanups of the Rust board.
    pub fn drop_rewind_copies(&self, slug: &str, t: &Map<String, Value>) {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let mut dirs: Vec<PathBuf> = Vec::new();
        let path = self.profile(slug).and_then(|p| p.get("path").and_then(Value::as_str).map(str::to_string));
        for d in [path, t.get("workdir").and_then(Value::as_str).map(str::to_string)].into_iter().flatten() {
            let d = PathBuf::from(d);
            if !d.as_os_str().is_empty() && d.exists() && !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        if dirs.is_empty() {
            return;
        }
        if !crate::dryrun::deletes_on() {
            for d in &dirs {
                let mut m = Map::new();
                m.insert("board".into(), json!(slug));
                m.insert("ticket".into(), json!(id));
                m.insert("path".into(), json!(d.to_string_lossy()));
                m.insert("action".into(), json!("drop rewind copies"));
                crate::dryrun::report(&self.root, "rewind-copies", m);
            }
            return;
        }
        let work = async move {
            for d in dirs {
                rewind::delete_snapshots(&d, &id).await;
            }
        };
        self.rt.spawn(work);
    }

    /// `forkTicket`: a new ticket like Branch whose chat ends just before the user's message `uuid`.
    pub fn fork_ticket(self: &Arc<Self>, slug: &str, id: &str, uuid: &str) -> Result<(Arc<Tk>, Option<String>), RunError> {
        let src = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let _guard = self.begin_rewind(slug, id)?;
        let list = self.tickets.list(slug);
        let title = fork_title(&src.title, list.tickets.iter().map(|t| t.title.as_str()), None);
        block(self.copy_ticket_before(slug, id, &title, Some(uuid)))
    }

    /// `planningCommand`: the terminal command that opens this ticket's Planning chat in Claude Code.
    pub fn planning_command(&self, slug: &str, id: &str) -> Result<String, String> {
        let s = block(self.git.ensure_session(slug, id))?;
        let t = self.get(slug, id).ok_or_else(|| format!("ticket {id} not found"))?;
        let file = self.tickets.ticket_dir(slug, id).join("ticket.md");
        let prompt = crate::prompts::planning::planning_prompt(&crate::runloop::prompt::prompt_ticket(&t), &file.to_string_lossy());
        let prompt = crate::quickchat::text::localize_attachments(&prompt, &crate::tickets::files::attachments_dir(&self.root));
        Ok(crate::prompts::planning::planning_command(&s.dir.to_string_lossy(), &s.session_id, &prompt, s.existed))
    }
}

/// `claudeSessionFile`: the transcript of a session, wherever Claude keeps it.
pub fn session_file(sid: &str) -> Option<PathBuf> {
    if sid.is_empty() {
        return None;
    }
    crate::sessions::files::find_session_file(&crate::sessions::files::projects_dir(None), sid)
}

/// The folder as text.
pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
