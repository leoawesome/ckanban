//! The switch for background deletes (plan 5.3). The background jobs that delete (the worktree sweep, cleaning up a
//! Done ticket's copy and a deleted ticket's copy, trimming packages from kept Done copies, run log compression, temp
//! files, rewind copies, huddle helper copies...) really delete by default since the dry-run log was checked
//! (2026-11-18, ticket t_20261118_awxv). `CKANBAN_RUST_DELETE=0` keeps the old report-only mode: each job then appends
//! what it would delete to `<data>/rust-board-dryrun.log` and deletes nothing. The copy of a ticket the user deletes
//! goes through this switch too; other deletes the user asks for (a schedule, a board) don't.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

pub const LOG_FILE: &str = "rust-board-dryrun.log";
pub const ENV: &str = "CKANBAN_RUST_DELETE";

/// Background deletes really delete unless `CKANBAN_RUST_DELETE=0` (then they are only reported).
pub fn deletes_on() -> bool {
    std::env::var(ENV).map_or(true, |v| v.trim() != "0")
}

pub fn log_path(root: &Path) -> PathBuf {
    root.join(LOG_FILE)
}

/// Appends one decision: `{"at", "job", ...fields}` as a JSON line. Paths and ids only, never file contents. A
/// failed write is only printed: reporting must never stop the job.
pub fn report(root: &Path, job: &str, fields: Map<String, Value>) {
    let mut m = Map::new();
    m.insert("at".into(), Value::String(ckanban_core::time::iso(ckanban_core::time::now_ms())));
    m.insert("job".into(), Value::String(job.into()));
    m.extend(fields);
    if let Err(e) = ckanban_core::jsonl::append(&log_path(root), &Value::Object(m)) {
        eprintln!("[board] can't write {}: {e}", log_path(root).display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_json_lines() {
        let d = tempfile::tempdir().unwrap();
        let mut f = Map::new();
        f.insert("path".into(), Value::from("/x"));
        report(d.path(), "worktree-sweep", f.clone());
        report(d.path(), "worktree-sweep", f);
        let lines = ckanban_core::jsonl::read_all(&log_path(d.path())).unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["job"], "worktree-sweep");
        assert_eq!(lines[0]["path"], "/x");
        assert_eq!(lines[0].as_object().unwrap().keys().collect::<Vec<_>>(), ["at", "job", "path"]);
    }
}
