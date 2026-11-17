//! `Board`'s run loop (`src/board/board.ts`): `chat`, `start`, `begin`, `execute`, `drainQueue`, `endStatus`,
//! `executeOnce`, `dropRun`, the end of a run. The other parts of the loop are `impl RunLoop` blocks in the files
//! next to this one, named like Bun's (`queue.rs` is `board-queue.ts`, ...).
//!
//! Threads and locks (plan 2.1): `decide` is held while a choice is made and acted on (Bun's run-to-completion
//! between awaits: "is it running? then start it"), on the caller's thread; ticket writes happen under it, but never a
//! wait for a run's end, `Tickets::update`/`create` (their hooks call back in) or an await. `state` and each run's
//! `st` are held only for a few field reads or writes, never across a ticket write: a write sends `ticket.updated`,
//! whose view asks `is_running` and `holds_slot`. The calls here are blocking (file writes): async code calls them
//! through `spawn_blocking`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use futures_util::future::BoxFuture;
use parking_lot::{Mutex, ReentrantMutex};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::rules::{self, THINKING_LINE};
use super::types::{Chat, ChatOptions};
use crate::api::{DeviceInfo, HuddleInfo, Satellite, SessionInfo};
use crate::browsers::Browsers;
use crate::bus::Bus;
use crate::families::Families;
use crate::git::landing::Git;
use crate::index::ticket::Tk;
use crate::runs::runner::RunHandle;
use crate::tickets::writer::{Refusal, TextMask, Tickets};

/// What went wrong for the caller: Bun's `ConflictError` is 409, `StillRefused` 410 (never sent: Telegram reads it),
/// any other `Error` 500 unless a route says otherwise.
#[derive(Debug, Clone, PartialEq)]
pub struct RunError {
    pub status: u16,
    pub message: String,
}

impl RunError {
    pub fn conflict(m: impl Into<String>) -> Self {
        RunError { status: 409, message: m.into() }
    }
    pub fn other(m: impl Into<String>) -> Self {
        RunError { status: 500, message: m.into() }
    }
    pub fn still() -> Self {
        RunError { status: 410, message: "not taking this message any more".into() }
    }
    pub fn is_conflict(&self) -> bool {
        self.status == 409
    }
}

impl From<Refusal> for RunError {
    fn from((status, message): Refusal) -> Self {
        RunError { status, message }
    }
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// What a run spent: its own messages plus its workflows' helper agents (`RunSpend`).
#[derive(Default)]
pub struct RunSpend {
    pub main: HashMap<String, f64>,
    pub main_order: Vec<String>,
    pub workflow_dirs: Vec<String>,
    pub files: HashMap<PathBuf, (String, f64)>,
}

/// A run's state that changes while it runs (`ActiveRun` fields other than the board and ticket).
#[derive(Default)]
pub struct RunSt {
    pub handle: Option<Arc<RunHandle>>,
    /// Status to land on when the run ends because the user moved the card.
    pub target_status: Option<String>,
    /// The user asked this run, in its own chat, to move its card once the reply is over.
    pub self_move: Option<String>,
    /// A quiet schedule's run found nothing: (summary, cost) once it is over.
    pub quiet_end: Option<(String, f64)>,
    pub stop_requested: bool,
    /// Its task runs (`execute`): the task's end unregisters it.
    pub started: bool,
    pub chat: Option<Chat>,
    pub retried: bool,
    pub spend: Option<Arc<Mutex<RunSpend>>>,
    /// What the attempt had spent when a Telegram message came in (0: Telegram started it).
    pub telegram_from: Option<f64>,
    pub restart_requested: bool,
    pub workflow_cap_hit: Option<f64>,
    pub auto_huddle_started: bool,
    pub user_steered: bool,
    /// Queued messages written to this claude process (id, the text it was given), in order.
    pub in_flight: Vec<(String, String)>,
    pub prompt_msg_id: Option<String>,
    /// Reply text streaming in right now.
    pub draft: String,
    pub status_eligible: bool,
    pub nudged: bool,
}

pub struct ActiveRun {
    pub slug: String,
    pub id: String,
    /// A main ticket's run: it can't edit files, holds no slot, never waits on the folder.
    pub no_edit: bool,
    pub st: Mutex<RunSt>,
    pub done: watch::Sender<bool>,
}

impl ActiveRun {
    /// Waits until the run's task has ended (`run.promise`).
    pub async fn finished(&self) {
        let mut rx = self.done.subscribe();
        let _ = rx.wait_for(|d| *d).await;
    }
    pub fn chat(&self) -> Option<Chat> {
        self.st.lock().chat.clone()
    }
}

/// The board's state the loop keeps (`Board` fields).
#[derive(Default)]
pub struct State {
    pub runs: HashMap<String, Arc<ActiveRun>>,
    pub shutting_down: bool,
    pub restart_pending: bool,
    /// Per ticket: the last form answer taken and when (`recentAnswers`).
    pub recent_answers: HashMap<String, (String, f64)>,
    /// Latest live progress of each workflow by "slug/id/toolUseId" (`workflowLive`).
    pub workflow_live: HashMap<String, Value>,
    /// Tickets with a rewind, undo or fork under way (R7b fills it).
    pub rewinding: HashSet<String>,
}

/// What the loop is built with (`BoardOptions` and the board's services).
#[derive(Clone)]
pub struct RunLoopOptions {
    pub claude_bin: String,
    /// Pause before the one automatic retry after a passing API error.
    pub retry_delay_ms: u64,
    /// How often a capped run with workflows adds up what it spent.
    pub cap_poll_ms: u64,
    /// Stall watchdog time, overriding the board's stallMinutes (tests).
    pub stall_ms: Option<u64>,
    /// How long ask_ticket waits for an answer.
    pub ask_timeout_ms: u64,
    /// The board's saved keys as a run's environment (`boardKeyEnv`).
    pub key_env: Arc<dyn Fn(&str) -> BTreeMap<String, String> + Send + Sync>,
    /// `maskSaved` (plain text).
    pub mask: TextMask,
    /// `maskSavedJson` (JSON text).
    pub mask_json: TextMask,
    /// The clock for limits and follow-ups (ms since the epoch).
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// The command a run's MCP config starts the board's tools with (this program's `mcp`).
    pub mcp_argv: Vec<String>,
    /// The board tools' fingerprint (`toolsVersion`); None: unknown, nothing noted.
    pub tools_version: Option<String>,
}

impl RunLoopOptions {
    pub fn new(claude_bin: impl Into<String>) -> Self {
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "ckanban".into());
        RunLoopOptions {
            claude_bin: claude_bin.into(),
            retry_delay_ms: crate::runs::retry::RETRY_DELAY_MS,
            cap_poll_ms: rules::WORKFLOW_CAP_POLL_MS,
            stall_ms: None,
            ask_timeout_ms: 5 * 60_000,
            key_env: Arc::new(|_| BTreeMap::new()),
            mask: Arc::new(|s: &str| s.to_string()),
            mask_json: Arc::new(|s: &str| s.to_string()),
            now: Arc::new(|| ckanban_core::time::now_ms() as f64),
            mcp_argv: vec![exe, "mcp".into()],
            tools_version: None,
        }
    }

    /// From the environment, as the daemon reads it: `CKANBAN_CLAUDE_BIN` (else `claude`).
    pub fn from_env() -> Self {
        RunLoopOptions::new(std::env::var("CKANBAN_CLAUDE_BIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "claude".into()))
    }
}

/// The services the loop calls.
pub struct RunLoopDeps {
    pub root: PathBuf,
    pub tickets: Arc<Tickets>,
    pub bus: Arc<Bus>,
    pub families: Arc<Families>,
    pub git: Arc<Git>,
    pub sessions: Arc<dyn SessionInfo>,
    pub huddles: Arc<dyn HuddleInfo>,
    pub browsers: Option<Arc<Browsers>>,
    pub devices: Arc<dyn DeviceInfo>,
    pub satellite: Arc<dyn Satellite>,
    pub opts: RunLoopOptions,
}

/// Called after each run of a ticket ends (`onRunEnd`).
pub type RunEnded = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct RunLoop {
    pub(super) me: Weak<RunLoop>,
    pub root: PathBuf,
    pub tickets: Arc<Tickets>,
    pub bus: Arc<Bus>,
    pub families: Arc<Families>,
    pub git: Arc<Git>,
    pub sessions: Arc<dyn SessionInfo>,
    pub huddles: Arc<dyn HuddleInfo>,
    pub browsers: Option<Arc<Browsers>>,
    pub devices: Arc<dyn DeviceInfo>,
    pub satellite: Arc<dyn Satellite>,
    pub opts: RunLoopOptions,
    pub(super) rt: tokio::runtime::Handle,
    pub(super) state: Mutex<State>,
    pub(super) decide: ReentrantMutex<()>,
    /// Other work a restart waits for (huddle agents mid-turn, quick chats), by board, repeats included.
    pub(super) restart_busy: Mutex<Vec<Arc<dyn Fn() -> Vec<String> + Send + Sync>>>,
    pub(super) run_ended: Mutex<Vec<RunEnded>>,
    /// Running ask_ticket forks with what to tell their asker if a restart cuts them off.
    pub(super) asks: Mutex<Vec<(Arc<RunHandle>, Arc<dyn Fn() + Send + Sync>)>>,
    /// Runs as each attempt's activity log number (`runCount + 1` at the start of a work run).
    pub(super) versions: crate::runs::model_versions::ModelVersions,
    pub(super) digests: Arc<crate::runs::activity_digest::ActivityDigests>,
    /// R6's view of the board, for the PR routes.
    pub(super) ops: std::sync::OnceLock<Arc<dyn crate::git::ops::BoardOps>>,
}

/// A JSON object from `json!({...})`.
pub fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub fn now_iso() -> String {
    crate::tickets::writer::now()
}

/// `crypto.randomUUID()`.
pub fn uuid() -> String {
    crate::git::landing::random_uuid()
}

/// A field as text.
pub fn ts<'a>(t: &'a Tk, k: &str) -> Option<&'a str> {
    t.s(k).filter(|s| !s.is_empty())
}

/// `t.error?.startsWith("corrupt")`.
pub fn corrupt(t: &Tk) -> bool {
    t.corrupt || t.s("error").is_some_and(|e| e.starts_with("corrupt"))
}

/// The ticket's queued messages (`queued ?? []`).
pub fn queued_of(t: &Tk) -> Vec<Map<String, Value>> {
    t.get("queued").and_then(Value::as_array).map(|a| a.iter().filter_map(|m| m.as_object().cloned()).collect()).unwrap_or_default()
}

pub fn msg_id(m: &Map<String, Value>) -> &str {
    m.get("id").and_then(Value::as_str).unwrap_or("")
}

pub fn msg_state(m: &Map<String, Value>) -> &str {
    m.get("state").and_then(Value::as_str).unwrap_or("")
}

impl RunLoop {
    pub fn new(d: RunLoopDeps) -> Arc<RunLoop> {
        let versions = crate::runs::model_versions::ModelVersions::new(Some(d.root.join("model-versions.json")));
        Arc::new_cyclic(|me| RunLoop {
            me: me.clone(),
            root: d.root,
            tickets: d.tickets,
            bus: d.bus,
            families: d.families,
            git: d.git,
            sessions: d.sessions,
            huddles: d.huddles,
            browsers: d.browsers,
            devices: d.devices,
            satellite: d.satellite,
            opts: d.opts,
            rt: tokio::runtime::Handle::current(),
            state: Mutex::new(State::default()),
            decide: ReentrantMutex::new(()),
            restart_busy: Mutex::new(Vec::new()),
            run_ended: Mutex::new(Vec::new()),
            asks: Mutex::new(Vec::new()),
            versions,
            digests: crate::runs::activity_digest::ActivityDigests::new(),
            ops: std::sync::OnceLock::new(),
        })
    }

    pub(super) fn arc(&self) -> Arc<RunLoop> {
        self.me.upgrade().expect("the run loop is alive")
    }

    /// R6's view of the board (the ticket writes), for the PR routes; set by board mode.
    pub fn set_ops(&self, ops: Arc<dyn crate::git::ops::BoardOps>) {
        let _ = self.ops.set(ops);
    }
    pub fn ops(&self) -> Arc<dyn crate::git::ops::BoardOps> {
        self.ops.get().cloned().expect("board mode sets the run loop's ops")
    }

    pub fn key(slug: &str, id: &str) -> String {
        format!("{slug}/{id}")
    }

    pub fn now(&self) -> f64 {
        (self.opts.now)()
    }

    pub(super) fn get(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        self.tickets.get(slug, id)
    }

    pub fn run_of(&self, slug: &str, id: &str) -> Option<Arc<ActiveRun>> {
        self.state.lock().runs.get(&Self::key(slug, id)).cloned()
    }

    pub fn shutting_down(&self) -> bool {
        self.state.lock().shutting_down
    }

    pub fn restart_pending(&self) -> bool {
        self.state.lock().restart_pending
    }

    pub(super) fn profile(&self, slug: &str) -> Option<Map<String, Value>> {
        ckanban_core::DataDir::new(self.root.clone()).profile(slug).map(|p| p.record.0)
    }

    /// `emitTicket`.
    pub fn emit_ticket(&self, slug: &str, id: &str) {
        if let Some(t) = self.get(slug, id) {
            self.tickets.emit(slug, &t);
        }
    }

    /// `Board.patch`: written and sent; Done drops the rewind copies (R7b).
    pub fn patch(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Result<Arc<Tk>, RunError> {
        Ok(self.tickets.patch(slug, id, patch)?)
    }

    /// A patch whose failure is only logged (Bun's `try { this.patch(...) } catch {}` places and patches that
    /// can't fail in practice).
    pub(super) fn patch_quiet(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Option<Arc<Tk>> {
        match self.tickets.patch(slug, id, patch) {
            Ok(t) => Some(t),
            Err((_, e)) => {
                eprintln!("[board] {slug}/{id}: {e}");
                None
            }
        }
    }

    /// `store.addComment(slug, id, "ai", text)`.
    pub fn note(&self, slug: &str, id: &str, text: &str) {
        self.tickets.note(slug, id, text);
    }

    // ---- Bun's Board.chat ----

    /// `chat`: send a message. It resumes the ticket's session right away; while Claude works it steers the run
    /// instead. Blocking.
    pub fn chat(&self, slug: &str, id: &str, text: &str, opts: ChatOptions) -> Result<Arc<Tk>, RunError> {
        if self.state.lock().rewinding.contains(&Self::key(slug, id)) {
            return Err(RunError::conflict(rules::REWINDING));
        }
        // STAND-IN (R7b): the rewind snapshot of the folder before the message (`takeSnapshot`).
        let _g = self.decide.lock();
        self.chat_now(slug, id, text, opts)
    }

    fn queued_msg(&self, text: &str, opts: &ChatOptions) -> Map<String, Value> {
        let mut m = obj(json!({ "id": uuid(), "text": text, "at": now_iso(), "state": "queued" }));
        m.extend(opts.flags());
        m
    }

    fn with_queued(t: &Tk, msg: Map<String, Value>) -> Value {
        let mut q: Vec<Value> = queued_of(t).into_iter().map(Value::Object).collect();
        q.push(Value::Object(msg));
        Value::Array(q)
    }

    fn chat_now(&self, slug: &str, id: &str, text_in: &str, opts: ChatOptions) -> Result<Arc<Tk>, RunError> {
        if self.state.lock().rewinding.contains(&Self::key(slug, id)) {
            return Err(RunError::conflict(rules::REWINDING));
        }
        if let Some(still) = &opts.still
            && !still()
        {
            return Err(RunError::still());
        }
        let mut text = text_in.to_string();
        let mut t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        if crate::runs::js::trim(&text).is_empty() {
            return Err(RunError::other("message is empty"));
        }
        if corrupt(&t) {
            return Err(RunError::other("ticket file is corrupt"));
        }
        let active = self.run_of(slug, id);
        if opts.fresh {
            if active.is_some() {
                return Err(RunError::conflict("Claude is working on this ticket; send it once Claude is done"));
            }
            t = self.start_fresh_chat(slug, id, false)?;
        }
        if !opts.peer && opts.slash.is_none() && !opts.host_wake && !opts.follow_up {
            // STAND-IN (R7b): slash commands (`parseSlash`, `slashMessage`, the board's /model and /effort); until
            // then a message starting with "/" goes to Claude as typed.
            let _ = &mut text;
        }
        if self.repeated_answer(slug, id, &t, &text, &opts) {
            return Ok(t);
        }
        let local = opts.slash.as_deref() == Some("local");
        let user = !opts.peer && !opts.from_planner && !opts.host_wake;
        // A main ticket parked in Done (or Backlog after its family started): the user wants more from it.
        if t.main && user && !local {
            let unparked = if !opts.follow_up {
                self.families.unpark_main(slug, id, "you wrote in its chat", true)
            } else {
                self.families.open_steps(slug, id) && self.families.unpark_main(slug, id, "its follow-up came while its steps are still at work", false)
            };
            if unparked {
                t = self.get(slug, id).unwrap_or(t);
                if t.is("plan") {
                    self.families.advance_plans(slug);
                }
            }
        }
        // The user chats on a Backlog card: it is being shaped now, so it shows in Planning.
        let parent_active = t.parent_id.as_deref().and_then(|p| self.get(slug, p)).is_some_and(|p| crate::index::attention::plan_active(&p));
        if t.status == "backlog" && user && !opts.follow_up && !local && !parent_active {
            t = self.patch(slug, id, obj(json!({ "status": "planning", "refineStarted": true })))?;
        }
        // The user (or the board's automatic continue) picks it up again: the limit wait is over.
        if t.is("limit") && !opts.peer && !opts.host_wake && !opts.follow_up {
            t = self.patch(slug, id, obj(json!({ "limit": null })))?;
        }
        if t.main && t.plan_state() == Some("stuck") && user && !opts.follow_up {
            let mut plan = t.get("plan").and_then(Value::as_object).cloned().unwrap_or_default();
            for (k, v) in [("state", json!("running")), ("reason", Value::Null), ("awaiting", Value::Null), ("noProgress", json!(0))] {
                plan.insert(k.into(), v);
            }
            t = self.patch(slug, id, obj(json!({ "plan": plan })))?;
        }
        if t.main && t.plan_state() == Some("paused") && user && !opts.follow_up && !local && self.families.resume_stopped_plan(slug, id, "you wrote in its chat") {
            t = self.get(slug, id).unwrap_or(t);
        }
        if let Some(active) = active {
            let stopping = active.st.lock().stop_requested;
            if stopping || self.shutting_down() {
                return Err(RunError::conflict("Claude is stopping; send your message once it has stopped"));
            }
            // Saved on the ticket until Claude reads it, so closing the chat, Stop or a restart can't lose it.
            let msg = self.queued_msg(&text, &opts);
            self.patch(slug, id, obj(json!({ "queued": Self::with_queued(&t, msg.clone()) })))?;
            if !opts.next_run {
                self.steer(&active, &msg);
            }
            return self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")));
        }
        let from_user = opts.from_user();
        if self.restart_pending() && !from_user {
            let msg = self.queued_msg(&text, &opts);
            return self.patch(slug, id, obj(json!({ "queued": Self::with_queued(&t, msg) })));
        }
        if !opts.peer && !opts.fresh && opts.automation.is_none() {
            t = self.auto_fresh(slug, t);
        }
        let mut m = obj(json!({ "text": text }));
        m.extend(opts.flags());
        let chat = rules::chat_for(&t.json, &m);
        let folder_busy = chat.act() && self.folder_busy(slug, &t);
        let slot = rules::takes_slot(Some(&chat), t.main);
        let waits = t.is("slotWait");
        if !slot && (folder_busy || waits) {
            let msg = self.queued_msg(&text, &opts);
            let slot_wait = t.get("slotWait").filter(|v| crate::runs::js::truthy(Some(v))).cloned().unwrap_or_else(|| {
                json!({ "at": now_iso(), "from": { "status": t.status, "outcome": t.get("outcome").cloned().unwrap_or(Value::Null) } })
            });
            self.patch(slug, id, obj(json!({ "queued": Self::with_queued(&t, msg), "lastActivity": rules::FOLDER_WAIT, "slotWait": slot_wait })))?;
            self.dispatch(slug);
            return self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")));
        }
        if slot && (waits || folder_busy) {
            let msg = self.queued_msg(&text, &opts);
            self.patch(slug, id, obj(json!({ "queued": Self::with_queued(&t, msg) })))?;
            self.wait_for_slot(slug, id)?;
            self.dispatch(slug);
            return self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")));
        }
        if opts.peer || opts.host_wake || opts.follow_up {
            if let Some(e) = self.start(slug, id, Some(chat), None) {
                return Err(RunError::other(e));
            }
        } else {
            let msg = self.queued_msg(&text, &opts);
            let msg_id = msg_id(&msg).to_string();
            let failed = self.start(slug, id, Some(chat), Some(msg_id));
            // Added once the run is registered, so the chat never shows it as waiting with no run behind it.
            let now = self.get(slug, id).unwrap_or(t);
            let r = self.patch(slug, id, obj(json!({ "queued": Self::with_queued(&now, msg) })));
            if let Some(e) = failed {
                return Err(RunError::other(e));
            }
            r?;
        }
        self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))
    }

    // ---- start, begin, execute ----

    /// `start`: registers and starts the ticket's run. Returns the error when it couldn't even start (the run is not
    /// registered then, and the card shows the error).
    pub fn start(&self, slug: &str, id: &str, chat: Option<Chat>, prompt_msg_id: Option<String>) -> Option<String> {
        let _g = self.decide.lock();
        let no_edit = self.get(slug, id).is_some_and(|t| t.main);
        let (done, _) = watch::channel(false);
        let run = Arc::new(ActiveRun {
            slug: slug.to_string(),
            id: id.to_string(),
            no_edit,
            st: Mutex::new(RunSt { chat, prompt_msg_id, ..Default::default() }),
            done,
        });
        self.state.lock().runs.insert(Self::key(slug, id), run.clone());
        if let Err(e) = self.begin(&run) {
            let msg = if e.message.contains("No space left") { "Couldn't start: no space left on the disk".to_string() } else { e.message.clone() };
            eprintln!("[board] run {slug}/{id} could not start: {}", e.message);
            let mut p = self.end_status(&run);
            p.extend(obj(json!({ "outcome": "failed", "error": msg, "lastActivity": null, "runStartedAt": null })));
            self.drop_run(&run, p);
            return Some(msg);
        }
        run.st.lock().started = true;
        let me = self.arc();
        let r = run.clone();
        self.rt.spawn(async move {
            let out = tokio::spawn(me.clone().execute(r.clone())).await;
            if let Err(e) = out {
                eprintln!("[board] run {}/{} crashed: {e}", r.slug, r.id);
                let (m, r2) = (me.clone(), r.clone());
                let _ = tokio::task::spawn_blocking(move || {
                    let mut p = m.end_status(&r2);
                    p.extend(obj(json!({ "outcome": "failed", "error": e.to_string() })));
                    m.patch_quiet(&r2.slug, &r2.id, p);
                })
                .await;
            }
            me.clone().after_run(r.clone()).await;
            let _ = r.done.send(true);
        });
        None
    }

    /// The end of a run (`start`'s `finally`).
    async fn after_run(self: Arc<Self>, run: Arc<ActiveRun>) {
        let me = self.clone();
        let r = run.clone();
        let quiet_end = tokio::task::spawn_blocking(move || {
            {
                let mut st = me.state.lock();
                if st.runs.get(&Self::key(&r.slug, &r.id)).is_some_and(|x| Arc::ptr_eq(x, &r)) {
                    st.runs.remove(&Self::key(&r.slug, &r.id));
                }
            }
            // The run may have changed the folder's history: ask git again next time.
            if let Some(path) = me.profile(&r.slug).and_then(|p| p.get("path").and_then(Value::as_str).map(PathBuf::from)) {
                crate::git::repo::forget_repo_kind(Some(&path));
            }
            me.devices.release_all(&r.slug, &r.id);
            r.st.lock().quiet_end.clone()
        })
        .await
        .unwrap_or(None);
        if let Some(end) = quiet_end
            && !self.shutting_down()
            && self.end_quietly(&run.slug, &run.id, &end).await
        {
            let me = self.clone();
            let slug = run.slug.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if me.restart_pending() {
                    me.emit_restart();
                }
                me.dispatch(&slug);
            })
            .await;
            return;
        }
        self.apply_self_move(&run).await;
        let me = self.clone();
        let r = run.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if me.restart_pending() {
                me.emit_restart();
            }
            let down = me.shutting_down();
            if let Some(now) = me.get(&r.slug, &r.id)
                && !down
            {
                if ["runStartedAt", "interrupted", "waitingOn", "stalled", "followUpRun"].iter().any(|k| now.is(k)) {
                    me.patch_quiet(&r.slug, &r.id, obj(json!({ "runStartedAt": null, "interrupted": null, "waitingOn": null, "stalled": null, "followUpRun": null })));
                } else {
                    me.tickets.emit(&r.slug, &now);
                }
            }
            if down {
                return;
            }
            let target = r.st.lock().target_status.clone();
            if target.is_none() {
                me.dispatch(&r.slug);
            }
            me.families.advance_plans(&r.slug);
            let hooks: Vec<RunEnded> = me.run_ended.lock().clone();
            for f in hooks {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&r.slug, &r.id)));
            }
        })
        .await;
    }

    /// `dropRun`: unregisters a run that has no task behind it and puts what it shows on the card.
    pub(super) fn drop_run(&self, run: &Arc<ActiveRun>, patch: Map<String, Value>) {
        let (slug, id) = (&run.slug, &run.id);
        {
            let mut st = self.state.lock();
            if st.runs.get(&Self::key(slug, id)).is_some_and(|x| Arc::ptr_eq(x, run)) {
                st.runs.remove(&Self::key(slug, id));
            }
        }
        self.devices.release_all(slug, id);
        if self.get(slug, id).is_some()
            && let Err((_, e)) = self.tickets.patch(slug, id, patch)
        {
            eprintln!("[board] couldn't record the end of run {slug}/{id}: {e}");
        }
        if self.restart_pending() {
            self.emit_restart();
        }
        let _ = run.done.send(true);
    }

    /// The move the user asked the run for, now that its reply is over (`applySelfMove`).
    async fn apply_self_move(self: &Arc<Self>, run: &Arc<ActiveRun>) {
        let (status, stopped, target) = {
            let st = run.st.lock();
            (st.self_move.clone(), st.stop_requested, st.target_status.clone())
        };
        let Some(status) = status else { return };
        if stopped || target.is_some() || self.shutting_down() || self.is_running(&run.slug, &run.id) {
            return;
        }
        let me = self.clone();
        let r = run.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let Some(t) = me.get(&r.slug, &r.id) else { return };
            if t.status == status {
                return;
            }
            let patch = obj(json!({ "status": status }));
            match me.tickets.update(&r.slug, &r.id, &patch, true) {
                Ok(_) => me.note(&r.slug, &r.id, &format!("Moved it to {status} by its own chat (user request).")),
                Err((_, e)) => me.note(&r.slug, &r.id, &format!("Couldn't move it to {status} as asked in the chat: {e}")),
            }
        })
        .await;
    }

    /// `begin`: the card shows the run starting.
    pub(super) fn begin(&self, run: &Arc<ActiveRun>) -> Result<(), RunError> {
        let (slug, id) = (&run.slug, &run.id);
        let chat = {
            let mut st = run.st.lock();
            if let Some(c) = &st.chat
                && !c.quiet
                && (!c.refine() || !crate::runs::js::trim(&c.text).is_empty())
            {
                st.status_eligible = true;
            }
            st.chat.clone()
        };
        let t = self.get(slug, id);
        let follow_up_run = chat.as_ref().filter(|c| c.follow_up).and_then(|c| c.return_to.clone()).map(|r| json!({ "returnTo": r }));
        if follow_up_run.is_some() || t.as_ref().is_some_and(|t| t.is("followUpRun")) {
            self.patch(slug, id, obj(json!({ "followUpRun": follow_up_run.unwrap_or(Value::Null) })))?;
        }
        let now = now_iso();
        let p = match &chat {
            Some(c) if c.quiet || (run.no_edit && c.act() && !c.host_wake) => {
                json!({ "error": null, "lastActivity": THINKING_LINE, "runStartedAt": now, "waitingOn": null, "stalled": null })
            }
            Some(c) if c.refine() => {
                json!({ "error": null, "lastActivity": THINKING_LINE, "refineStarted": true, "runStartedAt": now, "waitingOn": null, "stalled": null })
            }
            _ => json!({ "status": "in_progress", "outcome": null, "error": null, "limit": null, "capHit": null, "lastActivity": "Starting…", "runStartedAt": now, "waitingOn": null, "stalled": null }),
        };
        self.patch(slug, id, obj(p))?;
        Ok(())
    }

    /// `execute`: one claude run, then a chat reply for each message that came in too late for it.
    fn execute(self: Arc<Self>, run: Arc<ActiveRun>) -> BoxFuture<'static, ()> {
        Box::pin(async move {
            let started_at = now_iso();
            self.clone().execute_once(run.clone(), false, None).await;
            if run.chat().is_some_and(|c| c.follow_up) {
                self.follow_up_cost(&run.slug, &run.id).await;
            }
            self.clone().drain_queue(run.clone()).await;
            if self.clone().nudge_status(run.clone(), started_at).await {
                self.clone().drain_queue(run).await;
            }
        })
    }

    /// `drainQueue`: a chat reply for each message that came in too late for the run's last turn.
    async fn drain_queue(self: Arc<Self>, run: Arc<ActiveRun>) {
        loop {
            let me = self.clone();
            let r = run.clone();
            let next = tokio::task::spawn_blocking(move || me.next_turn(&r)).await.unwrap_or(false);
            if !next {
                return;
            }
            self.clone().execute_once(run.clone(), false, None).await;
            if run.chat().is_some_and(|c| c.follow_up) {
                self.follow_up_cost(&run.slug, &run.id).await;
            }
        }
    }

    /// One step of `drainQueue` before its run: true when a next turn begins.
    fn next_turn(&self, run: &Arc<ActiveRun>) -> bool {
        let _g = self.decide.lock();
        if self.shutting_down() || self.restart_pending() {
            return false;
        }
        let Some(t) = self.get(&run.slug, &run.id) else { return false };
        let Some(next) = self.waiting(&run.slug, &run.id).into_iter().next() else { return false };
        let (stopped, prompt_id, cur) = {
            let st = run.st.lock();
            (st.stop_requested, st.prompt_msg_id.clone(), st.chat.clone())
        };
        // Stopped, or the last reply could not even start: keep them for the user to send or discard.
        if stopped || prompt_id.as_deref() == Some(msg_id(&next)) {
            let q: Vec<Value> = queued_of(&t)
                .into_iter()
                .map(|mut m| {
                    if msg_state(&m) == "queued" {
                        m.insert("state".into(), "unsent".into());
                    }
                    Value::Object(m)
                })
                .collect();
            self.patch_quiet(&run.slug, &run.id, obj(json!({ "queued": q })));
            return false;
        }
        let chat = rules::chat_for(&t.json, &next);
        if rules::takes_slot(Some(&chat), run.no_edit) && !rules::takes_slot(cur.as_ref(), run.no_edit) && chat.act() && self.folder_busy(&run.slug, &t) {
            let _ = self.wait_for_slot(&run.slug, &run.id);
            return false;
        }
        {
            let mut st = run.st.lock();
            st.chat = Some(chat);
            st.quiet_end = None;
            st.retried = false;
            st.restart_requested = false;
            st.user_steered = false;
            st.prompt_msg_id = Some(msg_id(&next).to_string());
            st.telegram_from = None;
            st.in_flight.clear();
            st.handle = None;
        }
        if let Err(e) = self.begin(run) {
            eprintln!("[board] {}/{}: {e}", run.slug, run.id);
            return false;
        }
        true
    }

    /// `endStatus`: where the card lands after a run; refine chats and replies to other tickets never move it.
    pub(super) fn end_status(&self, run: &ActiveRun) -> Map<String, Value> {
        let (chat, target) = {
            let st = run.st.lock();
            (st.chat.clone(), st.target_status.clone())
        };
        let keep = |target: Option<String>| match target {
            Some(s) => obj(json!({ "status": s })),
            None => Map::new(),
        };
        if let Some(c) = &chat {
            if c.refine() || c.quiet {
                return keep(target);
            }
            if run.no_edit && !c.host_wake {
                return keep(target);
            }
        }
        let status = target.clone().or_else(|| chat.as_ref().and_then(|c| c.return_to.clone())).unwrap_or_else(|| "review".into());
        let status = if status == "done" && target.is_none() && self.huddle_open(&run.slug, &run.id) { "review".to_string() } else { status };
        obj(json!({ "status": status }))
    }

    /// The ticket hosts a huddle that isn't closed.
    pub(super) fn huddle_open(&self, slug: &str, id: &str) -> bool {
        self.huddles.host_states(slug).contains_key(id)
    }

    /// `onRunEnd`.
    pub fn on_run_end(&self, f: RunEnded) {
        self.run_ended.lock().push(f);
    }
}
