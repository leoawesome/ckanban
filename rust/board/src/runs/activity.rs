//! One plain line per run event for the card (`src/runs/activity.ts`): "Reading Card.tsx", "Running tests",
//! "Finished", and the final text of a run.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::js;

const ARG_KEYS: [&str; 7] = ["file_path", "command", "pattern", "url", "description", "path", "query"];
const READERS: [&str; 8] = ["cat", "sed", "head", "tail", "less", "bat", "wc", "nl"];
const SEARCHERS: [&str; 3] = ["grep", "rg", "ag"];

static TEST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:bun|npm|pnpm|yarn)(?: run)? test|npx (?:jest|vitest)|jest|vitest|pytest|go test|cargo test)(?-u:\b)").expect("test regex")
});
static SPLIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&&|\|\||;|\|").expect("split regex"));
// JS's `.` doesn't match line terminators.
static MCP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^mcp__([^\n\r\u{2028}\u{2029}]+?)__([^\n\r\u{2028}\u{2029}]+)$").expect("mcp regex"));

fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or("")
}

/// `clip(s, n)`: at most n UTF-16 units, the last one an ellipsis when cut.
pub fn clip(s: &str, n: usize) -> String {
    if js::len16(s) > n { format!("{}…", js::head16(s, n - 1)) } else { s.to_string() }
}

fn base(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    match t.rsplit('/').next() {
        Some(last) if !last.is_empty() => last,
        _ => p,
    }
}

fn short_arg(key: &str, v: &str) -> String {
    let mut s = first_line(v).to_string();
    if key == "file_path" || key == "path" {
        let parts: Vec<&str> = s.split('/').filter(|x| !x.is_empty()).collect();
        s = parts[parts.len().saturating_sub(2)..].join("/");
    }
    clip(&s, 60)
}

fn unquote(s: &str) -> String {
    // `s.replace(/^['"]|['"]$/g, "")`: one quote off each end.
    let s = s.strip_prefix(['\'', '"']).unwrap_or(s);
    s.strip_suffix(['\'', '"']).unwrap_or(s).to_string()
}

fn is_ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// First real command of a shell line: skips `cd x &&`, env assignments and leading sudo.
fn main_command(cmd: &str) -> Vec<String> {
    for part in SPLIT_RE.split(first_line(cmd)) {
        let mut words = js::words(js::trim(part));
        while let Some(w) = words.first() {
            let assign = w.find('=').is_some_and(|i| i > 0 && w[..i].chars().all(is_ascii_word));
            if assign || w == "sudo" {
                words.remove(0);
            } else {
                break;
            }
        }
        // Redirects and heredocs are not arguments.
        let redirect = |x: &String| {
            let mut c = x.chars();
            match c.next() {
                Some('<' | '>') => true,
                Some(d) if d.is_ascii_digit() => matches!(c.next(), Some('<' | '>')),
                _ => false,
            }
        };
        if let Some(end) = words.iter().position(redirect) {
            words.truncate(end);
        }
        if matches!(words.first().map(String::as_str), Some("bunx" | "npx" | "pnpx")) {
            words.remove(0);
        }
        if !words.is_empty() && words[0] != "cd" {
            return words;
        }
    }
    Vec::new()
}

fn describe_bash(cmd: &str) -> String {
    let words = main_command(cmd);
    let line = words.join(" ");
    if words.is_empty() {
        return format!("Bash: {}", clip(first_line(cmd), 60));
    }
    if TEST_RE.is_match(&line) {
        return "Running tests".into();
    }
    let w = words[0].as_str();
    let args: Vec<&String> = words[1..].iter().filter(|a| !a.starts_with('-')).collect();
    if w == "git" {
        let rest = &words[1..];
        let sub = rest.iter().enumerate().find(|(i, a)| {
            let prev = if *i == 0 { "" } else { rest[i - 1].as_str() };
            !a.starts_with('-') && prev != "-C" && prev != "-c"
        });
        return match sub {
            Some((_, s)) => format!("Git: {}", clip(s, 30)),
            None => "Running git".into(),
        };
    }
    if READERS.contains(&w) {
        // sed's first plain argument is its script; the file comes after it.
        let pool: &[&String] = if w == "sed" { args.get(1..).unwrap_or(&[]) } else { &args };
        let file = pool.iter().rev().find(|a| {
            a.chars().any(|c| is_ascii_word(c) || c == '.') && !a.starts_with(|c: char| c.is_ascii_digit() || c == '<' || c == '>')
        });
        let verb = if w == "sed" && words.iter().any(|a| a.starts_with("-i")) { "Editing" } else { "Reading" };
        if let Some(f) = file {
            return format!("{verb} {}", clip(base(&unquote(f)), 60));
        }
    }
    if SEARCHERS.contains(&w)
        && let Some(a) = args.first()
    {
        return format!("Searching for \"{}\"", clip(&unquote(a), 40));
    }
    format!("Running {}", clip(w.rsplit('/').next().unwrap_or(w), 30))
}

fn str_arg<'a>(input: &'a Value, k: &str) -> Option<&'a str> {
    input.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `new URL(url).host`, or None when it doesn't parse.
fn url_host(u: &str) -> Option<String> {
    let p = url::Url::parse(u).ok()?;
    let host = p.host_str().unwrap_or("").to_string();
    Some(match p.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

/// Plain-English line for a tool call ("Reading Card.tsx"); unknown tools keep the `Name: arg` form.
pub fn describe_tool(name: &str, input: &Value) -> String {
    let file = str_arg(input, "file_path").or_else(|| str_arg(input, "notebook_path")).or_else(|| str_arg(input, "path"));
    let described = match name {
        "Read" => file.map(|f| format!("Reading {}", clip(base(f), 60))),
        "Edit" | "MultiEdit" | "NotebookEdit" => file.map(|f| format!("Editing {}", clip(base(f), 60))),
        "Write" => file.map(|f| format!("Writing {}", clip(base(f), 60))),
        "Grep" => str_arg(input, "pattern").map(|p| format!("Searching for \"{}\"", clip(p, 40))),
        "Glob" => str_arg(input, "pattern").map(|p| format!("Finding {}", clip(p, 60))),
        "Bash" => str_arg(input, "command").map(describe_bash),
        "WebSearch" => Some("Searching the web".into()),
        "WebFetch" => str_arg(input, "url").and_then(url_host).map(|h| format!("Reading {h}")),
        "Task" | "Agent" => str_arg(input, "description").map(|d| format!("Delegating: {}", clip(d, 60))),
        "TodoWrite" => Some("Updating the plan".into()),
        _ => None,
    };
    if let Some(d) = described {
        return d;
    }
    if let Some(c) = MCP_RE.captures(name) {
        return format!("{}: {}", c[1].replace('_', " "), c[2].replace('_', " "));
    }
    raw_tool(name, input)
}

fn raw_tool(name: &str, input: &Value) -> String {
    match ARG_KEYS.iter().find_map(|k| input.get(*k).and_then(Value::as_str).map(|v| (*k, v))) {
        Some((k, v)) => format!("{name}: {}", short_arg(k, v)),
        None => name.to_string(),
    }
}

fn blocks(ev: &Value) -> &[Value] {
    ev.pointer("/message/content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn ty(v: &Value) -> Option<&str> {
    v.get("type").and_then(Value::as_str)
}

/// `summarizeEvent`: one line for the card; `raw` keeps the exact tool call (`Bash: sed -n …`) for logs.
pub fn summarize_event(ev: &Value, raw: bool) -> Option<String> {
    if !ev.is_object() {
        return None;
    }
    if ty(ev) == Some("result") {
        return Some("Finished".into());
    }
    // Claude Code retries a failing API connection for minutes; say so instead of looking frozen.
    if ty(ev) == Some("system") && ev.get("subtype").and_then(Value::as_str) == Some("api_retry") && js::number(ev.get("attempt")) >= 2.0 {
        let max = match ev.get("max_retries") {
            None | Some(Value::Null) => "?".to_string(),
            Some(v) => js::to_string(v),
        };
        return Some(format!("Can't reach Claude's API, retrying ({}/{max})…", js::to_string(&ev["attempt"])));
    }
    if ty(ev) != Some("assistant") {
        return None;
    }
    let bs = blocks(ev);
    if let Some(tool) = bs.iter().rev().find(|b| ty(b) == Some("tool_use")) {
        let name = tool.get("name").map(js::to_string).unwrap_or_else(|| "undefined".into());
        let input = match tool.get("input") {
            None | Some(Value::Null) => Value::Object(Default::default()),
            Some(v) => v.clone(),
        };
        return Some(if raw { raw_tool(&name, &input) } else { describe_tool(&name, &input) });
    }
    let text = bs.iter().rev().find_map(|b| {
        let t = b.get("text").and_then(Value::as_str)?;
        (ty(b) == Some("text") && !js::trim(t).is_empty()).then_some(t)
    })?;
    Some(js::head16(&js::squash_ws(js::trim(text)), 80).to_string())
}

/// `extractFinalText`: the result's text, else the last assistant text.
pub fn extract_final_text(events: &[Value]) -> String {
    if let Some(r) = events.iter().rev().find_map(|e| (ty(e) == Some("result")).then(|| e.get("result").and_then(Value::as_str)).flatten()) {
        return r.to_string();
    }
    for e in events.iter().rev() {
        if ty(e) != Some("assistant") {
            continue;
        }
        if let Some(t) = blocks(e).iter().rev().find(|b| ty(b) == Some("text") && js::truthy(b.get("text"))) {
            return js::to_string(&t["text"]);
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain_lines() {
        assert_eq!(describe_tool("Read", &json!({"file_path": "/a/b/Card.tsx"})), "Reading Card.tsx");
        assert_eq!(describe_tool("Bash", &json!({"command": "cd x && FOO=1 bun run test a"})), "Running tests");
        assert_eq!(describe_tool("Bash", &json!({"command": "git -C /x status"})), "Git: status");
        assert_eq!(describe_tool("Bash", &json!({"command": "sed -n 1,20p 'src/app.ts'"})), "Reading app.ts");
        assert_eq!(describe_tool("WebFetch", &json!({"url": "https://Example.com:8080/x"})), "Reading example.com:8080");
        assert_eq!(describe_tool("mcp__ckanban__move_ticket", &json!({})), "ckanban: move ticket");
    }
}
