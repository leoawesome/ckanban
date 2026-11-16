//! Keep the Mac awake while Claude works (`src/runs/awake.ts`). While there is active work on a board with "Keep this
//! Mac awake" on, the daemon holds a `caffeinate -i` child (idle sleep only) and kills it once the work is done.
//! `-w <daemon pid>` makes caffeinate exit by itself if the daemon dies, even on kill -9.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

/// How often the daemon checks whether there is active work.
pub const AWAKE_CHECK_MS: u64 = 2000;

/// A running hold.
pub trait Hold: Send {
    fn kill(&mut self);
    /// The process has exited (killed, or gone on its own).
    fn exited(&mut self) -> bool;
}

struct ChildHold(std::process::Child);

impl Hold for ChildHold {
    fn kill(&mut self) {
        // `p.kill()`: SIGTERM, then reaped.
        unsafe { libc::kill(self.0.id() as i32, libc::SIGTERM) };
        let _ = self.0.wait();
    }
    fn exited(&mut self) -> bool {
        !matches!(self.0.try_wait(), Ok(None))
    }
}

pub fn caffeinate_argv(pid: u32) -> Vec<String> {
    vec!["caffeinate".into(), "-i".into(), "-w".into(), pid.to_string()]
}

pub type Spawn = Box<dyn Fn(&[String]) -> std::io::Result<Box<dyn Hold>> + Send + Sync>;

fn spawn_hold(argv: &[String]) -> std::io::Result<Box<dyn Hold>> {
    use std::process::{Command, Stdio};
    let c = Command::new(&argv[0]).args(&argv[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    Ok(Box::new(ChildHold(c)))
}

pub struct StayAwakeOptions {
    /// Active work wants the Mac awake now.
    pub wanted: Box<dyn Fn() -> bool + Send + Sync>,
    /// The hold started or ended.
    pub on_change: Option<Box<dyn Fn(bool) + Send + Sync>>,
    pub platform: Option<String>,
    pub pid: Option<u32>,
    pub spawn: Option<Spawn>,
    pub interval_ms: Option<u64>,
}

struct State {
    hold: Option<Box<dyn Hold>>,
    /// caffeinate could not start: don't try again on every check.
    broken: bool,
}

pub struct StayAwake {
    o: StayAwakeOptions,
    mac: bool,
    pid: u32,
    spawn: Spawn,
    state: Mutex<State>,
}

impl StayAwake {
    pub fn new(mut o: StayAwakeOptions) -> Arc<Self> {
        let mac = o.platform.as_deref().map(|p| p == "darwin").unwrap_or(cfg!(target_os = "macos"));
        let pid = o.pid.unwrap_or_else(std::process::id);
        let spawn = o.spawn.take().unwrap_or_else(|| Box::new(spawn_hold));
        Arc::new(StayAwake { o, mac, pid, spawn, state: Mutex::new(State { hold: None, broken: false }) })
    }

    pub fn held(&self) -> bool {
        self.state.lock().hold.is_some()
    }

    fn changed(&self, held: bool) {
        if let Some(f) = &self.o.on_change {
            f(held);
        }
    }

    /// Start or end the hold to match the work going on now (spawning caffeinate is a quick fork).
    pub fn check(&self) {
        if !self.mac {
            return;
        }
        let mut s = self.state.lock();
        if s.broken {
            return;
        }
        // Gone on its own (killed from outside): a new one starts below if work still wants it.
        if s.hold.as_mut().is_some_and(|h| h.exited()) {
            s.hold = None;
            drop(s);
            self.changed(false);
            s = self.state.lock();
        }
        let want = (self.o.wanted)();
        if want && s.hold.is_none() {
            match (self.spawn)(&caffeinate_argv(self.pid)) {
                Ok(h) => {
                    s.hold = Some(h);
                    drop(s);
                    self.changed(true);
                }
                Err(e) => {
                    s.broken = true;
                    eprintln!("keep awake: could not start caffeinate ({e}); the Mac may sleep during runs");
                }
            }
        } else if !want && s.hold.is_some() {
            self.release(s);
        }
    }

    fn release(&self, mut s: parking_lot::MutexGuard<'_, State>) {
        let hold = s.hold.take();
        drop(s);
        if let Some(mut h) = hold {
            h.kill();
        }
        self.changed(false);
    }

    /// Checks every interval on the runtime; the returned function stops checking and ends the hold.
    pub fn start(self: &Arc<Self>) -> impl FnOnce() + Send + 'static {
        self.check();
        let me = self.clone();
        let every = Duration::from_millis(self.o.interval_ms.unwrap_or(AWAKE_CHECK_MS));
        let task = tokio::spawn(async move {
            let mut t = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                t.tick().await;
                me.check();
            }
        });
        let me = self.clone();
        move || {
            task.abort();
            let s = me.state.lock();
            if s.hold.is_some() {
                me.release(s);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    type Holds = Arc<Mutex<Vec<(Vec<String>, bool)>>>;
    struct Fake(Holds, usize, Arc<AtomicBool>);
    impl Hold for Fake {
        fn kill(&mut self) {
            self.0.lock()[self.1].1 = true;
        }
        fn exited(&mut self) -> bool {
            self.0.lock()[self.1].1 || self.2.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn holds_while_busy_and_restarts_a_lost_hold() {
        let holds: Holds = Arc::default();
        let busy = Arc::new(AtomicBool::new(false));
        let gone = Arc::new(AtomicBool::new(false));
        let changes: Arc<Mutex<Vec<bool>>> = Arc::default();
        let (h2, b2, c2, g2) = (holds.clone(), busy.clone(), changes.clone(), gone.clone());
        let awake = StayAwake::new(StayAwakeOptions {
            wanted: Box::new(move || b2.load(Ordering::SeqCst)),
            on_change: Some(Box::new(move |h| c2.lock().push(h))),
            platform: Some("darwin".into()),
            pid: Some(4242),
            spawn: Some(Box::new(move |argv| {
                let mut g = h2.lock();
                g.push((argv.to_vec(), false));
                Ok(Box::new(Fake(h2.clone(), g.len() - 1, g2.clone())) as Box<dyn Hold>)
            })),
            interval_ms: None,
        });
        awake.check();
        assert!(holds.lock().is_empty());
        busy.store(true, Ordering::SeqCst);
        awake.check();
        awake.check();
        assert_eq!(holds.lock().len(), 1);
        assert_eq!(holds.lock()[0].0, caffeinate_argv(4242));
        busy.store(false, Ordering::SeqCst);
        awake.check();
        assert!(holds.lock()[0].1);
        assert_eq!(*changes.lock(), vec![true, false]);
        // A hold that went away by itself is replaced while work still wants it.
        busy.store(true, Ordering::SeqCst);
        awake.check();
        gone.store(true, Ordering::SeqCst);
        awake.check();
        assert_eq!(*changes.lock(), vec![true, false, true, false, true]);
        let off = StayAwake::new(StayAwakeOptions { wanted: Box::new(|| true), on_change: None, platform: Some("linux".into()), pid: None, spawn: None, interval_ms: None });
        off.check();
        assert!(!off.held());
    }
}
