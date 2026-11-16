//! Boards and tickets (src/mcp/ticket-tools.ts): list, read, search chats, create, update, tag.

use serde_json::{Map, Value, json};

use super::client::{ListQuery, R, err};
use super::js::{self, get, s, sh, t, trim};
use super::text::{family_line, gather_text, profile_list, ticket_line, ticket_list_text, ticket_text};
use super::{Ctx, dep_list, needs_list, opt_str, req_str, tags_list};

const STATUSES: [&str; 6] = ["backlog", "planning", "ready", "in_progress", "review", "done"];

/// parseStatus: any case, spaces or dashes for underscores.
pub fn parse_status(v: Option<&Value>) -> R<String> {
    let raw = match v {
        None | Some(Value::Null) => String::new(),
        x => js::show(x),
    };
    let mut norm = String::new();
    let mut sep = false;
    for c in trim(&raw).to_lowercase().chars() {
        if c.is_whitespace() || c == '-' {
            if !sep {
                norm.push('_');
            }
            sep = true;
        } else {
            norm.push(c);
            sep = false;
        }
    }
    if STATUSES.contains(&norm.as_str()) {
        return Ok(norm);
    }
    err(format!("invalid status \"{}\"; use one of: {}", js::show(v), STATUSES.join(", ")))
}

/// parseMode.
pub fn parse_mode(v: Option<&Value>) -> R<String> {
    let raw = match v {
        None | Some(Value::Null) => String::new(),
        x => js::show(x),
    };
    let m = trim(&raw).to_lowercase();
    if m == "interview" || m == "auto" {
        return Ok(m);
    }
    err(format!("invalid mode \"{}\"; use interview or auto", js::show(v)))
}

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "list_profiles" => list_profiles(cx).await,
        "list_tickets" => list_tickets(a, cx).await,
        "get_ticket" => get_ticket(a, cx).await,
        "get_family" => get_family(a, cx).await,
        "search_chat" => search_chat(a, cx).await,
        "read_chat" => read_chat(a, cx).await,
        "create_ticket" => create_ticket(a, cx).await,
        "update_ticket" => update_ticket(a, cx).await,
        "suggest_tags" => suggest_tags(a, cx).await,
        _ => return None,
    })
}

async fn list_profiles(cx: &Ctx) -> R<String> {
    let ps = cx.client.list_profiles().await?;
    Ok(profile_list(ps.as_array().map_or(&[], Vec::as_slice)))
}

async fn list_tickets(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let q = ListQuery {
        status: if t(a, "status") { Some(parse_status(get(a, "status"))?) } else { None },
        tool: js::is_true(a, "includeTool"),
        query: s(a, "query").map(str::to_string),
        limit: js::num(a, "limit").filter(|l| *l > 0.0).map(|l| l.floor() as i64),
        after: s(a, "after").filter(|x| !trim(x).is_empty()).map(|x| trim(x).to_string()),
    };
    let page = cx.client.list_tickets(&slug, &q).await?;
    Ok(ticket_list_text(
        &slug,
        &page,
        &q,
        |after| format!("call list_tickets again with the same arguments and after: \"{after}\""),
        "list_tickets with status \"done\" pages through them, or query finds one",
    ))
}

async fn get_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let id = req_str(a, "id")?;
    let before = js::num(a, "commentsBefore").filter(|b| *b >= 0.0).map(|b| b.floor() as i64);
    let (tk, page) = tokio::join!(cx.client.get_ticket(&slug, id), cx.client.list_comments(&slug, id, before));
    let tk = tk?;
    let page = page?;
    let earlier = get(&page, "earlier").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let how = format!("call get_ticket with commentsBefore: {}", sh(&page, "earlier"));
    Ok(ticket_text(&tk, js::arr(&page, "comments"), Some((earlier, how))))
}

async fn get_family(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let rows = cx.client.get_family(&slug, req_str(a, "id")?).await?;
    let rows = rows.as_array().cloned().unwrap_or_default();
    if rows.len() <= 1 {
        let id = rows.first().map(|r| sh(r, "id")).unwrap_or(req_str(a, "id")?.to_string());
        return Ok(format!("{id} has no linked tickets yet: it is not part of a family."));
    }
    let mut lines = vec![format!("Family of {} tickets on board {slug}, from the top ticket down:", rows.len()), String::new()];
    lines.extend(rows.iter().map(family_line));
    Ok(lines.join("\n"))
}

async fn search_chat(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let ticket = opt_str(a, "ticket");
    if ticket.is_none() && cx.run_ticket().is_none() {
        return err("outside a board run, say which ticket's chat to search (ticket)");
    }
    let r = cx.client.search_chat(&slug, req_str(a, "query")?, ticket, js::is_true(a, "includeTools"), cx.run_env()).await?;
    Ok(sh(&r, "text"))
}

async fn read_chat(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let r = cx.client.read_chat(&slug, req_str(a, "ref")?, js::num(a, "before"), js::num(a, "after"), cx.run_env()).await?;
    Ok(sh(&r, "text"))
}

async fn create_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let deps = dep_list(a)?;
    let needs = needs_list(a)?;
    let tags = tags_list(a, "tags")?;
    let main = js::is_true(a, "main");
    let gather = get(a, "gather").and_then(Value::as_array).filter(|g| !g.is_empty());
    if !main && gather.is_some() {
        return err("gather only works with main: true (use gather_tickets to add tickets to an existing feature)");
    }
    let mut input = Map::new();
    input.insert("title".into(), json!(trim(req_str(a, "title")?)));
    input.insert("body".into(), json!(s(a, "body").unwrap_or("")));
    input.insert("status".into(), json!(if t(a, "status") { parse_status(get(a, "status"))? } else { "backlog".into() }));
    input.insert("mode".into(), json!(if t(a, "mode") { parse_mode(get(a, "mode"))? } else { "interview".into() }));
    if let Some(k) = opt_str(a, "key") {
        input.insert("planKey".into(), json!(trim(k)));
    }
    if let Some(d) = deps {
        input.insert("dependsOn".into(), json!(d));
    }
    if let Some(n) = needs.filter(|n| !n.is_empty()) {
        input.insert("needs".into(), json!(n));
    }
    if let Some(g) = tags.filter(|g| !g.is_empty()) {
        input.insert("tags".into(), json!(g));
    }
    // Only the run's own board: a guest chat on another board has no ticket here to be part of.
    if js::is_true(a, "partOfThisTicket") && cx.run_ticket().is_some() && cx.run_env().and_then(|r| r.split('/').next()) == Some(slug.as_str()) {
        input.insert("partOf".into(), json!(cx.run_ticket()));
    }
    if let Some(p) = opt_str(a, "partOf") {
        input.insert("partOf".into(), json!(trim(p)));
    }
    for key in ["kind", "model", "effort"] {
        if let Some(v) = opt_str(a, key) {
            input.insert(key.into(), json!(trim(v)));
        }
    }
    if main {
        input.insert("main".into(), json!(true));
        if let Some(g) = gather {
            input.insert("gather".into(), Value::Array(g.clone()));
        }
        if let Some(ng) = s(a, "newGroup") {
            input.insert("newGroup".into(), json!(ng));
        }
    }
    let tk = cx.client.create_ticket(&slug, &Value::Object(input), cx.run_env()).await?;
    let how = ["kind", "model"]
        .iter()
        .filter(|k| t(&tk, k))
        .map(|k| sh(&tk, k))
        .chain(t(&tk, "effort").then(|| format!("{} effort", sh(&tk, "effort"))))
        .collect::<Vec<_>>()
        .join(", ");
    let how = if how.is_empty() { String::new() } else { format!(" ({how})") };
    // Where the board put it instead of the partOf asked for, or whose step it is.
    if let Some(note) = s(&tk, "note").filter(|n| !n.is_empty()) {
        let wher = if t(&tk, "tool") {
            format!("tool ticket {} under {}", sh(&tk, "id"), sh(&tk, "parentId"))
        } else {
            let part = if t(&tk, "partOf") { format!(", part of {}", sh(&tk, "partOf")) } else { ", at the top level".into() };
            format!("{} in {} ({} mode){part}", sh(&tk, "id"), sh(&tk, "status"), sh(&tk, "mode"))
        };
        return Ok(format!("Created {wher}{how}: {}. {note}", sh(&tk, "title")));
    }
    if t(&tk, "main") {
        let mut parts = vec![format!("Created main ticket {} on board {slug} in {} ({} mode): {}", sh(&tk, "id"), sh(&tk, "status"), sh(&tk, "mode"), sh(&tk, "title"))];
        if let Some(g) = get(&tk, "gather").filter(|g| js::truthy(Some(g))) {
            parts.push(gather_text(g));
        }
        return Ok(parts.join("\n\n"));
    }
    if t(&tk, "tool") && t(&tk, "planPaused") {
        return Ok(format!(
            "Created tool ticket {}{how}: {}. It won't start yet: this feature's tasks are paused because the user pressed Stop. Tell the user it waits until they write in this chat or move this ticket to ready; don't say it is queued or started.",
            sh(&tk, "id"),
            sh(&tk, "title")
        ));
    }
    if t(&tk, "tool") {
        return Ok(format!(
            "Created tool ticket {}{how}: {}. The board starts it when its dependsOn are done and wakes you with its result.",
            sh(&tk, "id"),
            sh(&tk, "title")
        ));
    }
    let part = if t(&tk, "partOf") { format!(", part of {}", sh(&tk, "partOf")) } else { String::new() };
    Ok(format!("Created {} on board {slug} in {} ({} mode){part}{how}: {}", sh(&tk, "id"), sh(&tk, "status"), sh(&tk, "mode"), sh(&tk, "title")))
}

async fn update_ticket(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let mut patch = Map::new();
    if let Some(title) = s(a, "title").filter(|x| !trim(x).is_empty()) {
        patch.insert("title".into(), json!(trim(title)));
    }
    if let Some(body) = s(a, "body") {
        patch.insert("body".into(), json!(body));
    }
    if t(a, "status") {
        patch.insert("status".into(), json!(parse_status(get(a, "status"))?));
    }
    if t(a, "mode") {
        patch.insert("mode".into(), json!(parse_mode(get(a, "mode"))?));
    }
    if let Some(d) = dep_list(a)? {
        patch.insert("dependsOn".into(), json!(d));
    }
    if let Some(n) = needs_list(a)? {
        patch.insert("needs".into(), json!(n));
    }
    if let Some(g) = tags_list(a, "tags")? {
        patch.insert("tags".into(), json!(g));
    }
    if js::is_true(a, "release") {
        patch.insert("parentId".into(), Value::Null);
    }
    if let Some(b) = js::bool_of(a, "important") {
        patch.insert("important".into(), json!(b));
    }
    if let Some(b) = js::bool_of(a, "showOnBoard") {
        patch.insert("showOnBoard".into(), json!(b));
    }
    if patch.is_empty() {
        return err("nothing to change: pass title, body, status, mode, dependsOn, needs, tags, important, release or showOnBoard");
    }
    let tk = cx.client.update_ticket(&slug, req_str(a, "id")?, &Value::Object(patch), cx.run_env()).await?;
    Ok(format!("Updated {}: {}", sh(&tk, "id"), ticket_line(&tk)))
}

async fn suggest_tags(a: &Value, cx: &Ctx) -> R<String> {
    let tags = tags_list(a, "tags")?.unwrap_or_default();
    if tags.is_empty() {
        return err("tags must list at least one tag name, e.g. [\"post\"]");
    }
    let id = match s(a, "id").map(trim).filter(|x| !x.is_empty()).or(cx.run_ticket()) {
        Some(id) => id.to_string(),
        None => return err("id is required outside a board run"),
    };
    let slug = cx.slug(a).await?;
    let tk = cx.client.get_ticket(&slug, &id).await?;
    let has: Vec<&str> = js::arr(&tk, "tags").iter().filter_map(Value::as_str).collect();
    let fresh: Vec<&String> = tags.iter().filter(|g| !has.contains(&g.as_str())).collect();
    if fresh.is_empty() {
        let all = tags.iter().map(|g| format!("#{g}")).collect::<Vec<_>>().join(" ");
        return Ok(format!("{} already has {all}; nothing to suggest.", sh(&tk, "id")));
    }
    let mut suggested: Vec<Value> = js::arr(&tk, "suggestedTags").to_vec();
    suggested.extend(fresh.iter().map(|g| json!(g)));
    let u = cx.client.update_ticket(&slug, &id, &json!({ "suggestedTags": suggested }), cx.run_env()).await?;
    let shown = fresh.iter().map(|g| format!("#{g}")).collect::<Vec<_>>().join(" ");
    Ok(format!("Suggested {shown} on {}: the user keeps or drops them on the board.", sh(&u, "id")))
}
