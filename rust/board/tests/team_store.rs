//! R11b: the team's files and routes over a temp data folder: what the contract tests can't reach in board mode yet
//! (the squads test needs R2a's ticket writes first), plus the cards that wait for R2a and R11a.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use ckanban_board::team::routes::{self, Call};
use ckanban_board::team::{Fail, LearningCards, Team, TicketCards};
use serde_json::{Value, json};

fn board(root: &Path, slug: &str) {
    let dir = root.join("profiles").join(slug);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("profile.json"), r#"{"name":"B","slug":"b","path":"/tmp/x","createdAt":"2026-11-01T00:00:00.000Z"}"#).unwrap();
}

fn call(team: &Team, method: &str, path: &str, body: Value, from_run: bool) -> (u16, Value) {
    let parts: Vec<String> = path.split('/').filter(|p| !p.is_empty()).map(String::from).collect();
    assert!(routes::claims(method, &parts), "{method} {path} is a team route");
    let text = if body.is_null() { String::new() } else { body.to_string() };
    let a = routes::answer(team, &Call { method, parts: &parts, scope: None, from_run, body: text.as_bytes() });
    (a.status, a.value)
}

fn read(p: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn squads_make_teammates_refuse_a_taken_name_and_wait_for_their_cards() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    board(root, "b");
    let team = Team::new(root);
    let squad = json!({ "name": "walk-squad", "roster": [{ "handle": "walker", "role": "Walker", "prompt": "Walk." }] });

    let (s, v) = call(&team, "POST", "profiles/b/squads", json!({ "squad": squad, "scope": "board" }), false);
    assert_eq!(s, 201, "{v}");
    assert_eq!(v["teammates"], json!({ "created": ["walker"], "reused": [] }));
    assert_eq!(v["squad"]["roster"], json!([{ "handle": "walker", "preset": "walker" }]));
    assert_eq!(v["squad"]["source"], "board");
    let presets = fs::read_to_string(root.join("profiles/b/huddle-presets.json")).unwrap();
    assert_eq!(
        presets,
        "[\n  {\n    \"name\": \"walker\",\n    \"role\": \"Walker\",\n    \"prompt\": \"Walk.\",\n    \"model\": null,\n    \"mode\": \"tagged\",\n    \"workspace\": \"shared\",\n    \"lead\": false,\n    \"canEdit\": false\n  }\n]\n"
    );
    assert!(read(&root.join("profiles/b/huddle-templates.json"))[0]["name"] == "walk-squad");

    let (s, v) = call(&team, "POST", "profiles/b/squads", json!({ "squad": squad }), false);
    assert_eq!(s, 409);
    assert!(v["error"].as_str().unwrap().starts_with("a squad named \"walk-squad\" already exists (Walk squad)"));
    let (s, v) = call(&team, "POST", "profiles/b/squads", json!({ "squad": { "name": "walk-squad", "description": "v2", "roster": squad["roster"] }, "replace": true }), false);
    assert_eq!(s, 201);
    assert_eq!(v["teammates"], json!({ "created": [], "reused": ["walker"] }));
    assert_eq!(v["squad"]["description"], "v2");

    assert_eq!(call(&team, "POST", "profiles/b/squads", json!({ "squad": squad, "card": { "nope": 1 } }), false).0, 400);
    assert_eq!(call(&team, "POST", "profiles/b/squads", json!({ "squad": squad, "card": [] }), false).0, 400);
    assert_eq!(call(&team, "POST", "profiles/b/squads", json!({ "squad": squad, "replace": true, "card": { "ticketId": "t_missing", "uuid": "u1" } }), false).0, 404);
    let (s, v) = call(&team, "POST", "profiles/b/squads", json!({ "squad": squad }), true);
    assert_eq!(s, 403);
    assert!(v["error"].as_str().unwrap().starts_with("a board or huddle run can't save squads"));
    assert_eq!(call(&team, "POST", "profiles/nope/squads", json!({ "squad": squad }), false), (404, json!({ "error": "board nope not found" })));
    assert_eq!(call(&team, "POST", "profiles/b/squads", json!({ "squad": squad, "scope": "everywhere" }), false).0, 400);

    // A ticket's card waits for R2a, a huddle's for R11a: refused before anything is written.
    let tdir = root.join("profiles/b/tickets/t_20261101_ab12");
    fs::create_dir_all(&tdir).unwrap();
    fs::write(tdir.join("ticket.md"), "---\nid: t_20261101_ab12\n---\n").unwrap();
    let before = fs::read_to_string(root.join("profiles/b/huddle-templates.json")).unwrap();
    let carded = json!({ "squad": { "name": "other", "roster": [{ "role": "Talker" }] }, "card": { "ticketId": "t_20261101_ab12", "uuid": "tu_9" } });
    let (s, v) = call(&team, "POST", "profiles/b/squads", carded.clone(), false);
    assert_eq!(s, 503, "{v}");
    let learn = json!({ "squad": squad, "replace": true, "card": { "huddleId": "h_x", "learningId": "l1" } });
    assert_eq!(call(&team, "POST", "profiles/b/squads", learn.clone(), false).0, 503);
    assert_eq!(fs::read_to_string(root.join("profiles/b/huddle-templates.json")).unwrap(), before);
    assert!(!read(&root.join("profiles/b/huddle-presets.json")).to_string().contains("talker"));

    // With them in, the cards are marked saved.
    #[derive(Default)]
    struct Cards(Mutex<Vec<Value>>);
    impl TicketCards for Cards {
        fn exists(&self, _: &str, id: &str) -> bool {
            id == "t_20261101_ab12"
        }
        fn mark_saved(&self, slug: &str, id: &str, uuid: &str, state: Value) -> Result<(), String> {
            self.0.lock().unwrap().push(json!([slug, id, uuid, state]));
            Ok(())
        }
    }
    impl LearningCards for Cards {
        fn check(&self, _: &str, _: &str, lid: &str) -> Result<(), Fail> {
            if lid == "l1" { Ok(()) } else { Err(Fail::new(404, format!("no learning {lid} in huddle h_x"))) }
        }
        fn mark_saved(&self, slug: &str, hid: &str, lid: &str, target: &str, scope: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(json!([slug, hid, lid, target, scope]));
            Ok(())
        }
    }
    let cards = Arc::new(Cards::default());
    team.set_ticket_cards(cards.clone());
    team.set_learning_cards(cards.clone());
    let (s, v) = call(&team, "POST", "profiles/b/squads", carded, false);
    assert_eq!(s, 201, "{v}");
    let (s, _) = call(&team, "POST", "profiles/b/squads", learn, false);
    assert_eq!(s, 201);
    let mut nope = json!({ "squad": squad, "replace": true, "card": { "huddleId": "h_x", "learningId": "l9" } });
    assert_eq!(call(&team, "POST", "profiles/b/squads", nope.take(), false).0, 404);
    let seen = cards.0.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0][3]["state"], "saved");
    assert_eq!(seen[0][3]["name"], "other");
    assert_eq!(seen[0][3]["scope"], "board");
    assert_eq!(seen[0][3]["teammates"], json!({ "created": ["talker"], "reused": [] }));
    assert!(seen[0][3]["at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(seen[1], json!(["b", "h_x", "l1", "walk-squad", "repo"]));
}

#[test]
fn teammates_move_between_levels_and_reset() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    board(root, "b");
    let team = Team::new(root);
    let (s, v) = call(&team, "POST", "profiles/b/huddle-presets", json!({ "name": "Walker", "prompt": "Walk." }), false);
    assert_eq!((s, v["source"].clone()), (201, json!("board")));
    let (s, v) = call(&team, "PUT", "profiles/b/huddle-presets/walker", json!({ "prompt": "Again.", "scope": "global" }), false);
    assert_eq!((s, v["source"].clone(), v["prompt"].clone()), (200, json!("global"), json!("Again.")));
    assert_eq!(read(&root.join("profiles/b/huddle-presets.json")), json!([]));
    assert_eq!(read(&root.join("huddle-presets.json"))[0]["name"], "walker");
    // Deleting goes to the level in effect (global here).
    let (s, v) = call(&team, "DELETE", "profiles/b/huddle-presets/walker", Value::Null, false);
    assert_eq!((s, v["reset"].clone()), (200, json!(false)));
    assert_eq!(read(&root.join("huddle-presets.json")), json!([]));
    assert_eq!(call(&team, "DELETE", "profiles/b/huddle-presets/walker", Value::Null, false).0, 404);
    assert_eq!(call(&team, "DELETE", "profiles/b/huddle-presets/reviewer", Value::Null, false).0, 409);
    // A name that says "built-in" is a 409 too, as in Bun.
    assert_eq!(call(&team, "DELETE", "profiles/b/huddle-presets/built-in", Value::Null, false).0, 409);
    let (_, v) = call(&team, "PUT", "profiles/b/huddle-presets/reviewer", json!({ "prompt": "Mine." }), false);
    assert_eq!((v["source"].clone(), v["base"].clone()), (json!("board"), json!("builtin")));
    let (_, v) = call(&team, "DELETE", "profiles/b/huddle-presets/reviewer", Value::Null, false);
    assert_eq!(v["reset"], true);
    // The body is required where Bun reads one; other methods and lengths are 404.
    assert_eq!(call(&team, "POST", "profiles/b/huddle-presets", Value::Null, false), (400, json!({ "error": "invalid JSON body" })));
    assert_eq!(call(&team, "GET", "profiles/b/huddle-presets/x", Value::Null, false).0, 404);
    assert_eq!(call(&team, "GET", "profiles/b/huddle-presets/x", Value::Null, true).0, 403);
    assert_eq!(call(&team, "PATCH", "profiles/b/huddle-templates/x", json!({}), false).0, 404);
    // A damaged file reads as empty, like Bun's readList.
    fs::write(root.join("profiles/b/huddle-templates.json"), "{oops").unwrap();
    let (s, v) = call(&team, "GET", "profiles/b/huddle-templates", Value::Null, false);
    assert_eq!(s, 200);
    assert!(v.as_array().unwrap().iter().all(|t| t["source"] == "builtin"));
}

#[test]
fn role_notes_are_markdown_files_by_scope() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    board(root, "b");
    let team = Team::new(root);
    let (s, v) = call(&team, "PUT", "profiles/b/huddle-notes/reviewer/general", json!({ "notes": [{ "text": "Read the tests first." }] }), false);
    assert_eq!((s, v), (200, json!([{ "text": "Read the tests first.", "by": "you", "date": null, "huddle": null }])));
    assert_eq!(
        fs::read_to_string(root.join("huddle-notes/reviewer.md")).unwrap(),
        "# Huddle notes: role reviewer, all repos\n<!-- Newest first. The first 30 lines go into new agents' instructions. -->\n\n- Read the tests first. <!-- by you -->\n"
    );
    call(&team, "PUT", "profiles/b/huddle-notes/_all/repo", json!({ "notes": [{ "text": "No git here." }] }), false);
    // Files that aren't a role's are left out; index-like names come first, as in a JS object.
    fs::write(root.join("huddle-notes/Bad Name.md"), "- x\n").unwrap();
    fs::write(root.join("huddle-notes/123.md"), "- y\n").unwrap();
    let parts: Vec<String> = ["profiles", "b", "huddle-notes"].map(String::from).to_vec();
    let a = routes::answer(&team, &Call { method: "GET", parts: &parts, scope: None, from_run: false, body: b"" });
    let text = ckanban_core::datafile::to_text(&a.value, ckanban_core::datafile::Layout::Compact);
    assert!(text.starts_with(r#"{"notes":{"123":{"general":[{"text":"y""#), "{text}");
    assert!(text.contains(r#""_all":{"general":[],"repo":[{"text":"No git here.""#));
    assert!(!text.contains("Bad Name"));
    assert!(text.ends_with(r#""cap":30}"#));
    assert_eq!(call(&team, "PUT", "profiles/b/huddle-notes/reviewer/everywhere", json!({ "notes": [] }), false).0, 400);
    assert_eq!(call(&team, "PUT", "profiles/b/huddle-notes/Bad Role!/general", json!({ "notes": [] }), false).0, 400);
    assert_eq!(call(&team, "PUT", "profiles/b/huddle-notes/reviewer/general", json!({ "x": 1 }), false), (400, json!({ "error": "notes must be a list" })));
    assert_eq!(call(&team, "PUT", "profiles/b/huddle-notes/reviewer/general", json!({ "notes": [] }), true).0, 403);
    // A board name can't walk out of profiles/.
    assert_eq!(call(&team, "GET", "profiles/../huddle-notes", Value::Null, false).0, 404);
}
