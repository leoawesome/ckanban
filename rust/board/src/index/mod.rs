//! R1: the board index and its read routes (`docs/rust-port-board-plan.md` 2.2, 3.4).
//!
//! - `store`: every board's ticket files parsed once and kept by mtime and size; each board's listing shared as one
//!   `Arc<BoardList>`; the start-up load on a few threads; the 30 s background re-check (the reading half of
//!   `src/core/store.ts`).
//! - `ticket`: a ticket as the listing holds it (`Tk`).
//! - `family`, `scope`, `card`, `attention`, `links`, `cmdbar`: families (`family.ts`), the list scopes and Done
//!   paging (`ticket-scope.ts`, `columns.ts`, `donePaging.ts`), a main ticket's card (`main-ticket.ts`), what waits on
//!   the user (`helper/attention.ts`), a ticket's links (`links.ts`), the command bar (`cmdbar.ts`, `fuzzy.ts`).
//! - `view`: `TicketView`, with live state through `Live` (board mode: the services' stand-ins until their tasks land).
//! - `routes`: `GET /api/profiles`, `/api/profiles/:p`, `/api/profiles/:p/tickets`, `/api/profiles/:p/tickets/:id`,
//!   `/api/tickets`, `/api/inbox`.
//! - `shadow`: shadow mode (front mode, `CKANBAN_RUST_SHADOW=1`): the same answers worked out from the files next to
//!   Bun's and the differences logged, never served.
//!
//! `cardState.ts` stays in the web UI: the server never uses it.

pub mod attention;
pub mod card;
pub mod cmdbar;
pub mod family;
pub mod links;
pub mod routes;
pub mod scope;
pub mod shadow;
pub mod store;
pub mod text;
pub mod ticket;
pub mod view;

pub use routes::Reads;
pub use store::Index;
pub use view::{Live, ServicesLive, Viewer};
