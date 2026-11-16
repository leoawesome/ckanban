//! Quick chats' pure text against Bun's answers (`tests/fixtures/quickchat.json`, written by
//! `test/rust-board-quickchat-fixtures.test.ts`): titles, the run note, attachment paths, drafts, "session missing" and
//! the error line, compared as JSON text.

use std::path::Path;

use ckanban_board::quickchat::text::{self, Draft, DraftTracker};
use ckanban_board::runs::js;
use serde_json::{Value, json};

fn answer(group: &str, c: &Value) -> Value {
    let s = |k: &str| c[k].as_str().unwrap_or("").to_string();
    match group {
        "autoTitle" => json!(text::auto_title(c["text"].as_str())),
        "quickChatNote" => json!(text::quick_chat_note(&c["name"], &s("slug"), &c["path"])),
        "localizeAttachments" => json!(text::localize_attachments(&s("prompt"), Path::new("/data/attachments"))),
        "draft" => {
            let mut d = DraftTracker::default();
            let seen: Vec<Value> = c["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| match d.feed(e) {
                    Draft::Same => Value::Null,
                    Draft::Cleared => json!(""),
                    Draft::Changed => json!(d.text),
                })
                .collect();
            json!({ "seen": seen, "text": d.text, "finished": d.finished })
        }
        "sessionMissing" => json!(text::session_missing(&s("error"), c["events"].as_array().unwrap())),
        "errorLine" => json!(text::error_line(&s("error"))),
        g => panic!("unknown group {g}"),
    }
}

#[test]
fn rust_gives_buns_answers() {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/quickchat.json")).unwrap()).unwrap();
    let mut n = 0;
    for (group, cases) in doc["groups"].as_object().unwrap() {
        for c in cases.as_array().unwrap() {
            let got = js::stringify(&answer(group, c));
            assert_eq!(got, c["expect"].as_str().unwrap(), "{group}: {c}");
            n += 1;
        }
    }
    assert!(n > 40);
}
