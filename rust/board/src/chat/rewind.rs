//! Rewind (`src/chat/rewind.ts`): go back to an earlier message of a chat, with the project files as they were just
//! before it, and Undo. Hidden git snapshots under `refs/ckanban/rewind/<ticket>/<ms>-<key>` (never a branch, never
//! the user's own history), the session file cut with a `.before-rewind` copy beside it. Async (git runs as child
//! processes); callers on a blocking thread use `tickets::writer::block`.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};

use crate::git::cmd::{RunResult, run};
use crate::runs::js;

pub const REWIND_REFS: &str = "refs/ckanban/rewind";
pub const UNDO_REFS: &str = "refs/ckanban/rewind-undo";

const IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "ckanban"),
    ("GIT_AUTHOR_EMAIL", "ckanban@localhost"),
    ("GIT_COMMITTER_NAME", "ckanban"),
    ("GIT_COMMITTER_EMAIL", "ckanban@localhost"),
];

const GIT: [&str; 5] = ["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];

pub fn now_ms() -> u64 {
    ckanban_core::time::now_ms() as u64
}

fn env_ms(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().map(|v| js::number_of_str(&v)).filter(|n| n.is_finite() && *n != 0.0).map(|n| n.max(1.0) as u64).unwrap_or(default)
}

/// `SNAPSHOT_LIMIT_MS`: how long saving the folder may hold up a message (CKANBAN_SNAPSHOT_LIMIT_MS overrides it).
pub fn snapshot_limit_ms() -> u64 {
    env_ms("CKANBAN_SNAPSHOT_LIMIT_MS", 2000)
}

/// `UNDO_SAVE_LIMIT_MS`: how long saving the folder before a rewind may take.
pub fn undo_save_limit_ms() -> u64 {
    env_ms("CKANBAN_UNDO_SAVE_LIMIT_MS", 60_000)
}

static ATTACH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\S*/attachments/([0-9a-f]{32}\.\w+)").unwrap());

/// `textKey`: short fingerprint of a message's text (attachment links reduced to the file name, as the chat shows).
pub fn text_key(text: &str) -> String {
    let norm = ATTACH.replace_all(js::trim(text), "$1");
    let mut h = Sha1::new();
    h.update(norm.as_bytes());
    hex(&h.finalize())[..12].to_string()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// `hashText`: sha1 of a text, hex.
pub fn hash_text(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    hex(&h.finalize())
}

/// `path.resolve` without touching the disk: `.` and `..` folded.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn git(args: &[&str], dir: &Path) -> RunResult {
    run(args, dir, &[], None).await
}

/// `withIndex` set-up: a throwaway index (a copy of `seed`'s real one when given), so the folder's staged changes are
/// never touched. The folder holding it goes when the guard drops.
struct TempIndex {
    dir: PathBuf,
    index: String,
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl TempIndex {
    async fn new(seed: Option<&Path>) -> std::io::Result<TempIndex> {
        let dir = std::env::temp_dir().join(format!("ck-rewind-{}", crate::git::landing::random_uuid()));
        std::fs::create_dir_all(&dir)?;
        let index = dir.join("index");
        if let Some(seed) = seed {
            let real = git(&["git", "rev-parse", "--git-path", "index"], seed).await;
            if real.ok() && !real.out().is_empty() {
                let p = seed.join(real.out());
                if p.exists() {
                    let _ = std::fs::copy(&p, &index);
                }
            }
        }
        Ok(TempIndex { index: index.to_string_lossy().into_owned(), dir })
    }
    fn env(&self) -> Vec<(&str, &str)> {
        let mut v = vec![("GIT_INDEX_FILE", self.index.as_str())];
        v.extend(IDENTITY);
        v
    }
}

/// `historyTop`: the repo's top folder when `dir` has version history (a repo with a commit), else None.
async fn history_top(dir: &Path) -> Option<PathBuf> {
    if !dir.exists() || !crate::git::repo::has_commits(dir).await {
        return None;
    }
    let top = git(&["git", "rev-parse", "--show-toplevel"], dir).await;
    (top.ok() && !top.out().is_empty()).then(|| PathBuf::from(top.out()))
}

fn left(end: Option<Instant>) -> Option<Duration> {
    end.map(|e| e.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)))
}

/// `currentTree`: the tree of everything in `dir` now (new and changed files, ignored ones left out).
async fn current_tree(dir: &Path, env: &[(&str, &str)], end: Option<Instant>) -> Option<String> {
    let add: Vec<&str> = GIT.iter().copied().chain(["add", "-A", "--", "."]).collect();
    if !run(&add, dir, env, left(end)).await.ok() {
        return None;
    }
    let wt: Vec<&str> = GIT.iter().copied().chain(["write-tree"]).collect();
    let tree = run(&wt, dir, env, left(end)).await;
    tree.ok().then(|| tree.out().to_string())
}

/// `takeSnapshot`: the folder as it is now, tied to the message about to be sent. None without version history or when
/// the save failed or took longer than `limit_ms`.
pub async fn take_snapshot(dir: &Path, ticket_id: &str, text: &str, at: u64, limit_ms: u64) -> Option<String> {
    let r = format!("{REWIND_REFS}/{ticket_id}/{at}-{}", text_key(text));
    save_folder(dir, &r, &format!("ckanban rewind snapshot for {ticket_id}"), limit_ms).await
}

/// `saveFolder`: the folder saved under `r`.
async fn save_folder(dir: &Path, r: &str, message: &str, limit_ms: u64) -> Option<String> {
    let deadline = Instant::now() + Duration::from_millis(limit_ms);
    let end = Some(deadline);
    history_top(dir).await?;
    let idx = TempIndex::new(Some(dir)).await.ok()?;
    let env = idx.env();
    let tree = current_tree(dir, &env, end).await?;
    let ct: Vec<&str> = GIT.iter().copied().chain(["commit-tree", tree.as_str(), "-m", message]).collect();
    let commit = run(&ct, dir, &env, left(end)).await;
    if !commit.ok() || Instant::now() >= deadline {
        return None;
    }
    let set = git(&["git", "update-ref", r, commit.out()], dir).await;
    set.ok().then(|| r.to_string())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub r: String,
    pub at: u64,
    pub key: String,
}

static SNAP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/(\d+)-([0-9a-f]{12})$").unwrap());

/// `listSnapshots`: a ticket's snapshots, oldest first.
pub async fn list_snapshots(dir: &Path, ticket_id: &str) -> Vec<Snapshot> {
    if !dir.exists() {
        return Vec::new();
    }
    let prefix = format!("{REWIND_REFS}/{ticket_id}/");
    let r = git(&["git", "for-each-ref", "--format=%(refname)", &prefix], dir).await;
    if !r.ok() {
        return Vec::new();
    }
    let mut out: Vec<Snapshot> = r
        .stdout
        .split('\n')
        .filter_map(|l| {
            let l = js::trim(l);
            let c = SNAP.captures(l)?;
            Some(Snapshot { r: l.to_string(), at: c[1].parse().ok()?, key: c[2].to_string() })
        })
        .collect();
    out.sort_by_key(|s| s.at);
    out
}

/// `snapshotFor`: the latest snapshot with the message's text taken before Claude read it.
pub fn snapshot_for(snaps: &[Snapshot], text: &str, read_at: &str) -> Option<Snapshot> {
    let key = text_key(text);
    let t = ckanban_core::time::parse_date(read_at).unwrap_or(f64::NAN);
    snaps.iter().rfind(|s| s.key == key && (t.is_nan() || (s.at as f64) <= t + 1000.0)).cloned()
}

#[derive(Clone, Debug, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// A (new since), D (deleted since) or M (edited since).
    pub status: char,
}

impl FileChange {
    pub fn view(&self) -> Value {
        json!({ "path": self.path, "status": self.status.to_string() })
    }
}

/// `changesSince`: files that differ between the snapshot and the folder now.
pub async fn changes_since(dir: &Path, r: &str) -> Option<Vec<FileChange>> {
    let top = history_top(dir).await?;
    let prefix = git(&["git", "rev-parse", "--show-prefix"], dir).await.out().to_string();
    let idx = TempIndex::new(Some(dir)).await.ok()?;
    let tree = current_tree(dir, &idx.env(), None).await?;
    let mut args = vec!["git", "diff-tree", "-r", "-z", "--name-status", "--no-renames", r, tree.as_str()];
    if !prefix.is_empty() {
        args.extend(["--", prefix.as_str()]);
    }
    let d = git(&args, &top).await;
    if !d.ok() {
        return None;
    }
    let parts: Vec<&str> = d.stdout.split('\0').filter(|x| !x.is_empty()).collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < parts.len() {
        let s = parts[i].chars().next().unwrap_or('M');
        out.push(FileChange { path: parts[i + 1].to_string(), status: if s == 'A' || s == 'D' { s } else { 'M' } });
        i += 2;
    }
    Some(out)
}

/// `restoreSnapshot`: the folder's files put back as the snapshot has them; the files that changed back.
pub async fn restore_snapshot(dir: &Path, r: &str) -> Result<Vec<FileChange>, String> {
    let Some(top) = history_top(dir).await else { return Err("This folder has no version history, so files can't be changed back.".into()) };
    let Some(changes) = changes_since(dir, r).await else { return Err("Couldn't compare the files with the earlier point.".into()) };
    let back: Vec<&str> = changes.iter().filter(|c| c.status != 'A').map(|c| c.path.as_str()).collect();
    {
        let idx = TempIndex::new(None).await.map_err(|e| e.to_string())?;
        let env = idx.env();
        let rt: Vec<&str> = GIT.iter().copied().chain(["read-tree", r]).collect();
        let read = run(&rt, &top, &env, None).await;
        if !read.ok() {
            return Err(format!("Couldn't read the earlier point: {}", js::trim(&read.stderr)));
        }
        for chunk in back.chunks(100) {
            let ci: Vec<&str> = GIT.iter().copied().chain(["checkout-index", "-f", "--"]).chain(chunk.iter().copied()).collect();
            let r = run(&ci, &top, &env, None).await;
            if !r.ok() {
                return Err(format!("Couldn't restore files: {}", js::trim(&r.stderr)));
            }
        }
    }
    let top_s = top.to_string_lossy().into_owned();
    for c in changes.iter().filter(|c| c.status == 'A') {
        let abs = lexical(&top.join(&c.path));
        if !abs.to_string_lossy().starts_with(&format!("{top_s}/")) {
            continue;
        }
        if std::fs::remove_file(&abs).is_err() {
            continue;
        }
        // Folders the removed file leaves empty go too, never the project folder itself.
        let mut d = abs.parent().map(Path::to_path_buf);
        while let Some(x) = d {
            let xs = x.to_string_lossy().into_owned();
            if !xs.starts_with(&format!("{top_s}/")) || x == top {
                break;
            }
            let empty = std::fs::read_dir(&x).is_ok_and(|mut it| it.next().is_none());
            if !empty || std::fs::remove_dir(&x).is_err() {
                break;
            }
            d = x.parent().map(Path::to_path_buf);
        }
    }
    Ok(changes)
}

/// `deleteSnapshots`: every saved copy of one ticket (it is done or deleted), Undo's too.
pub async fn delete_snapshots(dir: &Path, ticket_id: &str) {
    if !valid_id(ticket_id) {
        return;
    }
    for s in list_snapshots(dir, ticket_id).await {
        git(&["git", "update-ref", "-d", &s.r], dir).await;
    }
    drop_undo_refs(dir, ticket_id).await;
}

/// What a cut leaves: lines kept, and whether nothing of the conversation is left.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cut {
    pub kept: usize,
    pub empty: bool,
}

/// `cutSession`: the session text up to (not including) the user message `uuid`; None when that isn't a plain user
/// message in the file.
pub fn cut_session(raw: &str, uuid: &str) -> Option<(String, Cut)> {
    let lines: Vec<&str> = raw.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        let Some(ev) = js::parse(line) else { continue };
        if ev.get("uuid").and_then(Value::as_str) != Some(uuid) {
            continue;
        }
        if ev.get("type").and_then(Value::as_str) != Some("user") || js::truthy(ev.get("isSidechain")) {
            return None;
        }
        if let Some(Value::Array(c)) = ev.get("message").and_then(|m| m.get("content"))
            && c.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        {
            return None;
        }
        let kept: Vec<&str> = lines[..i].iter().copied().filter(|l| !l.is_empty()).collect();
        let empty = !kept.iter().any(|l| {
            js::parse(l).is_some_and(|k| matches!(k.get("type").and_then(Value::as_str), Some("user" | "assistant")) && !js::truthy(k.get("isSidechain")))
        });
        let text = if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) };
        return Some((text, Cut { kept: kept.len(), empty }));
    }
    None
}

/// `rewindSessionFile`: the session file cut before the message; the original stays beside it as `.before-rewind`.
pub fn rewind_session_file(file: &Path, uuid: &str) -> Result<Cut, String> {
    let raw = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let Some((text, cut)) = cut_session(&raw, uuid) else { return Err("This message can't be rewound to.".into()) };
    std::fs::copy(file, before_rewind(file)).map_err(|e| e.to_string())?;
    ckanban_core::atomic::atomic_write(file, text).map_err(|e| e.to_string())?;
    Ok(cut)
}

pub fn before_rewind(file: &Path) -> PathBuf {
    PathBuf::from(format!("{}.before-rewind", file.to_string_lossy()))
}

/// `previewRewind`: what going back to the message would change in the folder ({files, filesReason}).
pub async fn preview_rewind(dir: Option<&Path>, ticket_id: &str, text: &str, at: &str) -> Map<String, Value> {
    let snap = match dir {
        Some(d) => snapshot_for(&list_snapshots(d, ticket_id).await, text, at),
        None => None,
    };
    let files = match (dir, &snap) {
        (Some(d), Some(s)) => changes_since(d, &s.r).await,
        _ => None,
    };
    let mut m = Map::new();
    if let Some(f) = files {
        m.insert("files".into(), Value::Array(f.iter().map(FileChange::view).collect()));
        m.insert("filesReason".into(), Value::Null);
        return m;
    }
    let has = match dir {
        Some(d) => crate::git::repo::has_commits(d).await,
        None => false,
    };
    m.insert("files".into(), Value::Null);
    m.insert("filesReason".into(), json!(if has { "no-snapshot" } else { "no-history" }));
    m
}

async fn ref_exists(dir: &Path, r: &str) -> bool {
    git(&["git", "rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")], dir).await.ok()
}

async fn move_ref(dir: &Path, from: &str, to: &str) -> bool {
    let sha = git(&["git", "rev-parse", "--verify", "--quiet", from], dir).await;
    if !sha.ok() || sha.out().is_empty() {
        return false;
    }
    if !git(&["git", "update-ref", to, sha.out()], dir).await.ok() {
        return false;
    }
    git(&["git", "update-ref", "-d", from], dir).await;
    true
}

/// `dropUndoRefs`: what Undo kept for one ticket.
pub async fn drop_undo_refs(dir: &Path, ticket_id: &str) {
    if !valid_id(ticket_id) || !dir.exists() {
        return;
    }
    let prefix = format!("{UNDO_REFS}/{ticket_id}/");
    let r = git(&["git", "for-each-ref", "--format=%(refname)", &prefix], dir).await;
    if !r.ok() {
        return;
    }
    for l in r.stdout.split('\n').map(js::trim).filter(|x| !x.is_empty()) {
        git(&["git", "update-ref", "-d", l], dir).await;
    }
}

/// A rewind or undo refused: `refused` (the chat got busy or moved on meanwhile: 409) or another failure.
#[derive(Debug)]
pub enum RewindError {
    Refused(String),
    Failed(String),
}

impl RewindError {
    pub fn message(&self) -> &str {
        match self {
            RewindError::Refused(m) | RewindError::Failed(m) => m,
        }
    }
}

/// What a rewind did: files changed back, the cut, and what Undo needs (`RewindUndo`, Bun's key order; `messages`
/// and `newSessionId` are the caller's to fill in).
pub struct Applied {
    pub restored: usize,
    pub cut: Cut,
    pub undo: Map<String, Value>,
}

/// `applyRewind`: files first (when asked and a snapshot exists), then the chat is cut before the message. Before files
/// change, the folder is saved so Undo can put it back. `still` is asked right before the cut: a reason stops it.
#[allow(clippy::too_many_arguments)]
pub async fn apply_rewind(
    dir: Option<&Path>, ticket_id: &str, uuid: &str, text: &str, at: &str, session_file: &Path, files: bool, session_id: &str,
    still: &(dyn Fn() -> Option<String> + Send + Sync),
) -> Result<Applied, RewindError> {
    let raw = std::fs::read_to_string(session_file).map_err(|e| RewindError::Failed(e.to_string()))?;
    if cut_session(&raw, uuid).is_none() {
        return Err(RewindError::Failed("This message can't be rewound to.".into()));
    }
    let dir = dir.filter(|_| valid_id(ticket_id));
    let snap = match dir {
        Some(d) => snapshot_for(&list_snapshots(d, ticket_id).await, text, at),
        None => None,
    };
    if let Some(d) = dir {
        drop_undo_refs(d, ticket_id).await;
    }
    let mut restored = 0;
    let mut before: Option<String> = None;
    let mut after: Option<String> = None;
    async fn put_back(dir: Option<&Path>, before: &Option<String>, after: &Option<String>) {
        let Some(d) = dir else { return };
        if let Some(b) = before {
            let _ = restore_snapshot(d, b).await;
        }
        for r in [before, after].into_iter().flatten() {
            git(&["git", "update-ref", "-d", r], d).await;
        }
    }
    if files && let (Some(d), Some(s)) = (dir, &snap) {
        let limit = undo_save_limit_ms();
        before = save_folder(d, &format!("{UNDO_REFS}/{ticket_id}/before"), &format!("ckanban folder before rewind for {ticket_id}"), limit).await;
        match restore_snapshot(d, &s.r).await {
            Ok(c) => restored = c.len(),
            Err(e) => {
                put_back(dir, &before, &after).await;
                return Err(RewindError::Failed(e));
            }
        }
        if before.is_some() {
            after = save_folder(d, &format!("{UNDO_REFS}/{ticket_id}/after"), &format!("ckanban folder after rewind for {ticket_id}"), limit).await;
        }
        if let (Some(b), None) = (&before, &after) {
            // Without the after copy undo can't tell whether files changed since, so it restores the chat only.
            git(&["git", "update-ref", "-d", b], d).await;
            before = None;
        }
    }
    let cut = match still() {
        Some(stop) => Err(RewindError::Refused(stop)),
        None => rewind_session_file(session_file, uuid).map_err(RewindError::Failed),
    };
    let cut = match cut {
        Ok(c) => c,
        Err(e) => {
            put_back(dir, &before, &after).await;
            return Err(e);
        }
    };
    // The removed messages' snapshots are set aside (undo brings them back), not deleted.
    let mut kept: Vec<String> = Vec::new();
    if let (Some(d), Some(s)) = (dir, &snap) {
        for x in list_snapshots(d, ticket_id).await {
            if x.at <= s.at {
                continue;
            }
            let to = format!("{UNDO_REFS}/{ticket_id}/kept/{}-{}", x.at, x.key);
            if move_ref(d, &x.r, &to).await {
                kept.push(to);
            } else {
                git(&["git", "update-ref", "-d", &x.r], d).await;
            }
        }
    }
    let hash = hash_text(&std::fs::read_to_string(session_file).unwrap_or_default());
    let undo = json!({
        "at": crate::tickets::writer::now(), "sessionId": session_id, "hash": hash, "newSessionId": null,
        "messages": 0, "dir": dir.map(|d| d.to_string_lossy().into_owned()), "files": restored, "before": before, "after": after, "kept": kept,
    });
    let Value::Object(undo) = undo else { unreachable!() };
    Ok(Applied { restored, cut, undo })
}

fn us<'a>(u: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    u.get(k).and_then(Value::as_str)
}

/// `undoBlocked`: why the rewind can't be undone now, or None. `session_file` is the file of u.sessionId; `current` the
/// chat's session id now and whether that session has started.
pub async fn undo_blocked(u: Option<&Map<String, Value>>, session_file: Option<&Path>, current: (Option<&str>, bool), files: bool) -> Option<String> {
    let Some(u) = u else { return Some("There is no rewind to undo.".into()) };
    let ok = session_file.is_some_and(|f| f.exists() && before_rewind(f).exists());
    if !ok {
        return Some("The chat from before the rewind is gone, so it can't come back.".into());
    }
    let file = session_file.unwrap();
    let moved = "The chat has moved on since the rewind (a message was sent), so it can't be undone without losing that.".to_string();
    let new_sid = us(u, "newSessionId").filter(|s| !s.is_empty());
    let off = match new_sid {
        Some(n) => current.0 != Some(n) || current.1,
        None => current.0 != us(u, "sessionId"),
    };
    if off {
        return Some(moved);
    }
    if Some(hash_text(&std::fs::read_to_string(file).unwrap_or_default())) != us(u, "hash").map(str::to_string) {
        return Some(moved);
    }
    if files && let (Some(d), Some(b), Some(a)) = (us(u, "dir").filter(|s| !s.is_empty()), us(u, "before").filter(|s| !s.is_empty()), us(u, "after").filter(|s| !s.is_empty())) {
        let d = Path::new(d);
        if !d.exists() || !ref_exists(d, b).await || !ref_exists(d, a).await {
            return Some("The saved files from before the rewind are gone. Undo the chat only?".into());
        }
        let Some(since) = changes_since(d, a).await else { return Some("Couldn't compare the files with how the rewind left them.".into()) };
        if !since.is_empty() {
            let n = since.len();
            return Some(if n == 1 {
                "A file has changed since the rewind, and undo would overwrite it. Undo the chat only?".to_string()
            } else {
                format!("{n} files have changed since the rewind, and undo would overwrite them. Undo the chat only?")
            });
        }
    }
    None
}

static KEPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/kept/(\d+-[0-9a-f]{12})$").unwrap());

/// `applyUndo`: files first, then the chat comes back from its `.before-rewind` copy. The `UndoResult` JSON.
pub async fn apply_undo(u: &Map<String, Value>, session_file: &Path, ticket_id: &str, files: bool, still: &(dyn Fn() -> Option<String> + Send + Sync)) -> Result<Value, RewindError> {
    let backup = before_rewind(session_file);
    let saved = std::fs::read_to_string(&backup).map_err(|e| RewindError::Failed(e.to_string()))?;
    let dir = us(u, "dir").filter(|s| !s.is_empty()).map(Path::new);
    let (b, a) = (us(u, "before").filter(|s| !s.is_empty()), us(u, "after").filter(|s| !s.is_empty()));
    let with_files = files && dir.is_some() && b.is_some() && a.is_some();
    let mut back = 0;
    if with_files {
        back = restore_snapshot(dir.unwrap(), b.unwrap()).await.map_err(RewindError::Failed)?.len();
    }
    let stop = still().or_else(|| {
        (hash_text(&std::fs::read_to_string(session_file).unwrap_or_default()).as_str() != us(u, "hash").unwrap_or("")).then(|| "The chat has moved on since the rewind.".to_string())
    });
    if let Some(stop) = stop {
        if with_files {
            let _ = restore_snapshot(dir.unwrap(), a.unwrap()).await;
        }
        return Err(RewindError::Refused(stop));
    }
    ckanban_core::atomic::atomic_write(session_file, &saved).map_err(|e| RewindError::Failed(e.to_string()))?;
    let _ = std::fs::remove_file(&backup);
    if let Some(d) = dir
        && valid_id(ticket_id)
        && d.exists()
    {
        let kept: Vec<String> = u.get("kept").and_then(Value::as_array).map(|k| k.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        for r in kept {
            if let Some(c) = KEPT.captures(&r)
                && r.starts_with(&format!("{UNDO_REFS}/{ticket_id}/"))
            {
                move_ref(d, &r, &format!("{REWIND_REFS}/{ticket_id}/{}", &c[1])).await;
            }
        }
        drop_undo_refs(d, ticket_id).await;
    }
    let reason = if with_files {
        Value::Null
    } else if !files && b.is_some() {
        json!("skipped")
    } else if js::truthy(u.get("files")) {
        json!("not-saved")
    } else {
        json!("unchanged")
    };
    Ok(json!({ "messages": u.get("messages").cloned().unwrap_or(json!(0)), "files": back, "filesRestored": with_files, "filesReason": reason }))
}

/// `messagesFrom`: chat messages (yours and Claude's replies) from the entry with `uuid` on.
pub fn messages_from(entries: &[Value], uuid: &str) -> usize {
    let Some(i) = entries.iter().position(|e| e.get("uuid").and_then(Value::as_str) == Some(uuid)) else { return 0 };
    entries[i..]
        .iter()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some("text") && matches!(e.get("role").and_then(Value::as_str), Some("user" | "assistant")))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cut_and_keys() {
        let raw = "{\"type\":\"user\",\"uuid\":\"a\",\"message\":{\"content\":\"hi\"}}\n{\"type\":\"assistant\",\"uuid\":\"b\"}\n{\"type\":\"user\",\"uuid\":\"c\",\"message\":{\"content\":\"next\"}}\n";
        let (text, cut) = cut_session(raw, "c").unwrap();
        assert_eq!(cut, Cut { kept: 2, empty: false });
        assert!(text.ends_with("\"b\"}\n"));
        assert_eq!(cut_session(raw, "a").unwrap(), (String::new(), Cut { kept: 0, empty: true }));
        assert!(cut_session(raw, "b").is_none());
        assert_eq!(text_key(" x /tmp/attachments/0123456789abcdef0123456789abcdef.png "), text_key("x 0123456789abcdef0123456789abcdef.png"));
        assert_eq!(text_key("hello").len(), 12);
    }
}
