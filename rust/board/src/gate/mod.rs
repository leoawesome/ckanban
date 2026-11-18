//! R13: the request gate, the system routes, housekeeping and the satellite's edge (plan 3.3, section 7 "R13").
//!
//! - `request`: `requestRefusal`, `isAllowedSocket`, the JSON-only rule and the debug profile's "this Mac only"
//!   check, checked against Bun on `tests/fixtures/gate.json`.
//! - `remote`: `remote.json` as the phone access check reads it (re-read when it changes).
//! - `system`: `health`, `claude/projects`, `claude/defaults`, `pick-folder`, `debug/profile`; `update`: the update
//!   check of `GET /api/version`. (`cron/preview` is `schedules::cron::preview`.)
//! - `housekeeping`: the temp file sweep and the daemon.log trim, report-only with `CKANBAN_RUST_DELETE=0`.
//! - `edge`: calls to the Bun satellite (`api::Satellite`) and the satellite's calls to the board.
//!
//! The server (`rust/src/board_mode.rs`, `rust/src/phone.rs`) reads requests and sends answers; this module holds
//! the decisions.

pub mod edge;
pub mod housekeeping;
pub mod remote;
pub mod request;
pub mod system;
pub mod update;
