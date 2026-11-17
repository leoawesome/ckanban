//! The server's last stop and its HTTP helpers. `Web::answer` gets every request no route took: the web page
//! (`web/dist`, built by `bun run build:web`) for any path outside `/api/`, Bun's JSON 404 (or 415 for a change that
//! isn't JSON) for the rest. Bun's `staticFile` in `src/api/server.ts` did this until P4 removed the Bun server: a file
//! of the build is sent with Bun's content type, any other path gets `index.html` (the UI routes itself).
//! A release build (`--features embed-web`, see build.rs) carries the page inside the binary and serves that copy, as
//! the installed binary has no source folder next to it.

use std::path::{Component, Path, PathBuf};

use bytes::Bytes;
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::header::{CONNECTION, HeaderMap, HeaderValue, UPGRADE};
use hyper::{Method, Request, Response, StatusCode, Uri};

pub type Body = BoxBody<Bytes, hyper::Error>;

mod embedded {
    // `WEB_ASSETS`: (URL path, bytes) of every file of `web/dist`, written by build.rs; empty without `embed-web`.
    include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));
}

/// The files of the page built into this binary (empty unless it was built with `embed-web`).
type Assets = &'static [(&'static str, &'static [u8])];

/// Whether this binary carries the web page (a release build): then no source folder is needed.
pub fn embedded() -> bool {
    !embedded::WEB_ASSETS.is_empty()
}

/// The built web page and the answer for a request no route took.
pub struct Web {
    /// `web/dist` of the source folder (`settings::web_dir`); unused when `assets` has the page.
    dir: PathBuf,
    /// The page built into the binary; when it has files they are served instead of `dir`.
    assets: Assets,
}

impl Web {
    pub fn new(dir: PathBuf) -> std::sync::Arc<Self> {
        Self::with_assets(dir, embedded::WEB_ASSETS)
    }

    fn with_assets(dir: PathBuf, assets: Assets) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Web { dir, assets })
    }

    /// Whether the page is built (built in, or `index.html` there); the server warns at start when it isn't.
    pub fn built(&self) -> bool {
        !self.assets.is_empty() || self.dir.join("index.html").is_file()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The answer to a request no route took (`route()` and `api()`'s ends in Bun's `src/api/server.ts`).
    pub async fn answer<B>(&self, req: &Request<B>) -> Response<Body> {
        let path = req.uri().path();
        if path.starts_with("/api/") {
            // Bun's upload routes come before its JSON-only rule: anything else under them is a plain 404.
            if path == "/api/attachments" || path.starts_with("/api/attachments/") {
                return json_error(StatusCode::NOT_FOUND, "not found");
            }
            let m = req.method();
            let json_type = req
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/json"))
                .unwrap_or(false);
            if (m == Method::POST || m == Method::PATCH || m == Method::PUT) && !json_type {
                return json_error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json");
            }
            return json_error(StatusCode::NOT_FOUND, "not found");
        }
        self.file(path).await
    }

    /// A file of the build, else `index.html`, else Bun's hint to build the page.
    async fn file(&self, path: &str) -> Response<Body> {
        if !self.assets.is_empty() {
            return self.built_in(path);
        }
        if let Some(rel) = relative(path) {
            let f = self.dir.join(&rel);
            if let Ok(bytes) = read_file(&f).await {
                return with_type(bytes, content_type(&f));
            }
        }
        let index = self.dir.join("index.html");
        match read_file(&index).await {
            Ok(bytes) => with_type(bytes, content_type(&index)),
            Err(_) => plain(StatusCode::NOT_FOUND, "UI not built. Run: bun run build:web"),
        }
    }
}

impl Web {
    /// `file` for the page built into the binary: the same lookup on the same normalized path. The list is the
    /// page's few dozen files, fixed at build time, so a plain search is enough.
    fn built_in(&self, path: &str) -> Response<Body> {
        let find = |url: &str| self.assets.iter().find(|(p, _)| *p == url).map(|(_, b)| *b);
        if let Some(rel) = relative(path) {
            let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            let url = format!("/{}", parts.join("/"));
            if let Some(b) = find(&url) {
                return with_static(b, content_type(Path::new(&url)));
            }
        }
        match find("/index.html") {
            Some(b) => with_static(b, content_type(Path::new("index.html"))),
            None => plain(StatusCode::NOT_FOUND, "UI not built. Run: bun run build:web"),
        }
    }
}

fn with_static(bytes: &'static [u8], ty: &'static str) -> Response<Body> {
    let mut r = Response::new(full(Bytes::from_static(bytes)));
    r.headers_mut().insert("content-type", HeaderValue::from_static(ty));
    r
}

/// The path inside the build folder, as Bun's `normalize(decodeURIComponent(...))` gives it, or None when it would
/// leave the folder or can't be decoded.
fn relative(path: &str) -> Option<PathBuf> {
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8().ok()?;
    let mut out = PathBuf::new();
    for c in Path::new(decoded.as_ref()).components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// A regular file's bytes (the build's files are small and fixed: read whole).
async fn read_file(f: &Path) -> std::io::Result<Vec<u8>> {
    let meta = tokio::fs::metadata(f).await?;
    if !meta.is_file() {
        return Err(std::io::Error::other("not a file"));
    }
    tokio::fs::read(f).await
}

/// The content type Bun gives a file (`Bun.file(...).type`) for the kinds a Vite build makes.
pub fn content_type(f: &Path) -> &'static str {
    let ext = f.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html;charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript;charset=utf-8",
        "css" => "text/css;charset=utf-8",
        "json" | "map" => "application/json;charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/vnd.microsoft.icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain;charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn with_type(bytes: Vec<u8>, ty: &'static str) -> Response<Body> {
    let mut r = Response::new(full(Bytes::from(bytes)));
    r.headers_mut().insert("content-type", HeaderValue::from_static(ty));
    r
}

/// `{"error": msg}` as Bun's `HttpError` answers.
pub fn json_error(status: StatusCode, msg: &str) -> Response<Body> {
    let mut r = Response::new(full(Bytes::from(serde_json::json!({ "error": msg }).to_string())));
    *r.status_mut() = status;
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
    r
}

/// The request target as Bun's `new URL(req.url)` reads it (WHATWG URL parsing: `.`/`..` segments and their `%2e`
/// forms resolved, `\` as `/`), so this server routes on the same path Bun would, and passes that path on. Without
/// this a board run could reach a route the Rust board owns through Bun (`/api/x/../profiles/...`), whose copy of the
/// state is stale in board mode. A target the URL parser refuses stays as it is (Bun refuses it too).
pub fn normalize_target<B>(req: &mut Request<B>) {
    let Some(raw) = req.uri().path_and_query().map(|p| p.as_str().to_string()) else { return };
    if !raw.starts_with('/') {
        return;
    }
    let Ok(u) = url::Url::parse(&format!("http://h{raw}")) else { return };
    let mut target = u.path().to_string();
    if let Some(q) = u.query() {
        target.push('?');
        target.push_str(q);
    }
    if target == raw {
        return;
    }
    if let Ok(pq) = target.parse::<hyper::http::uri::PathAndQuery>() {
        let mut parts = req.uri().clone().into_parts();
        parts.path_and_query = Some(pq);
        if let Ok(uri) = Uri::from_parts(parts) {
            *req.uri_mut() = uri;
        }
    }
}

/// A WebSocket (or other) upgrade: `Connection: upgrade` with an `Upgrade` header.
pub fn wants_upgrade(h: &HeaderMap) -> bool {
    h.contains_key(UPGRADE) && connection_tokens(h).iter().any(|t| t == "upgrade")
}

fn connection_tokens(h: &HeaderMap) -> Vec<String> {
    h.get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

pub fn full(b: Bytes) -> Body {
    Full::new(b).map_err(|never| match never {}).boxed()
}

pub fn plain(status: StatusCode, text: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(text.to_string())).map_err(|never| match never {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderName;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn targets_read_like_new_url() {
        let norm = |t: &str| {
            let mut r = Request::get(t).body(()).unwrap();
            normalize_target(&mut r);
            r.uri().path_and_query().unwrap().as_str().to_string()
        };
        assert_eq!(norm("/api/x/../profiles/b/tickets/t/devices"), "/api/profiles/b/tickets/t/devices");
        assert_eq!(norm("/api/x/%2e%2E/profiles"), "/api/profiles");
        assert_eq!(norm("/api/./events?a=1"), "/api/events?a=1");
        assert_eq!(norm("/api/x/.%2e/y"), "/api/y");
        assert_eq!(norm("/../../api/health"), "/api/health");
        assert_eq!(norm("/api/%68ealth?x=a%20b"), "/api/%68ealth?x=a%20b");
        assert_eq!(norm("/api/events"), "/api/events");
    }

    #[test]
    fn upgrade_needs_both_headers() {
        assert!(!wants_upgrade(&headers(&[("upgrade", "websocket")])));
        assert!(!wants_upgrade(&headers(&[("connection", "upgrade")])));
        assert!(wants_upgrade(&headers(&[("connection", "keep-alive, Upgrade"), ("upgrade", "websocket")])));
    }

    #[test]
    fn paths_stay_in_the_build() {
        assert_eq!(relative("/assets/a.js"), Some(PathBuf::from("assets/a.js")));
        assert_eq!(relative("/a%20b.png"), Some(PathBuf::from("a b.png")));
        assert_eq!(relative("/"), None);
        assert_eq!(relative("/x/%2e%2e/%2e%2e/etc/passwd"), None);
        assert_eq!(content_type(Path::new("a/index.html")), "text/html;charset=utf-8");
        assert_eq!(content_type(Path::new("x.mjs")), "text/javascript;charset=utf-8");
        assert_eq!(content_type(Path::new("manifest.webmanifest")), "application/manifest+json");
    }

    #[tokio::test]
    async fn serves_files_index_and_api_errors() {
        let dir = std::env::temp_dir().join(format!("ckweb-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<html>").unwrap();
        std::fs::write(dir.join("assets/a.css"), "b{}").unwrap();
        let web = Web::new(dir.clone());
        let get = |p: &str| Request::get(p).body(()).unwrap();
        let body = |r: Response<Body>| async move { String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap() };
        let r = web.answer(&get("/assets/a.css")).await;
        assert_eq!(r.headers()["content-type"], "text/css;charset=utf-8");
        assert_eq!(body(r).await, "b{}");
        let r = web.answer(&get("/some/route")).await;
        assert_eq!(r.headers()["content-type"], "text/html;charset=utf-8");
        assert_eq!(body(r).await, "<html>");
        let r = web.answer(&get("/api/nope")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(r).await, r#"{"error":"not found"}"#);
        let post = Request::post("/api/nope").header("content-type", "text/plain").body(()).unwrap();
        assert_eq!(web.answer(&post).await.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let put = Request::put("/api/attachments/x.png").body(()).unwrap();
        assert_eq!(web.answer(&put).await.status(), StatusCode::NOT_FOUND);
        std::fs::remove_dir_all(&dir).unwrap();
        let r = web.answer(&get("/")).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn serves_the_built_in_page_without_a_folder() {
        static ASSETS: &[(&str, &[u8])] = &[("/index.html", b"<html>"), ("/assets/a b.js", b"x()")];
        let web = Web::with_assets(PathBuf::from("/nonexistent/web/dist"), ASSETS);
        assert!(web.built());
        let get = |p: &str| Request::get(p).body(()).unwrap();
        let body = |r: Response<Body>| async move { String::from_utf8(r.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap() };
        let r = web.answer(&get("/assets/a%20b.js")).await;
        assert_eq!(r.headers()["content-type"], "text/javascript;charset=utf-8");
        assert_eq!(body(r).await, "x()");
        for p in ["/", "/board/x", "/assets/../../etc/passwd", "/assets/%2e%2e/index.html"] {
            let r = web.answer(&get(p)).await;
            assert_eq!(r.headers()["content-type"], "text/html;charset=utf-8", "{p}");
            assert_eq!(body(r).await, "<html>", "{p}");
        }
        assert_eq!(web.answer(&get("/api/nope")).await.status(), StatusCode::NOT_FOUND);
    }
}
