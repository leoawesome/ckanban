//! Subagents Claude starts with the Agent (older: Task) tool, ported from `src/runs/subagents.ts`: their own
//! transcripts (`<session>/subagents/agent-<id>.jsonl`), background task notifications and the stale-row rule.
//!
//! An `AgentInfo`, `AgentStep` and `AgentTranscript` are JSON objects with Bun's keys in Bun's order.

use super::Obj;
use super::js;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// `AGENT_TOOL.test(name)`: `/^(?:Agent|Task)$/`.
pub fn is_agent_tool(name: &str) -> bool {
    name == "Agent" || name == "Task"
}

const TOOL_ARG_KEYS: [&str; 7] = ["file_path", "command", "url", "pattern", "query", "description", "prompt"];

/// `String(v)` with undefined as "undefined".
fn js_str_opt(v: Option<&Value>) -> String {
    v.map(js::string).unwrap_or_else(|| "undefined".into())
}

/// `toolLabel(block)`: "Name: first line of its main argument" (120 units at most), else the name.
pub fn tool_label(block: &Value) -> String {
    let input = block.get("input").filter(|v| !v.is_null());
    let arg = input
        .and_then(Value::as_object)
        .and_then(|o| TOOL_ARG_KEYS.iter().find_map(|k| o.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty())))
        .map(|s| js::cut16(s.split('\n').next().unwrap_or(""), 120).to_string())
        .unwrap_or_default();
    let name = js_str_opt(block.get("name"));
    if arg.is_empty() { name } else { format!("{name}: {arg}") }
}

/// Intermediate messages are clipped: the row is a progress view, the full report shows as the result.
const STEP_TEXT_MAX: usize = 600;

/// `parseAgentTranscript(raw)`: `{ steps, current, final, startedAt, lastAt }`.
pub fn parse_agent_transcript(raw: &str) -> Value {
    let mut steps: Vec<Obj> = Vec::new();
    // A JS Map: insertion order kept, a set on a known key keeps its place.
    let mut open: Vec<(String, String)> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut final_: Option<String> = None;
    let mut started_at: Option<String> = None;
    let mut last_at: Option<String> = None;
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(at) = ev.get("timestamp").and_then(Value::as_str) {
            if started_at.is_none() {
                started_at = Some(at.to_string());
            }
            last_at = Some(at.to_string());
        }
        let Some(content) = js::at(&ev, &["message", "content"]).and_then(Value::as_array) else { continue };
        let ty = ev.get("type").and_then(Value::as_str);
        if ty == Some("user") {
            for b in content {
                if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(id) = b.get("tool_use_id").and_then(Value::as_str) else { continue };
                open.retain(|(k, _)| k != id);
                if let Some(&i) = by_id.get(id)
                    && js::truthy(b.get("is_error"))
                {
                    steps[i].insert("error".into(), Value::Bool(true));
                }
            }
            continue;
        }
        if ty != Some("assistant") {
            continue;
        }
        let ended = js::at(&ev, &["message", "stop_reason"]).and_then(Value::as_str) == Some("end_turn");
        final_ = None;
        for b in content {
            match b.get("type").and_then(Value::as_str) {
                Some("tool_use") => {
                    let label = tool_label(b);
                    let mut step = Obj::new();
                    step.insert("kind".into(), json!("tool"));
                    step.insert("text".into(), json!(label));
                    if let Some(id) = b.get("id").and_then(Value::as_str) {
                        step.insert("id".into(), json!(id));
                        by_id.insert(id.to_string(), steps.len());
                        match open.iter_mut().find(|(k, _)| k == id) {
                            Some(slot) => slot.1 = label,
                            None => open.push((id.to_string(), label)),
                        }
                    }
                    steps.push(step);
                }
                Some("text") => {
                    let Some(t) = b.get("text").and_then(Value::as_str) else { continue };
                    let text = js::trim(t);
                    if text.is_empty() {
                        continue;
                    }
                    if ended {
                        final_ = Some(text.to_string());
                    } else {
                        let text = if js::len16(text) > STEP_TEXT_MAX {
                            format!("{}…", js::cut16(text, STEP_TEXT_MAX))
                        } else {
                            text.to_string()
                        };
                        let mut step = Obj::new();
                        step.insert("kind".into(), json!("text"));
                        step.insert("text".into(), json!(text));
                        steps.push(step);
                    }
                }
                _ => {}
            }
        }
    }
    json!({
        "steps": steps.into_iter().map(Value::Object).collect::<Vec<_>>(),
        "current": open.last().map(|(_, l)| l.clone()),
        "final": final_,
        "startedAt": started_at,
        "lastAt": last_at,
    })
}

/// JS `mtimeMs`: `sec * 1e3 + nsec / 1e6`.
pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    meta.mtime() as f64 * 1e3 + meta.mtime_nsec() as f64 / 1e6
}

/// The `${size}:${mtimeMs}` key a file is cached under.
pub(crate) fn file_key(meta: &fs::Metadata) -> String {
    format!("{}:{}", meta.len(), ckanban_core::jsnum::js_string(mtime_ms(meta)))
}

/// `readdirSync(dir)` names (OS order), None when the folder can't be read.
pub(crate) fn read_names(dir: &Path) -> Option<Vec<String>> {
    let rd = fs::read_dir(dir).ok()?;
    Some(rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
}

/// `readFileSync(file, "utf8")`.
pub(crate) fn read_text(file: &Path) -> Option<String> {
    fs::read(file).ok().map(|b| String::from_utf8(b).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

/// `sessionFile.replace(/\.jsonl$/, "")`.
pub(crate) fn session_base(session_file: &Path) -> PathBuf {
    let s = session_file.to_string_lossy();
    PathBuf::from(s.strip_suffix(".jsonl").unwrap_or(&s).to_string())
}

fn subagents_dir(session_file: &Path) -> PathBuf {
    session_base(session_file).join("subagents")
}

struct Cached {
    key: String,
    tool_use_id: Option<String>,
    transcript: Value,
}

/// Reads a session's subagent transcripts (`<session dir>/subagents/agent-<id>.jsonl` + `.meta.json` naming the
/// parent's tool_use id), re-parsing a file only when its size/mtime change.
#[derive(Default)]
pub struct SubagentCache {
    files: Mutex<HashMap<PathBuf, Cached>>,
}

impl SubagentCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Cheap change marker for the subagents folder of a session file ("" when there is none).
    pub fn version(&self, session_file: &Path) -> String {
        let dir = subagents_dir(session_file);
        let Some(names) = read_names(&dir) else { return String::new() };
        let (mut size, mut mtime, mut n) = (0u64, 0f64, 0u32);
        for name in names {
            if !name.ends_with(".jsonl") {
                continue;
            }
            if let Ok(s) = fs::metadata(dir.join(&name)) {
                size += s.len();
                mtime = mtime.max(mtime_ms(&s));
                n += 1;
            }
        }
        if n == 0 { String::new() } else { format!("{n}:{size}:{}", ckanban_core::jsnum::js_string(mtime)) }
    }

    /// Transcripts by the parent's tool_use id.
    pub fn load(&self, session_file: &Path) -> HashMap<String, Value> {
        let dir = subagents_dir(session_file);
        let mut out = HashMap::new();
        let Some(names) = read_names(&dir) else { return out };
        let mut files = self.files.lock();
        for name in names {
            if !name.ends_with(".jsonl") {
                continue;
            }
            let file = dir.join(&name);
            let Ok(s) = fs::metadata(&file) else { continue };
            let key = file_key(&s);
            let fresh = matches!(files.get(&file), Some(h) if h.key == key && h.tool_use_id.is_some());
            if !fresh {
                let Some(raw) = read_text(&file) else { continue };
                let meta = dir.join(format!("{}.meta.json", name.strip_suffix(".jsonl").unwrap_or(&name)));
                let hit = Cached { key, tool_use_id: read_tool_use_id(&meta), transcript: parse_agent_transcript(&raw) };
                files.insert(file.clone(), hit);
            }
            let hit = &files[&file];
            if let Some(id) = &hit.tool_use_id {
                out.insert(id.clone(), hit.transcript.clone());
            }
        }
        out
    }
}

/// A session's subagent transcript files, workflow agents' included (empty when there are none).
pub fn subagent_files(session_file: &Path) -> Vec<PathBuf> {
    let dir = subagents_dir(session_file);
    let list = |d: &Path| -> Vec<PathBuf> {
        read_names(d)
            .unwrap_or_default()
            .into_iter()
            .filter(|n| n.ends_with(".jsonl") && n != "journal.jsonl")
            .map(|n| d.join(n))
            .collect()
    };
    let runs = dir.join("workflows");
    let ids = read_names(&runs).unwrap_or_default();
    let mut out = list(&dir);
    for id in ids {
        out.extend(list(&runs.join(id)));
    }
    out
}

fn read_tool_use_id(meta_file: &Path) -> Option<String> {
    let raw = read_text(meta_file)?;
    let meta: Value = serde_json::from_str(&raw).ok()?;
    meta.get("toolUseId").and_then(Value::as_str).map(str::to_string)
}

fn str_gt(a: &str, b: Option<&Value>) -> bool {
    matches!(b, Some(Value::String(b)) if a > b.as_str())
}

/// The parent's view of an agent, filled in with what its own transcript shows.
pub fn with_transcript(a: &Obj, t: Option<&Value>) -> Obj {
    let Some(t) = t else { return a.clone() };
    let mut out = a.clone();
    let steps = t.get("steps").cloned().unwrap_or(Value::Array(vec![]));
    let n = steps.as_array().map_or(0, Vec::len);
    out.insert("steps".into(), steps);
    out.insert("stepCount".into(), json!(n));
    let last_at = t.get("lastAt").and_then(Value::as_str).filter(|s| !s.is_empty());
    if let Some(l) = last_at
        && str_gt(l, out.get("updatedAt"))
    {
        out.insert("updatedAt".into(), json!(l));
    }
    let final_ = t.get("final").filter(|v| !v.is_null());
    let running = |o: &Obj| o.get("status").and_then(Value::as_str) == Some("running");
    if running(&out) && final_.is_some() && !js::truthy(t.get("current")) {
        out.insert("status".into(), json!("done"));
        out.insert("endedAt".into(), t.get("lastAt").cloned().unwrap_or(Value::Null));
    }
    if running(&out) {
        out.insert("current".into(), t.get("current").cloned().unwrap_or(Value::Null));
    }
    if !js::truthy(out.get("result")) && out.get("status").and_then(Value::as_str) == Some("done") {
        out.insert("result".into(), t.get("final").cloned().unwrap_or(Value::Null));
    }
    out
}

static NOTE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<tool-use-id>([^<]+)</tool-use-id>").unwrap());
static NOTE_STATUS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<status>([^<]+)</status>").unwrap());
static NOTE_RESULT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<result>(.*?)</result>").unwrap());

/// Background agents report back as a `<task-notification>` message to the parent: (toolUseId, status, result).
pub fn parse_task_notification(text: &str) -> Option<(String, String, Option<String>)> {
    if !text.contains("<task-notification>") {
        return None;
    }
    let id = NOTE_ID.captures(text)?.get(1)?.as_str().to_string();
    let status = NOTE_STATUS.captures(text)?.get(1)?.as_str().to_string();
    let result = NOTE_RESULT.captures(text).and_then(|c| c.get(1)).map(|m| js::trim(m.as_str()).to_string()).filter(|s| !s.is_empty());
    Some((id, status, result))
}

/// Status words in task notifications → the row's status.
pub fn notified_status(status: &str) -> &'static str {
    match status {
        "completed" => "done",
        "killed" | "stopped" => "stopped",
        _ => "failed",
    }
}

/// No word from a running agent for this long while the ticket isn't running: it was cut off.
pub const AGENT_STALE_MS: f64 = 60_000.0;

/// `Date.parse(String(v))` for a JSON value; None is NaN.
pub(crate) fn date_parse(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::String(s)) => ckanban_core::time::parse_date(s),
        None => None,
        Some(v) => ckanban_core::time::parse_date(&js::string(v)),
    }
}

/// Shown as stopped instead of spinning forever once its run is gone and it went quiet.
pub fn settle_agent(a: &Obj, run_active: bool, now_ms: f64) -> Obj {
    if a.get("status").and_then(Value::as_str) != Some("running") || run_active {
        return a.clone();
    }
    if let Some(last) = date_parse(a.get("updatedAt"))
        && now_ms - last < AGENT_STALE_MS
    {
        return a.clone();
    }
    let mut out = a.clone();
    out.insert("status".into(), json!("stopped"));
    out.insert("current".into(), Value::Null);
    out
}

/// Steps a chat row gets up front; the rest load on "show all".
pub const AGENT_STEP_TAIL: usize = 20;
