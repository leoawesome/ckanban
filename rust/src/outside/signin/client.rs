//! The tool servers a pass reaches (ports of `src/integrations/mcp-client.ts` and `stdio-client.ts`): an online MCP
//! server over streamable HTTP, or a program on this computer over stdio (newline-delimited JSON-RPC). One client per
//! piece of work; nothing is kept between them.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

use super::Fault;
use super::http::Http;
use crate::js;

const PROTOCOL: &str = "2025-03-26";

fn init_params() -> Value {
    json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "ckanban", "version": "1" } })
}

/// `toolAnswer`: a tools/call result as its JSON text parsed, or the plain text. Err is the tool's own error text.
pub fn tool_answer(name: &str, result: &Value) -> Result<Value, Fault> {
    let text = match result.get("content") {
        Some(Value::Array(a)) => a
            .iter()
            .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
            .map(|c| match c.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(t) => js::string(t),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if js::truthy(result.get("isError")) {
        return Err(Fault::Other(if text.is_empty() { format!("{name} failed") } else { text }));
    }
    if let Some(s) = result.get("structuredContent")
        && text.is_empty()
    {
        return Ok(s.clone());
    }
    Ok(ckanban_board::runs::js::parse(&text).unwrap_or(Value::String(text)))
}

/// `tools/list`'s `tools` (missing: none).
fn tools_of(result: &Value) -> Vec<Value> {
    match result.get("tools") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

pub enum Client {
    Http(HttpMcp),
    Stdio(StdioMcp),
}

impl Client {
    pub async fn list_tools(&mut self) -> Result<Vec<Value>, Fault> {
        match self {
            Client::Http(c) => c.list_tools().await,
            Client::Stdio(c) => c.list_tools().await,
        }
    }

    pub async fn call(&mut self, name: &str, args: Value) -> Result<Value, Fault> {
        match self {
            Client::Http(c) => c.call(name, args).await,
            Client::Stdio(c) => c.call(name, args).await,
        }
    }

    pub async fn close(&mut self) {
        match self {
            Client::Http(c) => c.close().await,
            Client::Stdio(c) => c.close(),
        }
    }
}

/// `McpClient`: a remote MCP server over streamable HTTP, with a bearer token.
pub struct HttpMcp {
    http: Http,
    url: String,
    token: String,
    session: Option<String>,
    next_id: u64,
    ready: bool,
}

impl HttpMcp {
    pub fn new(http: Http, url: &str, token: &str) -> Self {
        HttpMcp { http, url: url.to_string(), token: token.to_string(), session: None, next_id: 1, ready: false }
    }

    async fn post(&self, body: &Value) -> Result<super::http::Reply, Fault> {
        let auth = format!("Bearer {}", self.token);
        let mut headers = vec![
            ("content-type", "application/json"),
            ("accept", "application/json, text/event-stream"),
            ("authorization", auth.as_str()),
            ("mcp-protocol-version", PROTOCOL),
        ];
        if let Some(s) = &self.session {
            headers.push(("mcp-session-id", s.as_str()));
        }
        let res = self.http.send("POST", &self.url, &headers, Some(body.to_string())).await.map_err(Fault::Other)?;
        if res.status == 401 || res.status == 403 {
            return Err(Fault::Auth("The service no longer accepts this connection".into()));
        }
        if res.status == 429 {
            let retry = res.header("retry-after").map(|r| ckanban_board::runs::js::number_of_str(&r)).unwrap_or(0.0);
            let secs = if retry.is_finite() && retry > 0.0 { retry } else { 60.0 };
            return Err(Fault::RateLimit("The service is limiting requests".into(), secs * 1000.0));
        }
        if !(200..300).contains(&res.status) {
            return Err(Fault::Other(format!("The service answered {}", res.status)));
        }
        Ok(res)
    }

    /// The reply to request `id`: plain JSON, or the matching message of an event stream.
    fn reply(res: &super::http::Reply, id: u64) -> Result<Value, Fault> {
        if res.header("content-type").unwrap_or_default().contains("text/event-stream") {
            let blocks = regex::Regex::new(r"\r?\n\r?\n").unwrap();
            for block in blocks.split(&res.text) {
                let data: Vec<&str> = block
                    .split('\n')
                    .map(|l| l.strip_suffix('\r').unwrap_or(l))
                    .filter(|l| l.starts_with("data:"))
                    .map(|l| l[5..].trim_start_matches(js::is_space))
                    .collect();
                let data = data.join("\n");
                if data.is_empty() {
                    continue;
                }
                if let Some(msg) = ckanban_board::runs::js::parse(&data)
                    && msg.get("id").and_then(Value::as_f64) == Some(id as f64)
                {
                    return Ok(msg);
                }
            }
            return Err(Fault::Other("The service sent no answer".into()));
        }
        ckanban_board::runs::js::parse(&res.text).ok_or_else(|| Fault::Other("The service sent an answer ckanban can't read".into()))
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, Fault> {
        let id = self.next_id;
        self.next_id += 1;
        let res = self.post(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        if method == "initialize"
            && let Some(s) = res.header("mcp-session-id")
        {
            self.session = Some(s);
        }
        let msg = Self::reply(&res, id)?;
        if let Some(e) = msg.get("error").filter(|e| js::truthy(Some(e))) {
            let m = e.get("message").filter(|m| !m.is_null()).map(js::string).unwrap_or_else(|| "The service refused the request".into());
            return Err(Fault::Other(m));
        }
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn init(&mut self) -> Result<(), Fault> {
        if self.ready {
            return Ok(());
        }
        self.request("initialize", init_params()).await?;
        self.post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        self.ready = true;
        Ok(())
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Value>, Fault> {
        self.init().await?;
        Ok(tools_of(&self.request("tools/list", json!({})).await?))
    }

    pub async fn call(&mut self, name: &str, args: Value) -> Result<Value, Fault> {
        self.init().await?;
        let r = self.request("tools/call", json!({ "name": name, "arguments": args })).await?;
        tool_answer(name, &r)
    }

    /// Ends the session on the server (best effort).
    pub async fn close(&mut self) {
        let Some(s) = self.session.clone() else { return };
        let auth = format!("Bearer {}", self.token);
        let _ = self.http.send("DELETE", &self.url, &[("authorization", auth.as_str()), ("mcp-session-id", s.as_str())], None).await;
    }
}

/// A program on this computer, started the way Claude starts it.
pub struct StdioServer {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: std::path::PathBuf,
}

type Waiting = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// `StdioMcpClient`: its own process group with a time limit; close() kills the whole group.
pub struct StdioMcp {
    server: StdioServer,
    timeout: Duration,
    stdin: Option<ChildStdin>,
    pid: Option<i32>,
    next_id: u64,
    waiting: Waiting,
    /// Why every later request fails (the program stopped, or took too long).
    dead: Arc<Mutex<Option<String>>>,
    deadline: Option<tokio::time::Instant>,
    ready: bool,
}

impl StdioMcp {
    pub fn new(server: StdioServer, timeout: Duration) -> Self {
        StdioMcp {
            server,
            timeout,
            stdin: None,
            pid: None,
            next_id: 1,
            waiting: Arc::new(Mutex::new(HashMap::new())),
            dead: Arc::new(Mutex::new(None)),
            deadline: None,
            ready: false,
        }
    }

    fn start(&mut self) -> Result<(), Fault> {
        let mut cmd = Command::new(&self.server.command);
        cmd.args(&self.server.args)
            .current_dir(&self.server.cwd)
            .env_clear()
            .envs(self.server.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = cmd.spawn().map_err(|e| Fault::Other(format!("Could not start {}: {e}", self.server.command)))?;
        self.pid = child.id().map(|p| p as i32);
        self.stdin = child.stdin.take();
        self.deadline = Some(tokio::time::Instant::now() + self.timeout);
        let (stdout, mut stderr) = (child.stdout.take().expect("piped"), child.stderr.take().expect("piped"));
        let waiting = self.waiting.clone();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Some(msg) = ckanban_board::runs::js::parse(&line) else { continue };
                let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                let Some(w) = waiting.lock().remove(&id) else { continue };
                let out = match msg.get("error").filter(|e| js::truthy(Some(e))) {
                    Some(e) => Err(e.get("message").filter(|m| !m.is_null()).map(js::string).unwrap_or_else(|| "The program refused the request".into())),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = w.send(out);
            }
        });
        let err_text = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        });
        let (waiting, dead) = (self.waiting.clone(), self.dead.clone());
        // The exit watcher owns the child and reaps it; close() kills its group by id until then.
        tokio::spawn(async move {
            let code = match child.wait().await {
                Ok(s) => ckanban_board::runs::runner::exit_code(s),
                Err(_) => -1,
            };
            let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
            let stderr = tokio::time::timeout(Duration::from_millis(500), err_text).await.ok().and_then(Result::ok).unwrap_or_default();
            let tail = js::trim(&stderr).split('\n').next_back().unwrap_or("").to_string();
            let why = format!("The program stopped (exit {code}){}", if js::trim(&stderr).is_empty() { String::new() } else { format!(": {tail}") });
            *dead.lock() = Some(why.clone());
            for (_, w) in waiting.lock().drain() {
                let _ = w.send(Err(why.clone()));
            }
        });
        Ok(())
    }

    async fn send(&mut self, msg: &Value) -> Result<(), Fault> {
        let line = format!("{msg}\n");
        let Some(stdin) = self.stdin.as_mut() else { return Err(Fault::Other("The program isn't running".into())) };
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            // Gone: the exit watcher says why in a moment.
            tokio::time::sleep(Duration::from_millis(100)).await;
            let why = self.dead.lock().clone().unwrap_or_else(|| "The program stopped".into());
            return Err(Fault::Other(why));
        }
        Ok(())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, Fault> {
        if let Some(why) = self.dead.lock().clone() {
            return Err(Fault::Other(why));
        }
        let id = self.next_id;
        self.next_id += 1;
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().insert(id, tx);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let deadline = self.deadline.unwrap_or_else(tokio::time::Instant::now);
        match tokio::time::timeout_at(deadline, rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(Fault::Other(e)),
            Ok(Err(_)) => Err(Fault::Other(self.dead.lock().clone().unwrap_or_else(|| "The program stopped".into()))),
            Err(_) => {
                self.waiting.lock().remove(&id);
                Err(Fault::Other("The program took too long to answer".into()))
            }
        }
    }

    async fn init(&mut self) -> Result<(), Fault> {
        if self.ready {
            return Ok(());
        }
        self.start()?;
        self.request("initialize", init_params()).await?;
        self.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await?;
        self.ready = true;
        Ok(())
    }

    pub async fn list_tools(&mut self) -> Result<Vec<Value>, Fault> {
        self.init().await?;
        Ok(tools_of(&self.request("tools/list", json!({})).await?))
    }

    pub async fn call(&mut self, name: &str, args: Value) -> Result<Value, Fault> {
        self.init().await?;
        let r = self.request("tools/call", json!({ "name": name, "arguments": args })).await?;
        tool_answer(name, &r)
    }

    /// Kills the program's whole process group.
    pub fn close(&mut self) {
        if let Some(pid) = self.pid.take() {
            // The group of the program this client started, as Bun's `process.kill(-pid)`: helpers it left behind
            // die too, even after it exited (a group id isn't reused while any member lives).
            // SAFETY: kill(2) with a negative pid signals that process group.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
        self.stdin = None;
    }
}

impl Drop for StdioMcp {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_answers() {
        assert_eq!(tool_answer("t", &json!({ "content": [{ "type": "text", "text": "[1,2]" }] })).unwrap(), json!([1, 2]));
        assert_eq!(tool_answer("t", &json!({ "content": [{ "type": "text", "text": "a" }, { "type": "image" }, { "type": "text", "text": "b" }] })).unwrap(), json!("a\nb"));
        assert_eq!(tool_answer("t", &json!({ "structuredContent": { "x": 1 } })).unwrap(), json!({ "x": 1 }));
        assert_eq!(tool_answer("t", &json!({})).unwrap(), json!(""));
        assert_eq!(tool_answer("t", &json!({ "isError": true })).unwrap_err(), Fault::Other("t failed".into()));
        assert_eq!(tool_answer("t", &json!({ "isError": true, "content": [{ "type": "text", "text": "no" }] })).unwrap_err(), Fault::Other("no".into()));
    }

    fn script(body: &str) -> StdioServer {
        StdioServer {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), body.into()],
            env: std::env::vars().collect(),
            cwd: std::env::temp_dir(),
        }
    }

    /// A tiny stdio MCP server in sh: answers initialize, tools/list and one tools/call by request id.
    const FAKE: &str = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"list_items","description":"Items"}]}}\n' "$id" ;;
    *'"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"[{\\"id\\":\\"1\\"}]"}]}}\n' "$id" ;;
  esac
done
"#;

    #[tokio::test]
    async fn stdio_lists_and_calls() {
        let mut c = StdioMcp::new(script(FAKE), Duration::from_secs(10));
        let tools = c.list_tools().await.unwrap();
        assert_eq!(tools[0]["name"], "list_items");
        assert_eq!(c.call("list_items", json!({})).await.unwrap(), json!([{ "id": "1" }]));
        c.close();
    }

    #[tokio::test]
    async fn stdio_program_that_stops_or_hangs() {
        let mut c = StdioMcp::new(script("echo broken >&2; exit 3"), Duration::from_secs(10));
        let e = c.list_tools().await.unwrap_err();
        assert_eq!(e, Fault::Other("The program stopped (exit 3): broken".into()));
        let mut c = StdioMcp::new(script("sleep 30"), Duration::from_millis(300));
        assert_eq!(c.list_tools().await.unwrap_err(), Fault::Other("The program took too long to answer".into()));
        c.close();
        let mut c = StdioMcp::new(StdioServer { command: "/nonexistent/x".into(), args: vec![], env: vec![], cwd: std::env::temp_dir() }, Duration::from_secs(1));
        assert!(matches!(c.list_tools().await.unwrap_err(), Fault::Other(m) if m.starts_with("Could not start /nonexistent/x")));
    }
}
