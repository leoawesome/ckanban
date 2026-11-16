//! The texts tools build from the daemon's answers, as src/cli/client.ts and src/mcp/shared.ts write them:
//! ticket lines, ticket pages, lists, families, profiles, gather results, device takes, bug reports, notify results.

use serde_json::Value;

use super::js::{arr, get, len, s, sh, show, slice, squash_space, t, trim, trim_end, ts, utf16_len};

/// `state(t)` in client.ts: column, then running or the outcome, then what it waits for.
fn state(tk: &Value) -> String {
    let mut bits = vec![sh(tk, "status")];
    if t(tk, "running") {
        bits.push("running".into());
    } else if t(tk, "outcome") {
        bits.push(sh(tk, "outcome"));
    }
    if let Some(k) = get(tk, "attention").filter(|a| t(a, "kind")) {
        if !t(tk, "running") {
            bits.push(format!("waiting: {}", sh(k, "kind")));
        }
    }
    bits.join(", ")
}

fn hash_tags(tags: &[Value]) -> String {
    tags.iter().map(|g| format!("#{}", show(Some(g)))).collect::<Vec<_>>().join(" ")
}

fn joined(v: &Value, key: &str, sep: &str) -> String {
    arr(v, key).iter().map(|x| show(Some(x))).collect::<Vec<_>>().join(sep)
}

/// `ticketLine`.
pub fn ticket_line(tk: &Value) -> String {
    let mut extra: Vec<String> = vec![];
    if t(tk, "feature") {
        extra.push("open feature".into());
    }
    if t(tk, "kind") {
        extra.push(sh(tk, "kind"));
    }
    if t(tk, "parentId") {
        extra.push(format!("in plan {}", sh(tk, "parentId")));
    }
    if len(tk, "needs") > 0 {
        extra.push(format!("needs {}", joined(tk, "needs", ", ")));
    }
    if len(tk, "tags") > 0 {
        extra.push(hash_tags(arr(tk, "tags")));
    }
    let star = if t(tk, "important") { "⭐ " } else { "" };
    let more = if extra.is_empty() { String::new() } else { format!("  ({})", extra.join("; ")) };
    format!("{}  [{}]  {star}{}{more}", sh(tk, "id"), state(tk), sh(tk, "title"))
}

/// `ticketText`: one ticket with its comments.
pub fn ticket_text(tk: &Value, comments: &[Value], earlier: Option<(i64, String)>) -> String {
    let mut lines = vec![sh(tk, "title"), format!("id: {}", sh(tk, "id")), format!("status: {}", state(tk))];
    lines.push(format!("mode: {}", match get(tk, "mode") {
        None | Some(Value::Null) => "auto".into(),
        m => show(m),
    }));
    if t(tk, "jobId") {
        lines.push(format!("job: {} (created by this one-time job; see list_jobs)", sh(tk, "jobId")));
    }
    if t(tk, "scheduleId") {
        lines.push(format!("schedule: {} (created by this schedule; see list_schedules)", sh(tk, "scheduleId")));
    }
    if t(tk, "parentId") {
        let key = if t(tk, "planKey") { format!(" (key {})", sh(tk, "planKey")) } else { String::new() };
        lines.push(format!("plan: child of {}{key}", sh(tk, "parentId")));
    }
    if t(tk, "partOf") {
        lines.push(format!("part of: {} (get_family lists its whole family)", sh(tk, "partOf")));
    }
    if t(tk, "madeFrom") {
        lines.push(format!("asked for in the chat of: {}", sh(tk, "madeFrom")));
    }
    if len(tk, "dependsOn") > 0 {
        lines.push(format!("depends on: {}", joined(tk, "dependsOn", ", ")));
    }
    if len(tk, "needs") > 0 {
        let r = get(tk, "resources").filter(|r| !r.is_null());
        let now = match r {
            Some(r) if t(r, "holding") => " (in use by this ticket)".to_string(),
            Some(r) if len(r, "waitingFor") > 0 => format!(" (waiting for {})", joined(r, "waitingFor", ", ")),
            _ => String::new(),
        };
        lines.push(format!("needs: {}{now}", joined(tk, "needs", ", ")));
    }
    if len(tk, "tags") > 0 {
        lines.push(format!("tags: {}", joined(tk, "tags", ", ")));
    }
    if len(tk, "suggestedTags") > 0 {
        lines.push(format!("suggested tags (not kept yet): {}", joined(tk, "suggestedTags", ", ")));
    }
    for (key, label) in [("userWait", "waiting on the user"), ("branch", "branch"), ("prUrl", "pr"), ("lastActivity", "activity"), ("error", "error")] {
        if t(tk, key) {
            lines.push(format!("{label}: {}", sh(tk, key)));
        }
    }
    let body = s(tk, "body").map(trim).unwrap_or("");
    lines.push(String::new());
    lines.push(if body.is_empty() { "(no description)".into() } else { body.to_string() });
    if !comments.is_empty() {
        lines.push(String::new());
        lines.push(match earlier {
            Some((count, how)) if count != 0 => format!("Comments (the last {}; {count} earlier not shown: {how}):", comments.len()),
            _ => "Comments:".into(),
        });
        for c in comments {
            lines.push(format!("- {} ({}): {}", sh(c, "author"), sh(c, "at"), sh(c, "text")));
        }
    }
    lines.join("\n")
}

/// `ticketListText`.
pub fn ticket_list_text(slug: &str, page: &Value, q: &super::client::ListQuery, more: impl Fn(&str) -> String, done_hint: &str) -> String {
    let query = q.query.as_deref().map(trim).filter(|x| !x.is_empty());
    let what = if query.is_some() {
        let words = query.map(|x| format!("\"{x}\"")).unwrap_or_default();
        format!("matching {words}{}", q.status.as_deref().map(|s| format!(" in {s}")).unwrap_or_else(|| " in any column".into()))
    } else if let Some(st) = q.status.as_deref() {
        format!("in {st}")
    } else {
        "open work (not Done)".into()
    };
    let tickets = arr(page, "tickets");
    let after = q.after.as_deref().map(|a| a.to_string());
    let mut lines: Vec<String> = vec![];
    if tickets.is_empty() {
        let none = if what == "open work (not Done)" { "open tickets (not Done)".to_string() } else { format!("tickets {what}") };
        lines.push(format!("Board {slug}: no {none}{}.", after.as_ref().map(|a| format!(" after {a}")).unwrap_or_default()));
    } else {
        let total = get(page, "total").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let shown = if (tickets.len() as f64) < total { format!("{} of {}", tickets.len(), sh(page, "total")) } else { sh(page, "total") };
        lines.push(format!("Board {slug}, {what}, newest first: {shown}{}.", after.as_ref().map(|a| format!(" (after {a})")).unwrap_or_default()));
        lines.extend(tickets.iter().map(ticket_line));
    }
    if let Some(next) = ts(page, "next") {
        lines.push(format!("More: {}.", more(next)));
    }
    let matched = get(page, "matched").and_then(Value::as_f64).unwrap_or(0.0);
    let total = get(page, "total").and_then(Value::as_f64).unwrap_or(f64::NAN);
    if matched != 0.0 && matched > total {
        lines.push(format!("{} tickets match; only the newest {} are listed: narrow the query or add a status.", sh(page, "matched"), sh(page, "total")));
    }
    if t(page, "doneLeft") {
        let n = get(page, "doneLeft").and_then(Value::as_f64).unwrap_or(0.0);
        lines.push(format!("{} Done ticket{} not listed: {done_hint}.", sh(page, "doneLeft"), if n == 1.0 { "" } else { "s" }));
    }
    lines.join("\n")
}

/// Claude's last result on a family member is cut to this many characters.
const FAMILY_RESULT_CHARS: usize = 400;

/// `familyLine`.
pub fn family_line(r: &Value) -> String {
    let depth = get(r, "depth").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as usize;
    let pad = "  ".repeat(depth);
    let result = squash_space(s(r, "result").unwrap_or(""));
    let result = trim(&result);
    let cut = if utf16_len(result) > FAMILY_RESULT_CHARS {
        format!("{}…", trim_end(&slice(result, 0, Some(FAMILY_RESULT_CHARS as isize))))
    } else {
        result.to_string()
    };
    let how = if t(r, "how") { format!(" ({})", sh(r, "how")) } else { " (top)".into() };
    let mut bits = vec![format!("{pad}- {} [{}]{how} {}", sh(r, "id"), sh(r, "status"), sh(r, "title"))];
    if t(r, "sessionId") {
        bits.push(format!("{pad}  session: {}", sh(r, "sessionId")));
    }
    if t(r, "prUrl") {
        bits.push(format!("{pad}  pr: {}", sh(r, "prUrl")));
    }
    if !cut.is_empty() {
        bits.push(format!("{pad}  last result: {cut}"));
    }
    bits.join("\n")
}

/// `profileList`.
pub fn profile_list(profiles: &[Value]) -> String {
    if profiles.is_empty() {
        return "No profiles yet; add one on the board first.".into();
    }
    let rows: Vec<String> = profiles.iter().map(|p| format!("  {}  ({}, {})", sh(p, "slug"), sh(p, "name"), sh(p, "path"))).collect();
    format!("Profiles:\n{}", rows.join("\n"))
}

/// `gatherText` in shared.ts.
pub fn gather_text(r: &Value) -> String {
    let mut parts = vec![];
    let gathered = arr(r, "gathered");
    parts.push(if gathered.is_empty() {
        "Gathered none.".to_string()
    } else {
        format!("Gathered {}:\n{}", gathered.len(), gathered.iter().map(|x| format!("- {}", ticket_line(x))).collect::<Vec<_>>().join("\n"))
    });
    if let Some(g) = get(r, "group").filter(|g| super::js::truthy(Some(g))) {
        parts.push(format!("New group: {}", ticket_line(g)));
    }
    let moved = arr(r, "movedUp");
    if !moved.is_empty() {
        let rows: Vec<String> = moved.iter().map(|m| format!("- {} \"{}\" under {}", sh(m, "id"), sh(m, "title"), sh(m, "to"))).collect();
        parts.push(format!("Moved up to stay 2 levels deep:\n{}", rows.join("\n")));
    }
    for (key, head) in [("skipped", "Skipped"), ("kept", "Kept their card")] {
        let xs = arr(r, key);
        if !xs.is_empty() {
            let rows: Vec<String> = xs.iter().map(|x| format!("- {}: {}", sh(x, "id"), sh(x, "reason"))).collect();
            parts.push(format!("{head} {}:\n{}", xs.len(), rows.join("\n")));
        }
    }
    parts.join("\n\n")
}

/// `deviceTakeText`.
pub fn device_take_text(r: &Value) -> String {
    let names = arr(r, "names").iter().map(|x| show(Some(x))).collect::<Vec<_>>().join(", ");
    if t(r, "ok") {
        return format!("You have {names} now. Use it, then let go with release_devices as soon as you are done, so the next ticket can have it.");
    }
    let who = arr(r, "usedBy")
        .iter()
        .map(|u| {
            let name = match get(u, "title") {
                None | Some(Value::Null) => sh(u, "id"),
                x => show(x),
            };
            let slug = if t(u, "slug") { format!(" ({})", sh(u, "slug")) } else { String::new() };
            format!("\"{name}\"{slug}")
        })
        .collect::<Vec<_>>()
        .join(", ");
    let holder = if who.is_empty() { "other tickets are ahead of you".to_string() } else { format!("{who} has it") };
    format!(
        "Still waiting for {names}: {holder}; you are #{} in line and keep that place. Do other work that doesn't need it if there is some, then call take_devices again with the same names (each call waits up to 4 minutes).",
        sh(r, "place")
    )
}

/// `bugReportText`.
pub fn bug_report_text(r: &Value) -> String {
    let n = len(r, "screenshots");
    let shots = if n > 0 {
        format!("\n{n} screenshot(s) from the ticket were not uploaded; ask the user to drag them into a comment on the issue.")
    } else {
        String::new()
    };
    if t(r, "url") {
        return format!("Created {}{shots}", sh(r, "url"));
    }
    format!(
        "Could not create the issue: {}\nOpen this link to file it in the browser instead (title and body are prefilled):\n{}{shots}",
        sh(r, "error"),
        sh(r, "fallbackUrl")
    )
}

/// `messageResultText` in shared.ts (notify_user's answer).
pub fn message_result_text(r: &Value) -> String {
    if t(r, "helper") {
        return "Passed to the helper: it tells the user (at once when it is urgent, else in its next summary). It is logged on the ticket.".into();
    }
    let reason = s(r, "reason");
    if reason == Some("off") {
        return "Not sent: the user turned off \"Messages from Claude\" in the board's notification settings.".into();
    }
    let on_screen = get(r, "onScreen").and_then(Value::as_f64);
    if reason == Some("on-screen") {
        let devices = if on_screen == Some(1.0) { "1 device".to_string() } else { format!("{} devices", sh(r, "onScreen")) };
        return format!("Not sent: the user has the board open on screen right now ({devices}), so they can see the ticket.");
    }
    if !t(r, "delivered") {
        return if t(r, "error") {
            format!("Not sent: {}.", sh(r, "error"))
        } else {
            "Not sent: the user hasn't set up any notifications (no phone or browser, webhook or Mac banner).".into()
        };
    }
    let mut wher = vec![];
    if t(r, "devices") {
        let d = get(r, "devices").and_then(Value::as_f64);
        wher.push(if d == Some(1.0) { "1 phone or browser".to_string() } else { format!("{} phones or browsers", sh(r, "devices")) });
    }
    if t(r, "webhook") {
        wher.push("the webhook".into());
    }
    if t(r, "banner") {
        wher.push("the Mac banner".into());
    }
    let skipped = if t(r, "onScreen") { format!(" Skipped {} where the board is on screen.", sh(r, "onScreen")) } else { String::new() };
    let failed = if t(r, "error") { format!(" One channel failed: {}.", sh(r, "error")) } else { String::new() };
    format!("Sent to {}. It is logged on the ticket.{skipped}{failed}", wher.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ticket_lines() {
        let tk = json!({"id": "t_1", "title": "Do it", "status": "backlog", "outcome": "done", "important": true, "kind": "build", "needs": ["a", "b"], "tags": ["post"]});
        assert_eq!(ticket_line(&tk), "t_1  [backlog, done]  ⭐ Do it  (build; needs a, b; #post)");
        let running = json!({"id": "t_2", "title": "X", "status": "in_progress", "running": true, "attention": {"kind": "questions"}});
        assert_eq!(ticket_line(&running), "t_2  [in_progress, running]  X");
    }

    #[test]
    fn family_cut() {
        let long = "word ".repeat(100);
        let line = family_line(&json!({"id": "t", "status": "done", "depth": 1, "how": null, "title": "T", "result": long}));
        assert!(line.starts_with("  - t [done] (top) T\n    last result: word"));
        assert!(line.ends_with("word…"));
    }

    #[test]
    fn gather() {
        assert_eq!(gather_text(&json!({"gathered": [], "movedUp": [], "skipped": [{"id": "x", "reason": "r"}], "group": null})), "Gathered none.\n\nSkipped 1:\n- x: r");
    }
}
