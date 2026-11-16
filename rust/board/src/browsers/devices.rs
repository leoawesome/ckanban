//! Shared devices (port of `src/browser/devices.ts`): things only a few tickets may use at once, on every board (a
//! WhatsApp Web tab, a phone, an emulator). A run's Claude takes one just before it uses it and lets go when done
//! (take_devices / release_devices); the board frees whatever a ticket still holds when its run ends.
//!
//! Takes are all-or-nothing and first come, first served: a waiting request keeps later requests off its devices. A
//! ticket that holds a device can't ask for more until it lets go, so two tickets never each hold one device and wait
//! for the other. Holds and the queue live in memory (a restart ends every run anyway); the list is `devices.json`,
//! written like Bun (`formats::DEVICES`).
//!
//! The state sits behind one lock that is never held across an await; `devices.json` (a few hundred bytes) is written
//! under it, so the file order is the state order. Who changed is told after the lock is let go.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ckanban_core::datafile::{formats, read_json, write_json};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;
use tokio::sync::Notify;

use super::js;
use crate::prompts::js::{slice16, trim};

/// How long one take_devices call waits before it answers "still waiting" (the ticket keeps its place).
pub const TAKE_WAIT_MS: f64 = 4.0 * 60_000.0;
/// A waiting request nobody asked about again for this long is dropped (its Claude moved on).
pub const STALE_WAIT_MS: f64 = 10.0 * 60_000.0;
const MAX_CAPACITY: f64 = 50.0;
const FILE: &str = "devices.json";

static NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9._-]{0,47}$").unwrap());

/// A refusal with its HTTP status and Bun's words (`DeviceError`).
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceError {
    pub status: u16,
    pub message: String,
}

fn err(status: u16, message: impl Into<String>) -> DeviceError {
    DeviceError { status, message: message.into() }
}

/// One device on the list, in `devices.json`'s key order.
#[derive(Debug, Clone, PartialEq)]
pub struct Device {
    pub name: String,
    pub description: String,
    pub capacity: u32,
    /// Claude asked for a name that wasn't on the list, so the board added it.
    pub added_by_claude: bool,
    /// Kept as read (Bun keeps any value here).
    pub last_used_at: Value,
}

impl Device {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("description".into(), json!(self.description));
        m.insert("capacity".into(), json!(self.capacity));
        if self.added_by_claude {
            m.insert("addedByClaude".into(), json!(true));
        }
        m.insert("lastUsedAt".into(), self.last_used_at.clone());
        m
    }
}

/// Who holds or waits: a ticket.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceUser {
    pub slug: String,
    pub id: String,
    pub since: String,
}

impl DeviceUser {
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("slug".into(), json!(self.slug));
        m.insert("id".into(), json!(self.id));
        m.insert("since".into(), json!(self.since));
        m
    }
}

/// A device with who uses it and who waits (`DeviceView`).
#[derive(Debug, Clone)]
pub struct DeviceView {
    pub device: Device,
    pub using: Vec<DeviceUser>,
    pub waiting: Vec<DeviceUser>,
}

/// A take's answer (`TakeResult`).
#[derive(Debug, Clone, PartialEq)]
pub enum TakeResult {
    Got { names: Vec<String> },
    Waiting { names: Vec<String>, place: usize, used_by: Vec<DeviceUser> },
}

/// Trimmed, lowercase, without repeats; refused on an empty list or a name that isn't a plain word (`deviceNames`).
pub fn device_names(raw: &Value) -> Result<Vec<String>, DeviceError> {
    let list: Vec<Value> = match raw {
        Value::Array(a) => a.clone(),
        Value::String(s) => s.split(',').map(|x| json!(x)).collect(),
        _ => Vec::new(),
    };
    let mut names: Vec<String> = Vec::new();
    for v in &list {
        let n = match v {
            Value::String(s) => trim(s).to_lowercase(),
            _ => String::new(),
        };
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    if names.is_empty() {
        return Err(err(400, "name at least one device, e.g. [\"chrome-whatsapp\"]"));
    }
    for n in &names {
        if !NAME_RE.is_match(n) {
            return Err(err(400, format!("\"{n}\" isn't a device name: use lowercase letters, digits and dashes, e.g. \"chrome-whatsapp\"")));
        }
    }
    Ok(names)
}

/// `clampCapacity`: a whole number from 1 to 50; anything else 1.
pub fn clamp_capacity(v: &Value) -> u32 {
    let n = js::number(v).floor();
    if n.is_finite() { n.clamp(1.0, MAX_CAPACITY) as u32 } else { 1 }
}

struct Hold {
    owner: String,
    name: String,
    at: String,
}

struct Wait {
    /// Tells apart two requests of one owner (the queue holds at most one each, but one may replace another).
    seq: u64,
    owner: String,
    names: Vec<String>,
    at: String,
    /// Last time its Claude asked (a call waiting now counts as asking).
    asked_at: f64,
    /// Calls waiting for this request right now.
    wakers: usize,
    wake: Arc<Notify>,
}

struct State {
    list: Vec<Device>,
    holds: Vec<Hold>,
    queue: Vec<Wait>,
    seq: u64,
}

/// Owners ("<board>/<ticket id>") whose state changed; empty: only the list changed. Told after the lock is let go.
pub type OnChange = Arc<dyn Fn(&[String]) + Send + Sync>;

pub struct Devices {
    file: PathBuf,
    state: Mutex<State>,
    on_change: OnChange,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

fn owner_key(slug: &str, id: &str) -> String {
    format!("{slug}/{id}")
}

fn user_of(owner: &str, since: &str) -> DeviceUser {
    let (slug, id) = owner.split_once('/').unwrap_or((owner, ""));
    DeviceUser { slug: slug.into(), id: id.into(), since: since.into() }
}

fn same_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|x| b.contains(x))
}

fn now_iso(ms: f64) -> String {
    ckanban_core::time::iso(ms)
}

impl Devices {
    pub fn new(root: &Path, on_change: OnChange) -> Self {
        Self::with_clock(root, on_change, Arc::new(ckanban_core::time::now_ms))
    }

    pub fn with_clock(root: &Path, on_change: OnChange, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        let file = root.join(FILE);
        let list = load(&file);
        Devices { file, state: Mutex::new(State { list, holds: Vec::new(), queue: Vec::new(), seq: 0 }), on_change, now }
    }

    fn save(&self, s: &State) {
        let v = Value::Array(s.list.iter().map(|d| Value::Object(d.to_json())).collect());
        if let Err(e) = write_json(&self.file, &v, formats::DEVICES) {
            eprintln!("devices: can't write {}: {e}", self.file.display());
        }
    }

    pub fn devices(&self) -> Vec<Device> {
        self.state.lock().list.clone()
    }

    pub fn get(&self, name: &str) -> Option<Device> {
        self.state.lock().list.iter().find(|d| d.name == name).cloned()
    }

    pub fn views(&self) -> Vec<DeviceView> {
        let s = self.state.lock();
        s.list
            .iter()
            .map(|d| DeviceView {
                device: d.clone(),
                using: s.holds.iter().filter(|h| h.name == d.name).map(|h| user_of(&h.owner, &h.at)).collect(),
                waiting: s.queue.iter().filter(|w| w.names.contains(&d.name)).map(|w| user_of(&w.owner, &w.at)).collect(),
            })
            .collect()
    }

    /// What a ticket's card shows (`ticketState`): devices it has now, and the ones it waits for; None for neither.
    pub fn ticket_state(&self, slug: &str, id: &str) -> Option<Value> {
        let owner = owner_key(slug, id);
        let s = self.state.lock();
        let using: Vec<Value> = s.holds.iter().filter(|h| h.owner == owner).map(|h| json!({ "name": h.name, "since": h.at })).collect();
        let w = s.queue.iter().find(|x| x.owner == owner);
        if using.is_empty() && w.is_none() {
            return None;
        }
        Some(json!({ "using": using, "waiting": w.map(|w| json!({ "names": w.names, "since": w.at })) }))
    }

    /// Adds a device, or changes its description or capacity (`upsert`). The user looked at it: it is theirs now.
    pub fn upsert(&self, name: &str, description: Option<&str>, capacity: Option<&Value>) -> Result<Device, DeviceError> {
        let name = device_names(&json!([name]))?.remove(0);
        let (d, changed) = {
            let mut s = self.state.lock();
            let i = match s.list.iter().position(|d| d.name == name) {
                Some(i) => i,
                None => {
                    s.list.push(Device { name: name.clone(), description: String::new(), capacity: 1, added_by_claude: false, last_used_at: Value::Null });
                    s.list.len() - 1
                }
            };
            let d = &mut s.list[i];
            if let Some(text) = description {
                d.description = slice16(trim(text), 300).to_string();
            }
            if let Some(c) = capacity {
                d.capacity = clamp_capacity(c);
            }
            d.added_by_claude = false;
            let d = d.clone();
            self.save(&s);
            (d, self.pump(&mut s, Vec::new()))
        };
        self.tell(changed);
        Ok(d)
    }

    /// Removes a device from the list; refused while a ticket uses it or waits for it.
    pub fn remove(&self, name: &str) -> Result<(), DeviceError> {
        {
            let mut s = self.state.lock();
            if !s.list.iter().any(|d| d.name == name) {
                return Err(err(404, format!("no device named \"{name}\"")));
            }
            if s.holds.iter().any(|h| h.name == name) || s.queue.iter().any(|w| w.names.iter().any(|n| n == name)) {
                return Err(err(409, format!("{name} is in use or a ticket waits for it: free it first")));
            }
            s.list.retain(|d| d.name != name);
            self.save(&s);
        }
        self.tell(Vec::new());
        Ok(())
    }

    /// Takes every named device for the ticket, waiting up to `wait_ms` for all of them at once. Names not on the list
    /// are added (one ticket at a time). When the wait runs out, the ticket keeps its place and asks again.
    pub async fn take(&self, slug: &str, id: &str, raw: &Value, wait_ms: f64) -> Result<TakeResult, DeviceError> {
        let names = device_names(raw)?;
        let owner = owner_key(slug, id);
        let (wake, seq, changed) = {
            let mut s = self.state.lock();
            let mine: Vec<String> = s.holds.iter().filter(|h| h.owner == owner).map(|h| h.name.clone()).collect();
            if names.iter().all(|n| mine.contains(n)) {
                return Ok(TakeResult::Got { names });
            }
            if !mine.is_empty() {
                let mut all = mine.clone();
                for n in &names {
                    if !all.contains(n) {
                        all.push(n.clone());
                    }
                }
                return Err(err(
                    409,
                    format!(
                        "you already have {}. Let go of it first (release_devices), then ask for everything you need in one request (e.g. {}), so two tickets never each hold one device and wait for the other.",
                        mine.join(", "),
                        serde_json::to_string(&all).unwrap_or_default()
                    ),
                ));
            }
            let mut added = false;
            for n in &names {
                if s.list.iter().any(|d| &d.name == n) {
                    continue;
                }
                s.list.push(Device { name: n.clone(), description: String::new(), capacity: 1, added_by_claude: true, last_used_at: Value::Null });
                added = true;
            }
            if added {
                self.save(&s);
            }
            // A different request goes to the back of the line.
            if let Some(i) = s.queue.iter().position(|x| x.owner == owner)
                && !same_set(&s.queue[i].names, &names) {
                    let w = s.queue.remove(i);
                    w.wake.notify_waiters();
                }
            let now = (self.now)();
            if !s.queue.iter().any(|x| x.owner == owner) {
                s.seq += 1;
                let seq = s.seq;
                s.queue.push(Wait { seq, owner: owner.clone(), names: names.clone(), at: now_iso(now), asked_at: now, wakers: 0, wake: Arc::new(Notify::new()) });
            }
            let w = s.queue.iter_mut().find(|x| x.owner == owner).expect("queued above");
            w.asked_at = now;
            let (wake, seq) = (w.wake.clone(), w.seq);
            let changed = self.pump(&mut s, vec![owner.clone()]);
            if has(&s, &owner, &names) {
                drop(s);
                self.tell(changed);
                return Ok(TakeResult::Got { names });
            }
            // Counted as waiting before the lock goes, so a pump meanwhile neither drops it as stale nor misses it.
            if let Some(w) = s.queue.iter_mut().find(|x| x.seq == seq) {
                w.wakers += 1;
            }
            (wake, seq, changed)
        };
        self.tell(changed);
        let notified = wake.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        // A grant or a drop between the lock and here already happened: then don't wait.
        let settled = {
            let s = self.state.lock();
            !s.queue.iter().any(|x| x.seq == seq)
        };
        if !settled {
            let _ = tokio::time::timeout(Duration::from_millis(wait_ms.max(0.0) as u64), notified).await;
        }
        let mut s = self.state.lock();
        let now = (self.now)();
        if let Some(w) = s.queue.iter_mut().find(|x| x.seq == seq) {
            w.wakers = w.wakers.saturating_sub(1);
            w.asked_at = now;
        }
        if has(&s, &owner, &names) {
            return Ok(TakeResult::Got { names });
        }
        let Some(place) = s.queue.iter().position(|x| x.seq == seq) else {
            return Err(err(409, "your request was cancelled (the user freed it or the run ended): ask again if you still need it"));
        };
        let used_by = s.holds.iter().filter(|h| names.contains(&h.name) && h.owner != owner).map(|h| user_of(&h.owner, &h.at)).collect();
        Ok(TakeResult::Waiting { names, place: place + 1, used_by })
    }

    /// Lets go of the named devices (all of them when `raw` is missing, null or empty), and drops the ticket's waiting
    /// request. Returns the names let go.
    pub fn release(&self, slug: &str, id: &str, raw: Option<&Value>) -> Result<Vec<String>, DeviceError> {
        let owner = owner_key(slug, id);
        let names = match raw {
            None | Some(Value::Null) => None,
            Some(Value::Array(a)) if a.is_empty() => None,
            Some(v) => Some(device_names(v)?),
        };
        let wanted = |n: &str| names.as_ref().is_none_or(|l| l.iter().any(|x| x == n));
        let (gone, changed) = {
            let mut s = self.state.lock();
            let mut gone = Vec::new();
            s.holds.retain(|h| {
                if h.owner == owner && wanted(&h.name) {
                    gone.push(h.name.clone());
                    false
                } else {
                    true
                }
            });
            let w = s.queue.iter().position(|x| x.owner == owner && (names.is_none() || x.names.iter().any(|n| wanted(n))));
            let dropped = w.is_some();
            if let Some(i) = w {
                let w = s.queue.remove(i);
                w.wake.notify_waiters();
            }
            let changed = if !gone.is_empty() || dropped { Some(self.pump(&mut s, vec![owner.clone()])) } else { None };
            (gone, changed)
        };
        if let Some(c) = changed {
            self.tell(c);
        }
        Ok(gone)
    }

    /// The ticket's run ended: frees everything it holds or waits for.
    pub fn release_all(&self, slug: &str, id: &str) {
        let _ = self.release(slug, id, None);
    }

    /// The user's "Free it": the ticket loses this device (it keeps running; its next take waits in line).
    pub fn free(&self, name: &str, slug: &str, id: &str) -> Result<(), DeviceError> {
        let owner = owner_key(slug, id);
        let changed = {
            let mut s = self.state.lock();
            let before = s.holds.len();
            s.holds.retain(|h| !(h.owner == owner && h.name == name));
            if s.holds.len() == before {
                return Err(err(404, format!("that ticket isn't using {name}")));
            }
            self.pump(&mut s, vec![owner])
        };
        self.tell(changed);
        Ok(())
    }

    fn tell(&self, owners: Vec<String>) {
        (self.on_change)(&owners);
    }

    /// Grants waiting requests in arrival order; one that can't be granted keeps later ones off its devices. Returns
    /// the owners whose state changed (told by the caller once the lock is let go).
    fn pump(&self, s: &mut State, changed: Vec<String>) -> Vec<String> {
        let mut owners = changed;
        let add = |o: &str, owners: &mut Vec<String>| {
            if !owners.iter().any(|x| x == o) {
                owners.push(o.to_string());
            }
        };
        let cutoff = (self.now)() - STALE_WAIT_MS;
        let mut i = 0;
        while i < s.queue.len() {
            if s.queue[i].wakers == 0 && s.queue[i].asked_at < cutoff {
                let w = s.queue.remove(i);
                w.wake.notify_waiters();
                add(&w.owner, &mut owners);
            } else {
                i += 1;
            }
        }
        let mut free: Vec<(String, i64)> =
            s.list.iter().map(|d| (d.name.clone(), d.capacity as i64 - s.holds.iter().filter(|h| h.name == d.name).count() as i64)).collect();
        let room = |free: &Vec<(String, i64)>, n: &str| free.iter().find(|(k, _)| k == n).map_or(0, |(_, v)| *v);
        let set = |free: &mut Vec<(String, i64)>, n: &str, v: i64| match free.iter_mut().find(|(k, _)| k == n) {
            Some(e) => e.1 = v,
            None => free.push((n.to_string(), v)),
        };
        let mut used = false;
        let mut i = 0;
        while i < s.queue.len() {
            if s.queue[i].names.iter().all(|n| room(&free, n) > 0) {
                let at = now_iso((self.now)());
                let w = s.queue.remove(i);
                for n in &w.names {
                    let left = room(&free, n) - 1;
                    set(&mut free, n, left);
                    s.holds.push(Hold { owner: w.owner.clone(), name: n.clone(), at: at.clone() });
                    if let Some(d) = s.list.iter_mut().find(|d| &d.name == n) {
                        d.last_used_at = json!(at);
                    }
                }
                used = true;
                w.wake.notify_waiters();
                add(&w.owner, &mut owners);
            } else {
                for n in s.queue[i].names.clone() {
                    set(&mut free, &n, 0);
                }
                i += 1;
            }
        }
        if used {
            self.save(s);
        }
        owners
    }
}

fn has(s: &State, owner: &str, names: &[String]) -> bool {
    names.iter().all(|n| s.holds.iter().any(|h| h.owner == owner && &h.name == n))
}

/// `devices.json` as Bun reads it: bad entries skipped, capacity clamped, an unreadable file read as empty.
fn load(file: &Path) -> Vec<Device> {
    let Ok(Some(raw)) = read_json(file) else { return Vec::new() };
    let Value::Array(list) = raw else { return Vec::new() };
    list.iter()
        .filter_map(|d| {
            let name = d.get("name")?.as_str()?;
            if !NAME_RE.is_match(name) {
                return None;
            }
            Some(Device {
                name: name.to_string(),
                description: d.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                capacity: clamp_capacity(d.get("capacity").unwrap_or(&Value::Null)),
                added_by_claude: d.get("addedByClaude").is_some_and(truthy),
                last_used_at: match d.get("lastUsedAt") {
                    None | Some(Value::Null) => Value::Null,
                    Some(v) => v.clone(),
                },
            })
        })
        .collect()
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Told = Arc<Mutex<Vec<Vec<String>>>>;

    fn devices(dir: &Path) -> (Arc<Devices>, Told) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let t = told.clone();
        (Arc::new(Devices::new(dir, Arc::new(move |o: &[String]| t.lock().push(o.to_vec())))), told)
    }

    #[test]
    fn names_are_checked_like_bun() {
        assert_eq!(device_names(&json!([" Leo-Phone ", "leo-phone", "b"])).unwrap(), ["leo-phone", "b"]);
        assert_eq!(device_names(&json!("a, b")).unwrap(), ["a", "b"]);
        assert_eq!(device_names(&json!([])).unwrap_err().status, 400);
        assert_eq!(device_names(&json!(["Two words"])).unwrap_err().message, "\"two words\" isn't a device name: use lowercase letters, digits and dashes, e.g. \"chrome-whatsapp\"");
        assert_eq!(clamp_capacity(&json!(99)), 50);
        assert_eq!(clamp_capacity(&json!(0)), 1);
        assert_eq!(clamp_capacity(&json!("2.9")), 2);
        assert_eq!(clamp_capacity(&json!("x")), 1);
    }

    #[test]
    fn upsert_writes_devices_json_like_bun() {
        let d = tempfile::tempdir().unwrap();
        let (dev, _) = devices(d.path());
        dev.upsert(" Leo-Phone ", Some("  The test phone "), Some(&json!(99))).unwrap();
        let raw = std::fs::read_to_string(d.path().join("devices.json")).unwrap();
        assert_eq!(raw, "[\n  {\n    \"name\": \"leo-phone\",\n    \"description\": \"The test phone\",\n    \"capacity\": 50,\n    \"lastUsedAt\": null\n  }\n]");
        // Read back as Bun would.
        let again = Devices::new(d.path(), Arc::new(|_: &[String]| {}));
        assert_eq!(again.devices()[0].capacity, 50);
    }

    #[tokio::test]
    async fn take_waits_in_line_and_release_hands_on() {
        let d = tempfile::tempdir().unwrap();
        let (dev, told) = devices(d.path());
        dev.upsert("phone", None, None).unwrap();
        assert_eq!(dev.take("b", "t1", &json!(["phone"]), 0.0).await.unwrap(), TakeResult::Got { names: vec!["phone".into()] });
        assert!(told.lock().iter().any(|o| o == &["b/t1".to_string()]));
        match dev.take("b", "t2", &json!(["phone"]), 0.0).await.unwrap() {
            TakeResult::Waiting { place, used_by, .. } => {
                assert_eq!(place, 1);
                assert_eq!(used_by[0].id, "t1");
            }
            r => panic!("{r:?}"),
        }
        assert_eq!(dev.take("b", "t1", &json!(["other"]), 0.0).await.unwrap_err().status, 409);
        // A waiting take returns once the holder lets go.
        let d2 = dev.clone();
        let waiting = tokio::spawn(async move { d2.take("b", "t2", &json!(["phone"]), 20_000.0).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(dev.release("b", "t1", None).unwrap(), ["phone"]);
        let got = tokio::time::timeout(Duration::from_secs(2), waiting).await.unwrap().unwrap().unwrap();
        assert_eq!(got, TakeResult::Got { names: vec!["phone".into()] });
        assert_eq!(dev.ticket_state("b", "t2").unwrap()["using"][0]["name"], "phone");
        assert!(dev.ticket_state("b", "t1").is_none());
        dev.free("phone", "b", "t2").unwrap();
        assert_eq!(dev.free("phone", "b", "t2").unwrap_err().status, 404);
    }

    #[tokio::test]
    async fn unknown_names_are_added_and_capacity_counts() {
        let d = tempfile::tempdir().unwrap();
        let (dev, _) = devices(d.path());
        assert!(matches!(dev.take("b", "a", &json!(["new-tablet"]), 0.0).await.unwrap(), TakeResult::Got { .. }));
        assert!(dev.get("new-tablet").unwrap().added_by_claude);
        dev.upsert("emu", None, Some(&json!(2))).unwrap();
        assert!(matches!(dev.take("b", "1", &json!(["emu"]), 0.0).await.unwrap(), TakeResult::Got { .. }));
        assert!(matches!(dev.take("b", "2", &json!(["emu"]), 0.0).await.unwrap(), TakeResult::Got { .. }));
        assert!(matches!(dev.take("b", "3", &json!(["emu"]), 0.0).await.unwrap(), TakeResult::Waiting { place: 1, .. }));
        assert_eq!(dev.remove("emu").unwrap_err().status, 409);
        for t in ["1", "2", "3"] {
            dev.release_all("b", t);
        }
        dev.remove("emu").unwrap();
        assert_eq!(dev.remove("emu").unwrap_err().status, 404);
    }
}
