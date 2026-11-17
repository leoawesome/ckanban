//! A small client for Chrome's debugging port (port of `src/browser/cdp.ts`): the board's browsers use it to check and
//! close a Chrome, read its tabs, run the read-only sign-in check and pass the sign-in screen's taps. Only 127.0.0.1 is
//! ever dialled.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use regex::Regex;
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

/// Chrome writes the port it picked (`--remote-debugging-port=0`) here in its data folder: line 1 the port, line 2 the
/// browser's path.
pub const PORT_FILE: &str = "DevToolsActivePort";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortFile {
    pub port: u16,
    /// "/devtools/browser/<uuid>": unique to the Chrome that wrote the file.
    pub path: String,
}

static PATH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/devtools/browser/[A-Za-z0-9-]{8,}$").unwrap());
static TAB_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9-]{1,64}$").unwrap());

/// `parsePortFile`.
pub fn parse_port_file(text: &str) -> Option<PortFile> {
    let mut lines = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l));
    let a = lines.next().unwrap_or("");
    let b = lines.next().unwrap_or("");
    let port: f64 = crate::browsers::js::number(&json!(a.trim()));
    if port.fract() != 0.0 || port <= 0.0 || port > 65535.0 {
        return None;
    }
    let path = b.trim();
    if !PATH_RE.is_match(path) {
        return None;
    }
    Some(PortFile { port: port as u16, path: path.to_string() })
}

pub async fn read_port_file(dir: &Path) -> Option<PortFile> {
    let text = tokio::fs::read_to_string(dir.join(PORT_FILE)).await.ok()?;
    parse_port_file(&text)
}

/// One HTTP request to 127.0.0.1:<port>; the status and body, or None when it fails or runs out of time.
pub async fn http(method: &str, port: u16, path_and_query: &str, timeout: Duration) -> Option<(u16, Bytes)> {
    let work = async {
        let stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        let (mut send, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await.ok()?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let req = Request::builder()
            .method(method)
            .uri(path_and_query)
            .header("host", format!("127.0.0.1:{port}"))
            .body(Empty::<Bytes>::new())
            .ok()?;
        let res = send.send_request(req).await.ok()?;
        let status = res.status().as_u16();
        let body = res.into_body().collect().await.ok()?.to_bytes();
        Some((status, body))
    };
    tokio::time::timeout(timeout, work).await.ok().flatten()
}

async fn get_json(port: u16, path: &str, timeout: Duration) -> Option<Value> {
    let (status, body) = http("GET", port, path, timeout).await?;
    if !(200..300).contains(&status) {
        return None;
    }
    serde_json::from_slice(&body).ok()
}

/// True when 127.0.0.1:<port> answers as the very Chrome that wrote the port file (`portMatches`): its browser
/// WebSocket path (a fresh uuid per start) must match.
pub async fn port_matches(pf: &PortFile, timeout: Duration) -> bool {
    let Some(v) = get_json(pf.port, "/json/version", timeout).await else { return false };
    let Some(ws) = v.get("webSocketDebuggerUrl").and_then(Value::as_str) else { return false };
    url::Url::parse(ws).is_ok_and(|u| u.path() == pf.path)
}

/// An open tab (page target).
#[derive(Debug, Clone, PartialEq)]
pub struct PageTarget {
    pub id: String,
    pub title: String,
    pub url: String,
}

/// The open tabs over plain HTTP (`listPages`); None when the port doesn't answer.
pub async fn list_pages(port: u16, timeout: Duration) -> Option<Vec<PageTarget>> {
    let Value::Array(list) = get_json(port, "/json/list", timeout).await? else { return None };
    Some(
        list.iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
            .map(|t| PageTarget {
                id: crate::browsers::js::string(t.get("id").unwrap_or(&Value::Null)),
                title: t.get("title").and_then(Value::as_str).unwrap_or("").into(),
                url: t.get("url").and_then(Value::as_str).unwrap_or("").into(),
            })
            .collect(),
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct CdpError(pub String);

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

async fn connect(url: &str, timeout: Duration) -> Result<Socket, CdpError> {
    // Chrome sends each answer as one frame: a full-page screenshot or a big evaluate result can pass tungstenite's
    // 16 MiB frame limit, which would drop the socket (and the run's page). Bun's WebSocket has no such limit.
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_frame_size(None).max_message_size(Some(512 << 20));
    match tokio::time::timeout(timeout, tokio_tungstenite::connect_async_with_config(url, Some(config), false)).await {
        Err(_) => Err(CdpError("the browser didn't answer in time".into())),
        Ok(Err(_)) => Err(CdpError("couldn't connect to the browser".into())),
        Ok(Ok((ws, _))) => Ok(ws),
    }
}

/// Sends one call and waits for its answer (events in between are skipped).
async fn call(ws: &mut Socket, id: u64, method: &str, params: &Value, timeout: Duration) -> Result<Value, CdpError> {
    let msg = json!({ "id": id, "method": method, "params": params });
    ws.send(Message::text(msg.to_string())).await.map_err(|_| CdpError("the browser closed the connection".into()))?;
    let wait = async {
        loop {
            match ws.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return Err(CdpError("the browser closed the connection".into())),
                Some(Ok(Message::Text(t))) => {
                    let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                    if v.get("id").and_then(Value::as_u64) != Some(id) {
                        continue;
                    }
                    if let Some(e) = v.get("error") {
                        return Err(CdpError(e.get("message").map(crate::browsers::js::string).unwrap_or_else(|| "browser error".into())));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(json!({})));
                }
                Some(Ok(_)) => continue,
            }
        }
    };
    tokio::time::timeout(timeout, wait).await.unwrap_or_else(|_| Err(CdpError(format!("the browser didn't answer {method} in time"))))
}

/// Asks the Chrome behind a checked port to quit (`requestBrowserClose`): Chrome saves its cookies and logins on the
/// way out, which a kill doesn't. Done once the request went out (Chrome may drop the connection before answering).
pub async fn request_browser_close(pf: &PortFile) -> Result<(), CdpError> {
    let mut ws = connect(&format!("ws://127.0.0.1:{}{}", pf.port, pf.path), Duration::from_secs(5)).await?;
    let r = call(&mut ws, 1, "Browser.close", &json!({}), Duration::from_secs(5)).await;
    let _ = ws.close(None).await;
    match r {
        Ok(_) => Ok(()),
        // The connection closing under us is Chrome quitting: that is the answer.
        Err(e) if e.0.contains("closed") => Ok(()),
        Err(e) => Err(e),
    }
}

/// One short series of calls to one tab over its own WebSocket (`pageCall`): connects, sends each, closes.
pub async fn page_call(port: u16, target: &str, calls: &[(&str, Value)], timeout: Duration) -> Result<Vec<Value>, CdpError> {
    if !TAB_RE.is_match(target) {
        return Err(CdpError("not a tab id".into()));
    }
    let mut ws = connect(&format!("ws://127.0.0.1:{port}/devtools/page/{target}"), timeout).await?;
    let mut out = Vec::new();
    let mut result = Ok(());
    for (i, (method, params)) in calls.iter().enumerate() {
        match call(&mut ws, i as u64 + 1, method, params, timeout).await {
            Ok(v) => out.push(v),
            Err(e) => {
                result = Err(e);
                break;
            }
        }
    }
    let _ = ws.close(None).await;
    result.map(|_| out)
}

/// Runs a read-only expression in a tab and returns its value (`evaluateInPage`); None when it fails or times out.
pub async fn evaluate_in_page(port: u16, target: &str, expression: &str, timeout: Duration) -> Option<Value> {
    let params = json!({ "expression": expression, "returnByValue": true, "silent": true, "timeout": timeout.as_millis() as u64 });
    let r = page_call(port, target, &[("Runtime.evaluate", params)], timeout).await.ok()?;
    let r = r.into_iter().next()?;
    if r.get("exceptionDetails").is_some_and(|v| !v.is_null()) {
        return None;
    }
    r.get("result").and_then(|x| x.get("value")).cloned().filter(|v| !v.is_null())
}

/// An event from the browser: method, params and the page session it came from.
pub type CdpEvent = (String, Value, Option<String>);

type Waiters = std::sync::Mutex<std::collections::HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, CdpError>>>>;

/// One WebSocket to the browser kept open (`Cdp` of cdp.ts): page sessions go over it too (`Target.attachToTarget`
/// with flatten). Calls may overlap; events come out of the receiver `connect` hands back.
pub struct Cdp {
    out: tokio::sync::mpsc::UnboundedSender<Message>,
    pending: std::sync::Arc<Waiters>,
    next: std::sync::atomic::AtomicU64,
    closed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Cdp {
    /// `Cdp.connect(port, path)`: the browser's own WebSocket on 127.0.0.1, within 5 seconds.
    pub async fn connect(port: u16, path: &str) -> Result<(std::sync::Arc<Cdp>, tokio::sync::mpsc::UnboundedReceiver<CdpEvent>), CdpError> {
        use std::sync::atomic::Ordering;
        let ws = connect(&format!("ws://127.0.0.1:{port}{path}"), Duration::from_secs(5)).await?;
        let (mut sink, mut stream) = ws.split();
        let (out, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
        let (ev_tx, ev_rx) = tokio::sync::mpsc::unbounded_channel::<CdpEvent>();
        let pending: std::sync::Arc<Waiters> = Default::default();
        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                let close = matches!(m, Message::Close(_));
                if sink.send(m).await.is_err() || close {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let (p, c) = (pending.clone(), closed.clone());
        tokio::spawn(async move {
            while let Some(Ok(m)) = stream.next().await {
                let Message::Text(t) = m else {
                    if matches!(m, Message::Close(_)) {
                        break;
                    }
                    continue;
                };
                let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    let Some(w) = p.lock().expect("pending").remove(&id) else { continue };
                    let r = match v.get("error") {
                        Some(e) => Err(CdpError(e.get("message").map(crate::browsers::js::string).unwrap_or_else(|| "browser error".into()))),
                        None => Ok(v.get("result").cloned().unwrap_or(json!({}))),
                    };
                    let _ = w.send(r);
                } else if let Some(method) = v.get("method").and_then(Value::as_str) {
                    let session = v.get("sessionId").and_then(Value::as_str).map(String::from);
                    let _ = ev_tx.send((method.to_string(), v.get("params").cloned().unwrap_or(Value::Null), session));
                }
            }
            c.store(true, Ordering::SeqCst);
            for (_, w) in p.lock().expect("pending").drain() {
                let _ = w.send(Err(CdpError("the browser closed the connection".into())));
            }
        });
        Ok((std::sync::Arc::new(Cdp { out, pending, next: std::sync::atomic::AtomicU64::new(1), closed }), ev_rx))
    }

    pub fn closed(&self) -> bool {
        self.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// `send(method, params, sessionId, timeoutMs)`.
    pub async fn send(&self, method: &str, params: Value, session: Option<&str>, timeout: Duration) -> Result<Value, CdpError> {
        if self.closed() {
            return Err(CdpError("the browser connection is closed".into()));
        }
        let id = self.next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().expect("pending").insert(id, tx);
        if self.out.send(Message::text(msg.to_string())).is_err() {
            self.pending.lock().expect("pending").remove(&id);
            return Err(CdpError("the browser closed the connection".into()));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(CdpError("the browser closed the connection".into())),
            Err(_) => {
                self.pending.lock().expect("pending").remove(&id);
                Err(CdpError(format!("the browser didn't answer {method} in time")))
            }
        }
    }

    pub fn close(&self) {
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.out.send(Message::Close(None));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_file_like_bun() {
        assert_eq!(
            parse_port_file("9222\r\n/devtools/browser/abcdef12-3456\n"),
            Some(PortFile { port: 9222, path: "/devtools/browser/abcdef12-3456".into() })
        );
        assert_eq!(parse_port_file("0\n/devtools/browser/abcdef12"), None);
        assert_eq!(parse_port_file("70000\n/devtools/browser/abcdef12"), None);
        assert_eq!(parse_port_file("9222\n/devtools/browser/short"), None);
        assert_eq!(parse_port_file("9222"), None);
    }

    #[tokio::test]
    async fn a_dead_port_answers_nothing() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert!(!port_matches(&PortFile { port, path: "/devtools/browser/abcdefgh".into() }, Duration::from_millis(500)).await);
        assert_eq!(list_pages(port, Duration::from_millis(500)).await, None);
    }
}
