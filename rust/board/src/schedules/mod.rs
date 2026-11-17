//! R10: schedules, one-time jobs and automations (`src/schedules/` and `src/integrations/script.ts`,
//! `ask-claude.ts`, `ticket-text.ts`), in board mode. `Schedules` holds the three:
//! - `scheduler`: repeating schedules (`scheduler.ts`): create, change, pause, history, run now, and the timer that
//!   fires due ones (a ticket that runs right away, or a task of a feature);
//! - `jobs`: one-time jobs (`jobs.ts`): a ticket or a command at a set time, late rules, recovery after a restart;
//! - `loops`: automations (`loops.ts`): check scripts on a timer, new items into tickets, Ask Claude first, and
//!   `ckanban call` through the check's token (`/api/automation-call`; the tool call itself goes to the satellite,
//!   which holds the passes' sign-ins).
//!
//! Only the board's owner fires: board mode starts these timers in Rust, and Bun's satellite starts none of its own.
//! Files are Bun's, byte for byte (`files`), so either side reads what the other wrote. Blocking: the routes and the
//! timers call in from the blocking pool; one schedule fire, one job fire and one check of an automation at a time,
//! as Bun's promise queues do.
//!
//! The check-in setup chat's guides (`checkin-guides.ts`) are in `prompts::deps`; the setup chat's automation card
//! (`automation-proposal.ts`) is read in `sessions::cards`.

pub mod cron;
pub mod files;
pub mod history;
pub mod jobs;
pub mod loops;
pub mod passbook;
pub mod routes;
pub mod scheduler;
pub mod script;
pub mod sha256;
pub mod text;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::api::Satellite;
use crate::bus::Bus;
use crate::families::board::Families;
use crate::index::ticket::Tk;
use crate::runloop::RunLoop;
use crate::runs::side_call::{SideCallInput, SideCallResult};
use crate::tickets::writer::Tickets;
use files::{Files, Obj};
use passbook::PassBook;

/// A refusal: HTTP status and message.
pub type Fail = (u16, String);

pub fn fail(status: u16, m: impl Into<String>) -> Fail {
    (status, m.into())
}

/// The side call Ask Claude first makes (`extras::side_caller()` in board mode).
pub type SideFn = Arc<dyn Fn(SideCallInput) -> futures_util::future::BoxFuture<'static, SideCallResult> + Send + Sync>;

pub struct Deps {
    pub root: PathBuf,
    pub tickets: Arc<Tickets>,
    pub bus: Arc<Bus>,
    pub families: Arc<Families>,
    pub runs: Arc<RunLoop>,
    pub satellite: Arc<dyn Satellite>,
    pub side: SideFn,
    pub passes: PassBook,
    /// The board's port, for `ckanban call` (`CKANBAN_PORT` of a check).
    pub port: u16,
}

/// What one check (or test run) may call through `ckanban call`, and what it called.
#[derive(Clone, Debug, Default)]
pub struct Grant {
    pub passes: Vec<String>,
    /// "<pass id>:<tool>"; None: any tool of its passes (the first check after a save learns the list).
    pub allowed: Option<Vec<String>>,
    pub used: std::collections::BTreeSet<String>,
    pub expires: f64,
    pub rate_limit_ms: f64,
}

pub struct Schedules {
    pub d: Deps,
    pub files: Arc<Files>,
    /// Ticket spend, for a schedule's spend over 7 days.
    spend: ckanban_core::spend::SpendIndex,
    /// Schedule fires (a tick, run now) one at a time.
    fire_lock: Mutex<()>,
    /// Job fires and edits one at a time.
    job_lock: Mutex<()>,
    /// Commands still running: id -> board.
    inflight: Mutex<HashMap<String, String>>,
    stops: Mutex<HashMap<String, script::Stopper>>,
    /// One check or edit of an automation at a time, per `<slug>/<id>`.
    loop_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    grants: Mutex<HashMap<String, Grant>>,
    ticking: AtomicBool,
    /// Jobs left running by the last board were looked at (`recover`, before the first job tick).
    jobs_recovered: AtomicBool,
    shim: Mutex<Option<PathBuf>>,
}

/// Where a schedule's run or an automation's new ticket goes as a task (`TaskPlace`).
#[derive(Debug, Clone, PartialEq)]
pub struct Place {
    pub manager_id: String,
    pub main_id: String,
    pub part_of: Option<String>,
    pub start_from: Option<String>,
}

pub(crate) fn st<'a>(o: &'a Obj, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn obj(v: Value) -> Obj {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub(crate) fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

/// `String(v ?? "")` of a body field (`str(v, fallback)` keeps `undefined` apart: None).
pub(crate) fn js_str(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        v => crate::runs::js::to_string(v),
    }
}

impl Schedules {
    pub fn new(d: Deps) -> Arc<Schedules> {
        let files = Files::new(&d.root);
        let spend = ckanban_core::spend::SpendIndex::new(ckanban_core::DataDir::new(&d.root));
        let s = Arc::new(Schedules {
            d,
            files,
            spend,
            fire_lock: Mutex::new(()),
            job_lock: Mutex::new(()),
            inflight: Mutex::new(HashMap::new()),
            stops: Mutex::new(HashMap::new()),
            loop_locks: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashMap::new()),
            ticking: AtomicBool::new(false),
            jobs_recovered: AtomicBool::new(false),
            shim: Mutex::new(None),
        });
        // A pending restart waits for running commands, so it doesn't cut them off.
        let me = Arc::downgrade(&s);
        s.d.runs.on_restart_busy(Arc::new(move || me.upgrade().map(|m| m.inflight.lock().values().cloned().collect()).unwrap_or_default()));
        // A deleted ticket's jobs that haven't run yet go with it.
        let me = Arc::downgrade(&s);
        s.d.bus.on(move |e| {
            if e.ty != "ticket.deleted" {
                return;
            }
            let (Some(m), Some(slug), Some(id)) = (me.upgrade(), e.body.get("profile").and_then(Value::as_str), e.body.get("id").and_then(Value::as_str)) else { return };
            let (slug, id) = (slug.to_string(), id.to_string());
            std::thread::spawn(move || m.drop_source(&slug, &id));
        });
        s
    }

    pub fn now(&self) -> f64 {
        ckanban_core::time::now_ms()
    }

    fn emit(&self, body: Value) {
        self.d.bus.emit_json(body);
    }

    /// The ticket's title, or None when it is gone.
    pub(crate) fn title_of(&self, slug: &str, id: &str) -> Option<String> {
        self.d.tickets.get(slug, id).map(|t| t.title.clone())
    }

    /// `existsSync(profile.path)` with the board's folder; Err is the board's or folder's problem.
    fn board_folder(&self, slug: &str) -> Result<PathBuf, (bool, String)> {
        let p = self.files.board(slug).ok_or((false, String::new()))?;
        let path = PathBuf::from(p.get("path").and_then(Value::as_str).unwrap_or(""));
        if !path.exists() {
            return Err((true, path.to_string_lossy().into_owned()));
        }
        Ok(path)
    }

    // ---- board-main.ts: taskPlaceFor, createFeatureTask, automationItem ----

    /// `taskPlaceFor`: a task of the nearest ticket there that runs tasks; Err is the problem in words.
    pub fn task_place_for(&self, slug: &str, part_of: &str) -> Result<Place, String> {
        use crate::families::rules::{MAX_LEVEL, groups_of, level_of};
        let list = self.d.tickets.list(slug);
        let Some(at) = list.get(part_of) else { return Err(format!("The feature {part_of} it puts runs in no longer exists")) };
        let top = crate::index::family::feature_root(&list, &at.id).map(|i| list.at(i));
        let is_group = |top: &Tk| groups_of(&list, &top.id).iter().any(|i| list.at(*i).id == at.id);
        let Some(top) = top.filter(|top| top.main && (at.id == top.id || is_group(top))) else {
            return Err(format!("{} (\"{}\") isn't a feature's main ticket or one of its groups", at.id, at.title));
        };
        let manager = if crate::tickets::rights::is_manager(at) && level_of(&list, &at.id) < MAX_LEVEL { at.as_ref() } else { top };
        let branch = top.s("branch").filter(|b| !b.is_empty());
        Ok(Place {
            manager_id: manager.id.clone(),
            main_id: top.id.clone(),
            part_of: (at.id != manager.id).then(|| at.id.clone()),
            start_from: branch.filter(|_| crate::runs::js::truthy(top.get("worktree"))).map(str::to_string),
        })
    }

    /// `createFeatureTask`: a tool ticket of the place's manager that keeps the schedule's or source's fields.
    pub fn create_feature_task(&self, slug: &str, place: &Place, mut input: Obj, kind: &str, name: &str) -> Result<Arc<Tk>, String> {
        let tickets = &self.d.tickets;
        if let Some(main) = tickets.get(slug, &place.main_id).filter(|m| m.main && m.status == "done") {
            let _ = tickets.patch(slug, &main.id, obj(json!({ "status": "review", "reopenedFrom": null })));
            tickets.note(
                slug,
                &main.id,
                &if kind == "schedule" { format!("Back to Review: scheduled run \"{name}\" started.") } else { format!("Back to Review: the automation \"{name}\" added a task.") },
            );
        }
        let backlog = st(&input, "status") == "backlog";
        input.insert("parentId".into(), place.manager_id.clone().into());
        input.insert("tool".into(), true.into());
        if let Some(p) = &place.part_of {
            input.insert("partOf".into(), p.clone().into());
        }
        if let Some(b) = &place.start_from {
            input.insert("startFrom".into(), b.clone().into());
        }
        if backlog {
            input.insert("waitsForStart".into(), true.into());
        }
        let t = tickets.create(slug, input).map_err(|(_, e)| e)?;
        let manager = self.title_of(slug, &place.manager_id).unwrap_or_default();
        tickets.note(
            slug,
            &t.id,
            &format!(
                "Task of {} (\"{manager}\"), made by the {kind} \"{name}\".{}",
                place.manager_id,
                if backlog { " It waits in Backlog until you or the main ticket start it." } else { "" }
            ),
        );
        self.d.families.ensure_plan(slug, &place.manager_id);
        self.d.families.advance_plans(slug);
        Ok(tickets.get(slug, &t.id).unwrap_or(t))
    }

    /// `automationItem`: a later item of a thread for the ticket its first item made; "note" or "chat". Err: it can't
    /// be delivered now (the item waits for the next check).
    pub fn automation_item(&self, slug: &str, id: &str, text: &str, loop_id: &str, name: &str, auto_start: bool) -> Result<&'static str, String> {
        let runs = &self.d.runs;
        let t = self.d.tickets.get(slug, id).ok_or_else(|| format!("ticket {id} not found"))?;
        let active = runs.run_of(slug, id);
        let (stopping, refine) = active.as_ref().map(|r| {
            let s = r.st.lock();
            (s.stop_requested, s.chat.as_ref().is_some_and(|c| c.mode == "refine"))
        }).unwrap_or((false, false));
        if stopping || runs.shutting_down() {
            return Err("Claude is stopping; the item waits for the next check".into());
        }
        let not_started = t.is("waitsForStart")
            || t.get("runCount").and_then(Value::as_f64) == Some(0.0)
            || matches!(t.status.as_str(), "backlog" | "planning" | "ready");
        if !auto_start || (active.is_none() && not_started) || refine {
            runs.add_comment(slug, id, text, Some(&format!("loop:{loop_id}"))).map_err(|e| e.to_string())?;
            return Ok("note");
        }
        let opts = crate::runloop::types::ChatOptions {
            from_planner: true,
            automation: Some(json!({ "loopId": loop_id, "name": name })),
            next_run: true,
            ..Default::default()
        };
        runs.chat(slug, id, text, opts).map_err(|e| e.to_string())?;
        let main = if t.main { self.d.tickets.get(slug, id) } else { self.d.tickets.main_of(slug, &t) };
        if let Some(main) = main.filter(|m| m.main && m.status == "done") {
            let why = if main.id == id {
                format!("the automation \"{name}\" sent it a new item")
            } else {
                format!("the automation \"{name}\" sent a new item to its task {id}")
            };
            self.d.families.unpark_main(slug, &main.id, &why, false);
        }
        Ok("chat")
    }

    /// The side call of Ask Claude first, waited for on this (blocking) thread.
    fn side_call(&self, input: SideCallInput) -> SideCallResult {
        crate::tickets::writer::block((self.d.side)(input))
    }

    /// `addHuddleSpend`: a cost into today's board total in `spend-days.json` (60 days kept).
    pub fn add_day_spend(&self, slug: &str, cost: f64) {
        if cost.is_nan() || cost <= 0.0 {
            return;
        }
        let file = ckanban_core::DataDir::new(&self.d.root).spend_days();
        let mut ledger = std::fs::read_to_string(&file).ok().and_then(|t| crate::runs::js::parse(&t)).map(obj).unwrap_or_default();
        let day = ckanban_core::time::day_key(self.now());
        let mut d = ledger.get(&day).cloned().map(obj).unwrap_or_default();
        let had = d.get(slug).and_then(Value::as_f64).unwrap_or(0.0);
        d.insert(slug.into(), ckanban_core::jsnum::num(had + cost));
        ledger.insert(day, Value::Object(d));
        let mut keys: Vec<String> = ledger.keys().cloned().collect();
        keys.sort();
        let keep = keys.split_off(keys.len().saturating_sub(60));
        let out: Map<String, Value> = keep.into_iter().filter_map(|k| ledger.get(&k).cloned().map(|v| (k, v))).collect();
        let mut text = ckanban_core::datafile::to_text(&Value::Object(out), ckanban_core::datafile::Layout::Compact);
        text.push('\n');
        if let Err(e) = ckanban_core::atomic::atomic_write(&file, text) {
            eprintln!("[schedules] can't write {}: {e}", file.display());
        }
    }

    /// Starts the three timers (Bun's `startDaemon`): one-time jobs recover first; each timer looks every
    /// `CKANBAN_TICK_MS` in tests, else every 30 s (schedules, jobs) or 60 s (automations). Call from the runtime;
    /// the returned function stops them (and running commands, so "interrupted by restart" is true).
    pub fn start(self: &Arc<Self>) -> impl FnOnce() + Send + 'static {
        let tick = tick_ms();
        if let Some(t) = tick {
            eprintln!("timers: schedules, jobs, automations and follow-ups look every {t} ms (CKANBAN_TICK_MS)");
        }
        *self.shim.lock() = Some(script::ckanban_shim(&self.d.root));
        let me = self.clone();
        let every = move |name: &'static str, ms: u64, f: fn(&Arc<Schedules>)| {
            let me = me.clone();
            tokio::spawn(async move {
                let mut timer = tokio::time::interval(std::time::Duration::from_millis(ms));
                loop {
                    timer.tick().await;
                    let m = me.clone();
                    if tokio::task::spawn_blocking(move || f(&m)).await.is_err() {
                        eprintln!("[schedules] {name} tick failed");
                    }
                }
            })
        };
        // The jobs tick looks at what the last board left running first (`recover`).
        let tasks = vec![
            every("scheduler", tick.unwrap_or(30_000), |s| s.tick_schedules()),
            every("jobs", tick.unwrap_or(30_000), |s| s.tick_jobs()),
            every("automations", tick.unwrap_or(60_000), |s| s.tick_loops()),
        ];
        let me = self.clone();
        move || {
            for t in tasks {
                t.abort();
            }
            for s in me.stops.lock().values() {
                s.stop();
            }
        }
    }
}

/// `tickMs()`: CKANBAN_TICK_MS as whole ms from 50 to 60000, else unset.
pub fn tick_ms() -> Option<u64> {
    let v = std::env::var("CKANBAN_TICK_MS").ok()?;
    let n: f64 = crate::runs::js::number_of_str(&v);
    (n.fract() == 0.0 && (50.0..=60_000.0).contains(&n)).then_some(n as u64)
}
