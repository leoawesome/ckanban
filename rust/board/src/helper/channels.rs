//! The channels a message goes out on (`src/helper/channels.ts`). Built in: "mac" (the Mac banner, or this Mac's
//! browser when it gets notifications), "push" (phones and other browsers that turned phone push on), "webhook"
//! (ntfy or JSON), sent here since P1b; "telegram" still goes through the satellite until P1c (`helper-send` with
//! only that channel).

use std::sync::Arc;

use base64::Engine;
use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::board::Facts;
use super::notify_settings::{channel_enabled, enabled, is_ntfy, telegram_takes};
use super::push::{Http, PushService, SendTo};
use crate::runs::js::{head16, squash_ws, trim, truthy};
use crate::tickets::files::encode_uri_component as enc;

/// What sends a message to some channels. `targets` are already filtered (on, set up, and taking this message).
pub trait Sender: Send + Sync {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>>;
    /// What the helper asks about the user's devices (phone push devices, the board on screen, a connection).
    fn facts(&self) -> BoxFuture<'static, Facts>;
}

/// No channels (tests): every target fails.
pub struct NoSender;

impl Sender for NoSender {
    fn send(&self, _: Value, _: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        Box::pin(async { Err("no sender".to_string()) })
    }
    fn facts(&self) -> BoxFuture<'static, Facts> {
        Box::pin(async { Facts::default() })
    }
}

/// `Channels.sendAll`: to the named channels (default: every one that is on), a channel that doesn't take the message
/// left out. A sender that can't be reached fails each target.
pub async fn send_all(sender: &Arc<dyn Sender>, out: &Map<String, Value>, settings: &Value, only: Option<&[String]>) -> Vec<Value> {
    let on: Vec<String> = match only {
        Some(names) => names.iter().filter(|n| channel_enabled(settings, n)).cloned().collect(),
        None => enabled(settings),
    };
    let targets: Vec<String> = on.into_iter().filter(|c| c != "telegram" || telegram_takes(out)).collect();
    if targets.is_empty() {
        return Vec::new();
    }
    match sender.send(Value::Object(out.clone()), targets.clone()).await {
        Ok(r) => r,
        Err(e) => targets.iter().map(|c| json!({ "channel": c, "ok": false, "error": format!("{c} failed: {e}") })).collect(),
    }
}

/// The Mac banner can't open a page, so it points the user at the board.
pub const MAC_BANNER_HINT: &str = "See Messages on the board";
/// ntfy's body limit is 4096 bytes; keep under it.
pub const NTFY_MAX_BYTES: usize = 4000;

/// `NTFY_TAGS[kind]`.
pub fn ntfy_tag(kind: &str) -> &'static str {
    match kind {
        "stalled" => "warning",
        "questions" => "question",
        "proposal" => "memo",
        "review" => "eyes",
        "failed" => "x",
        "limit" => "hourglass",
        "blocked" => "no_entry",
        "huddle" | "reply" => "speech_balloon",
        "message" => "bell",
        _ => "undefined",
    }
}

/// HTTP headers allow Latin-1 only; ntfy reads RFC 2047 encoded words for anything else.
pub fn header_value(s: &str) -> String {
    let flat = trim(&squash_ws(s)).to_string();
    if flat.chars().all(|c| (' '..='~').contains(&c)) {
        flat
    } else {
        format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(flat.as_bytes()))
    }
}

/// Cuts text to at most `max` UTF-8 bytes (never inside a character).
pub fn cut_bytes(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max.saturating_sub(3);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn origin(url: &str) -> Option<String> {
    url::Url::parse(url).ok().map(|u| u.origin().ascii_serialization()).filter(|o| o != "null")
}

/// The message page for a stored message, on the same address as the link.
pub fn message_page_url(url: &str, message_id: &str) -> String {
    match origin(url) {
        Some(o) => format!("{o}/#/~messages/{}", enc(message_id)),
        None => url.to_string(),
    }
}

/// A ticket's page that also marks the message read: `#/<board>/<ticketId>?read=<messageId>`.
pub fn ticket_tap_url(url: &str, board: &str, ticket_id: &str, message_id: &str) -> String {
    match origin(url) {
        Some(o) => format!("{o}/#/{}/{}?read={}", enc(board), enc(ticket_id), enc(message_id)),
        None => url.to_string(),
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn sm<'a>(m: &'a Map<String, Value>, k: &str) -> &'a str {
    m.get(k).and_then(Value::as_str).unwrap_or("")
}

/// What a tap opens (phone push, ntfy Click, Telegram Open): the one ticket an urgent alert or reminder is about,
/// else the message's page when it is stored, else the link.
pub fn tap_url(m: &Map<String, Value>) -> String {
    let id = sm(m, "messageId");
    if !truthy(m.get("messageId")) {
        return sm(m, "url").to_string();
    }
    match m.get("ticket").filter(|t| truthy(Some(t))) {
        Some(t) => ticket_tap_url(sm(m, "url"), s(t, "board"), s(t, "ticketId"), id),
        None => message_page_url(sm(m, "url"), id),
    }
}

/// The legacy "needs you" shape a message carries, or one made from it.
fn legacy(m: &Map<String, Value>) -> Value {
    m.get("notify").filter(|n| truthy(Some(n))).cloned().unwrap_or_else(|| {
        json!({ "board": "", "boardName": "ckanban", "ticketId": "", "title": sm(m, "title"), "kind": "message", "label": sm(m, "body"), "url": sm(m, "url") })
    })
}

/// A phone notification: the ticket as title, what it needs (and the board) below; one per ticket on screen.
pub fn push_payload(n: &Value) -> Map<String, Value> {
    let tag = if s(n, "ticketId").is_empty() { "ckanban".to_string() } else { format!("{}/{}", s(n, "board"), s(n, "ticketId")) };
    let v = json!({ "title": s(n, "title"), "body": format!("{} · {}", s(n, "label"), s(n, "boardName")), "url": s(n, "url"), "tag": tag });
    v.as_object().cloned().unwrap_or_default()
}

/// The phone push payload: a tap opens tap_url's page (sw.js), the one line below the title.
pub fn payload_of(m: &Map<String, Value>) -> Value {
    let mut p = if truthy(m.get("notify")) {
        push_payload(&legacy(m))
    } else {
        let tag = m.get("tag").filter(|t| truthy(Some(t))).cloned().unwrap_or_else(|| "ckanban".into());
        json!({ "title": m.get("title"), "body": m.get("body"), "url": m.get("url"), "tag": tag }).as_object().cloned().unwrap_or_default()
    };
    if let Some(t) = m.get("tag").filter(|t| truthy(Some(t))) {
        p.insert("tag".into(), t.clone());
    }
    p.insert("url".into(), tap_url(m).into());
    if truthy(m.get("messageId")) {
        p.insert("messageId".into(), m.get("messageId").cloned().unwrap_or(Value::Null));
    }
    Value::Object(p)
}

/// The web address request: (url, headers, body).
pub type HookRequest = (String, Vec<(String, String)>, Vec<u8>);

/// ntfy: the full text in the body (up to about 4 KB), Priority 5 when urgent, a Click link only with phone access.
pub fn ntfy_request(webhook_url: &str, m: &Map<String, Value>, phone_access: bool) -> HookRequest {
    let n = legacy(m);
    let title = if truthy(m.get("notify")) && s(&n, "kind") != "message" { format!("{}: {}", s(&n, "label"), s(&n, "title")) } else { sm(m, "title").to_string() };
    let tail = if phone_access { "" } else { "\n\nAnswer on your Mac." };
    let t = trim(sm(m, "text"));
    let text = if t.is_empty() { sm(m, "body") } else { t };
    let urgent = truthy(m.get("urgent"));
    let mut headers = vec![
        ("Title".to_string(), header_value(&title)),
        ("Tags".to_string(), if urgent { "rotating_light".into() } else { ntfy_tag(s(&n, "kind")).to_string() }),
        ("Content-Type".to_string(), "text/plain; charset=utf-8".to_string()),
    ];
    if phone_access {
        headers.push(("Click".into(), tap_url(m)));
    }
    if urgent {
        headers.push(("Priority".into(), "5".into()));
    }
    let body = cut_bytes(text, NTFY_MAX_BYTES - tail.len()) + tail;
    (webhook_url.to_string(), headers, body.into_bytes())
}

/// The JSON web address request: {board, boardName, ticketId, title, kind, label, url}.
pub fn json_request(webhook_url: &str, n: &Value) -> HookRequest {
    let body = json!({ "board": n.get("board"), "boardName": n.get("boardName"), "ticketId": n.get("ticketId"), "title": n.get("title"), "kind": n.get("kind"), "label": n.get("label"), "url": n.get("url") });
    (webhook_url.to_string(), vec![("Content-Type".into(), "application/json".into())], body.to_string().into_bytes())
}

/// Shows a Mac banner (title, body).
pub type Banner = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// The real banner: `osascript -e 'display notification ...'` (macOS only; nothing when it fails).
pub fn mac_banner() -> Banner {
    Arc::new(|title: &str, body: &str| {
        if !cfg!(target_os = "macos") {
            return;
        }
        let q = |s: &str| serde_json::to_string(head16(&squash_ws(s), 240)).unwrap_or_default();
        let script = format!("display notification {} with title {}", q(body), q(title));
        std::thread::spawn(move || {
            let _ = std::process::Command::new("osascript")
                .arg("-e")
                .arg(script)
                .current_dir(ckanban_core::home::home_dir())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        });
    })
}

/// How the last send went (Settings' "last sent" line).
#[derive(Clone, Debug, Default)]
pub struct LastSend {
    pub sent_at: Option<String>,
    pub error: Option<String>,
}

/// The board's own channels, and Telegram through the satellite.
pub struct Channels {
    root: std::path::PathBuf,
    pub push: Arc<PushService>,
    http: Arc<dyn Http>,
    banner: Banner,
    base_url: Arc<dyn Fn() -> String + Send + Sync>,
    telegram: Arc<dyn Sender>,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
    last: Mutex<LastSend>,
    /// Some MCP server is connected (the helper's check-in offer); set by the board.
    pub connected: std::sync::atomic::AtomicBool,
}

impl Channels {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        root: &std::path::Path,
        push: Arc<PushService>,
        http: Arc<dyn Http>,
        banner: Banner,
        base_url: Arc<dyn Fn() -> String + Send + Sync>,
        telegram: Arc<dyn Sender>,
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> Arc<Self> {
        let me = Arc::new(Channels {
            root: root.to_path_buf(),
            push,
            http,
            banner,
            base_url,
            telegram,
            now,
            last: Mutex::new(LastSend::default()),
            connected: std::sync::atomic::AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&me);
        me.push.on_dropped(Arc::new(move |label: &str| {
            if let Some(c) = weak.upgrade() {
                c.dropped(label);
            }
        }));
        me
    }

    pub fn last(&self) -> LastSend {
        self.last.lock().clone()
    }

    fn settings(&self) -> Value {
        super::notify_settings::read_notify(&self.root)
    }

    /// Phone access is on (links open off this Mac): the link base isn't this Mac's localhost.
    pub fn phone_access(&self) -> bool {
        static LOCAL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?/?$").expect("local"));
        !LOCAL.is_match(&(self.base_url)())
    }

    /// This Mac: a push to this Mac's browser when one gets notifications (a click opens the message), else the Mac
    /// banner (a click can't open a page, so it says "See Messages on the board").
    async fn mac(&self, m: &Map<String, Value>) -> Value {
        if self.push.has_this_mac() {
            let r = self.push.send(&payload_of(m), &SendTo { this_mac: true, skip_visible: !truthy(m.get("everyDevice")), ..Default::default() }).await;
            if r.sent > 0 || r.on_screen > 0 {
                return json!({ "channel": "mac", "ok": r.sent > 0, "devices": r.sent, "onScreen": r.on_screen, "error": r.error });
            }
            // The browser didn't take it: the banner still can.
        }
        let n = legacy(m);
        let stored = truthy(m.get("messageId"));
        if truthy(m.get("notify")) && s(&n, "kind") != "message" {
            let body = if stored { format!("{} · {MAC_BANNER_HINT}", s(&n, "boardName")) } else { s(&n, "boardName").to_string() };
            (self.banner)(&format!("{}: {}", s(&n, "label"), s(&n, "title")), &body);
        } else {
            let body = if stored { format!("{} · {MAC_BANNER_HINT}", sm(m, "body")) } else { sm(m, "body").to_string() };
            (self.banner)(sm(m, "title"), &body);
        }
        json!({ "channel": "mac", "ok": true, "error": null })
    }

    /// Phones and other browsers that turned phone push on (this Mac's browser is the "mac" channel). 0 devices is a
    /// failure.
    async fn phone(&self, m: &Map<String, Value>) -> Value {
        let r = self.push.send(&payload_of(m), &SendTo { skip_visible: !truthy(m.get("everyDevice")), except_this_mac: true, ..Default::default() }).await;
        let empty = r.error.is_none() && r.sent == 0 && r.on_screen == 0 && r.removed == 0;
        let error = r.error.clone().or_else(|| empty.then(|| "no phone has notifications turned on".to_string()));
        let mut v = json!({ "channel": "push", "ok": r.sent > 0, "devices": r.sent, "onScreen": r.on_screen, "error": error });
        if empty {
            v["empty"] = true.into();
        }
        v
    }

    /// The web address channel: ntfy (`ntfy_request`) or any JSON endpoint.
    async fn webhook(&self, m: &Map<String, Value>, settings: &Value) -> Value {
        let url = s(settings, "webhookUrl");
        if url.is_empty() {
            return json!({ "channel": "webhook", "ok": false, "skipped": true, "error": null });
        }
        let (u, headers, body) = if is_ntfy(settings) { ntfy_request(url, m, self.phone_access()) } else { json_request(url, &legacy(m)) };
        match self.http.post(u, headers, body).await {
            Ok((status, _)) if (200..300).contains(&status) => json!({ "channel": "webhook", "ok": true, "error": null }),
            Ok((status, reason)) => json!({ "channel": "webhook", "ok": false, "error": trim(&format!("webhook answered {status} {reason}")) }),
            Err(e) => json!({ "channel": "webhook", "ok": false, "error": format!("webhook failed: {e}") }),
        }
    }

    async fn one(&self, name: &str, m: &Map<String, Value>, settings: &Value) -> Value {
        match name {
            "mac" => self.mac(m).await,
            "push" => self.phone(m).await,
            "webhook" => self.webhook(m, settings).await,
            "telegram" => match self.telegram.send(Value::Object(m.clone()), vec!["telegram".into()]).await {
                Ok(mut r) if !r.is_empty() => r.remove(0),
                Ok(_) => json!({ "channel": "telegram", "ok": false, "error": "telegram failed: no answer" }),
                Err(e) => json!({ "channel": "telegram", "ok": false, "error": format!("telegram failed: {e}") }),
            },
            other => json!({ "channel": other, "ok": false, "error": format!("{other} failed: unknown channel") }),
        }
    }

    /// Sends to these channels at once, results in their order, and notes how it went (`noteResults`).
    pub async fn send_to(&self, m: Map<String, Value>, targets: Vec<String>) -> Vec<Value> {
        let settings = self.settings();
        let results = futures_util::future::join_all(targets.iter().map(|t| self.one(t, &m, &settings))).await;
        self.note(&results, &settings);
        results
    }

    /// lastSentAt / lastError from a send's channel results (the banner can't tell).
    fn note(&self, results: &[Value], settings: &Value) {
        let counted: Vec<&Value> = results.iter().filter(|r| s(r, "channel") != "mac" && !truthy(r.get("skipped")) && !truthy(r.get("empty"))).collect();
        let error = counted.iter().find_map(|r| r.get("error").and_then(Value::as_str).filter(|e| !e.is_empty())).map(str::to_string);
        let sent = counted.iter().any(|r| r.get("ok") == Some(&Value::Bool(true)));
        if let Some(e) = &error {
            let token = settings.get("telegram").map(|t| s(t, "token")).unwrap_or("");
            eprintln!("notify: {}", scrub(e, token));
        }
        let mut l = self.last.lock();
        if sent || error.is_some() {
            l.error = error;
        }
        if sent {
            l.sent_at = Some(ckanban_core::time::iso((self.now)()));
        }
    }

    /// A device stopped accepting notifications and the board removed it: log it and tell the user on this Mac (its
    /// browser, or the banner), since that device won't hear about it.
    fn dropped(self: &Arc<Self>, label: &str) {
        eprintln!("notify: {label} no longer accepts notifications (its push service said it is gone), so the board removed it");
        if !truthy(self.settings().get("mac")) {
            return;
        }
        let title = format!("Notifications stopped on {label}");
        let body = "Open the board there and turn notifications on again.";
        if !self.push.has_this_mac() {
            return (self.banner)(&title, body);
        }
        let payload = json!({ "title": title, "body": body, "url": format!("{}/", (self.base_url)()), "tag": "push-dropped" });
        let me = self.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let r = me.push.send(&payload, &SendTo { this_mac: true, ..Default::default() }).await;
                if let Some(e) = r.error {
                    eprintln!("notify: {e}");
                }
            });
        }
    }

    /// Only on this Mac (when the banner is on), not to the web address or phones: board events that aren't "needs
    /// you" (a plan done). `url` is the ticket a click opens.
    pub fn mac_only(self: &Arc<Self>, title: &str, body: &str, url: &str) {
        if !truthy(self.settings().get("mac")) {
            return;
        }
        if !self.push.has_this_mac() {
            return (self.banner)(title, body);
        }
        let payload = json!({ "title": title, "body": body, "url": url, "tag": url });
        let me = self.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let r = me.push.send(&payload, &SendTo { this_mac: true, skip_visible: true, ..Default::default() }).await;
                if let Some(e) = r.error {
                    eprintln!("notify: {e}");
                }
            });
        }
    }
}

/// Takes the Telegram token out of any text that may hold it (`scrub`).
pub fn scrub(text: &str, token: &str) -> String {
    static BOT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"bot\d{5,15}:[A-Za-z0-9_-]{20,}").expect("bot"));
    let out = if token.is_empty() { text.to_string() } else { text.replace(token, "<token>") };
    BOT.replace_all(&out, "bot<token>").into_owned()
}

impl Sender for Arc<Channels> {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>> {
        let me = self.clone();
        Box::pin(async move { Ok(me.send_to(out.as_object().cloned().unwrap_or_default(), targets).await) })
    }
    fn facts(&self) -> BoxFuture<'static, Facts> {
        let me = self.clone();
        Box::pin(async move {
            let push = me.push.clone();
            // push.json is read from disk: off the runtime.
            let (on_screen, phone_devices) = tokio::task::spawn_blocking(move || (push.any_visible(), push.phone_devices())).await.unwrap_or((false, 0));
            Facts { on_screen, phone_devices, connected: me.connected.load(std::sync::atomic::Ordering::Relaxed) }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn header_values_and_byte_cuts_are_bun_s() {
        assert_eq!(header_value("  Answer\n2 questions: Fix   it "), "Answer 2 questions: Fix it");
        assert_eq!(header_value("Café"), "=?UTF-8?B?Q2Fmw6k=?=");
        assert_eq!(cut_bytes("abc", 10), "abc");
        assert_eq!(cut_bytes("aéééé", 7), "aé…");
        assert_eq!(scrub("GET /bot12345:AAAAAAAAAAAAAAAAAAAAAAAA/x failed (tok)", "tok"), "GET /bot<token>/x failed (<token>)");
    }

    #[test]
    fn taps_open_the_ticket_or_the_message_page() {
        let base = json!({ "url": "http://localhost:3000/#/b", "messageId": "m1", "ticket": null });
        assert_eq!(tap_url(&m(base.clone())), "http://localhost:3000/#/~messages/m1");
        let mut t = base.clone();
        t["ticket"] = json!({ "board": "b", "ticketId": "t 1" });
        assert_eq!(tap_url(&m(t)), "http://localhost:3000/#/b/t%201?read=m1");
        let mut none = base;
        none["messageId"] = Value::Null;
        assert_eq!(tap_url(&m(none)), "http://localhost:3000/#/b");
    }

    #[test]
    fn the_push_payload_and_the_ntfy_request() {
        let notify = json!({ "board": "b", "boardName": "Board", "ticketId": "t1", "title": "Fix", "kind": "questions", "label": "Answer 2 questions", "url": "http://x/#/b/t1" });
        let out = m(json!({ "messageId": "m1", "level": "direct", "title": "Fix", "body": "Answer 2 questions", "text": "Fix (Board)\n\nAnswer", "url": "http://x/#/b/t1", "ticket": null, "notify": notify }));
        assert_eq!(payload_of(&out).to_string(), r#"{"title":"Fix","body":"Answer 2 questions · Board","url":"http://x/#/~messages/m1","tag":"b/t1","messageId":"m1"}"#);
        let (_, h, body) = ntfy_request("https://ntfy.sh/x", &out, false);
        assert_eq!(h[0], ("Title".to_string(), "Answer 2 questions: Fix".to_string()));
        assert_eq!(h[1].1, "question");
        assert!(!h.iter().any(|(k, _)| k == "Click"));
        assert_eq!(String::from_utf8(body).unwrap(), "Fix (Board)\n\nAnswer\n\nAnswer on your Mac.");
        let (_, h, _) = ntfy_request("https://ntfy.sh/x", &m(json!({ "title": "T", "body": "B", "text": "", "url": "https://h.ts.net/", "urgent": true, "messageId": null })), true);
        assert_eq!(h.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>(), ["Title=T", "Tags=rotating_light", "Content-Type=text/plain; charset=utf-8", "Click=https://h.ts.net/", "Priority=5"]);
        let (_, _, j) = json_request("http://h", &legacy(&m(json!({ "title": "T", "body": "B", "url": "u" }))));
        assert_eq!(String::from_utf8(j).unwrap(), r#"{"board":"","boardName":"ckanban","ticketId":"","title":"T","kind":"message","label":"B","url":"u"}"#);
    }
}
