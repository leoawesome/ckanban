//! Automations (`src/schedules/loops.ts`): each tick, every switched-on automation that is due runs its check script;
//! each item the script finds for the first time becomes a ticket (after Claude's yes, with Ask Claude first). Nothing
//! here knows a service: scripts reach them through the board's passes (`ckanban call`, `call`), whose tool calls the
//! satellite makes.

use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use base64::Engine;
use serde_json::{Map, Value, json};

use super::files::Obj;
use super::script::{SCRIPT_TIMEOUT_MS, ScriptRun, run_script, script_env};
use super::sha256::hex as sha_hex;
use super::text::{ASK_BODY, DECISION_SYSTEM, Decision, Item, VARIABLES, decision_prompt, parse_decision, thread_item_text, ticket_body, ticket_title, used_variables};
use super::{Fail, Grant, Schedules, fail, js_str, now_iso, obj, st};
use crate::runloop::followup::iso_ms;
use crate::runs::js;
use crate::runs::side_call::{SideCallInput, SideCallResult};

const FORMAT: f64 = 2.0;
const DEFAULT_EVERY: f64 = 15.0;
/// Programs on this computer start a process for each check: not more often than this.
const LOCAL_MIN_EVERY: f64 = 5.0;
const SCRIPT_MAX: usize = 64_000;
const PREVIEW: usize = 20;
/// New items Claude looks at in one check (Ask Claude first).
const ASK_PER_CHECK: usize = 20;
/// Tickets one check makes at most.
const NEW_PER_CHECK: usize = 20;
const BACKOFF_MIN_MS: f64 = 2.0 * 60_000.0;
const BACKOFF_MAX_MS: f64 = 30.0 * 60_000.0;
const COLUMNS: [&str; 3] = ["backlog", "planning", "ready"];
pub const DEFAULT_INSTRUCTIONS: &str = "Look at this item from {{service}} and do what it needs.\n\nLink: {{link}}";

fn sha256(text: &str) -> String {
    sha_hex(text.as_bytes())
}

/// `forTickets`: taskPlaceFor's problem in an automation's words.
fn for_tickets(problem: &str) -> String {
    problem.replacen("it puts runs in", "it puts new tickets in", 1)
}

fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// `learnedTools`: the tools its checks may call, or None while still learning them (an empty list counts as not
/// learned).
fn learned_tools(l: &Obj) -> Option<Vec<String>> {
    let v = strs(l.get("allowedTools"));
    (!v.is_empty()).then_some(v)
}

fn text_or(input: &Obj, k: &str, fallback: &str) -> String {
    match input.get(k) {
        None => fallback.to_string(),
        Some(v) => js_str(v),
    }
}

impl Schedules {
    /// `lock`: one check or edit of an automation at a time.
    fn loop_lock(&self, slug: &str, id: &str) -> Arc<parking_lot::Mutex<()>> {
        self.loop_locks.lock().entry(format!("{slug}/{id}")).or_default().clone()
    }

    /// `view`: the automation with whether it can run and why not, its script as it is now, its passes and memory.
    pub fn loop_view(&self, slug: &str, l: &Obj) -> Obj {
        let id = st(l, "id");
        let mut problems: Vec<String> = Vec::new();
        let mut state = "ok";
        let version = l.get("version").and_then(Value::as_f64);
        if version.is_some_and(|v| v > FORMAT) {
            problems.push("Saved by a newer ckanban. Update ckanban to use it.".into());
        } else if version.is_some_and(|v| v < FORMAT) {
            problems.push("Made by an earlier test version of automations. Delete it and set it up again.".into());
        }
        if !problems.is_empty() {
            state = "unsupported";
        }
        let script = self.files.read_script(slug, id);
        let pass_views: Vec<(String, String, String)> = strs(l.get("passes"))
            .into_iter()
            .map(|pid| {
                let p = self.d.passes.get(&pid);
                let f = |k: &str, d: &str| p.as_ref().and_then(|p| p.get(k)).and_then(Value::as_str).unwrap_or(d).to_string();
                (pid, f("name", "(removed)"), f("status", "missing"))
            })
            .collect();
        if state == "ok" {
            for (_, name, status) in &pass_views {
                if status == "missing" {
                    problems.push("One of its connections was removed. Pick it again or connect it in Connections.".into());
                } else if status != "connected" {
                    problems.push(format!("{name} needs to be connected again (Connections)."));
                }
            }
            if !problems.is_empty() {
                state = "needs_connection";
            }
        }
        if state == "ok" && script.as_deref().is_none_or(|s| sha256(s) != st(l, "scriptHash")) {
            problems.push("Script changed, review it: it doesn't run until you save it again.".into());
            state = "script_changed";
        }
        let stt = self.files.loop_state(slug, id);
        let mut v = l.clone();
        v.insert("state".into(), state.into());
        v.insert("problems".into(), json!(problems));
        v.insert("script".into(), script.map(Value::from).unwrap_or(Value::Null));
        v.insert("passViews".into(), Value::Array(pass_views.into_iter().map(|(id, name, status)| json!({ "id": id, "name": name, "status": status })).collect()));
        v.insert("seenCount".into(), stt.get("seen").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0).into());
        v.insert("lastFound".into(), stt.get("lastFound").cloned().unwrap_or(Value::Null));
        v.insert("lastItems".into(), stt.get("lastItems").cloned().unwrap_or(Value::Null));
        if js::truthy(l.get("partOf")) {
            v.insert("partOfTitle".into(), self.title_of(slug, st(l, "partOf")).map(Value::from).unwrap_or(Value::Null));
        }
        v
    }

    fn emit_loop(&self, slug: &str, l: Option<&Obj>, id: &str) {
        let view = l.map(|l| Value::Object(self.loop_view(slug, l))).unwrap_or(Value::Null);
        self.emit(json!({ "type": "loop.updated", "profile": slug, "id": id, "loop": view }));
    }

    pub fn get_loop(&self, slug: &str, id: &str) -> Result<Obj, Fail> {
        self.files.get_loop(slug, id).ok_or_else(|| fail(404, format!("automation {id} not found")))
    }

    pub fn list_loops(&self, slug: &str) -> Vec<Value> {
        self.files.list_loops(slug).iter().map(|l| Value::Object(self.loop_view(slug, l))).collect()
    }

    /// `passIds`: pass ids from ids or names; refuses one the board doesn't have.
    fn pass_ids(&self, v: &Value, slug: &str) -> Result<Vec<String>, Fail> {
        let Some(a) = v.as_array() else { return Err(fail(400, "passes must be a list")) };
        let mut out: Vec<String> = Vec::new();
        for r in a {
            let p = self.d.passes.find(&js_str(r), None, Some(slug));
            let Some(id) = p.as_ref().and_then(|p| p.get("id")).and_then(Value::as_str) else {
                let shown = if r.is_null() { "null".to_string() } else { js::to_string(r) };
                return Err(fail(400, format!("\"{shown}\" isn't connected for automations yet: connect it in Connections first")));
            };
            if !out.iter().any(|x| x == id) {
                out.push(id.to_string());
            }
        }
        Ok(out)
    }

    /// `validate`: the automation's fields in Bun's order, and its new script when one was sent.
    fn validate_loop(&self, slug: &str, input: &Obj, base: Option<&Obj>) -> Result<(Obj, Option<String>), Fail> {
        let b = |k: &str| base.and_then(|b| b.get(k)).filter(|v| !v.is_null());
        let bs = |k: &str, d: &str| b(k).and_then(Value::as_str).unwrap_or(d).to_string();
        let name = js::head16(js::trim(&text_or(input, "name", &bs("name", ""))), 80).to_string();
        if name.is_empty() {
            return Err(fail(400, "Give the automation a name"));
        }
        let passes = match input.get("passes") {
            None => strs(b("passes")),
            Some(v) => self.pass_ids(v, slug)?,
        };
        let service_in = js::trim(&text_or(input, "service", &bs("service", ""))).to_string();
        let service = if !service_in.is_empty() {
            service_in
        } else {
            passes.first().and_then(|p| self.d.passes.get(p)).and_then(|p| p.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string)).unwrap_or_else(|| "a script".into())
        };
        let service = js::head16(&service, 60).to_string();
        let mut script = None;
        if let Some(v) = input.get("script") {
            let s = js_str(v).replace("\r\n", "\n");
            if js::trim(&s).is_empty() {
                return Err(fail(400, "The automation needs its check script"));
            }
            if js::len16(&s) > SCRIPT_MAX {
                return Err(fail(400, "The check script is too long"));
            }
            script = Some(s);
        } else if base.is_none() {
            return Err(fail(400, "The automation needs its check script"));
        }
        let every = match input.get("everyMinutes") {
            None => b("everyMinutes").and_then(Value::as_f64).unwrap_or(DEFAULT_EVERY),
            Some(v) => js::number(Some(v)),
        };
        if every.fract() != 0.0 || !(1.0..=1440.0).contains(&every) {
            return Err(fail(400, "Check every 1 to 1440 minutes"));
        }
        let local = passes.iter().any(|id| self.d.passes.get(id).and_then(|p| p.get("kind").and_then(Value::as_str).map(|k| k == "local")).unwrap_or(false));
        if local && every < LOCAL_MIN_EVERY {
            return Err(fail(400, format!("It starts a program on this computer: check every {LOCAL_MIN_EVERY} minutes or less often")));
        }
        let column = text_or(input, "column", &bs("column", "backlog"));
        if !COLUMNS.contains(&column.as_str()) {
            return Err(fail(400, "Pick Backlog, Planning or Ready for the new tickets"));
        }
        let auto_start = match input.get("autoStart") {
            None => b("autoStart").and_then(Value::as_bool).unwrap_or(false),
            Some(v) => *v == Value::Bool(true),
        };
        if column != "backlog" && !auto_start {
            return Err(fail(
                400,
                format!("{} starts Claude on text from {service}: switch on \"Start Claude by itself\" first", if column == "ready" { "Ready" } else { "Planning" }),
            ));
        }
        let raw_ask = match input.get("askClaude") {
            None => base.and_then(|b| b.get("askClaude")).cloned(),
            Some(v) => Some(v.clone()),
        };
        let ask_on = raw_ask.as_ref().and_then(|a| a.get("on")) == Some(&Value::Bool(true));
        let ask_prompt = raw_ask.as_ref().and_then(|a| a.get("prompt")).map(js_str).unwrap_or_default();
        let ask = json!({ "on": ask_on, "prompt": js::head16(&ask_prompt, 4000) });
        let instructions = js::head16(&text_or(input, "instructions", &bs("instructions", DEFAULT_INSTRUCTIONS)), 8000).to_string();
        let unknown: Vec<String> = used_variables(&instructions).into_iter().filter(|v| !VARIABLES.contains(&v.as_str())).collect();
        if !unknown.is_empty() {
            return Err(fail(
                400,
                format!(
                    "Unknown {} in the ticket text: {}",
                    if unknown.len() == 1 { "variable" } else { "variables" },
                    unknown.iter().map(|v| format!("{{{{{v}}}}}")).collect::<Vec<_>>().join(", ")
                ),
            ));
        }
        let enabled = match input.get("enabled") {
            None => b("enabled").and_then(Value::as_bool).unwrap_or(true),
            Some(v) => *v == Value::Bool(true),
        };
        let mut part_of = b("partOf").cloned().unwrap_or(Value::Null);
        if let Some(v) = input.get("partOf") {
            let p = if v.is_null() { String::new() } else { js::trim(&js_str(v)).to_string() };
            if !p.is_empty() && !super::scheduler::ID_RE.is_match(&p) {
                return Err(fail(400, format!("\"{}\" isn't a ticket id: pick a main ticket or one of its groups", js::head16(&p, 80))));
            }
            if !p.is_empty()
                && let Err(problem) = self.task_place_for(slug, &p)
            {
                return Err(fail(400, format!("Where each new ticket goes: {}", for_tickets(&problem))));
            }
            part_of = if p.is_empty() { Value::Null } else { p.into() };
        }
        let fields = obj(json!({
            "name": name, "enabled": enabled, "service": service, "passes": passes, "everyMinutes": ckanban_core::jsnum::num(every),
            "column": column, "autoStart": auto_start, "askClaude": ask, "instructions": instructions, "partOf": part_of,
        }));
        Ok((fields, script))
    }

    pub fn create_loop(&self, slug: &str, input: &Obj) -> Result<Obj, Fail> {
        if self.files.board(slug).is_none() {
            return Err(fail(404, format!("board {slug} not found")));
        }
        let (fields, script) = self.validate_loop(slug, input, None)?;
        let script = script.unwrap_or_default();
        let id = ckanban_core::atomic::new_id();
        let lock = self.loop_lock(slug, &id);
        let _g = lock.lock();
        let at = now_iso();
        self.files.save_script(slug, &id, &script).map_err(|e| fail(500, e))?;
        let mut l = obj(json!({ "version": 2, "id": id }));
        l.extend(fields);
        l.insert("scriptHash".into(), sha256(&script).into());
        l.insert("allowedTools".into(), Value::Null);
        l.insert("createdAt".into(), at.clone().into());
        l.insert("updatedAt".into(), at.into());
        l.insert("lastCheckedAt".into(), Value::Null);
        l.insert("lastFiredAt".into(), Value::Null);
        l.insert("lastError".into(), Value::Null);
        self.files.save_loop(slug, &l).map_err(|e| fail(500, e))?;
        self.emit_loop(slug, Some(&l), &id);
        Ok(self.loop_view(slug, &l))
    }

    pub fn update_loop(&self, slug: &str, id: &str, input: &Obj) -> Result<Obj, Fail> {
        let lock = self.loop_lock(slug, id);
        let _g = lock.lock();
        let current = self.get_loop(slug, id)?;
        let version = current.get("version").and_then(Value::as_f64);
        if version.is_some_and(|v| v > FORMAT) {
            return Err(fail(409, "This automation was saved by a newer ckanban; update ckanban to edit it"));
        }
        // A loop this version can't run can still be switched off.
        let only_toggle = input.keys().all(|k| k == "enabled");
        if only_toggle && version != Some(FORMAT) {
            let mut next = current.clone();
            next.insert("enabled".into(), (input.get("enabled") == Some(&Value::Bool(true))).into());
            next.insert("updatedAt".into(), now_iso().into());
            self.files.save_loop(slug, &next).map_err(|e| fail(500, e))?;
            self.emit_loop(slug, Some(&next), id);
            return Ok(self.loop_view(slug, &next));
        }
        let (fields, script) = self.validate_loop(slug, input, Some(&current))?;
        let mut next = current.clone();
        let passes_changed = strs(fields.get("passes")).join(",") != strs(current.get("passes")).join(",");
        next.extend(fields);
        next.insert("updatedAt".into(), now_iso().into());
        let state = self.files.loop_state(slug, id);
        let mut restart = false;
        if let Some(s) = &script {
            if sha256(s) != st(&current, "scriptHash") || self.files.read_script(slug, id).as_deref() != Some(s.as_str()) {
                self.files.save_script(slug, id, s).map_err(|e| fail(500, e))?;
                next.insert("scriptHash".into(), sha256(s).into());
                restart = true;
            }
            next.insert("allowedTools".into(), Value::Null);
        }
        if passes_changed {
            next.insert("allowedTools".into(), Value::Null);
        }
        let on = |o: &Obj| o.get("enabled") == Some(&Value::Bool(true));
        if restart || (on(&next) && !on(&current)) {
            next.insert("lastError".into(), Value::Null);
            let mut s2 = state.clone();
            s2.insert("primed".into(), false.into());
            s2.insert("failures".into(), 0.into());
            s2.insert("backoffUntil".into(), Value::Null);
            self.files.save_loop_state(slug, id, &s2).map_err(|e| fail(500, e))?;
        }
        self.files.save_loop(slug, &next).map_err(|e| fail(500, e))?;
        self.emit_loop(slug, Some(&next), id);
        Ok(self.loop_view(slug, &next))
    }

    pub fn remove_loop(&self, slug: &str, id: &str) -> Result<(), Fail> {
        let lock = self.loop_lock(slug, id);
        let _g = lock.lock();
        self.get_loop(slug, id)?;
        self.files.delete_loop(slug, id);
        self.emit_loop(slug, None, id);
        Ok(())
    }

    /// `copy`: the automation on another board, switched off, with a clean memory.
    pub fn copy_loop(&self, slug: &str, id: &str, to: &str) -> Result<Obj, Fail> {
        if self.files.board(to).is_none() {
            return Err(fail(404, format!("board {to} not found")));
        }
        let l = self.get_loop(slug, id)?;
        let v = self.loop_view(slug, &l);
        if st(&v, "state") == "unsupported" {
            return Err(fail(409, "This automation can't be copied: this version of ckanban doesn't support it"));
        }
        if st(&v, "state") == "script_changed" || !v.get("script").is_some_and(Value::is_string) {
            return Err(fail(409, "Its script changed since it was saved: review and save it first"));
        }
        let g = |k: &str| l.get(k).cloned().unwrap_or(Value::Null);
        let mut input = obj(json!({
            "name": g("name"), "enabled": false, "service": g("service"), "passes": g("passes"), "script": v.get("script").cloned().unwrap_or(Value::Null),
            "everyMinutes": g("everyMinutes"), "column": g("column"), "autoStart": g("autoStart"), "askClaude": g("askClaude"), "instructions": g("instructions"),
        }));
        // `undefined` fields of an old file stay missing (their defaults apply).
        input.retain(|k, v| !(v.is_null() && !l.contains_key(k.as_str()) && k != "script"));
        self.create_loop(to, &input)
    }

    /// `call`: a call from a check script (`ckanban call`): only with its check's token, only to that automation's
    /// passes, and after the first check only the tools that check used. The tool call goes to the satellite.
    pub fn call(&self, token: &str, service: &str, tool: &str, args: Value) -> Result<Value, Fail> {
        let g = self.grants.lock().get(token).cloned();
        let Some(g) = g.filter(|g| g.expires >= self.now()) else { return Err(fail(403, "ckanban call only works inside an automation's check")) };
        let Some(p) = self.d.passes.find(service, Some(&g.passes), None) else {
            let names: Vec<String> = g.passes.iter().filter_map(|id| self.d.passes.get(id)).filter_map(|p| p.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string)).collect();
            let can = if names.is_empty() { "It has no connections.".to_string() } else { format!("It can use: {}.", names.join(", ")) };
            return Err(fail(404, format!("This automation can't use \"{service}\". {can}")));
        };
        static TOOL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[A-Za-z0-9_.:-]{1,100}$").unwrap());
        if !TOOL.is_match(tool) {
            return Err(fail(400, "That isn't a tool name"));
        }
        let pid = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let key = format!("{pid}:{tool}");
        if let Some(a) = &g.allowed
            && !a.contains(&key)
        {
            let name = p.get("name").and_then(Value::as_str).unwrap_or("");
            return Err(fail(403, format!("This automation may not use {name}'s {tool}: it can only use the tools its check used when it was saved. Save it again to allow more.")));
        }
        if let Some(live) = self.grants.lock().get_mut(token) {
            live.used.insert(key);
        }
        let body = json!({ "service": service, "tool": tool, "args": args, "passes": g.passes, "allowed": g.allowed });
        let answer = crate::tickets::writer::block(self.d.satellite.pass_call(body)).map_err(|e| fail(502, self.d.passes.mask(&e)))?;
        let rate = answer.get("rateLimitMs").and_then(Value::as_f64).unwrap_or(0.0);
        if rate > 0.0
            && let Some(live) = self.grants.lock().get_mut(token)
        {
            live.rate_limit_ms = live.rate_limit_ms.max(rate);
        }
        let status = answer.get("status").and_then(Value::as_u64).unwrap_or(502) as u16;
        let body = answer.get("body").cloned().unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            Ok(body.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(fail(status, body.get("error").and_then(Value::as_str).unwrap_or("the call failed").to_string()))
        }
    }

    /// `runWith`: runs a script with a grant for its passes; the grant ends with the run.
    fn run_with(&self, slug: &str, file: &std::path::Path, cwd: &std::path::Path, passes: &[String], allowed: Option<Vec<String>>) -> (ScriptRun, Grant) {
        let mut raw = [0u8; 24];
        if let Err(e) = getrandom::fill(&mut raw) {
            let run = ScriptRun { items: None, error: Some(format!("Could not start the check: no random token ({e})")), stderr: String::new(), duration_ms: 0.0 };
            return (run, Grant::default());
        }
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
        let grant = Grant { passes: passes.to_vec(), allowed, used: BTreeSet::new(), expires: self.now() + 10.0 * 60_000.0, rate_limit_ms: 0.0 };
        self.grants.lock().insert(token.clone(), grant);
        let shim = self.shim.lock().clone().unwrap_or_else(|| super::script::ckanban_shim(&self.d.root));
        let env = script_env(&shim, self.d.port, &token, &self.d.passes.env_for(passes, slug));
        let mut run = run_script(file, cwd, &env, SCRIPT_TIMEOUT_MS);
        let grant = self.grants.lock().remove(&token).unwrap_or_default();
        run.error = run.error.map(|e| self.d.passes.mask(&e));
        run.stderr = self.d.passes.mask(&run.stderr);
        (run, grant)
    }

    fn mask_item(&self, i: &Item) -> Item {
        let m = |s: &Option<String>| s.as_ref().map(|s| self.d.passes.mask(s));
        Item { id: i.id.clone(), title: self.d.passes.mask(&i.title), text: m(&i.text), link: m(&i.link), thread: m(&i.thread) }
    }

    fn tool_label(&self, key: &str) -> String {
        let mut parts = key.split(':');
        let id = parts.next().unwrap_or("");
        let tool = parts.next().unwrap_or("undefined");
        let name = self.d.passes.get(id).and_then(|p| p.get("name").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| id.to_string());
        format!("{name}: {tool}")
    }

    /// `test`: a trial run of a script that isn't saved; makes no tickets.
    pub fn test_script(&self, slug: &str, input: &Obj) -> Result<Value, Fail> {
        let Some(profile) = self.files.board(slug) else { return Err(fail(404, format!("board {slug} not found"))) };
        let script = input.get("script").map(js_str).unwrap_or_default();
        if js::trim(&script).is_empty() {
            return Err(fail(400, "There is no script to test"));
        }
        if js::len16(&script) > SCRIPT_MAX {
            return Err(fail(400, "The check script is too long"));
        }
        let passes = match input.get("passes") {
            None => Vec::new(),
            Some(v) => self.pass_ids(v, slug)?,
        };
        let dir = self.d.root.join("automation-tests");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("{}.sh", ckanban_core::atomic::new_id()));
        std::fs::write(&file, &script).map_err(|e| fail(500, e.to_string()))?;
        let cwd = std::path::PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
        let (run, grant) = self.run_with(slug, &file, &cwd, &passes, None);
        let _ = std::fs::remove_file(&file);
        let items: Vec<Item> = run.items.unwrap_or_default().iter().map(|i| self.mask_item(i)).collect();
        Ok(json!({
            "items": items.iter().take(PREVIEW).map(Item::to_json).collect::<Vec<_>>(), "found": items.len(), "error": run.error, "stderr": run.stderr,
            "durationMs": ckanban_core::jsnum::num(run.duration_ms), "toolsUsed": grant.used.iter().map(|k| self.tool_label(k)).collect::<Vec<_>>(),
        }))
    }

    /// `tick`: checks every switched-on automation that is due, one after another.
    pub fn tick_loops(self: &Arc<Self>) {
        if self.ticking.swap(true, Ordering::SeqCst) {
            return;
        }
        // Cleared however the tick ends (a panic in a check included), as Bun's `finally`.
        struct Done<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _done = Done(&self.ticking);
        for (slug, _) in self.files.boards() {
            for l in self.files.list_loops(&slug) {
                if l.get("enabled") != Some(&Value::Bool(true)) {
                    continue;
                }
                let id = st(&l, "id").to_string();
                let lock = self.loop_lock(&slug, &id);
                let _g = lock.lock();
                if let Err(e) = self.check(&slug, &id, false) {
                    eprintln!("automation {slug}/{id} check failed: {}", self.d.passes.mask(&e));
                }
            }
        }
    }

    /// `checkNow`: checks one automation now, ignoring its timer and its wait after a failure.
    pub fn check_now(&self, slug: &str, id: &str) -> Result<Obj, Fail> {
        let lock = self.loop_lock(slug, id);
        let _g = lock.lock();
        let l = self.get_loop(slug, id)?;
        if l.get("enabled") == Some(&Value::Bool(true))
            && let Err(e) = self.check(slug, id, true)
        {
            return Err(fail(500, e));
        }
        Ok(self.loop_view(slug, &self.get_loop(slug, id)?))
    }

    fn save_check(&self, slug: &str, id: &str, patch: Obj, st_patch: Obj) {
        let Some(mut cur) = self.files.get_loop(slug, id) else { return };
        cur.extend(patch);
        let _ = self.files.save_loop(slug, &cur);
        let mut stt = self.files.loop_state(slug, id);
        stt.extend(st_patch);
        let _ = self.files.save_loop_state(slug, id, &stt);
        self.emit_loop(slug, Some(&cur), id);
    }

    /// `check`: runs the script; what it finds for the first time becomes tickets (or goes into its thread's ticket).
    fn check(&self, slug: &str, id: &str, force: bool) -> Result<(), String> {
        let (Some(lp), Some(profile)) = (self.files.get_loop(slug, id), self.files.board(slug)) else { return Ok(()) };
        if lp.get("enabled") != Some(&Value::Bool(true)) {
            return Ok(());
        }
        let v = self.loop_view(slug, &lp);
        let now = self.now();
        let now_s = ckanban_core::time::iso(now);
        let state = self.files.loop_state(slug, id);
        if !force {
            if let Some(b) = state.get("backoffUntil").and_then(Value::as_str)
                && iso_ms(b) > now
            {
                return Ok(());
            }
            let every = lp.get("everyMinutes").and_then(Value::as_f64).unwrap_or(DEFAULT_EVERY);
            if let Some(last) = lp.get("lastCheckedAt").and_then(Value::as_str).filter(|s| !s.is_empty())
                && now - iso_ms(last) < every * 60_000.0 - 5_000.0
            {
                return Ok(());
            }
        }
        let vstate = st(&v, "state");
        if vstate == "unsupported" || vstate == "needs_connection" {
            return Ok(());
        }
        if vstate == "script_changed" {
            let first = v.get("problems").and_then(|p| p.get(0)).cloned().unwrap_or(Value::Null);
            if lp.get("lastError") != Some(&first) {
                self.save_check(slug, id, obj(json!({ "lastError": first })), Map::new());
            }
            return Ok(());
        }
        let failures = state.get("failures").and_then(Value::as_f64).unwrap_or(0.0);
        let fail_with = |message: &str, wait_ms: f64| {
            let n = failures + 1.0;
            let wait = if wait_ms > 0.0 { wait_ms } else { BACKOFF_MAX_MS.min(BACKOFF_MIN_MS * 2f64.powf(n - 1.0)) };
            self.save_check(
                slug,
                id,
                obj(json!({ "lastCheckedAt": now_s, "lastError": message })),
                obj(json!({ "failures": ckanban_core::jsnum::num(n), "backoffUntil": ckanban_core::time::iso(now + wait) })),
            );
        };
        let allowed = learned_tools(&lp);
        let cwd = std::path::PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
        let passes = strs(lp.get("passes"));
        let (run, grant) = self.run_with(slug, &self.files.script_file(slug, id), &cwd, &passes, allowed.clone());
        let Some(found) = run.items else {
            fail_with(run.error.as_deref().unwrap_or("The check failed"), grant.rate_limit_ms);
            return Ok(());
        };
        // Learned from the first good check that really calls tools.
        let learned = allowed.or_else(|| (!grant.used.is_empty()).then(|| grant.used.iter().cloned().collect()));
        let learned_v = learned.map(|l| json!(l)).unwrap_or(Value::Null);
        let items: Vec<Item> = found.iter().map(|i| self.mask_item(i)).collect();
        let mut seen: Vec<String> = strs(state.get("seen"));
        let mut seen_set: HashSet<String> = seen.iter().cloned().collect();
        let add_seen = |seen: &mut Vec<String>, set: &mut HashSet<String>, id: &str| {
            if set.insert(id.to_string()) {
                seen.push(id.to_string());
            }
        };
        let base_of = |i: &Item| {
            let mut m = obj(json!({ "id": i.id, "title": i.title }));
            if let Some(l) = &i.link {
                m.insert("link".into(), l.clone().into());
            }
            m
        };
        if state.get("primed") != Some(&Value::Bool(true)) {
            // The first check after a save or switching it on: what is there already never makes a ticket.
            for i in &items {
                add_seen(&mut seen, &mut seen_set, &i.id);
            }
            let last: Vec<Value> = items
                .iter()
                .take(PREVIEW)
                .map(|i| {
                    let mut m = base_of(i);
                    m.insert("state".into(), "first".into());
                    Value::Object(m)
                })
                .collect();
            self.save_check(
                slug,
                id,
                obj(json!({ "lastCheckedAt": now_s, "lastError": null, "allowedTools": learned_v })),
                obj(json!({ "seen": seen, "primed": true, "failures": 0, "backoffUntil": null, "lastFound": items.len(), "lastItems": last })),
            );
            return Ok(());
        }
        let name = st(&lp, "name").to_string();
        let service = st(&lp, "service").to_string();
        let auto_start = lp.get("autoStart") == Some(&Value::Bool(true));
        let ask = lp.get("askClaude").and_then(|a| a.get("on")) == Some(&Value::Bool(true));
        let ask_prompt = lp.get("askClaude").and_then(|a| a.get("prompt")).and_then(Value::as_str).unwrap_or("").to_string();
        let mut shown: Vec<Obj> = Vec::new();
        let mut fired: Option<String> = None;
        let (mut asked, mut made) = (0usize, 0usize);
        // Thread -> its ticket: a thread whose ticket is gone, or was put in Done without ever running, starts over.
        let open = |tid: &str| {
            self.d.tickets.get(slug, tid).is_some_and(|t| !(t.status == "done" && !js::truthy(t.get("runCount")) && !self.d.runs.is_running(slug, tid)))
        };
        let mut threads: Map<String, Value> = Map::new();
        if let Some(Value::Object(m)) = state.get("threads") {
            for (k, v) in m {
                if v.as_str().is_some_and(&open) {
                    threads.insert(k.clone(), v.clone());
                }
            }
        }
        let mut held: HashSet<String> = HashSet::new();
        let remember = |seen: &Vec<String>, threads: &Map<String, Value>| {
            let mut s = self.files.loop_state(slug, id);
            s.insert("seen".into(), json!(seen));
            s.insert("threads".into(), Value::Object(threads.clone()));
            let _ = self.files.save_loop_state(slug, id, &s);
        };
        for item in &items {
            let mut base = base_of(item);
            let with = |mut b: Obj, state: &str, extra: Value| {
                b.insert("state".into(), state.into());
                if let Value::Object(e) = extra {
                    b.extend(e);
                }
                b
            };
            if seen_set.contains(&item.id) {
                shown.push(with(base, "seen", Value::Null));
                continue;
            }
            if let Some(th) = item.thread.as_ref().filter(|t| held.contains(*t)) {
                let tid = threads.get(th).cloned().unwrap_or(Value::Null);
                shown.push(with(base, "waiting", json!({ "ticketId": tid, "note": "an earlier item of its thread waits, so this one does too" })));
                continue;
            }
            if made >= NEW_PER_CHECK {
                continue;
            }
            let mut decision: Option<Decision> = None;
            if ask {
                if asked >= ASK_PER_CHECK {
                    continue;
                }
                asked += 1;
                let r = self.side_call(SideCallInput {
                    system: DECISION_SYSTEM.into(),
                    prompt: decision_prompt(&ask_prompt, &service, item),
                    timeout_ms: Some(120_000),
                    ..Default::default()
                });
                let d = match r {
                    SideCallResult::Err { error, .. } => {
                        fail_with(&format!("Claude couldn't look at the item: {error}"), 0.0);
                        return Ok(());
                    }
                    SideCallResult::Ok { text, .. } => match parse_decision(&text) {
                        Some(d) => d,
                        None => {
                            fail_with("Claude's answer about the item couldn't be read", 0.0);
                            return Ok(());
                        }
                    },
                };
                if !d.create {
                    add_seen(&mut seen, &mut seen_set, &item.id);
                    remember(&seen, &threads);
                    shown.push(with(base, "skipped", json!({ "note": d.summary })));
                    continue;
                }
                decision = Some(d);
            }
            let summary = decision.as_ref().map(|d| d.summary.as_str());
            // A later item of a thread whose ticket is still there: it goes into that ticket.
            let into = item.thread.as_ref().and_then(|t| threads.get(t)).and_then(Value::as_str).map(str::to_string);
            if let Some(into) = into.filter(|t| open(t)) {
                let text = thread_item_text(&name, &service, item, summary);
                match self.automation_item(slug, &into, &text, id, &name, auto_start) {
                    Ok(how) => {
                        // Written down after it reached the ticket: a crash in between sends it twice rather than never.
                        add_seen(&mut seen, &mut seen_set, &item.id);
                        remember(&seen, &threads);
                        fired = Some(now_s.clone());
                        made += 1;
                        let extra = if how == "note" { json!({ "ticketId": into, "note": "left as a note: it reads it when it next runs" }) } else { json!({ "ticketId": into }) };
                        shown.push(with(base, "added", extra));
                    }
                    Err(e) => {
                        held.insert(item.thread.clone().unwrap_or_default());
                        let why = self.d.passes.mask(&e);
                        shown.push(with(base, "waiting", json!({ "ticketId": into, "note": format!("its ticket can't take it now ({why}); it goes in at the next check") })));
                        eprintln!("automation {slug}/{id}: item {} waits for the next check: {why}", item.id);
                    }
                }
                continue;
            }
            // Written down before the ticket, so a crash in between can't make a second ticket for the same item.
            add_seen(&mut seen, &mut seen_set, &item.id);
            remember(&seen, &threads);
            let title = ticket_title(decision.as_ref().map(|d| d.title.as_str()).filter(|t| !t.is_empty()).unwrap_or(&item.title));
            let instructions = if decision.is_some() { ASK_BODY.to_string() } else { st(&lp, "instructions").to_string() };
            let mut fields = obj(json!({
                "title": title,
                "body": ticket_body(&instructions, &service, item, summary),
                "source": { "provider": service, "label": ticket_title(&item.title), "url": item.link.clone().unwrap_or_default(), "loopId": id },
            }));
            let place = js::truthy(lp.get("partOf")).then(|| self.task_place_for(slug, st(&lp, "partOf")));
            let made_ticket = match &place {
                Some(Ok(p)) => {
                    fields.insert("status".into(), (if auto_start { "in_progress" } else { "backlog" }).into());
                    fields.insert("mode".into(), "auto".into());
                    self.create_feature_task(slug, p, fields, "automation", &name)
                }
                _ => {
                    let column = st(&lp, "column");
                    fields.insert("status".into(), (if column == "backlog" || !auto_start { "backlog" } else { column }).into());
                    self.d.tickets.create(slug, fields).map_err(|(_, e)| e)
                }
            };
            match made_ticket {
                Ok(t) => {
                    fired = Some(now_s.clone());
                    made += 1;
                    if let Some(th) = &item.thread {
                        threads.insert(th.clone(), t.id.clone().into());
                        remember(&seen, &threads);
                    }
                    let mut extra = obj(json!({ "ticketId": t.id }));
                    if let Some(Err(p)) = &place {
                        extra.insert("note".into(), format!("{}, so it got its own card.", for_tickets(p)).into());
                    }
                    base.insert("state".into(), "new".into());
                    base.extend(extra);
                    shown.push(base);
                }
                Err(e) => {
                    seen.retain(|s| s != &item.id);
                    seen_set.remove(&item.id);
                    remember(&seen, &threads);
                    fail_with(&format!("Could not create the ticket: {e}"), 0.0);
                    return Ok(());
                }
            }
        }
        let order = |s: &Obj| match st(s, "state") {
            "new" => 0,
            "added" => 1,
            "waiting" => 2,
            "skipped" => 3,
            "first" => 4,
            _ => 5,
        };
        shown.sort_by_key(order);
        let mut patch = obj(json!({ "lastCheckedAt": now_s, "lastError": null, "allowedTools": learned_v }));
        if let Some(f) = fired {
            patch.insert("lastFiredAt".into(), f.into());
        }
        let backoff = if grant.rate_limit_ms > 0.0 { Value::from(ckanban_core::time::iso(now + grant.rate_limit_ms)) } else { Value::Null };
        let last: Vec<Value> = shown.into_iter().take(PREVIEW).map(Value::Object).collect();
        self.save_check(
            slug,
            id,
            patch,
            obj(json!({ "seen": seen, "threads": threads, "failures": 0, "backoffUntil": backoff, "lastFound": items.len(), "lastItems": last })),
        );
        Ok(())
    }
}
