//! The pure parts of `src/integrations/mcp.ts` and `board-tools.ts`: reading `claude mcp list|get` and a session's
//! `init` event, scopes, the `claude mcp add` arguments, form inputs and stored entries, and error texts.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::js;
use crate::mask::mask_secrets;

/// The board's own MCP server name (`ckanban mcp`).
pub const OWN: &str = "ckanban";
pub const CANT_READ: &str = "Can't move: the board can't read back how this tool was set up.";

/// `McpError`: an answer `{error}` with a status.
#[derive(Debug, Clone, PartialEq)]
pub struct McpError(pub u16, pub String);

impl McpError {
    pub fn new(status: u16, msg: impl Into<String>) -> Self {
        McpError(status, msg.into())
    }
}

fn re(s: &str) -> Regex {
    Regex::new(s).unwrap()
}

/// A server as `claude mcp list` gives it (the fields of `Parsed`, in Bun's key order).
pub type Obj = Map<String, Value>;

pub fn s<'a>(o: &'a Obj, k: &str) -> &'a str {
    o.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `status` from a CLI status text.
pub fn status_of(text: &str) -> &'static str {
    let t = text.to_lowercase();
    if t.contains("needs auth") {
        "needs_auth"
    } else if t.contains("fail") || t.contains("error") {
        "failed"
    } else if t.contains("pending") {
        "pending"
    } else if t.contains("connected") {
        "connected"
    } else {
        "unknown"
    }
}

static LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^[^\p{L}\p{N}]+"));

/// `splitStatus`: "✔ Connected" → (connected, null); "✘ Failed to connect — X" → (failed, "Failed to connect — X").
pub fn split_status(raw: &str) -> (&'static str, Option<String>) {
    let text = LEAD.replace(raw, "");
    let text = js::trim(&text).to_string();
    let status = status_of(&text);
    let message = if status == "connected" || text.is_empty() { None } else { Some(text) };
    (status, message)
}

static DASH: LazyLock<Regex> = LazyLock::new(|| re(r"\s-\s[^\p{L}\p{N}\s]"));
static DASH_LEAD: LazyLock<Regex> = LazyLock::new(|| re(r"^\s-\s"));
static SUFFIX: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\s\((HTTP|SSE|STDIO)\)$"));
static HEALTH: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^checking mcp server health"));
static NONE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^no mcp servers configured"));

/// `parseMcpList`: servers `{name, target, transport, status, message}` and the lines it couldn't read.
pub fn parse_mcp_list(text: &str) -> (Vec<Obj>, Vec<String>) {
    let mut servers = Vec::new();
    let mut unparsed = Vec::new();
    for raw in text.split('\n') {
        let line = js::trim(raw);
        if line.is_empty() || HEALTH.is_match(line) || NONE.is_match(line) {
            continue;
        }
        let colon = line.find(": ");
        let (Some(colon), true) = (colon, colon.is_some_and(|c| c > 0)) else {
            unparsed.push(line.to_string());
            continue;
        };
        let rest = &line[colon + 2..];
        let Some(dash) = DASH.find(rest).map(|m| m.start()) else {
            unparsed.push(line.to_string());
            continue;
        };
        let name = &line[..colon];
        let mut target = js::trim(&rest[..dash]).to_string();
        let status_text = DASH_LEAD.replace(&rest[dash..], "").into_owned();
        let transport = if let Some(c) = SUFFIX.captures(&target) {
            let t = c[1].to_lowercase();
            let cut = c.get(0).unwrap().start();
            target.truncate(cut);
            t
        } else if target.starts_with("http://") || target.starts_with("https://") {
            "http".into()
        } else {
            "stdio".into()
        };
        let (status, message) = split_status(&status_text);
        let mut o = Obj::new();
        o.insert("name".into(), json!(name));
        o.insert("target".into(), json!(mask_secrets(&target)));
        o.insert("transport".into(), json!(transport));
        o.insert("status".into(), json!(status));
        o.insert("message".into(), json!(message));
        servers.push(o);
    }
    (servers, unparsed)
}

static STATUS_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*Status:\s*(.+)$"));
static ISSUE_LINE: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^\s*Issue:\s*(.+)$"));

/// `parseMcpGet`: the `Status:` and `Issue:` lines of `claude mcp get <name>`.
pub fn parse_mcp_get(text: &str) -> Option<(&'static str, Option<String>)> {
    let status = STATUS_LINE.captures(text)?;
    let (st, mut message) = split_status(&status[1]);
    if let Some(issue) = ISSUE_LINE.captures(text)
        && st != "connected"
    {
        let joined = format!("{} — {}", message.clone().unwrap_or_default(), js::trim(&issue[1]));
        message = Some(joined.strip_prefix(" — ").map(str::to_string).unwrap_or(joined));
    }
    Some((st, message))
}

/// Statuses from a session's `init` event, by server name.
pub type Session = Vec<(String, &'static str)>;

pub fn session_get(s: Option<&Session>, name: &str) -> Option<&'static str> {
    s?.iter().find(|(n, _)| n == name).map(|(_, st)| *st)
}

/// `parseSessionInit`: server statuses of a stream-json `system`/`init` line; None for any other line.
pub fn parse_session_init(line: &str) -> Option<Session> {
    let d: Value = serde_json::from_str(line).ok()?;
    if d.get("type").and_then(Value::as_str) != Some("system") || d.get("subtype").and_then(Value::as_str) != Some("init") {
        return None;
    }
    let list = d.get("mcp_servers")?.as_array()?;
    let mut out: Session = Vec::new();
    for s in list {
        let status = match s.get("status").map(js::string).as_deref() {
            Some("connected") => "connected",
            Some("needs-auth") => "needs_auth",
            Some("failed") => "failed",
            Some("pending") => "pending",
            _ => continue,
        };
        if let Some(name) = s.get("name").and_then(Value::as_str) {
            out.retain(|(n, _)| n != name);
            out.push((name.to_string(), status));
        }
    }
    Some(out)
}

/// `applySessionStatus`: what a session sees wins over the list.
pub fn apply_session_status(mut o: Obj, session: Option<&Session>) -> Obj {
    let Some(status) = session_get(session, s(&o, "name")) else { return o };
    if status == s(&o, "status") {
        return o;
    }
    let message = match status {
        "connected" => Value::Null,
        "needs_auth" => json!("Needs authentication"),
        "failed" => match o.get("message") {
            Some(Value::Null) | None => json!("Failed to connect in Claude sessions"),
            Some(m) => m.clone(),
        },
        _ => o.get("message").cloned().unwrap_or(Value::Null),
    };
    o.insert("status".into(), json!(status));
    o.insert("message".into(), message);
    o
}

/// Server names per scope in Claude's config files, seen from `cwd`.
pub struct Scopes {
    pub user: HashSet<String>,
    pub local: HashSet<String>,
    pub project: HashSet<String>,
}

/// `scopeOf`.
pub fn scope_of(name: &str, cfg: &Scopes) -> &'static str {
    if name.starts_with("claude.ai ") {
        "claude.ai"
    } else if cfg.local.contains(name) {
        "local"
    } else if cfg.project.contains(name) {
        "project"
    } else if cfg.user.contains(name) {
        "user"
    } else {
        "other"
    }
}

/// `readJson`: the file's JSON, or None when missing or unreadable.
pub fn read_json(path: &Path) -> Option<Value> {
    let t = std::fs::read_to_string(path).ok()?;
    ckanban_core::datafile::parse_json(&t)
}

fn cwd_key(cwd: &Path) -> String {
    cwd.to_string_lossy().into_owned()
}

/// `configScopes`.
pub fn config_scopes(cwd: &Path, config_file: &Path) -> Scopes {
    let cfg = read_json(config_file).unwrap_or(Value::Null);
    let keys = |o: Option<&Value>| -> HashSet<String> { o.and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default() };
    let project = read_json(&cwd.join(".mcp.json"));
    Scopes {
        user: keys(cfg.get("mcpServers")),
        local: keys(cfg.get("projects").and_then(|p| p.get(cwd_key(cwd))).and_then(|p| p.get("mcpServers"))),
        project: keys(project.as_ref().and_then(|p| p.get("mcpServers"))),
    }
}

static SAFE: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9_@%+=:,./-]+$"));

/// `shellQuote`.
pub fn shell_quote(s: &str) -> String {
    if SAFE.is_match(s) { s.to_string() } else { format!("'{}'", s.replace('\'', "'\\''")) }
}

/// `String(x)` with undefined for a missing value.
pub fn jstr(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => js::string(v),
    }
}

/// `String(x ?? fallback)`.
pub fn jstr_or(v: Option<&Value>, fallback: &str) -> String {
    match v {
        None | Some(Value::Null) => fallback.into(),
        Some(v) => js::string(v),
    }
}

/// `Object.entries(o)` as (key, `String(value)`) pairs; empty for a value that isn't an object.
fn entries(o: Option<&Value>) -> Vec<(String, String)> {
    match o {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), js::string(v))).collect(),
        // Object.entries of a string or array lists its indices: such configs aren't hand-written; treat as none.
        _ => Vec::new(),
    }
}

fn pairs_json(pairs: &[(String, String)], k: &str, v: &str) -> Value {
    Value::Array(pairs.iter().map(|(a, b)| json!({ k: a, v: b })).collect())
}

/// `commandLineOf`.
pub fn command_line_of(command: &str, args: &[String], env: &[(String, String)]) -> String {
    env.iter()
        .map(|(k, v)| format!("{k}={}", shell_quote(v)))
        .chain(std::iter::once(shell_quote(command)))
        .chain(args.iter().map(|a| shell_quote(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `readMcpConfig`: a server's saved settings (unmasked) from Claude's config files; None when it isn't in them.
pub fn read_mcp_config(name: &str, cwd: &Path, config_file: &Path) -> Option<Value> {
    let cfg = read_json(config_file).unwrap_or(Value::Null);
    let project = read_json(&cwd.join(".mcp.json"));
    let sources: [(&str, Option<&Value>); 3] = [
        ("local", cfg.get("projects").and_then(|p| p.get(cwd_key(cwd))).and_then(|p| p.get("mcpServers"))),
        ("project", project.as_ref().and_then(|p| p.get("mcpServers"))),
        ("user", cfg.get("mcpServers")),
    ];
    for (scope, servers) in sources {
        let Some(e) = servers.and_then(Value::as_object).and_then(|m| m.get(name)) else { continue };
        if !(e.is_object() || e.is_array()) {
            continue;
        }
        let kind = match e.get("type") {
            Some(t) if !t.is_null() => js::string(t),
            _ => if js::truthy(e.get("url")) { "http".into() } else { "stdio".into() },
        };
        if kind == "http" || kind == "sse" {
            let headers = entries(e.get("headers"));
            return Some(json!({ "name": name, "scope": scope, "transport": kind, "url": jstr_or(e.get("url"), ""),
                "headers": pairs_json(&headers, "name", "value"), "commandLine": null }));
        }
        let command = jstr_or(e.get("command"), "");
        let args: Vec<String> = e.get("args").and_then(Value::as_array).map(|a| a.iter().map(js::string).collect()).unwrap_or_default();
        let env = entries(e.get("env"));
        let line = command_line_of(&command, &args, &env);
        return Some(json!({ "name": name, "scope": scope, "transport": "stdio", "command": command, "args": args,
            "env": pairs_json(&env, "key", "value"), "commandLine": line }));
    }
    None
}

/// `userEntry`: a tool's raw entry in Claude's user config, or None.
pub fn user_entry(name: &str, config_file: &Path) -> Option<Obj> {
    read_json(config_file)?.get("mcpServers")?.get(name)?.as_object().cloned()
}

/// `canLogin`.
pub fn can_login(transport: Option<&str>, scope: &str) -> bool {
    scope == "claude.ai" || matches!(transport, Some("http" | "sse"))
}

static NAME: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$"));
static ENV_KEY: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z_][A-Za-z0-9_]*$"));
static HEADER: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$"));
static WEB: LazyLock<Regex> = LazyLock::new(|| re(r"^https?://\S+$"));

fn no_newline(v: String, what: &str) -> Result<String, McpError> {
    if v.contains(['\r', '\n', '\0']) { Err(McpError::new(400, format!("{what} must be on one line"))) } else { Ok(v) }
}

/// `(x ?? [])` as a list; a value that isn't an array makes Bun throw a TypeError (500).
fn list<'a>(v: Option<&'a Value>, what: &str) -> Result<Vec<&'a Value>, McpError> {
    match v {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.iter().collect()),
        Some(_) => Err(McpError::new(500, format!("input.{what}.filter is not a function"))),
    }
}

fn field<'a>(o: &'a Value, k: &str) -> Option<&'a Value> {
    o.as_object().and_then(|m| m.get(k))
}

/// `addArgs`: argv for `claude mcp add` (user scope). Never goes through a shell.
pub fn add_args(input: &Value) -> Result<Vec<String>, McpError> {
    let name = js::trim(&jstr_or(field(input, "name"), "")).to_string();
    if !NAME.is_match(&name) {
        return Err(McpError::new(400, "name: letters, digits, dot, dash and underscore only"));
    }
    let transport = field(input, "transport").and_then(Value::as_str).unwrap_or("");
    if transport == "stdio" {
        let command = js::trim(&jstr_or(field(input, "command"), "")).to_string();
        if command.is_empty() {
            return Err(McpError::new(400, "command is required"));
        }
        let mut env = Vec::new();
        for e in list(field(input, "env"), "env")? {
            if !(js::truthy(field(e, "key")) || js::truthy(field(e, "value"))) {
                continue;
            }
            let key = jstr(field(e, "key"));
            if !ENV_KEY.is_match(&key) {
                return Err(McpError::new(400, format!("invalid environment variable name: {key}")));
            }
            env.push("-e".to_string());
            env.push(format!("{key}={}", no_newline(jstr(field(e, "value")), &key)?));
        }
        let mut args = Vec::new();
        for a in list(field(input, "args"), "args")? {
            args.push(no_newline(js::string(a), "arguments")?);
        }
        let mut out: Vec<String> = ["mcp", "add", "--scope", "user", "--transport", "stdio"].iter().map(|x| x.to_string()).collect();
        out.push(name);
        out.extend(env);
        out.push("--".into());
        out.push(no_newline(command, "command")?);
        out.extend(args);
        return Ok(out);
    }
    if transport == "http" || transport == "sse" {
        let url = no_newline(js::trim(&jstr_or(field(input, "url"), "")).to_string(), "URL")?;
        if !WEB.is_match(&url) {
            return Err(McpError::new(400, "URL must start with http:// or https://"));
        }
        let mut headers = Vec::new();
        for h in list(field(input, "headers"), "headers")? {
            if !(js::truthy(field(h, "name")) || js::truthy(field(h, "value"))) {
                continue;
            }
            let hn = jstr(field(h, "name"));
            if !HEADER.is_match(&hn) {
                return Err(McpError::new(400, format!("invalid header name: {hn}")));
            }
            headers.push("-H".to_string());
            headers.push(format!("{hn}: {}", no_newline(jstr(field(h, "value")), &hn)?));
        }
        let mut out: Vec<String> = ["mcp", "add", "--scope", "user", "--transport"].iter().map(|x| x.to_string()).collect();
        out.push(transport.into());
        out.push(name);
        out.push(url);
        out.extend(headers);
        return Ok(out);
    }
    Err(McpError::new(400, "transport must be stdio, http or sse"))
}

/// `entryFromInput`: the stored entry for a form input (already checked with `add_args`).
pub fn entry_from_input(input: &Value) -> Obj {
    let mut o = Obj::new();
    let transport = jstr(field(input, "transport"));
    if transport == "stdio" {
        let mut env = Obj::new();
        for e in list(field(input, "env"), "env").unwrap_or_default() {
            if js::truthy(field(e, "key")) || js::truthy(field(e, "value")) {
                env.insert(js::trim(&jstr(field(e, "key"))).to_string(), json!(jstr(field(e, "value"))));
            }
        }
        o.insert("type".into(), json!("stdio"));
        o.insert("command".into(), json!(js::trim(&jstr_or(field(input, "command"), ""))));
        let args: Vec<String> = list(field(input, "args"), "args").unwrap_or_default().into_iter().map(js::string).collect();
        o.insert("args".into(), json!(args));
        if !env.is_empty() {
            o.insert("env".into(), Value::Object(env));
        }
        return o;
    }
    let mut headers = Obj::new();
    for h in list(field(input, "headers"), "headers").unwrap_or_default() {
        if js::truthy(field(h, "name")) || js::truthy(field(h, "value")) {
            headers.insert(js::trim(&jstr(field(h, "name"))).to_string(), json!(jstr(field(h, "value"))));
        }
    }
    o.insert("type".into(), json!(transport));
    o.insert("url".into(), json!(js::trim(&jstr_or(field(input, "url"), ""))));
    if !headers.is_empty() {
        o.insert("headers".into(), Value::Object(headers));
    }
    o
}

/// `inputFromEntry`: the form input for a stored entry; None for a shape the board can't read back.
pub fn input_from_entry(name: &str, e: &Obj) -> Option<Value> {
    let kind = match e.get("type") {
        Some(t) if !t.is_null() => js::string(t),
        _ => if js::truthy(e.get("url")) { "http".into() } else { "stdio".into() },
    };
    let pairs = |v: Option<&Value>| -> Option<Vec<(String, String)>> {
        match v {
            None => Some(Vec::new()),
            Some(Value::Object(m)) => Some(m.iter().map(|(k, v)| (k.clone(), js::string(v))).collect()),
            _ => None,
        }
    };
    if kind == "http" || kind == "sse" {
        let headers = pairs(e.get("headers"))?;
        let url = e.get("url").and_then(Value::as_str).filter(|u| !u.is_empty())?;
        return Some(json!({ "name": name, "transport": kind, "url": url, "headers": pairs_json(&headers, "name", "value") }));
    }
    if kind != "stdio" {
        return None;
    }
    let env = pairs(e.get("env"))?;
    let command = e.get("command").and_then(Value::as_str).filter(|c| !c.is_empty())?;
    let args: Vec<String> = match e.get("args") {
        None => Vec::new(),
        Some(Value::Array(a)) => a.iter().map(js::string).collect(),
        Some(_) => return None,
    };
    Some(json!({ "name": name, "transport": "stdio", "command": command, "args": args, "env": pairs_json(&env, "key", "value") }))
}

/// `movableInput`: the form input for an entry, only if `claude mcp add` takes it back as it is.
pub fn movable_input(name: &str, e: Option<&Obj>) -> Option<Value> {
    let input = input_from_entry(name, e?)?;
    add_args(&input).ok().map(|_| input)
}

/// `secretsOf`: header and env values of a tool, to cut from error text.
pub fn secrets_of(input: Option<&Value>) -> Vec<String> {
    let Some(input) = input else { return Vec::new() };
    let vals = |k: &str, f: &str| -> Vec<String> {
        input.get(k).and_then(Value::as_array).map(|a| a.iter().map(|x| jstr(x.get(f))).collect()).unwrap_or_default()
    };
    let mut out = vals("env", "value");
    out.extend(vals("headers", "value"));
    out
}

/// What a CLI command gave.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// `errorText`.
pub fn error_text(r: &RunOut, what: &str, secrets: &[String]) -> String {
    let text = {
        let e = js::trim(&r.stderr);
        if e.is_empty() { js::trim(&r.stdout) } else { e }
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let mut text = lines[lines.len().saturating_sub(5)..].join("\n");
    for v in secrets {
        if v.encode_utf16().count() >= 4 {
            text = text.replace(v.as_str(), "***");
        }
    }
    let masked = mask_secrets(&text);
    format!("{what} failed: {}", if masked.is_empty() { format!("exit code {}", r.code) } else { masked })
}

static OSC: LazyLock<Regex> = LazyLock::new(|| re(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"));
static CSI: LazyLock<Regex> = LazyLock::new(|| re(r"\x1b\[[0-9;?]*[A-Za-z]"));
static URL: LazyLock<Regex> = LazyLock::new(|| re(r"https?://[^\s\x07\x1b]+"));

/// `stripAnsi`: drops terminal escapes (colours, OSC 8 links).
pub fn strip_ansi(s: &str) -> String {
    let s = OSC.replace_all(s, "");
    CSI.replace_all(&s, "").into_owned()
}

/// `findUrl`: the first web address in CLI output.
pub fn find_url(out: &str) -> Option<String> {
    URL.find(&strip_ansi(out)).map(|m| m.as_str().to_string())
}

/// `readBoardTools`: a board's tools; empty when the file is missing or unreadable.
pub fn read_board_tools(file: &Path) -> Obj {
    let Some(v) = read_json(file) else { return Obj::new() };
    let Some(Value::Object(servers)) = v.get("mcpServers") else { return Obj::new() };
    servers.iter().filter(|(_, e)| e.is_object()).map(|(k, e)| (k.clone(), e.clone())).collect()
}

/// `writeBoardTools`: atomic, owner-only, `JSON.stringify({mcpServers}, null, 2) + "\n"`.
pub fn write_board_tools(file: &Path, servers: &Obj) -> std::io::Result<()> {
    let v = json!({ "mcpServers": Value::Object(servers.clone()) });
    ckanban_core::datafile::write_json(file, &v, ckanban_core::datafile::formats::BOARD_TOOLS)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn list_lines() {
        let text = "Checking MCP server health...\n\nnotes: /bin/echo hi there - ✓ Connected\nlin: https://mcp.linear.app/sse (SSE) - ! Needs authentication\nclaude.ai Slack: https://x.io/mcp?token=abc - ✘ Failed to connect — CONNECTION_CLOSED: boom\nweird line\n";
        let (servers, unparsed) = parse_mcp_list(text);
        assert_eq!(unparsed, vec!["weird line"]);
        assert_eq!(serde_json::to_string(&servers).unwrap(), r#"[{"name":"notes","target":"/bin/echo hi there","transport":"stdio","status":"connected","message":null},{"name":"lin","target":"https://mcp.linear.app/sse","transport":"sse","status":"needs_auth","message":"Needs authentication"},{"name":"claude.ai Slack","target":"https://x.io/mcp?token=***","transport":"http","status":"failed","message":"Failed to connect — CONNECTION_CLOSED: boom"}]"#);
        assert_eq!(parse_mcp_list("No MCP servers configured. Use `claude mcp add`").0.len(), 0);
    }

    #[test]
    fn get_lines() {
        assert_eq!(parse_mcp_get("notes:\n  Scope: User\n  Status: ✓ Connected\n"), Some(("connected", None)));
        assert_eq!(parse_mcp_get("  Status: ✘ Failed to connect\n  Issue: bad thing \n"), Some(("failed", Some("Failed to connect — bad thing".into()))));
        assert_eq!(parse_mcp_get("  Status: ⏸ \n  Issue: x\n"), Some(("unknown", Some("x".into()))));
        assert_eq!(parse_mcp_get("nothing"), None);
    }

    #[test]
    fn session_init() {
        assert!(parse_session_init(r#"{"type":"assistant"}"#).is_none());
        assert!(parse_session_init("nope").is_none());
        let s = parse_session_init(r#"{"type":"system","subtype":"init","mcp_servers":[{"name":"a","status":"connected"},{"name":"b","status":"needs-auth"},{"name":"c","status":"disabled"},{"name":3,"status":"failed"}]}"#).unwrap();
        assert_eq!(s, vec![("a".to_string(), "connected"), ("b".to_string(), "needs_auth")]);
        let o: Obj = serde_json::from_str(r#"{"name":"b","target":"t","transport":"http","status":"connected","message":null}"#).unwrap();
        let o = apply_session_status(o, Some(&s));
        assert_eq!(s_of(&o), ("needs_auth", json!("Needs authentication")));
        let o: Obj = serde_json::from_str(r#"{"name":"a","status":"failed","message":"x"}"#).unwrap();
        assert_eq!(s_of(&apply_session_status(o, Some(&s))), ("connected", Value::Null));
    }

    fn s_of(o: &Obj) -> (&str, Value) {
        (s(o, "status"), o["message"].clone())
    }

    #[test]
    fn scopes_and_config() {
        let dir = tempfile_dir();
        let cfg = dir.join(".claude.json");
        let cwd = dir.join("home");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::write(&cfg, json!({ "mcpServers": { "u": { "command": "/bin/x", "args": ["a b", 1], "env": { "K": "v'1" } }, "h": { "type": "http", "url": "https://x.io", "headers": { "Authorization": "Bearer z" } } },
            "projects": { cwd.to_string_lossy(): { "mcpServers": { "l": { "url": "https://l.io" } } } } }).to_string()).unwrap();
        std::fs::write(cwd.join(".mcp.json"), r#"{"mcpServers":{"p":{}}}"#).unwrap();
        let sc = config_scopes(&cwd, &cfg);
        assert_eq!([scope_of("u", &sc), scope_of("l", &sc), scope_of("p", &sc), scope_of("claude.ai X", &sc), scope_of("z", &sc)], ["user", "local", "project", "claude.ai", "other"]);
        assert_eq!(read_mcp_config("u", &cwd, &cfg).unwrap().to_string(), r#"{"name":"u","scope":"user","transport":"stdio","command":"/bin/x","args":["a b","1"],"env":[{"key":"K","value":"v'1"}],"commandLine":"K='v'\\''1' /bin/x 'a b' 1"}"#);
        assert_eq!(read_mcp_config("h", &cwd, &cfg).unwrap().to_string(), r#"{"name":"h","scope":"user","transport":"http","url":"https://x.io","headers":[{"name":"Authorization","value":"Bearer z"}],"commandLine":null}"#);
        assert_eq!(read_mcp_config("l", &cwd, &cfg).unwrap()["scope"], "local");
        assert!(read_mcp_config("nope", &cwd, &cfg).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    pub(crate) fn tempfile_dir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ck-mcp-{}-{}", std::process::id(), ckanban_core::atomic::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn add_args_checks() {
        let ok = add_args(&json!({ "name": " notes ", "transport": "stdio", "command": "/bin/echo", "args": ["hi there"], "env": [{ "key": "K", "value": "v" }, { "key": "", "value": "" }] })).unwrap();
        assert_eq!(ok, ["mcp", "add", "--scope", "user", "--transport", "stdio", "notes", "-e", "K=v", "--", "/bin/echo", "hi there"]);
        let h = add_args(&json!({ "name": "h", "transport": "sse", "url": " https://x.io/a ", "headers": [{ "name": "X-Key", "value": "1" }] })).unwrap();
        assert_eq!(h, ["mcp", "add", "--scope", "user", "--transport", "sse", "h", "https://x.io/a", "-H", "X-Key: 1"]);
        let err = |v: Value| add_args(&v).unwrap_err().1;
        assert_eq!(err(json!({ "name": "-x", "transport": "stdio" })), "name: letters, digits, dot, dash and underscore only");
        assert_eq!(err(json!({ "name": "x", "transport": "stdio" })), "command is required");
        // A missing key is "undefined" to JS's regex test, which passes (as in Bun).
        assert_eq!(add_args(&json!({ "name": "x", "transport": "stdio", "command": "c", "env": [{ "value": "v" }] })).unwrap()[8], "undefined=v");
        assert_eq!(err(json!({ "name": "x", "transport": "stdio", "command": "c", "env": [{ "key": "1x", "value": "v" }] })), "invalid environment variable name: 1x");
        assert_eq!(err(json!({ "name": "x", "transport": "stdio", "command": "c", "env": [{ "key": "K", "value": "a\nb" }] })), "K must be on one line");
        assert_eq!(err(json!({ "name": "x", "transport": "stdio", "command": "c", "args": ["a\rb"] })), "arguments must be on one line");
        assert_eq!(err(json!({ "name": "x", "transport": "http", "url": "ftp://x" })), "URL must start with http:// or https://");
        assert_eq!(err(json!({ "name": "x", "transport": "http", "url": "https://x", "headers": [{ "name": "a b", "value": "1" }] })), "invalid header name: a b");
        assert_eq!(err(json!({ "name": "x" })), "transport must be stdio, http or sse");
    }

    #[test]
    fn quoting_entries_and_errors() {
        assert_eq!(shell_quote("a/b-c.d"), "a/b-c.d");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
        let input = json!({ "name": "n", "transport": "stdio", "command": " c ", "args": ["x"], "env": [{ "key": " K ", "value": "v" }] });
        let e = entry_from_input(&input);
        assert_eq!(Value::Object(e.clone()).to_string(), r#"{"type":"stdio","command":"c","args":["x"],"env":{"K":"v"}}"#);
        assert_eq!(input_from_entry("n", &e).unwrap().to_string(), r#"{"name":"n","transport":"stdio","command":"c","args":["x"],"env":[{"key":"K","value":"v"}]}"#);
        let h = entry_from_input(&json!({ "transport": "http", "url": "https://x", "headers": [] }));
        assert_eq!(Value::Object(h.clone()).to_string(), r#"{"type":"http","url":"https://x"}"#);
        assert_eq!(input_from_entry("n", &h).unwrap()["headers"], json!([]));
        assert!(input_from_entry("n", serde_json::from_str::<Obj>(r#"{"command":"c","args":"x"}"#).as_ref().unwrap()).is_none());
        assert!(input_from_entry("n", serde_json::from_str::<Obj>(r#"{"type":"ws","url":"u"}"#).as_ref().unwrap()).is_none());
        let r = RunOut { code: 2, stdout: "out".into(), stderr: "1\n2\n3\n4\n5\n6 secretvalue --token abc\n".into(), timed_out: false };
        assert_eq!(error_text(&r, "claude mcp add", &["secretvalue".into(), "abc".into()]), "claude mcp add failed: 2\n3\n4\n5\n6 *** --token ***");
        assert_eq!(error_text(&RunOut { code: 3, ..Default::default() }, "x", &[]), "x failed: exit code 3");
        assert_eq!(strip_ansi("\x1b[1mhi\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07"), "hi link");
        assert_eq!(find_url("Open \x1b[4mhttps://a.io/x?y=1\x1b[0m now"), Some("https://a.io/x?y=1".into()));
        assert_eq!(find_url("none"), None);
    }
}
