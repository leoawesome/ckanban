//! `ckanban install`, `restart`, `uninstall` and `open` (`src/cli/cli.ts`, `src/cli/launchd.ts`,
//! `src/cli/uninstall-extras.ts`): the launchd job `io.ckanban.daemon`, its plist byte for byte as Bun writes it.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;

use super::agents::{Agent, Registry};
use super::{board_port, home, out};

pub const LABEL: &str = "io.ckanban.daemon";
/// How long the daemon may take to restart once its runs end (`RESTART_MAX_WAIT_MS` in `src/board/board.ts`), in min.
const RESTART_MAX_WAIT_MIN: u32 = 2;
/// Each uninstall step's limit (`STEP_LIMIT_MS`).
const STEP_LIMIT: Duration = Duration::from_secs(15);

fn plist_path() -> PathBuf {
    PathBuf::from(home()).join("Library").join("LaunchAgents").join(format!("{LABEL}.plist"))
}

fn uid() -> u32 {
    // SAFETY: getuid(2) can't fail.
    unsafe { libc::getuid() }
}

fn domain() -> String {
    format!("gui/{}", uid())
}

fn target() -> String {
    format!("{}/{LABEL}", domain())
}

fn board_url() -> String {
    format!("http://localhost:{}", board_port())
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `plistXml`: `program_args` is [binary] for a built CLI; "start" is appended.
pub fn plist_xml(program_args: &[String], path: &str, log_file: &str, home: &str) -> String {
    let args: Vec<String> = program_args.iter().map(|a| format!("    <string>{}</string>", esc(a))).collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{}
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{}</string>
    <key>HOME</key>
    <string>{}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{}</string>
  <key>StandardErrorPath</key>
  <string>{}</string>
</dict>
</plist>
"#,
        args.join("\n"),
        esc(path),
        esc(home),
        esc(log_file),
        esc(log_file)
    )
}

/// Runs a command with its output dropped; its exit code (1 when it can't start).
fn quiet(cmd: &str, args: &[&str]) -> i32 {
    code_of(Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status())
}

/// Runs a command with its output shown; its exit code.
fn sh(cmd: &str, args: &[&str]) -> i32 {
    code_of(Command::new(cmd).args(args).status())
}

fn code_of(s: std::io::Result<std::process::ExitStatus>) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    match s {
        Ok(s) => s.code().or_else(|| s.signal().map(|x| 128 + x)).unwrap_or(1),
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn exit(code: i32) -> u8 {
    (code & 0xff) as u8
}

pub fn install() -> u8 {
    let root = crate::settings::data_root();
    let plist = plist_path();
    for d in [root.as_path(), plist.parent().unwrap_or(Path::new("/"))] {
        if let Err(e) = std::fs::create_dir_all(d) {
            eprintln!("{e}");
            return 1;
        }
    }
    // Common tool locations first-class, so the daemon finds claude/git/gh even from a minimal shell.
    let h = home();
    let extra = [format!("{h}/.local/bin"), format!("{h}/.bun/bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/usr/bin".into(), "/bin".into()];
    let mut dirs: Vec<String> = Vec::new();
    let path = std::env::var("PATH").unwrap_or_default();
    for d in path.split(':').filter(|d| !d.is_empty()).map(str::to_string).chain(extra) {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let log = root.join("daemon.log").to_string_lossy().into_owned();
    if let Err(e) = std::fs::write(&plist, plist_xml(&[exe], &dirs.join(":"), &log, &h)) {
        eprintln!("{e}");
        return 1;
    }
    let plist_s = plist.to_string_lossy().into_owned();
    quiet("launchctl", &["bootout", &target()]);
    // bootout returns before the old job is gone; bootstrap fails until it is.
    for _ in 0..50 {
        if quiet("launchctl", &["print", &target()]) != 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let mut code = 1;
    for _ in 0..5 {
        code = quiet("launchctl", &["bootstrap", &domain(), &plist_s]);
        if code == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if code != 0 {
        eprintln!("launchctl bootstrap failed");
        return exit(code);
    }
    out(&format!("Installed {plist_s}\nBoard: {}\nLogs: {log}", board_url()));
    0
}

/// Asks the daemon to restart once no run is active: how many runs it waits for, or None when it can't be asked.
fn graceful_restart() -> Option<u32> {
    let port = board_port();
    let headers = [("content-type".to_string(), "application/json".to_string())];
    let res = super::http::send(port, &format!("localhost:{port}"), "POST", "/api/restart", &headers, Some("{}".into()), Some(Duration::from_secs(5)))?;
    if !(200..300).contains(&res.status) {
        return None;
    }
    let v: Value = serde_json::from_slice(&res.body).ok()?;
    // Number(running) || 0
    let n = match v.get("running") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => super::args::js_number(s),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    };
    Some(if n.is_finite() && n > 0.0 { n as u32 } else { 0 })
}

pub fn restart(now: bool) -> u8 {
    if quiet("launchctl", &["print", &target()]) != 0 {
        eprintln!("daemon not installed; run: ckanban install");
        return 1;
    }
    let waiting = if now { None } else { graceful_restart() };
    match waiting {
        None => {
            let code = sh("launchctl", &["kickstart", "-k", &target()]);
            if code != 0 {
                return exit(code);
            }
            out(&format!("Restarted. Board: {}", board_url()));
        }
        Some(0) => out(&format!("Restarting. Board: {}", board_url())),
        Some(n) => out(&format!(
            "Restart pending: waiting for {n} active run{} to finish (at most {RESTART_MAX_WAIT_MIN} min).\nNew runs, huddle wakes and Planning interviews start after the restart; your chat messages are answered as usual. Use `ckanban restart --now` to restart at once.",
            if n == 1 { "" } else { "s" }
        )),
    }
    0
}

pub fn open() -> u8 {
    sh("open", &[&board_url()]);
    0
}

/// Phone access is on (`RemoteAccess.active()`): remote.json enabled with a host and a login.
fn remote_active() -> bool {
    let file = crate::settings::data_root().join("remote.json");
    let Ok(v) = std::fs::read_to_string(file).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) else { return false };
    let s = |k: &str| v.get(k).and_then(Value::as_str).is_some_and(|x| !x.is_empty());
    v.get("enabled") == Some(&Value::Bool(true)) && s("host") && s("allowedLogin")
}

/// Turning phone access off drives Tailscale, which stays on Bun: `ckanban remote off` through Bun, within the step
/// limit. The reason when it didn't work.
fn remote_off() -> Option<String> {
    let mut cmd = match super::bun_command(&["remote".into(), "off".into()]) {
        Ok(c) => c,
        Err(e) => return Some(e),
    };
    let child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => return Some(e.to_string()),
    };
    let mut se = child.stderr.take().expect("piped");
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = std::io::Read::read_to_end(&mut se, &mut b);
        String::from_utf8_lossy(&b).into_owned()
    });
    let deadline = std::time::Instant::now() + STEP_LIMIT;
    let status = loop {
        if let Ok(Some(s)) = child.try_wait() {
            break s;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Some(format!("no answer after {} seconds", STEP_LIMIT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let err = reader.join().unwrap_or_default();
    let first = |s: &str| s.lines().next().unwrap_or("").to_string();
    if !status.success() {
        return Some(first(err.trim()));
    }
    err.lines().find_map(|l| l.strip_prefix("Warning: ")).map(first)
}

/// `ckanban uninstall`: phone access off, the MCP removed from Claude Code and Codex, the launchd job and its plist
/// gone. Each failing step is one line on stderr; the exit is always 0. Board data stays.
pub fn uninstall() -> u8 {
    if remote_active() {
        if let Some(why) = remote_off() {
            eprintln!("Couldn't turn off phone access ({why}); run \"ckanban remote off\" later.");
        }
    }
    let reg = Registry::new();
    for s in reg.status() {
        // Not registered, or Claude Code isn't installed (nothing to remove it with): fine.
        if !s.installed || (s.agent == Agent::Claude && !s.available) {
            continue;
        }
        if let Err(e) = reg.uninstall(s.agent, STEP_LIMIT) {
            let why = e.split('\n').next().unwrap_or("");
            eprintln!("Couldn't remove ckanban from {} ({why}); run \"ckanban mcp uninstall --{}\" later.", s.agent.label(), s.agent.id());
        }
    }
    sh("launchctl", &["bootout", &target()]);
    let _ = std::fs::remove_file(plist_path());
    out("Uninstalled ckanban daemon");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_escapes_values() {
        let x = plist_xml(&["/a&b/ck".into()], "/x<y>", "/l.log", "/h");
        assert!(x.contains("    <string>/a&amp;b/ck</string>\n    <string>start</string>"));
        assert!(x.contains("<string>/x&lt;y&gt;</string>"));
        assert!(x.ends_with("</plist>\n"));
    }
}
