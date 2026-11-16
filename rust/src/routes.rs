//! The routes `ckanban-rs` answers itself: `GET /api/usage` (`?fresh=1` is the Refresh button) and `GET /api/spend`
//! with `ckanban-core` (step 3 of the trial), the board's passes and keys (passes.rs) and `GET /api/agents`
//! (agents.rs). Everything else, these paths with any other method or spelling, and every request from the Telegram
//! front desk, goes to Bun unchanged (proxy.rs).
//!
//! Before any of them, the checks Bun's server makes first: `requestRefusal` in `src/api/context.ts` (Host, and the
//! Origin of a change; 403 `forbidden` as plain text), then a JSON content type for POST, PATCH and PUT (415). Usage
//! and spend answers match `src/api/system.ts`: 200 with `content-type: application/json`, and a 500
//! `{"error": ...}` when spend can't be counted.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::{DataDir, SpendIndex, UsageCache, UsageClient};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::header::{CONTENT_TYPE, HOST, HeaderMap, ORIGIN};
use hyper::{Method, Request, Response, StatusCode};

use crate::agents::Agents;
use crate::passes::{self, Outcome, Passes};
use crate::proxy::{Body, plain, wants_upgrade};

/// The Telegram front desk's header (`FRONT_DESK_HEADER` in `src/core/env.ts`): its requests go through Bun's gate.
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// `LOCAL_HOSTS` in `src/api/context.ts`.
const LOCAL_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

#[derive(Debug, PartialEq)]
pub enum Route {
    Usage { fresh: bool },
    Spend,
    Passes(passes::Route),
    Agents,
}

pub struct Native {
    /// The board's port as callers see it (this server's), for the Host and Origin checks.
    public_port: u16,
    root: PathBuf,
    usage: UsageCache,
    spend: Arc<SpendIndex>,
    passes: Arc<Passes>,
    /// None when Bun's own command line can't be known for sure: Bun answers `GET /api/agents` then.
    agents: Option<Arc<Agents>>,
}

impl Native {
    /// Same data folder as the Bun child; the usage cache reads `usage-last.json` now (a small file). `notify` tells
    /// the Bun child about a file Rust changed; `bun` and `repo` are how the child was started.
    pub fn new(root: PathBuf, public_port: u16, notify: passes::Notify, bun: &Path, repo: &Path) -> Arc<Self> {
        let dir = DataDir::new(root.clone());
        Arc::new(Native {
            public_port,
            usage: UsageCache::for_daemon(&dir, UsageClient::from_env()),
            spend: Arc::new(SpendIndex::new(dir)),
            passes: Arc::new(Passes::new(root.clone(), notify)),
            agents: Agents::new(bun, repo).map(Arc::new),
            root,
        })
    }

    /// The answer when Rust answers this request itself; otherwise the request (its body read or not) goes to Bun.
    pub async fn answer(&self, req: Request<Incoming>, peer: SocketAddr) -> Result<Response<Body>, Request<Body>> {
        let bun = |req: Request<Incoming>| req.map(|b| b.boxed());
        let Some(route) = route_of(req.method(), req.uri().path(), req.uri().query(), req.headers()) else { return Err(bun(req)) };
        if route == Route::Agents && self.agents.is_none() {
            return Err(bun(req));
        }
        let h = req.headers();
        // Headers Bun would read joined (two Host lines, say): only Bun knows what it makes of them.
        if [HOST, ORIGIN, CONTENT_TYPE].iter().any(|n| h.get_all(n).iter().count() > 1) {
            return Err(bun(req));
        }
        if !local_host(h, self.public_port) || (is_mutation(req.method()) && !local_origin(h, self.public_port)) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT) && !json_type(h) {
            let msg = serde_json::json!({ "error": "content-type must be application/json" });
            return Ok(passes::json_answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, &msg, &passes::current_secrets(&self.root)));
        }
        Ok(match route {
            // Waits for Anthropic only inside this request's own task: other requests (and the proxy) go on.
            Route::Usage { fresh } => passes::json_answer(StatusCode::OK, &self.usage.get(fresh).await, &passes::current_secrets(&self.root)),
            Route::Spend => match self.spend.recent().await {
                Ok(s) => passes::json_answer(StatusCode::OK, &s.to_json(), &passes::current_secrets(&self.root)),
                Err(e) => {
                    eprintln!("ckanban-rs: GET /api/spend: {e}");
                    passes::json_answer(StatusCode::INTERNAL_SERVER_ERROR, &serde_json::json!({ "error": e.to_string() }), &passes::current_secrets(&self.root))
                }
            },
            Route::Passes(r) => match self.passes.answer(r, req, peer.port()).await {
                Outcome::Answer(res) => res,
                Outcome::Bun(req) => return Err(req),
            },
            Route::Agents => {
                let agents = self.agents.clone().expect("checked above");
                match tokio::task::spawn_blocking(move || agents.status()).await {
                    Ok(v) => passes::json_answer(StatusCode::OK, &v, &passes::current_secrets(&self.root)),
                    Err(_) => return Err(bun(req)),
                }
            }
        })
    }
}

/// Which native route a request is, if any. Only the exact paths: `/api/usage/` and other spellings Bun also
/// accepts still reach Bun, which answers from the same files.
pub fn route_of(method: &Method, path: &str, query: Option<&str>, headers: &HeaderMap) -> Option<Route> {
    if headers.contains_key(FRONT_DESK_HEADER) || wants_upgrade(headers) {
        return None;
    }
    if let Some(r) = passes::route_of(method, path) {
        return Some(Route::Passes(r));
    }
    if method != Method::GET {
        return None;
    }
    match path {
        "/api/usage" => Some(Route::Usage { fresh: query_param(query.unwrap_or(""), "fresh").as_deref() == Some("1") }),
        "/api/spend" => Some(Route::Spend),
        "/api/agents" => Some(Route::Agents),
        _ => None,
    }
}

fn is_mutation(m: &Method) -> bool {
    m != Method::GET && m != Method::HEAD
}

/// `requestRefusal` on the local listener: the Host must be localhost or 127.0.0.1 on the board's port.
pub(crate) fn local_host(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(HOST).and_then(|h| h.to_str().ok()) else { return false };
    LOCAL_HOSTS.iter().any(|h| host == format!("{h}:{port}"))
}

/// `requestRefusal` for a change: an Origin, when sent (and not empty), must be the board's own page.
fn local_origin(headers: &HeaderMap, port: u16) -> bool {
    match headers.get(ORIGIN) {
        None => true,
        Some(o) if o.is_empty() => true,
        Some(o) => o.to_str().is_ok_and(|o| LOCAL_HOSTS.iter().any(|h| o == format!("http://{h}:{port}"))),
    }
}

/// Bun's `type === "application/json"`: the content type before any `;`, trimmed, any case.
fn json_type(headers: &HeaderMap) -> bool {
    let raw = headers.get(CONTENT_TYPE).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).unwrap_or_default();
    crate::js::trim(raw.split(';').next().unwrap_or("")).to_lowercase() == "application/json"
}

/// `URLSearchParams.get(name)`: the first value for `name`, decoded like a form (`+` is a space, `%XX` a byte).
fn query_param(query: &str, name: &str) -> Option<String> {
    query.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (form_decode(k) == name).then(|| form_decode(v))
    })
}

fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 2;
                }
                _ => out.push(b'%'),
            },
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}


#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(*k, HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn only_get_on_the_exact_paths_is_native() {
        let none = HeaderMap::new();
        assert_eq!(route_of(&Method::GET, "/api/usage", None, &none), Some(Route::Usage { fresh: false }));
        assert_eq!(route_of(&Method::GET, "/api/usage", Some("fresh=1"), &none), Some(Route::Usage { fresh: true }));
        assert_eq!(route_of(&Method::GET, "/api/spend", Some("x=1"), &none), Some(Route::Spend));
        assert_eq!(route_of(&Method::POST, "/api/usage", None, &none), None);
        assert_eq!(route_of(&Method::HEAD, "/api/spend", None, &none), None);
        assert_eq!(route_of(&Method::GET, "/api/usage/", None, &none), None);
        assert_eq!(route_of(&Method::GET, "/api/spending", None, &none), None);
        assert_eq!(route_of(&Method::GET, "/api/team-usage", None, &none), None);
        assert_eq!(route_of(&Method::GET, "/api/usage", None, &h(&[("x-ckanban-frontdesk", "c1")])), None);
        assert_eq!(route_of(&Method::GET, "/api/usage", None, &h(&[("connection", "upgrade"), ("upgrade", "websocket")])), None);
        assert_eq!(route_of(&Method::GET, "/api/agents", None, &none), Some(Route::Agents));
        assert_eq!(route_of(&Method::POST, "/api/agents/claude/install", None, &none), None);
        assert_eq!(route_of(&Method::GET, "/api/agents/", None, &none), None);
        assert_eq!(route_of(&Method::PATCH, "/api/passes/x1", None, &none), Some(Route::Passes(passes::Route::Replace("x1".into()))));
        assert_eq!(route_of(&Method::POST, "/api/passes", None, &h(&[("x-ckanban-frontdesk", "c1")])), None);
        assert_eq!(route_of(&Method::GET, "/api/mcp", None, &none), None);
        assert_eq!(route_of(&Method::GET, "/api/remote", None, &none), None);
    }

    #[test]
    fn origin_and_content_type_like_bun() {
        assert!(local_origin(&HeaderMap::new(), 7777));
        assert!(local_origin(&h(&[("origin", "")]), 7777));
        assert!(local_origin(&h(&[("origin", "http://localhost:7777")]), 7777));
        assert!(local_origin(&h(&[("origin", "http://127.0.0.1:7777")]), 7777));
        assert!(!local_origin(&h(&[("origin", "http://localhost:7778")]), 7777));
        assert!(!local_origin(&h(&[("origin", "https://localhost:7777")]), 7777));
        assert!(!local_origin(&h(&[("origin", "null")]), 7777));
        assert!(json_type(&h(&[("content-type", "application/json")])));
        assert!(json_type(&h(&[("content-type", " Application/JSON ; charset=utf-8")])));
        assert!(!json_type(&h(&[("content-type", "text/plain")])));
        assert!(!json_type(&HeaderMap::new()));
    }

    #[test]
    fn fresh_reads_like_url_search_params() {
        let fresh = |q| route_of(&Method::GET, "/api/usage", Some(q), &HeaderMap::new()) == Some(Route::Usage { fresh: true });
        assert!(fresh("fresh=1"));
        assert!(fresh("a=b&fresh=%31"));
        assert!(fresh("fresh=1&fresh=0"));
        assert!(!fresh("fresh=0&fresh=1"));
        assert!(!fresh("fresh=true"));
        assert!(!fresh("fresh"));
        assert!(!fresh("fresh=1%"));
        assert_eq!(form_decode("a+b%20c%zz%4"), "a b c%zz%4");
    }

    #[test]
    fn host_must_be_this_mac_on_the_board_port() {
        assert!(local_host(&h(&[("host", "localhost:7777")]), 7777));
        assert!(local_host(&h(&[("host", "127.0.0.1:7777")]), 7777));
        assert!(!local_host(&h(&[("host", "127.0.0.1:7778")]), 7777));
        assert!(!local_host(&h(&[("host", "evil.example:7777")]), 7777));
        assert!(!local_host(&h(&[("host", "localhost")]), 7777));
        assert!(!local_host(&HeaderMap::new(), 7777));
    }
}
