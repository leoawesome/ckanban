//! Today's spend (`GET /api/spend`), ported from `SpendIndex` in `src/usage/spend.ts` and `readSideSpend` in
//! `src/runs/side-call.ts`. Read only: Rust never writes a spend file.
//!
//! A board's cost today is today's share of: its tickets' `activity.jsonl` result lines (each carries the session's
//! running `total_cost_usd`; the growth counts, on the line's local day), its tickets' `side-spend.jsonl`, its quick
//! chats' `chats/<id>.activity.jsonl` and `.side-spend.jsonl`, and its entry in `spend-days.json` (huddle agents).
//! The helper's `helper-spend.jsonl` adds a last "Helper" line. Files untouched since local midnight are skipped;
//! activity logs are read incrementally (only what was appended since), and a ticket Done long ago may have only a
//! compressed `activity.jsonl.gz` (run-log.ts), read the same way.
//!
//! The work is file reads, so `recent()` runs it on tokio's blocking pool: it never holds up the server's other
//! requests, which is what Bun's `pauser()` slices are for.

use crate::home::DataDir;
use crate::jsnum::{js_string, num};
use crate::time::{day_key, local_midnight, system_ms, value_ms};
use flate2::read::MultiGzDecoder;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const CHUNK: usize = 1024 * 1024;
/// How long one answer is reused (every open page asks again after each ticket change).
pub const RECENT_MAX_AGE_MS: f64 = 5_000.0;

#[derive(Clone, Debug, PartialEq)]
pub struct BoardSpend {
    pub slug: String,
    /// The board's `name` as stored.
    pub name: Value,
    pub cost_usd: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TodaySpend {
    pub day: String,
    pub cost_usd: f64,
    pub boards: Vec<BoardSpend>,
}

impl TodaySpend {
    /// The `GET /api/spend` body, as Bun writes it.
    pub fn to_json(&self) -> Value {
        let boards = self
            .boards
            .iter()
            .map(|b| {
                let mut m = Map::new();
                m.insert("slug".into(), b.slug.clone().into());
                m.insert("name".into(), b.name.clone());
                m.insert("costUsd".into(), num(b.cost_usd));
                Value::Object(m)
            })
            .collect();
        let mut m = Map::new();
        m.insert("day".into(), self.day.clone().into());
        m.insert("costUsd".into(), num(self.cost_usd));
        m.insert("boards".into(), Value::Array(boards));
        Value::Object(m)
    }
}

/// A cost so far, by local day of the line that reported it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Spend {
    pub cost_usd: f64,
    pub days: HashMap<String, f64>,
    /// Paid calls by day (side-spend files only).
    pub calls: HashMap<String, u64>,
}

impl Spend {
    pub fn on(&self, day: &str) -> f64 {
        self.days.get(day).copied().unwrap_or(0.0)
    }
}

#[derive(Default)]
struct FileState {
    offset: u64,
    /// Last running total per session (result lines carry the session's total, kept across --resume).
    totals: HashMap<String, f64>,
    spend: Spend,
}

#[derive(Default)]
struct Inner {
    files: HashMap<PathBuf, FileState>,
    side: HashMap<PathBuf, (String, Spend)>,
}

/// A run log's size and age, plain or compressed (`logStat` in run-log.ts).
struct LogStat {
    size: u64,
    mtime_ms: f64,
    gz: Option<PathBuf>,
}

fn gz_of(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".gz");
    PathBuf::from(s)
}

fn log_stat(file: &Path) -> Option<LogStat> {
    if let Ok(m) = std::fs::metadata(file) {
        return Some(LogStat { size: m.len(), mtime_ms: m.modified().map(system_ms).unwrap_or(0.0), gz: None });
    }
    let gz = gz_of(file);
    let m = std::fs::metadata(&gz).ok()?;
    // The uncompressed size from the gzip trailer (the last 4 bytes, size mod 4 GB: run logs stay far below that).
    let mut f = File::open(&gz).ok()?;
    let mut b = [0u8; 4];
    f.seek(SeekFrom::Start(m.len().saturating_sub(4))).ok()?;
    f.read_exact(&mut b).ok()?;
    Some(LogStat { size: u64::from(u32::from_le_bytes(b)), mtime_ms: m.modified().map(system_ms).unwrap_or(0.0), gz: Some(gz) })
}

fn mtime_of(file: &Path) -> f64 {
    std::fs::metadata(file).and_then(|m| m.modified()).map(system_ms).unwrap_or(0.0)
}

/// `n > 0 && finite`, else 0 (`num` in spend.ts).
fn positive(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(0.0)
}

/// `String(v ?? "")` for a session id.
fn js_str(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map(js_string).unwrap_or_default(),
        Some(Value::Array(a)) => a.iter().map(|x| js_str(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn day_of(at: Option<&Value>) -> String {
    value_ms(at).map(day_key).unwrap_or_default()
}

/// One activity log line; only result lines with a running total count.
fn count_line(st: &mut FileState, line: &str) {
    if !line.contains("\"total_cost_usd\"") {
        return;
    }
    let Ok(e) = serde_json::from_str::<Value>(line) else { return };
    let Some(ev) = e.get("event") else { return };
    if ev.get("type").and_then(Value::as_str) != Some("result") {
        return;
    }
    let sid = js_str(ev.get("session_id"));
    let total = positive(ev.get("total_cost_usd"));
    let prev = st.totals.get(&sid).copied().unwrap_or(0.0);
    let cost = if total >= prev { total - prev } else { total };
    st.totals.insert(sid, total);
    if cost == 0.0 {
        return;
    }
    st.spend.cost_usd += cost;
    *st.spend.days.entry(day_of(e.get("at"))).or_insert(0.0) += cost;
}

/// Counts whole lines in `bytes` (which start at `st.offset`); a line still being written stays for the next read.
fn count_bytes(st: &mut FileState, bytes: &[u8]) {
    let Some(cut) = bytes.iter().rposition(|b| *b == b'\n') else { return };
    for line in String::from_utf8_lossy(&bytes[..cut]).split('\n') {
        count_line(st, line);
    }
    st.offset += cut as u64 + 1;
}

/// Reads from `st.offset` up to `size`, a chunk at a time (a busy ticket's first read is tens of MB).
fn read_new(file: &Path, gz: Option<&Path>, st: &mut FileState, size: u64) -> io::Result<()> {
    if let Some(gz) = gz {
        let mut all = Vec::new();
        MultiGzDecoder::new(File::open(gz)?).read_to_end(&mut all)?;
        let end = (size as usize).min(all.len());
        let from = (st.offset as usize).min(end);
        count_bytes(st, &all[from..end]);
        return Ok(());
    }
    let mut f = File::open(file)?;
    let size = size.min(f.metadata()?.len());
    f.seek(SeekFrom::Start(st.offset))?;
    let mut carry: Vec<u8> = Vec::new();
    let mut pos = st.offset;
    let mut buf = vec![0u8; CHUNK.min((size - st.offset) as usize).max(1)];
    while pos < size {
        let want = buf.len().min((size - pos) as usize);
        let n = f.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        pos += n as u64;
        carry.extend_from_slice(&buf[..n]);
        let before = st.offset;
        count_bytes(st, &carry);
        let used = (st.offset - before) as usize;
        carry.drain(..used);
    }
    Ok(())
}

pub struct SpendIndex {
    dir: DataDir,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    inner: Mutex<Inner>,
    recent: tokio::sync::Mutex<Option<(f64, TodaySpend)>>,
}

impl SpendIndex {
    pub fn new(dir: DataDir) -> Self {
        Self::with_clock(dir, Arc::new(crate::time::now_ms))
    }

    pub fn with_clock(dir: DataDir, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        Self { dir, now, inner: Mutex::new(Inner::default()), recent: tokio::sync::Mutex::new(None) }
    }

    /// Cost of the result lines in one activity log; reads only what was appended since the last call.
    fn log_spend(inner: &mut Inner, file: &Path) -> Spend {
        let Some(ls) = log_stat(file) else {
            inner.files.remove(file);
            return Spend::default();
        };
        let st = inner.files.entry(file.to_path_buf()).or_default();
        // Rewritten or replaced (e.g. a deleted and re-made ticket): start over.
        if ls.size < st.offset {
            *st = FileState::default();
        }
        if ls.size > st.offset {
            let _ = read_new(file, ls.gz.as_deref(), st, ls.size);
        }
        st.spend.clone()
    }

    /// `readSideSpend`: a side-call ledger's cost, re-read only when its size or time changed.
    fn side_spend(inner: &mut Inner, file: &Path) -> Spend {
        let Ok(m) = std::fs::metadata(file) else {
            inner.side.remove(file);
            return Spend::default();
        };
        let version = format!("{}:{}", m.len(), m.modified().map(system_ms).unwrap_or(0.0));
        if let Some((v, s)) = inner.side.get(file) {
            if *v == version {
                return s.clone();
            }
        }
        let mut spend = Spend::default();
        let text = std::fs::read(file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        for line in text.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
            let cost = e.get("costUsd").and_then(Value::as_f64).filter(|c| *c > 0.0).unwrap_or(0.0);
            if cost == 0.0 {
                continue;
            }
            spend.cost_usd += cost;
            let day = day_of(e.get("at"));
            *spend.days.entry(day.clone()).or_insert(0.0) += cost;
            *spend.calls.entry(day).or_insert(0) += 1;
        }
        inner.side.insert(file.to_path_buf(), (version, spend.clone()));
        spend
    }

    fn ticket_in(&self, inner: &mut Inner, slug: &str, id: &str) -> Spend {
        let runs = Self::log_spend(inner, &self.dir.activity_path(slug, id));
        let side = Self::side_spend(inner, &self.dir.side_spend_path(slug, id));
        if side.cost_usd == 0.0 {
            return runs;
        }
        let mut days = runs.days;
        for (d, c) in side.days {
            *days.entry(d).or_insert(0.0) += c;
        }
        Spend { cost_usd: runs.cost_usd + side.cost_usd, days, calls: HashMap::new() }
    }

    /// A ticket's cost so far: its runs and its side calls (huddle agents not included, as in Bun).
    pub fn ticket(&self, slug: &str, id: &str) -> Spend {
        let mut inner = self.inner.lock().unwrap();
        self.ticket_in(&mut inner, slug, id)
    }

    /// What every board spent today (local day): its tickets' runs, its quick chats and its huddle agents, then the
    /// helper. Blocking file reads: call it off the async runtime, or use `recent()`.
    pub fn today(&self) -> io::Result<TodaySpend> {
        let now = (self.now)();
        let day = day_key(now);
        let start = local_midnight(now);
        let ledger = std::fs::read_to_string(self.dir.spend_days()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let huddles = ledger.as_ref().and_then(|l| l.get(&day)).cloned().unwrap_or(Value::Null);
        let mut inner = self.inner.lock().unwrap();
        let mut boards = Vec::new();
        for p in self.dir.list_profiles()? {
            let Some(slug) = p.slug().map(str::to_string) else { continue };
            let mut cost = huddles.get(&slug).and_then(Value::as_f64).unwrap_or(0.0);
            if let Ok(rd) = std::fs::read_dir(self.dir.tickets_dir(&slug)) {
                for e in rd.flatten() {
                    let id = e.file_name().to_string_lossy().into_owned();
                    // Untouched since midnight: nothing spent today. A compressed log keeps its original's time.
                    let log_m = log_stat(&self.dir.activity_path(&slug, &id)).map_or(0.0, |s| s.mtime_ms);
                    let mtime = log_m.max(mtime_of(&self.dir.side_spend_path(&slug, &id)));
                    if mtime >= start {
                        cost += self.ticket_in(&mut inner, &slug, &id).on(&day);
                    }
                }
            }
            // Quick chats log their result lines, and their side calls, next to each chat.
            let chats = self.dir.chats_dir(&slug);
            if let Ok(rd) = std::fs::read_dir(&chats) {
                for e in rd.flatten() {
                    let f = e.file_name().to_string_lossy().into_owned();
                    let file = chats.join(&f);
                    if f.ends_with(".activity.jsonl") && mtime_of(&file) >= start {
                        cost += Self::log_spend(&mut inner, &file).on(&day);
                    }
                    if f.ends_with(".side-spend.jsonl") && mtime_of(&file) >= start {
                        cost += Self::side_spend(&mut inner, &file).on(&day);
                    }
                }
            }
            boards.push(BoardSpend { slug, name: p.name(), cost_usd: cost });
        }
        // The helper covers every board: its own "Helper" line.
        let helper = Self::side_spend(&mut inner, &self.dir.helper_spend()).on(&day);
        if helper > 0.0 {
            boards.push(BoardSpend { slug: "~helper".into(), name: "Helper".into(), cost_usd: helper });
        }
        let cost_usd = boards.iter().fold(0.0, |s, b| s + b.cost_usd);
        Ok(TodaySpend { day, cost_usd, boards })
    }

    /// `today()` at most 5 seconds old, made off the async runtime, one at a time: callers meanwhile wait for it.
    pub async fn recent(self: &Arc<Self>) -> io::Result<TodaySpend> {
        self.recent_within(RECENT_MAX_AGE_MS).await
    }

    pub async fn recent_within(self: &Arc<Self>, max_age_ms: f64) -> io::Result<TodaySpend> {
        let mut last = self.recent.lock().await;
        let at = (self.now)();
        if let Some((t, s)) = last.as_ref() {
            if at - t < max_age_ms && at >= *t {
                return Ok(s.clone());
            }
        }
        let me = self.clone();
        let spend = tokio::task::spawn_blocking(move || me.today()).await.map_err(io::Error::other)??;
        *last = Some((at, spend.clone()));
        Ok(spend)
    }
}

/// Days `spend-days.json` keeps (`KEEP_DAYS`).
pub const KEEP_DAYS: usize = 60;

static LEDGER: Mutex<()> = Mutex::new(());

/// `addHuddleSpend`: what a huddle agent's turn cost, added to its board's total for the local day of `at_ms` in
/// `spend-days.json` (the last KEEP_DAYS days kept). Nothing for a cost that isn't positive.
pub fn add_huddle_spend(dir: &DataDir, slug: &str, cost_usd: f64, at_ms: f64) -> io::Result<()> {
    if !(cost_usd > 0.0) {
        return Ok(());
    }
    let _g = LEDGER.lock().unwrap_or_else(|e| e.into_inner());
    let file = dir.spend_days();
    let mut ledger = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default();
    let day = ledger.entry(day_key(at_ms)).or_insert_with(|| Value::Object(Map::new()));
    if !day.is_object() {
        *day = Value::Object(Map::new());
    }
    if let Value::Object(d) = day {
        let was = d.get(slug).and_then(Value::as_f64).unwrap_or(0.0);
        d.insert(slug.to_string(), num(was + cost_usd));
    }
    let mut keys: Vec<String> = ledger.keys().cloned().collect();
    keys.sort();
    let keep = &keys[keys.len().saturating_sub(KEEP_DAYS)..];
    let out: Map<String, Value> = keep.iter().filter_map(|k| ledger.get(k).map(|v| (k.clone(), v.clone()))).collect();
    let text = serde_json::to_string(&Value::Object(out)).map_err(io::Error::other)? + "\n";
    crate::atomic::atomic_write(&file, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st() -> FileState {
        FileState::default()
    }

    #[test]
    fn running_totals_count_their_growth() {
        let mut s = st();
        let r = |sid: &str, t: f64| format!(r#"{{"at":"2026-11-15T11:00:00.000Z","event":{{"type":"result","total_cost_usd":{t},"session_id":"{sid}"}}}}"#);
        for l in [r("a", 0.1), r("a", 0.25), r("b", 0.05), r("a", 0.02)] {
            count_line(&mut s, &l);
        }
        // 0.1 + 0.15 + 0.05 + 0.02 (a total that went down is a new run: it counts whole)
        assert!((s.spend.cost_usd - 0.32).abs() < 1e-12);
    }

    #[test]
    fn a_line_being_written_waits_for_its_newline() {
        let mut s = st();
        let line = r#"{"at":"2026-11-15T11:00:00.000Z","event":{"type":"result","total_cost_usd":1,"session_id":"a"}}"#;
        count_bytes(&mut s, format!("{line}\n{}", &line[..20]).as_bytes());
        assert_eq!(s.offset, line.len() as u64 + 1);
        assert_eq!(s.spend.cost_usd, 1.0);
    }

    #[test]
    fn session_ids_read_like_js_string() {
        assert_eq!(js_str(Some(&serde_json::json!(5))), "5");
        assert_eq!(js_str(Some(&Value::Null)), "");
        assert_eq!(js_str(None), "");
    }
}
