//! read_artifact and publish_artifact (src/mcp/artifact-tools.ts): claude.ai artifact pages through the artifact
//! helper (crate::artifact), the board's stand-in for the Artifact tool headless runs don't get.

use std::path::PathBuf;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;

use super::client::{R, err};
use super::{Ctx, opt_str, req_str};
use crate::artifact::{self, Job, Options, Outcome};

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "read_artifact" => read_artifact(a, cx).await,
        "publish_artifact" => publish_artifact(a, cx).await,
        _ => return None,
    })
}

/// artifactWaitMs: 3 minutes, or less when MCP_TOOL_TIMEOUT would cut the call off sooner.
fn wait_ms(limit: Option<&str>) -> u64 {
    const WAIT: f64 = 180_000.0;
    // Number(): blank is 0, junk is NaN.
    let limit = match limit.map(str::trim) {
        None => f64::NAN,
        Some("") => 0.0,
        Some(s) => s.parse::<f64>().unwrap_or(f64::NAN),
    };
    if !limit.is_finite() || limit < 1000.0 {
        return WAIT as u64;
    }
    1000f64.max(WAIT.min(limit - 5_000.0)) as u64
}

/// artifactFileName: the artifact id when updating (so updates overwrite it), else the title.
fn file_name(url: Option<&str>, title: Option<&str>, now: u128) -> String {
    static ID: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"/artifact/([A-Za-z0-9-]+)").unwrap());
    static NON: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());
    let id = url.and_then(|u| ID.captures(u)).map(|c| c[1].to_string());
    let base = id.or_else(|| title.map(str::to_string)).unwrap_or_default().to_lowercase();
    let slug = NON.replace_all(&base, "-");
    let slug: String = slug.trim_matches('-').chars().take(60).collect();
    if slug.is_empty() { format!("artifact-{now}.html") } else { format!("{slug}.html") }
}

async fn run_job(job: Job, cx: &Ctx) -> Outcome {
    let o = Options {
        bin: cx.env.get("CKANBAN_CLAUDE_BIN").map(str::to_string),
        model: cx.env.get("CKANBAN_ARTIFACT_MODEL").map(str::to_string),
        timeout: Duration::from_millis(wait_ms(cx.env.get("MCP_TOOL_TIMEOUT"))),
        ..Options::default()
    };
    tokio::task::spawn_blocking(move || artifact::run_job(&job, &o)).await.unwrap_or_else(|e| Outcome::Failed(e.to_string()))
}

async fn read_artifact(a: &Value, cx: &Ctx) -> R<String> {
    let url = req_str(a, "url")?.trim().to_string();
    match run_job(Job::Read { url }, cx).await {
        Outcome::Read { html } => Ok(html),
        Outcome::Failed(e) => err(format!("artifact read failed: {e}")),
        Outcome::Published { .. } => err("artifact read failed: no page source"),
    }
}

async fn publish_artifact(a: &Value, cx: &Ctx) -> R<String> {
    let html = req_str(a, "html")?.to_string();
    let url = opt_str(a, "url").map(|u| u.trim().to_string());
    let title = opt_str(a, "title").map(|t| t.trim().to_string());
    let base = cx.env.get("CKANBAN_OUTPUT_DIR").map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("ckanban-artifacts"));
    let dir = base.join("artifacts");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let file = dir.join(file_name(url.as_deref(), title.as_deref(), now));
    std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&file, html)).or_else(|e| err(e.to_string()))?;
    let job = Job::Publish { file: file.to_string_lossy().into_owned(), url, title };
    match run_job(job, cx).await {
        // Same wording as the Artifact tool, so the board lists the page on the ticket.
        Outcome::Published { text, .. } => Ok(text),
        Outcome::Failed(e) => err(format!("artifact publish failed: {e}")),
        Outcome::Read { .. } => err("artifact publish failed: no link came back"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_and_names() {
        assert_eq!(wait_ms(None), 180_000);
        assert_eq!(wait_ms(Some("6000")), 1000);
        assert_eq!(wait_ms(Some("60000")), 55_000);
        assert_eq!(wait_ms(Some("999999")), 180_000);
        assert_eq!(wait_ms(Some("x")), 180_000);
        assert_eq!(file_name(Some("https://claude.ai/artifact/AbC-12"), Some("T"), 1), "abc-12.html");
        assert_eq!(file_name(None, Some("Contract Page!"), 1), "contract-page.html");
        assert_eq!(file_name(None, None, 7), "artifact-7.html");
    }
}
