//! The board's passes in full (P2): every `/api/passes*` route and the automations' pass calls, ported from
//! `src/api/passes.ts`, `src/integrations/passes.ts` and `LoopManager.callForBoard` in `src/schedules/loops.ts`.
//! - `GET /api/passes` reuses the front's list (`crate::passes`);
//! - `POST /api/passes` for every kind: `key` (with or without an online server's address), `mcp` (an online MCP
//!   server the board signs in to) and `local` (a program on this computer from Claude's own settings);
//! - `PATCH` (a new key), `DELETE`, `POST .../authorize` (the sign-in page's address), `GET .../oauth/callback` (the
//!   service sends the browser back with a code), `GET .../tools`;
//! - `pass_call`: one tool call for an automation's check, after the board checked the check's token.
//!
//! Shared file: `automation-passes.json`, changed read-modify-write under the same `flock` as `crate::passes` and Bun,
//! written by atomic rename; after each change `notify` tells the satellite, which sends the UI `integration.updated`.
//! The sign-in states (which page, which proof) are kept in memory for 10 minutes, as Bun does.

#![allow(dead_code)] // Until the router (rust/src/outside/routes.rs) and board mode call it.

pub mod client;
pub mod http;
pub mod oauth;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use base64::Engine;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use self::client::{Client, HttpMcp, StdioMcp, StdioServer};
use self::http::Http;
use super::{Answer, Call};
use crate::js;
use crate::mask;
use crate::passes::{self as front, FileLock, PASSES_FILE};

/// Why a pass action failed: Bun's error classes.
#[derive(Debug, Clone, PartialEq)]
pub enum Fault {
    /// `PassError`: a status, a message and maybe a code (`no_registration`).
    Pass { status: u16, msg: String, code: Option<&'static str> },
    /// `AuthError`: the service refused the credentials; the pass needs connecting again.
    Auth(String),
    /// `RateLimitError`: wait this many milliseconds.
    RateLimit(String, f64),
    /// `NoRegistrationError`: the service can't register ckanban by itself.
    NoRegistration(String),
    /// Any other error.
    Other(String),
}

impl Fault {
    fn pass(status: u16, msg: impl Into<String>) -> Self {
        Fault::Pass { status, msg: msg.into(), code: None }
    }

    pub fn message(&self) -> &str {
        match self {
            Fault::Pass { msg, .. } | Fault::Auth(msg) | Fault::RateLimit(msg, _) | Fault::NoRegistration(msg) | Fault::Other(msg) => msg,
        }
    }

    /// How Bun's server answers it when a route lets it through.
    fn answer(&self) -> Answer {
        match self {
            Fault::Pass { status, msg, code } => {
                let mut v = json!({ "error": msg });
                if let Some(c) = code {
                    v["code"] = json!(c);
                }
                Answer::Json(*status, v)
            }
            other => Answer::error(500, other.message()),
        }
    }
}

/// An access token is renewed when it has less than this long left.
const RENEW_MS: f64 = 60_000.0;
/// The user has this long to finish signing in at the service.
const SIGN_IN_MS: f64 = 10.0 * 60_000.0;
/// Time limit for one use of a program on this computer.
const STDIO_TIMEOUT: Duration = Duration::from_secs(60);
static ENV_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z_][A-Z0-9_]{0,63}$").unwrap());
const RESERVED_ENV: [&str; 8] = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CKANBAN_PORT", "CKANBAN_CALL_TOKEN"];
static TOOL_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:\-]{1,100}$").unwrap());

/// One sign-in in progress: which pass, until when, and the PKCE proof.
struct Pending {
    pass_id: String,
    expires: f64,
    verifier: String,
}

/// A look at the file under the lock before a save; Err saves nothing.
type Check<'a> = dyn Fn(&[Value]) -> Result<(), Fault> + 'a;

/// The passes file: read as Bun's `read()` does (missing or unreadable: no passes), changed under the lock.
#[derive(Clone)]
struct Store {
    file: PathBuf,
    notify: front::Notify,
}

impl Store {
    fn read(&self) -> Vec<Value> {
        let Ok(text) = std::fs::read(&self.file) else { return Vec::new() };
        match serde_json::from_slice::<Value>(&text) {
            Ok(v) => match v.get("passes") {
                Some(Value::Array(a)) => a.iter().cloned().map(ckanban_core::jsnum::normalize).collect(),
                _ => Vec::new(),
            },
            Err(_) => Vec::new(),
        }
    }

    fn get(&self, id: &str) -> Option<Map<String, Value>> {
        self.read().into_iter().find(|p| p.get("id").and_then(Value::as_str) == Some(id)).and_then(|p| p.as_object().cloned())
    }

    /// `Passes.save`: puts `p` in place of the pass with its id, or at the end, under the lock. `check` sees the file as
    /// read under the lock and may refuse (nothing is written then).
    fn save(&self, p: Map<String, Value>, check: Option<&Check<'_>>) -> Result<(), Fault> {
        {
            let _lock = FileLock::take(&self.file).map_err(|e| Fault::Other(format!("can't lock {PASSES_FILE}: {e}")))?;
            let mut all = self.read();
            if let Some(check) = check {
                check(&all)?;
            }
            let id = p.get("id").cloned();
            let p = Value::Object(p);
            match all.iter().position(|x| x.get("id") == id.as_ref()) {
                Some(i) => all[i] = p,
                None => all.push(p),
            }
            front::write_passes(&self.file, &all).map_err(|e| Fault::Other(e.to_string()))?;
        }
        (self.notify)(PASSES_FILE);
        Ok(())
    }

    fn remove(&self, id: &str) -> Result<(), Fault> {
        {
            let _lock = FileLock::take(&self.file).map_err(|e| Fault::Other(format!("can't lock {PASSES_FILE}: {e}")))?;
            let mut all = self.read();
            if !all.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(id)) {
                return Err(gone());
            }
            all.retain(|p| p.get("id").and_then(Value::as_str) != Some(id));
            front::write_passes(&self.file, &all).map_err(|e| Fault::Other(e.to_string()))?;
        }
        (self.notify)(PASSES_FILE);
        Ok(())
    }

    /// `secrets()`: every secret the passes hold (at least 6 long).
    fn secrets(&self) -> Vec<String> {
        mask::pass_secrets(&self.read())
    }

    /// `mask(text)`: known secrets and anything that looks like one hidden.
    fn mask(&self, text: &str) -> String {
        mask::mask_text(text, &self.secrets())
    }
}

fn gone() -> Fault {
    Fault::pass(404, "That connection no longer exists")
}

/// `String(x)` of a field, "undefined" when it is missing (template literals in Bun's messages).
fn field(o: &Map<String, Value>, k: &str) -> String {
    o.get(k).map(js::string).unwrap_or_else(|| "undefined".into())
}

fn text_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

fn now_ms() -> f64 {
    ckanban_core::time::now_ms()
}

/// `nameOr`: the name tidied (spaces squashed, at most 60 UTF-16 units) or the fallback.
fn name_or(v: Option<&Value>, fallback: &str) -> String {
    let s = match v {
        Some(Value::String(s)) => ckanban_board::runs::js::head16(&js::squash_spaces(js::trim(s)), 60).to_string(),
        _ => String::new(),
    };
    if s.is_empty() { fallback.to_string() } else { s }
}

/// `httpUrl`: a trimmed https address (http only on this computer).
fn http_url(v: Option<&Value>) -> Result<String, Fault> {
    let s = match v {
        Some(Value::String(s)) => js::trim(s).to_string(),
        _ => String::new(),
    };
    oauth::web_address(&s).map_err(|_| Fault::pass(400, "The address must start with https://"))
}

fn one_line(s: &str) -> bool {
    !s.contains(['\r', '\n', '\0'])
}

/// `base64url` of random bytes, as `randomBytes(n).toString("base64url")`.
fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("random bytes");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// `createHash("sha256").update(verifier).digest("base64url")`.
fn challenge_of(verifier: &str) -> String {
    let hex = crate::mcp::sha256::hex(verifier.as_bytes());
    let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0)).collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Claude's own settings for one server (`readMcpConfig` in `src/integrations/mcp.ts`), the fields a pass needs.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub scope: &'static str,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    ckanban_board::runs::js::parse(&text)
}

/// `readMcpConfig(name, cwd, configFile)`: the server's entry from Claude's local, project or user settings.
pub fn read_mcp_config(name: &str, cwd: &Path, config_file: &Path) -> Option<ServerConfig> {
    let cfg = read_json(config_file).filter(|v| !v.is_null()).unwrap_or_else(|| json!({}));
    let cwd_s = cwd.to_string_lossy().into_owned();
    let project = read_json(&cwd.join(".mcp.json"));
    let sources: [(&'static str, Option<&Value>); 3] = [
        ("local", cfg.get("projects").and_then(|p| p.get(&cwd_s)).and_then(|p| p.get("mcpServers"))),
        ("project", project.as_ref().and_then(|p| p.get("mcpServers"))),
        ("user", cfg.get("mcpServers")),
    ];
    for (scope, servers) in sources {
        let Some(e) = servers.filter(|s| s.is_object() || s.is_array()).and_then(|s| s.get(name)) else { continue };
        let Some(o) = e.as_object() else { continue };
        let kind = match o.get("type").filter(|t| !t.is_null()) {
            Some(t) => js::string(t),
            None => (if js::truthy(o.get("url")) { "http" } else { "stdio" }).to_string(),
        };
        if kind == "http" || kind == "sse" {
            return Some(ServerConfig { scope, transport: kind, command: String::new(), args: Vec::new(), env: Vec::new() });
        }
        let command = o.get("command").filter(|c| !c.is_null()).map(js::string).unwrap_or_default();
        let args = match o.get("args") {
            Some(Value::Array(a)) => a.iter().map(js::string).collect(),
            _ => Vec::new(),
        };
        let env = match o.get("env") {
            Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), js::string(v))).collect(),
            _ => Vec::new(),
        };
        return Some(ServerConfig { scope, transport: "stdio".into(), command, args, env });
    }
    None
}

pub struct SignIn {
    store: Store,
    /// The front's pass routes, for the list (`GET /api/passes`).
    front: Arc<front::Passes>,
    root: PathBuf,
    callback_url: String,
    /// Folder Claude's local-scope servers belong to, and where programs on this computer start.
    home: PathBuf,
    /// Claude's global config (`.claude.json`).
    config_file: PathBuf,
    http: Http,
    sign_ins: Mutex<HashMap<String, Pending>>,
    /// One renewal per pass at a time.
    renewing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    stdio_timeout: Duration,
}

impl SignIn {
    pub fn new(root: PathBuf, callback_url: String, notify: front::Notify, home: PathBuf, config_file: PathBuf) -> Arc<SignIn> {
        let store = Store { file: root.join(PASSES_FILE), notify: notify.clone() };
        Arc::new(SignIn {
            store,
            front: Arc::new(front::Passes::new(root.clone(), notify)),
            root,
            callback_url,
            home,
            config_file,
            http: Http::new(),
            sign_ins: Mutex::new(HashMap::new()),
            renewing: Mutex::new(HashMap::new()),
            stdio_timeout: STDIO_TIMEOUT,
        })
    }

    /// Runs a file job on the blocking pool (the lock may wait for Bun's write).
    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce(&Store) -> T + Send + 'static) -> T {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || f(&store)).await.expect("passes file job")
    }

    async fn get(&self, id: &str) -> Option<Map<String, Value>> {
        let id = id.to_string();
        self.blocking(move |s| s.get(&id)).await
    }

    async fn require(&self, id: &str) -> Result<Map<String, Value>, Fault> {
        self.get(id).await.ok_or_else(gone)
    }

    async fn save(&self, p: Map<String, Value>) -> Result<(), Fault> {
        self.blocking(move |s| s.save(p, None)).await
    }

    async fn mask(&self, text: &str) -> String {
        let text = text.to_string();
        self.blocking(move |s| s.mask(&text)).await
    }

    /// `Passes.view`: what the UI may see of a pass (no secrets; the error masked).
    fn view(p: &Map<String, Value>, secrets: &[String]) -> Value {
        let mut v = Map::new();
        let copy = |v: &mut Map<String, Value>, k: &str| {
            if let Some(x) = p.get(k) {
                v.insert(k.into(), x.clone());
            }
        };
        let or_null = |k: &str| p.get(k).filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null);
        copy(&mut v, "id");
        copy(&mut v, "kind");
        copy(&mut v, "name");
        copy(&mut v, "claudeName");
        v.insert("url".into(), or_null("url"));
        v.insert("envName".into(), or_null("envName"));
        v.insert("board".into(), or_null("board"));
        copy(&mut v, "status");
        let err = if js::truthy(p.get("error")) { Value::String(mask::mask_text(&js::string(&p["error"]), secrets)) } else { Value::Null };
        v.insert("error".into(), err);
        copy(&mut v, "createdAt");
        if let Some(s) = p.get("savedAt").filter(|x| !x.is_null()).or_else(|| p.get("createdAt")) {
            v.insert("savedAt".into(), s.clone());
        }
        Value::Object(v)
    }

    async fn view_of(&self, p: &Map<String, Value>) -> Value {
        let secrets = self.blocking(|s| s.secrets()).await;
        Self::view(p, &secrets)
    }

    /// A board slug that names a board (Bun's `store.getProfile`).
    fn board_exists(&self, slug: &str) -> bool {
        !slug.is_empty() && !slug.contains('/') && slug != "." && slug != ".." && ckanban_core::DataDir::new(self.root.clone()).profile(slug).is_some()
    }

    /// Every `/api/passes...` route. None: not one of them.
    pub async fn answer(self: &Arc<Self>, c: &Call<'_>) -> Option<Answer> {
        let parts = c.parts;
        if parts.first().map(String::as_str) != Some("passes") {
            return None;
        }
        Some(self.route(c).await.unwrap_or_else(|a| a))
    }

    async fn route(self: &Arc<Self>, c: &Call<'_>) -> Result<Answer, Answer> {
        let (parts, m) = (c.parts, c.method);
        let p = |i: usize| parts.get(i).map(String::as_str);
        if parts.len() == 1 && m == "GET" {
            let fr = self.front.clone();
            return Ok(match tokio::task::spawn_blocking(move || fr.list()).await.ok().flatten() {
                Some(v) => Answer::Json(200, v),
                None => Answer::error(500, format!("{PASSES_FILE} can't be read")),
            });
        }
        if parts.len() == 1 && m == "POST" {
            (c.user)("Connecting a service for automations")?;
            let b = super::body_json(c.body)?;
            let b = if b.is_null() { json!({}) } else { b };
            match b.get("board") {
                None | Some(Value::Null) => {}
                Some(Value::String(s)) if self.board_exists(s) => {}
                Some(_) => return Err(Answer::error(400, "That board doesn't exist")),
            }
            let pass = self.add(&b).await.map_err(|f| f.answer())?;
            return Ok(Answer::Json(201, self.view_of(&pass).await));
        }
        if p(1) == Some("oauth") && p(2) == Some("callback") && m == "GET" {
            if !c.local {
                return Err(Answer::error(403, "sign in from the computer ckanban runs on"));
            }
            return self.callback(c.query).await;
        }
        let pid = p(1).unwrap_or("").to_string();
        if parts.len() == 3 && p(2) == Some("tools") && m == "GET" {
            return match self.tools(&pid).await {
                Ok(v) => Ok(Answer::Json(200, Value::Array(v))),
                Err(f @ Fault::Pass { .. }) => Err(f.answer()),
                Err(f) => Err(Answer::error(502, self.mask(f.message()).await)),
            };
        }
        (c.user)("Changing a service's connection for automations")?;
        if parts.len() == 2 && m == "PATCH" {
            let b = super::body_json(c.body)?;
            let secret = b.get("secret").cloned();
            let pass = self.replace_key(&pid, secret).await.map_err(|f| f.answer())?;
            return Ok(Answer::Json(200, self.view_of(&pass).await));
        }
        if parts.len() == 2 && m == "DELETE" {
            let id = pid.clone();
            self.blocking(move |s| s.remove(&id)).await.map_err(|f| f.answer())?;
            return Ok(Answer::Empty(204));
        }
        if parts.len() == 3 && p(2) == Some("authorize") && m == "POST" {
            let url = self.authorize(&pid).await.map_err(|f| f.answer())?;
            return Ok(Answer::Json(200, json!({ "url": url })));
        }
        Err(Answer::error(404, "not found"))
    }

    /// `add(input)`: a new pass. mcp waits for the sign-in; key and local are connected at once.
    async fn add(&self, input: &Value) -> Result<Map<String, Value>, Fault> {
        let kind = match input.get("kind") {
            None | Some(Value::Null) => String::new(),
            Some(k) => js::string(k),
        };
        let claude_name = match input.get("claudeName") {
            Some(Value::String(s)) if !js::trim(s).is_empty() => Some(js::trim(s).to_string()),
            _ => None,
        };
        let mut p = Map::new();
        p.insert("id".into(), json!(front::new_id()));
        p.insert("claudeName".into(), claude_name.clone().map(Value::String).unwrap_or(Value::Null));
        p.insert("error".into(), Value::Null);
        p.insert("createdAt".into(), json!(ckanban_core::time::iso(now_ms())));
        match kind.as_str() {
            "local" => {
                let Some(cn) = claude_name else { return Err(Fault::pass(400, "Pick the program from Connections")) };
                self.local_server(&cn)?;
                p.insert("kind".into(), json!("local"));
                p.insert("name".into(), json!(name_or(input.get("name"), &cn)));
                p.insert("status".into(), json!("connected"));
                self.save(p.clone()).await?;
                Ok(p)
            }
            "mcp" => {
                let url = http_url(input.get("url"))?;
                let host = url::Url::parse(&url).map(|u| oauth::host_of(&u)).unwrap_or_default();
                p.insert("kind".into(), json!("mcp"));
                p.insert("name".into(), json!(name_or(input.get("name"), claude_name.as_deref().unwrap_or(&host))));
                p.insert("url".into(), json!(url));
                p.insert("status".into(), json!("pending"));
                self.save(p.clone()).await?;
                Ok(p)
            }
            "key" => {
                let secret = match input.get("secret") {
                    Some(Value::String(s)) => js::trim(s).to_string(),
                    _ => String::new(),
                };
                if secret.is_empty() {
                    return Err(Fault::pass(400, "Paste the key"));
                }
                if !one_line(&secret) {
                    return Err(Fault::pass(400, "The key must be on one line"));
                }
                let url = if js::truthy(input.get("url")) { Some(http_url(input.get("url"))?) } else { None };
                let name = name_or(input.get("name"), claude_name.as_deref().unwrap_or(""));
                if name.is_empty() {
                    return Err(Fault::pass(400, "Give the key a name, e.g. Jira"));
                }
                let board = match input.get("board") {
                    Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                    _ => None,
                };
                if board.is_some() && url.is_some() {
                    return Err(Fault::pass(400, "A key for one board is for its runs and scripts, not for an online server"));
                }
                let mut env_name = None;
                if url.is_none() {
                    let e = match input.get("envName") {
                        Some(Value::String(s)) if !js::trim(s).is_empty() => js::trim(s).to_string(),
                        _ => front::env_name_for(&name),
                    };
                    if !ENV_NAME.is_match(&e) || RESERVED_ENV.contains(&e.as_str()) {
                        return Err(Fault::pass(400, format!("\"{e}\" can't be used as the key's name for scripts: use capital letters, digits and _")));
                    }
                    if board.is_some()
                        && let Some(bad) = front::key_name_error(&e)
                    {
                        return Err(Fault::pass(400, bad));
                    }
                    env_name = Some(e);
                }
                p.insert("kind".into(), json!("key"));
                p.insert("name".into(), json!(name));
                if let Some(u) = &url {
                    p.insert("url".into(), json!(u));
                }
                if let Some(e) = &env_name {
                    p.insert("envName".into(), json!(e));
                }
                if let Some(b) = &board {
                    p.insert("board".into(), json!(b));
                }
                p.insert("secret".into(), json!(secret));
                p.insert("status".into(), json!("connected"));
                let saved = p.clone();
                self.blocking(move |s| {
                    let check = |all: &[Value]| -> Result<(), Fault> {
                        let Some(e) = &env_name else { return Ok(()) };
                        let bv = board.clone().map(Value::String).unwrap_or(Value::Null);
                        let taken = all.iter().any(|x| text_of(x.get("envName")) == Some(e) && x.get("board").cloned().unwrap_or(Value::Null) == bv);
                        if taken { Err(Fault::pass(409, format!("A key named {e} already exists: replace that one instead"))) } else { Ok(()) }
                    };
                    s.save(saved, Some(&check))
                })
                .await?;
                Ok(p)
            }
            _ => Err(Fault::pass(400, "kind must be \"mcp\", \"key\" or \"local\"")),
        }
    }

    /// `replaceKey`: a new value for a key pass.
    async fn replace_key(&self, id: &str, secret: Option<Value>) -> Result<Map<String, Value>, Fault> {
        let mut p = self.require(id).await?;
        if text_of(p.get("kind")) != Some("key") {
            return Err(Fault::pass(400, "Only a key can be replaced"));
        }
        let s = match &secret {
            Some(Value::String(s)) => js::trim(s).to_string(),
            _ => String::new(),
        };
        if s.is_empty() || !one_line(&s) {
            return Err(Fault::pass(400, "Paste the new key on one line"));
        }
        p.insert("secret".into(), json!(s));
        p.insert("status".into(), json!("connected"));
        p.insert("error".into(), Value::Null);
        p.insert("savedAt".into(), json!(ckanban_core::time::iso(now_ms())));
        self.save(p.clone()).await?;
        Ok(p)
    }

    /// `localServer`: Claude's own settings for a program on this computer, read again each time.
    fn local_server(&self, claude_name: &str) -> Result<ServerConfig, Fault> {
        let Some(cfg) = read_mcp_config(claude_name, &self.home, &self.config_file) else {
            return Err(Fault::pass(404, format!("{claude_name} isn't in Claude's settings any more")));
        };
        if cfg.scope != "user" && cfg.scope != "local" {
            return Err(Fault::pass(
                400,
                format!("{claude_name} comes from a project's .mcp.json: the board only starts programs from your own Claude settings"),
            ));
        }
        if cfg.transport != "stdio" || cfg.command.is_empty() {
            return Err(Fault::pass(400, format!("{claude_name} isn't a program on this computer")));
        }
        Ok(cfg)
    }

    /// `authorizeUrl(id)`: the address to send the user to. Registers the board at the service first (again when the
    /// board's callback address changed).
    async fn authorize(&self, id: &str) -> Result<String, Fault> {
        let mut p = self.require(id).await?;
        if text_of(p.get("kind")) != Some("mcp") || !js::truthy(p.get("url")) {
            return Err(Fault::pass(400, "This connection has no sign-in step"));
        }
        let redirect = self.callback_url.clone();
        let current = p.get("oauth").filter(|v| js::truthy(Some(v)));
        if current.is_none_or(|o| o.get("redirectUri") != Some(&Value::String(redirect.clone()))) {
            let url = js::string(&p["url"]);
            let name = field(&p, "name");
            let found = async {
                let server = oauth::discover(&self.http, &url).await?;
                let client = oauth::register(&self.http, &server, &redirect).await?;
                Ok::<_, Fault>((server, client))
            }
            .await;
            let (server, mut o) = match found {
                Ok(x) => x,
                Err(Fault::NoRegistration(_)) => {
                    return Err(Fault::Pass {
                        status: 409,
                        msg: format!("{name} can't be signed in to from the board by itself. Paste a key for it instead."),
                        code: Some("no_registration"),
                    });
                }
                Err(e) => return Err(Fault::pass(502, format!("Could not start the sign-in with {name}: {}", self.mask(e.message()).await))),
            };
            o.insert("redirectUri".into(), json!(redirect));
            o.insert("authorizationEndpoint".into(), json!(server.authorization_endpoint));
            o.insert("tokenEndpoint".into(), json!(server.token_endpoint));
            o.insert("resource".into(), json!(url));
            if !server.read_scopes.is_empty() {
                o.insert("scope".into(), json!(server.read_scopes.join(" ")));
            }
            p.insert("oauth".into(), Value::Object(o));
            self.save(p.clone()).await?;
        }
        let state = random_b64(24);
        let verifier = random_b64(32);
        let now = now_ms();
        {
            let mut s = self.sign_ins.lock();
            s.retain(|_, v| v.expires >= now);
            s.insert(state.clone(), Pending { pass_id: id.to_string(), expires: now + SIGN_IN_MS, verifier: verifier.clone() });
        }
        let o = p.get("oauth").and_then(Value::as_object).cloned().unwrap_or_default();
        oauth::authorize_url(&o, &state, &challenge_of(&verifier)).map_err(Fault::Other)
    }

    /// `complete(state, code)`: the service sent the user back with a code. The state must be one `authorize` made,
    /// and works once.
    async fn complete(&self, state: &str, code: &str) -> Result<Map<String, Value>, Fault> {
        let s = self.sign_ins.lock().remove(state);
        let Some(s) = s.filter(|s| s.expires >= now_ms()) else {
            return Err(Fault::pass(400, "This sign-in link is not valid any more. Start again from Connections."));
        };
        let p = self.require(&s.pass_id).await?;
        let Some(o) = p.get("oauth").and_then(Value::as_object).cloned() else {
            return Err(Fault::pass(400, "Start the sign-in again from Connections."));
        };
        let tokens = match oauth::exchange(&self.http, &o, code, &s.verifier, now_ms()).await {
            Ok(t) => t,
            Err(e) => {
                let mut q = p.clone();
                q.insert("status".into(), json!("pending"));
                q.insert("error".into(), json!(e.message()));
                self.save(q).await?;
                return Err(Fault::pass(502, self.mask(e.message()).await));
            }
        };
        let mut signed = p.clone();
        signed.insert("tokens".into(), Value::Object(tokens));
        signed.insert("status".into(), json!("connected"));
        signed.insert("error".into(), Value::Null);
        self.save(signed.clone()).await?;
        let pid = field(&p, "id");
        if let Err(e) = self.with_client(&pid, |c| Box::pin(async move { c.list_tools().await })).await {
            let why = format!("{} signed you in but didn't let the board use its tools: {}", field(&p, "name"), e.message());
            signed.insert("status".into(), json!("needs_reconnect"));
            signed.insert("error".into(), json!(why));
            self.save(signed).await?;
            return Err(Fault::pass(502, self.mask(&why).await));
        }
        self.get(&pid).await.ok_or_else(gone)
    }

    /// `GET /api/passes/oauth/callback`: a small page on this Mac.
    async fn callback(&self, query: &str) -> Result<Answer, Answer> {
        let page = |title: &str, text: &str, status: u16| {
            Answer::Html(
                status,
                format!(
                    "<!doctype html><meta charset=\"utf-8\"><title>{title}</title><body style=\"font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem\"><h2>{title}</h2><p>{text}</p>"
                ),
            )
        };
        let q: Vec<(String, String)> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
        let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        if let Some(denied) = get("error").filter(|d| !d.is_empty()) {
            return Ok(page("Not connected", &esc(&get("error_description").unwrap_or(denied)), 400));
        }
        match self.complete(&get("state").unwrap_or_default(), &get("code").unwrap_or_default()).await {
            Ok(p) => Ok(page(
                "Connected",
                &format!("{} is connected for automations. You can close this tab and go back to the board.", esc(&field(&p, "name"))),
                200,
            )),
            Err(Fault::Pass { status, msg, .. }) => Ok(page("Not connected", &esc(&msg), status)),
            Err(e) => Err(e.answer()),
        }
    }

    /// `markNeedsReconnect`: the service refused this pass.
    async fn mark_needs_reconnect(&self, id: &str, message: &str) {
        let Some(mut p) = self.get(id).await else { return };
        if text_of(p.get("status")) != Some("needs_reconnect") || p.get("error") != Some(&Value::String(message.into())) {
            p.insert("status".into(), json!("needs_reconnect"));
            p.insert("error".into(), json!(message));
            if let Err(e) = self.save(p).await {
                eprintln!("ckanban-rs: {PASSES_FILE}: {}", e.message());
            }
        }
    }

    /// `token(id)`: the access token, renewed first when it is about to run out. One renewal per pass at a time.
    async fn token(&self, id: &str) -> Result<String, Fault> {
        let soon = |p: &Map<String, Value>| {
            let at = p.get("tokens").and_then(|t| t.get("expiresAt")).filter(|v| js::truthy(Some(v)));
            at.and_then(|v| v.as_str()).and_then(ckanban_core::time::parse_date).is_some_and(|ms| ms - now_ms() < RENEW_MS)
        };
        let access = |p: &Map<String, Value>| p.get("tokens").and_then(|t| t.get("access")).map(js::string).unwrap_or_else(|| "undefined".into());
        let has_tokens = |p: &Option<Map<String, Value>>| p.as_ref().is_some_and(|p| js::truthy(p.get("tokens")));
        let p = self.get(id).await;
        if !has_tokens(&p) {
            return Err(Fault::Auth("This connection is not signed in".into()));
        }
        let p = p.expect("checked");
        if !soon(&p) {
            return Ok(access(&p));
        }
        let gate = self.renewing.lock().entry(id.to_string()).or_default().clone();
        let _turn = gate.lock().await;
        // Another call may have renewed it meanwhile.
        let p = self.get(id).await;
        if !has_tokens(&p) {
            return Err(Fault::Auth("This connection is not signed in".into()));
        }
        let p = p.expect("checked");
        if !soon(&p) {
            return Ok(access(&p));
        }
        let r = self.renew(p).await;
        self.renewing.lock().remove(id);
        r
    }

    async fn renew(&self, mut p: Map<String, Value>) -> Result<String, Fault> {
        let old = p.get("tokens").cloned().unwrap_or(Value::Null);
        let o = p.get("oauth").filter(|v| js::truthy(Some(v))).map(|v| v.as_object().cloned().unwrap_or_default());
        let refresh_token = old.get("refresh").filter(|v| js::truthy(Some(v))).map(js::string);
        let (Some(o), Some(rt)) = (o, refresh_token) else {
            return Err(Fault::Auth("The sign-in expired. Connect again.".into()));
        };
        let fresh = oauth::refresh(&self.http, &o, &rt, now_ms()).await?;
        let mut t = Map::new();
        t.insert("refresh".into(), old.get("refresh").cloned().unwrap_or(Value::Null));
        for (k, v) in &fresh {
            t.insert(k.clone(), v.clone());
        }
        let access = js::string(&fresh["access"]);
        p.insert("tokens".into(), Value::Object(t));
        self.save(p).await?;
        Ok(access)
    }

    /// The pass's tool server, opened (`withClient`'s first half). Its errors never mark the pass.
    async fn client_for(&self, id: &str) -> Result<Client, Fault> {
        let p = self.require(id).await?;
        let kind = text_of(p.get("kind")).unwrap_or("");
        if kind == "local" {
            let name = p.get("claudeName").filter(|v| !v.is_null()).map(js::string).unwrap_or_default();
            let cfg = self.local_server(&name)?;
            let mut env: Vec<(String, String)> = ckanban_board::runs::runner::inherited_env(
                std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?))),
            );
            for (k, v) in cfg.env {
                match env.iter_mut().find(|(n, _)| *n == k) {
                    Some(e) => e.1 = v,
                    None => env.push((k, v)),
                }
            }
            let server = StdioServer { command: cfg.command, args: cfg.args, env, cwd: self.home.clone() };
            return Ok(Client::Stdio(StdioMcp::new(server, self.stdio_timeout)));
        }
        if kind == "mcp" {
            if text_of(p.get("status")) == Some("pending") {
                return Err(Fault::Auth(format!("{} isn't signed in yet: press Connect in Connections", field(&p, "name"))));
            }
            let token = self.token(id).await?;
            return Ok(Client::Http(HttpMcp::new(self.http.clone(), &field(&p, "url"), &token)));
        }
        if js::truthy(p.get("url")) {
            let secret = p.get("secret").filter(|v| !v.is_null()).map(js::string).unwrap_or_default();
            return Ok(Client::Http(HttpMcp::new(self.http.clone(), &js::string(&p["url"]), &secret)));
        }
        Err(Fault::pass(400, format!("{} is a key for scripts ({}), not a service the board can call", field(&p, "name"), field(&p, "envName"))))
    }

    /// `withClient`: opens the pass's tool server, runs `op`, closes it again. An auth failure marks the pass.
    async fn with_client<T>(
        &self,
        id: &str,
        op: impl for<'a> FnOnce(&'a mut Client) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, Fault>> + Send + 'a>>,
    ) -> Result<T, Fault> {
        let mut c = self.client_for(id).await?;
        let r = op(&mut c).await;
        if let Err(Fault::Auth(m)) = &r {
            self.mark_needs_reconnect(id, m).await;
        }
        c.close().await;
        r
    }

    /// `tools(id)`: the pass's tools as `{name, description?}` (descriptions cut to 300).
    async fn tools(&self, id: &str) -> Result<Vec<Value>, Fault> {
        let list = self.with_client(id, |c| Box::pin(async move { c.list_tools().await })).await?;
        Ok(list
            .into_iter()
            .map(|t| {
                let mut o = Map::new();
                o.insert("name".into(), t.get("name").cloned().unwrap_or(Value::Null));
                if js::truthy(t.get("description")) {
                    let d = js::string(&t["description"]);
                    o.insert("description".into(), json!(ckanban_board::runs::js::head16(&d, 300)));
                }
                Value::Object(o)
            })
            .collect())
    }

    /// `call(id, tool, args)`.
    async fn call(&self, id: &str, tool: &str, args: Value) -> Result<Value, Fault> {
        let tool = tool.to_string();
        self.with_client(id, move |c| Box::pin(async move { c.call(&tool, args).await })).await
    }

    /// `find(ref, among)`: a pass by id, Claude server name, display name or key name (any case).
    fn find(all: &[Value], r: &str, among: &[String]) -> Option<Map<String, Value>> {
        let low = js::trim(r).to_lowercase();
        let list: Vec<&Map<String, Value>> = all
            .iter()
            .filter_map(Value::as_object)
            .filter(|p| text_of(p.get("id")).is_some_and(|id| among.iter().any(|a| a == id)))
            .collect();
        let lower = |p: &Map<String, Value>, k: &str| p.get(k).filter(|v| !v.is_null()).map(|v| js::string(v).to_lowercase());
        list.iter()
            .find(|p| text_of(p.get("id")) == Some(r))
            .or_else(|| list.iter().find(|p| lower(p, "claudeName").as_deref() == Some(low.as_str())))
            .or_else(|| list.iter().find(|p| lower(p, "name").as_deref() == Some(low.as_str())))
            .or_else(|| list.iter().find(|p| lower(p, "envName").as_deref() == Some(low.as_str())))
            .map(|p| (*p).clone())
    }

    /// `callForBoard`: one tool call for an automation's check, with the grant the board checked the check's token
    /// for (`{service, tool, args, passes, allowed}`). Gives `{status, body: {result} | {error}, rateLimitMs}`.
    pub async fn pass_call(&self, b: Value) -> Value {
        let strs = |v: Option<&Value>| match v {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let passes = strs(b.get("passes"));
        let allowed = match b.get("allowed") {
            Some(Value::Array(_)) => Some(strs(b.get("allowed"))),
            _ => None,
        };
        let s = |k: &str| match b.get(k) {
            None | Some(Value::Null) => String::new(),
            Some(v) => js::string(v),
        };
        let (service, tool) = (s("service"), s("tool"));
        let mut rate = 0.0f64;
        let r = self.call_with(&passes, allowed.as_deref(), &service, &tool, b.get("args"), &mut rate).await;
        match r {
            Ok(result) => json!({ "status": 200, "body": { "result": result }, "rateLimitMs": rate }),
            Err((status, error)) => json!({ "status": status, "body": { "error": error }, "rateLimitMs": rate }),
        }
    }

    async fn call_with(&self, passes: &[String], allowed: Option<&[String]>, service: &str, tool: &str, args: Option<&Value>, rate: &mut f64) -> Result<Value, (u16, String)> {
        let all = self.blocking(|s| s.read()).await;
        let Some(p) = Self::find(&all, service, passes) else {
            let names: Vec<String> = passes
                .iter()
                .filter_map(|id| all.iter().find(|p| text_of(p.get("id")) == Some(id)))
                .filter_map(|p| p.get("name").filter(|n| js::truthy(Some(n))).map(js::string))
                .collect();
            let tail = if names.is_empty() { "It has no connections.".to_string() } else { format!("It can use: {}.", names.join(", ")) };
            return Err((404, format!("This automation can't use \"{service}\". {tail}")));
        };
        if !TOOL_NAME.is_match(tool) {
            return Err((400, "That isn't a tool name".into()));
        }
        let id = field(&p, "id");
        let key = format!("{id}:{tool}");
        if let Some(a) = allowed
            && !a.contains(&key)
        {
            return Err((
                403,
                format!(
                    "This automation may not use {}'s {tool}: it can only use the tools its check used when it was saved. Save it again to allow more.",
                    field(&p, "name")
                ),
            ));
        }
        let args = match args {
            Some(Value::Object(o)) => Value::Object(o.clone()),
            _ => json!({}),
        };
        match self.call(&id, tool, args).await {
            Ok(v) => Ok(v),
            Err(Fault::RateLimit(m, ms)) => {
                *rate = rate.max(ms);
                Err((502, self.mask(&m).await))
            }
            Err(Fault::Pass { status, msg, .. }) => Err((status, msg)),
            Err(e) => Err((502, self.mask(e.message()).await)),
        }
    }
}

/// The callback page's escape: `&<>"` as character references.
fn esc(x: &str) -> String {
    let mut out = String::with_capacity(x.len());
    for c in x.chars() {
        match c {
            '&' | '<' | '>' | '"' => out.push_str(&format!("&#{};", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests;
