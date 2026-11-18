//! `SessionParser` (`src/runs/session-parser.ts`): parses a transcript as it grows. Feed it the new bytes, read the
//! result when needed; feeding a transcript in pieces gives the same result as parsing it whole, so a running
//! session's new lines are parsed on their own.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use indexmap_shim::IndexMap;
use serde_json::{Value, json};

use super::chat_cache::ChatCacheTracker;
use super::js::{self, truthy};
use super::markers::{self, UserText};
use super::subagents::{is_agent_tool, notified_status, parse_task_notification, tool_label};
use super::text::{command_text, local_command_output, parse_setup_block};
use super::workflows::{self, is_workflow_tool, workflow_from_call};
use super::Obj;

/// A tiny insertion-ordered map (Bun's `Map` keeps insertion order; a delete and set moves a key last).
mod indexmap_shim {
    use std::collections::HashMap;

    #[derive(Default, Clone)]
    pub struct IndexMap<V> {
        order: Vec<Option<String>>,
        at: HashMap<String, (usize, V)>,
    }

    impl<V: Clone> IndexMap<V> {
        pub fn remove(&mut self, k: &str) {
            if let Some((i, _)) = self.at.remove(k) {
                self.order[i] = None;
            }
        }
        pub fn insert(&mut self, k: String, v: V) {
            self.remove(&k);
            self.order.push(Some(k.clone()));
            self.at.insert(k, (self.order.len() - 1, v));
        }
        pub fn values(&self) -> Vec<V> {
            self.order.iter().flatten().filter_map(|k| self.at.get(k).map(|(_, v)| v.clone())).collect()
        }
    }
}

/// The session as parsed (`ParsedSession`): the fields every caller reads, and the summary fields in Bun's order.
#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub title: Value,
    pub entries: Arc<Vec<Value>>,
    pub artifacts: Vec<Value>,
    pub last_message: Value,
    /// `pendingSince`: openQuestions, openForm, openAsk?, openFormId?, pendingProposal, pendingTeammates,
    /// pendingSquads, pendingAutomations, pendingKeys, pendingScheduleDeletes, pendingHelperRules.
    pub pending: Obj,
    pub cache: Value,
}

impl Parsed {
    /// The whole `ParsedSession` as Bun's object (for fixtures and tests).
    pub fn to_json(&self) -> Value {
        let mut o = Obj::new();
        o.insert("title".into(), self.title.clone());
        o.insert("entries".into(), Value::Array((*self.entries).clone()));
        o.insert("artifacts".into(), Value::Array(self.artifacts.clone()));
        o.insert("lastMessage".into(), self.last_message.clone());
        for (k, v) in &self.pending {
            o.insert(k.clone(), v.clone());
        }
        o.insert("cache".into(), self.cache.clone());
        Value::Object(o)
    }

    /// Whether any entry is a subagent or a workflow (their transcripts get merged in by the cache).
    pub fn has(&self, key: &str) -> bool {
        self.entries.iter().any(|e| e.get(key).is_some())
    }
}

#[derive(Default)]
pub struct SessionParser {
    custom_title: Option<String>,
    ai_title: Option<String>,
    entries: Vec<Value>,
    artifacts: IndexMap<Value>,
    publishers: HashSet<String>,
    setups: HashSet<String>,
    cards: HashSet<String>,
    failed: HashSet<String>,
    errored: HashSet<String>,
    /// Subagents and workflows by tool_use id: the index of their entry (updated in place as results arrive).
    agents: HashMap<String, usize>,
    workflows: HashMap<String, usize>,
    hide_output: bool,
    cache: ChatCacheTracker,
    tail: Vec<u8>,
    snapshot: Option<Arc<Parsed>>,
}

fn s(v: &str) -> Value {
    Value::String(v.to_string())
}

fn str_at<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

/// `basename(p).replace(/\.[a-z0-9]+$/i, "")`.
fn label_of(path: &str) -> String {
    let base = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    if let Some(i) = base.rfind('.') {
        let ext = &base[i + 1..];
        if !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return base[..i].to_string();
        }
    }
    base.to_string()
}

/// A sync agent's tool_result wraps its report in a notice and indents it; keep just the report.
fn hand_back(text: &str) -> String {
    const HEAD: &str = "[Subagent hand-back]";
    if let Some(rest) = text.strip_prefix(HEAD)
        && let Some(nl) = rest.find('\n')
    {
        let body = &rest[nl + 1..];
        let lines: Vec<&str> = body.split('\n').map(|l| l.strip_prefix("  ").unwrap_or(l)).collect();
        return js::trim(&lines.join("\n")).to_string();
    }
    js::trim(text).to_string()
}

/// `at || fallback`.
fn or_at(at: &str, fallback: Option<&Value>) -> Value {
    if at.is_empty() { fallback.cloned().unwrap_or(Value::Null) } else { s(at) }
}

/// The parent's tool_result for an Agent call: the report (sync), the launch (background) or an error.
fn agent_result(a: &mut Obj, block: &Value, meta: &Value, at: &str) {
    let updated = or_at(at, a.get("updatedAt"));
    a.insert("updatedAt".into(), updated);
    if meta.get("status").and_then(Value::as_str) == Some("async_launched") {
        a.insert("background".into(), Value::Bool(true));
        return;
    }
    if truthy(block.get("is_error")) {
        a.insert("status".into(), s("failed"));
        let t = js::trim(&markers::result_text(block.get("content").unwrap_or(&Value::Null))).to_string();
        a.insert("error".into(), s(if t.is_empty() { "Agent failed" } else { &t }));
    } else {
        a.insert("status".into(), s("done"));
        let report = match meta.get("content") {
            Some(c @ Value::Array(_)) => js::trim(&markers::result_text(c)).to_string(),
            _ => String::new(),
        };
        let result = if report.is_empty() { hand_back(&markers::result_text(block.get("content").unwrap_or(&Value::Null))) } else { report };
        a.insert("result".into(), Value::String(result));
        if let Some(t) = meta.get("agentType").and_then(Value::as_str)
            && a.get("type").is_none_or(Value::is_null)
        {
            a.insert("type".into(), s(t));
        }
    }
    a.insert("endedAt".into(), if at.is_empty() { Value::Null } else { s(at) });
}

/// `content.map((c) => (c?.type === "text" ? c.text : "")).join("\n")`.
fn joined_text(content: &[Value]) -> String {
    content
        .iter()
        .map(|c| if str_at(c, "type") == Some("text") { js::string_or_empty(c.get("text")) } else { String::new() })
        .collect::<Vec<_>>()
        .join("\n")
}

impl SessionParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// New bytes of the transcript, cut anywhere (even inside a line or a character).
    pub fn feed(&mut self, chunk: &[u8]) {
        let mut buf = std::mem::take(&mut self.tail);
        buf.extend_from_slice(chunk);
        let mut start = 0;
        if let Some(nl) = buf.iter().rposition(|&b| b == b'\n') {
            let text = String::from_utf8_lossy(&buf[..nl]).into_owned();
            self.lines(&text);
            start = nl + 1;
        }
        let rest = &buf[start..];
        // A complete JSON object with no newline yet is a whole line; a half-written one waits.
        if !rest.is_empty() && rest[0] == b'{' && rest[rest.len() - 1] == b'}' {
            let text = String::from_utf8_lossy(rest);
            if let Ok(ev @ Value::Object(_)) = serde_json::from_str::<Value>(&text) {
                self.event(&ev);
                return;
            }
        }
        self.tail = rest.to_vec();
    }

    /// Whole lines of text (the last one may lack its newline).
    pub fn lines(&mut self, text: &str) {
        for line in text.split('\n') {
            if line.is_empty() {
                continue;
            }
            // JSON.parse allows surrounding whitespace (a "\r" before the newline).
            match serde_json::from_str::<Value>(line) {
                // `null` would throw in Bun's event(); nothing to show from it either way.
                Ok(Value::Null) | Err(_) => continue,
                Ok(ev) => self.event(&ev),
            }
        }
    }

    fn entry_mut(&mut self, i: usize, key: &str) -> Option<&mut Obj> {
        self.entries.get_mut(i)?.get_mut(key)?.as_object_mut()
    }

    fn notified(&mut self, text: &str, at: &str) {
        let Some((id, status, result)) = parse_task_notification(text) else { return };
        if let Some(&i) = self.workflows.get(&id)
            && let Some(w) = self.entry_mut(i, "workflow")
        {
            workflows::workflow_notified(w, &status, result.as_deref(), at);
        }
        let Some(&i) = self.agents.get(&id) else { return };
        let Some(a) = self.entry_mut(i, "agent") else { return };
        let st = notified_status(&status);
        a.insert("status".into(), s(st));
        let ended = or_at(at, a.get("endedAt"));
        a.insert("endedAt".into(), ended);
        let updated = or_at(at, a.get("updatedAt"));
        a.insert("updatedAt".into(), updated);
        if st == "done" {
            if let Some(r) = result {
                a.insert("result".into(), Value::String(r));
            }
        } else {
            a.insert("error".into(), Value::String(result.unwrap_or_else(|| format!("Agent {status}"))));
        }
    }

    fn peer_entry(u: &UserText, uuid: &str, at: &str) -> Obj {
        let from = if u.kind == "text" && u.huddle.is_none() { markers::from_ticket(&u.text) } else { None };
        let auto = if u.kind == "text" && u.huddle.is_none() && from.is_none() { markers::from_automation(&u.text) } else { None };
        let text = match (&from, &auto) {
            (Some((_, _, t)), _) => t.clone(),
            (_, Some((_, t))) => t.clone(),
            _ => u.text.clone(),
        };
        let mut e = Obj::new();
        e.insert("uuid".into(), s(uuid));
        e.insert("at".into(), s(at));
        e.insert("role".into(), s("user"));
        e.insert("kind".into(), s(u.kind));
        e.insert("text".into(), Value::String(text));
        if let Some(c) = &u.command {
            e.insert("command".into(), s(c));
        }
        if let Some(h) = &u.huddle {
            e.insert("peer".into(), json!({"dir": "in", "ticketId": null}));
            e.insert("huddleId".into(), s(h));
        }
        if let Some((id, title, _)) = &from {
            e.insert("peer".into(), json!({"dir": "in", "ticketId": id, "title": title}));
        }
        if let Some((name, _)) = &auto {
            e.insert("peer".into(), json!({"dir": "in", "ticketId": null, "automation": name}));
        }
        if let Some(setup) = &u.setup {
            e.insert("setup".into(), setup.clone());
        }
        if let Some(w) = &u.wake {
            e.insert("wake".into(), s(w));
        }
        e
    }

    fn push(&mut self, e: Obj) {
        self.entries.push(Value::Object(e));
    }

    fn base(uuid: &str, at: &str, role: &str, kind: &str, text: &str) -> Obj {
        let mut e = Obj::new();
        e.insert("uuid".into(), s(uuid));
        e.insert("at".into(), s(at));
        e.insert("role".into(), s(role));
        e.insert("kind".into(), s(kind));
        e.insert("text".into(), s(text));
        e
    }

    fn command_output(&mut self, uuid: &str, at: &str, out: String) {
        if self.hide_output {
            self.hide_output = false;
        } else if !out.is_empty() {
            let mut e = Self::base(uuid, at, "assistant", "text", &out);
            e.insert("commandOutput".into(), Value::Bool(true));
            self.push(e);
        }
    }

    fn event(&mut self, ev: &Value) {
        self.snapshot = None;
        let ty = str_at(ev, "type");
        if ty == Some("custom-title")
            && let Some(t) = str_at(ev, "customTitle")
        {
            self.custom_title = Some(t.to_string());
        } else if ty == Some("ai-title")
            && let Some(t) = str_at(ev, "aiTitle")
        {
            self.ai_title = Some(t.to_string());
        }
        let at = str_at(ev, "timestamp").unwrap_or("").to_string();
        let uuid = str_at(ev, "uuid").map(str::to_string).unwrap_or_else(|| self.entries.len().to_string());
        let sidechain = truthy(ev.get("isSidechain"));
        let attachment = ev.get("attachment");
        let queued = ty == Some("attachment")
            && attachment.and_then(|a| a.get("type")).and_then(Value::as_str) == Some("queued_command")
            && !sidechain;
        if queued && let Some(p) = attachment.and_then(|a| a.get("prompt")).and_then(Value::as_str) {
            self.notified(p, &at);
        }
        if ty == Some("queue-operation")
            && str_at(ev, "operation") == Some("enqueue")
            && let Some(c) = str_at(ev, "content")
        {
            self.notified(c, &at);
        }
        if queued && attachment.and_then(|a| a.get("commandMode")).and_then(Value::as_str) == Some("prompt") {
            let prompt = attachment.and_then(|a| a.get("prompt")).unwrap_or(&Value::Null);
            if let Some(u) = markers::user_text(prompt) {
                let e = Self::peer_entry(&u, &uuid, &at);
                self.push(e);
            }
            return;
        }
        if ty == Some("system") && !sidechain {
            let out = if str_at(ev, "subtype") == Some("local_command") { str_at(ev, "content").and_then(local_command_output) } else { None };
            match out {
                Some(_) if self.hide_output => self.hide_output = false,
                Some(o) if !o.is_empty() => {
                    let mut e = Self::base(&uuid, &at, "assistant", "text", &o);
                    e.insert("commandOutput".into(), Value::Bool(true));
                    self.push(e);
                }
                _ => {
                    if str_at(ev, "subtype") == Some("compact_boundary") {
                        self.push(Self::base(&uuid, &at, "user", "board", "Conversation compacted"));
                    }
                }
            }
            return;
        }
        if (ty != Some("user") && ty != Some("assistant")) || sidechain {
            return;
        }
        let compact = truthy(ev.get("isCompactSummary"));
        if !compact {
            self.cache.add(ev);
        }
        let null = Value::Null;
        let content = ev.get("message").and_then(|m| m.get("content")).unwrap_or(&null);

        if ty == Some("user") {
            if compact {
                return;
            }
            if let Value::String(c) = content
                && markers::terminal_only(command_text(js::trim(c)).as_deref())
            {
                self.hide_output = true;
                return;
            }
            if let Value::String(c) = content
                && let Some(out) = local_command_output(c)
            {
                self.command_output(&uuid, &at, out);
                return;
            }
            let meta_ev = truthy(ev.get("isMeta"));
            if !meta_ev {
                self.hide_output = false;
            }
            let note = match content {
                Value::String(c) => c.clone(),
                Value::Array(a) => joined_text(a),
                _ => String::new(),
            };
            self.notified(&note, &at);
            if let Value::Array(blocks) = content {
                let tool_use_result = ev.get("toolUseResult").unwrap_or(&null);
                for b in blocks {
                    if str_at(b, "type") != Some("tool_result") {
                        continue;
                    }
                    let id = str_at(b, "tool_use_id").unwrap_or("").to_string();
                    let has_id = b.get("tool_use_id").is_some_and(Value::is_string);
                    if has_id && let Some(&i) = self.agents.get(&id)
                        && let Some(a) = self.entry_mut(i, "agent")
                    {
                        agent_result(a, b, tool_use_result, &at);
                    }
                    if has_id && let Some(&i) = self.workflows.get(&id)
                        && let Some(w) = self.entry_mut(i, "workflow")
                    {
                        workflows::workflow_launched(w, b, tool_use_result, &at);
                    }
                    let is_error = truthy(b.get("is_error"));
                    if has_id && is_error && self.cards.contains(&id) {
                        self.failed.insert(id.clone());
                    }
                    if is_error {
                        // Bun's Set keeps whatever tool_use_id is, even a missing one.
                        self.errored.insert(js::string_or_empty(b.get("tool_use_id")));
                    }
                    let text = || markers::result_text(b.get("content").unwrap_or(&Value::Null));
                    if has_id && self.setups.contains(&id)
                        && let Some(setup) = parse_setup_block(&text())
                    {
                        let mut e = Self::base(&format!("{id}:setup"), &at, "assistant", "board", "");
                        e.insert("setup".into(), setup);
                        self.push(e);
                    }
                    if !has_id || !self.publishers.contains(&id) {
                        continue;
                    }
                    for (path, url) in markers::published(&text()) {
                        let mut a = Obj::new();
                        a.insert("url".into(), s(&url));
                        a.insert("label".into(), Value::String(label_of(&path)));
                        a.insert("at".into(), s(&at));
                        self.artifacts.insert(url, Value::Object(a));
                    }
                }
            }
            if let Some(u) = markers::user_text(content)
                && !meta_ev
            {
                let mut e = Self::peer_entry(&u, &uuid, &at);
                if u.kind == "text" && !e.contains_key("peer") && !e.contains_key("setup") {
                    e.insert("rewind".into(), Value::Bool(true));
                }
                self.push(e);
            }
            return;
        }

        self.hide_output = false;
        let Value::Array(blocks) = content else { return };
        for (i, b) in blocks.iter().enumerate() {
            let is_use = str_at(b, "type") == Some("tool_use");
            let bid = if is_use { str_at(b, "id") } else { None };
            if let Some(id) = bid {
                if markers::is_publisher(b) {
                    self.publishers.insert(id.to_string());
                }
                if str_at(b, "name") == Some("Bash") {
                    let cmd = js::string_or_empty(b.get("input").and_then(|x| x.get("command")));
                    if markers::is_setup_helper(&cmd) {
                        self.setups.insert(id.to_string());
                    }
                }
            }
            let id = if i > 0 { format!("{uuid}:{i}") } else { uuid.clone() };
            let card = if bid.is_some() { markers::card_entry(b) } else { None };
            let name = js::string_or_empty(b.get("name"));
            let text = if str_at(b, "type") == Some("text") { b.get("text").and_then(Value::as_str).map(js::trim).filter(|t| !t.is_empty()) } else { None };
            if let Some(t) = text {
                let mut e = Self::base(&id, &at, "assistant", "text", "");
                e.remove("text");
                for (k, v) in markers::assistant_block(t) {
                    e.insert(k, v);
                }
                self.push(e);
            } else if let Some(card) = card {
                let bid = bid.unwrap_or_default();
                self.cards.insert(bid.to_string());
                let mut e = Self::base(bid, &at, "assistant", "text", "");
                for (k, v) in card {
                    e.insert(k, v);
                }
                self.push(e);
            } else if is_use && is_agent_tool(&name) && bid.is_some() {
                let bid = bid.unwrap_or_default();
                let null = Value::Null;
                let input = b.get("input").filter(|v| !v.is_null()).unwrap_or(&null);
                let desc = input.get("description").and_then(Value::as_str).map(js::trim).filter(|d| !d.is_empty()).unwrap_or("Subagent");
                let mut a = Obj::new();
                a.insert("toolUseId".into(), s(bid));
                a.insert("description".into(), s(desc));
                a.insert("type".into(), input.get("subagent_type").and_then(Value::as_str).map(s).unwrap_or(Value::Null));
                a.insert("background".into(), Value::Bool(input.get("run_in_background") == Some(&Value::Bool(true))));
                a.insert("status".into(), s("running"));
                a.insert("startedAt".into(), s(&at));
                a.insert("endedAt".into(), Value::Null);
                a.insert("updatedAt".into(), s(&at));
                a.insert("steps".into(), json!([]));
                a.insert("stepCount".into(), json!(0));
                a.insert("current".into(), Value::Null);
                a.insert("result".into(), Value::Null);
                a.insert("error".into(), Value::Null);
                self.agents.insert(bid.to_string(), self.entries.len());
                let mut e = Self::base(bid, &at, "assistant", "agent", &tool_label(b));
                e.insert("agent".into(), Value::Object(a));
                self.push(e);
            } else if is_use && is_workflow_tool(&name) && bid.is_some() {
                let bid = bid.unwrap_or_default();
                let w = workflow_from_call(bid, b.get("input").unwrap_or(&Value::Null), &at);
                let wname = js::string_or_empty(w.get("name"));
                self.workflows.insert(bid.to_string(), self.entries.len());
                let mut e = Self::base(bid, &at, "assistant", "workflow", &wname);
                e.insert("workflow".into(), Value::Object(w));
                self.push(e);
            } else if is_use {
                let mut e = Self::base(&id, &at, "assistant", "tool", &tool_label(b));
                if let Some(t) = bid {
                    e.insert("toolUseId".into(), s(t));
                }
                self.push(e);
            }
        }
    }

    /// The session as parsed so far (the same `Arc` until more lines arrive).
    pub fn result(&mut self) -> Arc<Parsed> {
        if let Some(p) = &self.snapshot {
            return p.clone();
        }
        let mut entries: Vec<Value> = self
            .entries
            .iter()
            .filter(|e| !str_at(e, "uuid").is_some_and(|u| self.failed.contains(u)))
            .cloned()
            .map(|mut e| {
                if let Some(t) = str_at(&e, "toolUseId").map(str::to_string)
                    && self.errored.contains(&t)
                    && let Some(o) = e.as_object_mut()
                {
                    o.insert("error".into(), Value::Bool(true));
                }
                e
            })
            .collect();
        markers::drop_blocked_moves(&mut entries);
        let p = Parsed {
            title: self.custom_title.clone().or_else(|| self.ai_title.clone()).map(Value::String).unwrap_or(Value::Null),
            last_message: last_message(&entries),
            pending: pending_since(&entries),
            artifacts: self.artifacts.values(),
            entries: Arc::new(entries),
            cache: self.cache.result(),
        };
        let p = Arc::new(p);
        self.snapshot = Some(p.clone());
        p
    }
}

/// `parseSession(raw)`: a whole transcript at once.
pub fn parse_session(raw: &str) -> Arc<Parsed> {
    let mut p = SessionParser::new();
    p.lines(raw);
    p.result()
}

const CARD_KEYS: [&str; 10] = ["questions", "proposal", "branch", "deletion", "scheduleDeletion", "helperRule", "teammate", "squad", "automation", "keys"];

fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n > 1 { "s" } else { "" })
}

fn last_message(entries: &[Value]) -> Value {
    let found = entries.iter().enumerate().rev().find(|(_, e)| {
        str_at(e, "kind") == Some("text") && (truthy(e.get("text")) || CARD_KEYS.iter().any(|k| truthy(e.get(*k))))
    });
    let Some((li, last)) = found else { return Value::Null };
    let len = |k: &str, sub: Option<&str>| {
        let v = last.get(k);
        let v = match sub {
            Some(s2) => v.and_then(|x| x.get(s2)),
            None => v,
        };
        v.and_then(Value::as_array).map(Vec::len).unwrap_or(0)
    };
    let text = if truthy(last.get("text")) {
        js::string(&last["text"])
    } else if truthy(last.get("questions")) {
        format!("Asked {}", plural(len("questions", None), "question"))
    } else if truthy(last.get("branch")) {
        "Offered to branch this ticket".into()
    } else if truthy(last.get("deletion")) {
        format!("Asked to delete {}", plural(len("deletion", Some("ids")), "ticket"))
    } else if truthy(last.get("scheduleDeletion")) {
        "Asked to delete a schedule".into()
    } else if truthy(last.get("helperRule")) {
        "Suggested a line for the helper".into()
    } else if truthy(last.get("teammate")) {
        format!("Proposed teammate @{}", js::string_or_empty(last["teammate"].get("name")))
    } else if truthy(last.get("squad")) {
        format!("Proposed squad \"{}\"", js::string_or_empty(last["squad"].get("squad").and_then(|q| q.get("label"))))
    } else if truthy(last.get("automation")) {
        format!("Proposed automation \"{}\"", js::string_or_empty(last["automation"].get("name")))
    } else {
        "Proposed an updated ticket".into()
    };
    let role = str_at(last, "role").unwrap_or("");
    let asked = if role == "assistant" {
        entries[..li].iter().rev().find(|e| str_at(e, "role") == Some("user") && str_at(e, "kind") == Some("text"))
    } else {
        None
    };
    let mut m = Obj::new();
    m.insert("role".into(), s(role));
    m.insert("text".into(), Value::String(text));
    m.insert("at".into(), last.get("at").cloned().unwrap_or(Value::Null));
    if role == "user" && truthy(last.get("huddleId")) {
        m.insert("from".into(), s("huddle"));
    }
    if role == "user" && truthy(last.get("peer").and_then(|p| p.get("automation"))) {
        m.insert("from".into(), s("automation"));
    }
    if asked.is_some_and(|a| truthy(a.get("huddleId"))) {
        m.insert("peerReply".into(), Value::Bool(true));
    }
    Value::Object(m)
}

fn uuids(entries: &[&Value], key: &str) -> Value {
    Value::Array(entries.iter().filter(|e| truthy(e.get(key))).map(|e| e.get("uuid").cloned().unwrap_or(Value::Null)).collect())
}

fn pending_since(entries: &[Value]) -> Obj {
    let mut last_user: isize = -1;
    for (i, e) in entries.iter().enumerate() {
        if str_at(e, "role") == Some("user")
            && str_at(e, "kind") == Some("text")
            && !truthy(e.get("huddleId"))
            && !truthy(e.get("peer").and_then(|p| p.get("automation")))
        {
            last_user = i as isize;
        }
    }
    let after: Vec<&Value> = entries[(last_user + 1) as usize..].iter().collect();
    let all: Vec<&Value> = entries.iter().collect();
    let form = after.iter().rev().find(|e| truthy(e.get("questions")));
    let open_form = form.and_then(|f| f.get("questions")).cloned().unwrap_or_else(|| json!([]));
    let mut o = Obj::new();
    let count = open_form.as_array().map(Vec::len).unwrap_or(0);
    o.insert("openQuestions".into(), json!(count));
    o.insert("openForm".into(), open_form);
    if let Some(ask) = form.and_then(|f| f.get("ask")).filter(|a| truthy(Some(a))) {
        o.insert("openAsk".into(), ask.clone());
    }
    if let Some(f) = form {
        o.insert("openFormId".into(), f.get("uuid").cloned().unwrap_or(Value::Null));
    }
    let proposal = after.iter().rev().find_map(|e| e.get("proposal").filter(|p| truthy(Some(p)))).cloned().unwrap_or(Value::Null);
    o.insert("pendingProposal".into(), proposal);
    o.insert("pendingTeammates".into(), uuids(&after, "teammate"));
    o.insert("pendingSquads".into(), uuids(&after, "squad"));
    o.insert("pendingAutomations".into(), uuids(&after, "automation"));
    // A key box stays open across the user's later messages (a question about how to get the key); only a newer
    // key box replaces it. Answered ones are filtered out by callers through `keyCards`.
    let newest_keys: Vec<&Value> = all.iter().rev().find(|e| truthy(e.get("keys"))).into_iter().copied().collect();
    o.insert("pendingKeys".into(), uuids(&newest_keys, "keys"));
    let deletes: Vec<Value> = all
        .iter()
        .filter_map(|e| {
            let d = e.get("scheduleDeletion").filter(|d| truthy(Some(d)))?;
            Some(json!({"uuid": e.get("uuid").cloned().unwrap_or(Value::Null), "id": d.get("id").cloned().unwrap_or(Value::Null)}))
        })
        .collect();
    o.insert("pendingScheduleDeletes".into(), Value::Array(deletes));
    o.insert("pendingHelperRules".into(), uuids(&all, "helperRule"));
    o
}


#[cfg(test)]
mod tests {
    use super::*;

    fn entry(uuid: &str, role: &str, extra: Value) -> Value {
        let mut e = json!({"uuid": uuid, "role": role, "kind": "text", "text": uuid, "at": ""});
        if let (Some(o), Value::Object(x)) = (e.as_object_mut(), extra) {
            o.extend(x);
        }
        e
    }

    fn keys(uuid: &str) -> Value {
        entry(uuid, "assistant", json!({"keys": {"keys": [{"name": "API_KEY"}], "reason": "r"}}))
    }

    #[test]
    fn key_box_stays_pending_after_a_user_message_until_a_newer_box() {
        let q = |uuid: &str| entry(uuid, "assistant", json!({"questions": [{"question": "?"}]}));
        // A user message after the key box (asking how to get the key) keeps the box open, while a form closes.
        let list = vec![q("f1"), keys("k1"), entry("u1", "user", json!({})), entry("a1", "assistant", json!({}))];
        let p = pending_since(&list);
        assert_eq!(p["pendingKeys"], json!(["k1"]));
        assert_eq!(p["openQuestions"], json!(0));
        // A newer key box replaces the older one.
        let mut list = list;
        list.push(keys("k2"));
        list.push(entry("u2", "user", json!({})));
        assert_eq!(pending_since(&list)["pendingKeys"], json!(["k2"]));
        // No key box: nothing pending.
        assert_eq!(pending_since(&[entry("u", "user", json!({}))])["pendingKeys"], json!([]));
    }
}
