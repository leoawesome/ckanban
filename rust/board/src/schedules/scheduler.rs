//! Repeating schedules (`src/schedules/scheduler.ts`): each tick, every switched-on schedule whose `nextRunAt` has
//! passed creates a ticket that runs right away (or a task of a feature). Runs missed while the board was off fire once
//! on the first tick, then the schedule moves on from now. Plus the list's figures (`src/api/schedules.ts`: spend over
//! 7 days, quiet checks per day, who paused it) and a quiet run's prompt context (`scheduleContext`).

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::cron;
use super::files::Obj;
use super::text::{fill_title, links_in, quiet_days, schedule_spend};
use super::{Fail, Schedules, fail, js_str, now_iso, obj, st};
use crate::runs::js;

/// A due time older than this when the scheduler sees it was missed.
const MISSED_AFTER_MS: f64 = 90_000.0;
const HISTORY_LIMIT: usize = 100;
/// Old prompt, title or cron kept in an "updated" history entry, cut to this many characters.
const PREVIOUS_MAX: usize = 2000;
const EDITABLE: [&str; 11] = ["name", "title", "body", "mode", "cron", "enabled", "skipIfRunning", "tags", "quiet", "model", "partOf"];

static MODEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,79}$").unwrap());
pub(crate) static ID_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").unwrap());

/// Who made an edit: "user" or `{ticketId}`.
pub fn editor(run: Option<&str>) -> Value {
    match run {
        Some(t) => json!({ "ticketId": t }),
        None => Value::from("user"),
    }
}

fn editor_text(by: &Value) -> String {
    match by.get("ticketId").and_then(Value::as_str) {
        Some(t) => format!("ticket {t}"),
        None => "the user".into(),
    }
}

/// `str(v, fallback)`: the fallback when the field is missing, else `String(v ?? "")`.
fn text_or(input: &Obj, k: &str, fallback: &str) -> String {
    match input.get(k) {
        None => fallback.to_string(),
        Some(v) => js_str(v),
    }
}

impl Schedules {
    fn emit_schedule(&self, slug: &str, id: &str, s: Option<&Obj>) {
        self.emit(json!({ "type": "schedule.updated", "profile": slug, "id": id, "schedule": s.cloned().map(Value::Object).unwrap_or(Value::Null) }));
    }

    fn next_run_at(&self, expr: &str) -> Option<String> {
        let c = cron::parse(expr).ok()?;
        cron::next_run(&c, self.now()).map(ckanban_core::time::iso)
    }

    /// `activeTicket`: the schedule's previous ticket while it is still queued or running.
    pub fn active_ticket(&self, slug: &str, id: &str) -> Option<String> {
        let list = self.d.tickets.list(slug);
        list.tickets
            .iter()
            .find(|t| t.s("scheduleId") == Some(id) && (t.status == "ready" || t.status == "in_progress" || self.d.runs.is_running(slug, &t.id)))
            .map(|t| t.id.clone())
    }

    /// `view`: the schedule with its cron in words, whether a run is going, and its feature's title.
    pub fn schedule_view(&self, slug: &str, s: &Obj) -> Obj {
        let mut v = s.clone();
        v.insert("summary".into(), cron::describe(st(s, "cron")).into());
        v.insert("active".into(), self.active_ticket(slug, st(s, "id")).is_some().into());
        if js::truthy(s.get("partOf")) {
            v.insert("partOfTitle".into(), self.title_of(slug, st(s, "partOf")).map(Value::from).unwrap_or(Value::Null));
        }
        v
    }

    /// The list's row: the view plus spend over 7 days, quiet checks per day and, for a paused one, when and by whom.
    pub fn schedule_row(&self, slug: &str, s: &Obj) -> Obj {
        let h = self.files.history_digest(slug, st(s, "id"));
        let cost_of = |tid: &str| if self.d.tickets.get(slug, tid).is_some() { self.spend.ticket(slug, tid).cost_usd } else { 0.0 };
        let from = ckanban_core::time::iso(self.now() - 7.0 * 86_400_000.0);
        let mut v = self.schedule_view(slug, s);
        v.insert("spend7dUsd".into(), ckanban_core::jsnum::num(schedule_spend(&h.recent, &from, &cost_of)));
        v.insert("quietPerDay".into(), Value::Array(quiet_days(&h.quiet_per_day).into_iter().take(7).collect()));
        if !js::truthy(s.get("enabled"))
            && let Some((at, by)) = h.last_pause
        {
            v.insert("pausedAt".into(), at.into());
            let by = match by.get("ticketId").and_then(Value::as_str) {
                Some(t) => json!({ "ticketId": t, "title": self.title_of(slug, t) }),
                None => Value::from("user"),
            };
            v.insert("pausedBy".into(), by);
        }
        v
    }

    pub fn list_schedule_rows(&self, slug: &str) -> Vec<Value> {
        self.files.list_schedules(slug).iter().map(|s| Value::Object(self.schedule_row(slug, s))).collect()
    }

    /// `validate`: the editable fields in Bun's order, over `base` for an edit.
    fn validate_schedule(&self, input: &Obj, base: Option<&Obj>) -> Result<Obj, Fail> {
        let b = |k: &str| base.map(|b| st(b, k)).unwrap_or("");
        let name = js::trim(&text_or(input, "name", b("name"))).to_string();
        let title = js::trim(&text_or(input, "title", b("title"))).to_string();
        let cron_expr = js::squash_ws(js::trim(&text_or(input, "cron", b("cron"))));
        if name.is_empty() {
            return Err(fail(400, "name is required"));
        }
        if title.is_empty() {
            return Err(fail(400, "ticket title is required"));
        }
        if cron_expr.is_empty() {
            return Err(fail(400, "cron expression is required"));
        }
        if let Some(e) = cron::error(&cron_expr) {
            return Err(fail(400, format!("invalid cron expression: {e}")));
        }
        let base_or = |k: &str, d: Value| base.and_then(|b| b.get(k)).filter(|v| !v.is_null()).cloned().unwrap_or(d);
        let mode = match input.get("mode") {
            None => base_or("mode", "auto".into()),
            Some(v) => Value::from(if v.as_str() == Some("interview") { "interview" } else { "auto" }),
        };
        let mut model = base_or("model", Value::Null);
        if let Some(v) = input.get("model") {
            let m = if v.is_null() { String::new() } else { js::trim(&js_str(v)).to_string() };
            if !m.is_empty() && !MODEL_RE.is_match(&m) {
                return Err(fail(400, format!("invalid model \"{m}\": use sonnet, opus, haiku or a model id")));
            }
            model = if m.is_empty() { Value::Null } else { m.into() };
        }
        let mut part_of = base_or("partOf", Value::Null);
        if let Some(v) = input.get("partOf") {
            let p = if v.is_null() { String::new() } else { js::trim(&js_str(v)).to_string() };
            if !p.is_empty() && !ID_RE.is_match(&p) {
                return Err(fail(400, format!("invalid partOf \"{p}\": use a ticket id")));
            }
            part_of = if p.is_empty() { Value::Null } else { p.into() };
        }
        let flag = |k: &str, d: bool| match input.get(k) {
            None => base_or(k, d.into()),
            Some(v) => Value::Bool(*v == Value::Bool(true)),
        };
        let mut out = Obj::new();
        out.insert("name".into(), name.into());
        out.insert("title".into(), title.into());
        out.insert("cron".into(), cron_expr.into());
        out.insert("mode".into(), mode);
        out.insert("body".into(), text_or(input, "body", b("body")).into());
        out.insert("enabled".into(), flag("enabled", true));
        out.insert("skipIfRunning".into(), flag("skipIfRunning", true));
        let tags = match input.get("tags") {
            None => base_or("tags", json!([])),
            Some(v) => json!(crate::tickets::norm::normalize_tags(Some(v))),
        };
        out.insert("tags".into(), tags);
        out.insert("quiet".into(), flag("quiet", false));
        out.insert("model".into(), model);
        out.insert("partOf".into(), part_of);
        Ok(out)
    }

    pub fn get_schedule(&self, slug: &str, id: &str) -> Result<Obj, Fail> {
        self.files.get_schedule(slug, id).ok_or_else(|| fail(404, format!("schedule {id} not found")))
    }

    fn log_edit(&self, slug: &str, id: &str, action: &str, fields: Vec<String>, by: &Value, previous: Option<Obj>) {
        let mut e = obj(json!({ "at": now_iso(), "kind": "edited", "action": action, "fields": fields, "by": by }));
        if let Some(p) = previous.filter(|p| !p.is_empty()) {
            e.insert("previous".into(), Value::Object(p));
        }
        self.files.append_history(slug, id, &Value::Object(e));
    }

    /// `checkPartOf`: a feature picked for the runs must be one they can go into now.
    fn check_part_of(&self, slug: &str, input: &Obj, fields: &Obj) -> Result<(), Fail> {
        if !input.contains_key("partOf") {
            return Ok(());
        }
        let p = st(fields, "partOf");
        if p.is_empty() {
            return Ok(());
        }
        self.task_place_for(slug, p).map(|_| ()).map_err(|e| fail(400, format!("partOf: {e}")))
    }

    pub fn create_schedule(&self, slug: &str, input: &Obj, by: &Value) -> Result<Obj, Fail> {
        let fields = self.validate_schedule(input, None)?;
        self.check_part_of(slug, input, &fields)?;
        let at = now_iso();
        let enabled = fields.get("enabled") == Some(&Value::Bool(true));
        let next = if enabled { self.next_run_at(st(&fields, "cron")) } else { None };
        let mut s = Obj::new();
        s.insert("id".into(), ckanban_core::atomic::new_id().into());
        s.extend(fields);
        s.insert("createdAt".into(), at.clone().into());
        s.insert("updatedAt".into(), at.into());
        s.insert("lastFiredAt".into(), Value::Null);
        s.insert("lastError".into(), Value::Null);
        s.insert("nextRunAt".into(), next.map(Value::from).unwrap_or(Value::Null));
        self.files.save_schedule(slug, &s).map_err(|e| fail(500, e))?;
        let id = st(&s, "id").to_string();
        self.log_edit(slug, &id, "created", vec![], by, None);
        self.emit_schedule(slug, &id, Some(&s));
        Ok(s)
    }

    pub fn update_schedule(&self, slug: &str, id: &str, input: &Obj, by: &Value) -> Result<Obj, Fail> {
        let current = self.get_schedule(slug, id)?;
        let fields = self.validate_schedule(input, Some(&current))?;
        self.check_part_of(slug, input, &fields)?;
        let mut next = current.clone();
        for (k, v) in fields {
            next.insert(k, v);
        }
        next.insert("updatedAt".into(), now_iso().into());
        let on = |o: &Obj| o.get("enabled") == Some(&Value::Bool(true));
        // Resuming starts from now (no backfill); edits that keep the timing keep the pending slot.
        if !on(&next) {
            next.insert("nextRunAt".into(), Value::Null);
        } else if !on(&current) || st(&next, "cron") != st(&current, "cron") || !js::truthy(current.get("nextRunAt")) {
            let n = self.next_run_at(st(&next, "cron"));
            next.insert("nextRunAt".into(), n.map(Value::from).unwrap_or(Value::Null));
        }
        self.files.save_schedule(slug, &next).map_err(|e| fail(500, e))?;
        let nul = |o: &Obj, k: &str| o.get(k).cloned().unwrap_or(Value::Null);
        let changed: Vec<String> = EDITABLE
            .iter()
            .filter(|k| match **k {
                "tags" => {
                    let j = |o: &Obj| o.get("tags").and_then(Value::as_array).map(|a| a.iter().map(js::to_string).collect::<Vec<_>>().join(",")).unwrap_or_default();
                    j(&next) != j(&current)
                }
                "quiet" => js::truthy(next.get("quiet")) != js::truthy(current.get("quiet")),
                "model" | "partOf" => nul(&next, k) != nul(&current, k),
                k => match (next.get(k), current.get(k)) {
                    (Some(a), Some(b)) => !js::strict_eq(a, b),
                    (None, None) => false,
                    _ => true,
                },
            })
            .map(|k| k.to_string())
            .collect();
        if !changed.is_empty() {
            let toggle = changed.len() == 1 && changed[0] == "enabled";
            let mut previous = Obj::new();
            for k in ["title", "body", "cron"] {
                if changed.iter().any(|c| c == k) {
                    previous.insert(k.into(), js::head16(st(&current, k), PREVIOUS_MAX).into());
                }
            }
            let action = if toggle { if on(&next) { "resumed" } else { "paused" } } else { "updated" };
            self.log_edit(slug, id, action, changed, by, Some(previous));
        }
        self.emit_schedule(slug, id, Some(&next));
        Ok(next)
    }

    /// `remove`: the schedule and its history go (the server's log is the only trace).
    pub fn remove_schedule(&self, slug: &str, id: &str, by: &Value) -> Result<String, Fail> {
        let s = self.get_schedule(slug, id)?;
        eprintln!("schedule {slug}/{id} ({}) deleted by {}", st(&s, "name"), editor_text(by));
        self.files.delete_schedule(slug, id);
        self.emit_schedule(slug, id, None);
        Ok(st(&s, "name").to_string())
    }

    /// `history`: newest first, each fire, skip or edit with its ticket's current state (null once it's gone).
    pub fn schedule_history(&self, slug: &str, id: &str) -> Result<Vec<Value>, Fail> {
        self.get_schedule(slug, id)?;
        let mut want = HISTORY_LIMIT * 2;
        let shown = loop {
            let (entries, complete) = self.files.history_tail(slug, id, want);
            let s = |e: &Value, k: &str| e.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let quiet: HashSet<String> = entries.iter().filter(|e| s(e, "kind") == "quiet").map(|e| s(e, "ticketId")).collect();
            let shown: Vec<Value> = entries.into_iter().filter(|e| !(s(e, "kind") == "fired" && quiet.contains(&s(e, "ticketId")))).collect();
            if complete || shown.len() >= HISTORY_LIMIT {
                break shown;
            }
            want *= 4;
        };
        let start = shown.len().saturating_sub(HISTORY_LIMIT);
        Ok(shown[start..]
            .iter()
            .rev()
            .map(|e| {
                let kind = e.get("kind").and_then(Value::as_str).unwrap_or("");
                let tid = if kind == "fired" || kind == "skipped" {
                    e.get("ticketId").and_then(Value::as_str).map(str::to_string)
                } else if kind == "edited" {
                    e.get("by").and_then(|b| b.get("ticketId")).and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                };
                let t = tid.and_then(|tid| self.d.tickets.get(slug, &tid));
                let mut out = obj(e.clone());
                let ticket = match t {
                    Some(t) => {
                        let mut m = obj(json!({ "id": t.id, "title": t.title, "status": t.status }));
                        if let Some(o) = t.get("outcome") {
                            m.insert("outcome".into(), o.clone());
                        }
                        m.insert("running".into(), self.d.runs.is_running(slug, &t.id).into());
                        Value::Object(m)
                    }
                    None => Value::Null,
                };
                out.insert("ticket".into(), ticket);
                Value::Object(out)
            })
            .collect())
    }

    /// `runNow`: fires now (skip-if-running applies); `by` is the run's ticket noted on the entry.
    pub fn run_schedule_now(&self, slug: &str, id: &str, by: Option<&str>) -> Result<Value, Fail> {
        let _g = self.fire_lock.lock();
        let s = self.get_schedule(slug, id)?;
        Ok(self.fire(slug, &s, "manual", by))
    }

    fn fire(&self, slug: &str, s: &Obj, trigger: &str, by: Option<&str>) -> Value {
        let now = self.now();
        let at = ckanban_core::time::iso(now);
        let sid = st(s, "id").to_string();
        let prev = if s.get("skipIfRunning") == Some(&Value::Bool(true)) { self.active_ticket(slug, &sid) } else { None };
        let mut last_error = s.get("lastError").cloned().unwrap_or(Value::Null);
        let mut fired = false;
        let mut entry = match prev {
            Some(p) => obj(json!({ "at": at, "kind": "skipped", "trigger": trigger, "ticketId": p })),
            None => match self.fire_ticket(slug, s, now) {
                Ok((tid, note)) => {
                    last_error = Value::Null;
                    fired = true;
                    let mut e = obj(json!({ "at": at, "kind": "fired", "trigger": trigger, "ticketId": tid }));
                    if let Some(n) = note {
                        e.insert("note".into(), n.into());
                    }
                    e
                }
                Err(message) => {
                    eprintln!("schedule {slug}/{sid} ({}) could not create its ticket: {message}", st(s, "name"));
                    last_error = message.clone().into();
                    obj(json!({ "at": at, "kind": "error", "trigger": trigger, "message": message }))
                }
            },
        };
        if let Some(t) = by {
            entry.insert("by".into(), json!({ "ticketId": t }));
        }
        // The schedule may have been edited or deleted while the ticket was being created.
        if let Some(mut current) = self.files.get_schedule(slug, &sid) {
            self.files.append_history(slug, &sid, &Value::Object(entry.clone()));
            current.insert("lastError".into(), last_error);
            // `lastFiredAt: fired ? at : current.lastFiredAt` (a missing one stays missing).
            if fired {
                current.insert("lastFiredAt".into(), at.into());
            }
            if let Err(e) = self.files.save_schedule(slug, &current) {
                eprintln!("[schedules] can't save {slug}/{sid}: {e}");
            }
            self.emit_schedule(slug, &sid, Some(&current));
        }
        Value::Object(entry)
    }

    /// The schedule's ticket (a task of its feature when it has one), and the note when it got its own card instead.
    fn fire_ticket(&self, slug: &str, s: &Obj, now: f64) -> Result<(String, Option<String>), String> {
        match self.board_folder(slug) {
            Err((false, _)) => return Err(format!("board {slug} no longer exists")),
            Err((true, p)) => return Err(format!("board folder {p} does not exist")),
            Ok(_) => {}
        }
        let place = js::truthy(s.get("partOf")).then(|| self.task_place_for(slug, st(s, "partOf")));
        let note = match &place {
            Some(Err(p)) => Some(format!("{p}, so this run got its own card.")),
            _ => None,
        };
        let mut input = obj(json!({
            "title": fill_title(st(s, "title"), now), "body": s.get("body").cloned().unwrap_or(Value::Null), "status": "in_progress",
            "mode": s.get("mode").cloned().unwrap_or(Value::Null), "scheduleId": st(s, "id"), "tags": s.get("tags").cloned().unwrap_or(json!([])),
        }));
        if js::truthy(s.get("model")) {
            input.insert("model".into(), s.get("model").cloned().unwrap_or(Value::Null));
        }
        let t = match place {
            Some(Ok(p)) => self.create_feature_task(slug, &p, input, "schedule", st(s, "name"))?,
            _ => self.d.tickets.create(slug, input).map_err(|(_, e)| e)?,
        };
        Ok((t.id.clone(), note))
    }

    /// `tick`: fire every enabled schedule that is due (one catch-up however many slots were missed).
    pub fn tick_schedules(&self) {
        let _g = self.fire_lock.lock();
        let now = self.now();
        for (slug, _) in self.files.boards() {
            for s in self.files.list_schedules(&slug) {
                if s.get("enabled") != Some(&Value::Bool(true)) || !js::truthy(s.get("nextRunAt")) {
                    continue;
                }
                let due = crate::runloop::followup::iso_ms(st(&s, "nextRunAt"));
                if due.is_nan() || due > now {
                    continue;
                }
                let trigger = if now - due > MISSED_AFTER_MS { "missed" } else { "schedule" };
                let mut moved = s.clone();
                moved.insert("nextRunAt".into(), self.next_run_at(st(&s, "cron")).map(Value::from).unwrap_or(Value::Null));
                if let Err(e) = self.files.save_schedule(&slug, &moved) {
                    eprintln!("[schedules] can't save {slug}/{}: {e}", st(&s, "id"));
                    continue;
                }
                self.fire(&slug, &moved, trigger, None);
            }
        }
    }

    /// `scheduleContext` (`board-tickets.ts`): for a quiet schedule, its last check and what it raised still open.
    pub fn schedule_context(&self, slug: &str, t: &crate::index::ticket::Tk) -> Option<crate::prompts::types::ScheduleRef> {
        use crate::prompts::types::{QuietContext, QuietOpen, ScheduleRef};
        let sid = t.s("scheduleId")?.to_string();
        let Some(s) = self.files.get_schedule(slug, &sid) else { return Some(ScheduleRef { id: sid, name: None, board: slug.into(), quiet: None }) };
        let quiet = js::truthy(s.get("quiet")).then(|| {
            let h = self.files.history_digest(slug, &sid);
            let last = h
                .last_fired
                .iter()
                .filter(|e| e.get("ticketId").and_then(Value::as_str) != Some(t.id.as_str()))
                .filter_map(|e| e.get("at").and_then(Value::as_str).map(str::to_string))
                .next_back();
            let list = self.d.tickets.list(slug);
            let mut open: Vec<_> = list
                .tickets
                .iter()
                .filter(|o| o.status != "done" && o.get("raisedBy").and_then(|r| r.get("scheduleId")).and_then(Value::as_str) == Some(sid.as_str()))
                .collect();
            open.sort_by(|a, b| js::locale_compare(&a.created_at, &b.created_at));
            QuietContext {
                last_check_at: last,
                open: open
                    .into_iter()
                    .map(|o| QuietOpen { id: o.id.clone(), title: o.title.clone(), status: o.status.clone(), created_at: o.created_at.clone(), links: links_in(&o.body) })
                    .collect(),
            }
        });
        Some(ScheduleRef { id: st(&s, "id").to_string(), name: Some(st(&s, "name").to_string()), board: slug.into(), quiet })
    }

    /// The history line of a quiet run whose ticket was removed (`endQuietly`), its cost in today's spend.
    pub fn quiet_ended(&self, slug: &str, sid: &str, ticket_id: &str, summary: &str, cost: f64) {
        self.add_day_spend(slug, cost);
        if let Some(s) = self.files.get_schedule(slug, sid) {
            let e = json!({
                "at": now_iso(), "kind": "quiet", "ticketId": ticket_id, "summary": js::head16(summary, 500),
                "costUsd": ckanban_core::jsnum::num((cost * 10_000.0).round() / 10_000.0),
            });
            self.files.append_history(slug, sid, &e);
            self.emit_schedule(slug, sid, Some(&s));
        }
    }
}

impl crate::runloop::board::ScheduleHooks for Schedules {
    fn context(&self, slug: &str, t: &crate::index::ticket::Tk) -> Option<crate::prompts::types::ScheduleRef> {
        self.schedule_context(slug, t)
    }
    fn quiet_ended(&self, slug: &str, schedule_id: &str, ticket_id: &str, summary: &str, cost_usd: f64) {
        Schedules::quiet_ended(self, slug, schedule_id, ticket_id, summary, cost_usd);
    }
}
