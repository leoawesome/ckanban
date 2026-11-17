//! The run split of `ticketRuns` (`src/usage/ticket-usage.ts`) that follow-ups need: each run's number, kind and
//! cost. The whole Usage tab is R12's.

use std::collections::HashMap;

use serde_json::Value;

use crate::runs::activity_digest::ActivityDigest;

pub struct TicketRun {
    pub run: f64,
    pub kind: String,
    pub cost_usd: f64,
}

fn num(v: Option<&Value>) -> f64 {
    let n = crate::runs::js::number(v);
    if n.is_finite() { n } else { 0.0 }
}

/// `ticketRuns`: a run's cost is the growth of the session's running total since the last result.
pub fn ticket_runs(d: &ActivityDigest) -> Vec<TicketRun> {
    struct Cur {
        run: Value,
        r: TicketRun,
        marked: bool,
        done: bool,
    }
    let mut out: Vec<Cur> = Vec::new();
    let mut last_total: HashMap<String, f64> = HashMap::new();
    for e in &d.run_entries {
        let Some(ev) = e.get("event").filter(|v| v.is_object()) else { continue };
        let run = e.get("run").cloned().unwrap_or(Value::Null);
        let ty = ev.get("type").and_then(Value::as_str);
        let marker = ty == Some("ckanban_run");
        let init = ty == Some("system") && ev.get("subtype").and_then(Value::as_str) == Some("init");
        let new = match out.last() {
            None => true,
            Some(c) => marker || !crate::runs::js::strict_eq(&c.run, &run) || (init && c.done && !c.marked),
        };
        if new {
            let kind = if marker { ev.get("kind").and_then(Value::as_str).unwrap_or("run").to_string() } else { "run".into() };
            out.push(Cur { run: run.clone(), r: TicketRun { run: num(Some(&run)), kind, cost_usd: 0.0 }, marked: marker, done: false });
        }
        let cur = out.last_mut().expect("pushed");
        if init && !cur.marked && cur.r.kind == "run" && ev.get("permissionMode").and_then(Value::as_str) == Some("plan") {
            cur.r.kind = "planning".into();
        }
        if ty != Some("result") {
            continue;
        }
        cur.done = true;
        let sid = ev.get("session_id").map(crate::runs::js::to_string).unwrap_or_default();
        let total = num(ev.get("total_cost_usd"));
        let prev = last_total.get(&sid).copied().unwrap_or(0.0);
        let cost = if total >= prev { total - prev } else { total };
        last_total.insert(sid, total);
        cur.r.cost_usd += cost;
    }
    out.into_iter().map(|c| c.r).collect()
}
