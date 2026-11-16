//! search_chat / read_chat, ported from `src/chat/chat-search.ts`: Claude looks up earlier messages of a ticket's chat
//! (its current session and every session left behind) instead of re-reading the whole conversation. A message's ref
//! is `<sessionId>:<index>`, the index of its entry in the parsed transcript.

use super::js;
use ckanban_core::jsnum::js_string;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, LazyLock};

/// One session of a ticket's chat, oldest first in the list handed in.
#[derive(Clone, Debug, Default)]
pub struct ChatSource {
    pub session_id: String,
    pub entries: Arc<Vec<Value>>,
    /// Tool output by tool_use id (only read when tools are searched).
    pub tool_output: Option<HashMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ChatMatch {
    pub r#ref: String,
    pub at: String,
    pub who: String,
    pub snippet: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReadLine {
    pub r#ref: String,
    pub at: String,
    pub who: String,
    pub text: String,
}

pub const SEARCH_LIMIT: usize = 10;
pub const READ_MAX_MESSAGES: usize = 40;
pub const READ_MAX_TOKENS: usize = 8000;
const DEFAULT_SIDE: f64 = 10.0;

/// Rough token count (about 4 characters a token).
pub fn rough_tokens(s: &str) -> usize {
    js::len16(s).div_ceil(4)
}

fn text_of(e: &Value) -> &str {
    e.get("text").and_then(Value::as_str).unwrap_or("")
}

fn at_of(e: &Value) -> String {
    e.get("at").and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn who_wrote(e: &Value) -> String {
    let peer = e.get("peer").filter(|p| js::truthy(Some(p)));
    if let Some(p) = peer {
        if js::truthy(p.get("automation")) {
            return format!("Automation \"{}\"", js::string(&p["automation"]));
        }
        if js::truthy(p.get("ticketId")) {
            return if p.get("dir").and_then(Value::as_str) == Some("in") {
                format!("Ticket {}", js::string(&p["ticketId"]))
            } else {
                "Claude".into()
            };
        }
        return "Huddle".into();
    }
    match e.get("kind").and_then(Value::as_str) {
        Some("tool" | "agent" | "workflow") => "Tool".into(),
        Some("board") => "Board".into(),
        _ if e.get("role").and_then(Value::as_str) == Some("user") => "User".into(),
        _ => "Claude".into(),
    }
}

/// A user message or one of Claude's replies (not a tool row, a board note or a built-in command's output).
fn is_message(e: &Value) -> bool {
    e.get("kind").and_then(Value::as_str) == Some("text") && !js::truthy(e.get("commandOutput")) && !js::trim(text_of(e)).is_empty()
}

fn entry_text(e: &Value, src: &ChatSource, tools: bool) -> Option<String> {
    if is_message(e) {
        return Some(text_of(e).to_string());
    }
    if !tools {
        return None;
    }
    let text = text_of(e);
    if matches!(e.get("kind").and_then(Value::as_str), Some("tool" | "agent" | "workflow")) {
        let out: Option<String> = match e.get("toolUseId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(id) => src.tool_output.as_ref().and_then(|m| m.get(id)).cloned(),
            None => js::at(e, &["agent", "result"]).filter(|v| !v.is_null()).map(js::string),
        };
        let parts: Vec<&str> = [Some(text), out.as_deref()].into_iter().flatten().filter(|s| !s.is_empty()).collect();
        let joined = parts.join("\n");
        return if joined.is_empty() { None } else { Some(joined) };
    }
    if js::trim(text).is_empty() { None } else { Some(text.to_string()) }
}

/// The query's words, lower case; whole words, no stemming.
pub fn query_words(query: &str) -> Vec<String> {
    let lower = query.to_lowercase();
    let mut seen = HashSet::new();
    lower
        .split(js::is_space)
        .map(js::trim)
        .filter(|w| !w.is_empty())
        .filter(|w| seen.insert(w.to_string()))
        .map(str::to_string)
        .collect()
}

static WORD_CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_]$").unwrap());

fn is_word_char(c: char) -> bool {
    let mut b = [0u8; 4];
    WORD_CHAR.is_match(c.encode_utf8(&mut b))
}

/// `(?<![\p{L}\p{N}_])word(?![\p{L}\p{N}_])` with flags `iu`.
struct WordRe(Regex);

impl WordRe {
    fn new(w: &str) -> Self {
        WordRe(Regex::new(&format!("(?i){}", regex::escape(w))).unwrap())
    }

    fn test(&self, text: &str) -> bool {
        let mut from = 0;
        while from <= text.len() {
            let Some(m) = self.0.find_at(text, from) else { return false };
            let before = text[..m.start()].chars().next_back().is_none_or(|c| !is_word_char(c));
            let after = text[m.end()..].chars().next().is_none_or(|c| !is_word_char(c));
            if before && after {
                return true;
            }
            from = m.start() + text[m.start()..].chars().next().map_or(1, char::len_utf8);
        }
        false
    }
}

fn clip(s: &str, max: usize) -> String {
    if js::len16(s) > max { format!("{}…", js::cut16(s, max - 1)) } else { s.to_string() }
}

/// A few lines around the first line that has one of the words.
fn snippet(text: &str, res: &[WordRe]) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let at = lines.iter().position(|l| res.iter().any(|r| r.test(l))).unwrap_or(0);
    let pick: Vec<String> = lines[at.saturating_sub(2)..(at + 3).min(lines.len())].iter().map(|l| clip(l, 300)).collect();
    let joined = pick.join("\n");
    clip(js::trim(&joined), 900)
}

/// Messages that have every word of the query, newest first; the count is every match.
pub fn search_chat(sources: &[ChatSource], query: &str, include_tools: bool, limit: Option<usize>) -> Result<(Vec<ChatMatch>, usize), String> {
    let words = query_words(query);
    if words.is_empty() {
        return Err("the query is empty: give one or more words to look for".into());
    }
    let res: Vec<WordRe> = words.iter().map(|w| WordRe::new(w)).collect();
    let limit = limit.unwrap_or(SEARCH_LIMIT);
    let mut matches = vec![];
    let mut total = 0;
    for src in sources.iter().rev() {
        for (i, e) in src.entries.iter().enumerate().rev() {
            let Some(text) = entry_text(e, src, include_tools) else { continue };
            if !res.iter().all(|r| r.test(&text)) {
                continue;
            }
            total += 1;
            if matches.len() < limit {
                matches.push(ChatMatch { r#ref: format!("{}:{i}", src.session_id), at: at_of(e), who: who_wrote(e), snippet: snippet(&text, &res) });
            }
        }
    }
    Ok((matches, total))
}

static REF: LazyLock<Regex> = LazyLock::new(|| {
    let s = r"[\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
    Regex::new(&format!(r"^{s}*([A-Za-z0-9_-]+):([0-9]+){s}*$")).unwrap()
});

/// `<sessionId>:<index>`; the index is `Number(digits)` (a JS number, so a huge one is not exact).
pub fn parse_ref(r: &str) -> Option<(String, f64)> {
    let c = REF.captures(r)?;
    Some((c[1].to_string(), c[2].parse::<f64>().ok()?))
}

/// The messages around `index`: up to `before` earlier and `after` later ones (10 each by default, also for NaN and
/// ±Infinity; fractions round down), capped at 40 messages and about 8,000 tokens, filled outwards from the ref.
pub fn read_chat(src: &ChatSource, index: f64, before: Option<f64>, after: Option<f64>) -> Result<(Vec<ReadLine>, bool), String> {
    let len = src.entries.len();
    // `parse_ref` only gives whole numbers; NaN or a fraction (never sent) reads as entry 0 or rounds down here.
    if index < 0.0 || index >= len as f64 {
        return Err(format!("no message {} in that chat (it has {len})", js_string(index)));
    }
    let index = index as usize;
    let side = |v: Option<f64>| -> usize {
        let v = match v {
            Some(x) if x.is_finite() => x.floor(),
            _ => DEFAULT_SIDE,
        };
        v.clamp(0.0, (READ_MAX_MESSAGES - 1) as f64) as usize
    };
    let (want, want_after) = (side(before), side(after));
    let shown = |i: usize, full: bool| -> Option<ReadLine> {
        let e = &src.entries[i];
        let mut text = if full {
            entry_text(e, src, true).unwrap_or_else(|| text_of(e).to_string())
        } else if is_message(e) {
            text_of(e).to_string()
        } else {
            text_of(e).split('\n').next().unwrap_or("").to_string()
        };
        if js::trim(&text).is_empty() {
            return None;
        }
        if full && rough_tokens(&text) > READ_MAX_TOKENS {
            text = format!("{}…", js::cut16(&text, READ_MAX_TOKENS * 4 - 1));
        }
        Some(ReadLine { r#ref: format!("{}:{i}", src.session_id), at: at_of(e), who: who_wrote(e), text })
    };
    let Some(center) = shown(index, true) else {
        return Err("null is not an object (evaluating 'center.text')".into());
    };
    let mut tokens = rough_tokens(&center.text);
    let mut lines = VecDeque::from([center]);
    let (mut lo, mut hi, mut n_before, mut n_after) = (index as i64 - 1, index + 1, 0, 0);
    while (n_before < want && lo >= 0) || (n_after < want_after && hi < len) {
        for dir_before in [true, false] {
            let i = if dir_before {
                if n_before >= want || lo < 0 {
                    continue;
                }
                lo -= 1;
                (lo + 1) as usize
            } else {
                if n_after >= want_after || hi >= len {
                    continue;
                }
                hi += 1;
                hi - 1
            };
            let Some(line) = shown(i, false) else { continue };
            let cost = rough_tokens(&line.text);
            if lines.len() >= READ_MAX_MESSAGES || tokens + cost > READ_MAX_TOKENS {
                return Ok((lines.into(), true));
            }
            tokens += cost;
            if dir_before {
                lines.push_front(line);
                n_before += 1;
            } else {
                lines.push_back(line);
                n_after += 1;
            }
        }
    }
    Ok((lines.into(), false))
}

/// Tool results in a raw transcript by tool_use id (search_chat with includeTools).
pub fn tool_outputs(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in raw.split('\n') {
        if !line.contains("tool_result") {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
        let Some(content) = js::at(&ev, &["message", "content"]).and_then(Value::as_array) else { continue };
        for b in content {
            if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = b.get("tool_use_id").and_then(Value::as_str) else { continue };
            let text = match b.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(a)) => a
                    .iter()
                    .map(|x| match x {
                        Value::String(s) => s.clone(),
                        Value::Object(o) => js::string_or_empty(o.get("text")),
                        _ => String::new(),
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            let text = if js::len16(&text) > 20_000 { js::cut16(&text, 20_000).to_string() } else { text };
            out.insert(id.to_string(), text);
        }
    }
    out
}

fn when(at: &str) -> String {
    if at.is_empty() { "unknown time".into() } else { js::cut16(at, 16).replacen('T', " ", 1) }
}

pub fn matches_text(ticket_id: &str, query: &str, r: &(Vec<ChatMatch>, usize), include_tools: bool) -> String {
    let (matches, total) = (&r.0, r.1);
    if matches.is_empty() {
        return format!(
            "No messages in {ticket_id}'s chat have all of: {}.{} Try fewer or other words.",
            query_words(query).join(", "),
            if include_tools { "" } else { " Tool output wasn't searched; pass includeTools: true to search it too." }
        );
    }
    let head = format!(
        "{total} message{} {ticket_id}'s chat match{}{}. read_chat(ref) loads the messages around one.",
        if total == 1 { " in" } else { "s in" },
        if total == 1 { "es" } else { "" },
        if total > matches.len() { format!("; the newest {} below", matches.len()) } else { String::new() }
    );
    let mut parts = vec![head];
    parts.extend(matches.iter().map(|m| format!("\n[{}] {} {}:\n{}", m.r#ref, when(&m.at), m.who, m.snippet)));
    parts.join("\n")
}

pub fn read_text(ticket_id: &str, r: &(Vec<ReadLine>, bool)) -> String {
    let (lines, capped) = (&r.0, r.1);
    let body = lines.iter().map(|l| format!("[{}] {} {}:\n{}", l.r#ref, when(&l.at), l.who, l.text)).collect::<Vec<_>>().join("\n\n");
    let tail = if capped {
        format!("\n\n(Stopped at the cap of {READ_MAX_MESSAGES} messages or about {READ_MAX_TOKENS} tokens; read_chat on the first or last ref shows more.)")
    } else {
        String::new()
    };
    format!("{} message{} from {ticket_id}'s chat:\n\n{body}{tail}", lines.len(), if lines.len() == 1 { "" } else { "s" })
}
