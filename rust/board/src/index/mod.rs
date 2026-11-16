//! R1: board index and read routes. Ticket cache and listings (port of the reading half of `src/core/store.ts`),
//! the background re-check, the start-up load on a thread pool; families, scopes, the command bar, done paging, card
//! state, columns, links, tags; attention (pure part of `src/helper/attention.ts`); `TicketView` (`view()` in
//! `src/api/context.ts`, which fills `api::TicketViews`); ticket GET scopes, `/api/tickets`, `/api/inbox`, `/api/profiles`
//! GETs; shadow mode (plan 3.4). Empty until R1 lands.
