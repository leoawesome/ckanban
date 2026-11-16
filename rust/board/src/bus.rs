//! The board's event bus (port of `src/core/events.ts`, plan 2.3): a `tokio::sync::broadcast` channel of
//! `Arc<BusEvent>` for the event stream's connections, plus in-process subscribers (the satellite mirror, later huddle
//! watchers and the restart gate) called synchronously inside `emit`, as Bun's listeners are. A subscriber must only
//! queue work (send on a channel), never block.
//!
//! Events are JSON objects with a `type`, exactly as Bun's `BusEvent`s serialize. An event from the Bun satellite
//! (re-emitted from its own event stream) arrives already built and masked by Bun, so its stream text is kept as it
//! came; it is never mirrored back to the satellite.

use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::broadcast;

/// How many events a slow event stream connection may fall behind before it is closed (the UI reopens it and
/// refetches; plan 2.3).
pub const CAPACITY: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Made by the Rust board.
    Board,
    /// Re-emitted from the Bun satellite's event stream.
    Satellite,
}

#[derive(Debug)]
pub struct BusEvent {
    /// The event's `type` ("ticket.updated", "activity", ...).
    pub ty: String,
    /// The whole event as JSON (its `type` included). Null for a satellite event whose text isn't JSON.
    pub body: Value,
    pub origin: Origin,
    /// What the event stream sends for it, built once and shared by every connection (`events::payload`).
    pub(crate) payload: OnceLock<String>,
}

impl BusEvent {
    /// An event of the Rust board. `body` must be a JSON object with a string `type`.
    pub fn new(body: Value) -> Self {
        let ty = body.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
        BusEvent { ty, body, origin: Origin::Board, payload: OnceLock::new() }
    }

    /// One `data:` message of the satellite's event stream (`data` is the text after `data: `), sent on as it came.
    pub fn from_satellite(data: &str) -> Self {
        let body: Value = serde_json::from_str(data).unwrap_or(Value::Null);
        let ty = body.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
        let payload = OnceLock::new();
        let _ = payload.set(format!("data: {data}\n\n"));
        BusEvent { ty, body, origin: Origin::Satellite, payload }
    }
}

type Subscriber = Arc<dyn Fn(&Arc<BusEvent>) + Send + Sync>;

pub struct Bus {
    tx: broadcast::Sender<Arc<BusEvent>>,
    subs: Mutex<Vec<(u64, Subscriber)>>,
    next_id: Mutex<u64>,
}

impl Default for Bus {
    fn default() -> Self {
        Self::new()
    }
}

impl Bus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CAPACITY);
        Bus { tx, subs: Mutex::new(Vec::new()), next_id: Mutex::new(0) }
    }

    /// Sends an event to the in-process subscribers (in the order they subscribed), then to every stream connection.
    pub fn emit(&self, e: BusEvent) {
        let e = Arc::new(e);
        // Copied out so a subscriber may (un)subscribe without a deadlock; never held across anything slow.
        let subs: Vec<Subscriber> = self.subs.lock().iter().map(|(_, f)| f.clone()).collect();
        for f in subs {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&e))).is_err() {
                eprintln!("bus listener error ({})", e.ty);
            }
        }
        // No connection open: nothing to do.
        let _ = self.tx.send(e);
    }

    /// Emits a board event from its JSON (`{"type": ..., ...}`).
    pub fn emit_json(&self, body: Value) {
        self.emit(BusEvent::new(body));
    }

    /// A receiver for one event stream connection (events from now on).
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<BusEvent>> {
        self.tx.subscribe()
    }

    /// An in-process subscriber; returns its id for `off`.
    pub fn on(&self, f: impl Fn(&Arc<BusEvent>) + Send + Sync + 'static) -> u64 {
        let mut n = self.next_id.lock();
        *n += 1;
        let id = *n;
        self.subs.lock().push((id, Arc::new(f)));
        id
    }

    pub fn off(&self, id: u64) {
        self.subs.lock().retain(|(i, _)| *i != id);
    }

    /// Open event stream connections.
    pub fn connections(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn subscribers_and_receivers_get_each_event_in_order() {
        let bus = Bus::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let id = bus.on(move |e| s.lock().push(e.ty.clone()));
        let mut rx = bus.subscribe();
        bus.emit_json(json!({ "type": "a" }));
        bus.emit_json(json!({ "type": "b" }));
        bus.off(id);
        bus.emit_json(json!({ "type": "c" }));
        assert_eq!(*seen.lock(), vec!["a", "b"]);
        let got: Vec<String> = (0..3).map(|_| rx.try_recv().unwrap().ty.clone()).collect();
        assert_eq!(got, vec!["a", "b", "c"]);
    }

    #[test]
    fn a_panicking_subscriber_doesnt_stop_the_others() {
        let bus = Bus::new();
        bus.on(|_| panic!("boom"));
        let hit = Arc::new(Mutex::new(0));
        let h = hit.clone();
        bus.on(move |_| *h.lock() += 1);
        bus.emit_json(json!({ "type": "x" }));
        assert_eq!(*hit.lock(), 1);
    }

    #[test]
    fn satellite_events_keep_their_text() {
        let e = BusEvent::from_satellite(r#"{"type":"helper.updated"}"#);
        assert_eq!(e.ty, "helper.updated");
        assert_eq!(e.origin, Origin::Satellite);
        assert_eq!(e.payload.get().unwrap(), "data: {\"type\":\"helper.updated\"}\n\n");
    }
}
