//! The leftover sweep over huddle helpers' copies: `<copies>/<board>/<ticket>.huddle/<handle>` (`agent_dir`). A
//! huddle's close removes its helpers' copies, but one closed while deletes were off, or cut off by a stop, leaves
//! them behind for good, since the ticket sweep only looks at folders named like a ticket id.
//!
//! A copy goes when its ticket is Done (or deleted), nothing works on the ticket (no run, no open huddle) and the copy
//! holds nobody's work: no unsaved changes in a git copy, nothing a helper never handed in. Saved work next to the
//! copies (`<handle>.kept`, `<handle>.handins`) always stays, and a branch a copy was on is never deleted. Each
//! decision is logged when deletes are off (`dryrun.rs`, job `huddle-copy-sweep`).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::landing::{Git, Swept};
use super::ops::s;
use crate::dryrun;
use crate::huddles::{copies, workspace as ws};

pub const SUFFIX: &str = ".huddle";

/// Folders of saved helper work next to the copies: never removed by the sweep.
const KEPT_SUFFIXES: [&str; 3] = [".kept", ".handins", ".copy.json"];

/// What the sweep decides about one helper's copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Remove { git: bool },
    Keep(String),
}

async fn git_out(args: &[&str], dir: &Path) -> super::cmd::RunResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    super::cmd::run(&cmd, dir, &[], None).await
}

/// Whether one helper's copy holds anyone's work (blocking parts on the blocking pool).
pub async fn verdict(dir: &Path) -> Verdict {
    let git = dir.join(".git").exists();
    let d = dir.to_string_lossy().into_owned();
    if copies::state_file(&d).exists() {
        let kind = if git { "git" } else { "folder" };
        match tokio::task::spawn_blocking(move || ws::unhanded(&d, kind)).await {
            Ok(Ok(false)) => {}
            Ok(Ok(true)) => return Verdict::Keep("it has changes the helper never handed in".into()),
            Ok(Err(e)) => return Verdict::Keep(format!("couldn't check it: {e}")),
            Err(e) => return Verdict::Keep(format!("couldn't check it: {e}")),
        }
    } else if !git {
        return Verdict::Keep("a plain folder with no record of what it started from".into());
    }
    if git {
        // No optional locks: looking must not refresh the copy's index or take its lock.
        let st = git_out(&["--no-optional-locks", "status", "--porcelain"], dir).await;
        if !st.ok() {
            return Verdict::Keep(format!("couldn't check it: {}", st.stderr.trim()));
        }
        if !st.out().is_empty() {
            return Verdict::Keep("it has unsaved changes".into());
        }
    }
    Verdict::Remove { git }
}

fn entries(dir: PathBuf) -> Vec<(String, PathBuf)> {
    let Ok(rd) = fs::read_dir(&dir) else { return Vec::new() };
    let mut v: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    v.sort();
    v
}

fn decision(slug: &str, id: &str, dir: &Path, action: &str, reason: Option<&str>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("board".into(), json!(slug));
    m.insert("ticket".into(), json!(id));
    m.insert("path".into(), json!(dir.to_string_lossy()));
    m.insert("action".into(), json!(action));
    if let Some(r) = reason {
        m.insert("reason".into(), json!(r));
    }
    m
}

impl Git {
    /// The ticket may lose its helpers' copies now: Done, or gone (and not merely unreadable), with no run, setup or
    /// open huddle on it.
    fn huddle_copies_free(&self, slug: &str, id: &str) -> bool {
        if self.ops.busy(slug, id) || self.setup_running(slug, id) {
            return false;
        }
        match self.ops.ticket(slug, id) {
            Some(t) => s(&t, "status") == Some("done"),
            None => !ckanban_core::DataDir::new(self.root.clone()).ticket_dir(slug, id).join("ticket.md").exists(),
        }
    }

    /// The huddle part of the sweep for one board's copies folder `root`. `limit`: copies it may still remove.
    pub(super) async fn sweep_huddle_copies(&self, slug: &str, root: &Path, deleting: bool, measure: bool, limit: Option<usize>) -> Swept {
        let mut out = Swept::default();
        let r = root.to_path_buf();
        let folders = tokio::task::spawn_blocking(move || entries(r)).await.unwrap_or_default();
        let mut kept = Vec::new();
        for (name, folder) in folders {
            let Some(id) = name.strip_suffix(SUFFIX) else { continue };
            if !ckanban_core::layout::is_ticket_id(id) || !self.huddle_copies_free(slug, id) {
                continue;
            }
            let f = folder.clone();
            let copies: Vec<(String, PathBuf)> = tokio::task::spawn_blocking(move || entries(f))
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|(n, _)| !KEPT_SUFFIXES.iter().any(|x| n.ends_with(x)))
                .collect();
            // The ticket's session lock while its helpers' copies go: a run or huddle starting now waits for it.
            let lock = self.session_lock(slug, id);
            let Ok(held) = lock.try_lock() else {
                self.drop_session_lock(slug, id, &lock);
                continue;
            };
            for (handle, dir) in copies {
                if limit.is_some_and(|l| out.removed >= l) {
                    break;
                }
                let v = verdict(&dir).await;
                if !deleting {
                    let d = match &v {
                        Verdict::Remove { .. } => decision(slug, id, &dir, "delete", None),
                        Verdict::Keep(why) => decision(slug, id, &dir, "keep", Some(why)),
                    };
                    dryrun::report(&self.root, "huddle-copy-sweep", d.clone());
                    out.decisions.push(Value::Object(d));
                    continue;
                }
                let git = match v {
                    Verdict::Keep(why) => {
                        kept.push(format!("{id}.huddle/{handle} ({why})"));
                        continue;
                    }
                    Verdict::Remove { git } => git,
                };
                // Last look right before removing.
                if !self.huddle_copies_free(slug, id) {
                    break;
                }
                let size = if measure {
                    let d = dir.clone();
                    tokio::task::spawn_blocking(move || super::trim::tree_size(&d)).await.unwrap_or(0)
                } else {
                    0
                };
                let repo = if git { Some(ws::main_repo(&dir).await) } else { None };
                // No branch: whatever a helper committed on one stays in the version history.
                ws::remove_copy(&dir, repo.as_deref(), None, true).await;
                if dir.exists() {
                    kept.push(format!("{id}.huddle/{handle} (couldn't remove it)"));
                    continue;
                }
                out.removed += 1;
                out.bytes += size;
                tokio::task::yield_now().await;
            }
            drop(held);
            self.drop_session_lock(slug, id, &lock);
            // The ticket's `.huddle` folder itself once nothing is left in it.
            if deleting {
                let f = folder.clone();
                let _ = tokio::task::spawn_blocking(move || fs::read_dir(&f).is_ok_and(|mut d| d.next().is_none()) && fs::remove_dir(&f).is_ok()).await;
            }
            if limit.is_some_and(|l| out.removed >= l) {
                break;
            }
        }
        if out.removed > 0 || !kept.is_empty() {
            let list = if kept.is_empty() { String::new() } else { format!(": {}", kept.join(", ")) };
            eprintln!("profile {slug}: swept {} huddle helper cop{}, kept {}{list}", out.removed, if out.removed == 1 { "y" } else { "ies" }, kept.len());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ops::mem::MemBoard;
    use crate::git::repo;
    use std::process::Command;
    use std::sync::Arc;

    fn sh(dir: &Path, args: &[&str]) {
        let o = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }

    struct Fx {
        _t: tempfile::TempDir,
        data: PathBuf,
        repo: PathBuf,
        board: Arc<MemBoard>,
        git: Arc<Git>,
    }

    fn fixture() -> Fx {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let repo = t.path().join("proj");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("a.txt"), "a").unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
        let board = Arc::new(MemBoard::default());
        board.add_profile(json!({ "slug": "p", "path": repo, "baseBranch": "main" }));
        let git = Git::new(&data, board.clone());
        Fx { _t: t, data, repo, board, git }
    }

    /// A read-only snapshot copy for `handle` on ticket `id`, as a huddle makes for a reviewer (detached HEAD).
    fn snapshot(fx: &Fx, id: &str, handle: &str) -> PathBuf {
        let dir = ws::agent_dir(&fx.repo, "p", id, handle);
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        sh(&fx.repo, &["worktree", "add", "-q", "--detach", &dir.to_string_lossy(), "HEAD"]);
        dir
    }

    /// An editable plain-folder copy with the board's record of what it started from.
    fn folder_copy(fx: &Fx, id: &str, handle: &str) -> PathBuf {
        let dir = ws::agent_dir(&fx.repo, "p", id, handle);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.txt"), "a").unwrap();
        let base = copies::scan(&dir, "folder").unwrap();
        copies::write_state(&dir.to_string_lossy(), &copies::CopyState { base, handed: None }).unwrap();
        dir
    }

    fn sweep_root(fx: &Fx) -> PathBuf {
        repo::worktree_dir(&fx.repo, "p", "x").parent().unwrap().to_path_buf()
    }

    #[tokio::test]
    async fn keeps_open_tickets_open_huddles_unsaved_and_unhanded_work() {
        let fx = fixture();
        let (done, open, live, gone) = ("t_20260101_done", "t_20260101_open", "t_20260101_live", "t_20260101_gone");
        fx.board.add("p", json!({ "id": done, "title": "Done", "status": "done" }));
        fx.board.add("p", json!({ "id": open, "title": "Open", "status": "review" }));
        fx.board.add("p", json!({ "id": live, "title": "Huddle open", "status": "done" }));
        // An open huddle (or a run) on the ticket makes it busy.
        fx.board.running.lock().push(live.into());
        let clean = snapshot(&fx, done, "reviewer");
        let dirty = snapshot(&fx, done, "breaker");
        fs::write(dirty.join("new.txt"), "x").unwrap();
        let unhanded = folder_copy(&fx, done, "fixer");
        fs::write(unhanded.join("a.txt"), "changed").unwrap();
        let handed = folder_copy(&fx, done, "qa");
        fs::create_dir_all(format!("{}.handins/h1", handed.display())).unwrap();
        let of_open = snapshot(&fx, open, "reviewer");
        let of_live = snapshot(&fx, live, "reviewer");
        let of_gone = snapshot(&fx, gone, "reviewer");
        // Not a ticket id: never touched.
        let odd = fx.repo.parent().unwrap().join(".ckanban-worktrees/p/notes.huddle/x");
        fs::create_dir_all(&odd).unwrap();

        // Deletes off: only decisions, all logged.
        let root = sweep_root(&fx);
        let r = fx.git.sweep_huddle_copies("p", &root, false, false, None).await;
        let mut got: Vec<(String, String)> =
            r.decisions.iter().map(|d| (d["path"].as_str().unwrap().rsplit('/').take(2).collect::<Vec<_>>().join("<"), d["action"].as_str().unwrap().to_string())).collect();
        got.sort();
        assert_eq!(
            got,
            [
                ("breaker<t_20260101_done.huddle".to_string(), "keep".to_string()),
                ("fixer<t_20260101_done.huddle".into(), "keep".into()),
                ("qa<t_20260101_done.huddle".into(), "delete".into()),
                ("reviewer<t_20260101_done.huddle".into(), "delete".into()),
                ("reviewer<t_20260101_gone.huddle".into(), "delete".into()),
            ]
        );
        assert_eq!(ckanban_core::jsonl::read_all(&dryrun::log_path(&fx.data)).unwrap().len(), 5);
        assert!(clean.exists() && handed.exists() && of_gone.exists());

        // Deletes on: clean copies of Done and deleted tickets go; everything else stays.
        let r = fx.git.sweep_huddle_copies("p", &root, true, true, None).await;
        assert_eq!(r.removed, 3);
        assert!(r.bytes > 0);
        assert!(!clean.exists() && !handed.exists() && !of_gone.exists());
        assert!(dirty.join("new.txt").exists() && unhanded.exists() && of_open.exists() && of_live.exists() && odd.exists());
        // Hand-ins stay, the copy's record goes; the deleted ticket's emptied folder goes too.
        assert!(Path::new(&format!("{}.handins/h1", handed.display())).exists());
        assert!(!copies::state_file(&handed.to_string_lossy()).exists());
        assert!(!of_gone.parent().unwrap().exists());
        // The snapshot's registration is gone from the repo.
        let list = repo::list_worktrees(&fx.repo).await;
        assert!(!list.iter().any(|w| w.ends_with("reviewer") && w.contains(done)));
    }

    #[tokio::test]
    async fn the_limited_sweep_takes_a_few_at_a_time() {
        let fx = fixture();
        let id = "t_20260101_done";
        fx.board.add("p", json!({ "id": id, "title": "Done", "status": "done" }));
        let dirs: Vec<PathBuf> = ["a", "b", "c"].iter().map(|h| snapshot(&fx, id, h)).collect();
        // A Done ticket something works on (a run, an open huddle): the hourly pass leaves its copies alone.
        let busy = "t_20260101_busy";
        fx.board.add("p", json!({ "id": busy, "title": "Busy", "status": "done" }));
        fx.board.running.lock().push(busy.into());
        let of_busy = snapshot(&fx, busy, "reviewer");
        let r = fx.git.sweep_leftovers(true, false, Some(2)).await;
        assert_eq!(r.removed, 2);
        assert_eq!(dirs.iter().filter(|d| d.exists()).count(), 1);
        let r = fx.git.sweep_leftovers(true, false, Some(2)).await;
        assert_eq!(r.removed, 1);
        assert!(dirs.iter().all(|d| !d.exists()));
        assert!(!dirs[0].parent().unwrap().exists());
        assert!(of_busy.exists());
        assert_eq!(fx.git.sweep_leftovers(true, false, Some(2)).await.removed, 0);
    }
}
