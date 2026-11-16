//! The Claude projects folder change feed (`src/core/changefeed.ts`), on FSEvents through `notify`: one recursive
//! watch on `<config>/projects` reporting new and growing transcripts (`<project>/<session>.jsonl`) and changes inside
//! a session's folder (`<project>/<session>/...`: subagents, workflows), so the watcher looks only at the sessions that
//! changed. While the watch isn't running (`live()` false) the watcher does full passes as before.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;

/// How often watchers fed by the change feed still look at everything, in case they missed a change.
pub const SAFETY_PASS_MS: f64 = 60_000.0;
/// The same for Done tickets: they change only through a ticket write or a session the feed reports.
pub const DONE_PASS_MS: f64 = 10.0 * 60_000.0;

/// A session's files changed: its transcript (`file` its path) or something in its folder (`file` None). `Unknown`:
/// something changed but the watch couldn't say what (do a full pass).
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Session { session_id: String, file: Option<PathBuf> },
    Unknown,
}

type Listener = Arc<dyn Fn(&Change) + Send + Sync>;

pub struct SessionFeed {
    root: PathBuf,
    /// The root as FSEvents reports it (symlinks resolved, e.g. /private/var for /var).
    real: PathBuf,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    live: AtomicBool,
    next: AtomicU64,
    listeners: Mutex<Vec<(u64, Listener)>>,
}

impl SessionFeed {
    pub fn new(root: &Path) -> Arc<Self> {
        Arc::new(SessionFeed {
            root: root.to_path_buf(),
            real: root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
            watcher: Mutex::new(None),
            live: AtomicBool::new(false),
            next: AtomicU64::new(1),
            listeners: Mutex::new(Vec::new()),
        })
    }

    /// The watch is running now.
    pub fn live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    /// Starts the watch; false when it can't (no projects folder yet): watchers poll.
    pub fn start(self: &Arc<Self>) -> bool {
        let mut slot = self.watcher.lock();
        if slot.is_some() {
            return true;
        }
        let weak = Arc::downgrade(self);
        let made = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Some(feed) = weak.upgrade() else { return };
            match res {
                Ok(ev) if ev.need_rescan() => feed.emit(&Change::Unknown),
                Ok(ev) => {
                    for p in &ev.paths {
                        feed.absolute(p);
                    }
                }
                Err(e) => {
                    eprintln!("session feed {e}");
                    feed.emit(&Change::Unknown);
                }
            }
        });
        let Ok(mut w) = made else { return false };
        if w.watch(&self.root, RecursiveMode::Recursive).is_err() {
            return false;
        }
        *slot = Some(w);
        self.live.store(true, Ordering::SeqCst);
        true
    }

    pub fn stop(&self) {
        self.watcher.lock().take();
        self.live.store(false, Ordering::SeqCst);
    }

    /// Calls `f` with every change until `unsubscribe` with the returned id. `f` runs on the watch's thread: keep it short.
    pub fn subscribe(&self, f: impl Fn(&Change) + Send + Sync + 'static) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        self.listeners.lock().push((id, Arc::new(f)));
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.listeners.lock().retain(|(i, _)| *i != id);
    }

    fn absolute(&self, p: &Path) {
        let rel = p.strip_prefix(&self.real).or_else(|_| p.strip_prefix(&self.root));
        if let Ok(rel) = rel {
            self.path(Some(rel));
        }
    }

    /// A path the watch reported, relative to the projects folder (None: it couldn't say).
    pub fn path(&self, rel: Option<&Path>) {
        let Some(rel) = rel else { return self.emit(&Change::Unknown) };
        let parts: Vec<String> = rel.components().filter_map(|c| match c {
            Component::Normal(s) => s.to_str().map(str::to_string),
            _ => None,
        }).collect();
        // A project folder itself: nothing in it to look at yet (its files come as their own events).
        if parts.len() < 2 {
            return;
        }
        let own = parts.len() == 2 && parts[1].ends_with(".jsonl");
        let session_id = if own { parts[1][..parts[1].len() - 6].to_string() } else { parts[1].clone() };
        if session_id.is_empty() {
            return;
        }
        let file = own.then(|| self.root.join(rel));
        self.emit(&Change::Session { session_id, file });
    }

    fn emit(&self, c: &Change) {
        let fns: Vec<Listener> = self.listeners.lock().iter().map(|(_, f)| f.clone()).collect();
        for f in fns {
            f(c);
        }
    }
}

impl Drop for SessionFeed {
    fn drop(&mut self) {
        self.watcher.get_mut().take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn names_the_session() {
        let feed = SessionFeed::new(Path::new("/x/projects"));
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let id = feed.subscribe(move |c| g.lock().push(c.clone()));
        feed.path(Some(Path::new("-p")));
        feed.path(Some(Path::new("-p/abc.jsonl")));
        feed.path(Some(Path::new("-p/abc/subagents/agent-1.jsonl")));
        feed.path(None);
        feed.unsubscribe(id);
        feed.path(Some(Path::new("-p/zzz.jsonl")));
        assert_eq!(*got.lock(), vec![
            Change::Session { session_id: "abc".into(), file: Some(PathBuf::from("/x/projects/-p/abc.jsonl")) },
            Change::Session { session_id: "abc".into(), file: None },
            Change::Unknown,
        ]);
    }

    #[test]
    fn watches_the_folder() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().join("projects");
        std::fs::create_dir_all(root.join("-p")).unwrap();
        let feed = SessionFeed::new(&root);
        assert!(feed.start());
        assert!(feed.live());
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        feed.subscribe(move |c| g.lock().push(c.clone()));
        std::thread::sleep(Duration::from_millis(300));
        std::fs::write(root.join("-p/s1.jsonl"), "{}\n").unwrap();
        let end = Instant::now() + Duration::from_secs(10);
        let want = Change::Session { session_id: "s1".into(), file: Some(root.join("-p/s1.jsonl")) };
        while Instant::now() < end && !got.lock().contains(&want) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(got.lock().contains(&want), "{:?}", got.lock());
        feed.stop();
        assert!(!feed.live());
    }
}
