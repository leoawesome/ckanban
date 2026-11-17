//! A huddle participant's own Claude session, read-only, for the Huddle tab's session viewer
//! (`src/huddle/huddle-session.ts`): what the helper thought, the tools it ran and what it posted, from its transcript
//! (found by its session id; it stays after the huddle closes). Also the `huddle.session` events that tell an open
//! viewer to refetch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::agents::Agents;
use super::model::*;
use super::service::{Huddles, R, SessionQuery};
use crate::team::Fail;

/// Longest text step sent (`STEP_TEXT_MAX`); the transcript has the rest.
pub const STEP_TEXT_MAX: usize = 4000;
const OUT_MAX: usize = 140;
/// Steps per page (`SESSION_PAGE`).
pub const SESSION_PAGE: f64 = 200.0;
/// Huddles closed this recently are still watched: a helper's last lines land just after the close stops it.
const CLOSED_GRACE_MS: f64 = 2.0 * 60_000.0;

fn clip(s: &str, n: usize) -> String {
    if crate::prompts::js::len16(s) > n { format!("{}…", crate::prompts::js::slice16(s, n - 1)) } else { s.to_string() }
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|c| match c {
                Value::String(s) => s.clone(),
                _ => match c.get("type").and_then(Value::as_str) {
                    Some("text") => c.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
                    Some("image") => "[image]".into(),
                    _ => String::new(),
                },
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `outputSummary`: a tool output in a few words: its only line, else how many lines (an error: its first line).
pub fn output_summary(text: &str, error: bool) -> String {
    let lines: Vec<&str> = text.split('\n').map(crate::prompts::js::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return if error { "error".into() } else { "no output".into() };
    }
    if lines.len() == 1 || error {
        return clip(lines[0], OUT_MAX);
    }
    format!("{} lines", lines.len())
}

/// A parsed session (`ParsedHuddleSession`): its steps as JSON objects in Bun's key order.
#[derive(Default, Clone)]
pub struct Parsed {
    pub steps: Vec<Map<String, Value>>,
    pub started_at: Option<String>,
    pub last_at: Option<String>,
}

fn is_post_tool(name: &str) -> bool {
    name == "huddle_post" || name.ends_with("__huddle_post")
}

/// `parseHuddleSession`.
pub fn parse_huddle_session(raw: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let push = |out: &mut Parsed, kind: &str, text: String, at: &Option<String>, pending: bool| -> usize {
        let mut m = Map::new();
        m.insert("i".into(), json!(out.steps.len()));
        m.insert("kind".into(), kind.into());
        m.insert("text".into(), text.into());
        m.insert("at".into(), at.clone().map(Value::from).unwrap_or(Value::Null));
        if pending {
            m.insert("pending".into(), true.into());
        }
        out.steps.push(m);
        out.steps.len() - 1
    };
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        let at = ev.get("timestamp").and_then(Value::as_str).map(str::to_string);
        if let Some(a) = &at {
            if out.started_at.is_none() {
                out.started_at = Some(a.clone());
            }
            out.last_at = Some(a.clone());
        }
        if crate::team::jsv::truthy(ev.get("isSidechain")) || crate::team::jsv::truthy(ev.get("isMeta")) {
            continue;
        }
        let content = ev.get("message").and_then(|m| m.get("content"));
        let ty = ev.get("type").and_then(Value::as_str);
        if ty == Some("user") {
            let has_result = content.and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")));
            if matches!(content, Some(Value::String(_))) || (content.is_some_and(Value::is_array) && !has_result) {
                let text = match content {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a.iter().map(|b| if b.get("type").and_then(Value::as_str) == Some("text") { b.get("text").and_then(Value::as_str).unwrap_or("") } else { "" }).collect::<Vec<_>>().join("\n"),
                    _ => String::new(),
                };
                let t = crate::prompts::js::trim(&text);
                let lead = text.trim_start();
                if t.is_empty() || lead.starts_with('<') || lead.starts_with("[Request interrupted") || lead.starts_with("Caveat:") {
                    continue;
                }
                let woke = out.steps.iter().any(|s| s.get("kind").and_then(Value::as_str) == Some("wake"));
                push(&mut out, "wake", if woke { "Woke up with new huddle messages".into() } else { "Started on its job".into() }, &at, false);
                continue;
            }
            let Some(blocks) = content.and_then(Value::as_array) else { continue };
            for b in blocks {
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(&i) = b.get("tool_use_id").and_then(Value::as_str).and_then(|id| by_id.get(id)) else { continue };
                let step = &mut out.steps[i];
                step.shift_remove("pending");
                let text = result_text(b.get("content"));
                let err = crate::team::jsv::truthy(b.get("is_error"));
                if err {
                    step.insert("error".into(), true.into());
                }
                if step.get("kind").and_then(Value::as_str) == Some("post") {
                    let seq = regex::Regex::new(r"Posted #(\d+)").ok().and_then(|re| re.captures(&text).map(|c| c[1].to_string()));
                    if let Some(n) = seq.and_then(|n| n.parse::<f64>().ok()) {
                        step.insert("seq".into(), num(n));
                    } else if err {
                        step.insert("out".into(), output_summary(&text, true).into());
                    }
                } else {
                    step.insert("out".into(), output_summary(&text, err).into());
                }
            }
            continue;
        }
        let Some(blocks) = content.and_then(Value::as_array).filter(|_| ty == Some("assistant")) else { continue };
        for b in blocks {
            let bt = b.get("type").and_then(Value::as_str);
            if bt == Some("tool_use") {
                let name = b.get("name").map(|v| crate::team::jsv::js_string(Some(v))).unwrap_or_default();
                let i = if is_post_tool(&name) {
                    let text = b.get("input").and_then(|x| x.get("text")).map(|v| crate::team::jsv::js_string(Some(v))).unwrap_or_default();
                    push(&mut out, "post", clip(crate::prompts::js::trim(&text), STEP_TEXT_MAX), &at, true)
                } else {
                    push(&mut out, "tool", crate::sessions::subagents::tool_label(b), &at, true)
                };
                if let Some(id) = b.get("id").and_then(Value::as_str) {
                    out.steps[i].insert("id".into(), id.into());
                    by_id.insert(id.to_string(), i);
                }
            } else if matches!(bt, Some("text" | "thinking")) {
                let t = b.get("text").or_else(|| b.get("thinking")).and_then(Value::as_str);
                if let Some(t) = t {
                    let t = crate::prompts::js::trim(t);
                    if !t.is_empty() {
                        push(&mut out, "text", clip(t, STEP_TEXT_MAX), &at, false);
                    }
                }
            }
        }
    }
    out
}

/// Parsed sessions by file, read again only when the file's size or mtime change (`HuddleSessionCache`).
#[derive(Default)]
pub struct SessionCache {
    items: Mutex<HashMap<PathBuf, (String, Arc<Parsed>)>>,
}

impl SessionCache {
    pub fn get(&self, file: &Path) -> Option<Arc<Parsed>> {
        let m = std::fs::metadata(file).ok()?;
        let key = format!("{}:{:?}", m.len(), m.modified().ok());
        if let Some((k, p)) = self.items.lock().get(file)
            && *k == key
        {
            return Some(p.clone());
        }
        let raw = std::fs::read_to_string(file).ok()?;
        let parsed = Arc::new(parse_huddle_session(&raw));
        self.items.lock().insert(file.to_path_buf(), (key, parsed.clone()));
        Some(parsed)
    }
}

/// `participantSession`: newest last; `before` (a step index) pages back, `since` gives every step from that index on.
pub fn participant_session(a: &Agents, hs: &Huddles, slug: &str, hid: &str, handle: &str, q: &SessionQuery) -> R<Value> {
    let h = hs.get(slug, hid)?;
    let view = hs.view(slug, &h);
    let p = view.get("participants").and_then(Value::as_array).and_then(|ps| ps.iter().find(|p| p.get("handle").and_then(Value::as_str) == Some(handle))).cloned();
    let Some(Value::Object(p)) = p.filter(|p| p.get("kind").and_then(Value::as_str) != Some("human")) else {
        return Err(Fail::new(404, if handle == USER_HANDLE { "@you has no session".to_string() } else { format!("no participant @{handle}") }));
    };
    let agent = s(&p, "kind") == "agent";
    let sid = opt_s(&p, "sessionId").filter(|x| !x.is_empty());
    let file = match (agent, sid, &a.sessions) {
        (true, Some(id), Some(ss)) => ss.cache.file(id),
        _ => None,
    };
    let parsed = file.as_deref().and_then(|f| a.session_cache.get(f));
    let all: &[Map<String, Value>] = parsed.as_ref().map(|p| p.steps.as_slice()).unwrap_or(&[]);
    let limit = q.limit.unwrap_or(SESSION_PAGE).floor().clamp(1.0, 1000.0) as usize;
    let steps: &[Map<String, Value>] = match q.since {
        Some(since) => &all[(since.floor().max(0.0) as usize).min(all.len())..],
        None => {
            let end = q.before.map(|b| b.floor().clamp(0.0, all.len() as f64) as usize).unwrap_or(all.len());
            &all[end.saturating_sub(limit)..end]
        }
    };
    let live = agent && b(&p, "running") && s(&p, "status") == "working";
    let current = if live { all.iter().rev().find(|s| s.contains_key("pending")).and_then(|s| s.get("i").cloned()) } else { None };
    let model = if agent {
        p.get("model").filter(|m| !m.is_null()).cloned().or_else(|| a_profile_model(a, slug)).unwrap_or(Value::Null)
    } else {
        p.get("model").cloned().unwrap_or(Value::Null)
    };
    let first = steps.first().and_then(|s| s.get("i")).and_then(Value::as_u64).map(|x| x as usize).unwrap_or(all.len());
    Ok(json!({
        "handle": s(&p, "handle"),
        "kind": s(&p, "kind"),
        "role": p.get("role").cloned().unwrap_or(Value::Null),
        "model": model,
        "mode": p.get("mode").cloned().unwrap_or(Value::Null),
        "status": p.get("status").cloned().unwrap_or(Value::Null),
        "live": live,
        "costUsd": p.get("costUsd").filter(|c| !c.is_null()).cloned().unwrap_or(json!(0)),
        "sessionId": if agent { p.get("sessionId").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "snapshot": p.get("snapshot").cloned().unwrap_or(Value::Null),
        "ticketId": if s(&p, "kind") == "ticket-main" { p.get("ticketId").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "file": file.map(|f| f.to_string_lossy().to_string()),
        "steps": steps,
        "total": all.len(),
        "hasMore": first > 0,
        "current": current,
    }))
}

fn a_profile_model(a: &Agents, slug: &str) -> Option<Value> {
    a.board.profile(slug).and_then(|p| p.get("model").filter(|m| !m.is_null()).cloned())
}

/// `participantTool`: one full tool call of a participant's session; None when the session or the call isn't there.
pub fn participant_tool(a: &Agents, hs: &Huddles, slug: &str, hid: &str, handle: &str, tool: &str) -> R<Option<Value>> {
    let h = hs.get(slug, hid)?;
    let Some(p) = participant(&h, handle) else { return Err(Fail::new(404, format!("no participant @{handle}"))) };
    let sid = opt_s(p, "sessionId").filter(|x| !x.is_empty());
    Ok(match (s(p, "kind"), sid, &a.sessions) {
        ("agent", Some(id), Some(ss)) => ss.cache.tool_detail(id, tool),
        _ => None,
    })
}

/// `pollHuddleSessions`: one pass; a `huddle.session` event for each helper whose session changed since the last
/// pass (the first pass only takes note). Blocking (reads the huddle lists, stats transcripts).
pub fn poll_sessions(hs: &Huddles, version: &dyn Fn(&str) -> Option<String>, state: &mut HashMap<String, String>, first: bool, now_ms: f64) {
    let mut seen = std::collections::HashSet::new();
    let boards: Vec<String> = std::fs::read_dir(hs.files.root().join("profiles"))
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    for slug in boards {
        for h in hs.files.index(&slug).iter() {
            if s(h, "status") == "closed" {
                let recent = opt_s(h, "closedAt").map(|c| ckanban_core::time::parse_date(c).unwrap_or(0.0)).is_some_and(|c| now_ms - c < CLOSED_GRACE_MS);
                if !recent {
                    continue;
                }
            }
            for p in participants(h) {
                let Some(sid) = opt_s(p, "sessionId").filter(|_| s(p, "kind") == "agent") else { continue };
                let key = format!("{slug}/{}/{}", s(h, "id"), s(p, "handle"));
                seen.insert(key.clone());
                let Some(v) = version(sid) else { continue };
                if state.get(&key) == Some(&v) {
                    continue;
                }
                let known = state.insert(key, v).is_some();
                if first && !known {
                    continue;
                }
                hs.emit_event(json!({ "type": "huddle.session", "profile": slug, "huddleId": s(h, "id"), "handle": s(p, "handle") }));
            }
        }
    }
    state.retain(|k, _| seen.contains(k));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_steps_posts_and_wakes() {
        let lines = [
            json!({ "type": "user", "timestamp": "t0", "message": { "content": "You just joined the huddle" } }),
            json!({ "type": "assistant", "timestamp": "t1", "message": { "content": [
                { "type": "thinking", "thinking": "Let me look" },
                { "type": "tool_use", "id": "a", "name": "Bash", "input": { "command": "ls\nmore" } },
                { "type": "tool_use", "id": "b", "name": "mcp__ckanban__huddle_post", "input": { "text": " Found it " } },
            ] } }),
            json!({ "type": "user", "timestamp": "t2", "message": { "content": [
                { "type": "tool_result", "tool_use_id": "a", "content": "one\ntwo" },
                { "type": "tool_result", "tool_use_id": "b", "content": [{ "type": "text", "text": "Posted #7" }] },
            ] } }),
            json!({ "type": "user", "timestamp": "t3", "message": { "content": "New huddle messages" } }),
        ];
        let raw = lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
        let p = parse_huddle_session(&raw);
        let kinds: Vec<&str> = p.steps.iter().map(|s| s["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["wake", "text", "tool", "post", "wake"]);
        assert_eq!(p.steps[0]["text"], "Started on its job");
        assert_eq!(p.steps[4]["text"], "Woke up with new huddle messages");
        assert_eq!(p.steps[2]["text"], "Bash: ls");
        assert_eq!(p.steps[2]["out"], "2 lines");
        assert!(!p.steps[2].contains_key("pending"));
        assert_eq!(p.steps[3]["text"], "Found it");
        assert_eq!(p.steps[3]["seq"], 7);
        assert_eq!(p.started_at.as_deref(), Some("t0"));
        assert_eq!(p.last_at.as_deref(), Some("t3"));
        assert_eq!(output_summary("", true), "error");
        assert_eq!(output_summary(" x \n", false), "x");
    }
}
