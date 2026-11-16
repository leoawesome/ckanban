//! R11b: the team (`src/huddle/`): teammates (huddle role presets), squads (huddle templates), role notes, teammate
//! and squad proposals, the squad save plan, the "Save as squad…" prompt, the plan review file, and the team routes
//! of board mode.
//!
//! - `presets`, `templates`, `layers`: the three levels (built-in, global, board) and their checks.
//! - `roster`: roster checks shared with the huddle start (R11a).
//! - `notes`: role notes files and lessons.
//! - `proposal`, `squad`: propose_teammate and propose_squad cards, saving a squad, "Save as squad…".
//! - `plan_review`: `outputs/huddles/<id>/proposal.md`.
//! - `store`: the files and operations (`Team`); `routes`: the HTTP routes over it.
//!
//! The built-in teammates and squads, and the long texts, are `builtins.json`, written by Bun's
//! `test/rust-team-fixtures.test.ts` from `BUILTIN_PRESETS` and `BUILTIN_TEMPLATES`, so they can't drift: that test
//! fails when Bun's change and the file differ. `tests/fixtures/team.json` is the fixture table of every pure helper.

pub mod jsv;
pub mod layers;
pub mod notes;
pub mod plan_review;
pub mod presets;
pub mod proposal;
pub mod roster;
pub mod routes;
pub mod squad;
pub mod store;
pub mod templates;

use std::sync::LazyLock;

use serde::Deserialize;

pub use store::{Fail, LearningCards, Team, TicketCards};

use jsv::Obj;

/// The texts shipped as they are.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Texts {
    pub generic_squad_system: String,
    pub generic_squad_model: String,
    pub generic_squad_timeout_ms: u64,
    pub auto_review_findings: String,
    pub auto_review_read_only: String,
}

pub struct Builtins {
    pub presets: Vec<Obj>,
    pub templates: Vec<Obj>,
    pub texts: Texts,
}

static BUILTINS: LazyLock<Builtins> = LazyLock::new(|| {
    let v = ckanban_core::datafile::parse_json(include_str!("builtins.json")).expect("team/builtins.json is JSON");
    let list = |k: &str| -> Vec<Obj> { v[k].as_array().expect("a list").iter().map(|x| x.as_object().expect("an object").clone()).collect() };
    Builtins {
        presets: list("presets"),
        templates: list("templates"),
        texts: serde_json::from_value(v["texts"].clone()).expect("team/builtins.json texts"),
    }
});

/// The built-in teammates, squads and texts.
pub fn builtins() -> &'static Builtins {
    &BUILTINS
}
