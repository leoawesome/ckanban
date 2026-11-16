//! The team's files and the operations the team routes call (`Huddles.savePreset`, `deletePreset`, `saveTemplate`,
//! `deleteTemplate`, `saveSquad`, `notes`, `setNotes` and the `Store` readers and writers they use), with Bun's
//! checks, error texts and statuses.
//!
//! The files are small and read fresh on every call (no cache: the user may edit them by hand). Every change is a
//! read, merge and atomic write; one process-wide lock keeps two changes from interleaving (Bun's single event loop
//! did that). Calls block: the server runs them in `spawn_blocking`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ckanban_core::DataDir;
use ckanban_core::datafile::{Replace, formats, parse_json, write_json, write_text};
use ckanban_core::layout::Level as FileLevel;
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};

use super::jsv::{self, Obj};
use super::layers::{self, Level};
use super::notes::{self, Note, RoleNotes, Scope};
use super::presets::{self, preset_name};
use super::squad;
use super::templates;

/// An error answer: HTTP status and Bun's message.
#[derive(Clone, Debug, PartialEq)]
pub struct Fail {
    pub status: u16,
    pub message: String,
}

impl Fail {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Fail { status, message: message.into() }
    }
}

/// Squad cards on tickets (a squad proposed in a ticket's chat): R2a's ticket writes fill this in.
pub trait TicketCards: Send + Sync {
    /// `store.getTicket(slug, id)` found it.
    fn exists(&self, slug: &str, id: &str) -> bool;
    /// Sets `squadCards[uuid] = state` on the ticket and emits its `ticket.updated`.
    fn mark_saved(&self, slug: &str, id: &str, uuid: &str, state: Value) -> Result<(), String>;
}

/// A huddle's proposed squad (under its Learnings): R11a's huddles fill this in.
pub trait LearningCards: Send + Sync {
    /// `this.learning(this.get(slug, hid), lid)`: the huddle exists and the learning waits (404 or 409 otherwise).
    fn check(&self, slug: &str, hid: &str, lid: &str) -> Result<(), Fail>;
    /// Marks the learning saved, with the squad's name and scope ("general" or "repo").
    fn mark_saved(&self, slug: &str, hid: &str, lid: &str, target: &str, scope: &str) -> Result<(), String>;
}

/// Why a card can't be marked yet: the part of the Rust board that owns it isn't in.
const NOT_YET: &str = "not in the Rust board yet";

/// One change at a time to the team's files, across every `Team` of this process.
static WRITES: Mutex<()> = Mutex::new(());

pub struct Team {
    dir: DataDir,
    tickets: RwLock<Option<Arc<dyn TicketCards>>>,
    learnings: RwLock<Option<Arc<dyn LearningCards>>>,
}

/// A ticket card to mark saved: (ticket id, card uuid).
pub type TicketCard<'a> = (&'a str, &'a str);
/// A huddle learning to mark saved: (huddle id, learning id).
pub type LearningCard<'a> = (&'a str, &'a str);

/// `typeof v === "string"` for path parts: no folder walking through a name.
fn safe_part(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0'])
}

impl Team {
    pub fn new(root: &Path) -> Self {
        Team { dir: DataDir::new(root.to_path_buf()), tickets: RwLock::new(None), learnings: RwLock::new(None) }
    }

    pub fn set_ticket_cards(&self, t: Arc<dyn TicketCards>) {
        *self.tickets.write() = Some(t);
    }

    pub fn set_learning_cards(&self, l: Arc<dyn LearningCards>) {
        *self.learnings.write() = Some(l);
    }

    /// `store.getProfile(slug)` exists.
    pub fn has_board(&self, slug: &str) -> bool {
        safe_part(slug) && self.dir.profile(slug).is_some()
    }

    fn need_board(&self, slug: &str) -> Result<(), Fail> {
        if self.has_board(slug) { Ok(()) } else { Err(Fail::new(404, format!("board {slug} not found"))) }
    }

    fn level_file(&self, slug: Option<&str>, name: &str) -> PathBuf {
        match slug {
            None => self.dir.root.join(name),
            Some(s) => self.dir.profile_dir(s).join(name),
        }
    }

    /// `readList`: missing, unreadable or damaged: none.
    fn read_list(&self, file: &Path, clean: fn(Option<&Value>) -> Vec<Obj>) -> Vec<Obj> {
        let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
        clean(parse_json(&text).as_ref())
    }

    fn write_list(&self, file: &Path, list: &[Obj]) -> Result<(), Fail> {
        let v = Value::Array(list.iter().cloned().map(Value::Object).collect());
        write_json(file, &v, formats::HUDDLE_PRESETS).map_err(|e| Fail::new(500, e.to_string()))
    }

    // ---- teammates ----

    /// `Store.listHuddlePresets`: one level's (a board's, or the global ones with None).
    pub fn level_presets(&self, slug: Option<&str>) -> Vec<Obj> {
        self.read_list(&self.level_file(slug, "huddle-presets.json"), presets::clean_presets)
    }

    /// `Huddles.presets`: built-ins merged with the global ones and the board's.
    pub fn presets(&self, slug: &str) -> Vec<Obj> {
        presets::merge_presets(&self.level_presets(None), &self.level_presets(Some(slug)))
    }

    fn preset_names(&self, slug: &str) -> Vec<String> {
        layers::names(&self.presets(slug))
    }

    /// `Huddles.savePreset`: add or change a preset at one level. Saving for every board drops this board's own
    /// version of it.
    pub fn save_preset(&self, slug: &str, input: Option<&Value>, level: Option<&Value>) -> Result<Obj, Fail> {
        let _w = WRITES.lock();
        self.save_preset_locked(slug, input, level)
    }

    fn save_preset_locked(&self, slug: &str, input: Option<&Value>, level: Option<&Value>) -> Result<Obj, Fail> {
        self.need_board(slug)?;
        let level = Level::of(level).ok_or_else(|| Fail::new(400, "scope must be board or global"))?;
        let global = self.level_presets(None);
        let board = self.level_presets(Some(slug));
        let lower = layers::lower_levels(presets::builtins(), &global, level);
        let (list, preset) = presets::save_preset(if level == Level::Global { &global } else { &board }, input, &lower).map_err(|e| Fail::new(400, e))?;
        let name = preset["name"].as_str().unwrap_or("").to_string();
        self.write_list(&self.level_file((level == Level::Board).then_some(slug), "huddle-presets.json"), &list)?;
        if level == Level::Global && layers::find(&board, &name).is_some() {
            let rest: Vec<Obj> = board.into_iter().filter(|p| p["name"] != name.as_str()).collect();
            self.write_list(&self.level_file(Some(slug), "huddle-presets.json"), &rest)?;
        }
        self.presets(slug).into_iter().find(|p| p["name"] == name.as_str()).ok_or_else(|| Fail::new(500, "the saved teammate is missing"))
    }

    /// `levelOf`: the level a delete goes to: the one asked for, else the one in effect.
    fn level_of(asked: Option<&str>, source: Option<&str>) -> Result<Level, Fail> {
        match asked {
            Some(a) if !a.is_empty() => Level::of(Some(&Value::from(a))).ok_or_else(|| Fail::new(400, "scope must be board or global")),
            _ => Ok(if source == Some("global") { Level::Global } else { Level::Board }),
        }
    }

    /// Bun's status for a failed delete: 409 when the message names a built-in, else 404.
    fn delete_fail(e: String) -> Fail {
        Fail::new(if e.contains("built-in") { 409 } else { 404 }, e)
    }

    /// `Huddles.deletePreset`: `{ reset, presets }`.
    pub fn delete_preset(&self, slug: &str, name: &str, level: Option<&str>) -> Result<Value, Fail> {
        let _w = WRITES.lock();
        let n = preset_name(name);
        let source = self.presets(slug).into_iter().find(|p| p["name"] == n.as_str()).and_then(|p| p.get("source").and_then(Value::as_str).map(String::from));
        let lvl = Self::level_of(level, source.as_deref())?;
        let global = self.level_presets(None);
        let at = (lvl == Level::Board).then_some(slug);
        let (list, reset) =
            presets::delete_preset(&self.level_presets(at), name, &layers::lower_levels(presets::builtins(), &global, lvl)).map_err(Self::delete_fail)?;
        self.write_list(&self.level_file(at, "huddle-presets.json"), &list)?;
        Ok(json!({ "reset": reset, "presets": self.presets(slug) }))
    }

    // ---- squads (templates) ----

    pub fn level_templates(&self, slug: Option<&str>) -> Vec<Obj> {
        self.read_list(&self.level_file(slug, "huddle-templates.json"), templates::clean_templates)
    }

    /// `Huddles.templates`.
    pub fn templates(&self, slug: &str) -> Vec<Obj> {
        templates::merge_templates(&self.level_templates(None), &self.level_templates(Some(slug)))
    }

    /// `Huddles.saveTemplate`.
    pub fn save_template(&self, slug: &str, input: Option<&Value>, level: Option<&Value>) -> Result<Obj, Fail> {
        let _w = WRITES.lock();
        self.save_template_locked(slug, input, level)
    }

    fn save_template_locked(&self, slug: &str, input: Option<&Value>, level: Option<&Value>) -> Result<Obj, Fail> {
        self.need_board(slug)?;
        let level = Level::of(level).ok_or_else(|| Fail::new(400, "scope must be board or global"))?;
        let global = self.level_templates(None);
        let board = self.level_templates(Some(slug));
        let names = self.preset_names(slug);
        let lower = layers::lower_levels(templates::builtins(), &global, level);
        let (list, t) = templates::save_template(if level == Level::Global { &global } else { &board }, input, Some(&names), &lower)
            .map_err(|e| Fail::new(400, e))?;
        let name = t["name"].as_str().unwrap_or("").to_string();
        self.write_list(&self.level_file((level == Level::Board).then_some(slug), "huddle-templates.json"), &list)?;
        if level == Level::Global && layers::find(&board, &name).is_some() {
            let rest: Vec<Obj> = board.into_iter().filter(|x| x["name"] != name.as_str()).collect();
            self.write_list(&self.level_file(Some(slug), "huddle-templates.json"), &rest)?;
        }
        self.templates(slug).into_iter().find(|x| x["name"] == name.as_str()).ok_or_else(|| Fail::new(500, "the saved squad is missing"))
    }

    /// `Huddles.deleteTemplate`: `{ reset, templates }`.
    pub fn delete_template(&self, slug: &str, name: &str, level: Option<&str>) -> Result<Value, Fail> {
        let _w = WRITES.lock();
        let n = preset_name(name);
        let source = self.templates(slug).into_iter().find(|t| t["name"] == n.as_str()).and_then(|t| t.get("source").and_then(Value::as_str).map(String::from));
        let lvl = Self::level_of(level, source.as_deref())?;
        let global = self.level_templates(None);
        let at = (lvl == Level::Board).then_some(slug);
        let (list, reset) = templates::delete_template(&self.level_templates(at), name, &layers::lower_levels(templates::builtins(), &global, lvl))
            .map_err(Self::delete_fail)?;
        self.write_list(&self.level_file(at, "huddle-templates.json"), &list)?;
        Ok(json!({ "reset": reset, "templates": self.templates(slug) }))
    }

    /// `store.getTicket(slug, id)` found it: through R2a once it is in, else the ticket's file is there.
    pub fn ticket_exists(&self, slug: &str, id: &str) -> bool {
        if let Some(t) = self.tickets.read().clone() {
            return t.exists(slug, id);
        }
        safe_part(slug) && safe_part(id) && self.dir.ticket_file(slug, id).is_file()
    }

    /// `Huddles.saveSquad` plus the squad card of `POST /squads`: first each person with no preset as a teammate at
    /// the same level, then the squad. Everything is checked before anything is written. `learning`: a huddle's
    /// proposed squad this saves; `card`: a ticket's squad card to mark saved. Answers `{ squad, teammates }`.
    pub fn save_squad(
        &self,
        slug: &str,
        input: Option<&Value>,
        level: Option<&Value>,
        learning: Option<LearningCard>,
        replace: bool,
        card: Option<TicketCard>,
    ) -> Result<Value, Fail> {
        let _w = WRITES.lock();
        self.need_board(slug)?;
        let level = Level::of(level).ok_or_else(|| Fail::new(400, "scope must be board or global"))?;
        let learnings = self.learnings.read().clone();
        let tickets = self.tickets.read().clone();
        if let Some((hid, lid)) = learning {
            match &learnings {
                Some(l) => l.check(slug, hid, lid)?,
                None => return Err(Fail::new(503, format!("saving a huddle's proposed squad is {NOT_YET}"))),
            }
        }
        // A card never replaces a squad by surprise: the user renames it, or confirms (replace).
        let name = presets::input_name(input);
        if let Some(existing) = self.templates(slug).into_iter().find(|t| t["name"] == name.as_str())
            && !replace
        {
            return Err(Fail::new(
                409,
                format!(
                    "a squad named \"{name}\" already exists ({}); rename this one, or save with replace to change that one",
                    jsv::js_string(existing.get("label"))
                ),
            ));
        }
        // A squad for all boards may only point at teammates every board has (built-in and global); a new one never
        // takes a name this board has.
        let reach = if level == Level::Global {
            layers::names(&layers::lower_levels(presets::builtins(), &self.level_presets(None), Level::Board))
        } else {
            self.preset_names(slug)
        };
        let taken = self.preset_names(slug);
        let plan = squad::squad_save_plan(input, &reach, Some(&taken)).map_err(|e| Fail::new(400, e))?;
        if card.is_some() && tickets.is_none() {
            return Err(Fail::new(503, format!("saving a squad card on a ticket is {NOT_YET}")));
        }
        let scope = Value::from(level.name());
        for p in &plan.create {
            self.save_preset_locked(slug, Some(&Value::Object(p.clone())), Some(&scope))?;
        }
        let saved = self.save_template_locked(slug, Some(&Value::Object(plan.squad.clone())), Some(&scope))?;
        let created: Vec<Value> = plan.create.iter().map(|p| p["name"].clone()).collect();
        let teammates = json!({ "created": created, "reused": plan.reused });
        let squad_name = saved["name"].as_str().unwrap_or("").to_string();
        if let (Some((hid, lid)), Some(l)) = (learning, &learnings) {
            let scope = if level == Level::Global { "general" } else { "repo" };
            l.mark_saved(slug, hid, lid, &squad_name, scope).map_err(|e| Fail::new(500, e))?;
        }
        if let (Some((id, uuid)), Some(t)) = (card, &tickets) {
            let state = json!({
                "state": "saved", "name": squad_name, "scope": level.name(), "teammates": teammates,
                "at": ckanban_core::time::iso(ckanban_core::time::now_ms()),
            });
            t.mark_saved(slug, id, uuid, state).map_err(|e| Fail::new(500, e))?;
        }
        Ok(json!({ "squad": saved, "teammates": teammates }))
    }

    // ---- role notes ----

    fn notes_dir(&self, slug: &str, scope: Scope) -> PathBuf {
        match scope {
            Scope::General => self.dir.root.join("huddle-notes"),
            Scope::Repo => self.dir.profile_dir(slug).join("huddle-notes"),
        }
    }

    fn notes_file(&self, slug: &str, role: &str, scope: Scope) -> PathBuf {
        let level = if scope == Scope::General { FileLevel::Global } else { FileLevel::Board(slug) };
        self.dir.huddle_notes(level, role)
    }

    /// `Store.readHuddleNotes`: a role's notes, newest first.
    pub fn read_notes(&self, slug: &str, role: &str, scope: Scope) -> Vec<Note> {
        std::fs::read_to_string(self.notes_file(slug, role, scope)).map(|t| notes::parse_notes(&t)).unwrap_or_default()
    }

    /// `Store.noteFileRoles`: roles with a notes file in one scope.
    fn note_file_roles(&self, slug: &str, scope: Scope) -> Vec<String> {
        let Ok(rd) = std::fs::read_dir(self.notes_dir(slug, scope)) else { return Vec::new() };
        let mut out: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter_map(|f| f.strip_suffix(".md").map(String::from))
            .collect();
        out.sort();
        out
    }

    /// `Huddles.notes`: every role's notes that exist on disk, general and this board's repo notes, by role.
    pub fn notes(&self, slug: &str) -> Result<Value, Fail> {
        self.need_board(slug)?;
        let mut roles = self.note_file_roles(slug, Scope::General);
        roles.extend(self.note_file_roles(slug, Scope::Repo));
        roles.sort();
        roles.dedup();
        let mut out = Obj::new();
        for role in roles {
            if notes::note_role(Some(&Value::from(role.as_str()))).as_deref() != Some(role.as_str()) {
                continue;
            }
            let r = RoleNotes { general: self.read_notes(slug, &role, Scope::General), repo: self.read_notes(slug, &role, Scope::Repo) };
            out.insert(role, serde_json::to_value(r).unwrap_or(Value::Null));
        }
        Ok(Value::Object(out))
    }

    /// `Huddles.setNotes`: replace a role's notes in one scope (the user added, edited or deleted lines).
    pub fn set_notes(&self, slug: &str, role: &str, scope: &str, notes_in: Option<&Value>) -> Result<Vec<Note>, Fail> {
        let _w = WRITES.lock();
        self.need_board(slug)?;
        let r = notes::note_role(Some(&Value::from(role))).ok_or_else(|| Fail::new(400, format!("\"{role}\" is not a role name")))?;
        let scope = Scope::of(scope).ok_or_else(|| Fail::new(400, "scope must be general or repo"))?;
        let ns = notes::clean_notes(notes_in).map_err(|e| Fail::new(400, e))?;
        let text = notes::serialize_notes(&r, scope, &ns);
        write_text(&self.notes_file(slug, &r, scope), text.as_bytes(), Replace::Atomic, false).map_err(|e| Fail::new(500, e.to_string()))?;
        Ok(self.read_notes(slug, &r, scope))
    }
}
