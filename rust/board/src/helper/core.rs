//! The helper's board side without the AI (`src/helper/core.ts` `HelperCore`): wait records, the message store, the
//! channels and the routing switch. Helper on (a runner plugged in and healthy): new waits become records and go to
//! the runner. Helper off or failing: the board sends each wait directly, stored as a message and marked told.
//!
//! The stores sit behind one lock taken for each step, never across a send (an await), the same interleaving as
//! Bun's event loop: a send in progress lets other steps run, and each step re-reads what it needs.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use ckanban_core::time::{iso, parse_date};
use parking_lot::{Mutex, MutexGuard, RwLock};
use serde_json::{Map, Value, json};

use super::board::HelperBoard;
use super::channels::{Sender, send_all};
use super::messages::{self, MessageStore, Msg, NewMessage};
use super::notify_settings::{helper_on, read_notify};
use super::text::{clock_time, cut1, direct_label, usage_limit_line};
use super::waits::{self, NewWait, Rec, WaitStore, WaitsStart, is_open, pending, rb, ro, rs};

pub const URGENT_RECENT_MS: f64 = 24.0 * 3600_000.0;
pub const LIMIT_BATCH_MS: f64 = 60_000.0;

/// Why the runner hears about a record.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reason {
    New,
    Urgent,
    Seeded,
    Restart,
    Message,
}

/// The runner, as the core sees it (`HelperSink`).
pub trait HelperSink: Send + Sync {
    fn healthy(&self) -> bool;
    fn last_success_at(&self) -> Option<f64>;
    fn on_wait(&self, rec: &Rec, reason: Reason);
    fn morning(&self, now: f64) -> Option<f64>;
    fn night_allowed(&self) -> bool;
}

/// What a send carries (`OutBody`): the fields of the out message but `url`, `messageId` and `ticket`; `url` None is
/// the stored message's own page.
#[derive(Clone, Debug, Default)]
pub struct OutBody {
    pub fields: Map<String, Value>,
    pub url: Option<String>,
}

impl OutBody {
    pub fn new(level: &str, title: &str, body: &str, text: &str, url: Option<String>) -> Self {
        let mut f = Map::new();
        f.insert("level".into(), level.into());
        f.insert("title".into(), title.into());
        f.insert("body".into(), body.into());
        f.insert("text".into(), text.into());
        OutBody { fields: f, url }
    }
    pub fn with(mut self, k: &str, v: impl Into<Value>) -> Self {
        self.fields.insert(k.into(), v.into());
        self
    }
}

pub struct Stores {
    pub waits: WaitStore,
    pub messages: MessageStore,
    limit_window: Option<(f64, Vec<String>, Vec<String>)>,
}

pub struct HelperCore {
    pub root: PathBuf,
    st: Mutex<Stores>,
    pub board: Arc<dyn HelperBoard>,
    pub sender: Arc<dyn Sender>,
    sink: RwLock<Option<Weak<dyn HelperSink>>>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

/// `tapTicket`: the one ticket an urgent alert or reminder is about.
pub fn tap_ticket(m: &Msg) -> Value {
    let level = rs(m, "level");
    if level != "urgent" && level != "reminder" {
        return Value::Null;
    }
    let mut seen: Vec<(String, &Value)> = Vec::new();
    for it in messages::items(m) {
        let k = format!("{}/{}", super::text::s(it, "board"), super::text::s(it, "ticketId"));
        if let Some(e) = seen.iter_mut().find(|(x, _)| *x == k) {
            e.1 = it;
        } else {
            seen.push((k, it));
        }
    }
    if seen.len() != 1 {
        return Value::Null;
    }
    let it = seen[0].1;
    json!({ "board": super::text::s(it, "board"), "ticketId": super::text::s(it, "ticketId") })
}

impl HelperCore {
    pub fn new(root: &Path, board: Arc<dyn HelperBoard>, sender: Arc<dyn Sender>, now: Arc<dyn Fn() -> f64 + Send + Sync>, on_unread: Option<messages::Unread>, on_closed: Option<waits::Closed>) -> Arc<Self> {
        let mut w = WaitStore::new(root, now.clone());
        w.on_closed = on_closed;
        let m = MessageStore::new(root, now.clone(), on_unread);
        Arc::new(HelperCore { root: root.to_path_buf(), st: Mutex::new(Stores { waits: w, messages: m, limit_window: None }), board, sender, sink: RwLock::new(None), now })
    }

    pub fn lock(&self) -> MutexGuard<'_, Stores> {
        self.st.lock()
    }

    pub fn set_sink(&self, sink: Weak<dyn HelperSink>) {
        *self.sink.write() = Some(sink);
    }

    fn sink(&self) -> Option<Arc<dyn HelperSink>> {
        self.sink.read().as_ref().and_then(Weak::upgrade)
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    pub fn settings(&self) -> Value {
        read_notify(&self.root)
    }

    /// The helper setting is on and a runner is plugged in.
    pub fn plugged(&self, settings: &Value) -> bool {
        helper_on(settings) && self.sink().is_some()
    }

    /// Waits go to the helper now (on, plugged in, healthy).
    pub fn active(&self, settings: &Value) -> bool {
        self.plugged(settings) && self.sink().is_some_and(|s| s.healthy())
    }

    fn emit(&self, rec: &Rec, reason: Reason) {
        if let Some(s) = self.sink() {
            s.on_wait(rec, reason);
        }
    }

    pub fn link(&self, slug: &str, id: Option<&str>) -> String {
        let enc = crate::tickets::files::encode_uri_component;
        format!("{}/#/{}{}", self.board.base_url(), enc(slug), id.filter(|i| !i.is_empty()).map(|i| format!("/{}", enc(i))).unwrap_or_default())
    }

    pub fn message_link(&self, id: &str) -> String {
        format!("{}/#/~messages/{}", self.board.base_url(), crate::tickets::files::encode_uri_component(id))
    }

    /// The message item for a record: its ticket title and board name as the board knows them now.
    pub fn item(&self, rec: &Rec) -> Value {
        let (board, id) = (rs(rec, "board"), rs(rec, "ticketId"));
        let title = self.board.ticket(board, id).map(|t| t.title.clone()).unwrap_or_else(|| id.to_string());
        json!({ "key": rs(rec, "key"), "board": board, "boardName": self.board.board_name(board), "ticketId": id, "title": title, "question": rs(rec, "question") })
    }

    /// A ticket waits (or a new question on a waiting ticket): open a record and hand it to the runner, or send it.
    pub async fn route(self: &Arc<Self>, w: NewWait) -> Rec {
        let settings = self.settings();
        let key = waits::record_key(&w.board, &w.ticket_id, &w.identity);
        let (rec, existed, was_urgent) = {
            let mut st = self.lock();
            let before = st.waits.get(&key).cloned();
            let existed = before.as_ref().is_some_and(is_open);
            let was_urgent = existed && before.as_ref().is_some_and(|b| rb(b, "urgent"));
            (st.waits.add(&w, false, None), existed, was_urgent)
        };
        if self.active(&settings) {
            if !existed {
                self.emit(&rec, if w.kind == "message" { Reason::Message } else { Reason::New });
            } else if rb(&rec, "urgent") && !was_urgent {
                self.emit(&rec, Reason::Urgent);
            }
            return rec;
        }
        if ro(&rec, "toldAt").is_some() {
            return rec;
        }
        if self.plugged(&settings) && self.hold_for_morning(vec![rec.clone()]).is_empty() {
            return rec;
        }
        if rs(&rec, "kind") == "limit" {
            self.direct_limit(&rec).await;
        } else {
            self.send_direct(&[rs(&rec, "key").to_string()], "direct").await;
        }
        rec
    }

    /// Start-up for one ticket: what waits now, given how the waits file was found.
    pub fn reconcile(&self, board: &str, ticket: &str, w: Option<&NewWait>, identity: Option<&str>, steps: &[NewWait], from_step: bool) {
        let plugged = self.plugged(&self.settings());
        if let Some(w) = w
            && from_step
            && w.identity != "questions"
        {
            let from_key = format!("{board}/{ticket}|questions");
            let moved = {
                let mut st = self.lock();
                let from = st.waits.get(&from_key).cloned();
                st.waits.rekey(&from_key, w).map(|m| (m, from))
            };
            if let Some((moved, from)) = moved
                && plugged
                && rb(&moved, "urgent")
                && !from.as_ref().is_some_and(|f| rb(f, "urgent"))
                && ro(&moved, "toldAt").is_none()
            {
                self.emit(&moved, Reason::Urgent);
            }
        }
        let keep: HashSet<String> = identity.into_iter().chain(steps.iter().map(|s| s.identity.as_str())).filter(|i| !i.is_empty()).map(|i| format!("{board}/{ticket}|{i}")).collect();
        {
            let mut st = self.lock();
            for r in st.waits.open_for(board, Some(ticket)) {
                if rs(&r, "kind") == "message" {
                    continue;
                }
                let k = rs(&r, "key").to_string();
                if !keep.contains(&k) {
                    st.waits.close(&[k], if rs(&r, "kind") == "questions" { "answered" } else { "cleared" });
                }
            }
        }
        let mut seen: HashSet<String> = HashSet::new();
        for x in w.into_iter().chain(steps.iter()) {
            if !seen.insert(x.identity.clone()) {
                continue;
            }
            self.open_at_start(x, plugged);
        }
    }

    fn open_at_start(&self, w: &NewWait, plugged: bool) {
        let rec = {
            let mut st = self.lock();
            if waits::closed_null(st.waits.get(&waits::record_key(&w.board, &w.ticket_id, &w.identity))) {
                return;
            }
            if st.waits.start == WaitsStart::Missing {
                let rec = st.waits.add(w, plugged, if plugged { None } else { Some("seed") });
                if plugged {
                    if !st.waits.first_summary_pending() {
                        st.waits.set_first_summary_pending(true);
                    }
                    Some((rec, Reason::Seeded))
                } else {
                    None
                }
            } else {
                let rec = st.waits.add(w, false, if plugged { None } else { Some("restart") });
                plugged.then_some((rec, Reason::Restart))
            }
        };
        if let Some((rec, reason)) = rec {
            self.emit(&rec, reason);
        }
    }

    /// Start-up is done: the waits file exists from now on.
    pub fn started(&self) {
        self.lock().waits.save();
    }

    /// The ticket no longer waits on these.
    pub fn settled(&self, board: &str, ticket: &str, identity: Option<&str>, steps: &[String]) {
        let keep: HashSet<String> = identity.into_iter().chain(steps.iter().map(String::as_str)).filter(|i| !i.is_empty()).map(|i| format!("{board}/{ticket}|{i}")).collect();
        let mut st = self.lock();
        for r in st.waits.open_for(board, Some(ticket)) {
            let k = rs(&r, "key").to_string();
            if keep.contains(&k) || (rs(&r, "kind") == "message" && identity.is_some()) {
                continue;
            }
            st.waits.close(&[k], if rs(&r, "kind") == "questions" { "answered" } else { "cleared" });
        }
    }

    pub fn step_settled(&self, board: &str, ticket: &str, identity: &str, current: Option<&str>) {
        if Some(identity) == current {
            return;
        }
        self.lock().waits.close(&[format!("{board}/{ticket}|{identity}")], "answered");
    }

    /// The ticket (or, without one, the board) was deleted.
    pub fn deleted(&self, board: &str, ticket: Option<&str>) {
        let mut st = self.lock();
        let keys: Vec<String> = st.waits.open_for(board, ticket).iter().map(|r| rs(r, "key").to_string()).collect();
        st.waits.close(&keys, "deleted");
    }

    /// The user opened the ticket; returns whether a reminder was pending (markSeen then records the open at once).
    pub fn opened(&self, board: &str, ticket: &str) -> bool {
        let mut st = self.lock();
        let pending = st.waits.has_pending_reminder(board, ticket);
        st.waits.opened(board, ticket);
        pending
    }

    /// Where each ticket of a message stands now, keyed by itemStateKey.
    pub fn item_states(&self, m: &Msg) -> Map<String, Value> {
        let mut out = Map::new();
        let mut rows: Vec<&Value> = messages::items(m).iter().collect();
        if let Some(s) = m.get("summary").filter(|s| s.is_object()) {
            for k in ["new", "still", "checkins"] {
                rows.extend(s.get(k).and_then(Value::as_array).map(|a| a.iter().collect::<Vec<_>>()).unwrap_or_default());
            }
        }
        let st = self.lock();
        for i in rows {
            let k = super::text::item_state_key(i);
            if out.contains_key(&k) {
                continue;
            }
            let rec = i.get("key").and_then(Value::as_str).filter(|k| !k.is_empty()).and_then(|key| st.waits.for_message(key, rs(m, "id"), rs(m, "at")));
            let why = rec.as_ref().and_then(|r| ro(r, "closedWhy"));
            let gone = self.board.ticket(super::text::s(i, "board"), super::text::s(i, "ticketId")).is_none();
            let v = if gone || why == Some("deleted") {
                json!({ "state": "removed", "at": if why == Some("deleted") { rec.as_ref().and_then(|r| r.get("closedAt").cloned()).unwrap_or(Value::Null) } else { Value::Null } })
            } else if let Some(r) = rec.as_ref().filter(|r| ro(r, "closedAt").is_some()) {
                let how = match why {
                    Some("opened") => "seen",
                    Some("answered") => "answered",
                    _ => "done",
                };
                json!({ "state": "answered", "at": r.get("closedAt").cloned().unwrap_or(Value::Null), "how": how })
            } else {
                json!({ "state": "open" })
            };
            out.insert(k, v);
        }
        out
    }

    /// The Messages screen's "Needs you" ids over the newest-first list.
    pub fn needs_you(&self, newest: &[Msg]) -> HashSet<String> {
        let st = self.lock();
        let mut by_base: HashMap<String, Vec<&Rec>> = HashMap::new();
        for r in st.waits.all() {
            let base = rs(r, "key").split('#').next().unwrap_or("").to_string();
            by_base.entry(base).or_default().push(r);
        }
        let board = self.board.clone();
        messages::needs_you_ids(newest, &mut |key, m| {
            let base = key.split('#').next().unwrap_or("");
            let list = by_base.get(base)?;
            let rec = waits::record_for_message(list.iter().copied(), key, rs(m, "id"), rs(m, "at"))?;
            if !is_open(rec) || board.ticket(rs(rec, "board"), rs(rec, "ticketId")).is_none() {
                return None;
            }
            Some(rs(rec, "key").to_string())
        })
    }

    /// A message with its tickets' states.
    pub fn with_states(&self, m: &Msg) -> Value {
        let mut v = m.clone();
        v.insert("itemState".into(), Value::Object(self.item_states(m)));
        Value::Object(v)
    }

    pub fn add_message(&self, m: NewMessage) -> Msg {
        self.lock().messages.add(m)
    }

    pub fn message(&self, id: &str) -> Option<Msg> {
        self.lock().messages.get(id)
    }

    /// Stores the message and sends it.
    pub async fn send(&self, m: NewMessage, out: OutBody, only: Option<&[String]>) -> (Msg, Vec<Value>) {
        let message = self.add_message(m);
        let results = self.deliver(&message, &out, only, None).await;
        (message, results)
    }

    /// Sends a stored message. only: these channels at once; chain: one at a time until one reaches the user.
    pub async fn deliver(&self, message: &Msg, out: &OutBody, only: Option<&[String]>, chain: Option<&[String]>) -> Vec<Value> {
        let mut full = out.fields.clone();
        let id = rs(message, "id").to_string();
        full.insert("url".into(), out.url.clone().unwrap_or_else(|| self.message_link(&id)).into());
        full.insert("messageId".into(), id.clone().into());
        full.insert("ticket".into(), tap_ticket(message));
        let settings = self.settings();
        let record = |results: &[Value]| {
            let at = iso(self.now());
            let sends: Vec<Value> = results
                .iter()
                .filter(|r| !crate::runs::js::truthy(r.get("skipped")))
                .map(|r| {
                    let mut s = Map::new();
                    s.insert("channel".into(), r.get("channel").cloned().unwrap_or(Value::Null));
                    s.insert("at".into(), at.clone().into());
                    s.insert("ok".into(), r.get("ok").cloned().unwrap_or(Value::Bool(false)));
                    if let Some(d) = r.get("devices").filter(|d| !d.is_null()) {
                        s.insert("devices".into(), d.clone());
                    }
                    s.insert("error".into(), r.get("error").cloned().unwrap_or(Value::Null));
                    Value::Object(s)
                })
                .collect();
            self.lock().messages.record_sends(&id, sends);
        };
        let Some(chain) = chain else {
            let results = send_all(&self.sender, &full, &settings, only).await;
            record(&results);
            return results;
        };
        let mut all = Vec::new();
        for name in chain {
            let results = send_all(&self.sender, &full, &settings, Some(std::slice::from_ref(name))).await;
            record(&results);
            let ok = results.iter().any(|r| r.get("ok") == Some(&Value::Bool(true)));
            all.extend(results);
            if ok {
                break;
            }
        }
        all
    }

    /// The ticket counts as urgent at night.
    pub fn urgent_for_night(&self, st: &mut Stores, rec: &Rec) -> bool {
        if rb(rec, "urgent") {
            return true;
        }
        let since = self.now() - URGENT_RECENT_MS;
        st.messages.list_newest(false).iter().any(|m| {
            matches!(rs(m, "level"), "urgent" | "reminder")
                && parse_date(rs(m, "at")).is_some_and(|a| a >= since)
                && messages::items(m).iter().any(|i| super::text::s(i, "board") == rs(rec, "board") && super::text::s(i, "ticketId") == rs(rec, "ticketId"))
        })
    }

    /// Night: only urgent records go out now (returned), the rest wait for the morning.
    pub fn hold_for_morning(&self, recs: Vec<Rec>) -> Vec<Rec> {
        let sink = self.sink();
        let Some(morning) = sink.as_ref().and_then(|s| s.morning(self.now())) else { return recs };
        let allowed = sink.as_ref().is_some_and(|s| s.night_allowed());
        let at = iso(morning);
        let now_iso = iso(self.now());
        let mut now_list = Vec::new();
        let mut held = 0;
        let mut st = self.lock();
        for r in recs {
            let urgent = self.urgent_for_night(&mut st, &r);
            if urgent && allowed {
                now_list.push(r);
            } else {
                let mut patch = vec![("fallbackAt", Value::Null), ("digestAt", Value::String(at.clone()))];
                if urgent && ro(&r, "nightHeldAt").is_none() {
                    patch.push(("nightHeldAt", now_iso.clone().into()));
                }
                st.waits.update(rs(&r, "key"), patch);
                held += 1;
            }
        }
        if held > 0 {
            eprintln!("helper: night: holding {held} wait{} for the morning ({} at the latest)", if held == 1 { "" } else { "s" }, clock_time(&at));
        }
        now_list
    }

    /// "Held overnight: Billing, marked urgent 22:35" for records held overnight while urgent, or None.
    pub fn held_overnight_line(&self, recs: &[Rec]) -> Option<String> {
        let held: Vec<&Rec> = recs.iter().filter(|r| ro(r, "nightHeldAt").is_some() && ro(r, "toldAt").is_none()).collect();
        if held.is_empty() {
            return None;
        }
        let parts: Vec<String> = held.iter().map(|r| format!("{}, marked urgent {}", super::text::s(&self.item(r), "title"), clock_time(rs(r, "nightHeldAt")))).collect();
        Some(format!("Held overnight: {}", parts.join("; ")))
    }

    pub fn mark_told(&self, keys: &[String], via: &str, message_id: Option<&str>) {
        self.lock().waits.mark_told(keys, via, message_id);
    }

    /// Sends these open, untold records directly, one message per ticket, and marks them told.
    pub async fn send_direct(&self, keys: &[String], level: &str) {
        for key in keys {
            let Some(rec) = self.lock().waits.get(key).cloned() else { continue };
            if !is_open(&rec) || ro(&rec, "toldAt").is_some() {
                continue;
            }
            let it = self.item(&rec);
            let label = direct_label(rs(&rec, "kind"), rs(&rec, "question"), rs(&rec, "label"));
            let (board, ticket) = (rs(&rec, "board"), rs(&rec, "ticketId"));
            let (title, board_name) = (super::text::s(&it, "title").to_string(), super::text::s(&it, "boardName").to_string());
            let url = self.link(board, Some(ticket));
            let notify = json!({ "board": board, "boardName": board_name, "ticketId": ticket, "title": title, "kind": rs(&rec, "kind"), "label": label, "url": url });
            self.lock().waits.mark_told(std::slice::from_ref(key), "direct", None);
            let q = if rs(&rec, "question").is_empty() { rs(&rec, "label") } else { rs(&rec, "question") };
            let mut parts = vec![format!("{title} ({board_name})"), q.to_string()];
            if let Some(why) = ro(&rec, "why") {
                parts.push(format!("Why: {why}"));
            }
            let text = parts.join("\n\n");
            let urgent = rb(&rec, "urgent");
            let lvl = if urgent { "urgent" } else { level };
            let mut m = NewMessage::new(lvl, cut1(&format!("{label}: {title}")), text.clone());
            m.why = ro(&rec, "why").map(str::to_string);
            m.items = vec![it];
            let out = OutBody::new(lvl, &title, &label, &text, Some(url)).with("notify", notify).with("urgent", urgent).with("everyDevice", urgent);
            let (message, _) = self.send(m, out, None).await;
            self.lock().waits.update(key, vec![("messageId", message.get("id").cloned().unwrap_or(Value::Null))]);
        }
    }

    async fn direct_limit(&self, rec: &Rec) {
        let now = self.now();
        let key = rs(rec, "key").to_string();
        {
            let mut st = self.lock();
            if let Some(w) = st.limit_window.as_mut()
                && now - w.0 < LIMIT_BATCH_MS
            {
                w.2.push(key.clone());
                st.waits.mark_told(std::slice::from_ref(&key), "direct", None);
                return;
            }
            st.limit_window = Some((now, vec![key.clone()], Vec::new()));
        }
        self.send_direct(&[key], "direct").await;
    }

    async fn flush_limits(&self) {
        let w = {
            let mut st = self.lock();
            match &st.limit_window {
                Some(w) if self.now() - w.0 >= LIMIT_BATCH_MS => st.limit_window.take(),
                _ => None,
            }
        };
        let Some((_, sent, batch)) = w else { return };
        if batch.is_empty() {
            return;
        }
        let recs: Vec<Rec> = {
            let st = self.lock();
            sent.iter().chain(batch.iter()).filter_map(|k| st.waits.get(k).cloned()).collect()
        };
        let mut resets: Vec<String> = recs
            .iter()
            .filter_map(|r| self.board.ticket(rs(r, "board"), rs(r, "ticketId")))
            .filter_map(|t| t.get("limit").and_then(|l| l.get("resetAt")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string))
            .collect();
        resets.sort_by(|a, b| crate::runs::js::cmp16(a, b));
        let line = usage_limit_line(recs.len(), resets.last().map(String::as_str));
        let items: Vec<Value> = recs.iter().map(|r| self.item(r)).collect();
        let text = std::iter::once(line.clone()).chain(items.iter().map(|i| format!("- {} ({})", super::text::s(i, "title"), super::text::s(i, "boardName")))).collect::<Vec<_>>().join("\n");
        let first_board = recs.first().map(|r| rs(r, "board").to_string()).unwrap_or_default();
        let url = self.link(&first_board, None);
        let names = cut1(&items.iter().map(|i| super::text::s(i, "title")).collect::<Vec<_>>().join(", "));
        let board_name = items.first().map(|i| super::text::s(i, "boardName").to_string()).unwrap_or_else(|| "ckanban".into());
        let notify = json!({ "board": first_board, "boardName": board_name, "ticketId": "", "title": line, "kind": "message", "label": names, "url": url });
        let mut m = NewMessage::new("direct", line.clone(), text.clone());
        m.items = items;
        let out = OutBody::new("direct", &line, &names, &text, Some(url)).with("tag", "usage-limit").with("notify", notify);
        let (message, _) = self.send(m, out, None).await;
        let mut st = self.lock();
        for k in &batch {
            st.waits.update(k, vec![("messageId", message.get("id").cloned().unwrap_or(Value::Null))]);
        }
    }

    /// Once a second: the merged usage-limit line, the 5-minute fallback and the 4-hour fallback digest.
    pub async fn tick(&self) {
        self.flush_limits().await;
        let now = self.now();
        let last = self.sink().and_then(|s| s.last_success_at());
        let open: Vec<Rec> = self.lock().waits.open().into_iter().filter(|r| ro(r, "toldAt").is_none()).collect();
        let due: Vec<Rec> = open
            .into_iter()
            .filter(|r| ro(r, "fallbackAt").is_some() && waits::rms(r, "fallbackAt") <= now && last.is_none_or(|l| l < waits::rms(r, "queuedAt")))
            .collect();
        let fallback = if due.is_empty() { due } else { self.hold_for_morning(due) };
        if !fallback.is_empty() {
            eprintln!("helper: no helper run in 5 minutes, sending {} directly", fallback.len());
            let keys: Vec<String> = fallback.iter().map(|r| rs(r, "key").to_string()).collect();
            self.send_direct(&keys, "fallback").await;
        }
        let due: Vec<Rec> = self
            .lock()
            .waits
            .open()
            .into_iter()
            .filter(|r| ro(r, "toldAt").is_none() && ro(r, "seenInChatAt").is_none() && ro(r, "digestAt").is_some() && waits::rms(r, "digestAt") <= now)
            .collect();
        let digest = if due.is_empty() { due } else { self.hold_for_morning(due) };
        if !digest.is_empty() {
            eprintln!("helper: helper missed {} waits for 4 hours, sending a digest", digest.len());
            self.digest(digest, "fallback", "The helper didn't tell you about these in time, so the board sends them itself.").await;
        }
    }

    /// One direct message naming several records; marks them told.
    pub async fn digest(&self, recs: Vec<Rec>, level: &str, why: &str) -> Option<Msg> {
        let fresh: Vec<Rec> = {
            let st = self.lock();
            recs.iter().filter_map(|r| st.waits.get(rs(r, "key")).cloned().or_else(|| Some(r.clone()))).filter(|r| is_open(r) && ro(r, "toldAt").is_none()).collect()
        };
        if fresh.is_empty() {
            return None;
        }
        let overnight = self.held_overnight_line(&fresh);
        let keys: Vec<String> = fresh.iter().map(|r| rs(r, "key").to_string()).collect();
        self.mark_told(&keys, "digest", None);
        let items: Vec<Value> = fresh.iter().map(|r| self.item(r)).collect();
        let first = &fresh[0];
        let dl = |r: &Rec| direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label"));
        let one = fresh.len() == 1;
        let title0 = super::text::s(&items[0], "title").to_string();
        let one_line = if one { cut1(&format!("{}: {title0}", dl(first))) } else { format!("{} tickets wait on you", fresh.len()) };
        let mut lines: Vec<String> = overnight.iter().cloned().collect();
        lines.push(one_line.clone());
        lines.extend(items.iter().zip(&fresh).map(|(it, r)| format!("- {} ({}): {}", super::text::s(it, "title"), super::text::s(it, "boardName"), dl(r))));
        let text = lines.join("\n");
        let url = if one { self.link(rs(first, "board"), Some(rs(first, "ticketId"))) } else { self.link(rs(first, "board"), None) };
        let ntitle = if one { title0.clone() } else { "ckanban".into() };
        let nlabel = if one { dl(first) } else { one_line.clone() };
        let notify = json!({ "board": rs(first, "board"), "boardName": super::text::s(&items[0], "boardName"), "ticketId": if one { rs(first, "ticketId") } else { "" }, "title": ntitle, "kind": "message", "label": nlabel, "url": url });
        let urgent = fresh.iter().any(|r| rb(r, "urgent"));
        let mut m = NewMessage::new(level, one_line.clone(), text.clone());
        m.why = Some(why.to_string());
        m.items = items;
        if let Some(o) = &overnight {
            m.held_overnight = Some(o.clone());
            m.night_ask = !self.sink().is_some_and(|s| s.night_allowed());
        }
        let out = OutBody::new(level, &ntitle, &nlabel, &text, Some(url)).with("tag", "ckanban-digest").with("notify", notify).with("urgent", urgent);
        let (message, _) = self.send(m, out, None).await;
        let mut st = self.lock();
        for k in &keys {
            st.waits.update(k, vec![("messageId", message.get("id").cloned().unwrap_or(Value::Null))]);
        }
        Some(message)
    }

    /// The helper setting changed. Off: pending reminders stop and what it held goes out as one digest. On: what is
    /// already open counts as told.
    pub async fn switched(&self, on: bool) {
        let open = self.lock().waits.open();
        if on {
            let keys: Vec<String> = open.iter().filter(|r| ro(r, "toldAt").is_none()).map(|r| rs(r, "key").to_string()).collect();
            self.mark_told(&keys, "direct", None);
            return;
        }
        {
            let mut st = self.lock();
            for r in &open {
                if pending(r) {
                    st.waits.stop_reminders(rs(r, "key"), "off");
                }
            }
        }
        let held: Vec<Rec> = open.into_iter().filter(|r| ro(r, "toldAt").is_none()).collect();
        if !held.is_empty() {
            self.digest(held, "digest", "The helper was turned off; these were waiting for its next message.").await;
        }
    }

    /// What waits on the user now, one line per ticket (Telegram's /waiting).
    pub fn waiting_text(&self) -> String {
        let open = self.lock().waits.open();
        if open.is_empty() {
            return "Nothing waits on you right now.".into();
        }
        let lines: Vec<String> = open
            .iter()
            .map(|r| {
                let it = self.item(r);
                format!("- {} ({}): {}{}", super::text::s(&it, "title"), super::text::s(&it, "boardName"), direct_label(rs(r, "kind"), rs(r, "question"), rs(r, "label")), if rb(r, "urgent") { " [urgent]" } else { "" })
            })
            .collect();
        let head = if open.len() == 1 { "1 ticket waits".to_string() } else { format!("{} tickets wait", open.len()) };
        std::iter::once(format!("{head} on you:")).chain(lines).collect::<Vec<_>>().join("\n")
    }
}
