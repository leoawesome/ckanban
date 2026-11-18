//! Free space for the low-disk banner (`GET /api/disk`, event `disk.space`). One `statvfs` of the data folder: on a
//! Mac the ticket copies (`<project>/../.ckanban-worktrees`) and the data folder sit on the same APFS container, whose
//! free space every volume shares. The reading is kept for a minute; a minute timer reads it again and tells the page
//! only when the shown number (tenths of a GB) moves, and Free up space reads it again as it finishes.
//! `CKANBAN_FAKE_FREE_GB` (tests and screenshots) replaces the reading.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{json, Value};

/// The banner shows under this much free space (decimal GB, as Finder counts).
pub const LOW_BYTES: u64 = 10_000_000_000;
/// How long a reading is kept.
pub const KEEP: Duration = Duration::from_secs(60);
pub const FAKE_ENV: &str = "CKANBAN_FAKE_FREE_GB";

pub struct DiskSpace {
    root: PathBuf,
    last: Mutex<Option<(Instant, Option<u64>)>>,
    /// The tenths of a GB last sent to the page, so the minute timer only sends a change.
    sent: Mutex<Option<u64>>,
}

impl DiskSpace {
    pub fn new(root: &Path) -> Self {
        Self { root: root.to_path_buf(), last: Mutex::new(None), sent: Mutex::new(None) }
    }

    /// `{freeBytes, low, lowBelowBytes, checkedAt}`; `freeBytes` null when the disk can't be read (then not low).
    pub fn status(&self) -> Value {
        let cached = *self.last.lock();
        let free = match cached {
            Some((at, v)) if at.elapsed() < KEEP => v,
            _ => self.read_now(),
        };
        shape(free)
    }

    /// Reads again now, and returns the status when the shown number moved since the last one sent.
    pub fn refresh_changed(&self) -> Option<Value> {
        let free = self.read_now();
        let tenths = free.map(|b| b / 100_000_000);
        let mut sent = self.sent.lock();
        if *sent == tenths && sent.is_some() {
            return None;
        }
        *sent = tenths;
        Some(shape(free))
    }

    fn read_now(&self) -> Option<u64> {
        let v = fake().or_else(|| free_bytes(&self.root));
        *self.last.lock() = Some((Instant::now(), v));
        v
    }
}

fn shape(free: Option<u64>) -> Value {
    json!({
        "freeBytes": free,
        "low": free.is_some_and(|b| b < LOW_BYTES),
        "lowBelowBytes": LOW_BYTES,
        "checkedAt": ckanban_core::time::iso(ckanban_core::time::now_ms()),
    })
}

fn fake() -> Option<u64> {
    let gb: f64 = std::env::var(FAKE_ENV).ok()?.trim().parse().ok()?;
    (gb.is_finite() && gb >= 0.0).then(|| (gb * 1e9) as u64)
}

/// Bytes a normal user may still write on the disk holding `path` (`f_bavail`, as `df` and Finder show).
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` a properly sized out-parameter.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_real_disk() {
        let b = free_bytes(Path::new("/")).expect("statvfs of /");
        assert!(b > 0);
        assert!(free_bytes(Path::new("/no/such/folder/here")).is_none());
    }

    #[test]
    fn shape_marks_low_under_ten_gb() {
        assert_eq!(shape(Some(6_200_000_000))["low"], true);
        assert_eq!(shape(Some(LOW_BYTES))["low"], false);
        assert_eq!(shape(None)["low"], false);
        assert_eq!(shape(None)["freeBytes"], Value::Null);
    }

    #[test]
    fn sends_only_when_the_tenths_move() {
        let d = DiskSpace::new(Path::new("/"));
        // The first reading is always sent; a second one a moment later normally lands in the same tenth of a GB.
        assert!(d.refresh_changed().is_some());
        *d.sent.lock() = Some(u64::MAX);
        assert!(d.refresh_changed().is_some());
        let st = d.status();
        assert!(st["freeBytes"].as_u64().is_some());
        // Kept for a minute: status doesn't read again.
        let first = d.last.lock().unwrap().0;
        d.status();
        assert_eq!(d.last.lock().unwrap().0, first);
    }
}
