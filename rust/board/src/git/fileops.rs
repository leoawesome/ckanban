//! A read-only `BoardOps` over the data folder, for what board mode runs before the board's write API (R2a) and run
//! loop (R7a) exist: the report-only worktree sweep at start reads boards and tickets from their files. Every write
//! is refused with a reason (none is reached in report-only mode); R2a/R7a replace this with the board.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

use super::ops::BoardOps;
use crate::api::{Failure, RunControl};

const NO_WRITES: &str = "ticket changes need the Rust board's write API (R2a), not in board mode yet";

pub struct FileOps {
    root: PathBuf,
    runs: Arc<dyn RunControl>,
}

impl FileOps {
    pub fn new(root: &Path, runs: Arc<dyn RunControl>) -> Arc<FileOps> {
        Arc::new(FileOps { root: root.to_path_buf(), runs })
    }

    fn data(&self) -> ckanban_core::home::DataDir {
        ckanban_core::home::DataDir::new(self.root.clone())
    }
}

impl BoardOps for FileOps {
    fn profile(&self, slug: &str) -> Option<Value> {
        self.data().profile(slug).map(|p| Value::Object(p.record.0))
    }
    fn profiles(&self) -> Vec<Value> {
        self.data().list_profiles().unwrap_or_default().into_iter().map(|p| Value::Object(p.record.0)).collect()
    }
    fn save_profile(&self, _: Value) {
        eprintln!("[board] {NO_WRITES}: profile not saved");
    }
    fn ticket(&self, slug: &str, id: &str) -> Option<Value> {
        match ckanban_core::ticket::read(&self.data().ticket_dir(slug, id).join("ticket.md")) {
            Ok(Some(Ok(t))) => Some(t.to_json()),
            // A corrupt ticket file still names a ticket: never treated as gone (the sweep keeps its copy).
            Ok(Some(Err(_))) => Some(serde_json::json!({ "id": id, "status": "corrupt" })),
            _ => None,
        }
    }
    fn tickets(&self, _: &str) -> Vec<Value> {
        // Listing every ticket file is the board index's job (R1); nothing here needs it yet.
        Vec::new()
    }
    fn patch(&self, _: &str, _: &str, _: Map<String, Value>) -> Result<Value, Failure> {
        Err(NO_WRITES.into())
    }
    fn move_to(&self, _: &str, _: &str, _: &str) -> BoxFuture<'_, Result<(), Failure>> {
        Box::pin(async { Err(NO_WRITES.to_string()) })
    }
    fn comments(&self, _: &str, _: &str) -> Vec<Value> {
        Vec::new()
    }
    fn add_comment(&self, slug: &str, id: &str, _: &str, _: &str) {
        eprintln!("[board] {NO_WRITES}: comment on {slug}/{id} not saved");
    }
    fn push_event(&self, _: &str, _: &str, _: &str) {}
    fn emit_ticket(&self, _: &str, _: &str) {}
    fn main_of(&self, _: &str, _: &str) -> Option<Value> {
        None
    }
    fn busy(&self, slug: &str, id: &str) -> bool {
        self.runs.is_running(slug, id)
    }
    fn is_running(&self, slug: &str, id: &str) -> bool {
        self.runs.is_running(slug, id)
    }
    fn holds_review(&self, _: &str, _: &str) -> bool {
        true
    }
    fn chat(&self, _: &str, _: &str, _: &str) -> BoxFuture<'_, Result<Value, Failure>> {
        Box::pin(async { Err(NO_WRITES.to_string()) })
    }
    fn session_exists(&self, _: &str) -> bool {
        false
    }
    fn record_milestone(&self, _: &str, _: &str, _: &str, _: &str) -> Result<(), Failure> {
        Err(NO_WRITES.into())
    }
}
