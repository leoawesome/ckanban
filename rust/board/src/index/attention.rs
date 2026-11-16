//! Whether a ticket waits on the user, and why: the pure part of `src/helper/attention.ts` with the step rules of
//! `src/board/main-ticket.ts` (`stepWait`, `stepName`) and `src/board/plan.ts` (`isComplete`, `planActive`). One rule
//! for the card's "Your turn", the counts and the Inbox.

use std::collections::HashSet;

use ckanban_core::jsnum::{js_string, truthy};
use ckanban_core::time::parse_date;
use serde_json::{Map, Value};

use super::family::{ask_closed, feature_rows};
use super::store::BoardList;
use super::text::{clip, fixed2, js_trim};
use super::ticket::Tk;

pub const STUCK_ON_QUESTIONS: &str = "there are questions for you";

#[derive(Clone, Debug, PartialEq)]
pub struct Attention {
    pub kind: String,
    pub label: String,
    pub since: String,
    pub step: Option<String>,
    pub step_id: Option<String>,
}

impl Attention {
    fn new(kind: &str, label: impl Into<String>, since: impl Into<String>) -> Attention {
        Attention { kind: kind.into(), label: label.into(), since: since.into(), step: None, step_id: None }
    }
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), self.kind.clone().into());
        m.insert("label".into(), self.label.clone().into());
        m.insert("since".into(), self.since.clone().into());
        if let Some(s) = &self.step {
            m.insert("step".into(), s.clone().into());
        }
        if let Some(s) = &self.step_id {
            m.insert("stepId".into(), s.clone().into());
        }
        Value::Object(m)
    }
}

/// Why a tool ticket waits (`StepWait`).
#[derive(Clone, Debug, PartialEq)]
pub struct StepWait {
    pub id: String,
    pub label: String,
    pub attention: &'static str,
    pub since: String,
    pub with_you: bool,
}

impl StepWait {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.clone().into());
        m.insert("label".into(), self.label.clone().into());
        m.insert("attention".into(), self.attention.into());
        m.insert("since".into(), self.since.clone().into());
        if self.with_you {
            m.insert("withYou".into(), true.into());
        }
        Value::Object(m)
    }
}

fn get<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    v.and_then(|x| x.get(k))
}
fn get_str<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a str> {
    get(v, k).and_then(Value::as_str)
}
/// `a || b || ...` over text values: the first truthy one.
fn first_truthy<'a>(vals: &[Option<&'a Value>]) -> String {
    for v in vals {
        if truthy(*v) {
            return match v {
                Some(Value::String(s)) => s.clone(),
                Some(x) => x.to_string(),
                None => String::new(),
            };
        }
    }
    String::new()
}
/// `x ?? ""` as text.
fn or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.as_f64().map(js_string).unwrap_or_default(),
        Some(x) => x.to_string(),
    }
}
fn num_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::Number(n)) => n.as_f64().map(js_string).unwrap_or_default(),
        Some(Value::String(s)) => s.clone(),
        None => "undefined".into(),
        Some(x) => x.to_string(),
    }
}

pub fn plan_active(t: &Tk) -> bool {
    matches!(t.plan_state(), Some("running") | Some("finishing"))
}

/// `isComplete`: Done, or finished in Review without a PR; never while its own plan runs.
pub fn is_complete(t: &Tk) -> bool {
    !plan_active(t) && (t.status == "done" || (t.status == "review" && t.outcome_is("done") && !t.is("prUrl")))
}

/// The ticket's own huddle works on its own (`huddleBusy`).
pub fn huddle_busy(h: Option<&Value>) -> bool {
    h.is_some_and(|h| h.get("working").and_then(Value::as_f64).unwrap_or(0.0) > 0.0 || truthy(h.get("queued")))
}

/// What the ticket's huddle asks of the user (`huddleAsk`).
pub fn huddle_ask(h: Option<&Value>) -> Option<String> {
    let h = h?;
    if truthy(h.get("closeRequest")) {
        return Some("Huddle asks to close".into());
    }
    let tagged = h.get("tagged").and_then(Value::as_f64).unwrap_or(0.0);
    if tagged > 0.0 {
        return Some(format!("Huddle: {} for you", js_string(tagged)));
    }
    let l = h.get("learnings").and_then(Value::as_f64).unwrap_or(0.0);
    if l > 0.0 {
        return Some(format!("Review {} learning{}", js_string(l), if l == 1.0 { "" } else { "s" }));
    }
    None
}

/// `lastChange`.
pub fn last_change(t: &Tk, s: Option<&Value>) -> String {
    first_truthy(&[get(get(s, "lastMessage"), "at"), get(s, "updatedAt"), t.get("lastRunAt"), t.get("updatedAt"), t.get("createdAt")])
}

const KIND_WORDS: [(&str, &str); 5] = [("explore", "Explore"), ("build", "Build"), ("test", "Test"), ("review", "Review"), ("fix", "Fix")];

/// `stepName`: the title, led by its kind unless the title already says it.
pub fn step_name(t: &Tk) -> String {
    let word = t.kind.as_deref().and_then(|k| KIND_WORDS.iter().find(|(x, _)| *x == k)).map(|(_, w)| *w);
    match word {
        Some(w) if !t.title.to_lowercase().starts_with(&w.to_lowercase()) => format!("{w}: {}", t.title),
        _ => t.title.clone(),
    }
}

/// `youWaiting`: a "with you" tool ticket waits for the user's answer.
pub fn you_waiting(t: &Tk, running: bool) -> bool {
    let with_you = t.tool && t.kind.as_deref() == Some("with_you");
    if !with_you || running || !t.outcome_is("needs_input") || ask_closed(t) {
        return false;
    }
    if matches!(t.status.as_str(), "done" | "ready" | "in_progress" | "backlog") {
        return false;
    }
    !matches!(t.get("queued"), Some(Value::Array(a)) if !a.is_empty())
}

fn since_of(t: &Tk) -> String {
    match t.get("runEndedAt") {
        None | Some(Value::Null) => or_empty(t.get("updatedAt")),
        v => or_empty(v),
    }
}

/// `stepWait`.
pub fn step_wait(t: &Tk, running: bool) -> Option<StepWait> {
    if you_waiting(t, running) {
        return Some(StepWait { id: t.id.clone(), label: format!("{} needs you", step_name(t)), attention: "questions", since: since_of(t), with_you: true });
    }
    if running || matches!(t.status.as_str(), "done" | "ready" | "in_progress" | "backlog") {
        return None;
    }
    let since = since_of(t);
    let at = |why: String, attention: &'static str| Some(StepWait { id: t.id.clone(), label: format!("{} {why}", step_name(t)), attention, since: since.clone(), with_you: false });
    if t.outcome_is("needs_input") && !ask_closed(t) {
        return at("asks a question".into(), "questions");
    }
    let err = t.s("error").unwrap_or("");
    let why = js_trim(err).split('\n').filter(|l| !js_trim(l).is_empty()).last().map(|l| js_trim(l).to_string());
    if t.outcome_is("failed") {
        return at(match why {
            Some(w) => format!("failed: {}", clip(&w, 80)),
            None => "failed".into(),
        }, "failed");
    }
    if t.outcome_is("blocked") {
        let cap = get(t.get("capHit"), "capUsd").and_then(Value::as_f64);
        return at(match (truthy(t.get("capHit")), cap) {
            (true, Some(c)) => format!("stopped at its ${} cap", fixed2(c)),
            _ => "is blocked".into(),
        }, "blocked");
    }
    if t.outcome_is("limit") && !truthy(get(t.get("limit"), "auto")) {
        return at("hit the usage limit".into(), "limit");
    }
    None
}

/// `oldestStep`: a main ticket's oldest tool ticket waiting on a decision ("with you" ones first).
pub fn oldest_step(list: &BoardList, main_id: &str, running: &dyn Fn(&str) -> bool) -> Option<StepWait> {
    let mut best: Option<StepWait> = None;
    let mut you: Vec<StepWait> = Vec::new();
    for r in feature_rows(list, main_id) {
        let t = list.at(r.idx);
        if t.id == main_id || !t.tool {
            continue;
        }
        match step_wait(t, running(&t.id)) {
            Some(w) if w.with_you => you.push(w),
            Some(w) => {
                if best.as_ref().is_none_or(|b| w.since < b.since) {
                    best = Some(w);
                }
            }
            None => {}
        }
    }
    if !you.is_empty() {
        you.sort_by(|a, b| a.since.cmp(&b.since));
        let n = you.len();
        let mut first = you.swap_remove(0);
        if n > 1 {
            first.label = format!("{n} tasks need you");
        }
        return Some(first);
    }
    best
}

#[derive(Default)]
pub struct Opts<'a> {
    pub managed: bool,
    pub plan_complete: Option<bool>,
    pub huddle: Option<&'a Value>,
    pub step: Option<StepWait>,
    pub schedules: Option<HashSet<String>>,
}

fn pending_unanswered(s: Option<&Value>, list: &str, t: &Tk, cards: &str) -> bool {
    match get(s, list) {
        Some(Value::Array(a)) => a.iter().any(|id| {
            let key = match id {
                Value::String(x) => x.clone(),
                x => x.to_string(),
            };
            !truthy(t.get(cards).and_then(|c| c.get(&key)))
        }),
        _ => false,
    }
}

fn own_attention(t: &Tk, s: Option<&Value>, running: bool, o: &Opts) -> Option<Attention> {
    let missed = get(t.get("followUp"), "missedAt");
    if truthy(missed) && !running {
        return Some(Attention::new("blocked", "Missed follow-up", or_empty(missed)));
    }
    if t.status == "done" {
        return None;
    }
    let since = last_change(t, s);
    if truthy(t.get("stalled")) && running {
        let st = t.get("stalled");
        return Some(Attention::new("stalled", format!("Stalled · no output for {} min", num_text(get(st, "minutes"))), or_empty(get(st, "at"))));
    }
    let closed_ask = get_str(t.get("plan"), "reason") == Some(STUCK_ON_QUESTIONS) && ask_closed(t);
    if t.plan_state() == Some("stuck") && (!o.plan_complete.unwrap_or(false) || t.main) && !closed_ask {
        return Some(Attention::new("blocked", "Plan stuck", or_empty(t.get("updatedAt"))));
    }
    if running || t.status == "in_progress" {
        return None;
    }
    if o.managed || matches!(t.plan_state(), Some("running") | Some("finishing") | Some("paused")) {
        return None;
    }
    if t.status == "backlog" {
        return None;
    }
    if let Some(ask) = huddle_ask(o.huddle) {
        let hs = match get(o.huddle, "since") {
            None | Some(Value::Null) => since.clone(),
            v => or_empty(v),
        };
        return Some(Attention::new("huddle", ask, hs));
    }
    if huddle_busy(o.huddle) {
        return None;
    }
    if t.outcome_is("failed") {
        return Some(Attention::new("failed", "Run failed", since));
    }
    if t.outcome_is("limit") {
        return if truthy(get(t.get("limit"), "auto")) { None } else { Some(Attention::new("limit", "Limit hit", since)) };
    }
    if t.outcome_is("blocked") {
        let label = match (truthy(t.get("capHit")), get(t.get("capHit"), "capUsd").and_then(Value::as_f64)) {
            (true, Some(c)) => format!("Stopped at ${} cap", fixed2(c)),
            _ => "Blocked".into(),
        };
        return Some(Attention::new("blocked", label, since));
    }
    let closed = ask_closed(t);
    let q = if closed { 0.0 } else { get(s, "openQuestions").and_then(Value::as_f64).unwrap_or(0.0) };
    if q > 0.0 {
        return Some(Attention::new("questions", format!("Answer {} question{}", js_string(q), if q == 1.0 { "" } else { "s" }), since));
    }
    if pending_unanswered(s, "pendingKeys", t, "keyCards") {
        return Some(Attention::new("questions", "Add keys", since));
    }
    if t.outcome_is("needs_input") && !closed {
        return Some(Attention::new("questions", "Answer Claude", since));
    }
    if proposal_pending(t, s) {
        return Some(Attention::new("proposal", "Review proposal", since));
    }
    if pending_unanswered(s, "pendingTeammates", t, "teammateCards") {
        return Some(Attention::new("proposal", "Review proposed teammate", since));
    }
    if pending_unanswered(s, "pendingSquads", t, "squadCards") {
        return Some(Attention::new("proposal", "Review proposed squad", since));
    }
    if pending_unanswered(s, "pendingAutomations", t, "automationCards") {
        return Some(Attention::new("proposal", "Review proposed automation", since));
    }
    if let Some(Value::Array(a)) = get(s, "pendingScheduleDeletes") {
        let waiting = a.iter().any(|c| {
            let uuid = or_empty(c.get("uuid"));
            let id = or_empty(c.get("id"));
            !truthy(t.get("scheduleDeleteCards").and_then(|m| m.get(&uuid))) && o.schedules.as_ref().is_none_or(|s| s.contains(&id))
        });
        if waiting {
            return Some(Attention::new("proposal", "Confirm deleting a schedule", since));
        }
    }
    if pending_unanswered(s, "pendingHelperRules", t, "helperRuleCards") {
        return Some(Attention::new("proposal", "Review a suggestion for the helper", since));
    }
    if t.status == "review" {
        return Some(Attention::new("review", "Ready for review", since));
    }
    let last = get(s, "lastMessage");
    if t.status == "planning" && get_str(last, "role") == Some("assistant") && !truthy(get(last, "peerReply")) && !t.is("interrupted") {
        return Some(Attention::new("reply", "Claude replied", since));
    }
    None
}

/// A proposal that would change the ticket waits for the user's Apply.
fn proposal_pending(t: &Tk, s: Option<&Value>) -> bool {
    let p = get(s, "pendingProposal");
    if !truthy(p) {
        return false;
    }
    let title = get(p, "title");
    let desc = get(p, "description");
    let same_title = !truthy(title) || title.and_then(Value::as_str) == Some(t.title.as_str());
    let same_body = !truthy(desc) || desc.and_then(Value::as_str).map(js_trim) == Some(js_trim(&t.body));
    !(same_title && same_body)
}

/// `attentionFor`.
pub fn attention_for(t: &Tk, s: Option<&Value>, running: bool, o: &Opts) -> Option<Attention> {
    if t.tool {
        return None;
    }
    let own = own_attention(t, s, running, o);
    let Some(step) = &o.step else { return own };
    if !t.main || t.status == "done" || t.status == "backlog" {
        return own;
    }
    let soft = |a: &Option<Attention>| a.as_ref().is_some_and(|a| a.kind != "review" && a.kind != "reply");
    if step.with_you {
        return if soft(&own) {
            own
        } else {
            Some(Attention { kind: "questions".into(), label: step.label.clone(), since: step.since.clone(), step: Some(step.attention.into()), step_id: Some(step.id.clone()) })
        };
    }
    if let Some(a) = &own {
        if matches!(a.kind.as_str(), "questions" | "blocked" | "failed") {
            return Some(Attention { label: step.label.clone(), step: Some(step.attention.into()), ..a.clone() });
        }
    }
    if running || soft(&own) {
        return own;
    }
    let unseen = step.since.as_str() > t.s("runEndedAt").unwrap_or("");
    let plan = t.get("plan");
    let will_wake = matches!(t.plan_state(), Some("running") | Some("finishing"))
        && (truthy(get(plan, "awaiting")) || matches!(get(plan, "inbox"), Some(Value::Array(a)) if !a.is_empty()));
    if unseen && !will_wake {
        return Some(Attention { kind: step.attention.into(), label: step.label.clone(), since: step.since.clone(), step: Some(step.attention.into()), step_id: Some(step.id.clone()) });
    }
    own
}

/// `ticketAttention`: attentionFor with its options read from the board.
pub fn ticket_attention(list: &BoardList, t: &Tk, s: Option<&Value>, running: bool, huddle: Option<&Value>, is_running: &dyn Fn(&str) -> bool, schedules: &dyn Fn() -> HashSet<String>) -> Option<Attention> {
    if t.tool {
        return None;
    }
    let managed = t.parent_id.as_deref().and_then(|p| list.get(p)).is_some_and(|p| plan_active(p));
    let plan_complete = (t.plan_state() == Some("stuck")).then(|| {
        let kids: Vec<_> = list.tickets.iter().filter(|k| k.parent_id.as_deref() == Some(t.id.as_str())).collect();
        !kids.is_empty() && kids.iter().all(|k| is_complete(k))
    });
    let step = if t.main { oldest_step(list, &t.id, is_running) } else { None };
    let has_deletes = matches!(get(s, "pendingScheduleDeletes"), Some(Value::Array(a)) if !a.is_empty());
    attention_for(t, s, running, &Opts { managed, plan_complete, huddle, step, schedules: has_deletes.then(schedules) })
}

/// `snoozeKey`.
pub fn snooze_key(t: &Tk, s: Option<&Value>, a: &Attention, huddle: Option<&Value>) -> String {
    let asks = if a.kind == "huddle" { format!("{}|{}", a.since, or_empty(get(huddle, "latest"))) } else { String::new() };
    [a.kind.clone(), a.label.clone(), or_empty(get(get(s, "lastMessage"), "at")), or_empty(t.get("lastRunAt")), or_empty(t.get("outcome")), asks].join("|")
}

/// `withSnooze`: (attention, snoozed) where snoozed is `{attention, until}`.
pub fn with_snooze(t: &Tk, s: Option<&Value>, a: Option<Attention>, now: f64, huddle: Option<&Value>) -> (Option<Attention>, Option<(Attention, String)>) {
    let z = t.get("snooze");
    if let (Some(a), true) = (&a, truthy(z)) {
        let until = get_str(z, "until");
        let live = until.and_then(parse_date).is_some_and(|u| u > now);
        if live && get_str(z, "key") == Some(snooze_key(t, s, a, huddle).as_str()) {
            return (None, Some((a.clone(), until.unwrap_or("").to_string())));
        }
    }
    (a, None)
}

/// `userWaitReason`: why a plan child waits on the user.
pub fn user_wait_reason(t: &Tk, s: Option<&Value>) -> Option<String> {
    if t.status == "done" {
        return None;
    }
    let closed = ask_closed(t);
    let q = if closed { 0.0 } else { get(s, "openQuestions").and_then(Value::as_f64).unwrap_or(0.0) };
    if q > 0.0 {
        return Some(format!("{} question{} for you", js_string(q), if q == 1.0 { "" } else { "s" }));
    }
    if t.status == "planning" {
        return Some("in Planning".into());
    }
    if t.outcome_is("needs_input") && !closed {
        return Some("has questions for you".into());
    }
    if proposal_pending(t, s) {
        return Some("proposal to apply".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::family::tests::{board, tk};
    use serde_json::json;

    #[test]
    fn own_attention_rules() {
        let none = |_: &str| false;
        let l = board(vec![]);
        let at = |t: Value, s: Option<Value>| ticket_attention(&l, &tk(t), s.as_ref(), false, None, &none, &HashSet::new).map(|a| a.label);
        assert_eq!(at(json!({"id": "a", "status": "review", "updatedAt": "u"}), None).as_deref(), Some("Ready for review"));
        assert_eq!(at(json!({"id": "a", "status": "review", "outcome": "failed"}), None).as_deref(), Some("Run failed"));
        assert_eq!(at(json!({"id": "a", "status": "review", "outcome": "blocked", "capHit": {"capUsd": 5}}), None).as_deref(), Some("Stopped at $5.00 cap"));
        assert_eq!(at(json!({"id": "a", "status": "review"}), Some(json!({"openQuestions": 2}))).as_deref(), Some("Answer 2 questions"));
        assert_eq!(at(json!({"id": "a", "status": "done", "followUp": {"missedAt": "m"}}), None).as_deref(), Some("Missed follow-up"));
        assert_eq!(at(json!({"id": "a", "status": "backlog"}), None), None);
        assert_eq!(at(json!({"id": "a", "status": "review", "tool": true}), None), None);
        assert_eq!(
            at(json!({"id": "a", "status": "planning"}), Some(json!({"lastMessage": {"role": "assistant", "at": "x"}}))).as_deref(),
            Some("Claude replied")
        );
    }

    #[test]
    fn steps_and_snooze() {
        let l = board(vec![
            json!({"id": "m", "title": "Main", "status": "review", "main": true, "createdAt": "1", "runEndedAt": "2"}),
            json!({"id": "s", "title": "checkout", "kind": "test", "status": "review", "tool": true, "parentId": "m", "createdAt": "2", "outcome": "failed", "error": "boom\nlast line\n", "runEndedAt": "5"}),
        ]);
        let none = |_: &str| false;
        let m = l.get("m").unwrap();
        let a = ticket_attention(&l, m, None, false, None, &none, &HashSet::new).unwrap();
        assert_eq!((a.kind.as_str(), a.label.as_str(), a.step_id.as_deref()), ("failed", "Test: checkout failed: last line", Some("s")));
        let t = tk(json!({"id": "z", "status": "review", "snooze": {"until": "9999-12-31T23:59:59.000Z", "key": "review|Ready for review||||"}}));
        let (a, z) = with_snooze(&t, None, Some(Attention::new("review", "Ready for review", "u")), 0.0, None);
        assert!(a.is_none() && z.is_some());
    }
}
