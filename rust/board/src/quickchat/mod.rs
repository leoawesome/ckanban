//! R8: quick chats (`src/chat/quickchat.ts`, `quickchat-index.ts`, the chats routes in `src/api/chats.ts`): chats with
//! Claude in a board's folder that aren't tickets (the phone's Ask tab, the computer's Claude panel), kept in
//! `profiles/<slug>/chats/` in Bun's exact format so either side reads the other's chats.
//!
//! - `text`: titles, the run note, attachment paths, live drafts, "session missing" (checked against Bun's fixtures).
//! - `index`: the chat list, newest first, kept between lists; pages for "Load older".
//! - `service`: `QuickChats` (send, runs on the run engine of R3, stop, rename, delete, shutdown and recover).
//! - `routes`: the HTTP routes in board mode.

pub mod index;
pub mod routes;
pub mod service;
pub mod text;

pub use service::{ChatHooks, QuickChatOptions, QuickChats, RunLimits};
