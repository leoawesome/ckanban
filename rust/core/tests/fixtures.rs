//! Feeds the shared fixtures (tests/fixtures, checked against Bun by test/rust-fixtures.test.ts) to the Rust code
//! and checks it gives the same JSON, byte for byte where Bun writes bytes (usage-last.json).

use ckanban_core::spend::SpendIndex;
use ckanban_core::usage::{normalize_usage, pick_credentials, windows_json, Credentials, UsageClient, UsageResult, UsageWindow};
use ckanban_core::usage_cache::{Fetcher, UsageCache};
use ckanban_core::{jsnum, time, DataDir};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn load(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(rel)).unwrap()).unwrap()
}

/// Both sides as normalized JSON text: same keys in the same order, numbers written like JS.
fn same(got: &Value, want: &Value, what: &str) {
    let g = serde_json::to_string(&jsnum::normalize(got.clone())).unwrap();
    let w = serde_json::to_string(&jsnum::normalize(want.clone())).unwrap();
    assert_eq!(g, w, "{what}");
}

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ckrs-{name}-{}", ckanban_core::atomic::new_id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn raws(c: &Value) -> Vec<Option<String>> {
    c["raws"].as_array().unwrap().iter().map(|r| r.as_str().map(str::to_string)).collect()
}

#[test]
fn normalize_matches_bun() {
    for c in load("usage/normalize.json")["cases"].as_array().unwrap() {
        let got = normalize_usage(&c["body"]).map_or(Value::Null, |w| windows_json(&w));
        same(&got, &c["expect"], c["name"].as_str().unwrap());
    }
}

fn creds_json(c: &Credentials) -> Value {
    match c {
        Credentials::Error(e) => json!({ "error": e }),
        Credentials::Token { token, expires_at } => json!({ "token": token, "expiresAt": expires_at.map_or(Value::Null, jsnum::num) }),
    }
}

#[test]
fn credentials_match_bun() {
    for c in load("usage/credentials.json")["cases"].as_array().unwrap() {
        same(&creds_json(&pick_credentials(&raws(c))), &c["expect"], c["name"].as_str().unwrap());
    }
}

/// A one-request HTTP server that answers with `reply` and reports the auth headers it got.
async fn fake_endpoint(reply: Value) -> (String, tokio::task::JoinHandle<Value>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/oauth/usage", l.local_addr().unwrap());
    let h = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = s.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let head = String::from_utf8_lossy(&buf).to_string();
        let header = |name: &str| {
            head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()))
        };
        let status = reply["status"].as_u64().unwrap();
        let body = reply["body"].as_str().unwrap_or("");
        let mut extra = String::new();
        if let Some(h) = reply["headers"].as_object() {
            for (k, v) in h {
                extra.push_str(&format!("{k}: {}\r\n", v.as_str().unwrap()));
            }
        }
        let len = if status == 204 { String::new() } else { format!("content-length: {}\r\n", body.len()) };
        let out = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{len}{extra}connection: close\r\n\r\n{body}");
        s.write_all(out.as_bytes()).await.unwrap();
        s.shutdown().await.ok();
        json!({ "authorization": header("authorization"), "anthropic-beta": header("anthropic-beta") })
    });
    (url, h)
}

#[tokio::test]
async fn fetch_matches_bun() {
    let doc = load("usage/fetch.json");
    let now = doc["now"].as_f64().unwrap();
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let (url, server) = if c["reply"].is_null() { ("http://127.0.0.1:9/never".to_string(), None) } else {
            let (u, h) = fake_endpoint(c["reply"].clone()).await;
            (u, Some(h))
        };
        let client = UsageClient::new(url, false, "/nonexistent");
        let result = client.fetch_with(pick_credentials(&raws(c)), || now).await;
        let sent = match server {
            Some(h) => h.await.unwrap(),
            None => Value::Null,
        };
        same(&json!({ "result": result.to_json(), "sent": sent }), &c["expect"], name);
    }
}

#[tokio::test]
async fn an_unreachable_endpoint_is_offline() {
    // A port nothing listens on.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/u", l.local_addr().unwrap());
    drop(l);
    let r = UsageClient::new(url, false, "/nonexistent").fetch_with(Credentials::Token { token: "t".into(), expires_at: None }, || 0.0).await;
    assert_eq!(r, UsageResult::failure("Could not reach Anthropic (offline?)", time::iso(0.0)));
}

/// A `UsageResult` as the fixtures write it (Bun's object).
fn result_of(v: &Value) -> UsageResult {
    let fetched_at = v["fetchedAt"].as_str().unwrap().to_string();
    if let Some(ws) = v["windows"].as_array() {
        let windows = ws
            .iter()
            .map(|w| UsageWindow {
                key: w["key"].as_str().unwrap().into(),
                label: w["label"].as_str().unwrap().into(),
                percent: w["percent"].as_f64().unwrap(),
                resets_at: w["resetsAt"].as_str().map(str::to_string),
            })
            .collect();
        return UsageResult::Answer { windows, fetched_at };
    }
    UsageResult::Failure {
        error: v["error"].as_str().unwrap().into(),
        fetched_at,
        status: v["status"].as_u64().map(|s| s as u16),
        retry_after_ms: v["retryAfterMs"].as_f64(),
    }
}

#[tokio::test]
async fn cache_matches_bun() {
    let doc = load("usage/cache.json");
    let start = doc["start"].as_f64().unwrap();
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let file = temp("cache").join("usage-last.json");
        if let Some(s) = c["saved"].as_str() {
            std::fs::write(&file, s).unwrap();
        }
        let now = Arc::new(Mutex::new(start));
        let reply: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let asked = Arc::new(Mutex::new(false));
        let fetcher: Fetcher = {
            let (reply, asked) = (reply.clone(), asked.clone());
            Arc::new(move || {
                *asked.lock().unwrap() = true;
                let r = reply.lock().unwrap().clone().unwrap_or_else(|| panic!("asked at a step without a reply"));
                Box::pin(async move {
                    if r == "hang" {
                        std::future::pending::<()>().await;
                    }
                    result_of(&r)
                })
            })
        };
        let clock = {
            let now = now.clone();
            Arc::new(move || *now.lock().unwrap())
        };
        let timeout = Duration::from_millis(c["timeoutMs"].as_u64().unwrap_or(10_000));
        let cache = UsageCache::new(fetcher, clock, Some(file.clone())).timeout(timeout);
        let mut steps = Vec::new();
        for s in c["steps"].as_array().unwrap() {
            *now.lock().unwrap() = start + s["t"].as_f64().unwrap();
            *reply.lock().unwrap() = s.get("reply").cloned();
            *asked.lock().unwrap() = false;
            let view = cache.get(s["fresh"].as_bool().unwrap_or(false)).await;
            steps.push(json!({ "asked": *asked.lock().unwrap(), "view": view }));
        }
        same(&Value::Array(steps), &c["expect"]["steps"], name);
        let saved = std::fs::read_to_string(&file).ok();
        assert_eq!(saved.as_deref(), c["expect"]["file"].as_str(), "{name}: usage-last.json");
    }
}

#[tokio::test]
async fn a_check_saved_by_another_process_is_reused() {
    // Bun (or another server) checked a moment ago and saved it: this cache serves that and doesn't ask.
    let file = temp("shared").join("usage-last.json");
    let t = 1_794_744_000_000.0;
    let now = Arc::new(Mutex::new(t));
    let calls = Arc::new(Mutex::new(0));
    let fetcher: Fetcher = {
        let calls = calls.clone();
        Arc::new(move || {
            *calls.lock().unwrap() += 1;
            Box::pin(async { UsageResult::failure("should not ask", String::new()) })
        })
    };
    let clock = {
        let now = now.clone();
        Arc::new(move || *now.lock().unwrap())
    };
    let cache = UsageCache::new(fetcher, clock, Some(file.clone()));
    // Nothing saved yet, and Bun's file appears after this cache started.
    let bun = format!(
        r#"{{"last":{{"windows":[{{"key":"five_hour","label":"Current session (5h)","percent":33,"resetsAt":null}}],"fetchedAt":"{}"}},"lastError":null,"attemptAt":{},"blockedUntil":0,"failures":0}}"#,
        time::iso(t - 5_000.0),
        t - 5_000.0
    );
    std::fs::write(&file, &bun).unwrap();
    let v = cache.get(true).await;
    assert_eq!(v["windows"][0]["percent"], json!(33));
    *now.lock().unwrap() = t + 120_000.0;
    let v = cache.get(false).await;
    assert_eq!(v["windows"][0]["percent"], json!(33));
    assert_eq!(*calls.lock().unwrap(), 0);
    // The file is left as Bun wrote it.
    assert_eq!(std::fs::read_to_string(&file).unwrap(), bun);
}

#[tokio::test]
async fn one_check_in_flight_for_everyone() {
    let calls = Arc::new(Mutex::new(0));
    let fetcher: Fetcher = {
        let calls = calls.clone();
        Arc::new(move || {
            *calls.lock().unwrap() += 1;
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                UsageResult::Answer {
                    windows: vec![UsageWindow { key: "five_hour".into(), label: "x".into(), percent: 1.0, resets_at: None }],
                    fetched_at: time::iso(time::now_ms()),
                }
            })
        })
    };
    let cache = Arc::new(UsageCache::new(fetcher, Arc::new(time::now_ms), None));
    let all: Vec<_> = (0..8).map(|i| {
        let c = cache.clone();
        tokio::spawn(async move { c.get(i % 2 == 0).await })
    }).collect();
    for h in all {
        assert_eq!(h.await.unwrap()["windows"][0]["percent"], json!(1));
    }
    assert_eq!(*calls.lock().unwrap(), 1);
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let p = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &p);
        } else {
            std::fs::copy(e.path(), &p).unwrap();
        }
    }
}

#[tokio::test]
async fn spend_matches_bun() {
    let doc = load("spend/case.json");
    let home = temp("spend");
    copy_dir(&fixtures().join("spend").join("home"), &home);
    for (rel, at) in doc["mtimes"].as_object().unwrap() {
        let ms = time::parse_date(at.as_str().unwrap()).unwrap();
        let t = std::time::UNIX_EPOCH + Duration::from_millis(ms as u64);
        std::fs::File::options().write(true).open(home.join(rel)).unwrap().set_modified(t).unwrap();
    }
    let now = time::parse_date(doc["now"].as_str().unwrap()).unwrap();
    let index = Arc::new(SpendIndex::with_clock(DataDir::new(&home), Arc::new(move || now)));
    let got = index.recent().await.unwrap().to_json();
    same(&got, &doc["expect"], "spend");
    // Asked again: the same answer (reused, and counting again from saved offsets gives the same sums).
    same(&index.today().unwrap().to_json(), &doc["expect"], "spend again");

    // A line appended later is counted once, on top.
    let log = home.join("profiles/beta/tickets/b1/activity.jsonl");
    let line = r#"{"at":"2026-11-15T12:30:00.000Z","event":{"type":"result","total_cost_usd":2,"session_id":"bb"}}"#;
    std::fs::write(&log, format!("{}{line}\n", std::fs::read_to_string(&log).unwrap())).unwrap();
    let again = index.today().unwrap();
    let beta = again.boards.iter().find(|b| b.slug == "beta").unwrap();
    assert!((beta.cost_usd - 2.0).abs() < 1e-12);
}

#[tokio::test]
async fn spend_needs_a_profiles_folder() {
    let home = temp("noprofiles");
    let index = Arc::new(SpendIndex::new(DataDir::new(&home)));
    assert!(index.recent().await.is_err());
    std::fs::create_dir_all(home.join("profiles")).unwrap();
    let mut m = Map::new();
    m.insert("day".into(), time::day_key(time::now_ms()).into());
    m.insert("costUsd".into(), json!(0));
    m.insert("boards".into(), json!([]));
    same(&index.today().unwrap().to_json(), &Value::Object(m), "empty");
}
