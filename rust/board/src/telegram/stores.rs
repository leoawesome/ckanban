//! The small files the Telegram bot keeps beside notify.json (`src/helper/tgstores.ts`), byte for byte like Bun:
//! - `Links` (`telegram-links.json`): which Telegram message the board sent for which stored helper message, board,
//!   ticket and wait, so a reply finds its ticket.
//! - `Pending` (`telegram-pending.json`): what a button tap does, under a short id; a tap works once and expires.
//! - `UpdateQueue` (`telegram-updates.json`): updates saved before the read position moves on, so a restart neither
//!   drops one nor handles it twice.
//!
//! Each file is written as `JSON.stringify(v) + "\n"` to `<file>.tmp` (owner-only) and renamed; a missing or
//! unreadable file starts empty. Each store keeps its file in memory after the first read, as Bun does.

use std::io::Write;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use crate::runs::js;
use ckanban_core::time::{iso, parse_date};

/// `readJson`: None when missing; None (with a warning) when unreadable.
fn read_json(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    match js::parse(&text) {
        Some(v) => Some(v),
        None => {
            eprintln!("telegram: {} could not be read (not JSON); starting a new one", file.display());
            None
        }
    }
}

/// `writeJson`: `<file>.tmp` (0600 when made) then rename.
pub fn write_json(file: &Path, v: &Value) -> std::io::Result<()> {
    let tmp = PathBuf::from(format!("{}.tmp", file.display()));
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp)?;
        f.write_all(format!("{}\n", js::stringify(v)).as_bytes())?;
    }
    std::fs::rename(&tmp, file)
}

fn safe_int(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

fn ms(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_str).and_then(parse_date).unwrap_or(f64::NAN)
}

/// One ticket a sent Telegram message is about; `key` is its wait record (null: none).
#[derive(Clone, Debug, PartialEq)]
pub struct LinkItem {
    pub board: String,
    pub ticket_id: String,
    pub key: Option<String>,
}

impl LinkItem {
    pub fn new(board: &str, ticket_id: &str, key: Option<&str>) -> Self {
        LinkItem { board: board.into(), ticket_id: ticket_id.into(), key: key.map(str::to_string) }
    }
    pub fn to_json(&self) -> Value {
        json!({ "board": self.board, "ticketId": self.ticket_id, "key": self.key })
    }
    pub fn of(v: &Value) -> LinkItem {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        LinkItem { board: s("board"), ticket_id: s("ticketId"), key: v.get("key").and_then(Value::as_str).map(str::to_string) }
    }
}

/// A message the board sent to Telegram (the JSON record as saved).
pub type Link = Map<String, Value>;

pub fn link_items(l: &Link) -> Vec<LinkItem> {
    l.get("items").and_then(Value::as_array).map(|a| a.iter().map(LinkItem::of).collect()).unwrap_or_default()
}

pub fn link_tg(l: &Link) -> i64 {
    safe_int(l.get("tg")).unwrap_or(0)
}

pub fn link_chat(l: &Link) -> Option<i64> {
    safe_int(l.get("chatId"))
}

pub const LINKS_KEEP_MS: f64 = 30.0 * 24.0 * 3600_000.0;
pub const LINKS_MAX: usize = 2000;

/// `TelegramLinks`: Telegram message → what it was about.
pub struct Links {
    pub file: PathBuf,
    list: Mutex<Option<Vec<Link>>>,
}

impl Links {
    pub fn new(root: &Path) -> Self {
        Links { file: root.join("telegram-links.json"), list: Mutex::new(None) }
    }

    fn items<'a>(&self, slot: &'a mut Option<Vec<Link>>) -> &'a mut Vec<Link> {
        slot.get_or_insert_with(|| {
            let v = read_json(&self.file);
            v.as_ref()
                .and_then(|v| v.get("links"))
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_object)
                        .filter(|l| safe_int(l.get("tg")).is_some() && l.get("items").is_some_and(Value::is_array))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        })
    }

    fn save(&self, list: &[Link]) {
        let v = json!({ "version": 1, "links": list });
        if let Err(e) = write_json(&self.file, &v) {
            eprintln!("telegram: couldn't save the message map: {e}");
        }
    }

    /// `add`: `{bot, tg, chatId, messageId, level, items}` plus `at`; older than 30 days dropped, 2000 kept.
    pub fn add(&self, bot: &str, tg: i64, chat_id: i64, message_id: Option<&str>, level: &str, items: &[LinkItem], now: f64) -> Link {
        let mut link = Map::new();
        link.insert("bot".into(), bot.into());
        link.insert("tg".into(), tg.into());
        link.insert("chatId".into(), chat_id.into());
        link.insert("messageId".into(), message_id.map(Value::from).unwrap_or(Value::Null));
        link.insert("level".into(), level.into());
        link.insert("items".into(), Value::Array(items.iter().map(LinkItem::to_json).collect()));
        link.insert("at".into(), iso(now).into());
        let cut = now - LINKS_KEEP_MS;
        let mut g = self.list.lock();
        let list = self.items(&mut g);
        // `Date.parse(x.at) >= cut` (NaN never is).
        list.retain(|x| ms(x.get("at")) >= cut);
        list.push(link.clone());
        let over = list.len().saturating_sub(LINKS_MAX);
        list.drain(..over);
        let snapshot = list.clone();
        drop(g);
        self.save(&snapshot);
        link
    }

    /// This bot's message with this id in this chat (the newest), or None.
    pub fn get(&self, chat_id: i64, tg: i64, bot: &str) -> Option<Link> {
        let mut g = self.list.lock();
        self.items(&mut g)
            .iter()
            .rev()
            .find(|l| l.get("bot").and_then(Value::as_str) == Some(bot) && link_chat(l) == Some(chat_id) && link_tg(l) == tg)
            .cloned()
    }

    /// Sent alerts (a stored helper message) about this wait that weren't edited to "closed" yet.
    pub fn open_for(&self, key: &str) -> Vec<Link> {
        let mut g = self.list.lock();
        self.items(&mut g)
            .iter()
            .filter(|l| js::truthy(l.get("messageId")) && !js::truthy(l.get("closedAt")) && link_items(l).iter().any(|i| i.key.as_deref() == Some(key)))
            .cloned()
            .collect()
    }

    /// `markClosed`.
    pub fn mark_closed(&self, l: &Link, now: f64) {
        let mut g = self.list.lock();
        let list = self.items(&mut g);
        let Some(x) = list.iter_mut().find(|y| y.get("bot") == l.get("bot") && link_chat(y) == link_chat(l) && link_tg(y) == link_tg(l)) else { return };
        x.insert("closedAt".into(), iso(now).into());
        let snapshot = list.clone();
        drop(g);
        self.save(&snapshot);
    }
}

/// A button's action (`PendingAction`, with `used`, `usedBy`, `card` once set), as saved.
pub type Action = Map<String, Value>;

pub fn action_data(a: &Action) -> &Value {
    a.get("data").unwrap_or(&Value::Null)
}

pub fn action_kind(a: &Action) -> &str {
    a.get("kind").and_then(Value::as_str).unwrap_or("")
}

pub fn action_id(a: &Action) -> &str {
    a.get("id").and_then(Value::as_str).unwrap_or("")
}

pub fn action_card(a: &Action) -> Option<i64> {
    a.get("card").and_then(|c| safe_int(Some(c)))
}

pub fn action_used_by(a: &Action) -> Option<i64> {
    a.get("usedBy").and_then(|c| safe_int(Some(c)))
}

pub fn action_used(a: &Action) -> bool {
    js::truthy(a.get("used"))
}

/// About 10 minutes: a tap after that is refused.
pub const ACTION_TTL_MS: f64 = 10.0 * 60_000.0;

fn action_id_ok(k: &str) -> bool {
    k.len() == 10 && k.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// `TakeResult`.
pub enum Take {
    Action(Action, bool),
    Gone(&'static str),
}

/// `peek`'s state.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum State {
    Open,
    Used,
    Expired,
}

/// `PendingActions`: single-use, expiring, on disk.
pub struct Pending {
    pub file: PathBuf,
    map: Mutex<Option<Map<String, Value>>>,
}

impl Pending {
    pub fn new(root: &Path) -> Self {
        Pending { file: root.join("telegram-pending.json"), map: Mutex::new(None) }
    }

    fn items<'a>(&self, slot: &'a mut Option<Map<String, Value>>) -> &'a mut Map<String, Value> {
        slot.get_or_insert_with(|| {
            let mut out = Map::new();
            if let Some(Value::Object(actions)) = read_json(&self.file).and_then(|v| v.get("actions").cloned()) {
                for (k, a) in actions {
                    if action_id_ok(&k) && a.get("kind").is_some_and(Value::is_string) {
                        out.insert(k, a);
                    }
                }
            }
            out
        })
    }

    /// `save`: expired ones are kept a day (a late tap says "expired"), then dropped. Err when it can't be written.
    fn save(&self, map: &mut Map<String, Value>, now: f64) -> std::io::Result<()> {
        let cut = now - 24.0 * 3600_000.0;
        map.retain(|_, a| !(ms(a.get("expiresAt")) < cut));
        write_json(&self.file, &json!({ "version": 1, "actions": map }))
    }

    fn save_logged(&self, map: &mut Map<String, Value>, now: f64) {
        if let Err(e) = self.save(map, now) {
            eprintln!("telegram: couldn't save the pending buttons: {e}");
        }
    }

    /// `create`: a fresh short id. Err when the file can't be written (Bun throws).
    pub fn create(&self, kind: &str, data: Value, ttl_ms: f64, now: f64) -> Result<Action, String> {
        let mut g = self.map.lock();
        let map = self.items(&mut g);
        let id = loop {
            let mut b = [0u8; 10];
            getrandom::fill(&mut b).map_err(|e| e.to_string())?;
            let id: String = b.iter().map(|x| b"abcdefghijklmnopqrstuvwxyz0123456789"[(*x % 36) as usize] as char).collect();
            if !map.contains_key(&id) {
                break id;
            }
        };
        let mut a = Map::new();
        a.insert("id".into(), id.clone().into());
        a.insert("kind".into(), kind.into());
        a.insert("data".into(), data);
        a.insert("at".into(), iso(now).into());
        a.insert("expiresAt".into(), iso(now + ttl_ms).into());
        map.insert(id, Value::Object(a.clone()));
        self.save(map, now).map_err(|e| e.to_string())?;
        Ok(a)
    }

    /// `find`: an open, unused action matching.
    pub fn find(&self, now: f64, f: &dyn Fn(&Action) -> bool) -> Option<Action> {
        let mut g = self.map.lock();
        self.items(&mut g).values().filter_map(Value::as_object).find(|a| ms(a.get("expiresAt")) > now && !action_used(a) && f(a)).cloned()
    }

    /// `take`: uses the action up (saved first). A used one taken again by the same update is a replay.
    pub fn take(&self, id: &str, by: Option<i64>, now: f64) -> Take {
        let mut g = self.map.lock();
        let map = self.items(&mut g);
        let Some(Value::Object(a)) = map.get_mut(id) else { return Take::Gone("unknown") };
        if action_used(a) {
            return if by.is_some() && action_used_by(a) == by { Take::Action(a.clone(), true) } else { Take::Gone("unknown") };
        }
        if ms(a.get("expiresAt")) <= now {
            return Take::Gone("expired");
        }
        a.insert("used".into(), iso(now).into());
        if let Some(b) = by {
            a.insert("usedBy".into(), b.into());
        }
        let out = a.clone();
        // Bun throws when this save fails: the tap answers "That button no longer works.".
        if self.save(map, now).is_err() {
            return Take::Gone("unknown");
        }
        Take::Action(out, false)
    }

    /// `peek`: the action as it is, its state, without using it up.
    pub fn peek(&self, id: &str, now: f64) -> Option<(Action, State)> {
        let mut g = self.map.lock();
        let a = self.items(&mut g).get(id)?.as_object()?.clone();
        let st = if action_used(&a) {
            State::Used
        } else if ms(a.get("expiresAt")) <= now {
            State::Expired
        } else {
            State::Open
        };
        Some((a, st))
    }

    /// `all(kind)`: every action kept, in the file's order.
    pub fn all(&self, kind: Option<&str>) -> Vec<Action> {
        let mut g = self.map.lock();
        self.items(&mut g).values().filter_map(Value::as_object).filter(|a| kind.is_none_or(|k| action_kind(a) == k)).cloned().collect()
    }

    /// `update`: saves a changed action's data.
    pub fn update(&self, id: &str, data: Value, now: f64) {
        let mut g = self.map.lock();
        let map = self.items(&mut g);
        let Some(Value::Object(a)) = map.get_mut(id) else { return };
        a.insert("data".into(), data);
        self.save_logged(map, now);
    }

    /// `shown`: the Telegram message that shows the action's buttons.
    pub fn shown(&self, id: &str, card: i64, now: f64) {
        let mut g = self.map.lock();
        let map = self.items(&mut g);
        let Some(Value::Object(a)) = map.get_mut(id) else { return };
        a.insert("card".into(), card.into());
        self.save_logged(map, now);
    }

    /// `expireAll`: every open button stops working now; how many.
    pub fn expire_all(&self, now: f64) -> usize {
        let mut g = self.map.lock();
        let map = self.items(&mut g);
        let mut n = 0;
        for a in map.values_mut().filter_map(Value::as_object_mut) {
            if action_used(a) || ms(a.get("expiresAt")) <= now {
                continue;
            }
            a.insert("expiresAt".into(), iso(now - 1.0).into());
            n += 1;
        }
        if n > 0 {
            self.save_logged(map, now);
        }
        n
    }

    /// `remove`.
    pub fn remove(&self, id: &str, now: f64) {
        let mut g = self.map.lock();
        let map = self.items(&mut g);
        if map.shift_remove(id).is_none() {
            return;
        }
        self.save_logged(map, now);
    }
}

/// Update ids already handled are remembered this many.
pub const SEEN_MAX: usize = 1000;

struct QueueData {
    bot: String,
    items: Vec<Value>,
    seen: Vec<i64>,
}

/// `UpdateQueue`: updates waiting to be handled, saved before the read position moves on.
pub struct UpdateQueue {
    pub file: Option<PathBuf>,
    data: Mutex<Option<QueueData>>,
}

impl UpdateQueue {
    pub fn new(root: Option<&Path>) -> Self {
        UpdateQueue { file: root.map(|r| r.join("telegram-updates.json")), data: Mutex::new(None) }
    }

    fn load<'a>(&self, slot: &'a mut Option<QueueData>, bot: &str) -> &'a mut QueueData {
        if slot.as_ref().is_some_and(|d| d.bot == bot) {
            return slot.as_mut().expect("loaded");
        }
        // Read from disk only the first time; another bot's queue isn't this bot's.
        let v = if slot.is_some() { None } else { self.file.as_deref().and_then(read_json) };
        let fresh = match v {
            Some(v) if v.get("bot").and_then(Value::as_str) == Some(bot) && v.get("items").is_some_and(Value::is_array) && v.get("seen").is_some_and(Value::is_array) => QueueData {
                bot: bot.into(),
                items: v["items"].as_array().expect("array").iter().filter(|u| safe_int(u.get("update_id")).is_some()).cloned().collect(),
                seen: v["seen"].as_array().expect("array").iter().filter_map(|x| safe_int(Some(x))).collect(),
            },
            _ => QueueData { bot: bot.into(), items: Vec::new(), seen: Vec::new() },
        };
        *slot = Some(fresh);
        slot.as_mut().expect("loaded")
    }

    fn save(&self, d: &QueueData) -> std::io::Result<()> {
        let Some(f) = &self.file else { return Ok(()) };
        write_json(f, &json!({ "bot": d.bot, "items": d.items, "seen": d.seen }))
    }

    /// `add`: updates not seen or queued yet; saved before it returns (Err when it can't be).
    pub fn add(&self, bot: &str, updates: &[Value]) -> Result<Vec<Value>, String> {
        let mut g = self.data.lock();
        let d = self.load(&mut g, bot);
        let mut have: std::collections::HashSet<i64> = d.seen.iter().copied().chain(d.items.iter().filter_map(|u| safe_int(u.get("update_id")))).collect();
        let fresh: Vec<Value> = updates.iter().filter(|u| safe_int(u.get("update_id")).is_some_and(|id| have.insert(id))).cloned().collect();
        if !fresh.is_empty() {
            d.items.extend(fresh.iter().cloned());
            self.save(d).map_err(|e| e.to_string())?;
        }
        Ok(fresh)
    }

    /// `pending`: oldest first.
    pub fn pending(&self, bot: &str) -> Vec<Value> {
        let mut g = self.data.lock();
        self.load(&mut g, bot).items.clone()
    }

    /// `done`: off the queue, its id remembered.
    pub fn done(&self, bot: &str, update_id: i64) {
        let mut g = self.data.lock();
        let d = self.load(&mut g, bot);
        d.items.retain(|u| safe_int(u.get("update_id")) != Some(update_id));
        if !d.seen.contains(&update_id) {
            d.seen.push(update_id);
            let over = d.seen.len().saturating_sub(SEEN_MAX);
            d.seen.drain(..over);
        }
        if let Err(e) = self.save(d) {
            eprintln!("telegram: couldn't save the update queue: {e}");
        }
    }

    /// `clear`: drops every update still waiting (marked handled); how many.
    pub fn clear(&self, bot: &str) -> usize {
        let mut g = self.data.lock();
        let d = self.load(&mut g, bot);
        let n = d.items.len();
        if n == 0 {
            return 0;
        }
        let ids: Vec<i64> = d.items.iter().filter_map(|u| safe_int(u.get("update_id"))).filter(|id| !d.seen.contains(id)).collect();
        d.seen.extend(ids);
        let over = d.seen.len().saturating_sub(SEEN_MAX);
        d.seen.drain(..over);
        d.items.clear();
        if let Err(e) = self.save(d) {
            eprintln!("telegram: couldn't drop queued updates: {e}");
        }
        n
    }

    pub fn seen(&self, bot: &str, update_id: i64) -> bool {
        let mut g = self.data.lock();
        self.load(&mut g, bot).seen.contains(&update_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_bytes_and_lookups() {
        let d = tempfile::tempdir().unwrap();
        let l = Links::new(d.path());
        let now = 1_800_000_000_000.0;
        l.add("123", 7, 42, Some("m_a"), "urgent", &[LinkItem::new("b", "t1", Some("k1"))], now);
        let text = std::fs::read_to_string(d.path().join("telegram-links.json")).unwrap();
        assert_eq!(text, "{\"version\":1,\"links\":[{\"bot\":\"123\",\"tg\":7,\"chatId\":42,\"messageId\":\"m_a\",\"level\":\"urgent\",\"items\":[{\"board\":\"b\",\"ticketId\":\"t1\",\"key\":\"k1\"}],\"at\":\"2027-01-15T08:00:00.000Z\"}]}\n");
        assert!(l.get(42, 7, "123").is_some());
        assert!(l.get(42, 7, "999").is_none());
        assert_eq!(l.open_for("k1").len(), 1);
        l.mark_closed(&l.get(42, 7, "123").unwrap(), now);
        assert!(l.open_for("k1").is_empty());
        // Read again from the file.
        let l2 = Links::new(d.path());
        assert!(l2.get(42, 7, "123").unwrap().contains_key("closedAt"));
    }

    #[test]
    fn pending_take_once_replay_expire() {
        let d = tempfile::tempdir().unwrap();
        let p = Pending::new(d.path());
        let now = 1_800_000_000_000.0;
        let a = p.create("send", json!({ "x": 1 }), ACTION_TTL_MS, now).unwrap();
        let id = action_id(&a).to_string();
        assert!(action_id_ok(&id));
        p.shown(&id, 9, now);
        assert!(matches!(p.take(&id, Some(5), now), Take::Action(_, false)));
        assert!(matches!(p.take(&id, Some(5), now), Take::Action(_, true)));
        assert!(matches!(p.take(&id, Some(6), now), Take::Gone("unknown")));
        let b = p.create("send", json!({}), ACTION_TTL_MS, now).unwrap();
        assert_eq!(p.expire_all(now), 1);
        assert!(matches!(p.take(action_id(&b), None, now), Take::Gone("expired")));
        let text = std::fs::read_to_string(d.path().join("telegram-pending.json")).unwrap();
        assert!(text.contains(&format!("\"{id}\":{{\"id\":\"{id}\",\"kind\":\"send\",\"data\":{{\"x\":1}},\"at\":")));
        assert!(text.contains("\"card\":9,\"used\":"));
    }

    #[test]
    fn queue_adds_once_and_remembers() {
        let d = tempfile::tempdir().unwrap();
        let q = UpdateQueue::new(Some(d.path()));
        let fresh = q.add("1", &[json!({ "update_id": 3 }), json!({ "update_id": 3 }), json!({ "nope": 1 })]).unwrap();
        assert_eq!(fresh.len(), 1);
        q.done("1", 3);
        assert!(q.add("1", &[json!({ "update_id": 3 })]).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(d.path().join("telegram-updates.json")).unwrap(), "{\"bot\":\"1\",\"items\":[],\"seen\":[3]}\n");
        // Another bot starts empty.
        assert!(q.pending("2").is_empty());
        assert!(!q.seen("2", 3));
    }
}
