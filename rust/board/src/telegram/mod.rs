//! Telegram and its front desk in Rust (P1c; Bun's `src/helper/telegram.ts`, `tgreply.ts`, `tgforms.ts`,
//! `tgstores.ts`, `frontdesk.ts` and the Telegram half of `notify.ts`). In board mode Rust owns them: the bot's one
//! long poll, pairing, alerts out (the helper's `telegram` channel), replies to alerts into tickets' chats, question
//! forms answered with buttons, a ticket's reply sent back, the front desk (a quick chat a day, its rights, its
//! daily cap) and its Confirm cards, the request gate for `x-ckanban-frontdesk`, and the files `telegram-links.json`,
//! `telegram-pending.json`, `telegram-updates.json`, `telegram-offset.json`, `telegram-frontdesk.json`,
//! `telegram-desk-spend.json` (and `telegram-spend.json` with the run loop). The satellite runs none of it.
//!
//! One `Telegram` value holds all of it; its parts are `impl Telegram` blocks in the files below:
//! - `api`: the Bot API calls (`CKANBAN_TELEGRAM_URL` points them at a local fake in tests), with the token scrubbed.
//! - `bot`: the poller, the update queue, pairing, `/lock`, `/waiting`, taps, the channel's send, files.
//! - `replies`: a reply to an alert into its ticket (Send / Confirm cards), and a ticket's answer sent back.
//! - `forms`: a ticket's question form answered with buttons.
//! - `desk`: the front desk (messages in, answers out, Confirm cards for held requests, closed alerts, files).
//! - `text`: the pure text rules, checked against Bun's answers (`tests/telegram.rs`).

pub mod api;
pub mod bot;
pub mod desk;
pub mod forms;
pub mod replies;
pub mod stores;
pub mod text;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use self::stores::{LinkItem, Links, Pending, UpdateQueue};
use crate::helper::Helper;
use crate::helper::notify_settings::{TOKEN_RE, write_notify};
use crate::quickchat::QuickChats;

/// What Telegram needs from the board besides the helper (made in `rust/src/board_mode.rs`).
pub trait Env: Send + Sync {
    /// The board's folder (`getProfile(slug)?.path`).
    fn profile_path(&self, slug: &str) -> Option<String>;
    /// A schedule's record (`store.getSchedule`).
    fn schedule(&self, slug: &str, id: &str) -> Option<Value>;
    /// A one-time job's record (`store.getJob`).
    fn job(&self, slug: &str, id: &str) -> Option<Value>;
    /// `Board.chatFromTelegram`: false when that update was already sent. `from` is `{updateId, tg, chatId, key?}`.
    fn chat_from_telegram(&self, slug: &str, id: &str, text: &str, from: Value) -> BoxFuture<'static, Result<bool, String>>;
    /// `Board.patchTelegram` (`telegramIn`, `telegramOut`, `telegramReport`).
    fn patch_telegram(&self, slug: &str, id: &str, patch: Value);
    /// `Board.dropTelegramQueued`.
    fn drop_telegram_queued(&self) -> usize;
    /// The quick chats (the front desk lives in them), once they run.
    fn chats(&self) -> Option<Arc<QuickChats>>;
    /// A held request run as the user after the Confirm tap (no gate, no front desk header): `(status, body)`.
    fn replay(&self, method: String, path: String, body: Value) -> BoxFuture<'static, (u16, Value)>;
}

/// One button: `data` is the whole callback_data; `url` an Open link.
#[derive(Clone, Debug, PartialEq)]
pub struct Button {
    pub text: String,
    pub data: Option<String>,
    pub url: Option<String>,
}

impl Button {
    pub fn data(text: &str, data: String) -> Button {
        Button { text: text.into(), data: Some(data), url: None }
    }
    pub fn url(text: &str, url: &str) -> Button {
        Button { text: text.into(), data: None, url: Some(url.into()) }
    }
}

pub type Rows = Vec<Vec<Button>>;

/// `Responder.say`'s options.
#[derive(Clone, Debug, Default)]
pub struct Say {
    pub reply_to: Option<i64>,
    pub buttons: Rows,
    pub link: Vec<LinkItem>,
    pub level: Option<String>,
    pub force_reply: Option<String>,
}

impl Say {
    pub fn reply(to: i64) -> Say {
        Say { reply_to: Some(to), ..Default::default() }
    }
    pub fn reply_opt(to: Option<i64>) -> Say {
        Say { reply_to: to, ..Default::default() }
    }
    pub fn buttons(mut self, rows: Rows) -> Say {
        self.buttons = rows;
        self
    }
}

/// `Responder`: how the routers talk in one chat; every send is silent. `paced`: about one a second (forms).
#[derive(Clone)]
pub struct Out {
    pub tg: Arc<Telegram>,
    pub chat_id: i64,
    pub paced: bool,
}

/// The pairing going on (`TelegramBot.pairing`).
#[derive(Clone, Debug)]
pub struct Pairing {
    pub code: String,
    pub started_at: f64,
    pub expires_at: f64,
    pub tries: u32,
}

/// What Telegram said last (`TelegramStatus`).
#[derive(Clone, Debug, Default)]
pub struct Status {
    /// "off", "connecting", "ok", "error".
    pub state: String,
    pub error: Option<String>,
    pub bot_name: Option<String>,
}

#[derive(Default)]
pub struct BotState {
    pub status: Status,
    pub pairing: Option<Pairing>,
    pub pair_error: Option<String>,
    pub offset: i64,
    pub offset_loaded: bool,
    /// Bumped on every (re)start and stop: an older loop sees it and ends.
    pub generation: u64,
    pub polling: bool,
    pub abort: Option<tokio::sync::watch::Sender<bool>>,
    pub locked_told_at: f64,
    pub commands_for: Option<String>,
}

pub struct Telegram {
    pub root: PathBuf,
    pub helper: Arc<Helper>,
    pub env: Arc<dyn Env>,
    pub links: Links,
    pub pending: Pending,
    pub queue: UpdateQueue,
    pub bot: Mutex<BotState>,
    pub in_flight: Mutex<HashSet<i64>>,
    /// Messages are handled one at a time, in order, by one task.
    msg_tx: OnceLock<tokio::sync::mpsc::UnboundedSender<Value>>,
    /// Paced calls (forms) run one after another, `pace_ms` apart; the time of the last one.
    pub pace: tokio::sync::Mutex<f64>,
    pub pace_ms: f64,
    /// Start the long poll (tests drive `poll_once`).
    pub auto_poll: bool,
    pub http: reqwest::Client,
    pub desk: Mutex<desk::DeskState>,
    pub typing: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    pub paused_at: Mutex<HashMap<i64, f64>>,
    /// Background work (forms after an alert, updates in flight): `idle` waits for it.
    pub busy: Arc<tokio::sync::Semaphore>,
    me: Weak<Telegram>,
}

/// How many background jobs at once `idle` can wait for.
const BUSY_MAX: u32 = 1 << 20;

impl Telegram {
    pub fn new(root: &Path, helper: Arc<Helper>, env: Arc<dyn Env>) -> Arc<Telegram> {
        Self::with(root, helper, env, bot::PACE_MS, true)
    }

    pub fn with(root: &Path, helper: Arc<Helper>, env: Arc<dyn Env>, pace_ms: f64, auto_poll: bool) -> Arc<Telegram> {
        let http = reqwest::Client::builder().build().unwrap_or_else(|_| reqwest::Client::new());
        Arc::new_cyclic(|me| Telegram {
            root: root.to_path_buf(),
            helper,
            env,
            links: Links::new(root),
            pending: Pending::new(root),
            queue: UpdateQueue::new(Some(root)),
            bot: Mutex::new(BotState { status: Status { state: "off".into(), ..Default::default() }, locked_told_at: f64::NEG_INFINITY, ..Default::default() }),
            in_flight: Mutex::new(HashSet::new()),
            msg_tx: OnceLock::new(),
            pace: tokio::sync::Mutex::new(f64::NEG_INFINITY),
            pace_ms,
            auto_poll,
            http,
            desk: Mutex::new(desk::DeskState::load(root)),
            typing: Mutex::new(HashMap::new()),
            paused_at: Mutex::new(HashMap::new()),
            busy: Arc::new(tokio::sync::Semaphore::new(BUSY_MAX as usize)),
            me: me.clone(),
        })
    }

    pub fn arc(&self) -> Arc<Telegram> {
        self.me.upgrade().expect("telegram alive")
    }

    pub fn now(&self) -> f64 {
        (self.helper.core.now)()
    }

    /// notify.json as it is now (`Notifier.settings()`).
    pub fn settings(&self) -> Value {
        self.helper.core.settings()
    }

    /// Its `telegram` part.
    pub fn tg_settings(&self) -> Value {
        self.settings().get("telegram").cloned().unwrap_or(Value::Null)
    }

    pub fn token(&self) -> String {
        self.tg_settings().get("token").and_then(Value::as_str).unwrap_or("").to_string()
    }

    /// `botId(token)`: the token's public part.
    pub fn bot_id(&self) -> String {
        text::bot_id(&self.token())
    }

    /// The paired chat, or None.
    pub fn chat_id(&self) -> Option<i64> {
        chat_of(&self.tg_settings())
    }

    /// "Take messages from Telegram" is on (`taking`): on, taking and paired.
    pub fn taking(&self) -> bool {
        let t = self.tg_settings();
        b(&t, "on") && b(&t, "takeMessages") && chat_of(&t).is_some()
    }

    /// Saves a change to the telegram settings (`TelegramDeps.save`), merged into notify.json as it is now; Err when
    /// it couldn't be written (logged too).
    pub fn save(&self, patch: Vec<(&str, Value)>) -> Result<(), String> {
        let _w = self.helper.core.notify_write.lock();
        let mut s = self.settings();
        if let Some(t) = s.get_mut("telegram").and_then(Value::as_object_mut) {
            for (k, v) in patch {
                t.insert(k.into(), v);
            }
        }
        write_notify(&self.root, &s).map_err(|e| {
            eprintln!("telegram: couldn't save the settings: {e}");
            e.to_string()
        })
    }

    /// Phone access is on (`phoneAccess`): the board's address isn't this Mac's.
    pub fn phone_access(&self) -> bool {
        !text::is_local_url(&self.helper.core.board.base_url())
    }

    /// The ticket's address when phone access is on and it is https (an Open button), else None.
    pub fn ticket_url(&self, slug: &str, id: &str) -> Option<String> {
        let url = self.helper.core.link(slug, Some(id));
        (self.phone_access() && url.starts_with("https://")).then_some(url)
    }

    /// The paired chat's responder, or None when Telegram is off, another chat or no token (`out`).
    pub fn out(&self, chat_id: i64, paced: bool) -> Option<Out> {
        let t = self.tg_settings();
        let token = t.get("token").and_then(Value::as_str).unwrap_or("");
        (b(&t, "on") && chat_of(&t) == Some(chat_id) && TOKEN_RE.is_match(token)).then(|| Out { tg: self.arc(), chat_id, paced })
    }

    /// The board's name (`getProfile(slug)?.name ?? slug`).
    pub fn board_name(&self, slug: &str) -> String {
        self.helper.core.board.board_name(slug)
    }

    pub fn ticket(&self, slug: &str, id: &str) -> Option<Arc<crate::index::ticket::Tk>> {
        self.helper.core.board.ticket(slug, id)
    }

    pub fn running(&self, slug: &str, id: &str) -> bool {
        self.helper.core.board.running(slug, id)
    }

    /// Background work `idle` waits for.
    pub fn track(&self, f: impl std::future::Future<Output = ()> + Send + 'static) {
        let busy = self.busy.clone();
        tokio::spawn(async move {
            let _permit = busy.acquire().await;
            f.await;
        });
    }

    /// Resolves once nothing handled in the background is left (tests).
    pub async fn idle(&self) {
        loop {
            let _all = self.busy.acquire_many(BUSY_MAX).await;
            drop(_all);
            tokio::task::yield_now().await;
            if self.busy.available_permits() == BUSY_MAX as usize && self.in_flight.lock().is_empty() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// The board's helper settings' "My night".
    pub fn night(&self) -> crate::helper::settings::Night {
        crate::helper::settings::HelperSettingsStore::new(&self.root, self.helper.core.now.clone()).get().night
    }

    /// Items of a stored helper message as link items.
    pub fn items_of(&self, message_id: &str) -> Vec<LinkItem> {
        self.helper.core.message(message_id).map(|m| m.get("items").and_then(Value::as_array).map(|a| a.iter().map(LinkItem::of).collect()).unwrap_or_default()).unwrap_or_default()
    }
}

pub fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

pub fn chat_of(t: &Value) -> Option<i64> {
    let n = t.get("chatId")?.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

pub fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

pub fn null_or<T: Into<Value>>(v: Option<T>) -> Value {
    v.map(Into::into).unwrap_or(Value::Null)
}

/// `{ ok: false, ... }` results and the like, kept as JSON.
pub fn result(channel: &str, ok: bool, error: Option<String>) -> Value {
    json!({ "channel": channel, "ok": ok, "error": error })
}
