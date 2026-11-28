//! What one transcript line means for the ticket chat, ported from Bun's `src/runs/session-markers.ts`: the user's
//! text (board prompts, wakes, huddle messages, slash commands), an assistant reply's board blocks (questions,
//! ticket proposals, mockups, the move and stay markers) and the cards planning-chat tools show.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::cards;
use super::text::{self, TERMINAL_COMMANDS, js_re};
use super::{Obj, js};

/// Marker Claude adds when a Review message only asked for planning; the board moves the card.
pub static MOVE_TO_PLANNING_RE: LazyLock<Regex> =
    LazyLock::new(|| js_re(r#"<ckanban-move\s+to="planning"\s*/?>(?:\s*</ckanban-move>)?"#));
/// A Review/Done chat reply that only proposed something: the card stays in its column.
pub static STAY_RE: LazyLock<Regex> = LazyLock::new(|| js_re(r"<ckanban-stay\s*/?>(?:\s*</ckanban-stay>)?"));

const CONTEXT_TAG: &str = "<ckanban-context";

fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object()?.get(k)
}

/// `typeof v === "string" ? v.trim() : ""`.
fn str_trim(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).map(js::trim).unwrap_or("")
}

/// ask_questions' urgent, why and about, or None when none is set.
pub fn parse_ask_meta(v: &Value) -> Option<Obj> {
    let urgent = get(v, "urgent") == Some(&Value::Bool(true));
    let why = js::cut16(str_trim(get(v, "why")), 300);
    let about: Vec<Value> = match get(v, "about") {
        Some(Value::Array(a)) => {
            a.iter().filter(|x| x.as_str().is_some_and(|s| !js::trim(s).is_empty())).take(20).cloned().collect()
        }
        _ => Vec::new(),
    };
    if !urgent && why.is_empty() && about.is_empty() {
        return None;
    }
    let mut out = Obj::new();
    if urgent {
        out.insert("urgent".into(), true.into());
    }
    if !why.is_empty() {
        out.insert("why".into(), why.into());
    }
    if !about.is_empty() {
        out.insert("about".into(), about.into());
    }
    Some(out)
}

/// End (exclusive byte index) of the JSON object/array starting at `from`, or None when it never closes.
pub fn json_end(text: &str, from: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut depth = 0i64;
    let mut in_string = false;
    let mut i = from;
    while i < b.len() {
        let c = b[i];
        if in_string {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'{' || c == b'[' {
            depth += 1;
        } else if c == b'}' || c == b']' {
            depth -= 1;
            if depth == 0 {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

static BLOCK_HEAD: LazyLock<Regex> = LazyLock::new(|| js_re(r"^\s*(?:```(?:json)?\s*)?"));
static BLOCK_TAIL: LazyLock<Regex> = LazyLock::new(|| js_re(r"^(?:\s*```)?(?:\s*</[\w-]+>)?"));

/// A parsed block (`raw`: its text, to cut it out). `value` None when no occurrence of the tag parses (then `raw` is
/// the first occurrence).
pub struct Block<T> {
    pub raw: String,
    pub value: Option<T>,
}

/// Find a `<tag>` block and parse its JSON. The JSON's own end decides where the block stops, so a wrong or missing
/// closing tag, or one quoted inside the JSON, doesn't break it; a ```json fence is fine. Each occurrence of the
/// opening tag is tried in order; the first whose content parses wins.
pub fn find_block<T>(text: &str, tag: &str, parse: impl Fn(&Value) -> Option<T>) -> Option<Block<T>> {
    let open = format!("<{tag}>");
    let mut first: Option<String> = None;
    let mut search = 0;
    while let Some(pos) = text[search..].find(&open) {
        let start = search + pos;
        search = start + open.len();
        let after = &text[start + open.len()..];
        let head = BLOCK_HEAD.find(after).map_or(0, |m| m.end());
        let from = start + open.len() + head;
        let end = match text.as_bytes().get(from) {
            Some(b'{' | b'[') => json_end(text, from),
            _ => None,
        };
        let Some(end) = end else {
            first.get_or_insert_with(|| text[start..].to_string());
            continue;
        };
        let tail = BLOCK_TAIL.find(&text[end..]).map_or(0, |m| m.end());
        let raw = &text[start..end + tail];
        let value = serde_json::from_str::<Value>(&text[from..end]).ok().and_then(|v| parse(&v));
        if value.is_some() {
            return Some(Block { raw: raw.to_string(), value });
        }
        first.get_or_insert_with(|| raw.to_string());
    }
    first.map(|raw| Block { raw, value: None })
}

/// The questions of a form (ask_questions or a `<ckanban-questions>` block), or None when any has no text.
pub fn parse_questions(v: &Value) -> Option<Value> {
    let list = v.as_array().filter(|a| !a.is_empty())?;
    let mut qs = Vec::new();
    for q in list {
        let question = js::trim(&js::string_or_empty(get(q, "question"))).to_string();
        if question.is_empty() {
            return None;
        }
        let mut o = Obj::new();
        o.insert("question".into(), question.into());
        let context = str_trim(get(q, "context"));
        if !context.is_empty() {
            o.insert("context".into(), context.into());
        }
        o.insert("multiSelect".into(), js::truthy(get(q, "multiSelect")).into());
        let options: Vec<Value> = match get(q, "options") {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|opt| {
                    let label = js::trim(&js::string_or_empty(get(opt, "label"))).to_string();
                    if label.is_empty() {
                        return None;
                    }
                    let mut x = Obj::new();
                    x.insert("label".into(), label.into());
                    // `description: undefined` in Bun: left out of the JSON.
                    if let Some(d) = get(opt, "description").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                        x.insert("description".into(), d.into());
                    }
                    x.insert("recommended".into(), js::truthy(get(opt, "recommended")).into());
                    if let Some(m) = get(opt, "mockup").and_then(Value::as_str).and_then(text::mockup_name) {
                        x.insert("mockup".into(), m.into());
                    }
                    Some(Value::Object(x))
                })
                .collect(),
            _ => Vec::new(),
        };
        o.insert("options".into(), options.into());
        qs.push(Value::Object(o));
    }
    Some(Value::Array(qs))
}

/// A ticket proposal (title, description, ⭐ important, partOf), or None when it has neither title nor description.
pub fn parse_proposal(v: &Value) -> Option<Value> {
    let (star_title, starred) = text::starred_title(str_trim(get(v, "title")));
    let title = js::trim(star_title);
    let description = str_trim(get(v, "description"));
    let part_of = match get(v, "partOf") {
        Some(Value::String(s)) if !js::trim(s).is_empty() => {
            let p = js::trim(s);
            Some(if p.eq_ignore_ascii_case("none") { Value::Null } else { p.into() })
        }
        Some(Value::Null) => Some(Value::Null),
        _ => None,
    };
    if title.is_empty() && description.is_empty() {
        return None;
    }
    let mut out = Obj::new();
    out.insert("title".into(), title.into());
    out.insert("description".into(), description.into());
    if starred || get(v, "important") == Some(&Value::Bool(true)) {
        out.insert("important".into(), true.into());
    }
    if let Some(p) = part_of {
        out.insert("partOf".into(), p);
    }
    Some(Value::Object(out))
}

/// Split an assistant text block into visible text + structured blocks. Keys in order: text, questions?, proposal?,
/// mockups?, moved?, unreadable? (an unreadable block stays visible and is flagged).
pub fn assistant_block(input: &str) -> Obj {
    let (rest, mockups) = text::strip_mockups(input);
    let mut out = rest;
    let mut moved = false;
    if MOVE_TO_PLANNING_RE.is_match(&out) {
        moved = true;
        out = MOVE_TO_PLANNING_RE.replace(&out, "").into_owned();
    }
    out = STAY_RE.replace(&out, "").into_owned();
    let mut unreadable: Option<&'static str> = None;
    let mut take = |out: &mut String, tag: &str, kind: &'static str, parse: &dyn Fn(&Value) -> Option<Value>| -> Option<Value> {
        let b = find_block(out, tag, parse)?;
        match b.value {
            None => {
                unreadable.get_or_insert(kind);
                None
            }
            Some(v) => {
                *out = out.replacen(&b.raw, "", 1);
                Some(v)
            }
        }
    };
    let questions = take(&mut out, "ckanban-questions", "questions", &parse_questions);
    let proposal = take(&mut out, "ckanban-ticket", "proposal", &parse_proposal);
    // Planned tickets are retired: an old reply's proposed-tickets block is only cut from the text (no card).
    take(&mut out, "ckanban-tickets", "tickets", &|v: &Value| v.is_array().then(|| v.clone()));
    let mut o = Obj::new();
    o.insert("text".into(), js::trim(&out).into());
    if let Some(q) = questions {
        o.insert("questions".into(), q);
    }
    if let Some(p) = proposal {
        o.insert("proposal".into(), p);
    }
    if !mockups.is_empty() {
        o.insert("mockups".into(), mockups.into());
    }
    if moved {
        o.insert("moved".into(), "planning".into());
    }
    if let Some(u) = unreadable {
        o.insert("unreadable".into(), u.into());
    }
    o
}

/// The board doesn't move a blocked run to Planning; its reply (up to the next user message) mustn't claim it did.
pub fn drop_blocked_moves(entries: &mut [Value]) {
    let mut drop = Vec::new();
    for (i, e) in entries.iter().enumerate() {
        if !js::truthy(get(e, "moved")) {
            continue;
        }
        for x in &entries[i..] {
            let role = get(x, "role").and_then(Value::as_str);
            if role == Some("user") && !js::truthy(get(x, "huddleId")) {
                break;
            }
            let blocked = role == Some("assistant")
                && get(x, "kind").and_then(Value::as_str) == Some("text")
                && text::parse_result(get(x, "text").and_then(Value::as_str).unwrap_or(""))
                    .is_some_and(|r| get(&r, "status").and_then(Value::as_str) == Some("blocked"));
            if blocked {
                drop.push(i);
                break;
            }
        }
    }
    for i in drop {
        if let Some(o) = entries[i].as_object_mut() {
            o.remove("moved");
        }
    }
}

static PUBLISHED: LazyLock<Regex> =
    LazyLock::new(|| js_re(r"Published (\S+) at (https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]+)"));

/// Every `Published <path> at <artifact url>` line in a text, in order: (path, url).
pub fn published(text: &str) -> Vec<(String, String)> {
    PUBLISHED.captures_iter(text).map(|c| (c[1].to_string(), c[2].to_string())).collect()
}

/// `/\b<phrase>\b/.test(text)` with JS's ASCII word boundaries (the phrase starts and ends with a word character).
fn has_phrase(text: &str, phrase: &str) -> bool {
    let word = |b: Option<&u8>| b.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_');
    let b = text.as_bytes();
    text.match_indices(phrase).any(|(i, _)| !word(i.checked_sub(1).and_then(|j| b.get(j))) && !word(b.get(i + phrase.len())))
}

/// `ckanban ticket setup`: its output ends with the setup block the chat draws a row from.
pub fn is_setup_helper(command: &str) -> bool {
    has_phrase(command, "ticket setup")
}

/// `name` is `tool` or ends with `__tool` (`/(?:^|__)tool$/`).
fn tool_is(name: &str, tool: &str) -> bool {
    name == tool || name.strip_suffix(tool).is_some_and(|p| p.ends_with("__"))
}

/// A tool call that publishes an artifact (the Artifact tool, publish_artifact, or `ckanban artifact publish`).
pub fn is_publisher(block: &Value) -> bool {
    let name = get(block, "name");
    if name.and_then(Value::as_str) == Some("Artifact") || tool_is(&js::string_or_empty(name), "publish_artifact") {
        return true;
    }
    name.and_then(Value::as_str) == Some("Bash")
        && js::at(block, &["input", "command"]).and_then(Value::as_str).is_some_and(|c| has_phrase(c, "artifact publish"))
}

/// A Claude Code built-in typed in a terminal session (/exit, /resume): not part of the ticket chat.
pub fn terminal_only(cmd: Option<&str>) -> bool {
    let Some(cmd) = cmd.filter(|c| !c.is_empty()) else { return false };
    let mut c = cmd.chars();
    c.next();
    TERMINAL_COMMANDS.contains(&c.as_str().split(' ').next().unwrap_or(""))
}

static FROM_TICKET: LazyLock<Regex> =
    LazyLock::new(|| js_re(r#"^Message from ticket (t_[\w-]+) \("((?s:.)*?)"\): ((?s:.)*)$"#));

/// The sender and message of a `Message from ticket <id> ("<title>"): text` line: (ticketId, title, trimmed text).
pub fn from_ticket(text: &str) -> Option<(String, String, String)> {
    let m = FROM_TICKET.captures(text)?;
    Some((m[1].to_string(), m[2].to_string(), js::trim(&m[3]).to_string()))
}

static FROM_AUTOMATION: LazyLock<Regex> =
    LazyLock::new(|| js_re(r#"^Message from automation \("([^"\r\n]*)"\): ((?s:.)*)$"#));

/// The automation's name and the trimmed message of a `Message from automation ("<name>"): text` line.
pub fn from_automation(text: &str) -> Option<(String, String)> {
    let m = FROM_AUTOMATION.captures(text)?;
    Some((m[1].to_string(), js::trim(&m[2]).to_string()))
}

/// A user message as the chat shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct UserText {
    /// "text" (the user's words) or "board" (a prompt the board sent; instructions hidden).
    pub kind: &'static str,
    pub text: String,
    /// Huddle messages delivered to this ticket's session: the huddle's id.
    pub huddle: Option<String>,
    /// A setup the board ran (the setup block in the board's instructions).
    pub setup: Option<Value>,
    /// A slash command the user ran (its name, without the slash).
    pub command: Option<String>,
    /// A message the board sent by itself: its one-line summary.
    pub wake: Option<String>,
}

static HUDDLE_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#" huddle="([^"]*)""#).expect("valid regex"));
static WAKE_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#" wake="([^"]*)""#).expect("valid regex"));
static NOTE_ATTR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"note="([^"]*)""#).expect("valid regex"));
static NOT_SHOWN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(Base directory for this skill|Caveat:|\[Request interrupted)").expect("valid regex"));

fn attr(re: &Regex, s: &str) -> Option<String> {
    re.captures(s).map(|c| c[1].to_string())
}

/// What a user-role transcript message shows in the chat, or None for tool results, wrappers and hook output.
/// `content`: a string or an array of content blocks (anything else gives None).
pub fn user_text(content: &Value) -> Option<UserText> {
    let joined;
    let content: &str = match content {
        Value::Array(a) => {
            if a.iter().any(|c| get(c, "type").and_then(Value::as_str) == Some("tool_result")) {
                return None;
            }
            joined = a
                .iter()
                .map(|c| {
                    if get(c, "type").and_then(Value::as_str) != Some("text") {
                        return String::new();
                    }
                    js::string_or_empty(get(c, "text"))
                })
                .collect::<Vec<_>>()
                .join("\n");
            &joined
        }
        Value::String(s) => s,
        _ => return None,
    };
    let plain = |kind, text: String| UserText { kind, text, huddle: None, setup: None, command: None, wake: None };
    if let Some(ctx) = content.find(CONTEXT_TAG) {
        // Board-sent prompt: show only what the user typed; pure instructions become a short note.
        let typed = js::trim(&content[..ctx]).to_string();
        let tag = match content[ctx..].find('>') {
            Some(gt) => &content[ctx..ctx + gt + 1],
            None => "",
        };
        let setup = text::parse_setup_block(&content[ctx..]);
        let huddle = attr(&HUDDLE_ATTR, tag);
        if let Some(wake) = attr(&WAKE_ATTR, tag) {
            let wake = if wake.is_empty() { "update".into() } else { wake };
            return Some(UserText { setup, wake: Some(wake), ..plain("board", typed) });
        }
        if !typed.is_empty() {
            return Some(UserText { setup, huddle: huddle.filter(|h| !h.is_empty()), ..plain("text", typed) });
        }
        let note = attr(&NOTE_ATTR, &content[ctx..]).filter(|n| !n.is_empty());
        return Some(UserText { setup, ..plain("board", note.unwrap_or_else(|| "Board sent instructions to Claude".into())) });
    }
    let t = text::without_attachment_note(js::trim(content));
    // A slash command the user ran: Claude Code stores it as tags; show it as typed.
    if let Some(cmd) = text::command_text(t) {
        if terminal_only(Some(&cmd)) {
            return None;
        }
        let name = cmd[1..].split(' ').next().unwrap_or("").to_string();
        return Some(UserText { command: Some(name), ..plain("text", cmd) });
    }
    // Other slash-command wrappers, hook output and skill preambles are stored as user messages too.
    if t.is_empty() || t.starts_with('<') || NOT_SHOWN.is_match(t) {
        return None;
    }
    Some(plain("text", t.to_string()))
}

/// A tool result's text: a string as is, an array's parts joined by lines, anything else "".
pub fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|c| match c {
                Value::String(s) => s.clone(),
                _ => js::string_or_empty(get(c, "text")),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn one(k: &str, v: Value) -> Obj {
    let mut o = Obj::new();
    o.insert(k.into(), v);
    o
}

fn with_reason(k: &str, v: Value, reason: &str) -> Obj {
    let mut o = Obj::new();
    o.insert(k.into(), v);
    o.insert("reason".into(), reason.into());
    o
}

/// The form or card a planning-chat tool call shows (keys: questions+ask?, proposal, branch, huddle, deletion,
/// scheduleDeletion, helperRule, teammate, squad, automation, keys), or None for other tools or input that can't be read.
pub fn card_entry(block: &Value) -> Option<Obj> {
    let name = js::string_or_empty(get(block, "name"));
    let input = get(block, "input").unwrap_or(&Value::Null);
    let inp = |k: &str| get(input, k);
    // Only the board's own tool: a same-named tool from another MCP server never passed propose_helper_rule's checks.
    if name == "mcp__ckanban__propose_helper_rule" {
        // A line the tool would refuse shows no card, even before its result arrives.
        let text = cards::helper_line_text(inp("text"));
        if cards::suggested_line_error(&text).is_some() {
            return None;
        }
        let reason = cards::helper_line_text(inp("reason"));
        let mut r = Obj::new();
        r.insert("text".into(), text.into());
        r.insert("reason".into(), js::cut16(&reason, 300).into());
        return Some(one("helperRule", Value::Object(r)));
    }
    // A refused call (no such schedule, another board, a huddle helper) comes back as an error and shows no card.
    if tool_is(&name, "delete_schedule") {
        let id = str_trim(inp("id"));
        if id.is_empty() {
            return None;
        }
        let mut r = Obj::new();
        r.insert("id".into(), id.into());
        r.insert("reason".into(), str_trim(inp("reason")).into());
        return Some(one("scheduleDeletion", Value::Object(r)));
    }
    if tool_is(&name, "ask_keys") {
        return cards::parse_keys_ask(input).map(|k| one("keys", k));
    }
    if tool_is(&name, "ask_questions") {
        let questions = parse_questions(inp("questions").unwrap_or(&Value::Null))?;
        let mut o = one("questions", questions);
        if let Some(ask) = parse_ask_meta(input) {
            o.insert("ask".into(), Value::Object(ask));
        }
        return Some(o);
    }
    if tool_is(&name, "propose_ticket") {
        return parse_proposal(input).map(|p| one("proposal", p));
    }
    if tool_is(&name, "propose_branch") {
        return Some(one("branch", Value::Object(one("reason", str_trim(inp("reason")).into()))));
    }
    if tool_is(&name, "propose_delete") {
        let mut ids: Vec<Value> = Vec::new();
        if let Some(Value::Array(a)) = inp("ids") {
            for id in a.iter().filter_map(Value::as_str).map(js::trim).filter(|s| !s.is_empty()) {
                if !ids.iter().any(|x| x == id) {
                    ids.push(id.into());
                }
            }
        }
        if ids.is_empty() {
            return None;
        }
        let mut d = with_reason("ids", ids.into(), str_trim(inp("reason")));
        // Waiting jobs Claude proposes to cancel with the delete (true: all of them); the card shows them ticked and
        // only the user's click cancels anything. The card looks the waiting jobs up itself (`GET .../jobs?scheduledBy=`).
        match inp("cancelJobs") {
            Some(Value::Bool(true)) => {
                d.insert("cancelJobs".into(), true.into());
            }
            Some(Value::Array(a)) => {
                let jobs: Vec<Value> = a.iter().filter_map(Value::as_str).map(js::trim).filter(|s| !s.is_empty()).map(Value::from).collect();
                if !jobs.is_empty() {
                    d.insert("cancelJobs".into(), jobs.into());
                }
            }
            _ => {}
        }
        return Some(one("deletion", Value::Object(d)));
    }
    if tool_is(&name, "propose_teammate") {
        return cards::parse_teammate_proposal(input).map(|t| one("teammate", t));
    }
    if tool_is(&name, "propose_squad") {
        return cards::parse_squad_proposal(input).map(|s| one("squad", s));
    }
    if tool_is(&name, "propose_automation") {
        return cards::parse_automation_proposal(input).map(|a| one("automation", a));
    }
    if tool_is(&name, "propose_huddle") {
        // `squad` is the name Claude is told; older calls say `template`.
        let template = [inp("squad"), inp("template")].into_iter().map(str_trim).find(|s| !s.is_empty());
        // With a squad the roster is optional: the card fills in the squad's.
        let roster = match (template, inp("roster")) {
            (Some(_), None) => Value::Array(Vec::new()),
            (_, r) => r.cloned().unwrap_or(Value::Null),
        };
        let empty_with_squad = template.is_some() && roster.as_array().is_some_and(Vec::is_empty);
        if !empty_with_squad && cards::roster_error(&roster, cards::DEFAULT_MAX_PARTICIPANTS).is_some() {
            return None;
        }
        let mut h = Obj::new();
        h.insert("roster".into(), ckanban_core::jsnum::normalize(roster));
        h.insert("reason".into(), str_trim(inp("reason")).into());
        if let Some(t) = template {
            h.insert("template".into(), t.into());
        }
        if let Some(b) = cards::proposed_budget(inp("maxCostUsd")).filter(Value::is_number) {
            h.insert("maxCostUsd".into(), b);
        }
        let topic = js::cut16(str_trim(inp("topic")), cards::TOPIC_MAX);
        if !topic.is_empty() {
            h.insert("topic".into(), topic.into());
        }
        return Some(one("huddle", Value::Object(h)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::card_entry;
    use serde_json::{Value, json};

    fn deletion(input: Value) -> Option<Value> {
        card_entry(&json!({ "type": "tool_use", "name": "mcp__ckanban__propose_delete", "input": input })).and_then(|o| o.get("deletion").cloned())
    }

    #[test]
    fn a_delete_card_carries_the_jobs_claude_proposed_to_cancel() {
        assert_eq!(deletion(json!({ "ids": ["t_1"], "reason": "r" })), Some(json!({ "ids": ["t_1"], "reason": "r" })));
        assert_eq!(deletion(json!({ "ids": ["t_1"], "reason": "r", "cancelJobs": true })), Some(json!({ "ids": ["t_1"], "reason": "r", "cancelJobs": true })));
        assert_eq!(deletion(json!({ "ids": ["t_1"], "reason": "r", "cancelJobs": [" j1 ", ""] })), Some(json!({ "ids": ["t_1"], "reason": "r", "cancelJobs": ["j1"] })));
        assert_eq!(deletion(json!({ "ids": ["t_1"], "reason": "r", "cancelJobs": false })), Some(json!({ "ids": ["t_1"], "reason": "r" })));
    }
}
