//! The bot (`TelegramBot` and the Telegram half of `Notifier`): one getUpdates long poll while the channel is on and
//! paired or a pairing goes on; updates saved before the read position moves on, handled messages one at a time in
//! order and taps at once; pairing with a 6-digit code; `/lock`, `/waiting`; the channel's send; the briefing.

use std::time::Duration;

use serde_json::{Map, Value, json};

use super::api::{Reply, explain};
use super::replies::Incoming;
use super::stores::LinkItem;
use super::text::{self, LOCKED, LOCKED_NOTE, NOT_TAKING, SEND_AGAIN, TEXT_ONLY, scrub, telegram_text};
use super::{Out, Pairing, Rows, Say, Status, Telegram, b, chat_of, s};
use crate::helper::notify_settings::TOKEN_RE;
use crate::runs::js;
use ckanban_core::time::iso;

/// Telegram allows about one message a second in one chat: form messages and their edits are spaced this far.
pub const PACE_MS: f64 = 1000.0;
/// Long-poll length (seconds).
pub const POLL_TIMEOUT_S: u64 = 50;
/// A pairing code is good for this long.
pub const PAIR_MS: f64 = 10.0 * 60_000.0;
/// Wrong codes allowed during one pairing before it is cancelled.
pub const PAIR_TRIES: u32 = 10;
/// Longest wait on a 429 before trying once more.
pub const RETRY_AFTER_MAX_S: f64 = 30.0;
/// The note while locked from Telegram goes at most this often.
pub const LOCKED_NOTE_MS: f64 = 10.0 * 60_000.0;

/// The bot's command menu.
fn commands() -> Value {
    json!([
        { "command": "waiting", "description": "What waits on you now" },
        { "command": "lock", "description": "Stop taking messages from this chat (alerts still arrive)" },
    ])
}

/// The night question's buttons.
pub fn night_buttons(message_id: &str) -> Value {
    json!([[{ "text": "Yes", "callback_data": format!("y:{message_id}") }, { "text": "Not at night", "callback_data": format!("x:{message_id}") }]])
}

/// `inline_keyboard` of the router's buttons: url buttons only for https links, data buttons only with data.
pub fn markup(rows: &Rows) -> Value {
    let out: Vec<Value> = rows
        .iter()
        .map(|row| {
            row.iter()
                .filter(|b| match &b.url {
                    Some(u) => u.starts_with("https://"),
                    None => b.data.as_deref().is_some_and(|d| !d.is_empty()),
                })
                .map(|b| match &b.url {
                    Some(u) => json!({ "text": b.text, "url": u }),
                    None => json!({ "text": b.text, "callback_data": b.data }),
                })
                .collect::<Vec<_>>()
        })
        .filter(|r| !r.is_empty())
        .map(Value::Array)
        .collect();
    json!({ "inline_keyboard": out })
}

fn safe_i64(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

impl Out {
    async fn call(&self, method: &str, body: Value) -> Reply {
        if self.paced { self.tg.paced(method, body).await } else { self.tg.api(method, body).await }
    }

    /// `say`: Telegram's message id, or None when it failed.
    pub async fn say(&self, text: &str, o: Say) -> Option<i64> {
        let kb = markup(&o.buttons);
        let mut body = Map::new();
        body.insert("chat_id".into(), self.chat_id.into());
        body.insert("text".into(), telegram_text(text, "").into());
        body.insert("disable_notification".into(), true.into());
        body.insert("disable_web_page_preview".into(), true.into());
        if let Some(r) = o.reply_to {
            body.insert("reply_parameters".into(), json!({ "message_id": r, "allow_sending_without_reply": true }));
        }
        if let Some(f) = &o.force_reply {
            body.insert("reply_markup".into(), json!({ "force_reply": true, "input_field_placeholder": js::head16(f, 64) }));
        } else if kb["inline_keyboard"].as_array().is_some_and(|a| !a.is_empty()) {
            body.insert("reply_markup".into(), kb);
        }
        let r = self.call("sendMessage", Value::Object(body)).await;
        if !r.ok {
            eprintln!("telegram: reply failed: {}", explain(&r));
            return None;
        }
        let tg = r.message_id()?;
        if !o.link.is_empty() {
            self.tg.links.add(&self.tg.bot_id(), tg, self.chat_id, None, o.level.as_deref().unwrap_or("report"), &o.link, self.tg.now());
        }
        Some(tg)
    }

    /// `edit`: a message's text and buttons (none: the buttons go).
    pub async fn edit(&self, message_id: i64, text: &str, buttons: Option<Rows>) {
        let body = json!({
            "chat_id": self.chat_id, "message_id": message_id, "text": telegram_text(text, ""), "disable_web_page_preview": true,
            "reply_markup": markup(&buttons.unwrap_or_default()),
        });
        let r = self.call("editMessageText", body).await;
        if !r.ok {
            eprintln!("telegram: edit failed: {}", explain(&r));
        }
    }
}

impl Telegram {
    /// Listen while the channel is on and paired, or while a pairing goes on (`wanted`).
    pub fn wanted(&self) -> bool {
        let t = self.tg_settings();
        if !TOKEN_RE.is_match(s(&t, "token")) {
            return false;
        }
        let pairing = self.bot.lock().pairing.as_ref().is_some_and(|p| p.expires_at > self.now());
        pairing || (b(&t, "on") && chat_of(&t).is_some())
    }

    /// The settings API's view of the bot (`state()`): never the pairing code.
    pub fn state(&self) -> Value {
        let now = self.now();
        let t = self.tg_settings();
        let wanted = self.wanted();
        let st = self.bot.lock();
        let state = if s(&t, "token").is_empty() {
            "no-token".to_string()
        } else if !wanted {
            "off".into()
        } else if st.status.state == "off" {
            "connecting".into()
        } else {
            st.status.state.clone()
        };
        let pairing = st.pairing.as_ref().filter(|p| p.expires_at > now).map(|p| json!({ "expiresAt": iso(p.expires_at) }));
        json!({ "state": state, "error": st.status.error, "botName": st.status.bot_name, "pairing": pairing, "pairError": st.pair_error })
    }

    /// Settings changed (or start-up): start or stop the one poller.
    pub fn refresh(&self) {
        if !self.wanted() {
            self.stop();
            return;
        }
        if self.bot.lock().polling || !self.auto_poll {
            return;
        }
        let me = self.arc();
        tokio::spawn(async move { me.poll_loop().await });
    }

    /// Stops the poller.
    pub fn stop(&self) {
        let mut st = self.bot.lock();
        st.generation += 1;
        if let Some(a) = st.abort.take() {
            let _ = a.send(true);
        }
        st.polling = false;
        st.status.state = "off".into();
        st.status.error = None;
    }

    /// The token changed: what Telegram said about the old one no longer holds.
    pub fn reset(&self) {
        self.stop();
        let mut st = self.bot.lock();
        st.status = Status { state: "off".into(), error: None, bot_name: None };
        st.offset = 0;
        st.offset_loaded = false;
    }

    fn offset_file(&self) -> std::path::PathBuf {
        self.root.join("telegram-offset.json")
    }

    fn load_offset(&self) {
        let mut st = self.bot.lock();
        if st.offset_loaded {
            return;
        }
        st.offset_loaded = true;
        let Some(v) = std::fs::read_to_string(self.offset_file()).ok().and_then(|t| js::parse(&t)) else { return };
        if v.get("bot").and_then(Value::as_str) == Some(self.bot_id().as_str())
            && let Some(o) = safe_i64(v.get("offset"))
        {
            st.offset = st.offset.max(o);
        }
    }

    fn save_offset(&self, offset: i64) {
        let f = self.offset_file();
        let tmp = std::path::PathBuf::from(format!("{}.tmp", f.display()));
        let text = format!("{}\n", js::stringify(&json!({ "bot": self.bot_id(), "offset": offset })));
        if let Err(e) = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &f)) {
            eprintln!("telegram: couldn't save the read position: {e}");
        }
    }

    async fn poll_loop(self: std::sync::Arc<Self>) {
        let generation = {
            let mut st = self.bot.lock();
            st.generation += 1;
            st.polling = true;
            st.generation
        };
        let mut backoff = 5000u64;
        while self.bot.lock().generation == generation && self.wanted() {
            let ok = self.poll_once(generation).await;
            if self.bot.lock().generation != generation {
                return;
            }
            if ok {
                backoff = 5000;
            } else {
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                backoff = (backoff * 2).min(60_000);
            }
        }
        let mut st = self.bot.lock();
        if st.generation == generation {
            st.polling = false;
        }
    }

    fn fail(&self, r: &Reply) {
        let error = explain(r);
        let mut st = self.bot.lock();
        if st.status.error.as_deref() != Some(error.as_str()) {
            eprintln!("telegram: {error}");
        }
        st.status.state = "error".into();
        st.status.error = Some(error);
    }

    /// One getUpdates round (getMe first while the bot's name is unknown). False on an error.
    pub async fn poll_once(&self, generation: u64) -> bool {
        let token = self.token();
        let need_me = {
            let mut st = self.bot.lock();
            if st.status.state == "off" {
                st.status.state = "connecting".into();
            }
            st.status.bot_name.is_none()
        };
        if need_me {
            let me = self.api_with(&token, "getMe", &json!({}), None).await;
            if self.bot.lock().generation != generation {
                return true;
            }
            if !me.ok {
                self.fail(&me);
                return false;
            }
            let name = me.result.get("username").and_then(Value::as_str).filter(|u| !u.is_empty()).map(|u| format!("@{u}"));
            self.bot.lock().status.bot_name = name;
        }
        // The menu of commands, once per bot.
        let bid = text::bot_id(&token);
        let set_menu = {
            let mut st = self.bot.lock();
            let want = st.commands_for.as_deref() != Some(bid.as_str()) && self.chat_id().is_some();
            if want {
                st.commands_for = Some(bid.clone());
            }
            want
        };
        if set_menu {
            let me = self.arc();
            let tok = token.clone();
            tokio::spawn(async move {
                let r = me.api_with(&tok, "setMyCommands", &json!({ "commands": commands() }), None).await;
                if !r.ok {
                    eprintln!("telegram: couldn't set the command menu: {}", explain(&r));
                }
            });
        }
        self.load_offset();
        // Updates saved before a restart and not handled yet.
        self.drain();
        let (tx, rx) = tokio::sync::watch::channel(false);
        let offset = {
            let mut st = self.bot.lock();
            st.abort = Some(tx);
            st.offset
        };
        let timeout = if self.auto_poll { POLL_TIMEOUT_S } else { 0 };
        let body = json!({ "offset": offset, "timeout": timeout, "allowed_updates": ["message", "edited_message", "callback_query"] });
        let r = self.api_with(&token, "getUpdates", &body, Some(rx)).await;
        if self.bot.lock().generation != generation {
            return true;
        }
        if !r.ok {
            self.fail(&r);
            return false;
        }
        {
            let mut st = self.bot.lock();
            st.status.state = "ok".into();
            st.status.error = None;
        }
        let updates: Vec<Value> = r.result.as_array().cloned().unwrap_or_default();
        // Saved first, then the position moves on.
        if let Err(e) = self.queue.add(&bid, &updates) {
            eprintln!("telegram: couldn't save incoming messages, reading them again: {e}");
            return false;
        }
        let (before, after) = {
            let mut st = self.bot.lock();
            let before = st.offset;
            for u in &updates {
                if let Some(id) = safe_i64(u.get("update_id")) {
                    st.offset = st.offset.max(id + 1);
                }
            }
            (before, st.offset)
        };
        if after != before {
            self.save_offset(after);
        }
        self.drain();
        if !self.auto_poll {
            self.idle().await;
        }
        true
    }

    /// Starts handling what waits in the queue: messages in order, one at a time; taps and /lock at once.
    pub fn drain(&self) {
        let bid = self.bot_id();
        for u in self.queue.pending(&bid) {
            let Some(id) = safe_i64(u.get("update_id")) else { continue };
            if !self.in_flight.lock().insert(id) {
                continue;
            }
            let tap = u.get("callback_query").is_some_and(|c| !c.is_null()) || text::is_lock(u.get("message").and_then(|m| m.get("text")));
            if tap {
                let me = self.arc();
                self.track(async move { me.run_update(u, id).await });
            } else {
                let tx = self.msg_tx.get_or_init(|| {
                    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
                    let me = self.arc();
                    tokio::spawn(async move {
                        while let Some(u) = rx.recv().await {
                            let id = safe_i64(u.get("update_id")).unwrap_or(0);
                            me.run_update(u, id).await;
                        }
                    });
                    tx
                });
                let _ = tx.send(u);
            }
        }
    }

    async fn run_update(&self, u: Value, id: i64) {
        let me = self.arc();
        // A panic in one update never stops the line behind it.
        let r = tokio::spawn(async move { me.handle(u).await }).await;
        if let Err(e) = r {
            eprintln!("telegram: update {id}: {}", scrub(&e.to_string(), &self.token()));
        }
        self.queue.done(&self.bot_id(), id);
        self.in_flight.lock().remove(&id);
    }

    /// A paced Bot API call (forms): at least `pace_ms` after the last one; a 429 waits `retry_after` and tries
    /// again, twice at most.
    pub async fn paced(&self, method: &str, body: Value) -> Reply {
        let mut last = self.pace.lock().await;
        let gap = *last + self.pace_ms - self.now();
        if gap > 0.0 {
            tokio::time::sleep(Duration::from_millis(gap as u64)).await;
        }
        let mut r = self.api(method, body.clone()).await;
        for _ in 0..2 {
            if r.ok || r.error_code != Some(429) {
                break;
            }
            let wait = r.retry_after.unwrap_or(1.0);
            if wait > RETRY_AFTER_MAX_S {
                break;
            }
            tokio::time::sleep(Duration::from_millis((wait * 1000.0) as u64)).await;
            r = self.api(method, body.clone()).await;
        }
        *last = self.now();
        r
    }

    /// `startPairing`: a fresh 6-digit code for 10 minutes; the poller runs meanwhile.
    pub fn start_pairing(&self) -> Result<(String, String), String> {
        if !TOKEN_RE.is_match(&self.token()) {
            return Err("Add the bot token from BotFather first.".into());
        }
        let now = self.now();
        let mut raw = [0u8; 4];
        getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
        let code = format!("{:06}", u32::from_le_bytes(raw) % 1_000_000);
        {
            let mut st = self.bot.lock();
            st.pairing = Some(Pairing { code: code.clone(), started_at: now, expires_at: now + PAIR_MS, tries: 0 });
            st.pair_error = None;
        }
        self.refresh();
        Ok((code, iso(now + PAIR_MS)))
    }

    /// `Notifier.telegramPair`: the code, and the front desk on the board paired from unless Settings chose one.
    pub fn pair(&self, board: Option<&str>) -> Result<(String, String), String> {
        let r = self.start_pairing()?;
        if let Some(bd) = board
            && self.helper.core.board.has_profile(bd)
            && !js::truthy(self.tg_settings().get("frontDesk"))
        {
            self.save(vec![("frontDesk", bd.into())]);
        }
        Ok(r)
    }

    /// `Notifier.telegramUnpair`: forget the chat, drop its open buttons and everything it left waiting.
    pub fn unpair(&self) {
        self.bot.lock().pairing = None;
        self.save(vec![("chatId", Value::Null), ("chatName", Value::Null), ("pairedAt", Value::Null)]);
        self.refresh();
        self.drop_work();
    }

    /// `dropTelegramWork`: open buttons expire, queued updates are dropped, ticket queues lose Telegram's messages.
    pub fn drop_work(&self) {
        self.pending.expire_all(self.now());
        self.queue.clear(&self.bot_id());
        self.env.drop_telegram_queued();
    }

    /// `telegramLock`: /lock from the paired chat.
    pub fn lock_now(&self) {
        self.save(vec![("takeMessages", false.into()), ("lockedAt", iso(self.now()).into())]);
        self.drop_work();
    }

    /// notify.json changed (Settings): a new bot starts over, a stop to taking messages drops what waits, and the
    /// poller starts or stops (`Notifier.update`).
    pub fn settings_changed(&self, before: &Value, after: &Value) {
        let t0 = before.get("telegram").cloned().unwrap_or(Value::Null);
        let t1 = after.get("telegram").cloned().unwrap_or(Value::Null);
        let taking = |t: &Value| b(t, "on") && b(t, "takeMessages") && chat_of(t).is_some();
        if s(&t0, "token") != s(&t1, "token") {
            self.reset();
        }
        if taking(&t0) && !taking(&t1) {
            self.drop_work();
        }
        self.refresh();
    }

    /// The bot's own answers: always silent.
    async fn reply(&self, chat_id: i64, text: &str) {
        let out = Out { tg: self.arc(), chat_id, paced: false };
        out.say(text, Say::default()).await;
    }

    /// After Got it / Not urgent: the tapped message keeps only its Open link, and a silent reply says what happened.
    async fn tapped(&self, chat_id: i64, msg: &Value, text: &str, buttons: Option<Value>) {
        let Some(message_id) = safe_i64(msg.get("message_id")) else { return };
        let keep: Vec<Value> = msg
            .get("reply_markup")
            .and_then(|m| m.get("inline_keyboard"))
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .map(|row| {
                        row.as_array()
                            .map(|r| {
                                r.iter()
                                    .filter(|b| b.get("text").is_some_and(Value::is_string) && b.get("url").and_then(Value::as_str).is_some_and(|u| u.starts_with("https://")))
                                    .map(|b| json!({ "text": b["text"], "url": b["url"] }))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    })
                    .filter(|r| !r.is_empty())
                    .map(Value::Array)
                    .collect()
            })
            .unwrap_or_default();
        let edit = self.api("editMessageReplyMarkup", json!({ "chat_id": chat_id, "message_id": message_id, "reply_markup": { "inline_keyboard": keep } })).await;
        if !edit.ok && !edit.description.as_deref().unwrap_or("").to_lowercase().contains("not modified") {
            eprintln!("telegram: couldn't update the buttons: {}", explain(&edit));
        }
        let mut body = Map::new();
        body.insert("chat_id".into(), chat_id.into());
        body.insert("text".into(), telegram_text(text, "").into());
        body.insert("disable_notification".into(), true.into());
        body.insert("disable_web_page_preview".into(), true.into());
        body.insert("reply_parameters".into(), json!({ "message_id": message_id, "allow_sending_without_reply": true }));
        if let Some(bt) = buttons.filter(|b| b.as_array().is_some_and(|a| !a.is_empty())) {
            body.insert("reply_markup".into(), json!({ "inline_keyboard": bt }));
        }
        let r = self.api("sendMessage", Value::Object(body)).await;
        if !r.ok {
            eprintln!("telegram: reply failed: {}", explain(&r));
        }
    }

    fn code_matches(&self, text: &str) -> bool {
        let st = self.bot.lock();
        let Some(p) = &st.pairing else { return false };
        let (a, b) = (text.as_bytes(), p.code.as_bytes());
        a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }

    /// A helper action (Got it, Not urgent, the night answer, /waiting): its short reply.
    fn action(&self, v: Value) -> String {
        let r = self.helper.action(&v);
        r.get("text").and_then(Value::as_str).unwrap_or("").to_string()
    }

    /// One update. Only the paired chat is acted on; a stranger only ever gets the pairing check.
    pub async fn handle(&self, u: Value) {
        let t = self.tg_settings();
        let paired = chat_of(&t);
        if let Some(cq) = u.get("callback_query").filter(|c| !c.is_null()) {
            let chat = cq.get("message").and_then(|m| m.get("chat")).and_then(|c| c.get("id")).and_then(|x| safe_i64(Some(x)));
            let from = cq.get("from").and_then(|f| f.get("id")).and_then(|x| safe_i64(Some(x)));
            let cq_id = cq.get("id").cloned().unwrap_or(Value::Null);
            let Some(chat_id) = paired.filter(|p| chat == Some(*p) && from == Some(*p)) else {
                self.api("answerCallbackQuery", json!({ "callback_query_id": cq_id, "text": "This bot isn't paired with you." })).await;
                return;
            };
            let data = cq.get("data").map(js::to_string).unwrap_or_default();
            let tap = parse_tap(&data);
            let mut text = "That button no longer works.".to_string();
            match &tap {
                Tap::Alert(k, id) => {
                    text = self.action(json!({ "action": if *k == 'g' { "got-it" } else { "not-urgent" }, "messageId": id }));
                    eprintln!("telegram: {} on {id}: {}", if *k == 'g' { "Got it" } else { "Not urgent" }, scrub(&text, &self.token()));
                }
                Tap::Night(k, id) => {
                    text = self.action(json!({ "action": "night", "messageId": id, "allow": *k == 'y' }));
                    eprintln!("telegram: night question on {id}: {}", if *k == 'y' { "yes" } else { "not at night" });
                }
                Tap::Pending(id, choice) => {
                    if t.get("takeMessages").and_then(Value::as_bool) == Some(false) {
                        text = NOT_TAKING.into();
                    } else {
                        let out = Out { tg: self.arc(), chat_id, paced: false };
                        let message_id = cq.get("message").and_then(|m| safe_i64(m.get("message_id"))).unwrap_or(0);
                        text = self.on_tap(id, choice, chat_id, message_id, &out, safe_i64(u.get("update_id"))).await;
                    }
                }
                Tap::None => {}
            }
            // Always answered, or the button keeps spinning on the phone.
            self.api("answerCallbackQuery", json!({ "callback_query_id": cq_id, "text": js::head16(&text, 200) })).await;
            let msg = cq.get("message").cloned().unwrap_or(Value::Null);
            match &tap {
                Tap::Alert(_, id) => {
                    // After Got it on a practice alert: offer the night question next.
                    let ask = self.helper.action(&json!({ "action": "night-after", "messageId": id })).get("text").and_then(Value::as_str).map(str::to_string);
                    match ask {
                        Some(a) => self.tapped(chat_id, &msg, &format!("{text}\n\n{a}"), Some(night_buttons(id))).await,
                        None => self.tapped(chat_id, &msg, &text, None).await,
                    }
                }
                Tap::Night(..) => self.tapped(chat_id, &msg, &text, None).await,
                _ => {}
            }
            return;
        }
        // An edited message: the first version was already handled.
        if let Some(edited) = u.get("edited_message").filter(|e| !e.is_null())
            && let Some(p) = paired
            && edited.get("chat").and_then(|c| safe_i64(c.get("id"))) == Some(p)
        {
            self.reply(p, SEND_AGAIN).await;
            return;
        }
        let Some(msg) = u.get("message").filter(|m| m.get("chat").is_some_and(|c| !c.is_null())) else { return };
        let Some(chat_id) = msg.get("chat").and_then(|c| c.get("id")).filter(|x| x.is_number()).and_then(|x| safe_i64(Some(x))) else { return };
        let text_raw = msg.get("text").and_then(Value::as_str).map(|t| js::trim(t).to_string()).unwrap_or_default();
        // Pairing: private chats only, messages sent after the code was shown.
        let pairing = self.bot.lock().pairing.clone();
        if let Some(p) = pairing
            && paired != Some(chat_id)
        {
            if p.expires_at <= self.now() {
                self.bot.lock().pairing = None;
            } else if msg.get("chat").and_then(|c| c.get("type")).and_then(Value::as_str) == Some("private")
                && msg.get("date").and_then(Value::as_f64).is_some_and(|d| d * 1000.0 >= p.started_at - 5000.0)
            {
                let code: String = text_raw.chars().filter(|c| !js::is_ws(*c)).collect();
                if !(code.len() == 6 && code.bytes().all(|c| c.is_ascii_digit())) {
                    self.reply(chat_id, "Send the 6-digit code shown in the board's Settings.").await;
                    return;
                }
                if self.code_matches(&code) {
                    let from = msg.get("from").filter(|f| !f.is_null()).unwrap_or(&msg["chat"]);
                    let parts: Vec<String> = [from.get("first_name"), from.get("last_name")].into_iter().filter(|x| js::truthy(*x)).map(|x| js::to_string(x.unwrap())).collect();
                    let name = if parts.is_empty() { "you".to_string() } else { parts.join(" ") };
                    let chat_name = match from.get("username").filter(|u| js::truthy(Some(*u))) {
                        Some(u) => format!("{name} (@{})", js::to_string(u)),
                        None => name,
                    };
                    self.bot.lock().pairing = None;
                    self.save(vec![
                        ("chatId", chat_id.into()),
                        ("chatName", chat_name.into()),
                        ("pairedAt", iso(self.now()).into()),
                        ("on", true.into()),
                        ("takeMessages", true.into()),
                        ("lockedAt", Value::Null),
                    ]);
                    self.reply(chat_id, &text::briefing(true)).await;
                    self.save(vec![("briefedAt", iso(self.now()).into())]);
                    return;
                }
                {
                    let mut st = self.bot.lock();
                    if let Some(pp) = st.pairing.as_mut() {
                        pp.tries += 1;
                        if pp.tries >= PAIR_TRIES {
                            st.pairing = None;
                            st.pair_error = Some("Too many wrong codes were sent to the bot, so pairing stopped. Start pairing again.".into());
                            eprintln!("telegram: pairing stopped after too many wrong codes");
                        }
                    }
                }
                self.reply(chat_id, "That code doesn't match. Check the code in the board's Settings.").await;
                return;
            }
        }
        if paired != Some(chat_id) {
            return;
        }
        let cmd = text::command(&text_raw);
        if cmd == "/lock" {
            // Saved before the answer goes out; only Settings on the Mac turns it back on.
            self.lock_now();
            self.bot.lock().locked_told_at = f64::NEG_INFINITY;
            self.reply(chat_id, LOCKED).await;
            return;
        }
        if cmd == "/waiting" {
            let w = self.action(json!({ "action": "waiting" }));
            self.reply(chat_id, &w).await;
            return;
        }
        // Read again: a /lock handled meanwhile counts for the messages behind it.
        let cur = self.tg_settings();
        if cur.get("takeMessages").and_then(Value::as_bool) == Some(false) {
            if !js::truthy(cur.get("lockedAt")) {
                self.reply(chat_id, NOT_TAKING).await;
            } else {
                let now = self.now();
                let due = {
                    let mut st = self.bot.lock();
                    let due = now - st.locked_told_at >= LOCKED_NOTE_MS;
                    if due {
                        st.locked_told_at = now;
                    }
                    due
                };
                if due {
                    self.reply(chat_id, LOCKED_NOTE).await;
                }
            }
            return;
        }
        if text_raw.is_empty() {
            self.reply(chat_id, TEXT_ONLY).await;
            return;
        }
        let reply_to = msg.get("reply_to_message").and_then(|r| safe_i64(r.get("message_id")));
        let forwarded = text::forwarded_from(msg);
        let update_id = safe_i64(u.get("update_id")).unwrap_or(0);
        let tg = safe_i64(msg.get("message_id")).unwrap_or(0);
        if let Some(rt) = reply_to
            && forwarded.is_none()
        {
            let r = Incoming { chat_id, update_id, tg, reply_to: rt, text: text_raw.clone() };
            let out = Out { tg: self.arc(), chat_id, paced: false };
            if self.on_reply(&r, &out).await {
                return;
            }
        }
        // Everything else goes to the front desk (a reply to a summary carries the summary's text).
        if self.desk_ready() {
            let quoted = msg
                .get("reply_to_message")
                .filter(|r| r.get("from").and_then(|f| f.get("is_bot")).and_then(Value::as_bool) == Some(true))
                .and_then(|r| r.get("text"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if self.desk_on_text(chat_id, update_id, tg, &text_raw, forwarded, quoted).await {
                return;
            }
        }
        let base = self.helper.core.board.base_url();
        let where_ = if self.phone_access() { format!("Or answer on the board: {base}/") } else { "Or answer on your Mac.".into() };
        self.reply(chat_id, &format!("Reply to an alert to answer that ticket. {where_}\n\nSend /waiting to see what waits on you.")).await;
    }

    /// "typing…" in the chat.
    pub async fn typing_once(&self, chat_id: i64) {
        self.api("sendChatAction", json!({ "chat_id": chat_id, "action": "typing" })).await;
    }

    /// The briefing to a chat paired before it existed (once).
    pub async fn brief_once(&self) {
        let t = self.tg_settings();
        let Some(chat) = chat_of(&t) else { return };
        if !b(&t, "on") || js::truthy(t.get("briefedAt")) || !TOKEN_RE.is_match(s(&t, "token")) {
            return;
        }
        self.save(vec![("briefedAt", iso(self.now()).into())]);
        self.reply(chat, &text::briefing(false)).await;
    }

    /// The channel's send (`TelegramBot.send`): plain text, sound only when urgent, Got it / Not urgent on messages
    /// that remind. `m` is the helper's `OutMessage`.
    pub async fn send(&self, m: &Map<String, Value>) -> Value {
        let t = self.tg_settings();
        let token = s(&t, "token").to_string();
        let Some(chat_id) = chat_of(&t).filter(|_| TOKEN_RE.is_match(&token)) else {
            return json!({ "channel": "telegram", "ok": false, "skipped": true, "error": null });
        };
        let get = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("");
        let message_id = m.get("messageId").and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_string);
        let link = if self.phone_access() { Some(text::tap_url(m)) } else { None };
        let head = if get("text").starts_with(get("title")) { get("text").to_string() } else { format!("{}\n\n{}", get("title"), get("text")) };
        let body_text = telegram_text(&head, if link.is_some() { "" } else { "\n\nAnswer on your Mac." });
        let level = get("level").to_string();
        let mut rows: Vec<Value> = Vec::new();
        if let Some(id) = &message_id {
            if level == "urgent" || level == "reminder" || js::truthy(m.get("practice")) {
                rows.push(json!([{ "text": "Got it", "callback_data": format!("g:{id}") }, { "text": "Not urgent", "callback_data": format!("n:{id}") }]));
            }
            if js::truthy(m.get("nightAsk")) {
                rows.extend(night_buttons(id).as_array().cloned().unwrap_or_default());
            }
        }
        if let Some(l) = link.as_deref().filter(|l| l.starts_with("https://")) {
            rows.push(json!([{ "text": "Open", "url": l }]));
        }
        let mut body = Map::new();
        body.insert("chat_id".into(), chat_id.into());
        body.insert("text".into(), body_text.into());
        body.insert("disable_notification".into(), (!js::truthy(m.get("urgent"))).into());
        body.insert("disable_web_page_preview".into(), true.into());
        if !rows.is_empty() {
            body.insert("reply_markup".into(), json!({ "inline_keyboard": rows }));
        }
        let body = Value::Object(body);
        let mut r = self.api_with(&token, "sendMessage", &body, None).await;
        if !r.ok && r.error_code == Some(429) {
            let wait = r.retry_after.unwrap_or(1.0);
            if wait <= RETRY_AFTER_MAX_S {
                tokio::time::sleep(Duration::from_millis((wait * 1000.0) as u64)).await;
                r = self.api_with(&token, "sendMessage", &body, None).await;
            }
        }
        if r.ok {
            if let Some(tg) = r.message_id() {
                let items = message_id.as_deref().map(|id| self.items_of(id)).unwrap_or_default();
                self.links.add(&text::bot_id(&token), tg, chat_id, message_id.as_deref(), &level, &items, self.now());
                // Forms the tickets in the alert wait on are shown under it, in the background.
                if let Some(id) = message_id.clone() {
                    let me = self.arc();
                    self.track(async move {
                        let items: Vec<LinkItem> = me.items_of(&id);
                        me.forms_show(&items, tg, chat_id).await;
                    });
                }
            }
            return json!({ "channel": "telegram", "ok": true, "devices": 1, "error": null });
        }
        let error = if r.error_code == Some(429) { "Telegram is limiting messages right now".to_string() } else { explain(&r) };
        json!({ "channel": "telegram", "ok": false, "error": error })
    }

    /// Start-up: the poller, and the briefing for chats paired before it existed; forms the board no longer asks
    /// are taken off the chat as tickets change.
    pub fn start(&self, bus: std::sync::Arc<crate::bus::Bus>) -> impl FnOnce() + Send + 'static {
        self.refresh();
        let me = self.arc();
        tokio::spawn(async move { me.brief_once().await });
        let dirty = std::sync::Arc::new(parking_lot::Mutex::new(std::collections::BTreeSet::<(String, String)>::new()));
        let d = dirty.clone();
        let sub = bus.on(move |e| {
            let ty = e.ty.as_str();
            if ty != "ticket.updated" && ty != "session.updated" {
                return;
            }
            let p = e.body.get("profile").and_then(Value::as_str).unwrap_or("").to_string();
            let id = if ty == "ticket.updated" { e.body.get("ticket").and_then(|t| t.get("id")) } else { e.body.get("id") };
            if let Some(id) = id.and_then(Value::as_str) {
                d.lock().insert((p, id.to_string()));
            }
        });
        let me = self.arc();
        let task = tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_millis(1000));
            loop {
                t.tick().await;
                let keys: Vec<(String, String)> = std::mem::take(&mut *dirty.lock()).into_iter().collect();
                if keys.is_empty() || !me.has_open_forms() {
                    continue;
                }
                for (slug, id) in keys {
                    me.forms_sync(&slug, &id).await;
                }
            }
        });
        let me = self.arc();
        move || {
            task.abort();
            bus.off(sub);
            me.stop();
            me.desk_stop();
        }
    }
}

/// What a button's callback_data asks.
enum Tap {
    /// `g:` Got it or `n:` Not urgent on a stored message.
    Alert(char, String),
    /// `y:` / `x:` the night question.
    Night(char, String),
    /// `p:<id>:<choice>`: a router, form or front desk button.
    Pending(String, String),
    None,
}

fn parse_tap(data: &str) -> Tap {
    let msg_id = |s: &str| s.starts_with("m_") && (3..=42).contains(&s.len()) && s[2..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if let Some((k, rest)) = data.split_once(':') {
        if (k == "g" || k == "n") && msg_id(rest) {
            return Tap::Alert(k.chars().next().unwrap(), rest.into());
        }
        if (k == "y" || k == "x") && msg_id(rest) {
            return Tap::Night(k.chars().next().unwrap(), rest.into());
        }
        if k == "p"
            && let Some((id, choice)) = rest.split_once(':')
            && id.len() == 10
            && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && (1..=3).contains(&choice.len())
            && choice.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        {
            return Tap::Pending(id.into(), choice.into());
        }
    }
    Tap::None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telegram::Button;

    #[test]
    fn taps_parse_like_bun() {
        assert!(matches!(parse_tap("g:m_abc1"), Tap::Alert('g', _)));
        assert!(matches!(parse_tap("n:m_"), Tap::None));
        assert!(matches!(parse_tap("y:m_x"), Tap::Night('y', _)));
        assert!(matches!(parse_tap("p:abcdefghij:y"), Tap::Pending(..)));
        assert!(matches!(parse_tap("p:abcdefghij:1234"), Tap::None));
        assert!(matches!(parse_tap("p:ABCDEFGHIJ:y"), Tap::None));
    }

    #[test]
    fn markup_keeps_https_links_and_data() {
        let rows = vec![vec![Button::url("Open", "http://x"), Button::data("Go", "p:a:y".into())], vec![Button::url("Open", "https://x")]];
        assert_eq!(markup(&rows), json!({ "inline_keyboard": [[{ "text": "Go", "callback_data": "p:a:y" }], [{ "text": "Open", "url": "https://x" }]] }));
    }
}
