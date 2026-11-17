//! Notification settings and the test sends in Rust (P1b, from `src/helper/notify.ts` `Notifier.state`, `update`,
//! `test`, `testDevice`). Rust owns notify.json and push.json; what only Telegram's bot knows (its status, a pairing,
//! what Telegram cost today) comes from the satellite until P1c (`telegram-state`, `telegram-pair`,
//! `telegram-unpair`), and a settings change that touches Telegram is told to it (`notify-changed`).

use std::sync::Arc;

use base64::Engine;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::channels::{Channels, push_payload};
use super::core::{HelperCore, OutBody};
use super::messages::NewMessage;
use super::notify_settings::{helper_on, is_ntfy, mask_token, normalize, read_notify, write_notify};
use super::push::SendTo;
use crate::runs::js::truthy;

/// Shown with the ntfy topic box.
pub const NTFY_WARNING: &str = "Anyone who knows the topic name can read these messages. Use a long random name like the suggested one and don't share it.";
/// Focus mode on the phone, in plain words.
pub const FOCUS_HINT: &str = "Focus mode on your phone can hold notifications back. ntfy can get through Focus if you allow the ntfy app in that Focus. For Telegram, allow Telegram in your Focus (not guaranteed). Phone push from the board can't get through Focus.";
/// The status line until a phone channel works.
pub const MAC_ONLY_LINE: &str = "I can only reach you on this Mac";
/// What phone access gets for turning Telegram messages back on: only the Mac may undo /lock or Pause.
pub const TG_ON_FROM_MAC: &str = "Turn this back on from the Mac.";
/// What phone access gets for pairing Telegram or giving it a new bot key.
pub const TG_PAIR_FROM_MAC: &str = "Pair Telegram from the Mac.";
/// The test button's text.
const TEST_TEXT: &str = "Test notification from ckanban: if you can read this, this channel works.";

/// What only the satellite's Telegram knows, and what it does on a settings change (P1c moves it here).
pub trait TelegramSide: Send + Sync {
    fn call(&self, name: &str, body: Value) -> BoxFuture<'static, Result<(u16, Value), String>>;
}

/// No satellite (tests): every call fails.
pub struct NoTelegram;

impl TelegramSide for NoTelegram {
    fn call(&self, _: &str, _: Value) -> BoxFuture<'static, Result<(u16, Value), String>> {
        Box::pin(async { Err("the satellite isn't running".to_string()) })
    }
}

pub type Answer = Result<Value, (u16, String)>;

pub struct Notify {
    pub core: Arc<HelperCore>,
    pub channels: Arc<Channels>,
    telegram: Arc<dyn TelegramSide>,
    /// A random ntfy topic address to offer (the same for this start).
    ntfy_topic: String,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Telegram takes messages: on, not paused, paired.
fn taking(t: &Value) -> bool {
    b(t, "on") && b(t, "takeMessages") && t.get("chatId").is_some_and(|c| !c.is_null())
}

/// `firstError`: the first error worth showing (not the Mac banner, not "no phone turned push on").
pub fn first_error(results: &[Value]) -> Value {
    results
        .iter()
        .find(|r| s(r, "channel") != "mac" && !truthy(r.get("empty")) && truthy(r.get("error")))
        .and_then(|r| r.get("error").cloned())
        .unwrap_or(Value::Null)
}

impl Notify {
    pub fn new(core: Arc<HelperCore>, channels: Arc<Channels>, telegram: Arc<dyn TelegramSide>) -> Arc<Self> {
        let mut raw = [0u8; 12];
        let _ = getrandom::fill(&mut raw);
        let topic = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw).replace(['-', '_'], "x");
        Arc::new(Notify { core, channels, telegram, ntfy_topic: format!("https://ntfy.sh/ckanban-{topic}") })
    }

    fn base_url(&self) -> String {
        self.core.board.base_url()
    }

    /// Telegram as the settings API shows it (never the token): from the satellite's bot, or, when it can't be asked,
    /// what the settings say with the status "error".
    async fn telegram_public(&self, settings: &Value) -> Value {
        if let Ok((200, v)) = self.telegram.call("telegram-state", json!({})).await
            && v.get("telegram").is_some_and(Value::is_object)
        {
            return v["telegram"].clone();
        }
        let t = settings.get("telegram").cloned().unwrap_or(Value::Null);
        let token = s(&t, "token");
        // TelegramBot.state(): no token first, then off; "error" here as the bot can't be asked.
        let status = if token.is_empty() { "no-token" } else if !b(&t, "on") { "off" } else { "error" };
        let boards: Vec<Value> = self.core.board.profiles().into_iter().map(|(slug, name)| json!({ "slug": slug, "name": name })).collect();
        json!({
            "on": b(&t, "on"), "tokenSet": !token.is_empty(), "tokenMasked": mask_token(token), "paired": t.get("chatId").is_some_and(|c| !c.is_null()),
            "chatName": t.get("chatName"), "pairedAt": t.get("pairedAt"), "status": status,
            "error": if status == "error" { Value::from("Telegram can't be reached right now; try again in a minute.") } else { Value::Null },
            "botName": null, "pairing": null, "pairError": null, "askTyped": t.get("askTyped"), "takeMessages": t.get("takeMessages"), "lockedAt": t.get("lockedAt"),
            "spentToday": 0, "deskCapUsd": t.get("deskCapUsd"), "deskSpentToday": 0, "frontDesk": t.get("frontDesk"), "boards": boards,
        })
    }

    /// The settings API's view (`state()` plus `local`): the Telegram token masked, each channel's state, the hints.
    pub async fn state(&self, local: bool) -> Value {
        let settings = read_notify(&self.core.root);
        let telegram = self.telegram_public(&settings).await;
        let push = self.channels.push.clone();
        let (mac_browser, phones) = tokio::task::spawn_blocking(move || (push.has_this_mac(), push.phone_count())).await.unwrap_or((false, 0));
        let t = settings.get("telegram").cloned().unwrap_or(Value::Null);
        let url = s(&settings, "webhookUrl");
        let ntfy = is_ntfy(&settings);
        let chat = t.get("chatName").and_then(Value::as_str).unwrap_or("your chat");
        let tg_detail: Value = if s(&t, "token").is_empty() {
            "Not set up: make a bot with BotFather and paste its token.".into()
        } else if !b(&telegram, "paired") {
            "Not paired yet: send the pairing code to your bot.".into()
        } else if let Some(e) = telegram.get("error").filter(|e| !e.is_null()) {
            e.clone()
        } else if b(&t, "takeMessages") {
            format!("Paired with {chat}.").into()
        } else {
            let why = if truthy(t.get("lockedAt")) { "Locked from Telegram" } else { "Paused" };
            format!("Paired with {chat}. {why}: not taking messages; alerts still arrive.").into()
        };
        let channels = vec![
            json!({ "name": "mac", "label": "This Mac", "on": b(&settings, "mac"), "ready": true,
                "detail": if mac_browser { "Notifications in this Mac's browser; a click opens the message." } else { "A Mac banner that says: See Messages on the board." } }),
            json!({ "name": "push", "label": "Phone push", "on": b(&settings, "push"), "ready": phones > 0,
                "detail": match phones {
                    0 => "No phone has notifications turned on yet (needs phone access).".to_string(),
                    1 => "1 phone or browser get notifications; a tap opens the message.".to_string(),
                    n => format!("{n} phones or browsers get notifications; a tap opens the message."),
                } }),
            json!({ "name": "webhook", "label": if ntfy || url.is_empty() { "ntfy" } else { "Web address (JSON)" }, "on": b(&settings, "webhookOn"), "ready": !url.is_empty(),
                "detail": if url.is_empty() { "Not set up: add an ntfy topic address." } else if ntfy { "The ntfy app shows the full message; urgent ones at top priority." } else { "The board posts each message to this address." } }),
            json!({ "name": "telegram", "label": "Telegram", "on": b(&t, "on"), "ready": b(&telegram, "tokenSet") && b(&telegram, "paired") && s(&telegram, "status") != "error", "detail": tg_detail }),
        ];
        let phone_ready = channels.iter().any(|c| s(c, "name") != "mac" && b(c, "on") && b(c, "ready"));
        let last = self.channels.last();
        let mut out: Map<String, Value> = settings.as_object().cloned().unwrap_or_default();
        out.shift_remove("telegram");
        out.insert("telegram".into(), telegram);
        out.insert("channels".into(), Value::Array(channels));
        out.insert("phoneReady".into(), phone_ready.into());
        out.insert("reachLine".into(), if phone_ready { Value::Null } else { MAC_ONLY_LINE.into() });
        out.insert("ntfyTopicSuggestion".into(), self.ntfy_topic.clone().into());
        out.insert("ntfyWarning".into(), NTFY_WARNING.into());
        out.insert("focusHint".into(), FOCUS_HINT.into());
        out.insert("lastSentAt".into(), last.sent_at.into());
        out.insert("lastError".into(), last.error.into());
        out.insert("macBrowser".into(), mac_browser.into());
        out.insert("local".into(), local.into());
        Value::Object(out)
    }

    /// Saves a settings change (`update`). From phone access, anything that turns Telegram messages back on, or sets
    /// a new bot key, is refused (403), so a lost phone with board access can't undo /lock or Pause.
    pub async fn update(&self, patch: &Value, local: bool) -> Answer {
        let (before, next) = {
            let _g = self.core.notify_write.lock();
            let before = read_notify(&self.core.root);
            let next = normalize(patch, &before, false).map_err(|e| (400, e))?;
            let desk = s(&next["telegram"], "frontDesk");
            if !desk.is_empty() && Some(desk) != before["telegram"].get("frontDesk").and_then(Value::as_str) && !self.core.board.has_profile(desk) {
                return Err((400, format!("board {desk} not found")));
            }
            if !local {
                let tok = s(&next["telegram"], "token");
                if !tok.is_empty() && tok != s(&before["telegram"], "token") {
                    return Err((403, TG_PAIR_FROM_MAC.into()));
                }
                if (b(&next["telegram"], "takeMessages") && !b(&before["telegram"], "takeMessages")) || (taking(&next["telegram"]) && !taking(&before["telegram"])) {
                    return Err((403, TG_ON_FROM_MAC.into()));
                }
            }
            write_notify(&self.core.root, &next).map_err(|e| (503, format!("The settings couldn't be saved: {e}")))?;
            (before, next)
        };
        if helper_on(&before) != helper_on(&next) {
            let (core, on) = (self.core.clone(), helper_on(&next));
            tokio::spawn(async move { core.switched(on).await });
        }
        // The satellite's bot: a new token starts over; stopped taking messages drops what Telegram left waiting.
        let changed = json!({
            "tokenChanged": s(&before["telegram"], "token") != s(&next["telegram"], "token"),
            "stoppedTaking": taking(&before["telegram"]) && !taking(&next["telegram"]),
        });
        // In the background: Settings answers without waiting for the satellite.
        let tg = self.telegram.clone();
        tokio::spawn(async move {
            match tg.call("notify-changed", changed).await {
                Ok((200, _)) => {}
                Ok((status, v)) => eprintln!("notify: the satellite's notify-changed: {status} {}", s(&v, "error")),
                Err(e) => eprintln!("notify: the satellite's notify-changed: {e}"),
            }
        });
        Ok(self.state(local).await)
    }

    /// The sample message (`testMessage`): the board asked for, or the first one.
    fn test_message(&self, slug: Option<&str>) -> Value {
        let p = match slug {
            Some(s) => self.core.board.has_profile(s).then(|| (s.to_string(), self.core.board.board_name(s))),
            None => self.core.board.profiles().into_iter().next(),
        };
        let url = match &p {
            Some((slug, _)) => self.core.link(slug, None),
            None => format!("{}/", self.base_url()),
        };
        json!({
            "board": p.as_ref().map(|x| x.0.clone()).unwrap_or_default(), "boardName": p.as_ref().map(|x| x.1.clone()).unwrap_or_else(|| "ckanban".into()),
            "ticketId": "", "title": "Test notification", "kind": "review", "label": "ckanban", "url": url,
        })
    }

    /// The "Send test notification" button: a sample message through every channel that is on (the board is on
    /// screen there, so the visible skip doesn't apply), stored as a "test" message.
    pub async fn test(&self, slug: Option<&str>, local: bool) -> Value {
        let settings = read_notify(&self.core.root);
        let m = self.test_message(slug);
        let (title, label, board_name) = (s(&m, "title").to_string(), s(&m, "label").to_string(), s(&m, "boardName").to_string());
        let nm = NewMessage::new("test", format!("{label}: {title}"), format!("{title} ({board_name})\n\n{TEST_TEXT}"));
        let out = OutBody::new("test", &title, &label, TEST_TEXT, Some(s(&m, "url").to_string())).with("notify", m.clone()).with("everyDevice", true);
        let (_, results) = self.core.send(nm, out, None).await;
        let error = first_error(&results);
        let push = self.channels.push.clone();
        let devices = tokio::task::spawn_blocking(move || push.devices().len()).await.unwrap_or(0);
        json!({
            "ok": error.is_null(), "error": error, "webhook": !s(&settings, "webhookUrl").is_empty(), "devices": devices, "channels": results,
            "state": self.state(local).await,
        })
    }

    /// A device's own "Send test": that device only.
    pub async fn test_device(&self, id: &str, slug: Option<&str>) -> Value {
        let payload = Value::Object(push_payload(&self.test_message(slug)));
        let r = self.channels.push.send(&payload, &SendTo { only: Some(id.to_string()), ..Default::default() }).await;
        let error = r.error.or_else(|| {
            if r.removed > 0 {
                Some("this device no longer accepts notifications: turn them on again".into())
            } else if r.sent > 0 {
                None
            } else {
                Some("device not found".into())
            }
        });
        json!({ "ok": error.is_none(), "error": error })
    }

    /// Settings' "Pair": a fresh 6-digit code from the satellite's bot (it needs a token).
    pub async fn pair(&self, board: Option<&str>, local: bool) -> Answer {
        let (status, v) = self.telegram.call("telegram-pair", json!({ "board": board })).await.map_err(|e| (503, e))?;
        if status != 200 {
            return Err((status, s(&v, "error").to_string()));
        }
        Ok(json!({ "code": v.get("code"), "expiresAt": v.get("expiresAt"), "state": self.state(local).await }))
    }

    /// Settings' "Unpair": the satellite's bot forgets the chat and drops what it left waiting.
    pub async fn unpair(&self, local: bool) -> Answer {
        let (status, v) = self.telegram.call("telegram-unpair", json!({})).await.map_err(|e| (503, e))?;
        if status != 200 {
            return Err((status, s(&v, "error").to_string()));
        }
        Ok(self.state(local).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::helper::board::HelperBoard;
    use crate::helper::channels::Banner;
    use crate::helper::push::{Http, PushService};
    use crate::index::store::BoardList;
    use crate::index::ticket::Tk;
    use parking_lot::Mutex;
    use std::collections::HashSet;

    struct Board;
    impl HelperBoard for Board {
        fn ticket(&self, _: &str, _: &str) -> Option<Arc<Tk>> {
            None
        }
        fn list(&self, slug: &str) -> Arc<BoardList> {
            Arc::new(BoardList::new(slug, vec![], 0))
        }
        fn profiles(&self) -> Vec<(String, String)> {
            vec![("b".into(), "Board".into())]
        }
        fn has_profile(&self, slug: &str) -> bool {
            slug == "b"
        }
        fn board_name(&self, _: &str) -> String {
            "Board".into()
        }
        fn session(&self, _: &str) -> Option<Value> {
            None
        }
        fn running(&self, _: &str, _: &str) -> bool {
            false
        }
        fn host(&self, _: &str, _: &str) -> Option<Value> {
            None
        }
        fn schedule_ids(&self, _: &str) -> HashSet<String> {
            HashSet::new()
        }
        fn has_checkin(&self, _: &str) -> bool {
            false
        }
        fn add_comment(&self, _: &str, _: &str, _: &str) {}
        fn base_url(&self) -> String {
            "http://localhost:4000".into()
        }
    }

    type Posts = Arc<Mutex<Vec<(String, Vec<(String, String)>, String)>>>;

    /// The web address and push services: every request; never the real network.
    struct Fake(Posts);
    impl Http for Fake {
        fn post(&self, url: String, headers: Vec<(String, String)>, body: Vec<u8>) -> BoxFuture<'static, Result<(u16, String), String>> {
            self.0.lock().push((url, headers, String::from_utf8_lossy(&body).into_owned()));
            Box::pin(async { Ok((200, "OK".into())) })
        }
    }

    struct Told(Arc<Mutex<Vec<String>>>);
    impl TelegramSide for Told {
        fn call(&self, name: &str, body: Value) -> BoxFuture<'static, Result<(u16, Value), String>> {
            self.0.lock().push(format!("{name} {body}"));
            Box::pin(async { Err("no satellite".to_string()) })
        }
    }

    type Lines = Arc<Mutex<Vec<String>>>;

    fn notify(dir: &std::path::Path) -> (Arc<Notify>, Posts, Lines, Lines) {
        let now: Arc<dyn Fn() -> f64 + Send + Sync> = Arc::new(|| 1_700_000_000_000.0);
        let posts = Arc::new(Mutex::new(Vec::new()));
        let http: Arc<dyn Http> = Arc::new(Fake(posts.clone()));
        let push = PushService::new(dir, http.clone(), now.clone());
        let banners = Arc::new(Mutex::new(Vec::new()));
        let b2 = banners.clone();
        let banner: Banner = Arc::new(move |t: &str, b: &str| b2.lock().push(format!("{t} | {b}")));
        let told = Arc::new(Mutex::new(Vec::new()));
        let tg: Arc<dyn TelegramSide> = Arc::new(Told(told.clone()));
        let channels = Channels::new(dir, push, http, banner, Arc::new(|| "http://localhost:4000".to_string()), Arc::new(super::super::channels::NoSender), now.clone());
        let core = HelperCore::new(dir, Arc::new(Board), Arc::new(channels.clone()), now, None, None);
        (Notify::new(core, channels, tg), posts, banners, told)
    }

    #[tokio::test]
    async fn settings_changes_follow_bun_s_rules_and_the_phone_can_t_turn_telegram_back_on() {
        let dir = tempfile::tempdir().unwrap();
        let (n, _, _, told) = notify(dir.path());
        let v = n.state(true).await;
        assert_eq!(v["reachLine"], MAC_ONLY_LINE);
        assert_eq!(v["telegram"]["status"], "no-token");
        assert_eq!(v["channels"][1]["detail"], "No phone has notifications turned on yet (needs phone access).");
        assert!(v["ntfyTopicSuggestion"].as_str().unwrap().starts_with("https://ntfy.sh/ckanban-"));
        assert_eq!(v["local"], true);
        assert_eq!(n.update(&json!({ "webhookUrl": "ftp://x" }), true).await.unwrap_err(), (400, "webhook URL must start with https:// or http://".to_string()));
        assert_eq!(n.update(&json!({ "telegram": { "frontDesk": "nope" } }), true).await.unwrap_err(), (400, "board nope not found".to_string()));
        let tok = "123456789:AAHfakeFAKEfakeFAKEfakeFAKEfake_1234";
        assert_eq!(n.update(&json!({ "telegram": { "token": tok } }), false).await.unwrap_err(), (403, TG_PAIR_FROM_MAC.to_string()));
        assert!(!dir.path().join("notify.json").exists());
        let v = n.update(&json!({ "webhookUrl": "https://ntfy.sh/abc", "telegram": { "token": tok, "on": true } }), true).await.unwrap();
        assert_eq!((v["webhookUrl"].as_str(), v["telegram"]["tokenMasked"].as_str(), v["channels"][2]["label"].as_str()), (Some("https://ntfy.sh/abc"), Some("set …1234"), Some("ntfy")));
        assert!(!v.to_string().contains(tok));
        tokio::task::yield_now().await;
        assert!(told.lock().iter().any(|t| t == r#"notify-changed {"tokenChanged":true,"stoppedTaking":false}"#));
        // Paused from the Mac; the phone can't turn it back on.
        let saved = read_notify(dir.path());
        let mut paired = saved.clone();
        paired["telegram"]["chatId"] = 5.into();
        paired["telegram"]["takeMessages"] = false.into();
        write_notify(dir.path(), &paired).unwrap();
        assert_eq!(n.update(&json!({ "telegram": { "takeMessages": true } }), false).await.unwrap_err(), (403, TG_ON_FROM_MAC.to_string()));
        assert!(n.update(&json!({ "telegram": { "takeMessages": true } }), true).await.is_ok());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.path().join("notify.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[tokio::test]
    async fn the_test_send_goes_to_the_banner_and_the_web_address_and_is_stored() {
        let dir = tempfile::tempdir().unwrap();
        let (n, posts, banners, _) = notify(dir.path());
        n.update(&json!({ "webhookUrl": "http://127.0.0.1:9/hook", "format": "json", "push": false }), true).await.unwrap();
        let r = n.test(None, true).await;
        assert_eq!((r["ok"].as_bool(), r["webhook"].as_bool(), r["devices"].as_u64()), (Some(true), Some(true), Some(0)));
        assert_eq!(*banners.lock(), ["ckanban: Test notification | Board · See Messages on the board"]);
        let p = posts.lock()[0].clone();
        assert_eq!(p.2, r#"{"board":"b","boardName":"Board","ticketId":"","title":"Test notification","kind":"review","label":"ckanban","url":"http://localhost:4000/#/b"}"#);
        assert!(r["state"]["lastSentAt"].is_string());
        let stored = n.core.lock().messages.list_newest(true);
        assert_eq!(stored.len(), 1);
        assert_eq!(n.test_device("nope", None).await, json!({ "ok": false, "error": "device not found" }));
    }
}
