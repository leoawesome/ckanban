//! The Connections window's MCP servers (`/api/mcp*`), ported from `McpManager` in `src/integrations/mcp.ts`, the
//! boards' "only this board" tools (`board-tools.ts`) and the routes in `src/api/connections.ts`.
//!
//! A cached view of `claude mcp list` (refreshed at start and every 10 minutes; one run at a time, a call during a run
//! queues one more), with what a probe session reports put over it, plus the boards' own tools; the actions behind
//! the window run `claude mcp ...`. Every change emits `mcp.updated` with the whole state, as Bun does. Files:
//! `mcp-seen.json` (servers that once worked: "needs auth" there counts for the header badge),
//! `claude-ai-connectors.json` (the account's claude.ai connectors, for runs right after a restart) and each board's
//! `board-tools.json` (owner-only: it can hold secrets).
//!
//! The routes have no user-only check, as in Bun (`connections.test.ts` keeps that quirk).

#![allow(dead_code)]

pub mod parse;
pub mod proc;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ckanban_core::DataDir;
use ckanban_core::time::{iso, now_ms};
use parking_lot::Mutex;
use serde_json::{Value, json};

use self::parse::*;
use self::proc::{LoginProc, OnOutput};
use super::{Answer, Call, Emit};
use crate::mask::mask_secrets;

pub struct McpOptions {
    pub claude_bin: String,
    /// Where commands run; project and local servers are read for this folder (the home folder).
    pub cwd: PathBuf,
    /// Claude's global config: `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`.
    pub config_file: PathBuf,
    pub seen_file: Option<PathBuf>,
    pub connectors_file: Option<PathBuf>,
    /// The data folder: its boards (and their `board-tools.json`) and `signin/`, where sign-ins to board-only tools run.
    pub data_root: PathBuf,
    pub list_timeout: Duration,
    pub probe_timeout: Duration,
    pub login_timeout: Duration,
    pub login_poll: Duration,
    pub login_poll_for: Duration,
    pub refresh_every: Duration,
}

impl McpOptions {
    /// Bun's defaults (`daemon.ts`): `CKANBAN_CLAUDE_BIN` or `claude`, the home folder, the data folder's files.
    pub fn new(data_root: &Path) -> Self {
        let home = ckanban_core::home::home_dir();
        let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.clone());
        McpOptions {
            claude_bin: std::env::var("CKANBAN_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()),
            cwd: home,
            config_file: config_dir.join(".claude.json"),
            seen_file: Some(data_root.join("mcp-seen.json")),
            connectors_file: Some(data_root.join("claude-ai-connectors.json")),
            data_root: data_root.to_path_buf(),
            list_timeout: Duration::from_secs(120),
            probe_timeout: Duration::from_secs(60),
            login_timeout: Duration::from_secs(600),
            login_poll: Duration::from_secs(5),
            login_poll_for: Duration::from_secs(300),
            refresh_every: Duration::from_secs(600),
        }
    }
}

#[derive(Clone)]
struct Login {
    id: u64,
    state: &'static str,
    url: Option<String>,
    error: Option<String>,
    started_at: String,
    claude_ai: bool,
    can_paste: bool,
}

impl Login {
    fn json(&self) -> Value {
        json!({ "state": self.state, "url": self.url, "error": self.error, "startedAt": self.started_at, "claudeAi": self.claude_ai, "canPaste": self.can_paste })
    }
}

/// A move whose second step failed: the tool is in both places until "Try again" removes the old copy.
enum Leftover {
    User(String),
    Boards(Vec<String>, String),
}

impl Leftover {
    fn reason(&self) -> &str {
        match self {
            Leftover::User(r) | Leftover::Boards(_, r) => r,
        }
    }
}

#[derive(Default)]
struct Inner {
    servers: Vec<Obj>,
    unparsed: Vec<String>,
    checked_at: Option<String>,
    error: Option<String>,
    inflight: bool,
    again: bool,
    /// Servers added, edited or removed while the current `claude mcp list` ran: its older output doesn't overwrite them.
    touched: HashSet<String>,
    logins: HashMap<String, Login>,
    procs: HashMap<String, (u64, Arc<LoginProc>)>,
    seen: BTreeSet<String>,
    /// Board-only tools' statuses, from the probe session (`claude mcp list` doesn't know them).
    board_status: HashMap<String, (String, Option<String>)>,
    leftovers: HashMap<String, Leftover>,
    next_login: u64,
}

/// One board that has a board-only tool.
#[derive(Clone)]
struct OnBoard {
    slug: String,
    name: Value,
    entry: Obj,
}

type Groups = Vec<(String, Vec<OnBoard>)>;

fn group<'a>(g: &'a Groups, name: &str) -> Option<&'a Vec<OnBoard>> {
    g.iter().find(|(n, _)| n == name).map(|(_, v)| v)
}

fn no_extra(o: &mut Obj) {
    o.insert("boards".into(), json!([]));
    o.insert("move".into(), json!({ "can": false, "why": null }));
    o.insert("leftover".into(), Value::Null);
}

type R<T> = Result<T, McpError>;

pub struct Mcp {
    o: McpOptions,
    emit: Emit,
    inner: Mutex<Inner>,
}

impl Mcp {
    pub fn new(o: McpOptions, emit: Emit) -> Arc<Mcp> {
        let mut inner = Inner::default();
        if let Some(Value::Array(a)) = o.seen_file.as_deref().and_then(read_json) {
            inner.seen = a.iter().filter_map(Value::as_str).map(str::to_string).collect();
        }
        if let Some(Value::Array(a)) = o.connectors_file.as_deref().and_then(read_json) {
            let names: Vec<String> = a.iter().filter_map(Value::as_str).map(str::to_string).collect();
            ckanban_board::runs::connectors::set_known_connectors(Some(&names));
        }
        Arc::new(Mcp { o, emit, inner: Mutex::new(inner) })
    }

    /// Refresh now and every 10 minutes.
    pub fn start(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        let every = self.o.refresh_every;
        tokio::spawn(async move {
            loop {
                let Some(m) = me.upgrade() else { return };
                m.refresh();
                drop(m);
                tokio::time::sleep(every).await;
            }
        });
    }

    // ----- state -----

    pub fn state(&self) -> Value {
        let servers = self.all();
        let i = self.inner.lock();
        let servers: Vec<Value> = servers
            .into_iter()
            .map(|mut s| {
                let login = i.logins.get(self::parse::s(&s, "name")).map(Login::json).unwrap_or(Value::Null);
                s.insert("login".into(), login);
                Value::Object(s)
            })
            .collect();
        json!({ "servers": servers, "unparsed": i.unparsed, "checkedAt": i.checked_at, "checking": i.inflight, "error": i.error })
    }

    /// Whether any server (Claude's or a board's) is connected: the helper's check-in offer.
    pub fn any_connected(&self) -> bool {
        self.all().iter().any(|s| self::parse::s(s, "status") == "connected")
    }

    /// `attentionCount`.
    pub fn attention_count(&self) -> usize {
        self.inner.lock().servers.iter().filter(|s| s.get("attention") == Some(&Value::Bool(true))).count()
    }

    fn emit(&self) {
        (self.emit)(json!({ "type": "mcp.updated", "state": self.state() }));
    }

    /// Every board-only tool by name, with the boards that have it (first board's entry first).
    fn board_groups(&self) -> Groups {
        let mut out: Groups = Vec::new();
        for (slug, name) in self.boards() {
            for (tool, entry) in read_board_tools(&self.tools_file(&slug)) {
                if tool == OWN {
                    continue;
                }
                let Value::Object(entry) = entry else { continue };
                let b = OnBoard { slug: slug.clone(), name: name.clone(), entry };
                match out.iter_mut().find(|(n, _)| *n == tool) {
                    Some((_, v)) => v.push(b),
                    None => out.push((tool, vec![b])),
                }
            }
        }
        out
    }

    /// `store.listProfiles()`: (slug, name) oldest first.
    fn boards(&self) -> Vec<(String, Value)> {
        DataDir::new(self.o.data_root.clone())
            .list_profiles()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|p| Some((p.slug()?.to_string(), p.name())))
            .collect()
    }

    fn tools_file(&self, slug: &str) -> PathBuf {
        DataDir::new(self.o.data_root.clone()).profile_dir(slug).join("board-tools.json")
    }

    fn read_tools(&self, slug: &str) -> Obj {
        read_board_tools(&self.tools_file(slug))
    }

    fn write_tools(&self, slug: &str, servers: &Obj) -> R<()> {
        write_board_tools(&self.tools_file(slug), servers).map_err(|e| McpError::new(500, e.to_string()))
    }

    /// Claude's own servers plus the boards' tools, each with its reach, move state and leftover.
    fn all(&self) -> Vec<Obj> {
        let groups = self.board_groups();
        let user = read_json(&self.o.config_file).and_then(|c| c.get("mcpServers").cloned()).unwrap_or(Value::Null);
        let i = self.inner.lock();
        let leftover = |name: &str| i.leftovers.get(name).map(|l| json!(l.reason())).unwrap_or(Value::Null);
        let boards_of = |g: &[OnBoard]| Value::Array(g.iter().map(|b| json!({ "slug": b.slug, "name": b.name })).collect());
        let mut out: Vec<Obj> = i
            .servers
            .iter()
            .map(|s0| {
                let mut o = s0.clone();
                let name = s(s0, "name").to_string();
                let movable = s(s0, "scope") == "user" && name != OWN;
                let mv = if !movable {
                    json!({ "can": false, "why": null })
                } else if movable_input(&name, user.get(&name).and_then(Value::as_object)).is_some() {
                    json!({ "can": true, "why": null })
                } else {
                    json!({ "can": false, "why": CANT_READ })
                };
                o.insert("boards".into(), group(&groups, &name).map(|g| boards_of(g)).unwrap_or(json!([])));
                o.insert("move".into(), mv);
                o.insert("leftover".into(), leftover(&name));
                o
            })
            .collect();
        for (name, g) in &groups {
            if i.servers.iter().any(|x| s(x, "name") == name) {
                continue;
            }
            let input = input_from_entry(name, &g[0].entry);
            let target = match &input {
                None => String::new(),
                Some(inp) if inp["transport"] == "stdio" => {
                    let mut parts = vec![inp["command"].as_str().unwrap_or("").to_string()];
                    parts.extend(inp["args"].as_array().into_iter().flatten().map(crate::js::string));
                    parts.join(" ")
                }
                Some(inp) => inp["url"].as_str().unwrap_or("").to_string(),
            };
            let (status, message) = i.board_status.get(name).cloned().unwrap_or_else(|| ("unknown".into(), None));
            let mv = if movable_input(name, Some(&g[0].entry)).is_some() { json!({ "can": true, "why": null }) } else { json!({ "can": false, "why": CANT_READ }) };
            let mut o = Obj::new();
            o.insert("name".into(), json!(name));
            o.insert("target".into(), json!(mask_secrets(&target)));
            o.insert("transport".into(), input.as_ref().map(|x| x["transport"].clone()).unwrap_or(Value::Null));
            o.insert("scope".into(), json!("board"));
            o.insert("attention".into(), json!(status == "failed"));
            // Bun's key order: ...st (status, message) come before attention.
            let attention = o.remove("attention").unwrap();
            o.insert("status".into(), json!(status));
            o.insert("message".into(), json!(message));
            o.insert("attention".into(), attention);
            o.insert("login".into(), Value::Null);
            o.insert("boards".into(), boards_of(g));
            o.insert("move".into(), mv);
            o.insert("leftover".into(), leftover(name));
            out.push(o);
        }
        out
    }

    fn find(&self, name: &str) -> R<Obj> {
        self.all().into_iter().find(|x| s(x, "name") == name).ok_or_else(|| McpError::new(404, format!("no MCP server named \"{name}\"")))
    }

    fn has_server(&self, name: &str) -> bool {
        self.inner.lock().servers.iter().any(|x| s(x, "name") == name)
    }

    /// `decorate`: remembers servers that worked; attention = failed, or needs auth after having worked.
    fn decorate(i: &mut Inner, mut o: Obj) -> Obj {
        let (name, status) = (s(&o, "name").to_string(), s(&o, "status").to_string());
        if status == "connected" {
            i.seen.insert(name.clone());
        }
        let attention = status == "failed" || (status == "needs_auth" && i.seen.contains(&name));
        o.insert("attention".into(), json!(attention));
        o
    }

    fn save_seen(&self) {
        let Some(f) = &self.o.seen_file else { return };
        let mut list: Vec<String> = self.inner.lock().seen.iter().cloned().collect();
        list.sort_by(|a, b| ckanban_board::runs::js::cmp16(a, b));
        let _ = std::fs::write(f, serde_json::to_string(&list).unwrap_or_else(|_| "[]".into()));
    }

    /// Boards' runs hide the connectors their board turned off by name, so they need the current list.
    fn note_connectors(&self) {
        let names: Vec<String> = self.inner.lock().servers.iter().filter(|x| s(x, "scope") == "claude.ai").map(|x| s(x, "name").to_string()).collect();
        ckanban_board::runs::connectors::set_known_connectors(Some(&names));
        let Some(f) = &self.o.connectors_file else { return };
        let known = ckanban_board::runs::connectors::known_connectors().unwrap_or_default();
        let _ = std::fs::write(f, serde_json::to_string(&known).unwrap_or_else(|_| "[]".into()));
    }

    fn note_board_statuses(&self, session: Option<&Session>) {
        let Some(session) = session else { return };
        let groups = self.board_groups();
        let mut i = self.inner.lock();
        for (name, _) in &groups {
            let Some(status) = session_get(Some(session), name) else { continue };
            let message = match status {
                "needs_auth" => Some("Needs a sign-in".to_string()),
                "failed" => Some("Couldn't start or connect".to_string()),
                _ => None,
            };
            i.board_status.insert(name.clone(), (status.to_string(), message));
        }
    }

    /// Union of the boards' tools, for the probe session (one entry per name). None when there are none.
    fn probe_config(&self) -> Option<String> {
        let groups = self.board_groups();
        if groups.is_empty() {
            return None;
        }
        let servers: Obj = groups.into_iter().map(|(n, g)| (n, Value::Object(g[0].entry.clone()))).collect();
        Some(ckanban_core::datafile::to_text(&json!({ "mcpServers": servers }), ckanban_core::datafile::Layout::Compact))
    }

    async fn run(&self, args: &[&str], timeout: Duration, on: Option<OnOutput>, cwd: Option<&Path>) -> RunOut {
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        proc::run(&self.o.claude_bin, &args, timeout, cwd.unwrap_or(&self.o.cwd), on).await
    }

    async fn run_owned(&self, args: Vec<String>, timeout: Duration, cwd: Option<&Path>) -> RunOut {
        proc::run(&self.o.claude_bin, &args, timeout, cwd.unwrap_or(&self.o.cwd), None).await
    }

    async fn session_statuses(&self) -> Option<Session> {
        proc::session_statuses(&self.o.claude_bin, &self.o.cwd, self.probe_config(), self.o.probe_timeout).await
    }

    // ----- refresh -----

    /// Re-runs `claude mcp list` in the background. A call during a run queues one more.
    pub fn refresh(self: &Arc<Self>) {
        {
            let mut i = self.inner.lock();
            if i.inflight {
                i.again = true;
                return;
            }
            i.inflight = true;
        }
        self.emit();
        let me = self.clone();
        tokio::spawn(async move {
            loop {
                me.do_refresh().await;
                let again = {
                    let mut i = me.inner.lock();
                    let again = std::mem::take(&mut i.again);
                    if !again {
                        i.inflight = false;
                    }
                    again
                };
                // Bun: the finished run's emit comes after the next one started (its own emit) when one was queued.
                me.emit();
                if !again {
                    return;
                }
                me.emit();
            }
        });
    }

    async fn do_refresh(&self) {
        self.inner.lock().touched = HashSet::new();
        let (r, session) = tokio::join!(self.run(&["mcp", "list"], self.o.list_timeout, None, None), self.session_statuses());
        if r.code != 0 {
            self.inner.lock().error = Some(error_text(&r, "claude mcp list", &[]));
            return;
        }
        let (servers, unparsed) = parse_mcp_list(&r.stdout);
        let scopes = config_scopes(&self.o.cwd, &self.o.config_file);
        {
            let mut i = self.inner.lock();
            let mut next: Vec<Obj> = servers
                .into_iter()
                .map(|mut o| {
                    let scope = scope_of(s(&o, "name"), &scopes);
                    o.insert("scope".into(), json!(scope));
                    o.insert("attention".into(), json!(false));
                    o.insert("login".into(), Value::Null);
                    no_extra(&mut o);
                    let o = apply_session_status(o, session.as_ref());
                    Self::decorate(&mut i, o)
                })
                .collect();
            let touched: Vec<String> = i.touched.iter().cloned().collect();
            for name in touched {
                let now = i.servers.iter().find(|x| s(x, "name") == name).cloned();
                next.retain(|x| s(x, "name") != name);
                if let Some(now) = now {
                    next.push(now);
                }
            }
            i.servers = next;
            i.unparsed = unparsed;
        }
        self.note_board_statuses(session.as_ref());
        {
            let mut i = self.inner.lock();
            i.checked_at = Some(iso(now_ms()));
            i.error = None;
        }
        self.save_seen();
        self.note_connectors();
    }

    // ----- checks -----

    /// `recheck`: one server again (`claude mcp get`, or a probe session for connectors and board tools).
    pub async fn recheck(&self, name: &str) -> Option<Obj> {
        let scope = self.inner.lock().servers.iter().find(|x| s(x, "name") == name).map(|x| s(x, "scope").to_string());
        if scope.as_deref() == Some("claude.ai") {
            return self.recheck_connector(name).await;
        }
        if scope.is_none() && group(&self.board_groups(), name).is_some() {
            let session = self.session_statuses().await;
            session_get(session.as_ref(), name)?;
            self.note_board_statuses(session.as_ref());
            self.emit();
            return self.all().into_iter().find(|x| s(x, "name") == name);
        }
        let r = self.run(&["mcp", "get", name], Duration::from_secs(60), None, None).await;
        let parsed = if r.code == 0 { parse_mcp_get(&r.stdout) } else { None };
        let out = {
            let mut i = self.inner.lock();
            let idx = i.servers.iter().position(|x| s(x, "name") == name)?;
            let (status, message) = parsed?;
            let mut o = i.servers[idx].clone();
            o.insert("status".into(), json!(status));
            o.insert("message".into(), json!(message));
            let o = Self::decorate(&mut i, o);
            i.servers[idx] = o.clone();
            o
        };
        self.save_seen();
        self.emit();
        Some(out)
    }

    async fn recheck_connector(&self, name: &str) -> Option<Obj> {
        let session = self.session_statuses().await;
        let out = {
            let mut i = self.inner.lock();
            let idx = i.servers.iter().position(|x| s(x, "name") == name)?;
            session_get(session.as_ref(), name)?;
            let o = apply_session_status(i.servers[idx].clone(), session.as_ref());
            let o = Self::decorate(&mut i, o);
            i.servers[idx] = o.clone();
            o
        };
        self.save_seen();
        self.emit();
        Some(out)
    }

    // ----- settings -----

    /// `config`: saved settings of one server (unmasked), for the edit form.
    pub fn config(&self, name: &str, board: Option<&str>) -> R<Value> {
        let srv = self.find(name)?;
        let board = board.filter(|b| !b.is_empty());
        if s(&srv, "scope") == "board" || board.is_some() {
            let groups = self.board_groups();
            let g = group(&groups, name).cloned().unwrap_or_default();
            let e = match board {
                Some(b) => g.iter().find(|x| x.slug == b),
                None => g.first(),
            };
            let input = e.and_then(|e| input_from_entry(name, &e.entry));
            let Some(Value::Object(mut input)) = input else {
                return Err(McpError::new(404, format!("The board can't read back how {name} was set up, so it can't be edited here")));
            };
            let line = if input["transport"] == "stdio" {
                let args: Vec<String> = input["args"].as_array().into_iter().flatten().map(crate::js::string).collect();
                let env: Vec<(String, String)> = input["env"].as_array().into_iter().flatten().map(|e| (jstr(e.get("key")), jstr(e.get("value")))).collect();
                json!(command_line_of(input["command"].as_str().unwrap_or(""), &args, &env))
            } else {
                Value::Null
            };
            input.insert("scope".into(), json!("board"));
            input.insert("commandLine".into(), line);
            return Ok(Value::Object(input));
        }
        read_mcp_config(name, &self.o.cwd, &self.o.config_file).ok_or_else(|| McpError::new(404, format!("{name} isn't in Claude's config files, so it can't be edited here")))
    }

    /// `update`: replaces a user-scope server (remove, then add; the old one is put back if the add fails).
    pub async fn update(self: &Arc<Self>, name: &str, input: &Value) -> R<()> {
        if let Some(b) = board_of(input) {
            return self.update_on_board(name, input, &b);
        }
        let srv = self.find(name)?;
        if s(&srv, "scope") != "user" {
            return Err(McpError::new(400, format!("{name} isn't a user-scope server; edit it where it's configured")));
        }
        let args = add_args(input)?;
        let next = crate::js::trim(&jstr(input.get("name"))).to_string();
        if next != name && self.has_server(&next) {
            return Err(McpError::new(409, format!("a server named \"{next}\" already exists")));
        }
        let old = read_mcp_config(name, &self.o.cwd, &self.o.config_file);
        let rm = self.run(&["mcp", "remove", name, "--scope", "user"], Duration::from_secs(60), None, None).await;
        if rm.code != 0 {
            return Err(McpError::new(502, error_text(&rm, "claude mcp remove", &[])));
        }
        let r = self.run_owned(args, Duration::from_secs(60), None).await;
        if r.code != 0 {
            if let Some(old_args) = old.as_ref().and_then(|o| add_args(o).ok()) {
                let _ = self.run_owned(old_args, Duration::from_secs(60), None).await;
            }
            self.refresh();
            return Err(McpError::new(502, error_text(&r, "claude mcp add", &[])));
        }
        {
            let mut i = self.inner.lock();
            i.logins.remove(name);
            if next != name {
                i.servers.retain(|x| s(x, "name") != name);
                i.touched.insert(name.to_string());
            }
        }
        self.show(input).await;
        self.refresh();
        Ok(())
    }

    /// `show`: puts a server just added or edited in the list with a quick `claude mcp get`.
    async fn show(&self, input: &Value) {
        let name = crate::js::trim(&jstr(input.get("name"))).to_string();
        let r = self.run(&["mcp", "get", &name], Duration::from_secs(30), None, None).await;
        let parsed = if r.code == 0 { parse_mcp_get(&r.stdout) } else { None };
        let transport = input.get("transport").cloned().unwrap_or(Value::Null);
        let target = if transport == "stdio" {
            let mut parts = vec![crate::js::trim(&jstr_or(input.get("command"), "")).to_string()];
            parts.extend(input.get("args").and_then(Value::as_array).into_iter().flatten().map(|a| if a.is_null() { String::new() } else { crate::js::string(a) }));
            parts.join(" ")
        } else {
            crate::js::trim(&jstr_or(input.get("url"), "")).to_string()
        };
        {
            let mut i = self.inner.lock();
            let mut o = Obj::new();
            o.insert("name".into(), json!(name));
            o.insert("target".into(), json!(mask_secrets(&target)));
            o.insert("transport".into(), transport);
            o.insert("scope".into(), json!("user"));
            o.insert("status".into(), json!(parsed.as_ref().map(|p| p.0).unwrap_or("unknown")));
            o.insert("message".into(), json!(parsed.and_then(|p| p.1)));
            o.insert("attention".into(), json!(false));
            o.insert("login".into(), Value::Null);
            no_extra(&mut o);
            let o = Self::decorate(&mut i, o);
            match i.servers.iter().position(|x| s(x, "name") == name) {
                Some(idx) => i.servers[idx] = o,
                None => i.servers.push(o),
            }
            i.touched.insert(name);
        }
        self.save_seen();
        self.emit();
    }

    // ----- sign-in -----

    /// `login`: starts signing in and returns at once (the CLI runs with --no-browser; the board opens the link).
    pub fn login(self: &Arc<Self>, name: &str) -> R<()> {
        let srv = self.find(name)?;
        let transport = srv.get("transport").and_then(Value::as_str).map(str::to_string);
        if !can_login(transport.as_deref(), s(&srv, "scope")) {
            return Err(McpError::new(400, format!("{name} doesn't use OAuth, so there's nothing to log in to")));
        }
        let claude_ai = s(&srv, "scope") == "claude.ai";
        let id = {
            let mut i = self.inner.lock();
            if i.logins.get(name).is_some_and(|l| l.state == "waiting") {
                return Err(McpError::new(409, format!("already logging in to {name}")));
            }
            i.next_login += 1;
            let id = i.next_login;
            i.logins.insert(name.to_string(), Login { id, state: "waiting", url: None, error: None, started_at: iso(now_ms()), claude_ai, can_paste: false });
            id
        };
        self.emit();
        let me = self.clone();
        let name = name.to_string();
        let was_connected = s(&srv, "status") == "connected";
        let board = s(&srv, "scope") == "board";
        tokio::spawn(async move {
            if let Err(e) = me.login_flow(&name, id, claude_ai, was_connected, board).await {
                me.login_failed(&name, id, claude_ai, e).await;
            }
        });
        Ok(())
    }

    fn current(&self, name: &str, id: u64) -> bool {
        self.inner.lock().logins.get(name).is_some_and(|l| l.id == id)
    }

    fn login_url(&self, name: &str, id: u64) -> Option<String> {
        self.inner.lock().logins.get(name).filter(|l| l.id == id).and_then(|l| l.url.clone())
    }

    async fn login_failed(&self, name: &str, id: u64, claude_ai: bool, error: String) {
        {
            let mut i = self.inner.lock();
            let Some(l) = i.logins.get_mut(name).filter(|l| l.id == id) else { return };
            l.state = "failed";
            l.error = Some(error);
            l.can_paste = false;
        }
        self.emit();
        // An OAuth login deletes the old one before it starts: show what's left, not the stale "Connected".
        if !claude_ai {
            let _ = self.recheck(name).await;
        }
    }

    fn on_output(self: &Arc<Self>, name: &str, id: u64) -> OnOutput {
        let me = Arc::downgrade(self);
        let name = name.to_string();
        Arc::new(move |out: &str| {
            let Some(me) = me.upgrade() else { return };
            let Some(url) = find_url(out) else { return };
            let changed = {
                let mut i = me.inner.lock();
                match i.logins.get_mut(&name).filter(|l| l.id == id) {
                    Some(l) if l.url.as_deref() != Some(url.as_str()) => {
                        l.url = Some(url);
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                me.emit();
            }
        })
    }

    async fn login_flow(self: &Arc<Self>, name: &str, id: u64, claude_ai: bool, was_connected: bool, board: bool) -> Result<(), String> {
        let on = self.on_output(name, id);
        if claude_ai {
            let r = self.run(&["mcp", "login", name, "--no-browser"], Duration::from_secs(60), Some(on), None).await;
            if !self.current(name, id) {
                return Ok(());
            }
            if r.code != 0 {
                return Err(error_text(&r, "claude mcp login", &[]));
            }
            if self.login_url(name, id).is_none() {
                return Err("claude mcp login didn't print a sign-in link".into());
            }
            let until = now_ms() + self.o.login_timeout.as_millis() as f64;
            while self.current(name, id) && now_ms() < until {
                if !was_connected {
                    match self.recheck(name).await {
                        Some(now) if s(&now, "status") != "connected" => {}
                        _ => break,
                    }
                }
                tokio::time::sleep(self.o.login_poll).await;
            }
        } else {
            let copy = if board { Some(self.local_copy(name).await.map_err(|e| e.1)?) } else { None };
            let r = self.run_login(name, id, on, copy.as_ref().map(|c| c.0.as_path())).await;
            if let Some((cwd, entry_name)) = &copy {
                let _ = self.run(&["mcp", "remove", entry_name, "--scope", "local"], Duration::from_secs(30), None, Some(cwd)).await;
            }
            if !self.current(name, id) {
                return Ok(());
            }
            if r.code != 0 {
                return Err(if r.timed_out { "Sign-in timed out".into() } else { error_text(&r, "claude mcp login", &[]) });
            }
            if let Some(l) = self.inner.lock().logins.get_mut(name).filter(|l| l.id == id) {
                l.can_paste = false;
            }
            self.emit();
            let until = now_ms() + self.o.login_poll_for.as_millis() as f64;
            while self.current(name, id) {
                match self.recheck(name).await {
                    Some(now) if s(&now, "status") != "connected" && now_ms() <= until => {}
                    _ => break,
                }
                tokio::time::sleep(self.o.login_poll).await;
            }
        }
        let still = {
            let mut i = self.inner.lock();
            let cur = i.logins.get(name).is_some_and(|l| l.id == id);
            if cur {
                i.logins.remove(name);
            }
            cur
        };
        let _ = still;
        self.emit();
        Ok(())
    }

    /// `runLogin`: on a terminal (pipes where there is none).
    async fn run_login(self: &Arc<Self>, name: &str, id: u64, on: OnOutput, cwd: Option<&Path>) -> RunOut {
        let cwd = cwd.unwrap_or(&self.o.cwd).to_path_buf();
        let me = self.clone();
        let started_name = name.to_string();
        let r = proc::run_login(&self.o.claude_bin, name, &cwd, self.o.login_timeout, on.clone(), move |p| {
            {
                let mut i = me.inner.lock();
                i.procs.insert(started_name.clone(), (id, p));
                if let Some(l) = i.logins.get_mut(&started_name).filter(|l| l.id == id) {
                    l.can_paste = true;
                }
            }
            me.emit();
        })
        .await;
        {
            let mut i = self.inner.lock();
            if i.procs.get(name).is_some_and(|(pid, _)| *pid == id) {
                i.procs.remove(name);
            }
        }
        match r {
            Some(r) => r,
            None => self.run(&["mcp", "login", name, "--no-browser"], self.o.login_timeout, Some(on), Some(&cwd)).await,
        }
    }

    /// `paste`: types the address the sign-in page ended on into a waiting OAuth login.
    pub fn paste(&self, name: &str, text: &str) -> R<()> {
        let t = crate::js::trim(text);
        static OK: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^https?://[\x21-\x7e]+$").unwrap());
        if t.encode_utf16().count() > 4096 || !OK.is_match(t) {
            return Err(McpError::new(400, "paste the full address from the browser, starting with http"));
        }
        let proc = {
            let i = self.inner.lock();
            let waiting = i.logins.get(name).is_some_and(|l| l.state == "waiting");
            i.procs.get(name).filter(|_| waiting).map(|(_, p)| p.clone())
        };
        let Some(proc) = proc else { return Err(McpError::new(409, format!("not signing in to {name} right now"))) };
        proc.write(&format!("{t}\r"));
        Ok(())
    }

    /// `cancelLogin`: stops a login, then re-checks (the old login may be gone already).
    pub fn cancel_login(self: &Arc<Self>, name: &str) {
        let (was, proc) = {
            let mut i = self.inner.lock();
            (i.logins.remove(name), i.procs.remove(name))
        };
        if let Some((_, p)) = proc {
            p.kill();
        }
        self.emit();
        if was.is_some_and(|w| !w.claude_ai) {
            let me = self.clone();
            let name = name.to_string();
            tokio::spawn(async move {
                let _ = me.recheck(&name).await;
            });
        }
    }

    pub async fn logout(&self, name: &str) -> R<()> {
        let srv = self.find(name)?;
        if !can_login(srv.get("transport").and_then(Value::as_str), s(&srv, "scope")) {
            return Err(McpError::new(400, format!("{name} doesn't use OAuth")));
        }
        let copy = if s(&srv, "scope") == "board" { Some(self.local_copy(name).await?) } else { None };
        let r = self.run(&["mcp", "logout", name], Duration::from_secs(60), None, copy.as_ref().map(|c| c.0.as_path())).await;
        if let Some((cwd, n)) = &copy {
            let _ = self.run(&["mcp", "remove", n, "--scope", "local"], Duration::from_secs(30), None, Some(cwd)).await;
        }
        if r.code != 0 {
            return Err(McpError::new(502, error_text(&r, "claude mcp logout", &[])));
        }
        self.inner.lock().logins.remove(name);
        self.recheck(name).await;
        Ok(())
    }

    /// `localCopy`: a board-only tool added for the board-owned `signin/` folder (local scope), so `claude mcp
    /// login|logout` know it there. Gives (that folder, name); the caller removes it afterwards.
    async fn local_copy(&self, name: &str) -> R<(PathBuf, String)> {
        let groups = self.board_groups();
        let entry = group(&groups, name).and_then(|g| g.first()).map(|b| b.entry.clone());
        let Some(entry) = entry else { return Err(McpError::new(404, format!("No board has a tool called {name}"))) };
        let cwd = self.o.data_root.join("signin");
        let _ = std::fs::create_dir_all(&cwd);
        let _ = self.run(&["mcp", "remove", name, "--scope", "local"], Duration::from_secs(30), None, Some(&cwd)).await;
        let text = ckanban_core::datafile::to_text(&Value::Object(entry.clone()), ckanban_core::datafile::Layout::Compact);
        let r = self.run(&["mcp", "add-json", "--scope", "local", name, &text], Duration::from_secs(60), None, Some(&cwd)).await;
        if r.code != 0 {
            return Err(McpError::new(502, error_text(&r, "claude mcp add-json", &secrets_of(input_from_entry(name, &entry).as_ref()))));
        }
        Ok((cwd, name.to_string()))
    }

    // ----- add, remove, move -----

    pub async fn add(self: &Arc<Self>, input: &Value) -> R<()> {
        let args = add_args(input)?;
        let name = crate::js::trim(&jstr(input.get("name"))).to_string();
        if let Some(b) = board_of(input) {
            let mut input = input.clone();
            input["name"] = json!(name);
            return self.add_to_board(&input, &b);
        }
        if self.has_server(&name) {
            return Err(McpError::new(409, format!("a server named \"{name}\" already exists")));
        }
        if let Some(on) = group(&self.board_groups(), &name) {
            let names: Vec<String> = on.iter().map(|b| crate::js::string(&b.name)).collect();
            return Err(McpError::new(409, format!("A tool called {name} is already on {} only. Use its \"Use in all projects\" button instead.", names.join(", "))));
        }
        let r = self.run_owned(args, Duration::from_secs(60), None).await;
        if r.code != 0 {
            return Err(McpError::new(502, error_text(&r, "claude mcp add", &[])));
        }
        self.show(input).await;
        self.refresh();
        Ok(())
    }

    /// `remove`. `board` is the `?board=` value as given (an empty one stays empty, as in Bun).
    pub async fn remove(self: &Arc<Self>, name: &str, board: Option<&str>) -> R<()> {
        let srv = self.find(name)?;
        if board.is_some_and(|b| !b.is_empty()) || s(&srv, "scope") == "board" {
            let slug = board.map(str::to_string).or_else(|| srv["boards"].get(0).and_then(|b| b.get("slug")).and_then(Value::as_str).map(str::to_string));
            let slug = self.board_source(slug.as_deref())?;
            let mut servers = self.read_tools(&slug);
            if servers.shift_remove(name).is_none() {
                return Err(McpError::new(404, format!("This board has no tool called {name}")));
            }
            self.write_tools(&slug, &servers)?;
            self.forget_board_tool(name);
            self.emit();
            return Ok(());
        }
        if s(&srv, "scope") != "user" {
            return Err(McpError::new(400, format!("{name} isn't a user-scope server; remove it where it's configured")));
        }
        let r = self.run(&["mcp", "remove", name, "--scope", "user"], Duration::from_secs(60), None, None).await;
        if r.code != 0 {
            return Err(McpError::new(502, error_text(&r, "claude mcp remove", &[])));
        }
        {
            let mut i = self.inner.lock();
            i.servers.retain(|x| s(x, "name") != name);
            i.touched.insert(name.to_string());
            i.logins.remove(name);
            i.leftovers.remove(name);
        }
        self.emit();
        self.refresh();
        Ok(())
    }

    /// `boardSource`: the slug, checked to be a board.
    fn board_source(&self, slug: Option<&str>) -> R<String> {
        match slug {
            Some(s) if !s.is_empty() && self.boards().iter().any(|(b, _)| b == s) => Ok(s.to_string()),
            _ => Err(McpError::new(404, format!("board {} not found", slug.unwrap_or("")))),
        }
    }

    fn check_board_name(&self, name: &str) -> R<()> {
        if name == OWN {
            return Err(McpError::new(409, format!("The name {OWN} belongs to the board's own tool. Pick another name.")));
        }
        let user_wide = self.inner.lock().servers.iter().any(|x| s(x, "name") == name && s(x, "scope") != "board");
        if user_wide || user_entry(name, &self.o.config_file).is_some() {
            return Err(McpError::new(409, format!("A tool called {name} is already on for all projects.")));
        }
        Ok(())
    }

    fn forget_board_tool(&self, name: &str) {
        if group(&self.board_groups(), name).is_some() {
            return;
        }
        let mut i = self.inner.lock();
        i.board_status.remove(name);
        i.logins.remove(name);
        if matches!(i.leftovers.get(name), Some(Leftover::Boards(..))) {
            i.leftovers.remove(name);
        }
    }

    fn add_to_board(self: &Arc<Self>, input: &Value, slug: &str) -> R<()> {
        let slug = self.board_source(Some(slug))?;
        let name = jstr(input.get("name"));
        self.check_board_name(&name)?;
        let mut servers = self.read_tools(&slug);
        if servers.contains_key(&name) {
            return Err(McpError::new(409, format!("This board already has a tool called {name}.")));
        }
        servers.insert(name.clone(), Value::Object(entry_from_input(input)));
        self.write_tools(&slug, &servers)?;
        self.inner.lock().board_status.remove(&name);
        self.emit();
        self.refresh();
        Ok(())
    }

    fn update_on_board(self: &Arc<Self>, name: &str, input: &Value, slug: &str) -> R<()> {
        let slug = self.board_source(Some(slug))?;
        add_args(input)?;
        let next = crate::js::trim(&jstr(input.get("name"))).to_string();
        let servers = self.read_tools(&slug);
        if !servers.contains_key(name) {
            return Err(McpError::new(404, format!("This board has no tool called {name}")));
        }
        if next != name {
            self.check_board_name(&next)?;
            if servers.contains_key(&next) {
                return Err(McpError::new(409, format!("This board already has a tool called {next}.")));
            }
        }
        let mut renamed = input.clone();
        renamed["name"] = json!(next);
        let out: Obj = servers.into_iter().map(|(k, v)| if k == name { (next.clone(), Value::Object(entry_from_input(&renamed))) } else { (k, v) }).collect();
        self.write_tools(&slug, &out)?;
        self.inner.lock().board_status.remove(&next);
        self.forget_board_tool(name);
        self.emit();
        self.refresh();
        Ok(())
    }

    /// "Only this board": copies the user-wide entry as it is into the board's tools, then removes the user-wide one.
    pub async fn move_to_board(self: &Arc<Self>, name: &str, slug: &str) -> R<()> {
        let slug = self.board_source(Some(slug))?;
        let srv = self.find(name)?;
        if s(&srv, "scope") != "user" || name == OWN {
            return Err(McpError::new(400, format!("{name} can't be moved from here")));
        }
        let entry = user_entry(name, &self.o.config_file);
        if movable_input(name, entry.as_ref()).is_none() {
            return Err(McpError::new(400, CANT_READ));
        }
        let mut servers = self.read_tools(&slug);
        servers.insert(name.to_string(), Value::Object(entry.unwrap()));
        self.write_tools(&slug, &servers)?;
        let st = (s(&srv, "status").to_string(), srv.get("message").and_then(Value::as_str).map(str::to_string));
        self.inner.lock().board_status.insert(name.to_string(), st);
        self.remove_user_copy(name).await;
        Ok(())
    }

    /// "Use in all projects": adds the board's entry user-wide (`claude mcp add-json`), then drops it from every board.
    pub async fn move_to_user(self: &Arc<Self>, name: &str, slug: &str) -> R<()> {
        self.board_source(Some(slug))?;
        let groups = self.board_groups();
        let Some(g) = group(&groups, name).cloned() else { return Err(McpError::new(404, format!("No board has a tool called {name}"))) };
        let user_wide = self.inner.lock().servers.iter().any(|x| s(x, "name") == name && s(x, "scope") != "board");
        if user_wide || user_entry(name, &self.o.config_file).is_some() {
            return Err(McpError::new(409, format!("A tool called {name} is already on for all projects.")));
        }
        let pick = g.iter().find(|b| b.slug == slug).unwrap_or(&g[0]);
        let Some(input) = movable_input(name, Some(&pick.entry)) else { return Err(McpError::new(400, CANT_READ)) };
        let text = ckanban_core::datafile::to_text(&Value::Object(pick.entry.clone()), ckanban_core::datafile::Layout::Compact);
        let r = self.run(&["mcp", "add-json", "--scope", "user", name, &text], Duration::from_secs(60), None, None).await;
        if r.code != 0 {
            return Err(McpError::new(502, error_text(&r, "claude mcp add-json", &secrets_of(Some(&input)))));
        }
        let slugs: Vec<String> = g.iter().map(|b| b.slug.clone()).collect();
        self.drop_board_copies(name, &slugs);
        self.show(&input).await;
        self.refresh();
        Ok(())
    }

    /// Retries the failed second step of a move.
    pub async fn retry_move(self: &Arc<Self>, name: &str) -> R<()> {
        let lf = self.inner.lock().leftovers.get(name).map(|l| match l {
            Leftover::User(_) => None,
            Leftover::Boards(b, _) => Some(b.clone()),
        });
        match lf {
            None => return Err(McpError::new(404, format!("{name} has nothing left to clean up"))),
            Some(None) => self.remove_user_copy(name).await,
            Some(Some(boards)) => self.drop_board_copies(name, &boards),
        }
        if let Some(now) = self.inner.lock().leftovers.get(name) {
            return Err(McpError::new(502, format!("The old copy still couldn't be removed: {}", now.reason())));
        }
        Ok(())
    }

    async fn remove_user_copy(self: &Arc<Self>, name: &str) {
        let r = self.run(&["mcp", "remove", name, "--scope", "user"], Duration::from_secs(60), None, None).await;
        if r.code != 0 {
            self.inner.lock().leftovers.insert(name.to_string(), Leftover::User(error_text(&r, "claude mcp remove", &[])));
            self.emit();
            return;
        }
        {
            let mut i = self.inner.lock();
            i.leftovers.remove(name);
            i.servers.retain(|x| s(x, "name") != name);
            i.touched.insert(name.to_string());
        }
        self.emit();
        self.refresh();
    }

    fn drop_board_copies(&self, name: &str, slugs: &[String]) {
        let mut failed = Vec::new();
        let mut reason = String::new();
        for slug in slugs {
            let mut servers = self.read_tools(slug);
            if servers.shift_remove(name).is_none() {
                continue;
            }
            if let Err(e) = write_board_tools(&self.tools_file(slug), &servers) {
                failed.push(slug.clone());
                reason = e.to_string();
            }
        }
        {
            let mut i = self.inner.lock();
            if failed.is_empty() {
                i.leftovers.remove(name);
            } else {
                let reason = if reason.is_empty() { "couldn't save the board's tools".to_string() } else { reason };
                i.leftovers.insert(name.to_string(), Leftover::Boards(failed, reason));
            }
            i.board_status.remove(name);
        }
        self.emit();
    }

    // ----- routes -----

    /// `/api/mcp...` (`connectionRoutes`); None for other paths.
    pub async fn answer(self: &Arc<Self>, c: &Call<'_>) -> Option<Answer> {
        if c.parts.first().map(String::as_str) != Some("mcp") {
            return None;
        }
        Some(match self.route(c).await {
            Ok(a) => a,
            Err(McpError(status, msg)) => Answer::error(status, msg),
        })
    }

    async fn route(self: &Arc<Self>, c: &Call<'_>) -> R<Answer> {
        let (p, m) = (c.parts, c.method);
        let name = p.get(1).map(String::as_str).unwrap_or("");
        let sub = p.get(2).map(String::as_str);
        let ok = |status: u16, me: &Self| Ok(Answer::Json(status, me.state()));
        let body = || super::body_json(c.body).map_err(|a| match a {
            Answer::Json(st, v) => McpError(st, v["error"].as_str().unwrap_or("invalid JSON body").to_string()),
            _ => McpError::new(400, "invalid JSON body"),
        });
        let board_q = query(c.query, "board");
        match (p.len(), m, sub) {
            (1, "GET", _) => ok(200, self),
            (1, "POST", _) => {
                self.add(&body()?).await?;
                ok(201, self)
            }
            (2, "POST", _) if name == "refresh" => {
                self.refresh();
                ok(202, self)
            }
            (2, "DELETE", _) => {
                self.remove(name, board_q.as_deref()).await?;
                ok(200, self)
            }
            (3, "POST", Some("move")) => {
                let b = body()?;
                let b = if b.is_null() { json!({}) } else { b };
                let board = jstr_or(b.get("board"), "");
                match b.get("to").and_then(Value::as_str) {
                    Some("board") => self.move_to_board(name, &board).await?,
                    Some("all") => self.move_to_user(name, &board).await?,
                    _ => return Err(McpError::new(400, "to must be board or all")),
                }
                ok(200, self)
            }
            (3, "POST", Some("retry-move")) => {
                self.retry_move(name).await?;
                ok(200, self)
            }
            (3, "POST", Some("login")) => {
                self.login(name)?;
                ok(202, self)
            }
            (3, "POST", Some("login-paste")) => {
                let b = body()?;
                self.paste(name, &jstr_or(b.get("text"), ""))?;
                ok(200, self)
            }
            (3, "POST", Some("cancel-login")) => {
                self.cancel_login(name);
                ok(200, self)
            }
            (3, "POST", Some("logout")) => {
                self.logout(name).await?;
                ok(200, self)
            }
            (3, "POST", Some("recheck")) => {
                if self.recheck(name).await.is_none() {
                    return Err(McpError::new(502, format!("couldn't check {name}; try Refresh")));
                }
                ok(200, self)
            }
            (3, "GET", Some("config")) => Ok(Answer::Json(200, self.config(name, board_q.as_deref())?)),
            (2, "PUT", _) => {
                self.update(name, &body()?).await?;
                ok(200, self)
            }
            _ => Err(McpError::new(404, "not found")),
        }
    }
}

/// `input.board` when truthy, as a string.
fn board_of(input: &Value) -> Option<String> {
    let b = input.get("board");
    crate::js::truthy(b).then(|| crate::js::string(b.unwrap()))
}

/// `url.searchParams.get(name)`.
fn query(q: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

#[cfg(test)]
mod tests;
