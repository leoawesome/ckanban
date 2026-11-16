//! A ticket's pull requests: the list and the main one (`board/prs.ts`), their status from `gh` (`runs/prstatus.ts`)
//! and what the board does with it (`runs/prpoller.ts`: check, refresh, Merge & done, send failures, resolve
//! conflicts, the poller). `gh` runs outside any checkout, so it never touches local branches.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::cmd::run;
use super::ops::{BoardOps, s, set};

// ---- the ticket's PRs (board/prs.ts) ----

/// Merged or closed: the board stops watching it.
pub fn pr_final(state: Option<&str>) -> bool {
    matches!(state, Some("MERGED") | Some("CLOSED"))
}

fn state_of(p: &Value) -> Option<&str> {
    p.get("state").and_then(Value::as_str)
}

/// `ticketPrs`: the ticket's PRs, oldest first; an old ticket's `prUrl` is its only one.
pub fn ticket_prs(t: &Value) -> Vec<Value> {
    if let Some(prs) = t.get("prs").and_then(Value::as_array).filter(|a| !a.is_empty()) {
        return prs.clone();
    }
    let Some(url) = set(t, "prUrl") else { return Vec::new() };
    let cached = t.get("pr").filter(|p| s(p, "url") == Some(url));
    let mut m = Map::new();
    m.insert("url".into(), json!(url));
    m.insert("state".into(), cached.and_then(|c| c.get("state")).cloned().filter(|v| !v.is_null()).unwrap_or(Value::Null));
    if let Some(b) = cached.and_then(|c| set(c, "base")) {
        m.insert("base".into(), json!(b));
    }
    vec![Value::Object(m)]
}

/// `mainPr`: the newest PR not known to be merged or closed, else the newest.
pub fn main_pr(prs: &[Value]) -> Option<String> {
    prs.iter().rev().find(|p| !pr_final(state_of(p))).or_else(|| prs.last()).and_then(|p| s(p, "url")).map(str::to_string)
}

/// `addPrs`: the patch that adds these PRs (new ones at the end, no duplicates); empty when none is new.
pub fn add_prs(t: &Value, urls: &[String]) -> Map<String, Value> {
    let mut prs = ticket_prs(t);
    let mut added = false;
    for u in urls {
        if prs.iter().any(|p| s(p, "url") == Some(u)) {
            continue;
        }
        prs.push(json!({ "url": u, "state": null }));
        added = true;
    }
    if !added {
        return Map::new();
    }
    let main = main_pr(&prs);
    let mut m = Map::new();
    m.insert("prs".into(), Value::Array(prs));
    m.insert("prUrl".into(), json!(main));
    m
}

/// A fetched state (and target branch) of one PR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    pub state: String,
    pub base: Option<String>,
}

/// `updatePrs`: records fetched states (and bases), re-picking the main PR.
pub fn update_prs(t: &Value, seen: &HashMap<String, Seen>) -> Map<String, Value> {
    let prs: Vec<Value> = ticket_prs(t)
        .into_iter()
        .map(|mut p| {
            let Some(sn) = s(&p, "url").and_then(|u| seen.get(u)).cloned() else { return p };
            if let Some(o) = p.as_object_mut() {
                o.insert("state".into(), json!(sn.state));
                if let Some(b) = sn.base.filter(|b| !b.is_empty()) {
                    o.insert("base".into(), json!(b));
                }
            }
            p
        })
        .collect();
    let main = main_pr(&prs);
    let mut m = Map::new();
    m.insert("prs".into(), Value::Array(prs));
    m.insert("prUrl".into(), json!(main));
    m
}

// ---- a PR's status (runs/prstatus.ts) ----

/// Fields of `gh pr view --json` the board reads.
pub const PR_FIELDS: &str = "number,state,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,comments";

const FAILED: [&str; 6] = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const SKIPPED: [&str; 3] = ["SKIPPED", "NEUTRAL", "STALE"];

/// `String(x ?? "")` for the JSON values gh gives.
fn js_str(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(x)) => x.clone(),
        Some(other) => other.to_string(),
    }
}

fn non_empty_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string)
}

/// One entry of statusCheckRollup: a CheckRun or a commit StatusContext.
fn parse_check(c: &Value) -> Value {
    let name = c.get("name").filter(|v| !v.is_null()).or_else(|| c.get("context").filter(|v| !v.is_null()));
    let name = if name.is_some() { js_str(name) } else { "check".into() };
    let url_v = c.get("detailsUrl").filter(|v| !v.is_null()).or_else(|| c.get("targetUrl"));
    let url = non_empty_str(url_v);
    let is_status = s(c, "__typename") == Some("StatusContext")
        || (ckanban_core::jsnum::truthy(c.get("context")) && !ckanban_core::jsnum::truthy(c.get("name")));
    let state = if is_status {
        let st = js_str(c.get("state")).to_uppercase();
        if st == "SUCCESS" {
            "pass"
        } else if FAILED.contains(&st.as_str()) {
            "fail"
        } else {
            "pending"
        }
    } else {
        let conclusion = js_str(c.get("conclusion")).to_uppercase();
        if js_str(c.get("status")).to_uppercase() != "COMPLETED" || conclusion.is_empty() {
            "pending"
        } else if conclusion == "SUCCESS" {
            "pass"
        } else if SKIPPED.contains(&conclusion.as_str()) {
            "skipped"
        } else {
            "fail"
        }
    };
    let completed = c.get("completedAt").filter(|v| ckanban_core::jsnum::truthy(Some(v)));
    let at = match completed {
        Some(v) if !js_str(Some(v)).starts_with("0001") => Some(js_str(Some(v))),
        _ => c.get("startedAt").filter(|v| ckanban_core::jsnum::truthy(Some(v))).map(|v| js_str(Some(v))),
    };
    json!({ "name": name, "state": state, "url": url, "at": at })
}

/// `Number(x) || 0` for what gh gives (a number or a numeric string).
fn js_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(x)) => {
            let t = x.trim();
            if t.is_empty() { Some(0.0) } else { t.parse().ok() }
        }
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Null) => Some(0.0),
        _ => None,
    }
    .filter(|n| n.is_finite() && *n != 0.0)
}

/// `parsePrStatus`: `gh pr view --json PR_FIELDS` output to the status the board caches on the ticket (`pr`).
pub fn parse_pr_status(url: &str, raw: &Value, now: &str) -> Value {
    let checks: Vec<Value> = raw.get("statusCheckRollup").and_then(Value::as_array).map(|a| a.iter().map(parse_check).collect()).unwrap_or_default();
    let state = match s(raw, "state") {
        Some(x @ ("OPEN" | "MERGED" | "CLOSED")) => json!(x),
        _ => Value::Null,
    };
    let mergeable = match s(raw, "mergeable") {
        Some(x @ ("MERGEABLE" | "CONFLICTING")) => x,
        _ => "UNKNOWN",
    };
    let comments = match raw.get("comments") {
        Some(Value::Array(a)) => a.len() as f64,
        other => js_number(other).unwrap_or(0.0),
    };
    let number = js_number(raw.get("number"))
        .or_else(|| js_number(Some(&Value::String(url.rsplit('/').next().unwrap_or("").to_string()))))
        .map(ckanban_core::jsnum::num)
        .unwrap_or(Value::Null);
    let count = |st: &str| checks.iter().filter(|c| c["state"] == st).count();
    let (failing, pending) = (count("fail"), count("pending"));
    json!({
        "url": url,
        "number": number,
        "state": state,
        "checks": checks,
        "failing": failing,
        "pending": pending,
        "mergeable": mergeable,
        "conflicts": mergeable == "CONFLICTING" || s(raw, "mergeStateStatus") == Some("DIRTY"),
        "mergeStateStatus": s(raw, "mergeStateStatus"),
        "base": non_empty_str(raw.get("baseRefName")),
        "reviewDecision": non_empty_str(raw.get("reviewDecision")),
        "comments": ckanban_core::jsnum::num(comments),
        "fetchedAt": now,
    })
}

fn n(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// `mergeBlock`: why Merge & done isn't allowed now, or None.
pub fn merge_block(pr: Option<&Value>) -> Option<String> {
    let Some(pr) = pr.filter(|p| p.is_object()) else { return Some("PR status not loaded yet".into()) };
    match s(pr, "state") {
        Some("OPEN") => {}
        Some("MERGED") => return Some("PR is already merged".into()),
        Some("CLOSED") => return Some("PR is closed".into()),
        _ => return Some("PR state unknown".into()),
    }
    if pr["conflicts"] == true {
        return Some("PR has conflicts with the base branch".into());
    }
    let failing = n(pr, "failing");
    if failing > 0 {
        return Some(format!("{failing} {} failing", if failing == 1 { "check" } else { "checks" }));
    }
    if n(pr, "pending") > 0 {
        return Some("Checks are still running".into());
    }
    if s(pr, "mergeable") != Some("MERGEABLE") {
        return Some("GitHub has not confirmed the PR is mergeable yet".into());
    }
    if s(pr, "reviewDecision") == Some("CHANGES_REQUESTED") {
        return Some("A reviewer requested changes".into());
    }
    None
}

pub const PER_CHECK_LOG: usize = 8_000;
pub const TOTAL_LOG: usize = 20_000;

/// JS string length (UTF-16 code units).
fn js_len(x: &str) -> usize {
    x.encode_utf16().count()
}

/// `s.slice(from)` in UTF-16 units.
fn js_slice_from(x: &str, from: usize) -> String {
    String::from_utf16_lossy(&x.encode_utf16().skip(from).collect::<Vec<u16>>())
}

/// `tail`: the end of a log, at most `max` characters.
pub fn tail(log: &str, max: usize) -> String {
    let t = log.trim_end();
    let len = js_len(t);
    if len <= max {
        return t.to_string();
    }
    format!("… ({} earlier chars cut)\n{}", len - max, js_slice_from(t, len - max))
}

/// A failing check's log for the message.
pub struct CheckLog {
    pub name: String,
    pub log: Option<String>,
    pub url: Option<String>,
}

/// `failureMessage`: what "Send failures to Claude" sends.
pub fn failure_message(pr: &Value, logs: &[CheckLog]) -> String {
    let number = pr.get("number").filter(|v| !v.is_null()).map(|v| v.to_string()).unwrap_or_else(|| "?".into());
    let names: Vec<&str> = logs.iter().map(|l| l.name.as_str()).collect();
    let mut parts = vec![format!("CI failed on PR #{number} ({}): {}.", s(pr, "url").unwrap_or(""), names.join(", "))];
    let mut budget = TOTAL_LOG as i64;
    for l in logs {
        let see = l.url.as_ref().map(|u| format!("; see {u}")).unwrap_or_default();
        let body = match l.log.as_deref().filter(|x| !x.trim().is_empty()) {
            None => format!("(no log available{see})"),
            Some(_) if budget <= 0 => format!("(log left out to keep this message short{see})"),
            Some(log) => {
                let cap = PER_CHECK_LOG.min(budget as usize);
                budget -= js_len(log.trim_end()).min(cap) as i64;
                format!("```\n{}\n```", tail(log, cap))
            }
        };
        parts.push(format!("### {}\n{body}", l.name));
    }
    parts.push("Fix it and push.".into());
    parts.join("\n\n")
}

/// `conflictMessage`: what "Resolve conflicts" sends.
pub fn conflict_message(pr: &Value, base: &str) -> String {
    let number = pr.get("number").filter(|v| !v.is_null()).map(|v| v.to_string()).unwrap_or_else(|| "?".into());
    let b = if base.is_empty() { "the base branch".to_string() } else { base.to_string() };
    let remote = if base.is_empty() { "the remote base branch".to_string() } else { format!("origin/{base}") };
    [
        format!("PR #{number} ({}) has conflicts with {b}. Resolve them:", s(pr, "url").unwrap_or("")),
        format!("1. `git fetch` and rebase this branch onto the remote base branch (`{remote}`)."),
        "2. Resolve every conflict keeping both sides' intent: the base branch's changes and this ticket's.".into(),
        "3. Run the repo's checks (tests, typecheck, build) and fix anything the rebase broke.".into(),
        "4. Push with `git push --force-with-lease` to this ticket's branch only. Never force-push the base branch or any other branch.".into(),
    ]
    .join("\n")
}

/// `actionsIds`: owner/repo, run id and job id from an Actions details URL.
pub fn actions_ids(url: Option<&str>) -> Option<(String, String, Option<String>)> {
    static RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"github\.com/([^/]+/[^/]+)/actions/runs/(\d+)(?:/job/(\d+))?").unwrap());
    let c = RE.captures(url?)?;
    Some((c[1].to_string(), c[2].to_string(), c.get(3).map(|m| m.as_str().to_string())))
}

/// How the board talks to GitHub; tests give their own.
pub trait Gh: Send + Sync {
    fn status(&self, url: &str) -> BoxFuture<'_, Result<Value, String>>;
    fn state(&self, url: &str) -> BoxFuture<'_, Option<String>>;
    fn merge(&self, url: &str) -> BoxFuture<'_, Result<(), String>>;
    fn failed_log(&self, check: &Value) -> BoxFuture<'_, Option<String>>;
}

/// The `gh` command on PATH.
pub struct GhCli;

fn tmp() -> std::path::PathBuf {
    std::env::temp_dir()
}

impl Gh for GhCli {
    fn status(&self, url: &str) -> BoxFuture<'_, Result<Value, String>> {
        let url = url.to_string();
        Box::pin(async move {
            let r = run(&["gh", "pr", "view", &url, "--json", PR_FIELDS], &tmp(), &[], None).await;
            if !r.ok() {
                let e = r.stderr.trim();
                return Err(if e.is_empty() { "gh pr view failed".into() } else { e.to_string() });
            }
            let raw: Value = serde_json::from_str(&r.stdout).map_err(|e| e.to_string())?;
            Ok(parse_pr_status(&url, &raw, &ckanban_core::time::iso(ckanban_core::time::now_ms())))
        })
    }
    fn state(&self, url: &str) -> BoxFuture<'_, Option<String>> {
        let url = url.to_string();
        Box::pin(async move {
            let cwd = std::env::current_dir().unwrap_or_else(|_| tmp());
            let r = run(&["gh", "pr", "view", &url, "--json", "state", "-q", ".state"], &cwd, &[], None).await;
            let st = r.out();
            (r.ok() && matches!(st, "OPEN" | "MERGED" | "CLOSED")).then(|| st.to_string())
        })
    }
    fn merge(&self, url: &str) -> BoxFuture<'_, Result<(), String>> {
        let url = url.to_string();
        Box::pin(async move {
            let r = run(&["gh", "pr", "merge", &url, "--squash", "--delete-branch"], &tmp(), &[], None).await;
            if r.ok() {
                return Ok(());
            }
            let e = if !r.stderr.trim().is_empty() { r.stderr.trim() } else if !r.stdout.trim().is_empty() { r.stdout.trim() } else { "gh pr merge failed" };
            Err(e.to_string())
        })
    }
    fn failed_log(&self, check: &Value) -> BoxFuture<'_, Option<String>> {
        let ids = actions_ids(s(check, "url"));
        Box::pin(async move {
            let (repo, run_id, job) = ids?;
            let mut args = vec!["gh", "run", "view"];
            match &job {
                Some(j) => args.extend(["--job", j.as_str()]),
                None => args.push(run_id.as_str()),
            }
            args.extend(["--log-failed", "-R", repo.as_str()]);
            let r = run(&args, &tmp(), &[], None).await;
            r.ok().then_some(r.stdout)
        })
    }
}

/// `openPrWithGh`: opens a pull request from `branch` into `base`; its URL.
pub async fn open_pr_with_gh(dir: &Path, branch: &str, base: &str, title: &str, body: &str) -> Result<String, String> {
    let r = run(&["gh", "pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body], dir, &[], None).await;
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"https://\S+/pull/\d+").unwrap());
    let url = RE.find(&r.stdout).map(|m| m.as_str().to_string());
    match url {
        Some(u) if r.ok() => Ok(u),
        _ => {
            let text = if r.stderr.is_empty() { &r.stdout } else { &r.stderr };
            let lines: Vec<&str> = text.trim().split('\n').collect();
            let last = lines[lines.len().saturating_sub(2)..].join(" ");
            Err(if last.is_empty() { "gh pr create failed".into() } else { last })
        }
    }
}

// ---- what the board does with it (runs/prpoller.ts) ----

const CLOSED_MSG: &str = "PR closed without merge.";
const MERGED_MSG: &str = "PR merged.";

/// The drawer's refresh reuses a status fetched less than this long ago.
pub const REFRESH_MIN: Duration = Duration::from_secs(30);
/// A closed PR (it can be reopened) is asked about again this often; a merged one never.
pub const CLOSED_RECHECK: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrError {
    pub status: u16,
    pub message: String,
}

fn pr_err(status: u16, message: impl Into<String>) -> PrError {
    PrError { status, message: message.into() }
}

fn has_ai_comment(ops: &dyn BoardOps, slug: &str, id: &str, text: &str) -> bool {
    ops.comments(slug, id).iter().any(|c| s(c, "author") == Some("ai") && s(c, "text") == Some(text))
}

fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    a.unwrap_or(&Value::Null) == b.unwrap_or(&Value::Null)
}

/// `checkPr`: asks for the ticket's PRs still open (and the main one) with `state`, records them, and once every PR is
/// merged or closed: Done when one was merged (unless the card still needs the user), else a "closed" note. The main
/// PR's state.
pub async fn check_pr<F>(ops: &dyn BoardOps, slug: &str, id: &str, state: F) -> Option<String>
where
    F: Fn(String) -> BoxFuture<'static, Option<String>>,
{
    let t = ops.ticket(slug, id)?;
    let pr_url = set(&t, "prUrl")?.to_string();
    if s(&t, "status") != Some("review") {
        return None;
    }
    let before = ticket_prs(&t);
    let mut seen: Vec<(String, Option<String>)> = Vec::new();
    for p in &before {
        let url = s(p, "url").unwrap_or_default().to_string();
        if !pr_final(state_of(p)) || url == pr_url {
            let st = state(url.clone()).await;
            seen.push((url, st));
        }
    }
    let main_state = seen.iter().find(|(u, _)| *u == pr_url).and_then(|(_, st)| st.clone());
    // The user may have moved the card while gh was in flight.
    let now = ops.ticket(slug, id)?;
    if s(&now, "status") != Some("review") || s(&now, "prUrl") != Some(pr_url.as_str()) {
        return main_state;
    }
    let known: HashMap<String, Seen> =
        seen.iter().filter_map(|(u, st)| st.as_ref().map(|st| (u.clone(), Seen { state: st.clone(), base: None }))).collect();
    let next = update_prs(&now, &known);
    let had_prs = now.get("prs").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    if (before.len() > 1 || had_prs) && (!same(next.get("prs"), now.get("prs")) || !same(next.get("prUrl"), now.get("prUrl"))) {
        let _ = ops.patch(slug, id, next.clone());
    }
    let prs = next.get("prs").and_then(Value::as_array).cloned().unwrap_or_default();
    if prs.iter().all(|p| pr_final(state_of(p))) {
        if prs.iter().any(|p| state_of(p) == Some("MERGED")) {
            // The poller sees the merge on every tick while the card waits; say it once.
            if !has_ai_comment(ops, slug, id, MERGED_MSG) {
                ops.add_comment(slug, id, "ai", MERGED_MSG);
            }
            if !ops.holds_review(slug, id) {
                let _ = ops.move_to(slug, id, "done").await;
            }
        } else {
            let last = ops.comments(slug, id).into_iter().filter(|c| s(c, "author") == Some("ai")).next_back();
            if last.as_ref().and_then(|c| s(c, "text")) != Some(CLOSED_MSG) {
                ops.add_comment(slug, id, "ai", CLOSED_MSG);
            }
        }
    }
    main_state
}

/// `checkPr` with gh's answer for each PR.
pub async fn check_pr_gh(ops: &dyn BoardOps, gh: Arc<dyn Gh>, slug: &str, id: &str) -> Option<String> {
    check_pr(ops, slug, id, move |url| {
        let gh = gh.clone();
        Box::pin(async move { gh.state(&url).await })
    })
    .await
}

fn fetched_ms(pr: &Value) -> Option<f64> {
    ckanban_core::time::parse_date(s(pr, "fetchedAt")?)
}

/// `refreshPr`: fetches the main PR's checks, conflicts and reviews (kept as `pr` on the ticket), the other open PRs'
/// states, then applies merged and closed like `check_pr`. `max_age`: keep a cached status this fresh.
pub async fn refresh_pr(ops: &dyn BoardOps, gh: Arc<dyn Gh>, slug: &str, id: &str, max_age: Option<Duration>) -> Result<Option<Value>, String> {
    let Some(t) = ops.ticket(slug, id) else { return Ok(None) };
    let Some(pr_url) = set(&t, "prUrl").map(str::to_string) else { return Ok(None) };
    if s(&t, "status") != Some("review") {
        return Ok(None);
    }
    let cached = t.get("pr").filter(|p| s(p, "url") == Some(pr_url.as_str()));
    if let (Some(c), Some(age)) = (cached, max_age.filter(|a| !a.is_zero())) {
        if fetched_ms(c).is_some_and(|at| ckanban_core::time::now_ms() - at < age.as_millis() as f64) {
            return Ok(Some(c.clone()));
        }
    }
    let pr = gh.status(&pr_url).await?;
    let Some(now) = ops.ticket(slug, id) else { return Ok(Some(pr)) };
    if s(&now, "prUrl") != Some(pr_url.as_str()) {
        return Ok(Some(pr));
    }
    let _ = ops.patch(slug, id, super::ops::patch1("pr", pr.clone()));
    // The other open PRs: their state and target branch (a failed fetch leaves the PR as it was).
    let mut others: HashMap<String, Value> = HashMap::new();
    for p in ticket_prs(&now) {
        let url = s(&p, "url").unwrap_or_default().to_string();
        if url == pr_url || pr_final(state_of(&p)) {
            continue;
        }
        if let Ok(st) = gh.status(&url).await {
            others.insert(url, st);
        }
    }
    if let Some(fresh) = ops.ticket(slug, id) {
        if fresh.get("prs").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            let mut seen = HashMap::new();
            for (url, st) in std::iter::once((&pr_url, &pr)).chain(others.iter()) {
                if let Some(state) = s(st, "state") {
                    seen.insert(url.clone(), Seen { state: state.to_string(), base: s(st, "base").map(str::to_string) });
                }
            }
            let _ = ops.patch(slug, id, update_prs(&fresh, &seen));
        }
    }
    let main_state = s(&pr, "state").map(str::to_string);
    let other_states: HashMap<String, Option<String>> = others.iter().map(|(u, v)| (u.clone(), s(v, "state").map(str::to_string))).collect();
    let main_url = pr_url.clone();
    check_pr(ops, slug, id, move |url| {
        let st = if url == main_url { main_state.clone() } else { other_states.get(&url).cloned().flatten() };
        Box::pin(async move { st })
    })
    .await;
    Ok(Some(pr))
}

fn review_pr(ops: &dyn BoardOps, slug: &str, id: &str) -> Result<(Value, String), PrError> {
    let t = ops.ticket(slug, id).ok_or_else(|| pr_err(404, format!("ticket {id} not found")))?;
    let url = set(&t, "prUrl").ok_or_else(|| pr_err(400, "this ticket has no pull request"))?.to_string();
    if s(&t, "status") != Some("review") {
        return Err(pr_err(409, "the ticket is no longer in Review"));
    }
    Ok((t, url))
}

async fn read_pr(gh: &dyn Gh, url: &str) -> Result<Value, PrError> {
    gh.status(url).await.map_err(|e| pr_err(502, format!("Could not read the PR: {e}")))
}

/// `mergePr` (Merge & done): re-checks the PR fresh, squash-merges it and deletes its branch (never `--admin`), then
/// Done (or, with more PRs, the next open one becomes the main PR). Any failure leaves the ticket as it was.
pub async fn merge_pr(ops: &dyn BoardOps, gh: &dyn Gh, slug: &str, id: &str) -> Result<Value, PrError> {
    let (_, url) = review_pr(ops, slug, id)?;
    let pr = read_pr(gh, &url).await?;
    if ops.ticket(slug, id).as_ref().and_then(|t| s(t, "prUrl")) == Some(url.as_str()) {
        let _ = ops.patch(slug, id, super::ops::patch1("pr", pr.clone()));
    }
    if let Some(why) = merge_block(Some(&pr)) {
        return Err(pr_err(409, format!("Not merged: {why}.")));
    }
    gh.merge(&url).await.map_err(|e| pr_err(502, e))?;
    let mut merged = pr.clone();
    merged["state"] = json!("MERGED");
    merged["fetchedAt"] = json!(ckanban_core::time::iso(ckanban_core::time::now_ms()));
    let _ = ops.patch(slug, id, super::ops::patch1("pr", merged));
    let after = ops.ticket(slug, id).ok_or_else(|| pr_err(404, format!("ticket {id} not found")))?;
    let mut seen = HashMap::new();
    seen.insert(url.clone(), Seen { state: "MERGED".into(), base: None });
    let next = update_prs(&after, &seen);
    if after.get("prs").and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
        let _ = ops.patch(slug, id, next.clone());
    }
    let open = next.get("prs").and_then(Value::as_array).is_some_and(|a| a.iter().any(|p| !pr_final(state_of(p))));
    if !open {
        if !has_ai_comment(ops, slug, id, MERGED_MSG) {
            ops.add_comment(slug, id, "ai", MERGED_MSG);
        }
        if ops.ticket(slug, id).as_ref().and_then(|t| s(t, "status")) == Some("review") {
            ops.move_to(slug, id, "done").await.map_err(|e| pr_err(502, e))?;
        }
    }
    ops.ticket(slug, id).ok_or_else(|| pr_err(404, format!("ticket {id} not found")))
}

/// `sendFailures`: the failing checks and the end of their logs, as a chat message to the ticket.
pub async fn send_failures(ops: &dyn BoardOps, gh: &dyn Gh, slug: &str, id: &str) -> Result<Value, PrError> {
    let (_, url) = review_pr(ops, slug, id)?;
    let pr = read_pr(gh, &url).await?;
    let _ = ops.patch(slug, id, super::ops::patch1("pr", pr.clone()));
    let failing: Vec<Value> = pr["checks"].as_array().cloned().unwrap_or_default().into_iter().filter(|c| c["state"] == "fail").collect();
    if failing.is_empty() {
        return Err(pr_err(409, "No checks are failing on this PR any more."));
    }
    let logs = futures_util::future::join_all(failing.iter().map(|c| async move {
        CheckLog { name: s(c, "name").unwrap_or_default().to_string(), url: s(c, "url").map(str::to_string), log: gh.failed_log(c).await }
    }))
    .await;
    ops.chat(slug, id, &failure_message(&pr, &logs)).await.map_err(|e| pr_err(502, e))
}

/// `resolveConflicts`: re-checks the PR, then asks the ticket's Claude to rebase onto the base branch and push.
pub async fn resolve_conflicts(ops: &dyn BoardOps, gh: &dyn Gh, slug: &str, id: &str) -> Result<Value, PrError> {
    let (_, url) = review_pr(ops, slug, id)?;
    if ops.is_running(slug, id) {
        return Err(pr_err(409, "Claude is already working on this ticket."));
    }
    let pr = read_pr(gh, &url).await?;
    let _ = ops.patch(slug, id, super::ops::patch1("pr", pr.clone()));
    if s(&pr, "state") != Some("OPEN") {
        return Err(pr_err(409, "The PR is no longer open."));
    }
    if pr["conflicts"] != true {
        return Err(pr_err(409, "The PR has no conflicts any more."));
    }
    let base = ops.profile(slug).and_then(|p| s(&p, "baseBranch").map(str::to_string)).unwrap_or_default();
    ops.chat(slug, id, &conflict_message(&pr, &base)).await.map_err(|e| pr_err(502, e))
}

/// One tick of the poller (`startPoller`'s `tick`): every Review ticket with a PR, newest in Review first. Tickets whose
/// PRs are all merged or closed get only the local step (a closed one is asked about again after `CLOSED_RECHECK`).
/// `closed_at`: when each ticket's closed PRs were last asked about, by "slug/id" (kept between ticks).
pub async fn poll_once(ops: &dyn BoardOps, gh: Arc<dyn Gh>, closed_at: &mut HashMap<String, f64>, now_ms: f64) {
    let mut due: Vec<(String, Value)> = Vec::new();
    for p in ops.profiles() {
        let Some(slug) = s(&p, "slug").map(str::to_string) else { continue };
        for t in ops.tickets(&slug) {
            if s(&t, "status") == Some("review") && set(&t, "prUrl").is_some() {
                due.push((slug.clone(), t));
            }
        }
    }
    // Stable, like Array.prototype.sort.
    due.sort_by(|a, b| s(&b.1, "statusAt").unwrap_or("").cmp(s(&a.1, "statusAt").unwrap_or("")));
    let mut keys = std::collections::HashSet::new();
    for (slug, t) in due {
        let id = s(&t, "id").unwrap_or_default().to_string();
        let key = format!("{slug}/{id}");
        keys.insert(key.clone());
        let prs = ticket_prs(&t);
        let fin = !prs.is_empty() && prs.iter().all(|p| pr_final(state_of(p)));
        let reopenable = prs.iter().any(|p| state_of(p) == Some("CLOSED"));
        if fin && !(reopenable && now_ms - closed_at.get(&key).copied().unwrap_or(0.0) >= CLOSED_RECHECK.as_millis() as f64) {
            let known: HashMap<String, Option<String>> =
                prs.iter().map(|p| (s(p, "url").unwrap_or_default().to_string(), state_of(p).map(str::to_string))).collect();
            check_pr(ops, &slug, &id, move |url| {
                let st = known.get(&url).cloned().flatten();
                Box::pin(async move { st })
            })
            .await;
            continue;
        }
        if fin {
            closed_at.insert(key, now_ms);
        }
        let _ = refresh_pr(ops, gh.clone(), &slug, &id, None).await;
    }
    closed_at.retain(|k, _| keys.contains(k));
}

/// `startPoller`: a tick now, then one every `minutes` (at least 1) until the returned handle is aborted. A tick that
/// is still going when the next is due is skipped.
pub fn start_poller(ops: Arc<dyn BoardOps>, gh: Arc<dyn Gh>, minutes: u64) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut closed_at = HashMap::new();
        let mut every = tokio::time::interval(Duration::from_secs(minutes.max(1) * 60));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            every.tick().await;
            poll_once(&*ops, gh.clone(), &mut closed_at, ckanban_core::time::now_ms()).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::super::ops::mem::MemBoard;
    use super::*;
    use parking_lot::Mutex;

    #[test]
    fn prs_list_and_main() {
        let old = json!({ "prUrl": "u1", "pr": { "url": "u1", "state": "OPEN", "base": "main" } });
        assert_eq!(ticket_prs(&old), vec![json!({ "url": "u1", "state": "OPEN", "base": "main" })]);
        assert_eq!(ticket_prs(&json!({ "prUrl": "u1" })), vec![json!({ "url": "u1", "state": null })]);
        assert!(ticket_prs(&json!({})).is_empty());
        let t = json!({ "prs": [{ "url": "a", "state": "MERGED" }, { "url": "b", "state": null }], "prUrl": "b" });
        assert_eq!(main_pr(&ticket_prs(&t)).as_deref(), Some("b"));
        let added = add_prs(&t, &["b".into(), "c".into(), "c".into()]);
        assert_eq!(Value::Object(added), json!({ "prs": [{ "url": "a", "state": "MERGED" }, { "url": "b", "state": null }, { "url": "c", "state": null }], "prUrl": "c" }));
        assert!(add_prs(&t, &["a".into()]).is_empty());
        let mut seen = HashMap::new();
        seen.insert("b".to_string(), Seen { state: "CLOSED".into(), base: Some("dev".into()) });
        assert_eq!(
            Value::Object(update_prs(&t, &seen)),
            json!({ "prs": [{ "url": "a", "state": "MERGED" }, { "url": "b", "state": "CLOSED", "base": "dev" }], "prUrl": "b" })
        );
    }

    #[test]
    fn parses_status_and_blocks_merge() {
        let raw = json!({
            "number": 7, "state": "OPEN", "baseRefName": "main", "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "reviewDecision": "", "comments": [{}, {}],
            "statusCheckRollup": [
                { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://github.com/o/r/actions/runs/1/job/2", "completedAt": "2026-01-01T00:00:00Z" },
                { "__typename": "StatusContext", "context": "ci/x", "state": "PENDING", "targetUrl": "" },
                { "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED", "completedAt": "0001-01-01T00:00:00Z", "startedAt": "2026-01-01T00:00:00Z" }
            ]
        });
        let pr = parse_pr_status("https://github.com/o/r/pull/7", &raw, "NOW");
        assert_eq!(
            pr,
            json!({
                "url": "https://github.com/o/r/pull/7", "number": 7, "state": "OPEN",
                "checks": [
                    { "name": "test", "state": "fail", "url": "https://github.com/o/r/actions/runs/1/job/2", "at": "2026-01-01T00:00:00Z" },
                    { "name": "ci/x", "state": "pending", "url": null, "at": null },
                    { "name": "lint", "state": "skipped", "url": null, "at": "2026-01-01T00:00:00Z" }
                ],
                "failing": 1, "pending": 1, "mergeable": "MERGEABLE", "conflicts": false, "mergeStateStatus": "CLEAN",
                "base": "main", "reviewDecision": null, "comments": 2, "fetchedAt": "NOW"
            })
        );
        assert_eq!(merge_block(Some(&pr)).as_deref(), Some("1 check failing"));
        assert_eq!(merge_block(None).as_deref(), Some("PR status not loaded yet"));
        let ok = parse_pr_status("https://x/pull/9", &json!({ "state": "OPEN", "mergeable": "MERGEABLE" }), "N");
        assert_eq!(ok["number"], json!(9));
        assert_eq!(merge_block(Some(&ok)), None);
        assert_eq!(actions_ids(Some("https://github.com/o/r/actions/runs/1/job/2")), Some(("o/r".into(), "1".into(), Some("2".into()))));
    }

    #[test]
    fn messages() {
        let pr = json!({ "number": 3, "url": "U" });
        let m = failure_message(&pr, &[
            CheckLog { name: "a".into(), log: Some("x".repeat(9000)), url: None },
            CheckLog { name: "b".into(), log: None, url: Some("L".into()) },
        ]);
        assert!(m.starts_with("CI failed on PR #3 (U): a, b.\n\n### a\n```\n… (1000 earlier chars cut)\n"));
        assert!(m.ends_with("### b\n(no log available; see L)\n\nFix it and push."));
        assert!(conflict_message(&pr, "main").contains("(`origin/main`)"));
        assert!(conflict_message(&json!({ "url": "U" }), "").starts_with("PR #? (U) has conflicts with the base branch."));
    }

    struct FakeGh {
        status: Mutex<HashMap<String, Value>>,
        merged: Mutex<Vec<String>>,
    }

    impl Gh for FakeGh {
        fn status(&self, url: &str) -> BoxFuture<'_, Result<Value, String>> {
            let r = self.status.lock().get(url).cloned().ok_or_else(|| "no such PR".to_string());
            Box::pin(async move { r })
        }
        fn state(&self, url: &str) -> BoxFuture<'_, Option<String>> {
            let r = self.status.lock().get(url).and_then(|v| s(v, "state").map(str::to_string));
            Box::pin(async move { r })
        }
        fn merge(&self, url: &str) -> BoxFuture<'_, Result<(), String>> {
            self.merged.lock().push(url.into());
            Box::pin(async { Ok(()) })
        }
        fn failed_log(&self, _: &Value) -> BoxFuture<'_, Option<String>> {
            Box::pin(async { Some("boom".into()) })
        }
    }

    fn open(url: &str) -> Value {
        parse_pr_status(url, &json!({ "state": "OPEN", "mergeable": "MERGEABLE", "baseRefName": "main" }), "2026-01-01T00:00:00.000Z")
    }

    #[tokio::test]
    async fn refresh_merge_and_check() {
        let b = MemBoard::default();
        b.add_profile(json!({ "slug": "p", "baseBranch": "main" }));
        b.add("p", json!({ "id": "t1", "status": "review", "prUrl": "u1" }));
        let gh = Arc::new(FakeGh { status: Mutex::new(HashMap::from([("u1".to_string(), open("u1"))])), merged: Mutex::new(vec![]) });
        let pr = refresh_pr(&b, gh.clone(), "p", "t1", None).await.unwrap().unwrap();
        assert_eq!(pr["state"], "OPEN");
        assert_eq!(b.get("p", "t1")["pr"]["url"], "u1");
        let t = merge_pr(&b, &*gh, "p", "t1").await.unwrap();
        assert_eq!(*gh.merged.lock(), ["u1"]);
        assert_eq!(t["status"], "done");
        assert_eq!(b.get("p", "t1")["pr"]["state"], "MERGED");
        assert_eq!(b.comment_texts("t1"), ["PR merged."]);
        // Refused: not in Review any more.
        assert_eq!(merge_pr(&b, &*gh, "p", "t1").await.unwrap_err().status, 409);

        // check-pr: merged on GitHub, the card waits on the user: stays in Review, says it once.
        b.add("p", json!({ "id": "t2", "status": "review", "prUrl": "u2" }));
        gh.status.lock().insert("u2".into(), json!({ "state": "MERGED" }));
        b.holds.lock().push("t2".into());
        assert_eq!(check_pr_gh(&b, gh.clone(), "p", "t2").await.as_deref(), Some("MERGED"));
        assert_eq!(check_pr_gh(&b, gh.clone(), "p", "t2").await.as_deref(), Some("MERGED"));
        assert_eq!(b.get("p", "t2")["status"], "review");
        assert_eq!(b.comment_texts("t2"), ["PR merged."]);
        b.holds.lock().clear();
        let mut closed = HashMap::new();
        poll_once(&b, gh.clone(), &mut closed, 0.0).await;
        assert_eq!(b.get("p", "t2")["status"], "done");

        // Closed without merge: a note, the card stays.
        b.add("p", json!({ "id": "t3", "status": "review", "prUrl": "u3" }));
        gh.status.lock().insert("u3".into(), json!({ "state": "CLOSED" }));
        check_pr_gh(&b, gh.clone(), "p", "t3").await;
        check_pr_gh(&b, gh.clone(), "p", "t3").await;
        assert_eq!(b.comment_texts("t3"), ["PR closed without merge."]);
        assert_eq!(b.get("p", "t3")["status"], "review");
    }

    #[tokio::test]
    async fn send_failures_and_resolve_conflicts_chat_the_ticket() {
        let b = MemBoard::default();
        b.add_profile(json!({ "slug": "p", "baseBranch": "main" }));
        b.add("p", json!({ "id": "t1", "status": "review", "prUrl": "u1" }));
        let failing = parse_pr_status(
            "u1",
            &json!({ "number": 1, "state": "OPEN", "mergeable": "CONFLICTING", "statusCheckRollup": [{ "name": "t", "status": "COMPLETED", "conclusion": "FAILURE" }] }),
            "N",
        );
        let gh = FakeGh { status: Mutex::new(HashMap::from([("u1".to_string(), failing)])), merged: Mutex::new(vec![]) };
        send_failures(&b, &gh, "p", "t1").await.unwrap();
        resolve_conflicts(&b, &gh, "p", "t1").await.unwrap();
        let chats = b.chats.lock().clone();
        assert!(chats[0].2.starts_with("CI failed on PR #1 (u1): t."));
        assert!(chats[1].2.contains("has conflicts with main"));
        b.running.lock().push("t1".into());
        assert_eq!(resolve_conflicts(&b, &gh, "p", "t1").await.unwrap_err().message, "Claude is already working on this ticket.");
    }
}
