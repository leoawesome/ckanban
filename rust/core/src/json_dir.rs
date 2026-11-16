//! A folder of small JSON files (schedules, jobs, automations, huddles, quick chats), parsed once and kept by each
//! file's mtime and size: `JsonDir` in `src/core/json-dir.ts`. A list costs a stat of the folder and of the live
//! entries; only files that changed are read again. Writers tell it about their own writes (`saved`, `touched`) so
//! those don't make it look at the whole folder.
//!
//! Bun slices the first read of a big folder with `pauser()`; here every call is plain blocking work meant to run
//! off the request path (a `spawn_blocking` task or a background thread), so there is no pause. Methods take
//! `&mut self`: share one behind a `Mutex`.

use crate::time::system_ms;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// How often every file of a folder is stat'ed again even though the folder itself didn't change.
pub const RECHECK_MS: f64 = 5.0 * 60_000.0;

pub struct Options<T> {
    /// Which file names are entries (e.g. `^[a-z0-9]+\.json$`, not `*.state.json`).
    pub matches: fn(&str) -> bool,
    /// The entry from the file's text; None leaves the file out.
    pub parse: fn(&str) -> Option<T>,
    pub sort: fn(&T, &T) -> std::cmp::Ordering,
    /// Entries still in play (a scheduled job, an open huddle): stat'ed on every list, so an edit made in place by
    /// another process shows at once.
    pub live: Option<fn(&T) -> bool>,
    pub now: fn() -> f64,
}

type Key = (u64, u64);

struct Entry<T> {
    key: Key,
    value: Option<Arc<T>>,
}

struct Dir<T> {
    mtime: f64,
    checked_at: f64,
    files: HashMap<String, Entry<T>>,
    list: Option<Arc<Vec<Arc<T>>>>,
    live: Option<Arc<Vec<Arc<T>>>>,
    gen: u64,
}

pub struct JsonDir<T> {
    o: Options<T>,
    dirs: HashMap<PathBuf, Dir<T>>,
    rechecking: bool,
}

fn key_of(file: &Path) -> Option<Key> {
    let m = fs::metadata(file).ok()?;
    let mtime = m.modified().map(|t| system_ms(t).to_bits()).unwrap_or(0);
    Some((mtime, m.len()))
}

fn mtime_of(dir: &Path) -> Option<f64> {
    fs::metadata(dir).ok()?.modified().ok().map(system_ms)
}

/// `^[a-z0-9]+\.json$`: the entry files of schedules, jobs, automations and quick chats.
pub fn id_json(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(crate::layout::is_short_id)
}

/// `^h_[a-z0-9_]+\.json$` (case-insensitive): huddle files.
pub fn huddle_json(name: &str) -> bool {
    name.len() > 5 && name[name.len() - 5..].eq_ignore_ascii_case(".json") && crate::layout::is_huddle_id(&name[..name.len() - 5])
}

impl<T> JsonDir<T> {
    pub fn new(o: Options<T>) -> Self {
        Self { o, dirs: HashMap::new(), rechecking: false }
    }

    /// The folder's entries, sorted. Shared: clone an entry before changing it.
    pub fn list(&mut self, dir: &Path) -> Arc<Vec<Arc<T>>> {
        let sort = self.o.sort;
        let Some(d) = self.current(dir) else { return Arc::default() };
        if d.list.is_none() {
            let mut v: Vec<Arc<T>> = d.files.values().filter_map(|f| f.value.clone()).collect();
            v.sort_by(|a, b| sort(a, b));
            d.list = Some(Arc::new(v));
        }
        d.list.clone().unwrap_or_default()
    }

    /// Only the live entries, sorted.
    pub fn live_list(&mut self, dir: &Path) -> Arc<Vec<Arc<T>>> {
        let all = self.list(dir);
        let live = self.o.live;
        let Some(d) = self.dirs.get_mut(dir) else { return Arc::default() };
        if d.live.is_none() {
            d.live = Some(Arc::new(all.iter().filter(|v| live.is_none_or(|f| f(v))).cloned().collect()));
        }
        d.live.clone().unwrap_or_default()
    }

    /// A number that moves on whenever the folder's list changes.
    pub fn version(&mut self, dir: &Path) -> u64 {
        self.current(dir).map_or(0, |d| d.gen)
    }

    /// The folder's mtime now, or None when it doesn't exist (pass it to `saved` / `touched`).
    pub fn mtime(&self, dir: &Path) -> Option<f64> {
        mtime_of(dir)
    }

    /// After a write (Some) or delete (None) of one entry file by this process. `mtime_before`: the folder's mtime
    /// just before; when it is the one the cache knows, the folder's new mtime is taken as ours (no rescan).
    pub fn saved(&mut self, dir: &Path, name: &str, value: Option<T>, mtime_before: Option<f64>) {
        let Some(d) = self.dirs.get_mut(dir) else { return };
        match value.and_then(|v| key_of(&dir.join(name)).map(|k| (k, v))) {
            Some((key, v)) => {
                d.files.insert(name.to_string(), Entry { key, value: Some(Arc::new(v)) });
            }
            None => {
                d.files.remove(name);
            }
        }
        if mtime_before.is_some() && mtime_before == Some(d.mtime) {
            if let Some(m) = mtime_of(dir) {
                d.mtime = m;
            }
        }
        changed(d);
    }

    /// After this process added a file to the folder that isn't an entry (a history or message log).
    pub fn touched(&mut self, dir: &Path, mtime_before: Option<f64>) {
        let Some(d) = self.dirs.get_mut(dir) else { return };
        if mtime_before.is_some() && mtime_before == Some(d.mtime) {
            if let Some(m) = mtime_of(dir) {
                d.mtime = m;
            }
        }
    }

    /// Stats every known file again to catch entries edited in place from outside. Once called, lists leave this to
    /// the caller's timer (every `RECHECK_MS`) instead of doing it inside whichever list comes next.
    pub fn recheck(&mut self, dir: &Path) {
        self.rechecking = true;
        let now = (self.o.now)();
        let parse = self.o.parse;
        let Some(d) = self.dirs.get_mut(dir) else { return };
        let mut any = false;
        let names: Vec<String> = d.files.keys().cloned().collect();
        for name in names {
            any |= refresh(d, dir, &name, parse);
        }
        if any {
            changed(d);
        }
        d.checked_at = d.checked_at.max(now);
    }

    /// The folder's cache, brought up to date; None when the folder doesn't exist.
    fn current(&mut self, dir: &Path) -> Option<&mut Dir<T>> {
        let Some(mtime) = mtime_of(dir) else {
            self.dirs.remove(dir);
            return None;
        };
        let now = (self.o.now)();
        let stale = match self.dirs.get(dir) {
            None => true,
            Some(d) => d.mtime != mtime || (!self.rechecking && now - d.checked_at >= RECHECK_MS),
        };
        if stale {
            return self.rescan(dir, mtime, now);
        }
        let live = self.o.live;
        let parse = self.o.parse;
        let d = self.dirs.get_mut(dir)?;
        // The folder is as it was: only live entries (all of them without a `live` rule) can have been rewritten in place.
        let names: Vec<String> = d.files.iter().filter(|(_, f)| f.value.as_ref().is_some_and(|v| live.is_none_or(|l| l(v)))).map(|(n, _)| n.clone()).collect();
        let mut any = false;
        for name in names {
            any |= refresh(d, dir, &name, parse);
        }
        if any {
            changed(d);
        }
        Some(d)
    }

    fn rescan(&mut self, dir: &Path, mtime: f64, now: f64) -> Option<&mut Dir<T>> {
        let names: Vec<String> = match fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| (self.o.matches)(n)).collect(),
            Err(_) => {
                self.dirs.remove(dir);
                return None;
            }
        };
        let mut old = self.dirs.remove(dir);
        let mut files = HashMap::new();
        let mut any = old.as_ref().is_none_or(|d| d.files.len() != names.len());
        for name in names {
            let prev = old.as_mut().and_then(|d| d.files.remove(&name));
            let Some(key) = key_of(&dir.join(&name)) else {
                any = true;
                continue;
            };
            let entry = match prev {
                Some(p) if p.key == key => p,
                _ => {
                    any = true;
                    Entry { key, value: read_entry(&dir.join(&name), self.o.parse) }
                }
            };
            files.insert(name, entry);
        }
        let d = match old {
            Some(o) if !any => Dir { mtime, checked_at: now, files, list: o.list, live: o.live, gen: o.gen },
            o => Dir { mtime, checked_at: now, files, list: None, live: None, gen: o.map_or(0, |o| o.gen) + 1 },
        };
        self.dirs.insert(dir.to_path_buf(), d);
        self.dirs.get_mut(dir)
    }
}

fn read_entry<T>(file: &Path, parse: fn(&str) -> Option<T>) -> Option<Arc<T>> {
    fs::read_to_string(file).ok().and_then(|t| parse(&t)).map(Arc::new)
}

/// Stats one known file again: re-read when it changed, dropped when it is gone. True when anything changed.
fn refresh<T>(d: &mut Dir<T>, dir: &Path, name: &str, parse: fn(&str) -> Option<T>) -> bool {
    let file = dir.join(name);
    match key_of(&file) {
        None => d.files.remove(name).is_some(),
        Some(key) if d.files.get(name).is_some_and(|f| f.key == key) => false,
        Some(key) => {
            d.files.insert(name.to_string(), Entry { key, value: read_entry(&file, parse) });
            true
        }
    }
}

fn changed<T>(d: &mut Dir<T>) {
    d.list = None;
    d.live = None;
    d.gen += 1;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datafile::parse_json;
    use serde_json::Value;

    fn opts() -> Options<Value> {
        Options {
            matches: id_json,
            parse: parse_json,
            sort: |a, b| a["at"].as_str().cmp(&b["at"].as_str()),
            live: Some(|v| v["state"] == "scheduled"),
            now: crate::time::now_ms,
        }
    }

    #[test]
    fn lists_sorted_and_follows_changes() {
        let d = std::env::temp_dir().join(format!("ckrs-jsondir-{}", crate::atomic::new_id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("b.json"), r#"{"at":"2","state":"done"}"#).unwrap();
        fs::write(d.join("a.json"), r#"{"at":"1","state":"scheduled"}"#).unwrap();
        fs::write(d.join("a.state.json"), "{}").unwrap();
        fs::write(d.join("bad.json"), "not json").unwrap();
        let mut j = JsonDir::new(opts());
        let l = j.list(&d);
        assert_eq!(l.iter().map(|v| v["at"].as_str().unwrap()).collect::<Vec<_>>(), ["1", "2"]);
        let v0 = j.version(&d);
        assert_eq!(j.live_list(&d).len(), 1);
        // A live entry rewritten in place (same folder mtime) shows at once.
        let before = j.mtime(&d);
        fs::write(d.join("a.json"), r#"{"at":"1","state":"done","more":true}"#).unwrap();
        assert_eq!(j.list(&d)[0]["more"], true);
        assert!(j.version(&d) > v0);
        // Our own write: no rescan needed.
        crate::atomic::atomic_write(&d.join("c.json"), r#"{"at":"0","state":"scheduled"}"#).unwrap();
        j.saved(&d, "c.json", parse_json(r#"{"at":"0","state":"scheduled"}"#), before);
        assert_eq!(j.list(&d)[0]["at"], "0");
        assert!(j.list(&Path::new("/nonexistent/ckrs")).is_empty());
        let _ = fs::remove_dir_all(d);
    }
}
