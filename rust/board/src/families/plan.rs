//! The plan engine's pure decisions (`src/board/plan.ts`) and the main-ticket helpers the engine uses
//! (`src/board/main-ticket.ts`): what a running plan does next, a wake's family table, the "finished" line, the
//! no-progress count and the family's signature.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::git::pr::ticket_prs;
use crate::index::attention::{is_complete, plan_active};
use crate::index::family::{family_state, group_summary};
use crate::index::store::BoardList;
use crate::index::text::{clip, js_trim, squash_spaces};
use crate::index::ticket::Tk;
use crate::tickets::writer::resolve_deps;

/// Result cards kept per ticket.
pub const RESULTS_KEEP: usize = 60;
/// No-progress wakes in a row before a main ticket's plan is stuck.
pub const NO_PROGRESS_WAKES: f64 = 3.0;
/// The tool ticket's report, in its outputs folder.
pub const REPORT_FILE: &str = "report.md";

/// A value as a JS template literal shows it (`${v}`): undefined, null, numbers as JS writes them.
pub fn tpl(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => ckanban_core::jsnum::js_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { tpl(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `x ?? ""` for a field shown in text.
pub fn or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        v => tpl(v),
    }
}

/// `childrenOf`: a planner's children, oldest first.
pub fn children(list: &BoardList, planner: &str) -> Vec<Arc<Tk>> {
    crate::tickets::writer::children_of(list, planner).into_iter().cloned().collect()
}

/// `planProblem`: why a set of children can't be planned, or None when it can.
pub fn plan_problem(children: &[Arc<Tk>]) -> Option<String> {
    if children.is_empty() {
        return Some("this ticket has no tool tickets to run".into());
    }
    for t in children {
        let missing = resolve_deps(t, children).1;
        if !missing.is_empty() {
            let names: Vec<String> = missing.iter().map(|m| format!("\"{m}\"")).collect();
            return Some(format!("\"{}\" depends on unknown ticket {}", t.title, names.join(", ")));
        }
    }
    crate::tickets::writer::find_cycle(children).map(|c| format!("dependency cycle: {}", c.join(" → ")))
}

/// `resultWakesMain`: every result wakes the main ticket, except a schedule's or automation's task that just finished.
pub fn result_wakes_main(t: &Tk) -> bool {
    let loop_task = t.get("source").and_then(|s| s.get("loopId")).is_some_and(|v| ckanban_core::jsnum::truthy(Some(v)));
    if !t.is("scheduleId") && !loop_task {
        return true;
    }
    ["needs_input", "blocked", "failed", "limit"].iter().any(|o| t.outcome_is(o))
}

/// `finishedLine`: the "finished" event a parent gets for a tool ticket's result.
pub fn finished_line(t: &Tk, summary: &str, report: Option<&str>) -> String {
    let outcome = match t.get("outcome") {
        Some(Value::String(o)) if o == "needs_input" => "questions".to_string(),
        None | Some(Value::Null) => "done".to_string(),
        v => tpl(v),
    };
    let verdict = match (t.kind.as_deref(), t.get("verdict")) {
        (Some("test"), Some(v)) if ckanban_core::jsnum::truthy(Some(v)) => format!("; verdict {}", tpl(Some(v))),
        _ => String::new(),
    };
    let one = js_trim(&squash_spaces(summary)).to_string();
    let s = if one.is_empty() { "(none)".to_string() } else { one };
    format!(
        "finished: {} \"{}\"; outcome {outcome}{verdict}; summary: {}; report: {}",
        t.id,
        t.title,
        clip(&s, 1200),
        report.unwrap_or("no report")
    )
}

/// `waitsOnLimit`: hit the usage limit, and the board continues it once the limit resets.
pub fn waits_on_limit(t: &Tk) -> bool {
    t.outcome_is("limit") && t.get("limit").and_then(|l| l.get("auto")).is_some_and(|a| ckanban_core::jsnum::truthy(Some(a)))
}

fn waits_to_start(t: &Tk) -> bool {
    t.status == "backlog" && t.is("waitsForStart")
}

pub struct PlanEvent {
    pub child_id: String,
    pub sig: String,
    pub line: String,
    pub result: bool,
}

pub struct PlanStep {
    pub start: Vec<String>,
    pub events: Vec<PlanEvent>,
    pub all_complete: bool,
    pub active: usize,
    pub awaiting_merge: usize,
    pub dead_end: Option<String>,
    pub user_wait: Vec<(String, String)>,
}

/// `planStep`: what a running plan does next. waiting_on_user: why a child waits on the user (`Board.userWait`);
/// summary and report: a child's last result and report file.
pub fn plan_step(
    plan: &Map<String, Value>,
    children: &[Arc<Tk>],
    running: &dyn Fn(&str) -> bool,
    waiting_on_user: &dyn Fn(&Tk) -> Option<String>,
    summary: &dyn Fn(&Tk) -> String,
    report: &dyn Fn(&Tk) -> Option<String>,
) -> PlanStep {
    let seen = plan.get("seen").and_then(Value::as_object);
    let mut events = Vec::new();
    let (mut active, mut awaiting_merge) = (0, 0);
    for t in children {
        let busy = running(&t.id) || t.status == "ready" || t.status == "in_progress" || waits_on_limit(t) || plan_active(t);
        if busy {
            active += 1;
            continue;
        }
        if t.tool && t.kind.as_deref() == Some("with_you") && t.outcome_is("needs_input") && t.status != "done" {
            active += 1;
            continue;
        }
        let ended = ["done", "failed", "blocked", "needs_input", "limit"].iter().any(|o| t.outcome_is(o));
        let ev = (ended && t.status != "backlog" && t.status != "planning" && result_wakes_main(t)).then(|| {
            let sig = format!("{}:{}:{}", tpl(t.get("runCount")), tpl(t.get("outcome")), or_empty(t.get("prUrl")));
            let line = finished_line(t, &summary(t), report(t).as_deref());
            PlanEvent { child_id: t.id.clone(), sig, line, result: true }
        });
        match ev {
            Some(ev) if seen.and_then(|s| s.get(&t.id)).and_then(Value::as_str) != Some(ev.sig.as_str()) => events.push(ev),
            Some(_) if t.is("prUrl") && t.outcome_is("done") => awaiting_merge += 1,
            _ => {}
        }
    }
    let all_complete = !children.is_empty() && children.iter().all(|t| is_complete(t));
    let mut user_wait: Vec<(String, String)> = Vec::new();
    for t in children {
        if is_complete(t) || running(&t.id) || t.status == "ready" || t.status == "in_progress" || t.tool {
            continue;
        }
        if let Some(reason) = waiting_on_user(t) {
            user_wait.push((t.id.clone(), reason));
        }
    }
    let mut start = Vec::new();
    for t in children {
        if t.status != "backlog" || running(&t.id) || waits_to_start(t) || user_wait.iter().any(|(id, _)| *id == t.id) {
            continue;
        }
        let (deps, missing) = resolve_deps(t, children);
        if missing.is_empty() && deps.iter().all(|d| is_complete(d)) {
            start.push(t.id.clone());
        }
    }
    let mut dead_end = None;
    if !all_complete && active == 0 && start.is_empty() && events.is_empty() && awaiting_merge == 0 {
        let label = |t: &Tk| format!("\"{}\"", t.title);
        let you: Vec<String> = user_wait
            .iter()
            .filter_map(|(id, why)| children.iter().find(|c| c.id == *id).map(|c| format!("{} ({why})", label(c))))
            .collect();
        let open: Vec<String> = children
            .iter()
            .filter(|t| !is_complete(t) && !user_wait.iter().any(|(id, _)| *id == t.id) && !waits_to_start(t))
            .map(|t| {
                let outcome = match t.get("outcome") {
                    Some(v) if ckanban_core::jsnum::truthy(Some(v)) => format!(", {}", tpl(Some(v))),
                    _ => String::new(),
                };
                format!("{} ({}{outcome})", label(t), t.status)
            })
            .collect();
        let list = |xs: &[String]| {
            let head = xs.iter().take(8).cloned().collect::<Vec<_>>().join(", ");
            if xs.len() > 8 { format!("{head} and {} more", xs.len() - 8) } else { head }
        };
        if !you.is_empty() || !open.is_empty() {
            let mut parts = Vec::new();
            if !you.is_empty() {
                parts.push(format!("waiting for you: {}", list(&you)));
            }
            if !open.is_empty() {
                parts.push(format!("{}: {}", if you.is_empty() { "nothing can run; not done yet" } else { "also not done" }, list(&open)));
            }
            dead_end = Some(parts.join("; "));
        }
    }
    PlanStep { start, events, all_complete, active, awaiting_merge, dead_end, user_wait }
}

/// Why a stuck main ticket's plan may run again, as the note's words; None while its reason still holds. Only for
/// a main ticket whose own run isn't going. `main_asks`: the main ticket's chat has an open questions form it hasn't
/// closed; `kid_waits`: a task waits on the user; `step`: what the plan would do next; `sig`: the family's signature
/// now. Unknown reasons stay stuck (the user's chat or Resume plan clears them, as before).
pub fn stuck_cleared(plan: &Map<String, Value>, main: &Tk, main_asks: bool, kids: &[Arc<Tk>], kid_waits: &dyn Fn(&Tk) -> bool, step: &PlanStep, sig: &str) -> Option<&'static str> {
    let reason = plan.get("reason").and_then(Value::as_str).unwrap_or("");
    let closed = crate::index::family::ask_closed(main);
    let main_holds = main_asks
        || (main.outcome_is("needs_input") && !closed)
        || ["blocked", "failed", "stopped", "limit"].iter().any(|o| main.outcome_is(o));
    // Whatever the reason, nothing may still wait on the user, and the plan must not hit the same dead end at once.
    if main_holds || kids.iter().any(|k| !is_complete(k) && kid_waits(k)) || (step.dead_end.is_some() && step.start.is_empty()) {
        return None;
    }
    if reason == crate::index::attention::STUCK_ON_QUESTIONS {
        Some("Plan running again: nothing is waiting on you.")
    } else if reason.starts_with("the run that plans the steps") {
        Some("Plan running again: a later run of this ticket ended well.")
    } else if reason.starts_with("waiting for you:") || reason.starts_with("nothing can run") {
        Some("Plan running again: the blocked task was resolved.")
    } else if reason.contains("wakes in a row without any tool ticket changing") {
        (plan.get("progressSig").and_then(Value::as_str) != Some(sig)).then_some("Plan running again: a tool ticket changed.")
    } else {
        None
    }
}

/// `kid_waits` for `stuck_cleared`: a task not at work whose last run ended asking, blocked or failed, or that waits
/// on the user for another reason (`user_wait`).
pub fn kid_waits_on_user(t: &Tk, running: bool, user_wait: Option<String>) -> bool {
    if running || t.status == "ready" || t.status == "in_progress" || plan_active(t) {
        return false;
    }
    ["needs_input", "blocked", "failed"].iter().any(|o| t.outcome_is(o)) || user_wait.is_some()
}

/// `progressStep`: (progressSig, noProgress, stuck) for a wake about to happen, sig being the family's signature.
pub fn progress_step(plan: &Map<String, Value>, sig: &str) -> (String, f64, bool) {
    let same = plan.get("progressSig").and_then(Value::as_str) == Some(sig);
    let no_progress = if same { plan.get("noProgress").and_then(Value::as_f64).unwrap_or(0.0) + 1.0 } else { 0.0 };
    (sig.to_string(), no_progress, no_progress >= NO_PROGRESS_WAKES)
}

/// `familySig`: who is in the family, each one's column, outcome, verdict and pull request states.
pub fn family_sig<'a>(rows: impl IntoIterator<Item = &'a Tk>) -> String {
    let mut parts: Vec<String> = rows
        .into_iter()
        .map(|t| {
            let prs: Vec<String> = ticket_prs(&Value::Object(t.json.clone())).iter().map(|p| or_empty(p.get("state"))).collect();
            format!("{}:{}:{}:{}:{}", t.id, t.status, or_empty(t.get("outcome")), or_empty(t.get("verdict")), prs.join(","))
        })
        .collect();
    // JS's default sort: by UTF-16 code units.
    parts.sort_by(|a, b| crate::runs::js::cmp16(a, b));
    parts.join("|")
}

/// `wakeTable`: the family table of a wake, collapsed to what works, failed or waits, one row per group.
pub fn wake_table(kids: &[Arc<Tk>], all: &BoardList, running: &dyn Fn(&str) -> bool) -> String {
    let mut lines = Vec::new();
    let mut finished = 0;
    for t in kids {
        let own: Vec<&Arc<Tk>> =
            all.tickets.iter().filter(|c| c.parent_id.as_deref() == Some(t.id.as_str()) || c.part_of.as_deref() == Some(t.id.as_str())).collect();
        if !own.is_empty() || matches!(t.kind.as_deref(), Some("group" | "round")) {
            let states: Vec<(Option<&str>, &str)> = own.iter().map(|c| (c.kind.as_deref(), family_state(c, running(&c.id), false))).collect();
            let mut parts = vec![group_summary(&states)];
            let count = |s: &str| states.iter().filter(|(_, x)| *x == s).count();
            let (working, failed, in_review) = (count("working"), count("failed"), count("in_review"));
            if working > 0 {
                parts.push(format!("{working} working"));
            }
            if in_review > 0 {
                parts.push(format!("{in_review} in review"));
            }
            if failed > 0 {
                parts.push(format!("{failed} failed"));
            }
            let busy = running(&t.id) || t.status == "ready" || t.status == "in_progress";
            lines.push(format!("- {} {}: {}{}", t.id, t.title, parts.join(", "), if busy { " (group working)" } else { "" }));
            continue;
        }
        let state = family_state(t, running(&t.id), false);
        if matches!(state, "done" | "passed" | "problem") {
            finished += 1;
            continue;
        }
        let why = if t.outcome_is("needs_input") {
            "asking a question".to_string()
        } else if state == "waiting" {
            match t.get("dependsOn").and_then(Value::as_array).filter(|d| !d.is_empty()) {
                Some(d) => format!("waiting for {}", d.iter().map(|x| tpl(Some(x))).collect::<Vec<_>>().join(", ")),
                None => "waiting to start".into(),
            }
        } else {
            state.replacen('_', " ", 1)
        };
        let kind = t.kind.as_deref().map(|k| format!(" ({k})")).unwrap_or_default();
        lines.push(format!("- {} \"{}\"{kind}: {why}", t.id, t.title));
    }
    if finished > 0 {
        lines.push(format!("- {finished} other tool ticket{} finished (get_family lists them)", if finished == 1 { "" } else { "s" }));
    }
    if lines.is_empty() { "- (no tool tickets yet)".into() } else { lines.join("\n") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::family::tests::tk;
    use serde_json::json;

    fn kid(id: &str, extra: Value) -> Arc<Tk> {
        let mut m = json!({ "id": id, "title": id, "status": "backlog", "createdAt": "2026-01-01", "parentId": "m", "tool": true });
        if let (Value::Object(m), Value::Object(e)) = (&mut m, extra) {
            m.extend(e);
        }
        tk(m)
    }

    #[test]
    fn steps_start_in_dependency_order() {
        let kids = vec![kid("a", json!({ "planKey": "a" })), kid("b", json!({ "dependsOn": ["a"] }))];
        let plan = Map::new();
        let s = plan_step(&plan, &kids, &|_| false, &|_| None, &|_| String::new(), &|_| None);
        assert_eq!(s.start, vec!["a".to_string()]);
        assert!(s.dead_end.is_none());
        let kids = vec![kid("a", json!({ "status": "done", "outcome": "done", "runCount": 1 })), kid("b", json!({ "dependsOn": ["a"] }))];
        let s = plan_step(&plan, &kids, &|_| false, &|_| None, &|_| "ok".into(), &|_| None);
        assert_eq!(s.start, vec!["b".to_string()]);
        assert_eq!(s.events.len(), 1);
        assert_eq!(s.events[0].sig, "1:done:");
        assert_eq!(s.events[0].line, "finished: a \"a\"; outcome done; summary: ok; report: no report");
        assert_eq!(plan_problem(&[]).as_deref(), Some("this ticket has no tool tickets to run"));
        assert_eq!(plan_problem(&[kid("x", json!({ "dependsOn": ["zz"] }))]).as_deref(), Some("\"x\" depends on unknown ticket \"zz\""));
    }

    #[test]
    fn stuck_cleared_by_reason() {
        let main = |o: &str| tk(json!({ "id": "m", "title": "m", "status": "review", "main": true, "outcome": o }));
        let kids = vec![kid("a", json!({ "status": "in_progress" }))];
        let plan = |reason: &str, sig: &str| {
            let mut p = Map::new();
            p.insert("reason".into(), reason.into());
            p.insert("progressSig".into(), sig.into());
            p
        };
        let no = |_: &Tk| false;
        let step = |p: &Map<String, Value>| plan_step(p, &kids, &|_| false, &|_| None, &|_| String::new(), &|_| None);
        let check = |p: Map<String, Value>, o: &str, asks: bool| stuck_cleared(&p, &main(o), asks, &kids, &no, &step(&p), "sig");
        assert_eq!(check(plan("the run that plans the steps failed", ""), "failed", false), None);
        assert_eq!(check(plan("the run that plans the steps failed", ""), "done", false), Some("Plan running again: a later run of this ticket ended well."));
        assert_eq!(check(plan(crate::index::attention::STUCK_ON_QUESTIONS, ""), "done", true), None);
        assert_eq!(check(plan("3 wakes in a row without any tool ticket changing; waiting events: x", "sig"), "done", false), None);
        assert_eq!(check(plan("3 wakes in a row without any tool ticket changing; waiting events: x", "old"), "done", false), Some("Plan running again: a tool ticket changed."));
        assert_eq!(check(plan("something else", ""), "done", false), None);
        let waits = |_: &Tk| true;
        let p = plan("waiting for you: \"a\" (has questions for you)", "");
        assert_eq!(stuck_cleared(&p, &main("done"), false, &kids, &waits, &step(&p), "sig"), None);
        assert!(kid_waits_on_user(&kid("b", json!({ "status": "review", "outcome": "failed" })), false, None));
        assert!(!kid_waits_on_user(&kid("b", json!({ "status": "ready", "outcome": "failed" })), false, None));
    }

    #[test]
    fn dead_end_and_sig() {
        let kids = vec![kid("a", json!({ "status": "review", "outcome": "failed", "runCount": 1 }))];
        let mut plan = Map::new();
        plan.insert("seen".into(), json!({ "a": "1:failed:" }));
        let s = plan_step(&plan, &kids, &|_| false, &|_| None, &|_| String::new(), &|_| None);
        assert_eq!(s.dead_end.as_deref(), Some("nothing can run; not done yet: \"a\" (review, failed)"));
        assert_eq!(family_sig(kids.iter().map(|k| &**k)), "a:review:failed::");
        let (_, n, stuck) = progress_step(&Map::new(), "x");
        assert_eq!((n, stuck), (0.0, false));
    }
}
