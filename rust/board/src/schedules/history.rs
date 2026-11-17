//! A schedule's history file (`<id>.history.jsonl`, append-only): what the schedules list and a quiet run need from it
//! without its whole file (`src/schedules/schedule-history.ts`), and its newest entries (`scheduleHistoryTail` of
//! `store.ts`). A history can grow for years: the digest reads only the bytes appended since last time; a file that
//! got shorter, or changed without growing, is read again from the start.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};

use ckanban_core::time::{iso, now_ms, system_ms};
use parking_lot::Mutex;
use serde_json::Value;

use super::text::day;

/// Days of fires and quiet runs kept for the spend figure (the list shows 7; one more for the day boundary).
const RECENT_MS: f64 = 8.0 * 86_400_000.0;
/// Fired entries kept for a quiet run's "last check".
const LAST_FIRED: usize = 3;
/// History files kept in memory.
const MAX_FILES: usize = 200;
const CHUNK: usize = 1024 * 1024;

/// The digest of one history file.
#[derive(Debug, Clone, Default)]
pub struct Digest {
    /// Quiet runs per local day (all of the history).
    pub quiet_per_day: BTreeMap<String, u64>,
    /// The last "paused" edit, unless a later "resumed" undid it: `(at, by)`.
    pub last_pause: Option<(String, Value)>,
    /// Fires and quiet runs of about the last 8 days.
    pub recent: Vec<Value>,
    /// The last few fires.
    pub last_fired: VecDeque<Value>,
}

#[derive(Default, Clone)]
struct State {
    offset: u64,
    mtime: f64,
    d: Digest,
    /// Use order, for dropping the oldest file past MAX_FILES.
    used: u64,
}

#[derive(Default)]
pub struct Digests {
    files: Mutex<(HashMap<PathBuf, State>, u64)>,
}

fn s<'a>(e: &'a Value, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}

fn fold(d: &mut Digest, e: &Value, from: &str) {
    if !e.is_object() || !e.get("at").is_some_and(Value::is_string) {
        return;
    }
    let (kind, at) = (s(e, "kind"), s(e, "at"));
    if kind == "quiet" {
        *d.quiet_per_day.entry(day(at)).or_insert(0) += 1;
    }
    if kind == "edited" && s(e, "action") == "paused" {
        d.last_pause = Some((at.to_string(), e.get("by").cloned().unwrap_or(Value::Null)));
    }
    if kind == "edited" && s(e, "action") == "resumed" {
        d.last_pause = None;
    }
    if (kind == "fired" || kind == "quiet") && at >= from {
        d.recent.push(e.clone());
    }
    if kind == "fired" {
        d.last_fired.push_back(e.clone());
        if d.last_fired.len() > LAST_FIRED {
            d.last_fired.pop_front();
        }
    }
}

impl Digests {
    pub fn new() -> Self {
        Self::default()
    }

    /// The digest of `file`, reading what was appended since last time.
    pub fn get(&self, file: &Path) -> Digest {
        let Ok(meta) = std::fs::metadata(file) else {
            self.files.lock().0.remove(file);
            return Digest::default();
        };
        let size = meta.len();
        let mtime = meta.modified().map(system_ms).unwrap_or(0.0);
        let mut st = {
            let g = self.files.lock();
            g.0.get(file).cloned().unwrap_or_default()
        };
        if size < st.offset || (size == st.offset && mtime != st.mtime) {
            st = State::default();
        }
        if size > st.offset {
            let from = iso(now_ms() - RECENT_MS);
            if let Ok(f) = File::open(file) {
                let mut rest: Vec<u8> = Vec::new();
                while st.offset + (rest.len() as u64) < size {
                    let want = CHUNK.min((size - st.offset) as usize - rest.len());
                    let mut buf = vec![0u8; want];
                    let n = f.read_at(&mut buf, st.offset + rest.len() as u64).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    rest.extend_from_slice(&buf[..n]);
                    // Only whole lines: a line still being written is read next time.
                    let end = rest.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1);
                    for line in String::from_utf8_lossy(&rest[..end]).split('\n') {
                        if crate::runs::js::trim(line).is_empty() {
                            continue;
                        }
                        if let Some(v) = crate::runs::js::parse(line) {
                            fold(&mut st.d, &v, &from);
                        }
                    }
                    st.offset += end as u64;
                    rest.drain(..end);
                }
            }
            if st.d.recent.first().is_some_and(|e| s(e, "at") < from.as_str()) {
                st.d.recent.retain(|e| s(e, "at") >= from.as_str());
            }
        }
        st.mtime = mtime;
        let out = st.d.clone();
        let mut g = self.files.lock();
        g.1 += 1;
        st.used = g.1;
        g.0.insert(file.to_path_buf(), st);
        if g.0.len() > MAX_FILES
            && let Some(oldest) = g.0.iter().min_by_key(|(_, v)| v.used).map(|(k, _)| k.clone())
        {
            g.0.remove(&oldest);
        }
        out
    }
}

/// `scheduleHistoryTail`: the newest entries, at least `min` of them (all when the file has fewer; then complete is
/// true), oldest first. Reads the file from its end.
pub fn tail(file: &Path, min: usize) -> (Vec<Value>, bool) {
    let mut pages: Vec<Vec<Value>> = Vec::new();
    let mut n = 0;
    let mut before = None;
    loop {
        let page = ckanban_core::jsonl::read_file_page(file, before, Some(64 * 1024)).unwrap_or(ckanban_core::jsonl::Page { entries: Vec::new(), before: None });
        n += page.entries.len();
        pages.insert(0, page.entries);
        match page.before {
            None => return (pages.concat(), true),
            Some(_) if n >= min => return (pages.concat(), false),
            Some(b) => before = Some(b),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_reads_what_was_appended() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.history.jsonl");
        let now = iso(now_ms());
        std::fs::write(&f, format!("{{\"at\":\"{now}\",\"kind\":\"fired\",\"ticketId\":\"t1\"}}\n{{\"at\":\"{now}\",\"kind\":\"edited\",\"action\":\"paused\",\"by\":\"user\"}}\n")).unwrap();
        let d = Digests::new();
        let g = d.get(&f);
        assert_eq!(g.recent.len(), 1);
        assert_eq!(g.last_pause.as_ref().map(|p| p.1.clone()), Some(Value::from("user")));
        let mut t = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        std::io::Write::write_all(&mut t, format!("{{\"at\":\"{now}\",\"kind\":\"edited\",\"action\":\"resumed\",\"by\":\"user\"}}\n{{\"at\":\"{now}\",\"kind\":\"quiet\",\"ticketId\":\"t2\",\"costUsd\":0.5}}\n").as_bytes()).unwrap();
        let g = d.get(&f);
        assert!(g.last_pause.is_none());
        assert_eq!(g.recent.len(), 2);
        assert_eq!(g.quiet_per_day.values().sum::<u64>(), 1);
        let (all, complete) = tail(&f, 10);
        assert_eq!((all.len(), complete), (4, true));
    }
}
