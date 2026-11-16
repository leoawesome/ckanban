//! R2a: ticket writes (plan 2.2, 7 row "R2a"). Create, update, delete, move; comments; run rights; saved keys masked
//! in comments as they are written (answers are masked by the server); attachments, avatars, snippets; the card
//! routes; profiles POST, PATCH, DELETE and detect-setup. The only code that writes `ticket.md` in board mode.
//!
//! - `writer`: `Tickets`, the board's write API (store writes, the index kept current, events).
//! - `hooks`: what later steps (R2b, R6, R7a, R9, R10, R11a, R13) plug in; stand-ins until then.
//! - `rights`: who may change which ticket (`runRights`).
//! - `routes`: the HTTP routes; `profiles`: the board routes; `files`: attachments, avatars, snippets; `norm`: tags,
//!   titles, slugs, models.

pub mod files;
pub mod hooks;
pub mod norm;
pub mod writer;
