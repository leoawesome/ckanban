//! The pure rules of the run loop (`src/board/board-types.ts`, and `commandText` of `src/chat/commands.ts`): how a
//! chat message runs (`chatFor`), which runs count as work (`takesSlot`), what a run's events say (`hasText`,
//! `replayText`), and the words of errors and waits. Tickets and events are JSON with Bun's field names.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::types::Chat;
use crate::runs::js;

pub const INSTALLING: &str = "Installing project dependencies…";
/// The live line right after a message is sent, while Claude thinks (the UI shows it with the name the user gave Claude).
pub const THINKING_LINE: &str = "Claude is thinking…";
/// What the chat says about a message held back by a pending restart.
pub const RESTART_HOLD_TEXT: &str = "The board restarts soon; your message is sent right after (at most 2 minutes).";
pub const ACTIVITY_THROTTLE_MS: u64 = 1000;
/// A form answer identical to one taken this recently isn't sent again.
pub const ANSWER_REPEAT_MS: f64 = 30_000.0;
pub const ANSWER_PREFIX: &str = "My answers:";
/// A run that would edit the board's folder while another ticket does waits with this on its card.
pub const FOLDER_WAIT: &str = "waiting: another ticket is using the folder";
/// What a stalled run's session is told when the user restarts it.
pub const STALL_RESTART_TEXT: &str = "Your previous run stopped responding and the user restarted it. Continue where you left off.";
/// A requested restart waits this long for active runs to finish, then restarts anyway.
pub const RESTART_MAX_WAIT_MS: u64 = 2 * 60_000;
pub const DRAFT_THROTTLE_MS: u64 = 120;
/// What Claude is told when the user stops one of its workflows from the board.
pub const WORKFLOW_STOPPED_TEXT: &str = "The user stopped your workflow from the board. Don't start it again; finish the task with the results you already have and say which parts the workflow didn't get to.";
/// How often a capped run with workflows running adds up its spending.
pub const WORKFLOW_CAP_POLL_MS: u64 = 5_000;
/// Why a message or a second rewind waits while a rewind, undo or fork runs.
pub const REWINDING: &str = "The chat is being rewound, undone or forked right now. Try again in a moment.";
pub const SESSION_OPEN_MSG: &str = "This ticket's Claude session is still open in a terminal. Exit it there (Ctrl+D or /exit), then try again.";
/// The chat note when a cold, large main or feature chat starts its next turn fresh.
pub const AUTO_FRESH_NOTE: &str = "Started a fresh chat to keep this cheap: Claude starts from the status and can look up earlier messages.";
/// Telegram marks kept per ticket (telegramIn, telegramOut).
pub const TELEGRAM_KEEP: usize = 30;

fn s<'a>(m: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

fn truthy(m: &Map<String, Value>, k: &str) -> bool {
    js::truthy(m.get(k))
}

/// `chatModeFor`: Backlog/Planning chats refine the ticket (no file edits); everywhere else Claude acts on it.
pub fn chat_mode_for(status: &str) -> &'static str {
    if status == "backlog" || status == "planning" { "refine" } else { "act" }
}

/// `chatFor`: how a chat run handles a queued message. `t`: the ticket (`status`, `outcome`, `tool`); `msg`: the
/// queued message (`text`, `peer`, `fromPlanner`, `slash`, `hostWake`, `followUp`). An outcome the ticket doesn't
/// have reads as null in `from`.
pub fn chat_for(t: &Map<String, Value>, msg: &Map<String, Value>) -> Chat {
    let text = s(msg, "text").unwrap_or("").to_string();
    let status = s(t, "status").unwrap_or("").to_string();
    // A follow-up comes back to the ticket's own work, wherever the card is; afterwards the card goes back there.
    if truthy(msg, "followUp") {
        let return_to = if status == "in_progress" { "review".to_string() } else { status };
        return Chat { text, mode: "act".into(), raw: true, return_to: Some(return_to), follow_up: true, ..Default::default() };
    }
    // The ticket's auto huddle wakes it: unattended work on its own ticket.
    if truthy(msg, "hostWake") {
        return Chat { text, mode: "act".into(), raw: true, host_wake: true, ..Default::default() };
    }
    // A tool ticket's messages come from its parent: they continue its work, in any column.
    let mode = if truthy(t, "tool") { "act" } else { chat_mode_for(&status) }.to_string();
    if truthy(msg, "peer") {
        return Chat { text, mode, raw: true, quiet: true, ..Default::default() };
    }
    let outcome = t.get("outcome").cloned().unwrap_or(Value::Null);
    let mut chat = Chat { text, mode, from: Some((status, outcome)), user: !truthy(msg, "fromPlanner"), ..Default::default() };
    // `msg.slash` read as JS truthiness: an empty string is no command.
    let Some(slash) = s(msg, "slash").filter(|x| !x.is_empty()) else { return chat };
    // A local command (/compact) gets no reply from Claude: the card and outcome stay as they were.
    chat.slash = Some(slash.to_string());
    if slash == "local" {
        chat.quiet = true;
    }
    chat
}

/// `takesSlot`: the run does the ticket's work (work runs and chat replies that act); Planning interviews, replies to
/// another ticket's Claude, planner wakes and a main ticket's runs don't.
pub fn takes_slot(chat: Option<&Chat>, no_edit: bool) -> bool {
    if no_edit {
        return false;
    }
    match chat {
        None => true,
        Some(c) => c.mode == "act" && !c.quiet && (c.return_to.is_none() || c.follow_up),
    }
}

fn content(ev: &Value) -> Option<&Value> {
    ev.get("message").and_then(|m| m.get("content"))
}

/// `hasText`: a finished assistant message with text in it (not just thinking or a tool call).
pub fn has_text(ev: &Value) -> bool {
    if ev.get("type").and_then(Value::as_str) != Some("assistant") || js::truthy(ev.get("parent_tool_use_id")) {
        return false;
    }
    match content(ev) {
        Some(Value::Array(blocks)) => blocks.iter().any(|b| {
            b.get("type").and_then(Value::as_str) == Some("text") && b.get("text").and_then(Value::as_str).is_some_and(|t| !js::trim(t).is_empty())
        }),
        _ => false,
    }
}

/// `String(x)` as `Array.join` writes an element (null and undefined as "").
fn join_part(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::Array(a)) => a.iter().map(|x| join_part(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(v) => js::to_string(v),
    }
}

/// `replayText`: the text of a user message Claude echoed back (`isReplay`), a slash command as the `/name args` the
/// board sent; None for anything else.
pub fn replay_text(ev: &Value) -> Option<String> {
    if ev.get("type").and_then(Value::as_str) != Some("user") || !js::truthy(ev.get("isReplay")) {
        return None;
    }
    let text = match content(ev) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| if b.get("type").and_then(Value::as_str) == Some("text") { join_part(b.get("text")) } else { String::new() })
            .collect(),
        _ => return None,
    };
    Some(command_text(&text).unwrap_or(text))
}

/// `commandText`: a slash command as Claude Code stores it (`<command-name>/x</command-name><command-args>..`) as
/// `/x args`; None when the text isn't one.
pub fn command_text(text: &str) -> Option<String> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    static ARGS: OnceLock<Regex> = OnceLock::new();
    let name_re = NAME.get_or_init(|| Regex::new(&format!(r"<command-name>{ws}*/?([^<\t\n\x0B\x0C\r \u{{a0}}\u{{1680}}\u{{2000}}-\u{{200a}}\u{{2028}}\u{{2029}}\u{{202f}}\u{{205f}}\u{{3000}}\u{{feff}}]+){ws}*</command-name>", ws = js::WS)).expect("command name regex"));
    let args_re = ARGS.get_or_init(|| Regex::new(r"(?s)<command-args>(.*?)</command-args>").expect("command args regex"));
    let name = name_re.captures(text)?.get(1)?.as_str().to_string();
    if !trim_start(text).starts_with("<command-") {
        return None;
    }
    let args = args_re.captures(text).and_then(|c| c.get(1)).map(|m| js::trim(m.as_str()).to_string()).unwrap_or_default();
    Some(if args.is_empty() { format!("/{name}") } else { format!("/{name} {args}") })
}

/// JS `trimStart`.
fn trim_start(s: &str) -> &str {
    s.trim_start_matches(js::is_ws)
}

/// `sessionMissing`: Claude's answer to `--resume` with a session it has no transcript for.
pub fn session_missing(error: &str, events: &[Value]) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i-u:No conversation found with session ID)").expect("session regex"));
    re.is_match(error)
        || events.iter().any(|e| {
            e.get("type").and_then(Value::as_str) == Some("result")
                && e.get("errors").and_then(Value::as_array).is_some_and(|errs| errs.iter().any(|m| m.as_str().is_some_and(|m| re.is_match(m))))
        })
}

/// `claudeSetupHint`: a run that failed because Claude Code isn't installed or signed in, in plain words; None for
/// any other failure.
pub fn claude_setup_hint(error: &str) -> Option<&'static str> {
    static MISSING: OnceLock<Regex> = OnceLock::new();
    static LOGIN: OnceLock<Regex> = OnceLock::new();
    let missing = MISSING.get_or_init(|| {
        Regex::new(r#"(?i-u:failed to start )[^\n\r\u{2028}\u{2029}]*(?i-u:claude)|(?i-u:Executable not found in \$PATH: "?claude"?)"#).expect("setup regex")
    });
    let login = LOGIN.get_or_init(|| Regex::new(r"(?i-u:Please run /login)").expect("login regex"));
    if missing.is_match(error) {
        return Some("Claude Code isn't installed, or the board can't find it. Install it from https://claude.com/claude-code and sign in, then start the ticket again. If it still fails, run `ckanban install` in Terminal so the board finds Claude Code.");
    }
    if login.is_match(error) {
        return Some("Claude Code isn't signed in. Open Terminal, type `claude`, sign in, then start the ticket again.");
    }
    None
}

/// `recoveryFor`: the one-click fix a run error offers ("session_missing": Start fresh session, "session_open":
/// Take over here), or None.
pub fn recovery_for(error: Option<&str>) -> Option<&'static str> {
    let error = error.filter(|e| !e.is_empty())?;
    if session_missing(error, &[]) {
        return Some("session_missing");
    }
    (error == SESSION_OPEN_MSG).then_some("session_open")
}

/// `autoHuddleActivity`: what the card says while the ticket waits for its auto huddle.
pub fn auto_huddle_activity(a: &Value) -> &'static str {
    if a.get("state").and_then(Value::as_str) == Some("waiting") { "Waiting for huddle slot" } else { "Auto huddle: waiting for the review" }
}

/// `reopenable`: statuses whose ticket already did its work.
pub fn reopenable(status: &str) -> bool {
    status == "review" || status == "done"
}

/// `e.slice(0, e.indexOf(":"))` and `e.slice(e.indexOf(":") + 1)`, with JS's quirk for an entry without a colon
/// (`slice(0, -1)` drops its last unit; the value is the whole entry).
fn split_entry(e: &str) -> (String, String) {
    match e.find(':') {
        Some(i) => (e[..i].to_string(), e[i + 1..].to_string()),
        None => {
            let n = js::len16(e);
            (js::head16(e, n.saturating_sub(1)).to_string(), e.to_string())
        }
    }
}

/// A `familySig` as JS's `new Map(entries)`: insertion order, a repeated key keeps its first place and last value.
fn parse_sig(sig: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for e in sig.split('|').filter(|e| !e.is_empty()) {
        let (k, v) = split_entry(e);
        match out.iter_mut().find(|(x, _)| *x == k) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        }
    }
    out
}

/// `sigChanges`: what changed in a feature's family between two `familySig` values, as short lines for the status
/// nudge. `rows`: (id, title) of the family's tickets.
pub fn sig_changes(before: &str, after: &str, rows: &[(String, String)]) -> Vec<String> {
    let (a, b) = (parse_sig(before), parse_sig(after));
    let title = |id: &str| rows.iter().find(|(r, _)| r == id).map(|(_, t)| t.clone()).unwrap_or_else(|| id.to_string());
    let get = |m: &[(String, String)], k: &str| m.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
    let mut out = Vec::new();
    for (id, v) in &b {
        match get(&a, id) {
            None => out.push(format!("\"{}\" joined the feature", title(id))),
            Some(old) if old != *v => {
                let mut parts = v.split(':');
                let status = parts.next().unwrap_or("");
                let outcome = parts.next().unwrap_or("");
                let verdict = parts.next().unwrap_or("");
                let o = if outcome.is_empty() { String::new() } else { format!(" ({outcome})") };
                let vd = if verdict.is_empty() { String::new() } else { format!(", verdict {verdict}") };
                out.push(format!("\"{}\" is now {status}{o}{vd}", title(id)));
            }
            Some(_) => {}
        }
    }
    for (id, _) in &a {
        if get(&b, id).is_none() {
            out.push(format!("{id} left the feature"));
        }
    }
    out
}

/// `startError`: what the card says when a run couldn't even start. A full disk gets Bun's plain words; any other
/// error its own text (Rust's `io::Error` text, which differs from Node's).
pub fn start_error(e: &std::io::Error) -> String {
    if e.raw_os_error() == Some(libc::ENOSPC) || e.kind() == std::io::ErrorKind::StorageFull {
        return "Couldn't start: no space left on the disk".into();
    }
    e.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn chat_for_follow_up_goes_back() {
        let c = chat_for(&m(json!({"status": "in_progress"})), &m(json!({"text": "x", "followUp": true})));
        assert_eq!(c.return_to.as_deref(), Some("review"));
        assert!(takes_slot(Some(&c), false));
    }

    #[test]
    fn local_slash_is_quiet() {
        let c = chat_for(&m(json!({"status": "review", "outcome": "done"})), &m(json!({"text": "/compact", "slash": "local"})));
        assert!(c.quiet && c.user);
        assert!(!takes_slot(Some(&c), false));
    }

    #[test]
    fn command_text_reads_tags() {
        assert_eq!(command_text("<command-name>/model</command-name>\n<command-args>sonnet</command-args>").as_deref(), Some("/model sonnet"));
        assert_eq!(command_text("hi <command-name>/x</command-name>"), None);
    }

    #[test]
    fn sig_changes_lines() {
        let rows = vec![("a".to_string(), "A".to_string())];
        assert_eq!(sig_changes("a:ready::", "a:review:done:|b:ready::", &rows), vec!["\"A\" is now review (done)", "\"b\" joined the feature"]);
        assert_eq!(sig_changes("c:x", "", &rows), vec!["c left the feature"]);
    }

    #[test]
    fn full_disk() {
        assert_eq!(start_error(&std::io::Error::from_raw_os_error(libc::ENOSPC)), "Couldn't start: no space left on the disk");
    }
}
