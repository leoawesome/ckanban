//! One-time jobs (`src/schedules/jobs.ts`): at a set time the board creates and starts a ticket, or runs a command
//! with no Claude. A job seen more than LATE_AFTER_MS past its time is late: a ticket job still starts (its run decides
//! whether the work still makes sense); a command job is skipped unless its action says `ifLate: "run"`. Each fire is
//! marked running before it starts, so a second tick or a restart never fires it again.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use super::files::Obj;
use super::text::describe_at;
use super::{Fail, Schedules, fail, now_iso, obj, st};
use crate::runloop::followup::{format_at, iso_ms, parse_at};
use crate::runs::js;

/// Due longer ago than this when the board sees it: late.
pub const LATE_AFTER_MS: f64 = 10.0 * 60_000.0;
pub const DEFAULT_TIMEOUT_SEC: u64 = 600;
const MAX_TIMEOUT_SEC: f64 = 24.0 * 3600.0;
/// Jobs that are over but still listed by default.
const RECENT_DONE: usize = 20;
/// A ticket job may not be scheduled from a ticket this deep in a job chain.
pub const MAX_CHAIN: usize = 10;
/// Output lines quoted in the comment a failed command leaves on its source ticket.
const FAIL_LINES: usize = 8;
const WHOLE_ACTION: &str = "send the whole action (kind and all its fields), not only the part you change";

fn is_open(j: &Obj) -> bool {
    st(j, "state") == "scheduled"
}

impl Schedules {
    fn save_job(&self, slug: &str, j: &Obj) -> Obj {
        let mut next = j.clone();
        next.insert("updatedAt".into(), now_iso().into());
        if let Err(e) = self.files.save_job(slug, &next) {
            eprintln!("[jobs] can't save {slug}/{}: {e}", st(j, "id"));
        }
        self.emit(json!({ "type": "job.updated", "profile": slug, "id": st(j, "id"), "job": next }));
        next
    }

    pub fn get_job(&self, slug: &str, id: &str) -> Result<Obj, Fail> {
        self.files.get_job(slug, id).ok_or_else(|| fail(404, format!("job {id} not found")))
    }

    /// `view`: the job with its due time in words.
    pub fn job_view(&self, j: &Obj) -> Value {
        let mut v = j.clone();
        v.insert("when".into(), describe_at(st(j, "at"), self.now()).into());
        Value::Object(v)
    }

    /// `list`: everything still to come, plus the most recent finished ones (or every one finished in
    /// `finished_days`); only the ticket's own with `ticket_id`.
    pub fn list_jobs(&self, slug: &str, ticket_id: Option<&str>, finished_days: Option<f64>) -> Vec<Obj> {
        let mine = |j: &Obj| ticket_id.is_none_or(|t| t.is_empty() || j.get("sourceTicketId").and_then(Value::as_str) == Some(t));
        let mut out: Vec<Obj> = self.files.open_jobs(slug).into_iter().filter(|j| mine(j)).collect();
        let key = |j: &Obj| j.get("firedAt").and_then(Value::as_str).unwrap_or(st(j, "updatedAt")).to_string();
        let mut over: Vec<Obj> = self.files.list_jobs(slug).into_iter().filter(|j| mine(j) && !is_open(j) && st(j, "state") != "running").collect();
        over.sort_by_key(|j| std::cmp::Reverse(key(j)));
        match finished_days {
            None => out.extend(over.into_iter().take(RECENT_DONE)),
            Some(days) => {
                let since = self.now() - days * 86_400_000.0;
                out.extend(over.into_iter().filter(|j| iso_ms(st(j, "updatedAt")) >= since));
            }
        }
        out
    }

    /// `action`: the action from the caller, checked.
    fn job_action(&self, v: Option<&Value>, base: Option<&Value>) -> Result<Value, Fail> {
        if v.is_none()
            && let Some(b) = base
        {
            return Ok(b.clone());
        }
        let Some(a) = v.and_then(Value::as_object) else {
            return Err(fail(400, "action is required: {kind: \"ticket\", title, body} or {kind: \"command\", command}"));
        };
        let text = |k: &str| a.get(k).and_then(Value::as_str);
        match text("kind") {
            Some("ticket") => {
                let title = text("title").map(js::trim).unwrap_or("").to_string();
                let body = text("body").unwrap_or("").to_string();
                if title.is_empty() {
                    return Err(fail(400, "a ticket job needs a title"));
                }
                if js::trim(&body).is_empty() {
                    return Err(fail(400, "a ticket job needs a body: the prompt the new ticket's run gets"));
                }
                let mode = if text("mode") == Some("interview") { "interview" } else { "auto" };
                Ok(json!({ "kind": "ticket", "title": title, "body": body, "mode": mode }))
            }
            Some("command") => {
                let command = text("command").map(js::trim).unwrap_or("").to_string();
                if command.is_empty() {
                    return Err(fail(400, "a command job needs a command"));
                }
                let if_late = a.get("ifLate");
                if if_late.is_some_and(|v| !v.is_null() && v.as_str() != Some("skip") && v.as_str() != Some("run")) {
                    return Err(fail(400, "ifLate must be \"skip\" (default) or \"run\""));
                }
                let mut out = obj(json!({ "kind": "command", "command": command }));
                match a.get("timeoutSec") {
                    None | Some(Value::Null) => {}
                    Some(t) => {
                        let t = js::number(Some(t));
                        if !t.is_finite() || !(1.0..=MAX_TIMEOUT_SEC).contains(&t) {
                            return Err(fail(400, format!("timeoutSec must be between 1 and {}", MAX_TIMEOUT_SEC as u64)));
                        }
                        out.insert("timeoutSec".into(), ckanban_core::jsnum::num((t + 0.5).floor()));
                    }
                }
                if if_late.and_then(Value::as_str) == Some("run") {
                    out.insert("ifLate".into(), "run".into());
                }
                Ok(Value::Object(out))
            }
            _ => Err(fail(400, "action.kind must be \"ticket\" or \"command\"")),
        }
    }

    fn future_at(&self, v: Option<&Value>) -> Result<String, Fail> {
        let d = parse_at(v.unwrap_or(&Value::Null)).map_err(|e| fail(400, e))?;
        let iso = ckanban_core::time::iso(d);
        if d <= self.now() {
            return Err(fail(400, format!("{} is in the past: pick a time from now on", describe_at(&iso, self.now()))));
        }
        Ok(iso)
    }

    /// `chain`: the jobs that led to this ticket, newest first: `(job, its source ticket, that ticket's title)`.
    pub fn job_chain(&self, slug: &str, ticket_id: Option<&str>) -> Vec<(Obj, Option<String>, Option<String>)> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut t = ticket_id.and_then(|id| self.d.tickets.get(slug, id));
        while let Some(job_id) = t.as_ref().and_then(|t| t.s("jobId")).filter(|j| !j.is_empty()).map(str::to_string) {
            if !seen.insert(job_id.clone()) {
                break;
            }
            let Some(job) = self.files.get_job(slug, &job_id) else { break };
            let src_id = job.get("sourceTicketId").and_then(Value::as_str).map(str::to_string);
            let src = src_id.as_deref().filter(|s| !s.is_empty()).and_then(|s| self.d.tickets.get(slug, s));
            out.push((job, src_id, src.as_ref().map(|s| s.title.clone())));
            t = src;
        }
        out
    }

    fn check_chain(&self, slug: &str, action: &Value, source: Option<&str>) -> Result<(), Fail> {
        let Some(source) = source.filter(|s| !s.is_empty()) else { return Ok(()) };
        if action.get("kind").and_then(Value::as_str) != Some("ticket") {
            return Ok(());
        }
        let depth = self.job_chain(slug, Some(source)).len();
        if depth >= MAX_CHAIN {
            return Err(fail(
                409,
                format!(
                    "ticket {source} is the end of a chain of {depth} tickets, each created by a job the one before scheduled; refusing to add another so a runaway loop stops here. For work that repeats, use create_schedule instead."
                ),
            ));
        }
        Ok(())
    }

    pub fn create_job(&self, slug: &str, input: &Obj, source: Option<&str>) -> Result<Obj, Fail> {
        if self.files.board(slug).is_none() {
            return Err(fail(404, format!("board {slug} not found")));
        }
        let name = input.get("name").and_then(Value::as_str).map(js::trim).unwrap_or("").to_string();
        if name.is_empty() {
            return Err(fail(400, "name is required"));
        }
        let at = self.future_at(input.get("at"))?;
        let action = self.job_action(input.get("action"), None)?;
        self.check_chain(slug, &action, source)?;
        let now = now_iso();
        let j = obj(json!({
            "id": ckanban_core::atomic::new_id(), "name": name, "at": at, "action": action, "state": "scheduled",
            "sourceTicketId": source, "createdAt": now, "updatedAt": now, "firedAt": null, "result": null,
        }));
        Ok(self.save_job(slug, &j))
    }

    /// `open`: only a job that hasn't run yet can change.
    fn open_job(&self, slug: &str, id: &str) -> Result<Obj, Fail> {
        let j = self.get_job(slug, id)?;
        if !is_open(&j) {
            return Err(fail(409, format!("job {id} is {}: only a scheduled job can be changed", st(&j, "state"))));
        }
        Ok(j)
    }

    /// `credit`: a run's change is noted on the job; the user's own change removes a run's earlier note.
    fn credit(&self, mut j: Obj, by: Option<&str>, action: &str) -> Obj {
        match by {
            Some(t) => {
                j.insert("changedBy".into(), json!({ "ticketId": t, "action": action, "at": now_iso() }));
            }
            None => {
                j.shift_remove("changedBy");
            }
        }
        j
    }

    pub fn update_job(&self, slug: &str, id: &str, input: &Obj, by: Option<&str>) -> Result<Obj, Fail> {
        let _g = self.job_lock.lock();
        let j = self.open_job(slug, id)?;
        let mut next = self.credit(j.clone(), by, "changed");
        if let Some(n) = input.get("name") {
            let name = n.as_str().map(js::trim).unwrap_or("").to_string();
            if name.is_empty() {
                return Err(fail(400, "name can't be empty"));
            }
            next.insert("name".into(), name.into());
        }
        if input.contains_key("action") {
            let a = self.job_action(input.get("action"), j.get("action")).map_err(|(s, m)| if s == 400 { (400, format!("{m}: {WHOLE_ACTION}")) } else { (s, m) })?;
            let source = j.get("sourceTicketId").and_then(Value::as_str);
            self.check_chain(slug, &a, source)?;
            if let Some(b) = by
                && Some(b) != source
            {
                self.check_chain(slug, &a, Some(b))?;
            }
            next.insert("action".into(), a);
        }
        if input.contains_key("at") {
            next.insert("at".into(), self.future_at(input.get("at"))?.into());
        }
        Ok(self.save_job(slug, &next))
    }

    pub fn cancel_job(&self, slug: &str, id: &str, by: Option<&str>) -> Result<Obj, Fail> {
        let _g = self.job_lock.lock();
        let mut j = self.credit(self.open_job(slug, id)?, by, "cancelled");
        j.insert("state".into(), "cancelled".into());
        Ok(self.save_job(slug, &j))
    }

    /// `runNow`: fires a scheduled job ahead of its time; a command keeps running after the answer.
    pub fn run_job_now(self: &Arc<Self>, slug: &str, id: &str, by: Option<&str>) -> Result<Obj, Fail> {
        let _g = self.job_lock.lock();
        self.recover_once();
        let j = self.credit(self.open_job(slug, id)?, by, "run now");
        Ok(self.fire_job(slug, j, false))
    }

    /// `failed`: saved as failed; a command's failure also leaves a quiet comment on the ticket that scheduled it.
    fn job_failed(&self, slug: &str, j: &Obj, result: Obj) -> Obj {
        let mut f = j.clone();
        f.insert("state".into(), "failed".into());
        f.insert("result".into(), Value::Object(result.clone()));
        let saved = self.save_job(slug, &f);
        let source = j.get("sourceTicketId").and_then(Value::as_str).filter(|s| !s.is_empty());
        let command = j.get("action").and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("command");
        if let Some(src) = source.filter(|s| command && self.d.tickets.get(slug, s).is_some()) {
            let output = result.get("output").and_then(Value::as_str).unwrap_or("");
            let lines: Vec<&str> = output.trim_end_matches(js::is_ws).split('\n').filter(|l| !js::trim(l).is_empty()).collect();
            let lines = &lines[lines.len().saturating_sub(FAIL_LINES)..];
            let tail = if lines.is_empty() { String::new() } else { format!("\n\nLast output:\n```\n{}\n```", lines.join("\n")) };
            let msg = result.get("message").and_then(Value::as_str).unwrap_or("unknown error");
            self.d.tickets.note(slug, src, &format!("Scheduled job '{}' failed: {msg}{tail}", st(j, "name")));
        }
        saved
    }

    /// `chainLine`: "Created by job 'B', scheduled by ticket t_2 ("…"), which was created by job 'A', ... (chain of 2)."
    fn chain_line(&self, slug: &str, j: &Obj) -> String {
        let source = j.get("sourceTicketId").and_then(Value::as_str).map(str::to_string);
        let src_title = source.as_deref().filter(|s| !s.is_empty()).and_then(|s| self.title_of(slug, s));
        let mut links = vec![(j.clone(), source.clone(), src_title.clone())];
        links.extend(self.job_chain(slug, source.as_deref()));
        if links.len() == 1 {
            let t = src_title.map(|t| format!(" (\"{t}\")")).unwrap_or_default();
            return format!("Scheduled by ticket {}{t} as job '{}'.", source.unwrap_or_default(), st(j, "name"));
        }
        let parts: Vec<String> = links
            .iter()
            .enumerate()
            .map(|(i, (job, tid, title))| {
                let by = match tid.as_deref().filter(|t| !t.is_empty()) {
                    Some(t) => format!(", scheduled by ticket {t}{}", title.as_ref().map(|x| format!(" (\"{x}\")")).unwrap_or_default()),
                    None => String::new(),
                };
                format!("{} by job '{}'{by}", if i > 0 { "which was created" } else { "Created" }, st(job, "name"))
            })
            .collect();
        format!("{} (chain of {}).", parts.join(", "), links.len())
    }

    fn fire_job(self: &Arc<Self>, slug: &str, j: Obj, late: bool) -> Obj {
        let action = j.get("action").cloned().unwrap_or(Value::Null);
        let a = |k: &str| action.get(k).and_then(Value::as_str).unwrap_or("");
        let command = a("kind") == "command";
        if late && command && a("ifLate") != "run" {
            let mut s = j.clone();
            s.insert("state".into(), "skipped".into());
            s.insert("result".into(), json!({ "message": format!("skipped: the computer was off at {}", format_at(st(&j, "at"))) }));
            return self.save_job(slug, &s);
        }
        let fired_at = now_iso();
        let mut r = j.clone();
        r.insert("state".into(), "running".into());
        r.insert("firedAt".into(), fired_at.clone().into());
        r.insert("result".into(), Value::Null);
        // Saved before anything starts: a second tick or a restart finds it running and leaves it alone.
        let running = self.save_job(slug, &r);
        let failed = |m: String| self.job_failed(slug, &running, obj(json!({ "message": m })));
        let folder: PathBuf = match self.board_folder(slug) {
            Ok(p) => p,
            Err((false, _)) => return failed(format!("board {slug} no longer exists")),
            Err((true, p)) => return failed(format!("the board folder {p} does not exist")),
        };
        if !command {
            let mut lines = Vec::new();
            if late {
                lines.push(format!(
                    "This was due {} but is running {} because the computer was off. Decide if it still makes sense: do it, adapt it, or stop and say why.",
                    format_at(st(&j, "at")),
                    format_at(&fired_at)
                ));
            }
            if j.get("sourceTicketId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
                lines.push(self.chain_line(slug, &j));
            }
            let intro = if lines.is_empty() { String::new() } else { format!("{}\n\n", lines.join("\n\n")) };
            let input = obj(json!({
                "title": a("title"), "body": format!("{intro}{}", a("body")), "status": "in_progress",
                "mode": action.get("mode").cloned().unwrap_or(Value::Null), "jobId": st(&j, "id"),
            }));
            return match self.d.tickets.create(slug, input) {
                Ok(t) => {
                    let mut done = running.clone();
                    done.insert("state".into(), "done".into());
                    done.insert("result".into(), json!({ "ticketId": t.id }));
                    self.save_job(slug, &done)
                }
                Err((_, e)) => {
                    eprintln!("job {slug}/{} ({}) could not create its ticket: {e}", st(&j, "id"), st(&j, "name"));
                    failed(format!("could not create the ticket: {e}"))
                }
            };
        }
        let id = st(&j, "id").to_string();
        let env = vec![
            ("CKANBAN_BOARD".to_string(), slug.to_string()),
            ("CKANBAN_JOB".to_string(), id.clone()),
            ("CKANBAN_SOURCE_TICKET".to_string(), j.get("sourceTicketId").and_then(Value::as_str).unwrap_or("").to_string()),
        ];
        let timeout = action.get("timeoutSec").and_then(Value::as_f64).map(|t| t as u64).unwrap_or(DEFAULT_TIMEOUT_SEC);
        let cmd = a("command").to_string();
        self.inflight.lock().insert(id.clone(), slug.to_string());
        let (me, slug2, running2) = (self.clone(), slug.to_string(), running.clone());
        std::thread::spawn(move || {
            let key = id.clone();
            let m2 = me.clone();
            let result = super::script::run_command(&cmd, &folder, &env, timeout, move |s| {
                m2.stops.lock().insert(key, s);
            });
            let ok = result.get("exitCode") == Some(&Value::from(0)) && result.get("timedOut") == Some(&Value::Bool(false)) && !result.contains_key("message");
            if ok {
                let mut done = running2.clone();
                done.insert("state".into(), "done".into());
                done.insert("result".into(), Value::Object(result));
                me.save_job(&slug2, &done);
            } else {
                me.job_failed(&slug2, &running2, result);
            }
            me.inflight.lock().remove(&id);
            me.stops.lock().remove(&id);
            me.d.runs.restart_work_changed();
        });
        running
    }

    /// `dropSource`: a deleted ticket's jobs that haven't run yet are cancelled.
    pub fn drop_source(&self, slug: &str, ticket_id: &str) {
        let _g = self.job_lock.lock();
        for j in self.files.open_jobs(slug) {
            if is_open(&j) && j.get("sourceTicketId").and_then(Value::as_str) == Some(ticket_id) {
                let mut c = j.clone();
                c.insert("state".into(), "cancelled".into());
                c.insert("result".into(), json!({ "message": "its ticket was deleted" }));
                self.save_job(slug, &c);
            }
        }
    }

    /// `recover` once, before any job fires (under `job_lock`).
    fn recover_once(&self) {
        if !self.jobs_recovered.swap(true, std::sync::atomic::Ordering::SeqCst) {
            self.recover_jobs();
        }
    }

    /// `recover`: after a restart, a command left running was cut off (failed); a ticket job left running either made
    /// its ticket (done) or never got that far (scheduled again).
    pub fn recover_jobs(&self) {
        for (slug, _) in self.files.boards() {
            for j in self.files.open_jobs(&slug) {
                if st(&j, "state") != "running" {
                    continue;
                }
                if j.get("action").and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("command") {
                    let mut r = j.get("result").and_then(Value::as_object).cloned().unwrap_or_default();
                    r.insert("message".into(), "interrupted by restart: the board stopped while the command was running".into());
                    self.job_failed(&slug, &j, r);
                    continue;
                }
                let list = self.d.tickets.list(&slug);
                let made = list.tickets.iter().find(|t| t.s("jobId") == Some(st(&j, "id"))).map(|t| t.id.clone());
                let mut next = j.clone();
                match made {
                    Some(tid) => {
                        next.insert("state".into(), "done".into());
                        next.insert("result".into(), json!({ "ticketId": tid }));
                    }
                    None => {
                        next.insert("state".into(), "scheduled".into());
                        next.insert("firedAt".into(), Value::Null);
                    }
                }
                self.save_job(&slug, &next);
            }
        }
    }

    /// `tick`: fire every job that is due; one seen more than LATE_AFTER_MS after its time fires late.
    pub fn tick_jobs(self: &Arc<Self>) {
        let _g = self.job_lock.lock();
        self.recover_once();
        let now = self.now();
        for (slug, _) in self.files.boards() {
            for j in self.files.open_jobs(&slug) {
                if !is_open(&j) {
                    continue;
                }
                let due = iso_ms(st(&j, "at"));
                if due.is_nan() || due > now {
                    continue;
                }
                let late = now - due > LATE_AFTER_MS;
                let action = j.get("action");
                let command = action.and_then(|a| a.get("kind")).and_then(Value::as_str) == Some("command");
                let runs_late = action.and_then(|a| a.get("ifLate")).and_then(Value::as_str) == Some("run");
                // A pending restart holds new work: a command waits for the next tick after it (a late one that would be
                // skipped anyway is skipped now).
                if command && self.d.runs.restart_pending() && !(late && !runs_late) {
                    continue;
                }
                self.fire_job(&slug, j, late);
            }
        }
    }
}
