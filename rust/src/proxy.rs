//! Passes one request to the Bun child and its answer back: method, path, query, headers (Host and Origin as sent),
//! body and status unchanged, streamed both ways (server-sent events go out as Bun writes them), and WebSocket
//! upgrades joined into one tunnel. Only hop-by-hop headers are dropped. The caller's TCP port and this start's secret
//! go to Bun in two headers it trusts only with the secret (`src/core/front.ts`).

use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::header::{CONNECTION, HeaderMap, HeaderName, HeaderValue, UPGRADE};
use hyper::{Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::{TokioExecutor, TokioIo};

pub const FRONT_SECRET_HEADER: &str = "x-ckanban-front";
pub const FRONT_PEER_HEADER: &str = "x-ckanban-peer-port";

pub type Body = BoxBody<Bytes, hyper::Error>;

/// Headers Bun trusts from this server only (with the secret): any copy a caller sends is dropped before passing a
/// request on. The front's secret and the caller's port; board mode's phone listener mark, replay mark and the
/// satellite edge's own header (`ckanban_board::gate::edge`).
const TRUSTED_HEADERS: [&str; 5] = [
    FRONT_SECRET_HEADER,
    FRONT_PEER_HEADER,
    ckanban_board::gate::edge::VIA_HEADER,
    ckanban_board::gate::edge::CONFIRMED_HEADER,
    ckanban_board::gate::edge::SATELLITE_HEADER,
];

/// Headers that belong to one connection, not to the message (RFC 9110 7.6.1), plus the ones `Connection` names.
const HOP_BY_HOP: [&str; 8] =
    ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding"];

pub struct Proxy {
    client: Client<HttpConnector, Body>,
    /// 127.0.0.1:<internal port> of the Bun child.
    backend: String,
    secret: HeaderValue,
}

impl Proxy {
    pub fn new(internal_port: u16, secret: &str) -> Arc<Self> {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        let client = Client::builder(TokioExecutor::new()).set_host(false).build(connector);
        Arc::new(Proxy {
            client,
            backend: format!("127.0.0.1:{internal_port}"),
            secret: HeaderValue::from_str(secret).expect("hex secret is a valid header value"),
        })
    }

    /// One request from a caller at `peer` (its body as it streams in, or as a native route already read it).
    pub async fn forward(&self, req: Request<Body>, peer: SocketAddr) -> Response<Body> {
        self.forward_as(req, peer, &[]).await
    }

    /// `forward` with headers only this server sets (board mode: the phone listener's `x-ckanban-front-via`, a
    /// replayed front desk request's `x-ckanban-front-confirmed`).
    pub async fn forward_as(&self, mut req: Request<Body>, peer: SocketAddr, extra: &[(&'static str, &'static str)]) -> Response<Body> {
        let upgrade = wants_upgrade(req.headers());
        let caller_upgrade = upgrade.then(|| hyper::upgrade::on(&mut req));

        let (mut parts, body) = req.into_parts();
        let path = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
        parts.uri = match format!("http://{}{}", self.backend, path).parse::<Uri>() {
            Ok(u) => u,
            Err(_) => return plain(StatusCode::BAD_REQUEST, "bad request target"),
        };
        strip_hop_by_hop(&mut parts.headers, upgrade);
        // Only this server says who the caller is: copies from the caller are dropped, never passed on.
        for h in TRUSTED_HEADERS {
            parts.headers.remove(h);
        }
        for (k, v) in extra {
            parts.headers.insert(HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        parts.headers.insert(HeaderName::from_static(FRONT_SECRET_HEADER), self.secret.clone());
        parts.headers.insert(HeaderName::from_static(FRONT_PEER_HEADER), HeaderValue::from(peer.port()));
        // HTTP/1.1 to Bun whatever the caller spoke (Bun's server is HTTP/1.1).
        parts.version = hyper::Version::HTTP_11;

        let mut res = match self.client.request(Request::from_parts(parts, body)).await {
            Ok(r) => r,
            Err(e) => return plain(StatusCode::BAD_GATEWAY, &format!("the board's daemon didn't answer: {e}")),
        };

        if res.status() == StatusCode::SWITCHING_PROTOCOLS {
            let Some(caller_upgrade) = caller_upgrade else {
                return plain(StatusCode::BAD_GATEWAY, "the board's daemon switched protocols unasked");
            };
            let backend_upgrade = hyper::upgrade::on(&mut res);
            tokio::spawn(async move {
                let (Ok(caller), Ok(backend)) = (caller_upgrade.await, backend_upgrade.await) else { return };
                let mut caller = TokioIo::new(caller);
                let mut backend = TokioIo::new(backend);
                let _ = tokio::io::copy_bidirectional(&mut caller, &mut backend).await;
            });
            let (mut parts, _) = res.into_parts();
            strip_hop_by_hop(&mut parts.headers, true);
            return Response::from_parts(parts, empty());
        }

        let (mut parts, body) = res.into_parts();
        strip_hop_by_hop(&mut parts.headers, false);
        Response::from_parts(parts, body.boxed())
    }

    /// Whether the Bun child answers a cheap GET (`/api/profiles`) as a request through this server would.
    pub async fn ready(&self, public_port: u16) -> bool {
        let Ok(uri) = format!("http://{}/api/profiles", self.backend).parse::<Uri>() else { return false };
        let mut req = Request::get(uri);
        req = req.header("host", format!("127.0.0.1:{public_port}")).header(FRONT_SECRET_HEADER, self.secret.clone());
        // A body-less client for this one check (the main client sends the caller's streaming bodies).
        let client: Client<HttpConnector, Full<Bytes>> = Client::builder(TokioExecutor::new()).set_host(false).build(HttpConnector::new());
        let Ok(req) = req.body(Full::new(Bytes::new())) else { return false };
        match tokio::time::timeout(std::time::Duration::from_secs(2), client.request(req)).await {
            Ok(Ok(res)) => res.status().is_success(),
            _ => false,
        }
    }
}

/// A WebSocket (or other) upgrade: `Connection: upgrade` with an `Upgrade` header.
pub fn wants_upgrade(h: &HeaderMap) -> bool {
    h.contains_key(UPGRADE) && connection_tokens(h).iter().any(|t| t == "upgrade")
}

fn connection_tokens(h: &HeaderMap) -> Vec<String> {
    h.get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Drops hop-by-hop headers and the ones `Connection` names. For an upgrade, `Connection: upgrade` and `Upgrade` stay:
/// the next hop must see them to switch protocols.
pub fn strip_hop_by_hop(h: &mut HeaderMap, upgrade: bool) {
    let named = connection_tokens(h);
    for t in &named {
        if upgrade && t == "upgrade" {
            continue;
        }
        if let Ok(n) = HeaderName::from_bytes(t.as_bytes()) {
            h.remove(n);
        }
    }
    for n in HOP_BY_HOP {
        h.remove(n);
    }
    if upgrade {
        h.insert(CONNECTION, HeaderValue::from_static("upgrade"));
    } else {
        h.remove(UPGRADE);
    }
}

fn empty() -> Body {
    Full::new(Bytes::new()).map_err(|never| match never {}).boxed()
}

pub fn full(b: Bytes) -> Body {
    Full::new(b).map_err(|never| match never {}).boxed()
}

pub fn plain(status: StatusCode, text: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(text.to_string())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn strips_hop_by_hop_keeps_the_rest() {
        let mut h = headers(&[
            ("host", "127.0.0.1:7777"),
            ("origin", "http://127.0.0.1:7777"),
            ("connection", "keep-alive, x-private"),
            ("keep-alive", "timeout=5"),
            ("x-private", "1"),
            ("transfer-encoding", "chunked"),
            ("te", "trailers"),
            ("upgrade", "h2c"),
            ("x-ckanban-run", "abc"),
            ("cookie", "a=1"),
        ]);
        strip_hop_by_hop(&mut h, false);
        let mut left: Vec<_> = h.keys().map(|k| k.as_str().to_string()).collect();
        left.sort();
        assert_eq!(left, ["cookie", "host", "origin", "x-ckanban-run"]);
        assert_eq!(h["host"], "127.0.0.1:7777");
    }

    #[test]
    fn upgrade_keeps_connection_and_upgrade() {
        let mut h = headers(&[("connection", "Upgrade"), ("upgrade", "websocket"), ("sec-websocket-key", "k"), ("keep-alive", "1")]);
        assert!(wants_upgrade(&h));
        strip_hop_by_hop(&mut h, true);
        assert_eq!(h["connection"], "upgrade");
        assert_eq!(h["upgrade"], "websocket");
        assert_eq!(h["sec-websocket-key"], "k");
        assert!(!h.contains_key("keep-alive"));
    }

    #[test]
    fn upgrade_needs_both_headers() {
        assert!(!wants_upgrade(&headers(&[("upgrade", "websocket")])));
        assert!(!wants_upgrade(&headers(&[("connection", "upgrade")])));
        assert!(wants_upgrade(&headers(&[("connection", "keep-alive, Upgrade"), ("upgrade", "websocket")])));
    }
}
