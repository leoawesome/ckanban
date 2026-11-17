//! The pass routes and calls against local fakes: an online MCP server with its sign-in on 127.0.0.1, and a program
//! on this computer written in sh. Never a real service.

use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response};

use super::*;
use std::os::unix::fs::PermissionsExt;

/// What the fake service saw and how it behaves.
#[derive(Default)]
struct FakeState {
    /// Requests as "METHOD path" and their bodies.
    seen: Mutex<Vec<(String, String)>>,
    /// Answer tools/list with 401 (the token was revoked).
    revoked: Mutex<bool>,
    /// Answer tools/call with 429 and this retry-after.
    limit: Mutex<Option<String>>,
    /// Answer over an event stream.
    sse: Mutex<bool>,
    /// No registration endpoint in the metadata.
    no_registration: Mutex<bool>,
    tokens: AtomicUsize,
}

async fn serve(state: Arc<FakeState>) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let b2 = base.clone();
    let h = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { return };
            let (state, base) = (state.clone(), b2.clone());
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
                    let (state, base) = (state.clone(), base.clone());
                    async move { Ok::<_, Infallible>(fake(req, &state, &base).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), svc).await;
            });
        }
    });
    (base, h)
}

fn reply(status: u16, ctype: &str, body: String) -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(Bytes::from(body)));
    *r.status_mut() = hyper::StatusCode::from_u16(status).unwrap();
    r.headers_mut().insert("content-type", ctype.parse().unwrap());
    r
}

async fn fake(req: Request<Incoming>, st: &FakeState, base: &str) -> Response<Full<Bytes>> {
    let (method, path) = (req.method().to_string(), req.uri().path().to_string());
    let auth = req.headers().get("authorization").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
    let body = String::from_utf8(req.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    st.seen.lock().push((format!("{method} {path}"), body.clone()));
    let json = |v: Value| reply(200, "application/json", v.to_string());
    match path.as_str() {
        "/.well-known/oauth-protected-resource/mcp" => json(json!({ "authorization_servers": [base] })),
        "/.well-known/oauth-authorization-server" => {
            let mut m = json!({ "authorization_endpoint": format!("{base}/authorize"), "token_endpoint": format!("{base}/token"), "scopes_supported": ["read", "write"] });
            if !*st.no_registration.lock() {
                m["registration_endpoint"] = json!(format!("{base}/register"));
            }
            json(m)
        }
        "/register" => json(json!({ "client_id": "client-1" })),
        "/token" => {
            let n = st.tokens.fetch_add(1, Ordering::SeqCst) + 1;
            let q: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
            if q.get("code").map(String::as_str) == Some("bad") {
                return reply(400, "application/json", json!({ "error": "invalid_grant", "error_description": "code expired" }).to_string());
            }
            // The first token runs out at once, so the next use renews it.
            json(json!({ "access_token": format!("access-token-{n:04}"), "refresh_token": "refresh-token-0001", "expires_in": if q.get("grant_type").map(String::as_str) == Some("authorization_code") { 1 } else { 3600 } }))
        }
        "/mcp" if method == "DELETE" => reply(200, "text/plain", String::new()),
        "/mcp" => {
            if !auth.starts_with("Bearer ") {
                let mut r = reply(401, "text/plain", "no".into());
                r.headers_mut().insert("www-authenticate", "Bearer resource_metadata=\"nowhere\"".parse().unwrap());
                return r;
            }
            let msg: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            let m = msg["method"].as_str().unwrap_or("");
            if m == "tools/list" && *st.revoked.lock() {
                return reply(401, "text/plain", "revoked".into());
            }
            if m == "tools/call"
                && let Some(after) = st.limit.lock().clone()
            {
                let mut r = reply(429, "text/plain", "slow down".into());
                r.headers_mut().insert("retry-after", after.parse().unwrap());
                return r;
            }
            let result = match m {
                "initialize" => json!({ "protocolVersion": "2025-03-26", "capabilities": {} }),
                "tools/list" => json!({ "tools": [{ "name": "list_items", "description": "x".repeat(400) }, { "name": "other" }] }),
                "tools/call" => json!({ "content": [{ "type": "text", "text": format!("{{\"got\":{}}}", msg["params"]["arguments"]) }] }),
                _ => return reply(202, "text/plain", String::new()),
            };
            let out = json!({ "jsonrpc": "2.0", "id": id, "result": result });
            if *st.sse.lock() {
                let mut r = reply(200, "text/event-stream", format!("event: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"x\"}}\n\ndata: {out}\n\n"));
                r.headers_mut().insert("mcp-session-id", "s-1".parse().unwrap());
                r
            } else {
                let mut r = json(out);
                r.headers_mut().insert("mcp-session-id", "s-1".parse().unwrap());
                r
            }
        }
        _ => reply(404, "text/plain", "no".into()),
    }
}

struct Env {
    dir: PathBuf,
    sign: Arc<SignIn>,
    notified: Arc<AtomicUsize>,
}

fn env() -> Env {
    let dir = std::env::temp_dir().join(format!("ck-signin-{}-{}", std::process::id(), front::new_id()));
    std::fs::create_dir_all(dir.join("profiles").join("keys")).unwrap();
    std::fs::write(dir.join("profiles").join("keys").join("profile.json"), r#"{"slug":"keys","name":"Keys","path":"/tmp"}"#).unwrap();
    let notified = Arc::new(AtomicUsize::new(0));
    let n = notified.clone();
    let notify: front::Notify = Arc::new(move |_| {
        n.fetch_add(1, Ordering::SeqCst);
    });
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let sign = SignIn::new(dir.clone(), "http://localhost:4000/api/passes/oauth/callback".into(), notify, home.clone(), home.join(".claude.json"));
    Env { dir, sign, notified }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn allow(_: &str) -> Result<(), Answer> {
    Ok(())
}

fn refuse(what: &str) -> Result<(), Answer> {
    Err(Answer::error(403, crate::guard::refusal(what)))
}

async fn call(e: &Env, method: &str, path: &str, body: Value) -> Answer {
    call_as(e, method, path, body, true, &allow).await
}

async fn call_as(e: &Env, method: &str, path: &str, body: Value, local: bool, user: &(dyn Fn(&str) -> Result<(), Answer> + Send + Sync)) -> Answer {
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    let parts: Vec<String> = path.trim_start_matches("/api/").split('/').map(str::to_string).collect();
    let body = if body.is_null() { Vec::new() } else { body.to_string().into_bytes() };
    let c = Call { method, parts: &parts, query, body: &body, local, from_run: false, user };
    e.sign.answer(&c).await.expect("a passes route")
}

fn json_of(a: &Answer) -> (u16, Value) {
    match a {
        Answer::Json(s, v) => (*s, v.clone()),
        other => panic!("not JSON: {other:?}"),
    }
}

fn stored(e: &Env) -> Value {
    serde_json::from_slice(&std::fs::read(e.dir.join(PASSES_FILE)).unwrap()).unwrap()
}

#[tokio::test]
async fn keys_and_validation() {
    let e = env();
    let (s, v) = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "key", "name": "Linear  API", "secret": " lin_api_value_123456 " })).await);
    assert_eq!(s, 201);
    assert_eq!(v["envName"], "LINEAR_API_KEY");
    assert_eq!(v["url"], Value::Null);
    assert!(v.get("secret").is_none());
    let id = v["id"].as_str().unwrap().to_string();
    let p = &stored(&e)["passes"][0];
    let keys: Vec<&String> = p.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["id", "claudeName", "error", "createdAt", "kind", "name", "envName", "secret", "status"]);
    assert_eq!(p["secret"], "lin_api_value_123456");
    assert_eq!(std::fs::metadata(e.dir.join(PASSES_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(e.notified.load(Ordering::SeqCst), 1);
    // The same key name again: 409.
    let dup = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "key", "name": "Linear API", "secret": "x" })).await);
    assert_eq!(dup, (409, json!({ "error": "A key named LINEAR_API_KEY already exists: replace that one instead" })));
    // A key for an online server keeps its address and no key name; not for one board.
    let (s, v) = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "key", "name": "Srv", "secret": "abcdefgh", "url": "https://srv.example/mcp" })).await);
    assert_eq!((s, v["url"].clone(), v["envName"].clone()), (201, json!("https://srv.example/mcp"), Value::Null));
    macro_rules! bad {
        ($b:expr, $want:expr) => {{
            let (s, v) = json_of(&call(&e, "POST", "/api/passes", $b).await);
            assert_eq!((s, v["error"].as_str().unwrap()), $want);
        }};
    }
    bad!(json!({ "kind": "key", "name": "S", "secret": "abc", "url": "https://x.example", "board": "keys" }), (400, "A key for one board is for its runs and scripts, not for an online server"));
    bad!(json!({ "kind": "key", "name": "S", "secret": "a\nb" }), (400, "The key must be on one line"));
    bad!(json!({ "kind": "key", "secret": "abc" }), (400, "Give the key a name, e.g. Jira"));
    bad!(json!({ "kind": "key", "name": "x", "secret": "abc", "url": "http://x.example" }), (400, "The address must start with https://"));
    bad!(json!({ "kind": "key", "name": "x", "secret": "abc", "envName": "PATH" }), (400, "\"PATH\" can't be used as the key's name for scripts: use capital letters, digits and _"));
    bad!(json!({ "kind": "nope" }), (400, "kind must be \"mcp\", \"key\" or \"local\""));
    bad!(json!({ "kind": "key", "board": "missing" }), (400, "That board doesn't exist"));
    bad!(json!({ "kind": "local" }), (400, "Pick the program from Connections"));
    bad!(json!({ "kind": "local", "claudeName": "gone" }), (404, "gone isn't in Claude's settings any more"));
    // Invalid JSON, the user-only checks.
    let parts = vec!["passes".to_string()];
    let c = Call { method: "POST", parts: &parts, query: "", body: b"{", local: true, from_run: false, user: &allow };
    assert_eq!(json_of(&e.sign.answer(&c).await.unwrap()), (400, json!({ "error": "invalid JSON body" })));
    let refused = json_of(&call_as(&e, "PATCH", &format!("/api/passes/{id}"), json!({ "secret": "y" }), true, &refuse).await);
    assert_eq!(refused.0, 403);
    assert!(refused.1["error"].as_str().unwrap().starts_with("Changing a service's connection for automations is for the user only"));
    assert_eq!(json_of(&call_as(&e, "POST", "/api/passes", json!({}), true, &refuse).await).0, 403);
    // Replace, then remove; a missing pass is 404.
    let (s, v) = json_of(&call(&e, "PATCH", &format!("/api/passes/{id}"), json!({ "secret": "lin_api_new_value_9" })).await);
    assert_eq!((s, v["status"].clone()), (200, json!("connected")));
    assert_eq!(stored(&e)["passes"][0]["secret"], "lin_api_new_value_9");
    assert!(stored(&e)["passes"][0]["savedAt"].is_string());
    assert_eq!(json_of(&call(&e, "PATCH", &format!("/api/passes/{id}"), json!({ "secret": "" })).await).0, 400);
    assert_eq!(call(&e, "DELETE", &format!("/api/passes/{id}"), Value::Null).await, Answer::Empty(204));
    assert_eq!(json_of(&call(&e, "DELETE", &format!("/api/passes/{id}"), Value::Null).await), (404, json!({ "error": "That connection no longer exists" })));
    assert_eq!(json_of(&call(&e, "GET", "/api/passes/x/nope", Value::Null).await), (404, json!({ "error": "not found" })));
    let (s, list) = json_of(&call(&e, "GET", "/api/passes", Value::Null).await);
    assert_eq!((s, list["passes"].as_array().unwrap().len(), list["automations"].clone()), (200, 1, json!(0)));
}

#[tokio::test]
async fn an_online_service_signs_in_lists_tools_renews_and_calls() {
    let e = env();
    let st = Arc::new(FakeState::default());
    let (base, server) = serve(st.clone()).await;
    let (s, v) = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "mcp", "url": format!("{base}/mcp") })).await);
    assert_eq!(s, 201);
    assert_eq!(v["name"], base.trim_start_matches("http://"));
    assert_eq!(v["status"], "pending");
    let id = v["id"].as_str().unwrap().to_string();
    // Not signed in yet.
    let (s, v) = json_of(&call(&e, "GET", &format!("/api/passes/{id}/tools"), Value::Null).await);
    assert_eq!((s, v["error"].as_str().unwrap()), (502, format!("{} isn't signed in yet: press Connect in Connections", base.trim_start_matches("http://")).as_str()));

    let (s, v) = json_of(&call(&e, "POST", &format!("/api/passes/{id}/authorize"), json!({})).await);
    assert_eq!(s, 200);
    let url = url::Url::parse(v["url"].as_str().unwrap()).unwrap();
    assert!(url.as_str().starts_with(&format!("{base}/authorize?response_type=code&client_id=client-1&redirect_uri=")));
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q["scope"], "read");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["resource"], format!("{base}/mcp"));
    let oauth = stored(&e)["passes"][0]["oauth"].clone();
    let keys: Vec<&String> = oauth.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["clientId", "redirectUri", "authorizationEndpoint", "tokenEndpoint", "resource", "scope"]);
    let reg = st.seen.lock().iter().find(|(r, _)| r == "POST /register").unwrap().1.clone();
    assert_eq!(reg, r#"{"client_name":"ckanban","redirect_uris":["http://localhost:4000/api/passes/oauth/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","scope":"read"}"#);

    // A wrong code: the pass stays pending with the reason.
    let bad = call(&e, "GET", &format!("/api/passes/oauth/callback?state={}&code=bad", q["state"]), Value::Null).await;
    let Answer::Html(502, html) = bad else { panic!("{bad:?}") };
    assert!(html.contains("<h2>Not connected</h2><p>The service refused the sign-in: code expired</p>"), "{html}");
    // The state works once.
    let again = call(&e, "GET", &format!("/api/passes/oauth/callback?state={}&code=good", q["state"]), Value::Null).await;
    assert!(matches!(&again, Answer::Html(400, h) if h.contains("not valid any more")));

    let v = json_of(&call(&e, "POST", &format!("/api/passes/{id}/authorize"), json!({})).await).1;
    let q: HashMap<String, String> = url::Url::parse(v["url"].as_str().unwrap()).unwrap().query_pairs().into_owned().collect();
    let tok = st.seen.lock().iter().filter(|(r, _)| r == "POST /token").count();
    let ok = call(&e, "GET", &format!("/api/passes/oauth/callback?state={}&code=good", q["state"]), Value::Null).await;
    let Answer::Html(200, html) = ok else { panic!("{ok:?}") };
    assert!(html.ends_with(&format!("<h2>Connected</h2><p>{} is connected for automations. You can close this tab and go back to the board.</p>", base.trim_start_matches("http://"))));
    let token_body = st.seen.lock().iter().filter(|(r, _)| r == "POST /token").nth(tok).unwrap().1.clone();
    assert!(token_body.starts_with("grant_type=authorization_code&code=good&redirect_uri=http%3A%2F%2Flocalhost%3A4000%2Fapi%2Fpasses%2Foauth%2Fcallback&code_verifier="), "{token_body}");
    assert!(token_body.ends_with(&format!("&client_id=client-1&resource={}", url::form_urlencoded::byte_serialize(format!("{base}/mcp").as_bytes()).collect::<String>())));
    let p = stored(&e)["passes"][0].clone();
    assert_eq!(p["status"], "connected");
    assert_eq!(p["tokens"]["refresh"], "refresh-token-0001");

    // The first token is about to run out: listing the tools renews it first (refresh first in the saved tokens).
    let (s, tools) = json_of(&call(&e, "GET", &format!("/api/passes/{id}/tools"), Value::Null).await);
    assert_eq!(s, 200);
    assert_eq!(tools[0]["description"].as_str().unwrap().len(), 300);
    assert_eq!(tools[1], json!({ "name": "other" }));
    let t = stored(&e)["passes"][0]["tokens"].clone();
    let keys: Vec<&String> = t.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["refresh", "access", "expiresAt"]);
    assert_eq!(t["access"], "access-token-0003");
    assert!(st.seen.lock().iter().any(|(r, b)| r == "POST /token" && b.starts_with("grant_type=refresh_token&refresh_token=refresh-token-0001&client_id=client-1")));
    assert!(st.seen.lock().iter().any(|(r, _)| r == "DELETE /mcp"));

    // An automation's call, plain and over an event stream; the grant's checks.
    let ok = e.sign.pass_call(json!({ "service": base.trim_start_matches("http://").to_uppercase(), "tool": "list_items", "args": { "a": 1 }, "passes": [id], "allowed": null })).await;
    assert_eq!(ok, json!({ "status": 200, "body": { "result": { "got": { "a": 1 } } }, "rateLimitMs": 0.0 }));
    *st.sse.lock() = true;
    let ok = e.sign.pass_call(json!({ "service": id, "tool": "list_items", "args": [1], "passes": [id] })).await;
    assert_eq!(ok["body"]["result"], json!({ "got": {} }));
    *st.sse.lock() = false;
    let none = e.sign.pass_call(json!({ "service": "nope", "tool": "x", "passes": [id] })).await;
    assert_eq!(none["status"], 404);
    assert_eq!(none["body"]["error"], format!("This automation can't use \"nope\". It can use: {}.", base.trim_start_matches("http://")));
    assert_eq!(e.sign.pass_call(json!({ "service": "nope", "tool": "x" })).await["body"]["error"], "This automation can't use \"nope\". It has no connections.");
    assert_eq!(e.sign.pass_call(json!({ "service": id, "tool": "a b", "passes": [id] })).await["status"], 400);
    let denied = e.sign.pass_call(json!({ "service": id, "tool": "other", "passes": [id], "allowed": [format!("{id}:list_items")] })).await;
    assert_eq!(denied["status"], 403);
    *st.limit.lock() = Some("7".into());
    let slow = e.sign.pass_call(json!({ "service": id, "tool": "list_items", "passes": [id] })).await;
    assert_eq!(slow, json!({ "status": 502, "body": { "error": "The service is limiting requests" }, "rateLimitMs": 7000.0 }));
    *st.limit.lock() = None;

    // The service revokes the token: the pass needs connecting again.
    *st.revoked.lock() = true;
    let (s, v) = json_of(&call(&e, "GET", &format!("/api/passes/{id}/tools"), Value::Null).await);
    assert_eq!((s, v["error"].as_str().unwrap()), (502, "The service no longer accepts this connection"));
    let p = stored(&e)["passes"][0].clone();
    assert_eq!((p["status"].clone(), p["error"].clone()), (json!("needs_reconnect"), json!("The service no longer accepts this connection")));
    server.abort();
}

#[tokio::test]
async fn a_service_without_registration_and_the_callback_rules() {
    let e = env();
    let st = Arc::new(FakeState::default());
    *st.no_registration.lock() = true;
    let (base, server) = serve(st.clone()).await;
    let id = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "mcp", "url": format!("{base}/mcp"), "name": "Svc" })).await).1["id"].as_str().unwrap().to_string();
    let (s, v) = json_of(&call(&e, "POST", &format!("/api/passes/{id}/authorize"), json!({})).await);
    assert_eq!((s, v), (409, json!({ "error": "Svc can't be signed in to from the board by itself. Paste a key for it instead.", "code": "no_registration" })));
    // A service that knows no sign-in at all.
    let id2 = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "mcp", "url": format!("{base}/other"), "name": "Bare" })).await).1["id"].as_str().unwrap().to_string();
    assert_eq!(json_of(&call(&e, "POST", &format!("/api/passes/{id2}/authorize"), json!({})).await).1["code"], "no_registration");
    server.abort();
    // Unreachable: 502.
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let id3 = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "mcp", "url": format!("http://127.0.0.1:{free}/mcp"), "name": "Gone" })).await).1["id"].as_str().unwrap().to_string();
    let (s, v) = json_of(&call(&e, "POST", &format!("/api/passes/{id3}/authorize"), json!({})).await);
    assert_eq!((s, v["error"].as_str().unwrap()), (502, format!("Could not start the sign-in with Gone: Could not reach 127.0.0.1:{free}").as_str()));

    let denied = call(&e, "GET", "/api/passes/oauth/callback?error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E", Value::Null).await;
    assert_eq!(
        denied,
        Answer::Html(400, "<!doctype html><meta charset=\"utf-8\"><title>Not connected</title><body style=\"font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem\"><h2>Not connected</h2><p>&#60;b&#62;no&#60;/b&#62;</p>".into())
    );
    let phone = call_as(&e, "GET", "/api/passes/oauth/callback?state=x&code=y", Value::Null, false, &allow).await;
    assert_eq!(json_of(&phone), (403, json!({ "error": "sign in from the computer ckanban runs on" })));
    // A key has no sign-in step; a key for scripts is no service to call.
    let key = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "key", "name": "Jira", "secret": "abcdefgh" })).await).1["id"].as_str().unwrap().to_string();
    assert_eq!(json_of(&call(&e, "POST", &format!("/api/passes/{key}/authorize"), json!({})).await), (400, json!({ "error": "This connection has no sign-in step" })));
    assert_eq!(
        json_of(&call(&e, "GET", &format!("/api/passes/{key}/tools"), Value::Null).await),
        (400, json!({ "error": "Jira is a key for scripts (JIRA_KEY), not a service the board can call" }))
    );
    assert_eq!(json_of(&call(&e, "GET", "/api/passes/missing/tools", Value::Null).await).0, 404);
}

#[tokio::test]
async fn a_program_on_this_computer() {
    let e = env();
    let script = r#"while IFS= read -r line; do id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p'); [ -z "$id" ] && continue; case "$line" in *initialize*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id";; *tools/list*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo_env"}]}}\n' "$id";; *) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"%s"}]}}\n' "$id" "$FAKE_VALUE";; esac; done"#;
    let home = e.dir.join("home");
    std::fs::write(
        home.join(".claude.json"),
        json!({ "mcpServers": { "tools": { "command": "/bin/sh", "args": ["-c", script], "env": { "FAKE_VALUE": "from-settings" } }, "web": { "type": "http", "url": "https://x.example" } },
                "projects": { home.to_string_lossy(): { "mcpServers": { "near": { "command": "/bin/echo" } } } } })
        .to_string(),
    )
    .unwrap();
    std::fs::write(home.join(".mcp.json"), json!({ "mcpServers": { "proj": { "command": "/bin/echo" } } }).to_string()).unwrap();
    assert_eq!(read_mcp_config("near", &home, &home.join(".claude.json")).unwrap().scope, "local");
    assert_eq!(read_mcp_config("proj", &home, &home.join(".claude.json")).unwrap().scope, "project");
    let bad = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "local", "claudeName": "proj" })).await);
    assert_eq!(bad.1["error"], "proj comes from a project's .mcp.json: the board only starts programs from your own Claude settings");
    assert_eq!(json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "local", "claudeName": "web" })).await).1["error"], "web isn't a program on this computer");
    let (s, v) = json_of(&call(&e, "POST", "/api/passes", json!({ "kind": "local", "claudeName": " tools " })).await);
    assert_eq!((s, v["name"].clone(), v["status"].clone()), (201, json!("tools"), json!("connected")));
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(json_of(&call(&e, "GET", &format!("/api/passes/{id}/tools"), Value::Null).await), (200, json!([{ "name": "echo_env" }])));
    let r = e.sign.pass_call(json!({ "service": "TOOLS", "tool": "echo_env", "passes": [id] })).await;
    assert_eq!(r["body"]["result"], "from-settings");
}

#[test]
fn challenge_is_sha256_base64url() {
    // RFC 7636 appendix B.
    assert_eq!(challenge_of("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert_eq!(esc(r#"a&<>"b"#), "a&#38;&#60;&#62;&#34;b");
    assert_eq!(name_or(Some(&json!("  a \t b  ")), "f"), "a b");
    assert_eq!(name_or(Some(&json!("")), "f"), "f");
}
