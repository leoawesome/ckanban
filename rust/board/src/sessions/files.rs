//! Where Claude keeps transcripts (`src/runs/session-files.ts`): `<config>/projects/<project>/<session>.jsonl`.
//! Blocking file reads: callers run them off the async runtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Claude's config folder: `CLAUDE_CONFIG_DIR` when set (even empty, as Bun's `??`), else `~/.claude`.
pub fn config_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(d) => PathBuf::from(d),
        None => ckanban_core::home::home_dir().join(".claude"),
    }
}

/// `<config>/projects`.
pub fn projects_dir(config: Option<&Path>) -> PathBuf {
    config.map(Path::to_path_buf).unwrap_or_else(config_dir).join("projects")
}

/// A folder's entry names (none when it can't be read).
fn names(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect()).unwrap_or_default()
}

/// The session's transcript in any project folder (one stat per project folder).
pub fn find_session_file(projects: &Path, session_id: &str) -> Option<PathBuf> {
    for dir in names(projects) {
        let f = projects.join(dir).join(format!("{session_id}.jsonl"));
        if std::fs::metadata(&f).is_ok_and(|m| m.is_file()) {
            return Some(f);
        }
    }
    None
}

/// Every session file under the projects folder by session id (one readdir per project folder, not a stat per id).
/// The first project folder listing an id wins, as in Bun (folders in readdir order).
pub fn scan_session_files(projects: &Path) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    for dir in names(projects) {
        for name in names(&projects.join(&dir)) {
            if let Some(id) = name.strip_suffix(".jsonl") {
                out.entry(id.to_string()).or_insert_with(|| projects.join(&dir).join(&name));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_transcripts() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("projects");
        std::fs::create_dir_all(p.join("-a")).unwrap();
        std::fs::create_dir_all(p.join("-b/s1")).unwrap();
        std::fs::write(p.join("-a/s1.jsonl"), "").unwrap();
        std::fs::write(p.join("-b/s2.jsonl"), "").unwrap();
        std::fs::write(p.join("-b/notes.txt"), "").unwrap();
        let all = scan_session_files(&p);
        assert_eq!(all.len(), 2);
        assert_eq!(all["s2"], p.join("-b/s2.jsonl"));
        assert_eq!(find_session_file(&p, "s1"), Some(p.join("-a/s1.jsonl")));
        assert_eq!(find_session_file(&p, "nope"), None);
        assert!(scan_session_files(&t.path().join("missing")).is_empty());
    }
}
