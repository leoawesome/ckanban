//! A side call (`src/runs/side-call.ts`): one short `claude -p` answer on the cheapest model, outside any ticket's
//! session. No resume, no tools (a reading call gets read-only file tools), no MCP servers, no skills, no user hooks,
//! nothing saved as a session. Its cost goes to the ticket's side ledger (`side-spend.jsonl`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use ckanban_core::time::{day_key, iso, now_ms, system_ms, value_ms};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{claude, js};

#[derive(Debug, Clone, Default)]
pub struct SideCallInput {
    pub prompt: String,
    pub system: String,
    /// Default: haiku.
    pub model: Option<String>,
    pub timeout_ms: Option<u64>,
    /// Read-only tools it may use (Read, Grep, Glob); default none.
    pub tools: Vec<String>,
    /// Folder it runs in (a reading call: the ticket's folder); default the caller's own side-calls folder.
    pub cwd: Option<PathBuf>,
    /// Structured output: the answer must match this JSON schema; the text is then that JSON.
    pub json_schema: Option<Value>,
}

/// A failed call may still have cost money: `cost_usd` then.
#[derive(Debug, Clone, PartialEq)]
pub enum SideCallResult {
    Ok { text: String, cost_usd: f64, model: String },
    Err { error: String, cost_usd: Option<f64> },
}

impl SideCallResult {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            SideCallResult::Ok { text, cost_usd, model } => {
                m.insert("ok".into(), Value::Bool(true));
                m.insert("text".into(), Value::String(text.clone()));
                m.insert("costUsd".into(), ckanban_core::jsnum::num(*cost_usd));
                m.insert("model".into(), Value::String(model.clone()));
            }
            SideCallResult::Err { error, cost_usd } => {
                m.insert("ok".into(), Value::Bool(false));
                m.insert("error".into(), Value::String(error.clone()));
                if let Some(c) = cost_usd {
                    m.insert("costUsd".into(), ckanban_core::jsnum::num(*c));
                }
            }
        }
        Value::Object(m)
    }
}

/// Tools a reading call may be given: none of them change files or run commands.
pub const READ_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];
/// Turns a reading call may take (each tool use is one).
const READ_TURNS: u32 = 20;

/// `sideCallArgs`.
pub fn side_call_args(i: &SideCallInput) -> Vec<String> {
    let tools: Vec<&str> = i.tools.iter().map(String::as_str).filter(|t| READ_TOOLS.contains(t)).collect();
    let mut a: Vec<String> = ["-p", "--output-format", "json", "--model", i.model.as_deref().unwrap_or("haiku"), "--no-session-persistence", "--tools"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    a.push(tools.join(","));
    if let Some(s) = &i.json_schema {
        a.extend(["--json-schema".to_string(), js::stringify(s)]);
    }
    if !tools.is_empty() {
        a.extend(["--max-turns".to_string(), READ_TURNS.to_string(), "--settings".into(), r#"{"disableAllHooks":true}"#.into()]);
    }
    a.extend(["--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "project", "--system-prompt"].iter().map(|s| s.to_string()));
    a.push(i.system.clone());
    a
}

/// Environment variables that mark a process as a child of a Claude session (`PARENT_MARKERS` in `artifact.ts`).
const PARENT_MARKERS: [&str; 9] = [
    "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_PID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH",
];

/// `helperEnv`: the environment minus the parent session's markers, with artifacts never opened in a browser.
pub fn helper_env(env: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = env.into_iter().filter(|(k, _)| !PARENT_MARKERS.contains(&k.as_str()) && k != "CLAUDE_CODE_ARTIFACT_AUTO_OPEN").collect();
    out.push(("CLAUDE_CODE_ARTIFACT_AUTO_OPEN".into(), "0".into()));
    out
}

/// `makeSideCaller`'s options.
#[derive(Debug, Clone, Default)]
pub struct SideCaller {
    pub bin: Option<String>,
    /// Default folder for calls without their own (default `<data>/side-calls`).
    pub cwd: Option<PathBuf>,
    /// The environment calls get (default this process's, PATH with the folder `find_claude` found first).
    pub env: Option<Vec<(String, String)>>,
}

impl SideCaller {
    pub async fn call(&self, i: SideCallInput) -> SideCallResult {
        let cwd = i.cwd.clone().or_else(|| self.cwd.clone()).unwrap_or_else(|| ckanban_core::DataDir::from_env().root.join("side-calls"));
        let _ = tokio::fs::create_dir_all(&cwd).await;
        let bin = self.bin.clone().or_else(|| std::env::var("CKANBAN_CLAUDE_BIN").ok()).unwrap_or_else(|| "claude".into());
        let env = self.env.clone().unwrap_or_else(|| {
            std::env::vars().map(|(k, v)| if k == "PATH" { (k, claude::path_for_runs(&v)) } else { (k, v) }).collect()
        });
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(side_call_args(&i)).current_dir(&cwd).env_clear().envs(helper_env(env));
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let Ok(mut child) = cmd.spawn() else {
            return SideCallResult::Err { error: "Claude Code isn't installed or isn't on PATH".into(), cost_usd: None };
        };
        let model = i.model.clone().unwrap_or_else(|| "haiku".into());
        let mut stdin = child.stdin.take();
        let prompt = i.prompt.clone();
        let writer = tokio::spawn(async move {
            if let Some(s) = stdin.as_mut() {
                let _ = s.write_all(prompt.as_bytes()).await;
            }
            drop(stdin);
        });
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
        let pid = child.id();
        let timeout = Duration::from_millis(i.timeout_ms.unwrap_or(90_000));
        let waited = async {
            tokio::select! {
                s = child.wait() => s.ok(),
                _ = tokio::time::sleep(timeout) => {
                    // `p.kill()`: SIGTERM, then the call ends when the process does.
                    if let Some(p) = pid {
                        unsafe { libc::kill(p as i32, libc::SIGTERM) };
                    }
                    child.wait().await.ok()
                }
            }
        };
        let (status, out, err) = tokio::join!(waited, read_out, read_err);
        let _ = writer.await;
        let code = status.map(super::runner::exit_code).unwrap_or(-1);
        parse_side_result(&String::from_utf8_lossy(&out), code, &String::from_utf8_lossy(&err), &model)
    }
}

/// `parseSideResult`: the answer and cost from `claude -p --output-format json`.
pub fn parse_side_result(out: &str, code: i32, err: &str, model: &str) -> SideCallResult {
    let r = js::parse(js::trim(out)).filter(|v| v.is_object() || v.is_array());
    let Some(r) = r else {
        let msg = [js::trim(err), js::trim(out)].into_iter().find(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("claude exited with code {code}"));
        let lines: Vec<&str> = msg.split('\n').collect();
        return SideCallResult::Err { error: lines[lines.len().saturating_sub(2)..].join(" "), cost_usd: None };
    };
    // With --json-schema the answer is in structured_output (result may be empty or prose).
    let structured = match r.get("structured_output") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::stringify(v),
    };
    let text = if structured.is_empty() { r.get("result").and_then(Value::as_str).map(|t| js::trim(t).to_string()).unwrap_or_default() } else { structured };
    let cost_usd = r.get("total_cost_usd").and_then(Value::as_f64).filter(|c| *c > 0.0).unwrap_or(0.0);
    if js::truthy(r.get("is_error")) || text.is_empty() {
        let error = if text.is_empty() {
            let sub = match r.get("subtype") {
                None | Some(Value::Null) => "unknown".to_string(),
                Some(v) => js::to_string(v),
            };
            format!("claude answered with an error ({sub})")
        } else {
            text
        };
        return SideCallResult::Err { error, cost_usd: (cost_usd > 0.0).then_some(cost_usd) };
    }
    let used = match r.get("modelUsage") {
        Some(Value::Object(m)) => m.keys().next().cloned(),
        Some(Value::Array(a)) => (!a.is_empty()).then(|| "0".to_string()),
        _ => None,
    };
    SideCallResult::Ok { text, cost_usd, model: used.unwrap_or_else(|| model.to_string()) }
}

// ---------- the ticket's side ledger ----------

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SideSpend {
    pub cost_usd: f64,
    /// Cost by local day (YYYY-MM-DD), first seen first.
    pub days: Vec<(String, f64)>,
    /// Paid calls by local day.
    pub calls: Vec<(String, u64)>,
}

impl SideSpend {
    pub fn to_json(&self) -> Value {
        use ckanban_core::jsnum::num;
        serde_json::json!({
            "costUsd": num(self.cost_usd),
            "days": Value::Object(self.days.iter().map(|(d, c)| (d.clone(), num(*c))).collect()),
            "calls": Value::Object(self.calls.iter().map(|(d, c)| (d.clone(), Value::from(*c))).collect()),
        })
    }
}

/// `addSideSpend`: records a side call's cost on the ticket (file: its side-spend.jsonl).
pub fn add_side_spend(file: &Path, kind: &str, cost_usd: f64, at_ms: Option<f64>) -> std::io::Result<()> {
    if cost_usd.is_nan() || cost_usd <= 0.0 {
        return Ok(());
    }
    let line = js::stringify(&serde_json::json!({ "at": iso(at_ms.unwrap_or_else(now_ms)), "kind": kind, "costUsd": ckanban_core::jsnum::num(cost_usd) }));
    ckanban_core::jsonl::append_line(file, &line)
}

static SIDE_CACHE: Mutex<Option<HashMap<PathBuf, (String, SideSpend)>>> = Mutex::new(None);

/// `readSideSpend`: what a ticket's side calls cost, re-read only when the file changed (blocking: reads the file).
pub fn read_side_spend(file: &Path) -> SideSpend {
    let version = match std::fs::metadata(file) {
        Ok(m) => format!("{}:{}", m.len(), m.modified().map(system_ms).unwrap_or(0.0)),
        Err(_) => {
            if let Some(c) = SIDE_CACHE.lock().as_mut() {
                c.remove(file);
            }
            return SideSpend::default();
        }
    };
    if let Some((v, s)) = SIDE_CACHE.lock().as_ref().and_then(|c| c.get(file))
        && *v == version
    {
        return s.clone();
    }
    let mut spend = SideSpend::default();
    let text = std::fs::read(file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    for line in text.split('\n') {
        if js::trim(line).is_empty() {
            continue;
        }
        let Some(e) = js::parse(line).filter(Value::is_object) else { continue };
        let cost = e.get("costUsd").and_then(Value::as_f64).filter(|c| *c > 0.0).unwrap_or(0.0);
        if cost == 0.0 {
            continue;
        }
        spend.cost_usd += cost;
        let day = value_ms(e.get("at")).map(day_key).unwrap_or_default();
        match spend.days.iter_mut().find(|(d, _)| *d == day) {
            Some(x) => x.1 += cost,
            None => spend.days.push((day.clone(), cost)),
        }
        match spend.calls.iter_mut().find(|(d, _)| *d == day) {
            Some(x) => x.1 += 1,
            None => spend.calls.push((day, 1)),
        }
    }
    SIDE_CACHE.lock().get_or_insert_with(HashMap::new).insert(file.to_path_buf(), (version, spend.clone()));
    spend
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_answers() {
        let ok = parse_side_result(r#"{"result":" hi ","total_cost_usd":0.002,"modelUsage":{"claude-haiku-5-5":{}}}"#, 0, "", "haiku");
        assert_eq!(ok, SideCallResult::Ok { text: "hi".into(), cost_usd: 0.002, model: "claude-haiku-5-5".into() });
        let bad = parse_side_result("oops\nline2\nline3", 1, "", "haiku");
        assert_eq!(bad, SideCallResult::Err { error: "line2 line3".into(), cost_usd: None });
    }
}
