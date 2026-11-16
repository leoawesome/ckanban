//! The request gate of `src/api/server.ts` and `src/api/context.ts`: which listener a request came in on, whether its
//! Host and Origin may reach the board (`requestRefusal`, `isAllowedSocket`), the JSON-only rule for changes, and the
//! "this Mac only" check of `POST /api/debug/profile`. Pure functions over header text; the server reads the headers
//! (`header_text`) and `remote.json` (`remote::RemoteFile`) and passes them in. Checked against Bun's own functions
//! on a shared table (`tests/fixtures/gate.json`, written by `test/rust-board-gate-fixtures.test.ts`).

use hyper::header::{HeaderMap, HeaderName};

use crate::runs::js;

/// `LOCAL_HOSTS` in `src/api/context.ts`.
pub const LOCAL_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];
/// `LISTENER_HEADER` in `src/integrations/remote.ts`: on every answer of the phone access listener.
pub const LISTENER_HEADER: &str = "x-ckanban-listener";
/// `LOGIN_HEADER`: the visitor's Tailscale login, set by `tailscale serve` (which drops any copy the client sent).
pub const LOGIN_HEADER: &str = "tailscale-user-login";
/// `FRONT_DESK_HEADER` in `src/core/env.ts`: a request from the Telegram front desk.
pub const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// `RUN_HEADER` and `HUDDLE_HEADER` in `src/core/env.ts`: sent by board runs and huddle helpers.
pub const RUN_HEADER: &str = "x-ckanban-run";
pub const HUDDLE_HEADER: &str = "x-ckanban-huddle-agent";
/// The refusal when phone access is off.
pub const PHONE_OFF: &str = "forbidden: phone access is off (run `ckanban remote on` on the Mac)";
/// The refusal for a tailnet caller that isn't the board's owner.
pub const NOT_OWNER: &str = "forbidden: open this board signed in to Tailscale as its owner";
pub const FORBIDDEN: &str = "forbidden";

/// `Listener`: the board's own port (this Mac) or the phone access port (only `tailscale serve` points at it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listener {
    Local,
    Remote,
}

/// `RemoteConfig` in `src/integrations/remote.ts`, as `remote.json` holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub host: String,
    pub allowed_login: String,
    pub updated_at: String,
}

/// What the gate reads of a request: the method and three headers as Fetch's `headers.get` gives them (several
/// values joined with ", ", bytes read as Latin-1), None when absent.
#[derive(Debug, Clone, Default)]
pub struct Seen {
    pub method: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub login: Option<String>,
}

impl Seen {
    pub fn of(method: &str, headers: &HeaderMap) -> Seen {
        Seen {
            method: method.to_string(),
            host: header_text(headers, "host"),
            origin: header_text(headers, "origin"),
            login: header_text(headers, LOGIN_HEADER),
        }
    }
}

/// Fetch's `Headers.get(name)`: every value of the header joined with ", " (bytes read as Latin-1, as a ByteString),
/// None when the request has none.
pub fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let name = HeaderName::from_bytes(name.as_bytes()).ok()?;
    let mut it = headers.get_all(name).iter().peekable();
    it.peek()?;
    Some(it.map(|v| v.as_bytes().iter().map(|&b| b as char).collect::<String>()).collect::<Vec<_>>().join(", "))
}

/// JS truthiness of `headers.get(name)`: present and not empty.
pub fn has(headers: &HeaderMap, name: &str) -> bool {
    header_text(headers, name).is_some_and(|v| !v.is_empty())
}

/// `remoteUrl`.
pub fn remote_url(host: &str) -> String {
    format!("https://{host}")
}

fn mutation(method: &str) -> bool {
    method != "GET" && method != "HEAD"
}

/// `requestRefusal`: why a request is refused (the 403 text), or None when it may go on. Local: Host
/// localhost/127.0.0.1 on the board's port (DNS rebinding) and, for a change, an Origin (when sent and not empty) of the
/// board's own page (CSRF). Remote: only while phone access is on (`remote` is `RemoteAccess.active()`), the tailnet
/// host, the owner's Tailscale login, and the tailnet Origin on a change.
///
/// A request with no Host: Bun falls back to its URL's host, which behind the front server is the internal port and
/// so never matches; here that is None, refused the same way.
pub fn refusal(req: &Seen, port: u16, remote: Option<&RemoteConfig>, via: Listener) -> Option<&'static str> {
    let host = req.host.as_deref();
    let origin = req.origin.as_deref().filter(|o| !o.is_empty());
    let change = mutation(&req.method);
    if via == Listener::Local {
        let Some(host) = host else { return Some(FORBIDDEN) };
        if !LOCAL_HOSTS.iter().any(|h| host == format!("{h}:{port}")) {
            return Some(FORBIDDEN);
        }
        if change && origin.is_some_and(|o| !LOCAL_HOSTS.iter().any(|h| o == format!("http://{h}:{port}"))) {
            return Some(FORBIDDEN);
        }
        return None;
    }
    let Some(remote) = remote else { return Some(PHONE_OFF) };
    let Some(host) = host else { return Some(FORBIDDEN) };
    if host != remote.host && host != format!("{}:443", remote.host) {
        return Some(FORBIDDEN);
    }
    let login = req.login.as_deref().map(|l| js::trim(l).to_lowercase()).unwrap_or_default();
    if login.is_empty() || login != remote.allowed_login.to_lowercase() {
        return Some(NOT_OWNER);
    }
    if change && origin.is_some_and(|o| o != remote_url(&remote.host)) {
        return Some(FORBIDDEN);
    }
    None
}

/// `isAllowedSocket`: a WebSocket upgrade (a GET) also needs an Origin, the board's own page.
pub fn socket_allowed(req: &Seen, port: u16, remote: Option<&RemoteConfig>, via: Listener) -> bool {
    let origin = req.origin.as_deref().filter(|o| !o.is_empty());
    let Some(origin) = origin else { return false };
    if refusal(req, port, remote, via).is_some() {
        return false;
    }
    match via {
        Listener::Local => LOCAL_HOSTS.iter().any(|h| origin == format!("http://{h}:{port}")),
        Listener::Remote => remote.is_some_and(|r| origin == remote_url(&r.host)),
    }
}

/// Bun's `type === "application/json"` for POST, PATCH and PUT: the content type before any `;`, trimmed, any case.
pub fn json_type(content_type: Option<&str>) -> bool {
    js::trim(content_type.unwrap_or("").split(';').next().unwrap_or("")).to_lowercase() == "application/json"
}

/// Whether a request needs a JSON body (`(m === "POST" || m === "PATCH" || m === "PUT") && type !== "application/json"`
/// is the 415).
pub fn needs_json(method: &str) -> bool {
    matches!(method, "POST" | "PATCH" | "PUT")
}

/// `POST /api/debug/profile`'s check: not a board run, Host this Mac's own address (any port but the phone access
/// port). False is the 403 "profiles are taken from this Mac only".
pub fn profile_allowed(run_header: bool, host: Option<&str>, remote_port: u16) -> bool {
    let host = host.unwrap_or("");
    if run_header {
        return false;
    }
    let rest = host.strip_prefix("localhost").or_else(|| host.strip_prefix("127.0.0.1"));
    let local = match rest {
        Some("") => true,
        Some(r) => r.strip_prefix(':').is_some_and(|d| !d.is_empty() && d.bytes().all(|c| c.is_ascii_digit())),
        None => false,
    };
    local && !host.ends_with(&format!(":{remote_port}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    fn seen(method: &str, host: Option<&str>, origin: Option<&str>, login: Option<&str>) -> Seen {
        Seen { method: method.into(), host: host.map(Into::into), origin: origin.map(Into::into), login: login.map(Into::into) }
    }

    fn cfg() -> RemoteConfig {
        RemoteConfig { enabled: true, host: "mac.tail0.ts.net".into(), allowed_login: "Owner@Example.com".into(), updated_at: String::new() }
    }

    #[test]
    fn local_host_and_origin() {
        let l = Listener::Local;
        assert_eq!(refusal(&seen("GET", Some("localhost:7777"), None, None), 7777, None, l), None);
        assert_eq!(refusal(&seen("GET", Some("localhost:7778"), None, None), 7777, None, l), Some(FORBIDDEN));
        assert_eq!(refusal(&seen("GET", None, None, None), 7777, None, l), Some(FORBIDDEN));
        assert_eq!(refusal(&seen("GET", Some("127.0.0.1:7777"), Some("https://evil"), None), 7777, None, l), None);
        assert_eq!(refusal(&seen("POST", Some("127.0.0.1:7777"), Some("https://evil"), None), 7777, None, l), Some(FORBIDDEN));
        assert_eq!(refusal(&seen("POST", Some("127.0.0.1:7777"), Some(""), None), 7777, None, l), None);
        assert_eq!(refusal(&seen("DELETE", Some("127.0.0.1:7777"), Some("http://localhost:7777"), None), 7777, None, l), None);
    }

    #[test]
    fn remote_needs_on_host_login_origin() {
        let r = Listener::Remote;
        let c = cfg();
        assert_eq!(refusal(&seen("GET", Some("mac.tail0.ts.net"), None, Some("owner@example.com")), 1, None, r), Some(PHONE_OFF));
        assert_eq!(refusal(&seen("GET", Some("mac.tail0.ts.net"), None, Some(" OWNER@example.com ")), 1, Some(&c), r), None);
        assert_eq!(refusal(&seen("GET", Some("mac.tail0.ts.net:443"), None, Some("owner@example.com")), 1, Some(&c), r), None);
        assert_eq!(refusal(&seen("GET", Some("localhost:1"), None, Some("owner@example.com")), 1, Some(&c), r), Some(FORBIDDEN));
        assert_eq!(refusal(&seen("GET", Some("mac.tail0.ts.net"), None, None), 1, Some(&c), r), Some(NOT_OWNER));
        assert_eq!(refusal(&seen("POST", Some("mac.tail0.ts.net"), Some("http://localhost:1"), Some("owner@example.com")), 1, Some(&c), r), Some(FORBIDDEN));
        assert_eq!(refusal(&seen("POST", Some("mac.tail0.ts.net"), Some("https://mac.tail0.ts.net"), Some("owner@example.com")), 1, Some(&c), r), None);
    }

    #[test]
    fn sockets_need_an_origin() {
        let c = cfg();
        assert!(socket_allowed(&seen("GET", Some("localhost:7"), Some("http://127.0.0.1:7"), None), 7, None, Listener::Local));
        assert!(!socket_allowed(&seen("GET", Some("localhost:7"), None, None), 7, None, Listener::Local));
        assert!(!socket_allowed(&seen("GET", Some("localhost:7"), Some("https://x"), None), 7, None, Listener::Local));
        assert!(socket_allowed(&seen("GET", Some("mac.tail0.ts.net"), Some("https://mac.tail0.ts.net"), Some("owner@example.com")), 7, Some(&c), Listener::Remote));
    }

    #[test]
    fn headers_read_like_fetch() {
        let mut h = HeaderMap::new();
        h.append("host", HeaderValue::from_static("localhost:1"));
        h.append("host", HeaderValue::from_static("localhost:2"));
        h.append("origin", HeaderValue::from_bytes(b"http://\xe9").unwrap());
        assert_eq!(header_text(&h, "host").as_deref(), Some("localhost:1, localhost:2"));
        assert_eq!(header_text(&h, "origin").as_deref(), Some("http://é"));
        assert_eq!(header_text(&h, "x-none"), None);
        assert!(!has(&h, "x-none"));
    }

    #[test]
    fn profile_check() {
        assert!(profile_allowed(false, Some("localhost:7777"), 7778));
        assert!(profile_allowed(false, Some("127.0.0.1"), 7778));
        assert!(!profile_allowed(false, Some("127.0.0.1:7778"), 7778));
        assert!(!profile_allowed(true, Some("localhost:7777"), 7778));
        assert!(!profile_allowed(false, Some("localhost:"), 7778));
        assert!(!profile_allowed(false, Some("evil.localhost:7777"), 7778));
        assert!(!profile_allowed(false, None, 7778));
    }
}
