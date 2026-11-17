//! The session routes the Rust board answers in board mode (Bun's `src/api/ticket-files.ts`, `chats.ts`,
//! `profiles.ts`): a ticket's conversation, one tool call, one subagent, a workflow's script and helper agents, chat
//! search and read, and the board folder's Claude sessions. Answers are JSON values; the server masks saved keys and
//! writes them. A request this code doesn't answer the same way Bun would (another ticket's chat from a run, odd query
//! numbers, a workflow stop) returns None and goes on to Bun.
//!
//! Every answer reads files (ticket files, transcripts), so it runs on a blocking thread.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{Value, json};

use super::search::{self, ChatSource};
use super::service::Sessions;
use super::subagents::{self, AGENT_STEP_TAIL};
use super::ticket_files::{earlier_sessions, session_id};
use super::workflows;
use super::{Obj, js};

pub const RUN_HEADER: &str = "x-ckanban-run";
pub const HUDDLE_HEADER: &str = "x-ckanban-huddle-agent";

/// What the routes read from a request.
#[derive(Debug, Clone, Default)]
pub struct Req {
    pub method: String,
    /// The path as sent (still percent-encoded).
    pub path: String,
    pub query: Option<String>,
    /// `x-ckanban-run`, when sent.
    pub run: Option<String>,
    /// `x-ckanban-huddle-agent` was sent.
    pub huddle: bool,
}

/// An answer: status and JSON body (`{"error": ...}` for errors, as Bun's `HttpError`).
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub status: u16,
    pub body: Value,
}

fn ok(body: Value) -> Option<Reply> {
    Some(Reply { status: 200, body })
}

fn err(status: u16, msg: impl Into<String>) -> Option<Reply> {
    Some(Reply { status, body: json!({ "error": msg.into() }) })
}

/// Whether this request is one the session routes may answer (cheap: no file read). The server only hands these over.
pub fn wanted(method: &str, path: &str) -> bool {
    if method != "GET" {
        return false;
    }
    let p: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    matches!(
        p.as_slice(),
        ["api", "profiles", _, "sessions"]
            | ["api", "profiles", _, "chat", "search" | "read"]
            | ["api", "profiles", _, "tickets", _, "conversation"]
            | ["api", "profiles", _, "tickets", _, "tool" | "agent", _]
            | ["api", "profiles", _, "tickets", _, "workflow", _, "script"]
            | ["api", "profiles", _, "tickets", _, "workflow", _, "agent", _]
    )
}

/// `URLSearchParams.get`: the first value of `key`, `+` as a space, percent-decoded.
fn query_get(q: Option<&str>, key: &str) -> Option<String> {
    let q = q?;
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if form_decode(k) == key {
            return Some(form_decode(v));
        }
    }
    None
}

fn form_decode(s: &str) -> String {
    let s = s.replace('+', " ");
    percent_encoding::percent_decode_str(&s).decode_utf8_lossy().into_owned()
}

/// JS `Number(s)` for a query value: None for NaN (the caller lets Bun answer then).
pub(crate) fn js_number(s: &str) -> Option<f64> {
    let t = js::trim(s);
    if t.is_empty() {
        return Some(0.0);
    }
    let lower = t.to_ascii_lowercase();
    if lower.contains("inf") || lower.contains("nan") {
        return match t {
            "Infinity" | "+Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            _ => None,
        };
    }
    if let Some(h) = lower.strip_prefix("0x") {
        return u64::from_str_radix(h, 16).ok().map(|v| v as f64);
    }
    t.parse::<f64>().ok()
}

impl Sessions {
    /// The answer to a session route, or None: Bun answers it.
    pub async fn answer(self: &Arc<Self>, req: Req) -> Option<Reply> {
        if !wanted(&req.method, &req.path) {
            return None;
        }
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.answer_now(&req)).await.ok().flatten()
    }

    /// `answer`, on the calling thread (blocking).
    pub fn answer_now(self: &Arc<Self>, req: &Req) -> Option<Reply> {
        let raw: Vec<&str> = req.path.split('/').filter(|s| !s.is_empty()).skip(1).collect();
        // decodeURIComponent: a malformed escape throws in Bun; let it answer that.
        let mut parts = Vec::with_capacity(raw.len());
        for p in raw {
            parts.push(percent_encoding::percent_decode_str(p).decode_utf8().ok()?.into_owned());
        }
        let slug = parts.get(1)?.clone();
        let Some(profile) = self.tickets.profile(&slug) else { return err(404, format!("board {slug} not found")) };
        let q = req.query.as_deref();
        match parts.get(2).map(String::as_str) {
            Some("sessions") => return self.sessions_route(&slug, &profile),
            Some("chat") if parts[3] == "search" => return self.search_route(req, &slug, q),
            Some("chat") => return self.read_route(req, &slug, q),
            _ => {}
        }
        let id = parts.get(3)?.clone();
        let Some(t) = self.tickets.ticket(&slug, &id) else { return err(404, format!("ticket {id} not found")) };
        match parts[4].as_str() {
            "conversation" => self.conversation(&slug, &id, &t, q),
            "tool" => self.tool(&t, &parts[5]),
            "agent" => self.agent(&slug, &id, &t, &parts[5]),
            "workflow" => self.workflow(&slug, &id, &t, &parts[5], &parts[6..]),
            _ => None,
        }
    }

    /// `chatEntries`: chats left behind with "Send in a fresh chat" (no rewinding into them), each followed by a note,
    /// then the current chat. Also how many entries the current chat has.
    fn chat_entries(&self, t: &Obj) -> (Vec<Value>, usize) {
        let current = session_id(t).and_then(|s| self.cache.get(&s)).map(|p| (*p.entries).clone()).unwrap_or_default();
        let earlier = earlier_sessions(t);
        if earlier.is_empty() {
            let n = current.len();
            return (current, n);
        }
        let mut all = Vec::new();
        for (sid, ended) in earlier {
            if let Some(p) = self.cache.get(&sid) {
                for e in p.entries.iter() {
                    let mut e = e.clone();
                    if let Some(o) = e.as_object_mut() {
                        o.shift_remove("rewind");
                    }
                    all.push(e);
                }
            }
            all.push(json!({
                "uuid": format!("fresh-chat-{sid}"), "at": ended, "role": "assistant", "kind": "board",
                "text": "Fresh chat from here: Claude no longer reads the messages above, but can look them up.",
            }));
        }
        let n = current.len();
        all.extend(current);
        (all, n)
    }

    /// `workflowView`: a workflow as the chat shows it, settled once the run is gone, without its script. The run's
    /// live progress comes from the run loop (R7a); none yet.
    fn workflow_view(&self, w: &Obj, active: bool) -> Obj {
        let mut v = workflows::settle_workflow(w, active, ckanban_core::time::now_ms());
        v.shift_remove("script");
        v.shift_remove("scriptPath");
        v
    }

    fn conversation(&self, slug: &str, id: &str, t: &Obj, q: Option<&str>) -> Option<Reply> {
        let sid = session_id(t);
        let parsed = sid.as_deref().and_then(|s| self.cache.get(s));
        let (all, current) = self.chat_entries(t);
        let len = all.len() as f64;
        let limit_raw = match query_get(q, "limit") {
            Some(v) => js_number(&v)?,
            None => 0.0,
        };
        let limit = 500f64.min(1f64.max(if limit_raw == 0.0 { 100.0 } else { limit_raw }));
        let before = match query_get(q, "before") {
            Some(v) => js_number(&v)?,
            None => len,
        };
        let end = 0f64.max(len.min(before));
        let start = 0f64.max(end - limit);
        let active = self.runs().is_running(slug, id);
        let earlier = all.len() - current;
        let now = ckanban_core::time::now_ms();
        let (a, b) = (start.trunc() as usize, end.trunc() as usize);
        let entries: Vec<Value> = all[a.min(b)..b]
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let Some(o) = e.as_object() else { return e.clone() };
                let mut o = o.clone();
                if let Some(w) = o.get("workflow").and_then(Value::as_object) {
                    let view = self.workflow_view(w, active && (start + i as f64) >= earlier as f64);
                    o.insert("workflow".into(), Value::Object(view));
                } else if let Some(ag) = o.get("agent").and_then(Value::as_object) {
                    let mut ag = subagents::settle_agent(ag, active, now);
                    if let Some(Value::Array(steps)) = ag.get_mut("steps") {
                        let cut = steps.len().saturating_sub(AGENT_STEP_TAIL);
                        steps.drain(..cut);
                    }
                    o.insert("agent".into(), Value::Object(ag));
                }
                Value::Object(o)
            })
            .collect();
        let title = parsed.map(|p| p.title.clone()).unwrap_or(Value::Null);
        ok(json!({ "entries": entries, "start": js::num(start), "total": all.len(), "title": title }))
    }

    fn tool(&self, t: &Obj, tool_use_id: &str) -> Option<Reply> {
        let mut ids: Vec<String> = session_id(t).into_iter().collect();
        ids.extend(earlier_sessions(t).into_iter().rev().map(|(s, _)| s));
        for sid in ids {
            if let Some(d) = self.cache.tool_detail(&sid, tool_use_id) {
                return ok(d);
            }
        }
        err(404, "no such tool call in this ticket's conversation")
    }

    fn agent(&self, slug: &str, id: &str, t: &Obj, tool_use_id: &str) -> Option<Reply> {
        let (all, _) = self.chat_entries(t);
        let found = all.iter().find_map(|e| e.get("agent").and_then(Value::as_object).filter(|a| a.get("toolUseId").and_then(Value::as_str) == Some(tool_use_id)));
        let Some(a) = found else { return err(404, "no such subagent in this ticket's conversation") };
        ok(Value::Object(subagents::settle_agent(a, self.runs().is_running(slug, id), ckanban_core::time::now_ms())))
    }

    fn workflow(&self, slug: &str, id: &str, t: &Obj, tool_use_id: &str, rest: &[String]) -> Option<Reply> {
        let sid = session_id(t);
        let parsed = sid.as_deref().and_then(|s| self.cache.get(s));
        let found = parsed.as_ref().and_then(|p| {
            p.entries.iter().find_map(|e| e.get("workflow").and_then(Value::as_object).filter(|w| w.get("toolUseId").and_then(Value::as_str) == Some(tool_use_id)).cloned())
        });
        let (Some(w), Some(sid)) = (found, sid) else { return err(404, "no such workflow in this ticket's conversation") };
        let run = w.get("runId").and_then(Value::as_str).filter(|r| !r.is_empty()).and_then(|r| self.cache.workflow_run(&sid, r));
        match rest {
            [s] if s == "script" => match workflows::workflow_script(&w, run.as_ref()) {
                Some(script) => ok(json!({ "script": script })),
                None => err(404, "the workflow's script wasn't saved"),
            },
            [a, agent_id] if a == "agent" => {
                let view = self.workflow_view(&w, self.runs().is_running(slug, id));
                match workflows::workflow_agent_detail(&view, run.as_ref(), agent_id) {
                    Some(d) => ok(d),
                    None => err(404, "no such helper agent in this workflow"),
                }
            }
            _ => None,
        }
    }

    /// `chatReach`: who may search or read a ticket's chat. A run reads its own ticket's chat, and a main ticket its
    /// family's; a chat answering the user's typed message any ticket's, on any board; the user's own Claude any.
    /// Some(Err(reply)) refuses.
    fn reach(&self, req: &Req, slug: &str, target: &str) -> Option<Result<(), Reply>> {
        use crate::tickets::rights::{Who, is_manager, other_board, split_run};
        if req.huddle {
            return Some(Err(Reply { status: 403, body: json!({ "error": "search_chat and read_chat work in a ticket's own runs, not for huddle helpers" }) }));
        }
        let Some(run) = &req.run else { return Some(Ok(())) };
        let (run_slug, run_id) = split_run(run);
        let caller = (run_slug == slug && !run_id.is_empty()).then_some(run_id.as_str());
        if caller == Some(target) {
            return Some(Ok(()));
        }
        let refuse = |status: u16, msg: String| Some(Err(Reply { status, body: json!({ "error": msg }) }));
        let Some(tickets) = self.board.get() else {
            return refuse(503, "the board is still starting; try again in a moment".into());
        };
        let who = Who { tickets, hooks: tickets.hooks() };
        let manager = caller.and_then(|c| tickets.get(slug, c)).is_some_and(|t| is_manager(&t));
        if manager && who.in_family(slug, caller.unwrap_or(""), target) {
            return Some(Ok(()));
        }
        // `askedBy`: a chat answering the user's typed message there (its ticket must exist).
        if !run_slug.is_empty() && !run_id.is_empty() && who.user_asked_run(&run_slug, &run_id) && tickets.get(&run_slug, &run_id).is_some() {
            return Some(Ok(()));
        }
        let Some(caller) = caller else {
            let (status, msg) = other_board("reading chats", slug, &run_slug);
            return refuse(status, msg);
        };
        refuse(
            403,
            format!(
                "{target} is out of reach: from this run you may search the chat of your own ticket ({caller}){}; other tickets' chats only in a reply to a message the user typed in this chat.",
                if manager { " and of its tool tickets (get_family lists them)" } else { "" }
            ),
        )
    }

    /// `chatSources`: a ticket's chat, oldest session first, with tool outputs when asked.
    fn chat_sources(&self, t: &Obj, tools: bool) -> Vec<ChatSource> {
        let mut ids: Vec<String> = earlier_sessions(t).into_iter().map(|(s, _)| s).collect();
        ids.extend(session_id(t));
        ids.into_iter()
            .filter_map(|sid| {
                let p = self.cache.get(&sid)?;
                let tool_output: Option<HashMap<String, String>> = if tools {
                    self.cache.file(&sid).and_then(|f| std::fs::read(f).ok()).map(|b| search::tool_outputs(&String::from_utf8_lossy(&b)))
                } else {
                    None
                };
                Some(ChatSource { session_id: sid, entries: p.entries.clone(), tool_output })
            })
            .collect()
    }

    fn search_route(&self, req: &Req, slug: &str, q: Option<&str>) -> Option<Reply> {
        let own = req.run.as_deref().and_then(|r| {
            let mut it = r.split('/');
            let (s, i) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            (s == slug && !i.is_empty()).then(|| i.to_string())
        });
        let id = query_get(q, "ticket").filter(|s| !s.is_empty()).or(own);
        let Some(id) = id else { return err(400, "say which ticket's chat to search (ticket)") };
        let Some(t) = self.tickets.ticket(slug, &id) else { return err(404, format!("ticket {id} not found")) };
        let tid = t.get("id").and_then(Value::as_str).unwrap_or(&id).to_string();
        if let Err(r) = self.reach(req, slug, &tid)? {
            return Some(r);
        }
        let tools = query_get(q, "tools").as_deref() == Some("1");
        let query = query_get(q, "q").unwrap_or_default();
        let sources = self.chat_sources(&t, tools);
        match search::search_chat(&sources, &query, tools, None) {
            Ok(r) => ok(json!({ "text": search::matches_text(&tid, &query, &r, tools) })),
            Err(e) => err(400, e),
        }
    }

    fn read_route(&self, req: &Req, slug: &str, q: Option<&str>) -> Option<Reply> {
        let Some((sid, index)) = search::parse_ref(&query_get(q, "ref").unwrap_or_default()) else {
            return err(400, "ref must look like <sessionId>:<message number>, as search_chat gives it");
        };
        // Every ticket of the board is looked through (Bun's listTickets().find): the ticket store (R1) will index it.
        let t = self.tickets.tickets(slug).into_iter().find(|t| {
            session_id(t).as_deref() == Some(sid.as_str()) || earlier_sessions(t).iter().any(|(s, _)| *s == sid)
        });
        let Some(t) = t else { return err(404, format!("no ticket on this board has the chat {sid}")) };
        let tid = t.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if let Err(r) = self.reach(req, slug, &tid)? {
            return Some(r);
        }
        let Some(src) = self.chat_sources(&t, true).into_iter().find(|s| s.session_id == sid) else {
            return err(404, format!("the chat {sid} can't be read any more (its transcript is gone)"));
        };
        let num = |k: &str| -> Option<Option<f64>> {
            match query_get(q, k) {
                None => Some(None),
                Some(v) => js_number(&v).map(Some),
            }
        };
        let (before, after) = (num("before")?, num("after")?);
        match search::read_chat(&src, index, before, after) {
            Ok(r) => ok(json!({ "text": search::read_text(&tid, &r) })),
            Err(e) => err(400, e),
        }
    }

    /// `/profiles/:p/sessions`: Claude Code sessions started in the board's folder, newest first, whether a `claude`
    /// process has each open, and the ticket linked to it.
    fn sessions_route(&self, slug: &str, profile: &Value) -> Option<Reply> {
        let path = profile.get("path").and_then(Value::as_str).unwrap_or("");
        let commands = process_commands();
        let mut linked: HashMap<String, (Value, Value)> = HashMap::new();
        for t in self.tickets.tickets(slug) {
            if let Some(s) = session_id(&t) {
                linked.insert(s, (t.get("id").cloned().unwrap_or(Value::Null), t.get("title").cloned().unwrap_or(Value::Null)));
            }
        }
        let projects = self.cache_projects();
        let list: Vec<Value> = list_sessions(&projects, path, 50)
            .into_iter()
            .map(|mut s| {
                let id = s.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let title = s.get("title").and_then(Value::as_str).map(str::to_string);
                s.insert("live".into(), Value::Bool(live_session_match(&commands, &id, title.as_deref())));
                let ticket = linked.get(&id).map(|(i, t)| json!({ "id": i, "title": t })).unwrap_or(Value::Null);
                s.insert("ticket".into(), ticket);
                Value::Object(s)
            })
            .collect();
        ok(Value::Array(list))
    }

    fn cache_projects(&self) -> std::path::PathBuf {
        self.projects.clone()
    }
}

/// `encodeProjectDir`: every UTF-16 unit that isn't an ASCII letter or digit becomes "-".
pub fn encode_project_dir(path: &str) -> String {
    path.chars().flat_map(|c| if c.is_ascii_alphanumeric() { vec![c] } else { vec!['-'; c.len_utf16()] }).collect()
}

/// `promptText`: the first prompt as a one-line preview.
fn prompt_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|c| if c.get("type").and_then(Value::as_str) == Some("text") { js::string_or_empty(c.get("text")) } else { String::new() }).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    };
    let t = js::trim(&text);
    if t.is_empty() || t.starts_with('<') || ["Base directory for this skill", "Caveat:", "[Request interrupted"].iter().any(|p| t.starts_with(p)) {
        return None;
    }
    Some(js::cut16(&js::squash_spaces(t), 160).to_string())
}

/// `listSessions`: the sessions in the project folder's transcripts folder, most recently active first.
pub fn list_sessions(projects: &std::path::Path, project_path: &str, limit: usize) -> Vec<Obj> {
    let dir = projects.join(encode_project_dir(project_path));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(String, std::path::PathBuf, f64)> = Vec::new();
    for e in rd.flatten() {
        let Ok(name) = e.file_name().into_string() else { continue };
        let Some(id) = name.strip_suffix(".jsonl") else { continue };
        // Bun's statSync throws on a file gone meanwhile, and the whole list is empty then.
        let Ok(m) = std::fs::metadata(e.path()) else { return Vec::new() };
        files.push((id.to_string(), e.path(), super::cache::mtime_ms(&m).trunc()));
    }
    files.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    files
        .into_iter()
        .take(limit)
        .map(|(id, file, mtime)| {
            let (mut title, mut ai, mut first): (Option<String>, Option<String>, Option<String>) = (None, None, None);
            let raw = std::fs::read(&file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            for line in raw.split('\n') {
                if line.is_empty() {
                    continue;
                }
                let is_title = line.contains("\"custom-title\"") || line.contains("\"ai-title\"");
                if !is_title && (first.is_some() || !line.contains("\"user\"")) {
                    continue;
                }
                let Ok(ev) = serde_json::from_str::<Value>(line) else { continue };
                let ty = ev.get("type").and_then(Value::as_str);
                if ty == Some("custom-title") && ev.get("customTitle").is_some_and(Value::is_string) {
                    title = ev["customTitle"].as_str().map(str::to_string);
                } else if ty == Some("ai-title") && ev.get("aiTitle").is_some_and(Value::is_string) {
                    ai = ev["aiTitle"].as_str().map(str::to_string);
                } else if first.is_none() && ty == Some("user") && ev.get("message").and_then(|m| m.get("role")).and_then(Value::as_str) == Some("user") {
                    first = prompt_text(ev["message"].get("content").unwrap_or(&Value::Null));
                }
            }
            let mut o = Obj::new();
            o.insert("id".into(), Value::String(id));
            o.insert("title".into(), title.or(ai).map(Value::String).unwrap_or(Value::Null));
            o.insert("firstPrompt".into(), first.map(Value::String).unwrap_or(Value::Null));
            o.insert("lastActive".into(), Value::String(ckanban_core::time::iso(mtime)));
            o
        })
        .collect()
}

/// `isClaudeCommand`: /(^|[\s/])claude(\s|$)|claude(-code)?\/cli\.js/.
fn is_claude_command(cmd: &str) -> bool {
    if cmd.contains("claude/cli.js") || cmd.contains("claude-code/cli.js") {
        return true;
    }
    cmd.match_indices("claude").any(|(i, _)| {
        let before = cmd[..i].chars().next_back();
        let after = cmd[i + 6..].chars().next();
        before.is_none_or(|c| c == '/' || js::is_space(c)) && after.is_none_or(js::is_space)
    })
}

/// `liveSessionMatch`: a `claude` process resuming this session (by id or title).
pub fn live_session_match(commands: &[String], id: &str, title: Option<&str>) -> bool {
    commands.iter().any(|c| is_claude_command(c) && (c.contains(id) || title.is_some_and(|t| !t.is_empty() && c.contains(t))))
}

/// `processCommands`: every process's command line (`ps -axo args=`), none when ps fails.
fn process_commands() -> Vec<String> {
    let out = std::process::Command::new("ps").args(["-axo", "args="]).current_dir(ckanban_core::home::home_dir()).output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_helpers_match_bun() {
        assert!(wanted("GET", "/api/profiles/b/tickets/t/conversation"));
        assert!(wanted("GET", "/api/profiles/b/tickets/t/workflow/w/agent/a"));
        assert!(!wanted("POST", "/api/profiles/b/tickets/t/workflow/w/stop"));
        assert!(!wanted("GET", "/api/profiles/b/chats/c/tool/x"));
        assert_eq!(query_get(Some("q=a+b%21&x=1"), "q").as_deref(), Some("a b!"));
        assert_eq!(query_get(Some("q"), "q").as_deref(), Some(""));
        assert_eq!(js_number(" 12 "), Some(12.0));
        assert_eq!(js_number(""), Some(0.0));
        assert_eq!(js_number("abc"), None);
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(encode_project_dir("/Users/a b/😀"), "-Users-a-b---");
        assert!(is_claude_command("/usr/local/bin/claude --resume x"));
        assert!(is_claude_command("node /x/claude-code/cli.js"));
        assert!(!is_claude_command("claudette"));
        assert!(live_session_match(&["claude --resume abc".into()], "abc", None));
        assert!(!live_session_match(&["vim abc".into()], "abc", None));
    }
}
