//! ckanban's plan usage (`GET /api/usage`) and today's spend (`GET /api/spend`), ported from the Bun daemon
//! (`src/usage/usage.ts`, `usage-cache.ts`, `spend.ts`), and the data folder library (`src/core/store.ts`,
//! `atomic.ts`, `json-dir.ts`): every saved file read and written byte for byte like Bun. A library only: no HTTP
//! server, no proxy (the `ckanban-rs` front server wires it in). Every answer is a `serde_json::Value` shaped and
//! formatted like Bun's `JSON.stringify` output, so a server can send it as is.

pub mod atomic;
pub mod datafile;
pub mod home;
pub mod jskeys;
pub mod jsnum;
pub mod json_dir;
pub mod jsonl;
pub mod layout;
pub mod record;
pub mod spend;
pub mod ticket;
pub mod time;
pub mod usage;
pub mod usage_cache;
pub mod usage_windows;
pub mod yaml_read;
pub mod yaml_write;

pub use home::DataDir;
pub use spend::{SpendIndex, TodaySpend};
pub use usage::{UsageClient, UsageResult, UsageWindow};
pub use usage_cache::UsageCache;
