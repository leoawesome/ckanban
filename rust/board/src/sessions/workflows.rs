//! Workflows, ported from `src/runs/workflows.ts`: scripts Claude Code runs with the Workflow tool, each starting many
//! helper agents in phases. The parent transcript has the Workflow call, its launch result and a `<task-notification>`
//! when it ends; Claude Code writes the rest next to the session file:
//!   `<session>/subagents/workflows/<runId>/journal.jsonl`          launched / started / result
//!   `<session>/subagents/workflows/<runId>/agent-<agentId>.jsonl`  each helper agent's transcript
//!   `<session>/workflows/<runId>.json`                             written when the workflow ends
//!
//! A `WorkflowInfo`, `WorkflowAgent` and journal row are JSON objects with Bun's keys in Bun's order. A `WorkflowRun`
//! is `{ journal: [row], agents: { <agentId>: AgentFile }, summary }` (agents in folder order, like Bun's Map).

use super::Obj;
use super::js;
use super::subagents::{date_parse, file_key, mtime_ms, parse_agent_transcript, read_names, read_text, session_base};
use ckanban_core::jsnum::{js_string, normalize, num};
use ckanban_core::time::iso;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// `WORKFLOW_TOOL.test(name)`.
pub fn is_workflow_tool(name: &str) -> bool {
    name == "Workflow"
}

/// JS `\s` as a regex class.
const S: &str = r"[\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

static META_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"export{S}+const{S}+meta{S}*={S}*\{{")).unwrap());
static PHASES_AT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"phases{S}*:{S}*\[")).unwrap());

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// First match of `re` at or after `from` whose start has a JS (ASCII) `\b` before it (the pattern starts with a word
/// character), as `/\b.../.exec`.
fn find_word(re: &Regex, text: &str, mut from: usize) -> Option<(usize, usize)> {
    while from <= text.len() {
        let m = re.find_at(text, from)?;
        let ok = text[..m.start()].chars().next_back().is_none_or(|c| !is_word(c));
        if ok {
            return Some((m.start(), m.end()));
        }
        from = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
    }
    None
}

/// `\b<key>\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1` (flag s), searched from `from`: (match end, captured body).
fn quoted_after(text: &str, key: &str, from: usize) -> Option<(usize, String)> {
    // One compiled regex per key (a few fixed keys), kept: compiling one per call was most of a big transcript's parse.
    static KEYS: LazyLock<Mutex<HashMap<String, Regex>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    let re = KEYS
        .lock()
        .entry(key.to_string())
        .or_insert_with(|| Regex::new(&format!(r"{}{S}*:{S}*(['`\x22])", regex::escape(key))).unwrap())
        .clone();
    let mut at = from;
    loop {
        let (start, end) = find_word(&re, text, at)?;
        let q = text[end - 1..].chars().next().unwrap();
        if let Some(close) = quoted_body(text, end, q) {
            return Some((close + 1, text[end..close].to_string()));
        }
        at = start + 1;
    }
}

/// Where the body starting at `from` closes (the quote's index), with the regex's backtracking order: an escape pair
/// first, then a lone backslash. Positions that failed once fail again, so each is tried once.
fn quoted_body(text: &str, from: usize, q: char) -> Option<usize> {
    let mut failed = vec![false; text.len() + 1];
    // Depth-first with an explicit stack of positions still to try.
    let mut stack = vec![from];
    while let Some(p) = stack.pop() {
        if failed[p] {
            continue;
        }
        let Some(c) = text[p..].chars().next() else {
            failed[p] = true;
            continue;
        };
        if c == q {
            return Some(p);
        }
        let next = p + c.len_utf8();
        failed[p] = true;
        if c == '\\' && next < text.len() {
            let n2 = next + text[next..].chars().next().unwrap().len_utf8();
            stack.push(next); // tried second: the backslash alone
            stack.push(n2); // tried first: the escape pair
        } else {
            stack.push(next);
        }
    }
    None
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\\'
            && let Some(&n) = it.peek()
            && matches!(n, '\'' | '"' | '`' | '\\')
        {
            out.push(n);
            it.next();
            continue;
        }
        out.push(c);
    }
    out.replace("\\n", " ")
}

/// Index just past the bracket that closes the one at `from` (strings skipped); text.len() when it never closes.
fn bracket_end(text: &str, from: usize) -> usize {
    let mut depth = 0i64;
    let mut quote: Option<char> = None;
    let mut it = text[from..].char_indices();
    while let Some((i, c)) = it.next() {
        if let Some(q) = quote {
            if c == '\\' {
                it.next();
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' | '`' => quote = Some(c),
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return from + i + 1;
                }
            }
            _ => {}
        }
    }
    text.len()
}

/// `parseWorkflowMeta(script)`: name / description / phase titles from `export const meta = { ... }`.
pub fn parse_workflow_meta(script: &str) -> (Option<String>, Option<String>, Vec<String>) {
    let Some(m) = META_START.find(script) else { return (None, None, vec![]) };
    let open = m.start() + script[m.start()..].find('{').unwrap();
    let meta = &script[open..bracket_end(script, open)];
    let mut rest = meta.to_string();
    let mut list = "";
    if let Some((at, _)) = find_word(&PHASES_AT, meta, 0) {
        let from = at + meta[at..].find('[').unwrap();
        let end = bracket_end(meta, from);
        list = &meta[from..end];
        rest = format!("{}{}", &meta[..at], &meta[end..]);
    }
    let str_ = |key: &str| quoted_after(&rest, key, 0).map(|(_, s)| unescape(&s));
    let mut phases = vec![];
    let mut at = 0;
    while let Some((end, s)) = quoted_after(list, "title", at) {
        phases.push(unescape(&s));
        at = end;
    }
    (str_("name"), str_("description"), phases)
}

/// `parseWorkflowMeta` as Bun's object.
pub fn workflow_meta_json(script: &str) -> Value {
    let (name, description, phases) = parse_workflow_meta(script);
    json!({ "name": name, "description": description, "phases": phases })
}

/// The parent's view of a Workflow call, before its files are read.
pub fn workflow_from_call(tool_use_id: &str, input: &Value, at: &str) -> Obj {
    let script = input.get("script").and_then(Value::as_str);
    let (name, description, phases) = match script {
        Some(s) if !s.is_empty() => parse_workflow_meta(s),
        _ => (None, None, vec![]),
    };
    let named = input.get("name").and_then(Value::as_str).map(js::trim).filter(|s| !s.is_empty());
    let mut w = Obj::new();
    w.insert("toolUseId".into(), json!(tool_use_id));
    w.insert("runId".into(), Value::Null);
    w.insert("taskId".into(), Value::Null);
    w.insert("name".into(), json!(name.or(named.map(str::to_string)).unwrap_or_else(|| "Workflow".into())));
    w.insert("description".into(), json!(description.unwrap_or_default()));
    w.insert("phases".into(), json!(phases));
    w.insert("status".into(), json!("running"));
    w.insert("startedAt".into(), json!(at));
    w.insert("endedAt".into(), Value::Null);
    w.insert("updatedAt".into(), json!(at));
    w.insert("agents".into(), json!([]));
    w.insert("costUsd".into(), json!(0));
    w.insert("error".into(), Value::Null);
    w.insert("script".into(), json!(script));
    w.insert("scriptPath".into(), json!(input.get("scriptPath").and_then(Value::as_str)));
    w
}

static RUN_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Run ID: (wf_[A-Za-z0-9_-]+)").unwrap());
static TASK_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Task ID: ([A-Za-z0-9_]+)").unwrap());
static SUMMARY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Summary: ([^\n]+)").unwrap());
static SCRIPT_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Script file: ([^\n]+)").unwrap());
static TRANSCRIPT_DIR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Transcript dir: ([^\n]+)").unwrap());

fn group<'a>(re: &Regex, text: &'a str) -> Option<&'a str> {
    re.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str())
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|c| match c {
                Value::String(s) => s.clone(),
                Value::Object(o) => js::string_or_empty(o.get("text")),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn s_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// The Workflow call's tool_result: launched (run and task ids) or an error. `meta` is Null when absent.
pub fn workflow_launched(w: &mut Obj, block: &Value, meta: &Value, at: &str) {
    if !at.is_empty() {
        w.insert("updatedAt".into(), json!(at));
    }
    let text = result_text(block.get("content"));
    if js::truthy(block.get("is_error")) {
        w.insert("status".into(), json!("failed"));
        let t = js::trim(&text);
        w.insert("error".into(), json!(if t.is_empty() { "The workflow didn't start" } else { t }));
        w.insert("endedAt".into(), if at.is_empty() { Value::Null } else { json!(at) });
        return;
    }
    if let Some(id) = s_of(meta, "runId").or_else(|| group(&RUN_ID, &text)) {
        w.insert("runId".into(), json!(id));
    }
    if let Some(id) = s_of(meta, "taskId").or_else(|| group(&TASK_ID, &text)) {
        w.insert("taskId".into(), json!(id));
    }
    if let Some(n) = s_of(meta, "workflowName").filter(|s| !s.is_empty())
        && w.get("name").and_then(Value::as_str) == Some("Workflow")
    {
        w.insert("name".into(), json!(n));
    }
    let summary = match meta.get("summary") {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => group(&SUMMARY, &text),
    };
    if let Some(s) = summary.filter(|s| !s.is_empty())
        && !js::truthy(w.get("description"))
    {
        w.insert("description".into(), json!(s));
    }
    if let Some(p) = s_of(meta, "scriptPath") {
        w.insert("scriptPath".into(), json!(p));
    } else if w.get("scriptPath").is_none_or(Value::is_null) {
        w.insert("scriptPath".into(), json!(group(&SCRIPT_FILE, &text).map(js::trim)));
    }
}

/// Where a launched workflow keeps its agents' transcripts (from the launch result text).
pub fn transcript_dir_of(text: &str) -> Option<String> {
    group(&TRANSCRIPT_DIR, text).map(|s| js::trim(s).to_string())
}

/// Task-notification status words → the workflow's status.
pub fn workflow_notified(w: &mut Obj, status: &str, result: Option<&str>, at: &str) {
    let s = match status {
        "completed" => "done",
        "killed" | "stopped" => "stopped",
        _ => "failed",
    };
    w.insert("status".into(), json!(s));
    if !at.is_empty() {
        w.insert("endedAt".into(), json!(at));
        w.insert("updatedAt".into(), json!(at));
    }
    if s == "failed" {
        w.insert("error".into(), json!(result.map(str::to_string).unwrap_or_else(|| format!("Workflow {status}"))));
    }
}

// ---------- pricing (src/usage/ticket-usage.ts) ----------

struct Price {
    input: f64,
    output: f64,
    cache_read: f64,
}

const OPUS_5_5: Price = Price { input: 4.0, output: 20.0, cache_read: 0.2 };

static PRICES: LazyLock<Vec<(Regex, Price)>> = LazyLock::new(|| {
    let p = |i, o, c| Price { input: i, output: o, cache_read: c };
    vec![
        (Regex::new(r"(fable|mythos)-5-1").unwrap(), p(10.0, 50.0, 0.25)),
        (Regex::new(r"fable|mythos").unwrap(), p(10.0, 50.0, 1.0)),
        (Regex::new(r"opus-5-5|^opus$").unwrap(), OPUS_5_5),
        (Regex::new(r"opus-(5|4-[5-9])").unwrap(), p(5.0, 25.0, 0.5)),
        (Regex::new(r"opus").unwrap(), p(15.0, 75.0, 1.5)),
        (Regex::new(r"sonnet-5").unwrap(), p(2.0, 10.0, 0.2)),
        (Regex::new(r"sonnet").unwrap(), p(3.0, 15.0, 0.3)),
        (Regex::new(r"haiku-4").unwrap(), p(1.0, 5.0, 0.1)),
        (Regex::new(r"haiku").unwrap(), p(0.8, 4.0, 0.08)),
    ]
});
static MODEL_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[.*\]$").unwrap());

fn price_for(model: &str) -> &'static Price {
    let lower = model.to_lowercase();
    let m = MODEL_TAIL.replace(&lower, "");
    PRICES.iter().find(|(re, _)| re.is_match(&m)).map_or(&OPUS_5_5, |(_, p)| p)
}

fn pos(v: Option<&Value>) -> f64 {
    js::finite(v).filter(|x| *x > 0.0).unwrap_or(0.0)
}

/// API-equivalent cost of one assistant message from its `usage` block.
fn message_cost(model: &str, usage: &Value) -> f64 {
    if !matches!(usage, Value::Object(_) | Value::Array(_)) {
        return 0.0;
    }
    let p = price_for(model);
    let created = pos(usage.get("cache_creation_input_tokens"));
    let split = usage.get("cache_creation").filter(|v| js::truthy(Some(v)));
    let w5m = split.map_or(0.0, |s| pos(s.get("ephemeral_5m_input_tokens")));
    let w1h = split.map_or(created, |s| pos(s.get("ephemeral_1h_input_tokens")));
    let dollars = pos(usage.get("input_tokens")) * p.input
        + pos(usage.get("output_tokens")) * p.output
        + pos(usage.get("cache_read_input_tokens")) * p.cache_read
        + w5m * p.input * 1.25
        + w1h * p.input * 2.0;
    (dollars / 1e6) * if usage.get("speed").and_then(Value::as_str) == Some("fast") { 2.0 } else { 1.0 }
}

// ---------- the workflow's own files ----------

/// Cost of a transcript: each message once (Claude Code writes one line per content block, each with the usage).
pub fn transcript_cost(raw: &str) -> f64 {
    let mut ids: HashMap<String, usize> = HashMap::new();
    let mut costs: Vec<f64> = vec![];
    let mut n = 0;
    for line in raw.split('\n') {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        if ev.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(usage) = js::at(&ev, &["message", "usage"]).filter(|u| js::truthy(Some(u))) else { continue };
        let id = match js::at(&ev, &["message", "id"]).and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => {
                n += 1;
                format!("#{}", n - 1)
            }
        };
        let model = js::string_or_empty(js::at(&ev, &["message", "model"]));
        let cost = message_cost(&model, usage);
        match ids.get(&id) {
            Some(&i) => costs[i] = cost,
            None => {
                ids.insert(id, costs.len());
                costs.push(cost);
            }
        }
    }
    costs.iter().fold(0.0, |s, c| s + c)
}

static FAILED_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)error|fail").unwrap());

/// Journal lines, skipping ones that can't be read (a half-written last line).
pub fn parse_journal(raw: &str) -> Vec<Value> {
    let mut rows: Vec<Obj> = vec![];
    let mut ids: HashMap<String, usize> = HashMap::new();
    for line in raw.split('\n') {
        if js::trim(line).is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        let Some(id) = ev.get("agentId").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
        let i = *ids.entry(id.to_string()).or_insert_with(|| {
            let mut row = Obj::new();
            row.insert("agentId".into(), json!(id));
            row.insert("label".into(), json!(""));
            row.insert("phase".into(), json!(""));
            rows.push(row);
            rows.len() - 1
        });
        let row = &mut rows[i];
        let ty = ev.get("type");
        if ty.and_then(Value::as_str) == Some("started") {
            if let Some(l) = s_of(&ev, "label") {
                row.insert("label".into(), json!(l));
            }
            if let Some(p) = s_of(&ev, "phase") {
                row.insert("phase".into(), json!(p));
            }
        } else if ty.and_then(Value::as_str) == Some("result") {
            row.insert("result".into(), normalize(ev.get("result").cloned().unwrap_or(Value::Null)));
        } else if FAILED_TYPE.is_match(&ty.map_or_else(|| "undefined".into(), js::string)) {
            let msg = s_of(&ev, "error").or_else(|| s_of(&ev, "message")).unwrap_or("The agent failed");
            row.insert("failed".into(), json!(msg));
        }
    }
    rows.into_iter().map(Value::Object).collect()
}

/// Reads workflow files, re-reading one only when its size/mtime change.
#[derive(Default)]
pub struct WorkflowCache {
    files: Mutex<HashMap<PathBuf, (String, Value)>>,
}

fn parse_or_null(raw: &str) -> Value {
    serde_json::from_str(raw).map(normalize).unwrap_or(Value::Null)
}

impl WorkflowCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// None when the file is missing or unreadable.
    fn cached(&self, file: &Path, read: impl FnOnce(&str) -> Value) -> Option<Value> {
        let key = match fs::metadata(file) {
            Ok(s) => file_key(&s),
            Err(_) => {
                self.files.lock().remove(file);
                return None;
            }
        };
        if let Some((k, v)) = self.files.lock().get(file)
            && *k == key
        {
            return Some(v.clone());
        }
        let raw = read_text(file)?;
        let value = read(&raw);
        self.files.lock().insert(file.to_path_buf(), (key, value.clone()));
        Some(value)
    }

    /// A workflow's files (empty parts when they're missing). Always Some (Bun never returns null here).
    pub fn load(&self, session_file: &Path, run_id: &str) -> Option<Value> {
        let base = session_base(session_file);
        let dir = base.join("subagents").join("workflows").join(run_id);
        let journal = self.cached(&dir.join("journal.jsonl"), |raw| Value::Array(parse_journal(raw))).unwrap_or(json!([]));
        let summary = self.cached(&base.join("workflows").join(format!("{run_id}.json")), parse_or_null).unwrap_or(Value::Null);
        let mut agents = Obj::new();
        for name in read_names(&dir).unwrap_or_default() {
            let Some(id) = AGENT_FILE.captures(&name).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()) else { continue };
            let Some(a) = self.cached(&dir.join(&name), |raw| {
                let t = parse_agent_transcript(raw);
                json!({
                    "steps": t["steps"], "current": t["current"], "final": t["final"], "startedAt": t["startedAt"],
                    "lastAt": t["lastAt"], "costUsd": num(transcript_cost(raw)), "label": null, "phase": null,
                })
            }) else {
                continue;
            };
            let meta = self.cached(&dir.join(format!("agent-{id}.meta.json")), parse_or_null).unwrap_or(Value::Null);
            let mut a = a;
            a["label"] = json!(s_of(&meta, "description"));
            a["phase"] = json!(s_of(&meta, "workflowPhase"));
            agents.insert(id, a);
        }
        Some(json!({ "journal": journal, "agents": agents, "summary": summary }))
    }

    /// Change marker for a session's workflow files ("" when there are none).
    pub fn version(&self, session_file: &Path) -> String {
        let base = session_base(session_file);
        let (mut size, mut mtime, mut n) = (0u64, 0f64, 0u32);
        fn add(dir: &Path, deep: bool, size: &mut u64, mtime: &mut f64, n: &mut u32) {
            let Some(names) = read_names(dir) else { return };
            for name in names {
                let p = dir.join(name);
                let Ok(s) = fs::metadata(&p) else { continue };
                if s.is_dir() {
                    if deep {
                        add(&p, false, size, mtime, n);
                    }
                    continue;
                }
                *size += s.len();
                *mtime = mtime.max(mtime_ms(&s));
                *n += 1;
            }
        }
        add(&base.join("subagents").join("workflows"), true, &mut size, &mut mtime, &mut n);
        add(&base.join("workflows"), false, &mut size, &mut mtime, &mut n);
        if n == 0 { String::new() } else { format!("{n}:{size}:{}", js_string(mtime)) }
    }
}

static AGENT_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^agent-(.+)\.jsonl$").unwrap());

/// Total cost of a workflow's agents, from the transcripts in its folder (for the run's spending cap).
pub fn workflow_dir_cost(dir: &Path, cache: &mut HashMap<PathBuf, (String, f64)>) -> f64 {
    let Some(names) = read_names(dir) else { return 0.0 };
    let mut sum = 0.0;
    for name in names {
        if !AGENT_FILE.is_match(&name) {
            continue;
        }
        let file = dir.join(&name);
        let Ok(s) = fs::metadata(&file) else { continue };
        let key = file_key(&s);
        let hit = match cache.get(&file) {
            Some((k, c)) if *k == key => Some(*c),
            _ => read_text(&file).map(|raw| transcript_cost(&raw)),
        };
        if let Some(c) = hit {
            cache.insert(file, (key, c));
            sum += c;
        }
    }
    sum
}

/// `ms(v)`: a positive finite number of ms as an ISO time, else null.
fn ms(v: Option<f64>) -> Value {
    match v {
        Some(x) if x.is_finite() && x > 0.0 => json!(iso(x)),
        _ => Value::Null,
    }
}

static FAIL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"fail|error").unwrap());
static STOP_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"kill|stop|cancel|abort|skip").unwrap());

/// Progress states (stream and summary file) → a row's status.
pub fn progress_status(state: Option<&Value>) -> &'static str {
    let s = js::string_or_empty(state).to_lowercase();
    match s.as_str() {
        "done" | "completed" | "success" => "done",
        _ if FAIL_RE.is_match(&s) => "failed",
        _ if STOP_RE.is_match(&s) => "stopped",
        "queued" | "pending" | "waiting" => "waiting",
        _ => "running",
    }
}

fn result_string(r: Option<&Value>) -> Option<String> {
    match r {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(format!("```json\n{}\n```", serde_json::to_string_pretty(v).unwrap_or_default())),
    }
}

fn st(a: &Obj) -> &str {
    a.get("status").and_then(Value::as_str).unwrap_or("")
}

fn agent_row(id: Value, label: Value, phase: Value, status: &str, started: Value, ended: Value, updated: Value) -> Obj {
    let mut a = Obj::new();
    a.insert("agentId".into(), id);
    a.insert("label".into(), label);
    a.insert("phase".into(), phase);
    a.insert("status".into(), json!(status));
    a.insert("startedAt".into(), started);
    a.insert("endedAt".into(), ended);
    a.insert("updatedAt".into(), updated);
    a.insert("costUsd".into(), json!(0));
    a.insert("current".into(), Value::Null);
    a.insert("stepCount".into(), json!(0));
    a
}

/// The parent's view filled in with the workflow's files and the latest live progress (stream task_progress).
pub fn with_run(w: &Obj, run: Option<&Value>, progress: Option<&[Value]>) -> Obj {
    let mut out = w.clone();
    out.insert("agents".into(), json!([]));
    let summary = run.and_then(|r| r.get("summary")).filter(|v| !v.is_null());
    let live: Option<&[Value]> = match summary.and_then(|s| s.get("workflowProgress")).and_then(Value::as_array) {
        Some(a) => Some(a),
        None => progress,
    };
    if let Some(phases) = summary.and_then(|s| s.get("phases")).and_then(Value::as_array) {
        let titles: Vec<&str> = phases.iter().filter_map(|p| s_of(p, "title")).filter(|t| !t.is_empty()).collect();
        if !titles.is_empty() {
            out.insert("phases".into(), json!(titles));
        }
    } else if let Some(live) = live {
        let titles: Vec<&str> =
            live.iter().filter(|p| s_of(p, "type") == Some("workflow_phase")).filter_map(|p| s_of(p, "title")).collect();
        if !titles.is_empty() {
            out.insert("phases".into(), json!(titles));
        }
    }
    if let Some(n) = summary.and_then(|s| s_of(s, "workflowName"))
        && out.get("name").and_then(Value::as_str) == Some("Workflow")
    {
        out.insert("name".into(), json!(n));
    }
    if let Some(d) = summary.and_then(|s| s_of(s, "summary"))
        && !js::truthy(out.get("description"))
    {
        out.insert("description".into(), json!(d));
    }

    let mut order: Vec<Obj> = vec![];
    let mut rows: HashMap<String, usize> = HashMap::new();
    fn add(a: Obj, order: &mut Vec<Obj>, rows: &mut HashMap<String, usize>) {
        if let Some(id) = a.get("agentId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            rows.insert(id.to_string(), order.len());
        }
        order.push(a);
    }
    if let Some(live) = live {
        for p in live {
            if s_of(p, "type") != Some("workflow_agent") {
                continue;
            }
            let id = json!(s_of(p, "agentId"));
            let status = progress_status(p.get("state"));
            let started = ms(p.get("startedAt").and_then(Value::as_f64));
            let dur = p.get("durationMs").and_then(Value::as_f64).filter(|d| *d > 0.0);
            let ended = match (started.as_str(), dur) {
                (Some(s), Some(d)) if status != "running" && status != "waiting" => {
                    json!(iso(ckanban_core::time::parse_date(s).unwrap_or(f64::NAN) + d))
                }
                _ => Value::Null,
            };
            let label = match p.get("label") {
                None | Some(Value::Null) => "Agent".to_string(),
                Some(v) => js::string(v),
            };
            let phase = json!(s_of(p, "phaseTitle").unwrap_or(""));
            let started = if status == "waiting" { Value::Null } else { started };
            let updated = ms(p.get("lastProgressAt").and_then(Value::as_f64));
            add(agent_row(id, json!(label), phase, status, started, ended, updated), &mut order, &mut rows);
        }
    }
    let journal = run.and_then(|r| r.get("journal")).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    for j in journal {
        let id = j.get("agentId").and_then(Value::as_str).unwrap_or("");
        let status = if js::truthy(j.get("failed")) {
            "failed"
        } else if j.get("result").is_some() {
            "done"
        } else {
            "running"
        };
        if let Some(&i) = rows.get(id) {
            let known = &mut order[i];
            if (st(known) == "running" || st(known) == "waiting") && status != "running" {
                known.insert("status".into(), json!(status));
            }
            if !js::truthy(known.get("label")) && js::truthy(j.get("label")) {
                known.insert("label".into(), j["label"].clone());
            }
            if !js::truthy(known.get("phase")) && js::truthy(j.get("phase")) {
                known.insert("phase".into(), j["phase"].clone());
            }
            continue;
        }
        let label = if js::truthy(j.get("label")) { j["label"].clone() } else { json!("Agent") };
        let phase = j.get("phase").cloned().unwrap_or(Value::Null);
        add(agent_row(json!(id), label, phase, status, Value::Null, Value::Null, Value::Null), &mut order, &mut rows);
    }
    let files = run.and_then(|r| r.get("agents")).and_then(Value::as_object);
    if let Some(files) = files {
        for (id, f) in files {
            if rows.contains_key(id) {
                continue;
            }
            let label = f.get("label").filter(|v| !v.is_null()).cloned().unwrap_or(json!("Agent"));
            let phase = f.get("phase").filter(|v| !v.is_null()).cloned().unwrap_or(json!(""));
            add(agent_row(json!(id), label, phase, "running", Value::Null, Value::Null, Value::Null), &mut order, &mut rows);
        }
    }
    for a in order.iter_mut() {
        let Some(f) = a.get("agentId").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(|id| files?.get(id)) else {
            continue;
        };
        a.insert("costUsd".into(), f.get("costUsd").cloned().unwrap_or(Value::Null));
        a.insert("stepCount".into(), json!(f.get("steps").and_then(Value::as_array).map_or(0, Vec::len)));
        if a.get("startedAt").is_none_or(Value::is_null) {
            a.insert("startedAt".into(), f.get("startedAt").cloned().unwrap_or(Value::Null));
        }
        if let Some(l) = f.get("lastAt").filter(|v| !v.is_null()) {
            a.insert("updatedAt".into(), l.clone());
        }
        if st(a) == "running" {
            a.insert("current".into(), f.get("current").cloned().unwrap_or(Value::Null));
        }
        if st(a) == "done" && !js::truthy(a.get("endedAt")) {
            a.insert("endedAt".into(), f.get("lastAt").cloned().unwrap_or(Value::Null));
        }
    }

    // The workflow's own end: the summary file, else the parent's notification.
    if let Some(summary) = summary
        && let Some(status) = summary.get("status").filter(|v| v.is_string())
    {
        let s = progress_status(Some(status));
        if s != "running" && s != "waiting" {
            out.insert("status".into(), json!(s));
            if out.get("endedAt").is_none_or(Value::is_null) {
                let start = date_parse(out.get("startedAt"));
                let ended = match (summary.get("durationMs").and_then(Value::as_f64), start) {
                    (Some(d), Some(start)) => json!(iso(start + d)),
                    _ => {
                        let ts = match summary.get("timestamp") {
                            None | Some(Value::Null) => None,
                            v => date_parse(v),
                        };
                        ms(ts)
                    }
                };
                out.insert("endedAt".into(), ended);
            }
        }
    }
    if st(&out) != "running" {
        for a in order.iter_mut() {
            if st(a) == "running" || st(a) == "waiting" {
                a.insert("status".into(), json!("stopped"));
                a.insert("current".into(), Value::Null);
            }
        }
    }

    let mut phases = out.get("phases").and_then(Value::as_array).cloned().unwrap_or_default();
    for a in &order {
        let p = a.get("phase").cloned().unwrap_or(Value::Null);
        if !phases.contains(&p) {
            phases.push(p);
        }
    }
    out.insert("phases".into(), Value::Array(phases));
    let cost = order.iter().fold(0.0, |s, a| s + a.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0));
    let last = order.iter().filter_map(|a| a.get("updatedAt").and_then(Value::as_str)).filter(|s| !s.is_empty()).max();
    let last = last.map(str::to_string);
    out.insert("agents".into(), Value::Array(order.into_iter().map(Value::Object).collect()));
    out.insert("costUsd".into(), num(cost));
    if let Some(l) = last
        && matches!(out.get("updatedAt"), Some(Value::String(u)) if l > *u)
    {
        out.insert("updatedAt".into(), json!(l));
    }
    out
}

/// One agent in full (steps and result), or None when the workflow has no such agent.
pub fn workflow_agent_detail(w: &Obj, run: Option<&Value>, agent_id: &str) -> Option<Value> {
    let a = w.get("agents")?.as_array()?.iter().find(|x| x.get("agentId").and_then(Value::as_str) == Some(agent_id))?;
    let f = run.and_then(|r| r.get("agents")).and_then(|m| m.get(agent_id));
    let j = run
        .and_then(|r| r.get("journal"))
        .and_then(Value::as_array)
        .and_then(|js| js.iter().find(|x| x.get("agentId").and_then(Value::as_str) == Some(agent_id)));
    let result = match j {
        Some(j) if j.get("result").is_some() => result_string(j.get("result")).map(Value::String).unwrap_or(Value::Null),
        _ if a.get("status").and_then(Value::as_str) == Some("done") => {
            f.and_then(|f| f.get("final")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null)
        }
        _ => j.and_then(|j| j.get("failed")).filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null),
    };
    let mut out = a.as_object()?.clone();
    out.insert("steps".into(), f.and_then(|f| f.get("steps")).filter(|v| !v.is_null()).cloned().unwrap_or(json!([])));
    out.insert("result".into(), result);
    Some(Value::Object(out))
}

/// No word from a running workflow for this long while the ticket isn't running: it was cut off.
pub const WORKFLOW_STALE_MS: f64 = 60_000.0;

/// Shown as stopped instead of spinning forever once its run is gone and it went quiet.
pub fn settle_workflow(w: &Obj, run_active: bool, now_ms: f64) -> Obj {
    if st(w) != "running" || run_active {
        return w.clone();
    }
    if let Some(last) = date_parse(w.get("updatedAt"))
        && now_ms - last < WORKFLOW_STALE_MS
    {
        return w.clone();
    }
    let mut out = w.clone();
    out.insert("status".into(), json!("stopped"));
    let agents = w.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    let agents = agents
        .into_iter()
        .map(|a| match a {
            Value::Object(mut o) if st(&o) == "running" || st(&o) == "waiting" => {
                o.insert("status".into(), json!("stopped"));
                o.insert("current".into(), Value::Null);
                Value::Object(o)
            }
            other => other,
        })
        .collect();
    out.insert("agents".into(), Value::Array(agents));
    out
}

/// The script, for "Show script": inline in the call, else the summary file, else the file it was saved to.
pub fn workflow_script(w: &Obj, run: Option<&Value>) -> Option<String> {
    if let Some(s) = w.get("script").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        return Some(s.to_string());
    }
    if let Some(s) = run.and_then(|r| js::at(r, &["summary", "script"])).and_then(Value::as_str) {
        return Some(s.to_string());
    }
    let p = w.get("scriptPath").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    read_text(Path::new(p))
}
