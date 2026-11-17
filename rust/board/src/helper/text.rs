//! The helper's small text rules (`src/helper/core.ts`, `runner-text.ts`, `runner-config.ts`): the phone line cut,
//! clock times, what a wait needs in one line, the summary's count, reminder texts, the fail-over order of channels.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::local;
use crate::runs::js::{head16, is_ws, len16, squash_ws, trim};

/// Phone line length.
pub const ONE_LINE_MAX: usize = 110;

/// `cut(s, max)`: spaces folded, trimmed, and cut to `max` UTF-16 units with an ellipsis.
pub fn cut(s: &str, max: usize) -> String {
    let flat = squash_ws(s);
    let flat = trim(&flat);
    if len16(flat) <= max {
        return flat.to_string();
    }
    let head = head16(flat, max.saturating_sub(1)).trim_end_matches(is_ws);
    format!("{head}…")
}

pub fn cut1(s: &str) -> String {
    cut(s, ONE_LINE_MAX)
}

/// `clockTime(iso)`: "3:00" or "15:30" in this Mac's time.
pub fn clock_time(iso: &str) -> String {
    match ckanban_core::time::parse_date(iso) {
        Some(ms) => clock_ms(ms),
        None => "NaN:NaN".into(),
    }
}

pub fn clock_ms(ms: f64) -> String {
    let p = local::parts(ms);
    format!("{}:{:02}", p.hour, p.minute)
}

/// "Usage limit: 4 tickets paused until 3:00".
pub fn usage_limit_line(count: usize, reset_at: Option<&str>) -> String {
    let n = if count == 1 { "1 ticket".to_string() } else { format!("{count} tickets") };
    match reset_at {
        Some(r) => format!("Usage limit: {n} paused until {}", clock_time(r)),
        None => format!("Usage limit: {n} paused"),
    }
}

/// `directLabel(rec)`: a question's first line (never just "Answer 1 question"), else the label.
pub fn direct_label(kind: &str, question: &str, label: &str) -> String {
    if kind != "questions" || question.is_empty() || question == label {
        return label.to_string();
    }
    match question.split('\n').map(trim).find(|l| !l.is_empty()) {
        Some(first) => cut1(first),
        None => label.to_string(),
    }
}

/// `itemStateKey`: a message item's wait key, else "<board>/<ticketId>".
pub fn item_state_key(i: &Value) -> String {
    match i.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()) {
        Some(k) => k.to_string(),
        None => format!("{}/{}", s(i, "board"), s(i, "ticketId")),
    }
}

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

const WS: &str = crate::runs::js::WS;

/// A count the helper put at the start of a summary line ("6 tickets wait on you: ").
static LEADING_COUNT: LazyLock<Regex> = LazyLock::new(|| {
    let w = WS;
    Regex::new(&format!(
        r"(?i)^{w}*[0-9]+{w}+(?:[\p{{L}}-]+{w}+){{0,3}}?(?:waits?|are{w}+waiting|is{w}+waiting|needs?{w}+you|need{w}+your{w}+[A-Za-z0-9_]+|new{w}+for{w}+you)(?:{w}+on{w}+you|{w}+for{w}+you)?{w}*(?:[:,.;\u{{2014}}\u{{2013}}-]{w}*)?"
    ))
    .expect("leading count")
});

/// `summaryLine(total, line)`: "N new for you: <what the helper said>", the helper's own count dropped.
pub fn summary_line(total: usize, line: &str) -> String {
    let rest = LEADING_COUNT.replace(line, "");
    let rest = trim(&rest);
    if total == 0 {
        return cut1(if rest.is_empty() { trim(line) } else { rest });
    }
    let head = format!("{total} new for you");
    cut1(&if rest.is_empty() { head } else { format!("{head}: {rest}") })
}

pub const NEXT_PREFIX: &str = "Next: I'll remind you";
pub const NO_REMINDERS: &str = "No reminders planned: this is the only alert.";
pub const ASK_PREFIX: &str = "Right call?";

/// "Reminder n of of" for the step at `index` (skipped steps don't count; step 0 is the alert).
pub fn reminder_count(skipped: &[bool], index: usize) -> (usize, usize) {
    let n = skipped.iter().skip(1).take(index).filter(|x| !**x).count();
    let n = n.max(1);
    let left = skipped.len().saturating_sub(index + 1);
    (n, n + left)
}

/// A reminder's text from the alert's: the alert without its closing "Next: ..." and "Right call?" lines.
pub fn reminder_body(text: &str) -> String {
    let mut parts: Vec<&str> = text.split("\n\n").collect();
    let plan = |p: &str| p.starts_with(NEXT_PREFIX) || p == NO_REMINDERS || p.starts_with(ASK_PREFIX);
    while parts.len() > 1 && plan(parts[parts.len() - 1]) {
        parts.pop();
    }
    parts.join("\n\n")
}

/// The fail-over order for one step: its channel, the later planned ones, then any other that is on; a phone step
/// tries every phone channel before this Mac.
pub fn step_chain(channel: &str, later: &[String], on: &[String]) -> Vec<String> {
    let mut chain: Vec<String> = Vec::new();
    for c in std::iter::once(channel.to_string()).chain(later.iter().cloned()).chain(on.iter().cloned()) {
        if !chain.contains(&c) {
            chain.push(c);
        }
    }
    if channel == "mac" {
        return chain;
    }
    let (mac, rest): (Vec<String>, Vec<String>) = chain.into_iter().partition(|c| c == "mac");
    rest.into_iter().chain(mac).collect()
}

/// What went wrong on each channel, for the log.
pub fn failures(results: &[Value]) -> String {
    if results.is_empty() {
        return "no channel is on".into();
    }
    results
        .iter()
        .map(|r| format!("{}: {}", s(r, "channel"), r.get("error").and_then(Value::as_str).unwrap_or("not reached")))
        .collect::<Vec<_>>()
        .join("; ")
}

/// "Kept quiet: 2 tickets, nothing urgent. They'll be in the next summary, by 12:41."
pub fn kept_quiet_line(n: usize, by: &str) -> String {
    if n == 1 {
        format!("Kept quiet: 1 ticket, nothing urgent. It'll be in the next summary, by {by}.")
    } else {
        format!("Kept quiet: {n} tickets, nothing urgent. They'll be in the next summary, by {by}.")
    }
}

/// Plain names of channels.
pub fn label(c: &str) -> String {
    match c {
        "mac" => "this Mac".into(),
        "push" => "phone".into(),
        "webhook" => "ntfy".into(),
        "telegram" => "Telegram".into(),
        _ => c.to_string(),
    }
}

/// Why an item's reminders had stopped before a Got it, in plain words.
pub fn stopped_why(why: &str) -> String {
    match why {
        "opened" => "you opened it",
        "answered" => "it was answered",
        "got-it" => "you tapped Got it",
        "not-urgent" => "you tapped Not urgent",
        "expired" => "their time ran out",
        "off" => "the helper was turned off",
        "deleted" => "the ticket was deleted",
        "cleared" | "closed" => "it no longer waits on you",
        other => return other.to_string(),
    }
    .to_string()
}

static PREP: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?i)^prep:.*(?-u:\b)at{WS}+([0-9]{{1,2}})[:.]([0-9]{{2}})(?-u:\b)")).expect("prep"));

/// When a check-in's prep item's meeting starts (ms), or None when its title names no time.
pub fn meeting_time(title: &str, created_at: &str) -> Option<f64> {
    let c = PREP.captures(trim(title))?;
    let h: u32 = c[1].parse().ok()?;
    let min: u32 = c[2].parse().ok()?;
    if h > 23 || min > 59 {
        return None;
    }
    let created = ckanban_core::time::parse_date(created_at).unwrap_or(f64::NAN);
    if created.is_nan() {
        return None;
    }
    let p = local::parts(created);
    let mut at = local::make(p.year, p.month0 as i64, p.day as i64, h, min);
    if at < created {
        at = local::make(p.year, p.month0 as i64, p.day as i64 + 1, h, min);
    }
    Some(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cuts_like_bun() {
        assert_eq!(cut("  a \n b  ", 110), "a b");
        assert_eq!(cut("abcdef", 4), "abc…");
        assert_eq!(cut("ab  cdef", 4), "ab…");
    }

    #[test]
    fn summary_line_drops_the_helpers_count() {
        assert_eq!(summary_line(2, "6 tickets wait on you: docs copy"), "2 new for you: docs copy");
        assert_eq!(summary_line(1, "5 wait on you - pricing"), "1 new for you: pricing");
        assert_eq!(summary_line(0, "From check-ins"), "From check-ins");
        assert_eq!(summary_line(3, ""), "3 new for you");
    }

    #[test]
    fn chains_and_counts() {
        let on = vec!["mac".to_string(), "push".to_string(), "telegram".to_string()];
        assert_eq!(step_chain("push", &["mac".into()], &on), ["push", "telegram", "mac"]);
        assert_eq!(step_chain("mac", &[], &on), ["mac", "push", "telegram"]);
        assert_eq!(reminder_count(&[false, false, true, false], 3), (2, 2));
        assert_eq!(reminder_body("a\n\nNext: I'll remind you x\n\nRight call? y"), "a");
    }
}
