//! `Huddles` (`src/huddle/huddle.ts` and its `huddle-*.ts` parts): the room. Reading and the views, who a request
//! comes from, starting a huddle, posts and routing, the brief, statuses, findings, participants, hand-ins, learnings,
//! stop, resume, close and the board's own summary, the idle watchdog and `hostStates`.
//!
//! What runs is not here: the helpers' own runs (agents, their copies of the folder, R11c) and the ticket sessions'
//! huddle replies (board runs, R7a) go through `HuddleRunner`. Its stand-in runs nothing: a wake leaves the messages
//! unread (the participant's cursor stays), so the first board that can run them delivers them (`wake_if_owed` at
//! the next start), as Bun does after a restart.
//!
//! One change at a time: every change runs under one lock (Bun's event loop did that), held across the huddle's file
//! writes only (a few KB). Work Bun queued for after the change (`queueMicrotask`: the host-moved note, the note
//! about a file edited from outside) runs when the change is over, still in order. Calls block: the server runs
//! them on the blocking pool.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::future::BoxFuture;
use parking_lot::{Mutex, ReentrantMutex, RwLock};
use serde_json::{Map, Value, json};

use super::copies;
use super::files::HuddleFiles;
use super::model::*;
use crate::api::{RunControl, SessionInfo};
use crate::bus::Bus;
use crate::index::ticket::Tk;
use crate::prompts::js;
use crate::team::{Fail, Team, jsv, notes, presets, proposal, roster, squad, templates};
use crate::tickets::writer::Tickets;

pub type R<T> = Result<T, Fail>;

fn fail<T>(status: u16, msg: impl Into<String>) -> R<T> {
    Err(Fail::new(status, msg))
}

fn now() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

fn new_id() -> String {
    ckanban_core::atomic::new_id()
}

/// Who is calling: a board run's ticket (`x-ckanban-run`) and a huddle agent (`x-ckanban-huddle-agent`).
#[derive(Clone, Debug, Default)]
pub struct Caller {
    pub run: Option<String>,
    pub agent: Option<String>,
}

/// What a helper's run is doing (`AgentRun`), for the views and the watchdog.
#[derive(Clone, Debug, Default)]
pub struct AgentState {
    /// Between Claude's result and its next turn.
    pub idle: bool,
    pub pending: bool,
    pub again: bool,
    pub stop_requested: bool,
    /// Its process started (Bun's `run.handle`).
    pub started: bool,
    pub refreshing: bool,
}

/// What runs for a huddle: the helpers' runs (R11c) and the ticket sessions' replies (R7a). Every method has the
/// stand-in "nothing runs".
pub trait HuddleRunner: Send + Sync {
    /// The helper's run, if one is going.
    fn agent(&self, _slug: &str, _hid: &str, _handle: &str) -> Option<AgentState> {
        None
    }
    /// Boards with a helper mid-turn (a pending restart waits for them).
    fn busy_boards(&self) -> Vec<String> {
        Vec::new()
    }
    /// What a helper's turn in progress cost so far.
    fn turn_cost(&self, _slug: &str, _hid: &str, _handle: &str) -> f64 {
        0.0
    }
    /// A helper's first run (`kickoff`).
    fn kickoff(&self, _h: &Huddles, _slug: &str, _hid: &str, _handle: &str) {}
    /// Hand a helper what it hasn't read (`deliver` for agents): steer, queue for the turn boundary, or a new run.
    fn deliver_agent(&self, _h: &Huddles, _slug: &str, _hid: &str, _handle: &str, _mentioned: bool) {}
    /// Hand a ticket session (@main, an invited ticket) what it hasn't read, as a chat message of its ticket
    /// (`deliverNow` for ticket-main). Leave the cursor where it is when nothing can run it.
    fn deliver_main(&self, _h: &Huddles, _slug: &str, _hid: &str, _handle: &str) {}
    /// Ends the helper's huddle run, or the reply run a ticket session was woken for (`stopParticipantRun`).
    fn stop_run(&self, _slug: &str, _hid: &str, _p: &Obj) {}
    /// A session kept open between turns ends at its next pause (`endWhenIdle`).
    fn end_when_idle(&self, _slug: &str, _hid: &str, _handle: &str) {}
    /// Sends a ticket's session a message as a peer (`board.chat(.., { peer: true })`); None: nothing can run it.
    fn chat_ticket(&self, _slug: &str, _ticket: &str, _text: String) -> Option<BoxFuture<'static, Result<(), String>>> {
        None
    }
    /// After a close: the helpers' copies of the folder and what they left in the outputs (`removeWorktrees`,
    /// `cleanOutputs`).
    fn after_close(&self, _h: &Huddles, _slug: &str, _hid: &str) {}
    /// After a hand-in hit a conflict: a fresh copy for the helper now (`copyFor`). Err: its next run makes one.
    fn fresh_copy(&self, _h: &Huddles, _slug: &str, _hid: &str, _handle: &str, _host_dir: &Path) -> Result<(), String> {
        Err("no helper runs in this board yet".into())
    }
    /// After a restart, a helper cut off mid-turn or held back by a restart carries on (`recover`). False: left as it
    /// is for a board that can run it.
    fn recover_agent(&self, _h: &Huddles, _slug: &str, _hid: &str, _handle: &str) -> bool {
        false
    }
    /// The folder the host ticket's runs work in (`board.ensureSession(..).dir`).
    fn host_dir(&self, h: &Huddles, slug: &str, ticket: &str) -> Result<PathBuf, String> {
        h.host_dir(slug, ticket)
    }
}

/// The stand-in: nothing runs.
pub struct NoRunner;
impl HuddleRunner for NoRunner {}

/// Lessons an agent proposed when it turned done, for the board's pile (R12's learner): (board, huddle,
/// participant, role, lessons).
pub type Learn = Arc<dyn Fn(&str, &Obj, &Obj, &str, &[Value]) + Send + Sync>;

type Later = Box<dyn FnOnce(&Huddles) + Send>;
type HostStates = Arc<BTreeMap<String, Value>>;
type Hosted = Arc<HashMap<String, Vec<Arc<Obj>>>>;

pub struct Huddles {
    me: std::sync::Weak<Huddles>,
    pub files: Arc<HuddleFiles>,
    tickets: RwLock<Option<Arc<Tickets>>>,
    bus: RwLock<Option<Arc<Bus>>>,
    runs: RwLock<Option<Arc<dyn RunControl>>>,
    sessions: RwLock<Option<Arc<dyn SessionInfo>>>,
    pub runner: RwLock<Arc<dyn HuddleRunner>>,
    pub team: Arc<Team>,
    learn: RwLock<Option<Learn>>,
    op: ReentrantMutex<()>,
    later: Mutex<Vec<Later>>,
    /// Each huddle as this board last saved it, with its file's stamp (see `guard`).
    saved: Mutex<HashMap<String, (Option<String>, Obj)>>,
    /// Ticket sessions in monitor mode with messages waiting until their run ends, "<slug>/<hid>/<handle>".
    pub main_pending: Mutex<HashSet<String>>,
    /// Closed huddles whose summary @main was asked to write.
    summary_owed: Mutex<HashSet<String>>,
    pub shutting_down: AtomicBool,
    /// `hostStates` per board, with when it was worked out; dropped on every change.
    states: Mutex<HashMap<String, (f64, HostStates)>>,
    /// Teammates and their spend by host ticket, per board, by the huddle list's version.
    hosted: Mutex<HashMap<String, (u64, Hosted)>>,
}

/// How long `hostStates` is reused when nothing changed through this board (edits from outside show after it).
const STATES_FOR_MS: f64 = 1000.0;

impl Huddles {
    pub fn new(root: &Path, team: Arc<Team>) -> Arc<Huddles> {
        Arc::new_cyclic(|me| Huddles {
            me: me.clone(),
            files: Arc::new(HuddleFiles::new(root)),
            tickets: RwLock::new(None),
            bus: RwLock::new(None),
            runs: RwLock::new(None),
            sessions: RwLock::new(None),
            runner: RwLock::new(Arc::new(NoRunner)),
            team,
            learn: RwLock::new(None),
            op: ReentrantMutex::new(()),
            later: Mutex::new(Vec::new()),
            saved: Mutex::new(HashMap::new()),
            main_pending: Mutex::new(HashSet::new()),
            summary_owed: Mutex::new(HashSet::new()),
            shutting_down: AtomicBool::new(false),
            states: Mutex::new(HashMap::new()),
            hosted: Mutex::new(HashMap::new()),
        })
    }

    /// The board's ticket writes, event bus, runs and sessions (once the core is built).
    pub fn attach(self: &Arc<Self>, tickets: Arc<Tickets>, sessions: Arc<dyn SessionInfo>) {
        *self.bus.write() = Some(tickets.bus.clone());
        *self.runs.write() = Some(tickets.runs.clone());
        *self.tickets.write() = Some(tickets.clone());
        *self.sessions.write() = Some(sessions);
        let me = Arc::downgrade(self);
        tickets.bus.on(move |e| {
            if let Some(h) = me.upgrade() {
                h.on_event(e);
            }
        });
    }

    pub fn set_runner(&self, r: Arc<dyn HuddleRunner>) {
        *self.runner.write() = r;
    }
    pub fn set_learn(&self, l: Learn) {
        *self.learn.write() = Some(l);
    }
    fn runner(&self) -> Arc<dyn HuddleRunner> {
        self.runner.read().clone()
    }

    pub fn key(slug: &str, hid: &str, handle: &str) -> String {
        format!("{slug}/{hid}/{handle}")
    }

    // ---- the board around the room ----

    pub fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        self.tickets.read().as_ref()?.get(slug, id)
    }
    pub fn is_ticket_running(&self, slug: &str, id: &str) -> bool {
        self.runs.read().as_ref().is_some_and(|r| r.is_running(slug, id))
    }
    fn emit(&self, v: Value) {
        if let Some(b) = self.bus.read().as_ref() {
            b.emit_json(v);
        }
    }
    fn profile_path(&self, slug: &str) -> Option<String> {
        let p = ckanban_core::DataDir::new(self.files.root().to_path_buf()).profile(slug)?;
        p.record.0.get("path").and_then(Value::as_str).map(str::to_string)
    }
    /// The host ticket's folder: its own copy when it has one, its linked folder, else the board's folder.
    pub fn host_dir(&self, slug: &str, ticket: &str) -> Result<PathBuf, String> {
        let t = self.ticket(slug, ticket).ok_or_else(|| format!("ticket {ticket} not found"))?;
        for k in ["worktree", "workdir"] {
            if let Some(d) = t.json.get(k).and_then(Value::as_str).filter(|d| !d.is_empty())
                && Path::new(d).is_dir()
            {
                return Ok(PathBuf::from(d));
            }
        }
        let p = self.profile_path(slug).ok_or_else(|| format!("board {slug} not found"))?;
        if !Path::new(&p).is_dir() {
            return Err(format!("board folder does not exist: {p}"));
        }
        Ok(PathBuf::from(p))
    }
    fn outputs_dir(&self, slug: &str, ticket: &str) -> PathBuf {
        self.files.outputs_path(slug, ticket)
    }
    fn changed(&self, slug: &str) {
        self.states.lock().remove(slug);
    }

    /// Runs one change under the lock, then what it queued for afterwards.
    pub fn op<T>(&self, f: impl FnOnce(&Huddles) -> T) -> T {
        let _g = self.op.lock();
        let out = f(self);
        loop {
            let next: Vec<Later> = std::mem::take(&mut *self.later.lock());
            if next.is_empty() {
                break;
            }
            for l in next {
                l(self);
            }
        }
        out
    }
    fn after(&self, f: impl FnOnce(&Huddles) + Send + 'static) {
        self.later.lock().push(Box::new(f));
    }

    // ---- reading ----

    pub fn get(&self, slug: &str, hid: &str) -> R<Obj> {
        self.load(slug, hid).ok_or_else(|| Fail::new(404, format!("huddle {hid} not found")))
    }

    /// The huddle from its file, checked against edits made outside the board (`guard`).
    pub fn load(&self, slug: &str, hid: &str) -> Option<Obj> {
        let key = format!("{slug}/{hid}");
        let Some(h) = self.files.get(slug, hid) else {
            self.saved.lock().remove(&key);
            return None;
        };
        Some(self.guard(slug, h))
    }

    fn save(&self, slug: &str, h: &Obj) -> R<()> {
        self.files.save(slug, h).map_err(|e| Fail::new(500, e.to_string()))?;
        let id = s(h, "id").to_string();
        self.saved.lock().insert(format!("{slug}/{id}"), (self.files.stamp(slug, &id), h.clone()));
        self.changed(slug);
        Ok(())
    }

    /// `guard`: what an edit of the file from outside raised goes back to what the board had.
    fn guard(&self, slug: &str, mut h: Obj) -> Obj {
        let id = s(&h, "id").to_string();
        let key = format!("{slug}/{id}");
        let stamp = self.files.stamp(slug, &id);
        let was = {
            let mut saved = self.saved.lock();
            match saved.get(&key) {
                None => {
                    saved.insert(key, (stamp, h.clone()));
                    return h;
                }
                Some((st, _)) if *st == stamp => return h,
                Some((_, was)) => was.clone(),
            }
        };
        let before: Vec<Obj> = participants(&was).into_iter().cloned().collect();
        if let Some(Value::Array(ps)) = h.get_mut("participants") {
            ps.retain(|p| before.iter().any(|x| s(x, "handle") == p.get("handle").and_then(Value::as_str).unwrap_or("")));
            for p in ps.iter_mut().filter_map(Value::as_object_mut) {
                let Some(b0) = before.iter().find(|x| s(x, "handle") == s(p, "handle")) else { continue };
                if !b(b0, "lead") {
                    p.insert("lead".into(), false.into());
                }
                if !b(b0, "canEdit") {
                    p.insert("canEdit".into(), false.into());
                }
                for k in ["kind", "copy", "worktree", "branch"] {
                    match b0.get(k) {
                        Some(v) => {
                            p.insert(k.into(), v.clone());
                        }
                        None => {
                            p.shift_remove(k);
                        }
                    }
                }
                if f(b0, "costUsd") > f(p, "costUsd") {
                    p.insert("costUsd".into(), b0.get("costUsd").cloned().unwrap_or(Value::Null));
                }
            }
        }
        for k in ["status", "stopReason", "learnings", "handIns", "host", "hostRules", "topic"] {
            match was.get(k) {
                Some(v) => {
                    h.insert(k.into(), v.clone());
                }
                None => {
                    h.shift_remove(k);
                }
            }
        }
        for k in ["posts", "sinceUser", "idleNudged"] {
            if f(&was, k) > f(&h, k) {
                h.insert(k.into(), was[k].clone());
            }
        }
        for k in ["maxParticipants", "maxCostUsd", "maxMessages"] {
            if let Some(limit) = opt_f(&was, k)
                && opt_f(&h, k).is_none_or(|x| x > limit)
            {
                h.insert(k.into(), was[k].clone());
            }
        }
        let _ = self.save(slug, &h);
        let (slug2, id2) = (slug.to_string(), id.clone());
        self.after(move |me| {
            if me.files.get(&slug2, &id2).is_some() {
                let _ = me.system(&slug2, &id2, "Huddle file edited outside the board. Changes there to lead, canEdit, the host, the limits, the status, the costs, the participants, the learnings, the hand-ins or the copies of the folder were ignored; only the board changes them.", &[]);
            }
        });
        h
    }

    pub fn is_running(&self, slug: &str, h: &Obj, p: &Obj) -> bool {
        match s(p, "kind") {
            "agent" => self.runner().agent(slug, s(h, "id"), s(p, "handle")).is_some(),
            "ticket-main" => opt_s(p, "ticketId").is_some_and(|t| self.is_ticket_running(slug, t)),
            _ => false,
        }
    }

    /// Doing something now: an agent mid-turn, or a ticket session with a run.
    pub fn working(&self, slug: &str, h: &Obj, p: &Obj) -> bool {
        if s(p, "kind") == "agent" {
            return self.runner().agent(slug, s(h, "id"), s(p, "handle")).is_some_and(|r| !r.idle);
        }
        self.is_running(slug, h, p)
    }

    /// `view`: the huddle as the API sends it.
    pub fn view(&self, slug: &str, h: &Obj) -> Value {
        let msgs = if s(h, "status") == "closed" { Arc::default() } else { self.files.messages(slug, s(h, "id")) };
        let since = user_seen_seq(h, &msgs);
        let pending = pending_learnings(h).len();
        let mut out = h.clone();
        out.insert("hostTitle".into(), self.ticket(slug, s(h, "hostTicket")).map(|t| Value::from(t.title.clone())).unwrap_or(Value::Null));
        let runner = self.runner();
        let ps: Vec<Value> = participants(h)
            .into_iter()
            .map(|p| {
                let running = self.is_running(slug, h, p);
                let mut v = p.clone();
                v.shift_remove("token");
                if s(p, "kind") == "ticket-main" && matches!(s(p, "status"), "idle" | "working") {
                    v.insert("status".into(), Value::from(if running { "working" } else { "idle" }));
                }
                v.insert("running".into(), running.into());
                let live = if running { runner.turn_cost(slug, s(h, "id"), s(p, "handle")) } else { 0.0 };
                if live > 0.0 {
                    v.insert("liveCostUsd".into(), num(live));
                }
                Value::Object(v)
            })
            .collect();
        out.insert("participants".into(), Value::Array(ps));
        let (quiet, idle_since) = self.quiet(slug, h, &msgs);
        out.insert("quiet".into(), quiet.into());
        out.insert("idleSince".into(), idle_since.map(Value::from).unwrap_or(Value::Null));
        let for_you = msgs.iter().filter_map(Value::as_object).filter(|m| is_for_you(m, since)).count() + pending;
        out.insert("forYou".into(), num(for_you as f64));
        out.insert("forYouSince".into(), num(since));
        out.insert("learningsPending".into(), num(pending as f64));
        out.insert("summary".into(), self.summary_of(slug, h).map(Value::from).unwrap_or(Value::Null));
        Value::Object(out)
    }

    /// `summaryOf`: the huddle's summary file in the host's outputs.
    pub fn summary_of(&self, slug: &str, h: &Obj) -> Option<String> {
        let dir = self.outputs_dir(slug, s(h, "hostTicket"));
        let own = summary_file(s(h, "id"));
        if dir.join(&own).exists() {
            return Some(own);
        }
        (s(h, "status") == "closed" && dir.join(LEGACY_SUMMARY_FILE).exists()).then(|| LEGACY_SUMMARY_FILE.to_string())
    }

    /// `quiet`: live, nobody working, nobody with an unanswered tag and no open findings.
    pub fn quiet(&self, slug: &str, h: &Obj, msgs: &[Value]) -> (bool, Option<String>) {
        let ps: Vec<&Obj> = participants(h).into_iter().filter(|p| s(p, "kind") != "human").collect();
        if s(h, "status") != "live" || list(h, "findings").iter().any(|x| s(x, "status") == "open") || ps.iter().any(|p| self.working(slug, h, p)) {
            return (false, None);
        }
        let all: Vec<&Obj> = msgs.iter().filter_map(Value::as_object).collect();
        if ps.iter().any(|p| all.iter().any(|m| f(m, "seq") > f(p, "cursor") && wakes(h, p, m) == Some("mention"))) {
            return (false, None);
        }
        let mut times: Vec<&str> = Vec::new();
        if let Some(m) = all.last().and_then(|m| opt_s(m, "ts")) {
            times.push(m);
        }
        times.extend(ps.iter().filter_map(|p| opt_s(p, "idleAt")).filter(|t| !t.is_empty()));
        let since = times.into_iter().max().map(str::to_string).unwrap_or_else(|| s(h, "createdAt").to_string());
        (true, Some(since))
    }

    /// `hostStates`: each open huddle by host ticket, as "needs you" sees it.
    pub fn host_states(&self, slug: &str) -> Arc<BTreeMap<String, Value>> {
        let t = ckanban_core::time::now_ms();
        if let Some((at, v)) = self.states.lock().get(slug)
            && t - at < STATES_FOR_MS
        {
            return v.clone();
        }
        let runner = self.runner();
        let mut out = BTreeMap::new();
        for h in self.files.open(slug).iter() {
            let hid = s(h, "id");
            let msgs = self.files.messages(slug, hid);
            let seen = user_seen_seq(h, &msgs);
            let tagged: Vec<&Obj> = msgs.iter().filter_map(Value::as_object).filter(|m| is_for_you(m, seen)).collect();
            let learnings = pending_learnings(h);
            let live = s(h, "status") == "live";
            let agents: Vec<&Obj> = participants(h).into_iter().filter(|p| s(p, "kind") != "human").collect();
            let pending = self.main_pending.lock().clone();
            let queued = live
                && agents.iter().any(|p| {
                    if pending.contains(&Self::key(slug, hid, s(p, "handle"))) {
                        return true;
                    }
                    runner.agent(slug, hid, s(p, "handle")).is_some_and(|r| !r.stop_requested && (!r.started || r.pending || r.again))
                });
            let mut times: Vec<String> = tagged.iter().map(|m| s(m, "ts").to_string()).collect();
            times.extend(learnings.iter().map(|l| s(l, "at").to_string()));
            if let Some(c) = h.get("closeRequest").and_then(Value::as_object).and_then(|c| opt_s(c, "at")) {
                times.push(c.to_string());
            }
            times.retain(|t| !t.is_empty());
            let helpers: Vec<&&Obj> = agents.iter().filter(|p| !is_coordinator(h, p)).collect();
            let working = if live { agents.iter().filter(|p| self.working(slug, h, p)).count() } else { 0 };
            let helpers_working = if live { helpers.iter().filter(|p| self.working(slug, h, p)).count() } else { 0 };
            out.insert(
                s(h, "hostTicket").to_string(),
                json!({
                    "working": working, "queued": queued, "helpers": helpers.len(), "helpersWorking": helpers_working,
                    "findings": list(h, "findings").iter().filter(|x| s(x, "status") == "open").count(),
                    "tagged": tagged.len(), "learnings": learnings.len(), "closeRequest": h.get("closeRequest").is_some_and(|v| !v.is_null()),
                    "since": times.iter().min(), "latest": times.iter().max(),
                }),
            );
        }
        let out = Arc::new(out);
        self.states.lock().insert(slug.to_string(), (t, out.clone()));
        out
    }

    /// The board's huddles by host ticket, rebuilt only when the list changed.
    fn hosted_by(&self, slug: &str) -> Arc<HashMap<String, Vec<Arc<Obj>>>> {
        let version = self.files.version(slug);
        if let Some((v, m)) = self.hosted.lock().get(slug)
            && *v == version
        {
            return m.clone();
        }
        let mut map: HashMap<String, Vec<Arc<Obj>>> = HashMap::new();
        for h in self.files.index(slug).iter() {
            map.entry(s(h, "hostTicket").to_string()).or_default().push(h.clone());
        }
        let map = Arc::new(map);
        self.hosted.lock().insert(slug.to_string(), (version, map.clone()));
        map
    }

    /// `ticketSpend(..).costUsd`: what the agents of a ticket's huddles spent.
    pub fn ticket_spend(&self, slug: &str, id: &str) -> f64 {
        self.hosted_by(slug)
            .get(id)
            .map(|hs| hs.iter().flat_map(|h| participants(h).into_iter().filter(|p| s(p, "kind") == "agent").map(|p| f(p, "costUsd").max(0.0)).collect::<Vec<_>>()).sum())
            .unwrap_or(0.0)
    }

    /// Huddle teammates (agents with a session) of a host ticket: (handle, session id).
    pub fn teammates(&self, slug: &str, id: &str) -> Vec<(String, String)> {
        let Some(hs) = self.hosted_by(slug).get(id).cloned() else { return Vec::new() };
        hs.iter()
            .flat_map(|h| {
                participants(h)
                    .into_iter()
                    .filter(|p| s(p, "kind") == "agent" && b(p, "sessionStarted") && !s(p, "sessionId").is_empty())
                    .map(|p| (s(p, "handle").to_string(), s(p, "sessionId").to_string()))
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// `listSliced` (off the runtime): views of the board's huddles, or only the open ones, or a ticket's.
    pub fn list(&self, slug: &str, ticket: Option<&str>, open: bool) -> Vec<Value> {
        let picked = if open { self.files.open(slug) } else { self.files.index(slug) };
        picked
            .iter()
            .filter(|h| ticket.is_none_or(|t| s(h, "hostTicket") == t || participants(h).iter().any(|p| opt_s(p, "ticketId") == Some(t))))
            .map(|h| self.view(slug, h))
            .collect()
    }

    /// `messages`: newest page first; `before` pages back, `since` reads forward.
    pub fn messages(&self, slug: &str, hid: &str, before: Option<f64>, since: Option<f64>, limit: Option<f64>) -> R<Value> {
        self.get(slug, hid)?;
        let limit = limit.unwrap_or(100.0).clamp(1.0, 500.0) as usize;
        let all = self.files.messages(slug, hid);
        if let Some(sn) = since {
            let after: Vec<&Value> = all.iter().filter(|m| m.get("seq").and_then(Value::as_f64).unwrap_or(0.0) > sn).collect();
            let more = after.len() > limit;
            return Ok(json!({ "messages": after.into_iter().take(limit).collect::<Vec<_>>(), "hasMore": more }));
        }
        let all: Vec<&Value> = match before {
            Some(bf) => all.iter().filter(|m| m.get("seq").and_then(Value::as_f64).unwrap_or(0.0) < bf).collect(),
            None => all.iter().collect(),
        };
        let more = all.len() > limit;
        let page: Vec<&Value> = all[all.len().saturating_sub(limit)..].to_vec();
        Ok(json!({ "messages": page, "hasMore": more }))
    }

    /// `identify`: the participant a request comes from.
    pub fn identify(&self, slug: &str, hid: &str, who: &Caller) -> R<(Obj, Obj)> {
        if let Some(agent) = &who.agent {
            let mut it = agent.split('/');
            let (a_hid, handle, token) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""));
            if hid != "current" && hid != a_hid {
                return fail(403, format!("you are in huddle {a_hid}, not {hid}"));
            }
            let h = self.get(slug, a_hid)?;
            let me = participant(&h, handle).filter(|p| s(p, "kind") == "agent").cloned();
            let Some(me) = me.filter(|p| !token.is_empty() && opt_s(p, "token") == Some(token)) else {
                return fail(403, "unknown huddle agent");
            };
            if let Some(run) = &who.run
                && *run != format!("{slug}/{}", s(&h, "hostTicket"))
            {
                return fail(403, "huddle agents can only reach their own huddle");
            }
            return Ok((h, me));
        }
        if let Some(run) = &who.run {
            let mut it = run.split('/');
            let (run_slug, ticket) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            if run_slug != slug || ticket.is_empty() {
                return fail(403, format!("a run can only reach huddles on its own board ({run_slug})"));
            }
            let mine = |h: &Obj| participants(h).into_iter().find(|p| s(p, "kind") == "ticket-main" && opt_s(p, "ticketId") == Some(ticket)).cloned();
            let h = if hid == "current" {
                let open: Vec<Arc<Obj>> = self.files.open(slug).iter().filter(|x| mine(x).is_some()).rev().cloned().collect();
                let found = open.iter().find(|x| s(x, "hostTicket") == ticket).or(open.first());
                match found {
                    Some(x) => (**x).clone(),
                    None => return fail(404, format!("ticket {ticket} is in no open huddle")),
                }
            } else {
                self.get(slug, hid)?
            };
            let Some(me) = mine(&h) else { return fail(403, format!("ticket {ticket} is not in huddle {}", s(&h, "id"))) };
            return Ok((h, me));
        }
        if hid == "current" {
            return fail(400, "pass a huddle id");
        }
        let h = self.get(slug, hid)?;
        let me = participants(&h).into_iter().find(|p| s(p, "kind") == "human").cloned().unwrap_or_default();
        Ok((h, me))
    }

    // ---- changing ----

    /// `update`: read, change and save in one step, then tell the UI.
    pub fn update(&self, slug: &str, hid: &str, change: impl FnOnce(&mut Obj)) -> R<Obj> {
        let mut h = self.get(slug, hid)?;
        let live_host = |h: &Obj| (opt_s(h, "host").is_some_and(|x| !x.is_empty()) && s(h, "status") == "live").then(|| active_host(h));
        let before = live_host(&h);
        let was = opt_s(&h, "host").and_then(|x| participant(&h, x)).map(|p| s(p, "status").to_string());
        change(&mut h);
        h.insert("updatedAt".into(), now().into());
        self.save(slug, &h)?;
        self.emit(json!({ "type": "huddle.updated", "profile": slug, "huddle": self.view(slug, &h) }));
        let after = live_host(&h);
        if let (Some(bf), Some(af)) = (before, after)
            && bf != af
            && !self.shutting_down.load(Ordering::Relaxed)
        {
            let (slug, hid) = (slug.to_string(), hid.to_string());
            self.after(move |me| me.host_moved(&slug, &hid, &af, was.as_deref()));
        }
        Ok(h)
    }

    /// `hostMoved`.
    fn host_moved(&self, slug: &str, hid: &str, now_host: &str, was: Option<&str>) {
        let Some(h) = self.load(slug, hid) else { return };
        let Some(p) = opt_s(&h, "host").and_then(|x| participant(&h, x)).cloned() else { return };
        if s(&h, "status") != "live" || active_host(&h) != now_host {
            return;
        }
        let handle = s(&p, "handle");
        if now_host == handle {
            if was != Some("done") {
                let _ = self.system(slug, hid, &format!("@{handle} is back and runs the huddle again."), &[]);
            }
            return;
        }
        if s(&p, "status") == "done" {
            return;
        }
        let why = opt_s(&p, "statusReason").filter(|x| !x.is_empty()).or_else(|| (s(&p, "status") == "failed").then(|| s(&p, "error")).filter(|x| !x.is_empty()));
        let text = format!(
            "@{handle} (the host) is {}{}. @main runs the huddle again: the idle watchdog, the notes, the budget warnings and the hand-ins go to @main until @{handle} is back.",
            s(&p, "status"),
            why.map(|w| format!(": {w}")).unwrap_or_default()
        );
        let _ = self.system(slug, hid, &text, &[MAIN_HANDLE]);
    }

    /// `updateP`: one participant's fields.
    pub fn update_p(&self, slug: &str, hid: &str, handle: &str, patch: Obj) -> R<()> {
        if self.load(slug, hid).is_none() {
            return Ok(());
        }
        if patch.keys().all(|k| k == "lastActivity" || k == "contextTokens") {
            let mut h = self.get(slug, hid)?;
            let live = self.runner().turn_cost(slug, hid, handle);
            let Some(p) = participant_mut(&mut h, handle) else { return Ok(()) };
            let changed = patch.iter().any(|(k, v)| p.get(k) != Some(v));
            if !changed && live == 0.0 {
                return Ok(());
            }
            if changed {
                for (k, v) in patch {
                    p.insert(k, v);
                }
            }
            let mut ev = json!({ "type": "huddle.activity", "profile": slug, "huddleId": hid, "handle": handle, "lastActivity": p.get("lastActivity").cloned().unwrap_or(Value::Null) });
            if live > 0.0 {
                ev["liveCostUsd"] = num(live);
            }
            if jsv::truthy(p.get("contextTokens")) {
                ev["contextTokens"] = p["contextTokens"].clone();
            }
            if changed {
                self.save(slug, &h)?;
            }
            self.emit(ev);
            return Ok(());
        }
        self.update(slug, hid, |h| {
            if let Some(p) = participant_mut(h, handle) {
                for (k, v) in patch {
                    p.insert(k, v);
                }
            }
        })?;
        Ok(())
    }

    /// `append`: a message in the log. `known`: handles that can be mentioned.
    #[allow(clippy::too_many_arguments)]
    pub fn append(&self, slug: &str, hid: &str, from: &str, text: &str, kind: &str, known: &[String], allow_all: bool, source: Option<&str>, hand_in: Option<&str>) -> R<Obj> {
        let mut seq = 0.0;
        self.update(slug, hid, |h| {
            seq = f(h, "seq") + 1.0;
            h.insert("seq".into(), num(seq));
            if let Some(p) = participant_mut(h, from)
                && f(p, "cursor") == seq - 1.0
            {
                p.insert("cursor".into(), num(seq));
            }
        })?;
        let mentions: Vec<String> = if kind == "system" {
            known.to_vec()
        } else {
            parse_mentions(text).into_iter().filter(|m| if m == "all" { allow_all } else { known.contains(m) }).collect()
        };
        let mut m = json!({ "id": format!("m_{}", new_id()), "seq": num(seq), "ts": now(), "from": from, "text": text, "mentions": mentions, "kind": kind });
        if let Some(src) = source {
            m["source"] = src.into();
        }
        if let Some(x) = hand_in {
            m["handIn"] = x.into();
        }
        self.files.append(slug, hid, &m).map_err(|e| Fail::new(500, e.to_string()))?;
        self.changed(slug);
        self.emit(json!({ "type": "huddle.message", "profile": slug, "huddleId": hid, "message": m }));
        Ok(m.as_object().cloned().unwrap_or_default())
    }

    /// `system`: context only, except that `wake` are woken by it.
    pub fn system(&self, slug: &str, hid: &str, text: &str, wake: &[&str]) -> R<Obj> {
        let known: Vec<String> = wake.iter().map(|x| x.to_string()).collect();
        let m = self.append(slug, hid, "system", text, "system", &known, false, None, None)?;
        let h = self.get(slug, hid)?;
        if s(&h, "status") == "live" {
            for p in participants(&h) {
                if let Some(w) = wakes(&h, p, &m) {
                    self.wake(slug, &h, p, w == "mention");
                }
            }
        }
        Ok(m)
    }

    fn handles(h: &Obj) -> Vec<String> {
        participants(h).iter().map(|p| s(p, "handle").to_string()).collect()
    }

    pub fn assert_open(h: &Obj) -> R<()> {
        if s(h, "status") == "closed" {
            return fail(409, format!("huddle {} is closed (read-only)", s(h, "id")));
        }
        Ok(())
    }

    fn preset_map(&self, slug: &str) -> Vec<Obj> {
        self.team.presets(slug)
    }

    /// `expand`: participants made from one roster entry, with handles not in `taken`.
    fn expand(&self, e: &Obj, taken: &[String], presets: &[Obj], grant: bool, read_only: bool) -> Vec<Obj> {
        let t = |k: &str| e.get(k).and_then(Value::as_str).map(js::trim).filter(|x| !x.is_empty());
        let preset = t("preset").and_then(|n| presets.iter().find(|p| s(p, "name") == n));
        let count = e.get("count").and_then(Value::as_f64).unwrap_or(1.0) as usize;
        let base = roster::handle_base(t("handle").or(t("preset")).or(e.get("role").and_then(Value::as_str)).unwrap_or(""));
        let mut used: HashSet<String> = taken.iter().cloned().collect();
        used.extend(roster::RESERVED_HANDLES.iter().map(|x| x.to_string()));
        let mut out = Vec::new();
        let mut n = 1;
        for _ in 0..count {
            let mut handle = base.clone();
            if count > 1 || used.contains(&handle) {
                while used.contains(&format!("{base}-{n}")) {
                    n += 1;
                }
                handle = format!("{base}-{n}");
            }
            used.insert(handle.clone());
            let pstr = |k: &str| preset.and_then(|p| opt_s(p, k)).map(str::to_string);
            let pbool = |k: &str| preset.and_then(|p| p.get(k)).and_then(Value::as_bool);
            let asked = e.get("workspace").and_then(Value::as_str).map(str::to_string).or(pstr("workspace")).unwrap_or_else(|| "shared".into());
            let can_edit = !read_only && e.get("canEdit").and_then(Value::as_bool).or(pbool("canEdit")).unwrap_or(asked == "own");
            let workspace = if read_only { "shared".to_string() } else if can_edit { "own".into() } else { asked };
            let e_lead = e.get("lead").and_then(Value::as_bool);
            let e_host = e.get("host").and_then(Value::as_bool).unwrap_or(false);
            let lead = grant && (e_host || e_lead.or(pbool("lead")).unwrap_or(false));
            let mode = e.get("mode").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| {
                if lead && (e_lead == Some(true) || e_host) {
                    "monitor".into()
                } else {
                    pstr("mode").unwrap_or_else(|| if lead { "monitor".into() } else { "tagged".into() })
                }
            });
            let role = t("role").map(str::to_string).or(pstr("role").filter(|r| !r.is_empty())).unwrap_or_else(|| base.clone());
            let prompt: Vec<String> = [pstr("prompt"), t("prompt").map(str::to_string)].into_iter().flatten().filter(|x| !x.is_empty()).collect();
            let prompt = if prompt.is_empty() { format!("Help with the ticket as {}.", jsv::js_string(e.get("role"))) } else { prompt.join("\n\n") };
            let mut p = Map::new();
            p.insert("handle".into(), handle.into());
            p.insert("role".into(), role.into());
            p.insert("preset".into(), t("preset").map(Value::from).unwrap_or(Value::Null));
            p.insert("prompt".into(), prompt.into());
            if let Some(fc) = t("focus") {
                p.insert("focus".into(), fc.into());
            }
            p.insert("model".into(), t("model").map(str::to_string).or(pstr("model").filter(|m| !m.is_empty())).map(Value::from).unwrap_or(Value::Null));
            p.insert("mode".into(), mode.into());
            p.insert("lead".into(), lead.into());
            p.insert("canEdit".into(), can_edit.into());
            p.insert("workspace".into(), workspace.into());
            p.insert("sessionId".into(), Value::Null);
            p.insert("status".into(), "idle".into());
            p.insert("kind".into(), "agent".into());
            p.insert("cursor".into(), num(0.0));
            p.insert("joinedAt".into(), now().into());
            p.insert("token".into(), format!("{}{}", new_id(), new_id()).into());
            out.push(p);
        }
        out
    }

    /// `create`: start a huddle on a ticket from a roster or a squad (`template`).
    #[allow(clippy::too_many_arguments)]
    pub fn create(&self, slug: &str, host_id: &str, roster_in: Vec<Value>, max_participants: Option<f64>, max_cost: Option<f64>, template: Option<&str>, topic: Option<&Value>) -> R<Obj> {
        let Some(host) = self.ticket(slug, host_id) else { return fail(404, format!("ticket {host_id} not found")) };
        if host.json.get("error").and_then(Value::as_str).is_some_and(|e| e.starts_with("corrupt")) {
            return fail(409, format!("ticket {host_id} file is corrupt"));
        }
        let mut roster_in = roster_in;
        let tpls = self.team.templates(slug);
        let tpl = match template {
            Some(name) => {
                let name = js::trim(name);
                match tpls.iter().find(|t| s(t, "name") == name) {
                    Some(t) => Some(t.clone()),
                    None => {
                        let names = tpls.iter().map(|t| s(t, "name")).collect::<Vec<_>>().join(", ");
                        return fail(404, format!("no huddle template \"{}\" (templates: {names})", template.unwrap_or("")));
                    }
                }
            }
            None => None,
        };
        if let Some(t) = &tpl
            && roster_in.is_empty()
        {
            roster_in = t.get("roster").and_then(Value::as_array).cloned().unwrap_or_default();
        }
        let max = max_participants.unwrap_or(roster::DEFAULT_MAX_PARTICIPANTS as f64).round().clamp(2.0, 32.0);
        if let Some(c) = max_cost
            && !(c.is_finite() && c > 0.0)
        {
            return fail(400, "maxCostUsd must be a positive amount");
        }
        let tpl_cost = tpl.as_ref().and_then(|t| opt_f(t, "maxCostUsd"));
        let max_cost_usd = max_cost.or(tpl_cost).unwrap_or(DEFAULT_MAX_COST_USD);
        let budget_note = if max_cost.is_none() { if tpl_cost.is_some() { " (template default)" } else { " (default)" } } else { "" };
        if let Some(open) = self.files.open(slug).iter().find(|h| s(h, "hostTicket") == host_id) {
            return fail(409, format!("ticket {host_id} already has an open huddle ({}); close it first", s(open, "id")));
        }
        let presets = self.preset_map(slug);
        let names: Vec<String> = presets.iter().map(|p| s(p, "name").to_string()).collect();
        if let Some(err) = roster::roster_error(Some(&Value::Array(roster_in.clone())), max as usize, Some(&names)) {
            return fail(400, err);
        }
        let at = now();
        let topic = templates::topic_input(topic).map_err(|e| Fail::new(400, e))?;
        let host_rules = tpl.as_ref().map(|t| js::trim(s(t, "hostRules")).to_string()).filter(|x| !x.is_empty());
        let brief_topic = topic.clone().or_else(|| host_rules.as_ref().map(|_| ticket_topic(&host.title, &host.body)));
        let main = presets.iter().find(|p| s(p, "name") == presets::MAIN_PRESET).cloned().unwrap_or_default();
        let id = format!("h_{}", new_id());
        let mut h = Map::new();
        for (k, v) in [
            ("id", Value::from(id.clone())),
            ("hostTicket", host_id.into()),
            ("status", "live".into()),
            ("maxParticipants", num(max)),
            ("findings", json!([])),
            ("invited", json!([])),
            ("seq", num(0.0)),
            ("maxCostUsd", num(max_cost_usd)),
            ("posts", num(0.0)),
            ("sinceUser", num(0.0)),
            ("stopReason", Value::Null),
            ("createdAt", at.clone().into()),
            ("updatedAt", at.clone().into()),
            ("template", tpl.as_ref().map(|t| Value::from(s(t, "name"))).unwrap_or(Value::Null)),
        ] {
            h.insert(k.into(), v);
        }
        if let Some(t) = &topic {
            h.insert("topic".into(), t.clone().into());
        }
        if let Some(r) = &host_rules {
            h.insert("hostRules".into(), r.clone().into());
        }
        let brief = match (&tpl, &topic) {
            (Some(t), _) => json!({ "text": templates::template_brief(t, max_cost_usd, brief_topic.as_deref()), "by": USER_HANDLE, "at": at }),
            (None, Some(tp)) => json!({ "text": format!("Topic: {tp}"), "by": USER_HANDLE, "at": at }),
            _ => Value::Null,
        };
        h.insert("brief".into(), brief);
        let base = |handle: &str, role: &str| {
            let mut p = Map::new();
            for (k, v) in [
                ("prompt", Value::from("")),
                ("sessionId", Value::Null),
                ("status", "idle".into()),
                ("cursor", num(0.0)),
                ("joinedAt", at.clone().into()),
                ("workspace", "shared".into()),
                ("preset", Value::Null),
                ("handle", handle.into()),
                ("role", role.into()),
            ] {
                p.insert(k.into(), v);
            }
            p
        };
        let mut you = base(USER_HANDLE, "User");
        for (k, v) in [("model", Value::Null), ("mode", "monitor".into()), ("lead", true.into()), ("canEdit", false.into()), ("kind", "human".into())] {
            you.insert(k.into(), v);
        }
        let mut coord = base(MAIN_HANDLE, s(&main, "role"));
        for (k, v) in [
            ("preset", Value::from(presets::MAIN_PRESET)),
            ("prompt", Value::from(s(&main, "prompt"))),
            ("model", Value::Null),
            ("mode", Value::from(opt_s(&main, "mode").unwrap_or("monitor"))),
            ("lead", true.into()),
            ("canEdit", true.into()),
            ("kind", "ticket-main".into()),
            ("ticketId", host_id.into()),
        ] {
            coord.insert(k.into(), v);
        }
        h.insert("participants".into(), json!([you, coord]));
        let planning = host.status == "planning";
        let mut agents: Vec<Obj> = Vec::new();
        for e in &roster_in {
            let e = e.as_object().cloned().unwrap_or_default();
            let taken = Self::handles(&h);
            let ps = self.expand(&e, &taken, &presets, true, planning);
            if b(&e, "host")
                && let Some(first) = ps.first()
            {
                h.insert("host".into(), first["handle"].clone());
            }
            list_mut(&mut h, "participants").extend(ps.iter().cloned().map(Value::Object));
            agents.extend(ps);
        }
        if opt_s(&h, "host").is_none() && tpl.is_some() {
            h.insert("host".into(), agents.iter().find(|p| b(p, "lead")).map(|p| p["handle"].clone()).unwrap_or(Value::Null));
        }
        self.save(slug, &h)?;
        if planning {
            self.write_proposal(slug, &id, &host);
        }
        self.emit(json!({ "type": "huddle.updated", "profile": slug, "huddle": self.view(slug, &h) }));
        let who = agents.iter().map(|p| format!("@{} ({})", s(p, "handle"), s(p, "role"))).collect::<Vec<_>>().join(", ");
        let hosts = match opt_s(&h, "host") {
            Some(x) => format!("@{x} hosts: it hands out the tasks, accepts the hand-ins and sends @main the final report."),
            None => "@main coordinates.".into(),
        };
        let from = tpl.as_ref().map(|t| format!(" from squad {}", jsv::js_string(t.get("label")))).unwrap_or_default();
        self.system(
            slug,
            &id,
            &format!("Huddle started on ticket {host_id} \"{}\"{from} with {who}. {hosts} Budget {}{budget_note}.", host.title, money(max_cost_usd)),
            &[],
        )?;
        let runner = self.runner();
        for p in &agents {
            runner.kickoff(self, slug, &id, s(p, "handle"));
        }
        self.get(slug, &id)
    }

    /// `writeProposal`: the plan a plan review reads.
    fn write_proposal(&self, slug: &str, hid: &str, host: &Tk) {
        let entries = match (host.json.get("sessionId").and_then(Value::as_str), self.sessions.read().clone()) {
            (Some(sid), Some(ss)) if !sid.is_empty() => ss.entries(sid),
            _ => Vec::new(),
        };
        let text = crate::team::plan_review::plan_proposal(&Value::Object(host.json.clone()), &entries);
        let file = self.outputs_dir(slug, &host.id).join(proposal_file(hid));
        let r = file.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::write(&file, text));
        if let Err(e) = r {
            eprintln!("huddle {hid}: couldn't write the plan for review: {e}");
        }
    }

    // ---- messages ----

    /// `post`: a message from `by` (the board decided who that is), then routed.
    #[allow(clippy::too_many_arguments)]
    pub fn post(&self, slug: &str, hid: &str, by: &Obj, text: &str, kind: &str, status: Option<(Value, Option<String>, Option<Value>)>, source: &str) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        let t = js::trim(text);
        if t.is_empty() {
            return fail(400, "text is required");
        }
        let len = js::len16(t);
        if len > POST_MAX {
            return fail(
                400,
                format!(
                    "your message is {len} characters, over the huddle's limit of {POST_MAX}. Nothing was posted. Shorten it, split it into a few messages, or put the details in a file in your outputs folder and post its path."
                ),
            );
        }
        if kind != "message" && kind != "finding" {
            return fail(400, "kind must be message or finding");
        }
        if s(by, "status") == "stopped" && s(by, "kind") != "human" {
            return fail(409, format!("@{} was stopped by the user", s(by, "handle")));
        }
        if let Some((st, reason, lessons)) = &status {
            Self::check_lessons(by, st, lessons.as_ref())?;
            Self::check_status(by, st, reason.as_deref())?;
        }
        let m = self.append(slug, hid, s(by, "handle"), t, kind, &Self::handles(&h), can_manage(&h, by), Some(source), None)?;
        if s(&h, "status") == "live" && self.brakes(slug, hid, by)? {
            self.route(slug, hid, &m)?;
        }
        if let Some((st, reason, lessons)) = status {
            self.set_status(slug, hid, by, &st, reason.as_deref(), lessons.as_ref())?;
        }
        Ok(m)
    }

    /// `setBrief`: leads, @main and the user.
    pub fn set_brief(&self, slug: &str, hid: &str, by: &Obj, text: &str) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if !can_manage(&h, by) {
            return fail(403, "only a lead, @main or the user can change the brief; suggest the change to your lead");
        }
        let t = js::trim(text);
        let n = js::len16(t);
        if n > BRIEF_MAX {
            return fail(400, format!("the brief is {n} characters, over the limit of {BRIEF_MAX}; keep only the goal and the decisions"));
        }
        let cur = h.get("brief").and_then(Value::as_object).map(|x| s(x, "text").to_string()).unwrap_or_default();
        if cur == t {
            return Ok(h);
        }
        let who = s(by, "handle").to_string();
        self.update(slug, hid, |x| {
            x.insert("brief".into(), if t.is_empty() { Value::Null } else { json!({ "text": t, "by": who, "at": now() }) });
        })?;
        let text = if t.is_empty() { format!("@{who} cleared the pinned brief.") } else { format!("@{who} updated the pinned brief.") };
        self.system(slug, hid, &text, &[])?;
        self.get(slug, hid)
    }

    fn check_status(by: &Obj, status: &Value, reason: Option<&str>) -> R<()> {
        if s(by, "kind") == "human" {
            return fail(400, "the user has no huddle status");
        }
        let st = status.as_str().unwrap_or("");
        if !matches!(st, "done" | "blocked" | "active") {
            return fail(400, "status must be done, blocked or active");
        }
        if st == "blocked" && reason.map(js::trim).is_none_or(str::is_empty) {
            return fail(400, "say what blocks you (reason)");
        }
        Ok(())
    }

    fn check_lessons(by: &Obj, status: &Value, lessons: Option<&Value>) -> R<Vec<Value>> {
        let out = notes::clean_lessons(lessons).map_err(|e| Fail::new(400, format!("{e}. Nothing was changed.")))?;
        if out.is_empty() {
            return Ok(Vec::new());
        }
        if status.as_str() != Some("done") {
            return fail(400, "lessons go with status done, when your job is finished");
        }
        if s(by, "kind") != "agent" {
            return fail(400, "only huddle agents propose lessons");
        }
        Ok(out.iter().map(|l| serde_json::to_value(l).unwrap_or(Value::Null)).collect())
    }

    /// `setStatus`: done, blocked (reason) or active again.
    pub fn set_status(&self, slug: &str, hid: &str, by: &Obj, status: &Value, reason: Option<&str>, lessons: Option<&Value>) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        let proposed = Self::check_lessons(by, status, lessons)?;
        Self::check_status(by, status, reason)?;
        let st = status.as_str().unwrap_or("");
        let handle = s(by, "handle").to_string();
        let p = participant(&h, &handle).cloned().unwrap_or_default();
        if s(&p, "status") == "stopped" {
            return fail(409, format!("@{handle} was stopped by the user"));
        }
        let why = reason.map(js::trim).filter(|x| !x.is_empty()).map(str::to_string);
        let was_host = s(&h, "status") == "live" && opt_s(&h, "host").is_some_and(|x| !x.is_empty()) && active_host(&h) == handle;
        if st == "active" {
            if !settled(&p) {
                return Ok(p);
            }
            let now_st = if self.working(slug, &h, &p) { "working" } else { "idle" };
            self.update_p(slug, hid, &handle, obj([("status", now_st.into()), ("statusReason", Value::Null)]))?;
            self.system(slug, hid, &format!("@{handle} is active again."), &[])?;
        } else {
            self.update_p(slug, hid, &handle, obj([("status", st.into()), ("statusReason", why.clone().map(Value::from).unwrap_or(Value::Null))]))?;
            if !proposed.is_empty() {
                self.add_learnings(slug, hid, &p, &proposed);
            }
            let n = proposed.len();
            let learned = if n > 0 {
                format!(
                    "{} It noted {n} lesson{} for future huddles; the board saves {} once {} up again (Team, Learned).",
                    if why.is_some() { "." } else { "" },
                    if n == 1 { "" } else { "s" },
                    if n == 1 { "it" } else { "them" },
                    if n == 1 { "it comes" } else { "they come" }
                )
            } else {
                String::new()
            };
            if st == "done" {
                let w = why.as_ref().map(|w| format!(": {w}")).unwrap_or_else(|| ".".into());
                self.system(slug, hid, &format!("@{handle} is done{w}{learned}"), &[])?;
            } else if !was_host {
                let to = if is_coordinator(&h, &p) { USER_HANDLE.to_string() } else { active_host(&h) };
                self.system(slug, hid, &format!("@{handle} is blocked: {}", why.unwrap_or_default()), &[&to])?;
            }
        }
        Ok(participant(&self.get(slug, hid)?, &handle).cloned().unwrap_or_default())
    }

    /// Lessons go to the board's pile (R12's learner), aimed at the agent's own role when it has one.
    fn add_learnings(&self, slug: &str, hid: &str, p: &Obj, lessons: &[Value]) {
        let names: Vec<String> = self.preset_map(slug).iter().map(|x| s(x, "name").to_string()).collect();
        let target = opt_s(p, "preset").filter(|x| *x != presets::MAIN_PRESET && names.iter().any(|n| n == x)).unwrap_or(notes::ALL_ROLES).to_string();
        let learn = self.learn.read().clone();
        if let (Some(l), Ok(h)) = (learn, self.get(slug, hid)) {
            l(slug, &h, p, &target, lessons);
        }
    }

    /// `requestClose`: @main or a lead asks the user to close, once the summary is written.
    pub fn request_close(&self, slug: &str, hid: &str, by: &Obj, reason: &str) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if !can_manage(&h, by) {
            return fail(403, "only @main or a lead can ask to close the huddle; tell your lead you are done (huddle_status done)");
        }
        let summary = self.outputs_dir(slug, s(&h, "hostTicket")).join(summary_file(hid));
        if !summary.exists() {
            return fail(
                409,
                format!(
                    "write the huddle summary first: {} (what was decided, the findings and their state, what is left to do), then call huddle_close again",
                    summary.display()
                ),
            );
        }
        let why = js::trim(reason).trim_end_matches('.').to_string();
        let why = if why.is_empty() { "the work is done".to_string() } else { why };
        if h.get("auto").is_some_and(|a| !a.is_null()) && is_coordinator(&h, by) {
            return self.close(slug, hid, Some(&format!("closed by @main ({why})")), true);
        }
        let who = s(by, "handle").to_string();
        let w = why.clone();
        self.update(slug, hid, |x| {
            x.insert("closeRequest".into(), json!({ "by": who, "at": now(), "reason": w }));
        })?;
        self.system(
            slug,
            hid,
            &format!("@{} asks to close the huddle: {why}. The summary is in the host ticket's outputs ({}). @you: press Close huddle to end it; only you can close it.", s(by, "handle"), summary_file(hid)),
            &[USER_HANDLE],
        )?;
        self.get(slug, hid)
    }

    /// `brakes`: counts a new message.
    fn brakes(&self, slug: &str, hid: &str, by: &Obj) -> R<bool> {
        let human = s(by, "kind") == "human";
        self.update(slug, hid, |x| {
            let posts = f(x, "posts") + 1.0;
            x.insert("posts".into(), num(posts));
            let since = if human { 0.0 } else { f(x, "sinceUser") + 1.0 };
            x.insert("sinceUser".into(), num(since));
        })?;
        Ok(true)
    }

    /// `halt`: the huddle stops by itself (the budget).
    pub fn halt(&self, slug: &str, hid: &str, reason: &str, text: &str) -> R<()> {
        let h = self.get(slug, hid)?;
        if s(&h, "status") == "closed" || (s(&h, "status") != "live" && reason != "budget") || opt_s(&h, "stopReason") == Some(reason) {
            return Ok(());
        }
        let hard = reason != "loop";
        if hard {
            let runner = self.runner();
            for p in participants(&h).into_iter().filter(|p| s(p, "kind") != "human") {
                runner.stop_run(slug, hid, p);
            }
        }
        self.update(slug, hid, |x| {
            x.insert("status".into(), "stopped".into());
            x.insert("stopReason".into(), reason.into());
            if hard {
                for p in list_mut(x, "participants").iter_mut().filter_map(Value::as_object_mut) {
                    if s(p, "kind") == "agent" {
                        p.insert("status".into(), "stopped".into());
                    }
                }
            }
        })?;
        self.system(slug, hid, text, &[USER_HANDLE])?;
        Ok(())
    }

    /// `checkBudget`: after a cost update, warn the leads at 80% and stop at 100%.
    pub fn check_budget(&self, slug: &str, hid: &str) -> R<()> {
        let Some(h) = self.load(slug, hid) else { return Ok(()) };
        if s(&h, "status") == "closed" {
            return Ok(());
        }
        let max = opt_f(&h, "maxCostUsd").unwrap_or(DEFAULT_MAX_COST_USD);
        let spent = huddle_cost(&h);
        if spent >= max {
            let by = participants(&h).iter().filter(|p| f(p, "costUsd") > 0.0).map(|p| format!("@{} {}", s(p, "handle"), money(f(p, "costUsd")))).collect::<Vec<_>>().join(", ");
            let stop = format!("■ Paused at the {} budget ({} spent{}); every run was stopped.", money(max), money(spent), if by.is_empty() { String::new() } else { format!(": {by}") });
            let finished = h.get("closeRequest").is_some_and(|c| !c.is_null()) || self.quiet(slug, &h, &self.files.messages(slug, hid)).0;
            if !finished {
                return self.halt(slug, hid, "budget", &format!("{stop} @you: resume it with more budget if it should go on."));
            }
            self.update(slug, hid, |x| {
                x.insert("finishedAtStop".into(), true.into());
            })?;
            return self.halt(slug, hid, "budget", &format!("{stop} @you: the work looks finished, so check the result and close the huddle."));
        }
        if spent >= max * BUDGET_WARN && !b(&h, "budgetWarned") {
            self.update(slug, hid, |x| {
                x.insert("budgetWarned".into(), true.into());
            })?;
            let hosted = active_host(&h) != MAIN_HANDLE;
            let leads: Vec<String> = participants(&h)
                .into_iter()
                .filter(|p| b(p, "lead") && s(p, "kind") != "human" && s(p, "status") != "stopped" && !(hosted && s(p, "handle") == MAIN_HANDLE))
                .map(|p| s(p, "handle").to_string())
                .collect();
            let tags = leads.iter().map(|x| format!("@{x}")).collect::<Vec<_>>().join(" ");
            let text = format!(
                "{tags}{}he huddle has spent {} of its {} budget ({}%). Wrap up: send the consolidated findings now and only start what is needed; at 100% every run stops.",
                if leads.is_empty() { "T" } else { ": t" },
                money(spent),
                money(max),
                js::num((spent / max * 100.0).round())
            );
            let wake: Vec<&str> = leads.iter().map(String::as_str).collect();
            self.system(slug, hid, &text, &wake)?;
        }
        Ok(())
    }

    // ---- routing ----

    /// `route`: who a message wakes; a tag that wakes nobody gets a note.
    pub fn route(&self, slug: &str, hid: &str, m: &Obj) -> R<()> {
        let h = self.get(slug, hid)?;
        let mut unwoken = Vec::new();
        for p in participants(&h) {
            match wakes(&h, p, m) {
                Some(w) => self.wake(slug, &h, p, w == "mention"),
                None => {
                    if mentions_has(m, s(p, "handle")) && s(p, "kind") != "human" && s(p, "handle") != s(m, "from") {
                        unwoken.push(s(p, "handle").to_string());
                    }
                }
            }
        }
        for p in unwoken {
            self.note_unwoken(slug, hid, &p, s(m, "from"))?;
        }
        Ok(())
    }

    /// `noteUnwoken`.
    fn note_unwoken(&self, slug: &str, hid: &str, handle: &str, from: &str) -> R<()> {
        let h = self.get(slug, hid)?;
        let Some(cur) = participant(&h, handle) else { return Ok(()) };
        if (!settled(cur) && s(cur, "status") != "stopped") || from == USER_HANDLE {
            return Ok(());
        }
        let held = h.get("unwoken").and_then(|u| u.get(handle)).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(from)));
        if held {
            return Ok(());
        }
        let status = s(cur, "status").to_string();
        self.update(slug, hid, |x| {
            if !matches!(x.get("unwoken"), Some(Value::Object(_))) {
                x.insert("unwoken".into(), json!({}));
            }
            let u = x.get_mut("unwoken").and_then(Value::as_object_mut).expect("an object");
            let list = u.entry(handle.to_string()).or_insert_with(|| json!([]));
            if let Value::Array(a) = list {
                a.push(from.into());
            }
        })?;
        let to = if handle == MAIN_HANDLE { USER_HANDLE.to_string() } else { active_host(&h) };
        let who = if status == "stopped" { "only the user can restart it".to_string() } else { format!("@{to} or a lead can wake it") };
        self.system(slug, hid, &format!("@{handle} is {status} and wasn't woken by @{from}'s tag; {who}."), &[&to])?;
        Ok(())
    }

    /// `wake`: being woken ends done or blocked, and its unwoken-tag notes start over.
    pub fn wake(&self, slug: &str, h: &Obj, p: &Obj, mentioned: bool) {
        let (hid, handle) = (s(h, "id").to_string(), s(p, "handle").to_string());
        if settled(p) {
            let _ = self.update_p(slug, &hid, &handle, obj([("status", "idle".into()), ("statusReason", Value::Null)]));
        }
        if self.get(slug, &hid).ok().is_some_and(|x| x.get("unwoken").and_then(|u| u.get(&handle)).is_some()) {
            let _ = self.update(slug, &hid, |x| {
                if let Some(Value::Object(u)) = x.get_mut("unwoken") {
                    u.shift_remove(&handle);
                }
            });
        }
        self.deliver(slug, &hid, &handle, s(p, "kind"), opt_s(p, "ticketId"), mentioned);
    }

    /// `deliver`.
    fn deliver(&self, slug: &str, hid: &str, handle: &str, kind: &str, ticket: Option<&str>, mentioned: bool) {
        let runner = self.runner();
        if kind == "ticket-main" {
            if !mentioned && ticket.is_some_and(|t| self.is_ticket_running(slug, t)) {
                self.main_pending.lock().insert(Self::key(slug, hid, handle));
                self.changed(slug);
                return;
            }
            return self.deliver_now(slug, hid, handle);
        }
        runner.deliver_agent(self, slug, hid, handle, mentioned);
    }

    /// `deliverNow`: hand the participant everything it hasn't read.
    pub fn deliver_now(&self, slug: &str, hid: &str, handle: &str) {
        let Some(h) = self.load(slug, hid) else { return };
        let Some(p) = participant(&h, handle) else { return };
        if s(&h, "status") != "live" || matches!(s(p, "status"), "stopped" | "done") || self.shutting_down.load(Ordering::Relaxed) {
            return;
        }
        let runner = self.runner();
        if s(p, "kind") == "ticket-main" {
            runner.deliver_main(self, slug, hid, handle);
        } else {
            runner.deliver_agent(self, slug, hid, handle, true);
        }
    }

    /// `takeUnread`: unread messages for a participant (moves its cursor past them), whether one tags it, and the
    /// cursor before (to put back with `undo_unread`). None when there is nothing to act on.
    pub fn take_unread(&self, slug: &str, hid: &str, handle: &str, with_system: bool) -> R<Option<(Vec<Value>, bool, f64)>> {
        let h = self.get(slug, hid)?;
        let Some(p) = participant(&h, handle) else { return Ok(None) };
        let cursor = f(p, "cursor");
        let unread: Vec<Value> =
            self.files.messages(slug, hid).iter().filter(|m| m.get("seq").and_then(Value::as_f64).unwrap_or(0.0) > cursor && m.get("from").and_then(Value::as_str) != Some(handle)).cloned().collect();
        if cursor != f(&h, "seq") {
            self.update_p(slug, hid, handle, obj([("cursor", num(f(&h, "seq")))]))?;
        }
        let tags = |m: &Obj| mentions_has(m, handle) || mentions_has(m, "all");
        let ms: Vec<&Obj> = unread.iter().filter_map(Value::as_object).collect();
        if ms.is_empty() || (!with_system && !ms.iter().any(|m| s(m, "kind") != "system" || tags(m))) {
            return Ok(None);
        }
        let tagged = ms.iter().any(|m| tags(m));
        Ok(Some((unread, tagged, cursor)))
    }

    /// Puts a participant's cursor back (the digest never arrived).
    pub fn undo_unread(&self, slug: &str, hid: &str, handle: &str, prev: f64) {
        let _ = self.update_p(slug, hid, handle, obj([("cursor", num(prev))]));
    }

    /// `wakeIfOwed`: deliver a wake that was owed but never happened.
    pub fn wake_if_owed(&self, slug: &str, hid: &str, handle: &str) -> Option<&'static str> {
        let h = self.load(slug, hid)?;
        let p = participant(&h, handle)?.clone();
        if s(&h, "status") != "live" {
            return None;
        }
        let mut owed = None;
        for m in self.files.messages(slug, hid).iter().filter_map(Value::as_object) {
            if f(m, "seq") <= f(&p, "cursor") {
                continue;
            }
            match wakes(&h, &p, m) {
                Some("mention") => {
                    owed = Some("mention");
                    break;
                }
                w => owed = owed.or(w),
            }
        }
        if let Some(w) = owed {
            self.wake(slug, &h, &p, w == "mention");
        }
        owed
    }

    /// `idleCheck` for one live huddle (the watchdog). `now`: ms.
    pub fn idle_check(&self, slug: &str, hid: &str, now_ms: f64) -> R<()> {
        let Some(h) = self.load(slug, hid) else { return Ok(()) };
        if s(&h, "status") != "live" {
            return Ok(());
        }
        let msgs = self.files.messages(slug, hid);
        let all: Vec<&Obj> = msgs.iter().filter_map(Value::as_object).collect();
        let Some(last) = all.iter().rev().find(|m| s(m, "kind") != "system").copied() else { return Ok(()) };
        let to = active_host(&h);
        if s(last, "from") == MAIN_HANDLE || s(last, "from") == USER_HANDLE || f(last, "seq") <= f(&h, "idleNudged") {
            return Ok(());
        }
        let silent: Vec<String> = if s(last, "from") == to {
            participants(&h)
                .into_iter()
                .filter(|p| s(p, "kind") != "human" && s(p, "handle") != to && s(p, "status") != "stopped" && mentions_has(last, s(p, "handle")))
                .map(|p| s(p, "handle").to_string())
                .collect()
        } else {
            Vec::new()
        };
        if s(last, "from") == to && silent.is_empty() {
            return Ok(());
        }
        let parse = |t: &str| chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.timestamp_millis() as f64);
        let mut times: Vec<f64> = [opt_s(&h, "updatedAt"), all.last().and_then(|m| opt_s(m, "ts"))].into_iter().flatten().filter_map(parse).collect();
        times.extend(participants(&h).iter().filter_map(|p| opt_s(p, "idleAt")).filter_map(parse));
        if times.is_empty() || now_ms - times.iter().cloned().fold(f64::MIN, f64::max) < HUDDLE_IDLE_MS {
            return Ok(());
        }
        let ps: Vec<&Obj> = participants(&h).into_iter().filter(|p| s(p, "kind") != "human").collect();
        let pending = self.main_pending.lock().clone();
        if ps.iter().any(|p| self.working(slug, &h, p) || pending.contains(&Self::key(slug, hid, s(p, "handle")))) {
            return Ok(());
        }
        let runner = self.runner();
        for p in &ps {
            if runner.agent(slug, hid, s(p, "handle")).is_some_and(|r| r.pending || r.again || r.refreshing) {
                return Ok(());
            }
            if all.iter().any(|m| f(m, "seq") > f(p, "cursor") && wakes(&h, p, m).is_some()) {
                return Ok(());
            }
        }
        let last_seq = last["seq"].clone();
        self.update(slug, hid, |x| {
            x.insert("idleNudged".into(), last_seq);
        })?;
        let mins = js::num((HUDDLE_IDLE_MS / 60_000.0).round());
        let seq = js::num(f(last, "seq"));
        if !silent.is_empty() {
            let mut who = silent.iter().map(|x| format!("@{x}")).collect::<Vec<_>>().join(", ");
            if let Some(i) = who.rfind(", ") {
                who.replace_range(i..i + 2, " and ");
            }
            let one = silent.len() == 1;
            let text = format!(
                "Huddle idle for {mins} min: {who} {} answered your #{seq}. Count {} as \"no\" and name {} in the report, or tag {} once more.",
                if one { "hasn't" } else { "haven't" },
                if one { "that answer" } else { "their answers" },
                if one { "it" } else { "them" },
                if one { "it" } else { "them" }
            );
            self.system(slug, hid, &text, &[&to])?;
            return Ok(());
        }
        self.system(slug, hid, &format!("Huddle idle for {mins} min since #{seq} (last: @{}). Check who should act, or ask the user to close it.", s(last, "from")), &[&to])?;
        Ok(())
    }

    /// `idleSweep`: every board's live huddles.
    pub fn idle_sweep(&self) {
        if self.shutting_down.load(Ordering::Relaxed) {
            return;
        }
        let now_ms = ckanban_core::time::now_ms();
        for slug in self.boards() {
            let live: Vec<String> = self.files.open(&slug).iter().filter(|h| s(h, "status") == "live").map(|h| s(h, "id").to_string()).collect();
            for hid in live {
                if let Err(e) = self.op(|me| me.idle_check(&slug, &hid, now_ms)) {
                    eprintln!("huddle idle check {slug}/{hid}: {}", e.message);
                }
            }
        }
    }

    fn boards(&self) -> Vec<String> {
        ckanban_core::DataDir::new(self.files.root().to_path_buf()).list_profiles().map(|ps| ps.iter().filter_map(|p| p.slug().map(str::to_string)).collect()).unwrap_or_default()
    }

    // ---- participants, findings ----

    /// `addParticipants`: the user, the coordinator or a lead.
    pub fn add_participants(&self, slug: &str, hid: &str, by: &Obj, e: &Value) -> R<Vec<Obj>> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if !can_manage(&h, by) {
            return fail(403, "only a lead or @main can add participants; ask them (or the user) in the huddle");
        }
        let presets = self.preset_map(slug);
        let names: Vec<String> = presets.iter().map(|p| s(p, "name").to_string()).collect();
        if let Some(err) = roster::roster_entry_error(e, "", Some(&names)) {
            return fail(400, err);
        }
        let mut entry = e.as_object().cloned().unwrap_or_default();
        let want = entry.get("count").and_then(Value::as_f64).unwrap_or(1.0);
        let max = f(&h, "maxParticipants");
        let room = max - non_human(&h) as f64;
        if want > room {
            return fail(
                409,
                format!(
                    "the huddle is full: {} of {} participants{}. Don't work around the limit: ask the user (tag @you) to raise it or stop someone.",
                    non_human(&h),
                    js::num(max),
                    if room > 0.0 { format!(", room for {} more", js::num(room)) } else { String::new() }
                ),
            );
        }
        entry.shift_remove("host");
        let planning = self.ticket(slug, s(&h, "hostTicket")).is_some_and(|t| t.status == "planning");
        let added = self.expand(&entry, &Self::handles(&h), &presets, s(by, "kind") == "human", planning);
        let add = added.clone();
        self.update(slug, hid, |x| list_mut(x, "participants").extend(add.into_iter().map(Value::Object)))?;
        let who = added
            .iter()
            .map(|p| format!("@{} ({}{})", s(p, "handle"), s(p, "role"), opt_s(p, "focus").map(|fc| format!(": {fc}")).unwrap_or_default()))
            .collect::<Vec<_>>()
            .join(", ");
        self.system(slug, hid, &format!("@{} added {who}.", s(by, "handle")), &[])?;
        if s(&h, "status") == "live" {
            let runner = self.runner();
            for p in &added {
                runner.kickoff(self, slug, hid, s(p, "handle"));
            }
        }
        Ok(added)
    }

    /// `invite`: another ticket's own session (same board).
    pub fn invite(&self, slug: &str, hid: &str, by: &Obj, ticket: &str, handle: Option<&str>) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if s(by, "kind") != "human" && !is_coordinator(&h, by) {
            return fail(403, "only the user or @main can invite tickets");
        }
        let Some(t) = self.ticket(slug, ticket) else { return fail(404, format!("ticket {ticket} not found")) };
        if participants(&h).iter().any(|p| opt_s(p, "ticketId") == Some(ticket)) {
            return fail(409, format!("ticket {ticket} is already in this huddle"));
        }
        if non_human(&h) as f64 >= f(&h, "maxParticipants") {
            return fail(409, format!("the huddle is full ({} participants)", js::num(f(&h, "maxParticipants"))));
        }
        let plan_key = t.json.get("planKey").and_then(Value::as_str).filter(|x| !x.is_empty());
        let first = t.title.split_whitespace().next().filter(|x| !x.is_empty()).unwrap_or("ticket");
        let asked = handle.map(js::trim).filter(|x| !x.is_empty()).map(str::to_string).unwrap_or_else(|| format!("{}-main", plan_key.unwrap_or(first)));
        let base = roster::handle_base(&asked);
        let mut taken: HashSet<String> = Self::handles(&h).into_iter().collect();
        taken.extend(roster::RESERVED_HANDLES.iter().map(|x| x.to_string()));
        let mut name = base.clone();
        let mut n = 2;
        while taken.contains(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        let mut p = Map::new();
        for (k, v) in [
            ("handle", Value::from(name.clone())),
            ("role", format!("Ticket {} \"{}\"", t.id, t.title).into()),
            ("preset", Value::Null),
            ("prompt", "".into()),
            ("model", Value::Null),
            ("mode", "tagged".into()),
            ("lead", false.into()),
            ("canEdit", false.into()),
            ("workspace", "shared".into()),
            ("sessionId", Value::Null),
            ("status", "idle".into()),
            ("kind", "ticket-main".into()),
            ("ticketId", ticket.into()),
            ("cursor", h["seq"].clone()),
            ("joinedAt", now().into()),
        ] {
            p.insert(k.into(), v);
        }
        let add = p.clone();
        self.update(slug, hid, |x| {
            list_mut(x, "participants").push(Value::Object(add));
            list_mut(x, "invited").push(ticket.into());
        })?;
        self.system(slug, hid, &format!("@{} invited ticket {} \"{}\" as @{name}.", s(by, "handle"), t.id, t.title), &[])?;
        Ok(p)
    }

    /// `setMode`: the user sets anyone's, a participant only its own.
    pub fn set_mode(&self, slug: &str, hid: &str, by: &Obj, handle: &str, mode: Option<&Value>) -> R<()> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if s(by, "kind") != "human" && s(by, "handle") != handle {
            return fail(403, "you can only change your own mode");
        }
        let Some(p) = participant(&h, handle).filter(|p| s(p, "kind") != "human") else { return fail(404, format!("no participant @{handle}")) };
        let mode = mode.and_then(Value::as_str).unwrap_or("");
        if mode != "tagged" && mode != "monitor" {
            return fail(400, "mode must be tagged or monitor");
        }
        if s(p, "mode") == mode {
            return Ok(());
        }
        self.update_p(slug, hid, handle, obj([("mode", mode.into())]))?;
        if mode == "tagged" {
            self.runner().end_when_idle(slug, hid, handle);
        }
        let by_note = if s(by, "handle") != handle { format!(" (by @{})", s(by, "handle")) } else { String::new() };
        self.system(slug, hid, &format!("@{handle} switched to {mode} mode{by_note}."), &[])?;
        Ok(())
    }

    /// `findings`: leads and the coordinator add and resolve; everyone lists.
    pub fn findings(&self, slug: &str, hid: &str, by: &Obj, action: &str, text: Option<&str>, id: Option<&str>) -> R<Value> {
        let h = self.get(slug, hid)?;
        if action == "list" {
            return Ok(h.get("findings").cloned().unwrap_or(json!([])));
        }
        Self::assert_open(&h)?;
        if !can_manage(&h, by) {
            return fail(403, "only a lead or @main can change the findings list; post your finding to your lead instead");
        }
        let who = s(by, "handle").to_string();
        if action == "add" {
            let t = text.map(js::trim).filter(|x| !x.is_empty()).ok_or_else(|| Fail::new(400, "text is required"))?;
            let fid = format!("f{}", list(&h, "findings").len() + 1);
            let finding = json!({ "id": fid, "text": t, "by": who, "status": "open", "resolvedBy": null, "at": now() });
            self.update(slug, hid, |x| list_mut(x, "findings").push(finding))?;
            self.system(slug, hid, &format!("@{who} pinned finding {fid}: {}", finding_title(t)), &[])?;
        } else {
            let id = id.unwrap_or("");
            let Some(found) = list(&h, "findings").into_iter().find(|x| s(x, "id") == id) else {
                return fail(404, format!("no finding {}", if id.is_empty() { "undefined" } else { id }));
            };
            if s(found, "status") == "resolved" {
                return Ok(h.get("findings").cloned().unwrap_or(json!([])));
            }
            let w = who.clone();
            self.update(slug, hid, |x| {
                if let Some(g) = list_mut(x, "findings").iter_mut().filter_map(Value::as_object_mut).find(|g| s(g, "id") == id) {
                    g.insert("status".into(), "resolved".into());
                    g.insert("resolvedBy".into(), w.into());
                }
            })?;
            self.system(slug, hid, &format!("@{who} resolved finding {id}."), &[])?;
        }
        Ok(self.get(slug, hid)?.get("findings").cloned().unwrap_or(json!([])))
    }

    // ---- hand-ins ----

    /// `allowChanges`: a lead, @main or the user lets a helper change files in its own copy.
    pub fn allow_changes(&self, slug: &str, hid: &str, by: &Obj, handle: &str) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if !can_manage(&h, by) {
            return fail(403, "only a lead, @main or the user can let a helper change files; ask them in the huddle");
        }
        let want = js::trim(handle.strip_prefix('@').unwrap_or(handle));
        let Some(p) = participant(&h, want).filter(|p| s(p, "kind") == "agent").cloned() else {
            return fail(404, format!("no helper @{handle} (only helpers the huddle runs get a copy of the folder)"));
        };
        if self.ticket(slug, s(&h, "hostTicket")).is_some_and(|t| t.status == "planning") {
            return fail(409, "the ticket is in Planning, which never changes files; nobody in this huddle changes them");
        }
        let ph = s(&p, "handle").to_string();
        if s(by, "kind") == "agent" && s(by, "handle") == ph {
            return fail(403, "you can't give yourself the right to change files; ask @main or another lead");
        }
        if b(&p, "canEdit") {
            return Ok(p);
        }
        let moved = !jsv::truthy(p.get("worktree")) && b(&p, "sessionStarted");
        let mut patch = obj([("canEdit", true.into()), ("workspace", "own".into())]);
        if moved {
            patch.insert("sessionId".into(), Value::Null);
            patch.insert("sessionStarted".into(), false.into());
            patch.insert("cursor".into(), num(0.0));
        }
        self.update_p(slug, hid, &ph, patch)?;
        self.runner().end_when_idle(slug, hid, &ph);
        self.system(
            slug,
            hid,
            &format!("@{} let @{ph} change files. @{ph}: you now work in your own copy of the folder; do the work there and hand it in with huddle_hand_in.", s(by, "handle")),
            &[&ph],
        )?;
        Ok(participant(&self.get(slug, hid)?, &ph).cloned().unwrap_or_default())
    }

    /// `handIn`: a helper hands in what it changed in its copy.
    pub fn hand_in(&self, slug: &str, hid: &str, by: &Obj, summary: &str) -> R<Value> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if s(by, "kind") != "agent" {
            return fail(400, "only helpers hand in changes; yours are in the ticket's folder already");
        }
        let p = participant(&h, s(by, "handle")).cloned().unwrap_or_default();
        if !b(&p, "canEdit") {
            return fail(403, "you can't change files in this huddle; ask @main or a lead to let you (huddle_allow_changes)");
        }
        let copy = p.get("copy").and_then(Value::as_object).cloned();
        let Some(copy) = copy.filter(|c| Path::new(s(c, "dir")).exists()) else {
            return fail(409, "you have no copy of the folder yet; it is made when your next run starts");
        };
        if b(&copy, "fresh") {
            return fail(409, "your copy is out of date after a conflict; finish this turn without changing files: your fresh copy comes at your next turn");
        }
        let text = squash(summary);
        if text.is_empty() {
            return fail(400, "summary is required: one line on what you changed");
        }
        let n = js::len16(&text);
        if n > HANDIN_SUMMARY_MAX {
            return fail(400, format!("the summary is {n} characters, over the limit of {HANDIN_SUMMARY_MAX}; keep it to one line"));
        }
        let handle = s(&p, "handle").to_string();
        if let Some(w) = list(&h, "handIns").into_iter().find(|x| s(x, "from") == handle && s(x, "status") == "waiting") {
            return fail(409, format!("your hand-in {} still waits for a decision; wait for it (you are tagged), then hand in again", s(w, "id")));
        }
        let id = format!("c{}", list(&h, "handIns").len() + 1);
        let files = copies::hand_in(s(&copy, "dir"), opt_s(&copy, "kind").unwrap_or("folder"), &id).map_err(|e| Fail::new(500, e))?;
        if files.is_empty() {
            return fail(409, "nothing changed in your copy since your last hand-in (or since it was made); nothing was handed in");
        }
        let files: Vec<Value> = files.into_iter().map(Value::Object).collect();
        let hi = json!({ "id": id, "from": handle, "summary": text, "files": files, "status": "waiting", "at": now() });
        let add = hi.clone();
        self.update(slug, hid, |x| list_mut(x, "handIns").push(add))?;
        let host = active_host(&h);
        let decider = if host == handle { MAIN_HANDLE.to_string() } else { host };
        let body = format!("{text}\n\nHand-in {id}: {}. @{decider}: accept or reject it with huddle_review_changes.", hand_in_files(&files, 20));
        let m = self.append(slug, hid, &handle, &body, "handin", &Self::handles(&h), false, None, Some(&id))?;
        if s(&self.get(slug, hid)?, "status") == "live" && self.brakes(slug, hid, &p)? {
            self.route(slug, hid, &m)?;
        }
        Ok(hi)
    }

    /// `reviewHandIn`: a lead, @main or the user accepts (into the host's folder) or rejects a hand-in.
    pub fn review_hand_in(&self, slug: &str, hid: &str, by: &Obj, id: &str, accept: bool, reason: &str) -> R<Value> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if !can_manage(&h, by) {
            return fail(403, "only a lead, @main or the user accepts or rejects changes");
        }
        let id = js::trim(id).to_string();
        let pending = |me: &Huddles| -> R<Obj> {
            let h = me.get(slug, hid)?;
            let Some(x) = list(&h, "handIns").into_iter().find(|y| s(y, "id") == id).cloned() else {
                return fail(404, format!("no hand-in {id} in huddle {hid}"));
            };
            if s(&x, "status") != "waiting" {
                return fail(409, format!("hand-in {} was already {}", s(&x, "id"), s(&x, "status")));
            }
            Ok(x)
        };
        let hi = pending(self)?;
        let from = s(&hi, "from").to_string();
        if s(by, "kind") == "agent" && s(by, "handle") == from {
            return fail(403, "you can't accept or reject your own hand-in; @main or another lead decides");
        }
        let squashed = squash(reason);
        let why = js::slice16(&squashed, 500).to_string();
        let who = s(by, "handle").to_string();
        let decided = |status: &str, conflicts: Option<Vec<String>>, keep_reason: bool| {
            let mut m = obj([("status", status.into()), ("by", who.clone().into()), ("decidedAt", now().into())]);
            m.insert("reason".into(), if keep_reason && !why.is_empty() { why.clone().into() } else { Value::Null });
            if let Some(c) = conflicts {
                // Bun: `{ status, conflicts, ...decided, reason: null }`.
                let mut out = obj([("status", status.into()), ("conflicts", json!(c))]);
                out.extend(m);
                out.insert("reason".into(), Value::Null);
                return out;
            }
            m
        };
        let set = |me: &Huddles, patch: Obj| -> R<Value> {
            me.update(slug, hid, |x| {
                if let Some(g) = list_mut(x, "handIns").iter_mut().filter_map(Value::as_object_mut).find(|g| s(g, "id") == id) {
                    for (k, v) in patch {
                        g.insert(k, v);
                    }
                }
            })?;
            Ok(list(&me.get(slug, hid)?, "handIns").into_iter().find(|y| s(y, "id") == id).map(|x| Value::Object(x.clone())).unwrap_or(Value::Null))
        };
        if !accept {
            set(self, decided("rejected", None, true))?;
            let tail = if why.is_empty() { ".".to_string() } else { format!(": {why}") };
            self.system(slug, hid, &format!("@{who} rejected @{from}'s changes ({id}){tail} Nothing was changed in the ticket's folder."), &[&from])?;
            return Ok(list(&self.get(slug, hid)?, "handIns").into_iter().find(|y| s(y, "id") == id).map(|x| Value::Object(x.clone())).unwrap_or(Value::Null));
        }
        if self.ticket(slug, s(&h, "hostTicket")).is_some_and(|t| t.status == "planning") {
            return fail(409, "the ticket is in Planning, which never changes files");
        }
        let Some(copy) = participant(&h, &from).and_then(|p| p.get("copy")).and_then(Value::as_object).cloned() else {
            return fail(409, format!("@{from}'s copy of the folder is gone, so its changes can't be brought in"));
        };
        let runner = self.runner();
        let host_dir = runner.host_dir(self, slug, s(&h, "hostTicket")).map_err(|e| Fail::new(500, e))?;
        pending(self)?;
        let files = hi.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
        let conflicts = copies::accept(&host_dir, s(&copy, "dir"), &id, &files).map_err(|e| Fail::new(500, format!("couldn't bring in the changes, so nothing was changed: {e}")))?;
        if conflicts.is_empty() {
            set(self, decided("accepted", None, true))?;
            let n = files.len();
            let tell = if who == MAIN_HANDLE || active_host(&self.get(slug, hid)?) != MAIN_HANDLE { String::new() } else { format!(" @{MAIN_HANDLE}: they are in your folder now.") };
            let wake: Vec<&str> = if tell.is_empty() { vec![] } else { vec![MAIN_HANDLE] };
            self.system(slug, hid, &format!("@{who} accepted @{from}'s changes ({id}): {n} file{} now in the ticket's folder.{tell}", if n == 1 { "" } else { "s" }), &wake)?;
            return Ok(list(&self.get(slug, hid)?, "handIns").into_iter().find(|y| s(y, "id") == id).map(|x| Value::Object(x.clone())).unwrap_or(Value::Null));
        }
        set(self, decided("conflict", Some(conflicts.clone()), false))?;
        let run = runner.agent(slug, hid, &from);
        runner.end_when_idle(slug, hid, &from);
        let mut fresh = run.as_ref().is_none_or(|r| r.idle);
        if fresh && let Err(e) = runner.fresh_copy(self, slug, hid, &from, &host_dir) {
            fresh = false;
            eprintln!("couldn't make a fresh copy for @{from}: {e}");
        }
        if !fresh {
            let mut c = copy.clone();
            c.insert("fresh".into(), true.into());
            self.update_p(slug, hid, &from, obj([("copy", Value::Object(c))]))?;
        }
        let shown = if conflicts.len() > 8 { format!("{} and {} more", conflicts[..8].join(", "), conflicts.len() - 8) } else { conflicts.join(", ") };
        let saved = copies::hand_in_dir(s(&copy, "dir"), &id);
        let text = format!(
            "@{from}'s changes ({id}) weren't brought in: the ticket's folder also changed {shown} since @{from}'s copy was made. Nothing was changed. @{from}: your copy {}; redo your change there and hand it in again (what you handed in is saved in {}).",
            if fresh { "is now a fresh copy of the ticket's folder" } else { "becomes a fresh copy of the ticket's folder at your next turn, so finish this turn without changing files" },
            saved.display()
        );
        self.system(slug, hid, &text, &[&from])?;
        Ok(list(&self.get(slug, hid)?, "handIns").into_iter().find(|y| s(y, "id") == id).map(|x| Value::Object(x.clone())).unwrap_or(Value::Null))
    }

    // ---- learnings ----

    fn learning<'a>(h: &'a Obj, id: &str, any_state: bool) -> R<&'a Obj> {
        let Some(l) = list(h, "learnings").into_iter().find(|x| s(x, "id") == id) else {
            return fail(404, format!("no learning {id} in huddle {}", s(h, "id")));
        };
        if !any_state && s(l, "status") != "pending" {
            return fail(409, format!("learning {id} was already {}", s(l, "status")));
        }
        Ok(l)
    }

    fn set_learning(&self, slug: &str, hid: &str, id: &str, next: Obj) -> R<()> {
        self.update(slug, hid, |x| {
            if let Some(l) = list_mut(x, "learnings").iter_mut().filter_map(Value::as_object_mut).find(|l| s(l, "id") == id) {
                for (k, v) in next {
                    l.insert(k, v);
                }
            }
        })?;
        Ok(())
    }

    /// `patched`: a pending learning with the user's changes applied and checked.
    fn patched(&self, slug: &str, l: &Obj, patch: &Obj) -> R<Obj> {
        let mut out = l.clone();
        if let Some(t) = patch.get("text") {
            let t = notes::note_text(&if t.is_null() { String::new() } else { jsv::js_string(Some(t)) });
            if t.is_empty() {
                return fail(400, "the lesson's text is empty");
            }
            let n = js::len16(&t);
            if n > notes::NOTE_MAX {
                return fail(400, format!("the lesson is {n} characters, over the limit of {}", notes::NOTE_MAX));
            }
            out.insert("text".into(), t.into());
        }
        if let Some(sc) = patch.get("scope") {
            if sc.as_str() != Some("general") && sc.as_str() != Some("repo") {
                return fail(400, "scope must be general or repo");
            }
            out.insert("scope".into(), sc.clone());
        }
        let proposal = jsv::truthy(l.get("teammate")) || jsv::truthy(l.get("squad"));
        if patch.contains_key("target") && proposal {
            return fail(400, format!("a proposed {} is saved as itself; pick all boards or this board with scope", if jsv::truthy(l.get("squad")) { "squad" } else { "teammate" }));
        }
        if let Some(t) = patch.get("target") {
            let t = jsv::js_string(Some(t));
            let known = self.preset_map(slug).iter().any(|p| s(p, "name") == t);
            if t != notes::ALL_ROLES && t != "new" && (t == presets::MAIN_PRESET || !known) {
                return fail(400, format!("save to must be {} (all roles), a role preset of this board, or new", notes::ALL_ROLES));
            }
            if t == "new" && jsv::truthy(l.get("preset")) {
                return fail(400, format!("@{} already has a role preset ({}); save to it instead", s(l, "from"), s(l, "preset")));
            }
            out.insert("target".into(), t.into());
        }
        Ok(out)
    }

    /// `editLearning`.
    pub fn edit_learning(&self, slug: &str, hid: &str, id: &str, patch: &Obj) -> R<Obj> {
        let h = self.get(slug, hid)?;
        let next = self.patched(slug, Self::learning(&h, id, false)?, patch)?;
        self.set_learning(slug, hid, id, next.clone())?;
        Ok(next)
    }

    /// `saveLearning`: a proposed teammate or squad saved as itself, or a lesson as a role note.
    pub fn save_learning(&self, slug: &str, hid: &str, id: &str, patch: &Obj) -> R<Value> {
        let h = self.get(slug, hid)?;
        let l = self.patched(slug, Self::learning(&h, id, false)?, patch)?;
        let level = if s(&l, "scope") == "general" { "global" } else { "board" };
        if let Some(sq) = l.get("squad").filter(|v| jsv::truthy(Some(v))) {
            let squad_in = sq.get("squad").cloned().unwrap_or(Value::Null);
            self.team.save_squad(slug, Some(&squad_in), Some(&Value::from(level)), Some((hid, id)), jsv::is_true(patch.get("replace")), None)?;
            return Ok(Value::Object(Self::learning(&self.get(slug, hid)?, id, true)?.clone()));
        }
        if let Some(tm) = l.get("teammate").and_then(Value::as_object).filter(|v| !v.is_empty()) {
            let p = self.team.save_preset(slug, Some(&Value::Object(proposal::proposal_preset(tm))), Some(&Value::from(level)))?;
            let mut saved = l.clone();
            saved.insert("status".into(), "saved".into());
            saved.insert("target".into(), p.get("name").cloned().unwrap_or(Value::Null));
            self.set_learning(slug, hid, id, saved.clone())?;
            return Ok(Value::Object(saved));
        }
        let mut role = s(&l, "target").to_string();
        if role == "new" {
            let p = participant(&h, s(&l, "from")).cloned();
            let name = presets::preset_name(s(&l, "role"));
            let Some(p) = p.filter(|_| !name.is_empty()) else { return fail(400, format!("can't make a role from \"{}\"", s(&l, "role"))) };
            if self.preset_map(slug).iter().any(|x| s(x, "name") == name) {
                return fail(409, format!("a role \"{name}\" already exists; save the lesson to it instead"));
            }
            let input = json!({ "name": name, "role": s(&l, "role"), "prompt": s(&p, "prompt"), "model": p.get("model"), "mode": p.get("mode"),
                "workspace": p.get("workspace"), "lead": false, "canEdit": p.get("canEdit") });
            self.team.save_preset(slug, Some(&input), None)?;
            role = name;
        }
        let scope = notes::Scope::of(s(&l, "scope")).unwrap_or(notes::Scope::General);
        let note = json!({ "text": s(&l, "text"), "by": s(&l, "from"), "date": js::slice16(&now(), 10), "huddle": s(&h, "id") });
        let mut all = vec![note];
        all.extend(self.team.read_notes(slug, &role, scope).iter().map(|n| serde_json::to_value(n).unwrap_or(Value::Null)));
        self.team.set_notes(slug, &role, s(&l, "scope"), Some(&Value::Array(all)))?;
        let mut saved = l.clone();
        saved.insert("status".into(), "saved".into());
        saved.insert("target".into(), role.into());
        if s(&l, "target") == "new" {
            saved.insert("newRole".into(), true.into());
        }
        self.set_learning(slug, hid, id, saved.clone())?;
        Ok(Value::Object(saved))
    }

    /// `discardLearning`.
    pub fn discard_learning(&self, slug: &str, hid: &str, id: &str) -> R<Value> {
        let h = self.get(slug, hid)?;
        let mut l = Self::learning(&h, id, false)?.clone();
        l.insert("status".into(), "discarded".into());
        self.set_learning(slug, hid, id, obj([("status", "discarded".into())]))?;
        Ok(Value::Object(l))
    }

    #[allow(clippy::too_many_arguments)]
    fn push_learning(&self, slug: &str, hid: &str, by: &Obj, text: &str, target: &str, field: &str, v: Value) -> R<Obj> {
        let mut out = Map::new();
        self.update(slug, hid, |x| {
            let n = list(x, "learnings").len() + 1;
            for (k, val) in [
                ("id", Value::from(format!("l{n}"))),
                ("from", s(by, "handle").into()),
                ("role", s(by, "role").into()),
                ("preset", by.get("preset").cloned().unwrap_or(Value::Null)),
                ("text", text.into()),
                ("evidence", "".into()),
                ("scope", "general".into()),
                ("status", "pending".into()),
                ("target", target.into()),
                ("at", now().into()),
                (field, v),
            ] {
                out.insert(k.into(), val);
            }
            list_mut(x, "learnings").push(Value::Object(out.clone()));
        })?;
        Ok(out)
    }

    /// `proposeTeammate`: an agent's proposed teammate waits under Learnings.
    pub fn propose_teammate(&self, slug: &str, hid: &str, by: &Obj, input: &Value) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if s(by, "kind") != "agent" {
            return fail(400, "only huddle agents propose teammates to the huddle; a ticket chat's propose_teammate shows a card in its chat");
        }
        let t = proposal::teammate_proposal(Some(input)).map_err(|e| Fail::new(400, format!("{e}. Nothing was changed.")))?;
        let waiting = pending_learnings(&h).iter().filter(|l| s(l, "from") == s(by, "handle") && jsv::truthy(l.get("teammate"))).count();
        if waiting >= MAX_PENDING_TEAMMATES {
            return fail(400, format!("you already have {waiting} proposed teammates waiting for the user; at most {MAX_PENDING_TEAMMATES} can wait at once. Nothing was changed."));
        }
        let name = s(&t, "name").to_string();
        let why = s(&t, "why").to_string();
        let out = self.push_learning(slug, hid, by, &why, "new", "teammate", Value::Object(t))?;
        let known = self.preset_map(slug).iter().any(|p| s(p, "name") == name);
        let what = if known { format!("a change to teammate @{name}") } else { format!("a new teammate @{name}") };
        self.system(slug, hid, &format!("@{} proposed {what}; the user reviews it under Learnings.", s(by, "handle")), &[])?;
        Ok(out)
    }

    /// `proposeSquad`.
    pub fn propose_squad(&self, slug: &str, hid: &str, by: &Obj, input: &Value) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if s(by, "kind") != "agent" {
            return fail(400, "only huddle agents propose squads to the huddle; a ticket chat's propose_squad shows a card in its chat");
        }
        let names: Vec<String> = self.preset_map(slug).iter().map(|p| s(p, "name").to_string()).collect();
        let sq = squad::squad_proposal(Some(input), Some(&names)).map_err(|e| Fail::new(400, format!("{e}. Nothing was changed.")))?;
        if pending_learnings(&h).iter().any(|l| s(l, "from") == s(by, "handle") && jsv::truthy(l.get("squad"))) {
            return fail(400, "you already have a proposed squad waiting for the user; one can wait at once. Nothing was changed.");
        }
        let inner = sq.get("squad").and_then(Value::as_object).cloned().unwrap_or_default();
        let out = self.push_learning(slug, hid, by, s(&sq, "why"), s(&inner, "name"), "squad", Value::Object(sq.clone()))?;
        self.system(slug, hid, &format!("@{} proposed a squad \"{}\"; the user reviews it under Learnings.", s(by, "handle"), jsv::js_string(inner.get("label"))), &[])?;
        Ok(out)
    }

    // ---- stop, resume, close ----

    /// `stopParticipant`: the user stops one participant.
    pub fn stop_participant(&self, slug: &str, hid: &str, handle: &str) -> R<()> {
        let h = self.get(slug, hid)?;
        let Some(p) = participant(&h, handle).filter(|p| s(p, "kind") != "human") else { return fail(404, format!("no participant @{handle}")) };
        self.runner().stop_run(slug, hid, p);
        self.update_p(slug, hid, handle, obj([("status", "stopped".into())]))?;
        if s(&h, "status") != "closed" {
            self.system(slug, hid, &format!("@{handle} was stopped by @you."), &[])?;
        }
        self.user_acted(slug, hid)
    }

    /// `restartParticipant`: a failed or stopped participant is idle again.
    pub fn restart_participant(&self, slug: &str, hid: &str, handle: &str) -> R<()> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        let Some(p) = participant(&h, handle).filter(|p| s(p, "kind") != "human") else { return fail(404, format!("no participant @{handle}")) };
        if !matches!(s(p, "status"), "failed" | "stopped") {
            return fail(409, format!("@{handle} is {}, not failed or stopped", s(p, "status")));
        }
        self.update_p(slug, hid, handle, obj([("status", "idle".into()), ("error", Value::Null)]))?;
        let live = s(&h, "status") == "live";
        let text = format!("@{handle} was restarted by @you{}.", if live { "" } else { "; it wakes when the huddle resumes" });
        let wake: Vec<&str> = if live { vec![handle] } else { vec![] };
        self.system(slug, hid, &text, &wake)?;
        self.user_acted(slug, hid)
    }

    /// `markSeen`.
    pub fn mark_seen(&self, slug: &str, hid: &str, seq: Option<f64>) -> R<Obj> {
        let h = self.get(slug, hid)?;
        let Some(seq) = seq.filter(|x| x.is_finite()) else { return fail(400, "seq must be a number") };
        let to = seq.floor().min(f(&h, "seq"));
        let Some(me) = participant(&h, USER_HANDLE) else { return Ok(h) };
        if f(me, "cursor") >= to {
            return Ok(h);
        }
        self.update(slug, hid, |x| {
            if let Some(m) = participant_mut(x, USER_HANDLE) {
                let c = f(m, "cursor").max(to);
                m.insert("cursor".into(), num(c));
            }
        })
    }

    /// `userActed`: what tagged the user so far counts as seen.
    fn user_acted(&self, slug: &str, hid: &str) -> R<()> {
        if self.files.get(slug, hid).is_none() {
            return Ok(());
        }
        self.update(slug, hid, |x| {
            let seq = x["seq"].clone();
            if let Some(m) = participant_mut(x, USER_HANDLE) {
                m.insert("cursor".into(), seq);
            }
        })?;
        Ok(())
    }

    /// `stopAll`: every helper's run and the huddle's reply runs end; routing stops until resumed.
    pub fn stop_all(&self, slug: &str, hid: &str) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        let runner = self.runner();
        for p in participants(&h).into_iter().filter(|p| s(p, "kind") != "human") {
            runner.stop_run(slug, hid, p);
        }
        self.update(slug, hid, |x| {
            x.insert("status".into(), "stopped".into());
            x.insert("stopReason".into(), Value::Null);
            for p in list_mut(x, "participants").iter_mut().filter_map(Value::as_object_mut) {
                if s(p, "kind") == "agent" {
                    p.insert("status".into(), "stopped".into());
                }
            }
        })?;
        self.system(slug, hid, "Huddle agents stopped by @you. The tickets' own runs keep going.", &[])?;
        self.user_acted(slug, hid)?;
        self.get(slug, hid)
    }

    /// `resume`: routing again; `add` raises the budget.
    pub fn resume(&self, slug: &str, hid: &str, add: f64) -> R<Obj> {
        let h = self.get(slug, hid)?;
        Self::assert_open(&h)?;
        if !add.is_finite() || add < 0.0 {
            return fail(400, "addBudgetUsd must be a positive amount");
        }
        let max = opt_f(&h, "maxCostUsd").unwrap_or(DEFAULT_MAX_COST_USD) + add;
        let spent = huddle_cost(&h);
        if spent >= max {
            return fail(409, format!("the huddle spent {} of its {} budget: add budget to resume it", money(spent), money(max)));
        }
        self.update(slug, hid, |x| {
            x.insert("status".into(), "live".into());
            x.insert("stopReason".into(), Value::Null);
            x.insert("maxCostUsd".into(), num(max));
            x.insert("sinceUser".into(), num(0.0));
            x.insert("held".into(), Value::Null);
            x.insert("finishedAtStop".into(), false.into());
            if spent < max * BUDGET_WARN {
                x.insert("budgetWarned".into(), false.into());
            }
            for p in list_mut(x, "participants").iter_mut().filter_map(Value::as_object_mut) {
                if s(p, "status") == "stopped" {
                    p.insert("status".into(), "idle".into());
                }
            }
        })?;
        if s(&h, "status") != "live" || add != 0.0 {
            let more = if add != 0.0 { format!(" with {} more budget (now {})", money(add), money(max)) } else { String::new() };
            self.system(slug, hid, &format!("Huddle resumed by @you{more}."), &[])?;
        }
        self.user_acted(slug, hid)?;
        let mut tagged = false;
        for p in participants(&self.get(slug, hid)?).into_iter().filter(|p| s(p, "kind") != "human") {
            if self.wake_if_owed(slug, hid, s(p, "handle")) == Some("mention") {
                tagged = true;
            }
        }
        if !tagged {
            self.system(slug, hid, "Nobody was tagged while the huddle was stopped, so no agent has new work. @you: tag an agent to give it work, or close the huddle.", &[])?;
        }
        self.get(slug, hid)
    }

    /// `close`: the huddle's runs stop and the history stays read-only.
    pub fn close(&self, slug: &str, hid: &str, why: Option<&str>, summarize: bool) -> R<Obj> {
        let h = self.get(slug, hid)?;
        if s(&h, "status") == "closed" {
            return Ok(h);
        }
        let runner = self.runner();
        for p in participants(&h).into_iter().filter(|p| s(p, "kind") != "human") {
            runner.stop_run(slug, hid, p);
        }
        let text = match why {
            Some(w) => format!("Huddle closed: {w}. The history stays, read-only."),
            None => "Huddle closed by @you. The history stays, read-only.".into(),
        };
        self.system(slug, hid, &text, &[])?;
        let out = self.update(slug, hid, |x| {
            x.insert("status".into(), "closed".into());
            x.insert("closedAt".into(), now().into());
            for p in list_mut(x, "participants").iter_mut().filter_map(Value::as_object_mut) {
                if s(p, "kind") == "agent" && s(p, "status") == "working" {
                    p.insert("status".into(), "stopped".into());
                }
            }
        })?;
        runner.after_close(self, slug, hid);
        if summarize {
            self.ensure_summary(slug, hid);
        }
        Ok(out)
    }

    /// `closeForTicket`: the host ticket was deleted or moved to Done.
    pub fn close_for_ticket(&self, slug: &str, ticket: &str, why: &str) {
        let done_at = if why == DELETED {
            None
        } else {
            self.ticket(slug, ticket).map(|t| t.json.get("doneAt").and_then(Value::as_str).map(str::to_string))
        };
        let ids: Vec<String> = self
            .files
            .open(slug)
            .iter()
            .filter(|h| s(h, "hostTicket") == ticket && done_at.as_ref().is_none_or(|d| ended_by_done(h, d.as_deref())))
            .map(|h| s(h, "id").to_string())
            .collect();
        for hid in ids {
            if let Err(e) = self.close(slug, &hid, Some(why), why != DELETED) {
                eprintln!("closing huddle {slug}/{hid}: {}", e.message);
            }
        }
    }

    /// `ensureSummary`: @main writes it when the host can run; otherwise the board does.
    pub fn ensure_summary(&self, slug: &str, hid: &str) {
        let Some(h) = self.load(slug, hid) else { return };
        let Some(t) = self.ticket(slug, s(&h, "hostTicket")) else { return };
        let dir = self.outputs_dir(slug, &t.id);
        let file = dir.join(summary_file(hid));
        if file.exists() {
            return;
        }
        let legacy = dir.join(LEGACY_SUMMARY_FILE);
        let legacy_new = std::fs::metadata(&legacy)
            .and_then(|m| m.modified())
            .map(|m| ckanban_core::time::iso(ckanban_core::time::system_ms(m)).as_str() >= s(&h, "createdAt"))
            .unwrap_or(false);
        if legacy_new {
            if let Some(p) = file.parent() {
                let _ = std::fs::create_dir_all(p);
            }
            let _ = std::fs::copy(&legacy, &file);
            return self.touch(slug, hid);
        }
        let sid = t.json.get("sessionId").and_then(Value::as_str).filter(|x| !x.is_empty());
        let can_run = t.status != "done"
            && sid.is_some_and(session_exists)
            && jsv::truthy(t.json.get("sessionStarted"));
        let ask = format!(
            "Huddle {hid} was closed without a summary. Write it to {}: what was decided, the findings and their state, what is left to do. The huddle is closed, so don't post there; just write the file and end your turn.",
            file.display()
        );
        let chat = if can_run { self.runner().chat_ticket(slug, &t.id, ask) } else { None };
        let Some(fut) = chat else { return self.write_fallback_summary(slug, hid) };
        let key = format!("{slug}/{hid}");
        self.summary_owed.lock().insert(key.clone());
        let me = self.self_ref();
        let (slug, hid) = (slug.to_string(), hid.to_string());
        spawn(async move {
            if fut.await.is_err()
                && let Some(me) = me.and_then(|w| w.upgrade())
            {
                me.summary_owed.lock().remove(&key);
                let _ = tokio::task::spawn_blocking(move || me.op(|m| m.write_fallback_summary(&slug, &hid))).await;
            }
        });
    }

    /// `writeFallbackSummary`, unless one exists by now.
    pub fn write_fallback_summary(&self, slug: &str, hid: &str) {
        let Some(h) = self.load(slug, hid) else { return };
        if self.ticket(slug, s(&h, "hostTicket")).is_none() {
            return;
        }
        let dir = self.outputs_dir(slug, s(&h, "hostTicket"));
        let file = dir.join(summary_file(hid));
        if file.exists() {
            return;
        }
        let outputs = list_outputs(&dir);
        let text = fallback_summary(&h, &self.files.messages(slug, hid), &outputs);
        let r = file.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).and_then(|_| std::fs::write(&file, text));
        if let Err(e) = r {
            eprintln!("huddle {hid}: couldn't write its summary: {e}");
            return;
        }
        self.touch(slug, hid);
    }

    /// `touch`: tell the UI the huddle changed (its summary appeared).
    pub fn touch(&self, slug: &str, hid: &str) {
        if let Some(h) = self.load(slug, hid) {
            self.changed(slug);
            self.emit(json!({ "type": "huddle.updated", "profile": slug, "huddle": self.view(slug, &h) }));
        }
    }

    /// `recover` after a start: huddles whose host is done close; helpers cut off carry on (R11c); everyone gets the
    /// wakes it was owed.
    pub fn recover(&self) {
        let runner = self.runner();
        for slug in self.boards() {
            let open: Vec<Arc<Obj>> = self.files.open(&slug).iter().cloned().collect();
            for h in open {
                let hid = s(&h, "id").to_string();
                if let Some(host) = self.ticket(&slug, s(&h, "hostTicket"))
                    && host.status == "done"
                    && ended_by_done(&h, host.json.get("doneAt").and_then(Value::as_str))
                {
                    let _ = self.close(&slug, &hid, Some("the host ticket moved to Done"), true);
                    continue;
                }
                for p in participants(&h).into_iter().filter(|p| s(p, "kind") == "agent") {
                    let cut = s(p, "status") == "working" || b(p, "interrupted");
                    if s(&h, "status") == "live" && s(p, "status") != "stopped" && cut {
                        runner.recover_agent(self, &slug, &hid, s(p, "handle"));
                    }
                }
                for p in participants(&h).into_iter().filter(|p| s(p, "kind") != "human") {
                    self.wake_if_owed(&slug, &hid, s(p, "handle"));
                }
            }
        }
    }

    // ---- the event bus ----

    /// `ticket.updated`: a host moved to Done closes its huddles; a ticket session's run ended (monitor messages
    /// waiting, a summary owed). Only queues the work: listeners never block.
    fn on_event(self: &Arc<Self>, e: &Arc<crate::bus::BusEvent>) {
        if e.ty != "ticket.updated" || self.shutting_down.load(Ordering::Relaxed) {
            return;
        }
        let (Some(slug), Some(t)) = (e.body.get("profile").and_then(Value::as_str), e.body.get("ticket").and_then(Value::as_object)) else { return };
        let id = s(t, "id").to_string();
        let done = s(t, "status") == "done";
        let me = self.clone();
        let slug = slug.to_string();
        let queued = t.get("queued").and_then(Value::as_array).is_some_and(|q| q.iter().any(|m| m.get("state").and_then(Value::as_str) == Some("queued")));
        let interesting = done || !self.main_pending.lock().is_empty() || !self.summary_owed.lock().is_empty();
        if !interesting {
            return;
        }
        let done_at = opt_s(t, "doneAt").map(str::to_string);
        spawn_blocking(move || {
            me.op(|me| {
                if done && me.files.open(&slug).iter().any(|h| s(h, "hostTicket") == id && ended_by_done(h, done_at.as_deref())) {
                    me.close_for_ticket(&slug, &id, "the host ticket moved to Done");
                }
                if !me.is_ticket_running(&slug, &id) {
                    let owed: Vec<String> = me.summary_owed.lock().iter().filter(|k| k.starts_with(&format!("{slug}/"))).cloned().collect();
                    for key in owed {
                        let hid = key[slug.len() + 1..].to_string();
                        let h = me.load(&slug, &hid);
                        if h.as_ref().is_some_and(|h| s(h, "hostTicket") != id) || queued {
                            continue;
                        }
                        me.summary_owed.lock().remove(&key);
                        if h.is_some() {
                            me.write_fallback_summary(&slug, &hid);
                        }
                    }
                    let pend: Vec<String> = me.main_pending.lock().iter().filter(|k| k.starts_with(&format!("{slug}/"))).cloned().collect();
                    for key in pend {
                        let mut it = key.splitn(3, '/');
                        let (_, hid, handle) = (it.next(), it.next().unwrap_or(""), it.next().unwrap_or(""));
                        let Some(h) = me.load(&slug, hid) else { continue };
                        if participant(&h, handle).is_none_or(|p| opt_s(p, "ticketId") != Some(id.as_str())) {
                            continue;
                        }
                        me.main_pending.lock().remove(&key);
                        me.deliver_now(&slug, hid, handle);
                    }
                }
            });
        });
    }

    fn self_ref(&self) -> Option<std::sync::Weak<Huddles>> {
        Some(self.me.clone())
    }
}

/// `{k: v, ...}` in order.
pub fn obj<const N: usize>(kv: [(&str, Value); N]) -> Obj {
    kv.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// `ticketTopic`.
fn ticket_topic(title: &str, body: &str) -> String {
    let body = squash(body);
    let title = js::trim(title);
    if body.is_empty() {
        return title.to_string();
    }
    let shown = if js::len16(&body) > 600 { format!("{}…", js::slice16(&body, 600)) } else { body };
    format!("{title} (from the ticket: {shown})")
}

/// `claudeSessionExists`: the transcript is somewhere under Claude's projects folder.
fn session_exists(sid: &str) -> bool {
    let projects = ckanban_core::home::home_dir().join(".claude").join("projects");
    let Ok(rd) = std::fs::read_dir(projects) else { return false };
    rd.flatten().any(|d| d.path().join(format!("{sid}.jsonl")).exists())
}

/// The names of the files in an outputs folder, relative to it (a walk bounded like `listOutputs`).
fn list_outputs(dir: &Path) -> Vec<String> {
    const MAX: usize = 500;
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if copies::COPY_SKIP.contains(&name.as_str()) {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file()
                && let Ok(rel) = e.path().strip_prefix(dir)
            {
                out.push(rel.to_string_lossy().into_owned());
                if out.len() >= MAX {
                    return out;
                }
            }
        }
    }
    out
}

fn spawn(f: impl std::future::Future<Output = ()> + Send + 'static) {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn(f);
        }
        Err(_) => eprintln!("huddles: no runtime for background work"),
    }
}

fn spawn_blocking(f: impl FnOnce() + Send + 'static) {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn_blocking(f);
        }
        Err(_) => {
            std::thread::spawn(f);
        }
    }
}

impl crate::api::HuddleInfo for Huddles {
    fn host_states(&self, slug: &str) -> BTreeMap<String, Value> {
        (*Huddles::host_states(self, slug)).clone()
    }
    fn restart_busy(&self) -> Vec<String> {
        self.runner().busy_boards().into_iter().map(|b| format!("a huddle helper on board {b}")).collect()
    }
    fn ticket_spend(&self, slug: &str, id: &str) -> f64 {
        Huddles::ticket_spend(self, slug, id)
    }
    fn teammates(&self, slug: &str, id: &str) -> Vec<(String, String)> {
        Huddles::teammates(self, slug, id)
    }
}

/// A huddle's proposed squad saved from the team routes (`POST /squads` with a learning).
impl crate::team::LearningCards for Huddles {
    fn check(&self, slug: &str, hid: &str, lid: &str) -> Result<(), Fail> {
        Huddles::learning(&self.get(slug, hid)?, lid, false).map(|_| ())
    }
    fn mark_saved(&self, slug: &str, hid: &str, lid: &str, target: &str, scope: &str) -> Result<(), String> {
        self.set_learning(slug, hid, lid, obj([("status", "saved".into()), ("target", target.into()), ("scope", scope.into())])).map_err(|e| e.message)
    }
}
