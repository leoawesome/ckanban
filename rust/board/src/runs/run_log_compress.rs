//! Compressing the run logs of tickets Done for more than 30 days (`src/runs/run-log-compress.ts`). Every reader
//! handles both forms (`run_log.rs`), and the log comes back as a plain file before anything is appended.
//!
//! **Report-only on request** (plan 5.3): deleting is on by default; with `CKANBAN_RUST_DELETE=0` (or `delete: false`)
//! nothing is written, renamed or removed: each log it would compress (and each temp file it would remove) is written
//! as a line to `<data>/rust-board-dryrun.log`, and the handled list stays in memory.
//!
//! With deleting on, the steps are Bun's: the copy is written to a temp file, synced, read back and compared with the
//! original byte for byte; then, holding the log's lock (appends wait), it checks the original didn't change and the
//! ticket didn't start running, renames the copy into place and removes the original. A crash leaves the original, or
//! the original and a verified copy (the original wins), never neither. All of it is blocking work: the timers run
//! it with `spawn_blocking`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ckanban_core::atomic::new_id;
use ckanban_core::time::{iso, now_ms, parse_date};
use flate2::Compression;
use flate2::read::MultiGzDecoder;
use flate2::write::GzEncoder;
use parking_lot::Mutex;

use super::{js, run_log};

/// Done for longer than this before the log is compressed.
pub const COMPRESS_AFTER_MS: f64 = 30.0 * 86_400_000.0;
/// Logs compressed per pass.
const PER_PASS: usize = 3;
/// Smaller logs are left as they are.
const MIN_BYTES: u64 = 8 * 1024;
const PASS_MS: u64 = 2 * 60_000;
const SCAN_MS: u64 = 6 * 3_600_000;
/// A log that failed is tried again after this long.
const RETRY_MS: f64 = 86_400_000.0;
pub const STATE_FILE: &str = "run-logs-compressed.jsonl";
/// Where report-only jobs of the Rust board write what they would delete (plan 5.3).
pub const DRY_RUN_LOG: &str = "rust-board-dryrun.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressResult {
    Compressed,
    /// Report-only: it would have compressed the log (written to the dry-run log).
    WouldCompress,
    NoLog,
    Small,
    NotEligible,
    Running,
    Changed,
    Failed,
}

/// The fields of a ticket the job looks at.
#[derive(Debug, Clone, PartialEq)]
pub struct CompressTicket {
    pub id: String,
    pub status: String,
    pub done_at: Option<String>,
    pub updated_at: String,
    pub run_count: Option<f64>,
}

/// What the job needs from the board (R1/R7a give the real one): ticket lists in memory, runs, and the store's note
/// that a log is compressed now.
pub trait CompressBoard: Send + Sync {
    fn profiles(&self) -> Vec<String>;
    fn tickets(&self, slug: &str) -> Vec<CompressTicket>;
    fn ticket(&self, slug: &str, id: &str) -> Option<CompressTicket>;
    fn is_running(&self, slug: &str, id: &str) -> bool;
    /// `store.activityCompressed`: the ticket's log is compressed now (caches keyed on the plain file let go).
    fn activity_compressed(&self, slug: &str, id: &str);
}

pub type BeforeSwap = Box<dyn Fn(&str, &str) + Send + Sync>;

pub struct CompressOptions {
    pub age_ms: f64,
    pub per_pass: usize,
    pub min_bytes: u64,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// Called after the copy is verified, just before the swap (tests change things in between).
    pub before_swap: Option<BeforeSwap>,
    /// Really compress (else report only); default on unless `CKANBAN_RUST_DELETE=0`.
    pub delete: bool,
}

impl Default for CompressOptions {
    fn default() -> Self {
        CompressOptions {
            age_ms: COMPRESS_AFTER_MS,
            per_pass: PER_PASS,
            min_bytes: MIN_BYTES,
            now: Arc::new(now_ms),
            before_swap: None,
            delete: crate::dryrun::deletes_on(),
        }
    }
}

/// What a ticket's handled mark is tied to: done again later, or run again, and it is looked at again.
fn handled_key(t: &CompressTicket) -> String {
    let at = t.done_at.clone().unwrap_or_else(|| t.updated_at.clone());
    format!("{at}|{}", ckanban_core::jsnum::js_string(t.run_count.unwrap_or(0.0)))
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub logs: u64,
    pub before: u64,
    pub after: u64,
}

/// Tickets left to look at (board, id), and the same as "board/id" keys.
type Queue = (VecDeque<(String, String)>, HashSet<String>);

pub struct RunLogCompressor {
    root: PathBuf,
    board: Arc<dyn CompressBoard>,
    o: CompressOptions,
    handled: Mutex<HashMap<String, HashMap<String, String>>>,
    failed: Mutex<HashMap<String, f64>>,
    queue: Mutex<Queue>,
    /// One job step at a time.
    busy: Mutex<()>,
    pub stats: Mutex<Stats>,
}

impl RunLogCompressor {
    pub fn new(root: &Path, board: Arc<dyn CompressBoard>, o: CompressOptions) -> Arc<Self> {
        Arc::new(RunLogCompressor {
            root: root.to_path_buf(),
            board,
            o,
            handled: Mutex::new(HashMap::new()),
            failed: Mutex::new(HashMap::new()),
            queue: Mutex::new((VecDeque::new(), HashSet::new())),
            busy: Mutex::new(()),
            stats: Mutex::new(Stats::default()),
        })
    }

    fn now(&self) -> f64 {
        (self.o.now)()
    }

    fn state_file(&self, slug: &str) -> PathBuf {
        self.root.join("profiles").join(slug).join(STATE_FILE)
    }

    pub fn activity_path(&self, slug: &str, id: &str) -> PathBuf {
        ckanban_core::DataDir::new(&self.root).activity_path(slug, id)
    }

    /// Writes one line to `<data>/rust-board-dryrun.log`.
    fn report(&self, what: &str) {
        let line = format!("{} run-log-compress: {what}\n", iso(now_ms()));
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(self.root.join(DRY_RUN_LOG)) {
            let _ = f.write_all(line.as_bytes());
        }
    }

    fn handled_of(&self, slug: &str) {
        if self.handled.lock().contains_key(slug) {
            return;
        }
        let mut m = HashMap::new();
        if let Ok(text) = fs::read_to_string(self.state_file(slug)) {
            for line in text.split('\n').filter(|l| !l.is_empty()) {
                if let Some(e) = js::parse(line)
                    && let (Some(id), Some(key)) = (e.get("id").and_then(|v| v.as_str()), e.get("key").and_then(|v| v.as_str()))
                {
                    m.insert(id.to_string(), key.to_string());
                }
            }
        }
        self.handled.lock().entry(slug.to_string()).or_insert(m);
    }

    fn is_handled(&self, slug: &str, t: &CompressTicket) -> bool {
        self.handled.lock().get(slug).and_then(|m| m.get(&t.id)).is_some_and(|k| *k == handled_key(t))
    }

    fn mark_handled(&self, slug: &str, t: &CompressTicket) {
        let key = handled_key(t);
        {
            let mut h = self.handled.lock();
            let m = h.entry(slug.to_string()).or_default();
            if m.get(&t.id) == Some(&key) {
                return;
            }
            m.insert(t.id.clone(), key.clone());
        }
        // Report-only keeps the mark in memory: the shared file is Bun's until deleting is on.
        if self.o.delete {
            let line = js::stringify(&serde_json::json!({ "id": t.id, "key": key }));
            let _ = ckanban_core::jsonl::append_line(&self.state_file(slug), &line);
        }
    }

    fn eligible(&self, t: Option<&CompressTicket>) -> bool {
        let Some(t) = t.filter(|t| t.status == "done") else { return false };
        let since = parse_date(t.done_at.as_deref().unwrap_or(&t.updated_at));
        since.is_some_and(|s| self.now() - s > self.o.age_ms)
    }

    /// Finds the tickets left to look at: Done long enough and not handled since they were last done or run (ticket
    /// lists in memory, no file reads besides each board's handled list once). Returns how many are waiting.
    pub fn scan(&self) -> usize {
        for slug in self.board.profiles() {
            self.handled_of(&slug);
            for t in self.board.tickets(&slug) {
                let k = format!("{slug}/{}", t.id);
                if self.queue.lock().1.contains(&k) || !self.eligible(Some(&t)) || self.is_handled(&slug, &t) {
                    continue;
                }
                if self.failed.lock().get(&k).is_some_and(|at| self.now() - at < RETRY_MS) {
                    continue;
                }
                let mut q = self.queue.lock();
                q.1.insert(k);
                q.0.push_back((slug.clone(), t.id.clone()));
            }
        }
        self.queue.lock().0.len()
    }

    /// Compresses (or reports) up to a few logs waiting from the last scan. Returns how many.
    pub fn pass(&self) -> usize {
        let mut done = 0;
        let mut looked = 0;
        while done < self.o.per_pass && looked < 200 {
            let Some((slug, id)) = ({
                let mut q = self.queue.lock();
                let next = q.0.pop_front();
                if let Some((s, i)) = &next {
                    q.1.remove(&format!("{s}/{i}"));
                }
                next
            }) else {
                break;
            };
            looked += 1;
            if matches!(self.compress(&slug, &id), CompressResult::Compressed | CompressResult::WouldCompress) {
                done += 1;
            }
        }
        if done > 0 && self.o.delete {
            let s = *self.stats.lock();
            println!("run logs: compressed {} so far, {} MB to {} MB", s.logs, mb(s.before), mb(s.after));
        }
        done
    }

    /// Compresses one ticket's log if it qualifies (report-only: says it would).
    pub fn compress(&self, slug: &str, id: &str) -> CompressResult {
        let t = self.board.ticket(slug, id);
        if !self.eligible(t.as_ref()) {
            return CompressResult::NotEligible;
        }
        let t = t.expect("eligible");
        if self.board.is_running(slug, id) {
            return CompressResult::Running;
        }
        self.handled_of(slug);
        let file = self.activity_path(slug, id);
        let gz = run_log::gz_of(&file);
        let k = format!("{slug}/{id}");
        if !self.o.delete {
            return self.dry_run(slug, &t, &file, &gz);
        }
        match self.compress_now(slug, id, &t, &file, &gz) {
            Ok(r) => r,
            Err(e) => {
                self.failed.lock().insert(k.clone(), self.now());
                eprintln!("run-log-compress {k}: {e}");
                CompressResult::Failed
            }
        }
    }

    fn dry_run(&self, slug: &str, t: &CompressTicket, file: &Path, gz: &Path) -> CompressResult {
        for p in run_log::stale_temps(file, 10.0 * 60_000.0) {
            self.report(&format!("would remove {} (a temp file left by a step cut short)", p.display()));
        }
        if file.exists() && gz.exists() {
            self.report(&format!("would settle {} with its compressed copy {}", file.display(), gz.display()));
        }
        let Ok(m) = fs::metadata(file) else {
            self.mark_handled(slug, t);
            return CompressResult::NoLog;
        };
        if m.len() < self.o.min_bytes {
            self.mark_handled(slug, t);
            return CompressResult::Small;
        }
        self.report(&format!("would compress {} ({} bytes) and remove it", file.display(), m.len()));
        self.mark_handled(slug, t);
        CompressResult::WouldCompress
    }

    fn compress_now(&self, slug: &str, id: &str, t: &CompressTicket, file: &Path, gz: &Path) -> io::Result<CompressResult> {
        // Temp files a crash left from an earlier try at this log.
        run_log::remove_stale_temps(file, 10.0 * 60_000.0);
        // Both there: a step cut short earlier. The plain file wins (joined with the copy if it isn't the same log).
        if file.exists() && gz.exists() {
            run_log::settle_blocking(file)?;
        }
        if !file.exists() {
            self.mark_handled(slug, t);
            return Ok(CompressResult::NoLog);
        }
        let st0 = fs::metadata(file)?;
        if st0.len() < self.o.min_bytes {
            self.mark_handled(slug, t);
            return Ok(CompressResult::Small);
        }
        let mut tmp_name = gz.as_os_str().to_owned();
        tmp_name.push(format!(".tmp-{}", new_id()));
        let tmp = PathBuf::from(tmp_name);
        let r = (|| -> io::Result<CompressResult> {
            write_copy(file, &tmp, st0.len())?;
            // Read back: the copy must decompress to exactly the original's bytes.
            if !same_bytes(file, &tmp, st0.len())? {
                return Err(io::Error::other(format!("copy of {slug}/{id} run log didn't match the original")));
            }
            if let Some(f) = &self.o.before_swap {
                f(slug, id);
            }
            // The swap, holding the log's lock: no append from this process can come in between.
            let l = run_log::lock(file);
            let _g = l.lock();
            let st1 = fs::metadata(file)?;
            if st1.len() != st0.len()
                || st1.modified().ok() != st0.modified().ok()
                || self.board.is_running(slug, id)
                || !self.eligible(self.board.ticket(slug, id).as_ref())
                || gz.exists()
            {
                let _ = fs::remove_file(&tmp);
                return Ok(CompressResult::Changed);
            }
            let size = fs::metadata(&tmp)?.len();
            let times = fs::FileTimes::new().set_accessed(st0.accessed()?).set_modified(st0.modified()?);
            File::options().write(true).open(&tmp)?.set_times(times)?;
            fs::rename(&tmp, gz)?;
            fs::remove_file(file)?;
            run_log::forget_log(file);
            self.board.activity_compressed(slug, id);
            let now_t = self.board.ticket(slug, id).unwrap_or_else(|| t.clone());
            self.mark_handled(slug, &now_t);
            self.failed.lock().remove(&format!("{slug}/{id}"));
            let mut s = self.stats.lock();
            s.logs += 1;
            s.before += st0.len();
            s.after += size;
            Ok(CompressResult::Compressed)
        })();
        if r.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        r
    }

    /// Starts the job on the runtime: a first look a minute after start, then a pass every 2 minutes and a fresh look
    /// every 6 hours. The returned function stops it. `CKANBAN_NO_LOG_COMPRESS` turns it off.
    pub fn start(self: &Arc<Self>) -> impl FnOnce() + Send + 'static {
        let off = std::env::var_os("CKANBAN_NO_LOG_COMPRESS").is_some_and(|v| !v.is_empty());
        let me = self.clone();
        let task = (!off).then(|| {
            tokio::spawn(async move {
                let step = |me: Arc<Self>, scan: bool| async move {
                    let _ = tokio::task::spawn_blocking(move || {
                        // A pass doesn't start while a scan or another pass runs.
                        let Some(_g) = me.busy.try_lock() else { return };
                        if scan {
                            me.scan();
                        } else {
                            me.pass();
                        }
                    })
                    .await;
                };
                tokio::time::sleep(Duration::from_secs(60)).await;
                step(me.clone(), true).await;
                let start = tokio::time::Instant::now();
                let mut passes = tokio::time::interval_at(start + Duration::from_millis(PASS_MS), Duration::from_millis(PASS_MS));
                let mut scans = tokio::time::interval_at(start + Duration::from_millis(SCAN_MS), Duration::from_millis(SCAN_MS));
                loop {
                    tokio::select! {
                        _ = passes.tick() => step(me.clone(), false).await,
                        _ = scans.tick() => step(me.clone(), true).await,
                    }
                }
            })
        });
        move || {
            if let Some(t) = task {
                t.abort();
            }
        }
    }
}

/// Streams the first `len` bytes of `file` through gzip (level 6) into a new `tmp`, synced.
fn write_copy(file: &Path, tmp: &Path, len: u64) -> io::Result<()> {
    let out = OpenOptions::new().write(true).create_new(true).open(tmp)?;
    let mut enc = GzEncoder::new(out, Compression::new(6));
    io::copy(&mut File::open(file)?.take(len), &mut enc)?;
    enc.finish()?.sync_all()
}

/// The copy decompresses to exactly the first `len` bytes of the original.
fn same_bytes(file: &Path, gz: &Path, len: u64) -> io::Result<bool> {
    let mut a = File::open(file)?.take(len);
    let mut b = MultiGzDecoder::new(File::open(gz)?);
    let (mut x, mut y) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = read_full(&mut a, &mut x)?;
        let m = read_full(&mut b, &mut y)?;
        if n != m || x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        let n = r.read(&mut buf[got..])?;
        if n == 0 {
            break;
        }
        got += n;
    }
    Ok(got)
}

fn mb(n: u64) -> u64 {
    (n as f64 / 1_048_576.0).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Board {
        tickets: Mutex<Vec<CompressTicket>>,
        running: Mutex<bool>,
        compressed: Mutex<Vec<String>>,
    }

    impl CompressBoard for Board {
        fn profiles(&self) -> Vec<String> {
            vec!["p".into()]
        }
        fn tickets(&self, _: &str) -> Vec<CompressTicket> {
            self.tickets.lock().clone()
        }
        fn ticket(&self, _: &str, id: &str) -> Option<CompressTicket> {
            self.tickets.lock().iter().find(|t| t.id == id).cloned()
        }
        fn is_running(&self, _: &str, _: &str) -> bool {
            *self.running.lock()
        }
        fn activity_compressed(&self, _: &str, id: &str) {
            self.compressed.lock().push(id.into());
        }
    }

    fn ticket(id: &str, status: &str, done_at: &str) -> CompressTicket {
        CompressTicket { id: id.into(), status: status.into(), done_at: Some(done_at.into()), updated_at: done_at.into(), run_count: Some(2.0) }
    }

    fn setup(delete: bool) -> (tempfile::TempDir, Arc<Board>, Arc<RunLogCompressor>) {
        let dir = tempfile::tempdir().unwrap();
        let board = Arc::new(Board {
            tickets: Mutex::new(vec![
                ticket("t_old", "done", "2026-01-01T00:00:00.000Z"),
                ticket("t_new", "done", "2026-11-16T00:00:00.000Z"),
                ticket("t_open", "todo", "2026-01-01T00:00:00.000Z"),
                ticket("t_small", "done", "2026-01-01T00:00:00.000Z"),
            ]),
            running: Mutex::new(false),
            compressed: Mutex::new(Vec::new()),
        });
        for (id, n) in [("t_old", 20_000), ("t_new", 20_000), ("t_open", 20_000), ("t_small", 100)] {
            let f = DataDirLike(dir.path()).activity(id);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(&f, "{\"run\":1,\"event\":{}}\n".repeat(n / 20)).unwrap();
        }
        let now = parse_date("2026-11-17T00:00:00.000Z").unwrap();
        let c = RunLogCompressor::new(dir.path(), board.clone(), CompressOptions { now: Arc::new(move || now), delete, ..Default::default() });
        (dir, board, c)
    }

    struct DataDirLike<'a>(&'a Path);
    impl DataDirLike<'_> {
        fn activity(&self, id: &str) -> PathBuf {
            ckanban_core::DataDir::new(self.0).activity_path("p", id)
        }
    }

    #[test]
    fn report_only_writes_nothing_but_the_dry_run_log() {
        let (dir, board, c) = setup(false);
        assert_eq!(c.scan(), 2);
        assert_eq!(c.pass(), 1);
        let f = DataDirLike(dir.path()).activity("t_old");
        assert!(f.exists() && !run_log::gz_of(&f).exists());
        assert!(!dir.path().join("profiles/p").join(STATE_FILE).exists());
        let log = fs::read_to_string(dir.path().join(DRY_RUN_LOG)).unwrap();
        assert!(log.contains("would compress") && log.contains("t_old"), "{log}");
        assert!(board.compressed.lock().is_empty());
        // Handled in memory: not looked at again.
        assert_eq!(c.scan(), 0);
    }

    #[test]
    fn compresses_only_old_done_tickets_and_reads_back_the_same() {
        let (dir, board, c) = setup(true);
        let f = DataDirLike(dir.path()).activity("t_old");
        let before = fs::read(&f).unwrap();
        let mtime = fs::metadata(&f).unwrap().modified().unwrap();
        assert_eq!(c.compress("p", "t_new"), CompressResult::NotEligible);
        assert_eq!(c.compress("p", "t_open"), CompressResult::NotEligible);
        assert_eq!(c.compress("p", "t_small"), CompressResult::Small);
        *board.running.lock() = true;
        assert_eq!(c.compress("p", "t_old"), CompressResult::Running);
        *board.running.lock() = false;
        assert_eq!(c.compress("p", "t_old"), CompressResult::Compressed);
        assert!(!f.exists());
        let gz = run_log::gz_of(&f);
        assert_eq!(fs::metadata(&gz).unwrap().modified().unwrap(), mtime);
        assert_eq!(*run_log::read_log_sync(&f).unwrap(), before);
        assert_eq!(board.compressed.lock().as_slice(), ["t_old"]);
        let state = fs::read_to_string(dir.path().join("profiles/p").join(STATE_FILE)).unwrap();
        assert!(state.contains("\"id\":\"t_old\",\"key\":\"2026-01-01T00:00:00.000Z|2\""), "{state}");
        assert_eq!(c.scan(), 0);
    }

    #[test]
    fn an_append_before_the_swap_leaves_the_original() {
        let (dir, _board, c) = setup(true);
        let f = DataDirLike(dir.path()).activity("t_old");
        let f2 = f.clone();
        let c2 = RunLogCompressor::new(
            dir.path(),
            c.board.clone(),
            CompressOptions {
                now: c.o.now.clone(),
                delete: true,
                before_swap: Some(Box::new(move |_, _| run_log::append_line(&f2, "{\"late\":true}").unwrap())),
                ..Default::default()
            },
        );
        assert_eq!(c2.compress("p", "t_old"), CompressResult::Changed);
        assert!(f.exists() && !run_log::gz_of(&f).exists());
        assert!(fs::read_to_string(&f).unwrap().ends_with("{\"late\":true}\n"));
    }
}
