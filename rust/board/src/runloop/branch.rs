//! Branch (`branchTicket`, `copyTicket` without a cut point, `src/board/board-tickets.ts`) and the PR box's routes
//! (`pr/refresh`, `pr/merge`, `pr/send-failures`, `pr/resolve-conflicts`, `check-pr` of `src/api/ticket-actions.ts`),
//! over R6's `landing::Git::branch_folder` and `git::pr`. Fork from a message (a cut point, R7b) goes through the same
//! `copy_ticket_before`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::{RunError, RunLoop, corrupt, now_iso, obj, ts, uuid};
use crate::index::ticket::Tk;
use crate::runs::js;

/// `rewriteSession` + `writeFork`: the transcript under a new id and folder (with attachment names swapped), and
/// its side folder (subagents, saved tool output) copied. Returns the new transcript file.
pub fn fork_session(src: &Path, from: &str, to: &str, from_cwd: &str, to_cwd: &str, rename: &[(String, String)]) -> Result<PathBuf, String> {
    let raw = std::fs::read_to_string(src).map_err(|e| e.to_string())?;
    fork_session_text(src, raw, from, to, from_cwd, to_cwd, rename)
}

/// `writeFork` of a given transcript text (`forkSessionBefore` passes the cut one).
pub fn fork_session_text(src: &Path, mut raw: String, from: &str, to: &str, from_cwd: &str, to_cwd: &str, rename: &[(String, String)]) -> Result<PathBuf, String> {
    let real = |p: &str| std::fs::canonicalize(p).map(|x| x.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_string());
    let (from_cwd, to_cwd) = (real(from_cwd), real(to_cwd));
    let dest = crate::sessions::files::projects_dir(None).join(crate::runs::claude::encode_project_dir(&to_cwd)).join(format!("{to}.jsonl"));
    if dest.exists() {
        return Err(format!("a Claude session {to} already exists"));
    }
    for (a, b) in rename {
        raw = raw.split(a.as_str()).collect::<Vec<_>>().join(b);
    }
    let out: Vec<String> = raw
        .split('\n')
        .map(|line| {
            if js::trim(line).is_empty() {
                return line.to_string();
            }
            let Some(mut ev) = js::parse(line) else { return line.to_string() };
            if !ev.is_object() {
                return line.to_string();
            }
            if ev.get("sessionId").and_then(Value::as_str) == Some(from) {
                ev["sessionId"] = Value::String(to.into());
            }
            if from_cwd != to_cwd
                && let Some(c) = ev.get("cwd").and_then(Value::as_str).map(str::to_string)
            {
                if c == from_cwd {
                    ev["cwd"] = Value::String(to_cwd.clone());
                } else if let Some(rest) = c.strip_prefix(&format!("{from_cwd}/")) {
                    ev["cwd"] = Value::String(format!("{to_cwd}/{rest}"));
                }
            }
            js::stringify(&ev)
        })
        .collect();
    if let Some(d) = dest.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    ckanban_core::atomic::atomic_write(&dest, out.join("\n")).map_err(|e| e.to_string())?;
    let side = src.parent().map(|p| p.join(from));
    if let (Some(side), Some(d)) = (side, dest.parent())
        && side.is_dir()
    {
        let _ = copy_dir(&side, &d.join(to));
    }
    Ok(dest)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)?.flatten() {
        let p = e.path();
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&p, &t)?;
        } else {
            std::fs::copy(&p, &t)?;
        }
    }
    Ok(())
}

impl RunLoop {
    /// `branchTicket`: a new "Branch: <title>" ticket in Planning with a copy of the conversation and its own branch
    /// off the source's. (ticket, warning).
    pub async fn branch_ticket(self: &Arc<Self>, slug: &str, id: &str) -> Result<(Arc<Tk>, Option<String>), RunError> {
        let src = self.get(slug, id);
        if src.is_some() && self.is_running(slug, id) {
            return Err(RunError::conflict("Claude is working on this ticket; branch it once Claude is done"));
        }
        let title = format!("Branch: {}", src.as_ref().map(|t| t.title.as_str()).unwrap_or(""));
        self.copy_ticket_before(slug, id, &title, None).await
    }

    /// `copyTicket`: Branch (no cut point) or Fork from here (`before`: the chat ends just before that message).
    pub async fn copy_ticket_before(self: &Arc<Self>, slug: &str, id: &str, title: &str, before: Option<&str>) -> Result<(Arc<Tk>, Option<String>), RunError> {
        let (profile, src) = (self.profile(slug), self.get(slug, id));
        let (Some(profile), Some(src)) = (profile, src) else { return Err(RunError::other(format!("ticket {id} not found"))) };
        if corrupt(&src) {
            return Err(RunError::other("ticket file is corrupt"));
        }
        let sid = ts(&src, "sessionId").map(str::to_string);
        let src_file = sid.as_deref().and_then(|s| crate::sessions::files::find_session_file(&crate::sessions::files::projects_dir(None), s));
        let what = if before.is_some() { "fork" } else { "branch" };
        let (Some(sid), Some(src_file)) = (sid, src_file) else { return Err(RunError::other(format!("this ticket has no Claude conversation to {what} yet"))) };
        if let Some(w) = ts(&src, "workdir")
            && !Path::new(w).exists()
        {
            return Err(RunError::other(format!("linked session folder no longer exists: {w}")));
        }
        // Checked before anything is made: a message the chat can't be cut at is refused.
        if let Some(b) = before
            && crate::chat::rewind::cut_session(&std::fs::read_to_string(&src_file).unwrap_or_default(), b).is_none()
        {
            return Err(RunError::other("The chat can't be forked from this message."));
        }
        let me = self.clone();
        let (s, t2, body, mode) = (slug.to_string(), title.to_string(), src.body.clone(), src.get("mode").cloned());
        let created = tokio::task::spawn_blocking(move || {
            let mut input = obj(json!({ "title": t2, "body": body, "status": "planning" }));
            if let Some(m) = mode.filter(|m| !m.is_null()) {
                input.insert("mode".into(), m);
            }
            me.tickets.create(&s, input)
        })
        .await
        .map_err(|e| RunError::other(e.to_string()))??;
        let new_id = created.id.clone();
        let out = self.fill_copy(slug, &src, &profile, &new_id, title, &sid, &src_file, before).await;
        match out {
            Ok(r) => Ok(r),
            Err((worktree, e)) => {
                if let Some(w) = worktree {
                    let path = PathBuf::from(profile.get("path").and_then(Value::as_str).unwrap_or(""));
                    let _ = crate::git::repo::remove_worktree::<std::future::Ready<()>>(&path, &w, None).await;
                }
                let me = self.clone();
                let s = slug.to_string();
                let _ = tokio::task::spawn_blocking(move || me.tickets.delete(&s, &new_id)).await;
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn fill_copy(self: &Arc<Self>, slug: &str, src: &Tk, profile: &Map<String, Value>, new_id: &str, title: &str, sid: &str, src_file: &Path, before: Option<&str>) -> Result<(Arc<Tk>, Option<String>), (Option<PathBuf>, RunError)> {
        let folder = self.git.branch_folder(slug, &Value::Object(src.json.clone()), new_id, title).await.map_err(|e| (None, RunError::other(e)))?;
        let wt = folder.worktree.clone();
        let fail = |e: String| (wt.clone(), RunError::other(e));
        let mut patch = obj(json!({
            "sessionId": uuid(), "sessionStarted": true, "refineStarted": true, "interviewed": src.get("interviewed").cloned().unwrap_or(Value::Null),
            "branchedFrom": src.id, "branchPoint": { "at": now_iso(), "sourceTitle": src.title },
        }));
        if !src.get("interviewed").is_some_and(|v| !v.is_null()) {
            patch.remove("interviewed");
        }
        patch.extend(folder.patch.clone());
        let path = profile.get("path").and_then(Value::as_str).unwrap_or("").to_string();
        let from_cwd = ts(src, "workdir")
            .map(str::to_string)
            .or_else(|| ts(src, "worktree").map(str::to_string))
            .or_else(|| ts(src, "branch").map(|_| crate::git::repo::worktree_dir(Path::new(&path), slug, &src.id).to_string_lossy().into_owned()))
            .unwrap_or_else(|| path.clone());
        let to_cwd = patch
            .get("workdir")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| wt.as_ref().map(|w| w.to_string_lossy().into_owned()))
            .unwrap_or_else(|| path.clone());
        // The branch gets its own copies of pasted images, so deleting either ticket can't break the other.
        let raw = std::fs::read_to_string(src_file).map_err(|e| fail(e.to_string()))?;
        let names = crate::tickets::files::referenced_attachments(&[src.body.clone(), raw.clone()]);
        let dir = crate::tickets::files::attachments_dir(&self.root);
        let mut rename: Vec<(String, String)> = Vec::new();
        for n in names {
            if !crate::tickets::files::is_attachment_name(&n) || !dir.join(&n).exists() {
                continue;
            }
            let ext = n.rsplit('.').next().unwrap_or("");
            let copy = format!("{}.{ext}", uuid().replace('-', ""));
            if std::fs::copy(dir.join(&n), dir.join(&copy)).is_ok() {
                rename.push((n, copy));
            }
        }
        if !rename.is_empty() {
            let mut body = src.body.clone();
            for (a, b) in &rename {
                body = body.split(a.as_str()).collect::<Vec<_>>().join(b);
            }
            patch.insert("body".into(), Value::String(body));
        }
        let to = patch.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        match before {
            None => {
                fork_session(src_file, sid, &to, &from_cwd, &to_cwd, &rename).map_err(fail)?;
            }
            Some(b) => match crate::chat::rewind::cut_session(&raw, b) {
                None => return Err(fail("The chat can't be forked from this message.".into())),
                // Forked from the first message: nothing to copy, the first message starts a new session.
                Some((_, cut)) if cut.empty => {
                    patch.insert("sessionStarted".into(), Value::Bool(false));
                    patch.insert("freshSession".into(), Value::Bool(true));
                }
                Some((text, _)) => {
                    fork_session_text(src_file, text, sid, &to, &from_cwd, &to_cwd, &rename).map_err(fail)?;
                }
            },
        }
        let outs = self.tickets.ticket_dir(slug, &src.id).join("outputs");
        if outs.is_dir() {
            let _ = copy_dir(&outs, &self.tickets.ticket_dir(slug, new_id).join("outputs"));
        }
        let me = self.clone();
        let (s, n) = (slug.to_string(), new_id.to_string());
        let t = tokio::task::spawn_blocking(move || me.patch(&s, &n, patch)).await.map_err(|e| fail(e.to_string()))?.map_err(|e| (wt.clone(), e))?;
        let warning = (!folder.warnings.is_empty()).then(|| folder.warnings.join(" "));
        Ok((t, warning))
    }
}
