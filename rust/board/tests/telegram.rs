//! Telegram's pure text rules against Bun's answers (`tests/fixtures/telegram.json`, written by
//! `test/rust-board-telegram-fixtures.test.ts`), in the time zone the file names.

use ckanban_board::telegram::text;
use serde_json::{Value, json};

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn answer(fun: &str, a: &[Value]) -> Value {
    match fun {
        "scrub" => json!(text::scrub(&s(&a[0]), &s(&a[1]))),
        "maskToken" => json!(text::mask_token(&s(&a[0]))),
        "telegramText" => json!(text::telegram_text(&s(&a[0]), &s(&a[1]))),
        "isLock" => json!(text::is_lock(Some(&a[0]))),
        "forwardedFrom" => json!(text::forwarded_from(&a[0])),
        "reportParts" => json!(text::report_parts(&s(&a[0]), &s(&a[1]), f(&a[2]) as usize, f(&a[3]) as usize, a[4].as_str())),
        "cutTail" => json!(text::cut_tail(a[0].as_str())),
        "rowsOf" => json!(text::rows_of(a[0].as_array().unwrap())),
        "questionText" => json!(text::question_text(&a[0], f(&a[1]) as usize, &s(&a[2]))),
        "formMessage" => json!(text::form_message(&a[0])),
        "heldKind" => match text::held_kind(&s(&a[0]), &s(&a[1]), &a[2]) {
            Some(h) => json!({ "kind": h.kind, "slug": h.slug, "ticketId": h.ticket_id }),
            None => Value::Null,
        },
        "dayTitle" => json!(text::day_title(f(&a[0]))),
        "dayEnded" => json!(text::day_ended(f(&a[0]), f(&a[1]), &s(&a[2]["end"]))),
        "deskPaused" => json!(text::desk_paused(f(&a[0]))),
        "briefing" => json!(text::briefing(a[0].as_bool().unwrap())),
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn bun_fixtures() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/telegram.json")).unwrap();
    let doc: Value = serde_json::from_str(&text).unwrap();
    // SAFETY: set before any other thread reads the environment (this test file has one test).
    unsafe { std::env::set_var("TZ", doc["tz"].as_str().unwrap()) };
    let mut bad = Vec::new();
    for (i, c) in doc["cases"].as_array().unwrap().iter().enumerate() {
        let fun = c["fn"].as_str().unwrap();
        let want: Value = serde_json::from_str(c["expect"].as_str().unwrap()).unwrap();
        let got = answer(fun, c["args"].as_array().unwrap());
        if got != want {
            bad.push(format!("#{i} {fun}({}): got {got}, want {want}", c["args"]));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ:\n{}", bad.len(), doc["cases"].as_array().unwrap().len(), bad.join("\n"));
}
