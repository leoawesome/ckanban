//! "Report bug" (P2): `src/integrations/bugreport.ts` and the `bug-report` routes of `src/api/system.ts`. A user's (or
//! Claude's) report plus some board context becomes a GitHub issue on the ckanban repo with `gh issue create`, or a
//! prefilled "new issue" address when gh can't do it.
//!
//! - `POST /api/bug-report/draft {profile?, ticketId?}`: the context blocks (version and system; with a ticket its
//!   details and the tail of its last run's log) and the ticket's screenshots, all scrubbed;
//! - `POST /api/bug-report {title, description, include?, source?, profile?, ticketId?}`: the issue, 201 with its
//!   address, 200 with an error and the fallback address when gh failed.
//!
//! Scrubbing hides the data folder, the home folder, tokens and secret-looking values (`maskSecrets`); the router also
//! masks the saved keys in the answer. The run log is read page by page from the end (at most 8 pages of 512 KB), off
//! the runtime, decompressing a compressed log first.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ckanban_core::DataDir;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::{Answer, Call};
use crate::mask::mask_secrets;

pub const BUG_REPO: &str = "leoawesome/ckanban";
pub const LOG_MAX_LINES: usize = 50;
pub const LOG_MAX_BYTES: usize = 4096;
/// GitHub rejects very long new-issue addresses (and browsers cut them); stay well under.
pub const MAX_URL_LENGTH: usize = 8000;
/// Pages of the log (512 KB each) read at most for a report.
const REPORT_LOG_PAGES: usize = 8;

/// `ATTACHMENT_NAME_SRC`'s extensions (`src/board/attachments.ts`: images, documents, text and code).
const EXTS: &str = "png|jpg|gif|webp|pdf|docx|xlsx|pptx|txt|md|csv|tsv|json|js|jsx|ts|tsx|py|rb|go|java|c|h|cpp|cs|php|swift|kt|rs|html|css|yaml|yml|xml|toml|ini|log|sql|sh";

static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})(?-u:\b)").unwrap()
});
static ATTACHMENT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\S*?attachments/([0-9a-f]{32}\.(?:png|jpg|gif|webp))(?-u:\b)").unwrap());
static IMAGE_MD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!\[[^\]]*\]\(\s*<?\S*?attachments/([0-9a-f]{32}\.(?:png|jpg|gif|webp))>?\s*\)").unwrap());
static FILE_MD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\[[^\]]*\]\(\s*<?\S*?attachments/([0-9a-f]{{32}}\.(?:{EXTS}))(?-u:\b)>?\s*\)")).unwrap());
static FILE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\S*?attachments/([0-9a-f]{{32}}\.(?:{EXTS}))(?-u:\b)")).unwrap());

/// `scrub`: hides the data folder, the home folder and anything that looks like a secret or token.
pub fn scrub(text: &str, data_root: Option<&str>, home: &str) -> String {
    let mut out = text.to_string();
    if let Some(r) = data_root.filter(|r| !r.is_empty()) {
        out = out.replace(r, "<ckanban data>");
    }
    if !home.is_empty() && home != "/" {
        out = out.replace(home, "~");
    }
    mask_secrets(&TOKEN_RE.replace_all(&out, "***"))
}

/// `screenshotNames`: screenshot file names referenced in the texts, first seen first.
pub fn screenshot_names<'a>(texts: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in texts {
        for c in ATTACHMENT_RE.captures_iter(t) {
            if !out.iter().any(|x| x == &c[1]) {
                out.push(c[1].to_string());
            }
        }
    }
    out
}

/// `stripScreenshots`: local image and file references become a placeholder, since GitHub can't load them.
pub fn strip_screenshots(text: &str) -> String {
    let t = IMAGE_MD_RE.replace_all(text, "_[screenshot not uploaded]_");
    let t = ATTACHMENT_RE.replace_all(&t, "_[screenshot not uploaded]_");
    let t = FILE_MD_RE.replace_all(&t, "_[attached file not uploaded]_");
    FILE_RE.replace_all(&t, "_[attached file not uploaded]_").into_owned()
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.slice(0, n)` on UTF-16 units (a cut surrogate pair becomes U+FFFD, as it would once encoded).
fn head16(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

/// JS `s.slice(-n)` on UTF-16 units.
fn tail16(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    String::from_utf16_lossy(&u[u.len().saturating_sub(n)..])
}

/// `tail`: the last `max_lines` lines, and at most `max_bytes` of them.
pub fn tail(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = lines[lines.len().saturating_sub(max_lines)..].join("\n");
    while out.len() > max_bytes && out.contains('\n') {
        let i = out.find('\n').unwrap_or(0);
        out = out[i + 1..].to_string();
    }
    if out.len() > max_bytes {
        out = tail16(&out, max_bytes);
    }
    out
}

/// `clip`.
fn clip(text: &str, max: usize) -> String {
    let t = crate::js::trim(text);
    if utf16_len(t) > max { format!("{}\n…(cut)", head16(t, max)) } else { t.to_string() }
}

/// One piece of context the user sees and can leave out.
fn block(id: &str, label: &str, text: String) -> Value {
    json!({ "id": id, "label": label, "text": text })
}

/// `envBlock`.
pub fn env_block(bun_version: Option<&str>) -> Value {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        o => o,
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        a => a,
    };
    let mut lines = vec![format!("- ckanban: {}", ckanban_board::gate::update::VERSION), format!("- OS: {os} {} ({arch})", os_release())];
    if let Some(v) = bun_version {
        lines.push(format!("- Bun: {v}"));
    }
    block("env", "Version and system", lines.join("\n"))
}

/// `os.release()`: the kernel's release (`uname -r`).
fn os_release() -> String {
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut u) } != 0 {
        return String::new();
    }
    let r: Vec<u8> = u.release.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8_lossy(&r).into_owned()
}

/// `${v}` in a JS template: `undefined` when missing.
fn tpl(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => ckanban_board::runs::js::to_string(v),
    }
}

/// A run log entry's `run` (None: undefined).
fn run_of(e: &Value) -> Option<&Value> {
    e.get("run")
}

/// `lastRun`: the events of the log's last run.
fn last_run(activity: &[Value]) -> Vec<&Value> {
    let Some(run) = activity.last().and_then(run_of) else { return Vec::new() };
    activity.iter().filter(|e| run_of(e) == Some(run)).collect()
}

/// `ticketBlock`.
pub fn ticket_block(profile: &Value, t: &Value, activity: &[Value]) -> Value {
    let truthy = |k: &str| crate::js::truthy(t.get(k));
    let mut lines = vec![
        format!("- Ticket: {} — {}", tpl(t.get("id")), tpl(t.get("title"))),
        format!("- Board: {}", tpl(profile.get("name"))),
        format!(
            "- Column: {}{}, mode: {}, runs: {}",
            tpl(t.get("status")),
            if truthy("outcome") { format!(" (last run: {})", tpl(t.get("outcome"))) } else { String::new() },
            match t.get("mode") {
                None | Some(Value::Null) => "auto".to_string(),
                v => tpl(v),
            },
            tpl(t.get("runCount")),
        ),
    ];
    if truthy("prUrl") {
        lines.push(format!("- PR: {}", tpl(t.get("prUrl"))));
    }
    if truthy("error") {
        lines.push(format!("- Error: {}", clip(&tpl(t.get("error")), 1500)));
    }
    let events: Vec<Value> = last_run(activity).into_iter().map(|e| e.get("event").cloned().unwrap_or(Value::Null)).collect();
    let result = ckanban_board::runs::activity::extract_final_text(&events);
    let body = clip(t.get("body").and_then(Value::as_str).unwrap_or(""), 3000);
    let mut parts = vec![lines.join("\n"), format!("**Description**\n\n{}", if body.is_empty() { "(empty)".to_string() } else { body })];
    if !crate::js::trim(&result).is_empty() {
        parts.push(format!("**Last run result**\n\n{}", clip(&result, 1500)));
    }
    block("ticket", "Ticket details", parts.join("\n\n"))
}

/// `logBlock`: the last run's summarized events (time and line), its tail.
pub fn log_block(activity: &[Value]) -> Option<Value> {
    let lines: Vec<String> = last_run(activity)
        .into_iter()
        .filter_map(|e| {
            let s = ckanban_board::runs::activity::summarize_event(e.get("event").unwrap_or(&Value::Null), true)?;
            if s.is_empty() {
                return None;
            }
            let at = e.get("at").and_then(Value::as_str).unwrap_or("");
            let u: Vec<u16> = at.encode_utf16().collect();
            let hms = String::from_utf16_lossy(&u[11.min(u.len())..19.min(u.len())]);
            Some(format!("{hms} {s}"))
        })
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(block("log", "Last run log (tail)", tail(&lines.join("\n"), LOG_MAX_LINES, LOG_MAX_BYTES)))
}

/// `lastRunTail`: the log's entries from the end back to the start of its last run, page by page (blocking).
fn last_run_tail(file: &Path) -> Vec<Value> {
    use ckanban_board::runs::run_log;
    let Some(log) = run_log::open_log(file) else { return Vec::new() };
    let mut entries: Vec<Value> = Vec::new();
    let mut before: Option<u64> = None;
    for _ in 0..REPORT_LOG_PAGES {
        let Ok(page) = ckanban_core::jsonl::read_page(&log, before, None) else { break };
        let first = page.entries.first().cloned();
        let mut next = page.entries;
        next.append(&mut entries);
        entries = next;
        let ended = match &first {
            Some(f) => run_of(f) != entries.last().and_then(run_of),
            None => false,
        };
        if page.before.is_none() || ended {
            break;
        }
        before = page.before;
    }
    entries
}

fn read_json(file: &Path) -> Option<Value> {
    ckanban_board::runs::js::parse(&std::fs::read_to_string(file).ok()?)
}

/// A board or ticket name as part of a path: one plain name, never a way out of the data folder.
fn plain_name(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains('/') && !s.contains('\0')
}

/// The source of a report: who sent it.
fn from_of(source: &str) -> &'static str {
    match source {
        "ai" => "Claude, on the user's request",
        "cli" => "the ckanban CLI",
        _ => "the board",
    }
}

/// `buildIssueBody`: the user's text, then the context blocks they kept, scrubbed; and the screenshots referenced.
pub fn build_issue_body(description: &str, blocks: &[Value], include: Option<&[String]>, source: &str, data_root: Option<&str>, home: &str) -> (String, Vec<String>) {
    let kept: Vec<&Value> = blocks.iter().filter(|b| include.is_none_or(|k| k.iter().any(|x| Some(x.as_str()) == b.get("id").and_then(Value::as_str)))).collect();
    let text_of = |b: &Value| b.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    let description = match crate::js::trim(description) {
        "" => "(no description)".to_string(),
        d => d.to_string(),
    };
    let texts: Vec<String> = kept.iter().map(|b| text_of(b)).collect();
    let screenshots = screenshot_names(std::iter::once(description.as_str()).chain(texts.iter().map(String::as_str)));
    let mut parts = vec![strip_screenshots(&description)];
    if !screenshots.is_empty() {
        let n = screenshots.len();
        parts.push(format!("> {n} screenshot{} not uploaded, see comments.", if n == 1 { "" } else { "s" }));
    }
    for b in &kept {
        let text = strip_screenshots(&text_of(b));
        let label = b.get("label").and_then(Value::as_str).unwrap_or("");
        if b.get("id").and_then(Value::as_str) == Some("log") {
            parts.push(format!("<details><summary>{label}</summary>\n\n```text\n{}\n```\n\n</details>", text.replace("```", "ˋˋˋ")));
        } else {
            parts.push(format!("### {label}\n\n{text}"));
        }
    }
    parts.push(format!("<sub>Reported from {} (ckanban {}).</sub>", from_of(source), ckanban_board::gate::update::VERSION));
    (scrub(&parts.join("\n\n"), data_root, home), screenshots)
}

/// `URLSearchParams` serializing (application/x-www-form-urlencoded): spaces as `+`.
fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `newIssueUrl`: the prefilled new-issue page; the body is cut to keep the address under `max` characters.
pub fn new_issue_url(title: &str, body: &str, labels: &[&str], max: usize) -> String {
    let make = |b: &str| {
        let mut q = format!("title={}&body={}", form_encode(title), form_encode(b));
        if !labels.is_empty() {
            q.push_str(&format!("&labels={}", form_encode(&labels.join(","))));
        }
        format!("https://github.com/{BUG_REPO}/issues/new?{q}")
    };
    let url = make(body);
    if url.len() <= max {
        return url;
    }
    let note = "\n\n…(cut to fit the link; add more details here)";
    let units: Vec<u16> = body.encode_utf16().collect();
    let cut = |n: usize| String::from_utf16_lossy(&units[..n]);
    let (mut lo, mut hi) = (0usize, units.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if make(&(cut(mid) + note)).len() <= max {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let url = make(&(cut(lo) + note));
    if url.len() <= max { url } else { make("")[..max.min(make("").len())].to_string() }
}

/// What `gh` printed.
#[derive(Debug, Clone, PartialEq)]
pub struct GhOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `gh <args>`: the real one, or a stand-in in tests.
pub type GhRunner = Arc<dyn Fn(Vec<String>) -> futures_util::future::BoxFuture<'static, GhOut> + Send + Sync>;

/// `run(["gh", ...args], process.cwd())` of `src/runs/git.ts`: a command that can't start is code -1 with the reason.
pub fn default_gh() -> GhRunner {
    Arc::new(|args: Vec<String>| {
        Box::pin(async move {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
            let out = tokio::process::Command::new("gh").args(&args).current_dir(cwd).stdin(std::process::Stdio::null()).output().await;
            match out {
                Ok(o) => GhOut { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned(), stderr: String::from_utf8_lossy(&o.stderr).into_owned() },
                Err(e) => GhOut { code: -1, stdout: String::new(), stderr: if e.kind() == std::io::ErrorKind::NotFound { "Executable not found in $PATH: \"gh\"".into() } else { e.to_string() } },
            }
        })
    })
}

static NOT_INSTALLED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)ENOENT|not found|No such file|Executable not found").unwrap());
static NOT_LOGGED_IN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)auth login|not logged|authentication|HTTP 401").unwrap());
static ISSUE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https://github\.com/\S+/issues/\d+").unwrap());

/// `ghError`.
fn gh_error(r: &GhOut) -> String {
    let said = [crate::js::trim(&r.stderr), crate::js::trim(&r.stdout)].into_iter().find(|s| !s.is_empty()).unwrap_or("");
    let lines: Vec<&str> = said.split('\n').collect();
    let text = lines[lines.len().saturating_sub(3)..].join(" ");
    if r.code == -1 && NOT_INSTALLED.is_match(&text) {
        return "GitHub CLI (gh) is not installed. Install it with `brew install gh`, then run `gh auth login`.".into();
    }
    if NOT_LOGGED_IN.is_match(&text) {
        return "GitHub CLI (gh) is not logged in. Run `gh auth login` in a terminal.".into();
    }
    let masked = mask_secrets(&text);
    format!("gh issue create failed: {}", if masked.is_empty() { format!("exit code {}", r.code) } else { masked })
}

/// `fileIssue`: creates the issue with gh (again without labels when a label was the problem). Gives (url, error,
/// fallbackUrl).
pub async fn file_issue(title: &str, body: &str, labels: &[&str], gh: &GhRunner) -> (Option<String>, Option<String>, String) {
    let bug: Vec<&str> = labels.iter().copied().filter(|l| *l == "bug").collect();
    let fallback = new_issue_url(title, body, &bug, MAX_URL_LENGTH);
    let create = |ls: &[&str]| {
        let mut a: Vec<String> = ["issue", "create", "--repo", BUG_REPO, "--title", title, "--body", body].iter().map(|s| s.to_string()).collect();
        for l in ls {
            a.push("--label".into());
            a.push(l.to_string());
        }
        gh(a)
    };
    let mut r = create(labels).await;
    if r.code != 0 && !labels.is_empty() && Regex::new("(?i)label").unwrap().is_match(&format!("{}{}", r.stderr, r.stdout)) {
        r = create(&[]).await;
    }
    if r.code != 0 {
        return (None, Some(gh_error(&r)), fallback);
    }
    let url = ISSUE_URL.find(&r.stdout).map(|m| m.as_str().to_string()).or_else(|| crate::js::trim(&r.stdout).split('\n').next_back().map(str::to_string));
    (url.filter(|u| !u.is_empty()), None, fallback)
}

pub struct BugReports {
    root: PathBuf,
    home: String,
    bun_version: Option<String>,
    gh: GhRunner,
}

impl BugReports {
    pub fn new(root: PathBuf, bun_version: Option<String>) -> Arc<BugReports> {
        Self::with(root, bun_version, ckanban_core::home::home_dir().to_string_lossy().into_owned(), default_gh())
    }

    pub fn with(root: PathBuf, bun_version: Option<String>, home: String, gh: GhRunner) -> Arc<BugReports> {
        Arc::new(BugReports { root, home, bun_version, gh })
    }

    fn data_root(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    /// `draftReport` (blocking: reads the ticket, its comments and its log's tail). Err: 404 for a missing board or ticket.
    pub fn draft(&self, r#ref: Option<(&str, &str)>) -> Result<Value, Answer> {
        let mut blocks = vec![env_block(self.bun_version.as_deref())];
        let mut shots: Vec<String> = Vec::new();
        if let Some((slug, id)) = r#ref {
            let d = DataDir::new(&self.root);
            let profile = plain_name(slug).then(|| read_json(&d.profile_file(slug))).flatten();
            let Some(profile) = profile else { return Err(Answer::error(404, format!("board {slug} not found"))) };
            let ticket = if plain_name(id) { ckanban_core::ticket::read(&d.ticket_file(slug, id)).ok().flatten() } else { None };
            let t = match ticket {
                None => return Err(Answer::error(404, format!("ticket {id} not found"))),
                Some(Ok(t)) => t.to_json(),
                Some(Err(e)) => ckanban_core::ticket::Ticket::corrupt(id, &e, &ckanban_core::time::iso(ckanban_core::time::now_ms())).to_json(),
            };
            let activity = last_run_tail(&d.ticket_dir(slug, id).join("activity.jsonl"));
            blocks.push(ticket_block(&profile, &t, &activity));
            if let Some(log) = log_block(&activity) {
                blocks.push(log);
            }
            let comments = ckanban_core::jsonl::read_all(&d.comments(slug, id)).unwrap_or_default();
            let texts: Vec<String> = comments.iter().map(|c| c.get("text").and_then(Value::as_str).unwrap_or("").to_string()).collect();
            let body = t.get("body").and_then(Value::as_str).unwrap_or("").to_string();
            shots = screenshot_names(std::iter::once(body.as_str()).chain(texts.iter().map(String::as_str)));
        }
        let root = self.data_root();
        let blocks: Vec<Value> = blocks
            .into_iter()
            .map(|mut b| {
                let text = scrub(b["text"].as_str().unwrap_or(""), Some(&root), &self.home);
                b["text"] = Value::String(text);
                b
            })
            .collect();
        Ok(json!({ "blocks": blocks, "screenshots": shots.iter().map(|n| format!("/api/attachments/{n}")).collect::<Vec<_>>() }))
    }

    /// `submitReport`: checks the title, builds the body and files the issue.
    pub async fn submit(&self, title: &str, description: &str, blocks: &[Value], include: Option<&[String]>, source: &str) -> Result<Value, Answer> {
        let root = self.data_root();
        let squashed = Regex::new(r"\s+").unwrap().replace_all(crate::js::trim(title), " ").into_owned();
        let title = scrub(&squashed, Some(&root), &self.home);
        if title.is_empty() {
            return Err(Answer::error(400, "title is required"));
        }
        if utf16_len(&title) > 200 {
            return Err(Answer::error(400, "title is too long (200 characters max)"));
        }
        let (body, shots) = build_issue_body(description, blocks, include, source, Some(&root), &self.home);
        let labels: &[&str] = if source == "ai" { &["bug", "from-ai"] } else { &["bug"] };
        let (url, error, fallback) = file_issue(&title, &body, labels, &self.gh).await;
        let mut m = Map::new();
        m.insert("url".into(), url.map(Value::String).unwrap_or(Value::Null));
        m.insert("error".into(), error.map(Value::String).unwrap_or(Value::Null));
        m.insert("fallbackUrl".into(), Value::String(fallback));
        m.insert("screenshots".into(), json!(shots.iter().map(|n| format!("/api/attachments/{n}")).collect::<Vec<_>>()));
        Ok(Value::Object(m))
    }

    /// `POST /api/bug-report` and `POST /api/bug-report/draft` (src/api/system.ts).
    pub async fn answer(self: &Arc<Self>, c: &Call<'_>) -> Option<Answer> {
        if c.parts.first().map(String::as_str) != Some("bug-report") || c.method != "POST" || c.parts.len() > 2 {
            return None;
        }
        let b = match super::body_json(c.body) {
            Ok(b) => b,
            Err(a) => return Some(a),
        };
        let Value::Object(b) = b else { return Some(Answer::error(500, "the report must be a JSON object")) };
        let js = |v: Option<&Value>| match v {
            None | Some(Value::Null) => String::new(),
            Some(v) => ckanban_board::runs::js::to_string(v),
        };
        let r#ref = crate::js::truthy(b.get("ticketId")).then(|| (js(b.get("profile")), js(b.get("ticketId"))));
        let me = self.clone();
        let rr = r#ref.clone();
        let draft = tokio::task::spawn_blocking(move || me.draft(rr.as_ref().map(|(s, i)| (s.as_str(), i.as_str())))).await;
        let draft = match draft {
            Ok(Ok(d)) => d,
            Ok(Err(a)) => return Some(a),
            Err(e) => return Some(Answer::error(500, e.to_string())),
        };
        if c.parts.get(1).map(String::as_str) == Some("draft") {
            return Some(Answer::Json(200, draft));
        }
        if c.parts.len() != 1 {
            return Some(Answer::error(404, "not found"));
        }
        let source = b.get("source").and_then(Value::as_str).filter(|s| *s == "ai" || *s == "cli").unwrap_or("ui");
        let include: Option<Vec<String>> = match b.get("include") {
            Some(Value::Array(a)) => Some(a.iter().map(ckanban_board::runs::js::to_string).collect()),
            _ => None,
        };
        let blocks = draft["blocks"].as_array().cloned().unwrap_or_default();
        Some(match self.submit(&js(b.get("title")), &js(b.get("description")), &blocks, include.as_deref(), source).await {
            Ok(v) => {
                let status = if v["url"].is_string() { 201 } else { 200 };
                Answer::Json(status, v)
            }
            Err(a) => a,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixtures made by Bun's functions (src/integrations/bugreport.ts), `bug-cases.json`.
    #[test]
    fn same_text_as_bun() {
        let v: Value = serde_json::from_str(include_str!("bug-cases.json")).unwrap();
        let home = v["home"].as_str().unwrap();
        for c in v["scrub"].as_array().unwrap() {
            assert_eq!(scrub(c[0].as_str().unwrap(), Some("/data/root"), home), c[1].as_str().unwrap(), "scrub {}", c[0]);
        }
        for c in v["strip"].as_array().unwrap() {
            assert_eq!(strip_screenshots(c[0].as_str().unwrap()), c[1].as_str().unwrap());
            let names: Vec<Value> = screenshot_names([c[0].as_str().unwrap()]).into_iter().map(Value::String).collect();
            assert_eq!(Value::Array(names), c[2]);
        }
        for c in v["tail"].as_array().unwrap() {
            assert_eq!(tail(c[0].as_str().unwrap(), 50, 4096), c[1].as_str().unwrap());
        }
        for c in v["url"].as_array().unwrap() {
            let labels: Vec<&str> = c[2].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
            assert_eq!(new_issue_url(c[0].as_str().unwrap(), c[1].as_str().unwrap(), &labels, c[3].as_u64().unwrap() as usize), c[4].as_str().unwrap());
        }
        for c in v["body"].as_array().unwrap() {
            let include: Option<Vec<String>> = c[2].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect());
            let (body, shots) = build_issue_body(c[0].as_str().unwrap(), c[1].as_array().unwrap(), include.as_deref(), c[3].as_str().unwrap(), Some("/data/root"), home);
            assert_eq!(body, c[4]["body"].as_str().unwrap().replace("ckanban dev)", &format!("ckanban {})", ckanban_board::gate::update::VERSION)));
            assert_eq!(json!(shots), c[4]["screenshots"]);
        }
        for c in v["ticket"].as_array().unwrap() {
            assert_eq!(ticket_block(&c[0], &c[1], c[2].as_array().unwrap()), c[3]);
            assert_eq!(log_block(c[2].as_array().unwrap()).unwrap_or(Value::Null), c[4]);
        }
    }

    fn fake_gh(answers: Vec<GhOut>) -> (GhRunner, Arc<parking_lot::Mutex<Vec<Vec<String>>>>) {
        let calls = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let q = Arc::new(parking_lot::Mutex::new(answers));
        let c = calls.clone();
        let gh: GhRunner = Arc::new(move |args: Vec<String>| {
            c.lock().push(args);
            let out = q.lock().remove(0);
            Box::pin(async move { out })
        });
        (gh, calls)
    }

    fn tmp() -> PathBuf {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).unwrap();
        let d = std::env::temp_dir().join(format!("ck-bug-{}-{}", std::process::id(), u32::from_le_bytes(b)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn the_routes() {
        let root = tmp();
        let d = DataDir::new(&root);
        std::fs::create_dir_all(d.ticket_dir("b", "t_1")).unwrap();
        std::fs::write(d.profile_file("b"), r#"{"name":"Board B","slug":"b"}"#).unwrap();
        std::fs::write(d.ticket_file("b", "t_1"), "---\nid: t_1\ntitle: Broken thing\nstatus: review\nrunCount: 2\n---\nSee /api/attachments/0123456789abcdef0123456789abcdef.png and the key ghp_abcdefghijklmnopqrstuvwxyz0123\n").unwrap();
        let ev = |run: u32, text: &str| json!({"at": "2026-11-17T10:11:12.000Z", "run": run, "event": {"type": "result", "subtype": "success", "result": text}});
        let log: String = [ev(1, "old"), ev(2, "Done it")].iter().map(|e| format!("{e}\n")).collect();
        std::fs::write(d.ticket_dir("b", "t_1").join("activity.jsonl"), log).unwrap();
        let (gh, calls) = fake_gh(vec![
            GhOut { code: 1, stdout: String::new(), stderr: "could not add label: 'from-ai' not found".into() },
            GhOut { code: 0, stdout: "https://github.com/leoawesome/ckanban/issues/12\n".into(), stderr: String::new() },
            GhOut { code: 1, stdout: String::new(), stderr: "To get started with GitHub CLI, please run:  gh auth login".into() },
        ]);
        let r = BugReports::with(root.clone(), Some("1.3.0".into()), "/Users/me".into(), gh);
        let user = |_: &str| Ok(());
        let parts = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let draft_parts = parts(&["bug-report", "draft"]);
        let c = Call { method: "POST", parts: &draft_parts, query: "", body: br#"{"profile":"b","ticketId":"t_1"}"#, local: true, from_run: false, user: &user };
        let Some(Answer::Json(200, v)) = r.answer(&c).await else { panic!() };
        let blocks = v["blocks"].as_array().unwrap();
        assert_eq!(blocks.iter().map(|b| b["id"].as_str().unwrap()).collect::<Vec<_>>(), ["env", "ticket", "log"]);
        assert!(blocks[0]["text"].as_str().unwrap().contains("- Bun: 1.3.0"));
        let t = blocks[1]["text"].as_str().unwrap();
        assert!(t.starts_with("- Ticket: t_1 — Broken thing\n- Board: Board B\n- Column: review, mode: auto, runs: 2"), "{t}");
        assert!(t.contains("**Last run result**\n\nDone it"));
        assert!(t.contains("***") && !t.contains("ghp_"));
        assert_eq!(v["screenshots"], json!(["/api/attachments/0123456789abcdef0123456789abcdef.png"]));
        let c = Call { method: "POST", parts: &draft_parts, query: "", body: br#"{"profile":"nope","ticketId":"t_1"}"#, local: true, from_run: false, user: &user };
        assert_eq!(r.answer(&c).await, Some(Answer::error(404, "board nope not found")));
        let c = Call { method: "POST", parts: &draft_parts, query: "", body: br#"{"profile":"b","ticketId":"t_2"}"#, local: true, from_run: false, user: &user };
        assert_eq!(r.answer(&c).await, Some(Answer::error(404, "ticket t_2 not found")));
        let submit = parts(&["bug-report"]);
        let c = Call { method: "POST", parts: &submit, query: "", body: br#"{"title":"  "}"#, local: true, from_run: false, user: &user };
        assert_eq!(r.answer(&c).await, Some(Answer::error(400, "title is required")));
        let c = Call { method: "POST", parts: &submit, query: "", body: br#"{"title":"It  broke","description":"x","profile":"b","ticketId":"t_1","source":"ai","include":["ticket"]}"#, local: true, from_run: false, user: &user };
        let Some(Answer::Json(201, v)) = r.answer(&c).await else { panic!() };
        assert_eq!(v["url"], json!("https://github.com/leoawesome/ckanban/issues/12"));
        assert_eq!(v["error"], Value::Null);
        assert!(v["fallbackUrl"].as_str().unwrap().starts_with("https://github.com/leoawesome/ckanban/issues/new?title=It+broke&body=x"));
        let cs = calls.lock().clone();
        assert_eq!(cs[0][..6], ["issue", "create", "--repo", BUG_REPO, "--title", "It broke"].map(String::from));
        assert!(cs[0].ends_with(&["--label".into(), "bug".into(), "--label".into(), "from-ai".into()]));
        assert!(!cs[1].contains(&"--label".to_string()));
        assert!(!cs[0][7].contains("Last run log"));
        let c = Call { method: "POST", parts: &submit, query: "", body: br#"{"title":"Again"}"#, local: true, from_run: false, user: &user };
        let Some(Answer::Json(200, v)) = r.answer(&c).await else { panic!() };
        assert_eq!(v["error"], json!("GitHub CLI (gh) is not logged in. Run `gh auth login` in a terminal."));
        assert_eq!(v["url"], Value::Null);
        let other = parts(&["bug-report", "x"]);
        let c = Call { method: "POST", parts: &other, query: "", body: b"{}", local: true, from_run: false, user: &user };
        assert_eq!(r.answer(&c).await, Some(Answer::error(404, "not found")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gh_errors() {
        let e = |code, stderr: &str| gh_error(&GhOut { code, stdout: String::new(), stderr: stderr.into() });
        assert_eq!(e(-1, "Executable not found in $PATH: \"gh\""), "GitHub CLI (gh) is not installed. Install it with `brew install gh`, then run `gh auth login`.");
        assert_eq!(e(1, "HTTP 401: Bad credentials"), "GitHub CLI (gh) is not logged in. Run `gh auth login` in a terminal.");
        assert_eq!(e(4, ""), "gh issue create failed: exit code 4");
        assert_eq!(e(1, "a\nb\nc\nd"), "gh issue create failed: b c d");
    }
}
