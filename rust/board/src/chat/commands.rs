//! Slash commands a ticket chat can run (`src/chat/commands.ts`): skills, custom commands and a few built-ins. The
//! board lists them for the composer's `/` picker and decides how to send a message that starts with one
//! (`slash_message`). Claude Code's bundled skills are learned from a run's init event (`remember_init`) and saved in
//! `<data>/claude-commands.json`, Bun's file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::runs::js;

#[derive(Clone, Debug, PartialEq)]
pub struct SlashCommand {
    pub name: String,
    /// skill, command or builtin.
    pub kind: &'static str,
    /// user, project, plugin, claude (bundled with Claude Code) or board (the board runs it itself).
    pub source: &'static str,
    pub description: String,
    /// Runs inside Claude Code without a model turn.
    pub local: bool,
    /// `user-invocable: false`: only Claude may use it, so it isn't offered.
    pub hidden: bool,
}

impl SlashCommand {
    /// The picker's JSON (`({ local, ...c }) => c`): name, kind, source, description.
    pub fn view(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("kind".into(), json!(self.kind));
        m.insert("source".into(), json!(self.source));
        m.insert("description".into(), json!(self.description));
        if self.hidden {
            m.insert("hidden".into(), json!(true));
        }
        Value::Object(m)
    }
}

fn builtin(name: &str, source: &'static str, local: bool, description: &str) -> SlashCommand {
    SlashCommand { name: name.into(), kind: "builtin", source, description: description.into(), local, hidden: false }
}

/// `BUILTINS`: compact and context run natively in `claude -p`; model and effort are the board's.
pub fn builtins() -> Vec<SlashCommand> {
    vec![
        builtin("compact", "claude", true, "Summarise the conversation to free up context"),
        builtin("context", "claude", true, "Show how much context the conversation uses"),
        builtin("model", "board", false, "Switch the model for this ticket's next runs (e.g. /model sonnet)"),
        builtin("effort", "board", false, "Set how hard Claude thinks on this ticket's next runs (e.g. /effort high)"),
    ]
}

/// `BOARD_COMMANDS`.
pub fn is_board_command(name: &str) -> bool {
    matches!(name, "model" | "effort")
}

/// `REFUSED_COMMANDS`: built-ins that would switch or end Claude Code's session behind the board's back.
pub fn is_refused(name: &str) -> bool {
    matches!(name, "clear" | "resume" | "exit" | "quit")
}

/// `TERMINAL_COMMANDS`: Claude Code built-ins that only make sense in its terminal UI.
pub const TERMINAL_COMMANDS: &[&str] = &[
    "add-dir", "agents", "auto-mode-setup", "autocompact", "bashes", "bug", "clear", "color", "config", "cost", "doctor",
    "effort", "exit", "export", "fast", "feedback", "focus", "heapdump", "help", "hooks", "ide", "import", "init", "insights",
    "install-github-app", "keybindings", "login", "logout", "mcp", "memory", "migrate-installer", "output-style", "permissions",
    "plugin", "plugins", "privacy-settings", "quit", "recap", "release-notes", "reload-plugins", "reload-skills", "rename",
    "resume", "rewind", "sandbox", "status", "statusline", "tasks", "terminal-setup", "theme", "todos", "upgrade", "usage",
    "usage-credits", "extra-usage", "vim",
];

fn is_terminal(name: &str) -> bool {
    TERMINAL_COMMANDS.contains(&name)
}

static FRONT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n---\r?\n?").unwrap());
static FLAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)^user-invocable:\s*["']?(true|false)["']?\s*$"#).unwrap());
static KV: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(name|description):\s*(.*)$").unwrap());
static BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[>|][-+]?$").unwrap());
static INDENTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s+\S").unwrap());
static HEADING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#+\s*").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());

#[derive(Debug, Default, PartialEq)]
pub struct Front {
    pub name: Option<String>,
    pub description: String,
    pub user_invocable: Option<bool>,
}

/// `^(["'])([\s\S]*)\1$` → `$2`.
fn unquote(v: &str) -> String {
    let c: Vec<char> = v.chars().collect();
    if c.len() >= 2 && (c[0] == '"' || c[0] == '\'') && c[c.len() - 1] == c[0] {
        return c[1..c.len() - 1].iter().collect();
    }
    v.to_string()
}

/// `frontmatter`: `description` (and `name`) from a markdown file's YAML frontmatter; the first text line when there
/// is none.
pub fn frontmatter(text: &str) -> Front {
    let mut out = Front::default();
    let m = FRONT.captures(text);
    if let Some(m) = &m {
        let lines: Vec<&str> = LINES.split(m.get(1).map_or("", |x| x.as_str())).collect();
        let mut i = 0;
        while i < lines.len() {
            if let Some(f) = FLAG.captures(lines[i]) {
                out.user_invocable = Some(f[1].to_lowercase() == "true");
            }
            let Some(kv) = KV.captures(lines[i]) else {
                i += 1;
                continue;
            };
            let mut v = js::trim(&kv[2]).to_string();
            if BLOCK.is_match(&v) {
                let mut block: Vec<String> = Vec::new();
                while i + 1 < lines.len() && INDENTED.is_match(lines[i + 1]) {
                    i += 1;
                    block.push(js::trim(lines[i]).to_string());
                }
                v = block.join(" ");
            }
            let v = unquote(&v);
            if &kv[1] == "name" {
                out.name = Some(v);
            } else {
                out.description = v;
            }
            i += 1;
        }
    }
    if out.description.is_empty() {
        let body = match &m {
            Some(m) => &text[m.get(0).unwrap().end()..],
            None => text,
        };
        out.description = LINES
            .split(body)
            .map(|l| js::trim(&HEADING.replace(l, "")).to_string())
            .find(|l| !l.is_empty())
            .unwrap_or_default();
    }
    out.description = js::trim(&SPACES.replace_all(&out.description, " ")).to_string();
    out
}

fn is_dir(p: &Path) -> bool {
    std::fs::metadata(p).is_ok_and(|m| m.is_dir())
}

/// A folder's entries sorted by name (`readdirSync(d).sort()`).
fn sorted(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort_by(|a, b| js::cmp16(a, b));
    v
}

fn read_json(file: &Path) -> Option<Value> {
    js::parse(&std::fs::read_to_string(file).ok()?)
}

/// `<dir>/<name>/SKILL.md` skills, named after the folder.
fn scan_skills(dir: &Path, source: &'static str, prefix: &str) -> Vec<SlashCommand> {
    if !is_dir(dir) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for d in sorted(dir) {
        let Ok(text) = std::fs::read_to_string(dir.join(&d).join("SKILL.md")) else { continue };
        let fm = frontmatter(&text);
        out.push(SlashCommand {
            name: format!("{prefix}{d}"),
            kind: "skill",
            source,
            description: fm.description,
            local: false,
            hidden: fm.user_invocable == Some(false),
        });
    }
    out
}

/// `<dir>/**/*.md` custom commands; subfolders become `folder:name`.
fn scan_commands(dir: &Path, source: &'static str, prefix: &str) -> Vec<SlashCommand> {
    if !is_dir(dir) {
        return Vec::new();
    }
    let mut out = Vec::new();
    fn walk(root: &Path, d: &Path, depth: u32, source: &'static str, prefix: &str, out: &mut Vec<SlashCommand>) {
        for f in sorted(d) {
            let p = d.join(&f);
            if is_dir(&p) {
                if depth < 3 {
                    walk(root, &p, depth + 1, source, prefix, out);
                }
                continue;
            }
            if !f.ends_with(".md") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            let name = rel[..rel.len() - 3].split(['/', '\\']).collect::<Vec<_>>().join(":");
            let fm = frontmatter(&text);
            out.push(SlashCommand {
                name: format!("{prefix}{name}"),
                kind: "command",
                source,
                description: fm.description,
                local: false,
                hidden: fm.user_invocable == Some(false),
            });
        }
    }
    walk(dir, dir, 0, source, prefix, &mut out);
    out
}

/// `pluginDirs`: install folders of the enabled plugins that apply to `projects`.
fn plugin_dirs(config: &Path, projects: &[String]) -> Vec<(String, PathBuf)> {
    let mut enabled: Map<String, Value> = Map::new();
    let mut add = |v: Option<Value>| {
        if let Some(Value::Object(m)) = v.and_then(|v| v.get("enabledPlugins").cloned()) {
            for (k, x) in m {
                enabled.insert(k, x);
            }
        }
    };
    add(read_json(&config.join("settings.json")));
    for p in projects {
        for f in ["settings.json", "settings.local.json"] {
            add(read_json(&Path::new(p).join(".claude").join(f)));
        }
    }
    let installed = read_json(&config.join("plugins").join("installed_plugins.json")).and_then(|v| v.get("plugins").cloned());
    let mut out = Vec::new();
    let Some(Value::Object(installed)) = installed else { return out };
    for (key, entries) in installed {
        let Value::Array(entries) = entries else { continue };
        if enabled.get(&key) != Some(&Value::Bool(true)) {
            continue;
        }
        let entry = entries.iter().find(|e| e.get("scope").and_then(Value::as_str) == Some("user")).or_else(|| {
            entries.iter().find(|e| e.get("projectPath").and_then(Value::as_str).is_some_and(|p| projects.iter().any(|x| x == p)))
        });
        let Some(install) = entry.and_then(|e| e.get("installPath")).and_then(Value::as_str) else { continue };
        let name = read_json(&Path::new(install).join(".claude-plugin").join("plugin.json"))
            .and_then(|v| v.get("name").cloned())
            .filter(|v| !v.is_null())
            .map(|v| js::to_string(&v))
            .unwrap_or_else(|| key.split('@').next().unwrap_or("").to_string());
        out.push((name, PathBuf::from(install)));
    }
    out
}

/// `scan`: built-ins, project, user and plugin skills and commands found on disk (hidden ones included).
fn scan(cwd: &str, projects: &[String]) -> Vec<SlashCommand> {
    let config = crate::sessions::files::config_dir();
    let mut all: Vec<String> = vec![cwd.to_string()];
    for p in projects {
        if !all.contains(p) {
            all.push(p.clone());
        }
    }
    let mut out: Vec<SlashCommand> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut add = |list: Vec<SlashCommand>| {
        for c in list {
            if !c.name.is_empty() && seen.insert(c.name.clone()) {
                out.push(c);
            }
        }
    };
    let cwd = Path::new(cwd);
    add(builtins());
    add(scan_skills(&cwd.join(".claude").join("skills"), "project", ""));
    add(scan_commands(&cwd.join(".claude").join("commands"), "project", ""));
    add(scan_skills(&config.join("skills"), "user", ""));
    add(scan_commands(&config.join("commands"), "user", ""));
    for (name, dir) in plugin_dirs(&config, &all) {
        add(scan_skills(&dir.join("skills"), "plugin", &format!("{name}:")));
        add(scan_commands(&dir.join("commands"), "plugin", &format!("{name}:")));
    }
    out
}

const CACHE: Duration = Duration::from_secs(30);

#[derive(Default)]
struct State {
    file: Option<PathBuf>,
    bundled: Option<Vec<String>>,
    last_init: HashMap<String, String>,
    cache: HashMap<String, (Instant, Vec<SlashCommand>)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

/// `useBundledFile`: where bundled skill names are saved (`<data>/claude-commands.json`); set at start.
pub fn use_bundled_file(file: Option<PathBuf>) {
    let mut s = STATE.lock();
    *s = State { file, ..Default::default() };
}

fn bundled_skills(s: &mut State) -> Vec<String> {
    if let Some(b) = &s.bundled {
        return b.clone();
    }
    let v = s.file.as_deref().and_then(read_json).and_then(|v| v.get("bundledSkills").cloned());
    let b: Vec<String> = match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    };
    s.bundled = Some(b.clone());
    b
}

/// `listCommands`: everything `/` can run in `cwd` (hidden skills left out), kept 30 s per folder. Blocking.
pub fn list_commands(cwd: &str, projects: &[String]) -> Vec<SlashCommand> {
    {
        let s = STATE.lock();
        if let Some((at, list)) = s.cache.get(cwd)
            && at.elapsed() < CACHE
        {
            return list.clone();
        }
    }
    let found = scan(cwd, projects);
    let mut s = STATE.lock();
    let taken: HashSet<&str> = found.iter().map(|c| c.name.as_str()).collect();
    let extra: Vec<SlashCommand> = bundled_skills(&mut s)
        .into_iter()
        .filter(|n| !taken.contains(n.as_str()))
        .map(|name| SlashCommand { name, kind: "skill", source: "claude", description: String::new(), local: false, hidden: false })
        .collect();
    let list: Vec<SlashCommand> = found.into_iter().chain(extra).filter(|c| !c.hidden).collect();
    s.cache.insert(cwd.to_string(), (Instant::now(), list.clone()));
    list
}

/// `rememberInit`: a run's init event; its skills the folder scan doesn't know (and aren't a plugin's `name:skill`) are
/// Claude Code's own. The disk scan (only when the list changed) runs off the caller's thread.
pub fn remember_init(cwd: &str, ev: &Value, projects: &[String]) {
    if ev.get("type").and_then(Value::as_str) != Some("system") || ev.get("subtype").and_then(Value::as_str) != Some("init") {
        return;
    }
    let strings = |k: &str| -> Vec<String> {
        match ev.get(k) {
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        }
    };
    let offered: HashSet<String> = strings("slash_commands").into_iter().collect();
    let mut candidates: Vec<String> = Vec::new();
    for n in strings("skills") {
        if !candidates.contains(&n) && offered.contains(&n) && !n.contains(':') && !is_terminal(&n) {
            candidates.push(n);
        }
    }
    candidates.sort_by(|a, b| js::cmp16(a, b));
    let key = candidates.join("\n");
    {
        let mut s = STATE.lock();
        if s.last_init.get(cwd) == Some(&key) {
            return;
        }
        s.last_init.insert(cwd.to_string(), key);
    }
    let (cwd, projects) = (cwd.to_string(), projects.to_vec());
    let work = move || {
        let known: HashSet<String> = scan(&cwd, &projects).into_iter().map(|c| c.name).collect();
        let names: Vec<String> = candidates.into_iter().filter(|n| !known.contains(n)).collect();
        let mut s = STATE.lock();
        s.cache.clear();
        if names.join("\n") == bundled_skills(&mut s).join("\n") {
            return;
        }
        s.bundled = Some(names.clone());
        let Some(file) = s.file.clone() else { return };
        drop(s);
        let text = serde_json::to_string_pretty(&json!({ "bundledSkills": names })).unwrap_or_default();
        if let Err(e) = ckanban_core::atomic::atomic_write(&file, text) {
            eprintln!("couldn't save bundled Claude Code skills {e}");
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn_blocking(work);
        }
        Err(_) => work(),
    }
}

static SLASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/([A-Za-z0-9][\w.:-]*)(?s:(\s.*)?)$").unwrap());

/// `parseSlash`: `/name rest` at the start of a message. Paths like `/Users/x` don't count.
pub fn parse_slash(text: &str) -> Option<(String, String)> {
    let t = js::trim(text);
    let c = SLASH.captures(t)?;
    Some((c[1].to_string(), js::trim(c.get(2).map_or("", |m| m.as_str())).to_string()))
}

/// `slashMessage`: the command a chat message runs (command, args, text to send), or None for plain text.
pub fn slash_message(text: &str, commands: &[SlashCommand]) -> Option<(SlashCommand, String, String)> {
    let (name, args) = parse_slash(text)?;
    let command = commands.iter().find(|c| c.name == name)?.clone();
    let text = if args.is_empty() { format!("/{name}") } else { format!("/{name} {args}") };
    Some((command, args, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_reads_fields() {
        let f = frontmatter("---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS\n");
        assert_eq!(f.description, "Say hello");
        let f = frontmatter("---\nname: x\ndescription: >\n  one\n  two\nuser-invocable: \"false\"\n---\n");
        assert_eq!((f.name.as_deref(), f.description.as_str(), f.user_invocable), (Some("x"), "one two", Some(false)));
        assert_eq!(frontmatter("# Title here\n\nmore").description, "Title here");
        assert_eq!(frontmatter("---\ndescription: 'quoted  text'\n---\n").description, "quoted text");
        assert_eq!(frontmatter("---\nfoo: 1\n---\n\n## Body line\n").description, "Body line");
    }

    #[test]
    fn slash_parsing() {
        assert_eq!(parse_slash(" /model sonnet "), Some(("model".into(), "sonnet".into())));
        assert_eq!(parse_slash("/compact"), Some(("compact".into(), String::new())));
        assert_eq!(parse_slash("/a:b-c.d x\ny"), Some(("a:b-c.d".into(), "x\ny".into())));
        assert_eq!(parse_slash("/Users/x"), None);
        assert_eq!(parse_slash("hello /model"), None);
        let list = builtins();
        let (c, args, text) = slash_message("/model   opus", &list).unwrap();
        assert_eq!((c.name.as_str(), args.as_str(), text.as_str()), ("model", "opus", "/model opus"));
        assert!(slash_message("/nothing", &list).is_none());
    }
}
