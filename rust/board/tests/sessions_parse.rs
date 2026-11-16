//! Parity with Bun for whole transcripts: every case in `tests/fixtures/sessions/parse.json` (filled by
//! `test/rust-board-parse-fixtures.test.ts`) must parse to exactly Bun's `parseSession` answer, keys in the same order,
//! whether the transcript is read at once or fed in pieces cut anywhere (inside a line or a character), and the
//! session cache must give Bun's summary.

use std::sync::Arc;

use ckanban_board::sessions::cache::SessionCache;
use ckanban_board::sessions::parser::{SessionParser, parse_session};
use serde_json::Value;

fn cases() -> Vec<Value> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sessions/parse.json");
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    doc["cases"].as_array().unwrap().clone()
}

/// The same JSON text: values and key order.
fn same(got: &Value, want: &Value, what: &str) {
    let (g, w) = (serde_json::to_string(got).unwrap(), serde_json::to_string(want).unwrap());
    if g != w {
        let at = g.bytes().zip(w.bytes()).position(|(a, b)| a != b).unwrap_or(g.len().min(w.len()));
        let from = at.saturating_sub(200);
        panic!("{what} differs at byte {at}:\n rust: {}\n  bun: {}", &g[from..(at + 200).min(g.len())], &w[from..(at + 200).min(w.len())]);
    }
}

#[test]
fn parses_like_bun() {
    let cases = cases();
    assert!(cases.len() > 200);
    for (i, c) in cases.iter().enumerate() {
        let raw = c["raw"].as_str().unwrap();
        let want = &c["expect"]["parsed"];
        same(&parse_session(raw).to_json(), want, &format!("case {i} (whole)"));
        // Fed in pieces: cuts at every 7th, 61st and 997th byte, and one byte at a time for small ones.
        for step in [1usize, 7, 61, 997] {
            if step == 1 && raw.len() > 3000 {
                continue;
            }
            let mut p = SessionParser::new();
            for chunk in raw.as_bytes().chunks(step) {
                p.feed(chunk);
                // Reading the result between pieces must not change what later pieces give.
                if step == 61 {
                    let _ = p.result();
                }
            }
            same(&p.result().to_json(), want, &format!("case {i} (fed in steps of {step})"));
        }
    }
}

#[test]
fn summarises_like_bun() {
    let t = tempfile::tempdir().unwrap();
    let projects = t.path().join("projects");
    std::fs::create_dir_all(projects.join("-p")).unwrap();
    let cases = cases();
    for (i, c) in cases.iter().enumerate() {
        std::fs::write(projects.join(format!("-p/s{i}.jsonl")), c["raw"].as_str().unwrap()).unwrap();
    }
    let cache = SessionCache::new(&projects, None, Arc::new(ckanban_core::time::now_ms), Arc::new(|s: &str| s.to_string()));
    for (i, c) in cases.iter().enumerate() {
        let got = cache.summary(&format!("s{i}")).map(|mut s| {
            s.as_object_mut().unwrap().shift_remove("updatedAt");
            s
        });
        same(&got.unwrap_or(Value::Null), &c["expect"]["summary"], &format!("case {i} summary"));
    }
}

/// Parse speed on a big transcript: `R5_BENCH=<file> cargo test --release -p ckanban-board --test sessions_parse --
/// --ignored --nocapture`. Prints the whole parse, the cache's first read, and an unchanged second read (no file read).
#[test]
#[ignore]
fn parse_speed() {
    let Some(file) = std::env::var_os("R5_BENCH") else { return };
    let file = std::path::PathBuf::from(file);
    let raw = std::fs::read_to_string(&file).unwrap();
    let t = std::time::Instant::now();
    let p = parse_session(&raw);
    println!("parse_session: {} MB, {} entries in {:?}", raw.len() / 1_000_000, p.entries.len(), t.elapsed());
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("projects/-p")).unwrap();
    std::fs::copy(&file, dir.path().join("projects/-p/big.jsonl")).unwrap();
    let cache = SessionCache::new(&dir.path().join("projects"), None, Arc::new(ckanban_core::time::now_ms), Arc::new(|s: &str| s.to_string()));
    let t = std::time::Instant::now();
    let first = cache.get("big").unwrap();
    println!("cache first read (1 MB steps): {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let again = cache.get("big").unwrap();
    println!("cache read again, file unchanged: {:?} (same parse: {})", t.elapsed(), Arc::ptr_eq(&first, &again));
    let t = std::time::Instant::now();
    let s = cache.summary("big").unwrap();
    println!("summary: {:?} ({} bytes)", t.elapsed(), s.to_string().len());
}

/// Where a big parse's time goes: JSON alone, then events, then the result (`R5_BENCH=<file>`, release, --ignored).
#[test]
#[ignore]
fn parse_phases() {
    let Some(file) = std::env::var_os("R5_BENCH") else { return };
    let raw = std::fs::read_to_string(file).unwrap();
    let t = std::time::Instant::now();
    let mut n = 0;
    for l in raw.split('\n') {
        if serde_json::from_str::<Value>(l).is_ok() {
            n += 1;
        }
    }
    println!("serde_json lines: {n} in {:?}", t.elapsed());
    let mut p = SessionParser::new();
    let t = std::time::Instant::now();
    p.lines(&raw);
    println!("lines(): {:?}", t.elapsed());
    let t = std::time::Instant::now();
    let r = p.result();
    println!("result(): {:?} ({} entries)", t.elapsed(), r.entries.len());
}
