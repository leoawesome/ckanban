//! Wait records (`src/helper/waits.ts`): one per (ticket, thing it waits on), in `<root>/waits.json`, written whole
//! (one-space indent, fixed `.tmp`, a final newline) on every change, keys in Bun's order. Pure bookkeeping.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::datafile;
use ckanban_core::jsnum::num;
use ckanban_core::time::{iso, parse_date};
use serde_json::{Map, Value, json};

pub type Rec = Map<String, Value>;

pub const CLOSED_KEEP_MS: f64 = 7.0 * 24.0 * 3_600_000.0;
pub const FALLBACK_MS: f64 = 5.0 * 60_000.0;
pub const BOOT_GRACE_MS: f64 = 2.0 * 60_000.0;
pub const DIGEST_MS: f64 = 4.0 * 3_600_000.0;

/// How the waits file was found at start-up.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WaitsStart {
    Missing,
    Present,
    Corrupt,
}

// ---- reading a record ----

pub fn rs<'a>(r: &'a Rec, k: &str) -> &'a str {
    r.get(k).and_then(Value::as_str).unwrap_or("")
}
/// A string field, None when missing, null or empty (JS truthiness of a string).
pub fn ro<'a>(r: &'a Rec, k: &str) -> Option<&'a str> {
    r.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}
pub fn rb(r: &Rec, k: &str) -> bool {
    crate::runs::js::truthy(r.get(k))
}
/// `Date.parse` of a field (NaN when missing).
pub fn rms(r: &Rec, k: &str) -> f64 {
    ro(r, k).and_then(parse_date).unwrap_or(f64::NAN)
}
pub fn reminders(r: &Rec) -> &[Value] {
    r.get("reminders").and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[])
}
fn vs<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}
pub fn step_sent(x: &Value) -> bool {
    vs(x, "sentAt").is_some()
}
pub fn step_flag(x: &Value, k: &str) -> bool {
    crate::runs::js::truthy(x.get(k))
}
/// A reminder step not sent yet.
pub fn pending(r: &Rec) -> bool {
    reminders(r).iter().any(|s| !step_sent(s))
}
/// An urgent alert or one of its steps reached the user.
pub fn alerted(r: &Rec) -> bool {
    reminders(r).iter().any(|x| step_sent(x) && !step_flag(x, "failed") && !step_flag(x, "skipped"))
}
/// Steps this wait has used so far.
pub fn steps_used(r: &Rec) -> f64 {
    let before = r.get("stepsUsed").and_then(Value::as_f64).unwrap_or(0.0);
    before + reminders(r).iter().filter(|x| step_sent(x) && !step_flag(x, "skipped")).count() as f64
}
pub fn is_open(r: &Rec) -> bool {
    ro(r, "closedAt").is_none()
}
/// `closedAt === null` (an open record under that key).
pub fn closed_null(r: Option<&Rec>) -> bool {
    r.is_some_and(|r| matches!(r.get("closedAt"), Some(Value::Null)))
}

/// What a told mark replaces, to give it back.
#[derive(Clone, Debug)]
pub struct Claim {
    pub key: String,
    pub told_at: Value,
    pub told_via: Value,
    pub fallback_at: Value,
    pub digest_at: Value,
}

pub fn claim_of(r: &Rec) -> Claim {
    let g = |k: &str| r.get(k).cloned().unwrap_or(Value::Null);
    Claim { key: rs(r, "key").to_string(), told_at: g("toldAt"), told_via: g("toldVia"), fallback_at: g("fallbackAt"), digest_at: g("digestAt") }
}

/// What opening a record needs.
#[derive(Clone, Debug, PartialEq)]
pub struct NewWait {
    pub board: String,
    pub ticket_id: String,
    pub kind: String,
    pub identity: String,
    pub question: String,
    pub label: String,
    pub since: String,
    pub urgent: bool,
    pub why: Option<String>,
}

pub fn normalize_question(text: &str) -> String {
    crate::runs::js::trim(&crate::runs::js::squash_ws(text)).to_lowercase()
}

pub fn question_hash(text: &str) -> String {
    crate::chat::sha256::hex(normalize_question(text).as_bytes())[..16].to_string()
}

/// What makes a wait "the same wait" for a ticket.
pub fn wait_identity(kind: &str, question: Option<&str>) -> String {
    match question.filter(|q| !q.is_empty()) {
        Some(q) if kind == "questions" => format!("q:{}", question_hash(q)),
        Some(q) if kind == "message" => format!("m:{}", question_hash(q)),
        _ => kind.to_string(),
    }
}

pub fn record_key(board: &str, ticket_id: &str, identity: &str) -> String {
    format!("{board}/{ticket_id}|{identity}")
}

/// Records as read from disk, made safe to use (`normalizeRecords`).
pub fn normalize_records(raw: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let str_of = |r: &Map<String, Value>, k: &str| r.get(k).and_then(Value::as_str).map(str::to_string);
    for (k, v) in raw {
        let Some(r) = v.as_object() else { continue };
        let (Some(board), Some(ticket)) = (str_of(r, "board").filter(|s| !s.is_empty()), str_of(r, "ticketId").filter(|s| !s.is_empty())) else { continue };
        let reminders: Vec<Value> = r
            .get("reminders")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|x| x.get("channel").is_some_and(Value::is_string) && x.get("dueAt").is_some_and(Value::is_string)).cloned().collect())
            .unwrap_or_default();
        let opt = |k: &str| str_of(r, k).map(Value::String).unwrap_or(Value::Null);
        // `??`: an empty string is kept.
        let since = str_of(r, "since").or_else(|| str_of(r, "queuedAt")).unwrap_or_else(|| iso(0.0));
        let queued = str_of(r, "queuedAt").or_else(|| str_of(r, "since")).unwrap_or_else(|| iso(0.0));
        let mut m = r.clone();
        m.insert("key".into(), k.clone().into());
        m.insert("board".into(), board.into());
        m.insert("ticketId".into(), ticket.into());
        m.insert("kind".into(), str_of(r, "kind").unwrap_or_else(|| "message".into()).into());
        m.insert("question".into(), str_of(r, "question").unwrap_or_default().into());
        m.insert("label".into(), str_of(r, "label").unwrap_or_default().into());
        m.insert("since".into(), since.into());
        m.insert("queuedAt".into(), queued.into());
        m.insert("toldAt".into(), opt("toldAt"));
        m.insert("toldVia".into(), opt("toldVia"));
        m.insert("fallbackAt".into(), opt("fallbackAt"));
        m.insert("digestAt".into(), opt("digestAt"));
        m.insert("reminders".into(), Value::Array(reminders));
        m.insert("closedAt".into(), opt("closedAt"));
        out.insert(k.clone(), Value::Object(m));
    }
    out
}

/// `recordForMessage`: the record a message's item meant.
pub fn record_for_message<'a>(all: impl Iterator<Item = &'a Rec>, key: &str, id: &str, at: &str) -> Option<&'a Rec> {
    let prefix = format!("{key}#");
    let recs: Vec<&Rec> = all.filter(|r| rs(r, "key") == key || rs(r, "key").starts_with(&prefix)).collect();
    if let Some(r) = recs.iter().find(|r| ro(r, "messageId") == Some(id) || reminders(r).iter().any(|s| vs(s, "messageId") == Some(id))) {
        return Some(r);
    }
    let at = parse_date(at).unwrap_or(f64::NAN);
    let mut c: Vec<&Rec> = recs.into_iter().filter(|r| !(rms(r, "queuedAt") > at)).collect();
    // A stable sort, newest queued first (NaN compares as equal, as JS's comparator gives NaN).
    c.sort_by(|a, b| {
        let d = rms(b, "queuedAt") - rms(a, "queuedAt");
        if d > 0.0 { std::cmp::Ordering::Greater } else if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }
    });
    c.first().copied()
}

pub type Closed = Arc<dyn Fn(Vec<Rec>) + Send + Sync>;

/// The waits file (`WaitStore`).
pub struct WaitStore {
    pub file: PathBuf,
    pub start: WaitsStart,
    pub boot_at: f64,
    records: Map<String, Value>,
    notify_user_at: Map<String, Value>,
    first_summary_pending: Option<bool>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub on_closed: Option<Closed>,
}

impl WaitStore {
    pub fn new(root: &Path, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> WaitStore {
        let file = root.join("waits.json");
        let mut w = WaitStore { file, start: WaitsStart::Missing, boot_at: now(), records: Map::new(), notify_user_at: Map::new(), first_summary_pending: None, now, on_closed: None };
        w.start = w.load();
        w
    }

    fn load(&mut self) -> WaitsStart {
        let text = match std::fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return WaitsStart::Missing,
            Err(e) => return self.aside(&e.to_string()),
        };
        let v = datafile::parse_json(&text);
        let recs = v.as_ref().and_then(|v| v.get("records")).filter(|r| r.is_object() || r.is_array());
        let Some(recs) = recs else { return self.aside(if v.is_none() { "not JSON" } else { "no records" }) };
        let v = v.as_ref().expect("checked");
        self.records = recs.as_object().map(normalize_records).unwrap_or_default();
        self.notify_user_at = v.get("notifyUserAt").and_then(Value::as_object).cloned().unwrap_or_default();
        self.first_summary_pending = Some(crate::runs::js::truthy(v.get("firstSummaryPending")));
        WaitsStart::Present
    }

    fn aside(&self, why: &str) -> WaitsStart {
        let aside = format!("{}.corrupt-{}", self.file.display(), (self.now)() as i64);
        let _ = std::fs::rename(&self.file, &aside);
        eprintln!("helper: waits.json could not be read ({why}); set aside as {aside}");
        WaitsStart::Corrupt
    }

    pub fn save(&self) {
        let mut m = Map::new();
        m.insert("version".into(), json!(1));
        m.insert("records".into(), Value::Object(self.records.clone()));
        m.insert("notifyUserAt".into(), Value::Object(self.notify_user_at.clone()));
        if let Some(f) = self.first_summary_pending {
            m.insert("firstSummaryPending".into(), f.into());
        }
        if let Err(e) = datafile::write_json(&self.file, &Value::Object(m), datafile::formats::WAITS) {
            eprintln!("helper: can't write waits.json: {e}");
        }
    }

    pub fn first_summary_pending(&self) -> bool {
        self.first_summary_pending == Some(true)
    }

    pub fn set_first_summary_pending(&mut self, v: bool) {
        self.first_summary_pending = Some(v);
        self.save();
    }

    pub fn get(&self, key: &str) -> Option<&Rec> {
        self.records.get(key).and_then(Value::as_object)
    }

    pub fn all(&self) -> impl Iterator<Item = &Rec> {
        self.records.values().filter_map(Value::as_object)
    }

    pub fn all_values(&self) -> Vec<Value> {
        self.records.values().cloned().collect()
    }

    pub fn open(&self) -> Vec<Rec> {
        self.all().filter(|r| is_open(r)).cloned().collect()
    }

    pub fn open_for(&self, board: &str, ticket: Option<&str>) -> Vec<Rec> {
        self.all().filter(|r| is_open(r) && rs(r, "board") == board && ticket.is_none_or(|t| rs(r, "ticketId") == t)).cloned().collect()
    }

    pub fn for_message(&self, key: &str, id: &str, at: &str) -> Option<Rec> {
        record_for_message(self.all(), key, id, at).cloned()
    }

    pub fn fallback_for(&self, queued: f64) -> String {
        iso((queued + FALLBACK_MS).max(self.boot_at + BOOT_GRACE_MS))
    }

    /// Opens a record (or returns the open one with that key). told: already told another way.
    pub fn add(&mut self, w: &NewWait, seeded: bool, told: Option<&str>) -> Rec {
        let key = record_key(&w.board, &w.ticket_id, &w.identity);
        if let Some(have) = self.records.get_mut(&key).and_then(Value::as_object_mut)
            && is_open(have)
        {
            if w.urgent && !rb(have, "urgent") {
                have.insert("urgent".into(), true.into());
                let why = w.why.clone().map(Value::String).or_else(|| have.get("why").filter(|x| !x.is_null()).cloned()).unwrap_or(Value::Null);
                have.insert("why".into(), why);
                let out = have.clone();
                self.save();
                return out;
            }
            return have.clone();
        }
        if let Some(Value::Object(have)) = self.records.shift_remove(&key) {
            let k = format!("{key}#{}", rs(&have, "since"));
            let mut have = have;
            have.insert("key".into(), k.clone().into());
            self.records.insert(k, Value::Object(have));
        }
        let now = (self.now)();
        let mut r = Map::new();
        r.insert("key".into(), key.clone().into());
        r.insert("board".into(), w.board.clone().into());
        r.insert("ticketId".into(), w.ticket_id.clone().into());
        r.insert("kind".into(), w.kind.clone().into());
        r.insert("question".into(), w.question.clone().into());
        r.insert("label".into(), w.label.clone().into());
        r.insert("since".into(), w.since.clone().into());
        r.insert("queuedAt".into(), iso(now).into());
        if seeded {
            r.insert("seeded".into(), true.into());
        }
        if w.urgent {
            r.insert("urgent".into(), true.into());
        }
        r.insert("why".into(), w.why.clone().map(Value::String).unwrap_or(Value::Null));
        r.insert("toldAt".into(), if told.is_some() { iso(now).into() } else { Value::Null });
        r.insert("toldVia".into(), told.map(|t| Value::String(t.into())).unwrap_or(Value::Null));
        let quiet = seeded || told.is_some();
        r.insert("fallbackAt".into(), if quiet { Value::Null } else { self.fallback_for(now).into() });
        r.insert("digestAt".into(), if quiet { Value::Null } else { iso(now + DIGEST_MS).into() });
        r.insert("reminders".into(), json!([]));
        r.insert("closedAt".into(), Value::Null);
        self.records.insert(key, Value::Object(r.clone()));
        self.prune();
        self.save();
        r
    }

    /// Moves an open record to the key of `w` (same wait, known by its real question).
    pub fn rekey(&mut self, from: &str, w: &NewWait) -> Option<Rec> {
        let key = record_key(&w.board, &w.ticket_id, &w.identity);
        let r = self.get(from)?.clone();
        if !is_open(&r) || key == from || closed_null(self.get(&key)) {
            return None;
        }
        if let Some(prev) = self.get(&key).cloned() {
            let k = format!("{key}#{}", rs(&prev, "since"));
            let mut prev = prev;
            prev.insert("key".into(), k.clone().into());
            self.records.insert(k, Value::Object(prev));
        }
        self.records.shift_remove(from);
        let mut moved = r.clone();
        moved.insert("key".into(), key.clone().into());
        moved.insert("question".into(), w.question.clone().into());
        moved.insert("label".into(), w.label.clone().into());
        if w.urgent {
            moved.insert("urgent".into(), true.into());
        }
        let why = w.why.clone().map(Value::String).or_else(|| r.get("why").filter(|x| !x.is_null()).cloned()).unwrap_or(Value::Null);
        moved.insert("why".into(), why);
        self.records.insert(key, Value::Object(moved.clone()));
        self.save();
        Some(moved)
    }

    /// Changes a record (Object.assign) and saves.
    pub fn update(&mut self, key: &str, patch: Vec<(&str, Value)>) -> Option<Rec> {
        let r = self.records.get_mut(key).and_then(Value::as_object_mut)?;
        for (k, v) in patch {
            r.insert(k.into(), v);
        }
        let out = r.clone();
        self.save();
        Some(out)
    }

    pub fn mark_told(&mut self, keys: &[String], via: &str, message_id: Option<&str>) {
        let at = iso((self.now)());
        let mut changed = false;
        for k in keys {
            let Some(r) = self.records.get_mut(k).and_then(Value::as_object_mut) else { continue };
            if ro(r, "toldAt").is_some() {
                continue;
            }
            r.insert("toldAt".into(), at.clone().into());
            r.insert("toldVia".into(), via.into());
            r.insert("messageId".into(), message_id.map(|m| Value::String(m.into())).unwrap_or(Value::Null));
            r.insert("fallbackAt".into(), Value::Null);
            r.insert("digestAt".into(), Value::Null);
            changed = true;
        }
        if changed {
            self.save();
        }
    }

    pub fn unclaim(&mut self, prev: &[Claim]) {
        let mut changed = false;
        for p in prev {
            let Some(r) = self.records.get_mut(&p.key).and_then(Value::as_object_mut) else { continue };
            if p.told_at.as_str().is_some_and(|s| !s.is_empty()) || !is_open(r) {
                continue;
            }
            r.insert("toldAt".into(), Value::Null);
            r.insert("toldVia".into(), Value::Null);
            r.insert("fallbackAt".into(), p.fallback_at.clone());
            r.insert("digestAt".into(), p.digest_at.clone());
            changed = true;
        }
        if changed {
            self.save();
        }
    }

    fn drop_pending(r: &mut Rec, why: &str) {
        let kept: Vec<Value> = reminders(r).iter().filter(|s| step_sent(s)).cloned().collect();
        r.insert("reminders".into(), Value::Array(kept));
        r.insert("remindersStopped".into(), why.into());
    }

    pub fn stop_reminders(&mut self, key: &str, why: &str) -> bool {
        let Some(r) = self.records.get_mut(key).and_then(Value::as_object_mut) else { return false };
        if !pending(r) {
            return false;
        }
        Self::drop_pending(r, why);
        self.save();
        true
    }

    pub fn close(&mut self, keys: &[String], why: &str) -> Vec<Rec> {
        let at = iso((self.now)());
        let mut out = Vec::new();
        for k in keys {
            let Some(r) = self.records.get_mut(k).and_then(Value::as_object_mut) else { continue };
            if !is_open(r) {
                continue;
            }
            if pending(r) {
                Self::drop_pending(r, why);
            }
            r.insert("closedAt".into(), at.clone().into());
            r.insert("closedWhy".into(), why.into());
            r.insert("fallbackAt".into(), Value::Null);
            r.insert("digestAt".into(), Value::Null);
            out.push(r.clone());
        }
        if !out.is_empty() {
            self.save();
            if let Some(f) = &self.on_closed {
                f(out.clone());
            }
        }
        out
    }

    /// The user opened the ticket: openedAt, reminders stop; passed-on messages close.
    pub fn opened(&mut self, board: &str, ticket: &str) -> Vec<Rec> {
        let at = iso((self.now)());
        let keys: Vec<String> = self.open_for(board, Some(ticket)).iter().map(|r| rs(r, "key").to_string()).collect();
        let mut msgs = Vec::new();
        for k in &keys {
            if let Some(r) = self.records.get_mut(k).and_then(Value::as_object_mut) {
                r.insert("openedAt".into(), at.clone().into());
                if pending(r) {
                    Self::drop_pending(r, "opened");
                }
                if rs(r, "kind") == "message" {
                    msgs.push(k.clone());
                }
            }
        }
        if !keys.is_empty() {
            self.save();
        }
        self.close(&msgs, "opened");
        keys.iter().filter_map(|k| self.get(k).cloned()).collect()
    }

    pub fn has_pending_reminder(&self, board: &str, ticket: &str) -> bool {
        self.open_for(board, Some(ticket)).iter().any(pending)
    }

    pub fn last_notify_user(&self, board: &str, ticket: &str) -> Option<f64> {
        self.notify_user_at.get(&format!("{board}/{ticket}")).and_then(Value::as_f64)
    }

    pub fn set_notify_user(&mut self, board: &str, ticket: &str, at: f64) {
        self.notify_user_at.insert(format!("{board}/{ticket}"), num(at));
        self.save();
    }

    fn prune(&mut self) {
        let now = (self.now)();
        let cut = now - CLOSED_KEEP_MS;
        self.records.retain(|_, r| r.as_object().is_none_or(|r| !(ro(r, "closedAt").is_some() && rms(r, "closedAt") < cut)));
        let day = now - 24.0 * 3_600_000.0;
        self.notify_user_at.retain(|_, at| !at.as_f64().is_some_and(|a| a < day));
    }
}
