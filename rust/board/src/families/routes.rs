//! A ticket's family routes in board mode (`src/api/ticket-info.ts`, `ticket-actions.ts`): `GET family`,
//! `GET family-view`, `GET`/`POST status`, `POST status/notes`, `POST own-work`, `POST gather`, `POST plan`, and
//! `merge-into-main` and `land` over R6's landing (`git::landing::Git`).
//! Called from the write routes (`tickets::routes::Writes`) after the board and the ticket were found.

use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::{Families, FeatureStatus};
use crate::index::family::{family_of, feature_root};
use crate::index::view::attention_of;
use crate::tickets::rights::{Who, is_manager, other_board, split_run};
use crate::tickets::routes::{Reply, Req, body_obj};
use crate::tickets::writer::{Refusal, bad};

/// Whether these routes answer `method` on a ticket's sub-path (`parts` after the ticket id).
pub fn wanted(method: &str, rest: &[&str]) -> bool {
    matches!(
        (method, rest),
        ("GET", ["family"]) | ("GET", ["family-view"]) | ("GET" | "POST", ["status"]) | ("POST", ["status", "notes"]) | ("POST", ["own-work" | "gather" | "plan" | "merge-into-main" | "land"])
    )
}

fn json_ok(v: Value) -> Result<Reply, Refusal> {
    Ok(Reply::Json(200, v))
}

/// `runBoard`: the board of the run that sent the request, None outside runs.
fn run_board(req: &Req) -> Option<String> {
    req.run.as_deref().map(|h| split_run(h).0)
}

/// `ownRun`: the run's ticket when it runs on this board.
fn own_run(req: &Req, slug: &str) -> Option<String> {
    let (s, id) = split_run(req.run.as_deref()?);
    (s == slug && !id.is_empty()).then_some(id)
}

/// `askedBy`: a chat answering a message the user typed there; how its change is credited, None for anyone else.
fn asked_by(f: &Families, req: &Req, slug: &str) -> Option<String> {
    let h = req.run.as_deref()?;
    if req.huddle {
        return None;
    }
    let (rs, rid) = split_run(h);
    let who = Who { tickets: &f.tickets, hooks: f.tickets.hooks() };
    if rs.is_empty() || rid.is_empty() || !who.user_asked_run(&rs, &rid) {
        return None;
    }
    let t = f.tickets.get(&rs, &rid)?;
    Some(if rs == slug {
        format!("by the chat of {} (\"{}\") (user request)", t.id, t.title)
    } else {
        format!("by the chat of {} on {} (user request)", t.id, who.board_name(&rs))
    })
}

/// `runTicket`: the run's ticket on this board; a run from another board is refused.
fn run_ticket(req: &Req, slug: &str) -> Result<Option<String>, Refusal> {
    let Some(h) = req.run.as_deref() else { return Ok(None) };
    let (rs, rid) = split_run(h);
    if rs != slug || rid.is_empty() {
        return Err((403, format!("tickets can only talk to tickets on their own board ({rs})")));
    }
    Ok(Some(rid))
}

fn same_feature(f: &Families, slug: &str, a: &str, b: &str) -> bool {
    let list = f.tickets.list(slug);
    let ra = feature_root(&list, a).map(|i| list.at(i).id.clone());
    ra.is_some() && ra == feature_root(&list, b).map(|i| list.at(i).id.clone())
}

/// The answer to a family route on ticket `id` of board `slug`.
pub fn answer(f: &Arc<Families>, req: &Req, slug: &str, id: &str, rest: &[&str]) -> Result<Reply, Refusal> {
    match (req.method.as_str(), rest) {
        ("GET", ["family"]) => family(f, slug, id),
        ("GET", ["family-view"]) => family_view(f, slug, id),
        ("GET", ["status"]) => {
            let s = f.feature_status(slug, id).map_err(bad)?;
            json_ok(Value::Object(s.to_json()))
        }
        ("POST", ["status"]) => update_status(f, req, slug, id),
        ("POST", ["status", "notes"]) => {
            if req.run.is_some() || req.huddle {
                return Err((403, "only the user adds notes to the status (Add a note)".into()));
            }
            let b = body_obj(req)?;
            let text = match b.get("text") {
                None | Some(Value::Null) => String::new(),
                v => super::plan::tpl(v),
            };
            let s = f.add_status_note(slug, id, &text).map_err(bad)?;
            json_ok(Value::Object(s.to_json()))
        }
        ("POST", ["own-work"]) => {
            if let Some(from) = run_board(req)
                && asked_by(f, req, slug).is_none()
            {
                if from != slug {
                    return Err(other_board("making a task its own work", slug, &from));
                }
                return Err((403, "making a task its own work works from a chat, in a reply to a message the user typed there".into()));
            }
            let t = f.make_own_work(slug, id).map_err(bad)?;
            json_ok(f.view(slug, &t))
        }
        ("POST", ["gather"]) => gather(f, req, slug, id),
        ("POST", ["plan"]) => plan(f, req, slug, id),
        // merge_into_main: a tool ticket's own run fast-forwards its main ticket's copy (R6's landing).
        ("POST", ["merge-into-main"]) => {
            if run_ticket(req, slug)?.as_deref() != Some(id) || req.huddle {
                return Err((403, "merge_into_main works only from the tool ticket's own run".into()));
            }
            let git = f.landing().ok_or_else(|| (503, "the board is still starting; try again in a moment".to_string()))?;
            let message = crate::tickets::writer::block(git.merge_into_main(slug, id)).map_err(|e| (409, e))?;
            json_ok(json!({ "message": message }))
        }
        // land_milestone: the main ticket's own run (or the user) lands its copy.
        ("POST", ["land"]) => {
            let caller = run_ticket(req, slug)?;
            if caller.as_deref().is_some_and(|c| c != id) || req.huddle {
                return Err((403, "land_milestone works only from the main ticket's own run".into()));
            }
            let b = body_obj(req)?;
            let summary = match b.get("summary") {
                None | Some(Value::Null) => String::new(),
                v => super::plan::tpl(v),
            };
            let git = f.landing().ok_or_else(|| (503, "the board is still starting; try again in a moment".to_string()))?;
            let message = crate::tickets::writer::block(git.land_milestone(slug, id, &summary)).map_err(|e| (409, e))?;
            json_ok(json!({ "message": message }))
        }
        _ => Err((404, "not found".into())),
    }
}

/// `GET .../family`: the whole family from the top ticket down, with each one's session and last result.
fn family(f: &Families, slug: &str, id: &str) -> Result<Reply, Refusal> {
    let list = f.tickets.list(slug);
    let profile = ckanban_core::DataDir::new(f.tickets.root().to_path_buf()).profile(slug).map(|p| p.record.0).unwrap_or_default();
    let rows: Vec<Value> = family_of(&list, id)
        .into_iter()
        .map(|r| {
            let t = list.at(r.idx);
            let mut m = Map::new();
            m.insert("id".into(), t.id.clone().into());
            m.insert("title".into(), t.json.get("title").cloned().unwrap_or(Value::Null));
            m.insert("status".into(), t.json.get("status").cloned().unwrap_or(Value::Null));
            m.insert("depth".into(), r.depth.into());
            let how = r.how.map(|h| match h.word() {
                "chat" => "from chat",
                w => w,
            });
            m.insert("how".into(), how.map(Value::from).unwrap_or(Value::Null));
            let parent = if r.depth > 0 { t.parent_link().map(|(p, _)| Value::from(p)).unwrap_or(Value::Null) } else { Value::Null };
            m.insert("parent".into(), parent);
            if r.depth > 0 && t.main {
                m.insert("subFeature".into(), true.into());
            } else if t.tool {
                m.insert("task".into(), true.into());
                if t.show_true {
                    m.insert("showOnBoard".into(), true.into());
                }
            } else if t.show_false {
                m.insert("showOnBoard".into(), false.into());
            }
            // JSON.stringify leaves out what the file doesn't have (undefined).
            if let Some(s) = t.json.get("sessionId") {
                m.insert("sessionId".into(), s.clone());
            }
            let sid = t.s("sessionId").filter(|s| !s.is_empty());
            let resume = sid.map(|sid| {
                let dir = [t.get("workdir"), t.get("worktree"), profile.get("path")].into_iter().flatten().find(|v| !v.is_null());
                crate::prompts::planning::resume_command(&super::plan::tpl(dir), sid)
            });
            m.insert("resumeCommand".into(), resume.map(Value::from).unwrap_or(Value::Null));
            if let Some(p) = t.json.get("prUrl") {
                m.insert("prUrl".into(), p.clone());
            }
            if let Some(u) = t.json.get("updatedAt") {
                m.insert("updatedAt".into(), u.clone());
            }
            let last = f.reads.viewer.comments.last_ai(&f.tickets.ticket_dir(slug, &t.id));
            m.insert("result".into(), last.map(Value::from).unwrap_or(Value::Null));
            Value::Object(m)
        })
        .collect();
    json_ok(Value::Array(rows))
}

/// `resolveRun`'s model and effort: the ticket's, else the board's (a main ticket's own model first).
fn resolve_run(t: &crate::index::ticket::Tk, p: &Map<String, Value>) -> (Value, Value) {
    let text = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let model = text(t.get("model")).or_else(|| if t.main { text(p.get("mainModel")) } else { None }).or_else(|| text(p.get("model")));
    let level = |v: Option<&Value>| text(v).map(|e| if e == "ultracode" { "xhigh".to_string() } else { e });
    let effort = level(t.get("effort")).or_else(|| level(p.get("effort")));
    (model.map(Value::from).unwrap_or(Value::Null), effort.map(Value::from).unwrap_or(Value::Null))
}

/// `GET .../family-view`: the Family tab's rows (model, cost, needs you, last summary, finished, report).
fn family_view(f: &Families, slug: &str, id: &str) -> Result<Reply, Refusal> {
    let list = f.tickets.list(slug);
    let profile = ckanban_core::DataDir::new(f.tickets.root().to_path_buf()).profile(slug).map(|p| p.record.0).unwrap_or_default();
    let live = &*f.reads.live;
    let mut rows = Vec::new();
    for r in family_of(&list, id) {
        let t = list.at(r.idx);
        let mut m = Map::new();
        m.insert("id".into(), t.id.clone().into());
        m.insert("depth".into(), r.depth.into());
        let parent = if r.depth > 0 { t.parent_link().map(|(p, _)| Value::from(p)).unwrap_or(Value::Null) } else { Value::Null };
        m.insert("parent".into(), parent);
        if r.depth > 0 && t.main {
            m.insert("subFeature".into(), true.into());
            m.insert("tasks".into(), f.tickets.tool_tickets(slug, &t.id).len().into());
        }
        let (model, effort) = resolve_run(t, &profile);
        m.insert("model".into(), model);
        m.insert("effort".into(), effort);
        m.insert("costUsd".into(), ckanban_core::jsnum::num(live.cost(slug, &t.id) + live.huddle_spend(slug, &t.id)));
        let session = t.s("sessionId").filter(|s| !s.is_empty()).and_then(|s| live.session(s));
        let (attention, _) = attention_of(f.tickets.root(), slug, &list, t, live, session.as_ref());
        let needs = !attention.is_null() && attention.get("kind").and_then(Value::as_str) != Some("review");
        m.insert("needsYou".into(), needs.into());
        let last = f.reads.viewer.comments.last_ai(&f.tickets.ticket_dir(slug, &t.id));
        m.insert("summary".into(), last.map(Value::from).unwrap_or(Value::Null));
        let finished = if live.running(slug, &t.id) {
            Value::Null
        } else {
            [t.get("runEndedAt"), t.get("doneAt")].into_iter().flatten().find(|v| !v.is_null()).cloned().unwrap_or(Value::Null)
        };
        m.insert("finishedAt".into(), finished);
        let report = f.tickets.ticket_dir(slug, &t.id).join("outputs").join("report.md").exists();
        m.insert("report".into(), report.into());
        rows.push(Value::Object(m));
    }
    json_ok(Value::Array(rows))
}

fn is_pr_url(u: &str) -> bool {
    let Some(rest) = u.strip_prefix("https://github.com/") else { return false };
    let p: Vec<&str> = rest.split('/').collect();
    let part = |s: &str| !s.is_empty() && !s.chars().any(crate::index::text::is_space);
    p.len() == 4 && part(p[0]) && part(p[1]) && p[2] == "pull" && !p[3].is_empty() && p[3].chars().all(|c| c.is_ascii_digit())
}

/// `POST .../status` (update_status): the user, a run in the same feature, or a chat answering the user's message.
fn update_status(f: &Families, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
    if req.huddle {
        return Err((403, "huddle helpers can't change the feature's status; tell @main what to put there".into()));
    }
    let mut by = None;
    if let Some(from) = run_board(req) {
        let caller = own_run(req, slug);
        if !caller.as_deref().is_some_and(|c| same_feature(f, slug, c, id)) {
            by = asked_by(f, req, slug);
            if by.is_none() && from != slug {
                return Err(other_board("updating a feature's status", slug, &from));
            }
            if by.is_none() {
                let c = caller.unwrap_or_else(|| "null".into());
                return Err((
                    403,
                    format!(
                        "only runs of tickets in this feature may update its status ({c} is not in {id}'s family), or a chat replying to a message the user typed there"
                    ),
                ));
            }
        }
    }
    let b = body_obj(req)?;
    let mut patch: Vec<(String, Option<String>)> = Vec::new();
    for k in super::status::STATUS_FIELDS {
        match b.get(k) {
            None => {}
            Some(Value::Null) => patch.push((k.into(), None)),
            Some(Value::String(s)) => patch.push((k.into(), Some(s.clone()))),
            Some(_) => return Err(bad(format!("{k} must be text or null"))),
        }
    }
    let mut notes: Option<Vec<(String, Option<String>)>> = None;
    if let Some(n) = b.get("prNotes") {
        let Value::Object(n) = n else { return Err(bad("prNotes must map pull request URLs to a short note")) };
        let fs = f.feature_status(slug, id).map_err(bad)?;
        let prs: Vec<String> = fs.facts.get("prs").and_then(Value::as_array).into_iter().flatten().filter_map(|p| p.get("url").and_then(Value::as_str).map(str::to_string)).collect();
        notes = Some(
            n.iter()
                .filter(|(u, _)| prs.contains(u))
                .take(100)
                .map(|(u, v)| (u.clone(), v.as_str().map(str::to_string)))
                .collect(),
        );
    }
    let mut added_prs = false;
    if let Some(prs) = b.get("prs") {
        let list = match prs {
            Value::Array(a) if a.iter().all(|u| u.as_str().is_some_and(is_pr_url)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>(),
            _ => return Err(bad("prs must be a list of GitHub pull request URLs, e.g. https://github.com/owner/repo/pull/12")),
        };
        let board = f.tickets.list(slug);
        if let (Some(top), false) = (feature_root(&board, id).map(|i| board.tickets[i].clone()), list.is_empty()) {
            let urls: Vec<String> = list.into_iter().take(20).collect();
            let add = crate::git::pr::add_prs(&Value::Object(top.json.clone()), &urls);
            if add.contains_key("prs") {
                f.tickets.patch(slug, &top.id, add)?;
            }
            added_prs = true;
        }
    }
    if patch.is_empty() && notes.is_none() && !added_prs {
        return Err(bad("nothing to update: pass goal, done, broken, waiting, next, prNotes or prs"));
    }
    let (s, markdown): (FeatureStatus, String) = f.update_status(slug, id, &patch, notes.as_deref()).map_err(bad)?;
    if let Some(by) = &by {
        f.tickets.note(slug, &s.top.id, &format!("Status updated {by}."));
    }
    let mut out = s.to_json();
    out.insert("markdown".into(), markdown.into());
    json_ok(Value::Object(out))
}

/// `POST .../gather`: the user (Family tab), or a chat answering the user's own message (credited when it isn't the
/// feature's own).
fn gather(f: &Families, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
    let mut by = None;
    if let Some(from) = run_board(req) {
        by = asked_by(f, req, slug);
        if by.is_none() && from != slug {
            return Err(other_board("gathering tickets", slug, &from));
        }
        if by.is_none() {
            return Err((403, "gathering tickets works from a chat, in a reply to a message the user typed there".into()));
        }
        if own_run(req, slug).is_some_and(|c| same_feature(f, slug, &c, id)) {
            by = None;
        }
    }
    let b = body_obj(req)?;
    let Some(Value::Array(items)) = b.get("tickets").filter(|t| t.as_array().is_some_and(|a| !a.is_empty())) else {
        return Err(bad("tickets must list { id, group } entries"));
    };
    let text = |v: Option<&Value>| v.and_then(Value::as_str).map(crate::index::text::js_trim).filter(|s| !s.is_empty()).map(str::to_string);
    let items: Vec<(String, Option<String>)> = items.iter().filter_map(|x| text(x.get("id")).map(|i| (i, text(x.get("group"))))).collect();
    if b.get("hide").is_some_and(|h| !h.is_boolean()) {
        return Err(bad("hide must be true or false"));
    }
    let new_group = b.get("newGroup").and_then(Value::as_str);
    let r = f.gather(slug, id, &items, new_group, by.as_deref(), b.get("hide") == Some(&Value::Bool(true))).map_err(bad)?;
    let views: Vec<Value> = r.gathered.iter().map(|t| f.view(slug, t)).collect();
    json_ok(json!({
        "gathered": views, "movedUp": r.moved_up, "skipped": r.skipped,
        "group": r.group.as_ref().map(|g| f.view(slug, g)).unwrap_or(Value::Null), "kept": r.kept,
    }))
}

/// `POST .../plan`: start, pause, resume or mark done a manager's plan (a main ticket's own run may start or resume it).
fn plan(f: &Families, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
    let b = body_obj(req)?;
    let action = b.get("action").and_then(Value::as_str).unwrap_or("");
    let starts = action == "start" || action == "resume";
    let t = f.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
    if starts && !is_manager(&t) {
        return Err(bad("only a main ticket runs tickets of its own: turn this ticket into a main ticket first"));
    }
    let by_planner = req.run.is_some();
    if by_planner {
        if run_ticket(req, slug)?.as_deref() != Some(id) || !starts {
            return Err((403, "a board run may only start or resume its own ticket's plan; pausing and finishing are the user's".into()));
        }
        let who = Who { tickets: &f.tickets, hooks: f.tickets.hooks() };
        if who.planner_rights(slug, id).is_none() {
            return Err((
                403,
                "starting the plan from a board run needs the user's go-ahead: only a reply to the user's message in this ticket's chat may do it".into(),
            ));
        }
        if t.plan_state() == Some("done") {
            return Err((403, "this ticket's plan is done; the user can start a new one first".into()));
        }
    }
    let out = match action {
        "pause" => f.pause_plan(slug, id),
        "start" | "resume" => f.start_plan(slug, id, by_planner, None),
        "done" => f.mark_plan_done(slug, id),
        _ => return Err(bad("action must be start, pause, resume or done")),
    }
    .map_err(bad)?;
    let now = f.tickets.get(slug, id).unwrap_or(out);
    json_ok(f.view(slug, &now))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_urls() {
        assert!(is_pr_url("https://github.com/o/r/pull/12"));
        assert!(!is_pr_url("https://github.com/o/r/pull/x"));
        assert!(!is_pr_url("https://example.com/x"));
        assert!(!is_pr_url("https://github.com/o/r/pull/12/files"));
    }
}
