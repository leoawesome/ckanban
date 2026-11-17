//! Huddle limits and pure helpers (`huddle-types.ts`, `huddle-roster.ts`): mentions, who manages, who wakes, what the
//! user hasn't seen, the board's own summary. A huddle is kept as its JSON object (`Map`), in Bun's key order, so
//! fields Rust doesn't know survive a save.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::prompts::js;

pub type Obj = Map<String, Value>;

/// The host ticket's own session: the coordinator.
pub const MAIN_HANDLE: &str = "main";
/// The user, posting from the board.
pub const USER_HANDLE: &str = "you";
/// Longest message anyone can post.
pub const POST_MAX: usize = 2000;
/// Longest pinned brief.
pub const BRIEF_MAX: usize = 8000;
const FINDING_TITLE: usize = 100;
pub const DEFAULT_MAX_COST_USD: f64 = 20.0;
pub const BUDGET_WARN: f64 = 0.8;
/// Teammates one agent may have waiting for the user's review at once.
pub const MAX_PENDING_TEAMMATES: usize = 2;
/// A live huddle with nobody working and nothing owed for this long wakes @main (`idleSweep`).
pub const HUDDLE_IDLE_MS: f64 = 5.0 * 60_000.0;
/// How often the idle watchdog looks at the open huddles.
pub const IDLE_SWEEP_MS: u64 = 30_000;
/// Longest one-line summary of a hand-in.
pub const HANDIN_SUMMARY_MAX: usize = 300;
/// The single summary file older huddles wrote.
pub const LEGACY_SUMMARY_FILE: &str = "huddle-summary.md";
/// `closeForTicket`'s reason when the host ticket is gone (nobody writes a summary).
pub const DELETED: &str = "the host ticket was deleted";

/// Where a huddle's summary goes, relative to the host ticket's outputs folder.
pub fn summary_file(hid: &str) -> String {
    format!("huddles/{hid}/summary.md")
}
/// The plan a plan review checks (`proposalFile`).
pub fn proposal_file(hid: &str) -> String {
    format!("huddles/{hid}/proposal.md")
}

// ---- field access over the JSON object ----

pub fn s<'a>(o: &'a Obj, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or("")
}
pub fn opt_s<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}
pub fn f(o: &Obj, k: &str) -> f64 {
    o.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}
pub fn opt_f(o: &Obj, k: &str) -> Option<f64> {
    o.get(k).and_then(Value::as_f64)
}
pub fn b(o: &Obj, k: &str) -> bool {
    matches!(o.get(k), Some(Value::Bool(true)))
}
pub fn num(x: f64) -> Value {
    ckanban_core::jsnum::num(x)
}
pub fn participants(h: &Obj) -> Vec<&Obj> {
    h.get("participants").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_object).collect()).unwrap_or_default()
}
pub fn participant<'a>(h: &'a Obj, handle: &str) -> Option<&'a Obj> {
    participants(h).into_iter().find(|p| s(p, "handle") == handle)
}
pub fn participant_mut<'a>(h: &'a mut Obj, handle: &str) -> Option<&'a mut Obj> {
    h.get_mut("participants")?.as_array_mut()?.iter_mut().filter_map(Value::as_object_mut).find(|p| s(p, "handle") == handle)
}
pub fn list<'a>(h: &'a Obj, k: &str) -> Vec<&'a Obj> {
    h.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_object).collect()).unwrap_or_default()
}
pub fn list_mut<'a>(h: &'a mut Obj, k: &str) -> &'a mut Vec<Value> {
    if !matches!(h.get(k), Some(Value::Array(_))) {
        h.insert(k.into(), Value::Array(Vec::new()));
    }
    h.get_mut(k).and_then(Value::as_array_mut).expect("an array")
}
pub fn mentions(m: &Obj) -> Vec<&str> {
    m.get("mentions").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default()
}
pub fn mentions_has(m: &Obj, who: &str) -> bool {
    mentions(m).contains(&who)
}

// ---- roles ----

pub fn is_coordinator(h: &Obj, p: &Obj) -> bool {
    s(p, "kind") == "ticket-main" && opt_s(p, "ticketId") == Some(s(h, "hostTicket"))
}
pub fn can_manage(h: &Obj, p: &Obj) -> bool {
    s(p, "kind") == "human" || is_coordinator(h, p) || b(p, "lead")
}
/// done / blocked: set by the participant itself.
pub fn settled(p: &Obj) -> bool {
    matches!(s(p, "status"), "done" | "blocked")
}
pub fn is_snapshot(p: &Obj) -> bool {
    s(p, "kind") == "agent" && s(p, "workspace") == "shared" && !b(p, "canEdit")
}
/// `activeHost`: the huddle's host while it can act, else @main.
pub fn active_host(h: &Obj) -> String {
    if let Some(host) = opt_s(h, "host")
        && let Some(p) = participant(h, host)
        && matches!(s(p, "status"), "idle" | "working")
    {
        return s(p, "handle").to_string();
    }
    MAIN_HANDLE.into()
}
/// `huddleCost`.
/// An auto huddle (`h.auto`).
pub fn is_auto(h: &Obj) -> bool {
    truthy(h.get("auto"))
}

pub fn huddle_cost(h: &Obj) -> f64 {
    participants(h).iter().map(|p| f(p, "costUsd")).sum()
}
pub fn non_human(h: &Obj) -> usize {
    participants(h).iter().filter(|p| s(p, "kind") != "human").count()
}
/// `endedByDone`: a Done host's huddle started before the host last moved to Done ends with it.
pub fn ended_by_done(h: &Obj, done_at: Option<&str>) -> bool {
    match done_at.filter(|d| !d.is_empty()) {
        None => true,
        Some(d) => s(h, "createdAt") <= d,
    }
}

/// `pendingLearnings`: teammates and squads agents proposed, waiting for the user.
pub fn pending_learnings(h: &Obj) -> Vec<&Obj> {
    list(h, "learnings").into_iter().filter(|l| s(l, "status") == "pending" && (truthy(l.get("teammate")) || truthy(l.get("squad")))).collect()
}
fn truthy(v: Option<&Value>) -> bool {
    crate::team::jsv::truthy(v)
}

/// `userSeenSeq`: the seq the user has seen up to: their last post or action.
pub fn user_seen_seq(h: &Obj, msgs: &[Value]) -> f64 {
    let cursor = participant(h, USER_HANDLE).map(|p| f(p, "cursor")).unwrap_or(0.0);
    let posted = msgs.iter().rev().filter_map(Value::as_object).find(|m| s(m, "from") == USER_HANDLE).map(|m| f(m, "seq")).unwrap_or(0.0);
    cursor.max(posted)
}
/// `isForYou`.
pub fn is_for_you(m: &Obj, since: f64) -> bool {
    f(m, "seq") > since && s(m, "from") != USER_HANDLE && mentions_has(m, USER_HANDLE)
}

/// `wakes`: whether a message wakes a participant: "mention", "monitor" or None.
pub fn wakes(h: &Obj, p: &Obj, m: &Obj) -> Option<&'static str> {
    if s(p, "kind") == "human" || s(m, "from") == s(p, "handle") || s(p, "status") == "stopped" {
        return None;
    }
    let me = s(p, "handle");
    let mentioned = mentions_has(m, me) || mentions_has(m, "all");
    if s(m, "kind") == "system" {
        return mentioned.then_some("mention");
    }
    if s(p, "status") == "done" {
        let from = participant(h, s(m, "from"));
        if mentioned && from.is_some_and(|x| can_manage(h, x)) {
            return Some("mention");
        }
        if !b(p, "lead") {
            return None;
        }
        if mentions_has(m, me) {
            return Some("mention");
        }
        return (s(p, "mode") == "monitor" && from.is_some_and(|x| !can_manage(h, x))).then_some("monitor");
    }
    if mentioned {
        return Some("mention");
    }
    (s(p, "mode") == "monitor" && s(p, "status") != "blocked").then_some("monitor")
}

// ---- text ----

/// Text where a @handle is quoted rather than addressed (`QUOTED_RE`).
static QUOTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)```[\s\S]*?(?:```|\z)|`[^`\n]*`|^[ \t]*>.*$|"[^"\n]*"|\x{201c}[^\x{201d}\n]*\x{201d}"#).unwrap());
static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[^A-Za-z0-9_@./-])@([A-Za-z0-9][A-Za-z0-9_-]*)").unwrap());

/// `parseMentions`: @handles in a message, lowercased; "all" for @all.
pub fn parse_mentions(text: &str) -> Vec<String> {
    let plain = QUOTED.replace_all(text, " ");
    let mut out: Vec<String> = Vec::new();
    for c in MENTION.captures_iter(&plain) {
        let h = c[1].to_lowercase().trim_end_matches(['-', '_']).to_string();
        if !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

/// `findingTitle`: a finding's first line, cut to 100 characters.
pub fn finding_title(text: &str) -> String {
    let line = js::trim(js::trim(text).split('\n').next().unwrap_or(""));
    if js::len16(line) > FINDING_TITLE { format!("{}…", js::trim_end(js::slice16(line, FINDING_TITLE - 1))) } else { line.to_string() }
}

/// `money`: "$1.20".
pub fn money(n: f64) -> String {
    format!("${}", js::to_fixed(n, 2))
}

/// `handInFiles`: "changed a, added b" (the first 20).
pub fn hand_in_files(files: &[Value], max: usize) -> String {
    let shown: Vec<String> = files
        .iter()
        .take(max)
        .filter_map(Value::as_object)
        .map(|f| format!("{} {}", s(f, "change"), s(f, "path")))
        .collect();
    let shown = shown.join(", ");
    if files.len() > max { format!("{shown} and {} more", files.len() - max) } else { shown }
}

/// `s.trim().replace(/\s+/g, " ")`.
pub fn squash(text: &str) -> String {
    js::trim(text).split(char::is_whitespace).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

static OUTPUT_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"outputs/([A-Za-z0-9_./-]+\.[A-Za-z0-9_]+)").unwrap());
static LINE_BREAK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\n\s*").unwrap());

/// `fallbackSummary`: the summary the board writes when a huddle closed without one.
pub fn fallback_summary(h: &Obj, msgs: &[Value], outputs: &[String]) -> String {
    let at16 = |t: &str| js::slice16(t, 16).replacen('T', " ", 1);
    let span = format!(
        "{}{} UTC",
        at16(s(h, "createdAt")),
        opt_s(h, "closedAt").filter(|c| !c.is_empty()).map(|c| format!(" to {}", at16(c))).unwrap_or_default()
    );
    let ps = participants(h);
    let agents: Vec<&Obj> = ps.iter().copied().filter(|p| s(p, "kind") != "human").collect();
    let leads: Vec<&Obj> = agents.iter().copied().filter(|p| b(p, "lead") || s(p, "handle") == MAIN_HANDLE).collect();
    let all: Vec<&Obj> = msgs.iter().filter_map(Value::as_object).collect();
    let last: Vec<(&Obj, &Obj)> = leads
        .iter()
        .filter_map(|p| all.iter().rev().find(|m| s(m, "from") == s(p, "handle") && s(m, "kind") != "system").map(|m| (*p, *m)))
        .collect();
    let said = all.iter().map(|m| s(m, "text")).collect::<Vec<_>>().join("\n");
    let mine = summary_file(s(h, "id"));
    let mut mentioned: Vec<String> = outputs.iter().filter(|f| **f != mine && said.contains(f.as_str())).cloned().collect();
    for c in OUTPUT_REF.captures_iter(&said) {
        let f = c[1].to_string();
        if f != mine && !mentioned.contains(&f) {
            mentioned.push(f);
        }
    }
    mentioned.sort();
    let mut out: Vec<String> = vec![
        "# Huddle summary".into(),
        String::new(),
        format!(
            "_Written by the board: huddle {} closed without a summary. {span}, {} messages, {} spent._",
            s(h, "id"),
            js::num(f(h, "seq")),
            money(huddle_cost(h))
        ),
        String::new(),
        "## Brief".into(),
        String::new(),
    ];
    let brief = h.get("brief").and_then(Value::as_object).map(|b| js::trim(s(b, "text")).to_string()).unwrap_or_default();
    out.push(if brief.is_empty() { "No brief was pinned.".into() } else { brief });
    out.extend([String::new(), "## Participants".into(), String::new()]);
    if agents.is_empty() {
        out.push("None.".into());
    }
    for p in &agents {
        out.push(format!(
            "- @{}: {}{} · {} · {}",
            s(p, "handle"),
            s(p, "role"),
            if b(p, "lead") { " (lead)" } else { "" },
            s(p, "status"),
            money(f(p, "costUsd"))
        ));
    }
    out.extend([String::new(), "## Findings".into(), String::new()]);
    let findings = list(h, "findings");
    if findings.is_empty() {
        out.push("None pinned.".into());
    }
    for x in findings {
        let resolved = opt_s(x, "resolvedBy").filter(|r| !r.is_empty()).map(|r| format!(", resolved by @{r}")).unwrap_or_default();
        out.push(format!(
            "- [{}] {} (pinned by @{}{resolved})",
            if s(x, "status") == "resolved" { "x" } else { " " },
            LINE_BREAK.replace_all(s(x, "text"), " "),
            s(x, "by")
        ));
    }
    out.push(String::new());
    let hand_ins = list(h, "handIns");
    if !hand_ins.is_empty() {
        out.extend(["## Changes handed in".into(), String::new()]);
        for x in hand_ins {
            let files = x.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
            let by = opt_s(x, "by").filter(|v| !v.is_empty()).map(|v| format!(" by @{v}")).unwrap_or_default();
            let why = opt_s(x, "reason").filter(|v| !v.is_empty()).map(|v| format!(" ({v})")).unwrap_or_default();
            out.push(format!("- {} from @{}: {} ({}): {}{by}{why}", s(x, "id"), s(x, "from"), s(x, "summary"), hand_in_files(&files, 20), s(x, "status")));
        }
        out.push(String::new());
    }
    out.extend(["## Last word from the leads".into(), String::new()]);
    if last.is_empty() {
        out.extend(["No lead posted.".into(), String::new()]);
    }
    for (p, m) in last {
        out.extend([format!("### @{} (#{})", s(p, "handle"), js::num(f(m, "seq"))), String::new(), js::trim(s(m, "text")).to_string(), String::new()]);
    }
    out.extend(["## Output files mentioned".into(), String::new()]);
    if mentioned.is_empty() {
        out.push("None.".into());
    }
    for f in mentioned {
        out.push(format!("- {f}"));
    }
    out.push(String::new());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mentions_skip_quotes_code_and_addresses() {
        assert_eq!(parse_mentions("hello @Reviewer and @qa-, @all"), vec!["reviewer", "qa", "all"]);
        assert_eq!(parse_mentions("mail a@b.com, `@x` \"@y\" path/@z"), Vec::<String>::new());
        assert_eq!(parse_mentions("> @quoted\n@real"), vec!["real"]);
        assert_eq!(parse_mentions("```\n@code"), Vec::<String>::new());
        assert_eq!(parse_mentions("@main looks fine"), vec!["main"]);
    }

    #[test]
    fn finding_titles_are_cut() {
        assert_eq!(finding_title("  one\ntwo"), "one");
        let long = "x".repeat(150);
        assert_eq!(finding_title(&long), format!("{}…", "x".repeat(99)));
    }

    #[test]
    fn wake_rules() {
        let h = json!({ "hostTicket": "t1", "participants": [
            { "handle": "you", "kind": "human" },
            { "handle": "main", "kind": "ticket-main", "ticketId": "t1", "mode": "monitor", "status": "idle" },
            { "handle": "r", "kind": "agent", "mode": "tagged", "status": "idle" },
            { "handle": "d", "kind": "agent", "mode": "monitor", "status": "done" },
        ]});
        let h = h.as_object().unwrap();
        let m = |from: &str, kind: &str, mentions: Value| json!({ "from": from, "kind": kind, "mentions": mentions });
        let p = |x: &str| participant(h, x).unwrap();
        assert_eq!(wakes(h, p("r"), m("you", "message", json!([])).as_object().unwrap()), None);
        assert_eq!(wakes(h, p("r"), m("you", "message", json!(["r"])).as_object().unwrap()), Some("mention"));
        assert_eq!(wakes(h, p("main"), m("r", "message", json!([])).as_object().unwrap()), Some("monitor"));
        assert_eq!(wakes(h, p("main"), m("system", "system", json!([])).as_object().unwrap()), None);
        assert_eq!(wakes(h, p("d"), m("r", "message", json!(["d"])).as_object().unwrap()), None);
        assert_eq!(wakes(h, p("d"), m("you", "message", json!(["d"])).as_object().unwrap()), Some("mention"));
    }

    #[test]
    fn fallback_summary_lists_the_room() {
        let h = json!({ "id": "h_1", "createdAt": "2026-01-02T03:04:05.000Z", "closedAt": "2026-01-02T04:00:00.000Z", "seq": 2,
            "brief": null, "findings": [{ "id": "f1", "text": "a\n b", "by": "you", "status": "resolved", "resolvedBy": "main" }],
            "participants": [{ "handle": "you", "kind": "human" }, { "handle": "main", "kind": "ticket-main", "role": "Coordinator", "lead": true, "status": "idle", "costUsd": 0.5 }] });
        let msgs = vec![json!({ "seq": 1, "from": "main", "kind": "message", "text": "see outputs/report.md" })];
        let out = fallback_summary(h.as_object().unwrap(), &msgs, &[]);
        assert!(out.starts_with("# Huddle summary\n\n_Written by the board: huddle h_1 closed without a summary. 2026-01-02 03:04 to 2026-01-02 04:00 UTC, 2 messages, $0.50 spent._"));
        assert!(out.contains("- [x] a b (pinned by @you, resolved by @main)"));
        assert!(out.contains("### @main (#1)\n\nsee outputs/report.md\n"));
        assert!(out.ends_with("## Output files mentioned\n\n- report.md\n"));
    }
}
