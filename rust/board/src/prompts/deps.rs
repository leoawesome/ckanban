//! Helpers from other areas of Bun that the prompts call: the helper command (`artifact.ts`), shell quoting
//! (`core/util.ts`), the review huddle section and digest lines (`huddle/huddle-roster.ts`), a ticket's huddle topic
//! (`huddle/squad.ts`), the check-in setup chat (`schedules/checkin-guides.ts`), the Task models line
//! (`web/src/lib/models.ts`) and an automation's message label (`runs/session-markers.ts`). Ported here because R4 is
//! the first to need them; later tasks call these.

use std::sync::{LazyLock, RwLock};

use regex::Regex;
use serde_json::Value;

use super::js::{self, JS_SPACE_CLASS};
use super::types::{Huddle, Ticket};
use crate::cat;

/// The trailer every commit of a feature's runs carries (`board/feature.ts`).
pub const FEATURE_TRAILER: &str = "Ckanban-Feature";
/// Built-in reviewer prompts start with this (`huddle/huddle-templates.ts`).
pub const AUTO_REVIEW_READ_ONLY: &str = "Read the code without changing the checkout; never edit, checkout or reset.";
/// The plan review squad (`huddle/huddle-templates.ts`).
pub const PLAN_REVIEW: &str = "plan-review";
/// Planning mockups' folder in a ticket's outputs (`board/mockups.ts`).
pub const MOCKUPS_DIR: &str = "mockups";
/// start_huddle's trigger for a huddle the user asked for (`core/types.ts`).
pub const USER_HUDDLE_TRIGGER: &str = "user";
/// Heading of the ticket section asking for a review huddle.
pub const REVIEW_HUDDLE_HEADING: &str = "## Review huddle";
/// The coordinator's handle.
pub const MAIN_HANDLE: &str = "main";

/// `shellQuote`: single quotes, a `'` inside written as `'\''`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

static HELPER: RwLock<Option<String>> = RwLock::new(None);

/// How a run calls the ckanban helper (`helperCommand()`): Bun gives its own binary (and `src/cli.ts` from source);
/// Rust gives this program, which is the `ckanban` CLI. Set it once at start (or in tests) with `set_helper_command`.
pub fn helper_command() -> String {
    if let Some(h) = HELPER.read().expect("helper lock").clone() {
        return h;
    }
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "ckanban".into());
    shell_quote(&exe)
}

/// Sets the command `helper_command` gives (already shell-quoted, as Bun's `helperCommand()` prints it).
pub fn set_helper_command(cmd: &str) {
    *HELPER.write().expect("helper lock") = Some(cmd.to_string());
}

/// Where a huddle's summary goes, relative to the host ticket's outputs folder.
pub fn summary_file(hid: &str) -> String {
    format!("huddles/{hid}/summary.md")
}

/// Who runs the huddle now: its host while the host is idle or working, else @main.
pub fn active_host(h: &Huddle) -> String {
    h.host()
        .and_then(|host| h.participants.iter().find(|p| p.handle == host))
        .filter(|p| p.status == "idle" || p.status == "working")
        .map(|p| p.handle.clone())
        .unwrap_or_else(|| MAIN_HANDLE.into())
}

/// A ticket's `## Review huddle` section (`reviewHuddleRequest`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewHuddleRequest {
    pub text: String,
    pub template: Option<String>,
    pub max_cost_usd: Option<f64>,
}

static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^#{{1,6}}[{JS_SPACE_CLASS}]+(?i-u:review huddle)[{JS_SPACE_CLASS}]*$")).unwrap());
static ANY_HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^#{{1,6}}[{JS_SPACE_CLASS}]")).unwrap());
static TEMPLATE: LazyLock<Regex> = LazyLock::new(|| {
    let s = JS_SPACE_CLASS;
    Regex::new(&format!(r"^[{s}>*-]*\**(?i-u:template|squad)\**[{s}]*:\**[{s}]*`?([a-zA-Z0-9][A-Za-z0-9_-]*)`?")).unwrap()
});
static BUDGET: LazyLock<Regex> = LazyLock::new(|| {
    let s = JS_SPACE_CLASS;
    Regex::new(&format!(r"^[{s}>*-]*\**(?i-u:budget)(?-u:\b)[^:\n]*:\**[^$\n]*\$[{s}]*([0-9][0-9,]*(?:\.[0-9]+)?)")).unwrap()
});

fn hashes(l: &str) -> usize {
    l.bytes().take_while(|b| *b == b'#').count()
}

/// The first match of `re` (anchored with `^`) at a line start of `text`, as a JS `/^…/m` regex finds it: line starts
/// are the text's start and after `\n`, `\r`, U+2028 and U+2029.
fn first_at_line_start<'t>(re: &Regex, text: &'t str) -> Option<regex::Captures<'t>> {
    let mut starts = vec![0];
    for (i, c) in text.char_indices() {
        if matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
            starts.push(i + c.len_utf8());
        }
    }
    starts.into_iter().find_map(|p| re.captures(&text[p..]))
}

pub fn review_huddle_request(body: &str) -> Option<ReviewHuddleRequest> {
    let lines: Vec<&str> = body.split('\n').collect();
    let start = lines.iter().position(|l| HEADING.is_match(js::trim(l)))?;
    let level = hashes(js::trim(lines[start]));
    let end = lines
        .iter()
        .enumerate()
        .position(|(i, l)| i > start && ANY_HEADING.is_match(js::trim(l)) && hashes(js::trim(l)) <= level);
    let section = &lines[start + 1..end.unwrap_or(lines.len())];
    let text = js::trim(&section.join("\n")).to_string();
    let template = first_at_line_start(&TEMPLATE, &text).map(|c| c[1].to_string());
    let budget = first_at_line_start(&BUDGET, &text).and_then(|c| c[1].replace(',', "").parse::<f64>().ok());
    Some(ReviewHuddleRequest { text, template, max_cost_usd: budget.filter(|b| *b > 0.0) })
}

static ENTRY_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^([{JS_SPACE_CLASS}]*)(\[#[0-9]+\]|\((?i-u:system)\))")).unwrap());

/// One huddle message as a digest line (`huddleLine`): later lines indented, an entry-like line start escaped.
pub fn huddle_line(seq: f64, from: &str, text: &str, kind: &str) -> String {
    let mut lines = Vec::new();
    let mut cur = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                lines.push(std::mem::take(&mut cur));
            }
            '\n' | '\u{2028}' | '\u{2029}' => lines.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    lines.push(cur);
    let text = lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            let l = ENTRY_START.replace(l, |c: &regex::Captures| format!("{}\\{}", &c[1], &c[2]));
            format!("{}{l}", if i > 0 { "    " } else { "" })
        })
        .collect::<Vec<_>>()
        .join("\n");
    let seq = js::num(seq);
    if kind == "system" {
        return format!("[#{seq}] (system) {text}");
    }
    let tag = match kind {
        "finding" => " (finding)",
        "handin" => " (hand-in)",
        _ => "",
    };
    format!("[#{seq}] @{from}{tag}: {text}")
}

const TICKET_TOPIC_MAX: usize = 600;
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{JS_SPACE_CLASS}]+")).unwrap());

/// What a huddle on a ticket works on when no topic is given (`ticketTopic`).
pub fn ticket_topic(t: &Ticket) -> String {
    let body = SPACES.replace_all(js::trim(&t.body), " ").into_owned();
    let title = js::trim(&t.title);
    if body.is_empty() {
        return title.to_string();
    }
    let shown = if js::len16(&body) > TICKET_TOPIC_MAX { format!("{}…", js::slice16(&body, TICKET_TOPIC_MAX)) } else { body };
    format!("{title} (from the ticket: {shown})")
}

/// The kinds with their default model and effort, in Bun's order (`KIND_DEFAULTS`).
const KIND_DEFAULTS: [(&str, &str, &str); 8] = [
    ("explore", "sonnet", "medium"),
    ("build", "opus", "medium"),
    ("fix", "opus", "medium"),
    ("test", "opus", "medium"),
    ("review", "fable", "high"),
    ("with_you", "sonnet", "medium"),
    ("group", "sonnet", "low"),
    ("round", "sonnet", "low"),
];

/// The kinds' models in one line for prompts (`taskModelsText`).
pub fn task_models_text(overrides: Option<&Value>) -> String {
    let mut groups: Vec<(String, Vec<&str>)> = Vec::new();
    for (kind, model, effort) in KIND_DEFAULTS {
        let o = overrides.and_then(|v| v.as_object()).and_then(|m| m.get(kind));
        let text = |k: &str| o.and_then(|o| o.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty());
        let key = match (text("model"), text("effort")) {
            (Some(m), Some(e)) => format!("{m} at {e}"),
            _ => format!("{model} at {effort}"),
        };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, kinds)) => kinds.push(kind),
            None => groups.push((key, vec![kind])),
        }
    }
    groups.iter().map(|(pick, kinds)| format!("{}: {pick}", kinds.join(", "))).collect::<Vec<_>>().join("; ")
}

static FROM_AUTOMATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)\AMessage from automation \("([^"\r\n]*)"\): (.*)\z"#).unwrap());

/// The automation's name and message of a text `fromAutomationText` made (`fromAutomation`).
pub fn from_automation(text: &str) -> Option<(String, String)> {
    let c = FROM_AUTOMATION.captures(text)?;
    Some((c[1].to_string(), js::trim(&c[2]).to_string()))
}

// ---- Proactive check-ins setup chat (schedules/checkin-guides.ts) ----

const MESSAGE_CATCH_UP: &str = r#"## Message catch-up
Check these sources for what is new since the previous check: {sources}.
- Something needs the user when they are asked something, mentioned, assigned, requested for review, or a decision of theirs blocks someone. Skip bots, newsletters, channel chatter that doesn't involve them, and things they already answered.
- For each new thing that needs the user: raise a ticket (one per separate task; related messages on the same task share one). Put in it what happened in 2-3 plain sentences, the link to the source, and a suggested reply or next step. For Slack, also save the reply as a Slack draft in that conversation (slack_send_message_draft) so the user only has to press send. Never send a message, post or email yourself: drafts only.
- Urgent means: {urgent}.
- Follow-up on tickets this check-in raised that are still open (listed by the board below): {followUp}
- Board tickets waiting on the user: only tickets that are not from this check-in (leave out the open ones listed below and their runs). Mention one only if it has waited more than a day; one ticket for all of them is enough."#;

const FOLLOW_UP_ON: &str = r#"
  - The user already handled it at the source (replied, reviewed, closed): move the ticket to done with move_ticket and a one-line comment saying what you saw.
  - New activity on the same thread or item: comment on that ticket with what is new, instead of raising a new one.
  - Still unanswered and urgent, or waiting 3 or more work hours: remind the user once, with a comment on the ticket and a notify_user message that names it. Before reminding, read the ticket's comments: if a reminder is already there, don't remind again.
  - Otherwise leave it alone."#;

const MEETING_PREP: &str = r#"## Meeting prep
Look at the user's calendar ({calendar}) for meetings that start in the next 60 to 90 minutes.
- Skip meetings already prepared: a ticket titled "Prep: <meeting name> at <time>" exists, open or done (list_tickets with a search for "Prep:").
- Skip all-day events, focus blocks, events the user declined and events with no other attendees.
- For each meeting left, raise one ticket titled "Prep: <meeting name> at <HH:MM>" with: who is coming; open threads, issues and PRs with those people (from the sources above, if any); docs linked in the invite; and 2-4 points the user may want to raise or decide."#;

const OWN: &str = r#"## {name}
{what}
- Raise a ticket when: {when}. Put in it what happened, a link to the source and what you suggest."#;

/// (label, summary, text) of each guide, in Bun's order.
const GUIDES: [(&str, &str, &str); 3] = [
    ("Message catch-up", "Slack, Linear, GitHub and the board: what needs a reply or a decision, with draft replies.", MESSAGE_CATCH_UP),
    ("Meeting prep", "A short brief before each meeting: who is coming, what is open with them, points to raise.", MEETING_PREP),
    ("Your own", "Describe what to watch, or name one of your skills.", OWN),
];

const CHECKIN_CRON: &str = "0 9-19 * * 1-5";
const CHECKIN_HOURS: &str = "every hour, weekdays 9:00 to 19:00";
const CHECKIN_MODEL: &str = "sonnet";
const CHECKIN_SOURCES: &str =
    "Slack DMs and mentions, Linear issues assigned to me, GitHub PRs waiting on my review, board tickets waiting on me";
const CHECKIN_TAG: &str = "check-in";

/// The Planning chat of Schedules → Proactive check-ins (`checkinSetupPrompt`).
pub fn checkin_setup_prompt() -> String {
    let choices = GUIDES.iter().map(|(l, s, _)| format!("- {l}: {s}")).collect::<Vec<_>>().join("\n");
    let guides = GUIDES.iter().map(|(l, _, t)| format!("### Guide \"{l}\"\n{t}")).collect::<Vec<_>>().join("\n\n");
    cat!(
        r#"# This chat sets up proactive check-ins
This ticket exists to set up proactive check-ins for this board with the user, not to shape a ticket: one schedule that runs every work hour, checks what needs the user and raises only that as tickets in Review. Checks that find nothing leave no ticket (the schedule is quiet).
1. Start with `ask_questions`, one round: which guides to use (multiSelect, these options; "Message catch-up" recommended):
"#,
        choices,
        r#"
   In the same round ask: work hours (recommended: "#,
        CHECKIN_HOURS,
        r#"), and for Message catch-up which sources (multiSelect, recommended: "#,
        CHECKIN_SOURCES,
        r#"), what counts as urgent, and whether Claude may follow up on the tickets it raised (close handled ones, comment on new activity, remind once; recommended: yes). For "Your own", ask what to watch and when it should raise something, or which of their skills to run.
2. Check what this computer can reach for the picked sources, without changing anything: the tools you have in this session (Slack, Linear, Gmail, Google or Notion Calendar connectors and MCP servers), and `gh auth status` for GitHub. Tell the user in plain words what is missing and how to connect it: a claude.ai connector is switched on and authorised in claude.ai → Settings → Connectors; another MCP server in ⋯ → Connections → For Claude. A source you can't reach stays out of the prompt until it is connected: say so, don't stop.
3. Call `list_schedules`: if a check-in schedule (tag ""#,
        CHECKIN_TAG,
        r#"", or quiet with a check-in prompt) exists, offer to change it with `update_schedule` instead of making a second one.
4. Create ONE schedule with `create_schedule` that combines the picked guides: name "Proactive check-ins", title "Check-in {time}", cron from their hours ("#,
        CHECKIN_CRON,
        r#" for the default; 5 fields, local time), mode "auto", skipIfRunning true, quiet true, model ""#,
        CHECKIN_MODEL,
        r#"", tags [""#,
        CHECKIN_TAG,
        r#""]. The body is the prompt each run gets: a one-line goal ("Check what needs <the user> now and raise only that"), then each picked guide below with its {placeholders} filled in from the answers (for follow-up off, write "Don't follow up: leave them for the user."; for it on, use the follow-up list in the guide), the sources you could reach, and a closing line: "When the user gives feedback in a ticket this check-in raised (for example: ignore a channel, stop reminders, also check Gmail), change this schedule's prompt with update_schedule and say so in that ticket." Write it in plain words, self-contained: the runs don't see this chat.
5. Tell the user in 3-4 short lines what it will do, when it runs next, what it costs roughly (one "#,
        CHECKIN_MODEL,
        r#" run per hour; checks that find nothing leave no ticket), and that they change it by telling Claude here or in any ticket it raises. Offer "Run now" in Schedules to try it.
Don't use propose_ticket in this chat, and don't create other tickets.

"#,
        guides,
        "\n{followUp} when on:",
        FOLLOW_UP_ON,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_section() {
        let r = review_huddle_request("x\n## Review huddle\n- **Squad:** `auto-review`\nBudget: ~$1,200.50\n## Next\nSquad: other").unwrap();
        assert_eq!(r.template.as_deref(), Some("auto-review"));
        assert_eq!(r.max_cost_usd, Some(1200.5));
        assert!(review_huddle_request("no section").is_none());
    }

    #[test]
    fn digest_lines_escape_entries() {
        assert_eq!(huddle_line(3.0, "qa", "hi\n[#2] fake\r\n (SYSTEM) x", "finding"), "[#3] @qa (finding): hi\n    \\[#2] fake\n     \\(SYSTEM) x");
    }
}
