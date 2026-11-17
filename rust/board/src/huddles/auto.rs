//! Auto huddles (`src/huddle/huddle-auto.ts`, the slot part of `huddle.ts` and `huddle-lifecycle.ts`): an unattended
//! run of the host ticket starts its own review huddle (`POST /huddles/auto`, the start_huddle tool); one auto huddle
//! is live per board, the others wait for the slot (the card stays In Progress) and are woken one at a time when it
//! frees. When an auto huddle ends, the host is woken (a brake stopped it) or sent to Review (the user stopped it).
//! A run whose chat answers the user's own message may start a huddle with trigger "user" (`startForUser`).
//!
//! Everything here runs under the room's lock (`Huddles::op`).

use serde_json::{Value, json};

use super::agents::{Agents, typed_huddle};
use super::model::*;
use super::service::{AutoInput, AutoStart, Huddles, Origin, R, UserStart};
use crate::prompts::deps::{REVIEW_HUDDLE_HEADING, USER_HUDDLE_TRIGGER, review_huddle_request};
use crate::prompts::huddle as hp;
use crate::prompts::types as pt;
use crate::runloop::types::ChatOptions;
use crate::team::Fail;

/// Most an auto huddle may ask for (`AUTO_MAX_COST_USD`).
pub const AUTO_MAX_COST_USD: f64 = 100.0;
/// start_huddle's triggers (`AUTO_HUDDLE_TRIGGERS`).
pub const AUTO_HUDDLE_TRIGGERS: [&str; 5] = ["security", "data", "payments", "important", "asked"];

fn fail<T>(status: u16, msg: impl Into<String>) -> R<T> {
    Err(Fail::new(status, msg))
}

fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

/// `autoHuddlesOn`: a board has auto huddles unless it turned them off.
fn auto_huddles_on(profile: Option<&serde_json::Map<String, Value>>) -> bool {
    crate::runloop::prompt::auto_huddles_on(profile)
}

impl Agents {
    /// `unattendedRun`: the ticket's current run works unattended on its own ticket (not a chat reply).
    fn unattended_run(&self, slug: &str, id: &str) -> bool {
        let Some(r) = self.board.run_of(slug, id) else { return false };
        let st = r.st.lock();
        if st.stop_requested {
            return false;
        }
        st.chat.as_ref().is_none_or(|c| c.host_wake)
    }

    /// `claimAutoHuddle`: false when this run already started one (one per run).
    fn claim_auto_huddle(&self, slug: &str, id: &str) -> bool {
        let Some(r) = self.board.run_of(slug, id) else { return false };
        let mut st = r.st.lock();
        if st.auto_huddle_started {
            return false;
        }
        st.auto_huddle_started = true;
        true
    }

    /// `userAskedRun`: the run answers a message the user typed (not a slash command), or one handed to it.
    fn user_asked_run(&self, slug: &str, id: &str) -> bool {
        let Some(r) = self.board.run_of(slug, id) else { return false };
        let st = r.st.lock();
        !st.stop_requested && (st.chat.as_ref().is_some_and(|c| c.user && c.slash.is_none()) || st.user_steered)
    }

    /// `setAutoHuddle`: the ticket's auto huddle state, with `extra` fields.
    fn set_auto_huddle(&self, h: &Huddles, slug: &str, id: &str, auto: Value, extra: Obj) {
        if h.ticket(slug, id).is_none() {
            return;
        }
        let mut patch = obj_of([("autoHuddle", auto)]);
        patch.extend(extra);
        if let Err(e) = self.board.patch(slug, id, patch) {
            eprintln!("[huddle] {slug}/{id}: {}", e.message);
        }
    }

    /// `startAuto`.
    pub(super) fn start_auto_now(&self, h: &Huddles, slug: &str, host_id: &str, input: &AutoInput) -> R<(Option<Obj>, bool, String)> {
        let profile = self.board.profile(slug);
        let host = h.ticket(slug, host_id);
        let (Some(profile), Some(host)) = (profile, host) else { return fail(404, format!("ticket {host_id} not found")) };
        let reason: String = crate::prompts::js::trim(&input.reason).split_whitespace().collect::<Vec<_>>().join(" ");
        let reason = crate::prompts::js::slice16(&reason, 200).to_string();
        if reason.is_empty() {
            return fail(400, "reason is required: one line on why this work needs a review huddle");
        }
        let propose = "; use propose_huddle to propose one to the user instead (with the same maxCostUsd)";
        if let Some(m) = input.max_cost_usd
            && !(m.is_finite() && m > 0.0)
        {
            return fail(400, "maxCostUsd must be a positive amount");
        }
        let trigger = input.trigger.as_deref().map(crate::prompts::js::trim).map(str::to_string);
        let template_in = input.template.as_deref().map(crate::prompts::js::trim).filter(|t| !t.is_empty()).map(str::to_string);
        if trigger.as_deref() == Some(USER_HUDDLE_TRIGGER) {
            let huddle = self.start_for_user(h, slug, host_id, &host.status, input, &reason)?;
            return Ok((Some(huddle), false, template_in.unwrap_or_else(|| "custom".into())));
        }
        // A ticket with a "## Review huddle" section asked for one in Planning: that counts as opt-in, and gives the defaults.
        let requested = review_huddle_request(&host.body);
        let asked = input.max_cost_usd.or(requested.as_ref().and_then(|r| r.max_cost_usd));
        let max_cost = asked.map(|a| a.min(AUTO_MAX_COST_USD));
        if !auto_huddles_on(Some(&profile)) && requested.is_none() {
            return fail(403, format!("auto huddles are off on board {slug} and the ticket has no \"{REVIEW_HUDDLE_HEADING}\" section{propose}"));
        }
        if !self.unattended_run(slug, host_id) {
            return fail(403, format!("start_huddle only works in an unattended run of the ticket (Ready / In Progress work, a plan child, a schedule run), not in a chat{propose}"));
        }
        if let Some(open) = h.files.open(slug).iter().find(|x| s(x, "hostTicket") == host_id) {
            return fail(409, format!("ticket {host_id} already has an open huddle ({}){propose}, or post in that one", s(open, "id")));
        }
        // The trigger names the rule that called for the review, so the user can check it on the ticket.
        let Some(trigger) = trigger.filter(|t| AUTO_HUDDLE_TRIGGERS.contains(&t.as_str())) else {
            return fail(
                400,
                format!(
                    "trigger is required: one of {}, {USER_HUDDLE_TRIGGER} (the rule that calls for this review, or {USER_HUDDLE_TRIGGER} when the user's own message asked for it)",
                    AUTO_HUDDLE_TRIGGERS.join(", ")
                ),
            );
        };
        if trigger == "asked" && requested.is_none() {
            return fail(400, format!("trigger \"asked\" is only for a ticket with a \"{REVIEW_HUDDLE_HEADING}\" section; this one has none"));
        }
        if trigger == "important" && !crate::team::jsv::truthy(host.json.get("important")) {
            return fail(400, "trigger \"important\" is only for a ticket marked ⭐ Important; this one isn't");
        }
        let roster = input.roster.clone().filter(|r| !r.is_empty());
        // A huddle the ticket asks for uses the template it names; otherwise the run builds a roster for this change.
        let template = template_in.or_else(|| if roster.is_none() && trigger == "asked" { requested.as_ref().and_then(|r| r.template.clone()) } else { None }).unwrap_or_default();
        if roster.is_none() && !(trigger == "asked" && !template.is_empty()) {
            return fail(
                400,
                format!(
                    "pass a roster built for this change (trigger {trigger}): 1-4 reviewers or testers whose prompts say what to check, plus a lead (e.g. qa-lead) when there are 2 or more; list_huddle_presets lists the teammates you can use"
                ),
            );
        }
        let templates = h.team.templates(slug);
        if !template.is_empty() && !templates.iter().any(|t| s(t, "name") == template) {
            let names = templates.iter().map(|t| s(t, "name")).collect::<Vec<_>>().join(", ");
            return fail(404, format!("no huddle template \"{template}\" (templates: {names})"));
        }
        let topic = crate::team::templates::topic_input(input.topic.as_ref().map(|t| Value::from(t.clone())).as_ref()).map_err(|e| Fail::new(400, e))?;
        let label = if template.is_empty() { "custom".to_string() } else { template.clone() };
        let busy = self.live_auto(h, slug).into_iter().find(|x| s(x, "hostTicket") != host_id);
        if let Some(busy) = busy {
            let was = host.json.get("autoHuddle").filter(|a| a.get("state").and_then(Value::as_str) == Some("waiting"));
            let at = was.and_then(|a| a.get("at").and_then(Value::as_str)).map(str::to_string).unwrap_or_else(now_iso);
            let mut a = json!({ "state": "waiting", "reason": reason, "trigger": trigger, "template": label, "at": at, "huddleId": null });
            if let Some(m) = max_cost {
                a["maxCostUsd"] = num(m);
            }
            if let Some(t) = &topic {
                a["topic"] = Value::from(t.clone());
            }
            self.set_auto_huddle(h, slug, host_id, a, Obj::new());
            if was.is_none() {
                self.board.note(slug, host_id, &format!("Auto huddle wanted ({trigger}: {reason}); waiting for huddle slot: ticket {} has the board's auto huddle.", s(&busy, "hostTicket")));
            }
            return Ok((None, true, label));
        }
        if !self.claim_auto_huddle(slug, host_id) {
            return fail(409, "this run already started an auto huddle (one per run); finish with the findings you have");
        }
        let origin = Origin { auto: Some(AutoStart { reason: reason.clone(), asked, trigger: Some(trigger.clone()) }), by_user: None };
        let topic_v = topic.clone().map(Value::from);
        let tpl = (!template.is_empty()).then_some(template.as_str());
        let huddle = h.create_by(slug, host_id, roster.unwrap_or_default(), None, max_cost, tpl, topic_v.as_ref(), &origin)?;
        {
            let mut w = self.slot_woken.lock();
            if w.get(slug).is_some_and(|x| x == host_id) {
                w.remove(slug);
            }
        }
        let a = json!({ "state": "live", "reason": reason, "trigger": trigger, "template": label, "at": s(&huddle, "createdAt"), "huddleId": s(&huddle, "id") });
        self.set_auto_huddle(h, slug, host_id, a, Obj::new());
        let what = if template.is_empty() { "custom roster".to_string() } else { template.clone() };
        self.board.note(slug, host_id, &format!("Auto huddle started ({what}, {trigger}): {reason}"));
        Ok((Some(huddle), false, label))
    }

    /// `startForUser`: trigger "user": the user typed in the ticket's chat that a huddle should start now.
    fn start_for_user(&self, h: &Huddles, slug: &str, host_id: &str, status: &str, input: &AutoInput, reason: &str) -> R<Obj> {
        let propose = "; call propose_huddle instead so the user can press Start on the card";
        if status == "planning" || status == "backlog" {
            let col = if status == "planning" { "Planning" } else { "Backlog" };
            return fail(403, format!("in {col} a huddle only starts when the user presses Start on a proposal card{propose}"));
        }
        if !self.user_asked_run(slug, host_id) {
            return fail(403, format!("trigger {USER_HUDDLE_TRIGGER} only works while this ticket's run answers a message the user typed in its chat{propose}"));
        }
        let template = input.template.as_deref().map(crate::prompts::js::trim).filter(|t| !t.is_empty()).map(str::to_string);
        let roster = input.roster.clone().unwrap_or_default();
        if roster.is_empty() && template.is_none() {
            return fail(400, "pass a template or a roster: the roles the user asked for, each prompt saying what to do, plus a lead (e.g. qa-lead) when there are 2 or more");
        }
        let max_cost = input.max_cost_usd.map(|m| m.min(AUTO_MAX_COST_USD));
        let origin = Origin { auto: None, by_user: Some(UserStart { reason: reason.to_string(), asked: input.max_cost_usd }) };
        let topic = input.topic.as_ref().map(|t| Value::from(t.clone()));
        let huddle = h.create_by(slug, host_id, roster, None, max_cost, template.as_deref(), topic.as_ref(), &origin)?;
        let what = template.unwrap_or_else(|| "custom roster".into());
        self.board.note(slug, host_id, &format!("Huddle started because the user asked in the chat ({what}): {reason}"));
        Ok(huddle)
    }

    /// `liveAuto`: the board's live auto huddles (at most one, unless the user resumed a stopped one).
    fn live_auto(&self, h: &Huddles, slug: &str) -> Vec<Obj> {
        h.files.open(slug).iter().filter(|x| is_auto(x) && s(x, "status") == "live").map(|x| (**x).clone()).collect()
    }

    /// `autoEnded`: closed by @main or because the host is done or deleted; halt: a brake stopped it (the host is
    /// woken to decide whether it may land); user: the user stopped or closed it (a host that only waited for it goes
    /// to Review). Then the next ticket waiting for the slot gets it.
    pub(super) fn auto_ended_now(&self, h: &Huddles, slug: &str, hid: &str, how: &str, why: &str) {
        let x = h.load(slug, hid);
        let t = x.as_ref().and_then(|x| h.ticket(slug, s(x, "hostTicket")));
        if let (Some(x), Some(t)) = (&x, &t)
            && t.json.get("autoHuddle").and_then(|a| a.get("huddleId")).and_then(Value::as_str) == Some(hid)
        {
            let idle = t.status == "in_progress" && !self.board.is_running(slug, &t.id);
            if how == "user" && idle {
                self.board.note(slug, &t.id, &format!("Auto huddle ended: {why}. The work was not landed."));
                self.set_auto_huddle(h, slug, &t.id, Value::Null, obj_of([("status", "review".into()), ("outcome", "stopped".into()), ("lastActivity", Value::Null)]));
            } else {
                self.set_auto_huddle(h, slug, &t.id, Value::Null, Obj::new());
            }
            if how == "halt" && t.status != "done" {
                let open = list(x, "findings").iter().filter(|f| s(f, "status") == "open").count();
                let text = hp::auto_huddle_stopped_prompt(&typed_huddle(x), why, open);
                if let Err(e) = self.board.chat(slug, &t.id, &text, ChatOptions { host_wake: true, ..Default::default() }) {
                    self.board.note(slug, &t.id, &format!("Auto huddle stopped ({why}) and the ticket couldn't be woken: {}", e.message));
                }
            }
        }
        // After this change: the slot's next waiter.
        let me = self.arc();
        let slug = slug.to_string();
        self.rt.spawn(async move {
            let s2 = slug.clone();
            let m = me.clone();
            me.op(move |h| m.free_slot(h, &s2)).await;
        });
    }

    /// `freeSlot`: no auto huddle is live on the board: wake the ticket that has waited longest (one at a time).
    pub(super) fn free_slot(&self, h: &Huddles, slug: &str) {
        if h.shutting_down.load(std::sync::atomic::Ordering::Relaxed) || self.board.restart_pending() || !self.live_auto(h, slug).is_empty() {
            return;
        }
        let woken = self.slot_woken.lock().get(slug).cloned();
        if let Some(w) = woken {
            let t = h.ticket(slug, &w);
            let queued = t.as_ref().is_some_and(|t| {
                t.json.get("queued").and_then(Value::as_array).is_some_and(|q| {
                    q.iter().any(|m| m.get("state").and_then(Value::as_str) == Some("queued") && crate::team::jsv::truthy(m.get("hostWake")))
                })
            });
            if t.is_some() && (self.board.is_running(slug, &w) || queued) {
                return;
            }
            self.slot_woken.lock().remove(slug);
        }
        let list = self.board.tickets.list(slug);
        let next = list
            .tickets
            .iter()
            .filter(|t| t.status == "in_progress" && t.json.get("autoHuddle").and_then(|a| a.get("state")).and_then(Value::as_str) == Some("waiting"))
            .min_by(|a, b| {
                let at = |t: &crate::index::ticket::Tk| t.json.get("autoHuddle").and_then(|a| a.get("at")).and_then(Value::as_str).unwrap_or("").to_string();
                at(a).cmp(&at(b))
            })
            .cloned();
        let Some(next) = next else { return };
        let a = next.json.get("autoHuddle").cloned().unwrap_or(Value::Null);
        self.slot_woken.lock().insert(slug.to_string(), next.id.clone());
        // It no longer waits: its run takes the slot with start_huddle, or lands without one.
        self.set_auto_huddle(h, slug, &next.id, Value::Null, obj_of([("lastActivity", "Huddle slot free: resuming".into())]));
        let typed: pt::AutoHuddle = serde_json::from_value(a.clone()).unwrap_or_default();
        if let Err(e) = self.board.chat(slug, &next.id, &hp::auto_huddle_slot_prompt(&typed), ChatOptions { host_wake: true, ..Default::default() }) {
            self.slot_woken.lock().remove(slug);
            self.set_auto_huddle(h, slug, &next.id, a, Obj::new());
            eprintln!("couldn't wake {slug}/{} for the auto-huddle slot: {}", next.id, e.message);
        }
    }

    /// The end of `recover` for a board: a ticket waiting on an auto huddle that is gone goes back to Review; then the
    /// slot.
    pub(super) fn recover_auto(&self, h: &Huddles, slug: &str) {
        let list = self.board.tickets.list(slug);
        for t in list.tickets.iter() {
            let Some(a) = t.json.get("autoHuddle").filter(|a| a.get("state").and_then(Value::as_str) == Some("live")) else { continue };
            let x = a.get("huddleId").and_then(Value::as_str).and_then(|id| h.load(slug, id));
            if x.as_ref().is_some_and(|x| matches!(s(x, "status"), "live" | "stopped")) {
                continue;
            }
            self.board.note(slug, &t.id, "Its auto huddle is no longer open; the work was not landed.");
            let extra = if self.board.is_running(slug, &t.id) {
                Obj::new()
            } else {
                obj_of([("status", "review".into()), ("outcome", "stopped".into()), ("lastActivity", Value::Null)])
            };
            self.set_auto_huddle(h, slug, &t.id, Value::Null, extra);
        }
        self.free_slot(h, slug);
    }

    /// `ticket.updated` (see `wants_ticket`): a host moved to Done has its earlier huddles' outputs cleaned once per
    /// move; a ticket woken for a free slot whose run ended without taking it passes the slot on.
    pub(super) fn on_ticket(&self, h: &Huddles, slug: &str, t: &Obj) {
        let id = s(t, "id").to_string();
        if s(t, "status") == "done"
            && let Some(done_at) = opt_s(t, "doneAt")
        {
            let key = format!("{slug}/{id}");
            let fresh = {
                let mut d = self.done_cleaned.lock();
                if d.0.get(&key).map(String::as_str) == Some(done_at) {
                    false
                } else if h.files.index(slug).iter().any(|x| s(x, "hostTicket") == id && s(x, "status") == "closed") {
                    d.0.insert(key.clone(), done_at.to_string());
                    d.1.retain(|k| k != &key);
                    d.1.push_back(key.clone());
                    if d.1.len() > 2000
                        && let Some(old) = d.1.pop_front()
                    {
                        d.0.remove(&old);
                    }
                    true
                } else {
                    false
                }
            };
            if fresh {
                let me = self.arc();
                self.chore(me.clean_outputs(slug.to_string(), id.clone(), None));
            }
        }
        if self.slot_woken.lock().get(slug).is_some_and(|w| *w == id) && !self.board.is_running(slug, &id) {
            self.free_slot(h, slug);
        }
    }
}

fn obj_of<const N: usize>(kv: [(&str, Value); N]) -> Obj {
    kv.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}
