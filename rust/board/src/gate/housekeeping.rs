//! Start-up clean-ups of `src/core/housekeeping.ts`: temp files a crash left behind (`sweepTempFiles`) and the
//! daemon's own log (`trimDaemonLog`). They delete unless `CKANBAN_RUST_DELETE=0` (plan 5.3, `dryrun.rs`): then what
//! they would remove or trim goes to `<data>/rust-board-dryrun.log` and nothing is touched. Both run off
//! the runtime (`spawn_blocking`); the satellite skips its own copies.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use ckanban_core::time::{iso, now_ms};

use crate::runs::run_log_compress::DRY_RUN_LOG;

/// The data folder's own folders the sweep goes into (`DATA_DIRS`); others hold many files that aren't the board's.
const DATA_DIRS: [&str; 3] = ["profiles", "learned", "huddle-notes"];
/// Folders that hold copies of a project (`SKIP`).
const SKIP: [&str; 3] = ["node_modules", ".git", ".ckanban-worktrees"];

/// Whether the background deleters really delete (on unless `CKANBAN_RUST_DELETE=0`; `dryrun::deletes_on`).
pub fn deletes_on() -> bool {
    crate::dryrun::deletes_on()
}

/// One line in `<data>/rust-board-dryrun.log`.
pub fn report(root: &Path, what: &str) {
    let line = format!("{} housekeeping: {what}\n", iso(now_ms()));
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(root.join(DRY_RUN_LOG)) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// `TMP`: atomicWrite's temp files, `<file>.tmp-<8 lowercase letters or digits>`.
fn is_temp(name: &str) -> bool {
    let Some(i) = name.rfind(".tmp-") else { return false };
    let tail = &name[i + 5..];
    tail.len() == 8 && tail.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `sweepTempFiles`: temp files of atomic writes older than `max_age_ms` under the data folder, found as Bun finds
/// them (its folders only, outputs folders looked at but not gone into, at most `max_depth` deep). Removes them when
/// `delete`, else reports each. Returns how many it removed or would remove.
pub fn sweep_temp_files(root: &Path, max_age_ms: f64, now: f64, max_depth: usize, delete: bool) -> usize {
    let mut found = 0;
    walk(root, root, 0, true, max_age_ms, now, max_depth, delete, &mut found);
    found
}

#[allow(clippy::too_many_arguments)]
fn walk(root: &Path, dir: &Path, depth: usize, descend: bool, max_age: f64, now: f64, max_depth: usize, delete: bool, found: &mut usize) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let Ok(kind) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if kind.is_dir() {
            let ours = if depth == 0 { DATA_DIRS.contains(&name.as_str()) } else { !SKIP.contains(&name.as_str()) };
            if descend && ours && depth < max_depth {
                walk(root, &path, depth + 1, name != "outputs", max_age, now, max_depth, delete, found);
            }
        } else if kind.is_file() && is_temp(&name) {
            let Ok(m) = fs::metadata(&path).and_then(|m| m.modified()) else { continue };
            let mtime = m.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
            if now - mtime < max_age {
                continue;
            }
            if delete {
                if fs::remove_file(&path).is_ok() {
                    *found += 1;
                }
            } else {
                report(root, &format!("would remove temp file {}", path.display()));
                *found += 1;
            }
        }
    }
}

/// `trimDaemonLog`: when the log is over `max_bytes`, its lines move to `<file>.1` (older ones up to `keep`) and the
/// log starts empty. Report-only unless `delete`. True when it trimmed or would have.
pub fn trim_daemon_log(root: &Path, file: &Path, max_bytes: u64, keep: usize, delete: bool) -> bool {
    let keep = keep.max(1);
    let Ok(size) = fs::metadata(file).map(|m| m.len()) else { return false };
    if size <= max_bytes {
        return false;
    }
    if !delete {
        report(root, &format!("would trim {} ({size} bytes) into {}.1, dropping {}.{keep}", file.display(), file.display(), file.display()));
        return true;
    }
    let name = |i: usize| format!("{}.{i}", file.display());
    let _ = fs::remove_file(name(keep));
    for i in (1..keep).rev() {
        let _ = fs::rename(name(i), name(i + 1));
    }
    if fs::copy(file, name(1)).is_err() {
        return false;
    }
    OpenOptions::new().write(true).open(file).and_then(|f| f.set_len(0)).is_ok()
}

/// Both clean-ups as the daemon runs them at start (Bun's defaults: a day, 6 folders deep; 5 MB, 2 old logs).
pub async fn at_start(root: &Path) {
    let root = root.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || {
        let delete = deletes_on();
        trim_daemon_log(&root, &root.join("daemon.log"), 5 * 1024 * 1024, 2, delete);
        sweep_temp_files(&root, 86_400_000.0, now_ms(), 6, delete);
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("ck-hk-{}-{}-{n}", std::process::id(), now_ms() as u64));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn temp_names() {
        assert!(is_temp("ticket.md.tmp-ab12cd34"));
        assert!(!is_temp("ticket.md.tmp-AB12CD34"));
        assert!(!is_temp("ticket.md.tmp-ab12cd3"));
        assert!(!is_temp("ticket.md"));
    }

    #[test]
    fn sweep_reports_and_deletes_only_when_asked() {
        let root = temp();
        let t = root.join("profiles/b/tickets/t1");
        fs::create_dir_all(&t).unwrap();
        fs::create_dir_all(root.join("profiles/b/tickets/t1/outputs/deep")).unwrap();
        fs::create_dir_all(root.join("browsers")).unwrap();
        fs::write(t.join("ticket.md.tmp-aaaaaaaa"), "x").unwrap();
        fs::write(root.join("profiles/b/tickets/t1/outputs/deep/x.tmp-bbbbbbbb"), "x").unwrap();
        fs::write(root.join("browsers/y.tmp-cccccccc"), "x").unwrap();
        let later = now_ms() + 2.0 * 86_400_000.0;
        assert_eq!(sweep_temp_files(&root, 86_400_000.0, later, 6, false), 1);
        assert!(t.join("ticket.md.tmp-aaaaaaaa").exists());
        let log = fs::read_to_string(root.join(DRY_RUN_LOG)).unwrap();
        assert!(log.contains("would remove temp file") && log.contains("ticket.md.tmp-aaaaaaaa"));
        // Too young: kept, not reported.
        assert_eq!(sweep_temp_files(&root, 86_400_000.0, now_ms(), 6, false), 0);
        assert_eq!(sweep_temp_files(&root, 86_400_000.0, later, 6, true), 1);
        assert!(!t.join("ticket.md.tmp-aaaaaaaa").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn trim_reports_then_trims() {
        let root = temp();
        let log = root.join("daemon.log");
        fs::write(&log, "0123456789").unwrap();
        assert!(!trim_daemon_log(&root, &log, 100, 2, false));
        assert!(trim_daemon_log(&root, &log, 5, 2, false));
        assert_eq!(fs::read_to_string(&log).unwrap(), "0123456789");
        assert!(trim_daemon_log(&root, &log, 5, 2, true));
        assert_eq!(fs::read_to_string(&log).unwrap(), "");
        assert_eq!(fs::read_to_string(root.join("daemon.log.1")).unwrap(), "0123456789");
        let _ = fs::remove_dir_all(&root);
    }
}
