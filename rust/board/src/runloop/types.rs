//! The run loop's own shapes (`ActiveRun["chat"]`, `ChatOptions` in `src/board/board-types.ts`). Queued messages
//! and tickets stay JSON maps with Bun's field names (`QueuedMessage`, `Ticket`), so their files keep Bun's bytes.

use serde_json::{Map, Value, json};

/// `ActiveRun["chat"]`: set for runs started from the ticket chat (not the Ready queue).
///
/// raw: `text` is the full prompt (planner wakes); return_to: the column such a run goes back to; quiet: a reply to
/// another ticket's Claude (the card, outcome and run count stay); from: the column (status, outcome) the card was in
/// when the message was sent; user: it answers a message the user typed in this ticket's chat.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Chat {
    pub text: String,
    /// "refine" (Backlog/Planning: no file edits) or "act".
    pub mode: String,
    pub raw: bool,
    pub return_to: Option<String>,
    pub quiet: bool,
    /// (status, outcome) where the card was; outcome as the ticket holds it (null when none).
    pub from: Option<(String, Value)>,
    pub user: bool,
    /// "prompt" or "local": the text is a slash command.
    pub slash: Option<String>,
    pub host_wake: bool,
    pub follow_up: bool,
    pub nudge: bool,
}

impl Chat {
    pub fn refine(&self) -> bool {
        self.mode == "refine"
    }
    pub fn act(&self) -> bool {
        self.mode == "act"
    }

    /// As Bun's object would print (only the keys it sets), for fixtures and logs.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("text".into(), Value::String(self.text.clone()));
        m.insert("mode".into(), Value::String(self.mode.clone()));
        if self.raw {
            m.insert("raw".into(), Value::Bool(true));
        }
        if let Some(r) = &self.return_to {
            m.insert("returnTo".into(), Value::String(r.clone()));
        }
        if self.quiet {
            m.insert("quiet".into(), Value::Bool(true));
        }
        if let Some((s, o)) = &self.from {
            m.insert("from".into(), json!({ "status": s, "outcome": o }));
        }
        if self.user {
            m.insert("user".into(), Value::Bool(true));
        }
        if let Some(s) = &self.slash {
            m.insert("slash".into(), Value::String(s.clone()));
        }
        if self.host_wake {
            m.insert("hostWake".into(), Value::Bool(true));
        }
        if self.follow_up {
            m.insert("followUp".into(), Value::Bool(true));
        }
        if self.nudge {
            m.insert("nudge".into(), Value::Bool(true));
        }
        Value::Object(m)
    }
}

/// `ChatOptions` of `Board.chat`.
#[derive(Clone, Default)]
pub struct ChatOptions {
    /// Checked right before the message is queued: false refuses it (`StillRefused`) and nothing is queued.
    pub still: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
    pub peer: bool,
    pub from_planner: bool,
    /// Sent by another ticket's Claude: `{ticketId, title}`.
    pub from: Option<Value>,
    pub slash: Option<String>,
    pub host_wake: bool,
    pub follow_up: bool,
    /// "Send in a fresh chat".
    pub fresh: bool,
    /// From Telegram: `{updateId, tg}`.
    pub telegram: Option<Value>,
    /// Start a new run for it rather than steering one already going.
    pub next_run: bool,
    /// A later item of an automation's thread: `{loopId, name}`.
    pub automation: Option<Value>,
}

impl ChatOptions {
    /// Not the user's own typing: a peer, a planner, a host wake or a follow-up.
    pub fn from_user(&self) -> bool {
        !self.peer && !self.from_planner && !self.host_wake && !self.follow_up && self.automation.is_none()
    }

    /// `flags(o)`: the queued-message fields these options set, in Bun's key order.
    pub fn flags(&self) -> Map<String, Value> {
        let mut m = Map::new();
        if let Some(a) = &self.automation {
            m.insert("automation".into(), a.clone());
        }
        if self.next_run {
            m.insert("nextRun".into(), Value::Bool(true));
        }
        if let Some(f) = &self.from {
            m.insert("from".into(), f.clone());
        }
        if let Some(t) = &self.telegram {
            m.insert("telegram".into(), t.clone());
        }
        if self.peer {
            m.insert("peer".into(), Value::Bool(true));
        }
        if self.from_planner {
            m.insert("fromPlanner".into(), Value::Bool(true));
        }
        if let Some(s) = &self.slash {
            m.insert("slash".into(), Value::String(s.clone()));
        }
        if self.host_wake {
            m.insert("hostWake".into(), Value::Bool(true));
        }
        if self.follow_up {
            m.insert("followUp".into(), Value::Bool(true));
        }
        m
    }

    /// The options a queued message was sent with (`sendQueued`).
    pub fn of_message(m: &Map<String, Value>) -> ChatOptions {
        let b = |k: &str| m.get(k).and_then(Value::as_bool).unwrap_or(false);
        let o = |k: &str| m.get(k).filter(|v| v.is_object()).cloned();
        ChatOptions {
            peer: b("peer"),
            from_planner: b("fromPlanner"),
            from: o("from"),
            automation: o("automation"),
            slash: m.get("slash").and_then(Value::as_str).map(str::to_string),
            host_wake: b("hostWake"),
            follow_up: b("followUp"),
            next_run: b("nextRun"),
            ..Default::default()
        }
    }
}

/// A queued message's text and flags, as `chatFor` reads them.
pub fn msg_flags(m: &Map<String, Value>) -> (bool, bool, Option<String>, bool, bool) {
    let b = |k: &str| m.get(k).and_then(Value::as_bool).unwrap_or(false);
    (b("peer"), b("fromPlanner"), m.get("slash").and_then(Value::as_str).map(str::to_string), b("hostWake"), b("followUp"))
}
