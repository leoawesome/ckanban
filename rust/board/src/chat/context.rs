//! The Context panel (`src/chat/context-usage.ts`): how full a chat's Claude memory is and what fills it, from Claude
//! Code's built-in `/context`. `claude -p "/context" --resume <id>` makes no model call but appends bookkeeping lines
//! to the session it resumes, so it runs on a throwaway copy of the session file (deleted afterwards).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

use ckanban_core::jsnum::num;

use crate::runs::js;

// ---- Parser: the markdown `/context` prints ----

/// `Math.round`: halves go up.
fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `Number(s)` for the digits, dots and commas the token pattern takes.
fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// "2.5k" → 2500, "1.2m" → 1200000, "201" → 201, "~130" → 130, "1,234" → 1234. Unreadable gives 0.
pub fn parse_tokens(s: &str) -> f64 {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)([0-9.,]+)\s*([kmb])?").unwrap());
    let cleaned = s.replace('~', "");
    let Some(m) = RE.captures(js::trim(&cleaned)) else { return 0.0 };
    let n = js_number(&m[1].replace(',', ""));
    if !n.is_finite() {
        return 0.0;
    }
    let mult = match m.get(2).map(|x| x.as_str().to_lowercase()).as_deref() {
        Some("k") => 1e3,
        Some("m") => 1e6,
        Some("b") => 1e9,
        _ => 1.0,
    };
    round(n * mult)
}

fn parse_percent(s: &str) -> Option<f64> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(-?[0-9.]+)\s*%").unwrap());
    RE.captures(s).map(|m| js_number(&m[1]))
}

/// The markdown table rows (cells) under each `###` heading, keyed by heading in lower case (a repeated heading: the
/// later table, as Bun's Map.set).
fn tables(md: &str) -> HashMap<String, Vec<Vec<String>>> {
    static H: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{3,}\s+(.+)$").unwrap());
    static TOP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,2}\s").unwrap());
    static SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^:?-+:?$").unwrap());
    let mut out: HashMap<String, Vec<Vec<String>>> = HashMap::new();
    let mut current: Option<String> = None;
    for raw in md.split('\n') {
        let line = js::trim(raw);
        if let Some(h) = H.captures(line) {
            let k = js::trim(&h[1]).to_lowercase();
            out.insert(k.clone(), Vec::new());
            current = Some(k);
            continue;
        }
        if TOP.is_match(line) {
            current = None;
            continue;
        }
        let Some(k) = &current else { continue };
        if !line.starts_with('|') {
            continue;
        }
        let inner = line.strip_prefix('|').unwrap_or(line);
        let inner = inner.strip_suffix('|').unwrap_or(inner);
        let cells: Vec<String> = inner.split('|').map(|c| js::trim(c).to_string()).collect();
        if cells.iter().all(|c| SEP.is_match(c) || c.is_empty()) {
            continue;
        }
        if let Some(rows) = out.get_mut(k) {
            rows.push(cells);
        }
    }
    for rows in out.values_mut() {
        if !rows.is_empty() {
            rows.remove(0);
        }
    }
    out
}

fn section<'a>(t: &'a HashMap<String, Vec<Vec<String>>>, names: &[&str]) -> &'a [Vec<String>] {
    for n in names {
        if let Some(rows) = t.get(*n) {
            return rows;
        }
    }
    &[]
}

fn cell(c: &[String], i: usize) -> &str {
    c.get(i).map(String::as_str).unwrap_or("")
}

/// `parseContextReport`: the report as Bun's object (same keys, same order).
pub fn parse_context_report(md: &str) -> Value {
    static MODEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)\*\*Model:\*\*\s*(.+?)\s*$").unwrap());
    static TOK: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?im)\*\*Tokens:\*\*\s*([0-9.,]+\s*[kmb]?)\s*/\s*([0-9.,]+\s*[kmb]?)\s*(?:\(\s*([0-9.]+)\s*%\s*\))?").unwrap()
    });
    static DEFERRED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\(deferred\)").unwrap());
    static FREE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^free space$").unwrap());
    static BUFFER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)autocompact|buffer").unwrap());
    let model = MODEL.captures(md).map(|m| js::trim(&m[1]).to_string()).filter(|s| !s.is_empty());
    let tok = TOK.captures(md);
    let t = tables(md);
    struct Cat {
        name: String,
        tokens: f64,
        percent: Option<f64>,
        deferred: bool,
    }
    let cats: Vec<Cat> = section(&t, &["estimated usage by category"])
        .iter()
        .filter(|c| !cell(c, 0).is_empty())
        .map(|c| Cat { name: c[0].clone(), tokens: parse_tokens(cell(c, 1)), percent: parse_percent(cell(c, 2)), deferred: DEFERRED.is_match(&c[0]) })
        .collect();
    let mut used = tok.as_ref().map_or(0.0, |m| parse_tokens(&m[1]));
    let mut window = tok.as_ref().map_or(0.0, |m| parse_tokens(&m[2]));
    if tok.is_none() && !cats.is_empty() {
        used = cats.iter().filter(|c| !c.deferred && !FREE.is_match(&c.name) && !BUFFER.is_match(&c.name)).map(|c| c.tokens).sum();
        window = cats.iter().filter(|c| !c.deferred).map(|c| c.tokens).sum();
    }
    let percent = match tok.as_ref().and_then(|m| m.get(3)) {
        Some(p) => js_number(p.as_str()),
        None if window != 0.0 => round(used / window * 100.0),
        None => 0.0,
    };
    // MCP tools by server, in the order each server first shows.
    let mut servers: Vec<(String, f64, Vec<Value>)> = Vec::new();
    for c in section(&t, &["mcp tools"]) {
        if cell(c, 0).is_empty() {
            continue;
        }
        let server = if cell(c, 1).is_empty() { "other".to_string() } else { c[1].clone() };
        let prefix = format!("mcp__{server}__");
        let name = c[0].strip_prefix(&prefix).unwrap_or(&c[0]).to_string();
        let tokens = parse_tokens(cell(c, 2));
        let i = match servers.iter().position(|s| s.0 == server) {
            Some(i) => i,
            None => {
                servers.push((server, 0.0, Vec::new()));
                servers.len() - 1
            }
        };
        servers[i].2.push(json!({ "name": name, "tokens": num(tokens) }));
        servers[i].1 += tokens;
    }
    // Stable, biggest first (`sort((a, b) => b.tokens - a.tokens)`).
    servers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let builtin: Vec<Value> = section(&t, &["system tools", "built-in tools"])
        .iter()
        .filter(|c| !cell(c, 0).is_empty())
        .map(|c| json!({ "name": c[0], "tokens": num(parse_tokens(c.last().map(String::as_str).unwrap_or(""))) }))
        .collect();
    let memory: Vec<Value> = section(&t, &["memory files"])
        .iter()
        .filter(|c| c.len() >= 2)
        .map(|c| {
            if c.len() >= 3 {
                json!({ "type": c[0], "path": c[1], "tokens": num(parse_tokens(&c[2])) })
            } else {
                json!({ "type": "", "path": c[0], "tokens": num(parse_tokens(&c[1])) })
            }
        })
        .collect();
    let skills: Vec<Value> = section(&t, &["skills"])
        .iter()
        .filter(|c| !cell(c, 0).is_empty())
        .map(|c| {
            if c.len() >= 3 {
                json!({ "name": c[0], "source": c[1], "tokens": num(parse_tokens(&c[2])) })
            } else {
                json!({ "name": c[0], "source": "", "tokens": num(parse_tokens(cell(c, 1))) })
            }
        })
        .collect();
    let categories: Vec<Value> = cats
        .iter()
        .map(|c| json!({ "name": c.name, "tokens": num(c.tokens), "percent": c.percent.map_or(Value::Null, num), "deferred": c.deferred }))
        .collect();
    json!({
        "model": model,
        "used": num(used),
        "window": num(window),
        "percent": num(percent),
        "categories": categories,
        "mcpServers": servers.into_iter().map(|(server, tokens, tools)| json!({ "server": server, "tokens": num(tokens), "tools": tools })).collect::<Vec<_>>(),
        "builtinTools": builtin,
        "memoryFiles": memory,
        "skills": skills,
    })
}

// ---- Runner: /context on a throwaway copy of the session ----

/// What a chat's real runs use, so the copy sees the same tools and settings (`ContextSpec`).
#[derive(Debug, Clone, PartialEq)]
pub struct ContextSpec {
    pub session_id: String,
    /// The folder the chat runs in (its session is filed under it).
    pub cwd: String,
    /// The chat's run flags (any --resume/--session-id in them is replaced).
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

const DROP_WITH_VALUE: [&str; 7] = ["--input-format", "--output-format", "--resume", "--session-id", "--append-system-prompt", "--max-budget-usd", "--permission-prompt-tool"];
const DROP: [&str; 5] = ["-p", "--print", "--verbose", "--replay-user-messages", "--include-partial-messages"];

/// `contextArgs`: `claude` argv (without the binary) that prints `/context` for the copy `fork_id`.
pub fn context_args(chat_args: &[String], fork_id: &str) -> Vec<String> {
    let mut keep = Vec::new();
    let mut i = 0;
    while i < chat_args.len() {
        let a = chat_args[i].as_str();
        if DROP.contains(&a) {
            i += 1;
            continue;
        }
        if DROP_WITH_VALUE.contains(&a) {
            i += 2;
            continue;
        }
        keep.push(chat_args[i].clone());
        i += 1;
    }
    let mut out: Vec<String> = ["-p", "/context", "--output-format", "json", "--resume", fork_id].iter().map(|s| s.to_string()).collect();
    out.extend(keep);
    out
}

pub const CONTEXT_TIMEOUT_MS: u64 = 60_000;

/// Plain-words message for a failed check.
fn plain(m: &str) -> String {
    let m = js::trim(m);
    if js::len16(m) > 300 {
        format!("{}…", js::head16(m, 297))
    } else if m.is_empty() {
        "Claude Code didn't say why.".into()
    } else {
        m.to_string()
    }
}

/// Where a chat's last result is saved (None: don't save, the chat is gone).
pub type ContextFile = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;
/// A check finished (or failed) for this chat key.
pub type ContextChanged = Arc<dyn Fn(&str) + Send + Sync>;

pub struct ContextOptions {
    pub claude_bin: String,
    pub timeout_ms: u64,
    pub file: ContextFile,
    pub changed: ContextChanged,
    pub max_background: usize,
}

#[derive(Clone)]
struct Entry {
    session_id: String,
    /// `{ report, checkedAt }`.
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Default)]
struct State {
    cache: HashMap<String, Entry>,
    /// One `/context` process per session: done flags its callers wait on.
    inflight: HashMap<String, watch::Receiver<bool>>,
    queue: Vec<(String, ContextSpec)>,
    background: usize,
    /// Keys whose saved file was looked for and wasn't there (read again only after a check).
    missing: HashSet<String>,
}

/// `ContextUsage`: results cached per chat (key) and session; nothing runs on a read, only `refresh` starts a check.
pub struct ContextUsage {
    opts: ContextOptions,
    st: Mutex<State>,
}

impl ContextUsage {
    pub fn new(opts: ContextOptions) -> Arc<Self> {
        Arc::new(ContextUsage { opts, st: Mutex::new(State::default()) })
    }

    /// `view`: the cached view for the chat (no session: `none`). Never starts a check. Blocking (may read the saved file).
    pub fn view(&self, key: &str, session_id: Option<&str>) -> Value {
        let Some(sid) = session_id else { return json!({ "state": "none", "result": null, "error": null }) };
        let e = self.entry(key);
        let state = if self.st.lock().inflight.contains_key(sid) { "running" } else { "idle" };
        match e {
            None => json!({ "state": state, "result": null, "error": null }),
            Some(e) if e.session_id == sid => json!({ "state": state, "result": e.result, "error": e.error }),
            // An earlier session's numbers: shown, marked stale, refreshed when the next run ends.
            Some(e) => json!({ "state": state, "result": e.result, "error": null, "stale": true }),
        }
    }

    fn entry(&self, key: &str) -> Option<Entry> {
        {
            let st = self.st.lock();
            if let Some(e) = st.cache.get(key) {
                return Some(e.clone());
            }
            if st.missing.contains(key) {
                return None;
            }
        }
        let saved = self.load(key);
        let mut st = self.st.lock();
        if let Some(e) = st.cache.get(key) {
            return Some(e.clone());
        }
        match saved {
            Some((sid, result)) => {
                let e = Entry { session_id: sid, result: Some(result), error: None };
                st.cache.insert(key.to_string(), e.clone());
                Some(e)
            }
            None => {
                st.missing.insert(key.to_string());
                None
            }
        }
    }

    fn load(&self, key: &str) -> Option<(String, Value)> {
        let f = (self.opts.file)(key)?;
        let text = std::fs::read_to_string(&f).ok()?;
        let s = js::parse(&text)?;
        let sid = s.get("sessionId")?.as_str()?.to_string();
        let result = s.get("result")?;
        result.get("checkedAt")?.as_str()?;
        if !js::truthy(result.get("report")) {
            return None;
        }
        Some((sid, result.clone()))
    }

    fn save(&self, key: &str, session_id: &str, result: &Value) {
        let Some(f) = (self.opts.file)(key) else { return };
        // A write never creates folders: a check that ends after a delete leaves nothing behind.
        if !f.parent().is_some_and(|d| d.is_dir()) {
            return;
        }
        let text = js::stringify(&json!({ "sessionId": session_id, "result": result }));
        let tmp = PathBuf::from(format!("{}.tmp-{}", f.display(), crate::runloop::board::uuid()));
        if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &f).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// `schedule`: a check in the background (a run of the chat ended), a few at a time across the board. A chat
    /// already waiting keeps one place in the queue, with the newest spec.
    pub fn schedule(self: &Arc<Self>, key: &str, spec: ContextSpec) {
        {
            let mut st = self.st.lock();
            st.queue.retain(|(k, _)| k != key);
            st.queue.push((key.to_string(), spec));
        }
        self.pump();
    }

    fn pump(self: &Arc<Self>) {
        let max = self.opts.max_background.max(1);
        loop {
            let (key, spec) = {
                let mut st = self.st.lock();
                if st.background >= max || st.queue.is_empty() {
                    return;
                }
                st.background += 1;
                st.queue.remove(0)
            };
            let me = self.clone();
            let Ok(rt) = tokio::runtime::Handle::try_current() else {
                self.st.lock().background -= 1;
                return;
            };
            rt.spawn(async move {
                me.refresh(&key, spec).await;
                me.st.lock().background -= 1;
                me.pump();
            });
        }
    }

    /// Background checks running and waiting (tests).
    pub fn pending(&self) -> (usize, usize) {
        let st = self.st.lock();
        (st.background, st.queue.len())
    }

    /// `refresh`: starts a check (or joins the one running for this session); returns when it is over.
    pub async fn refresh(self: &Arc<Self>, key: &str, spec: ContextSpec) {
        let mut rx = {
            let mut st = self.st.lock();
            match st.inflight.get(&spec.session_id) {
                Some(rx) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel(false);
                    st.inflight.insert(spec.session_id.clone(), rx.clone());
                    let me = self.clone();
                    let key = key.to_string();
                    tokio::spawn(async move {
                        let r = me.run(&spec).await;
                        let sid = spec.session_id.clone();
                        let k2 = key.clone();
                        let me2 = me.clone();
                        let _ = tokio::task::spawn_blocking(move || me2.settle(&k2, &sid, r)).await;
                        me.st.lock().inflight.remove(&spec.session_id);
                        (me.opts.changed)(&key);
                        let _ = tx.send(true);
                    });
                    rx
                }
            }
        };
        let _ = rx.wait_for(|d| *d).await;
    }

    fn settle(&self, key: &str, sid: &str, r: Result<Value, String>) {
        match r {
            Ok(result) => {
                self.save(key, sid, &result);
                let mut st = self.st.lock();
                st.missing.remove(key);
                st.cache.insert(key.to_string(), Entry { session_id: sid.to_string(), result: Some(result), error: None });
            }
            Err(e) => {
                let prev = self.entry(key);
                let result = prev.filter(|p| p.session_id == sid).and_then(|p| p.result);
                self.st.lock().cache.insert(key.to_string(), Entry { session_id: sid.to_string(), result, error: Some(plain(&e)) });
            }
        }
    }

    /// `drop`: forget a chat (deleted): its cached result and any queued check.
    pub fn forget(&self, key: &str) {
        let mut st = self.st.lock();
        st.cache.remove(key);
        st.missing.remove(key);
        st.queue.retain(|(k, _)| k != key);
    }

    async fn run(&self, spec: &ContextSpec) -> Result<Value, String> {
        let projects = crate::sessions::files::projects_dir(None);
        let sid = spec.session_id.clone();
        let p2 = projects.clone();
        let src = tokio::task::spawn_blocking(move || crate::sessions::files::find_session_file(&p2, &sid)).await.ok().flatten();
        let Some(src) = src else { return Err("This chat has no saved conversation yet.".into()) };
        let fork_id = crate::runloop::board::uuid();
        let (from, to, cwd) = (spec.session_id.clone(), fork_id.clone(), spec.cwd.clone());
        // The copy is read from the file, so a chat that is running right now is safe too.
        let fork = tokio::task::spawn_blocking(move || crate::runloop::branch::fork_session(&src, &from, &to, &cwd, &cwd, &[]))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
        let fork = fork?;
        let out = self.call(spec, &fork_id).await;
        let side = fork.parent().map(|d| d.join(&fork_id));
        let _ = tokio::task::spawn_blocking(move || {
            let _ = std::fs::remove_file(&fork);
            if let Some(s) = side.filter(|s| s.exists()) {
                let _ = std::fs::remove_dir_all(s);
            }
        })
        .await;
        out
    }

    async fn call(&self, spec: &ContextSpec, fork_id: &str) -> Result<Value, String> {
        let mut cmd = tokio::process::Command::new(&self.opts.claude_bin);
        cmd.args(context_args(&spec.args, fork_id)).current_dir(&spec.cwd).envs(&spec.env);
        // Closed stdin: otherwise Claude Code waits a few seconds for input.
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("{} {}: {e}", "spawn", self.opts.claude_bin))?;
        let mut out = child.stdout.take();
        let mut err = child.stderr.take();
        let read_out = async move {
            let mut b = Vec::new();
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_end(&mut b).await;
            }
            b
        };
        let read_err = async move {
            let mut b = Vec::new();
            if let Some(e) = err.as_mut() {
                let _ = e.read_to_end(&mut b).await;
            }
            b
        };
        let timeout = Duration::from_millis(self.opts.timeout_ms);
        let mut timed_out = false;
        let waited = async {
            tokio::select! {
                s = child.wait() => s.ok(),
                _ = tokio::time::sleep(timeout) => {
                    timed_out = true;
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
            }
        };
        let (status, out, err) = tokio::join!(waited, read_out, read_err);
        if timed_out {
            return Err(format!("Claude Code took longer than {} seconds to answer.", (self.opts.timeout_ms as f64 / 1000.0).round()));
        }
        let (out, err) = (String::from_utf8_lossy(&out), String::from_utf8_lossy(&err));
        let last = js::trim(&out).split('\n').rfind(|l| !l.is_empty()).unwrap_or("").to_string();
        let parsed = js::parse(&last).filter(|v| v.get("result").is_some_and(Value::is_string));
        let Some(v) = parsed else {
            let why = js::trim(js::trim(&err).split('\n').rfind(|l| !l.is_empty()).unwrap_or("")).to_string();
            let code = status.map(crate::runs::runner::exit_code).map_or("null".to_string(), |c| c.to_string());
            return Err(if why.is_empty() { format!("Claude Code couldn't check (exit code {code}).") } else { format!("Claude Code couldn't check: {why}") });
        };
        let text = v.get("result").and_then(Value::as_str).unwrap_or("");
        if js::truthy(v.get("is_error")) {
            let t = js::trim(text);
            return Err(format!("Claude Code couldn't check: {}", if t.is_empty() { "no reason given" } else { t }));
        }
        let report = parse_context_report(text);
        let window = report.get("window").and_then(Value::as_f64).unwrap_or(0.0);
        let empty = report.get("categories").and_then(Value::as_array).is_none_or(|c| c.is_empty());
        if window == 0.0 && empty {
            return Err("Claude Code's answer had no context numbers in it.".into());
        }
        let mut r = Map::new();
        r.insert("report".into(), report);
        r.insert("checkedAt".into(), Value::String(ckanban_core::time::iso(ckanban_core::time::now_ms())));
        Ok(Value::Object(r))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens() {
        assert_eq!(parse_tokens("2.5k"), 2500.0);
        assert_eq!(parse_tokens("1.2m"), 1_200_000.0);
        assert_eq!(parse_tokens("~130"), 130.0);
        assert_eq!(parse_tokens("1,234"), 1234.0);
        assert_eq!(parse_tokens("x"), 0.0);
    }

    #[test]
    fn report() {
        let md = "## Context Usage\n\n**Model:** claude-opus\n**Tokens:** 20.1k / 200k (10%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| System prompt | 3k | 1.5% |\n| MCP tools (deferred) | 2k | |\n| Free space | 150k | 75% |\n\n### MCP Tools\n\n| Tool | Server | Tokens |\n|---|---|---|\n| mcp__a__x | a | 100 |\n| mcp__b__y | b | 300 |\n| mcp__a__z | a | 50 |\n\n### Memory Files\n\n| Type | Path | Tokens |\n|---|---|---|\n| Project | /x/CLAUDE.md | 1.1k |\n";
        let r = parse_context_report(md);
        assert_eq!(r["model"], "claude-opus");
        assert_eq!(r["used"], 20100);
        assert_eq!(r["window"], 200000);
        assert_eq!(r["percent"], 10);
        assert_eq!(r["categories"][1]["deferred"], true);
        assert_eq!(r["categories"][1]["percent"], Value::Null);
        assert_eq!(r["categories"][0]["percent"], 1.5);
        assert_eq!(r["mcpServers"][0]["server"], "b");
        assert_eq!(r["mcpServers"][1]["tokens"], 150);
        assert_eq!(r["mcpServers"][1]["tools"][1]["name"], "z");
        assert_eq!(r["memoryFiles"][0]["tokens"], 1100);
        let keys: Vec<&String> = r.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "used", "window", "percent", "categories", "mcpServers", "builtinTools", "memoryFiles", "skills"]);
    }

    #[test]
    fn args() {
        let a: Vec<String> = ["-p", "--output-format", "stream-json", "--resume", "s1", "--model", "opus", "--verbose", "--max-budget-usd", "3"].iter().map(|s| s.to_string()).collect();
        assert_eq!(context_args(&a, "f"), ["-p", "/context", "--output-format", "json", "--resume", "f", "--model", "opus"]);
    }
}
