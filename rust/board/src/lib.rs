//! `ckanban-board`: the board, runs and chat of ckanban in Rust, behind board mode (`docs/rust-port-board-plan.md`).
//! Nothing here runs unless board mode is on (`mode.rs`); the server (`rust/src/board_mode.rs`) calls into it.
//!
//! R0 (this skeleton): the interfaces between modules with stand-ins (`api`), `Core` and its start and stop order
//! (`core`), the bus (`bus`) and `/api/events` (`events`), board mode and its fallbacks (`mode`), the data folder lock
//! (`lock`), and the Bun satellite's edge (`satellite`). One folder per later task, empty until it lands.

pub mod api;
pub mod bus;
pub mod core;
pub mod events;
pub mod lock;
pub mod mode;
pub mod satellite;

// One folder per task of the plan (section 7); each starts empty.
pub mod browsers; // R9
pub mod chat; // R7b
pub mod extras; // R12
pub mod families; // R2b
pub mod gate; // R13
pub mod git; // R6
pub mod huddle_agents; // R11c
pub mod huddles; // R11a
pub mod index; // R1
pub mod prompts; // R4
pub mod quickchat; // R8
pub mod runloop; // R7a
pub mod runs; // R3
pub mod schedules; // R10
pub mod sessions; // R5
pub mod team; // R11b
pub mod tickets; // R2a

// Dependencies of later tasks, added once by R0 so parallel tasks don't each change Cargo.toml and Cargo.lock:
// referenced here so the build doesn't warn until a task uses them (then remove its line).
use arc_swap as _;
use getrandom as _;
use notify as _;
use portable_pty as _;
use sha1 as _;
use tokio_tungstenite as _;
