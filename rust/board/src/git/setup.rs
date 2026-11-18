//! Setting up a ticket's copy of the folder (port of `src/runs/worktree-setup.ts`): a fresh copy lacks git-ignored
//! files (.env, node_modules). The board copies the board's `copyFiles` when it makes the copy and runs its
//! `setupCommand` there only when the ticket's Claude asks (`ckanban ticket setup`). Both are detected from the folder.

use std::collections::HashSet;
use std::path::{Component, Path};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;

use super::cmd::run;
use super::ops::s;
use super::repo::is_git_repo;

/// The board's setup command is stopped after this long with no new output (an install can take long, but it prints).
pub const SETUP_SILENCE: Duration = Duration::from_secs(15 * 60);
pub const CLEANUP_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// After SIGTERM, how long the command gets before SIGKILL.
const KILL_GRACE: Duration = Duration::from_secs(5);
/// After the command ended, how long its output pipes may stay open (a background grandchild holding them).
const PIPE_GRACE: Duration = Duration::from_secs(3);

/// When `run_shell` gives up on a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    /// This long in all.
    Total(Duration),
    /// This long with no new output.
    Silence(Duration),
}

/// "15 minutes", "90 seconds", "300ms".
pub fn span_text(d: Duration) -> String {
    let secs = d.as_secs();
    let plural = |n: u64, w: &str| format!("{n} {w}{}", if n == 1 { "" } else { "s" });
    if d.subsec_millis() != 0 || secs == 0 {
        format!("{}ms", d.as_millis())
    } else if secs % 60 == 0 {
        plural(secs / 60, "minute")
    } else {
        plural(secs, "second")
    }
}
/// Output lines kept for the prompt and the chat row.
pub const SETUP_TAIL_LINES: usize = 40;

/// Folders never scanned for lockfiles or .env files: dependencies, build output, caches.
const SKIP_DIRS: [&str; 9] = ["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "tmp", "__pycache__"];

/// Per ecosystem, the first lockfile found in a folder decides its install command.
const LOCKFILES: [&[(&str, &str)]; 3] = [
    &[
        ("bun.lock", "bun install"),
        ("bun.lockb", "bun install"),
        ("pnpm-lock.yaml", "pnpm install"),
        ("yarn.lock", "yarn install"),
        ("package-lock.json", "npm ci"),
    ],
    &[("uv.lock", "uv sync"), ("poetry.lock", "poetry install")],
    &[("Gemfile.lock", "bundle install")],
];

fn sh_quote(x: &str) -> String {
    if !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-')) {
        x.to_string()
    } else {
        format!("'{}'", x.replace('\'', "'\\''"))
    }
}

/// JS `a < b` for strings: UTF-16 code unit order (what `.sort()` with no compare function uses).
pub fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The root ("") and its first-level subfolders worth scanning, sorted.
fn scan_dirs(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .map(|d| {
            d.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| !n.starts_with('.') && !SKIP_DIRS.contains(&n.as_str()))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| js_cmp(a, b));
    std::iter::once(String::new()).chain(names).collect()
}

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|d| d.flatten().filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    names.sort_by(|a, b| js_cmp(a, b));
    names
}

/// Which of these repo-relative paths git ignores (folders end in "/").
async fn ignored(repo: &Path, paths: &[String]) -> HashSet<String> {
    if paths.is_empty() {
        return HashSet::new();
    }
    let mut cmd = vec!["git", "check-ignore", "--"];
    cmd.extend(paths.iter().map(String::as_str));
    let r = run(&cmd, repo, &[], None).await;
    // Exit 1: none ignored; 128: not a repo.
    if r.code != 0 {
        return HashSet::new();
    }
    r.stdout.split('\n').map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

async fn tracked_files(repo: &Path, paths: &[String]) -> HashSet<String> {
    if paths.is_empty() {
        return HashSet::new();
    }
    let mut cmd = vec!["git", "ls-files", "--"];
    cmd.extend(paths.iter().map(String::as_str));
    let r = run(&cmd, repo, &[], None).await;
    if r.code != 0 {
        return HashSet::new();
    }
    r.stdout.split('\n').map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

fn join_rel(d: &str, f: &str) -> String {
    if d.is_empty() { f.to_string() } else { format!("{d}/{f}") }
}

/// `detectSetup`: git-ignored .env files to copy and lockfiles that say how to install dependencies, as Bun's
/// `SetupDetection` (`{at, copyFiles, setupCommand, setupFrom}`).
pub async fn detect_setup(repo: &Path) -> Value {
    let at = ckanban_core::time::iso(ckanban_core::time::now_ms());
    // Only git boards get copies, so only they need setup.
    if !is_git_repo(repo).await {
        return json!({ "at": at, "copyFiles": [], "setupCommand": "", "setupFrom": [] });
    }
    let all = scan_dirs(repo);
    let dir_ignored = ignored(repo, &all.iter().filter(|d| !d.is_empty()).map(|d| format!("{d}/")).collect::<Vec<_>>()).await;
    let dirs: Vec<String> = all.into_iter().filter(|d| d.is_empty() || (!dir_ignored.contains(&format!("{d}/")) && !dir_ignored.contains(d))).collect();

    let envs: Vec<String> = dirs.iter().flat_map(|d| files(&repo.join(d)).into_iter().filter(|f| f.starts_with(".env")).map(move |f| join_rel(d, &f))).collect();
    let ignored_envs = ignored(repo, &envs).await;
    let copy_files: Vec<String> = envs.into_iter().filter(|f| ignored_envs.contains(f)).collect();

    // Only lockfiles in version history: a ticket's copy has no untracked folders.
    let is_lock = |f: &str| LOCKFILES.iter().any(|g| g.iter().any(|(l, _)| *l == f));
    let candidates: Vec<String> = dirs.iter().flat_map(|d| files(&repo.join(d)).into_iter().filter(|f| is_lock(f)).map(move |f| join_rel(d, &f))).collect();
    let tracked = tracked_files(repo, &candidates).await;
    let mut commands = Vec::new();
    let mut setup_from = Vec::new();
    for d in &dirs {
        let present: HashSet<String> = files(&repo.join(d)).into_iter().filter(|f| tracked.contains(&join_rel(d, f))).collect();
        for group in LOCKFILES {
            let Some((file, command)) = group.iter().find(|(l, _)| present.contains(*l)) else { continue };
            commands.push(if d.is_empty() { command.to_string() } else { format!("(cd {} && {command})", sh_quote(d)) });
            setup_from.push(join_rel(d, file));
        }
    }
    json!({ "at": at, "copyFiles": copy_files, "setupCommand": commands.join(" && "), "setupFrom": setup_from })
}

/// `applyDetection`: fills in only the profile fields never set (or all with `overwrite`), and `setupDetected`.
pub fn apply_detection(p: &Value, d: &Value, overwrite: bool) -> Value {
    let mut m = p.as_object().cloned().unwrap_or_default();
    for key in ["copyFiles", "setupCommand"] {
        // `p.copyFiles === undefined`: only a missing key counts as never set.
        let keep = !overwrite && m.contains_key(key);
        let v = if keep { m[key].clone() } else { d[key].clone() };
        m.insert(key.into(), v);
    }
    m.insert("setupDetected".into(), d.clone());
    Value::Object(m)
}

/// What `detect_missing` changes in one profile, or None.
fn missing_update(now: &Value, d: &Value) -> Option<Value> {
    let Some(det) = now.get("setupDetected") else { return Some(apply_detection(now, d, false)) };
    let guessed = det.is_object() && now.get("setupCommand") == det.get("setupCommand");
    if !guessed || d.get("setupCommand") == now.get("setupCommand") {
        return None;
    }
    let mut next = now.as_object().cloned().unwrap_or_default();
    next.insert("setupCommand".into(), d["setupCommand"].clone());
    let mut det = det.as_object().cloned().unwrap_or_default();
    det.insert("at".into(), d["at"].clone());
    det.insert("setupCommand".into(), d["setupCommand"].clone());
    det.insert("setupFrom".into(), d["setupFrom"].clone());
    next.insert("setupDetected".into(), Value::Object(det));
    Some(Value::Object(next))
}

/// `detectMissing` (daemon start): boards made before setup detection existed are detected once, keeping values
/// already set; a setup command still equal to an earlier guess is guessed again; an edited one stays. `get` reads a
/// profile now, `save` writes it (and tells the board).
pub async fn detect_missing(profiles: Vec<Value>, get: impl Fn(&str) -> Option<Value>, save: impl Fn(Value)) {
    for p in profiles {
        let det = p.get("setupDetected");
        let guessed = det.is_some_and(|d| ckanban_core::jsnum::truthy(Some(d))) && p.get("setupCommand") == det.and_then(|d| d.get("setupCommand"));
        let Some(path) = s(&p, "path") else { continue };
        if (det.is_some() && !guessed) || !Path::new(path).exists() {
            continue;
        }
        let Some(slug) = s(&p, "slug") else { continue };
        let d = detect_setup(Path::new(path)).await;
        let Some(now) = get(slug) else { continue };
        if let Some(next) = missing_update(&now, &d) {
            save(next);
        }
    }
}

/// A repo-relative path that stays inside the repo, or None (`inside`: normalized, no trailing slash).
fn inside(p: &str) -> Option<String> {
    let t = p.trim();
    if t.is_empty() || t.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for c in Path::new(t).components() {
        match c {
            Component::Normal(x) => parts.push(x.to_str()?),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            _ => return None,
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("/"))
}

fn has_glob(p: &str) -> bool {
    p.contains(['*', '?', '[', ']', '{', '}'])
}

/// One path segment of a glob as a regex (`*`, `?`, `[...]`, `{a,b}`).
fn segment_regex(seg: &str) -> Option<regex::Regex> {
    let mut re = String::from("^");
    let chars: Vec<char> = seg.chars().collect();
    let mut i = 0;
    let mut depth = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '[' => {
                let end = chars[i + 1..].iter().position(|&x| x == ']').map(|p| p + i + 1)?;
                let mut class: String = chars[i + 1..end].iter().collect();
                if let Some(rest) = class.strip_prefix('!') {
                    class = format!("^{rest}");
                }
                re.push('[');
                re.push_str(&class.replace('\\', "\\\\"));
                re.push(']');
                i = end;
            }
            '{' => {
                depth += 1;
                re.push_str("(?:");
            }
            '}' if depth > 0 => {
                depth -= 1;
                re.push(')');
            }
            ',' if depth > 0 => re.push('|'),
            '\\' if i + 1 < chars.len() => {
                i += 1;
                re.push_str(&regex::escape(&chars[i].to_string()));
            }
            other => re.push_str(&regex::escape(&other.to_string())),
        }
        i += 1;
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// Files under `root` matching a relative glob (`Bun.Glob(p).scanSync({cwd, dot: true, onlyFiles: true})`):
/// symlinked folders are not followed. Relative, "/"-separated.
pub fn glob_files(root: &Path, pattern: &str) -> Vec<String> {
    let segs: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    walk_glob(root, "", &segs, &mut out, &mut seen);
    out
}

fn walk_glob(dir: &Path, rel: &str, segs: &[&str], out: &mut Vec<String>, seen: &mut HashSet<String>) {
    let Some((seg, rest)) = segs.split_first() else { return };
    if *seg == "**" {
        walk_glob(dir, rel, rest, out, seen);
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(name) = e.file_name().into_string() else { continue };
            walk_glob(&dir.join(&name), &join_rel(rel, &name), segs, out, seen);
        }
        return;
    }
    let mut take = |name: &str, is_dir: bool, is_file: bool| {
        let r = join_rel(rel, name);
        if rest.is_empty() {
            if is_file && seen.insert(r.clone()) {
                out.push(r);
            }
        } else if is_dir {
            walk_glob(&dir.join(name), &r, rest, out, seen);
        }
    };
    if !has_glob(seg) {
        let p = dir.join(seg);
        // Bun's scan doesn't follow a symlinked folder, but a symlinked file counts as a file.
        let Ok(lm) = std::fs::symlink_metadata(&p) else { return };
        let is_dir = lm.is_dir();
        let is_file = lm.is_file() || (lm.file_type().is_symlink() && p.is_file());
        take(seg, is_dir, is_file);
        return;
    }
    let Some(re) = segment_regex(seg) else { return };
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<(String, bool, bool)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let ft = e.file_type().ok()?;
            let is_file = ft.is_file() || (ft.is_symlink() && e.path().is_file());
            Some((name, ft.is_dir(), is_file))
        })
        .filter(|(n, _, _)| re.is_match(n))
        .collect();
    entries.sort_by(|a, b| js_cmp(&a.0, &b.0));
    for (name, is_dir, is_file) in entries {
        take(&name, is_dir, is_file);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Copied {
    pub copied: Vec<String>,
    pub missing: Vec<String>,
}

/// `copySetupFiles`: copies files (paths or globs relative to `from`) to the same place under `to`. Missing ones are
/// listed, files already there (tracked ones) are left alone. Blocking: call it off the runtime.
pub fn copy_setup_files(from: &Path, to: &Path, patterns: &[String]) -> Copied {
    let mut out = Copied::default();
    for raw in patterns {
        let Some(pattern) = inside(raw) else { continue };
        let mut matches: Vec<String> = if has_glob(&pattern) {
            glob_files(from, &pattern).into_iter().filter_map(|m| inside(&m)).collect()
        } else if from.join(&pattern).is_file() {
            vec![pattern.clone()]
        } else {
            Vec::new()
        };
        if matches.is_empty() {
            out.missing.push(raw.trim().to_string());
            continue;
        }
        matches.sort_by(|a, b| js_cmp(a, b));
        for m in matches {
            let dest = to.join(&m);
            if dest.exists() || out.copied.contains(&m) {
                continue;
            }
            let ok = dest.parent().map(std::fs::create_dir_all).transpose().is_ok() && std::fs::copy(from.join(&m), &dest).is_ok();
            if ok { out.copied.push(m) } else { out.missing.push(m) }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Last lines of stdout and stderr, interleaved.
    pub output: String,
    pub duration_ms: u64,
}

const MAX_OUTPUT: usize = 64 * 1024;

/// The user's login shell (so PATH matches their terminal even under launchd).
pub fn user_shell() -> String {
    match std::env::var("SHELL") {
        Ok(x) if !x.is_empty() && Path::new(&x).exists() => x,
        _ if Path::new("/bin/zsh").exists() => "/bin/zsh".into(),
        _ => "/bin/sh".into(),
    }
}

/// `tailLines`: the last `n` lines, trailing white space dropped.
pub fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.trim_end().split('\n').collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// `runShell`: runs `command` in `cwd` through the user's shell (`-lc`), in its own process group. Stopped at its
/// `limit` or when `abort` is notified: SIGTERM to the group, SIGKILL after `KILL_GRACE`, and the output pipes are
/// read for at most `PIPE_GRACE` more, so a grandchild that keeps them open can't hold the caller.
pub async fn run_shell(cwd: &Path, command: &str, limit: Limit, shell: Option<&str>, env: &[(&str, &str)], abort: Option<Arc<tokio::sync::Notify>>) -> ShellResult {
    let started = Instant::now();
    let shell = shell.map(str::to_string).unwrap_or_else(user_shell);
    let mut c = tokio::process::Command::new(&shell);
    c.args(["-lc", command]).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).kill_on_drop(true);
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            return ShellResult { ok: false, exit_code: None, timed_out: false, output: e.to_string(), duration_ms: started.elapsed().as_millis() as u64 };
        }
    };
    let pid = child.id();
    let buf = Arc::new(parking_lot::Mutex::new(Vec::<u8>::new()));
    // When output last came in.
    let last = Arc::new(parking_lot::Mutex::new(Instant::now()));
    let pump = |mut r: Box<dyn tokio::io::AsyncRead + Unpin + Send>, buf: Arc<parking_lot::Mutex<Vec<u8>>>, last: Arc<parking_lot::Mutex<Instant>>| {
        tokio::spawn(async move {
            let mut chunk = [0u8; 8192];
            loop {
                match r.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        *last.lock() = Instant::now();
                        let mut b = buf.lock();
                        b.extend_from_slice(&chunk[..n]);
                        if b.len() > MAX_OUTPUT * 2 {
                            let cut = b.len() - MAX_OUTPUT;
                            b.drain(..cut);
                        }
                    }
                }
            }
        })
    };
    let a = pump(Box::new(child.stdout.take().expect("piped")), buf.clone(), last.clone());
    let b = pump(Box::new(child.stderr.take().expect("piped")), buf.clone(), last.clone());
    let signal = |sig: libc::c_int| {
        if let Some(pid) = pid {
            // SAFETY: kill(2) on the process group this function started.
            unsafe { libc::kill(-(pid as libc::pid_t), sig) };
        }
    };
    let aborted = async {
        match &abort {
            Some(n) => n.notified().await,
            None => std::future::pending().await,
        }
    };
    tokio::pin!(aborted);
    enum End {
        Exited(Option<std::process::ExitStatus>),
        Limit,
        Stopped,
    }
    let end = loop {
        let deadline = match limit {
            Limit::Total(d) => started + d,
            Limit::Silence(d) => *last.lock() + d,
        };
        tokio::select! {
            _ = tokio::time::sleep_until(deadline.into()) => {
                // Output came in while sleeping: wait from then.
                if matches!(limit, Limit::Silence(d) if last.lock().elapsed() < d) {
                    continue;
                }
                break End::Limit;
            }
            _ = &mut aborted => break End::Stopped,
            st = child.wait() => break End::Exited(st.ok()),
        }
    };
    let status = match end {
        End::Exited(st) => st,
        End::Limit | End::Stopped => {
            signal(libc::SIGTERM);
            match tokio::time::timeout(KILL_GRACE, child.wait()).await {
                Ok(st) => st.ok(),
                Err(_) => {
                    signal(libc::SIGKILL);
                    tokio::time::timeout(KILL_GRACE, child.wait()).await.ok().and_then(Result::ok)
                }
            }
        }
    };
    // The shell is gone; a grandchild may still hold the pipes open. Take what came, then stop reading.
    let (ha, hb) = (a.abort_handle(), b.abort_handle());
    if tokio::time::timeout(PIPE_GRACE, async {
        let _ = a.await;
        let _ = b.await;
    })
    .await
    .is_err()
    {
        ha.abort();
        hb.abort();
    }
    let mut text = String::from_utf8_lossy(&buf.lock()).into_owned();
    let timed_out = matches!(end, End::Limit);
    match (&end, limit) {
        (End::Limit, Limit::Total(d)) => text.push_str(&format!("\n(timed out after {}s)", (d.as_millis() as f64 / 1000.0).round() as u64)),
        (End::Limit, Limit::Silence(d)) => {
            text.truncate(text.trim_end().len());
            text.push_str(&format!("\n(stopped: no output for {})", span_text(d)));
        }
        (End::Stopped, _) => text.push_str("\n(stopped)"),
        _ => {}
    }
    let code = status.and_then(|s| s.code());
    let ok = code == Some(0) && !timed_out;
    let start = text.len().saturating_sub(MAX_OUTPUT);
    let start = (start..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len());
    ShellResult { ok, exit_code: code, timed_out, output: tail_lines(&text[start..], 400), duration_ms: started.elapsed().as_millis() as u64 }
}

/// What preparing a copy did (`SetupResult`): one row in the ticket chat, told to Claude.
pub fn setup_result(copied: &Copied, command: &str, r: Option<&ShellResult>, duration_ms: u64) -> Value {
    json!({
        "copied": copied.copied,
        "missing": copied.missing,
        "command": command,
        "ok": r.map(|r| r.ok),
        "exitCode": r.and_then(|r| r.exit_code),
        "timedOut": r.is_some_and(|r| r.timed_out),
        "output": r.map(|r| tail_lines(&r.output, SETUP_TAIL_LINES)).unwrap_or_default(),
        "durationMs": duration_ms,
    })
}

/// `prepareWorktree`: copies the board's files into a new copy, then runs its setup command there. None when there
/// is nothing to do. Never fails.
pub async fn prepare_worktree(repo: &Path, dir: &Path, profile: &Value, limit: Limit, shell: Option<&str>, env: &[(&str, &str)], abort: Option<Arc<tokio::sync::Notify>>) -> Option<Value> {
    let patterns: Vec<String> = profile.get("copyFiles").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let command = s(profile, "setupCommand").unwrap_or("").trim().to_string();
    if patterns.is_empty() && command.is_empty() {
        return None;
    }
    let started = Instant::now();
    let (from, to) = (repo.to_path_buf(), dir.to_path_buf());
    let copied = tokio::task::spawn_blocking(move || copy_setup_files(&from, &to, &patterns)).await.unwrap_or_default();
    if command.is_empty() {
        return Some(setup_result(&copied, "", None, started.elapsed().as_millis() as u64));
    }
    let r = run_shell(dir, &command, limit, shell, env, abort).await;
    Some(setup_result(&copied, &command, Some(&r), started.elapsed().as_millis() as u64))
}

const SETUP_TAG: &str = "ckanban-setup";

/// `setupBlock`: the setup result as the block that ends `ckanban ticket setup`'s output ("<" escaped).
pub fn setup_block(r: &Value) -> String {
    let text = serde_json::to_string(r).unwrap_or_default().replace('<', "\\u003c");
    format!("<{SETUP_TAG}>{text}</{SETUP_TAG}>")
}

/// `parseSetupBlock`.
pub fn parse_setup_block(text: &str) -> Option<Value> {
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?s)<ckanban-setup>(.*?)</ckanban-setup>").unwrap());
    let inner = RE.captures(text)?.get(1)?.as_str();
    let v: Value = serde_json::from_str(inner).ok()?;
    let command = v.get("command")?.as_str()?.to_string();
    let strs = |k: &str| -> Value {
        Value::Array(
            v.get(k)
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|x| Value::String(x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string()))).collect())
                .unwrap_or_default(),
        )
    };
    let mut m = Map::new();
    m.insert("copied".into(), strs("copied"));
    m.insert("missing".into(), strs("missing"));
    m.insert("command".into(), json!(command));
    m.insert("ok".into(), v.get("ok").filter(|x| x.is_boolean()).cloned().unwrap_or(Value::Null));
    m.insert("exitCode".into(), v.get("exitCode").filter(|x| x.is_number()).cloned().unwrap_or(Value::Null));
    m.insert("timedOut".into(), json!(ckanban_core::jsnum::truthy(v.get("timedOut"))));
    m.insert("output".into(), v.get("output").filter(|x| x.is_string()).cloned().unwrap_or(json!("")));
    m.insert("durationMs".into(), v.get("durationMs").filter(|x| x.is_number()).cloned().unwrap_or(json!(0)));
    Some(Value::Object(m))
}

/// `withBoardText`: adds board text to a prompt inside its board instructions (or new ones).
pub fn with_board_text(prompt: &str, text: &str, note: &str) -> String {
    if prompt.contains("<ckanban-context") {
        format!("{prompt}\n\n{text}")
    } else {
        format!("{prompt}\n\n<ckanban-context note=\"{note}\">\n{text}\n</ckanban-context>")
    }
}

#[cfg(test)]
mod tests {
    use super::super::repo::tests::{make_repo, sh};
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    async fn commit(repo: &Path) {
        sh(repo, &["add", "-A"]).await;
        sh(repo, &["commit", "-qm", "c"]).await;
    }

    #[tokio::test]
    async fn detects_env_files_and_lockfiles() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "a").await;
        write(&repo, ".gitignore", ".env\n.env.local\nnode_modules/\ndist/\nweb/.env\ndeep/a/.env\n");
        write(&repo, ".env.example", "");
        commit(&repo).await;
        for f in [".env", ".env.local", "web/.env", "web/index.ts", "deep/a/.env", "node_modules/x/.env", "node_modules/.env", "dist/.env"] {
            write(&repo, f, "");
        }
        assert_eq!(detect_setup(&repo).await["copyFiles"], json!([".env", ".env.local", "web/.env"]));

        let repo = make_repo(t.path(), "b").await;
        for f in ["bun.lock", "web/bun.lockb", "api/poetry.lock", "api/uv.lock", "site/package-lock.json", "site/Gemfile.lock", "tool/go.mod", "crate/Cargo.lock", "node_modules/foo/yarn.lock"] {
            write(&repo, f, "");
        }
        commit(&repo).await;
        let d = detect_setup(&repo).await;
        assert_eq!(d["setupCommand"], "bun install && (cd api && uv sync) && (cd site && npm ci) && (cd site && bundle install) && (cd web && bun install)");
        assert_eq!(d["setupFrom"], json!(["bun.lock", "api/uv.lock", "site/package-lock.json", "site/Gemfile.lock", "web/bun.lockb"]));
        assert_eq!(d.as_object().unwrap().keys().collect::<Vec<_>>(), ["at", "copyFiles", "setupCommand", "setupFrom"]);

        // Untracked folders and git-ignored folders are left out; a plain folder gets nothing.
        let repo = make_repo(t.path(), "c").await;
        write(&repo, ".gitignore", "generated/\n");
        write(&repo, "expo/package-lock.json", "");
        commit(&repo).await;
        write(&repo, "generated/package-lock.json", "");
        write(&repo, "marketing/package-lock.json", "");
        write(&repo, "yarn.lock", "");
        assert_eq!(detect_setup(&repo).await["setupCommand"], "(cd expo && npm ci)");
        let plain = t.path().join("plain");
        write(&plain, "bun.lock", "");
        write(&plain, ".env", "");
        let d = detect_setup(&plain).await;
        assert_eq!((d["copyFiles"].clone(), d["setupCommand"].clone()), (json!([]), json!("")));
    }

    #[tokio::test]
    async fn detect_missing_redoes_unedited_guesses_only() {
        let t = tempfile::tempdir().unwrap();
        let repo = make_repo(t.path(), "r").await;
        write(&repo, "expo/package-lock.json", "");
        commit(&repo).await;
        write(&repo, "marketing-video/package-lock.json", "");
        let old = json!({ "at": "t", "copyFiles": [], "setupCommand": "(cd expo && npm ci) && (cd marketing-video && npm ci)", "setupFrom": [] });
        let path = repo.to_string_lossy().to_string();
        let profiles = parking_lot::Mutex::new(vec![
            json!({ "slug": "guessed", "path": path, "setupCommand": old["setupCommand"], "setupDetected": old }),
            json!({ "slug": "edited", "path": path, "setupCommand": "make deps", "setupDetected": old }),
            json!({ "slug": "fresh", "path": path }),
        ]);
        let saved = parking_lot::Mutex::new(Vec::<String>::new());
        let list = profiles.lock().clone();
        detect_missing(
            list,
            |slug| profiles.lock().iter().find(|p| p["slug"] == slug).cloned(),
            |p| {
                saved.lock().push(p["slug"].as_str().unwrap().to_string());
                let mut ps = profiles.lock();
                let i = ps.iter().position(|x| x["slug"] == p["slug"]).unwrap();
                ps[i] = p;
            },
        )
        .await;
        let mut got = saved.lock().clone();
        got.sort();
        assert_eq!(got, ["fresh", "guessed"]);
        let ps = profiles.lock().clone();
        assert_eq!(ps[0]["setupCommand"], "(cd expo && npm ci)");
        assert_eq!(ps[0]["setupDetected"]["setupCommand"], "(cd expo && npm ci)");
        assert_eq!(ps[1]["setupCommand"], "make deps");
        assert_eq!(ps[2]["setupCommand"], "(cd expo && npm ci)");
        assert_eq!(ps[2].as_object().unwrap().keys().collect::<Vec<_>>(), ["slug", "path", "copyFiles", "setupCommand", "setupDetected"]);
    }

    #[test]
    fn apply_detection_keeps_what_the_user_set() {
        let d = json!({ "at": "t", "copyFiles": [".env"], "setupCommand": "bun install", "setupFrom": ["bun.lock"] });
        let p = json!({ "slug": "p" });
        assert_eq!(apply_detection(&p, &d, false)["setupCommand"], "bun install");
        let made = json!({ "slug": "p", "setupCommand": "make" });
        assert_eq!(apply_detection(&made, &d, false)["setupCommand"], "make");
        assert_eq!(apply_detection(&made, &d, true)["setupCommand"], "bun install");
    }

    #[test]
    fn copies_paths_and_globs_inside_the_folder_only() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("from"), t.path().join("to"));
        write(&from, ".env", "A=1\n");
        write(&from, "web/.env.local", "B=2\n");
        write(&from, "web/.env.test", "C=3\n");
        write(&to, "tracked.env", "keep\n");
        write(&from, "tracked.env", "overwrite?\n");
        let pats: Vec<String> = [".env", "web/.env*", "missing.env", "../etc/passwd", "tracked.env"].iter().map(|x| x.to_string()).collect();
        let r = copy_setup_files(&from, &to, &pats);
        assert_eq!(r.copied, [".env", "web/.env.local", "web/.env.test"]);
        assert_eq!(r.missing, ["missing.env"]);
        assert_eq!(fs::read_to_string(to.join("web/.env.local")).unwrap(), "B=2\n");
        assert_eq!(fs::read_to_string(to.join("tracked.env")).unwrap(), "keep\n");
        write(&from, "apps/a/.env", "");
        write(&from, "apps/b/c/.env", "");
        let mut all = glob_files(&from, "**/.env");
        all.sort();
        assert_eq!(all, [".env", "apps/a/.env", "apps/b/c/.env"]);
        assert_eq!(glob_files(&from, "apps/{a,x}/.env"), ["apps/a/.env"]);
        assert_eq!(inside("./a/../b/"), Some("b".into()));
        assert_eq!(inside("../x"), None);
    }

    #[tokio::test]
    async fn run_shell_output_codes_and_timeout() {
        let t = tempfile::tempdir().unwrap();
        let ok = run_shell(t.path(), "echo out; echo err >&2", Limit::Silence(SETUP_SILENCE), Some("/bin/sh"), &[], None).await;
        assert!(ok.ok && ok.exit_code == Some(0) && ok.output.contains("out") && ok.output.contains("err"));
        let bad = run_shell(t.path(), "echo nope; exit 3", Limit::Silence(SETUP_SILENCE), Some("/bin/sh"), &[], None).await;
        assert_eq!((bad.ok, bad.exit_code), (false, Some(3)));
        let slow = run_shell(t.path(), "sleep 5", Limit::Total(Duration::from_millis(200)), Some("/bin/sh"), &[], None).await;
        assert!(!slow.ok && slow.timed_out && slow.duration_ms < 4900, "{slow:?}");
        let n = Arc::new(tokio::sync::Notify::new());
        n.notify_one();
        let stopped = run_shell(t.path(), "sleep 5", Limit::Silence(SETUP_SILENCE), Some("/bin/sh"), &[], Some(n)).await;
        assert!(stopped.output.ends_with("(stopped)"));
    }

    #[tokio::test]
    async fn the_silence_limit_counts_from_the_last_output() {
        let t = tempfile::tempdir().unwrap();
        // Quiet for less than the limit each time: runs to the end.
        let chatty = run_shell(t.path(), "echo a; sleep 0.4; echo b; sleep 0.4; echo c", Limit::Silence(Duration::from_millis(700)), Some("/bin/sh"), &[], None).await;
        assert!(chatty.ok && chatty.output == "a\nb\nc", "{chatty:?}");
        // Quiet too long: stopped, with the reason after its output.
        let quiet = run_shell(t.path(), "echo hi; sleep 30", Limit::Silence(Duration::from_millis(300)), Some("/bin/sh"), &[], None).await;
        assert!(!quiet.ok && quiet.timed_out && quiet.duration_ms < 5000, "{quiet:?}");
        // The shell may report its killed `sleep` ("Terminated: 15  sleep 30") before it dies itself.
        assert!(quiet.output.starts_with("hi\n") && quiet.output.ends_with("\n(stopped: no output for 300ms)"), "{quiet:?}");
        assert_eq!((span_text(SETUP_SILENCE), span_text(Duration::from_secs(90)), span_text(Duration::from_secs(1))), ("15 minutes".into(), "90 seconds".into(), "1 second".into()));
    }

    #[tokio::test]
    async fn a_background_child_holding_the_output_does_not_hold_the_caller() {
        let t = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let r = run_shell(t.path(), "sleep 30 & echo done", Limit::Silence(SETUP_SILENCE), Some("/bin/sh"), &[], None).await;
        assert!(r.ok && r.output == "done", "{r:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn prepare_worktree_copies_then_runs_and_keeps_40_lines() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("from"), t.path().join("to"));
        write(&from, ".env", "SECRET=1\n");
        fs::create_dir_all(&to).unwrap();
        let p = json!({ "copyFiles": [".env"], "setupCommand": "cat .env > seen.txt && seq 1 100" });
        let r = prepare_worktree(&from, &to, &p, Limit::Silence(SETUP_SILENCE), Some("/bin/sh"), &[], None).await.unwrap();
        assert_eq!(fs::read_to_string(to.join("seen.txt")).unwrap(), "SECRET=1\n");
        assert_eq!((r["copied"].clone(), r["ok"].clone(), r["exitCode"].clone()), (json!([".env"]), json!(true), json!(0)));
        let out = r["output"].as_str().unwrap();
        assert_eq!(out.split('\n').count(), 40);
        assert!(out.ends_with("100"));
        assert!(prepare_worktree(&from, &to, &json!({}), Limit::Silence(SETUP_SILENCE), None, &[], None).await.is_none());
        let failed = prepare_worktree(&from, &to, &json!({ "setupCommand": "echo boom; exit 1" }), Limit::Silence(SETUP_SILENCE), Some("/bin/sh"), &[], None).await.unwrap();
        assert_eq!((failed["ok"].clone(), failed["exitCode"].clone(), failed["output"].clone()), (json!(false), json!(1), json!("boom")));
        let block = setup_block(&json!({ "command": "x", "output": "</ckanban-setup>" }));
        assert!(!block[15..block.len() - 16].contains('<'));
        assert_eq!(parse_setup_block(&format!("out\n{}", setup_block(&failed))).unwrap(), failed);
        assert_eq!(with_board_text("p", "t", "Setup"), "p\n\n<ckanban-context note=\"Setup\">\nt\n</ckanban-context>");
    }
}
