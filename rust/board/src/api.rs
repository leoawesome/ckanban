//! The interfaces between the board's modules (plan 2.6), so a task can build and test its module before the module it
//! calls exists. Each trait has a stand-in ("nothing running", "no session", "no huddle", "no devices", "no
//! satellite"); `Services::stand_ins()` uses them all, and a task that lands replaces its stand-in in `Services`
//! (`core.rs`) with the real thing. Shapes that Bun keeps as objects (a session summary, a huddle's host state, a
//! device state) are JSON values here until their module defines a type: they go out in answers as they are.
//!
//! | Trait | Bun source | Filled in by |
//! | --- | --- | --- |
//! | `RunControl` | `Board` (`isRunning`, `runningKey`, `holdsSlot`, `start`, `stop`, `chat`, `activeWork`, `busyBoards`, `runs`) | R7a |
//! | `SessionInfo` | `SessionCache` (`summary`, `version`, `get(..).entries`) | R5 |
//! | `HuddleInfo` | `Huddles` (`hostStates`, the restart-busy hook) | R11a |
//! | `DeviceInfo` | `Devices`, `BoardBrowsers` (`deviceState`, `releaseAll`, `browserPicks`) | R9 |
//! | `Landing` | `board-main.ts`, `board-repo.ts` (`mergeIntoMain`, `land`, `cleanupWorktree`, repo state) | R6 |
//! | `Satellite` | the Bun satellite's edge (plan 3.3) | R13 |
//! | `TicketViews` | `view()` in `src/api/context.ts` (what `ticket.updated` events carry) | R1 |
//! | `ActivityCut` | `liveJson` in `src/runs/live-cut.ts` (run events without their long strings) | R3 |

use std::collections::BTreeMap;

use futures_util::future::BoxFuture;
use serde_json::Value;

/// What went wrong, in words a user may see (Bun's thrown `Error` messages).
pub type Failure = String;

/// Runs of board tickets (`Board` in `src/board/board.ts`).
pub trait RunControl: Send + Sync {
    /// A run of this ticket is going now.
    fn is_running(&self, slug: &str, id: &str) -> bool;
    /// The key of the run this ticket's work is under (its own, or the ticket whose run it shares), if any.
    fn running_key(&self, slug: &str, id: &str) -> Option<String>;
    /// The ticket's run counts against the board's slots.
    fn holds_slot(&self, slug: &str, id: &str) -> bool;
    /// Starts a run (`start`); Err says why it can't.
    fn start(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// Stops the ticket's run (`stop`).
    fn stop(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// Sends a chat message to the ticket, starting or queuing a run (`chat`).
    fn chat(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// What a restart waits for: one line per active run (`activeWork`).
    fn active_work(&self) -> Vec<String>;
    /// Boards with active runs (`busyBoards`), for keep-awake.
    fn busy_boards(&self) -> Vec<String>;
    /// Every ticket with a run going now, as (board, ticket id): the satellite's `runtime` mirror.
    fn running_tickets(&self) -> Vec<(String, String)>;
    /// The card's `folderWait` (`Board.folderWait`): it would start now but another ticket edits the board's folder in
    /// place. `ticket` is the ticket as its view shows it. False until runs exist (R7a).
    fn folder_wait(&self, _slug: &str, _ticket: &Value) -> bool {
        false
    }
}

/// Claude session transcripts (`SessionCache` in `src/runs/session-cache.ts`).
pub trait SessionInfo: Send + Sync {
    /// `SessionSummary` as JSON, or None when the session is unknown or not read yet.
    fn summary(&self, session_id: &str) -> Option<Value>;
    /// A string that changes whenever the session file changes (`version`).
    fn version(&self, session_id: &str) -> Option<String>;
    /// The parsed transcript entries (`get(id).entries`); empty when unknown.
    fn entries(&self, session_id: &str) -> Vec<Value>;
}

/// Huddles' live state (`Huddles` in `src/huddle/huddle.ts`).
pub trait HuddleInfo: Send + Sync {
    /// `hostStates(slug)`: each open huddle's `HostHuddle` by host ticket id.
    fn host_states(&self, slug: &str) -> BTreeMap<String, Value>;
    /// What a restart also waits for besides board runs (huddle agents mid-turn), one line each.
    fn restart_busy(&self) -> Vec<String>;
    /// What a ticket's huddle teammates spent (`Huddles.ticketSpend(..).costUsd`), for its card's cost.
    fn ticket_spend(&self, _slug: &str, _id: &str) -> f64 {
        0.0
    }
    /// The ticket's huddle teammates with a session (handle, session id): their artifacts join its links.
    fn teammates(&self, _slug: &str, _id: &str) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// Shared devices and board browsers (`Devices`, `BoardBrowsers` in `src/browser/`).
pub trait DeviceInfo: Send + Sync {
    /// The ticket's devices as its view shows them (`deviceState`); None when it holds and waits for nothing.
    fn device_state(&self, slug: &str, id: &str) -> Option<Value>;
    /// Lets go of everything a ticket's run holds (`releaseAll`), at the run's end.
    fn release_all(&self, slug: &str, id: &str);
    /// The browsers a ticket's runs may use (`browserPicks`); None: no list (the board's default).
    fn browser_picks(&self, slug: &str, id: Option<&str>) -> Option<Value>;
    /// The ticket's linked session is open in a terminal now (`terminals.isOpen`).
    fn terminal_open(&self, _slug: &str, _id: &str) -> bool {
        false
    }
}

/// Copies of the folder and landing (`board-main.ts`, `board-repo.ts`).
pub trait Landing: Send + Sync {
    fn merge_into_main(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<Value, Failure>>;
    fn land(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<Value, Failure>>;
    fn cleanup_worktree(&self, slug: &str, id: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// The board folder's state (git or plain, branch, remote) as the UI gets it.
    fn repo_state(&self, slug: &str) -> BoxFuture<'_, Result<Value, Failure>>;
}

/// What the board asks of the Bun satellite (plan 3.3), over its internal port.
pub trait Satellite: Send + Sync {
    /// A message that came from Telegram goes to the ticket's chat (`chatFromTelegram`), from the satellite's side.
    fn chat_from_telegram(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// A ticket's turn ended: the helper may notify (Mac banner, push, Telegram).
    fn notify_message(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// An automation's pass tool call (`automation-call`), after the board checked the script's token.
    fn pass_call(&self, body: Value) -> BoxFuture<'_, Result<Value, Failure>>;
    /// Whether a Telegram front desk request may go ahead now (Ok(None)) or is held (Ok(Some(answer))).
    fn frontdesk_gate(&self, request: Value) -> BoxFuture<'_, Result<Option<Value>, Failure>>;
    /// Share to claude.ai: publish a file, give its link.
    fn publish_artifact(&self, request: Value) -> BoxFuture<'_, Result<Value, Failure>>;
    /// The ticket's publishing jobs now (`shareJobs`), as its view lists them.
    fn share_jobs(&self, _slug: &str, _id: &str) -> Vec<Value> {
        Vec::new()
    }
}

/// What `ticket.updated` events and ticket answers carry (`view()` in `src/api/context.ts`).
pub trait TicketViews: Send + Sync {
    /// The ticket's `TicketView` (file fields plus the live ones). None: send the ticket as it is.
    fn view(&self, profile: &str, ticket: &Value) -> Option<Value>;
    /// The current view of a ticket by id, for the extra `ticket.updated` after `session.updated`/`huddle.updated`.
    fn view_of(&self, profile: &str, id: &str) -> Option<Value>;
}

/// `liveJson` (`src/runs/live-cut.ts`): a run's raw event as live events send it, long strings cut.
pub trait ActivityCut: Send + Sync {
    /// The JSON text of an `activity` event as the event stream sends it. `mask` hides saved keys in a long string
    /// before it is cut (the whole text is masked again afterwards, as in Bun).
    fn live_json(&self, event: &Value, mask: &dyn Fn(&str) -> String) -> String;
}

/// The stand-ins: nothing running, no session, no huddle, no devices, no landing, no satellite, tickets as they are.
pub struct StandIn;

const NOT_YET: &str = "not in the Rust board yet";

impl RunControl for StandIn {
    fn is_running(&self, _: &str, _: &str) -> bool {
        false
    }
    fn running_key(&self, _: &str, _: &str) -> Option<String> {
        None
    }
    fn holds_slot(&self, _: &str, _: &str) -> bool {
        false
    }
    fn start(&self, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    fn stop(&self, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Ok(()) })
    }
    fn chat(&self, _: &str, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    fn active_work(&self) -> Vec<String> {
        Vec::new()
    }
    fn busy_boards(&self) -> Vec<String> {
        Vec::new()
    }
    fn running_tickets(&self) -> Vec<(String, String)> {
        Vec::new()
    }
}

impl SessionInfo for StandIn {
    fn summary(&self, _: &str) -> Option<Value> {
        None
    }
    fn version(&self, _: &str) -> Option<String> {
        None
    }
    fn entries(&self, _: &str) -> Vec<Value> {
        Vec::new()
    }
}

impl HuddleInfo for StandIn {
    fn host_states(&self, _: &str) -> BTreeMap<String, Value> {
        BTreeMap::new()
    }
    fn restart_busy(&self) -> Vec<String> {
        Vec::new()
    }
}

impl DeviceInfo for StandIn {
    fn device_state(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn release_all(&self, _: &str, _: &str) {}
    fn browser_picks(&self, _: &str, _: Option<&str>) -> Option<Value> {
        None
    }
}

impl Landing for StandIn {
    fn merge_into_main(&self, _: &str, _: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    fn land(&self, _: &str, _: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    fn cleanup_worktree(&self, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Ok(()) })
    }
    fn repo_state(&self, _: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
}

impl Satellite for StandIn {
    fn chat_from_telegram(&self, _: &str, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    fn notify_message(&self, _: &str, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Ok(()) })
    }
    fn pass_call(&self, _: Value) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
    fn frontdesk_gate(&self, _: Value) -> BoxFuture<'_, Result<Option<Value>, Failure>> {
        Box::pin(async { Ok(None) })
    }
    fn publish_artifact(&self, _: Value) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async { Err(NOT_YET.to_string()) })
    }
}

impl TicketViews for StandIn {
    fn view(&self, _: &str, _: &Value) -> Option<Value> {
        None
    }
    fn view_of(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
}

impl ActivityCut for StandIn {
    fn live_json(&self, event: &Value, _mask: &dyn Fn(&str) -> String) -> String {
        serde_json::to_string(event).unwrap_or_else(|_| "null".into())
    }
}
