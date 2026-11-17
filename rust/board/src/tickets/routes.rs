//! The write routes in board mode (R2a), as `src/api/` answers them: a ticket's create (`tickets-list.ts` POST),
//! change and delete (`tickets.ts`), move (`ticket-actions.ts`), comments and the chat's cards (`ticket-cards.ts`),
//! snooze and seen (`ticket-info.ts`), the board routes (`profiles.ts`, in `profiles.rs`), attachments, avatars and
//! snippets. Answers are JSON; the server masks saved keys in their text, as Bun's `json()` does.
//!
//! Blocking: `Writes::answer` runs on the blocking pool (file writes, `git status`, the user check), and calls the
//! async hooks of later steps with `writer::block`.

use std::path::PathBuf;
use std::sync::Arc;

use ckanban_core::DataDir;
use ckanban_core::jsnum::truthy;
use serde_json::{Map, Value, json};

use super::files::{self, js_string};
use super::hooks::BoardHooks;
use super::norm::{SELF_MOVES, STATUSES, TICKET_KINDS, effort_help, kind_defaults, model_help, strings, valid_effort, valid_model};
use super::rights::{Rights, Who, is_manager, split_run};
use super::writer::{Refusal, Tickets, bad, block, now};
use crate::api::SessionInfo;
use crate::index::Reads;
use crate::index::attention::{snooze_key, ticket_attention};
use crate::index::family::feature_root;
use crate::index::routes::{param, path_parts};
use crate::index::text::js_trim;
use crate::index::ticket::Tk;
use crate::index::view::schedule_ids;

pub const RUN_HEADER: &str = "x-ckanban-run";
pub const HUDDLE_HEADER: &str = "x-ckanban-huddle-agent";
pub const SOURCE_HEADER: &str = "x-ckanban-source";

/// `SNOOZE_MS` and `SNOOZE_FOREVER` in `src/helper/attention.ts`.
const SNOOZE_HOURS: f64 = 24.0;
const SNOOZE_FOREVER: &str = "9999-12-31T23:59:59.000Z";

/// A request the write routes may answer.
pub struct Req {
    pub method: String,
    pub path: String,
    pub query: String,
    /// `x-ckanban-run` when sent and not empty.
    pub run: Option<String>,
    /// `x-ckanban-huddle-agent` sent (not empty).
    pub huddle: bool,
    pub source: Option<String>,
    /// The content type before any `;`, trimmed, lowercase.
    pub content_type: String,
    pub file_name: Option<String>,
    pub body: Vec<u8>,
    /// `userOnly`'s check of the caller (blocking): the user's own browser, not a run or another program.
    pub user: Arc<dyn Fn() -> bool + Send + Sync>,
}

/// An answer.
pub enum Reply {
    Json(u16, Value),
    Empty(u16),
    /// A stored file with its headers.
    File(PathBuf, Vec<(String, String)>),
}

fn err((status, msg): Refusal) -> Reply {
    Reply::Json(status, json!({ "error": msg }))
}

/// Saves a board's keys from a key box (`passes.saveBoardKeys`, the server's pass store): the names saved.
pub type SaveKeys = Arc<dyn Fn(&str, &[(String, Option<Value>, Value)]) -> Result<Vec<String>, Refusal> + Send + Sync>;

/// `userOnly`'s refusal text.
pub fn user_only_refusal(what: &str) -> Refusal {
    (
        403,
        format!(
            "{what} is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board."
        ),
    )
}

/// Whether the write routes answer this request (method and path only); the rest goes on (to Bun).
pub fn wanted(method: &str, path: &str) -> bool {
    let Some(parts) = path_parts(path) else { return false };
    let p: Vec<&str> = parts.iter().map(String::as_str).collect();
    match (method, p.as_slice()) {
        ("POST", ["attachments"]) | ("GET", ["attachments", _]) | ("GET", ["attachments", _, "info"]) => true,
        ("GET", ["avatars"]) | ("PUT" | "DELETE", ["avatars", _]) | ("PUT", ["avatars", "claude", "name"]) => true,
        ("GET" | "POST", ["snippets"]) | ("PATCH" | "DELETE", ["snippets", _]) => true,
        ("POST", ["profiles"]) | ("PATCH" | "DELETE", ["profiles", _]) => true,
        ("POST", ["profiles", _, "tickets"]) | ("PATCH" | "DELETE", ["profiles", _, "tickets", _]) => true,
        ("POST", ["profiles", _, "tickets", _, "move" | "seen"]) => true,
        ("GET" | "POST", ["profiles", _, "tickets", _, "comments"]) => true,
        ("POST" | "DELETE", ["profiles", _, "tickets", _, "snooze"]) => true,
        ("POST", ["profiles", _, "tickets", _, "key-cards", _]) => true,
        (m, ["profiles", _, "tickets", _, rest @ ..]) if crate::families::routes::wanted(m, rest) => true,
        (m, ["profiles", _, "tickets", _, rest @ ..]) if crate::runloop::routes::wanted(m, rest) => true,
        (m, ["profiles", _, "tickets", _, rest @ ..]) if crate::chat::routes::wanted(m, rest) => true,
        (m, ["profiles", _, "tickets", _, rest @ ..]) if crate::chat::extras::wanted(m, rest) => true,
        ("GET", ["profiles", _, "commands"]) => true,
        ("PUT", ["profiles", _, "tickets", _, "automation-cards" | "squad-cards" | "teammate-cards" | "closed-forms" | "schedule-delete-cards" | "helper-rule-cards", _]) => {
            true
        }
        _ => false,
    }
}

pub struct Writes {
    pub tickets: Arc<Tickets>,
    pub reads: Arc<Reads>,
    pub sessions: Arc<dyn SessionInfo>,
    pub save_keys: SaveKeys,
    /// Key boxes being saved right now ("<board>/<ticket>/<box>").
    in_flight: parking_lot::Mutex<std::collections::HashSet<String>>,
    /// Families, plans and the feature status (R2b), once board mode has made them.
    families: std::sync::OnceLock<Arc<crate::families::Families>>,
    /// The run loop (R7a): chat, queue, stop, limits, follow-ups.
    runs: std::sync::OnceLock<Arc<crate::runloop::RunLoop>>,
    /// Say it simpler, Help me understand and the Context panel (R7b).
    chat_extras: std::sync::OnceLock<Arc<crate::chat::extras::ChatExtras>>,
    /// The helper (P1a): the user opened a ticket (its reminders stop); true when a reminder was pending.
    opened: std::sync::OnceLock<Opened>,
}

/// `notifier.opened(slug, id)`.
pub type Opened = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// `body(req)`: the JSON body; 400 when it isn't JSON.
fn body(req: &Req) -> Result<Value, Refusal> {
    serde_json::from_slice::<Value>(&req.body).map(ckanban_core::jsnum::normalize).map_err(|_| bad("invalid JSON body"))
}

/// `(await body(req)) ?? {}` as an object (anything else reads as no fields, like property reads on it).
pub(crate) fn body_obj(req: &Req) -> Result<Map<String, Value>, Refusal> {
    Ok(match body(req)? {
        Value::Object(m) => m,
        _ => Map::new(),
    })
}

impl Writes {
    pub fn new(tickets: Arc<Tickets>, reads: Arc<Reads>, sessions: Arc<dyn SessionInfo>, save_keys: SaveKeys) -> Writes {
        Writes { tickets, reads, sessions, save_keys, in_flight: Default::default(), families: Default::default(), runs: Default::default(), chat_extras: Default::default(), opened: Default::default() }
    }

    /// The chat extras (R7b): their routes answer from them.
    pub fn set_chat_extras(&self, x: Arc<crate::chat::extras::ChatExtras>) {
        let _ = self.chat_extras.set(x);
    }

    /// R2b's families: the family routes answer from them, and a run's ticket is placed in its feature.
    pub fn set_families(&self, f: Arc<crate::families::Families>) {
        let _ = self.families.set(f);
    }

    /// The run loop (R7a): its routes answer from it.
    pub fn set_runs(&self, r: Arc<crate::runloop::RunLoop>) {
        let _ = self.runs.set(r);
    }

    /// The helper's `opened` (P1a): opening a ticket stops its reminders.
    pub fn set_opened(&self, f: Opened) {
        let _ = self.opened.set(f);
    }

    /// `view(profile, t)` for the run loop's routes.
    pub fn view_pub(&self, slug: &str, t: &Tk) -> Value {
        self.view(slug, t)
    }
    /// The ticket's view now (null when it is gone).
    pub fn view_now_pub(&self, slug: &str, id: &str) -> Value {
        self.view_now(slug, id)
    }

    fn hooks(&self) -> Arc<dyn BoardHooks> {
        self.tickets.hooks()
    }

    fn who(&self) -> Who<'_> {
        Who { tickets: &self.tickets, hooks: self.hooks() }
    }

    fn root(&self) -> PathBuf {
        self.tickets.root.clone()
    }

    fn profile(&self, slug: &str) -> Option<Map<String, Value>> {
        DataDir::new(self.root()).profile(slug).map(|p| p.record.0)
    }

    /// `view(profile, t)`: the ticket as the board shows it.
    pub fn view(&self, slug: &str, t: &Tk) -> Value {
        let p = self.profile(slug).unwrap_or_default();
        let list = self.tickets.list(slug);
        Value::Object(self.reads.viewer.view(slug, &p, &list, t, &*self.reads.live))
    }

    fn view_now(&self, slug: &str, id: &str) -> Value {
        match self.tickets.get(slug, id) {
            Some(t) => self.view(slug, &t),
            None => Value::Null,
        }
    }

    fn user_only(&self, req: &Req, what: &str) -> Result<(), Refusal> {
        if req.run.is_some() || req.huddle || !(req.user)() { Err(user_only_refusal(what)) } else { Ok(()) }
    }

    /// The answer; None when this isn't one of these routes (it goes on to Bun).
    pub fn answer(&self, req: &Req) -> Option<Reply> {
        if !wanted(&req.method, &req.path) {
            return None;
        }
        let Some(parts) = path_parts(&req.path) else { return Some(err(bad("malformed URL"))) };
        let p: Vec<&str> = parts.iter().map(String::as_str).collect();
        let m = req.method.as_str();
        Some(match p[0] {
            "attachments" => self.attachments(req, &p),
            "avatars" => self.avatars(req, &p),
            "snippets" => self.snippets(req, &p),
            _ => {
                if p.len() == 1 {
                    return Some(super::profiles::create(self, req).unwrap_or_else(err));
                }
                let slug = p[1];
                // A board is a folder under profiles/: a name that leaves it (`..`, a slash) is never one.
                if slug.is_empty() || slug == "." || slug == ".." || slug.contains('/') || slug.contains('\0') || self.profile(slug).is_none() {
                    return Some(err((404, format!("board {slug} not found"))));
                }
                if p.len() == 2 {
                    return Some(super::profiles::routes(self, req, slug).unwrap_or_else(err));
                }
                if p.len() == 3 {
                    if p[2] == "commands" {
                        return Some(crate::chat::routes::board_commands(&self.profile(slug).unwrap_or_default()));
                    }
                    return Some(self.create(req, slug).unwrap_or_else(err));
                }
                let id = p[3];
                if self.tickets.get(slug, id).is_none() {
                    return Some(err((404, format!("ticket {id} not found"))));
                }
                if crate::runloop::routes::wanted(m, &p[4..]) {
                    return Some(match self.runs.get() {
                        Some(r) => crate::runloop::routes::answer(r, self, req, slug, id, &p[4..]).unwrap_or_else(err),
                        None => err((503, "the board is still starting; try again in a moment".into())),
                    });
                }
                if crate::chat::routes::wanted(m, &p[4..]) {
                    return Some(match self.runs.get() {
                        Some(r) => crate::chat::routes::answer(r, self, req, slug, id, &p[4..]).unwrap_or_else(err),
                        None => err((503, "the board is still starting; try again in a moment".into())),
                    });
                }
                if crate::chat::extras::wanted(m, &p[4..]) {
                    return Some(match self.chat_extras.get() {
                        Some(x) => x.answer(req, slug, id, &p[4..]).unwrap_or_else(err),
                        None => err((503, "the board is still starting; try again in a moment".into())),
                    });
                }
                if crate::families::routes::wanted(m, &p[4..]) {
                    return Some(match self.families.get() {
                        Some(f) => crate::families::routes::answer(f, req, slug, id, &p[4..]).unwrap_or_else(err),
                        None => err((404, "not found".into())),
                    });
                }
                let r = match (m, p.get(4).copied()) {
                    ("PATCH", None) => self.patch(req, slug, id),
                    ("DELETE", None) => self.delete(req, slug, id),
                    (_, Some("move")) => self.move_to(req, slug, id),
                    (_, Some("comments")) => self.comments(req, slug, id),
                    (_, Some("snooze")) => self.snooze(req, slug, id),
                    (_, Some("seen")) => self.seen(req, slug, id),
                    (_, Some(card)) => self.card(req, slug, id, card, p[5]),
                    _ => Err((404, "not found".into())),
                };
                r.unwrap_or_else(err)
            }
        })
    }

    // ---- Tickets ----

    /// `POST /api/profiles/:p/tickets`.
    fn create(&self, req: &Req, slug: &str) -> Result<Reply, Refusal> {
        let b = body_obj(req)?;
        let title = js_trim(&js_string(b.get("title"), "")).to_string();
        if title.is_empty() {
            return Err(bad("title is required"));
        }
        let from_run = req.run.as_deref().map(split_run);
        let want_main = b.get("main") == Some(&Value::Bool(true));
        if !matches!(b.get("main"), None | Some(Value::Null) | Some(Value::Bool(_))) {
            return Err(bad("main must be true or false"));
        }
        let who = self.who();
        if want_main {
            if truthy(b.get("parentId")) {
                return Err(bad("a main ticket isn't part of a plan: leave out parentId (use partOf to make it a sub-feature)"));
            }
            if truthy(b.get("sessionId")) {
                return Err(bad("a main ticket can't be made from a linked session: leave out sessionId"));
            }
            if let Some((rs, rid)) = &from_run
                && (req.huddle || rid.is_empty() || !who.user_asked_run(rs, rid))
            {
                return Err((
                    403,
                    "main: true needs a message the user typed in this chat: work runs, follow-ups, plan wake-ups, replies to other tickets and huddle helpers can't create main tickets".into(),
                ));
            }
        } else if !matches!(b.get("gather"), None | Some(Value::Null)) {
            return Err(bad("gather only works with main: true (use gather_tickets to add tickets to an existing feature)"));
        }
        let mut gather: Option<Vec<(String, Option<String>)>> = None;
        if want_main && !matches!(b.get("gather"), None | Some(Value::Null)) {
            let Some(Value::Array(items)) = b.get("gather") else { return Err(bad("gather must list { id, group } entries")) };
            let text = |v: Option<&Value>| v.and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty()).map(str::to_string);
            gather = Some(items.iter().filter_map(|x| text(x.get("id")).map(|id| (id, text(x.get("group"))))).collect());
        }
        let rights = who.rights(req.run.as_deref(), req.huddle, slug, None)?;
        let mut part_of = b.get("partOf").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        if let Some(po) = &part_of
            && self.tickets.get(slug, po).is_none()
        {
            return Err(bad(format!("ticket {po} not found (partOf)")));
        }
        let mut part_of_via = match (&part_of, &from_run) {
            (Some(po), Some((rs, rid))) if rs == slug && rid == po => Some("chat"),
            _ => None,
        };
        let own_run = match &from_run {
            Some((rs, rid)) if rs == slug && !rid.is_empty() && !req.huddle => self.tickets.get(slug, rid),
            _ => None,
        };
        // Where a run's ticket went instead of the partOf it asked for, and why: told to the run in the reply.
        let mut placed: Vec<String> = Vec::new();
        if let (Some(asked), Some(_), false) = (part_of.clone(), &from_run, want_main) {
            use crate::families::rules::{MAX_LEVEL, fit_parent, groups_of, is_feature};
            use crate::index::family::feature_root;
            let all = self.tickets.list(slug);
            let top = feature_root(&all, &asked);
            // From a run, partOf is any ticket of the run's own feature, or another open feature's top or group.
            let own_family = own_run.as_ref().is_some_and(|o| top.is_some() && feature_root(&all, &o.id) == top);
            let feature = top.is_some_and(|t| is_feature(&all, all.at(t)) && (all.at(t).id == asked || groups_of(&all, &all.at(t).id).into_iter().any(|g| all.at(g).id == asked)));
            if part_of_via.is_none() && !own_family && !feature {
                (part_of, part_of_via) = match &own_run {
                    Some(o) => (Some(o.id.clone()), Some("chat")),
                    None => (None, None),
                };
                let to = own_run.as_ref().map(|o| format!("under this run's own ticket {}", o.id)).unwrap_or_else(|| "to the top level".into());
                placed.push(format!("partOf {asked} isn't in this run's own feature or an open feature's top ticket or group, so the ticket went {to} instead."));
            }
            if let Some(po) = part_of.clone() {
                let fit = fit_parent(&all, &po);
                if fit != po {
                    let title = all.get(&fit).map(|t| t.title.clone()).unwrap_or_default();
                    placed.push(format!("Under {po} it would be more than {MAX_LEVEL} levels deep, so it went under {fit} (\"{title}\") instead."));
                    part_of_via = if own_run.as_ref().is_some_and(|o| o.id == fit) { Some("chat") } else { None };
                    part_of = Some(fit);
                }
            }
        }
        // A ticket a run makes inside its own main ticket's family is a tool ticket of the nearest ticket above it that
        // runs steps (a group or round, else the main ticket).
        let mut step_of: Option<Arc<Tk>> = None;
        if let (false, Some(po), Some(o)) = (want_main, &part_of, &own_run)
            && rights.planner.as_ref().is_none_or(|p| is_manager(p))
        {
            use crate::families::rules::{MAX_LEVEL, level_of};
            let all = self.tickets.list(slug);
            if let Some(at) = self.tickets.get(slug, po) {
                let main = self.tickets.main_of(slug, &at);
                if let Some(main) = main.filter(|m| self.tickets.main_of(slug, o).is_some_and(|om| om.id == m.id)) {
                    let mut pick = main.clone();
                    let mut cur = Some(at.clone());
                    let mut n = 0;
                    while let Some(c) = cur.filter(|c| c.id != main.id && n < 50) {
                        if is_manager(&c) && level_of(&all, &c.id) < MAX_LEVEL {
                            pick = c.clone();
                            break;
                        }
                        cur = c.parent_link().and_then(|(p, _)| all.get(p).cloned());
                        n += 1;
                    }
                    if pick.id != o.id {
                        placed.push(format!("It is a tool ticket of {} (\"{}\"): the board starts it on its own and its result goes there.", pick.id, pick.title));
                    }
                    step_of = Some(pick);
                }
            }
        }
        let planner = if want_main { None } else { step_of.clone().or_else(|| rights.planner.clone()) };
        let runner = rights.runner.clone().or_else(|| if want_main { rights.planner.clone() } else { None });
        let mut status = b.get("status").and_then(Value::as_str).filter(|s| STATUSES.contains(s)).unwrap_or("backlog").to_string();
        let mut mode = if b.get("mode").and_then(Value::as_str) == Some("auto") { "auto" } else { "interview" }.to_string();
        let mut parent_id = b.get("parentId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let plan_key = b.get("planKey").and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty()).map(str::to_string);
        let depends_on = strings(b.get("dependsOn"));
        let needs = strings(b.get("needs"));
        let tags = strings(b.get("tags"));
        if parent_id.is_some() && planner.is_none() {
            return Err(bad(
                "a ticket can't be created under another one: planned tickets are retired. Create it on its own (a new ticket is a main ticket that splits its work into tasks), or with partOf to put it in a feature",
            ));
        }
        if let Some(pl) = &planner {
            let list = self.tickets.list(slug);
            let kids: Vec<&Arc<Tk>> = list.tickets.iter().filter(|c| c.parent_id.as_deref() == Some(pl.id.as_str())).collect();
            let missing: Vec<&String> = depends_on
                .iter()
                .flatten()
                .filter(|d| !kids.iter().any(|k| k.id == **d || k.get("planKey").and_then(Value::as_str) == Some(d.as_str())))
                .collect();
            if !missing.is_empty() {
                let names: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
                return Err(bad(format!("unknown dependency {}: use a sibling's ticket id or key", names.join(", "))));
            }
            parent_id = Some(pl.id.clone());
            status = "backlog".into();
            mode = "auto".into();
        }
        let tool = planner.is_some();
        if let Some(pid) = &parent_id
            && self.tickets.get(slug, pid).is_none()
        {
            return Err(bad(format!("parent ticket {pid} not found")));
        }
        let kind = match b.get("kind") {
            None | Some(Value::Null) => None,
            Some(Value::String(k)) if TICKET_KINDS.contains(&k.as_str()) => Some(k.clone()),
            Some(_) => return Err(bad(format!("kind must be one of {}", TICKET_KINDS.join(", ")))),
        };
        check_model_effort(&b)?;
        let defaults = if tool { kind_defaults(kind.as_deref(), self.profile(slug).as_ref().and_then(|p| p.get("taskModels"))) } else { None };
        let model = b.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).or_else(|| defaults.as_ref().map(|d| d.0.clone()));
        let effort = b.get("effort").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).or_else(|| defaults.as_ref().map(|d| d.1.clone()));
        let run_ticket = match &from_run {
            Some((rs, rid)) if rs == slug && !rid.is_empty() && !req.huddle => self.tickets.get(slug, rid),
            _ => None,
        };
        let raised_by = run_ticket.as_ref().and_then(|r| {
            r.get("scheduleId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| json!({ "scheduleId": s, "ticketId": r.id }))
        });
        let starts = starts_run(Some(&status));
        let started_by = match (&runner, &rights.guest) {
            (Some(r), _) if starts => Some(who.run_start(slug, r, None)?),
            (None, Some(g)) if starts => Some(who.guest_start(g, None)?),
            _ => None,
        };
        let session = b.get("sessionId").filter(|v| truthy(Some(v))).cloned();
        let main = want_main || (from_run.is_none() && parent_id.is_none() && part_of.is_none() && session.is_none());
        let main_ticket = planner.as_ref().and_then(|pl| self.tickets.main_of(slug, pl));
        let start_from = if tool {
            main_ticket.as_ref().filter(|m| truthy(m.get("worktree"))).and_then(|m| m.get("branch").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string))
        } else {
            None
        };
        let mut input = Map::new();
        input.insert("title".into(), title.into());
        input.insert("body".into(), js_string(b.get("body"), "").into());
        input.insert("status".into(), if session.is_some() && planner.is_none() { "backlog".into() } else { status.clone().into() });
        input.insert("mode".into(), mode.into());
        let put_opt = |input: &mut Map<String, Value>, k: &str, v: Option<String>| {
            if let Some(v) = v {
                input.insert(k.into(), v.into());
            }
        };
        put_opt(&mut input, "parentId", parent_id.clone());
        put_opt(&mut input, "planKey", plan_key);
        for (k, v) in [("dependsOn", &depends_on), ("needs", &needs), ("tags", &tags)] {
            if let Some(v) = v {
                input.insert(k.into(), json!(v));
            }
        }
        input.insert("important".into(), Value::Bool(b.get("important") == Some(&Value::Bool(true))));
        if let Some(po) = part_of.clone().filter(|_| !tool) {
            input.insert("partOf".into(), po.into());
            if let Some(via) = part_of_via {
                input.insert("partOfVia".into(), via.into());
            }
        }
        if let Some(r) = raised_by {
            input.insert("raisedBy".into(), r);
        }
        put_opt(&mut input, "kind", kind);
        put_opt(&mut input, "model", model);
        put_opt(&mut input, "effort", effort);
        if main {
            input.insert("main".into(), true.into());
        }
        if tool {
            input.insert("tool".into(), true.into());
        }
        put_opt(&mut input, "startFrom", start_from);
        let t = self.tickets.create(slug, input).map_err(|(s, e)| (if s == 500 { 500 } else { 400 }, e))?;
        let tid = t.id.clone();
        if let Some(pl) = &planner {
            self.tickets.note(slug, &tid, &format!("Tool ticket of {} (\"{}\").", pl.id, pl.title));
        }
        let mut plan_paused = false;
        if let Some(pl) = &planner {
            let top = main_ticket.clone().unwrap_or_else(|| pl.clone());
            plan_paused = self.tickets.get(slug, &top.id).and_then(|x| x.get("plan").and_then(|p| p.get("state")).and_then(Value::as_str).map(|s| s == "paused")).unwrap_or(false);
            plan_paused = self.hooks().new_step(slug, &pl.id, pl.main) || plan_paused;
        }
        if let Some(r) = &rights.requester {
            self.tickets.note(slug, &tid, &format!("Created {}.", Who::by_request(r)));
        }
        if let Some(r) = &runner {
            self.tickets.note(slug, &tid, &format!("Created {}.", Who::by_run(r)));
        }
        if let Some(g) = &rights.guest {
            self.tickets.note(slug, &tid, &format!("Created {}.", who.by_guest(g)));
        }
        if let (Some(via), Some(po)) = (part_of_via, &part_of)
            && via == "chat"
        {
            let ptitle = self.tickets.get(slug, po).map(|p| p.title.clone()).unwrap_or_default();
            self.tickets.note(slug, &tid, &format!("Linked as part of {po} (\"{ptitle}\"), the ticket whose chat created it."));
        }
        if let Some(by) = started_by {
            self.tickets.mark_started_by(slug, &tid, Some(by));
        }
        if want_main && from_run.is_some() {
            self.tickets.note(slug, &tid, "Created as a main ticket at the user's request.");
        }
        let mut gathered: Option<Value> = None;
        if let Some(items) = gather.filter(|g| !g.is_empty()) {
            let new_group = b.get("newGroup").and_then(Value::as_str);
            gathered = Some(match block(self.hooks().gather(slug, &tid, &items, new_group)) {
                Ok(v) => v,
                Err(e) => json!({
                    "gathered": [], "movedUp": [],
                    "skipped": items.iter().map(|(id, _)| json!({ "id": id, "reason": e })).collect::<Vec<_>>(), "group": null,
                }),
            });
        }
        if from_run.is_none() && parent_id.is_none() && part_of.is_none() {
            self.hooks().suggest_parent(slug, &tid);
        }
        if let Some(sid) = session.filter(|_| planner.is_none()) {
            let linked = block(self.hooks().link_session(slug, &tid, &js_string(Some(&sid), "")));
            let r = linked.and_then(|()| {
                let mut p = Map::new();
                p.insert("status".into(), status.clone().into());
                self.tickets.update(slug, &tid, &p, true).map(|_| ()).map_err(|(_, e)| e)
            });
            if let Err(e) = r {
                let _ = self.tickets.delete(slug, &tid);
                return Err(bad(e));
            }
        }
        let mut out = match self.view_now(slug, &tid) {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Some(g) = gathered {
            out.insert("gather".into(), g);
        }
        if plan_paused {
            out.insert("planPaused".into(), true.into());
        }
        if !placed.is_empty() {
            out.insert("note".into(), placed.join(" ").into());
        }
        Ok(Reply::Json(201, Value::Object(out)))
    }

    /// `PATCH /api/profiles/:p/tickets/:id`.
    fn patch(&self, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
        let b = body_obj(req)?;
        if let Some(st) = b.get("status").filter(|v| !v.is_null())
            && !st.as_str().is_some_and(|s| STATUSES.contains(&s))
        {
            return Err(bad(format!("invalid status {}", js_string(Some(st), ""))));
        }
        let target = self.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
        let own = req.run.as_deref() == Some(format!("{slug}/{id}").as_str()) && !req.huddle;
        let only_own = !b.is_empty() && b.keys().all(|k| k == "important" || k == "suggestedTags");
        let status_in = b.get("status").and_then(Value::as_str);
        if own && b.len() == 1 && status_in.is_some_and(|s| SELF_MOVES.contains(&s)) && self.hooks().request_self_move(slug, id, status_in.unwrap_or("")) {
            let mut v = match self.view(slug, &target) {
                Value::Object(m) => m,
                _ => Map::new(),
            };
            v.insert("selfMove".into(), status_in.unwrap_or("").into());
            return Ok(Reply::Json(200, Value::Object(v)));
        }
        let who = self.who();
        let rights = if own && only_own { Rights::default() } else { who.rights(req.run.as_deref(), req.huddle, slug, Some(&target))? };
        let mut patch = Map::new();
        for k in ["dependsOn", "needs", "tags", "suggestedTags"] {
            if let Some(v) = strings(b.get(k)) {
                patch.insert(k.into(), json!(v));
            }
        }
        match b.get("parentId") {
            Some(Value::Null) => {
                patch.insert("parentId".into(), Value::Null);
            }
            None => {}
            Some(_) => return Err(bad("parentId can only be cleared (null); use adopt to add a ticket to a plan")),
        }
        if let Some(po) = b.get("partOf")
            && !po.is_null()
            && !po.as_str().is_some_and(|s| !s.is_empty())
        {
            return Err(bad("partOf must be a ticket id or null"));
        }
        if b.get("parentSuggestion").is_some_and(|v| !v.is_null()) {
            return Err(bad("parentSuggestion can only be cleared (null)"));
        }
        if b.get("showOnBoard").is_some_and(|v| !v.is_boolean()) {
            return Err(bad("showOnBoard must be true or false"));
        }
        let link_only = !b.is_empty() && b.keys().all(|k| k == "partOf" || k == "parentSuggestion" || k == "showOnBoard");
        if let Some(mo) = b.get("mode").and_then(Value::as_str).filter(|m| *m == "auto" || *m == "interview") {
            patch.insert("mode".into(), mo.into());
        }
        for k in ["expectedBody", "title", "body"] {
            if let Some(Value::String(s)) = b.get(k) {
                patch.insert(k.into(), s.clone().into());
            }
        }
        if truthy(b.get("status")) {
            patch.insert("status".into(), b["status"].clone());
        }
        let working = |s: Option<&str>| matches!(s, Some("ready" | "in_progress"));
        let new_status = patch.get("status").and_then(Value::as_str).map(str::to_string);
        if working(new_status.as_deref()) && !working(Some(&target.status)) && self.hooks().huddle_live(slug, id)
            && let Some(r) = parallel_work(req, &b)
        {
            return Ok(r);
        }
        if let Some(o) = b.get("order").filter(|o| o.is_number()) {
            patch.insert("order".into(), o.clone());
        }
        if b.get("notice") == Some(&Value::Null) {
            patch.insert("notice".into(), Value::Null);
        }
        for k in ["important", "pinned"] {
            if let Some(v) = b.get(k) {
                if !v.is_boolean() {
                    return Err(bad(format!("{k} must be true or false")));
                }
                patch.insert(k.into(), v.clone());
            }
        }
        if let Some(cap) = b.get("runCapUsd") {
            if req.run.is_some() {
                return Err((403, "only the user can change a ticket's spending cap".into()));
            }
            patch.insert("runCapUsd".into(), cap_value(cap, true)?);
        }
        if (b.contains_key("model") || b.contains_key("effort") || b.contains_key("ultracode")) && req.run.is_some() {
            return Err((403, "only the user can change a ticket's model or effort".into()));
        }
        if b.contains_key("chrome") || b.contains_key("browsers") {
            if req.run.is_some() || req.huddle {
                return Err((403, "only the user picks a ticket's browsers".into()));
            }
            if b.contains_key("browsers") {
                self.user_only(req, "Choosing a ticket's browsers")?;
            }
            let (chrome, browsers) = self.hooks().browsers(b.get("browsers"), b.get("chrome"))?;
            if b.contains_key("browsers") {
                patch.insert("browsers".into(), browsers);
                patch.insert("chrome".into(), chrome);
            } else {
                patch.insert("chrome".into(), chrome);
                patch.insert("browsers".into(), browsers);
            }
        }
        if let Some(u) = b.get("ultracode") {
            if !u.is_null() && !u.is_boolean() {
                return Err(bad("ultracode must be true, false or null"));
            }
            patch.insert("ultracode".into(), u.clone());
            if target.get("effort").and_then(Value::as_str) == Some("ultracode") && !b.contains_key("effort") {
                patch.insert("effort".into(), "xhigh".into());
            }
        }
        check_model_effort(&b)?;
        if let Some(mo) = b.get("model") {
            patch.insert("model".into(), mo.clone());
        }
        if let Some(e) = b.get("effort") {
            patch.insert("effort".into(), e.clone());
        }
        if rights.any() {
            patch.shift_remove("order");
            patch.shift_remove("notice");
        }
        let run_or_guest = rights.runner.is_some() || rights.guest.is_some();
        if run_or_guest && new_status.as_deref() == Some("done") && target.status != "done" {
            if self.tickets.runs.is_running(slug, id) {
                return Err((409, format!("{id} is working right now: stop it first with stop_ticket, or leave closing it to the user")));
            }
            if !truthy(target.get("workdir"))
                && let Some(wt) = target.get("worktree").and_then(Value::as_str).filter(|s| !s.is_empty())
                && has_uncommitted_changes(wt)
            {
                return Err((
                    409,
                    format!(
                        "{id} has changes in its copy of the folder that aren't saved in its version history yet; moving it to done could lose them, so only the user can close it (on the board)"
                    ),
                ));
            }
        }
        let mut started_by: Option<Option<Value>> = None;
        if starts_run(new_status.as_deref()) && new_status.as_deref() != Some(target.status.as_str()) {
            if let Some(r) = &rights.runner {
                started_by = Some(Some(who.run_start(slug, r, Some(id))?));
            } else if let Some(g) = &rights.guest {
                started_by = Some(Some(who.guest_start(g, Some(id))?));
            } else if rights.planner.is_none() {
                started_by = Some(None);
            }
        }
        if let Some(pl) = &rights.planner
            && new_status.as_deref() == Some("ready")
            && target.status != "ready"
            && target.get("runCount").and_then(Value::as_f64).is_some_and(|n| n > 0.0)
        {
            self.count_retry(slug, &pl.id, id)?;
        }
        let mut t = target.clone();
        let hooks = self.hooks();
        if let Some(po) = b.get("partOf") {
            // null unlinks; any other value is looked up as a ticket id, as Bun's setPartOf does ("ticket 123 not found").
            let parent = match po {
                Value::Null => None,
                Value::String(s) => Some(s.as_str()),
                other => return Err(bad(format!("ticket {} not found", crate::runs::js::to_string(other)))),
            };
            block(hooks.set_part_of(slug, id, parent)).map_err(bad)?;
            t = self.tickets.get(slug, id).unwrap_or(t);
        } else if b.get("parentSuggestion") == Some(&Value::Null) {
            let mut p = Map::new();
            p.insert("parentSuggestion".into(), Value::Null);
            p.insert("parentChecked".into(), true.into());
            t = self.tickets.patch(slug, id, p).map_err(|(_, e)| bad(e))?;
        }
        if let Some(Value::Bool(on)) = b.get("showOnBoard")
            && (!b.contains_key("partOf") || t.tool)
        {
            t = self.set_show_on_board(slug, id, *on)?;
        }
        if !link_only {
            t = self.tickets.update(slug, id, &patch, req.run.is_none()).map_err(|(s, e)| (if s == 409 { 409 } else { 400 }, e))?;
        }
        if let Some(by) = &started_by {
            self.tickets.mark_started_by(slug, id, by.clone());
        }
        let important = |x: &Tk| truthy(x.get("important"));
        if own && only_own && important(&target) != important(&t) {
            self.tickets.note(slug, id, if important(&t) { "Claude marked this ticket ⭐ Important." } else { "Claude cleared ⭐ Important." });
        }
        let changer = rights.planner.is_some() || rights.requester.is_some() || rights.runner.is_some() || rights.guest.is_some();
        if changer {
            let what: Vec<String> = patch
                .iter()
                .map(|(k, v)| match k.as_str() {
                    "status" => format!("moved it to {}", js_string(Some(v), "")),
                    "parentId" => format!("released it from plan {}", js_string(target.get("parentId"), "undefined")),
                    "important" => if truthy(Some(v)) { "marked it ⭐ Important".into() } else { "cleared ⭐ Important".into() },
                    "pinned" => if truthy(Some(v)) { "pinned it".into() } else { "unpinned it".into() },
                    _ => format!("changed {k}"),
                })
                .collect();
            let what = what.join(", ");
            let by = if rights.planner.is_some() {
                String::new()
            } else if let Some(r) = &rights.requester {
                Who::by_request(r)
            } else if let Some(r) = &rights.runner {
                Who::by_run(r)
            } else {
                rights.guest.as_ref().map(|g| who.by_guest(g)).unwrap_or_default()
            };
            let was = target.parent_link().map(|(p, _)| p.to_string());
            let linked = match b.get("partOf") {
                None => String::new(),
                Some(po) if po.as_str() == was.as_deref() && (po.is_string() || was.is_none()) => String::new(),
                Some(Value::String(po)) => format!("linked it as part of {po}"),
                Some(_) => format!("unlinked it from {}", was.unwrap_or_else(|| "null".into())),
            };
            let say = |s: &str| {
                if rights.planner.is_some() {
                    format!("Planner {s}.")
                } else {
                    let mut c = s.chars();
                    let first = c.next().map(|f| f.to_uppercase().collect::<String>()).unwrap_or_default();
                    format!("{first}{} {by}.", c.as_str())
                }
            };
            if !linked.is_empty() {
                self.tickets.note(slug, id, &say(&linked));
            }
            if !what.is_empty() {
                self.tickets.note(slug, id, &say(&what));
            }
        }
        let out = if started_by.is_none() { self.view(slug, &t) } else { self.view_now(slug, id) };
        Ok(Reply::Json(200, out))
    }

    /// `countRetry`: the planner restarts a child that already ran, at most `MAX_RETRIES` times.
    fn count_retry(&self, slug: &str, planner: &str, child: &str) -> Result<(), Refusal> {
        if self.tickets.get(slug, planner).is_none_or(|p| !truthy(p.get("plan"))) {
            return Ok(());
        }
        // Counted from the planner's file under the board's lock: two restarts at once both count.
        self.tickets
            .update_with(slug, planner, |meta| {
                let Some(Value::Object(plan)) = meta.get("plan").filter(|v| truthy(Some(v))) else { return Ok(Map::new()) };
                let n = plan.get("retries").and_then(|r| r.get(child)).and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
                if n > super::norm::MAX_RETRIES {
                    return Err((
                        409,
                        format!("retry limit reached: {child} was already restarted 3 times; skip or split it, or end with \"blocked\" for the user"),
                    ));
                }
                let mut plan = plan.clone();
                let mut retries = plan.get("retries").and_then(Value::as_object).cloned().unwrap_or_default();
                retries.insert(child.into(), ckanban_core::jsnum::num(n));
                plan.insert("retries".into(), Value::Object(retries));
                let mut patch = Map::new();
                patch.insert("plan".into(), Value::Object(plan));
                Ok(patch)
            })
            .map(|_| ())
    }

    /// `setShowOnBoard`.
    fn set_show_on_board(&self, slug: &str, id: &str, on: bool) -> Result<Arc<Tk>, Refusal> {
        let t = self.tickets.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))?;
        let one = |k: &str, v: Value| {
            let mut p = Map::new();
            p.insert(k.into(), v);
            p
        };
        if t.tool {
            return self.tickets.patch(slug, id, one("showOnBoard", if on { true.into() } else { Value::Null })).map_err(|(_, e)| bad(e));
        }
        if on {
            return if t.show_false { self.tickets.patch(slug, id, one("showOnBoard", Value::Null)).map_err(|(_, e)| bad(e)) } else { Ok(t) };
        }
        if t.main {
            let sub = if t.parent_link().is_some() { " (a sub-feature)" } else { "" };
            return Err(bad(format!("\"{}\" is a main ticket{sub}: it keeps its own card on the board", t.title)));
        }
        if matches!(t.kind.as_deref(), Some("group" | "round")) {
            return Err(bad(format!("\"{}\" is a group of its feature: it keeps its own card on the board", t.title)));
        }
        let list = self.tickets.list(slug);
        let top = feature_root(&list, id).map(|i| list.at(i).id.clone());
        if !t.hideable_card() || top.is_none() || top.as_deref() == Some(id) {
            return Err(bad(format!(
                "\"{}\" isn't part of a feature: only a task or a card gathered into a feature can be hidden from the board",
                t.title
            )));
        }
        self.tickets.patch(slug, id, one("showOnBoard", false.into())).map_err(|(_, e)| bad(e))
    }

    /// `DELETE /api/profiles/:p/tickets/:id`.
    fn delete(&self, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
        let doomed = self.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
        if req.run.is_some() {
            // A main ticket may delete its own tool tickets; every other delete stays the user's.
            let rights = if doomed.tool { self.who().rights(req.run.as_deref(), req.huddle, slug, Some(&doomed))? } else { Rights::default() };
            if !rights.planner.as_ref().is_some_and(|p| is_manager(p)) {
                return Err((403, "deleting tickets is disabled inside a board run".into()));
            }
        }
        let hooks = self.hooks();
        let main = if doomed.main { Some(doomed.clone()) } else if doomed.tool { self.tickets.main_of(slug, &doomed) } else { None };
        if let Some(m) = main
            && hooks.merging(slug, &m.id)
        {
            return Err((409, "Wait a moment: a merge is running".into()));
        }
        if doomed.main {
            for o in self.tickets.tool_tickets(slug, id) {
                hooks.close_huddles(slug, &o.id);
            }
        }
        hooks.close_huddles(slug, id);
        self.tickets.delete(slug, id).map_err(|(_, e)| (409, e))?;
        Ok(Reply::Empty(204))
    }

    /// `POST .../move`: a Backlog ticket to another board.
    fn move_to(&self, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
        if req.run.is_some() {
            return Err((403, "moving tickets is the user's call, not a run's".into()));
        }
        let b = body_obj(req)?;
        let target = js_string(b.get("board"), "");
        if target.is_empty() || target == "." || target == ".." || target.contains('/') || self.profile(&target).is_none() {
            return Err((404, "board not found".into()));
        }
        let t = self.tickets.move_to(slug, id, &target).map_err(|(_, e)| bad(e))?;
        self.hooks().close_huddles(slug, id);
        Ok(Reply::Json(201, self.view(&target, &t)))
    }

    /// `GET`/`POST .../comments`.
    fn comments(&self, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
        if req.method == "GET" {
            let all = self.tickets.comments(slug, id);
            let last = crate::index::routes::js_number(param(&req.query, "last").as_deref());
            if last <= 0.0 {
                return Ok(Reply::Json(200, Value::Array(all)));
            }
            let before = param(&req.query, "before");
            let n = all.len() as f64;
            let end = match before {
                None => n,
                Some(b) => {
                    let x = crate::index::routes::js_number(Some(&b)).floor();
                    let x = if x.is_nan() { 0.0 } else { x };
                    0f64.max(n.min(x))
                }
            };
            let start = 0f64.max(end - last.min(500.0));
            let page: Vec<Value> = all[start as usize..end as usize].to_vec();
            return Ok(Reply::Json(200, json!({ "comments": page, "earlier": start as usize, "total": all.len() })));
        }
        let b = body_obj(req)?;
        let text = js_trim(&js_string(b.get("text"), "")).to_string();
        if text.is_empty() {
            return Err(bad("text is required"));
        }
        let target = self.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
        let who = self.who();
        let r = who.rights(req.run.as_deref(), req.huddle, slug, Some(&target))?;
        if let Some(runner) = &r.runner {
            let c = self.tickets.add_comment(slug, id, &format!("Note from ticket {} (\"{}\"): {text}", runner.id, runner.title), Some(&runner.id))?;
            return Ok(Reply::Json(201, c));
        }
        let by = if r.planner.is_some() {
            "Planner: ".to_string()
        } else if let Some(q) = &r.requester {
            format!("From the Planning chat of {} (user request): ", q.id)
        } else if let Some(g) = &r.guest {
            format!("From the chat of {} on {} (user request): ", g.ticket.id, who.board_name(&g.slug))
        } else {
            String::new()
        };
        let c = self.tickets.add_comment(slug, id, &format!("{by}{text}"), None)?;
        Ok(Reply::Json(201, c))
    }

    /// `POST`/`DELETE .../snooze`: the Inbox's snooze.
    fn snooze(&self, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
        if req.run.is_some() {
            return Err((403, "snoozing is the user's, not a board run's".into()));
        }
        let one = |v: Value| {
            let mut p = Map::new();
            p.insert("snooze".into(), v);
            p
        };
        if req.method == "DELETE" {
            let t = self.tickets.patch(slug, id, one(Value::Null))?;
            return Ok(Reply::Json(200, self.view(slug, &t)));
        }
        let b = body_obj(req)?;
        let forever = b.get("forever") == Some(&Value::Bool(true));
        let hours = match b.get("hours") {
            None => SNOOZE_HOURS,
            Some(v) => js_to_number(v),
        };
        if !forever && !(hours > 0.0 && hours <= 24.0 * 30.0) {
            return Err(bad("hours must be between 0 and 720"));
        }
        let t = self.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
        let live = &*self.reads.live;
        let session = t.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()).and_then(|s| live.session(s));
        let host = live.host(slug, id);
        let list = self.tickets.list(slug);
        let root = self.root();
        let a = ticket_attention(&list, &t, session.as_ref(), live.running(slug, id), host.as_ref(), &|x| live.running(slug, x), &|| {
            schedule_ids(&root, slug)
        });
        let Some(a) = a else { return Err((409, "this ticket doesn't need you, nothing to snooze".into())) };
        let until = if forever {
            SNOOZE_FOREVER.to_string()
        } else {
            ckanban_core::time::iso(ckanban_core::time::now_ms() + hours * 3_600_000.0)
        };
        let key = snooze_key(&t, session.as_ref(), &a, host.as_ref());
        let t = self.tickets.patch(slug, id, one(json!({ "until": until, "key": key })))?;
        Ok(Reply::Json(200, self.view(slug, &t)))
    }

    /// `POST .../seen`: the user opened the ticket (`markSeen`, at most every 5 minutes). Opening it stops its
    /// helper reminders (`notifier.opened`); a pending reminder skips the 5-minute throttle.
    fn seen(&self, req: &Req, slug: &str, id: &str) -> Result<Reply, Refusal> {
        if req.run.is_some() {
            return Err((403, "only the user's board marks a ticket seen".into()));
        }
        let reminded = self.opened.get().is_some_and(|f| f(slug, id));
        if reminded {
            self.tickets.bus.emit_json(serde_json::json!({ "type": "helper.updated" }));
        }
        let t = self.tickets.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))?;
        let now_ms = ckanban_core::time::now_ms();
        let recent = !reminded && t.get("seenAt").and_then(Value::as_str).and_then(ckanban_core::time::parse_date).is_some_and(|at| now_ms - at < 5.0 * 60_000.0);
        let t = if recent {
            t
        } else {
            let mut p = Map::new();
            p.insert("seenAt".into(), ckanban_core::time::iso(now_ms).into());
            self.tickets.patch(slug, id, p)?
        };
        Ok(Reply::Json(200, self.view(slug, &t)))
    }

    // ---- The chat's cards ----

    fn card(&self, req: &Req, slug: &str, id: &str, card: &str, uuid: &str) -> Result<Reply, Refusal> {
        // The card's answer is merged into the ticket's map under the board's lock (two answers at once both stay).
        let put = |_: &Tk, field: &str, value: Value| -> Result<Reply, Refusal> {
            let t = self.tickets.set_entry(slug, id, field, uuid, value)?;
            Ok(Reply::Json(200, self.view(slug, &t)))
        };
        let current = || self.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")));
        match card {
            "automation-cards" => {
                self.user_only(req, "Answering an automation card")?;
                let b = body_obj(req)?;
                let loop_id = js_string(b.get("loopId"), "");
                let exists = DataDir::new(self.root()).loop_file(slug, &loop_id).is_some_and(|f| f.is_file());
                if !exists {
                    return Err(bad("that automation doesn't exist"));
                }
                put(current()?.as_ref(), "automationCards", json!({ "loopId": loop_id, "at": now() }))
            }
            "squad-cards" | "teammate-cards" => {
                if req.run.is_some() || req.huddle {
                    let what = if card == "squad-cards" { "squad" } else { "teammate" };
                    return Err((403, format!("only the user answers {what} cards")));
                }
                let b = body_obj(req)?;
                let state = b.get("state").and_then(Value::as_str);
                if !matches!(state, Some("saved" | "dismissed")) {
                    return Err(bad("state must be saved or dismissed"));
                }
                let scope = b.get("scope");
                if scope.is_some_and(|s| !matches!(s.as_str(), Some("global" | "board"))) {
                    return Err(bad("scope must be global or board"));
                }
                let mut c = Map::new();
                c.insert("state".into(), state.unwrap_or("").into());
                c.insert("at".into(), now().into());
                if state == Some("saved") {
                    if let Some(n) = b.get("name").and_then(Value::as_str).map(js_trim).filter(|s| !s.is_empty()) {
                        c.insert("name".into(), n.into());
                    }
                    if let Some(s) = scope.filter(|s| truthy(Some(s))) {
                        c.insert("scope".into(), s.clone());
                    }
                }
                let field = if card == "squad-cards" { "squadCards" } else { "teammateCards" };
                put(current()?.as_ref(), field, Value::Object(c))
            }
            "closed-forms" => {
                self.user_only(req, "Closing a question")?;
                if uuid.is_empty() || uuid.encode_utf16().count() > 200 {
                    return Err(bad("the question's id is missing"));
                }
                let t = self.hooks().closes_form(slug, id, uuid).map_err(|(s, e)| (if s == 409 { 409 } else { 404 }, e))?;
                let t = Tk::from_json(t, false);
                self.tickets.emit(slug, &t);
                Ok(Reply::Json(200, self.view(slug, &t)))
            }
            "schedule-delete-cards" => {
                self.user_only(req, "Deleting a schedule")?;
                if uuid.is_empty() || uuid.encode_utf16().count() > 200 {
                    return Err(bad("the card's id is missing"));
                }
                let b = body_obj(req)?;
                let state = b.get("state").and_then(Value::as_str);
                if !matches!(state, Some("deleted" | "kept")) {
                    return Err(bad("state must be deleted or kept"));
                }
                let t = current()?;
                if let Some(done) = t.get("scheduleDeleteCards").and_then(|c| c.get(uuid)).filter(|v| truthy(Some(v))) {
                    let msg = if done.get("state").and_then(Value::as_str) == Some("deleted") {
                        "this schedule was already deleted from this card"
                    } else {
                        "this card was already answered"
                    };
                    return Err((409, msg.into()));
                }
                let mut c = Map::new();
                c.insert("state".into(), state.unwrap_or("").into());
                c.insert("at".into(), now().into());
                if state == Some("deleted") {
                    let sid = b.get("scheduleId").and_then(Value::as_str).unwrap_or("");
                    let name = if sid.is_empty() { None } else { self.hooks().remove_schedule(slug, sid).map_err(|e| (409, e))? };
                    let Some(name) = name else { return Err((404, "This schedule is no longer on the board.".into())) };
                    if !name.is_empty() {
                        c.insert("name".into(), name.into());
                        c.insert("scheduleId".into(), sid.into());
                    }
                }
                put(current()?.as_ref(), "scheduleDeleteCards", Value::Object(c))
            }
            "helper-rule-cards" => {
                self.user_only(req, "Adding to what the helper knows about you")?;
                if uuid.is_empty() || uuid.encode_utf16().count() > 200 {
                    return Err(bad("the card's id is missing"));
                }
                let b = body_obj(req)?;
                let state = b.get("state").and_then(Value::as_str);
                if !matches!(state, Some("added" | "dismissed")) {
                    return Err(bad("state must be added or dismissed"));
                }
                let t = current()?;
                let rule = self.chat_entry(&t, uuid, "helperRule").and_then(|r| r.get("text").and_then(Value::as_str).map(str::to_string));
                let Some(rule) = rule else { return Err((404, "This suggestion isn't in this ticket's chat.".into())) };
                if let Some(done) = t.get("helperRuleCards").and_then(|c| c.get(uuid)).filter(|v| truthy(Some(v))) {
                    let msg = if done.get("state").and_then(Value::as_str) == Some("added") {
                        "This line was already added from this card."
                    } else {
                        "This card was already answered."
                    };
                    return Err((409, msg.into()));
                }
                let mut c = json!({ "state": "dismissed", "at": now() });
                if state == Some("added") {
                    if b.get("text").and_then(Value::as_str) != Some(rule.as_str()) {
                        return Err((409, "This suggestion changed since the card was shown; reload the chat and check it again.".into()));
                    }
                    if t.hidden_tool() {
                        return Err((403, "This suggestion came from a step working in the background; ask in the main chat instead.".into()));
                    }
                    let already = block(self.hooks().helper_rule(&rule))?;
                    c = json!({ "state": "added", "at": now(), "text": rule });
                    if already {
                        c["already"] = true.into();
                    }
                }
                put(current()?.as_ref(), "helperRuleCards", c)
            }
            "key-cards" => self.key_card(req, slug, id, uuid),
            _ => Err((404, "not found".into())),
        }
    }

    /// The chat entry `uuid` that carries `field` (a key box, a helper rule), in any of the ticket's sessions.
    fn chat_entry(&self, t: &Tk, uuid: &str, field: &str) -> Option<Value> {
        let mut sids: Vec<String> = match t.get("earlierSessions") {
            Some(Value::Array(a)) => a.iter().filter_map(|s| s.get("sessionId").and_then(Value::as_str).map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        if let Some(s) = t.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            sids.push(s.to_string());
        }
        sids.iter()
            .flat_map(|s| self.sessions.entries(s))
            .find(|e| e.get("uuid").and_then(Value::as_str) == Some(uuid) && truthy(e.get(field)))
            .and_then(|e| e.get(field).cloned())
    }

    /// `POST .../key-cards/<box>`: the user's keys saved for the board, then the ticket goes on in a new run.
    fn key_card(&self, req: &Req, slug: &str, id: &str, uuid: &str) -> Result<Reply, Refusal> {
        self.user_only(req, "Saving keys")?;
        let flight = format!("{slug}/{id}/{uuid}");
        if !self.in_flight.lock().insert(flight.clone()) {
            return Err((409, "These keys are being saved already".into()));
        }
        struct Release<'a>(&'a Writes, String);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                self.0.in_flight.lock().remove(&self.1);
            }
        }
        let _release = Release(self, flight);
        let t = self.tickets.get(slug, id).ok_or_else(|| (404, format!("ticket {id} not found")))?;
        if t.get("keyCards").and_then(|c| c.get(uuid)).is_some_and(|v| truthy(Some(v))) {
            return Err((409, "This key box was already answered".into()));
        }
        let Some(ask) = self.chat_entry(&t, uuid, "keys") else { return Err((404, "That key box isn't in this chat any more".into())) };
        let b = body_obj(req)?;
        let self_ = b.get("self") == Some(&Value::Bool(true));
        let given = b.get("keys").and_then(Value::as_object).cloned().unwrap_or_default();
        let asked: Vec<(String, Value)> = match ask.get("keys") {
            Some(Value::Array(a)) => {
                a.iter().filter_map(|k| Some((k.get("envName")?.as_str()?.to_string(), k.get("label").cloned().unwrap_or(Value::Null)))).collect()
            }
            _ => Vec::new(),
        };
        let input: Vec<(String, Option<Value>, Value)> = if self_ {
            Vec::new()
        } else {
            asked
                .iter()
                .filter_map(|(env, label)| match given.get(env) {
                    Some(Value::String(v)) if !js_trim(v).is_empty() => Some((env.clone(), Some(label.clone()), Value::String(v.clone()))),
                    _ => None,
                })
                .collect()
        };
        if !self_ && input.is_empty() {
            return Err(bad("Paste at least one key, or pick \"I'll do it myself\""));
        }
        let saved = (self.save_keys)(slug, &input)?;
        let mark = || -> Result<(), Refusal> {
            let mut c = Map::new();
            c.insert("saved".into(), json!(saved));
            if self_ {
                c.insert("self".into(), true.into());
            }
            c.insert("at".into(), now().into());
            self.tickets.set_entry(slug, id, "keyCards", uuid, Value::Object(c)).map(|_| ())
        };
        let text = keys_answer_text(&asked, &saved, self_);
        if let Err(e) = block(self.hooks().chat_next_run(slug, id, &text)) {
            if saved.is_empty() {
                return Err((500, e));
            }
            mark()?;
            let what = if saved.len() == 1 { "key is" } else { "keys are" };
            return Err((409, format!("The {what} saved, but Claude couldn't be told right now ({e}). Send it a message to carry on.")));
        }
        mark()?;
        Ok(Reply::Json(202, self.view_now(slug, id)))
    }

    // ---- Attachments, avatars, snippets ----

    fn attachments(&self, req: &Req, p: &[&str]) -> Reply {
        let dir = files::attachments_dir(&self.root());
        if req.method == "POST" {
            if !files::is_image_type(&req.content_type) && req.content_type != "application/octet-stream" {
                return err((415, files::UNSUPPORTED.into()));
            }
            let name = req.file_name.as_deref().filter(|n| !n.is_empty());
            return match files::save_attachment(&dir, files::upload_ext(&req.content_type, name).as_deref(), &req.body) {
                Ok(n) => Reply::Json(201, json!({ "url": format!("/api/attachments/{n}"), "path": dir.join(&n).to_string_lossy() })),
                Err(e) => err(e),
            };
        }
        let Some(file) = files::attachment_file(&dir, p[1]) else { return err((404, "attachment not found".into())) };
        if p.len() == 3 {
            let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
            return Reply::Json(200, json!({ "size": size }));
        }
        let shown = param(&req.query, "name");
        let download = req.query.split('&').any(|kv| kv.split('=').next() == Some("download")) || !files::opens_inline(p[1]);
        let mut headers = vec![
            ("content-type".to_string(), files::attachment_type(p[1]).unwrap_or("text/plain; charset=utf-8").to_string()),
            ("x-content-type-options".into(), "nosniff".into()),
            ("content-security-policy".into(), "sandbox".into()),
            ("cache-control".into(), "private, max-age=31536000, immutable".into()),
        ];
        if download || shown.is_some() {
            let disposition = files::attachment_header(&match &shown {
                Some(s) => files::clean_file_name(s),
                None => p[1].to_string(),
            });
            let d = if download { disposition } else { disposition.replacen("attachment", "inline", 1) };
            headers.push(("content-disposition".into(), d));
        }
        Reply::File(file, headers)
    }

    fn avatars(&self, req: &Req, p: &[&str]) -> Reply {
        let root = self.root();
        if req.method == "GET" {
            return Reply::Json(200, Value::Object(files::list_avatars(&root)));
        }
        if req.run.is_some() || req.huddle {
            return err((403, "a board or huddle run can't change avatars; ask the user".into()));
        }
        let r = (|| {
            let sent = if req.method == "PUT" { Some(body(req)?) } else { None };
            let map = files::list_avatars(&root);
            let next = if p.len() == 3 {
                let Some(Value::Object(o)) = &sent else { return Err(bad("send {\"name\": \"...\"}")) };
                if !o.contains_key("name") {
                    return Err(bad("send {\"name\": \"...\"}"));
                }
                files::with_claude_name(&map, o.get("name"))?
            } else if req.method == "PUT" {
                files::with_avatar(&map, p[1], sent.as_ref().unwrap_or(&Value::Null))?
            } else {
                files::without_avatar(&map, p[1])
            };
            files::save_avatars(&root, &next)?;
            Ok(files::list_avatars(&root))
        })();
        match r {
            Ok(m) => Reply::Json(200, Value::Object(m)),
            Err(e) => err(e),
        }
    }

    fn snippets(&self, req: &Req, p: &[&str]) -> Reply {
        let root = self.root();
        let bus = &self.tickets.bus;
        let r = match (req.method.as_str(), p.len()) {
            ("GET", 1) => Ok(Reply::Json(200, Value::Array(files::list_snippets(&root, param(&req.query, "profile").as_deref())))),
            ("POST", 1) => body(req).and_then(|b| files::create_snippet(&root, &null_obj(b), bus)).map(|s| Reply::Json(201, s)),
            ("PATCH", 2) => body(req).and_then(|b| files::update_snippet(&root, p[1], &null_obj(b), bus)).map(|s| Reply::Json(200, s)),
            ("DELETE", 2) => files::remove_snippet(&root, p[1], bus).map(|()| Reply::Empty(204)),
            _ => Err((404, "not found".into())),
        };
        r.unwrap_or_else(err)
    }
}

/// `?? {}` for a body that is JSON null.
fn null_obj(v: Value) -> Value {
    if v.is_null() { json!({}) } else { v }
}

/// The model and effort checks of create and PATCH.
fn check_model_effort(b: &Map<String, Value>) -> Result<(), Refusal> {
    if let Some(m) = b.get("model").filter(|v| !v.is_null())
        && !m.as_str().is_some_and(valid_model)
    {
        return Err(bad(format!("\"{}\" is not a model name. Use {}.", js_string(Some(m), ""), model_help())));
    }
    if let Some(e) = b.get("effort").filter(|v| !v.is_null())
        && !e.as_str().is_some_and(valid_effort)
    {
        return Err(bad(format!("\"{}\" is not an effort level. Use {}.", js_string(Some(e), ""), effort_help())));
    }
    Ok(())
}

/// `startsRun`: Ready (In progress queues there) and Planning start a Claude run.
pub fn starts_run(st: Option<&str>) -> bool {
    matches!(st, Some("ready" | "in_progress" | "planning"))
}

/// `parallelWork`: the UI asks "Start anyway?" before a run and a huddle work the same ticket (409 with `confirm`).
fn parallel_work(req: &Req, b: &Map<String, Value>) -> Option<Reply> {
    if req.source.as_deref() != Some("ui") || req.run.is_some() || b.get("confirmParallel") == Some(&Value::Bool(true)) {
        return None;
    }
    Some(Reply::Json(409, json!({ "error": "A huddle is already working on this ticket.", "confirm": "huddle-open" })))
}

/// `Number(v)` for a JSON value.
pub fn js_to_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let t = js_trim(s);
            match t {
                "" => 0.0,
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ if t.len() > 2 && t[..2].eq_ignore_ascii_case("0x") => u64::from_str_radix(&t[2..], 16).map(|n| n as f64).unwrap_or(f64::NAN),
                _ if t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) => t.parse::<f64>().unwrap_or(f64::NAN),
                _ => f64::NAN,
            }
        }
        _ => f64::NAN,
    }
}

/// `capValue`: a spending cap from a request: a positive amount, 0 for none (allow_zero), null for the default.
pub fn cap_value(v: &Value, allow_zero: bool) -> Result<Value, Refusal> {
    if v.is_null() || v.as_str() == Some("") {
        return Ok(Value::Null);
    }
    let n = js_to_number(v);
    if !n.is_finite() || n < 0.0 || (n == 0.0 && !allow_zero) {
        let zero = if allow_zero { ", 0 for none" } else { "" };
        return Err(bad(format!("spending cap must be a positive amount{zero}, or null")));
    }
    Ok(ckanban_core::jsnum::num(n))
}

/// `hasUncommittedChanges`: the folder has changes its version history doesn't hold (or git can't say).
fn has_uncommitted_changes(dir: &str) -> bool {
    if !std::path::Path::new(dir).exists() {
        return false;
    }
    match std::process::Command::new("git").args(["status", "--porcelain"]).current_dir(dir).stdin(std::process::Stdio::null()).output() {
        Ok(o) => !o.status.success() || !String::from_utf8_lossy(&o.stdout).trim().is_empty(),
        Err(_) => true,
    }
}

/// `keysAnswerText`: the message that resumes Claude after a key box was answered (names only, never a value).
pub fn keys_answer_text(asked: &[(String, Value)], saved: &[String], self_: bool) -> String {
    let label = |n: &str| asked.iter().find(|(e, _)| e == n).and_then(|(_, l)| l.as_str().map(str::to_string)).unwrap_or_else(|| n.to_string());
    let list = |names: &[String]| names.iter().map(|n| format!("${n} ({})", label(n))).collect::<Vec<_>>().join(", ");
    let all: Vec<String> = asked.iter().map(|(e, _)| e.clone()).collect();
    if self_ || saved.is_empty() {
        return format!("I'll add {} myself. Carry on without it and tell me what is left for me to do.", list(&all));
    }
    let skipped: Vec<String> = all.iter().filter(|n| !saved.contains(n)).cloned().collect();
    let (it, name) = if saved.len() == 1 { ("It is", "that name") } else { ("They are", "those names") };
    let mut s = format!(
        "Saved on this Mac for this board: {}. {it} in your environment under {name}: place them with commands that use the variable, and never print a value.",
        list(saved)
    );
    if !skipped.is_empty() {
        s.push_str(&format!(" Left empty, not saved: {}.", list(&skipped)));
    }
    s
}
