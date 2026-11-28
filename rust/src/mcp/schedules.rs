//! Schedules and one-time jobs (src/mcp/schedule-tools.ts). propose_helper_rule, listed among them, runs on Bun.

use serde_json::{Map, Value, json};

use super::client::{FRONT_DESK_ENV, HUDDLE_AGENT_ENV, QUICK_CHAT_ENV, R, err};
use super::js::{self, arr, get, s, sh, t};
use super::tickets::parse_mode;
use super::{Ctx, hidden_tool, opt_str, req_str, tags_list};

/// QUICK_CHAT_NO_DELETE in src/mcp/shared.ts.
const QUICK_CHAT_NO_DELETE: &str = "Nothing was deleted: a quick chat can't show the user a delete card, and only the user deletes a schedule. Ask them to delete it in the board's Schedules window, or pause it now with update_schedule enabled=false (resume it later with enabled=true).";

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "list_schedules" => list_schedules(a, cx).await,
        "create_schedule" => create_schedule(a, cx).await,
        "update_schedule" => update_schedule(a, cx).await,
        "delete_schedule" => delete_schedule(a, cx).await,
        "run_schedule" => run_schedule(a, cx).await,
        "schedule_history" => schedule_history(a, cx).await,
        "schedule_job" => schedule_job(a, cx).await,
        "list_jobs" => list_jobs(a, cx).await,
        "update_job" => update_job(a, cx).await,
        "cancel_job" => cancel_job(a, cx).await,
        "run_job_now" => run_job_now(a, cx).await,
        _ => return None,
    })
}

/// scheduleLine.
fn schedule_line(sc: &Value) -> String {
    let mut state = vec![if t(sc, "enabled") { "active" } else { "paused" }];
    if t(sc, "active") {
        state.push("running");
    }
    let mut bits = vec![format!("{}  [{}]  {}: {} ({})", sh(sc, "id"), state.join(", "), sh(sc, "name"), sh(sc, "summary"), sh(sc, "cron"))];
    if t(sc, "enabled") && t(sc, "nextRunAt") {
        bits.push(format!("next {}", js::local_time_of(get(sc, "nextRunAt"))));
    }
    if t(sc, "lastFiredAt") {
        bits.push(format!("last ticket {}", js::local_time_of(get(sc, "lastFiredAt"))));
    }
    if t(sc, "lastError") {
        bits.push(format!("last run failed to start: {}", sh(sc, "lastError")));
    }
    if t(sc, "quiet") {
        bits.push("quiet when nothing needs the user".into());
    }
    if t(sc, "model") {
        bits.push(format!("model {}", sh(sc, "model")));
    }
    if t(sc, "partOf") {
        let title = if t(sc, "partOfTitle") { format!(" \"{}\"", sh(sc, "partOfTitle")) } else { " (ticket not found: runs get their own card)".into() };
        bits.push(format!("each run is a task of {}{title}", sh(sc, "partOf")));
    }
    bits.join("; ")
}

/// scheduleText.
fn schedule_text(sc: &Value) -> String {
    let mut lines = vec![
        schedule_line(sc),
        format!("ticket title: {}", sh(sc, "title")),
        format!("mode: {}, skip while previous runs: {}", sh(sc, "mode"), if t(sc, "skipIfRunning") { "yes" } else { "no" }),
    ];
    if js::len(sc, "tags") > 0 {
        lines.push(format!("tags: {}", arr(sc, "tags").iter().map(|x| js::show(Some(x))).collect::<Vec<_>>().join(", ")));
    }
    lines.push(String::new());
    let body = s(sc, "body").map(js::trim).unwrap_or("");
    lines.push(if body.is_empty() { "(no prompt)".into() } else { body.to_string() });
    lines.join("\n")
}

/// historyLine.
fn history_line(e: &Value) -> String {
    let tk = get(e, "ticket").filter(|x| js::truthy(Some(x)));
    let tline = tk.map(|tk| {
        let state = if t(tk, "running") {
            "running".to_string()
        } else {
            ["status", "outcome"].iter().filter(|k| t(tk, k)).map(|k| sh(tk, k)).collect::<Vec<_>>().join(", ")
        };
        format!("{} \"{}\" [{state}]", sh(tk, "id"), sh(tk, "title"))
    });
    let at = js::local_time_of(get(e, "at"));
    let kind = s(e, "kind").unwrap_or("");
    let by = get(e, "by").filter(|b| js::truthy(Some(b)));
    let by_ticket = by.filter(|b| b.as_str() != Some("user")).map(|b| sh(b, "ticketId"));
    let run_by = if kind != "edited" { by_ticket.as_ref().map(|t| format!(" by ticket {t}")).unwrap_or_default() } else { String::new() };
    match kind {
        "fired" => {
            let what = tline.unwrap_or_else(|| format!("{} (deleted)", sh(e, "ticketId")));
            let note = if t(e, "note") { format!(" ({})", sh(e, "note")) } else { String::new() };
            format!("{at}  fired ({}{run_by}): {what}{note}", sh(e, "trigger"))
        }
        "skipped" => format!("{at}  skipped ({}{run_by}): previous ticket {} still queued or running", sh(e, "trigger"), js::sh_or_empty(e, "ticketId")),
        "error" => format!("{at}  could not create the ticket ({}{run_by}): {}", sh(e, "trigger"), sh(e, "message")),
        "quiet" => format!("{at}  checked, nothing new: {}", js::sh_or_empty(e, "summary")),
        _ => {
            let who = match by_ticket {
                None => "the user".to_string(),
                Some(t) => format!("ticket {t}"),
            };
            let fields = if js::len(e, "fields") > 0 {
                format!(" {}", arr(e, "fields").iter().map(|x| js::show(Some(x))).collect::<Vec<_>>().join(", "))
            } else {
                String::new()
            };
            let prev = get(e, "previous")
                .and_then(Value::as_object)
                .map(|o| {
                    // Object.entries keeps the daemon's key order; serde_json sorts them, so put them back in the order
                    // the daemon writes them (title, body, cron).
                    let mut keys: Vec<&String> = o.keys().collect();
                    let rank = |k: &str| ["title", "body", "cron"].iter().position(|x| *x == k).unwrap_or(3);
                    keys.sort_by_key(|k| rank(k));
                    keys.iter()
                        .map(|k| format!("\n    previous {k}: {}", js::slice(&js::squash_space(&js::show(o.get(*k))), 0, Some(300))))
                        .collect::<String>()
                })
                .unwrap_or_default();
            format!("{at}  {}{fields} by {who}{prev}", sh(e, "action"))
        }
    }
}

/// scheduleInput: the fields to send; `partial` for an update.
fn schedule_input(a: &Value, partial: bool) -> R<Map<String, Value>> {
    let mut out = Map::new();
    for k in ["name", "title", "body", "cron"] {
        match s(a, k) {
            Some(v) => {
                out.insert(k.into(), json!(v));
            }
            None if !partial && k != "body" => return err(format!("{k} is required")),
            None => {}
        }
    }
    if js::has(a, "mode") {
        out.insert("mode".into(), json!(parse_mode(get(a, "mode"))?));
    }
    if let Some(m) = get(a, "model") {
        let Some(m) = m.as_str() else { return err("model must be a string") };
        let m = js::trim(m);
        out.insert("model".into(), if m.is_empty() { Value::Null } else { json!(m) });
    }
    if let Some(p) = get(a, "partOf") {
        if !p.is_null() && !p.is_string() {
            return err("partOf must be a ticket id, or \"\" to clear it");
        }
        let p = js::trim(p.as_str().unwrap_or(""));
        out.insert("partOf".into(), if p.is_empty() { Value::Null } else { json!(p) });
    }
    for k in ["enabled", "skipIfRunning", "quiet"] {
        let Some(v) = get(a, k) else { continue };
        let Some(b) = v.as_bool() else { return err(format!("{k} must be true or false")) };
        out.insert(k.into(), json!(b));
    }
    if let Some(tags) = tags_list(a, "tags")? {
        out.insert("tags".into(), json!(tags));
    }
    Ok(out)
}

async fn list_schedules(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let ss = cx.client.list_schedules(&slug).await?;
    let ss = ss.as_array().cloned().unwrap_or_default();
    if ss.is_empty() {
        return Ok(format!("Board {slug} has no schedules."));
    }
    Ok(format!("Schedules on board {slug}:\n{}", ss.iter().map(schedule_line).collect::<Vec<_>>().join("\n")))
}

async fn create_schedule(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let input = schedule_input(a, false)?;
    let sc = cx.client.create_schedule(&slug, &Value::Object(input), cx.run_env()).await?;
    let p = cx.client.cron_preview(&sh(&sc, "cron")).await.ok();
    let next = p.as_ref().map(|p| arr(p, "next")).filter(|n| !n.is_empty()).map_or(String::new(), |n| {
        format!("\nNext runs: {}", n.iter().map(|x| js::local_time_of(Some(x))).collect::<Vec<_>>().join(", "))
    });
    Ok(format!(
        "Created schedule {} on board {slug}: {}, {} ({}), {} mode.{next}\nThe user can see, pause or edit it in the board's Schedules dialog.",
        sh(&sc, "id"),
        sh(&sc, "name"),
        sh(&sc, "summary"),
        sh(&sc, "cron"),
        sh(&sc, "mode")
    ))
}

async fn update_schedule(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let patch = schedule_input(a, true)?;
    if patch.is_empty() {
        return err("nothing to change: pass name, title, body, cron, mode, enabled, skipIfRunning, tags, quiet, model or partOf");
    }
    let sc = cx.client.update_schedule(&slug, req_str(a, "id")?, &Value::Object(patch), cx.run_env()).await?;
    Ok(format!("Updated: {}", schedule_line(&sc)))
}

async fn delete_schedule(a: &Value, cx: &Ctx) -> R<String> {
    let id = req_str(a, "id")?;
    if cx.env.get(HUDDLE_AGENT_ENV).is_some() {
        return err("huddle participants can't delete schedules; ask @main");
    }
    let in_run = cx.run_env().is_some();
    // The front desk's request is held for the user's Confirm tap in Telegram (the daemon's answer says what to say).
    if !in_run && cx.env.get(FRONT_DESK_ENV).is_some() {
        let slug = cx.slug(a).await?;
        cx.client.delete_schedule(&slug, id, None).await?;
        return Ok(format!("Deleted schedule {id}."));
    }
    // A quick chat shows no cards, and the daemon refuses its deletes.
    if !in_run && cx.env.get(QUICK_CHAT_ENV).is_some() {
        return err(QUICK_CHAT_NO_DELETE);
    }
    if !in_run {
        let slug = cx.slug(a).await?;
        cx.client.delete_schedule(&slug, id, None).await?;
        return Ok(format!("Deleted schedule {id}."));
    }
    // A board run or chat: the card in this ticket's chat deletes it on the user's click.
    let slug = cx.slug(&Value::Object(Default::default())).await?;
    if s(a, "profile").is_some_and(|p| !js::trim(p).is_empty()) && cx.slug(a).await? != slug {
        return err(format!(
            "only schedules on this ticket's board ({slug}) can be proposed for deletion here; ask the user to delete it in that board's Schedules window."
        ));
    }
    let all = cx.client.list_schedules(&slug).await?;
    let Some(sc) = all.as_array().and_then(|x| x.iter().find(|x| s(x, "id") == Some(id))).cloned() else {
        return err(format!("no schedule {id} on board {slug}. Check list_schedules."));
    };
    // A tool ticket's chat is seen by nobody: its main ticket asks the user instead (refused, so no card shows).
    let own = cx.run_env().and_then(|r| r.split('/').nth(1)).unwrap_or("");
    let me = cx.client.get_ticket(&slug, own).await.ok();
    if hidden_tool(me.as_ref()) {
        return err(format!(
            "Nothing was deleted and no card was shown: this is a tool ticket, and the user doesn't see its chat. Put the request in your result for your main ticket (schedule {} \"{}\" and why it can go); your main ticket asks the user with delete_schedule in its own chat, where a card shows. If it only needs to stop for now, pause it with update_schedule enabled=false.",
            sh(&sc, "id"),
            sh(&sc, "name")
        ));
    }
    Ok(format!(
        "Nothing is deleted yet: the board shows the user a card in this ticket's chat for schedule \"{}\" ({}), and only their click on Delete removes it. You don't need to wait for it. If the goal is only to stop it for now, pause it with update_schedule enabled=false instead, and tell the user.",
        sh(&sc, "name"),
        sh(&sc, "summary")
    ))
}

async fn run_schedule(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    if cx.env.get(HUDDLE_AGENT_ENV).is_some() {
        return err("huddle participants can't run a schedule now; ask @main");
    }
    let r = cx.client.run_schedule(&slug, req_str(a, "id")?, &cx.caller()).await?;
    let entry = get(&r, "entry").cloned().unwrap_or(Value::Null);
    match s(&entry, "kind") {
        Some("fired") => Ok(format!("Started: created ticket {}, Claude is working on it.", sh(&entry, "ticketId"))),
        Some("skipped") => Ok(format!(
            "Skipped: the previous ticket {} from this schedule is still queued or running.",
            js::sh_or_empty(&entry, "ticketId")
        )),
        _ => err(format!("could not create the ticket: {}", sh(&entry, "message"))),
    }
}

async fn schedule_history(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = req_str(a, "id")?;
    let (all, h) = tokio::join!(cx.client.list_schedules(&slug), cx.client.schedule_history(&slug, id));
    let all = all?;
    let h = h?;
    let sc = all.as_array().and_then(|x| x.iter().find(|x| s(x, "id") == Some(id)));
    // Math.max(1, Math.min(100, Number(args.limit) || 20)).
    let limit = match get(a, "limit").map(js_number) {
        Some(n) if n != 0.0 && !n.is_nan() => n.min(100.0).max(1.0),
        _ => 20.0,
    };
    let entries = h.as_array().cloned().unwrap_or_default();
    let take = if limit.is_finite() { limit.trunc().max(0.0) as usize } else { entries.len() };
    // slice(0, 1.5) takes 1: slice truncates its end.
    let lines: Vec<String> = entries.iter().take(take).map(history_line).collect();
    let head = sc.map_or_else(|| format!("Schedule {id}"), schedule_text);
    Ok(format!("{head}\n\nHistory:\n{}", if lines.is_empty() { "(not run yet)".to_string() } else { lines.join("\n") }))
}

/// Number(v) for the JSON values a `limit` can be.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as u8 as f64,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = js::trim(s);
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => js_number(&Value::String(js::show(Some(&a[0])))),
        _ => f64::NAN,
    }
}

/// jobAction: the action as the daemon takes it.
fn job_action(v: Option<&Value>) -> R<Value> {
    let Some(v) = v.filter(|v| v.is_object() || v.is_array()) else {
        return err("action must be an object: {kind: \"ticket\", title, body} or {kind: \"command\", command}");
    };
    let text = |k: &str| match get(v, k) {
        None | Some(Value::Null) => String::new(),
        x => js::show(x),
    };
    match s(v, "kind") {
        Some("ticket") => {
            let mut out = Map::new();
            out.insert("kind".into(), json!("ticket"));
            out.insert("title".into(), json!(text("title")));
            out.insert("body".into(), json!(text("body")));
            if js::has(v, "mode") {
                out.insert("mode".into(), json!(parse_mode(get(v, "mode"))?));
            }
            Ok(Value::Object(out))
        }
        Some("command") => {
            let mut out = Map::new();
            out.insert("kind".into(), json!("command"));
            out.insert("command".into(), json!(text("command")));
            if let Some(t) = get(v, "timeoutSec") {
                let n = js_number(t);
                // JSON.stringify writes NaN as null.
                out.insert("timeoutSec".into(), serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number));
            }
            if let Some(l) = get(v, "ifLate") {
                out.insert("ifLate".into(), l.clone());
            }
            Ok(Value::Object(out))
        }
        _ => err("action.kind must be \"ticket\" or \"command\""),
    }
}

/// A delete's `cancelJobs` as the request's query: true is "all", a list of job ids is joined; false/absent is None.
pub(super) fn cancel_jobs_arg(v: Option<&Value>) -> Result<Option<String>, String> {
    const BAD: &str = "cancelJobs must be true (every waiting job the deleted tickets scheduled) or a list of job ids from list_jobs";
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::Bool(true)) => Ok(Some("all".into())),
        Some(Value::Array(a)) => {
            let ids: Vec<&str> = a.iter().map(|x| x.as_str().map(js::trim).filter(|x| !x.is_empty() && !x.contains(','))).collect::<Option<_>>().ok_or(BAD)?;
            Ok((!ids.is_empty()).then(|| ids.join(",")))
        }
        _ => Err(BAD.into()),
    }
}

/// "1 waiting job" / "3 waiting jobs".
pub(super) fn jobs_count(n: usize) -> String {
    format!("{n} waiting job{}", if n == 1 { "" } else { "s" })
}

/// "'Post on X' (j1, in 2 hours), ..." for an answer.
pub(super) fn jobs_names(jobs: &[&Value]) -> String {
    jobs.iter().map(|j| format!("'{}' ({}, {})", sh(j, "name"), sh(j, "id"), sh(j, "when"))).collect::<Vec<_>>().join(", ")
}

/// jobLine: id, state, time, what it does, how it went.
fn job_line(j: &Value) -> String {
    let action = get(j, "action").cloned().unwrap_or(Value::Null);
    let is_ticket = s(&action, "kind") == Some("ticket");
    let what = if is_ticket {
        format!("ticket \"{}\"", sh(&action, "title"))
    } else {
        format!("command `{}`", js::slice(&js::squash_space(&sh(&action, "command")), 0, Some(80)))
    };
    let mut bits = vec![format!("{}  [{}]  {}: {}, {what}", sh(j, "id"), sh(j, "state"), sh(j, "name"), sh(j, "when"))];
    if t(j, "sourceTicketId") {
        let title = if t(j, "sourceTicketTitle") { format!(" (\"{}\")", sh(j, "sourceTicketTitle")) } else { String::new() };
        if t(j, "sourceGone") {
            bits.push(format!("scheduled by a deleted ticket {}{title}; it still runs at its time", sh(j, "sourceTicketId")));
        } else {
            bits.push(format!("scheduled by {}", sh(j, "sourceTicketId")));
        }
    }
    if let Some(c) = get(j, "changedBy").filter(|c| js::truthy(Some(c))) {
        bits.push(format!("{} by {}", sh(c, "action"), sh(c, "ticketId")));
    }
    let r = get(j, "result").filter(|r| js::truthy(Some(r)));
    if let Some(r) = r {
        if t(r, "ticketId") {
            bits.push(format!("created ticket {}", sh(r, "ticketId")));
        }
        if s(&action, "kind") == Some("command") && s(j, "state") != Some("running") && (js::has(r, "exitCode") || t(r, "timedOut")) {
            bits.push(if t(r, "timedOut") { "timed out".into() } else { format!("exit {}", sh(r, "exitCode")) });
            if let Some(d) = get(r, "durationMs") {
                bits.push(format!("{} s", js::to_fixed(d.as_f64().unwrap_or(f64::NAN) / 1000.0, 1)));
            }
        }
        if t(r, "message") && !t(r, "timedOut") {
            bits.push(sh(r, "message"));
        }
    }
    bits.join("; ")
}

/// jobText: the line and the end of its output.
fn job_text(j: &Value) -> String {
    let out = get(j, "result").and_then(|r| s(r, "output")).map(js::trim).unwrap_or("");
    if out.is_empty() {
        return job_line(j);
    }
    format!("{}\nLast output:\n{}", job_line(j), js::slice(out, -1500, None))
}

async fn schedule_job(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let input = json!({ "name": req_str(a, "name")?, "at": req_str(a, "at")?, "action": job_action(get(a, "action"))? });
    let j = cx.client.create_job(&slug, &input, &cx.caller()).await?;
    Ok(format!("Scheduled job {} on board {slug}: {} runs {}.", sh(&j, "id"), sh(&j, "name"), sh(&j, "when")))
}

async fn list_jobs(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let tid = opt_str(a, "ticketId");
    let js_ = cx.client.list_jobs(&slug, tid).await?;
    let jobs = js_.as_array().cloned().unwrap_or_default();
    if jobs.is_empty() {
        return Ok(match tid {
            Some(t) => format!("Ticket {t} has no scheduled jobs."),
            None => format!("Board {slug} has no scheduled jobs."),
        });
    }
    let by = tid.map(|t| format!(" scheduled by {t}")).unwrap_or_default();
    Ok(format!("Jobs on board {slug}{by}:\n{}", jobs.iter().map(job_text).collect::<Vec<_>>().join("\n")))
}

async fn update_job(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let mut patch = Map::new();
    if let Some(n) = s(a, "name") {
        patch.insert("name".into(), json!(n));
    }
    if let Some(at) = s(a, "at") {
        patch.insert("at".into(), json!(at));
    }
    if js::has(a, "action") {
        match job_action(get(a, "action")) {
            Ok(x) => {
                patch.insert("action".into(), x);
            }
            Err(e) => return err(format!("{}: send the whole action (kind and all its fields), not only the part you change", e.text())),
        }
    }
    if patch.is_empty() {
        return err("nothing to change: pass name, at or action");
    }
    let j = cx.client.update_job(&slug, req_str(a, "id")?, &Value::Object(patch), &cx.caller()).await?;
    Ok(format!("Updated: {}", job_line(&j)))
}

async fn cancel_job(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let j = cx.client.job_action(&slug, req_str(a, "id")?, "cancel", &cx.caller()).await?;
    Ok(format!("Cancelled: {}", job_line(&j)))
}

async fn run_job_now(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let j = cx.client.job_action(&slug, req_str(a, "id")?, "run", &cx.caller()).await?;
    if s(&j, "state") == Some("failed") {
        let msg = get(&j, "result").and_then(|r| get(r, "message")).filter(|m| !m.is_null()).map_or("unknown error".into(), |m| js::show(Some(m)));
        return err(format!("job {} failed: {msg}", sh(&j, "id")));
    }
    if let Some(tid) = get(&j, "result").filter(|r| t(r, "ticketId")) {
        return Ok(format!("Started: created ticket {}, Claude is working on it.", sh(tid, "ticketId")));
    }
    Ok(format!("Started: {}. Check list_jobs for its exit code and output.", job_line(&j)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_lines() {
        let j = json!({"id": "j_1", "state": "done", "name": "N", "when": "Tue", "action": {"kind": "command", "command": "echo  hi"}, "result": {"exitCode": 0, "durationMs": 1234, "output": "x"}});
        assert_eq!(job_line(&j), "j_1  [done]  N: Tue, command `echo hi`; exit 0; 1.2 s");
        assert_eq!(job_text(&j), "j_1  [done]  N: Tue, command `echo hi`; exit 0; 1.2 s\nLast output:\nx");
    }

    #[test]
    fn a_job_of_a_deleted_ticket_says_so() {
        let j = json!({"id": "j_2", "state": "scheduled", "name": "Post", "when": "in 2 hours", "action": {"kind": "ticket", "title": "T"}, "sourceTicketId": "t_1", "sourceTicketTitle": "Launch", "sourceGone": true});
        assert_eq!(job_line(&j), "j_2  [scheduled]  Post: in 2 hours, ticket \"T\"; scheduled by a deleted ticket t_1 (\"Launch\"); it still runs at its time");
        let live = json!({"id": "j_3", "state": "scheduled", "name": "P", "when": "w", "action": {"kind": "ticket", "title": "T"}, "sourceTicketId": "t_1", "sourceTicketTitle": "Launch"});
        assert_eq!(job_line(&live), "j_3  [scheduled]  P: w, ticket \"T\"; scheduled by t_1");
    }

    #[test]
    fn cancel_jobs_argument() {
        assert_eq!(cancel_jobs_arg(None), Ok(None));
        assert_eq!(cancel_jobs_arg(Some(&json!(false))), Ok(None));
        assert_eq!(cancel_jobs_arg(Some(&json!(true))), Ok(Some("all".into())));
        assert_eq!(cancel_jobs_arg(Some(&json!(["a", " b "]))), Ok(Some("a,b".into())));
        assert_eq!(cancel_jobs_arg(Some(&json!([]))), Ok(None));
        assert!(cancel_jobs_arg(Some(&json!("all"))).is_err());
        assert!(cancel_jobs_arg(Some(&json!(["a,b"]))).is_err());
        assert!(cancel_jobs_arg(Some(&json!([1]))).is_err());
    }

    #[test]
    fn numbers_for_limits() {
        assert_eq!(js_number(&json!("7")), 7.0);
        assert!(js_number(&json!("x")).is_nan());
    }
}
