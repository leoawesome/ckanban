//! R2b: families, plans, main tickets and the feature status, in board mode. Ported from `board-families.ts`,
//! `board-plans.ts`, `board-main.ts` (the parts without git and runs), `board-features.ts`, `feature.ts`,
//! `main-ticket.ts`, `plan.ts` and the family rules of `web/src/features/family/family.ts`.
//!
//! - `rules`: loops, levels, `fitParent`, `isFeature`, groups, rounds and `linkProblem`.
//! - `plan`: the plan engine's pure decisions (`planStep`, `planProblem`), a wake's table, the "finished" line.
//! - `status`: status.json and status.md ("Where we are"), byte for byte like Bun.
//! - `board`: `Families`, the calls on the board (link, own work, show on board, gather, plans, status), with what
//!   needs a run behind `PlanRuns` (the run loop, R7a; its stand-in starts nothing).
//! - `routes`: `family`, `family-view`, `status`, `status/notes`, `own-work`, `gather` and `plan` of a ticket.
//! - `old_plans`: a board with an old-style plan (from before main tickets) refuses board mode (fallback 2), so Bun's
//!   one-time migration (`retire-plans.ts`) handles it.

pub mod board;
pub mod old_plans;
pub mod plan;
pub mod routes;
pub mod rules;
pub mod status;

pub use board::{Families, NoRuns, PlanRuns};
