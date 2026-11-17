//! R11a: huddle rooms (`src/huddle/huddle.ts` and its `huddle-*.ts` parts, the `huddles` routes of
//! `src/api/huddles.ts`), behind board mode; fills `api::HuddleInfo`.
//!
//! - `model`: limits and pure helpers (mentions, who wakes, the board's own summary).
//! - `files`: the huddle files and message logs.
//! - `copies`: hand-ins from a helper's own copy of the folder (saving them aside, bringing them in).
//! - `service`: `Huddles`, the room; what runs (helpers, ticket replies) goes through `HuddleRunner` (R11c, R7a).
//! - `routes`: `/api/profiles/:p/huddles...`.

pub mod copies;
pub mod files;
pub mod model;
pub mod routes;
pub mod service;

pub use service::{AgentState, Caller, HuddleRunner, Huddles, NoRunner};
