//! `Sessions`: the R5 service in board mode. Holds the session cache, the projects folder change feed, the watcher and
//! what the routes read tickets from; fills `api::SessionInfo` for the other modules.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;

use super::cache::{SUMMARIES_FILE, SessionCache, TextMask};
use super::feed::SessionFeed;
use super::files;
use super::ticket_files::{FileTickets, TicketSource};
use super::watcher::{Emit, Watcher, session_event};
use crate::api::{RunControl, SessionInfo, StandIn};
use crate::core::Core;

/// How often the watcher looks (Bun's 2 s).
pub const WATCH_EVERY: Duration = Duration::from_secs(2);

pub struct Sessions {
    /// Claude's projects folder (`<config>/projects`).
    pub projects: std::path::PathBuf,
    pub cache: Arc<SessionCache>,
    pub tickets: Arc<dyn TicketSource>,
    pub feed: Arc<SessionFeed>,
    /// Who runs what (R7a); "nothing running" until the run loop lands.
    pub runs: Mutex<Arc<dyn RunControl>>,
    watcher: Mutex<Option<Arc<Watcher>>>,
}

impl Sessions {
    /// The service for the data folder `root`, with Claude's projects folder from the environment (CLAUDE_CONFIG_DIR).
    pub fn new(root: &Path, mask: TextMask) -> Arc<Self> {
        Self::with(root, &files::projects_dir(None), mask)
    }

    pub fn with(root: &Path, projects: &Path, mask: TextMask) -> Arc<Self> {
        let cache = SessionCache::new(projects, Some(root.join(SUMMARIES_FILE)), Arc::new(ckanban_core::time::now_ms), mask);
        let feed = SessionFeed::new(projects);
        Arc::new(Sessions {
            projects: projects.to_path_buf(),
            cache,
            tickets: FileTickets::new(ckanban_core::DataDir::new(root)),
            feed,
            runs: Mutex::new(Arc::new(StandIn)),
            watcher: Mutex::new(None),
        })
    }

    pub fn runs(&self) -> Arc<dyn RunControl> {
        self.runs.lock().clone()
    }

    /// A ticket was written: the watcher looks at its session in the next pass.
    pub fn ticket_changed(&self, slug: &str, id: &str) {
        if let Some(w) = self.watcher.lock().as_ref() {
            w.ticket_changed(slug, id);
        }
    }

    /// Starts the change feed and the watcher (`session.updated` on the core's bus); both stop with the core, and the
    /// summaries file is written then.
    pub fn start(self: &Arc<Self>, core: &Arc<Core>) {
        *self.runs.lock() = core.services.runs.clone();
        self.cache.follow(&self.feed);
        if !self.feed.start() {
            eprintln!("[board] session feed: can't watch Claude's projects folder; looking at every ticket every 2 s");
        }
        let bus = core.bus.clone();
        let emit: Emit = Arc::new(move |slug, id, s| bus.emit_json(session_event(slug, id, s)));
        let w = Watcher::new(self.cache.clone(), self.tickets.clone(), Some(self.feed.clone()), emit, Arc::new(ckanban_core::time::now_ms));
        *self.watcher.lock() = Some(w.clone());
        let task = tokio::spawn(async move {
            let mut every = tokio::time::interval(WATCH_EVERY);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                every.tick().await;
                let w = w.clone();
                // One tick at a time: the next waits until this one's pass is done.
                if tokio::task::spawn_blocking(move || w.tick()).await.is_err() {
                    eprintln!("[board] session watcher: a pass failed");
                }
            }
        });
        let me = self.clone();
        core.on_stop("session watcher", move || {
            task.abort();
            me.feed.stop();
            me.cache.flush_summaries();
        });
    }
}

impl SessionInfo for Sessions {
    /// The summary the watcher last made or announced (no file read here: callers may be on the async runtime).
    fn summary(&self, session_id: &str) -> Option<Value> {
        let w = self.watcher.lock().clone()?;
        w.known.lock().get(session_id).map(|(_, s)| s.clone())
    }

    fn summary_now(&self, session_id: &str) -> Option<Value> {
        self.summary(session_id).or_else(|| self.cache.summary(session_id))
    }

    fn version(&self, session_id: &str) -> Option<String> {
        let w = self.watcher.lock().clone()?;
        w.known.lock().get(session_id).map(|(v, _)| v.clone())
    }

    fn refresh(&self, slug: &str, id: &str, session_id: &str) {
        if let Some(w) = self.watcher.lock().clone() {
            w.poll_one(slug, id, session_id, true);
        }
    }

    /// The parsed entries. Reads and parses the transcript: call it from a blocking thread.
    fn entries(&self, session_id: &str) -> Vec<Value> {
        self.cache.get(session_id).map(|p| (*p.entries).clone()).unwrap_or_default()
    }
}
