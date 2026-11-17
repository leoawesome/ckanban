//! P2 (`docs/rust-port-board-plan.md` 7.2): the outside services that the Bun satellite answered until now, in Rust,
//! for board mode. Ported from `src/integrations/` and the routes in `src/api/connections.ts`, `remote.ts`,
//! `passes.ts` (sign-in, `tools`, other kinds of pass) and `system.ts` (`bug-report`):
//! - `mcp`: the Connections window's MCP servers (`/api/mcp*`), their checks and sign-ins; `board-tools.json`,
//!   `mcp-seen.json`, `claude-ai-connectors.json`;
//! - `signin`: the board's passes that reach a service (online MCP sign-in with OAuth, keys for an online server,
//!   programs on this computer), `tools`, and the automations' pass calls (`automation-call`);
//! - `phone`: phone access on and off (`POST /api/remote`, `tailscale serve`), `GET /api/remote`, the link check;
//! - `agents_admin`: registering `ckanban mcp` with Claude Code and Codex (`POST /api/agents/:id/install|uninstall`);
//! - `bugreport`: `POST /api/bug-report` and `/api/bug-report/draft`;
//! - `routes`: the router that hands a request to the right one.

pub mod agents_admin;
pub mod bugreport;
pub mod edge;
pub mod mcp;
pub mod phone;
pub mod routes;
pub mod signin;

use std::sync::Arc;

use serde_json::Value;

/// One request to an outside route, as the router hands it over: the request gate, the Telegram front desk's gate and
/// the JSON content type rule are already checked (as Bun's `api()` does before its routes).
pub struct Call<'a> {
    /// "GET", "POST"...
    pub method: &'a str,
    /// The path after `/api/`, split on `/` and percent-decoded (Bun's `parts`).
    pub parts: &'a [String],
    /// The raw query string ("" when none).
    pub query: &'a str,
    /// The request body as it came (empty for GET).
    pub body: &'a [u8],
    /// The request came on this Mac's listener (Bun's `listenerOf(req) === "local"`), not the phone access listener.
    pub local: bool,
    /// The request carries a board run's header (`x-ckanban-run`, Bun's `RUN_HEADER`, non-empty).
    pub from_run: bool,
    /// Bun's `userOnly(req, what)`: Ok when the caller is the user; Err is the 403 answer to send.
    pub user: &'a (dyn Fn(&str) -> Result<(), Answer> + Send + Sync),
}

/// What a route answers. JSON answers are masked with the saved keys by the router (Bun's `ctx.json`).
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Json(u16, Value),
    /// A page (`text/html; charset=utf-8`, `cache-control: no-store`): the sign-in callback.
    Html(u16, String),
    /// No body (204).
    Empty(u16),
}

impl Answer {
    /// `{ error }` with a status, as Bun's error classes answer.
    pub fn error(status: u16, msg: impl Into<String>) -> Self {
        Answer::Json(status, serde_json::json!({ "error": msg.into() }))
    }
}

/// Puts an event on the board's event stream (`{type, ...}`), e.g. `mcp.updated`.
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Bun's `body(req)`: the JSON body, or 400 "invalid JSON body". Uses the JS-compatible parser of the server.
pub fn body_json(body: &[u8]) -> Result<Value, Answer> {
    let text = std::str::from_utf8(body).map_err(|_| Answer::error(400, "invalid JSON body"))?;
    ckanban_board::runs::js::parse(text).ok_or_else(|| Answer::error(400, "invalid JSON body"))
}
