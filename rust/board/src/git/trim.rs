//! The package trim and Free up space. A Done ticket whose copy of the folder is kept (it has changes that aren't
//! saved or pushed, so the cleanup leaves it) still holds its installed packages, about 2 GB each. Once the ticket has
//! been Done for `TRIM_AFTER_MS`, `trim_done_packages` removes only its dependency folders (`DEPENDENCY_DIRS`:
//! `node_modules` at any depth, `.venv`, `__pycache__`...), sets `setupPending: true` so the board's setup command
//! installs them again when the ticket is reopened or runs, and marks it `depsTrimmedAt` so later passes skip it
//! (a successful setup clears the mark, `landing.rs` `run_setup`).
//!
//! Safety: only Done tickets that aren't running, with a copy inside the board's own copies folder
//! (`<project>/../.ckanban-worktrees/<board>/<ticket id>`, a linked git worktree, never the project folder); only
//! folders with one of those names that git ignores and tracks no file in (never inside another repo), in a board with a setup command (else the
//! packages wouldn't come back); `.git` is never gone into and symlinks are never followed or removed. The ticket's
//! status, running state and the copy are checked again right before deleting, with the ticket's session lock held
//! (a run starting meanwhile waits for it, then sees `setupPending`).
//!
//! It follows `dryrun::deletes_on()`: with deletes off it only reports (job `package-trim`). The background job runs
//! once after the start-up sweep, then hourly (`start`); `free_up` runs the sweep and the trim at once without the
//! wait, for the low-disk banner's Free up space button (`POST /api/disk/free-up`, `GET` for its progress).
//!
//! Candidates come from the board index (`BoardOps::trim_candidates`), never from reading every ticket file; the file
//! work is on the blocking pool, one ticket at a time.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::landing::Git;
use super::ops::{s, set, truthy};
use super::repo;
use crate::dryrun;
use crate::huddles::output_copies::DEPENDENCY_DIRS;

/// How long a ticket stays Done before its packages are trimmed (3 days).
pub const TRIM_AFTER_MS: f64 = 3.0 * 86_400_000.0;
/// How often the background trim looks again.
pub const TRIM_EVERY: Duration = Duration::from_secs(3600);
/// The ticket field that marks a trimmed copy.
pub const TRIMMED_AT: &str = "depsTrimmedAt";

/// A Done ticket the index says still has a copy and wasn't trimmed: its id and when it went Done (ms; None when
/// the ticket has no `doneAt`/`updatedAt` date).
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub done_at: Option<f64>,
}

/// A ticket's JSON as a trim candidate, if it is one.
pub fn candidate(t: &Map<String, Value>) -> Option<Candidate> {
    let st = |k: &str| t.get(k).and_then(Value::as_str).filter(|x| !x.is_empty());
    if st("status") != Some("done") || st("worktree").is_none() || ckanban_core::jsnum::truthy(t.get(TRIMMED_AT)) {
        return None;
    }
    let done_at = st("doneAt").or_else(|| st("updatedAt")).and_then(ckanban_core::time::parse_date);
    Some(Candidate { id: st("id")?.to_string(), done_at })
}

/// What a trim pass did.
#[derive(Debug, Default, Clone)]
pub struct Trimmed {
    /// Tickets whose packages were removed (or would be, with deletes off).
    pub tickets: Vec<String>,
    pub bytes: u64,
    /// The decisions, as logged with deletes off.
    pub decisions: Vec<Value>,
}

/// The size in bytes of the files under `dir` (symlinks counted as themselves, never followed).
pub fn tree_size(dir: &Path) -> u64 {
    let Ok(m) = fs::symlink_metadata(dir) else { return 0 };
    if !m.is_dir() {
        return m.len();
    }
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                stack.push(e.path());
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

/// The dependency folders in a copy: every folder named in `DEPENDENCY_DIRS` (not gone into), never inside `.git`,
/// never through a symlink. Paths relative to `root`.
pub fn find_dependency_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let Ok(rd) = fs::read_dir(root.join(&rel)) else { continue };
        for e in rd.flatten() {
            // `file_type` doesn't follow symlinks: a linked folder is neither gone into nor picked.
            let Ok(kind) = e.file_type() else { continue };
            if !kind.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" {
                continue;
            }
            let path = rel.join(&name);
            // Another repo inside the copy (its own `.git`): not the copy's files, never gone into.
            if fs::symlink_metadata(root.join(&path).join(".git")).is_ok() {
                continue;
            }
            if DEPENDENCY_DIRS.contains(&name.as_str()) {
                out.push(path);
            } else {
                stack.push(path);
            }
        }
    }
    out.sort();
    out
}

fn git_in(root: &Path, args: &[&str], path: &Path) -> Option<std::process::Output> {
    std::process::Command::new("git")
        .args(args)
        .arg(path)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
}

/// Of `dirs` (relative to the copy `root`), the ones git ignores and tracks no file in: a `.cache` or `venv` folder
/// that is in the version history, or new and not ignored (someone's unsaved work), stays. None when git fails (then
/// nothing is removed and the ticket isn't marked, so a later pass tries again).
fn ignored_only(root: &Path, dirs: Vec<PathBuf>) -> Option<Vec<PathBuf>> {
    let mut out = Vec::new();
    for d in dirs {
        // `check-ignore -q`: 0 ignored, 1 not ignored, anything else an error.
        let ignored = git_in(root, &["check-ignore", "-q", "--"], &d)?;
        match ignored.status.code() {
            Some(0) => {}
            Some(1) => continue,
            _ => return None,
        }
        let tracked = git_in(root, &["ls-files", "-z", "--"], &d)?;
        if !tracked.status.success() {
            return None;
        }
        if tracked.stdout.is_empty() {
            out.push(d);
        }
    }
    Some(out)
}

/// Removes the dependency folders `dirs` (relative to `root`); the bytes they held. Each must still be a real folder
/// (not a symlink) directly under the copy's real path.
fn remove_dirs(root: &Path, dirs: &[PathBuf]) -> u64 {
    let Ok(real_root) = fs::canonicalize(root) else { return 0 };
    let mut freed = 0;
    for rel in dirs {
        let p = root.join(rel);
        let Ok(m) = fs::symlink_metadata(&p) else { continue };
        if !m.is_dir() {
            continue;
        }
        // The parent's real path must be inside the copy (a folder on the way swapped for a symlink is skipped).
        match p.parent().and_then(|x| fs::canonicalize(x).ok()) {
            Some(parent) if parent.starts_with(&real_root) => {}
            _ => continue,
        }
        let size = tree_size(&p);
        // `remove_dir_all` never follows symlinks inside the folder.
        if fs::remove_dir_all(&p).is_ok() {
            freed += size;
        } else {
            freed += size.saturating_sub(tree_size(&p));
        }
    }
    freed
}

/// The ticket's copy is the board's own: `<copies folder>/<ticket id>` by the board's rule, a linked worktree (`.git`
/// is a file there), not the project folder.
fn is_ticket_copy(project: &Path, slug: &str, id: &str, wt: &Path) -> bool {
    if !ckanban_core::layout::is_ticket_id(id) {
        return false;
    }
    let want = repo::worktree_dir(project, slug, id);
    let same = wt == want || matches!((fs::canonicalize(wt), fs::canonicalize(&want)), (Ok(a), Ok(b)) if a == b);
    same && fs::symlink_metadata(wt.join(".git")).is_ok_and(|m| m.is_file()) && fs::canonicalize(wt).ok() != fs::canonicalize(project).ok()
}

fn decision(slug: &str, id: &str, wt: &Path, action: &str, reason: Option<&str>, dirs: &[PathBuf]) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("board".into(), json!(slug));
    m.insert("ticket".into(), json!(id));
    m.insert("path".into(), json!(wt.to_string_lossy()));
    m.insert("action".into(), json!(action));
    if let Some(r) = reason {
        m.insert("reason".into(), json!(r));
    }
    if !dirs.is_empty() {
        m.insert("dirs".into(), json!(dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>()));
    }
    m
}

impl Git {
    /// One trim pass over every board: Done tickets with a kept copy, Done for at least `wait_ms` (0: no wait).
    /// `deleting` false only reports. One pass at a time; never fails.
    pub async fn trim_done_packages(self: &Arc<Self>, wait_ms: f64, deleting: bool) -> Trimmed {
        let _one = self.trim_gate.lock().await;
        let mut out = Trimmed::default();
        let now = ckanban_core::time::now_ms();
        let ops = self.ops.clone();
        let profiles = tokio::task::spawn_blocking(move || ops.profiles()).await.unwrap_or_default();
        for profile in profiles {
            let (Some(slug), Some(path)) = (s(&profile, "slug").map(str::to_string), s(&profile, "path").map(PathBuf::from)) else { continue };
            let has_setup = s(&profile, "setupCommand").is_some_and(|c| !c.trim().is_empty());
            let (ops, sl) = (self.ops.clone(), slug.clone());
            let cands = tokio::task::spawn_blocking(move || ops.trim_candidates(&sl)).await.unwrap_or_default();
            for c in cands {
                if wait_ms > 0.0 && c.done_at.is_none_or(|d| now - d < wait_ms) {
                    continue;
                }
                // Report-only: the hourly pass logs each copy once per daemon start, not every hour.
                let k = format!("{slug}/{}", c.id);
                if !deleting && wait_ms > 0.0 && self.trim_reported.lock().contains(&k) {
                    continue;
                }
                if !deleting && wait_ms > 0.0 {
                    self.trim_reported.lock().insert(k);
                }
                if let Some(d) = self.trim_one(&slug, &c.id, &path, has_setup, deleting).await {
                    if s(&Value::Object(d.0.clone()), "action") == Some("trim") {
                        out.tickets.push(c.id.clone());
                        out.bytes += d.1;
                    }
                    out.decisions.push(Value::Object(d.0));
                }
            }
        }
        out
    }

    /// Trims one ticket's copy, re-checking everything first with its session lock held. None: not a candidate any
    /// more (left alone without a note); else the decision and the bytes freed.
    async fn trim_one(self: &Arc<Self>, slug: &str, id: &str, project: &Path, has_setup: bool, deleting: bool) -> Option<(Map<String, Value>, u64)> {
        // A run or a copy being made for this ticket right now: skip it this time.
        let lock = self.session_lock(slug, id);
        let held = lock.try_lock().ok()?;
        let out = self.trim_locked(slug, id, project, has_setup, deleting).await;
        drop(held);
        self.drop_session_lock(slug, id, &lock);
        out
    }

    async fn trim_locked(&self, slug: &str, id: &str, project: &Path, has_setup: bool, deleting: bool) -> Option<(Map<String, Value>, u64)> {
        let fresh = |t: &Value| s(t, "status") == Some("done") && set(t, "worktree").is_some() && !truthy(t, TRIMMED_AT);
        let t = self.ops.ticket(slug, id).filter(|t| fresh(t))?;
        if self.ops.busy(slug, id) || self.ops.is_running(slug, id) || self.setup_running(slug, id) {
            return None;
        }
        let wt = PathBuf::from(set(&t, "worktree")?);
        if !wt.exists() {
            return None;
        }
        let keep = |why: &str| {
            let d = decision(slug, id, &wt, "keep", Some(why), &[]);
            if !deleting {
                dryrun::report(&self.root, "package-trim", d.clone());
            }
            Some((d, 0))
        };
        if !is_ticket_copy(project, slug, id, &wt) {
            return keep("not the board's own copy of the folder");
        }
        if !has_setup {
            return keep("the board has no setup command to install the packages again");
        }
        let w = wt.clone();
        let dirs = tokio::task::spawn_blocking(move || {
            let found = find_dependency_dirs(&w);
            ignored_only(&w, found)
        })
        .await
        .ok()
        .flatten();
        // Git couldn't answer: nothing removed, not marked, tried again next pass.
        let Some(dirs) = dirs else { return keep("git couldn't say which folders are ignored") };
        if dirs.is_empty() {
            // Nothing to remove: marked, so later passes don't walk it again.
            if deleting {
                let mut p = Map::new();
                p.insert(TRIMMED_AT.into(), json!(ckanban_core::time::iso(ckanban_core::time::now_ms())));
                let _ = self.ops.patch(slug, id, p);
            }
            return None;
        }
        let d = decision(slug, id, &wt, "trim", None, &dirs);
        if !deleting {
            dryrun::report(&self.root, "package-trim", d.clone());
            return Some((d, 0));
        }
        // Last look right before deleting: still Done, still not running, still this copy.
        let now = self.ops.ticket(slug, id)?;
        if !fresh(&now) || set(&now, "worktree") != Some(&*wt.to_string_lossy()) || self.ops.busy(slug, id) || self.ops.is_running(slug, id) {
            return None;
        }
        // Packages to install again before they go: a run that starts after this sees it.
        let mut p = Map::new();
        p.insert("setupPending".into(), json!(true));
        self.ops.patch(slug, id, p).ok()?;
        let w = wt.clone();
        let freed = tokio::task::spawn_blocking(move || remove_dirs(&w, &dirs)).await.unwrap_or(0);
        let mut p = Map::new();
        p.insert(TRIMMED_AT.into(), json!(ckanban_core::time::iso(ckanban_core::time::now_ms())));
        let _ = self.ops.patch(slug, id, p);
        eprintln!("ticket {slug}/{id}: removed installed packages from its kept copy ({freed} bytes); they install again when it runs");
        let mut d = d;
        d.insert("bytes".into(), json!(freed));
        Some((d, freed))
    }

    /// Free up space now: the clean Done copies removed (the sweep) and every kept Done copy's packages trimmed,
    /// without the 3-day wait. Progress and the result in `free_up_status`. False when one is already running.
    pub fn start_free_up(self: &Arc<Self>) -> bool {
        let deleting = dryrun::deletes_on();
        {
            let mut st = self.free_up.lock();
            if st.get("state").and_then(Value::as_str) == Some("running") {
                return false;
            }
            *st = json!({
                "state": "running", "phase": "removing", "reportOnly": !deleting,
                "startedAt": ckanban_core::time::iso(ckanban_core::time::now_ms()), "finishedAt": null,
                "bytesFreed": 0, "foldersRemoved": 0, "foldersTrimmed": 0,
            });
        }
        self.free_up_changed();
        let me = self.clone();
        tokio::spawn(async move {
            // Its own task: a panic in it still ends the status (with what was freed so far), never stuck "running".
            let inner = me.clone();
            let r = tokio::spawn(async move { inner.free_up(deleting).await }).await;
            {
                let mut st = me.free_up.lock();
                st["state"] = json!("done");
                st["phase"] = Value::Null;
                st["finishedAt"] = json!(ckanban_core::time::iso(ckanban_core::time::now_ms()));
                match r {
                    Ok(r) => {
                        st["bytesFreed"] = json!(r.0);
                        st["foldersRemoved"] = json!(r.1);
                        st["foldersTrimmed"] = json!(r.2);
                    }
                    Err(e) => st["error"] = json!(format!("Free up space stopped early: {e}")),
                }
            }
            me.free_up_changed();
        });
        true
    }

    /// The sweep, then the trim with no wait: (bytes freed, copies removed, copies trimmed).
    pub async fn free_up(self: &Arc<Self>, deleting: bool) -> (u64, usize, usize) {
        let swept = self.sweep_worktrees_with(deleting, true).await;
        {
            let mut st = self.free_up.lock();
            st["phase"] = json!("trimming");
            st["bytesFreed"] = json!(swept.bytes);
            st["foldersRemoved"] = json!(swept.removed);
        }
        self.free_up_changed();
        let trimmed = self.trim_done_packages(0.0, deleting).await;
        (swept.bytes + trimmed.bytes, swept.removed, trimmed.tickets.len())
    }

    /// `GET /api/disk/free-up`: the last Free up space (`state` "idle" before any).
    pub fn free_up_status(&self) -> Value {
        self.free_up.lock().clone()
    }

    fn free_up_changed(&self) {
        let st = self.free_up_status();
        let f = self.on_free_up.lock().clone();
        if let Some(f) = f {
            f(&st);
        }
    }

    /// Called with the status whenever Free up space moves on (the server sends it as a `disk.freeup` event).
    pub fn on_free_up(&self, f: impl Fn(&Value) + Send + Sync + 'static) {
        *self.on_free_up.lock() = Some(Arc::new(f));
    }
}

/// The background trim: once now (after the start-up sweep), then every `TRIM_EVERY`; runs until its task is aborted.
pub async fn run_forever(git: Arc<Git>) {
    loop {
        git.trim_done_packages(TRIM_AFTER_MS, dryrun::deletes_on()).await;
        tokio::time::sleep(TRIM_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::ops::BoardOps;
    use crate::git::ops::mem::MemBoard;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        let o = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    }

    /// A project with a committed `src/` and a tracked `.cache/keep.txt`, and the board's copy for each ticket id,
    /// each with packages, an `.env`, a change not committed and a `.git` file.
    struct Fx {
        _t: tempfile::TempDir,
        data: PathBuf,
        project: PathBuf,
        board: Arc<MemBoard>,
        git: Arc<Git>,
    }

    fn days_ago(n: f64) -> String {
        ckanban_core::time::iso(ckanban_core::time::now_ms() - n * 86_400_000.0)
    }

    fn fixture() -> Fx {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let project = t.path().join("proj");
        fs::create_dir_all(project.join("src")).unwrap();
        fs::create_dir_all(project.join(".cache")).unwrap();
        fs::write(project.join("src/a.ts"), "a").unwrap();
        fs::write(project.join(".cache/keep.txt"), "tracked").unwrap();
        fs::write(project.join(".gitignore"), "node_modules\n.env\n.venv\n__pycache__\n").unwrap();
        sh(&project, &["init", "-q", "-b", "main"]);
        sh(&project, &["add", "."]);
        sh(&project, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first"]);
        let board = Arc::new(MemBoard::default());
        board.add_profile(json!({ "slug": "p", "path": project.to_string_lossy(), "setupCommand": "bun install" }));
        let git = Git::new(&data, board.clone());
        Fx { _t: t, data, project, board, git }
    }

    impl Fx {
        fn copy(&self, id: &str, status: &str, done_days: f64) -> PathBuf {
            let wt = repo::worktree_dir(&self.project, "p", id);
            sh(&self.project, &["worktree", "add", "-q", "-b", &format!("ck/{id}"), &wt.to_string_lossy()]);
            fs::create_dir_all(wt.join("node_modules/pkg/lib")).unwrap();
            fs::write(wt.join("node_modules/pkg/lib/index.js"), "x".repeat(1000)).unwrap();
            fs::create_dir_all(wt.join("packages/ui/node_modules/dep")).unwrap();
            fs::write(wt.join("packages/ui/node_modules/dep/i.js"), "y".repeat(500)).unwrap();
            fs::create_dir_all(wt.join("py/__pycache__")).unwrap();
            fs::write(wt.join("py/__pycache__/m.pyc"), "z").unwrap();
            fs::write(wt.join(".env"), "SECRET=1").unwrap();
            fs::write(wt.join("src/a.ts"), "changed, not committed").unwrap();
            self.board.add("p", json!({ "id": id, "status": status, "worktree": wt.to_string_lossy(), "doneAt": days_ago(done_days) }));
            wt
        }
        fn log(&self) -> Vec<Value> {
            ckanban_core::jsonl::read_all(&dryrun::log_path(&self.data)).unwrap_or_default()
        }
    }

    fn untouched(wt: &Path) {
        assert_eq!(fs::read_to_string(wt.join("src/a.ts")).unwrap(), "changed, not committed");
        assert_eq!(fs::read_to_string(wt.join(".env")).unwrap(), "SECRET=1");
        assert_eq!(fs::read_to_string(wt.join(".cache/keep.txt")).unwrap(), "tracked");
        assert!(wt.join(".git").is_file());
    }

    #[test]
    fn finds_dependency_folders_at_any_depth_but_not_in_git_or_through_links() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join("node_modules/a/node_modules")).unwrap();
        fs::create_dir_all(r.join("apps/web/.next")).unwrap();
        fs::create_dir_all(r.join(".git/node_modules")).unwrap();
        fs::create_dir_all(r.join("src")).unwrap();
        std::os::unix::fs::symlink(r.join("apps"), r.join("linked")).unwrap();
        let got = find_dependency_dirs(r);
        assert_eq!(got, [PathBuf::from("apps/web/.next"), PathBuf::from("node_modules")]);
    }

    #[tokio::test]
    async fn waits_three_days_then_trims_only_packages_and_marks_setup() {
        let fx = fixture();
        let old = fx.copy("t_20260101_old1", "done", 4.0);
        let young = fx.copy("t_20260101_new1", "done", 1.0);
        let r = fx.git.trim_done_packages(TRIM_AFTER_MS, true).await;
        assert_eq!(r.tickets, ["t_20260101_old1"]);
        assert_eq!(r.bytes, 1501);
        assert!(!old.join("node_modules").exists() && !old.join("packages/ui/node_modules").exists() && !old.join("py/__pycache__").exists());
        assert!(old.join("packages/ui").is_dir() && old.join("py").is_dir());
        untouched(&old);
        let t = fx.board.get("p", "t_20260101_old1");
        assert_eq!(t["setupPending"], true);
        assert!(t[TRIMMED_AT].is_string());
        // Not Done long enough: left as it is.
        assert!(young.join("node_modules/pkg/lib/index.js").exists());
        assert!(fx.board.get("p", "t_20260101_new1").get("setupPending").is_none());
        // Marked: the next pass skips it.
        assert!(fx.git.trim_done_packages(TRIM_AFTER_MS, true).await.tickets.is_empty());
    }

    #[tokio::test]
    async fn skips_running_and_not_done_tickets() {
        let fx = fixture();
        let running = fx.copy("t_20260101_run1", "done", 9.0);
        let review = fx.copy("t_20260101_rev1", "review", 9.0);
        fx.board.running.lock().push("t_20260101_run1".into());
        let r = fx.git.trim_done_packages(0.0, true).await;
        assert!(r.tickets.is_empty());
        assert!(running.join("node_modules").exists() && review.join("node_modules").exists());
        assert!(fx.board.get("p", "t_20260101_run1").get(TRIMMED_AT).is_none());
        // A copy being made or a run starting (its session lock held) is skipped too.
        fx.board.running.lock().clear();
        let lock = fx.git.session_lock("p", "t_20260101_run1");
        let held = lock.lock().await;
        assert!(fx.git.trim_done_packages(0.0, true).await.tickets.is_empty());
        drop(held);
        assert!(running.join("node_modules").exists());
    }

    #[tokio::test]
    async fn never_touches_a_copy_outside_the_copies_folder_or_tracked_folders() {
        let fx = fixture();
        // A Done ticket that worked in the project folder itself.
        fs::create_dir_all(fx.project.join("node_modules/x")).unwrap();
        fx.board.add("p", json!({ "id": "t_20260101_inpl", "status": "done", "worktree": fx.project.to_string_lossy(), "doneAt": days_ago(9.0) }));
        let r = fx.git.trim_done_packages(0.0, true).await;
        assert!(r.tickets.is_empty());
        assert!(fx.project.join("node_modules/x").exists());
        // `.cache` is in the project's version history: kept even though it is a dependency name.
        let wt = fx.copy("t_20260101_cch1", "done", 9.0);
        fx.git.trim_done_packages(0.0, true).await;
        untouched(&wt);
        assert!(!wt.join("node_modules").exists());
    }

    #[tokio::test]
    async fn keeps_dependency_named_folders_git_doesnt_ignore_and_other_repos() {
        let fx = fixture();
        let wt = fx.copy("t_20260101_ign1", "done", 9.0);
        // New work in folders with dependency names, not ignored: someone's unsaved files.
        fs::create_dir_all(wt.join("src/venv")).unwrap();
        fs::write(wt.join("src/venv/settings.py"), "mine").unwrap();
        fs::create_dir_all(wt.join("tools/.next")).unwrap();
        fs::write(wt.join("tools/.next/notes.md"), "mine").unwrap();
        // Another repo inside the copy: never gone into, even for an ignored name.
        let sub = wt.join("vendor/lib");
        fs::create_dir_all(sub.join("node_modules/x")).unwrap();
        sh(&sub, &["init", "-q", "-b", "main"]);
        let r = fx.git.trim_done_packages(0.0, true).await;
        assert_eq!(r.tickets, ["t_20260101_ign1"]);
        assert!(!wt.join("node_modules").exists());
        assert_eq!(fs::read_to_string(wt.join("src/venv/settings.py")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(wt.join("tools/.next/notes.md")).unwrap(), "mine");
        assert!(sub.join("node_modules/x").is_dir());
        untouched(&wt);
    }

    #[tokio::test]
    async fn git_failing_removes_nothing_and_leaves_the_ticket_for_later() {
        let fx = fixture();
        let wt = fx.copy("t_20260101_gfl1", "done", 9.0);
        // The copy's link to the repo is broken: git can't answer in it.
        fs::write(wt.join(".git"), "gitdir: /nonexistent/ckanban-trim-test\n").unwrap();
        let r = fx.git.trim_done_packages(0.0, true).await;
        assert!(r.tickets.is_empty());
        assert!(wt.join("node_modules/pkg/lib/index.js").exists());
        let t = fx.board.get("p", "t_20260101_gfl1");
        assert!(t.get(TRIMMED_AT).is_none() && t.get("setupPending").is_none());
    }

    #[tokio::test]
    async fn the_sweep_leaves_a_copy_whose_session_lock_is_held() {
        let fx = fixture();
        let clean = repo::worktree_dir(&fx.project, "p", "t_20260101_lck1");
        sh(&fx.project, &["worktree", "add", "-q", "-b", "ck/lck1", &clean.to_string_lossy()]);
        fx.board.add("p", json!({ "id": "t_20260101_lck1", "status": "done", "worktree": clean.to_string_lossy() }));
        let lock = fx.git.session_lock("p", "t_20260101_lck1");
        let held = lock.lock().await;
        assert_eq!(fx.git.sweep_worktrees_with(true, true).await.removed, 0);
        assert!(clean.exists());
        drop(held);
        fx.git.drop_session_lock("p", "t_20260101_lck1", &lock);
        drop(lock);
        // Not Done any more: kept.
        fx.board.patch("p", "t_20260101_lck1", crate::git::ops::patch1("status", json!("in_progress"))).unwrap();
        assert_eq!(fx.git.sweep_worktrees_with(true, true).await.removed, 0);
        fx.board.patch("p", "t_20260101_lck1", crate::git::ops::patch1("status", json!("done"))).unwrap();
        assert_eq!(fx.git.sweep_worktrees_with(true, true).await.removed, 1);
        assert!(!clean.exists());
    }

    #[tokio::test]
    async fn report_only_when_deletes_are_off() {
        let fx = fixture();
        let wt = fx.copy("t_20260101_rep1", "done", 9.0);
        let r = fx.git.trim_done_packages(TRIM_AFTER_MS, false).await;
        assert_eq!(r.tickets, ["t_20260101_rep1"]);
        assert_eq!(r.bytes, 0);
        assert!(wt.join("node_modules/pkg/lib/index.js").exists() && wt.join("py/__pycache__").exists());
        let t = fx.board.get("p", "t_20260101_rep1");
        assert!(t.get("setupPending").is_none() && t.get(TRIMMED_AT).is_none());
        let log = fx.log();
        assert_eq!(log.len(), 1);
        assert_eq!((log[0]["job"].as_str(), log[0]["action"].as_str()), (Some("package-trim"), Some("trim")));
        assert_eq!(log[0]["dirs"], json!(["node_modules", "packages/ui/node_modules", "py/__pycache__"]));
        // The hourly pass logs it once, not every hour.
        fx.git.trim_done_packages(TRIM_AFTER_MS, false).await;
        assert_eq!(fx.log().len(), 1);
    }

    #[tokio::test]
    async fn free_up_ignores_the_wait_and_removes_clean_done_copies() {
        let fx = fixture();
        let kept = fx.copy("t_20260101_frk1", "done", 0.0);
        // A clean Done copy: the sweep removes it whole.
        let clean = repo::worktree_dir(&fx.project, "p", "t_20260101_cln1");
        sh(&fx.project, &["worktree", "add", "-q", "-b", "ck/cln1", &clean.to_string_lossy()]);
        fs::write(clean.join("big.bin"), vec![0u8; 4000]).ok();
        fs::write(fx.project.join(".gitignore"), "node_modules\n.env\n.venv\n__pycache__\nbig.bin\n").unwrap();
        fs::write(clean.join(".gitignore"), "node_modules\n.env\n.venv\n__pycache__\nbig.bin\n").unwrap();
        sh(&clean, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "ignore big"]);
        fx.board.add("p", json!({ "id": "t_20260101_cln1", "status": "done", "worktree": clean.to_string_lossy(), "doneAt": days_ago(0.0) }));
        let (bytes, removed, trimmed) = fx.git.free_up(true).await;
        assert_eq!((removed, trimmed), (1, 1));
        assert!(!clean.exists());
        assert!(fx.board.get("p", "t_20260101_cln1")["worktree"].is_null());
        assert!(!kept.join("node_modules").exists());
        untouched(&kept);
        assert!(bytes >= 4000 + 1501, "{bytes}");
        assert_eq!(fx.board.get("p", "t_20260101_frk1")["setupPending"], true);
    }

    #[tokio::test]
    async fn free_up_status_moves_from_idle_to_done() {
        let fx = fixture();
        assert_eq!(fx.git.free_up_status()["state"], "idle");
        let seen = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        fx.git.on_free_up(move |st| s2.lock().push(st["state"].as_str().unwrap_or("").to_string()));
        assert!(fx.git.start_free_up());
        for _ in 0..200 {
            if fx.git.free_up_status()["state"] == "done" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let st = fx.git.free_up_status();
        assert_eq!(st["state"], "done");
        assert!(st["finishedAt"].is_string() && st["bytesFreed"].is_number());
        assert_eq!(seen.lock().last().map(String::as_str), Some("done"));
    }

    #[test]
    fn candidates_are_done_tickets_with_a_copy_not_yet_trimmed() {
        let m = |v: Value| v.as_object().unwrap().clone();
        assert!(candidate(&m(json!({ "id": "a", "status": "done", "worktree": "/w" }))).is_some());
        assert!(candidate(&m(json!({ "id": "a", "status": "review", "worktree": "/w" }))).is_none());
        assert!(candidate(&m(json!({ "id": "a", "status": "done", "worktree": null }))).is_none());
        assert!(candidate(&m(json!({ "id": "a", "status": "done", "worktree": "/w", "depsTrimmedAt": "x" }))).is_none());
        assert_eq!(candidate(&m(json!({ "id": "a", "status": "done", "worktree": "/w", "doneAt": "2026-11-15T00:00:00.000Z" }))).unwrap().done_at, ckanban_core::time::parse_date("2026-11-15T00:00:00.000Z"));
    }
}
