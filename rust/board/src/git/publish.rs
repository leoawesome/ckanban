//! The Share menu's "Publish" (P2): `startPublish` of `src/api/context.ts` in the Rust board. An output file is
//! published as a claude.ai page in the background (the helper takes a minute or two); its job shows on the ticket
//! (`shareJobs`, in memory only) until it is done, then the link is saved in the ticket's `shareLinks`. Publishing the
//! same file again updates its link. The publishing itself (Markdown made into a page, the interactive Claude that has
//! the Artifact tool) is the `run` hook: the server runs `ckanban artifact publish-output` for it until P3 ports that
//! command.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::tickets::writer::Tickets;

/// The publishing step: `{file, name, url?}` (the output's path, its name, the link to update) gives Bun's
/// `ArtifactOutcome` (`{ok: true, kind: "publish", url, text}` or `{ok: false, error}`).
pub type PublishRun = Arc<dyn Fn(Value) -> BoxFuture<'static, Value> + Send + Sync>;

pub struct Publisher {
    tickets: Arc<Tickets>,
    run: PublishRun,
    /// Per ticket (`<slug>/<id>`), each file's job in the order first published (a JS Map's order).
    jobs: Mutex<HashMap<String, Vec<(String, Value)>>>,
}

fn now() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

impl Publisher {
    pub fn new(tickets: Arc<Tickets>, run: PublishRun) -> Arc<Self> {
        Arc::new(Publisher { tickets, run, jobs: Mutex::new(HashMap::new()) })
    }

    /// The ticket's publishing jobs now (`shareJobs`).
    pub fn jobs(&self, slug: &str, id: &str) -> Vec<Value> {
        self.jobs.lock().get(&format!("{slug}/{id}")).map(|v| v.iter().map(|(_, j)| j.clone()).collect()).unwrap_or_default()
    }

    fn set(&self, key: &str, name: &str, job: Option<Value>) {
        let mut all = self.jobs.lock();
        let list = all.entry(key.to_string()).or_default();
        match (list.iter().position(|(n, _)| n == name), job) {
            (Some(i), Some(j)) => list[i].1 = j,
            (None, Some(j)) => list.push((name.to_string(), j)),
            (Some(i), None) => {
                list.remove(i);
            }
            (None, None) => {}
        }
    }

    fn emit_ticket(&self, slug: &str, id: &str) {
        if let Some(t) = self.tickets.get(slug, id) {
            self.tickets.emit(slug, &t);
        }
    }

    /// Starts publishing `file` (the output `name` of the ticket): the job as the route answers it (202), or 409 when
    /// that file is already being published.
    pub fn start(self: &Arc<Self>, slug: &str, id: &str, name: &str, file: PathBuf) -> Result<Value, (u16, String)> {
        let key = format!("{slug}/{id}");
        {
            let mut all = self.jobs.lock();
            let list = all.entry(key.clone()).or_default();
            if list.iter().any(|(n, j)| n == name && j.get("state").and_then(Value::as_str) == Some("publishing")) {
                return Err((409, "this file is already being published".into()));
            }
        }
        let job = json!({ "file": name, "state": "publishing", "at": now() });
        self.set(&key, name, Some(job.clone()));
        self.emit_ticket(slug, id);
        let (me, slug, id, name) = (self.clone(), slug.to_string(), id.to_string(), name.to_string());
        tokio::spawn(async move {
            if let Err(e) = me.publish(&key, &slug, &id, &name, file).await {
                me.set(&key, &name, Some(json!({ "file": name, "state": "failed", "error": e, "at": now() })));
                me.emit_ticket(&slug, &id);
            }
        });
        Ok(job)
    }

    async fn publish(&self, key: &str, slug: &str, id: &str, name: &str, file: PathBuf) -> Result<(), String> {
        static MD: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"(?i)\.(md|markdown)$").unwrap());
        static HTML: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"(?i)\.html?$").unwrap());
        let existing = self.tickets.get(slug, id).and_then(|t| link_of(t.json.get("shareLinks"), name));
        if !MD.is_match(name) && !HTML.is_match(name) {
            return Err("only Markdown and HTML files can be published".into());
        }
        let mut ask = json!({ "file": file.to_string_lossy(), "name": name });
        if let Some(u) = existing {
            ask["url"] = Value::String(u);
        }
        let r = (self.run)(ask).await;
        if r.get("ok") != Some(&Value::Bool(true)) {
            return Err(r.get("error").and_then(Value::as_str).unwrap_or("publishing failed").to_string());
        }
        if r.get("kind").and_then(Value::as_str) != Some("publish") {
            return Err("unexpected helper result".into());
        }
        let url = r.get("url").and_then(Value::as_str).unwrap_or("").to_string();
        // The ticket was deleted meanwhile: nothing to save (its job stays, as in Bun).
        let Some(t) = self.tickets.get(slug, id) else { return Ok(()) };
        let mut links: Vec<Value> = t.json.get("shareLinks").and_then(Value::as_array).cloned().unwrap_or_default();
        links.retain(|l| l.get("file").and_then(Value::as_str) != Some(name));
        links.push(json!({ "file": name, "url": url, "at": now() }));
        self.set(key, name, None);
        let mut patch = Map::new();
        patch.insert("shareLinks".into(), Value::Array(links));
        self.tickets.update_quiet(slug, id, patch).map_err(|e| e.1)?;
        self.emit_ticket(slug, id);
        Ok(())
    }
}

/// The link saved for `name` in a ticket's `shareLinks`.
fn link_of(links: Option<&Value>, name: &str) -> Option<String> {
    links?.as_array()?.iter().find(|l| l.get("file").and_then(Value::as_str) == Some(name))?.get("url")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_files_link() {
        let links = json!([{ "file": "a.md", "url": "u1" }, { "file": "b.html", "url": "u2" }]);
        assert_eq!(link_of(Some(&links), "b.html").as_deref(), Some("u2"));
        assert_eq!(link_of(Some(&links), "c.html"), None);
        assert_eq!(link_of(None, "a.md"), None);
    }
}
