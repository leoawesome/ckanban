//! The routes `ckanban-rs` answers itself, with `ckanban-core` (step 3b of the Rust port trial):
//! `GET /api/usage` (`?fresh=1` is the Refresh button) and `GET /api/spend`. Everything else, these paths with any
//! other method or spelling, and every request from the Telegram front desk, goes to Bun unchanged (proxy.rs).
//!
//! Answers match Bun's `src/api/system.ts`: 200 with `content-type: application/json`, the Host check of
//! `requestRefusal` in `src/api/context.ts` (403 `forbidden` as plain text), and a 500 `{"error": ...}` when spend
//! can't be counted.

use std::path::PathBuf;
use std::sync::Arc;

use bytes::Bytes;
use ckanban_core::{DataDir, SpendIndex, UsageCache, UsageClient};
use http_body_util::{BodyExt, Full};
use hyper::header::{CONTENT_TYPE, HOST, HeaderMap, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};

use crate::proxy::{Body, plain, wants_upgrade};

/// The Telegram front desk's header (`FRONT_DESK_HEADER` in `src/core/env.ts`): its requests go through Bun's gate.
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// `LOCAL_HOSTS` in `src/api/context.ts`.
const LOCAL_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

#[derive(Debug, PartialEq)]
pub enum Route {
    Usage { fresh: bool },
    Spend,
}

pub struct Native {
    /// The board's port as callers see it (this server's), for the Host check.
    public_port: u16,
    usage: UsageCache,
    spend: Arc<SpendIndex>,
}

impl Native {
    /// Same data folder as the Bun child; the usage cache reads `usage-last.json` now (a small file).
    pub fn new(root: PathBuf, public_port: u16) -> Arc<Self> {
        let dir = DataDir::new(root);
        Arc::new(Native {
            public_port,
            usage: UsageCache::for_daemon(&dir, UsageClient::from_env()),
            spend: Arc::new(SpendIndex::new(dir)),
        })
    }

    /// The answer when Rust answers this request itself; None sends it to Bun.
    pub async fn answer<B>(&self, req: &Request<B>) -> Option<Response<Body>> {
        let route = route_of(req.method(), req.uri().path(), req.uri().query(), req.headers())?;
        if !local_host(req.headers(), self.public_port) {
            return Some(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        Some(match route {
            // Waits for Anthropic only inside this request's own task: other requests (and the proxy) go on.
            Route::Usage { fresh } => json(StatusCode::OK, &self.usage.get(fresh).await),
            Route::Spend => match self.spend.recent().await {
                Ok(s) => json(StatusCode::OK, &s.to_json()),
                Err(e) => {
                    eprintln!("ckanban-rs: GET /api/spend: {e}");
                    json(StatusCode::INTERNAL_SERVER_ERROR, &serde_json::json!({ "error": e.to_string() }))
                }
            },
        })
    }
}

/// Which native route a request is, if any. Only the exact paths: `/api/usage/` and other spellings Bun also
/// accepts still reach Bun, which answers from the same shared `usage-last.json`.
pub fn route_of(method: &Method, path: &str, query: Option<&str>, headers: &HeaderMap) -> Option<Route> {
    if method != Method::GET || headers.contains_key(FRONT_DESK_HEADER) || wants_upgrade(headers) {
        return None;
    }
    match path {
        "/api/usage" => Some(Route::Usage { fresh: query_param(query.unwrap_or(""), "fresh").as_deref() == Some("1") }),
        "/api/spend" => Some(Route::Spend),
        _ => None,
    }
}

/// `requestRefusal` for a GET on the local listener: the Host must be localhost or 127.0.0.1 on the board's port.
fn local_host(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(HOST).and_then(|h| h.to_str().ok()) else { return false };
    LOCAL_HOSTS.iter().any(|h| host == format!("{h}:{port}"))
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

fn json(status: StatusCode, v: &serde_json::Value) -> Response<Body> {
    let text = serde_json::to_string(v).unwrap_or_else(|_| "null".into());
    let mut r = Response::new(Full::new(Bytes::from(text)).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

#[cfg(test)]
mod tests {
    use super::*;

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
