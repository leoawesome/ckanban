//! What the ticket writes need from the board steps that come after R2a, behind one trait with stand-ins (like
//! `api.rs` does for the steps before): families and plans (R2b), the run loop (R7a), copies of the folder (R6),
//! huddles (R11a), browsers (R9), the scheduler (R10), chat extras (R7b) and the helper (the satellite, R13). A step
//! that lands implements the methods it owns and hands its `BoardHooks` to `Tickets::new`.
//!
//! Stand-ins keep board mode safe until then: nothing runs, so no run has rights and nothing is stopped; family
//! links that need R2b's rules (`partOf`, gather, plan tool tickets) are refused with `NOT_YET` instead of being
//! written without their checks (board mode plugs R2b's `families::Families` in through `wiring::Wired`).

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

/// How the ticket's own run may move its card (`requestSelfMove`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelfMove {
    /// Not this way: the run has no such right (the usual run rights decide).
    Refused,
    /// The user asked in a message they typed: the card moves once the reply ends.
    Asked,
    /// A work run without the user's message moves it to done: only if the run ends with status done.
    OnDone,
}

/// Which waiting jobs a delete cancels on purpose (`cancelJobs` of a delete request). Without it, none: a deleted
/// ticket's jobs stay scheduled and run at their time.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum CancelJobs {
    #[default]
    None,
    /// Every waiting job the deleted tickets scheduled.
    All,
    /// These job ids; each must be a waiting job of a ticket being deleted.
    These(Vec<String>),
}

impl CancelJobs {
    /// From a request: `true`/`"all"` is All, a list (or a comma-separated string) of job ids is These, and
    /// `false`/null/empty is None. Err for anything else.
    pub fn parse(v: Option<&Value>) -> Result<CancelJobs, String> {
        const BAD: &str = "cancelJobs must be true, \"all\" or a list of job ids";
        let ids = |it: Vec<String>| if it.is_empty() { CancelJobs::None } else { CancelJobs::These(it) };
        match v {
            None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(CancelJobs::None),
            Some(Value::Bool(true)) => Ok(CancelJobs::All),
            Some(Value::String(s)) => match s.trim() {
                "" | "false" | "0" | "none" => Ok(CancelJobs::None),
                "all" | "true" | "1" => Ok(CancelJobs::All),
                s => Ok(ids(s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect())),
            },
            Some(Value::Array(a)) => {
                let mut out = Vec::new();
                for x in a {
                    let Some(x) = x.as_str().map(str::trim).filter(|x| !x.is_empty()) else { return Err(BAD.into()) };
                    out.push(x.to_string());
                }
                Ok(ids(out))
            }
            _ => Err(BAD.into()),
        }
    }
}

pub trait BoardHooks: Send + Sync {
    /// The waiting jobs a delete of `ids` cancels (`pick`), checked before anything is deleted (R10). Err refuses
    /// the delete. The stand-in: none, and an explicit pick is refused.
    fn jobs_to_cancel(&self, _slug: &str, _ids: &[String], pick: &CancelJobs) -> Result<Vec<String>, (u16, String)> {
        match pick {
            CancelJobs::None => Ok(Vec::new()),
            _ => Err((400, format!("cancelling jobs is {NOT_YET}"))),
        }
    }
    /// Cancels them after the delete, each saying it was chosen when deleting its ticket (`titles`: id -> title).
    fn cancel_jobs(&self, _slug: &str, _job_ids: &[String], _titles: &std::collections::HashMap<String, String>, _by: Option<&str>) -> Vec<Value> {
        Vec::new()
    }
    /// The ticket's run, if any (R7a).
    fn run_state(&self, _slug: &str, _id: &str) -> RunState {
        RunState::default()
    }
    /// Asks the ticket's own run to move its card once the reply ends (`requestSelfMove`, R7a).
    fn request_self_move(&self, _slug: &str, _id: &str, _status: &str) -> SelfMove {
        SelfMove::Refused
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
    /// A move from Planning (or Backlog) to Ready, before the status is written: the work may start in a fresh chat
    /// (`choice`: the user's tick sent with "Apply & start work"; None: decided by the planning chat's size) (R7a).
    fn fresh_for_work(&self, _slug: &str, _id: &str, _choice: Option<bool>) {}
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
    /// An open huddle (any kind) is hosted by the ticket: its helpers may work in the ticket's copy (R11a).
    fn huddle_open(&self, _slug: &str, _id: &str) -> bool {
        false
    }
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

#[cfg(test)]
mod tests {
    use super::CancelJobs;
    use serde_json::json;

    #[test]
    fn cancel_jobs_from_a_request() {
        let p = |v: serde_json::Value| CancelJobs::parse(Some(&v));
        assert_eq!(CancelJobs::parse(None), Ok(CancelJobs::None));
        assert_eq!(p(json!(null)), Ok(CancelJobs::None));
        assert_eq!(p(json!(false)), Ok(CancelJobs::None));
        assert_eq!(p(json!("")), Ok(CancelJobs::None));
        assert_eq!(p(json!(true)), Ok(CancelJobs::All));
        assert_eq!(p(json!("all")), Ok(CancelJobs::All));
        assert_eq!(p(json!("a, b")), Ok(CancelJobs::These(vec!["a".into(), "b".into()])));
        assert_eq!(p(json!(["a"])), Ok(CancelJobs::These(vec!["a".into()])));
        assert_eq!(p(json!([])), Ok(CancelJobs::None));
        assert!(p(json!([1])).is_err());
        assert!(p(json!(3)).is_err());
        assert!(p(json!({})).is_err());
    }
}
