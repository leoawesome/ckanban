//! `ckanban browser-mcp --id <id> --name <name> --dir <data folder> --out <folder>` (src/browser/browser-mcp.ts): a
//! stdio MCP server that drives one board browser over its local debugging port. Each run gets one per browser it may
//! use, named browser-<id>, so its tools are mcp__browser-<id>__browser_*. Same tools, texts and files as Bun's: the
//! tool list (tools.json) and the page scripts (page-lib.js, snapshot.js) are Bun's own, written out by
//! `bun -e` from browser-mcp.ts. Only 127.0.0.1 is dialled (ckanban_board::browsers::cdp).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ckanban_board::browsers::cdp::{Cdp, CdpError, PortFile, port_matches, read_port_file};
use ckanban_board::runs::js::{self as bjs, len16, number, stringify, to_string, truthy};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const RESULT_MAX: usize = 20_000;
const LOAD_WAIT: Duration = Duration::from_secs(30);
const PAGE_LIB: &str = include_str!("page-lib.js");
const SNAPSHOT_JS: &str = include_str!("snapshot.js");
const TOOLS_JSON: &str = include_str!("tools.json");
const USAGE: &str = "usage: ckanban browser-mcp --id <id> --dir <data folder> [--name <name>] [--out <folder>]";

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

async fn sleep(n: u64) {
    tokio::time::sleep(ms(n)).await;
}

/// `JSON.stringify(v)`.
fn q(v: &Value) -> String {
    stringify(v)
}

/// A missing or null argument as JS `?? null`.
fn or_null(a: &Value, k: &str) -> Value {
    a.get(k).cloned().unwrap_or(Value::Null)
}

/// `${x}` of an argument: "undefined" when missing.
fn show(v: Option<&Value>) -> String {
    v.map(to_string).unwrap_or_else(|| "undefined".into())
}

/// `String(a[k] ?? "")`.
fn str_or_empty(a: &Value, k: &str) -> String {
    match a.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(v) => to_string(v),
    }
}

/// `JSON.stringify(v, null, 1)`: the compact text re-indented, one space per level.
fn pretty1(v: &Value) -> String {
    let compact = stringify(v);
    let mut out = String::new();
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    let chars: Vec<char> = compact.chars().collect();
    let mut i = 0;
    let nl = |out: &mut String, d: usize| {
        out.push('\n');
        out.push_str(&" ".repeat(d));
    };
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                out.push(c);
            }
            '{' | '[' => {
                let close = if c == '{' { '}' } else { ']' };
                if chars.get(i + 1) == Some(&close) {
                    out.push(c);
                    out.push(close);
                    i += 2;
                    continue;
                }
                out.push(c);
                depth += 1;
                nl(&mut out, depth);
            }
            '}' | ']' => {
                depth -= 1;
                nl(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(',');
                nl(&mut out, depth);
            }
            ':' => out.push_str(": "),
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

/// The first `n` UTF-16 units of `s`.
fn head16(s: &str, n: usize) -> &str {
    bjs::head16(s, n)
}

fn first_line(s: &str) -> String {
    s.split('\n').next().unwrap_or("").to_string()
}

/// A key press as CDP wants it (`keyEvent`).
#[derive(Debug, PartialEq)]
pub struct Key {
    modifiers: u32,
    key: String,
    code: u32,
    text: Option<String>,
}

fn known_key(name: &str) -> Option<(u32, &'static str, Option<&'static str>)> {
    Some(match name {
        "Enter" => (13, "Enter", Some("\r")),
        "Tab" => (9, "Tab", None),
        "Escape" => (27, "Escape", None),
        "Backspace" => (8, "Backspace", None),
        "Delete" => (46, "Delete", None),
        "Space" => (32, " ", Some(" ")),
        "ArrowUp" => (38, "ArrowUp", None),
        "ArrowDown" => (40, "ArrowDown", None),
        "ArrowLeft" => (37, "ArrowLeft", None),
        "ArrowRight" => (39, "ArrowRight", None),
        "PageUp" => (33, "PageUp", None),
        "PageDown" => (34, "PageDown", None),
        "Home" => (36, "Home", None),
        "End" => (35, "End", None),
        _ => return None,
    })
}

fn modifier(name: &str) -> Option<u32> {
    Some(match name {
        "Alt" => 1,
        "Control" | "Ctrl" => 2,
        "Meta" | "Cmd" | "Command" => 4,
        "Shift" => 8,
        _ => return None,
    })
}

/// "Meta+A", "Enter", "a": the CDP key events for it.
pub fn key_event(spec: &str) -> Result<Key, String> {
    let parts: Vec<&str> = spec.split('+').map(bjs::trim).filter(|p| !p.is_empty()).collect();
    let Some((last, mods)) = parts.split_last() else { return Err("give a key, like Enter or Meta+A".into()) };
    let mut modifiers = 0;
    for m in mods {
        modifiers |= modifier(m).ok_or_else(|| format!("unknown modifier {m} (use Alt, Control, Meta or Shift)"))?;
    }
    if let Some((code, key, text)) = known_key(last) {
        return Ok(Key { modifiers, key: key.into(), code, text: text.map(String::from) });
    }
    if len16(last) == 1 {
        let ch = if modifiers & 8 != 0 { last.to_uppercase() } else { last.to_string() };
        let code = ch.to_uppercase().encode_utf16().next().unwrap_or(0) as u32;
        let text = if modifiers & !8 != 0 { None } else { Some(ch.clone()) };
        return Ok(Key { modifiers, key: ch, code, text });
    }
    Err(format!("unknown key {last}"))
}

/// `siteOk`: http and https pages (a bare name gets https://), and about:blank.
fn site_ok(url: &str) -> Result<String, String> {
    let s = bjs::trim(url);
    if s == "about:blank" {
        return Ok(s.into());
    }
    let full = if ckanban_board::browsers::js::has_scheme(s) { s.to_string() } else { format!("https://{s}") };
    let u = url::Url::parse(&full).map_err(|_| format!("not a web address: {url}"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err("only http and https pages can be opened".into());
    }
    Ok(u.to_string())
}

/// `path.join` of node: the parts joined, then `.` and `..` folded.
fn join_norm(base: &str, parts: &[&str]) -> PathBuf {
    let mut p = PathBuf::from(base);
    for x in parts {
        p.push(x);
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

struct State {
    cdp: Option<Arc<Cdp>>,
    own: HashSet<String>,
    /// (targetId, sessionId) of the tab this run works in.
    current: Option<(String, String)>,
}

pub struct BrowserMcp {
    id: String,
    name: String,
    dir: PathBuf,
    out: PathBuf,
    port: u16,
    state: Arc<Mutex<State>>,
    notes: Arc<Mutex<Vec<String>>>,
    /// Serialises connecting, so overlapping calls share one connection.
    connecting: tokio::sync::Mutex<()>,
}

type R<T> = Result<T, String>;

fn cdp_err(e: CdpError) -> String {
    e.0
}

impl BrowserMcp {
    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().expect("state")
    }

    fn not_running(&self) -> String {
        format!("The board browser \"{}\" isn't running and couldn't be started. Tell the user it isn't available right now; don't use another browser in its place.", self.name)
    }

    /// Asks the daemon to start the browser when it isn't running.
    async fn ensure(&self) {
        let Ok(c) = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(45)).build() else { return };
        let id = super::http::enc(&self.id);
        let _ = c.post(format!("http://localhost:{}/api/board-browsers/{id}/ensure", self.port)).send().await;
    }

    async fn ready_port(&self) -> Option<PortFile> {
        let pf = read_port_file(&self.dir).await?;
        port_matches(&pf, ms(2000)).await.then_some(pf)
    }

    async fn connect(&self) -> R<Arc<Cdp>> {
        let _g = self.connecting.lock().await;
        {
            let mut st = self.st();
            if let Some(c) = &st.cdp
                && !c.closed()
            {
                return Ok(c.clone());
            }
            st.cdp = None;
            st.current = None;
        }
        let pf = match self.ready_port().await {
            Some(pf) => pf,
            None => {
                // Not running (it crashed, or was closed): the daemon starts it again, then the new port is read.
                self.ensure().await;
                self.ready_port().await.ok_or_else(|| self.not_running())?
            }
        };
        let (cdp, mut events) = Cdp::connect(pf.port, &pf.path).await.map_err(|_| self.not_running())?;
        let (c2, state, notes) = (Arc::downgrade(&cdp), self.state.clone(), self.notes.clone());
        tokio::spawn(async move {
            while let Some((method, params, session)) = events.recv().await {
                if method == "Page.javascriptDialogOpening"
                    && let Some(sid) = session
                {
                    // An alert or confirm would freeze the page: dismiss it (never confirm), and say so in the next answer.
                    let kind = params.get("type");
                    let accept = matches!(kind.and_then(Value::as_str), Some("alert" | "beforeunload"));
                    if let Some(c) = c2.upgrade() {
                        tokio::spawn(async move {
                            let _ = c.send("Page.handleJavaScriptDialog", json!({ "accept": accept }), Some(&sid), ms(30_000)).await;
                        });
                    }
                    let msg = match params.get("message") {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => to_string(v),
                    };
                    notes.lock().expect("notes").push(format!(
                        "The page showed a {} dialog (\"{}\"); it was {}.",
                        show(kind),
                        head16(&msg, 200),
                        if accept { "closed" } else { "dismissed (cancelled)" }
                    ));
                }
                if method == "Target.detachedFromTarget" {
                    let mut st = state.lock().expect("state");
                    if st.current.as_ref().is_some_and(|c| params.get("sessionId").and_then(Value::as_str) == Some(c.1.as_str())) {
                        st.current = None;
                    }
                }
            }
        });
        self.st().cdp = Some(cdp.clone());
        Ok(cdp)
    }

    async fn send(&self, method: &str, params: Value, session: Option<&str>) -> R<Value> {
        let cdp = self.connect().await?;
        cdp.send(method, params, session, ms(30_000)).await.map_err(cdp_err)
    }

    async fn attach(&self, target: &str) -> R<(String, String)> {
        let r = self.send("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None).await?;
        let sid = r.get("sessionId").map(to_string).unwrap_or_else(|| "undefined".into());
        let _ = self.send("Page.enable", json!({}), Some(&sid)).await;
        let cur = (target.to_string(), sid);
        self.st().current = Some(cur.clone());
        Ok(cur)
    }

    async fn new_tab(&self, url: &str) -> R<(String, String)> {
        let cdp = self.connect().await?;
        let url = site_ok(url)?;
        let r = cdp.send("Target.createTarget", json!({ "url": url, "background": true }), None, ms(30_000)).await.map_err(cdp_err)?;
        let target = r.get("targetId").map(to_string).unwrap_or_else(|| "undefined".into());
        self.st().own.insert(target.clone());
        self.attach(&target).await
    }

    /// The tab this run works in: the selected one, else a new tab of its own.
    async fn page(&self) -> R<(String, String)> {
        let cdp = self.connect().await?;
        let cur = self.st().current.clone();
        if let Some(c) = cur {
            if cdp.send("Target.getTargetInfo", json!({ "targetId": c.0 }), None, ms(30_000)).await.is_ok() {
                return Ok(c);
            }
            let mut st = self.st();
            st.own.remove(&c.0);
            st.current = None;
        }
        self.new_tab("about:blank").await
    }

    /// The page script's value (None: undefined). `timeout`: how long to wait for the page.
    async fn evaluate(&self, expression: &str, sid: &str, timeout: Duration) -> R<Option<Value>> {
        let cdp = self.connect().await?;
        let p = json!({ "expression": expression, "returnByValue": true, "awaitPromise": true, "userGesture": true });
        let r = cdp.send("Runtime.evaluate", p, Some(sid), timeout).await.map_err(cdp_err)?;
        if let Some(ex) = r.get("exceptionDetails").filter(|v| truthy(Some(v))) {
            let d = ex.get("exception").and_then(|e| e.get("description")).filter(|v| !v.is_null()).or_else(|| ex.get("text").filter(|v| !v.is_null()));
            let text = d.map(to_string).unwrap_or_else(|| "the page script failed".into());
            return Err(first_line(&text));
        }
        Ok(r.get("result").and_then(|x| x.get("value")).cloned())
    }

    async fn eval30(&self, expression: &str, sid: &str) -> R<Option<Value>> {
        self.evaluate(expression, sid, ms(30_000)).await
    }

    fn left(end: Instant) -> Duration {
        let rest = end.saturating_duration_since(Instant::now()).as_millis() as u64;
        ms(rest.clamp(500, 5000))
    }

    async fn wait_ready(&self, sid: &str) -> bool {
        let end = Instant::now() + LOAD_WAIT;
        sleep(150).await;
        while Instant::now() < end {
            if let Ok(Some(Value::String(s))) = self.evaluate("document.readyState", sid, Self::left(end)).await
                && s == "complete"
            {
                return true;
            }
            sleep(250).await;
        }
        false
    }

    async fn where_(&self, sid: &str) -> String {
        match self.evaluate("({ t: document.title, u: location.href })", sid, ms(5000)).await {
            Ok(v) => {
                let v = v.unwrap_or(Value::Null);
                let t = v.get("t").filter(|x| truthy(Some(x))).map(to_string).unwrap_or_else(|| "(no title)".into());
                format!("Page: {t}\nAddress: {}", show(v.get("u")))
            }
            Err(_) => "(The page is busy and didn't answer yet.)".into(),
        }
    }

    async fn tabs(&self) -> R<Vec<(String, String, String)>> {
        let r = self.send("Target.getTargets", json!({}), None).await?;
        let list = r.get("targetInfos").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(list
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("page"))
            .map(|t| (show(t.get("targetId")), t.get("title").map(to_string).unwrap_or_default(), show(t.get("url"))))
            .collect())
    }

    async fn point(&self, a: &Value, sid: &str) -> R<Value> {
        let js = format!(
            "(() => {{{PAGE_LIB}\nconst el = ckEl({}, {});\nel.scrollIntoView({{ block: \"center\", inline: \"center\" }});\nconst r = el.getBoundingClientRect();\nconst x = r.left + r.width / 2, y = r.top + r.height / 2;\nconst top = document.elementFromPoint(x, y);\nreturn {{ x, y, covered: !!top && top !== el && !el.contains(top) && !top.contains(el) }};\n}})()",
            q(&or_null(a, "ref")),
            q(&or_null(a, "selector"))
        );
        Ok(self.eval30(&js, sid).await?.unwrap_or(Value::Null))
    }

    async fn key(&self, spec: &str, sid: &str) -> R<()> {
        let cdp = self.connect().await?;
        let k = key_event(spec)?;
        let mut down = Map::new();
        down.insert("type".into(), json!(if k.text.is_some() { "keyDown" } else { "rawKeyDown" }));
        let mut base = Map::new();
        base.insert("modifiers".into(), json!(k.modifiers));
        base.insert("key".into(), json!(k.key));
        base.insert("windowsVirtualKeyCode".into(), json!(k.code));
        base.insert("nativeVirtualKeyCode".into(), json!(k.code));
        down.extend(base.clone());
        if let Some(t) = &k.text {
            down.insert("text".into(), json!(t));
            down.insert("unmodifiedText".into(), json!(t));
        }
        cdp.send("Input.dispatchKeyEvent", Value::Object(down), Some(sid), ms(30_000)).await.map_err(cdp_err)?;
        let mut up = Map::new();
        up.insert("type".into(), json!("keyUp"));
        up.extend(base);
        cdp.send("Input.dispatchKeyEvent", Value::Object(up), Some(sid), ms(30_000)).await.map_err(cdp_err)?;
        Ok(())
    }

    /// One tool: its text, or (screenshot) its content blocks.
    async fn run(&self, name: &str, a: &Value) -> R<Value> {
        let text = |s: String| Ok(Value::String(s));
        match name {
            "browser_tabs" => {
                let action = match a.get("action") {
                    None | Some(Value::Null) => "list".to_string(),
                    Some(v) => to_string(v),
                };
                if action == "new" {
                    let url = if truthy(a.get("url")) { to_string(&a["url"]) } else { "about:blank".into() };
                    let s = self.new_tab(&url).await?;
                    if truthy(a.get("url")) {
                        self.wait_ready(&s.1).await;
                    }
                    return text(format!("Opened a new tab of your own.\n{}", self.where_(&s.1).await));
                }
                let list = self.tabs().await?;
                let current = self.st().current.as_ref().map(|c| c.0.clone());
                let pick = || -> R<usize> {
                    let i = match a.get("index") {
                        None => list.iter().position(|t| Some(&t.0) == current.as_ref()).map(|i| i as f64).unwrap_or(-1.0),
                        Some(v) => number(Some(v)),
                    };
                    if i >= 0.0 && i.fract() == 0.0 && (i as usize) < list.len() {
                        Ok(i as usize)
                    } else {
                        Err("no tab with that number: call browser_tabs with action list".into())
                    }
                };
                if action == "select" {
                    let i = pick()?;
                    let url = &list[i].2;
                    if !(url.starts_with("http:") || url.starts_with("https:") || url.starts_with("about:blank")) {
                        return Err("Only web page tabs can be used.".into());
                    }
                    let s = self.attach(&list[i].0).await?;
                    return text(format!("Working in tab {i} now.\n{}", self.where_(&s.1).await));
                }
                if action == "close" {
                    let i = pick()?;
                    let t = list[i].0.clone();
                    if !self.st().own.contains(&t) {
                        return Err("That tab wasn't opened by this task: leave it open.".into());
                    }
                    self.send("Target.closeTarget", json!({ "targetId": t }), None).await?;
                    let mut st = self.st();
                    st.own.remove(&t);
                    if st.current.as_ref().is_some_and(|c| c.0 == t) {
                        st.current = None;
                    }
                    return text("Closed your tab.".into());
                }
                if list.is_empty() {
                    return text("No tabs are open.".into());
                }
                let st = self.st();
                let cur = st.current.as_ref().map(|c| c.0.as_str());
                text(
                    list.iter()
                        .enumerate()
                        .map(|(i, t)| {
                            let title = if t.1.is_empty() { "(no title)" } else { &t.1 };
                            let yours = if st.own.contains(&t.0) { " (yours)" } else { "" };
                            let here = if Some(t.0.as_str()) == cur { " (current)" } else { "" };
                            format!("{i}: {title} - {}{yours}{here}", t.2)
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                )
            }
            "browser_navigate" => {
                let url = site_ok(&str_or_empty(a, "url"))?;
                let s = self.page().await?;
                let r = self.send("Page.navigate", json!({ "url": url }), Some(&s.1)).await?;
                if let Some(e) = r.get("errorText").filter(|v| truthy(Some(v))) {
                    return Err(format!("couldn't open {url}: {}", to_string(e)));
                }
                let ready = self.wait_ready(&s.1).await;
                text(format!("{}{}", self.where_(&s.1).await, if ready { "" } else { "\n(Still loading: use browser_wait_for.)" }))
            }
            "browser_navigate_back" => {
                let s = self.page().await?;
                self.eval30("history.back()", &s.1).await?;
                self.wait_ready(&s.1).await;
                text(self.where_(&s.1).await)
            }
            "browser_snapshot" => {
                let s = self.page().await?;
                let body = self.eval30(SNAPSHOT_JS, &s.1).await?;
                let body = body.filter(|v| truthy(Some(v))).map(|v| to_string(&v)).unwrap_or_else(|| "(the page shows nothing yet)".into());
                text(format!("{}\n\n{body}", self.where_(&s.1).await))
            }
            "browser_click" => {
                let s = self.page().await?;
                let cdp = self.connect().await?;
                let p = self.point(a, &s.1).await?;
                let (x, y) = (p.get("x").cloned().unwrap_or(Value::Null), p.get("y").cloned().unwrap_or(Value::Null));
                let count = if truthy(a.get("doubleClick")) { 2 } else { 1 };
                for params in [
                    json!({ "type": "mouseMoved", "x": x, "y": y }),
                    json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": count }),
                    json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": count }),
                ] {
                    cdp.send("Input.dispatchMouseEvent", params, Some(&s.1), ms(30_000)).await.map_err(cdp_err)?;
                }
                sleep(400).await;
                let covered = if truthy(p.get("covered")) { " (Another element covered it: check the result with browser_snapshot.)" } else { "" };
                text(format!("Clicked.{covered}\n{}", self.where_(&s.1).await))
            }
            "browser_type" => {
                let s = self.page().await?;
                let js = format!(
                    "(() => {{{PAGE_LIB}\nconst el = ckEl({}, {});\nel.scrollIntoView({{ block: \"center\" }}); el.focus();\nif (\"select\" in el && typeof el.select === \"function\") el.select();\nelse if (el.isContentEditable) {{ const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }}\n}})()",
                    q(&or_null(a, "ref")),
                    q(&or_null(a, "selector"))
                );
                self.eval30(&js, &s.1).await?;
                self.send("Input.insertText", json!({ "text": str_or_empty(a, "text") }), Some(&s.1)).await?;
                let submit = truthy(a.get("submit"));
                if submit {
                    self.key("Enter", &s.1).await?;
                }
                sleep(200).await;
                text(format!("Typed.{}", if submit { " Pressed Enter." } else { "" }))
            }
            "browser_press_key" => {
                let s = self.page().await?;
                self.key(&str_or_empty(a, "key"), &s.1).await?;
                sleep(200).await;
                text(format!("Pressed {}.", show(a.get("key"))))
            }
            "browser_select_option" => {
                let s = self.page().await?;
                let want: Vec<Value> = a.get("values").and_then(Value::as_array).map(|v| v.iter().map(|x| Value::String(to_string(x))).collect()).unwrap_or_default();
                let js = format!(
                    "(() => {{{PAGE_LIB}\nconst el = ckEl({}, {});\nconst want = {};\nlet n = 0;\nfor (const o of el.options || []) {{ o.selected = want.includes(o.value) || want.includes(o.text.trim()); if (o.selected) n++; }}\nel.dispatchEvent(new Event(\"input\", {{ bubbles: true }})); el.dispatchEvent(new Event(\"change\", {{ bubbles: true }}));\nreturn n;\n}})()",
                    q(&or_null(a, "ref")),
                    q(&or_null(a, "selector")),
                    q(&Value::Array(want))
                );
                let n = self.eval30(&js, &s.1).await?;
                text(if truthy(n.as_ref()) { format!("Selected {} option(s).", show(n.as_ref())) } else { "No option matched.".into() })
            }
            "browser_evaluate" => {
                let s = self.page().await?;
                let f = str_or_empty(a, "function");
                let call = if truthy(a.get("ref")) {
                    format!("(() => {{{PAGE_LIB}\nreturn ({f})(ckEl({}, null));}})()", q(&a["ref"]))
                } else {
                    format!("({f})()")
                };
                let v = self.eval30(&call, &s.1).await?;
                let t = match v {
                    None => "undefined".to_string(),
                    Some(v) => pretty1(&v),
                };
                let n = len16(&t);
                text(if n > RESULT_MAX { format!("{}\n… (cut, {n} characters in all)", head16(&t, RESULT_MAX)) } else { t })
            }
            "browser_wait_for" => {
                let s = self.page().await?;
                let has = |k: &str| a.get(k).is_some();
                if has("time") && !has("text") && !has("textGone") && !has("selector") {
                    let mut secs = number(a.get("time"));
                    if secs.is_nan() {
                        secs = 0.0;
                    }
                    let secs = secs.clamp(0.0, 60.0);
                    tokio::time::sleep(Duration::from_secs_f64(secs)).await;
                    return text(format!("Waited {}s.", to_string(&json!(secs))));
                }
                let mut t = number(a.get("timeout"));
                if t.is_nan() || t == 0.0 {
                    t = 30.0;
                }
                let end = Instant::now() + Duration::from_secs_f64(t.clamp(1.0, 120.0));
                let part = |k: &str, f: &dyn Fn(String) -> String| if has(k) { f(q(&Value::String(to_string(&a[k])))) } else { "true".into() };
                let check = format!(
                    "(() => {{ const t = document.body ? document.body.innerText : \"\";\n  return {}\n    && {}\n    && {}; }})()",
                    part("text", &|x| format!("t.includes({x})")),
                    part("textGone", &|x| format!("!t.includes({x})")),
                    part("selector", &|x| format!("!!document.querySelector({x})")),
                );
                while Instant::now() < end {
                    if let Ok(v) = self.evaluate(&check, &s.1, Self::left(end)).await
                        && truthy(v.as_ref())
                    {
                        return text(format!("Ready.\n{}", self.where_(&s.1).await));
                    }
                    sleep(400).await;
                }
                Err("Timed out waiting. Take a browser_snapshot to see what the page shows.".into())
            }
            "browser_take_screenshot" => {
                let s = self.page().await?;
                let mut opts = Map::new();
                opts.insert("format".into(), json!("png"));
                if truthy(a.get("fullPage")) {
                    let m = self.send("Page.getLayoutMetrics", json!({}), Some(&s.1)).await?;
                    let size = m.get("cssContentSize").filter(|v| !v.is_null()).or_else(|| m.get("contentSize")).cloned().unwrap_or(Value::Null);
                    let h = number(size.get("height"));
                    opts.insert("captureBeyondViewport".into(), json!(true));
                    opts.insert(
                        "clip".into(),
                        json!({ "x": 0, "y": 0, "width": size.get("width").cloned().unwrap_or(Value::Null), "height": if h.is_nan() { Value::Null } else { json!(h.min(16_000.0)) }, "scale": 1 }),
                    );
                }
                let r = self.send("Page.captureScreenshot", Value::Object(opts), Some(&s.1)).await?;
                let data = r.get("data").map(to_string).unwrap_or_default();
                std::fs::create_dir_all(&self.out).map_err(|e| e.to_string())?;
                let name = if truthy(a.get("filename")) { shot_name(&to_string(&a["filename"])) } else { format!("{}-{}.png", self.id, now_iso().replace([':', '.'], "-")) };
                let file = self.out.join(name);
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).unwrap_or_default();
                std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
                Ok(json!([{ "type": "image", "data": data, "mimeType": "image/png" }, { "type": "text", "text": format!("Saved to {}", file.display()) }]))
            }
            "browser_file_upload" => {
                let s = self.page().await?;
                let paths: Vec<String> = a.get("paths").and_then(Value::as_array).map(|v| v.iter().map(to_string).collect()).unwrap_or_default();
                for p in &paths {
                    if !Path::new(p).is_absolute() || !Path::new(p).exists() {
                        return Err(format!("no file at {p}"));
                    }
                }
                let expr = format!("(() => {{{PAGE_LIB}\nreturn ckEl({}, {});}})()", q(&or_null(a, "ref")), q(&or_null(a, "selector")));
                let r = self.send("Runtime.evaluate", json!({ "expression": expr }), Some(&s.1)).await?;
                let ex = r.get("exceptionDetails").filter(|v| truthy(Some(v)));
                let object = r.get("result").and_then(|x| x.get("objectId")).filter(|v| truthy(Some(v))).cloned();
                if ex.is_some() || object.is_none() {
                    let d = ex.and_then(|e| e.get("exception")).and_then(|e| e.get("description")).filter(|v| !v.is_null()).map(to_string);
                    return Err(first_line(&d.unwrap_or_else(|| "element not found".into())));
                }
                self.send("DOM.setFileInputFiles", json!({ "files": paths, "objectId": object }), Some(&s.1)).await?;
                text(format!("Added {} file(s).", paths.len()))
            }
            _ => Err(format!("unknown tool {name}")),
        }
    }

    async fn call(&self, name: &str, args: Option<&Value>) -> Value {
        if !tools().iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)) {
            return json!({ "content": [{ "type": "text", "text": format!("unknown tool {name}") }], "isError": true });
        }
        let empty = json!({});
        let a = match args {
            Some(v @ (Value::Object(_) | Value::Array(_))) => v,
            _ => &empty,
        };
        match self.run(name, a).await {
            Ok(out) => {
                let mut content = match out {
                    Value::String(s) => vec![json!({ "type": "text", "text": s })],
                    Value::Array(v) => v,
                    other => vec![other],
                };
                let notes: Vec<String> = self.notes.lock().expect("notes").drain(..).collect();
                if !notes.is_empty() {
                    content.push(json!({ "type": "text", "text": notes.join("\n") }));
                }
                json!({ "content": content })
            }
            Err(e) => {
                // A dropped connection (Chrome restarted): the next call connects again.
                let mut st = self.st();
                if st.cdp.as_ref().is_some_and(|c| c.closed()) {
                    st.cdp = None;
                }
                json!({ "content": [{ "type": "text", "text": e }], "isError": true })
            }
        }
    }

    async fn handle(&self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let reply = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        let params = msg.get("params");
        match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                let asked = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
                let v = asked.filter(|a| PROTOCOL_VERSIONS.contains(a)).unwrap_or(PROTOCOL_VERSIONS[0]);
                reply(json!({
                    "protocolVersion": v,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": format!("browser-{}", self.id), "version": super::VERSION },
                    "instructions": format!("Tools for the board browser \"{}\": a Chrome the board keeps with its own saved logins, separate from the user's Chrome. Work in a tab of your own; never close tabs you didn't open.", self.name),
                }))
            }
            Some("ping") => reply(json!({})),
            Some("tools/list") => {
                let list: Vec<Value> = tools()
                    .iter()
                    .map(|t| {
                        json!({ "name": t["name"], "description": format!("{} (Board browser \"{}\".)", show(t.get("description")), self.name), "inputSchema": t["inputSchema"] })
                    })
                    .collect();
                reply(json!({ "tools": list }))
            }
            Some("tools/call") => {
                let name = match params.and_then(|p| p.get("name")) {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => to_string(v),
                };
                reply(self.call(&name, params.and_then(|p| p.get("arguments"))).await)
            }
            _ => {
                if id.is_null() {
                    return None;
                }
                let m = show(msg.get("method"));
                Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {m}") } }))
            }
        }
    }

    /// The run ended: close the tabs this run opened (never others), then let go of the browser.
    async fn end(&self) {
        let (cdp, own) = {
            let mut st = self.st();
            (st.cdp.take(), st.own.iter().cloned().collect::<Vec<_>>())
        };
        if let Some(c) = cdp
            && !c.closed()
        {
            let closes = own.iter().map(|t| c.send("Target.closeTarget", json!({ "targetId": t }), None, ms(3000)));
            futures_util::future::join_all(closes).await;
            c.close();
        }
    }
}

fn tools() -> &'static Vec<Value> {
    static T: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    T.get_or_init(|| serde_json::from_str(TOOLS_JSON).expect("tools.json"))
}

fn now_iso() -> String {
    ckanban_core::time::iso(ckanban_core::time::now_ms())
}

/// The screenshot's file name from `filename`: node's basename, runs of other than `[\w.-]` made "-", ".png" at the end.
fn shot_name(f: &str) -> String {
    let trimmed = f.trim_end_matches('/');
    let base = trimmed.rsplit('/').next().unwrap_or("");
    let mut s = String::new();
    let mut run = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
            s.push(c);
            run = false;
        } else if !run {
            s.push('-');
            run = true;
        }
    }
    if s.len() >= 4 && s[s.len() - 4..].eq_ignore_ascii_case(".png") {
        s.truncate(s.len() - 4);
    }
    s + ".png"
}

fn arg<'a>(argv: &'a [String], name: &str) -> Option<&'a str> {
    let i = argv.iter().position(|a| a == &format!("--{name}"))?;
    argv.get(i + 1).map(String::as_str)
}

/// `serveBrowserMcp(argv)`.
pub fn run(argv: &[String]) -> u8 {
    let (Some(id), Some(dir)) = (arg(argv, "id"), arg(argv, "dir")) else {
        eprintln!("{USAGE}");
        return 1;
    };
    let out = arg(argv, "out").map(PathBuf::from).unwrap_or_else(|| join_norm(dir, &["..", "..", "browser-files", id]));
    let mcp = Arc::new(BrowserMcp {
        id: id.into(),
        name: arg(argv, "name").unwrap_or(id).into(),
        dir: dir.into(),
        out,
        port: super::board_port(),
        state: Arc::new(Mutex::new(State { cdp: None, own: HashSet::new(), current: None })),
        notes: Arc::new(Mutex::new(Vec::new())),
        connecting: tokio::sync::Mutex::new(()),
    });
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("ckanban: {e}");
            return 1;
        }
    };
    rt.block_on(serve(mcp));
    0
}

async fn finish(mcp: &BrowserMcp) {
    let _ = tokio::time::timeout(ms(4000), mcp.end()).await;
}

async fn serve(mcp: Arc<BrowserMcp>) {
    use tokio::signal::unix::{SignalKind, signal};
    // Claude Code ends a tool server with a signal (not only by closing its input): close this run's tabs either way.
    let m2 = mcp.clone();
    tokio::spawn(async move {
        let (Ok(mut a), Ok(mut b), Ok(mut c)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt()), signal(SignalKind::hangup())) else { return };
        tokio::select! { _ = a.recv() => {}, _ = b.recv() => {}, _ = c.recv() => {} }
        finish(&m2).await;
        std::process::exit(0);
    });
    let stdout = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let write = move |v: Value| {
        let o = stdout.clone();
        async move {
            let line = stringify(&v) + "\n";
            let mut o = o.lock().await;
            let _ = o.write_all(line.as_bytes()).await;
            let _ = o.flush().await;
        }
    };
    let mut pending = Vec::new();
    let handle = |line: &str, pending: &mut Vec<tokio::task::JoinHandle<()>>| {
        if bjs::trim(line).is_empty() {
            return;
        }
        let Some(msg) = bjs::parse(line) else {
            pending.push(tokio::spawn(write(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } }))));
            return;
        };
        let msgs = match msg {
            Value::Array(v) => v,
            m => vec![m],
        };
        for m in msgs {
            let (mcp, w) = (mcp.clone(), write.clone());
            pending.push(tokio::spawn(async move {
                if let Some(r) = mcp.handle(&m).await {
                    w(r).await;
                }
            }));
        }
    };
    let mut stdin = tokio::io::stdin();
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = match stdin.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            handle(&String::from_utf8_lossy(&line[..line.len() - 1]), &mut pending);
        }
    }
    let rest = String::from_utf8_lossy(&buf).into_owned();
    handle(&rest, &mut pending);
    for p in pending {
        let _ = p.await;
    }
    finish(&mcp).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_like_bun() {
        assert_eq!(key_event("Enter").unwrap(), Key { modifiers: 0, key: "Enter".into(), code: 13, text: Some("\r".into()) });
        assert_eq!(key_event("Meta+a").unwrap(), Key { modifiers: 4, key: "a".into(), code: 65, text: None });
        assert_eq!(key_event("x").unwrap(), Key { modifiers: 0, key: "x".into(), code: 88, text: Some("x".into()) });
        assert_eq!(key_event("Shift+x").unwrap(), Key { modifiers: 8, key: "X".into(), code: 88, text: Some("X".into()) });
        assert!(key_event("Hyper+x").is_err());
        assert_eq!(key_event("").unwrap_err(), "give a key, like Enter or Meta+A");
        assert_eq!(key_event("F13").unwrap_err(), "unknown key F13");
    }

    #[test]
    fn sites() {
        assert_eq!(site_ok("example.com").unwrap(), "https://example.com/");
        assert_eq!(site_ok(" about:blank ").unwrap(), "about:blank");
        assert_eq!(site_ok("file:///etc/passwd").unwrap_err(), "only http and https pages can be opened");
        assert_eq!(site_ok("http://").unwrap_err(), "not a web address: http://");
    }

    #[test]
    fn json_indent_one() {
        assert_eq!(pretty1(&json!({ "a": [1, {}], "b": "x:,{" , "c": [] })), "{\n \"a\": [\n  1,\n  {}\n ],\n \"b\": \"x:,{\",\n \"c\": []\n}");
        assert_eq!(pretty1(&json!("s")), "\"s\"");
    }

    #[test]
    fn names_and_paths() {
        assert_eq!(shot_name("../a b/My Shot!.PNG"), "My-Shot-.png");
        assert_eq!(shot_name("x"), "x.png");
        assert_eq!(join_norm("/d/profiles/biz", &["..", "..", "browser-files", "biz"]), PathBuf::from("/d/browser-files/biz"));
    }
}
