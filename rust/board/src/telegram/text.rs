//! Telegram's pure text rules (Bun's `telegram.ts`, `tgreply.ts`, `tgforms.ts`, `frontdesk.ts`), each checked against
//! Bun's own answers on a shared table (`tests/telegram.rs`, `tests/fixtures/telegram.json`).

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::helper::local;
use crate::helper::text::cut;
use crate::prompts::question_forms::{Answer, answer_text, answers_message};
use crate::prompts::types::Question;
use crate::runs::js::{self, head16, len16, trim};

/// Longest Telegram message.
pub const TELEGRAM_MAX: usize = 4096;
pub const FOCUS_HINT_TELEGRAM: &str = "If you use Focus on your phone, allow Telegram in that Focus so urgent messages can get through (not guaranteed).";
pub const NOT_TAKING: &str = "I'm not taking messages right now. Turn it back on in Settings on the Mac.";
pub const LOCKED: &str = "🔒 Locked. I won't take messages from this chat until you unlock it on the Mac (Settings, Telegram). Alerts still arrive.";
pub const LOCKED_NOTE: &str = "Telegram is locked. Turn on 'Take messages from Telegram' on the Mac to use it again.";
pub const TEXT_ONLY: &str = "Text only for now.";
pub const SEND_AGAIN: &str = "Send it again to change it.";
pub const NEEDS_BOARD: &str = "This needs the board.";

static BOT_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"bot[0-9]{5,15}:[A-Za-z0-9_-]{20,}").unwrap());
static LOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^/lock(@\S+)?$").unwrap());
static LOCAL_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?/?$").unwrap());
static RESULT_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*CKANBAN_RESULT:").unwrap());
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());
static FIRST_LINE_MARKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[#>*\-\s`]+").unwrap());

/// `maskToken`: "set …AbCd".
pub fn mask_token(token: &str) -> String {
    if token.is_empty() { String::new() } else { format!("set …{}", js::tail16(token, 4)) }
}

/// `scrub`: the token out of any text that may hold it.
pub fn scrub(text: &str, token: &str) -> String {
    let out = if token.is_empty() { text.to_string() } else { text.split(token).collect::<Vec<_>>().join("<token>") };
    BOT_TOKEN.replace_all(&out, "bot<token>").into_owned()
}

/// `botId`: the token's public part.
pub fn bot_id(token: &str) -> String {
    token.split(':').next().unwrap_or("").to_string()
}

/// `telegramText`: cut to Telegram's limit keeping the tail.
pub fn telegram_text(body: &str, tail: &str) -> String {
    let room = TELEGRAM_MAX.saturating_sub(len16(tail));
    if len16(body) <= room {
        format!("{body}{tail}")
    } else {
        format!("{}…{tail}", head16(body, room.saturating_sub(1)))
    }
}

/// The first word of a message (`text.trim().split(/\s+/)[0]`).
fn first_word(text: &str) -> &str {
    trim(text).split(js::is_ws).next().unwrap_or("")
}

/// `isLock`: "/lock" or "/lock@mybot".
pub fn is_lock(text: Option<&Value>) -> bool {
    text.and_then(Value::as_str).is_some_and(|t| LOCK.is_match(first_word(t)))
}

/// The command a message starts with: its first word, without "@bot", lower case.
pub fn command(text: &str) -> String {
    let w = first_word(text);
    let w = match w.find('@') {
        // `/@\S+$/`: from the first "@" to the end (the word has no spaces).
        Some(i) if i + 1 < w.len() => &w[..i],
        _ => w,
    };
    w.to_lowercase()
}

/// `forwardedFrom`: who a forwarded message came from, or None when it isn't forwarded.
pub fn forwarded_from(msg: &Value) -> Option<String> {
    let nn = |v: Option<&Value>| v.filter(|x| !x.is_null()).cloned();
    let legacy = js::truthy(msg.get("forward_from")) || js::truthy(msg.get("forward_sender_name")) || js::truthy(msg.get("forward_from_chat"));
    let o = nn(msg.get("forward_origin")).or_else(|| legacy.then(|| serde_json::json!({ "type": "legacy" })))?;
    let u = nn(o.get("sender_user")).or_else(|| nn(msg.get("forward_from")));
    let name: Option<Value> = match u {
        Some(u) => {
            let parts: Vec<String> = [u.get("first_name"), u.get("last_name")].into_iter().filter(|x| js::truthy(*x)).map(|x| js::to_string(x.unwrap())).collect();
            let joined = parts.join(" ");
            if !joined.is_empty() { Some(Value::String(joined)) } else { nn(u.get("username")) }
        }
        None => nn(o.get("sender_user_name"))
            .or_else(|| nn(msg.get("forward_sender_name")))
            .or_else(|| nn(o.get("chat").and_then(|c| c.get("title"))))
            .or_else(|| nn(o.get("sender_chat").and_then(|c| c.get("title"))))
            .or_else(|| nn(msg.get("forward_from_chat").and_then(|c| c.get("title")))),
    };
    Some(match name.filter(|n| js::truthy(Some(n))) {
        Some(n) => head16(&js::to_string(&n), 80).to_string(),
        None => "someone".into(),
    })
}

/// The board's address is this Mac's (phone access off).
pub fn is_local_url(url: &str) -> bool {
    LOCAL_URL.is_match(url)
}

/// `tapUrl`: where a tap on a sent message goes (`ticketTapUrl`, `messagePageUrl`).
pub fn tap_url(m: &serde_json::Map<String, Value>) -> String {
    let url = m.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    let Some(id) = m.get("messageId").and_then(Value::as_str).filter(|x| !x.is_empty()) else { return url };
    let Ok(u) = url::Url::parse(&url) else { return url };
    let origin = u.origin().ascii_serialization();
    let enc = crate::tickets::files::encode_uri_component;
    match m.get("ticket").filter(|t| t.is_object()) {
        Some(t) => format!("{origin}/#/{}/{}?read={}", enc(t.get("board").and_then(Value::as_str).unwrap_or("")), enc(t.get("ticketId").and_then(Value::as_str).unwrap_or("")), enc(id)),
        None => format!("{origin}/#/~messages/{}", enc(id)),
    }
}

/// `cutTail`: the last line of a reply cut at `parts` messages.
pub fn cut_tail(link: Option<&str>) -> String {
    match link {
        Some(l) => format!("\n\n… (cut: read the rest on the board: {l})"),
        None => "\n\n… (cut: the rest is on the board)".into(),
    }
}

fn trim_end(s: &str) -> &str {
    s.trim_end_matches(js::is_ws)
}

/// `reportParts`: a reply in Telegram-sized parts, the result line dropped, split at line breaks, at most `parts`.
pub fn report_parts(head: &str, text: &str, parts: usize, max: usize, link: Option<&str>) -> Vec<String> {
    let kept: Vec<&str> = text.split('\n').filter(|l| !RESULT_LINE.is_match(l)).collect();
    let joined = kept.join("\n");
    let body = BLANK_RUNS.replace_all(&joined, "\n\n");
    let body = trim(&body);
    if body.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut cur = if head.is_empty() { String::new() } else { format!("{head}\n\n") };
    let push = |cur: &mut String, out: &mut Vec<String>| {
        if !trim(cur).is_empty() {
            out.push(trim_end(cur).to_string());
        }
        cur.clear();
    };
    for line in body.split('\n') {
        let mut line = line.to_string();
        while len16(&line) > max - 1 {
            push(&mut cur, &mut out);
            let at = head16(&line, max - 1).len();
            out.push(line[..at].to_string());
            line = line[at..].to_string();
        }
        if len16(&cur) + len16(&line) + 1 > max {
            push(&mut cur, &mut out);
        }
        cur.push_str(&line);
        cur.push('\n');
    }
    push(&mut cur, &mut out);
    if out.len() <= parts {
        return out;
    }
    let mut kept: Vec<String> = out.into_iter().take(parts).collect();
    let tail = cut_tail(link);
    let last = kept[parts - 1].clone();
    kept[parts - 1] = format!("{}{tail}", head16(&last, max.saturating_sub(len16(&tail))));
    kept
}

/// `rowsOf`: n buttons in rows of 3-4.
pub fn rows_of<T: Clone>(items: &[T]) -> Vec<Vec<T>> {
    if items.is_empty() {
        return Vec::new();
    }
    let rows = items.len().div_ceil(4);
    let per = items.len().div_ceil(rows);
    items.chunks(per).map(<[T]>::to_vec).collect()
}

/// `clockTime` of tgforms: "14:02" (en-GB, two digits) in this Mac's time.
pub fn clock_hm(ms: f64) -> String {
    let p = local::parts(ms);
    format!("{:02}:{:02}", p.hour, p.minute)
}

fn flat(s: &str) -> String {
    trim(&js::squash_ws(s)).to_string()
}

/// A form's questions as the board reads them.
pub fn questions(d: &Value) -> Vec<Value> {
    d.get("questions").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn typed_questions(d: &Value) -> Vec<Question> {
    questions(d).into_iter().map(|q| serde_json::from_value(q).unwrap_or_default()).collect()
}

/// The answer of question i as `{picked, other}`.
pub fn answer_at(d: &Value, i: usize) -> (Vec<String>, String) {
    let a = d.get("answers").and_then(|a| a.get(i));
    let picked = a.and_then(|a| a.get("picked")).and_then(Value::as_array).map(|p| p.iter().map(js::to_string).collect()).unwrap_or_default();
    let other = a.and_then(|a| a.get("other")).and_then(Value::as_str).unwrap_or("").to_string();
    (picked, other)
}

/// `boardAnswer`.
pub fn board_answer(d: &Value, i: usize) -> Answer {
    let (picked, other) = answer_at(d, i);
    let other_on = !trim(&other).is_empty();
    Answer { picked, other, other_on }
}

pub fn multi(q: &Value) -> bool {
    js::truthy(q.get("multiSelect"))
}

/// `questionText`: one question's message.
pub fn question_text(d: &Value, i: usize, head: &str) -> String {
    let qs = questions(d);
    let q = &qs[i];
    let n = qs.len();
    let last = i == n - 1;
    let pick = if multi(q) { if last { " Pick any, then Done." } else { " Pick any." } } else { "" };
    let question = js::to_string(q.get("question").unwrap_or(&Value::Null));
    let top = if i == 0 { format!("{head} (1 of {n})\n\n{question}{pick}") } else { format!("({} of {n}) {question}{pick}", i + 1) };
    let opts: Vec<String> = q
        .get("options")
        .and_then(Value::as_array)
        .map(|o| {
            o.iter()
                .enumerate()
                .map(|(k, o)| {
                    let label = js::to_string(o.get("label").unwrap_or(&Value::Null));
                    let desc = o.get("description").filter(|d| js::truthy(Some(*d))).map(|d| format!(": {}", flat(&js::to_string(d)))).unwrap_or_default();
                    let rec = if js::truthy(o.get("recommended")) { " (suggested)" } else { "" };
                    format!("{}. {label}{desc}{rec}", k + 1)
                })
                .collect()
        })
        .unwrap_or_default();
    let (_, other) = answer_at(d, i);
    let other = trim(&other);
    let opts = if opts.is_empty() { String::new() } else { format!("\n{}", opts.join("\n")) };
    let mine = if other.is_empty() { String::new() } else { format!("\n\nYour answer: {}", cut(other, 500)) };
    format!("{top}{opts}{mine}")
}

/// `formMessage`: the answers in the board's format.
pub fn form_message(d: &Value) -> String {
    let qs = typed_questions(d);
    let answers: Vec<Answer> = (0..qs.len()).map(|i| board_answer(d, i)).collect();
    answers_message(&qs, &answers, "")
}

/// `answerText(boardAnswer(...))`.
pub fn form_answer_text(d: &Value, i: usize) -> String {
    answer_text(&board_answer(d, i))
}

/// `routeParts`: the path as the router reads it (segments without "api", decoded, empty ones dropped).
pub fn route_parts(path: &str) -> Option<Vec<String>> {
    path.split('/').filter(|s| !s.is_empty()).skip(1).map(crate::tickets::files::decode_uri_component).collect()
}

/// What a held front desk request is (`heldKind`): None passes now.
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub kind: &'static str,
    pub slug: Option<String>,
    pub ticket_id: Option<String>,
}

fn held(kind: &'static str, slug: Option<&String>, ticket: Option<&String>) -> Option<Held> {
    Some(Held { kind, slug: slug.cloned(), ticket_id: ticket.cloned() })
}

/// `heldKind`: an allow-list. Reads and a plain Backlog ticket pass; every other change is held.
pub fn held_kind(method: &str, path: &str, body: &Value) -> Option<Held> {
    if matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return None;
    }
    let Some(parts) = route_parts(path) else { return held("other", None, None) };
    let slug = (parts.first().map(String::as_str) == Some("profiles")).then(|| parts.get(1)).flatten().filter(|s| !s.is_empty());
    let area = slug.and(parts.get(2)).map(String::as_str);
    let id = if slug.is_some() && parts.len() >= 4 { parts.get(3) } else { None };
    let sub = if slug.is_some() { parts.iter().skip(4).cloned().collect::<Vec<_>>().join("/") } else { String::new() };
    let id_ok = id.is_some_and(|x| !x.is_empty());
    if area == Some("tickets") {
        if !id_ok && method == "POST" && parts.len() == 3 {
            let status = body.get("status");
            let plain = (!js::truthy(status) || status.and_then(Value::as_str) == Some("backlog"))
                && !js::truthy(body.get("main"))
                && !body.get("gather").and_then(Value::as_array).is_some_and(|g| !g.is_empty());
            return if plain { None } else { held("create", slug, None) };
        }
        if id_ok && sub.is_empty() && method == "PATCH" {
            let kind = if body.as_object().is_some_and(|o| o.contains_key("status")) { "move" } else { "edit" };
            return held(kind, slug, id);
        }
        if id_ok && sub.is_empty() && method == "DELETE" {
            return held("delete", slug, id);
        }
        if id_ok && method == "POST" {
            match sub.as_str() {
                "stop" => return held("stop", slug, id),
                "chat" => return held("chat", slug, id),
                "plan" => return held("plan", slug, id),
                "comments" => return held("comment", slug, id),
                _ => {}
            }
        }
        return held("other", slug, if id_ok { id } else { None });
    }
    if area == Some("schedules") && id_ok && method == "DELETE" && sub.is_empty() {
        return held("unschedule", slug, None);
    }
    if area == Some("jobs") && id_ok && method == "POST" && sub == "cancel" {
        return None;
    }
    let sched = matches!(area, Some("schedules" | "jobs"));
    if sched && method == "POST" && id_ok && sub == "run" {
        return held("run", slug, None);
    }
    if sched && ((method == "POST" && !id_ok) || (method == "PATCH" && id_ok && sub.is_empty())) {
        return held("schedule", slug, None);
    }
    held("other", slug, None)
}

/// `deskDenyRules`: files the front desk can't read.
pub fn desk_deny_rules(data_root: &Path) -> Vec<String> {
    let mut roots = vec![data_root.to_string_lossy().into_owned()];
    if let Ok(r) = std::fs::canonicalize(data_root) {
        let r = r.to_string_lossy().into_owned();
        if !roots.contains(&r) {
            roots.push(r);
        }
    }
    let abs = |p: &str| format!("/{}", p.trim_end_matches('/'));
    let home = "~/";
    let mut paths: Vec<String> = ["**/.env*", "//**/.env*", "**/.ssh/**", "//**/.ssh/**", "//**/.dev.vars", "//**/.mcp.json", "//**/*.pem", "//**/*.key"].iter().map(|s| s.to_string()).collect();
    paths.push(format!("{home}.claude-kanban/*.json"));
    paths.push(format!("{home}.claude-kanban/profiles/*/board-tools.json"));
    for r in &roots {
        paths.push(format!("{}/*.json", abs(r)));
        paths.push(format!("{}/profiles/*/board-tools.json", abs(r)));
    }
    for p in [".aws/**", ".config/gh/**", ".netrc", ".git-credentials", ".npmrc", ".claude.json", ".claude/.credentials.json", ".claude/settings*.json", ".docker/config.json"] {
        paths.push(format!("{home}{p}"));
    }
    let mut seen = std::collections::HashSet::new();
    paths.into_iter().filter(|p| seen.insert(p.clone())).map(|p| format!("Read({p})")).collect()
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `dayTitle`: "Telegram · Nov 9" (Bun's default locale is en-US).
pub fn day_title(ms: f64) -> String {
    let p = local::parts(ms);
    format!("Telegram · {} {}", MONTHS[p.month0.min(11) as usize], p.day)
}

/// A day's chat ends after this long without a message.
pub const DAY_IDLE_MS: f64 = 4.0 * 3600_000.0;

/// `dayEnded`: 4 hours without a message, or the end of My night came in between.
pub fn day_ended(last_ms: f64, now_ms: f64, night_end: &str) -> bool {
    if !last_ms.is_finite() || now_ms - last_ms >= DAY_IDLE_MS {
        return true;
    }
    let e = crate::helper::settings::hm(night_end).unwrap_or(7 * 60);
    let p = local::parts(last_ms);
    let mut end = local::make(p.year, p.month0 as i64, p.day as i64, e / 60, e % 60);
    if end <= last_ms {
        end = local::make(p.year, p.month0 as i64, p.day as i64 + 1, e / 60, e % 60);
    }
    now_ms >= end
}

/// `deskPaused`.
pub fn desk_paused(spent: f64) -> String {
    format!("Front desk paused for today (spent ${}); alerts still come.", to_fixed2(spent))
}

/// `n.toFixed(2)`.
pub fn to_fixed2(n: f64) -> String {
    format!("{:.2}", (n * 100.0).round() / 100.0)
}

/// `FrontDesk.briefing`.
pub fn briefing(paired: bool) -> String {
    [
        if paired { "Paired. Here's what I can do from Telegram:" } else { "New: here's what I can do from Telegram now:" },
        "• Alerts: only urgent ones and their reminders come here, with sound. Reply to an alert to answer that ticket.",
        "• Ask me anything else right here: what's going on, send an answer, or start work on any board. Starting, stopping or moving work always asks you to Confirm first.",
        "• /waiting shows what waits on you. /lock stops me taking messages until you turn it back on from the Mac.",
        FOCUS_HINT_TELEGRAM,
    ]
    .join("\n\n")
}

/// `quote`.
pub fn quote(s: &str) -> String {
    s.split('\n').map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n")
}

/// `firstLine`: the first line with text, marks and spaces taken off its start.
pub fn first_line(s: &str) -> String {
    s.split('\n').map(|l| trim(&FIRST_LINE_MARKS.replace(l, "")).to_string()).find(|l| !l.is_empty()).unwrap_or_default()
}

/// `short` of the front desk and the routers: `cut`.
pub fn short(s: &str, max: usize) -> String {
    cut(s, max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn small_rules() {
        assert_eq!(mask_token("123456:ABCDEFG"), "set …DEFG");
        assert_eq!(scrub("https://x/bot12345:abcdefghijklmnopqrstuvwxyz/getMe", ""), "https://x/bot<token>/getMe");
        assert_eq!(scrub("a TOK b", "TOK"), "a <token> b");
        assert!(is_lock(Some(&json!(" /LOCK@bot now"))));
        assert!(!is_lock(Some(&json!("/locked"))));
        assert_eq!(command("/Waiting@my_bot"), "/waiting");
        assert_eq!(forwarded_from(&json!({ "forward_origin": { "type": "user", "sender_user": { "first_name": "Ann", "last_name": "Lee" } } })).as_deref(), Some("Ann Lee"));
        assert_eq!(forwarded_from(&json!({ "forward_sender_name": "Bob" })).as_deref(), Some("Bob"));
        assert_eq!(forwarded_from(&json!({ "forward_origin": { "type": "hidden_user" } })).as_deref(), Some("someone"));
        assert_eq!(forwarded_from(&json!({ "text": "hi" })), None);
        assert!(is_local_url("http://localhost:7777"));
        assert!(!is_local_url("https://mac.ts.net"));
        assert_eq!(rows_of(&[1, 2, 3, 4, 5, 6, 7]), vec![vec![1, 2, 3, 4], vec![5, 6, 7]]);
        assert_eq!(rows_of(&[1, 2, 3, 4, 5]), vec![vec![1, 2, 3], vec![4, 5]]);
    }

    #[test]
    fn held_kinds() {
        let k = |m: &str, p: &str, b: Value| held_kind(m, p, &b).map(|h| h.kind);
        assert_eq!(k("GET", "/api/profiles/b/tickets", Value::Null), None);
        assert_eq!(k("POST", "/api/profiles/b/tickets", json!({ "title": "x" })), None);
        assert_eq!(k("POST", "/api/profiles/b/tickets", json!({ "status": "ready" })), Some("create"));
        assert_eq!(k("PATCH", "/api/profiles/b/tickets/t1", json!({ "status": "ready" })), Some("move"));
        assert_eq!(k("PATCH", "/api/profiles/b/%74ickets/t1", json!({ "title": "y" })), Some("edit"));
        assert_eq!(k("POST", "/api/profiles/b/jobs/j1/cancel", Value::Null), None);
        assert_eq!(k("DELETE", "/api/profiles/b/schedules/s1", Value::Null), Some("unschedule"));
        assert_eq!(k("POST", "/api/profiles/b/schedules", json!({})), Some("schedule"));
        assert_eq!(k("POST", "/api/notify", json!({})), Some("other"));
        assert_eq!(k("POST", "/api/profiles/b/%E0%A4%A", json!({})), Some("other"));
    }

    #[test]
    fn parts_split_and_cut() {
        assert!(report_parts("H:", "CKANBAN_RESULT: {}", 3, 4096, None).is_empty());
        assert_eq!(report_parts("H:", "a\n\n\n\nb\nCKANBAN_RESULT: x", 3, 4096, None), vec!["H:\n\na\n\nb".to_string()]);
        let long = "x".repeat(30);
        let p = report_parts("", &long, 2, 10, None);
        assert_eq!(p.len(), 2);
    }
}
