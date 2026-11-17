//! R7b: chat extras (slash commands, drafts, rewind and undo, fork, simplify, explain, the Context panel, fresh
//! chat and session, take-over, link-session).
//! - `simplify`: "Say it simpler" (`src/chat/simplify.ts`); `explain`: "Help me understand" (`src/chat/explain.ts`);
//!   `context`: the Context panel (`src/chat/context-usage.ts`); `extras`: `ChatExtras`, which holds them, and their
//!   ticket routes.

pub mod context;
pub mod explain;
pub mod extras;
pub mod sha256;
pub mod simplify;

/// A refusal: status and message (Bun's `HttpError`).
pub type Fail = (u16, String);
