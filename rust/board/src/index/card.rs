//! What a main ticket's card shows of its family (`familyCard` in `src/board/main-ticket.ts`, `Board.familyCard`):
//! tool tickets and tasks counted, what works now, the waiting step and the one working line.

use std::collections::HashSet;

use ckanban_core::jsnum::{js_string, num};
use serde_json::{Map, Value, json};

use super::attention::{StepWait, step_name, step_wait};
use super::family::{family_below, family_state, feature_rows, group_summary, task_tally, working_in_family};
use super::store::BoardList;
use super::text::{clip, js_trim, squash_spaces};
use super::ticket::Tk;

fn or_null<'a>(v: Option<&'a Value>) -> Option<&'a Value> {
    v.filter(|x| !x.is_null())
}
fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(x) => x.to_string(),
    }
}

/// `runStartedAt ?? lastRunAt ?? updatedAt`.
fn started_at(t: &Tk) -> String {
    text(or_null(t.get("runStartedAt")).or(or_null(t.get("lastRunAt"))).or(t.get("updatedAt")))
}

fn is_group(t: &Tk) -> bool {
    matches!(t.kind.as_deref(), Some("group") | Some("round"))
}

fn line(text: String, tone: &str, until: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("text".into(), text.into());
    m.insert("tone".into(), tone.into());
    if let Some(u) = until {
        m.insert("until".into(), u);
    }
    Value::Object(m)
}

/// `Board.familyCard`: None unless `id` is a main ticket. cost: what the family spent so far (its main ticket and
/// everything below it), already rounded to cents.
pub fn family_card(list: &BoardList, id: &str, running: &dyn Fn(&str) -> bool, cost: f64) -> Option<Value> {
    let main = list.get(id)?;
    if !main.main {
        return None;
    }
    let rows = feature_rows(list, id);
    let (tasks_done, tasks) = task_tally(list, &rows);
    let family: Vec<usize> = rows.iter().map(|r| r.idx).filter(|&i| list.at(i).id != id).collect();
    let tools: Vec<usize> = family.iter().copied().filter(|&i| list.at(i).tool).collect();
    let mut pool = family.clone();
    let mut seen: HashSet<usize> = family.iter().copied().collect();
    for i in family_below(list, id) {
        if seen.insert(i) {
            pool.push(i);
        }
    }
    let run = |t: &Tk| running(&t.id);
    let working = working_in_family(list, &pool, id, &run);
    let newest_start = working.iter().map(|&i| started_at(list.at(i))).fold(String::new(), |m, s| if s > m { s } else { m });
    let seen_until = text(or_null(main.get("runEndedAt")));
    let mut waits: Vec<StepWait> = tools.iter().filter_map(|&i| step_wait(list.at(i), running(&list.at(i).id))).collect();
    waits.sort_by(|a, b| a.since.cmp(&b.since));
    let main_asks = !running(id) && (main.outcome_is("needs_input") || main.outcome_is("blocked") || main.plan_state() == Some("stuck"));
    let needs_you: Vec<&StepWait> = waits.iter().filter(|w| w.with_you).collect();
    let waiting = needs_you.first().copied().or_else(|| waits.iter().find(|w| w.since > seen_until)).or(if main_asks { waits.first() } else { None });
    let tone = |w: &StepWait| if w.attention == "failed" { "fail" } else { "warn" };
    let mut out_line: Option<Value> = waiting.map(|w| line(w.label.clone(), tone(w), None));
    let resting = main.status == "done" || (!tools.is_empty() && tools.iter().all(|&i| list.at(i).status == "done" && !running(&list.at(i).id)));
    if out_line.is_none() && !resting && main.plan_state() == Some("stuck") {
        let reason = main.get("plan").and_then(|p| or_null(p.get("reason"))).map(|r| text(Some(r))).unwrap_or_else(|| "no progress".into());
        out_line = Some(line(format!("Stuck: {}", clip(js_trim(&squash_spaces(&reason)), 140)), "warn", None));
    }
    if out_line.is_none() {
        if let Some(&s) = working.iter().find(|&&i| list.at(i).is("stalled")) {
            let t = list.at(s);
            let minutes = t.get("stalled").and_then(|x| x.get("minutes"));
            let m = match minutes {
                Some(Value::Number(n)) => n.as_f64().map(js_string).unwrap_or_default(),
                Some(v) => text(Some(v)),
                None => "undefined".into(),
            };
            out_line = Some(line(format!("Stuck: {} has had no output for {m} min", step_name(t)), "warn", None));
        }
    }
    if out_line.is_none() {
        if let Some(f) = waits.iter().filter(|w| w.attention != "questions" && w.since > newest_start).last() {
            out_line = Some(line(f.label.clone(), tone(f), None));
        }
    }
    if out_line.is_none() && !resting {
        let reset = |t: &Tk| t.get("limit").and_then(|l| l.get("resetAt")).cloned().unwrap_or(Value::Null);
        let auto = |t: &Tk| t.get("limit").and_then(|l| l.get("auto")).is_some_and(|a| ckanban_core::jsnum::truthy(Some(a)));
        let mut paused: Vec<usize> = tools
            .iter()
            .copied()
            .filter(|&i| {
                let t = list.at(i);
                t.outcome_is("limit") && auto(t) && t.status != "done" && !running(&t.id)
            })
            .collect();
        paused.sort_by(|&a, &b| text(Some(&reset(list.at(a)))).cmp(&text(Some(&reset(list.at(b))))));
        if let Some(&p) = paused.first() {
            out_line = Some(line("Paused: usage limit".into(), "warn", Some(reset(list.at(p)))));
        } else if main.outcome_is("limit") && auto(main) && !running(id) {
            out_line = Some(line("Paused: usage limit".into(), "warn", Some(reset(main))));
        }
    }
    if out_line.is_none() && !resting && main.plan_state() == Some("paused") {
        out_line = Some(line("Paused: new tasks wait until you press Resume".into(), "warn", None));
    }
    if out_line.is_none() && !working.is_empty() {
        let mut by_start = working.clone();
        by_start.sort_by_key(|&i| std::cmp::Reverse(started_at(list.at(i))));
        let top = list.at(by_start[0]);
        let group = if is_group(top) {
            Some(top)
        } else {
            match &top.parent_id {
                Some(p) if p != id => family.iter().map(|&i| list.at(i)).find(|g| &g.id == p && is_group(g)),
                _ => None,
            }
        };
        out_line = Some(match group {
            Some(g) => {
                let kids: Vec<&Tk> = list.tickets.iter().map(|t| &**t).filter(|c| c.parent_id.as_deref() == Some(g.id.as_str()) || c.part_of.as_deref() == Some(g.id.as_str())).collect();
                let states: Vec<(Option<&str>, &str)> = kids.iter().map(|c| (c.kind.as_deref(), family_state(c, running(&c.id), false))).collect();
                line(format!("{}: {}", g.title, group_summary(&states)), "work", None)
            }
            None => line(step_name(top), "work", None),
        });
    }
    let open = tools.iter().filter(|&&i| list.at(i).status != "done" || running(&list.at(i).id)).count();
    let names = |f: &dyn Fn(&Tk) -> bool| working.iter().map(|&i| list.at(i)).filter(|t| f(t)).map(step_name).collect::<Vec<_>>();
    let subs: Vec<Value> = family
        .iter()
        .map(|&i| list.at(i))
        .filter(|t| t.main)
        .map(|t| json!({ "id": t.id, "title": t.title, "working": working.iter().any(|&w| list.at(w).id == t.id) }))
        .collect();
    let mut m = Map::new();
    m.insert("tools".into(), tools.len().into());
    m.insert("open".into(), open.into());
    m.insert("toolsDone".into(), tools.iter().filter(|&&i| list.at(i).status == "done").count().into());
    m.insert("tasks".into(), tasks.into());
    m.insert("tasksDone".into(), tasks_done.into());
    m.insert("running".into(), names(&|t| t.tool).into());
    m.insert("working".into(), names(&|_| true).into());
    m.insert("costUsd".into(), num(cost));
    m.insert("line".into(), out_line.unwrap_or(Value::Null));
    m.insert("waiting".into(), waiting.map(StepWait::to_json).unwrap_or(Value::Null));
    m.insert("needsYou".into(), Value::Array(needs_you.iter().map(|w| w.to_json()).collect()));
    m.insert("subFeatures".into(), Value::Array(subs));
    m.insert("subFeaturesRunning".into(), working.iter().filter(|&&i| list.at(i).main).count().into());
    Some(Value::Object(m))
}

/// `familyWorking`: how many of a main ticket's family work now.
pub fn family_working(list: &BoardList, id: &str, running: &dyn Fn(&str) -> bool) -> usize {
    let below = family_below(list, id);
    working_in_family(list, &below, id, &|t| running(&t.id)).len()
}

/// `stepsRunning`: how many of a main ticket's steps (tool tickets) are running now.
pub fn steps_running(list: &BoardList, id: &str, running: &dyn Fn(&str) -> bool) -> usize {
    feature_rows(list, id).iter().map(|r| list.at(r.idx)).filter(|t| t.id != id && t.tool && running(&t.id)).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::family::tests::board;

    #[test]
    fn a_main_card() {
        let l = board(vec![
            json!({"id": "m", "title": "Main", "status": "review", "main": true, "createdAt": "1"}),
            json!({"id": "a", "title": "checkout", "kind": "test", "status": "done", "tool": true, "parentId": "m", "createdAt": "2"}),
            json!({"id": "b", "title": "Build it", "kind": "build", "status": "ready", "tool": true, "parentId": "m", "createdAt": "3", "updatedAt": "9"}),
        ]);
        let c = family_card(&l, "m", &|_| false, 1.5).unwrap();
        assert_eq!(c["tools"], 2);
        assert_eq!(c["tasks"], 2);
        assert_eq!(c["tasksDone"], 1);
        assert_eq!(c["working"], json!(["Build it"]));
        assert_eq!(c["line"], json!({"text": "Build it", "tone": "work"}));
        assert_eq!(c["costUsd"], json!(1.5));
        assert!(family_card(&l, "a", &|_| false, 0.0).is_none());
        assert_eq!(family_working(&l, "m", &|_| false), 1);
        assert_eq!(steps_running(&l, "m", &|x| x == "b"), 1);
    }
}
