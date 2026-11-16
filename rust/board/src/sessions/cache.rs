//! `SessionCache` (`src/runs/session-cache.ts`): parses transcripts lazily and only reads what a transcript gained since
//! the last read (a file that shrank or was replaced is parsed again from the start), keeps the 30 most recently used
//! parses (plus running ones), and keeps every session's summary in `<data>/session-summaries.json` so the first page
//! after a restart doesn't parse every transcript again.
//!
//! Every method here is blocking (stats, reads, parses): callers run them in `spawn_blocking`. The cache's shared state
//! is behind one short lock that is never held across a file read, a parse or a folder walk; a session's own parse has
//! its own lock, so two readers of the same transcript take turns while other sessions go on.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::feed::SessionFeed;
use super::files::scan_session_files;
use super::parser::{Parsed, SessionParser};
use super::subagents::{self, SubagentCache};
use super::tooldetail;
use super::workflows::{self, WorkflowCache};
use super::{Obj, js};

/// How many parsed sessions stay in memory, most recently used first (running sessions are kept too).
const MAX_PARSED: usize = 30;
/// A session whose transcript changed this recently counts as running and keeps its parse.
const ACTIVE_MS: f64 = 10.0 * 60_000.0;
/// How much of a transcript one read step takes.
const CHUNK: u64 = 1 << 20;
/// A session file missing this long is searched for at most every MISSING_RETRY_MS.
const MISSING_GRACE_MS: f64 = 5.0 * 60_000.0;
const MISSING_RETRY_MS: f64 = 60_000.0;
/// How long one scan of the projects folder answers lookups; with the feed live it is only a safety net.
const INDEX_MS: f64 = 1_000.0;
const FED_INDEX_MS: f64 = 60_000.0;
/// How soon new summaries are written to the summaries file (rewritten whole: at most this often, and at stop).
pub const SUMMARY_FLUSH_MS: f64 = 30_000.0;
/// A saved summary nobody used this many days is dropped.
const SUMMARY_KEEP_DAYS: f64 = 30.0;
const DAY_MS: f64 = 86_400_000.0;
/// The first part of the summaries' tag (Bun's SUMMARY_FORMAT): summaries of another tag with the same number are shown
/// until made again.
const SUMMARY_FORMAT: u32 = 2;
pub const SUMMARIES_FILE: &str = "session-summaries.json";

/// The code that makes summaries: its hash goes into the tag, so a fix to the parsing applies at the next start while
/// summaries made by the same code are kept (Bun hashes its own source files the same way).
const SOURCES: [&str; 9] = [
    include_str!("parser.rs"),
    include_str!("markers.rs"),
    include_str!("cards.rs"),
    include_str!("text.rs"),
    include_str!("chat_cache.rs"),
    include_str!("subagents.rs"),
    include_str!("workflows.rs"),
    include_str!("cache.rs"),
    include_str!("js.rs"),
];

/// The summaries' tag: `2:rust:<hash of the parsing code>`. Bun's tags differ, so each side shows the other's
/// summaries as stale (still right for an unchanged transcript) until it has made them again.
pub fn summary_tag() -> String {
    // FNV-1a, 64 bits: stable across builds and platforms.
    let mut h: u64 = 0xcbf29ce484222325;
    for s in SOURCES {
        for b in s.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    format!("{SUMMARY_FORMAT}:rust:{h:x}")
}

fn same_format(tag: Option<&Value>) -> bool {
    tag.and_then(Value::as_str).is_some_and(|t| t.starts_with(&format!("{SUMMARY_FORMAT}:")))
}

/// JS `stat.mtimeMs`.
pub fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.mtime() as f64 * 1e3 + m.mtime_nsec() as f64 / 1e6
}

/// `${size}:${mtimeMs}` as Bun writes it.
fn file_version(m: &std::fs::Metadata) -> String {
    format!("{}:{}", m.size(), ckanban_core::jsnum::js_string(mtime_ms(m)))
}

struct Item {
    file: PathBuf,
    ino: u64,
    size: u64,
    mtime_ms: f64,
    offset: u64,
    parser: SessionParser,
    agent_key: String,
    merged_from: Option<Arc<Parsed>>,
    merged: Option<Arc<Parsed>>,
}

impl Item {
    fn new(file: &Path, ino: u64) -> Self {
        Item { file: file.to_path_buf(), ino, size: 0, mtime_ms: 0.0, offset: 0, parser: SessionParser::new(), agent_key: String::new(), merged_from: None, merged: None }
    }
}

#[derive(Default)]
struct Summaries {
    tag: String,
    items: Obj,
    stale: Obj,
}

#[derive(Default)]
struct State {
    items: HashMap<String, (u64, Arc<Mutex<Item>>)>,
    use_seq: u64,
    files: HashMap<String, PathBuf>,
    missing: HashMap<String, (f64, f64)>,
    index: Option<(f64, HashMap<String, PathBuf>)>,
    /// Files the feed reported while a background scan runs.
    scan_adds: Option<HashMap<String, PathBuf>>,
    summaries: Option<Summaries>,
    dirty: bool,
    blank: Option<Obj>,
    /// When the summaries file is due to be written (a timer's pass writes it then).
    flush_at: Option<f64>,
    write_seq: u64,
}

pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type TextMask = Arc<dyn Fn(&str) -> String + Send + Sync>;

pub struct SessionCache {
    projects: PathBuf,
    summary_file: Option<PathBuf>,
    now: Clock,
    /// `maskSaved`: a saved key in a stored preview is hidden.
    mask: TextMask,
    agents: SubagentCache,
    workflows: WorkflowCache,
    state: Mutex<State>,
    feed: Mutex<Option<Arc<SessionFeed>>>,
    /// One summaries write at a time.
    writing: Mutex<()>,
}

impl SessionCache {
    pub fn new(projects: &Path, summary_file: Option<PathBuf>, now: Clock, mask: TextMask) -> Arc<Self> {
        Arc::new(SessionCache {
            projects: projects.to_path_buf(),
            summary_file,
            now,
            mask,
            agents: SubagentCache::new(),
            workflows: WorkflowCache::new(),
            state: Mutex::new(State::default()),
            feed: Mutex::new(None),
            writing: Mutex::new(()),
        })
    }

    fn today(&self) -> f64 {
        ((self.now)() / DAY_MS).floor()
    }

    fn feed_live(&self) -> bool {
        self.feed.lock().as_ref().is_some_and(|f| f.live())
    }

    /// Loads the summaries file into `st` once (a few MB on a big board; read under the lock only the first time).
    fn stored<'a>(&self, st: &'a mut State) -> &'a mut Summaries {
        if st.summaries.is_none() {
            let tag = summary_tag();
            let mut s = Summaries { tag: tag.clone(), ..Default::default() };
            if let Some(file) = &self.summary_file {
                let v: Value = std::fs::read(file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
                if let Some(items) = v.get("items").and_then(Value::as_object)
                    && same_format(v.get("tag"))
                {
                    let older = v.get("stale").and_then(Value::as_object).cloned().unwrap_or_default();
                    if v.get("tag").and_then(Value::as_str) == Some(tag.as_str()) {
                        s.items = items.clone();
                        s.stale = older;
                    } else {
                        s.stale = older;
                        for (k, e) in items {
                            s.stale.insert(k.clone(), e.clone());
                        }
                        st.dirty = true;
                    }
                }
                let today = self.today();
                for e in s.items.values_mut() {
                    if let Some(o) = e.as_object_mut()
                        && !o.contains_key("u")
                    {
                        o.insert("u".into(), js::num(today));
                        st.dirty = true;
                    }
                }
            }
            st.summaries = Some(s);
        }
        st.summaries.as_mut().unwrap_or_else(|| unreachable!())
    }

    fn blank(&self, st: &mut State) -> Obj {
        if st.blank.is_none() {
            let p = SessionParser::new().result();
            st.blank = Some(self.summary_of(&p));
        }
        st.blank.clone().unwrap_or_default()
    }

    /// An older summary of this session that still matches its transcript (version v), to show until made again.
    fn stale_summary(&self, st: &mut State, id: &str, v: Option<&str>) -> Option<Obj> {
        let v = v?;
        let old = self.stored(st).stale.get(id)?.clone();
        if old.get("v").and_then(Value::as_str) != Some(v) {
            return None;
        }
        let mut out = self.blank(st);
        if let Some(s) = old.get("s").and_then(Value::as_object) {
            for (k, x) in s {
                out.insert(k.clone(), x.clone());
            }
        }
        Some(out)
    }

    fn used(&self, st: &mut State, id: &str) {
        let today = self.today();
        let items = &mut self.stored(st).items;
        if let Some(o) = items.get_mut(id).and_then(Value::as_object_mut)
            && o.get("u").and_then(Value::as_f64) != Some(today)
        {
            o.insert("u".into(), js::num(today));
            st.dirty = true;
        }
    }

    fn store_summary(&self, id: &str, v: &str, s: &Obj) {
        if self.summary_file.is_none() {
            return;
        }
        let today = self.today();
        let now = (self.now)();
        let mut st = self.state.lock();
        let stored = self.stored(&mut st);
        stored.items.insert(id.to_string(), json!({"v": v, "s": Value::Object(s.clone()), "u": js::num(today)}));
        stored.stale.remove(id);
        st.dirty = true;
        st.flush_at.get_or_insert(now + SUMMARY_FLUSH_MS);
    }

    /// Writes the summaries file when it is due (a timer calls this every pass).
    pub fn flush_if_due(&self) {
        let due = self.state.lock().flush_at.is_some_and(|t| (self.now)() >= t);
        if due {
            self.flush_summaries();
        }
    }

    /// Writes the summaries file now, if anything in it changed (after dropping old and orphaned summaries).
    pub fn flush_summaries(&self) {
        let Some(file) = self.summary_file.clone() else { return };
        let _one = self.writing.lock();
        let (text, seq) = {
            let mut st = self.state.lock();
            st.flush_at = None;
            if st.summaries.is_none() {
                return;
            }
            self.prune(&mut st);
            if !st.dirty {
                return;
            }
            st.dirty = false;
            st.write_seq += 1;
            let s = st.summaries.as_ref().unwrap_or_else(|| unreachable!());
            let mut o = Obj::new();
            o.insert("tag".into(), Value::String(s.tag.clone()));
            o.insert("items".into(), Value::Object(s.items.clone()));
            if !s.stale.is_empty() {
                o.insert("stale".into(), Value::Object(s.stale.clone()));
            }
            (serde_json::to_string(&Value::Object(o)).unwrap_or_default(), st.write_seq)
        };
        let _ = seq;
        if let Err(e) = ckanban_core::atomic::atomic_write(&file, text) {
            eprintln!("session summary cache {e}");
            self.state.lock().dirty = true;
        }
    }

    /// Drops saved summaries of sessions whose transcript is gone (from the last scan) and those unused for 30 days.
    fn prune(&self, st: &mut State) {
        let oldest = self.today() - SUMMARY_KEEP_DAYS;
        let scan: Option<std::collections::HashSet<String>> =
            st.index.as_ref().filter(|(_, f)| !f.is_empty()).map(|(_, f)| f.keys().cloned().collect());
        let files: std::collections::HashSet<String> = st.files.keys().cloned().collect();
        let items = &mut self.stored(st).items;
        let before = items.len();
        items.retain(|id, e| {
            let u = e.get("u").and_then(Value::as_f64).unwrap_or(oldest);
            !(u < oldest || scan.as_ref().is_some_and(|s| !s.contains(id) && !files.contains(id)))
        });
        if items.len() != before {
            st.dirty = true;
        }
    }

    /// Keeps the scan of the projects folder current from the feed's new transcripts.
    pub fn follow(self: &Arc<Self>, feed: &Arc<SessionFeed>) -> u64 {
        *self.feed.lock() = Some(feed.clone());
        let weak = Arc::downgrade(self);
        feed.subscribe(move |c| {
            let Some(me) = weak.upgrade() else { return };
            if let super::feed::Change::Session { session_id, file: Some(f) } = c {
                let mut st = me.state.lock();
                if let Some((_, files)) = st.index.as_mut() {
                    files.insert(session_id.clone(), f.clone());
                }
                if let Some(adds) = st.scan_adds.as_mut() {
                    adds.insert(session_id.clone(), f.clone());
                }
                st.missing.remove(session_id);
            }
        })
    }

    /// The first scan of the projects folder (a folder walk: blocking, outside the lock).
    pub fn scanned(&self) {
        if self.state.lock().index.is_some() {
            return;
        }
        let at = (self.now)();
        self.state.lock().scan_adds = Some(HashMap::new());
        let mut files = scan_session_files(&self.projects);
        let mut st = self.state.lock();
        for (id, f) in st.scan_adds.take().unwrap_or_default() {
            files.insert(id, f);
        }
        if st.index.is_none() {
            st.index = Some((at, files));
        }
    }

    /// A fresh index from a scan on its own thread (one at a time); the old index answers meanwhile.
    fn rescan(self: &Arc<Self>) {
        {
            let mut st = self.state.lock();
            if st.scan_adds.is_some() {
                return;
            }
            st.scan_adds = Some(HashMap::new());
        }
        let me = self.clone();
        std::thread::spawn(move || {
            let at = (me.now)();
            let mut files = scan_session_files(&me.projects);
            let mut st = me.state.lock();
            for (id, f) in st.scan_adds.take().unwrap_or_default() {
                files.insert(id, f);
            }
            st.index = Some((at, files));
        });
    }

    fn locate(self: &Arc<Self>, id: &str) -> Option<PathBuf> {
        let known = self.state.lock().files.get(id).cloned();
        if let Some(k) = known {
            if std::fs::metadata(&k).is_ok() {
                return Some(k);
            }
            let mut st = self.state.lock();
            st.files.remove(id);
            if let Some((_, files)) = st.index.as_mut()
                && files.get(id) == Some(&k)
            {
                files.remove(id);
            }
        }
        let now = (self.now)();
        let live = self.feed_live();
        let (miss, need_scan, background) = {
            let st = self.state.lock();
            let miss = st.missing.get(id).copied();
            if let Some((since, at)) = miss
                && now - since >= MISSING_GRACE_MS
                && now - at < MISSING_RETRY_MS
            {
                return None;
            }
            let index_ms = if live { FED_INDEX_MS } else { INDEX_MS };
            let stale = match &st.index {
                None => true,
                Some((at, _)) => now - at >= index_ms || now < *at,
            };
            (miss, stale, stale && st.index.is_some() && live)
        };
        if need_scan {
            if background {
                self.rescan();
            } else {
                let files = scan_session_files(&self.projects);
                self.state.lock().index = Some((now, files));
            }
        }
        let mut st = self.state.lock();
        let f = st.index.as_ref().and_then(|(_, files)| files.get(id).cloned());
        match &f {
            Some(f) => {
                st.files.insert(id.to_string(), f.clone());
                st.missing.remove(id);
            }
            None => {
                st.missing.insert(id.to_string(), (miss.map(|m| m.0).unwrap_or(now), now));
            }
        }
        f
    }

    /// The session's transcript file, wherever it is under the projects folder.
    pub fn file(self: &Arc<Self>, id: &str) -> Option<PathBuf> {
        self.locate(id)
    }

    /// Cheap change marker (subagent and workflow files included); None when the session file doesn't exist.
    pub fn version(self: &Arc<Self>, id: &str) -> Option<String> {
        let f = self.locate(id)?;
        let v = file_version(&std::fs::metadata(&f).ok()?);
        let agents = self.agents.version(&f);
        let wf = self.workflows.version(&f);
        Some(format!("{v}{}{}", if agents.is_empty() { String::new() } else { format!("|{agents}") }, if wf.is_empty() { String::new() } else { format!("|w{wf}") }))
    }

    /// Parses what the transcript gained since the last call (at most `max` bytes). A half-written last line waits; a
    /// file that shrank or was replaced is parsed from the start.
    fn catch_up(self: &Arc<Self>, id: &str, f: &Path, max: u64) -> Option<Arc<Mutex<Item>>> {
        let meta = std::fs::metadata(f).ok()?;
        let (size, mtime, ino) = (meta.size(), mtime_ms(&meta), meta.ino());
        let item = {
            let mut st = self.state.lock();
            st.use_seq += 1;
            let seq = st.use_seq;
            let item = match st.items.get_mut(id) {
                Some((s, it)) => {
                    *s = seq;
                    it.clone()
                }
                None => {
                    let it = Arc::new(Mutex::new(Item::new(f, ino)));
                    st.items.insert(id.to_string(), (seq, it.clone()));
                    it
                }
            };
            if st.items.len() > MAX_PARSED {
                let recent = (self.now)() - ACTIVE_MS;
                let mut by_use: Vec<(u64, String)> = st.items.iter().map(|(k, (s, _))| (*s, k.clone())).collect();
                by_use.sort();
                for (_, k) in by_use {
                    if st.items.len() <= MAX_PARSED {
                        break;
                    }
                    if k == id {
                        continue;
                    }
                    // One being read now (locked) stays; so does one written to lately or still being read in steps.
                    let drop = st.items.get(&k).and_then(|(_, it)| it.try_lock().map(|v| v.mtime_ms < recent && v.offset >= v.size)).unwrap_or(false);
                    if drop {
                        st.items.remove(&k);
                    }
                }
            }
            item
        };
        let mut it = item.lock();
        let rewritten = it.file != f || it.ino != ino || size < it.offset || (size == it.size && mtime != it.mtime_ms && it.offset > 0);
        if rewritten {
            *it = Item::new(f, ino);
        }
        it.size = size;
        it.mtime_ms = mtime;
        let n = size.saturating_sub(it.offset).min(max);
        if n == 0 {
            drop(it);
            return Some(item);
        }
        let read = (|| -> std::io::Result<()> {
            let mut file = std::fs::File::open(f)?;
            file.seek(SeekFrom::Start(it.offset))?;
            let mut buf = vec![0u8; CHUNK.min(n) as usize];
            let mut left = n;
            while left > 0 {
                let want = CHUNK.min(left) as usize;
                let got = file.read(&mut buf[..want])?;
                if got == 0 {
                    // Shorter than it said (cut while reading): look again next time.
                    it.size = it.offset;
                    break;
                }
                it.parser.feed(&buf[..got]);
                it.offset += got as u64;
                left -= got as u64;
            }
            Ok(())
        })();
        drop(it);
        if read.is_err() {
            self.state.lock().items.remove(id);
            return None;
        }
        Some(item)
    }

    /// The session's own transcript parsed, without its subagents' transcripts.
    fn parsed(self: &Arc<Self>, id: &str) -> Option<Arc<Parsed>> {
        let f = self.locate(id)?;
        let item = self.catch_up(id, &f, u64::MAX)?;
        let r = item.lock().parser.result();
        Some(r)
    }

    /// The session parsed, with its subagents' transcripts and workflow runs merged in.
    pub fn get(self: &Arc<Self>, id: &str) -> Option<Arc<Parsed>> {
        let f = self.locate(id)?;
        let item = self.catch_up(id, &f, u64::MAX)?;
        let mut it = item.lock();
        let parsed = it.parser.result();
        let has_agents = parsed.has("agent");
        let has_workflows = parsed.has("workflow");
        if !has_agents && !has_workflows {
            return Some(parsed);
        }
        let key = format!(
            "{}|{}",
            if has_agents { self.agents.version(&f) } else { String::new() },
            if has_workflows { self.workflows.version(&f) } else { String::new() }
        );
        let same = it.merged_from.as_ref().is_some_and(|m| Arc::ptr_eq(m, &parsed));
        if it.agent_key != key || !same || it.merged.is_none() {
            let transcripts = if has_agents { self.agents.load(&f) } else { HashMap::new() };
            let entries: Vec<Value> = parsed
                .entries
                .iter()
                .map(|e| {
                    let mut e = e.clone();
                    let Some(o) = e.as_object_mut() else { return e };
                    if let Some(a) = o.get("agent").and_then(Value::as_object) {
                        let id = a.get("toolUseId").and_then(Value::as_str).unwrap_or("");
                        let merged = subagents::with_transcript(a, transcripts.get(id));
                        o.insert("agent".into(), Value::Object(merged));
                    } else if let Some(w) = o.get("workflow").and_then(Value::as_object) {
                        let run = w.get("runId").and_then(Value::as_str).filter(|r| !r.is_empty()).and_then(|r| self.workflows.load(&f, r));
                        let merged = workflows::with_run(w, run.as_ref(), None);
                        o.insert("workflow".into(), Value::Object(merged));
                    }
                    e
                })
                .collect();
            let mut m = (*parsed).clone();
            m.entries = Arc::new(entries);
            it.merged = Some(Arc::new(m));
            it.merged_from = Some(parsed);
            it.agent_key = key;
        }
        it.merged.clone()
    }

    /// Reads what the transcript gained, unless its saved summary still holds (with `parse`: always, for get()).
    pub fn read_in(self: &Arc<Self>, id: &str, parse: bool) {
        let Some(f) = self.locate(id) else { return };
        if self.summary_file.is_some() && !parse {
            let v = self.version(id);
            let mut st = self.state.lock();
            let saved = v.as_deref().is_some_and(|v| self.stored(&mut st).items.get(id).and_then(|e| e.get("v")).and_then(Value::as_str) == Some(v));
            if saved || self.stale_summary(&mut st, id, v.as_deref()).is_some() {
                return;
            }
        }
        self.read_all(id, &f);
    }

    fn read_all(self: &Arc<Self>, id: &str, f: &Path) {
        loop {
            let Some(item) = self.catch_up(id, f, CHUNK) else { break };
            let it = item.lock();
            if it.offset >= it.size {
                break;
            }
        }
    }

    /// Readies these sessions' summaries (`warm`): first those with nothing to show (`ready` is called after them), then
    /// the ones still shown from older code are made again and `changed` is called for each that came out different.
    pub fn warm(self: &Arc<Self>, ids: &[String], ready: impl FnOnce(), changed: impl Fn(&str)) {
        self.scanned();
        for id in ids {
            let Some(f) = self.locate(id) else { continue };
            let v = if self.summary_file.is_some() { self.version(id) } else { None };
            {
                let mut st = self.state.lock();
                let saved = v.as_deref().is_some_and(|v| self.stored(&mut st).items.get(id).and_then(|e| e.get("v")).and_then(Value::as_str) == Some(v));
                if saved {
                    self.used(&mut st, id);
                    continue;
                }
                if self.stale_summary(&mut st, id, v.as_deref()).is_some() {
                    continue;
                }
            }
            self.read_all(id, &f);
            self.summary(id);
        }
        ready();
        if self.summary_file.is_none() {
            return;
        }
        for id in ids {
            if !self.stored(&mut self.state.lock()).stale.contains_key(id) {
                continue;
            }
            let Some(f) = self.locate(id) else { continue };
            let v = self.version(id);
            let Some(old) = self.stale_summary(&mut self.state.lock(), id, v.as_deref()) else { continue };
            self.read_all(id, &f);
            if let Some(Value::Object(mut now)) = self.fresh(id) {
                now.remove("updatedAt");
                if Value::Object(now) != Value::Object(old) {
                    changed(id);
                }
            }
        }
        let now = (self.now)();
        let mut st = self.state.lock();
        let stored = self.stored(&mut st);
        if !stored.stale.is_empty() {
            stored.stale.clear();
            st.dirty = true;
            st.flush_at.get_or_insert(now + SUMMARY_FLUSH_MS);
        }
    }

    /// A workflow's files (journal, agent transcripts, summary), or None when the session or run is unknown.
    pub fn workflow_run(self: &Arc<Self>, id: &str, run_id: &str) -> Option<Value> {
        let f = self.locate(id)?;
        self.workflows.load(&f, run_id)
    }

    /// One tool call in full (input and output), from the session or one of its subagents' transcripts.
    pub fn tool_detail(self: &Arc<Self>, id: &str, tool_use_id: &str) -> Option<Value> {
        let f = self.locate(id)?;
        let mut files = vec![f.clone()];
        files.extend(subagents::subagent_files(&f));
        tooldetail::find_tool_detail_in(&files, tool_use_id)
    }

    fn updated_at(f: &Path) -> String {
        std::fs::metadata(f).map(|m| ckanban_core::time::iso(mtime_ms(&m).trunc())).unwrap_or_default()
    }

    /// `SessionSummary` (what the card and the ticket header need), from the saved summary when the transcript hasn't
    /// changed since it was made.
    pub fn summary(self: &Arc<Self>, id: &str) -> Option<Value> {
        let f = self.locate(id)?;
        let updated = Self::updated_at(&f);
        let v = if self.summary_file.is_some() { self.version(id) } else { None };
        {
            let mut st = self.state.lock();
            let hit = v.as_deref().and_then(|v| {
                let e = self.stored(&mut st).items.get(id)?;
                (e.get("v").and_then(Value::as_str) == Some(v)).then(|| e.get("s").and_then(Value::as_object).cloned().unwrap_or_default())
            });
            if let Some(mut s) = hit {
                self.used(&mut st, id);
                s.insert("updatedAt".into(), Value::String(updated));
                return Some(Value::Object(s));
            }
            if let Some(mut old) = self.stale_summary(&mut st, id, v.as_deref()) {
                old.insert("updatedAt".into(), Value::String(updated));
                return Some(Value::Object(old));
            }
        }
        self.fresh(id)
    }

    /// The summary read from the transcript now (and saved), whatever older summary there is.
    fn fresh(self: &Arc<Self>, id: &str) -> Option<Value> {
        let f = self.locate(id)?;
        let p = self.parsed(id)?;
        let updated = Self::updated_at(&f);
        let v = if self.summary_file.is_some() { self.version(id) } else { None };
        let s = self.summary_of(&p);
        if let Some(v) = v {
            self.store_summary(id, &v, &s);
        }
        let mut out = s;
        out.insert("updatedAt".into(), Value::String(updated));
        Some(Value::Object(out))
    }

    fn summary_of(&self, p: &Parsed) -> Obj {
        let mut o = Obj::new();
        o.insert("title".into(), p.title.clone());
        let mut last = p.last_message.clone();
        if self.summary_file.is_some()
            && let Some(m) = last.as_object_mut()
            && let Some(t) = m.get("text").and_then(Value::as_str)
        {
            let masked = (self.mask)(t);
            m.insert("text".into(), Value::String(masked));
        }
        o.insert("lastMessage".into(), last);
        o.insert("artifacts".into(), Value::Array(p.artifacts.clone()));
        let pending = &p.pending;
        let get = |k: &str| pending.get(k).cloned().unwrap_or(Value::Null);
        o.insert("openQuestions".into(), get("openQuestions"));
        o.insert("openForm".into(), get("openForm"));
        for k in ["openAsk", "openFormId"] {
            if let Some(v) = pending.get(k) {
                o.insert(k.into(), v.clone());
            }
        }
        for k in ["pendingProposal", "pendingTeammates", "pendingSquads", "pendingAutomations"] {
            o.insert(k.into(), get(k));
        }
        for k in ["pendingKeys", "pendingScheduleDeletes", "pendingHelperRules"] {
            if pending.get(k).and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
                o.insert(k.into(), get(k));
            }
        }
        o.insert("cache".into(), p.cache.clone());
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(v: Value) -> String {
        format!("{}\n", serde_json::to_string(&v).unwrap())
    }

    fn user(uuid: &str, text: &str) -> String {
        line(json!({"type": "user", "uuid": uuid, "timestamp": "2026-01-01T00:00:00.000Z", "message": {"role": "user", "content": text}}))
    }

    fn reply(uuid: &str, text: &str) -> String {
        line(json!({"type": "assistant", "uuid": uuid, "timestamp": "2026-01-01T00:00:01.000Z", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}))
    }

    fn setup() -> (tempfile::TempDir, PathBuf, Arc<SessionCache>) {
        let t = tempfile::tempdir().unwrap();
        let projects = t.path().join("projects");
        std::fs::create_dir_all(projects.join("-p")).unwrap();
        let cache = SessionCache::new(&projects, Some(t.path().join(SUMMARIES_FILE)), Arc::new(ckanban_core::time::now_ms), Arc::new(|s: &str| s.replace("sekrit", "***")));
        (t, projects, cache)
    }

    #[test]
    fn reads_only_what_was_added() {
        let (_t, projects, cache) = setup();
        let f = projects.join("-p/s1.jsonl");
        std::fs::write(&f, user("u1", "hello")).unwrap();
        let p = cache.get("s1").unwrap();
        assert_eq!(p.entries.len(), 1);
        // Same file, nothing new: the same parse comes back.
        assert!(Arc::ptr_eq(&p, &cache.get("s1").unwrap()));
        // A half-written line waits for its end.
        let mut h = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        let r = reply("a1", "the sekrit answer");
        h.write_all(&r.as_bytes()[..10]).unwrap();
        assert_eq!(cache.get("s1").unwrap().entries.len(), 1);
        h.write_all(&r.as_bytes()[10..]).unwrap();
        let p = cache.get("s1").unwrap();
        assert_eq!(p.entries.len(), 2);
        let s = cache.summary("s1").unwrap();
        assert_eq!(s["lastMessage"]["text"], json!("the *** answer"));
        assert!(s["updatedAt"].as_str().unwrap().ends_with('Z'));
        // Replaced by a shorter file: parsed again from the start.
        std::fs::write(&f, user("u9", "again")).unwrap();
        let p = cache.get("s1").unwrap();
        assert_eq!(p.entries.len(), 1);
        assert_eq!(p.entries[0]["uuid"], json!("u9"));
        assert!(cache.get("nope").is_none());
        assert!(cache.version("nope").is_none());
    }

    #[test]
    fn keeps_summaries_on_disk() {
        let (t, projects, cache) = setup();
        let f = projects.join("-p/s1.jsonl");
        std::fs::write(&f, format!("{}{}", user("u1", "hi"), reply("a1", "done"))).unwrap();
        let s = cache.summary("s1").unwrap();
        cache.flush_summaries();
        let saved: Value = serde_json::from_slice(&std::fs::read(t.path().join(SUMMARIES_FILE)).unwrap()).unwrap();
        assert_eq!(saved["tag"], json!(summary_tag()));
        assert_eq!(saved["items"]["s1"]["v"], json!(cache.version("s1").unwrap()));
        // A new cache (a restart) answers from the file without parsing the transcript.
        let again = SessionCache::new(&projects, Some(t.path().join(SUMMARIES_FILE)), Arc::new(ckanban_core::time::now_ms), Arc::new(|s: &str| s.to_string()));
        assert_eq!(again.summary("s1").unwrap(), s);
        assert!(again.state.lock().items.is_empty());
        // Summaries from other code (Bun's tag) are shown while the transcript is unchanged, then made again.
        let mut other = saved.clone();
        other["tag"] = json!("2:0.18.1:abc");
        other["items"]["s1"]["s"]["title"] = json!("from bun");
        std::fs::write(t.path().join(SUMMARIES_FILE), serde_json::to_string(&other).unwrap()).unwrap();
        let third = SessionCache::new(&projects, Some(t.path().join(SUMMARIES_FILE)), Arc::new(ckanban_core::time::now_ms), Arc::new(|s: &str| s.to_string()));
        assert_eq!(third.summary("s1").unwrap()["title"], json!("from bun"));
        let changed = Mutex::new(Vec::new());
        let ready = std::sync::atomic::AtomicBool::new(false);
        third.warm(&["s1".to_string()], || ready.store(true, std::sync::atomic::Ordering::SeqCst), |id| changed.lock().push(id.to_string()));
        assert!(ready.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(*changed.lock(), vec!["s1".to_string()]);
        assert_eq!(third.summary("s1").unwrap()["title"], Value::Null);
    }

    #[test]
    fn tags_differ_from_buns() {
        assert!(summary_tag().starts_with("2:rust:"));
        assert!(same_format(Some(&json!("2:0.18.1:x"))));
        assert!(!same_format(Some(&json!("1:x"))));
    }
}
