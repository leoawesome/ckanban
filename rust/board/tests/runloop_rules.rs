//! The run loop's pure rules (R7a) against Bun's answers (`tests/fixtures/runloop.json`, written by
//! `test/rust-board-runloop-fixtures.test.ts`): every case's output, as JSON text, must equal Bun's. Local time is
//! the file's zone (America/New_York), set for this whole test binary.

use ckanban_board::runloop::followup::{self, follow_up_spend, follow_up_time, format_at, log_follow_up, parse_at, parse_delay};
use ckanban_board::runloop::limit::{self, clock_time, day_key, next_full_hour, parse_reset};
use ckanban_board::runloop::rules::{self, *};
use ckanban_board::runloop::types::Chat;
use ckanban_core::jsnum::num;
use ckanban_core::time::iso;
use serde_json::{Map, Value, json};

fn doc() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/runloop.json")).expect("fixture file");
    let d: Value = serde_json::from_str(&text).expect("fixture JSON");
    // SAFETY: every test of this binary sets the same value before reading local time.
    unsafe { std::env::set_var("TZ", d["tz"].as_str().unwrap()) };
    d
}

/// Runs `f` on every case of `group` and lists the cases whose answer differs from Bun's.
fn check(group: &str, f: impl Fn(&Value) -> Value) {
    let d = doc();
    let cases = d["groups"][group].as_array().unwrap_or_else(|| panic!("group {group}"));
    assert!(!cases.is_empty());
    let bad: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let got = serde_json::to_string(&f(c)).unwrap();
            let want = c["expect"].as_str().unwrap();
            (got != want).then(|| format!("{c}\n  rust: {got}\n  bun:  {want}"))
        })
        .collect();
    assert!(bad.is_empty(), "{} of {} {group} cases differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

fn ms(v: &Value) -> f64 {
    followup::iso_ms(v.as_str().unwrap())
}

fn time(t: f64) -> Value {
    if t.is_nan() { Value::Null } else { Value::String(iso(t)) }
}

fn opt(v: Option<impl Into<Value>>) -> Value {
    v.map(Into::into).unwrap_or(Value::Null)
}

fn result(r: Result<f64, String>) -> Value {
    match r {
        Ok(t) => json!({ "ok": time(t) }),
        Err(e) => json!({ "error": e }),
    }
}

/// A chat as Bun's object gave it (the canonical keys of `Chat::to_json`).
fn chat_of(v: &Value) -> Chat {
    let b = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Chat {
        text: s("text").unwrap_or_default(),
        mode: s("mode").unwrap_or_default(),
        raw: b("raw"),
        return_to: s("returnTo"),
        quiet: b("quiet"),
        from: v.get("from").map(|f| (f["status"].as_str().unwrap_or("").to_string(), f["outcome"].clone())),
        user: b("user"),
        slash: s("slash"),
        host_wake: b("hostWake"),
        follow_up: b("followUp"),
        nudge: b("nudge"),
    }
}

#[test]
fn chat_rules_like_bun() {
    check("chatModeFor", |c| Value::from(chat_mode_for(c["status"].as_str().unwrap())));
    check("chatFor", |c| chat_for(&obj(&c["ticket"]), &obj(&c["msg"])).to_json());
    check("takesSlot", |c| {
        let chat = (!c["chat"].is_null()).then(|| chat_of(&c["chat"]));
        Value::from(takes_slot(chat.as_ref(), c["noEdit"].as_bool().unwrap()))
    });
    check("reopenable", |c| Value::from(reopenable(c["status"].as_str().unwrap())));
    check("autoHuddleActivity", |c| Value::from(auto_huddle_activity(&c["a"])));
}

#[test]
fn events_like_bun() {
    check("hasText", |c| Value::from(has_text(&c["ev"])));
    check("replayText", |c| opt(replay_text(&c["ev"])));
    check("commandText", |c| opt(command_text(c["text"].as_str().unwrap())));
}

#[test]
fn errors_like_bun() {
    check("sessionMissing", |c| Value::from(session_missing(c["error"].as_str().unwrap(), c["events"].as_array().unwrap())));
    check("claudeSetupHint", |c| opt(claude_setup_hint(c["error"].as_str().unwrap())));
    check("recoveryFor", |c| opt(recovery_for(c["error"].as_str())));
    check("sigChanges", |c| {
        let rows: Vec<(String, String)> = c["rows"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().into(), r["title"].as_str().unwrap().into())).collect();
        json!(sig_changes(c["before"].as_str().unwrap(), c["after"].as_str().unwrap(), &rows))
    });
}

#[test]
fn limits_like_bun() {
    check("parseReset", |c| time(parse_reset(c["text"].as_str().unwrap(), ms(&c["now"]))));
    check("nextFullHour", |c| time(next_full_hour(ms(&c["now"]))));
    check("dayKey", |c| Value::from(day_key(ms(&c["at"]))));
    check("clockTime", |c| Value::from(clock_time(ms(&c["at"]), ms(&c["now"]))));
}

#[test]
fn follow_ups_like_bun() {
    check("parseDelay", |c| opt(parse_delay(c["v"].as_str().unwrap()).map(num)));
    check("parseAt", |c| result(parse_at(&c["v"])));
    check("formatAt", |c| Value::from(format_at(c["at"].as_str().unwrap())));
    check("followUpTime", |c| result(follow_up_time(c["after"].as_str(), c["at"].as_str(), ms(&c["now"]))));
    check("logFollowUp", |c| json!(log_follow_up(c["log"].as_array().unwrap(), c["e"].clone())));
    check("followUpSpend", |c| {
        let (count, cost) = follow_up_spend(c["log"].as_array().unwrap());
        json!({ "count": count, "costUsd": num(cost) })
    });
}

#[test]
fn constants_like_bun() {
    check("constants", |_| {
        json!({
            "THINKING_LINE": rules::THINKING_LINE, "INSTALLING": INSTALLING, "FOLDER_WAIT": FOLDER_WAIT, "STALL_RESTART_TEXT": STALL_RESTART_TEXT,
            "RESTART_MAX_WAIT_MS": RESTART_MAX_WAIT_MS, "DRAFT_THROTTLE_MS": DRAFT_THROTTLE_MS, "ACTIVITY_THROTTLE_MS": ACTIVITY_THROTTLE_MS,
            "ANSWER_REPEAT_MS": ANSWER_REPEAT_MS as u64, "ANSWER_PREFIX": ANSWER_PREFIX, "SESSION_OPEN_MSG": SESSION_OPEN_MSG, "REWINDING": REWINDING,
            "AUTO_FRESH_NOTE": AUTO_FRESH_NOTE, "WORKFLOW_STOPPED_TEXT": WORKFLOW_STOPPED_TEXT, "WORKFLOW_CAP_POLL_MS": WORKFLOW_CAP_POLL_MS,
            "RESTART_HOLD_TEXT": RESTART_HOLD_TEXT, "TELEGRAM_KEEP": TELEGRAM_KEEP,
            "CONTINUE_TEXT": limit::CONTINUE_TEXT, "CONTINUE_DELAY_MS": limit::CONTINUE_DELAY_MS as u64, "AUTO_CONTINUE_PER_DAY": limit::AUTO_CONTINUE_PER_DAY,
            "FOLLOW_UP_MIN_MS": followup::FOLLOW_UP_MIN_MS as u64, "FOLLOW_UP_LATE_MS": followup::FOLLOW_UP_LATE_MS as u64,
            "FOLLOW_UP_NOTE_MAX": followup::FOLLOW_UP_NOTE_MAX, "FOLLOW_UP_REASON_MAX": followup::FOLLOW_UP_REASON_MAX,
            "FOLLOW_UP_MAX_MS": followup::FOLLOW_UP_MAX_MS as u64, "FOLLOW_UP_LOG_KEEP": followup::FOLLOW_UP_LOG_KEEP,
        })
    });
}
