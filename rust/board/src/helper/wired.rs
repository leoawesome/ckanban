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

/// Waits up to `secs` for Telegram to run (the helper starts before the server has made it).
async fn telegram_of(cell: &Arc<std::sync::OnceLock<Arc<crate::telegram::Telegram>>>, secs: u64) -> Option<Arc<crate::telegram::Telegram>> {
    let mut waited = 0;
    while cell.get().is_none() && waited < secs * 10 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        waited += 1;
    }
    cell.get().cloned()
}

/// P1c: the helper's `telegram` channel, sent by the Rust Telegram. A send while the server is still starting waits
/// for it, up to two minutes.
pub struct TelegramSender(pub Arc<std::sync::OnceLock<Arc<crate::telegram::Telegram>>>);

impl Sender for TelegramSender {
    fn send(&self, out: Value, _targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let cell = self.0.clone();
        Box::pin(async move {
            let t = telegram_of(&cell, 120).await.ok_or_else(|| "Telegram isn't ready yet".to_string())?;
            let m = out.as_object().cloned().unwrap_or_default();
            Ok(vec![t.send(&m).await])
        })
    }
    /// Not asked: the board's own channels know the devices (`Channels::facts`).
    fn facts(&self) -> BoxFuture<'static, Facts> {
        Box::pin(async { Facts::default() })
    }
}

/// P1c: Telegram's part of Settings, from the Rust Telegram (`telegram-state`, `telegram-pair`, `telegram-unpair`,
/// `notify-changed`). `telegram-state` waits at most 2 s for it (Settings then shows Telegram from the file), the
/// others up to 15 s.
pub struct RustTelegram(pub Arc<std::sync::OnceLock<Arc<crate::telegram::Telegram>>>);

impl super::notify::TelegramSide for RustTelegram {
    fn call(&self, name: &str, body: Value) -> BoxFuture<'static, Result<(u16, Value), String>> {
        let (cell, name) = (self.0.clone(), name.to_string());
        Box::pin(async move {
            let t = telegram_of(&cell, if name == "telegram-state" { 2 } else { 15 }).await.ok_or_else(|| "Telegram is still starting; try again in a moment".to_string())?;
            Ok(match name.as_str() {
                "telegram-state" => (200, json!({ "telegram": t.public() })),
                "telegram-pair" => match t.pair(body.get("board").and_then(Value::as_str)) {
                    Ok((code, expires)) => (200, json!({ "code": code, "expiresAt": expires })),
                    Err((status, e)) => (status, json!({ "error": e })),
                },
                "telegram-unpair" => match t.unpair() {
                    Ok(()) => (200, json!({ "ok": true })),
                    Err(e) => (503, json!({ "error": e })),
                },
                "notify-changed" => {
                    t.changed(body.get("tokenChanged") == Some(&Value::Bool(true)), body.get("stoppedTaking") == Some(&Value::Bool(true)));
                    (200, json!({ "ok": true }))
                }
                other => (404, json!({ "error": format!("unknown Telegram call {other}") })),
            })
        })
    }
}
