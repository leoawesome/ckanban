//! The sign-in every online MCP server is meant to support (port of `src/integrations/oauth.ts`): find the server's
//! sign-in addresses from the server itself, register ckanban as a client on the spot (RFC 7591), and sign in with a
//! one-time proof (PKCE) for a token bound to that server (RFC 8707 `resource`). Nothing here is written for one
//! service.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};
use url::Url;

use super::Fault;
use super::http::Http;
use crate::js;

/// Where a server signs people in, as its metadata says.
#[derive(Debug, Clone, PartialEq)]
pub struct SignInServer {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    /// None: the server doesn't let clients register themselves, so the user pastes a key instead.
    pub registration_endpoint: Option<String>,
    /// The read-only scopes it offers; empty: ask for none, the server's default.
    pub read_scopes: Vec<String>,
}

static READ_SCOPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^read$|[:.]read$|^read[:.]").unwrap());

/// `readScopes`: scopes that only read, by their name.
pub fn read_scopes(supported: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(a)) = supported else { return Vec::new() };
    a.iter().map(js::string).filter(|s| READ_SCOPE.is_match(s)).collect()
}

/// `webAddress`: an address accepted only as https (http only on this computer). Err is the Error's message.
pub fn web_address(raw: &str) -> Result<String, String> {
    let u = Url::parse(raw).map_err(|_| format!("\"{raw}\" isn't a web address"))?;
    let host = u.host_str().unwrap_or("");
    let local = ["localhost", "127.0.0.1", "[::1]"].contains(&host);
    let scheme = u.scheme();
    if scheme != "https" && !(scheme == "http" && local) {
        return Err(format!("{scheme}://{} isn't a secure web address (https)", host_of(&u)));
    }
    Ok(u.as_str().to_string())
}

/// `URL.host`: the host and a non-default port.
pub fn host_of(u: &Url) -> String {
    let h = u.host_str().unwrap_or("");
    match u.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_string(),
    }
}

/// `URL.origin` for http(s) addresses.
fn origin_of(u: &Url) -> String {
    u.origin().ascii_serialization()
}

/// `getJson`: the JSON of a 2xx answer; None for anything else (a JSON `null` too, as `??` treats it).
async fn get_json(http: &Http, url: &str) -> Option<Value> {
    let r = http.send("GET", url, &[("accept", "application/json")], None).await.ok()?;
    if !(200..300).contains(&r.status) {
        return None;
    }
    serde_json::from_str::<Value>(&r.text).ok().filter(|v| !v.is_null())
}

static RESOURCE_METADATA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)resource_metadata="([^"]+)""#).unwrap());

/// `resourceMetadataUrl`: `resource_metadata="..."` from a 401's WWW-Authenticate header.
pub fn resource_metadata_url(header: Option<&str>) -> Option<String> {
    RESOURCE_METADATA.captures(header?).map(|c| c[1].to_string())
}

/// `metadataUrls`: RFC 8414 / OpenID addresses for an issuer, path-aware first, then at the root.
fn metadata_urls(issuer: &str) -> Result<Vec<String>, String> {
    let u = Url::parse(issuer).map_err(|_| format!("\"{issuer}\" cannot be parsed as a URL."))?;
    let origin = origin_of(&u);
    let path = u.path().strip_suffix('/').unwrap_or(u.path()).to_string();
    let mut urls = vec![format!("{origin}/.well-known/oauth-authorization-server{path}"), format!("{origin}/.well-known/openid-configuration{path}")];
    if !path.is_empty() {
        urls.push(format!("{origin}/.well-known/oauth-authorization-server"));
        urls.push(format!("{origin}{path}/.well-known/openid-configuration"));
    }
    let mut out: Vec<String> = Vec::new();
    for x in urls {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    Ok(out)
}

/// `discover`: the server's sign-in addresses (protected-resource metadata, then the sign-in server's metadata).
pub async fn discover(http: &Http, mcp_url: &str) -> Result<SignInServer, Fault> {
    let url = Url::parse(mcp_url).map_err(|_| Fault::Other(format!("\"{mcp_url}\" cannot be parsed as a URL.")))?;
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "ckanban", "version": "1" } } });
    let headers = [("content-type", "application/json"), ("accept", "application/json, text/event-stream")];
    let prm = match http.send("POST", mcp_url, &headers, Some(init.to_string())).await {
        Ok(r) => resource_metadata_url(r.header("www-authenticate").as_deref()),
        Err(_) => return Err(Fault::Other(format!("Could not reach {}", host_of(&url)))),
    };
    let origin = origin_of(&url);
    let path = url.path().strip_suffix('/').unwrap_or(url.path()).to_string();
    let mut resource = None;
    if let Some(prm) = prm.filter(|p| !p.is_empty()) {
        resource = get_json(http, &prm).await;
    }
    if resource.is_none() && !path.is_empty() {
        resource = get_json(http, &format!("{origin}/.well-known/oauth-protected-resource{path}")).await;
    }
    if resource.is_none() {
        resource = get_json(http, &format!("{origin}/.well-known/oauth-protected-resource")).await;
    }
    let issuers: Vec<String> = match resource.as_ref().and_then(|r| r.get("authorization_servers")) {
        Some(Value::Array(a)) if !a.is_empty() => a.iter().map(js::string).collect(),
        _ => vec![origin.clone()],
    };
    for issuer in issuers {
        for m in metadata_urls(&issuer).map_err(Fault::Other)? {
            let Some(meta) = get_json(http, &m).await else { continue };
            if js::truthy(meta.get("authorization_endpoint")) && js::truthy(meta.get("token_endpoint")) {
                let addr = |k: &str| web_address(&js::string(&meta[k])).map_err(Fault::Other);
                let registration = if js::truthy(meta.get("registration_endpoint")) { Some(addr("registration_endpoint")?) } else { None };
                return Ok(SignInServer {
                    authorization_endpoint: addr("authorization_endpoint")?,
                    token_endpoint: addr("token_endpoint")?,
                    registration_endpoint: registration,
                    read_scopes: read_scopes(meta.get("scopes_supported")),
                });
            }
        }
    }
    Err(Fault::NoRegistration(format!("{} doesn't say how to sign in", host_of(&url))))
}

/// `register`: registers ckanban for this callback address (a public client that signs in with PKCE). Gives
/// `{clientId, clientSecret?}`.
pub async fn register(http: &Http, server: &SignInServer, redirect_uri: &str) -> Result<Map<String, Value>, Fault> {
    let Some(endpoint) = &server.registration_endpoint else {
        return Err(Fault::NoRegistration("This service doesn't let ckanban sign in by itself".into()));
    };
    let mut body = json!({
        "client_name": "ckanban", "redirect_uris": [redirect_uri], "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"], "token_endpoint_auth_method": "none",
    });
    if !server.read_scopes.is_empty() {
        body["scope"] = json!(server.read_scopes.join(" "));
    }
    let r = http
        .send("POST", endpoint, &[("content-type", "application/json"), ("accept", "application/json")], Some(body.to_string()))
        .await
        .map_err(Fault::Other)?;
    let b = ckanban_board::runs::js::parse(&r.text).unwrap_or_else(|| json!({}));
    if !(200..300).contains(&r.status) || !js::truthy(b.get("client_id")) {
        return Err(Fault::Other(why(&b).unwrap_or_else(|| format!("registration answered {}", r.status))));
    }
    let mut out = Map::new();
    out.insert("clientId".into(), json!(js::string(&b["client_id"])));
    if js::truthy(b.get("client_secret")) {
        out.insert("clientSecret".into(), json!(js::string(&b["client_secret"])));
    }
    Ok(out)
}

/// `String(b.error_description ?? b.error)`, when either is there (not null or missing).
fn why(b: &Value) -> Option<String> {
    let pick = |k: &str| b.get(k).filter(|v| !v.is_null());
    pick("error_description").or_else(|| pick("error")).map(js::string)
}

/// `URLSearchParams.set` on a list of pairs: replaces the first pair of that name, drops the others, else appends.
fn set_param(pairs: &mut Vec<(String, String)>, k: &str, v: &str) {
    match pairs.iter().position(|(n, _)| n == k) {
        Some(i) => {
            pairs[i].1 = v.to_string();
            let mut j = 0;
            pairs.retain(|(n, _)| {
                let keep = n != k || j == i;
                j += 1;
                keep
            });
        }
        None => pairs.push((k.to_string(), v.to_string())),
    }
}

/// `authorizeUrl(c, state, challenge)`: the sign-in page's address with every parameter set.
pub fn authorize_url(c: &Map<String, Value>, state: &str, challenge: &str) -> Result<String, String> {
    let s = |k: &str| c.get(k).map(js::string).unwrap_or_else(|| "undefined".into());
    let mut u = Url::parse(&web_address(&s("authorizationEndpoint"))?).map_err(|e| e.to_string())?;
    let mut pairs: Vec<(String, String)> = u.query_pairs().into_owned().collect();
    for (k, v) in [
        ("response_type", "code".to_string()),
        ("client_id", s("clientId")),
        ("redirect_uri", s("redirectUri")),
        ("state", state.to_string()),
        ("code_challenge", challenge.to_string()),
        ("code_challenge_method", "S256".to_string()),
        ("resource", s("resource")),
    ] {
        set_param(&mut pairs, k, &v);
    }
    if js::truthy(c.get("scope")) {
        set_param(&mut pairs, "scope", &s("scope"));
    }
    let q = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.iter()).finish();
    u.set_query(Some(&q));
    Ok(u.as_str().to_string())
}

/// `tokenCall`: the token endpoint's answer as the pass's `tokens` (`{access, refresh?, expiresAt?}`).
async fn token_call(http: &Http, c: &Map<String, Value>, params: &[(&str, &str)], now_ms: f64) -> Result<Map<String, Value>, Fault> {
    let s = |k: &str| c.get(k).map(js::string).unwrap_or_else(|| "undefined".into());
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in params {
        form.append_pair(k, v);
    }
    form.append_pair("client_id", &s("clientId"));
    form.append_pair("resource", &s("resource"));
    if js::truthy(c.get("clientSecret")) {
        form.append_pair("client_secret", &s("clientSecret"));
    }
    let body = form.finish();
    let headers = [("content-type", "application/x-www-form-urlencoded"), ("accept", "application/json")];
    let r = http.send("POST", &s("tokenEndpoint"), &headers, Some(body)).await.map_err(Fault::Other)?;
    let b = ckanban_board::runs::js::parse(&r.text).unwrap_or_else(|| json!({}));
    let refreshing = params.iter().any(|(k, v)| *k == "grant_type" && *v == "refresh_token");
    if !(200..300).contains(&r.status) || !js::truthy(b.get("access_token")) {
        let why = why(&b).unwrap_or_else(|| format!("status {}", r.status));
        return Err(if refreshing {
            Fault::Auth(format!("The service refused to renew the connection: {why}"))
        } else {
            Fault::Other(format!("The service refused the sign-in: {why}"))
        });
    }
    let mut t = Map::new();
    t.insert("access".into(), json!(js::string(&b["access_token"])));
    if js::truthy(b.get("refresh_token")) {
        t.insert("refresh".into(), json!(js::string(&b["refresh_token"])));
    }
    let seconds = ckanban_board::runs::js::number(b.get("expires_in"));
    if seconds.is_finite() && seconds > 0.0 {
        t.insert("expiresAt".into(), json!(ckanban_core::time::iso((now_ms + seconds * 1000.0).trunc())));
    }
    Ok(t)
}

/// `exchange`: the code the service sent back, for tokens.
pub async fn exchange(http: &Http, c: &Map<String, Value>, code: &str, verifier: &str, now_ms: f64) -> Result<Map<String, Value>, Fault> {
    let redirect = c.get("redirectUri").map(js::string).unwrap_or_else(|| "undefined".into());
    token_call(http, c, &[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", &redirect), ("code_verifier", verifier)], now_ms).await
}

/// `refresh`: new tokens for a refresh token.
pub async fn refresh(http: &Http, c: &Map<String, Value>, refresh_token: &str, now_ms: f64) -> Result<Map<String, Value>, Fault> {
    token_call(http, c, &[("grant_type", "refresh_token"), ("refresh_token", refresh_token)], now_ms).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_addresses() {
        assert_eq!(web_address("https://a.example/x").unwrap(), "https://a.example/x");
        assert_eq!(web_address("https://A.example").unwrap(), "https://a.example/");
        assert_eq!(web_address("http://127.0.0.1:9/mcp").unwrap(), "http://127.0.0.1:9/mcp");
        assert_eq!(web_address("http://[::1]:9/").unwrap(), "http://[::1]:9/");
        assert_eq!(web_address("http://a.example/").unwrap_err(), "http://a.example isn't a secure web address (https)");
        assert_eq!(web_address("javascript:alert(1)").unwrap_err(), "javascript:// isn't a secure web address (https)");
        assert_eq!(web_address("nope").unwrap_err(), "\"nope\" isn't a web address");
    }

    #[test]
    fn scopes_and_metadata() {
        assert_eq!(read_scopes(Some(&json!(["read", "write", "org:read", "read:x", "a.read", "reader"]))), vec!["read", "org:read", "read:x", "a.read"]);
        assert!(read_scopes(Some(&json!("read"))).is_empty());
        assert_eq!(resource_metadata_url(Some(r#"Bearer resource_metadata="https://x/y""#)), Some("https://x/y".into()));
        assert_eq!(
            metadata_urls("https://a.example/t/").unwrap(),
            vec![
                "https://a.example/.well-known/oauth-authorization-server/t",
                "https://a.example/.well-known/openid-configuration/t",
                "https://a.example/.well-known/oauth-authorization-server",
                "https://a.example/t/.well-known/openid-configuration",
            ]
        );
        assert_eq!(metadata_urls("https://a.example").unwrap().len(), 2);
    }

    #[test]
    fn authorize_url_sets_every_parameter() {
        let c = json!({ "clientId": "c 1", "redirectUri": "http://localhost:1/api/passes/oauth/callback", "authorizationEndpoint": "https://a.example/auth?x=1&state=old&state=again", "tokenEndpoint": "https://a.example/t", "resource": "https://a.example/mcp", "scope": "read org:read" });
        let u = authorize_url(c.as_object().unwrap(), "st", "ch").unwrap();
        assert_eq!(
            u,
            "https://a.example/auth?x=1&state=st&response_type=code&client_id=c+1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fapi%2Fpasses%2Foauth%2Fcallback&code_challenge=ch&code_challenge_method=S256&resource=https%3A%2F%2Fa.example%2Fmcp&scope=read+org%3Aread"
        );
    }
}
