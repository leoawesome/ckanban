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

/// Sending through the satellite (until P1b/P1c). `ready` turns true once the satellite runs: a send or a question
/// before that (the helper starts before the satellite does) waits for it, up to two minutes.
pub struct SatelliteSender(pub Arc<SatelliteClient>, pub tokio::sync::watch::Receiver<bool>);

async fn wait_ready(mut ready: tokio::sync::watch::Receiver<bool>) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(120), ready.wait_for(|r| *r)).await;
}

impl Sender for SatelliteSender {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let (c, ready) = (self.0.clone(), self.1.clone());
        Box::pin(async move {
            wait_ready(ready).await;
            let (status, v) = c.call("helper-send", &json!({ "message": out, "only": targets })).await?;
            if !(200..300).contains(&status) {
                return Err(v.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("the satellite answered {status}")));
            }
            Ok(v.get("results").and_then(Value::as_array).cloned().unwrap_or_default())
        })
    }
    fn facts(&self) -> BoxFuture<'static, Facts> {
        let (c, ready) = (self.0.clone(), self.1.clone());
        Box::pin(async move {
            wait_ready(ready).await;
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

/// P1c: Telegram is sent here, in Rust; every other channel through the satellite (until P1b). Results keep the
/// order of `targets`.
pub struct SplitSender {
    pub sat: SatelliteSender,
    pub telegram: Arc<std::sync::OnceLock<Arc<crate::telegram::Telegram>>>,
}

impl Sender for SplitSender {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let others: Vec<String> = targets.iter().filter(|t| *t != "telegram").cloned().collect();
        let wants_tg = others.len() != targets.len();
        let sat = if others.is_empty() { None } else { Some(self.sat.send(out.clone(), others.clone())) };
        let tg = self.telegram.get().cloned();
        Box::pin(async move {
            let tg_fut = async {
                if !wants_tg {
                    return None;
                }
                Some(match (tg, out.as_object()) {
                    (Some(t), Some(m)) => t.send(m).await,
                    _ => json!({ "channel": "telegram", "ok": false, "error": "telegram failed: Telegram isn't ready yet" }),
                })
            };
            let sat_fut = async {
                match sat {
                    Some(f) => f.await,
                    None => Ok(Vec::new()),
                }
            };
            let (tg_r, sat_r) = futures_util::join!(tg_fut, sat_fut);
            let sat_list = match sat_r {
                Ok(l) => l,
                Err(e) => others.iter().map(|c| json!({ "channel": c, "ok": false, "error": format!("{c} failed: {e}") })).collect(),
            };
            let mut used = vec![false; sat_list.len()];
            let mut tg_r = tg_r;
            let mut out = Vec::new();
            for t in &targets {
                if t == "telegram" {
                    if let Some(r) = tg_r.take() {
                        out.push(r);
                    }
                    continue;
                }
                if let Some(i) = (0..sat_list.len()).find(|i| !used[*i] && sat_list[*i].get("channel").and_then(Value::as_str) == Some(t.as_str())) {
                    used[i] = true;
                    out.push(sat_list[i].clone());
                }
            }
            Ok(out)
        })
    }
    fn facts(&self) -> BoxFuture<'static, Facts> {
        self.sat.facts()
    }
}
