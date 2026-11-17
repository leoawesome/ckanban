//! The helper plugged into the Rust board (`rust/src/board_mode.rs` makes these): tickets and boards from the index
//! and the ticket writes, live state through `Live`, links on the phone address when phone access is on, and the
//! satellite for sending (`helper-send`) and what only it knows (`helper-facts`).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::board::{Facts, HelperBoard};
use super::channels::Sender;
use crate::gate::edge::SatelliteClient;
use crate::gate::remote::RemoteFile;
use crate::index::routes::Reads;
use crate::index::store::BoardList;
use crate::index::ticket::Tk;
use crate::tickets::writer::Tickets;

pub struct BoardSide {
    pub tickets: Arc<Tickets>,
    pub reads: Arc<Reads>,
    /// Summaries read now when the session watcher hasn't reached a session yet (the start-up stock-take).
    pub sessions: Arc<dyn crate::api::SessionInfo>,
    pub root: PathBuf,
    pub port: u16,
    pub remote: RemoteFile,
}

impl HelperBoard for BoardSide {
    fn ticket(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        self.tickets.get(slug, id)
    }
    fn list(&self, slug: &str) -> Arc<BoardList> {
        self.tickets.list(slug)
    }
    fn profiles(&self) -> Vec<(String, String)> {
        let mut slugs = self.reads.index.board_slugs();
        slugs.sort();
        slugs.into_iter().filter(|s| self.has_profile(s)).map(|s| (s.clone(), self.board_name(&s))).collect()
    }
    fn has_profile(&self, slug: &str) -> bool {
        ckanban_core::DataDir::new(self.root.clone()).profile(slug).is_some()
    }
    fn board_name(&self, slug: &str) -> String {
        match ckanban_core::DataDir::new(self.root.clone()).profile(slug).and_then(|p| p.record.0.get("name").cloned()) {
            Some(Value::String(s)) => s,
            Some(Value::Null) | None => slug.to_string(),
            Some(v) => v.to_string(),
        }
    }
    fn session(&self, session_id: &str) -> Option<Value> {
        self.reads.live.session(session_id).or_else(|| self.sessions.summary_now(session_id))
    }
    fn running(&self, slug: &str, id: &str) -> bool {
        self.reads.live.running(slug, id)
    }
    fn host(&self, slug: &str, id: &str) -> Option<Value> {
        self.reads.live.host(slug, id)
    }
    fn schedule_ids(&self, slug: &str) -> HashSet<String> {
        crate::index::view::schedule_ids(&self.root, slug)
    }
    fn has_checkin(&self, slug: &str) -> bool {
        let dir = self.root.join("profiles").join(slug).join("schedules");
        let Ok(d) = std::fs::read_dir(dir) else { return false };
        d.flatten().filter(|e| e.file_name().to_str().is_some_and(ckanban_core::json_dir::id_json)).any(|e| {
            ckanban_core::datafile::read_json(&e.path()).ok().flatten().is_some_and(|v| crate::runs::js::truthy(v.get("quiet")))
        })
    }
    fn add_comment(&self, slug: &str, id: &str, text: &str) {
        if let Err((_, e)) = self.tickets.store_comment(slug, id, "ai", text, None) {
            eprintln!("helper: can't comment on {slug}/{id}: {e}");
        }
    }
    fn base_url(&self) -> String {
        match self.remote.active() {
            Some(r) => crate::gate::request::remote_url(&r.host),
            None => format!("http://localhost:{}", self.port),
        }
    }
}

/// Sending through the satellite (until P1b/P1c).
pub struct SatelliteSender(pub Arc<SatelliteClient>);

impl Sender for SatelliteSender {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let c = self.0.clone();
        Box::pin(async move {
            let (status, v) = c.call("helper-send", &json!({ "message": out, "only": targets })).await?;
            if !(200..300).contains(&status) {
                return Err(v.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("the satellite answered {status}")));
            }
            Ok(v.get("results").and_then(Value::as_array).cloned().unwrap_or_default())
        })
    }
    fn facts(&self) -> BoxFuture<'static, Facts> {
        let c = self.0.clone();
        Box::pin(async move {
            match c.call("helper-facts", &json!({})).await {
                Ok((200, v)) => Facts {
                    on_screen: v.get("onScreen").and_then(Value::as_bool).unwrap_or(false),
                    phone_devices: v.get("phoneDevices").and_then(Value::as_u64).unwrap_or(0),
                    connected: v.get("connected").and_then(Value::as_bool).unwrap_or(false),
                },
                _ => Facts::default(),
            }
        })
    }
}
