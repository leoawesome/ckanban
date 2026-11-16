//! The Ask tab's chat list (`src/chat/quickchat-index.ts`): a board's quick chats newest first, kept between lists. A
//! chat file is parsed again only when its mtime or size changed, and the folder isn't walked at all while its own
//! mtime stays the same (saving a chat renames a new file into it, so any save or delete changes it). The board's own
//! saves update the index directly (`wrote`). Pages of 50 for "Load older".
//!
//! Blocking (stats and small file reads): callers run it off the async runtime. The lock is taken per file during a
//! walk, so a save never waits for a whole cold board of thousands of chats (Bun yields between files the same way).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use parking_lot::Mutex;
use serde_json::{Map, Value};

/// A chat as saved (`QuickChat`), shared.
pub type Chat = Arc<Map<String, Value>>;

/// Chats per page of the Ask tab's list.
pub const CHAT_PAGE: f64 = 50.0;

type StatKey = (u128, u64);

#[derive(Default)]
struct Board {
    dir_key: Option<StatKey>,
    files: HashMap<String, (StatKey, Chat)>,
    sorted: Option<Arc<Vec<Chat>>>,
}

fn stat_key(path: &Path) -> Option<StatKey> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    Some((mtime, m.len()))
}

fn field<'a>(c: &'a Map<String, Value>, k: &str) -> &'a str {
    c.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Newest first: last message, then created, then id (so two chats never tie and pages never overlap).
fn newer(a: (&str, &str, &str), b: (&str, &str, &str)) -> std::cmp::Ordering {
    b.0.cmp(a.0).then_with(|| b.1.cmp(a.1)).then_with(|| b.2.cmp(a.2))
}

fn place(c: &Map<String, Value>) -> (&str, &str, &str) {
    (field(c, "updatedAt"), field(c, "createdAt"), field(c, "id"))
}

/// `cursorOf`: where a page ends; the next one starts after it.
pub fn cursor_of(c: &Map<String, Value>) -> String {
    let (u, cr, id) = place(c);
    format!("{u}|{cr}|{id}")
}

fn sort(files: &HashMap<String, (StatKey, Chat)>) -> Arc<Vec<Chat>> {
    let mut v: Vec<Chat> = files.values().map(|(_, c)| c.clone()).collect();
    v.sort_by(|a, b| newer(place(a), place(b)));
    Arc::new(v)
}

pub type Parse = Box<dyn Fn(&str, &str) -> Option<Chat> + Send + Sync>;

pub struct ChatIndex {
    boards: Mutex<HashMap<String, Board>>,
    dir: Box<dyn Fn(&str) -> PathBuf + Send + Sync>,
    parse: Parse,
}

impl ChatIndex {
    /// dir: the board's chats folder; parse: one chat file's chat, or None when it can't be read.
    pub fn new(dir: impl Fn(&str) -> PathBuf + Send + Sync + 'static, parse: Parse) -> Self {
        ChatIndex { boards: Mutex::new(HashMap::new()), dir: Box::new(dir), parse }
    }

    /// Every chat, newest first, brought up to date now (shared: don't change it).
    pub fn all(&self, slug: &str) -> Arc<Vec<Chat>> {
        let dir = (self.dir)(slug);
        let dir_key = stat_key(&dir);
        {
            let mut g = self.boards.lock();
            let b = g.entry(slug.to_string()).or_default();
            let Some(key) = dir_key else {
                b.files.clear();
                b.dir_key = None;
                let empty = Arc::new(Vec::new());
                b.sorted = Some(empty.clone());
                return empty;
            };
            // The folder didn't change since the last walk (or only by the board's own saves, already in the index).
            if b.dir_key == Some(key) {
                return b.sorted.get_or_insert_with(|| sort(&b.files)).clone();
            }
        }
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        names.retain(|f| f.strip_suffix(".json").is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())));
        let mut present = HashSet::new();
        for f in names {
            let id = f[..f.len() - 5].to_string();
            let key = stat_key(&dir.join(&f));
            let mut g = self.boards.lock();
            let b = g.entry(slug.to_string()).or_default();
            present.insert(id.clone());
            if key.is_some() && b.files.get(&id).map(|e| e.0) == key {
                continue;
            }
            match key.and_then(|k| (self.parse)(slug, &id).map(|c| (k, c))) {
                Some(e) => {
                    b.files.insert(id, e);
                }
                None => {
                    b.files.remove(&id);
                }
            }
            b.sorted = None;
        }
        let mut g = self.boards.lock();
        let b = g.entry(slug.to_string()).or_default();
        let before = b.files.len();
        b.files.retain(|id, _| present.contains(id));
        if b.files.len() != before {
            b.sorted = None;
        }
        // The folder's key from before the walk: a save during it changes the folder again, so the next list looks.
        b.dir_key = dir_key;
        b.sorted.get_or_insert_with(|| sort(&b.files)).clone()
    }

    /// A page of chats newest first: the first `limit`, or the `limit` after the chat `before` names (`cursor_of`).
    /// next: the cursor of the page's last chat, None when no older chat is left.
    pub fn page(sorted: &[Chat], limit: f64, before: Option<&str>) -> (Vec<Chat>, Option<String>) {
        let floor = limit.floor();
        let n = (if floor.is_nan() || floor == 0.0 { CHAT_PAGE } else { floor }).clamp(1.0, 200.0) as usize;
        let mut from = 0;
        if let Some(b) = before {
            let mut it = b.split('|');
            if let (Some(u), Some(c), Some(id)) = (it.next(), it.next(), it.next())
                && !u.is_empty()
                && !c.is_empty()
                && !id.is_empty()
            {
                // The first chat older than the cursor.
                from = sorted.partition_point(|x| newer(place(x), (u, c, id)) != std::cmp::Ordering::Greater);
            }
        }
        let chats: Vec<Chat> = sorted.iter().skip(from).take(n).cloned().collect();
        let next = if from + n < sorted.len() && !chats.is_empty() { chats.last().map(|c| cursor_of(c)) } else { None };
        (chats, next)
    }

    /// After the board saved or deleted a chat itself (chat None): the index takes it without walking the folder
    /// again. `write` does the change; the folder's key before and after tell whether anything else changed in it.
    pub fn wrote<T>(&self, slug: &str, id: &str, write: impl FnOnce() -> T, chat: Option<Chat>) -> T {
        let dir = (self.dir)(slug);
        let mut g = self.boards.lock();
        let Some(b) = g.get_mut(slug) else {
            drop(g);
            return write();
        };
        let before = stat_key(&dir);
        let out = write();
        let key = chat.as_ref().and_then(|_| stat_key(&dir.join(format!("{id}.json"))));
        match (chat, key) {
            (Some(c), Some(k)) => {
                b.files.insert(id.to_string(), (k, c));
            }
            _ => {
                b.files.remove(id);
            }
        }
        b.sorted = None;
        b.dir_key = if before.is_some() && before == b.dir_key { stat_key(&dir) } else { None };
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chat(id: &str, created: &str, updated: &str) -> Chat {
        Arc::new(json!({"id": id, "createdAt": created, "updatedAt": updated}).as_object().unwrap().clone())
    }

    fn write(dir: &Path, c: &Chat) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{}.json", field(c, "id"))), serde_json::to_string(&**c).unwrap()).unwrap();
    }

    fn index(root: &Path) -> (Arc<std::sync::atomic::AtomicUsize>, ChatIndex) {
        let parses = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let p = parses.clone();
        let r = root.to_path_buf();
        let r2 = root.to_path_buf();
        let idx = ChatIndex::new(
            move |slug| r.join(slug),
            Box::new(move |slug, id| {
                p.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let t = std::fs::read_to_string(r2.join(slug).join(format!("{id}.json"))).ok()?;
                serde_json::from_str::<Map<String, Value>>(&t).ok().map(Arc::new)
            }),
        );
        (parses, idx)
    }

    fn ids(v: &[Chat]) -> Vec<&str> {
        v.iter().map(|c| field(c, "id")).collect()
    }

    #[test]
    fn newest_first_parsed_once_and_paged() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("b");
        write(&dir, &chat("a1", "2026-01-01T00:00:00.000Z", "2026-01-03T00:00:00.000Z"));
        write(&dir, &chat("b2", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z"));
        write(&dir, &chat("c3", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"));
        std::fs::write(dir.join("x.activity.jsonl"), "").unwrap();
        std::fs::write(dir.join("Bad.json"), "{}").unwrap();
        let (parses, idx) = index(d.path());
        let all = idx.all("b");
        assert_eq!(ids(&all), ["a1", "b2", "c3"]);
        assert_eq!(parses.load(std::sync::atomic::Ordering::SeqCst), 3);
        idx.all("b");
        assert_eq!(parses.load(std::sync::atomic::Ordering::SeqCst), 3);
        let (p1, next) = ChatIndex::page(&all, 2.0, None);
        assert_eq!(ids(&p1), ["a1", "b2"]);
        let (p2, next2) = ChatIndex::page(&all, 2.0, next.as_deref());
        assert_eq!(ids(&p2), ["c3"]);
        assert_eq!(next2, None);
        assert_eq!(ChatIndex::page(&all, f64::NAN, None).0.len(), 3);
        assert!(idx.all("none").is_empty());
    }

    #[test]
    fn own_saves_and_deletes_need_no_walk() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("b");
        write(&dir, &chat("a1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"));
        let (parses, idx) = index(d.path());
        idx.all("b");
        let n = chat("z9", "2026-01-05T00:00:00.000Z", "2026-01-05T00:00:00.000Z");
        idx.wrote("b", "z9", || write(&dir, &n), Some(n.clone()));
        assert_eq!(ids(&idx.all("b")), ["z9", "a1"]);
        idx.wrote("b", "a1", || std::fs::remove_file(dir.join("a1.json")).unwrap(), None);
        assert_eq!(ids(&idx.all("b")), ["z9"]);
        assert_eq!(parses.load(std::sync::atomic::Ordering::SeqCst), 1);
        // A file written by someone else is found by the next walk.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&dir, &chat("m5", "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z"));
        assert_eq!(ids(&idx.all("b")), ["z9", "m5"]);
    }
}
