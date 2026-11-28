//! A stuck main ticket's plan runs again by itself once what made it stuck is gone (a later run of the main ticket
//! ended well, the blocked task was resolved), and stays stuck while anything still waits on the user.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use ckanban_board::api::StandIn;
use ckanban_board::bus::Bus;
use ckanban_board::families::Families;
use ckanban_board::index::Index;
use ckanban_board::index::attention::{STUCK_ON_QUESTIONS, ticket_attention};
use ckanban_board::index::routes::Reads;
use ckanban_board::index::ticket::Tk;
use ckanban_board::index::view::Live;
use ckanban_board::tickets::writer::Tickets;
use serde_json::{Map, Value, json};

/// No runs; `session` answers every session id with the summary set here.
#[derive(Default)]
struct TestLive {
    session: Mutex<Option<Value>>,
}

impl Live for TestLive {
    fn running(&self, _: &str, _: &str) -> bool {
        false
    }
    fn holds_slot(&self, _: &str, _: &str) -> bool {
        false
    }
    fn board_running(&self, _: &str) -> usize {
        0
    }
    fn session(&self, _: &str) -> Option<Value> {
        self.session.lock().unwrap().clone()
    }
    fn host(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn devices(&self, _: &str, _: &str) -> Value {
        json!([])
    }
    fn share_jobs(&self, _: &str, _: &str) -> Vec<Value> {
        Vec::new()
    }
    fn terminal_open(&self, _: &str, _: &str) -> bool {
        false
    }
    fn folder_wait(&self, _: &str, _: &Tk) -> bool {
        false
    }
    fn cost(&self, _: &str, _: &str) -> f64 {
        0.0
    }
    fn huddle_spend(&self, _: &str, _: &str) -> f64 {
        0.0
    }
    fn teammate_artifacts(&self, _: &str, _: &str) -> Vec<(String, Vec<Value>)> {
        Vec::new()
    }
}

struct Board {
    _d: tempfile::TempDir,
    tickets: Arc<Tickets>,
    live: Arc<TestLive>,
    f: Arc<Families>,
}

fn board() -> Board {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("data");
    let project = d.path().join("project");
    std::fs::create_dir_all(root.join("profiles/b/tickets")).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    let profile = json!({ "name": "B", "slug": "b", "path": project, "createdAt": "2026-11-01T00:00:00.000Z" });
    std::fs::write(root.join("profiles/b/profile.json"), profile.to_string()).unwrap();
    let index = Index::new(&root);
    let live = Arc::new(TestLive::default());
    let reads = Arc::new(Reads::new(index.clone(), live.clone()));
    let tickets = Tickets::new(index, Arc::new(Bus::new()), Arc::new(StandIn), Arc::new(|s: &str| s.to_string()));
    let f = Families::new(tickets.clone(), reads);
    Board { _d: d, tickets, live, f }
}

fn obj(v: Value) -> Map<String, Value> {
    v.as_object().unwrap().clone()
}

fn ticket(b: &Board, title: &str, fields: Value) -> String {
    let mut m = Map::new();
    m.insert("title".into(), title.into());
    m.insert("body".into(), "".into());
    let id = b.tickets.create("b", m).unwrap().id.clone();
    b.tickets.patch("b", &id, obj(fields)).unwrap();
    id
}

/// A main ticket with a stuck plan for `reason`; its tasks' plan events are all seen already.
fn stuck_main(b: &Board, reason: &str, main_fields: Value) -> String {
    let main = ticket(b, "Main", json!({ "main": true, "status": "review", "sessionId": "s1" }));
    b.tickets.patch("b", &main, obj(main_fields)).unwrap();
    let plan = json!({ "state": "stuck", "reason": reason, "wakeups": 3, "startedAt": "2026-11-17T00:00:00.000Z", "originalCount": 2, "inbox": [], "seen": {}, "retries": {}, "awaiting": null });
    b.tickets.patch("b", &main, obj(json!({ "plan": plan }))).unwrap();
    main
}

/// The plan has seen every task's current result, so a pass makes no new event of them.
fn mark_seen(b: &Board, main: &str, kids: &[&str]) {
    let t = b.tickets.get("b", main).unwrap();
    let mut plan = t.get("plan").and_then(Value::as_object).cloned().unwrap();
    let mut seen = Map::new();
    for k in kids {
        let k = b.tickets.get("b", k).unwrap();
        let tpl = |v: Option<&Value>| match v {
            None => "undefined".to_string(),
            Some(Value::Null) => "null".into(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        };
        seen.insert(k.id.clone(), format!("{}:{}:{}", tpl(k.get("runCount")), tpl(k.get("outcome")), k.s("prUrl").unwrap_or("")).into());
    }
    plan.insert("seen".into(), Value::Object(seen));
    b.tickets.patch("b", main, obj(json!({ "plan": plan }))).unwrap();
}

fn state(b: &Board, id: &str) -> String {
    b.tickets.get("b", id).unwrap().plan_state().unwrap_or("").to_string()
}

fn label(b: &Board, id: &str) -> Option<String> {
    let list = b.tickets.list("b");
    let t = b.tickets.get("b", id).unwrap();
    ticket_attention(&list, &t, None, false, None, &|_| false, &HashSet::new).map(|a| a.label)
}

#[test]
fn a_follow_up_run_of_the_main_that_ends_done_unsticks_its_plan() {
    let b = board();
    let main = stuck_main(&b, STUCK_ON_QUESTIONS, json!({ "outcome": "done", "runCount": 3 }));
    // A task still at work keeps the plan running (not closed as done) after it unsticks.
    let k = ticket(&b, "Working", json!({ "tool": true, "parentId": main, "status": "in_progress" }));
    mark_seen(&b, &main, &[&k]);
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "running");
    let p = b.tickets.get("b", &main).unwrap().get("plan").cloned().unwrap();
    assert!(p["reason"].is_null(), "{p:?}");
    assert_ne!(label(&b, &main).as_deref(), Some("Plan stuck"));
}

#[test]
fn a_main_that_still_asks_stays_stuck() {
    let b = board();
    let main = stuck_main(&b, STUCK_ON_QUESTIONS, json!({ "outcome": "needs_input", "runCount": 2 }));
    let k = ticket(&b, "Working", json!({ "tool": true, "parentId": main, "status": "in_progress" }));
    mark_seen(&b, &main, &[&k]);
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "stuck");
    // Its run ended well, but its chat still has an open questions form.
    b.tickets.patch("b", &main, obj(json!({ "outcome": "done" }))).unwrap();
    *b.live.session.lock().unwrap() = Some(json!({ "openQuestions": 1, "openFormId": "f1" }));
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "stuck");
    // The form closed: nothing waits on the user any more.
    b.tickets.patch("b", &main, obj(json!({ "runEndedAt": "2026-11-20T00:00:00.000Z", "closedForms": { "f1": { "at": "2026-11-21T00:00:00.000Z", "by": "user", "run": "2026-11-20T00:00:00.000Z" } } }))).unwrap();
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "running");
}

#[test]
fn a_blocked_task_moved_to_done_unsticks_the_plan() {
    let b = board();
    let reason = "nothing can run; not done yet: \"Blocked\" (review, blocked)";
    let main = stuck_main(&b, reason, json!({ "outcome": "done" }));
    let blocked = ticket(&b, "Blocked", json!({ "tool": true, "parentId": main, "status": "review", "outcome": "blocked", "runCount": 1 }));
    let next = ticket(&b, "Next", json!({ "tool": true, "parentId": main, "status": "backlog", "mode": "auto", "dependsOn": [blocked.clone()] }));
    mark_seen(&b, &main, &[&blocked, &next]);
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "stuck", "the reason still holds");
    assert!(label(&b, &main).is_some(), "the card still asks for the user");
    b.tickets.patch("b", &blocked, obj(json!({ "status": "done" }))).unwrap();
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "running");
    assert_ne!(label(&b, &main).as_deref(), Some("Plan stuck"));
    assert_eq!(b.tickets.get("b", &next).unwrap().status, "ready", "the task after it starts");
}

#[test]
fn a_blocked_task_moved_to_done_while_another_task_asks_stays_stuck() {
    let b = board();
    let reason = "nothing can run; not done yet: \"Blocked\" (review, blocked), \"Asks\" (review, needs_input)";
    let main = stuck_main(&b, reason, json!({ "outcome": "done" }));
    let blocked = ticket(&b, "Blocked", json!({ "tool": true, "parentId": main, "status": "review", "outcome": "blocked", "runCount": 1 }));
    let asks = ticket(&b, "Asks", json!({ "tool": true, "parentId": main, "status": "review", "outcome": "needs_input", "runCount": 1 }));
    let next = ticket(&b, "Next", json!({ "tool": true, "parentId": main, "status": "backlog", "mode": "auto", "dependsOn": [blocked.clone()] }));
    mark_seen(&b, &main, &[&blocked, &asks, &next]);
    b.tickets.patch("b", &blocked, obj(json!({ "status": "done" }))).unwrap();
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "stuck");
    // Deleting the asking task clears the last thing waiting on the user.
    b.tickets.delete("b", &asks).unwrap();
    b.f.advance_plans("b");
    assert_eq!(state(&b, &main), "running");
}
