//! `src/board/learner.ts`: reads corrected tickets once they settle in Review or Done, takes huddle agents' lessons,
//! saves the ones that come back, tidies the notes once a week, and undoes any of it on the user's click. Every step
//! holds one lock (`serial`), so the pile and the files are never written by two steps at once. The files are Bun's:
//! `learned/pile.json`, `changes.json`, `scanned-at.json`, `profiles/<slug>/learned-rules.md` and the role notes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ckanban_core::datafile::{formats, render, to_text, Layout};
use ckanban_core::layout::Level as FileLevel;
use ckanban_core::DataDir;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::learn::{self, ms, s, Corrections, Learned, TidyNote, TidyOp, CHANGES_CAP, DAY, PILE_CAP, SHORTLIST, TIDY_DAYS};
use super::lessons;
use super::SideFn;
use crate::api::{RunControl, SessionInfo};
use crate::bus::Bus;
use crate::index::store::Index;
use crate::runs::side_call::{add_side_spend, SideCallInput, SideCallResult};
use crate::team::notes::{note_text, parse_notes, serialize_notes, Lesson, Note, Scope, ALL_ROLES};

pub const LEARN_MODEL: &str = "haiku";
pub const TIDY_MODEL: &str = "sonnet";
const SAVED_DAYS: f64 = 7.0;
const CLEANED_DAYS: f64 = 30.0;
const WATCHING_MAX: usize = 50;

/// `LearnError`: a refusal with its HTTP status.
#[derive(Debug, Clone, PartialEq)]
pub struct LearnError(pub u16, pub String);

fn err(status: u16, m: impl Into<String>) -> LearnError {
    LearnError(status, m.into())
}

fn learnable(status: &str) -> bool {
    status == "review" || status == "done"
}

pub struct LearnerOptions {
    pub side: SideFn,
    pub sessions: Arc<dyn SessionInfo>,
    pub runs: Arc<dyn RunControl>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
    /// How long a ticket stays in Review or Done before it is read. Default 2 minutes.
    pub settle_ms: u64,
    /// How often a due tidy pass is checked; 0: never on its own. Default hourly.
    pub tidy_check_ms: u64,
}

/// A random number (no `rand` crate here: the hasher's random keys and the clock).
fn random() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// Bun's ids: the time in base 36 and four random base-36 characters.
pub fn new_id() -> String {
    fn b36(mut n: u64) -> String {
        let d = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut out = Vec::new();
        loop {
            out.push(d[(n % 36) as usize]);
            n /= 36;
            if n == 0 {
                break;
            }
        }
        out.reverse();
        String::from_utf8(out).expect("ascii")
    }
    let r: u64 = random() % 36u64.pow(4);
    let tail = format!("{:0>4}", b36(r));
    format!("{}{}", b36(ckanban_core::time::now_ms() as u64), tail)
}

pub struct Learner {
    dir: DataDir,
    index: Arc<Index>,
    bus: Arc<Bus>,
    o: LearnerOptions,
    serial: tokio::sync::Mutex<()>,
    timers: Mutex<HashMap<String, tokio::task::AbortHandle>>,
    /// `scanned-at.json`, read once; and whether a write is due.
    scanned: Mutex<(Option<Map<String, Value>>, bool)>,
    jobs: Mutex<Vec<tokio::task::AbortHandle>>,
}

fn iso(ms: f64) -> String {
    ckanban_core::time::iso(ms)
}

impl Learner {
    pub fn new(root: &Path, index: Arc<Index>, bus: Arc<Bus>, o: LearnerOptions) -> Arc<Learner> {
        Arc::new(Learner {
            dir: DataDir::new(root),
            index,
            bus,
            o,
            serial: tokio::sync::Mutex::new(()),
            timers: Mutex::new(HashMap::new()),
            scanned: Mutex::new((None, false)),
            jobs: Mutex::new(Vec::new()),
        })
    }

    fn now(&self) -> f64 {
        (self.o.now)()
    }

    // ---- Files ----

    fn learned_dir(&self) -> PathBuf {
        self.dir.root.join("learned")
    }
    fn pile_file(&self) -> PathBuf {
        self.learned_dir().join("pile.json")
    }
    fn changes_file(&self) -> PathBuf {
        self.learned_dir().join("changes.json")
    }
    fn scanned_file(&self) -> PathBuf {
        self.learned_dir().join("scanned-at.json")
    }

    fn write_pretty(&self, file: &Path, v: &Value) {
        let _ = std::fs::create_dir_all(self.learned_dir());
        if let Err(e) = ckanban_core::atomic::atomic_write(file, format!("{}\n", to_text(v, Layout::Indent(2)))) {
            eprintln!("learner: can't write {}: {e}", file.display());
        }
    }

    pub fn read_pile(&self) -> Value {
        let v = std::fs::read_to_string(self.pile_file()).ok().and_then(|t| crate::runs::js::parse(&t));
        learn::pile_of(v)
    }

    fn write_pile(&self, p: &Value) {
        self.write_pretty(&self.pile_file(), p);
    }

    pub fn changes(&self) -> Vec<Value> {
        match std::fs::read_to_string(self.changes_file()).ok().and_then(|t| crate::runs::js::parse(&t)) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        }
    }

    fn write_changes(&self, cs: &[Value]) {
        let from = cs.len().saturating_sub(CHANGES_CAP);
        self.write_pretty(&self.changes_file(), &Value::Array(cs[from..].to_vec()));
    }

    fn add_change(&self, c: Value) {
        let mut cs = self.changes();
        cs.push(c);
        self.write_changes(&cs);
    }

    fn rules_file(&self, slug: &str) -> PathBuf {
        self.dir.learned_rules(slug)
    }

    /// The board's learned rules, newest first.
    pub fn rules(&self, slug: &str) -> Vec<Note> {
        std::fs::read_to_string(self.rules_file(slug)).map(|t| parse_notes(&t)).unwrap_or_default()
    }

    fn existing_rules(&self, slug: &str) -> Vec<String> {
        let mut out: Vec<String> = self.rules(slug).into_iter().map(|r| r.text).collect();
        if let Some(path) = self.dir.profile(slug).and_then(|p| p.record.str("path").map(str::to_string)).filter(|p| !p.is_empty()) {
            out.extend(lessons::project_rules(Path::new(&path)));
        }
        out
    }

    /// A role's notes file (role "rules": the board's rules).
    fn shelf_file(&self, slug: &str, role: &str, scope: Scope) -> PathBuf {
        if role == "rules" {
            return self.rules_file(slug);
        }
        let level = if scope == Scope::General { FileLevel::Global } else { FileLevel::Board(slug) };
        self.dir.huddle_notes(level, role)
    }

    fn write_shelf(role: &str, scope: Scope, ns: &[Note]) -> String {
        if role == "rules" { learn::serialize_rules(ns) } else { serialize_notes(role, scope, ns) }
    }

    fn read(file: &Path) -> Option<String> {
        std::fs::read_to_string(file).ok()
    }

    fn put(file: &Path, text: Option<&str>) {
        match text {
            None => {
                let _ = std::fs::remove_file(file);
            }
            Some(t) => {
                if let Some(d) = file.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                if let Err(e) = ckanban_core::atomic::atomic_write(file, t) {
                    eprintln!("learner: can't write {}: {e}", file.display());
                }
            }
        }
    }

    /// `editNotes`: one notes file changed through f; the edit, the whole file before and after.
    fn edit_notes(&self, slug: &str, role: &str, scope: Scope, f: impl FnOnce(Vec<Note>) -> Vec<Note>) -> Value {
        let file = self.shelf_file(slug, role, scope);
        let before = Self::read(&file);
        let after = Self::write_shelf(role, scope, &f(before.as_deref().map(parse_notes).unwrap_or_default()));
        Self::put(&file, Some(&after));
        json!({ "file": file.to_string_lossy(), "role": role, "scope": scope.name(), "slug": slug, "before": before, "after": after })
    }

    fn emit(&self, slug: Option<&str>) {
        self.bus.emit_json(json!({ "type": "learned.updated", "profile": slug }));
    }

    // ---- Watching tickets ----

    /// `start`: tickets that settled while the board was down, then each ticket that settles, and the weekly tidy.
    /// Call from the runtime; the hooks stop with `stop`.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        let handle = tokio::spawn(async move {
            let m = me.clone();
            let due = tokio::task::spawn_blocking(move || m.settled_while_down()).await.unwrap_or_default();
            for (slug, id) in due {
                me.schedule(&slug, &id);
            }
        });
        self.jobs.lock().push(handle.abort_handle());
        let me = Arc::downgrade(self);
        let rt = tokio::runtime::Handle::current();
        self.bus.on(move |e| {
            if e.ty != "ticket.updated" {
                return;
            }
            let Some(me) = me.upgrade() else { return };
            let slug = s(&e.body, "profile").to_string();
            let t = &e.body["ticket"];
            let _g = rt.enter();
            if learnable(s(t, "status")) {
                me.schedule(&slug, s(t, "id"));
            }
            if let Some(m) = t.get("madeFrom").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                me.schedule(&slug, m);
            }
        });
        let every = self.o.tidy_check_ms;
        if every > 0 {
            let me = Arc::downgrade(self);
            let tick = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(60_000)).await;
                loop {
                    let Some(l) = me.upgrade() else { return };
                    if let Err(e) = l.tidy_if_due().await {
                        eprintln!("tidy pass failed: {e}");
                    }
                    drop(l);
                    tokio::time::sleep(Duration::from_millis(every)).await;
                }
            });
            self.jobs.lock().push(tick.abort_handle());
        }
    }

    fn settled_while_down(&self) -> Vec<(String, String)> {
        let mut pile = self.read_pile();
        if s(&pile, "since").is_empty() {
            pile["since"] = Value::String(iso(self.now()));
            self.write_pile(&pile);
        }
        let since = s(&self.read_pile(), "since").to_string();
        let scanned = self.scanned_at();
        let mut out = Vec::new();
        for p in self.dir.list_profiles().unwrap_or_default() {
            let Some(slug) = p.slug().map(str::to_string) else { continue };
            for t in self.index.list(&slug).tickets.iter() {
                if learnable(&t.status) && t.updated_at.as_str() >= since.as_str() && scanned.get(&format!("{slug}/{}", t.id)).and_then(Value::as_str) != Some(t.updated_at.as_str()) {
                    out.push((slug.clone(), t.id.clone()));
                }
            }
        }
        out
    }

    /// Stops the timers and writes `scanned-at.json` if a write is due.
    pub fn stop(&self) {
        for (_, h) in self.timers.lock().drain() {
            h.abort();
        }
        for h in self.jobs.lock().drain(..) {
            h.abort();
        }
        self.flush_scanned();
    }

    fn scanned_at(&self) -> Map<String, Value> {
        let mut g = self.scanned.lock();
        if g.0.is_none() {
            let v = std::fs::read_to_string(self.scanned_file()).ok().and_then(|t| crate::runs::js::parse(&t));
            g.0 = Some(match v {
                Some(Value::Object(m)) => m,
                _ => Map::new(),
            });
        }
        g.0.clone().unwrap_or_default()
    }

    fn note_scanned(self: &Arc<Self>, k: &str, updated_at: &str) {
        self.scanned_at();
        let mut g = self.scanned.lock();
        let all = g.0.get_or_insert_with(Map::new);
        if all.get(k).and_then(Value::as_str) == Some(updated_at) {
            return;
        }
        all.insert(k.into(), Value::String(updated_at.into()));
        if g.1 {
            return;
        }
        g.1 = true;
        let me = Arc::downgrade(self);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(2_000)).await;
                if let Some(me) = me.upgrade() {
                    let _ = tokio::task::spawn_blocking(move || me.flush_scanned()).await;
                }
            });
        }
    }

    fn flush_scanned(&self) {
        let mut g = self.scanned.lock();
        if !g.1 {
            return;
        }
        g.1 = false;
        let Some(m) = g.0.clone() else { return };
        drop(g);
        let _ = std::fs::create_dir_all(self.learned_dir());
        let _ = ckanban_core::atomic::atomic_write(&self.scanned_file(), render(&Value::Object(m), formats::LEARNED_SCANNED_AT));
    }

    fn schedule(self: &Arc<Self>, slug: &str, id: &str) {
        let k = format!("{slug}/{id}");
        let me = self.clone();
        let (s2, i2, k2) = (slug.to_string(), id.to_string(), k.clone());
        let settle = self.o.settle_ms;
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(settle)).await;
            me.timers.lock().remove(&k2);
            if let Err(e) = me.scan_ticket(&s2, &i2).await {
                eprintln!("learning from {k2} failed: {e}");
            }
        });
        if let Some(old) = self.timers.lock().insert(k, task.abort_handle()) {
            old.abort();
        }
    }

    /// `scanTicket`: a settled ticket's new corrections (each read once) into the pile with one cheap call; saves a
    /// lesson that came back or that the user made a standing rule. The candidates it touched.
    pub async fn scan_ticket(self: &Arc<Self>, slug: &str, id: &str) -> Result<Vec<Value>, String> {
        let _g = self.serial.lock().await;
        let me = self.clone();
        let (sl, i) = (slug.to_string(), id.to_string());
        type Prep = (Map<String, Value>, Vec<Value>, Corrections, String, Vec<Value>, String, Vec<(String, Option<String>)>);
        let prep: Option<Prep> = tokio::task::spawn_blocking(move || {
            let t = me.index.ticket(&sl, &i)?;
            if !learnable(&t.status) || me.o.runs.is_running(&sl, &i) {
                return None;
            }
            let mut pile = me.read_pile();
            let since = s(&pile, "since");
            if !since.is_empty() && t.updated_at.as_str() < since {
                return None;
            }
            let session = t.json.get("sessionId").and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string);
            let entries = session.map(|sid| me.o.sessions.entries(&sid)).unwrap_or_default();
            let t = me.index.ticket(&sl, &i)?;
            if !learnable(&t.status) || me.o.runs.is_running(&sl, &i) {
                return None;
            }
            let k = format!("{sl}/{i}");
            me.note_scanned(&k, &t.updated_at);
            let list = me.index.list(&sl);
            let maps: Vec<&Map<String, Value>> = list.tickets.iter().map(|x| &x.json).collect();
            let all = lessons::corrections(&t.json, &entries, &maps);
            let seen: Vec<String> = pile["scanned"].get(&k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let fresh = learn::new_corrections(&all, &seen);
            if !lessons::has_corrections(&fresh) {
                return None;
            }
            let mut keys = seen.clone();
            for x in learn::correction_keys(&all) {
                if !keys.contains(&x) {
                    keys.push(x);
                }
            }
            if !pile["scanned"].is_object() {
                pile["scanned"] = json!({});
            }
            pile["scanned"][&k] = json!(keys);
            me.write_pile(&pile);
            let dest = json!({ "kind": "rules", "slug": sl });
            let said: String = fresh.messages.iter().map(|e| s(e, "text")).collect::<Vec<_>>().join("\n");
            let short = learn::shortlist(&pile, "ticket", &dest, &format!("{} {said}", t.title), SHORTLIST);
            let prompt = format!(
                "{}\n\nPILE:\n{}",
                lessons::lessons_prompt(&t.json, &entries, &fresh, &me.existing_rules(&sl)),
                learn::pile_text(&short)
            );
            let chain: Vec<(String, Option<String>)> = list.tickets.iter().map(|x| (x.id.clone(), x.json.get("madeFrom").and_then(Value::as_str).map(str::to_string))).collect();
            Some((t.json.clone(), short, fresh, said, vec![dest], prompt, chain))
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some((t, short, _fresh, said, dest, prompt, chain)) = prep else { return Ok(Vec::new()) };
        let k = format!("{slug}/{id}");
        let r = (self.o.side)(SideCallInput {
            system: learn::LEARN_SYSTEM.clone(),
            prompt,
            model: Some(LEARN_MODEL.into()),
            timeout_ms: Some(180_000),
            ..Default::default()
        })
        .await;
        let (text, cost) = match r {
            SideCallResult::Err { error, .. } => {
                eprintln!("learning from {k}: {error}");
                return Ok(Vec::new());
            }
            SideCallResult::Ok { text, cost_usd, .. } => (text, cost_usd),
        };
        let me = self.clone();
        let (sl, i) = (slug.to_string(), id.to_string());
        tokio::task::spawn_blocking(move || {
            let _ = add_side_spend(&me.dir.side_spend_path(&sl, &i), "learn", cost, None);
            let ids: Vec<String> = short.iter().map(|c| s(c, "id").to_string()).collect();
            let found = learn::parse_learned(&text, &ids, 3, false).unwrap_or_default();
            if found.is_empty() {
                return Vec::new();
            }
            let mut pile = me.read_pile();
            let at = iso(me.now());
            let title = t.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            let key = learn::ticket_key(&sl, &i, t.get("madeFrom").and_then(Value::as_str), &chain);
            let mut out = Vec::new();
            for l in found {
                let raw = if l.evidence.is_empty() { &l.mistake } else { &l.evidence };
                let quote = crate::prompts::js::slice16(&note_text(raw), 200).to_string();
                let source = json!({ "kind": "ticket", "slug": sl, "id": i, "title": title, "by": "you", "at": at, "quote": quote, "key": key });
                let idx = learn::add_to_pile(&mut pile, &l, "ticket", &dest[0], &source, Some(&said), &mut || (me.o.new_id)());
                if learn::should_promote(&learn::candidates(&pile)[idx]) {
                    let mut c = learn::candidates(&pile)[idx].clone();
                    me.promote(&mut c);
                    learn::candidates_mut(&mut pile)[idx] = c;
                }
                out.push(learn::candidates(&pile)[idx].clone());
            }
            learn::prune(&mut pile, me.now(), PILE_CAP);
            me.write_pile(&pile);
            me.emit(Some(&sl));
            out
        })
        .await
        .map_err(|e| e.to_string())
    }

    // ---- Huddle lessons ----

    /// `addHuddleLessons`: lessons a huddle agent proposed when it turned done (`role`: where they would go).
    pub async fn add_huddle_lessons(self: &Arc<Self>, slug: &str, huddle: &str, host_ticket: &str, handle: &str, role: &str, lessons: Vec<Lesson>) -> Vec<Value> {
        let _g = self.serial.lock().await;
        if lessons.is_empty() {
            return Vec::new();
        }
        let pile = self.read_pile();
        let dests: Vec<Value> = lessons.iter().map(|l| json!({ "kind": "notes", "role": role, "scope": l.scope, "slug": slug })).collect();
        let mut short: Vec<Value> = Vec::new();
        for (i, d) in dests.iter().enumerate() {
            for c in learn::shortlist(&pile, "huddle", d, &lessons[i].text, SHORTLIST) {
                match short.iter_mut().find(|x| s(x, "id") == s(&c, "id")) {
                    Some(x) => *x = c,
                    None => short.push(c),
                }
            }
        }
        short.truncate(40);
        let pairs: Vec<(String, String)> = lessons.iter().map(|l| (l.text.clone(), l.evidence.clone())).collect();
        let r = (self.o.side)(SideCallInput {
            system: learn::HUDDLE_LEARN_SYSTEM.clone(),
            prompt: learn::huddle_learn_prompt(role, &pairs, &short),
            model: Some(LEARN_MODEL.into()),
            timeout_ms: Some(120_000),
            ..Default::default()
        })
        .await;
        let me = self.clone();
        let (sl, hid, host, handle) = (slug.to_string(), huddle.to_string(), host_ticket.to_string(), handle.to_string());
        tokio::task::spawn_blocking(move || {
            let found = match &r {
                SideCallResult::Ok { text, cost_usd, .. } => {
                    let _ = add_side_spend(&me.dir.side_spend_path(&sl, &host), "learn", *cost_usd, None);
                    let ids: Vec<String> = short.iter().map(|c| s(c, "id").to_string()).collect();
                    learn::parse_learned(text, &ids, 3, true).unwrap_or_default()
                }
                SideCallResult::Err { error, .. } => {
                    eprintln!("learning from huddle {hid}: {error}");
                    Vec::new()
                }
            };
            let mut pile = me.read_pile();
            let at = iso(me.now());
            let title = me.index.ticket(&sl, &host).map(|t| t.title.clone()).unwrap_or_else(|| "a huddle".into());
            let mut out = Vec::new();
            for (i, l) in lessons.iter().enumerate() {
                let learned = found.get(i).cloned().unwrap_or(Learned { text: String::new(), r#match: None, ..Default::default() });
                let source = json!({
                    "kind": "huddle", "slug": sl, "id": hid, "title": title, "by": handle, "at": at, "quote": l.text,
                    "key": learn::huddle_key(&sl, &hid), "ticket": host,
                });
                let idx = learn::add_to_pile(&mut pile, &learned, "huddle", &dests[i], &source, None, &mut || (me.o.new_id)());
                if learn::should_promote(&learn::candidates(&pile)[idx]) {
                    let mut c = learn::candidates(&pile)[idx].clone();
                    me.promote(&mut c);
                    learn::candidates_mut(&mut pile)[idx] = c;
                }
                out.push(learn::candidates(&pile)[idx].clone());
            }
            learn::prune(&mut pile, me.now(), PILE_CAP);
            me.write_pile(&pile);
            me.emit(Some(&sl));
            out
        })
        .await
        .unwrap_or_default()
    }

    // ---- Saving ----

    /// `promote`: writes a candidate where it goes (newest first) and logs the change; the caller writes the pile.
    fn promote(&self, c: &mut Value) {
        let now = self.now();
        let today = iso(now)[..10].to_string();
        let last = c.get("sources").and_then(Value::as_array).and_then(|a| a.last()).cloned();
        let d = c["dest"].clone();
        let ticket = s(c, "kind") == "ticket";
        let note = Note {
            text: s(c, "text").to_string(),
            by: if ticket { "board".into() } else { last.as_ref().and_then(|l| l.get("by")).and_then(Value::as_str).unwrap_or("board").to_string() },
            date: Some(today),
            huddle: if s(c, "kind") == "huddle" { last.as_ref().and_then(|l| l.get("id")).and_then(Value::as_str).map(str::to_string) } else { None },
        };
        let text = note_text(s(c, "text")).to_lowercase();
        let slug = s(&d, "slug").to_string();
        let keep = |ns: Vec<Note>| {
            let mut out = vec![note.clone()];
            out.extend(ns.into_iter().filter(|n| note_text(&n.text).to_lowercase() != text));
            out
        };
        let edit = if s(&d, "kind") == "rules" {
            self.edit_notes(&slug, "rules", Scope::Repo, keep)
        } else {
            self.edit_notes(&slug, s(&d, "role"), learn::scope_of(&d), keep)
        };
        let general = s(&d, "kind") == "notes" && s(&d, "scope") == "general";
        let id = (self.o.new_id)();
        let change = json!({
            "id": id, "at": iso(self.now()), "kind": "saved", "slug": if general { Value::Null } else { Value::String(slug) },
            "edits": [edit], "text": s(c, "text"), "old": [], "where": learn::where_text(&d), "candidateId": s(c, "id"), "sources": c.get("sources"),
        });
        c["state"] = Value::String("saved".into());
        c["changeId"] = Value::String(id);
        self.add_change(change);
    }

    fn dest_board(c: &Value) -> Option<String> {
        let d = &c["dest"];
        if s(d, "kind") == "notes" && s(d, "scope") == "general" { None } else { Some(s(d, "slug").to_string()) }
    }

    /// `saveNow`: the user saves a lesson seen once.
    pub async fn save_now(self: &Arc<Self>, id: &str) -> Result<Value, LearnError> {
        let _g = self.serial.lock().await;
        let me = self.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let mut pile = me.read_pile();
            let Some(i) = learn::candidates(&pile).iter().position(|x| s(x, "id") == id) else { return Err(err(404, "that lesson is gone")) };
            let mut c = learn::candidates(&pile)[i].clone();
            let state = s(&c, "state").to_string();
            if state != "watching" {
                return Err(err(409, format!("that lesson was already {state}")));
            }
            if !ckanban_core::jsnum::truthy(c.get("general")) {
                return Err(err(409, "that lesson isn't in general words yet; the board saves it once it comes up again"));
            }
            me.promote(&mut c);
            learn::candidates_mut(&mut pile)[i] = c.clone();
            me.write_pile(&pile);
            me.emit(Self::dest_board(&c).as_deref());
            Ok(c)
        })
        .await
        .map_err(|e| err(500, e.to_string()))?
    }

    /// `drop`: the user drops a lesson seen once (keep: puts it back).
    pub async fn drop_lesson(self: &Arc<Self>, id: &str, keep: bool) -> Result<Value, LearnError> {
        let _g = self.serial.lock().await;
        let me = self.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let mut pile = me.read_pile();
            let Some(i) = learn::candidates(&pile).iter().position(|x| s(x, "id") == id) else { return Err(err(404, "that lesson is gone")) };
            let state = s(&learn::candidates(&pile)[i], "state").to_string();
            if state != if keep { "dropped" } else { "watching" } {
                return Err(err(409, format!("that lesson is {state}")));
            }
            let c = &mut learn::candidates_mut(&mut pile)[i];
            c["state"] = Value::String(if keep { "watching" } else { "dropped" }.into());
            let c = c.clone();
            me.write_pile(&pile);
            Ok(c)
        })
        .await
        .map_err(|e| err(500, e.to_string()))?
    }

    // ---- Undo and redo ----

    /// `undo`: each file back to how it was when nothing else changed it since, else note by note.
    pub async fn undo(self: &Arc<Self>, id: &str, redo: bool) -> Result<Value, LearnError> {
        let _g = self.serial.lock().await;
        let me = self.clone();
        let id = id.to_string();
        tokio::task::spawn_blocking(move || {
            let mut cs = me.changes();
            let Some(i) = cs.iter().position(|x| s(x, "id") == id) else { return Err(err(404, "that change is gone")) };
            let undone = ckanban_core::jsnum::truthy(cs[i].get("undoneAt"));
            if if redo { !undone } else { undone } {
                return Err(err(409, if redo { "that change isn't undone" } else { "that change was already undone" }));
            }
            let mut edits: Vec<Value> = cs[i].get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
            if !redo {
                edits.reverse();
            }
            for e in &edits {
                let text = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_string);
                let (from, to) = if redo { (text("before"), text("after")) } else { (text("after"), text("before")) };
                let file = PathBuf::from(s(e, "file"));
                let role = s(e, "role");
                let scope = if s(e, "scope") == "general" { Scope::General } else { Scope::Repo };
                let now = Self::read(&file);
                if now == from {
                    Self::put(&file, to.as_deref());
                } else {
                    let ns = learn::shift_notes(&now.as_deref().map(parse_notes).unwrap_or_default(), from.as_deref(), to.as_deref());
                    if ns.is_empty() && to.is_none() {
                        Self::put(&file, None);
                    } else {
                        Self::put(&file, Some(&Self::write_shelf(role, scope, &ns)));
                    }
                }
            }
            cs[i]["undoneAt"] = if redo { Value::Null } else { Value::String(iso(me.now())) };
            me.write_changes(&cs);
            let c = cs[i].clone();
            if let Some(cid) = c.get("candidateId").and_then(Value::as_str).filter(|x| !x.is_empty()) {
                let mut pile = me.read_pile();
                if let Some(cand) = learn::candidates_mut(&mut pile).iter_mut().find(|x| s(x, "id") == cid) {
                    cand["state"] = Value::String(if redo { "saved" } else { "undone" }.into());
                    me.write_pile(&pile);
                }
            }
            me.emit(c.get("slug").and_then(Value::as_str));
            Ok(c)
        })
        .await
        .map_err(|e| err(500, e.to_string()))?
    }

    // ---- Tidy ----

    /// `tidyIfDue`.
    pub async fn tidy_if_due(self: &Arc<Self>) -> Result<Vec<Value>, String> {
        let last = s(&self.read_pile(), "tidyAt").to_string();
        if !last.is_empty() && self.now() - ms(&last) < TIDY_DAYS * DAY {
            return Ok(Vec::new());
        }
        self.tidy().await
    }

    fn note_file_roles(&self, slug: &str, scope: Scope) -> Vec<String> {
        let dir = if scope == Scope::General { self.dir.root.join("huddle-notes") } else { self.dir.profile_dir(slug).join("huddle-notes") };
        let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
        let mut out: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter_map(|f| f.strip_suffix(".md").map(String::from)).collect();
        out.sort();
        out
    }

    /// `tidy`: one call per group of notes; applied at once, one logged change per step.
    pub async fn tidy(self: &Arc<Self>) -> Result<Vec<Value>, String> {
        let _g = self.serial.lock().await;
        let me = self.clone();
        let groups = tokio::task::spawn_blocking(move || {
            let mut groups: Vec<(String, Scope, Vec<String>)> = Vec::new();
            let boards: Vec<String> = me.dir.list_profiles().unwrap_or_default().iter().filter_map(|p| p.slug().map(str::to_string)).collect();
            if let Some(first) = boards.first() {
                groups.push((first.clone(), Scope::General, me.note_file_roles(first, Scope::General)));
            }
            for b in &boards {
                groups.push((b.clone(), Scope::Repo, me.note_file_roles(b, Scope::Repo)));
                if me.rules_file(b).exists() {
                    groups.push((b.clone(), Scope::Repo, vec!["rules".into()]));
                }
            }
            groups
        })
        .await
        .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let (mut called, mut failed) = (0, 0);
        for (slug, scope, roles) in groups {
            match self.tidy_group(&slug, scope, &roles).await {
                Ok(Some(steps)) => {
                    called += 1;
                    out.extend(steps);
                }
                Ok(None) => {}
                Err(e) => {
                    called += 1;
                    failed += 1;
                    eprintln!("tidy {} {slug}: {e}", scope.name());
                }
            }
        }
        if failed > 0 && failed == called {
            return Ok(out);
        }
        let mut pile = self.read_pile();
        pile["tidyAt"] = Value::String(iso(self.now()));
        self.write_pile(&pile);
        if !out.is_empty() {
            self.emit(None);
        }
        Ok(out)
    }

    async fn tidy_group(self: &Arc<Self>, slug: &str, scope: Scope, roles: &[String]) -> Result<Option<Vec<Value>>, String> {
        let raw = |me: &Learner| roles.iter().map(|r| Self::read(&me.shelf_file(slug, r, scope))).collect::<Vec<_>>();
        let was = raw(self);
        let mut uid = 0usize;
        let mut files: learn::Files = Vec::new();
        for (i, r) in roles.iter().enumerate() {
            let ns = was[i].as_deref().map(parse_notes).unwrap_or_default();
            files.push((r.clone(), ns.into_iter().map(|n| {
                uid += 1;
                (uid, n)
            }).collect()));
        }
        let list: Vec<TidyNote> = files.iter().flat_map(|(role, ns)| ns.iter().map(move |(u, n)| TidyNote { role: role.clone(), note: n.clone(), uid: *u })).collect();
        if !list.iter().any(|n| n.note.by != "you") {
            return Ok(None);
        }
        let targets: Vec<String> = if roles.iter().any(|r| r == "rules") {
            vec!["rules".into()]
        } else {
            let mut t: Vec<String> = Vec::new();
            for r in roles.iter().map(String::as_str).chain([ALL_ROLES]) {
                if !t.iter().any(|x| x == r) {
                    t.push(r.to_string());
                }
            }
            t
        };
        let r = (self.o.side)(SideCallInput {
            system: learn::TIDY_SYSTEM.clone(),
            prompt: learn::tidy_prompt(&list, &targets),
            model: Some(TIDY_MODEL.into()),
            timeout_ms: Some(240_000),
            ..Default::default()
        })
        .await;
        let text = match r {
            SideCallResult::Err { error, .. } => return Err(error),
            SideCallResult::Ok { text, .. } => text,
        };
        if raw(self) != was {
            return Ok(Some(Vec::new()));
        }
        let ops = learn::parse_tidy(&text, &list, &targets).unwrap_or_default();
        let today = iso(self.now())[..10].to_string();
        let mut out = Vec::new();
        let mut cur = files;
        for op in ops {
            let next = learn::apply_tidy_op(&cur, &op, &list, &today, &mut uid);
            let notes_of = |f: &learn::Files, role: &str| f.iter().find(|(r, _)| r == role).map(|(_, v)| v.iter().map(|(_, n)| n.clone()).collect::<Vec<_>>());
            let mut edits = Vec::new();
            for (role, ns) in &next {
                let now: Vec<Note> = ns.iter().map(|(_, n)| n.clone()).collect();
                if now != notes_of(&cur, role).unwrap_or_default() {
                    edits.push(self.edit_notes(slug, role, scope, |_| now.clone()));
                }
            }
            cur = next;
            if edits.is_empty() {
                continue;
            }
            out.push(self.tidy_change(&op, &list, edits, slug, scope));
        }
        Ok(Some(out))
    }

    fn tidy_change(&self, op: &TidyOp, list: &[TidyNote], edits: Vec<Value>, slug: &str, scope: Scope) -> Value {
        let old: Vec<String> = op.ids().iter().map(|n| note_text(&list[n - 1].note.text)).collect();
        let (kind, role, text, why) = match op {
            TidyOp::Merge { to, text, why, .. } => ("merged", to.clone(), text.clone(), why.clone()),
            TidyOp::Rewrite { to, text, why, .. } => ("rewrote", to.clone(), text.clone(), why.clone()),
            TidyOp::Remove { id, why } => ("removed", list[id - 1].role.clone(), old[0].clone(), why.clone()),
        };
        let dest = if role == "rules" { json!({ "kind": "rules", "slug": slug }) } else { json!({ "kind": "notes", "role": role, "scope": scope.name(), "slug": slug }) };
        let change = json!({
            "id": (self.o.new_id)(), "at": iso(self.now()), "kind": kind, "slug": if scope == Scope::General { Value::Null } else { Value::String(slug.into()) },
            "edits": edits, "text": text, "old": old, "why": why, "where": learn::where_text(&dest),
        });
        self.add_change(change.clone());
        change
    }

    // ---- The Learned view ----

    /// `view`: one board's Learned view, its own and what every board shares.
    pub fn view(&self, slug: &str) -> Value {
        let now = self.now();
        let pile = self.read_pile();
        let recent = |c: &Value, days: f64| now - ms(s(c, "at")) < days * DAY;
        let mut all: Vec<Value> = self.changes().into_iter().filter(|c| matches!(c.get("slug"), Some(Value::Null)) || c.get("slug").and_then(Value::as_str) == Some(slug)).collect();
        all.reverse();
        let seen = pile.get("seen").and_then(|x| x.get(slug)).and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string);
        let saved: Vec<Value> = all.iter().filter(|c| s(c, "kind") == "saved" && recent(c, SAVED_DAYS)).cloned().collect();
        let cleaned: Vec<Value> = all.iter().filter(|c| s(c, "kind") != "saved" && recent(c, CLEANED_DAYS)).cloned().collect();
        let mut watching: Vec<Value> = learn::candidates(&pile)
            .iter()
            .filter(|c| s(c, "state") == "watching" && (c["dest"].get("slug").and_then(Value::as_str) == Some(slug) || (s(&c["dest"], "kind") == "notes" && s(&c["dest"], "scope") == "general")))
            .cloned()
            .collect();
        watching.sort_by(|a, b| crate::runs::js::locale_compare(s(b, "lastAt"), s(a, "lastAt")));
        watching.truncate(WATCHING_MAX);
        let new_count = saved.iter().filter(|c| !ckanban_core::jsnum::truthy(c.get("undoneAt")) && seen.as_deref().is_none_or(|x| s(c, "at") > x)).count();
        json!({
            "saved": saved, "cleaned": cleaned, "watching": watching, "newCount": new_count,
            "tidyAt": match pile.get("tidyAt") { Some(Value::Null) | None => Value::Null, Some(x) => x.clone() },
        })
    }

    /// `markSeen`: what was saved so far counts as seen.
    pub async fn mark_seen(self: &Arc<Self>, slug: &str) {
        let _g = self.serial.lock().await;
        let me = self.clone();
        let sl = slug.to_string();
        let _ = tokio::task::spawn_blocking(move || {
            let mut pile = me.read_pile();
            if !pile.get("seen").is_some_and(Value::is_object) {
                pile["seen"] = json!({});
            }
            pile["seen"][&sl] = Value::String(iso(me.now()));
            me.write_pile(&pile);
            me.emit(Some(&sl));
        })
        .await;
    }
}
