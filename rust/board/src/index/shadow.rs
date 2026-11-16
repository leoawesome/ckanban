//! Shadow mode (plan 3.4): with `CKANBAN_RUST_SHADOW=1` in front mode, after Bun answers a ticket list request
//! (`GET /api/profiles/:p/tickets?scope=board|done|ids|search|list|count`, `GET /api/tickets`, `GET /api/inbox`), Rust
//! works out its own answer from the files and appends any difference to `<data>/rust-shadow.log`: ids and field
//! names only, never text. Never served, never writes board data.
//!
//! Live fields (`running`, `session`, `devices`, `huddleBusy`, costs...) come from Bun's answer; the Inbox, whose
//! answer carries no live state, reads sessions from `session-summaries.json` (Bun's saved summaries, up to 30 s old).
//! Checks run one at a time on the blocking pool, at most every 10 s per route; a ticket changed between Bun's answer
//! and Rust's read is skipped, not reported. The same difference is logged once until it changes, and the log is
//! cut to its newest half at 5 MB. `<data>/rust-shadow.json` counts the checks.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

use ckanban_core::datafile::{Format, Layout, Replace, write_json};
use ckanban_core::time::{iso, now_ms};
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::links::Comments;
use super::routes::{Reads, param, path_parts};
use super::store::Index;
use super::ticket::Tk;
use super::view::{Live, Viewer};

pub const ENV: &str = "CKANBAN_RUST_SHADOW";
pub const LOG_FILE: &str = "rust-shadow.log";
pub const STATUS_FILE: &str = "rust-shadow.json";
/// One check per route at most this often.
const EVERY: Duration = Duration::from_secs(10);
/// Bun answers larger than this aren't compared (the no-scope listing of a huge board).
const MAX_BODY: usize = 32 * 1024 * 1024;
const LOG_MAX: u64 = 5 * 1024 * 1024;

/// Fields of a ticket view that come from Bun's live state (taken from its answer, not compared).
const LIVE: [&str; 12] =
    ["running", "holdsSlot", "session", "devices", "shareJobs", "terminalOpen", "folderWait", "huddleBusy", "huddleLine", "costUsd", "familyWorking", "stepsRunning"];

/// Whether shadow mode is on for this start (`CKANBAN_RUST_SHADOW=1`).
pub fn enabled() -> bool {
    std::env::var(ENV).is_ok_and(|v| v == "1")
}

/// The route key a request is compared under, or None when shadow mode doesn't look at it.
pub fn route_key(path: &str, query: &str) -> Option<String> {
    let parts = path_parts(path)?;
    match parts.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["inbox"] => Some("GET /api/inbox".into()),
        ["tickets"] => Some(format!("GET /api/tickets scope={}", param(query, "scope").unwrap_or_default())),
        ["profiles", slug, "tickets"] => {
            let scope = param(query, "scope").unwrap_or_default();
            ["board", "done", "ids", "search", "list", "count"].contains(&scope.as_str()).then(|| format!("GET /api/profiles/{slug}/tickets scope={scope}"))
        }
        _ => None,
    }
}

#[derive(Default)]
struct Counts {
    checked: u64,
    differed: u64,
    skipped: u64,
}

pub struct Shadow {
    index: Arc<Index>,
    comments: Arc<Comments>,
    root: PathBuf,
    busy: AtomicBool,
    last: Mutex<HashMap<String, (Instant, String)>>,
    counts: Mutex<Counts>,
    started: String,
    summaries: Mutex<Option<((Option<SystemTime>, u64), Arc<HashMap<String, Value>>)>>,
}

impl Shadow {
    pub fn new(root: &Path) -> Arc<Shadow> {
        Arc::new(Shadow {
            index: Index::new(root),
            comments: Arc::new(Comments::default()),
            root: root.to_path_buf(),
            busy: AtomicBool::new(false),
            last: Mutex::new(HashMap::new()),
            counts: Mutex::new(Counts::default()),
            started: iso(now_ms()),
            summaries: Mutex::new(None),
        })
    }

    /// After Bun answered: compare in the background, unless a check runs now or this route was checked lately.
    pub fn check(self: &Arc<Self>, path: String, query: String, status: u16, body: bytes::Bytes) {
        let Some(key) = route_key(&path, &query) else { return };
        if body.len() > MAX_BODY {
            return;
        }
        if self.last.lock().get(&key).is_some_and(|(at, _)| at.elapsed() < EVERY) {
            return;
        }
        if self.busy.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| me.compare(&key, &path, &query, status, &body)));
            if r.is_err() {
                eprintln!("ckanban-rs: shadow check of {key} failed");
            }
            me.busy.store(false, Ordering::SeqCst);
        });
    }

    /// One comparison (blocking). Returns the difference line, if any (also logged).
    pub fn compare(&self, key: &str, path: &str, query: &str, status: u16, body: &[u8]) -> Option<String> {
        let bun: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let parts = path_parts(path).unwrap_or_default();
        let mut skipped = 0;
        let diffs: Vec<String> = match parts.first().map(String::as_str) {
            Some("inbox") => self.compare_inbox(&bun),
            Some("tickets") => self.compare_cmd(query, &bun),
            _ => {
                let slug = parts.get(1).cloned().unwrap_or_default();
                // Read the board's files now: Bun just answered from its own memory.
                self.index.refresh(&slug);
                let live = Arc::new(BunLive::from_rows(&bun));
                let reads = self.reads(live);
                match reads.answer(path, query) {
                    None => vec!["not answered".into()],
                    Some((st, _)) if st != status => vec![format!("status {status} vs {st}")],
                    Some((_, mine)) => compare_lists(&bun, &mine, &mut skipped),
                }
            }
        };
        let line = (!diffs.is_empty()).then(|| format!("{} {key}: {}", iso(now_ms()), diffs.join("; ")));
        {
            let mut c = self.counts.lock();
            c.checked += 1;
            c.skipped += skipped;
            if line.is_some() {
                c.differed += 1;
            }
        }
        let sig = diffs.join("; ");
        let repeat = {
            let mut last = self.last.lock();
            let same = last.get(key).is_some_and(|(_, s)| *s == sig);
            last.insert(key.to_string(), (Instant::now(), sig));
            same
        };
        if let (Some(l), false) = (&line, repeat) {
            self.append(l);
        }
        self.write_status();
        line
    }

    fn reads(&self, live: Arc<dyn Live>) -> Reads {
        Reads { index: self.index.clone(), viewer: Viewer { index: self.index.clone(), comments: self.comments.clone() }, live }
    }

    fn append(&self, line: &str) {
        let file = self.root.join(LOG_FILE);
        if std::fs::metadata(&file).is_ok_and(|m| m.len() > LOG_MAX) {
            // Keep the newest half.
            if let Ok(text) = std::fs::read_to_string(&file) {
                let cut = text.len() / 2;
                let from = text[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(text.len());
                let _ = ckanban_core::atomic::atomic_write(&file, &text[from..]);
            }
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
            let _ = writeln!(f, "{line}");
        }
    }

    fn write_status(&self) {
        let c = self.counts.lock();
        let v = json!({ "startedAt": self.started, "checked": c.checked, "differed": c.differed, "skipped": c.skipped, "lastAt": iso(now_ms()) });
        drop(c);
        let _ = write_json(&self.root.join(STATUS_FILE), &v, Format { layout: Layout::Indent(2), newline: true, replace: Replace::Atomic, private: false });
    }

    /// Bun's saved session summaries (`session-summaries.json`), read again when the file changes.
    fn summaries(&self) -> Arc<HashMap<String, Value>> {
        let file = self.root.join("session-summaries.json");
        let st = std::fs::metadata(&file).map(|m| (m.modified().ok(), m.len())).unwrap_or((None, 0));
        if let Some((s, v)) = &*self.summaries.lock() {
            if *s == st {
                return v.clone();
            }
        }
        let mut out = HashMap::new();
        if let Ok(Some(Value::Object(m))) = ckanban_core::datafile::read_json(&file) {
            if let Some(Value::Object(items)) = m.get("items") {
                for (sid, item) in items {
                    if let Some(s) = item.get("s") {
                        out.insert(sid.clone(), s.clone());
                    }
                }
            }
        }
        let v = Arc::new(out);
        *self.summaries.lock() = Some((st, v.clone()));
        v
    }

    fn compare_inbox(&self, bun: &Value) -> Vec<String> {
        let profiles = ckanban_core::home::DataDir::new(self.root.clone()).list_profiles().unwrap_or_default();
        for p in &profiles {
            if let Some(s) = p.slug() {
                self.index.refresh(s);
            }
        }
        let live = Arc::new(BunLive { rows: HashMap::new(), sessions: Some(self.summaries()) });
        let (_, mine) = self.reads(live).inbox();
        let key = |v: &Value| format!("{}/{}", v.get("profile").and_then(Value::as_str).unwrap_or(""), v.get("id").and_then(Value::as_str).unwrap_or(""));
        compare_rows(bun, &mine, key, &[])
    }

    fn compare_cmd(&self, query: &str, bun: &Value) -> Vec<String> {
        let profiles = ckanban_core::home::DataDir::new(self.root.clone()).list_profiles().unwrap_or_default();
        for p in &profiles {
            if let Some(s) = p.slug() {
                self.index.refresh(s);
            }
        }
        let live = Arc::new(BunLive::from_rows(bun));
        let (_, mine) = self.reads(live).tickets(query);
        let key = |v: &Value| format!("{}/{}", v.get("profile").and_then(Value::as_str).unwrap_or(""), v.get("id").and_then(Value::as_str).unwrap_or(""));
        // A broken ticket file's placeholder is dated when it is read: its time is no difference.
        let mut corrupt = HashSet::new();
        for p in &profiles {
            if let Some(slug) = p.slug() {
                let list = self.index.list(slug);
                corrupt.extend(list.tickets.iter().filter(|t| t.corrupt).map(|t| format!("{slug}/{}", t.id)));
            }
        }
        let mut out = compare_rows(bun, &mine, key, &["running"]);
        out.retain(|l| !corrupt.iter().any(|k| *l == format!("{k} [updatedAt]")));
        out
    }
}

/// Live state as Bun's answer shows it (shadow mode).
pub struct BunLive {
    rows: HashMap<String, Value>,
    /// The Inbox's sessions (session-summaries.json); None: from the rows.
    sessions: Option<Arc<HashMap<String, Value>>>,
}

impl BunLive {
    pub fn from_rows(answer: &Value) -> BunLive {
        let rows = match answer {
            Value::Array(a) => a.as_slice(),
            Value::Object(m) => m.get("tickets").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]),
            _ => &[],
        };
        BunLive { rows: rows.iter().filter_map(|r| Some((r.get("id")?.as_str()?.to_string(), r.clone()))).collect(), sessions: None }
    }
    fn field(&self, id: &str, k: &str) -> Option<&Value> {
        self.rows.get(id).and_then(|r| r.get(k))
    }
}

impl Live for BunLive {
    fn running(&self, _: &str, id: &str) -> bool {
        self.field(id, "running").and_then(Value::as_bool).unwrap_or(false)
    }
    fn holds_slot(&self, _: &str, id: &str) -> bool {
        self.field(id, "holdsSlot").and_then(Value::as_bool).unwrap_or(false)
    }
    fn board_running(&self, _: &str) -> usize {
        0
    }
    fn session(&self, session_id: &str) -> Option<Value> {
        if let Some(s) = &self.sessions {
            return s.get(session_id).cloned();
        }
        self.rows.values().find(|r| r.get("sessionId").and_then(Value::as_str) == Some(session_id)).and_then(|r| r.get("session")).filter(|s| !s.is_null()).cloned()
    }
    fn host(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn devices(&self, _: &str, id: &str) -> Value {
        self.field(id, "devices").cloned().unwrap_or(Value::Null)
    }
    fn share_jobs(&self, _: &str, id: &str) -> Vec<Value> {
        self.field(id, "shareJobs").and_then(Value::as_array).cloned().unwrap_or_default()
    }
    fn terminal_open(&self, _: &str, id: &str) -> bool {
        self.field(id, "terminalOpen").and_then(Value::as_bool).unwrap_or(false)
    }
    fn folder_wait(&self, _: &str, t: &Tk) -> bool {
        self.field(&t.id, "folderWait").and_then(Value::as_bool).unwrap_or(false)
    }
    fn cost(&self, _: &str, _: &str) -> f64 {
        0.0
    }
    fn huddle_spend(&self, _: &str, _: &str) -> f64 {
        0.0
    }
    fn teammate_artifacts(&self, _: &str, _: &str) -> Vec<(String, Vec<Value>)> {
        Vec::new()
    }
}

fn tickets_of(v: &Value) -> &[Value] {
    match v {
        Value::Array(a) => a,
        Value::Object(m) => m.get("tickets").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]),
        _ => &[],
    }
}

fn ids(v: &[Value], key: &dyn Fn(&Value) -> String) -> Vec<String> {
    v.iter().map(key).collect()
}

/// Membership, order, and per-row differing field names (rows changed in between are skipped).
fn compare_rows(bun: &Value, mine: &Value, key: impl Fn(&Value) -> String, ignore: &[&str]) -> Vec<String> {
    let (b, m) = (tickets_of(bun), tickets_of(mine));
    let (bi, mi) = (ids(b, &key), ids(m, &key));
    let bs: HashSet<&String> = bi.iter().collect();
    let ms: HashSet<&String> = mi.iter().collect();
    let mut out = Vec::new();
    let missing: Vec<&str> = bi.iter().filter(|i| !ms.contains(i)).map(String::as_str).collect();
    let extra: Vec<&str> = mi.iter().filter(|i| !bs.contains(i)).map(String::as_str).collect();
    if !missing.is_empty() {
        out.push(format!("missing in Rust: {}", missing.join(" ")));
    }
    if !extra.is_empty() {
        out.push(format!("extra in Rust: {}", extra.join(" ")));
    }
    let common_b: Vec<&String> = bi.iter().filter(|i| ms.contains(i)).collect();
    let common_m: Vec<&String> = mi.iter().filter(|i| bs.contains(i)).collect();
    if common_b != common_m {
        out.push("order differs".into());
    }
    let by: HashMap<String, &Value> = m.iter().map(|r| (key(r), r)).collect();
    for row in b {
        let Some(r) = by.get(&key(row)) else { continue };
        let fields = differing_fields(row, r, ignore);
        if !fields.is_empty() {
            out.push(format!("{} [{}]", key(row), fields.join(", ")));
        }
    }
    out
}

fn differing_fields(a: &Value, b: &Value, ignore: &[&str]) -> Vec<String> {
    let (Some(a), Some(b)) = (a.as_object(), b.as_object()) else {
        return if a == b { vec![] } else { vec!["(row)".into()] };
    };
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    keys.into_iter().filter(|k| !ignore.contains(&k.as_str()) && !same(a.get(*k), b.get(*k))).map(|k| k.to_string()).collect()
}

/// Equal as JSON (numbers by value: Bun writes 1, a parse may keep 1.0).
fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::Array(x)), Some(Value::Array(y))) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(Some(p), Some(q))),
        (Some(Value::Object(x)), Some(Value::Object(y))) => x.len() == y.len() && x.iter().all(|(k, v)| same(Some(v), y.get(k))),
        (x, y) => x == y,
    }
}

/// A ticket list answer (`{tickets, ...}`): the other keys exactly, the tickets as rows with the live fields left out.
fn compare_lists(bun: &Value, mine: &Value, skipped: &mut u64) -> Vec<String> {
    let mut out = Vec::new();
    if let (Some(b), Some(m)) = (bun.as_object(), mine.as_object()) {
        let keys: BTreeSet<&String> = b.keys().chain(m.keys()).filter(|k| *k != "tickets").collect();
        for k in keys {
            if !same(b.get(k), m.get(k)) {
                out.push(format!("{k} differs"));
            }
        }
    }
    let key = |v: &Value| v.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let (b, m) = (tickets_of(bun), tickets_of(mine));
    let by: HashMap<String, &Value> = m.iter().map(|r| (key(r), r)).collect();
    let mut rows = compare_rows(&Value::Array(b.to_vec()), &Value::Array(m.to_vec()), key, &[]);
    // compare_rows reported field names with every field; redo the per-row part with the live rules.
    rows.retain(|l| l.starts_with("missing") || l.starts_with("extra") || l == "order differs");
    out.extend(rows);
    for row in b {
        let id = key(row);
        let Some(r) = by.get(&id) else { continue };
        // Changed between Bun's answer and the read of its file: not a difference.
        if row.get("updatedAt") != r.get("updatedAt") {
            *skipped += 1;
            continue;
        }
        let fields = view_differences(row, r);
        if !fields.is_empty() {
            out.push(format!("{id} [{}]", fields.join(", ")));
        }
    }
    out
}

/// Differing fields of one ticket view, live fields and the parts built from them left out.
fn view_differences(bun: &Value, mine: &Value) -> Vec<String> {
    let (Some(b), Some(m)) = (bun.as_object(), mine.as_object()) else { return vec!["(row)".into()] };
    let corrupt = b.get("error").and_then(Value::as_str).is_some_and(|e| e.starts_with("corrupt ticket file"));
    let huddle = b.get("huddleBusy") == Some(&Value::Bool(true)) || b.get("attention").and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("huddle");
    let huddle_links = b.get("links").and_then(Value::as_array).is_some_and(|a| a.iter().any(|l| l.get("source").and_then(Value::as_str).is_some_and(|s| s.starts_with("huddle:"))));
    let keys: BTreeSet<&String> = b.keys().chain(m.keys()).collect();
    let mut out = Vec::new();
    for k in keys {
        let k = k.as_str();
        if LIVE.contains(&k) || (corrupt && matches!(k, "createdAt" | "updatedAt" | "error")) {
            continue;
        }
        if huddle && matches!(k, "attention" | "snoozed") || huddle_links && k == "links" {
            continue;
        }
        if k == "familyCard" {
            let strip = |v: Option<&Value>| {
                v.cloned().map(|mut c| {
                    if let Some(o) = c.as_object_mut() {
                        o.remove("costUsd");
                    }
                    c
                })
            };
            if !same(strip(b.get(k)).as_ref(), strip(m.get(k)).as_ref()) {
                out.push(k.to_string());
            }
            continue;
        }
        if !same(b.get(k), m.get(k)) {
            out.push(k.to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_keys() {
        assert_eq!(route_key("/api/profiles/b/tickets", "scope=board&done=20").as_deref(), Some("GET /api/profiles/b/tickets scope=board"));
        assert_eq!(route_key("/api/profiles/b/tickets", ""), None);
        assert_eq!(route_key("/api/profiles/b/tickets/t_1", "scope=board"), None);
        assert_eq!(route_key("/api/inbox", "").as_deref(), Some("GET /api/inbox"));
        assert_eq!(route_key("/api/tickets", "scope=open").as_deref(), Some("GET /api/tickets scope=open"));
    }

    #[test]
    fn differences_name_ids_and_fields_only() {
        let bun = json!({ "tickets": [
            { "id": "a", "updatedAt": "1", "title": "x", "running": true, "attention": null },
            { "id": "b", "updatedAt": "1", "title": "secret text" },
            { "id": "c", "updatedAt": "1" },
        ], "doneTotal": 3 });
        let mine = json!({ "tickets": [
            { "id": "a", "updatedAt": "1", "title": "x", "running": false, "attention": { "kind": "review" } },
            { "id": "b", "updatedAt": "2", "title": "other" },
            { "id": "d", "updatedAt": "1" },
        ], "doneTotal": 3 });
        let mut skipped = 0;
        let d = compare_lists(&bun, &mine, &mut skipped);
        assert_eq!(d, ["missing in Rust: c", "extra in Rust: d", "a [attention]"]);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn a_check_logs_once_and_counts() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let t = root.join("profiles/b/tickets/t_1");
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(root.join("profiles/b/profile.json"), r#"{"name":"B","slug":"b","path":"/nowhere","createdAt":"2026"}"#).unwrap();
        std::fs::write(t.join("ticket.md"), "---\nid: t_1\ntitle: One\nstatus: review\norder: 1\nupdatedAt: u\n---\n").unwrap();
        let s = Shadow::new(root);
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let _g = rt.enter();
        let body = json!({ "total": 2, "open": 1, "doneTotal": 0 }).to_string();
        let l = s.compare("k", "/api/profiles/b/tickets", "scope=count", 200, body.as_bytes());
        assert!(l.unwrap().ends_with("k: total differs"));
        s.compare("k", "/api/profiles/b/tickets", "scope=count", 200, body.as_bytes());
        let log = std::fs::read_to_string(root.join(LOG_FILE)).unwrap();
        assert_eq!(log.lines().count(), 1);
        let ok = json!({ "total": 1, "open": 1, "doneTotal": 0 }).to_string();
        assert!(s.compare("k", "/api/profiles/b/tickets", "scope=count", 200, ok.as_bytes()).is_none());
        let st: Value = serde_json::from_str(&std::fs::read_to_string(root.join(STATUS_FILE)).unwrap()).unwrap();
        assert_eq!((st["checked"].as_u64(), st["differed"].as_u64()), (Some(3), Some(2)));
    }
}
