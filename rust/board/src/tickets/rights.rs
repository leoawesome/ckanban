//! Who may change which ticket (`runRights` and its helpers in `src/api/context.ts`, `plannerRights`,
//! `userRequestRights`, `runnerRights`, `userAskedRun` and `runStart` in `src/board/board-plans.ts`).
//!
//! Board runs send `x-ckanban-run: <board>/<ticket>`; the user sends nothing. What a run may do depends on its live
//! state (`hooks::RunState`, R7a): until the run loop lands nothing runs, so only a main ticket whose plan is active
//! has rights from its file (`planActive`).

use std::sync::Arc;

use serde_json::{Value, json};

use super::hooks::BoardHooks;
use super::writer::{Refusal, Tickets};
use crate::index::attention::plan_active;
use crate::index::family::family_of;
use crate::index::ticket::Tk;

/// `MAX_RUN_RETURNS` and `RUN_CHAIN_KEEP` in plan.ts.
const MAX_RUN_RETURNS: usize = 2;
const RUN_CHAIN_KEEP: usize = 20;

/// A chat on another board acting for the user here: its board and ticket.
#[derive(Clone)]
pub struct Guest {
    pub slug: String,
    pub ticket: Arc<Tk>,
}

/// `runRights`' answer; all None for the user.
#[derive(Default, Clone)]
pub struct Rights {
    pub planner: Option<Arc<Tk>>,
    pub requester: Option<Arc<Tk>>,
    pub runner: Option<Arc<Tk>>,
    pub guest: Option<Guest>,
}

impl Rights {
    pub fn any(&self) -> bool {
        self.planner.is_some() || self.requester.is_some() || self.runner.is_some() || self.guest.is_some()
    }
}

/// `isManager`: a main ticket, or a tool group or round.
pub fn is_manager(t: &Tk) -> bool {
    t.main || (t.tool && matches!(t.kind.as_deref(), Some("group" | "round")))
}

/// The run header split like Bun's `h.split("/")`: (board, ticket) with "" for a missing part.
pub fn split_run(h: &str) -> (String, String) {
    let mut p = h.split('/');
    (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string())
}

pub struct Who<'a> {
    pub tickets: &'a Tickets,
    pub hooks: Arc<dyn BoardHooks>,
}

impl Who<'_> {
    /// `userAskedRun`: the ticket's run answers a message the user typed (not a slash command), or one handed to it.
    pub fn user_asked_run(&self, slug: &str, id: &str) -> bool {
        let r = self.hooks.run_state(slug, id);
        r.active && ((r.chat_user && !r.chat_slash) || r.user_steered)
    }

    /// `plannerRights`.
    pub fn planner_rights(&self, slug: &str, run_id: &str) -> Option<Arc<Tk>> {
        let t = self.tickets.get(slug, run_id)?;
        if !is_manager(&t) {
            return None;
        }
        let r = self.hooks.run_state(slug, run_id);
        if r.active && !r.chat_quiet {
            return Some(t);
        }
        if plan_active(&t) {
            return Some(t);
        }
        r.chat_user.then_some(t)
    }

    /// `userRequestRights`: a Planning chat answering the user's message.
    pub fn user_request_rights(&self, slug: &str, run_id: &str) -> Option<Arc<Tk>> {
        let r = self.hooks.run_state(slug, run_id);
        (r.chat_mode.as_deref() == Some("refine") && r.chat_user).then(|| self.tickets.get(slug, run_id)).flatten()
    }

    /// `runnerRights`: a work run or a chat reply that acts on the ticket.
    pub fn runner_rights(&self, slug: &str, run_id: &str) -> Option<Arc<Tk>> {
        let r = self.hooks.run_state(slug, run_id);
        if !r.active || r.chat_mode.as_deref() == Some("refine") || r.chat_quiet {
            return None;
        }
        self.tickets.get(slug, run_id)
    }

    /// `inFamily`: target is below id in id's family.
    pub fn in_family(&self, slug: &str, id: &str, target: &str) -> bool {
        let list = self.tickets.list(slug);
        let rows = family_of(&list, id);
        let Some(at) = rows.iter().position(|r| list.at(r.idx).id == id) else { return false };
        rows.iter().enumerate().any(|(i, r)| i > at && list.at(r.idx).id == target && rows[at + 1..=i].iter().all(|x| x.depth > rows[at].depth))
    }

    /// `runRights(req, slug, target)`.
    pub fn rights(&self, run: Option<&str>, huddle: bool, slug: &str, target: Option<&Tk>) -> Result<Rights, Refusal> {
        let Some(h) = run.filter(|h| !h.is_empty()) else { return Ok(Rights::default()) };
        let (run_slug, run_id) = split_run(h);
        if run_slug != slug && !run_id.is_empty() {
            let ticket = if !huddle && self.user_asked_run(&run_slug, &run_id) { self.tickets.get(&run_slug, &run_id) } else { None };
            if let Some(ticket) = ticket {
                return Ok(Rights { guest: Some(Guest { slug: run_slug, ticket }), ..Default::default() });
            }
            return Err(other_board("changing tickets", slug, &run_slug));
        }
        let mine = run_slug == slug && !run_id.is_empty() && !huddle;
        let target_id = target.map(|t| t.id.as_str());
        let self_t = if mine && target_id != Some(run_id.as_str()) { self.tickets.get(slug, &run_id) } else { None };
        if self_t.is_some_and(|s| is_manager(&s))
            && let Some(planner) = self.planner_rights(slug, &run_id)
            && target_id.is_none_or(|t| self.in_family(slug, &planner.id, t))
        {
            return Ok(Rights { planner: Some(planner), ..Default::default() });
        }
        let requester = if mine { self.user_request_rights(slug, &run_id) } else { None };
        if let Some(requester) = requester {
            if target_id == Some(requester.id.as_str()) {
                return Err((
                    403,
                    format!(
                        "{} is this Planning chat's own ticket: ask the user to edit or stop it themselves (changing it from here would end this reply or start its work). Only moving it to done, backlog or ready works, when the user asks in this chat",
                        requester.id
                    ),
                ));
            }
            return Ok(Rights { requester: Some(requester), ..Default::default() });
        }
        if mine && target_id == Some(run_id.as_str()) {
            return Err((
                403,
                format!(
                    "{run_id} is this run's own ticket: it may only move it to done, backlog or ready, and only when the user asks for that in a message they typed in this ticket's chat; otherwise ask the user to change it on the board"
                ),
            ));
        }
        let planner = if mine { self.planner_rights(slug, &run_id) } else { None };
        if let Some(p) = &planner {
            let ok = match target {
                None => true,
                Some(t) => t.parent_id.as_deref() == Some(p.id.as_str()) || (is_manager(p) && self.in_family(slug, &p.id, &t.id)),
            };
            if ok {
                return Ok(Rights { planner, ..Default::default() });
            }
        }
        if let Some(runner) = if mine { self.runner_rights(slug, &run_id) } else { None } {
            return Ok(Rights { runner: Some(runner), ..Default::default() });
        }
        if let Some(p) = planner {
            let tid = target.map(|t| t.id.clone()).unwrap_or_default();
            return Err((403, format!("{tid} is not in the family of {}; a main ticket may only change its own tool tickets", p.id)));
        }
        Err((
            403,
            "changing the board is disabled inside a board run that isn't working right now (or is a Planning chat without the user's message, a reply to another ticket's question or a huddle helper): only a ticket's active run or chat reply, a Planning chat answering the user's message, and a main ticket on its own tool tickets may change other tickets".into(),
        ))
    }

    /// `runStart`: a run starts another ticket's run (`target`; None for a ticket it creates). Only a loop is refused.
    pub fn run_start(&self, slug: &str, runner: &Tk, target: Option<&str>) -> Result<Value, Refusal> {
        let me = self.tickets.get(slug, &runner.id);
        let by = me.as_ref().and_then(|t| t.get("startedBy")).filter(|v| v.is_object());
        let depth = by.and_then(|b| b.get("depth")).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        let mut chain: Vec<String> = match by.and_then(|b| b.get("chain")) {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => by.and_then(|b| b.get("ticketId")).and_then(Value::as_str).map(|s| vec![s.to_string()]).unwrap_or_default(),
        };
        chain.push(runner.id.clone());
        if chain.len() > RUN_CHAIN_KEEP {
            chain.drain(..chain.len() - RUN_CHAIN_KEEP);
        }
        if let Some(t) = target
            && chain.iter().filter(|x| *x == t).count() >= MAX_RUN_RETURNS
        {
            return Err((
                409,
                format!(
                    "{t} and this run keep starting each other (runs started by runs: {}): to stop an endless loop, this run can't start it again. Ask the user to start it on the board",
                    chain.join(" → ")
                ),
            ));
        }
        Ok(json!({ "ticketId": runner.id, "depth": ckanban_core::jsnum::num(depth), "chain": chain }))
    }

    /// `guestStart`: a guest's start, counted against its own ticket on its own board.
    pub fn guest_start(&self, g: &Guest, target: Option<&str>) -> Result<Value, Refusal> {
        let who = Who { tickets: self.tickets, hooks: self.hooks.clone() };
        let mut v = who.run_start(&g.slug, &g.ticket, target)?;
        v["slug"] = Value::from(g.slug.clone());
        Ok(v)
    }

    /// `byRequest`, `byRun`, `byGuest`: how a change is credited on the changed ticket.
    pub fn by_request(r: &Tk) -> String {
        format!("by the Planning chat of {} (user request)", r.id)
    }
    pub fn by_run(r: &Tk) -> String {
        format!("by the run of {} (\"{}\")", r.id, r.title)
    }
    pub fn by_guest(&self, g: &Guest) -> String {
        format!("by the chat of {} on {} (user request)", g.ticket.id, self.board_name(&g.slug))
    }

    /// `store.getProfile(slug)?.name ?? slug`.
    pub fn board_name(&self, slug: &str) -> String {
        match ckanban_core::DataDir::new(self.tickets.root()).profile(slug).and_then(|p| p.record.0.get("name").cloned()) {
            Some(Value::String(s)) => s,
            Some(Value::Null) | None => slug.to_string(),
            Some(v) => v.to_string(),
        }
    }
}

/// The refusal for a run reaching another board without the user's typed message.
pub fn other_board(what: &str, slug: &str, run_slug: &str) -> Refusal {
    (
        403,
        format!(
            "{what} on another board ({slug}) only works in a chat reply to a message the user typed in that chat (on {run_slug}); work runs, follow-ups, plan wake-ups, replies to other tickets and huddle helpers stay on their own board"
        ),
    )
}
