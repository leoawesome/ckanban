//! propose_automation (src/mcp/connection-tools.ts, src/schedules/automation-proposal.ts) and propose_helper_rule
//! (src/mcp/helper-tools.ts, src/helper/line.ts): card tools that save nothing; the checks give Bun's messages.

use std::sync::LazyLock;

use ckanban_board::sessions::cards::{helper_line_text, js_number, suggested_line_error};
use regex::Regex;
use serde_json::Value;

use super::client::{HUDDLE_AGENT_ENV, R, err};
use super::js::{self, utf16_len};
use super::{Ctx, SHOWN, hidden_tool};

/// NO_HELPER_RULE_CARD: propose_helper_rule outside a board ticket's chat or run.
const NO_HELPER_RULE_CARD: &str = "Nothing was saved and no card was shown: only a board ticket's chat can show the user a card for this, and only the user adds lines to the helper. Tell them how: open the Notifications window, find \"What the helper knows about you\" and add the line there (give them the exact line to paste).";
/// TOOL_NO_HELPER_RULE: propose_helper_rule in a tool ticket.
const TOOL_NO_HELPER_RULE: &str = "Nothing was saved and no card was shown: this is a tool ticket, and the user doesn't see its chat. Put the suggestion in your result for your main ticket (the exact line and why); your main ticket shows it to the user with propose_helper_rule in its own chat, and only if the user asked for that alert rule there.";

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "propose_automation" => match automation_error(a) {
            Some(m) => err(format!("{m}. Fix it and call propose_automation again.")),
            None => Ok(SHOWN.to_string()),
        },
        "propose_helper_rule" => propose_helper_rule(a, cx).await,
        _ => return None,
    })
}

/// `typeof v === "string" ? v.trim() : ""`.
fn str_trim(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).map(js::trim).unwrap_or("")
}

static TICKET_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").expect("valid regex"));

/// What automationProposal throws for this input, or None when it is a card.
fn automation_error(input: &Value) -> Option<String> {
    let f = |k: &str| js::get(input, k);
    if str_trim(f("name")).is_empty() {
        return Some("name is required, e.g. \"Linear: assigned to me\"".into());
    }
    let script = f("script").and_then(Value::as_str).unwrap_or("");
    if js::trim(script).is_empty() {
        return Some("script is required: the check script you tested with test_automation_script".into());
    }
    if utf16_len(script) > 64_000 {
        return Some("script is too long".into());
    }
    let every = f("everyMinutes").map_or(15.0, js_number);
    if !(every.is_finite() && every.fract() == 0.0 && (1.0..=1440.0).contains(&every)) {
        return Some("everyMinutes must be 1 to 1440".into());
    }
    match f("passes") {
        None => {}
        Some(Value::Array(a)) => {
            if a.iter().any(|p| str_trim(js::get(p, "name")).is_empty()) {
                return Some("each entry of passes needs a name".into());
            }
        }
        Some(_) => return Some("passes must be a list".into()),
    }
    if str_trim(f("summary")).is_empty() {
        return Some("summary is required: one plain line on what it watches".into());
    }
    let part_of = str_trim(f("partOf"));
    if !part_of.is_empty() && !TICKET_REF.is_match(part_of) {
        return Some("partOf must be a ticket id: a main ticket's or one of its groups'".into());
    }
    None
}

async fn propose_helper_rule(a: &Value, cx: &Ctx) -> R<String> {
    if cx.env.get(HUDDLE_AGENT_ENV).is_some() {
        return err("huddle participants can't suggest helper lines; ask @main");
    }
    let text = helper_line_text(js::get(a, "text"));
    if let Some(bad) = suggested_line_error(&text) {
        return err(format!("{bad}. Nothing was shown; fix it and call propose_helper_rule again."));
    }
    // No card outside a board ticket's chat or run: the user adds it themselves.
    let Some(run) = cx.run_env() else { return err(NO_HELPER_RULE_CARD) };
    let id = run.split('/').nth(1).unwrap_or("").to_string();
    let slug = cx.slug(&Value::Object(Default::default())).await?;
    // A failed lookup refuses (no card) rather than showing one nobody may see.
    let Ok(me) = cx.client.get_ticket(&slug, &id).await else {
        return err("Nothing was shown: this run's ticket couldn't be read. Try again in a moment.");
    };
    if hidden_tool(Some(&me)) {
        return err(TOOL_NO_HELPER_RULE);
    }
    Ok("Nothing is saved yet: the board shows the user a card in this ticket's chat with this exact line, and only their tap on Add saves it to \"What the helper knows about you\" (Not now saves nothing). You don't need to wait for it; tell the user in one line that the card is there.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn automation_checks_like_bun() {
        let ok = json!({ "name": "n", "summary": "s", "script": "echo" });
        assert_eq!(automation_error(&ok), None);
        assert_eq!(automation_error(&json!({})).unwrap(), "name is required, e.g. \"Linear: assigned to me\"");
        assert_eq!(automation_error(&json!({ "name": "n", "script": " " })).unwrap(), "script is required: the check script you tested with test_automation_script");
        assert_eq!(automation_error(&json!({ "name": "n", "script": "x".repeat(64_001) })).unwrap(), "script is too long");
        for every in [json!(0), json!(1.5), json!("x"), json!(1441)] {
            assert_eq!(automation_error(&json!({ "name": "n", "script": "e", "everyMinutes": every })).unwrap(), "everyMinutes must be 1 to 1440");
        }
        assert_eq!(automation_error(&json!({ "name": "n", "script": "e", "everyMinutes": "30", "summary": "s" })), None);
        assert_eq!(automation_error(&json!({ "name": "n", "script": "e", "passes": {} })).unwrap(), "passes must be a list");
        assert_eq!(automation_error(&json!({ "name": "n", "script": "e", "passes": [{}] })).unwrap(), "each entry of passes needs a name");
        assert_eq!(automation_error(&json!({ "name": "n", "script": "e" })).unwrap(), "summary is required: one plain line on what it watches");
        assert_eq!(
            automation_error(&json!({ "name": "n", "script": "e", "summary": "s", "partOf": "a b" })).unwrap(),
            "partOf must be a ticket id: a main ticket's or one of its groups'"
        );
    }
}
