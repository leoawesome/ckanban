//! The R2b family rules, plan engine and feature status against Bun's answers (`tests/fixtures/families.json`,
//! written by `test/rust-board-families-fixtures.test.ts`): every case's output, as JSON text, must equal Bun's.

use std::sync::Arc;

use ckanban_board::families::plan::{children, family_sig, finished_line, plan_problem, plan_step, progress_step, wake_table};
use ckanban_board::families::rules::{Moved, fit_parent, is_feature, level_of, link_problem, next_round_title};
use ckanban_board::families::status::{SubFacts, apply_patch, clip_text, status_facts, status_markdown};
use ckanban_board::index::store::BoardList;
use ckanban_board::index::ticket::Tk;
use serde_json::{Map, Value, json};

fn doc() -> Value {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/families.json")).expect("fixture file");
    ckanban_board::runs::js::parse(&text).expect("fixture JSON")
}

fn tks(v: &Value) -> Vec<Arc<Tk>> {
    v.as_array().unwrap().iter().map(|t| Arc::new(Tk::from_json(t.as_object().unwrap().clone(), false))).collect()
}

fn board() -> BoardList {
    BoardList::new("b", tks(&doc()["board"]), 1)
}

/// JSON text as `JSON.stringify` writes it (`undefined` for None).
fn j(v: Option<Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => ckanban_board::runs::js::stringify(&v),
    }
}

fn check(group: &str, f: impl Fn(&Value) -> String) {
    let d = doc();
    let cases = d["groups"][group].as_array().unwrap_or_else(|| panic!("group {group}"));
    assert!(!cases.is_empty());
    let bad: Vec<String> = cases
        .iter()
        .filter_map(|c| {
            let got = f(c);
            let want = c["expect"].as_str().unwrap();
            (got != want).then(|| format!("{c}\n  rust: {got}\n  bun:  {want}"))
        })
        .collect();
    assert!(bad.is_empty(), "{} of {} {group} cases differ:\n{}", bad.len(), cases.len(), bad.join("\n"));
}

fn s(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

#[test]
fn link_problem_cases() {
    let b = board();
    check("linkProblem", |c| {
        let m = &c["moved"];
        let moved = Moved { id: m["id"].as_str().unwrap(), title: m["title"].as_str().unwrap(), main: m["main"].as_bool() };
        j(Some(link_problem(&b, &moved, c["parent"].as_str().unwrap(), c["subtree"] == true).map(Value::from).unwrap_or(Value::Null)))
    });
}

#[test]
fn levels_fits_rounds_features() {
    let b = board();
    check("fitParent", |c| j(Some(fit_parent(&b, c["id"].as_str().unwrap()).into())));
    check("levelOf", |c| j(Some(level_of(&b, c["id"].as_str().unwrap()).into())));
    check("nextRoundTitle", |c| j(Some(next_round_title(&b, c["top"].as_str()).into())));
    check("isFeature", |c| j(Some(is_feature(&b, b.get(c["id"].as_str().unwrap()).unwrap()).into())));
}

#[test]
fn sig_table_lines_progress() {
    let b = board();
    check("familySig", |c| {
        let top = c["top"].as_str().unwrap();
        let rows = b.tickets.iter().filter(|t| t.id == top || t.part_of.as_deref() == Some(top) || t.parent_id.as_deref() == Some(top)).map(|t| &**t);
        j(Some(family_sig(rows).into()))
    });
    check("wakeTable", |c| {
        let p = c["parent"].as_str().unwrap();
        let mut kids = children(&b, p);
        kids.extend(b.tickets.iter().filter(|t| t.part_of.as_deref() == Some(p) && t.parent_id.is_none()).cloned());
        let running: Vec<String> = c["running"].as_array().unwrap().iter().filter_map(s).collect();
        j(Some(wake_table(&kids, &b, &|id| running.iter().any(|r| r == id)).into()))
    });
    check("finishedLine", |c| {
        let t = b.get(c["id"].as_str().unwrap()).unwrap();
        j(Some(finished_line(t, c["summary"].as_str().unwrap(), c["report"].as_str()).into()))
    });
    check("progressStep", |c| {
        let (sig, n, stuck) = progress_step(c["plan"].as_object().unwrap(), c["sig"].as_str().unwrap());
        j(Some(json!({ "progressSig": sig, "noProgress": ckanban_core::jsnum::num(n), "stuck": stuck })))
    });
}

#[test]
fn plans() {
    check("planProblem", |c| j(Some(plan_problem(&tks(&c["kids"])).map(Value::from).unwrap_or(Value::Null))));
    check("planStep", |c| {
        let kids = tks(&c["kids"]);
        let running: Vec<String> = c["running"].as_array().unwrap().iter().filter_map(s).collect();
        let st = plan_step(
            c["plan"].as_object().unwrap(),
            &kids,
            &|id| running.iter().any(|r| r == id),
            &|t| s(&c["waiting"][&t.id]),
            &|t| s(&c["summary"][&t.id]).unwrap_or_default(),
            &|_| None,
        );
        let events: Vec<Value> = st.events.iter().map(|e| json!({ "childId": e.child_id, "sig": e.sig, "line": e.line, "result": e.result })).collect();
        let wait: Vec<Value> = st.user_wait.iter().map(|(id, reason)| json!({ "id": id, "reason": reason })).collect();
        j(Some(json!({
            "start": st.start, "events": events, "allComplete": st.all_complete, "active": st.active,
            "awaitingMerge": st.awaiting_merge, "deadEnd": st.dead_end, "userWait": wait,
        })))
    });
}

#[test]
fn status() {
    check("clipText", |c| j(Some(clip_text(c["s"].as_str().unwrap(), c["max"].as_u64().unwrap() as usize).into())));
    check("applyPatch", |c| {
        let patch: Vec<(String, Option<String>)> =
            c["patch"].as_object().unwrap().iter().filter(|(k, _)| *k != "prNotes").map(|(k, v)| (k.clone(), s(v))).collect();
        let notes: Option<Vec<(String, Option<String>)>> = c["patch"]["prNotes"].as_object().map(|n| n.iter().map(|(k, v)| (k.clone(), s(v))).collect());
        j(Some(Value::Object(apply_patch(c["saved"].as_object().cloned(), &patch, notes.as_deref(), "NOW", "SIG"))))
    });
    let b = board();
    check("status", |c| {
        let top = c["top"].as_str().unwrap();
        let needs: Vec<String> = c["needsYou"].as_array().unwrap().iter().filter_map(s).collect();
        let notes = c["prNotes"].as_object().cloned().unwrap_or_default();
        let subs = c["subs"].clone();
        let f = status_facts(&b, top, &|t| needs.contains(&t.id), &notes, &|t| SubFacts {
            working: subs[&t.id]["working"] == true,
            headline: s(&subs[&t.id]["headline"]),
        });
        let saved: Option<Map<String, Value>> = c["saved"].as_object().cloned();
        let t = b.get(top).unwrap();
        let md = status_markdown(&t.id, &t.title, saved.as_ref(), &f);
        j(Some(json!({ "facts": f, "markdown": md })))
    });
}
