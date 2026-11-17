//! Every message the board sends the user, stored before it goes out (`src/helper/messages.ts`):
//! `<root>/messages.json` (`{"version":1,"messages":[...]}`, newest last, compact, fixed `.tmp`), and the Messages
//! screen's rows, tabs and pages.
//!
//! The whole list is kept in memory and written whole on each change, as Bun does: it is capped (500 sent messages
//! within 30 days, 200 held rows within 7), so it stays small.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ckanban_core::datafile;
use ckanban_core::time::{iso, parse_date};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::settings::{base36, hex};
use super::waits::{ro, rs};
use crate::runs::js::{self, head16, len16, trim};

pub type Msg = Map<String, Value>;

pub const MESSAGES_KEEP_MS: f64 = 30.0 * 24.0 * 3_600_000.0;
pub const MESSAGES_MAX: usize = 500;
pub const HELD_KEEP_MS: f64 = 7.0 * 24.0 * 3_600_000.0;
pub const HELD_MAX: usize = 200;
pub const NEAR_KEEP_MAX: usize = 300;
pub const PAIR_MS: f64 = 90_000.0;

/// What a new message carries (`NewMessage`).
#[derive(Clone, Debug, Default)]
pub struct NewMessage {
    pub level: String,
    pub one_line: String,
    pub text: String,
    pub why: Option<String>,
    pub items: Vec<Value>,
    pub held: bool,
    pub summary: Option<Value>,
    pub practice: bool,
    pub night_ask: bool,
    pub held_overnight: Option<String>,
}

impl NewMessage {
    pub fn new(level: &str, one_line: impl Into<String>, text: impl Into<String>) -> Self {
        NewMessage { level: level.into(), one_line: one_line.into(), text: text.into(), ..Default::default() }
    }
}

pub fn held(m: &Msg) -> bool {
    m.get("held") == Some(&Value::Bool(true))
}
fn truthy(m: &Msg, k: &str) -> bool {
    js::truthy(m.get(k))
}
pub fn items(m: &Msg) -> &[Value] {
    m.get("items").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[])
}
fn at_ms(m: &Msg) -> f64 {
    parse_date(rs(m, "at")).unwrap_or(f64::NAN)
}

/// Keeps sent messages for 30 days / 500 and held rows for 7 days / 200, each counted on its own; order kept.
pub fn trim_messages(list: Vec<Msg>, now: f64) -> Vec<Msg> {
    let cut = now - MESSAGES_KEEP_MS;
    let held_cut = now - HELD_KEEP_MS;
    let mut keep = vec![false; list.len()];
    let (mut sent, mut h) = (0, 0);
    for i in (0..list.len()).rev() {
        let m = &list[i];
        let at = at_ms(m);
        if held(m) {
            if h < HELD_MAX && at >= held_cut {
                keep[i] = true;
                h += 1;
            }
        } else if sent < MESSAGES_MAX && at >= cut {
            keep[i] = true;
            sent += 1;
        }
    }
    list.into_iter().zip(keep).filter(|(_, k)| *k).map(|(m, _)| m).collect()
}

pub type Unread = Arc<dyn Fn(usize) + Send + Sync>;

pub struct MessageStore {
    pub file: PathBuf,
    list: Option<Vec<Msg>>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    on_change: Option<Unread>,
}

impl MessageStore {
    pub fn new(root: &Path, now: Arc<dyn Fn() -> f64 + Send + Sync>, on_change: Option<Unread>) -> Self {
        MessageStore { file: root.join("messages.json"), list: None, now, on_change }
    }

    fn changed(&mut self) {
        let n = self.unread();
        if let Some(f) = &self.on_change {
            f(n);
        }
    }

    fn items(&mut self) -> &mut Vec<Msg> {
        if self.list.is_none() {
            let mut list = Vec::new();
            if let Ok(t) = std::fs::read_to_string(&self.file) {
                match datafile::parse_json(&t) {
                    Some(v) => {
                        if let Some(a) = v.get("messages").and_then(Value::as_array) {
                            list = a.iter().filter_map(|m| m.as_object().filter(|m| m.get("id").is_some_and(Value::is_string)).cloned()).collect();
                        }
                    }
                    None => eprintln!("helper: messages.json could not be read (not JSON); starting a new one"),
                }
            }
            self.list = Some(list);
        }
        self.list.as_mut().expect("loaded")
    }

    fn save(&mut self) {
        let msgs = Value::Array(self.items().iter().cloned().map(Value::Object).collect());
        let v = json!({ "version": 1, "messages": msgs });
        if let Err(e) = datafile::write_json(&self.file, &v, datafile::formats::MESSAGES) {
            eprintln!("helper: can't write messages.json: {e}");
        }
    }

    /// Stores a new message (before it is sent) and returns it.
    pub fn add(&mut self, m: NewMessage) -> Msg {
        let now = (self.now)();
        let mut msg = Map::new();
        msg.insert("id".into(), format!("m_{}{}", base36(now as u64), hex(3)).into());
        msg.insert("at".into(), iso(now).into());
        msg.insert("level".into(), m.level.into());
        msg.insert("oneLine".into(), m.one_line.into());
        msg.insert("text".into(), m.text.into());
        msg.insert("why".into(), m.why.map(Value::String).unwrap_or(Value::Null));
        msg.insert("items".into(), Value::Array(m.items));
        msg.insert("sends".into(), json!([]));
        msg.insert("readAt".into(), Value::Null);
        if m.held {
            msg.insert("held".into(), true.into());
        }
        if let Some(s) = m.summary {
            msg.insert("summary".into(), s);
        }
        if m.practice {
            msg.insert("practice".into(), true.into());
        }
        if m.night_ask {
            msg.insert("nightAsk".into(), true.into());
        }
        if let Some(h) = m.held_overnight.filter(|h| !h.is_empty()) {
            msg.insert("heldOvernight".into(), h.into());
        }
        let list = std::mem::take(self.items());
        let mut list = list;
        list.push(msg.clone());
        self.list = Some(trim_messages(list, now));
        self.save();
        self.changed();
        msg
    }

    pub fn record_sends(&mut self, id: &str, sends: Vec<Value>) -> Option<Msg> {
        let m = self.items().iter_mut().find(|m| rs(m, "id") == id)?;
        if let Some(Value::Array(a)) = m.get_mut("sends") {
            a.extend(sends);
        } else {
            m.insert("sends".into(), Value::Array(sends));
        }
        let out = m.clone();
        self.save();
        Some(out)
    }

    pub fn get(&mut self, id: &str) -> Option<Msg> {
        self.items().iter().find(|m| rs(m, "id") == id).cloned()
    }

    /// Newest first; `with_held`: the helper's held rows too.
    pub fn list_newest(&mut self, with_held: bool) -> Vec<Msg> {
        self.items().iter().rev().filter(|m| with_held || !held(m)).cloned().collect()
    }

    pub fn unread(&mut self) -> usize {
        self.items().iter().filter(|m| !truthy(m, "held") && !truthy(m, "practice") && !truthy(m, "readAt")).count()
    }

    pub fn mark_tapped(&mut self, id: &str, how: &str) -> Option<Msg> {
        let at = iso((self.now)());
        let m = self.items().iter_mut().find(|m| rs(m, "id") == id)?;
        m.insert("tapped".into(), json!({ "how": how, "at": at }));
        let read = ro(m, "readAt").is_none();
        if read {
            m.insert("readAt".into(), at.into());
        }
        let out = m.clone();
        self.save();
        if read {
            self.changed();
        }
        Some(out)
    }

    pub fn mark_read(&mut self, id: &str) -> Option<Msg> {
        let at = iso((self.now)());
        let m = self.items().iter_mut().find(|m| rs(m, "id") == id)?;
        if ro(m, "readAt").is_some() {
            return Some(m.clone());
        }
        m.insert("readAt".into(), at.into());
        let out = m.clone();
        self.save();
        self.changed();
        Some(out)
    }

    pub fn mark_all_read(&mut self) -> usize {
        let at = iso((self.now)());
        let mut n = 0;
        for m in self.items().iter_mut() {
            if held(m) || ro(m, "readAt").is_some() {
                continue;
            }
            m.insert("readAt".into(), at.clone().into());
            n += 1;
        }
        if n > 0 {
            self.save();
            self.changed();
        }
        n
    }
}

// ---- the Messages screen's list ----

pub const TABS: [&str; 4] = ["needs", "all", "summaries", "quiet"];

pub fn as_tab(v: Option<&str>) -> &'static str {
    TABS.iter().find(|t| Some(**t) == v).copied().unwrap_or("all")
}

/// `clip(s, n)`.
fn clip(s: &str, n: usize) -> String {
    if len16(s) > n { format!("{}…", head16(s, n - 1).trim_end_matches(js::is_ws)) } else { s.to_string() }
}

static TICKET_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^t_[0-9]{8}_[A-Za-z0-9_]+$").expect("id"));

fn item_name(i: &Value) -> String {
    let title = i.get("title").and_then(Value::as_str).unwrap_or("");
    let t = trim(title);
    let id = i.get("ticketId").and_then(Value::as_str).unwrap_or("");
    if !t.is_empty() && t != id && !TICKET_ID.is_match(t) { t.to_string() } else { String::new() }
}

fn tickets_on(items: &[Value]) -> String {
    let mut boards: Vec<String> = Vec::new();
    for i in items {
        let name = i.get("boardName").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| i.get("board").and_then(Value::as_str)).unwrap_or("");
        let b = trim(name).to_string();
        if !b.is_empty() && !boards.contains(&b) {
            boards.push(b);
        }
    }
    let n = items.len();
    let on = if boards.is_empty() {
        String::new()
    } else if boards.len() > 2 {
        format!(" on {} and {} more boards", boards[..2].join(", "), boards.len() - 2)
    } else {
        format!(" on {}", boards.join(" and "))
    };
    format!("{n} ticket{}{on}", if n == 1 { "" } else { "s" })
}

/// A row's two lines (`rowLines`).
pub fn row_lines(m: &Msg) -> (String, String) {
    let line = trim(rs(m, "oneLine")).to_string();
    let level = rs(m, "level");
    let items = items(m);
    if level == "pause" && !truthy(m, "held") {
        return ("Helper paused".into(), "It can't run right now, so you get each wait directly".into());
    }
    if items.len() == 1 {
        let t = item_name(&items[0]);
        let tail = format!(": {t}");
        if !t.is_empty() && line.ends_with(&tail) && len16(&line) > len16(&t) + 2 {
            return (clip(&line[..line.len() - tail.len()], 160), clip(&t, 120));
        }
    }
    if (level == "summary" || level == "digest")
        && let Some(at) = line.find(": ").filter(|a| *a > 0)
    {
        return (clip(&line[..at], 160), clip(&line[at + 2..], 120));
    }
    let mut names: Vec<String> = Vec::new();
    for i in items {
        let n = item_name(i);
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    if names.is_empty() && !items.is_empty() {
        return (clip(&line, 160), clip(&tickets_on(items), 120));
    }
    let more = if names.len() > 3 { format!(" and {} more", names.len() - 3) } else { String::new() };
    (clip(&line, 160), clip(&(names.iter().take(3).cloned().collect::<Vec<_>>().join(", ") + &more), 120))
}

pub fn to_row(m: &Msg, needs: &HashSet<String>) -> Value {
    let (title, sub) = row_lines(m);
    let mut r = Map::new();
    r.insert("id".into(), m.get("id").cloned().unwrap_or(Value::Null));
    r.insert("at".into(), m.get("at").cloned().unwrap_or(Value::Null));
    r.insert("level".into(), m.get("level").cloned().unwrap_or(Value::Null));
    r.insert("oneLine".into(), clip(rs(m, "oneLine"), 200).into());
    r.insert("title".into(), title.into());
    r.insert("sub".into(), sub.into());
    r.insert("readAt".into(), m.get("readAt").cloned().unwrap_or(Value::Null));
    if truthy(m, "held") {
        r.insert("held".into(), true.into());
    }
    if truthy(m, "practice") {
        r.insert("practice".into(), true.into());
    }
    if needs.contains(rs(m, "id")) {
        r.insert("needsYou".into(), true.into());
    }
    Value::Object(r)
}

pub fn in_tab(m: &Msg, tab: &str, needs: &HashSet<String>) -> bool {
    if tab == "quiet" {
        return truthy(m, "held");
    }
    if truthy(m, "held") {
        return false;
    }
    match tab {
        "summaries" => matches!(rs(m, "level"), "summary" | "digest"),
        "needs" => needs.contains(rs(m, "id")),
        _ => true,
    }
}

/// "Needs you" over a newest-first list (`needsYouIds`); `open_key` gives the open record's key an item meant.
pub fn needs_you_ids(newest: &[Msg], open_key: &mut dyn FnMut(&str, &Msg) -> Option<String>) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut claimed: HashSet<String> = HashSet::new();
    for m in newest {
        if truthy(m, "held") || truthy(m, "practice") {
            continue;
        }
        let rows: &[Value] = match m.get("summary").filter(|s| js::truthy(Some(s))) {
            Some(s) => s.get("new").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[]),
            None => items(m),
        };
        let mut open = false;
        for r in rows {
            let Some(key) = r.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) else { continue };
            let Some(k) = open_key(key, m) else { continue };
            if claimed.contains(&k) {
                continue;
            }
            claimed.insert(k);
            open = true;
        }
        if ro(m, "readAt").is_none() || (open && !truthy(m, "tapped")) {
            out.insert(rs(m, "id").to_string());
        }
    }
    out
}

/// The Needs you badge: a pause and its missed message next to each other count once.
pub fn needs_shown(newest: &[Msg], needs: &HashSet<String>) -> usize {
    let tab: Vec<&Msg> = newest.iter().filter(|m| !truthy(m, "held") && needs.contains(rs(m, "id"))).collect();
    let mut n = 0;
    let mut i = 0;
    while i < tab.len() {
        let a = tab[i];
        if let Some(b) = tab.get(i + 1) {
            let (la, lb) = (rs(a, "level"), rs(b, "level"));
            let pair = ((la == "pause" && lb == "fallback") || (la == "fallback" && lb == "pause")) && (at_ms(a) - at_ms(b)).abs() <= PAIR_MS;
            if pair {
                i += 1;
            }
        }
        n += 1;
        i += 1;
    }
    n
}

#[derive(Clone, Debug)]
pub struct Cursor {
    pub at: String,
    pub id: String,
}

fn cursor_index(newest: &[Msg], c: &Cursor, before: bool) -> usize {
    if let Some(i) = newest.iter().position(|m| rs(m, "id") == c.id) {
        return i;
    }
    let t = parse_date(&c.at).unwrap_or(f64::NAN);
    let j = newest.iter().position(|m| {
        let a = at_ms(m);
        if before { a < t || (a == t && js::cmp16(rs(m, "id"), &c.id).is_lt()) } else { a <= t }
    });
    match j {
        None => newest.len(),
        Some(j) => {
            if before {
                // `j - 1` (may be -1: the page then starts at 0).
                j.wrapping_sub(1)
            } else {
                j
            }
        }
    }
}

/// One page of a tab, newest first (`pageOf`).
pub fn page_of<'a>(newest: &'a [Msg], tab: &str, limit: usize, before: Option<&Cursor>, after: Option<&Cursor>, needs: &HashSet<String>) -> (Vec<&'a Msg>, bool) {
    let mut from: usize = 0;
    let mut to = newest.len();
    if let Some(b) = before {
        from = cursor_index(newest, b, true).wrapping_add(1);
    }
    if let Some(a) = after {
        to = to.min(cursor_index(newest, a, false));
    }
    let mut hits = Vec::new();
    let mut more = false;
    let mut i = from;
    while i < to {
        if in_tab(&newest[i], tab, needs) {
            if hits.len() == limit {
                more = true;
                break;
            }
            hits.push(&newest[i]);
        }
        i += 1;
    }
    (hits, more)
}

pub fn step_tab(m: &Msg, tab: &str, needs: &HashSet<String>) -> String {
    if in_tab(m, tab, needs) || (tab == "needs" && !truthy(m, "held")) {
        return tab.to_string();
    }
    if truthy(m, "held") { "quiet".into() } else { "all".into() }
}

pub fn neighbours_in(newest: &[Msg], id: &str, tab: &str, needs: &HashSet<String>) -> (Option<String>, Option<String>) {
    let Some(i) = newest.iter().position(|m| rs(m, "id") == id) else { return (None, None) };
    let newer = (0..i).rev().find(|j| in_tab(&newest[*j], tab, needs)).map(|j| rs(&newest[j], "id").to_string());
    let older = (i + 1..newest.len()).find(|j| in_tab(&newest[*j], tab, needs)).map(|j| rs(&newest[j], "id").to_string());
    (newer, older)
}

/// A message page's up/down (`nearOf`).
pub fn near_of(newest: &[Msg], msg: &Msg, asked: &str, needs: &HashSet<String>, keep: Option<&str>) -> Value {
    let ids: Vec<&str> = keep.unwrap_or("").split(',').filter(|s| !s.is_empty()).take(NEAR_KEEP_MAX).collect();
    let walk: HashSet<String> = if asked == "needs" && !ids.is_empty() { needs.iter().cloned().chain(ids.iter().map(|s| s.to_string())).collect() } else { needs.clone() };
    let tab = step_tab(msg, asked, &walk);
    let (newer, older) = neighbours_in(newest, rs(msg, "id"), &tab, &walk);
    json!({ "tab": tab, "newer": newer, "older": older })
}
