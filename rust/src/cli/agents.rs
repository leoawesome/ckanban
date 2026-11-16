//! `ckanban mcp install|uninstall|status`: registers this CLI's `mcp` with Claude Code (`claude mcp add --scope user`)
//! and Codex (`$CODEX_HOME/config.toml`), as `AgentRegistry` in `src/integrations/agents.ts` does. No HTTP.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::args::{self, js_str};
use super::{TICKET_USAGE, home, out};

const SERVER_NAME: &str = "ckanban";
/// How long one `claude mcp ...` call may take before it is killed.
const CLAUDE_LIMIT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, PartialEq)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    pub fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
        }
    }
}

pub struct Status {
    pub agent: Agent,
    pub available: bool,
    pub installed: bool,
    pub current: bool,
    pub command: Option<String>,
    pub config_path: PathBuf,
}

pub struct Registry {
    claude_bin: String,
    codex_bin: String,
    claude_config: PathBuf,
    codex_config: PathBuf,
    pub server_argv: Vec<String>,
}

/// `Bun.which`: a name with a slash must be an executable file; else the first executable on PATH.
pub fn which(bin: &str) -> Option<PathBuf> {
    let exec = |p: &Path| p.is_file() && std::fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        return exec(&p).then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(bin)).find(|p| exec(p))
}

impl Registry {
    pub fn new() -> Self {
        let env = |k: &str| std::env::var(k).ok();
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "ckanban".into());
        Registry {
            claude_bin: env("CKANBAN_CLAUDE_BIN").unwrap_or_else(|| "claude".into()),
            codex_bin: "codex".into(),
            claude_config: PathBuf::from(env("CLAUDE_CONFIG_DIR").unwrap_or_else(home)).join(".claude.json"),
            codex_config: PathBuf::from(env("CODEX_HOME").unwrap_or_else(|| format!("{}/.codex", home()))).join("config.toml"),
            server_argv: vec![exe, "mcp".into()],
        }
    }

    fn claude_entry(&self) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(&self.claude_config).ok()?;
        let v: Value = serde_json::from_str(&text).ok()?;
        let e = v.get("mcpServers")?.get(SERVER_NAME)?;
        let command = e.get("command")?.as_str()?.to_string();
        let mut argv = vec![command];
        if let Some(a) = e.get("args").and_then(Value::as_array) {
            argv.extend(a.iter().map(|x| js_str(Some(x))));
        }
        Some(argv)
    }

    fn codex_text(&self) -> String {
        std::fs::read_to_string(&self.codex_config).unwrap_or_default()
    }

    pub fn status(&self) -> Vec<Status> {
        let claude = self.claude_entry();
        let codex = read_codex_server(&self.codex_text());
        let same = |a: &Option<Vec<String>>| a.as_ref() == Some(&self.server_argv);
        vec![
            Status {
                agent: Agent::Claude,
                available: which(&self.claude_bin).is_some(),
                installed: claude.is_some(),
                current: same(&claude),
                command: claude.as_ref().map(|a| a.join(" ")),
                config_path: self.claude_config.clone(),
            },
            Status {
                agent: Agent::Codex,
                available: which(&self.codex_bin).is_some() || self.codex_config.parent().is_some_and(Path::exists),
                installed: codex.is_some(),
                current: same(&codex),
                command: codex.as_ref().map(|a| a.join(" ")),
                config_path: self.codex_config.clone(),
            },
        ]
    }

    /// Registers (or re-points) the ckanban MCP; nothing when it's already current.
    pub fn install(&self, a: Agent, limit: Duration) -> Result<(), String> {
        match a {
            Agent::Claude => {
                let entry = self.claude_entry();
                if entry.as_ref() == Some(&self.server_argv) {
                    return Ok(());
                }
                if entry.is_some() {
                    self.claude(&["mcp", "remove", SERVER_NAME, "--scope", "user"], limit)?;
                }
                let mut argv: Vec<&str> = vec!["mcp", "add", "--scope", "user", SERVER_NAME, "--"];
                argv.extend(self.server_argv.iter().map(String::as_str));
                self.claude(&argv, limit)
            }
            Agent::Codex => {
                let text = self.codex_text();
                if read_codex_server(&text).as_ref() == Some(&self.server_argv) {
                    return Ok(());
                }
                atomic_write(&self.codex_config, &set_codex_server(&text, &self.server_argv)).map_err(|e| e.to_string())
            }
        }
    }

    pub fn uninstall(&self, a: Agent, limit: Duration) -> Result<(), String> {
        match a {
            Agent::Claude => {
                if self.claude_entry().is_some() {
                    self.claude(&["mcp", "remove", SERVER_NAME, "--scope", "user"], limit)?;
                }
                Ok(())
            }
            Agent::Codex => {
                let text = self.codex_text();
                if read_codex_server(&text).is_some() {
                    atomic_write(&self.codex_config, &format!("{}\n", trim_end_ws(&remove_codex_server(&text)))).map_err(|e| e.to_string())?;
                }
                Ok(())
            }
        }
    }

    /// Runs `claude <args>` in the home folder. `limit` under 60 s is a caller's own limit: hitting it gives
    /// `no answer after N seconds` (uninstall's step limit); else the call is killed at 60 s like Bun does.
    fn claude(&self, argv: &[&str], limit: Duration) -> Result<(), String> {
        let mut child = Command::new(&self.claude_bin)
            .args(argv)
            .current_dir(home())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| format!("Claude CLI not found ({}). Is Claude Code installed and on PATH?", self.claude_bin))?;
        let mut so = child.stdout.take().expect("piped");
        let mut se = child.stderr.take().expect("piped");
        let t_out = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = so.read_to_end(&mut b);
            b
        });
        let t_err = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = se.read_to_end(&mut b);
            b
        });
        let deadline = Instant::now() + limit.min(CLAUDE_LIMIT);
        let status = loop {
            if let Ok(Some(s)) = child.try_wait() {
                break s;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let s = child.wait().map_err(|e| e.to_string())?;
                if limit < CLAUDE_LIMIT {
                    return Err(format!("no answer after {} seconds", limit.as_secs()));
                }
                break s;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
        if status.success() {
            return Ok(());
        }
        use std::os::unix::process::ExitStatusExt;
        let code = status.code().map(|c| c.to_string()).or_else(|| status.signal().map(|s| (128 + s).to_string())).unwrap_or_else(|| "1".into());
        let why = [stderr.trim(), stdout.trim()].into_iter().find(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("exit code {code}"));
        let lines: Vec<&str> = why.split('\n').collect();
        Err(format!("claude {} failed: {}", argv[..2].join(" "), lines[lines.len().saturating_sub(3)..].join("\n")))
    }
}

fn atomic_write(file: &Path, content: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".tmp-{}", ckanban_core::atomic::new_id()));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, content)?;
    // Keep the original permissions (config.toml may hold tokens).
    if let Ok(m) = std::fs::metadata(file) {
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(m.permissions().mode() & 0o777))?;
    }
    std::fs::rename(&tmp, file)
}

// --- Codex config.toml --------------------------------------------------------------------------------------------

/// JS `\s` for the few places it matters.
fn ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn trim_end_ws(s: &str) -> &str {
    s.trim_end_matches(ws)
}

/// The table name of a `[table]` / `[[table]]` header line, as the header regex in agents.ts reads it.
fn header(line: &str) -> Option<String> {
    let s = line.trim_start_matches(ws).strip_prefix('[')?;
    let s = s.strip_prefix('[').unwrap_or(s).trim_start_matches(ws);
    let close = s.find(']')?;
    let name = trim_end_ws(&s[..close]).to_string();
    let rest = &s[close + 1..];
    let rest = rest.strip_prefix(']').unwrap_or(rest).trim_start_matches(ws);
    let ok = rest.is_empty() || (rest.starts_with('#') && !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']));
    ok.then_some(name)
}

fn table_key(h: &str) -> Vec<String> {
    h.split('.')
        .map(|k| {
            let k = k.trim_matches(ws);
            for q in ['"', '\''] {
                if k.len() >= 2 && k.starts_with(q) && k.ends_with(q) {
                    return k[1..k.len() - 1].to_string();
                }
            }
            k.to_string()
        })
        .collect()
}

fn is_our_table(h: &str) -> bool {
    let k = table_key(h);
    k.first().map(String::as_str) == Some("mcp_servers") && k.get(1).map(String::as_str) == Some(SERVER_NAME)
}

/// Drops `[mcp_servers.ckanban]` (and its sub-tables), keeping everything else.
pub fn remove_codex_server(toml: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in toml.split('\n') {
        if let Some(h) = header(line) {
            skipping = is_our_table(&h);
        }
        if !skipping {
            out.push(line);
        }
    }
    // /\n{3,}/g → "\n\n"
    let joined = out.join("\n");
    let mut res = String::with_capacity(joined.len());
    let mut run = 0;
    for c in joined.chars() {
        if c == '\n' {
            run += 1;
            if run <= 2 {
                res.push(c);
            }
        } else {
            run = 0;
            res.push(c);
        }
    }
    res
}

pub fn set_codex_server(toml: &str, argv: &[String]) -> String {
    let command = serde_json::to_string(&argv[0]).unwrap_or_default();
    let args = serde_json::to_string(&argv[1..]).unwrap_or_default().replace("\",\"", "\", \"");
    let block = format!("[mcp_servers.{SERVER_NAME}]\ncommand = {command}\nargs = {args}\n");
    let removed = remove_codex_server(toml);
    let rest = trim_end_ws(&removed);
    if rest.is_empty() { block } else { format!("{rest}\n\n{block}") }
}

/// argv of the registered `[mcp_servers.ckanban]`, or None.
pub fn read_codex_server(toml: &str) -> Option<Vec<String>> {
    let mut inside = false;
    let mut command: Option<String> = None;
    let mut args_v: Vec<String> = Vec::new();
    for line in toml.split('\n') {
        if let Some(h) = header(line) {
            inside = table_key(&h).len() == 2 && is_our_table(&h);
            continue;
        }
        if !inside {
            continue;
        }
        let s = line.trim_start_matches(ws);
        let (key, rest) = if let Some(r) = s.strip_prefix("command") {
            ("command", r)
        } else if let Some(r) = s.strip_prefix("args") {
            ("args", r)
        } else {
            continue;
        };
        let Some(rest) = rest.trim_start_matches(ws).strip_prefix('=') else { continue };
        let raw = rest.trim_matches(ws);
        if raw.is_empty() || raw.contains(['\r', '\u{2028}', '\u{2029}']) {
            continue;
        }
        let raw = if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') { serde_json::to_string(&raw[1..raw.len() - 1]).unwrap_or_default() } else { raw.to_string() };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else { continue };
        match (key, v) {
            ("command", Value::String(c)) => command = Some(c),
            ("args", Value::Array(a)) => args_v = a.iter().map(|x| js_str(Some(x))).collect(),
            _ => {}
        }
    }
    command.filter(|c| !c.is_empty()).map(|c| std::iter::once(c).chain(args_v).collect())
}

// --- the command --------------------------------------------------------------------------------------------------

pub fn mcp_command(argv: &[String]) -> Result<(), String> {
    let p = args::parse(argv)?;
    let reg = Registry::new();
    match p.pos(0) {
        Some(action @ ("install" | "uninstall")) => {
            let picked: Vec<Agent> = [Agent::Claude, Agent::Codex].into_iter().filter(|a| p.on(a.id())).collect();
            let agents = if picked.is_empty() { vec![Agent::Claude, Agent::Codex] } else { picked };
            for a in agents {
                if action == "install" {
                    reg.install(a, CLAUDE_LIMIT)?;
                    out(&format!("{}: registered \"ckanban\" → {}", a.label(), reg.server_argv.join(" ")));
                } else {
                    reg.uninstall(a, CLAUDE_LIMIT)?;
                    out(&format!("{}: removed \"ckanban\"", a.label()));
                }
            }
            Ok(())
        }
        Some("status") => {
            for s in reg.status() {
                let state = if !s.installed {
                    "not registered".to_string()
                } else if s.current {
                    "registered".into()
                } else {
                    format!("registered with another command ({})", s.command.unwrap_or_default())
                };
                out(&format!("{}: {state}{}  [{}]", s.agent.label(), if s.available { "" } else { " (CLI not found)" }, s.config_path.display()));
            }
            Ok(())
        }
        _ => {
            let lines: Vec<&str> = TICKET_USAGE.split('\n').filter(|l| l.contains("ckanban mcp") || is_register_line(l)).collect();
            Err(format!("usage:\n{}", lines.join("\n")))
        }
    }
}

/// `/^\s{20,}Register/`.
fn is_register_line(l: &str) -> bool {
    let n = l.chars().take_while(|c| ws(*c)).count();
    n >= 20 && l.trim_start_matches(ws).starts_with("Register")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_block_kept_and_replaced() {
        let argv = vec!["/bin/ck".to_string(), "mcp".to_string()];
        let toml = "model = \"o3\"\n\n[mcp_servers.ckanban]\ncommand = \"/old\"\nargs = [\"mcp\"]\n\n[mcp_servers.ckanban.env]\nX = \"1\"\n\n[other]\nx = 1\n";
        assert_eq!(read_codex_server(toml), Some(vec!["/old".to_string(), "mcp".to_string()]));
        let block = "[mcp_servers.ckanban]\ncommand = \"/bin/ck\"\nargs = [\"mcp\"]\n";
        assert_eq!(set_codex_server(toml, &argv), format!("model = \"o3\"\n\n[other]\nx = 1\n\n{block}"));
        assert_eq!(set_codex_server("", &argv), block);
        assert_eq!(read_codex_server("[mcp_servers.ckanban]\ncommand = '/x'\n"), Some(vec!["/x".to_string()]));
        assert_eq!(header("  [[ a.b ]] # c"), Some("a.b".into()));
        assert_eq!(header("[a] ]"), None);
    }
}
