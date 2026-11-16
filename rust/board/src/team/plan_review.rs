//! The plan a plan review huddle checks (`src/huddle/plan-review-file.ts`, `outputs/huddles/<id>/proposal.md`): the
//! latest ticket the Planning chat proposed, as written, with no chat text. Reviewers read only this, so they see the
//! plan the way the worker will. Pure: the huddle start reads the chat and writes the file.

use serde_json::Value;

use super::jsv;
use crate::prompts::js;

/// `planProposal`: the file's text from the ticket (`id`, `title`, `body`) and its chat's session entries (failed
/// tool calls already left out).
pub fn plan_proposal(ticket: &Value, entries: &[Value]) -> String {
    let t = |k: &str| jsv::js_string(jsv::field(Some(ticket), k));
    let head = format!("# Plan under review (ticket {})", t("id"));
    let proposal = entries
        .iter()
        .rev()
        .find(|e| jsv::str_of(jsv::field(Some(e), "role")) == Some("assistant") && jsv::truthy(jsv::field(Some(e), "proposal")))
        .and_then(|e| jsv::field(Some(e), "proposal"));
    let Some(p) = proposal else {
        let body = js::trim(jsv::str_of(jsv::field(Some(ticket), "body")).unwrap_or(""));
        let body = if body.is_empty() { "(no description)" } else { body };
        return format!(
            "{head}\n\nNothing was proposed in the ticket's chat, so this is the ticket's current title and description.\n\n## Ticket: {}\n\n{body}\n",
            t("title")
        );
    };
    let pf = |k: &str| jsv::field(Some(p), k);
    let title = if jsv::truthy(pf("title")) { jsv::js_string(pf("title")) } else { t("title") };
    let desc = if jsv::truthy(pf("description")) { jsv::js_string(pf("description")) } else { "(no description)".into() };
    format!("{head}\n\nThe latest ticket proposed in the ticket's chat, as written.\n\n---\n\n## Proposed ticket: {title}\n\n{desc}\n")
}
