//! The satellite's edge over HTTP (plan 3.3), both ways. Every call carries `x-ckanban-satellite: <secret>` (the
//! front server's secret of this start): the proxy drops any copy a caller sends, so only Rust and the satellite can
//! make these calls, never a request passed through.
//!
//! - Board to satellite (`SatelliteClient`, implements `api::Satellite`): `POST /api/internal/<name>` on the
//!   satellite's internal port, names `frontdesk-gate`, `pass-call`, `publish`, `turn-ended`
//!   (`src/core/satellite-edge.ts` answers them).
//! - Satellite to board (`inbound`): `POST /api/internal/<name>` on the board's port, names `chat-from-telegram`,
//!   `patch-telegram`, `drop-telegram-queued`, `comment` (to `api::BoardActions`), and `replay` (a held front desk
//!   request after the user's Confirm, run by the server's router as the user).

use bytes::Bytes;
use futures_util::future::BoxFuture;
use http_body_util::{BodyExt, Full};
use hyper::{Request, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};

use crate::api::{BoardActions, Failure, Satellite};

/// The header that marks the edge's own calls; its value is the front server's secret.
pub const SATELLITE_HEADER: &str = "x-ckanban-satellite";
/// Set by the board on a request it passes to the satellite after the phone access listener checked it: the
/// satellite then treats it as a phone request (`listener: "remote"`). The proxy drops callers' copies.
pub const VIA_HEADER: &str = "x-ckanban-front-via";
/// Set by the board on a replayed front desk request it passes on: the satellite acts on it as the user
/// (`confirmedInTelegram`). The proxy drops callers' copies.
pub const CONFIRMED_HEADER: &str = "x-ckanban-front-confirmed";
/// What `/api/internal/<name>` starts with.
pub const INTERNAL_PREFIX: &str = "/api/internal/";
/// How long a call to the satellite may take (a pass tool call reaches an outside service).
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Whether `got` is this start's secret (same length and bytes, compared in constant time).
pub fn secret_matches(got: &[u8], secret: &str) -> bool {
    let want = secret.as_bytes();
    if got.len() != want.len() || want.is_empty() {
        return false;
    }
    got.iter().zip(want).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Calls the satellite's `/api/internal/...` on its internal port.
pub struct SatelliteClient {
    client: Client<HttpConnector, Full<Bytes>>,
    internal_port: u16,
    public_port: u16,
    secret: String,
}

impl SatelliteClient {
    pub fn new(internal_port: u16, public_port: u16, secret: &str) -> Self {
        let client = Client::builder(TokioExecutor::new()).set_host(false).build(HttpConnector::new());
        SatelliteClient { client, internal_port, public_port, secret: secret.to_string() }
    }

    /// One call: the answer's status and JSON body; Err when the satellite can't be reached.
    pub async fn call(&self, name: &str, body: &Value) -> Result<(u16, Value), Failure> {
        let req = Request::post(format!("http://127.0.0.1:{}{INTERNAL_PREFIX}{name}", self.internal_port))
            .header("host", format!("127.0.0.1:{}", self.public_port))
            .header("content-type", "application/json")
            .header("x-ckanban-front", &self.secret)
            .header(SATELLITE_HEADER, &self.secret)
            .body(Full::new(Bytes::from(serde_json::to_vec(body).unwrap_or_default())))
            .map_err(|e| e.to_string())?;
        let res = tokio::time::timeout(CALL_TIMEOUT, self.client.request(req))
            .await
            .map_err(|_| format!("the satellite didn't answer {name} within {}s", CALL_TIMEOUT.as_secs()))?
            .map_err(|e| format!("the satellite didn't answer {name}: {e}"))?;
        let status = res.status().as_u16();
        let bytes = res.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
        let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok((status, v))
    }

    async fn ok(&self, name: &str, body: Value) -> Result<Value, Failure> {
        let (status, v) = self.call(name, &body).await?;
        if (200..300).contains(&status) {
            Ok(v)
        } else {
            Err(v.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("the satellite answered {name} with {status}")))
        }
    }
}

impl Satellite for SatelliteClient {
    fn turn_ended(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<(), Failure>> {
        let body = json!({ "slug": slug, "id": id, "text": text });
        Box::pin(async move { self.ok("turn-ended", body).await.map(|_| ()) })
    }
    fn pass_call(&self, body: Value) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async move { self.ok("pass-call", body).await })
    }
    fn frontdesk_gate(&self, request: Value) -> BoxFuture<'_, Result<Option<Value>, Failure>> {
        Box::pin(async move {
            let v = self.ok("frontdesk-gate", request).await?;
            Ok(v.get("held").filter(|h| !h.is_null()).cloned())
        })
    }
    fn publish_artifact(&self, request: Value) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async move { self.ok("publish", request).await })
    }
}

fn text<'a>(b: &'a Value, k: &str) -> &'a str {
    b.get(k).and_then(Value::as_str).unwrap_or("")
}

/// A call from the satellite to the board's actions (every name but `replay`): the answer's status and body.
/// None: no such name.
pub async fn inbound(actions: &dyn BoardActions, name: &str, b: &Value) -> Option<(StatusCode, Value)> {
    let fail = |e: Failure| (StatusCode::NOT_IMPLEMENTED, json!({ "error": e }));
    Some(match name {
        "chat-from-telegram" => {
            let from = b.get("from").cloned().unwrap_or(Value::Null);
            match actions.chat_from_telegram(text(b, "slug"), text(b, "id"), text(b, "text"), from).await {
                Ok(sent) => (StatusCode::OK, json!({ "sent": sent })),
                Err(e) => fail(e),
            }
        }
        "patch-telegram" => match actions.patch_telegram(text(b, "slug"), text(b, "id"), b.get("patch").cloned().unwrap_or(Value::Null)) {
            Ok(()) => (StatusCode::OK, json!({ "ok": true })),
            Err(e) => fail(e),
        },
        "drop-telegram-queued" => match actions.drop_telegram_queued() {
            Ok(n) => (StatusCode::OK, json!({ "dropped": n })),
            Err(e) => fail(e),
        },
        "comment" => match actions.add_comment(text(b, "slug"), text(b, "id"), text(b, "author"), text(b, "text")) {
            Ok(()) => (StatusCode::OK, json!({ "ok": true })),
            Err(e) => fail(e),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::StandIn;

    #[test]
    fn secrets_compare_whole() {
        assert!(secret_matches(b"abc123", "abc123"));
        assert!(!secret_matches(b"abc12", "abc123"));
        assert!(!secret_matches(b"abc124", "abc123"));
        assert!(!secret_matches(b"", ""));
    }

    #[tokio::test]
    async fn stand_in_actions_refuse_until_their_task() {
        let (s, v) = inbound(&StandIn, "comment", &json!({"slug": "b", "id": "t", "author": "ai", "text": "x"})).await.unwrap();
        assert_eq!(s, StatusCode::NOT_IMPLEMENTED);
        assert!(v["error"].as_str().unwrap().contains("not in the Rust board yet"));
        assert_eq!(inbound(&StandIn, "drop-telegram-queued", &Value::Null).await.unwrap().1, json!({"dropped": 0}));
        assert!(inbound(&StandIn, "nope", &Value::Null).await.is_none());
    }
}
