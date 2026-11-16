//! A run's result line (`src/runs/result.ts`): the last `CKANBAN_RESULT: {...}` line of Claude's final text.

use serde_json::{Map, Value};

use super::js;

const PREFIX: &str = "CKANBAN_RESULT:";

#[derive(Debug, Clone, PartialEq)]
pub struct RunResult {
    /// "done", "blocked" or "questions".
    pub status: String,
    /// The last PR it reported (prUrl, else the last of prUrls).
    pub pr_url: Option<String>,
    /// Every PR it reported: prUrls plus prUrl.
    pub pr_urls: Vec<String>,
    pub summary: String,
    /// A quiet schedule's run says nothing needs the user.
    pub quiet: bool,
    /// A test ticket's result: "passed" or "problem".
    pub verdict: Option<String>,
}

impl RunResult {
    /// The object Bun's `parseResult` returns, in its key order.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("status".into(), Value::String(self.status.clone()));
        m.insert("prUrl".into(), self.pr_url.clone().map(Value::String).unwrap_or(Value::Null));
        m.insert("prUrls".into(), Value::Array(self.pr_urls.iter().cloned().map(Value::String).collect()));
        m.insert("summary".into(), Value::String(self.summary.clone()));
        if self.quiet {
            m.insert("quiet".into(), Value::Bool(true));
        }
        if let Some(v) = &self.verdict {
            m.insert("verdict".into(), Value::String(v.clone()));
        }
        Value::Object(m)
    }
}

fn is_url(v: &Value) -> Option<&str> {
    v.as_str().filter(|u| u.starts_with("https://"))
}

/// `parseResult`.
pub fn parse_result(text: &str) -> Option<RunResult> {
    let line = text.split('\n').rfind(|l| l.contains(PREFIX))?;
    let json = js::trim(js::trim(&line[line.find(PREFIX)? + PREFIX.len()..]).trim_end_matches('`'));
    let v = js::parse(json)?;
    let status = v.get("status").and_then(Value::as_str).filter(|s| matches!(*s, "done" | "blocked" | "questions"))?.to_string();
    let mut pr_urls: Vec<String> = Vec::new();
    let listed = v.get("prUrls").and_then(Value::as_array).map(|a| a.iter().filter_map(is_url).collect::<Vec<_>>()).unwrap_or_default();
    let own = v.get("prUrl").and_then(is_url);
    for u in listed.into_iter().chain(own) {
        if !pr_urls.iter().any(|x| x == u) {
            pr_urls.push(u.to_string());
        }
    }
    let verdict = v.get("verdict").and_then(Value::as_str).filter(|s| matches!(*s, "passed" | "problem")).map(str::to_string);
    Some(RunResult {
        pr_url: own.map(str::to_string).or_else(|| pr_urls.last().cloned()),
        pr_urls,
        summary: v.get("summary").and_then(Value::as_str).unwrap_or("").to_string(),
        quiet: v.get("quiet") == Some(&Value::Bool(true)) && status == "done",
        verdict,
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_line_wins() {
        let r = parse_result("x\nCKANBAN_RESULT: {\"status\":\"blocked\",\"prUrl\":null,\"summary\":\"a\"}\nCKANBAN_RESULT: {\"status\":\"done\",\"prUrl\":\"https://x/1\",\"summary\":\"b\"}```").unwrap();
        assert_eq!(r.status, "done");
        assert_eq!(r.pr_url.as_deref(), Some("https://x/1"));
        assert_eq!(r.summary, "b");
        assert!(parse_result("CKANBAN_RESULT: {\"status\":\"nope\"}").is_none());
    }
}
