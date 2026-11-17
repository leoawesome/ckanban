//! A feature's status, "Where we are" (`src/board/feature.ts`): Claude's words (`status.json`) and the board's facts
//! from ticket data, rendered as `status.md`. Both live in the top ticket's outputs folder; status.json is written
//! as Bun writes it (`JSON.stringify(saved, null, 2)`, no final newline, through `status.json.tmp`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::plan::or_empty;
use crate::git::pr::ticket_prs;
use crate::index::family::{family_state, feature_rows, feature_tasks, settled};
use crate::index::store::BoardList;
use crate::index::text::{is_space, js_trim, js_trim_end, len16, slice16, squash_spaces};
use crate::index::ticket::Tk;

/// The sections Claude writes, in the block's order.
pub const STATUS_FIELDS: [&str; 5] = ["goal", "done", "broken", "waiting", "next"];
pub const STATUS_FIELD_MAX: usize = 2000;
pub const STATUS_NOTE_MAX: usize = 2000;
pub const CUT_SHORT: &str = "… (cut short)";
/// The line every commit of a feature's tickets ends with.
pub const FEATURE_TRAILER: &str = "Ckanban-Feature";
pub const CHANGES_SHOWN: usize = 30;
pub const SAVED_CHANGES_FILE: &str = "saved-changes.md";

/// `clipText`: at most max (UTF-16 units), cut at a word break, with CUT_SHORT at the end.
pub fn clip_text(s: &str, max: usize) -> String {
    if len16(s) <= max {
        return s.to_string();
    }
    let room = slice16(s, max - len16(CUT_SHORT));
    // room.search(/\s\S*$/): the last whitespace with only non-whitespace after it.
    let space = room.char_indices().filter(|(_, c)| is_space(*c)).last().map(|(i, _)| i);
    // No space: search gives -1, which passes the test below, and slice(0, -1) drops the last unit (Bun's bytes).
    let at = space.map(|i| len16(&room[..i]) as i64).unwrap_or(-1);
    let cut = if at > len16(room) as i64 - 80 {
        match space {
            Some(i) => &room[..i],
            None => slice16(room, len16(room).saturating_sub(1)),
        }
    } else {
        room
    };
    let cut = js_trim_end(cut).trim_end_matches(|c: char| is_space(c) || matches!(c, ',' | ';' | ':' | '('));
    format!("{cut}{CUT_SHORT}")
}

pub fn status_json(dir: &Path) -> PathBuf {
    dir.join("status.json")
}
pub fn status_md(dir: &Path) -> PathBuf {
    dir.join("status.md")
}

/// `readStatus`: the saved status, None when missing, not an object or without `updatedAt`.
pub fn read_status(dir: &Path) -> Option<Map<String, Value>> {
    let text = std::fs::read_to_string(status_json(dir)).ok()?;
    let v = crate::runs::js::parse(&text)?;
    let Value::Object(mut v) = v else { return None };
    if !v.get("updatedAt").is_some_and(Value::is_string) {
        return None;
    }
    for f in STATUS_FIELDS {
        if let Some(Value::String(s)) = v.get(f)
            && len16(s) >= STATUS_FIELD_MAX
            && !s.ends_with(CUT_SHORT)
        {
            let c = clip_text(&format!("{s}…"), STATUS_FIELD_MAX);
            v.insert(f.into(), c.into());
        }
    }
    Some(v)
}

/// `applyPatch`: only the sections the patch names change (null or "" clears one). patch: field → Some(text) or
/// None (null); pr_notes: url → Some(note) or None.
pub fn apply_patch(saved: Option<Map<String, Value>>, patch: &[(String, Option<String>)], pr_notes: Option<&[(String, Option<String>)]>, now: &str, sig: &str) -> Map<String, Value> {
    let old_notes = saved.as_ref().and_then(|s| s.get("prNotes")).and_then(Value::as_object).cloned();
    let mut next = saved.unwrap_or_default();
    next.insert("updatedAt".into(), now.into());
    next.insert("claudeAt".into(), now.into());
    next.insert("familySig".into(), sig.into());
    for f in STATUS_FIELDS {
        let Some((_, v)) = patch.iter().find(|(k, _)| k == f) else { continue };
        match v.as_deref().map(js_trim).filter(|s| !s.is_empty()) {
            Some(s) => {
                next.insert(f.into(), clip_text(s, STATUS_FIELD_MAX).into());
            }
            None => {
                next.shift_remove(f);
            }
        }
    }
    if let Some(p) = pr_notes {
        let mut notes = old_notes.unwrap_or_default();
        for (url, v) in p {
            match v.as_deref().map(js_trim).filter(|s| !s.is_empty()) {
                Some(s) => {
                    notes.insert(url.clone(), clip_text(s, 200).into());
                }
                None => {
                    notes.shift_remove(url);
                }
            }
        }
        next.insert("prNotes".into(), Value::Object(notes));
    }
    next
}

fn add(c: &mut Map<String, Value>, s: &str) {
    let n = c.get(s).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
    c.insert(s.into(), ckanban_core::jsnum::num(n));
}

fn last_line(s: &str) -> String {
    js_trim(s).split('\n').filter(|l| !js_trim(l).is_empty()).last().map(|l| js_trim(l).to_string()).unwrap_or_default()
}

/// `clip` of feature.ts: the cut end trimmed before the ellipsis.
fn clip(s: &str, max: usize) -> String {
    if len16(s) > max { format!("{}…", js_trim_end(slice16(s, max - 1))) } else { s.to_string() }
}

/// `brokenReason`: why a ticket failed or found a problem, in one line. results: the family's result cards, oldest first.
pub fn broken_reason(t: &Tk, results: &[(String, String)]) -> Option<String> {
    if t.outcome_is("blocked") && t.is("capHit") {
        let cap = t.get("capHit").and_then(|c| c.get("capUsd")).and_then(Value::as_f64).unwrap_or(f64::NAN);
        return Some(format!("Stopped at its ${cap:.2} cap."));
    }
    let summary = results.iter().rev().find(|(id, _)| *id == t.id).map(|(_, s)| last_line(s)).unwrap_or_default();
    let error = last_line(&or_empty(t.get("error")));
    let why = if t.outcome_is("failed") {
        if error.is_empty() { summary } else { error }
    } else if summary.is_empty() {
        error
    } else {
        summary
    };
    (!why.is_empty()).then(|| clip(&why, 160))
}

fn pr_number(url: &str) -> Value {
    let Some(i) = url.find("/pull/") else { return Value::Null };
    let digits: String = url[i + 6..].chars().take_while(char::is_ascii_digit).collect();
    match digits.parse::<f64>() {
        Ok(n) if n != 0.0 => ckanban_core::jsnum::num(n),
        _ => Value::Null,
    }
}

/// What a sub-feature tells its parent's status: working (it or anything under it works) and its own next step.
pub struct SubFacts {
    pub working: bool,
    pub headline: Option<String>,
}

/// `statusFacts`: the board's facts for the feature top_id (`featureRows`: a sub-feature is one row).
pub fn status_facts(
    list: &BoardList,
    top_id: &str,
    needs_you: &dyn Fn(&Tk) -> bool,
    pr_notes: &Map<String, Value>,
    sub: &dyn Fn(&Tk) -> SubFacts,
) -> Map<String, Value> {
    let rows = feature_rows(list, top_id);
    let kids = list.kids();
    let task_ids: HashSet<usize> = feature_tasks(list, &rows).into_iter().collect();
    let is_sub = |t: &Tk| t.id != top_id && t.main;
    let sub_facts: HashMap<usize, SubFacts> = rows.iter().filter(|r| is_sub(list.at(r.idx))).map(|r| (r.idx, sub(list.at(r.idx)))).collect();
    let state_of: HashMap<usize, &'static str> = rows
        .iter()
        .map(|r| {
            let t = list.at(r.idx);
            let s = if sub_facts.get(&r.idx).is_some_and(|f| f.working) { "working" } else { family_state(t, false, needs_you(t)) };
            (r.idx, s)
        })
        .collect();
    let st = |i: usize| state_of.get(&i).copied();
    // A sub-feature's tickets are its own: the walk stops at it.
    let below = |id: &str| -> Vec<usize> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut stack: Vec<usize> = kids.of(id).iter().rev().map(|&(i, _)| i).collect();
        while let Some(i) = stack.pop() {
            if !seen.insert(i) {
                continue;
            }
            out.push(i);
            if !is_sub(list.at(i)) {
                stack.extend(kids.of(&list.at(i).id).iter().rev().map(|&(c, _)| c));
            }
        }
        out
    };
    let mut counts = Map::new();
    for r in rows.iter().skip(1) {
        add(&mut counts, st(r.idx).unwrap_or("waiting"));
    }
    let mut groups = Vec::new();
    let mut loose_total = 0;
    let mut loose_counts = Map::new();
    let mut rounds: Vec<Value> = Vec::new();
    let mut round_ids: Vec<String> = Vec::new();
    for r in rows.iter().filter(|r| r.depth == 1) {
        let t = list.at(r.idx);
        if is_sub(t) {
            continue;
        }
        let inside = below(&t.id);
        let grouping = matches!(t.kind.as_deref(), Some("group" | "round"));
        if inside.is_empty() && !grouping {
            loose_total += 1;
            add(&mut loose_counts, st(r.idx).unwrap_or("waiting"));
            continue;
        }
        let mut c = Map::new();
        let tasks: Vec<usize> = inside.iter().copied().filter(|i| task_ids.contains(i)).collect();
        for &k in &tasks {
            if let Some(s) = st(k) {
                add(&mut c, s);
            }
        }
        let all_settled = inside.iter().all(|&k| st(k).is_some_and(settled));
        groups.push(json!({ "id": t.id, "title": t.title, "kind": t.get("kind").cloned().unwrap_or(Value::Null), "total": tasks.len(), "counts": c, "settled": all_settled }));
        let tests: Vec<usize> = inside.iter().copied().filter(|&k| list.at(k).kind.as_deref() == Some("test")).collect();
        if t.kind.as_deref() == Some("round") || (!tests.is_empty() && tests.len() == inside.len()) {
            let verdicts: Vec<&str> = tests.iter().map(|&k| st(k).unwrap_or("waiting")).collect();
            rounds.push(json!({
                "id": t.id, "title": t.title,
                "passed": verdicts.iter().filter(|s| **s == "passed").count(),
                "problem": verdicts.iter().filter(|s| **s == "problem").count(),
                "open": verdicts.iter().filter(|s| !settled(s)).count(),
            }));
            round_ids.push(t.id.clone());
        }
    }
    let newest = round_ids.last().cloned();
    let own: Vec<usize> = rows.iter().map(|r| r.idx).filter(|&i| !is_sub(list.at(i))).collect();
    let mut results: Vec<(String, String, String)> = Vec::new();
    for &i in &own {
        if let Some(Value::Array(rs)) = list.at(i).get("results") {
            for r in rs {
                let s = |k: &str| or_empty(r.get(k));
                results.push((s("at"), s("ticketId"), s("summary")));
            }
        }
    }
    results.sort_by(|a, b| crate::runs::js::locale_compare(&a.0, &b.0));
    let results: Vec<(String, String)> = results.into_iter().map(|(_, id, s)| (id, s)).collect();
    let mut round_of: HashMap<usize, String> = HashMap::new();
    for g in &round_ids {
        for k in below(g) {
            round_of.insert(k, g.clone());
        }
    }
    let rest = || own.iter().copied().skip(1);
    let broken: Vec<Value> = rest()
        .filter(|&i| {
            let s = st(i);
            s == Some("failed") || (s == Some("problem") && round_of.get(&i).is_none_or(|g| Some(g) == newest.as_ref()))
        })
        .map(|i| {
            let t = list.at(i);
            let mut m = Map::new();
            m.insert("id".into(), t.id.clone().into());
            m.insert("title".into(), t.title.clone().into());
            m.insert("state".into(), st(i).unwrap_or("waiting").into());
            if let Some(r) = broken_reason(t, &results) {
                m.insert("reason".into(), r.into());
            }
            Value::Object(m)
        })
        .collect();
    let paused: Vec<Value> = rest()
        .filter(|&i| st(i) == Some("paused") && !matches!(list.at(i).status.as_str(), "ready" | "in_progress"))
        .map(|i| {
            let t = list.at(i);
            let limit = t.get("limit");
            let reset = limit.and_then(|l| l.get("resetAt")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null);
            let auto = ckanban_core::jsnum::truthy(limit.and_then(|l| l.get("auto")));
            json!({ "id": t.id, "title": t.title, "resumeAt": reset, "auto": auto })
        })
        .collect();
    let waiting: Vec<Value> = rest().filter(|&i| st(i) == Some("needs_you")).map(|i| json!({ "id": list.at(i).id, "title": list.at(i).title })).collect();
    let mut prs = Vec::new();
    for &i in &own {
        let t = list.at(i);
        for p in ticket_prs(&Value::Object(t.json.clone())) {
            let url = or_empty(p.get("url"));
            let state = match p.get("state") {
                Some(Value::String(s)) => s.to_lowercase(),
                _ => "unknown".into(),
            };
            let mut m = Map::new();
            m.insert("url".into(), url.clone().into());
            m.insert("number".into(), pr_number(&url));
            m.insert("state".into(), state.into());
            m.insert("ticketId".into(), t.id.clone().into());
            m.insert("ticketTitle".into(), t.title.clone().into());
            if let Some(n) = pr_notes.get(&url).filter(|n| ckanban_core::jsnum::truthy(Some(n))) {
                m.insert("note".into(), n.clone());
            }
            prs.push(Value::Object(m));
        }
    }
    let subs: Vec<Value> = rows
        .iter()
        .filter(|r| is_sub(list.at(r.idx)))
        .map(|r| {
            let t = list.at(r.idx);
            let mut m = Map::new();
            m.insert("id".into(), t.id.clone().into());
            m.insert("title".into(), t.title.clone().into());
            m.insert("state".into(), st(r.idx).unwrap_or("waiting").into());
            let head = sub_facts.get(&r.idx).and_then(|f| f.headline.as_deref()).map(js_trim).unwrap_or("");
            if !head.is_empty() {
                m.insert("headline".into(), clip(&squash_spaces(head), 160).into());
            }
            Value::Object(m)
        })
        .collect();
    let mut out = Map::new();
    out.insert("size".into(), rows.len().into());
    out.insert("counts".into(), Value::Object(counts));
    out.insert("groups".into(), Value::Array(groups));
    out.insert("loose".into(), json!({ "total": loose_total, "counts": loose_counts }));
    out.insert("rounds".into(), Value::Array(rounds));
    out.insert("broken".into(), Value::Array(broken));
    out.insert("paused".into(), Value::Array(paused));
    out.insert("needsYou".into(), Value::Array(waiting));
    out.insert("prs".into(), Value::Array(prs));
    if !subs.is_empty() {
        out.insert("subFeatures".into(), Value::Array(subs));
    }
    out
}

/// `STATE_WORDS`.
pub fn state_word(s: &str) -> &'static str {
    match s {
        "waiting" => "Waiting",
        "working" => "Working",
        "done" => "Done",
        "passed" => "Passed",
        "problem" => "Found a problem",
        "failed" => "Failed",
        "needs_you" => "Needs you",
        "in_review" => "In review",
        "paused" => "Paused",
        _ => "undefined",
    }
}

fn n(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}
fn js(x: f64) -> String {
    ckanban_core::jsnum::js_string(x)
}

fn count_words(c: &Map<String, Value>, total: f64) -> String {
    let done = n(c.get("done")) + n(c.get("passed")) + n(c.get("problem"));
    let mut parts = vec![format!("{} of {} done", js(done), js(total))];
    for s in ["working", "waiting", "needs_you", "in_review", "failed", "paused"] {
        let k = n(c.get(s));
        if k != 0.0 {
            let word = if s == "needs_you" { "need you".to_string() } else { state_word(s).to_lowercase() };
            parts.push(format!("{} {word}", js(k)));
        }
    }
    parts.join(", ")
}

/// `changesLabel`.
pub fn changes_label(kind: &str) -> &'static str {
    if kind == "history" { "Saved changes (newest first; undo in this order)" } else { "Files changed in your folder" }
}

fn item_text(i: &Value) -> String {
    match i.get("id").filter(|v| ckanban_core::jsnum::truthy(Some(v))) {
        Some(id) => format!("{} {}", or_empty(Some(id)), or_empty(i.get("text"))),
        None => or_empty(i.get("text")),
    }
}

/// `savedChangesMarkdown`: the full list for SAVED_CHANGES_FILE.
pub fn saved_changes_markdown(title: &str, c: &Value) -> String {
    let mut lines = vec![format!("# {}: {title}", changes_label(c.get("kind").and_then(Value::as_str).unwrap_or(""))), String::new()];
    for i in c.get("items").and_then(Value::as_array).into_iter().flatten() {
        lines.push(format!("- {}", item_text(i)));
    }
    lines.push(String::new());
    lines.join("\n")
}

fn s_of<'a>(saved: Option<&'a Map<String, Value>>, k: &str) -> Option<&'a str> {
    saved.and_then(|s| s.get(k)).and_then(Value::as_str)
}

/// `statusSections`: the block's sections as (key, label, text), in order; empty ones left out.
pub fn status_sections(saved: Option<&Map<String, Value>>, f: &Map<String, Value>) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut push = |key: &str, label: &str, parts: &[Option<String>]| {
        let text = parts.iter().flatten().filter(|p| !js_trim(p).is_empty()).cloned().collect::<Vec<_>>().join(" ");
        if !text.is_empty() {
            out.push((key.to_string(), label.to_string(), text));
        }
    };
    let arr = |k: &str| f.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (groups, rounds) = (arr("groups"), arr("rounds"));
    let round = |id: &Value| rounds.iter().find(|r| r.get("id") == Some(id)).cloned();
    let s = |v: &Value, k: &str| or_empty(v.get(k));
    push("goal", "Goal", &[s_of(saved, "goal").map(str::to_string)]);
    let mut done_facts: Vec<String> = groups
        .iter()
        .filter(|g| g.get("settled") == Some(&Value::Bool(true)) && n(g.get("total")) != 0.0)
        .map(|g| match round(&g["id"]) {
            Some(r) => {
                let problem = n(r.get("problem"));
                let more = if problem != 0.0 { format!(", {} found a problem", js(problem)) } else { String::new() };
                format!("{} ({} passed{more})", s(g, "title"), js(n(r.get("passed"))))
            }
            None => format!("{} ({} done)", s(g, "title"), js(n(g.get("total")))),
        })
        .collect();
    let loose = f.get("loose").cloned().unwrap_or(Value::Null);
    let lc = loose.get("counts").and_then(Value::as_object).cloned().unwrap_or_default();
    let loose_done = n(lc.get("done")) + n(lc.get("passed")) + n(lc.get("problem"));
    if loose_done != 0.0 {
        done_facts.push(format!("{} other ticket{} done", js(loose_done), if loose_done == 1.0 { "" } else { "s" }));
    }
    let bracket = |xs: &[String], sep: &str| (!xs.is_empty()).then(|| format!("[{}]", xs.join(sep)));
    push("done", "Done", &[bracket(&done_facts, "; "), s_of(saved, "done").map(str::to_string)]);
    let mut running: Vec<String> = groups
        .iter()
        .filter(|g| g.get("settled") != Some(&Value::Bool(true)) && n(g.get("total")) != 0.0)
        .map(|g| {
            let counts = g.get("counts").and_then(Value::as_object).cloned().unwrap_or_default();
            let tail = match round(&g["id"]) {
                Some(r) if n(r.get("passed")) != 0.0 || n(r.get("problem")) != 0.0 => {
                    format!(" ({} passed, {} found a problem)", js(n(r.get("passed"))), js(n(r.get("problem"))))
                }
                _ => String::new(),
            };
            format!("{}: {}{tail}.", s(g, "title"), count_words(&counts, n(g.get("total"))))
        })
        .collect();
    if ["working", "waiting", "needs_you", "in_review", "paused"].iter().any(|x| n(lc.get(*x)) != 0.0) {
        running.push(format!("Other tickets: {}.", count_words(&lc, n(loose.get("total")))));
    }
    push("running", "Running", &[Some(running.join(" "))]);
    let subs: Vec<String> = arr("subFeatures")
        .iter()
        .map(|x| {
            let head = x.get("headline").and_then(Value::as_str).filter(|h| !h.is_empty()).map(|h| format!(" · {h}")).unwrap_or_default();
            format!("{}: {}{head}", s(x, "title"), state_word(&s(x, "state")))
        })
        .collect();
    push("subfeatures", "Sub-features", &[Some(subs.join("\n"))]);
    let broken = arr("broken");
    let broken_facts = (!broken.is_empty()).then(|| {
        let items: Vec<String> = broken
            .iter()
            .map(|b| {
                let reason = b.get("reason").and_then(Value::as_str).filter(|r| !r.is_empty()).map(|r| format!(": {r}")).unwrap_or_default();
                format!("{} ({}{reason})", s(b, "title"), state_word(&s(b, "state")).to_lowercase())
            })
            .collect();
        format!("[{}: {}]", broken.len(), items.join("; "))
    });
    push("broken", "Broken", &[broken_facts, s_of(saved, "broken").map(str::to_string)]);
    let you = arr("needsYou");
    let you_facts = (!you.is_empty()).then(|| format!("[{}: {}]", you.len(), you.iter().map(|b| s(b, "title")).collect::<Vec<_>>().join("; ")));
    push("waiting", "Waiting on you", &[you_facts, s_of(saved, "waiting").map(str::to_string)]);
    let prs: Vec<String> = arr("prs")
        .iter()
        .map(|p| {
            let num = match p.get("number") {
                Some(Value::Number(x)) => format!("#{x}"),
                _ => s(p, "url"),
            };
            let note = p.get("note").and_then(Value::as_str).filter(|x| !x.is_empty()).map(|x| format!(" · {x}")).unwrap_or_default();
            format!("{num} {} · {}{note}", s(p, "ticketTitle"), s(p, "state"))
        })
        .collect();
    push("prs", "Pull requests", &[Some(prs.join("\n"))]);
    let ms: Vec<Value> = saved.and_then(|x| x.get("milestones")).and_then(Value::as_array).cloned().unwrap_or_default();
    let ms: Vec<String> = ms[ms.len().saturating_sub(5)..]
        .iter()
        .map(|m| format!("{}: {} ({})", slice16(&s(m, "at"), 10), s(m, "summary"), s(m, "landed")))
        .collect();
    push("milestones", "Milestones landed", &[Some(ms.join("\n"))]);
    if let Some(c) = f.get("changes").filter(|c| c.get("items").and_then(Value::as_array).is_some_and(|i| !i.is_empty())) {
        let items = c["items"].as_array().cloned().unwrap_or_default();
        let mut shown: Vec<String> = items.iter().take(CHANGES_SHOWN).map(item_text).collect();
        let more = items.len().saturating_sub(shown.len());
        if more > 0 {
            let file = c.get("file").and_then(Value::as_str).filter(|x| !x.is_empty()).map(|x| format!(": the full list is in {x}")).unwrap_or_default();
            shown.push(format!("…and {more} more{file}"));
        }
        push("changes", changes_label(c.get("kind").and_then(Value::as_str).unwrap_or("")), &[Some(shown.join("\n"))]);
    }
    push("next", "Next step", &[s_of(saved, "next").map(str::to_string)]);
    out
}

/// `statusMarkdown`: status.md.
pub fn status_markdown(id: &str, title: &str, saved: Option<&Map<String, Value>>, f: &Map<String, Value>) -> String {
    let updated = saved.and_then(|s| s.get("updatedAt")).map(|v| or_empty(Some(v))).unwrap_or_else(|| "never".into());
    let size = f.get("size").map(|v| or_empty(Some(v))).unwrap_or_default();
    let mut lines = vec![format!("# Where we are: {title}"), String::new(), format!("Feature ticket {id}, {size} tickets. Updated {updated}."), String::new()];
    for (key, label, text) in status_sections(saved, f) {
        lines.push(format!("## {label}"));
        lines.push(String::new());
        let listed = matches!(key.as_str(), "prs" | "milestones" | "changes" | "subfeatures");
        lines.push(if listed { text.split('\n').map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n") } else { text });
        lines.push(String::new());
    }
    if let Some(notes) = saved.and_then(|s| s.get("notes")).and_then(Value::as_array).filter(|n| !n.is_empty()) {
        lines.push("## Notes from the user".into());
        lines.push(String::new());
        for n in notes {
            lines.push(format!("- {}: {}", slice16(&or_empty(n.get("at")), 10), or_empty(n.get("text"))));
        }
        lines.push(String::new());
    }
    lines.push(
        "Counts, test results, pull requests and saved changes come from the board (counts in [brackets]); the rest is written with update_status."
            .into(),
    );
    lines.push(String::new());
    lines.join("\n")
}

/// `writeStatus`: status.json (only with saved and write_json) and status.md (only when it changed); the markdown.
pub fn write_status(dir: &Path, id: &str, title: &str, saved: Option<&Map<String, Value>>, f: &Map<String, Value>, write_json: bool) -> std::io::Result<String> {
    if let (true, Some(saved)) = (write_json, saved) {
        let text = ckanban_core::datafile::to_text(&Value::Object(saved.clone()), ckanban_core::datafile::Layout::Indent(2));
        let tmp = dir.join("status.json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, status_json(dir))?;
    }
    let text = status_markdown(id, title, saved, f);
    let old = std::fs::read_to_string(status_md(dir)).unwrap_or_default();
    if old != text {
        std::fs::write(status_md(dir), &text)?;
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_text_cuts_at_a_word() {
        assert_eq!(clip_text("short", 100), "short");
        let long = "word ".repeat(30);
        let c = clip_text(&long, 40);
        assert!(c.ends_with(CUT_SHORT));
        assert!(len16(&c) <= 40);
        assert_eq!(c, format!("word word word word word{CUT_SHORT}"));
    }

    #[test]
    fn patch_keeps_key_order_and_clears() {
        let mut saved = Map::new();
        saved.insert("goal".into(), "g".into());
        saved.insert("updatedAt".into(), "old".into());
        saved.insert("done".into(), "d".into());
        let p = vec![("done".to_string(), None), ("next".to_string(), Some(" n ".to_string()))];
        let next = apply_patch(Some(saved), &p, None, "now", "sig");
        assert_eq!(serde_json::to_string(&next).unwrap(), r#"{"goal":"g","updatedAt":"now","claudeAt":"now","familySig":"sig","next":"n"}"#);
    }
}
