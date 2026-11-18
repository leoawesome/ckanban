//! The run loop's routes in board mode (Bun's `ticket-cards.ts` chat and queue, `ticket-actions.ts` ask, stop, cap,
//! stall, limit, fresh session, take over, fresh chat, setup, `ticket-info.ts` follow-up, `ticket-files.ts` workflow
//! stop). They run inside `tickets::routes::Writes::answer`, after its gate, on a blocking thread; the ticket exists.

use std::sync::Arc;

use serde_json::{Value, json};

use super::board::{RunError, RunLoop, ts};
use super::types::ChatOptions;
use crate::tickets::rights::{Who, split_run};
use crate::tickets::routes::{Reply, Req, Writes, body_obj};
use crate::tickets::writer::{Refusal, bad, block};

/// The paths after `/api/profiles/:p/tickets/:id/` these routes take.
pub fn wanted(method: &str, rest: &[&str]) -> bool {
    matches!(
        (method, rest),
        ("POST", ["chat"])
            | ("POST" | "PATCH" | "DELETE", ["queued", _])
            | ("POST", ["link-session" | "branch" | "check-pr" | "follow-up-work"])
            | ("POST", ["pr", "refresh" | "send-failures" | "resolve-conflicts" | "merge"])
            | ("POST", ["ask" | "stop" | "cap-continue" | "stall" | "limit" | "fresh-session" | "take-over" | "fresh-chat" | "setup"])
            | ("GET", ["setup"])
            | ("POST" | "DELETE", ["follow-up"])
            | ("POST", ["follow-up", "now"])
            | ("POST", ["workflow", _, "stop"])
    )
}

fn err(e: RunError) -> Refusal {
    (e.status, e.message)
}

/// Bun's `catch (e) { if (e instanceof ConflictError) throw e; throw new HttpError(status, e.message) }`.
fn or(status: u16) -> impl Fn(RunError) -> Refusal {
    move |e| if e.is_conflict() { (409, e.message) } else { (status, e.message) }
}

fn s(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => crate::runs::js::to_string(v),
    }
}

/// `runTicket(req, slug)`: the run's ticket when it runs on this board.
fn run_ticket(req: &Req, slug: &str) -> Option<String> {
    let (s, id) = split_run(req.run.as_deref()?);
    (s == slug && !id.is_empty()).then_some(id)
}

pub fn answer(runs: &Arc<RunLoop>, w: &Writes, req: &Req, slug: &str, id: &str, rest: &[&str]) -> Result<Reply, Refusal> {
    let view = |id: &str| w.view_now_pub(slug, id);
    let m = req.method.as_str();
    match rest {
        ["chat"] => chat(runs, w, req, slug, id),
        ["queued", msg] => {
            let t = match m {
                "PATCH" => {
                    let b = body_obj(req)?;
                    let text = crate::runs::js::trim(&s(b.get("text"))).to_string();
                    if text.is_empty() {
                        return Err(bad("text is required"));
                    }
                    runs.edit_queued(slug, id, msg, &text)
                }
                "POST" => runs.send_queued(slug, id, msg),
                _ => runs.discard_queued(slug, id, msg),
            };
            t.map_err(or(404))?;
            Ok(Reply::Json(if m == "POST" { 202 } else { 200 }, view(id)))
        }
        ["link-session"] => {
            let b = body_obj(req)?;
            let sid = b.get("sessionId").filter(|v| crate::runs::js::truthy(Some(v))).map(|v| s(Some(v)));
            let t = block(runs.link_session(slug, id, sid.as_deref())).map_err(|e| (400, e.message))?;
            Ok(Reply::Json(200, w.view_pub(slug, &t)))
        }
        ["follow-up-work"] => {
            if req.run.is_some() {
                return Err((403, "follow-up work starts with the user's click on a proposal card; use the propose_ticket tool".into()));
            }
            let b = body_obj(req)?;
            let t = runs
                .follow_up_work(slug, id, &s(b.get("title")), &s(b.get("body")), crate::runs::js::truthy(b.get("start")), b.get("important") == Some(&Value::Bool(true)))
                .map_err(|e| (400, e.message))?;
            Ok(Reply::Json(201, w.view_pub(slug, &t)))
        }
        ["branch"] => {
            if req.run.is_some() {
                return Err((403, "branching is disabled inside a board run; use the propose_branch tool so the user can click Branch".into()));
            }
            let (t, warning) = block(runs.branch_ticket(slug, id)).map_err(or(400))?;
            Ok(Reply::Json(201, json!({ "ticket": w.view_pub(slug, &t), "warning": warning })))
        }
        ["check-pr"] => {
            let gh: Arc<dyn crate::git::pr::Gh> = Arc::new(crate::git::pr::GhCli);
            let state = block(crate::git::pr::check_pr_gh(&*runs.ops(), gh, slug, id));
            Ok(Reply::Json(200, json!({ "state": state, "ticket": view(id) })))
        }
        ["pr", what] => {
            if *what != "refresh" && req.run.is_some() {
                return Err((403, "only the user can merge a PR or send its CI failures or conflicts from the board".into()));
            }
            let ops = runs.ops();
            let gh = Arc::new(crate::git::pr::GhCli);
            if *what == "refresh" {
                let force = body_obj(req).ok().is_some_and(|b| crate::runs::js::truthy(b.get("force")));
                let age = if force { std::time::Duration::ZERO } else { std::time::Duration::from_millis(30_000) };
                let pr = block(crate::git::pr::refresh_pr(&*ops, gh, slug, id, Some(age))).map_err(|e| (502, e))?;
                return Ok(Reply::Json(200, json!({ "pr": pr, "ticket": view(id) })));
            }
            let r = match *what {
                "merge" => block(crate::git::pr::merge_pr(&*ops, &*gh, slug, id)),
                "resolve-conflicts" => block(crate::git::pr::resolve_conflicts(&*ops, &*gh, slug, id)),
                _ => block(crate::git::pr::send_failures(&*ops, &*gh, slug, id)),
            };
            r.map_err(|e| (e.status, e.message))?;
            Ok(Reply::Json(if *what == "merge" { 200 } else { 202 }, view(id)))
        }
        ["ask"] => {
            let asker = run_ticket(req, slug);
            if asker.as_deref() != Some(id) || req.huddle {
                return Err((403, "ask_ticket works from a board run, for that run's own ticket".into()));
            }
            let b = body_obj(req)?;
            let target_id = s(b.get("target"));
            let target = runs.tickets.get(slug, &target_id).ok_or_else(|| (404, format!("ticket {} not found", if b.get("target").is_none() { "undefined".into() } else { target_id.clone() })))?;
            let who = Who { tickets: &runs.tickets, hooks: runs.tickets.hooks() };
            let list = runs.tickets.list(slug);
            let root = |x: &str| crate::index::family::family_root(&list, x).map(|i| list.at(i).id.clone());
            if !who.in_family(slug, id, &target.id) && root(id) != root(&target.id) {
                return Err((403, format!("{} is not in this ticket's family", target.id)));
            }
            let msg = runs.ask_ticket(slug, id, &target.id, &s(b.get("question"))).map_err(|e| (400, e))?;
            Ok(Reply::Json(202, json!({ "message": msg })))
        }
        ["stop"] => {
            let target = runs.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
            let who = Who { tickets: &runs.tickets, hooks: runs.tickets.hooks() };
            let r = who.rights(req.run.as_deref(), req.huddle, slug, Some(&target))?;
            if target.main && req.run.is_none() {
                let (stopped, tools) = runs.stop_family(slug, id);
                return Ok(Reply::Json(200, json!({ "stopped": stopped, "tools": tools })));
            }
            let stopped = runs.stop(slug, id);
            if stopped {
                if r.planner.is_some() {
                    runs.note(slug, id, "Planner stopped this run.");
                }
                if let Some(q) = &r.requester {
                    runs.note(slug, id, &format!("Run stopped {}.", Who::by_request(q)));
                }
                if let Some(x) = &r.runner {
                    runs.note(slug, id, &format!("Run stopped {}.", Who::by_run(x)));
                }
                if let Some(g) = &r.guest {
                    runs.note(slug, id, &format!("Run stopped {}.", who.by_guest(g)));
                }
            }
            Ok(Reply::Json(200, json!({ "stopped": stopped })))
        }
        ["cap-continue"] => {
            if req.run.is_some() {
                return Err((403, "only the user can continue a ticket past its spending cap".into()));
            }
            let b = body_obj(req)?;
            let add = crate::runs::js::number(b.get("addUsd"));
            runs.continue_after_cap(slug, id, add).map_err(or(400))?;
            Ok(Reply::Json(202, view(id)))
        }
        ["stall"] => {
            if req.run.is_some() {
                return Err((403, "only the user can stop, keep waiting on or restart a stalled run".into()));
            }
            let b = body_obj(req)?;
            let action = b.get("action").and_then(Value::as_str).unwrap_or("");
            if !matches!(action, "stop" | "wait" | "restart") {
                return Err(bad("action must be stop, wait or restart"));
            }
            runs.stall_action(slug, id, action).map_err(|e| (409, e.message))?;
            Ok(Reply::Json(200, view(id)))
        }
        ["limit"] => {
            if req.run.is_some() {
                return Err((403, "only the user can continue a ticket after the usage limit or change its auto-continue".into()));
            }
            let b = body_obj(req)?;
            if b.get("action").and_then(Value::as_str) == Some("continue") {
                runs.continue_after_limit(slug, id, false).map_err(or(400))?;
                return Ok(Reply::Json(202, view(id)));
            }
            let Some(auto) = b.get("auto").and_then(Value::as_bool) else {
                return Err(bad("send {action: \"continue\"} or {auto: true|false}"));
            };
            runs.set_auto_continue(slug, id, auto).map_err(err)?;
            Ok(Reply::Json(200, view(id)))
        }
        ["fresh-session"] | ["take-over"] => {
            if req.run.is_some() {
                return Err((403, "session recovery is the user's call, not a run's".into()));
            }
            if rest == ["fresh-session"] {
                let t = runs.start_fresh(slug, id).map_err(or(400))?;
                return Ok(Reply::Json(200, json!({ "ticket": w.view_pub(slug, &t), "external": false })));
            }
            let (t, external) = block(runs.take_over(slug, id)).map_err(or(400))?;
            Ok(Reply::Json(200, json!({ "ticket": w.view_pub(slug, &t), "external": external })))
        }
        ["fresh-chat"] => {
            if req.run.is_some() {
                return Err((403, "a fresh chat is the user's call, not a run's".into()));
            }
            let t = runs.fresh_chat(slug, id).map_err(or(400))?;
            Ok(Reply::Json(200, w.view_pub(slug, &t)))
        }
        ["setup"] => {
            if m == "GET" {
                // Whether one runs now (and for how long) and whether a POST would start one: `ticket setup`'s first line.
                return Ok(Reply::Json(200, runs.git.setup_status(slug, id)));
            }
            if req.run.is_some() && run_ticket(req, slug).as_deref() != Some(id) {
                return Err((403, "a board run may only run the setup of its own ticket".into()));
            }
            let out = block(runs.git.run_setup(slug, id)).map_err(|e| (500, e))?;
            Ok(Reply::Json(200, out))
        }
        ["follow-up", rest2 @ ..] => {
            let caller = req.run.clone();
            if let Some(c) = &caller
                && (*c != format!("{slug}/{id}") || req.huddle)
            {
                return Err((403, "a run can only set or stop follow-ups on its own ticket".into()));
            }
            if m == "POST" && rest2 == ["now"] {
                if caller.is_some() {
                    return Err((403, "Follow up now is the user's button; set a follow-up with follow_up instead".into()));
                }
                runs.wake_follow_up(slug, id, true).map_err(err)?;
                return Ok(Reply::Json(202, view(id)));
            }
            if m == "POST" {
                let b = body_obj(req)?;
                let opt = |k: &str| match b.get(k) {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(s(Some(v))),
                };
                let cancel = match b.get("cancelOnReply") {
                    None => None,
                    Some(Value::Bool(x)) => Some(*x),
                    Some(_) => return Err(bad("cancelOnReply must be true or false")),
                };
                runs.set_follow_up(slug, id, opt("after").as_deref(), opt("at").as_deref(), opt("note").as_deref(), cancel).map_err(err)?;
                return Ok(Reply::Json(201, view(id)));
            }
            let b = body_obj(req).unwrap_or_default();
            let reason = b.get("reason").map(|v| s(Some(v)));
            runs.cancel_follow_up(slug, id, if caller.is_some() { "claude" } else { "user" }, reason.as_deref()).map_err(err)?;
            Ok(Reply::Json(200, view(id)))
        }
        ["workflow", tool, "stop"] => {
            if req.run.is_some() {
                return Err((403, "Stopping a workflow is the user's click, not a board run's".into()));
            }
            let t = runs.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
            let sid = ts(&t, "sessionId").map(str::to_string);
            let entry = sid.as_deref().and_then(|s| runs.sessions.entries(s).into_iter().find(|e| e.get("workflow").and_then(|w| w.get("toolUseId")).and_then(Value::as_str) == Some(tool)));
            let Some(wf) = entry.and_then(|e| e.get("workflow").cloned()) else {
                return Err((404, "no such workflow in this ticket's conversation".into()));
            };
            let Some(task) = wf.get("taskId").and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string) else {
                return Err(bad("this workflow hasn't started yet"));
            };
            if !runs.is_running(slug, id) {
                return Err(bad("this ticket isn't running"));
            }
            let out = block(runs.stop_workflow(slug, id, &task)).map_err(|e| (400, e.message))?;
            Ok(Reply::Json(200, out))
        }
        _ => Err((404, "not found".into())),
    }
}

/// `POST .../chat`.
fn chat(runs: &Arc<RunLoop>, w: &Writes, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
    let target = runs.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
    let who = Who { tickets: &runs.tickets, hooks: runs.tickets.hooks() };
    let r = who.rights(req.run.as_deref(), req.huddle, slug, Some(&target))?;
    let b = body_obj(req)?;
    let text = crate::runs::js::trim(&s(b.get("text"))).to_string();
    if text.is_empty() {
        return Err(bad("text is required"));
    }
    // undefined: leave startedBy; None: the user's message to a ticket that isn't working clears it.
    let started_by: Option<Option<Value>> = if let Some(x) = &r.runner {
        Some(Some(who.run_start(slug, x, Some(id))?))
    } else if let Some(g) = &r.guest {
        Some(Some(who.guest_start(g, Some(id))?))
    } else if r.planner.is_none() && r.requester.is_none() && !runs.is_running(slug, id) {
        Some(None)
    } else {
        None
    };
    let sender = r.runner.clone().or(r.planner.clone()).or(r.requester.clone()).or(r.guest.as_ref().map(|g| g.ticket.clone()));
    let fresh = b.get("fresh") == Some(&Value::Bool(true)) && sender.is_none() && req.run.is_none();
    let waited = !runs.is_running(slug, id) && crate::index::attention::user_wait_reason(&target, target.s("sessionId").filter(|s| !s.is_empty()).and_then(|s| runs.sessions.summary(s)).as_ref()).is_some();
    let (body, opts) = match &sender {
        Some(x) => (
            format!("Message from ticket {} (\"{}\"): {text}", x.id, x.title),
            ChatOptions { from_planner: true, from: Some(json!({ "ticketId": x.id, "title": x.title })), fresh, ..Default::default() },
        ),
        None => (text.clone(), ChatOptions { fresh, ..Default::default() }),
    };
    let t = runs.chat(slug, id, &body, opts).map_err(err)?;
    if let Some(by) = started_by {
        runs.tickets.mark_started_by(slug, id, by);
    }
    if req.run.is_none() && !text.starts_with('/') {
        runs.user_replied(slug, id);
    }
    if sender.is_none() && req.run.is_none() && !req.huddle && !text.starts_with('/')
        && let Some(main) = runs.close_questions_about(slug, &t, waited)
    {
        runs.emit_ticket(slug, &main);
    }
    if req.run.is_none() && !req.huddle && t.tool && t.kind.as_deref() != Some("with_you") {
        runs.families.note_user_message(slug, id, &text);
    }
    if let Some(q) = &r.requester {
        runs.note(slug, id, &format!("Message sent {}.", Who::by_request(q)));
    }
    if let Some(x) = &r.runner {
        runs.note(slug, id, &format!("Message sent {}.", Who::by_run(x)));
    }
    if let Some(g) = &r.guest {
        runs.note(slug, id, &format!("Message sent {}.", who.by_guest(g)));
    }
    let now = runs.tickets.get(slug, id).unwrap_or(t);
    Ok(Reply::Json(202, w.view_pub(slug, &now)))
}

impl RunLoop {
    /// `closeQuestionsAbout`: the user answered in a task's chat; a main ticket's question about it closes. The main
    /// ticket's id when it closed one.
    pub fn close_questions_about(&self, slug: &str, task: &crate::index::ticket::Tk, waited: bool) -> Option<String> {
        if !waited {
            return None;
        }
        let list = self.tickets.list(slug);
        let above = task.parent_link().and_then(|(p, _)| list.get(p)).cloned()?;
        let main = crate::index::family::main_of(&list, &above).map(|i| list.tickets[i].clone()).or_else(|| above.main.then(|| above.clone()))?;
        let sid = ts(&main, "sessionId")?;
        if self.is_running(slug, &main.id) || crate::index::family::ask_closed(&main) {
            return None;
        }
        let s = self.sessions.summary(sid)?;
        let form = s.get("openFormId").and_then(Value::as_str)?.to_string();
        let about = s.get("openAsk").and_then(|a| a.get("about")).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(&task.id)));
        if !crate::runs::js::truthy(s.get("openQuestions")) || !about || main.get("closedForms").and_then(|c| c.get(&form)).is_some_and(|v| crate::runs::js::truthy(Some(v))) {
            return None;
        }
        let run = main.get("runEndedAt").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!(""));
        let tid = task.id.clone();
        let _ = self.tickets.update_with(slug, &main.id, move |meta| {
            let mut c = meta.get("closedForms").and_then(Value::as_object).cloned().unwrap_or_default();
            c.insert(form, json!({ "at": super::board::now_iso(), "by": "task", "taskId": tid, "run": run }));
            Ok(super::board::obj(json!({ "closedForms": c })))
        });
        self.note(slug, &main.id, &format!("Closed the question about \"{}\": you answered it in that task's chat.", task.title));
        Some(main.id.clone())
    }
}
