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

/// Board mode's start jobs of R6, in the background like Bun's `startup: sweepWorktrees` and
/// `startup: detectMissing`: the worktree sweep (report-only, `dryrun.rs`) and setup detection for boards that never
/// had it (saves `profile.json`, sends `profile.updated`).
pub fn start_jobs(core: &Arc<Core>) {
    let (root, runs) = (core.root.clone(), core.services.runs.clone());
    tokio::spawn(async move {
        let git = landing::Git::new(&root, fileops::FileOps::new(&root, runs));
        git.sweep_worktrees().await;
    });
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
