//! The session markers against Bun's answers in `tests/fixtures/sessions/markers.json` (filled by
//! `test/rust-board-markers-fixtures.test.ts`). Each `expect` is `{ "value": ... }`, `{}` when Bun's answer is
//! undefined. Answers are compared as JSON text, so key order and number spelling count too.

use ckanban_board::sessions::{cards, markers, text};
use serde_json::{Map, Value, json};

fn opt<T: Into<Value>>(v: Option<T>) -> Value {
    v.map(Into::into).unwrap_or(Value::Null)
}

fn s(input: &Value) -> &str {
    input.as_str().expect("a string input")
}

fn user_text(u: markers::UserText) -> Value {
    let mut o = Map::new();
    o.insert("kind".into(), u.kind.into());
    o.insert("text".into(), u.text.into());
    for (k, v) in [("huddle", u.huddle), ("wake", u.wake), ("command", u.command)] {
        if let Some(v) = v {
            o.insert(k.into(), v.into());
        }
    }
    if let Some(setup) = u.setup {
        o.insert("setup".into(), setup);
    }
    Value::Object(o)
}

/// The Rust answer for one case: Some(value), or None where Bun's is undefined.
fn run(f: &str, input: Option<&Value>) -> Option<Value> {
    let i = input.unwrap_or(&Value::Null);
    Some(match f {
        "commandText" => opt(text::command_text(s(i))),
        "localCommandOutput" => opt(text::local_command_output(s(i))),
        "withoutAttachmentNote" => text::without_attachment_note(s(i)).into(),
        "parseSetupBlock" => opt(text::parse_setup_block(s(i))),
        "parseResult" => opt(text::parse_result(s(i))),
        "starredTitle" => {
            let (title, important) = text::starred_title(s(i));
            json!({ "title": title, "important": important })
        }
        "mockupName" => opt(text::mockup_name(s(i))),
        "stripMockups" => {
            let (t, names) = text::strip_mockups(s(i));
            json!({ "text": t, "names": names })
        }
        "terminalOnly" => markers::terminal_only(i.as_str()).into(),
        "parseTeammateProposal" => opt(cards::parse_teammate_proposal(i)),
        "parseSquadProposal" => opt(cards::parse_squad_proposal(i)),
        "parseAutomationProposal" => opt(cards::parse_automation_proposal(i)),
        "parseKeysAsk" => opt(cards::parse_keys_ask(i)),
        "rosterError" => opt(cards::roster_error(i, cards::DEFAULT_MAX_PARTICIPANTS)),
        "proposedBudget" => return cards::proposed_budget(input),
        "helperLineText" => cards::helper_line_text(input).into(),
        "suggestedLineError" => opt(cards::suggested_line_error(s(i))),
        "parseAskMeta" => return markers::parse_ask_meta(i).map(Value::Object),
        "parseQuestions" => opt(markers::parse_questions(i)),
        "parseProposal" => opt(markers::parse_proposal(i)),
        "assistantBlock" => Value::Object(markers::assistant_block(s(i))),
        "dropBlockedMoves" => {
            let mut entries = i.as_array().expect("entries").clone();
            markers::drop_blocked_moves(&mut entries);
            entries.into()
        }
        "published" => markers::published(s(i)).into_iter().map(|(p, u)| json!([p, u])).collect::<Vec<_>>().into(),
        "isSetupHelper" => markers::is_setup_helper(s(i)).into(),
        "isPublisher" => markers::is_publisher(i).into(),
        "fromTicket" => opt(markers::from_ticket(s(i)).map(|(id, title, t)| json!({ "ticketId": id, "title": title, "text": t }))),
        "fromAutomation" => opt(markers::from_automation(s(i)).map(|(name, t)| json!({ "name": name, "text": t }))),
        "userText" => opt(markers::user_text(i).map(user_text)),
        "resultText" => markers::result_text(i).into(),
        "cardEntry" => opt(markers::card_entry(i).map(Value::Object)),
        other => panic!("no function {other}"),
    })
}

#[test]
fn markers_match_bun() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sessions/markers.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("fixture JSON");
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() >= 80);
    let mut failed = Vec::new();
    for (n, c) in cases.iter().enumerate() {
        let f = c["fn"].as_str().expect("fn");
        let got = run(f, c.get("input"));
        let mut wrapped = Map::new();
        if let Some(v) = got {
            wrapped.insert("value".into(), v);
        }
        let got = serde_json::to_string(&Value::Object(wrapped)).unwrap();
        let want = serde_json::to_string(&c["expect"]).unwrap();
        if got != want {
            failed.push(format!("case {n} {f}({})\n  want {want}\n  got  {got}", c.get("input").map(Value::to_string).unwrap_or_default()));
        }
    }
    assert!(failed.is_empty(), "{} of {} cases differ:\n{}", failed.len(), cases.len(), failed.join("\n"));
}
