//! `Core`: every service of the Rust board, built once at start like `startDaemon()` in `src/cli/daemon.ts` (plan 2.1),
//! started in Bun's order and stopped in reverse.
//!
//! Start order (Bun's): load tickets, load lists, recover, huddles, quick chats, then the timers. A step that fails
//! stops the start; `ckanban-rs` then lets Bun run the whole board (fallback 2 of `mode.rs`). Each task fills in its
//! step and replaces its stand-in in `Services`; until then a step does nothing.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use futures_util::future::BoxFuture;
use parking_lot::Mutex;

use crate::api::{ActivityCut, BoardActions, DeviceInfo, HuddleInfo, Landing, RunControl, Satellite, SessionInfo, StandIn, TicketViews};
use crate::bus::Bus;
use crate::index::store::RECHECK_EVERY;
use crate::index::{Index, Reads, ServicesLive};

/// The modules other modules call through (plan 2.6).
#[derive(Clone)]
pub struct Services {
    pub runs: Arc<dyn RunControl>,
    pub sessions: Arc<dyn SessionInfo>,
    pub huddles: Arc<dyn HuddleInfo>,
    pub devices: Arc<dyn DeviceInfo>,
    pub landing: Arc<dyn Landing>,
    pub satellite: Arc<dyn Satellite>,
    pub actions: Arc<dyn BoardActions>,
    pub views: Arc<dyn TicketViews>,
    pub cut: Arc<dyn ActivityCut>,
}

impl Services {
    pub fn stand_ins() -> Self {
        let s = Arc::new(StandIn);
        Services {
            runs: s.clone(),
            sessions: s.clone(),
            huddles: s.clone(),
            devices: s.clone(),
            landing: s.clone(),
            satellite: s.clone(),
            actions: s.clone(),
            views: s,
            // R3: run events go out with their long strings cut.
            cut: Arc::new(crate::runs::live_cut::LiveCut),
        }
    }
}

/// One start step: a name for logs and freezes, and the work.
pub struct Step {
    pub name: &'static str,
    pub run: Box<dyn FnOnce(Arc<Core>) -> BoxFuture<'static, Result<(), String>> + Send>,
}

impl Step {
    pub fn new<F>(name: &'static str, f: impl FnOnce(Arc<Core>) -> F + Send + 'static) -> Self
    where
        F: std::future::Future<Output = Result<(), String>> + Send + 'static,
    {
        Step { name, run: Box::new(move |c| Box::pin(f(c))) }
    }
}

/// What to stop at shutdown, named; run in reverse order of registration.
type Stop = (&'static str, Box<dyn FnOnce() + Send>);

pub struct Core {
    pub root: PathBuf,
    pub bus: Arc<Bus>,
    pub services: Services,
    /// Every board's tickets (R1): listings, families, scopes.
    pub index: Arc<Index>,
    /// The read routes over the index, with live state from `services` (R1).
    pub reads: Arc<Reads>,
    stops: Mutex<Vec<Stop>>,
}

impl Core {
    /// `services.views` is replaced by the index's views (R1); the rest is used as given.
    pub fn new(root: &Path, mut services: Services) -> Arc<Core> {
        let index = Index::new(root);
        let reads = Arc::new(Reads::new(index.clone(), Arc::new(ServicesLive::new(root, services.clone()))));
        services.views = Arc::new(IndexViews { reads: reads.clone() });
        Arc::new(Core { root: root.to_path_buf(), bus: Arc::new(Bus::new()), services, index, reads, stops: Mutex::new(Vec::new()) })
    }

    /// Registers something to stop at shutdown (a timer, a watcher); stops run newest first.
    pub fn on_stop(&self, name: &'static str, f: impl FnOnce() + Send + 'static) {
        self.stops.lock().push((name, Box::new(f)));
    }

    /// Bun's start order. Each task fills in its step.
    pub fn steps() -> Vec<Step> {
        vec![
            // R1: every board's tickets read on a thread pool, so recover() and the first pages list from memory.
            Step::new("load tickets", |c| async move {
                check_readable(&c.root.join("profiles"))?;
                // On a few threads in the background: the server answers meanwhile, and a board's first listing
                // waits for the load instead of reading its files a second time (Index::list).
                let index = c.index.clone();
                index.begin_load();
                let t0 = Instant::now();
                tokio::task::spawn_blocking(move || {
                    let n = index.load_all();
                    eprintln!("[board] loaded {n} tickets in {}ms", t0.elapsed().as_millis());
                });
                Ok(())
            }),
            // R1/R10/R11a: huddles, jobs, schedules and automations.
            Step::new("load lists", |_| async { Ok(()) }),
            // R7a: interrupted runs resumed, follow-ups and limits picked up (`board.recover`).
            Step::new("recover", |_| async { Ok(()) }),
            // R11a: open huddles (`huddles.recover`, the watchdog).
            Step::new("huddles", |_| async { Ok(()) }),
            // R8: quick chats cut off by a restart.
            Step::new("quick chats", |_| async { Ok(()) }),
            // R3, R5, R6, R7a, R9, R10, R12: the PR poller, scheduler, jobs, loops, learner, limits, follow-ups, run
            // log compression, the session watcher, the ticket and list re-checks, board browsers, keep-awake.
            Step::new("timers", |c| async move {
                // R1: the ticket files re-checked every 30 s (edits made outside the board), off the runtime.
                let index = c.index.clone();
                let task = tokio::spawn(async move {
                    let mut tick = tokio::time::interval(RECHECK_EVERY);
                    tick.tick().await;
                    loop {
                        tick.tick().await;
                        let ix = index.clone();
                        let _ = tokio::task::spawn_blocking(move || ix.recheck_all()).await;
                    }
                });
                c.on_stop("ticket re-check", move || task.abort());
                Ok(())
            }),
        ]
    }

    /// Runs `steps` in order; the first failure stops the start (and stops what already started).
    pub async fn start(self: &Arc<Self>, steps: Vec<Step>) -> Result<(), String> {
        for step in steps {
            let t0 = Instant::now();
            if let Err(e) = (step.run)(self.clone()).await {
                self.stop();
                return Err(format!("startup: {}: {e}", step.name));
            }
            let ms = t0.elapsed().as_millis();
            if ms >= 1000 {
                eprintln!("[board] startup: {} took {ms}ms", step.name);
            }
        }
        Ok(())
    }

    /// Stops everything registered with `on_stop`, newest first (timers before the services they use).
    pub fn stop(&self) {
        let stops: Vec<Stop> = std::mem::take(&mut *self.stops.lock());
        for (name, f) in stops.into_iter().rev() {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err() {
                eprintln!("[board] stopping {name} failed");
            }
        }
    }
}

/// `TicketViews` from the index (what `ticket.updated` events carry): the ticket's view with the board's live state.
pub struct IndexViews {
    pub reads: Arc<Reads>,
}

impl TicketViews for IndexViews {
    fn view(&self, profile: &str, ticket: &serde_json::Value) -> Option<serde_json::Value> {
        let serde_json::Value::Object(m) = ticket else { return None };
        let p = ckanban_core::home::DataDir::new(self.reads.index.root().to_path_buf()).profile(profile)?;
        let t = crate::index::ticket::Tk::from_json(m.clone(), false);
        let list = self.reads.index.peek(profile).unwrap_or_else(|| self.reads.index.list(profile));
        Some(serde_json::Value::Object(self.reads.viewer.view(profile, &p.record.0, &list, &t, &*self.reads.live)))
    }
    fn view_of(&self, profile: &str, id: &str) -> Option<serde_json::Value> {
        let t = self.reads.index.ticket(profile, id)?;
        self.view(profile, &serde_json::Value::Object(t.json.clone()))
    }
}

/// A folder the board must read: missing is fine (a new data folder), unreadable stops board mode.
fn check_readable(dir: &Path) -> Result<(), String> {
    match std::fs::read_dir(dir) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("can't read {}: {e}", dir.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn steps_run_in_order_and_stops_run_in_reverse() {
        let d = tempfile::tempdir().unwrap();
        let core = Core::new(d.path(), Services::stand_ins());
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let step = |name: &'static str, log: Arc<Mutex<Vec<String>>>| {
            Step::new(name, move |c: Arc<Core>| async move {
                log.lock().push(format!("start {name}"));
                let l = log.clone();
                c.on_stop(name, move || l.lock().push(format!("stop {name}")));
                Ok(())
            })
        };
        core.start(vec![step("a", log.clone()), step("b", log.clone())]).await.unwrap();
        core.stop();
        assert_eq!(*log.lock(), vec!["start a", "start b", "stop b", "stop a"]);
    }

    #[tokio::test]
    async fn a_failing_step_stops_the_start_and_what_started() {
        let d = tempfile::tempdir().unwrap();
        let core = Core::new(d.path(), Services::stand_ins());
        let stopped = Arc::new(Mutex::new(false));
        let s = stopped.clone();
        let ran_after = Arc::new(Mutex::new(false));
        let r = ran_after.clone();
        let err = core
            .start(vec![
                Step::new("first", move |c: Arc<Core>| async move {
                    c.on_stop("first", move || *s.lock() = true);
                    Ok(())
                }),
                Step::new("load tickets", |_| async { Err("can't read x".to_string()) }),
                Step::new("later", move |_| async move {
                    *r.lock() = true;
                    Ok(())
                }),
            ])
            .await
            .unwrap_err();
        assert_eq!(err, "startup: load tickets: can't read x");
        assert!(*stopped.lock());
        assert!(!*ran_after.lock());
    }

    #[tokio::test]
    async fn the_default_steps_start_on_an_empty_data_folder() {
        let d = tempfile::tempdir().unwrap();
        let core = Core::new(d.path(), Services::stand_ins());
        core.start(Core::steps()).await.unwrap();
        assert_eq!(Core::steps().iter().map(|s| s.name).collect::<Vec<_>>(), ["load tickets", "load lists", "recover", "huddles", "quick chats", "timers"]);
    }
}
