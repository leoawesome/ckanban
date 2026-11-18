//! A temp folder of its own for each Claude process the board starts for a ticket (runs, chat replies, huddle
//! helpers): `<system temp>/ckanban-runs/<board>-<ticket>-<random>`, passed to Claude as `TMPDIR`, and removed when the
//! process ends (done, failed or stopped). Scratch clones, trial builds and test daemons a run puts there no longer
//! pile up in the temp folder.
//!
//! Only folders under `root()` are ever removed. At start the board removes the ones a stopped daemon left behind,
//! and every hour any older than `MAX_AGE_MS` (a run cut off without its clean-up); a folder of a process still
//! running is never touched. With background deletes off (`dryrun.rs`) nothing is removed, only printed.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use parking_lot::Mutex;

/// Leftovers older than this go in the hourly pass.
pub const MAX_AGE_MS: f64 = 86_400_000.0;
/// Where the folders go instead of the system temp folder (tests).
pub const ROOT_ENV: &str = "CKANBAN_RUN_TEMP_ROOT";

/// Folders of processes still running: never removed by a sweep.
static LIVE: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

pub fn root() -> PathBuf {
    std::env::var_os(ROOT_ENV).filter(|r| !r.is_empty()).map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("ckanban-runs"))
}

/// `slug/id` (the run's `CKANBAN_TICKET`) as a folder name part: letters, digits, `_` and `-` only.
fn label(ticket: &str) -> String {
    let l: String = ticket.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).take(80).collect();
    if l.is_empty() { "run".into() } else { l }
}

/// One process's temp folder; removed when dropped (or by `finish`).
pub struct RunTemp {
    dir: PathBuf,
}

impl RunTemp {
    /// Makes the folder. None when it can't be made (the run then keeps the usual temp folder).
    pub fn make(ticket: &str) -> Option<RunTemp> {
        Self::make_in(&root(), ticket)
    }

    fn make_in(root: &Path, ticket: &str) -> Option<RunTemp> {
        let rand = crate::git::landing::random_uuid();
        let dir = root.join(format!("{}-{}", label(ticket), &rand[..8]));
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!("[runs] can't make the run's temp folder {}: {e}", dir.display());
            return None;
        }
        // Resolved, so the path Claude sees is the one the sweep compares (macOS: /var is /private/var).
        let dir = fs::canonicalize(&dir).unwrap_or(dir);
        LIVE.lock().insert(dir.clone());
        Some(RunTemp { dir })
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// Removes the folder now, on the blocking pool, and waits for it.
    pub async fn finish(self) {
        let dir = self.dir.clone();
        std::mem::forget(self);
        let _ = tokio::task::spawn_blocking(move || release(&dir)).await;
    }
}

impl Drop for RunTemp {
    /// A run whose task was cut off: the folder still goes, off the runtime when there is one.
    fn drop(&mut self) {
        let dir = std::mem::take(&mut self.dir);
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn_blocking(move || release(&dir));
            }
            Err(_) => release(&dir),
        }
    }
}

fn release(dir: &Path) {
    LIVE.lock().remove(dir);
    if !crate::dryrun::deletes_on() {
        eprintln!("[runs] would remove the run's temp folder {} (deletes are off)", dir.display());
        return;
    }
    if let Err(e) = fs::remove_dir_all(dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        // Read-only files (a Go module cache, for one) can stop a plain removal: make them writable and try again.
        let _ = std::process::Command::new("chmod").args(["-R", "u+w"]).arg(dir).output();
        if let Err(e) = fs::remove_dir_all(dir) {
            eprintln!("[runs] couldn't remove the run's temp folder {}: {e}", dir.display());
        }
    }
}

/// Removes leftover folders under `root()`: all of them (`max_age_ms` None, at start) or those not changed for that
/// long; a running process's folder never. Blocking. The number removed (or that would be, with deletes off).
pub fn sweep(max_age_ms: Option<f64>) -> usize {
    sweep_in(&root(), max_age_ms, crate::dryrun::deletes_on())
}

fn sweep_in(root: &Path, max_age_ms: Option<f64>, deleting: bool) -> usize {
    let Ok(rd) = fs::read_dir(root) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut n = 0;
    for e in rd.flatten() {
        let p = e.path();
        let real = fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        if LIVE.lock().contains(&real) || !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if let Some(max) = max_age_ms {
            let age = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|m| now.duration_since(m).ok()).map(|d| d.as_millis() as f64);
            if age.is_none_or(|a| a < max) {
                continue;
            }
        }
        n += 1;
        if !deleting {
            eprintln!("[runs] would remove the old run temp folder {} (deletes are off)", p.display());
            continue;
        }
        let _ = fs::remove_dir_all(&p);
    }
    if n > 0 && deleting {
        eprintln!("[runs] removed {n} old run temp folder{}", if n == 1 { "" } else { "s" });
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_plain_folder_names() {
        assert_eq!(label("kanban/t_20261118_z697"), "kanban-t_20261118_z697");
        assert_eq!(label("../.."), "-----");
        assert_eq!(label(""), "run");
    }

    #[tokio::test]
    async fn a_folder_goes_when_its_run_ends_and_the_sweep_spares_live_ones() {
        let t = tempfile::tempdir().unwrap();
        let a = RunTemp::make_in(t.path(), "p/t1").unwrap();
        let b = RunTemp::make_in(t.path(), "p/t2").unwrap();
        let (pa, pb) = (a.path().to_path_buf(), b.path().to_path_buf());
        assert!(pa.starts_with(fs::canonicalize(t.path()).unwrap()) && pa.is_dir());
        fs::write(pa.join("scratch.txt"), "x").unwrap();
        // A leftover of a stopped daemon, outside the live set.
        let old = t.path().join("p-t0-deadbeef");
        fs::create_dir_all(old.join("clone")).unwrap();
        // The hourly pass leaves a fresh leftover; the start-up pass takes it but never a live folder.
        assert_eq!(sweep_in(t.path(), Some(MAX_AGE_MS), true), 0);
        assert_eq!(sweep_in(t.path(), None, false), 1);
        assert!(old.exists());
        assert_eq!(sweep_in(t.path(), None, true), 1);
        assert!(!old.exists() && pa.exists() && pb.exists());
        a.finish().await;
        assert!(!pa.exists());
        // Dropped (a run cut off): removed in the background.
        drop(b);
        for _ in 0..100 {
            if !pb.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(!pb.exists());
    }
}
