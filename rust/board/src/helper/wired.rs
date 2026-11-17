//! The helper plugged into the Rust board (`rust/src/board_mode.rs` makes these): tickets and boards from the index
//! and the ticket writes, live state through `Live`, links on the phone address when phone access is on, and the
//! satellite for Telegram until P1c (`helper-send` with only "telegram", and the bot's state and pairing).

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
        // `listProfiles()`: by createdAt (localeCompare; ISO times compare the same as text).
        let dd = ckanban_core::DataDir::new(self.root.clone());
        let mut list: Vec<(String, String, String)> = self
            .reads
            .index
            .board_slugs()
            .into_iter()
            .filter_map(|s| {
                let p = dd.profile(&s)?;
                let created = p.record.0.get("createdAt").and_then(Value::as_str).unwrap_or("").to_string();
                Some((created, s.clone(), self.board_name(&s)))
            })
            .collect();
        list.sort_by(|a, b| crate::runs::js::locale_compare(&a.0, &b.0));
        list.into_iter().map(|(_, s, n)| (s, n)).collect()
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

/// Telegram through the satellite (until P1c). `ready` turns true once the satellite runs: a send before that (the
/// helper starts before the satellite does) waits for it, up to two minutes.
pub struct SatelliteSender(pub Arc<SatelliteClient>, pub tokio::sync::watch::Receiver<bool>);

async fn wait_ready(mut ready: tokio::sync::watch::Receiver<bool>, secs: u64) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(secs), ready.wait_for(|r| *r)).await;
}

impl Sender for SatelliteSender {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let (c, ready) = (self.0.clone(), self.1.clone());
        Box::pin(async move {
            wait_ready(ready, 120).await;
            let (status, v) = c.call("helper-send", &json!({ "message": out, "only": targets })).await?;
            if !(200..300).contains(&status) {
                return Err(v.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("the satellite answered {status}")));
            }
            Ok(v.get("results").and_then(Value::as_array).cloned().unwrap_or_default())
        })
    }
    /// Not asked: the board's own channels know the devices (`Channels::facts`).
    fn facts(&self) -> BoxFuture<'static, Facts> {
        Box::pin(async { Facts::default() })
    }
}

/// The satellite's Telegram bot for Settings (`telegram-state`, `telegram-pair`, `telegram-unpair`,
/// `notify-changed`). `telegram-state` waits at most 2 s for the satellite to run (Settings then shows Telegram from
/// the file), the others up to 15 s.
pub struct SatelliteTelegram(pub Arc<SatelliteClient>, pub tokio::sync::watch::Receiver<bool>);

impl super::notify::TelegramSide for SatelliteTelegram {
    fn call(&self, name: &str, body: Value) -> BoxFuture<'static, Result<(u16, Value), String>> {
        let (c, ready, name) = (self.0.clone(), self.1.clone(), name.to_string());
        Box::pin(async move {
            wait_ready(ready, if name == "telegram-state" { 2 } else { 15 }).await;
            c.call(&name, &body).await
        })
    }
}
