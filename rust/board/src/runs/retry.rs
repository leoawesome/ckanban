//! One automatic retry for runs that die on a passing API problem (`src/runs/retry.ts`), and the usage limit check it
//! leaves out (`isLimitText` from `src/usage/limit.ts`; the rest of `limit.ts` is R7a's).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::js;

/// Pause before the retry.
pub const RETRY_DELAY_MS: u64 = 30_000;
/// What the resumed session is told.
pub const RETRY_TEXT: &str = "Your previous run stopped on a temporary API error before it finished. Continue where you left off.";

// JS's `\b` and `\w` (no u flag) are ASCII; Rust's are Unicode unless asked otherwise.
static TRANSIENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i-u)\boverloaded|\b(?:500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway time-?out",
        r"|\bapi_error\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+",
        r"|socket hang up|fetch failed|network error|connection error|connection (?:reset|closed|refused)|request timed out",
    ))
    .expect("transient regex")
});

/// stderr's last line: network failures and named API errors, not bare status codes.
static STDERR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i-u)\boverloaded|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNRESET|ECONNREFUSED",
        r"|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+|socket hang up|fetch failed|network error|request timed out|API Error: (?:5\d\d|529)",
    ))
    .expect("stderr regex")
});

static LIMIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)hit your(?-u:\b)[^\n·]*(?-u:\b)limit(?-u:\b)|(?-u:\b)(?:usage|spend|session|weekly|opus|sonnet|5-hour)\s+limit(?-u:\b)|(?-u:\b)limit reached(?-u:\b)")
        .expect("limit regex")
});
// Transient API throttling ("rate limit", "rate_limit_error") and the board's own caps aren't a usage limit.
static NOT_LIMIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\brate[ _]limit|\b(?:retry|wake-up|create) limit reached").expect("not-limit regex"));

/// `isLimitText`: the text says the Claude usage/spend limit was hit.
pub fn is_limit_text(text: &str) -> bool {
    // JS's `\s` in LIMIT_RE: map JS white space to a plain space first so Rust's Unicode `\s` can't differ.
    let t: String = text.chars().map(|c| if js::is_ws(c) && c != '\n' { ' ' } else { c }).collect();
    LIMIT_RE.is_match(&t) && !NOT_LIMIT_RE.is_match(text)
}

/// The text names a passing API or network problem (and not the usage limit, which waits for its reset instead).
pub fn is_transient_text(text: &str) -> bool {
    TRANSIENT_RE.is_match(text) && !is_limit_text(text)
}

fn event_text(ev: &Value) -> String {
    if ev.get("type").and_then(Value::as_str) == Some("result") {
        let errors = ev.get("errors").and_then(Value::as_array).map(|a| a.iter().map(js::to_string).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let result = ev.get("result").and_then(Value::as_str).unwrap_or("");
        return [result, errors.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    }
    match ev.pointer("/message/content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|b| match (b.get("type").and_then(Value::as_str), b.get("text").and_then(Value::as_str)) {
                (Some("text"), Some(t)) => t,
                _ => "",
            })
            .collect(),
        _ => String::new(),
    }
}

/// An assistant API-error message or an error result: the only events whose words are the CLI's own.
pub fn is_api_error(ev: &Value) -> bool {
    match ev.get("type").and_then(Value::as_str) {
        Some("assistant") => js::truthy(ev.get("is_api_error_message")) || js::truthy(ev.get("error")),
        Some("result") => js::truthy(ev.get("is_error")),
        _ => false,
    }
}

/// `transientError`: the passing API error a failed run ended with, or None. Looks only at the CLI's own API-error
/// messages and result (never Claude's words) and at stderr's last line.
pub fn transient_error(events: &[Value], stderr: &str) -> Option<String> {
    for ev in events.iter().rev() {
        if !is_api_error(ev) {
            continue;
        }
        let status = js::number(ev.get("api_error_status"));
        let text = js::trim(&event_text(ev)).to_string();
        if status >= 500.0 || (!text.is_empty() && is_transient_text(&text)) {
            return Some(if text.is_empty() { format!("API error {}", ckanban_core::jsnum::js_string(status)) } else { text });
        }
        // Nothing to judge it by: look further back.
        if text.is_empty() && (status == 0.0 || status.is_nan()) {
            continue;
        }
        // The last API error is a lasting one (bad request, auth): that is what the run died on.
        return None;
    }
    // Only a run that never got to a result died on stderr; only its last line says why.
    if events.iter().any(|e| e.get("type").and_then(Value::as_str) == Some("result")) {
        return None;
    }
    let last = stderr.split('\n').map(js::trim).rfind(|l| !l.is_empty()).unwrap_or("");
    (!last.is_empty() && STDERR_RE.is_match(last) && !is_limit_text(last)).then(|| last.to_string())
}

/// `limitMessage` in `src/usage/limit.ts`: the limit message a run ended with, or None (R7a's limit wait uses it).
pub fn limit_message(events: &[Value], stderr: &str) -> Option<String> {
    for ev in events.iter().rev() {
        if !is_api_error(ev) {
            continue;
        }
        // limit.ts reads a result's text without its errors.
        let text = if ev.get("type").and_then(Value::as_str) == Some("result") {
            ev.get("result").and_then(Value::as_str).unwrap_or("").to_string()
        } else {
            event_text(ev)
        };
        let text = js::trim(&text);
        if !text.is_empty() && is_limit_text(text) {
            return Some(text.to_string());
        }
    }
    stderr.split('\n').map(js::trim).rfind(|l| !l.is_empty() && is_limit_text(l)).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn overloaded_is_transient_limit_is_not() {
        let ev = json!({"type":"result","is_error":true,"api_error_status":529,"result":"API Error: 529 overloaded"});
        assert_eq!(transient_error(&[ev], "").as_deref(), Some("API Error: 529 overloaded"));
        let lim = json!({"type":"result","is_error":true,"api_error_status":429,"result":"You've hit your session limit · resets 4am"});
        assert_eq!(transient_error(std::slice::from_ref(&lim), ""), None);
        assert!(limit_message(&[lim], "").is_some());
        assert!(!is_limit_text("rate limit reached"));
    }
}
