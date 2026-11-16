//! The data-folder library against files Bun wrote (tests/fixtures/data, checked against Bun by
//! test/rust-data-fixtures.test.ts): YAML front matter cases, and a data folder whose every file must come back
//! byte for byte after Rust reads and writes it.
//!
//! `real_board_round_trip` (ignored) does the same, read only, on a real data folder:
//! `CKANBAN_PARITY_HOME=~/.claude-kanban cargo test -p ckanban-core --test data -- --ignored --nocapture`.

use ckanban_core::datafile::{self, formats, Format};
use ckanban_core::{jsnum, jsonl, ticket, yaml_read, yaml_write};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn data() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join("data")
}

fn text(v: &Value) -> String {
    serde_json::to_string(&jsnum::normalize(v.clone())).unwrap()
}

#[test]
fn yaml_stringify_matches_bun() {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(data().join("yaml.json")).unwrap()).unwrap();
    let mut bad = Vec::new();
    for c in doc["stringify"].as_array().unwrap() {
        let got = yaml_write::stringify(&jsnum::normalize(c["value"].clone()));
        if got != c["yaml"].as_str().unwrap() {
            bad.push(format!("value {}\n--- bun\n{}--- rust\n{}", c["value"], c["yaml"].as_str().unwrap(), got));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ; first:\n{}", bad.len(), doc["stringify"].as_array().unwrap().len(), bad[0]);
}

#[test]
fn yaml_parse_matches_bun() {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(data().join("yaml.json")).unwrap()).unwrap();
    let mut bad = Vec::new();
    for c in doc["parse"].as_array().unwrap() {
        let yaml = c["yaml"].as_str().unwrap();
        let got = yaml_read::parse(yaml);
        let ok = match (&got, c.get("error").is_some()) {
            (Err(_), true) => true,
            (Ok(v), false) => text(v) == text(&c["value"]),
            _ => false,
        };
        if !ok {
            bad.push(format!("yaml:\n{yaml}\n--- bun {}\n--- rust {:?}", c.get("value").map_or("error".into(), text), got.map(|v| text(&v))));
        }
    }
    assert!(bad.is_empty(), "{} differ; first:\n{}", bad.len(), bad[0]);
}

/// The format Bun writes each JSON file of a data folder in (None: not a JSON file this library writes).
fn format_of(rel: &str) -> Option<Format> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let parent = rel.rsplit('/').nth(1).unwrap_or("");
    if !name.ends_with(".json") {
        return None;
    }
    if rel.contains("/outputs/") {
        return (name == "status.json").then_some(formats::FEATURE_STATUS);
    }
    Some(match (parent, name) {
        (_, "profile.json") => formats::PROFILE,
        (_, "board-tools.json") => formats::BOARD_TOOLS,
        (_, "help.json") => formats::HELP,
        (_, "simplified.json") => formats::SIMPLIFIED,
        (_, "context.json") => formats::CONTEXT,
        (_, n) if n.ends_with(".state.json") => formats::LOOP_STATE,
        (_, n) if n.ends_with(".simplified.json") => formats::SIMPLIFIED,
        (_, n) if n.ends_with(".context.json") => formats::CONTEXT,
        ("schedules", _) => formats::SCHEDULE,
        ("jobs", _) => formats::JOB,
        ("loops", _) => formats::LOOP,
        ("huddles", _) => formats::HUDDLE,
        ("chats", _) => formats::QUICK_CHAT,
        ("learned", "pile.json") => formats::LEARNED_PILE,
        ("learned", "changes.json") => formats::LEARNED_CHANGES,
        ("learned", "scanned-at.json") => formats::LEARNED_SCANNED_AT,
        (_, "huddle-presets.json") => formats::HUDDLE_PRESETS,
        (_, "huddle-templates.json") => formats::HUDDLE_TEMPLATES,
        (_, "avatars.json") => formats::AVATARS,
        (_, "snippets.json") => formats::SNIPPETS,
        (_, "notify.json") => formats::NOTIFY,
        (_, "push.json") => formats::PUSH,
        (_, "remote.json") => formats::REMOTE,
        (_, "automation-passes.json") => formats::AUTOMATION_PASSES,
        (_, "helper.json") => formats::HELPER,
        (_, "devices.json") => formats::DEVICES,
        (_, "browsers.json") => formats::BROWSERS,
        (_, "board-browsers.json") => formats::BOARD_BROWSERS,
        (_, "spend-days.json") => formats::SPEND_DAYS,
        (_, "telegram-spend.json" | "telegram-desk-spend.json") => formats::TELEGRAM_SPEND,
        (_, "usage-windows.json") => formats::USAGE_WINDOWS,
        (_, "messages.json") => formats::MESSAGES,
        (_, "waits.json") => formats::WAITS,
        (_, "helper-state.json") => formats::HELPER_STATE,
        (_, "telegram-links.json" | "telegram-pending.json" | "telegram-updates.json") => formats::TELEGRAM_STORE,
        (_, "telegram-offset.json") => formats::TELEGRAM_OFFSET,
        (_, "telegram-frontdesk.json") => formats::TELEGRAM_FRONTDESK,
        (_, "session-summaries.json") => formats::SESSION_SUMMARIES,
        (_, "usage-last.json") => formats::USAGE_LAST,
        (_, "mcp-seen.json" | "claude-ai-connectors.json") => formats::MCP_SEEN,
        (_, "claude-commands.json") => formats::CLAUDE_COMMANDS,
        (_, "model-versions.json") => formats::MODEL_VERSIONS,
        _ => return None,
    })
}

/// Folders a real data folder has that aren't the daemon's JSON (Chrome profiles, run outputs, scratch).
const SKIP_DIRS: &[&str] = &["browsers", "browsers-removed", "browser-files", "attachments", "debug", "share-tmp", "side-calls", "artifact-helper", "signin", "automation-tests", "node_modules", ".git", ".key-backups"];

const BOARD_DIRS: &[&str] = &["tickets", "chats", "schedules", "jobs", "loops", "huddles", "huddle-notes"];

fn walk(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            // In a board's folder only the daemon's own folders (others are Claude's or the user's, e.g. whatsapp/).
            let in_board = p.strip_prefix(base).map(|r| r.components().count() == 3 && r.starts_with("profiles")).unwrap_or(false);
            if in_board && !BOARD_DIRS.contains(&name.as_str()) {
                continue;
            }
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk(&p, base, out);
            }
        } else if ft.is_file() && !datafile::is_temp_name(&name) {
            out.push(p.strip_prefix(base).unwrap().to_string_lossy().into_owned());
        }
    }
}

#[derive(Default, Debug)]
struct Report {
    checked: usize,
    migrated: usize,
    differ: Vec<String>,
    unreadable: Vec<String>,
}

/// Reads every ticket, JSON and JSONL file of a data folder and renders it again: it must give the same bytes.
fn round_trip(home: &Path, max_jsonl_bytes: u64) -> Report {
    let mut files = Vec::new();
    walk(home, home, &mut files);
    files.sort();
    let mut r = Report::default();
    for rel in files {
        let path = home.join(&rel);
        // A run's outputs are its own files, except the feature status the board writes.
        if rel.contains("/outputs/") && !rel.ends_with("/outputs/status.json") {
            continue;
        }
        if rel.ends_with("/ticket.md") {
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            r.checked += 1;
            match ticket::parse(&raw) {
                Ok(t) if ticket::serialize(&t) == raw => {}
                // Bun turns an old add-on link into a family link on load (withoutAddOn): its next save differs too.
                Ok(_) if raw.contains("\naddOnOf:") || raw.contains("\nfollowUpOf:") => r.migrated += 1,
                Ok(t) => r.differ.push(format!("{rel}\n--- file\n{raw}\n--- rust\n{}", ticket::serialize(&t))),
                Err(e) => r.unreadable.push(format!("{rel}: {e}")),
            }
        } else if rel.ends_with(".jsonl") {
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > max_jsonl_bytes {
                continue;
            }
            let raw = String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default()).into_owned();
            r.checked += 1;
            for line in raw.split('\n').filter(|l| !l.trim().is_empty()) {
                match datafile::parse_json(line) {
                    Some(v) if datafile::to_text(&v, datafile::Layout::Compact) == line => {}
                    Some(v) => {
                        r.differ.push(format!("{rel}\n--- file {line}\n--- rust {}", datafile::to_text(&v, datafile::Layout::Compact)));
                        break;
                    }
                    None => {}
                }
            }
        } else if let Some(fmt) = rel.ends_with(".json").then(|| format_of(&rel)).flatten() {
            let raw = std::fs::read_to_string(&path).unwrap_or_default();
            r.checked += 1;
            match datafile::parse_json(&raw) {
                Some(v) if datafile::render(&v, fmt) == raw => {}
                Some(v) => r.differ.push(format!("{rel}\n--- file\n{raw}\n--- rust\n{}", datafile::render(&v, fmt))),
                None => r.unreadable.push(rel),
            }
        }
    }
    r
}

#[test]
fn bun_written_folder_round_trips_byte_for_byte() {
    let home = data().join("home");
    let r = round_trip(&home, u64::MAX);
    assert!(r.differ.is_empty(), "{}", r.differ.join("\n\n"));
    assert!(r.unreadable.is_empty(), "{:?}", r.unreadable);
    assert!(r.checked >= 15, "only {} files checked", r.checked);
    // Each kind the fixture has, read through the typed helpers.
    let d = ckanban_core::DataDir::new(&home);
    let ids: Vec<String> = std::fs::read_dir(d.tickets_dir("demo")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    for id in &ids {
        let t = ticket::read(&d.ticket_file("demo", id)).unwrap().unwrap().unwrap();
        assert_eq!(t.id(), Some(id.as_str()));
    }
    assert_eq!(jsonl::read_file_page(&d.schedule_history("demo", "q8w3n2xk"), None, None).unwrap().entries.len(), 2);
    let mut tail = jsonl::Tail::default();
    tail.read(&d.huddle_messages("demo", "h_4f2kq9zb")).unwrap();
    assert_eq!(tail.entries[0]["mentions"][0], "qa-1");
}

#[test]
fn rust_writes_what_bun_wrote() {
    // Written again through the library's own writers into a temp folder: same bytes as Bun's.
    let home = data().join("home");
    let out = std::env::temp_dir().join(format!("ckrs-data-{}", ckanban_core::atomic::new_id()));
    let mut files = Vec::new();
    walk(&home, &home, &mut files);
    for rel in &files {
        let src = home.join(rel);
        let dst = out.join(rel);
        let raw = std::fs::read_to_string(&src).unwrap();
        if rel.ends_with("/ticket.md") {
            ticket::write(&dst, &ticket::parse(&raw).unwrap()).unwrap();
        } else if rel.ends_with(".jsonl") {
            std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
            for v in jsonl::read_all(&src).unwrap() {
                jsonl::append(&dst, &v).unwrap();
            }
        } else if let Some(fmt) = format_of(rel) {
            datafile::write_json(&dst, &datafile::read_json(&src).unwrap().unwrap(), fmt).unwrap();
        } else {
            continue;
        }
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), raw, "{rel}");
    }
    let _ = std::fs::remove_dir_all(out);
}

#[test]
#[ignore = "reads a real data folder: set CKANBAN_PARITY_HOME"]
fn real_board_round_trip() {
    let home = PathBuf::from(std::env::var("CKANBAN_PARITY_HOME").expect("CKANBAN_PARITY_HOME"));
    // Run logs can be tens of MB: lines of logs up to 2 MB are checked.
    let r = round_trip(&home, 2 * 1024 * 1024);
    println!("checked {} files; {} differ; {} unreadable; {} old add-on tickets (rewritten on load, as in Bun)", r.checked, r.differ.len(), r.unreadable.len(), r.migrated);
    for u in r.unreadable.iter().take(20) {
        println!("unreadable: {u}");
    }
    for d in &r.differ {
        println!("differs: {}", d.lines().next().unwrap_or(""));
    }
    for d in r.differ.iter().take(3) {
        println!("DIFFER {d}\n");
    }
    assert!(r.differ.is_empty());
}
