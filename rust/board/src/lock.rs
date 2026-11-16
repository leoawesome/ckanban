//! `<data>/board.lock` (plan 3.1): one owner of a data folder's board. Board mode (here) and Bun's full mode
//! (`src/core/board-lock.ts`) both hold an exclusive `flock` on it while they own the board and refuse to start the
//! board without it, so two daemons can't write tickets in one data folder. The file stays empty; the lock goes with
//! the process (close on exec: board runs and Chromes started by the owner don't keep it).

use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const LOCK_FILE: &str = "board.lock";

/// Held while alive; dropping it lets go.
#[derive(Debug)]
pub struct BoardLock {
    _file: File,
    pub path: PathBuf,
}

/// Takes the lock, trying again for up to `wait` (an owner that is stopping lets go in a moment). Err names why.
pub fn take(root: &Path, wait: Duration) -> Result<BoardLock, String> {
    let path = root.join(LOCK_FILE);
    std::fs::create_dir_all(root).map_err(|e| format!("can't create {}: {e}", root.display()))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("can't open {}: {e}", path.display()))?;
    let end = Instant::now() + wait;
    loop {
        // SAFETY: flock(2) on a file descriptor this function owns.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(BoardLock { _file: file, path });
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EWOULDBLOCK) {
            return Err(format!("can't lock {}: {err}", path.display()));
        }
        if Instant::now() >= end {
            return Err(format!("another ckanban daemon owns this data folder ({} is locked)", path.display()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_owner_at_a_time_and_dropping_lets_go() {
        let d = tempfile::tempdir().unwrap();
        let a = take(d.path(), Duration::ZERO).unwrap();
        let e = take(d.path(), Duration::from_millis(250)).unwrap_err();
        assert!(e.contains("another ckanban daemon owns this data folder"), "{e}");
        drop(a);
        let _b = take(d.path(), Duration::ZERO).unwrap();
        assert_eq!(std::fs::read(d.path().join(LOCK_FILE)).unwrap(), b"");
    }

    #[test]
    fn a_child_process_doesnt_keep_the_lock() {
        let d = tempfile::tempdir().unwrap();
        let a = take(d.path(), Duration::ZERO).unwrap();
        let mut child = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        drop(a);
        // A moment's wait: a process forked by another test thread holds every descriptor until its exec.
        let got = take(d.path(), Duration::from_secs(2));
        let _ = child.kill();
        let _ = child.wait();
        got.unwrap();
    }
}
