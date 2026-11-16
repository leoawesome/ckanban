//! The R6 port gives Bun's answers (tests/fixtures/git.json, written by `test/rust-git-fixtures.test.ts`): diff
//! parsing, PR status, merge blocks and messages, a ticket's PR list, slugs, download headers, markdown titles, setup
//! blocks, setup detection's profile fields and the file name order. Compared as JSON text, so key order counts.

use std::collections::HashMap;

use ckanban_board::git::{diff, files, landing, pr, setup, share};
use serde_json::Value;

fn fixtures() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/git.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn same(case: &str, got: &Value, want: &Value) {
    assert_eq!(serde_json::to_string(got).unwrap(), serde_json::to_string(want).unwrap(), "{case}");
}

fn arr<'a>(f: &'a Value, k: &str) -> &'a Vec<Value> {
    f[k].as_array().unwrap()
}

#[test]
fn parse_diff() {
    for c in arr(&fixtures(), "parseDiff") {
        let got: Vec<Value> = diff::parse_diff(c["in"].as_str().unwrap()).iter().map(diff::DiffFile::to_json).collect();
        same(c["in"].as_str().unwrap(), &Value::Array(got), &c["out"]);
    }
}

#[test]
fn pr_status_blocks_and_messages() {
    let f = fixtures();
    for c in arr(&f, "parsePrStatus") {
        let got = pr::parse_pr_status(c["url"].as_str().unwrap(), &c["raw"], c["now"].as_str().unwrap());
        same(&c["raw"].to_string(), &got, &c["out"]);
        same(&c["raw"].to_string(), &Value::from(pr::merge_block(Some(&got))), &c["mergeBlock"]);
    }
    same("null", &Value::from(pr::merge_block(None)), &f["mergeBlockNull"]);
    for c in arr(&f, "failureMessage") {
        let logs: Vec<pr::CheckLog> = arr(c, "logs")
            .iter()
            .map(|l| pr::CheckLog { name: l["name"].as_str().unwrap().into(), log: l["log"].as_str().map(str::to_string), url: l["url"].as_str().map(str::to_string) })
            .collect();
        assert_eq!(pr::failure_message(&c["pr"], &logs), c["out"].as_str().unwrap());
    }
    for c in arr(&f, "conflictMessage") {
        assert_eq!(pr::conflict_message(&c["pr"], c["base"].as_str().unwrap()), c["out"].as_str().unwrap());
    }
    for c in arr(&f, "tail") {
        assert_eq!(pr::tail(c["log"].as_str().unwrap(), c["max"].as_u64().unwrap() as usize), c["out"].as_str().unwrap());
    }
}

#[test]
fn ticket_prs() {
    for c in arr(&fixtures(), "prs") {
        let t = &c["ticket"];
        same(&t.to_string(), &Value::Array(pr::ticket_prs(t)), &c["ticketPrs"]);
        same(&t.to_string(), &Value::Object(pr::add_prs(t, &["b".into(), "c".into(), "c".into()])), &c["addPrs"]);
        let seen = HashMap::from([
            ("b".to_string(), pr::Seen { state: "CLOSED".into(), base: Some("dev".into()) }),
            ("u1".to_string(), pr::Seen { state: "MERGED".into(), base: None }),
        ]);
        same(&t.to_string(), &Value::Object(pr::update_prs(t, &seen)), &c["updatePrs"]);
    }
}

#[test]
fn names_titles_and_slugs() {
    let f = fixtures();
    for c in arr(&f, "attachmentHeader") {
        assert_eq!(share::attachment_header(c["name"].as_str().unwrap()), c["out"].as_str().unwrap());
    }
    for c in arr(&f, "markdownTitle") {
        assert_eq!(share::markdown_title(c["md"].as_str().unwrap(), c["file"].as_str().unwrap()), c["out"].as_str().unwrap());
    }
    for c in arr(&f, "slugify") {
        assert_eq!(landing::slugify(c["title"].as_str().unwrap()), c["out"].as_str().unwrap(), "{}", c["title"]);
    }
    for c in arr(&f, "localeSort") {
        let mut names: Vec<&str> = arr(c, "names").iter().map(|v| v.as_str().unwrap()).collect();
        names.sort_by(|a, b| files::locale_cmp(a, b));
        let want: Vec<&str> = arr(c, "out").iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(names, want);
    }
}

#[test]
fn setup_text_and_detection() {
    let f = fixtures();
    for c in arr(&f, "tailLines") {
        assert_eq!(setup::tail_lines(c["text"].as_str().unwrap(), c["n"].as_u64().unwrap() as usize), c["out"].as_str().unwrap());
    }
    for c in arr(&f, "setupBlock") {
        assert_eq!(setup::setup_block(&c["result"]), c["block"].as_str().unwrap());
        let wrapped = format!("before\n{}\nafter", c["block"].as_str().unwrap());
        same("parseSetupBlock", &setup::parse_setup_block(&wrapped).unwrap(), &c["parsed"]);
    }
    for c in arr(&f, "withBoardText") {
        let got = setup::with_board_text(c["prompt"].as_str().unwrap(), c["text"].as_str().unwrap(), c["note"].as_str().unwrap());
        assert_eq!(got, c["out"].as_str().unwrap());
    }
    for c in arr(&f, "applyDetection") {
        same("applyDetection", &setup::apply_detection(&c["profile"], &c["detected"], c["overwrite"].as_bool().unwrap()), &c["out"]);
    }
}
