//! R11a and R11c: huddle rooms (`src/huddle/huddle.ts` and its `huddle-*.ts` parts, the `huddles` routes of
//! `src/api/huddles.ts`), behind board mode; fills `api::HuddleInfo`.
//!
//! - `model`: limits and pure helpers (mentions, who wakes, the board's own summary).
//! - `files`: the huddle files and message logs.
//! - `copies`: hand-ins from a helper's own copy of the folder (saving them aside, bringing them in).
//! - `service`: `Huddles`, the room; what runs (helpers, ticket replies) goes through `HuddleRunner`.
//! - R11c: `agents` (`Agents`, the board's `HuddleRunner`: helpers' runs, ticket sessions' replies, costs, close
//!   cleanup, shutdown and recovery), `auto` (auto huddles and the board's slot), `session` (a participant's session
//!   viewer, `huddle.session` events), `workspace` (helpers' copies and snapshots), `output_copies` (project copies
//!   left in outputs; report-only until `CKANBAN_RUST_DELETE=1`).
//! - `routes`: `/api/profiles/:p/huddles...`.

pub mod agents;
pub mod auto;
pub mod copies;
pub mod files;
pub mod model;
pub mod output_copies;
pub mod routes;
pub mod service;
pub mod session;
pub mod workspace;

pub use agents::{AgentOptions, Agents};
pub use service::{AgentState, Caller, HuddleRunner, Huddles, NoRunner};
