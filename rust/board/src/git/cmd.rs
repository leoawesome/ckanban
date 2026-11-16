//! Running `git`, `gh` and other commands as child processes (`run` and `which` in `src/runs/git.ts`). Every git call
//! stays a child process, as in Bun; none of it runs on a lock or blocks the runtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl RunResult {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    /// stdout without the surrounding white space (`.stdout.trim()`).
    pub fn out(&self) -> &str {
        self.stdout.trim()
    }
}

/// `run(cmd, cwd, env, timeoutMs)`: the command's exit code and output. A command that can't start is code -1 with the
/// reason in stderr; one killed after `timeout` is code -1 with "timed out after Ns" added to stderr.
pub async fn run(cmd: &[&str], cwd: &Path, env: &[(&str, &str)], timeout: Option<Duration>) -> RunResult {
    run_input(cmd, cwd, env, timeout, None).await
}

/// `run` with `input` written to the command's stdin (closed after it).
pub async fn run_input(cmd: &[&str], cwd: &Path, env: &[(&str, &str)], timeout: Option<Duration>, input: Option<&[u8]>) -> RunResult {
    let Some((bin, args)) = cmd.split_first() else {
        return RunResult { code: -1, stdout: String::new(), stderr: "no command".into() };
    };
    let mut c = Command::new(bin);
    c.args(args)
        .current_dir(cwd)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return RunResult { code: -1, stdout: String::new(), stderr: spawn_error(bin, cwd, &e) },
    };
    if let (Some(mut stdin), Some(bytes)) = (child.stdin.take(), input) {
        let bytes = bytes.to_vec();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(&bytes).await;
        });
    }
    let mut out = child.stdout.take().expect("piped");
    let mut err = child.stderr.take().expect("piped");
    let read_out = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b).await;
        b
    });
    let read_err = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b).await;
        b
    });
    let mut timed_out = false;
    let status = match timeout {
        Some(t) => match tokio::time::timeout(t, child.wait()).await {
            Ok(s) => s.ok(),
            Err(_) => {
                timed_out = true;
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        },
        None => child.wait().await.ok(),
    };
    let stdout = String::from_utf8_lossy(&read_out.await.unwrap_or_default()).into_owned();
    let mut stderr = String::from_utf8_lossy(&read_err.await.unwrap_or_default()).into_owned();
    if timed_out {
        let secs = timeout.map(|t| (t.as_millis() as f64 / 1000.0).round() as u64).unwrap_or(0);
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(&format!("timed out after {secs}s"));
        return RunResult { code: -1, stdout, stderr };
    }
    let code = status.map(exit_code).unwrap_or(-1);
    RunResult { code, stdout, stderr }
}

/// The exit code; a signal death is 128 + the signal, as a shell says it (callers only test for 0).
fn exit_code(s: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    s.code().unwrap_or_else(|| 128 + s.signal().unwrap_or(0))
}

fn spawn_error(bin: &str, cwd: &Path, e: &std::io::Error) -> String {
    // Bun: `Executable not found in $PATH: "x"` / `No such file or directory (os error 2)`; callers show the text only.
    if e.kind() == std::io::ErrorKind::NotFound && !cwd.is_dir() {
        return format!("No such file or directory: {}", cwd.display());
    }
    if e.kind() == std::io::ErrorKind::NotFound {
        return format!("Executable not found in $PATH: \"{bin}\"");
    }
    e.to_string()
}

/// `Bun.which(bin)`: the first executable file named `bin` on `PATH` (or `bin` itself when it has a slash).
pub fn which_path(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        return is_exec(Path::new(bin)).then(|| PathBuf::from(bin));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(bin)).find(|p| is_exec(p))
}

fn is_exec(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// `gitRuns`: whether the `git` at `bin` can run. A new Mac has /usr/bin/git, but it is only a placeholder until the
/// Command Line Tools are installed (every call pops up the "install developer tools" dialog); `xcode-select -p` tells.
pub fn git_runs(bin: Option<&Path>, has_developer_tools: impl FnOnce() -> bool, darwin: bool, developer_dir_set: bool) -> bool {
    let Some(bin) = bin else { return false };
    !darwin || bin != Path::new("/usr/bin/git") || developer_dir_set || has_developer_tools()
}

static GIT_WORKS: AtomicBool = AtomicBool::new(false);

/// `gitUsable`: `git_runs` for this computer. Once git works it stays working, so only a "no" is checked again.
/// Blocking (a `which` and maybe `xcode-select -p`): call it off the runtime, or through `which`.
pub fn git_usable() -> bool {
    if GIT_WORKS.load(Ordering::Relaxed) {
        return true;
    }
    let ok = git_runs(
        which_path("git").as_deref(),
        || {
            std::process::Command::new("xcode-select")
                .arg("-p")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        },
        cfg!(target_os = "macos"),
        std::env::var_os("DEVELOPER_DIR").is_some_and(|v| !v.is_empty()),
    );
    if ok {
        GIT_WORKS.store(true, Ordering::Relaxed);
    }
    ok
}

/// `which(bin)`: git counts only when it can run (`git_usable`).
pub async fn which(bin: &str) -> bool {
    let bin = bin.to_string();
    tokio::task::spawn_blocking(move || if bin == "git" { git_usable() } else { which_path(&bin).is_some() }).await.unwrap_or(false)
}

/// The environment of the daemon as a map, for commands that add to it.
pub fn env_with(extra: &[(&str, &str)]) -> HashMap<String, String> {
    let mut m: HashMap<String, String> = std::env::vars().collect();
    for (k, v) in extra {
        m.insert(k.to_string(), v.to_string());
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_a_command_and_reports_code_and_output() {
        let d = tempfile::tempdir().unwrap();
        let r = run(&["sh", "-c", "echo out; echo err >&2; exit 3"], d.path(), &[], None).await;
        assert_eq!(r, RunResult { code: 3, stdout: "out\n".into(), stderr: "err\n".into() });
        let r = run(&["sh", "-c", "printf %s \"$X\""], d.path(), &[("X", "y")], None).await;
        assert_eq!(r.stdout, "y");
    }

    #[tokio::test]
    async fn a_missing_command_or_a_timeout_is_code_minus_one() {
        let d = tempfile::tempdir().unwrap();
        let r = run(&["no-such-command-ckanban"], d.path(), &[], None).await;
        assert_eq!(r.code, -1);
        assert!(r.stderr.contains("not found"), "{}", r.stderr);
        let r = run(&["sh", "-c", "echo partial >&2; sleep 5"], d.path(), &[], Some(Duration::from_millis(200))).await;
        assert_eq!(r.code, -1);
        assert_eq!(r.stderr, "partial\ntimed out after 0s");
    }

    #[tokio::test]
    async fn writes_input_to_stdin() {
        let d = tempfile::tempdir().unwrap();
        let r = run_input(&["cat"], d.path(), &[], None, Some(b"a\0b")).await;
        assert_eq!(r.stdout, "a\0b");
    }

    #[test]
    fn git_runs_rules() {
        let usr = Path::new("/usr/bin/git");
        let brew = Path::new("/opt/homebrew/bin/git");
        assert!(!git_runs(None, || true, true, false));
        assert!(git_runs(Some(brew), || false, true, false));
        assert!(!git_runs(Some(usr), || false, true, false));
        assert!(git_runs(Some(usr), || true, true, false));
        assert!(git_runs(Some(usr), || false, true, true));
        assert!(git_runs(Some(usr), || false, false, false));
    }
}
