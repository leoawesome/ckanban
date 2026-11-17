//! `src/board/learn.ts`: the board's pile of lessons, which corrections are new, matching and promotion, the board's
//! rules file, undo by note, the side calls' answers and prompts. Plain helpers on JSON values kept in Bun's key order
//! (the pile and the change log are Bun's files, written byte for byte alike); the daemon side is `learner.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};

use crate::prompts::js::slice16;
use crate::team::notes::{note_text, parse_notes, Note, Scope, ALL_ROLES};

/// Candidates seen once are dropped after this many days.
pub const EXPIRE_DAYS: f64 = 60.0;
/// Most candidates kept per kind.
pub const PILE_CAP: usize = 300;
/// Candidates a matching call is shown.
pub const SHORTLIST: usize = 25;
/// Changes kept in the log.
pub const CHANGES_CAP: usize = 500;
/// Days between tidy passes.
pub const TIDY_DAYS: f64 = 7.0;
pub const DAY: f64 = 86_400_000.0;

// ---- small JSON helpers ----

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `typeof v === "string" ? v.trim() : ""`.
fn str_trim(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|x| crate::prompts::js::trim(x).to_string()).unwrap_or_default()
}

/// `Date.parse` of an ISO time; NaN when it isn't one.
pub fn ms(s: &str) -> f64 {
    ckanban_core::time::parse_date(s).unwrap_or(f64::NAN)
}

/// `emptyPile()`.
pub fn empty_pile() -> Value {
    json!({ "candidates": [], "scanned": {} })
}

/// `{ ...emptyPile(), ...v }` of a read pile (null when it isn't one: `emptyPile()`).
pub fn pile_of(v: Option<Value>) -> Value {
    match v {
        Some(Value::Object(m)) if m.get("candidates").is_some_and(Value::is_array) => {
            let mut out = Map::new();
            out.insert("candidates".into(), Value::Null);
            out.insert("scanned".into(), json!({}));
            for (k, x) in m {
                out.insert(k, x);
            }
            Value::Object(out)
        }
        _ => empty_pile(),
    }
}

pub fn candidates(pile: &Value) -> &Vec<Value> {
    static EMPTY: Vec<Value> = Vec::new();
    pile.get("candidates").and_then(Value::as_array).unwrap_or(&EMPTY)
}

pub fn candidates_mut(pile: &mut Value) -> &mut Vec<Value> {
    if !pile.get("candidates").is_some_and(Value::is_array) {
        pile["candidates"] = json!([]);
    }
    pile["candidates"].as_array_mut().expect("candidates is a list")
}

// ---- Which corrections are new ----

/// `Corrections` (lessons.ts): session entries and the follow-up tickets as JSON.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Corrections {
    pub messages: Vec<Value>,
    pub reopened: bool,
    pub changes_requested: bool,
    /// `{ id, title }`.
    pub follow_ups: Vec<(String, String)>,
}

impl Corrections {
    pub fn to_json(&self) -> Value {
        json!({
            "messages": self.messages, "reopened": self.reopened, "changesRequested": self.changes_requested,
            "followUps": self.follow_ups.iter().map(|(id, title)| json!({ "id": id, "title": title })).collect::<Vec<_>>(),
        })
    }
}

/// `e.uuid || e.at`.
fn msg_key(e: &Value) -> String {
    let u = s(e, "uuid");
    format!("msg:{}", if u.is_empty() { s(e, "at") } else { u })
}

/// `correctionKeys`.
pub fn correction_keys(c: &Corrections) -> Vec<String> {
    let mut out: Vec<String> = c.messages.iter().map(msg_key).collect();
    if c.reopened {
        out.push("reopen".into());
    }
    if c.changes_requested {
        out.push("changes".into());
    }
    out.extend(c.follow_ups.iter().map(|(id, _)| format!("addon:{id}")));
    out
}

/// `newCorrections`.
pub fn new_corrections(c: &Corrections, seen: &[String]) -> Corrections {
    let has: HashSet<&str> = seen.iter().map(String::as_str).collect();
    Corrections {
        messages: c.messages.iter().filter(|e| !has.contains(msg_key(e).as_str())).cloned().collect(),
        reopened: c.reopened && !has.contains("reopen"),
        changes_requested: c.changes_requested && !has.contains("changes"),
        follow_ups: c.follow_ups.iter().filter(|(id, _)| !has.contains(format!("addon:{id}").as_str())).cloned().collect(),
    }
}

/// `ticketKey`: the first ticket of the follow-up chain. `tickets`: (id, madeFrom).
pub fn ticket_key(slug: &str, id: &str, made_from: Option<&str>, tickets: &[(String, Option<String>)]) -> String {
    let by_id: HashMap<&str, Option<&str>> = tickets.iter().map(|(i, m)| (i.as_str(), m.as_deref())).collect();
    let mut cur = (id, made_from);
    let mut seen = HashSet::new();
    while let Some(m) = cur.1.filter(|m| !m.is_empty()) {
        let Some(next) = by_id.get(m) else { break };
        if seen.contains(cur.0) {
            break;
        }
        seen.insert(cur.0);
        cur = (m, *next);
    }
    format!("ticket:{slug}/{}", cur.0)
}

pub fn huddle_key(slug: &str, hid: &str) -> String {
    format!("huddle:{slug}/{hid}")
}

// ---- Matching and promotion ----

static WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]{3,}").expect("words pattern"));

fn words(s: &str) -> HashSet<String> {
    WORDS.find_iter(&s.to_lowercase()).map(|m| m.as_str().to_string()).collect()
}

/// `sameShelf`.
fn same_shelf(a: &Value, kind: &str, dest: &Value) -> bool {
    if s(a, "kind") != kind {
        return false;
    }
    let ad = &a["dest"];
    if s(dest, "kind") == "rules" || s(ad, "kind") == "rules" {
        return ad.get("slug") == dest.get("slug");
    }
    if s(dest, "scope") == "general" && s(ad, "scope") == "general" {
        true
    } else {
        ad.get("slug") == dest.get("slug")
    }
}

/// `shortlist`: indexes into the pile's candidates.
pub fn shortlist(pile: &Value, kind: &str, dest: &Value, text: &str, n: usize) -> Vec<Value> {
    let pool: Vec<&Value> = candidates(pile).iter().filter(|c| same_shelf(c, kind, dest)).collect();
    if pool.len() <= n {
        return pool.into_iter().cloned().collect();
    }
    let w = words(text);
    let mut scored: Vec<(usize, &Value)> = pool.into_iter().map(|c| (words(s(c, "text")).iter().filter(|x| w.contains(*x)).count(), c)).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| s(b.1, "lastAt").cmp(s(a.1, "lastAt"))));
    scored.into_iter().take(n).map(|(_, c)| c.clone()).collect()
}

/// `sourceCount`.
pub fn source_count(c: &Value) -> usize {
    c.get("sources").and_then(Value::as_array).map_or(0, |a| a.iter().map(|x| s(x, "key")).collect::<HashSet<_>>().len())
}

fn truthy(v: Option<&Value>) -> bool {
    ckanban_core::jsnum::truthy(v)
}

/// `shouldPromote`.
pub fn should_promote(c: &Value) -> bool {
    s(c, "state") == "watching" && truthy(c.get("general")) && !s(c, "text").is_empty() && (source_count(c) >= 2 || truthy(c.get("standing")))
}

/// `Learned`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Learned {
    pub text: String,
    pub r#match: Option<String>,
    pub standing: Option<String>,
    pub evidence: String,
    pub mistake: String,
}

impl Learned {
    pub fn to_json(&self) -> Value {
        json!({ "text": self.text, "match": self.r#match, "standing": self.standing, "evidence": self.evidence, "mistake": self.mistake })
    }
}

/// `addToPile`: the index of the candidate the lesson went to.
pub fn add_to_pile(pile: &mut Value, l: &Learned, kind: &str, dest: &Value, source: &Value, user_text: Option<&str>, new_id: &mut dyn FnMut() -> String) -> usize {
    let text = note_text(&l.text);
    let standing = match (&l.standing, user_text) {
        (Some(st), Some(u)) if !st.is_empty() && !u.is_empty() => {
            let t = crate::prompts::js::trim(st);
            u.to_lowercase().contains(&t.to_lowercase()) && crate::prompts::js::len16(t) > 2
        }
        _ => false,
    };
    let at = s(source, "at").to_string();
    let hit = l.r#match.as_ref().and_then(|m| candidates(pile).iter().position(|c| s(c, "id") == m && same_shelf(c, kind, dest)));
    if let Some(i) = hit {
        let hit = &mut candidates_mut(pile)[i];
        let key = s(source, "key").to_string();
        let sources = hit.get_mut("sources").and_then(Value::as_array_mut);
        if let Some(src) = sources
            && !src.iter().any(|x| s(x, "key") == key && s(x, "at") == at)
        {
            src.push(source.clone());
        }
        hit["lastAt"] = Value::String(at);
        if standing {
            hit["standing"] = Value::Bool(true);
        }
        if s(hit, "state") == "watching" && !text.is_empty() && (!truthy(hit.get("general")) || s(hit, "text").is_empty()) {
            hit["text"] = Value::String(text.clone());
            hit["general"] = Value::Bool(true);
        }
        if s(&hit["dest"], "kind") == "notes" && s(dest, "kind") == "notes" && s(hit, "state") == "watching" {
            if s(&hit["dest"], "role") != s(dest, "role") {
                hit["dest"]["role"] = Value::String(ALL_ROLES.into());
            }
            if s(dest, "scope") == "general" || hit["dest"].get("slug") != dest.get("slug") {
                hit["dest"]["scope"] = Value::String("general".into());
            }
        }
        return i;
    }
    let mut c = Map::new();
    c.insert("id".into(), Value::String(new_id()));
    c.insert("kind".into(), Value::String(kind.into()));
    let shown = if text.is_empty() { note_text(s(source, "quote")) } else { text.clone() };
    c.insert("text".into(), Value::String(shown));
    c.insert("general".into(), Value::Bool(!text.is_empty()));
    c.insert("dest".into(), dest.clone());
    c.insert("sources".into(), json!([source]));
    c.insert("firstAt".into(), Value::String(at.clone()));
    c.insert("lastAt".into(), Value::String(at));
    c.insert("state".into(), Value::String("watching".into()));
    if standing {
        c.insert("standing".into(), Value::Bool(true));
    }
    let list = candidates_mut(pile);
    list.push(Value::Object(c));
    list.len() - 1
}

/// `prune`: `{ ...pile, candidates }`.
pub fn prune(pile: &mut Value, now_ms: f64, cap: usize) {
    let cut = now_ms - EXPIRE_DAYS * DAY;
    let mut cs: Vec<Value> = candidates(pile)
        .iter()
        .filter(|c| !(s(c, "state") == "watching" && source_count(c) < 2 && ms(s(c, "lastAt")) < cut))
        .cloned()
        .collect();
    for kind in ["ticket", "huddle"] {
        let mine: Vec<usize> = (0..cs.len()).filter(|&i| s(&cs[i], "kind") == kind).collect();
        if mine.len() <= cap {
            continue;
        }
        let mut order: Vec<usize> = mine.iter().copied().filter(|&i| matches!(s(&cs[i], "state"), "watching" | "saved")).collect();
        let rank = |i: usize| if s(&cs[i], "state") == "watching" { 0 } else { 1 };
        order.sort_by(|&a, &b| rank(a).cmp(&rank(b)).then_with(|| s(&cs[a], "lastAt").cmp(s(&cs[b], "lastAt"))));
        let drop: HashSet<usize> = order.into_iter().take(mine.len() - cap).collect();
        cs = cs.into_iter().enumerate().filter(|(i, _)| !drop.contains(i)).map(|(_, c)| c).collect();
    }
    pile["candidates"] = Value::Array(cs);
}

// ---- The board's rules file ----

/// `serializeRules`.
pub fn serialize_rules(notes: &[Note]) -> String {
    let mut out = String::from(
        "# Lessons learned on this board\n<!-- Newest first. Every run on this board gets these. Undo them from the Team tab's Learned view. -->\n\n",
    );
    for n in notes {
        let mut src = vec![if n.by == "you" { "by you".to_string() } else { format!("from @{}", n.by) }];
        src.extend(n.date.clone().filter(|d| !d.is_empty()));
        out.push_str(&format!("- {} <!-- {} -->\n", note_text(&n.text), src.join(", ")));
    }
    out
}

/// `rulesBlock`: the rules as a block for a run's first prompt; "" for none.
pub fn rules_block(rules: &[Note]) -> String {
    if rules.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = rules.iter().take(30).map(|r| format!("- {}", note_text(&r.text))).collect();
    format!(
        "# Lessons learned on this board\nThe board saved these from corrections the user made on earlier tickets. Follow them unless this ticket or the user says otherwise:\n{}",
        lines.join("\n")
    )
}

/// `learnedRulesBlock`: the board's learned rules file as a run's prompt block.
pub fn learned_rules_block(root: &std::path::Path, slug: &str) -> String {
    match std::fs::read_to_string(rules_path(root, slug)) {
        Ok(t) => rules_block(&parse_notes(&t)),
        Err(_) => String::new(),
    }
}

/// `Store.boardRulesPath`.
pub fn rules_path(root: &std::path::Path, slug: &str) -> std::path::PathBuf {
    ckanban_core::DataDir::new(root).profile_dir(slug).join("learned-rules.md")
}

// ---- Undo and redo ----

fn key(n: &Note) -> String {
    note_text(&n.text).to_lowercase()
}

fn texts(md: Option<&str>) -> Vec<Note> {
    md.map(parse_notes).unwrap_or_default()
}

/// Counts by key, keys in first-seen order (a JS Map).
fn counts(ns: &[Note]) -> Vec<(String, usize)> {
    let mut out: Vec<(String, usize)> = Vec::new();
    for n in ns {
        let k = key(n);
        match out.iter_mut().find(|(x, _)| *x == k) {
            Some(e) => e.1 += 1,
            None => out.push((k, 1)),
        }
    }
    out
}

fn count_of(c: &[(String, usize)], k: &str) -> usize {
    c.iter().find(|(x, _)| x == k).map_or(0, |e| e.1)
}

fn nth(ns: &[Note], k: &str, n: usize) -> isize {
    let mut seen = 0;
    let mut last = -1;
    for (i, x) in ns.iter().enumerate() {
        if key(x) != k {
            continue;
        }
        last = i as isize;
        seen += 1;
        if seen == n {
            return i as isize;
        }
    }
    last
}

/// `shiftNotes`.
pub fn shift_notes(current: &[Note], from: Option<&str>, to: Option<&str>) -> Vec<Note> {
    let a = texts(from);
    let b = texts(to);
    let in_a = counts(&a);
    let in_b = counts(&b);
    let mut out: Vec<Note> = current.to_vec();
    let mut was: isize = -1;
    for (k, n) in &in_a {
        let mut extra = *n as isize - count_of(&in_b, k) as isize;
        while extra > 0 {
            let Some(i) = out.iter().position(|x| key(x) == *k) else { break };
            let i = i as isize;
            if was < 0 || i < was {
                was = i;
            }
            out.remove(i as usize);
            extra -= 1;
        }
    }
    let mut rank: HashMap<String, usize> = HashMap::new();
    let ranks: Vec<usize> = b
        .iter()
        .map(|n| {
            let r = rank.get(&key(n)).copied().unwrap_or(0) + 1;
            rank.insert(key(n), r);
            r
        })
        .collect();
    for (i, n) in b.iter().enumerate() {
        let k = key(n);
        if ranks[i] <= count_of(&in_a, &k) || count_of(&counts(&out), &k) >= ranks[i] {
            continue;
        }
        let mut at: isize = -1;
        if was >= 0 {
            at = was.min(out.len() as isize);
            was = -1;
        }
        let mut j = i as isize - 1;
        while j >= 0 && at < 0 {
            let x = nth(&out, &key(&b[j as usize]), ranks[j as usize]);
            if x >= 0 {
                at = x + 1;
            }
            j -= 1;
        }
        let mut j = i + 1;
        while j < b.len() && at < 0 {
            at = nth(&out, &key(&b[j]), ranks[j]);
            j += 1;
        }
        out.insert(at.max(0) as usize, n.clone());
    }
    out
}

// ---- Side call answers ----

/// `jsonObject`: the first `{` to the last `}`, parsed; None when it isn't an object (arrays count, as in Bun).
pub fn json_object(text: &str) -> Option<Value> {
    let from = text.find('{')?;
    let to = text.rfind('}')?;
    if to < from {
        return None;
    }
    let v = crate::runs::js::parse(&text[from..=to])?;
    (v.is_object() || v.is_array()).then_some(v)
}

/// `l?.rule ?? l?.text`.
fn rule_or_text(l: &Value) -> Option<&Value> {
    match l.get("rule") {
        Some(Value::Null) | None => l.get("text"),
        x => x,
    }
}

/// `parseLearned`.
pub fn parse_learned(text: &str, ids: &[String], max: usize, keep_empty: bool) -> Option<Vec<Learned>> {
    let v = json_object(text)?;
    let lessons = v.get("lessons")?.as_array()?;
    let mut out = Vec::new();
    for l in lessons {
        let t = slice16(&note_text(&str_trim(rule_or_text(l))), 300).to_string();
        let m = str_trim(l.get("match"));
        if t.is_empty() && m.is_empty() && !keep_empty {
            continue;
        }
        let standing = str_trim(l.get("standing"));
        out.push(Learned {
            text: t,
            r#match: (!m.is_empty() && ids.contains(&m)).then_some(m),
            standing: (!standing.is_empty()).then_some(standing),
            evidence: slice16(&note_text(&str_trim(l.get("evidence"))), 300).to_string(),
            mistake: slice16(&note_text(&str_trim(l.get("mistake"))), 300).to_string(),
        });
    }
    out.truncate(max);
    Some(out)
}

/// One note in a tidy call's numbered list; `uid` stands in for the note object's identity in Bun.
#[derive(Clone, Debug, PartialEq)]
pub struct TidyNote {
    pub role: String,
    pub note: Note,
    pub uid: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TidyOp {
    Merge { ids: Vec<usize>, text: String, to: String, why: String },
    Rewrite { id: usize, text: String, to: String, why: String },
    Remove { id: usize, why: String },
}

impl TidyOp {
    pub fn to_json(&self) -> Value {
        match self {
            TidyOp::Merge { ids, text, to, why } => json!({ "op": "merge", "ids": ids, "text": text, "to": to, "why": why }),
            TidyOp::Rewrite { id, text, to, why } => json!({ "op": "rewrite", "id": id, "text": text, "to": to, "why": why }),
            TidyOp::Remove { id, why } => json!({ "op": "remove", "id": id, "why": why }),
        }
    }
    pub fn ids(&self) -> Vec<usize> {
        match self {
            TidyOp::Merge { ids, .. } => ids.clone(),
            TidyOp::Rewrite { id, .. } | TidyOp::Remove { id, .. } => vec![*id],
        }
    }
}

/// `Number.isInteger(n)` as a 1-based index.
fn int_of(v: &Value) -> Option<f64> {
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0).then_some(f)
}

/// JS SameValueZero for the values a Set keeps apart.
fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b && !a.is_object() && !a.is_array(),
    }
}

/// `parseTidy`.
pub fn parse_tidy(text: &str, list: &[TidyNote], roles: &[String]) -> Option<Vec<TidyOp>> {
    let v = json_object(text)?;
    let ops = v.get("ops")?.as_array()?;
    let mut used: HashSet<usize> = list.iter().enumerate().filter(|(_, n)| n.note.by == "you").map(|(i, _)| i + 1).collect();
    let ok = |n: &Value, used: &HashSet<usize>| int_of(n).is_some_and(|f| f >= 1.0 && f <= list.len() as f64 && !used.contains(&(f as usize)));
    let role = |to: Option<&Value>, first: usize| match to.and_then(Value::as_str).map(crate::prompts::js::trim) {
        Some(t) if roles.iter().any(|r| r == t) => t.to_string(),
        _ => list[first - 1].role.clone(),
    };
    let mut out = Vec::new();
    for o in ops {
        let why = slice16(&note_text(&str_trim(o.get("why"))), 200).to_string();
        let t = slice16(&note_text(&str_trim(o.get("text"))), 400).to_string();
        let ids: Vec<Value> = match o.get("ids") {
            Some(Value::Array(a)) => {
                let mut u: Vec<Value> = Vec::new();
                for x in a {
                    if !u.iter().any(|y| same(x, y)) {
                        u.push(x.clone());
                    }
                }
                u
            }
            _ => match o.get("id") {
                Some(x) => vec![x.clone()],
                None => vec![],
            },
        };
        fn to_of(o: &Value) -> Option<&Value> {
            match o.get("to") {
                Some(Value::Null) | None => o.get("file"),
                x => x,
            }
        }
        match o.get("op").and_then(Value::as_str) {
            Some("merge") => {
                if ids.len() < 2 || !ids.iter().all(|n| ok(n, &used)) || t.is_empty() {
                    continue;
                }
                let ns: Vec<usize> = ids.iter().map(|n| int_of(n).unwrap() as usize).collect();
                used.extend(ns.iter().copied());
                let to = role(to_of(o), ns[0]);
                out.push(TidyOp::Merge { ids: ns, text: t, to, why });
            }
            Some("rewrite") => {
                if ids.len() != 1 || !ok(&ids[0], &used) || t.is_empty() {
                    continue;
                }
                let id = int_of(&ids[0]).unwrap() as usize;
                used.insert(id);
                let to = role(to_of(o), id);
                if t == note_text(&list[id - 1].note.text) && to == list[id - 1].role {
                    continue;
                }
                out.push(TidyOp::Rewrite { id, text: t, to, why });
            }
            Some("remove") => {
                if ids.len() != 1 || !ok(&ids[0], &used) {
                    continue;
                }
                let id = int_of(&ids[0]).unwrap() as usize;
                used.insert(id);
                out.push(TidyOp::Remove { id, why });
            }
            _ => {}
        }
    }
    Some(out)
}

/// Role files in key order, each note with its identity.
pub type Files = Vec<(String, Vec<(usize, Note)>)>;

fn file_of<'a>(files: &'a Files, role: &str) -> Option<&'a Vec<(usize, Note)>> {
    files.iter().find(|(r, _)| r == role).map(|(_, v)| v)
}

/// `applyTidyOp`. `next_uid` gives the new note its identity.
pub fn apply_tidy_op(files: &Files, op: &TidyOp, list: &[TidyNote], today: &str, next_uid: &mut usize) -> Files {
    let ids = op.ids();
    let refs: Vec<&TidyNote> = ids.iter().map(|n| &list[n - 1]).collect();
    let gone: HashSet<usize> = refs.iter().map(|r| r.uid).collect();
    let mut out: Files = files.iter().map(|(r, ns)| (r.clone(), ns.iter().filter(|(u, _)| !gone.contains(u)).cloned().collect())).collect();
    let (text, to) = match op {
        TidyOp::Remove { .. } => return out,
        TidyOp::Merge { text, to, .. } | TidyOp::Rewrite { text, to, .. } => (text, to),
    };
    let first = refs[0];
    let mut note = first.note.clone();
    note.text = text.clone();
    if matches!(op, TidyOp::Merge { .. }) {
        note.date = Some(today.to_string());
    }
    *next_uid += 1;
    let uid = *next_uid;
    let first_file = file_of(files, &first.role).cloned().unwrap_or_default();
    let at: isize = if *to == first.role { first_file.iter().position(|(u, _)| *u == first.uid).map_or(-1, |i| i as isize) } else { 0 };
    let place = if at <= 0 { 0 } else { first_file[..at as usize].iter().filter(|(u, _)| !gone.contains(u)).count() };
    match out.iter_mut().find(|(r, _)| r == to) {
        Some((_, v)) => {
            let place = place.min(v.len());
            v.insert(place, (uid, note));
        }
        None => out.push((to.clone(), vec![(uid, note)])),
    }
    out
}

// ---- Prompts ----

const GENERAL: &str = "A lesson is one short rule (at most 200 characters) that would help on a different task: what to do and when. No ticket or issue ids, ticket names, people, message numbers, counts, or paths and examples that only fit this one task (a command or file name only when the rule can't be followed without it).";

const PLAIN: &str = "Write for a person who is not technical: plain everyday words. No filler, no em dashes, no arrows standing in for words, no made-up abbreviations. Write in the language the user writes in.";

pub static LEARN_SYSTEM: LazyLock<String> = LazyLock::new(|| {
    format!(
        "You help an AI coding assistant (Claude) stop repeating mistakes on a person's project. You get a finished task: what was asked, the conversation, the user's corrections, and PILE: lessons noted on earlier tasks, each as [id] text.

Find mistakes Claude made that the user had to correct. Only count one that would come back on other tasks in this project; skip one-off slips, changes of mind, and new wishes that were not mistakes. Return 0 to 3 lessons; fewer is better, and none is often the honest answer.

{GENERAL} When the mistake can't be put that way, set rule to \"\".

For each lesson, set match to the id of the PILE lesson that says the same thing (following one makes following the other unnecessary), or \"\" when none does.
Set standing to the user's exact words, copied character for character from what they typed, only when they said the rule holds from now on (\"always\", \"never\", \"from now on\", \"every time\", or the same in their language); otherwise \"\".

Answer with JSON only, no other text:
{{\"lessons\":[{{\"mistake\":\"...\",\"evidence\":\"...\",\"rule\":\"...\",\"match\":\"\",\"standing\":\"\"}}]}}
- mistake: what went wrong, one plain sentence.
- evidence: the user's own words that corrected it, quoted exactly (shorten with … if long).

{PLAIN}"
    )
});

pub static HUDDLE_LEARN_SYSTEM: LazyLock<String> = LazyLock::new(|| {
    format!(
        "You keep the notes that helper AI agents (huddle teammates) get in their instructions. An agent that finished its job proposed lessons for future agents. You also get PILE: lessons noted before, each as [id] text.

For each proposed lesson, in order:
- rule: the lesson rewritten as a general rule. {GENERAL} When it can't be put that way, \"\".
- match: the id of the PILE lesson that says the same thing (following one makes following the other unnecessary), or \"\".

Answer with JSON only, no other text, one entry per proposed lesson:
{{\"lessons\":[{{\"rule\":\"...\",\"match\":\"\"}}]}}

{PLAIN}"
    )
});

pub static TIDY_SYSTEM: LazyLock<String> = LazyLock::new(|| {
    format!(
        "You tidy the notes that helper AI agents (huddle teammates) get in their instructions. Fewer, sharper notes are better: extra notes distract the agents. You get the notes as a numbered list, each with the file (role) it is in; \"_all\" is read by every role.

For each note that should change, return one step:
- \"rewrite\": the note in general words, or moved to another file with \"to\" (a general note in one role's file goes to \"_all\"). {GENERAL}
- \"merge\": two or more notes that say the same thing become one, in \"to\" (\"_all\" when they come from different roles).
- \"remove\": a note that only fit one task, a stale fact, or one another note already covers.
Leave good notes out (no step means keep). Never invent a rule that isn't in the notes. Every step needs \"why\": one short plain sentence.

Answer with JSON only, no other text:
{{\"ops\":[{{\"op\":\"rewrite\",\"id\":3,\"text\":\"...\",\"to\":\"_all\",\"why\":\"...\"}},{{\"op\":\"merge\",\"ids\":[1,4],\"text\":\"...\",\"to\":\"_all\",\"why\":\"...\"}},{{\"op\":\"remove\",\"id\":2,\"why\":\"...\"}}]}}

{PLAIN}"
    )
});

/// `pileText`.
pub fn pile_text(cs: &[Value]) -> String {
    if cs.is_empty() {
        return "(empty)".into();
    }
    cs.iter().map(|c| format!("[{}] {}", s(c, "id"), s(c, "text"))).collect::<Vec<_>>().join("\n")
}

/// `huddleLearnPrompt`: lessons as (text, evidence).
pub fn huddle_learn_prompt(role: &str, lessons: &[(String, String)], pile: &[Value]) -> String {
    let list: Vec<String> = lessons
        .iter()
        .enumerate()
        .map(|(i, (t, e))| format!("{}. {t}{}", i + 1, if e.is_empty() { String::new() } else { format!(" (evidence: {e})") }))
        .collect();
    [format!("Proposed by an agent in the role \"{role}\":"), list.join("\n"), format!("PILE:\n{}", pile_text(pile))].join("\n\n")
}

/// `tidyPrompt`.
pub fn tidy_prompt(list: &[TidyNote], roles: &[String]) -> String {
    let notes: Vec<String> = list.iter().enumerate().map(|(i, n)| format!("{}. ({}) {}", i + 1, n.role, note_text(&n.note.text))).collect();
    [format!("Files: {}", roles.join(", ")), format!("Notes:\n{}", notes.join("\n"))].join("\n\n")
}

/// `whereText`: where a lesson went, in plain words.
pub fn where_text(d: &Value) -> String {
    if s(d, "kind") == "rules" {
        return "Rule for this board".into();
    }
    let role = s(d, "role");
    let who = if role == ALL_ROLES { "every teammate" } else { role };
    format!("Note for {who}{}", if s(d, "scope") == "general" { ", all boards" } else { "" })
}

/// A note's scope name.
pub fn scope_of(d: &Value) -> Scope {
    if s(d, "scope") == "general" { Scope::General } else { Scope::Repo }
}
