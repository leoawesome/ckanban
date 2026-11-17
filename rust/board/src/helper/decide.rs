//! The helper's AI part (`src/helper/decide.ts`): its instructions, the JSON schema of its answer and the board's
//! checks on every answer. Pure: no files, no sends.

use std::collections::HashMap;
use std::sync::LazyLock;

use ckanban_core::jsnum::js_string;
use serde_json::Value;

use super::local;
use super::settings::{Night, hm, in_night};
use super::text::{ONE_LINE_MAX, cut};
use crate::runs::js::{self, head16, trim};

/// `HELPER_SYSTEM`, Bun's text byte for byte (written from Bun; the fixtures check it).
pub const HELPER_SYSTEM: &str = include_str!("system.txt");
/// `DECISION_SCHEMA` as `JSON.stringify` writes it.
pub const DECISION_SCHEMA_TEXT: &str = include_str!("schema.json");
pub static DECISION_SCHEMA: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(DECISION_SCHEMA_TEXT).expect("schema"));

pub const SUMMARY_GAP_MS: f64 = 3.0 * 3600_000.0;
pub const MIN_WAKE_MIN: f64 = 1.0;
pub const MAX_WAKE_MIN: f64 = 24.0 * 60.0;
pub const STEP_GAP_MIN: f64 = 5.0;
pub const NIGHT_STEP_GAP_MIN: f64 = 30.0;
pub const REMIND_MAX_MIN: f64 = 120.0;
pub const REMIND_MAX_STEPS: usize = 6;
pub const WHY_MAX: usize = 300;
pub const NOTES_MAX: usize = 4000;
pub const LOG_MAX: usize = 500;
pub const FOLLOWED_MAX: usize = 3;

/// What the board knows about each key when checking a decision.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ItemState {
    pub open: bool,
    pub snoozed: bool,
    pub checkin: bool,
    pub told: bool,
    pub pending_reminders: bool,
    pub stopped: Option<String>,
    pub opened: bool,
    pub alerted: bool,
}

/// Why an item may not get an urgent alert (None: it may).
pub fn urgent_refusal(st: &ItemState) -> Option<String> {
    if st.checkin {
        return Some("a check-in item".into());
    }
    if st.pending_reminders {
        return Some("reminders already running".into());
    }
    if let Some(s) = st.stopped.as_deref().filter(|s| !s.is_empty()) {
        return Some(if s == "got-it" || s == "not-urgent" { format!("the user tapped {s}") } else { format!("its reminders stopped ({s})") });
    }
    if st.opened {
        return Some("the user opened it".into());
    }
    if st.alerted {
        return Some("an urgent alert already reached the user".into());
    }
    None
}

pub struct CheckContext<'a> {
    pub now: f64,
    pub items: &'a HashMap<String, ItemState>,
    pub channels: &'a [String],
    pub on: &'a [String],
    pub night: &'a Night,
    pub night_opt_in: Option<bool>,
    pub feedback: &'a [String],
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckedStep {
    pub channel: String,
    pub after_min: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckedSend {
    pub level: String,
    pub one_line: String,
    pub why: String,
    pub keys: Vec<String>,
    pub steps: Vec<CheckedStep>,
    pub followed: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CheckedDecision {
    pub sends: Vec<CheckedSend>,
    pub next_wake_at: f64,
    pub notes: String,
    pub log: String,
    pub fixes: Vec<String>,
}

pub fn you_said(line: &str) -> String {
    format!("You said: \"{line}\"")
}

/// When the night before `now` ended, or None when there is no night.
pub fn last_night_end(now: f64, n: &Night) -> Option<f64> {
    let (s, e) = (hm(&n.start)?, hm(&n.end)?);
    if s == e {
        return None;
    }
    let p = local::parts(now);
    let mut end = local::make(p.year, p.month0 as i64, p.day as i64, e / 60, e % 60);
    if end > now {
        end = local::make(p.year, p.month0 as i64, p.day as i64 - 1, e / 60, e % 60);
    }
    Some(end)
}

/// When the next routine summary may go out: None when one may go now, else when the 3-hour gap ends.
pub fn summary_allowed_at(last: Option<f64>, now: f64, n: &Night) -> Option<f64> {
    let last = last.filter(|x| x.is_finite())?;
    let at = last + SUMMARY_GAP_MS;
    if at <= now {
        return None;
    }
    if let Some(morning) = last_night_end(now, n)
        && last < morning
    {
        return None;
    }
    Some(at)
}

/// A channel that is off falls to the next one on (in the board's order, wrapping round).
pub fn channel_for(wanted: &str, channels: &[String], on: &[String]) -> Option<String> {
    if on.iter().any(|c| c == wanted) {
        return Some(wanted.to_string());
    }
    let first = on.first()?;
    let Some(i) = channels.iter().position(|c| c == wanted) else { return Some(first.clone()) };
    for k in 1..=channels.len() {
        let c = &channels[(i + k) % channels.len()];
        if on.contains(c) {
            return Some(c.clone());
        }
    }
    Some(first.clone())
}

/// The model's text as a decision value; Err for bad JSON (a failed run).
pub fn parse_decision(text: &str) -> Result<Value, String> {
    static FENCE_START: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(&format!(r"(?i)^```(?:json)?{}*", js::WS)).expect("fence"));
    static FENCE_END: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(&format!(r"```{}*$", js::WS)).expect("fence"));
    let t = trim(text);
    let t = FENCE_START.replace(t, "");
    let t = FENCE_END.replace(&t, "");
    js::parse(&t).ok_or_else(|| "the helper's answer was not valid JSON".to_string())
}

/// `JSON.stringify(v)` for a fix line (`undefined` when missing).
fn jstr(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js::stringify(v),
    }
}

fn num_text(v: f64) -> String {
    js_string(v)
}

/// JS `Math.round`.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// The board's checks on one decision (`checkDecision`).
pub fn check_decision(raw: &Value, c: &CheckContext) -> Result<CheckedDecision, String> {
    let bad = || "the helper's answer is missing sends or nextWakeIn".to_string();
    let r = raw.as_object().ok_or_else(bad)?;
    let sends_raw = r.get("sends").and_then(Value::as_array).ok_or_else(bad)?;
    let wake = r.get("nextWakeIn").and_then(Value::as_f64).filter(|x| x.is_finite()).ok_or_else(bad)?;
    let mut fixes: Vec<String> = Vec::new();
    let night = in_night(c.now, c.night);
    let mut used: Vec<String> = Vec::new();
    let mut sends = Vec::new();
    let mut ordered: Vec<&Value> = sends_raw.iter().filter(|s| s.is_object() || s.is_array()).collect();
    ordered.sort_by_key(|s| if s.get("level").and_then(Value::as_str) == Some("urgent") { 0 } else { 1 });
    for s in ordered {
        let level = match s.get("level").and_then(Value::as_str) {
            Some(l @ ("urgent" | "summary")) => l,
            _ => {
                fixes.push(format!("dropped a send with level {}", jstr(s.get("level"))));
                continue;
            }
        };
        let mut keys: Vec<String> = Vec::new();
        let empty = Vec::new();
        for k in s.get("itemKeys").and_then(Value::as_array).unwrap_or(&empty) {
            let ks = k.as_str();
            let st = ks.and_then(|k| c.items.get(k));
            if let Some(ks) = ks
                && keys.iter().any(|x| x == ks)
            {
                fixes.push(format!("dropped item {ks} named twice in one send"));
                continue;
            }
            let Some(st) = st.filter(|st| st.open && !st.snoozed && !used.iter().any(|u| Some(u.as_str()) == ks)) else {
                let snoozed = st.is_some_and(|st| st.snoozed);
                fixes.push(format!("dropped item {} (not waiting{})", js::stringify(k), if snoozed { ": snoozed" } else { "" }));
                continue;
            };
            let ks = ks.unwrap_or_default();
            if level == "urgent"
                && let Some(why) = urgent_refusal(st)
            {
                fixes.push(format!("dropped item {ks} from an urgent send ({why})"));
                continue;
            }
            keys.push(ks.to_string());
        }
        if keys.is_empty() {
            fixes.push(format!("dropped a {level} send with no items still waiting"));
            continue;
        }
        if level == "urgent" && night && c.night_opt_in != Some(true) {
            fixes.push("held an urgent send: it is night and the user hasn't allowed waking them".into());
            continue;
        }
        if level == "summary" && night {
            fixes.push("held a summary: it is night; it goes out when the night ends".into());
            continue;
        }
        if level == "summary" && keys.iter().all(|k| c.items.get(k).is_some_and(|st| st.told)) {
            fixes.push("dropped a summary with nothing new".into());
            continue;
        }
        used.extend(keys.iter().cloned());
        let one_line = cut(s.get("oneLine").and_then(Value::as_str).unwrap_or(""), ONE_LINE_MAX);
        if one_line.is_empty() {
            fixes.push(format!("a {level} send had no oneLine: the board wrote one"));
        }
        let followed = check_followed(s.get("followed"), c.feedback, &mut fixes);
        let why: Vec<String> = std::iter::once(cut(s.get("why").and_then(Value::as_str).unwrap_or(""), WHY_MAX))
            .chain(followed.iter().map(|f| you_said(f)))
            .filter(|x| !x.is_empty())
            .collect();
        let steps = if level == "urgent" { check_steps(s.get("escalation"), c, &mut fixes) } else { Vec::new() };
        sends.push(CheckedSend { level: level.into(), one_line, why: why.join(" "), keys, steps, followed });
    }
    let mins = MAX_WAKE_MIN.min(MIN_WAKE_MIN.max(wake));
    if mins != wake {
        fixes.push(format!("next wake {} min moved to {} min", num_text(wake), num_text(mins)));
    }
    Ok(CheckedDecision {
        sends,
        next_wake_at: c.now + js_round(mins * 60_000.0),
        notes: r.get("notes").and_then(Value::as_str).map(|n| head16(n, NOTES_MAX).to_string()).unwrap_or_default(),
        log: cut(r.get("log").and_then(Value::as_str).unwrap_or(""), LOG_MAX),
        fixes,
    })
}

/// A send's `followed`: the feedback lines its indexes name, in order, each once, at most `FOLLOWED_MAX`.
pub fn check_followed(raw: Option<&Value>, feedback: &[String], fixes: &mut Vec<String>) -> Vec<String> {
    let list = match raw {
        None | Some(Value::Null) => return Vec::new(),
        Some(Value::Array(a)) => a,
        Some(_) => {
            fixes.push("dropped followed: not a list".into());
            return Vec::new();
        }
    };
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for i in list {
        let n = i.as_f64().filter(|x| x.is_finite() && x.fract() == 0.0 && *x >= 0.0 && *x < feedback.len() as f64);
        let Some(n) = n.map(|x| x as usize).filter(|n| !trim(&feedback[*n]).is_empty()) else {
            fixes.push(format!("dropped followed {} (no such feedback line)", js::stringify(i)));
            continue;
        };
        if seen.contains(&n) {
            continue;
        }
        seen.push(n);
        if out.len() >= FOLLOWED_MAX {
            fixes.push(format!("quoted only {FOLLOWED_MAX} followed feedback lines"));
            break;
        }
        out.push(feedback[n].clone());
    }
    out
}

/// The urgent send's reminder plan after the checks.
pub fn check_steps(raw: Option<&Value>, c: &CheckContext, fixes: &mut Vec<String>) -> Vec<CheckedStep> {
    let mut list: Vec<CheckedStep> = raw
        .and_then(Value::as_array)
        .map(|a| a.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|x| {
            let ch = x.get("channel")?.as_str()?;
            let at = x.get("afterMin")?.as_f64().filter(|v| v.is_finite())?;
            Some(CheckedStep { channel: ch.to_string(), after_min: at.max(0.0) })
        })
        .collect();
    list.sort_by(|a, b| a.after_min.partial_cmp(&b.after_min).unwrap_or(std::cmp::Ordering::Equal));
    if c.on.is_empty() {
        fixes.push("no channel is on: the alert is only stored".into());
        return Vec::new();
    }
    if list.is_empty() {
        list.push(CheckedStep { channel: c.on[0].clone(), after_min: 0.0 });
    }
    if list[0].after_min != 0.0 {
        fixes.push(format!("first step moved from minute {} to 0", num_text(list[0].after_min)));
        list[0].after_min = 0.0;
    }
    let mut out: Vec<CheckedStep> = Vec::new();
    for s in list {
        let channel = channel_for(&s.channel, c.channels, c.on).unwrap_or_default();
        if channel != s.channel {
            fixes.push(format!("{} is off: step goes to {channel}", s.channel));
        }
        let mut at = s.after_min;
        if let Some(prev) = out.last() {
            let gap = if in_night(c.now + prev.after_min * 60_000.0, c.night) { NIGHT_STEP_GAP_MIN } else { STEP_GAP_MIN };
            if at < prev.after_min + gap {
                at = prev.after_min + gap;
            }
        }
        if at >= REMIND_MAX_MIN || out.len() >= REMIND_MAX_STEPS {
            fixes.push("reminders past 2 hours or 6 steps dropped".into());
            break;
        }
        out.push(CheckedStep { channel, after_min: at });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_a_decision() {
        let mut items = HashMap::new();
        items.insert("a".to_string(), ItemState { open: true, ..Default::default() });
        let ch = vec!["mac".to_string(), "webhook".into(), "push".into(), "telegram".into()];
        let on = vec!["mac".to_string(), "push".into()];
        let night = Night { start: "00:00".into(), end: "00:00".into() };
        let c = CheckContext { now: 0.0, items: &items, channels: &ch, on: &on, night: &night, night_opt_in: None, feedback: &[] };
        let raw = json!({ "sends": [{ "level": "urgent", "oneLine": "x", "why": "y", "itemKeys": ["a", "b"], "escalation": [{ "channel": "telegram", "afterMin": 1 }] }], "nextWakeIn": 0, "notes": "", "log": "l" });
        let d = check_decision(&raw, &c).unwrap();
        assert_eq!(d.sends[0].steps, vec![CheckedStep { channel: "mac".into(), after_min: 0.0 }]);
        assert_eq!(d.fixes, vec!["dropped item \"b\" (not waiting)", "first step moved from minute 1 to 0", "telegram is off: step goes to mac", "next wake 0 min moved to 1 min"]);
        assert_eq!(d.next_wake_at, 60_000.0);
    }
}
