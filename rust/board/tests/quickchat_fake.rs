//! Quick chats (R8) against the fake Claude (`test/fixtures/fake-claude.ts`, run by Bun), on a temp data folder and a
//! temp `CLAUDE_CONFIG_DIR`: never the real `claude`. The same steps as `test/contract/quickchat.test.ts` that don't
//! need later tasks (sending, events, files, list pages, conversation, tool details, rename, stop, delete, who may), plus
//! a restart in the middle of a reply and a lost conversation. Skipped without Bun.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ckanban_board::bus::Bus;
use ckanban_board::quickchat::routes::{ChatReq, Reply, UserCheck};
use ckanban_board::quickchat::{QuickChatOptions, QuickChats};
use ckanban_board::sessions::files;
use ckanban_board::sessions::service::Sessions;
use parking_lot::Mutex;
use serde_json::{Value, json};

fn fake() -> String {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/fake-claude.ts").canonicalize().expect("fake claude").to_string_lossy().into_owned()
}

fn path_with_bun() -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let dirs = path.split(':').map(PathBuf::from).chain([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    let home_bun = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".bun/bin"));
    let dir = dirs.chain(home_bun).find(|d| d.join("bun").is_file())?;
    Some(format!("{}:{path}", dir.display()))
}

struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
    projects: PathBuf,
    args_file: PathBuf,
    chats: Arc<QuickChats>,
    sessions: Arc<Sessions>,
    events: Arc<Mutex<Vec<Value>>>,
}

const SLUG: &str = "ask";

fn setup(vars: &[(&str, &str)]) -> Option<Env> {
    let Some(path) = path_with_bun() else {
        eprintln!("skipped: bun not found");
        return None;
    };
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("data");
    let project = base.join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(root.join("profiles").join(SLUG)).unwrap();
    std::fs::write(
        root.join("profiles").join(SLUG).join("profile.json"),
        serde_json::to_string_pretty(&json!({ "slug": SLUG, "name": "Ask", "path": project, "createdAt": "2026-11-17T00:00:00.000Z" })).unwrap(),
    )
    .unwrap();
    let config = base.join("claude");
    let projects = config.join("projects");
    let args_file = base.join("claude-args.jsonl");
    Some(open(dir, root, projects, &config, &args_file, &path, vars))
}

fn open(dir: tempfile::TempDir, root: PathBuf, projects: PathBuf, config: &Path, args_file: &Path, path: &str, vars: &[(&str, &str)]) -> Env {
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    env.insert("PATH".into(), path.into());
    env.insert("CLAUDE_CONFIG_DIR".into(), config.to_string_lossy().into_owned());
    env.insert("FAKE_ARGS_FILE".into(), args_file.to_string_lossy().into_owned());
    for (k, v) in vars {
        env.insert(k.to_string(), v.to_string());
    }
    let p = projects.clone();
    let opts = QuickChatOptions {
        claude_bin: fake(),
        env,
        mcp: Some(Arc::new(|_| "{\"mcpServers\":{}}".to_string())),
        session_exists: Some(Arc::new(move |id| files::find_session_file(&p, id).is_some())),
    };
    let bus = Arc::new(Bus::new());
    let events = Arc::new(Mutex::new(Vec::new()));
    let e = events.clone();
    bus.on(move |ev| e.lock().push(ev.body.clone()));
    let chats = QuickChats::new(&root, bus, opts);
    let sessions = Sessions::with(&root, &projects, Arc::new(|s: &str| s.to_string()));
    Env { _dir: dir, root, projects, args_file: args_file.to_path_buf(), chats, sessions, events }
}

fn user(yes: bool) -> UserCheck {
    Box::new(move || Box::pin(async move { yes }))
}

async fn call(e: &Env, method: &str, path: &str, body: Option<Value>, is_user: bool) -> Reply {
    let (path, query) = match path.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (path.to_string(), None),
    };
    let req = ChatReq { method: method.into(), path, query, body: Ok(body) };
    e.chats.answer(&e.sessions, req, user(is_user)).await
}

fn base() -> String {
    format!("/api/profiles/{SLUG}/chats")
}

async fn until<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
    let t0 = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn chat_file(e: &Env, id: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(e.root.join("profiles").join(SLUG).join("chats").join(format!("{id}.json"))).unwrap()).unwrap()
}

fn body(r: &Reply) -> &Value {
    r.body.as_ref().expect("a body")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_chat_from_first_message_to_delete() {
    let Some(e) = setup(&[("FAKE_TRANSCRIPT", "1"), ("FAKE_UUIDS", "1"), ("FAKE_STREAM_DELAY", "300")]) else { return };
    // Who may: a run or a program without the user's browser is refused; reads are open; 404s come first.
    let refused = call(&e, "POST", &base(), Some(json!({ "text": "hi" })), false).await;
    assert_eq!(refused.status, 403);
    assert!(body(&refused)["error"].as_str().unwrap().starts_with("Quick chats is for the user only"));
    assert_eq!(call(&e, "GET", &base(), None, false).await.status, 200);
    let nope = call(&e, "GET", &format!("{}/nope", base()), None, false).await;
    assert_eq!((nope.status, body(&nope).clone()), (404, json!({ "error": "chat not found" })));
    assert_eq!(call(&e, "DELETE", &format!("{}/nope", base()), None, false).await.status, 404);
    assert_eq!(call(&e, "GET", "/api/profiles/nope/chats", None, false).await.status, 404);
    assert_eq!(call(&e, "POST", &base(), Some(json!({ "text": "   " })), true).await.status, 400);
    let bad = e.chats.answer(&e.sessions, ChatReq { method: "POST".into(), path: base(), query: None, body: Err(()) }, user(true)).await;
    assert_eq!((bad.status, body(&bad)["error"].as_str()), (400, Some("invalid JSON body")));

    // The first message starts a chat; events stream its reply; its files are written.
    let made = call(&e, "POST", &base(), Some(json!({ "text": "What is in this folder?\nmore lines" })), true).await;
    assert_eq!(made.status, 201);
    let v = body(&made);
    assert_eq!(v["title"], "What is in this folder?");
    assert_eq!(v["renamed"], false);
    assert_eq!(v["firstMessage"], "What is in this folder?\nmore lines");
    assert_eq!(v["running"], true);
    let id = v["id"].as_str().unwrap().to_string();
    let sid = v["sessionId"].as_str().unwrap().to_string();
    assert!(id.len() == 8 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    assert_eq!(sid.len(), 36);
    e.chats.idle().await;
    let done = call(&e, "GET", &format!("{}/{id}", base()), None, false).await;
    let d = body(&done);
    assert_eq!((d["running"].clone(), d["activity"].clone(), d["waiting"].clone(), d["started"].clone()), (json!(false), Value::Null, json!(0), json!(true)));
    let evs = e.events.lock().clone();
    let drafts: Vec<&Value> = evs.iter().filter(|x| x["type"] == "chat.draft" && x["id"] == id.as_str()).collect();
    assert!(drafts.iter().any(|x| x["text"].as_str().unwrap().starts_with("Work ") && x.get("final").is_none()), "{drafts:?}");
    assert!(drafts.last().unwrap()["final"].as_str().unwrap().contains("Work complete."));
    let updates: Vec<&Value> = evs.iter().filter(|x| x["type"] == "chat.updated" && x["id"] == id.as_str()).collect();
    assert!(updates.iter().any(|x| x["chat"]["running"] == true));
    assert_eq!(updates.last().unwrap()["chat"]["running"], false);
    assert!(evs.iter().any(|x| x["type"] == "chat.activity" && x["id"] == id.as_str() && x.get("activity").is_some()));
    let saved = chat_file(&e, &id);
    assert_eq!((saved["title"].clone(), saved["started"].clone(), saved["ticketId"].clone()), (Value::Null, json!(true), Value::Null));
    assert!(saved.get("running").is_none() && saved.get("renamed").is_none());
    let keys: Vec<&str> = saved.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["id", "sessionId", "title", "firstMessage", "createdAt", "updatedAt", "started", "ticketId", "error"]);
    let log = std::fs::read_to_string(e.chats.activity_path(SLUG, &id)).unwrap();
    assert!(log.lines().next().unwrap().starts_with("{\"run\":1,\"at\":"));

    // The list: every chat without limit; pages with limit and before.
    let second = call(&e, "POST", &base(), Some(json!({ "text": "Second chat" })), true).await;
    let id2 = body(&second)["id"].as_str().unwrap().to_string();
    e.chats.idle().await;
    let all = call(&e, "GET", &base(), None, false).await;
    assert_eq!(body(&all).as_array().unwrap().len(), 2);
    let p1 = call(&e, "GET", &format!("{}?limit=1", base()), None, false).await;
    assert_eq!(body(&p1)["chats"][0]["id"], id2.as_str());
    let next = body(&p1)["next"].as_str().unwrap().to_string();
    let p2 = call(&e, "GET", &format!("{}?limit=1&before={}", base(), next.replace('|', "%7C")), None, false).await;
    assert_eq!(body(&p2)["chats"][0]["id"], id.as_str());
    assert_eq!(body(&p2)["next"], Value::Null);
    assert_eq!(call(&e, "DELETE", &format!("{}/{id2}", base()), None, true).await.status, 204);

    // Conversation: user and assistant entries, a tool row, paging.
    let c = call(&e, "GET", &format!("{}/{id}/conversation", base()), None, false).await;
    let c = body(&c).clone();
    let entries = c["entries"].as_array().unwrap();
    assert_eq!(c["start"], 0);
    assert_eq!(c["total"], entries.len());
    assert_eq!(entries[0]["role"], "user");
    assert_eq!(entries[0]["text"], "What is in this folder?\nmore lines");
    assert!(entries.iter().any(|x| x["kind"] == "tool" && x["toolUseId"] == "tu_ls"));
    assert!(entries.iter().any(|x| x["role"] == "assistant" && x["text"].as_str().is_some_and(|t| t.contains("Work complete."))));
    let last = call(&e, "GET", &format!("{}/{id}/conversation?limit=1", base()), None, false).await;
    assert_eq!(body(&last)["entries"][0], *entries.last().unwrap());
    let first = call(&e, "GET", &format!("{}/{id}/conversation?limit=1&before=1", base()), None, false).await;
    assert_eq!(body(&first)["entries"][0], entries[0]);
    let tool = call(&e, "GET", &format!("{}/{id}/tool/tu_ls", base()), None, false).await;
    assert_eq!(tool.status, 200);
    assert!(body(&tool).to_string().contains("ls src"));
    assert_eq!(call(&e, "GET", &format!("{}/{id}/tool/tu_nope", base()), None, false).await.status, 404);

    // A reply continues the same session; rename.
    let r = call(&e, "POST", &format!("{}/{id}/messages", base()), Some(json!({ "text": "And the README?" })), true).await;
    assert_eq!((r.status, body(&r)["sessionId"].as_str()), (200, Some(sid.as_str())));
    assert_eq!(call(&e, "POST", &format!("{}/{id}/messages", base()), Some(json!({ "text": "x" })), false).await.status, 403);
    e.chats.idle().await;
    let args: Vec<Value> = std::fs::read_to_string(&e.args_file).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let mine: Vec<&Value> = args.iter().filter(|a| a["args"].as_array().unwrap().iter().any(|x| x == sid.as_str())).collect();
    let last_args = mine.last().unwrap()["args"].as_array().unwrap();
    assert!(last_args.iter().any(|x| x == "--resume"));
    assert!(last_args.iter().any(|x| x.as_str().is_some_and(|t| t.starts_with("You are running in a quick chat of ckanban"))));
    let renamed = call(&e, "PATCH", &format!("{}/{id}", base()), Some(json!({ "title": "  Folder   tour " })), true).await;
    assert_eq!((body(&renamed)["title"].as_str(), body(&renamed)["renamed"].as_bool()), (Some("Folder tour"), Some(true)));
    assert_eq!(chat_file(&e, &id)["title"], "Folder tour");
    assert_eq!(call(&e, "PATCH", &format!("{}/{id}", base()), Some(json!({ "title": "x" })), false).await.status, 403);

    // Later tasks' routes answer plainly for now.
    assert_eq!(call(&e, "GET", &format!("{}/{id}/context", base()), None, false).await.status, 501);
    assert_eq!(call(&e, "POST", &format!("{}/{id}/ticket", base()), Some(json!({})), false).await.status, 403);
    assert_eq!(call(&e, "POST", &format!("{}/{id}/ticket", base()), Some(json!({})), true).await.status, 501);

    // Stop when idle; delete removes its files.
    assert_eq!(call(&e, "POST", &format!("{}/{id}/stop", base()), Some(json!({})), false).await.status, 403);
    let stopped = call(&e, "POST", &format!("{}/{id}/stop", base()), Some(json!({})), true).await;
    assert_eq!(body(&stopped)["running"], false);
    assert_eq!(call(&e, "DELETE", &format!("{}/{id}", base()), None, false).await.status, 403);
    assert_eq!(call(&e, "DELETE", &format!("{}/{id}", base()), None, true).await.status, 204);
    assert_eq!(call(&e, "GET", &format!("{}/{id}", base()), None, false).await.status, 404);
    assert!(!e.chats.activity_path(SLUG, &id).exists());
    assert!(e.events.lock().iter().any(|x| x["type"] == "chat.updated" && x["id"] == id.as_str() && x["chat"].is_null()));
    let _ = &e.projects;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stop_ends_a_reply_without_an_error() {
    let Some(e) = setup(&[("FAKE_MODE", "slow")]) else { return };
    let v = e.chats.send(SLUG, None, "take your time").unwrap();
    let id = v["id"].as_str().unwrap().to_string();
    until("the run to start", || e.events.lock().iter().any(|x| x["type"] == "chat.activity" && x["id"] == id.as_str()).then_some(())).await;
    e.chats.stop(SLUG, &id);
    tokio::time::timeout(Duration::from_secs(15), e.chats.idle()).await.expect("stopped in time");
    let c = chat_file(&e, &id);
    assert_eq!(c["error"], Value::Null);
    assert!(e.events.lock().iter().any(|x| x["type"] == "chat.activity" && x["activity"] == "Stopping…"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_reply_cut_by_a_stop_of_board_mode_continues_after_the_next_start() {
    let Some(e) = setup(&[("FAKE_MODE", "slow")]) else { return };
    let v = e.chats.send(SLUG, None, "a long job").unwrap();
    let id = v["id"].as_str().unwrap().to_string();
    until("the run to start", || e.events.lock().iter().any(|x| x["type"] == "chat.activity" && x["id"] == id.as_str()).then_some(())).await;
    let ch = e.chats.clone();
    tokio::task::spawn_blocking(move || ch.shutdown()).await.unwrap();
    let cut = chat_file(&e, &id);
    assert!(cut["interrupted"].is_object(), "{cut}");
    // A new start with a fake that answers: recover sends the reply on and clears the marks.
    let Env { _dir, root, projects, args_file, .. } = e;
    let config = projects.parent().unwrap().to_path_buf();
    let e2 = open(_dir, root, projects, &config, &args_file, &path_with_bun().unwrap(), &[]);
    let ch = e2.chats.clone();
    tokio::task::spawn_blocking(move || ch.recover()).await.unwrap();
    assert!(e2.chats.is_running(SLUG, &id));
    e2.chats.idle().await;
    let c = chat_file(&e2, &id);
    assert!(c.get("interrupted").is_none() && c.get("pending").is_none(), "{c}");
    assert_eq!(c["started"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lost_conversation_carries_on_in_a_new_one() {
    let Some(e) = setup(&[]) else { return };
    let dir = e.root.join("profiles").join(SLUG).join("chats");
    std::fs::create_dir_all(&dir).unwrap();
    let old = "11111111-2222-4333-8444-555555555555";
    std::fs::write(
        dir.join("lost1.json"),
        serde_json::to_string_pretty(&json!({ "id": "lost1", "sessionId": old, "title": null, "firstMessage": "hi", "createdAt": "2026-11-17T00:00:00.000Z",
            "updatedAt": "2026-11-17T00:00:00.000Z", "started": true, "ticketId": null, "error": null })).unwrap() + "\n",
    )
    .unwrap();
    e.chats.send(SLUG, Some("lost1"), "still there?").unwrap();
    e.chats.idle().await;
    let c = chat_file(&e, "lost1");
    assert_eq!(c["error"], Value::Null, "{c}");
    assert_ne!(c["sessionId"], old);
    assert_eq!(c["started"], true);
}
