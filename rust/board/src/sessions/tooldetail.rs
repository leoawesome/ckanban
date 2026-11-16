//! One tool call in full for the chat's expanded tool rows, ported from `src/chat/tooldetail.ts`:
//! `{ id, name, input, output, isError, truncated }`.

use super::js;
use super::subagents::read_text;
use ckanban_core::jsnum::normalize;
use serde_json::{Value, json};
use std::path::PathBuf;

/// Same cap as the terminal transcript view (UTF-16 units).
pub const TOOL_OUTPUT_MAX: usize = 8000;

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|c| match c {
                Value::String(s) => s.clone(),
                Value::Object(o) => match o.get("type").and_then(Value::as_str) {
                    Some("text") => js::string_or_empty(o.get("text")),
                    Some("image") => "[image]".into(),
                    _ => String::new(),
                },
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Finds a tool call and its result in a session (or subagent) transcript; None when the id isn't there.
pub fn find_tool_detail(raw: &str, tool_use_id: &str) -> Option<Value> {
    let mut detail: Option<serde_json::Map<String, Value>> = None;
    let needle = serde_json::to_string(tool_use_id).unwrap_or_default();
    for line in raw.split('\n') {
        // Cheap skip: only lines mentioning the id can hold its call or result.
        if !line.contains(&needle) {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        let Some(content) = js::at(&ev, &["message", "content"]).and_then(Value::as_array) else { continue };
        for b in content {
            let ty = b.get("type").and_then(Value::as_str);
            if ty == Some("tool_use") && b.get("id").and_then(Value::as_str) == Some(tool_use_id) && detail.is_none() {
                // Only the first copy: newer transcripts repeat earlier tool_use blocks after the result.
                let input = match b.get("input") {
                    Some(v @ (Value::Object(_) | Value::Array(_))) => normalize(v.clone()),
                    _ => json!({}),
                };
                let name = match b.get("name") {
                    None | Some(Value::Null) => "tool".to_string(),
                    Some(v) => js::string(v),
                };
                let mut d = serde_json::Map::new();
                d.insert("id".into(), json!(tool_use_id));
                d.insert("name".into(), json!(name));
                d.insert("input".into(), input);
                d.insert("output".into(), Value::Null);
                d.insert("isError".into(), json!(false));
                d.insert("truncated".into(), json!(false));
                detail = Some(d);
            } else if ty == Some("tool_result")
                && b.get("tool_use_id").and_then(Value::as_str) == Some(tool_use_id)
                && let Some(d) = detail.as_mut()
            {
                let text = result_text(b.get("content"));
                let truncated = js::len16(&text) > TOOL_OUTPUT_MAX;
                d.insert("isError".into(), json!(b.get("is_error") == Some(&Value::Bool(true))));
                d.insert("truncated".into(), json!(truncated));
                d.insert("output".into(), json!(if truncated { js::cut16(&text, TOOL_OUTPUT_MAX) } else { &text }));
            }
        }
    }
    detail.map(Value::Object)
}

/// Looks through files in order (the session, then its subagents' transcripts).
pub fn find_tool_detail_in(files: &[PathBuf], tool_use_id: &str) -> Option<Value> {
    let needle = serde_json::to_string(tool_use_id).unwrap_or_default();
    for f in files {
        let Some(raw) = read_text(f) else { continue };
        if !raw.contains(&needle) {
            continue;
        }
        if let Some(d) = find_tool_detail(&raw, tool_use_id) {
            return Some(d);
        }
    }
    None
}
