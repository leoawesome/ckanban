//! `GET /api/events` in board mode (plan 2.3; Bun's `sse()` and `ssePayload` in `src/api/context.ts`): `: connected`,
//! a `: ping` every 15 s, then one `data:` message per bus event. A `ticket.updated` event carries the ticket's view;
//! `session.updated` and `huddle.updated` are followed by the ticket's fresh `ticket.updated`; `activity` events go out
//! cut (`liveJson`); everything is masked like Bun's `maskSavedJson`. The text of an event is built once and shared by
//! every connection. A connection that falls behind the bus (`Lagged`) is closed: the UI reopens it and refetches.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::combinators::BoxBody;
use hyper::body::Frame;
use hyper::header::{CACHE_CONTROL, CONNECTION, CONTENT_TYPE, HeaderValue};
use hyper::Response;
use serde_json::Value;
use tokio::sync::{broadcast, mpsc};

use crate::api::{ActivityCut, TicketViews};
use crate::bus::{Bus, BusEvent};

pub const PING_EVERY: Duration = Duration::from_secs(15);

/// Hides saved keys in a JSON text (`maskSavedJson`); the server gives its own (`rust/src/mask.rs`).
pub type Mask = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// What building an event's text needs.
pub struct EventHooks {
    pub views: Arc<dyn TicketViews>,
    pub cut: Arc<dyn ActivityCut>,
    pub mask: Mask,
}

/// The text the event stream sends for `e`, built on first use and kept with the event.
pub fn payload<'a>(e: &'a BusEvent, hooks: &EventHooks) -> &'a str {
    e.payload.get_or_init(|| build(e, hooks))
}

fn build(e: &BusEvent, hooks: &EventHooks) -> String {
    let mut out = e.body.clone();
    if e.ty == "ticket.updated"
        && let (Some(p), Some(t)) = (e.body.get("profile").and_then(Value::as_str), e.body.get("ticket"))
        && let Some(v) = hooks.views.view(p, t)
    {
        out["ticket"] = v;
    }
    let text = if e.ty == "activity" { hooks.cut.live_json(&out, &|t: &str| (hooks.mask)(t)) } else { serde_json::to_string(&out).unwrap_or_else(|_| "null".into()) };
    let mut msg = format!("data: {text}\n\n");
    // Session changes and the host's huddle change the ticket's "your turn" state too.
    let changed = match e.ty.as_str() {
        "session.updated" => e.body.get("id").and_then(Value::as_str),
        "huddle.updated" => e.body.pointer("/huddle/hostTicket").and_then(Value::as_str),
        _ => None,
    };
    if let (Some(id), Some(p)) = (changed, e.body.get("profile").and_then(Value::as_str))
        && let Some(v) = hooks.views.view_of(p, id)
    {
        let extra = serde_json::json!({ "type": "ticket.updated", "profile": p, "ticket": v });
        msg.push_str(&format!("data: {extra}\n\n"));
    }
    (hooks.mask)(&msg)
}

/// A response body fed by a channel: the connection's task writes, hyper reads; dropping it (the caller left) ends the
/// task at its next write.
struct ChannelBody(mpsc::Receiver<Bytes>);

impl hyper::body::Body for ChannelBody {
    type Data = Bytes;
    type Error = hyper::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        self.0.poll_recv(cx).map(|o| o.map(|b| Ok(Frame::data(b))))
    }
}

/// The event stream's answer: 200 `text/event-stream`, open until the caller leaves or falls behind.
pub fn stream(bus: &Bus, hooks: Arc<EventHooks>, ping_every: Duration) -> Response<BoxBody<Bytes, hyper::Error>> {
    let rx = bus.subscribe();
    let (tx, body_rx) = mpsc::channel::<Bytes>(64);
    tokio::spawn(pump(rx, tx, hooks, ping_every));
    let mut res = Response::new(ChannelBody(body_rx).boxed());
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    res
}

async fn pump(mut rx: broadcast::Receiver<Arc<BusEvent>>, tx: mpsc::Sender<Bytes>, hooks: Arc<EventHooks>, ping_every: Duration) {
    if tx.send(Bytes::from_static(b": connected\n\n")).await.is_err() {
        return;
    }
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + ping_every, ping_every);
    loop {
        let out = tokio::select! {
            got = rx.recv() => match got {
                Ok(e) => {
                    let hooks = hooks.clone();
                    // Building a view can take a moment on a big board: off the runtime's worker, once per event.
                    let text = if e.payload.get().is_some() {
                        payload(&e, &hooks).to_string()
                    } else {
                        let e2 = e.clone();
                        match tokio::task::spawn_blocking(move || payload(&e2, &hooks).to_string()).await {
                            Ok(t) => t,
                            Err(_) => continue,
                        }
                    };
                    Bytes::from(text)
                }
                // Fell behind: close; the page reopens the stream and refetches what it may have missed.
                Err(broadcast::error::RecvError::Lagged(_)) => return,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            _ = ping.tick() => Bytes::from_static(b": ping\n\n"),
            _ = tx.closed() => return,
        };
        if tx.send(out).await.is_err() {
            return;
        }
    }
}

/// Splits an event stream's text into its `data:` payloads (one per message), keeping what is left of an unfinished
/// message in `buf`. Comments (`: ping`) and other fields are skipped. Used to re-emit the satellite's events.
pub fn take_messages(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(end) = buf.find("\n\n") {
        let msg: String = buf.drain(..end + 2).collect();
        let data: Vec<&str> = msg.lines().filter_map(|l| l.strip_prefix("data: ").or_else(|| l.strip_prefix("data:"))).collect();
        if !data.is_empty() {
            out.push(data.join("\n"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::StandIn;
    use serde_json::json;

    struct Views;
    impl TicketViews for Views {
        fn view(&self, _: &str, t: &Value) -> Option<Value> {
            let mut v = t.clone();
            v["running"] = json!(false);
            Some(v)
        }
        fn view_of(&self, p: &str, id: &str) -> Option<Value> {
            Some(json!({ "id": id, "board": p }))
        }
    }

    fn hooks(views: Arc<dyn TicketViews>) -> EventHooks {
        EventHooks { views, cut: Arc::new(StandIn), mask: Arc::new(|s: &str| s.replace("sk-secret-1", "***")) }
    }

    #[test]
    fn ticket_updated_carries_the_view_and_is_masked() {
        let h = hooks(Arc::new(Views));
        let e = BusEvent::new(json!({ "type": "ticket.updated", "profile": "b", "ticket": { "id": "t1", "body": "sk-secret-1" } }));
        assert_eq!(
            payload(&e, &h),
            "data: {\"type\":\"ticket.updated\",\"profile\":\"b\",\"ticket\":{\"id\":\"t1\",\"body\":\"***\",\"running\":false}}\n\n"
        );
    }

    #[test]
    fn session_and_huddle_changes_are_followed_by_the_ticket() {
        let h = hooks(Arc::new(Views));
        let e = BusEvent::new(json!({ "type": "session.updated", "profile": "b", "id": "t1", "session": {} }));
        let p = payload(&e, &h);
        assert!(p.ends_with("data: {\"type\":\"ticket.updated\",\"profile\":\"b\",\"ticket\":{\"id\":\"t1\",\"board\":\"b\"}}\n\n"), "{p}");
        let e = BusEvent::new(json!({ "type": "huddle.updated", "profile": "b", "huddle": { "hostTicket": "t9" } }));
        assert!(payload(&e, &h).contains("\"id\":\"t9\""));
        // The stand-ins: the ticket as it is, no extra message.
        let s = hooks(Arc::new(StandIn));
        let e = BusEvent::new(json!({ "type": "session.updated", "profile": "b", "id": "t1" }));
        assert_eq!(payload(&e, &s).matches("data: ").count(), 1);
    }

    #[test]
    fn satellite_text_is_sent_as_it_came() {
        let h = hooks(Arc::new(Views));
        let e = BusEvent::from_satellite(r#"{"type":"ticket.updated","profile":"b","ticket":{"id":"x"}}"#);
        assert_eq!(payload(&e, &h), "data: {\"type\":\"ticket.updated\",\"profile\":\"b\",\"ticket\":{\"id\":\"x\"}}\n\n");
    }

    #[test]
    fn messages_are_split_and_unfinished_ones_kept() {
        let mut buf = ": connected\n\ndata: {\"a\":1}\n\n: ping\n\ndata: {\"b\"".to_string();
        assert_eq!(take_messages(&mut buf), vec!["{\"a\":1}"]);
        assert_eq!(buf, "data: {\"b\"");
        buf.push_str(":2}\n\n");
        assert_eq!(take_messages(&mut buf), vec!["{\"b\":2}"]);
        assert!(buf.is_empty());
    }

    #[tokio::test]
    async fn the_stream_sends_connected_events_and_pings() {
        let bus = Bus::new();
        let res = stream(&bus, Arc::new(hooks(Arc::new(StandIn))), Duration::from_millis(50));
        assert_eq!(res.headers()[CONTENT_TYPE], "text/event-stream");
        let mut body = res.into_body();
        async fn next(b: &mut BoxBody<Bytes, hyper::Error>) -> String {
            String::from_utf8(b.frame().await.unwrap().unwrap().into_data().unwrap().to_vec()).unwrap()
        }
        assert_eq!(next(&mut body).await, ": connected\n\n");
        // The connection is subscribed before the first frame is read.
        while bus.connections() == 0 {
            tokio::task::yield_now().await;
        }
        bus.emit_json(json!({ "type": "integration.updated" }));
        assert_eq!(next(&mut body).await, "data: {\"type\":\"integration.updated\"}\n\n");
        assert_eq!(next(&mut body).await, ": ping\n\n");
        drop(body);
    }

    #[tokio::test]
    async fn a_connection_that_falls_behind_is_closed() {
        let bus = Bus::new();
        let res = stream(&bus, Arc::new(hooks(Arc::new(StandIn))), Duration::from_secs(60));
        let mut body = res.into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(&first[..], b": connected\n\n");
        for i in 0..(crate::bus::CAPACITY + 200) {
            bus.emit_json(json!({ "type": "x", "i": i }));
        }
        // Whatever it sent before it noticed, the stream ends.
        let mut ended = false;
        for _ in 0..(crate::bus::CAPACITY + 300) {
            match tokio::time::timeout(Duration::from_secs(5), body.frame()).await.unwrap() {
                None => {
                    ended = true;
                    break;
                }
                Some(f) => {
                    f.unwrap();
                }
            }
        }
        assert!(ended);
    }
}
