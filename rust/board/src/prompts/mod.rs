//! R4: the run prompts (`src/runs/prompts-*.ts`) and the question forms logic (`web/src/features/ticket/questionForms.ts`),
//! the same bytes as Bun's. `tests/prompts.rs` runs every builder over the fixture table Bun writes
//! (`tests/fixtures/prompts.json`, kept by `test/rust-prompt-fixtures.test.ts`) and compares byte for byte.
//!
//! The text is pure: builders take the ticket and board facts and return a string. Two read the outside world like
//! Bun: `target_design_rule` lists the ticket's mockups folder, and `follow_up_wake_prompt` writes times in local time.
//! The helper command the prompts name is this program unless `deps::set_helper_command` says otherwise.

pub mod chat;
pub mod deps;
pub mod huddle;
pub mod js;
pub mod main_role;
pub mod planning;
pub mod question_forms;
pub mod rules;
pub mod types;

pub use chat::*;
pub use huddle::*;
pub use main_role::*;
pub use planning::*;
pub use rules::*;
