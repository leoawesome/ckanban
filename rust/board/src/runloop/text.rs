//! Small text rules of the run's end (`board.ts`, `session-markers.ts`, `main-ticket.ts`, `usage/spend.ts`).

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

static RESULT_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^[^\n\r\u{2028}\u{2029}]*CKANBAN_RESULT:[^\n\r\u{2028}\u{2029}]*$").unwrap());
/// `MOVE_TO_PLANNING_RE`.
static MOVE_TO_PLANNING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<ckanban-move\s+to="planning"\s*/?>(?:\s*</ckanban-move>)?"#).unwrap());
/// `STAY_RE`.
static STAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<ckanban-stay\s*/?>(?:\s*</ckanban-stay>)?").unwrap());
static BULLET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[#>*\-\s]+").unwrap());

/// `finalText.replace(/^.*CKANBAN_RESULT:.*$/gm, "").replace(MOVE_TO_PLANNING_RE, "")` (not trimmed).
pub fn result_body(text: &str) -> String {
    let no_result = RESULT_LINE.replace_all(text, "");
    MOVE_TO_PLANNING.replacen(&no_result, 1, "").into_owned()
}

/// `MOVE_TO_PLANNING_RE.test(text)`.
pub fn moves_to_planning(text: &str) -> bool {
    MOVE_TO_PLANNING.is_match(text)
}

/// `STAY_RE.test(text)`.
pub fn stays(text: &str) -> bool {
    STAY.is_match(text)
}

/// `l.replace(/^[#>*\-\s]+/, "").trim()`.
pub fn strip_bullet(l: &str) -> String {
    crate::runs::js::trim(&BULLET.replace(l, "")).to_string()
}

/// `addTelegramSpend`: what turns Telegram started cost today ("Spent from Telegram today"), 60 days kept.
pub fn add_telegram_spend(root: &Path, cost: f64, now: f64) {
    if !(cost > 0.0) || !cost.is_finite() {
        return;
    }
    let file = root.join("telegram-spend.json");
    let mut ledger: Map<String, Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| crate::runs::js::parse(&t))
        .and_then(|v| v.as_object().cloned())
        .map(|m| {
            m.into_iter()
                .filter(|(k, n)| k.len() == 10 && k.as_bytes()[4] == b'-' && k.as_bytes()[7] == b'-' && k.chars().filter(char::is_ascii_digit).count() == 8 && n.as_f64().is_some_and(|x| x > 0.0))
                .collect()
        })
        .unwrap_or_default();
    let day = super::limit::day_key(now);
    let prev = ledger.get(&day).and_then(Value::as_f64).unwrap_or(0.0);
    ledger.insert(day, ckanban_core::jsnum::num(prev + cost));
    let mut keys: Vec<String> = ledger.keys().cloned().collect();
    keys.sort();
    let keep = keys.len().saturating_sub(60);
    let mut out = Map::new();
    for k in &keys[keep..] {
        if let Some(v) = ledger.get(k) {
            out.insert(k.clone(), v.clone());
        }
    }
    let text = format!("{}\n", crate::runs::js::stringify(&Value::Object(out)));
    if let Err(e) = ckanban_core::atomic::atomic_write(&file, text.as_bytes()) {
        eprintln!("[board] telegram spend: {e}");
    }
}
