//! R6: git, copies of the folder and landing. Ports of `src/runs/git.ts` (`cmd`, `repo`), `worktree-setup.ts`
//! (`setup`), `diff.ts` (`diff`), `prstatus.ts`, `prpoller.ts` and `board/prs.ts` (`pr`), `board/share.ts` (`share`),
//! `core/files.ts` and the outputs listing of `core/store.ts` (`files`), and the git half of `board-repo.ts` and
//! `board-main.ts` (`landing`: ticket copies, merge into main, land, branch, the worktree sweep). `routes` answers the
//! read routes board mode can serve from files alone.

pub mod cmd;
pub mod repo;
pub mod diff;
pub mod ops;
pub mod pr;
pub mod setup;
pub mod files;
pub mod share;
pub mod landing;
pub mod routes;
pub mod fileops;

use std::sync::Arc;

use serde_json::{Value, json};

use crate::bus::BusEvent;
use crate::core::Core;

/// Board mode's start job of R6, in the background like Bun's `startup: detectMissing`: setup detection for boards
/// that never had it (saves `profile.json`, sends `profile.updated`). The worktree sweep is `sweep_after_recover`.
pub fn start_jobs(core: &Arc<Core>) {
    let (root, bus) = (core.root.clone(), core.bus.clone());
    tokio::spawn(async move {
        let data = ckanban_core::home::DataDir::new(root);
        let profiles: Vec<Value> = data.list_profiles().unwrap_or_default().into_iter().map(|p| Value::Object(p.record.0)).collect();
        setup::detect_missing(
            profiles,
            |slug| data.profile(slug).map(|p| Value::Object(p.record.0)),
            |p| {
                let Some(map) = p.as_object().cloned() else { return };
                let slug = map.get("slug").and_then(Value::as_str).unwrap_or("").to_string();
                let profile = ckanban_core::home::Profile { record: ckanban_core::record::JsonRecord(map) };
                match profile.save(&data) {
                    Ok(()) => bus.emit(BusEvent::new(json!({ "type": "profile.updated", "slug": slug, "profile": p }))),
                    Err(e) => eprintln!("profile {slug}: worktree setup detection failed: {e}"),
                }
            },
        )
        .await;
    });
}

/// Bun's `startup: sweepWorktrees`, on the board's own `Git` (its ticket writes clear a swept ticket's `worktree`,
/// and a copy being set up right now is seen): started once the board index is loaded and `recover()` ran, so every
/// ticket is known when its copy is looked at. Report-only until deletes are on (`dryrun.rs`).
pub fn sweep_after_recover(git: Arc<landing::Git>) {
    tokio::spawn(async move {
        git.sweep_worktrees().await;
    });
}
