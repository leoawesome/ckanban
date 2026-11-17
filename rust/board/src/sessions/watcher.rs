//! The session watcher (`startSessionWatcher`, `pollSessionsSliced`, `primeSessions` in `src/runs/session-cache.ts`):
//! announces tickets whose session changed (`session.updated` with the session's summary). With the change feed live,
//! a pass looks only at the tickets written meanwhile and the sessions the feed reported, plus a full pass every
//! minute for anything missed (Done tickets only every 10 minutes); without it every pass is a full one. The first pass
//! after a start only takes stock (summaries readied, versions noted) and announces nothing, except a ticket whose
//! summary from older code was shown meanwhile and came out different.
//!
//! Passes are blocking work (stats, transcript reads): `tick()` runs on a blocking thread, one full pass and one
//! changed-sessions pass at a time, and never holds the watcher's lock across a read.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::cache::{Clock, SessionCache};
use super::feed::{Change, DONE_PASS_MS, SAFETY_PASS_MS, SessionFeed};
use super::ticket_files::{TicketSource, session_id};

/// What a session change is announced with: `(board, ticket id, summary)`.
pub type Emit = Arc<dyn Fn(&str, &str, Value) + Send + Sync>;

#[derive(Default)]
struct Pending {
    /// Tickets written since the last pass ("slug/id") and sessions the feed reported.
    tickets: HashSet<String>,
    sessions: HashSet<String>,
    /// The feed couldn't say what changed: the next pass is a full one.
    unknown: bool,
}

#[derive(Default)]
struct Passes {
    primed: bool,
    last_full: f64,
    last_done: f64,
}

pub struct Watcher {
    cache: Arc<SessionCache>,
    tickets: Arc<dyn TicketSource>,
    feed: Option<Arc<SessionFeed>>,
    emit: Emit,
    now: Clock,
    /// "slug/id" -> "sessionId:version" when last looked at.
    state: Mutex<HashMap<String, String>>,
    /// Ticket keys by session id (from the last full pass and the passes since).
    owners: Mutex<HashMap<String, HashSet<String>>>,
    pending: Mutex<Pending>,
    passes: Mutex<Passes>,
    full_running: AtomicBool,
    changed_running: AtomicBool,
    /// The last summary announced or readied per session (what `SessionInfo::summary` answers without a read).
    pub known: Mutex<HashMap<String, (String, Value)>>,
}

impl Watcher {
    pub fn new(cache: Arc<SessionCache>, tickets: Arc<dyn TicketSource>, feed: Option<Arc<SessionFeed>>, emit: Emit, now: Clock) -> Arc<Self> {
        let w = Arc::new(Watcher {
            cache,
            tickets,
            feed: feed.clone(),
            emit,
            now,
            state: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            pending: Mutex::new(Pending::default()),
            passes: Mutex::new(Passes { primed: false, last_full: f64::NEG_INFINITY, last_done: f64::NEG_INFINITY }),
            full_running: AtomicBool::new(false),
            changed_running: AtomicBool::new(false),
            known: Mutex::new(HashMap::new()),
        });
        if let Some(f) = feed {
            let weak = Arc::downgrade(&w);
            f.subscribe(move |c| {
                let Some(w) = weak.upgrade() else { return };
                let mut p = w.pending.lock();
                match c {
                    Change::Session { session_id, .. } => {
                        p.sessions.insert(session_id.clone());
                    }
                    Change::Unknown => p.unknown = true,
                }
            });
        }
        w
    }

    fn feed_live(&self) -> bool {
        self.feed.as_ref().is_some_and(|f| f.live())
    }

    /// A ticket was written (its session may have changed): looked at in the next pass.
    pub fn ticket_changed(&self, slug: &str, id: &str) {
        self.pending.lock().tickets.insert(format!("{slug}/{id}"));
    }

    /// One timer tick (every 2 s), on a blocking thread. Returns once its pass is done (or at once when a pass of its
    /// kind is still running).
    pub fn tick(self: &Arc<Self>) {
        let (primed, live, unknown, last_full) = {
            let p = self.passes.lock();
            (p.primed, self.feed_live(), self.pending.lock().unknown, p.last_full)
        };
        let full_due = !primed || !live || unknown || (self.now)() - last_full >= SAFETY_PASS_MS;
        if full_due && !self.full_running.swap(true, Ordering::SeqCst) {
            if primed {
                self.full(true);
            } else {
                self.prime();
            }
            self.full_running.store(false, Ordering::SeqCst);
        } else if (!full_due || (live && !unknown)) && !self.changed_running.swap(true, Ordering::SeqCst) {
            // While a full pass runs, the sessions the feed reported are still announced.
            self.changed();
            self.changed_running.store(false, Ordering::SeqCst);
        }
        self.cache.flush_if_due();
    }

    fn own(&self, sid: &str, key: &str) {
        self.owners.lock().entry(sid.to_string()).or_default().insert(key.to_string());
    }

    /// `pollOne`: the ticket's session changed since it was last looked at: note the version and announce it.
    pub fn poll_one(&self, slug: &str, id: &str, sid: &str, emit: bool) {
        let key = format!("{slug}/{id}");
        let Some(v) = self.cache.version(sid) else { return };
        let mark = format!("{sid}:{v}");
        if self.state.lock().get(&key) == Some(&mark) {
            return;
        }
        self.state.lock().insert(key, mark);
        let Some(summary) = self.cache.summary(sid) else { return };
        self.known.lock().insert(sid.to_string(), (v, summary.clone()));
        if emit {
            (self.emit)(slug, id, summary);
        }
    }

    /// The first pass after a start: readies every ticket's summary and notes the versions.
    fn prime(self: &Arc<Self>) {
        let mut all: Vec<(String, String, String)> = Vec::new();
        for slug in self.tickets.boards() {
            for t in self.tickets.tickets(&slug) {
                let (Some(id), Some(sid)) = (t.get("id").and_then(Value::as_str), session_id(&t)) else { continue };
                self.own(&sid, &format!("{slug}/{id}"));
                all.push((slug.clone(), id.to_string(), sid));
            }
        }
        let ids: Vec<String> = all.iter().map(|(_, _, s)| s.clone()).collect();
        let remade = Mutex::new(HashSet::new());
        self.cache.warm(&ids, || {}, |id| {
            remade.lock().insert(id.to_string());
        });
        let remade = remade.into_inner();
        for (slug, id, sid) in &all {
            if remade.contains(sid)
                && let Some(s) = self.cache.summary(sid)
            {
                (self.emit)(slug, id, s);
            }
            self.poll_one(slug, id, sid, false);
        }
        let now = (self.now)();
        let mut p = self.passes.lock();
        p.primed = true;
        p.last_full = now;
        p.last_done = now;
    }

    /// A full pass over every ticket (Done tickets only every 10 minutes while the feed missed nothing).
    fn full(self: &Arc<Self>, emit: bool) {
        let now = (self.now)();
        let skip_done = {
            let mut p = self.passes.lock();
            let mut pend = self.pending.lock();
            let skip = self.feed_live() && !pend.unknown && now - p.last_done < DONE_PASS_MS;
            if !skip {
                p.last_done = now;
            }
            pend.tickets.clear();
            pend.sessions.clear();
            pend.unknown = false;
            p.last_full = now;
            skip
        };
        let mut owners: HashMap<String, HashSet<String>> = HashMap::new();
        let mut live: HashSet<String> = HashSet::new();
        for slug in self.tickets.boards() {
            for t in self.tickets.tickets(&slug) {
                let Some(id) = t.get("id").and_then(Value::as_str) else { continue };
                let key = format!("{slug}/{id}");
                let sid = session_id(&t);
                if let Some(s) = &sid {
                    owners.entry(s.clone()).or_default().insert(key.clone());
                    live.insert(key.clone());
                }
                if skip_done && t.get("status").and_then(Value::as_str) == Some("done") {
                    continue;
                }
                if let Some(s) = sid {
                    self.poll_one(&slug, id, &s, emit);
                }
            }
        }
        self.state.lock().retain(|k, _| live.contains(k));
        *self.owners.lock() = owners;
    }

    /// Only the tickets written and the sessions the feed reported since the last pass.
    fn changed(self: &Arc<Self>) {
        let keys: HashSet<String> = {
            let mut p = self.pending.lock();
            let mut keys: HashSet<String> = std::mem::take(&mut p.tickets);
            let owners = self.owners.lock();
            for s in p.sessions.drain() {
                if let Some(o) = owners.get(&s) {
                    keys.extend(o.iter().cloned());
                }
            }
            keys
        };
        for key in keys {
            let Some((slug, id)) = key.split_once('/') else { continue };
            let sid = self.tickets.ticket(slug, id).and_then(|t| session_id(&t));
            let Some(sid) = sid else {
                self.state.lock().remove(&key);
                continue;
            };
            self.own(&sid, &key);
            self.poll_one(slug, id, &sid, true);
        }
    }
}

/// The `session.updated` event for a board's ticket.
pub fn session_event(slug: &str, id: &str, session: Value) -> Value {
    json!({ "type": "session.updated", "profile": slug, "id": id, "session": session })
}

#[cfg(test)]
mod tests {
    use super::super::ticket_files::FileTickets;
    use super::*;

    #[test]
    fn announces_changed_sessions_after_taking_stock() {
        let d = tempfile::tempdir().unwrap();
        let dir = ckanban_core::DataDir::new(d.path().join("data"));
        let projects = d.path().join("projects");
        std::fs::create_dir_all(projects.join("-p")).unwrap();
        let tdir = dir.ticket_dir("b", "t_20260101_aaaa");
        std::fs::create_dir_all(&tdir).unwrap();
        std::fs::write(tdir.join("ticket.md"), "---\nid: t_20260101_aaaa\nstatus: review\nsessionId: s1\n---\n").unwrap();
        let line = |t: &str| format!("{}\n", json!({"type": "user", "uuid": t, "message": {"content": t}}));
        std::fs::write(projects.join("-p/s1.jsonl"), line("first")).unwrap();
        let cache = SessionCache::new(&projects, Some(d.path().join("data/session-summaries.json")), Arc::new(ckanban_core::time::now_ms), Arc::new(|s: &str| s.to_string()));
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let emit: Emit = Arc::new(move |slug, id, s| g.lock().push((slug.to_string(), id.to_string(), s)));
        let w = Watcher::new(cache, FileTickets::new(dir), None, emit, Arc::new(ckanban_core::time::now_ms));
        w.tick();
        assert!(got.lock().is_empty(), "the first pass only takes stock");
        assert!(w.known.lock().contains_key("s1"));
        w.tick();
        assert!(got.lock().is_empty(), "nothing changed");
        let mut f = std::fs::OpenOptions::new().append(true).open(projects.join("-p/s1.jsonl")).unwrap();
        std::io::Write::write_all(&mut f, line("second").as_bytes()).unwrap();
        w.tick();
        let got = got.lock();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "b");
        assert_eq!(got[0].2["lastMessage"]["text"], json!("second"));
    }
}
