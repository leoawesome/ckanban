//! ask_keys and backup_file (src/mcp/form-tools.ts): the key box Claude asks for (src/integrations/ask-keys.ts) and
//! the private copy of a file before a key goes into it (src/integrations/file-backup.ts). Same texts, refusals and
//! files as Bun.

use std::collections::HashSet;
use std::fs;
use std::io::{ErrorKind, Read};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::sync::LazyLock;

use ckanban_board::sessions::js::{cut16, squash_spaces};
use regex::Regex;
use serde_json::Value;

use super::client::{HUDDLE_AGENT_ENV, R, err};
use super::js::{self, arr, s, t};
use super::{Ctx, hidden_tool, req_str};

/// TOOL_NO_KEYS: ask_keys inside a tool ticket's run.
const TOOL_NO_KEYS: &str = "This is a tool ticket: the user doesn't see its chat, so it can't show a key box. End your run with status \"questions\" and name each key you need in your summary (its variable name like SENTRY_AUTH_TOKEN, what it is for and where to create it): your parent asks the user for it with ask_keys, and your next run has it as that variable.";

const MAX_ASKED_KEYS: usize = 8;

pub async fn run(name: &str, a: &Value, cx: &Ctx) -> Option<R<String>> {
    Some(match name {
        "ask_keys" => ask_keys(a, cx).await,
        "backup_file" => backup_file(a, cx).await,
        _ => return None,
    })
}

// ---------- ask_keys ----------

/// `typeof v === "string" ? v.trim() : ""`.
fn str_trim(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).map(js::trim).unwrap_or("")
}

static CREATE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^https://[^\s"<>]+$"#).expect("valid regex"));

/// keysAsk: the env names asked for and whether to replace, or Bun's message for input it refuses.
fn keys_ask(input: &Value) -> Result<(Vec<String>, bool), String> {
    let raw = match js::get(input, "keys") {
        Some(Value::Array(a)) if !a.is_empty() => a,
        _ => return Err("keys must be a non-empty list of {envName, label}".into()),
    };
    if raw.len() > MAX_ASKED_KEYS {
        return Err(format!("ask for at most {MAX_ASKED_KEYS} keys at once"));
    }
    let mut seen: Vec<String> = Vec::new();
    for (i, k) in raw.iter().enumerate() {
        let at = format!("key {}: ", i + 1);
        let env_name = str_trim(js::get(k, "envName")).to_string();
        if let Some(bad) = crate::passes::key_name_error(&env_name) {
            return Err(at + &bad);
        }
        if seen.contains(&env_name) {
            return Err(format!("{at}{env_name} is listed twice"));
        }
        seen.push(env_name);
        if cut16(&squash_spaces(str_trim(js::get(k, "label"))), 80).is_empty() {
            return Err(format!("{at}label is required, e.g. \"Sentry auth token\""));
        }
        let url = str_trim(js::get(k, "createUrl"));
        if !url.is_empty() && !CREATE_URL.is_match(url) {
            return Err(format!("{at}createUrl must be an https:// address"));
        }
    }
    if cut16(&squash_spaces(str_trim(js::get(input, "reason"))), 300).is_empty() {
        return Err("reason is required: one line on what you will do with the keys".into());
    }
    let replace = js::get(input, "replace");
    if replace.is_some_and(|r| !r.is_boolean()) {
        return Err("replace must be true or false".into());
    }
    Ok((seen, replace == Some(&Value::Bool(true))))
}

async fn ask_keys(a: &Value, cx: &Ctx) -> R<String> {
    let (Some(board), Some(id)) = (cx.run_profile(), cx.run_ticket()) else {
        return err(NO_BOX);
    };
    if cx.env.get(HUDDLE_AGENT_ENV).is_some() {
        return err(NO_BOX);
    }
    let me = cx.client.get_ticket(board, id).await.ok();
    if hidden_tool(me.as_ref()) {
        return err(TOOL_NO_KEYS);
    }
    let (names, replace) = match keys_ask(a) {
        Ok(x) => x,
        Err(m) => return err(format!("{m}. Fix it and call ask_keys again.")),
    };
    // Always the run's own board: keys are kept per board.
    let all = cx.client.list_passes().await?;
    let saved: HashSet<String> = arr(&all, "passes")
        .iter()
        .filter(|p| s(p, "kind") == Some("key") && s(p, "board") == Some(board) && t(p, "envName"))
        .map(|p| js::sh(p, "envName"))
        .collect();
    let already: Vec<&String> = names.iter().filter(|n| saved.contains(*n)).collect();
    if !already.is_empty() && !replace {
        // `ctx.env[n] !== undefined`: set, even when empty.
        let set = |n: &str| std::env::var_os(n).is_some();
        let here: Vec<&String> = already.iter().copied().filter(|n| set(n)).collect();
        let later: Vec<&String> = already.iter().copied().filter(|n| !set(n)).collect();
        let list = |ns: &[&String]| ns.iter().map(|n| format!("${n}")).collect::<Vec<_>>().join(", ");
        let mut status = String::new();
        if !here.is_empty() {
            status += &format!("{} {} already saved for this board and in your environment now. ", list(&here), if here.len() == 1 { "is" } else { "are" });
        }
        if !later.is_empty() {
            let one = later.len() == 1;
            status += &format!(
                "{} {} saved for this board after this run started: {} the next run, not this one. ",
                list(&later),
                if one { "was" } else { "were" },
                if one { "it reaches" } else { "they reach" }
            );
        }
        let rest: Vec<&String> = names.iter().filter(|n| !saved.contains(*n)).collect();
        let tail = if rest.is_empty() {
            "Use them through the variables (never print a value). To replace a saved key, call ask_keys again with replace: true.".to_string()
        } else {
            format!("Call ask_keys again with only the keys not saved yet ({}), or with replace: true to replace the saved ones.", list(&rest))
        };
        // An error result: the chat draws no box for this call (session.ts drops cards whose call failed).
        return err(format!("No box shown. {status}{tail}"));
    }
    Ok(format!(
        "Shown to the user as a key box{}. End your turn now and wait: the board resumes you with a message naming the keys saved (they are then in your environment under those names) or saying the user will do it themselves.",
        if already.is_empty() { "" } else { " (it says it replaces the saved key)" }
    ))
}

const NO_BOX: &str = "ask_keys works only in a board ticket's chat, where the user sees the box. Ask the user to add the key in the ticket chat instead, and never ask them to paste it in a message.";

// ---------- backup_file ----------

/// The hidden folder in a board's data folder that holds the copies.
const BACKUPS_DIR: &str = ".key-backups";
/// Copies kept per file: the first one and the newest after it.
const BACKUPS_KEPT: usize = 5;
/// Larger files are not copied: a file a key goes into is small.
const BACKUP_MAX_BYTES: u64 = 10 * 1024 * 1024;

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$").expect("valid regex"));
static COPY_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{8}T\d{9}Z)(?:-(\d+))?$").expect("valid regex"));
static HOME_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:~|\$HOME|\$\{HOME\})(/.*)?$").expect("valid regex"));

async fn backup_file(a: &Value, cx: &Ctx) -> R<String> {
    // Inside a run, always the run's own board (like its keys); outside, the board of the folder or `profile`.
    let slug = match cx.run_profile() {
        Some(p) => p.to_string(),
        None => cx.slug(a).await?,
    };
    let path = req_str(a, "path")?.to_string();
    let root = crate::settings::data_root();
    let home = std::env::var("HOME").unwrap_or_default();
    let cwd = cx.cwd.to_string_lossy().to_string();
    let now = ckanban_core::time::now_ms();
    let r = tokio::task::spawn_blocking(move || backup(&root.to_string_lossy(), &slug, &path, &cwd, now, &home))
        .await
        .unwrap_or_else(|e| Err(e.to_string()));
    match r {
        Ok(r) => Ok(backup_text(&r)),
        Err(e) => err(format!("No copy made: {e}. Don't change the file until a copy is saved.")),
    }
}

#[derive(Debug, PartialEq)]
enum Backup {
    Copied { source: String, copy: String, removed: usize },
    Skipped(String),
}

/// path.normalize of an absolute path: `.`, `..` and repeated slashes folded; a trailing slash kept.
fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let mut out = format!("/{}", parts.join("/"));
    if p.ends_with('/') && out != "/" {
        out.push('/');
    }
    out
}

/// expandPath: a leading ~ or $HOME is the home folder; other paths are absolute or relative to `cwd`.
fn expand_path(path: &str, cwd: &str, home: &str) -> Result<String, String> {
    let p = js::trim(path);
    if let Some(m) = HOME_PREFIX.captures(p) {
        let rest = m.get(1).map_or("", |x| x.as_str());
        // path.join(home, rest): joined, then normalized (a trailing slash stays).
        return Ok(normalize(&if rest.is_empty() { home.to_string() } else { format!("{home}/{rest}") }));
    }
    if p.starts_with('~') {
        return Err(format!("write the full path instead of {p}"));
    }
    if p.starts_with('/') {
        return Ok(p.to_string());
    }
    // path.resolve: no trailing slash.
    let r = normalize(&format!("{cwd}/{p}"));
    Ok(if r.len() > 1 { r.trim_end_matches('/').to_string() } else { r })
}

/// Node's error code names for what these calls can meet.
fn code(e: &std::io::Error) -> String {
    let n = e.raw_os_error().unwrap_or(0);
    let name = match n {
        libc::ENOENT => "ENOENT",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::ENOTDIR => "ENOTDIR",
        libc::ELOOP => "ELOOP",
        libc::ENAMETOOLONG => "ENAMETOOLONG",
        libc::EISDIR => "EISDIR",
        libc::EEXIST => "EEXIST",
        libc::EIO => "EIO",
        libc::ENXIO => "ENXIO",
        libc::EAGAIN => "EAGAIN",
        libc::ENOSPC => "ENOSPC",
        libc::EROFS => "EROFS",
        _ => return e.to_string(),
    };
    name.to_string()
}

/// Node's fs error message: `CODE: description, call 'path'`.
fn fs_err(e: &std::io::Error, call: &str, path: &str) -> String {
    let desc = match e.raw_os_error() {
        Some(libc::ENOENT) => "no such file or directory",
        Some(libc::EACCES) => "permission denied",
        Some(libc::EPERM) => "operation not permitted",
        Some(libc::ENOTDIR) => "not a directory",
        Some(libc::EEXIST) => "file already exists",
        Some(libc::ELOOP) => "too many symbolic links encountered",
        Some(libc::ENOSPC) => "no space left on device",
        _ => return format!("{e}, {call} '{path}'"),
    };
    format!("{}: {desc}, {call} '{path}'", code(e))
}

/// Makes (or checks) a private folder: a real folder, not a link, mode 0700.
fn private_dir(dir: &str) -> Result<(), String> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true).mode(0o700);
    b.create(dir).map_err(|e| fs_err(&e, "mkdir", dir))?;
    let st = fs::symlink_metadata(dir).map_err(|e| fs_err(&e, "lstat", dir))?;
    if !st.is_dir() || st.file_type().is_symlink() {
        return Err(format!("{dir} is not a plain folder"));
    }
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| fs_err(&e, "chmod", dir))
}

/// backupFolderName: a short hash of the full real path, then the name made safe.
fn backup_folder_name(real: &str) -> String {
    let hash = &super::sha256::hex(real.as_bytes())[..12];
    let base = real.rsplit('/').next().unwrap_or("");
    let safe: String = base.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect();
    let safe = cut16(&safe, 60);
    format!("{hash}-{}", if safe.is_empty() { "file" } else { safe })
}

/// 20261109T153012345Z: sorts by time as text.
fn stamp(now_ms: f64) -> String {
    ckanban_core::time::iso(now_ms).replace(['-', ':'], "").replacen('.', "", 1)
}

/// Copy names in time order: by stamp, then by the number a same-millisecond copy gets.
fn by_time(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |s: &str| {
        let c = COPY_NAME.captures(s).expect("copy name");
        let n: f64 = c.get(2).map_or(0.0, |m| m.as_str().parse().unwrap_or(f64::INFINITY));
        (c[1].to_string(), n)
    };
    let (sa, na) = key(a);
    let (sb, nb) = key(b);
    sa.cmp(&sb).then(na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal))
}

/// backupFile: copies `path` to <root>/profiles/<slug>/.key-backups/<hash>-<name>/<time>, keeps the first and the
/// newest copies, and says where the copy went. A missing file is not an error: nothing is done.
fn backup(root: &str, slug: &str, path: &str, cwd: &str, now_ms: f64, home: &str) -> Result<Backup, String> {
    if !SLUG.is_match(slug) {
        return Err(format!("\"{slug}\" is not a board name"));
    }
    if js::trim(path).is_empty() {
        return Err("path is required".into());
    }
    let asked = expand_path(path, cwd, home)?;
    let real = match fs::canonicalize(&asked) {
        Ok(r) => r.to_string_lossy().to_string(),
        // Only a file that really isn't there is "missing": one that can't be read must not be overwritten.
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {
            return Ok(Backup::Skipped(format!(
                "{asked} doesn't exist: nothing to back up. Check the path is the one you will write; if it is, create the file with only the key's line."
            )));
        }
        Err(e) => return Err(format!("{asked} can't be read ({})", code(&e))),
    };
    // Open without blocking (a FIFO swapped in stays unread), then check what was opened.
    let mut f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(&real).map_err(|e| fs_err(&e, "open", &real))?;
    let st = f.metadata().map_err(|e| e.to_string())?;
    if !st.is_file() {
        return Ok(Backup::Skipped(format!("{asked} is not a file: nothing was copied.")));
    }
    if st.len() > BACKUP_MAX_BYTES {
        return Ok(Backup::Skipped(format!(
            "{asked} is larger than {} MB: not copied. A file a key goes into should be small; check the path.",
            BACKUP_MAX_BYTES / 1_048_576
        )));
    }
    let mut data = Vec::new();
    f.read_to_end(&mut data).map_err(|e| fs_err(&e, "read", &real))?;
    drop(f);

    let board = format!("{}/profiles/{slug}", root.trim_end_matches('/'));
    if !fs::symlink_metadata(&board).is_ok_and(|m| m.is_dir()) {
        return Err(format!("board \"{slug}\" has no data folder"));
    }
    let base = format!("{board}/{BACKUPS_DIR}");
    private_dir(&base)?;
    let dir = format!("{base}/{}", backup_folder_name(&real));
    private_dir(&dir)?;

    let first = stamp(now_ms);
    let mut n = 0;
    let copy = loop {
        let name = if n > 0 { format!("{first}-{n}") } else { first.clone() };
        let copy = format!("{dir}/{name}");
        // create_new: never overwrite, never follow a link planted at the name.
        match fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&copy) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(&data).map_err(|e| fs_err(&e, "write", &copy))?;
                break copy;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists && n <= 50 => n += 1,
            Err(e) => return Err(fs_err(&e, "open", &copy)),
        }
    };
    fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).map_err(|e| fs_err(&e, "chmod", &copy))?;

    // Keep the first copy (the file before Claude's edits), the one just made, and the newest others up to BACKUPS_KEPT.
    let made = copy.rsplit('/').next().unwrap_or("").to_string();
    let mut copies: Vec<String> = fs::read_dir(&dir)
        .map_err(|e| fs_err(&e, "scandir", &dir))?
        .filter_map(|e| e.ok().and_then(|e| e.file_name().into_string().ok()))
        .filter(|f| COPY_NAME.is_match(f) && *f != made)
        .collect();
    copies.sort_by(|a, b| by_time(a, b));
    let keep_rest = BACKUPS_KEPT.saturating_sub(2);
    let old: &[String] = if copies.is_empty() { &[] } else { &copies[1..copies.len() - (copies.len() - 1).min(keep_rest)] };
    for f in old {
        let p = format!("{dir}/{f}");
        fs::remove_file(&p).map_err(|e| fs_err(&e, "unlink", &p))?;
    }
    Ok(Backup::Copied { source: real, copy, removed: old.len() })
}

/// backupText: where the copy went, never what is in it.
fn backup_text(r: &Backup) -> String {
    match r {
        Backup::Skipped(reason) => reason.clone(),
        Backup::Copied { source, copy, removed } => format!(
            "Saved a private copy of {source} to {copy} (only this Mac's user can read it; {BACKUPS_KEPT} copies of this file are kept: the first and the newest{}; deleting the board deletes them). Don't read or print the copy (it can hold keys); to undo, copy it back over the file. Now change only the key's line (add it if it is missing), using the variable; don't rewrite or print the file.",
            if *removed > 0 { format!(", {removed} older removed") } else { String::new() }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp() -> String {
        let d = std::env::temp_dir().join(format!("ck-backup-{}-{}", std::process::id(), ckanban_core::time::now_ms() as u64 ^ rand_bits()));
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap().to_string_lossy().to_string()
    }
    fn rand_bits() -> u64 {
        let mut b = [0u8; 8];
        getrandom::fill(&mut b).unwrap();
        u64::from_le_bytes(b)
    }

    #[test]
    fn key_asks_like_bun() {
        let ok = json!({ "keys": [{ "envName": "SENTRY_TOKEN", "label": "Sentry" }], "reason": "r" });
        assert_eq!(keys_ask(&ok), Ok((vec!["SENTRY_TOKEN".to_string()], false)));
        assert_eq!(keys_ask(&json!({ "keys": [] })).unwrap_err(), "keys must be a non-empty list of {envName, label}");
        let many: Vec<Value> = (0..9).map(|i| json!({ "envName": format!("K{i}"), "label": "x" })).collect();
        assert_eq!(keys_ask(&json!({ "keys": many })).unwrap_err(), "ask for at most 8 keys at once");
        assert_eq!(
            keys_ask(&json!({ "keys": [{ "envName": "path", "label": "x" }] })).unwrap_err(),
            "key 1: \"path\" can't be a key's name: use capital letters, digits and _ (like SENTRY_AUTH_TOKEN)"
        );
        assert_eq!(
            keys_ask(&json!({ "keys": [{ "envName": "CKANBAN_X", "label": "x" }] })).unwrap_err(),
            "key 1: \"CKANBAN_X\" is a name the board or Claude uses itself: pick another (like MY_CKANBAN_X)"
        );
        assert_eq!(keys_ask(&json!({ "keys": [{ "envName": "A", "label": "x" }, { "envName": "A", "label": "y" }] })).unwrap_err(), "key 2: A is listed twice");
        assert_eq!(keys_ask(&json!({ "keys": [{ "envName": "A", "label": " " }] })).unwrap_err(), "key 1: label is required, e.g. \"Sentry auth token\"");
        assert_eq!(keys_ask(&json!({ "keys": [{ "envName": "A", "label": "x", "createUrl": "http://x" }] })).unwrap_err(), "key 1: createUrl must be an https:// address");
        assert_eq!(keys_ask(&json!({ "keys": [{ "envName": "A", "label": "x" }] })).unwrap_err(), "reason is required: one line on what you will do with the keys");
        assert_eq!(keys_ask(&json!({ "keys": [{ "envName": "A", "label": "x" }], "reason": "r", "replace": 1 })).unwrap_err(), "replace must be true or false");
    }

    #[test]
    fn paths_expand_like_node() {
        assert_eq!(expand_path("~/.env", "/w", "/h").unwrap(), "/h/.env");
        assert_eq!(expand_path(" $HOME/a/../b ", "/w", "/h").unwrap(), "/h/b");
        assert_eq!(expand_path("${HOME}", "/w", "/h").unwrap(), "/h");
        assert_eq!(expand_path("~", "/w", "/h/").unwrap(), "/h/");
        assert_eq!(expand_path("~/", "/w", "/h").unwrap(), "/h/");
        assert_eq!(expand_path("~bob/x", "/w", "/h").unwrap_err(), "write the full path instead of ~bob/x");
        assert_eq!(expand_path("a/./b/", "/w", "/h").unwrap(), "/w/a/b");
        assert_eq!(expand_path("/x//y", "/w", "/h").unwrap(), "/x//y");
        assert_eq!(stamp(1_762_702_212_345.0), "20251109T153012345Z");
        assert!(backup_folder_name("/p/my .env").ends_with("-my_.env"));
        assert_eq!(backup_folder_name("/p/my .env").len(), 12 + 1 + 7);
    }

    #[test]
    fn copies_and_prunes() {
        let root = tmp();
        fs::create_dir_all(format!("{root}/profiles/b")).unwrap();
        let file = format!("{root}/proj/.env");
        fs::create_dir_all(format!("{root}/proj")).unwrap();
        fs::write(&file, "A=1\n").unwrap();
        let missing = backup(&root, "b", "nope", &format!("{root}/proj"), 0.0, "/h").unwrap();
        assert_eq!(missing, Backup::Skipped(format!("{root}/proj/nope doesn't exist: nothing to back up. Check the path is the one you will write; if it is, create the file with only the key's line.")));
        assert_eq!(backup(&root, "b", &format!("{root}/proj"), "/", 0.0, "/h").unwrap(), Backup::Skipped(format!("{root}/proj is not a file: nothing was copied.")));
        assert_eq!(backup(&root, "../x", ".env", "/", 0.0, "/h").unwrap_err(), "\"../x\" is not a board name");
        assert_eq!(backup(&root, "nob", &file, "/", 0.0, "/h").unwrap_err(), "board \"nob\" has no data folder");
        let mut removed = vec![];
        for _ in 0..8 {
            match backup(&root, "b", ".env", &format!("{root}/proj"), 1_000.0, "/h").unwrap() {
                Backup::Copied { source, copy, removed: r } => {
                    assert_eq!(source, file);
                    assert_eq!(fs::read_to_string(&copy).unwrap(), "A=1\n");
                    assert_eq!(fs::metadata(&copy).unwrap().permissions().mode() & 0o777, 0o600);
                    removed.push(r);
                }
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(removed, vec![0, 0, 0, 0, 0, 1, 1, 1]);
        let dir = format!("{root}/profiles/b/{BACKUPS_DIR}/{}", backup_folder_name(&file));
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let mut names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort_by(|a, b| by_time(a, b));
        let s = stamp(1_000.0);
        // Same millisecond: a pruned name is free again and taken by the next copy (as Bun's `wx` loop does).
        assert_eq!(names, vec![s.clone(), format!("{s}-2"), format!("{s}-3"), format!("{s}-4"), format!("{s}-5")]);
        // A link at the backups folder is refused.
        fs::create_dir_all(format!("{root}/profiles/c")).unwrap();
        std::os::unix::fs::symlink("/tmp", format!("{root}/profiles/c/{BACKUPS_DIR}")).unwrap();
        assert!(backup(&root, "c", &file, "/", 0.0, "/h").unwrap_err().ends_with("is not a plain folder"));
        fs::remove_dir_all(&root).unwrap();
    }
}
