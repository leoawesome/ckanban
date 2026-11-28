//! The daemon's HTTP API as `BoardClient` in src/cli/client.ts calls it: same paths, bodies, headers and errors.
//! Answers stay loose JSON (serde_json::Value): the tools read them the way the Bun tools read theirs.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::Request;
use hyper_util::client::legacy::Client as HyperClient;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};

use super::js::{enc, query};

pub const DAEMON_DOWN: &str = "ckanban daemon not running, run `ckanban install` or `ckanban dev`";
/// Set on every board run's claude process ("<profile>/<ticket id>").
pub const RUN_ENV: &str = "CKANBAN_TICKET";
pub const RUN_HEADER: &str = "x-ckanban-run";
pub const QUICK_CHAT_ENV: &str = "CKANBAN_QUICK_CHAT";
pub const QUICK_CHAT_HEADER: &str = "x-ckanban-quick-chat";
pub const HUDDLE_AGENT_ENV: &str = "CKANBAN_HUDDLE_AGENT";
pub const HUDDLE_HEADER: &str = "x-ckanban-huddle-agent";
pub const SOURCE_HEADER: &str = "x-ckanban-source";
pub const FRONT_DESK_ENV: &str = "CKANBAN_FRONTDESK";
pub const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// The daemon held a Telegram front desk request for the user's Confirm tap (src/helper/frontdesk-id.ts).
const CONFIRM_STATUS: u16 = 202;
/// Comments get_ticket prints at a time (COMMENTS_PAGE).
pub const COMMENTS_PAGE: u32 = 50;

/// A tool's failure: its message becomes an error result. Confirm is the front desk's held request: not an error,
/// its message says what happens next (ConfirmPending).
#[derive(Debug, Clone)]
pub enum Fail {
    Msg(String),
    Confirm(String),
}

impl Fail {
    pub fn msg(m: impl Into<String>) -> Self {
        Fail::Msg(m.into())
    }
    pub fn text(&self) -> &str {
        match self {
            Fail::Msg(m) | Fail::Confirm(m) => m,
        }
    }
}

pub type R<T> = Result<T, Fail>;

/// `ClientError(msg)` as an early return.
pub fn err<T>(m: impl Into<String>) -> R<T> {
    Err(Fail::msg(m))
}

/// Who calls the huddle API from a run (HuddleCaller): its ticket and, for a huddle agent, CKANBAN_HUDDLE_AGENT.
#[derive(Default, Clone)]
pub struct Caller {
    pub run: Option<String>,
    pub agent: Option<String>,
}

pub struct Client {
    http: HyperClient<HttpConnector, Full<Bytes>>,
    base: String,
    /// CKANBAN_FRONTDESK and CKANBAN_QUICK_CHAT of this process, sent on every request.
    front_desk: Option<String>,
    quick_chat: Option<String>,
}

type Headers = Vec<(&'static str, String)>;

impl Client {
    pub fn new(port: u16, env: &super::Env) -> Self {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        Client {
            http: HyperClient::builder(TokioExecutor::new()).build(connector),
            // 127.0.0.1, not localhost: the daemon only listens on IPv4 and checks the Host header.
            base: format!("http://127.0.0.1:{port}"),
            front_desk: env.get(FRONT_DESK_ENV).map(str::to_string),
            quick_chat: env.get(QUICK_CHAT_ENV).map(str::to_string),
        }
    }

    async fn req(&self, method: &str, path: &str, body: Option<&Value>, extra: Headers) -> R<Value> {
        let mut b = Request::builder().method(method).uri(format!("{}{}", self.base, path));
        if body.is_some() {
            b = b.header("content-type", "application/json");
        }
        if let Some(fd) = &self.front_desk {
            b = b.header(FRONT_DESK_HEADER, fd);
        }
        if let Some(qc) = &self.quick_chat {
            b = b.header(QUICK_CHAT_HEADER, qc);
        }
        for (k, v) in extra {
            b = b.header(k, v);
        }
        let payload = body.map(|v| Bytes::from(v.to_string())).unwrap_or_default();
        let req = b.body(Full::new(payload)).map_err(|_| Fail::msg(DAEMON_DOWN))?;
        let res = self.http.request(req).await.map_err(|_| Fail::msg(DAEMON_DOWN))?;
        let status = res.status().as_u16();
        if status == 204 {
            return Ok(Value::Null);
        }
        let bytes = res.into_body().collect().await.map_err(|_| Fail::msg(DAEMON_DOWN))?.to_bytes();
        let text = String::from_utf8_lossy(&bytes);
        let data: Value = if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) };
        if !(200..300).contains(&status) {
            return Err(Fail::Msg(match data.get("error") {
                Some(Value::Null) | None => format!("{method} {path} failed: {status}"),
                Some(e) => super::js::show(Some(e)),
            }));
        }
        if status == CONFIRM_STATUS {
            if let Some(c) = data.get("confirmation").and_then(Value::as_str) {
                return Err(Fail::Confirm(c.to_string()));
            }
        }
        Ok(data)
    }

    async fn get(&self, path: &str, extra: Headers) -> R<Value> {
        self.req("GET", path, None, extra).await
    }

    fn by(run: Option<&str>) -> Headers {
        run.filter(|r| !r.is_empty()).map(|r| vec![(RUN_HEADER, r.to_string())]).unwrap_or_default()
    }

    fn as_caller(c: &Caller) -> Headers {
        let mut h = vec![(SOURCE_HEADER, "mcp".to_string())];
        h.extend(Self::by(c.run.as_deref()));
        if let Some(a) = c.agent.as_deref().filter(|a| !a.is_empty()) {
            h.push((HUDDLE_HEADER, a.to_string()));
        }
        h
    }

    fn p(slug: &str) -> String {
        format!("/api/profiles/{}", enc(slug))
    }
    fn t(slug: &str, id: Option<&str>) -> String {
        let base = format!("{}/tickets", Self::p(slug));
        id.map_or(base.clone(), |id| format!("{base}/{}", enc(id)))
    }
    fn s(slug: &str, id: Option<&str>) -> String {
        let base = format!("{}/schedules", Self::p(slug));
        id.map_or(base.clone(), |id| format!("{base}/{}", enc(id)))
    }
    fn j(slug: &str, id: Option<&str>) -> String {
        let base = format!("{}/jobs", Self::p(slug));
        id.map_or(base.clone(), |id| format!("{base}/{}", enc(id)))
    }
    fn h(slug: &str, hid: &str) -> String {
        format!("{}/huddles/{}", Self::p(slug), enc(hid))
    }

    // Boards and tickets.
    pub async fn list_profiles(&self) -> R<Value> {
        self.get("/api/profiles", vec![]).await
    }
    /// A page of the board's tickets (scope=list); the board filters.
    pub async fn list_tickets(&self, slug: &str, q: &ListQuery) -> R<Value> {
        let mut p: Vec<(&str, String)> = vec![("scope", "list".into())];
        if let Some(s) = q.status.as_deref() {
            p.push(("status", s.into()));
        }
        if q.tool {
            p.push(("tool", "1".into()));
        }
        if let Some(qq) = q.query.as_deref().map(super::js::trim).filter(|x| !x.is_empty()) {
            p.push(("q", qq.into()));
        }
        if let Some(l) = q.limit {
            p.push(("limit", l.to_string()));
        }
        if let Some(a) = q.after.as_deref() {
            p.push(("after", a.into()));
        }
        self.get(&format!("{}?{}", Self::t(slug, None), query(&p)), vec![]).await
    }
    pub async fn tickets_by_ids(&self, slug: &str, ids: &[String]) -> R<Value> {
        let list = ids.iter().map(|i| enc(i)).collect::<Vec<_>>().join(",");
        self.get(&format!("{}?scope=ids&ids={list}", Self::t(slug, None)), vec![]).await
    }
    pub async fn get_ticket(&self, slug: &str, id: &str) -> R<Value> {
        self.get(&Self::t(slug, Some(id)), vec![]).await
    }
    pub async fn get_family(&self, slug: &str, id: &str) -> R<Value> {
        self.get(&format!("{}/family", Self::t(slug, Some(id))), vec![]).await
    }
    pub async fn create_ticket(&self, slug: &str, input: &Value, run: Option<&str>) -> R<Value> {
        self.req("POST", &Self::t(slug, None), Some(input), Self::by(run)).await
    }
    pub async fn plan_action(&self, slug: &str, id: &str, action: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/plan", Self::t(slug, Some(id))), Some(&json!({ "action": action })), Self::by(run)).await
    }
    pub async fn ask_ticket(&self, slug: &str, id: &str, target: &str, question: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/ask", Self::t(slug, Some(id))), Some(&json!({ "target": target, "question": question })), Self::by(run)).await
    }
    pub async fn merge_into_main(&self, slug: &str, id: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/merge-into-main", Self::t(slug, Some(id))), Some(&json!({})), Self::by(run)).await
    }
    pub async fn land_milestone(&self, slug: &str, id: &str, summary: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/land", Self::t(slug, Some(id))), Some(&json!({ "summary": summary })), Self::by(run)).await
    }
    pub async fn search_chat(&self, slug: &str, q: &str, ticket: Option<&str>, tools: bool, run: Option<&str>) -> R<Value> {
        let mut p: Vec<(&str, String)> = vec![("q", q.into())];
        if let Some(t) = ticket {
            p.push(("ticket", t.into()));
        }
        if tools {
            p.push(("tools", "1".into()));
        }
        self.get(&format!("{}/chat/search?{}", Self::p(slug), query(&p)), Self::by(run)).await
    }
    pub async fn read_chat(&self, slug: &str, r: &str, before: Option<f64>, after: Option<f64>, run: Option<&str>) -> R<Value> {
        let mut p: Vec<(&str, String)> = vec![("ref", r.into())];
        if let Some(b) = before {
            p.push(("before", super::js::num_str(b)));
        }
        if let Some(a) = after {
            p.push(("after", super::js::num_str(a)));
        }
        self.get(&format!("{}/chat/read?{}", Self::p(slug), query(&p)), Self::by(run)).await
    }
    pub async fn update_status(&self, slug: &str, id: &str, patch: &Value, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/status", Self::t(slug, Some(id))), Some(patch), Self::by(run)).await
    }
    pub async fn gather(&self, slug: &str, id: &str, tickets: &Value, new_group: Option<&str>, run: Option<&str>, hide: bool) -> R<Value> {
        let mut body = json!({ "tickets": tickets, "newGroup": new_group });
        if hide {
            body["hide"] = Value::Bool(true);
        }
        self.req("POST", &format!("{}/gather", Self::t(slug, Some(id))), Some(&body), Self::by(run)).await
    }
    pub async fn update_ticket(&self, slug: &str, id: &str, patch: &Value, run: Option<&str>) -> R<Value> {
        self.req("PATCH", &Self::t(slug, Some(id)), Some(patch), Self::by(run)).await
    }
    /// `cancel`: the waiting jobs to cancel with it ("all" or comma-separated job ids); None keeps them all. Sent in
    /// the body, which a held front desk request keeps for its Confirm (the query isn't).
    pub async fn delete_ticket(&self, slug: &str, id: &str, cancel: Option<&str>) -> R<Value> {
        let body = cancel.map(|c| json!({ "cancelJobs": c }));
        self.req("DELETE", &Self::t(slug, Some(id)), body.as_ref(), vec![]).await
    }
    pub async fn chat(&self, slug: &str, id: &str, text: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/chat", Self::t(slug, Some(id))), Some(&json!({ "text": text })), Self::by(run)).await
    }
    pub async fn stop(&self, slug: &str, id: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/stop", Self::t(slug, Some(id))), Some(&json!({})), Self::by(run)).await
    }
    pub async fn list_comments(&self, slug: &str, id: &str, before: Option<i64>) -> R<Value> {
        let b = before.map(|b| format!("&before={b}")).unwrap_or_default();
        self.get(&format!("{}/comments?last={COMMENTS_PAGE}{b}", Self::t(slug, Some(id))), vec![]).await
    }
    pub async fn comment(&self, slug: &str, id: &str, text: &str, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/comments", Self::t(slug, Some(id))), Some(&json!({ "text": text })), Self::by(run)).await
    }
    pub async fn set_follow_up(&self, slug: &str, id: &str, input: &Value, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/follow-up", Self::t(slug, Some(id))), Some(input), Self::by(run)).await
    }
    pub async fn cancel_follow_up(&self, slug: &str, id: &str, reason: &str, run: Option<&str>) -> R<Value> {
        self.req("DELETE", &format!("{}/follow-up", Self::t(slug, Some(id))), Some(&json!({ "reason": reason })), Self::by(run)).await
    }
    pub async fn notify_user(&self, slug: &str, id: &str, body: &Value, run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/notify", Self::t(slug, Some(id))), Some(body), Self::by(run)).await
    }
    pub async fn take_devices(&self, slug: &str, id: &str, names: &[String], run: Option<&str>) -> R<Value> {
        self.req("POST", &format!("{}/devices", Self::t(slug, Some(id))), Some(&json!({ "action": "take", "names": names })), Self::by(run)).await
    }
    pub async fn release_devices(&self, slug: &str, id: &str, names: Option<&[String]>, run: Option<&str>) -> R<Value> {
        let names = names.unwrap_or(&[]);
        self.req("POST", &format!("{}/devices", Self::t(slug, Some(id))), Some(&json!({ "action": "release", "names": names })), Self::by(run)).await
    }
    pub async fn send_telegram_file(&self, path: &str, caption: &str) -> R<Value> {
        self.req("POST", "/api/telegram/front-desk/file", Some(&json!({ "path": path, "caption": caption })), vec![]).await
    }
    pub async fn report_bug(&self, input: &Value) -> R<Value> {
        self.req("POST", "/api/bug-report", Some(input), vec![]).await
    }

    // Connections.
    pub async fn claude_servers(&self) -> R<Value> {
        self.get("/api/mcp", vec![]).await
    }
    pub async fn list_passes(&self) -> R<Value> {
        self.get("/api/passes", vec![]).await
    }
    pub async fn pass_tools(&self, id: &str) -> R<Value> {
        self.get(&format!("/api/passes/{}/tools", enc(id)), vec![]).await
    }
    pub async fn test_automation(&self, slug: &str, script: &str, passes: &[String]) -> R<Value> {
        self.req("POST", &format!("{}/loops/test", Self::p(slug)), Some(&json!({ "script": script, "passes": passes })), vec![]).await
    }

    // Schedules and jobs.
    pub async fn list_schedules(&self, slug: &str) -> R<Value> {
        self.get(&Self::s(slug, None), vec![]).await
    }
    pub async fn create_schedule(&self, slug: &str, input: &Value, run: Option<&str>) -> R<Value> {
        self.req("POST", &Self::s(slug, None), Some(input), Self::by(run)).await
    }
    pub async fn update_schedule(&self, slug: &str, id: &str, patch: &Value, run: Option<&str>) -> R<Value> {
        self.req("PATCH", &Self::s(slug, Some(id)), Some(patch), Self::by(run)).await
    }
    pub async fn delete_schedule(&self, slug: &str, id: &str, run: Option<&str>) -> R<Value> {
        self.req("DELETE", &Self::s(slug, Some(id)), None, Self::by(run)).await
    }
    pub async fn run_schedule(&self, slug: &str, id: &str, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/run", Self::s(slug, Some(id))), Some(&json!({})), Self::as_caller(c)).await
    }
    pub async fn schedule_history(&self, slug: &str, id: &str) -> R<Value> {
        self.get(&format!("{}/history", Self::s(slug, Some(id))), vec![]).await
    }
    /// The jobs still waiting to run that a delete of these tickets leaves behind (`?scheduledBy=`).
    pub async fn waiting_jobs(&self, slug: &str, ids: &[String]) -> R<Value> {
        let list = ids.iter().map(|i| enc(i)).collect::<Vec<_>>().join(",");
        self.get(&format!("{}?scheduledBy={list}", Self::j(slug, None)), vec![]).await
    }
    pub async fn list_jobs(&self, slug: &str, ticket_id: Option<&str>) -> R<Value> {
        let path = match ticket_id {
            Some(t) => format!("{}?ticketId={}", Self::j(slug, None), enc(t)),
            None => Self::j(slug, None),
        };
        self.get(&path, vec![]).await
    }
    pub async fn create_job(&self, slug: &str, input: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &Self::j(slug, None), Some(input), Self::as_caller(c)).await
    }
    pub async fn update_job(&self, slug: &str, id: &str, patch: &Value, c: &Caller) -> R<Value> {
        self.req("PATCH", &Self::j(slug, Some(id)), Some(patch), Self::as_caller(c)).await
    }
    pub async fn job_action(&self, slug: &str, id: &str, action: &str, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/{action}", Self::j(slug, Some(id))), Some(&json!({})), Self::as_caller(c)).await
    }
    pub async fn cron_preview(&self, expr: &str) -> R<Value> {
        self.get(&format!("/api/cron/preview?expr={}", enc(expr)), vec![]).await
    }

    // Huddle presets.
    fn hp(slug: &str, name: Option<&str>) -> String {
        format!("{}/huddle-presets{}", Self::p(slug), name.map(|n| format!("/{}", enc(n))).unwrap_or_default())
    }
    pub async fn delete_huddle_preset(&self, slug: &str, name: &str, c: &Caller, scope: Option<&str>) -> R<Value> {
        let q = scope.map(|s| format!("?scope={s}")).unwrap_or_default();
        self.req("DELETE", &format!("{}{q}", Self::hp(slug, Some(name))), None, Self::as_caller(c)).await
    }

    // Huddles: the daemon decides who calls from the headers, never from the body.
    pub async fn huddle_read(&self, slug: &str, hid: &str, since: Option<i64>, limit: Option<i64>, c: &Caller) -> R<Value> {
        let mut p: Vec<(&str, String)> = vec![];
        if let Some(s) = since {
            p.push(("since", s.to_string()));
        }
        if let Some(l) = limit {
            p.push(("limit", l.to_string()));
        }
        let q = if p.is_empty() { String::new() } else { format!("?{}", query(&p)) };
        self.get(&format!("{}{q}", Self::h(slug, hid)), Self::as_caller(c)).await
    }
    pub async fn huddle_post(&self, slug: &str, hid: &str, body: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/messages", Self::h(slug, hid)), Some(body), Self::as_caller(c)).await
    }
    pub async fn huddle_status(&self, slug: &str, hid: &str, body: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/status", Self::h(slug, hid)), Some(body), Self::as_caller(c)).await
    }
    pub async fn huddle_close_request(&self, slug: &str, hid: &str, reason: &str, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/close-request", Self::h(slug, hid)), Some(&json!({ "reason": reason })), Self::as_caller(c)).await
    }
    pub async fn huddle_mode(&self, slug: &str, hid: &str, handle: &str, mode: &str, c: &Caller) -> R<Value> {
        let path = format!("{}/participants/{}", Self::h(slug, hid), enc(handle));
        self.req("PATCH", &path, Some(&json!({ "mode": mode })), Self::as_caller(c)).await
    }
    pub async fn huddle_findings(&self, slug: &str, hid: &str, body: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/findings", Self::h(slug, hid)), Some(body), Self::as_caller(c)).await
    }
    pub async fn huddle_hand_in(&self, slug: &str, hid: &str, summary: &str, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/hand-ins", Self::h(slug, hid)), Some(&json!({ "summary": summary })), Self::as_caller(c)).await
    }
    pub async fn huddle_review_hand_in(&self, slug: &str, hid: &str, id: &str, accept: bool, reason: &str, c: &Caller) -> R<Value> {
        let path = format!("{}/hand-ins/{}/{}", Self::h(slug, hid), enc(id), if accept { "accept" } else { "reject" });
        self.req("POST", &path, Some(&json!({ "reason": reason })), Self::as_caller(c)).await
    }
    pub async fn huddle_allow_changes(&self, slug: &str, hid: &str, handle: &str, c: &Caller) -> R<Value> {
        let path = format!("{}/participants/{}/allow-changes", Self::h(slug, hid), enc(handle));
        self.req("POST", &path, Some(&json!({})), Self::as_caller(c)).await
    }
    pub async fn huddle_brief(&self, slug: &str, hid: &str, text: &str, c: &Caller) -> R<Value> {
        self.req("PUT", &format!("{}/brief", Self::h(slug, hid)), Some(&json!({ "text": text })), Self::as_caller(c)).await
    }

    // Teammates, squads and starting huddles (P3: propose_*, start_huddle, huddle_add_participant, presets).
    pub async fn list_huddle_presets(&self, slug: &str) -> R<Value> {
        self.get(&Self::hp(slug, None), vec![]).await
    }
    pub async fn save_huddle_preset(&self, slug: &str, preset: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &Self::hp(slug, None), Some(preset), Self::as_caller(c)).await
    }
    pub async fn list_huddle_templates(&self, slug: &str) -> R<Value> {
        self.get(&format!("{}/huddle-templates", Self::p(slug)), vec![]).await
    }
    pub async fn start_auto_huddle(&self, slug: &str, input: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/huddles/auto", Self::p(slug)), Some(input), Self::as_caller(c)).await
    }
    pub async fn huddle_add(&self, slug: &str, hid: &str, entry: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/participants", Self::h(slug, hid)), Some(entry), Self::as_caller(c)).await
    }
    pub async fn huddle_propose_squad(&self, slug: &str, hid: &str, input: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/squads", Self::h(slug, hid)), Some(input), Self::as_caller(c)).await
    }
    pub async fn huddle_propose_teammate(&self, slug: &str, hid: &str, input: &Value, c: &Caller) -> R<Value> {
        self.req("POST", &format!("{}/teammates", Self::h(slug, hid)), Some(input), Self::as_caller(c)).await
    }
}

/// What list_tickets asks the board for (TicketListQuery).
#[derive(Default)]
pub struct ListQuery {
    pub status: Option<String>,
    pub tool: bool,
    pub query: Option<String>,
    pub limit: Option<i64>,
    pub after: Option<String>,
}
