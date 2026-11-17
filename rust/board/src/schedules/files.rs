//! The schedules, one-time jobs and automations of every board as files, written byte for byte like Bun's `Store`
//! (`saveSchedule`, `appendScheduleHistory`, `saveJob`, `saveLoop`, `saveLoopState`...): pretty JSON and a newline,
//! each object in the key order Bun built it (`serde_json` keeps insertion order). Lists are kept by file mtime and
//! size (`JsonDir`), so a list costs a stat of the folder. Blocking: call from the blocking pool.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::DataDir;
use ckanban_core::datafile::{Layout, formats, to_text};
use ckanban_core::json_dir::{JsonDir, Options, id_json};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::history::{Digest, Digests};

pub type Obj = Map<String, Value>;

fn s<'a>(v: &'a Obj, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn parse_obj(text: &str) -> Option<Obj> {
    match crate::runs::js::parse(text).map(ckanban_core::jsnum::normalize) {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// `parseJob`: a late job older versions kept "missed" reads as skipped.
pub fn parse_job(text: &str) -> Option<Obj> {
    let mut j = parse_obj(text)?;
    if s(&j, "state") == "missed" {
        j.insert("state".into(), "skipped".into());
        let mut r = j.get("result").and_then(Value::as_object).cloned().unwrap_or_default();
        r.insert("message".into(), "was due while the computer was off".into());
        j.insert("result".into(), Value::Object(r));
    }
    Some(j)
}

/// A list's entries that are JSON objects (Bun keeps whatever parses; the routes only ever see objects).
fn by_created(a: &Obj, b: &Obj) -> std::cmp::Ordering {
    s(a, "createdAt").cmp(s(b, "createdAt"))
}

pub struct Files {
    pub dir: DataDir,
    schedules: Mutex<JsonDir<Obj>>,
    jobs: Mutex<JsonDir<Obj>>,
    loops: Mutex<JsonDir<Obj>>,
    histories: Digests,
}

/// The pretty text Bun's `JSON.stringify(v, null, 2) + "\n"` gives.
fn pretty(v: &Obj) -> String {
    let mut t = to_text(&Value::Object(v.clone()), Layout::Indent(2));
    t.push('\n');
    t
}

fn write(file: &Path, text: &str) -> Result<(), String> {
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    ckanban_core::atomic::atomic_write(file, text).map_err(|e| e.to_string())
}

impl Files {
    pub fn new(root: &Path) -> Arc<Files> {
        let o = |live: Option<fn(&Obj) -> bool>, sort: fn(&Obj, &Obj) -> std::cmp::Ordering, parse: fn(&str) -> Option<Obj>| Options {
            matches: id_json,
            parse,
            sort,
            live,
            now: ckanban_core::time::now_ms,
        };
        let by_due = |a: &Obj, b: &Obj| s(a, "at").cmp(s(b, "at")).then_with(|| s(a, "createdAt").cmp(s(b, "createdAt")));
        let open = |j: &Obj| matches!(s(j, "state"), "scheduled" | "running");
        let _ = (formats::SCHEDULE, formats::JOB, formats::LOOP, formats::LOOP_STATE);
        Arc::new(Files {
            dir: DataDir::new(root),
            schedules: Mutex::new(JsonDir::new(o(None, by_created, parse_obj))),
            jobs: Mutex::new(JsonDir::new(o(Some(open), by_due, parse_job))),
            loops: Mutex::new(JsonDir::new(o(None, by_created, parse_obj))),
            histories: Digests::new(),
        })
    }

    /// Every readable board's slug, oldest first (`listProfiles`).
    pub fn boards(&self) -> Vec<(String, PathBuf)> {
        self.dir
            .list_profiles()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| Some((p.slug()?.to_string(), PathBuf::from(p.record.str("path").unwrap_or("")))))
            .collect()
    }

    /// The board's `profile.json` (path as stored), or None.
    pub fn board(&self, slug: &str) -> Option<Obj> {
        self.dir.profile(slug).map(|p| p.record.0.clone())
    }

    fn read(file: Option<PathBuf>, parse: fn(&str) -> Option<Obj>) -> Option<Obj> {
        std::fs::read_to_string(file?).ok().and_then(|t| parse(&t))
    }

    // ---- schedules ----

    pub fn list_schedules(&self, slug: &str) -> Vec<Obj> {
        self.schedules.lock().list(&self.dir.schedules_dir(slug)).iter().map(|v| (**v).clone()).collect()
    }
    pub fn get_schedule(&self, slug: &str, id: &str) -> Option<Obj> {
        Self::read(self.dir.schedule(slug, id), parse_obj)
    }
    pub fn save_schedule(&self, slug: &str, sch: &Obj) -> Result<(), String> {
        let id = s(sch, "id").to_string();
        let file = self.dir.schedule(slug, &id).ok_or("bad schedule id")?;
        let dir = self.dir.schedules_dir(slug);
        let mut d = self.schedules.lock();
        let before = d.mtime(&dir);
        write(&file, &pretty(sch))?;
        d.saved(&dir, &format!("{id}.json"), Some(sch.clone()), before);
        Ok(())
    }
    pub fn delete_schedule(&self, slug: &str, id: &str) {
        let dir = self.dir.schedules_dir(slug);
        let mut d = self.schedules.lock();
        let before = d.mtime(&dir);
        if let Some(f) = self.dir.schedule(slug, id) {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_file(self.dir.schedule_history(slug, id));
        d.saved(&dir, &format!("{id}.json"), None, before);
    }
    pub fn append_history(&self, slug: &str, id: &str, e: &Value) {
        let dir = self.dir.schedules_dir(slug);
        let _ = std::fs::create_dir_all(&dir);
        let mut d = self.schedules.lock();
        let before = d.mtime(&dir);
        let line = to_text(e, Layout::Compact);
        if let Err(err) = ckanban_core::jsonl::append_line(&self.dir.schedule_history(slug, id), &line) {
            eprintln!("[schedules] can't write the history of {slug}/{id}: {err}");
        }
        d.touched(&dir, before);
    }
    pub fn history_digest(&self, slug: &str, id: &str) -> Digest {
        self.histories.get(&self.dir.schedule_history(slug, id))
    }
    pub fn history_tail(&self, slug: &str, id: &str, min: usize) -> (Vec<Value>, bool) {
        super::history::tail(&self.dir.schedule_history(slug, id), min)
    }

    // ---- jobs ----

    pub fn list_jobs(&self, slug: &str) -> Vec<Obj> {
        self.jobs.lock().list(&self.dir.jobs_dir(slug)).iter().map(|v| (**v).clone()).collect()
    }
    /// Only the jobs still to run or running, oldest due first.
    pub fn open_jobs(&self, slug: &str) -> Vec<Obj> {
        self.jobs.lock().live_list(&self.dir.jobs_dir(slug)).iter().map(|v| (**v).clone()).collect()
    }
    pub fn get_job(&self, slug: &str, id: &str) -> Option<Obj> {
        Self::read(self.dir.job(slug, id), parse_job)
    }
    pub fn save_job(&self, slug: &str, j: &Obj) -> Result<(), String> {
        let id = s(j, "id").to_string();
        let file = self.dir.job(slug, &id).ok_or("bad job id")?;
        let dir = self.dir.jobs_dir(slug);
        let mut d = self.jobs.lock();
        let before = d.mtime(&dir);
        write(&file, &pretty(j))?;
        d.saved(&dir, &format!("{id}.json"), Some(j.clone()), before);
        Ok(())
    }

    // ---- automations ----

    pub fn list_loops(&self, slug: &str) -> Vec<Obj> {
        self.loops.lock().list(&self.dir.loops_dir(slug)).iter().map(|v| (**v).clone()).collect()
    }
    pub fn get_loop(&self, slug: &str, id: &str) -> Option<Obj> {
        Self::read(self.dir.loop_file(slug, id), parse_obj)
    }
    pub fn save_loop(&self, slug: &str, l: &Obj) -> Result<(), String> {
        let id = s(l, "id").to_string();
        let file = self.dir.loop_file(slug, &id).ok_or("bad automation id")?;
        let dir = self.dir.loops_dir(slug);
        let mut d = self.loops.lock();
        let before = d.mtime(&dir);
        write(&file, &pretty(l))?;
        d.saved(&dir, &format!("{id}.json"), Some(l.clone()), before);
        Ok(())
    }
    pub fn delete_loop(&self, slug: &str, id: &str) {
        let dir = self.dir.loops_dir(slug);
        let mut d = self.loops.lock();
        let before = d.mtime(&dir);
        if let Some(f) = self.dir.loop_file(slug, id) {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_file(self.dir.loop_state(slug, id));
        let _ = std::fs::remove_file(self.dir.loop_script(slug, id));
        d.saved(&dir, &format!("{id}.json"), None, before);
    }
    pub fn script_file(&self, slug: &str, id: &str) -> PathBuf {
        self.dir.loop_script(slug, id)
    }
    pub fn save_script(&self, slug: &str, id: &str, script: &str) -> Result<(), String> {
        write(&self.dir.loop_script(slug, id), script)
    }
    /// `readScript`: the script's text, or None when the file is gone (or not UTF-8, which Bun reads with
    /// replacement characters: then its hash differs and the automation shows "Script changed").
    pub fn read_script(&self, slug: &str, id: &str) -> Option<String> {
        std::fs::read(self.dir.loop_script(slug, id)).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    }
    /// `getLoopState`: the saved state over the empty one.
    pub fn loop_state(&self, slug: &str, id: &str) -> Obj {
        let mut st: Obj = match json!({ "seen": [], "primed": false, "failures": 0, "backoffUntil": null, "lastFound": 0, "lastItems": [] }) {
            Value::Object(m) => m,
            _ => unreachable!(),
        };
        if let Some(saved) = std::fs::read_to_string(self.dir.loop_state(slug, id)).ok().and_then(|t| parse_obj(&t)) {
            for (k, v) in saved {
                st.insert(k, v);
            }
        }
        st
    }
    pub fn save_loop_state(&self, slug: &str, id: &str, st: &Obj) -> Result<(), String> {
        let mut t = to_text(&Value::Object(st.clone()), Layout::Compact);
        t.push('\n');
        write(&self.dir.loop_state(slug, id), &t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missed_jobs_read_as_skipped() {
        let j = parse_job(r#"{"id":"a","state":"missed","result":{"x":1}}"#).unwrap();
        assert_eq!(Value::Object(j), json!({"id":"a","state":"skipped","result":{"x":1,"message":"was due while the computer was off"}}));
    }

    #[test]
    fn files_keep_bun_format() {
        let d = tempfile::tempdir().unwrap();
        let f = Files::new(d.path());
        let sch: Obj = serde_json::from_str(r#"{"id":"abc","name":"n","tags":[],"enabled":true}"#).unwrap();
        f.save_schedule("b", &sch).unwrap();
        let text = std::fs::read_to_string(d.path().join("profiles/b/schedules/abc.json")).unwrap();
        assert_eq!(text, "{\n  \"id\": \"abc\",\n  \"name\": \"n\",\n  \"tags\": [],\n  \"enabled\": true\n}\n");
        assert_eq!(f.list_schedules("b").len(), 1);
        f.append_history("b", "abc", &json!({"at": "x", "kind": "fired"}));
        assert_eq!(std::fs::read_to_string(d.path().join("profiles/b/schedules/abc.history.jsonl")).unwrap(), "{\"at\":\"x\",\"kind\":\"fired\"}\n");
        f.delete_schedule("b", "abc");
        assert!(f.list_schedules("b").is_empty());
        let st = f.loop_state("b", "l1");
        assert_eq!(st.get("primed"), Some(&Value::Bool(false)));
    }
}
