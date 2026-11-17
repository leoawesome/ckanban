//! Registering `ckanban mcp` with outside agents (P2): `install` and `uninstall` of `AgentRegistry` in
//! `src/integrations/agents.ts` and the `/api/agents` routes of `src/api/connections.ts`. Claude Code goes through
//! `claude mcp remove|add --scope user ckanban -- <argv>` (run in the home folder, 60 s at most); Codex through
//! `~/.codex/config.toml` (`$CODEX_HOME`), rewritten atomically with its permissions kept. The status list is
//! `crate::agents` (the front's `GET /api/agents`).

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::{Answer, Call};
use crate::agents::{Agents, HEADER, claude_entry, is_our_table, read_codex_server};

const SERVER_NAME: &str = "ckanban";
const AGENT_IDS: [&str; 2] = ["claude", "codex"];
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(60);

/// `removeCodexServer`: drops `[mcp_servers.ckanban]` (and its sub-tables) from a config.toml, keeping everything else.
pub fn remove_codex_server(toml: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in toml.split('\n') {
        if let Some(h) = HEADER.captures(line) {
            skipping = is_our_table(&h[1]);
        }
        if !skipping {
            out.push(line);
        }
    }
    collapse_newlines(&out.join("\n"))
}

/// `.replace(/\n{3,}/g, "\n\n")`.
fn collapse_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0;
    for c in s.chars() {
        if c == '\n' {
            run += 1;
            continue;
        }
        out.push_str(if run >= 3 { "\n\n" } else { &"\n\n"[..run] });
        run = 0;
        out.push(c);
    }
    out.push_str(if run >= 3 { "\n\n" } else { &"\n\n"[..run] });
    out
}

/// `.replace(/\s+$/, "")`.
fn trim_end_js(s: &str) -> &str {
    s.trim_end_matches(crate::js::is_space)
}

/// `setCodexServer`: adds or replaces `[mcp_servers.ckanban]` in a config.toml.
pub fn set_codex_server(toml: &str, argv: &[String]) -> String {
    let (command, args) = argv.split_first().map(|(c, a)| (c.as_str(), a)).unwrap_or(("", &[]));
    // JSON strings are valid TOML basic strings.
    let args = serde_json::to_string(args).unwrap_or_default().replace("\",\"", "\", \"");
    let block = format!("[mcp_servers.{SERVER_NAME}]\ncommand = {}\nargs = {args}\n", serde_json::to_string(command).unwrap_or_default());
    let removed = remove_codex_server(toml);
    let rest = trim_end_js(&removed);
    if rest.is_empty() { block } else { format!("{rest}\n\n{block}") }
}

/// `atomicWrite`: through `<file>.tmp-<id>`, keeping the original permissions (config.toml may hold tokens).
fn atomic_write(file: &Path, content: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut b = [0u8; 6];
    let _ = getrandom::fill(&mut b);
    let id: String = b.iter().map(|x| char::from_digit((*x % 36) as u32, 36).unwrap_or('0')).collect();
    let tmp = PathBuf::from(format!("{}.tmp-{id}", file.display()));
    std::fs::write(&tmp, content)?;
    if let Ok(m) = std::fs::metadata(file) {
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(m.permissions().mode() & 0o777))?;
    }
    std::fs::rename(&tmp, file)
}

pub struct AgentsAdmin {
    status: Arc<Agents>,
    claude_bin: String,
    claude_config: PathBuf,
    codex_config: PathBuf,
    home: PathBuf,
    /// One install or uninstall at a time (each reads, then writes, the same config files).
    busy: tokio::sync::Mutex<()>,
}

impl AgentsAdmin {
    /// With the paths Bun's `AgentRegistry` uses by default: `CKANBAN_CLAUDE_BIN` or `claude`, `$CLAUDE_CONFIG_DIR` or
    /// the home folder for `.claude.json`, `$CODEX_HOME` or `~/.codex` for `config.toml`.
    pub fn new(status: Arc<Agents>) -> Arc<AgentsAdmin> {
        let home = ckanban_core::home::home_dir();
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        Self::with(
            status,
            std::env::var("CKANBAN_CLAUDE_BIN").unwrap_or_else(|_| "claude".into()),
            env("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.clone()).join(".claude.json"),
            env("CODEX_HOME").unwrap_or_else(|| home.join(".codex")).join("config.toml"),
            home,
        )
    }

    pub fn with(status: Arc<Agents>, claude_bin: String, claude_config: PathBuf, codex_config: PathBuf, home: PathBuf) -> Arc<AgentsAdmin> {
        Arc::new(AgentsAdmin { status, claude_bin, claude_config, codex_config, home, busy: tokio::sync::Mutex::new(()) })
    }

    fn argv(&self) -> &[String] {
        self.status.server_argv()
    }

    /// Registers (or re-points) the ckanban MCP. Nothing to do when it's already current.
    pub async fn install(&self, id: &str) -> Result<(), Answer> {
        let _g = self.busy.lock().await;
        match id {
            "claude" => {
                let entry = claude_entry(&self.claude_config);
                if entry.as_deref() == Some(self.argv()) {
                    return Ok(());
                }
                if entry.is_some() {
                    self.claude(&["mcp", "remove", SERVER_NAME, "--scope", "user"]).await?;
                }
                let mut args: Vec<&str> = vec!["mcp", "add", "--scope", "user", SERVER_NAME, "--"];
                args.extend(self.argv().iter().map(String::as_str));
                self.claude(&args).await
            }
            "codex" => {
                let text = std::fs::read_to_string(&self.codex_config).unwrap_or_default();
                if read_codex_server(&text).as_deref() == Some(self.argv()) {
                    return Ok(());
                }
                atomic_write(&self.codex_config, &set_codex_server(&text, self.argv())).map_err(|e| Answer::error(500, e.to_string()))
            }
            _ => Err(Answer::error(400, format!("unknown agent {id}"))),
        }
    }

    pub async fn uninstall(&self, id: &str) -> Result<(), Answer> {
        let _g = self.busy.lock().await;
        match id {
            "claude" => {
                if claude_entry(&self.claude_config).is_some() {
                    self.claude(&["mcp", "remove", SERVER_NAME, "--scope", "user"]).await?;
                }
                Ok(())
            }
            "codex" => {
                let text = std::fs::read_to_string(&self.codex_config).unwrap_or_default();
                if read_codex_server(&text).is_some() {
                    let next = format!("{}\n", trim_end_js(&remove_codex_server(&text)));
                    atomic_write(&self.codex_config, &next).map_err(|e| Answer::error(500, e.to_string()))?;
                }
                Ok(())
            }
            _ => Err(Answer::error(400, format!("unknown agent {id}"))),
        }
    }

    /// `claude <args>` in the home folder; a failure is a 502 with the last lines it printed.
    async fn claude(&self, args: &[&str]) -> Result<(), Answer> {
        use std::os::unix::process::ExitStatusExt;
        let not_found = || Answer::error(502, format!("Claude CLI not found ({}). Is Claude Code installed and on PATH?", self.claude_bin));
        let mut cmd = tokio::process::Command::new(&self.claude_bin);
        cmd.args(args).current_dir(&self.home).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
        let child = cmd.spawn().map_err(|_| not_found())?;
        let pid = child.id();
        let wait = child.wait_with_output();
        tokio::pin!(wait);
        let out = tokio::select! {
            o = &mut wait => o,
            _ = tokio::time::sleep(CLAUDE_TIMEOUT) => {
                if let Some(pid) = pid {
                    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
                }
                // Not forever: a CLI that ignores the signal, or a child holding its pipes, gets SIGKILL after 5 s and
                // the request ends (a hung install would block every later one).
                match tokio::time::timeout(std::time::Duration::from_secs(5), &mut wait).await {
                    Ok(o) => o,
                    Err(_) => {
                        if let Some(pid) = pid {
                            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
                        }
                        match tokio::time::timeout(std::time::Duration::from_secs(5), &mut wait).await {
                            Ok(o) => o,
                            Err(_) => Err(std::io::Error::other(format!("claude {} didn't stop after 60s", args.iter().take(2).cloned().collect::<Vec<_>>().join(" ")))),
                        }
                    }
                }
            }
        }
        .map_err(|e| Answer::error(502, e.to_string()))?;
        if out.status.success() {
            return Ok(());
        }
        let code = out.status.code().unwrap_or_else(|| 128 + out.status.signal().unwrap_or(0));
        let (o, e) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let said = [crate::js::trim(&e), crate::js::trim(&o)].into_iter().find(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("exit code {code}"));
        let lines: Vec<&str> = said.split('\n').collect();
        let tail = lines[lines.len().saturating_sub(3)..].join("\n");
        Err(Answer::error(502, format!("claude {} failed: {tail}", args.iter().take(2).copied().collect::<Vec<_>>().join(" "))))
    }

    async fn status_list(&self) -> Value {
        let s = self.status.clone();
        tokio::task::spawn_blocking(move || s.status()).await.unwrap_or(Value::Array(vec![]))
    }

    /// `/api/agents...` (src/api/connections.ts): `GET /api/agents`, `POST /api/agents/:id/install|uninstall` (then
    /// `on_claude_changed` for Claude Code: the Connections list is checked again), 404 for anything else.
    pub async fn answer(&self, c: &Call<'_>, on_claude_changed: &(dyn Fn() + Send + Sync)) -> Option<Answer> {
        if c.parts.first().map(String::as_str) != Some("agents") {
            return None;
        }
        if c.parts.len() == 1 && c.method == "GET" {
            return Some(Answer::Json(200, self.status_list().await));
        }
        let id = c.parts.get(1).map(String::as_str).unwrap_or("");
        let action = c.parts.get(2).map(String::as_str).unwrap_or("");
        if c.parts.len() == 3 && c.method == "POST" && AGENT_IDS.contains(&id) && (action == "install" || action == "uninstall") {
            let r = if action == "install" { self.install(id).await } else { self.uninstall(id).await };
            if let Err(a) = r {
                return Some(a);
            }
            if id == "claude" {
                on_claude_changed();
            }
            return Some(Answer::Json(200, self.status_list().await));
        }
        Some(Answer::error(404, "not found"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Made by Bun's `setCodexServer` / `removeCodexServer` (src/integrations/agents.ts).
    #[test]
    fn codex_config_text_like_bun() {
        let argv: Vec<String> = vec!["/usr/bin/bun".into(), "/r/src/cli.ts".into(), "mcp".into()];
        assert_eq!(set_codex_server("", &argv), "[mcp_servers.ckanban]\ncommand = \"/usr/bin/bun\"\nargs = [\"/r/src/cli.ts\", \"mcp\"]\n");
        let toml = "model = \"o3\"\n\n\n\n[mcp_servers.ckanban]\ncommand = \"old\"\n[mcp_servers.ckanban.env]\nX = \"1\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n  \n";
        assert_eq!(remove_codex_server(toml), "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n  \n");
        assert_eq!(
            set_codex_server(toml, &argv),
            "model = \"o3\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n\n[mcp_servers.ckanban]\ncommand = \"/usr/bin/bun\"\nargs = [\"/r/src/cli.ts\", \"mcp\"]\n"
        );
        assert_eq!(set_codex_server("x = 1", &["c".to_string()]), "x = 1\n\n[mcp_servers.ckanban]\ncommand = \"c\"\nargs = []\n");
        assert_eq!(collapse_newlines("a\n\n\n\nb\nc\n\n"), "a\n\nb\nc\n\n");
    }

    fn admin(dir: &Path, claude_bin: &str) -> Arc<AgentsAdmin> {
        let bun = dir.join("bun");
        std::fs::write(&bun, [0u8, 1, 2]).unwrap();
        std::fs::create_dir_all(dir.join("repo/src")).unwrap();
        std::fs::write(dir.join("repo/src/cli.ts"), "").unwrap();
        let agents = Arc::new(Agents::new(&bun, &dir.join("repo")).unwrap());
        AgentsAdmin::with(agents, claude_bin.into(), dir.join(".claude.json"), dir.join("codex/config.toml"), dir.to_path_buf())
    }

    fn tmp() -> PathBuf {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).unwrap();
        let d = std::env::temp_dir().join(format!("ck-agents-{}-{}", std::process::id(), u32::from_le_bytes(b)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn codex_install_and_uninstall_keep_the_rest_and_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp();
        let a = admin(&d, "/nonexistent/claude");
        let file = d.join("codex/config.toml");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "model = \"o3\"\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        a.install("codex").await.unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.starts_with("model = \"o3\"\n\n[mcp_servers.ckanban]\ncommand = "), "{text}");
        assert_eq!(read_codex_server(&text).as_deref(), Some(a.argv()));
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        a.uninstall("codex").await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "model = \"o3\"\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn claude_install_runs_claude_mcp_and_reports_failures() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp();
        let missing = admin(&d, "/nonexistent/claude");
        assert_eq!(missing.install("claude").await, Err(Answer::error(502, "Claude CLI not found (/nonexistent/claude). Is Claude Code installed and on PATH?")));
        let bin = d.join("claude");
        std::fs::write(&bin, format!("#!/bin/sh\necho \"$PWD $*\" >> {}/calls\nif [ \"$2\" = remove ]; then exit 0; fi\nprintf 'a\\nb\\nc\\nd\\n' >&2\nexit 2\n", d.display())).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // An old registration: removed, then added again.
        std::fs::write(d.join(".claude.json"), r#"{"mcpServers":{"ckanban":{"command":"old"}}}"#).unwrap();
        let a = admin(&d, bin.to_str().unwrap());
        assert_eq!(a.install("claude").await, Err(Answer::error(502, "claude mcp add failed: b\nc\nd")));
        let calls = std::fs::read_to_string(d.join("calls")).unwrap();
        let home = std::fs::canonicalize(&d).unwrap();
        let lines: Vec<&str> = calls.lines().collect();
        assert_eq!(lines[0], format!("{} mcp remove ckanban --scope user", home.display()));
        assert!(lines[1].starts_with(&format!("{} mcp add --scope user ckanban -- ", home.display())), "{calls}");
        assert!(lines[1].ends_with("/repo/src/cli.ts mcp"));
        // The route: unknown shapes are 404, a failure keeps its status.
        let user = |_: &str| Ok(());
        let parts = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let p = parts(&["agents", "gemini", "install"]);
        let call = Call { method: "POST", parts: &p, query: "", body: b"", local: true, from_run: false, user: &user };
        assert_eq!(a.answer(&call, &|| {}).await, Some(Answer::error(404, "not found")));
        let p = parts(&["agents", "claude", "uninstall"]);
        let call = Call { method: "POST", parts: &p, query: "", body: b"", local: true, from_run: false, user: &user };
        let refreshed = std::sync::atomic::AtomicBool::new(false);
        let Some(Answer::Json(200, v)) = a.answer(&call, &|| refreshed.store(true, std::sync::atomic::Ordering::SeqCst)).await else { panic!() };
        assert_eq!(v[0]["id"], "claude");
        assert!(refreshed.load(std::sync::atomic::Ordering::SeqCst));
        let p = parts(&["usage"]);
        let call = Call { method: "GET", parts: &p, query: "", body: b"", local: true, from_run: false, user: &user };
        assert_eq!(a.answer(&call, &|| {}).await, None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
