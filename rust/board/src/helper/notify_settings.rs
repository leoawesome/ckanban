//! Notification settings (`src/helper/notify.ts` `readNotifySettings`, `normalizeSettings`, `writeNotifySettings`):
//! `<root>/notify.json`, owner-only (it holds the Telegram bot token). Rust is its only writer in board mode: the
//! satellite (Settings' Telegram parts until P1c) sends the settings it worked out through `/api/internal/notify-write`.

use std::path::Path;
use std::sync::LazyLock;

use ckanban_core::datafile;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::runs::js::{head16, trim};

pub const NOTIFY_KINDS: [&str; 10] = ["stalled", "questions", "proposal", "review", "failed", "limit", "blocked", "huddle", "reply", "message"];
/// The built-in channels in fallback order (`new Channels([mac, webhook, push, telegram])`).
pub const CHANNEL_NAMES: [&str; 4] = ["mac", "webhook", "push", "telegram"];

pub static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]{5,15}:[A-Za-z0-9_-]{30,60}$").expect("token"));
static DESK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").expect("desk"));

pub fn default_notify() -> Value {
    json!({
        "webhookUrl": "", "format": "auto", "mac": true,
        "kinds": { "stalled": true, "questions": true, "proposal": true, "review": true, "failed": true, "limit": true, "blocked": true, "huddle": true, "reply": false, "message": true },
        "helper": true, "push": true, "webhookOn": true,
        "telegram": { "on": false, "token": "", "chatId": null, "chatName": null, "pairedAt": null, "askTyped": true, "takeMessages": true, "lockedAt": null, "frontDesk": null, "briefedAt": null, "deskCapUsd": 2 },
    })
}

/// `normalizeSettings(raw, DEFAULT_NOTIFY, true)`: Err on a webhook URL that isn't http(s).
pub fn normalize_from_file(raw: &Value) -> Result<Value, String> {
    let mut out = default_notify();
    let Some(r) = raw.as_object() else { return Ok(out) };
    let o = out.as_object_mut().expect("object");
    if let Some(Value::String(u)) = r.get("webhookUrl") {
        let u = trim(u).to_string();
        if !u.is_empty() {
            let parsed = url::Url::parse(&u).map_err(|_| "webhook URL is not a valid URL".to_string())?;
            if parsed.scheme() != "https" && parsed.scheme() != "http" {
                return Err("webhook URL must start with https:// or http://".into());
            }
        }
        o.insert("webhookUrl".into(), u.into());
    }
    if let Some(f @ ("auto" | "ntfy" | "json")) = r.get("format").and_then(Value::as_str) {
        o.insert("format".into(), f.into());
    }
    for k in ["mac", "helper", "push", "webhookOn"] {
        if let Some(b) = r.get(k).and_then(Value::as_bool) {
            o.insert(k.into(), b.into());
        }
    }
    if let Some(tg) = r.get("telegram").filter(|t| t.is_object() || t.is_array()) {
        let t = o.get_mut("telegram").and_then(Value::as_object_mut).expect("telegram");
        for k in ["on", "askTyped", "takeMessages"] {
            if let Some(b) = tg.get(k).and_then(Value::as_bool) {
                t.insert(k.into(), b.into());
            }
        }
        if let Some(c) = tg.get("deskCapUsd").and_then(Value::as_f64).filter(|c| c.is_finite() && *c >= 0.0) {
            t.insert("deskCapUsd".into(), ckanban_core::jsnum::num(100f64.min(crate::helper::decide::js_round(c * 100.0) / 100.0)));
        }
        match tg.get("frontDesk") {
            Some(Value::Null) => {
                t.insert("frontDesk".into(), Value::Null);
            }
            Some(Value::String(d)) if DESK_RE.is_match(d) => {
                t.insert("frontDesk".into(), d.clone().into());
            }
            _ => {}
        }
        if let Some(Value::String(tok)) = tg.get("token") {
            t.insert("token".into(), trim(tok).into());
        }
        if let Some(id) = tg.get("chatId").and_then(Value::as_f64).filter(|x| x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0) {
            t.insert("chatId".into(), ckanban_core::jsnum::num(id));
        }
        if let Some(Value::String(n)) = tg.get("chatName") {
            t.insert("chatName".into(), head16(n, 120).into());
        }
        for k in ["pairedAt", "lockedAt", "briefedAt"] {
            if let Some(Value::String(v)) = tg.get(k) {
                t.insert(k.into(), v.clone().into());
            }
        }
    }
    if let Some(kinds) = r.get("kinds").filter(|k| k.is_object() || k.is_array()) {
        let ko = o.get_mut("kinds").and_then(Value::as_object_mut).expect("kinds");
        for k in NOTIFY_KINDS {
            if let Some(b) = kinds.get(k).and_then(Value::as_bool) {
                ko.insert(k.into(), b.into());
            }
        }
    }
    Ok(out)
}

/// Held around every read-merge-write of notify.json (the satellite's Settings, Telegram's pairing, /lock, briefing),
/// so one write never undoes another.
pub static WRITE: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// `readNotifySettings`: defaults for anything missing or invalid.
pub fn read_notify(root: &Path) -> Value {
    match std::fs::read_to_string(root.join("notify.json")).ok().and_then(|t| crate::runs::js::parse(&t)) {
        Some(v) => normalize_from_file(&v).unwrap_or_else(|_| default_notify()),
        None => default_notify(),
    }
}

/// `writeNotifySettings` (pretty, fixed `.tmp`, 0600).
pub fn write_notify(root: &Path, s: &Value) -> std::io::Result<()> {
    let _ = std::fs::remove_file(root.join("notify.json.tmp"));
    datafile::write_json(&root.join("notify.json"), s, datafile::formats::NOTIFY)
}

fn b(s: &Value, k: &str) -> bool {
    s.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// The helper is on (`settings.helper`).
pub fn helper_on(s: &Value) -> bool {
    b(s, "helper")
}

pub fn kind_on(s: &Value, kind: &str) -> bool {
    s.get("kinds").and_then(|k| k.get(kind)).and_then(Value::as_bool).unwrap_or(false)
}

/// A channel is on and set up (`Channel.enabled`). Phone push counts as there: the satellite always has its push service.
pub fn channel_enabled(s: &Value, name: &str) -> bool {
    match name {
        "mac" => b(s, "mac"),
        "push" => b(s, "push"),
        "webhook" => s.get("webhookUrl").and_then(Value::as_str).is_some_and(|u| !u.is_empty()) && b(s, "webhookOn"),
        "telegram" => {
            let t = s.get("telegram");
            t.is_some_and(|t| b(t, "on"))
                && t.and_then(|t| t.get("token")).and_then(Value::as_str).is_some_and(|tok| TOKEN_RE.is_match(tok))
                && t.and_then(|t| t.get("chatId")).is_some_and(|c| !c.is_null())
        }
        _ => false,
    }
}

/// Channels that are on, in order.
pub fn enabled(s: &Value) -> Vec<String> {
    CHANNEL_NAMES.iter().filter(|c| channel_enabled(s, c)).map(|c| c.to_string()).collect()
}

/// `telegramTakes`: Telegram gets only urgent sends, the test and the night question.
pub fn telegram_takes(m: &Map<String, Value>) -> bool {
    crate::runs::js::truthy(m.get("urgent")) || m.get("level").and_then(Value::as_str) == Some("test") || crate::runs::js::truthy(m.get("nightAsk"))
}
