//! R7a: the board run loop (`src/board/board.ts` and its parts `board-queue`, `board-devices`, `board-limits`,
//! `board-followups`, `board-recovery`, `board-types`; `src/usage/limit.ts`, `src/schedules/followup.ts`). Fills
//! `api::RunControl`, R2b's `families::PlanRuns`, the run half of `tickets::hooks::BoardHooks` and
//! `api::BoardActions`.
//!
//! - `types`: `ActiveRun["chat"]` (`Chat`) and `ChatOptions`.
//! - `rules`: the pure rules of `board-types.ts` (`chatFor`, `takesSlot`, `hasText`, `replayText`, `sessionMissing`...).
//! - `limit`: `usage/limit.ts` (when a usage limit resets, the day key, the clock text).
//! - `followup`: `schedules/followup.ts` and the `parseAt`/`formatAt` of `schedules/jobs.ts`.

pub mod followup;
pub mod limit;
pub mod rules;
pub mod types;
pub mod board;
mod followups;
mod limits;
pub mod once;
pub mod prompt;
mod queue;
mod recovery;
mod slots;
pub mod text;
pub mod usage;
pub mod wiring;

pub use board::{ActiveRun, RunError, RunLoop, RunLoopDeps, RunLoopOptions};
pub mod ask;
pub mod routes;
pub mod branch;
