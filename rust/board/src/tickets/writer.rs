//! The board's ticket writes (plan 2.2): the writing half of `Store` (`createTicket`, `updateTicket`, `deleteTicket`,
//! `addComment` in `src/core/store.ts`) and the board calls on top of it (`createTicket`, `updateTicket`,
//! `deleteTicket`, `moveTicket`, `patch`, `addComment` in `src/board/`). The only code that writes `ticket.md` in
//! board mode.
//!
//! Each write takes the board's write lock, writes the file (atomic, Bun's bytes through `ckanban_core::ticket`),
//! puts the ticket in the index's listing (`Index::saved`) and sends `ticket.updated` or `ticket.deleted`, in that
//! order, so the file order is the order of the listing and of the events. Blocking: call from a blocking thread.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::atomic::new_id;
use ckanban_core::jsnum::truthy;
use ckanban_core::layout::new_ticket_id;
use ckanban_core::ticket::{self as tfile, NewTicket, Ticket};
use ckanban_core::time::{iso, now_ms};
use parking_lot::{Mutex, RwLock};
use serde_json::{Map, Value, json};

use super::hooks::{BoardHooks, NoHooks};
use super::norm::{normalize_needs, normalize_tags, starred_title};
use crate::api::RunControl;
use crate::bus::Bus;
use crate::index::family::{feature_rows, main_of};
use crate::index::store::Index;
use crate::index::ticket::Tk;

/// A refusal: the HTTP status and Bun's message.
pub type Refusal = (u16, String);

pub fn bad(msg: impl Into<String>) -> Refusal {
    (400, msg.into())
}

/// `maskSaved`: the saved keys of this Mac hidden in a text about to be written.
pub type TextMask = Arc<dyn Fn(&str) -> String + Send + Sync>;

type Written = Arc<dyn Fn(&str, &str) + Send + Sync>;

pub struct Tickets {
    pub root: PathBuf,
    pub index: Arc<Index>,
    pub bus: Arc<Bus>,
    pub runs: Arc<dyn RunControl>,
    hooks: RwLock<Arc<dyn BoardHooks>>,
    mask: RwLock<TextMask>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    written: RwLock<Vec<Written>>,
}

pub fn now() -> String {
    iso(now_ms())
}

fn obj(t: &Ticket) -> Map<String, Value> {
    match t.to_json() {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

impl Tickets {
    pub fn new(index: Arc<Index>, bus: Arc<Bus>, runs: Arc<dyn RunControl>, mask: TextMask) -> Arc<Tickets> {
        Arc::new(Tickets {
            root: index.root().to_path_buf(),
            index,
            bus,
            runs,
            hooks: RwLock::new(Arc::new(NoHooks)),
            mask: RwLock::new(mask),
            locks: Mutex::new(HashMap::new()),
            written: RwLock::new(Vec::new()),
        })
    }

    /// `maskSaved` for comments (the server's pass store; no masking until set).
    pub fn set_mask(&self, mask: TextMask) {
        *self.mask.write() = mask;
    }

    /// The later board steps' hooks (R2b, R6, R7a...); stand-ins until set.
    pub fn set_hooks(&self, hooks: Arc<dyn BoardHooks>) {
        *self.hooks.write() = hooks;
    }
    pub fn hooks(&self) -> Arc<dyn BoardHooks> {
        self.hooks.read().clone()
    }

    /// Called after each ticket write with (board, ticket id): the session watcher looks at it next (R5).
    pub fn on_written(&self, f: impl Fn(&str, &str) + Send + Sync + 'static) {
        self.written.write().push(Arc::new(f));
    }

    /// The board's write lock: one write of a board's tickets at a time.
    fn lock(&self, slug: &str) -> Arc<Mutex<()>> {
        self.locks.lock().entry(slug.to_string()).or_default().clone()
    }

    pub fn ticket_dir(&self, slug: &str, id: &str) -> PathBuf {
        self.index.ticket_dir(slug, id)
    }

    fn ticket_file(&self, slug: &str, id: &str) -> PathBuf {
        self.ticket_dir(slug, id).join("ticket.md")
    }

    /// `getTicket`: the ticket, its file stat'ed now.
    pub fn get(&self, slug: &str, id: &str) -> Option<Arc<Tk>> {
        self.index.ticket(slug, id)
    }

    /// The board's tickets now (`listTickets`).
    pub fn list(&self, slug: &str) -> Arc<crate::index::store::BoardList> {
        self.index.list(slug)
    }

    // ---- Store (store.ts) ----

    /// `entryOrder`: where a ticket lands when it enters a column: on top, except Ready, which is a FIFO run queue.
    pub fn entry_order(&self, slug: &str, status: &str) -> f64 {
        let list = self.index.list(slug);
        let column = |i: usize| {
            let t = list.at(i);
            (t.status == status).then_some(t.order)
        };
        let orders: Vec<f64> = if status == "done" {
            (0..list.tickets.len()).filter_map(column).collect()
        } else {
            list.open().iter().copied().filter_map(column).collect()
        };
        if status == "ready" {
            let mut max = f64::NEG_INFINITY;
            for o in orders {
                if o > max {
                    max = o;
                }
            }
            if max == f64::NEG_INFINITY { 1.0 } else { max + 1.0 }
        } else {
            let mut min = f64::INFINITY;
            for o in orders {
                if o < min {
                    min = o;
                }
            }
            if min == f64::INFINITY { 1.0 } else { min - 1.0 }
        }
    }

    /// Puts the written ticket in the listing. `body_after`: the key `body` follows in Bun's in-memory object (its
    /// answers keep that order until the file is read again): "updatedAt" for a new ticket (the object literal of
    /// `createTicket`), else the last key the file had before the change (`{...parsed, ...patch}`).
    fn installed(&self, slug: &str, id: &str, t: &Ticket, body_after: Option<&str>) -> Arc<Tk> {
        let json = match body_after {
            None => obj(t),
            Some(after) => {
                let mut m = Map::new();
                let mut placed = false;
                for (k, v) in &t.meta {
                    m.insert(k.clone(), v.clone());
                    if k == after {
                        m.insert("body".into(), Value::String(t.body.clone()));
                        placed = true;
                    }
                }
                if !placed {
                    m.insert("body".into(), Value::String(t.body.clone()));
                }
                m
            }
        };
        let tk = Arc::new(Tk::from_json(json, false));
        self.index.saved(slug, id, Some(tk.clone()));
        tk
    }

    /// `Store.createTicket` (the board's lock held).
    fn store_create(&self, slug: &str, input: NewTicket) -> Result<Arc<Tk>, Refusal> {
        let at = now();
        let id = new_ticket_id(now_ms());
        let order = self.entry_order(slug, &input.status);
        let t = tfile::new_ticket(input, &id, order, &at);
        let file = self.ticket_file(slug, &id);
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| (500, e.to_string()))?;
        }
        tfile::write(&file, &t).map_err(|e| (500, e.to_string()))?;
        Ok(self.installed(slug, &id, &t, Some("updatedAt")))
    }

    /// `Store.updateTicket` (the board's lock held): the file read now, the patch merged, written back.
    fn store_update(&self, slug: &str, id: &str, patch: &Map<String, Value>, keep_updated_at: bool) -> Result<Arc<Tk>, Refusal> {
        let file = self.ticket_file(slug, id);
        let current = match tfile::read(&file) {
            Ok(Some(Ok(t))) => t,
            Ok(Some(Err(e))) => return Err((500, e.to_string())),
            Ok(None) => return Err((404, format!("ticket {id} not found"))),
            Err(e) => return Err((500, e.to_string())),
        };
        let next = tfile::apply_patch(&current, patch, &now(), keep_updated_at, |st| self.entry_order(slug, st));
        tfile::write(&file, &next).map_err(|e| (500, e.to_string()))?;
        let last = current.meta.keys().next_back().cloned();
        Ok(self.installed(slug, id, &next, Some(last.as_deref().unwrap_or("updatedAt"))))
    }

    /// `Store.deleteTicket` (the board's lock held).
    fn store_delete(&self, slug: &str, id: &str) {
        let dir = self.ticket_dir(slug, id);
        if let Err(e) = std::fs::remove_dir_all(&dir)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("[board] can't remove {}: {e}", dir.display());
        }
        self.index.saved(slug, id, None);
    }

    /// `Store.addComment`: a saved key never lands in the ticket's files. Returns the comment.
    pub fn store_comment(&self, slug: &str, id: &str, author: &str, text: &str, from: Option<&str>) -> Result<Value, Refusal> {
        let mut c = json!({ "id": new_id(), "author": author, "text": (self.mask.read().clone())(text), "at": now() });
        if let Some(f) = from.filter(|f| !f.is_empty()) {
            c["from"] = Value::from(f);
        }
        let file = self.ticket_dir(slug, id).join("comments.jsonl");
        let line = format!("{}\n", serde_json::to_string(&c).unwrap_or_default());
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file).map_err(|e| (500, e.to_string()))?;
        f.write_all(line.as_bytes()).map_err(|e| (500, e.to_string()))?;
        Ok(c)
    }

    /// `Store.listComments`.
    pub fn comments(&self, slug: &str, id: &str) -> Vec<Value> {
        let file = self.ticket_dir(slug, id).join("comments.jsonl");
        let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
        text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str(l).ok()).collect()
    }

    // ---- Board ----

    /// `emitTicket`.
    pub fn emit(&self, slug: &str, t: &Tk) {
        self.bus.emit_json(json!({ "type": "ticket.updated", "profile": slug, "ticket": Value::Object(t.json.clone()) }));
        for f in self.written.read().iter() {
            f(slug, &t.id);
        }
    }

    fn emit_deleted(&self, slug: &str, id: &str) {
        self.bus.emit_json(json!({ "type": "ticket.deleted", "profile": slug, "id": id }));
    }

    /// `Board.patch`: written and sent. A new activity line is stamped (`lastActivityAt`).
    pub fn patch(&self, slug: &str, id: &str, mut patch: Map<String, Value>) -> Result<Arc<Tk>, Refusal> {
        if patch.contains_key("lastActivity") && !patch.contains_key("lastActivityAt") {
            let at = if truthy(patch.get("lastActivity")) { Value::from(now()) } else { Value::Null };
            patch.insert("lastActivityAt".into(), at);
        }
        let lock = self.lock(slug);
        let _g = lock.lock();
        let t = self.store_update(slug, id, &patch, false)?;
        self.emit(slug, &t);
        Ok(t)
    }

    /// A store write without a `ticket.updated` (the card routes send one themselves, as Bun's `emitTicket`).
    pub fn update_quiet(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Result<Arc<Tk>, Refusal> {
        let lock = self.lock(slug);
        let _g = lock.lock();
        self.store_update(slug, id, &patch, false)
    }

    /// `Board.addComment` (`from`: another ticket's run left it, shown as Claude's) and the ticket's view sent.
    pub fn add_comment(&self, slug: &str, id: &str, text: &str, from: Option<&str>) -> Result<Value, Refusal> {
        let c = self.store_comment(slug, id, if from.is_some() { "ai" } else { "user" }, text, from)?;
        if let Some(t) = self.get(slug, id) {
            self.emit(slug, &t);
        }
        Ok(c)
    }

    /// `Store.addComment(slug, id, "ai", text)` where Bun writes a board note (no event of its own).
    pub fn note(&self, slug: &str, id: &str, text: &str) {
        if let Err((_, e)) = self.store_comment(slug, id, "ai", text, None) {
            eprintln!("[board] can't write a comment on {slug}/{id}: {e}");
        }
    }

    /// `Board.createTicket`. `input` holds `createTicket`'s fields by Bun's names.
    pub fn create(&self, slug: &str, mut input: Map<String, Value>) -> Result<Arc<Tk>, Refusal> {
        if input.get("status").and_then(Value::as_str) == Some("in_progress") {
            input.insert("status".into(), "ready".into());
        }
        self.hooks().place_in_feature(slug, &mut input).map_err(bad)?;
        let s = |k: &str| input.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let title = input.get("title").and_then(Value::as_str).unwrap_or("").to_string();
        let (star_title, starred) = starred_title(&title);
        let star = starred && !crate::index::text::js_trim(&star_title).is_empty();
        let list = |k: &str| match input.get(k) {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => Vec::new(),
        };
        let status = s("status").unwrap_or_else(|| "backlog".into());
        let nt = NewTicket {
            title: if star { star_title } else { title },
            body: input.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
            status: status.clone(),
            mode: s("mode"),
            schedule_id: s("scheduleId"),
            job_id: s("jobId"),
            source: input.get("source").cloned(),
            parent_id: s("parentId"),
            plan_key: s("planKey"),
            proposed_as: s("proposedAs"),
            made_from: s("madeFrom"),
            depends_on: list("dependsOn"),
            needs: normalize_needs(input.get("needs")),
            tags: normalize_tags(input.get("tags")),
            important: star || truthy(input.get("important")),
            part_of: s("partOf"),
            part_of_via: s("partOfVia"),
            model: s("model"),
            raised_by: input.get("raisedBy").cloned(),
            kind: s("kind"),
            effort: s("effort"),
            main: truthy(input.get("main")),
            waits_for_start: truthy(input.get("waitsForStart")),
            tool: truthy(input.get("tool")),
            start_from: s("startFrom"),
        };
        let parent_id = nt.parent_id.clone();
        let t = {
            let lock = self.lock(slug);
            let _g = lock.lock();
            let t = self.store_create(slug, nt)?;
            self.emit(slug, &t);
            t
        };
        // The parent's card shows its family (its task counts).
        if let Some(p) = parent_id.as_deref().and_then(|p| self.get(slug, p)) {
            self.emit(slug, &p);
        }
        self.hooks().after_create(slug, &t.id, &status, parent_id.is_some());
        Ok(self.get(slug, &t.id).unwrap_or(t))
    }

    /// `markStartedBy`: who started the ticket's latest run (None: the user).
    pub fn mark_started_by(&self, slug: &str, id: &str, by: Option<Value>) {
        let Some(t) = self.get(slug, id) else { return };
        if !truthy(t.get("startedBy")) && by.is_none() {
            return;
        }
        let mut p = Map::new();
        p.insert("startedBy".into(), by.unwrap_or(Value::Null));
        if let Err((_, e)) = self.patch(slug, id, p) {
            eprintln!("[board] startedBy on {slug}/{id}: {e}");
        }
    }

    /// `Board.updateTicket`: the user's or a run's change to a ticket. `patch` holds Bun's patch fields (`title`,
    /// `body`, `status`, `order`, `mode`, `notice`, `dependsOn`, `needs`, `tags`, `suggestedTags`, `important`,
    /// `runCapUsd`, `model`, `effort`, `ultracode`, `chrome`, `browsers`, `expectedBody`, `parentId: null`, `pinned`).
    /// A Conflict is 409, other refusals 400.
    pub fn update(&self, slug: &str, id: &str, patch: &Map<String, Value>, by_user: bool) -> Result<Arc<Tk>, Refusal> {
        let mut current = self.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))?;
        if let (Some(Value::String(_)), Some(Value::String(expected))) = (patch.get("body"), patch.get("expectedBody")) {
            if *expected != current.body {
                return Err((409, "description changed since you started editing (Claude may have updated it); reload and retry".into()));
            }
        }
        let mut clean = Map::new();
        if let Some(Value::String(title)) = patch.get("title") {
            let (st, starred) = starred_title(title);
            let t = if starred && !crate::index::text::js_trim(&st).is_empty() { st } else { title.clone() };
            if t != *title {
                clean.insert("important".into(), Value::Bool(true));
            }
            clean.insert("title".into(), t.into());
        }
        for k in ["body", "order", "mode", "notice", "runCapUsd", "model", "effort", "ultracode", "chrome", "browsers"] {
            if let Some(v) = patch.get(k) {
                clean.insert(k.into(), v.clone());
            }
        }
        if patch.contains_key("needs") {
            clean.insert("needs".into(), json!(normalize_needs(patch.get("needs"))));
        }
        if patch.contains_key("tags") {
            clean.insert("tags".into(), json!(normalize_tags(patch.get("tags"))));
        }
        if patch.contains_key("suggestedTags") || patch.contains_key("tags") {
            // A suggestion that is now a tag is no longer a suggestion.
            let tags: Vec<String> = match clean.get("tags") {
                Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
                None => current.tags.clone(),
            };
            let from = patch.get("suggestedTags").or_else(|| current.get("suggestedTags"));
            let kept: Vec<String> = normalize_tags(from).into_iter().filter(|s| !tags.contains(s)).collect();
            clean.insert("suggestedTags".into(), json!(kept));
        }
        if let Some(v) = patch.get("important") {
            clean.insert("important".into(), Value::Bool(truthy(Some(v))));
        }
        if let Some(v) = patch.get("pinned") {
            clean.insert("pinnedAt".into(), if truthy(Some(v)) { now().into() } else { Value::Null });
        }
        let cleared_parent = patch.get("parentId") == Some(&Value::Null) && current.parent_id.is_some();
        if cleared_parent {
            let planner = current.parent_id.clone().unwrap_or_default();
            let list = self.list(slug);
            let me = &current;
            let users: Vec<&Arc<Tk>> = children_of(&list, &planner)
                .into_iter()
                .filter(|s| s.id != id && !resolve_deps(s, &[(*s).clone(), me.clone()]).0.is_empty())
                .collect();
            if !users.is_empty() {
                let names: Vec<String> = users.iter().map(|u| format!("\"{}\"", u.title)).collect();
                let verb = if users.len() == 1 { "depends" } else { "depend" };
                return Err(bad(format!("{} {verb} on this ticket; change their dependsOn first", names.join(", "))));
            }
            clean.insert("parentId".into(), Value::Null);
            clean.insert("planKey".into(), Value::Null);
            clean.insert("dependsOn".into(), json!([]));
        }
        if let Some(deps) = patch.get("dependsOn").filter(|_| !cleared_parent) {
            clean.insert("dependsOn".into(), deps.clone());
            if let Some(planner) = current.parent_id.clone() {
                let list = self.list(slug);
                let mut siblings: Vec<Arc<Tk>> = children_of(&list, &planner).into_iter().cloned().collect();
                for s in siblings.iter_mut() {
                    if s.id == id {
                        let mut j = s.json.clone();
                        j.insert("dependsOn".into(), deps.clone());
                        *s = Arc::new(Tk::from_json(j, false));
                    }
                }
                if let Some(me) = siblings.iter().find(|s| s.id == id) {
                    let missing = resolve_deps(me, &siblings).1;
                    if !missing.is_empty() {
                        let names: Vec<String> = missing.iter().map(|m| format!("\"{m}\"")).collect();
                        return Err(bad(format!("unknown dependency {}: use a sibling's ticket id or key", names.join(", "))));
                    }
                }
                if let Some(cycle) = find_cycle(&siblings) {
                    return Err(bad(format!("dependency cycle: {}", cycle.join(" → "))));
                }
            }
        }
        let mut status = patch.get("status").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        // A reply waiting for a slot stays put when reordered; moved elsewhere, it stops waiting.
        if current.slot_wait.is_some() && status.as_deref() == Some("in_progress") {
            status = None;
        }
        if status.as_deref() == Some("in_progress") && !self.runs.is_running(slug, id) {
            status = Some("ready".into());
        }
        if current.slot_wait.is_some() && status.is_some() {
            current = self.cancel_slot_wait(slug, id)?;
        }
        let was_running = self.runs.is_running(slug, id);
        if was_running && status.as_deref().is_some_and(|s| s != "in_progress") {
            let hooks = self.hooks();
            block(hooks.stop_run(slug, id, status.as_deref()));
            current = self.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))?;
        }
        if let Some(st) = status.as_deref().filter(|s| *s != current.status) {
            clean.insert("status".into(), st.into());
        }
        let new_status = clean.get("status").and_then(Value::as_str).map(str::to_string);
        if new_status.is_some() {
            // Moved by hand: the user takes it from here (no automatic continue, no auto huddle wait, no snooze).
            for k in ["limit", "autoHuddle", "snooze"] {
                if truthy(current.get(k)) {
                    clean.insert(k.into(), Value::Null);
                }
            }
            if truthy(current.get("waitsForStart")) {
                clean.insert("waitsForStart".into(), Value::Bool(false));
            }
        }
        let shaping = matches!(new_status.as_deref(), Some("planning" | "backlog"));
        if shaping && matches!(current.status.as_str(), "review" | "done") {
            let outcome = current.get("outcome").cloned().unwrap_or(Value::Null);
            clean.insert("reopenedFrom".into(), json!({ "status": current.status, "outcome": outcome }));
        } else if new_status.is_some() && !shaping && truthy(current.get("reopenedFrom")) {
            clean.insert("reopenedFrom".into(), Value::Null);
        }
        self.patch(slug, id, clean)?;
        let hooks = self.hooks();
        block(hooks.after_update(slug, id, new_status.as_deref(), by_user, was_running));
        self.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))
    }

    /// `cancelSlotWait`: back where it was before it waited for a slot; its queued messages wait for the user.
    pub fn cancel_slot_wait(&self, slug: &str, id: &str) -> Result<Arc<Tk>, Refusal> {
        let t = self.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))?;
        let from = t.get("slotWait").and_then(|s| s.get("from")).filter(|f| f.is_object());
        let (status, outcome) = match from {
            Some(f) => (f.get("status").cloned().unwrap_or(Value::Null), f.get("outcome").cloned().unwrap_or(Value::Null)),
            None => (Value::from("review"), t.get("outcome").cloned().unwrap_or(Value::Null)),
        };
        let queued: Vec<Value> = match t.get("queued") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|m| {
                    let mut m = m.clone();
                    if m.get("state").and_then(Value::as_str) == Some("queued") {
                        m["state"] = "unsent".into();
                    }
                    m
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut p = Map::new();
        p.insert("status".into(), status);
        p.insert("outcome".into(), outcome);
        p.insert("slotWait".into(), Value::Null);
        p.insert("lastActivity".into(), Value::Null);
        p.insert("queued".into(), Value::Array(queued));
        self.patch(slug, id, p)
    }

    /// `toolTickets`: a main ticket's own tool tickets (from its feature rows; not a sub-feature's).
    pub fn tool_tickets(&self, slug: &str, main_id: &str) -> Vec<Arc<Tk>> {
        let list = self.list(slug);
        feature_rows(&list, main_id).into_iter().map(|r| list.tickets[r.idx].clone()).filter(|t| t.id != main_id && t.tool).collect()
    }

    /// The main ticket above `t` (`mainOf`).
    pub fn main_of(&self, slug: &str, t: &Tk) -> Option<Arc<Tk>> {
        let list = self.list(slug);
        main_of(&list, t).map(|i| list.tickets[i].clone())
    }

    /// `Board.deleteTicket`: a main ticket takes its tool tickets with it, deepest first; refused while a merge runs.
    pub fn delete(&self, slug: &str, id: &str) -> Result<(), Refusal> {
        let hooks = self.hooks();
        if let Some(t0) = self.get(slug, id) {
            if t0.main {
                if hooks.merging(slug, id) {
                    return Err((409, "Wait a moment: a merge is running".into()));
                }
                for o in self.tool_tickets(slug, id).into_iter().rev() {
                    if self.get(slug, &o.id).is_some() {
                        self.delete_one(slug, &o.id);
                    }
                }
            } else if t0.tool {
                if let Some(main) = self.main_of(slug, &t0) {
                    if hooks.merging(slug, &main.id) {
                        return Err((409, "Wait a moment: a merge is running".into()));
                    }
                }
            }
        }
        self.delete_one(slug, id);
        Ok(())
    }

    /// `deleteOne`: its run stopped, its copies and pasted files removed, its folder gone; its family stays, unlinked.
    pub fn delete_one(&self, slug: &str, id: &str) {
        let hooks = self.hooks();
        if self.runs.is_running(slug, id) {
            block(hooks.stop_run(slug, id, None));
        }
        if let Some(t) = self.get(slug, id) {
            block(hooks.remove_copies(slug, &t.json));
            super::files::delete_attachments(&self.root, &self.attachments_of(slug, &t));
        }
        {
            let lock = self.lock(slug);
            let _g = lock.lock();
            self.store_delete(slug, id);
        }
        self.emit_deleted(slug, id);
        hooks.after_delete(slug, id);
        for o in self.list(slug).tickets.iter() {
            let mut p = Map::new();
            if o.json.get("partOf").and_then(Value::as_str) == Some(id) {
                p.insert("partOf".into(), Value::Null);
                p.insert("partOfVia".into(), Value::Null);
            }
            if o.get("parentSuggestion").and_then(|s| s.get("id")).and_then(Value::as_str) == Some(id) {
                p.insert("parentSuggestion".into(), Value::Null);
            }
            if !p.is_empty() {
                let _ = self.patch(slug, &o.id, p);
            }
        }
    }

    /// `attachmentsOf`: pasted files its description, comments, waiting messages and chat refer to.
    pub fn attachments_of(&self, slug: &str, t: &Tk) -> Vec<String> {
        let mut texts: Vec<String> = vec![t.body.clone()];
        texts.extend(self.comments(slug, &t.id).iter().filter_map(|c| c.get("text").and_then(Value::as_str).map(str::to_string)));
        if let Some(Value::Array(q)) = t.get("queued") {
            texts.extend(q.iter().filter_map(|m| m.get("text").and_then(Value::as_str).map(str::to_string)));
        }
        if let Some(sid) = t.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            let projects = crate::sessions::files::projects_dir(None);
            if let Some(f) = crate::sessions::files::find_session_file(&projects, sid)
                && let Ok(text) = std::fs::read_to_string(f)
            {
                texts.push(text);
            }
        }
        super::files::referenced_attachments(&texts)
    }

    /// `Board.moveTicket`: a fresh Backlog ticket on `target` with the same title, description and tags, then the
    /// original goes. Refused while it is linked to other tickets or has work in a copy of the folder.
    pub fn move_to(&self, slug: &str, id: &str, target: &str) -> Result<Arc<Tk>, Refusal> {
        let t = self.get(slug, id).ok_or_else(|| bad(format!("ticket {id} not found")))?;
        if ckanban_core::DataDir::new(&self.root).profile(target).is_none() {
            return Err((404, format!("board {target} not found")));
        }
        if target == slug {
            return Err(bad("The ticket is already on that board."));
        }
        if t.status != "backlog" {
            return Err(bad("Only tickets in Backlog can move to another board."));
        }
        if self.runs.is_running(slug, id) {
            return Err(bad("Claude is working on this ticket. Stop it first."));
        }
        if truthy(t.get("worktree")) || truthy(t.get("branch")) {
            return Err(bad("This ticket has work in a copy of the folder. Delete the ticket or finish it instead of moving it."));
        }
        let deps = |o: &Tk| match o.get("dependsOn") {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let plan_key = t.get("planKey").and_then(Value::as_str).filter(|k| !k.is_empty()).map(str::to_string);
        let linked = t.parent_id.is_some()
            || !deps(&t).is_empty()
            || ["branchedFrom", "madeFrom", "plan"].iter().any(|k| truthy(t.get(k)))
            || self.list(slug).tickets.iter().any(|o| {
                o.id != id
                    && (o.parent_id.as_deref() == Some(id)
                        || o.get("branchedFrom").and_then(Value::as_str) == Some(id)
                        || o.get("madeFrom").and_then(Value::as_str) == Some(id)
                        || deps(o).iter().any(|d| d == id || plan_key.as_deref() == Some(d.as_str())))
            });
        if linked {
            return Err(bad("Can't move: this ticket is linked to other tickets. Remove the links first."));
        }
        let mut input = Map::new();
        input.insert("title".into(), t.title.clone().into());
        input.insert("body".into(), t.body.clone().into());
        input.insert("status".into(), "backlog".into());
        if let Some(tags) = t.get("tags") {
            input.insert("tags".into(), tags.clone());
        }
        if let Some(i) = t.get("important") {
            input.insert("important".into(), i.clone());
        }
        // Create first, delete second: a failure in between leaves the original in place.
        let copy = self.create(target, input)?;
        {
            let lock = self.lock(slug);
            let _g = lock.lock();
            self.store_delete(slug, id);
        }
        self.emit_deleted(slug, id);
        self.hooks().after_delete(slug, id);
        Ok(copy)
    }

    /// The board's tickets on disk are gone (its folder was deleted): its listing goes too.
    pub fn forget_board(&self, slug: &str) {
        self.index.forget(slug);
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Runs an async hook from a blocking thread (the routes run on the blocking pool).
/// Never from an async task: there it would stop the runtime's thread (Tokio refuses with a panic).
pub fn block<T>(f: impl std::future::Future<Output = T>) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(h) => h.block_on(f),
        Err(_) => tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime for a hook").block_on(f),
    }
}

/// `childrenOf`: a planner's children, oldest first.
pub fn children_of<'a>(list: &'a crate::index::store::BoardList, planner: &str) -> Vec<&'a Arc<Tk>> {
    let mut out: Vec<&Arc<Tk>> = list.tickets.iter().filter(|t| t.parent_id.as_deref() == Some(planner)).collect();
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.order.partial_cmp(&b.order).unwrap_or(std::cmp::Ordering::Equal)));
    out
}

fn depends_on(t: &Tk) -> Vec<String> {
    match t.get("dependsOn") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// `resolveDeps`: (the siblings a ticket depends on, the references that match none).
pub fn resolve_deps(t: &Tk, siblings: &[Arc<Tk>]) -> (Vec<Arc<Tk>>, Vec<String>) {
    let mut deps = Vec::new();
    let mut missing = Vec::new();
    for r in depends_on(t) {
        let found = siblings.iter().find(|s| {
            s.id != t.id && (s.id == r || s.get("planKey").and_then(Value::as_str).is_some_and(|k| !k.is_empty() && k == r))
        });
        match found {
            Some(d) => deps.push(d.clone()),
            None => missing.push(r),
        }
    }
    (deps, missing)
}

/// `findCycle`: titles along a dependency cycle among the children, or None.
pub fn find_cycle(children: &[Arc<Tk>]) -> Option<Vec<String>> {
    #[derive(PartialEq)]
    enum S {
        Visiting,
        Done,
    }
    fn visit(t: &Arc<Tk>, children: &[Arc<Tk>], state: &mut HashMap<String, S>, stack: &mut Vec<Arc<Tk>>) -> Option<Vec<String>> {
        match state.get(&t.id) {
            Some(S::Done) => return None,
            Some(S::Visiting) => {
                let at = stack.iter().position(|x| Arc::ptr_eq(x, t) || x.id == t.id).unwrap_or(0);
                let mut out: Vec<String> = stack[at..].iter().map(|x| x.title.clone()).collect();
                out.push(t.title.clone());
                return Some(out);
            }
            None => {}
        }
        state.insert(t.id.clone(), S::Visiting);
        stack.push(t.clone());
        for d in resolve_deps(t, children).0 {
            if let Some(c) = visit(&d, children, state, stack) {
                return Some(c);
            }
        }
        stack.pop();
        state.insert(t.id.clone(), S::Done);
        None
    }
    let mut state = HashMap::new();
    let mut stack = Vec::new();
    for c in children {
        if let Some(cycle) = visit(c, children, &mut state, &mut stack) {
            return Some(cycle);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::StandIn;

    fn board() -> (tempfile::TempDir, Arc<Tickets>) {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("profiles/b/tickets")).unwrap();
        let index = Index::new(d.path());
        let t = Tickets::new(index, Arc::new(Bus::new()), Arc::new(StandIn), Arc::new(|s: &str| s.replace("sk-secret-1", "***")));
        (d, t)
    }

    fn input(title: &str, status: &str) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("title".into(), title.into());
        m.insert("status".into(), status.into());
        m
    }

    #[test]
    fn create_update_delete_keep_the_listing_and_files_in_step() {
        let (_d, t) = board();
        let a = t.create("b", input("⭐ A", "backlog")).unwrap();
        let b = t.create("b", input("B", "backlog")).unwrap();
        let r1 = t.create("b", input("R1", "ready")).unwrap();
        let r2 = t.create("b", input("R2", "in_progress")).unwrap();
        assert_eq!((a.title.as_str(), a.get("important")), ("A", Some(&Value::Bool(true))));
        // Backlog: each new card on top; Ready: a queue (In progress queues there too).
        assert!(b.order < a.order);
        assert_eq!((r2.status.as_str(), r2.order), ("ready", r1.order + 1.0));
        let list = t.list("b");
        assert_eq!(list.tickets.len(), 4);
        assert!(t.ticket_file("b", &a.id).exists());

        let mut p = Map::new();
        p.insert("status".into(), "done".into());
        p.insert("pinned".into(), true.into());
        let done = t.update("b", &a.id, &p, true).unwrap();
        assert_eq!(done.status, "done");
        assert!(done.get("doneAt").is_some_and(Value::is_string));
        assert_eq!(done.get("pinnedAt"), Some(&Value::Null));
        let mut p = Map::new();
        p.insert("status".into(), "backlog".into());
        let back = t.update("b", &a.id, &p, true).unwrap();
        assert_eq!(back.get("reopenedFrom"), Some(&serde_json::json!({ "status": "done", "outcome": null })));
        // The file says the same as the listing.
        let file = tfile::read(&t.ticket_file("b", &a.id)).unwrap().unwrap().unwrap();
        assert_eq!(file.to_json()["reopenedFrom"], back.json["reopenedFrom"]);

        let mut p = Map::new();
        p.insert("body".into(), "x".into());
        p.insert("expectedBody".into(), "not it".into());
        assert_eq!(t.update("b", &a.id, &p, true).unwrap_err().0, 409);

        t.delete("b", &b.id).unwrap();
        assert!(!t.ticket_dir("b", &b.id).exists());
        assert!(t.list("b").get(&b.id).is_none());
    }

    #[test]
    fn comments_are_masked_as_they_are_written() {
        let (_d, t) = board();
        let a = t.create("b", input("A", "backlog")).unwrap();
        let c = t.add_comment("b", &a.id, "key sk-secret-1 here", None).unwrap();
        assert_eq!((c["author"].as_str(), c["text"].as_str()), (Some("user"), Some("key *** here")));
        let n = t.add_comment("b", &a.id, "from a run", Some("t_x")).unwrap();
        assert_eq!((n["author"].as_str(), n["from"].as_str()), (Some("ai"), Some("t_x")));
        let all = t.comments("b", &a.id);
        assert_eq!(all.len(), 2);
        let raw = std::fs::read_to_string(t.ticket_dir("b", &a.id).join("comments.jsonl")).unwrap();
        assert!(!raw.contains("sk-secret-1"));
        assert!(raw.starts_with("{\"id\":"));
    }

    #[test]
    fn moves_only_a_free_backlog_ticket() {
        let (d, t) = board();
        std::fs::create_dir_all(d.path().join("profiles/o")).unwrap();
        std::fs::write(d.path().join("profiles/o/profile.json"), "{\"name\":\"O\",\"slug\":\"o\",\"path\":\"/tmp\",\"createdAt\":\"x\"}\n").unwrap();
        let a = t.create("b", input("A", "backlog")).unwrap();
        let r = t.create("b", input("R", "review")).unwrap();
        assert_eq!(t.move_to("b", &r.id, "o").unwrap_err().1, "Only tickets in Backlog can move to another board.");
        let moved = t.move_to("b", &a.id, "o").unwrap();
        assert_eq!(moved.title, "A");
        assert!(t.get("b", &a.id).is_none());
        assert!(t.get("o", &moved.id).is_some());
    }

    #[test]
    fn cycles_and_dependencies() {
        let mk = |id: &str, title: &str, deps: &[&str]| Arc::new(Tk::from_json(serde_json::json!({ "id": id, "title": title, "dependsOn": deps }).as_object().unwrap().clone(), false));
        let kids = vec![mk("a", "A", &["b"]), mk("b", "B", &["a"]), mk("c", "C", &["zz"])];
        assert_eq!(find_cycle(&kids), Some(vec!["A".to_string(), "B".to_string(), "A".to_string()]));
        assert_eq!(resolve_deps(&kids[2], &kids).1, vec!["zz".to_string()]);
    }
}
