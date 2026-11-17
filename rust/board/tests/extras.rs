//! R12 parity: every case of the extras fixture table (`tests/fixtures/extras.json`, written by Bun's
//! `test/rust-extras-fixtures.test.ts`) gives Bun's answer in Rust, as the same JSON text.

use std::sync::Arc;

use ckanban_board::extras::learn::{self, Corrections, Learned, TidyNote};
use ckanban_board::extras::linker::{self, LinkTicket};
use ckanban_board::extras::recall::{self, RecallQuery, RecallRow, RecallTicket};
use ckanban_board::extras::{lessons, mockups, usage};
use ckanban_board::team::notes::Note;
use ckanban_core::datafile::{to_text, Layout};
use serde_json::{json, Map, Value};

fn st(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}
fn opt(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(String::from)
}
fn map(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}
fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn strs(v: &Value) -> Vec<String> {
    arr(v).iter().map(st).collect()
}
fn note(v: &Value) -> Note {
    Note { text: st(&v["text"]), by: st(&v["by"]), date: v["date"].as_str().map(String::from), huddle: v["huddle"].as_str().map(String::from) }
}
fn notes(v: &Value) -> Vec<Note> {
    arr(v).iter().map(note).collect()
}
fn corrections(v: &Value) -> Corrections {
    Corrections {
        messages: arr(&v["messages"]),
        reopened: v["reopened"].as_bool().unwrap_or(false),
        changes_requested: v["changesRequested"].as_bool().unwrap_or(false),
        follow_ups: arr(&v["followUps"]).iter().map(|f| (st(&f["id"]), st(&f["title"]))).collect(),
    }
}
fn learned(v: &Value) -> Learned {
    Learned { text: st(&v["text"]), r#match: opt(&v["match"]), standing: opt(&v["standing"]), evidence: st(&v["evidence"]), mistake: st(&v["mistake"]) }
}
fn link_ticket(v: &Value) -> LinkTicket {
    LinkTicket {
        id: st(&v["id"]),
        title: st(&v["title"]),
        body: st(&v["body"]),
        status: st(&v["status"]),
        updated_at: st(&v["updatedAt"]),
        part_of: opt(&v["partOf"]),
        part_of_chat: v["partOfVia"].as_str() == Some("chat"),
        parent_id: opt(&v["parentId"]),
    }
}
fn rows(v: &Value) -> Vec<RecallRow> {
    arr(v).iter().map(|r| RecallRow { ticket: RecallTicket::of(&map(&r["ticket"])), summary: r["summary"].as_str().map(String::from) }).collect()
}
fn notes_json(ns: &[Note]) -> Value {
    serde_json::to_value(ns).unwrap()
}
fn ticket_run(v: &Value) -> usage::TicketRun {
    usage::TicketRun {
        run: v["run"].clone(),
        kind: v["kind"].clone(),
        started_at: v["startedAt"].clone(),
        model: opt(&v["model"]),
        tokens: v["tokens"].as_f64().unwrap_or(0.0),
        cost_usd: v["costUsd"].as_f64().unwrap_or(0.0),
        parts: arr(&v["parts"]).iter().map(|p| (st(&p["at"]), p["cost"].as_f64().unwrap_or(0.0))).collect(),
    }
}
fn ms(s: &str) -> f64 {
    ckanban_core::time::parse_date(s).unwrap()
}

fn tidy_run(files: &Value, answer: &str, roles: &[String]) -> Value {
    let mut uid = 0;
    let mut f: learn::Files = Vec::new();
    for (role, ns) in files.as_object().unwrap() {
        f.push((role.clone(), notes(ns).into_iter().map(|n| {
            uid += 1;
            (uid, n)
        }).collect()));
    }
    let list: Vec<TidyNote> = f.iter().flat_map(|(r, ns)| ns.iter().map(move |(u, n)| TidyNote { role: r.clone(), note: n.clone(), uid: *u })).collect();
    let ops = learn::parse_tidy(answer, &list, roles);
    let mut cur = f;
    let mut steps = Vec::new();
    for op in ops.clone().unwrap_or_default() {
        cur = learn::apply_tidy_op(&cur, &op, &list, "2026-11-17", &mut uid);
        steps.push(Value::Object(cur.iter().map(|(r, ns)| (r.clone(), notes_json(&ns.iter().map(|(_, n)| n.clone()).collect::<Vec<_>>()))).collect()));
    }
    json!({ "ops": ops.map(|o| o.iter().map(|x| x.to_json()).collect::<Vec<_>>()), "steps": steps })
}

fn run(f: &str, a: &[Value]) -> Value {
    let n = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    match f {
        "correctionKeys" => json!(learn::correction_keys(&corrections(&a[0]))),
        "newCorrections" => learn::new_corrections(&corrections(&a[0]), &strs(&a[1])).to_json(),
        "ticketKey" => {
            let chain: Vec<(String, Option<String>)> = arr(&a[2]).iter().map(|t| (st(&t["id"]), opt(&t["madeFrom"]))).collect();
            json!(learn::ticket_key(&st(&a[0]), &st(&a[1]["id"]), a[1]["madeFrom"].as_str(), &chain))
        }
        "shortlist" => json!(learn::shortlist(&a[0], &st(&a[1]), &a[2], &st(&a[3]), a[4].as_u64().unwrap() as usize).iter().map(|c| c["id"].clone()).collect::<Vec<_>>()),
        "shouldPromote" => json!(learn::should_promote(&a[0])),
        "addToPile" => {
            let mut pile = a[0].clone();
            let o = &a[2];
            let mut k = 0;
            let mut id = || {
                k += 1;
                format!("c{k}")
            };
            let i = learn::add_to_pile(&mut pile, &learned(&a[1]), &st(&o["kind"]), &o["dest"], &o["source"], o["userText"].as_str(), &mut id);
            let id = learn::candidates(&pile)[i]["id"].clone();
            json!({ "pile": pile, "id": id })
        }
        "prune" => {
            let mut pile = a[0].clone();
            learn::prune(&mut pile, a[1].as_f64().unwrap(), a[2].as_u64().unwrap() as usize);
            pile
        }
        "serializeRules" => json!(learn::serialize_rules(&notes(&a[0]))),
        "rulesBlock" => json!(learn::rules_block(&notes(&a[0]))),
        "shiftNotes" => notes_json(&learn::shift_notes(&notes(&a[0]), a[1].as_str(), a[2].as_str())),
        "parseLearned" => {
            let o = n(2);
            let max = o["max"].as_u64().unwrap_or(3) as usize;
            let keep = o["keepEmpty"].as_bool().unwrap_or(false);
            learn::parse_learned(&st(&a[0]), &strs(&a[1]), max, keep).map_or(Value::Null, |v| json!(v.iter().map(Learned::to_json).collect::<Vec<_>>()))
        }
        "tidyRun" => tidy_run(&a[0], &st(&a[1]), &strs(&a[2])),
        "pileText" => json!(learn::pile_text(&arr(&a[0]))),
        "huddleLearnPrompt" => {
            let ls: Vec<(String, String)> = arr(&a[1]).iter().map(|l| (st(&l["text"]), st(&l["evidence"]))).collect();
            json!(learn::huddle_learn_prompt(&st(&a[0]), &ls, &arr(&a[2])))
        }
        "tidyPrompt" => {
            let list: Vec<TidyNote> = arr(&a[0]).iter().enumerate().map(|(i, x)| TidyNote { role: st(&x["role"]), note: note(&x["note"]), uid: i }).collect();
            json!(learn::tidy_prompt(&list, &strs(&a[1])))
        }
        "texts" => json!({
            "learn": *learn::LEARN_SYSTEM, "huddle": *learn::HUDDLE_LEARN_SYSTEM, "tidy": *learn::TIDY_SYSTEM,
            "suggest": linker::SUGGEST_SYSTEM, "find": linker::FIND_SYSTEM,
        }),
        "corrections" => {
            let ts: Vec<Map<String, Value>> = arr(&a[2]).iter().map(map).collect();
            let refs: Vec<&Map<String, Value>> = ts.iter().collect();
            lessons::corrections(&map(&a[0]), &arr(&a[1]), &refs).to_json()
        }
        "lessonsPrompt" => {
            let i = &a[0];
            json!(lessons::lessons_prompt(&map(&i["ticket"]), &arr(&i["entries"]), &corrections(&i["corrections"]), &strs(&i["existing"])))
        }
        "lessonBullets" => json!(lessons::lesson_bullets(&st(&a[0]))),
        "transcript" => json!(lessons::transcript(&arr(&a[0]))),
        "candidates" => {
            let ts = arr(&a[0]).iter().map(link_ticket).collect();
            json!(linker::candidates(ts, a[1].as_f64().unwrap()).iter().map(|t| t.id.clone()).collect::<Vec<_>>())
        }
        "suggestPrompt" => json!(linker::suggest_prompt(&link_ticket(&a[0]), &arr(&a[1]).iter().map(link_ticket).collect::<Vec<_>>())),
        "parseSuggestion" => linker::parse_suggestion(&st(&a[0]), &strs(&a[1])).map_or(Value::Null, |(id, reason)| json!({ "id": id, "reason": reason })),
        "findPrompt" => json!(linker::find_prompt(&arr(&a[0]).iter().map(link_ticket).collect::<Vec<_>>())),
        "parseFound" => linker::parse_found(&st(&a[0]), &arr(&a[1]).iter().map(link_ticket).collect::<Vec<_>>()).map_or(Value::Null, Value::Array),
        "words" => json!(recall::words(&st(&a[0]))),
        "recallBlock" => json!(recall::recall_block(&RecallQuery::of(&map(&a[0])), &rows(&a[1]))),
        "pickRelated" => json!(recall::pick_related(&RecallQuery::of(&map(&a[0])), &rows(&a[1])).iter().map(|r| r.ticket.id.clone()).collect::<Vec<_>>()),
        "extractMockups" => json!(mockups::extract_mockups(&st(&a[0])).iter().map(|m| json!({ "name": m.name, "html": m.html })).collect::<Vec<_>>()),
        "ticketRuns" => json!(usage::ticket_runs(&arr(&a[0])).iter().map(|r| r.to_json()).collect::<Vec<_>>()),
        "windowsNeeded" => {
            let runs: Vec<usage::TicketRun> = arr(&a[0]).iter().map(ticket_run).collect();
            json!(usage::windows_needed(&runs, &arr(&a[1]), a[2].as_f64().unwrap()))
        }
        "ticketUsage" => {
            let i = &a[0];
            let windows = arr(&i["windows"]);
            let machine = |w: usize| {
                let k = format!("{}-{}", ms(&st(&windows[w]["start"])) as i64, ms(&st(&windows[w]["end"])) as i64);
                a[1][&k].as_f64().unwrap_or(0.0)
            };
            usage::ticket_usage(&arr(&i["activity"]), &windows, &machine, i["now"].as_f64().unwrap(), i["windowError"].as_str(), &i["teammates"], i["side"].as_f64().unwrap_or(0.0))
        }
        "huddleUsage" => {
            let input: Vec<(String, Arc<Value>, Option<String>)> = arr(&a[0]).iter().map(|x| (st(&x["board"]), Arc::new(x["huddle"].clone()), x["title"].as_str().map(String::from))).collect();
            usage::huddle_usage(&input)
        }
        "teammateSpend" => {
            let hs: Vec<Arc<Value>> = arr(&a[0]).into_iter().map(Arc::new).collect();
            usage::teammate_spend(&hs, &st(&a[1]))
        }
        other => panic!("no case for {other}"),
    }
}

fn text(v: &Value) -> String {
    to_text(&ckanban_core::jsnum::normalize(v.clone()), Layout::Compact)
}

#[test]
fn extras_match_bun() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/extras.json")).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&raw).unwrap();
    let mut bad = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        let f = c["fn"].as_str().unwrap();
        let got = run(f, c["args"].as_array().unwrap());
        let (want, have) = (text(&c["json"]), text(&got));
        if want != have {
            bad.push(format!("#{i} {f}\n  bun:  {want}\n  rust: {have}"));
        }
    }
    assert!(bad.is_empty(), "{} of {} cases differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}
