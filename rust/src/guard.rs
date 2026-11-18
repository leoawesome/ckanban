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

/// The header Tailscale fills with the visitor's tailnet address; `tailscale serve` replaces any copy the client sent.
const FORWARDED_FOR: &str = "x-forwarded-for";

/// `userOnly` on the phone access port: the headers, then the request really came through `tailscale serve` from
/// another device (the owner's phone). Fails closed: anything that can't be told counts as not the user.
pub async fn phone_user(headers: &HeaderMap, peer_port: u16, remote_port: u16) -> bool {
    headers_allow(headers) && from_phone(headers, peer_port, remote_port).await
}

/// Whether a phone-port request came through Tailscale from another device, in three steps:
/// - The caller's end of the TCP connection belongs to Tailscale's own forwarder: a root process that is the standalone
///   app's system extension or the open-source `tailscaled`. A board run, a shell, curl or a script runs as this user,
///   and other system users this user can steer (such as the printing system) run other programs, so calling the port
///   directly with forged headers is refused. `lsof` run as this user can't see a root process's sockets, so the owner
///   comes from `netstat -anv`, which lists every socket's pid. (The Mac App Store app's extension runs as the user:
///   there the phone can still read the board but not do user-only actions.)
/// - Tailscale's settings forward no raw TCP port at all (`tailscale serve --tcp`): through a forward to the phone port
///   Tailscale's forwarder carries whatever a program on this Mac sends, X-Forwarded-For included. Not airtight: a
///   program that adds a forward, connects and removes it before asking is not seen (an open forwarded connection
///   outlives the forward); a board run that goes that far could change the board's data files directly anyway.
/// - The visitor's address (`X-Forwarded-For`, set by Tailscale's HTTPS proxy, which replaces any copy the client
///   sent) is not one of this Mac's own. A request from this Mac to its own tailnet name goes through Tailscale too
///   and carries the owner's login, so a board run could pass that way; the user's own browser on this Mac uses
///   localhost instead.
///
/// Each step runs a system tool (netstat, ps, tailscale: about 50 ms together), which is fine for user-only actions,
/// which are rare; nothing is kept between requests.
pub async fn from_phone(headers: &HeaderMap, peer_port: u16, remote_port: u16) -> bool {
    if peer_port == 0 || remote_port == 0 {
        return false;
    }
    let refuse = |why: &str| {
        eprintln!("ckanban-rs: phone access: refused a user-only request: {why}");
        false
    };
    // netstat lists every TCP socket on the Mac (a few hundred rows): fine for rare user-only actions.
    let netstat = out(&[NETSTAT, "-anv", "-p", "tcp"]).await;
    let pids = netstat_caller_pids(&netstat, peer_port, remote_port);
    if pids.is_empty() {
        return refuse("its caller isn't Tailscale's forwarder (no socket found)");
    }
    // SAFETY: getuid has no preconditions and can't fail.
    let me = unsafe { libc::getuid() };
    let forwarder = std::env::var(FORWARDER_UID_ENV).ok().filter(|f| !f.trim().is_empty());
    // A socket has one owner in netstat; every row found must be the forwarder's.
    for pid in &pids {
        let line = out(&[PS, "-o", "uid=,comm=", "-p", &pid.to_string()]).await;
        if !is_forwarder(&line, me, forwarder.as_deref()) {
            return refuse("its caller is a program on this Mac, not Tailscale's forwarder");
        }
    }
    // The tests' stand-in forwarder has no Tailscale settings to read.
    if forwarder.is_none() {
        let status = match crate::outside::phone::tailscale_serve_status().await {
            Some(s) => s,
            None => return refuse("Tailscale's settings couldn't be read"),
        };
        if !serve_has_no_tcp_forward(&status) {
            return refuse("Tailscale's settings forward a raw TCP port (tailscale serve --tcp), which could reach the phone port");
        }
    }
    let Some(visitor) = forwarded_for(headers) else {
        return refuse("no visitor address from Tailscale");
    };
    if visitor.is_loopback() || visitor.is_unspecified() || own_addrs().contains(&visitor) {
        return refuse("it came from this Mac itself, not the phone");
    }
    true
}

/// Whether a `ps -o uid=,comm=` line (uid, then the program's path) is Tailscale's forwarder: a root process that is the
/// standalone app's system extension (`/Library/SystemExtensions/.../io.tailscale.ipn.*`, only root installs there) or
/// `tailscaled`. With `CKANBAN_PHONE_FORWARDER_UID` set (contract tests), exactly that uid, any program.
pub fn is_forwarder(ps_line: &str, me: u32, forwarder: Option<&str>) -> bool {
    let line = ps_line.trim();
    let (uid, comm) = line.split_once(char::is_whitespace).map_or((line, ""), |(u, c)| (u, c.trim()));
    let Ok(uid) = uid.parse::<u32>() else { return false };
    if let Some(f) = forwarder {
        return f.trim().parse::<u32>().is_ok_and(|f| f == uid);
    }
    if uid != 0 || uid == me {
        return false;
    }
    let name = comm.rsplit('/').next().unwrap_or("");
    (comm.starts_with("/Library/SystemExtensions/") && name.starts_with("io.tailscale.ipn.")) || name == "tailscaled"
}

/// Whether `tailscale serve status --json` has no raw TCP forward (`TCPForward`, plain or TLS-terminated) at all, in
/// any part of the settings (background, foreground, services). Any forward counts, not only one to the phone port:
/// Tailscale accepts a port written many ways (`07778`, a service name from /etc/services), and the board's own
/// settings never use one. The text must be JSON (an object or null).
pub fn serve_has_no_tcp_forward(status: &str) -> bool {
    fn any_forward(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Object(m) => m.iter().any(|(k, v)| k == "TCPForward" || any_forward(v)),
            serde_json::Value::Array(a) => a.iter().any(any_forward),
            _ => false,
        }
    }
    let status = status.trim();
    let parsed = if status.is_empty() { None } else { serde_json::from_str::<serde_json::Value>(status).ok() };
    match parsed {
        Some(v @ (serde_json::Value::Object(_) | serde_json::Value::Null)) => !any_forward(&v),
        _ => false,
    }
}

/// Contract tests only: the macOS user id whose programs count as Tailscale's forwarder on the phone port (the tests
/// call it from their own process, which runs as this user), and the Tailscale settings check is skipped. Unset or
/// empty, as on every real Mac: only Tailscale's root forwarder. Read from the daemon's own environment, which a board
/// run can't change.
pub const FORWARDER_UID_ENV: &str = "CKANBAN_PHONE_FORWARDER_UID";

/// The pids on the caller's end of 127.0.0.1:<peer_port> -> 127.0.0.1:<remote_port>, from `netstat -anv -p tcp`
/// (macOS). The pid column is found by its header name, as macOS versions add columns. Empty when none is found.
pub fn netstat_caller_pids(text: &str, peer_port: u16, remote_port: u16) -> Vec<u32> {
    let mut lines = text.lines();
    // "Local Address" and "Foreign Address" are two words each in the header, one in a row.
    let Some(col) = lines.by_ref().find(|l| l.starts_with("Proto")).and_then(|h| h.split_whitespace().position(|w| w == "pid")).and_then(|i| i.checked_sub(2)) else {
        return Vec::new();
    };
    let (local, foreign) = (format!("127.0.0.1.{peer_port}"), format!("127.0.0.1.{remote_port}"));
    lines
        .map(|l| l.split_whitespace().collect::<Vec<_>>())
        .filter(|w| w.len() > col && w[0].starts_with("tcp") && w[3] == local && w[4] == foreign && w[5] == "ESTABLISHED")
        .filter_map(|w| w[col].parse::<u32>().ok())
        .filter(|p| *p > 0)
        .collect()
}

/// The visitor's address in `X-Forwarded-For`: exactly one address (Tailscale sends one), else None.
pub fn forwarded_for(headers: &HeaderMap) -> Option<std::net::IpAddr> {
    let mut it = headers.get_all(FORWARDED_FOR).iter();
    let one = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let ip: std::net::IpAddr = one.to_str().ok()?.trim().parse().ok()?;
    Some(ip.to_canonical())
}

/// Every address on this Mac's network interfaces (the Tailscale one included).
fn own_addrs() -> Vec<std::net::IpAddr> {
    let mut addrs = Vec::new();
    let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills a list we only read and then free with freeifaddrs.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            return addrs;
        }
        let mut cur = head;
        while !cur.is_null() {
            let sa = (*cur).ifa_addr;
            if !sa.is_null() {
                match (*sa).sa_family as i32 {
                    libc::AF_INET => {
                        let a = &*(sa as *const libc::sockaddr_in);
                        addrs.push(std::net::IpAddr::V4(std::net::Ipv4Addr::from(u32::from_be(a.sin_addr.s_addr))));
                    }
                    libc::AF_INET6 => {
                        let a = &*(sa as *const libc::sockaddr_in6);
                        addrs.push(std::net::IpAddr::V6(std::net::Ipv6Addr::from(a.sin6_addr.s6_addr)).to_canonical());
                    }
                    _ => {}
                }
            }
            cur = (*cur).ifa_next;
        }
        libc::freeifaddrs(head);
    }
    addrs
}

/// The system tools the caller checks run, by full path: the daemon's PATH starts with folders a board run can write
/// (~/.local/bin, /opt/homebrew/bin), where a fake `ps` could vouch for any caller.
const NETSTAT: &str = "/usr/sbin/netstat";
const PS: &str = "/bin/ps";
const LSOF: &str = "/usr/sbin/lsof";

/// How long one of those tools may take before the check gives up and refuses.
const TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Runs a command and returns its stdout; "" when it fails or takes longer than `TOOL_TIMEOUT` (it is killed then).
async fn out(argv: &[&str]) -> String {
    let run = Command::new(argv[0]).args(&argv[1..]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).output();
    match tokio::time::timeout(TOOL_TIMEOUT, run).await {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => String::new(),
    }
}

/// `fromUserBrowser`: whether every process on the caller's end of `peer_port` is a browser this server didn't start
/// and no program drives.
pub async fn from_user_browser(peer_port: u16, own_pid: u32) -> bool {
    if peer_port == 0 {
        return false;
    }
    let addr = caller_lsof_addr(peer_port);
    let lsof = out(&[LSOF, "-nP", &addr, "-sTCP:ESTABLISHED", "-Fp"]).await;
    let pids: Vec<u32> = lsof_pids(&lsof).into_iter().filter(|p| *p != own_pid).collect();
    if pids.is_empty() {
        return false;
    }
    let (parents, commands, args) = tokio::join!(out(&[PS, "-A", "-o", "pid=,ppid="]), out(&[PS, "-A", "-o", "pid=,comm="]), out(&[PS, "-A", "-o", "pid=,args="]));
    let (parents, commands, args) = (parent_map(&parents), command_map(&commands), command_map(&args));
    pids.iter().all(|p| {
        !descends_from(*p, own_pid, &parents) && is_browser(commands.get(p).map_or("", String::as_str)) && !driven_browser(*p, &parents, &args)
    })
}

/// `outsideBoard`: whether every process on the caller's end of `peer_port` is a program this server didn't start (the
/// user's own Claude or terminal, a browser): not a board run, its shell, a job's command or the satellite. Nothing
/// found counts as the board's. Like `from_user_browser` it can't see a process a run detached from the server.
pub async fn outside_board(peer_port: u16, own_pid: u32) -> bool {
    if peer_port == 0 {
        return false;
    }
    let addr = caller_lsof_addr(peer_port);
    let lsof = out(&[LSOF, "-nP", &addr, "-sTCP:ESTABLISHED", "-Fp"]).await;
    let pids: Vec<u32> = lsof_pids(&lsof).into_iter().filter(|p| *p != own_pid).collect();
    if pids.is_empty() {
        return false;
    }
    let parents = parent_map(&out(&[PS, "-A", "-o", "pid=,ppid="]).await);
    pids.iter().all(|p| !descends_from(*p, own_pid, &parents))
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

    const NETSTAT_SAMPLE: &str = "Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat    pid   epid state  options           gencnt    flags   flags1 usecnt rtncnt fltrs
tcp4       0      0  127.0.0.1.7778         127.0.0.1.64526        ESTABLISHED        28312        14416  394880  146988   8733      0 00102 00000004 00000000024cdd35 00000081 01000900      2      0 000000
tcp4       0      0  127.0.0.1.64526        127.0.0.1.7778         ESTABLISHED        29560        13792  394240  146988  84444      0 00182 00000008 00000000024cdd34 00000080 04000900      2      0 000000
tcp4       0      0  127.0.0.1.64527        127.0.0.1.7777         ESTABLISHED        29560        13792  394240  146988    555      0 00182 00000008 00000000024cdd34 00000080 04000900      2      0 000000
tcp4       0      0  127.0.0.1.64000        127.0.0.1.7778         TIME_WAIT          59044        13631  379520  146988  84444      0 021b1 00000008 00000000024cb45f 00000080 04000900      0      0 000000
tcp4       0      0  127.0.0.1.7778         *.*                    LISTEN                 0            0  131072  131072   8733      0 00100 00000006 00000000024b6dd4 00000001 00000900      1      0 000000
";

    #[test]
    fn netstat_gives_the_pid_on_the_callers_end_only() {
        assert_eq!(netstat_caller_pids(NETSTAT_SAMPLE, 64526, 7778), vec![84444]);
        // Another server port, a closed connection and an unknown port find nothing.
        assert!(netstat_caller_pids(NETSTAT_SAMPLE, 64527, 7778).is_empty());
        assert!(netstat_caller_pids(NETSTAT_SAMPLE, 64000, 7778).is_empty());
        assert!(netstat_caller_pids(NETSTAT_SAMPLE, 1, 7778).is_empty());
        // No header with a pid column: nothing (fail closed).
        assert!(netstat_caller_pids("tcp4 0 0 127.0.0.1.64526 127.0.0.1.7778 ESTABLISHED 1 2 3 4 84444", 64526, 7778).is_empty());
        assert!(netstat_caller_pids("", 64526, 7778).is_empty());
    }

    #[test]
    fn only_tailscales_root_program_is_the_forwarder() {
        let ext = "    0 /Library/SystemExtensions/3635F8D3/io.tailscale.ipn.macsys.network-extension.systemextension/Contents/MacOS/io.tailscale.ipn.macsys.network-extension";
        assert!(is_forwarder(ext, 501, None));
        assert!(is_forwarder("0 /usr/local/bin/tailscaled", 501, None));
        // This user, another system user (the printing system), another root program, a look-alike path: refused.
        assert!(!is_forwarder(&ext.replacen("    0", "  501", 1), 501, None));
        assert!(!is_forwarder("26 /usr/libexec/cups/backend/socket", 501, None));
        assert!(!is_forwarder("26 /usr/local/bin/tailscaled", 501, None));
        assert!(!is_forwarder("0 /usr/libexec/cups/backend/socket", 501, None));
        assert!(!is_forwarder("0 /tmp/io.tailscale.ipn.macsys.network-extension", 501, None));
        assert!(!is_forwarder("0 /usr/local/bin/tailscaled-not", 501, None));
        assert!(!is_forwarder("", 501, None));
        assert!(!is_forwarder("x /usr/local/bin/tailscaled", 501, None));
        // A daemon running as root never trusts its own uid.
        assert!(!is_forwarder("0 /usr/local/bin/tailscaled", 0, None));
        // The tests' stand-in: exactly that uid, any program; a value that isn't a number lets no one in.
        assert!(is_forwarder("501 /bin/bun", 501, Some("501")));
        assert!(!is_forwarder(ext, 501, Some("501")));
        assert!(!is_forwarder("0 /usr/local/bin/tailscaled", 501, Some("root")));
    }

    #[test]
    fn any_raw_tcp_forward_anywhere_in_the_settings_refuses() {
        let board = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7778"}}}}}"#;
        assert!(serve_has_no_tcp_forward(board));
        assert!(serve_has_no_tcp_forward("null"));
        assert!(serve_has_no_tcp_forward("{}"));
        for forward in ["127.0.0.1:7778", "127.0.0.1:07778", "127.0.0.1:interwise", "localhost:7778", "[::1]:7778", "127.0.0.1:7799"] {
            let status = format!(r#"{{"TCP":{{"18443":{{"TCPForward":"{forward}"}}}}}}"#);
            assert!(!serve_has_no_tcp_forward(&status), "{forward}");
        }
        assert!(!serve_has_no_tcp_forward(r#"{"TCP":{"1":{"TCPForward":"localhost:7778","TerminateTLS":"mac.tail.ts.net"}}}"#));
        assert!(!serve_has_no_tcp_forward(r#"{"Foreground":{"abc":{"TCP":{"1":{"TCPForward":"127.0.0.1:7778"}}}}}"#));
        assert!(!serve_has_no_tcp_forward(r#"{"Services":{"svc:x":{"TCP":{"1":{"TCPForward":"[::1]:7778"}}}}}"#));
        // Unreadable settings refuse.
        assert!(!serve_has_no_tcp_forward(""));
        assert!(!serve_has_no_tcp_forward("not json"));
        assert!(!serve_has_no_tcp_forward("[]"));
    }

    #[test]
    fn the_visitor_address_is_one_address_or_nothing() {
        assert_eq!(forwarded_for(&h(&[("x-forwarded-for", "100.64.1.2")])), Some("100.64.1.2".parse().unwrap()));
        assert_eq!(forwarded_for(&h(&[("x-forwarded-for", " fd7a:115c:a1e0::1 ")])), Some("fd7a:115c:a1e0::1".parse().unwrap()));
        assert_eq!(forwarded_for(&h(&[("x-forwarded-for", "::ffff:100.64.1.2")])), Some("100.64.1.2".parse().unwrap()));
        assert_eq!(forwarded_for(&h(&[])), None);
        assert_eq!(forwarded_for(&h(&[("x-forwarded-for", "100.64.1.2, 100.64.1.3")])), None);
        assert_eq!(forwarded_for(&h(&[("x-forwarded-for", "nope")])), None);
        let mut two = HeaderMap::new();
        two.append("x-forwarded-for", HeaderValue::from_static("100.64.1.2"));
        two.append("x-forwarded-for", HeaderValue::from_static("100.64.1.3"));
        assert_eq!(forwarded_for(&two), None);
    }

    #[test]
    fn this_macs_loopback_is_among_its_own_addresses() {
        assert!(own_addrs().contains(&"127.0.0.1".parse().unwrap()));
    }

    #[tokio::test]
    async fn a_program_of_this_user_calling_the_phone_port_is_not_the_phone() {
        // A real connection from this test (this user) to a listener: the caller is found and refused.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let c = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (_s, peer) = l.accept().await.unwrap();
        assert_eq!(peer.port(), c.local_addr().unwrap().port());
        let pids = netstat_caller_pids(&out(&[NETSTAT, "-anv", "-p", "tcp"]).await, peer.port(), port);
        assert_eq!(pids, vec![std::process::id()]);
        let forged = h(&[("origin", "https://mac.tail.ts.net"), ("x-forwarded-for", "100.64.1.2")]);
        assert!(!phone_user(&forged, peer.port(), port).await);
        assert!(!phone_user(&forged, 0, port).await);
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
