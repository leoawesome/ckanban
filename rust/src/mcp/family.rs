//! Tickets talking to tickets (src/mcp/family-tools.ts): chat, ask, merge into main, land, send files, stop,
//! comment, delete, report a bug.

use serde_json::{Map, Value, json};

use super::client::{R, err};
use super::js::{self, get, s, sh, t, trim};
use super::text::bug_report_text;
use super::{Ctx, opt_str, req_str};

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "chat_ticket" => chat_ticket(a, cx).await,
        "ask_ticket" => ask_ticket(a, cx).await,
        "merge_into_main" => merge_into_main(a, cx).await,
        "land_milestone" => land_milestone(a, cx).await,
        "send_file" => send_file(a, cx).await,
        "stop_ticket" => stop_ticket(a, cx).await,
        "comment_ticket" => comment_ticket(a, cx).await,
        "delete_ticket" => delete_ticket(a, cx).await,
        "report_bug" => report_bug(a, cx).await,
        _ => return None,
    })
}

async fn chat_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let tk = cx.client.chat(&slug, req_str(a, "id")?, req_str(a, "message")?, cx.run_env()).await?;
    let state = if t(&tk, "running") { "Claude is working on it".to_string() } else { format!("Ticket is in {}", sh(&tk, "status")) };
    Ok(format!("Sent to {}. {state}; read the reply later with get_ticket or on the board.", sh(&tk, "id")))
}

async fn ask_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let Some(me) = cx.run_ticket() else { return err("ask_ticket works inside a board run (the answer comes back to that run's ticket)") };
    let r = cx.client.ask_ticket(&slug, me, req_str(a, "id")?, req_str(a, "question")?, cx.run_env()).await?;
    Ok(sh(&r, "message"))
}

async fn merge_into_main(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let Some(me) = cx.run_ticket() else { return err("merge_into_main works inside a tool ticket's board run") };
    Ok(sh(&cx.client.merge_into_main(&slug, me, cx.run_env()).await?, "message"))
}

async fn land_milestone(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let Some(me) = cx.run_ticket() else { return err("land_milestone works inside the main ticket's board run") };
    Ok(sh(&cx.client.land_milestone(&slug, me, req_str(a, "summary")?, cx.run_env()).await?, "message"))
}

async fn send_file(a: &Value, cx: &Ctx) -> R<String> {
    let r = cx.client.send_telegram_file(req_str(a, "path")?, s(a, "caption").unwrap_or("")).await?;
    let bytes = get(&r, "bytes").and_then(Value::as_f64).unwrap_or(f64::NAN);
    // Math.max(1, Math.round(bytes / 1024)): JS rounds halves up.
    let kb = (bytes / 1024.0 + 0.5).floor().max(1.0);
    Ok(format!("Sent {} ({} KB) to the user's Telegram.", sh(&r, "sent"), js::num_str(kb)))
}

async fn stop_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = req_str(a, "id")?;
    let r = cx.client.stop(&slug, id, cx.run_env()).await?;
    Ok(if t(&r, "stopped") { format!("Stopped the run on {id}.") } else { format!("{id} had no run to stop.") })
}

async fn comment_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = req_str(a, "id")?;
    cx.client.comment(&slug, id, req_str(a, "text")?, cx.run_env()).await?;
    Ok(format!("Commented on {id}."))
}

async fn delete_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = req_str(a, "id")?;
    cx.client.delete_ticket(&slug, id).await?;
    Ok(format!("Deleted {id}."))
}

async fn report_bug(a: &Value, cx: &Ctx) -> R<String> {
    let ticket_id = opt_str(a, "ticketId");
    let slug = match ticket_id {
        Some(_) => Some(cx.slug(a).await?),
        None => None,
    };
    let mut include = vec!["env", "ticket"];
    if get(a, "includeLogs") != Some(&Value::Bool(false)) {
        include.push("log");
    }
    let mut input = Map::new();
    input.insert("title".into(), json!(trim(req_str(a, "title")?)));
    input.insert("description".into(), json!(req_str(a, "description")?));
    if let Some(s) = slug {
        input.insert("profile".into(), json!(s));
    }
    if let Some(t) = ticket_id {
        input.insert("ticketId".into(), json!(t));
    }
    input.insert("include".into(), json!(include));
    input.insert("source".into(), json!("ai"));
    Ok(bug_report_text(&cx.client.report_bug(&Value::Object(input)).await?))
}
