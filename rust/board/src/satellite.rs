//! The Rust board's side of the Bun satellite's stdin and event stream (plan 3.3; Bun's side is
//! `src/core/satellite.ts`).
//!
//! - `event <json>` lines: the board's own events of the types the helper needs, `ticket.updated` with its view.
//!   Events that came from the satellite are never sent back.
//! - `runtime <json>` lines: a snapshot of the live state the helper asks synchronously, at start; later tasks send
//!   one per change (only the keys that changed: `running`, `hostHuddles` per board, `sessions` per session).
//! - The satellite's own event stream is read and each message re-emitted on the board's bus as it came (`Origin::
//!   Satellite`), so pages see one stream.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{Map, Value, json};

use crate::api::{HuddleInfo, RunControl, SessionInfo, TicketViews};
use crate::bus::{Bus, BusEvent, Origin};
use crate::events::take_messages;

/// The event types the satellite gets (the helper's notifier and runner listen to these).
pub const MIRRORED: [&str; 5] = ["ticket.updated", "ticket.deleted", "activity", "session.updated", "profile.updated"];

/// The `event` line for a board event, or None when the satellite doesn't get it.
pub fn event_line(e: &BusEvent, views: &dyn TicketViews) -> Option<String> {
    if e.origin != Origin::Board || !MIRRORED.contains(&e.ty.as_str()) {
        return None;
    }
    let mut body = e.body.clone();
    if e.ty == "ticket.updated"
        && let (Some(p), Some(t)) = (e.body.get("profile").and_then(Value::as_str), e.body.get("ticket"))
        && let Some(v) = views.view(p, t)
    {
        body["ticket"] = v;
    }
    Some(format!("event {}\n", serde_json::to_string(&body).ok()?))
}

/// The start snapshot: what runs, each board's huddles by host ticket, and the summaries of `sessions`.
pub fn runtime_snapshot(
    runs: &dyn RunControl,
    huddles: &dyn HuddleInfo,
    sessions: &dyn SessionInfo,
    boards: &[String],
    session_ids: &[String],
) -> Value {
    let running: Vec<String> = runs.running_tickets().into_iter().map(|(s, id)| format!("{s}/{id}")).collect();
    let mut host = Map::new();
    for slug in boards {
        let states = huddles.host_states(slug);
        if !states.is_empty() {
            host.insert(slug.clone(), Value::Object(states.into_iter().collect()));
        }
    }
    let mut sums = Map::new();
    for id in session_ids {
        if let Some(s) = sessions.summary(id) {
            sums.insert(id.clone(), s);
        }
    }
    json!({ "running": running, "hostHuddles": host, "sessions": sums })
}

pub fn runtime_line(state: &Value) -> String {
    format!("runtime {state}\n")
}

/// Opens the satellite's event stream (on its internal port, with the front secret) and waits for `: connected`, so
/// nothing it emits after this returns is missed. Then reads it in the background, re-emitting each message on `bus`,
/// and opens it again if it drops (until the returned task is aborted).
pub async fn follow(bus: Arc<Bus>, internal_port: u16, public_port: u16, secret: String) -> Result<tokio::task::JoinHandle<()>, String> {
    let first = open(internal_port, public_port, &secret).await?;
    Ok(tokio::spawn(async move {
        let mut body = Some(first);
        loop {
            if let Some(b) = body.take() {
                read_into(&bus, b).await;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            match open(internal_port, public_port, &secret).await {
                Ok(b) => body = Some(b),
                Err(e) => eprintln!("[board] the satellite's event stream: {e}"),
            }
        }
    }))
}

type Incoming = (hyper::body::Incoming, String);

async fn open(internal_port: u16, public_port: u16, secret: &str) -> Result<Incoming, String> {
    let client = Client::builder(TokioExecutor::new()).build_http::<Empty<Bytes>>();
    let req = Request::get(format!("http://127.0.0.1:{internal_port}/api/events"))
        // Bun's Host check is against the board's port (it runs behind the front).
        .header(hyper::header::HOST, format!("127.0.0.1:{public_port}"))
        .header("x-ckanban-front", secret)
        .body(Empty::new())
        .map_err(|e| e.to_string())?;
    let res = client.request(req).await.map_err(|e| format!("can't open it: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("it answered {}", res.status()));
    }
    let mut body = res.into_body();
    let mut buf = String::new();
    let wait = async {
        while !buf.contains(": connected\n\n") {
            match body.frame().await {
                Some(Ok(f)) => {
                    if let Ok(d) = f.into_data() {
                        buf.push_str(&String::from_utf8_lossy(&d));
                    }
                }
                _ => return Err("it ended before it was connected".to_string()),
            }
        }
        Ok(())
    };
    tokio::time::timeout(Duration::from_secs(10), wait).await.map_err(|_| "no `: connected` within 10s".to_string())??;
    let rest = buf.split_off(buf.find(": connected\n\n").unwrap_or(0) + ": connected\n\n".len());
    Ok((body, rest))
}

async fn read_into(bus: &Bus, (mut body, mut buf): Incoming) {
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        for data in take_messages(&mut buf) {
            bus.emit(BusEvent::from_satellite(&data));
        }
        match body.frame().await {
            Some(Ok(f)) => {
                if let Ok(d) = f.into_data() {
                    // A chunk may end inside a character: keep the bytes until they decode.
                    bytes.extend_from_slice(&d);
                    match std::str::from_utf8(&bytes) {
                        Ok(s) => {
                            buf.push_str(s);
                            bytes.clear();
                        }
                        Err(e) => {
                            let ok = e.valid_up_to();
                            buf.push_str(std::str::from_utf8(&bytes[..ok]).unwrap_or_default());
                            bytes.drain(..ok);
                        }
                    }
                }
            }
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::StandIn;

    #[test]
    fn only_the_boards_own_events_of_the_mirrored_types_go_to_the_satellite() {
        let e = BusEvent::new(json!({ "type": "ticket.updated", "profile": "b", "ticket": { "id": "t1", "body": "a\nb" } }));
        assert_eq!(event_line(&e, &StandIn).unwrap(), "event {\"type\":\"ticket.updated\",\"profile\":\"b\",\"ticket\":{\"id\":\"t1\",\"body\":\"a\\nb\"}}\n");
        assert!(event_line(&BusEvent::new(json!({ "type": "draft", "profile": "b" })), &StandIn).is_none());
        assert!(event_line(&BusEvent::from_satellite(r#"{"type":"profile.updated","slug":"b"}"#), &StandIn).is_none());
    }

    #[test]
    fn the_stand_in_snapshot_is_empty() {
        let s = runtime_snapshot(&StandIn, &StandIn, &StandIn, &["b".into()], &["s1".into()]);
        assert_eq!(runtime_line(&s), "runtime {\"running\":[],\"hostHuddles\":{},\"sessions\":{}}\n");
    }
}
