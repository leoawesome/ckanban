//! Running `claude -p` (`src/runs/runner.ts`): the command line (`build_args`), answers to Claude Code's control
//! requests (`control_response`), and `start_run`, which spawns Claude in its own process group and hands back a
//! `RunHandle`.
//!
//! One task per run owns everything about it (the child, its timers, the events read so far); the handle talks to it
//! through a small queue, so the handle's methods never wait on the run. Claude's stdin gets its own writer task, so a
//! Claude that stops reading can't block the reading of its output. Callbacks (`on_event`, `on_waiting`, `on_stall`)
//! run on the run's task, in order: they must not block (hand slow work to `spawn_blocking`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, mpsc, oneshot, watch};
use tokio::time::Instant;

use super::{claude, connectors, js};

/// How long `stop_task` waits for Claude Code's answer.
pub const CONTROL_TIMEOUT_MS: u64 = 10_000;
/// After Claude's last task finishes, how long to wait for the turn it starts before ending input anyway.
pub const BACKGROUND_GRACE_MS: u64 = 10_000;
/// How long a monitor-mode huddle session stays open between turns before it exits.
pub const MONITOR_IDLE_MS: u64 = 30 * 60_000;
/// Board setting "Stall after": minutes without stream output before a run counts as stalled (0: never).
pub const DEFAULT_STALL_MINUTES: u64 = 20;
/// After TERM, how long a stopped run gets before KILL.
const KILL_AFTER: Duration = Duration::from_secs(5);
const TASK_DONE: [&str; 4] = ["completed", "failed", "killed", "stopped"];
const STDERR_TAIL: usize = 2048;

/// The huddle helpers' "can't edit" list (`NO_EDIT_TOOLS` in `src/huddle/huddle-roster.ts`).
pub const NO_EDIT_TOOLS: &str = "Edit,Write,NotebookEdit";

/// Everything `buildArgs` takes; `Default` is a fresh session with nothing extra.
#[derive(Debug, Clone, Default)]
pub struct BuildArgs {
    pub session_id: String,
    pub resume: bool,
    pub model: Option<String>,
    /// Tools this run can't use (`NO_EDIT_TOOLS`, `planning_disallowed_tools()`); the unused tools are always added.
    pub disallowed: Vec<String>,
    /// Inline MCP config so every run has the board's tools.
    pub mcp: Option<String>,
    /// Board instructions for a run whose message is a slash command.
    pub system_prompt: Option<String>,
    /// Spending cap for this run (--max-budget-usd).
    pub max_budget_usd: Option<f64>,
    /// Reasoning effort (--effort).
    pub effort: Option<String>,
    /// Ultracode on for this session.
    pub ultracode: bool,
    /// Narrower runs (the front desk): more --settings, an allow-list of built-in tools, only the board's MCP servers.
    pub settings: Option<Map<String, Value>>,
    pub tools: Option<Vec<String>>,
    pub strict_mcp: bool,
    pub no_chrome: bool,
}

fn set(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|x| !x.is_empty())
}

/// `buildArgs`.
pub fn build_args(o: &BuildArgs) -> Vec<String> {
    // Prompts go in on stdin so more messages can follow while Claude works; --replay-user-messages echoes each one
    // back when Claude picks it up; --include-partial-messages gives token-level events for live replies.
    let mut a: Vec<String> = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
        "--include-partial-messages", "--permission-mode", "bypassPermissions", "--disallowedTools",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push(connectors::run_disallowed(&o.disallowed, o.ultracode).join(","));
    a.push(if o.resume { "--resume" } else { "--session-id" }.into());
    a.push(o.session_id.clone());
    if let Some(m) = set(&o.model) {
        a.extend(["--model".into(), m.into()]);
    }
    if let Some(e) = set(&o.effort) {
        a.extend(["--effort".into(), e.into()]);
    }
    if o.ultracode || o.settings.is_some() {
        let mut s = o.settings.clone().unwrap_or_default();
        if o.ultracode {
            s.insert("ultracode".into(), Value::Bool(true));
        }
        a.extend(["--settings".into(), js::stringify(&Value::Object(s))]);
    }
    if let Some(t) = &o.tools {
        a.extend(["--tools".into(), t.join(",")]);
    }
    if o.strict_mcp {
        a.push("--strict-mcp-config".into());
    }
    if let Some(m) = set(&o.mcp) {
        a.extend(["--mcp-config".into(), m.into()]);
    }
    if let Some(p) = set(&o.system_prompt) {
        a.extend(["--append-system-prompt".into(), p.into()]);
    }
    if let Some(b) = o.max_budget_usd.filter(|b| *b != 0.0 && !b.is_nan()) {
        a.extend(["--max-budget-usd".into(), ckanban_core::jsnum::js_string(b)]);
    }
    // Claude in Chrome: its permission asks reach the board as control requests (see control_response).
    a.extend([if o.no_chrome { "--no-chrome" } else { "--chrome" }.into(), "--permission-prompt-tool".into(), "stdio".into()]);
    a
}

const CHROME_TOOL: &str = "mcp__claude-in-chrome__";

/// Backlog/Planning chats can't edit files or start a huddle (`PLANNING_DISALLOWED_TOOLS`).
pub fn planning_disallowed_tools() -> Vec<String> {
    NO_EDIT_TOOLS.split(',').map(str::to_string).chain(["mcp__ckanban__start_huddle".to_string()]).collect()
}

/// The board's schedule and one-time job tools: every run may use them (the daemon checks each call).
pub const SCHEDULE_JOB_TOOLS: [&str; 11] =
    ["list_schedules", "create_schedule", "update_schedule", "delete_schedule", "run_schedule", "schedule_history", "schedule_job", "list_jobs", "update_job", "run_job_now", "cancel_job"];
const HUDDLE_TOOLS: [&str; 11] = [
    "huddle_post", "huddle_read", "huddle_mode", "huddle_findings", "huddle_add_participant", "huddle_status", "huddle_close", "huddle_brief",
    "huddle_hand_in", "huddle_review_changes", "huddle_allow_changes",
];
const PLANNING_BOARD_TOOLS: [&str; 10] =
    ["move_ticket", "update_ticket", "comment_ticket", "create_ticket", "chat_ticket", "stop_ticket", "plan_control", "suggest_tags", "update_status", "gather_tickets"];

fn board_tool(tool: &str, list: &[&str]) -> bool {
    tool.strip_prefix("mcp__ckanban__").is_some_and(|t| list.contains(&t))
}

/// `controlResponse`: the board's answer to a control request from Claude. Permission asks for Claude in Chrome, the
/// huddle tools and the schedule and job tools are allowed, in a Planning run the board tools too; every other ask is
/// denied; anything else gets an error so Claude never waits on the board.
pub fn control_response(ev: &Value, planning: bool) -> Value {
    let req = ev.get("request");
    let id = ev.get("request_id");
    let mut response = Map::new();
    let subtype = req.and_then(|r| r.get("subtype"));
    if subtype.and_then(Value::as_str) != Some("can_use_tool") {
        response.insert("subtype".into(), "error".into());
        if let Some(id) = id {
            response.insert("request_id".into(), id.clone());
        }
        let what = subtype.map(js::to_string).unwrap_or_else(|| "undefined".into());
        response.insert("error".into(), Value::String(format!("unsupported control request: {what}")));
        return json!({ "type": "control_response", "response": Value::Object(response) });
    }
    let req = req.expect("checked above");
    let tool = req.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let allow = tool.starts_with(CHROME_TOOL)
        || board_tool(tool, &HUDDLE_TOOLS)
        || board_tool(tool, &SCHEDULE_JOB_TOOLS)
        || (planning && board_tool(tool, &PLANNING_BOARD_TOOLS));
    response.insert("subtype".into(), "success".into());
    if let Some(id) = id {
        response.insert("request_id".into(), id.clone());
    }
    let input = match req.get("input") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(v) => v.clone(),
    };
    response.insert(
        "response".into(),
        if allow {
            json!({ "behavior": "allow", "updatedInput": input })
        } else {
            json!({ "behavior": "deny", "message": "Permission prompts can't be answered in a board run." })
        },
    );
    json!({ "type": "control_response", "response": Value::Object(response) })
}

/// One user message on Claude's stdin (stream-json).
pub fn user_message(text: &str) -> String {
    js::stringify(&json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } })) + "\n"
}

/// A run's identity vars: each run gets its own, never the ones of a run the daemon was started from.
pub const RUN_IDENTITY_ENV: [&str; 4] = ["CKANBAN_TICKET", "CKANBAN_HUDDLE_AGENT", "CKANBAN_OUTPUT_DIR", "CKANBAN_FRONTDESK"];

/// `inheritedEnv`: the environment minus run identity vars, so a child can't act as a run it doesn't belong to.
pub fn inherited_env(env: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    env.into_iter().filter(|(k, _)| !RUN_IDENTITY_ENV.contains(&k.as_str())).collect()
}

/// The exit code Bun gives: the code, or 128 + the signal that ended it.
pub fn exit_code(s: ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    s.code().or_else(|| s.signal().map(|n| 128 + n)).unwrap_or(-1)
}

/// A background task Claude is waiting on (`BackgroundTask` in `src/core/types.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundTask {
    pub id: String,
    pub description: String,
    /// When the board first saw it.
    pub started_at: String,
}

impl BackgroundTask {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "description": self.description, "startedAt": self.started_at })
    }
}

#[derive(Debug, Clone)]
pub struct RunOutput {
    pub code: i32,
    /// The last 2048 characters of stderr.
    pub stderr: String,
    /// Every event but the partial-message deltas (`stream_event`).
    pub events: Vec<Value>,
}

pub type OnEvent = Box<dyn FnMut(&Value) + Send>;
pub type OnWaiting = Box<dyn FnMut(Option<&[BackgroundTask]>) + Send>;
pub type OnStall = Box<dyn FnMut(bool) + Send>;

/// What `start_run` takes (`startRun`'s options).
pub struct RunOptions {
    pub bin: String,
    pub cwd: PathBuf,
    pub args: Vec<String>,
    /// Added to the inherited environment (identity vars, the board's port...).
    pub env: BTreeMap<String, String>,
    /// First user message, written to stdin (needs --input-format stream-json in args). None: stdin closed.
    pub input: Option<String>,
    /// The first message is a local slash command (see `RunHandle::send`).
    pub input_local: bool,
    /// A Planning chat: its permission asks for the board tools are allowed.
    pub planning: bool,
    pub on_event: OnEvent,
    /// Claude ended its turn but background tasks it waits on are still running; None once it works or is done again.
    pub on_waiting: Option<OnWaiting>,
    pub grace_ms: Option<u64>,
    /// Keep input open this long after Claude goes idle, so more messages reach the live session (huddle monitor
    /// mode); then end it. 0: end input as soon as Claude is idle with nothing unread.
    pub idle_ms: u64,
    /// Watchdog: no output for this long marks the run stalled (`on_stall(true)`); output resumes it. 0: off.
    pub stall_ms: u64,
    pub on_stall: Option<OnStall>,
}

impl RunOptions {
    pub fn new(bin: impl Into<String>, cwd: impl Into<PathBuf>, args: Vec<String>, on_event: OnEvent) -> Self {
        RunOptions {
            bin: bin.into(),
            cwd: cwd.into(),
            args,
            env: BTreeMap::new(),
            input: None,
            input_local: false,
            planning: false,
            on_event,
            on_waiting: None,
            grace_ms: None,
            idle_ms: 0,
            stall_ms: 0,
            on_stall: None,
        }
    }
}

type ControlReply = oneshot::Sender<Result<(), String>>;

enum Cmd {
    Write { text: String, local: bool },
    Control { request: Value, reply: ControlReply },
    EndWhenIdle,
    KeepWaiting,
    Stop,
}

struct Shared {
    /// Claude's stdin is open (a message written now reaches it).
    open: bool,
    queue: VecDeque<Cmd>,
}

struct Ctl {
    shared: Mutex<Shared>,
    wake: Notify,
    stopped: AtomicBool,
    pid: AtomicU32,
}

impl Ctl {
    fn push(&self, c: Cmd) {
        self.shared.lock().queue.push_back(c);
        self.wake.notify_one();
    }
}

/// A running `claude -p` (`RunHandle`). Cheap to clone; every clone controls the same run.
#[derive(Clone)]
pub struct RunHandle {
    ctl: Arc<Ctl>,
    done: watch::Receiver<Option<Arc<RunOutput>>>,
}

impl RunHandle {
    /// Waits for the run to end (`done`).
    pub async fn wait(&self) -> Arc<RunOutput> {
        let mut rx = self.done.clone();
        let got = rx.wait_for(Option::is_some).await;
        match got {
            Ok(v) => v.clone().expect("checked"),
            Err(_) => Arc::new(RunOutput { code: -1, stderr: "the run's task ended".into(), events: Vec::new() }),
        }
    }

    /// The run has ended.
    pub fn finished(&self) -> bool {
        self.done.borrow().is_some()
    }

    /// Hands Claude another user message while it works; it reads it at its next step. False once input is closed.
    /// local: a built-in slash command (/compact) that is never echoed back, so it doesn't hold input open.
    pub fn send(&self, text: &str, local: bool) -> bool {
        if self.stopped() {
            return false;
        }
        let mut g = self.ctl.shared.lock();
        if !g.open {
            return false;
        }
        g.queue.push_back(Cmd::Write { text: text.to_string(), local });
        drop(g);
        self.ctl.wake.notify_one();
        true
    }

    /// A run started with `idle_ms`: stop keeping input open, and end it now if Claude is idle.
    pub fn end_when_idle(&self) {
        self.ctl.push(Cmd::EndWhenIdle);
    }

    /// Stops one background task (a workflow, a background agent) and keeps the run going (a stop_task control
    /// request). Ok, or the error Claude Code gave (also when input is closed or it doesn't answer).
    pub async fn stop_task(&self, task_id: &str) -> Result<(), String> {
        if self.stopped() {
            return Err("the run is stopping".into());
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut g = self.ctl.shared.lock();
            if !g.open {
                return Err("the run is finishing".into());
            }
            g.queue.push_back(Cmd::Control { request: json!({ "subtype": "stop_task", "task_id": task_id }), reply: tx });
        }
        self.ctl.wake.notify_one();
        rx.await.unwrap_or_else(|_| Err("the run ended".into()))
    }

    /// A stalled run: the user chose Keep waiting, so the watchdog starts counting again.
    pub fn keep_waiting(&self) {
        self.ctl.push(Cmd::KeepWaiting);
    }

    pub fn stopped(&self) -> bool {
        self.ctl.stopped.load(Ordering::SeqCst)
    }

    /// Claude's process id once started (its process group has the same id).
    pub fn pid(&self) -> Option<u32> {
        Some(self.ctl.pid.load(Ordering::SeqCst)).filter(|p| *p != 0)
    }

    /// Stops the run: input closed, TERM to the whole process group (tools Claude started too), KILL after 5 s.
    /// Unlike Bun, a stop before Claude has started counts too: it is stopped as soon as it starts.
    pub fn stop(&self) {
        if self.ctl.stopped.swap(true, Ordering::SeqCst) || self.finished() {
            return;
        }
        self.ctl.push(Cmd::Stop);
    }
}

/// `startRun`: spawns Claude and returns its handle at once (on a tokio runtime).
pub fn start_run(opts: RunOptions) -> RunHandle {
    let ctl = Arc::new(Ctl { shared: Mutex::new(Shared { open: false, queue: VecDeque::new() }), wake: Notify::new(), stopped: AtomicBool::new(false), pid: AtomicU32::new(0) });
    let (tx, rx) = watch::channel(None);
    let c = ctl.clone();
    tokio::spawn(async move {
        let out = run(opts, c).await;
        let _ = tx.send(Some(Arc::new(out)));
    });
    RunHandle { ctl, done: rx }
}

/// Sends TERM or KILL to the run's process group (else to Claude alone). Only while Claude hasn't been reaped: after
/// that its pid may belong to another process.
fn kill_group(pid: u32, sig: i32) {
    let pid = pid as i32;
    if pid <= 0 {
        return;
    }
    unsafe {
        if libc::kill(-pid, sig) != 0 {
            libc::kill(pid, sig);
        }
    }
}

struct Run {
    ctl: Arc<Ctl>,
    opts: RunOptions,
    events: Vec<Value>,
    writer: Option<mpsc::UnboundedSender<String>>,
    /// Messages written but not yet picked up by Claude (no replay seen).
    unread: i64,
    /// Background tasks still running, in the order they were listed.
    tasks: Vec<BackgroundTask>,
    /// Between Claude's result and its next turn.
    idle: bool,
    waiting: bool,
    grace: Option<Instant>,
    keep_ms: u64,
    idle_timer: Option<Instant>,
    stalled: bool,
    stall_at: Option<Instant>,
    pending: HashMap<String, (ControlReply, Instant)>,
    requests: u64,
    kill_at: Option<Instant>,
    exited: bool,
}

impl Run {
    fn quiet(&self) -> bool {
        self.idle && self.unread == 0 && self.tasks.is_empty()
    }

    fn arm_stall(&mut self) {
        if self.opts.stall_ms > 0 {
            self.stall_at = Some(Instant::now() + Duration::from_millis(self.opts.stall_ms));
        }
    }

    fn output_seen(&mut self) {
        self.arm_stall();
        if self.stalled {
            self.stalled = false;
            if let Some(f) = self.opts.on_stall.as_mut() {
                f(false);
            }
        }
    }

    /// Claude is done and nothing is waiting: end input (so it exits), or wait idle_ms for more messages first.
    fn finish(&mut self) {
        if self.keep_ms == 0 {
            return self.close_input(false);
        }
        self.idle_timer = Some(Instant::now() + Duration::from_millis(self.keep_ms));
    }

    fn report(&mut self) {
        let now = self.idle && !self.tasks.is_empty() && self.writer.is_some();
        if !now && !self.waiting {
            return;
        }
        self.waiting = now;
        let tasks = self.tasks.clone();
        if let Some(f) = self.opts.on_waiting.as_mut() {
            f(if now { Some(&tasks) } else { None });
        }
    }

    fn write_line(&mut self, line: String) -> bool {
        match &self.writer {
            Some(w) => w.send(line).is_ok(),
            None => false,
        }
    }

    fn write(&mut self, text: &str, local: bool) -> bool {
        if !self.write_line(user_message(text)) {
            return false;
        }
        if !local {
            self.unread += 1;
            self.idle_timer = None;
        }
        true
    }

    /// Ends Claude's input. Unless forced (stop, exit), a message the handle queued just now keeps it open: it is
    /// written instead, as in Bun where a message sent before the close was already counted.
    fn close_input(&mut self, force: bool) {
        let cmds: Vec<Cmd> = {
            let mut g = self.ctl.shared.lock();
            let has_message = g.queue.iter().any(|c| matches!(c, Cmd::Write { local: false, .. }));
            if !force && has_message {
                let q: Vec<Cmd> = g.queue.drain(..).collect();
                drop(g);
                for c in q {
                    self.apply(c);
                }
                return;
            }
            g.open = false;
            g.queue.drain(..).collect()
        };
        for c in cmds {
            self.apply(c);
        }
        self.grace = None;
        self.idle_timer = None;
        self.writer = None;
    }

    /// Takes what the handle queued.
    fn drain(&mut self) {
        let cmds: Vec<Cmd> = self.ctl.shared.lock().queue.drain(..).collect();
        for c in cmds {
            self.apply(c);
        }
    }

    fn apply(&mut self, c: Cmd) {
        match c {
            Cmd::Write { text, local } => {
                self.write(&text, local);
            }
            Cmd::Control { request, reply } => {
                self.requests += 1;
                let id = format!("ckanban-{}", self.requests);
                let line = js::stringify(&json!({ "type": "control_request", "request_id": id, "request": request })) + "\n";
                if !self.write_line(line) {
                    let _ = reply.send(Err("the run is finishing".into()));
                    return;
                }
                self.pending.insert(id, (reply, Instant::now() + Duration::from_millis(CONTROL_TIMEOUT_MS)));
            }
            Cmd::EndWhenIdle => {
                self.keep_ms = 0;
                if self.idle_timer.is_some() && self.quiet() {
                    self.close_input(false);
                }
            }
            Cmd::KeepWaiting => {
                if self.stalled {
                    self.stalled = false;
                    self.arm_stall();
                }
            }
            Cmd::Stop => {
                self.close_input(true);
                if !self.exited {
                    kill_group(self.ctl.pid.load(Ordering::SeqCst), libc::SIGTERM);
                    self.kill_at = Some(Instant::now() + KILL_AFTER);
                }
            }
        }
    }

    fn track_tasks(&mut self, ev: &Value) {
        if ev.get("type").and_then(Value::as_str) != Some("system") {
            return;
        }
        let done = |v: Option<&Value>| v.and_then(Value::as_str).is_some_and(|s| TASK_DONE.contains(&s));
        match ev.get("subtype").and_then(Value::as_str) {
            Some("background_tasks_changed") => {
                let Some(list) = ev.get("tasks").and_then(Value::as_array) else { return };
                // The full current list: keep first-seen times for tasks already known.
                let known = std::mem::take(&mut self.tasks);
                for t in list {
                    let id = match t.get("task_id") {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => js::to_string(v),
                    };
                    if id.is_empty() {
                        continue;
                    }
                    let task = known.iter().find(|k| k.id == id).cloned().unwrap_or_else(|| BackgroundTask {
                        id: id.clone(),
                        description: if js::truthy(t.get("description")) { js::to_string(&t["description"]) } else { "Background task".into() },
                        started_at: ckanban_core::time::iso(ckanban_core::time::now_ms()),
                    });
                    match self.tasks.iter_mut().find(|k| k.id == id) {
                        Some(k) => *k = task,
                        None => self.tasks.push(task),
                    }
                }
            }
            Some("task_notification") if done(ev.get("status")) => {
                let id = ev.get("task_id").map(js::to_string).unwrap_or_else(|| "undefined".into());
                self.tasks.retain(|t| t.id != id);
            }
            Some("task_updated") if done(ev.pointer("/patch/status")) => {
                let id = ev.get("task_id").map(js::to_string).unwrap_or_else(|| "undefined".into());
                self.tasks.retain(|t| t.id != id);
            }
            _ => {}
        }
    }

    fn handle_line(&mut self, line: &str) {
        if js::trim(line).is_empty() {
            return;
        }
        // Messages the handle sent before this line count before anything is decided on it.
        self.drain();
        self.output_seen();
        let Some(ev) = js::parse(line) else { return };
        let ty = ev.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        // Permission asks and other requests to the host: answer them, they aren't part of the conversation.
        if ty == "control_request" {
            let answer = js::stringify(&control_response(&ev, self.opts.planning)) + "\n";
            self.write_line(answer);
            return;
        }
        // Claude Code's answer to a request the board sent.
        if ty == "control_response" {
            let r = ev.get("response");
            if let Some(id) = r.and_then(|r| r.get("request_id")).and_then(Value::as_str)
                && let Some((reply, _)) = self.pending.remove(id)
            {
                let r = r.expect("checked");
                let _ = reply.send(if r.get("subtype").and_then(Value::as_str) == Some("success") {
                    Ok(())
                } else {
                    Err(r.get("error").and_then(Value::as_str).unwrap_or("Claude Code refused").to_string())
                });
                return;
            }
        }
        // Partial-message deltas are only for the live view; don't keep thousands of them in memory.
        if ty != "stream_event" {
            self.events.push(ev.clone());
        }
        if ty == "user" && js::truthy(ev.get("isReplay")) {
            self.unread = (self.unread - 1).max(0);
        }
        self.track_tasks(&ev);
        if ty == "result" {
            self.idle = true;
        } else if ty == "assistant" || ty == "stream_event" || (ty == "system" && ev.get("subtype").and_then(Value::as_str) == Some("init")) {
            self.idle = false;
            self.grace = None;
            self.idle_timer = None;
        }
        // Claude is done and nothing is waiting: end input so the process exits. Unread messages keep it open (Claude
        // answers them in another turn); so do background tasks (Claude resumes on its own when they finish).
        if self.idle && self.unread == 0 && self.writer.is_some() {
            if self.tasks.is_empty() && ty == "result" {
                self.finish();
            } else if self.tasks.is_empty() && self.grace.is_none() && self.idle_timer.is_none() {
                // The last task finished after the result: Claude normally starts a turn for it at once.
                self.grace = Some(Instant::now() + Duration::from_millis(self.opts.grace_ms.unwrap_or(BACKGROUND_GRACE_MS)));
            }
        }
        self.report();
        (self.opts.on_event)(&ev);
    }

    fn next_deadline(&self) -> Option<Instant> {
        [self.stall_at, self.grace, self.idle_timer, self.kill_at].into_iter().flatten().chain(self.pending.values().map(|(_, at)| *at)).min()
    }

    fn fire_timers(&mut self) {
        let now = Instant::now();
        if self.stall_at.is_some_and(|t| t <= now) {
            self.stall_at = None;
            // Declared background tasks and an open idle window are silent on purpose: keep watching.
            if !self.tasks.is_empty() || self.idle_timer.is_some() {
                self.arm_stall();
            } else {
                self.stalled = true;
                if let Some(f) = self.opts.on_stall.as_mut() {
                    f(true);
                }
            }
        }
        if self.grace.is_some_and(|t| t <= now) {
            self.grace = None;
            self.drain();
            if self.quiet() {
                self.finish();
            }
        }
        if self.idle_timer.is_some_and(|t| t <= now) {
            self.idle_timer = None;
            self.drain();
            if self.quiet() {
                self.close_input(false);
            }
        }
        if self.kill_at.is_some_and(|t| t <= now) {
            self.kill_at = None;
            if !self.exited {
                kill_group(self.ctl.pid.load(Ordering::SeqCst), libc::SIGKILL);
            }
        }
        let due: Vec<String> = self.pending.iter().filter(|(_, (_, at))| *at <= now).map(|(id, _)| id.clone()).collect();
        for id in due {
            if let Some((reply, _)) = self.pending.remove(&id) {
                let _ = reply.send(Err("Claude Code didn't answer".into()));
            }
        }
    }
}

async fn run(mut opts: RunOptions, ctl: Arc<Ctl>) -> RunOutput {
    // Claude Code installed after the board started, or where the service's PATH doesn't look.
    if opts.bin == "claude" {
        claude::find_claude(claude::FindClaude::default()).await;
    }
    let mut cmd = tokio::process::Command::new(&opts.bin);
    let env = inherited_env(std::env::vars().map(|(k, v)| if k == "PATH" { (k, claude::path_for_runs(&v)) } else { (k, v) }));
    cmd.args(&opts.args).current_dir(&opts.cwd).env_clear().envs(env).envs(&opts.env);
    cmd.stdin(if opts.input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Own process group so stop() can take down tools Claude spawned (shells, dev servers).
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return RunOutput { code: -1, stderr: format!("failed to start {}: {e}", opts.bin), events: Vec::new() },
    };
    ctl.pid.store(child.id().unwrap_or(0), Ordering::SeqCst);
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        String::from_utf8_lossy(&buf).into_owned()
    });
    let mut writer = None;
    if let Some(mut stdin) = child.stdin.take() {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let c = ctl.clone();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    c.shared.lock().open = false;
                    return;
                }
            }
            // Every sender gone: closing stdin is Claude's end of input.
        });
        writer = Some(tx);
    }
    let input = opts.input.take();
    let keep_ms = opts.idle_ms;
    let mut r = Run {
        ctl: ctl.clone(),
        opts,
        events: Vec::new(),
        writer,
        unread: 0,
        tasks: Vec::new(),
        idle: false,
        waiting: false,
        grace: None,
        keep_ms,
        idle_timer: None,
        stalled: false,
        stall_at: None,
        pending: HashMap::new(),
        requests: 0,
        kill_at: None,
        exited: false,
    };
    r.arm_stall();
    if let Some(text) = input {
        r.ctl.shared.lock().open = true;
        let local = r.opts.input_local;
        r.write(&text, local);
    }
    // A stop that came before Claude started.
    if ctl.stopped.load(Ordering::SeqCst) {
        r.drain();
    }

    let mut lines = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    let mut stdout_done = false;
    let mut code = None;
    while !(stdout_done && code.is_some()) {
        let deadline = r.next_deadline();
        tokio::select! {
            _ = ctl.wake.notified() => r.drain(),
            got = lines.read_until(b'\n', &mut buf), if !stdout_done => {
                match got {
                    Ok(0) | Err(_) => {
                        stdout_done = true;
                        if !buf.is_empty() {
                            let line = String::from_utf8_lossy(&buf).into_owned();
                            buf.clear();
                            r.handle_line(&line);
                        }
                    }
                    Ok(_) => {
                        if buf.last() == Some(&b'\n') {
                            buf.pop();
                        }
                        let line = String::from_utf8_lossy(&buf).into_owned();
                        buf.clear();
                        r.handle_line(&line);
                    }
                }
            }
            status = child.wait(), if code.is_none() => {
                r.exited = true;
                code = Some(status.map(exit_code).unwrap_or(-1));
            }
            _ = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => r.fire_timers(),
        }
    }
    let stderr = stderr_task.await.unwrap_or_default();
    r.stall_at = None;
    for (_, (reply, _)) in r.pending.drain() {
        let _ = reply.send(Err("the run ended".into()));
    }
    if r.stalled {
        r.stalled = false;
        if let Some(f) = r.opts.on_stall.as_mut() {
            f(false);
        }
    }
    r.close_input(true);
    r.idle = false;
    r.report();
    RunOutput { code: code.unwrap_or(-1), stderr: js::tail16(&stderr, STDERR_TAIL).to_string(), events: std::mem::take(&mut r.events) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_and_answers() {
        let a = build_args(&BuildArgs { session_id: "u1".into(), model: Some("sonnet".into()), ..Default::default() });
        assert_eq!(a[11], "Workflow,ScheduleWakeup,AskUserQuestion,ShareOnboardingGuide,CronCreate,CronDelete,CronList");
        assert_eq!(&a[12..16], ["--session-id", "u1", "--model", "sonnet"]);
        let ask = |tool: &str, planning: bool| {
            let ev = json!({ "request_id": "r", "request": { "subtype": "can_use_tool", "tool_name": tool, "input": { "id": "t_1" } } });
            control_response(&ev, planning)["response"]["response"]["behavior"].as_str().unwrap_or("").to_string()
        };
        assert_eq!(ask("mcp__ckanban__move_ticket", true), "allow");
        assert_eq!(ask("mcp__ckanban__move_ticket", false), "deny");
        assert_eq!(ask("mcp__ckanban__cancel_job", false), "allow");
        assert_eq!(ask("Bash", true), "deny");
        let env = inherited_env([("PATH".to_string(), "/bin".to_string()), ("CKANBAN_TICKET".to_string(), "p/t".to_string())]);
        assert_eq!(env, vec![("PATH".to_string(), "/bin".to_string())]);
    }
}
