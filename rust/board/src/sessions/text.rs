//! Small text readers the transcript parser needs, ported from Bun: slash command tags and local command output
//! (`src/chat/commands.ts`), the attachment note (`src/board/attachments.ts`), the setup block
//! (`src/runs/worktree-setup.ts`), the run's result line (`src/runs/result.ts`), ⭐ titles (`src/core/util.ts`) and
//! mockup blocks (`src/board/mockups.ts`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::{Obj, js};

/// The characters of JS's `\s`, for use inside a regex character class (`[{WS}]`, `[^{WS}]`).
pub const WS: &str = r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// A regex with `\s` / `\S` / `\w` written as JS reads them (no `u` flag): `\s` and `\S` become [`WS`] classes and
/// `\w` the ASCII word class.
pub fn js_re(src: &str) -> Regex {
    let s = src
        .replace(r"\s", &format!("[{WS}]"))
        .replace(r"\S", &format!("[^{WS}]"))
        .replace(r"\w", "[A-Za-z0-9_]");
    Regex::new(&s).expect("valid regex")
}

/// Claude Code built-ins that only make sense in its terminal UI: the ticket chat doesn't show them.
pub const TERMINAL_COMMANDS: &[&str] = &[
    "add-dir", "agents", "auto-mode-setup", "autocompact", "bashes", "bug", "clear", "color", "config", "cost", "doctor",
    "effort", "exit", "export", "fast", "feedback", "focus", "heapdump", "help", "hooks", "ide", "import", "init", "insights",
    "install-github-app", "keybindings", "login", "logout", "mcp", "memory", "migrate-installer", "output-style", "permissions",
    "plugin", "plugins", "privacy-settings", "quit", "recap", "release-notes", "reload-plugins", "reload-skills", "rename",
    "resume", "rewind", "sandbox", "status", "statusline", "tasks", "terminal-setup", "theme", "todos", "upgrade", "usage",
    "usage-credits", "extra-usage", "vim",
];

static COMMAND_NAME: LazyLock<Regex> = LazyLock::new(|| js_re(r"<command-name>\s*/?([^<\s]+)\s*</command-name>"));
static COMMAND_ARGS: LazyLock<Regex> = LazyLock::new(|| js_re(r"<command-args>((?s:.)*?)</command-args>"));

/// A slash command as Claude Code stores it (`<command-name>/x</command-name><command-args>a b</command-args>`):
/// `/x a b`, or None for any other text.
pub fn command_text(text: &str) -> Option<String> {
    let name = COMMAND_NAME.captures(text)?.get(1)?.as_str();
    if !js::trim_start(text).starts_with("<command-") {
        return None;
    }
    let args = COMMAND_ARGS.captures(text).and_then(|c| c.get(1)).map(|m| js::trim(m.as_str())).unwrap_or("");
    Some(if args.is_empty() { format!("/{name}") } else { format!("/{name} {args}") })
}

static LOCAL_OUT: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    ["stdout", "stderr"].map(|k| js_re(&format!(r"^\s*<local-command-{k}>((?s:.)*?)</local-command-{k}>\s*$")))
});
static ANSI_COLOUR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").expect("valid regex"));

/// Output of a local command (/compact, /context) as Claude Code stores it, without the tags and colour codes.
pub fn local_command_output(text: &str) -> Option<String> {
    // JS uses a backreference (`</local-command-\1>`); one regex per tag name matches the same texts.
    let m = LOCAL_OUT.iter().find_map(|re| re.captures(text))?;
    Some(js::trim(&ANSI_COLOUR.replace_all(m.get(1)?.as_str(), "")).to_string())
}

pub const IMAGES_NOTE: &str = "Images in this message are local files; open them with the Read tool to see them.";
pub const FILES_NOTE: &str = "Files attached to this message are local files. Open images, PDFs and text files with the Read tool. \
For Word, Excel or PowerPoint files, convert them to text yourself with what this computer already has \
(for example unzip the file and read its XML, textutil on macOS, python or pandoc); don't ask the user to install anything. \
If you can't read a file, tell the user which one.";

/// `text` without the note the board adds after a message with attachments: chats show what the user typed.
pub fn without_attachment_note(text: &str) -> &str {
    match [IMAGES_NOTE, FILES_NOTE].into_iter().find(|n| text.ends_with(n)) {
        Some(n) => js::trim_end(&text[..text.len() - n.len()]),
        None => text,
    }
}

static SETUP_BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<ckanban-setup>((?s:.)*?)</ckanban-setup>").expect("valid regex"));

/// The setup result in a `<ckanban-setup>` block (what the chat's setup row is drawn from), or None.
pub fn parse_setup_block(text: &str) -> Option<Value> {
    let m = SETUP_BLOCK.captures(text)?;
    let v: Value = serde_json::from_str(m.get(1)?.as_str()).ok()?;
    let o = v.as_object()?;
    let command = o.get("command")?.as_str()?;
    let strings = |k: &str| match o.get(k) {
        Some(Value::Array(a)) => Value::Array(a.iter().map(|x| Value::String(js::string(x))).collect()),
        _ => json!([]),
    };
    let number = |k: &str, or: Value| match o.get(k) {
        Some(Value::Number(n)) => n.as_f64().map(js::num).unwrap_or(or),
        _ => or,
    };
    let mut out = Obj::new();
    out.insert("copied".into(), strings("copied"));
    out.insert("missing".into(), strings("missing"));
    out.insert("command".into(), command.into());
    out.insert("ok".into(), o.get("ok").filter(|v| v.is_boolean()).cloned().unwrap_or(Value::Null));
    out.insert("exitCode".into(), number("exitCode", Value::Null));
    out.insert("timedOut".into(), js::truthy(o.get("timedOut")).into());
    out.insert("output".into(), o.get("output").and_then(Value::as_str).unwrap_or("").into());
    out.insert("durationMs".into(), number("durationMs", json!(0)));
    Some(Value::Object(out))
}

const RESULT_PREFIX: &str = "CKANBAN_RESULT:";

/// The run's last `CKANBAN_RESULT:` line as `{status, prUrl, prUrls, summary, quiet?, verdict?}`, or None.
pub fn parse_result(text: &str) -> Option<Value> {
    let line = text.split('\n').rfind(|l| l.contains(RESULT_PREFIX))?;
    let rest = js::trim(&line[line.find(RESULT_PREFIX)? + RESULT_PREFIX.len()..]);
    let v: Value = serde_json::from_str(js::trim(rest.trim_end_matches('`'))).ok()?;
    let o = v.as_object()?;
    let status = o.get("status")?.as_str().filter(|s| matches!(*s, "done" | "blocked" | "questions"))?;
    let url = |u: Option<&Value>| u.and_then(Value::as_str).filter(|s| s.starts_with("https://")).map(str::to_string);
    let mut pr_urls: Vec<String> = Vec::new();
    let listed = o.get("prUrls").and_then(Value::as_array).map(|a| a.iter().filter_map(|u| url(Some(u))).collect()).unwrap_or_else(Vec::new);
    for u in listed.into_iter().chain(url(o.get("prUrl"))) {
        if !pr_urls.contains(&u) {
            pr_urls.push(u);
        }
    }
    let pr_url = url(o.get("prUrl")).or_else(|| pr_urls.last().cloned());
    let mut out = Obj::new();
    out.insert("status".into(), status.into());
    out.insert("prUrl".into(), pr_url.map(Value::String).unwrap_or(Value::Null));
    out.insert("prUrls".into(), pr_urls.into());
    out.insert("summary".into(), o.get("summary").and_then(Value::as_str).unwrap_or("").into());
    if o.get("quiet") == Some(&Value::Bool(true)) && status == "done" {
        out.insert("quiet".into(), true.into());
    }
    if let Some(v) = o.get("verdict").and_then(Value::as_str).filter(|v| matches!(*v, "passed" | "problem")) {
        out.insert("verdict".into(), v.into());
    }
    Some(Value::Object(out))
}

static STAR: LazyLock<Regex> = LazyLock::new(|| js_re("^\\s*(?:\u{2B50}\u{FE0F}?\\s*)+"));

/// A ⭐ typed at the start of a title marks the ticket ⭐ Important; the title keeps the rest. `(title, important)`.
pub fn starred_title(title: &str) -> (&str, bool) {
    match STAR.find(title) {
        Some(m) => (&title[m.end()..], true),
        None => (title, false),
    }
}

static MOCKUP_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_.\-]{0,80}\.[hH][tT][mM][lL]?$").expect("valid regex"));

/// A safe file name for a mockup ("a-compact.html"), or None.
pub fn mockup_name(name: &str) -> Option<&str> {
    let n = js::trim(name);
    (MOCKUP_NAME.is_match(n) && !n.contains("..")).then_some(n)
}

static MOCKUP_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| js_re(r#"<ckanban-mockup\s+name="([^"]*)"\s*>((?s:.)*?)</ckanban-mockup>"#));
static MOCKUP_OPEN: LazyLock<Regex> = LazyLock::new(|| js_re(r#"<ckanban-mockup\s+name="[^"]*"\s*>\s*(?:<|```|$)"#));
static FENCE_OPEN: LazyLock<Regex> = LazyLock::new(|| js_re(r"^```(?:html)?\s*\n"));
static FENCE_CLOSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n?```$").expect("valid regex"));

/// `extractMockups`: the mockup blocks in a reply as (name, html), valid names only, a ``` fence dropped.
pub fn extract_mockups(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for c in MOCKUP_BLOCK.captures_iter(text) {
        let html = js::trim(&c[2]).to_string();
        let html = FENCE_OPEN.replace(&html, "").into_owned();
        let html = js::trim(&FENCE_CLOSE.replace(&html, "")).to_string();
        if let Some(name) = mockup_name(&c[1])
            && !html.is_empty()
        {
            out.push((name.to_string(), html));
        }
    }
    out
}

/// The names of the mockup blocks in a reply that carry HTML (valid names only).
fn mockup_names(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in MOCKUP_BLOCK.captures_iter(text) {
        let html = js::trim(&c[2]).to_string();
        let html = FENCE_OPEN.replace(&html, "").into_owned();
        let html = FENCE_CLOSE.replace(&html, "").into_owned();
        if let Some(name) = mockup_name(&c[1])
            && !js::trim(&html).is_empty()
        {
            out.push(name.to_string());
        }
    }
    out
}

/// The reply without its mockup blocks (and without an unfinished one at the end), plus the mockups' names.
pub fn strip_mockups(text: &str) -> (String, Vec<String>) {
    let names = mockup_names(text);
    let mut out = MOCKUP_BLOCK.replace_all(text, "").into_owned();
    if let Some(open) = MOCKUP_OPEN.find_iter(&out).last().map(|m| m.start())
        && !out[open + 1..].contains("<ckanban-")
    {
        out.truncate(open);
    }
    (out, names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_bun() {
        assert_eq!(command_text("<command-message>x</command-message><command-name>/x</command-name><command-args> a b </command-args>").as_deref(), Some("/x a b"));
        assert_eq!(local_command_output(" <local-command-stdout>\x1b[1mhi\x1b[0m</local-command-stdout>\n").as_deref(), Some("hi"));
        assert_eq!(local_command_output("<local-command-stdout>x</local-command-stderr>"), None);
        assert_eq!(starred_title("⭐️ ⭐ Fix"), ("Fix", true));
        assert_eq!(mockup_name(" a.HTM "), Some("a.HTM"));
    }
}
