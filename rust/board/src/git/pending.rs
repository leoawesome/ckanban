//! Requests to turn version history on for a folder once the tickets editing it in place have finished (the card's
//! "Turn on version history" link while they still run). Saved in `<data>/version-history-pending.json`, keyed by the
//! folder's path: `{ "<path>": { "at": iso, "tickets": [{ "board", "id" }] } }`, so a request survives a restart.
//! `tickets`: who was editing the folder when it was asked (the newest one gets the comment if turning it on fails).
//!
//! The file holds one small entry per folder with a request (a handful at most), so it is read once per data folder
//! and kept in memory; every change is written straight back.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

const FILE: &str = "version-history-pending.json";

/// Per data folder (tests use several): the requests by folder path.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, BTreeMap<String, Value>>>> = LazyLock::new(Default::default);

fn with<R>(root: &Path, f: impl FnOnce(&mut BTreeMap<String, Value>) -> R) -> R {
    let mut all = CACHE.lock();
    let map = all.entry(root.to_path_buf()).or_insert_with(|| load(root));
    f(map)
}

fn load(root: &Path) -> BTreeMap<String, Value> {
    let Ok(text) = std::fs::read_to_string(root.join(FILE)) else { return BTreeMap::new() };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => m.into_iter().filter(|(_, v)| v.is_object()).collect(),
        _ => BTreeMap::new(),
    }
}

fn save(root: &Path, map: &BTreeMap<String, Value>) {
    let file = root.join(FILE);
    let r = if map.is_empty() {
        match std::fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    } else {
        let v = Value::Object(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Map<String, Value>>());
        ckanban_core::atomic::atomic_write(&file, format!("{}\n", serde_json::to_string_pretty(&v).unwrap_or_default()))
    };
    if let Err(e) = r {
        eprintln!("[board] can't save {}: {e}", file.display());
    }
}

/// A request is waiting for this folder.
pub fn is_pending(root: &Path, path: &str) -> bool {
    !path.is_empty() && with(root, |m| m.contains_key(path))
}

/// The request for this folder, if any.
pub fn get(root: &Path, path: &str) -> Option<Value> {
    with(root, |m| m.get(path).cloned())
}

/// Records (or renews) the request; `tickets` are (board, ticket id) of the runs editing the folder now.
pub fn set(root: &Path, path: &str, at: &str, tickets: &[(String, String)]) {
    let list: Vec<Value> = tickets.iter().map(|(b, id)| json!({ "board": b, "id": id })).collect();
    with(root, |m| {
        m.insert(path.to_string(), json!({ "at": at, "tickets": list }));
        save(root, m);
    });
}

/// Drops the request; true when there was one.
pub fn clear(root: &Path, path: &str) -> bool {
    with(root, |m| {
        let had = m.remove(path).is_some();
        if had {
            save(root, m);
        }
        had
    })
}

/// Every folder with a request (for the check after a restart).
pub fn folders(root: &Path) -> Vec<String> {
    with(root, |m| m.keys().cloned().collect())
}

/// The (board, ticket id) pairs a request names.
pub fn tickets_of(req: &Value) -> Vec<(String, String)> {
    req.get("tickets")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| Some((t.get("board")?.as_str()?.to_string(), t.get("id")?.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_is_saved_read_back_after_a_restart_and_cleared() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        assert!(!is_pending(root, "/p"));
        set(root, "/p", "2026-11-22T00:00:00.000Z", &[("b".into(), "t1".into())]);
        assert!(is_pending(root, "/p"));
        // A new daemon reads the file again.
        CACHE.lock().remove(root);
        assert!(is_pending(root, "/p"));
        assert_eq!(tickets_of(&get(root, "/p").unwrap()), vec![("b".to_string(), "t1".to_string())]);
        assert_eq!(folders(root), vec!["/p".to_string()]);
        assert!(clear(root, "/p"));
        assert!(!clear(root, "/p"));
        assert!(!root.join(FILE).exists());
    }
}
