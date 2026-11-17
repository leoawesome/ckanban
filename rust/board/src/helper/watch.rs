//! What waits on the user, followed ticket by ticket (the watching half of `src/helper/notify.ts` `Notifier`): at
//! start a stock-take reconciled with the waits file, then ticket, session and huddle changes, each turned into one
//! wait when its new state has held for 5 seconds (`TransitionTracker`); a main ticket's steps' questions are waits of
//! their own. Also `notify_user` (`Notifier.message`): a ticket's Claude telling the user something itself.
//!
//! Bus events only mark tickets to look at (cheap, on the emitter's thread); the looking happens on the 1-second
//! tick, off the runtime.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ckanban_core::time::iso;
use parking_lot::Mutex;
use serde_json::{Value, json};

use super::core::{HelperCore, OutBody};
use super::messages::NewMessage;
use super::notify_settings::kind_on;
use super::waits::{NewWait, wait_identity};
use crate::bus::BusEvent;
use crate::index::attention::{step_wait, ticket_attention};
use crate::index::family::feature_rows;
use crate::index::store::BoardList;
use crate::index::ticket::Tk;
use crate::runs::js;

pub const DEBOUNCE_MS: f64 = 5000.0;
pub const CLAUDE_MESSAGE_MAX: usize = 200;
pub const CLAUDE_MESSAGE_GAP_MS: f64 = 10.0 * 60_000.0;
pub const TOOL_NO_NOTIFY: &str = "Tool tickets report to their main ticket; end your run with your question instead.";

/// One notification per transition into a state, once the state has held for the debounce (`TransitionTracker`).
#[derive(Default)]
pub struct Tracker {
    states: HashMap<String, (Option<String>, Option<String>, f64)>,
    order: Vec<String>,
    debounce: f64,
}

impl Tracker {
    pub fn new(debounce: f64) -> Self {
        Tracker { debounce, ..Default::default() }
    }

    fn put(&mut self, key: &str, v: (Option<String>, Option<String>, f64)) {
        if !self.states.contains_key(key) {
            self.order.push(key.to_string());
        }
        self.states.insert(key.to_string(), v);
    }

    pub fn seed(&mut self, key: &str, kind: Option<String>, now: f64) {
        self.put(key, (kind.clone(), kind, now));
    }

    pub fn observe(&mut self, key: &str, kind: Option<String>, now: f64) -> Option<String> {
        if !self.states.contains_key(key) {
            self.put(key, (None, kind.clone(), now));
        }
        let s = self.states.get_mut(key).expect("present");
        if s.1 != kind {
            s.1 = kind;
            s.2 = now;
        }
        if s.1 == s.0 || now - s.2 < self.debounce {
            return None;
        }
        s.0 = s.1.clone();
        s.0.clone()
    }

    /// The settled state: None when never seen, Some(None) when settled on "not waiting".
    pub fn settled_of(&self, key: &str) -> Option<Option<String>> {
        self.states.get(key).map(|s| s.0.clone())
    }

    pub fn unsettled(&self) -> Vec<String> {
        self.order.iter().filter(|k| self.states.get(*k).is_some_and(|s| s.1 != s.0)).cloned().collect()
    }

    pub fn forget(&mut self, key: &str) {
        self.states.remove(key);
        self.order.retain(|k| k != key);
    }
}

struct StepAsk {
    step_id: String,
    wait: NewWait,
    with_you: bool,
}

#[derive(Default)]
struct WatchState {
    tracker: Tracker,
    step_keys: HashMap<String, Vec<String>>,
    dirty: Vec<String>,
    events: Vec<Arc<BusEvent>>,
    started: bool,
}

pub struct Watcher {
    core: Arc<HelperCore>,
    st: Mutex<WatchState>,
}

fn add_dirty(d: &mut Vec<String>, k: String) {
    if !d.contains(&k) {
        d.push(k);
    }
}

/// `mainTicketOf`: the nearest main ticket above (not the ticket itself), else the family's top.
pub fn main_ticket_of(list: &BoardList, id: &str) -> Option<Arc<Tk>> {
    let mut seen = HashSet::new();
    let mut cur = list.get(id).cloned();
    let mut top = cur.clone();
    while let Some(c) = cur {
        if !seen.insert(c.id.clone()) {
            break;
        }
        if c.main && c.id != id {
            return Some(c);
        }
        top = Some(c.clone());
        cur = c.parent_link().and_then(|(p, _)| list.get(p).cloned());
    }
    top.filter(|t| t.id != id)
}

fn with_you_tool(t: &Tk) -> bool {
    t.tool && t.kind.as_deref() == Some("with_you")
}

/// What `notify_user` answers (`MessageResult`) or why it is refused (status, message).
pub type MessageOutcome = Result<Value, (u16, String)>;

impl Watcher {
    pub fn new(core: Arc<HelperCore>) -> Arc<Self> {
        Arc::new(Watcher { core, st: Mutex::new(WatchState { tracker: Tracker::new(DEBOUNCE_MS), ..Default::default() }) })
    }

    /// A board event (from the bus): kept for the next tick.
    pub fn on_event(&self, e: &Arc<BusEvent>) {
        if matches!(e.ty.as_str(), "ticket.updated" | "session.updated" | "huddle.updated" | "ticket.deleted" | "profile.updated") {
            self.st.lock().events.push(e.clone());
        }
    }

    fn take_events(&self) {
        let events = std::mem::take(&mut self.st.lock().events);
        for e in events {
            let b = &e.body;
            let profile = b.get("profile").and_then(Value::as_str).unwrap_or("").to_string();
            match e.ty.as_str() {
                "ticket.updated" => {
                    let Some(t) = b.get("ticket") else { continue };
                    let id = t.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let mut st = self.st.lock();
                    add_dirty(&mut st.dirty, format!("{profile}/{id}"));
                    if js::truthy(t.get("tool")) {
                        drop(st);
                        if let Some(main) = main_ticket_of(&self.core.board.list(&profile), &id) {
                            add_dirty(&mut self.st.lock().dirty, format!("{profile}/{}", main.id));
                        }
                    }
                }
                "session.updated" => {
                    let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    add_dirty(&mut self.st.lock().dirty, format!("{profile}/{id}"));
                    if self.core.board.ticket(&profile, &id).is_some_and(|t| t.tool)
                        && let Some(main) = main_ticket_of(&self.core.board.list(&profile), &id)
                    {
                        add_dirty(&mut self.st.lock().dirty, format!("{profile}/{}", main.id));
                    }
                }
                "huddle.updated" => {
                    if let Some(host) = b.get("huddle").and_then(|h| h.get("hostTicket")).and_then(Value::as_str).filter(|h| !h.is_empty()) {
                        add_dirty(&mut self.st.lock().dirty, format!("{profile}/{host}"));
                    }
                }
                "ticket.deleted" => {
                    let id = b.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let key = format!("{profile}/{id}");
                    {
                        let mut st = self.st.lock();
                        st.tracker.forget(&key);
                        for sid in st.step_keys.remove(&key).unwrap_or_default() {
                            st.tracker.forget(&format!("{key}~{sid}"));
                        }
                        let mains: Vec<String> = st.step_keys.iter().filter(|(k, ids)| k.starts_with(&format!("{profile}/")) && ids.contains(&id)).map(|(k, _)| k.clone()).collect();
                        for k in mains {
                            add_dirty(&mut st.dirty, k);
                        }
                    }
                    self.core.deleted(&profile, Some(&id));
                }
                "profile.updated" => {
                    if b.get("profile").is_some_and(Value::is_null)
                        && let Some(slug) = b.get("slug").and_then(Value::as_str)
                    {
                        self.core.deleted(slug, None);
                    }
                }
                _ => {}
            }
        }
    }

    /// A ticket's session summary. Not for Done and Backlog tickets, which can't wait on the user (`ownAttention`):
    /// the start-up stock-take over a big board then reads no transcript of them (the satellite never had them).
    fn session_of(&self, t: &Tk) -> Option<Value> {
        if t.status == "done" || t.status == "backlog" {
            return None;
        }
        t.s("sessionId").filter(|s| !s.is_empty()).and_then(|s| self.core.board.session(s))
    }

    fn step_question(&self, slug: &str, main_id: &str, step: &Tk, label: &str, since: &str) -> NewWait {
        let s = self.session_of(step);
        let form = open_form(s.as_ref());
        let ask = form.as_ref().filter(|f| !f.is_empty()).and_then(|_| s.as_ref().and_then(|s| s.get("openAsk")).cloned());
        let identity = wait_identity("questions", Some(&format!("{}\n{}", step.id, form.clone().unwrap_or_default())));
        NewWait {
            board: slug.into(),
            ticket_id: main_id.into(),
            kind: "questions".into(),
            identity,
            question: form.unwrap_or_else(|| label.to_string()),
            label: label.into(),
            since: since.into(),
            urgent: ask.as_ref().is_some_and(|a| js::truthy(a.get("urgent"))),
            why: ask.as_ref().and_then(|a| a.get("why")).and_then(Value::as_str).map(str::to_string),
        }
    }

    /// What the ticket waits on now, as a wait (`waitOf`).
    fn wait_of(&self, slug: &str, id: &str) -> Option<NewWait> {
        let t = self.core.board.ticket(slug, id)?;
        let s = self.session_of(&t);
        let list = self.core.board.list(slug);
        let board = self.core.board.clone();
        let running = board.running(slug, id);
        let host = board.host(slug, id);
        let att = ticket_attention(&list, &t, s.as_ref(), running, host.as_ref(), &|x| board.running(slug, x), &|| board.schedule_ids(slug))?;
        if att.kind == "questions"
            && let Some(step) = att.step_id.as_deref().and_then(|sid| board.ticket(slug, sid))
        {
            let mut w = self.step_question(slug, id, &step, &att.label, &att.since);
            w.label = att.label.clone();
            return Some(w);
        }
        let form = if att.kind == "questions" { open_form(s.as_ref()) } else { None };
        let ask = form.as_ref().filter(|f| !f.is_empty()).and_then(|_| s.as_ref().and_then(|s| s.get("openAsk")).cloned());
        Some(NewWait {
            board: slug.into(),
            ticket_id: id.into(),
            kind: att.kind.clone(),
            identity: wait_identity(&att.kind, form.as_deref()),
            question: form.unwrap_or_else(|| att.label.clone()),
            label: att.label.clone(),
            since: att.since.clone(),
            urgent: ask.as_ref().is_some_and(|a| js::truthy(a.get("urgent"))),
            why: ask.as_ref().and_then(|a| a.get("why")).and_then(Value::as_str).map(str::to_string),
        })
    }

    /// On a main ticket: each tool ticket waiting on a question, as a wait under the main ticket (`stepAsks`).
    fn step_asks(&self, slug: &str, id: &str) -> Vec<StepAsk> {
        let Some(t) = self.core.board.ticket(slug, id) else { return Vec::new() };
        if !t.main || t.status == "done" || t.status == "backlog" {
            return Vec::new();
        }
        let list = self.core.board.list(slug);
        let board = &self.core.board;
        let plan = t.get("plan");
        let plan_state = plan.and_then(|p| p.get("state")).and_then(Value::as_str);
        let inbox = plan.and_then(|p| p.get("inbox")).and_then(Value::as_array).is_some_and(|a| !a.is_empty());
        let handling = board.running(slug, id) || (matches!(plan_state, Some("running" | "finishing")) && (js::truthy(plan.and_then(|p| p.get("awaiting"))) || inbox));
        let ended = t.s("runEndedAt").unwrap_or("").to_string();
        let mut out = Vec::new();
        for r in feature_rows(&list, id) {
            let rt = list.at(r.idx);
            if rt.id == id || !rt.hidden_tool() {
                continue;
            }
            let Some(sw) = step_wait(rt, board.running(slug, &rt.id)) else { continue };
            if sw.attention != "questions" {
                continue;
            }
            if !sw.with_you && (handling || js::cmp16(&sw.since, &ended).is_le()) {
                continue;
            }
            out.push(StepAsk { step_id: rt.id.clone(), wait: self.step_question(slug, id, rt, &sw.label, &sw.since), with_you: sw.with_you });
        }
        out
    }

    /// The start-up stock-take: what already waits, reconciled with the waits file. Blocking (every ticket).
    pub fn stock_take(&self) {
        let now = (self.core.now)();
        for (slug, _) in self.core.board.profiles() {
            let list = self.core.board.list(&slug);
            for t in list.tickets.iter() {
                let id = t.id.clone();
                let w = self.wait_of(&slug, &id);
                let asks = self.step_asks(&slug, &id);
                {
                    let mut st = self.st.lock();
                    let key = format!("{slug}/{id}");
                    st.tracker.seed(&key, w.as_ref().map(|w| w.identity.clone()), now);
                    for a in &asks {
                        st.tracker.seed(&format!("{key}~{}", a.step_id), Some(a.wait.identity.clone()), now);
                    }
                    if !asks.is_empty() {
                        st.step_keys.insert(key, asks.iter().map(|a| a.step_id.clone()).collect());
                    }
                }
                let settings = self.core.settings();
                let on = kind_on(&settings, "questions");
                let steps: Vec<NewWait> = if on { asks.iter().filter(|a| a.with_you || Some(&a.wait.identity) == w.as_ref().map(|w| &w.identity)).map(|a| a.wait.clone()).collect() } else { Vec::new() };
                let from_step = w.as_ref().is_some_and(|w| asks.iter().any(|a| a.wait.identity == w.identity));
                let shown = w.as_ref().filter(|w| kind_on(&settings, &w.kind));
                self.core.reconcile(&slug, &id, shown, w.as_ref().map(|w| w.identity.as_str()), &steps, from_step);
            }
        }
        self.core.started();
        self.st.lock().started = true;
    }

    /// Look again at changed tickets and those still settling; route what changed (blocking part of the tick).
    /// Returns the waits to route.
    pub fn look(&self) -> Vec<NewWait> {
        if !self.st.lock().started {
            return Vec::new();
        }
        self.take_events();
        let now = (self.core.now)();
        let keys: Vec<String> = {
            let mut st = self.st.lock();
            let mut keys = Vec::new();
            let dirty = std::mem::take(&mut st.dirty);
            for k in dirty.into_iter().chain(st.tracker.unsettled()) {
                let base = k.split('~').next().unwrap_or("").to_string();
                if !keys.contains(&base) {
                    keys.push(base);
                }
            }
            keys
        };
        let mut fire = Vec::new();
        for key in keys {
            let (slug, id) = key.split_once('/').unwrap_or((key.as_str(), ""));
            let w = self.wait_of(slug, id);
            let asks = self.step_asks(slug, id);
            let (before, identity, after) = {
                let mut st = self.st.lock();
                let before = st.tracker.settled_of(&key);
                let identity = st.tracker.observe(&key, w.as_ref().map(|w| w.identity.clone()), now);
                (before, identity, st.tracker.settled_of(&key))
            };
            let step_ids: Vec<String> = asks.iter().map(|a| a.wait.identity.clone()).collect();
            if before.is_some() && before != after {
                self.core.settled(slug, id, after.clone().flatten().as_deref(), &step_ids);
            }
            if identity.is_some()
                && let Some(w) = &w
            {
                fire.push(w.clone());
            }
            fire.extend(self.observe_steps(&key, slug, id, &asks, after.flatten(), now));
        }
        let settings = self.core.settings();
        fire.into_iter().filter(|w| kind_on(&settings, &w.kind) && self.core.board.ticket(&w.board, &w.ticket_id).is_some() && self.core.board.has_profile(&w.board)).collect()
    }

    fn observe_steps(&self, key: &str, slug: &str, id: &str, asks: &[StepAsk], current: Option<String>, now: f64) -> Vec<NewWait> {
        let mut fire = Vec::new();
        let mut known = self.st.lock().step_keys.get(key).cloned().unwrap_or_default();
        for a in asks {
            if !known.contains(&a.step_id) {
                known.push(a.step_id.clone());
            }
        }
        for sid in known.clone() {
            let sk = format!("{key}~{sid}");
            let a = asks.iter().find(|x| x.step_id == sid);
            let (before, identity, after, unsettled) = {
                let mut st = self.st.lock();
                let before = st.tracker.settled_of(&sk);
                let identity = st.tracker.observe(&sk, a.map(|a| a.wait.identity.clone()), now);
                let after = st.tracker.settled_of(&sk);
                (before, identity, after, st.tracker.unsettled().contains(&sk))
            };
            if let Some(Some(b)) = &before
                && before != after
            {
                self.core.step_settled(slug, id, b, current.as_deref());
            }
            if identity.is_some()
                && let Some(a) = a.filter(|a| a.with_you)
            {
                fire.push(a.wait.clone());
            }
            if a.is_none() && after.clone().flatten().is_none() && !unsettled {
                self.st.lock().tracker.forget(&sk);
                known.retain(|x| *x != sid);
            }
        }
        let mut st = self.st.lock();
        if known.is_empty() {
            st.step_keys.remove(key);
        } else {
            st.step_keys.insert(key.to_string(), known);
        }
        fire
    }

    /// notify_user: a ticket's Claude tells the user something in its own words (`Notifier.message`).
    pub async fn message(&self, slug: &str, id: &str, raw: &str, urgent: bool, why: Option<&str>) -> MessageOutcome {
        let text = js::trim(&js::squash_ws(raw)).to_string();
        if text.is_empty() {
            return Err((400, "message is required: what you need from the user, in one short sentence".into()));
        }
        let n = js::len16(&text);
        if n > CLAUDE_MESSAGE_MAX {
            return Err((400, format!("message is too long ({n} characters, max {CLAUDE_MESSAGE_MAX}): keep it to one short ask")));
        }
        let board = self.core.board.clone();
        let (Some(t), true) = (board.ticket(slug, id), board.has_profile(slug)) else { return Err((404, format!("ticket {id} not found"))) };
        let now = (self.core.now)();
        if let Some(last) = self.core.lock().waits.last_notify_user(slug, id)
            && now - last < CLAUDE_MESSAGE_GAP_MS
        {
            let next = iso(last + CLAUDE_MESSAGE_GAP_MS);
            return Err((429, format!("a message was already sent for this ticket in the last {} minutes; the next one is allowed after {next}", (CLAUDE_MESSAGE_GAP_MS / 60_000.0) as u64)));
        }
        let none = json!({ "delivered": false, "devices": 0, "onScreen": 0, "webhook": false, "banner": false, "error": null });
        let settings = self.core.settings();
        if !kind_on(&settings, "message") {
            let mut v = none;
            v["reason"] = "off".into();
            return Ok(v);
        }
        let main = if with_you_tool(&t) { main_ticket_of(&board.list(slug), id) } else { None };
        let target = main.filter(|m| m.id != id).unwrap_or_else(|| t.clone());
        let label = if target.id == id { text.clone() } else { format!("{}: {text}", t.title) };
        let why = why.map(js::trim).filter(|w| !w.is_empty()).map(str::to_string);
        if self.core.active(&settings) {
            self.core
                .route(NewWait {
                    board: slug.into(),
                    ticket_id: target.id.clone(),
                    kind: "message".into(),
                    identity: wait_identity("message", Some(&label)),
                    question: label.clone(),
                    label: label.clone(),
                    since: iso(now),
                    urgent,
                    why,
                })
                .await;
            self.core.lock().waits.set_notify_user(slug, id, now);
            board.add_comment(slug, id, &format!("Passed to the helper: {text}"));
            let mut v = none;
            v["delivered"] = true.into();
            v["reason"] = Value::Null;
            v["helper"] = true.into();
            return Ok(v);
        }
        let board_name = board.board_name(slug);
        let url = self.core.link(slug, Some(&target.id));
        let notify = json!({ "board": slug, "boardName": board_name, "ticketId": target.id, "title": target.title, "kind": "message", "label": label, "url": url });
        let item = json!({ "board": slug, "boardName": board_name, "ticketId": target.id, "title": target.title, "question": label });
        let full = format!("{} ({board_name})\n\n{label}{}", target.title, why.as_ref().map(|w| format!("\n\nWhy: {w}")).unwrap_or_default());
        let level = if urgent { "urgent" } else { "message" };
        let mut m = NewMessage::new(level, js::head16(&format!("{}: {label}", target.title), 240).to_string(), full.clone());
        m.why = why.clone();
        m.items = vec![item];
        let mut out = OutBody::new(level, &target.title, &label, &full, Some(url)).with("notify", notify);
        if urgent {
            out = out.with("urgent", true);
        }
        let (_, results) = self.core.send(m, out, None).await;
        let find = |c: &str| results.iter().find(|r| r.get("channel").and_then(Value::as_str) == Some(c));
        let ok = |r: Option<&Value>| r.is_some_and(|r| r.get("ok") == Some(&Value::Bool(true)));
        let numf = |r: Option<&Value>, k: &str| r.and_then(|r| r.get(k)).and_then(Value::as_f64).unwrap_or(0.0);
        let (hook, push, mac, tg) = (find("webhook"), find("push"), find("mac"), find("telegram"));
        let banner = ok(mac) && mac.and_then(|m| m.get("devices")).is_none_or(Value::is_null);
        let error = first_error(&results);
        let devices = numf(push, "devices") + numf(mac, "devices");
        let on_screen = numf(push, "onScreen") + numf(mac, "onScreen");
        let delivered = banner || ok(hook) || devices > 0.0 || ok(tg);
        if delivered {
            self.core.lock().waits.set_notify_user(slug, id, now);
            board.add_comment(slug, id, &format!("Sent you a notification: {text}"));
        }
        let mut v = serde_json::Map::new();
        v.insert("delivered".into(), delivered.into());
        v.insert("devices".into(), ckanban_core::jsnum::num(devices));
        v.insert("onScreen".into(), ckanban_core::jsnum::num(on_screen));
        v.insert("webhook".into(), ok(hook).into());
        v.insert("banner".into(), banner.into());
        v.insert("error".into(), error.clone().map(Value::String).unwrap_or(Value::Null));
        if let Some(ok) = tg.and_then(|t| t.get("ok")) {
            v.insert("telegram".into(), ok.clone());
        }
        let reason = if delivered {
            Value::Null
        } else if on_screen > 0.0 {
            "on-screen".into()
        } else if error.is_some() {
            Value::Null
        } else {
            "nowhere".into()
        };
        v.insert("reason".into(), reason);
        Ok(Value::Object(v))
    }

    /// A board browser was logged out: an urgent message on every channel (`browserLoggedOut`).
    pub async fn browser_logged_out(&self, name: &str, site: &str, slug: Option<&str>, boards: &[String]) -> Option<String> {
        let body = format!("{name} is logged out of {site}. Open More, Browsers to sign in again.");
        let used = if boards.is_empty() { String::new() } else { format!("\n\nUsed by: {}.", boards.join(", ")) };
        let text = format!("{body}{used}\n\nOn a phone, the Browsers window shows the login page so you can sign in from there.");
        let url = format!("{}?browsers", match slug {
            Some(s) => self.core.link(s, None),
            None => format!("{}/#/", self.core.board.base_url()),
        });
        let m = NewMessage::new("urgent", body.clone(), text.clone());
        let out = OutBody::new("urgent", "Browser logged out", &body, &text, Some(url)).with("urgent", true).with("everyDevice", true).with("tag", format!("browser-{name}"));
        let (_, results) = self.core.send(m, out, None).await;
        first_error(&results)
    }
}

/// The first error worth showing (not the Mac banner, not "no phone turned push on").
fn first_error(results: &[Value]) -> Option<String> {
    results
        .iter()
        .find(|r| r.get("channel").and_then(Value::as_str) != Some("mac") && !js::truthy(r.get("empty")) && r.get("error").and_then(Value::as_str).is_some_and(|e| !e.is_empty()))
        .and_then(|r| r.get("error").and_then(Value::as_str).map(str::to_string))
}

/// A session's open form as one question per line, or None.
fn open_form(s: Option<&Value>) -> Option<String> {
    let f = s?.get("openForm")?.as_array().filter(|a| !a.is_empty())?;
    Some(f.iter().map(|q| match q.get("question") {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_string(v),
    }).collect::<Vec<_>>().join("\n"))
}
