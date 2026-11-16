//! A ticket's run log (`activity.jsonl`) as readers see it (`src/runs/run-log.ts`): the plain file, or, for a ticket
//! Done long ago, its compressed copy (`activity.jsonl.gz`). Readers get the same bytes either way, with the same byte
//! offsets.
//!
//! Rules every reader and writer keeps (Bun's):
//! - The plain file, when it exists, is the log. A compressed copy next to it is a leftover of a step cut short.
//! - A compressed copy alone is the log. Before anything is appended, it is restored to the plain file.
//!
//! Everything here is blocking file work (decompressing a big log takes a while): the `async` functions run it with
//! `spawn_blocking`. Bun's event loop made each step atomic against appends; here every step that changes which file
//! is the log, and every append (`append_line`), holds the log's lock (`lock`), so no line can fall between them.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use ckanban_core::atomic::new_id;
use ckanban_core::jsonl::ReadAt;
use ckanban_core::time::{now_ms, system_ms};
use parking_lot::{Mutex, ReentrantMutex};

pub fn gz_of(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".gz");
    PathBuf::from(s)
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Decompressed logs kept in memory, newest use last; past the cap the oldest go (one bigger log stays on its own).
const MAX_BYTES: usize = 256 * 1024 * 1024;
/// A decompressed log not read for this long is let go.
const IDLE_MS: f64 = 5.0 * 60_000.0;
/// Uncompressed sizes read from compressed copies' trailers, by path (bounded like a cache).
const MAX_SIZES: usize = 20_000;

struct Unzipped {
    key: String,
    buf: Arc<Vec<u8>>,
    used_at: f64,
    /// Order of last use (the smallest goes first).
    seq: u64,
}

#[derive(Default)]
struct Cache {
    unzipped: HashMap<PathBuf, Unzipped>,
    bytes: usize,
    seq: u64,
    sizes: HashMap<PathBuf, (String, u64, u64)>,
    size_order: BTreeMap<u64, PathBuf>,
    size_seq: u64,
    reaper: bool,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));

fn key_of(m: &fs::Metadata) -> String {
    format!("{}:{}", m.len(), m.modified().map(system_ms).unwrap_or(0.0))
}

fn remember(gz: &Path, key: String, buf: Arc<Vec<u8>>) {
    let mut c = CACHE.lock();
    forget_in(&mut c, gz);
    c.seq += 1;
    let seq = c.seq;
    c.bytes += buf.len();
    c.unzipped.insert(gz.to_path_buf(), Unzipped { key, buf, used_at: now_ms(), seq });
    while c.bytes > MAX_BYTES && c.unzipped.len() > 1 {
        let Some(oldest) = c.unzipped.iter().filter(|(k, _)| k.as_path() != gz).min_by_key(|(_, v)| v.seq).map(|(k, _)| k.clone()) else { break };
        forget_in(&mut c, &oldest);
    }
    if !c.reaper {
        c.reaper = true;
        // Bun's idle timer: every few minutes, logs not read for 5 minutes are let go.
        let _ = std::thread::Builder::new().name("run-log-idle".into()).spawn(|| loop {
            std::thread::sleep(Duration::from_millis(IDLE_MS as u64));
            let mut c = CACHE.lock();
            let now = now_ms();
            let idle: Vec<PathBuf> = c.unzipped.iter().filter(|(_, v)| now - v.used_at >= IDLE_MS).map(|(k, _)| k.clone()).collect();
            for k in idle {
                forget_in(&mut c, &k);
            }
        });
    }
}

fn forget_in(c: &mut Cache, gz: &Path) {
    if let Some(had) = c.unzipped.remove(gz) {
        c.bytes -= had.buf.len();
    }
}

/// When the kept decompressed copy of a log was last used (for tests); None when none is kept.
pub fn kept_log_used_at(file: &Path) -> Option<f64> {
    CACHE.lock().unzipped.get(&gz_of(file)).map(|u| u.used_at)
}

/// Lets go of what is kept for a log (after it was restored, or compressed again).
pub fn forget_log(file: &Path) {
    let gz = gz_of(file);
    let mut c = CACHE.lock();
    forget_in(&mut c, &gz);
    if let Some((_, _, seq)) = c.sizes.remove(&gz) {
        c.size_order.remove(&seq);
    }
}

/// Drops every kept decompressed log (tests).
pub fn reset_log_cache() {
    let mut c = CACHE.lock();
    c.unzipped.clear();
    c.bytes = 0;
    c.sizes.clear();
    c.size_order.clear();
}

/// The kept copy when it is current. mark: counts as a use (keeps it from the idle drop); a look doesn't.
fn cached(gz: &Path, key: &str, mark: bool) -> Option<Arc<Vec<u8>>> {
    let mut c = CACHE.lock();
    c.seq += 1;
    let seq = c.seq;
    let u = c.unzipped.get_mut(gz).filter(|u| u.key == key)?;
    if mark {
        u.used_at = now_ms();
        u.seq = seq;
    }
    Some(u.buf.clone())
}

/// The uncompressed size from a gzip trailer (the last 4 bytes, size mod 4 GB: run logs stay far below that).
fn trailer_size(gz: &Path, m: &fs::Metadata) -> io::Result<u64> {
    let key = key_of(m);
    if let Some((k, size, _)) = CACHE.lock().sizes.get(gz)
        && *k == key
    {
        return Ok(*size);
    }
    let f = File::open(gz)?;
    let mut b = [0u8; 4];
    let n = std::os::unix::fs::FileExt::read_at(&f, &mut b, m.len().saturating_sub(4))?;
    if n < 4 {
        b[n..].fill(0);
    }
    let size = u64::from(u32::from_le_bytes(b));
    let mut c = CACHE.lock();
    c.size_seq += 1;
    let seq = c.size_seq;
    if let Some((_, _, old)) = c.sizes.insert(gz.to_path_buf(), (key, size, seq)) {
        c.size_order.remove(&old);
    }
    c.size_order.insert(seq, gz.to_path_buf());
    if c.sizes.len() > MAX_SIZES
        && let Some((_, k)) = c.size_order.pop_first()
    {
        c.sizes.remove(&k);
    }
    Ok(size)
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogStat {
    /// Bytes of the log (uncompressed).
    pub size: u64,
    /// Last change (a compressed copy keeps the original's).
    pub mtime_ms: f64,
    /// The compressed copy's path when the log is compressed.
    pub gz: Option<PathBuf>,
}

/// `logStat`: the log's size and age, plain or compressed; None when neither exists.
pub fn log_stat(file: &Path) -> Option<LogStat> {
    if let Ok(m) = fs::metadata(file) {
        return Some(LogStat { size: m.len(), mtime_ms: m.modified().map(system_ms).unwrap_or(0.0), gz: None });
    }
    let gz = gz_of(file);
    let m = fs::metadata(&gz).ok()?;
    // Only a look: today's spend stats every log every few seconds.
    let size = match cached(&gz, &key_of(&m), false) {
        Some(b) => b.len() as u64,
        None => trailer_size(&gz, &m).ok()?,
    };
    Some(LogStat { size, mtime_ms: m.modified().map(system_ms).unwrap_or(0.0), gz: Some(gz) })
}

pub fn log_exists(file: &Path) -> bool {
    file.exists() || gz_of(file).exists()
}

/// One lock per log: steps that change which file is the log and appends hold it. Reentrant, so a step can call
/// another (a restore that settles both files).
pub fn lock(file: &Path) -> Arc<ReentrantMutex<()>> {
    static LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<ReentrantMutex<()>>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut g = LOCKS.lock();
    if let Some(l) = g.get(file).and_then(Weak::upgrade) {
        return l;
    }
    if g.len() > 1000 {
        g.retain(|_, w| w.strong_count() > 0);
    }
    let l = Arc::new(ReentrantMutex::new(()));
    g.insert(file.to_path_buf(), Arc::downgrade(&l));
    l
}

/// zlib said the data is bad: the copy is damaged, not the disk full or a file missing.
fn gunzip(raw: &[u8]) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(raw.len() * 4);
    flate2::read::MultiGzDecoder::new(raw).read_to_end(&mut out)?;
    Ok(out)
}

/// A damaged copy is renamed aside (`activity.jsonl.gz.unreadable-<id>`, never deleted) so the ticket can run again
/// with a fresh log.
fn set_aside(file: &Path, e: &io::Error) {
    let gz = gz_of(file);
    let aside = with_suffix(&gz, &format!(".unreadable-{}", new_id()));
    if fs::rename(&gz, &aside).is_err() {
        return; // gone meanwhile
    }
    forget_log(file);
    eprintln!("run log {}: its compressed copy doesn't decompress ({e}); kept as {}, a new log starts", file.display(), aside.display());
}

/// The compressed log's bytes: kept ones, else decompressed now. None when there is no copy or it is damaged (then
/// set aside).
fn unzip(file: &Path) -> io::Result<Option<Arc<Vec<u8>>>> {
    let gz = gz_of(file);
    let l = lock(file);
    let _g = l.lock();
    let Ok(m) = fs::metadata(&gz) else { return Ok(None) };
    let key = key_of(&m);
    if let Some(b) = cached(&gz, &key, true) {
        return Ok(Some(b));
    }
    let raw = match fs::read(&gz) {
        Ok(r) => r,
        // Restored meanwhile (the copy is gone): the plain file is the log now.
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    match gunzip(&raw) {
        Ok(buf) => {
            let buf = Arc::new(buf);
            remember(&gz, key, buf.clone());
            Ok(Some(buf))
        }
        Err(e) => {
            set_aside(file, &e);
            Ok(None)
        }
    }
}

/// `loadLog`: decompresses a compressed log off the runtime and keeps it for the readers' next reads.
pub async fn load_log(file: &Path) -> io::Result<()> {
    let f = file.to_path_buf();
    tokio::task::spawn_blocking(move || if f.exists() { Ok(()) } else { unzip(&f).map(|_| ()) }).await.map_err(io::Error::other)?
}

/// Positioned reads of a log, plain or compressed.
pub enum LogReader {
    File(File, u64),
    Mem(Arc<Vec<u8>>),
}

impl LogReader {
    pub fn size(&self) -> u64 {
        match self {
            LogReader::File(_, n) => *n,
            LogReader::Mem(b) => b.len() as u64,
        }
    }
}

impl ReadAt for LogReader {
    fn size(&self) -> u64 {
        LogReader::size(self)
    }
    fn read_at(&self, buf: &mut [u8], pos: u64) -> io::Result<usize> {
        match self {
            LogReader::File(f, _) => std::os::unix::fs::FileExt::read_at(f, buf, pos),
            LogReader::Mem(b) => b.as_slice().read_at(buf, pos),
        }
    }
}

/// `openLog` (blocking): positioned reads of the log; None when it doesn't exist. A compressed one is decompressed now
/// unless `load_log` ran.
pub fn open_log(file: &Path) -> Option<LogReader> {
    if let Ok(f) = File::open(file) {
        let n = f.metadata().map(|m| m.len()).unwrap_or(0);
        return Some(LogReader::File(f, n));
    }
    unzip(file).ok().flatten().map(LogReader::Mem)
}

/// `readLogSync` (blocking): the whole log's bytes (plain or compressed). For one ticket at a time: logs reach tens of MB.
pub fn read_log_sync(file: &Path) -> Option<Arc<Vec<u8>>> {
    if let Ok(b) = fs::read(file) {
        return Some(Arc::new(b));
    }
    unzip(file).ok().flatten().or_else(|| fs::read(file).ok().map(Arc::new))
}

/// `readLog`: the same off the runtime.
pub async fn read_log(file: &Path) -> Option<Arc<Vec<u8>>> {
    let f = file.to_path_buf();
    tokio::task::spawn_blocking(move || read_log_sync(&f)).await.ok().flatten()
}

fn write_synced(tmp: &Path, parts: &[&[u8]]) -> io::Result<()> {
    let mut f = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    for p in parts {
        f.write_all(p)?;
    }
    f.sync_all()
}

/// `restoreLogSync` / `restoreLog`'s steps (blocking): brings a compressed log back to the plain file so new lines can
/// be appended. Written to a temp file and synced, then renamed into place and the copy removed. A crash leaves the
/// copy (and maybe a temp file), or both files with the same bytes: never neither.
pub fn restore_log_blocking(file: &Path) -> io::Result<()> {
    let l = lock(file);
    let _g = l.lock();
    let gz = gz_of(file);
    if !gz.exists() {
        return Ok(());
    }
    if file.exists() {
        return settle_blocking(file);
    }
    let Some(bytes) = unzip(file)? else { return Ok(()) };
    let tmp = with_suffix(file, &format!(".tmp-{}", new_id()));
    let r = (|| {
        write_synced(&tmp, &[&bytes])?;
        fs::rename(&tmp, file)?;
        let _ = fs::remove_file(&gz);
        forget_log(file);
        Ok(())
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// `restoreLog`: the same off the runtime (the board calls it before a run starts).
pub async fn restore_log(file: &Path) -> io::Result<()> {
    let f = file.to_path_buf();
    tokio::task::spawn_blocking(move || restore_log_blocking(&f)).await.map_err(io::Error::other)?
}

/// `settleBoth`: both the plain log and a compressed copy exist. If the plain file starts with exactly the copy's
/// bytes (a step cut short, maybe with lines appended since), the plain file is the log and the copy is removed.
/// Otherwise the two are joined, the copy's bytes first. Nothing is dropped either way.
pub async fn settle_both(file: &Path) -> io::Result<()> {
    let f = file.to_path_buf();
    tokio::task::spawn_blocking(move || settle_blocking(&f)).await.map_err(io::Error::other)?
}

/// `settleBoth`'s steps (blocking).
pub fn settle_blocking(file: &Path) -> io::Result<()> {
    let l = lock(file);
    let _g = l.lock();
    let gz = gz_of(file);
    if !gz.exists() || !file.exists() {
        return Ok(());
    }
    // Taken before the compare: lines appended after it make the join below stop and try again later.
    let st0 = fs::metadata(file)?;
    let Some(bytes) = unzip(file)? else { return Ok(()) };
    let mut same = false;
    if st0.len() >= bytes.len() as u64 {
        let f = File::open(file)?;
        let mut head = vec![0u8; bytes.len()];
        let mut got = 0;
        while got < head.len() {
            let n = std::os::unix::fs::FileExt::read_at(&f, &mut head[got..], got as u64)?;
            if n == 0 {
                break;
            }
            got += n;
        }
        same = got == head.len() && head == *bytes;
    }
    // The plain file is the start of the copy (only a copy of the log cut short from outside): the copy is the log.
    let mut prefix = false;
    if !same && st0.len() < bytes.len() as u64 {
        let plain = fs::read(file)?;
        prefix = plain.len() as u64 == st0.len() && bytes[..plain.len()] == plain[..];
    }
    if !same {
        let tmp = with_suffix(file, &format!(".tmp-{}", new_id()));
        let r = (|| {
            let plain = if prefix { Vec::new() } else { fs::read(file)? };
            write_synced(&tmp, &[&bytes, &plain])?;
            let st1 = fs::metadata(file)?;
            // Grew meanwhile: try again next time rather than lose the new lines.
            if st1.len() != st0.len() || st1.modified().ok() != st0.modified().ok() {
                let _ = fs::remove_file(&tmp);
                return Ok(false);
            }
            fs::rename(&tmp, file)?;
            Ok(true)
        })();
        match r {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }
    let _ = fs::remove_file(&gz);
    forget_log(file);
    Ok(())
}

/// Appends one line (without its newline) to a run log, restoring a compressed log first (Bun's `appendActivity`
/// safety net). Holds the log's lock, so the compressor's swap can't happen between the check and the write.
pub fn append_line(file: &Path, line: &str) -> io::Result<()> {
    let l = lock(file);
    let _g = l.lock();
    if !file.exists() && gz_of(file).exists() {
        restore_log_blocking(file)?;
    }
    ckanban_core::jsonl::append_line(file, line)
}

/// Temp files of this log's own steps older than max_age_ms (a crash leaves them).
pub fn stale_temps(file: &Path, max_age_ms: f64) -> Vec<PathBuf> {
    let (Some(dir), Some(base)) = (file.parent(), file.file_name().map(|b| b.to_string_lossy().into_owned())) else { return Vec::new() };
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let now = now_ms();
    rd.flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(&format!("{base}.tmp-")) || n.starts_with(&format!("{base}.gz.tmp-"))
        })
        .filter(|e| e.metadata().ok().and_then(|m| m.modified().ok()).is_some_and(|t| now - system_ms(t) >= max_age_ms))
        .map(|e| e.path())
        .collect()
}

/// `removeStaleTemps` (blocking).
pub fn remove_stale_temps(file: &Path, max_age_ms: f64) {
    for p in stale_temps(file, max_age_ms) {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = GzEncoder::new(Vec::new(), Compression::new(6));
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn compressed_logs_read_like_plain_ones_and_restore() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("activity.jsonl");
        let text = b"{\"run\":1}\n{\"run\":2}\n";
        fs::write(gz_of(&file), gz(text)).unwrap();
        let st = log_stat(&file).unwrap();
        assert_eq!(st.size, text.len() as u64);
        assert!(st.gz.is_some());
        let r = open_log(&file).unwrap();
        let mut b = [0u8; 9];
        assert_eq!(r.read_at(&mut b, 10).unwrap(), 9);
        assert_eq!(&b, b"{\"run\":2}");
        append_line(&file, "{\"run\":3}").unwrap();
        assert!(!gz_of(&file).exists());
        assert_eq!(fs::read(&file).unwrap(), b"{\"run\":1}\n{\"run\":2}\n{\"run\":3}\n");
    }

    #[test]
    fn both_files_settle_without_losing_lines() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("activity.jsonl");
        // A step cut short with a line appended since: the plain file wins.
        fs::write(gz_of(&file), gz(b"a\n")).unwrap();
        fs::write(&file, b"a\nb\n").unwrap();
        settle_blocking(&file).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"a\nb\n");
        assert!(!gz_of(&file).exists());
        // Lines appended to a fresh plain file while compressed: joined, the copy first.
        fs::write(gz_of(&file), gz(b"a\nb\n")).unwrap();
        fs::write(&file, b"c\n").unwrap();
        settle_blocking(&file).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"a\nb\nc\n");
        // The plain file is only the start of the copy: the copy is the log.
        fs::write(gz_of(&file), gz(b"a\nb\nc\nd\n")).unwrap();
        fs::write(&file, b"a\nb\n").unwrap();
        settle_blocking(&file).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"a\nb\nc\nd\n");
    }

    #[test]
    fn a_damaged_copy_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("activity.jsonl");
        let mut bad = gz(b"hello\n");
        let n = bad.len();
        bad[n / 2] ^= 0xff;
        bad[n - 6] ^= 0xff;
        fs::write(gz_of(&file), bad).unwrap();
        assert!(open_log(&file).is_none());
        assert!(!gz_of(&file).exists());
        let aside: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(aside.iter().any(|n| n.starts_with("activity.jsonl.gz.unreadable-")), "{aside:?}");
        restore_log_blocking(&file).unwrap();
        append_line(&file, "x").unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"x\n");
    }
}
