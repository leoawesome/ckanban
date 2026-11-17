//! R11c: what runs for a huddle (`src/huddle/huddle-agents.ts`, the delivering half of `huddle-routing.ts`, the
//! cleanup and shutdown of `huddle-lifecycle.ts`, the ticket sessions' huddle costs of `huddle.ts`). `Agents` is the
//! board's `HuddleRunner`:
//!
//! - helpers' runs: `claude -p` on R3's runner, in their own copy of the host's folder (one that changes files), a
//!   read-only snapshot worktree (a reviewer, in a repo with commits) or the host's folder; woken with the messages
//!   they haven't read (steered mid-turn, queued for a monitor's turn boundary, or a new run);
//! - ticket sessions (@main, invited tickets): their unread messages as a chat message of their ticket (R7a);
//! - the cost of each turn on the roster and on the board's day ledger, the budget brake after it;
//! - after a close: the helpers' copies and what they left in the outputs, both report-only until
//!   `CKANBAN_RUST_DELETE=1` (plan 5.3);
//! - shutdown and recovery: helpers mid-turn are marked and carry on after the restart.
//!
//! Auto huddles are in `auto.rs`, the session viewer in `session.rs`.
//!
//! Locks: the room's changes run under `Huddles::op` on the blocking pool. A run's events come on the runtime: they
//! update the run's memory at once and queue their huddle writes, which one task per run applies in order off the
//! runtime. Git and file copies run as child processes or on the blocking pool, never under the room's lock.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, watch};

use super::model::*;
use super::service::{AgentState, AutoInput, HuddleRunner, Huddles, R, SessionQuery, obj};
use super::workspace::{self as ws, agent_dir};
use crate::prompts::huddle as hp;
use crate::prompts::types as pt;
use crate::runloop::board::RunLoop;
use crate::runloop::types::ChatOptions;
use crate::runs::runner::{self, BuildArgs, MONITOR_IDLE_MS, NO_EDIT_TOOLS, RunHandle, RunOptions};
use crate::team::Fail;

/// The environment variable a helper's run carries, `<huddle>/<handle>/<token>` (`HUDDLE_AGENT_ENV`).
pub const HUDDLE_AGENT_ENV: &str = "CKANBAN_HUDDLE_AGENT";
/// How often a helper's activity line and conversation size are written (`ACTIVITY_THROTTLE_MS`).
pub const ACTIVITY_THROTTLE_MS: f64 = 1000.0;
/// Most message text one wake hands a session (`DIGEST_MAX_CHARS`).
pub const DIGEST_MAX_CHARS: usize = 100_000;
/// How long a shutdown waits for the helpers' runs to end.
const SHUTDOWN_WAIT: std::time::Duration = std::time::Duration::from_secs(6);

/// A huddle write queued by a run's events, applied in order under the room's lock.
type Write = Box<dyn FnOnce(&Huddles) + Send>;

/// `AgentRun`: one helper's run.
#[derive(Default)]
pub struct RunSt {
    pub handle: Option<RunHandle>,
    pub idle: bool,
    pub pending: bool,
    pub again: bool,
    pub stop_requested: bool,
    pub refreshing: bool,
    pub fresh: bool,
    /// The turn in progress: estimated cost by assistant message id.
    pub turn: Option<HashMap<String, f64>>,
    pub ctx: f64,
}

pub struct AgentRun {
    pub st: Mutex<RunSt>,
    done: watch::Sender<bool>,
}

impl AgentRun {
    async fn finished(&self) {
        let mut rx = self.done.subscribe();
        let _ = rx.wait_for(|d| *d).await;
    }
}

/// How helpers run.
#[derive(Clone)]
pub struct AgentOptions {
    pub claude_bin: String,
    /// How long a monitor's session stays open between turns (`MONITOR_IDLE_MS`; tests shorten it).
    pub idle_ms: u64,
}

impl AgentOptions {
    pub fn from_env(claude_bin: &str) -> Self {
        let idle_ms = std::env::var("CKANBAN_HUDDLE_IDLE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(MONITOR_IDLE_MS);
        AgentOptions { claude_bin: claude_bin.to_string(), idle_ms }
    }
}

pub struct Agents {
    pub(super) me: Weak<Agents>,
    pub(super) huddles: Weak<Huddles>,
    pub(super) board: Arc<RunLoop>,
    pub(super) sessions: Option<Arc<crate::sessions::service::Sessions>>,
    pub(super) opts: AgentOptions,
    pub(super) rt: tokio::runtime::Handle,
    pub(super) runs: Mutex<HashMap<String, Arc<AgentRun>>>,
    /// Ticket sessions by "<slug>/<ticket>": the participant that last woke them (`mainWoken`).
    pub(super) main_woken: Mutex<HashMap<String, (String, String)>>,
    /// A ticket session's running total at its latest result, by "<slug>/<ticket>/<session>" (`ticketTotals`).
    ticket_totals: Mutex<HashMap<String, f64>>,
    /// A ticket session's conversation size, by "<slug>/<ticket>": (tokens, saved at, saved) (`ticketCtx`).
    ticket_ctx: Mutex<HashMap<String, (f64, f64, f64)>>,
    /// Per board: the ticket last woken because the auto-huddle slot freed (`slotWoken`).
    pub(super) slot_woken: Mutex<HashMap<String, String>>,
    /// Background clean-ups and refreshes `when_idle` waits for.
    chores: Mutex<usize>,
    chores_done: tokio::sync::Notify,
    /// Per ticket: the outputs cleanup running now, so two never walk the same folders at once.
    cleaning: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Ticket -> the doneAt its outputs were last cleaned for; oldest dropped past 2000.
    pub(super) done_cleaned: Mutex<(HashMap<String, String>, std::collections::VecDeque<String>)>,
    pub(super) session_cache: super::session::SessionCache,
}

fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

fn now_ms() -> f64 {
    ckanban_core::time::now_ms()
}

fn fail<T>(status: u16, msg: impl Into<String>) -> R<T> {
    Err(Fail::new(status, msg))
}

/// `contextTokens`: a message's input as the conversation's size.
pub fn context_tokens(usage: Option<&Value>) -> f64 {
    let n = |k: &str| usage.and_then(|u| u.get(k)).and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(0.0);
    n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens")
}

/// `costAfter`: a participant's cost after a result line reporting its session's running total.
pub fn cost_after(p: Option<&Obj>, total: f64) -> (f64, f64) {
    let prev = p.and_then(|p| opt_f(p, "sessionCostUsd")).unwrap_or(0.0);
    let cost = p.and_then(|p| opt_f(p, "costUsd")).unwrap_or(0.0);
    (cost + if total >= prev { total - prev } else { total }, total)
}

/// `digestWindow`: the newest unread messages whose text fits in DIGEST_MAX_CHARS (always at least the newest one).
pub fn digest_window(unread: &[Value]) -> &[Value] {
    let len = |m: &Value| crate::prompts::js::len16(m.get("text").and_then(Value::as_str).unwrap_or(""));
    let mut total = 0;
    let mut i = unread.len();
    while i > 0 && (i == unread.len() || total + len(&unread[i - 1]) <= DIGEST_MAX_CHARS) {
        i -= 1;
        total += len(&unread[i]);
    }
    &unread[i..]
}

/// The prompts' view of a huddle and a participant.
pub fn typed_huddle(h: &Obj) -> pt::Huddle {
    serde_json::from_value(Value::Object(h.clone())).unwrap_or_default()
}
pub fn typed_p(p: &Obj) -> pt::HuddleParticipant {
    serde_json::from_value(Value::Object(p.clone())).unwrap_or_default()
}

/// `huddleDigest` of the unread messages (the newest that fit).
pub fn digest(h: &Obj, unread: &[Value]) -> String {
    let shown = digest_window(unread);
    let msgs: Vec<pt::HuddleMessage> = shown.iter().filter_map(|m| serde_json::from_value(m.clone()).ok()).collect();
    let brief: Option<pt::Brief> = h.get("brief").filter(|b| b.is_object()).and_then(|b| serde_json::from_value(b.clone()).ok());
    hp::huddle_digest(&msgs, unread.len() - shown.len(), brief.as_ref())
}

fn status_after(cur: Option<&Obj>, otherwise: &str) -> Value {
    match cur {
        Some(c) if settled(c) => Value::from(s(c, "status")),
        _ => Value::from(otherwise),
    }
}

impl Agents {
    pub fn new(huddles: &Arc<Huddles>, board: Arc<RunLoop>, sessions: Option<Arc<crate::sessions::service::Sessions>>, opts: AgentOptions) -> Arc<Agents> {
        Arc::new_cyclic(|me| Agents {
            me: me.clone(),
            huddles: Arc::downgrade(huddles),
            board,
            sessions,
            opts,
            rt: tokio::runtime::Handle::current(),
            runs: Mutex::new(HashMap::new()),
            main_woken: Mutex::new(HashMap::new()),
            ticket_totals: Mutex::new(HashMap::new()),
            ticket_ctx: Mutex::new(HashMap::new()),
            slot_woken: Mutex::new(HashMap::new()),
            chores: Mutex::new(0),
            chores_done: tokio::sync::Notify::new(),
            cleaning: Mutex::new(HashMap::new()),
            done_cleaned: Mutex::new((HashMap::new(), std::collections::VecDeque::new())),
            session_cache: super::session::SessionCache::default(),
        })
    }

    pub(super) fn arc(&self) -> Arc<Agents> {
        self.me.upgrade().expect("the board holds its huddle runner")
    }

    fn shutting_down(h: &Huddles) -> bool {
        h.shutting_down.load(Ordering::Relaxed)
    }

    /// Runs `f` under the room's lock on the blocking pool; None once the room is gone.
    pub(super) async fn op<T: Send + 'static>(&self, f: impl FnOnce(&Huddles) -> T + Send + 'static) -> Option<T> {
        let h = self.huddles.upgrade()?;
        tokio::task::spawn_blocking(move || h.op(f)).await.ok()
    }

    /// Background work `when_idle` waits for (`chore`).
    pub(super) fn chore(&self, f: impl std::future::Future<Output = ()> + Send + 'static) {
        *self.chores.lock() += 1;
        let me = self.arc();
        self.rt.spawn(async move {
            f.await;
            let mut n = me.chores.lock();
            *n -= 1;
            if *n == 0 {
                me.chores_done.notify_waiters();
            }
        });
    }

    fn run(&self, slug: &str, hid: &str, handle: &str) -> Option<Arc<AgentRun>> {
        self.runs.lock().get(&Huddles::key(slug, hid, handle)).cloned()
    }

    /// `browserLease`.
    pub fn lease(slug: &str, hid: &str, handle: &str) -> String {
        format!("huddle:{slug}/{hid}/{handle}")
    }

    /// `holdForRestart`: a restart is pending, so no new helper run starts; recover() starts it after the restart.
    fn hold_for_restart(&self, h: &Huddles, slug: &str, hid: &str, handle: &str) -> bool {
        if !self.board.restart_pending() {
            return false;
        }
        let _ = h.update_p(slug, hid, handle, obj([("interrupted", true.into()), ("lastActivity", "Waiting for the board to restart".into())]));
        true
    }

    /// `runAgent`: a new run of the helper with `input` as its first message.
    pub(super) fn run_agent(&self, h: &Huddles, slug: &str, hid: &str, handle: &str, input: String) {
        let key = Huddles::key(slug, hid, handle);
        if self.runs.lock().contains_key(&key) || Self::shutting_down(h) || self.hold_for_restart(h, slug, hid, handle) {
            return;
        }
        let (tx, _) = watch::channel(false);
        let run = Arc::new(AgentRun { st: Mutex::new(RunSt::default()), done: tx });
        {
            let mut runs = self.runs.lock();
            if runs.contains_key(&key) {
                return;
            }
            runs.insert(key.clone(), run.clone());
        }
        let cur = h.get(slug, hid).ok().and_then(|x| participant(&x, handle).cloned());
        let _ = h.update_p(slug, hid, handle, obj([("status", status_after(cur.as_ref(), "working")), ("error", Value::Null), ("interrupted", false.into())]));
        let me = self.arc();
        let (slug, hid, handle) = (slug.to_string(), hid.to_string(), handle.to_string());
        self.rt.spawn(async move {
            let out = me.clone().execute(&slug, &hid, &handle, run.clone(), input).await;
            if let Err(error) = out {
                eprintln!("huddle {slug}/{hid} @{handle} crashed: {error}");
                let (s2, h2, p2) = (slug.clone(), hid.clone(), handle.clone());
                me.op(move |h| {
                    let _ = h.update_p(&s2, &h2, &p2, obj([("status", "failed".into()), ("error", error.clone().into())]));
                    if h.load(&s2, &h2).is_some() {
                        let _ = h.system(&s2, &h2, &format!("@{p2} failed: {error}"), &[]);
                    }
                })
                .await;
            }
            me.runs.lock().remove(&Huddles::key(&slug, &hid, &handle));
            if let Some(b) = &me.board.browsers {
                b.board_browsers.release(&Self::lease(&slug, &hid, &handle));
            }
            let _ = run.done.send(true);
            let (again, stop) = {
                let st = run.st.lock();
                (st.again || st.pending, st.stop_requested)
            };
            let m2 = me.clone();
            me.op(move |h| {
                if Self::shutting_down(h) {
                    return;
                }
                m2.board.restart_work_changed();
                // Emit with running: false now that the run is gone.
                if h.load(&slug, &hid).is_some() {
                    let _ = h.update(&slug, &hid, |_| {});
                }
                if again && !stop {
                    h.deliver_now(&slug, &hid, &handle);
                }
            })
            .await;
        });
    }

    /// The host ticket's folder: its run's folder, made now if it needs a copy (`board.ensureSession`).
    async fn host_session(&self, slug: &str, host: &str) -> Result<(PathBuf, bool), String> {
        let s = self.board.git.ensure_session(slug, host).await?;
        let committed = s.is_git && crate::git::repo::has_commits(&s.dir).await;
        Ok((s.dir, committed))
    }

    /// `workspace`: where the helper works now (making its copy or resetting its snapshot first).
    async fn workspace(&self, slug: &str, hid: &str, handle: &str) -> Result<PathBuf, String> {
        let (h, p) = self.op_read(slug, hid, handle).await.ok_or_else(|| format!("huddle {hid} not found"))?;
        let (host_dir, committed) = self.host_session(slug, s(&h, "hostTicket")).await?;
        if s(&p, "workspace") == "shared" {
            return if is_snapshot(&p) && committed { self.snapshot(slug, &h, &p, &host_dir).await } else { Ok(host_dir) };
        }
        // An older huddle's own worktree carries on as it was.
        if p.get("copy").is_none_or(Value::is_null)
            && opt_s(&p, "branch").is_some()
            && let Some(wt) = opt_s(&p, "worktree").filter(|w| Path::new(w).exists())
        {
            return Ok(PathBuf::from(wt));
        }
        if let Some(c) = p.get("copy").and_then(Value::as_object) {
            let dir = c.get("dir").and_then(Value::as_str).unwrap_or("");
            if !b(c, "fresh") && !dir.is_empty() && Path::new(dir).exists() && super::copies::read_state(dir).is_some() {
                return Ok(PathBuf::from(dir));
            }
        }
        self.copy_for(slug, hid, handle, &host_dir, committed).await
    }

    /// The huddle and one participant, read under the room's lock.
    async fn op_read(&self, slug: &str, hid: &str, handle: &str) -> Option<(Obj, Obj)> {
        let (slug, hid, handle) = (slug.to_string(), hid.to_string(), handle.to_string());
        self.op(move |h| {
            let x = h.load(&slug, &hid)?;
            let p = participant(&x, &handle)?.clone();
            Some((x, p))
        })
        .await
        .flatten()
    }

    async fn update_p(&self, slug: &str, hid: &str, handle: &str, patch: Obj) {
        let (slug, hid, handle) = (slug.to_string(), hid.to_string(), handle.to_string());
        self.op(move |h| {
            let _ = h.update_p(&slug, &hid, &handle, patch);
        })
        .await;
    }

    async fn system(&self, slug: &str, hid: &str, text: String) {
        let (slug, hid) = (slug.to_string(), hid.to_string());
        self.op(move |h| {
            let _ = h.system(&slug, &hid, &text, &[]);
        })
        .await;
    }

    fn board_path(&self, slug: &str) -> Option<PathBuf> {
        self.board.profile(slug).and_then(|p| p.get("path").and_then(Value::as_str).map(PathBuf::from))
    }

    /// `copyFor`: (again) the helper's own copy of the host's folder: a worktree on its own branch at the folder as it
    /// is now when the repo has commits, else a plain copy. Changes it never handed in are saved first.
    pub(super) async fn copy_for(&self, slug: &str, hid: &str, handle: &str, host_dir: &Path, committed: bool) -> Result<PathBuf, String> {
        let (h, p) = self.op_read(slug, hid, handle).await.ok_or_else(|| format!("huddle {hid} not found"))?;
        let board = self.board_path(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let dir = agent_dir(&board, slug, s(&h, "hostTicket"), handle);
        if let Some(wt) = opt_s(&p, "worktree").filter(|_| opt_s(&p, "branch").is_none()) {
            let wt = PathBuf::from(wt);
            if wt.exists() {
                let _ = ws::force_remove_worktree(&board, &wt).await;
            }
            let _ = tokio::fs::remove_dir_all(&wt).await;
            ws::prune(&board).await;
            self.update_p(slug, hid, handle, obj([("worktree", Value::Null), ("snapshot", Value::Null)])).await;
        }
        let made = self.make_copy(slug, &h, &p, host_dir, committed).await?;
        let (sl, hi, ha) = (slug.to_string(), hid.to_string(), handle.to_string());
        self.op(move |h| {
            // Made again (after a conflict): whatever it changed and never handed in was saved first.
            if let Some(k) = made.kept {
                let _ = h.system(&sl, &hi, &format!("Saved the changes @{ha} never handed in to {} before giving it a fresh copy of the folder, so nothing is lost.", k.display()), &[]);
            }
            let _ = h.update_p(&sl, &hi, &ha, obj([("copy", made.copy)]));
        })
        .await;
        Ok(dir)
    }

    /// `snapshot`: a read-only helper's detached worktree at the host's committed HEAD, reset at every wake.
    async fn snapshot(&self, slug: &str, h: &Obj, p: &Obj, host_dir: &Path) -> Result<PathBuf, String> {
        let board = self.board_path(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let (sha, branch) = ws::head_of(host_dir).await?;
        let handle = s(p, "handle");
        let dir = opt_s(p, "worktree").map(PathBuf::from).unwrap_or_else(|| agent_dir(&board, slug, s(h, "hostTicket"), handle));
        ws::reset_snapshot(&board, &dir, &sha).await?;
        let patch = obj([("worktree", Value::from(dir.to_string_lossy().to_string())), ("branch", Value::Null), ("snapshot", json!({ "branch": branch, "sha": sha }))]);
        self.update_p(slug, s(h, "id"), handle, patch).await;
        Ok(dir)
    }

    /// `executeAgent`: the helper's run, from its folder to its end.
    async fn execute(self: Arc<Self>, slug: &str, hid: &str, handle: &str, run: Arc<AgentRun>, input: String) -> Result<(), String> {
        let Some(hs) = self.huddles.upgrade() else { return Ok(()) };
        {
            let (h, _) = self.op_read(slug, hid, handle).await.ok_or_else(|| format!("huddle {hid} not found"))?;
            let host = s(&h, "hostTicket");
            if hs.ticket(slug, host).is_none() {
                return Err(format!("host ticket {host} not found"));
            }
        }
        let dir = self.workspace(slug, hid, handle).await?;
        if run.st.lock().stop_requested || Self::shutting_down(&hs) {
            return Ok(());
        }
        let (h, p) = self.op_read(slug, hid, handle).await.ok_or_else(|| format!("huddle {hid} not found"))?;
        let host_id = s(&h, "hostTicket").to_string();
        let host = hs.ticket(slug, &host_id).ok_or_else(|| format!("host ticket {host_id} not found"))?;
        let profile = self.board.profile(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let session_id = opt_s(&p, "sessionId").map(str::to_string).unwrap_or_else(crate::git::landing::random_uuid);
        let resume = b(&p, "sessionStarted") && self.board.session_exists(&session_id);
        if opt_s(&p, "sessionId").is_none() {
            self.update_p(slug, hid, handle, obj([("sessionId", session_id.clone().into())])).await;
        }
        let outputs = hs.files.outputs_path(slug, &host_id);
        let output_dir = outputs.join(handle);
        let _ = std::fs::create_dir_all(&output_dir);
        let summary = outputs.join(summary_file(hid));
        let plan = outputs.join(proposal_file(hid));
        let lessons = self.lessons_for(&hs, slug, opt_s(&p, "preset"));
        let base = profile.get("baseBranch").and_then(Value::as_str);
        let system = hp::huddle_agent_system_prompt(
            &typed_huddle(&h),
            &typed_p(&p),
            &crate::runloop::prompt::prompt_ticket(&host),
            &output_dir.to_string_lossy(),
            &dir.to_string_lossy(),
            base,
            &lessons,
            Some(&summary.to_string_lossy()),
            plan.exists().then(|| plan.to_string_lossy().to_string()).as_deref(),
        );
        let connectors = crate::runs::connectors::board_connector_options(profile.get("claudeAiConnectors"));
        // The host ticket's browsers: board browsers start now and stay open until this helper's run ends.
        let lease = Self::lease(slug, hid, handle);
        let browsers = if self.board.browsers.is_some() { Some(self.board.run_browsers(slug, &host_id, &lease, &output_dir).await) } else { None };
        if run.st.lock().stop_requested || Self::shutting_down(&hs) {
            return Ok(());
        }
        let mut disallowed: Vec<String> = if b(&p, "canEdit") { Vec::new() } else { NO_EDIT_TOOLS.split(',').map(str::to_string).collect() };
        disallowed.extend(connectors.disallowed.clone());
        let mut servers = self.board.board_tools(slug);
        let no_chrome = browsers.as_ref().is_some_and(|b| b.no_chrome);
        let system = match browsers.as_ref().and_then(|b| b.note.clone()) {
            Some(note) => format!("{}\n\n{note}", if no_chrome { crate::prompts::rules::without_chrome_rule(&system) } else { system }),
            None => system,
        };
        if let Some(b) = &browsers {
            servers.extend(b.servers.clone());
        }
        let model = opt_s(&p, "model").or_else(|| profile.get("model").and_then(Value::as_str)).filter(|m| !m.is_empty()).map(str::to_string);
        let args = runner::build_args(&BuildArgs {
            session_id: session_id.clone(),
            resume,
            model: model.clone(),
            disallowed,
            mcp: Some(self.board.mcp_config(servers)),
            system_prompt: Some(system),
            no_chrome,
            ..Default::default()
        });
        let mut env = (self.board.opts.key_env)(slug);
        env.extend(connectors.env);
        env.insert("CKANBAN_OUTPUT_DIR".into(), output_dir.to_string_lossy().to_string());
        env.insert("CKANBAN_TICKET".into(), format!("{slug}/{host_id}"));
        env.insert(HUDDLE_AGENT_ENV.into(), format!("{hid}/{handle}/{}", s(&p, "token")));

        // Writes from the run's events, applied in order off the runtime.
        let (wtx, mut wrx) = mpsc::unbounded_channel::<Write>();
        let writer = {
            let hs = hs.clone();
            tokio::spawn(async move {
                while let Some(w) = wrx.recv().await {
                    let hs = hs.clone();
                    let _ = tokio::task::spawn_blocking(move || hs.op(|h| w(h))).await;
                }
            })
        };
        let started = Arc::new(Mutex::new(resume));
        let mut last_write = 0.0;
        let on_event: runner::OnEvent = {
            let (me, run, started, wtx) = (self.clone(), run.clone(), started.clone(), wtx.clone());
            let (slug, hid, handle, hs) = (slug.to_string(), hid.to_string(), handle.to_string(), hs.clone());
            let default_model = model.clone().unwrap_or_default();
            Box::new(move |ev: &Value| {
                let ty = ev.get("type").and_then(Value::as_str).unwrap_or("");
                if ty == "stream_event" || Self::shutting_down(&hs) {
                    return;
                }
                let (sl, hi, ha) = (slug.clone(), hid.clone(), handle.clone());
                if ty == "result" {
                    let (pending, ctx) = {
                        let mut st = run.st.lock();
                        st.idle = true;
                        st.turn = None;
                        (st.pending, st.ctx)
                    };
                    let total = ev.get("total_cost_usd").and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(0.0);
                    let me = me.clone();
                    let _ = wtx.send(Box::new(move |h: &Huddles| {
                        let cur = h.get(&sl, &hi).ok().and_then(|x| participant(&x, &ha).cloned());
                        let (cost, session_cost) = cost_after(cur.as_ref(), total);
                        let mut patch = obj([("status", status_after(cur.as_ref(), "idle")), ("idleAt", now_iso().into()), ("costUsd", num(cost)), ("sessionCostUsd", num(session_cost))]);
                        if ctx > 0.0 {
                            patch.insert("contextTokens".into(), num(ctx));
                        }
                        let _ = h.update_p(&sl, &hi, &ha, patch);
                        let spent = cost - cur.as_ref().and_then(|c| opt_f(c, "costUsd")).unwrap_or(0.0);
                        let dir = ckanban_core::DataDir::new(h.files.root().to_path_buf());
                        let _ = ckanban_core::spend::add_huddle_spend(&dir, &sl, spent, now_ms());
                        me.board.restart_work_changed();
                        let _ = h.check_budget(&sl, &hi);
                        // Turn boundary: a monitor gets what came in while it worked.
                        if pending {
                            h.deliver_now(&sl, &hi, &ha);
                        }
                    }));
                    return;
                }
                let init = ty == "system" && ev.get("subtype").and_then(Value::as_str) == Some("init");
                // Saved at once: a restart may cut the run off before it ends, and the next run must resume this session.
                if init && !*started.lock() {
                    *started.lock() = true;
                    let (sl, hi, ha) = (sl.clone(), hi.clone(), ha.clone());
                    let _ = wtx.send(Box::new(move |h: &Huddles| {
                        let _ = h.update_p(&sl, &hi, &ha, obj([("sessionStarted", true.into())]));
                    }));
                }
                let woke = {
                    let mut st = run.st.lock();
                    let w = st.idle && (ty == "assistant" || init);
                    if w {
                        st.idle = false;
                    }
                    w
                };
                if woke {
                    let (sl, hi, ha) = (sl.clone(), hi.clone(), ha.clone());
                    let _ = wtx.send(Box::new(move |h: &Huddles| {
                        if h.get(&sl, &hi).ok().and_then(|x| participant(&x, &ha).cloned()).is_some_and(|p| !settled(&p)) {
                            let _ = h.update_p(&sl, &hi, &ha, obj([("status", "working".into())]));
                        }
                    }));
                }
                // Live cost on the roster: the turn's messages priced from their usage until the result line.
                let msg = ev.get("message");
                if ty == "assistant"
                    && let (Some(id), Some(usage)) = (msg.and_then(|m| m.get("id")).and_then(Value::as_str), msg.and_then(|m| m.get("usage")))
                {
                    let model = msg.and_then(|m| m.get("model")).and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or(&default_model);
                    let cost = crate::sessions::workflows::message_cost(model, usage);
                    let mut st = run.st.lock();
                    st.turn.get_or_insert_with(HashMap::new).insert(id.to_string(), cost);
                    if ev.get("parent_tool_use_id").is_none_or(Value::is_null) {
                        let c = context_tokens(Some(usage));
                        if c > 0.0 {
                            st.ctx = c;
                        }
                    }
                }
                let line = crate::runs::activity::summarize_event(ev, false);
                let ctx = run.st.lock().ctx;
                let now = now_ms();
                if (line.is_some() || ctx > 0.0) && now - last_write >= ACTIVITY_THROTTLE_MS {
                    last_write = now;
                    let _ = wtx.send(Box::new(move |h: &Huddles| {
                        let mut patch = Map::new();
                        if let Some(l) = line {
                            patch.insert("lastActivity".into(), l.into());
                        }
                        if ctx > 0.0 {
                            patch.insert("contextTokens".into(), num(ctx));
                        }
                        let _ = h.update_p(&sl, &hi, &ha, patch);
                    }));
                }
            })
        };
        let mut o = RunOptions::new(self.opts.claude_bin.clone(), dir, args, on_event);
        o.input = Some(input);
        o.env = env;
        o.idle_ms = if s(&p, "mode") == "monitor" { self.opts.idle_ms } else { 0 };
        let handle_ = runner::start_run(o);
        run.st.lock().handle = Some(handle_.clone());
        let out = handle_.wait().await;
        drop(wtx);
        let _ = writer.await;
        if Self::shutting_down(&hs) {
            return Ok(());
        }
        let started = *started.lock() || self.board.session_exists(&session_id);
        let stopped = run.st.lock().stop_requested || handle_.stopped();
        let (sl, hi, ha) = (slug.to_string(), hid.to_string(), handle.to_string());
        let (code, stderr) = (out.code, out.stderr.clone());
        self.op(move |h| {
            if h.load(&sl, &hi).is_none() {
                return;
            }
            if stopped {
                let _ = h.update_p(&sl, &hi, &ha, obj([("sessionStarted", started.into()), ("status", "stopped".into())]));
                return;
            }
            if code != 0 {
                let lines: Vec<&str> = stderr.trim().split('\n').collect();
                let tail = lines[lines.len().saturating_sub(3)..].join("\n");
                let error = if tail.is_empty() { format!("claude exited with code {code}") } else { tail };
                let _ = h.update_p(&sl, &hi, &ha, obj([("sessionStarted", started.into()), ("status", "failed".into()), ("error", error.clone().into())]));
                let _ = h.system(&sl, &hi, &format!("@{ha}'s run failed: {error}"), &[]);
                return;
            }
            let cur = h.get(&sl, &hi).ok().and_then(|x| participant(&x, &ha).cloned());
            let _ = h.update_p(&sl, &hi, &ha, obj([("sessionStarted", started.into()), ("status", status_after(cur.as_ref(), "idle")), ("idleAt", now_iso().into())]));
        })
        .await;
        Ok(())
    }

    /// `lessonsFor`: the "Lessons from past huddles" section for a helper of `preset` (ad-hoc: All-roles notes only).
    fn lessons_for(&self, hs: &Huddles, slug: &str, preset: Option<&str>) -> String {
        use crate::team::notes::{ALL_ROLES, RoleNotes, Scope, lessons_section, note_role};
        let read = |role: &str| RoleNotes { general: hs.team.read_notes(slug, role, Scope::General), repo: hs.team.read_notes(slug, role, Scope::Repo) };
        let role = preset.filter(|p| *p != ALL_ROLES && note_role(Some(&Value::from(*p))).is_some());
        lessons_section(&read(ALL_ROLES), role.map(read).as_ref(), role)
    }

    /// `deliverNow` for a helper: into its live run, or a new run.
    fn deliver_now_agent(&self, h: &Huddles, slug: &str, hid: &str, handle: &str) {
        let Some(x) = h.load(slug, hid) else { return };
        let Some(p) = participant(&x, handle).cloned() else { return };
        if s(&x, "status") != "live" || matches!(s(&p, "status"), "stopped" | "done") || Self::shutting_down(h) {
            return;
        }
        if let Some(run) = self.run(slug, hid, handle) {
            let (idle, handle_) = {
                let mut st = run.st.lock();
                if st.stop_requested {
                    return;
                }
                // Still starting (its folder, setup): it gets them at its first turn boundary.
                let Some(hd) = st.handle.clone() else {
                    st.pending = true;
                    return;
                };
                // Between turns, a snapshot helper sees the host's latest commit first. Mid-turn its files stay put.
                if st.idle && is_snapshot(&p) && !st.fresh {
                    if st.refreshing {
                        return;
                    }
                    st.refreshing = true;
                    drop(st);
                    let me = self.arc();
                    let (sl, hi, ha, r) = (slug.to_string(), hid.to_string(), handle.to_string(), run.clone());
                    self.chore(async move {
                        if let Err(e) = me.workspace(&sl, &hi, &ha).await
                            && !r.st.lock().stop_requested
                        {
                            me.system(&sl, &hi, format!("Couldn't refresh @{ha}'s snapshot: {e}")).await;
                        }
                        {
                            let mut st = r.st.lock();
                            st.refreshing = false;
                            st.fresh = true;
                        }
                        me.op(move |h| h.deliver_now(&sl, &hi, &ha)).await;
                    });
                    return;
                }
                if st.refreshing {
                    return;
                }
                st.fresh = false;
                st.pending = false;
                (st.idle, hd)
            };
            let Ok(Some((unread, tagged, prev))) = h.take_unread(slug, hid, handle, false) else { return };
            let Ok(x) = h.get(slug, hid) else { return };
            let Some(cur) = participant(&x, handle).cloned() else { return };
            let snap: Option<pt::Snapshot> = if is_snapshot(&cur) { cur.get("snapshot").filter(|v| v.is_object()).and_then(|v| serde_json::from_value(v.clone()).ok()) } else { None };
            let text = hp::huddle_agent_prompt("wake", &typed_p(&cur), &digest(&x, &unread), tagged, snap.as_ref());
            if handle_.send(&text, false) {
                if idle && !settled(&p) {
                    let _ = h.update_p(slug, hid, handle, obj([("status", "working".into())]));
                }
                run.st.lock().idle = false;
            } else {
                // Input is closing (the run is finishing): a new run picks them up.
                h.undo_unread(slug, hid, handle, prev);
                run.st.lock().again = true;
            }
            return;
        }
        // Before taking the unread messages: recover() hands them over after the restart.
        if self.hold_for_restart(h, slug, hid, handle) {
            return;
        }
        if let Ok(Some((unread, tagged, _))) = h.take_unread(slug, hid, handle, false) {
            let text = hp::huddle_agent_prompt("wake", &typed_p(&p), &digest(&x, &unread), tagged, None);
            self.run_agent(h, slug, hid, handle, text);
        }
    }

    /// `removeWorktrees`: after a close, the read-only snapshots and each helper's copy when nothing would be lost;
    /// a system note lists the ones kept. Report-only until deletes are on: what would go is logged and stays.
    async fn remove_worktrees(self: Arc<Self>, slug: String, hid: String) {
        // The helpers' runs were just stopped: let them end first.
        let ending: Vec<Arc<AgentRun>> = self.runs.lock().iter().filter(|(k, _)| k.starts_with(&format!("{slug}/{hid}/"))).map(|(_, r)| r.clone()).collect();
        for r in ending {
            r.finished().await;
        }
        let Some(Some(h)) = self.op({
            let (slug, hid) = (slug.clone(), hid.clone());
            move |h| h.load(&slug, &hid)
        })
        .await
        else {
            return;
        };
        let Some(board) = self.board_path(&slug) else { return };
        let base = self
            .huddles
            .upgrade()
            .and_then(|hs| hs.ticket(&slug, s(&h, "hostTicket")))
            .and_then(|t| t.json.get("branch").and_then(Value::as_str).map(str::to_string))
            .or_else(|| self.board.profile(&slug).and_then(|p| p.get("baseBranch").and_then(Value::as_str).map(str::to_string)))
            .unwrap_or_else(|| "main".into());
        let deletes = crate::dryrun::deletes_on();
        let root = self.huddles.upgrade().map(|hs| hs.files.root().to_path_buf());
        let report = |path: &str, what: &str| {
            if let Some(root) = &root {
                let mut m = Map::new();
                m.insert("board".into(), json!(slug));
                m.insert("huddle".into(), json!(hid));
                m.insert("path".into(), json!(path));
                m.insert("action".into(), json!(what));
                crate::dryrun::report(root, "huddle-copies", m);
            }
        };
        let (mut removed, mut kept) = (Vec::<String>::new(), Vec::<String>::new());
        for p in participants(&h).into_iter().filter(|p| s(p, "kind") == "agent") {
            let handle = s(p, "handle").to_string();
            if let Some(c) = p.get("copy").and_then(Value::as_object) {
                let dir = c.get("dir").and_then(Value::as_str).unwrap_or("").to_string();
                let kind = c.get("kind").and_then(Value::as_str).unwrap_or("folder").to_string();
                // Only the folder the board made for it: a stored path elsewhere is never removed.
                if PathBuf::from(&dir) != agent_dir(&board, &slug, s(&h, "hostTicket"), &handle) {
                    kept.push(format!("@{handle}: {dir} (not where the board keeps copies, so it was left alone)"));
                    continue;
                }
                let mine: Vec<&Obj> = list(&h, "handIns").into_iter().filter(|x| s(x, "from") == handle).collect();
                let waiting = mine.iter().any(|x| s(x, "status") == "waiting");
                let redo = mine.last().is_some_and(|x| s(x, "status") == "conflict");
                let mut keep = waiting.then(|| "changes it handed in still wait for a decision".to_string());
                if keep.is_none() {
                    let (d, k) = (dir.clone(), kind.clone());
                    match tokio::task::spawn_blocking(move || ws::unhanded(&d, &k)).await {
                        Ok(Ok(true)) => keep = Some("it has changes that were never handed in".into()),
                        Ok(Ok(false)) => {}
                        Ok(Err(e)) => keep = Some(format!("couldn't remove it: {e}")),
                        Err(e) => keep = Some(format!("couldn't remove it: {e}")),
                    }
                }
                if keep.is_none() {
                    if deletes {
                        let repo = (kind == "git").then(|| c.get("repo").and_then(Value::as_str).map(PathBuf::from).unwrap_or_else(|| board.clone()));
                        ws::remove_copy(Path::new(&dir), repo.as_deref(), c.get("branch").and_then(Value::as_str), redo).await;
                        if redo {
                            kept.push(format!("@{handle}: {dir}.handins (changes that weren't brought in because of a conflict)"));
                        }
                    } else {
                        report(&dir, "remove-copy");
                    }
                }
                let kd = ws::kept_dir(&dir);
                if kd.exists() {
                    kept.push(format!("@{handle}: {} (changes saved before a fresh copy was made)", kd.display()));
                }
                match keep {
                    Some(k) => kept.push(format!("@{handle}: {dir} ({k})")),
                    None if deletes => {
                        removed.push(format!("@{handle}"));
                        self.update_p(&slug, &hid, &handle, obj([("copy", Value::Null)])).await;
                    }
                    None => {}
                }
                continue;
            }
            let Some(wt) = opt_s(p, "worktree").map(str::to_string) else { continue };
            if opt_s(p, "branch").is_none() {
                // A read-only snapshot: nothing in it is anyone's work, so it goes without a note.
                if !deletes {
                    report(&wt, "remove-snapshot");
                    continue;
                }
                let r = if Path::new(&wt).exists() { ws::force_remove_worktree(&board, Path::new(&wt)).await } else { Ok(()) };
                match r {
                    Err(e) => kept.push(format!("@{handle}: {wt}: {e}")),
                    Ok(()) => self.update_p(&slug, &hid, &handle, obj([("worktree", Value::Null)])).await,
                }
                continue;
            }
            if !deletes {
                report(&wt, "remove-own-worktree");
                continue;
            }
            match ws::remove_own_worktree(&board, Path::new(&wt), opt_s(p, "branch"), &base).await {
                Some(why) => kept.push(format!("@{handle}: {wt}{}: {why}", opt_s(p, "branch").map(|b| format!(" (branch {b})")).unwrap_or_default())),
                None => {
                    removed.push(format!("@{handle}"));
                    self.update_p(&slug, &hid, &handle, obj([("worktree", Value::Null), ("branch", Value::Null)])).await;
                }
            }
        }
        let mut lines = Vec::new();
        if !removed.is_empty() {
            lines.push(format!("Removed the copies of the folder of {} (all their changes were handed in).", removed.join(", ")));
        }
        if !kept.is_empty() {
            lines.push("Kept these copies of the folder, so nothing is lost; take what you need from them, then delete them yourself:".into());
            lines.extend(kept.iter().map(|k| format!("- {k}")));
        }
        if !lines.is_empty() {
            self.system(&slug, &hid, lines.join("\n")).await;
        }
    }

    /// `cleanOutputs`: project copies and dependency folders helpers left in the ticket's outputs, for one huddle
    /// (just closed) or every closed huddle of a ticket that moved to Done. One cleanup per ticket at a time.
    pub(super) async fn clean_outputs(self: Arc<Self>, slug: String, ticket: String, hid: Option<String>) {
        let lock = self.cleaning.lock().entry(format!("{slug}/{ticket}")).or_default().clone();
        let _held = lock.lock().await;
        self.clean_outputs_now(&slug, &ticket, hid.as_deref()).await;
    }

    async fn clean_outputs_now(&self, slug: &str, ticket: &str, hid: Option<&str>) {
        let Some(hs) = self.huddles.upgrade() else { return };
        let mine = |hs: &Huddles| -> Vec<Arc<Obj>> {
            hs.files.index(slug).iter().filter(|x| s(x, "hostTicket") == ticket && (hid.is_none_or(|id| s(x, "id") == id) || s(x, "status") != "closed")).cloned().collect()
        };
        let first = mine(&hs);
        if !first.iter().any(|x| s(x, "status") == "closed") {
            return;
        }
        let Some(board) = self.board_path(slug) else { return };
        if hs.ticket(slug, ticket).is_none() {
            return;
        }
        // Their runs were just stopped: let them end first, so nothing writes while the copies go.
        let closed: Vec<String> = first.iter().filter(|x| s(x, "status") == "closed").map(|x| format!("{slug}/{}/", s(x, "id"))).collect();
        let ending: Vec<Arc<AgentRun>> = self.runs.lock().iter().filter(|(k, _)| closed.iter().any(|c| k.starts_with(c.as_str()))).map(|(_, r)| r.clone()).collect();
        for r in ending {
            r.finished().await;
        }
        let now = mine(&hs);
        let busy: std::collections::HashSet<String> = now.iter().filter(|x| s(x, "status") != "closed").flat_map(|x| participants(x).into_iter().map(|p| s(p, "handle").to_string())).collect();
        let handles: Vec<String> = now
            .iter()
            .filter(|x| s(x, "status") == "closed" && hid.is_none_or(|id| s(x, "id") == id))
            .flat_map(|x| participants(x).into_iter().filter(|p| s(p, "kind") == "agent" && !busy.contains(s(p, "handle"))).map(|p| s(p, "handle").to_string()))
            .collect();
        if handles.is_empty() {
            return;
        }
        let outputs = hs.files.outputs_path(slug, ticket);
        let root = hs.files.root().to_path_buf();
        let (rt, b2, sl, tk, h2) = (self.rt.clone(), board.clone(), slug.to_string(), ticket.to_string(), hid.map(str::to_string));
        let out = tokio::task::spawn_blocking(move || {
            let names = super::output_copies::project_names(Some(&b2));
            let report = (!crate::dryrun::deletes_on()).then(|| {
                let mut m = Map::new();
                m.insert("board".into(), json!(sl));
                m.insert("ticket".into(), json!(tk));
                if let Some(h) = &h2 {
                    m.insert("huddle".into(), json!(h));
                }
                m
            });
            super::output_copies::remove_output_copies(rt, &outputs, &handles, &names, Some(&b2), report.map(|m| (root.as_path(), m)))
        })
        .await;
        let Ok(out) = out else { return };
        if out.reported {
            if !out.removed.is_empty() {
                eprintln!("[huddle] report-only: would remove {} copied or installed folders from {ticket}'s outputs", out.removed.len());
            }
            return;
        }
        if out.worktree {
            ws::prune(&board).await;
        }
        if !out.failed.is_empty() {
            eprintln!("[huddle] couldn't remove these from {ticket}'s outputs: {}", out.failed.join(", "));
        }
        if !out.removed.is_empty() {
            eprintln!("[huddle] removed {} copied or installed folders from {ticket}'s outputs: {}", out.removed.len(), out.removed.join(", "));
        }
        let Some(hid) = hid else { return };
        if out.removed.is_empty() && out.failed.is_empty() {
            return;
        }
        let mut lines = Vec::new();
        if !out.removed.is_empty() {
            lines.push(format!("Removed copies of the project the helpers left in the ticket's outputs ({}). Reports and other results stay.", out.removed.join(", ")));
        }
        if !out.failed.is_empty() {
            lines.push(format!("Couldn't fully remove: {}. Delete what's left yourself if you don't need it.", out.failed.join(", ")));
        }
        let (slug, hid, text) = (slug.to_string(), hid.to_string(), lines.join("\n"));
        self.op(move |h| {
            // The huddle may have been deleted during a long removal.
            if h.load(&slug, &hid).is_some() {
                let _ = h.system(&slug, &hid, &text, &[]);
            }
        })
        .await;
    }

    /// `shutdown`: helpers mid-turn are marked so recover() resumes them; every helper's run is stopped, and waited
    /// for up to 6 s. Call after `Huddles::shutting_down` is set.
    pub async fn shutdown(&self) {
        let runs: Vec<(String, Arc<AgentRun>)> = self.runs.lock().iter().map(|(k, r)| (k.clone(), r.clone())).collect();
        let mut marks = Vec::new();
        for (key, run) in &runs {
            let mut st = run.st.lock();
            if !st.idle && !st.stop_requested {
                marks.push(key.clone());
            }
            st.stop_requested = true;
            if let Some(h) = &st.handle {
                h.stop();
            }
        }
        if !marks.is_empty()
            && let Some(hs) = self.huddles.upgrade()
        {
            let _ = tokio::task::spawn_blocking(move || {
                // The room's own lock: the shutdown flag already keeps new work out.
                hs.op(|h| {
                    for key in marks {
                        let mut it = key.splitn(3, '/');
                        let (slug, hid, handle) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""));
                        let _ = h.update_p(slug, hid, handle, obj([("interrupted", true.into())]));
                    }
                })
            })
            .await;
        }
        let all = async {
            for (_, r) in &runs {
                r.finished().await;
            }
        };
        let _ = tokio::time::timeout(SHUTDOWN_WAIT, all).await;
    }

    /// `whenIdle`: every helper's run and background chore has ended.
    pub async fn when_idle(&self) {
        loop {
            let runs: Vec<Arc<AgentRun>> = self.runs.lock().values().cloned().collect();
            for r in &runs {
                r.finished().await;
            }
            let wait = self.chores_done.notified();
            if *self.chores.lock() == 0 {
                if self.runs.lock().is_empty() {
                    return;
                }
                continue;
            }
            wait.await;
        }
    }

    /// `mainResult`: a ticket session's result line; a huddle reply run's cost counts toward the huddle that woke it.
    /// The total is the session's running total, so the reply's cost is the growth since the session's last result.
    fn main_result(&self, h: &Huddles, slug: &str, ticket: &str, ev: &Value) {
        if ev.get("type").and_then(Value::as_str) != Some("result") {
            return;
        }
        let sid = match ev.get("session_id") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(x)) => x.clone(),
            Some(v) => v.to_string(),
        };
        let total = ev.get("total_cost_usd").and_then(Value::as_f64).filter(|x| x.is_finite()).unwrap_or(0.0);
        let key = format!("{slug}/{ticket}/{sid}");
        let known = self.ticket_totals.lock().insert(key, total);
        if Self::shutting_down(h) {
            return;
        }
        let Some((hid, handle)) = self.main_woken.lock().get(&format!("{slug}/{ticket}")).cloned() else { return };
        if !self.board.is_peer_run(slug, ticket) {
            return;
        }
        let ok = |h: &Huddles| -> Option<Obj> {
            let x = h.load(slug, &hid)?;
            let p = participant(&x, &handle).filter(|p| opt_s(p, "ticketId") == Some(ticket))?.clone();
            (s(&x, "status") != "closed").then_some(p)
        };
        if ok(h).is_none() {
            return;
        }
        let prev = match known {
            Some(k) => k,
            None => self.prior_session_total(slug, ticket, &sid, total),
        };
        let Some(p) = ok(h) else { return };
        let cost = if total >= prev { total - prev } else { total };
        let c = opt_f(&p, "costUsd").unwrap_or(0.0) + cost;
        let _ = h.update_p(slug, &hid, &handle, obj([("costUsd", num(c)), ("sessionCostUsd", num(total)), ("idleAt", now_iso().into())]));
        let _ = h.check_budget(slug, &hid);
    }

    /// `priorSessionTotal`: the session's running total before its latest result, from the ticket's run log; 0 if none.
    fn prior_session_total(&self, slug: &str, ticket: &str, sid: &str, latest: f64) -> f64 {
        let file = self.board.tickets.ticket_dir(slug, ticket).join("activity.jsonl");
        let Ok(text) = std::fs::read_to_string(&file) else { return 0.0 };
        let mut totals: Vec<f64> = Vec::new();
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let ev = v.get("event").unwrap_or(&Value::Null);
            if ev.get("type").and_then(Value::as_str) == Some("result")
                && ev.get("session_id").and_then(Value::as_str) == Some(sid)
                && let Some(t) = ev.get("total_cost_usd").and_then(Value::as_f64)
            {
                totals.push(t);
            }
        }
        if totals.last() == Some(&latest) {
            totals.pop();
        }
        totals.last().copied().unwrap_or(0.0)
    }

    /// `ticketContext`: a ticket session's conversation size, on its ticket-main participants in open huddles.
    fn ticket_context(&self, h: &Huddles, slug: &str, ticket: &str, ev: &Value) {
        if Self::shutting_down(h) {
            return;
        }
        let key = format!("{slug}/{ticket}");
        let ty = ev.get("type").and_then(Value::as_str);
        let tokens = {
            let mut ctx = self.ticket_ctx.lock();
            if ty == Some("assistant") {
                if ev.get("parent_tool_use_id").is_some_and(|v| !v.is_null()) {
                    return;
                }
                let t = context_tokens(ev.get("message").and_then(|m| m.get("usage")));
                if t == 0.0 {
                    return;
                }
                ctx.entry(key.clone()).or_insert((0.0, 0.0, 0.0)).0 = t;
            } else if ty != Some("result") || !ctx.contains_key(&key) {
                return;
            }
            let cur = ctx.get_mut(&key).expect("just set");
            let now = now_ms();
            if cur.0 == cur.2 || (ty != Some("result") && now - cur.1 < ACTIVITY_THROTTLE_MS) {
                return;
            }
            cur.2 = cur.0;
            cur.1 = now;
            cur.0
        };
        for x in h.files.open(slug).iter() {
            for p in participants(x) {
                if s(p, "kind") == "ticket-main" && opt_s(p, "ticketId") == Some(ticket) && opt_f(p, "contextTokens") != Some(tokens) {
                    let _ = h.update_p(slug, s(x, "id"), s(p, "handle"), obj([("contextTokens", num(tokens))]));
                }
            }
        }
    }
}

impl HuddleRunner for Agents {
    fn agent(&self, slug: &str, hid: &str, handle: &str) -> Option<AgentState> {
        let r = self.run(slug, hid, handle)?;
        let st = r.st.lock();
        Some(AgentState { idle: st.idle, pending: st.pending, again: st.again, stop_requested: st.stop_requested, started: st.handle.is_some(), refreshing: st.refreshing })
    }

    fn busy_boards(&self) -> Vec<String> {
        self.runs
            .lock()
            .iter()
            .filter(|(_, r)| {
                let st = r.st.lock();
                !st.idle && !st.stop_requested
            })
            .map(|(k, _)| k.split('/').next().unwrap_or("").to_string())
            .collect()
    }

    fn turn_cost(&self, slug: &str, hid: &str, handle: &str) -> f64 {
        self.run(slug, hid, handle).and_then(|r| r.st.lock().turn.as_ref().map(|t| t.values().sum())).unwrap_or(0.0)
    }

    fn runs_agents(&self) -> bool {
        true
    }

    fn kickoff(&self, h: &Huddles, slug: &str, hid: &str, handle: &str) {
        if self.hold_for_restart(h, slug, hid, handle) {
            return;
        }
        let Ok(x) = h.get(slug, hid) else { return };
        let Some(p) = participant(&x, handle).cloned() else { return };
        let d = match h.take_unread(slug, hid, handle, true) {
            Ok(Some((unread, _, _))) => digest(&x, &unread),
            _ => String::new(),
        };
        self.run_agent(h, slug, hid, handle, hp::huddle_agent_prompt("start", &typed_p(&p), &d, false, None));
    }

    fn deliver_agent(&self, h: &Huddles, slug: &str, hid: &str, handle: &str, mentioned: bool) {
        if let Some(run) = self.run(slug, hid, handle) {
            // Mid-turn: a mention steers it now; for a monitor the rest waits for the turn boundary.
            let mut st = run.st.lock();
            if !mentioned && !st.idle {
                st.pending = true;
                return;
            }
        }
        self.deliver_now_agent(h, slug, hid, handle);
    }

    fn deliver_main(&self, h: &Huddles, slug: &str, hid: &str, handle: &str) {
        let Ok(x) = h.get(slug, hid) else { return };
        let Some(p) = participant(&x, handle).cloned() else { return };
        let Some(ticket) = opt_s(&p, "ticketId").map(str::to_string) else { return };
        let Ok(Some((unread, _, prev))) = h.take_unread(slug, hid, handle, false) else { return };
        self.main_woken.lock().insert(format!("{slug}/{ticket}"), (hid.to_string(), handle.to_string()));
        let t = h.ticket(slug, &ticket);
        // Its own auto huddle wakes the host as unattended work on the ticket (it ends with a result line and lands).
        let own = t.as_ref().and_then(|t| t.json.get("autoHuddle").cloned()).filter(Value::is_object);
        let host_wake = is_auto(&x)
            && is_coordinator(&x, &p)
            && own.as_ref().is_some_and(|a| a.get("state").and_then(Value::as_str) == Some("live") && a.get("huddleId").and_then(Value::as_str) == Some(hid));
        let planning = t.as_ref().is_some_and(|t| t.status == "planning");
        let text = hp::huddle_main_prompt(&typed_huddle(&x), &typed_p(&p), &digest(&x, &unread), self.board.git.committed(slug), planning);
        let opts = if host_wake { ChatOptions { host_wake: true, ..Default::default() } } else { ChatOptions { peer: true, ..Default::default() } };
        if let Err(e) = self.board.chat(slug, &ticket, &text, opts) {
            h.undo_unread(slug, hid, handle, prev);
            let _ = h.system(slug, hid, &format!("Couldn't reach @{handle}: {}", e.message), &[]);
        }
    }

    fn stop_run(&self, slug: &str, hid: &str, p: &Obj) {
        let handle = s(p, "handle");
        if let Some(run) = self.run(slug, hid, handle) {
            let mut st = run.st.lock();
            st.stop_requested = true;
            if let Some(h) = &st.handle {
                h.stop();
            }
        }
        if let Some(hs) = self.huddles.upgrade() {
            hs.main_pending.lock().remove(&Huddles::key(slug, hid, handle));
        }
        if s(p, "kind") == "ticket-main"
            && let Some(t) = opt_s(p, "ticketId")
            && self.board.is_peer_run(slug, t)
            && self.main_woken.lock().get(&format!("{slug}/{t}")).is_some_and(|(h, _)| h == hid)
        {
            self.board.stop(slug, t);
        }
    }

    fn end_when_idle(&self, slug: &str, hid: &str, handle: &str) {
        if let Some(r) = self.run(slug, hid, handle)
            && let Some(h) = r.st.lock().handle.clone()
        {
            h.end_when_idle();
        }
    }

    fn chat_ticket(&self, slug: &str, ticket: &str, text: String) -> Option<futures_util::future::BoxFuture<'static, Result<(), String>>> {
        let r = self.board.chat(slug, ticket, &text, ChatOptions { peer: true, ..Default::default() }).map(|_| ()).map_err(|e| e.message);
        Some(Box::pin(std::future::ready(r)))
    }

    fn after_close(&self, h: &Huddles, slug: &str, hid: &str) {
        let Some(x) = h.load(slug, hid) else { return };
        let me = self.arc();
        if participants(&x).iter().any(|p| s(p, "kind") == "agent" && (opt_s(p, "worktree").is_some() || p.get("copy").is_some_and(Value::is_object))) {
            self.chore(me.clone().remove_worktrees(slug.to_string(), hid.to_string()));
        }
        self.chore(me.clean_outputs(slug.to_string(), s(&x, "hostTicket").to_string(), Some(hid.to_string())));
    }

    fn fresh_copy(&self, h: &Huddles, slug: &str, hid: &str, handle: &str, host_dir: &Path) -> Result<(), String> {
        // Called under the room's lock by a request on the blocking pool: the folder work runs here (git as child
        // processes), the huddle writes after it under the lock this thread holds.
        let rt = tokio::runtime::Handle::try_current().map_err(|e| e.to_string())?;
        let committed = rt.block_on(async { crate::git::repo::is_git_repo(host_dir).await && crate::git::repo::has_commits(host_dir).await });
        let x = h.get(slug, hid).map_err(|e| e.message)?;
        let p = participant(&x, handle).cloned().ok_or_else(|| format!("no participant @{handle}"))?;
        let made = rt.block_on(self.make_copy(slug, &x, &p, host_dir, committed))?;
        if let Some(k) = made.kept {
            let _ = h.system(slug, hid, &format!("Saved the changes @{handle} never handed in to {} before giving it a fresh copy of the folder, so nothing is lost.", k.display()), &[]);
        }
        let _ = h.update_p(slug, hid, handle, obj([("copy", made.copy)]));
        Ok(())
    }

    fn recover_agent(&self, h: &Huddles, slug: &str, hid: &str, handle: &str) -> bool {
        let Ok(x) = h.get(slug, hid) else { return false };
        let Some(p) = participant(&x, handle).cloned() else { return false };
        let d = match h.take_unread(slug, hid, handle, true) {
            Ok(Some((unread, _, _))) => digest(&x, &unread),
            _ => String::new(),
        };
        let kind = if b(&p, "sessionStarted") { "interrupted" } else { "start" };
        self.run_agent(h, slug, hid, handle, hp::huddle_agent_prompt(kind, &typed_p(&p), &d, false, None));
        true
    }

    fn start_auto(&self, h: &Huddles, slug: &str, host: &str, input: &AutoInput) -> R<(Option<Obj>, bool, String)> {
        self.start_auto_now(h, slug, host, input)
    }

    fn auto_ended(&self, h: &Huddles, slug: &str, hid: &str, how: &str, why: &str) {
        self.auto_ended_now(h, slug, hid, how, why);
    }

    fn after_recover(&self, h: &Huddles, slug: &str) {
        self.recover_auto(h, slug);
    }

    fn wants_ticket(&self, slug: &str, t: &Obj) -> bool {
        let id = s(t, "id");
        (s(t, "status") == "done" && opt_s(t, "doneAt").is_some()) || self.slot_woken.lock().get(slug).is_some_and(|w| w == id)
    }

    fn ticket_updated(&self, h: &Huddles, slug: &str, t: &Obj) {
        self.on_ticket(h, slug, t);
    }

    fn ticket_activity(&self, h: &Huddles, slug: &str, id: &str, ev: &Value) {
        self.ticket_context(h, slug, id, ev);
        self.main_result(h, slug, id, ev);
    }

    fn session(&self, h: &Huddles, slug: &str, hid: &str, handle: &str, q: &SessionQuery) -> R<Value> {
        super::session::participant_session(self, h, slug, hid, handle, q)
    }

    fn session_tool(&self, h: &Huddles, slug: &str, hid: &str, handle: &str, tool: &str) -> R<Option<Value>> {
        super::session::participant_tool(self, h, slug, hid, handle, tool)
    }

    fn reveal_session(&self, h: &Huddles, slug: &str, hid: &str, handle: &str) -> R<Value> {
        let file = super::session::participant_session(self, h, slug, hid, handle, &SessionQuery { limit: Some(1.0), ..Default::default() })?;
        let Some(f) = file.get("file").and_then(Value::as_str).map(str::to_string) else { return fail(404, format!("@{handle} has no transcript file yet")) };
        let rt = tokio::runtime::Handle::try_current().map_err(|e| Fail::new(500, e.to_string()))?;
        rt.block_on(crate::git::share::reveal_file(Path::new(&f))).map_err(|e| Fail::new(e.status, e.message))?;
        Ok(json!({ "ok": true, "file": f }))
    }
}

/// A copy made for a helper: its `copy` field and where unsent changes were saved first.
pub(super) struct Made {
    pub copy: Value,
    pub kept: Option<PathBuf>,
}

impl Agents {
    /// The folder work of `copyFor` without the huddle writes (a caller holding the room's lock writes them).
    pub(super) async fn make_copy(&self, slug: &str, h: &Obj, p: &Obj, host_dir: &Path, committed: bool) -> Result<Made, String> {
        let board = self.board_path(slug).ok_or_else(|| format!("board {slug} not found"))?;
        let host = s(h, "hostTicket").to_string();
        let handle = s(p, "handle");
        let dir = agent_dir(&board, slug, &host, handle);
        let mut kept = None;
        if let Some(c) = p.get("copy").and_then(Value::as_object)
            && c.get("dir").and_then(Value::as_str).map(PathBuf::from).as_deref() == Some(dir.as_path())
            && dir.exists()
        {
            let (d, kind, label) = (dir.to_string_lossy().to_string(), c.get("kind").and_then(Value::as_str).unwrap_or("folder").to_string(), now_iso().replace([':', '.'], "-"));
            kept = tokio::task::spawn_blocking(move || ws::keep_unhanded(&d, &kind, &label)).await.map_err(|e| e.to_string())??;
        }
        let branch = committed.then(|| format!("ck/{host}-{handle}"));
        let repo = if committed { Some(ws::main_repo(host_dir).await) } else { None };
        match (&repo, &branch) {
            (Some(r), Some(b)) => ws::make_git_copy(r, host_dir, &dir, b).await?,
            _ => ws::make_folder_copy(host_dir, &dir).await?,
        }
        let copy = json!({
            "kind": if committed { "git" } else { "folder" },
            "dir": dir.to_string_lossy(),
            "repo": repo.as_ref().map(|r| r.to_string_lossy().to_string()),
            "branch": branch,
            "at": now_iso(),
        });
        Ok(Made { copy, kept })
    }
}
