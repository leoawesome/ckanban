//! Known login pages, for the board browsers' sign-in check (port of `src/browser/sign-in-signs.ts`). The check only
//! reads: tab addresses and titles, and for WhatsApp Web one small read-only look inside the page. It never navigates,
//! reloads, clicks or types.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use super::js;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageSignIn {
    In,
    Out,
    Unknown,
}

/// What the address and title alone say (`classifyByAddress`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByAddress {
    Known(PageSignIn),
    /// The site needs a look inside the page (`PAGE_PROBES`).
    Probe,
}

/// WhatsApp Web keeps its address and title when it logs out: only a look inside the page tells (same text as Bun).
pub const WHATSAPP_PROBE: &str = r#"(() => {
    const d = document;
    if (d.querySelector('#pane-side, #side, [aria-label="Chat list"], [data-testid="chat-list"]')) return "in";
    if (d.querySelector('canvas[aria-label*="QR" i], canvas[aria-label*="scan" i], div[data-ref] canvas')) return "out";
    const t = ((d.body && d.body.innerText) || "").slice(0, 4000);
    if (/Log into WhatsApp|Use WhatsApp on your computer|Steps to log in|Link with phone number|Log in with phone number|Scan to log in|Enter phone number|Enter code on (your )?phone/i.test(t)) return "out";
    return "unknown";
  })()"#;

/// The page check for a host (`PAGE_PROBES[host]`).
pub fn page_probe(host: &str) -> Option<&'static str> {
    (host == "web.whatsapp.com").then_some(WHATSAPP_PROBE)
}

/// `site in PAGE_PROBES`.
pub fn has_probe(site: &str) -> bool {
    page_probe(site).is_some()
}

static GOOGLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)signin|servicelogin|accountchooser|/o/oauth2").unwrap());
static X_HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\.)(x|twitter)\.com$").unwrap());
static LOGIN_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)/(log-?in|sign-?in|log_in|sign_in)/?$").unwrap());

/// Address rules that mean "this tab is a login page" (`LOGIN_SIGNS`).
fn login_sign(u: &Url) -> bool {
    let host = js::hostname(u);
    let path = u.path();
    (host == "accounts.google.com" && GOOGLE.is_match(path))
        || host == "login.microsoftonline.com"
        || host == "login.live.com"
        || (X_HOST.is_match(&host) && path.starts_with("/i/flow/login"))
        || LOGIN_PATH.is_match(path)
}

/// "web.whatsapp.com" from a web address; None for blank, chrome:// and other non-web pages (`siteOf`).
pub fn site_of(url: &str) -> Option<String> {
    let u = js::parse_url(url)?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let h = js::hostname(&u);
    let h = h.strip_prefix("www.").unwrap_or(&h).to_string();
    if h.is_empty() { None } else { Some(h) }
}

/// `classifyByAddress`; None for a blank or non-web tab (says nothing).
pub fn classify_by_address(url: &str, _title: &str) -> Option<ByAddress> {
    let u = js::parse_url(url)?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    if has_probe(&js::hostname(&u)) {
        return Some(ByAddress::Probe);
    }
    Some(ByAddress::Known(if login_sign(&u) { PageSignIn::Out } else { PageSignIn::In }))
}

/// A page check's answer; anything unexpected is unknown (`probeAnswer`).
pub fn probe_answer(v: Option<&serde_json::Value>) -> PageSignIn {
    match v.and_then(serde_json::Value::as_str) {
        Some("in") => PageSignIn::In,
        Some("out") => PageSignIn::Out,
        _ => PageSignIn::Unknown,
    }
}

/// How a site reads in an alert (`siteName`).
pub fn site_name(site: Option<&str>) -> String {
    match site {
        None => "a site".into(),
        Some("web.whatsapp.com") => "WhatsApp".into(),
        Some(s) => s.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use PageSignIn::*;

    #[test]
    fn login_pages_like_bun() {
        let c = |u: &str| classify_by_address(u, "");
        assert_eq!(c("https://accounts.google.com/v3/signin/identifier"), Some(ByAddress::Known(Out)));
        assert_eq!(c("https://accounts.google.com/"), Some(ByAddress::Known(In)));
        assert_eq!(c("https://login.live.com/x"), Some(ByAddress::Known(Out)));
        assert_eq!(c("https://x.com/i/flow/login?x=1"), Some(ByAddress::Known(Out)));
        assert_eq!(c("https://example.com/users/sign_in"), Some(ByAddress::Known(Out)));
        assert_eq!(c("https://example.com/blog/how-to-login-fast"), Some(ByAddress::Known(In)));
        assert_eq!(c("https://web.whatsapp.com/"), Some(ByAddress::Probe));
        assert_eq!(c("about:blank"), None);
        assert_eq!(c("chrome://newtab/"), None);
        assert_eq!(site_of("https://www.example.com/a"), Some("example.com".into()));
        assert_eq!(site_of("about:blank"), None);
        assert_eq!(probe_answer(Some(&serde_json::json!("out"))), Out);
        assert_eq!(probe_answer(None), Unknown);
        assert_eq!(site_name(Some("web.whatsapp.com")), "WhatsApp");
    }
}
