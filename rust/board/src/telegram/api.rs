//! The Bot API (`TelegramBot.api`, `explain`, `sendFile`): JSON over HTTPS to `<base>/bot<token>/<method>`, where the
//! base is `CKANBAN_TELEGRAM_URL` (a local fake in tests, never set on a real Mac) or api.telegram.org. Never fails:
//! errors come back as an answer with the token scrubbed; the token is never logged.

use std::time::Duration;

use serde_json::{Value, json};

use super::Telegram;
use super::text::scrub;
use crate::helper::notify_settings::TOKEN_RE;

pub const CONFLICT: &str = "Another program is reading this bot's messages, or the bot has a web address (webhook) set. Only one can: close the other program or remove its webhook, or make a new bot with BotFather just for ckanban.";
pub const BAD_TOKEN: &str = "Telegram doesn't accept this bot token. Copy it again from BotFather.";

/// `ApiReply`.
#[derive(Clone, Debug, Default)]
pub struct Reply {
    pub ok: bool,
    pub result: Value,
    pub error_code: Option<i64>,
    pub description: Option<String>,
    pub retry_after: Option<f64>,
}

impl Reply {
    fn failed(code: i64, description: String) -> Reply {
        Reply { ok: false, error_code: Some(code), description: Some(description), ..Default::default() }
    }

    fn of(v: &Value, status: u16) -> Reply {
        let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let mut error_code = v.get("error_code").and_then(Value::as_f64).map(|n| n as i64);
        if !ok && error_code.is_none() {
            error_code = Some(status as i64);
        }
        Reply {
            ok,
            result: v.get("result").cloned().unwrap_or(Value::Null),
            error_code,
            description: v.get("description").map(crate::runs::js::to_string),
            retry_after: v.get("parameters").and_then(|p| p.get("retry_after")).and_then(Value::as_f64),
        }
    }

    /// The sent message's id.
    pub fn message_id(&self) -> Option<i64> {
        let n = self.result.get("message_id")?.as_f64()?;
        (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
    }
}

/// `telegramApiBase`.
pub fn api_base() -> String {
    let b = std::env::var("CKANBAN_TELEGRAM_URL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "https://api.telegram.org".into());
    b.trim_end_matches('/').to_string()
}

/// `explain`: plain words for an API failure.
pub fn explain(r: &Reply) -> String {
    match r.error_code {
        Some(409) => CONFLICT.into(),
        Some(401 | 404) => BAD_TOKEN.into(),
        Some(0) => format!("Can't reach Telegram: {}", r.description.as_deref().unwrap_or("network error")),
        code => format!("Telegram answered: {}", r.description.clone().unwrap_or_else(|| code.map(|c| c.to_string()).unwrap_or_else(|| "undefined".into()))),
    }
}

/// How long one call may take.
fn timeout_for(method: &str) -> Duration {
    if method == "getUpdates" { Duration::from_secs(super::bot::POLL_TIMEOUT_S + 15) } else { Duration::from_secs(10) }
}

impl Telegram {
    /// One Bot API call with this token. `stop`: the poller's stop signal (getUpdates ends at once on it).
    pub async fn api_with(&self, token: &str, method: &str, body: &Value, stop: Option<tokio::sync::watch::Receiver<bool>>) -> Reply {
        if !TOKEN_RE.is_match(token) {
            return Reply::failed(401, "no bot token".into());
        }
        let url = format!("{}/bot{token}/{method}", api_base());
        let call = async {
            let res = self.http.post(&url).header("content-type", "application/json").body(serde_json::to_vec(body).unwrap_or_default()).timeout(timeout_for(method)).send().await;
            match res {
                Ok(r) => {
                    let status = r.status();
                    let bytes = r.bytes().await.unwrap_or_default();
                    match serde_json::from_slice::<Value>(&bytes) {
                        Ok(v) if v.is_object() => Reply::of(&v, status.as_u16()),
                        _ => Reply {
                            ok: status.is_success(),
                            error_code: Some(status.as_u16() as i64),
                            description: Some(format!("{} {}", status.as_u16(), status.canonical_reason().unwrap_or("")).trim().to_string()),
                            ..Default::default()
                        },
                    }
                }
                Err(e) => Reply::failed(0, error_text(e)),
            }
        };
        let mut r = match stop {
            Some(mut s) => tokio::select! {
                r = call => r,
                _ = s.wait_for(|v| *v) => Reply::failed(0, "This operation was aborted".into()),
            },
            None => call.await,
        };
        if let Some(d) = &r.description {
            r.description = Some(scrub(d, token));
        }
        r
    }

    /// One Bot API call with the saved token.
    pub async fn api(&self, method: &str, body: Value) -> Reply {
        let token = self.token();
        self.api_with(&token, method, &body, None).await
    }

    /// `sendDocument` (multipart): an error in plain words, or None when sent.
    pub async fn send_file(&self, chat_id: i64, file: &std::path::Path, caption: &str, reply_to: Option<i64>) -> Option<String> {
        let token = self.token();
        if !TOKEN_RE.is_match(&token) {
            return Some("Telegram isn't set up.".into());
        }
        let data = match tokio::fs::read(file).await {
            Ok(d) => d,
            Err(e) => return Some(format!("Can't reach Telegram: {}", scrub(&e.to_string(), &token))),
        };
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
        let boundary = format!("----ckanban{:x}", rand_u64());
        let mut body: Vec<u8> = Vec::new();
        let mut field = |k: &str, v: &str| {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
        };
        field("chat_id", &chat_id.to_string());
        field("caption", crate::runs::js::head16(caption, 1024));
        field("disable_notification", "true");
        if let Some(r) = reply_to {
            field("reply_parameters", &json!({ "message_id": r, "allow_sending_without_reply": true }).to_string());
        }
        let safe = name.replace(['"', '\r', '\n'], "_");
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{safe}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(&data);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let url = format!("{}/bot{token}/sendDocument", api_base());
        let res = self
            .http
            .post(&url)
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(body)
            .timeout(Duration::from_secs(120))
            .send()
            .await;
        match res {
            Ok(r) => {
                let status = r.status();
                let bytes = r.bytes().await.unwrap_or_default();
                let j = match serde_json::from_slice::<Value>(&bytes) {
                    Ok(v) if v.is_object() => Reply::of(&v, status.as_u16()),
                    _ => Reply { ok: status.is_success(), error_code: Some(status.as_u16() as i64), description: Some(status.as_u16().to_string()), ..Default::default() },
                };
                if j.ok {
                    return None;
                }
                let j = Reply { description: j.description.as_deref().map(|d| scrub(d, &token)), ..j };
                Some(explain(&j))
            }
            Err(e) => Some(format!("Can't reach Telegram: {}", scrub(&error_text(e), &token))),
        }
    }
}

/// A transport error in words, without the URL (it holds the token).
fn error_text(e: reqwest::Error) -> String {
    let e = e.without_url();
    if e.is_timeout() {
        return "The operation timed out.".into();
    }
    if e.is_connect() {
        return "Unable to connect. Is the computer able to access the url?".into();
    }
    e.to_string()
}

fn rand_u64() -> u64 {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    u64::from_le_bytes(b)
}
