//! What the ticket writes need from the board steps that come after R2a, behind one trait with stand-ins (like
//! `api.rs` does for the steps before): families and plans (R2b), the run loop (R7a), copies of the folder (R6),
//! huddles (R11a), browsers (R9), the scheduler (R10), chat extras (R7b) and the helper (the satellite, R13). A step
//! that lands implements the methods it owns and hands its `BoardHooks` to `Tickets::new`.
//!
//! Stand-ins keep board mode safe until then: nothing runs, so no run has rights and nothing is stopped; family
//! links that need R2b's rules (`partOf`, gather, plan tool tickets) are refused with `NOT_YET` instead of being
//! written without their checks.

use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

/// The refusal for what a later board step does.
pub const NOT_YET: &str = "not in the Rust board yet";

/// What a ticket's current run is, for run rights (`Board.runs` in Bun). The stand-in: no run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunState {
    /// A run of the ticket is going and wasn't asked to stop.
    pub active: bool,
    /// The run is a chat reply: its mode ("refine" for Planning) and whether it answers the user's typed message.
    pub chat_mode: Option<String>,
    pub chat_user: bool,
    pub chat_slash: bool,
    pub chat_quiet: bool,
    /// The user typed a message that was handed to the run while it worked.
    pub user_steered: bool,
}

pub trait BoardHooks: Send + Sync {
    /// The ticket's run, if any (R7a).
    fn run_state(&self, _slug: &str, _id: &str) -> RunState {
        RunState::default()
    }
    /// Asks the ticket's own run to move its card once the reply ends (`requestSelfMove`, R7a). False: no such run.
    fn request_self_move(&self, _slug: &str, _id: &str, _status: &str) -> bool {
        false
    }
    /// Stops the ticket's run with `target` as the status it ends in, and waits for it (R7a).
    fn stop_run(&self, _slug: &str, _id: &str, _target: Option<&str>) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    /// After a create: start Ready work (`dispatch`), a Planning interview (`autoRefine`), plans (`advancePlans`).
    fn after_create(&self, _slug: &str, _id: &str, _status: &str, _has_parent: bool) {}
    /// After an update: Done cleans up the copy of the folder (R6), Planning starts its interview, a main ticket
    /// moved back to work resumes its plan, Ready work is dispatched, plans advance (R2b, R7a).
    fn after_update(&self, _slug: &str, _id: &str, _new_status: Option<&str>, _by_user: bool, _was_running: bool) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    /// After a delete or a move away: what the run loop keeps for the ticket goes.
    fn after_delete(&self, _slug: &str, _id: &str) {}
    /// A board's settings changed: work waiting for a slot may start (`dispatch`).
    fn board_changed(&self, _slug: &str) {}
    /// Before a ticket's files go: its copy of the folder (R6) and its rewind copies (R7b).
    fn remove_copies(&self, _slug: &str, _ticket: &Map<String, Value>) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    /// A merge into this main ticket's copy is running (R6).
    fn merging(&self, _slug: &str, _main_id: &str) -> bool {
        false
    }
    /// Closes the huddles hosted by a ticket that is going (R11a).
    fn close_huddles(&self, _slug: &str, _id: &str) {}
    /// A live huddle the user started works on the ticket (R11a).
    fn huddle_live(&self, _slug: &str, _id: &str) -> bool {
        false
    }
    /// Where a new ticket goes in its family (`placeInFeature`, R2b): may retitle a round or move it under the
    /// feature's top; Err refuses the link. The stand-in refuses every link.
    fn place_in_feature(&self, _slug: &str, input: &mut Map<String, Value>) -> Result<(), String> {
        let linked = |k: &str| input.get(k).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
        if linked("partOf") || linked("parentId") || input.get("kind").and_then(Value::as_str) == Some("round") {
            return Err(format!("linking a ticket into a feature is {NOT_YET}"));
        }
        Ok(())
    }
    /// `setPartOf` (R2b): links the ticket under `parent` (None unlinks).
    fn set_part_of(&self, _slug: &str, _id: &str, _parent: Option<&str>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err(format!("linking a ticket into a feature is {NOT_YET}")) })
    }
    /// Plans after a tool ticket was made (`unparkForNewStep`, `ensurePlan`, `advancePlans`, R2b). Returns whether
    /// the main ticket's plan is paused.
    fn new_step(&self, _slug: &str, _planner: &str, _main: bool) -> bool {
        false
    }
    /// `gather` with `main: true` (R2b): the tickets moved into the new feature, as the create answer's `gather`.
    fn gather(&self, _slug: &str, _id: &str, _items: &[(String, Option<String>)], _new_group: Option<&str>) -> BoxFuture<'_, Result<Value, String>> {
        Box::pin(async { Err(format!("gather is {NOT_YET}")) })
    }
    /// A Claude session the user started, linked to a new ticket (`linkSession`, R7b).
    fn link_session(&self, _slug: &str, _id: &str, _session: &str) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err(format!("linking a session is {NOT_YET}")) })
    }
    /// The board's parent suggestion for a ticket the user made (`suggestParent`, linker, R12).
    fn suggest_parent(&self, _slug: &str, _id: &str) {}
    /// A browser pick for a ticket or board (`browserPicks`/`chromeSetting`, R9): the `(chrome, browsers)` to save,
    /// or (status, message) refusing it.
    fn browsers(&self, _browsers: Option<&Value>, _chrome: Option<&Value>) -> Result<(Value, Value), (u16, String)> {
        Err((400, format!("choosing browsers is {NOT_YET}")))
    }
    /// A board's terminal shells end (its folder changed or it was deleted, R9).
    fn kill_shells(&self, _slug: &str) {}
    /// Tells a ticket's run something (`board.chat`, R7a); used by key cards after the keys are saved.
    fn chat_next_run(&self, _slug: &str, _id: &str, _text: &str) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    /// Removes a schedule for the user (`scheduler.remove`, R10); Ok(name) when it was there.
    fn remove_schedule(&self, _slug: &str, _id: &str) -> Result<Option<String>, String> {
        Err(format!("deleting a schedule is {NOT_YET}"))
    }
    /// Closes a questions form without answering (`closeForm`, R7a): the ticket as written.
    fn closes_form(&self, _slug: &str, _id: &str, _uuid: &str) -> Result<Map<String, Value>, (u16, String)> {
        Err((409, format!("closing a question is {NOT_YET}")))
    }
    /// Adds a line to what the helper knows about the user (the satellite, R13).
    fn helper_rule(&self, _text: &str) -> BoxFuture<'_, Result<bool, (u16, String)>> {
        Box::pin(async { Err((503, "the helper isn't running".to_string())) })
    }
}

/// Every hook as its stand-in.
pub struct NoHooks;

impl BoardHooks for NoHooks {}
