//! `QuickChats` (`src/chat/quickchat.ts`): conversations with Claude in a board's folder that aren't tickets (the
//! phone's Ask tab, the computer's Claude panel). Each is a headless `claude -p` session, resumed for every message like
//! a ticket's chat, kept in `profiles/<slug>/chats/<id>.json` in Bun's exact format. Their runs don't take ticket run
//! slots; a restart waits for them like other runs.
//!
//! Locks: `runs` (who replies now) and each run's state are held only for a few field changes; `writes` is held across
//! one chat file's read and write (a few KB), so two changes of one chat never lose one, as in Bun's single thread.
//! File work runs on blocking threads; a run's callbacks only queue events and append one log line.
//!
//! Not here yet, each marked `STAND-IN` below: board browsers for the runs (R9: none), the Telegram front desk's
//! hooks (R13/P1: a front desk chat refuses to run, as Bun does when the front desk isn't plugged in), and the Context
//! panel's refresh after a run (R7b).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use ckanban_core::DataDir;
use ckanban_core::atomic::{atomic_write, new_id};
use ckanban_core::time::{iso, now_ms};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::index::{CHAT_PAGE, Chat, ChatIndex};
use super::text::{self, CONTINUE_TEXT, Draft, DraftTracker, MESSAGE_MAX, TITLE_MAX};
use crate::bus::Bus;
use crate::runs::activity::summarize_event;
use crate::runs::connectors::board_connector_options;
use crate::runs::js as rjs;
use crate::runs::runner::{self, BuildArgs, RunHandle, RunOptions};
use crate::sessions::{files, js};

const DRAFT_THROTTLE_MS: u64 = 120;
const ACTIVITY_THROTTLE_MS: f64 = 1000.0;
/// `QUICK_CHAT_ENV` (`src/core/env.ts`): the ckanban tools know they run in a quick chat.
pub const QUICK_CHAT_ENV: &str = "CKANBAN_QUICK_CHAT";
/// `BOARD_TOOLS_FILE`: the board's own MCP servers.
const BOARD_TOOLS_FILE: &str = "board-tools.json";
/// `SERVER_NAME` in `src/integrations/agents.ts`.
const SERVER_NAME: &str = "ckanban";
/// How long Delete and a shutdown wait for a stopped reply.
const STOP_WAIT: Duration = Duration::from_secs(6);

/// `QuickChatError`: an answer's status and message.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatError {
    pub status: u16,
    pub message: String,
}

fn fail<T>(status: u16, message: impl Into<String>) -> Result<T, ChatError> {
    Err(ChatError { status, message: message.into() })
}

pub type McpConfig = Arc<dyn Fn(&str) -> String + Send + Sync>;
pub type SessionExists = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type Flag = Arc<dyn Fn() -> bool + Send + Sync>;

/// `QuickChatOptions`.
#[derive(Clone)]
pub struct QuickChatOptions {
    /// `CKANBAN_CLAUDE_BIN`, else `claude`.
    pub claude_bin: String,
    /// More environment for every run (tests: the fake Claude's settings).
    pub env: BTreeMap<String, String>,
    /// MCP config for the runs (default: this program's `mcp` with the board's own tools).
    pub mcp: Option<McpConfig>,
    /// Whether Claude has a transcript for a session (default: one in Claude's projects folder).
    pub session_exists: Option<SessionExists>,
}

impl QuickChatOptions {
    pub fn from_env() -> Self {
        QuickChatOptions {
            claude_bin: std::env::var("CKANBAN_CLAUDE_BIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "claude".into()),
            env: BTreeMap::new(),
            mcp: None,
            session_exists: None,
        }
    }
}

/// The restart gate as quick chats see it (board mode sets it from the run loop, R7a); the default: never pending.
#[derive(Clone)]
pub struct RestartGate {
    /// `board.isRestartPending()`: messages that come as a run ends are held for after the restart.
    pub pending: Flag,
    /// `board.restartWorkChanged()`: a quick chat run ended (the gate may restart now).
    pub work_changed: Arc<dyn Fn() + Send + Sync>,
}

impl Default for RestartGate {
    fn default() -> Self {
        RestartGate { pending: Arc::new(|| false), work_changed: Arc::new(|| {}) }
    }
}

struct RunState {
    handle: Option<RunHandle>,
    started: bool,
    /// Sent after the run stopped taking input: the next run starts with them.
    later: Vec<String>,
    activity: Option<String>,
    stop_requested: bool,
    draft: DraftTracker,
    /// Bumped to cancel a throttled draft event.
    draft_gen: u64,
    draft_timer: bool,
    last_activity: f64,
}

struct ActiveChat {
    slug: String,
    id: String,
    /// The message this run started with, until Claude has it (a restart before then sends it again).
    prompt: String,
    state: Mutex<RunState>,
    done: watch::Sender<bool>,
}

pub struct QuickChats {
    dir: DataDir,
    bus: Arc<Bus>,
    opts: QuickChatOptions,
    rt: tokio::runtime::Handle,
    runs: Mutex<HashMap<String, Arc<ActiveChat>>>,
    /// Chats Make ticket is turning into tickets right now (R2a/R7b: Make ticket isn't in Rust yet).
    making: Mutex<HashSet<String>>,
    /// Chats with a rewind, undo or fork under way (R7b).
    rewinding: Mutex<HashSet<String>>,
    shutting_down: AtomicBool,
    index: ChatIndex,
    writes: Mutex<()>,
    gate: Mutex<RestartGate>,
    me: Weak<QuickChats>,
    draft_seq: AtomicU64,
}

fn key(slug: &str, id: &str) -> String {
    format!("{slug}/{id}")
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

fn s<'a>(c: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    c.get(k).and_then(Value::as_str)
}

fn now() -> String {
    iso(now_ms())
}

/// Reads one chat file (`get`): None when missing, unreadable, not an object or not this id.
fn read_chat(file: &Path, id: &str) -> Option<Chat> {
    let t = std::fs::read_to_string(file).ok()?;
    let v = rjs::parse(&t)?;
    let m = match v {
        Value::Object(m) => m,
        _ => return None,
    };
    (s(&m, "id") == Some(id)).then(|| Arc::new(ckanban_core::jsnum::normalize_map(m)))
}

impl QuickChats {
    /// Must be called on a tokio runtime (runs start on it).
    pub fn new(root: &Path, bus: Arc<Bus>, opts: QuickChatOptions) -> Arc<Self> {
        let dir = DataDir::new(root);
        Arc::new_cyclic(|me: &Weak<QuickChats>| {
            let d1 = dir.clone();
            let d2 = dir.clone();
            QuickChats {
                index: ChatIndex::new(move |slug| d1.chats_dir(slug), Box::new(move |slug, id| read_chat(&d2.chats_dir(slug).join(format!("{id}.json")), id))),
                dir,
                bus,
                opts,
                rt: tokio::runtime::Handle::current(),
                runs: Mutex::new(HashMap::new()),
                making: Mutex::new(HashSet::new()),
                rewinding: Mutex::new(HashSet::new()),
                shutting_down: AtomicBool::new(false),
                writes: Mutex::new(()),
                gate: Mutex::new(RestartGate::default()),
                me: me.clone(),
                draft_seq: AtomicU64::new(0),
            }
        })
    }

    fn arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("quick chats alive")
    }

    /// R7a plugs the restart gate in here.
    pub fn set_gate(&self, g: RestartGate) {
        *self.gate.lock() = g;
    }

    pub fn chats_dir(&self, slug: &str) -> PathBuf {
        self.dir.chats_dir(slug)
    }

    fn file(&self, slug: &str, id: &str) -> PathBuf {
        self.chats_dir(slug).join(format!("{id}.json"))
    }

    /// Result lines of the chat's runs, for today's spend (same shape as a ticket's activity log).
    pub fn activity_path(&self, slug: &str, id: &str) -> PathBuf {
        self.chats_dir(slug).join(format!("{id}.activity.jsonl"))
    }
    pub fn simplified_path(&self, slug: &str, id: &str) -> PathBuf {
        self.chats_dir(slug).join(format!("{id}.simplified.json"))
    }
    pub fn side_spend_path(&self, slug: &str, id: &str) -> PathBuf {
        self.chats_dir(slug).join(format!("{id}.side-spend.jsonl"))
    }
    pub fn context_path(&self, slug: &str, id: &str) -> PathBuf {
        self.chats_dir(slug).join(format!("{id}.context.json"))
    }

    fn attachments_dir(&self) -> PathBuf {
        self.dir.root.join("attachments")
    }

    /// The board's `profile.json` as JSON (`store.getProfile`).
    pub fn profile(&self, slug: &str) -> Option<Map<String, Value>> {
        self.dir.profile(slug).map(|p| p.record.0.clone())
    }

    fn session_exists(&self, id: &str) -> bool {
        match &self.opts.session_exists {
            Some(f) => f(id),
            None => files::find_session_file(&files::projects_dir(None), id).is_some(),
        }
    }

    /// `get`: the chat, or None.
    pub fn get(&self, slug: &str, id: &str) -> Option<Chat> {
        if !valid_id(id) {
            return None;
        }
        read_chat(&self.file(slug, id), id)
    }

    fn get_or_404(&self, slug: &str, id: &str) -> Result<Chat, ChatError> {
        self.get(slug, id).map_or_else(|| fail(404, "chat not found"), Ok)
    }

    /// The board's chats, latest first. Every chat: only for a page opened before the list came in pages.
    pub fn list(&self, slug: &str) -> Arc<Vec<Chat>> {
        self.index.all(slug)
    }

    /// A page of the board's chats, latest first ("Load older" asks with the last page's `next`).
    pub fn page(&self, slug: &str, limit: f64, before: Option<&str>) -> (Vec<Chat>, Option<String>) {
        let all = self.index.all(slug);
        ChatIndex::page(&all, if limit.is_nan() { CHAT_PAGE } else { limit }, before)
    }

    /// `view`: the chat plus its live state.
    pub fn view(&self, slug: &str, c: &Map<String, Value>) -> Value {
        let id = s(c, "id").unwrap_or("");
        let run = self.runs.lock().get(&key(slug, id)).cloned();
        let mut out = Map::new();
        for (k, v) in c {
            if k != "pending" && k != "interrupted" && k != "title" {
                out.insert(k.clone(), v.clone());
            }
        }
        let title = c.get("title").filter(|v| !v.is_null());
        out.insert("title".into(), match title {
            Some(t) => t.clone(),
            None => Value::String(text::auto_title(s(c, "firstMessage"))),
        });
        out.insert("renamed".into(), Value::Bool(js::truthy(title)));
        out.insert("running".into(), Value::Bool(run.is_some()));
        let (activity, later) = run.as_ref().map_or((None, 0), |r| {
            let st = r.state.lock();
            (st.activity.clone(), st.later.len())
        });
        out.insert("activity".into(), activity.map_or(Value::Null, Value::String));
        let pending = c.get("pending").and_then(Value::as_array).map_or(0, Vec::len);
        out.insert("waiting".into(), json!(pending + later));
        Value::Object(out)
    }

    pub fn is_running(&self, slug: &str, id: &str) -> bool {
        self.runs.lock().contains_key(&key(slug, id))
    }

    /// Boards with a quick chat replying now: what a restart also waits for (`onRestartBusy`).
    pub fn restart_busy(&self) -> Vec<String> {
        self.runs.lock().values().map(|r| r.slug.clone()).collect()
    }

    fn save(&self, slug: &str, c: Map<String, Value>) -> Chat {
        let c = Arc::new(c);
        let file = self.file(slug, s(&c, "id").unwrap_or(""));
        let text = serde_json::to_string_pretty(&*c).unwrap_or_else(|_| "{}".into()) + "\n";
        let id = s(&c, "id").unwrap_or("").to_string();
        if let Err(e) = self.index.wrote(slug, &id, || atomic_write(&file, text), Some(c.clone())) {
            eprintln!("[board] quick chat {slug}/{id}: can't save: {e}");
        }
        c
    }

    /// Saves a change to a chat that still exists (a run ending after Delete must not bring it back).
    fn patch(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Option<Chat> {
        let next = {
            let _w = self.writes.lock();
            let mut c = (*self.get(slug, id)?).clone();
            for (k, v) in patch {
                c.insert(k, v);
            }
            self.save(slug, c)
        };
        self.emit(slug, &next);
        Some(next)
    }

    fn emit(&self, slug: &str, c: &Map<String, Value>) {
        self.bus.emit_json(json!({ "type": "chat.updated", "profile": slug, "id": s(c, "id"), "chat": self.view(slug, c) }));
    }

    fn emit_activity(&self, slug: &str, id: &str, activity: Option<&str>) {
        self.bus.emit_json(json!({ "type": "chat.activity", "profile": slug, "id": id, "activity": activity }));
    }

    fn emit_draft(&self, slug: &str, id: &str, text: &str, finished: Option<&str>) {
        let mut e = json!({ "type": "chat.draft", "profile": slug, "id": id, "text": text });
        if let Some(f) = finished.filter(|f| !f.is_empty()) {
            e["final"] = Value::String(f.to_string());
        }
        self.bus.emit_json(e);
    }

    /// `send`: a message in a new chat (id None), to a reply in progress, or as a new reply in the same conversation.
    /// Blocking (file reads and writes).
    pub fn send(&self, slug: &str, id: Option<&str>, text_in: &str) -> Result<Value, ChatError> {
        let Some(profile) = self.profile(slug) else { return fail(404, format!("board {slug} not found")) };
        let msg = js::trim(text_in).to_string();
        if msg.is_empty() {
            return fail(400, "message is empty");
        }
        if js::len16(&msg) > MESSAGE_MAX {
            return fail(413, "message is too long");
        }
        let at = now();
        let _w = self.writes.lock();
        let mut c: Map<String, Value> = match id {
            None => {
                let v = json!({
                    "id": new_id(), "sessionId": text::random_uuid(), "title": null, "firstMessage": msg, "createdAt": at,
                    "updatedAt": at, "started": false, "ticketId": null, "error": null,
                });
                v.as_object().cloned().unwrap_or_default()
            }
            Some(id) => {
                let c = self.get_or_404(slug, id)?;
                if js::truthy(c.get("ticketId")) {
                    return fail(409, "This chat became a ticket. Continue it in the ticket's chat.");
                }
                if self.making.lock().contains(&key(slug, id)) {
                    return fail(409, "This chat is being made into a ticket. Continue it in the ticket's chat.");
                }
                if self.rewinding.lock().contains(&key(slug, id)) {
                    return fail(409, "The chat is being rewound, undone or forked right now. Try again in a moment.");
                }
                let mut c = (*c).clone();
                if c.get("firstMessage").is_none_or(Value::is_null) {
                    c.insert("firstMessage".into(), Value::String(msg.clone()));
                }
                c.insert("updatedAt".into(), Value::String(at));
                c.insert("error".into(), Value::Null);
                c
            }
        };
        let cid = s(&c, "id").unwrap_or("").to_string();
        let run = self.runs.lock().get(&key(slug, &cid)).cloned();
        let saved = if let Some(run) = run {
            // Claude is replying: it reads the message at its next step. Once its input has closed, the next run takes it.
            let local = text::localize_attachments(&msg, &self.attachments_dir());
            let mut st = run.state.lock();
            let sent = !st.stop_requested && st.handle.as_ref().is_some_and(|h| h.send(&local, false));
            if !sent {
                st.later.push(msg);
            }
            drop(st);
            self.save(slug, c)
        } else if self.shutting_down.load(Ordering::SeqCst) {
            // Held until after the restart (recover sends it).
            let mut pending = c.get("pending").and_then(Value::as_array).cloned().unwrap_or_default();
            pending.push(Value::String(msg));
            c.insert("pending".into(), Value::Array(pending));
            self.save(slug, c)
        } else {
            let saved = self.save(slug, c);
            self.start(slug, profile, saved.clone(), msg);
            saved
        };
        drop(_w);
        let saved = self.get(slug, &cid).unwrap_or(saved);
        self.emit(slug, &saved);
        Ok(self.view(slug, &saved))
    }

    fn start(&self, slug: &str, profile: Map<String, Value>, c: Chat, prompt: String) {
        let id = s(&c, "id").unwrap_or("").to_string();
        let (done, _) = watch::channel(false);
        let run = Arc::new(ActiveChat {
            slug: slug.to_string(),
            id: id.clone(),
            prompt,
            state: Mutex::new(RunState {
                handle: None,
                started: false,
                later: Vec::new(),
                activity: Some("Starting…".into()),
                stop_requested: false,
                draft: DraftTracker::default(),
                draft_gen: 0,
                draft_timer: false,
                last_activity: 0.0,
            }),
            done,
        });
        self.runs.lock().insert(key(slug, &id), run.clone());
        let me = self.arc();
        self.rt.spawn(async move {
            if let Err(e) = me.clone().execute(run.clone(), profile, c, false).await {
                eprintln!("[board] quick chat {}/{}: {e}", run.slug, run.id);
                let (m, r) = (me.clone(), run.clone());
                let _ = tokio::task::spawn_blocking(move || m.patch(&r.slug, &r.id, obj(json!({ "error": e })))).await;
            }
            // STAND-IN (R9): board browsers would be let go here (`boardBrowsers.release`).
            let (m, r) = (me.clone(), run.clone());
            let _ = tokio::task::spawn_blocking(move || m.finished(&r)).await;
            let _ = run.done.send(true);
        });
    }

    fn execute(self: Arc<Self>, run: Arc<ActiveChat>, profile: Map<String, Value>, c: Chat, healed: bool) -> futures_util::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async move {
            let (slug, id) = (run.slug.clone(), run.id.clone());
            let sid = s(&c, "sessionId").unwrap_or("").to_string();
            let me = self.clone();
            let sid2 = sid.clone();
            let started_flag = js::truthy(c.get("started"));
            let resume = started_flag || tokio::task::spawn_blocking(move || me.session_exists(&sid2)).await.unwrap_or(false);
            // STAND-IN (R9): the board's browsers (`board.runBrowsers`); runs get none until R9.
            {
                let st = run.state.lock();
                if st.stop_requested || self.shutting_down.load(Ordering::SeqCst) {
                    return Ok(());
                }
            }
            let (env, args) = self.run_setup(&slug, &profile, &c, resume)?;
            let me = self.clone();
            let r = run.clone();
            let on_event: runner::OnEvent = Box::new(move |ev: &Value| me.on_event(&r, ev));
            let cwd = PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or("."));
            let mut o = RunOptions::new(self.opts.claude_bin.clone(), cwd, args, on_event);
            o.env = env;
            o.input = Some(text::localize_attachments(&run.prompt, &self.attachments_dir()));
            let handle = {
                let mut st = run.state.lock();
                let h = runner::start_run(o);
                st.handle = Some(h.clone());
                h
            };
            let out = handle.wait().await;
            let draft = {
                let mut st = run.state.lock();
                st.draft_gen += 1;
                st.draft_timer = false;
                std::mem::take(&mut st.draft.text)
            };
            if !draft.is_empty() {
                self.emit_draft(&slug, &id, "", Some(&draft));
            }
            if self.shutting_down.load(Ordering::SeqCst) {
                return Ok(());
            }
            let me = self.clone();
            let (run2, out2, handle2, c2) = (run.clone(), out.clone(), handle.clone(), c.clone());
            let next = tokio::task::spawn_blocking(move || {
                let started = resume || run2.state.lock().started || me.session_exists(&sid);
                let mut patch = obj(json!({ "started": started, "updatedAt": now() }));
                if out2.code != 0 && !handle2.stopped() {
                    let result = out2.events.iter().rev().find(|e| e.get("type").and_then(Value::as_str) == Some("result"));
                    let from_result = result.and_then(|r| r.get("result")).and_then(Value::as_str).map(|t| js::trim(t).to_string()).unwrap_or_default();
                    let stderr = js::trim(&out2.stderr).to_string();
                    let error = if !stderr.is_empty() {
                        stderr
                    } else if !from_result.is_empty() {
                        from_result
                    } else {
                        format!("claude exited with code {}", out2.code)
                    };
                    // Claude lost the conversation (stopped before it was saved): carry on in a new one.
                    if !healed && text::session_missing(&error, &out2.events) {
                        let fresh = me.patch(&run2.slug, &run2.id, obj(json!({ "sessionId": text::random_uuid(), "started": false })));
                        if let Some(f) = fresh {
                            run2.state.lock().started = false;
                            return Some(f);
                        }
                    }
                    patch.insert("error".into(), Value::String(text::error_line(&error)));
                }
                let _ = c2;
                me.patch(&run2.slug, &run2.id, patch);
                None
            })
            .await
            .unwrap_or(None);
            if let Some(fresh) = next {
                return self.execute(run, profile, fresh, true).await;
            }
            Ok(())
        })
    }

    /// One event of a chat's run: drafts, the run log, the activity line. Runs on the run's task: no waiting.
    fn on_event(&self, run: &Arc<ActiveChat>, ev: &Value) {
        let (slug, id) = (&run.slug, &run.id);
        let ty = ev.get("type").and_then(Value::as_str).unwrap_or("");
        let mut st = run.state.lock();
        match st.draft.feed(ev) {
            Draft::Cleared => {
                st.draft_gen += 1;
                st.draft_timer = false;
                let finished = st.draft.finished.clone();
                drop(st);
                self.emit_draft(slug, id, "", Some(&finished));
                st = run.state.lock();
            }
            Draft::Changed if !st.draft_timer => {
                st.draft_timer = true;
                let at_gen = st.draft_gen;
                let (me, r) = (self.arc(), run.clone());
                self.draft_seq.fetch_add(1, Ordering::Relaxed);
                self.rt.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(DRAFT_THROTTLE_MS)).await;
                    let text = {
                        let mut st = r.state.lock();
                        if st.draft_gen != at_gen || !st.draft_timer {
                            return;
                        }
                        st.draft_timer = false;
                        st.draft.text.clone()
                    };
                    me.emit_draft(&r.slug, &r.id, &text, None);
                });
            }
            _ => {}
        }
        if ty == "stream_event" {
            return;
        }
        if (ty == "system" && ev.get("subtype").and_then(Value::as_str) == Some("init")) || ty == "assistant" {
            st.started = true;
        }
        // Only result lines: they carry the cost today's spend adds up.
        if ty == "result" {
            let line = json!({ "run": 1, "at": now(), "event": ev });
            let path = self.activity_path(slug, id);
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                use std::io::Write;
                let _ = f.write_all(format!("{}\n", rjs::stringify(&line)).as_bytes());
            }
            // STAND-IN (R13/P1): the front desk's onResult hook.
        }
        if let Some(sum) = summarize_event(ev, false)
            && !st.stop_requested
        {
            st.activity = Some(sum);
        }
        let t = now_ms();
        if t - st.last_activity >= ACTIVITY_THROTTLE_MS || ty == "result" || ty == "user" {
            st.last_activity = t;
            let a = st.activity.clone();
            drop(st);
            self.emit_activity(slug, id, a.as_deref());
        }
    }

    /// The environment and flags a run of the chat gets (`runSetup`).
    fn run_setup(&self, slug: &str, profile: &Map<String, Value>, c: &Map<String, Value>, resume: bool) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
        let connectors = board_connector_options(profile.get("claudeAiConnectors"));
        // STAND-IN (R13/P1): the front desk's hooks (env, note, limits). A front desk chat never runs with a normal
        // chat's rights, so without them it doesn't run at all, as in Bun.
        if js::truthy(c.get("frontDesk")) {
            return Err("The Telegram front desk isn't set up on this board right now, so nothing was run.".into());
        }
        let mut env = self.opts.env.clone();
        env.extend(connectors.env);
        env.insert(QUICK_CHAT_ENV.into(), format!("{slug}/{}", s(c, "id").unwrap_or("")));
        let mcp = match &self.opts.mcp {
            Some(f) => f(slug),
            None => self.mcp_config(slug),
        };
        let effort = match profile.get("effort").and_then(Value::as_str) {
            Some("ultracode") => Some("xhigh".to_string()),
            Some(e) if !e.is_empty() => Some(e.to_string()),
            _ => None,
        };
        let args = runner::build_args(&BuildArgs {
            session_id: s(c, "sessionId").unwrap_or("").to_string(),
            resume,
            model: profile.get("model").and_then(Value::as_str).map(str::to_string),
            disallowed: connectors.disallowed,
            mcp: Some(mcp),
            system_prompt: Some(text::quick_chat_note(profile.get("name").unwrap_or(&Value::Null), slug, profile.get("path").unwrap_or(&Value::Null))),
            effort,
            ..Default::default()
        });
        Ok((env, args))
    }

    /// `mcpConfig(helperArgv + "mcp", board tools)`: the board's own servers, then this program's `mcp`.
    fn mcp_config(&self, slug: &str) -> String {
        let mut servers = Map::new();
        let file = self.dir.profile_dir(slug).join(BOARD_TOOLS_FILE);
        if let Some(Value::Object(m)) = std::fs::read_to_string(file).ok().and_then(|t| rjs::parse(&t)).and_then(|v| v.get("mcpServers").cloned()) {
            for (k, v) in m {
                if v.is_object() && k != SERVER_NAME {
                    servers.insert(k, v);
                }
            }
        }
        // STAND-IN (R9): board browsers' MCP servers (`browserServers`).
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "ckanban".into());
        servers.insert(SERVER_NAME.into(), json!({ "command": exe, "args": ["mcp"] }));
        rjs::stringify(&json!({ "mcpServers": servers }))
    }

    /// A run ended: messages that came meanwhile get their own reply, then the chat goes out again. Blocking.
    fn finished(&self, run: &Arc<ActiveChat>) {
        let k = key(&run.slug, &run.id);
        {
            let mut runs = self.runs.lock();
            if !runs.get(&k).is_some_and(|r| Arc::ptr_eq(r, run)) {
                return;
            }
            runs.remove(&k);
        }
        let gate = self.gate.lock().clone();
        (gate.work_changed)();
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        // STAND-IN (R7b): the Context panel refreshes after a run (`onRunEnd`).
        let Some(c) = self.get(&run.slug, &run.id) else { return };
        let (later, stopped) = {
            let st = run.state.lock();
            (st.later.clone(), st.stop_requested)
        };
        if !later.is_empty() && !stopped {
            if (gate.pending)() {
                let mut pending = c.get("pending").and_then(Value::as_array).cloned().unwrap_or_default();
                pending.extend(later.into_iter().map(Value::String));
                self.patch(&run.slug, &run.id, obj(json!({ "pending": pending })));
            } else if let Some(profile) = self.profile(&run.slug) {
                return self.start(&run.slug, profile, c, later.join("\n\n"));
            }
        }
        let c = self.get(&run.slug, &run.id).unwrap_or(c);
        self.emit(&run.slug, &c);
    }

    /// `stop`: the reply in progress stops; messages queued for it are dropped.
    pub fn stop(&self, slug: &str, id: &str) {
        let Some(run) = self.runs.lock().get(&key(slug, id)).cloned() else { return };
        let mut st = run.state.lock();
        st.stop_requested = true;
        st.later.clear();
        st.activity = Some("Stopping…".into());
        if let Some(h) = &st.handle {
            h.stop();
        }
        drop(st);
        self.emit_activity(slug, id, Some("Stopping…"));
    }

    /// `rename`. Blocking.
    pub fn rename(&self, slug: &str, id: &str, title: Option<&str>) -> Result<Value, ChatError> {
        self.get_or_404(slug, id)?;
        let t = title.map(|t| js::slice16(js::trim(&js::squash_spaces(t)), 0, Some(TITLE_MAX)).to_string()).unwrap_or_default();
        let next = self.patch(slug, id, obj(json!({ "title": if t.is_empty() { Value::Null } else { Value::String(t) } })));
        match next {
            Some(c) => Ok(self.view(slug, &c)),
            None => fail(404, "chat not found"),
        }
    }

    /// `remove`: the chat leaves the board's list (Claude Code keeps its own copy of the conversation).
    pub async fn remove(&self, slug: &str, id: &str) -> Result<(), ChatError> {
        let me = self.arc();
        let (s1, i1) = (slug.to_string(), id.to_string());
        tokio::task::spawn_blocking(move || me.get_or_404(&s1, &i1).map(|_| ())).await.unwrap_or_else(|_| fail(500, "chat lookup failed"))?;
        let run = self.runs.lock().get(&key(slug, id)).cloned();
        if let Some(run) = run {
            self.stop(slug, id);
            let mut rx = run.done.subscribe();
            let _ = tokio::time::timeout(STOP_WAIT, rx.wait_for(|d| *d)).await;
        }
        let me = self.arc();
        let (s1, i1) = (slug.to_string(), id.to_string());
        let _ = tokio::task::spawn_blocking(move || {
            let _w = me.writes.lock();
            let file = me.file(&s1, &i1);
            me.index.wrote(&s1, &i1, || std::fs::remove_file(&file), None).ok();
            for f in [me.activity_path(&s1, &i1), me.simplified_path(&s1, &i1), me.side_spend_path(&s1, &i1), me.context_path(&s1, &i1)] {
                let _ = std::fs::remove_file(f);
            }
        })
        .await;
        self.bus.emit_json(json!({ "type": "chat.updated", "profile": slug, "id": id, "chat": null }));
        Ok(())
    }

    /// Board mode stopping: replies in progress are marked so `recover` continues them; every run is stopped. Blocking
    /// (one small file write per reply in progress); it doesn't wait for the runs to end.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let runs: Vec<Arc<ActiveChat>> = self.runs.lock().values().cloned().collect();
        for run in runs {
            // Same lock order as `send`: the chat's file first, then the run's state.
            let _w = self.writes.lock();
            let mut st = run.state.lock();
            if st.stop_requested {
                continue;
            }
            {
                if let Some(c) = self.get(&run.slug, &run.id) {
                    let mut c = (*c).clone();
                    let mut pending = c.get("pending").and_then(Value::as_array).cloned().unwrap_or_default();
                    pending.extend(st.later.iter().cloned().map(Value::String));
                    c.insert("interrupted".into(), if st.started { json!({}) } else { json!({ "prompt": run.prompt }) });
                    if !pending.is_empty() {
                        c.insert("pending".into(), Value::Array(pending));
                    }
                    self.save(&run.slug, c);
                }
            }
            st.stop_requested = true;
            if let Some(h) = &st.handle {
                h.stop();
            }
        }
    }

    /// After a restart: continue replies it cut off and send messages it held. Blocking (reads every board's chats
    /// once, a file at a time).
    pub fn recover(&self) {
        let Ok(profiles) = self.dir.list_profiles() else { return };
        for p in profiles {
            let Some(slug) = p.slug().map(str::to_string) else { continue };
            let all = self.index.all(&slug);
            for c in all.iter() {
                let interrupted = js::truthy(c.get("interrupted"));
                let pending: Vec<String> = c.get("pending").and_then(Value::as_array).map(|a| a.iter().map(rjs::to_string).collect()).unwrap_or_default();
                if !interrupted && pending.is_empty() {
                    continue;
                }
                let mut texts = Vec::new();
                if interrupted {
                    let prompt = c.get("interrupted").and_then(|i| i.get("prompt")).filter(|v| !v.is_null());
                    texts.push(prompt.map_or_else(|| CONTINUE_TEXT.to_string(), rjs::to_string));
                }
                texts.extend(pending);
                let mut next = (**c).clone();
                next.shift_remove("pending");
                next.shift_remove("interrupted");
                let next = {
                    let _w = self.writes.lock();
                    self.save(&slug, next)
                };
                if !js::truthy(next.get("ticketId")) {
                    self.start(&slug, p.record.0.clone(), next, texts.join("\n\n"));
                }
            }
        }
    }

    /// Waits until no chat is replying (tests).
    pub async fn idle(&self) {
        loop {
            let runs: Vec<Arc<ActiveChat>> = self.runs.lock().values().cloned().collect();
            if runs.is_empty() {
                return;
            }
            for r in runs {
                let mut rx = r.done.subscribe();
                let _ = rx.wait_for(|d| *d).await;
            }
        }
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}
