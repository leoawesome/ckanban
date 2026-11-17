//! The manager against a fake `claude` (`test/contract/fake-claude-mcp.ts` for `claude mcp ...`; anything else, the
//! probe session included, exits at once), on a temp data folder and a temp Claude config. Needs `bun` on PATH.

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::*;

struct Fixture {
    dir: PathBuf,
    mcp: Arc<Mcp>,
    events: Arc<Mutex<Vec<Value>>>,
    log: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn fixture() -> Option<Fixture> {
    let bun = which("bun")?;
    let dir = parse::tests::tempfile_dir();
    let fake = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../test/contract/fake-claude-mcp.ts");
    let log = dir.join("mcp.jsonl");
    let bin = dir.join("claude");
    std::fs::write(
        &bin,
        format!("#!/bin/sh\nif [ \"$1\" = mcp ]; then CLAUDE_CONFIG_DIR='{}' FAKE_MCP_LOG='{}' exec '{}' '{}' \"$@\"; fi\nexit 1\n", dir.display(), log.display(), bun.display(), fake.display()),
    )
    .unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let data = dir.join("data");
    std::fs::create_dir_all(data.join("profiles/b1")).unwrap();
    std::fs::write(data.join("profiles/b1/profile.json"), r#"{"slug":"b1","name":"Board One","createdAt":"2026-01-01T00:00:00.000Z"}"#).unwrap();
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let mut o = McpOptions::new(&data);
    o.claude_bin = bin.to_string_lossy().into_owned();
    o.cwd = home;
    o.config_file = dir.join(".claude.json");
    o.probe_timeout = Duration::from_secs(5);
    let events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let mcp = Mcp::new(o, Arc::new(move |v| ev.lock().push(v)));
    Some(Fixture { dir, mcp, events, log })
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|f| f.is_file()))
}

async fn settle(m: &Arc<Mcp>) {
    for _ in 0..200 {
        if !m.inner.lock().inflight {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("refresh didn't finish");
}

fn call<'a>(method: &'a str, parts: &'a [String], body: &'a [u8], query: &'a str) -> Call<'a> {
    static USER: fn(&str) -> Result<(), Answer> = |_| Ok(());
    Call { method, parts, query, body, local: true, from_run: false, user: &USER }
}

fn parts(p: &str) -> Vec<String> {
    p.split('/').map(str::to_string).collect()
}

async fn api(m: &Arc<Mcp>, method: &str, path: &str, body: Value) -> (u16, Value) {
    let (path, q) = path.split_once('?').unwrap_or((path, ""));
    let ps = parts(path);
    let b = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
    match m.answer(&call(method, &ps, &b, q)).await.unwrap() {
        Answer::Json(s, v) => (s, v),
        a => panic!("{a:?}"),
    }
}

fn server<'a>(state: &'a Value, name: &str) -> Option<&'a Value> {
    state["servers"].as_array()?.iter().find(|s| s["name"] == name)
}

#[tokio::test]
async fn user_wide_server_add_config_edit_remove() {
    let Some(f) = fixture() else { return };
    let m = &f.mcp;
    m.refresh();
    settle(m).await;
    let (st, v) = api(m, "GET", "mcp", Value::Null).await;
    assert_eq!(st, 200);
    assert_eq!(v["servers"], json!([]));
    assert!(v["checkedAt"].is_string(), "{v}");
    assert_eq!(v["error"], Value::Null);

    let input = json!({ "name": "notes", "transport": "stdio", "command": "/bin/echo", "args": ["hi there"], "env": [{ "key": "NOTES_TOKEN", "value": "env-value-123456" }] });
    let (st, v) = api(m, "POST", "mcp", input.clone()).await;
    assert_eq!(st, 201, "{v}");
    let s = server(&v, "notes").unwrap();
    assert_eq!(s["scope"], "user");
    assert_eq!(s["status"], "connected");
    assert_eq!(s["boards"], json!([]));
    assert_eq!(s["move"], json!({ "can": true, "why": null }));
    assert_eq!(s["target"], "/bin/echo hi there");
    let log = std::fs::read_to_string(&f.log).unwrap();
    assert!(log.contains(r#"["mcp","add","--scope","user","--transport","stdio","notes","-e","NOTES_TOKEN=env-value-123456","--","/bin/echo","hi there"]"#), "{log}");
    assert_eq!(api(m, "POST", "mcp", input).await.0, 409);
    let (st, cfg) = api(m, "GET", "mcp/notes/config", Value::Null).await;
    assert_eq!(st, 200);
    assert_eq!(cfg["env"], json!([{ "key": "NOTES_TOKEN", "value": "env-value-123456" }]));
    settle(m).await;

    let edit = json!({ "name": "notes2", "transport": "http", "url": "https://x.io/mcp" });
    let (st, v) = api(m, "PUT", "mcp/notes", edit).await;
    assert_eq!(st, 200, "{v}");
    assert!(server(&v, "notes").is_none());
    assert_eq!(server(&v, "notes2").unwrap()["transport"], "http");
    assert_eq!(api(m, "POST", "mcp/notes2/recheck", Value::Null).await.0, 200);
    assert_eq!(api(m, "POST", "mcp/notes2/logout", Value::Null).await.0, 502);
    settle(m).await;
    let (st, v) = api(m, "DELETE", "mcp/notes2", Value::Null).await;
    assert_eq!(st, 200);
    assert!(server(&v, "notes2").is_none());
    assert_eq!(api(m, "DELETE", "mcp/nope", Value::Null).await, (404, json!({ "error": "no MCP server named \"nope\"" })));
    assert_eq!(api(m, "POST", "mcp/x/whatever", Value::Null).await, (404, json!({ "error": "not found" })));
    assert_eq!(api(m, "POST", "mcp", json!({ "name": "-" })).await.0, 400);
    assert_eq!(api(m, "POST", "mcp/refresh", Value::Null).await.0, 202);
    settle(m).await;
    assert!(f.events.lock().iter().all(|e| e["type"] == "mcp.updated"));
    let seen = std::fs::read_to_string(f.dir.join("data/mcp-seen.json")).unwrap();
    assert_eq!(seen, r#"["notes","notes2"]"#);
}

#[tokio::test]
async fn board_only_tool_add_move_and_back() {
    let Some(f) = fixture() else { return };
    let m = &f.mcp;
    m.refresh();
    settle(m).await;
    let tool = json!({ "name": "linear", "transport": "http", "url": "https://mcp.linear.app/mcp", "headers": [{ "name": "Authorization", "value": "Bearer abcdefghijklmnop" }], "board": "b1" });
    let (st, v) = api(m, "POST", "mcp", tool.clone()).await;
    assert_eq!(st, 201, "{v}");
    let s = server(&v, "linear").unwrap();
    assert_eq!(Value::Object(s.as_object().unwrap().clone()).to_string(), r#"{"name":"linear","target":"https://mcp.linear.app/mcp","transport":"http","scope":"board","status":"unknown","message":null,"attention":false,"login":null,"boards":[{"slug":"b1","name":"Board One"}],"move":{"can":true,"why":null},"leftover":null}"#);
    let file = f.dir.join("data/profiles/b1/board-tools.json");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\n  \"mcpServers\": {\n    \"linear\": {\n      \"type\": \"http\",\n      \"url\": \"https://mcp.linear.app/mcp\",\n      \"headers\": {\n        \"Authorization\": \"Bearer abcdefghijklmnop\"\n      }\n    }\n  }\n}\n");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(api(m, "POST", "mcp", tool).await.0, 409);
    assert_eq!(api(m, "POST", "mcp", json!({ "name": "ckanban", "transport": "stdio", "command": "x", "board": "b1" })).await.0, 409);
    assert_eq!(api(m, "POST", "mcp", json!({ "name": "y", "transport": "stdio", "command": "x", "board": "nope" })).await, (404, json!({ "error": "board nope not found" })));
    let (st, cfg) = api(m, "GET", "mcp/linear/config?board=b1", Value::Null).await;
    assert_eq!(st, 200);
    assert_eq!(cfg["scope"], "board");
    assert_eq!(cfg["commandLine"], Value::Null);
    settle(m).await;

    let (st, v) = api(m, "POST", "mcp/linear/move", json!({ "to": "all", "board": "b1" })).await;
    assert_eq!(st, 200, "{v}");
    assert_eq!(server(&v, "linear").unwrap()["scope"], "user");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{\n  \"mcpServers\": {}\n}\n");
    settle(m).await;
    let (st, v) = api(m, "POST", "mcp/linear/move", json!({ "to": "board", "board": "b1" })).await;
    assert_eq!(st, 200, "{v}");
    let s = server(&v, "linear").unwrap();
    assert_eq!(s["scope"], "board");
    assert_eq!(s["status"], "connected");
    settle(m).await;
    assert_eq!(api(m, "POST", "mcp/linear/move", json!({ "to": "x" })).await, (400, json!({ "error": "to must be board or all" })));
    assert_eq!(api(m, "POST", "mcp/linear/retry-move", Value::Null).await.0, 404);
    let (st, v) = api(m, "DELETE", "mcp/linear?board=b1", Value::Null).await;
    assert_eq!(st, 200);
    assert!(server(&v, "linear").is_none());
    assert_eq!(api(m, "POST", "mcp/nope/login-paste", json!({ "text": "nope" })).await.0, 400);
    assert_eq!(api(m, "POST", "mcp/nope/login-paste", json!({ "text": "https://x/cb" })).await.0, 409);
}
