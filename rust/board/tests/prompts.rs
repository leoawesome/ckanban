//! R4 parity: every case of the prompt fixture table (`tests/fixtures/prompts.json`, written by Bun's
//! `test/rust-prompt-fixtures.test.ts`) gives the same bytes in Rust. Text answers are compared by SHA-1 and length;
//! on a mismatch the Rust text is written to `target/prompt-fixtures/<case number>.txt`, to diff with Bun's
//! (`DUMP_PROMPTS=<dir> bun test test/rust-prompt-fixtures.test.ts`).
//!
//! One test function on purpose: it sets TZ for the whole process before anything reads local time.

use std::path::{Path, PathBuf};

use ckanban_board::prompts::{self as p, deps, question_forms as q, types::*};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

fn arg<T: DeserializeOwned>(args: &[Value], i: usize) -> T {
    serde_json::from_value(args.get(i).cloned().unwrap_or(Value::Null)).unwrap_or_else(|e| panic!("argument {i}: {e}"))
}
fn opt<T: DeserializeOwned>(args: &[Value], i: usize) -> Option<T> {
    arg::<Option<T>>(args, i)
}
fn s(args: &[Value], i: usize) -> String {
    arg(args, i)
}
fn b(args: &[Value], i: usize) -> bool {
    opt::<bool>(args, i).unwrap_or(false)
}

fn constant(name: &str) -> String {
    match name {
        "RESULT_RULE" => p::RESULT_RULE.into(),
        "URGENCY_RULE" => p::URGENCY_RULE.into(),
        "QUESTIONS_FORMAT" => p::QUESTIONS_FORMAT.clone(),
        "TICKET_FORMAT" => p::TICKET_FORMAT.clone(),
        "SPLIT_RULE" => p::SPLIT_RULE.clone(),
        "REVIEW_HUDDLE_FORMAT" => p::REVIEW_HUDDLE_FORMAT.clone(),
        "TEAMMATE_FORMAT" => p::TEAMMATE_FORMAT.clone(),
        "SQUAD_FORMAT" => p::SQUAD_FORMAT.clone(),
        "BRANCH_FORMAT" => p::BRANCH_FORMAT.clone(),
        "CHROME_RULE" => p::CHROME_RULE.into(),
        "OUTBOUND_RULE" => p::OUTBOUND_RULE.into(),
        "NOTIFY_USER_RULE" => p::NOTIFY_USER_RULE.clone(),
        "JOB_RULE" => p::JOB_RULE.into(),
        "HELPER_RULE_RULE" => p::HELPER_RULE_RULE.into(),
        "SCHEDULES_RULE" => p::SCHEDULES_RULE.into(),
        "FEATURE_RULE" => p::FEATURE_RULE.into(),
        "NEW_MAIN_RULE" => p::NEW_MAIN_RULE.into(),
        "BOARD_RULE" => p::BOARD_RULE.clone(),
        "FOLLOW_UP_RULE" => p::FOLLOW_UP_RULE.clone(),
        "LENGTH_RULE" => p::LENGTH_RULE.into(),
        "WRITING_RULE" => p::WRITING_RULE.clone(),
        "REPLY_RULE" => p::REPLY_RULE.clone(),
        "KEYS_RULE" => p::KEYS_RULE.into(),
        "PLAIN_WORDS" => p::PLAIN_WORDS.clone(),
        "CHAT_PLAIN_WORDS" => p::CHAT_PLAIN_WORDS.clone(),
        "NEUTRAL_BRIEF" => p::NEUTRAL_BRIEF.into(),
        "HUDDLE_NOW_RULE" => p::HUDDLE_NOW_RULE.clone(),
        "INTERVIEW" => p::INTERVIEW.clone(),
        "AFTER_ANSWERS" => p::AFTER_ANSWERS.clone(),
        "FILE_LINK_RULE" => p::FILE_LINK_RULE.into(),
        "PLANNING_ARTIFACT_RULE" => p::PLANNING_ARTIFACT_RULE.into(),
        "SELF_MOVE_RULE" => p::SELF_MOVE_RULE.into(),
        "MAIN_QUESTIONS_RULE" => p::MAIN_QUESTIONS_RULE.into(),
        "AUTOMATION_SETUP" => p::AUTOMATION_SETUP.into(),
        "GO_AHEAD_RULE" => p::GO_AHEAD_RULE.into(),
        "OFF_TOPIC_RULE" => p::OFF_TOPIC_RULE.into(),
        "PLANNING_GO_AHEAD_RULE" => p::PLANNING_GO_AHEAD_RULE.into(),
        "PUSHBACK_RULE" => p::PUSHBACK_RULE.into(),
        "MAIN_FIRST_REPLY" => p::MAIN_FIRST_REPLY.into(),
        "MAIN_PLANNING" => p::MAIN_PLANNING.into(),
        "MAIN_GO_AHEAD" => p::MAIN_GO_AHEAD.into(),
        "MAIN_PAUSED" => p::MAIN_PAUSED.into(),
        "PLAN_FINDINGS_RULE" => p::PLAN_FINDINGS_RULE.into(),
        other => panic!("no constant {other}"),
    }
}

/// Bun's `undefined`/`null` both read as None; a string answer as Text, anything else as JSON.
enum Out {
    Text(String),
    Json(Value),
}

fn ms(iso: &str) -> f64 {
    chrono::DateTime::parse_from_rfc3339(iso).expect("time").timestamp_millis() as f64
}

fn call(f: &str, a: &[Value]) -> Out {
    use Out::*;
    let ticket = |i| arg::<Ticket>(a, i);
    Text(match f {
        "const" => constant(&s(a, 0)),
        "context" => {
            let attrs: Vec<(String, String)> = opt::<serde_json::Map<String, Value>>(a, 2)
                .unwrap_or_default()
                .into_iter()
                .map(|(k, v)| (k, v.as_str().unwrap_or_default().to_string()))
                .collect();
            let refs: Vec<(&str, String)> = attrs.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
            p::context(&s(a, 0), &s(a, 1), &refs)
        }
        "landRule" => p::land_rule(&s(a, 0), b(a, 1), b(a, 2), opt::<Home>(a, 3).as_ref()),
        "whereRule" => p::where_rule(&ticket(0), &s(a, 1), b(a, 2), b(a, 3)),
        "autoHuddleRule" => p::auto_huddle_rule(&ticket(0), &opt::<String>(a, 1).unwrap_or_else(|| "remote".into())),
        "wakeSummary" => p::wake_summary(&s(a, 0), arg(a, 1), b(a, 2)),
        "mentionsArtifact" => {
            let texts: Vec<Option<String>> = a.iter().map(|v| v.as_str().map(str::to_string)).collect();
            let refs: Vec<Option<&str>> = texts.iter().map(|t| t.as_deref()).collect();
            return Json(json!(p::mentions_artifact(&refs)));
        }
        "chromeTurnNote" => p::chrome_turn_note(&s(a, 0)),
        "toolsChangedNote" => p::tools_changed_note(),
        "artifactRule" => p::artifact_rule(b(a, 0)),
        "deliverableRule" => p::deliverable_rule(&s(a, 0)),
        "reviewFileRule" => p::review_file_rule(&s(a, 0)),
        "mockupsRule" => p::mockups_rule(&s(a, 0)),
        "targetDesignRule" => p::target_design_rule(&s(a, 0)),
        "sourceNote" => p::source_note(&ticket(0)),
        "bugReportRule" => p::bug_report_rule(&ticket(0)),
        "setupNote" => p::setup_note(&s(a, 0), &s(a, 1)),
        "chatNotes" => p::chat_notes(&arg::<Vec<Comment>>(a, 0)),
        "interruptedPrompt" => p::interrupted_prompt(),
        "steerPrompt" => p::steer_prompt(&s(a, 0)),
        "quietSection" => p::quiet_section(&arg(a, 0)),
        "chromeChoiceNote" => {
            let board: Vec<BoardBrowserChoice> = opt(a, 1).unwrap_or_default();
            match p::chrome_choice_note(opt::<ChromeChoice>(a, 0).as_ref(), &board) {
                Some(t) => t,
                None => return Json(Value::Null),
            }
        }
        "devicesNote" => match p::devices_note(&arg::<Vec<Device>>(a, 0), &opt::<Vec<String>>(a, 1).unwrap_or_default()) {
            Some(t) => t,
            None => return Json(Value::Null),
        },
        "firstRunPrompt" => p::first_run_prompt(&ticket(0), &arg(a, 1)),
        "withoutChromeRule+firstRunPrompt" => p::without_chrome_rule(&p::first_run_prompt(&ticket(0), &arg(a, 1))),
        "resumePrompt" => p::resume_prompt(
            &ticket(0),
            &arg::<Vec<Comment>>(a, 1),
            &s(a, 2),
            b(a, 3),
            b(a, 4),
            &opt::<String>(a, 5).unwrap_or_else(|| "remote".into()),
            b(a, 6),
            opt::<Home>(a, 7).as_ref(),
            opt::<RunRole>(a, 8).as_ref(),
        ),
        "freshSessionPrompt" => p::fresh_session_prompt(&ticket(0), &arg(a, 1)),
        "freshChatNote" => {
            p::fresh_chat_note(&ticket(0), opt::<String>(a, 1).as_deref(), &arg::<Vec<Comment>>(a, 2), opt::<FreshFeature>(a, 3).as_ref())
        }
        "chatPrompt" => p::chat_prompt(
            &ticket(0),
            &s(a, 1),
            &s(a, 2),
            &s(a, 3),
            b(a, 4),
            &opt::<String>(a, 5).unwrap_or_else(|| "remote".into()),
            b(a, 6),
            &opt::<String>(a, 7).unwrap_or_default(),
            opt::<RunRole>(a, 8).as_ref(),
            opt::<FollowUpPlace>(a, 9).as_ref(),
        ),
        "followUpRule" => p::follow_up_rule(&ticket(0), opt::<FollowUpPlace>(a, 1).as_ref()),
        "followUpWakePrompt" => p::follow_up_wake_prompt(&ticket(0), ms(&s(a, 1)), b(a, 2)),
        "featureMainNote" => p::feature_main_note(&s(a, 0)),
        "featureMemberNote" => {
            let top: IdTitle = arg(a, 0);
            p::feature_member_note(&top.id, &top.title, &s(a, 1))
        }
        "featureTrailerRule" => p::feature_trailer_rule(&s(a, 0)),
        "statusNotesBlock" => p::status_notes_block(&arg::<Vec<p::StatusNote>>(a, 0)),
        "statusNudgePrompt" => p::status_nudge_prompt(&s(a, 0), &arg::<Vec<String>>(a, 1), &opt::<Vec<Question>>(a, 2).unwrap_or_default()),
        "openQuestionsRule" => p::open_questions_rule(&arg::<Vec<Question>>(a, 0)),
        "planningPrompt" => p::planning_prompt(&ticket(0), &s(a, 1)),
        "resumeCommand" => p::resume_command(&s(a, 0), &s(a, 1)),
        "planningCommand" => p::planning_command(&s(a, 0), &s(a, 1), &s(a, 2), b(a, 3)),
        "mainPlannedRule" => p::main_planned_rule(&s(a, 0)),
        "mainTicketRules" => p::main_ticket_rules(&arg(a, 0)),
        "mainWhere" => p::main_where(&arg(a, 0)),
        "mainChatRules" => p::main_chat_rules(&ticket(0), &arg(a, 1), &s(a, 2)),
        "toolHeader" => p::tool_header(&arg(a, 0)),
        "toolRules" => p::tool_rules(&arg(a, 0)),
        "toolChatPrompt" => p::tool_chat_prompt(&ticket(0), &s(a, 1), &arg(a, 2)),
        "toolFirstPrompt" => p::tool_first_prompt(&ticket(0), &arg(a, 1), &arg(a, 2)),
        "automationNote" => p::automation_note(&s(a, 0)),
        "mainWakePrompt" => p::main_wake_prompt(&ticket(0), &arg(a, 1)),
        "huddleDigest" => p::huddle_digest(&arg::<Vec<HuddleMessage>>(a, 0), arg(a, 1), opt::<Brief>(a, 2).as_ref()),
        "briefBlock" => p::brief_block(opt::<Brief>(a, 0).as_ref()),
        "hostDescription" => p::host_description(&opt::<String>(a, 0).unwrap_or_default()),
        "huddleAgentSystemPrompt" => p::huddle_agent_system_prompt(
            &arg(a, 0),
            &arg(a, 1),
            &ticket(2),
            &s(a, 3),
            &s(a, 4),
            opt::<String>(a, 5).as_deref(),
            &opt::<String>(a, 6).unwrap_or_default(),
            opt::<String>(a, 7).as_deref(),
            opt::<String>(a, 8).as_deref(),
        ),
        "huddleAgentPrompt" => p::huddle_agent_prompt(&s(a, 0), &arg(a, 1), &s(a, 2), b(a, 3), opt::<Snapshot>(a, 4).as_ref()),
        "huddleMainPrompt" => p::huddle_main_prompt(&arg(a, 0), &arg(a, 1), &s(a, 2), opt::<bool>(a, 3).unwrap_or(true), b(a, 4)),
        "autoHuddleSlotPrompt" => p::auto_huddle_slot_prompt(&arg(a, 0)),
        "autoHuddleStoppedPrompt" => p::auto_huddle_stopped_prompt(&arg(a, 0), &s(a, 1), arg(a, 2)),
        "squadHostRules" => p::squad_host_rules(&arg(a, 0), &ticket(1)),
        "signature" => q::signature(&arg::<Vec<Question>>(a, 0)),
        "initial" => return Json(serde_json::to_value(q::initial(&arg(a, 0))).unwrap()),
        "fresh" => return Json(q::fresh(&arg::<Vec<Question>>(a, 0))),
        "startProgress" => return Json(q::start_progress(&arg::<Vec<Question>>(a, 0), a.get(1).filter(|v| !v.is_null()))),
        "formStates" => {
            let entries: Vec<q::FormEntry> = arg(a, 0);
            let states = q::form_states(&entries, b(a, 1), &arg::<Vec<String>>(a, 2), b(a, 3));
            return Json(Value::Array(states.into_iter().map(|(i, st)| json!([i, st])).collect()));
        }
        "answersMessage" => q::answers_message(&arg::<Vec<Question>>(a, 0), &arg::<Vec<q::Answer>>(a, 1), &opt::<String>(a, 2).unwrap_or_default()),
        "parseAnswers" => {
            let (answers, note) = q::parse_answers(&s(a, 0), &arg::<Vec<Question>>(a, 1));
            return Json(json!({ "answers": answers, "note": note }));
        }
        "answerText" => q::answer_text(&arg(a, 0)),
        "repeatsForm" => return Json(json!(q::repeats_form(&s(a, 0), &arg::<Vec<Question>>(a, 1)))),
        other => panic!("no function {other}"),
    })
}

fn sha1_hex(text: &str) -> String {
    Sha1::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn diff_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("target").join("prompt-fixtures")
}

#[test]
fn every_prompt_is_buns_bytes() {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prompts.json");
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).expect("fixture file")).expect("fixture JSON");
    // SAFETY: the only test in this binary, before any thread or local time read.
    unsafe { std::env::set_var("TZ", doc["tz"].as_str().expect("tz")) };
    deps::set_helper_command(doc["helper"].as_str().expect("helper"));
    let cases = doc["cases"].as_array().expect("cases");
    assert!(cases.len() > 700, "the table lost cases: {}", cases.len());
    let dir = diff_dir();
    let _ = std::fs::remove_dir_all(&dir);
    let mut failed = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let name = c["name"].as_str().unwrap_or("?");
        let out = tempfile::tempdir().expect("temp dir");
        let out_s = out.path().to_string_lossy().into_owned();
        if let Some(m) = c["mockups"].as_array() {
            std::fs::create_dir_all(out.path().join("mockups")).unwrap();
            for f in m {
                std::fs::write(out.path().join("mockups").join(f.as_str().unwrap()), "<html></html>").unwrap();
            }
        }
        let args: Value = serde_json::from_str(&c["args"].to_string().replace("@OUT@", &out_s)).unwrap();
        let got = call(c["fn"].as_str().unwrap(), args.as_array().unwrap());
        let ok = match got {
            Out::Text(t) => {
                let t = t.replace(&out_s, "@OUT@");
                let ok = c["sha1"].as_str() == Some(sha1_hex(&t).as_str()) && c["len"].as_u64() == Some(t.len() as u64);
                if !ok {
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(dir.join(format!("{i}.txt")), &t).unwrap();
                }
                ok
            }
            Out::Json(v) => {
                let want = c.get("json").cloned().unwrap_or(Value::Null);
                let ok = v == want;
                if !ok {
                    eprintln!("case {i} {name}: got {v} want {want}");
                }
                ok
            }
        };
        if !ok {
            failed.push(format!("{i} {name}"));
        }
    }
    assert!(
        failed.is_empty(),
        "{} of {} prompt cases differ from Bun (Rust texts in {}):\n{}",
        failed.len(),
        cases.len(),
        dir.display(),
        failed.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
}
