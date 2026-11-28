//! `Families`: the board's family, plan and feature-status calls (`board-families.ts`, `board-plans.ts`,
//! `board-main.ts` without git and runs, `board-features.ts`), applied through the ticket writes (`Tickets`).
//!
//! What needs a run (waking a main ticket, starting Ready work, a Planning interview, notifications) goes through
//! `PlanRuns`, which the run loop (R7a) fills in; until then its stand-in does nothing, so a plan moves its tool
//! tickets to Ready and records what it would tell its main ticket, and nothing runs. Blocking: call from a blocking
//! thread (the routes and hooks run there).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use parking_lot::{Mutex, ReentrantMutex, RwLock};
use serde_json::{Map, Value, json};

use super::plan::{children, family_sig, finished_line, kid_waits_on_user, or_empty, plan_problem, plan_step, progress_step, stuck_cleared, wake_table, REPORT_FILE, RESULTS_KEEP};
use super::rules::{MAX_LEVEL, Moved, groups_of, is_feature, link_problem, next_round_title, subtree_ids, would_loop, without_plan_link};
use super::status::{
    FEATURE_TRAILER, SAVED_CHANGES_FILE, STATUS_NOTE_MAX, SubFacts, apply_patch, read_status, saved_changes_markdown, status_md, status_facts,
    status_sections, write_status,
};
use crate::index::attention::{is_complete, ticket_attention, user_wait_reason, you_waiting};
use crate::index::family::{family_below, feature_root, feature_rows, main_of, parent_in, working_in_family};
use crate::index::routes::Reads;
use crate::index::store::BoardList;
use crate::index::text::{js_trim, len16, slice16};
use crate::index::ticket::Tk;
use crate::index::view::schedule_ids;
use crate::runs::activity_digest::ActivityDigests;
use crate::tickets::rights::is_manager;
use crate::tickets::writer::{Refusal, Tickets, now};

/// A plan's wait before it wakes its main ticket with new events (`planWakeDelayMs`), so results arriving together
/// make one wake.
const PLAN_WAKE_DELAY_MS: u64 = 3000;
/// How long a feature's saved changes list is reused before it is read again (`CHANGES_TTL_MS`).
const CHANGES_TTL_MS: f64 = 60_000.0;
/// The refusal code `change` uses inside `update_with` for "leave the file as it is" (never an answer's status).
const UNCHANGED: u16 = 0;
/// Passes in a row on one board before it stops going again (each new change starts another): plans that keep
/// changing under the pass can't hold the thread.
const MAX_PASS_ROUNDS: usize = 50;

/// What the plan engine needs of the run loop (R7a). The stand-in starts nothing.
pub trait PlanRuns: Send + Sync {
    /// Starts the planner's wake run with `text` (act mode, raw); return_to: where a tool group's card goes after.
    fn wake(&self, _slug: &str, _id: &str, _text: String, _return_to: Option<String>) {}
    /// Work in Ready may start (`dispatch`).
    fn dispatch(&self, _slug: &str) {}
    /// A fresh chat before a wake when the session is too big (`autoFresh`).
    fn auto_fresh(&self, _slug: &str, _id: &str) {}
    /// A ticket moved from Planning to work may start the work in a fresh chat (see `RunLoop::fresh_for_work`).
    fn fresh_for_work(&self, _slug: &str, _id: &str, _choice: Option<bool>) {}
    /// A ticket moved to Planning starts its interview (`autoRefine`).
    fn auto_refine(&self, _slug: &str, _id: &str) {}
    /// A notification for the user (`notify`).
    fn notify(&self, _title: &str, _body: &str, _slug: &str, _id: &str) {}
}

pub struct NoRuns;
impl PlanRuns for NoRuns {}

/// What `gather` did.
pub struct Gathered {
    pub gathered: Vec<Arc<Tk>>,
    pub moved_up: Vec<Value>,
    pub skipped: Vec<Value>,
    pub group: Option<Arc<Tk>>,
    pub kept: Vec<Value>,
}

/// `featureStatus`' answer.
pub struct FeatureStatus {
    pub top: Arc<Tk>,
    pub feature: bool,
    pub saved: Option<Map<String, Value>>,
    pub facts: Map<String, Value>,
    pub path: PathBuf,
}

impl FeatureStatus {
    /// The route's answer: topId, title, feature, saved, facts, sections, path.
    pub fn to_json(&self) -> Map<String, Value> {
        let sections: Vec<Value> = status_sections(self.saved.as_ref(), &self.facts)
            .into_iter()
            .map(|(key, label, text)| json!({ "key": key, "label": label, "text": text }))
            .collect();
        let mut m = Map::new();
        m.insert("topId".into(), self.top.id.clone().into());
        m.insert("title".into(), self.top.title.clone().into());
        m.insert("feature".into(), self.feature.into());
        m.insert("saved".into(), self.saved.clone().map(Value::Object).unwrap_or(Value::Null));
        m.insert("facts".into(), Value::Object(self.facts.clone()));
        m.insert("sections".into(), Value::Array(sections));
        m.insert("path".into(), self.path.to_string_lossy().into_owned().into());
        m
    }
}

struct ChangesEntry {
    at: f64,
    sig: String,
    value: Value,
}

pub struct Families {
    pub tickets: Arc<Tickets>,
    pub reads: Arc<Reads>,
    runs: RwLock<Arc<dyn PlanRuns>>,
    me: Weak<Families>,
    advancing: Mutex<HashSet<String>>,
    again: Mutex<HashSet<String>>,
    wake_due: Mutex<HashMap<String, f64>>,
    /// One status.json read-change-write at a time.
    status_lock: Mutex<()>,
    /// Per board: one family link (check and write) at a time, so two opposite links can't both pass the loop and
    /// level checks. Reentrant: gather links through set_part_of. Taken before the board's write lock, never under
    /// it or in a plan pass.
    links: Mutex<HashMap<String, Arc<ReentrantMutex<()>>>>,
    changes: Mutex<HashMap<String, ChangesEntry>>,
    changes_checks: Mutex<HashSet<String>>,
    digests: Arc<ActivityDigests>,
    stopping: std::sync::atomic::AtomicBool,
    landing: std::sync::OnceLock<Arc<crate::git::landing::Git>>,
}

fn one(k: &str, v: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(k.into(), v);
    m
}

fn msg((_, e): Refusal) -> String {
    e
}

/// The plan in a ticket's front matter (`t.plan`, when set).
fn plan_in(meta: &Map<String, Value>) -> Option<Map<String, Value>> {
    meta.get("plan").filter(|p| ckanban_core::jsnum::truthy(Some(p))).and_then(Value::as_object).cloned()
}

/// The same plan, compared as JSON text (a number written and read back may differ in its Rust form only).
fn same_plan(a: Option<&Map<String, Value>>, b: Option<&Map<String, Value>>) -> bool {
    let text = |m: Option<&Map<String, Value>>| m.map(|m| crate::runs::js::stringify(&Value::Object(m.clone())));
    text(a) == text(b)
}

/// `closePlan`'s fields on a plan.
fn closed(mut plan: Map<String, Value>) -> Map<String, Value> {
    plan.insert("state".into(), "done".into());
    plan.insert("awaiting".into(), Value::Null);
    plan.insert("reason".into(), Value::Null);
    plan.insert("inbox".into(), json!([]));
    plan.insert("finishedAt".into(), now().into());
    plan
}

fn now_ms() -> f64 {
    ckanban_core::time::now_ms() as f64
}

impl Families {
    pub fn new(tickets: Arc<Tickets>, reads: Arc<Reads>) -> Arc<Families> {
        Arc::new_cyclic(|me| Families {
            tickets,
            reads,
            runs: RwLock::new(Arc::new(NoRuns)),
            me: me.clone(),
            advancing: Mutex::default(),
            again: Mutex::default(),
            wake_due: Mutex::default(),
            status_lock: Mutex::new(()),
            links: Mutex::default(),
            changes: Mutex::default(),
            changes_checks: Mutex::default(),
            digests: ActivityDigests::new(),
            stopping: Default::default(),
            landing: Default::default(),
        })
    }

    /// The run loop's side (R7a).
    pub fn set_runs(&self, runs: Arc<dyn PlanRuns>) {
        *self.runs.write() = runs;
    }
    fn runs(&self) -> Arc<dyn PlanRuns> {
        self.runs.read().clone()
    }
    /// R6's merge into main and landing, for `merge-into-main` and `land`.
    pub fn set_landing(&self, git: Arc<crate::git::landing::Git>) {
        let _ = self.landing.set(git);
    }
    pub fn landing(&self) -> Option<Arc<crate::git::landing::Git>> {
        self.landing.get().cloned()
    }

    /// The run loop's side as set now (the hooks call it).
    pub fn runs_handle(&self) -> Arc<dyn PlanRuns> {
        self.runs()
    }

    /// No plan moves on and no background job starts from now on (the board is stopping).
    pub fn shutdown(&self) {
        self.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    fn stopping(&self) -> bool {
        self.stopping.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn get(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        self.tickets.get(slug, id)
    }
    /// The board's family link lock (see `links`).
    fn link_lock(&self, slug: &str) -> Arc<ReentrantMutex<()>> {
        self.links.lock().entry(slug.to_string()).or_default().clone()
    }
    fn list(&self, slug: &str) -> Arc<BoardList> {
        self.tickets.list(slug)
    }
    fn not_found(id: &str) -> String {
        format!("ticket {id} not found")
    }
    fn patch(&self, slug: &str, id: &str, p: Map<String, Value>) -> Result<Arc<Tk>, String> {
        self.tickets.patch(slug, id, p).map_err(msg)
    }
    fn note(&self, slug: &str, id: &str, text: &str) {
        self.tickets.note(slug, id, text);
    }
    pub fn is_running(&self, slug: &str, id: &str) -> bool {
        self.reads.live.running(slug, id)
    }
    fn session(&self, t: &Tk) -> Option<Value> {
        t.s("sessionId").filter(|s| !s.is_empty()).and_then(|s| self.reads.live.session(s))
    }
    fn profile(&self, slug: &str) -> Option<Map<String, Value>> {
        ckanban_core::DataDir::new(self.tickets.root().to_path_buf()).profile(slug).map(|p| p.record.0)
    }
    /// `outputsDir`: the ticket's outputs folder, made if missing.
    pub fn outputs_dir(&self, slug: &str, id: &str) -> PathBuf {
        let d = self.tickets.ticket_dir(slug, id).join("outputs");
        let _ = std::fs::create_dir_all(&d);
        d
    }
    fn outputs_path(&self, slug: &str, id: &str) -> PathBuf {
        self.tickets.ticket_dir(slug, id).join("outputs")
    }

    /// The ticket as the board shows it (`view`).
    pub fn view(&self, slug: &str, t: &Tk) -> Value {
        let p = self.profile(slug).unwrap_or_default();
        let list = self.list(slug);
        Value::Object(self.reads.viewer.view(slug, &p, &list, t, &*self.reads.live))
    }

    // ---- Families (board-families.ts) ----

    /// `setPartOf`: links id under parent (None unlinks). via "chat": the parent's chat made it. subtree false: only
    /// its own depth is checked (gather moves deeper tickets up itself).
    pub fn set_part_of(&self, slug: &str, id: &str, parent: Option<&str>, via: Option<&str>, subtree: bool) -> Result<Arc<Tk>, String> {
        let lock = self.link_lock(slug);
        let _links = lock.lock();
        let mut t = self.get(slug, id).ok_or_else(|| Self::not_found(id))?;
        if let Some(parent) = parent {
            let p = self.get(slug, parent).ok_or_else(|| Self::not_found(parent))?;
            let without = without_plan_link(&self.list(slug), id);
            if would_loop(&without, id, parent) {
                return Err(if parent == id {
                    format!("\"{}\" can't be part of itself", t.title)
                } else {
                    format!("\"{}\" is already inside \"{}\", so \"{}\" can't go under it.", p.title, t.title, t.title)
                });
            }
            if let Some(problem) = link_problem(&without, &Moved { id, title: &t.title, main: None }, parent, subtree) {
                return Err(problem);
            }
        }
        if t.parent_id.as_deref().is_some_and(|p| Some(p) != parent) {
            t = self.tickets.update(slug, id, &one("parentId", Value::Null), false).map_err(msg)?;
        }
        let mut patch = Map::new();
        patch.insert("partOf".into(), parent.map(Value::from).unwrap_or(Value::Null));
        patch.insert("partOfVia".into(), if parent.is_some() { via.map(Value::from).unwrap_or(Value::Null) } else { Value::Null });
        patch.insert("parentSuggestion".into(), Value::Null);
        patch.insert("parentChecked".into(), true.into());
        if parent.is_none() && t.tool {
            patch.extend(self.own_work_patch(slug, &t, false));
        }
        let made_from = t.s("madeFrom").filter(|s| !s.is_empty());
        if !t.tool && made_from.is_some() && t.part_of.as_deref() == made_from && parent != made_from && t.is("startFrom") && !t.is("worktree") {
            patch.insert("startFrom".into(), Value::Null);
        }
        if parent.is_some() && t.parent_id.as_deref() == parent {
            patch.insert("partOf".into(), Value::Null);
            patch.insert("partOfVia".into(), Value::Null);
        }
        self.patch(slug, id, patch)
    }

    /// `ownWorkPatch`: what a task becomes when it stops being one.
    pub fn own_work_patch(&self, slug: &str, t: &Tk, main: bool) -> Map<String, Value> {
        let list = self.list(slug);
        let has_tasks = family_below(&list, &t.id).into_iter().any(|i| list.at(i).id != t.id && list.at(i).tool);
        let mut p = Map::new();
        p.insert("tool".into(), false.into());
        p.insert("showOnBoard".into(), Value::Null);
        if main || has_tasks {
            p.insert("main".into(), true.into());
        }
        p
    }

    /// `makeOwnWork`: a task becomes a main ticket with its own card and chat (a sub-feature while still linked).
    pub fn make_own_work(&self, slug: &str, id: &str) -> Result<Arc<Tk>, String> {
        let lock = self.link_lock(slug);
        let _links = lock.lock();
        let t = self.get(slug, id).ok_or_else(|| Self::not_found(id))?;
        if !t.tool {
            return Err(format!("\"{}\" is already its own work", t.title));
        }
        if self.is_running(slug, id) {
            return Err(format!("\"{}\" is working right now: make it its own work once its run ends", t.title));
        }
        let list = self.list(slug);
        let was = main_of(&list, &t).map(|i| list.tickets[i].clone());
        let parent = t.parent_link().and_then(|(p, _)| list.get(p).cloned());
        if let Some(parent) = &parent {
            let without = without_plan_link(&list, id);
            if let Some(problem) = link_problem(&without, &Moved { id, title: &t.title, main: Some(true) }, &parent.id, true) {
                if let Some(sub) = feature_root(&list, &parent.id).map(|i| list.at(i)).filter(|s| s.main && s.parent_link().is_some()) {
                    return Err(format!(
                        "\"{}\" can't become its own work here: it is inside the sub-feature \"{}\", and a sub-feature can't hold another sub-feature. Unlink it first to make it top-level work.",
                        t.title, sub.title
                    ));
                }
                return Err(format!("{problem} Unlink it instead to make it its own work at the top of the board."));
            }
            if t.parent_id.is_some() {
                self.tickets.update(slug, id, &one("parentId", Value::Null), false).map_err(msg)?;
            }
        }
        let mut p = self.own_work_patch(slug, &t, true);
        if let Some(parent) = &parent {
            p.insert("partOf".into(), parent.id.clone().into());
            p.insert("partOfVia".into(), Value::Null);
        }
        let out = self.patch(slug, id, p)?;
        match &parent {
            Some(parent) => self.note(
                slug,
                id,
                &format!("Made its own work: a sub-feature of \"{}\" with its own card and chat. Tasks under it report here.", parent.title),
            ),
            None => self.note(slug, id, "Made its own work: its own card and chat on the board."),
        }
        if let Some(was) = was.filter(|w| w.id != id) {
            let sub = parent.as_ref().map(|p| format!(", a sub-feature of \"{}\"", p.title)).unwrap_or_default();
            self.note(slug, &was.id, &format!("\"{}\" ({}) is now its own work{sub}: its results go to its own chat.", t.title, t.id));
        }
        Ok(out)
    }

    /// `setShowOnBoard`: a task gets a card (on) or lives in its feature only (off); a gathered card can be hidden too.
    pub fn set_show_on_board(&self, slug: &str, id: &str, on: bool) -> Result<Arc<Tk>, String> {
        let t = self.get(slug, id).ok_or_else(|| Self::not_found(id))?;
        if t.tool {
            return self.patch(slug, id, one("showOnBoard", if on { true.into() } else { Value::Null }));
        }
        if on {
            return if t.show_false { self.patch(slug, id, one("showOnBoard", Value::Null)) } else { Ok(t) };
        }
        if t.main {
            let sub = if t.parent_link().is_some() { " (a sub-feature)" } else { "" };
            return Err(format!("\"{}\" is a main ticket{sub}: it keeps its own card on the board", t.title));
        }
        if matches!(t.kind.as_deref(), Some("group" | "round")) {
            return Err(format!("\"{}\" is a group of its feature: it keeps its own card on the board", t.title));
        }
        let list = self.list(slug);
        let top = feature_root(&list, id).map(|i| list.at(i).id.clone());
        if !t.hideable_card() || top.is_none() || top.as_deref() == Some(id) {
            return Err(format!(
                "\"{}\" isn't part of a feature: only a task or a card gathered into a feature can be hidden from the board",
                t.title
            ));
        }
        self.patch(slug, id, one("showOnBoard", false.into()))
    }

    /// `placeInFeature`: a new round is titled "Testing round N" and goes under its feature's top; a new ticket under
    /// another must keep the family rules.
    pub fn place_in_feature(&self, slug: &str, input: &mut Map<String, Value>) -> Result<(), String> {
        let list = self.list(slug);
        let text = |k: &str| input.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let parent = text("partOf").or_else(|| text("parentId"));
        if input.get("kind").and_then(Value::as_str) == Some("round") {
            let top = parent.as_deref().and_then(|p| feature_root(&list, p)).map(|i| list.at(i).id.clone());
            input.insert("title".into(), next_round_title(&list, top.as_deref()).into());
            if let Some(top) = top.filter(|t| Some(t) != parent.as_ref()) {
                input.insert("partOf".into(), top.into());
                input.shift_remove("partOfVia");
            }
            return Ok(());
        }
        let Some(parent) = parent else { return Ok(()) };
        let title = input.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        let main = ckanban_core::jsnum::truthy(input.get("main"));
        match link_problem(&list, &Moved { id: "\u{0}new", title: &title, main: Some(main) }, &parent, true) {
            Some(p) => Err(p),
            None => Ok(()),
        }
    }

    /// `gather`: tickets into the feature, under one of its groups (an existing one, "new" for a new group named
    /// new_group) or the feature itself. Their own tickets deeper than MAX_LEVEL move up beside them.
    pub fn gather(&self, slug: &str, feature_id: &str, items: &[(String, Option<String>)], new_group: Option<&str>, by: Option<&str>, hide: bool) -> Result<Gathered, String> {
        let lock = self.link_lock(slug);
        let _links = lock.lock();
        let top = {
            let list = self.list(slug);
            feature_root(&list, feature_id).map(|i| list.tickets[i].clone()).ok_or_else(|| Self::not_found(feature_id))?
        };
        let mut group: Option<Arc<Tk>> = None;
        if items.iter().any(|(_, g)| g.as_deref() == Some("new")) {
            let title = new_group.map(js_trim).filter(|s| !s.is_empty()).unwrap_or("New group");
            let mut input = Map::new();
            input.insert("title".into(), title.into());
            input.insert("body".into(), "".into());
            input.insert("status".into(), "backlog".into());
            input.insert("mode".into(), "auto".into());
            input.insert("kind".into(), "group".into());
            input.insert("partOf".into(), top.id.clone().into());
            group = Some(self.tickets.create(slug, input).map_err(msg)?);
        }
        let groups: HashSet<String> = {
            let list = self.list(slug);
            groups_of(&list, &top.id).into_iter().map(|i| list.at(i).id.clone()).collect()
        };
        let mut out = Gathered { gathered: Vec::new(), moved_up: Vec::new(), skipped: Vec::new(), group: group.clone(), kept: Vec::new() };
        let skip = |out: &mut Gathered, id: &str, reason: String| out.skipped.push(json!({ "id": id, "reason": reason }));
        for (item_id, item_group) in items {
            let target = match item_group.as_deref() {
                Some("new") => group.as_ref().map(|g| g.id.clone()).unwrap_or_default(),
                Some(g) => g.to_string(),
                None => top.id.clone(),
            };
            let Some(t) = self.get(slug, item_id) else {
                skip(&mut out, item_id, "not found".into());
                continue;
            };
            if t.id == top.id {
                skip(&mut out, &t.id, "that is the feature itself".into());
                continue;
            }
            if target != top.id && !groups.contains(&target) {
                skip(&mut out, &t.id, format!("{target} is not a group of this feature"));
                continue;
            }
            let own: HashSet<String> = subtree_ids(&self.list(slug), &t.id).into_iter().collect();
            let r: Result<(), String> = (|| {
                if t.parent_link().map(|(p, _)| p) != Some(target.as_str()) {
                    self.set_part_of(slug, &t.id, Some(&target), None, false)?;
                }
                let now_t = self.get(slug, &t.id).ok_or_else(|| Self::not_found(&t.id))?;
                if hide && !now_t.tool {
                    if let Err(e) = self.set_show_on_board(slug, &t.id, false) {
                        out.kept.push(json!({ "id": t.id, "reason": e }));
                    }
                }
                out.gathered.push(self.get(slug, &t.id).ok_or_else(|| Self::not_found(&t.id))?);
                let under = if target != top.id {
                    format!(", under \"{}\"", self.get(slug, &target).map(|g| g.title.clone()).unwrap_or_else(|| "undefined".into()))
                } else {
                    String::new()
                };
                let by = by.map(|b| format!(" {b}")).unwrap_or_default();
                self.note(slug, &t.id, &format!("Gathered into the feature \"{}\" ({}){under}{by}.", top.title, top.id));
                Ok(())
            })();
            if let Err(e) = r {
                skip(&mut out, &t.id, e);
                continue;
            }
            for _ in 0..500 {
                let list = self.list(slug);
                let rows = feature_rows(&list, &top.id);
                let Some(deep) = rows.iter().position(|r| own.contains(&list.at(r.idx).id) && r.depth > MAX_LEVEL) else { break };
                let Some(anc) = rows[..deep].iter().rev().find(|r| r.depth == 1) else { break };
                let (d, a) = (list.tickets[rows[deep].idx].clone(), list.tickets[anc.idx].clone());
                let mut p = Map::new();
                p.insert("partOf".into(), a.id.clone().into());
                p.insert("partOfVia".into(), Value::Null);
                self.patch(slug, &d.id, p)?;
                out.moved_up.push(json!({ "id": d.id, "title": d.title, "to": a.id }));
                self.note(
                    slug,
                    &d.id,
                    &format!("Moved up under \"{}\" so the feature \"{}\" stays at most {MAX_LEVEL} levels deep.", a.title, top.title),
                );
            }
        }
        if !out.gathered.is_empty() {
            let n = out.gathered.len();
            let titles: Vec<String> = out.gathered.iter().map(|t| format!("\"{}\"", t.title)).collect();
            let by = by.map(|b| format!(" {b}")).unwrap_or_default();
            self.note(slug, &top.id, &format!("Gathered {n} ticket{} into this feature{by}: {}.", if n == 1 { "" } else { "s" }, titles.join(", ")));
        }
        if let Some(t) = self.get(slug, &top.id) {
            self.tickets.emit(slug, &t);
        }
        Ok(out)
    }

    // ---- Plans (board-plans.ts, board-main.ts) ----

    fn new_plan(children: usize) -> Value {
        json!({ "state": "running", "wakeups": 0, "startedAt": now(), "originalCount": children, "inbox": [], "seen": {}, "retries": {}, "awaiting": null })
    }

    /// A change worked out from the ticket's file under the board's lock (`Tickets::update_with`); `make` answers
    /// None to leave the file as it is. Ok(None): nothing written. Bun is single-threaded, so its read-then-write is
    /// one step; here routes, hooks and the wake timer run at once, so every plan write reads the file it changes.
    pub(crate) fn change(&self, slug: &str, id: &str, make: impl FnOnce(&Map<String, Value>) -> Result<Option<Map<String, Value>>, String>) -> Result<Option<Arc<Tk>>, String> {
        match self.tickets.update_with(slug, id, |meta| match make(meta) {
            Ok(Some(p)) => Ok(p),
            Ok(None) => Err((UNCHANGED, String::new())),
            Err(e) => Err((400, e)),
        }) {
            Ok(t) => Ok(Some(t)),
            Err((UNCHANGED, _)) => Ok(None),
            Err((_, e)) => Err(e),
        }
    }

    /// A plan pass's write: the planner's plan becomes `plan` (with `extra` fields) unless the file's plan is no
    /// longer `from`, the copy the pass started from (a Pause, an event, Mark done came in meanwhile): then nothing
    /// is written and the pass goes again with the file as it is now. True when written.
    fn save_plan(&self, slug: &str, id: &str, from: &Map<String, Value>, plan: Map<String, Value>) -> bool {
        let r = self.change(slug, id, |meta| {
            if !same_plan(plan_in(meta).as_ref(), Some(from)) {
                return Ok(None);
            }
            Ok(Some(one("plan", Value::Object(plan))))
        });
        match r {
            Ok(Some(_)) => true,
            Ok(None) => {
                self.again.lock().insert(slug.to_string());
                false
            }
            Err(e) => {
                eprintln!("[board] plan of {slug}/{id}: {e}");
                false
            }
        }
    }

    /// `ensurePlan`: a manager gets a running plan once it has tool tickets or events.
    pub fn ensure_plan(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        let t = self.get(slug, id)?;
        if t.is("plan") && t.plan_state() != Some("done") {
            return Some(t);
        }
        let kids = children(&self.list(slug), id).len();
        // Only the plan's own fields change, on the plan in the file now.
        let r = self.change(slug, id, |meta| Ok(Self::ensured(plan_in(meta), kids).map(|p| one("plan", Value::Object(p)))));
        match r {
            Ok(Some(t)) => Some(t),
            Ok(None) => self.get(slug, id),
            Err(_) => None,
        }
    }

    /// `ensurePlan`'s plan from the one in the file: None when it is running already (left as it is), else a done
    /// plan reopened or a new one.
    fn ensured(plan: Option<Map<String, Value>>, kids: usize) -> Option<Map<String, Value>> {
        match plan {
            Some(p) if p.get("state").and_then(Value::as_str) != Some("done") => None,
            Some(mut p) => {
                p.insert("state".into(), "running".into());
                p.insert("awaiting".into(), Value::Null);
                p.insert("reason".into(), Value::Null);
                p.insert("finishedAt".into(), Value::Null);
                let orig = p.get("originalCount").and_then(Value::as_f64).unwrap_or(f64::NAN);
                p.insert("originalCount".into(), ckanban_core::jsnum::num(if orig.is_nan() { f64::NAN } else { orig.max(kids as f64) }));
                Some(p)
            }
            None => Self::new_plan(kids).as_object().cloned(),
        }
    }

    /// `pushEvent`: an event for a manager's next wake, and the plans move on. The plan is ensured (a done one
    /// reopened) and the event added in one write, so a close can't come in between and leave the event in a done
    /// plan that never wakes its main ticket.
    pub fn push_event(&self, slug: &str, planner: &str, line: &str) {
        if self.get(slug, planner).is_none() {
            return;
        }
        let kids = children(&self.list(slug), planner).len();
        let r = self.change(slug, planner, |meta| {
            let now = plan_in(meta);
            let mut plan = Self::ensured(now.clone(), kids).or(now).unwrap_or_default();
            let mut inbox = plan.get("inbox").and_then(Value::as_array).cloned().unwrap_or_default();
            inbox.push(line.into());
            plan.insert("inbox".into(), Value::Array(inbox));
            Ok(Some(one("plan", Value::Object(plan))))
        });
        if let Err(e) = r {
            eprintln!("[board] plan event for {slug}/{planner}: {e}");
        }
        self.advance_plans(slug);
    }

    /// `startPlan`: start or resume a manager's plan.
    pub fn start_plan(&self, slug: &str, id: &str, by_planner: bool, why: Option<&str>) -> Result<Arc<Tk>, String> {
        let t = self.get(slug, id).ok_or_else(|| Self::not_found(id))?;
        if !is_manager(&t) {
            return Err("only a main ticket runs tickets of its own: turn this ticket into a main ticket first".into());
        }
        let kids = children(&self.list(slug), id);
        if let Some(p) = plan_problem(&kids) {
            return Err(format!("can't start the plan: {p}"));
        }
        for k in &kids {
            if k.status == "backlog" && k.s("mode") != Some("auto") {
                self.patch(slug, &k.id, one("mode", "auto".into()))?;
            }
        }
        // Worked out from the plan in the file now: only the plan's own fields change.
        let mut resuming = false;
        let out = self
            .change(slug, id, |meta| {
                let prev = plan_in(meta);
                resuming = prev.as_ref().is_some_and(|p| p.get("state").and_then(Value::as_str) != Some("done"));
                let plan = match prev.filter(|_| resuming) {
                    Some(mut p) => {
                        let finishing = p.get("awaiting").and_then(Value::as_str) == Some("final") || p.get("state").and_then(Value::as_str) == Some("finishing");
                        let stuck = p.get("state").and_then(Value::as_str) == Some("stuck");
                        p.insert("state".into(), if finishing { "finishing" } else { "running" }.into());
                        p.insert("reason".into(), Value::Null);
                        if stuck {
                            p.insert("wakeups".into(), 0.into());
                            p.insert("awaiting".into(), Value::Null);
                            p.insert("seen".into(), json!({}));
                        }
                        Value::Object(p)
                    }
                    None => Self::new_plan(kids.len()),
                };
                let mut p = one("plan", plan);
                if meta.get("outcome").is_some_and(|o| ckanban_core::jsnum::truthy(Some(o))) && meta.get("outcome").and_then(Value::as_str) != Some("done") {
                    p.insert("outcome".into(), Value::Null);
                }
                Ok(Some(p))
            })?
            .ok_or_else(|| Self::not_found(id))?;
        let by = if by_planner { " by the planner" } else { "" };
        if resuming {
            let why = why.map(|w| format!(": {w}")).unwrap_or_default();
            self.note(slug, id, &format!("Plan resumed{by}{why}."));
        } else {
            self.note(slug, id, &format!("Plan started{by}: {} tool tickets; each starts as soon as the ones it waits for are done.", kids.len()));
        }
        self.advance_plans(slug);
        Ok(self.get(slug, id).unwrap_or(out))
    }

    /// `resumeStoppedPlan`: the user acting on a paused main ticket resumes its plan.
    pub fn resume_stopped_plan(&self, slug: &str, id: &str, why: &str) -> bool {
        let Some(t) = self.get(slug, id) else { return false };
        if !t.main || t.plan_state() != Some("paused") {
            return false;
        }
        match self.start_plan(slug, id, false, Some(why)) {
            Ok(_) => true,
            Err(e) => {
                self.note(slug, id, &format!("Couldn't resume the paused plan: {e}"));
                false
            }
        }
    }

    /// `unparkMain`: a main ticket parked in Done or Backlog goes back to Review. True when it moved.
    pub fn unpark_main(&self, slug: &str, id: &str, why: &str, started_only: bool) -> bool {
        let Some(t) = self.get(slug, id) else { return false };
        if !t.main || (t.status != "done" && t.status != "backlog") {
            return false;
        }
        if started_only && t.status == "backlog" && !t.is("plan") {
            return false;
        }
        let from = if t.status == "done" { "Done" } else { "Backlog" };
        let mut p = Map::new();
        p.insert("status".into(), "review".into());
        p.insert("reopenedFrom".into(), Value::Null);
        if self.patch(slug, id, p).is_err() {
            return false;
        }
        self.note(slug, id, &format!("Moved back from {from}: {why}."));
        true
    }

    /// `holdsReview`: the PR poller leaves a main ticket in Review.
    pub fn holds_review(&self, slug: &str, id: &str) -> bool {
        self.get(slug, id).is_some_and(|t| t.main && (t.is("doneAt") || self.open_steps(slug, id)))
    }

    /// `openSteps`: the family still has tool tickets that aren't finished.
    pub fn open_steps(&self, slug: &str, id: &str) -> bool {
        let list = self.list(slug);
        let mut todo = children(&list, id);
        let mut seen: HashSet<String> = HashSet::from([id.to_string()]);
        while let Some(k) = todo.pop() {
            if !seen.insert(k.id.clone()) {
                continue;
            }
            if k.tool && (k.status != "done" || self.is_running(slug, &k.id)) {
                return true;
            }
            todo.extend(children(&list, &k.id));
        }
        false
    }

    fn plan_of(t: &Tk) -> Option<Map<String, Value>> {
        t.get("plan").and_then(Value::as_object).filter(|_| t.is("plan")).cloned()
    }

    /// `pausePlan`.
    pub fn pause_plan(&self, slug: &str, id: &str) -> Result<Arc<Tk>, String> {
        let t = self.get(slug, id).ok_or_else(|| "this ticket has no plan".to_string())?;
        let plan = Self::plan_of(&t).ok_or_else(|| "this ticket has no plan".to_string())?;
        if plan.get("state").and_then(Value::as_str) == Some("done") {
            return Ok(t);
        }
        self.note(slug, id, "Plan paused.");
        // Only the state changes, on the plan in the file now (an event a pass just added stays).
        let r = self.change(slug, id, |meta| {
            let Some(mut plan) = plan_in(meta) else { return Err("this ticket has no plan".into()) };
            if plan.get("state").and_then(Value::as_str) == Some("done") {
                return Ok(None);
            }
            plan.insert("state".into(), "paused".into());
            Ok(Some(one("plan", Value::Object(plan))))
        })?;
        Ok(r.or_else(|| self.get(slug, id)).unwrap_or(t))
    }

    /// `markPlanDone`.
    pub fn mark_plan_done(&self, slug: &str, id: &str) -> Result<Arc<Tk>, String> {
        let t = self.get(slug, id).ok_or_else(|| "this ticket has no plan".to_string())?;
        let plan = Self::plan_of(&t).ok_or_else(|| "this ticket has no plan".to_string())?;
        if plan.get("state").and_then(Value::as_str) == Some("done") {
            return Ok(t);
        }
        // The plan's closing fields only, on the plan in the file now.
        let r = self.change(slug, id, |meta| {
            let Some(plan) = plan_in(meta) else { return Err("this ticket has no plan".into()) };
            if plan.get("state").and_then(Value::as_str) == Some("done") {
                return Ok(None);
            }
            Ok(Some(one("plan", Value::Object(closed(plan)))))
        })?;
        match r {
            Some(out) => {
                self.note(slug, id, "Plan marked done.");
                Ok(out)
            }
            None => Ok(self.get(slug, id).unwrap_or(t)),
        }
    }

    /// A pass closes the plan it read (`closePlan`); false when the file's plan changed meanwhile (the pass goes again).
    fn close_plan(&self, slug: &str, planner: &Tk, from: &Map<String, Value>, comment: &str) -> bool {
        if !self.save_plan(slug, &planner.id, from, closed(from.clone())) {
            return false;
        }
        self.note(slug, &planner.id, comment);
        true
    }

    /// A pass marks the plan it read stuck; false when the file's plan changed meanwhile (the pass goes again).
    fn stuck(&self, slug: &str, planner: &Tk, from: &Map<String, Value>, mut plan: Map<String, Value>, reason: &str) -> bool {
        plan.insert("state".into(), "stuck".into());
        plan.insert("awaiting".into(), Value::Null);
        plan.insert("reason".into(), reason.into());
        if !self.save_plan(slug, &planner.id, from, plan) {
            return false;
        }
        let tail = if planner.main { "Write in its chat to carry on." } else { "Its main ticket can resume it once that is fixed." };
        self.note(slug, &planner.id, &format!("Stuck: {reason}. {tail}"));
        true
    }

    /// A stuck main ticket's plan runs again when what made it stuck is gone (`plan::stuck_cleared`): only this
    /// family is looked at. True when it was written (the pass goes again and moves the plan on, its inbox waking the
    /// main ticket through the usual wake).
    fn unstick(&self, slug: &str, planner: &Arc<Tk>, orig: &Map<String, Value>, plan: &Map<String, Value>, kids: &[Arc<Tk>]) -> bool {
        let asks = !crate::index::family::ask_closed(planner)
            && self.session(planner).and_then(|s| s.get("openQuestions").and_then(Value::as_f64)).is_some_and(|q| q > 0.0);
        let running = |id: &str| self.is_running(slug, id);
        let kid_waits = |t: &Tk| kid_waits_on_user(t, running(&t.id), self.user_wait(t));
        let step = plan_step(plan, kids, &running, &|t| self.user_wait(t), &|t| self.last_summary(slug, &t.id), &|t| self.report_of(slug, &t.id));
        let sig = family_sig(kids.iter().map(|k| &**k));
        let Some(why) = stuck_cleared(plan, planner, asks, kids, &kid_waits, &step, &sig) else { return false };
        let mut next = plan.clone();
        for (k, v) in [("state", json!("running")), ("reason", Value::Null), ("awaiting", Value::Null), ("noProgress", json!(0)), ("wakeups", json!(0))] {
            next.insert(k.into(), v);
        }
        if !self.save_plan(slug, &planner.id, orig, next) {
            return false;
        }
        self.note(slug, &planner.id, why);
        self.again.lock().insert(slug.to_string());
        true
    }

    /// `userWait`: why a plan child waits on the user.
    fn user_wait(&self, t: &Tk) -> Option<String> {
        user_wait_reason(t, self.session(t).as_ref())
    }

    /// `waitsOnUser`: the card still needs the user (not just a look).
    pub fn waits_on_user(&self, slug: &str, list: &BoardList, t: &Tk) -> bool {
        let running = self.is_running(slug, &t.id);
        if t.tool && t.kind.as_deref() == Some("with_you") {
            return you_waiting(t, running);
        }
        let host = self.reads.live.host(slug, &t.id);
        let is_running = |x: &str| self.is_running(slug, x);
        let root = self.tickets.root().to_path_buf();
        let a = ticket_attention(list, t, self.session(t).as_ref(), running, host.as_ref(), &is_running, &|| schedule_ids(&root, slug));
        a.is_some_and(|a| a.kind != "review")
    }

    /// `lastSummary`: the ticket's newest Claude comment that isn't a board note.
    pub fn last_summary(&self, slug: &str, id: &str) -> String {
        const NOTES: [&str; 8] = [
            "Run failed",
            "Could not start",
            "Run stopped",
            "Planner stopped",
            "Started a fresh session",
            "Started a fresh chat",
            "Took over the session",
            "This ticket's Claude session is still open",
        ];
        let ai = self.reads.viewer.comments.ai(&self.tickets.ticket_dir(slug, id));
        ai.iter().rev().find(|(t, _)| !NOTES.iter().any(|n| t.starts_with(n))).map(|(t, _)| t.clone()).unwrap_or_default()
    }

    /// `reportOf`: the ticket's outputs/report.md, if it wrote one.
    pub fn report_of(&self, slug: &str, id: &str) -> Option<String> {
        let f = self.outputs_path(slug, id).join(REPORT_FILE);
        f.exists().then(|| f.to_string_lossy().into_owned())
    }

    fn repo_plain(&self, slug: &str) -> bool {
        let Some(path) = self.profile(slug).and_then(|p| p.get("path").and_then(Value::as_str).map(PathBuf::from)) else { return false };
        matches!(wait(crate::git::repo::repo_kind(&path, false)), crate::git::repo::RepoKind::Plain | crate::git::repo::RepoKind::Empty)
    }

    /// `folderFiles`: files a tool ticket changed in the project folder itself (no version history).
    fn folder_files(&self, slug: &str, t: &Tk) -> usize {
        let root = self.profile(slug).and_then(|p| p.get("path").and_then(Value::as_str).map(PathBuf::from));
        let parse = |k: &str| t.s(k).and_then(ckanban_core::time::parse_date);
        let from = parse("lastRunAt").map(|x| x - 1000.0);
        let to = parse("runEndedAt").unwrap_or_else(now_ms) + 2000.0;
        let mut files: HashSet<String> = HashSet::new();
        if let (Some(root), Some(from)) = (root, from) {
            let mut seen = 0usize;
            fn walk(dir: &Path, depth: usize, seen: &mut usize, from: f64, to: f64, files: &mut HashSet<String>) {
                if depth > 8 || *seen > 20_000 {
                    return;
                }
                let Ok(rd) = std::fs::read_dir(dir) else { return };
                for d in rd.flatten() {
                    let name = d.file_name().to_string_lossy().into_owned();
                    if name == ".git" || name == "node_modules" || name.starts_with(".ckanban") {
                        continue;
                    }
                    let Ok(ft) = d.file_type() else { continue };
                    let p = d.path();
                    if ft.is_dir() {
                        walk(&p, depth + 1, seen, from, to, files);
                    } else if ft.is_file() {
                        *seen += 1;
                        let m = d.metadata().ok().and_then(|m| m.modified().ok()).and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok());
                        if let Some(m) = m.map(|m| m.as_secs_f64() * 1000.0)
                            && m >= from
                            && m <= to
                        {
                            files.insert(p.to_string_lossy().into_owned());
                        }
                    }
                }
            }
            walk(&root, 0, &mut seen, from, to, &mut files);
        }
        let log = self.tickets.ticket_dir(slug, &t.id).join("activity.jsonl");
        files.extend(self.digests.get_now(&log).edited);
        files.len()
    }

    /// `resultCard`: a tool ticket's result as a card for its parent's chat.
    pub fn result_card(&self, slug: &str, id: &str) -> Option<Value> {
        let t = self.get(slug, id)?;
        let summary = js_trim(&self.last_summary(slug, id)).to_string();
        let plain = !t.is("worktree") && !t.is("branch") && !t.is("workdir") && self.repo_plain(slug);
        let cost = (self.reads.live.cost(slug, id) * 100.0).round() / 100.0;
        let summary = if len16(&summary) > 600 { format!("{}…", slice16(&summary, 599)) } else { summary };
        let mut m = Map::new();
        m.insert("at".into(), now().into());
        m.insert("ticketId".into(), t.id.clone().into());
        m.insert("title".into(), t.title.clone().into());
        m.insert("kind".into(), t.get("kind").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
        m.insert("outcome".into(), t.get("outcome").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| "done".into()));
        m.insert("verdict".into(), t.get("verdict").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
        m.insert("summary".into(), summary.into());
        m.insert("report".into(), self.report_of(slug, id).map(Value::from).unwrap_or(Value::Null));
        m.insert("model".into(), t.get("model").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null));
        m.insert("costUsd".into(), ckanban_core::jsnum::num(cost));
        if plain {
            m.insert("folderFiles".into(), self.folder_files(slug, &t).into());
        }
        Some(Value::Object(m))
    }

    fn add_results(&self, slug: &str, id: &str, cards: Vec<Value>) {
        if cards.is_empty() {
            return;
        }
        let _ = self.tickets.update_with(slug, id, |meta| {
            let mut r = meta.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
            r.extend(cards);
            let keep = r.len().saturating_sub(RESULTS_KEEP);
            Ok(one("results", Value::Array(r[keep..].to_vec())))
        });
    }

    /// `reportToMain`: a ticket the user added to a feature finished: its result reaches the main ticket too.
    pub fn report_to_main(&self, slug: &str, id: &str, summary: &str) {
        let Some(t) = self.get(slug, id) else { return };
        if t.tool || t.main {
            return;
        }
        let list = self.list(slug);
        let Some(main) = main_of(&list, &t).map(|i| list.tickets[i].clone()).filter(|m| m.id != id) else { return };
        if let Some(card) = self.result_card(slug, id) {
            self.add_results(slug, &main.id, vec![card]);
        }
        self.push_event(slug, &main.id, &finished_line(&t, summary, self.report_of(slug, id).as_deref()));
    }

    /// `noteUserMessage`: the user wrote in a tool ticket's chat; its parent hears the whole message.
    pub fn note_user_message(&self, slug: &str, id: &str, text: &str) {
        let Some(t) = self.get(slug, id).filter(|t| t.tool) else { return };
        let list = self.list(slug);
        let parent = t.parent_id.clone().or_else(|| main_of(&list, &t).map(|i| list.at(i).id.clone()));
        if let Some(p) = parent {
            self.push_event(slug, &p, &format!("the user wrote in tool ticket {} \"{}\": {text}", t.id, t.title));
        }
    }

    /// `familyWorking`: how many of a main ticket's family work now.
    pub fn family_working(&self, slug: &str, list: &BoardList, id: &str) -> usize {
        let below = family_below(list, id);
        working_in_family(list, &below, id, &|t| self.is_running(slug, &t.id)).len()
    }

    /// `advancePlans`: every running plan on the board moves forward. Cheap and idempotent. One pass per board at a
    /// time; a call during a pass makes it go again. A plan whose step panics is skipped (Bun catches per plan) and
    /// the board is never left marked as advancing (Bun's finally).
    pub fn advance_plans(&self, slug: &str) {
        if self.stopping() {
            return;
        }
        {
            // Under the advancing lock, so a pass ending now sees the request to go again.
            let mut adv = self.advancing.lock();
            if !adv.insert(slug.to_string()) {
                self.again.lock().insert(slug.to_string());
                return;
            }
        }
        // Clears the mark if the pass panics outside a plan step; a normal end clears it under the lock below.
        struct Mark<'a>(&'a Families, &'a str, bool);
        impl Drop for Mark<'_> {
            fn drop(&mut self) {
                if self.2 {
                    self.0.advancing.lock().remove(self.1);
                }
            }
        }
        let mut mark = Mark(self, slug, true);
        let mut rounds = 0;
        loop {
            rounds += 1;
            self.again.lock().remove(slug);
            let list = self.list(slug);
            let mut started = false;
            for p in &list.tickets {
                if !p.is("plan") || matches!(p.plan_state(), Some("done" | "paused")) || !is_manager(p) {
                    continue;
                }
                // The planner as its file is now (the listing is cached by folder, so an outside edit of its
                // ticket.md would otherwise make every write of this pass find a different plan).
                let Some(p) = self.get(slug, &p.id) else { continue };
                if !p.is("plan") || matches!(p.plan_state(), Some("done" | "paused")) || !is_manager(&p) {
                    continue;
                }
                let p = &p;
                let kids = children(&list, &p.id);
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.advance_plan(slug, p, &kids))) {
                    Ok(s) => started = s || started,
                    Err(e) => {
                        let why = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
                        eprintln!("[board] plan of {slug}/{}: {why}", p.id);
                    }
                }
            }
            if started {
                self.runs().dispatch(slug);
            }
            // Another call came in meanwhile, or a write found the plan changed: go again (its changes count).
            let mut adv = self.advancing.lock();
            if !self.again.lock().contains(slug) || rounds >= MAX_PASS_ROUNDS {
                if rounds >= MAX_PASS_ROUNDS {
                    eprintln!("[board] plans of {slug}: still changing after {rounds} passes; the next change moves them on");
                }
                adv.remove(slug);
                mark.2 = false;
                break;
            }
        }
    }

    /// `advancePlan`: one plan; true when it moved children to Ready. Every write checks the file still holds the plan
    /// this pass read (`orig`); when it doesn't, nothing more is written and the pass goes again.
    fn advance_plan(&self, slug: &str, planner: &Arc<Tk>, kids: &[Arc<Tk>]) -> bool {
        let Some(orig) = Self::plan_of(planner) else { return false };
        let mut plan = orig.clone();
        let busy = self.is_running(slug, &planner.id);
        let awaiting = plan.get("awaiting").filter(|a| ckanban_core::jsnum::truthy(Some(a))).and_then(Value::as_str).map(str::to_string);
        if let (Some(aw), false) = (&awaiting, busy) {
            let o = planner.s("outcome");
            let auto = planner.get("limit").and_then(|l| l.get("auto")).is_some_and(|a| ckanban_core::jsnum::truthy(Some(a)));
            if o == Some("limit") && auto {
                return false;
            }
            if o == Some("limit") {
                self.stuck(slug, planner, &orig, plan, "the run that plans the steps hit the usage limit");
                return false;
            }
            if let Some(o @ ("blocked" | "needs_input" | "failed" | "stopped")) = o {
                let reason = match o {
                    "needs_input" => crate::index::attention::STUCK_ON_QUESTIONS.to_string(),
                    "blocked" => "the run that plans the steps is blocked".into(),
                    o => format!("the run that plans the steps {o}"),
                };
                self.stuck(slug, planner, &orig, plan, &reason);
                return false;
            }
            if aw == "final" {
                plan.insert("state".into(), "done".into());
                plan.insert("awaiting".into(), Value::Null);
                plan.insert("finishedAt".into(), now().into());
                if self.save_plan(slug, &planner.id, &orig, plan) {
                    self.note(slug, &planner.id, "Plan done: every ticket in this group finished and the final check ran.");
                    self.runs().notify(&format!("Plan done: {}", planner.title), "Every ticket in this group finished.", slug, &planner.id);
                }
                return false;
            }
            plan.insert("awaiting".into(), Value::Null);
        }
        let state = plan.get("state").and_then(Value::as_str).unwrap_or("").to_string();
        // A stuck main plan whose reason is gone runs again; the next round wakes it for its inbox as usual.
        if state == "stuck" && planner.main && !busy && self.unstick(slug, planner, &orig, &plan, kids) {
            return false;
        }
        if state == "stuck" && !planner.main {
            if !kids.is_empty() && kids.iter().all(|k| is_complete(k)) {
                self.close_plan(slug, planner, &orig, "Plan done: every ticket in this group finished, so the stuck plan was closed without another run.");
            }
            return false;
        }
        // The plan written back when it changed; false when the file's plan changed meanwhile.
        let save = |plan: Map<String, Value>| plan == orig || self.save_plan(slug, &planner.id, &orig, plan);
        if state == "finishing" {
            if !ckanban_core::jsnum::truthy(plan.get("awaiting")) && !busy {
                self.wake(slug, planner, &orig, plan, "final", Vec::new(), kids, Vec::new());
            } else {
                save(plan);
            }
            return false;
        }
        let step = plan_step(
            &plan,
            kids,
            &|id| self.is_running(slug, id),
            &|t| self.user_wait(t),
            &|t| self.last_summary(slug, &t.id),
            &|t| self.report_of(slug, &t.id),
        );
        let held = planner.main && (planner.status == "backlog" || planner.status == "done");
        let quiet = state == "stuck";
        if !held {
            for cid in &step.start {
                // Only a child still in Backlog, and only while the plan is the one this pass read (no Pause since):
                // both checked under the board's lock, where every ticket write happens.
                let r = self.change(slug, cid, |meta| {
                    let plan_now = self.get(slug, &planner.id).and_then(|t| Self::plan_of(&t));
                    if meta.get("status").and_then(Value::as_str) != Some("backlog") || !same_plan(plan_now.as_ref(), Some(&orig)) {
                        return Ok(None);
                    }
                    let mut p = Map::new();
                    p.insert("status".into(), "ready".into());
                    p.insert("mode".into(), "auto".into());
                    p.insert("outcome".into(), Value::Null);
                    p.insert("error".into(), Value::Null);
                    Ok(Some(p))
                });
                if let Ok(None) = r {
                    self.again.lock().insert(slug.to_string());
                }
            }
        }
        // Result cards go to the planner once its plan records the events (seen), so a pass that has to go again
        // doesn't add them twice.
        let mut cards: Vec<Value> = Vec::new();
        if !step.events.is_empty() {
            let mut inbox = plan.get("inbox").and_then(Value::as_array).cloned().unwrap_or_default();
            inbox.extend(step.events.iter().map(|e| Value::from(e.line.clone())));
            plan.insert("inbox".into(), Value::Array(inbox));
            let mut seen = plan.get("seen").and_then(Value::as_object).cloned().unwrap_or_default();
            for e in &step.events {
                seen.insert(e.child_id.clone(), e.sig.clone().into());
            }
            plan.insert("seen".into(), Value::Object(seen));
            cards = step.events.iter().filter(|e| e.result).filter_map(|e| self.result_card(slug, &e.child_id)).collect();
        }
        let starts = !step.start.is_empty();
        let with_cards = |written: bool, cards: Vec<Value>| {
            if written {
                self.add_results(slug, &planner.id, cards);
            }
        };
        if held || quiet {
            with_cards(save(plan), cards);
            return !held && starts;
        }
        let inbox: Vec<String> = plan.get("inbox").and_then(Value::as_array).into_iter().flatten().map(|v| or_empty(Some(v))).collect();
        if !busy && !ckanban_core::jsnum::truthy(plan.get("awaiting")) {
            if !inbox.is_empty() {
                let (_, no_progress, stuck) = progress_step(&plan, &family_sig(kids.iter().map(|k| &**k)));
                if stuck {
                    let waiting = slice16(&inbox.join("; "), 600).to_string();
                    let n = ckanban_core::jsnum::js_string(no_progress);
                    let written = self.stuck(slug, planner, &orig, plan, &format!("{n} wakes in a row without any tool ticket changing; waiting events: {waiting}"));
                    with_cards(written, cards);
                    return false;
                }
                let key = format!("{slug}\u{0}{}", planner.id);
                let due = self.wake_due.lock().get(&key).copied();
                match due {
                    None => {
                        self.wake_due.lock().insert(key, now_ms() + PLAN_WAKE_DELAY_MS as f64);
                        let me = self.me.clone();
                        let s = slug.to_string();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(PLAN_WAKE_DELAY_MS + 5));
                            if let Some(me) = me.upgrade() {
                                me.advance_plans(&s);
                            }
                        });
                    }
                    Some(due) if now_ms() >= due => {
                        // The wait ends only when the wake is written; a pass that has to go again wakes then.
                        if self.wake(slug, planner, &orig, plan, "event", inbox, kids, cards) {
                            self.wake_due.lock().remove(&key);
                        }
                        return starts;
                    }
                    Some(_) => {}
                }
                with_cards(save(plan), cards);
                return starts;
            }
            if step.all_complete || (planner.main && kids.is_empty()) {
                if planner.main {
                    plan.insert("state".into(), "done".into());
                    plan.insert("awaiting".into(), Value::Null);
                    plan.insert("reason".into(), Value::Null);
                    plan.insert("finishedAt".into(), now().into());
                    with_cards(self.save_plan(slug, &planner.id, &orig, plan), cards);
                    return false;
                }
                plan.insert("state".into(), "finishing".into());
                self.wake(slug, planner, &orig, plan, "final", Vec::new(), kids, cards);
                return false;
            }
            if let (Some(dead), false) = (&step.dead_end, starts) {
                with_cards(self.stuck(slug, planner, &orig, plan, dead), cards);
                return false;
            }
        }
        with_cards(save(plan), cards);
        starts
    }

    /// `openForm`: the questions form in the ticket's chat still waiting for the user's answers.
    fn open_form(&self, t: &Tk) -> Value {
        if crate::index::family::ask_closed(t) {
            return json!([]);
        }
        self.session(t).and_then(|s| s.get("openForm").cloned()).filter(|f| !f.is_null()).unwrap_or_else(|| json!([]))
    }

    /// `wake`: the planner's session resumes with what happened (several events as one message). Nothing happens
    /// when the file's plan is no longer `from` (the pass goes again); true when the wake was written and sent.
    #[allow(clippy::too_many_arguments)]
    fn wake(&self, slug: &str, planner: &Arc<Tk>, from: &Map<String, Value>, mut plan: Map<String, Value>, kind: &str, events: Vec<String>, kids: &[Arc<Tk>], cards: Vec<Value>) -> bool {
        let open: Vec<crate::prompts::types::Question> = serde_json::from_value(self.open_form(planner)).unwrap_or_default();
        let list = self.list(slug);
        let table = wake_table(kids, &list, &|id| self.is_running(slug, id));
        let pt: crate::prompts::types::Ticket = serde_json::from_value(Value::Object(planner.json.clone())).unwrap_or_default();
        let text = crate::prompts::main_role::main_wake_prompt(
            &pt,
            &crate::prompts::main_role::MainWake {
                kind: kind.into(),
                events,
                table,
                board: slug.into(),
                group: Some(!planner.main),
                open: Some(open),
            },
        );
        let (sig, no_progress, _) = progress_step(&plan, &family_sig(kids.iter().map(|k| &**k)));
        let wakeups = plan.get("wakeups").and_then(Value::as_f64).unwrap_or(0.0) + 1.0;
        plan.insert("inbox".into(), json!([]));
        plan.insert("awaiting".into(), kind.into());
        plan.insert("wakeups".into(), ckanban_core::jsnum::num(wakeups));
        plan.insert("progressSig".into(), sig.into());
        plan.insert("noProgress".into(), ckanban_core::jsnum::num(no_progress));
        if !self.save_plan(slug, &planner.id, from, plan) {
            return false;
        }
        self.add_results(slug, &planner.id, cards);
        let runs = self.runs();
        runs.auto_fresh(slug, &planner.id);
        if planner.main {
            if planner.status == "done" && self.open_steps(slug, &planner.id) {
                self.unpark_main(slug, &planner.id, "its steps are still at work", false);
            }
            runs.wake(slug, &planner.id, text, None);
            return true;
        }
        let back = if planner.status == "in_progress" { "review".to_string() } else { planner.status.clone() };
        runs.wake(slug, &planner.id, text, Some(back));
        true
    }

    // ---- Feature status (board-features.ts) ----

    /// `facts`: the board's facts for a feature's status, its saved changes included.
    pub fn facts(&self, slug: &str, list: &BoardList, top_id: &str, pr_notes: &Map<String, Value>) -> Map<String, Value> {
        let sub = |t: &Tk| SubFacts {
            working: self.is_running(slug, &t.id) || t.status == "ready" || t.status == "in_progress" || self.family_working(slug, list, &t.id) > 0,
            headline: read_status(&self.outputs_path(slug, &t.id)).and_then(|s| s.get("next").and_then(Value::as_str).map(str::to_string)),
        };
        let mut f = status_facts(list, top_id, &|t| self.waits_on_user(slug, list, t), pr_notes, &sub);
        f.insert("changes".into(), self.saved_changes(slug, list, top_id));
        f
    }

    /// `featureStatus`: the top of id's own feature, its saved status and the board's facts.
    pub fn feature_status(&self, slug: &str, id: &str) -> Result<FeatureStatus, String> {
        let list = self.list(slug);
        let top = feature_root(&list, id).map(|i| list.tickets[i].clone()).ok_or_else(|| Self::not_found(id))?;
        let dir = self.outputs_dir(slug, &top.id);
        let saved = read_status(&dir);
        let notes = saved.as_ref().and_then(|s| s.get("prNotes")).and_then(Value::as_object).cloned().unwrap_or_default();
        let facts = self.facts(slug, &list, &top.id, &notes);
        let feature = is_feature(&list, &top);
        Ok(FeatureStatus { top, feature, saved, facts, path: status_md(&dir) })
    }

    /// `refreshStatusFile`: status.md rewritten from the saved status and the facts now.
    pub fn refresh_status_file(&self, slug: &str, id: &str) -> Option<PathBuf> {
        let _g = self.status_lock.lock();
        let f = self.feature_status(slug, id).ok()?;
        if f.saved.is_none() && !f.feature {
            return None;
        }
        let dir = self.outputs_dir(slug, &f.top.id);
        if let Err(e) = write_status(&dir, &f.top.id, &f.top.title, f.saved.as_ref(), &f.facts, false) {
            eprintln!("[board] status of {slug}/{}: {e}", f.top.id);
        }
        Some(f.path)
    }

    /// `updateStatus` (update_status): only the sections the patch names change, on the top of id's family.
    pub fn update_status(&self, slug: &str, id: &str, patch: &[(String, Option<String>)], pr_notes: Option<&[(String, Option<String>)]>) -> Result<(FeatureStatus, String), String> {
        let _g = self.status_lock.lock();
        let list = self.list(slug);
        let top = feature_root(&list, id).map(|i| list.tickets[i].clone()).ok_or_else(|| Self::not_found(id))?;
        let dir = self.outputs_dir(slug, &top.id);
        let at = now();
        let rows = feature_rows(&list, &top.id);
        let sig = family_sig(rows.iter().skip(1).map(|r| list.at(r.idx)));
        let saved = apply_patch(read_status(&dir), patch, pr_notes, &at, &sig);
        let notes = saved.get("prNotes").and_then(Value::as_object).cloned().unwrap_or_default();
        let facts = self.facts(slug, &list, &top.id, &notes);
        let markdown = write_status(&dir, &top.id, &top.title, Some(&saved), &facts, true).map_err(|e| e.to_string())?;
        self.patch(slug, &top.id, one("statusAt", at.into()))?;
        Ok((self.feature_status(slug, &top.id)?, markdown))
    }

    /// `addStatusNote` ("Add a note"): saved in the status under its date.
    pub fn add_status_note(&self, slug: &str, id: &str, text: &str) -> Result<FeatureStatus, String> {
        let note = slice16(js_trim(text), STATUS_NOTE_MAX).to_string();
        if note.is_empty() {
            return Err("the note is empty".into());
        }
        let _g = self.status_lock.lock();
        let list = self.list(slug);
        let top = feature_root(&list, id).map(|i| list.tickets[i].clone()).ok_or_else(|| Self::not_found(id))?;
        let dir = self.outputs_dir(slug, &top.id);
        let at = now();
        let mut saved = read_status(&dir).unwrap_or_default();
        saved.insert("updatedAt".into(), at.clone().into());
        let mut notes = saved.get("notes").and_then(Value::as_array).cloned().unwrap_or_default();
        notes.push(json!({ "at": at, "text": note, "delivered": false }));
        saved.insert("notes".into(), Value::Array(notes));
        let pr = saved.get("prNotes").and_then(Value::as_object).cloned().unwrap_or_default();
        let facts = self.facts(slug, &list, &top.id, &pr);
        write_status(&dir, &top.id, &top.title, Some(&saved), &facts, true).map_err(|e| e.to_string())?;
        self.patch(slug, &top.id, one("statusAt", at.into()))?;
        self.feature_status(slug, &top.id)
    }

    /// `land_milestone`'s record: the milestone in the status (last 20), statusAt and a comment.
    pub fn record_milestone(&self, slug: &str, id: &str, text: &str, landed: &str) -> Result<(), String> {
        let _g = self.status_lock.lock();
        let t = self.get(slug, id).ok_or_else(|| Self::not_found(id))?;
        let dir = self.outputs_dir(slug, id);
        let mut saved = read_status(&dir).unwrap_or_default();
        saved.insert("updatedAt".into(), now().into());
        let mut ms = saved.get("milestones").and_then(Value::as_array).cloned().unwrap_or_default();
        ms.push(json!({ "at": now(), "summary": text, "landed": landed }));
        let keep = ms.len().saturating_sub(20);
        saved.insert("milestones".into(), Value::Array(ms[keep..].to_vec()));
        let list = self.list(slug);
        let pr = saved.get("prNotes").and_then(Value::as_object).cloned().unwrap_or_default();
        let facts = self.facts(slug, &list, id, &pr);
        write_status(&dir, id, &t.title, Some(&saved), &facts, true).map_err(|e| e.to_string())?;
        self.patch(slug, id, one("statusAt", now().into()))?;
        self.note(slug, id, &format!("Milestone landed: {text} ({landed})."));
        Ok(())
    }

    /// `savedChanges`: a feature's saved changes from the cache (null until first built); rebuilt in the background
    /// when the family changed or after CHANGES_TTL_MS.
    fn saved_changes(&self, slug: &str, list: &BoardList, top_id: &str) -> Value {
        let Some(top) = list.get(top_id) else { return Value::Null };
        if !(is_feature(list, top) || top.is("statusAt")) {
            return Value::Null;
        }
        let key = format!("{slug}\u{0}{top_id}");
        let rows = feature_rows(list, top_id);
        let sig = family_sig(rows.iter().map(|r| list.at(r.idx)));
        let (stale, value) = match self.changes.lock().get(&key) {
            Some(c) => (c.sig != sig || now_ms() - c.at > CHANGES_TTL_MS, c.value.clone()),
            None => (true, Value::Null),
        };
        if stale && !self.stopping() && self.changes_checks.lock().insert(key.clone()) {
            let me = self.me.clone();
            let (slug, top_id) = (slug.to_string(), top_id.to_string());
            std::thread::spawn(move || {
                if let Some(me) = me.upgrade() {
                    me.build_changes(&slug, &top_id, &key, sig);
                    me.changes_checks.lock().remove(&key);
                }
            });
        }
        value
    }

    fn build_changes(&self, slug: &str, top_id: &str, key: &str, sig: String) {
        let prev = self.changes.lock().get(key).map(|c| c.value.clone()).unwrap_or(Value::Null);
        let value = self.read_changes(slug, top_id).unwrap_or_else(|| prev.clone());
        self.changes.lock().insert(key.to_string(), ChangesEntry { at: now_ms(), sig, value: value.clone() });
        if value == prev || value.is_null() || self.stopping() {
            return;
        }
        let Some(top) = self.get(slug, top_id) else { return };
        if let Some(file) = value.get("file").and_then(Value::as_str) {
            let _ = std::fs::write(file, saved_changes_markdown(&top.title, &value));
        }
        self.refresh_status_file(slug, top_id);
        let _ = self.patch(slug, top_id, one("statusAt", now().into()));
    }

    /// `readChanges`: with version history, the entries carrying "Ckanban-Feature: <topId>" on the base branch (and
    /// its remote copy) and the main ticket's copy, newest first; without, the files the family's tickets edited.
    /// None when it can't tell (a failing git): the last list stays.
    fn read_changes(&self, slug: &str, top_id: &str) -> Option<Value> {
        let profile = self.profile(slug)?;
        let path = PathBuf::from(profile.get("path").and_then(Value::as_str)?);
        let list = self.list(slug);
        let top = list.get(top_id)?.clone();
        let full = self.outputs_dir(slug, top_id).join(SAVED_CHANGES_FILE);
        let with_file = |kind: &str, items: Vec<Value>| -> Value {
            let mut m = Map::new();
            m.insert("kind".into(), kind.into());
            let more = items.len() > super::status::CHANGES_SHOWN;
            m.insert("items".into(), Value::Array(items));
            if more {
                m.insert("file".into(), full.to_string_lossy().into_owned().into());
            }
            Value::Object(m)
        };
        let repo = wait(crate::git::repo::repo_kind(&path, false));
        use crate::git::repo::RepoKind;
        if matches!(repo, RepoKind::Local | RepoKind::Remote) {
            let base = profile.get("baseBranch").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or("main").to_string();
            // A branch name is a ref, never an option: one starting with "-" is left out of the git arguments.
            let mut refs: Vec<String> = vec![base.clone()].into_iter().filter(|r| !r.starts_with('-')).collect();
            if repo == RepoKind::Remote {
                refs.push(format!("origin/{base}"));
            }
            let grep = format!("--grep=^{FEATURE_TRAILER}: {top_id}$");
            let branch = top.s("branch").filter(|s| !s.is_empty() && !s.starts_with('-')).map(str::to_string);
            if refs.is_empty() && branch.is_none() {
                // Nothing left to read (git log would read the current branch instead).
                return None;
            }
            let mut args = vec!["log".to_string(), "--ignore-missing".into(), "--format=%H%x09%h%x09%s".into(), grep.clone()];
            args.extend(refs.iter().cloned());
            args.extend(branch.iter().cloned());
            args.push("--".into());
            let out = git(&path, &args)?;
            let all: Vec<(String, String, String)> = out
                .split('\n')
                .filter(|l| !js_trim(l).is_empty())
                .map(|l| {
                    let mut p = l.split('\t');
                    let full = p.next().unwrap_or("").to_string();
                    let id = p.next().unwrap_or("").to_string();
                    (full, id, js_trim(&p.collect::<Vec<_>>().join("\t")).to_string())
                })
                .collect();
            let dropped = match &branch {
                Some(b) => copy_duplicates(&path, &grep, &refs, b, &all),
                None => HashSet::new(),
            };
            let items: Vec<Value> = all.iter().filter(|c| !dropped.contains(&c.0)).map(|(_, id, text)| json!({ "id": id, "text": text })).collect();
            return Some(if items.is_empty() { Value::Null } else { with_file("history", items) });
        }
        let mut files: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for r in feature_rows(&list, top_id) {
            let t = list.at(r.idx);
            if r.depth == 0 || !t.main {
                let log = self.tickets.ticket_dir(slug, &t.id).join("activity.jsonl");
                for f in self.digests.get_now(&log).edited {
                    if seen.insert(f.clone()) {
                        files.push(f);
                    }
                }
            }
        }
        let p = path.to_string_lossy();
        let root = if p.ends_with('/') { p.to_string() } else { format!("{p}/") };
        let mut items: Vec<String> = files.into_iter().map(|f| f.strip_prefix(&root).map(str::to_string).unwrap_or(f)).collect();
        items.sort_by(|a, b| crate::runs::js::cmp16(a, b));
        let items: Vec<Value> = items.into_iter().map(|t| json!({ "text": t })).collect();
        Some(if items.is_empty() { Value::Null } else { with_file("files", items) })
    }
}

/// Waits for an async check from any thread: inside the runtime (a hook's future, an async caller) on a thread of its
/// own, so the runtime's thread is never asked to block on itself.
fn wait<T: Send>(f: impl std::future::Future<Output = T> + Send) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => std::thread::scope(|s| s.spawn(|| h.block_on(f)).join().expect("the check's thread")),
        Err(_) => crate::tickets::writer::block(f),
    }
}

/// `git <args>` in dir: its output, None when it fails or takes longer than 20 s.
fn git(dir: &Path, args: &[String]) -> Option<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    limited(cmd, dir)
}

/// The command's output in dir, None when it fails or takes longer than 20 s (Bun's `runCmd` timeout). It runs in a
/// process group of its own, so a hung pipeline (sh and the gits under it) is killed whole.
fn limited(mut cmd: std::process::Command, dir: &Path) -> Option<String> {
    use std::os::unix::process::CommandExt;
    let mut child = cmd
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = std::io::Read::read_to_end(&mut out, &mut s);
        s
    });
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let bytes = reader.join().ok()?;
                return st.success().then(|| String::from_utf8_lossy(&bytes).into_owned());
            }
            Ok(None) if start.elapsed() > std::time::Duration::from_secs(20) => {
                // SAFETY: kill(2) on the group this child leads; no memory is touched.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
}

/// `copyDuplicates`: entries only on the main ticket's copy whose change is already on the base branch (same patch,
/// or same subject line). Empty when unsure.
fn copy_duplicates(cwd: &Path, grep: &str, base_refs: &[String], branch: &str, all: &[(String, String, String)]) -> HashSet<String> {
    let mut dropped = HashSet::new();
    let mut args = vec!["log".to_string(), "--ignore-missing".into(), "--format=%H".into(), grep.into(), branch.into(), "--not".into()];
    args.extend(base_refs.iter().cloned());
    args.push("--".into());
    let Some(out) = git(cwd, &args) else { return dropped };
    let copy_only: HashSet<String> = out.split('\n').map(|l| js_trim(l).to_string()).filter(|l| !l.is_empty()).collect();
    let on_base: Vec<&(String, String, String)> = all.iter().filter(|c| !copy_only.contains(&c.0)).collect();
    if copy_only.is_empty() || on_base.is_empty() {
        return dropped;
    }
    let subjects: HashSet<&str> = on_base.iter().map(|c| c.2.as_str()).collect();
    for c in all {
        if copy_only.contains(&c.0) && subjects.contains(c.2.as_str()) {
            dropped.insert(c.0.clone());
        }
    }
    let rest: Vec<String> = all.iter().filter(|c| copy_only.contains(&c.0) && !dropped.contains(&c.0)).map(|c| c.0.clone()).collect();
    if rest.is_empty() {
        return dropped;
    }
    let mut sh = vec![
        "-c".to_string(),
        "git log --no-walk=unsorted -p --no-color --format=\"commit %H\" \"$@\" | git patch-id --stable".into(),
        "sh".into(),
    ];
    sh.extend(on_base.iter().map(|c| c.0.clone()));
    sh.extend(rest.iter().cloned());
    let mut cmd = std::process::Command::new("sh");
    cmd.args(&sh);
    let Some(text) = limited(cmd, cwd) else { return dropped };
    let by_commit: HashMap<String, String> = text
        .split('\n')
        .filter_map(|l| {
            let p: Vec<&str> = js_trim(l).split(' ').collect();
            (p.len() == 2).then(|| (p[1].to_string(), p[0].to_string()))
        })
        .collect();
    let base_patches: HashSet<&String> = on_base.iter().filter_map(|c| by_commit.get(&c.0)).collect();
    for sha in rest {
        if by_commit.get(&sha).is_some_and(|p| base_patches.contains(p)) {
            dropped.insert(sha);
        }
    }
    dropped
}

/// The parent a ticket hangs under now (for callers outside: `parentLink(t)?.id`).
pub fn parent_id_of(list: &BoardList, t: &Tk) -> Option<String> {
    parent_in(list, t).map(|(p, _)| list.at(p).id.clone())
}
