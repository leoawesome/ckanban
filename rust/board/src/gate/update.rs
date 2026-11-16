//! The update check of `src/core/update.ts` for `GET /api/version`: the latest GitHub release of ckanban, asked at
//! most every 6 hours, compared with this build's version ("dev" from source is never outdated).
//! `CKANBAN_RELEASES_URL` (tests only) points it at a local stand-in for GitHub's API.

use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::Mutex as AsyncMutex;

use crate::runs::js;

/// `VERSION` in `src/core/version.ts`: set when a release is built, "dev" from source.
pub const VERSION: &str = match option_env!("CKANBAN_VERSION") {
    Some(v) => v,
    None => "dev",
};
/// `REPO`.
pub const REPO: &str = "leoawesome/ckanban";
const TTL_MS: f64 = 6.0 * 3600_000.0;
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq)]
pub struct Release {
    pub version: String,
    pub url: String,
}

/// `isNewer`: dotted versions compared part by part as numbers (a part that isn't a number never decides).
pub fn is_newer(latest: &str, current: &str) -> bool {
    if current == "dev" || latest.is_empty() {
        return false;
    }
    let a: Vec<f64> = latest.split('.').map(js::number_of_str).collect();
    let b: Vec<f64> = current.split('.').map(js::number_of_str).collect();
    for i in 0..a.len().max(b.len()) {
        let d = a.get(i).copied().unwrap_or(0.0) - b.get(i).copied().unwrap_or(0.0);
        if d != 0.0 && !d.is_nan() {
            return d > 0.0;
        }
    }
    false
}

/// `String(v ?? "")` for the release fields.
fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_string(v),
    }
}

/// The release from GitHub's answer.
pub fn release_of(j: &Value) -> Release {
    let tag = text(j.get("tag_name"));
    Release { version: tag.strip_prefix('v').unwrap_or(&tag).to_string(), url: text(j.get("html_url")) }
}

fn releases_url() -> String {
    std::env::var("CKANBAN_RELEASES_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{REPO}/releases/latest"))
}

/// `latestRelease`: None when offline, rate-limited or the answer isn't JSON.
async fn latest_release(http: &reqwest::Client) -> Option<Release> {
    let r = http
        .get(releases_url())
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "ckanban")
        .timeout(TIMEOUT)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let body = r.text().await.ok()?;
    js::parse(&body).map(|j| release_of(&j))
}

/// `UpdateChecker`: one per daemon.
pub struct UpdateChecker {
    http: reqwest::Client,
    cached: Mutex<Option<(f64, Option<Release>)>>,
    /// One check at a time; callers meanwhile wait for its answer.
    asking: AsyncMutex<()>,
}

impl Default for UpdateChecker {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateChecker {
    pub fn new() -> Self {
        UpdateChecker { http: reqwest::Client::builder().build().expect("http client"), cached: Mutex::new(None), asking: AsyncMutex::new(()) }
    }

    fn fresh(&self) -> Option<Option<Release>> {
        let now = ckanban_core::time::now_ms();
        self.cached.lock().as_ref().filter(|(at, _)| now - at <= TTL_MS).map(|(_, r)| r.clone())
    }

    /// `status()`: `{version, latest, updateAvailable, url}`.
    pub async fn status(&self) -> Value {
        let latest = match self.fresh() {
            Some(r) => r,
            None => {
                let _one = self.asking.lock().await;
                match self.fresh() {
                    Some(r) => r,
                    None => {
                        let r = latest_release(&self.http).await;
                        *self.cached.lock() = Some((ckanban_core::time::now_ms(), r.clone()));
                        r
                    }
                }
            }
        };
        json!({
            "version": VERSION,
            "latest": latest.as_ref().map(|r| r.version.clone()),
            "updateAvailable": latest.as_ref().is_some_and(|r| is_newer(&r.version, VERSION)),
            "url": latest.as_ref().map(|r| r.url.clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_like_bun() {
        assert!(is_newer("1.2.0", "1.1.9"));
        assert!(!is_newer("1.2.0", "1.2.0"));
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(is_newer("1.2.0.1", "1.2"));
        assert!(!is_newer("2.0.0", "dev"));
        assert!(!is_newer("", "1.0.0"));
        assert!(is_newer("1.3.0-beta", "1.2.0"));
        assert!(!is_newer("1.2.0-beta", "1.2.0"));
        assert_eq!(release_of(&json!({"tag_name": "v1.2.3", "html_url": "u"})), Release { version: "1.2.3".into(), url: "u".into() });
        assert_eq!(release_of(&json!({})), Release { version: String::new(), url: String::new() });
    }
}
