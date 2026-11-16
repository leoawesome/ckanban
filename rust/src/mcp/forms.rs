//! Chat cards and automation setup (src/mcp/form-tools.ts, src/mcp/connection-tools.ts): ask_questions,
//! propose_ticket, propose_branch, propose_delete, list_connections, connection_tools, test_automation_script.
//! The other tools of those files run on Bun (`ON_BUN` in mod.rs).

use std::collections::HashSet;

use serde_json::Value;

use super::client::{R, err};
use super::js::{self, arr, get, s, sh, t, trim, utf16_len};
use super::workflow::urgency_error;
use super::{Ctx, SHOWN, hidden_tool, with_you_tool};

const MAX_TITLE: usize = 80;
const MAX_BARE_QUESTION: usize = 200;

/// TOOL_NO_QUESTIONS: ask_questions inside a tool ticket's run.
const TOOL_NO_QUESTIONS: &str = "This is a tool ticket: it never asks the user. End your run with status \"questions\" and put the question in your summary instead; your parent ticket answers it with a message that resumes you.";

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "ask_questions" => ask_questions(a, cx).await,
        "propose_ticket" => propose_ticket(a),
        "propose_branch" => propose_branch(a),
        "propose_delete" => propose_delete(a, cx).await,
        "list_connections" => list_connections(a, cx).await,
        "connection_tools" => connection_tools(a, cx).await,
        "test_automation_script" => test_automation_script(a, cx).await,
        _ => return None,
    })
}

/// isText: a non-blank string.
fn is_text(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str).is_some_and(|s| !trim(s).is_empty())
}

/// titleError.
fn title_error(title: Option<&Value>, wher: &str) -> Option<String> {
    if !is_text(title) {
        return Some(format!("{wher}title is required"));
    }
    let n = utf16_len(trim(title.and_then(Value::as_str).unwrap_or("")));
    (n >= MAX_TITLE).then(|| format!("{wher}title must be under {MAX_TITLE} characters (it has {n})"))
}

/// questionsError: what's wrong with ask_questions input, or None.
fn questions_error(a: &Value) -> Option<String> {
    if let Some(u) = urgency_error(a) {
        return Some(u.into());
    }
    if let Some(about) = get(a, "about") {
        let ok = about.as_array().is_some_and(|x| x.iter().all(Value::is_string) && x.len() <= 20);
        if !ok {
            return Some("about must be a list of task ids (at most 20)".into());
        }
    }
    let qs = match get(a, "questions").and_then(Value::as_array) {
        Some(q) if !q.is_empty() => q,
        _ => return Some("questions must be a non-empty list".into()),
    };
    for (i, q) in qs.iter().enumerate() {
        let at = format!("question {}: ", i + 1);
        if !is_text(get(q, "question")) {
            return Some(format!("{at}question text is required"));
        }
        if get(q, "context").is_some_and(|c| !c.is_string()) {
            return Some(format!("{at}context must be text"));
        }
        let n = utf16_len(trim(s(q, "question").unwrap_or("")));
        if n > MAX_BARE_QUESTION && !is_text(get(q, "context")) {
            return Some(format!(
                "{at}the question has {n} characters: keep it to one sentence (about 120 characters) and move the background into its \"context\" (what the user should do after picking an option goes in that option's description)"
            ));
        }
        let opts = match get(q, "options").and_then(Value::as_array) {
            Some(o) if (2..=8).contains(&o.len()) => o,
            _ => return Some(format!("{at}give 2-8 options")),
        };
        if opts.iter().any(|o| !is_text(get(o, "label"))) {
            return Some(format!("{at}every option needs a label"));
        }
        let rec = opts.iter().filter(|o| js::is_true(o, "recommended")).count();
        if rec != 1 {
            return Some(format!("{at}mark exactly one option recommended (found {rec})"));
        }
        if get(q, "multiSelect").is_some_and(|m| !m.is_boolean()) {
            return Some(format!("{at}multiSelect must be true or false"));
        }
    }
    None
}

async fn ask_questions(a: &Value, cx: &Ctx) -> R<String> {
    // A tool ticket never asks the user: its question goes to its parent through its result.
    if let Some(run) = cx.run_env() {
        let mut parts = run.split('/');
        if let (Some(slug), Some(id)) = (parts.next().filter(|x| !x.is_empty()), parts.next().filter(|x| !x.is_empty())) {
            let tk = cx.client.get_ticket(slug, id).await.ok();
            if hidden_tool(tk.as_ref()) && !with_you_tool(tk.as_ref()) {
                return err(TOOL_NO_QUESTIONS);
            }
        }
    }
    if let Some(e) = questions_error(a) {
        return err(format!("{e}. Fix it and call ask_questions again."));
    }
    Ok(SHOWN.replacen("a card", "a form", 1))
}

/// proposalError.
fn proposal_error(a: &Value) -> Option<String> {
    if get(a, "important").is_some_and(|v| !v.is_boolean()) {
        return Some("important must be true or false".into());
    }
    if get(a, "partOf").is_some_and(|p| !p.is_null() && !is_text(Some(p))) {
        return Some("partOf must be a ticket id, or \"none\" to take the ticket out of its family".into());
    }
    title_error(get(a, "title"), "").or_else(|| (!is_text(get(a, "description"))).then(|| "description is required".to_string()))
}

fn propose_ticket(a: &Value) -> R<String> {
    if let Some(e) = proposal_error(a) {
        return err(format!("{e}. Fix it and call propose_ticket again."));
    }
    Ok(SHOWN.into())
}

fn propose_branch(a: &Value) -> R<String> {
    if get(a, "reason").is_some_and(|r| !r.is_string()) {
        return err("reason must be a string. Fix it and call propose_branch again.");
    }
    Ok(SHOWN.into())
}

async fn propose_delete(a: &Value, cx: &Ctx) -> R<String> {
    let mut ids: Vec<String> = vec![];
    for id in arr(a, "ids").iter().filter_map(Value::as_str).filter(|x| !trim(x).is_empty()).map(|x| trim(x).to_string()) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return err("ids must be a non-empty list of ticket ids. Fix it and call propose_delete again.");
    }
    if !s(a, "reason").is_some_and(|r| !trim(r).is_empty()) {
        return err("reason is required. Fix it and call propose_delete again.");
    }
    if let Some(own) = cx.run_ticket().filter(|o| ids.iter().any(|i| i == o)) {
        return err(format!("{own} is this chat's own ticket and can't be proposed for deletion; ask the user to delete it from the board."));
    }
    // Always this chat's board: the card can only delete tickets there.
    let slug = cx.slug(&Value::Object(Default::default())).await?;
    let found = cx.client.tickets_by_ids(&slug, &ids).await?;
    let known: HashSet<String> = arr(&found, "tickets").iter().map(|t| sh(t, "id")).collect();
    let missing: Vec<&String> = ids.iter().filter(|i| !known.contains(*i)).collect();
    let list = missing.iter().map(|m| m.as_str()).collect::<Vec<_>>().join(", ");
    if missing.len() == ids.len() {
        return err(format!("no such ticket on board {slug}: {list}. Check list_tickets."));
    }
    let skipped = if missing.is_empty() { String::new() } else { format!(" Not on board {slug}, shown as skipped: {list}.") };
    Ok(format!("{SHOWN}{skipped}"))
}

async fn list_connections(a: &Value, cx: &Ctx) -> R<String> {
    let (passes, claude, slug) = tokio::join!(cx.client.list_passes(), cx.client.claude_servers(), cx.slug(a));
    let all = passes?;
    let claude = claude.unwrap_or_else(|_| serde_json::json!({ "servers": [] }));
    let slug = slug.ok();
    // Keys saved for another board aren't this board's to use.
    let passes: Vec<&Value> = arr(&all, "passes").iter().filter(|p| !t(p, "board") || s(p, "board") == slug.as_deref()).collect();
    let linked: HashSet<String> = passes.iter().filter(|p| t(p, "claudeName")).map(|p| sh(p, "claudeName")).collect();
    let own: Vec<String> = passes
        .iter()
        .map(|p| {
            let kind = match s(p, "kind") {
                Some("local") => "program on this computer".to_string(),
                Some("mcp") => "signed in".to_string(),
                _ if t(p, "url") => "key for an MCP server".to_string(),
                _ => format!("key, scripts read it from ${}", sh(p, "envName")),
            };
            let error = if t(p, "error") { format!(" ({})", sh(p, "error")) } else { String::new() };
            let from = if t(p, "claudeName") { format!(", from Connections server \"{}\"", sh(p, "claudeName")) } else { String::new() };
            format!("- {} ({kind}): {}{error}{from}", sh(p, "name"), sh(p, "status"))
        })
        .collect();
    let servers = arr(&claude, "servers");
    let can: Vec<String> = servers
        .iter()
        .filter(|sv| {
            let scope = s(sv, "scope");
            !linked.contains(&sh(sv, "name")) && scope != Some("claude.ai") && (scope == Some("user") || scope == Some("local"))
        })
        .map(|sv| {
            let how = if s(sv, "transport") == Some("stdio") {
                "program on this computer, connects in one click"
            } else {
                "online server, the user signs in once (or pastes a key if it can't)"
            };
            format!("- {}: {how}", sh(sv, "name"))
        })
        .collect();
    let claude_only: Vec<String> = servers
        .iter()
        .filter(|sv| s(sv, "scope") == Some("claude.ai"))
        .map(|sv| format!("{}{}", sh(sv, "name"), if t(sv, "target") { format!(" ({})", sh(sv, "target")) } else { String::new() }))
        .collect();
    let own = if own.is_empty() { "(none yet)".to_string() } else { own.join("\n") };
    let can = if can.is_empty() { "(none)".to_string() } else { can.join("\n") };
    let mut out = format!(
        "Connected for automations:\n{own}\n\nIn Connections, can be connected for automations (propose them in passes with from: \"<name>\"):\n{can}"
    );
    if !claude_only.is_empty() {
        out.push_str(&format!(
            "\n\nclaude.ai connectors (automations can't use Claude's sign-in; for an online server the board can sign in by itself: propose {{name, url}} with its address): {}",
            claude_only.join(", ")
        ));
    }
    out.push_str("\n\nA service with none of these: a key the user pastes (passes entry with envName; the script reads $ENV_NAME). A key saved for this board with ask_keys can be listed by its name the same way.");
    Ok(out)
}

async fn connection_tools(a: &Value, cx: &Ctx) -> R<String> {
    let all = cx.client.list_passes().await?;
    let given = match get(a, "name") {
        None | Some(Value::Null) => String::new(),
        v => js::show(v),
    };
    let wanted = trim(&given).to_lowercase();
    let Some(p) = arr(&all, "passes").iter().find(|x| sh(x, "name").to_lowercase() == wanted || s(x, "claudeName").map(str::to_lowercase).as_deref() == Some(wanted.as_str()))
    else {
        return err(format!(
            "\"{}\" isn't connected for automations yet: check list_connections, and ask the user to connect it (or propose it with from in propose_automation).",
            js::sh(a, "name")
        ));
    };
    let tools = cx.client.pass_tools(&sh(p, "id")).await?;
    let lines: Vec<String> = tools
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|t| {
            let d = if js::t(t, "description") { format!(": {}", js::squash_space(&sh(t, "description"))) } else { String::new() };
            format!("- {}{d}", sh(t, "name"))
        })
        .collect();
    Ok(if lines.is_empty() { "(no tools)".into() } else { lines.join("\n") })
}

async fn test_automation_script(a: &Value, cx: &Ctx) -> R<String> {
    let slug = cx.slug(a).await?;
    let script = match get(a, "script") {
        None | Some(Value::Null) => String::new(),
        v => js::show(v),
    };
    let passes: Vec<String> = get(a, "passes").and_then(Value::as_array).map_or(vec![], |p| p.iter().map(|x| js::show(Some(x))).collect());
    let r = cx.client.test_automation(&slug, &script, &passes).await?;
    let items = arr(&r, "items");
    let lines: Vec<String> = items
        .iter()
        .map(|i| {
            let link = if t(i, "link") { format!(" ({})", sh(i, "link")) } else { String::new() };
            let thread = if t(i, "thread") { format!(" thread: {}", sh(i, "thread")) } else { String::new() };
            format!("- [{}] {}{link}{thread}", sh(i, "id"), sh(i, "title"))
        })
        .collect();
    let mut threads: Vec<String> = vec![];
    for i in items.iter().filter(|i| t(i, "thread")) {
        let th = sh(i, "thread");
        if !threads.contains(&th) {
            threads.push(th);
        }
    }
    let found = get(&r, "found").and_then(Value::as_f64).unwrap_or(f64::NAN);
    let mut out = if t(&r, "error") {
        format!("Failed: {}", sh(&r, "error"))
    } else {
        let secs = js::to_fixed(get(&r, "durationMs").and_then(Value::as_f64).unwrap_or(f64::NAN) / 1000.0, 1);
        format!("Found {} item{} in {secs} s.", sh(&r, "found"), if found == 1.0 { "" } else { "s" })
    };
    if !lines.is_empty() {
        out.push_str(&format!("\n{}", lines.join("\n")));
        if found > lines.len() as f64 {
            out.push_str(&format!("\n… and {} more", js::num_str(found - lines.len() as f64)));
        }
    }
    if !items.is_empty() && threads.is_empty() {
        out.push_str("\nNo item has a thread: each one becomes its own ticket. If several can be about the same thing, add thread.");
    }
    if !threads.is_empty() {
        let n = threads.len();
        out.push_str(&format!("\n{n} thread{}: items with the same thread go into one ticket.", if n == 1 { "" } else { "s" }));
    }
    let used = arr(&r, "toolsUsed");
    if !used.is_empty() {
        out.push_str(&format!("\nTools it called: {}", used.iter().map(|x| js::show(Some(x))).collect::<Vec<_>>().join(", ")));
    }
    let stderr = s(&r, "stderr").map(trim).unwrap_or("");
    if !stderr.is_empty() {
        let tail: Vec<&str> = stderr.split('\n').collect();
        let tail = &tail[tail.len().saturating_sub(15)..];
        out.push_str(&format!("\nstderr (end):\n{}", tail.join("\n")));
    }
    Ok(out)
}
