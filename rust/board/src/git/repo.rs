//! A folder's version history: is it a repo, its base branch, ticket copies (worktrees) and their branches, the
//! folder's kind (plain, empty, local, remote) and turning version history on. Port of `src/runs/git.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::Mutex;

use super::cmd::{RunResult, git_usable, run};

/// Prefix for ckanban's own git commands that check out files: the project's hooks (husky's post-checkout, say) are
/// for the user's checkouts, and in a fresh copy they often fail on git-ignored files.
pub const NO_HOOKS: [&str; 3] = ["git", "-c", "core.hooksPath=/dev/null"];

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

async fn git(args: &[&str], cwd: &Path) -> RunResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    run(&cmd, cwd, &[], None).await
}

fn with_hooks_off<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut v: Vec<&str> = NO_HOOKS.to_vec();
    v.extend_from_slice(args);
    v
}

/// `isGitRepo`: the folder is inside a git work tree (and git can run here).
pub async fn is_git_repo(path: &Path) -> bool {
    if !path.exists() || !super::cmd::which("git").await {
        return false;
    }
    let r = git(&["rev-parse", "--is-inside-work-tree"], path).await;
    r.ok() && r.out() == "true"
}

/// `detectBaseBranch`: origin's default branch, else the current branch, else "main".
pub async fn detect_base_branch(path: &Path) -> String {
    let origin = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path).await;
    if origin.ok() && !origin.out().is_empty() {
        return origin.out().strip_prefix("origin/").unwrap_or(origin.out()).to_string();
    }
    let cur = git(&["branch", "--show-current"], path).await;
    if cur.ok() && !cur.out().is_empty() {
        return cur.out().to_string();
    }
    "main".into()
}

async fn is_commit(repo: &Path, r#ref: &str) -> bool {
    if r#ref.is_empty() {
        return false;
    }
    git(&["rev-parse", "--verify", "--quiet", &format!("{ref}^{{commit}}")], repo).await.ok()
}

/// False in a fresh `git init` with no commits yet.
pub async fn has_commits(dir: &Path) -> bool {
    is_commit(dir, "HEAD").await
}

/// `resolveBaseBranch`: the saved base branch if it still points at a commit, else the first of the detected default
/// branch, its origin/ copy, main, master or HEAD that does. None when the repo has no commits yet.
pub async fn resolve_base_branch(repo: &Path, saved: &str) -> Option<String> {
    if is_commit(repo, saved).await {
        return Some(saved.to_string());
    }
    let detected = detect_base_branch(repo).await;
    for r in [detected.clone(), format!("origin/{detected}"), "main".into(), "master".into(), "HEAD".into()] {
        if r != saved && is_commit(repo, &r).await {
            return Some(r);
        }
    }
    None
}

/// `worktreeDir`: `<folder's parent>/.ckanban-worktrees/<board>/<ticket>`.
pub fn worktree_dir(board_path: &Path, slug: &str, id: &str) -> PathBuf {
    board_path.parent().unwrap_or(Path::new("/")).join(".ckanban-worktrees").join(slug).join(id)
}

/// Tickets starting together share one fetch: parallel fetches of the same ref fail on git's ref lock.
type Fetch = Shared<BoxFuture<'static, Result<String, String>>>;
static FETCHES: LazyLock<Mutex<HashMap<(PathBuf, String), Fetch>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `latestBase`: brings origin's copy of the base branch up to date and returns the ref new ticket branches start from
/// (`origin/<base>`). Only remote-tracking refs change. Falls back to the local base when origin has no such branch.
/// Err (the user-facing reason) when origin can't be reached.
pub async fn latest_base(repo: &Path, base: &str, timeout: Duration) -> Result<String, String> {
    let key = (repo.to_path_buf(), base.to_string());
    let fut = {
        let mut m = FETCHES.lock();
        if let Some(f) = m.get(&key) {
            f.clone()
        } else {
            let (r, b, k) = (repo.to_path_buf(), base.to_string(), key.clone());
            let f: Fetch = async move {
                let out = fetch_base(&r, &b, timeout).await;
                FETCHES.lock().remove(&k);
                out
            }
            .boxed()
            .shared();
            m.insert(key, f.clone());
            f
        }
    };
    fut.await
}

async fn fetch_base(repo: &Path, base: &str, timeout: Duration) -> Result<String, String> {
    let name = base.strip_prefix("origin/").unwrap_or(base);
    if name == "HEAD" {
        return Ok(base.to_string());
    }
    // No password prompts or ssh questions (a run has nobody to answer them); the user's own ssh command wins.
    let own_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some_and(|v| !v.is_empty())
        || !git(&["config", "--get", "core.sshCommand"], repo).await.out().is_empty();
    let mut env = vec![("GIT_TERMINAL_PROMPT", "0")];
    if !own_ssh {
        env.push(("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"));
    }
    let refspec = format!("+refs/heads/{name}:refs/remotes/origin/{name}");
    let cmd = with_hooks_off(&["fetch", "--quiet", "--no-tags", "origin", &refspec]);
    let mut r = run(&cmd, repo, &env, Some(timeout)).await;
    // Someone else fetching at the same moment holds the ref lock: once more, then judge.
    if !r.ok() && lock_clash(&r.stderr) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        r = run(&cmd, repo, &env, Some(timeout)).await;
    }
    if !r.ok() {
        if r.stderr.to_lowercase().contains("couldn't find remote ref") {
            return Ok(base.to_string());
        }
        let last = r
            .stderr
            .trim()
            .split('\n')
            .filter(|l| !l.is_empty())
            .next_back()
            .map(str::to_string)
            .unwrap_or_else(|| format!("git fetch exited with {}", r.code));
        return Err(format!(
            "Couldn't reach the online copy of your project to get its latest version (offline or signed out?). Check your connection or sign in, then send a message to retry.\n\n{last}"
        ));
    }
    let origin = format!("origin/{name}");
    Ok(if is_commit(repo, &origin).await { origin } else { base.to_string() })
}

fn lock_clash(stderr: &str) -> bool {
    static RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)cannot lock ref|\.lock'?: File exists").unwrap());
    RE.is_match(stderr)
}

/// `addWorktree`: a copy of the repo at `dir` on `branch` (made from `base` when new, without tracking it).
pub async fn add_worktree(repo: &Path, dir: &Path, branch: &str, base: &str) -> Result<(), String> {
    if let Some(parent) = dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let d = dir.to_string_lossy();
    let args: Vec<&str> = if branch_exists(repo, branch).await {
        with_hooks_off(&["worktree", "add", &d, branch])
    } else {
        // --no-track: a branch made from origin/<base> would otherwise track it, and a plain `git push` would refuse.
        with_hooks_off(&["worktree", "add", "--no-track", "-b", branch, &d, base])
    };
    let r = run(&args, repo, &[], None).await;
    if !r.ok() {
        return Err(format!(
            "Could not create an isolated git worktree for this ticket from \"{base}\". Check the board's base branch in its settings, then send a message to retry.\n\ngit worktree add failed: {}",
            r.stderr.trim()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub removed: bool,
    pub reason: Option<String>,
}

/// `removeWorktree`: removes a clean copy; one with uncommitted changes is kept (with the reason). `before_remove`
/// runs once the copy is known to be removable (the board's cleanup command).
pub async fn remove_worktree<F>(repo: &Path, dir: &Path, before_remove: Option<F>) -> Removed
where
    F: std::future::Future<Output = ()>,
{
    if !dir.exists() {
        return Removed { removed: true, reason: None };
    }
    let status = git(&["status", "--porcelain"], dir).await;
    if !status.ok() {
        return Removed { removed: false, reason: Some(status.stderr.trim().to_string()) };
    }
    if !status.out().is_empty() {
        return Removed { removed: false, reason: Some("worktree has uncommitted changes".into()) };
    }
    if let Some(f) = before_remove {
        f.await;
    }
    let r = git(&["worktree", "remove", &dir.to_string_lossy()], repo).await;
    if !r.ok() {
        return Removed { removed: false, reason: Some(r.stderr.trim().to_string()) };
    }
    Removed { removed: true, reason: None }
}

/// The folder has changes not in its version history yet (an unreadable status counts as changes).
pub async fn has_uncommitted_changes(dir: &Path) -> bool {
    if !dir.exists() {
        return false;
    }
    let s = git(&["status", "--porcelain"], dir).await;
    !s.ok() || !s.out().is_empty()
}

pub async fn branch_exists(repo: &Path, branch: &str) -> bool {
    git(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], repo).await.ok()
}

/// Local branches starting with `prefix`, most recently committed first.
pub async fn branches_with_prefix(repo: &Path, prefix: &str) -> Vec<String> {
    let r = git(&["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads/"], repo).await;
    if !r.ok() {
        return Vec::new();
    }
    r.stdout.split('\n').map(str::trim).filter(|b| b.starts_with(prefix)).map(str::to_string).collect()
}

/// Paths of the repo's linked worktrees (after pruning registrations whose folder is gone).
pub async fn list_worktrees(repo: &Path) -> Vec<String> {
    git(&["worktree", "prune"], repo).await;
    let r = git(&["worktree", "list", "--porcelain"], repo).await;
    if !r.ok() {
        return Vec::new();
    }
    r.stdout.split('\n').filter_map(|l| l.strip_prefix("worktree ")).skip(1).map(str::to_string).collect()
}

/// A folder's version history as runs see it: no git, a repo with no commits, one with commits but no `origin`, or one
/// with a remote. Only the last can push or open a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RepoKind {
    Plain,
    Empty,
    Local,
    Remote,
}

impl RepoKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RepoKind::Plain => "plain",
            RepoKind::Empty => "empty",
            RepoKind::Local => "local",
            RepoKind::Remote => "remote",
        }
    }
    /// local or remote: the folder has commits.
    pub fn committed(self) -> bool {
        matches!(self, RepoKind::Local | RepoKind::Remote)
    }
}

/// How long `repo_kind` reuses a folder's answer.
pub const REPO_KIND_TTL: Duration = Duration::from_secs(10);

type KindCheck = Shared<BoxFuture<'static, RepoKind>>;
// One entry per folder asked about (the boards' folders, a few at most), so it stays small without pruning.
static KINDS: LazyLock<Mutex<HashMap<PathBuf, (Instant, KindCheck)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// `repoKind`: the folder's kind, reused for `REPO_KIND_TTL` (calls during a check share it). `fresh`: ask git now
/// (steps that act on the answer) and keep that answer for later calls.
pub async fn repo_kind(path: &Path, fresh: bool) -> RepoKind {
    let fut = {
        let mut m = KINDS.lock();
        match m.get(path) {
            Some((at, f)) if !fresh && at.elapsed() < REPO_KIND_TTL => f.clone(),
            _ => {
                let p = path.to_path_buf();
                let f: KindCheck = async move { check_repo_kind(&p).await }.boxed().shared();
                m.insert(path.to_path_buf(), (Instant::now(), f.clone()));
                f
            }
        }
    };
    fut.await
}

/// `forgetRepoKind`: drops one folder's cached answer, or every one.
pub fn forget_repo_kind(path: Option<&Path>) {
    let mut m = KINDS.lock();
    match path {
        Some(p) => {
            m.remove(p);
        }
        None => m.clear(),
    }
}

async fn check_repo_kind(path: &Path) -> RepoKind {
    if !is_git_repo(path).await {
        return RepoKind::Plain;
    }
    if !has_commits(path).await {
        return RepoKind::Empty;
    }
    if git(&["remote", "get-url", "origin"], path).await.ok() { RepoKind::Remote } else { RepoKind::Local }
}

/// Files bigger than this stay out of the first snapshot (listed in the ignore file by path).
pub const SNAPSHOT_MAX_BYTES: u64 = 50 * 1024 * 1024;

const SNAPSHOT_IGNORE: [&str; 16] = [
    "# Written by ckanban when version history was turned on. Edit freely.",
    ".env*",
    "node_modules/",
    ".DS_Store",
    "*.log",
    "dist/",
    "build/",
    "out/",
    ".next/",
    ".nuxt/",
    ".cache/",
    "coverage/",
    "target/",
    "__pycache__/",
    ".venv/",
    "venv/",
];

pub const SNAPSHOT_MESSAGE: &str = "Initial snapshot (ckanban)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enabled {
    pub changed: bool,
    pub sha: Option<String>,
    pub ignored: Vec<String>,
}

impl Enabled {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "changed": self.changed, "sha": self.sha, "ignored": self.ignored })
    }
}

/// `enableVersionHistory`: `git init` (unless it is a repo already), a .gitignore when it has none, a local identity
/// only when git has none, then one commit of everything. Never pushes. A repo with commits is left alone.
pub async fn enable_version_history(dir: &Path) -> Result<Enabled, String> {
    let r = turn_on_version_history(dir).await;
    forget_repo_kind(Some(dir));
    r
}

async fn must(args: &[&str], dir: &Path) -> Result<String, String> {
    let r = git(args, dir).await;
    if !r.ok() {
        let what = std::iter::once("git").chain(args.iter().copied()).take(2).collect::<Vec<_>>().join(" ");
        let msg = if r.stderr.is_empty() { &r.stdout } else { &r.stderr };
        return Err(format!("{what} failed: {}", msg.trim()));
    }
    Ok(r.stdout)
}

async fn turn_on_version_history(dir: &Path) -> Result<Enabled, String> {
    if !dir.is_dir() {
        return Err(format!("This folder doesn't exist: {}", dir.display()));
    }
    let real = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let home = std::fs::canonicalize(ckanban_core::home::home_dir()).ok();
    // A whole home folder or disk would sweep every private file into one snapshot.
    if real == Path::new("/") || Some(&real) == home.as_ref() || real.parent() == Some(Path::new("/")) {
        return Err("Choose a project folder: version history can't be turned on for your whole home folder or disk.".into());
    }
    // Only a repo rooted at this folder is used as is; inside an outer repo with no commits, it gets its own.
    let top = git(&["rev-parse", "--show-toplevel"], dir).await.out().to_string();
    let own = !top.is_empty() && std::fs::canonicalize(&top).ok().as_ref() == Some(&real);
    if !top.is_empty() && has_commits(dir).await {
        let sha = must(&["rev-parse", "HEAD"], dir).await?.trim().to_string();
        return Ok(Enabled { changed: false, sha: Some(sha), ignored: Vec::new() });
    }
    if !own {
        must(&["init", "-q"], dir).await?;
    }
    let gitignore = dir.join(".gitignore");
    let fresh = !gitignore.exists();
    if fresh {
        std::fs::write(&gitignore, format!("{}\n", SNAPSHOT_IGNORE.join("\n"))).map_err(|e| e.to_string())?;
    }
    let untracked = must(&["ls-files", "-z", "--others", "--exclude-standard"], dir).await?;
    let staged = must(&["diff", "-z", "--cached", "--name-only"], dir).await?;
    let staged: Vec<&str> = staged.split('\0').filter(|s| !s.is_empty()).collect();
    let big: Vec<String> = untracked
        .split('\0')
        .filter(|s| !s.is_empty())
        .chain(staged.iter().copied())
        .filter(|f| std::fs::metadata(dir.join(f)).map(|m| m.len() > SNAPSHOT_MAX_BYTES).unwrap_or(false))
        .map(str::to_string)
        .collect();
    if !big.is_empty() {
        let lines: Vec<String> = big.iter().map(|f| format!("/{}", escape_ignore(f))).collect();
        let text = format!("\n# Files over 50 MB, kept out of version history\n{}\n", lines.join("\n"));
        let target = if fresh {
            gitignore.clone()
        } else {
            PathBuf::from(must(&["rev-parse", "--absolute-git-dir"], dir).await?.trim()).join("info").join("exclude")
        };
        if let Some(p) = target.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        use std::io::Write;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .and_then(|mut f| f.write_all(text.as_bytes()))
            .map_err(|e| e.to_string())?;
        let staged_big: Vec<&str> = big.iter().map(String::as_str).filter(|f| staged.contains(f)).collect();
        if !staged_big.is_empty() {
            let mut args = vec!["rm", "-q", "--cached", "--"];
            args.extend(staged_big);
            must(&args, dir).await?;
        }
    }
    for (key, value) in [("user.name", "ckanban"), ("user.email", "ckanban@localhost")] {
        if git(&["config", key], dir).await.out().is_empty() {
            must(&["config", key, value], dir).await?;
        }
    }
    must(&["add", "-A"], dir).await?;
    // No signing: a passphrase prompt would hang the request.
    must(&["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", SNAPSHOT_MESSAGE], dir).await?;
    let sha = must(&["rev-parse", "HEAD"], dir).await?.trim().to_string();
    Ok(Enabled { changed: true, sha: Some(sha), ignored: big })
}

/// `f.replace(/([*?[\]\\#! ])/g, "\\$1")`.
fn escape_ignore(f: &str) -> String {
    let mut s = String::with_capacity(f.len());
    for c in f.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\' | '#' | '!' | ' ') {
            s.push('\\');
        }
        s.push(c);
    }
    s
}

/// Whether `git` can be used here at all (for `GET /api/version-history`).
pub async fn git_installed() -> bool {
    tokio::task::spawn_blocking(git_usable).await.unwrap_or(false)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;

    /// `makeRepo` in test/support/helpers.ts: a repo on main with one commit of README.md.
    pub async fn make_repo(parent: &Path, name: &str) -> PathBuf {
        let dir = parent.join(name);
        fs::create_dir_all(&dir).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "t"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            assert!(git(&args, &dir).await.ok());
        }
        fs::write(dir.join("README.md"), "hello\n").unwrap();
        assert!(git(&["add", "."], &dir).await.ok());
        assert!(git(&["commit", "-qm", "init"], &dir).await.ok());
        dir
    }

    pub async fn sh(dir: &Path, args: &[&str]) -> String {
        let r = git(args, dir).await;
        assert!(r.ok(), "git {args:?}: {}", r.stderr);
        r.stdout.trim().to_string()
    }

    #[tokio::test]
    async fn repo_basics() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        assert!(is_git_repo(&repo).await);
        let plain = t.path().join("plain");
        fs::create_dir(&plain).unwrap();
        assert!(!is_git_repo(&plain).await);
        assert!(!is_git_repo(&t.path().join("missing")).await);
        assert_eq!(detect_base_branch(&repo).await, "main");
        assert_eq!(worktree_dir(Path::new("/a/b/repo"), "p", "t_1"), PathBuf::from("/a/b/.ckanban-worktrees/p/t_1"));
        assert_eq!(resolve_base_branch(&repo, "main").await.as_deref(), Some("main"));
        assert_eq!(resolve_base_branch(&repo, "nope").await.as_deref(), Some("main"));
        assert_eq!(resolve_base_branch(&repo, "").await.as_deref(), Some("main"));
        let empty = t.path().join("empty");
        fs::create_dir(&empty).unwrap();
        sh(&empty, &["init", "-q", "-b", "main"]).await;
        assert_eq!(resolve_base_branch(&empty, "main").await, None);
        let m = make_repo(t.path(), "m").await;
        sh(&m, &["branch", "-m", "main", "master"]).await;
        assert_eq!(resolve_base_branch(&m, "main").await.as_deref(), Some("master"));
    }

    #[tokio::test]
    async fn worktrees_add_remove_and_dirty_kept() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        // The project's checkout hooks are skipped.
        fs::write(repo.join(".git/hooks/post-checkout"), "#!/bin/sh\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(repo.join(".git/hooks/post-checkout"), fs::Permissions::from_mode(0o755)).unwrap();
        let dir = t.path().join("wt/t1");
        add_worktree(&repo, &dir, "ck/t1-x", "main").await.unwrap();
        assert!(dir.join("README.md").exists());
        assert_eq!(sh(&dir, &["branch", "--show-current"]).await, "ck/t1-x");
        assert!(branch_exists(&repo, "ck/t1-x").await);
        assert_eq!(branches_with_prefix(&repo, "ck/t1-").await, ["ck/t1-x"]);
        let listed = list_worktrees(&repo).await;
        assert_eq!(listed.len(), 1);
        assert!(listed[0].ends_with("wt/t1"));
        assert!(!has_uncommitted_changes(&dir).await);
        let none: Option<std::future::Ready<()>> = None;
        assert_eq!(remove_worktree(&repo, &dir, none).await, Removed { removed: true, reason: None });
        assert!(!dir.exists());

        let dir2 = t.path().join("wt/t2");
        add_worktree(&repo, &dir2, "ck/t2-x", "main").await.unwrap();
        fs::write(dir2.join("new.txt"), "x").unwrap();
        assert!(has_uncommitted_changes(&dir2).await);
        let ran = Arc::new(Mutex::new(false));
        let r2 = ran.clone();
        let r = remove_worktree(&repo, &dir2, Some(async move { *r2.lock() = true })).await;
        assert_eq!(r, Removed { removed: false, reason: Some("worktree has uncommitted changes".into()) });
        assert!(!*ran.lock());
        assert!(dir2.exists());

        let e = add_worktree(&repo, &t.path().join("wt/t3"), "ck/t3", "nope-branch").await.unwrap_err();
        assert!(e.starts_with("Could not create an isolated git worktree") && e.contains("git worktree add failed"), "{e}");
    }

    #[tokio::test]
    async fn latest_base_fetches_from_a_bare_remote_and_says_why_when_it_cant() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        let bare = t.path().join("remote.git");
        sh(t.path(), &["init", "-q", "--bare", "-b", "main", &bare.to_string_lossy()]).await;
        sh(&repo, &["remote", "add", "origin", &bare.to_string_lossy()]).await;
        sh(&repo, &["push", "-q", "origin", "main"]).await;
        assert_eq!(latest_base(&repo, "main", FETCH_TIMEOUT).await.unwrap(), "origin/main");
        // origin has no such branch: the local base.
        sh(&repo, &["branch", "only-here"]).await;
        assert_eq!(latest_base(&repo, "only-here", FETCH_TIMEOUT).await.unwrap(), "only-here");
        assert_eq!(latest_base(&repo, "HEAD", FETCH_TIMEOUT).await.unwrap(), "HEAD");
        sh(&repo, &["remote", "set-url", "origin", &t.path().join("gone.git").to_string_lossy()]).await;
        let e = latest_base(&repo, "main", FETCH_TIMEOUT).await.unwrap_err();
        assert!(e.starts_with("Couldn't reach the online copy of your project"), "{e}");
    }

    #[tokio::test]
    async fn repo_kind_and_version_history() {
        let t = tempfile::tempdir().unwrap();
        let plain = t.path().join("plain");
        fs::create_dir(&plain).unwrap();
        assert_eq!(repo_kind(&plain, false).await, RepoKind::Plain);
        fs::write(plain.join("notes.txt"), "hi\n").unwrap();
        fs::write(plain.join("debug.log"), "x\n").unwrap();
        let big = fs::File::create(plain.join("video.mov")).unwrap();
        big.set_len(SNAPSHOT_MAX_BYTES + 1).unwrap();
        let r = enable_version_history(&plain).await.unwrap();
        assert!(r.changed);
        assert_eq!(r.ignored, ["video.mov"]);
        let ignore = fs::read_to_string(plain.join(".gitignore")).unwrap();
        for line in [".env*", "node_modules/", ".DS_Store", "*.log", "/video.mov"] {
            assert!(ignore.contains(line), "{line}");
        }
        let mut files: Vec<String> = sh(&plain, &["ls-files"]).await.lines().map(str::to_string).collect();
        files.sort();
        assert_eq!(files, [".gitignore", "notes.txt"]);
        assert_eq!(repo_kind(&plain, false).await, RepoKind::Local);

        // No commits: its own .gitignore is kept and it isn't re-initialised.
        let empty = t.path().join("empty");
        fs::create_dir(&empty).unwrap();
        sh(&empty, &["init", "-q", "-b", "trunk"]).await;
        fs::write(empty.join(".gitignore"), "secret.txt\n").unwrap();
        fs::write(empty.join("secret.txt"), "s\n").unwrap();
        fs::write(empty.join("a.txt"), "a\n").unwrap();
        assert_eq!(repo_kind(&empty, false).await, RepoKind::Empty);
        assert!(enable_version_history(&empty).await.unwrap().changed);
        assert_eq!(fs::read_to_string(empty.join(".gitignore")).unwrap(), "secret.txt\n");
        assert_eq!(sh(&empty, &["branch", "--show-current"]).await, "trunk");

        // An existing repo is left alone; a remote makes it "remote".
        let repo = make_repo(t.path(), "repo").await;
        let head = sh(&repo, &["rev-parse", "HEAD"]).await;
        assert_eq!(enable_version_history(&repo).await.unwrap(), Enabled { changed: false, sha: Some(head), ignored: vec![] });
        assert!(!repo.join(".gitignore").exists());
        sh(&repo, &["remote", "add", "origin", "https://example.com/x.git"]).await;
        assert_eq!(repo_kind(&repo, true).await, RepoKind::Remote);

        // Home and disk are refused.
        assert!(enable_version_history(Path::new("/")).await.unwrap_err().contains("whole home folder"));
    }

    #[tokio::test]
    async fn repo_kind_is_reused_until_forgotten_or_fresh() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("k");
        fs::create_dir(&dir).unwrap();
        assert_eq!(repo_kind(&dir, false).await, RepoKind::Plain);
        sh(&dir, &["init", "-q"]).await;
        assert_eq!(repo_kind(&dir, false).await, RepoKind::Plain);
        assert_eq!(repo_kind(&dir, true).await, RepoKind::Empty);
        assert_eq!(repo_kind(&dir, false).await, RepoKind::Empty);
        forget_repo_kind(Some(&dir));
        assert_eq!(repo_kind(&dir, false).await, RepoKind::Empty);
    }

    #[tokio::test]
    async fn a_folder_inside_an_outer_repo_with_no_commits_gets_its_own() {
        let t = tempfile::tempdir().unwrap();
        let outer = t.path().join("outer");
        fs::create_dir_all(outer.join("proj")).unwrap();
        sh(&outer, &["init", "-q"]).await;
        fs::write(outer.join("secret-outside.txt"), "s\n").unwrap();
        fs::write(outer.join("proj/a.txt"), "a\n").unwrap();
        sh(&outer, &["add", "."]).await;
        assert!(enable_version_history(&outer.join("proj")).await.unwrap().changed);
        let mut files: Vec<String> = sh(&outer.join("proj"), &["ls-files"]).await.lines().map(str::to_string).collect();
        files.sort();
        assert_eq!(files, [".gitignore", "a.txt"]);
        assert!(outer.join("proj/.git").exists());
    }
}
