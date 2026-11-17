//! Follow-up work from a proposal card (`followUpWork`, `src/board/board-tickets.ts`) and where it goes
//! (`followUpPlace`, `followUpFor` of `web/src/features/ticket/followUp.ts`).

use std::sync::Arc;

use serde_json::{Value, json};

use super::board::{RunError, RunLoop, obj, ts};
use crate::families::rules::{MAX_LEVEL, fit_parent, level_of};
use crate::index::store::BoardList;
use crate::index::ticket::Tk;

/// `followUpPlace` in full.
pub enum Place {
    /// A step run by `manager`, under `part_of` (None: right under the manager).
    Step { manager: String, part_of: Option<String> },
    /// The ticket becomes a main ticket and the work its first step.
    Main,
    /// A new ticket next to it.
    Ticket { part_of: String },
}

fn runs_tasks(t: &Tk) -> bool {
    t.main || (t.tool && matches!(t.kind.as_deref(), Some("group" | "round")))
}

pub fn follow_up_place(list: &BoardList, id: &str) -> Option<Place> {
    let t = list.get(id)?;
    let mut up: Vec<Arc<Tk>> = Vec::new();
    let mut seen = std::collections::HashSet::from([t.id.clone()]);
    let mut p = t.parent_link().and_then(|(p, _)| list.get(p)).cloned();
    while let Some(x) = p {
        if !seen.insert(x.id.clone()) {
            break;
        }
        p = x.parent_link().and_then(|(q, _)| list.get(q)).cloned();
        up.push(x);
    }
    if let Some(mi) = up.iter().position(|p| p.main) {
        let manager = up[..mi].iter().find(|p| runs_tasks(p) && level_of(list, &p.id) < MAX_LEVEL).unwrap_or(&up[mi]).id.clone();
        let spot = fit_parent(list, &t.id);
        return Some(Place::Step { part_of: (spot != manager).then_some(spot), manager });
    }
    if up.is_empty() {
        return Some(Place::Main);
    }
    Some(Place::Ticket { part_of: fit_parent(list, &t.id) })
}

impl RunLoop {
    /// `followUpWork`. Blocking.
    pub fn follow_up_work(&self, slug: &str, id: &str, title: &str, body: &str, start: bool, important: bool) -> Result<Arc<Tk>, RunError> {
        let src = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let title = crate::runs::js::trim(title).to_string();
        if title.is_empty() {
            return Err(RunError::other("title is required"));
        }
        let list = self.tickets.list(slug);
        let own: Vec<&Arc<Tk>> = list.tickets.iter().filter(|t| t.s("madeFrom") == Some(&src.id)).collect();
        if let Some(made) = own.iter().find(|t| t.s("proposedAs") == Some(&title)).or_else(|| own.iter().find(|t| t.title == title)) {
            return Ok((*made).clone());
        }
        if src.main {
            return Err(RunError::other("A main ticket's card updates its own plan: it adds new work as steps itself."));
        }
        if src.tool {
            return Err(RunError::other("A step's follow-up work goes through its main ticket."));
        }
        let place = follow_up_place(&list, &src.id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let shaping = src.status == "planning" || src.status == "backlog";
        let reopened = src.get("reopenedFrom").filter(|r| r.is_object()).cloned();
        let was_status = if shaping && let Some(r) = &reopened { r.get("status").and_then(Value::as_str).unwrap_or("").to_string() } else { src.status.clone() };
        let mut extra = serde_json::Map::new();
        if src.is("important") || important {
            extra.insert("important".into(), Value::Bool(true));
        }
        if !src.tags.is_empty() {
            extra.insert("tags".into(), json!(src.tags));
        }
        let created;
        let mut manager: Option<Arc<Tk>> = None;
        match place {
            Place::Ticket { part_of } => {
                let mut input = obj(json!({ "title": title, "body": body, "status": "backlog", "mode": "auto", "proposedAs": title, "madeFrom": src.id, "partOf": part_of }));
                input.extend(extra);
                if was_status == "review" && let Some(b) = ts(&src, "branch") && !src.is("workdir") {
                    input.insert("startFrom".into(), Value::String(b.into()));
                }
                created = self.tickets.create(slug, input)?;
            }
            p => {
                let (mgr_id, part_of) = match &p {
                    Place::Main => {
                        self.patch(slug, &src.id, obj(json!({ "main": true })))?;
                        self.note(slug, &src.id, &format!("Became a main ticket: follow-up work \"{title}\" runs as its first step, and you keep talking here."));
                        (src.id.clone(), None)
                    }
                    Place::Step { manager, part_of } => (manager.clone(), part_of.clone()),
                    Place::Ticket { .. } => unreachable!(),
                };
                let mgr = self.get(slug, &mgr_id).ok_or_else(|| RunError::other(format!("ticket {mgr_id} not found")))?;
                let top = self.tickets.main_of(slug, &mgr).unwrap_or_else(|| mgr.clone());
                let start_from = (top.is("branch") && top.is("worktree")).then(|| ts(&top, "branch").unwrap_or("").to_string());
                let models = self.profile(slug).and_then(|p| p.get("taskModels").cloned());
                let (model, effort) = crate::tickets::norm::kind_defaults(Some("build"), models.as_ref()).unwrap_or_default();
                let mut input = obj(json!({
                    "title": title, "body": body, "status": "backlog", "mode": "auto", "proposedAs": title, "madeFrom": src.id, "parentId": mgr.id,
                    "kind": "build", "tool": true, "model": model, "effort": effort,
                }));
                if let (Place::Step { .. }, Some(po)) = (&p, part_of) {
                    input.insert("partOf".into(), Value::String(po));
                }
                input.extend(extra);
                if let Some(sf) = start_from {
                    input.insert("startFrom".into(), Value::String(sf));
                }
                created = self.tickets.create(slug, input)?;
                self.note(slug, &created.id, &format!("Tool ticket of {} (\"{}\"): follow-up work the user asked for in the chat of {} (\"{}\").", mgr.id, mgr.title, src.id, src.title));
                if matches!(p, Place::Step { .. }) {
                    self.note(slug, &src.id, &format!("Follow-up work \"{title}\" runs as a step of \"{}\"; its result goes there.", top.title));
                }
                manager = Some(mgr);
            }
        }
        if shaping && let Some(r) = reopened && !self.is_running(slug, id) {
            let mut p = serde_json::Map::new();
            p.insert("status".into(), r.get("status").cloned().unwrap_or(Value::Null));
            self.tickets.update(slug, id, &p, false)?;
            self.patch(slug, id, obj(json!({ "outcome": r.get("outcome").cloned().unwrap_or(Value::Null) })))?;
        }
        if let Some(mgr) = manager {
            if self.get(slug, &mgr.id).is_some_and(|m| m.main) {
                self.families.unpark_main(slug, &mgr.id, "it made a new step, so its steps run again", false);
            }
            self.families.ensure_plan(slug, &mgr.id);
            self.families.advance_plans(slug);
            return self.get(slug, &created.id).ok_or_else(|| RunError::other("ticket not found"));
        }
        if start {
            let mut p = serde_json::Map::new();
            p.insert("status".into(), "ready".into());
            return Ok(self.tickets.update(slug, &created.id, &p, false)?);
        }
        self.get(slug, &created.id).ok_or_else(|| RunError::other("ticket not found"))
    }
}
