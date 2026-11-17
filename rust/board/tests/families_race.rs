//! R2b plans and links when two threads change them at once. Bun is single-threaded, so its read-then-write of a
//! plan is one step; in Rust the routes, the hooks and the wake timer run in parallel. Each test makes a second
//! thread act at the worst moment of the first (from inside the first's own calls, so the order is the same on every
//! run) and checks that nothing the second thread wrote is lost.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ckanban_board::api::StandIn;
use ckanban_board::bus::Bus;
use ckanban_board::families::Families;
use ckanban_board::index::Index;
use ckanban_board::index::routes::Reads;
use ckanban_board::index::ticket::Tk;
use ckanban_board::index::view::Live;
use ckanban_board::tickets::writer::Tickets;
use serde_json::{Map, Value, json};

type Hook = Box<dyn Fn(&str, &str) + Send + Sync>;

/// No runs, no sessions; `on_running` is called each time a plan pass asks whether a ticket runs.
#[derive(Default)]
struct TestLive {
    on_running: Mutex<Option<Hook>>,
}

impl Live for TestLive {
    fn running(&self, slug: &str, id: &str) -> bool {
        if let Some(h) = self.on_running.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            h(slug, id);
        }
        false
    }
    fn holds_slot(&self, _: &str, _: &str) -> bool {
        false
    }
    fn board_running(&self, _: &str) -> usize {
        0
    }
    fn session(&self, _: &str) -> Option<Value> {
        None
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
    _project: PathBuf,
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
    Board { _d: d, _project: project, tickets, live, f }
}

/// A ticket with these fields written as they are.
fn ticket(b: &Board, title: &str, fields: Value) -> String {
    let mut m = Map::new();
    m.insert("title".into(), title.into());
    m.insert("body".into(), "".into());
    let id = b.tickets.create("b", m).unwrap().id.clone();
    b.tickets.patch("b", &id, fields.as_object().unwrap().clone()).unwrap();
    id
}

fn plan(b: &Board, id: &str) -> Map<String, Value> {
    b.tickets.get("b", id).unwrap().get("plan").and_then(Value::as_object).cloned().unwrap()
}

/// A main ticket with a running plan, a finished task its plan hasn't seen yet (an event) and a task waiting in
/// Backlog that the pass would move to Ready.
fn family(b: &Board) -> (String, String) {
    let main = ticket(b, "Main", json!({ "main": true, "status": "review" }));
    let plan = json!({ "state": "running", "wakeups": 0, "startedAt": "2026-11-17T00:00:00.000Z", "originalCount": 2, "inbox": [], "seen": {}, "retries": {}, "awaiting": null });
    b.tickets.patch("b", &main, json!({ "plan": plan }).as_object().unwrap().clone()).unwrap();
    ticket(b, "Finished", json!({ "tool": true, "parentId": main, "status": "done", "outcome": "done" }));
    let waiting = ticket(b, "Waiting", json!({ "tool": true, "parentId": main, "status": "backlog", "mode": "auto" }));
    (main, waiting)
}

/// Runs `act` on a second thread the first time the pass looks at the planner (after it read the plan, before it
/// writes), and waits for it at most `wait`: a second thread that has to wait for a lock the first holds is let go.
fn at_planner_read(b: &Board, planner: &str, wait: Duration, act: impl Fn() + Send + Sync + 'static) -> Arc<OnceLock<std::thread::JoinHandle<()>>> {
    let armed = AtomicBool::new(true);
    let planner = planner.to_string();
    let act = Arc::new(act);
    let handle: Arc<OnceLock<std::thread::JoinHandle<()>>> = Arc::default();
    let h2 = handle.clone();
    *b.live.on_running.lock().unwrap() = Some(Box::new(move |_, id| {
        if id != planner || !armed.swap(false, Ordering::SeqCst) {
            return;
        }
        let act = act.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let h = std::thread::spawn(move || {
            act();
            let _ = tx.send(());
        });
        let _ = rx.recv_timeout(wait);
        let _ = h2.set(h);
    }));
    handle
}

#[test]
fn a_pause_during_a_plan_pass_stays_and_no_task_starts() {
    let b = board();
    let (main, waiting) = family(&b);
    let (f, m) = (b.f.clone(), main.clone());
    let second = at_planner_read(&b, &main, Duration::from_secs(5), move || {
        f.pause_plan("b", &m).unwrap();
    });
    let f = b.f.clone();
    std::thread::spawn(move || f.advance_plans("b")).join().unwrap();
    if let Some(h) = Arc::try_unwrap(second).ok().and_then(OnceLock::into_inner) {
        h.join().unwrap();
    }
    let p = plan(&b, &main);
    assert_eq!(p["state"], "paused", "the pass wrote its old copy of the plan over the Pause: {p:?}");
    assert_eq!(b.tickets.get("b", &waiting).unwrap().status, "backlog", "a task started after the plan was paused");
}

#[test]
fn an_event_pushed_during_a_plan_pass_is_kept() {
    let b = board();
    let (main, _) = family(&b);
    let (f, m) = (b.f.clone(), main.clone());
    let second = at_planner_read(&b, &main, Duration::from_secs(5), move || {
        f.push_event("b", &m, "merge failed: t_x \"X\" couldn't merge");
    });
    let f = b.f.clone();
    std::thread::spawn(move || f.advance_plans("b")).join().unwrap();
    if let Some(h) = Arc::try_unwrap(second).ok().and_then(OnceLock::into_inner) {
        h.join().unwrap();
    }
    let p = plan(&b, &main);
    let inbox: Vec<&str> = p["inbox"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(inbox.iter().any(|l| l.starts_with("merge failed")), "the pushed event was lost: {inbox:?}");
    assert!(inbox.iter().any(|l| l.contains("Finished")), "the pass's own event is missing: {inbox:?}");
    // Its result card was added once, though the pass had to go again.
    let results = b.tickets.get("b", &main).unwrap().get("results").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    assert_eq!(results, 1);
}

#[test]
fn mark_done_during_a_plan_pass_stays_done() {
    let b = board();
    let (main, waiting) = family(&b);
    let (f, m) = (b.f.clone(), main.clone());
    let second = at_planner_read(&b, &main, Duration::from_secs(5), move || {
        f.mark_plan_done("b", &m).unwrap();
    });
    let f = b.f.clone();
    std::thread::spawn(move || f.advance_plans("b")).join().unwrap();
    if let Some(h) = Arc::try_unwrap(second).ok().and_then(OnceLock::into_inner) {
        h.join().unwrap();
    }
    assert_eq!(plan(&b, &main)["state"], "done");
    assert_eq!(b.tickets.get("b", &waiting).unwrap().status, "backlog");
}

#[test]
fn a_task_the_user_moved_on_during_a_pass_is_not_moved_back_to_ready() {
    let b = board();
    let (main, waiting) = family(&b);
    let (t, w) = (b.tickets.clone(), waiting.clone());
    let second = at_planner_read(&b, &main, Duration::from_secs(5), move || {
        t.patch("b", &w, json!({ "status": "done", "outcome": "done" }).as_object().unwrap().clone()).unwrap();
    });
    let f = b.f.clone();
    std::thread::spawn(move || f.advance_plans("b")).join().unwrap();
    if let Some(h) = Arc::try_unwrap(second).ok().and_then(OnceLock::into_inner) {
        h.join().unwrap();
    }
    assert_eq!(b.tickets.get("b", &waiting).unwrap().status, "done", "the pass moved a finished task back to Ready");
}

#[test]
fn a_panicking_plan_step_doesnt_stop_the_boards_plans() {
    let b = board();
    let (main, waiting) = family(&b);
    let armed = AtomicBool::new(true);
    let m = main.clone();
    *b.live.on_running.lock().unwrap() = Some(Box::new(move |_, id| {
        if id == m && armed.swap(false, Ordering::SeqCst) {
            panic!("a plan step broke");
        }
    }));
    let f = b.f.clone();
    let first = std::thread::spawn(move || f.advance_plans("b")).join();
    assert!(first.is_ok(), "the panic left the pass");
    // The board isn't left marked as advancing: the next pass moves the plan on.
    b.f.advance_plans("b");
    assert_eq!(b.tickets.get("b", &waiting).unwrap().status, "ready");
}

#[test]
fn two_opposite_links_at_once_make_no_loop() {
    let b = board();
    // a hangs under an old plan link, so linking it first clears that (a write the second link slips in behind).
    let p = ticket(&b, "Planner", json!({}));
    let a = ticket(&b, "A", json!({ "parentId": p }));
    let c = ticket(&b, "C", json!({}));
    let armed = Arc::new(AtomicBool::new(true));
    let second: Arc<Mutex<Option<std::thread::JoinHandle<Result<(), String>>>>> = Arc::default();
    {
        let (f, a, c, armed, second) = (b.f.clone(), a.clone(), c.clone(), armed.clone(), second.clone());
        b.tickets.on_written(move |_, id| {
            if id != a || !armed.swap(false, Ordering::SeqCst) {
                return;
            }
            let (f2, a2, c2) = (f.clone(), a.clone(), c.clone());
            let (tx, rx) = std::sync::mpsc::channel();
            let h = std::thread::spawn(move || {
                let r = f2.set_part_of("b", &c2, Some(&a2), None, true).map(|_| ());
                let _ = tx.send(());
                r
            });
            // With the link lock the second link waits for this one: let it wait and go on.
            let _ = rx.recv_timeout(Duration::from_millis(500));
            *second.lock().unwrap() = Some(h);
        });
    }
    let (f, a1, c1) = (b.f.clone(), a.clone(), c.clone());
    let first = std::thread::spawn(move || f.set_part_of("b", &a1, Some(&c1), None, true).map(|_| ())).join().unwrap();
    let second = second.lock().unwrap().take().expect("the second link ran").join().unwrap();
    let a_in_c = b.tickets.get("b", &a).unwrap().part_of.as_deref() == Some(c.as_str());
    let c_in_a = b.tickets.get("b", &c).unwrap().part_of.as_deref() == Some(a.as_str());
    assert!(!(a_in_c && c_in_a), "both links went through: a partOf loop ({first:?}, {second:?})");
    assert!(first.is_ok() != second.is_ok(), "exactly one link wins: {first:?}, {second:?}");
}
