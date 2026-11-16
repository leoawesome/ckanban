//! The system routes of `src/api/system.ts` that board mode answers in Rust: `GET /api/health`, `GET /api/version`
//! (update.rs), `GET /api/claude/projects`, `GET /api/claude/defaults`, `POST /api/pick-folder`,
//! `GET /api/cron/preview` (until R10, `schedules::cron`) and `POST /api/debug/profile`. The answers are the JSON
//! values; the server sends them with Bun's `json()` (masked, `application/json`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use crate::runs::claude::{self, Dirs, FindClaude};
use crate::runs::model_versions::ModelVersions;

/// `GET /api/health`: whether `claude`, `git` and `gh` can be found, and whether terminals can start (a pty).
pub async fn health() -> Value {
    let path = std::env::var("PATH").unwrap_or_default();
    let claude = match std::env::var("CKANBAN_CLAUDE_BIN").ok().filter(|b| !b.is_empty()) {
        // `which(bin)` of a set binary: Bun.which, which takes a path too.
        Some(bin) => claude::which(&bin, &path).is_some(),
        None => claude::find_claude(FindClaude::default()).await.0,
    };
    let gh = claude::which("gh", &path).is_some();
    let git = tokio::task::spawn_blocking(git_usable).await.unwrap_or(false);
    // Terminals run on portable-pty in board mode: always there on macOS.
    json!({ "claude": claude, "git": git, "gh": gh, "pty": true })
}

static GIT_WORKS: AtomicBool = AtomicBool::new(false);

/// `gitUsable` (`src/runs/git.ts`): a new Mac has /usr/bin/git, but only as a placeholder until the Command Line Tools
/// are installed; `xcode-select -p` tells without the install dialog. Once it works it stays working.
pub fn git_usable() -> bool {
    if GIT_WORKS.load(Ordering::Relaxed) {
        return true;
    }
    let path = std::env::var("PATH").unwrap_or_default();
    let Some(bin) = claude::which("git", &path) else { return false };
    let ok = !cfg!(target_os = "macos")
        || bin != Path::new("/usr/bin/git")
        || std::env::var_os("DEVELOPER_DIR").is_some_and(|d| !d.is_empty())
        || std::process::Command::new("xcode-select")
            .arg("-p")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
    if ok {
        GIT_WORKS.store(true, Ordering::Relaxed);
    }
    ok
}

/// The folders boards point at (`store.listProfiles().map(p => p.path)`): a few small files.
pub fn board_paths(root: &Path) -> Vec<String> {
    let Ok(dir) = std::fs::read_dir(root.join("profiles")) else { return Vec::new() };
    dir.flatten()
        .filter_map(|e| std::fs::read_to_string(e.path().join("profile.json")).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter_map(|v| v.get("path").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// `GET /api/claude/projects`: folders Claude Code ran in, each with whether a board already uses it.
pub fn claude_projects(root: &Path) -> Value {
    let taken = board_paths(root);
    Value::Array(
        claude::list_claude_projects(&Dirs::default())
            .into_iter()
            .map(|p| {
                let mut v = p.to_json();
                let has = taken.contains(&p.path);
                if let Value::Object(m) = &mut v {
                    m.insert("hasProfile".into(), Value::Bool(has));
                }
                v
            })
            .collect(),
    )
}

/// `GET /api/claude/defaults`: the user's Claude Code model and effort, and the model versions runs taught the board.
pub fn claude_defaults(versions: &ModelVersions) -> Value {
    let (model, effort) = claude::claude_defaults(&Dirs::default());
    json!({ "model": model, "effort": effort, "versions": Value::Object(versions.learned()) })
}

/// `POST /api/pick-folder`: the Mac's folder chooser.
pub async fn pick_folder() -> Value {
    json!({ "path": claude::pick_folder().await })
}

static PROFILING: AtomicBool = AtomicBool::new(false);

/// `POST /api/debug/profile?seconds=N`: samples this process for N seconds (1 to 120, default 15) with macOS
/// `sample`, keeps the report in `<data>/debug/`, and gives the hottest functions. Bun took a V8 CPU profile of
/// itself; here the report is `sample`'s text and `totalMs` equals `selfMs` (it counts the top of each stack only).
/// Err is Bun's thrown message (a 500).
pub async fn profile(seconds_param: Option<&str>, root: &Path) -> Result<Value, String> {
    let n = seconds_param.map(crate::runs::js::number_of_str).unwrap_or(0.0);
    let seconds = if n.is_nan() || n == 0.0 { 15.0 } else { n }.clamp(1.0, 120.0);
    if PROFILING.swap(true, Ordering::SeqCst) {
        return Err("a profile is already being taken".into());
    }
    let r = take_profile(seconds, root.join("debug")).await;
    PROFILING.store(false, Ordering::SeqCst);
    r
}

async fn take_profile(seconds: f64, dir: PathBuf) -> Result<Value, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = ckanban_core::time::iso(ckanban_core::time::now_ms()).replace([':', '.'], "-");
    let file = dir.join(format!("daemon-{stamp}.sample.txt"));
    let secs = (seconds.round() as u64).max(1);
    let out = tokio::process::Command::new("/usr/bin/sample")
        .arg(std::process::id().to_string())
        .arg(secs.to_string())
        .arg("-file")
        .arg(&file)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("can't run sample: {e}"))?;
    if !out.status.success() {
        return Err(format!("sample failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(json!({ "file": file.to_string_lossy(), "hot": hottest(&text, secs as f64 * 1000.0, 30) }))
}

/// The "Sort by top of stack" part of a `sample` report as `HotFunction`s, most samples first.
pub fn hottest(report: &str, duration_ms: f64, top: usize) -> Vec<Value> {
    let mut rows: Vec<(String, String, u64)> = Vec::new();
    let mut inside = false;
    for line in report.lines() {
        if line.starts_with("Sort by top of stack") {
            inside = true;
            continue;
        }
        if !inside {
            continue;
        }
        let t = line.trim();
        if t.is_empty() {
            break;
        }
        // "        name  (in library)        123"
        let Some((head, count)) = t.rsplit_once(char::is_whitespace) else { continue };
        let Ok(count) = count.parse::<u64>() else { continue };
        let head = head.trim_end();
        let (name, lib) = match head.rfind("  (in ") {
            Some(i) => (head[..i].trim().to_string(), head[i + 6..].trim_end_matches(')').to_string()),
            None => (head.to_string(), "native".to_string()),
        };
        rows.push((name, lib, count));
    }
    let total: u64 = rows.iter().map(|r| r.2).sum();
    let per = if total > 0 { duration_ms / total as f64 } else { 0.0 };
    rows.sort_by(|a, b| b.2.cmp(&a.2));
    rows.into_iter()
        .take(top)
        .map(|(fun, lib, n)| {
            let ms = (n as f64 * per).round();
            json!({ "fn": fun, "where": lib, "selfMs": ms, "totalMs": ms })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_sample_report() {
        let report = "Call graph:\n  x\n\nSort by top of stack, same collapsed (when >= 5):\n        __sigsuspend  (in libsystem_kernel.dylib)        300\n        foo::bar  (in ckanban-rs)        100\n\nBinary Images:\n";
        let hot = hottest(report, 1000.0, 30);
        assert_eq!(hot.len(), 2);
        assert_eq!(hot[0]["fn"], "__sigsuspend");
        assert_eq!(hot[0]["where"], "libsystem_kernel.dylib");
        assert_eq!(hot[0]["selfMs"], 750.0);
        assert_eq!(hot[1]["fn"], "foo::bar");
        assert!(hottest("nothing", 1000.0, 30).is_empty());
    }

    #[test]
    fn board_paths_reads_profiles() {
        let dir = std::env::temp_dir().join(format!("ck-sys-{}-{}", std::process::id(), ckanban_core::time::now_ms() as u64));
        std::fs::create_dir_all(dir.join("profiles/a")).unwrap();
        std::fs::create_dir_all(dir.join("profiles/b")).unwrap();
        std::fs::write(dir.join("profiles/a/profile.json"), r#"{"path":"/x/a"}"#).unwrap();
        assert_eq!(board_paths(&dir), vec!["/x/a".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
