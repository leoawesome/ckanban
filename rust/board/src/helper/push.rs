//! Phone push (`src/helper/push.ts` `PushService`): devices that turned notifications on in the board, kept in
//! `<root>/push.json` with the board's VAPID keys (owner-only: the private key is inside), and the sending side
//! (`webpush.rs`). A device whose board is on screen right now (the page's heartbeat) is skipped: the user already
//! sees it. Rust is the only writer of push.json in board mode; the satellite reads it and never writes it.
//!
//! push.json is small (a handful of devices), so it is read whole on each call, as Bun does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use ckanban_core::datafile;
use futures_util::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use serde_json::{Map, Value, json};

use super::webpush::{VapidKeys, device_id, generate_vapid_keys, push_request};
use crate::runs::js::{head16, trim};

/// How long a "board on screen" heartbeat counts; the page sends one every 15 s while visible.
pub const VISIBLE_MS: f64 = 40_000.0;
/// A send that timed out or hit a network error is tried once more after this long.
pub const RETRY_MS: u64 = 3000;
/// The newest dropped devices kept for the Notifications dialog.
const DROPPED_MAX: usize = 5;

static KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+=*$").expect("key"));

/// One POST out (push services and the web address channel): the status and its reason phrase, or why it failed.
pub trait Http: Send + Sync {
    fn post(&self, url: String, headers: Vec<(String, String)>, body: Vec<u8>) -> BoxFuture<'static, Result<(u16, String), String>>;
}

/// The real one: 10 s per request. `NODE_TLS_REJECT_UNAUTHORIZED=0` (the contract tests' self-signed fake push
/// service) is honoured as Bun's fetch honours it.
pub struct ReqwestHttp(reqwest::Client);

impl ReqwestHttp {
    pub fn new() -> Self {
        let insecure = std::env::var("NODE_TLS_REJECT_UNAUTHORIZED").is_ok_and(|v| v == "0");
        ReqwestHttp(reqwest::Client::builder().timeout(Duration::from_secs(10)).tls_danger_accept_invalid_certs(insecure).build().expect("http client"))
    }
}

impl Default for ReqwestHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl Http for ReqwestHttp {
    fn post(&self, url: String, headers: Vec<(String, String)>, body: Vec<u8>) -> BoxFuture<'static, Result<(u16, String), String>> {
        let c = self.0.clone();
        Box::pin(async move {
            let mut req = c.post(&url);
            for (k, v) in headers {
                req = req.header(k, v);
            }
            let r = req.body(body).send().await.map_err(without_url)?;
            Ok((r.status().as_u16(), r.status().canonical_reason().unwrap_or("").to_string()))
        })
    }
}

/// A request error without the address it went to (a push endpoint is a secret; a webhook may hold a token).
pub fn without_url(e: reqwest::Error) -> String {
    let e = e.without_url();
    if e.is_timeout() { "The operation timed out.".into() } else { e.to_string() }
}

/// What a send reached (`PushResult`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PushResult {
    pub sent: u64,
    /// Devices dropped because their push service said they're gone (404/410).
    pub removed: u64,
    /// Devices skipped because the board is on screen there.
    pub on_screen: u64,
    pub error: Option<String>,
}

/// Which devices a send goes to (`send`'s options).
#[derive(Clone, Debug, Default)]
pub struct SendTo {
    pub only: Option<String>,
    pub this_mac: bool,
    pub except_this_mac: bool,
    /// Skip devices with the board on screen (default true).
    pub skip_visible: bool,
}

impl SendTo {
    pub fn all() -> Self {
        SendTo { skip_visible: true, ..Default::default() }
    }
}

/// Called for each device removed because its push service said it is gone (the label).
pub type Dropped = Arc<dyn Fn(&str) + Send + Sync>;

pub struct PushService {
    root: PathBuf,
    /// One read-modify-write of push.json at a time (never held across a send).
    file: Mutex<()>,
    visible_until: Mutex<HashMap<String, f64>>,
    http: Arc<dyn Http>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    retry: Duration,
    dropped: RwLock<Vec<Dropped>>,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn truthy(v: Option<&Value>) -> bool {
    crate::runs::js::truthy(v)
}

impl PushService {
    pub fn new(root: &Path, http: Arc<dyn Http>, now: Arc<dyn Fn() -> f64 + Send + Sync>) -> Arc<Self> {
        Self::with_retry(root, http, now, Duration::from_millis(RETRY_MS))
    }

    pub fn with_retry(root: &Path, http: Arc<dyn Http>, now: Arc<dyn Fn() -> f64 + Send + Sync>, retry: Duration) -> Arc<Self> {
        Arc::new(PushService { root: root.to_path_buf(), file: Mutex::new(()), visible_until: Mutex::new(HashMap::new()), http, now, retry, dropped: RwLock::new(Vec::new()) })
    }

    pub fn on_dropped(&self, f: Dropped) {
        self.dropped.write().push(f);
    }

    fn path(&self) -> PathBuf {
        self.root.join("push.json")
    }

    /// The file, or fresh keys written when it is missing or damaged (`read`). Call with `file` held.
    fn read(&self) -> Map<String, Value> {
        let f = std::fs::read_to_string(self.path()).ok().and_then(|t| crate::runs::js::parse(&t));
        if let Some(f) = f
            && let Some(vapid) = f.get("vapid")
            && truthy(vapid.get("publicKey"))
            && truthy(vapid.get("privateKey"))
        {
            let mut out = Map::new();
            out.insert("vapid".into(), vapid.clone());
            out.insert("devices".into(), f.get("devices").filter(|d| d.is_array()).cloned().unwrap_or_else(|| json!([])));
            if let Some(d) = f.get("dropped").filter(|d| d.is_array()) {
                out.insert("dropped".into(), d.clone());
            }
            return out;
        }
        let k = generate_vapid_keys();
        let fresh = json!({ "vapid": { "publicKey": k.public_key, "privateKey": k.private_key }, "devices": [] });
        let fresh = fresh.as_object().cloned().unwrap_or_default();
        if let Err(e) = self.write(&fresh) {
            eprintln!("notify: can't write push.json: {e}");
        }
        fresh
    }

    /// Private key inside: owner-only (pretty, `.tmp` then rename).
    fn write(&self, f: &Map<String, Value>) -> std::io::Result<()> {
        datafile::write_json(&self.path(), &Value::Object(f.clone()), datafile::formats::PUSH)
    }

    fn snapshot(&self) -> Map<String, Value> {
        let _g = self.file.lock();
        self.read()
    }

    fn devices_of(f: &Map<String, Value>) -> Vec<Value> {
        f.get("devices").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn keys_of(f: &Map<String, Value>) -> VapidKeys {
        let v = f.get("vapid").cloned().unwrap_or(Value::Null);
        VapidKeys { public_key: s(&v, "publicKey").to_string(), private_key: s(&v, "privateKey").to_string() }
    }

    pub fn public_key(&self) -> Value {
        self.snapshot().get("vapid").and_then(|v| v.get("publicKey")).cloned().unwrap_or(Value::Null)
    }

    /// The devices as the answers show them: never the endpoint or keys.
    pub fn devices(&self) -> Vec<Value> {
        Self::devices_of(&self.snapshot()).iter().map(|d| json!({ "id": d.get("id"), "label": d.get("label"), "createdAt": d.get("createdAt") })).collect()
    }

    /// Devices the board removed because they stopped accepting notifications, newest last.
    pub fn dropped(&self) -> Value {
        self.snapshot().get("dropped").cloned().unwrap_or_else(|| json!([]))
    }

    /// Devices other than this Mac's browsers (phones, other computers): what the "push" channel reaches.
    pub fn phone_count(&self) -> u64 {
        Self::devices_of(&self.snapshot()).iter().filter(|d| !truthy(d.get("thisMac"))).count() as u64
    }

    /// Whether a browser on this Mac gets notifications (they open the ticket when clicked, unlike the Mac banner).
    pub fn has_this_mac(&self) -> bool {
        Self::devices_of(&self.snapshot()).iter().any(|d| truthy(d.get("thisMac")))
    }

    /// Add (or refresh) a device. Err on input that isn't a browser push subscription. Clears the dropped notice for
    /// `replaces` (the id it had before the board dropped it) and for devices with the same label.
    pub fn subscribe(&self, raw: &Value, label: Option<&Value>, this_mac: bool, replaces: Option<&str>) -> Result<Value, String> {
        let endpoint = raw.get("endpoint").and_then(Value::as_str).unwrap_or("");
        let u = url::Url::parse(endpoint).map_err(|_| "endpoint is not a valid URL".to_string())?;
        if u.scheme() != "https" {
            return Err("endpoint must be https".into());
        }
        let keys = raw.get("keys");
        let (p256dh, auth) = (keys.and_then(|k| k.get("p256dh")).and_then(Value::as_str), keys.and_then(|k| k.get("auth")).and_then(Value::as_str));
        let (Some(p256dh), Some(auth)) = (p256dh, auth) else { return Err("keys.p256dh and keys.auth are required".into()) };
        if !KEY_RE.is_match(p256dh) || !KEY_RE.is_match(auth) {
            return Err("keys.p256dh and keys.auth are required".into());
        }
        let _g = self.file.lock();
        let mut f = self.read();
        let id = device_id(endpoint);
        let mut devices = Self::devices_of(&f);
        let label = match label.and_then(Value::as_str).map(trim) {
            Some(l) if !l.is_empty() => head16(l, 80).to_string(),
            _ => "Browser".to_string(),
        };
        let created = devices.iter().find(|d| s(d, "id") == id).and_then(|d| d.get("createdAt").cloned()).unwrap_or_else(|| ckanban_core::time::iso((self.now)()).into());
        let mut device = json!({ "id": id, "endpoint": endpoint, "keys": { "p256dh": p256dh, "auth": auth }, "label": label, "createdAt": created });
        if this_mac {
            device["thisMac"] = true.into();
        }
        devices.retain(|d| s(d, "id") != id);
        devices.push(device.clone());
        f.insert("devices".into(), Value::Array(devices));
        if let Some(Value::Array(dropped)) = f.get_mut("dropped") {
            dropped.retain(|d| s(d, "id") != id && Some(s(d, "id")) != replaces && s(d, "label") != label);
        }
        self.write(&f).map_err(|e| format!("can't save the device: {e}"))?;
        Ok(device)
    }

    /// Remove by device id or endpoint; true when one was there.
    pub fn remove(&self, id_or_endpoint: &str) -> Result<bool, String> {
        let _g = self.file.lock();
        let mut f = self.read();
        let devices = Self::devices_of(&f);
        let kept: Vec<Value> = devices.iter().filter(|d| s(d, "id") != id_or_endpoint && s(d, "endpoint") != id_or_endpoint).cloned().collect();
        if kept.len() == devices.len() {
            return Ok(false);
        }
        f.insert("devices".into(), Value::Array(kept));
        self.write(&f).map_err(|e| format!("can't save the devices: {e}"))?;
        self.visible_until.lock().remove(id_or_endpoint);
        Ok(true)
    }

    /// Remove devices whose push service said they're gone, and remember them so the user is told.
    fn drop_gone(&self, ids: &[String]) {
        let dropped: Vec<Value> = {
            let _g = self.file.lock();
            let mut f = self.read();
            let at = ckanban_core::time::iso((self.now)());
            let devices = Self::devices_of(&f);
            let dropped: Vec<Value> =
                devices.iter().filter(|d| ids.iter().any(|i| i == s(d, "id"))).map(|d| json!({ "id": d.get("id"), "label": d.get("label"), "at": at })).collect();
            if dropped.is_empty() {
                return;
            }
            f.insert("devices".into(), Value::Array(devices.into_iter().filter(|d| !ids.iter().any(|i| i == s(d, "id"))).collect()));
            let mut list: Vec<Value> = f.get("dropped").and_then(Value::as_array).cloned().unwrap_or_default();
            list.retain(|d| !ids.iter().any(|i| i == s(d, "id")));
            list.extend(dropped.iter().cloned());
            let start = list.len().saturating_sub(DROPPED_MAX);
            f.insert("dropped".into(), Value::Array(list.split_off(start)));
            if let Err(e) = self.write(&f) {
                eprintln!("notify: can't write push.json: {e}");
            }
            dropped
        };
        for d in dropped {
            self.visible_until.lock().remove(s(&d, "id"));
            let listeners = self.dropped.read().clone();
            for f in listeners {
                f(s(&d, "label"));
            }
        }
    }

    /// A known device was seen in a browser on this Mac (devices turned on before `thisMac` existed); true when it
    /// changed.
    pub fn mark_this_mac(&self, endpoint: &str) -> bool {
        let _g = self.file.lock();
        let mut f = self.read();
        let mut devices = Self::devices_of(&f);
        let Some(d) = devices.iter_mut().find(|x| s(x, "endpoint") == endpoint) else { return false };
        if truthy(d.get("thisMac")) {
            return false;
        }
        d["thisMac"] = true.into();
        f.insert("devices".into(), Value::Array(devices));
        if let Err(e) = self.write(&f) {
            eprintln!("notify: can't write push.json: {e}");
            return false;
        }
        true
    }

    /// The page's heartbeat: its board is on screen (or not anymore).
    pub fn set_visible(&self, endpoint: &str, visible: bool) {
        let id = device_id(endpoint);
        let mut v = self.visible_until.lock();
        if visible {
            v.insert(id, (self.now)() + VISIBLE_MS);
        } else {
            v.remove(&id);
        }
    }

    /// The board is on screen on some device right now (the helper's "board on screen").
    pub fn any_visible(&self) -> bool {
        let now = (self.now)();
        self.visible_until.lock().values().any(|u| *u > now)
    }

    /// Devices other than this Mac's browsers: a phone (or another computer) push reaches.
    pub fn phone_devices(&self) -> u64 {
        self.phone_count()
    }

    fn is_visible(&self, id: &str) -> bool {
        self.visible_until.lock().get(id).is_some_and(|u| *u > (self.now)())
    }

    /// Send to every device (or only one, only this Mac's browsers, or all but those), skipping those with the board
    /// on screen unless `skip_visible` is false. `payload` is the JSON the service worker reads.
    pub async fn send(&self, payload: &Value, o: &SendTo) -> PushResult {
        let f = self.snapshot();
        let keys = Self::keys_of(&f);
        let wanted: Vec<Value> = Self::devices_of(&f)
            .into_iter()
            .filter(|d| o.only.as_deref().is_none_or(|only| s(d, "id") == only || s(d, "endpoint") == only))
            .filter(|d| !o.this_mac || truthy(d.get("thisMac")))
            .filter(|d| !o.except_this_mac || !truthy(d.get("thisMac")))
            .collect();
        let targets: Vec<Value> = wanted.iter().filter(|d| !(o.skip_visible && self.is_visible(s(d, "id")))).cloned().collect();
        let text = payload.to_string();
        let now_sec = ((self.now)() / 1000.0).floor() as i64;
        let sends = targets.iter().map(|d| {
            let (keys, text) = (keys.clone(), text.clone());
            async move {
                let label = s(d, "label").to_string();
                let k = d.get("keys").cloned().unwrap_or(Value::Null);
                let req = match push_request(s(d, "endpoint"), s(&k, "p256dh"), s(&k, "auth"), &text, &keys, now_sec) {
                    Ok(r) => r,
                    Err(e) => return (s(d, "id").to_string(), Err(format!("push to {label} failed: {e}"))),
                };
                let headers: Vec<(String, String)> = req.headers.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
                // A timeout or network error gets one more try (phones on a weak network often miss the first).
                let mut r = self.http.post(req.url.clone(), headers.clone(), req.body.clone()).await;
                if r.is_err() {
                    tokio::time::sleep(self.retry).await;
                    r = self.http.post(req.url, headers, req.body).await;
                }
                let out = match r {
                    Ok((404 | 410, _)) => Ok(None),
                    Ok((status, _)) if (200..300).contains(&status) => Ok(Some(())),
                    Ok((status, reason)) => Err(trim(&format!("push to {label} answered {status} {reason}")).to_string()),
                    Err(e) => Err(format!("push to {label} failed: {e}")),
                };
                (s(d, "id").to_string(), out)
            }
        });
        let results = futures_util::future::join_all(sends).await;
        let (mut sent, mut gone, mut errors) = (0u64, Vec::new(), Vec::new());
        for (id, r) in results {
            match r {
                Ok(Some(())) => sent += 1,
                Ok(None) => gone.push(id),
                Err(e) => errors.push(e),
            }
        }
        if !gone.is_empty() {
            self.drop_gone(&gone);
        }
        PushResult { sent, removed: gone.len() as u64, on_screen: (wanted.len() - targets.len()) as u64, error: errors.into_iter().next() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helper::webpush::{b64url, decrypt_payload};
    use aws_lc_rs::agreement::{ECDH_P256, PrivateKey};
    use aws_lc_rs::encoding::AsBigEndian;

    type Request = (String, Vec<(String, String)>, Vec<u8>);

    /// A fake push service: every request, and the status it answers per endpoint word.
    #[derive(Default)]
    struct FakePush {
        got: Mutex<Vec<Request>>,
        fail_first: Mutex<u32>,
    }

    impl Http for Arc<FakePush> {
        fn post(&self, url: String, headers: Vec<(String, String)>, body: Vec<u8>) -> BoxFuture<'static, Result<(u16, String), String>> {
            let me = self.clone();
            Box::pin(async move {
                {
                    let mut f = me.fail_first.lock();
                    if *f > 0 {
                        *f -= 1;
                        return Err("network down".into());
                    }
                }
                me.got.lock().push((url.clone(), headers, body));
                Ok(if url.contains("gone") { (410, "Gone".into()) } else if url.contains("bad") { (500, "Internal Server Error".into()) } else { (201, "Created".into()) })
            })
        }
    }

    /// A browser: its subscription and the keys to read what it gets.
    fn browser(endpoint: &str) -> (Value, String, String) {
        let k = PrivateKey::generate(&ECDH_P256).unwrap();
        let public = b64url(k.compute_public_key().unwrap().as_ref());
        let private: aws_lc_rs::encoding::EcPrivateKeyBin<'static> = k.as_be_bytes().unwrap();
        let auth = b64url(&[7u8; 16]);
        (json!({ "endpoint": endpoint, "keys": { "p256dh": public, "auth": auth } }), b64url(private.as_ref()), auth)
    }

    fn service(dir: &Path, fake: &Arc<FakePush>, now: f64) -> Arc<PushService> {
        PushService::with_retry(dir, Arc::new(fake.clone()), Arc::new(move || now), Duration::from_millis(1))
    }

    #[tokio::test]
    async fn devices_are_kept_in_bun_s_bytes_and_never_shown_with_their_keys() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakePush::default());
        let push = service(dir.path(), &fake, 1_700_000_000_000.0);
        let key = push.public_key();
        let raw = std::fs::read_to_string(dir.path().join("push.json")).unwrap();
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["vapid"]["publicKey"], key);
        assert_eq!(raw, format!("{}\n", serde_json::to_string_pretty(&v).unwrap()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("push.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(push.subscribe(&json!({ "endpoint": "http://x/y" }), None, false, None).unwrap_err(), "endpoint must be https");
        assert_eq!(push.subscribe(&json!({ "endpoint": "nope" }), None, false, None).unwrap_err(), "endpoint is not a valid URL");
        assert_eq!(push.subscribe(&json!({ "endpoint": "https://p/x", "keys": { "p256dh": "a b", "auth": "c" } }), None, false, None).unwrap_err(), "keys.p256dh and keys.auth are required");
        let (sub, _, _) = browser("https://push.example/p1");
        let d = push.subscribe(&sub, Some(&json!("  My phone ")), false, None).unwrap();
        assert_eq!(d["label"], "My phone");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.path().join("push.json")).unwrap()).unwrap();
        let keys: Vec<&str> = saved["devices"][0].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["id", "endpoint", "keys", "label", "createdAt"]);
        assert_eq!(saved["devices"][0]["createdAt"], "2023-11-14T22:13:20.000Z");
        // The answers: id, label and createdAt only.
        let listed = serde_json::to_string(&push.devices()).unwrap();
        assert!(!listed.contains("push.example") && !listed.contains(sub["keys"]["auth"].as_str().unwrap()));
        assert_eq!(push.phone_count(), 1);
        assert!(!push.has_this_mac());
        assert!(push.mark_this_mac("https://push.example/p1"));
        assert!(push.has_this_mac());
        assert!(!push.remove("nope").unwrap());
        assert!(push.remove("https://push.example/p1").unwrap());
        assert!(push.devices().is_empty());
    }

    #[tokio::test]
    async fn a_send_encrypts_for_the_device_skips_the_board_on_screen_and_drops_gone_ones() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakePush::default());
        let push = service(dir.path(), &fake, 1_000_000.0);
        let (sub, private, auth) = browser("https://push.example/p1");
        push.subscribe(&sub, Some(&json!("Phone")), false, None).unwrap();
        let payload = json!({ "title": "T", "body": "B", "url": "u", "tag": "x" });
        let r = push.send(&payload, &SendTo::all()).await;
        assert_eq!(r, PushResult { sent: 1, ..Default::default() });
        let (url, headers, body) = fake.got.lock()[0].clone();
        assert_eq!(url, "https://push.example/p1");
        assert!(headers.iter().any(|(k, v)| k == "Authorization" && v.starts_with("vapid t=")));
        assert_eq!(decrypt_payload(&body, &private, &auth).unwrap(), payload.to_string().as_bytes());
        // On screen there: skipped, unless the send says every device.
        push.set_visible("https://push.example/p1", true);
        assert!(push.any_visible());
        assert_eq!(push.send(&payload, &SendTo::all()).await, PushResult { on_screen: 1, ..Default::default() });
        assert_eq!(push.send(&payload, &SendTo::default()).await.sent, 1);
        // A network error is tried once more.
        *fake.fail_first.lock() = 1;
        assert_eq!(push.send(&payload, &SendTo::default()).await.sent, 1);
        // A failing push service is an error; a gone device is dropped, remembered and told.
        let told = Arc::new(Mutex::new(Vec::<String>::new()));
        let t = told.clone();
        push.on_dropped(Arc::new(move |l: &str| t.lock().push(l.to_string())));
        let (bad, _, _) = browser("https://push.example/bad");
        push.subscribe(&bad, Some(&json!("Tablet")), false, None).unwrap();
        let (gone, _, _) = browser("https://push.example/gone");
        let g = push.subscribe(&gone, Some(&json!("Old phone")), false, None).unwrap();
        let r = push.send(&payload, &SendTo::default()).await;
        assert_eq!((r.sent, r.removed, r.error.as_deref()), (1, 1, Some("push to Tablet answered 500 Internal Server Error")));
        assert_eq!(*told.lock(), ["Old phone"]);
        assert_eq!(push.dropped(), json!([{ "id": g["id"], "label": "Old phone", "at": "1970-01-01T00:16:40.000Z" }]));
        // Turned on again: the notice goes.
        push.subscribe(&gone, Some(&json!("Old phone")), false, Some("x")).unwrap();
        assert_eq!(push.dropped(), json!([]));
    }
}
