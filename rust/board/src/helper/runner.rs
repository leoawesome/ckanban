//! The helper runner (`src/helper/runner.ts` `HelperRunner`): wakes the helper (one side call with a JSON schema),
//! checks its decision and carries it out through the core; fires the reminder steps it planned; backs off when runs
//! fail and sends directly with one pause message after 3 failures in a row; sends the hello and the first summary;
//! keeps the status the screens show. Its state is `<root>/helper-state.json` (one-space indent), so a restart
//! changes nothing. Not a board run: a restart neither waits for it nor holds it.
//!
//! Like Bun, a wake and a tick never overlap themselves (`busy`, `ticking`); between their sends (awaits) other steps
//! may run, and each step re-reads the records it changes.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ckanban_core::jsnum::num;
use ckanban_core::time::{day_key, iso, parse_date};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::core::{HelperCore, HelperSink, OutBody, Reason};
use super::decide::{self, CheckContext, CheckedDecision, CheckedSend, ItemState, REMIND_MAX_MIN, REMIND_MAX_STEPS, summary_allowed_at, urgent_refusal, you_said};
use super::local;
use super::messages::{self, Msg, NewMessage};
use super::notify_settings::{CHANNEL_NAMES, enabled};
use super::settings::{HelperSettings, HelperSettingsStore, Night, in_night, morning_digest_at, night_allowed, night_answer_text, night_end, night_question};
use super::summary::{SummaryBuild, SummaryInput, build_summary, week_recap_line, week_start};
use super::text::{self, ASK_PREFIX, NEXT_PREFIX, NO_REMINDERS, clock_ms, clock_time, cut, cut1, direct_label, kept_quiet_line, label, reminder_body, reminder_count, step_chain, stopped_why, summary_line};
use super::waits::{self, DIGEST_MS, FALLBACK_MS, Rec, alerted, claim_of, is_open, pending, rb, reminders, rms, ro, rs, step_flag, step_sent, steps_used};
use crate::runs::side_call::{SideCallInput, SideCallResult, add_side_spend, read_side_spend};

pub const BATCH_MS: f64 = 60_000.0;
pub const ROUTINE_KINDS: [&str; 4] = ["review", "reply", "proposal", "huddle"];
pub const LOOP_GUARD_MS: f64 = 60_000.0;
pub const FAIL_LIMIT: f64 = 3.0;
pub const RUN_TIMEOUT_MS: u64 = 90_000;
pub const AWAKE_AHEAD_MS: f64 = 15.0 * 60_000.0;
pub const URGENT_RETRY_MS: f64 = 5.0 * 60_000.0;
pub const RUNS_KEEP: usize = 50;
pub const UNSNOOZED_MAX_MS: f64 = 24.0 * 3_600_000.0;
pub const DIGEST_LEAD_MS: f64 = 5.0 * 60_000.0;
pub const REACTIONS_KEEP: usize = 20;
pub const PRACTICE_REMIND_MS: f64 = 60_000.0;
pub const NIGHT_ASK_MAX_MS: f64 = 24.0 * 3_600_000.0;
pub const PRACTICE_STOPPED: &str = "That stopped the reminder. Real alerts work the same way.";
/// `snoozeForever`: a snooze "until I unsnooze" (an end from the year 9000 on).
fn snooze_forever(until: &str) -> bool {
    parse_date(until).is_some_and(|u| u >= parse_date("9000-01-01T00:00:00.000Z").unwrap_or(f64::INFINITY))
}

/// Retry after a failed run: 1, 2, 4, 8, 16, then 30 minutes.
pub fn backoff_ms(failures: f64) -> f64 {
    30f64.min(2f64.powf((failures - 1.0).max(0.0))) * 60_000.0
}

/// When the helper looks at held items due a digest soon (`lookBeforeDigest`).
pub fn look_before_digest(before: f64, night: &Night) -> f64 {
    if in_night(before, night) {
        return night_end(before, night);
    }
    let grace = before - super::settings::MORNING_GRACE_MS;
    if in_night(grace, night) { night_end(grace, night) } else { before }
}

/// A runner error: an HTTP status and a plain message.
pub type HelperError = (u16, String);

pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;
pub type SideFn = Arc<dyn Fn(SideCallInput) -> futures_util::future::BoxFuture<'static, SideCallResult> + Send + Sync>;
/// Until when a ticket is snoozed in the Inbox (None: not snoozed).
pub type SnoozedUntil = Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;

fn empty_state() -> Map<String, Value> {
    let v = json!({
        "nextWakeAt": null, "lastRunAt": null, "lastOkAt": null, "lastFailAt": null, "lastCheckAt": null, "failures": 0, "failReason": null, "pauseSentAt": null,
        "notes": "", "helloSentAt": null, "noticeSeenAt": null, "firstUrgentAsked": false, "named": {}, "reactions": [], "nightWokeAt": null, "nightWokeFor": null, "nightNoticeAt": null, "practice": null, "heldSends": [], "runs": [],
    });
    v.as_object().cloned().unwrap_or_default()
}

/// A check-in item the helper may name.
#[derive(Clone, Debug)]
struct Checkin {
    key: String,
    title: String,
    board_name: String,
    meeting_at: Option<f64>,
    created_at: String,
}

/// What one wake sees.
struct Gathered {
    now: f64,
    open: Vec<Rec>,
    snoozed: HashSet<String>,
    checkins: Vec<Checkin>,
    older: usize,
    states: HashMap<String, ItemState>,
    new_feedback: Vec<String>,
    anything: bool,
}

pub struct HelperRunner {
    pub core: Arc<HelperCore>,
    pub settings: HelperSettingsStore,
    file: PathBuf,
    state: Mutex<Map<String, Value>>,
    busy: AtomicBool,
    ticking: AtomicBool,
    batch_at: Mutex<Option<f64>>,
    side: SideFn,
    emit: Emit,
    snoozed_until: SnoozedUntil,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

fn ms_of(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(parse_date).unwrap_or(f64::NAN)
}

fn vals(v: &[String]) -> Value {
    Value::Array(v.iter().cloned().map(Value::String).collect())
}

/// `{ ...entry, k: v }`.
fn put(mut m: Map<String, Value>, k: &str, v: impl Into<Value>) -> Map<String, Value> {
    m.insert(k.into(), v.into());
    m
}

impl HelperRunner {
    pub fn new(core: Arc<HelperCore>, side: SideFn, emit: Emit, snoozed_until: SnoozedUntil) -> Arc<Self> {
        let now = core.now.clone();
        let file = core.root.join("helper-state.json");
        let settings = HelperSettingsStore::new(&core.root, now.clone());
        let mut state = empty_state();
        if let Ok(Some(Value::Object(m))) = ckanban_core::datafile::read_json(&file) {
            for (k, v) in m {
                state.insert(k, v);
            }
        }
        let r = Arc::new(HelperRunner {
            core: core.clone(),
            settings,
            file,
            state: Mutex::new(state),
            busy: AtomicBool::new(false),
            ticking: AtomicBool::new(false),
            batch_at: Mutex::new(None),
            side,
            emit,
            snoozed_until,
            now,
        });
        let weak: std::sync::Weak<dyn HelperSink> = Arc::downgrade(&(r.clone() as Arc<dyn HelperSink>));
        core.set_sink(weak);
        r
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    // ---------- state ----------

    fn st_get(&self, k: &str) -> Value {
        self.state.lock().get(k).cloned().unwrap_or(Value::Null)
    }
    fn st_str(&self, k: &str) -> Option<String> {
        self.state.lock().get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
    }
    fn st_set(&self, k: &str, v: impl Into<Value>) {
        self.state.lock().insert(k.into(), v.into());
    }
    fn failures(&self) -> f64 {
        self.state.lock().get("failures").and_then(Value::as_f64).unwrap_or(0.0)
    }

    fn save(&self) {
        let v = Value::Object(self.state.lock().clone());
        if let Err(e) = ckanban_core::datafile::write_json(&self.file, &v, ckanban_core::datafile::formats::HELPER_STATE) {
            eprintln!("helper: can't write helper-state.json: {e}");
        }
    }

    fn changed(&self) {
        self.save();
        (self.emit)(json!({ "type": "helper.updated" }));
    }

    fn active(&self) -> bool {
        self.core.plugged(&self.core.settings())
    }

    fn on_channels(&self) -> Vec<String> {
        enabled(&self.core.settings())
    }

    // ---------- waits arriving ----------

    fn wait_arrived(&self, rec: &Rec, reason: Reason) {
        let now = self.now();
        let night = self.settings.get().night;
        let key = rs(rec, "key").to_string();
        if ro(rec, "digestAt").is_some() && in_night(rms(rec, "digestAt"), &night) {
            self.core.lock().waits.update(&key, vec![("digestAt", iso(morning_digest_at(rms(rec, "digestAt"), &night)).into())]);
        }
        let rec = self.core.lock().waits.get(&key).cloned().unwrap_or_else(|| rec.clone());
        if in_night(now, &night) && !self.night_allowed_now() {
            if ro(&rec, "toldAt").is_none() && ro(&rec, "closedAt").is_none() {
                self.hold_night(vec![rec], now, &night);
            }
        } else if reason == Reason::Urgent || rb(&rec, "urgent") {
            self.request_wake(now);
        } else if let Some(hold) = self.routine_hold(&rec, reason, now, &night) {
            self.core.lock().waits.update(&key, vec![("heldUntil", iso(hold).into()), ("fallbackAt", Value::Null)]);
            self.request_wake(hold);
        } else {
            self.request_wake(now + BATCH_MS);
        }
        (self.emit)(json!({ "type": "helper.updated" }));
    }

    fn routine_hold(&self, rec: &Rec, reason: Reason, now: f64, night: &Night) -> Option<f64> {
        if !ROUTINE_KINDS.contains(&rs(rec, "kind")) || rb(rec, "urgent") || ro(rec, "toldAt").is_some() || ro(rec, "closedAt").is_some() || rb(rec, "seeded") {
            return None;
        }
        if reason != Reason::New && reason != Reason::Restart {
            return None;
        }
        if self.failures() != 0.0 {
            return None;
        }
        if in_night(now, night) {
            return Some(night_end(now, night));
        }
        summary_allowed_at(self.last_summary_at(), now, night).map(|gap| night_end(gap, night))
    }

    fn night_allowed_now(&self) -> bool {
        night_allowed(&self.settings.get())
    }

    fn hold_night(&self, recs: Vec<Rec>, now: f64, night: &Night) {
        if recs.is_empty() {
            return;
        }
        let end = night_end(now, night);
        let later: Vec<Option<String>> = recs
            .iter()
            .map(|r| ro(r, "digestAt").filter(|d| !in_night(parse_date(d).unwrap_or(f64::NAN), night) && parse_date(d).unwrap_or(f64::NAN) > end).map(str::to_string))
            .collect();
        let keys: Vec<String> = recs.iter().map(|r| rs(r, "key").to_string()).collect();
        self.core.hold_for_morning(recs);
        let mut st = self.core.lock();
        for (k, l) in keys.iter().zip(later) {
            let mut patch = vec![("heldUntil", Value::String(iso(end)))];
            if let Some(l) = l {
                patch.push(("digestAt", l.into()));
            }
            st.waits.update(k, patch);
        }
        drop(st);
        self.request_wake(end);
    }

    /// Wake at this time (or sooner if already due sooner).
    pub fn request_wake(&self, at: f64) {
        let mut b = self.batch_at.lock();
        *b = Some(match *b {
            None => at,
            Some(x) => x.min(at),
        });
    }

    /// When the next wake may run, after the loop guard and the backoff. None: none.
    pub fn due_at(&self) -> Option<f64> {
        let want: Vec<f64> = [*self.batch_at.lock(), Some(ms_of(Some(&self.st_get("nextWakeAt"))))].into_iter().flatten().filter(|x| x.is_finite()).collect();
        let mut at = want.into_iter().reduce(f64::min)?;
        let last = ms_of(Some(&self.st_get("lastRunAt")));
        if last.is_finite() {
            at = at.max(last + LOOP_GUARD_MS);
        }
        let failed = ms_of(Some(&self.st_get("lastFailAt")));
        let f = self.failures();
        if f > 0.0 && failed.is_finite() {
            at = at.max(failed + backoff_ms(f));
        }
        Some(at)
    }

    // ---------- the timer ----------

    /// Every ~10 s: reminder steps, safety-net times, then a wake if one is due.
    pub async fn tick(self: &Arc<Self>) {
        if !self.active() || self.ticking.swap(true, Ordering::SeqCst) {
            return;
        }
        struct Clear<'a>(&'a AtomicBool);
        impl Drop for Clear<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _clear = Clear(&self.ticking);
        self.reminders().await;
        self.maintain();
        self.send_held().await;
        self.practice_reminder().await;
        self.night_notice().await;
        self.ask_about_night_wake().await;
        if let Some(due) = self.due_at()
            && due <= self.now()
        {
            self.wake().await;
        }
    }

    /// The first wakes after a start, then the 10-second timer (stopped with the returned task).
    pub fn start(self: &Arc<Self>, every: Duration) -> tokio::task::JoinHandle<()> {
        let now = self.now();
        let mut untold = false;
        for r in self.core.lock().waits.open() {
            if ro(&r, "toldAt").is_some() {
                continue;
            }
            let held = rms(&r, "heldUntil");
            if ro(&r, "fallbackAt").is_none() && !rb(&r, "seeded") && !rb(&r, "urgent") && held.is_finite() && held > now {
                self.request_wake(held);
            } else {
                untold = true;
            }
        }
        let first = self.core.lock().waits.first_summary_pending();
        if self.st_str("helloSentAt").is_none() || first || untold {
            self.request_wake(now + BATCH_MS);
        }
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                t.tick().await;
                let me = me.clone();
                // One tick at a time; a panic in one is logged and the next goes on.
                if let Err(e) = tokio::spawn(async move { me.tick().await }).await {
                    eprintln!("helper: tick: {e}");
                }
            }
        })
    }

    fn snoozed(&self, board: &str, ticket: &str) -> Option<String> {
        let until = (self.snoozed_until)(board, ticket)?;
        (ms_of(Some(&Value::String(until.clone()))) > self.now()).then_some(until)
    }

    /// Snoozed items wait for their snooze before any fallback; the helper looks again when a snooze ends.
    fn maintain(&self) {
        let now = self.now();
        for r in self.core.lock().waits.open() {
            let key = rs(&r, "key").to_string();
            let Some(until) = self.snoozed(rs(&r, "board"), rs(&r, "ticketId")) else {
                if ro(&r, "toldAt").is_some() {
                    continue;
                }
                let mut patch = Vec::new();
                if ro(&r, "digestAt").is_some() && rms(&r, "digestAt") > now + UNSNOOZED_MAX_MS {
                    patch.push(("digestAt", Value::String(iso(now + DIGEST_MS))));
                }
                if ro(&r, "fallbackAt").is_some() && rms(&r, "fallbackAt") > now + UNSNOOZED_MAX_MS {
                    patch.push(("fallbackAt", Value::String(iso(now + FALLBACK_MS))));
                }
                if !patch.is_empty() {
                    self.core.lock().waits.update(&key, patch);
                    self.request_wake(now + BATCH_MS);
                }
                continue;
            };
            let u = ms_of(Some(&Value::String(until.clone())));
            if !snooze_forever(&until) {
                self.request_wake(u);
            }
            if ro(&r, "toldAt").is_some() {
                continue;
            }
            let mut patch = Vec::new();
            if ro(&r, "fallbackAt").is_some() && rms(&r, "fallbackAt") < u {
                patch.push(("fallbackAt", Value::String(until.clone())));
            }
            if ro(&r, "digestAt").is_some() && rms(&r, "digestAt") < u {
                patch.push(("digestAt", Value::String(until.clone())));
            }
            if !patch.is_empty() {
                self.core.lock().waits.update(&key, patch);
            }
        }
    }

    // ---------- what a wake sees ----------

    fn checkins(&self, now: f64) -> (Vec<Checkin>, usize) {
        let named = self.st_get("named");
        let mut list = Vec::new();
        let mut older = 0;
        for (slug, name) in self.core.board.profiles() {
            let board = self.core.board.list(&slug);
            for t in board.tickets.iter() {
                if t.s("raisedBy").is_none_or(str::is_empty) || t.status == "done" {
                    continue;
                }
                let key = format!("checkin:{slug}/{}", t.id);
                let meeting_at = text::meeting_time(&t.title, &t.created_at);
                if let Some(m) = meeting_at {
                    if m <= now {
                        continue;
                    }
                } else if named.get(&key).is_some_and(|v| crate::runs::js::truthy(Some(v))) {
                    older += 1;
                    continue;
                }
                list.push(Checkin { key, title: t.title.clone(), board_name: name.clone(), meeting_at, created_at: t.created_at.clone() });
            }
        }
        (list, older)
    }

    fn is_named(&self, key: &str) -> bool {
        self.state.lock().get("named").and_then(|n| n.get(key)).is_some_and(|v| crate::runs::js::truthy(Some(v)))
    }

    fn gather(&self, now: f64, s: &HelperSettings) -> Gathered {
        let open = self.core.lock().waits.open();
        let snoozed: HashSet<String> = open.iter().filter(|r| self.snoozed(rs(r, "board"), rs(r, "ticketId")).is_some()).map(|r| rs(r, "key").to_string()).collect();
        let (checkins, older) = self.checkins(now);
        let mut states = HashMap::new();
        for r in &open {
            states.insert(rs(r, "key").to_string(), item_state(r, snoozed.contains(rs(r, "key"))));
        }
        for c in &checkins {
            states.insert(c.key.clone(), ItemState { open: true, checkin: true, told: self.is_named(&c.key), ..Default::default() });
        }
        let seen = self.st_str("lastOkAt").unwrap_or_default();
        let new_feedback: Vec<String> = s
            .feedback
            .iter()
            .filter(|f| crate::runs::js::cmp16(f.get("at").and_then(Value::as_str).unwrap_or(""), &seen).is_gt() && f.get("at").is_some_and(Value::is_string))
            .map(|f| f.get("text").and_then(Value::as_str).unwrap_or("").to_string())
            .collect();
        let untold = open.iter().any(|r| !snoozed.contains(rs(r, "key")) && ro(r, "toldAt").is_none() && (ro(r, "seenInChatAt").is_none() || rb(r, "urgent")));
        let unreached = open.iter().any(|r| {
            !snoozed.contains(rs(r, "key"))
                && ro(r, "remindersStopped").is_none()
                && !pending(r)
                && !alerted(r)
                && reminders(r).iter().any(|x| step_flag(x, "failed"))
                && steps_used(r) < REMIND_MAX_STEPS as f64
                && (ro(r, "remindUntil").is_none() || rms(r, "remindUntil") > now)
        });
        let anything = untold || unreached || checkins.iter().any(|c| !self.is_named(&c.key)) || !new_feedback.is_empty();
        Gathered { now, open, snoozed, checkins, older, states, new_feedback, anything }
    }

    fn told(r: &Rec) -> &'static str {
        if ro(r, "toldAt").is_none() {
            return "no";
        }
        if ro(r, "toldVia") != Some("helper") {
            return "direct";
        }
        if reminders(r).is_empty() { "summary" } else { "urgent" }
    }

    /// The wake's input (`HelperInput`).
    async fn input(&self, g: &Gathered, s: &HelperSettings) -> Value {
        let last_ok = ms_of(Some(&self.st_get("lastOkAt")));
        let mut items = Vec::new();
        for r in &g.open {
            let it = self.core.item(r);
            let since = if rms(r, "since").is_finite() { rms(r, "since") } else { rms(r, "queuedAt") };
            let mut m = Map::new();
            m.insert("key".into(), rs(r, "key").into());
            m.insert("type".into(), "wait".into());
            m.insert("ticket".into(), it["title"].clone());
            m.insert("board".into(), it["boardName"].clone());
            m.insert("question".into(), crate::runs::js::head16(rs(r, "question"), 1500).into());
            m.insert("label".into(), r.get("label").cloned().unwrap_or(Value::Null));
            m.insert("urgent".into(), rb(r, "urgent").into());
            m.insert("why".into(), r.get("why").filter(|w| !w.is_null()).cloned().unwrap_or(Value::Null));
            m.insert("waitingMin".into(), num(0f64.max(decide::js_round((g.now - since) / 60_000.0))));
            m.insert("new".into(), (!last_ok.is_finite() || rms(r, "queuedAt") > last_ok).into());
            m.insert("opened".into(), ro(r, "openedAt").is_some().into());
            m.insert("snoozed".into(), g.snoozed.contains(rs(r, "key")).into());
            m.insert("told".into(), Self::told(r).into());
            if ro(r, "seenInChatAt").is_some() {
                m.insert("inChat".into(), true.into());
            }
            let rem = if pending(r) { Value::String("running".into()) } else { r.get("remindersStopped").filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null) };
            m.insert("reminders".into(), rem);
            items.push(Value::Object(m));
        }
        for c in &g.checkins {
            let named = self.is_named(&c.key);
            let created = parse_date(&c.created_at).unwrap_or(f64::NAN);
            items.push(json!({
                "key": c.key, "type": "checkin", "ticket": c.title, "board": c.board_name, "question": "Raised for you by a check-in", "label": "Check-in", "urgent": false, "why": null,
                "waitingMin": num(decide::js_round((g.now - created) / 60_000.0)), "new": !named, "opened": false, "snoozed": false,
                "told": if named { "summary" } else { "no" }, "reminders": null, "meetingAt": c.meeting_at.map(|m| Value::String(local::to_string(m))).unwrap_or(Value::Null),
            }));
        }
        let night = in_night(g.now, &s.night);
        let facts = self.core.sender.facts().await;
        let st = self.state.lock().clone();
        json!({
            "now": iso(g.now), "localTime": local::to_string(g.now),
            "night": { "start": s.night.start, "end": s.night.end, "nowIsNight": night, "mayWakeAtNight": night_allowed(s) },
            "boardOnScreen": facts.on_screen, "items": items, "olderCheckins": g.older,
            "channels": vals(&self.on_channels()),
            "feedback": vals(&s.feedback_texts()), "newFeedback": vals(&g.new_feedback),
            "reactions": st.get("reactions").and_then(Value::as_array).map(|a| a.iter().map(|r| r.get("text").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()).unwrap_or_default(),
            "notes": st.get("notes").cloned().unwrap_or(Value::String(String::new())), "firstSummary": self.core.lock().waits.first_summary_pending(),
            "nextSummaryAt": summary_allowed_at(self.last_summary_at(), g.now, &s.night).map(local::to_string),
        })
    }

    /// When the last routine summary reached the user (ms), or None.
    pub fn last_summary_at(&self) -> Option<f64> {
        let list = self.core.lock().messages.list_newest(false);
        list.iter()
            .find(|m| rs(m, "level") == "summary" && m.get("sends").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.get("ok") == Some(&Value::Bool(true)))))
            .map(|m| parse_date(rs(m, "at")).unwrap_or(f64::NAN))
    }

    // ---------- a wake ----------

    /// One wake: look, ask the helper (unless nothing waits), check its decision and carry it out.
    pub async fn wake(self: &Arc<Self>) -> Option<Map<String, Value>> {
        if !self.active() || self.busy.swap(true, Ordering::SeqCst) {
            return None;
        }
        let started = self.now();
        *self.batch_at.lock() = None;
        let s = self.settings.get();
        let mut entry = Map::new();
        entry.insert("at".into(), iso(started).into());
        entry.insert("ok".into(), false.into());
        let entry = self.wake_inner(started, &s, entry).await;
        {
            let mut st = self.state.lock();
            let mut runs = st.get("runs").and_then(Value::as_array).cloned().unwrap_or_default();
            runs.push(Value::Object(entry.clone()));
            let n = runs.len();
            if n > RUNS_KEEP {
                runs.drain(..n - RUNS_KEEP);
            }
            st.insert("runs".into(), Value::Array(runs));
        }
        self.busy.store(false, Ordering::SeqCst);
        self.changed();
        Some(entry)
    }

    async fn wake_inner(self: &Arc<Self>, started: f64, s: &HelperSettings, entry: Map<String, Value>) -> Map<String, Value> {
        let at = iso(started);
        self.st_set("lastCheckAt", at.clone());
        self.hello(s).await;
        if in_night(started, &s.night) && !night_allowed(s) {
            let untold: Vec<Rec> = self.core.lock().waits.open().into_iter().filter(|r| ro(r, "toldAt").is_none()).collect();
            let n = untold.len();
            self.hold_night(untold, started, &s.night);
            let end = night_end(started, &s.night);
            self.st_set("nextWakeAt", iso(end));
            let what = if n == 0 { "nothing to do".to_string() } else { format!("holding {} for the morning", if n == 1 { "1 ticket".to_string() } else { format!("{n} tickets") }) };
            return put(put(put(entry, "ok", true), "skipped", true), "log", format!("Night: {what}; waking you at night is off."));
        }
        let g = self.gather(started, s);
        if !g.anything && self.failures() == 0.0 {
            self.st_set("nextWakeAt", Value::Null);
            {
                let mut st = self.core.lock();
                for r in &g.open {
                    if ro(r, "toldAt").is_none() && ro(r, "seenInChatAt").is_some() && !rb(r, "urgent") && ro(r, "fallbackAt").is_some() {
                        st.waits.update(rs(r, "key"), vec![("fallbackAt", Value::Null)]);
                    }
                }
                if st.waits.first_summary_pending() {
                    st.waits.set_first_summary_pending(false);
                }
            }
            return put(put(put(entry, "ok", true), "skipped", true), "log", "Nothing waits on you.");
        }
        self.st_set("lastRunAt", at);
        self.save();
        let input = self.input(&g, s).await;
        let call = SideCallInput {
            system: decide::HELPER_SYSTEM.to_string(),
            prompt: crate::runs::js::stringify(&input),
            model: Some(s.model.clone()),
            json_schema: Some(decide::DECISION_SCHEMA.clone()),
            timeout_ms: Some(RUN_TIMEOUT_MS),
            ..Default::default()
        };
        let res = (self.side)(call).await;
        let spend = self.core.root.join("helper-spend.jsonl");
        let (text, entry) = match res {
            SideCallResult::Err { error, cost_usd } => {
                let mut entry = entry;
                if let Some(c) = cost_usd.filter(|c| *c != 0.0 && c.is_finite()) {
                    let _ = add_side_spend(&spend, "helper", c, Some(self.now()));
                    entry = put(entry, "costUsd", num(c));
                }
                return self.failed(entry, &error).await;
            }
            SideCallResult::Ok { text, cost_usd, model } => {
                let _ = add_side_spend(&spend, "helper", cost_usd, Some(self.now()));
                (text, put(put(entry, "costUsd", num(cost_usd)), "model", model))
            }
        };
        let raw = match decide::parse_decision(&text) {
            Ok(v) => v,
            Err(e) => return self.failed(entry, &e).await,
        };
        if !self.active() {
            return put(put(put(entry, "ok", true), "sends", 0), "log", "The helper was turned off during this run: nothing sent.");
        }
        let now = self.now();
        let fresh = self.gather(now, s);
        let channels: Vec<String> = CHANNEL_NAMES.iter().map(|c| c.to_string()).collect();
        let on = self.on_channels();
        let feedback: Vec<String> = input.get("feedback").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
        let checked = decide::check_decision(&raw, &CheckContext { now, items: &fresh.states, channels: &channels, on: &on, night: &s.night, night_opt_in: s.night_opt_in, feedback: &feedback });
        let mut dec = match checked {
            Ok(d) => d,
            Err(e) => return self.failed(entry, &e).await,
        };
        {
            let mut st = self.state.lock();
            st.insert("failures".into(), 0.into());
            st.insert("failReason".into(), Value::Null);
            st.insert("pauseSentAt".into(), Value::Null);
            st.insert("lastOkAt".into(), entry.get("at").cloned().unwrap_or(Value::Null));
            st.insert("notes".into(), dec.notes.clone().into());
        }
        let sent = self.apply(&mut dec, &fresh, s).await;
        let mut entry = put(put(put(entry, "ok", true), "sends", sent), "log", dec.log.clone());
        if !dec.fixes.is_empty() {
            entry = put(entry, "fixes", vals(&dec.fixes));
        }
        entry
    }

    async fn failed(&self, entry: Map<String, Value>, error: &str) -> Map<String, Value> {
        let now = self.now();
        let failures = self.failures() + 1.0;
        {
            let mut st = self.state.lock();
            st.insert("failures".into(), num(failures));
            st.insert("failReason".into(), error.into());
            st.insert("lastFailAt".into(), iso(now).into());
            st.insert("nextWakeAt".into(), iso(now).into());
        }
        eprintln!("helper: run failed ({failures} in a row): {error}");
        if failures >= FAIL_LIMIT && self.st_str("pauseSentAt").is_none() {
            self.st_set("pauseSentAt", iso(now));
            self.save();
            let open: Vec<Rec> = self.core.lock().waits.open().into_iter().filter(|r| ro(r, "toldAt").is_none() && self.snoozed(rs(r, "board"), rs(r, "ticketId")).is_none()).collect();
            let held = self.core.hold_for_morning(open);
            if !held.is_empty() {
                self.core.digest(held, "fallback", "The helper couldn't run, so the board sends these itself.").await;
            }
            let next = decide::js_round(backoff_ms(failures) / 60_000.0);
            let text = [
                "The helper can't run right now, so you get each wait directly, one notification per ticket, as before.".to_string(),
                format!("What went wrong: {}", cut(error, 200)),
                format!("It keeps trying by itself (next try in about {} minute{}) and takes over again once it works.", ckanban_core::jsnum::js_string(next), if next == 1.0 { "" } else { "s" }),
            ]
            .join("\n\n");
            let mut m = NewMessage::new("pause", "The helper can't run right now: you get each wait directly", text);
            m.why = Some(error.to_string());
            self.send_or_hold(m, held_send("ckanban helper paused", "You get each wait directly until it works again", "helper-pause", Some("pause"), false)).await;
        }
        put(put(entry, "ok", false), "error", error.to_string())
    }

    /// Carries out a checked decision; returns how many messages went out.
    async fn apply(&self, dec: &mut CheckedDecision, g: &Gathered, s: &HelperSettings) -> u64 {
        let mut sent = 0;
        let first = self.core.lock().waits.first_summary_pending();
        let mut first_done = false;
        let mut unreached: HashSet<String> = HashSet::new();
        let mut retry = false;
        let mut gap_ends: Option<f64> = None;
        let sends = dec.sends.clone();
        for raw in sends {
            if !self.active() {
                return sent;
            }
            let keys: Vec<String> = raw.keys.iter().filter(|k| self.still_open(k)).cloned().collect();
            if keys.is_empty() {
                continue;
            }
            let mut send = raw.clone();
            if send.one_line.is_empty() {
                send.one_line = self.fallback_line(&keys);
            }
            if send.level == "urgent" {
                let (ok, tried, steps) = self.send_urgent(&send, keys, s).await;
                if !ok {
                    let n = tried.len();
                    unreached.extend(tried);
                    if n > 0 && steps < 2 {
                        retry = true;
                    }
                    continue;
                }
            } else {
                let allowed = if first && !first_done { None } else { summary_allowed_at(self.last_summary_at(), self.now(), &s.night) };
                if let Some(a) = allowed {
                    gap_ends = Some(gap_ends.map_or(a, |x| x.min(a)));
                    dec.fixes.push(format!("held a summary: the last one went out under 3 hours ago; the next may go at {}", clock_ms(a)));
                    continue;
                }
                if self.send_summary(&send, &keys, g, first && !first_done).await.is_some() {
                    first_done = first;
                } else {
                    continue;
                }
            }
            sent += 1;
        }
        if !self.active() {
            return sent;
        }
        let night = in_night(self.now(), &s.night);
        if first && !night {
            let seeded: Vec<String> = self.core.lock().waits.open().iter().filter(|r| rb(r, "seeded") && ro(r, "toldAt").is_none() && !g.snoozed.contains(rs(r, "key"))).map(|r| rs(r, "key").to_string()).collect();
            if !seeded.is_empty() {
                let n = seeded.len();
                let line = format!("{n} {} on you", if n == 1 { "ticket waits" } else { "tickets wait" });
                let send = CheckedSend { level: "summary".into(), one_line: line, why: String::new(), keys: seeded.clone(), steps: Vec::new(), followed: Vec::new() };
                if self.send_summary(&send, &seeded, g, !first_done).await.is_some() {
                    sent += 1;
                }
            }
            self.core.lock().waits.set_first_summary_pending(false);
        }
        let now = self.now();
        let mut next = if retry { dec.next_wake_at.min(now + URGENT_RETRY_MS) } else { dec.next_wake_at };
        if night {
            next = next.min(night_end(now, &s.night));
        }
        if let Some(gap) = gap_ends {
            next = next.min(gap);
        }
        let held: Vec<Rec> = self.core.lock().waits.open().into_iter().filter(|r| ro(r, "toldAt").is_none() && ro(r, "seenInChatAt").is_none() && !g.snoozed.contains(rs(r, "key")) && !unreached.contains(rs(r, "key"))).collect();
        if !held.is_empty() {
            if let Some(gap) = summary_allowed_at(self.last_summary_at(), now, &s.night) {
                next = next.min(gap);
            }
            let digests: Vec<f64> = held.iter().map(|r| rms(r, "digestAt")).filter(|t| t.is_finite()).collect();
            if let Some(min) = digests.into_iter().reduce(f64::min) {
                let before = min - DIGEST_LEAD_MS;
                if before > now {
                    next = next.min(look_before_digest(before, &s.night));
                }
            }
        }
        let next_iso = iso(next);
        {
            let mut st = self.core.lock();
            for r in &held {
                st.waits.update(rs(r, "key"), vec![("heldUntil", next_iso.clone().into())]);
            }
        }
        if !held.is_empty() {
            let items: Vec<Value> = held.iter().map(|r| self.core.item(r)).collect();
            let mut lines: Vec<String> = Vec::new();
            if !dec.log.is_empty() {
                lines.push(dec.log.clone());
            }
            for (it, r) in items.iter().zip(&held) {
                lines.push(format!("- {} ({}): {}", text::s(it, "title"), text::s(it, "boardName"), direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label"))));
            }
            let mut m = NewMessage::new("routine", cut1(&kept_quiet_line(held.len(), &clock_time(&next_iso))), lines.join("\n"));
            m.held = true;
            m.items = items;
            self.core.add_message(m);
        }
        self.st_set("nextWakeAt", next_iso);
        sent
    }

    fn still_open(&self, key: &str) -> bool {
        if let Some(rest) = key.strip_prefix("checkin:") {
            let (board, id) = rest.split_once('/').unwrap_or((rest, ""));
            return self.core.board.ticket(board, id).is_some_and(|t| t.status != "done");
        }
        self.core.lock().waits.get(key).is_some_and(is_open)
    }

    fn fallback_line(&self, keys: &[String]) -> String {
        let recs: Vec<Rec> = {
            let st = self.core.lock();
            keys.iter().filter_map(|k| st.waits.get(k).cloned()).collect()
        };
        if keys.len() == 1 && recs.len() == 1 {
            let r = &recs[0];
            return cut1(&format!("{}: {}", direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label")), text::s(&self.core.item(r), "title")));
        }
        if keys.len() == 1 {
            return cut1(&self.checkin_item(&keys[0]).map(|i| text::s(&i, "title").to_string()).unwrap_or_else(|| "1 ticket waits on you".into()));
        }
        format!("{} tickets wait on you", keys.len())
    }

    fn checkin_item(&self, key: &str) -> Option<Value> {
        let rest = key.strip_prefix("checkin:").unwrap_or(key);
        let (board, id) = rest.split_once('/').unwrap_or((rest, ""));
        let t = self.core.board.ticket(board, id)?;
        Some(json!({ "key": key, "board": board, "boardName": self.core.board.board_name(board), "ticketId": id, "title": t.title, "question": "Raised for you by a check-in" }))
    }

    fn boards(&self, items: &[Value]) -> bool {
        let set: HashSet<&str> = items.iter().map(|i| text::s(i, "board")).collect();
        set.len() > 1 || self.core.board.profiles().len() > 1
    }

    fn out(&self, m: &Msg, title: &str, body: &str, text: &str, urgent: bool, tag: &str) -> OutBody {
        OutBody::new(rs(m, "level"), title, body, text, None).with("tag", tag).with("urgent", urgent).with("everyDevice", urgent)
    }

    // ---------- urgent ----------

    /// Sends an urgent alert along its step chain: (reached someone, the keys tried, steps planned).
    async fn send_urgent(&self, send: &CheckedSend, keys: Vec<String>, s: &HelperSettings) -> (bool, Vec<String>, usize) {
        let now = self.now();
        let mut recs: Vec<Rec> = Vec::new();
        for k in &keys {
            let Some(r) = self.core.lock().waits.get(k).cloned() else { continue };
            if !is_open(&r) {
                continue;
            }
            if urgent_refusal(&item_state(&r, false)).is_some() {
                continue;
            }
            let until = if ro(&r, "remindUntil").is_some() { rms(&r, "remindUntil") } else { f64::INFINITY };
            if steps_used(&r) >= REMIND_MAX_STEPS as f64 || until <= now {
                self.core.lock().waits.update(k, vec![("remindersStopped", "expired".into())]);
                continue;
            }
            recs.push(r);
        }
        if recs.is_empty() {
            return (false, Vec::new(), 0);
        }
        let keys: Vec<String> = recs.iter().map(|r| rs(r, "key").to_string()).collect();
        let until = recs.iter().map(|r| if ro(r, "remindUntil").is_some() { rms(r, "remindUntil") } else { f64::INFINITY }).fold(now + REMIND_MAX_MIN * 60_000.0, f64::min);
        let left = REMIND_MAX_STEPS as f64 - recs.iter().map(steps_used).fold(f64::NEG_INFINITY, f64::max);
        let steps: Vec<decide::CheckedStep> = send.steps.iter().enumerate().filter(|(i, x)| (*i as f64) < left && (*i == 0 || now + x.after_min * 60_000.0 < until)).map(|(_, x)| x.clone()).collect();
        let items: Vec<Value> = recs.iter().map(|r| self.core.item(r)).collect();
        let next_line = match steps.get(1) {
            Some(n) => format!("{NEXT_PREFIX} on {} at {}, until {} at most, unless you open it.", label(&n.channel), clock_ms(now + n.after_min * 60_000.0), clock_ms(until)),
            None => NO_REMINDERS.to_string(),
        };
        let first_asked = crate::runs::js::truthy(Some(&self.st_get("firstUrgentAsked")));
        let ask = (!first_asked).then(|| format!("{ASK_PREFIX} Tap Got it if this was worth interrupting you, or Not urgent if it wasn't."));
        let boards = self.boards(&items);
        let overnight = self.core.held_overnight_line(&recs);
        let mut parts: Vec<String> = Vec::new();
        parts.extend(overnight.clone());
        parts.push(send.one_line.clone());
        if !send.why.is_empty() {
            parts.push(format!("Why: {}", send.why));
        }
        for (it, r) in items.iter().zip(&recs) {
            let b = if boards { format!(" ({})", text::s(it, "boardName")) } else { String::new() };
            parts.push(format!("{}{b}\n{}\n{}", text::s(it, "title"), rs(r, "question"), self.core.link(text::s(it, "board"), Some(text::s(it, "ticketId")))));
        }
        parts.push(next_line);
        parts.extend(ask);
        let text = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
        let mut m = NewMessage::new("urgent", send.one_line.clone(), text.clone());
        m.why = (!send.why.is_empty()).then(|| send.why.clone());
        m.items = items.clone();
        if let Some(o) = &overnight {
            m.held_overnight = Some(o.clone());
            m.night_ask = s.night_opt_in.is_none();
        }
        let message = self.core.add_message(m);
        let id = rs(&message, "id").to_string();
        let title = if items.len() == 1 { text::s(&items[0], "title").to_string() } else { "Urgent".into() };
        let out = self.out(&message, &title, &send.one_line, &text, true, &format!("urgent-{id}"));
        let on = self.on_channels();
        let chain = match steps.first() {
            Some(f) => step_chain(&f.channel, &steps[1..].iter().map(|x| x.channel.clone()).collect::<Vec<_>>(), &on),
            None => on,
        };
        let at = iso(now);
        let claims: Vec<waits::Claim> = recs.iter().filter(|r| ro(r, "toldAt").is_none()).map(claim_of).collect();
        self.core.mark_told(&keys, "helper", Some(&id));
        {
            let mut st = self.core.lock();
            for r in &recs {
                let mut plan = vec![json!({ "channel": steps.first().map(|x| x.channel.as_str()).unwrap_or("none"), "dueAt": at, "sentAt": at, "messageId": id })];
                plan.extend(steps.iter().skip(1).map(|x| json!({ "channel": x.channel, "dueAt": iso(now + x.after_min * 60_000.0) })));
                st.waits.update(
                    rs(r, "key"),
                    vec![
                        ("messageId", id.clone().into()),
                        ("heldUntil", Value::Null),
                        ("remindersStopped", Value::Null),
                        ("remindUntil", iso(until).into()),
                        ("stepsUsed", num(steps_used(r))),
                        ("reminders", Value::Array(plan)),
                    ],
                );
            }
        }
        let results = self.core.deliver(&message, &out, None, Some(&chain)).await;
        let ok = results.iter().any(|r| r.get("ok") == Some(&Value::Bool(true)));
        let used = results
            .iter()
            .find(|r| r.get("ok") == Some(&Value::Bool(true)))
            .and_then(|r| r.get("channel").and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| steps.first().map(|x| x.channel.clone()).unwrap_or_else(|| "none".into()));
        if !ok {
            self.core.lock().waits.unclaim(&claims);
            eprintln!("helper: urgent alert {id} reached no channel ({}); it stays untold", text::failures(&results));
        }
        {
            let mut st = self.core.lock();
            for k in &keys {
                let Some(fresh) = st.waits.get(k).cloned() else { continue };
                let list: Vec<Value> = reminders(&fresh)
                    .iter()
                    .map(|x| {
                        if x.get("messageId").and_then(Value::as_str) == Some(id.as_str()) && x.get("dueAt").and_then(Value::as_str) == Some(at.as_str()) {
                            let mut y = x.as_object().cloned().unwrap_or_default();
                            y.insert("channel".into(), used.clone().into());
                            if !ok {
                                y.insert("failed".into(), true.into());
                            }
                            Value::Object(y)
                        } else {
                            x.clone()
                        }
                    })
                    .collect();
                st.waits.update(k, vec![("reminders", Value::Array(list))]);
            }
        }
        if ok {
            self.st_set("firstUrgentAsked", true);
            if in_night(now, &s.night) {
                self.st_set("nightWokeAt", at.clone());
                self.st_set("nightWokeFor", send.one_line.clone());
            }
        }
        (self.emit)(json!({ "type": "helper.message", "id": id, "level": "urgent", "oneLine": send.one_line }));
        (ok, keys, steps.len())
    }

    /// Fires reminder steps that are due, and ends reminders past the hard expiry.
    async fn reminders(&self) {
        let now = self.now();
        let s = self.settings.get();
        let quiet = in_night(now, &s.night) && !night_allowed(&s);
        let mut due: Vec<(String, Vec<Rec>, usize)> = Vec::new();
        let mut expired: Vec<(String, Vec<Rec>)> = Vec::new();
        for r in self.core.lock().waits.open() {
            if !pending(&r) {
                continue;
            }
            let group = ro(&r, "messageId").unwrap_or(rs(&r, "key")).to_string();
            if ro(&r, "remindUntil").is_some() && rms(&r, "remindUntil") <= now {
                match expired.iter_mut().find(|(k, _)| *k == group) {
                    Some(e) => e.1.push(r),
                    None => expired.push((group, vec![r])),
                }
                continue;
            }
            if self.snoozed(rs(&r, "board"), rs(&r, "ticketId")).is_some() || quiet {
                continue;
            }
            let list = reminders(&r);
            let Some(index) = list.iter().rposition(|x| !step_sent(x) && ms_of(x.get("dueAt")) <= now) else { continue };
            let at = iso(now);
            if list.iter().take(index).any(|x| !step_sent(x)) {
                let marked: Vec<Value> = list
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        if i < index && !step_sent(x) {
                            let mut y = x.as_object().cloned().unwrap_or_default();
                            y.insert("sentAt".into(), at.clone().into());
                            y.insert("skipped".into(), true.into());
                            Value::Object(y)
                        } else {
                            x.clone()
                        }
                    })
                    .collect();
                self.core.lock().waits.update(rs(&r, "key"), vec![("reminders", Value::Array(marked))]);
            }
            let k = format!("{group}|{index}");
            match due.iter_mut().find(|(x, _, _)| *x == k) {
                Some(d) => d.1.push(r),
                None => due.push((k, vec![r], index)),
            }
        }
        let any = !due.is_empty() || !expired.is_empty();
        for (_, recs, index) in due {
            self.fire_step(recs, index).await;
        }
        for (_, recs) in expired {
            {
                let mut st = self.core.lock();
                for r in &recs {
                    st.waits.stop_reminders(rs(r, "key"), "expired");
                }
            }
            let items: Vec<Value> = recs.iter().map(|r| self.core.item(r)).collect();
            let names = items.iter().map(|i| text::s(i, "title")).collect::<Vec<_>>().join(", ");
            let text = format!("I've stopped reminding you about {names}. {} still in your Inbox.", if recs.len() == 1 { "It's" } else { "They're" });
            let mut m = NewMessage::new("reminder", cut1(&format!("I've stopped reminding you: {names}")), text);
            m.items = items;
            self.send_or_hold(m, held_send("Reminders stopped", &cut1(&format!("I've stopped reminding you: {names}")), "stopped", None, false)).await;
        }
        if any {
            self.changed();
        }
    }

    async fn fire_step(&self, recs: Vec<Rec>, index: usize) {
        let now = self.now();
        let first = &recs[0];
        let orig = ro(first, "messageId").and_then(|id| self.core.message(id));
        let items: Vec<Value> = recs.iter().map(|r| self.core.item(r)).collect();
        let steps = reminders(first).to_vec();
        let Some(step) = steps.get(index).cloned() else { return };
        let stored = self.core.lock().waits.get(rs(first, "key")).cloned().unwrap_or_else(|| first.clone());
        let skipped: Vec<bool> = reminders(&stored).iter().map(|x| step_flag(x, "skipped")).collect();
        let (n, of) = reminder_count(&skipped, index);
        let later: Vec<Value> = steps[index + 1..].to_vec();
        let next_line = match later.first() {
            Some(l) => format!(
                "Next reminder on {} at {}{}.",
                label(l.get("channel").and_then(Value::as_str).unwrap_or("")),
                clock_time(l.get("dueAt").and_then(Value::as_str).unwrap_or("")),
                ro(first, "remindUntil").map(|u| format!(", until {} at most", clock_time(u))).unwrap_or_default()
            ),
            None => "This is the last reminder.".into(),
        };
        let titles = items.iter().map(|i| text::s(i, "title")).collect::<Vec<_>>().join(", ");
        let one_line = cut1(&format!("Reminder: {}", orig.as_ref().map(|o| rs(o, "oneLine").to_string()).unwrap_or(titles)));
        let body = match &orig {
            Some(o) => reminder_body(rs(o, "text")),
            None => items.iter().map(|i| format!("{}\n{}", text::s(i, "title"), self.core.link(text::s(i, "board"), Some(text::s(i, "ticketId"))))).collect::<Vec<_>>().join("\n\n"),
        };
        let text = [format!("Reminder {n} of {of}, not opened yet."), body, next_line].join("\n\n");
        let mut m = NewMessage::new("reminder", one_line.clone(), text.clone());
        m.why = orig.as_ref().and_then(|o| ro(o, "why").map(str::to_string));
        m.items = items.clone();
        let message = self.core.add_message(m);
        let id = rs(&message, "id").to_string();
        let claimed = iso(now);
        let set_step = |st: &mut super::core::Stores, extra: &[(&str, Value)]| {
            for r in &recs {
                let Some(fresh) = st.waits.get(rs(r, "key")).cloned() else { continue };
                let list: Vec<Value> = reminders(&fresh)
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        if i == index {
                            let mut y = x.as_object().cloned().unwrap_or_default();
                            for (k, v) in extra {
                                y.insert((*k).into(), v.clone());
                            }
                            Value::Object(y)
                        } else {
                            x.clone()
                        }
                    })
                    .collect();
                st.waits.update(rs(r, "key"), vec![("reminders", Value::Array(list))]);
            }
        };
        set_step(&mut self.core.lock(), &[("sentAt", claimed.clone().into()), ("messageId", id.clone().into())]);
        let on = self.on_channels();
        let step_channel = step.get("channel").and_then(Value::as_str).unwrap_or("").to_string();
        let later_channels: Vec<String> = later.iter().map(|x| x.get("channel").and_then(Value::as_str).unwrap_or("").to_string()).collect();
        let tag = format!("urgent-{}", ro(first, "messageId").unwrap_or(&id));
        let title = if items.len() == 1 { text::s(&items[0], "title").to_string() } else { "Reminder".into() };
        let out = self.out(&message, &title, &one_line, &text, true, &tag);
        let results = self.core.deliver(&message, &out, None, Some(&step_chain(&step_channel, &later_channels, &on))).await;
        let ok = results.iter().any(|r| r.get("ok") == Some(&Value::Bool(true)));
        let used = results.iter().find(|r| r.get("ok") == Some(&Value::Bool(true))).and_then(|r| r.get("channel").and_then(Value::as_str)).map(str::to_string).unwrap_or(step_channel);
        let at = iso(now);
        let untold: Vec<String> = {
            let st = self.core.lock();
            recs.iter().filter_map(|r| st.waits.get(rs(r, "key"))).filter(|r| ro(r, "toldAt").is_none()).map(|r| rs(r, "key").to_string()).collect()
        };
        if ok {
            self.core.mark_told(&untold, "helper", Some(&id));
        } else {
            eprintln!("helper: reminder {id} reached no channel ({})", text::failures(&results));
            if !untold.is_empty() && later.is_empty() {
                self.request_wake(now + URGENT_RETRY_MS);
            }
        }
        {
            let mut st = self.core.lock();
            for r in &recs {
                let Some(fresh) = st.waits.get(rs(r, "key")).cloned() else { continue };
                let list: Vec<Value> = reminders(&fresh)
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        if i == index {
                            let mut y = x.as_object().cloned().unwrap_or_default();
                            y.insert("channel".into(), used.clone().into());
                            y.insert("sentAt".into(), at.clone().into());
                            y.insert("messageId".into(), id.clone().into());
                            if !ok {
                                y.insert("failed".into(), true.into());
                            }
                            Value::Object(y)
                        } else {
                            x.clone()
                        }
                    })
                    .collect();
                let mut done = fresh.clone();
                done.insert("reminders".into(), Value::Array(list.clone()));
                let over = later.is_empty() && ro(&fresh, "remindersStopped").is_none() && !pending(&done) && alerted(&done);
                let mut patch = vec![("reminders", Value::Array(list))];
                if over {
                    patch.push(("remindersStopped", "expired".into()));
                }
                st.waits.update(rs(r, "key"), patch);
            }
        }
        (self.emit)(json!({ "type": "helper.message", "id": id, "level": "reminder", "oneLine": one_line }));
    }

    // ---------- summaries ----------

    async fn send_summary(&self, send: &CheckedSend, keys: &[String], g: &Gathered, first: bool) -> Option<Msg> {
        let wait_keys: Vec<&String> = keys.iter().filter(|k| !k.starts_with("checkin:")).collect();
        let check_keys: Vec<&String> = keys.iter().filter(|k| k.starts_with("checkin:")).collect();
        let (named, open) = {
            let st = self.core.lock();
            (wait_keys.iter().filter_map(|k| st.waits.get(k).cloned()).collect::<Vec<_>>(), st.waits.open())
        };
        let fresh: Vec<Rec> = named.into_iter().filter(|r| ro(r, "toldAt").is_none() && ro(r, "seenInChatAt").is_none()).collect();
        let fresh_keys: HashSet<String> = fresh.iter().map(|r| rs(r, "key").to_string()).collect();
        let still: Vec<Rec> = open.into_iter().filter(|r| (ro(r, "toldAt").is_some() || ro(r, "seenInChatAt").is_some()) && !fresh_keys.contains(rs(r, "key")) && !g.snoozed.contains(rs(r, "key"))).collect();
        let new_checks: Vec<Value> = check_keys.iter().filter_map(|k| self.checkin_item(k)).collect();
        if fresh.is_empty() && !new_checks.iter().any(|c| !self.is_named(text::s(c, "key"))) {
            return None;
        }
        let fresh_items: Vec<Value> = fresh.iter().map(|r| self.core.item(r)).collect();
        let still_items: Vec<Value> = still.iter().map(|r| self.core.item(r)).collect();
        let all: Vec<Value> = fresh_items.iter().chain(still_items.iter()).chain(new_checks.iter()).cloned().collect();
        let boards = self.boards(&all);
        let total = fresh.len();
        let one_line = summary_line(total, &send.one_line);
        let offer = if first {
            let facts = self.core.sender.facts().await;
            let any_checkin = self.core.board.profiles().iter().any(|(slug, _)| self.core.board.has_checkin(slug));
            (facts.connected && !any_checkin).then(|| "Want me to watch your calendar and messages too? Set up a check-in in Schedules → Proactive check-ins (one tap: Set up check-ins).".to_string())
        } else {
            None
        };
        let input = |it: &Value, r: &Rec| SummaryInput {
            key: Some(rs(r, "key").to_string()),
            board: text::s(it, "board").into(),
            board_name: text::s(it, "boardName").into(),
            ticket_id: text::s(it, "ticketId").into(),
            title: text::s(it, "title").into(),
            label: direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label")),
            since: ro(r, "since").unwrap_or(rs(r, "queuedAt")).to_string(),
        };
        let now = self.now();
        let week = day_key(week_start(now));
        let recap = if self.st_str("recapWeek").as_deref() != Some(week.as_str()) {
            let all = self.core.lock().waits.all_values();
            let days: HashMap<String, f64> = read_side_spend(&self.core.root.join("helper-spend.jsonl")).days.into_iter().collect();
            week_recap_line(&all, &days, now)
        } else {
            None
        };
        let mut notes: Vec<String> = Vec::new();
        if first {
            notes.push("This is your first summary from the helper. Routine things come grouped like this; only urgent ones interrupt you.".into());
        }
        notes.extend(offer);
        notes.extend(send.followed.iter().map(|f| you_said(f)));
        notes.extend(recap);
        let checkins: Vec<SummaryInput> = new_checks
            .iter()
            .map(|c| {
                let title = text::s(c, "title");
                let since = self.core.board.ticket(text::s(c, "board"), text::s(c, "ticketId")).map(|t| t.created_at.clone()).unwrap_or_else(|| iso(self.now()));
                SummaryInput {
                    key: Some(text::s(c, "key").into()),
                    board: text::s(c, "board").into(),
                    board_name: text::s(c, "boardName").into(),
                    ticket_id: text::s(c, "ticketId").into(),
                    title: title.into(),
                    label: if title.to_lowercase().starts_with("prep:") { "prep ready".into() } else { "raised for you".into() },
                    since,
                }
            })
            .collect();
        let (text, view) = build_summary(&SummaryBuild {
            headline: one_line.clone(),
            fresh: fresh.iter().zip(&fresh_items).map(|(r, it)| input(it, r)).collect(),
            still: still.iter().zip(&still_items).map(|(r, it)| input(it, r)).collect(),
            checkins,
            older_checkins: g.older,
            notes,
            boards,
            now: self.now(),
        });
        let title = if total == 0 { "From your check-ins".to_string() } else if total == 1 { "1 new ticket waits on you".into() } else { format!("{total} new tickets wait on you") };
        let overnight = self.core.held_overnight_line(&fresh);
        let night_ask = overnight.is_some() && self.settings.get().night_opt_in.is_none();
        let mut m = NewMessage::new("summary", one_line.clone(), overnight.as_ref().map(|o| format!("{o}\n\n{text}")).unwrap_or(text));
        m.items = fresh_items.iter().chain(new_checks.iter()).chain(still_items.iter()).cloned().collect();
        m.summary = Some(view);
        if let Some(o) = &overnight {
            m.held_overnight = Some(o.clone());
            m.night_ask = night_ask;
        }
        let message = self.core.add_message(m);
        let id = rs(&message, "id").to_string();
        let claims: Vec<waits::Claim> = fresh.iter().map(claim_of).collect();
        self.core.mark_told(&fresh_keys_in_order(&fresh), "helper", Some(&id));
        {
            let mut st = self.core.lock();
            for r in &fresh {
                st.waits.update(rs(r, "key"), vec![("heldUntil", Value::Null), ("messageId", id.clone().into())]);
            }
        }
        let out = self.out(&message, &title, &one_line, rs(&message, "text"), false, "helper-summary");
        let results = self.core.deliver(&message, &out, None, None).await;
        let tried: Vec<&Value> = results.iter().filter(|r| !crate::runs::js::truthy(r.get("skipped"))).collect();
        if !tried.is_empty() && !tried.iter().any(|r| r.get("ok") == Some(&Value::Bool(true))) {
            self.core.lock().waits.unclaim(&claims);
            eprintln!("helper: summary {id} reached no channel ({}); its new items stay untold", text::failures(&results));
        } else {
            self.st_set("recapWeek", week);
        }
        let at = iso(self.now());
        {
            let mut st = self.state.lock();
            let named = st.entry("named").or_insert_with(|| json!({}));
            if let Some(n) = named.as_object_mut() {
                for c in &new_checks {
                    n.insert(text::s(c, "key").into(), at.clone().into());
                }
            }
        }
        (self.emit)(json!({ "type": "helper.message", "id": id, "level": "summary", "oneLine": one_line }));
        Some(message)
    }

    // ---------- the first run ----------

    async fn hello(&self, s: &HelperSettings) {
        if self.st_str("helloSentAt").is_some() {
            return;
        }
        let at = iso(self.now());
        self.st_set("helloSentAt", at.clone());
        self.save();
        let mut parts = vec![
            "Hi, I'm the helper. I now sit in front of your ckanban notifications: routine things come grouped in a summary, and only urgent ones interrupt you, repeating until you act.".to_string(),
            "Tap any message to read it in full. If you got this, this channel works.".into(),
            format!("My night is {} to {}; change it in Settings. Alerts need this Mac on and awake; a closed lid means no alerts.", s.night.start, s.night.end),
            "ntfy can get through Focus if you allow the ntfy app in that Focus; for Telegram, allow Telegram in your Focus (not guaranteed).".into(),
            "Want to see what an urgent alert looks like? Open this message on the board and tap Try a pretend urgent alert.".into(),
        ];
        if s.night_opt_in.is_none() {
            parts.push(format!("{} Until you choose, nothing wakes you at night. Answer on this message's page or in Settings.", night_question(&s.night)));
        }
        if self.st_str("nightNoticeAt").is_none() {
            self.st_set("nightNoticeAt", at);
        }
        self.save();
        let mut m = NewMessage::new("hello", "Hi, I'm the helper: routine things come grouped, urgent ones interrupt", parts.join("\n\n"));
        m.night_ask = s.night_opt_in.is_none();
        self.send_or_hold(m, held_send("ckanban helper", "Routine things come grouped now; only urgent ones interrupt you", "helper-hello", None, false)).await;
    }

    // ---------- held for the morning ----------

    async fn send_or_hold(&self, m: NewMessage, o: Map<String, Value>) {
        let message = self.core.add_message(m);
        let night = self.settings.get().night;
        if in_night(self.now(), &night) {
            let mut held = Map::new();
            held.insert("messageId".into(), message.get("id").cloned().unwrap_or(Value::Null));
            held.extend(o);
            {
                let mut st = self.state.lock();
                let mut list = st.get("heldSends").and_then(Value::as_array).cloned().unwrap_or_default();
                list.push(Value::Object(held));
                st.insert("heldSends".into(), Value::Array(list));
            }
            self.save();
            self.request_wake(night_end(self.now(), &night));
            return;
        }
        self.core.deliver(&message, &held_out(&message, &o), None, None).await;
    }

    async fn send_held(&self) {
        let held = self.st_get("heldSends").as_array().cloned().unwrap_or_default();
        if held.is_empty() || in_night(self.now(), &self.settings.get().night) {
            return;
        }
        self.st_set("heldSends", json!([]));
        self.save();
        for x in held {
            if !self.active() {
                return;
            }
            let o = x.as_object().cloned().unwrap_or_default();
            if o.get("kind").and_then(Value::as_str) == Some("pause") && self.healthy() {
                continue;
            }
            if let Some(message) = o.get("messageId").and_then(Value::as_str).and_then(|id| self.core.message(id)) {
                self.core.deliver(&message, &held_out(&message, &o), None, None).await;
            }
        }
        self.changed();
    }

    // ---------- the night question ----------

    async fn night_notice(&self) {
        let s = self.settings.get();
        if self.st_str("nightNoticeAt").is_some() || self.st_str("helloSentAt").is_none() || s.night_opt_in.is_some() || in_night(self.now(), &s.night) {
            return;
        }
        self.st_set("nightNoticeAt", iso(self.now()));
        self.save();
        let text = [
            night_question(&s.night),
            "Until you choose, nothing wakes you at night: urgent things wait for the morning, and the morning message says what was held. You can change it any time in Settings.".to_string(),
        ]
        .join("\n\n");
        let mut m = NewMessage::new("hello", "Should urgent alerts wake you at night?", text);
        m.night_ask = true;
        let message = self.core.add_message(m);
        self.core.deliver(&message, &held_out(&message, &held_send("ckanban helper", "Should urgent alerts wake you at night?", "helper-night", None, true)), None, None).await;
        self.changed();
    }

    async fn ask_about_night_wake(&self) {
        let Some(at) = self.st_str("nightWokeAt") else { return };
        let now = self.now();
        let s = self.settings.get();
        if in_night(now, &s.night) {
            return;
        }
        let what = self.st_str("nightWokeFor").unwrap_or_else(|| "an urgent alert".into());
        self.st_set("nightWokeAt", Value::Null);
        self.st_set("nightWokeFor", Value::Null);
        self.save();
        if now - parse_date(&at).unwrap_or(f64::NAN) > NIGHT_ASK_MAX_MS {
            return;
        }
        let text = [
            format!("Last night at {} I woke you for: {what}", clock_time(&at)),
            "Was that worth waking you for? If it could have waited, open that alert and tap Not urgent, or tell me under What the helper knows about you. I'll go by it next time.".to_string(),
        ]
        .join("\n\n");
        let message = self.core.add_message(NewMessage::new("direct", cut1(&format!("Was it right to wake you at {}?", clock_time(&at))), text));
        let body = cut1(&format!("Was it right to wake you at {}? {what}", clock_time(&at)));
        self.core.deliver(&message, &held_out(&message, &held_send("ckanban helper", &body, "helper-night-ask", None, false)), None, None).await;
        self.changed();
    }

    /// Yes / Not at night (Telegram's buttons): saves the user's choice.
    pub fn night_answer(&self, _message_id: &str, allow: bool) -> Result<String, HelperError> {
        let cur = self.settings.get();
        if let Some(chose) = cur.night_opt_in {
            let now = if chose { "urgent alerts may wake you at night" } else { "nothing wakes you at night" };
            return Ok(format!("You already chose: {now}. Change it in Settings."));
        }
        let s = self.settings.update(&json!({ "nightOptIn": allow })).map_err(|e| (400, e))?;
        self.react(if allow { "Said yes to urgent alerts at night" } else { "Said not at night" });
        self.changed();
        Ok(night_answer_text(allow, &s.night))
    }

    /// After Got it / Not urgent on a practice alert: the night question next while the user hasn't chosen.
    pub fn night_after(&self, message_id: &str) -> Option<String> {
        let m = self.core.message(message_id)?;
        let s = self.settings.get();
        (crate::runs::js::truthy(m.get("practice")) && s.night_opt_in.is_none()).then(|| night_question(&s.night))
    }

    // ---------- the practice alert ----------

    /// A pretend urgent alert the user asked for; never a wait.
    pub async fn practice(&self) -> Result<Value, HelperError> {
        if !self.active() {
            return Err((409, "Turn the helper on first".into()));
        }
        let now = self.now();
        let due = iso(now + PRACTICE_REMIND_MS);
        let one_line = "Practice alert: tap Got it to stop the reminder";
        let why = "Nothing is wrong: you asked to see what an urgent alert looks like.";
        let text = [
            one_line.to_string(),
            format!("Why: {why}"),
            "A real alert names the ticket and what waiting costs, like customers billed twice, and keeps reminding you until you open it or tap Got it or Not urgent.".into(),
            format!("{NEXT_PREFIX} once at {}, unless you tap Got it or Not urgent.", clock_time(&due)),
        ]
        .join("\n\n");
        let mut m = NewMessage::new("test", one_line, text.clone());
        m.why = Some(why.into());
        m.practice = true;
        let message = self.core.add_message(m);
        let id = rs(&message, "id").to_string();
        self.st_set("practice", json!({ "messageId": id, "dueAt": due, "reminderId": null }));
        self.changed();
        let out = self.out(&message, "Practice alert", one_line, &text, true, &format!("urgent-{id}")).with("practice", true);
        self.core.deliver(&message, &out, None, None).await;
        Ok(json!({ "messageId": id }))
    }

    async fn practice_reminder(&self) {
        let p = self.st_get("practice");
        if !p.is_object() || p.get("reminderId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) || ms_of(p.get("dueAt")) > self.now() {
            return;
        }
        let orig = p.get("messageId").and_then(Value::as_str).and_then(|id| self.core.message(id));
        let Some(orig) = orig.filter(|o| !crate::runs::js::truthy(o.get("tapped"))) else {
            self.st_set("practice", Value::Null);
            self.save();
            return;
        };
        let one_line = cut1(&format!("Reminder: {}", rs(&orig, "oneLine")));
        let text = ["Reminder 1 of 1, not opened yet.".to_string(), reminder_body(rs(&orig, "text")), "This is the last reminder.".into()].join("\n\n");
        let mut m = NewMessage::new("test", one_line.clone(), text.clone());
        m.why = ro(&orig, "why").map(str::to_string);
        m.practice = true;
        let message = self.core.add_message(m);
        let mut np = p.as_object().cloned().unwrap_or_default();
        np.insert("reminderId".into(), message.get("id").cloned().unwrap_or(Value::Null));
        self.st_set("practice", Value::Object(np));
        self.save();
        let out = self.out(&message, "Practice alert", &one_line, &text, true, &format!("urgent-{}", rs(&orig, "id"))).with("practice", true);
        self.core.deliver(&message, &out, None, None).await;
        self.changed();
    }

    fn practice_tap(&self, message: &Msg, how: &str) -> Value {
        let p = self.st_get("practice");
        let mut ids = vec![rs(message, "id").to_string()];
        let mut stopped = 0;
        let pid = p.get("messageId").and_then(Value::as_str).unwrap_or("");
        let rid = p.get("reminderId").and_then(Value::as_str).filter(|s| !s.is_empty());
        if p.is_object() && (pid == rs(message, "id") || rid == Some(rs(message, "id"))) {
            ids.push(pid.to_string());
            match rid {
                Some(r) => ids.push(r.to_string()),
                None => stopped = 1,
            }
            self.st_set("practice", Value::Null);
        }
        let mut seen = HashSet::new();
        {
            let mut st = self.core.lock();
            for id in ids {
                if seen.insert(id.clone()) {
                    st.messages.mark_tapped(&id, how);
                }
            }
        }
        self.changed();
        json!({ "stopped": stopped, "text": PRACTICE_STOPPED })
    }

    // ---------- the user's taps ----------

    fn react(&self, text: &str) {
        let at = iso(self.now());
        let mut st = self.state.lock();
        let mut list = st.get("reactions").and_then(Value::as_array).cloned().unwrap_or_default();
        list.push(json!({ "at": at, "text": text }));
        let n = list.len();
        if n > REACTIONS_KEEP {
            list.drain(..n - REACTIONS_KEEP);
        }
        st.insert("reactions".into(), Value::Array(list));
    }

    fn tapped(&self, message_id: &str, key: Option<&str>) -> Result<(Msg, Vec<Rec>), HelperError> {
        let message = self.core.message(message_id).ok_or((404, "message not found".to_string()))?;
        let mut st = self.core.lock();
        let recs: Vec<Rec> = messages::items(&message)
            .iter()
            .filter_map(|i| i.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()))
            .filter(|k| key.is_none_or(|x| x == *k))
            .filter_map(|k| st.waits.for_message(k, rs(&message, "id"), rs(&message, "at")))
            .collect();
        st.messages.mark_read(rs(&message, "id"));
        Ok((message, recs))
    }

    fn mark_tapped(&self, message: &Msg, recs: &[Rec], how: &str) {
        let mut ids: Vec<String> = vec![rs(message, "id").to_string()];
        for r in recs {
            if let Some(m) = ro(r, "messageId") {
                ids.push(m.into());
            }
            for x in reminders(r) {
                if let Some(m) = x.get("messageId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    ids.push(m.into());
                }
            }
        }
        let mut seen = HashSet::new();
        let mut st = self.core.lock();
        for id in ids {
            if seen.insert(id.clone()) {
                st.messages.mark_tapped(&id, how);
            }
        }
    }

    /// A tap from Telegram or the board's buttons, as a short reply (`tap`).
    pub fn tap_text(r: Result<Value, HelperError>) -> String {
        match r {
            Ok(v) => v.get("text").and_then(Value::as_str).unwrap_or("").to_string(),
            Err((404, _)) => "That message is gone.".into(),
            Err((_, e)) => {
                eprintln!("helper: tap {e}");
                "That didn't work. Try again on the board.".into()
            }
        }
    }

    /// Got it: reminders for this message's items stop, and don't come back.
    pub fn got_it(&self, message_id: &str, key: Option<&str>) -> Result<Value, HelperError> {
        if let Some(p) = self.core.message(message_id).filter(|m| crate::runs::js::truthy(m.get("practice"))) {
            return Ok(self.practice_tap(&p, "got-it"));
        }
        let (message, recs) = self.tapped(message_id, key)?;
        self.mark_tapped(&message, &recs, "got-it");
        let before: Vec<Option<String>> = recs
            .iter()
            .map(|r| {
                if reminders(r).is_empty() {
                    return None;
                }
                match r.get("remindersStopped").filter(|x| !x.is_null()) {
                    Some(s) => Some(s.as_str().unwrap_or("").to_string()),
                    None if ro(r, "closedAt").is_some() => Some(r.get("closedWhy").filter(|x| !x.is_null()).and_then(Value::as_str).unwrap_or("closed").to_string()),
                    None => None,
                }
            })
            .collect();
        let mut stopped = 0;
        {
            let mut st = self.core.lock();
            for r in &recs {
                if st.waits.stop_reminders(rs(r, "key"), "got-it") {
                    stopped += 1;
                } else if ro(r, "remindersStopped").is_none() && !reminders(r).is_empty() {
                    st.waits.update(rs(r, "key"), vec![("remindersStopped", "got-it".into())]);
                }
            }
        }
        let names = self.names(&recs);
        self.react(&format!("Got it on \"{names}\" at {}", clock_ms(self.now())));
        self.changed();
        if stopped > 0 {
            return Ok(json!({ "stopped": stopped, "text": format!("Got it: no more reminders for {names}") }));
        }
        let text = match before.into_iter().flatten().find(|w| !w.is_empty()) {
            Some(why) => format!("Got it: reminders for {names} had already stopped ({})", stopped_why(&why)),
            None => format!("Got it: {names}"),
        };
        Ok(json!({ "stopped": stopped, "text": text }))
    }

    fn names(&self, recs: &[Rec]) -> String {
        let n = recs.iter().map(|r| text::s(&self.core.item(r), "title").to_string()).collect::<Vec<_>>().join(", ");
        if n.is_empty() { "this".into() } else { n }
    }

    /// Not urgent: that item's reminders stop at once.
    pub fn not_urgent(&self, message_id: &str, key: Option<&str>) -> Result<Value, HelperError> {
        if let Some(p) = self.core.message(message_id).filter(|m| crate::runs::js::truthy(m.get("practice"))) {
            return Ok(self.practice_tap(&p, "not-urgent"));
        }
        let (message, recs) = self.tapped(message_id, key)?;
        self.mark_tapped(&message, &recs, "not-urgent");
        let mut stopped = 0;
        {
            let mut st = self.core.lock();
            for r in &recs {
                if st.waits.stop_reminders(rs(r, "key"), "not-urgent") {
                    stopped += 1;
                } else {
                    st.waits.update(rs(r, "key"), vec![("remindersStopped", "not-urgent".into())]);
                }
            }
        }
        let names = self.names(&recs);
        self.react(&format!("Not urgent on \"{names}\""));
        self.changed();
        Ok(json!({ "stopped": stopped, "text": format!("Stopped reminders for {names}") }))
    }

    /// Should have pinged me, on a held item: a feedback line, and the helper looks again at once.
    pub fn should_have_pinged(&self, board: &str, ticket: &str) -> Result<Value, HelperError> {
        let recs = self.core.lock().waits.open_for(board, Some(ticket));
        let t = self.core.board.ticket(board, ticket).ok_or((404, "ticket not found".to_string()))?;
        let what = recs.first().map(|r| direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label"))).unwrap_or_else(|| "what it waited on".into());
        let line = self.settings.add_feedback(Some(&Value::String(cut(&format!("Should have pinged me about \"{}\": {what}", t.title), 300))), "should-have-pinged").map_err(|e| (400, e))?;
        self.react(&format!("Should have pinged me on \"{}\"", t.title));
        self.request_wake(self.now());
        self.changed();
        Ok(json!({ "text": line.get("text").cloned().unwrap_or(Value::Null) }))
    }

    /// A feedback line was added: the helper looks again at once.
    pub fn feedback_added(&self) {
        self.request_wake(self.now());
        self.changed();
    }

    pub fn notice_seen(&self) {
        if self.st_str("noticeSeenAt").is_some() {
            return;
        }
        self.st_set("noticeSeenAt", iso(self.now()));
        self.changed();
    }

    // ---------- keep awake, status ----------

    /// Keep the Mac awake: an urgent item is open, a wake or reminder is due within 15 minutes, or a fallback is.
    pub fn wants_awake(&self) -> bool {
        if !self.active() {
            return false;
        }
        let now = self.now();
        let soon = now + AWAKE_AHEAD_MS;
        if self.due_at().is_some_and(|d| d <= soon) {
            return true;
        }
        for r in self.core.lock().waits.open() {
            if pending(&r) {
                return true;
            }
            let stopped = matches!(ro(&r, "remindersStopped"), Some("got-it" | "not-urgent"));
            if rb(&r, "urgent") && ro(&r, "toldAt").is_none() && !stopped {
                return true;
            }
            let seen = ro(&r, "seenInChatAt").is_some();
            let fb = ro(&r, "fallbackAt").is_some() && rms(&r, "fallbackAt") <= soon && !(seen && rms(&r, "fallbackAt") < now);
            let dg = !seen && ro(&r, "digestAt").is_some() && rms(&r, "digestAt") <= soon;
            if ro(&r, "toldAt").is_none() && (fb || dg) {
                return true;
            }
        }
        false
    }

    /// The helper line for one record, or None.
    fn line_for(&self, r: &Rec) -> Option<String> {
        if self.snoozed(rs(r, "board"), rs(r, "ticketId")).is_some() {
            return Some("Snoozed: the helper leaves it out until the snooze ends".into());
        }
        let list = reminders(r);
        if !list.is_empty() {
            let trail = list
                .iter()
                .filter(|x| !step_flag(x, "skipped"))
                .map(|x| {
                    let at = x.get("sentAt").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| x.get("dueAt").and_then(Value::as_str)).unwrap_or("");
                    format!("{} {}{}", label(x.get("channel").and_then(Value::as_str).unwrap_or("")), clock_time(at), if step_flag(x, "failed") { " (didn't get through)" } else { "" })
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Some(match ro(r, "remindersStopped") {
                Some("got-it") => format!("Urgent: {trail}; you tapped Got it"),
                Some("not-urgent") => format!("Urgent: {trail}; you said not urgent"),
                Some("opened") => format!("Urgent: {trail}; reminders stopped when you opened this"),
                Some("expired") => format!("Urgent: {trail}; reminders stopped"),
                _ => format!("Urgent: {trail}"),
            });
        }
        if let Some(t) = ro(r, "toldAt") {
            return match ro(r, "toldVia") {
                Some("helper") => Some(format!("In the {} summary", clock_time(t))),
                Some("direct" | "digest") => Some(format!("Sent directly at {}", clock_time(t))),
                _ => None,
            };
        }
        if let Some(h) = ro(r, "heldUntil") {
            return Some(format!("In the {} summary: {}", clock_time(h), direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label"))));
        }
        Some("With the helper: it looks within a minute or two".into())
    }

    /// The status the screens show (GET /api/helper).
    pub async fn status(&self) -> Value {
        let ns = self.core.settings();
        let s = self.settings.get();
        let on = self.core.plugged(&ns);
        let open = self.core.lock().waits.open();
        let mut lines = Map::new();
        let mut line_msg = Map::new();
        let mut waiting = 0;
        if on {
            let rank = |r: &Rec| if pending(r) { 0 } else if ro(r, "toldAt").is_none() { 1 } else { 2 };
            let mut sorted = open.clone();
            sorted.sort_by_key(rank);
            for r in &sorted {
                if self.snoozed(rs(r, "board"), rs(r, "ticketId")).is_none() {
                    waiting += 1;
                }
                let k = format!("{}/{}", rs(r, "board"), rs(r, "ticketId"));
                if lines.contains_key(&k) {
                    continue;
                }
                let Some(l) = self.line_for(r) else { continue };
                lines.insert(k.clone(), l.into());
                let sent: Vec<&Value> = reminders(r).iter().filter(|x| x.get("messageId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) && step_sent(x) && !step_flag(x, "skipped")).collect();
                let msg = sent.last().and_then(|x| x.get("messageId").and_then(Value::as_str)).or_else(|| ro(r, "messageId"));
                if let Some(m) = msg
                    && self.core.message(m).is_some()
                {
                    line_msg.insert(k, m.into());
                }
            }
        }
        let enabled = enabled(&ns);
        let facts = self.core.sender.facts().await;
        let only_mac = !enabled.iter().any(|n| n != "mac" && n != "push") && facts.phone_devices == 0;
        let failures = self.failures();
        let paused = failures >= FAIL_LIMIT;
        let reason = self.st_str("failReason");
        let checked = match self.st_str("lastCheckAt") {
            Some(c) => format!("checked {}", clock_time(&c)),
            None => "not checked yet".into(),
        };
        let line = if !on {
            "Helper off: you get one notification per wait".to_string()
        } else if paused {
            format!("Helper paused: {}. You get each wait directly.", cut(reason.as_deref().unwrap_or("its runs fail"), 80))
        } else if failures > 0.0 {
            format!("Helper on, last try failed: {}", cut(reason.as_deref().unwrap_or(""), 80))
        } else {
            let w = if waiting > 0 { format!("{waiting} wait{} on you", if waiting == 1 { "s" } else { "" }) } else { "nothing waits on you".into() };
            format!("Helper on, {checked}, {w}")
        };
        let st = self.state.lock().clone();
        let runs = st.get("runs").and_then(Value::as_array).cloned().unwrap_or_default();
        let runs: Vec<Value> = runs[runs.len().saturating_sub(10)..].to_vec();
        let spend = read_side_spend(&self.core.root.join("helper-spend.jsonl"));
        let day = day_key(self.now());
        let checks = spend.calls.iter().find(|(d, _)| *d == day).map(|(_, c)| *c).unwrap_or(0);
        let cost = spend.days.iter().find(|(d, _)| *d == day).map(|(_, c)| *c).unwrap_or(0.0);
        let g = |k: &str| st.get(k).cloned().unwrap_or(Value::Null);
        json!({
            "on": on, "model": s.model, "night": s.night.to_json(), "nightOptIn": s.night_opt_in, "lastCheckAt": g("lastCheckAt"), "lastOkAt": g("lastOkAt"),
            "nextWakeAt": if on { self.due_at().map(|d| Value::String(iso(d))).unwrap_or(Value::Null) } else { Value::Null },
            "failures": num(failures), "failReason": g("failReason"), "paused": paused, "onlyMac": only_mac, "notice": st.get("noticeSeenAt").and_then(Value::as_str).is_none_or(str::is_empty), "line": line,
            "problem": on && failures > 0.0, "waiting": waiting, "lines": lines, "lineMsg": line_msg, "today": { "checks": checks, "costUsd": num(cost) }, "runs": runs,
        })
    }
}

fn fresh_keys_in_order(recs: &[Rec]) -> Vec<String> {
    recs.iter().map(|r| rs(r, "key").to_string()).collect()
}

/// The board's state of a record for the decision checks (`itemState`).
fn item_state(r: &Rec, snoozed: bool) -> ItemState {
    ItemState {
        open: ro(r, "closedAt").is_none(),
        snoozed,
        checkin: false,
        told: ro(r, "toldAt").is_some(),
        pending_reminders: pending(r),
        stopped: r.get("remindersStopped").filter(|x| !x.is_null()).map(|x| x.as_str().unwrap_or("").to_string()),
        opened: ro(r, "openedAt").is_some(),
        alerted: alerted(r),
    }
}

/// A held send's fields after its message id (`Omit<HeldSend, "messageId">`).
fn held_send(title: &str, body: &str, tag: &str, kind: Option<&str>, night_ask: bool) -> Map<String, Value> {
    let mut o = Map::new();
    o.insert("title".into(), title.into());
    o.insert("body".into(), body.into());
    o.insert("tag".into(), tag.into());
    if let Some(k) = kind {
        o.insert("kind".into(), k.into());
    }
    if night_ask {
        o.insert("nightAsk".into(), true.into());
    }
    o
}

fn held_out(message: &Msg, o: &Map<String, Value>) -> OutBody {
    let tag = o.get("tag").and_then(Value::as_str).unwrap_or("");
    let tag = if tag == "stopped" { format!("stopped-{}", rs(message, "id")) } else { tag.to_string() };
    let mut out = OutBody::new(
        rs(message, "level"),
        o.get("title").and_then(Value::as_str).unwrap_or(""),
        o.get("body").and_then(Value::as_str).unwrap_or(""),
        rs(message, "text"),
        None,
    )
    .with("tag", tag);
    if crate::runs::js::truthy(o.get("nightAsk")) {
        out = out.with("nightAsk", true);
    }
    out
}

impl HelperSink for HelperRunner {
    fn healthy(&self) -> bool {
        self.failures() < FAIL_LIMIT
    }
    fn last_success_at(&self) -> Option<f64> {
        let t = ms_of(Some(&self.st_get("lastOkAt")));
        t.is_finite().then_some(t)
    }
    fn on_wait(&self, rec: &Rec, reason: Reason) {
        self.wait_arrived(rec, reason);
    }
    fn morning(&self, now: f64) -> Option<f64> {
        let night = self.settings.get().night;
        in_night(now, &night).then(|| morning_digest_at(now, &night))
    }
    fn night_allowed(&self) -> bool {
        self.night_allowed_now()
    }
}
