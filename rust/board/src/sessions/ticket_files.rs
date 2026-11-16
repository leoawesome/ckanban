//! What the session routes and the watcher need from the board's tickets, behind `TicketSource`, read straight from
//! the ticket files for now (`FileTickets`). The board's own ticket store (R1/R2a) replaces it: it keeps every board's
//! tickets in memory and knows when one changes. Until then a ticket file is parsed again only when its size or mtime
//! moved, and listing a board stats each of its ticket files (blocking: callers run it off the async runtime).

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Arc;

use ckanban_core::DataDir;
use parking_lot::Mutex;
use serde_json::Value;

use super::Obj;

pub trait TicketSource: Send + Sync {
    /// The boards (folders under `profiles/`).
    fn boards(&self) -> Vec<String>;
    /// The board's `profile.json`, None when there is no such board.
    fn profile(&self, slug: &str) -> Option<Value>;
    /// One ticket's fields (a corrupt file gives Bun's corrupt ticket), None when there is no such ticket.
    fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Obj>>;
    /// Every ticket of the board. Big boards have thousands: only for slow passes and rare requests.
    fn tickets(&self, slug: &str) -> Vec<Arc<Obj>>;
}

/// A parsed ticket file and the (size, mtime seconds, mtime nanoseconds) it had.
type Cached = ((u64, i64, i64), Arc<Obj>);

pub struct FileTickets {
    dir: DataDir,
    /// Parsed ticket files by path, with the (size, mtime) they had.
    cache: Mutex<HashMap<PathBuf, Cached>>,
}

impl FileTickets {
    pub fn new(dir: DataDir) -> Arc<Self> {
        Arc::new(FileTickets { dir, cache: Mutex::new(HashMap::new()) })
    }

    fn read(&self, slug: &str, id: &str) -> Option<Arc<Obj>> {
        let file = self.dir.ticket_dir(slug, id).join("ticket.md");
        let m = std::fs::metadata(&file).ok()?;
        let stamp = (m.size(), m.mtime(), m.mtime_nsec());
        if let Some((s, t)) = self.cache.lock().get(&file)
            && *s == stamp
        {
            return Some(t.clone());
        }
        let t = match ckanban_core::ticket::read(&file).ok()?? {
            Ok(t) => t,
            Err(e) => ckanban_core::ticket::Ticket::corrupt(id, &e, &ckanban_core::time::iso(ckanban_core::time::now_ms())),
        };
        let mut meta = t.meta;
        meta.insert("body".into(), Value::String(t.body));
        let t = Arc::new(meta);
        self.cache.lock().insert(file, (stamp, t.clone()));
        Some(t)
    }
}

impl TicketSource for FileTickets {
    fn boards(&self) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(self.dir.profiles_dir())
            .map(|d| d.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        out.sort();
        out
    }

    fn profile(&self, slug: &str) -> Option<Value> {
        if slug.is_empty() || slug.contains('/') || slug == "." || slug == ".." {
            return None;
        }
        let raw = std::fs::read(self.dir.profile_dir(slug).join("profile.json")).ok()?;
        serde_json::from_slice(&raw).ok()
    }

    fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Obj>> {
        if id.is_empty() || id.contains('/') || id == "." || id == ".." {
            return None;
        }
        self.read(slug, id)
    }

    fn tickets(&self, slug: &str) -> Vec<Arc<Obj>> {
        let names: Vec<String> = std::fs::read_dir(self.dir.tickets_dir(slug))
            .map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default();
        names.iter().filter_map(|id| self.read(slug, id)).collect()
    }
}

/// A ticket's earlier sessions (left behind with "Send in a fresh chat"): (sessionId, endedAt), oldest first.
pub fn earlier_sessions(t: &Obj) -> Vec<(String, Value)> {
    t.get("earlierSessions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| Some((s.get("sessionId")?.as_str()?.to_string(), s.get("endedAt").cloned().unwrap_or(Value::Null))))
                .collect()
        })
        .unwrap_or_default()
}

/// The ticket's current session id.
pub fn session_id(t: &Obj) -> Option<String> {
    t.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ticket_files() {
        let d = tempfile::tempdir().unwrap();
        let dir = DataDir::new(d.path());
        let tdir = dir.ticket_dir("b", "t_20260101_aaaa");
        std::fs::create_dir_all(&tdir).unwrap();
        std::fs::write(dir.profile_dir("b").join("profile.json"), r#"{"slug":"b","path":"/x"}"#).unwrap();
        std::fs::write(tdir.join("ticket.md"), "---\nid: t_20260101_aaaa\ntitle: Hi\nsessionId: s1\n---\nbody\n").unwrap();
        let src = FileTickets::new(dir);
        assert_eq!(src.boards(), vec!["b".to_string()]);
        assert_eq!(src.profile("b").unwrap()["path"], "/x");
        assert!(src.profile("nope").is_none());
        let t = src.ticket("b", "t_20260101_aaaa").unwrap();
        assert_eq!(session_id(&t).as_deref(), Some("s1"));
        assert_eq!(t["body"], "body\n");
        assert_eq!(src.tickets("b").len(), 1);
        assert!(src.ticket("b", "../b").is_none());
        assert!(earlier_sessions(&t).is_empty());
    }
}
