//! How cold a ticket's Claude conversation is (`src/chat/chat-cache.ts`): the conversation's size, cache time and
//! cold re-read cost at Claude's last reply, read from the transcript's main-conversation events in order.

use serde_json::Value;

use super::js::num;
use super::Obj;

/// How far back (in content blocks) Claude looks for an earlier cache entry.
pub const LOOKBACK_BLOCKS: u64 = 20;

/// List prices in $ per million tokens (`priceFor` in `src/usage/ticket-usage.ts`); only the input price is used here.
fn input_price(model: &str) -> f64 {
    let lower = model.to_lowercase();
    // `.replace(/\[.*\]$/, "")`: a trailing "[...]" (the first "[" whose "]" ends the string).
    let m = match (lower.find('['), lower.ends_with(']')) {
        (Some(i), true) => &lower[..i],
        _ => lower.as_str(),
    };
    let has = |s: &str| m.contains(s);
    let opus_minor = || {
        // /opus-(5|4-[5-9])/
        m.match_indices("opus-").any(|(i, _)| {
            let r = &m[i + 5..];
            r.starts_with('5') || (r.starts_with("4-") && r[2..].chars().next().is_some_and(|c| ('5'..='9').contains(&c)))
        })
    };
    if has("fable-5-1") || has("mythos-5-1") || has("fable") || has("mythos") {
        10.0
    } else if has("opus-5-5") || m == "opus" {
        4.0
    } else if opus_minor() {
        5.0
    } else if has("opus") {
        15.0
    } else if has("sonnet-5") {
        2.0
    } else if has("sonnet") {
        3.0
    } else if has("haiku-4") {
        1.0
    } else if has("haiku") {
        0.8
    } else {
        4.0
    }
}

/// What a cache write of `tokens` costs at list price, for the model and cache time.
pub fn cold_cost(model: &str, tokens: f64, ttl: &str) -> f64 {
    (tokens * input_price(model) * if ttl == "1h" { 2.0 } else { 1.25 }) / 1e6
}

/// `typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0`.
fn n(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(0.0)
}

/// Reads assistant events in transcript order; `result()` gives the state at the last one with usage.
#[derive(Default, Clone)]
pub struct ChatCacheTracker {
    last: Option<(f64, String, String)>,
    ttl: Option<&'static str>,
    shared: Option<f64>,
    hour: f64,
    hour_at: String,
    hour_blocks: u64,
}

impl ChatCacheTracker {
    /// One main-conversation user or assistant event from the transcript, in order.
    pub fn add(&mut self, ev: &Value) {
        let msg = ev.get("message");
        let content = msg.and_then(|m| m.get("content"));
        self.hour_blocks += match content {
            Some(Value::Array(a)) => a.len() as u64,
            Some(c) if super::js::truthy(Some(c)) => 1,
            _ => 0,
        };
        if ev.get("type").and_then(Value::as_str) != Some("assistant") {
            return;
        }
        let usage = msg.and_then(|m| m.get("usage"));
        let model = msg.and_then(|m| m.get("model")).and_then(Value::as_str);
        let (Some(usage), Some(model)) = (usage.filter(|u| super::js::truthy(Some(u))), model) else { return };
        if model == "<synthetic>" {
            return;
        }
        if !usage.is_object() {
            return;
        }
        let read = n(usage.get("cache_read_input_tokens"));
        let tokens = n(usage.get("input_tokens")) + read + n(usage.get("cache_creation_input_tokens"));
        if tokens == 0.0 {
            return;
        }
        if self.shared.is_none() {
            self.shared = Some(read);
        }
        let split = usage.get("cache_creation").filter(|s| s.is_object());
        if let Some(s) = split {
            if n(s.get("ephemeral_5m_input_tokens")) > 0.0 {
                self.ttl = Some("5m");
            } else if n(s.get("ephemeral_1h_input_tokens")) > 0.0 {
                self.ttl = Some("1h");
            }
        }
        let ts = ev.get("timestamp").and_then(Value::as_str);
        let at = ts.unwrap_or("").to_string();
        let w1h = split.map(|s| n(s.get("ephemeral_1h_input_tokens"))).unwrap_or(0.0);
        let prefix = read + n(usage.get("cache_creation_input_tokens"));
        if w1h > 0.0 {
            self.hour = read + w1h;
            self.hour_at = at;
            self.hour_blocks = 0;
        } else if prefix < self.hour {
            self.hour = 0.0;
        } else if self.hour != 0.0 && read == self.hour {
            self.hour_at = at;
        }
        let last_at = match ts {
            Some(t) => t.to_string(),
            None => self.last.as_ref().map(|l| l.1.clone()).unwrap_or_default(),
        };
        self.last = Some((tokens, last_at, model.to_string()));
    }

    /// `ChatCache` as JSON, or null before any reply with usage.
    pub fn result(&self) -> Value {
        let Some((tokens, at, model)) = &self.last else { return Value::Null };
        if at.is_empty() {
            return Value::Null;
        }
        let ttl = self.ttl.unwrap_or("1h");
        let cold = (tokens - self.shared.unwrap_or(0.0).min(*tokens)).max(0.0);
        let hour_at = (ttl == "5m" && self.hour > 0.0 && !self.hour_at.is_empty() && self.hour_blocks <= LOOKBACK_BLOCKS)
            .then(|| self.hour_at.clone());
        let hour_tokens = if hour_at.is_some() { self.hour.min(*tokens) } else { 0.0 };
        let mut o = Obj::new();
        o.insert("tokens".into(), num(*tokens));
        o.insert("at".into(), Value::String(at.clone()));
        o.insert("model".into(), Value::String(model.clone()));
        o.insert("coldTokens".into(), num(cold));
        o.insert("ttl".into(), Value::String(ttl.into()));
        o.insert("hourTokens".into(), num(hour_tokens));
        o.insert("hourAt".into(), hour_at.map(Value::String).unwrap_or(Value::Null));
        o.insert("costUsd".into(), num(cold_cost(model, cold, ttl)));
        Value::Object(o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prices_like_bun() {
        assert_eq!(input_price("claude-opus-5-5[1m]"), 4.0);
        assert_eq!(input_price("opus"), 4.0);
        assert_eq!(input_price("claude-opus-4-6"), 5.0);
        assert_eq!(input_price("claude-opus-4-1"), 15.0);
        assert_eq!(input_price("claude-sonnet-5-5"), 2.0);
        assert_eq!(input_price("claude-haiku-4-5"), 1.0);
        assert_eq!(input_price("claude-fable-5-2"), 10.0);
        assert_eq!(input_price("weird"), 4.0);
    }

    #[test]
    fn tracks_the_last_reply() {
        let mut t = ChatCacheTracker::default();
        assert_eq!(t.result(), Value::Null);
        t.add(&json!({"type": "user", "message": {"content": "hi"}}));
        t.add(&json!({"type": "assistant", "timestamp": "2026-01-01T00:00:00.000Z", "message": {"model": "claude-opus-5-5",
            "content": [{"type": "text", "text": "x"}], "usage": {"input_tokens": 10, "cache_read_input_tokens": 1000,
            "cache_creation_input_tokens": 500, "cache_creation": {"ephemeral_1h_input_tokens": 500}}}}));
        let r = t.result();
        assert_eq!(r["tokens"], json!(1510));
        assert_eq!(r["coldTokens"], json!(510));
        assert_eq!(r["ttl"], json!("1h"));
        assert_eq!(r["hourAt"], Value::Null);
    }
}
