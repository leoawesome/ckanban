//! ckanban's plan usage (`GET /api/usage`) and today's spend (`GET /api/spend`), ported from the Bun daemon
//! (`src/usage/usage.ts`, `usage-cache.ts`, `spend.ts`). A library only: no HTTP server, no proxy (the
//! `ckanban-rs` front server wires it in). Every answer is a `serde_json::Value` shaped and formatted like Bun's
//! `JSON.stringify` output, so a server can send it as is.

pub mod atomic;
pub mod home;
pub mod jsnum;
pub mod record;
pub mod spend;
pub mod time;
pub mod usage;
pub mod usage_cache;
pub mod usage_windows;

pub use home::DataDir;
pub use spend::{SpendIndex, TodaySpend};
pub use usage::{UsageClient, UsageResult, UsageWindow};
pub use usage_cache::UsageCache;
