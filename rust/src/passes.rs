//! The board's passes and saved keys (`/api/passes`), ported from `src/api/passes.ts` and `src/integrations/passes.ts`.
//! Rust answers:
//! - `GET /api/passes`: every pass as the UI may see it (no secrets), with the automations that use it;
//! - `POST /api/passes` for a key without an address (`kind: "key"`, no `url`): the Keys list and a board's keys;
//! - `PATCH /api/passes/<id>` (a new value for a key) and `DELETE /api/passes/<id>`.
//!
//! Everything else under `/api/passes` stays on Bun: other kinds of pass and keys for an online server (they need
//! WHATWG URL rules or Claude's settings), the sign-in (`authorize`, `oauth/callback`: Bun keeps the sign-in states
//! in memory) and `tools` (calls the service). A request Rust can't answer exactly as Bun would (a body or a passes
//! file only JS can parse, a field of an unexpected type, an id with escapes) is passed to Bun unchanged.
//!
//! Shared file: `automation-passes.json` (owner-only). Both sides change it read-modify-write under an exclusive
//! `flock` on `automation-passes.json.lock` (Bun opens it with O_EXLOCK, the same lock on macOS), and write it by
//! atomic rename, so neither can lose the other's change or see half a file. Bun reads the file again on every use
//! (its board-key cache is keyed by mtime, size and inode). After a change Rust tells Bun on the child's stdin
//! (`changed automation-passes.json`), and Bun sends the UI its `integration.updated` event, as after its own writes.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use bytes::Bytes;
use ckanban_core::DataDir;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::guard;
use crate::js;
use crate::mask;
use crate::proxy::Body;

pub const PASSES_FILE: &str = "automation-passes.json";
/// Bodies declared larger than this go to Bun unread (a pass is a few hundred bytes); a larger one sent without a
/// length gets 413.
const BODY_LIMIT: usize = 1 << 20;

/// Called after Rust changed the passes file: Bun hears of it and tells the UI.
pub type Notify = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Debug, PartialEq, Clone)]
pub enum Route {
    List,
    Add,
    Replace(String),
    Remove(String),
}

/// Which pass route Rust answers, if any: only these exact paths, ids as plain letters, digits, `_` and `-`.
pub fn route_of(method: &Method, path: &str) -> Option<Route> {
    let rest = path.strip_prefix("/api/passes")?;
    if rest.is_empty() {
        return match *method {
            Method::GET => Some(Route::List),
            Method::POST => Some(Route::Add),
            _ => None,
        };
    }
    let id = rest.strip_prefix('/')?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    match *method {
        Method::PATCH => Some(Route::Replace(id.to_string())),
        Method::DELETE => Some(Route::Remove(id.to_string())),
        _ => None,
    }
}

pub struct Passes {
    dir: DataDir,
    file: PathBuf,
    notify: Notify,
}

/// What a route decided: an answer, or Bun answers (the request goes on as it came).
pub enum Outcome {
    Answer(Response<Body>),
    Bun(Request<Body>),
}

/// The passes file as Bun's `read()` gives it, or None when only Bun can say (it exists but serde can't parse it, or
/// an entry isn't what Rust expects).
fn read_passes(file: &Path) -> Option<Vec<Value>> {
    let text = match fs::read(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    let v: Value = serde_json::from_slice(&text).ok()?;
    let passes = match v.get("passes") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let passes: Vec<Value> = passes.into_iter().map(ckanban_core::jsnum::normalize).collect();
    passes.iter().all(clean).then_some(passes)
}

/// Fields the routes read are absent, null or text (anything else makes Bun throw or print oddly: Bun answers).
fn clean(p: &Value) -> bool {
    let Some(o) = p.as_object() else { return false };
    ["id", "kind", "name", "claudeName", "url", "envName", "board", "status", "error", "createdAt", "savedAt", "secret"]
        .iter()
        .all(|k| matches!(o.get(*k), None | Some(Value::Null) | Some(Value::String(_))))
}

/// The secrets an answer must not show (`maskSavedJson`): read again for each answer, as Bun does.
pub fn current_secrets(root: &Path) -> Vec<String> {
    let file = root.join(PASSES_FILE);
    let passes = fs::read(&file)
        .ok()
        .and_then(|t| serde_json::from_slice::<Value>(&t).ok())
        .and_then(|v| v.get("passes").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    mask::saved_secrets(&passes)
}

/// A JSON answer as Bun's `json()` sends it: masked, `content-type: application/json`.
pub fn json_answer(status: StatusCode, v: &Value, secrets: &[String]) -> Response<Body> {
    let text = mask::mask_saved_json(secrets, &serde_json::to_string(v).unwrap_or_else(|_| "null".into()));
    let mut r = Response::new(Full::new(Bytes::from(text)).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    r
}

fn error(status: StatusCode, msg: impl Into<String>, secrets: &[String]) -> Response<Body> {
    json_answer(status, &json!({ "error": msg.into() }), secrets)
}

/// A pass error before anything was written (400, 404, 409).
struct Refused(StatusCode, String);

/// Holds `automation-passes.json.lock` exclusively until dropped (also released if this process dies).
struct FileLock(fs::File);

impl FileLock {
    fn take(file: &Path) -> std::io::Result<Self> {
        let mut lock = file.as_os_str().to_owned();
        lock.push(".lock");
        let f = OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(PathBuf::from(lock))?;
        // SAFETY: flock(2) on a descriptor this File owns.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(FileLock(f))
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        // SAFETY: as above; closing the file would release it too.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// `Passes.write`: `{ version: 1, passes }` as `JSON.stringify(f, null, 2)` writes it, owner-only, by atomic rename.
fn write_passes(file: &Path, passes: &[Value]) -> std::io::Result<()> {
    let mut f = Map::new();
    f.insert("version".into(), json!(1));
    f.insert("passes".into(), Value::Array(passes.to_vec()));
    let mut text = serde_json::to_string_pretty(&Value::Object(f)).map_err(std::io::Error::other)?;
    text.push('\n');
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", new_id()));
    let tmp = PathBuf::from(tmp);
    let r = (|| {
        let mut out = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        out.write_all(text.as_bytes())?;
        drop(out);
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        fs::rename(&tmp, file)
    })();
    if r.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    r
}

/// `newId()`: 8 random base36 characters.
fn new_id() -> String {
    const B36: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut b = [0u8; 8];
    if getrandom::fill(&mut b).is_err() {
        return ckanban_core::atomic::new_id();
    }
    b.iter().map(|x| B36[(*x % 36) as usize] as char).collect()
}

fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

/// `Passes.view`: what the UI may see of a pass, with its error masked by `maskText`.
fn view(p: &Value, pass_secrets: &[String]) -> Map<String, Value> {
    let o = p.as_object().expect("clean pass");
    let mut v = Map::new();
    let copy = |v: &mut Map<String, Value>, k: &str| {
        if let Some(x) = o.get(k) {
            v.insert(k.into(), x.clone());
        }
    };
    let or_null = |k: &str| o.get(k).filter(|x| !x.is_null()).cloned().unwrap_or(Value::Null);
    copy(&mut v, "id");
    copy(&mut v, "kind");
    copy(&mut v, "name");
    copy(&mut v, "claudeName");
    v.insert("url".into(), or_null("url"));
    v.insert("envName".into(), or_null("envName"));
    v.insert("board".into(), or_null("board"));
    copy(&mut v, "status");
    let err = match o.get("error") {
        Some(Value::String(e)) if !e.is_empty() => Value::String(mask::mask_text(e, pass_secrets)),
        _ => Value::Null,
    };
    v.insert("error".into(), err);
    copy(&mut v, "createdAt");
    // `p.savedAt ?? p.createdAt`: left out when both are missing.
    if let Some(s) = o.get("savedAt").filter(|x| !x.is_null()).or_else(|| o.get("createdAt")) {
        v.insert("savedAt".into(), s.clone());
    }
    v
}

/// `ENV_NAME` in passes.ts and `KEY_NAME` in board-keys.ts.
static ENV_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z_][A-Z0-9_]{0,63}$").unwrap());
/// `RESERVED_ENV` in passes.ts: names the board sets for scripts itself.
const RESERVED_ENV: [&str; 8] = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CKANBAN_PORT", "CKANBAN_CALL_TOKEN"];
/// `RESERVED` and `RESERVED_PREFIX` in board-keys.ts.
const RESERVED: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TMP", "TEMP", "PWD", "IFS", "PS4", "CDPATH", "BASH_ENV", "ENV", "ZDOTDIR",
    "PROMPT_COMMAND", "EDITOR", "VISUAL", "PAGER", "SSH_AUTH_SOCK", "GNUPGHOME", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
];
static RESERVED_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(CKANBAN_|CLAUDE|ANTHROPIC_|AWS_BEARER_TOKEN_BEDROCK|VERTEX_|GH_|DYLD_|LD_|NODE_|BUN_|npm_|GIT_|LC_|XDG_|SSL_|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|MCP_|OTEL_|DISABLE_|PYTHON)").unwrap()
});

/// `boardKeyEnv`: the environment variables a run on this board gets, each saved key under its name (never another
/// board's).
pub fn board_key_env(root: &Path, slug: &str) -> std::collections::BTreeMap<String, String> {
    let passes = fs::read(root.join(PASSES_FILE))
        .ok()
        .and_then(|t| serde_json::from_slice::<Value>(&t).ok())
        .and_then(|v| v.get("passes").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut out = std::collections::BTreeMap::new();
    for p in passes {
        let s = |k: &str| p.get(k).and_then(Value::as_str);
        let url = p.get("url").is_some_and(|u| !u.is_null() && u != "" && u != &Value::Bool(false));
        if s("kind") != Some("key") || s("board") != Some(slug) || url {
            continue;
        }
        let (Some(name), Some(secret)) = (s("envName"), s("secret")) else { continue };
        if secret.is_empty() || key_name_error(name).is_some() {
            continue;
        }
        out.insert(name.to_string(), secret.to_string());
    }
    out
}

/// `keyNameError`.
pub fn key_name_error(name: &str) -> Option<String> {
    if !ENV_NAME.is_match(name) {
        return Some(format!("\"{name}\" can't be a key's name: use capital letters, digits and _ (like SENTRY_AUTH_TOKEN)"));
    }
    if RESERVED.contains(&name) || RESERVED_PREFIX.is_match(name) {
        return Some(format!(
            "\"{name}\" is a name the board or Claude uses itself: pick another (like MY_{})",
            name.trim_start_matches('_')
        ));
    }
    None
}

/// `envNameFor`: "Linear API key" -> LINEAR_API_KEY.
pub fn env_name_for(name: &str) -> String {
    let upper = name.to_uppercase();
    let mut base = String::new();
    let mut gap = false;
    for c in upper.chars() {
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            base.push(c);
            gap = false;
        } else if !gap {
            base.push('_');
            gap = true;
        }
    }
    let mut base = base.trim_matches('_').to_string();
    if base.starts_with(|c: char| c.is_ascii_digit()) {
        base.insert(0, '_');
    }
    if base.is_empty() {
        return "API_KEY".into();
    }
    if base.ends_with("KEY") || base.ends_with("TOKEN") || base.ends_with("SECRET") { base } else { format!("{base}_KEY") }
}

/// `nameOr`: the name tidied (spaces squashed, at most 60 UTF-16 units) or the fallback. None: Bun must answer.
fn name_or(v: Option<&Value>, fallback: &str) -> Option<String> {
    let s = match v {
        Some(Value::String(s)) => js::slice_utf16(&js::squash_spaces(js::trim(s)), 60)?.to_string(),
        _ => String::new(),
    };
    Some(if s.is_empty() { fallback.to_string() } else { s })
}

fn one_line(s: &str) -> bool {
    !s.contains(['\r', '\n', '\0'])
}

impl Passes {
    pub fn new(root: PathBuf, notify: Notify) -> Self {
        let file = root.join(PASSES_FILE);
        Passes { dir: DataDir::new(root), file, notify }
    }

    fn secrets(&self) -> Vec<String> {
        current_secrets(&self.dir.root)
    }

    pub async fn answer(self: &Arc<Self>, route: Route, req: Request<Incoming>, peer_port: u16) -> Outcome {
        let req = req.map(|b| b.boxed());
        match route {
            Route::List => {
                let me = self.clone();
                match tokio::task::spawn_blocking(move || me.list()).await {
                    Ok(Some(v)) => Outcome::Answer(json_answer(StatusCode::OK, &v, &self.secrets())),
                    _ => Outcome::Bun(req),
                }
            }
            Route::Add => self.mutate(req, peer_port, "Connecting a service for automations", |me, body| me.add(body)).await,
            Route::Replace(id) => {
                self.mutate(req, peer_port, "Changing a service's connection for automations", move |me, body| me.replace(&id, body)).await
            }
            Route::Remove(id) => {
                self.mutate(req, peer_port, "Changing a service's connection for automations", move |me, _| me.remove(&id)).await
            }
        }
    }

    /// `userOnly`, then the body, then the change on a blocking thread under the file lock.
    async fn mutate<F>(self: &Arc<Self>, req: Request<Body>, peer_port: u16, what: &str, change: F) -> Outcome
    where
        F: FnOnce(&Passes, Option<Value>) -> Change + Send + 'static,
    {
        if !guard::user_only(req.headers(), peer_port).await {
            return Outcome::Answer(error(StatusCode::FORBIDDEN, guard::refusal(what), &self.secrets()));
        }
        let wants_body = req.method() != Method::DELETE;
        // A body declared bigger than Rust reads goes to Bun unread (Bun takes up to 128 MB).
        let declared = req.headers().get(hyper::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok());
        if wants_body && declared.is_some_and(|n| n > BODY_LIMIT as u64) {
            return Outcome::Bun(req);
        }
        let (parts, body) = req.into_parts();
        // DELETE: Bun never reads its body, so neither does Rust; it goes on untouched if Bun must answer.
        let (bytes, unread) = if wants_body {
            match Limited::new(body, BODY_LIMIT).collect().await {
                Ok(b) => (b.to_bytes(), None),
                // Only a body sent without a length can get here (chunked, over 1 MB): Bun would take it.
                Err(_) => return Outcome::Answer(error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large", &self.secrets())),
            }
        } else {
            (Bytes::new(), Some(body))
        };
        let again = move |bytes: Bytes| match unread {
            Some(body) => Request::from_parts(parts, body),
            None => Request::from_parts(parts, Full::new(bytes).map_err(|never| match never {}).boxed()),
        };
        let parsed = if wants_body {
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(v) => Some(ckanban_core::jsnum::normalize(v)),
                // Empty, not JSON, or JSON only JS reads (a lone surrogate): Bun says which.
                Err(_) => return Outcome::Bun(again(bytes)),
            }
        } else {
            None
        };
        let me = self.clone();
        let done = tokio::task::spawn_blocking(move || change(&me, parsed)).await;
        match done {
            Ok(Change::Done(status, v)) => {
                if status.is_success() {
                    (self.notify)(PASSES_FILE);
                }
                let secrets = self.secrets();
                Outcome::Answer(match v {
                    Some(v) => json_answer(status, &v, &secrets),
                    None => {
                        let mut r = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
                        *r.status_mut() = status;
                        r
                    }
                })
            }
            Ok(Change::Refused(Refused(status, msg))) => Outcome::Answer(error(status, msg, &self.secrets())),
            Ok(Change::Failed(e)) => {
                eprintln!("ckanban-rs: {PASSES_FILE}: {e}");
                Outcome::Answer(error(StatusCode::INTERNAL_SERVER_ERROR, e, &self.secrets()))
            }
            Ok(Change::Bun) | Err(_) => Outcome::Bun(again(bytes)),
        }
    }

    /// `saveBoardKeys` (a key box answered in a ticket's chat, board mode): each `(envName, name, secret)` saved as the
    /// board's key, replacing one with the same name. Returns the names saved. Blocking.
    pub fn save_board_keys(&self, slug: &str, keys: &[(String, Option<Value>, Value)]) -> Result<Vec<String>, (u16, String)> {
        if slug.is_empty() {
            return Err((400, "Which board are the keys for?".into()));
        }
        let mut clean = Vec::new();
        for (env, name, secret) in keys {
            let env = js::trim(env).to_string();
            if let Some(bad) = key_name_error(&env) {
                return Err((400, bad));
            }
            let secret = secret.as_str().map(|s| js::trim(s).to_string()).unwrap_or_default();
            if secret.is_empty() {
                return Err((400, format!("Paste the key for {env}")));
            }
            if !one_line(&secret) {
                return Err((400, format!("The key for {env} must be on one line")));
            }
            let name = name_or(name.as_ref(), &env).ok_or((400, format!("The name for {env} can't be read")))?;
            clean.push((env, secret, name));
        }
        if clean.is_empty() {
            return Ok(Vec::new());
        }
        let _lock = FileLock::take(&self.file).map_err(|e| (500, format!("can't lock {PASSES_FILE}: {e}")))?;
        let mut passes = read_passes(&self.file).ok_or((500, format!("{PASSES_FILE} can't be read")))?;
        let now = now_iso();
        for (env, secret, name) in &clean {
            let same = |p: &Value| {
                p.get("kind").and_then(Value::as_str) == Some("key")
                    && p.get("board").and_then(Value::as_str) == Some(slug)
                    && p.get("envName").and_then(Value::as_str) == Some(env)
                    && !ckanban_core::jsnum::truthy(p.get("url"))
            };
            match passes.iter().position(same) {
                Some(i) => {
                    let p = passes[i].as_object_mut().expect("a pass is an object");
                    p.insert("secret".into(), json!(secret));
                    p.insert("name".into(), json!(name));
                    p.insert("status".into(), json!("connected"));
                    p.insert("error".into(), Value::Null);
                    p.insert("savedAt".into(), json!(now));
                }
                None => passes.push(json!({
                    "id": new_id(), "kind": "key", "name": name, "claudeName": null, "envName": env, "board": slug,
                    "secret": secret, "status": "connected", "error": null, "createdAt": now, "savedAt": now,
                })),
            }
        }
        write_passes(&self.file, &passes).map_err(|e| (500, e.to_string()))?;
        (self.notify)(PASSES_FILE);
        Ok(clean.into_iter().map(|(env, _, _)| env).collect())
    }

    /// `GET /api/passes`. None: Bun answers.
    fn list(&self) -> Option<Value> {
        let passes = read_passes(&self.file)?;
        let profiles = self.dir.list_profiles().ok()?;
        let mut used: Vec<(String, u64, Vec<Value>)> = Vec::new();
        let mut automations = 0u64;
        for p in &profiles {
            let loops = list_loops(&self.dir.profile_dir(p.slug()?).join("loops"))?;
            automations += loops.len() as u64;
            for l in &loops {
                let ids = match l.get("passes") {
                    None | Some(Value::Null) => continue,
                    Some(Value::Array(a)) => a,
                    // Bun's for...of throws on anything else: let it answer.
                    Some(_) => return None,
                };
                let name = l.get("name").cloned().unwrap_or(Value::Null);
                for id in ids.iter().filter_map(Value::as_str) {
                    match used.iter_mut().find(|u| u.0 == id) {
                        Some(u) => {
                            u.1 += 1;
                            u.2.push(name.clone());
                        }
                        None => used.push((id.to_string(), 1, vec![name.clone()])),
                    }
                }
            }
        }
        let secrets6 = mask::pass_secrets(&passes);
        let list: Vec<Value> = passes
            .iter()
            .map(|p| {
                let mut v = view(p, &secrets6);
                let id = p.get("id").and_then(Value::as_str);
                let u = id.and_then(|id| used.iter().find(|u| u.0 == id));
                v.insert("usedBy".into(), json!(u.map_or(0, |u| u.1)));
                v.insert("usedByNames".into(), Value::Array(u.map(|u| u.2.clone()).unwrap_or_default()));
                let board_name = match p.get("board").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    None => Value::Null,
                    Some(s) => {
                        let name = self.dir.profile(s).map(|pr| pr.name()).filter(|n| js::truthy(Some(n)));
                        name.unwrap_or_else(|| Value::String(s.to_string()))
                    }
                };
                v.insert("boardName".into(), board_name);
                Value::Object(v)
            })
            .collect();
        Some(json!({ "passes": list, "automations": automations }))
    }

    /// `POST /api/passes` for a key without an address; other kinds go to Bun.
    fn add(&self, body: Option<Value>) -> Change {
        let b = match body {
            Some(Value::Object(o)) => o,
            // null is `{}` in Bun: kind "" is a 400 there; let it say so. Other shapes likewise.
            _ => return Change::Bun,
        };
        if b.get("kind") != Some(&Value::String("key".into())) || js::truthy(b.get("url")) {
            return Change::Bun;
        }
        // The route's board check comes first.
        let board = match b.get("board") {
            None | Some(Value::Null) => None,
            // path.join and PathBuf::join differ on "/x" and "..": Bun decides those.
            Some(Value::String(s)) if s.starts_with('/') || s.contains("..") => return Change::Bun,
            Some(Value::String(s)) if self.dir.profile(s).is_some() => Some(s.clone()),
            Some(_) => return Change::Refused(Refused(StatusCode::BAD_REQUEST, "That board doesn't exist".into())),
        };
        let claude_name = match b.get("claudeName") {
            Some(Value::String(s)) if !js::trim(s).is_empty() => Some(js::trim(s).to_string()),
            _ => None,
        };
        let secret = match b.get("secret") {
            Some(Value::String(s)) => js::trim(s).to_string(),
            _ => String::new(),
        };
        if secret.is_empty() {
            return Change::refused(400, "Paste the key");
        }
        if !one_line(&secret) {
            return Change::refused(400, "The key must be on one line");
        }
        let Some(name) = name_or(b.get("name"), claude_name.as_deref().unwrap_or("")) else { return Change::Bun };
        if name.is_empty() {
            return Change::refused(400, "Give the key a name, e.g. Jira");
        }
        // `typeof input.board === "string" && input.board`: "" is no board.
        let board = board.filter(|s| !s.is_empty());
        let env_name = match b.get("envName") {
            Some(Value::String(s)) if !js::trim(s).is_empty() => js::trim(s).to_string(),
            _ => env_name_for(&name),
        };
        if !ENV_NAME.is_match(&env_name) || RESERVED_ENV.contains(&env_name.as_str()) {
            return Change::refused(400, format!("\"{env_name}\" can't be used as the key's name for scripts: use capital letters, digits and _"));
        }
        if board.is_some()
            && let Some(bad) = key_name_error(&env_name)
        {
            return Change::refused(400, bad);
        }
        self.locked(|passes| {
            let board_v = board.clone().map(Value::String).unwrap_or(Value::Null);
            let taken = passes.iter().any(|x| {
                x.get("envName") == Some(&Value::String(env_name.clone())) && x.get("board").cloned().unwrap_or(Value::Null) == board_v
            });
            if taken {
                return Err(Refused(StatusCode::CONFLICT, format!("A key named {env_name} already exists: replace that one instead")));
            }
            let mut p = Map::new();
            p.insert("id".into(), json!(new_id()));
            p.insert("claudeName".into(), claude_name.clone().map(Value::String).unwrap_or(Value::Null));
            p.insert("error".into(), Value::Null);
            p.insert("createdAt".into(), json!(now_iso()));
            p.insert("kind".into(), json!("key"));
            p.insert("name".into(), json!(name));
            p.insert("envName".into(), json!(env_name));
            if let Some(b) = &board {
                p.insert("board".into(), json!(b));
            }
            p.insert("secret".into(), json!(secret));
            p.insert("status".into(), json!("connected"));
            let p = Value::Object(p);
            passes.push(p.clone());
            Ok((StatusCode::CREATED, p))
        })
    }

    /// `PATCH /api/passes/<id>`: a new value for a key.
    fn replace(&self, id: &str, body: Option<Value>) -> Change {
        let secret = body.as_ref().and_then(Value::as_object).and_then(|o| o.get("secret")).cloned();
        self.locked(|passes| {
            let i = find(passes, id)?;
            if passes[i].get("kind").and_then(Value::as_str) != Some("key") {
                return Err(Refused(StatusCode::BAD_REQUEST, "Only a key can be replaced".into()));
            }
            let s = match &secret {
                Some(Value::String(s)) => js::trim(s).to_string(),
                _ => String::new(),
            };
            if s.is_empty() || !one_line(&s) {
                return Err(Refused(StatusCode::BAD_REQUEST, "Paste the new key on one line".into()));
            }
            let o = passes[i].as_object_mut().expect("clean pass");
            o.insert("secret".into(), json!(s));
            o.insert("status".into(), json!("connected"));
            o.insert("error".into(), Value::Null);
            o.insert("savedAt".into(), json!(now_iso()));
            Ok((StatusCode::OK, passes[i].clone()))
        })
    }

    /// `DELETE /api/passes/<id>`.
    fn remove(&self, id: &str) -> Change {
        match self.locked(|passes| {
            find(passes, id)?;
            passes.retain(|p| p.get("id").and_then(Value::as_str) != Some(id));
            Ok((StatusCode::NO_CONTENT, Value::Null))
        }) {
            Change::Done(status, _) => Change::Done(status, None),
            other => other,
        }
    }

    /// Reads the file under the lock, lets `f` change the list, writes it back; the answer is the changed pass's view.
    fn locked(&self, f: impl FnOnce(&mut Vec<Value>) -> Result<(StatusCode, Value), Refused>) -> Change {
        let _lock = match FileLock::take(&self.file) {
            Ok(l) => l,
            Err(e) => return Change::Failed(format!("can't lock {PASSES_FILE}: {e}")),
        };
        let Some(mut passes) = read_passes(&self.file) else { return Change::Bun };
        let (status, p) = match f(&mut passes) {
            Ok(x) => x,
            Err(r) => return Change::Refused(r),
        };
        if let Err(e) = write_passes(&self.file, &passes) {
            return Change::Failed(e.to_string());
        }
        if p.is_null() {
            return Change::Done(status, Some(Value::Null));
        }
        Change::Done(status, Some(Value::Object(view(&p, &mask::pass_secrets(&passes)))))
    }
}

/// `Passes.require`: the first pass with this id, else 404.
fn find(passes: &[Value], id: &str) -> Result<usize, Refused> {
    passes
        .iter()
        .position(|p| p.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| Refused(StatusCode::NOT_FOUND, "That connection no longer exists".into()))
}

enum Change {
    Done(StatusCode, Option<Value>),
    Refused(Refused),
    Failed(String),
    Bun,
}

impl Change {
    fn refused(status: u16, msg: impl Into<String>) -> Change {
        Change::Refused(Refused(StatusCode::from_u16(status).expect("status"), msg.into()))
    }
}

/// `Store.listLoops`: a board's automations (`loops/<id>.json`), oldest first. Automations are a handful of small files
/// per board, so they are read on each call (Bun keeps them parsed in memory). None: Bun answers.
fn list_loops(dir: &Path) -> Option<Vec<Value>> {
    static ID_JSON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+\.json$").unwrap());
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Some(Vec::new()),
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str().filter(|n| ID_JSON.is_match(n)) else { continue };
        let Ok(text) = fs::read(dir.join(name)) else { continue };
        match serde_json::from_slice::<Value>(&text) {
            Ok(Value::Null) => {}
            Ok(v) => out.push(v),
            // JS might read what serde can't (a lone surrogate): only Bun knows whether it's an automation.
            Err(e) if e.is_syntax() || e.is_eof() => {}
            Err(_) => return None,
        }
    }
    out.sort_by(|a, b| js::cmp_str(a.get("createdAt"), b.get("createdAt")));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_pass_routes_are_rust_s() {
        assert_eq!(route_of(&Method::GET, "/api/passes"), Some(Route::List));
        assert_eq!(route_of(&Method::POST, "/api/passes"), Some(Route::Add));
        assert_eq!(route_of(&Method::PATCH, "/api/passes/abc12"), Some(Route::Replace("abc12".into())));
        assert_eq!(route_of(&Method::DELETE, "/api/passes/abc12"), Some(Route::Remove("abc12".into())));
        for (m, p) in [
            (Method::GET, "/api/passes/"),
            (Method::HEAD, "/api/passes"),
            (Method::PUT, "/api/passes"),
            (Method::GET, "/api/passes/abc/tools"),
            (Method::POST, "/api/passes/abc/authorize"),
            (Method::GET, "/api/passes/oauth/callback"),
            (Method::PATCH, "/api/passes/a%62c"),
            (Method::DELETE, "/api/passes/abc/"),
            (Method::GET, "/api/passesx"),
            (Method::GET, "/api/passes/abc"),
        ] {
            assert_eq!(route_of(&m, p), None, "{m} {p}");
        }
    }

    #[test]
    fn names_like_bun() {
        assert_eq!(env_name_for("Linear API key"), "LINEAR_API_KEY");
        assert_eq!(env_name_for("Sentry token"), "SENTRY_TOKEN");
        assert_eq!(env_name_for("3d  printer"), "_3D_PRINTER_KEY");
        assert_eq!(env_name_for("!!!"), "API_KEY");
        assert_eq!(env_name_for("straße"), "STRASSE_KEY");
        assert_eq!(key_name_error("SENTRY_AUTH_TOKEN"), None);
        assert!(key_name_error("GITHUB_TOKEN").unwrap().contains("pick another (like MY_GITHUB_TOKEN)"));
        assert!(key_name_error("__CLAUDE_X").is_none());
        assert!(key_name_error("CLAUDE_X").unwrap().contains("like MY_CLAUDE_X"));
        assert!(key_name_error("lower").unwrap().contains("can't be a key's name"));
        assert_eq!(name_or(Some(&json!("  a \n b  ")), "x"), Some("a b".into()));
        assert_eq!(name_or(Some(&json!(5)), "fallback"), Some("fallback".into()));
    }

    #[test]
    fn view_hides_secrets_and_fills_defaults() {
        let p = json!({ "id": "a1", "kind": "key", "name": "N", "claudeName": null, "envName": "N_KEY", "secret": "s3cr3t-value",
            "status": "needs_reconnect", "error": "failed with s3cr3t-value", "createdAt": "2026-01-01T00:00:00.000Z" });
        let v = Value::Object(view(&p, &mask::pass_secrets(&[p.clone()])));
        assert_eq!(
            serde_json::to_string(&v).unwrap(),
            r#"{"id":"a1","kind":"key","name":"N","claudeName":null,"url":null,"envName":"N_KEY","board":null,"status":"needs_reconnect","error":"failed with ***","createdAt":"2026-01-01T00:00:00.000Z","savedAt":"2026-01-01T00:00:00.000Z"}"#
        );
    }

    #[test]
    fn writes_like_json_stringify_and_owner_only() {
        let dir = std::env::temp_dir().join(format!("ckrs-passes-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join(PASSES_FILE);
        write_passes(&f, &[json!({ "id": "a", "n": 1.5, "x": [] })]).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "{\n  \"version\": 1,\n  \"passes\": [\n    {\n      \"id\": \"a\",\n      \"n\": 1.5,\n      \"x\": []\n    }\n  ]\n}\n");
        assert_eq!(fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
        let _lock = FileLock::take(&f).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        let _ = fs::remove_dir_all(dir);
    }
}
