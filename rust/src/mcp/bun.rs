//! Tools left on Bun (see `ON_BUN` in mod.rs): their calls go to `bun src/cli.ts mcp`, started on first use with
//! this process's env and working folder, so they answer exactly as Bun does (its own run checks included). One
//! child serves every call of this session; it ends when this process does.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

type Pending = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct Running {
    stdin: ChildStdin,
    pending: Pending,
    /// Kept so the child is killed when this process drops it.
    _child: Child,
}

pub struct Bun {
    cwd: PathBuf,
    running: Mutex<Option<Running>>,
    next: AtomicU64,
}

impl Bun {
    pub fn new(cwd: PathBuf) -> Self {
        Bun { cwd, running: Mutex::new(None), next: AtomicU64::new(1) }
    }

    /// One tools/call on the Bun server: its JSON-RPC `result`, or an error text when Bun can't be reached.
    pub async fn call(&self, name: &str, args: Option<&Value>) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let mut params = json!({ "name": name });
        if let Some(a) = args {
            params["arguments"] = a.clone();
        }
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params }).to_string() + "\n";
        let rx = {
            let mut guard = self.running.lock().await;
            if guard.is_none() {
                *guard = Some(self.start().await?);
            }
            let run = guard.as_mut().expect("started");
            let (tx, rx) = oneshot::channel();
            run.pending.lock().expect("pending").insert(id, tx);
            if run.stdin.write_all(line.as_bytes()).await.is_err() || run.stdin.flush().await.is_err() {
                // The child is gone: start a new one on the next call.
                *guard = None;
                return Err(format!("{name} runs on the Bun server, which stopped; try again"));
            }
            rx
        };
        let reply = rx.await.map_err(|_| {
            // Reader ended: the child exited mid-call.
            format!("{name} runs on the Bun server, which stopped before it answered; try again")
        })?;
        if let Some(r) = reply.get("result") {
            return Ok(r.clone());
        }
        let msg = reply.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("no answer");
        Err(msg.to_string())
    }

    async fn start(&self) -> Result<Running, String> {
        let bun = crate::settings::bun_path().map_err(|e| format!("this tool runs on the Bun server: {e}"))?;
        let exe = std::env::current_exe().unwrap_or_default();
        let env_repo = std::env::var_os("CKANBAN_REPO").filter(|s| !s.is_empty()).map(PathBuf::from);
        let repo = crate::settings::repo_root(env_repo.as_deref(), &exe).map_err(|e| format!("this tool runs on the Bun server: {e}"))?;
        let mut child = Command::new(&bun)
            .arg(repo.join("src/cli.ts"))
            .arg("mcp")
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("this tool runs on the Bun server, which didn't start ({}): {e}", bun.display()))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let pending: Pending = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (init_tx, init_rx) = oneshot::channel();
        pending.lock().expect("pending").insert(0, init_tx);
        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                if let Some(tx) = reader_pending.lock().expect("pending").remove(&id) {
                    let _ = tx.send(msg);
                }
            }
            // End of output: every waiting call fails (their senders drop).
            reader_pending.lock().expect("pending").clear();
        });
        let hello = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "ckanban-rs", "version": env!("CARGO_PKG_VERSION") } } });
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        let out = format!("{hello}\n{note}\n");
        stdin.write_all(out.as_bytes()).await.map_err(|e| format!("this tool runs on the Bun server, which didn't start: {e}"))?;
        let _ = stdin.flush().await;
        init_rx.await.map_err(|_| "this tool runs on the Bun server, which exited at start".to_string())?;
        Ok(Running { stdin, pending, _child: child })
    }
}
