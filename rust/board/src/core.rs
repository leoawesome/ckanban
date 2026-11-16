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

use crate::api::{ActivityCut, DeviceInfo, HuddleInfo, Landing, RunControl, Satellite, SessionInfo, StandIn, TicketViews};
use crate::bus::Bus;

/// The modules other modules call through (plan 2.6).
#[derive(Clone)]
pub struct Services {
    pub runs: Arc<dyn RunControl>,
    pub sessions: Arc<dyn SessionInfo>,
    pub huddles: Arc<dyn HuddleInfo>,
    pub devices: Arc<dyn DeviceInfo>,
    pub landing: Arc<dyn Landing>,
    pub satellite: Arc<dyn Satellite>,
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
    stops: Mutex<Vec<Stop>>,
}

impl Core {
    pub fn new(root: &Path, services: Services) -> Arc<Core> {
        Arc::new(Core { root: root.to_path_buf(), bus: Arc::new(Bus::new()), services, stops: Mutex::new(Vec::new()) })
    }

    /// Registers something to stop at shutdown (a timer, a watcher); stops run newest first.
    pub fn on_stop(&self, name: &'static str, f: impl FnOnce() + Send + 'static) {
        self.stops.lock().push((name, Box::new(f)));
    }

    /// Bun's start order. Each task fills in its step.
    pub fn steps() -> Vec<Step> {
        vec![
            // R1: every board's tickets read on a thread pool, so recover() and the first pages list from memory.
            Step::new("load tickets", |c| async move { check_readable(&c.root.join("profiles")) }),
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
            Step::new("timers", |_| async { Ok(()) }),
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
