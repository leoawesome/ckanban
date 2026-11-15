//! `atomicWrite` from `src/core/atomic.ts`: write `<file>.tmp-<8 base36 chars>`, then rename it over the file, so a
//! reader (Bun or Rust) never sees half a file. A failed write or rename removes its temp file.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const B36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// 8 random base36 characters, like `newId()` (no crypto needed: it only has to differ between writers).
pub fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let mut x = nanos ^ (u64::from(std::process::id()) << 32) ^ COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut out = String::with_capacity(8);
    for _ in 0..8 {
        // splitmix64 step
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        out.push(B36[(z % 36) as usize] as char);
    }
    out
}

pub fn atomic_write(file: &Path, content: impl AsRef<[u8]>) -> io::Result<()> {
    if let Some(dir) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", new_id()));
    let tmp = std::path::PathBuf::from(tmp);
    let r = fs::write(&tmp, content).and_then(|()| fs::rename(&tmp, file));
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_whole_file_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("ckrs-atomic-{}", new_id()));
        let f = dir.join("a").join("x.json");
        atomic_write(&f, "one").unwrap();
        atomic_write(&f, "two").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "two");
        assert_eq!(fs::read_dir(f.parent().unwrap()).unwrap().count(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_are_base36_and_differ() {
        let a = new_id();
        assert_eq!(a.len(), 8);
        assert!(a.bytes().all(|b| B36.contains(&b)));
        assert_ne!(a, new_id());
    }
}
