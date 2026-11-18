//! `ckanban profiles`, `ckanban ticket ...` and `ckanban call` (`src/cli/ticket-cli.ts`, `callCommand` in
//! `src/cli/cli.ts`): HTTP calls to the daemon and the texts they print. Every error is returned as the one line the
//! command prints on stderr (exit 1).

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::args::{self, Parsed, js_number, js_str, pretty};
use super::http::{Client, enc, form};
use super::text;
use super::{TICKET_USAGE, out};

const RUN_ENV: &str = "CKANBAN_TICKET";
const STATUSES: [&str; 6] = ["backlog", "planning", "ready", "in_progress", "review", "done"];
/// Comments `ticket show` prints at a time (`COMMENTS_PAGE`).
const COMMENTS_PAGE: u32 = 50;
const TAG_MAX_LEN: usize = 24;
const TAGS_MAX: usize = 10;

type R<T> = Result<T, String>;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `runProfile`: the board part of CKANBAN_TICKET.
fn run_profile() -> Option<String> {
    env(RUN_ENV).and_then(|v| v.split('/').next().map(str::to_string)).filter(|s| !s.is_empty())
}

fn assert_can_change() -> R<()> {
    match env(RUN_ENV).filter(|v| !v.is_empty()) {
        Some(v) => Err(format!(
            "changing the board is disabled inside a board run ({RUN_ENV}={v}), so runs can't create or start other runs. Reading tickets still works; ask the user to make this change on the board."
        )),
        None => Ok(()),
    }
}

fn need<'a>(v: Option<&'a str>, usage: &str) -> R<&'a str> {
    v.filter(|s| !s.is_empty()).ok_or_else(|| format!("usage: ckanban {usage}"))
}

fn parse_status(s: &str) -> R<String> {
    let mut v = String::new();
    let mut gap = false;
    for c in s.trim().to_lowercase().chars() {
        if c.is_whitespace() || c == '-' {
            gap = true;
            continue;
        }
        if gap {
            v.push('_');
            gap = false;
        }
        v.push(c);
    }
    if gap {
        v.push('_');
    }
    if STATUSES.contains(&v.as_str()) {
        Ok(v)
    } else {
        Err(format!("invalid status \"{s}\"; use one of: {}", STATUSES.join(", ")))
    }
}

fn parse_mode(s: &str) -> R<String> {
    let v = s.trim().to_lowercase();
    if v == "interview" || v == "auto" { Ok(v) } else { Err(format!("invalid mode \"{s}\"; use interview or auto")) }
}

/// `normalizeTag` in `src/board/tags.ts`.
fn normalize_tag(v: &str) -> String {
    let t = v.trim().trim_start_matches('#').trim().to_lowercase();
    let mut dashed = String::new();
    let mut gap = false;
    for c in t.chars() {
        if c.is_whitespace() {
            gap = true;
            continue;
        }
        if gap {
            dashed.push('-');
            gap = false;
        }
        dashed.push(c);
    }
    // .slice(0, 24) counts UTF-16 units.
    let mut cut = String::new();
    let mut units = 0;
    for c in dashed.chars() {
        units += c.len_utf16();
        if units > TAG_MAX_LEN {
            break;
        }
        cut.push(c);
    }
    cut.trim_end_matches('-').to_string()
}

fn normalize_tags(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in raw.split(',').map(normalize_tag) {
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(TAGS_MAX);
    out
}

fn needs_flag(p: &Parsed) -> Option<Vec<String>> {
    p.str("needs").map(|v| v.split(',').map(|x| x.trim().to_lowercase()).filter(|x| !x.is_empty()).collect())
}

fn tags_flag(p: &Parsed) -> Option<Vec<String>> {
    p.str("tags").map(normalize_tags)
}

fn read_stdin() -> R<String> {
    let mut b = Vec::new();
    std::io::stdin().read_to_end(&mut b).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&b).into_owned())
}

/// --body / --body-file (either may be "-" for stdin).
fn body_from(p: &Parsed) -> R<Option<String>> {
    match (p.str("body"), p.str("body-file")) {
        (Some(_), Some(_)) => Err("use --body or --body-file, not both".into()),
        (Some("-"), None) | (None, Some("-")) => read_stdin().map(Some),
        (Some(b), None) => Ok(Some(b.to_string())),
        (None, Some(f)) => std::fs::read(f)
            .map(|b| Some(String::from_utf8_lossy(&b).into_owned()))
            .map_err(|e| format!("ENOENT: {}, open '{f}'", e.to_string().split(" (os error").next().unwrap_or_default().to_lowercase())),
        (None, None) => Ok(None),
    }
}

// --- picking the board ------------------------------------------------------------------------------------------

fn real(p: &Path, cwd: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| normalize(&cwd.join(p)))
}

/// `path.resolve` without the file system: drops `.` and folds `..`.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(x) => out.push(x),
            _ => {}
        }
    }
    out
}

fn contains(parent: &str, child: &str) -> bool {
    child == parent || child.starts_with(&if parent.ends_with('/') { parent.to_string() } else { format!("{parent}/") })
}

fn deepest<'a>(profiles: &'a [Value], dir: &str, cwd: &Path) -> Option<&'a Value> {
    let mut best = None;
    let mut best_len: i64 = -1;
    for p in profiles {
        let path = real(Path::new(p.get("path").and_then(Value::as_str).unwrap_or("")), cwd).to_string_lossy().into_owned();
        // String length in UTF-16 units, as JS compares them.
        let len = path.encode_utf16().count() as i64;
        if contains(&path, dir) && len > best_len {
            best = Some(p);
            best_len = len;
        }
    }
    best
}

/// The main checkout of the git worktree `dir` is in (`mainCheckout` in `src/cli/client.ts`).
fn main_checkout(dir: &Path) -> Option<String> {
    let r = std::process::Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !r.status.success() {
        return None;
    }
    let common = String::from_utf8_lossy(&r.stdout).trim().to_string();
    if common.is_empty() || !common.starts_with('/') {
        return None;
    }
    let parent = Path::new(&common).parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/"));
    Some(real(&parent, dir).to_string_lossy().into_owned())
}

fn resolve_profile(profiles: &[Value], explicit: Option<String>) -> R<String> {
    let slug_of = |p: &Value| js_str(p.get("slug"));
    if let Some(want) = explicit.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        let hit = profiles.iter().find(|x| x.get("slug").and_then(Value::as_str) == Some(want)).or_else(|| {
            let w = want.to_lowercase();
            profiles.iter().find(|x| x.get("name").and_then(Value::as_str).map(str::to_lowercase).as_deref() == Some(w.as_str()))
        });
        return hit.map(slug_of).ok_or_else(|| format!("no profile \"{want}\". {}", text::profile_list(profiles)));
    }
    let here = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let cwd = real(&here, &here).to_string_lossy().into_owned();
    if let Some(p) = deepest(profiles, &cwd, &here) {
        return Ok(slug_of(p));
    }
    if let Some(main) = main_checkout(Path::new(&cwd)).filter(|m| *m != cwd) {
        if let Some(p) = deepest(profiles, &main, &here) {
            return Ok(slug_of(p));
        }
    }
    Err(format!("no profile matches {cwd}; pass a profile. {}", text::profile_list(profiles)))
}

fn list_profiles(c: &Client) -> R<Vec<Value>> {
    Ok(match c.req("GET", "/api/profiles", None, &[], false)? {
        Value::Array(a) => a,
        _ => Vec::new(),
    })
}

fn board(c: &Client, p: &Parsed, explicit: Option<String>) -> R<String> {
    let explicit = explicit.or_else(|| p.str("profile").map(str::to_string)).or_else(run_profile);
    resolve_profile(&list_profiles(c)?, explicit)
}

fn t(slug: &str, id: Option<&str>) -> String {
    let base = format!("/api/profiles/{}/tickets", enc(slug));
    match id {
        Some(id) => format!("{base}/{}", enc(id)),
        None => base,
    }
}

fn run_header() -> Vec<(&'static str, String)> {
    env(RUN_ENV).filter(|v| !v.is_empty()).map(|v| vec![("x-ckanban-run", v)]).unwrap_or_default()
}

// --- commands ---------------------------------------------------------------------------------------------------

pub fn profiles(argv: &[String], c: &Client) -> R<()> {
    let p = args::parse(argv)?;
    let ps = list_profiles(c)?;
    out(&if p.on("json") { pretty(&Value::Array(ps)) } else { text::profile_list(&ps) });
    Ok(())
}

pub fn ticket(argv: &[String], c: &Client) -> R<()> {
    let p = args::parse(argv)?;
    let action = p.pos(0).unwrap_or("");
    let id = p.pos(1);
    let rest: Vec<&str> = p.positional.iter().skip(2).map(String::as_str).collect();
    let json = p.on("json");
    let print = |data: &Value, text: String| out(&if json { pretty(data) } else { text });
    const KNOWN: [&str; 13] = ["list", "show", "create", "update", "move", "chat", "comment", "stop", "delete", "report-bug", "setup", "take-device", "release-device"];
    if !KNOWN.contains(&action) {
        return Err(format!("usage:\n{TICKET_USAGE}"));
    }
    match action {
        "report-bug" => return report_bug(&p, id, c),
        "setup" => return setup(&p, id, c),
        "take-device" | "release-device" => {
            let names: Vec<String> = p.positional.iter().skip(1).filter(|s| !s.is_empty()).cloned().collect();
            return devices(action, &p, names, c);
        }
        "list" | "show" => {}
        _ => assert_can_change()?,
    }
    let slug = board(c, &p, None)?;

    match action {
        "list" => {
            // Tool tickets have no card: listed only with --include-tool. The board filters and pages.
            let status_raw = p.str("status");
            let status = match status_raw.filter(|s| !s.is_empty()) {
                Some(s) => Some(parse_status(s)?),
                None => None,
            };
            let tool = p.on("include-tool");
            let query = p.str("query");
            let limit = js_number(p.str("limit").unwrap_or("0"));
            let limit = (limit > 0.0).then(|| limit.floor());
            let after = p.str("after");
            let mut qs = vec!["scope=list".to_string()];
            if let Some(s) = &status {
                qs.push(format!("status={}", form(s)));
            }
            if tool {
                qs.push("tool=1".into());
            }
            if let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) {
                qs.push(format!("q={}", form(q)));
            }
            let limit_s = limit.map(ckanban_core::jsnum::js_string);
            if let Some(l) = &limit_s {
                qs.push(format!("limit={}", form(l)));
            }
            if let Some(a) = after.filter(|a| !a.is_empty()) {
                qs.push(format!("after={}", form(a)));
            }
            let page = c.req("GET", &format!("{}?{}", t(&slug, None), qs.join("&")), None, &[], false)?;
            let again = [
                status_raw.filter(|s| !s.is_empty()).map(|s| format!("--status {s}")),
                query.filter(|q| !q.is_empty()).map(|q| format!("--query {}", serde_json::to_string(q).unwrap_or_default())),
                limit_s.map(|l| format!("--limit {l}")),
                tool.then(|| "--include-tool".to_string()),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
            let q = text::ListQuery { status: status.as_deref(), query, after };
            let more = |a: &str| format!("ckanban ticket list {}--after {a}", if again.is_empty() { String::new() } else { format!("{again} ") });
            print(&page, text::ticket_list_text(&slug, &page, &q, more, "use --status done, or --query"));
        }
        "show" => {
            let tid = need(id, "ticket show <id>")?;
            let raw = p.str("comments-before");
            let before = raw.map(js_number).filter(|n| *n >= 0.0).map(f64::floor);
            let tk = c.req("GET", &t(&slug, Some(tid)), None, &[], false)?;
            let before_q = before.map(|b| format!("&before={}", ckanban_core::jsnum::js_string(b))).unwrap_or_default();
            let cp = c.req("GET", &format!("{}/comments?last={COMMENTS_PAGE}{before_q}", t(&slug, Some(tid))), None, &[], false)?;
            let comments = cp.get("comments").cloned().unwrap_or(Value::Null);
            let earlier = cp.get("earlier").cloned().unwrap_or(Value::Null);
            let mut data = match &tk {
                Value::Object(m) => m.clone(),
                _ => Map::new(),
            };
            data.insert("comments".into(), comments.clone());
            data.insert("earlierComments".into(), earlier.clone());
            let list = comments.as_array().map(Vec::as_slice).unwrap_or(&[]);
            let n = earlier.as_f64().unwrap_or(0.0);
            let how = format!("ckanban ticket show {tid} --comments-before {}", js_str(Some(&earlier)));
            print(&Value::Object(data), text::ticket_text(&tk, list, n, &how));
        }
        "create" => {
            // `ticket create "Title"` works too.
            let words: Vec<&str> = p.positional.iter().skip(1).map(String::as_str).filter(|s| !s.is_empty()).collect();
            let title = p.str("title").map(str::to_string).unwrap_or_else(|| words.join(" ")).trim().to_string();
            if title.is_empty() {
                return Err("usage: ckanban ticket create --title <t> [--body <md>]".into());
            }
            let body = body_from(&p)?.unwrap_or_default();
            let status = match p.str("status").filter(|s| !s.is_empty()) {
                Some(s) => parse_status(s)?,
                None => "backlog".into(),
            };
            let mode = match p.str("mode").filter(|s| !s.is_empty()) {
                Some(m) => parse_mode(m)?,
                None => "interview".into(),
            };
            let mut input = Map::new();
            input.insert("title".into(), json!(title));
            input.insert("body".into(), json!(body));
            input.insert("status".into(), json!(status));
            input.insert("mode".into(), json!(mode));
            if let Some(n) = needs_flag(&p).filter(|n| !n.is_empty()) {
                input.insert("needs".into(), json!(n));
            }
            if let Some(g) = tags_flag(&p).filter(|g| !g.is_empty()) {
                input.insert("tags".into(), json!(g));
            }
            let tk = c.req("POST", &t(&slug, None), Some(&Value::Object(input)), &[], false)?;
            let f = |k: &str| js_str(tk.get(k));
            print(&tk, format!("Created {} on {slug} in {} ({} mode): {}", f("id"), f("status"), f("mode"), f("title")));
        }
        "update" | "move" => {
            let tid = need(id, if action == "move" { "ticket move <id> <status>" } else { "ticket update <id> [--title ...]" })?;
            let mut patch = Map::new();
            if action == "move" {
                let s = need(rest.first().copied().or(p.str("status")), "ticket move <id> <status>")?;
                patch.insert("status".into(), json!(parse_status(s)?));
            } else {
                if let Some(title) = p.str("title").map(str::trim).filter(|x| !x.is_empty()) {
                    patch.insert("title".into(), json!(title));
                }
                if let Some(body) = body_from(&p)? {
                    patch.insert("body".into(), json!(body));
                }
                if let Some(s) = p.str("status").filter(|s| !s.is_empty()) {
                    patch.insert("status".into(), json!(parse_status(s)?));
                }
                if let Some(m) = p.str("mode").filter(|s| !s.is_empty()) {
                    patch.insert("mode".into(), json!(parse_mode(m)?));
                }
                if let Some(n) = needs_flag(&p) {
                    patch.insert("needs".into(), json!(n));
                }
                if let Some(g) = tags_flag(&p) {
                    patch.insert("tags".into(), json!(g));
                }
                // A task's card on or off the board; false also hides a card gathered into a feature.
                if let Some(show) = p.str("show-on-board") {
                    if show != "true" && show != "false" {
                        return Err("--show-on-board must be true or false".into());
                    }
                    patch.insert("showOnBoard".into(), json!(show == "true"));
                }
                if patch.is_empty() {
                    return Err("nothing to change: pass --title, --body, --status, --mode, --needs, --tags or --show-on-board".into());
                }
            }
            let tk = c.req("PATCH", &t(&slug, Some(tid)), Some(&Value::Object(patch)), &[], false)?;
            print(&tk, format!("Updated {}", text::ticket_line(&tk)));
        }
        "chat" => {
            let tid = need(id, "ticket chat <id> <message>")?;
            let joined = rest.join(" ").trim().to_string();
            let msg = need(if joined.is_empty() { p.str("message") } else { Some(joined.as_str()) }, "ticket chat <id> <message>")?;
            let tk = c.req("POST", &format!("{}/chat", t(&slug, Some(tid))), Some(&json!({ "text": msg })), &[], false)?;
            let working = if args::truthy(tk.get("running")) { "; Claude is working on it." } else { "." };
            print(&tk, format!("Sent to {}{working}", js_str(tk.get("id"))));
        }
        "comment" => {
            let tid = need(id, "ticket comment <id> <text>")?;
            let joined = rest.join(" ").trim().to_string();
            let msg = need(if joined.is_empty() { p.str("text") } else { Some(joined.as_str()) }, "ticket comment <id> <text>")?;
            let cm = c.req("POST", &format!("{}/comments", t(&slug, Some(tid))), Some(&json!({ "text": msg })), &[], false)?;
            print(&cm, format!("Commented on {tid}."));
        }
        "stop" => {
            let tid = need(id, "ticket stop <id>")?;
            let r = c.req("POST", &format!("{}/stop", t(&slug, Some(tid))), Some(&json!({})), &[], false)?;
            print(&r, if args::truthy(r.get("stopped")) { format!("Stopped the run on {tid}.") } else { format!("{tid} had no run to stop.") });
        }
        "delete" => {
            let tid = need(id, "ticket delete <id>")?;
            c.req("DELETE", &t(&slug, Some(tid)), None, &[], false)?;
            print(&json!({ "deleted": tid }), format!("Deleted {tid}."));
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn devices(action: &str, p: &Parsed, names: Vec<String>, c: &Client) -> R<()> {
    let run = env(RUN_ENV).unwrap_or_default();
    let mut parts = run.split('/');
    let (slug, tid) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if run.is_empty() || slug.is_empty() || tid.is_empty() {
        return Err(format!("ckanban ticket {action} works inside a board run, for its own ticket"));
    }
    let path = format!("{}/devices", t(slug, Some(tid)));
    let hdr = run_header();
    if action == "take-device" {
        if names.is_empty() {
            need(None, "ticket take-device <name> [<name>...]")?;
        }
        let r = c.req("POST", &path, Some(&json!({ "action": "take", "names": names })), &hdr, true)?;
        out(&if p.on("json") { pretty(&r) } else { text::device_take_text(&r) });
        return Ok(());
    }
    let r = c.req("POST", &path, Some(&json!({ "action": "release", "names": names })), &hdr, false)?;
    let released = r.get("released").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    out(&if p.on("json") {
        pretty(&r)
    } else if released.is_empty() {
        "Nothing to let go of.".into()
    } else {
        format!("Let go of {}.", released.iter().map(|x| js_str(Some(x))).collect::<Vec<_>>().join(", "))
    });
    Ok(())
}

/// How often `ticket setup` says it is still waiting (`CKANBAN_SETUP_TICK_MS` in tests).
fn setup_tick() -> std::time::Duration {
    let ms = std::env::var("CKANBAN_SETUP_TICK_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|&ms| ms > 0).unwrap_or(30_000);
    std::time::Duration::from_millis(ms)
}

/// The setup request, with a first line at once (starting, or joining one already running and since when) and a
/// line every `setup_tick` while it runs, so a long install never looks stuck.
fn setup_with_progress(c: &Client, path: &str) -> R<Value> {
    use std::time::{Duration, Instant};
    let status = c.req_within("GET", path, None, &[], Some(Duration::from_secs(2)));
    let began = Instant::now();
    let before = match &status {
        Ok(s) if args::truthy(s.get("running")) => {
            let ms = s.get("runningMs").and_then(Value::as_u64).unwrap_or(0);
            out(&format!("Joining the setup already running for this ticket (started {} ago)…", text::elapsed_text(ms)));
            ms
        }
        Ok(s) if args::truthy(s.get("needed")) => {
            out("Starting the project setup (installing its dependencies)…");
            0
        }
        // Nothing to run: the answer comes at once.
        Ok(_) => 0,
        // An older board without the status route, or one too busy to answer quickly.
        Err(_) => {
            out("Running the project setup…");
            0
        }
    };
    let (tx, rx) = std::sync::mpsc::channel();
    let (port, path2, hdr) = (c.port, path.to_string(), run_header());
    std::thread::spawn(move || {
        let _ = tx.send(Client { port }.req("POST", &path2, Some(&json!({})), &hdr, true));
    });
    let tick = setup_tick();
    loop {
        match rx.recv_timeout(tick) {
            Ok(r) => return r,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let ms = before + began.elapsed().as_millis() as u64;
                out(&format!("Still running the setup ({} so far)…", text::elapsed_text(ms)));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(super::http::DAEMON_DOWN.into()),
        }
    }
}

fn setup(p: &Parsed, target: Option<&str>, c: &Client) -> R<()> {
    let target = need(target, "ticket setup [<board>/]<id>")?;
    let (explicit, tid) = match target.find('/') {
        Some(cut) => (Some(target[..cut].to_string()), &target[cut + 1..]),
        None => (None, target),
    };
    let slug = board(c, p, explicit)?;
    let tid = need(Some(tid), "ticket setup [<board>/]<id>")?;
    let path = format!("{}/setup", t(&slug, Some(tid)));
    let r = if p.on("json") { c.req("POST", &path, Some(&json!({})), &run_header(), true)? } else { setup_with_progress(c, &path)? };
    out(&if p.on("json") { pretty(&r) } else { text::setup_text(&r) });
    if r.get("status").and_then(Value::as_str) == Some("ran") {
        let x = r.get("result").cloned().unwrap_or(Value::Null);
        if !args::truthy(x.get("ok")) {
            return Err(if args::truthy(x.get("timedOut")) { "Setup timed out.".into() } else { format!("Setup failed (exit {}).", text::exit_of(&x)) });
        }
    }
    Ok(())
}

fn report_bug(p: &Parsed, id: Option<&str>, c: &Client) -> R<()> {
    let usage = "ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]";
    let title = need(p.str("title").map(str::trim), usage)?.to_string();
    // An empty id needs no board but is still sent, as Bun does.
    let slug = match id.filter(|i| !i.is_empty()) {
        Some(_) => Some(board(c, p, None)?),
        None => None,
    };
    let mut input = Map::new();
    input.insert("title".into(), json!(title));
    input.insert("description".into(), json!(body_from(p)?.unwrap_or_default()));
    if let Some(s) = slug {
        input.insert("profile".into(), json!(s));
    }
    if let Some(i) = id {
        input.insert("ticketId".into(), json!(i));
    }
    let include: &[&str] = if p.on("no-logs") { &["env", "ticket"] } else { &["env", "ticket", "log"] };
    input.insert("include".into(), json!(include));
    input.insert("source".into(), json!(if run_profile().is_some() { "ai" } else { "cli" }));
    let r = c.req("POST", "/api/bug-report", Some(&Value::Object(input)), &[], false)?;
    out(&if p.on("json") { pretty(&r) } else { text::bug_report_text(&r) });
    Ok(())
}

/// `ckanban call <service> <tool> [json]` inside an automation's check script.
pub fn call(argv: &[String], c: &Client) -> R<()> {
    let service = argv.first().map(String::as_str).unwrap_or("");
    let tool = argv.get(1).map(String::as_str).unwrap_or("");
    let raw = argv.get(2).map(String::as_str).unwrap_or("{}");
    if service.is_empty() || tool.is_empty() {
        return Err("usage: ckanban call <service> <tool> ['<json arguments>']".into());
    }
    let token = env("CKANBAN_CALL_TOKEN").filter(|t| !t.is_empty()).ok_or("ckanban call only works inside an automation's check script")?;
    let input: Value = serde_json::from_str(raw).map_err(|_| r#"The arguments must be JSON, e.g. '{"limit": 20}'"#.to_string())?;
    let r = c.req("POST", "/api/automation-call", Some(&json!({ "token": token, "service": service, "tool": tool, "args": input })), &[], true)?;
    out(&match r.get("result") {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => args::compact(v),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_tags_like_bun() {
        assert_eq!(parse_status(" In Progress ").unwrap(), "in_progress");
        assert_eq!(parse_status("in--progress").unwrap(), "in_progress");
        assert!(parse_status("later").is_err());
        assert_eq!(normalize_tags("Post,#xhs, , post,two words"), vec!["post", "xhs", "two-words"]);
        assert_eq!(normalize_tag("abcdefghijklmnopqrstuvw-xyz"), "abcdefghijklmnopqrstuvw");
    }

    #[test]
    fn contains_is_by_folder() {
        assert!(contains("/a/b", "/a/b/c"));
        assert!(!contains("/a/b", "/a/bc"));
        assert!(contains("/", "/x"));
    }
}
