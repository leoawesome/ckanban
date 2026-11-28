//! The routes of `src/api/schedules.ts` (`/api/profiles/:p/schedules`, `automation-setup`, `checkin-setup`,
//! `loops`, `jobs`) and `POST /api/automation-call` of `src/api/passes.ts`, answered in board mode. The server runs
//! Bun's gate first (Host, the Origin of a change, a JSON body type) and gives what it knows of the caller. Blocking:
//! call from the blocking pool.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::scheduler::editor;
use super::{Fail, Schedules, fail, js_str, obj};

/// One request, as the routes need it.
pub struct Req<'a> {
    pub method: &'a str,
    /// The decoded path parts after `/api/`.
    pub parts: &'a [String],
    pub query: &'a str,
    /// `x-ckanban-run` (`<board>/<ticket>`), as sent.
    pub run: Option<String>,
    pub huddle: bool,
    pub quick_chat: bool,
    /// A front desk request the user confirmed in Telegram (it acts as the user).
    pub confirmed: bool,
    /// On the phone access listener.
    pub phone: bool,
    pub origin: bool,
    pub body: &'a [u8],
    /// `userOnly(what)`: Err refuses (403).
    pub user: &'a (dyn Fn(&str) -> Result<(), Fail> + Sync),
    /// `isOutsideBoard`: the caller is a program the board didn't start.
    pub outside: &'a (dyn Fn() -> bool + Sync),
    /// A ticket's view as the board sends it.
    pub view: &'a (dyn Fn(&str, &str) -> Value + Sync),
}

/// An answer: status and JSON body (None: no body, 204).
pub type Answer = (u16, Option<Value>);

const SECTIONS: [&str; 5] = ["schedules", "automation-setup", "checkin-setup", "loops", "jobs"];

/// Whether these routes answer the path.
pub fn claims(parts: &[String]) -> bool {
    (parts.len() >= 3 && parts[0] == "profiles" && SECTIONS.contains(&parts[2].as_str())) || (parts.len() == 1 && parts[0] == "automation-call")
}

/// `(await body(req)) ?? {}`: Err for a body that isn't JSON; anything but an object reads as `{}`.
fn body(r: &Req) -> Result<Map<String, Value>, Fail> {
    let text = std::str::from_utf8(r.body).map_err(|_| fail(400, "invalid JSON body"))?;
    match crate::runs::js::parse(text).map(ckanban_core::jsnum::normalize) {
        Some(Value::Object(m)) => Ok(m),
        Some(_) => Ok(Map::new()),
        None => Err(fail(400, "invalid JSON body")),
    }
}

fn query(q: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// `runTicket`: the run's ticket, refused when it is another board's.
fn run_ticket(r: &Req, slug: &str) -> Result<Option<String>, Fail> {
    let Some(h) = r.run.as_deref().filter(|h| !h.is_empty()) else { return Ok(None) };
    let mut it = h.split('/');
    let run_slug = it.next().unwrap_or("");
    let run_id = it.next().unwrap_or("");
    if run_slug != slug || run_id.is_empty() {
        return Err(fail(403, format!("tickets can only talk to tickets on their own board ({run_slug})")));
    }
    Ok(Some(run_id.to_string()))
}

/// `scheduleDeleter`: who may really delete a schedule.
fn deleter(r: &Req) -> Result<(), Fail> {
    if r.confirmed {
        return Ok(());
    }
    if r.run.as_deref().is_some_and(|h| !h.is_empty()) || r.huddle {
        return Err(fail(
            403,
            "a board run or chat can't delete a schedule: call delete_schedule, which shows the user a card to confirm, or pause it with update_schedule enabled=false",
        ));
    }
    let refusal = "only the user deletes a schedule (in the board's Schedules window): a quick chat, a run's shell or a job's command can't. Pause it with update_schedule enabled=false, or ask the user to delete it in Schedules.";
    if r.quick_chat {
        return Err(fail(403, refusal));
    }
    if r.origin {
        return (r.user)("Deleting a schedule");
    }
    if r.phone || !(r.outside)() {
        return Err(fail(403, refusal));
    }
    Ok(())
}

fn ok(v: Value) -> Result<Answer, Fail> {
    Ok((200, Some(v)))
}

/// The answer, or None when these routes don't take the request (it goes on).
pub fn answer(s: &Arc<Schedules>, r: &Req) -> Option<Answer> {
    if !claims(r.parts) {
        return None;
    }
    Some(route(s, r).unwrap_or_else(|(status, m)| (status, Some(json!({ "error": m })))))
}

fn route(s: &Arc<Schedules>, r: &Req) -> Result<Answer, Fail> {
    let parts = r.parts;
    let m = r.method;
    let p = |i: usize| parts.get(i).map(String::as_str).unwrap_or("");
    let n = parts.len();
    if p(0) == "automation-call" {
        if m != "POST" {
            return Err(fail(404, "not found"));
        }
        let b = body(r)?;
        let text = |k: &str| b.get(k).map(js_str).unwrap_or_default();
        let result = s.call(&text("token"), &text("service"), &text("tool"), b.get("args").cloned().unwrap_or(Value::Null))?;
        return ok(json!({ "result": result }));
    }
    let slug = p(1);
    if s.files.board(slug).is_none() {
        return Err(fail(404, format!("board {slug} not found")));
    }
    match p(2) {
        "schedules" => {
            // Set by the MCP tools inside a board run: the edit is credited to that ticket.
            let run = r.run.as_deref().and_then(|h| h.split('/').nth(1)).unwrap_or("");
            let by_run = (!run.is_empty() && run.len() > 2 && run[..2].eq_ignore_ascii_case("t_") && run[2..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')).then_some(run);
            let by = editor(by_run);
            if n == 3 && m == "GET" {
                return ok(Value::Array(s.list_schedule_rows(slug)));
            }
            if n == 3 && m == "POST" {
                let sc = s.create_schedule(slug, &body(r)?, &by)?;
                return Ok((201, Some(Value::Object(s.schedule_view(slug, &sc)))));
            }
            let sid = p(3);
            if n == 4 && m == "PATCH" {
                let sc = s.update_schedule(slug, sid, &body(r)?, &by)?;
                return ok(Value::Object(s.schedule_view(slug, &sc)));
            }
            if n == 4 && m == "DELETE" {
                deleter(r)?;
                s.remove_schedule(slug, sid, &by)?;
                return Ok((204, None));
            }
            if n == 5 && p(4) == "history" && m == "GET" {
                return ok(Value::Array(s.schedule_history(slug, sid)?));
            }
            if n == 5 && p(4) == "run" && m == "POST" {
                if r.huddle {
                    return Err(fail(403, "huddle participants can't run a schedule now; ask @main"));
                }
                if let Some(t) = run_ticket(r, slug)?
                    && s.d.tickets.get(slug, &t).is_none()
                {
                    return Err(fail(404, format!("ticket {t} not found")));
                }
                let entry = s.run_schedule_now(slug, sid, by_run)?;
                let sc = s.get_schedule(slug, sid)?;
                return ok(json!({ "entry": entry, "schedule": s.schedule_view(slug, &sc) }));
            }
            Err(fail(404, "not found"))
        }
        "automation-setup" | "checkin-setup" if n == 3 && m == "POST" => {
            let automation = p(2) == "automation-setup";
            (r.user)(if automation { "Setting up an automation" } else { "Setting up check-ins" })?;
            let (title, text, flag) = if automation {
                (
                    "Set up an automation",
                    "Set up an automation for this board with Claude: say what to watch (for example \"new Linear issues assigned to me\") and how often to check.",
                    "automationSetup",
                )
            } else {
                (
                    "Set up proactive check-ins",
                    "Set up proactive check-ins with Claude: every work hour, Claude checks what needs you (messages, reviews, meetings coming up) and raises only that in Review. Pick what to check, your hours and what counts as urgent.",
                    "checkinSetup",
                )
            };
            let t = s.d.tickets.create(slug, obj(json!({ "title": title, "status": "planning", "body": text }))).map_err(|(st, e)| (st, e))?;
            let t = s.d.tickets.update_quiet(slug, &t.id, obj(json!({ flag: true }))).map_err(|(st, e)| (st, e))?;
            s.d.tickets.emit(slug, &t);
            Ok((201, Some((r.view)(slug, &t.id))))
        }
        "loops" => {
            if n == 3 && m == "GET" {
                return ok(Value::Array(s.list_loops(slug)));
            }
            if n == 4 && p(3) == "test" && m == "POST" {
                return ok(s.test_script(slug, &body(r)?)?);
            }
            (r.user)("Saving or changing an automation")?;
            if n == 3 && m == "POST" {
                let l = s.create_loop(slug, &body(r)?)?;
                // Its first check notes what is there already (no tickets) and fills "Last check found".
                check_later(s, slug, super::st(&l, "id"));
                return Ok((201, Some(Value::Object(l))));
            }
            let lid = p(3);
            if n == 4 && m == "PATCH" {
                let b = body(r)?;
                let l = s.update_loop(slug, lid, &b)?;
                // A new script or switching it on starts with a check that notes what is there.
                if l.get("enabled") == Some(&Value::Bool(true)) && super::st(&l, "state") == "ok" && (b.contains_key("script") || b.get("enabled") == Some(&Value::Bool(true))) {
                    check_later(s, slug, super::st(&l, "id"));
                }
                return ok(Value::Object(l));
            }
            if n == 4 && m == "DELETE" {
                s.remove_loop(slug, lid)?;
                return Ok((204, None));
            }
            if n == 5 && p(4) == "check" && m == "POST" {
                return ok(Value::Object(s.check_now(slug, lid)?));
            }
            if n == 5 && p(4) == "copy" && m == "POST" {
                let to = body(r)?.get("to").map(js_str).unwrap_or_default();
                return Ok((201, Some(Value::Object(s.copy_loop(slug, lid, &to)?))));
            }
            Err(fail(404, "not found"))
        }
        "jobs" => {
            if n == 3 && m == "GET" {
                let days = query(r.query, "finishedDays").map(|d| crate::runs::js::number_of_str(&d)).filter(|d| d.is_finite() && *d > 0.0).map(|d| d.min(365.0));
                // `?scheduledBy=a,b`: the jobs still waiting to run that a delete of those tickets would leave behind
                // (a main ticket counts with its tool tickets, which go with it).
                if let Some(ids) = query(r.query, "scheduledBy") {
                    let ids = s.doomed_ids(slug, &ids.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect::<Vec<_>>());
                    return ok(s.jobs_view(slug, &s.waiting_jobs_of(slug, &ids)));
                }
                let tid = query(r.query, "ticketId");
                return ok(s.jobs_view(slug, &s.list_jobs(slug, tid.as_deref(), days)));
            }
            if n == 4 && m == "GET" {
                return ok(s.job_view(slug, &s.get_job(slug, p(3))?));
            }
            if r.huddle {
                return Err(fail(403, "huddle participants can't schedule or change jobs; ask @main"));
            }
            let by = run_ticket(r, slug)?;
            if let Some(t) = &by
                && s.d.tickets.get(slug, t).is_none()
            {
                return Err(fail(404, format!("ticket {t} not found")));
            }
            let by = by.as_deref();
            if n == 3 && m == "POST" {
                return Ok((201, Some(s.job_view(slug, &s.create_job(slug, &body(r)?, by)?))));
            }
            let jid = p(3);
            if n == 4 && m == "PATCH" {
                return ok(s.job_view(slug, &s.update_job(slug, jid, &body(r)?, by)?));
            }
            if n == 5 && m == "POST" {
                if p(4) == "cancel" {
                    return ok(s.job_view(slug, &s.cancel_job(slug, jid, by)?));
                }
                if p(4) == "run" {
                    return ok(s.job_view(slug, &s.run_job_now(slug, jid, by)?));
                }
            }
            Err(fail(404, "not found"))
        }
        _ => Err(fail(404, "not found")),
    }
}

/// `void loops.checkNow(...)`: a check after the answer, on a thread of its own.
fn check_later(s: &Arc<Schedules>, slug: &str, id: &str) {
    let (s, slug, id) = (s.clone(), slug.to_string(), id.to_string());
    let run = move || {
        let _ = s.check_now(&slug, &id);
    };
    match tokio::runtime::Handle::try_current() {
        Ok(h) => drop(h.spawn_blocking(run)),
        Err(_) => drop(std::thread::spawn(run)),
    }
}
