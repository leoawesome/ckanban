//! Follow-ups (`src/board/board-followups.ts`, the watcher of `src/schedules/followup.ts`): Claude comes back to its
//! own ticket later. The time is saved on the ticket; when due, the same conversation is woken.

use std::sync::Arc;

use serde_json::{Value, json};

use super::board::{RunError, RunLoop, obj};
use super::followup::{FOLLOW_UP_LATE_MS, FOLLOW_UP_NOTE_MAX, FOLLOW_UP_REASON_MAX, follow_up_time, format_at, iso_ms, log_follow_up};
use super::types::ChatOptions;
use crate::index::ticket::Tk;
use crate::runs::js;

/// A follow-up refusal (`FollowUpError`): the routes answer 400.
fn fu(msg: impl Into<String>) -> RunError {
    RunError { status: 400, message: msg.into() }
}

fn iso(ms: f64) -> String {
    ckanban_core::time::iso(ms)
}

impl RunLoop {
    fn log_of(t: &Tk) -> Vec<Value> {
        t.get("followUpLog").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    /// `setFollowUp`: when Claude (or the user) wants the conversation woken again; replaces the pending one.
    pub fn set_follow_up(&self, slug: &str, id: &str, after: Option<&str>, at: Option<&str>, note: Option<&str>, cancel_on_reply: Option<bool>) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let note = note.map(js::trim).unwrap_or("");
        if note.is_empty() {
            return Err(fu("note is required: why you come back, and what to check then"));
        }
        if js::len16(note) > FOLLOW_UP_NOTE_MAX {
            return Err(fu(format!("note is too long (max {FOLLOW_UP_NOTE_MAX} characters): keep it to why and what to check")));
        }
        let now = self.now();
        let due = follow_up_time(after, at, now).map_err(fu)?;
        let follow = json!({ "dueAt": iso(due), "note": note, "cancelOnReply": cancel_on_reply != Some(false), "setAt": iso(now) });
        self.note(slug, id, &format!("Follow-up set for {}: {note}", format_at(&iso(due))));
        let log = log_follow_up(&Self::log_of(&t), json!({ "at": iso(now), "kind": "set", "dueAt": iso(due), "note": note }));
        self.patch(slug, id, obj(json!({ "followUp": follow, "followUpStopped": null, "followUpLog": log })))
    }

    /// `cancelFollowUp`: by "claude" (cancel_follow_up, with its reason) or "user" (Stop following up).
    pub fn cancel_follow_up(&self, slug: &str, id: &str, by: &str, reason: Option<&str>) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let why = reason.map(js::trim).filter(|w| !w.is_empty());
        if by == "claude" && why.is_none() {
            return Err(fu("reason is required: one line on why you stop following up"));
        }
        if let Some(w) = why
            && js::len16(w) > FOLLOW_UP_REASON_MAX
        {
            return Err(fu(format!("reason is too long (max {FOLLOW_UP_REASON_MAX} characters): one line")));
        }
        if by == "user" && !t.is("followUp") {
            return if t.is("followUpStopped") { self.patch(slug, id, obj(json!({ "followUpStopped": null }))) } else { Ok(t) };
        }
        let at = iso(self.now());
        self.note(slug, id, &if by == "user" { "Follow-up stopped by user.".to_string() } else { format!("Stopped following up: {}", why.unwrap_or("")) });
        let mut entry = json!({ "at": at, "kind": "cancelled", "by": by });
        if let Some(w) = why {
            entry["note"] = Value::String(w.into());
        }
        let stopped = if by == "claude" { json!({ "at": at, "reason": why.unwrap_or("") }) } else { Value::Null };
        self.patch(slug, id, obj(json!({ "followUp": null, "followUpStopped": stopped, "followUpLog": log_follow_up(&Self::log_of(&t), entry) })))
    }

    /// `userReplied`: the user wrote in the ticket chat; a cancel-on-reply follow-up stops.
    pub fn user_replied(&self, slug: &str, id: &str) {
        let Some(t) = self.get(slug, id) else { return };
        let Some(f) = t.get("followUp").filter(|f| js::truthy(Some(f))) else { return };
        let at = iso(self.now());
        if !js::truthy(f.get("cancelOnReply")) {
            self.patch_quiet(slug, id, obj(json!({ "followUpLog": log_follow_up(&Self::log_of(&t), json!({ "at": at, "kind": "replied" })) })));
            return;
        }
        self.note(slug, id, "Follow-up cancelled: you replied.");
        let log = log_follow_up(&log_follow_up(&Self::log_of(&t), json!({ "at": at, "kind": "replied" })), json!({ "at": at, "kind": "cancelled", "by": "reply" }));
        self.patch_quiet(slug, id, obj(json!({ "followUp": null, "followUpLog": log })));
    }

    /// `dueFollowUps`: tickets whose follow-up is due and that are free to take it.
    pub fn due_follow_ups(&self, slug: &str) -> Vec<String> {
        let now = self.now();
        let list = self.tickets.list(slug);
        list.tickets
            .iter()
            .filter(|t| {
                let Some(f) = t.get("followUp").filter(|f| js::truthy(Some(f))) else { return false };
                !js::truthy(f.get("missedAt"))
                    && f.get("dueAt").and_then(Value::as_str).map(iso_ms).is_some_and(|d| d <= now)
                    && !self.is_running(slug, &t.id)
                    && t.status != "in_progress"
                    && !t.is("slotWait")
                    && self.waiting(slug, &t.id).is_empty()
                    && !(t.s("outcome") == Some("limit") && t.is("limit"))
                    && !super::board::corrupt(t)
            })
            .map(|t| t.id.clone())
            .collect()
    }

    /// `wakeFollowUp`: wake the conversation for its follow-up. manual: the user's Follow up now.
    pub fn wake_follow_up(&self, slug: &str, id: &str, manual: bool) -> Result<Arc<Tk>, RunError> {
        // One decision: the button and the watcher can't both wake it.
        let _g = self.decide.lock();
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let Some(f) = t.get("followUp").filter(|f| js::truthy(Some(f))).cloned() else { return Err(fu("this ticket has no follow-up")) };
        if self.is_running(slug, id) || t.is("slotWait") {
            if manual {
                return Err(RunError::conflict("Claude is working on this ticket; follow up once it has finished"));
            }
            return Ok(t);
        }
        let now = self.now();
        let due = f.get("dueAt").and_then(Value::as_str).unwrap_or("").to_string();
        let late = now - iso_ms(&due);
        if !manual && late > FOLLOW_UP_LATE_MS {
            if js::truthy(f.get("missedAt")) {
                return Ok(t);
            }
            self.note(slug, id, &format!("Missed follow-up: it was due {}, while the computer was asleep or the board was off. Press Follow up now to let Claude check, or stop it.", format_at(&due)));
            let mut missed = f.clone();
            missed["missedAt"] = Value::String(iso(now));
            let log = log_follow_up(&Self::log_of(&t), json!({ "at": iso(now), "kind": "missed", "dueAt": due }));
            return self.patch(slug, id, obj(json!({ "followUp": missed, "followUpLog": log })));
        }
        let text = crate::prompts::chat::follow_up_wake_prompt(&super::prompt::prompt_ticket(&t), now, manual);
        let log = log_follow_up(&Self::log_of(&t), json!({ "at": iso(now), "kind": "woke", "dueAt": due, "note": f.get("note").cloned().unwrap_or(Value::Null) }));
        self.patch(slug, id, obj(json!({ "followUp": null, "followUpLog": log })))?;
        match self.chat(slug, id, &text, ChatOptions { follow_up: true, ..Default::default() }) {
            Ok(t) => Ok(t),
            Err(e) => {
                if let Some(cur) = self.get(slug, id)
                    && !cur.is("followUp")
                {
                    let old = t.get("followUpLog").cloned().unwrap_or_else(|| json!([]));
                    self.patch_quiet(slug, id, obj(json!({ "followUp": f, "followUpLog": old })));
                }
                Err(e)
            }
        }
    }

    /// `followUpCost`: a follow-up run's cost goes on its "woke" log entry.
    pub(super) async fn follow_up_cost(self: &Arc<Self>, slug: &str, id: &str) {
        let Some(t) = self.get(slug, id) else { return };
        if Self::log_of(&t).is_empty() {
            return;
        }
        let file = self.tickets.ticket_dir(slug, id).join("activity.jsonl");
        let digest = self.digests.get(&file).await;
        let me = self.clone();
        let (slug, id) = (slug.to_string(), id.to_string());
        let _ = tokio::task::spawn_blocking(move || {
            let Some(t) = me.get(&slug, &id) else { return };
            let log = Self::log_of(&t);
            if log.is_empty() {
                return;
            }
            let runs = crate::extras::usage::ticket_runs(&digest.run_entries);
            let Some(run) = runs.iter().rev().find(|r| r.kind.as_str() == Some("follow-up")) else { return };
            let Some(i) = log.iter().rposition(|e| e.get("kind").and_then(Value::as_str) == Some("woke")) else { return };
            if log[i].get("costUsd").is_some() {
                return;
            }
            let mut log2 = log.clone();
            log2[i]["run"] = run.run.clone();
            log2[i]["costUsd"] = ckanban_core::jsnum::num((run.cost_usd * 10_000.0).round() / 10_000.0);
            let woke_at = log[i].get("at").and_then(Value::as_str).unwrap_or("");
            let said = t.is("followUp") || t.get("followUpStopped").and_then(|s| s.get("at")).and_then(Value::as_str).is_some_and(|a| a >= woke_at);
            let mut p = obj(json!({ "followUpLog": log2 }));
            if !said {
                p.insert("followUpStopped".into(), json!({ "at": iso(me.now()), "reason": "no next follow-up was set" }));
            }
            me.patch_quiet(&slug, &id, p);
        })
        .await;
    }

    /// One pass of the follow-up watcher (blocking).
    pub fn follow_up_tick(&self) {
        for slug in self.boards() {
            for id in self.due_follow_ups(&slug) {
                if let Err(e) = self.wake_follow_up(&slug, &id, false) {
                    eprintln!("ticket {slug}/{id}: follow-up wake failed: {e}");
                }
            }
        }
    }

    /// `markSeen`: the user opened the ticket (at most one write per 5 minutes unless forced).
    pub fn mark_seen(&self, slug: &str, id: &str, force: bool) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let now = self.now();
        if !force && t.s("seenAt").map(iso_ms).is_some_and(|s| now - s < 5.0 * 60_000.0) {
            return Ok(t);
        }
        self.patch(slug, id, obj(json!({ "seenAt": iso(now) })))
    }
}
