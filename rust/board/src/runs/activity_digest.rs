//! What the daemon needs from a ticket's run log (`src/runs/activity-digest.ts`), kept per file and brought up to
//! date by reading only the bytes appended since last time. Run logs reach tens of MB on a real board, so reading them
//! whole (to count changed files, a follow-up's cost, a session's previous total) froze Bun's daemon. Reading is
//! blocking: `get` runs it with `spawn_blocking`; `get_now` is for code already off the runtime.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use super::{js, run_log};

/// Bytes read at a time.
const CHUNK: usize = 1 << 20;
/// Logs kept in memory; a log pushed out is read again next time it's asked for.
const MAX_FILES: usize = 500;
const EDIT_TOOLS: [&str; 3] = ["Edit", "Write", "NotebookEdit"];

#[derive(Debug, Clone, Default)]
pub struct ActivityDigest {
    /// Bytes read so far (up to the last whole line).
    pub offset: u64,
    /// Files the run's Edit/Write/NotebookEdit tool calls named, first seen first.
    pub edited: Vec<String>,
    edited_set: HashSet<String>,
    /// The entries `ticketRuns()` looks at, trimmed to the fields it reads: run markers, inits, results and the first
    /// event of each new run number.
    pub run_entries: Vec<Value>,
    /// Per session (first seen first): its last two running totals from result lines, older first.
    pub session_totals: Vec<(String, Vec<f64>)>,
    /// The last entry's `run` (None: it had none, JS's undefined).
    pub last_run: Option<Value>,
}

impl ActivityDigest {
    fn fresh() -> Self {
        ActivityDigest { last_run: Some(Value::Null), ..Default::default() }
    }

    pub fn session_total(&self, sid: &str) -> Option<&[f64]> {
        self.session_totals.iter().find(|(s, _)| s == sid).map(|(_, t)| t.as_slice())
    }

    /// As JSON (fixtures): sets as arrays, the totals map as [session, totals] pairs.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("offset".into(), Value::from(self.offset));
        m.insert("edited".into(), Value::Array(self.edited.iter().cloned().map(Value::String).collect()));
        m.insert("runEntries".into(), Value::Array(self.run_entries.clone()));
        m.insert(
            "sessionTotals".into(),
            Value::Array(self.session_totals.iter().map(|(s, t)| serde_json::json!([s, t.iter().map(|x| ckanban_core::jsnum::num(*x)).collect::<Vec<_>>()])).collect()),
        );
        if let Some(r) = &self.last_run {
            m.insert("lastRun".into(), r.clone());
        }
        Value::Object(m)
    }
}

fn slim_event(ev: &Value) -> Value {
    let mut m = Map::new();
    let ty = ev.get("type");
    if let Some(t) = ty {
        m.insert("type".into(), t.clone());
    }
    let keep: &[&str] = match ty.and_then(Value::as_str) {
        Some("ckanban_run") => &["kind"],
        Some("system") => &["subtype", "permissionMode"],
        Some("result") => &["session_id", "total_cost_usd", "modelUsage", "usage"],
        _ => &[],
    };
    for k in keep {
        if let Some(v) = ev.get(*k) {
            m.insert((*k).into(), v.clone());
        }
    }
    Value::Object(m)
}

/// `^\{"run":(-?\d+)`, as a number.
fn head_run(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("{\"run\":")?;
    let neg = rest.starts_with('-');
    let digits: String = rest[usize::from(neg)..].chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let n = js::number_of_str(&digits);
    Some(if neg { -n } else { n })
}

fn same_run(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => js::strict_eq(x, y),
        _ => false,
    }
}

fn add_line(d: &mut ActivityDigest, line: &str) {
    if line.is_empty() {
        return;
    }
    let run = head_run(line);
    let marker = line.contains("\"ckanban_run\"");
    let init = line.contains("\"init\"");
    let result = line.contains("\"total_cost_usd\"");
    let edit = line.contains("\"tool_use\"") && EDIT_TOOLS.iter().any(|t| line.contains(&format!("\"name\":\"{t}\"")));
    // Most lines (tool output, text, stream events) need no parsing at all.
    if let Some(r) = run
        && d.last_run.as_ref().and_then(Value::as_f64) == Some(r)
        && !marker
        && !init
        && !result
        && !edit
    {
        return;
    }
    let Some(e) = js::parse(line) else { return };
    let Some(ev) = e.get("event").filter(|v| v.is_object() || v.is_array()) else { return };
    let ty = ev.get("type").and_then(Value::as_str);
    if edit && ty == Some("assistant")
        && let Some(blocks) = ev.pointer("/message/content").and_then(Value::as_array)
    {
        for b in blocks {
            if b.get("type").and_then(Value::as_str) == Some("tool_use")
                && b.get("name").and_then(Value::as_str).is_some_and(|n| EDIT_TOOLS.contains(&n))
                && let Some(f) = b.pointer("/input/file_path").and_then(Value::as_str)
                && d.edited_set.insert(f.to_string())
            {
                d.edited.push(f.to_string());
            }
        }
    }
    let is_init = ty == Some("system") && ev.get("subtype").and_then(Value::as_str) == Some("init");
    if ty == Some("ckanban_run") || is_init || ty == Some("result") || !same_run(e.get("run"), d.last_run.as_ref()) {
        let mut entry = Map::new();
        if let Some(r) = e.get("run") {
            entry.insert("run".into(), r.clone());
        }
        if let Some(a) = e.get("at") {
            entry.insert("at".into(), a.clone());
        }
        entry.insert("event".into(), slim_event(ev));
        d.run_entries.push(Value::Object(entry));
        d.last_run = e.get("run").cloned();
    }
    if ty == Some("result") {
        let sid = match ev.get("session_id") {
            None | Some(Value::Null) => String::new(),
            Some(v) => js::to_string(v),
        };
        let n = js::number(ev.get("total_cost_usd"));
        let total = if n.is_nan() { 0.0 } else { n };
        match d.session_totals.iter_mut().find(|(s, _)| *s == sid) {
            Some((_, t)) => {
                t.push(total);
                if t.len() > 2 {
                    t.remove(0);
                }
            }
            None => d.session_totals.push((sid, vec![total])),
        }
    }
}

/// A log's digest and when it was last used.
type Entry = (u64, Arc<Mutex<ActivityDigest>>);

/// Every log's digest, kept up to date (`ActivityDigests`).
#[derive(Default)]
pub struct ActivityDigests {
    /// Most recently used last.
    files: Mutex<(HashMap<PathBuf, Entry>, u64)>,
}

impl ActivityDigests {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn entry(&self, file: &Path) -> Arc<Mutex<ActivityDigest>> {
        let mut g = self.files.lock();
        g.1 += 1;
        let seq = g.1;
        let d = g.0.get(file).map(|(_, d)| d.clone()).unwrap_or_else(|| Arc::new(Mutex::new(ActivityDigest::fresh())));
        g.0.insert(file.to_path_buf(), (seq, d.clone()));
        if g.0.len() > MAX_FILES
            && let Some(oldest) = g.0.iter().min_by_key(|(_, (s, _))| *s).map(|(k, _)| k.clone())
        {
            g.0.remove(&oldest);
        }
        d
    }

    /// The digest of `file` as far as it has been written, read off the runtime (a compressed log is decompressed
    /// there too).
    pub async fn get(self: &Arc<Self>, file: &Path) -> ActivityDigest {
        let me = self.clone();
        let f = file.to_path_buf();
        tokio::task::spawn_blocking(move || me.get_now(&f)).await.unwrap_or_else(|_| ActivityDigest::fresh())
    }

    /// The same, blocking: reads whatever was appended since the last call (one run's worth, once warm).
    pub fn get_now(&self, file: &Path) -> ActivityDigest {
        let Some(st) = run_log::log_stat(file) else {
            self.files.lock().0.remove(file);
            return ActivityDigest::fresh();
        };
        let cell = self.entry(file);
        // One reader per log at a time; a second caller waits and then finds it read.
        let mut d = cell.lock();
        // Rewritten or replaced (a deleted and re-made ticket): start over.
        if st.size < d.offset {
            *d = ActivityDigest::fresh();
        }
        if st.size <= d.offset {
            return d.clone();
        }
        let Some(log) = run_log::open_log(file) else { return d.clone() };
        let size = st.size.min(log.size());
        let mut buf = vec![0u8; CHUNK.min((size - d.offset) as usize)];
        // Bytes after the last whole line: decoded with the next chunk, so a character split between chunks stays whole.
        let mut carry: Vec<u8> = Vec::new();
        let mut pos = d.offset;
        while pos < size {
            let want = buf.len().min((size - pos) as usize);
            let n = match ckanban_core::jsonl::ReadAt::read_at(&log, &mut buf[..want], pos) {
                Ok(n) if n > 0 => n,
                _ => break,
            };
            pos += n as u64;
            carry.extend_from_slice(&buf[..n]);
            // A line still being written stays for the next read.
            let Some(cut) = carry.iter().rposition(|b| *b == b'\n') else { continue };
            let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
            for line in text.split('\n') {
                add_line(&mut d, line);
            }
            carry.drain(..=cut);
            d.offset = pos - carry.len() as u64;
        }
        d.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_appended_parts_as_they_come() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("activity.jsonl");
        let lines = [
            r#"{"run":1,"at":"t1","event":{"type":"ckanban_run","kind":"work"}}"#,
            r#"{"run":1,"at":"t2","event":{"type":"system","subtype":"init","session_id":"s"}}"#,
            r#"{"run":1,"at":"t3","event":{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a.ts"}}]}}}"#,
            r#"{"run":1,"at":"t4","event":{"type":"result","session_id":"s","total_cost_usd":0.5}}"#,
            r#"{"run":2,"at":"t5","event":{"type":"assistant","message":{"content":[]}}}"#,
        ];
        std::fs::write(&file, format!("{}\n{}\n{}\n", lines[0], lines[1], lines[2])).unwrap();
        let ds = ActivityDigests::default();
        let a = ds.get_now(&file);
        assert_eq!(a.edited, vec!["/a.ts"]);
        assert_eq!(a.run_entries.len(), 2);
        // Half a line: left for the next read.
        let rest = format!("{}\n{}\n", lines[3], lines[4]);
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(&rest.as_bytes()[..10]).unwrap();
        assert_eq!(ds.get_now(&file).offset, a.offset);
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(&rest.as_bytes()[10..]).unwrap();
        let b = ds.get_now(&file);
        assert_eq!(b.session_total("s"), Some(&[0.5][..]));
        assert_eq!(b.run_entries.len(), 4);
        assert_eq!(b.last_run, Some(Value::from(2)));
    }

    use std::io::Write;
}
