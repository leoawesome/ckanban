//! The channels a message goes out on (`src/helper/channels.ts` `Channels`). Sending stays with the satellite until
//! P1b (phone push, ntfy, the Mac banner) and P1c (Telegram): Rust works out which channels a send goes to and asks
//! the satellite to send it (`helper-send`), then records the results itself.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{Map, Value, json};

use super::board::Facts;
use super::notify_settings::{channel_enabled, enabled, telegram_takes};

/// What sends a message to some channels. `targets` are already filtered (on, set up, and taking this message).
pub trait Sender: Send + Sync {
    fn send(&self, out: Value, targets: Vec<String>) -> BoxFuture<'static, Result<Vec<Value>, String>>;
    /// What the satellite knows (phone push devices, the board on screen, a connection).
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
/// left out. A satellite that can't be reached fails each target.
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
