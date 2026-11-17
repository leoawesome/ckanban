//! `src/usage/ticket-usage.ts`: how much of the Claude plan a ticket used (its runs' cost in each 5h window ÷ the cost
//! of all Claude Code activity on this Mac then × the window's utilization), with the two incremental indexes it reads:
//! `RunLogIndex` (a ticket's run log, only the lines that matter, read from where it stopped) and `ClaudeLogIndex`
//! (every transcript under `~/.claude/projects`, priced per minute). Also `team-usage` (`src/huddle/huddle-usage.ts`)
//! and a ticket's huddle teammates' spend (`teammateSpend`), from the huddle files every board keeps.
//! All file work is blocking: callers run it on the blocking pool.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use ckanban_core::jsonl::ReadAt;
use ckanban_core::jsnum::num;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Map, Value};

use super::learn::{ms, s};
use crate::runs::js::{strict_eq, to_string};
use crate::runs::run_log::{log_stat, open_log};
use crate::sessions::workflows::message_cost;

const FIVE_HOURS: f64 = 5.0 * 3_600_000.0;
const BUCKET_MS: f64 = 60_000.0;
const HOLD_MS: f64 = 3_600_000.0;
const LOG_CHUNK: u64 = 1 << 20;

/// `num`: a finite number above 0, else 0.
fn pos(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(0.0)
}

// ---------- reading whole lines ----------

/// `readLines`: the whole lines between `from` and `to`, a chunk at a time; the offset after the last whole line.
pub fn read_lines(src: &dyn ReadAt, from: u64, to: u64, each: &mut dyn FnMut(&str)) -> std::io::Result<u64> {
    let mut carry: Vec<u8> = Vec::new();
    let mut pos = from;
    while pos < to {
        let end = to.min(pos + LOG_CHUNK);
        let mut got = vec![0u8; (end - pos) as usize];
        let mut n = 0;
        while n < got.len() {
            let r = src.read_at(&mut got[n..], pos + n as u64)?;
            if r == 0 {
                break;
            }
            n += r;
        }
        got.truncate(n);
        pos = end;
        carry.extend_from_slice(&got);
        let Some(cut) = carry.iter().rposition(|b| *b == b'\n') else { continue };
        let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
        for line in text.split('\n') {
            each(line);
        }
        carry.drain(..=cut);
        if n == 0 {
            break;
        }
    }
    Ok(pos - carry.len() as u64)
}

// ---------- machine-wide Claude Code cost ----------

pub fn claude_projects_dir() -> PathBuf {
    let base = std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| ckanban_core::home::home_dir().join(".claude"));
    base.join("projects")
}

#[derive(Default)]
struct LogState {
    files: HashMap<PathBuf, u64>,
    buckets: HashMap<i64, f64>,
    keys: HashMap<u64, i64>,
    costs: HashMap<u64, f64>,
    horizon: f64,
    asked: Vec<(f64, f64)>,
    last_refresh: f64,
}

/// `ClaudeLogIndex`: cost of every Claude Code message on this Mac, read incrementally and summed per minute, only
/// back to the oldest window asked for in the last hour.
pub struct ClaudeLogIndex {
    root: PathBuf,
    min_interval_ms: f64,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    state: Arc<tokio::sync::Mutex<LogState>>,
}

impl ClaudeLogIndex {
    pub fn new(root: PathBuf, min_interval_ms: f64, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        let state = LogState { horizon: f64::INFINITY, ..Default::default() };
        ClaudeLogIndex { root, min_interval_ms, now, state: Arc::new(tokio::sync::Mutex::new(state)) }
    }

    /// `refresh`: catch up with the logs, covering activity since `since` (ms). One at a time.
    pub async fn refresh(&self, since: f64) {
        let mut g = self.state.clone().lock_owned().await;
        let now = (self.now)();
        match g.asked.iter_mut().find(|(s, _)| *s == since) {
            Some(e) => e.1 = now,
            None => g.asked.push((since, now)),
        }
        if since < g.horizon {
            g.files.clear();
            g.buckets.clear();
            g.keys.clear();
            g.costs.clear();
            g.horizon = f64::INFINITY;
        } else {
            trim(&mut g, now);
        }
        if since >= g.horizon && now - g.last_refresh < self.min_interval_ms {
            return;
        }
        let from = since.min(g.horizon);
        let root = self.root.clone();
        let clock = self.now.clone();
        let _ = tokio::task::spawn_blocking(move || {
            scan(&mut g, &root, from);
            g.last_refresh = clock();
        })
        .await;
    }

    /// `costBetween`.
    pub async fn cost_between(&self, start: f64, end: f64) -> f64 {
        let g = self.state.lock().await;
        let from = (start / BUCKET_MS).ceil() as i64;
        let to = (end / BUCKET_MS).ceil() as i64;
        let mut sum = 0.0;
        if to - from <= g.buckets.len() as i64 {
            for m in from..to {
                sum += g.buckets.get(&m).copied().unwrap_or(0.0);
            }
        } else {
            for (m, c) in &g.buckets {
                if *m >= from && *m < to {
                    sum += c;
                }
            }
        }
        sum
    }
}

fn trim(g: &mut LogState, now: f64) {
    let mut oldest = f64::INFINITY;
    g.asked.retain(|(since, at)| {
        if now - at > HOLD_MS {
            false
        } else {
            oldest = oldest.min(*since);
            true
        }
    });
    if oldest.partial_cmp(&g.horizon) != Some(std::cmp::Ordering::Greater) || oldest == f64::INFINITY {
        return;
    }
    let cut = (oldest / BUCKET_MS).floor() as i64;
    g.buckets.retain(|m, _| *m >= cut);
    let gone: Vec<u64> = g.keys.iter().filter(|(_, m)| **m < cut).map(|(k, _)| *k).collect();
    for k in gone {
        g.keys.remove(&k);
        g.costs.remove(&k);
    }
    g.horizon = cut as f64 * BUCKET_MS;
}

fn jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else { return false };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() {
            jsonl_files(&p, out);
        } else if p.to_string_lossy().ends_with(".jsonl") {
            out.push(p);
        }
    }
    true
}

fn scan(g: &mut LogState, root: &Path, since: f64) {
    let mut names = Vec::new();
    let listed = jsonl_files(root, &mut names);
    let floor = (since / BUCKET_MS).floor() * BUCKET_MS;
    for f in &names {
        let Ok(m) = std::fs::metadata(f) else { continue };
        let mtime = m.modified().map(ckanban_core::time::system_ms).unwrap_or(0.0);
        let size = m.len();
        let offset = match g.files.get(f) {
            Some(o) => *o,
            None => {
                if mtime < floor {
                    continue;
                }
                g.files.insert(f.clone(), 0);
                0
            }
        };
        let offset = if size < offset { 0 } else { offset };
        if size == offset {
            g.files.insert(f.clone(), offset);
            continue;
        }
        let Ok(file) = std::fs::File::open(f) else { continue };
        let mut lines = Vec::new();
        let next = read_lines(&FileAt(file), offset, size, &mut |l| {
            if l.contains("\"usage\"") && l.contains("\"assistant\"") {
                lines.push(l.to_string());
            }
        })
        .unwrap_or(offset);
        for l in lines {
            add_line(g, &l, floor);
        }
        g.files.insert(f.clone(), next);
    }
    if listed {
        let live: std::collections::HashSet<&PathBuf> = names.iter().collect();
        g.files.retain(|f, _| live.contains(f));
    }
    g.horizon = g.horizon.min(floor);
}

struct FileAt(std::fs::File);

impl ReadAt for FileAt {
    fn size(&self) -> u64 {
        self.0.metadata().map(|m| m.len()).unwrap_or(0)
    }
    fn read_at(&self, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
        std::os::unix::fs::FileExt::read_at(&self.0, buf, pos)
    }
}

fn add_line(g: &mut LogState, line: &str, since: f64) {
    let Some(j) = crate::runs::js::parse(line) else { return };
    let Some(m) = j.get("message") else { return };
    if s(&j, "type") != "assistant" || !ckanban_core::jsnum::truthy(m.get("usage")) {
        return;
    }
    let Some(model) = m.get("model").and_then(Value::as_str).filter(|m| *m != "<synthetic>") else { return };
    let t = j.get("timestamp").and_then(Value::as_str).map(ms).unwrap_or(f64::NAN);
    if t.is_nan() || t < since {
        return;
    }
    let cost = message_cost(model, &m["usage"]);
    let id = match m.get("id") {
        Some(Value::Null) | None => j.get("uuid").map_or("undefined".to_string(), to_string),
        Some(v) => to_string(v),
    };
    let req = match j.get("requestId") {
        Some(Value::Null) | None => String::new(),
        Some(v) => to_string(v),
    };
    let mut h = std::collections::hash_map::DefaultHasher::new();
    format!("{id}:{req}").hash(&mut h);
    let key = h.finish();
    if let Some(&at) = g.keys.get(&key) {
        let old = g.costs.get(&key).copied().unwrap_or(0.0);
        *g.buckets.entry(at).or_insert(0.0) += cost - old;
        g.costs.insert(key, cost);
    } else {
        let minute = (t / BUCKET_MS).floor() as i64;
        g.keys.insert(key, minute);
        g.costs.insert(key, cost);
        *g.buckets.entry(minute).or_insert(0.0) += cost;
    }
}

// ---------- per-ticket runs ----------

/// `TicketRun`.
#[derive(Clone, Debug)]
pub struct TicketRun {
    pub run: Value,
    pub kind: Value,
    pub started_at: Value,
    pub model: Option<String>,
    pub tokens: f64,
    pub cost_usd: f64,
    /// (at, cost) per result event.
    pub parts: Vec<(String, f64)>,
}

impl TicketRun {
    pub fn to_json(&self) -> Value {
        json!({
            "run": self.run, "kind": self.kind, "startedAt": self.started_at, "model": self.model, "tokens": num(self.tokens),
            "costUsd": num(self.cost_usd), "parts": self.parts.iter().map(|(at, c)| json!({ "at": at, "cost": num(*c) })).collect::<Vec<_>>(),
        })
    }
}

/// `ticketRuns`: a ticket's activity split into runs with their cost and tokens.
pub fn ticket_runs(activity: &[Value]) -> Vec<TicketRun> {
    struct Cur {
        r: TicketRun,
        marked: bool,
        done: bool,
        models: Vec<(String, f64)>,
    }
    let mut out: Vec<Cur> = Vec::new();
    let mut last_total: HashMap<String, f64> = HashMap::new();
    let mut last_model: HashMap<String, (f64, f64)> = HashMap::new();
    for e in activity {
        let Some(ev) = e.get("event").filter(|v| v.is_object() || v.is_array()) else { continue };
        let ty = s(ev, "type");
        let marker = ty == "ckanban_run";
        let init = ty == "system" && s(ev, "subtype") == "init";
        let run = e.get("run").cloned().unwrap_or(Value::Null);
        let new = match out.last() {
            None => true,
            Some(c) => marker || !strict_eq(&c.r.run, &run) || e.get("run").is_none() != c.r.run.is_null() || (init && c.done && !c.marked),
        };
        if new {
            let kind = if marker {
                match ev.get("kind") {
                    Some(Value::Null) | None => Value::String("run".into()),
                    Some(k) => k.clone(),
                }
            } else {
                Value::String("run".into())
            };
            out.push(Cur {
                r: TicketRun { run, kind, started_at: e.get("at").cloned().unwrap_or(Value::Null), model: None, tokens: 0.0, cost_usd: 0.0, parts: Vec::new() },
                marked: marker,
                done: false,
                models: Vec::new(),
            });
        }
        let cur = out.last_mut().expect("a run");
        if init && !cur.marked && cur.r.kind.as_str() == Some("run") && s(ev, "permissionMode") == "plan" {
            cur.r.kind = Value::String("planning".into());
        }
        if ty != "result" {
            continue;
        }
        cur.done = true;
        let sid = match ev.get("session_id") {
            Some(Value::Null) | None => String::new(),
            Some(v) => to_string(v),
        };
        let total = pos(ev.get("total_cost_usd"));
        let prev = last_total.get(&sid).copied().unwrap_or(0.0);
        let cost = if total >= prev { total - prev } else { total };
        last_total.insert(sid.clone(), total);
        cur.r.cost_usd += cost;
        cur.r.parts.push((e.get("at").map(to_string).unwrap_or_else(|| "undefined".into()), cost));
        let mu = ev.get("modelUsage").and_then(Value::as_object).filter(|m| !m.is_empty());
        if let Some(mu) = mu {
            for (model, u) in mu {
                let now_tokens = pos(u.get("inputTokens")) + pos(u.get("outputTokens")) + pos(u.get("cacheReadInputTokens")) + pos(u.get("cacheCreationInputTokens"));
                let now_cost = pos(u.get("costUSD"));
                let k = format!("{sid}|{model}");
                let (bt, bc) = last_model.get(&k).copied().unwrap_or((0.0, 0.0));
                let grew = now_tokens >= bt && now_cost >= bc;
                last_model.insert(k, (now_tokens, now_cost));
                cur.r.tokens += if grew { now_tokens - bt } else { now_tokens };
                let add = if grew { now_cost - bc } else { now_cost };
                match cur.models.iter_mut().find(|(m, _)| m == model) {
                    Some(e) => e.1 += add,
                    None => cur.models.push((model.clone(), add)),
                }
            }
        } else if let Some(u) = ev.get("usage").filter(|u| ckanban_core::jsnum::truthy(Some(u))) {
            cur.r.tokens += pos(u.get("input_tokens")) + pos(u.get("output_tokens")) + pos(u.get("cache_read_input_tokens")) + pos(u.get("cache_creation_input_tokens"));
        }
    }
    out.into_iter()
        .filter(|c| c.done)
        .map(|mut c| {
            let mut models = c.models.clone();
            models.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            c.r.model = models.first().map(|m| m.0.clone());
            c.r
        })
        .collect()
}

/// A 5h window snapshot from `usage-windows.json`.
fn span(w: &Value) -> (f64, f64) {
    (ms(s(w, "start")), ms(s(w, "end")))
}

fn window_of(windows: &[Value], t: f64) -> Option<usize> {
    windows.iter().position(|w| {
        let (a, b) = span(w);
        a <= t && t < b
    })
}

/// `windowsNeeded`: the windows the runs fall in, and the current one (indexes into `windows`).
pub fn windows_needed(runs: &[TicketRun], windows: &[Value], now: f64) -> Vec<usize> {
    let mut set: Vec<usize> = Vec::new();
    let mut add = |i: Option<usize>| {
        if let Some(i) = i
            && !set.contains(&i)
        {
            set.push(i);
        }
    };
    add(window_of(windows, now));
    for r in runs {
        for (at, _) in &r.parts {
            add(window_of(windows, ms(at)));
        }
    }
    set
}

/// `ticketUsage`. `machine`: the machine's cost per window (by index, for the windows the ticket has costs in).
pub fn ticket_usage(activity: &[Value], windows: &[Value], machine: &dyn Fn(usize) -> f64, now: f64, window_error: Option<&str>, teammates: &Value, side: f64) -> Value {
    let runs = ticket_runs(activity);
    let current = window_of(windows, now);
    let mut ticket_in: Vec<(usize, f64)> = Vec::new();
    for r in &runs {
        for (at, cost) in &r.parts {
            if let Some(w) = window_of(windows, ms(at)) {
                match ticket_in.iter_mut().find(|(x, _)| *x == w) {
                    Some(e) => e.1 += cost,
                    None => ticket_in.push((w, *cost)),
                }
            }
        }
    }
    let denom: HashMap<usize, f64> = ticket_in.iter().map(|(w, mine)| (*w, machine(*w).max(*mine))).collect();
    let mut pct_current: Option<f64> = current.map(|_| 0.0);
    let mut pct_lifetime: Option<f64> = None;
    let util = |w: usize| windows[w].get("utilization").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let out_runs: Vec<Value> = runs
        .iter()
        .map(|r| {
            let mut pct: Option<f64> = None;
            for (at, cost) in &r.parts {
                let Some(w) = window_of(windows, ms(at)) else { continue };
                let d = denom[&w];
                let share = if d > 0.0 { (cost / d) * util(w) } else { 0.0 };
                pct = Some(pct.unwrap_or(0.0) + share);
                pct_lifetime = Some(pct_lifetime.unwrap_or(0.0) + share);
                if Some(w) == current {
                    pct_current = Some(pct_current.unwrap_or(0.0) + share);
                }
            }
            json!({
                "run": r.run, "kind": r.kind, "startedAt": r.started_at, "model": r.model, "tokens": num(r.tokens),
                "costUsd": num(r.cost_usd), "pct5h": pct.map(num),
            })
        })
        .collect();
    let team_cost = teammates.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
    let run_cost = runs.iter().fold(0.0, |a, r| a + r.cost_usd);
    let window = current.map(|w| {
        let x = &windows[w];
        json!({ "utilization": x.get("utilization").cloned().unwrap_or(Value::Null), "resetsAt": x.get("end").cloned().unwrap_or(Value::Null), "seenAt": x.get("seenAt").cloned().unwrap_or(Value::Null) })
    });
    json!({
        "runs": out_runs,
        "totals": {
            "costUsd": num(run_cost + team_cost + side),
            "tokens": num(runs.iter().fold(0.0, |a, r| a + r.tokens)),
            "pctCurrentWindow": pct_current.map(num),
            "pctLifetime": pct_lifetime.map(num),
        },
        "teammates": if team_cost != 0.0 && !team_cost.is_nan() { teammates.clone() } else { Value::Null },
        "sideCostUsd": num(side),
        "window": window,
        "windowError": if current.is_some() { Value::Null } else { window_error.map_or(Value::Null, |e| Value::String(e.into())) },
    })
}

/// `start`/`end` of a window as ms.
pub fn window_span(w: &Value) -> (f64, f64) {
    span(w)
}

/// `FIVE_HOURS`, for callers that record windows.
pub const WINDOW_MS: f64 = FIVE_HOURS;

// ---------- run log ----------

const RUN_FIELDS: [&str; 8] = ["type", "subtype", "kind", "permissionMode", "session_id", "total_cost_usd", "modelUsage", "usage"];

static RUN_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\{"run":(\d+),"at":"([^"]*)""#).expect("run line pattern"));

#[derive(Default)]
struct RunLog {
    offset: u64,
    size: u64,
    entries: Arc<Vec<Value>>,
    last_run: Option<f64>,
}

/// `RunLogIndex`: per log file, the entries `ticket_runs` needs, read from where the last read stopped.
#[derive(Default)]
pub struct RunLogIndex {
    files: Mutex<HashMap<PathBuf, Arc<Mutex<RunLog>>>>,
}

impl RunLogIndex {
    pub fn new() -> RunLogIndex {
        RunLogIndex::default()
    }

    /// `entries` (blocking).
    pub fn entries(&self, file: &Path) -> Vec<Value> {
        let slot = self.files.lock().entry(file.to_path_buf()).or_default().clone();
        let mut st = slot.lock();
        let Some(ls) = log_stat(file) else {
            *st = RunLog::default();
            return Vec::new();
        };
        let size = ls.size;
        if size < st.size {
            *st = RunLog::default();
        }
        if size <= st.offset {
            st.size = size;
            return st.entries.to_vec();
        }
        let Some(reader) = open_log(file) else { return st.entries.to_vec() };
        let size = size.min(reader.size());
        let mut entries = st.entries.to_vec();
        let mut last_run = st.last_run;
        let next = read_lines(&reader, st.offset, size, &mut |line| add_entry(&mut entries, &mut last_run, line));
        match next {
            Ok(n) => {
                st.offset = n;
                st.size = size;
                st.entries = Arc::new(entries);
                st.last_run = last_run;
                st.entries.to_vec()
            }
            Err(_) => {
                *st = RunLog::default();
                Vec::new()
            }
        }
    }
}

fn add_entry(entries: &mut Vec<Value>, last_run: &mut Option<f64>, line: &str) {
    if line.is_empty() {
        return;
    }
    let wanted = line.contains("\"ckanban_run\"") || line.contains("\"subtype\":\"init\"") || line.contains("\"type\":\"result\"");
    if wanted {
        let Some(Value::Object(mut e)) = crate::runs::js::parse(line) else { return };
        let Some(ev) = e.get("event").filter(|v| v.is_object() || v.is_array()) else { return };
        let mut slim = Map::new();
        for k in RUN_FIELDS {
            if let Some(v) = ev.get(k) {
                slim.insert(k.into(), v.clone());
            }
        }
        e.insert("event".into(), Value::Object(slim));
        *last_run = Some(e.get("run").and_then(Value::as_f64).unwrap_or(f64::NAN));
        entries.push(Value::Object(e));
        return;
    }
    let Some(m) = RUN_LINE.captures(line) else { return };
    let run: f64 = m[1].parse().unwrap_or(f64::NAN);
    if Some(run) == *last_run {
        return;
    }
    *last_run = Some(run);
    entries.push(json!({ "run": num(run), "at": &m[2], "event": { "type": "other" } }));
}

// ---------- huddles: teammates' spend and team usage ----------

/// `teammateSpend`: what the agents of a ticket's huddles spent.
pub fn teammate_spend(huddles: &[Arc<Value>], ticket_id: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let mut total = 0.0;
    for h in huddles {
        if s(h, "hostTicket") != ticket_id {
            continue;
        }
        let teammates: Vec<(String, Value, f64)> = h
            .get("participants")
            .and_then(Value::as_array)
            .map(|ps| {
                ps.iter()
                    .filter(|p| s(p, "kind") == "agent" && p.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0) > 0.0)
                    .map(|p| (s(p, "handle").to_string(), p.get("role").cloned().unwrap_or(Value::Null), p.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0)))
                    .collect()
            })
            .unwrap_or_default();
        if teammates.is_empty() {
            continue;
        }
        let cost = teammates.iter().fold(0.0, |a, t| a + t.2);
        total += cost;
        out.push(json!({
            "id": h.get("id"), "status": h.get("status"), "createdAt": h.get("createdAt"), "costUsd": num(cost),
            "teammates": teammates.iter().map(|(handle, role, c)| json!({ "handle": handle, "role": role, "costUsd": num(*c) })).collect::<Vec<_>>(),
        }));
    }
    json!({ "costUsd": num(total), "huddles": out })
}

/// Recent huddles kept per teammate or template.
pub const RECENT_HUDDLES: usize = 5;

fn summary(list: &[Value]) -> Value {
    let mut recent: Vec<&Value> = list.iter().collect();
    recent.sort_by(|a, b| crate::runs::js::locale_compare(s(b, "at"), s(a, "at")));
    let cost = list.iter().fold(0.0, |a, u| a + u.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0));
    json!({
        "huddles": list.len(),
        "lastUsed": recent.first().map(|u| u["at"].clone()),
        "costUsd": num((cost * 10000.0).round() / 10000.0),
        "recent": recent.into_iter().take(RECENT_HUDDLES).cloned().collect::<Vec<_>>(),
    })
}

/// `huddleUsage`: usage per preset name and per template name. `input`: (board, huddle, host ticket's title).
pub fn huddle_usage(input: &[(String, Arc<Value>, Option<String>)]) -> Value {
    let mut by_preset: Vec<(String, Vec<Value>)> = Vec::new();
    let mut by_template: Vec<(String, Vec<Value>)> = Vec::new();
    let add = |m: &mut Vec<(String, Vec<Value>)>, k: &str, u: Value| match m.iter_mut().find(|(x, _)| x == k) {
        Some(e) => e.1.push(u),
        None => m.push((k.to_string(), vec![u])),
    };
    for (board, h, title) in input {
        let created = h.get("createdAt").cloned().unwrap_or(Value::Null);
        let base = |at: Value, cost: f64| json!({ "board": board, "huddle": h.get("id"), "ticket": h.get("hostTicket"), "title": title, "at": at, "costUsd": num(cost) });
        let mut presets: Vec<(String, Value, f64)> = Vec::new();
        let parts = h.get("participants").and_then(Value::as_array).cloned().unwrap_or_default();
        for p in &parts {
            let preset = p.get("preset").filter(|v| ckanban_core::jsnum::truthy(Some(v))).map(to_string);
            let Some(preset) = preset else { continue };
            if s(p, "kind") == "human" {
                continue;
            }
            let joined = p.get("joinedAt").filter(|v| ckanban_core::jsnum::truthy(Some(v))).cloned().unwrap_or(created.clone());
            let c = p.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
            match presets.iter_mut().find(|(n, _, _)| *n == preset) {
                Some(e) => {
                    let later = to_string(&e.1) > to_string(&joined);
                    if !later {
                        e.1 = joined;
                    }
                    e.2 += c;
                }
                None => presets.push((preset, joined, c)),
            }
        }
        for (name, at, c) in presets {
            add(&mut by_preset, &name, base(at, c));
        }
        if let Some(t) = h.get("template").filter(|v| ckanban_core::jsnum::truthy(Some(v))).map(to_string) {
            let c = parts.iter().fold(0.0, |a, p| a + p.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0));
            add(&mut by_template, &t, base(created.clone(), c));
        }
    }
    let out = |m: Vec<(String, Vec<Value>)>| Value::Object(m.into_iter().map(|(k, v)| (k, summary(&v))).collect());
    json!({ "teammates": out(by_preset), "templates": out(by_template) })
}

/// Every board's huddle files, kept by mtime and size (`Store.huddleIndex`), sorted by `createdAt`.
pub struct HuddleFiles {
    root: PathBuf,
    dir: Mutex<ckanban_core::json_dir::JsonDir<Value>>,
}

impl HuddleFiles {
    pub fn new(root: &Path) -> HuddleFiles {
        let o = ckanban_core::json_dir::Options {
            matches: ckanban_core::json_dir::huddle_json,
            parse: |t| serde_json::from_str::<Value>(t).ok().map(ckanban_core::jsnum::normalize),
            sort: |a, b| s(a, "createdAt").cmp(s(b, "createdAt")),
            live: None,
            now: ckanban_core::time::now_ms,
        };
        HuddleFiles { root: root.to_path_buf(), dir: Mutex::new(ckanban_core::json_dir::JsonDir::new(o)) }
    }

    /// A board's huddles (blocking).
    pub fn list(&self, slug: &str) -> Arc<Vec<Arc<Value>>> {
        let d = ckanban_core::DataDir::new(&self.root).huddles_dir(slug);
        self.dir.lock().list(&d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_split_and_priced() {
        let a = vec![
            json!({ "run": 1, "at": "2026-11-16T10:00:00.000Z", "event": { "type": "ckanban_run", "kind": "work" } }),
            json!({ "run": 1, "at": "2026-11-16T10:05:00.000Z", "event": { "type": "result", "session_id": "s", "total_cost_usd": 0.5, "modelUsage": { "opus": { "inputTokens": 10, "costUSD": 0.5 } } } }),
            json!({ "run": 2, "at": "2026-11-16T11:00:00.000Z", "event": { "type": "other" } }),
            json!({ "run": 2, "at": "2026-11-16T11:05:00.000Z", "event": { "type": "result", "session_id": "s", "total_cost_usd": 0.75 } }),
        ];
        let r = ticket_runs(&a);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].kind, json!("work"));
        assert_eq!(r[0].model.as_deref(), Some("opus"));
        assert_eq!(r[1].cost_usd, 0.25);
    }

    #[test]
    fn run_log_keeps_what_matters() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("activity.jsonl");
        std::fs::write(&f, "{\"run\":1,\"at\":\"a\",\"event\":{\"type\":\"assistant\",\"big\":1}}\n{\"run\":1,\"at\":\"b\",\"event\":{\"type\":\"result\",\"total_cost_usd\":1,\"result\":\"x\"}}\n{\"run\":2,\"at\":\"c\",\"event\":{\"type\":\"user\"}}\n").unwrap();
        let idx = RunLogIndex::new();
        let e = idx.entries(&f);
        assert_eq!(e.len(), 3);
        assert_eq!(e[0], json!({ "run": 1, "at": "a", "event": { "type": "other" } }));
        assert_eq!(e[1]["event"], json!({ "type": "result", "total_cost_usd": 1 }));
        assert_eq!(e[2]["run"], json!(2));
    }
}
