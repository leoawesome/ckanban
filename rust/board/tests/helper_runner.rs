//! The Rust helper runner against Bun's, step by step (`tests/fixtures/helper_runner.json`, written by
//! `test/rust-board-helper-runner-fixtures.test.ts`): the same scenarios on the same clock, fake channels and fake
//! helper answers, and after each step the same files byte for byte (message and feedback ids numbered).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ckanban_board::bus::Bus;
use ckanban_board::helper::board::{Facts, HelperBoard};
use ckanban_board::helper::channels::Sender;
use ckanban_board::helper::runner::SideFn;
use ckanban_board::helper::waits::NewWait;
use ckanban_board::helper::{Helper, notify_settings};
use ckanban_board::index::store::BoardList;
use ckanban_board::index::ticket::Tk;
use ckanban_board::runs::js;
use ckanban_board::runs::side_call::SideCallResult;
use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

const BASE: &str = "http://localhost:4000";

struct FakeBoard {
    profiles: Vec<(String, String)>,
    lists: HashMap<String, Arc<BoardList>>,
}

impl HelperBoard for FakeBoard {
    fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        self.lists.get(slug).and_then(|l| l.get(id).cloned())
    }
    fn list(&self, slug: &str) -> Arc<BoardList> {
        self.lists.get(slug).cloned().unwrap_or_else(|| Arc::new(BoardList::new(slug, vec![], 0)))
    }
    fn profiles(&self) -> Vec<(String, String)> {
        self.profiles.clone()
    }
    fn has_profile(&self, slug: &str) -> bool {
        self.profiles.iter().any(|(s, _)| s == slug)
    }
    fn board_name(&self, slug: &str) -> String {
        self.profiles.iter().find(|(s, _)| s == slug).map(|(_, n)| n.clone()).unwrap_or_else(|| slug.to_string())
    }
    fn session(&self, _: &str) -> Option<Value> {
        None
    }
    fn running(&self, _: &str, _: &str) -> bool {
        false
    }
    fn host(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn schedule_ids(&self, _: &str) -> HashSet<String> {
        HashSet::new()
    }
    fn has_checkin(&self, _: &str) -> bool {
        false
    }
    fn add_comment(&self, _: &str, _: &str, _: &str) {}
    fn base_url(&self) -> String {
        BASE.into()
    }
}

struct FakeSender {
    results: Arc<Mutex<Map<String, Value>>>,
}

impl Sender for FakeSender {
    fn send(&self, _: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let results = self.results.lock().clone();
        Box::pin(async move {
            Ok(targets
                .iter()
                .map(|c| {
                    let r = results.get(c).cloned().unwrap_or(json!({ "ok": true }));
                    let ok = r["ok"].as_bool().unwrap_or(false);
                    let mut m = Map::new();
                    m.insert("channel".into(), c.clone().into());
                    m.insert("ok".into(), ok.into());
                    let err = r.get("error").cloned().filter(|e| !e.is_null()).unwrap_or(if ok { Value::Null } else { Value::String(format!("{c} failed")) });
                    m.insert("error".into(), err);
                    if let Some(d) = r.get("devices") {
                        m.insert("devices".into(), d.clone());
                    }
                    Value::Object(m)
                })
                .collect())
        })
    }
    fn facts(&self) -> BoxFuture<'static, Facts> {
        Box::pin(async { Facts::default() })
    }
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn new_wait(v: &Value) -> NewWait {
    NewWait {
        board: s(&v["board"]),
        ticket_id: s(&v["ticketId"]),
        kind: s(&v["kind"]),
        identity: s(&v["identity"]),
        question: s(&v["question"]),
        label: s(&v["label"]),
        since: s(&v["since"]),
        urgent: v["urgent"].as_bool().unwrap_or(false),
        why: v.get("why").and_then(Value::as_str).map(str::to_string),
    }
}

/// `named`: message and feedback ids numbered by first sight.
fn named(text: &str, ids: &mut Vec<(String, String)>) -> String {
    let re = regex::Regex::new(r"\b([mf])_[a-z0-9]{6,}\b").unwrap();
    let mut out = String::new();
    let mut last = 0;
    for c in re.captures_iter(text) {
        let m = c.get(0).unwrap();
        out.push_str(&text[last..m.start()]);
        let real = m.as_str().to_string();
        let name = match ids.iter().find(|(r, _)| *r == real) {
            Some((_, n)) => n.clone(),
            None => {
                let k = &c[1];
                let n = format!("{k}_{}", ids.iter().filter(|(r, _)| r.starts_with(k)).count() + 1);
                ids.push((real, n.clone()));
                n
            }
        };
        out.push_str(&name);
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

fn read(p: &std::path::Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

async fn run(sc: &Value, n: usize) -> Vec<String> {
    let dir = std::env::temp_dir().join(format!("helper-run-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let start = ckanban_core::time::parse_date(&s(&sc["start"])).unwrap();
    let clock = Arc::new(AtomicU64::new(start as u64));
    let c = clock.clone();
    let now: Arc<dyn Fn() -> f64 + Send + Sync> = Arc::new(move || c.load(Ordering::SeqCst) as f64);
    let results = Arc::new(Mutex::new(sc.get("channels").and_then(Value::as_object).cloned().unwrap_or_default()));
    let mut lists = HashMap::new();
    for (slug, tickets) in sc["board"]["tickets"].as_object().unwrap() {
        let tks: Vec<Arc<Tk>> = tickets.as_array().unwrap().iter().map(|t| Arc::new(Tk::from_json(t.as_object().unwrap().clone(), false))).collect();
        lists.insert(slug.clone(), Arc::new(BoardList::new(slug, tks, 0)));
    }
    let profiles: Vec<(String, String)> = sc["board"]["profiles"].as_array().unwrap().iter().map(|p| (s(&p["slug"]), s(&p["name"]))).collect();
    let board = Arc::new(FakeBoard { profiles, lists });
    let replies: Arc<Mutex<Vec<SideCallResult>>> = Arc::new(Mutex::new(Vec::new()));
    let r = replies.clone();
    let side: SideFn = Arc::new(move |_| {
        let next = {
            let mut q = r.lock();
            if q.is_empty() { SideCallResult::Err { error: "no reply".into(), cost_usd: None } } else { q.remove(0) }
        };
        Box::pin(async move { next })
    });
    let mut helper: Option<Arc<Helper>> = None;
    let mut ids: Vec<(String, String)> = Vec::new();
    let mut out = Vec::new();
    for st in sc["steps"].as_array().unwrap() {
        let msg_id = |k: u64, ids: &Vec<(String, String)>| ids.iter().find(|(_, n)| *n == format!("m_{k}")).map(|(r, _)| r.clone()).unwrap_or_default();
        let h = helper.clone();
        let said: Value = match s(&st["op"]).as_str() {
            "notify" => {
                notify_settings::write_notify(&dir, &notify_settings::normalize_from_file(&st["settings"]).unwrap()).unwrap();
                Value::Null
            }
            "start" => {
                helper = Some(Helper::with_clock(&dir, board.clone(), Arc::new(FakeSender { results: results.clone() }), side.clone(), Arc::new(Bus::new()), None, now.clone()));
                Value::Null
            }
            "advance" => {
                clock.fetch_add(st["ms"].as_u64().unwrap(), Ordering::SeqCst);
                Value::Null
            }
            "route" => {
                let rec = h.unwrap().core.route(new_wait(&st["wait"])).await;
                rec.get("key").cloned().unwrap_or(Value::Null)
            }
            "reconcile" => {
                let w = st.get("wait").map(new_wait);
                h.unwrap().core.reconcile(&s(&st["board"]), &s(&st["ticketId"]), w.as_ref(), w.as_ref().map(|w| w.identity.as_str()), &[], false);
                Value::Null
            }
            "started" => {
                h.unwrap().core.started();
                Value::Null
            }
            "settled" => {
                h.unwrap().core.settled(&s(&st["board"]), &s(&st["ticketId"]), st["identity"].as_str(), &[]);
                Value::Null
            }
            "opened" => {
                h.unwrap().core.opened(&s(&st["board"]), &s(&st["ticketId"]));
                Value::Null
            }
            "deleted" => {
                h.unwrap().core.deleted(&s(&st["board"]), st["ticketId"].as_str());
                Value::Null
            }
            "reply" => {
                let mut q = replies.lock();
                for r in st["replies"].as_array().unwrap() {
                    q.push(match r.get("fail") {
                        Some(f) => SideCallResult::Err { error: s(f), cost_usd: r["costUsd"].as_f64() },
                        None => SideCallResult::Ok {
                            text: r["text"].as_str().map(str::to_string).unwrap_or_else(|| js::stringify(&r["decision"])),
                            cost_usd: r["costUsd"].as_f64().unwrap_or(0.01),
                            model: "claude-sonnet".into(),
                        },
                    });
                }
                Value::Null
            }
            "wake" => h.unwrap().runner.wake().await.and_then(|e| e.get("ok").cloned()).unwrap_or(Value::Null),
            "tick" => {
                h.unwrap().runner.tick().await;
                Value::Null
            }
            "coreTick" => {
                h.unwrap().core.tick().await;
                Value::Null
            }
            "switched" => {
                h.unwrap().core.switched(st["on"].as_bool().unwrap()).await;
                Value::Null
            }
            "channels" => {
                *results.lock() = st["results"].as_object().cloned().unwrap_or_default();
                Value::Null
            }
            "gotIt" => h.unwrap().runner.got_it(&msg_id(st["m"].as_u64().unwrap(), &ids), st["key"].as_str()).unwrap_or_else(|e| json!({ "error": e.1 })),
            "notUrgent" => h.unwrap().runner.not_urgent(&msg_id(st["m"].as_u64().unwrap(), &ids), st["key"].as_str()).unwrap_or_else(|e| json!({ "error": e.1 })),
            "night" => json!({ "text": h.unwrap().runner.night_answer(&msg_id(st["m"].as_u64().unwrap(), &ids), st["allow"].as_bool().unwrap()).unwrap() }),
            "practice" => h.unwrap().runner.practice().await.unwrap(),
            "helperSettings" => h.unwrap().runner.settings.update(&st["raw"]).unwrap().to_json(),
            "feedback" => {
                let h = h.unwrap();
                let line = h.runner.settings.add_feedback(st.get("text"), "user").unwrap();
                h.runner.feedback_added();
                line
            }
            "pinged" => h.unwrap().runner.should_have_pinged(&s(&st["board"]), &s(&st["ticketId"])).unwrap(),
            "status" => h.unwrap().runner.status().await,
            "awake" => h.unwrap().runner.wants_awake().into(),
            "waiting" => h.unwrap().core.waiting_text().into(),
            "dueAt" => h.unwrap().runner.due_at().map(ckanban_core::jsnum::num).unwrap_or(Value::Null),
            other => panic!("unknown op {other}"),
        };
        let mut snap = Map::new();
        snap.insert("said".into(), said);
        snap.insert("waits".into(), read(&dir.join("waits.json")).into());
        snap.insert("messages".into(), read(&dir.join("messages.json")).into());
        snap.insert("state".into(), read(&dir.join("helper-state.json")).into());
        snap.insert("helper".into(), read(&dir.join("helper.json")).into());
        snap.insert("spend".into(), read(&dir.join("helper-spend.jsonl")).into());
        out.push(named(&js::stringify(&Value::Object(snap)), &mut ids));
    }
    let _ = std::fs::remove_dir_all(&dir);
    out
}

/// The first place two texts differ, with some text around it.
fn around(a: &str, b: &str) -> String {
    let i = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let ca: Vec<char> = a.chars().collect();
    let cb: Vec<char> = b.chars().collect();
    let from = i.saturating_sub(250);
    format!("bun:  …{}\nrust: …{}", ca[from..(i + 120).min(ca.len())].iter().collect::<String>(), cb[from..(i + 120).min(cb.len())].iter().collect::<String>())
}

#[tokio::test(flavor = "multi_thread")]
async fn runner_writes_what_bun_writes() {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/helper_runner.json")).unwrap();
    let doc: Value = serde_json::from_str(&text).unwrap();
    // SAFETY: set before any local time is read; this binary's only test.
    unsafe { std::env::set_var("TZ", doc["tz"].as_str().unwrap()) };
    let mut failed = Vec::new();
    for (n, sc) in doc["scenarios"].as_array().unwrap().iter().enumerate() {
        let got = run(sc, n).await;
        for (k, want) in sc["expect"].as_array().unwrap().iter().enumerate() {
            let want = want.as_str().unwrap();
            if got.get(k).map(String::as_str) != Some(want) {
                failed.push(format!("{} step {k} ({}):\n{}", s(&sc["name"]), s(&sc["steps"][k]["op"]), around(want, got.get(k).map(String::as_str).unwrap_or(""))));
                break;
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n\n"));
}
