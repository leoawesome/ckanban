//! `GET /api/agents` (the Connections panel's "Use the board from Claude Code / Codex"), ported from
//! `AgentRegistry.status()` in `src/integrations/agents.ts`: whether each agent's CLI is there and whether `ckanban mcp`
//! is registered with it, pointing at this ckanban. Read only: install and uninstall stay on Bun (they run `claude
//! mcp`, and Bun refreshes its in-memory Connections list after them).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::js;

const SERVER_NAME: &str = "ckanban";

pub struct Agents {
    /// `helperArgv()` of the Bun child plus `mcp`: `[bun's real path, <repo>/src/cli.ts, "mcp"]`.
    server_argv: Vec<String>,
}

impl Agents {
    /// None when the Bun child's `process.execPath` can't be known for sure (a wrapper script stands in for bun):
    /// Bun answers then.
    pub fn new(bun: &Path, repo: &Path) -> Option<Self> {
        let bun = std::fs::canonicalize(bun).ok()?;
        let head = std::fs::read(&bun).ok().map(|b| b.starts_with(b"#!"))?;
        if head {
            return None;
        }
        let cli = std::fs::canonicalize(repo.join("src").join("cli.ts")).ok()?;
        Some(Agents { server_argv: vec![bun.to_string_lossy().into_owned(), cli.to_string_lossy().into_owned(), "mcp".into()] })
    }

    /// The answer, as Bun's `status()` gives it (blocking: reads two small config files and looks along PATH).
    pub fn status(&self) -> Value {
        let env = |k: &str| std::env::var_os(k);
        let home = ckanban_core::home::home_dir();
        let claude_bin = std::env::var("CKANBAN_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
        let claude_config = env("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.clone()).join(".claude.json");
        let codex_config = env("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex")).join("config.toml");
        let claude = claude_entry(&claude_config);
        let codex = read_codex_server(&std::fs::read_to_string(&codex_config).unwrap_or_default());
        let codex_dir = codex_config.parent().is_some_and(|d| d.exists());
        json!([
            {
                "id": "claude", "label": "Claude Code", "available": which(&claude_bin), "installed": claude.is_some(),
                "current": claude.as_deref() == Some(&self.server_argv[..]), "command": claude.map(|a| a.join(" ")),
                "configPath": claude_config.to_string_lossy(),
            },
            {
                "id": "codex", "label": "Codex", "available": which("codex") || codex_dir, "installed": codex.is_some(),
                "current": codex.as_deref() == Some(&self.server_argv[..]), "command": codex.map(|a| a.join(" ")),
                "configPath": codex_config.to_string_lossy(),
            },
        ])
    }
}

/// `Bun.which(bin)`: a path is checked as given, a name is looked for along PATH; it must be an executable file.
fn which(bin: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let ok = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    if bin.is_empty() {
        return false;
    }
    if bin.contains('/') {
        return ok(Path::new(bin));
    }
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|d| !d.as_os_str().is_empty() && ok(&d.join(bin))))
}

/// `claudeEntry`: `mcpServers.ckanban` of Claude's config as argv.
fn claude_entry(file: &Path) -> Option<Vec<String>> {
    let v: Value = serde_json::from_slice(&std::fs::read(file).ok()?).ok()?;
    let e = v.get("mcpServers")?.get(SERVER_NAME)?;
    let command = e.get("command")?.as_str()?;
    let mut argv = vec![command.to_string()];
    if let Some(Value::Array(a)) = e.get("args") {
        argv.extend(a.iter().map(js::string));
    }
    Some(argv)
}

/// Any character but the line ends JS's `.` stops at.
const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";
const S: &str = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
static HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^{S}*\[\[?{S}*([^\]]*?){S}*\]\]?{S}*(?:#{DOT}*)?$")).unwrap());
static ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^{S}*(command|args){S}*={S}*({DOT}+?){S}*$")).unwrap());
static SINGLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^'({DOT}*)'$")).unwrap());

fn table_key(header: &str) -> Vec<String> {
    header
        .split('.')
        .map(|k| {
            let k = js::trim(k);
            let unq = |q: char| k.strip_prefix(q).and_then(|x| x.strip_suffix(q)).filter(|_| k.len() >= 2);
            unq('"').or_else(|| unq('\'')).unwrap_or(k).to_string()
        })
        .collect()
}

fn is_our_table(header: &str) -> bool {
    let k = table_key(header);
    k.first().map(String::as_str) == Some("mcp_servers") && k.get(1).map(String::as_str) == Some(SERVER_NAME)
}

/// `readCodexServer`: argv of the registered `[mcp_servers.ckanban]` in a Codex config.toml.
pub fn read_codex_server(toml: &str) -> Option<Vec<String>> {
    let mut inside = false;
    let mut command: Option<String> = None;
    let mut args: Vec<String> = Vec::new();
    for line in toml.split('\n') {
        if let Some(h) = HEADER.captures(line) {
            inside = table_key(&h[1]).len() == 2 && is_our_table(&h[1]);
            continue;
        }
        if !inside {
            continue;
        }
        let Some(m) = ENTRY.captures(line) else { continue };
        let raw = &m[2];
        let text = match SINGLE.captures(raw) {
            Some(c) => serde_json::to_string(&c[1]).unwrap_or_default(),
            None => raw.to_string(),
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        match (&m[1], v) {
            ("command", Value::String(s)) => command = Some(s),
            ("args", Value::Array(a)) => args = a.iter().map(js::string).collect(),
            _ => {}
        }
    }
    // `command ? [...] : null`: an empty command counts as none.
    let mut argv = vec![command.filter(|c| !c.is_empty())?];
    argv.extend(args);
    Some(argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codex_config_like_bun() {
        let toml = "model = \"x\"\n\n[mcp_servers.ckanban]\ncommand = \"/usr/bin/bun\"\nargs = [\"/r/src/cli.ts\", \"mcp\"]\n\n[mcp_servers.other]\ncommand = \"nope\"\n";
        assert_eq!(read_codex_server(toml), Some(vec!["/usr/bin/bun".into(), "/r/src/cli.ts".into(), "mcp".into()]));
        assert_eq!(read_codex_server("[mcp_servers.\"ckanban\"] # c\ncommand = '/a b'\n"), Some(vec!["/a b".into()]));
        assert_eq!(read_codex_server("[mcp_servers.ckanban.env]\ncommand = \"x\"\n"), None);
        assert_eq!(read_codex_server("[mcp_servers.ckanban]\nargs = [\"a\"]\n"), None);
        assert_eq!(read_codex_server("[mcp_servers.ckanban]\ncommand = \"x\"\nargs = [1, null]\n"), Some(vec!["x".into(), "1".into(), "null".into()]));
        assert_eq!(read_codex_server(""), None);
    }

    #[test]
    fn which_needs_an_executable_file() {
        assert!(which("sh"));
        assert!(which("/bin/sh"));
        assert!(!which("/etc/hosts"));
        assert!(!which("no-such-program-ckrs"));
        assert!(!which(""));
    }
}
