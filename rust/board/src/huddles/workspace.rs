//! Where a helper works (R11c): its own copy of the host's folder (`makeGitCopy`, `makeFolderCopy`, `snapshotCommit`,
//! `removeCopy`, `keepUnhanded`, `unhanded` of `src/huddle/huddle-copies.ts`), a read-only snapshot worktree, and the
//! paths and git helpers of `huddle-types.ts` (`agentDir`, `mainRepo`, `removeOwnWorktree`).
//!
//! Git runs as child processes (async); file walks and copies run on the blocking pool.

use std::fs;
use std::path::{Path, PathBuf};

use super::copies::{self, CopyState, bad_name, changes, plain_path, read_state, scan, write_state};
use crate::git::cmd::{RunResult, run};
use crate::git::repo::{NO_HOOKS, branch_exists, remove_worktree, worktree_dir};

async fn git(args: &[&str], cwd: &Path) -> RunResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    run(&cmd, cwd, &[], None).await
}

async fn git_env(args: &[&str], cwd: &Path, env: &[(&str, &str)]) -> RunResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    run(&cmd, cwd, env, None).await
}

async fn no_hooks(args: &[&str], cwd: &Path) -> RunResult {
    let mut cmd: Vec<&str> = NO_HOOKS.to_vec();
    cmd.extend_from_slice(args);
    run(&cmd, cwd, &[], None).await
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// `agentDir`: a helper's own or snapshot folder, next to the board's copies folder (so its sweep, one folder per
/// ticket id, leaves it alone): `<copies>/<board>/<ticket>.huddle/<handle>`.
pub fn agent_dir(board_path: &Path, slug: &str, host_ticket: &str, handle: &str) -> PathBuf {
    let wt = worktree_dir(board_path, slug, host_ticket);
    wt.parent().unwrap_or(Path::new("/")).join(format!("{host_ticket}.huddle")).join(handle)
}

/// `mainRepo`: the main checkout of the repo `dir` belongs to (the host's folder may be one of its worktrees).
pub async fn main_repo(dir: &Path) -> PathBuf {
    let r = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"], dir).await;
    let common = PathBuf::from(r.out());
    if !r.out().is_empty() && common.file_name().is_some_and(|n| n == ".git") {
        return common.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.to_path_buf());
    }
    dir.to_path_buf()
}

/// `snapshotCommit`: a commit of `dir` as it is now (tracked changes and new files included), made with a temporary
/// index so the folder's own index, files and branches stay as they are. Its parent is HEAD.
pub async fn snapshot_commit(dir: &Path) -> Result<String, String> {
    let index = std::env::temp_dir().join(format!("ck-index-{}", crate::git::landing::random_uuid()));
    let ix = index.to_string_lossy().to_string();
    let env = [
        ("GIT_INDEX_FILE", ix.as_str()),
        ("GIT_AUTHOR_NAME", "ckanban"),
        ("GIT_AUTHOR_EMAIL", "ckanban@localhost"),
        ("GIT_COMMITTER_NAME", "ckanban"),
        ("GIT_COMMITTER_EMAIL", "ckanban@localhost"),
    ];
    let out = async {
        let must = |args: Vec<String>| async move {
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            let r = git_env(&a, dir, &env).await;
            if !r.ok() {
                return Err(format!("couldn't copy the ticket's folder ({}): {}", a[..2.min(a.len())].join(" "), r.stderr.trim()));
            }
            Ok(r.out().to_string())
        };
        let v = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<String>>();
        must(v(&["read-tree", "HEAD"])).await?;
        must(v(&["add", "-A"])).await?;
        let tree = must(v(&["write-tree"])).await?;
        must(v(&["commit-tree", &tree, "-p", "HEAD", "-m", "Copy of the ticket's folder for a huddle helper (ckanban)"])).await
    }
    .await;
    let _ = fs::remove_file(&index);
    out
}

/// `removeCopy`: a copy and what the board kept about it. `repo`: the project, when the copy is a git worktree (its
/// branch goes too). `keep_hand_ins`: a fresh copy replaces it, and what was handed in stays readable.
pub async fn remove_copy(copy: &Path, repo: Option<&Path>, branch: Option<&str>, keep_hand_ins: bool) {
    let c = copy.to_string_lossy().to_string();
    if let Some(repo) = repo
        && copy.exists()
    {
        git(&["worktree", "remove", "--force", &c], repo).await;
    }
    let (c2, keep) = (c.clone(), keep_hand_ins);
    let _ = blocking(move || {
        let _ = fs::remove_dir_all(&c2);
        let _ = fs::remove_file(copies::state_file(&c2));
        if !keep {
            let _ = fs::remove_dir_all(format!("{c2}.handins"));
        }
    })
    .await;
    if let Some(repo) = repo {
        git(&["worktree", "prune"], repo).await;
        if let Some(b) = branch.filter(|b| !b.is_empty())
            && branch_exists(repo, b).await
        {
            git(&["branch", "-D", b], repo).await;
        }
    }
}

/// `makeGitCopy`: a worktree on `branch` at a snapshot of the host folder; replaces an older copy at `dest`.
pub async fn make_git_copy(repo: &Path, host_dir: &Path, dest: &Path, branch: &str) -> Result<(), String> {
    let sha = snapshot_commit(host_dir).await?;
    remove_copy(dest, Some(repo), Some(branch), true).await;
    if let Some(p) = dest.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let d = dest.to_string_lossy().to_string();
    let r = no_hooks(&["worktree", "add", "--no-track", "-b", branch, &d, &sha], repo).await;
    if !r.ok() {
        return Err(format!("couldn't make a copy of the ticket's folder for the helper: {}", r.stderr.trim()));
    }
    let dest = dest.to_path_buf();
    blocking(move || {
        let base = scan(&dest, "git")?;
        write_state(&dest.to_string_lossy(), &CopyState { base, handed: None }).map_err(|e| e.to_string())
    })
    .await?
}

/// Copies `src` into `dest` leaving out `COPY_SKIP` below the top; symlinks stay as they are (a relative one made
/// absolute would point into the ticket's folder itself).
fn copy_tree(src: &Path, dest: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let name = e.file_name();
        if copies::COPY_SKIP.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let (from, to) = (e.path(), dest.join(&name));
        let m = fs::symlink_metadata(&from)?;
        if m.file_type().is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
        } else if m.is_dir() {
            copy_tree(&from, &to)?;
        } else if m.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// `makeFolderCopy`: a plain copy of the host folder (without `COPY_SKIP`); replaces an older copy at `dest`.
pub async fn make_folder_copy(host_dir: &Path, dest: &Path) -> Result<(), String> {
    remove_copy(dest, None, None, true).await;
    let (src, dest) = (host_dir.to_path_buf(), dest.to_path_buf());
    blocking(move || {
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        copy_tree(&src, &dest).map_err(|e| format!("couldn't copy the ticket's folder for the helper: {e}"))?;
        let base = scan(&dest, "folder")?;
        write_state(&dest.to_string_lossy(), &CopyState { base, handed: None }).map_err(|e| e.to_string())
    })
    .await?
}

/// `keptDir`: where changes a helper never handed in are saved before its copy is made again.
pub fn kept_dir(copy: &str) -> PathBuf {
    PathBuf::from(format!("{copy}.kept"))
}

/// `keepUnhanded`: before a copy is made again, the files it changed since its last hand-in (or since it was made) go
/// to `kept_dir/<label>`, with a REMOVED.txt listing files it deleted. The folder, or None when nothing was unsent.
/// Blocking.
pub fn keep_unhanded(copy: &str, kind: &str, label: &str) -> Result<Option<PathBuf>, String> {
    let Some(st) = read_state(copy) else { return Ok(None) };
    let root = Path::new(copy);
    if !root.exists() {
        return Ok(None);
    }
    let now = scan(root, kind)?;
    let files: Vec<_> = changes(st.handed.as_ref().unwrap_or(&st.base), &now)
        .into_iter()
        .filter(|f| {
            let p = f["path"].as_str().unwrap_or("");
            !bad_name(p) && plain_path(root, p)
        })
        .collect();
    if files.is_empty() {
        return Ok(None);
    }
    let dest = kept_dir(copy).join(label);
    let _ = fs::remove_dir_all(&dest);
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut removed = Vec::new();
    for f in &files {
        let p = f["path"].as_str().unwrap_or("");
        if f["hash"].is_null() {
            removed.push(p.to_string());
            continue;
        }
        let to = dest.join(p);
        if let Some(d) = to.parent() {
            fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        fs::write(&to, fs::read(root.join(p)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    if !removed.is_empty() {
        fs::write(dest.join("REMOVED.txt"), format!("{}\n", removed.join("\n"))).map_err(|e| e.to_string())?;
    }
    Ok(Some(dest))
}

/// `unhanded`: the copy has changes the helper never handed in (a close keeps it then). Blocking.
pub fn unhanded(copy: &str, kind: &str) -> Result<bool, String> {
    let Some(st) = read_state(copy) else { return Ok(false) };
    if !Path::new(copy).exists() {
        return Ok(false);
    }
    Ok(!changes(st.handed.as_ref().unwrap_or(&st.base), &scan(Path::new(copy), kind)?).is_empty())
}

/// `removeOwnWorktree`: an older huddle's own worktree and branch; the reason it was kept, or None once removed.
pub async fn remove_own_worktree(repo: &Path, dir: &Path, branch: Option<&str>, base: &str) -> Option<String> {
    let branch = branch.filter(|b| !b.is_empty());
    let has = match branch {
        Some(b) => branch_exists(repo, b).await,
        None => false,
    };
    if let (true, Some(b)) = (has, branch) {
        let ahead = git(&["rev-list", "--count", &format!("{base}..{b}")], repo).await;
        if !ahead.ok() {
            return Some(format!("couldn't compare it with {base}: {}", ahead.stderr.trim()));
        }
        let n: u64 = ahead.out().parse().unwrap_or(0);
        if n > 0 {
            return Some(format!("{n} commit{} not on {base}", if n == 1 { "" } else { "s" }));
        }
    }
    let r = remove_worktree(repo, dir, None::<std::future::Ready<()>>).await;
    if !r.removed {
        return Some(r.reason.unwrap_or_else(|| "couldn't remove it".into()));
    }
    if let (true, Some(b)) = (has, branch) {
        git(&["branch", "-D", b], repo).await;
    }
    None
}

/// The host folder's committed HEAD and branch, for a read-only snapshot.
pub async fn head_of(dir: &Path) -> Result<(String, Option<String>), String> {
    let head = git(&["rev-parse", "HEAD"], dir).await;
    if !head.ok() {
        return Err(format!("couldn't read the host worktree's HEAD: {}", head.stderr.trim()));
    }
    let branch = git(&["branch", "--show-current"], dir).await;
    Ok((head.out().to_string(), Some(branch.out().to_string()).filter(|b| !b.is_empty())))
}

/// A read-only snapshot at `sha`: an existing one is reset there (its local changes and untracked files discarded), a
/// new one is a detached worktree of `repo`.
pub async fn reset_snapshot(repo: &Path, dir: &Path, sha: &str) -> Result<(), String> {
    if dir.exists() {
        let r = no_hooks(&["checkout", "--quiet", "--force", "--detach", sha], dir).await;
        if !r.ok() {
            return Err(format!("couldn't reset the snapshot worktree {}: {}", dir.display(), r.stderr.trim()));
        }
        let r = git(&["clean", "-fdq"], dir).await;
        if !r.ok() {
            return Err(format!("couldn't reset the snapshot worktree {}: {}", dir.display(), r.stderr.trim()));
        }
        return Ok(());
    }
    git(&["worktree", "prune"], repo).await;
    if let Some(p) = dir.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let d = dir.to_string_lossy().to_string();
    let r = no_hooks(&["worktree", "add", "--detach", &d, sha], repo).await;
    if !r.ok() {
        return Err(format!("couldn't make the snapshot worktree {}: {}", dir.display(), r.stderr.trim()));
    }
    Ok(())
}

/// `git worktree remove --force <dir>` from `repo`; Err with git's words.
pub async fn force_remove_worktree(repo: &Path, dir: &Path) -> Result<(), String> {
    let r = git(&["worktree", "remove", "--force", &dir.to_string_lossy()], repo).await;
    if r.ok() { Ok(()) } else { Err(Some(r.stderr.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "couldn't remove it".into())) }
}

/// `git worktree prune` in `repo`.
pub async fn prune(repo: &Path) {
    git(&["worktree", "prune"], repo).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    #[tokio::test]
    async fn git_copy_has_the_host_folder_as_it_is_now_and_goes_away() {
        let d = tempfile::tempdir().unwrap();
        let repo = d.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
        fs::write(repo.join("new.txt"), "uncommitted").unwrap();
        let dest = d.path().join("copies/T1.huddle/fixer");
        make_git_copy(&repo, &repo, &dest, "ck/T1-fixer").await.unwrap();
        assert_eq!(fs::read_to_string(dest.join("new.txt")).unwrap(), "uncommitted");
        // The user's own index and branch are untouched.
        let st = std::process::Command::new("git").args(["status", "--porcelain"]).current_dir(&repo).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&st.stdout).trim(), "?? new.txt");
        let c = dest.to_string_lossy().to_string();
        assert!(!unhanded(&c, "git").unwrap());
        fs::write(dest.join("new.txt"), "changed").unwrap();
        assert!(unhanded(&c, "git").unwrap());
        let kept = keep_unhanded(&c, "git", "x").unwrap().unwrap();
        assert_eq!(fs::read_to_string(kept.join("new.txt")).unwrap(), "changed");
        remove_copy(&dest, Some(&repo), Some("ck/T1-fixer"), false).await;
        assert!(!dest.exists());
        assert!(!branch_exists(&repo, "ck/T1-fixer").await);
    }

    #[tokio::test]
    async fn folder_copy_leaves_out_installed_files_and_keeps_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let host = d.path().join("host");
        fs::create_dir_all(host.join("node_modules/x")).unwrap();
        fs::create_dir_all(host.join("src")).unwrap();
        fs::write(host.join("src/a.txt"), "a").unwrap();
        std::os::unix::fs::symlink("src/a.txt", host.join("link")).unwrap();
        let dest = d.path().join("copy");
        make_folder_copy(&host, &dest).await.unwrap();
        assert!(dest.join("src/a.txt").is_file());
        assert!(!dest.join("node_modules").exists());
        assert_eq!(fs::read_link(dest.join("link")).unwrap(), PathBuf::from("src/a.txt"));
        assert!(read_state(&dest.to_string_lossy()).unwrap().base.contains_key("src/a.txt"));
    }

    #[test]
    fn agent_dir_sits_next_to_the_ticket_copies() {
        assert_eq!(agent_dir(Path::new("/w/proj"), "b", "t1", "qa"), PathBuf::from("/w/.ckanban-worktrees/b/t1.huddle/qa"));
    }
}
