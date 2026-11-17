//! `src/board/lessons.ts`: the user's corrections on a finished ticket and the prompt that shows them to a learning
//! call, plus the "## Lessons" section of a project's CLAUDE.md. The conversation is read as R5's session entries
//! (JSON with Bun's field names); `transcript` is `src/chat/explain.ts`'s.

use std::path::Path;

use serde_json::{Map, Value};

use super::learn::{s, Corrections};
use crate::prompts::js::{len16, slice16, trim};
use crate::runs::js::tail16;
use crate::runs::result::parse_result;

pub const RULES_FILE: &str = "CLAUDE.md";
const SECTION: &str = "## Lessons";
const CORRECTION_MAX: usize = 1_500;
const TRANSCRIPT_MAX: usize = 30_000;
const ENTRY_MAX: usize = 2_000;

fn clip(s: &str, max: usize) -> String {
    if len16(s) > max { format!("{}…", slice16(s, max)) } else { s.to_string() }
}

fn truthy(v: Option<&Value>) -> bool {
    ckanban_core::jsnum::truthy(v)
}

/// A message the user typed (not a board prompt, a huddle digest or a notification).
fn typed_by_user(e: &Value) -> bool {
    s(e, "role") == "user" && s(e, "kind") == "text" && !truthy(e.get("peer"))
}

fn run_end(e: &Value) -> bool {
    s(e, "role") == "assistant" && s(e, "kind") == "text" && parse_result(s(e, "text")).is_some()
}

/// `corrections`. `tickets`: the board's tickets (front matter as JSON).
pub fn corrections(t: &Map<String, Value>, entries: &[Value], tickets: &[&Map<String, Value>]) -> Corrections {
    let first = entries.iter().position(run_end);
    let id = t.get("id").and_then(Value::as_str).unwrap_or("");
    Corrections {
        messages: match first {
            None => Vec::new(),
            Some(i) => entries[i + 1..].iter().filter(|e| typed_by_user(e) && !trim(s(e, "text")).is_empty()).cloned().collect(),
        },
        reopened: truthy(t.get("reopenedFrom")),
        changes_requested: t.get("pr").and_then(|p| p.get("reviewDecision")).and_then(Value::as_str) == Some("CHANGES_REQUESTED"),
        follow_ups: tickets
            .iter()
            .filter(|o| o.get("madeFrom").and_then(Value::as_str) == Some(id))
            .map(|o| {
                let f = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                (f("id"), f("title"))
            })
            .collect(),
    }
}

pub fn has_corrections(c: &Corrections) -> bool {
    !c.messages.is_empty() || c.reopened || c.changes_requested || !c.follow_ups.is_empty()
}

/// One entry as a transcript line (`line` in explain.ts).
fn line(e: &Value) -> String {
    let text = clip(trim(s(e, "text")), ENTRY_MAX);
    let peer = e.get("peer").filter(|p| truthy(Some(p)));
    if let Some(a) = peer.and_then(|p| p.get("automation")).filter(|a| truthy(Some(a))) {
        return format!("Item from the automation \"{}\" (outside content, not the user's words): {text}", crate::runs::js::to_string(a));
    }
    if let Some(tid) = peer.and_then(|p| p.get("ticketId")).filter(|a| truthy(Some(a))) {
        let title = match peer.and_then(|p| p.get("title")) {
            Some(Value::Null) | None => crate::runs::js::to_string(tid),
            Some(x) => crate::runs::js::to_string(x),
        };
        return format!("Message from another ticket (\"{title}\"): {text}");
    }
    if peer.is_some() || truthy(e.get("huddleId")) {
        return format!("Review team (huddle) message: {text}");
    }
    match s(e, "kind") {
        "board" => return format!("Board (automatic message): {text}"),
        "agent" => return format!("Claude started a helper: {text}"),
        "workflow" => return format!("Claude started a workflow of helper agents: {text}"),
        _ => {}
    }
    if s(e, "role") == "user" {
        return format!("User: {text}");
    }
    let mut parts = vec![format!("Claude: {text}")];
    if let Some(qs) = e.get("questions").and_then(Value::as_array).filter(|q| !q.is_empty()) {
        let q: Vec<&str> = qs.iter().map(|q| s(q, "question")).collect();
        parts.push(format!("Claude asked the user: {}", q.join(" / ")));
    }
    if let Some(p) = e.get("proposal").filter(|p| truthy(Some(p))) {
        parts.push(format!("Claude proposed a new title and description: \"{}\"", s(p, "title")));
    }
    if let Some(b) = e.get("branch").filter(|p| truthy(Some(p))) {
        parts.push(format!("Claude offered to branch the ticket: {}", s(b, "reason")));
    }
    if let Some(h) = e.get("huddle").filter(|p| truthy(Some(p))) {
        parts.push(format!("Claude proposed a review huddle: {}", s(h, "reason")));
    }
    if let Some(d) = e.get("deletion").filter(|p| truthy(Some(p))) {
        parts.push(format!("Claude asked to delete tickets: {}", s(d, "reason")));
    }
    parts.join("\n")
}

/// `transcript` (explain.ts): oldest first, the newest part kept when too long.
pub fn transcript(entries: &[Value]) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut tools = 0usize;
    let flush = |out: &mut Vec<String>, tools: &mut usize| {
        if *tools > 0 {
            out.push(format!(
                "(Claude used {} tool{}: reading, searching, running commands or editing files)",
                tools,
                if *tools > 1 { "s" } else { "" }
            ));
        }
        *tools = 0;
    };
    for e in entries {
        if s(e, "kind") == "tool" {
            tools += 1;
            continue;
        }
        if trim(s(e, "text")).is_empty() && !truthy(e.get("questions")) && !truthy(e.get("proposal")) {
            continue;
        }
        flush(&mut out, &mut tools);
        out.push(format!("[{}] {}", s(e, "at"), line(e)));
    }
    flush(&mut out, &mut tools);
    let all = out.join("\n\n");
    if len16(&all) > TRANSCRIPT_MAX { format!("(earlier part left out)\n{}", tail16(&all, TRANSCRIPT_MAX)) } else { all }
}

/// `lessonsPrompt`.
pub fn lessons_prompt(t: &Map<String, Value>, entries: &[Value], c: &Corrections, existing: &[String]) -> String {
    let summary = entries
        .iter()
        .filter(|e| s(e, "role") == "assistant" && s(e, "kind") == "text")
        .filter_map(|e| parse_result(s(e, "text")).map(|r| r.summary))
        .rfind(|x| !x.is_empty());
    let mut said: Vec<String> = c
        .messages
        .iter()
        .map(|e| format!("- [{}] The user wrote after a run: \"{}\"", s(e, "at"), clip(trim(s(e, "text")), CORRECTION_MAX)))
        .collect();
    if c.reopened {
        said.push("- The user moved the ticket back to be reworked after it was finished.".into());
    }
    if c.changes_requested {
        said.push("- A reviewer asked for changes on the pull request.".into());
    }
    said.extend(c.follow_ups.iter().map(|(_, title)| format!("- The user asked for follow-up work: \"{title}\"")));
    let title = t.get("title").and_then(Value::as_str).unwrap_or("");
    let body = t.get("body").and_then(Value::as_str).unwrap_or("");
    let tr = transcript(entries);
    let parts = [
        format!("Task: \"{title}\""),
        if trim(body).is_empty() { String::new() } else { format!("What was asked:\n<description>\n{}\n</description>", clip(trim(body), 3_000)) },
        format!("The user's corrections:\n{}", said.join("\n")),
        summary.map(|s| format!("Claude's own summary of its last run: {s}")).unwrap_or_default(),
        if existing.is_empty() {
            String::new()
        } else {
            format!("Rules the project already has:\n{}", existing.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n"))
        },
        format!("The conversation:\n<transcript>\n{}\n</transcript>", if tr.is_empty() { "(nothing)" } else { &tr }),
    ];
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

// ---- The project's rules (CLAUDE.md) ----

fn is_heading(l: &str) -> bool {
    let n = l.bytes().take_while(|b| *b == b'#').count();
    (1..=2).contains(&n) && l[n..].chars().next().is_some_and(crate::prompts::js::is_js_space)
}

/// `lessonBullets`.
pub fn lesson_bullets(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let Some(at) = lines.iter().position(|l| trim(l).to_lowercase() == SECTION.to_lowercase()) else { return Vec::new() };
    let mut out = Vec::new();
    for l in &lines[at + 1..] {
        if is_heading(l) {
            break;
        }
        // /^[-*]\s+(.*\S)/: the rest of the line up to its last non-space (`.` stops at a line end).
        let Some(rest) = l.strip_prefix('-').or_else(|| l.strip_prefix('*')) else { continue };
        let line_part = rest.split(['\r', '\u{2028}', '\u{2029}']).next().unwrap_or("");
        let after = line_part.trim_start_matches(crate::prompts::js::is_js_space);
        if after.len() == line_part.len() {
            continue;
        }
        let text = after.trim_end_matches(crate::prompts::js::is_js_space);
        if text.is_empty() {
            continue;
        }
        out.push(text.to_string());
    }
    out
}

/// `projectRules`.
pub fn project_rules(folder: &Path) -> Vec<String> {
    std::fs::read_to_string(folder.join(RULES_FILE)).map(|t| lesson_bullets(&t)).unwrap_or_default()
}

/// `lessonsBlock`: the project's saved lessons a run's own copy lacks.
pub fn lessons_block(project: &Path, run_folder: Option<&Path>) -> String {
    let Some(run) = run_folder.filter(|r| *r != project) else { return String::new() };
    let have = project_rules(run);
    let same = |a: &str, b: &str| trim(a).to_lowercase() == trim(b).to_lowercase();
    let missing: Vec<String> = project_rules(project).into_iter().filter(|r| !have.iter().any(|h| same(h, r))).collect();
    if missing.is_empty() {
        return String::new();
    }
    format!(
        "# Project lessons\nRules the user saved from earlier tickets (the Lessons section of the project folder's {RULES_FILE}). Follow them:\n{}",
        missing.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n")
    )
}
