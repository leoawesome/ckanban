//! The R13 gate and cron against Bun's answers (`tests/fixtures/gate.json`, written by
//! `test/rust-board-gate-fixtures.test.ts`): every case's output, as JSON text, must equal Bun's.

use ckanban_board::gate::request::{self, Listener, RemoteConfig, Seen};
use ckanban_board::gate::update::is_newer;
use ckanban_board::schedules::cron;
use serde_json::Value;

fn doc() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/gate.json")).expect("fixture file");
    serde_json::from_str(&text).expect("fixture JSON")
}

fn s(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn case_req(c: &Value) -> (Seen, Option<RemoteConfig>, Listener) {
    let seen = Seen { method: c["method"].as_str().unwrap().to_string(), host: s(&c["host"]), origin: s(&c["origin"]), login: s(&c["login"]) };
    let remote = c["remote"].as_object().map(|r| RemoteConfig {
        enabled: r["enabled"] == Value::Bool(true),
        host: r["host"].as_str().unwrap().to_string(),
        allowed_login: r["allowedLogin"].as_str().unwrap().to_string(),
        updated_at: String::new(),
    });
    let via = if c["via"] == "remote" { Listener::Remote } else { Listener::Local };
    (seen, remote, via)
}

/// Runs `f` on every case of `group` and lists the cases whose answer differs from Bun's.
fn check(group: &str, f: impl Fn(&Value) -> String) {
    let d = doc();
    let cases = d["groups"][group].as_array().unwrap_or_else(|| panic!("group {group}"));
    assert!(!cases.is_empty());
    let bad: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let got = f(c);
            let want = c["expect"].as_str().unwrap();
            (got != want).then(|| format!("{c}\n  rust: {got}\n  bun:  {want}"))
        })
        .collect();
    assert!(bad.is_empty(), "{} of {} {group} cases differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}

fn port() -> u16 {
    doc()["port"].as_u64().unwrap() as u16
}

#[test]
fn refusal_like_bun() {
    let port = port();
    check("refusal", |c| {
        let (seen, remote, via) = case_req(c);
        serde_json::to_string(&request::refusal(&seen, port, remote.as_ref(), via)).unwrap()
    });
}

#[test]
fn socket_like_bun() {
    let port = port();
    check("socket", |c| {
        let (seen, remote, via) = case_req(c);
        serde_json::to_string(&request::socket_allowed(&seen, port, remote.as_ref(), via)).unwrap()
    });
}

/// The fixture's time zone for this process (every cron test sets the same one).
fn tz() {
    let tz = doc()["tz"].as_str().unwrap().to_string();
    // SAFETY: every test in this file that reads local time sets the same value first.
    unsafe { std::env::set_var("TZ", tz) };
}

#[test]
fn cron_error_like_bun() {
    tz();
    check("cronError", |c| serde_json::to_string(&cron::error(c["expr"].as_str().unwrap())).unwrap());
}

#[test]
fn describe_cron_like_bun() {
    check("describeCron", |c| serde_json::to_string(&cron::describe(c["expr"].as_str().unwrap())).unwrap());
}

#[test]
fn next_runs_like_bun() {
    tz();
    check("nextRuns", |c| {
        let after = chrono::DateTime::parse_from_rfc3339(c["after"].as_str().unwrap()).unwrap().timestamp_millis() as f64;
        let parsed = cron::parse(c["expr"].as_str().unwrap()).expect("a valid expression");
        let out: Vec<String> = cron::next_runs(&parsed, after, c["n"].as_u64().unwrap() as usize).into_iter().map(ckanban_core::time::iso).collect();
        serde_json::to_string(&out).unwrap()
    });
}

#[test]
fn is_newer_like_bun() {
    check("isNewer", |c| serde_json::to_string(&is_newer(c["latest"].as_str().unwrap(), c["current"].as_str().unwrap())).unwrap());
}
