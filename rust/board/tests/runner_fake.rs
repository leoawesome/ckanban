//! `start_run` against the fake Claude (`test/fixtures/fake-claude.ts`, run by Bun), the same cases as
//! `src/runs/runner.test.ts` plus the watchdog, `stop_task`, side calls and the result and retry readers on real
//! output. Never the real `claude`: every run gets the fake as its command and a temp `CLAUDE_CONFIG_DIR`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use ckanban_board::runs::runner::{self, BuildArgs, RunHandle, RunOptions};
use ckanban_board::runs::{activity, result, retry, side_call};
use parking_lot::Mutex;
use serde_json::Value;

fn fake() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/fake-claude.ts").canonicalize().expect("fake claude").to_string_lossy().into_owned()
}

/// PATH with Bun's folder first (the fake's `#!/usr/bin/env bun`); None when Bun isn't installed (tests skip).
fn path_with_bun() -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let dirs = path.split(':').map(PathBuf::from).chain([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    let home_bun = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".bun/bin"));
    let dir = dirs.chain(home_bun).find(|d| d.join("bun").is_file())?;
    Some(format!("{}:{path}", dir.display()))
}

struct Env {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    env: Vec<(String, String)>,
}

/// A temp folder to run in and the fake's settings; None (skip) without Bun.
fn env(vars: &[(&str, &str)]) -> Option<Env> {
    let Some(path) = path_with_bun() else {
        eprintln!("skipped: bun not found");
        return None;
    };
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("work");
    std::fs::create_dir_all(&cwd).unwrap();
    let mut env = vec![("PATH".to_string(), path), ("CLAUDE_CONFIG_DIR".to_string(), dir.path().join("claude").to_string_lossy().into_owned())];
    env.extend(vars.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    Some(Env { _dir: dir, cwd, env })
}

fn opts(e: &Env, args: Vec<String>, on_event: runner::OnEvent) -> RunOptions {
    let mut o = RunOptions::new(fake(), &e.cwd, args, on_event);
    o.env = e.env.iter().cloned().collect();
    o
}

fn stream_args() -> Vec<String> {
    runner::build_args(&BuildArgs { session_id: "u1".into(), ..Default::default() })
}

fn ty(e: &Value) -> &str {
    e.get("type").and_then(Value::as_str).unwrap_or("")
}

fn results(events: &[Value]) -> Vec<String> {
    events.iter().filter(|e| ty(e) == "result").map(|e| e["result"].as_str().unwrap_or("").to_string()).collect()
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let t0 = Instant::now();
    while !f() {
        assert!(t0.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn ok_run_collects_events_and_skips_non_json_lines() {
    let Some(e) = env(&[("FAKE_MODE", "ok")]) else { return };
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let s = seen.clone();
    let h = runner::start_run(opts(&e, vec!["-p".into(), "x".into()], Box::new(move |ev| s.lock().push(ev.clone()))));
    let r = h.wait().await;
    assert_eq!(r.code, 0, "{}", r.stderr);
    assert_eq!(r.events.iter().map(ty).collect::<Vec<_>>(), ["system", "assistant", "assistant", "result"]);
    assert_eq!(seen.lock().iter().filter(|e| ty(e) != "stream_event").count(), 4);
    assert_eq!(r.events[1]["message"]["content"][0]["name"], "Edit");
    // The result line and the card's line come out as Bun reads them.
    let res = result::parse_result(&activity::extract_final_text(&r.events)).expect("a result line");
    assert_eq!((res.status.as_str(), res.summary.as_str()), ("done", "fake done"));
    assert_eq!(activity::summarize_event(&r.events[1], false).as_deref(), Some("Editing app.ts"));
}

#[tokio::test]
async fn fail_run_returns_code_and_stderr_tail() {
    let Some(e) = env(&[("FAKE_MODE", "fail")]) else { return };
    let r = runner::start_run(opts(&e, vec![], Box::new(|_| {}))).wait().await;
    assert_eq!(r.code, 1);
    assert!(r.stderr.contains("boom"), "{}", r.stderr);
}

#[tokio::test]
async fn missing_binary_resolves_with_an_error() {
    let Some(e) = env(&[]) else { return };
    let mut o = opts(&e, vec![], Box::new(|_| {}));
    o.bin = "/nonexistent/claude".into();
    let r = runner::start_run(o).wait().await;
    assert_ne!(r.code, 0);
    assert!(!r.stderr.is_empty());
}

#[tokio::test]
async fn stop_terminates_a_slow_run() {
    let Some(e) = env(&[("FAKE_MODE", "slow")]) else { return };
    let h = runner::start_run(opts(&e, vec![], Box::new(|_| {})));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let t0 = Instant::now();
    h.stop();
    let r = h.wait().await;
    assert!(t0.elapsed() < Duration::from_secs(15));
    assert_ne!(r.code, 0);
    assert!(h.stopped());
}

#[tokio::test]
async fn stop_kills_the_whole_process_group() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("child.pid");
    let pf = pid_file.to_string_lossy().into_owned();
    let Some(e) = env(&[("FAKE_MODE", "child"), ("FAKE_CHILD_PID_FILE", &pf)]) else { return };
    let h = runner::start_run(opts(&e, vec![], Box::new(|_| {})));
    until("the child's pid", || std::fs::read_to_string(&pid_file).is_ok_and(|s| !s.is_empty())).await;
    let child: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    assert!(child > 0);
    h.stop();
    h.wait().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_ne!(unsafe { libc::kill(child, 0) }, 0, "the grandchild survived");
}

#[tokio::test]
async fn messages_sent_mid_run_reach_claude_at_its_next_step_in_order() {
    let Some(e) = env(&[("FAKE_STEP_MS", "150")]) else { return };
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("do it".into());
    let h = runner::start_run(o);
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Bun's handle has no stdin until Claude is spawned; Bun spawning is quick, so wait for it here.
    until("input open", || h.pid().is_some()).await;
    assert!(h.send("also A", false));
    assert!(h.send("also B", false));
    let r = h.wait().await;
    assert_eq!(r.code, 0, "{}", r.stderr);
    let replays: Vec<&str> = r.events.iter().filter(|e| ty(e) == "user" && e["isReplay"] == true).map(|e| e["message"]["content"][0]["text"].as_str().unwrap()).collect();
    assert_eq!(replays, ["do it", "also A", "also B"]);
    let res = results(&r.events);
    assert_eq!(res.len(), 1);
    assert!(res[0].contains("Steered: also A | also B"), "{}", res[0]);
    assert!(!h.send("too late", false));
}

#[tokio::test]
async fn a_message_that_lands_after_claudes_result_gets_its_own_turn() {
    let Some(e) = env(&[]) else { return };
    let cell: Arc<OnceLock<RunHandle>> = Arc::default();
    let sent = Arc::new(Mutex::new(false));
    let (c, s) = (cell.clone(), sent.clone());
    let mut o = opts(
        &e,
        stream_args(),
        // Sent while the final message is being written, i.e. just before the result line.
        Box::new(move |ev| {
            if ty(ev) == "assistant" && ev["message"]["content"][0]["type"] == "text" && !*s.lock() {
                *s.lock() = c.get().is_some_and(|h| h.send("one more thing", false));
            }
        }),
    );
    o.input = Some("do it".into());
    let h = runner::start_run(o);
    let _ = cell.set(h.clone());
    let r = h.wait().await;
    assert!(*sent.lock());
    assert_eq!(r.code, 0);
    let res = results(&r.events);
    assert_eq!(res.len(), 2);
    assert!(res[1].contains("Reply: one more thing"));
}

#[tokio::test]
async fn permission_asks_are_answered_for_the_run_kind() {
    let Some(e) = env(&[("FAKE_MODE", "asks")]) else { return };
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let s = seen.clone();
    let mut o = opts(&e, stream_args(), Box::new(move |ev| s.lock().push(ev.clone())));
    o.input = Some("open example.com".into());
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.code, 0);
    assert!(results(&r.events).last().unwrap().contains("Asks: mcp__claude-in-chrome__navigate=allow Bash=deny other=error mcp__ckanban__move_ticket=deny"));
    assert!(!seen.lock().iter().any(|e| ty(e) == "control_request"));
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("move t_1 to done".into());
    o.planning = true;
    let p = runner::start_run(o).wait().await;
    assert!(results(&p.events).last().unwrap().contains("Bash=deny other=error mcp__ckanban__move_ticket=allow"));
}

#[tokio::test]
async fn a_background_task_keeps_the_run_open_until_claude_picks_its_result_up() {
    let Some(e) = env(&[("FAKE_MODE", "background")]) else { return };
    let waits: Arc<Mutex<Vec<Option<Vec<String>>>>> = Arc::default();
    let w = waits.clone();
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("scan the logs".into());
    o.on_waiting = Some(Box::new(move |t| w.lock().push(t.map(|t| t.iter().map(|x| x.description.clone()).collect()))));
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.code, 0);
    let res = results(&r.events);
    assert_eq!(res.len(), 2);
    assert!(res[1].contains("Background result: completed"));
    assert!(!r.events.iter().any(|e| e["subtype"] == "task_notification" && e["status"] == "killed"));
    assert_eq!(*waits.lock(), vec![Some(vec!["Count timeouts".to_string()]), None]);
}

#[tokio::test]
async fn input_still_ends_if_claude_starts_no_turn_after_its_last_background_task() {
    let Some(e) = env(&[("FAKE_MODE", "bgsilent")]) else { return };
    let t0 = Instant::now();
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("scan".into());
    o.grace_ms = Some(200);
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.code, 0);
    assert_eq!(results(&r.events).len(), 1);
    assert_eq!(r.events.iter().find(|e| e["subtype"] == "task_notification").unwrap()["status"], "completed");
    assert!(t0.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn stop_while_waiting_on_a_background_task_ends_the_run() {
    let Some(e) = env(&[("FAKE_MODE", "background"), ("FAKE_BG_MS", "30000")]) else { return };
    let waits: Arc<Mutex<Vec<bool>>> = Arc::default();
    let w = waits.clone();
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("scan".into());
    o.on_waiting = Some(Box::new(move |t| w.lock().push(t.is_some())));
    let h = runner::start_run(o);
    until("waiting", || !waits.lock().is_empty()).await;
    h.stop();
    h.wait().await;
    assert!(h.stopped());
    assert_eq!(waits.lock().last(), Some(&false));
}

#[tokio::test]
async fn idle_ms_keeps_input_open_between_turns_then_ends_it() {
    let Some(e) = env(&[]) else { return };
    let turns: Arc<Mutex<Vec<Instant>>> = Arc::default();
    let t = turns.clone();
    let mut o = opts(&e, vec!["--input-format".into(), "stream-json".into(), "--replay-user-messages".into()], Box::new(move |ev| {
        if ty(ev) == "result" {
            t.lock().push(Instant::now());
        }
    }));
    o.input = Some("first".into());
    o.idle_ms = 400;
    let h = runner::start_run(o);
    until("the first turn", || !turns.lock().is_empty()).await;
    // Idle after its turn, but still alive: a message reaches the live session.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!h.finished());
    assert!(h.send("second", false));
    until("the second turn", || turns.lock().len() >= 2).await;
    let r = h.wait().await;
    assert_eq!(r.code, 0);
    let firsts: Vec<String> = results(&r.events).iter().map(|x| x.split('\n').next().unwrap().to_string()).collect();
    assert_eq!(firsts, ["Work complete.", "Reply: second"]);
    // It ended about idle_ms after the last turn, not right away.
    assert!(turns.lock()[1].elapsed() >= Duration::from_millis(350));
}

#[tokio::test]
async fn end_when_idle_ends_a_kept_open_run_at_once() {
    let Some(e) = env(&[]) else { return };
    let idle = Arc::new(Mutex::new(false));
    let i = idle.clone();
    let mut o = opts(&e, vec!["--input-format".into(), "stream-json".into(), "--replay-user-messages".into()], Box::new(move |ev| {
        if ty(ev) == "result" {
            *i.lock() = true;
        }
    }));
    o.input = Some("x".into());
    o.idle_ms = 60_000;
    let h = runner::start_run(o);
    until("idle", || *idle.lock()).await;
    let t1 = Instant::now();
    h.end_when_idle();
    assert_eq!(h.wait().await.code, 0);
    assert!(t1.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn the_watchdog_flags_a_silent_run_and_clears_when_output_resumes() {
    let Some(e) = env(&[("FAKE_MODE", "silent"), ("FAKE_SILENT_MS", "1200")]) else { return };
    let stalls: Arc<Mutex<Vec<bool>>> = Arc::default();
    let s = stalls.clone();
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("hang".into());
    o.stall_ms = 300;
    o.on_stall = Some(Box::new(move |x| s.lock().push(x)));
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.code, 0);
    // Stalled, then cleared when output came back (a slow start of Bun can add one more pair before the silence).
    let got = stalls.lock().clone();
    assert!(got.len() >= 2 && got.len().is_multiple_of(2) && got.iter().enumerate().all(|(i, x)| *x == (i % 2 == 0)), "{got:?}");
}

#[tokio::test]
async fn stop_task_stops_a_workflow_and_the_run_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let wf = dir.path().to_string_lossy().into_owned();
    let Some(e) = env(&[("FAKE_MODE", "workflow"), ("FAKE_WF_DIR", &wf), ("FAKE_WF_STEP_MS", "300"), ("FAKE_WF_AGENTS", "10")]) else { return };
    let started = Arc::new(Mutex::new(false));
    let s = started.clone();
    let mut o = opts(&e, stream_args(), Box::new(move |ev| {
        if ev["subtype"] == "background_tasks_changed" && ev["tasks"].as_array().is_some_and(|t| !t.is_empty()) {
            *s.lock() = true;
        }
    }));
    o.input = Some("review".into());
    let h = runner::start_run(o);
    until("the workflow", || *started.lock()).await;
    assert_eq!(h.stop_task("wtask1").await, Ok(()));
    let r = h.wait().await;
    assert_eq!(r.code, 0);
    assert_eq!(r.events.iter().find(|e| e["subtype"] == "task_notification").unwrap()["status"], "killed");
    // A CLI that refuses: its error comes back.
    let Some(e) = env(&[("FAKE_MODE", "workflow-nostop"), ("FAKE_WF_DIR", &wf), ("FAKE_WF_STEP_MS", "300"), ("FAKE_WF_AGENTS", "3")]) else { return };
    let started = Arc::new(Mutex::new(false));
    let s = started.clone();
    let mut o = opts(&e, stream_args(), Box::new(move |ev| {
        if ev["subtype"] == "background_tasks_changed" {
            *s.lock() = true;
        }
    }));
    o.input = Some("review".into());
    let h = runner::start_run(o);
    until("the workflow", || *started.lock()).await;
    assert_eq!(h.stop_task("wtask1").await, Err("stop_task: not supported".into()));
    h.wait().await;
    assert_eq!(h.stop_task("wtask1").await, Err("the run is finishing".into()));
}

#[tokio::test]
async fn retry_and_limit_readers_on_real_output() {
    let Some(e) = env(&[("FAKE_MODE", "overloaded")]) else { return };
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("x".into());
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.code, 1);
    assert!(retry::transient_error(&r.events, &r.stderr).is_some_and(|t| t.contains("529")));
    let Some(e) = env(&[("FAKE_MODE", "limit")]) else { return };
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("x".into());
    let r = runner::start_run(o).wait().await;
    assert!(retry::transient_error(&r.events, &r.stderr).is_none());
    assert!(retry::limit_message(&r.events, &r.stderr).is_some_and(|t| t.contains("spend limit")));
    let Some(e) = env(&[("FAKE_MODE", "budget")]) else { return };
    let mut o = opts(&e, runner::build_args(&BuildArgs { session_id: "u9".into(), max_budget_usd: Some(0.05), ..Default::default() }), Box::new(|_| {}));
    o.input = Some("x".into());
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.events.last().unwrap()["subtype"], "error_max_budget_usd");
}

#[tokio::test]
async fn a_run_gets_its_own_identity_vars_and_args() {
    let dir = tempfile::tempdir().unwrap();
    let args_file = dir.path().join("args.jsonl").to_string_lossy().into_owned();
    let Some(e) = env(&[("FAKE_ARGS_FILE", &args_file), ("FAKE_ENV_KEYS", "CKANBAN_TICKET,CKANBAN_PORT"), ("CKANBAN_TICKET", "p/t_1")]) else { return };
    let mut o = opts(&e, stream_args(), Box::new(|_| {}));
    o.input = Some("hello".into());
    let r = runner::start_run(o).wait().await;
    assert_eq!(r.code, 0);
    let rec: Value = serde_json::from_str(std::fs::read_to_string(&args_file).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!(rec["prompt"], "hello");
    assert_eq!(rec["env"]["CKANBAN_TICKET"], "p/t_1");
    assert_eq!(rec["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect::<Vec<_>>(), stream_args());
}

#[tokio::test]
async fn a_side_call_reads_the_clis_json_answer() {
    let Some(e) = env(&[("FAKE_SIDE_JSON", "1"), ("FAKE_SIDE_TEXT", "It is done.")]) else { return };
    let caller = side_call::SideCaller { bin: Some(fake()), cwd: Some(e.cwd.clone()), env: Some(e.env.clone()) };
    let r = caller.call(side_call::SideCallInput { prompt: "explain".into(), system: "Be brief.".into(), ..Default::default() }).await;
    assert_eq!(r, side_call::SideCallResult::Ok { text: "It is done.".into(), cost_usd: 0.002, model: "haiku".into() });
    // Without FAKE_SIDE_JSON the fake prints stream lines: not an answer.
    let Some(e) = env(&[]) else { return };
    let caller = side_call::SideCaller { bin: Some(fake()), cwd: Some(e.cwd.clone()), env: Some(e.env.clone()) };
    assert!(matches!(caller.call(side_call::SideCallInput { prompt: "x".into(), system: "s".into(), ..Default::default() }).await, side_call::SideCallResult::Err { .. }));
    let missing = side_call::SideCaller { bin: Some("/nonexistent/claude".into()), cwd: Some(e.cwd.clone()), env: None };
    assert_eq!(
        missing.call(side_call::SideCallInput::default()).await,
        side_call::SideCallResult::Err { error: "Claude Code isn't installed or isn't on PATH".into(), cost_usd: None }
    );
}

/// The TMPDIR the fake was given (from its args file), once it has started.
async fn tmpdir_given(args_file: &Path) -> PathBuf {
    until("the fake's args record", || std::fs::read_to_string(args_file).is_ok_and(|s| s.contains("TMPDIR"))).await;
    let rec: Value = serde_json::from_str(std::fs::read_to_string(args_file).unwrap().lines().next().unwrap()).unwrap();
    PathBuf::from(rec["env"]["TMPDIR"].as_str().expect("TMPDIR given"))
}

#[tokio::test]
async fn a_tickets_run_gets_its_own_temp_folder_removed_when_it_ends_or_is_stopped() {
    use ckanban_board::runs::run_temp;
    for mode in ["ok", "slow"] {
        let dir = tempfile::tempdir().unwrap();
        let args_file = dir.path().join("args.jsonl");
        let af = args_file.to_string_lossy().into_owned();
        let Some(e) = env(&[("FAKE_MODE", mode), ("FAKE_ARGS_FILE", &af), ("FAKE_ENV_KEYS", "TMPDIR"), ("CKANBAN_TICKET", "p/t_tmp")]) else { return };
        let h = runner::start_run(opts(&e, vec![], Box::new(|_| {})));
        let tmp = tmpdir_given(&args_file).await;
        let root = std::fs::canonicalize(run_temp::root()).unwrap();
        assert!(tmp.starts_with(&root), "{} not under {}", tmp.display(), root.display());
        assert!(tmp.file_name().unwrap().to_string_lossy().starts_with("p-t_tmp-"));
        assert!(tmp.is_dir(), "the folder is there while the run works");
        if mode == "slow" {
            h.stop();
        }
        h.wait().await;
        assert!(!tmp.exists(), "{mode}: the run's temp folder is gone once it ended");
    }
    // A process that isn't a ticket's keeps the usual temp folder.
    let dir = tempfile::tempdir().unwrap();
    let args_file = dir.path().join("args.jsonl");
    let af = args_file.to_string_lossy().into_owned();
    let Some(e) = env(&[("FAKE_ARGS_FILE", &af), ("FAKE_ENV_KEYS", "TMPDIR")]) else { return };
    runner::start_run(opts(&e, vec![], Box::new(|_| {}))).wait().await;
    let rec: Value = serde_json::from_str(std::fs::read_to_string(&args_file).unwrap().lines().next().unwrap()).unwrap();
    assert!(!rec["env"]["TMPDIR"].as_str().unwrap_or("").contains("ckanban-runs"));
}
