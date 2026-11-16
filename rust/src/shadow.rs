//! Shadow mode in the front server (`docs/rust-port-board-plan.md` 3.4, `ckanban_board::index::shadow`): with
//! `CKANBAN_RUST_SHADOW=1` and board mode off, Bun's answers to the ticket list requests are read whole, sent on as
//! they are, and handed to the Rust board index to compare in the background. Nothing Rust works out is served.

use std::sync::Arc;

use ckanban_board::index::shadow::{self, Shadow};
use http_body_util::{BodyExt, Full};
use hyper::{Method, Response, StatusCode};

use crate::proxy::{Body, plain};

/// Shadow mode for this start, or None (off, or board mode owns the board).
pub fn prepare(root: &std::path::Path, board_mode: bool) -> Option<Arc<Shadow>> {
    if board_mode || !shadow::enabled() {
        return None;
    }
    eprintln!("ckanban-rs: shadow mode: ticket list answers are compared with the Rust board's; differences go to {}", root.join(shadow::LOG_FILE).display());
    Some(Shadow::new(root))
}

/// The request's path and query when shadow mode compares its answer.
pub fn wanted(method: &Method, path: &str, query: Option<&str>) -> Option<(String, String)> {
    let q = query.unwrap_or("");
    (method == Method::GET && shadow::route_key(path, q).is_some()).then(|| (path.to_string(), q.to_string()))
}

/// Reads Bun's answer whole, starts the comparison, and gives the same answer back.
pub async fn tee(s: &Arc<Shadow>, path: String, query: String, res: Response<Body>) -> Response<Body> {
    let status = res.status().as_u16();
    let (parts, body) = res.into_parts();
    match body.collect().await {
        Ok(c) => {
            let bytes = c.to_bytes();
            s.check(path, query, status, bytes.clone());
            Response::from_parts(parts, Full::new(bytes).map_err(|never| match never {}).boxed())
        }
        Err(e) => plain(StatusCode::BAD_GATEWAY, &format!("the board's daemon didn't answer: {e}")),
    }
}
