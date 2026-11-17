//! The `fetch` the pass code uses (Bun's `Deps.fetch`): one shared client, redirects followed as fetch does, the whole
//! answer read as text.

use std::time::Duration;

/// How long one call to a service may take. Bun's fetch has no limit; a service that never answers would otherwise
/// hold a check or a route forever.
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct Http(reqwest::Client);

pub struct Reply {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub text: String,
}

impl Reply {
    /// `res.headers.get(name)`: several values joined with ", ".
    pub fn header(&self, name: &str) -> Option<String> {
        let all: Vec<String> = self.headers.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
        (!all.is_empty()).then(|| all.join(", "))
    }
}

impl Default for Http {
    fn default() -> Self {
        Self::new()
    }
}

impl Http {
    pub fn new() -> Self {
        let client = reqwest::Client::builder().timeout(TIMEOUT).build().expect("http client");
        Http(client)
    }

    /// One request; Err is the network error's text (fetch's rejection).
    pub async fn send(&self, method: &str, url: &str, headers: &[(&str, &str)], body: Option<String>) -> Result<Reply, String> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = self.0.request(m, url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        if let Some(b) = body {
            req = req.body(b);
        }
        let res = req.send().await.map_err(|e| without_url(&e))?;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let bytes = res.bytes().await.map_err(|e| without_url(&e))?;
        Ok(Reply { status, headers, text: String::from_utf8_lossy(&bytes).into_owned() })
    }
}

/// reqwest's error text without the address it was for (it may carry a key in its query); the cause chain kept.
fn without_url(e: &reqwest::Error) -> String {
    let mut out = if e.is_timeout() {
        "The operation timed out.".to_string()
    } else if e.is_connect() {
        "Unable to connect. Is the computer able to access the url?".to_string()
    } else {
        String::new()
    };
    if out.is_empty() {
        let mut src: Option<&dyn std::error::Error> = std::error::Error::source(e);
        let mut parts = Vec::new();
        while let Some(s) = src {
            parts.push(s.to_string());
            src = s.source();
        }
        out = if parts.is_empty() { "fetch failed".into() } else { parts.join(": ") };
    }
    out
}
