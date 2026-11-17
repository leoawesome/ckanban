//! The huddle files (`Store` in `src/core/store.ts`): `profiles/<slug>/huddles/<id>.json` (pretty JSON, a newline at
//! the end) kept parsed by mtime and size (`JsonDir`), and `<id>.messages.jsonl`, an append-only log read only as far
//! as it grew (`Tail`), with the last few logs kept in memory.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::DataDir;
use ckanban_core::datafile::{formats, parse_json, write_json};
use ckanban_core::json_dir::{JsonDir, Options, huddle_json};
use ckanban_core::jsonl::Tail;
use ckanban_core::layout::is_huddle_id;
use parking_lot::Mutex;
use serde_json::Value;

use super::model::{Obj, s};

/// Message logs kept parsed in memory (`HUDDLE_LOGS_MAX`).
const LOGS_MAX: usize = 20;

/// Hides saved keys in a JSON text (`maskSavedJson`).
pub type JsonMask = Arc<dyn Fn(&str) -> String + Send + Sync>;

pub struct HuddleFiles {
    dir: DataDir,
    files: Mutex<JsonDir<Obj>>,
    logs: Mutex<VecDeque<(String, Arc<Log>)>>,
    mask: parking_lot::RwLock<JsonMask>,
}

/// A parsed message log and the byte offset read up to.
struct Log {
    offset: u64,
    msgs: Arc<Vec<Value>>,
}

fn parse(text: &str) -> Option<Obj> {
    match parse_json(text)? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn by_created(a: &Obj, b: &Obj) -> std::cmp::Ordering {
    s(a, "createdAt").cmp(s(b, "createdAt"))
}

fn open(h: &Obj) -> bool {
    s(h, "status") != "closed"
}

impl HuddleFiles {
    pub fn new(root: &Path) -> Self {
        HuddleFiles {
            dir: DataDir::new(root.to_path_buf()),
            files: Mutex::new(JsonDir::new(Options { matches: huddle_json, parse, sort: by_created, live: Some(open), now: ckanban_core::time::now_ms })),
            logs: Mutex::new(VecDeque::new()),
            mask: parking_lot::RwLock::new(Arc::new(|t: &str| t.to_string())),
        }
    }

    pub fn set_mask(&self, m: JsonMask) {
        *self.mask.write() = m;
    }

    pub fn root(&self) -> &Path {
        &self.dir.root
    }

    pub fn huddles_dir(&self, slug: &str) -> PathBuf {
        self.dir.huddles_dir(slug)
    }

    /// `huddleIndex`: the board's huddles, oldest first (shared).
    pub fn index(&self, slug: &str) -> Arc<Vec<Arc<Obj>>> {
        self.files.lock().list(&self.huddles_dir(slug))
    }

    /// `openHuddles`: the ones not closed, oldest first.
    pub fn open(&self, slug: &str) -> Arc<Vec<Arc<Obj>>> {
        self.files.lock().live_list(&self.huddles_dir(slug))
    }

    /// `huddlesVersion`.
    pub fn version(&self, slug: &str) -> u64 {
        self.files.lock().version(&self.huddles_dir(slug))
    }

    /// Stats every board's huddle files again (edits made in place from outside).
    pub fn recheck(&self, slug: &str) {
        self.files.lock().recheck(&self.huddles_dir(slug));
    }

    fn file(&self, slug: &str, id: &str) -> Option<PathBuf> {
        self.dir.huddle(slug, id)
    }

    /// `getHuddle`: read from the file now.
    pub fn get(&self, slug: &str, id: &str) -> Option<Obj> {
        let f = self.file(slug, id)?;
        parse(&std::fs::read_to_string(f).ok()?)
    }

    /// `saveHuddle`.
    pub fn save(&self, slug: &str, h: &Obj) -> std::io::Result<()> {
        let id = s(h, "id");
        let Some(file) = self.file(slug, id) else { return Err(std::io::Error::other(format!("bad huddle id {id}"))) };
        let dir = self.huddles_dir(slug);
        let mut files = self.files.lock();
        let before = files.mtime(&dir);
        write_json(&file, &Value::Object(h.clone()), formats::HUDDLE)?;
        files.saved(&dir, &format!("{id}.json"), Some(h.clone()), before);
        Ok(())
    }

    /// `huddleStamp`: inode and mtime of the file, or None when it is gone.
    pub fn stamp(&self, slug: &str, id: &str) -> Option<String> {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(self.file(slug, id)?).ok()?;
        Some(format!("{}:{}", m.ino(), m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6))
    }

    /// `appendHuddleMessage`: one masked line.
    pub fn append(&self, slug: &str, id: &str, m: &Value) -> std::io::Result<()> {
        let dir = self.huddles_dir(slug);
        std::fs::create_dir_all(&dir)?;
        let text = ckanban_core::datafile::to_text(m, ckanban_core::datafile::Layout::Compact);
        let line = (self.mask.read().clone())(&text);
        let mut files = self.files.lock();
        let before = files.mtime(&dir);
        ckanban_core::jsonl::append_line(&self.dir.huddle_messages(slug, id), &line)?;
        files.touched(&dir, before);
        Ok(())
    }

    /// `readHuddleMessages`: the messages, oldest first (each with `mentions`).
    pub fn messages(&self, slug: &str, id: &str) -> Arc<Vec<Value>> {
        if !is_huddle_id(id) {
            return Arc::default();
        }
        let key = format!("{slug}/{id}");
        let file = self.dir.huddle_messages(slug, id);
        let size = std::fs::metadata(&file).map(|m| m.len()).ok();
        let mut logs = self.logs.lock();
        let had = logs.iter().position(|(k, _)| *k == key).and_then(|i| logs.remove(i)).map(|(_, t)| t);
        let Some(size) = size else { return Arc::default() };
        let (mut offset, mut msgs) = match had {
            Some(l) if size >= l.offset => (l.offset, l.msgs.clone()),
            _ => (0, Arc::default()),
        };
        if size > offset {
            // Only the lines added since: a new list only when some were.
            let mut tail = Tail { offset, entries: Vec::new() };
            if tail.read(&file).is_ok() {
                offset = tail.offset;
                if !tail.entries.is_empty() {
                    let mut all = (*msgs).clone();
                    for mut e in tail.entries {
                        if let Value::Object(m) = &mut e
                            && !m.contains_key("mentions")
                        {
                            m.insert("mentions".into(), Value::Array(vec![]));
                        }
                        all.push(e);
                    }
                    msgs = Arc::new(all);
                }
            }
        }
        logs.push_back((key, Arc::new(Log { offset, msgs: msgs.clone() })));
        while logs.len() > LOGS_MAX {
            logs.pop_front();
        }
        msgs
    }

    /// The host ticket's outputs folder (not made).
    pub fn outputs_path(&self, slug: &str, ticket: &str) -> PathBuf {
        self.dir.ticket_dir(slug, ticket).join("outputs")
    }
}
