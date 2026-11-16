//! Moving work along (src/mcp/workflow-tools.ts): follow-ups, notifications, devices, moves, feature status,
//! gathering and plans.

use serde_json::{Map, Value, json};

use super::client::{HUDDLE_AGENT_ENV, R, err};
use super::js::{self, get, s, sh, t, trim};
use super::text::{device_take_text, gather_text, message_result_text};
use super::tickets::parse_status;
use super::{Ctx, hidden_tool, opt_str, req_str, with_you_tool};

/// TOOL_NO_NOTIFY in src/board/main-ticket.ts.
const TOOL_NO_NOTIFY: &str = "Tool tickets report to their main ticket; end your run with your question instead.";

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "follow_up" => follow_up(a, cx).await,
        "cancel_follow_up" => cancel_follow_up(a, cx).await,
        "notify_user" => notify_user(a, cx).await,
        "take_devices" => take_devices(a, cx).await,
        "release_devices" => release_devices(a, cx).await,
        "move_ticket" => move_ticket(a, cx).await,
        "update_status" => update_status(a, cx).await,
        "gather_tickets" => gather_tickets(a, cx).await,
        "plan_control" => plan_control(a, cx).await,
        _ => return None,
    })
}

/// urgencyError in src/mcp/form-tools.ts: urgent / why input the board refuses.
pub fn urgency_error(a: &Value) -> Option<&'static str> {
    if get(a, "urgent").is_some_and(|v| !v.is_boolean()) {
        return Some("urgent must be true or false");
    }
    if get(a, "why").is_some_and(|v| !v.is_string()) {
        return Some("why must be one line of text");
    }
    if s(a, "why").is_some_and(|w| js::utf16_len(w) > 300) {
        return Some("why is too long: keep it to one line");
    }
    None
}

/// deviceArg: names as a list of strings.
fn device_arg(a: &Value) -> R<Vec<String>> {
    match get(a, "names").and_then(Value::as_array) {
        Some(n) if n.iter().all(Value::is_string) => Ok(n.iter().filter_map(Value::as_str).map(str::to_string).collect()),
        _ => err("names must be a list of device names, e.g. [\"chrome-whatsapp\"]"),
    }
}

async fn follow_up(a: &Value, cx: &Ctx) -> R<String> {
    let Some(own) = cx.run_ticket() else { return err("follow_up works inside a board run or ticket chat, on its own ticket") };
    let slug = cx.slug(a).await?;
    let mut input = Map::new();
    input.insert("note".into(), json!(req_str(a, "note")?));
    if let Some(after) = opt_str(a, "after") {
        input.insert("after".into(), json!(after));
    }
    if let Some(at) = opt_str(a, "at") {
        input.insert("at".into(), json!(at));
    }
    if let Some(b) = js::bool_of(a, "cancelOnReply") {
        input.insert("cancelOnReply".into(), json!(b));
    }
    let tk = cx.client.set_follow_up(&slug, own, &Value::Object(input), cx.run_env()).await?;
    let f = get(&tk, "followUp").cloned().unwrap_or(Value::Null);
    let cancel = if t(&f, "cancelOnReply") { " It is cancelled if the user writes in this chat first." } else { "" };
    Ok(format!("Follow-up set: the board wakes this conversation at {} (local time).{cancel}", js::local_time_of(get(&f, "dueAt"))))
}

async fn cancel_follow_up(a: &Value, cx: &Ctx) -> R<String> {
    let Some(own) = cx.run_ticket() else { return err("cancel_follow_up works inside a board run or ticket chat, on its own ticket") };
    let slug = cx.slug(a).await?;
    cx.client.cancel_follow_up(&slug, own, req_str(a, "reason")?, cx.run_env()).await?;
    Ok("Stopped following up. The card says so with your reason.".into())
}

async fn notify_user(a: &Value, cx: &Ctx) -> R<String> {
    let Some(own) = cx.run_ticket() else { return err("notify_user works inside a board run or ticket chat, on its own ticket") };
    let slug = cx.slug(a).await?;
    let me = cx.client.get_ticket(&slug, own).await.ok();
    if hidden_tool(me.as_ref()) && !with_you_tool(me.as_ref()) {
        return err(TOOL_NO_NOTIFY);
    }
    if let Some(u) = urgency_error(a) {
        return err(u);
    }
    let mut body = Map::new();
    body.insert("message".into(), json!(req_str(a, "message")?));
    if js::is_true(a, "urgent") {
        body.insert("urgent".into(), json!(true));
    }
    if let Some(why) = s(a, "why").map(trim).filter(|w| !w.is_empty()) {
        body.insert("why".into(), json!(why));
    }
    let r = cx.client.notify_user(&slug, own, &Value::Object(body), cx.run_env()).await?;
    Ok(message_result_text(&r))
}

async fn take_devices(a: &Value, cx: &Ctx) -> R<String> {
    let own = cx.run_ticket();
    if own.is_none() || cx.env.get(HUDDLE_AGENT_ENV).is_some() {
        return err("take_devices works inside a board run or ticket chat, for its own ticket (not from a huddle)");
    }
    let slug = cx.slug(a).await?;
    let names = device_arg(a)?;
    Ok(device_take_text(&cx.client.take_devices(&slug, own.unwrap_or_default(), &names, cx.run_env()).await?))
}

async fn release_devices(a: &Value, cx: &Ctx) -> R<String> {
    let own = cx.run_ticket();
    if own.is_none() || cx.env.get(HUDDLE_AGENT_ENV).is_some() {
        return err("release_devices works inside a board run or ticket chat, for its own ticket (not from a huddle)");
    }
    let slug = cx.slug(a).await?;
    // Only a missing `names` means all of them (`args.names === undefined`); null is checked like any other value.
    let names = if js::has(a, "names") { Some(device_arg(a)?) } else { None };
    let r = cx.client.release_devices(&slug, own.unwrap_or_default(), names.as_deref(), cx.run_env()).await?;
    let released = js::arr(&r, "released");
    if released.is_empty() {
        return Ok("You weren't holding any of those, so nothing changed.".into());
    }
    Ok(format!("Let go of {}.", released.iter().map(|x| js::show(Some(x))).collect::<Vec<_>>().join(", ")))
}

async fn move_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = req_str(a, "id")?;
    let status = parse_status(Some(&json!(req_str(a, "status")?)))?;
    let tk = cx.client.update_ticket(&slug, id, &json!({ "status": status }), cx.run_env()).await?;
    if t(&tk, "selfMove") {
        return Ok(format!("{} moves to {} once this reply ends. Tell the user.", sh(&tk, "id"), sh(&tk, "selfMove")));
    }
    let running = if t(&tk, "running") { " (Claude is working on it)" } else { "" };
    Ok(format!("Moved {} to {}{running}.", sh(&tk, "id"), sh(&tk, "status")))
}

/// The feature a status or gather call is about: `id`, else the run's own ticket on its own board.
fn feature_id(a: &Value, cx: &Ctx, slug: &str) -> R<String> {
    if let Some(id) = s(a, "id").map(trim).filter(|x| !x.is_empty()) {
        return Ok(id.to_string());
    }
    match cx.run_profile().filter(|p| *p == slug).and(cx.run_ticket()) {
        Some(id) => Ok(id.to_string()),
        None => err("id is required outside a board run and for another board's feature"),
    }
}

async fn update_status(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = feature_id(a, cx, &slug)?;
    let mut patch = Map::new();
    for (from, to) in [("goal", "goal"), ("done", "done"), ("broken", "broken"), ("waitingOnYou", "waiting"), ("nextStep", "next")] {
        if let Some(v) = s(a, from) {
            patch.insert(to.into(), json!(v));
        }
    }
    if let Some(n) = get(a, "prNotes").filter(|n| js::truthy(Some(n)) && (n.is_object() || n.is_array())) {
        patch.insert("prNotes".into(), n.clone());
    }
    if let Some(p) = get(a, "prs").filter(|p| p.is_array()) {
        patch.insert("prs".into(), p.clone());
    }
    if patch.is_empty() {
        return err("nothing to update: pass goal, done, broken, waitingOnYou, nextStep, prNotes or prs");
    }
    let r = cx.client.update_status(&slug, &id, &Value::Object(patch), cx.run_env()).await?;
    Ok(format!("Updated the status of \"{}\" ({}). The whole status now:\n\n{}", sh(&r, "title"), sh(&r, "topId"), sh(&r, "markdown")))
}

async fn gather_tickets(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = feature_id(a, cx, &slug)?;
    let tickets = match get(a, "tickets") {
        Some(Value::Array(x)) if !x.is_empty() => Value::Array(x.clone()),
        _ => return err("tickets must list { id, group } entries"),
    };
    let r = cx.client.gather(&slug, &id, &tickets, s(a, "newGroup"), cx.run_env(), js::is_true(a, "hide")).await?;
    Ok(gather_text(&r))
}

async fn plan_control(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = match opt_str(a, "id").or(cx.run_ticket()) {
        Some(id) => id.to_string(),
        None => return err("id is required outside a board run"),
    };
    let action = match s(a, "action") {
        Some("resume") => "resume",
        Some("start") => "start",
        _ => return err("action must be start or resume"),
    };
    let tk = cx.client.plan_action(&slug, &id, action, cx.run_env()).await?;
    let state = get(&tk, "plan").filter(|p| !p.is_null()).and_then(|p| get(p, "state")).filter(|s| !s.is_null()).map_or("not started".into(), |s| js::show(Some(s)));
    Ok(format!(
        "Tool tickets of {}: {state}. The board starts them itself and wakes this ticket with their results; end your reply now.",
        sh(&tk, "id")
    ))
}
