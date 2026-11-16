//! The Changes tab: a ticket copy's changes against where it started, or a folder's changes since a commit. Port of
//! `src/runs/diff.ts`; the answer has Bun's shape and key order (`TicketDiff`).

use std::path::Path;

use serde_json::{Map, Value, json};

use super::cmd::{RunResult, run};

/// Files whose patch is longer than this many lines are listed without content.
pub const MAX_FILE_LINES: usize = 3000;
/// Most changed files one diff answers, and most patch lines it sends in all.
pub const MAX_DIFF_FILES: usize = 300;
pub const MAX_DIFF_LINES: usize = 20_000;

/// Says why a folder's changes can't be shown since its start.
pub const REWRITTEN_NOTE: &str = "The project folder's version history changed since this ticket started (for example a branch switch or a reset), so its changes can't be shown here. Claude's summary lists the files it changed.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffError {
    pub status: u16,
    pub message: String,
}

fn err(status: u16, message: impl Into<String>) -> DiffError {
    DiffError { status, message: message.into() }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineType {
    Ctx,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub ty: LineType,
    pub text: String,
    pub old: Option<u64>,
    pub new: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    /// A, M, D or R.
    pub status: char,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub too_large: bool,
    pub hunks: Vec<DiffHunk>,
    pub more: bool,
}

impl DiffFile {
    fn new(path: String) -> Self {
        DiffFile { path, old_path: None, status: 'M', additions: 0, deletions: 0, binary: false, too_large: false, hunks: Vec::new(), more: false }
    }

    /// Bun's object: `oldPath` only for renames (set between `path` and `status`, after `rename from`), `more` only on
    /// the last "and N more" row.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("path".into(), json!(self.path));
        m.insert("status".into(), json!(self.status.to_string()));
        m.insert("additions".into(), json!(self.additions));
        m.insert("deletions".into(), json!(self.deletions));
        m.insert("binary".into(), json!(self.binary));
        m.insert("tooLarge".into(), json!(self.too_large));
        let hunks: Vec<Value> = self
            .hunks
            .iter()
            .map(|h| {
                let lines: Vec<Value> = h
                    .lines
                    .iter()
                    .map(|l| {
                        let ty = match l.ty {
                            LineType::Ctx => "ctx",
                            LineType::Add => "add",
                            LineType::Del => "del",
                        };
                        json!({ "type": ty, "text": l.text, "old": l.old, "new": l.new })
                    })
                    .collect();
                json!({ "header": h.header, "lines": lines })
            })
            .collect();
        m.insert("hunks".into(), Value::Array(hunks));
        if let Some(o) = &self.old_path {
            m.insert("oldPath".into(), json!(o));
        }
        if self.more {
            m.insert("more".into(), json!(true));
        }
        Value::Object(m)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketDiff {
    pub base: String,
    pub merge_base: String,
    pub branch: Option<String>,
    pub files: Vec<DiffFile>,
    pub additions: u64,
    pub deletions: u64,
    pub note: Option<String>,
    pub more_files: Option<usize>,
    pub started_from: Option<String>,
}

impl TicketDiff {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("base".into(), json!(self.base));
        m.insert("mergeBase".into(), json!(self.merge_base));
        m.insert("branch".into(), json!(self.branch));
        m.insert("files".into(), Value::Array(self.files.iter().map(DiffFile::to_json).collect()));
        m.insert("additions".into(), json!(self.additions));
        m.insert("deletions".into(), json!(self.deletions));
        if let Some(n) = &self.note {
            m.insert("note".into(), json!(n));
        }
        if let Some(n) = self.more_files {
            m.insert("moreFiles".into(), json!(n));
        }
        if let Some(s) = &self.started_from {
            m.insert("startedFrom".into(), json!(s));
        }
        Value::Object(m)
    }
}

async fn git(args: &[&str], dir: &Path) -> RunResult {
    let mut cmd = vec!["git"];
    cmd.extend_from_slice(args);
    run(&cmd, dir, &[], None).await
}

async fn current_branch(dir: &Path) -> Option<String> {
    let b = git(&["branch", "--show-current"], dir).await;
    let s = b.out();
    (!s.is_empty()).then(|| s.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Mb {
    r#ref: String,
    sha: String,
}

async fn is_ancestor(dir: &Path, a: &str, b: &str) -> bool {
    git(&["merge-base", "--is-ancestor", a, b], dir).await.ok()
}

/// The merge-base of HEAD with the base branch; its origin/ copy is tried too and the newer merge-base wins.
async fn merge_base(dir: &Path, base: &str) -> Option<Mb> {
    let mut refs = vec![base.to_string()];
    if !base.starts_with("origin/") {
        let o = format!("origin/{base}");
        if o != base {
            refs.push(o);
        }
    }
    let mut best: Option<Mb> = None;
    for r in refs {
        let res = git(&["merge-base", "HEAD", &r], dir).await;
        let sha = res.out().to_string();
        if !res.ok() || sha.is_empty() {
            continue;
        }
        match &best {
            None => best = Some(Mb { r#ref: r, sha }),
            Some(b) if sha != b.sha && is_ancestor(dir, &b.sha, &sha).await => best = Some(Mb { r#ref: r, sha }),
            _ => {}
        }
    }
    best
}

fn moved_line(line: &str) -> Option<&str> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(?:branch: (?:Created from|Reset to)|rebase(?: \([a-z]+\))?: checkout|reset: moving to) (\S+)$").unwrap()
    });
    RE.captures(line).and_then(|c| c.get(1)).map(|m| m.as_str())
}

fn not_a_name(name: &str) -> bool {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^HEAD\b|^[0-9a-f]{7,40}$|[~^@:]").unwrap());
    RE.is_match(name)
}

/// Versions the ticket's branch was moved onto, newest first (reflogs of HEAD and the branch); only names of
/// branches that still exist, never the ticket's own branch or its origin/ copy.
async fn moved_onto(dir: &Path, branch: Option<&str>) -> Vec<String> {
    let mut logs = vec![git(&["reflog", "show", "-n", "200", "--format=%gs", "HEAD"], dir).await];
    if let Some(b) = branch {
        logs.push(git(&["reflog", "show", "-n", "200", "--format=%gs", &format!("refs/heads/{b}")], dir).await);
    }
    let own: Vec<String> = branch.map(|b| vec![b.to_string(), format!("origin/{b}")]).unwrap_or_default();
    let mut names: Vec<String> = Vec::new();
    for r in &logs {
        if !r.ok() {
            continue;
        }
        for line in r.stdout.split('\n') {
            let Some(name) = moved_line(line.trim()) else { continue };
            if own.iter().any(|o| o == name) || names.iter().any(|n| n == name) || not_a_name(name) {
                continue;
            }
            names.push(name.to_string());
        }
    }
    let mut real = Vec::new();
    for name in names.into_iter().take(8) {
        let ok = git(&["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")], dir).await.ok()
            || git(&["show-ref", "--verify", "--quiet", &format!("refs/remotes/{name}")], dir).await.ok();
        if ok {
            real.push(name);
        }
    }
    real
}

fn plain(r: &str) -> &str {
    r.strip_prefix("origin/").unwrap_or(r)
}

/// What the ticket's changes are compared with: its PR's base when it has one, else the board's base branch unless
/// the branch was moved onto another version (then whichever has the newest merge-base with HEAD).
async fn compare_base(dir: &Path, base: &str, pr_base: Option<&str>, branch: Option<&str>) -> Option<Mb> {
    if let Some(pb) = pr_base.filter(|s| !s.is_empty()) {
        if let Some(mb) = merge_base(dir, pb).await {
            return Some(mb);
        }
    }
    let mut best = merge_base(dir, base).await;
    for name in moved_onto(dir, branch).await {
        if plain(&name) == plain(base) {
            continue;
        }
        let Some(mb) = merge_base(dir, &name).await else { continue };
        let take = match &best {
            None => true,
            Some(b) => mb.sha != b.sha && is_ancestor(dir, &b.sha, &mb.sha).await,
        };
        if take {
            best = Some(mb);
        }
    }
    best
}

/// `ticketDiff`: the copy's changes (commits, staged, unstaged, untracked) against the merge-base with where it
/// started (`compare_base`).
pub async fn ticket_diff(dir: &Path, base: &str, ignore_whitespace: bool, pr_base: Option<&str>) -> Result<TicketDiff, DiffError> {
    if !dir.exists() {
        return Err(err(404, "the ticket's worktree no longer exists"));
    }
    let branch = current_branch(dir).await;
    let Some(mb) = compare_base(dir, base, pr_base, branch.as_deref()).await else {
        return Err(err(400, format!("no common ancestor with the base branch \"{base}\"")));
    };
    let mut d = diff_from(dir, &mb, ignore_whitespace).await?;
    if plain(&mb.r#ref) != plain(base) {
        d.started_from = Some(plain(&mb.r#ref).to_string());
    }
    Ok(d)
}

/// `folderDiff`: everything in the folder since `sha`; a note instead when `sha` is no longer an ancestor of HEAD.
pub async fn folder_diff(dir: &Path, sha: &str, ignore_whitespace: bool) -> Result<TicketDiff, DiffError> {
    if !dir.exists() {
        return Err(err(404, "the board's folder no longer exists"));
    }
    let r: String = sha.chars().take(7).collect();
    if !is_ancestor(dir, sha, "HEAD").await {
        let branch = current_branch(dir).await;
        return Ok(TicketDiff {
            base: r,
            merge_base: sha.to_string(),
            branch,
            files: Vec::new(),
            additions: 0,
            deletions: 0,
            note: Some(REWRITTEN_NOTE.into()),
            more_files: None,
            started_from: None,
        });
    }
    diff_from(dir, &Mb { r#ref: r, sha: sha.to_string() }, ignore_whitespace).await
}

/// A throwaway index file, removed (with its lock) when dropped.
struct TempIndex(std::path::PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

async fn diff_from(dir: &Path, mb: &Mb, ignore_whitespace: bool) -> Result<TicketDiff, DiffError> {
    let branch = current_branch(dir).await;
    let index = TempIndex(std::env::temp_dir().join(format!(
        "ckanban-diff-{}-{}-{}.index",
        std::process::id(),
        ckanban_core::time::now_ms() as u64,
        ckanban_core::atomic::new_id()
    )));
    let idx = index.0.to_string_lossy().to_string();
    let env = [("GIT_INDEX_FILE", idx.as_str())];
    let mut r = run(&["git", "read-tree", "HEAD"], dir, &env, None).await;
    if r.ok() {
        r = run(&["git", "add", "-A"], dir, &env, None).await;
    }
    if !r.ok() {
        return Err(err(500, format!("git failed: {}", r.stderr.trim())));
    }
    let mut args: Vec<&str> =
        vec!["git", "-c", "core.quotePath=false", "diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
    if ignore_whitespace {
        args.push("-w");
    }
    // The names first (no contents compared): past MAX_DIFF_FILES only the first ones' patch is made.
    let mut names = args.clone();
    names.extend(["--name-status", "-z", mb.sha.as_str()]);
    r = run(&names, dir, &env, None).await;
    if !r.ok() {
        return Err(err(500, format!("git diff failed: {}", r.stderr.trim())));
    }
    let changed = name_status(&r.stdout);
    let shown = &changed[..changed.len().min(MAX_DIFF_FILES)];
    let more = changed.len() - shown.len();
    let mut patch = args.clone();
    patch.push(mb.sha.as_str());
    let paths: Vec<String> = if more > 0 { shown.iter().flatten().cloned().collect() } else { Vec::new() };
    let r = if more > 0 {
        patch.push("--");
        patch.extend(paths.iter().map(String::as_str));
        run(&patch, dir, &[env[0], ("GIT_LITERAL_PATHSPECS", "1")], None).await
    } else {
        run(&patch, dir, &env, None).await
    };
    if !r.ok() {
        return Err(err(500, format!("git diff failed: {}", r.stderr.trim())));
    }
    let mut files = parse_diff(&r.stdout);
    let additions = files.iter().map(|f| f.additions).sum();
    let deletions = files.iter().map(|f| f.deletions).sum();
    let mut out = TicketDiff {
        base: mb.r#ref.clone(),
        merge_base: mb.sha.clone(),
        branch,
        files: Vec::new(),
        additions,
        deletions,
        note: None,
        more_files: None,
        started_from: None,
    };
    if more > 0 {
        out.more_files = Some(more);
        let mut row = DiffFile::new(format!("… and {} more changed files (not shown)", en_us(more)));
        row.more = true;
        files.push(row);
    }
    out.files = files;
    Ok(out)
}

/// `n.toLocaleString("en-US")`: thousands separated by commas.
fn en_us(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `git diff --name-status -z`: each changed file's paths (a rename's old and new one).
fn name_status(out: &str) -> Vec<Vec<String>> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut files = Vec::new();
    let mut i = 0;
    while i < parts.len() {
        let st = parts[i];
        i += 1;
        if st.is_empty() {
            continue;
        }
        let two = st.starts_with('R') || st.starts_with('C');
        let n = if two { 2 } else { 1 };
        let paths: Vec<String> = parts[i..(i + n).min(parts.len())].iter().filter(|p| !p.is_empty()).map(|p| p.to_string()).collect();
        i += n;
        if !paths.is_empty() {
            files.push(paths);
        }
    }
    files
}

/// Undoes git's C-style quoting of a path (`"a/t\303\251st"`).
fn unquote(p: &str) -> String {
    if p.len() < 2 || !p.starts_with('"') || !p.ends_with('"') {
        return p.to_string();
    }
    let s: Vec<char> = p[1..p.len() - 1].chars().collect();
    let mut bytes: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] != '\\' {
            let mut b = [0u8; 4];
            bytes.extend_from_slice(s[i].encode_utf8(&mut b).as_bytes());
            i += 1;
            continue;
        }
        i += 1;
        let Some(&n) = s.get(i) else { break };
        if ('0'..='7').contains(&n) {
            let digits: String = s[i..(i + 3).min(s.len())].iter().collect();
            // parseInt stops at the first non-octal digit.
            let oct: String = digits.chars().take_while(|c| ('0'..='7').contains(c)).collect();
            bytes.push(u32::from_str_radix(&oct, 8).unwrap_or(0) as u8);
            i += 3;
        } else {
            let b = match n {
                'n' => 10,
                't' => 9,
                'r' => 13,
                'b' => 8,
                'f' => 12,
                'v' => 11,
                'a' => 7,
                '"' => 34,
                '\\' => 92,
                c => c as u32 as u8,
            };
            bytes.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// A path from a ---/+++ line: "a/x", "b/x" or /dev/null.
fn side(rest: &str) -> Option<String> {
    let p = unquote(rest.strip_suffix('\t').unwrap_or(rest));
    if p == "/dev/null" {
        return None;
    }
    Some(p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(&p).to_string())
}

fn hunk_header(line: &str) -> Option<(u64, u64)> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@").unwrap());
    let c = RE.captures(line)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?))
}

/// `parseDiff`: `git diff` patch output into files, hunks and numbered lines.
pub fn parse_diff(out: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut in_hunk = false;
    let (mut old_no, mut new_no) = (0u64, 0u64);
    let mut patch_lines = 0usize;
    let mut kept = 0usize;
    let mut lines: Vec<&str> = out.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let finish = |files: &mut Vec<DiffFile>| {
        if let Some(f) = files.last_mut() {
            if f.too_large {
                f.hunks.clear();
            }
        }
    };
    for line in lines {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            finish(&mut files);
            // "a/P b/P": for an unrenamed file both halves are equal, so the path is the middle split.
            let half = if rest.chars().count() >= 5 {
                let chars: Vec<char> = rest.chars().collect();
                let n = (chars.len() - 1) / 2;
                unquote(&chars[..n].iter().collect::<String>())
            } else {
                String::new()
            };
            files.push(DiffFile::new(half.strip_prefix("a/").unwrap_or(&half).to_string()));
            in_hunk = false;
            patch_lines = 0;
            continue;
        }
        let Some(f) = files.last_mut() else { continue };
        if !in_hunk {
            if line.starts_with("new file mode") {
                f.status = 'A';
            } else if line.starts_with("deleted file mode") {
                f.status = 'D';
            } else if let Some(from) = line.strip_prefix("rename from ") {
                f.status = 'R';
                f.old_path = Some(unquote(from));
            } else if let Some(to) = line.strip_prefix("rename to ") {
                f.path = unquote(to);
            } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
                f.binary = true;
            } else if let Some(rest) = line.strip_prefix("--- ") {
                if let Some(p) = side(rest) {
                    if f.status != 'R' {
                        f.path = p;
                    }
                }
            } else if let Some(rest) = line.strip_prefix("+++ ") {
                if let Some(p) = side(rest) {
                    f.path = p;
                }
            }
        }
        if let Some((o, n)) = hunk_header(line) {
            old_no = o;
            new_no = n;
            f.hunks.push(DiffHunk { header: line.to_string(), lines: Vec::new() });
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        let c = line.chars().next();
        if c == Some('\\') {
            continue; // "\ No newline at end of file"
        }
        patch_lines += 1;
        if patch_lines > MAX_FILE_LINES || kept >= MAX_DIFF_LINES {
            f.too_large = true;
        }
        if !f.too_large {
            kept += 1;
        }
        let text: String = line.chars().skip(1).collect();
        let hunk = f.hunks.last_mut().expect("in a hunk");
        match c {
            Some('+') => {
                f.additions += 1;
                if !f.too_large {
                    hunk.lines.push(DiffLine { ty: LineType::Add, text, old: None, new: Some(new_no) });
                }
                new_no += 1;
            }
            Some('-') => {
                f.deletions += 1;
                if !f.too_large {
                    hunk.lines.push(DiffLine { ty: LineType::Del, text, old: Some(old_no), new: None });
                }
                old_no += 1;
            }
            _ => {
                if !f.too_large {
                    hunk.lines.push(DiffLine { ty: LineType::Ctx, text, old: Some(old_no), new: Some(new_no) });
                }
                old_no += 1;
                new_no += 1;
            }
        }
    }
    finish(&mut files);
    files
}

#[cfg(test)]
mod tests {
    use super::super::repo::tests::{make_repo, sh};
    use super::*;
    use std::fs;

    #[test]
    fn parses_a_patch() {
        let out = "diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+n\ndiff --git a/old name.txt b/new name.txt\nsimilarity index 100%\nrename from old name.txt\nrename to new name.txt\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\ndiff --git \"a/t\\303\\251st\" \"b/t\\303\\251st\"\ndeleted file mode 100644\n--- \"a/t\\303\\251st\"\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
        let files = parse_diff(out);
        let j: Vec<Value> = files.iter().map(DiffFile::to_json).collect();
        assert_eq!(
            j[0],
            json!({"path":"x.txt","status":"M","additions":1,"deletions":1,"binary":false,"tooLarge":false,"hunks":[{"header":"@@ -1,2 +1,2 @@","lines":[{"type":"ctx","text":"a","old":1,"new":1},{"type":"del","text":"b","old":2,"new":null},{"type":"add","text":"c","old":null,"new":2}]}]})
        );
        assert_eq!(files[1].status, 'A');
        assert_eq!(files[1].path, "new.txt");
        assert_eq!((files[2].status, files[2].path.as_str(), files[2].old_path.as_deref()), ('R', "new name.txt", Some("old name.txt")));
        assert!(files[3].binary);
        assert_eq!((files[4].status, files[4].path.as_str(), files[4].deletions), ('D', "tést", 1));
    }

    #[test]
    fn a_long_file_is_listed_without_content() {
        let mut out = String::from("diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,3001 @@\n");
        for i in 0..3001 {
            out.push_str(&format!("+{i}\n"));
        }
        let f = &parse_diff(&out)[0];
        assert!(f.too_large);
        assert!(f.hunks.is_empty());
        assert_eq!(f.additions, 3001);
    }

    #[test]
    fn helpers() {
        assert_eq!(en_us(1234567), "1,234,567");
        assert_eq!(en_us(12), "12");
        assert_eq!(name_status("M\0a\0R100\0b\0c\0"), vec![vec!["a".to_string()], vec!["b".into(), "c".into()]]);
        assert_eq!(unquote("\"a\\tb\""), "a\tb");
        assert_eq!(moved_line("branch: Created from origin/feature"), Some("origin/feature"));
        assert_eq!(moved_line("rebase (start): checkout main"), Some("main"));
        assert!(not_a_name("HEAD~1") && not_a_name("abcdef1") && !not_a_name("feature/x"));
    }

    #[tokio::test]
    async fn ticket_and_folder_diffs() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "repo").await;
        let wt = t.path().join("wt");
        sh(&repo, &["worktree", "add", "-q", "-b", "ck/t1", &wt.to_string_lossy(), "main"]).await;
        fs::write(wt.join("README.md"), "hello\nmore\n").unwrap();
        sh(&wt, &["commit", "-qam", "more"]).await;
        fs::write(wt.join("untracked.txt"), "u\n").unwrap();
        let d = ticket_diff(&wt, "main", false, None).await.unwrap();
        assert_eq!(d.base, "main");
        assert_eq!(d.branch.as_deref(), Some("ck/t1"));
        let paths: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["README.md", "untracked.txt"]);
        assert_eq!((d.additions, d.deletions), (2, 0));
        // The real index is untouched: untracked.txt is still untracked.
        assert_eq!(sh(&wt, &["status", "--porcelain"]).await, "?? untracked.txt");
        let j = d.to_json();
        assert_eq!(j.as_object().unwrap().keys().collect::<Vec<_>>(), ["base", "mergeBase", "branch", "files", "additions", "deletions"]);

        // Moved onto another branch: compared with it, named as startedFrom.
        sh(&repo, &["branch", "feature", "main"]).await;
        let fw = t.path().join("fw");
        sh(&repo, &["worktree", "add", "-q", "-b", "ck/t2", &fw.to_string_lossy(), "main"]).await;
        sh(&fw, &["checkout", "-q", "feature"]).await;
        fs::write(fw.join("f.txt"), "f\n").unwrap();
        sh(&fw, &["add", "."]).await;
        sh(&fw, &["commit", "-qm", "f"]).await;
        sh(&fw, &["checkout", "-q", "-B", "ck/t2", "feature"]).await;
        sh(&fw, &["reset", "-q", "--hard", "HEAD"]).await;
        let d2 = ticket_diff(&fw, "main", false, None).await.unwrap();
        assert_eq!(d2.started_from.as_deref(), Some("feature"));
        assert!(d2.files.is_empty());

        // The folder since a commit; a commit that is no longer an ancestor gives the note.
        let head = sh(&repo, &["rev-parse", "HEAD"]).await;
        fs::write(repo.join("README.md"), "changed\n").unwrap();
        let f = folder_diff(&repo, &head, false).await.unwrap();
        assert_eq!(f.base, &head[..7]);
        assert_eq!(f.files.len(), 1);
        sh(&repo, &["checkout", "-q", "--", "README.md"]).await;
        let gone = folder_diff(&repo, "0000000000000000000000000000000000000000", false).await.unwrap();
        assert_eq!(gone.note.as_deref(), Some(REWRITTEN_NOTE));
        assert_eq!(ticket_diff(&t.path().join("none"), "main", false, None).await.unwrap_err().status, 404);
    }
}
