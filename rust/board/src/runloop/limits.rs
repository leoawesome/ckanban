//! Caps, stalls and plan-limit waits (`src/board/board-limits.ts`) and the watcher that sends the automatic
//! "continue" once a usage limit has reset (`LimitWatcher` of `src/usage/limit.ts`).

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::{RunError, RunLoop, now_iso, obj};
use super::limit::{AUTO_CONTINUE_PER_DAY, CONTINUE_DELAY_MS, CONTINUE_TEXT, clock_time, day_key, parse_reset};
use super::types::ChatOptions;
use crate::index::ticket::Tk;
use crate::runs::runner::DEFAULT_STALL_MINUTES;

/// `n.toFixed(2)`.
pub fn fixed2(n: f64) -> String {
    format!("{:.2}", (n * 100.0).round() / 100.0)
}

impl RunLoop {
    /// `stallMs`: the watchdog time for this board's runs in ms (0: off).
    pub fn stall_ms(&self, profile: &Map<String, Value>) -> u64 {
        if let Some(ms) = self.opts.stall_ms {
            return ms;
        }
        let m = profile.get("stallMinutes").and_then(Value::as_f64).unwrap_or(DEFAULT_STALL_MINUTES as f64);
        if m > 0.0 { (m * 60_000.0) as u64 } else { 0 }
    }

    /// `stallAction`: the Inbox's answer to a stalled run (stop, wait, restart).
    pub fn stall_action(&self, slug: &str, id: &str, action: &str) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let run = self.run_of(slug, id);
        let handle = run.as_ref().and_then(|r| r.st.lock().handle.clone());
        let (Some(run), Some(h)) = (run, handle) else {
            if t.is("stalled") {
                return self.patch(slug, id, obj(json!({ "stalled": null })));
            }
            return Err(RunError::other("this ticket has no running run"));
        };
        if !t.is("stalled") || run.st.lock().restart_requested {
            return Err(RunError::other("this run is not stalled anymore"));
        }
        match action {
            "stop" => self.stop_run(&run),
            "wait" => {
                h.keep_waiting();
                self.note(slug, id, "Kept waiting on the stalled run.");
                self.patch(slug, id, obj(json!({ "stalled": null })))?;
            }
            _ => {
                run.st.lock().restart_requested = true;
                self.patch(slug, id, obj(json!({ "lastActivity": "Restarting…" })))?;
                h.stop();
            }
        }
        self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))
    }

    /// `capReached`: blocked until the user continues it with more budget.
    pub(super) fn cap_reached(&self, slug: &str, id: &str, base: Map<String, Value>, cap: f64, with_workflows: Option<f64>) {
        let msg = format!("Stopped at ${} cap", fixed2(cap));
        let why = match with_workflows {
            None => "this run spent its budget before it finished".to_string(),
            Some(w) => format!("this run and its workflow's helper agents spent ${}, so the board stopped the run and its workflow", fixed2(w)),
        };
        self.note(slug, id, &format!("{msg}: {why}. Continue it with more budget, or change the ticket's cap in its ⋯ menu."));
        let mut p = base;
        p.extend(obj(json!({ "outcome": "blocked", "error": msg, "capHit": { "capUsd": ckanban_core::jsnum::num(cap), "at": now_iso() } })));
        self.patch_quiet(slug, id, p);
    }

    /// `continueAfterCap`: "Continue with +$Y": "continue" in the same session, with a cap of add for that run.
    pub fn continue_after_cap(&self, slug: &str, id: &str, add: f64) -> Result<Arc<Tk>, RunError> {
        let _g = self.decide.lock();
        self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        if !(add.is_finite() && add > 0.0) {
            return Err(RunError::other("addUsd must be a positive amount"));
        }
        if self.is_running(slug, id) {
            return Err(RunError::other("this ticket is already running"));
        }
        self.patch(slug, id, obj(json!({ "capNextUsd": ckanban_core::jsnum::num(add) })))?;
        match self.chat(slug, id, CONTINUE_TEXT, ChatOptions::default()) {
            Ok(t) => Ok(t),
            Err(e) => {
                self.patch_quiet(slug, id, obj(json!({ "capNextUsd": null })));
                Err(e)
            }
        }
    }

    /// `limitHit`: wait for the reset, then continue on its own unless turned off or capped.
    pub(super) fn limit_hit(&self, slug: &str, id: &str, base: Map<String, Value>, message: &str) {
        let Some(t) = self.get(slug, id) else { return };
        let now = self.now();
        let reset = parse_reset(message, now);
        let today = day_key(now);
        let used = t.get("autoContinued").filter(|a| a.get("day").and_then(Value::as_str) == Some(&today)).and_then(|a| a.get("count")).and_then(Value::as_f64).unwrap_or(0.0);
        let capped = used >= AUTO_CONTINUE_PER_DAY as f64;
        let off = t.get("autoContinue") == Some(&Value::Bool(false));
        let auto = !off && !capped;
        let mut limit = obj(json!({ "resetAt": ckanban_core::time::iso(reset), "auto": auto, "at": ckanban_core::time::iso(now), "message": message }));
        if capped && !off {
            limit.insert("capped".into(), Value::Bool(true));
        }
        let when = clock_time(reset, now);
        let next = if auto {
            format!("It continues automatically at {when}.")
        } else if capped && !off {
            format!("It resets at {when}; it already continued automatically {AUTO_CONTINUE_PER_DAY} times today, so continue it yourself.")
        } else {
            format!("It resets at {when}.")
        };
        self.note(slug, id, &format!("Usage limit hit: {message}\n{next}"));
        let mut p = base;
        p.extend(obj(json!({ "outcome": "limit", "error": message, "limit": limit })));
        self.patch_quiet(slug, id, p);
    }

    /// `continueAfterLimit`: "continue" to the same session through the normal chat path. auto: the board's own.
    pub fn continue_after_limit(&self, slug: &str, id: &str, auto: bool) -> Result<Arc<Tk>, RunError> {
        // One decision: Continue now and the automatic continue can't both send "continue".
        let _g = self.decide.lock();
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        if auto {
            let waits = t.s("outcome") == Some("limit") && t.get("limit").and_then(|l| l.get("auto")).is_some_and(|a| crate::runs::js::truthy(Some(a)));
            if !waits || self.is_running(slug, id) {
                return Ok(t);
            }
            let day = day_key(self.now());
            let prev = t.get("autoContinued").filter(|a| a.get("day").and_then(Value::as_str) == Some(&day)).and_then(|a| a.get("count")).and_then(Value::as_f64).unwrap_or(0.0);
            self.patch(slug, id, obj(json!({ "autoContinued": { "day": day, "count": ckanban_core::jsnum::num(prev + 1.0) } })))?;
            self.note(slug, id, "The usage limit has reset: sent \"continue\".");
        }
        self.chat(slug, id, CONTINUE_TEXT, ChatOptions::default())
    }

    /// `setAutoContinue`: for the current wait and later limit hits of this ticket.
    pub fn set_auto_continue(&self, slug: &str, id: &str, auto: bool) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let mut p = obj(json!({ "autoContinue": auto }));
        if let Some(Value::Object(l)) = t.get("limit") {
            let mut l = l.clone();
            l.insert("auto".into(), Value::Bool(auto));
            l.remove("capped");
            p.insert("limit".into(), Value::Object(l));
        }
        let out = self.patch(slug, id, p)?;
        if t.parent_id.is_some() {
            self.families.advance_plans(slug);
        }
        Ok(out)
    }

    /// `dueContinues`: tickets waiting for a usage limit to reset whose automatic continue is due.
    pub fn due_continues(&self, slug: &str, delay_ms: f64) -> Vec<String> {
        let now = self.now();
        let list = self.tickets.list(slug);
        list.tickets
            .iter()
            .filter(|t| {
                let l = t.get("limit");
                t.s("outcome") == Some("limit")
                    && l.and_then(|l| l.get("auto")).is_some_and(|a| crate::runs::js::truthy(Some(a)))
                    && !self.is_running(slug, &t.id)
                    && t.status != "done"
                    && l.and_then(|l| l.get("resetAt")).and_then(Value::as_str).map(super::followup::iso_ms).is_some_and(|r| r + delay_ms <= now)
            })
            .map(|t| t.id.clone())
            .collect()
    }

    /// One pass of the limit watcher (blocking).
    pub fn limit_tick(&self) {
        for slug in self.boards() {
            for id in self.due_continues(&slug, CONTINUE_DELAY_MS) {
                if let Err(e) = self.continue_after_limit(&slug, &id, true) {
                    eprintln!("ticket {slug}/{id}: automatic continue after the usage limit failed: {e}");
                }
            }
        }
    }

    /// The boards (folders under `profiles/`).
    pub fn boards(&self) -> Vec<String> {
        self.tickets.index.board_slugs()
    }
}
