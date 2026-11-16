//! Who is calling, for the user-only routes Rust answers itself: `userOnly` in `src/api/context.ts` with
//! `fromUserBrowser` from `src/integrations/guard.ts`. A board run, a check script or another program can't save a
//! key or change a pass: only a web browser that the board didn't start, and not one driven by a program.
//!
//! Bun looks up the process behind the caller's TCP port; here the caller connects to this server, so the same
//! lookup works directly. Every process this server started (the Bun daemon, and through it every board run) descends
//! from this process, so "not started by the board" is "not a descendant of this process". Anything that can't be
//! told counts as not the user (fail closed).

use std::collections::HashMap;
use std::sync::LazyLock;

use hyper::header::HeaderMap;
use regex::Regex;
use tokio::process::Command;

/// `RUN_HEADER` and `HUDDLE_HEADER` in `src/core/env.ts`: sent by board runs and huddle helpers.
const RUN_HEADER: &str = "x-ckanban-run";
const HUDDLE_HEADER: &str = "x-ckanban-huddle-agent";

/// `userOnly`'s refusal text.
pub fn refusal(what: &str) -> String {
    format!(
        "{what} is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board."
    )
}

/// `req.headers.get(name)` is a non-empty string (JS truthiness): every line of the header joined with ", ", as
/// Fetch reads it (two lines, the first empty, are ", x": truthy).
fn has(headers: &HeaderMap, name: &str) -> bool {
    ckanban_board::gate::request::has(headers, name)
}

/// The header checks `userOnly` makes before it looks at the caller: false refuses.
pub fn headers_allow(headers: &HeaderMap) -> bool {
    !has(headers, RUN_HEADER) && !has(headers, HUDDLE_HEADER) && has(headers, "origin")
}

/// `userOnly` on the board's own port: the headers, then the caller must be the user's own browser.
pub async fn user_only(headers: &HeaderMap, peer_port: u16) -> bool {
    headers_allow(headers) && from_user_browser(peer_port, std::process::id()).await
}

/// Runs a command and returns its stdout; "" when it fails.
async fn out(argv: &[&str]) -> String {
    match Command::new(argv[0]).args(&argv[1..]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output().await {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// `fromUserBrowser`: whether every process on the caller's end of `peer_port` is a browser this server didn't start
/// and no program drives.
pub async fn from_user_browser(peer_port: u16, own_pid: u32) -> bool {
    if peer_port == 0 {
        return false;
    }
    let addr = caller_lsof_addr(peer_port);
    let lsof = out(&["lsof", "-nP", &addr, "-sTCP:ESTABLISHED", "-Fp"]).await;
    let pids: Vec<u32> = lsof_pids(&lsof).into_iter().filter(|p| *p != own_pid).collect();
    if pids.is_empty() {
        return false;
    }
    let (parents, commands, args) = tokio::join!(out(&["ps", "-A", "-o", "pid=,ppid="]), out(&["ps", "-A", "-o", "pid=,comm="]), out(&["ps", "-A", "-o", "pid=,args="]));
    let (parents, commands, args) = (parent_map(&parents), command_map(&commands), command_map(&args));
    pids.iter().all(|p| {
        !descends_from(*p, own_pid, &parents) && is_browser(commands.get(p).map_or("", String::as_str)) && !driven_browser(*p, &parents, &args)
    })
}

/// `callerLsofArgs` in guard.ts: lsof's `-i` for the caller (it matches 127.0.0.1 on one end and the port on either
/// end, not one exact connection; an extra pid can only refuse). This server listens on
/// 127.0.0.1 only, so the caller's end is 127.0.0.1:<peer_port>. A bare `-iTCP:<port>` also matched any other socket on
/// the Mac with that port number (another address, or as its remote port), such as a desktop app's connection to the
/// internet: that pid isn't a browser, so the user's own browser was refused.
pub fn caller_lsof_addr(peer_port: u16) -> String {
    format!("-iTCP@127.0.0.1:{peer_port}")
}

/// Pids in `lsof -F` output (lines `p<pid>`).
pub fn lsof_pids(text: &str) -> Vec<u32> {
    text.lines().filter_map(|l| l.strip_prefix('p')).filter_map(|n| n.parse::<u32>().ok()).filter(|n| *n > 0).collect()
}

/// pid -> parent pid, from `ps -A -o pid=,ppid=`.
pub fn parent_map(ps: &str) -> HashMap<u32, u32> {
    let mut m = HashMap::new();
    for line in ps.lines() {
        let mut it = line.split_whitespace();
        if let (Some(Ok(pid)), Some(Ok(ppid))) = (it.next().map(str::parse::<u32>), it.next().map(str::parse::<u32>))
            && pid > 0
        {
            m.insert(pid, ppid);
        }
    }
    m
}

/// pid -> the rest of the line, from `ps -A -o pid=,comm=` (macOS prints the full path) or `pid=,args=`.
pub fn command_map(ps: &str) -> HashMap<u32, String> {
    let mut m = HashMap::new();
    for line in ps.lines() {
        let t = line.trim_start();
        let digits = t.find(|c: char| !c.is_ascii_digit()).unwrap_or(t.len());
        if digits == 0 {
            continue;
        }
        let rest = &t[digits..];
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let cmd = rest.trim();
        if let (Ok(pid), false) = (t[..digits].parse::<u32>(), cmd.is_empty()) {
            m.insert(pid, cmd.to_string());
        }
    }
    m
}

/// Whether `pid` is `ancestor` or one of its descendants.
pub fn descends_from(pid: u32, ancestor: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut p = pid;
    for _ in 0..200 {
        if p <= 1 {
            return false;
        }
        if p == ancestor {
            return true;
        }
        p = parents.get(&p).copied().unwrap_or(0);
    }
    false
}

/// `BROWSER` in guard.ts: the process that holds a browser's connections.
static BROWSER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/(Google Chrome|Google Chrome Helper|Chromium|Chromium Helper|Brave Browser|Brave Browser Helper|Microsoft Edge|Microsoft Edge Helper|Arc|Arc Helper|Vivaldi|Vivaldi Helper|Opera|Opera Helper|Orion|Firefox|firefox|plugin-container)(\.app)?(/|$)|com\.apple\.WebKit\.Networking").unwrap()
});
/// `DRIVEN` in guard.ts: a browser started to be driven by a program.
static DRIVEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]--(headless|remote-debugging-port|remote-debugging-pipe|enable-automation|marionette|remote-allow-origins)(?-u:\b)").unwrap()
});

pub fn is_browser(command: &str) -> bool {
    BROWSER.is_match(command)
}

/// Whether `pid` or any process above it runs as a driven browser.
pub fn driven_browser(pid: u32, parents: &HashMap<u32, u32>, args: &HashMap<u32, String>) -> bool {
    let mut p = pid;
    for _ in 0..200 {
        if p <= 1 {
            return false;
        }
        if DRIVEN.is_match(&format!(" {}", args.get(&p).map_or("", String::as_str))) {
            return true;
        }
        p = parents.get(&p).copied().unwrap_or(0);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(*k, HeaderValue::from_static(v));
        }
        m
    }

    #[test]
    fn runs_huddles_and_callers_without_origin_are_refused_by_headers() {
        let origin = ("origin", "http://localhost:7777");
        assert!(headers_allow(&h(&[origin])));
        assert!(!headers_allow(&h(&[])));
        assert!(!headers_allow(&h(&[("origin", "")])));
        assert!(!headers_allow(&h(&[origin, ("x-ckanban-run", "abc")])));
        assert!(!headers_allow(&h(&[origin, ("x-ckanban-huddle-agent", "1")])));
        // An empty run header is falsy in Bun too.
        assert!(headers_allow(&h(&[origin, ("x-ckanban-run", "")])));
        // Two lines, the first empty: Bun reads ", abc", a run.
        let mut two = h(&[origin]);
        two.append("x-ckanban-run", HeaderValue::from_static(""));
        two.append("x-ckanban-run", HeaderValue::from_static("abc"));
        assert!(!headers_allow(&two));
    }

    #[test]
    fn parses_ps_and_lsof_like_guard_ts() {
        assert_eq!(lsof_pids("p123\nf7\np456\nx\np0\n"), vec![123, 456]);
        // Only the caller's end on 127.0.0.1 (guard.test.ts checks lsof skips the same port number elsewhere).
        assert_eq!(caller_lsof_addr(51234), "-iTCP@127.0.0.1:51234");
        let parents = parent_map("  1 0\n 50 1\n 60 50\n 70 60\nbad line\n");
        assert_eq!(parents.get(&70), Some(&60));
        assert!(descends_from(70, 50, &parents));
        assert!(!descends_from(70, 99, &parents));
        assert!(!descends_from(1, 1, &parents));
        let cmds = command_map("  70 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 71 /bin/zsh\n");
        assert!(is_browser(&cmds[&70]));
        assert!(!is_browser(&cmds[&71]));
        assert!(is_browser("/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking"));
        assert!(!is_browser("/usr/local/bin/curl"));
        let args = command_map(" 60 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new\n 70 helper --type=renderer\n");
        assert!(driven_browser(70, &parents, &args));
        let calm = command_map(" 60 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --no-first-run\n");
        assert!(!driven_browser(70, &parents, &calm));
    }

    #[tokio::test]
    async fn this_test_process_is_not_the_users_browser() {
        // Port 1 has no established connection: nothing found, so not the user.
        assert!(!from_user_browser(1, std::process::id()).await);
        assert!(!from_user_browser(0, std::process::id()).await);
    }
}
