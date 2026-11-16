//! The CLI's HTTP calls to the daemon (`BoardClient.req` in `src/cli/client.ts`), blocking from the caller's view: a
//! small current-thread runtime per call. The daemon only listens on 127.0.0.1, so every call connects there; the
//! Host header is `127.0.0.1:<port>` for board commands and `localhost:<port>` for `restart`, as Bun sends them.
//! No Origin header, ever.

use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full, combinators::BoxBody};
use hyper::Request;
use hyper_util::rt::TokioIo;
use serde_json::Value;

use super::args::js_str;

pub const DAEMON_DOWN: &str = "ckanban daemon not running, run `ckanban install` or `ckanban dev`";

/// Bun's fetch gives up on a silent answer after this long unless the call says it may wait (`timeout: false`).
const DEFAULT_WAIT: Duration = Duration::from_secs(300);

pub struct Answer {
    pub status: u16,
    pub body: Bytes,
}

/// One request. `None` when it couldn't be sent or answered (refused, reset, timed out).
pub fn send(port: u16, host: &str, method: &str, path: &str, headers: &[(String, String)], body: Option<String>, wait: Option<Duration>) -> Option<Answer> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
    let fut = async {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.ok()?;
        tokio::spawn(conn);
        let mut req = Request::builder().method(method).uri(path).header("host", host);
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
        let body: BoxBody<Bytes, std::convert::Infallible> = match body {
            Some(b) => Full::new(Bytes::from(b)).boxed(),
            None => Empty::new().boxed(),
        };
        let res = sender.send_request(req.body(body).ok()?).await.ok()?;
        let status = res.status().as_u16();
        let body = res.into_body().collect().await.ok()?.to_bytes();
        Some(Answer { status, body })
    };
    match wait {
        Some(d) => rt.block_on(async { tokio::time::timeout(d, fut).await.ok().flatten() }),
        None => rt.block_on(fut),
    }
}

/// The board client: `http://127.0.0.1:<port>`, identity headers from the environment.
pub struct Client {
    pub port: u16,
}

impl Client {
    /// `req`: the parsed JSON answer (Null for 204 or an empty body), or the error text the CLI prints.
    pub fn req(&self, method: &str, path: &str, body: Option<&Value>, extra: &[(&str, String)], long: bool) -> Result<Value, String> {
        let mut headers: Vec<(String, String)> = Vec::new();
        if body.is_some() {
            headers.push(("content-type".into(), "application/json".into()));
        }
        // The Telegram front desk's and quick chat's runs say who they are.
        for (env, header) in [("CKANBAN_FRONTDESK", "x-ckanban-frontdesk"), ("CKANBAN_QUICK_CHAT", "x-ckanban-quick-chat")] {
            if let Some(v) = std::env::var(env).ok().filter(|v| !v.is_empty()) {
                headers.push((header.into(), v));
            }
        }
        for (k, v) in extra {
            headers.push((k.to_string(), v.clone()));
        }
        let text = body.map(super::args::compact);
        let host = format!("127.0.0.1:{}", self.port);
        let res = send(self.port, &host, method, path, &headers, text, if long { None } else { Some(DEFAULT_WAIT) }).ok_or_else(|| DAEMON_DOWN.to_string())?;
        if res.status == 204 {
            return Ok(Value::Null);
        }
        let data: Value = if res.body.is_empty() { Value::Null } else { serde_json::from_slice(&res.body).unwrap_or(Value::Null) };
        if !(200..300).contains(&res.status) {
            return Err(match data.get("error") {
                Some(e) if !e.is_null() => js_str(Some(e)),
                _ => format!("{method} {path} failed: {}", res.status),
            });
        }
        if res.status == 202 {
            if let Some(Value::String(c)) = data.get("confirmation") {
                return Err(c.clone());
            }
        }
        Ok(data)
    }
}

/// `encodeURIComponent`.
pub fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// One `URLSearchParams` value (form encoding: space is `+`).
pub fn form(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"*-._".contains(&b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_js() {
        assert_eq!(enc("a b/c~é"), "a%20b%2Fc~%C3%A9");
        assert_eq!(form("fix it~*"), "fix+it%7E*");
    }
}
