//! The reading half of `Store` (`src/core/store.ts`): every board's ticket files parsed once and kept by file mtime and
//! size, and each board's listing (all tickets by `order`) as one shared `Arc<BoardList>` that readers take without
//! waiting (plan 2.1, 2.2).
//!
//! When the files are read again, like Bun:
//! - at start, every board at once on a few threads (`load_all`);
//! - when a board's `tickets/` folder changed (a ticket added or removed): one stat per listing (`list`);
//! - every 30 s in the background (`recheck_all`), which catches a `ticket.md` edited from outside;
//! - one ticket's file on every read of that ticket (`ticket`), as `getTicket` does.
//!
//! No lock is held while reading files: a refresh reads and parses with no lock, looks up and fills the parse cache
//! one file at a time, and swaps in the finished listing. Two refreshes of one board at once: the one that started
//! last wins.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Instant, SystemTime};

use ckanban_core::time::{iso, now_ms};
use parking_lot::{Condvar, Mutex, RwLock};

use super::family::Kids;
use super::scope::ScopeIndex;
use super::ticket::Tk;

/// How often the background re-check stats every ticket file (`TICKET_RECHECK_MS`).
pub const RECHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(30);

/// How long a listing waits for the start-up load before reading the board itself.
const LOAD_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

/// A file's mtime and size: the parse cache's key (Bun's `${mtimeMs}:${size}`).
type Stamp = (Option<SystemTime>, u64);

fn stamp(m: &std::fs::Metadata) -> Stamp {
    (m.modified().ok(), m.len())
}

/// One board's tickets at one moment: shared and never changed (a change is a new `BoardList`).
pub struct BoardList {
    pub slug: String,
    /// By `order` (ties in folder order, as Bun's sort of `readdirSync`).
    pub tickets: Vec<Arc<Tk>>,
    /// Moves on whenever the listing changes (`ticketsVersion`).
    pub version: u64,
    by_id: HashMap<String, usize>,
    kids: OnceLock<Kids>,
    scope: OnceLock<ScopeIndex>,
    features: OnceLock<HashSet<String>>,
    newest: OnceLock<Vec<usize>>,
    inboxable: OnceLock<Vec<usize>>,
    open: OnceLock<Vec<usize>>,
}

impl BoardList {
    pub fn new(slug: &str, tickets: Vec<Arc<Tk>>, version: u64) -> BoardList {
        let mut by_id = HashMap::with_capacity(tickets.len());
        for (i, t) in tickets.iter().enumerate() {
            by_id.entry(t.id.clone()).or_insert(i);
        }
        BoardList {
            slug: slug.to_string(),
            tickets,
            version,
            by_id,
            kids: OnceLock::new(),
            scope: OnceLock::new(),
            features: OnceLock::new(),
            newest: OnceLock::new(),
            inboxable: OnceLock::new(),
            open: OnceLock::new(),
        }
    }

    /// A listing of these tickets, sorted like Bun's `remember` (by order, stable).
    pub fn sorted(slug: &str, mut tickets: Vec<Arc<Tk>>, version: u64) -> BoardList {
        tickets.sort_by(|a, b| a.order.partial_cmp(&b.order).unwrap_or(std::cmp::Ordering::Equal));
        BoardList::new(slug, tickets, version)
    }

    pub fn idx(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }
    pub fn get(&self, id: &str) -> Option<&Arc<Tk>> {
        self.idx(id).map(|i| &self.tickets[i])
    }
    pub fn at(&self, i: usize) -> &Tk {
        &self.tickets[i]
    }

    /// Direct children of every ticket, oldest first (`childrenByParent`).
    pub fn kids(&self) -> &Kids {
        self.kids.get_or_init(|| Kids::build(self))
    }
    /// Family keys and the Done column (`scopeIndex`).
    pub fn scope(&self) -> &ScopeIndex {
        self.scope.get_or_init(|| ScopeIndex::build(self))
    }
    /// Top tickets of the open features (`openFeatures`), for the list's `feature: true`.
    pub fn features(&self) -> &HashSet<String> {
        self.features.get_or_init(|| super::family::open_features(self).into_iter().map(|i| self.tickets[i].id.clone()).collect())
    }
    /// Newest first by id (`byIdNewest`): list_tickets' order.
    pub fn newest(&self) -> &[usize] {
        self.newest.get_or_init(|| {
            let mut v: Vec<usize> = (0..self.tickets.len()).collect();
            v.sort_by(|&a, &b| self.tickets[b].id.cmp(&self.tickets[a].id));
            v
        })
    }
    /// The tickets that can wait on the user: not Done, or with a missed follow-up (`inboxable`).
    pub fn inboxable(&self) -> &[usize] {
        self.inboxable.get_or_init(|| {
            (0..self.tickets.len())
                .filter(|&i| {
                    let t = &self.tickets[i];
                    t.status != "done" || t.get("followUp").and_then(|f| f.get("missedAt")).is_some_and(|m| ckanban_core::jsnum::truthy(Some(m)))
                })
                .collect()
        })
    }
    /// The tickets that aren't Done (`listOpenTickets`).
    pub fn open(&self) -> &[usize] {
        self.open.get_or_init(|| (0..self.tickets.len()).filter(|&i| self.tickets[i].status != "done").collect())
    }
}

struct BoardState {
    list: Arc<BoardList>,
    dir_mtime: Option<SystemTime>,
    /// The start of the refresh that made `list` (a refresh that started earlier never replaces it).
    made_by: u64,
    checked_at: Instant,
}

pub struct Index {
    root: PathBuf,
    /// Parsed ticket files by path, with the stamp they were parsed at. Corrupt files aren't kept (Bun reads them each time).
    cache: Mutex<HashMap<PathBuf, (Stamp, Arc<Tk>)>>,
    boards: RwLock<HashMap<String, BoardState>>,
    seq: AtomicU64,
    /// The start-up load is running: a listing of a board it hasn't installed yet waits for it instead of reading the
    /// same files a second time.
    loading: Mutex<bool>,
    loaded: Condvar,
}

impl Index {
    pub fn new(root: &Path) -> Arc<Index> {
        Arc::new(Index {
            root: root.to_path_buf(),
            cache: Mutex::new(HashMap::new()),
            boards: RwLock::new(HashMap::new()),
            seq: AtomicU64::new(1),
            loading: Mutex::new(false),
            loaded: Condvar::new(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn tickets_dir(&self, slug: &str) -> PathBuf {
        self.root.join("profiles").join(slug).join("tickets")
    }
    pub fn ticket_dir(&self, slug: &str, id: &str) -> PathBuf {
        self.tickets_dir(slug).join(id)
    }

    /// The boards (folders under `profiles/`).
    fn board_slugs(&self) -> Vec<String> {
        std::fs::read_dir(self.root.join("profiles"))
            .map(|d| d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
            .unwrap_or_default()
    }

    /// The board's listing, brought up to date (`listTickets`): read once, then again when its folder changed.
    /// Blocking: call it off the async runtime.
    pub fn list(&self, slug: &str) -> Arc<BoardList> {
        let dir = self.tickets_dir(slug);
        let mtime = match std::fs::metadata(&dir) {
            Ok(m) => m.modified().ok(),
            Err(_) => {
                self.boards.write().remove(slug);
                return Arc::new(BoardList::new(slug, Vec::new(), 0));
            }
        };
        if let Some(b) = self.boards.read().get(slug) {
            if b.dir_mtime == mtime {
                return b.list.clone();
            }
        }
        if self.wait_loaded(LOAD_WAIT) {
            if let Some(b) = self.boards.read().get(slug) {
                if b.dir_mtime == mtime {
                    return b.list.clone();
                }
            }
        }
        self.refresh(slug)
    }

    /// Marks the start-up load as begun (before it is handed to a thread), so early listings wait for it.
    pub fn begin_load(&self) {
        *self.loading.lock() = true;
    }

    /// Waits (at most `max`) while the start-up load runs. True when it had to wait.
    pub fn wait_loaded(&self, max: std::time::Duration) -> bool {
        let mut loading = self.loading.lock();
        if !*loading {
            return false;
        }
        let deadline = Instant::now() + max;
        while *loading {
            if self.loaded.wait_until(&mut loading, deadline).timed_out() {
                break;
            }
        }
        true
    }

    /// The listing as it is now, without a stat (None: not read yet).
    pub fn peek(&self, slug: &str) -> Option<Arc<BoardList>> {
        self.boards.read().get(slug).map(|b| b.list.clone())
    }

    /// One ticket, its file stat'ed now (`getTicket`): a file changed from outside is read again, and the board's
    /// listing follows it. None when the file is missing.
    pub fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        if id.is_empty() || id.contains('/') || id == "." || id == ".." {
            return None;
        }
        let file = self.ticket_dir(slug, id).join("ticket.md");
        let Ok(m) = std::fs::metadata(&file) else {
            if self.cache.lock().remove(&file).is_some() {
                self.refresh(slug);
            }
            return None;
        };
        let st = stamp(&m);
        if let Some((s, t)) = self.cache.lock().get(&file) {
            if *s == st {
                return Some(t.clone());
            }
        }
        let known = self.cache.lock().contains_key(&file);
        let t = self.read_file(&file, id, st)?;
        // A ticket we knew changed outside: the listing must show it now, not at the next re-check.
        if known || self.peek(slug).is_some_and(|l| l.get(id).is_some_and(|x| !Arc::ptr_eq(x, &t))) {
            self.refresh(slug);
        }
        Some(t)
    }

    /// Reads and parses one ticket file (cached when it parses). None when it can't be read.
    fn read_file(&self, file: &Path, id: &str, st: Stamp) -> Option<Arc<Tk>> {
        let raw = std::fs::read(file).ok()?;
        let raw = String::from_utf8_lossy(&raw);
        let t = Arc::new(Tk::parse(id, &raw, &iso(now_ms())));
        let mut cache = self.cache.lock();
        if t.corrupt {
            cache.remove(file);
        } else {
            cache.insert(file.to_path_buf(), (st, t.clone()));
        }
        Some(t)
    }

    /// The ticket behind `file` now: the cached parse when the stamp matches, else read again. None: no ticket there.
    fn current(&self, file: &Path, id: &str) -> Option<Arc<Tk>> {
        let st = match std::fs::metadata(file) {
            Ok(m) => stamp(&m),
            Err(_) => {
                self.cache.lock().remove(file);
                return None;
            }
        };
        if let Some((s, t)) = self.cache.lock().get(file) {
            if *s == st {
                return Some(t.clone());
            }
        }
        self.read_file(file, id, st)
    }

    /// Reads the board's folder again: every ticket file stat'ed, changed ones parsed, the listing swapped in.
    pub fn refresh(&self, slug: &str) -> Arc<BoardList> {
        let started = self.seq.fetch_add(1, Ordering::SeqCst);
        let dir = self.tickets_dir(slug);
        let (mtime, names) = match (std::fs::metadata(&dir), std::fs::read_dir(&dir)) {
            (Ok(m), Ok(d)) => (m.modified().ok(), d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect::<Vec<_>>()),
            _ => {
                self.boards.write().remove(slug);
                return Arc::new(BoardList::new(slug, Vec::new(), 0));
            }
        };
        let tickets: Vec<Arc<Tk>> = names.iter().filter_map(|id| self.current(&dir.join(id).join("ticket.md"), id)).collect();
        self.install(slug, tickets, mtime, started)
    }

    /// Swaps in a freshly read listing (its version moves on when it differs), unless a later refresh got there first.
    fn install(&self, slug: &str, tickets: Vec<Arc<Tk>>, mtime: Option<SystemTime>, started: u64) -> Arc<BoardList> {
        let mut boards = self.boards.write();
        let prev = boards.get(slug);
        if let Some(p) = prev {
            if p.made_by > started {
                return p.list.clone();
            }
        }
        let mut list = BoardList::sorted(slug, tickets, 0);
        let version = match prev {
            None => 0,
            Some(p) => {
                let same = p.list.tickets.len() == list.tickets.len() && p.list.tickets.iter().zip(&list.tickets).all(|(a, b)| Arc::ptr_eq(a, b));
                if same {
                    // Nothing changed: keep the old listing (and what was worked out from it).
                    let keep = p.list.clone();
                    boards.insert(slug.to_string(), BoardState { list: keep.clone(), dir_mtime: mtime, made_by: started, checked_at: Instant::now() });
                    return keep;
                }
                p.list.version + 1
            }
        };
        list.version = version;
        let list = Arc::new(list);
        boards.insert(slug.to_string(), BoardState { list: list.clone(), dir_mtime: mtime, made_by: started, checked_at: Instant::now() });
        list
    }

    /// Every board's tickets read at once on a few threads (the start-up load, plan 2.2). Returns how many tickets.
    pub fn load_all(&self) -> usize {
        let slugs = self.board_slugs();
        let mut work: Vec<(String, Option<SystemTime>, Vec<String>)> = Vec::new();
        for slug in slugs {
            let dir = self.tickets_dir(&slug);
            if let (Ok(m), Ok(d)) = (std::fs::metadata(&dir), std::fs::read_dir(&dir)) {
                work.push((slug, m.modified().ok(), d.flatten().filter_map(|e| e.file_name().into_string().ok()).collect()));
            }
        }
        *self.loading.lock() = true;
        // Whatever happens below, waiting listings are let go at the end.
        struct Done<'a>(&'a Index);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                *self.0.loading.lock() = false;
                self.0.loaded.notify_all();
            }
        }
        let _done = Done(self);
        let started = self.seq.fetch_add(1, Ordering::SeqCst);
        let jobs: Vec<(usize, usize)> = work.iter().enumerate().flat_map(|(b, (_, _, names))| (0..names.len()).map(move |n| (b, n))).collect();
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
        let per = jobs.len().div_ceil(threads).max(1);
        let mut found: Vec<Vec<Option<Arc<Tk>>>> = work.iter().map(|(_, _, n)| vec![None; n.len()]).collect();
        let results: Vec<Vec<((usize, usize), Option<Arc<Tk>>)>> = std::thread::scope(|s| {
            let handles: Vec<_> = jobs
                .chunks(per)
                .map(|chunk| {
                    let work = &work;
                    s.spawn(move || {
                        chunk
                            .iter()
                            .map(|&(b, n)| {
                                let (slug, _, names) = &work[b];
                                let id = &names[n];
                                ((b, n), self.current(&self.tickets_dir(slug).join(id).join("ticket.md"), id))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
        });
        for ((b, n), t) in results.into_iter().flatten() {
            found[b][n] = t;
        }
        let mut total = 0;
        for ((slug, mtime, _), tickets) in work.iter().zip(found) {
            let tickets: Vec<Arc<Tk>> = tickets.into_iter().flatten().collect();
            total += tickets.len();
            self.install(slug, tickets, *mtime, started);
        }
        total
    }

    /// The background re-check (`recheckTickets`): every board's files stat'ed again, changed ones read.
    pub fn recheck_all(&self) {
        for slug in self.board_slugs() {
            let due = self.boards.read().get(&slug).is_none_or(|b| b.checked_at.elapsed() >= RECHECK_EVERY / 2);
            if due {
                self.refresh(&slug);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, slug: &str, id: &str, extra: &str) {
        let d = root.join("profiles").join(slug).join("tickets").join(id);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("ticket.md"), format!("---\nid: {id}\ntitle: T {id}\nstatus: backlog\n{extra}---\nbody\n")).unwrap();
    }

    #[test]
    fn lists_by_order_and_follows_changes() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "b", "t_1", "order: 3\n");
        write(d.path(), "b", "t_2", "order: 1\n");
        write(d.path(), "c", "t_9", "order: 1\n");
        std::fs::create_dir_all(d.path().join("profiles/b/tickets/junk")).unwrap();
        let ix = Index::new(d.path());
        assert_eq!(ix.load_all(), 3);
        let l = ix.list("b");
        assert_eq!(l.tickets.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t_2", "t_1"]);
        assert_eq!(l.version, 0);
        // Same folder: the same listing.
        assert!(Arc::ptr_eq(&l, &ix.list("b")));
        // A new ticket changes the folder: listed at once.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(d.path(), "b", "t_3", "order: 2\n");
        let l2 = ix.list("b");
        assert_eq!(l2.tickets.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["t_2", "t_3", "t_1"]);
        assert_eq!(l2.version, 1);
        // An edit in place: seen by a read of that ticket, and the listing follows.
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(d.path(), "b", "t_1", "order: 0\n");
        assert_eq!(ix.ticket("b", "t_1").unwrap().order, 0.0);
        assert_eq!(ix.list("b").tickets[0].id, "t_1");
        assert!(ix.ticket("b", "nope").is_none());
        assert!(ix.ticket("b", "../c").is_none());
    }
}

/// `R1_BENCH_HOME=<data folder> cargo test --release -p ckanban-board load_bench -- --ignored --nocapture`: how long
/// the start-up load takes on a real-sized data folder (read only).
#[cfg(test)]
#[test]
#[ignore]
fn load_bench() {
    let Ok(home) = std::env::var("R1_BENCH_HOME") else { return };
    for _ in 0..3 {
        let ix = Index::new(Path::new(&home));
        let t0 = Instant::now();
        let n = ix.load_all();
        let load = t0.elapsed();
        let t1 = Instant::now();
        for slug in ix.board_slugs() {
            ix.refresh(&slug);
        }
        eprintln!("{n} tickets: load {load:?}, re-check {:?}", t1.elapsed());
    }
}
