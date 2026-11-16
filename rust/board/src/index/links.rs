//! A ticket's links (`src/board/links.ts`): claude.ai artifacts from its session, its huddle teammates' sessions and
//! its result summaries, plus the share links of its output files; and the comment reads they need
//! (`aiComments`, `lastAiComment` in `src/core/store.ts`), kept by `comments.jsonl`'s mtime and size.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value};

use super::text::js_trim;

/// Most comment files kept parsed (a board's open tickets plus the Done pages a user opens).
const COMMENTS_MAX: usize = 5000;

/// Claude's comments of one ticket, oldest first: (text, at).
pub type AiComments = Arc<Vec<(String, String)>>;

#[derive(Default)]
pub struct Comments {
    cache: Mutex<HashMap<PathBuf, ((Option<SystemTime>, u64), AiComments)>>,
}

impl Comments {
    /// The ticket's Claude comments (`aiComments`); read again only when the file changed.
    pub fn ai(&self, ticket_dir: &Path) -> AiComments {
        let file = ticket_dir.join("comments.jsonl");
        let Ok(m) = std::fs::metadata(&file) else {
            self.cache.lock().remove(&file);
            return Arc::new(Vec::new());
        };
        let st = (m.modified().ok(), m.len());
        if let Some((s, v)) = self.cache.lock().get(&file) {
            if *s == st {
                return v.clone();
            }
        }
        let text = std::fs::read(&file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let mut out = Vec::new();
        for line in text.split('\n') {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(c) = serde_json::from_str::<Value>(line) else { continue };
            if c.get("author").and_then(Value::as_str) != Some("ai") {
                continue;
            }
            let s = |k: &str| match c.get(k) {
                Some(Value::String(x)) => x.clone(),
                None | Some(Value::Null) => String::new(),
                Some(x) => x.to_string(),
            };
            out.push((s("text"), s("at")));
        }
        let v = Arc::new(out);
        let mut cache = self.cache.lock();
        if cache.len() >= COMMENTS_MAX {
            cache.clear();
        }
        cache.insert(file, (st, v.clone()));
        v
    }

    /// Text of the ticket's last Claude comment (`lastAiComment`).
    pub fn last_ai(&self, ticket_dir: &Path) -> Option<String> {
        self.ai(ticket_dir).last().map(|(t, _)| t.clone())
    }
}

fn artifact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:\[([^\]\n]{1,200})\]\()?(https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9-]+)").expect("valid regex"))
}

/// `artifactUrlsIn`: claude.ai artifact URLs in a text, with their Markdown link text when there is one.
pub fn artifact_urls_in(text: &str) -> Vec<(String, Option<String>)> {
    artifact_re()
        .captures_iter(text)
        .map(|c| {
            let label = c.get(1).map(|m| js_trim(m.as_str()).to_string()).filter(|s| !s.is_empty());
            (c[2].to_string(), label)
        })
        .collect()
}

const DEFAULT_LABEL: &str = "claude.ai artifact";

fn rank(source: &str) -> u8 {
    match source {
        "result" => 0,
        "share" => 1,
        _ => 2,
    }
}

fn s(v: &Map<String, Value>, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        None | Some(Value::Null) => String::new(),
        Some(x) => x.to_string(),
    }
}

/// `collectLinks`. session: the ticket's session artifacts; huddles: (handle, artifacts) of its teammates.
pub fn collect_links(session: Option<&Value>, huddles: &[(String, Vec<Value>)], results: &[(String, String)], share_links: Option<&Value>) -> Value {
    let mut found: Vec<Map<String, Value>> = Vec::new();
    let with_source = |a: &Value, source: &str| {
        let mut m = a.as_object().cloned().unwrap_or_default();
        m.insert("source".into(), source.into());
        m
    };
    if let Some(Value::Array(a)) = session {
        found.extend(a.iter().map(|x| with_source(x, "ticket")));
    }
    for (handle, arts) in huddles {
        found.extend(arts.iter().map(|x| with_source(x, &format!("huddle:@{handle}"))));
    }
    for (text, at) in results {
        for (url, label) in artifact_urls_in(text) {
            let mut m = Map::new();
            m.insert("url".into(), url.into());
            m.insert("label".into(), label.unwrap_or_else(|| DEFAULT_LABEL.into()).into());
            m.insert("at".into(), at.clone().into());
            m.insert("source".into(), "result".into());
            found.push(m);
        }
    }
    if let Some(Value::Array(a)) = share_links {
        for l in a {
            let Some(o) = l.as_object() else { continue };
            let file = s(o, "file");
            let mut m = Map::new();
            m.insert("url".into(), o.get("url").cloned().unwrap_or(Value::Null));
            m.insert("label".into(), file.rsplit('/').next().unwrap_or("").to_string().into());
            m.insert("at".into(), o.get("at").cloned().unwrap_or(Value::Null));
            m.insert("source".into(), "share".into());
            found.push(m);
        }
    }
    let mut order: Vec<String> = Vec::new();
    let mut by_url: HashMap<String, Map<String, Value>> = HashMap::new();
    for l in found {
        let url = s(&l, "url");
        if !url.starts_with("https://") {
            continue;
        }
        let Some(had) = by_url.get(&url) else {
            order.push(url.clone());
            by_url.insert(url, l);
            continue;
        };
        let (rl, rh) = (rank(&s(&l, "source")), rank(&s(had, "source")));
        if rl > rh {
            by_url.insert(url, l);
            continue;
        }
        if rl < rh {
            continue;
        }
        let label = if s(had, "label") == DEFAULT_LABEL && s(&l, "label") != DEFAULT_LABEL { l.get("label").cloned() } else { had.get("label").cloned() };
        let at = if s(&l, "at") > s(had, "at") { l.get("at").cloned() } else { had.get("at").cloned() };
        let mut next = had.clone();
        next.insert("label".into(), label.unwrap_or(Value::Null));
        next.insert("at".into(), at.unwrap_or(Value::Null));
        by_url.insert(url, next);
    }
    let mut out: Vec<Map<String, Value>> = order.into_iter().filter_map(|u| by_url.remove(&u)).collect();
    out.sort_by(|a, b| s(b, "at").cmp(&s(a, "at")));
    Value::Array(out.into_iter().map(Value::Object).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn links_like_bun() {
        let results = vec![
            ("See [The page](https://claude.ai/artifact/abc-1) and https://claude.ai/code/artifact/x2".to_string(), "2026-01-02".to_string()),
        ];
        let shares = json!([{ "file": "out/report.html", "url": "https://claude.ai/artifact/abc-1", "at": "2026-01-01" }]);
        let v = collect_links(None, &[], &results, Some(&shares));
        assert_eq!(
            v,
            json!([
                { "url": "https://claude.ai/code/artifact/x2", "label": "claude.ai artifact", "at": "2026-01-02", "source": "result" },
                { "url": "https://claude.ai/artifact/abc-1", "label": "report.html", "at": "2026-01-01", "source": "share" },
            ])
        );
    }
}
