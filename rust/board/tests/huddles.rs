//! R11a: huddle rooms through their routes on a temp data folder (no runs: the stand-in runner). The contract tests
//! (`test/contract/huddle*.test.ts`) check the same against Bun; these cover what they can't reach without helper runs:
//! a hand-in accepted and in conflict, the guard against file edits, the board's own summary, Done closing a huddle.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use ckanban_board::api::StandIn;
use ckanban_board::bus::Bus;
use ckanban_board::huddles::Huddles;
use ckanban_board::huddles::copies;
use ckanban_board::huddles::routes::{Req, answer};
use ckanban_board::index::Index;
use ckanban_board::team::Team;
use ckanban_board::tickets::writer::Tickets;
use serde_json::{Map, Value, json};

struct Board {
    _d: tempfile::TempDir,
    root: std::path::PathBuf,
    project: std::path::PathBuf,
    tickets: Arc<Tickets>,
    hs: Arc<Huddles>,
}

fn board() -> Board {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("data");
    let project = d.path().join("project");
    fs::create_dir_all(root.join("profiles/b/tickets")).unwrap();
    fs::create_dir_all(&project).unwrap();
    let profile = json!({ "name": "B", "slug": "b", "path": project, "createdAt": "2026-11-01T00:00:00.000Z" });
    fs::write(root.join("profiles/b/profile.json"), profile.to_string()).unwrap();
    let tickets = Tickets::new(Index::new(&root), Arc::new(Bus::new()), Arc::new(StandIn), Arc::new(|s: &str| s.to_string()));
    let team = Arc::new(Team::new(&root));
    let hs = Huddles::new(&root, team.clone());
    hs.attach(tickets.clone(), Arc::new(StandIn));
    team.set_learning_cards(hs.clone());
    Board { _d: d, root, project, tickets, hs }
}

fn ticket(b: &Board, title: &str) -> String {
    let mut m = Map::new();
    m.insert("title".into(), title.into());
    m.insert("body".into(), "Host.".into());
    b.tickets.create("b", m).unwrap().id.clone()
}

fn call(b: &Board, method: &str, path: &str, body: Value, run: Option<&str>, agent: Option<&str>) -> (u16, Value) {
    let parts: Vec<String> = format!("profiles/b/huddles{path}").split('/').filter(|x| !x.is_empty()).map(str::to_string).collect();
    let (path_only, query) = match path.split_once('?') {
        Some((_, q)) => (parts.clone(), q.to_string()),
        None => (parts.clone(), String::new()),
    };
    let path_only: Vec<String> = path_only.into_iter().map(|p| p.split('?').next().unwrap().to_string()).collect();
    let body = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
    let r = Req { method, parts: &path_only, query: &query, run: run.map(str::to_string), agent: agent.map(str::to_string), source: None, body: &body };
    answer(&b.hs, &r)
}

fn on_disk(b: &Board, hid: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(b.root.join(format!("profiles/b/huddles/{hid}.json"))).unwrap()).unwrap()
}

fn messages(b: &Board, hid: &str) -> Vec<Value> {
    fs::read_to_string(b.root.join(format!("profiles/b/huddles/{hid}.messages.jsonl"))).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn token(b: &Board, hid: &str, handle: &str) -> String {
    on_disk(b, hid)["participants"].as_array().unwrap().iter().find(|p| p["handle"] == handle).unwrap()["token"].as_str().unwrap().to_string()
}

#[test]
fn start_post_findings_and_close_with_the_boards_summary() {
    let b = board();
    let t = ticket(&b, "Roster host");
    assert_eq!(call(&b, "POST", "", json!({}), None, None).0, 400);
    assert_eq!(call(&b, "POST", "", json!({ "ticketId": t }), Some(&format!("b/{t}")), None).0, 403);
    assert_eq!(call(&b, "POST", "", json!({ "ticketId": "t_missing", "roster": [{ "preset": "reviewer" }] }), None, None).0, 404);
    let (st, h) = call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "preset": "reviewer" }], "topic": "Login" }), None, None);
    assert_eq!(st, 201, "{h}");
    let hid = h["id"].as_str().unwrap().to_string();
    assert!(!h.to_string().contains("token"));
    assert_eq!(h["participants"].as_array().unwrap().iter().map(|p| p["handle"].as_str().unwrap()).collect::<Vec<_>>(), ["you", "main", "reviewer"]);
    assert_eq!(h["brief"]["text"], "Topic: Login");
    let file = fs::read_to_string(b.root.join(format!("profiles/b/huddles/{hid}.json"))).unwrap();
    assert!(file.ends_with("}\n") && file.contains("\n  \"id\": "));
    assert!(messages(&b, &hid)[0]["text"].as_str().unwrap().starts_with(&format!("Huddle started on ticket {t} \"Roster host\" with @reviewer (")));
    assert_eq!(call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "preset": "reviewer" }] }), None, None).0, 409);

    // The user posts; a helper proves who it is; the host's run is @main.
    let (st, m) = call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "hello @reviewer" }), None, None);
    assert_eq!(st, 201);
    assert_eq!(m["mentions"], json!(["reviewer"]));
    let agent = format!("{hid}/reviewer/{}", token(&b, &hid, "reviewer"));
    let run = format!("b/{t}");
    let (_, m) = call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "@main fine", "kind": "finding" }), Some(&run), Some(&agent));
    assert_eq!((m["from"].as_str(), m["kind"].as_str()), (Some("reviewer"), Some("finding")));
    assert_eq!(call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "x" }), None, Some(&format!("{hid}/reviewer/bad"))).0, 403);
    assert_eq!(call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "noted" }), Some(&run), None).1["from"], "main");
    assert_eq!(call(&b, "GET", "/current", Value::Null, Some(&run), Some(&agent)).1["you"], "reviewer");
    // Nothing runs, so @main's wake waits: its cursor stays before the finding.
    let main = on_disk(&b, &hid)["participants"][1].clone();
    assert!(main["cursor"].as_f64().unwrap() < 3.0);

    let (st, f) = call(&b, "POST", &format!("/{hid}/findings"), json!({ "action": "add", "text": "Hidden on phones" }), None, None);
    assert_eq!(st, 200);
    assert_eq!(f[0]["id"], "f1");
    assert_eq!(call(&b, "POST", &format!("/{hid}/findings"), json!({ "action": "add" }), Some(&run), Some(&agent)).0, 403);
    assert_eq!(call(&b, "POST", &format!("/{hid}/findings"), json!({ "action": "resolve", "id": "f1" }), None, None).1[0]["resolvedBy"], "you");

    // The host-state "needs you" view.
    call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "@you look" }), Some(&run), None);
    let states = b.hs.host_states("b");
    assert_eq!(states[&t]["tagged"], 1);
    assert_eq!(states[&t]["helpers"], 1);

    let (st, closed) = call(&b, "POST", &format!("/{hid}/close"), json!({}), None, None);
    assert_eq!(st, 200);
    assert_eq!(closed["status"], "closed");
    assert_eq!(closed["summary"], format!("huddles/{hid}/summary.md"));
    let summary = fs::read_to_string(b.root.join(format!("profiles/b/tickets/{t}/outputs/huddles/{hid}/summary.md"))).unwrap();
    assert!(summary.starts_with("# Huddle summary\n"));
    assert!(summary.contains("- [x] Hidden on phones (pinned by @you, resolved by @you)"));
    assert_eq!(call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "late" }), None, None).0, 409);
    assert_eq!(call(&b, "GET", "?open=1", Value::Null, None, None).1, json!([]));
}

#[test]
fn a_file_edit_from_outside_cant_raise_rights() {
    let b = board();
    let t = ticket(&b, "Guarded");
    let hid = call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "preset": "reviewer" }] }), None, None).1["id"].as_str().unwrap().to_string();
    let file = b.root.join(format!("profiles/b/huddles/{hid}.json"));
    let mut h = on_disk(&b, &hid);
    h["participants"][2]["lead"] = json!(true);
    h["maxCostUsd"] = json!(500);
    h["status"] = json!("closed");
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(&file, serde_json::to_string_pretty(&h).unwrap()).unwrap();
    let (_, v) = call(&b, "GET", &format!("/{hid}"), Value::Null, None, None);
    assert_eq!(v["huddle"]["participants"][2]["lead"], false);
    assert_eq!(v["huddle"]["maxCostUsd"], 20);
    assert_eq!(v["huddle"]["status"], "live");
    // The note comes after the read that found it, with the next change.
    call(&b, "POST", &format!("/{hid}/messages"), json!({ "text": "hi" }), None, None);
    assert!(messages(&b, &hid).iter().any(|m| m["text"].as_str().unwrap().starts_with("Huddle file edited outside the board.")));
}

#[test]
fn hand_ins_are_accepted_into_the_folder_or_conflict() {
    let b = board();
    let t = ticket(&b, "Hand-in host");
    let (_, h) = call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "role": "Fixer", "prompt": "Fix.", "canEdit": true, "handle": "fixer" }] }), None, None);
    let hid = h["id"].as_str().unwrap().to_string();
    let agent = format!("{hid}/fixer/{}", token(&b, &hid, "fixer"));
    let run = format!("b/{t}");
    assert_eq!(call(&b, "POST", &format!("/{hid}/hand-ins"), json!({ "summary": "x" }), Some(&run), Some(&agent)).0, 409);
    // The copy R11c would make: a plain copy with its base.
    let copy = b.root.join("copies/fixer");
    fs::create_dir_all(&copy).unwrap();
    fs::write(b.project.join("same.txt"), "same").unwrap();
    fs::write(copy.join("same.txt"), "same").unwrap();
    let c = copy.to_string_lossy().to_string();
    copies::write_state(&c, &copies::CopyState { base: copies::scan(&copy, "folder").unwrap(), handed: None }).unwrap();
    let mut hj = on_disk(&b, &hid);
    hj["participants"][2]["copy"] = json!({ "dir": c, "kind": "folder" });
    fs::write(b.root.join(format!("profiles/b/huddles/{hid}.json")), serde_json::to_string_pretty(&hj).unwrap()).unwrap();
    // The guard keeps the board's own copy field: a copy set by a file edit doesn't count.
    assert_eq!(call(&b, "POST", &format!("/{hid}/hand-ins"), json!({ "summary": "x" }), Some(&run), Some(&agent)).0, 409);
    b.hs.op(|hs| hs.update_p("b", &hid, "fixer", ckanban_board::huddles::service::obj([("copy", json!({ "dir": c, "kind": "folder" }))]))).unwrap();
    fs::write(copy.join("new.txt"), "new\n").unwrap();
    let (st, c1) = call(&b, "POST", &format!("/{hid}/hand-ins"), json!({ "summary": "Added new.txt" }), Some(&run), Some(&agent));
    assert_eq!(st, 201, "{c1}");
    assert_eq!(c1["files"][0]["change"], "added");
    assert_eq!(call(&b, "POST", &format!("/{hid}/hand-ins/c1/accept"), json!({}), Some(&run), Some(&agent)).0, 403);
    let (st, ok) = call(&b, "POST", &format!("/{hid}/hand-ins/c1/accept"), json!({}), None, None);
    assert_eq!(st, 200, "{ok}");
    assert_eq!(ok["status"], "accepted");
    assert_eq!(fs::read_to_string(b.project.join("new.txt")).unwrap(), "new\n");
    // The host's folder changed the same file: a conflict, nothing written.
    fs::write(copy.join("same.txt"), "mine").unwrap();
    fs::write(b.project.join("same.txt"), "theirs").unwrap();
    call(&b, "POST", &format!("/{hid}/hand-ins"), json!({ "summary": "Changed same.txt" }), Some(&run), Some(&agent));
    let (_, c2) = call(&b, "POST", &format!("/{hid}/hand-ins/c2/accept"), json!({}), None, None);
    assert_eq!(c2["status"], "conflict");
    assert_eq!(c2["conflicts"], json!(["same.txt"]));
    assert_eq!(fs::read_to_string(b.project.join("same.txt")).unwrap(), "theirs");
    assert!(messages(&b, &hid).last().unwrap()["text"].as_str().unwrap().contains("weren't brought in"));
}

#[test]
fn learnings_wait_for_the_user_and_save_as_teammates() {
    let b = board();
    let t = ticket(&b, "Learning host");
    let hid = call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "preset": "reviewer" }] }), None, None).1["id"].as_str().unwrap().to_string();
    let agent = format!("{hid}/reviewer/{}", token(&b, &hid, "reviewer"));
    let run = format!("b/{t}");
    let p = json!({ "name": "Phone Walker", "role": "Phone walker", "prompt": "Walk it.", "why": "Nobody checks." });
    assert_eq!(call(&b, "POST", &format!("/{hid}/teammates"), p.clone(), None, None).0, 400);
    let (st, l1) = call(&b, "POST", &format!("/{hid}/teammates"), p, Some(&run), Some(&agent));
    assert_eq!(st, 201, "{l1}");
    assert_eq!((l1["id"].as_str(), l1["status"].as_str()), (Some("l1"), Some("pending")));
    assert_eq!(call(&b, "GET", &format!("/{hid}"), Value::Null, None, None).1["huddle"]["learningsPending"], 1);
    assert_eq!(call(&b, "PATCH", &format!("/{hid}/learnings/l1"), json!({ "scope": "repo" }), None, None).1["scope"], "repo");
    let (st, saved) = call(&b, "POST", &format!("/{hid}/learnings/l1/save"), Value::Null, None, None);
    assert_eq!(st, 200, "{saved}");
    assert_eq!(saved["target"], "phone-walker");
    let presets: Value = serde_json::from_str(&fs::read_to_string(b.root.join("profiles/b/huddle-presets.json")).unwrap()).unwrap();
    assert_eq!(presets[0]["name"], "phone-walker");
    assert_eq!(call(&b, "POST", &format!("/{hid}/learnings/l1/save"), Value::Null, None, None).0, 409);
}

#[test]
fn status_mode_participants_invite_and_seen() {
    let b = board();
    let t = ticket(&b, "Room host");
    let other = ticket(&b, "Api side");
    let hid = call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "preset": "reviewer" }], "maxParticipants": 4 }), None, None).1["id"].as_str().unwrap().to_string();
    let agent = format!("{hid}/reviewer/{}", token(&b, &hid, "reviewer"));
    let run = format!("b/{t}");
    let (st, p) = call(&b, "POST", &format!("/{hid}/status"), json!({ "status": "blocked", "reason": "needs the API" }), Some(&run), Some(&agent));
    assert_eq!(st, 200);
    assert!(p.get("token").is_none());
    assert_eq!(messages(&b, &hid).last().unwrap()["mentions"], json!(["main"]));
    let (st, added) = call(&b, "POST", &format!("/{hid}/participants"), json!({ "preset": "qa", "focus": "the form" }), None, None);
    assert_eq!(st, 201);
    assert_eq!(added["added"][0]["mode"], "monitor");
    assert_eq!(call(&b, "POST", &format!("/{hid}/participants"), json!({ "preset": "security", "count": 2 }), None, None).0, 409);
    assert_eq!(call(&b, "POST", &format!("/{hid}/participants/qa/restart"), json!({}), None, None).0, 409);
    assert_eq!(call(&b, "POST", &format!("/{hid}/participants/qa/stop"), json!({}), None, None).0, 200);
    let (st, inv) = call(&b, "POST", &format!("/{hid}/invite"), json!({ "ticketId": other }), None, None);
    assert_eq!(st, 201);
    assert_eq!(inv["handle"], "api-main");
    let (st, seen) = call(&b, "POST", &format!("/{hid}/seen"), json!({ "seq": 1e9 }), None, None);
    assert_eq!(st, 200);
    assert_eq!(seen["forYou"], 0);
    assert_eq!(call(&b, "POST", &format!("/{hid}/seen"), json!({ "seq": "x" }), None, None).0, 400);
    let early = call(&b, "POST", &format!("/{hid}/close-request"), json!({ "reason": "done" }), Some(&run), None);
    assert_eq!(early.0, 409);
}

#[test]
fn closed_when_the_host_is_deleted() {
    let b = board();
    let t = ticket(&b, "Gone");
    let hid = call(&b, "POST", "", json!({ "ticketId": t, "roster": [{ "preset": "reviewer" }] }), None, None).1["id"].as_str().unwrap().to_string();
    b.hs.op(|hs| hs.close_for_ticket("b", &t, ckanban_board::huddles::model::DELETED));
    assert_eq!(on_disk(&b, &hid)["status"], "closed");
    assert!(!Path::new(&b.root.join(format!("profiles/b/tickets/{t}/outputs/huddles/{hid}/summary.md"))).exists());
}
