//! Project copies review helpers left in a ticket's outputs (`src/huddle/output-copies.ts`): `outputs/<handle>/copy`,
//! `.../main`, installed dependencies. When a huddle closes or its ticket moves to Done, `remove_output_copies` looks
//! only inside that huddle's helpers' folders of that one ticket's outputs and picks:
//! - dependency folders (node_modules and the like); `venv`, `.cache` and `.next` only inside a copy of the project
//!   (or a venv with its pyvenv.cfg);
//! - a checked-out copy of the project (its own .git, most of the project's top-level names), only when git says
//!   nothing in it is uncommitted or untracked and every commit it points at is in the project's own history.
//!
//! Anything else stays. A helper's folder itself is never removed, symlinks are never followed, and every pick is
//! checked to be inside the ticket's outputs folder by real path.
//!
//! In board mode this is a background delete, so it starts report-only (plan 5.3): each pick goes to
//! `<data>/rust-board-dryrun.log` (job `huddle-output-copies`) and nothing is removed, unless `CKANBAN_RUST_DELETE=1`.
//! Blocking (a folder walk and git calls): run it on the blocking pool.

use std::collections::HashSet;
use std::fs;
use std::path::{MAIN_SEPARATOR, Path};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::dryrun;
use crate::git::cmd::{RunResult, run};

/// Installed or cached files: picked wherever they sit in a helper's folder.
pub const DEPENDENCY_DIRS: [&str; 9] = ["node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", ".turbo", ".pnpm-store"];
/// Dependency names also used for other folders: picked only inside a copy of the project.
const LOOSE_DEPENDENCY_DIRS: [&str; 3] = ["venv", ".cache", ".next"];
const MAX_DEPTH: usize = 3;
const MATCH_SHARE: f64 = 0.6;
const MIN_MATCH: usize = 3;
const DEPS_ONLY_SHARE: f64 = 0.8;
const GIT_MARK: &str = ".git";
const DEP_MARKS: [&str; 3] = ["node_modules", ".venv", "venv"];
const MAX_SHAS: usize = 200;

fn dep(n: &str) -> bool {
    DEPENDENCY_DIRS.contains(&n)
}
fn loose(n: &str) -> bool {
    LOOSE_DEPENDENCY_DIRS.contains(&n)
}

/// `projectNames`: the project folder's own top-level names (hidden and dependency ones left out).
pub fn project_names(project: Option<&Path>) -> HashSet<String> {
    let Some(p) = project else { return HashSet::new() };
    let Ok(rd) = fs::read_dir(p) else { return HashSet::new() };
    rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| !n.starts_with('.') && !dep(n)).collect()
}

/// `looksLikeCopy`: `names` (a folder's entries) clearly are a checked-out or installed copy of the project.
pub fn looks_like_copy(names: &[String], project: &HashSet<String>) -> bool {
    if project.len() < MIN_MATCH {
        return false;
    }
    let git = names.iter().any(|n| n == GIT_MARK);
    let deps = DEP_MARKS.iter().any(|d| names.iter().any(|n| n == d));
    if !git && !deps {
        return false;
    }
    let (mut matched, mut other) = (0usize, 0usize);
    for n in names {
        if project.contains(n) {
            matched += 1;
        } else if !n.starts_with('.') && !dep(n) {
            other += 1;
        }
    }
    let share = if git { MATCH_SHARE } else { DEPS_ONLY_SHARE };
    let need = (if git { MIN_MATCH } else { MIN_MATCH + 1 }).max((project.len() as f64 * share).ceil() as usize);
    matched >= need && (other as f64) <= 3f64.max(matched as f64 / 2.0)
}

fn safe_handle(h: &str) -> bool {
    let mut cs = h.chars();
    let first_ok = cs.next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    first_ok && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn git_in(rt: &tokio::runtime::Handle, cwd: &Path, args: &[&str]) -> RunResult {
    let mut cmd = vec!["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
    cmd.extend_from_slice(args);
    rt.block_on(run(&cmd, cwd, &[("GIT_OPTIONAL_LOCKS", "0"), ("GIT_TERMINAL_PROMPT", "0")], Some(Duration::from_secs(30))))
}

fn installed_only(path: &str) -> bool {
    path.split('/').any(|x| dep(x) && !loose(x)) || path == ".DS_Store" || path.ends_with("/.DS_Store")
}

/// `committedElsewhere`: nothing in the checkout at `copy` would be lost by removing it.
pub fn committed_elsewhere(rt: &tokio::runtime::Handle, copy: &Path, project: Option<&Path>) -> bool {
    let Some(project) = project else { return false };
    let top = git_in(rt, copy, &["rev-parse", "--show-toplevel"]);
    if !top.ok() {
        return false;
    }
    match (fs::canonicalize(top.out()), fs::canonicalize(copy)) {
        (Ok(a), Ok(b)) if a == b => {}
        _ => return false,
    }
    let status = git_in(rt, copy, &["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]);
    if !status.ok() {
        return false;
    }
    for line in status.stdout.split('\n').filter(|l| !l.is_empty()) {
        let untracked = line.starts_with("!! ") || line.starts_with("?? ");
        let p = line.get(3..).unwrap_or("").trim_start_matches('"').trim_end_matches('"').trim_end_matches('/');
        if !untracked || !installed_only(p) {
            return false;
        }
    }
    let flags = git_in(rt, copy, &["ls-files", "-v"]);
    if !flags.ok() || flags.stdout.split('\n').any(|l| l.chars().next().is_some_and(|c| c == 'S' || c != c.to_ascii_uppercase())) {
        return false;
    }
    let head = git_in(rt, copy, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let refs = git_in(rt, copy, &["for-each-ref", "--format=%(objectname)"]);
    let reflog = git_in(rt, copy, &["reflog", "--format=%H"]);
    if !head.ok() || !refs.ok() {
        return false;
    }
    let mut shas: Vec<String> = Vec::new();
    for o in [head.stdout.as_str(), refs.stdout.as_str(), if reflog.ok() { reflog.stdout.as_str() } else { "" }] {
        for x in o.split('\n').map(str::trim).filter(|x| !x.is_empty()) {
            if !shas.iter().any(|s| s == x) {
                shas.push(x.to_string());
            }
        }
    }
    if shas.len() > MAX_SHAS {
        return false;
    }
    for sha in shas {
        if !(40..=64).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return false;
        }
        let commit = git_in(rt, copy, &["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")]);
        if !commit.ok() {
            return false;
        }
        let has = git_in(rt, project, &["for-each-ref", "--count=1", "--contains", commit.out(), "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"]);
        if !has.ok() || has.out().is_empty() {
            return false;
        }
    }
    true
}

/// What a cleanup picked.
#[derive(Debug, Default)]
pub struct CopyCleanup {
    /// Removed (or, report-only, picked) folders, relative to the outputs folder.
    pub removed: Vec<String>,
    pub failed: Vec<String>,
    /// A removed folder was a git worktree: `git worktree prune` in the project frees its branch.
    pub worktree: bool,
    /// Nothing was deleted: the picks went to the report-only log.
    pub reported: bool,
}

struct Walk<'a> {
    rt: tokio::runtime::Handle,
    root: String,
    project: &'a HashSet<String>,
    project_dir: Option<&'a Path>,
    out: CopyCleanup,
    report: Option<(&'a Path, Map<String, Value>)>,
}

impl Walk<'_> {
    /// Only a real folder whose real path is exactly where it should be.
    fn real_dir(path: &Path) -> bool {
        let Ok(m) = fs::symlink_metadata(path) else { return false };
        m.is_dir() && !m.file_type().is_symlink() && fs::canonicalize(path).is_ok_and(|r| r == path)
    }

    fn remove(&mut self, path: &Path, rel: &str) {
        let ps = path.to_string_lossy();
        if !ps.starts_with(&format!("{}{MAIN_SEPARATOR}", self.root)) || rel.split('/').count() < 2 || !path.parent().is_some_and(Self::real_dir) {
            return;
        }
        let Ok(m) = fs::symlink_metadata(path) else { return };
        if m.is_dir() && !Self::real_dir(path) {
            return;
        }
        let git_file = if rel.ends_with(&format!("/{GIT_MARK}")) { path.to_path_buf() } else { path.join(GIT_MARK) };
        if !self.out.worktree {
            self.out.worktree = fs::symlink_metadata(&git_file).is_ok_and(|x| x.is_file());
        }
        if let Some((data, base)) = &self.report {
            let mut f = base.clone();
            f.insert("path".into(), json!(ps));
            f.insert("action".into(), json!("remove"));
            dryrun::report(data, "huddle-output-copies", f);
            self.out.removed.push(rel.to_string());
            return;
        }
        let r = if m.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
        match r {
            Ok(()) => self.out.removed.push(rel.to_string()),
            Err(e) => self.out.failed.push(format!("{rel} ({e})")),
        }
    }

    fn untracked(&self, repo: &Path, path: &Path) -> bool {
        let r = git_in(&self.rt, repo, &["ls-files", "--", &path.to_string_lossy()]);
        r.ok() && r.out().is_empty()
    }

    fn names(dir: &Path) -> Option<Vec<String>> {
        let mut v: Vec<String> = fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        Some(v)
    }

    fn visit(&mut self, dir: &Path, rel: &str, depth: usize, in_copy: bool, repo: Option<&Path>) {
        let Some(names) = Self::names(dir) else { return };
        for n in names {
            let path = dir.join(&n);
            if !Self::real_dir(&path) {
                continue;
            }
            let r = format!("{rel}/{n}");
            if dep(&n) && (!loose(&n) || in_copy || (n == "venv" && fs::symlink_metadata(path.join("pyvenv.cfg")).is_ok_and(|m| m.is_file()))) {
                if repo.is_none_or(|repo| self.untracked(repo, &path)) {
                    self.remove(&path, &r);
                }
                continue;
            }
            let Some(inner) = Self::names(&path) else { continue };
            if !looks_like_copy(&inner, self.project) {
                if depth < MAX_DEPTH {
                    self.visit(&path, &r, depth + 1, in_copy, repo);
                }
                continue;
            }
            let has_git = inner.iter().any(|x| x == GIT_MARK);
            if has_git && committed_elsewhere(&self.rt, &path, self.project_dir) {
                let extras = inner.iter().any(|x| !self.project.contains(x) && !x.starts_with('.') && !dep(x));
                if !extras {
                    self.remove(&path, &r);
                } else {
                    for x in &inner {
                        if self.project.contains(x) || x == GIT_MARK || dep(x) {
                            self.remove(&path.join(x), &format!("{r}/{x}"));
                        }
                    }
                }
                continue;
            }
            let next_repo = if has_git { Some(path.clone()) } else { repo.map(Path::to_path_buf) };
            self.visit(&path, &r, depth + 1, true, next_repo.as_deref());
        }
    }
}

/// `removeOutputCopies` for each of `handles` (see the file comment). `report`: report-only (the data folder and the
/// fields every line of the log gets); None removes for real. Must run on a blocking thread of the runtime.
pub fn remove_output_copies(
    rt: tokio::runtime::Handle,
    outputs_dir: &Path,
    handles: &[String],
    project: &HashSet<String>,
    project_dir: Option<&Path>,
    report: Option<(&Path, Map<String, Value>)>,
) -> CopyCleanup {
    let reported = report.is_some();
    let Ok(root) = fs::canonicalize(outputs_dir) else { return CopyCleanup { reported, ..Default::default() } };
    let mut w = Walk { rt, root: root.to_string_lossy().into_owned(), project, project_dir, out: CopyCleanup { reported, ..Default::default() }, report };
    let mut seen = HashSet::new();
    for handle in handles {
        if !seen.insert(handle.clone()) || !safe_handle(handle) {
            continue;
        }
        let dir = root.join(handle);
        if !Walk::real_dir(&dir) {
            continue;
        }
        let own = Walk::names(&dir).unwrap_or_default();
        let own_git = own.iter().any(|x| x == GIT_MARK);
        let repo = own_git.then(|| dir.clone());
        w.visit(&dir, handle, 1, looks_like_copy(&own, project), repo.as_deref());
    }
    w.out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn copies_need_marks_and_most_names() {
        let p: HashSet<String> = ["src", "README.md", "package.json", "web", "test"].iter().map(|s| s.to_string()).collect();
        assert!(looks_like_copy(&names(&[".git", "src", "README.md", "package.json", "web"]), &p));
        assert!(!looks_like_copy(&names(&["src", "README.md", "package.json", "web"]), &p));
        assert!(!looks_like_copy(&names(&[".git", "src"]), &p));
        assert!(looks_like_copy(&names(&["node_modules", "src", "README.md", "package.json", "web"]), &p));
    }

    #[test]
    fn report_only_picks_dependencies_and_removes_nothing() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let d = tempfile::tempdir().unwrap();
        let data = d.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let out = d.path().join("outputs");
        fs::create_dir_all(out.join("qa/run/node_modules/x")).unwrap();
        fs::write(out.join("qa/report.md"), "r").unwrap();
        let h = rt.handle().clone();
        let r = std::thread::spawn({
            let (out, data) = (out.clone(), data.clone());
            move || remove_output_copies(h, &out, &["qa".into(), "../x".into()], &HashSet::new(), None, Some((&data, Map::new())))
        })
        .join()
        .unwrap();
        assert_eq!(r.removed, ["qa/run/node_modules"]);
        assert!(r.reported);
        assert!(out.join("qa/run/node_modules").exists());
        let log = ckanban_core::jsonl::read_all(&dryrun::log_path(&data)).unwrap();
        assert_eq!(log[0]["job"], "huddle-output-copies");
        // Deleting for real.
        let h = rt.handle().clone();
        let r = std::thread::spawn({
            let out = out.clone();
            move || remove_output_copies(h, &out, &["qa".into()], &HashSet::new(), None, None)
        })
        .join()
        .unwrap();
        assert_eq!(r.removed, ["qa/run/node_modules"]);
        assert!(!out.join("qa/run/node_modules").exists());
        assert!(out.join("qa/report.md").exists());
    }
}
