//! Ticket copies and landing: the git half of `src/board/board-repo.ts` (the folder's repo state, where a ticket's
//! runs work, making its copy, the setup command, removing a copy), `board-main.ts` (merge into main, land a
//! milestone), `board-tickets.ts` (`copyTicket`'s copy of the folder for Branch and Fork) and `board-plans.ts` (the
//! worktree sweep, cleaning up a Done ticket's copy). The plain-folder path (no git, no commits, no remote, no `gh`)
//! works everywhere: such tickets run in the folder itself and landing only records the milestone.
//!
//! Background deletes (the sweep, the Done cleanup, the package trim in `trim.rs`) delete unless `CKANBAN_RUST_DELETE=0`
//! (`dryrun.rs`), which keeps them report-only.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::cmd::run;
use super::ops::{BoardOps, s, set, truthy};
use super::pr::{add_prs, open_pr_with_gh, pr_final, ticket_prs};
use super::repo::{self, RepoKind, Removed};
use super::setup::{self, CLEANUP_TIMEOUT, SETUP_TIMEOUT};
use crate::api::{Failure, Landing};
use crate::dryrun;

/// The live line while the setup command runs.
pub const INSTALLING: &str = "Installing project dependencies…";
/// How long a board folder's repo state is trusted (`REPO_TTL_MS`).
pub const REPO_TTL: Duration = Duration::from_secs(10);
/// Tries a tool ticket gets to merge into its main ticket's copy before it ends blocked.
pub const MERGE_TRIES: u64 = 3;

/// Where a ticket's runs work (`Session`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub dir: PathBuf,
    pub session_id: String,
    /// Only a saved session can be resumed.
    pub existed: bool,
    pub is_git: bool,
    pub repo: RepoKind,
    /// The run edits the board's folder itself (no copy, not a linked session).
    pub in_place: bool,
}

/// What a sweep did: its decisions (as logged when deletes are off), the copies it removed and their size in bytes
/// (only added up when asked).
#[derive(Debug, Default)]
pub struct Swept {
    pub decisions: Vec<Value>,
    pub removed: usize,
    pub bytes: u64,
}

/// Opens a pull request (`openPrWithGh`); tests give their own.
pub type OpenPr = Arc<dyn Fn(PathBuf, String, String, String, String) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

type SetupRun = Shared<BoxFuture<'static, Result<Value, String>>>;

pub struct Git {
    /// The data folder (for the report-only log).
    pub root: PathBuf,
    pub ops: Arc<dyn BoardOps>,
    /// Each board folder's repo kind and when it was checked (`Board.repos`).
    repos: Mutex<HashMap<PathBuf, (RepoKind, Instant)>>,
    repo_checks: Mutex<HashSet<PathBuf>>,
    /// Called when a folder's kind changed (`dispatch(slug)`: tickets held back by an unknown state start then).
    on_repo_change: Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
    session_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    merge_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    setups: Mutex<HashMap<String, (SetupRun, Arc<tokio::sync::Notify>)>>,
    open_pr: OpenPr,
    /// One package trim pass at a time (`trim.rs`).
    pub(super) trim_gate: tokio::sync::Mutex<()>,
    /// The last Free up space: its progress and result (`trim.rs`).
    pub(super) free_up: Mutex<Value>,
    pub(super) on_free_up: Mutex<Option<Arc<dyn Fn(&Value) + Send + Sync>>>,
    /// Report-only trim: copies already logged by the hourly pass.
    pub(super) trim_reported: Mutex<HashSet<String>>,
}

fn key(slug: &str, id: &str) -> String {
    format!("{slug}/{id}")
}

fn exists(p: Option<&str>) -> bool {
    p.is_some_and(|p| !p.is_empty() && Path::new(p).exists())
}

/// The last `n` lines of a command's error text (stderr, else stdout), joined with spaces.
fn last_lines(r: &super::cmd::RunResult, n: usize) -> String {
    let text = if r.stderr.is_empty() { &r.stdout } else { &r.stderr };
    let lines: Vec<&str> = text.trim().split('\n').collect();
    lines[lines.len().saturating_sub(n)..].join(" ")
}

async fn git(args: &[&str], dir: &Path) -> super::cmd::RunResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    run(&cmd, dir, &[], None).await
}

/// `crypto.randomUUID()`.
pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::fill(&mut b).is_err() {
        // No randomness: time and pid still make a unique enough id for a session.
        let t = ckanban_core::time::now_ms() as u128 ^ ((std::process::id() as u128) << 64);
        b = t.to_le_bytes();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// `slugify(s, 40)`: lowercase a-z0-9 words joined by "-", "task" when nothing is left. Bun first decomposes the text
/// (NFKD), so an accented letter becomes its base letter followed by a mark (which turns into "-"); here the common
/// Latin letters do the same, other characters are dropped like any non a-z0-9.
pub fn slugify(text: &str) -> String {
    let mut decomposed = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        match base_letter(c) {
            Some(b) => {
                decomposed.push(b);
                decomposed.push('\u{301}');
            }
            None => decomposed.push(c),
        }
    }
    let mut slug = String::new();
    let mut dash = false;
    for c in decomposed.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !slug.is_empty() {
                slug.push('-');
            }
            dash = false;
            slug.push(c);
        } else {
            dash = true;
        }
    }
    if dash && !slug.is_empty() {
        slug.push('-');
    }
    let cut: String = slug.chars().take(40).collect();
    let out = cut.trim_end_matches('-').to_string();
    if out.is_empty() { "task".into() } else { out }
}

fn base_letter(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'ď' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' => 'i',
        'ñ' | 'ń' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ō' | 'ő' => 'o',
        'ř' => 'r',
        'ś' | 'š' | 'ş' => 's',
        'ť' | 'ţ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
        'ý' | 'ÿ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        _ => return None,
    })
}

/// `runsInFolder`: the ticket's runs edit the board's folder itself (a plain folder or a repo with no commits, a
/// ticket that already ran there, a board set to work in the folder). None: not known yet (the folder is being
/// checked). Linked sessions are the user's own and don't count.
pub fn runs_in_folder(t: &Value, profile: Option<&Value>, kind: Option<RepoKind>) -> Option<bool> {
    if set(t, "workdir").is_some() || set(t, "worktree").is_some() || set(t, "branch").is_some() {
        return Some(false);
    }
    if truthy(t, "sessionStarted") || t.get("runCount").and_then(Value::as_f64).is_some_and(|n| n > 0.0) {
        return Some(true);
    }
    if profile.and_then(|p| s(p, "workspace")) == Some("folder") {
        return Some(true);
    }
    kind.map(|k| matches!(k, RepoKind::Plain | RepoKind::Empty))
}

/// `guessRepo`: before the first check, from the folder's .git (its config names an origin or not).
pub fn guess_repo(path: Option<&str>) -> RepoKind {
    let Some(path) = path.filter(|p| Path::new(p).join(".git").exists()) else { return RepoKind::Plain };
    match std::fs::read_to_string(Path::new(path).join(".git").join("config")) {
        Ok(c) if c.contains("[remote \"origin\"]") => RepoKind::Remote,
        Ok(_) => RepoKind::Local,
        Err(_) => RepoKind::Remote,
    }
}

/// What `branch_folder` gives the new ticket: the fields for its patch (in Bun's order), the copy it made (to remove
/// if the branch fails later) and the warnings for the user.
#[derive(Debug, Clone, PartialEq)]
pub struct BranchFolder {
    pub patch: Map<String, Value>,
    pub worktree: Option<PathBuf>,
    pub warnings: Vec<String>,
}

impl Git {
    pub fn new(root: &Path, ops: Arc<dyn BoardOps>) -> Arc<Git> {
        Self::with_open_pr(
            root,
            ops,
            Arc::new(|dir, branch, base, title, body| Box::pin(async move { open_pr_with_gh(&dir, &branch, &base, &title, &body).await })),
        )
    }

    pub fn with_open_pr(root: &Path, ops: Arc<dyn BoardOps>, open_pr: OpenPr) -> Arc<Git> {
        Arc::new(Git {
            root: root.to_path_buf(),
            ops,
            repos: Mutex::new(HashMap::new()),
            repo_checks: Mutex::new(HashSet::new()),
            on_repo_change: Mutex::new(None),
            session_locks: Mutex::new(HashMap::new()),
            merge_locks: Mutex::new(HashMap::new()),
            setups: Mutex::new(HashMap::new()),
            open_pr,
            trim_gate: tokio::sync::Mutex::new(()),
            free_up: Mutex::new(json!({ "state": "idle", "phase": null, "reportOnly": !dryrun::deletes_on(), "startedAt": null, "finishedAt": null, "bytesFreed": 0, "foldersRemoved": 0, "foldersTrimmed": 0 })),
            on_free_up: Mutex::new(None),
            trim_reported: Mutex::new(HashSet::new()),
        })
    }

    /// What runs when a board folder's kind changes (the run loop's dispatch).
    pub fn on_repo_change(&self, f: impl Fn(&str) + Send + Sync + 'static) {
        *self.on_repo_change.lock() = Some(Arc::new(f));
    }

    fn board_path(&self, slug: &str) -> Option<PathBuf> {
        self.ops.profile(slug).and_then(|p| s(&p, "path").map(PathBuf::from))
    }

    /// `repoState`: the folder's kind from the cache (None until first checked); a stale or missing entry is checked
    /// again in the background.
    pub fn repo_state(self: &Arc<Self>, slug: &str) -> Option<RepoKind> {
        let path = self.board_path(slug).unwrap_or_default();
        let hit = self.repos.lock().get(&path).copied();
        // Callers may be on a plain thread (a plan's delayed wake): the check needs the runtime, so it waits for the
        // next caller that has one.
        if hit.is_none_or(|(_, at)| at.elapsed() > REPO_TTL)
            && let Ok(rt) = tokio::runtime::Handle::try_current()
        {
            let me = self.clone();
            let slug = slug.to_string();
            rt.spawn(async move { me.check_repo(&slug).await });
        }
        hit.map(|(k, _)| k)
    }

    /// The board folder has commits (huddle reviewers get snapshots of committed code); true until known.
    pub fn committed(self: &Arc<Self>, slug: &str) -> bool {
        self.repo_state(slug).is_none_or(RepoKind::committed)
    }

    pub async fn check_repo(&self, slug: &str) {
        let Some(path) = self.board_path(slug) else { return };
        if !self.repo_checks.lock().insert(path.clone()) {
            return;
        }
        let kind = repo::repo_kind(&path, false).await;
        self.repo_checks.lock().remove(&path);
        self.note_repo(slug, kind);
    }

    /// `noteRepo`: records what the folder is now; a change runs `on_repo_change`.
    pub fn note_repo(&self, slug: &str, kind: RepoKind) {
        let Some(path) = self.board_path(slug) else { return };
        let prev = self.repos.lock().insert(path, (kind, Instant::now())).map(|(k, _)| k);
        if prev != Some(kind) {
            let hook = self.on_repo_change.lock().clone();
            if let Some(f) = hook {
                f(slug);
            }
        }
    }

    /// `runsInFolder` with this board's cached repo state (checked only when the answer needs it).
    pub fn runs_in_folder(self: &Arc<Self>, slug: &str, t: &Value) -> Option<bool> {
        let profile = self.ops.profile(slug);
        runs_in_folder(t, profile.as_ref(), None).or_else(|| runs_in_folder(t, profile.as_ref(), self.repo_state(slug)))
    }

    /// A copy is being made or set up for this ticket right now (the sweep leaves it alone).
    pub fn busy(&self, slug: &str, id: &str) -> bool {
        let k = key(slug, id);
        self.setups.lock().contains_key(&k) || self.session_locks.lock().contains_key(&k)
    }

    /// `ensureSession`: where the ticket's next run works, making its copy of the folder first when it needs one.
    /// One at a time per ticket: a run and a "copy command" click must not both create the copy.
    pub async fn ensure_session(self: &Arc<Self>, slug: &str, id: &str) -> Result<Session, Failure> {
        let lock = self.session_lock(slug, id);
        let out = {
            let _held = lock.lock().await;
            self.ensure_session_now(slug, id).await
        };
        self.drop_session_lock(slug, id, &lock);
        out
    }

    /// The ticket's session lock (making a copy, the package trim): one at a time per ticket.
    pub(super) fn session_lock(&self, slug: &str, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.session_locks.lock().entry(key(slug, id)).or_default().clone()
    }

    /// Forgets the ticket's session lock once nobody else holds or waits for it.
    pub(super) fn drop_session_lock(&self, slug: &str, id: &str, lock: &Arc<tokio::sync::Mutex<()>>) {
        let k = key(slug, id);
        let mut locks = self.session_locks.lock();
        if locks.get(&k).is_some_and(|l| Arc::ptr_eq(l, lock) && Arc::strong_count(l) == 2) {
            locks.remove(&k);
        }
    }

    /// The board's setup command runs in the ticket's copy right now.
    pub(super) fn setup_running(&self, slug: &str, id: &str) -> bool {
        self.setups.lock().contains_key(&key(slug, id))
    }

    async fn ensure_session_now(self: &Arc<Self>, slug: &str, id: &str) -> Result<Session, Failure> {
        let profile = self.ops.profile(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let path = PathBuf::from(s(&profile, "path").unwrap_or(""));
        if !path.exists() {
            return Err(format!("board folder does not exist: {}", path.display()));
        }
        let t = self.ops.ticket(slug, id).ok_or_else(|| format!("ticket {id} not found"))?;
        let kind = repo::repo_kind(&path, false).await;
        self.note_repo(slug, kind);
        let is_git = kind != RepoKind::Plain;
        let mut patch = Map::new();
        if let Some(w) = set(&t, "workdir") {
            if !Path::new(w).exists() {
                return Err(format!("linked session folder no longer exists: {w}"));
            }
        }
        let has_wt = set(&t, "worktree").is_some();
        let has_branch = set(&t, "branch").is_some();
        let ran = truthy(&t, "sessionStarted") || t.get("runCount").and_then(Value::as_f64).is_some_and(|n| n > 0.0);
        // A ticket that already ran in the folder stays there: its Claude session belongs to that folder.
        let ran_in_place = !has_wt && !has_branch && ran;
        let folder_mode = s(&profile, "workspace") == Some("folder") && !has_wt && !has_branch;
        if is_git && set(&t, "workdir").is_none() && !ran_in_place && !folder_mode && !exists(s(&t, "worktree")) {
            let dir = repo::worktree_dir(&path, slug, id);
            let title = s(&t, "title").unwrap_or("");
            let mut branch = set(&t, "branch").map(str::to_string).unwrap_or_else(|| format!("ck/{id}-{}", slugify(title)));
            if let Some(b) = set(&t, "branch") {
                if !dir.exists() && !repo::branch_exists(&path, b).await {
                    // Claude may have renamed the branch in its copy: take the ticket's newest one, else start over.
                    match repo::branches_with_prefix(&path, &format!("ck/{id}-")).await.into_iter().next() {
                        Some(renamed) => branch = renamed,
                        None => {
                            patch.insert("notice".into(), json!(format!("Branch \"{b}\" was not found, so this ticket's worktree starts again from the base branch.")));
                        }
                    }
                }
            }
            let saved_base = s(&profile, "baseBranch").unwrap_or("").to_string();
            let base = if dir.exists() { Some(saved_base.clone()) } else { repo::resolve_base_branch(&path, &saved_base).await };
            match base {
                None => {
                    // A fresh `git init` with no commits: run in the folder rather than fail.
                    patch.insert("notice".into(), json!("This repo has no commits yet, so Claude works directly in your folder instead of an isolated worktree. Make a first commit to give new tickets their own worktree."));
                }
                Some(base) => {
                    if base != saved_base {
                        eprintln!("profile {slug}: base branch \"{saved_base}\" not found, using \"{base}\"");
                        let mut fixed = profile.clone();
                        fixed["baseBranch"] = json!(base);
                        self.ops.save_profile(fixed);
                        if !saved_base.is_empty() {
                            patch.insert("notice".into(), json!(format!("Base branch \"{saved_base}\" was not found in this repo, so the board now uses \"{base}\".")));
                        }
                    }
                    if !dir.exists() {
                        // A new branch starts from the remote's latest base; a step builds on its main ticket's copy.
                        let start_from = set(&t, "startFrom");
                        let from = match start_from {
                            Some(sf) if repo::branch_exists(&path, sf).await => sf.to_string(),
                            _ if kind == RepoKind::Remote && !repo::branch_exists(&path, &branch).await => repo::latest_base(&path, &base, repo::FETCH_TIMEOUT).await?,
                            _ => base.clone(),
                        };
                        repo::add_worktree(&path, &dir, &branch, &from).await?;
                        // Only the cheap part now; the setup command runs when Claude asks for it.
                        self.copy_worktree_files(slug, id, &profile, &dir).await;
                        patch.insert("setupPending".into(), json!(true));
                        // A main ticket's Changes tab shows its whole family's work since here.
                        if truthy(&t, "main") && set(&t, "startSha").is_none() {
                            let head = git(&["rev-parse", "HEAD"], &dir).await;
                            if head.ok() && !head.out().is_empty() {
                                patch.insert("startSha".into(), json!(head.out()));
                            }
                        }
                    }
                    if set(&t, "startFrom").is_some() {
                        patch.insert("startFrom".into(), Value::Null);
                    }
                    patch.insert("worktree".into(), json!(dir.to_string_lossy()));
                    patch.insert("branch".into(), json!(branch));
                }
            }
        }
        // In place on a repo with commits: the folder's HEAD at the first run is what the Changes tab diffs against.
        if set(&t, "workdir").is_none() && !has_wt && !patch.contains_key("worktree") && set(&t, "baseSha").is_none() && kind.committed() {
            let head = git(&["rev-parse", "HEAD"], &path).await;
            if head.ok() && !head.out().is_empty() {
                patch.insert("baseSha".into(), json!(head.out()));
            }
        }
        if set(&t, "sessionId").is_none() {
            patch.insert("sessionId".into(), json!(random_uuid()));
        }
        let t = if patch.is_empty() { t } else { self.ops.patch(slug, id, patch)? };
        let session_id = s(&t, "sessionId").unwrap_or("").to_string();
        let workdir = set(&t, "workdir");
        let worktree = set(&t, "worktree");
        Ok(Session {
            dir: PathBuf::from(workdir.or(worktree).map(str::to_string).unwrap_or_else(|| path.to_string_lossy().into_owned())),
            existed: (workdir.is_some() && !truthy(&t, "freshSession")) || self.ops.session_exists(&session_id),
            session_id,
            is_git,
            repo: kind,
            in_place: workdir.is_none() && worktree.is_none(),
        })
    }

    /// `copyWorktreeFiles`: the board's git-ignored files (.env) into a new copy; missing ones are only logged.
    pub async fn copy_worktree_files(&self, slug: &str, id: &str, profile: &Value, dir: &Path) {
        let patterns: Vec<String> = profile.get("copyFiles").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        if patterns.is_empty() {
            return;
        }
        let from = PathBuf::from(s(profile, "path").unwrap_or(""));
        let to = dir.to_path_buf();
        let r = tokio::task::spawn_blocking(move || setup::copy_setup_files(&from, &to, &patterns)).await.unwrap_or_default();
        if !r.missing.is_empty() {
            eprintln!("ticket {slug}/{id}: files to copy not found: {}", r.missing.join(", "));
        }
    }

    /// `runSetup`: runs the board's setup command in the ticket's copy when its Claude asks; calls while one runs share
    /// it; after a success it isn't run again for this copy. A failed command is a result, not an error.
    pub async fn run_setup(self: &Arc<Self>, slug: &str, id: &str) -> Result<Value, Failure> {
        let (Some(profile), Some(t)) = (self.ops.profile(slug), self.ops.ticket(slug, id)) else { return Err(format!("ticket {id} not found")) };
        let k = key(slug, id);
        if let Some((running, _)) = self.setups.lock().get(&k).cloned() {
            return running.await;
        }
        let command = s(&profile, "setupCommand").unwrap_or("").trim().to_string();
        if !exists(s(&t, "worktree")) {
            return Ok(json!({ "status": "no-worktree" }));
        }
        if command.is_empty() {
            return Ok(json!({ "status": "no-command" }));
        }
        if !truthy(&t, "setupPending") {
            return Ok(json!({ "status": "already-done" }));
        }
        let dir = s(&t, "worktree").unwrap_or("").to_string();
        let abort = Arc::new(tokio::sync::Notify::new());
        let me = self.clone();
        let (slug2, id2, ab) = (slug.to_string(), id.to_string(), abort.clone());
        let fut: SetupRun = async move {
            let _ = me.ops.patch(&slug2, &id2, super::ops::patch1("lastActivity", json!(INSTALLING)));
            let repo = PathBuf::from(s(&profile, "path").unwrap_or(""));
            let env_ticket = format!("{slug2}/{id2}");
            let r = setup::prepare_worktree(&repo, Path::new(&dir), &json!({ "setupCommand": command }), SETUP_TIMEOUT, None, &[("CKANBAN_TICKET", &env_ticket)], Some(ab))
                .await
                .unwrap_or(Value::Null);
            // The copy may have been removed or replaced meanwhile: only mark the one it ran in.
            if let Some(now) = me.ops.ticket(&slug2, &id2) {
                let mut p = Map::new();
                if r["ok"] == true && s(&now, "worktree") == Some(dir.as_str()) {
                    p.insert("setupPending".into(), json!(false));
                    // Packages are back: a later Done may trim them again (`trim.rs`).
                    if truthy(&now, super::trim::TRIMMED_AT) {
                        p.insert(super::trim::TRIMMED_AT.into(), Value::Null);
                    }
                }
                if s(&now, "lastActivity") == Some(INSTALLING) {
                    p.insert("lastActivity".into(), Value::Null);
                }
                let _ = me.ops.patch(&slug2, &id2, p);
            }
            if r["ok"] != true {
                let out = r["output"].as_str().unwrap_or("");
                let lines: Vec<&str> = out.split('\n').collect();
                eprintln!("ticket {slug2}/{id2}: setup failed ({}): {}", r["command"].as_str().unwrap_or(""), lines[lines.len().saturating_sub(3)..].join(" | "));
            }
            me.setups.lock().remove(&key(&slug2, &id2));
            Ok(json!({ "status": "ran", "result": r }))
        }
        .boxed()
        .shared();
        self.setups.lock().insert(k, (fut.clone(), abort));
        fut.await
    }

    /// Stops a running setup command of the ticket (its run was stopped).
    pub fn stop_setup(&self, slug: &str, id: &str) {
        if let Some((_, abort)) = self.setups.lock().get(&key(slug, id)) {
            abort.notify_one();
        }
    }

    /// `removeTicketWorktree`: removes a copy, running the board's cleanup command in it first (its failure never
    /// blocks). This deletes: callers decide whether a background job may (`dryrun::deletes_on`).
    pub async fn remove_ticket_worktree(&self, profile: &Value, dir: &Path) -> Removed {
        let repo_path = PathBuf::from(s(profile, "path").unwrap_or(""));
        let cleanup = s(profile, "cleanupCommand").map(str::trim).filter(|c| !c.is_empty()).map(str::to_string);
        let before = cleanup.map(|c| {
            let d = dir.to_path_buf();
            async move {
                let r = setup::run_shell(&d, &c, CLEANUP_TIMEOUT, None, &[], None).await;
                if !r.ok {
                    let lines: Vec<&str> = r.output.split('\n').collect();
                    eprintln!("worktree cleanup failed in {} ({c}): {}", d.display(), lines[lines.len().saturating_sub(5)..].join(" | "));
                }
            }
        });
        repo::remove_worktree(&repo_path, dir, before).await
    }

    /// `cleanupWorktree` (a ticket moved to Done): removes its copy when clean, else says where it was kept. With
    /// deletes switched off (`dryrun.rs`) the decision only goes to the dry-run log and the ticket keeps its copy.
    pub async fn cleanup_worktree(&self, slug: &str, id: &str) -> Result<(), Failure> {
        self.cleanup_worktree_with(slug, id, dryrun::deletes_on()).await
    }

    /// `cleanup_worktree` with the switch given (tests).
    pub async fn cleanup_worktree_with(&self, slug: &str, id: &str, deleting: bool) -> Result<(), Failure> {
        let (Some(profile), Some(t)) = (self.ops.profile(slug), self.ops.ticket(slug, id)) else { return Ok(()) };
        let Some(wt) = set(&t, "worktree").map(PathBuf::from) else { return Ok(()) };
        if !deleting {
            let (action, reason) = would_remove(&wt).await;
            dryrun::report(&self.root, "done-cleanup", decision(slug, id, &wt, action, reason));
            return Ok(());
        }
        let r = self.remove_ticket_worktree(&profile, &wt).await;
        if r.removed {
            self.ops.patch(slug, id, super::ops::patch1("worktree", Value::Null))?;
        } else {
            self.ops.add_comment(slug, id, "ai", &format!("Worktree kept at {}: {}", wt.display(), r.reason.unwrap_or_default()));
        }
        Ok(())
    }

    /// `sweepWorktrees` (once at start): copies left behind by Done or deleted tickets in each board's own copies
    /// folder. Clean ones are removed, ones with changes kept and logged. Report-only when deletes are switched off
    /// (and then `git worktree prune` is skipped too). Never fails. The decisions, as written to the dry-run log.
    pub async fn sweep_worktrees(&self) -> Vec<Value> {
        self.sweep_worktrees_with(dryrun::deletes_on(), false).await.decisions
    }

    /// The sweep with the switch given. `measure`: add up the size of each copy before removing it (Free up space
    /// shows the bytes freed; the start-up sweep skips the walk). Only folders named like a ticket id are ever treated
    /// as left behind: a worktree someone made by hand in the copies folder (`t_..._xxxx-ops`) is kept.
    pub async fn sweep_worktrees_with(&self, deleting: bool, measure: bool) -> Swept {
        let mut decisions = Vec::new();
        let (mut removed_total, mut bytes) = (0usize, 0u64);
        for profile in self.ops.profiles() {
            let (Some(slug), Some(path)) = (s(&profile, "slug").map(str::to_string), s(&profile, "path").map(PathBuf::from)) else { continue };
            if !repo::is_git_repo(&path).await {
                continue;
            }
            let root = repo::worktree_dir(&path, &slug, "x").parent().map(Path::to_path_buf).unwrap_or_default();
            if !root.exists() {
                continue;
            }
            let real_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
            let listed = if deleting { repo::list_worktrees(&path).await } else { list_worktrees_quietly(&path).await };
            let (mut swept, mut kept) = (0, Vec::new());
            for dir in listed {
                let dir = PathBuf::from(dir);
                let parent = dir.parent().map(Path::to_path_buf).unwrap_or_default();
                if parent != real_root && parent != root {
                    continue;
                }
                let id = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let t = self.ops.ticket(&slug, &id);
                if t.is_none() && !ckanban_core::layout::is_ticket_id(&id) {
                    let d = decision(&slug, &id, &dir, "keep", Some("not a ticket copy".into()));
                    if !deleting {
                        dryrun::report(&self.root, "worktree-sweep", d.clone());
                    }
                    decisions.push(Value::Object(d));
                    continue;
                }
                // A ticket file the board couldn't load (unreadable, half written) still names a ticket: its copy is
                // never treated as left behind (Bun would sweep it; keeping it costs only disk).
                if t.is_none() && ckanban_core::DataDir::new(self.root.clone()).ticket_dir(&slug, &id).join("ticket.md").exists() {
                    continue;
                }
                let busy = self.ops.busy(&slug, &id) || self.busy(&slug, &id);
                if let Some(t) = &t {
                    if s(t, "status") != Some("done") || busy {
                        continue;
                    }
                }
                if !deleting {
                    let (action, reason) = would_remove(&dir).await;
                    let d = decision(&slug, &id, &dir, action, reason);
                    dryrun::report(&self.root, "worktree-sweep", d.clone());
                    decisions.push(Value::Object(d));
                    continue;
                }
                // The ticket's session lock while it goes: a run starting now waits, then makes a fresh copy. Held
                // elsewhere (a run or a copy being made): left for the next sweep.
                let lock = self.session_lock(&slug, &id);
                let Ok(held) = lock.try_lock() else {
                    self.drop_session_lock(&slug, &id, &lock);
                    continue;
                };
                let size = if measure && dir.exists() {
                    let d = dir.clone();
                    tokio::task::spawn_blocking(move || super::trim::tree_size(&d)).await.unwrap_or(0)
                } else {
                    0
                };
                // Last look right before removing: still Done (or still no ticket) and nothing working in it.
                let now = self.ops.ticket(&slug, &id);
                let still = match (&t, &now) {
                    (None, None) => true,
                    (Some(_), Some(n)) => s(n, "status") == Some("done") && !self.ops.busy(&slug, &id) && !self.setup_running(&slug, &id),
                    _ => false,
                };
                if !still {
                    drop(held);
                    self.drop_session_lock(&slug, &id, &lock);
                    continue;
                }
                let r = self.remove_ticket_worktree(&profile, &dir).await;
                drop(held);
                self.drop_session_lock(&slug, &id, &lock);
                if !r.removed {
                    kept.push(format!("{id} ({})", r.reason.unwrap_or_default()));
                    continue;
                }
                swept += 1;
                removed_total += 1;
                if !dir.exists() {
                    bytes += size;
                }
                if t.as_ref().and_then(|t| set(t, "worktree")).is_some() {
                    let _ = self.ops.patch(&slug, &id, super::ops::patch1("worktree", Value::Null));
                }
            }
            if swept > 0 || !kept.is_empty() {
                let list = if kept.is_empty() { String::new() } else { format!(": {}", kept.join(", ")) };
                eprintln!("profile {slug}: swept {swept} orphan worktree{}, kept {} with changes{list}", if swept == 1 { "" } else { "s" }, kept.len());
            }
        }
        Swept { decisions, removed: removed_total, bytes }
    }

    /// `merge_into_main`: fast-forwards the main ticket's copy to the tool ticket's branch, one at a time per main
    /// ticket. Refused (and counted) when the main copy moved since the tool ticket merged it.
    pub async fn merge_into_main(&self, slug: &str, tool_id: &str) -> Result<String, Failure> {
        let tool = self.ops.ticket(slug, tool_id).ok_or_else(|| format!("ticket {tool_id} not found"))?;
        if !truthy(&tool, "tool") {
            return Err("only a tool ticket merges into its main ticket's copy".into());
        }
        let main = self.ops.main_of(slug, tool_id).ok_or("this ticket has no main ticket to merge into")?;
        let main_id = s(&main, "id").unwrap_or("").to_string();
        let k = key(slug, &main_id);
        let lock = self.merge_locks.lock().entry(k.clone()).or_default().clone();
        let out = {
            let _held = lock.lock().await;
            self.merge_now(slug, tool_id, &main_id).await
        };
        let mut locks = self.merge_locks.lock();
        if locks.get(&k).is_some_and(|l| Arc::ptr_eq(l, &lock) && Arc::strong_count(l) == 2) {
            locks.remove(&k);
        }
        out
    }

    async fn merge_now(&self, slug: &str, tool_id: &str, main_id: &str) -> Result<String, Failure> {
        let profile = self.ops.profile(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let path = PathBuf::from(s(&profile, "path").unwrap_or(""));
        let tool = self.ops.ticket(slug, tool_id).ok_or_else(|| format!("ticket {tool_id} not found"))?;
        let main = self.ops.ticket(slug, main_id).ok_or_else(|| format!("ticket {main_id} not found"))?;
        let (Some(tool_wt), Some(tool_branch)) = (set(&tool, "worktree"), set(&tool, "branch")) else {
            return Ok("Nothing to merge: you edit the project folder itself, so your changes are already where the main ticket sees them.".into());
        };
        let Some(main_branch) = set(&main, "branch") else {
            return Err("the main ticket has no copy of its own to merge into; end with your branch as it is and say so in your summary".into());
        };
        if let Some(b) = [tool_branch, main_branch].into_iter().find(|b| b.starts_with('-')) {
            return Err(option_like(b));
        }
        let dirty = git(&["status", "--porcelain"], Path::new(tool_wt)).await;
        if dirty.ok() && !dirty.out().is_empty() {
            return Err("you have changes that aren't committed yet: commit them, then call merge_into_main again".into());
        }
        if !git(&["merge-base", "--is-ancestor", main_branch, tool_branch], &path).await.ok() {
            let fails = tool.get("mergeFails").and_then(Value::as_u64).unwrap_or(0) + 1;
            self.ops.patch(slug, tool_id, super::ops::patch1("mergeFails", json!(fails)))?;
            if fails >= MERGE_TRIES {
                let parent = set(&tool, "parentId").unwrap_or(main_id);
                let title = s(&tool, "title").unwrap_or("");
                self.ops.push_event(slug, parent, &format!("merge failed: {tool_id} \"{title}\" couldn't merge into the main copy {fails} times, so it ends blocked."));
                return Err(format!(
                    "The main ticket's copy moved again (try {fails} of {MERGE_TRIES}). Stop here: end your run with status \"blocked\" and say what is left to merge; your parent decides what happens next."
                ));
            }
            return Err(format!(
                "The main ticket's copy moved since you last merged it (try {fails} of {MERGE_TRIES}): merge again and retry. Run `git merge {main_branch}`, sort out any clashes, re-run the checks, commit, then call merge_into_main again."
            ));
        }
        let sha = git(&["rev-parse", tool_branch], &path).await.out().to_string();
        let count: u64 = git(&["rev-list", "--count", &format!("{main_branch}..{tool_branch}")], &path).await.out().parse().unwrap_or(0);
        let mut done = Map::new();
        done.insert("merged".into(), json!(sha));
        done.insert("mergeFails".into(), json!(0));
        if count == 0 {
            self.ops.patch(slug, tool_id, done)?;
            return Ok("Nothing new to merge: the main ticket's copy already has your work.".into());
        }
        let r = match set(&main, "worktree").filter(|w| Path::new(w).exists()) {
            Some(mw) => git(&["merge", "--ff-only", tool_branch], Path::new(mw)).await,
            None => git(&["branch", "-f", main_branch, tool_branch], &path).await,
        };
        if !r.ok() {
            return Err(format!("couldn't move the main ticket's copy forward: {}", last_lines(&r, 3)));
        }
        self.ops.patch(slug, tool_id, done)?;
        let plural = if count == 1 { "" } else { "s" };
        let title = s(&tool, "title").unwrap_or("");
        self.ops.add_comment(slug, main_id, "ai", &format!("Merged {count} commit{plural} of {tool_id} \"{title}\" into this ticket's copy."));
        self.ops.emit_ticket(slug, main_id);
        Ok(format!("Merged {count} commit{plural} into the main ticket's copy ({main_branch})."))
    }

    /// `land_milestone`: lands the main ticket's copy as the board lands work (landRule): push and one pull request on
    /// a repo with a remote (the open one is updated), a merge into the project folder without one. Plain folders
    /// only record it (the work is already there).
    pub async fn land_milestone(&self, slug: &str, id: &str, summary: &str) -> Result<String, Failure> {
        let (Some(t), Some(profile)) = (self.ops.ticket(slug, id), self.ops.profile(slug)) else { return Err(format!("ticket {id} not found")) };
        if !truthy(&t, "main") {
            return Err("only a main ticket lands milestones".into());
        }
        let trimmed = summary.trim();
        let text = String::from_utf16_lossy(&trimmed.encode_utf16().take(500).collect::<Vec<u16>>());
        if text.is_empty() {
            return Err("say in one line what this milestone is (summary)".into());
        }
        let path = PathBuf::from(s(&profile, "path").unwrap_or(""));
        // Fresh: a remote the user just added must be pushed to.
        let kind = repo::repo_kind(&path, true).await;
        let (branch, wt) = (set(&t, "branch"), set(&t, "worktree"));
        let (Some(branch), Some(wt)) = (branch.filter(|_| kind.committed()), wt.filter(|w| Path::new(w).exists())) else {
            self.ops.record_milestone(slug, id, &text, "already in the project folder")?;
            return Ok("Recorded the milestone: the tool tickets already edited the project folder itself, so there is nothing else to land.".into());
        };
        if branch.starts_with('-') {
            return Err(option_like(branch));
        }
        let wt = Path::new(wt);
        let dirty = git(&["status", "--porcelain"], wt).await;
        if dirty.ok() && !dirty.out().is_empty() {
            return Err("the main ticket's copy has uncommitted changes, so it can't land cleanly; start a fix tool ticket to commit or drop them".into());
        }
        let base = set(&profile, "baseBranch").unwrap_or("main").to_string();
        if kind == RepoKind::Remote {
            let push = git(&["push", "-u", "origin", branch], wt).await;
            if !push.ok() {
                return Err(format!(
                    "couldn't push the main ticket's copy: {}. Start a fix tool ticket (for example to merge {base} in and sort out clashes).",
                    last_lines(&push, 3)
                ));
            }
            let open = ticket_prs(&t).into_iter().find(|p| !pr_final(p.get("state").and_then(Value::as_str))).and_then(|p| s(&p, "url").map(str::to_string));
            let url = match &open {
                Some(u) => u.clone(),
                None => {
                    let title = s(&t, "title").unwrap_or("").to_string();
                    let url = (self.open_pr)(wt.to_path_buf(), branch.to_string(), base.clone(), title, text.clone())
                        .await
                        .map_err(|e| format!("pushed the copy, but couldn't open the pull request: {e}"))?;
                    let now = self.ops.ticket(slug, id).unwrap_or(t.clone());
                    self.ops.patch(slug, id, add_prs(&now, std::slice::from_ref(&url)))?;
                    url
                }
            };
            let word = if open.is_some() { "updated" } else { "opened" };
            self.ops.record_milestone(slug, id, &text, &format!("{word} {url}"))?;
            let what = if open.is_some() { "updated the open" } else { "opened a" };
            return Ok(format!("Landed: pushed your copy and {what} pull request: {url}"));
        }
        // No remote: merge the copy into the project folder, like a ticket's own run would.
        let head = git(&["rev-parse", "--abbrev-ref", "HEAD"], &path).await;
        if head.out() != base {
            return Err(format!("the project folder is on \"{}\", not {base}, so the board won't merge into it; ask the user to switch it back", head.out()));
        }
        if !git(&["status", "--porcelain"], &path).await.out().is_empty() {
            return Err("the project folder has uncommitted changes, so the board won't merge into it; ask the user to save or discard them first".into());
        }
        let m = git(&["merge", "--no-edit", branch], &path).await;
        if !m.ok() {
            git(&["merge", "--abort"], &path).await;
            let text = if m.stdout.is_empty() { &m.stderr } else { &m.stdout };
            let lines: Vec<&str> = text.trim().split('\n').collect();
            let last = lines[lines.len().saturating_sub(2)..].join(" ");
            return Err(format!(
                "merging into {base} clashed ({last}), so nothing was landed. Start a fix tool ticket to merge {base} into your copy and sort out the clashes"
            ));
        }
        let sha = git(&["rev-parse", "--short", "HEAD"], &path).await.out().to_string();
        self.ops.record_milestone(slug, id, &text, &format!("merged into {base} in the project folder at {sha}"))?;
        Ok(format!("Landed: merged your copy into {base} in the project folder ({sha})."))
    }

    /// The folder half of `copyTicket` (Branch, Fork): the new ticket works where the source does: its linked folder,
    /// a copy of its own on a branch off the source's (from the base branch when the source's is gone), or the
    /// project folder itself.
    pub async fn branch_folder(&self, slug: &str, src: &Value, new_id: &str, title: &str) -> Result<BranchFolder, Failure> {
        let profile = self.ops.profile(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let path = PathBuf::from(s(&profile, "path").unwrap_or(""));
        let mut out = BranchFolder { patch: Map::new(), worktree: None, warnings: Vec::new() };
        if let Some(w) = set(src, "workdir") {
            out.patch.insert("workdir".into(), json!(w));
            return Ok(out);
        }
        let is_git = repo::is_git_repo(&path).await;
        if let Some(src_branch) = set(src, "branch").filter(|_| is_git) {
            let dir = repo::worktree_dir(&path, slug, new_id);
            let branch = format!("ck/{new_id}-{}", slugify(title));
            let has_branch = git(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{src_branch}")], &path).await.ok();
            let mut base = src_branch.to_string();
            if !has_branch {
                base = repo::resolve_base_branch(&path, s(&profile, "baseBranch").unwrap_or(""))
                    .await
                    .ok_or_else(|| format!("branch {src_branch} no longer exists and the repo has nothing to branch from"))?;
                out.warnings.push(format!("The source branch {src_branch} no longer exists, so the branch starts from {base}."));
            } else if let Some(sw) = set(src, "worktree").filter(|w| Path::new(w).exists()) {
                let st = git(&["status", "--porcelain"], Path::new(sw)).await;
                if st.ok() && !st.out().is_empty() {
                    out.warnings.push("Uncommitted changes in the source were not copied.".into());
                }
            }
            repo::add_worktree(&path, &dir, &branch, &base).await?;
            self.copy_worktree_files(slug, new_id, &profile, &dir).await;
            out.patch.insert("worktree".into(), json!(dir.to_string_lossy()));
            out.patch.insert("branch".into(), json!(branch));
            out.patch.insert("setupPending".into(), json!(true));
            out.worktree = Some(dir);
            return Ok(out);
        }
        // The source works in the project folder itself: so does the branch, with the same Changes base.
        if let Some(b) = set(src, "baseSha") {
            out.patch.insert("baseSha".into(), json!(b));
        }
        out.warnings.push(if is_git {
            "The original works in the project folder, so the branch edits the same files; they run one at a time.".into()
        } else {
            "This folder has no version history, so the branch edits the same files as the original; they run one at a time.".into()
        });
        Ok(out)
    }
}

/// `git worktree list` without `prune` (report-only mode changes nothing in the user's repo).
async fn list_worktrees_quietly(repo_path: &Path) -> Vec<String> {
    let r = git(&["worktree", "list", "--porcelain"], repo_path).await;
    if !r.ok() {
        return Vec::new();
    }
    r.stdout.split('\n').filter_map(|l| l.strip_prefix("worktree ")).skip(1).map(str::to_string).collect()
}

/// What removing this copy would do now: "delete" when it is clean, else "keep" with the reason (as `removeWorktree`
/// decides, without its cleanup command).
async fn would_remove(dir: &Path) -> (&'static str, Option<String>) {
    if !dir.exists() {
        return ("delete", Some("folder already gone".into()));
    }
    // No optional locks: a report must not refresh the copy's index or take its lock.
    let st = git(&["--no-optional-locks", "status", "--porcelain"], dir).await;
    if !st.ok() {
        return ("keep", Some(st.stderr.trim().to_string()));
    }
    if !st.out().is_empty() {
        return ("keep", Some("worktree has uncommitted changes".into()));
    }
    ("delete", None)
}

fn decision(slug: &str, id: &str, dir: &Path, action: &str, reason: Option<String>) -> Map<String, Value> {
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

impl Landing for Git {
    fn merge_into_main(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        let (slug, id) = (slug.to_string(), id.to_string());
        Box::pin(async move { Git::merge_into_main(self, &slug, &id).await.map(Value::String) })
    }
    fn land(&self, slug: &str, id: &str, summary: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        let (slug, id, summary) = (slug.to_string(), id.to_string(), summary.to_string());
        Box::pin(async move { self.land_milestone(&slug, &id, &summary).await.map(Value::String) })
    }
    fn cleanup_worktree(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<(), Failure>> {
        let (slug, id) = (slug.to_string(), id.to_string());
        Box::pin(async move { Git::cleanup_worktree(self, &slug, &id).await })
    }
    fn repo_state(&self, slug: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        let path = self.board_path(slug);
        Box::pin(async move {
            let path = path.ok_or("board not found")?;
            Ok(json!(repo::repo_kind(&path, false).await.as_str()))
        })
    }
}

/// A branch name git would read as an option: never passed to git (Bun's git would fail on it the same way).
fn option_like(branch: &str) -> String {
    format!("the branch name \"{branch}\" starts with \"-\", so git would read it as an option; the board won't pass it to git")
}

#[cfg(test)]
mod tests {
    use super::super::ops::mem::MemBoard;
    use super::super::repo::tests::{make_repo, sh};
    use super::*;
    use std::fs;

    #[test]
    fn slugs_and_uuids() {
        assert_eq!(slugify("Rust board R6: git, copies!"), "rust-board-r6-git-copies");
        assert_eq!(slugify("Résumé café"), "re-sume-cafe");
        assert_eq!(slugify("!!!"), "task");
        assert_eq!(slugify(&"a".repeat(60)).len(), 40);
        assert_eq!(slugify("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let u = random_uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }

    #[test]
    fn where_runs_work() {
        let none: Option<&Value> = None;
        assert_eq!(runs_in_folder(&json!({ "worktree": "/x" }), none, None), Some(false));
        assert_eq!(runs_in_folder(&json!({ "runCount": 1 }), none, None), Some(true));
        assert_eq!(runs_in_folder(&json!({}), Some(&json!({ "workspace": "folder" })), None), Some(true));
        assert_eq!(runs_in_folder(&json!({}), none, None), None);
        assert_eq!(runs_in_folder(&json!({}), none, Some(RepoKind::Empty)), Some(true));
        assert_eq!(runs_in_folder(&json!({}), none, Some(RepoKind::Remote)), Some(false));
        let t = tempfile::tempdir().unwrap();
        assert_eq!(guess_repo(t.path().to_str()), RepoKind::Plain);
        fs::create_dir(t.path().join(".git")).unwrap();
        fs::write(t.path().join(".git/config"), "[remote \"origin\"]\n").unwrap();
        assert_eq!(guess_repo(t.path().to_str()), RepoKind::Remote);
    }

    fn board(repo: &Path) -> Arc<MemBoard> {
        let b = Arc::new(MemBoard::default());
        b.add_profile(json!({ "slug": "p", "path": repo, "baseBranch": "main", "copyFiles": [".env"] }));
        b
    }

    #[tokio::test]
    async fn plain_folder_tickets_run_in_place_and_land_by_recording() {
        let t = tempfile::tempdir().unwrap();
        let plain = t.path().join("plain");
        fs::create_dir(&plain).unwrap();
        let b = board(&plain);
        b.add("p", json!({ "id": "m", "title": "Main", "main": true }));
        let g = Git::new(t.path(), b.clone());
        let s1 = g.ensure_session("p", "m").await.unwrap();
        assert!(s1.in_place && !s1.is_git && s1.repo == RepoKind::Plain);
        assert_eq!(s1.dir, plain);
        assert!(b.get("p", "m")["sessionId"].as_str().is_some());
        assert!(b.get("p", "m").get("worktree").is_none());
        let msg = g.land_milestone("p", "m", "  first cut  ").await.unwrap();
        assert!(msg.starts_with("Recorded the milestone"));
        assert_eq!(b.milestones.lock()[0].2, "first cut");
        assert_eq!(b.milestones.lock()[0].3, "already in the project folder");
        assert_eq!(g.land_milestone("p", "m", " ").await.unwrap_err(), "say in one line what this milestone is (summary)");
        // A tool ticket in a plain folder has nothing to merge.
        b.add("p", json!({ "id": "w", "title": "Work", "tool": true, "parentId": "m" }));
        assert!(g.merge_into_main("p", "w").await.unwrap().starts_with("Nothing to merge"));
        // Setup: no copy.
        assert_eq!(g.run_setup("p", "w").await.unwrap(), json!({ "status": "no-worktree" }));
    }

    #[tokio::test]
    async fn copies_merge_into_main_and_land_without_a_remote() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        fs::write(repo.join(".gitignore"), ".env\n").unwrap();
        fs::write(repo.join(".env"), "K=1\n").unwrap();
        sh(&repo, &["add", ".gitignore"]).await;
        sh(&repo, &["commit", "-qm", "ignore"]).await;
        let b = board(&repo);
        b.add("p", json!({ "id": "m1", "title": "The main", "main": true, "status": "in_progress" }));
        let g = Git::new(t.path(), b.clone());
        let sm = g.ensure_session("p", "m1").await.unwrap();
        let main = b.get("p", "m1");
        assert_eq!(main["branch"], "ck/m1-the-main");
        assert_eq!(sm.dir, PathBuf::from(main["worktree"].as_str().unwrap()));
        assert!(!sm.in_place && sm.repo == RepoKind::Local);
        assert_eq!(main["setupPending"], true);
        assert!(main["startSha"].as_str().is_some());
        assert_eq!(fs::read_to_string(sm.dir.join(".env")).unwrap(), "K=1\n");
        assert_eq!(main.as_object().unwrap().keys().skip(4).collect::<Vec<_>>(), ["setupPending", "startSha", "worktree", "branch", "sessionId"]);
        // Again: the same copy.
        assert_eq!(g.ensure_session("p", "m1").await.unwrap().dir, sm.dir);

        // A tool ticket starts from the main copy, commits, merges.
        b.add("p", json!({ "id": "w1", "title": "Step one", "tool": true, "parentId": "m1", "startFrom": "ck/m1-the-main" }));
        let sw = g.ensure_session("p", "w1").await.unwrap();
        assert_eq!(b.get("p", "w1")["startFrom"], Value::Null);
        fs::write(sw.dir.join("step.txt"), "1\n").unwrap();
        assert_eq!(g.merge_into_main("p", "w1").await.unwrap_err(), "you have changes that aren't committed yet: commit them, then call merge_into_main again");
        sh(&sw.dir, &["add", "."]).await;
        sh(&sw.dir, &["commit", "-qm", "step"]).await;
        assert_eq!(g.merge_into_main("p", "w1").await.unwrap(), "Merged 1 commit into the main ticket's copy (ck/m1-the-main).");
        assert!(sm.dir.join("step.txt").exists());
        assert_eq!(b.comment_texts("m1"), ["Merged 1 commit of w1 \"Step one\" into this ticket's copy."]);
        assert_eq!(b.get("p", "w1")["mergeFails"], 0);
        assert_eq!(g.merge_into_main("p", "w1").await.unwrap(), "Nothing new to merge: the main ticket's copy already has your work.");
        // The main copy moves on: refused, counted, blocked at the third try.
        fs::write(sm.dir.join("main.txt"), "m\n").unwrap();
        sh(&sm.dir, &["add", "."]).await;
        sh(&sm.dir, &["commit", "-qm", "main moved"]).await;
        fs::write(sw.dir.join("step2.txt"), "2\n").unwrap();
        sh(&sw.dir, &["add", "."]).await;
        sh(&sw.dir, &["commit", "-qm", "step2"]).await;
        assert!(g.merge_into_main("p", "w1").await.unwrap_err().contains("(try 1 of 3): merge again and retry"));
        assert!(g.merge_into_main("p", "w1").await.unwrap_err().contains("(try 2 of 3)"));
        assert!(g.merge_into_main("p", "w1").await.unwrap_err().contains("moved again (try 3 of 3)"));
        assert!(b.events.lock()[0].2.starts_with("merge failed: w1"));
        // Not a tool ticket.
        assert_eq!(g.merge_into_main("p", "m1").await.unwrap_err(), "only a tool ticket merges into its main ticket's copy");

        // Land without a remote: merged into main in the project folder.
        let msg = g.land_milestone("p", "m1", "milestone one").await.unwrap();
        assert!(msg.starts_with("Landed: merged your copy into main in the project folder ("), "{msg}");
        assert!(repo.join("step.txt").exists() && repo.join("main.txt").exists());
        // Dirty copy refused.
        fs::write(sm.dir.join("dirty.txt"), "d").unwrap();
        assert!(g.land_milestone("p", "m1", "again").await.unwrap_err().starts_with("the main ticket's copy has uncommitted changes"));
    }

    #[tokio::test]
    async fn land_with_a_remote_pushes_and_opens_one_pr() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        let bare = t.path().join("remote.git");
        sh(t.path(), &["init", "-q", "--bare", "-b", "main", &bare.to_string_lossy()]).await;
        sh(&repo, &["remote", "add", "origin", &bare.to_string_lossy()]).await;
        sh(&repo, &["push", "-q", "-u", "origin", "main"]).await;
        let b = board(&repo);
        b.add("p", json!({ "id": "m2", "title": "Feature", "main": true }));
        let opened = Arc::new(Mutex::new(Vec::<(String, String, String)>::new()));
        let o2 = opened.clone();
        let g = Git::with_open_pr(
            t.path(),
            b.clone(),
            Arc::new(move |_dir, branch, base, _title, body| {
                o2.lock().push((branch, base, body));
                Box::pin(async { Ok("https://github.com/o/r/pull/5".to_string()) })
            }),
        );
        let sm = g.ensure_session("p", "m2").await.unwrap();
        assert_eq!(sm.repo, RepoKind::Remote);
        fs::write(sm.dir.join("f.txt"), "f").unwrap();
        sh(&sm.dir, &["add", "."]).await;
        sh(&sm.dir, &["commit", "-qm", "f"]).await;
        assert_eq!(g.land_milestone("p", "m2", "first").await.unwrap(), "Landed: pushed your copy and opened a pull request: https://github.com/o/r/pull/5");
        assert_eq!(*opened.lock(), [("ck/m2-feature".to_string(), "main".to_string(), "first".to_string())]);
        assert_eq!(b.get("p", "m2")["prUrl"], "https://github.com/o/r/pull/5");
        assert!(sh(&bare, &["branch", "--list", "ck/m2-feature"]).await.contains("ck/m2-feature"));
        assert_eq!(g.land_milestone("p", "m2", "second").await.unwrap(), "Landed: pushed your copy and updated the open pull request: https://github.com/o/r/pull/5");
        assert_eq!(opened.lock().len(), 1);
    }

    #[tokio::test]
    async fn setup_runs_once_and_branch_copies_the_folder() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        let b = board(&repo);
        {
            let mut ps = b.profiles.lock();
            ps[0]["setupCommand"] = json!("echo installed > installed.txt");
        }
        b.add("p", json!({ "id": "s1", "title": "Setup" }));
        let g = Git::new(t.path(), b.clone());
        let sess = g.ensure_session("p", "s1").await.unwrap();
        let r = g.run_setup("p", "s1").await.unwrap();
        assert_eq!(r["status"], "ran");
        assert_eq!(r["result"]["ok"], true);
        assert!(sess.dir.join("installed.txt").exists());
        let after = b.get("p", "s1");
        assert_eq!((after["setupPending"].clone(), after["lastActivity"].clone()), (json!(false), Value::Null));
        assert_eq!(g.run_setup("p", "s1").await.unwrap(), json!({ "status": "already-done" }));

        // Branch: a copy on a branch off the source's; the source's uncommitted changes are not copied.
        fs::write(sess.dir.join("wip.txt"), "w").unwrap();
        let src = b.get("p", "s1");
        let bf = g.branch_folder("p", &src, "s2", "Branch: Setup").await.unwrap();
        assert_eq!(bf.warnings, ["Uncommitted changes in the source were not copied."]);
        assert_eq!(bf.patch["branch"], "ck/s2-branch-setup");
        assert_eq!(bf.patch.keys().collect::<Vec<_>>(), ["worktree", "branch", "setupPending"]);
        let wt = bf.worktree.unwrap();
        assert!(wt.join("README.md").exists() && !wt.join("wip.txt").exists());
        // A source with no branch works in the folder.
        let bf2 = g.branch_folder("p", &json!({ "id": "x", "baseSha": "abc" }), "s3", "B").await.unwrap();
        assert_eq!(bf2.patch, json!({ "baseSha": "abc" }).as_object().unwrap().clone());
        assert!(bf2.warnings[0].starts_with("The original works in the project folder"));
    }

    #[tokio::test]
    async fn the_sweep_reports_with_deletes_off_and_keeps_hand_made_folders() {
        let t = tempfile::tempdir().unwrap();
        let data = t.path().join("data");
        fs::create_dir(&data).unwrap();
        let repo = make_repo(t.path(), "repo").await;
        let b = board(&repo);
        b.add("p", json!({ "id": "d1", "title": "Done one", "status": "done" }));
        b.add("p", json!({ "id": "o1", "title": "Open one", "status": "review" }));
        b.add("p", json!({ "id": "d2", "title": "Done dirty", "status": "done" }));
        let g = Git::new(&data, b.clone());
        for id in ["d1", "o1", "d2"] {
            g.ensure_session("p", id).await.unwrap();
        }
        let dirty = PathBuf::from(b.get("p", "d2")["worktree"].as_str().unwrap());
        fs::write(dirty.join("x.txt"), "x").unwrap();
        // A copy whose ticket is gone.
        let orphan = repo::worktree_dir(&repo, "p", "t_20260101_gone");
        repo::add_worktree(&repo, &orphan, "ck/gone", "main").await.unwrap();
        // A worktree someone made by hand in the copies folder: not a ticket id, never treated as left behind.
        let hand = repo::worktree_dir(&repo, "p", "t_20260101_gone-ops");
        repo::add_worktree(&repo, &hand, "ck/gone-ops", "main").await.unwrap();
        // A copy whose ticket file is there but wasn't loaded (unreadable): never treated as left behind.
        let unread = repo::worktree_dir(&repo, "p", "t_20260101_unrd");
        repo::add_worktree(&repo, &unread, "ck/unread", "main").await.unwrap();
        let tdir = ckanban_core::DataDir::new(data.clone()).ticket_dir("p", "t_20260101_unrd");
        fs::create_dir_all(&tdir).unwrap();
        fs::write(tdir.join("ticket.md"), "not front matter").unwrap();
        let pairs = |v: &[Value]| {
            let mut got: Vec<(String, String)> = v.iter().map(|d| (d["ticket"].as_str().unwrap().to_string(), d["action"].as_str().unwrap().to_string())).collect();
            got.sort();
            got
        };
        let got = pairs(&g.sweep_worktrees_with(false, false).await.decisions);
        assert_eq!(
            got,
            [("d1".to_string(), "delete".to_string()), ("d2".into(), "keep".into()), ("t_20260101_gone".into(), "delete".into()), ("t_20260101_gone-ops".into(), "keep".into())]
        );
        // Nothing was deleted, and it was all logged.
        assert!(orphan.exists() && hand.exists() && PathBuf::from(b.get("p", "d1")["worktree"].as_str().unwrap()).exists());
        assert_eq!(ckanban_core::jsonl::read_all(&dryrun::log_path(&data)).unwrap().len(), 4);
        // The Done cleanup reports too.
        g.cleanup_worktree_with("p", "d1", false).await.unwrap();
        let log = ckanban_core::jsonl::read_all(&dryrun::log_path(&data)).unwrap();
        assert_eq!(log[4]["job"], "done-cleanup");
        assert!(b.get("p", "d1")["worktree"].is_string());

        // Deletes on: the clean Done copy and the left-behind one go; changes, open tickets, an unreadable ticket's
        // copy and the hand-made folder stay.
        let d1 = PathBuf::from(b.get("p", "d1")["worktree"].as_str().unwrap());
        let open = PathBuf::from(b.get("p", "o1")["worktree"].as_str().unwrap());
        let swept = g.sweep_worktrees_with(true, true).await;
        assert_eq!(swept.removed, 2);
        assert!(swept.bytes > 0);
        assert!(!d1.exists() && !orphan.exists());
        assert!(b.get("p", "d1")["worktree"].is_null());
        assert!(dirty.join("x.txt").exists() && open.exists() && unread.exists() && hand.exists());
        assert_eq!(ckanban_core::jsonl::read_all(&dryrun::log_path(&data)).unwrap().len(), 5);
    }
}
