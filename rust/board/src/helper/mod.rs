//! The helper in Rust (P1a, `src/helper/`): what waits on the user and how they hear of it. Rust owns its files in
//! board mode: `waits.json`, `messages.json`, `helper-state.json`, `helper.json`, and is the only writer of
//! `notify.json` (the satellite sends its Telegram and settings changes through `/api/internal/notify-write`).
//!
//! - `watch`: which tickets wait on the user (the Notifier's watching half) and notify_user.
//! - `core`: wait records, the message store, the routing switch, direct sends, digests and night holds.
//! - `runner`: the helper's wakes (a side call), its decisions carried out, reminders, summaries, taps, status.
//! - `decide`, `summary`, `settings`, `text`, `local`: the pure rules, checked against Bun's answers.
//! - `waits`, `messages`, `notify_settings`: the files.
//! - `channels`: sending, done by the satellite until P1b (push, ntfy, the Mac banner) and P1c (Telegram).
//! - `routes`: `/api/messages...`, `/api/helper...`, a ticket's `POST .../notify`.

pub mod board;
pub mod channels;
pub mod core;
pub mod decide;
pub mod local;
pub mod messages;
pub mod notify_settings;
pub mod routes;
pub mod runner;
pub mod settings;
pub mod summary;
pub mod text;
pub mod waits;
pub mod watch;
pub mod wired;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use self::board::HelperBoard;
use self::channels::Sender;
use self::core::HelperCore;
use self::runner::{Emit, HelperRunner, SideFn};
use self::watch::Watcher;
use crate::bus::Bus;
use crate::index::attention::{ticket_attention, with_snooze};

/// The whole helper: its core, runner and watcher.
pub struct Helper {
    pub core: Arc<HelperCore>,
    pub runner: Arc<HelperRunner>,
    pub watch: Arc<Watcher>,
    pub emit: Emit,
}

/// How often things look: the watcher and the core's safety nets, the runner's reminders and wakes.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub watch: Duration,
    pub runner: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { watch: Duration::from_millis(1000), runner: Duration::from_millis(10_000) }
    }
}

impl Helper {
    /// `on_closed`: records just closed (the satellite's Telegram edits their alerts until P1c).
    pub fn new(root: &Path, board: Arc<dyn HelperBoard>, sender: Arc<dyn Sender>, side: SideFn, bus: Arc<Bus>, on_closed: Option<waits::Closed>) -> Arc<Helper> {
        let now: Arc<dyn Fn() -> f64 + Send + Sync> = Arc::new(ckanban_core::time::now_ms);
        Self::with_clock(root, board, sender, side, bus, on_closed, now)
    }

    pub fn with_clock(root: &Path, board: Arc<dyn HelperBoard>, sender: Arc<dyn Sender>, side: SideFn, bus: Arc<Bus>, on_closed: Option<waits::Closed>, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Arc<Helper> {
        let b = bus.clone();
        let emit: Emit = Arc::new(move |v: Value| b.emit_json(v));
        let b = bus.clone();
        let on_unread: messages::Unread = Arc::new(move |n| b.emit_json(json!({ "type": "messages.updated", "unread": n })));
        let core = HelperCore::new(root, board.clone(), sender, now.clone(), Some(on_unread), on_closed);
        let clock = now.clone();
        let snoozed: runner::SnoozedUntil = Arc::new(move |slug: &str, id: &str| {
            let t = board.ticket(slug, id)?;
            let until = t.get("snooze").and_then(|z| z.get("until")).and_then(Value::as_str)?;
            let now = clock();
            if ckanban_core::time::parse_date(until).is_none_or(|u| u <= now) {
                return None;
            }
            let s = t.s("sessionId").filter(|s| !s.is_empty()).and_then(|s| board.session(s));
            let list = board.list(slug);
            let host = board.host(slug, id);
            let a = ticket_attention(&list, &t, s.as_ref(), board.running(slug, id), host.as_ref(), &|x| board.running(slug, x), &|| board.schedule_ids(slug));
            with_snooze(&t, s.as_ref(), a, now, host.as_ref()).1.map(|(_, until)| until)
        });
        let runner = HelperRunner::new(core.clone(), side, emit.clone(), snoozed);
        let watch = Watcher::new(core.clone());
        Arc::new(Helper { core, runner, watch, emit })
    }

    /// Follows the board (bus events), takes stock once the board is loaded (`loaded` blocks until then), then
    /// ticks. Returns what stops it.
    pub fn start(self: &Arc<Self>, bus: Arc<Bus>, timing: Timing, loaded: Arc<dyn Fn() + Send + Sync>) -> impl FnOnce() + Send + 'static {
        let w = self.watch.clone();
        let sub = bus.on(move |e| w.on_event(e));
        let me = self.clone();
        let task = tokio::spawn(async move {
            let w = me.watch.clone();
            let _ = tokio::task::spawn_blocking(move || {
                loaded();
                w.stock_take();
            })
            .await;
            let runner = me.runner.start(timing.runner);
            let mut t = tokio::time::interval(timing.watch);
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let _keep = Abort(runner);
            let core_busy = Arc::new(std::sync::atomic::AtomicBool::new(false));
            loop {
                t.tick().await;
                let w = me.watch.clone();
                let fire = tokio::task::spawn_blocking(move || w.look()).await.unwrap_or_default();
                // One after another, in the order the tick found them (each claims its record before it sends).
                if !fire.is_empty() {
                    let core = me.core.clone();
                    tokio::spawn(async move {
                        for wait in fire {
                            core.route(wait).await;
                        }
                    });
                }
                // One safety-net tick at a time (a slow send must not let the next one send the same digest).
                if !core_busy.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    let (core, busy) = (me.core.clone(), core_busy.clone());
                    tokio::spawn(async move {
                        core.tick().await;
                        busy.store(false, std::sync::atomic::Ordering::SeqCst);
                    });
                }
            }
        });
        move || {
            task.abort();
            bus.off(sub);
        }
    }

    /// Telegram's and the board's taps from the satellite (`helper-action`): a short reply for the user.
    pub fn action(&self, b: &Value) -> Value {
        let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or("");
        let id = s("messageId");
        let text = match s("action") {
            "got-it" => HelperRunner::tap_text(self.runner.got_it(id, None)),
            "not-urgent" => HelperRunner::tap_text(self.runner.not_urgent(id, None)),
            "night" => HelperRunner::tap_text(self.runner.night_answer(id, b.get("allow") == Some(&Value::Bool(true))).map(|t| json!({ "text": t }))),
            "night-after" => return json!({ "text": self.runner.night_after(id) }),
            "waiting" => self.core.waiting_text(),
            other => return json!({ "error": format!("unknown helper action {other}") }),
        };
        json!({ "text": text })
    }
}

impl Helper {
    /// The satellite's calls about the helper (`/api/internal/<name>`); None when the name isn't one of them.
    /// - `helper-action`: Got it, Not urgent, the night answer, /waiting from Telegram.
    /// - `notify-write`: notify.json as the satellite worked it out (Settings, Telegram pairing, /lock); Rust writes
    ///   it, and switching the helper off or on does what Bun's `switched` does.
    /// - `wait-seen`: the front desk showed these waits in its chat (`seenInChatAt`).
    /// - `helper-send-message`: a message the satellite sends itself (the Settings test), stored here, sent there.
    pub async fn internal(&self, name: &str, b: &Value) -> Option<(u16, Value)> {
        Some(match name {
            "helper-action" => (200, self.action(b)),
            "notify-write" => {
                let Some(next) = b.get("settings").filter(|s| s.is_object()) else { return Some((400, json!({ "error": "settings is required" }))) };
                let before = notify_settings::helper_on(&self.core.settings());
                if let Err(e) = notify_settings::write_notify(&self.core.root, next) {
                    return Some((500, json!({ "error": format!("can't write notify.json: {e}") })));
                }
                let after = notify_settings::helper_on(next);
                if before != after {
                    let core = self.core.clone();
                    tokio::spawn(async move { core.switched(after).await });
                }
                (200, json!({ "ok": true }))
            }
            "wait-seen" => {
                let at = b.get("at").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| ckanban_core::time::iso((self.core.now)()));
                let keys: Vec<String> = b.get("keys").and_then(Value::as_array).map(|a| a.iter().filter_map(|k| k.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let mut st = self.core.lock();
                for k in &keys {
                    st.waits.update(k, vec![("seenInChatAt", at.clone().into())]);
                }
                (200, json!({ "ok": true }))
            }
            "helper-send-message" => {
                let m = b.get("message").cloned().unwrap_or(Value::Null);
                let s = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let mut nm = messages::NewMessage::new(&s("level"), s("oneLine"), s("text"));
                nm.why = m.get("why").and_then(Value::as_str).map(str::to_string);
                nm.items = m.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut fields = b.get("out").and_then(Value::as_object).cloned().unwrap_or_default();
                let url = fields.remove("url").and_then(|u| u.as_str().map(str::to_string));
                let (message, results) = self.core.send(nm, core::OutBody { fields, url }, None).await;
                (200, json!({ "message": message, "results": results }))
            }
            _ => return None,
        })
    }
}

struct Abort(tokio::task::JoinHandle<()>);

impl Drop for Abort {
    fn drop(&mut self) {
        self.0.abort();
    }
}
