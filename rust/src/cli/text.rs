//! What the board commands print, as the formatters in `src/cli/client.ts` and `src/cli/ticket-cli.ts` write it
//! (contracts/cli.md section 3). Answers stay `serde_json::Value`, read with JS truthiness, so a field the daemon adds
//! or leaves out changes nothing here.

use serde_json::Value;

use super::args::{js_str, truthy};

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn join(v: &[Value], sep: &str) -> String {
    v.iter().map(|x| js_str(Some(x))).collect::<Vec<_>>().join(sep)
}

fn field(v: &Value, key: &str) -> String {
    js_str(v.get(key))
}

pub fn profile_list(profiles: &[Value]) -> String {
    if profiles.is_empty() {
        return "No profiles yet; add one on the board first.".into();
    }
    let lines: Vec<String> = profiles.iter().map(|p| format!("  {}  ({}, {})", field(p, "slug"), field(p, "name"), field(p, "path"))).collect();
    format!("Profiles:\n{}", lines.join("\n"))
}

fn state(t: &Value) -> String {
    let mut bits = vec![field(t, "status")];
    let running = truthy(t.get("running"));
    if running {
        bits.push("running".into());
    } else if truthy(t.get("outcome")) {
        bits.push(field(t, "outcome"));
    }
    let kind = t.get("attention").and_then(|a| a.get("kind"));
    if truthy(kind) && !running {
        bits.push(format!("waiting: {}", js_str(kind)));
    }
    bits.join(", ")
}

pub fn ticket_line(t: &Value) -> String {
    let mut extra: Vec<String> = Vec::new();
    if truthy(t.get("feature")) {
        extra.push("open feature".into());
    }
    if truthy(t.get("kind")) {
        extra.push(field(t, "kind"));
    }
    if truthy(t.get("parentId")) {
        extra.push(format!("in plan {}", field(t, "parentId")));
    }
    if !arr(t, "needs").is_empty() {
        extra.push(format!("needs {}", join(arr(t, "needs"), ", ")));
    }
    if !arr(t, "tags").is_empty() {
        extra.push(arr(t, "tags").iter().map(|g| format!("#{}", js_str(Some(g)))).collect::<Vec<_>>().join(" "));
    }
    format!(
        "{}  [{}]  {}{}{}",
        field(t, "id"),
        state(t),
        if truthy(t.get("important")) { "⭐ " } else { "" },
        field(t, "title"),
        if extra.is_empty() { String::new() } else { format!("  ({})", extra.join("; ")) }
    )
}

/// What `ticket list` asked for; `query` as typed (trimmed here), `status` already parsed.
pub struct ListQuery<'a> {
    pub status: Option<&'a str>,
    pub query: Option<&'a str>,
    pub after: Option<&'a str>,
}

pub fn ticket_list_text(slug: &str, page: &Value, q: &ListQuery, more: impl Fn(&str) -> String, done_hint: &str) -> String {
    let query = q.query.map(str::trim).filter(|x| !x.is_empty());
    let what = match (query, q.status) {
        (Some(qq), st) => format!("matching \"{qq}\"{}", st.map(|s| format!(" in {s}")).unwrap_or_else(|| " in any column".into())),
        (None, Some(st)) => format!("in {st}"),
        (None, None) => "open work (not Done)".into(),
    };
    let after = q.after.filter(|a| !a.is_empty());
    let tickets = arr(page, "tickets");
    let total = page.get("total");
    let mut lines: Vec<String> = Vec::new();
    if tickets.is_empty() {
        let what = if what == "open work (not Done)" { "open tickets (not Done)".to_string() } else { format!("tickets {what}") };
        lines.push(format!("Board {slug}: no {what}{}.", after.map(|a| format!(" after {a}")).unwrap_or_default()));
    } else {
        let n = tickets.len() as f64;
        let shown = if total.and_then(Value::as_f64).is_some_and(|t| n < t) { format!("{} of {}", tickets.len(), js_str(total)) } else { js_str(total) };
        lines.push(format!("Board {slug}, {what}, newest first: {shown}{}.", after.map(|a| format!(" (after {a})")).unwrap_or_default()));
        lines.extend(tickets.iter().map(ticket_line));
    }
    if truthy(page.get("next")) {
        lines.push(format!("More: {}.", more(&field(page, "next"))));
    }
    let matched = page.get("matched");
    if truthy(matched) && matched.and_then(Value::as_f64).zip(total.and_then(Value::as_f64)).is_some_and(|(m, t)| m > t) {
        lines.push(format!("{} tickets match; only the newest {} are listed: narrow the query or add a status.", js_str(matched), js_str(total)));
    }
    let done_left = page.get("doneLeft");
    if truthy(done_left) {
        let one = done_left.and_then(Value::as_f64) == Some(1.0);
        lines.push(format!("{} Done ticket{} not listed: {done_hint}.", js_str(done_left), if one { "" } else { "s" }));
    }
    lines.join("\n")
}

pub fn ticket_text(t: &Value, comments: &[Value], earlier: f64, how: &str) -> String {
    let mut lines = vec![
        field(t, "title"),
        format!("id: {}", field(t, "id")),
        format!("status: {}", state(t)),
        format!("mode: {}", match t.get("mode") { None | Some(Value::Null) => "auto".into(), m => js_str(m) }),
    ];
    let has = |k: &str| truthy(t.get(k));
    if has("jobId") {
        lines.push(format!("job: {} (created by this one-time job; see list_jobs)", field(t, "jobId")));
    }
    if has("scheduleId") {
        lines.push(format!("schedule: {} (created by this schedule; see list_schedules)", field(t, "scheduleId")));
    }
    if has("parentId") {
        let key = if has("planKey") { format!(" (key {})", field(t, "planKey")) } else { String::new() };
        lines.push(format!("plan: child of {}{key}", field(t, "parentId")));
    }
    if has("partOf") {
        lines.push(format!("part of: {} (get_family lists its whole family)", field(t, "partOf")));
    }
    if has("madeFrom") {
        lines.push(format!("asked for in the chat of: {}", field(t, "madeFrom")));
    }
    if !arr(t, "dependsOn").is_empty() {
        lines.push(format!("depends on: {}", join(arr(t, "dependsOn"), ", ")));
    }
    if !arr(t, "needs").is_empty() {
        let r = t.get("resources").filter(|r| !r.is_null());
        let waiting = r.map(|r| arr(r, "waitingFor")).unwrap_or(&[]);
        let now = if r.is_some_and(|r| truthy(r.get("holding"))) {
            " (in use by this ticket)".to_string()
        } else if !waiting.is_empty() {
            format!(" (waiting for {})", join(waiting, ", "))
        } else {
            String::new()
        };
        lines.push(format!("needs: {}{now}", join(arr(t, "needs"), ", ")));
    }
    if !arr(t, "tags").is_empty() {
        lines.push(format!("tags: {}", join(arr(t, "tags"), ", ")));
    }
    if !arr(t, "suggestedTags").is_empty() {
        lines.push(format!("suggested tags (not kept yet): {}", join(arr(t, "suggestedTags"), ", ")));
    }
    for (key, label) in [("userWait", "waiting on the user"), ("branch", "branch"), ("prUrl", "pr"), ("lastActivity", "activity"), ("error", "error")] {
        if has(key) {
            lines.push(format!("{label}: {}", field(t, key)));
        }
    }
    let body = s(t, "body").trim();
    lines.push(String::new());
    lines.push(if body.is_empty() { "(no description)".into() } else { body.to_string() });
    if !comments.is_empty() {
        lines.push(String::new());
        lines.push(if earlier != 0.0 && !earlier.is_nan() {
            format!("Comments (the last {}; {} earlier not shown: {how}):", comments.len(), ckanban_core::jsnum::js_string(earlier))
        } else {
            "Comments:".into()
        });
        for c in comments {
            lines.push(format!("- {} ({}): {}", field(c, "author"), field(c, "at"), field(c, "text")));
        }
    }
    lines.join("\n")
}

pub fn device_take_text(r: &Value) -> String {
    let names = join(arr(r, "names"), ", ");
    if truthy(r.get("ok")) {
        return format!("You have {names} now. Use it, then let go with release_devices as soon as you are done, so the next ticket can have it.");
    }
    let who = arr(r, "usedBy")
        .iter()
        .map(|u| {
            let title = match u.get("title") { None | Some(Value::Null) => field(u, "id"), t => js_str(t) };
            let slug = if truthy(u.get("slug")) { format!(" ({})", field(u, "slug")) } else { String::new() };
            format!("\"{title}\"{slug}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Still waiting for {names}: {}; you are #{} in line and keep that place. Do other work that doesn't need it if there is some, then call take_devices again with the same names (each call waits up to 4 minutes).",
        if who.is_empty() { "other tickets are ahead of you".to_string() } else { format!("{who} has it") },
        field(r, "place")
    )
}

pub fn bug_report_text(r: &Value) -> String {
    let shots = arr(r, "screenshots");
    let shots = if shots.is_empty() {
        String::new()
    } else {
        format!("\n{} screenshot(s) from the ticket were not uploaded; ask the user to drag them into a comment on the issue.", shots.len())
    };
    if truthy(r.get("url")) {
        return format!("Created {}{shots}", field(r, "url"));
    }
    format!(
        "Could not create the issue: {}\nOpen this link to file it in the browser instead (title and body are prefilled):\n{}{shots}",
        field(r, "error"),
        field(r, "fallbackUrl")
    )
}

/// `setupText` in `src/cli/ticket-cli.ts`.
pub fn setup_text(r: &Value) -> String {
    let status = s(r, "status");
    if status != "ran" {
        return match status {
            "already-done" => "Already done: this ticket's dependencies are installed.",
            "no-command" => "Nothing to install: this board has no setup command.",
            "no-worktree" => "Nothing to install: this ticket works in the project folder itself, not a separate copy.",
            _ => "undefined",
        }
        .into();
    }
    let x = r.get("result").cloned().unwrap_or(Value::Null);
    let ms = x.get("durationMs").and_then(Value::as_f64).unwrap_or(f64::NAN);
    // Math.round: halves go up.
    let secs = ckanban_core::jsnum::js_string((ms / 1000.0 + 0.5).floor());
    let ok = truthy(x.get("ok"));
    let command = field(&x, "command");
    let head = if ok {
        format!("Installed the project's dependencies in {secs}s (`{command}`).")
    } else {
        let what = if truthy(x.get("timedOut")) { "timed out".to_string() } else { format!("failed (exit {})", exit_of(&x)) };
        format!("`{command}` {what} after {secs}s. Last lines of its output:")
    };
    let output = if ok { String::new() } else { field(&x, "output") };
    let block = format!("<ckanban-setup>{}</ckanban-setup>", super::args::compact(&x).replace('<', "\\u003c"));
    [head, output, block].into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
}

/// A wait in words: "45s", "2m 5s", "1h 3m".
pub fn elapsed_text(ms: u64) -> String {
    let secs = ms / 1000;
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {}s", secs / 60, secs % 60),
        _ => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
    }
}

/// `exitCode ?? "signal"`.
pub fn exit_of(x: &Value) -> String {
    match x.get("exitCode") {
        None | Some(Value::Null) => "signal".into(),
        v => js_str(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ticket_line_with_extras() {
        let t = json!({ "id": "t1", "status": "review", "outcome": "needs_input", "important": true, "title": "Phone", "needs": ["emulator"], "tags": ["ui"], "kind": "build", "feature": true });
        assert_eq!(ticket_line(&t), "t1  [review, needs_input]  ⭐ Phone  (open feature; build; needs emulator; #ui)");
    }

    #[test]
    fn list_text_like_contract() {
        let page = json!({ "tickets": [{ "id": "t1", "status": "backlog", "title": "A" }], "total": 41, "doneLeft": 1204, "next": "t1" });
        let q = ListQuery { status: None, query: None, after: None };
        let text = ticket_list_text("kanban", &page, &q, |a| format!("ckanban ticket list --limit 3 --after {a}"), "use --status done, or --query");
        assert_eq!(text, "Board kanban, open work (not Done), newest first: 1 of 41.\nt1  [backlog]  A\nMore: ckanban ticket list --limit 3 --after t1.\n1204 Done tickets not listed: use --status done, or --query.");
    }
}
