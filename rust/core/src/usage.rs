//! `src/usage/usage.ts`: Claude plan usage from Anthropic's OAuth usage endpoint. The OAuth token is read per check
//! and never leaves this module: no logging, no caching, no answer field.

use crate::jsnum::{finite, num};
use crate::time::{iso, parse_date};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
pub const RATE_LIMITED: &str = "Anthropic is limiting usage checks";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq)]
pub struct UsageWindow {
    pub key: String,
    pub label: String,
    /// 0-100
    pub percent: f64,
    pub resets_at: Option<String>,
}

impl UsageWindow {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("key".into(), self.key.clone().into());
        m.insert("label".into(), self.label.clone().into());
        m.insert("percent".into(), num(self.percent));
        m.insert("resetsAt".into(), self.resets_at.clone().map_or(Value::Null, Value::String));
        Value::Object(m)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum UsageResult {
    Answer { windows: Vec<UsageWindow>, fetched_at: String },
    Failure {
        error: String,
        fetched_at: String,
        /// HTTP status when Anthropic answered (429 = rate limited).
        status: Option<u16>,
        /// Anthropic's retry-after, in ms, when it sent one.
        retry_after_ms: Option<f64>,
    },
}

impl UsageResult {
    pub fn failure(error: impl Into<String>, fetched_at: String) -> Self {
        Self::Failure { error: error.into(), fetched_at, status: None, retry_after_ms: None }
    }

    /// The object Bun's fetchUsage resolves to (key order included).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            Self::Answer { windows, fetched_at } => {
                m.insert("windows".into(), windows_json(windows));
                m.insert("fetchedAt".into(), fetched_at.clone().into());
            }
            Self::Failure { error, fetched_at, status, retry_after_ms } => {
                m.insert("error".into(), error.clone().into());
                m.insert("fetchedAt".into(), fetched_at.clone().into());
                if let Some(s) = status {
                    m.insert("status".into(), num(f64::from(*s)));
                }
                if let Some(r) = retry_after_ms {
                    m.insert("retryAfterMs".into(), num(*r));
                }
            }
        }
        Value::Object(m)
    }
}

pub fn windows_json(w: &[UsageWindow]) -> Value {
    Value::Array(w.iter().map(UsageWindow::to_json).collect())
}

/// retry-after as seconds or an HTTP date, in ms; None when missing or unreadable.
pub fn parse_retry_after(v: Option<&str>, now: f64) -> Option<f64> {
    let t = v?.trim();
    if t.is_empty() {
        return None;
    }
    let (int, frac) = t.split_once('.').unwrap_or((t, "1"));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if digits(int) && digits(frac) {
        // Math.round: halves go up.
        return Some((t.parse::<f64>().ok()? * 1000.0 + 0.5).floor());
    }
    parse_date(t).map(|at| (at - now).max(0.0))
}

const LABELS: [(&str, &str); 4] = [
    ("five_hour", "Current session (5h)"),
    ("seven_day", "Week · all models"),
    ("seven_day_opus", "Week · Opus"),
    ("seven_day_sonnet", "Week · Sonnet"),
];

fn label(key: &str) -> String {
    if let Some((_, l)) = LABELS.iter().find(|(k, _)| *k == key) {
        return (*l).to_string();
    }
    let rest = key.strip_prefix("seven_day").map(|r| r.strip_prefix('_').unwrap_or(r)).unwrap_or(key);
    let rest = rest.replace('_', " ");
    format!("Week · {}", if rest.is_empty() { "other" } else { &rest })
}

/// Turns the endpoint's JSON into windows; None when the shape is not what we expect.
pub fn normalize_usage(body: &Value) -> Option<Vec<UsageWindow>> {
    let obj = body.as_object()?;
    let mut out = Vec::new();
    let mut saw_window_key = false;
    for (key, v) in obj {
        // Other keys (extra usage, internal flags) are not plan windows.
        if !(key.starts_with("five_hour") || key.starts_with("seven_day")) {
            continue;
        }
        saw_window_key = true;
        let Some(w) = v.as_object() else { continue };
        let Some(utilization) = finite(w.get("utilization")) else { continue };
        let reset = w.get("resets_at").and_then(Value::as_str).filter(|s| parse_date(s).is_some()).map(str::to_string);
        out.push(UsageWindow { key: key.clone(), label: label(key), percent: utilization.clamp(0.0, 100.0), resets_at: reset });
    }
    if !saw_window_key {
        return None;
    }
    let rank = |k: &str| LABELS.iter().position(|(x, _)| *x == k).unwrap_or(LABELS.len());
    out.sort_by_key(|w| rank(&w.key)); // stable, like Array.prototype.sort
    Some(out)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Credentials {
    Token { token: String, expires_at: Option<f64> },
    Error(String),
}

/// Parses Claude Code's stored credentials JSON (keychain secret or ~/.claude/.credentials.json).
pub fn parse_credentials(raw: &str) -> Credentials {
    let Ok(j) = serde_json::from_str::<Value>(raw) else {
        return Credentials::Error("Claude Code credentials are unreadable".into());
    };
    let o = j.get("claudeAiOauth");
    match o.and_then(|o| o.get("accessToken")).and_then(Value::as_str) {
        Some(t) if !t.is_empty() => Credentials::Token {
            token: t.to_string(),
            expires_at: o.and_then(|o| o.get("expiresAt")).and_then(Value::as_f64),
        },
        _ => Credentials::Error("Not logged in to Claude Code with a Claude plan".into()),
    }
}

/// Picks the login to use from every stored copy: the newest wins (no expiry counts as current, else the latest
/// `expiresAt`); a stale same-named keychain item must not hide the live one.
pub fn pick_credentials(raws: &[Option<String>]) -> Credentials {
    let mut best: Option<(String, Option<f64>)> = None;
    let mut first_error: Option<String> = None;
    let rank = |e: Option<f64>| e.unwrap_or(f64::INFINITY);
    for raw in raws.iter().flatten() {
        if raw.is_empty() {
            continue;
        }
        match parse_credentials(raw) {
            Credentials::Error(e) => {
                first_error.get_or_insert(e);
            }
            Credentials::Token { token, expires_at } => {
                if best.as_ref().is_none_or(|b| rank(expires_at) > rank(b.1)) {
                    best = Some((token, expires_at));
                }
            }
        }
    }
    match best {
        Some((token, expires_at)) => Credentials::Token { token, expires_at },
        None => Credentials::Error(first_error.unwrap_or_else(|| "Not logged in to Claude Code".into())),
    }
}

/// Where the usage check asks and where it finds the login. `from_env()` reads the same env vars as Bun.
#[derive(Clone)]
pub struct UsageClient {
    /// `CKANBAN_USAGE_URL`, else Anthropic's endpoint.
    pub url: String,
    /// False with `CKANBAN_NO_KEYCHAIN=1` (tests must never reach the real Mac keychain) and off macOS.
    pub keychain: bool,
    /// `CLAUDE_CONFIG_DIR`, else `~/.claude`; the file is `.credentials.json` in it.
    pub claude_dir: PathBuf,
    http: reqwest::Client,
}

impl UsageClient {
    pub fn new(url: impl Into<String>, keychain: bool, claude_dir: impl Into<PathBuf>) -> Self {
        let http = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().expect("http client");
        Self { url: url.into(), keychain, claude_dir: claude_dir.into(), http }
    }

    pub fn from_env() -> Self {
        let nonempty = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let url = nonempty("CKANBAN_USAGE_URL").unwrap_or_else(|| DEFAULT_USAGE_URL.into());
        let keychain = cfg!(target_os = "macos") && std::env::var("CKANBAN_NO_KEYCHAIN").ok().as_deref() != Some("1");
        let claude_dir = nonempty("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| crate::home::home_dir().join(".claude"));
        Self::new(url, keychain, claude_dir)
    }

    async fn read_keychain(account: Option<&str>) -> Option<String> {
        let mut cmd = tokio::process::Command::new("security");
        cmd.args(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
        if let Some(a) = account {
            cmd.args(["-a", a]);
        }
        cmd.arg("-w").stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        let out = cmd.output().await.ok()?;
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !s.is_empty()).then_some(s)
    }

    /// Keychain (the OS user's account, then any item) when allowed, then the credentials file.
    pub async fn read_credentials(&self) -> Credentials {
        let mut raws = Vec::new();
        if self.keychain {
            if let Some(user) = crate::home::user_name() {
                raws.push(Self::read_keychain(Some(&user)).await);
            }
            raws.push(Self::read_keychain(None).await);
        }
        let file = self.claude_dir.join(".credentials.json");
        raws.push(tokio::task::spawn_blocking(move || std::fs::read_to_string(file).ok()).await.ok().flatten());
        pick_credentials(&raws)
    }

    /// `fetchUsage()`: reads the login, then asks the endpoint.
    pub async fn fetch_usage(&self) -> UsageResult {
        let creds = self.read_credentials().await;
        self.fetch_with(creds, crate::time::now_ms).await
    }

    /// The request part of `fetchUsage()`, with the login and clock given.
    pub async fn fetch_with(&self, creds: Credentials, now: impl Fn() -> f64) -> UsageResult {
        let fetched_at = || iso(now());
        let token = match creds {
            Credentials::Error(e) => return UsageResult::failure(e, fetched_at()),
            Credentials::Token { expires_at: Some(e), .. } if e <= now() => {
                return UsageResult::failure("Token expired: run any claude command to refresh it", fetched_at());
            }
            Credentials::Token { token, .. } => token,
        };
        let sent = self
            .http
            .get(&self.url)
            .header("authorization", format!("Bearer {token}"))
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("accept", "application/json")
            .header("user-agent", "ckanban")
            .send()
            .await;
        let r = match sent {
            Ok(r) => r,
            Err(e) => {
                let msg = if e.is_timeout() { "Anthropic did not answer in time" } else { "Could not reach Anthropic (offline?)" };
                return UsageResult::failure(msg, fetched_at());
            }
        };
        let status = r.status().as_u16();
        let fail = |error: &str, retry_after_ms: Option<f64>| UsageResult::Failure {
            error: error.into(),
            fetched_at: fetched_at(),
            status: Some(status),
            retry_after_ms,
        };
        if status == 401 || status == 403 {
            return fail("Token rejected: run any claude command to refresh it", None);
        }
        if status == 429 {
            let ra = r.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_string);
            return fail(RATE_LIMITED, parse_retry_after(ra.as_deref(), now()));
        }
        if !(200..300).contains(&status) {
            return fail(&format!("Anthropic answered HTTP {status}"), None);
        }
        let body = match r.bytes().await {
            Ok(b) => serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        match normalize_usage(&body) {
            Some(windows) => UsageResult::Answer { windows, fetched_at: fetched_at() },
            None => fail("Unexpected answer from the usage endpoint", None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_seconds_and_dates() {
        assert_eq!(parse_retry_after(Some("120"), 0.0), Some(120_000.0));
        assert_eq!(parse_retry_after(Some(" 1.5 "), 0.0), Some(1500.0));
        assert_eq!(parse_retry_after(Some("0.0005"), 0.0), Some(1.0));
        assert_eq!(parse_retry_after(None, 0.0), None);
        assert_eq!(parse_retry_after(Some("soon"), 0.0), None);
        let at = parse_date("Sun, 15 Nov 2026 10:02:00 GMT").unwrap();
        assert_eq!(parse_retry_after(Some("Sun, 15 Nov 2026 10:02:00 GMT"), at - 120_000.0), Some(120_000.0));
        assert_eq!(parse_retry_after(Some("Sun, 15 Nov 2026 10:02:00 GMT"), at + 5.0), Some(0.0));
    }

    #[test]
    fn labels_for_unknown_windows() {
        assert_eq!(label("seven_day_haiku_x"), "Week · haiku x");
        assert_eq!(label("seven_daytime"), "Week · time");
        assert_eq!(label("five_hour_x"), "Week · five hour x");
    }
}
