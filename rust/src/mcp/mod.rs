//! `ckanban-rs mcp`: the stdio MCP server (newline-delimited JSON-RPC 2.0), the port of `ckanban mcp`
//! (src/mcp/server.ts). Same protocol answers, the same 69 tools with the same names, descriptions and input schemas
//! (tools.json, generated from Bun's TOOLS before P4, edited by hand since), and the same answers and refusals: the tools
//! call the daemon over HTTP (client.rs) and build the same texts.
//!
//! Every tool runs here (one file per group, as in src/mcp/); none starts Bun.

mod artifact;
mod client;
mod family;
mod forms;
mod huddles;
mod js;
mod keys;
mod proposals;
mod schedules;
mod text;
mod tickets;
mod workflow;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use client::{Client, Fail, R, RUN_ENV, err};

/// What tools/list answers: Bun's TOOLS as generated before P4 (the source since).
const TOOLS_JSON: &str = include_str!("tools.json");

pub mod sha256;

/// `toolsVersion`: a fingerprint of the board tools' names, descriptions and options (the first 16 hex of SHA-256 of
/// `JSON.stringify(TOOLS.map((t) => [t.name, t.description, t.inputSchema]))`), so a resumed session hears when a new
/// version changed them. None when the list can't be read.
pub fn tools_version() -> Option<String> {
    let tools: Vec<serde_json::Value> = serde_json::from_str(TOOLS_JSON).ok()?;
    let list: Vec<serde_json::Value> = tools
        .iter()
        .map(|t| serde_json::Value::Array(vec![t.get("name").cloned().unwrap_or(serde_json::Value::Null), t.get("description").cloned().unwrap_or(serde_json::Value::Null), t.get("inputSchema").cloned().unwrap_or(serde_json::Value::Null)]))
        .collect();
    let text = ckanban_board::runs::js::stringify(&serde_json::Value::Array(list));
    Some(sha256::hex(text.as_bytes())[..16].to_string())
}
/// Per tool: changes, allowInRun, plannerScope (same order).
const FLAGS_JSON: &str = include_str!("tool-flags.json");

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Tools for the user's local ckanban board. Use them when the user asks to put work on the board, \
find what to do next, or check on, start or steer tickets. Tickets you create land in Backlog in interview mode by default. \
Schedules (create_schedule etc.) make the board create and run a ticket on a cron, for work the user wants done regularly; \
schedule_job runs a ticket or a command once at a set time. Board chats and runs may create, change, pause, resume and run them now on their own judgment; \
delete_schedule there deletes nothing: in a ticket's chat or run it shows the user a card to confirm (a tool ticket reports it to its main ticket instead), \
a quick chat can't delete schedules (the user does it in the Schedules window), and the Telegram front desk asks for a Confirm tap. \
ask_questions, propose_ticket, propose_branch, propose_teammate and propose_squad are for the board's ticket chats: they show a form or cards to the user. \
propose_helper_rule suggests a line for what the helper knows about the user, only when the user asked for that alert rule in a message they typed; the user's Add on its card saves it.";

/// This process's environment; `get` gives only set, non-empty values (JS truthiness of `env[X]`).
pub struct Env(HashMap<String, String>);

impl Env {
    pub fn from_process() -> Self {
        Env(std::env::vars().collect())
    }
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }
}

/// What every tool gets (ToolContext).
pub struct Ctx {
    pub client: Client,
    pub cwd: PathBuf,
    pub env: Env,
}

#[derive(serde::Deserialize, Clone, Copy)]
struct Flags {
    changes: bool,
    #[serde(rename = "allowInRun")]
    allow_in_run: bool,
    #[serde(rename = "plannerScope")]
    planner_scope: bool,
}

#[derive(serde::Deserialize)]
struct FlagRow {
    name: String,
    #[serde(flatten)]
    flags: Flags,
}

fn flags() -> &'static HashMap<String, Flags> {
    static F: std::sync::OnceLock<HashMap<String, Flags>> = std::sync::OnceLock::new();
    F.get_or_init(|| {
        let rows: Vec<FlagRow> = serde_json::from_str(FLAGS_JSON).expect("tool-flags.json");
        rows.into_iter().map(|r| (r.name, r.flags)).collect()
    })
}

/// The tools/list array, compact, as Bun's JSON.stringify writes it.
fn tools_list() -> &'static str {
    static T: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    T.get_or_init(|| TOOLS_JSON.lines().filter(|l| l.starts_with('{')).map(|l| l.trim_end_matches(',')).collect::<Vec<_>>().join(","))
}

/// `ckanban-rs mcp`: serves stdin/stdout until stdin ends, then waits for the calls still running.
pub fn main() -> std::process::ExitCode {
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("ckanban-rs: {e}");
            return std::process::ExitCode::from(1);
        }
    };
    rt.block_on(serve());
    std::process::ExitCode::SUCCESS
}

async fn serve() {
    let env = Env::from_process();
    let root = crate::settings::data_root();
    let config = std::fs::read_to_string(root.join("config.json")).ok();
    let port = crate::settings::board_port(env.get("CKANBAN_PORT"), config.as_deref());
    let cwd = std::env::current_dir().unwrap_or_default();
    let ctx = Arc::new(Ctx { client: Client::new(port, &env), cwd, env });
    let out = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut stdin = tokio::io::stdin();
    let mut buf: Vec<u8> = vec![];
    let mut chunk = vec![0u8; 64 * 1024];
    let mut pending = vec![];
    loop {
        let n = match stdin.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            handle_line(&line[..line.len() - 1], &ctx, &out, &mut pending);
        }
    }
    handle_line(&buf, &ctx, &out, &mut pending);
    for p in pending {
        let _ = p.await;
    }
}

fn handle_line(line: &[u8], ctx: &Arc<Ctx>, out: &Arc<Mutex<tokio::io::Stdout>>, pending: &mut Vec<tokio::task::JoinHandle<()>>) {
    let text = String::from_utf8_lossy(line);
    if js::trim(&text).is_empty() {
        return;
    }
    let msg: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            let out = out.clone();
            pending.push(tokio::spawn(async move { write(&out, r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}"#.into()).await }));
            return;
        }
    };
    let msgs = match msg {
        Value::Array(a) => a,
        m => vec![m],
    };
    for m in msgs {
        let ctx = ctx.clone();
        let out = out.clone();
        pending.push(tokio::spawn(async move {
            if let Some(reply) = handle_message(&m, &ctx).await {
                write(&out, reply).await;
            }
        }));
    }
}

async fn write(out: &Arc<Mutex<tokio::io::Stdout>>, line: String) {
    let mut o = out.lock().await;
    let _ = o.write_all(format!("{line}\n").as_bytes()).await;
    let _ = o.flush().await;
}

/// `JSON.stringify` of a string.
fn q(s: &str) -> String {
    Value::String(s.to_string()).to_string()
}

/// One JSON-RPC message: the reply line, or None for notifications (handleMessage).
async fn handle_message(msg: &Value, ctx: &Ctx) -> Option<String> {
    // A batch entry that isn't an object makes Bun's handler throw before it can answer: no reply.
    msg.as_object()?;
    let id = match js::get(msg, "id") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v),
    };
    let id_json = id.map_or("null".to_string(), Value::to_string);
    let reply = |result: String| Some(format!(r#"{{"jsonrpc":"2.0","id":{id_json},"result":{result}}}"#));
    let params = js::get(msg, "params").cloned().unwrap_or(Value::Null);
    match js::get(msg, "method").and_then(Value::as_str) {
        Some("initialize") => {
            let asked = js::s(&params, "protocolVersion");
            let version = asked.filter(|a| PROTOCOL_VERSIONS.contains(a)).unwrap_or(PROTOCOL_VERSIONS[0]);
            let server_version = option_env!("CKANBAN_VERSION").unwrap_or("dev");
            reply(format!(
                r#"{{"protocolVersion":{},"capabilities":{{"tools":{{}}}},"serverInfo":{{"name":"ckanban","version":{}}},"instructions":{}}}"#,
                q(version),
                q(server_version),
                q(INSTRUCTIONS)
            ))
        }
        Some("ping") => reply("{}".into()),
        Some("tools/list") => reply(format!(r#"{{"tools":[{}]}}"#, tools_list())),
        Some("tools/call") => {
            let name = match js::get(&params, "name") {
                None | Some(Value::Null) => String::new(),
                v => js::show(v),
            };
            reply(call_tool(&name, js::get(&params, "arguments"), ctx).await)
        }
        _ => {
            id?;
            let method = js::show(js::get(msg, "method"));
            Some(format!(r#"{{"jsonrpc":"2.0","id":{id_json},"error":{{"code":-32601,"message":{}}}}}"#, q(&format!("method not found: {method}"))))
        }
    }
}

/// A tool result as Bun writes it: one text block, isError only when true.
fn result_text(text: &str, is_error: bool) -> String {
    let e = if is_error { r#","isError":true"# } else { "" };
    format!(r#"{{"content":[{{"type":"text","text":{}}}]{e}}}"#, q(text))
}

/// callTool: the run check, then the tool; a thrown error becomes an error result.
async fn call_tool(name: &str, args: Option<&Value>, ctx: &Ctx) -> String {
    let Some(f) = flags().get(name).copied() else {
        return result_text(&format!("unknown tool {name}"), true);
    };
    let empty = Value::Object(Default::default());
    let args = match args {
        None | Some(Value::Null) => &empty,
        Some(a) => a,
    };
    let out = async {
        if f.changes && !f.allow_in_run && !f.planner_scope {
            assert_can_change(&ctx.env)?;
        }
        run_tool(name, args, ctx).await
    }
    .await;
    match out {
        Ok(t) => result_text(&t, false),
        // Held for the user's Confirm tap in Telegram (the front desk): not an error, the text says what happens next.
        Err(Fail::Confirm(m)) => result_text(&m, false),
        Err(Fail::Msg(m)) => result_text(&m, true),
    }
}

async fn run_tool(name: &str, a: &Value, cx: &Ctx) -> R<String> {
    if let Some(r) = artifact::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = tickets::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = workflow::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = family::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = forms::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = huddles::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = schedules::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = keys::run(name, a, cx).await {
        return r;
    }
    if let Some(r) = proposals::run(name, a, cx).await {
        return r;
    }
    err(format!("unknown tool {name}"))
}

// ---- What every group uses (src/mcp/shared.ts and the profile lookup of src/cli/client.ts) ----

/// Board runs may read the board but not change it (assertCanChange).
fn assert_can_change(env: &Env) -> R<()> {
    if let Some(v) = env.get(RUN_ENV) {
        return err(format!(
            "changing the board is disabled inside a board run ({RUN_ENV}={v}), so runs can't create or start other runs. Reading tickets still works; ask the user to make this change on the board."
        ));
    }
    Ok(())
}

impl Ctx {
    /// CKANBAN_TICKET, the board run this process belongs to.
    pub fn run_env(&self) -> Option<&str> {
        self.env.get(RUN_ENV)
    }
    /// The ticket a board run belongs to (runTicketId).
    pub fn run_ticket(&self) -> Option<&str> {
        self.run_env().and_then(|v| v.split('/').nth(1)).filter(|s| !s.is_empty())
    }
    /// The board a board run belongs to (runProfile).
    pub fn run_profile(&self) -> Option<&str> {
        self.run_env().and_then(|v| v.split('/').next()).filter(|s| !s.is_empty())
    }
    pub fn caller(&self) -> client::Caller {
        client::Caller { run: self.run_env().map(str::to_string), agent: self.env.get(client::HUDDLE_AGENT_ENV).map(str::to_string) }
    }

    /// slugFor: `profile`, else the run's board, else the board whose folder holds the working folder.
    pub async fn slug(&self, args: &Value) -> R<String> {
        let explicit = js::s(args, "profile").filter(|p| !js::trim(p).is_empty()).map(str::to_string).or_else(|| self.run_profile().map(str::to_string));
        let profiles = self.client.list_profiles().await?;
        let list = profiles.as_array().cloned().unwrap_or_default();
        resolve_profile(&list, explicit.as_deref(), &self.cwd).await
    }
}

/// `str(args, key)`: a non-blank string, else "<key> is required".
pub fn req_str<'a>(args: &'a Value, key: &str) -> R<&'a str> {
    match js::s(args, key) {
        Some(v) if !js::trim(v).is_empty() => Ok(v),
        _ => err(format!("{key} is required")),
    }
}

/// `str(args, key, false)`: a non-blank string or None.
pub fn opt_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    js::s(args, key).filter(|v| !js::trim(v).is_empty())
}

/// realpathSync, else path.resolve.
fn real(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| resolve(p))
}

/// path.resolve of one path: absolute against the working folder, `.` and `..` folded.
fn resolve(p: &Path) -> PathBuf {
    let full = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::from("/");
    for c in full.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(x) => out.push(x),
            _ => {}
        }
    }
    out
}

fn contains(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&if parent.ends_with('/') { parent.to_string() } else { format!("{parent}/") })
}

/// The profile with the deepest `path` containing `dir` (deepestProfile).
fn deepest<'a>(profiles: &'a [Value], dir: &str) -> Option<&'a Value> {
    let mut best: Option<&Value> = None;
    let mut best_len: isize = -1;
    for p in profiles {
        let path = real(Path::new(&js::sh(p, "path"))).to_string_lossy().to_string();
        if contains(&path, dir) && path.len() as isize > best_len {
            best = Some(p);
            best_len = path.len() as isize;
        }
    }
    best
}

/// Main checkout of the git repo `dir` is in (mainCheckout).
async fn main_checkout(dir: &str) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(dir)
        .stderr(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let common = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if common.is_empty() || !Path::new(&common).is_absolute() {
        return None;
    }
    let parent = Path::new(&common).parent().unwrap_or(Path::new("/"));
    Some(real(parent).to_string_lossy().to_string())
}

/// resolveProfile: the explicit slug or name, else the folder's board (worktrees count as their main checkout).
async fn resolve_profile(profiles: &[Value], explicit: Option<&str>, cwd: &Path) -> R<String> {
    if let Some(want) = explicit.map(js::trim).filter(|w| !w.is_empty()) {
        let lower = want.to_lowercase();
        let hit = profiles.iter().find(|p| js::s(p, "slug") == Some(want)).or_else(|| profiles.iter().find(|p| js::sh(p, "name").to_lowercase() == lower));
        return match hit {
            Some(p) => Ok(js::sh(p, "slug")),
            None => err(format!("no profile \"{want}\". {}", text::profile_list(profiles))),
        };
    }
    let cwd = real(cwd).to_string_lossy().to_string();
    if let Some(p) = deepest(profiles, &cwd) {
        return Ok(js::sh(p, "slug"));
    }
    if let Some(main) = main_checkout(&cwd).await.filter(|m| *m != cwd) {
        if let Some(p) = deepest(profiles, &main) {
            return Ok(js::sh(p, "slug"));
        }
    }
    err(format!("no profile matches {cwd}; pass a profile. {}", text::profile_list(profiles)))
}

/// depList: dependsOn as trimmed ids.
pub fn dep_list(args: &Value) -> R<Option<Vec<String>>> {
    let Some(v) = js::get(args, "dependsOn") else { return Ok(None) };
    let Some(a) = v.as_array() else { return err("dependsOn must be a list of ticket ids or keys") };
    Ok(Some(a.iter().filter_map(Value::as_str).filter(|d| !js::trim(d).is_empty()).map(|d| js::trim(d).to_string()).collect()))
}

/// needsList: device names, trimmed and lowercase.
pub fn needs_list(args: &Value) -> R<Option<Vec<String>>> {
    let Some(v) = js::get(args, "needs") else { return Ok(None) };
    match v.as_array() {
        Some(a) if a.iter().all(Value::is_string) => {
            Ok(Some(a.iter().filter_map(Value::as_str).map(|n| js::trim(n).to_lowercase()).filter(|n| !n.is_empty()).collect()))
        }
        _ => err("needs must be a list of device names, e.g. [\"chrome-whatsapp\"]"),
    }
}

/// Most tags on one ticket (TAGS_MAX in src/board/tags.ts) and the longest tag (TAG_MAX_LEN).
const TAGS_MAX: usize = 10;
const TAG_MAX_LEN: isize = 24;

/// normalizeTag in src/board/tags.ts: trimmed, leading #s dropped, lowercase, whitespace runs become one dash, at most
/// TAG_MAX_LEN characters, trailing dashes dropped.
fn normalize_tag(v: &str) -> String {
    let t = js::trim(js::trim(v).trim_start_matches('#')).to_lowercase();
    let mut out = String::new();
    let mut space = false;
    for c in t.chars() {
        if c.is_whitespace() || c == '\u{feff}' {
            if !space {
                out.push('-');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    js::slice(&out, 0, Some(TAG_MAX_LEN)).trim_end_matches('-').to_string()
}

/// tagsList: tag names, normalised and deduplicated.
pub fn tags_list(args: &Value, key: &str) -> R<Option<Vec<String>>> {
    let Some(v) = js::get(args, key) else { return Ok(None) };
    match v.as_array() {
        Some(a) if a.iter().all(Value::is_string) => {
            let mut out: Vec<String> = vec![];
            for t in a.iter().filter_map(Value::as_str).map(normalize_tag).filter(|t| !t.is_empty()) {
                if !out.contains(&t) {
                    out.push(t);
                }
            }
            out.truncate(TAGS_MAX);
            Ok(Some(out))
        }
        _ => err(format!("{key} must be a list of tag names, e.g. [\"post\"]")),
    }
}

/// A ticket that is a tool ticket (hiddenTool in web/src/features/family/family.ts).
pub fn hidden_tool(t: Option<&Value>) -> bool {
    t.is_some_and(|t| js::t(t, "tool"))
}

/// A tool ticket that talks to the user itself (withYouTool).
pub fn with_you_tool(t: Option<&Value>) -> bool {
    t.is_some_and(|t| js::t(t, "tool") && js::s(t, "kind") == Some("with_you"))
}

/// What a card tool answers (SHOWN).
pub const SHOWN: &str = "Shown to the user as a card. End your turn and wait for their reply.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_json_is_complete() {
        let list: Vec<Value> = serde_json::from_str(&format!("[{}]", tools_list())).unwrap();
        assert_eq!(list.len(), 69);
        assert_eq!(flags().len(), 69);
        for t in &list {
            assert!(flags().contains_key(t["name"].as_str().unwrap()));
        }
    }

    #[test]
    fn tags_normalise() {
        assert_eq!(normalize_tag(" ##Post  Ideas! "), "post-ideas!");
        assert_eq!(normalize_tag("a ".repeat(20).as_str()), "a-a-a-a-a-a-a-a-a-a-a-a");
        assert_eq!(normalize_tag("xhs"), "xhs");
    }

    #[test]
    fn folder_contains() {
        assert!(contains("/a/b", "/a/b/c"));
        assert!(!contains("/a/b", "/a/bc"));
        assert_eq!(resolve(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
    }
}
