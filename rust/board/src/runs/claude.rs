//! Claude Code on this Mac (`src/runs/claude.ts`): its projects and sessions, its defaults, whether a session is
//! open in a terminal, and finding the `claude` command. Everything that reads files here is blocking: call it from
//! `spawn_blocking` (session files can be large).

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use ckanban_core::time::{iso, now_ms, system_ms};
use parking_lot::Mutex;
use regex::Regex;
use serde_json::Value;

use super::js;

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeProject {
    pub path: String,
    pub name: String,
    pub last_used: Option<String>,
}

impl ClaudeProject {
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "path": self.path, "name": self.name, "lastUsed": self.last_used })
    }
}

/// Where to look (`Dirs`); every field defaults to the real place.
#[derive(Debug, Clone, Default)]
pub struct Dirs {
    pub home_dir: Option<PathBuf>,
    pub config_dir: Option<PathBuf>,
    /// Paths under these prefixes are skipped (scratch/temp sessions).
    pub exclude_prefixes: Option<Vec<String>>,
    /// The board's own data folder: its helper folders are never a project.
    pub data_dir: Option<PathBuf>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

fn config_dir_of(d: &Dirs) -> PathBuf {
    if let Some(c) = &d.config_dir {
        return c.clone();
    }
    if let Some(c) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|c| !c.is_empty()) {
        return PathBuf::from(c);
    }
    d.home_dir.clone().unwrap_or_else(home).join(".claude")
}

fn read_json(file: &Path) -> Option<Value> {
    js::parse(&std::fs::read_to_string(file).ok()?)
}

/// Claude Code stores sessions under ~/.claude/projects/<cwd with every non-alphanumeric UTF-16 unit as "-">.
pub fn encode_project_dir(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_string() } else { "-".repeat(c.len_utf16()) }).collect()
}

fn temp_prefixes() -> Vec<String> {
    let tmp = std::env::var("TMPDIR").ok().filter(|t| !t.is_empty()).unwrap_or_else(|| "/tmp".into());
    // os.tmpdir() drops a trailing slash.
    let tmp = if tmp.len() > 1 { tmp.trim_end_matches('/').to_string() } else { tmp };
    ["/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/"].iter().map(|s| s.to_string()).chain([format!("{tmp}/")]).collect()
}

fn mtime_iso(p: &Path) -> Option<String> {
    std::fs::metadata(p).ok()?.modified().ok().map(|t| iso(system_ms(t)))
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// `listClaudeProjects`: folders the user has run Claude Code in, most recent session first.
pub fn list_claude_projects(d: &Dirs) -> Vec<ClaudeProject> {
    let home = d.home_dir.clone().unwrap_or_else(home);
    let config_dir = config_dir_of(d);
    // ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json when Claude Code is configured that way.
    let state_dir = match (&d.home_dir, std::env::var_os("CLAUDE_CONFIG_DIR").filter(|c| !c.is_empty())) {
        (None, Some(c)) => PathBuf::from(c),
        _ => home.clone(),
    };
    let state = read_json(&state_dir.join(".claude.json"));
    let mut internal: Vec<String> = Vec::new();
    let env_home = std::env::var("CKANBAN_HOME").ok().filter(|h| !h.is_empty()).map(PathBuf::from);
    for p in [Some(home.join(".claude-kanban")), d.data_dir.clone().or(env_home)].into_iter().flatten() {
        let p = s(&p);
        if !internal.contains(&p) {
            internal.push(p);
        }
    }
    let mut exclude = d.exclude_prefixes.clone().unwrap_or_else(temp_prefixes);
    exclude.extend(internal.iter().map(|p| format!("{}/", p.trim_end_matches('/'))));
    let home_bare = s(&home).trim_end_matches('/').to_string();
    let mut out = Vec::new();
    let paths: Vec<String> = match state.as_ref().and_then(|s| s.get("projects")) {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        _ => Vec::new(),
    };
    for path in paths {
        let bare = path.trim_end_matches('/');
        if bare == home_bare || internal.iter().any(|i| i == bare) || exclude.iter().any(|p| path.starts_with(p.as_str())) {
            continue;
        }
        if !std::fs::metadata(&path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let last_used = mtime_iso(&config_dir.join("projects").join(encode_project_dir(&path)));
        let name = path.rsplit('/').find(|x| !x.is_empty()).unwrap_or("").to_string();
        out.push(ClaudeProject { path, name, last_used });
    }
    out.sort_by(|a, b| match (&a.last_used, &b.last_used) {
        (Some(x), Some(y)) => js::locale_compare(y, x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => js::locale_compare(&a.path, &b.path),
    });
    out
}

/// `claudeDefaults`: user-level Claude Code defaults (model, effortLevel) as (model, effort).
pub fn claude_defaults(d: &Dirs) -> (Option<String>, Option<String>) {
    let settings = read_json(&config_dir_of(d).join("settings.json"));
    let text = |k: &str| settings.as_ref().and_then(|s| s.get(k)).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    (text("model"), text("effortLevel"))
}

/// `pickFolder`: the Mac's folder chooser; None when cancelled or not a Mac.
pub async fn pick_folder() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let script = r#"tell application (path to frontmost application as text) to POSIX path of (choose folder with prompt "Choose a folder for this board")"#;
    let out = tokio::process::Command::new("osascript").arg("-e").arg(script).current_dir(home()).output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let path = js::trim(&text).trim_end_matches('/').to_string();
    (!path.is_empty() && Path::new(&path).exists()).then_some(path)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeSession {
    pub id: String,
    pub title: Option<String>,
    pub first_prompt: Option<String>,
    pub last_active: String,
}

impl ClaudeSession {
    pub fn to_json(&self) -> Value {
        serde_json::json!({ "id": self.id, "title": self.title, "firstPrompt": self.first_prompt, "lastActive": self.last_active })
    }
}

static WRAPPER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(Base directory for this skill|Caveat:|\[Request interrupted)").expect("wrapper regex"));

fn prompt_text(content: Option<&Value>) -> Option<String> {
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|c| match (c.get("type").and_then(Value::as_str), c.get("text")) {
                // join() writes undefined and null as nothing.
                (Some("text"), Some(t)) if !t.is_null() => js::to_string(t),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    let t = js::trim(&text);
    // Skip slash-command / hook wrappers Claude Code stores as user messages.
    if t.is_empty() || t.starts_with('<') || WRAPPER_RE.is_match(t) {
        return None;
    }
    Some(js::head16(&js::squash_ws(t), 160).to_string())
}

/// `listSessions`: Claude Code sessions started in `project_path`, most recently active first (blocking: reads files).
pub fn list_sessions(project_path: &str, d: &Dirs, limit: usize) -> Vec<ClaudeSession> {
    let dir = config_dir_of(d).join("projects").join(encode_project_dir(project_path));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut files: Vec<(String, PathBuf, f64)> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".jsonl") else { continue };
        let file = dir.join(&name);
        // statSync throws in Bun for a file gone meanwhile: the whole list is then empty.
        let Some(m) = std::fs::metadata(&file).ok().and_then(|m| m.modified().ok()) else { return Vec::new() };
        files.push((id.to_string(), file, system_ms(m).trunc()));
    }
    files.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    files
        .into_iter()
        .take(limit)
        .map(|(id, file, mtime)| {
            let mut title = None;
            let mut ai_title = None;
            let mut first_prompt: Option<String> = None;
            let raw = std::fs::read(&file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            for line in raw.split('\n') {
                if line.is_empty() {
                    continue;
                }
                let is_title = line.contains("\"custom-title\"") || line.contains("\"ai-title\"");
                if !is_title && (first_prompt.is_some() || !line.contains("\"user\"")) {
                    continue;
                }
                let Some(ev) = js::parse(line) else { continue };
                let ty = ev.get("type").and_then(Value::as_str);
                if ty == Some("custom-title") && ev.get("customTitle").is_some_and(Value::is_string) {
                    title = ev["customTitle"].as_str().map(str::to_string);
                } else if ty == Some("ai-title") && ev.get("aiTitle").is_some_and(Value::is_string) {
                    ai_title = ev["aiTitle"].as_str().map(str::to_string);
                } else if first_prompt.is_none() && ty == Some("user") && ev.pointer("/message/role").and_then(Value::as_str) == Some("user") {
                    first_prompt = prompt_text(ev.pointer("/message/content"));
                }
            }
            ClaudeSession { id, title: title.or(ai_title), first_prompt, last_active: iso(mtime) }
        })
        .collect()
}

static CLAUDE_CMD_RE: LazyLock<Regex> = LazyLock::new(|| {
    let ws = js::WS;
    Regex::new(&format!(r"(^|{ws}|/)claude({ws}|$)|claude(-code)?/cli\.js")).expect("claude command regex")
});

/// A process command line that runs Claude Code.
pub fn is_claude_command(cmd: &str) -> bool {
    CLAUDE_CMD_RE.is_match(cmd)
}

/// True if any command line looks like a claude CLI resuming this session (by id or title).
pub fn live_session_match(commands: &[String], id: &str, title: Option<&str>) -> bool {
    commands.iter().any(|cmd| is_claude_command(cmd) && (cmd.contains(id) || title.is_some_and(|t| !t.is_empty() && cmd.contains(t))))
}

/// Every process's command line (`ps -axo args=`).
pub async fn process_commands() -> Vec<String> {
    match tokio::process::Command::new("ps").args(["-axo", "args="]).current_dir(home()).output().await {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

pub async fn is_session_live(id: &str, title: Option<&str>) -> bool {
    live_session_match(&process_commands().await, id, title)
}

/// `sessionTitle` (blocking).
pub fn session_title(project_path: &str, id: &str, d: &Dirs) -> Option<String> {
    list_sessions(project_path, d, 500).into_iter().find(|s| s.id == id).and_then(|s| s.title)
}

/// Where Claude Code's installers put `claude`, besides the folders `ckanban install` already adds to the PATH.
pub fn claude_install_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        home.join(".npm-global/bin"),
        home.join(".volta/bin"),
        home.join(".bun/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]
}

/// `Bun.which(name, { PATH })`: the first executable file of that name in PATH's folders.
pub fn which(name: &str, path: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    path.split(':').filter(|d| !d.is_empty()).map(|d| Path::new(d).join(name)).find(|p| {
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    })
}

/// The folder `find_claude` found `claude` in, put first in the PATH of every run (Bun adds it to its own PATH, which
/// runs inherit; changing this process's environment isn't safe in Rust, so runs get it from here).
static FOUND_DIR: Mutex<Option<String>> = Mutex::new(None);
static LAST_LOOKUP: Mutex<f64> = Mutex::new(f64::NEG_INFINITY);

/// The PATH a run gets: `base` with the folder `find_claude` found first.
pub fn path_for_runs(base: &str) -> String {
    match FOUND_DIR.lock().clone() {
        Some(dir) => std::iter::once(dir.as_str()).chain(base.split(':').filter(|p| !p.is_empty() && *p != dir)).collect::<Vec<_>>().join(":"),
        None => base.to_string(),
    }
}

pub type ShellLookup = Box<dyn FnOnce() -> futures_util::future::BoxFuture<'static, String> + Send>;

/// `findClaude`'s options; every field defaults to the real thing.
#[derive(Default)]
pub struct FindClaude {
    /// The PATH to look in and to update (default: this process's PATH with the folder found before).
    pub path: Option<String>,
    pub home: Option<PathBuf>,
    pub dirs: Option<Vec<PathBuf>>,
    pub shell: Option<ShellLookup>,
    pub min_interval_ms: Option<f64>,
    /// The login shell (default $SHELL, else /bin/zsh).
    pub shell_bin: Option<String>,
}

/// `findClaude`: makes `claude` findable when Claude Code was installed after the board started, or somewhere the
/// service's PATH doesn't cover: looks in the usual install folders, then asks the user's login shell. Returns whether
/// `claude` can be found, and the PATH with its folder first (also kept for every later run).
pub async fn find_claude(o: FindClaude) -> (bool, String) {
    let path = o.path.unwrap_or_else(|| path_for_runs(&std::env::var("PATH").unwrap_or_default()));
    if which("claude", &path).is_some() {
        return (true, path);
    }
    // Asking the shell takes a moment: not on every health check while Claude Code stays missing.
    {
        let mut last = LAST_LOOKUP.lock();
        if now_ms() - *last < o.min_interval_ms.unwrap_or(10_000.0) {
            return (false, path);
        }
        *last = now_ms();
    }
    let home_dir = o.home.clone().unwrap_or_else(home);
    let mut dir = o.dirs.unwrap_or_else(|| claude_install_dirs(&home_dir)).into_iter().find(|d| d.join("claude").exists()).map(|d| s(&d));
    if dir.is_none() {
        let out = match o.shell {
            Some(f) => f().await,
            None => {
                let sh = o.shell_bin.or_else(|| std::env::var("SHELL").ok().filter(|s| !s.is_empty())).unwrap_or_else(|| "/bin/zsh".into());
                let child = tokio::process::Command::new(sh).args(["-lic", "command -v claude"]).current_dir(&home_dir).kill_on_drop(true).output();
                match tokio::time::timeout(Duration::from_secs(5), child).await {
                    Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).into_owned(),
                    _ => String::new(),
                }
            }
        };
        let found = out.split('\n').map(js::trim).rfind(|l| l.starts_with('/') && l.ends_with("/claude")).map(str::to_string);
        if let Some(f) = found.filter(|f| Path::new(f).exists()) {
            dir = Some(f[..f.len() - "/claude".len()].to_string());
        }
    }
    let Some(dir) = dir else { return (false, path) };
    *FOUND_DIR.lock() = Some(dir.clone());
    let path = std::iter::once(dir.as_str()).chain(path.split(':').filter(|p| !p.is_empty() && *p != dir)).collect::<Vec<_>>().join(":");
    (true, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_and_dirs() {
        assert_eq!(encode_project_dir("/Users/a/my_app"), "-Users-a-my-app");
        assert!(is_claude_command("/opt/homebrew/bin/claude --resume abc"));
        assert!(is_claude_command("node /x/claude-code/cli.js"));
        assert!(!is_claude_command("claudette"));
        assert!(live_session_match(&["claude --resume s1".into()], "s1", None));
        assert!(!live_session_match(&["vim s1".into()], "s1", None));
    }
}
