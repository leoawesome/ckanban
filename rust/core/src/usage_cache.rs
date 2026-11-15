//! `UsageCache` from `src/usage/usage-cache.ts`: what the board serves for plan usage. The endpoint rate-limits, so:
//! one check in flight for everyone, a good answer reused for 4 minutes, at most one check a minute (`fresh` too), a
//! growing wait after a 429 (retry-after when longer), and the last good answer kept through errors.
//!
//! The state lives in `usage-last.json`, in Bun's format (compact JSON, no final newline, times in epoch ms), written
//! by atomic rename. The file is read again whenever it changed on disk, so a check made by the Bun daemon (or
//! another Rust process) counts here too: the shared minute gap and backoff hold across both, and Rust never asks
//! Anthropic more often than Bun alone would.

use crate::atomic::atomic_write;
use crate::jsnum::{finite, normalize_map, num, truthy};
use crate::time::{iso, parse_date};
use crate::usage::{windows_json, UsageClient, UsageResult, RATE_LIMITED};
use serde_json::{Map, Value};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// A good answer is reused this long by every caller (page opens, ticket Usage tabs).
pub const GOOD_TTL_MS: f64 = 4.0 * 60_000.0;
/// Never ask Anthropic more often than this, Refresh included.
pub const MIN_GAP_MS: f64 = 60_000.0;
/// Waits after 1, 2, 3, 4+ 429s in a row when Anthropic sends no retry-after.
pub const BACKOFF_MS: [f64; 4] = [60_000.0, 120_000.0, 240_000.0, 600_000.0];
/// A retry-after longer than this is capped (a bad header must not hide usage for hours).
const MAX_RETRY_AFTER_MS: f64 = 30.0 * 60_000.0;
/// A usage check (keychain read + request) that takes longer than this counts as failed, so nobody waits on it.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Fetcher = Arc<dyn Fn() -> BoxFuture<UsageResult> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
type Hook = Box<dyn Fn(&UsageResult) + Send + Sync>;
type Log = Box<dyn Fn(&str) + Send + Sync>;

#[derive(Clone, Debug, PartialEq)]
struct LastError {
    error: String,
    at: f64,
    limited: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Saved {
    /// `{ windows, fetchedAt, ... }` as saved: any other fields in it are kept and served, as Bun's spread does.
    last: Option<Map<String, Value>>,
    last_error: Option<LastError>,
    attempt_at: f64,
    blocked_until: f64,
    failures: f64,
}

#[derive(Default)]
struct State {
    saved: Saved,
    /// Times of the calls to Anthropic in the last hour, for the log line.
    calls: Vec<f64>,
    /// Size and change time of usage-last.json when last read or written here.
    stamp: Option<(u64, SystemTime)>,
}

/// Saved times past `now` + the longest wait come from a clock set back; they must not block checks.
/// None when the file is missing or isn't JSON (Bun's `load` returning null).
fn load(text: &str, now: f64) -> Option<Saved> {
    let j: Value = serde_json::from_str(text).ok()?;
    let n = |k: &str| finite(j.get(k)).unwrap_or(0.0);
    let last = j.get("last").and_then(Value::as_object).filter(|l| l.get("windows").is_some_and(Value::is_array) && l.get("fetchedAt").is_some_and(Value::is_string));
    let last_error = j.get("lastError").filter(|e| truthy(Some(e))).and_then(|e| {
        let error = e.get("error")?.as_str()?.to_string();
        let at = e.get("at")?.as_f64()?;
        Some(LastError { error, at, limited: truthy(e.get("limited")) })
    });
    let attempt_at = if n("attemptAt") > now { now } else { n("attemptAt") };
    Some(Saved {
        last: last.cloned().map(normalize_map),
        last_error,
        attempt_at,
        blocked_until: n("blockedUntil").min(now + MAX_RETRY_AFTER_MS),
        failures: n("failures"),
    })
}

/// `JSON.stringify(saved)`: the exact bytes Bun writes.
fn dump(s: &Saved) -> String {
    let mut m = Map::new();
    m.insert("last".into(), s.last.clone().map_or(Value::Null, Value::Object));
    m.insert(
        "lastError".into(),
        s.last_error.as_ref().map_or(Value::Null, |e| {
            let mut o = Map::new();
            o.insert("error".into(), e.error.clone().into());
            o.insert("at".into(), num(e.at));
            o.insert("limited".into(), e.limited.into());
            Value::Object(o)
        }),
    );
    m.insert("attemptAt".into(), num(s.attempt_at));
    m.insert("blockedUntil".into(), num(s.blocked_until));
    m.insert("failures".into(), num(s.failures));
    serde_json::to_string(&m).expect("json")
}

/// The answer for `GET /api/usage`.
fn view(s: &Saved, now: f64) -> Value {
    let e = s.last_error.as_ref();
    let retry_at = (s.blocked_until > now).then(|| iso(s.blocked_until));
    let extra = |m: &mut Map<String, Value>| {
        if e.is_some_and(|e| e.limited) {
            m.insert("limited".into(), true.into());
        }
        if let Some(r) = &retry_at {
            m.insert("retryAt".into(), r.clone().into());
        }
    };
    if let Some(last) = &s.last {
        let mut m = last.clone();
        if let Some(e) = e {
            m.insert("stale".into(), true.into());
            m.insert("error".into(), e.error.clone().into());
            extra(&mut m);
        }
        return Value::Object(m);
    }
    if let Some(e) = e {
        let mins = if retry_at.is_some() { ((s.blocked_until - now) / 60_000.0).ceil().max(1.0) } else { 0.0 };
        let error = if e.limited && mins != 0.0 { format!("{RATE_LIMITED}; next try in about {} min", crate::jsnum::js_string(mins)) } else { e.error.clone() };
        let mut m = Map::new();
        m.insert("error".into(), error.into());
        m.insert("fetchedAt".into(), iso(e.at).into());
        extra(&mut m);
        return Value::Object(m);
    }
    // Only reachable while nothing was ever asked and a call is blocked, e.g. right after a restart inside the gap.
    let mut m = Map::new();
    m.insert("error".into(), "Usage not checked yet; try Refresh in a minute".into());
    m.insert("fetchedAt".into(), iso(now).into());
    Value::Object(m)
}

pub struct UsageCache {
    state: Mutex<State>,
    /// Held for the whole check: callers that come meanwhile wait for it and then get its answer (Bun's `inflight`).
    gate: tokio::sync::Mutex<()>,
    fetcher: Fetcher,
    on_result: Option<Hook>,
    now: Clock,
    file: Option<PathBuf>,
    log: Option<Log>,
    timeout: Duration,
}

impl UsageCache {
    pub fn new(fetcher: Fetcher, now: Clock, file: Option<PathBuf>) -> Self {
        let c = Self {
            state: Mutex::new(State::default()),
            gate: tokio::sync::Mutex::new(()),
            fetcher,
            on_result: None,
            now,
            file,
            log: None,
            timeout: FETCH_TIMEOUT,
        };
        c.reload_if_changed();
        c
    }

    /// The daemon's cache (`context.ts`): asks with `client`, saves to `usage-last.json`, records each 5h window in
    /// `usage-windows.json`, and logs one line per call to Anthropic.
    pub fn for_daemon(dir: &crate::DataDir, client: UsageClient) -> Self {
        let client = Arc::new(client);
        let fetcher: Fetcher = Arc::new(move || {
            let c = client.clone();
            Box::pin(async move { c.fetch_usage().await })
        });
        let windows = dir.usage_windows();
        Self::new(fetcher, Arc::new(crate::time::now_ms), Some(dir.usage_last()))
            .on_result(move |r| {
                let _ = crate::usage_windows::record_window(&windows, r);
            })
            .log(|line| println!("{line}"))
    }

    pub fn on_result(mut self, f: impl Fn(&UsageResult) + Send + Sync + 'static) -> Self {
        self.on_result = Some(Box::new(f));
        self
    }
    pub fn log(mut self, f: impl Fn(&str) + Send + Sync + 'static) -> Self {
        self.log = Some(Box::new(f));
        self
    }
    pub fn timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }

    fn stamp(&self) -> Option<(u64, SystemTime)> {
        let m = std::fs::metadata(self.file.as_ref()?).ok()?;
        Some((m.len(), m.modified().ok()?))
    }

    /// Reads usage-last.json again when it changed since this cache last read or wrote it (another process checked).
    fn reload_if_changed(&self) {
        if self.file.is_none() {
            return;
        }
        let stamp = self.stamp();
        let mut st = self.state.lock().unwrap();
        if stamp.is_none() || stamp == st.stamp {
            return;
        }
        st.stamp = stamp;
        let now = (self.now)();
        if let Some(saved) = self.file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|t| load(&t, now)) {
            st.saved = saved;
        }
    }

    /// Cached usage; `fresh` (the Refresh button) asks now unless a call went out in the last minute or we are
    /// backing off. Always an answer: failures are in the body.
    pub async fn get(&self, fresh: bool) -> Value {
        let _one = self.gate.lock().await;
        self.reload_if_changed();
        let now = (self.now)();
        {
            let mut st = self.state.lock().unwrap();
            let s = &st.saved;
            if now < s.blocked_until || now - s.attempt_at < MIN_GAP_MS {
                return view(s, now);
            }
            let good_age = s.last.as_ref().and_then(|l| l.get("fetchedAt")?.as_str().and_then(parse_date)).map_or(f64::INFINITY, |t| now - t);
            let failed_since = s.last_error.as_ref().is_some_and(|e| e.at >= s.attempt_at);
            if !fresh && good_age < GOOD_TTL_MS && !failed_since {
                return view(s, now);
            }
            st.saved.attempt_at = now;
        }
        let started = now;
        let r = match tokio::time::timeout(self.timeout, (self.fetcher)()).await {
            Ok(r) => r,
            Err(_) => UsageResult::failure(
                format!("Usage check took over {}s", crate::jsnum::js_string(self.timeout.as_millis() as f64 / 1000.0)),
                iso((self.now)()),
            ),
        };
        self.settle(&r, started);
        if let Some(f) = &self.on_result {
            f(&r);
        }
        let st = self.state.lock().unwrap();
        view(&st.saved, (self.now)())
    }

    fn settle(&self, r: &UsageResult, started: f64) {
        let now = (self.now)();
        let mut st = self.state.lock().unwrap();
        st.calls.retain(|t| now - t < 3_600_000.0);
        st.calls.push(started);
        let s = &mut st.saved;
        let what = match r {
            UsageResult::Answer { windows, fetched_at } => {
                let mut m = Map::new();
                m.insert("windows".into(), windows_json(windows));
                m.insert("fetchedAt".into(), fetched_at.clone().into());
                s.last = Some(m);
                s.last_error = None;
                s.failures = 0.0;
                s.blocked_until = 0.0;
                "200".to_string()
            }
            UsageResult::Failure { error, status, retry_after_ms, .. } => {
                let limited = *status == Some(429);
                s.last_error = Some(LastError { error: error.clone(), at: now, limited });
                if limited {
                    s.failures += 1.0;
                    // retry-after can lengthen the growing wait, never shorten it.
                    let i = (s.failures.floor() as usize).clamp(1, BACKOFF_MS.len()) - 1;
                    let wait = retry_after_ms.unwrap_or(0.0).max(BACKOFF_MS[i]).min(MAX_RETRY_AFTER_MS);
                    s.blocked_until = now + wait;
                } else {
                    s.failures = 0.0;
                    s.blocked_until = 0.0;
                }
                format!("{} ({error})", status.map_or("no answer".to_string(), |x| x.to_string()))
            }
        };
        // Status and timing only: the token never reaches this module.
        if let Some(log) = &self.log {
            let wait = if s.blocked_until > now { format!("; next check after {}s", crate::jsnum::js_string(((s.blocked_until - now) / 1000.0).round())) } else { String::new() };
            log(&format!(
                "[usage] asked Anthropic: {what} in {}ms; {} checks in the last hour{wait}",
                crate::jsnum::js_string(now - started),
                st.calls.len()
            ));
        }
        let text = dump(&st.saved);
        if let Some(f) = &self.file {
            if atomic_write(f, text).is_ok() {
                drop(st);
                let stamp = self.stamp();
                self.state.lock().unwrap().stamp = stamp;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_clamps_times_from_a_clock_set_back() {
        let s = load(r#"{"last":null,"lastError":null,"attemptAt":5000,"blockedUntil":99999999,"failures":2}"#, 1000.0).unwrap();
        assert_eq!(s.attempt_at, 1000.0);
        assert_eq!(s.blocked_until, 1000.0 + MAX_RETRY_AFTER_MS);
        assert_eq!(s.failures, 2.0);
        assert!(load("not json", 0.0).is_none());
        assert_eq!(load("null", 0.0), Some(Saved::default()));
    }
}
