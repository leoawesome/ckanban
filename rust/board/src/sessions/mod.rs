//! R5: sessions and transcripts, ported from Bun (`src/runs/session-*.ts`, `subagents.ts`, `workflows.ts`,
//! `src/chat/chat-cache.ts`, `tooldetail.ts`, `chat-search.ts`, `src/core/changefeed.ts`). Fills `api::SessionInfo`.
//!
//! Every shape Bun keeps as an object (a transcript entry, an agent, a workflow, a summary) is a `serde_json` map here,
//! built with its keys in the order Bun's object literals give them, so answers and the summaries file read the same.
//! Transcript parsing and file walks run off the async runtime (`spawn_blocking`), and a transcript is only read again
//! from where the last read stopped, or whole when its size, mtime or inode say it was replaced.

pub mod js;

// Text and cards inside one transcript line (session-markers.ts and what it imports).
pub mod cards;
pub mod markers;
pub mod text;

// Subagents, workflows, tool details and chat search.
pub mod search;
pub mod subagents;
pub mod tooldetail;
pub mod workflows;

// The parse, its cache, the projects folder and its change feed, the watcher and the routes.
pub mod chat_cache;
pub mod feed;
pub mod files;
pub mod ticket_files;
pub mod cache;
pub mod parser;
pub mod routes;
pub mod service;
pub mod watcher;

/// A JS object: keys in insertion order (`serde_json` with `preserve_order`).
pub type Obj = serde_json::Map<String, serde_json::Value>;
