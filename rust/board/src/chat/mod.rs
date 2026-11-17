//! R7b: chat extras (slash commands, drafts, rewind and undo, fork, simplify, explain, the Context panel, fresh
//! chat and session, take-over, link-session). Drafts, fresh chat and session, take-over and link-session came with
//! R7a (`runloop`); the rest is here.
//! - `commands`, `slash`: slash commands (`src/chat/commands.ts`, the board's /model and /effort).
//! - `rewind`, `board`, `quick`: Rewind, Undo rewind and Fork for tickets and quick chats, Make ticket, the Planning
//!   chat's terminal command; `routes`: their ticket routes.
//! - `simplify`: "Say it simpler" (`src/chat/simplify.ts`); `explain`: "Help me understand" (`src/chat/explain.ts`);
//!   `context`: the Context panel (`src/chat/context-usage.ts`); `extras`: `ChatExtras`, which holds them, and their
//!   ticket routes.

pub mod board;
pub mod commands;
pub mod context;
pub mod explain;
pub mod extras;
pub mod quick;
pub mod rewind;
pub mod routes;
pub mod sha256;
pub mod simplify;
pub mod slash;

/// A refusal: status and message (Bun's `HttpError`).
pub type Fail = (u16, String);
