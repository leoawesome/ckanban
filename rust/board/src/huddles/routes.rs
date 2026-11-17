//! The huddle routes of board mode (`huddleApi` in `src/api/huddles.ts`): `/api/profiles/:p/huddles...`, with Bun's
//! checks, answers and statuses. The sender of a message is never taken from the body: a request from a board run is
//! that run's participant (its token for agents), anything else is the user (@you). Stop, resume, close and stopping
//! one participant are the user's alone.
//!
//! Auto huddles (`POST /huddles/auto`) and a participant's own session go to the `HuddleRunner` (R11c). Not here yet,
//! answered 503 so nothing reaches a satellite that has no huddles: "Save as squad…" (`generic-squad`, a side call).
//!
//! Calls block (file reads and writes): the server runs `answer` on the blocking pool.

use serde_json::{Map, Value, json};

use super::model::{Obj, s};
use super::service::{Caller, Huddles};
use crate::team::{Fail, jsv};

pub struct Req<'a> {
    pub method: &'a str,
    /// The path parts after `/api/` (decoded): `profiles`, slug, `huddles`, ...
    pub parts: &'a [String],
    pub query: &'a str,
    pub run: Option<String>,
    pub agent: Option<String>,
    pub source: Option<String>,
    pub body: &'a [u8],
}

/// Whether the huddle routes take this request.
pub fn claims(parts: &[String]) -> bool {
    parts.len() >= 3 && parts[0] == "profiles" && parts[2] == "huddles"
}

type Out = Result<(u16, Value), Fail>;

fn body(r: &Req) -> Result<Value, Fail> {
    ckanban_core::datafile::parse_json(&String::from_utf8_lossy(r.body)).map(ckanban_core::jsnum::normalize).ok_or_else(|| Fail::new(400, "invalid JSON body"))
}

fn get<'a>(b: &'a Value, k: &str) -> Option<&'a Value> {
    jsv::field(Some(b), k)
}

fn text_of(b: &Value, k: &str) -> Option<String> {
    get(b, k).and_then(Value::as_str).map(str::to_string)
}

/// `Number(v)` for a body field: undefined or null stay None.
fn number(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::String(t)) => {
            let t = crate::prompts::js::trim(t);
            if t.is_empty() { Some(0.0) } else { Some(t.parse::<f64>().unwrap_or(f64::NAN)) }
        }
        Some(_) => Some(f64::NAN),
    }
}

fn query(q: &str, k: &str) -> Option<String> {
    url::form_urlencoded::parse(q.as_bytes()).find(|(n, _)| n == k).map(|(_, v)| v.into_owned())
}

/// `num(k)`: a finite number from the query, else None.
fn qnum(q: &str, k: &str) -> Option<f64> {
    let v = query(q, k)?;
    if v.is_empty() {
        return None;
    }
    v.trim().parse::<f64>().ok().filter(|x| x.is_finite())
}

fn no_token(p: &Obj) -> Value {
    let mut p = p.clone();
    p.shift_remove("token");
    Value::Object(p)
}

const NOT_YET: &str = "not in the Rust board yet";

/// The answer: (status, JSON); errors as `{ error }`.
pub fn answer(hs: &Huddles, r: &Req) -> (u16, Value) {
    // Reads go without the lock (a list of every huddle takes a while); changes one at a time.
    let out = if r.method == "GET" { route(hs, r) } else { hs.op(|hs| route(hs, r)) };
    match out {
        Ok(x) => x,
        Err(e) => {
            let mut v = json!({ "error": e.message });
            if e.status == 409 && (e.message == "This ticket's run is already working on it." || e.message == "A huddle is already working on this ticket.") {
                v["confirm"] = Value::from(if e.message.starts_with("A huddle") { "huddle-open" } else { "run-active" });
            }
            (e.status, v)
        }
    }
}

fn route(hs: &Huddles, r: &Req) -> Out {
    let slug = r.parts[1].as_str();
    if !hs.team.has_board(slug) {
        return Err(Fail::new(404, format!("board {slug} not found")));
    }
    let rest = &r.parts[3..];
    let m = r.method;
    let who = Caller { run: r.run.clone(), agent: r.agent.clone() };
    let user_only = |what: &str| -> Result<(), Fail> {
        if who.run.is_some() || who.agent.is_some() {
            return Err(Fail::new(403, format!("only the user can {what}; ask them in the huddle (tag @you)")));
        }
        Ok(())
    };
    if rest.len() == 1 && rest[0] == "auto" && m == "POST" {
        let run = who.run.clone().unwrap_or_default();
        let mut it = run.split('/');
        let (run_slug, ticket) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
        if who.run.is_none() || who.agent.is_some() || run_slug != slug || ticket.is_empty() {
            return Err(Fail::new(403, "only a board run of the host ticket can start an auto huddle; propose a roster with propose_huddle instead"));
        }
        let b = body(r)?;
        let str_of = |k: &str| get(&b, k).and_then(Value::as_str).map(str::to_string);
        let template = [str_of("squad"), str_of("template")].into_iter().flatten().find(|v| !crate::prompts::js::trim(v).is_empty()).map(|v| crate::prompts::js::trim(&v).to_string());
        let input = super::service::AutoInput {
            reason: str_of("reason").unwrap_or_default(),
            trigger: str_of("trigger"),
            template,
            roster: get(&b, "roster").and_then(Value::as_array).cloned(),
            max_cost_usd: match get(&b, "maxCostUsd") {
                None | Some(Value::Null) => None,
                v => Some(number(v).unwrap_or(f64::NAN)),
            },
            topic: str_of("topic"),
        };
        let (h, waiting, template) = hs.runner.read().clone().start_auto(hs, slug, ticket, &input)?;
        let huddle = h.map(|h| hs.view(slug, &h)).unwrap_or(Value::Null);
        return Ok((if waiting { 202 } else { 201 }, json!({ "waiting": waiting, "template": template, "huddle": huddle })));
    }
    if rest.is_empty() {
        if m == "GET" {
            let ticket = query(r.query, "ticket");
            return Ok((200, Value::Array(hs.list(slug, ticket.as_deref(), query(r.query, "open").as_deref() == Some("1")))));
        }
        if m == "POST" {
            user_only("start a huddle (propose a roster with propose_huddle instead)")?;
            let b = body(r)?;
            let ticket = match get(&b, "ticketId") {
                None | Some(Value::Null) => String::new(),
                Some(v) => jsv::js_string(Some(v)),
            };
            if ticket.is_empty() {
                return Err(Fail::new(400, "ticketId is required"));
            }
            if let Some(host) = hs.ticket(slug, &ticket)
                && (host.status == "ready" || host.status == "in_progress")
                && hs.is_ticket_running(slug, &ticket)
                && r.source.as_deref() == Some("ui")
                && !jsv::is_true(get(&b, "confirmParallel"))
            {
                return Err(Fail::new(409, "This ticket's run is already working on it."));
            }
            let squad = [get(&b, "squad"), get(&b, "template")].into_iter().flatten().filter_map(Value::as_str).find(|v| !crate::prompts::js::trim(v).is_empty()).map(str::to_string);
            let roster = get(&b, "roster").and_then(Value::as_array).cloned().unwrap_or_default();
            let max_p = number(get(&b, "maxParticipants")).filter(|x| *x != 0.0 && !x.is_nan());
            let max_c = number(get(&b, "maxCostUsd"));
            let h = hs.create(slug, &ticket, roster, max_p, max_c, squad.as_deref(), get(&b, "topic"))?;
            return Ok((201, hs.view(slug, &h)));
        }
        return Err(Fail::new(404, "not found"));
    }
    let (h, me) = hs.identify(slug, &rest[0], &who)?;
    let hid = s(&h, "id").to_string();
    let at = |i: usize| rest.get(i).map(String::as_str);
    let (action, handle, sub, part, part_id) = (at(1), at(2), at(3), at(4), at(5));
    let view = |hs: &Huddles| -> Result<Value, Fail> { Ok(hs.view(slug, &hs.get(slug, &hid)?)) };
    if action.is_none() && m == "GET" {
        let page = hs.messages(slug, &hid, qnum(r.query, "before"), qnum(r.query, "since"), qnum(r.query, "limit"))?;
        let mut out = Map::new();
        out.insert("huddle".into(), hs.view(slug, &h));
        out.insert("you".into(), me.get("handle").cloned().unwrap_or(Value::Null));
        if let Value::Object(p) = page {
            out.extend(p);
        }
        return Ok((200, Value::Object(out)));
    }
    if m == "POST" && action == Some("messages") && handle.is_none() {
        let b = body(r)?;
        let kind = if get(&b, "kind").and_then(Value::as_str) == Some("finding") { "finding" } else { "message" };
        let status = get(&b, "status").filter(|v| jsv::truthy(Some(v))).map(|st| (st.clone(), text_of(&b, "reason"), get(&b, "lessons").cloned()));
        let src = match r.source.as_deref() {
            Some("ui") => "ui",
            Some("mcp") => "mcp",
            _ => "none",
        };
        let text = match get(&b, "text") {
            None | Some(Value::Null) => String::new(),
            Some(v) => jsv::js_string(Some(v)),
        };
        let msg = hs.post(slug, &hid, &me, &text, kind, status, src)?;
        return Ok((201, Value::Object(msg)));
    }
    if m == "PUT" && action == Some("brief") && handle.is_none() {
        let b = body(r)?;
        let text = get(&b, "text").filter(|v| !v.is_null()).map(|v| jsv::js_string(Some(v))).unwrap_or_default();
        let h = hs.set_brief(slug, &hid, &me, &text)?;
        return Ok((200, hs.view(slug, &h)));
    }
    if m == "POST" && action == Some("status") && handle.is_none() {
        let b = body(r)?;
        let st = get(&b, "status").cloned().unwrap_or(Value::Null);
        let p = hs.set_status(slug, &hid, &me, &st, text_of(&b, "reason").as_deref(), get(&b, "lessons"))?;
        return Ok((200, no_token(&p)));
    }
    if m == "POST" && action == Some("close-request") && handle.is_none() {
        let b = body(r)?;
        let h = hs.request_close(slug, &hid, &me, &text_of(&b, "reason").unwrap_or_default())?;
        return Ok((200, hs.view(slug, &h)));
    }
    if action == Some("participants") {
        if m == "POST" && handle.is_none() {
            let b = body(r)?;
            let e = if b.is_null() { json!({}) } else { b };
            let added = hs.add_participants(slug, &hid, &me, &e)?;
            return Ok((201, json!({ "added": added.iter().map(no_token).collect::<Vec<_>>(), "huddle": view(hs)? })));
        }
        if let Some(handle) = handle {
            if m == "PATCH" && sub.is_none() {
                let b = body(r)?;
                hs.set_mode(slug, &hid, &me, handle, get(&b, "mode"))?;
                return Ok((200, view(hs)?));
            }
            if m == "POST" && sub == Some("stop") {
                user_only("stop a participant")?;
                hs.stop_participant(slug, &hid, handle)?;
                return Ok((200, view(hs)?));
            }
            if sub == Some("session") {
                user_only("read a participant's session")?;
                let runner = hs.runner.read().clone();
                if m == "GET" && part.is_none() {
                    let q = super::service::SessionQuery { before: qnum(r.query, "before"), since: qnum(r.query, "since"), limit: qnum(r.query, "limit") };
                    return Ok((200, runner.session(hs, slug, &hid, handle, &q)?));
                }
                if m == "GET" && part == Some("tool") && let Some(tool) = part_id {
                    return match runner.session_tool(hs, slug, &hid, handle, tool)? {
                        Some(d) => Ok((200, d)),
                        None => Err(Fail::new(404, "tool call not found")),
                    };
                }
                if m == "POST" && part == Some("reveal") && part_id.is_none() {
                    return Ok((200, runner.reveal_session(hs, slug, &hid, handle)?));
                }
            }
            if m == "POST" && sub == Some("restart") {
                user_only("restart a participant")?;
                hs.restart_participant(slug, &hid, handle)?;
                return Ok((200, view(hs)?));
            }
        }
    }
    if m == "POST" && handle.is_none() && matches!(action, Some("stop" | "resume" | "close")) {
        let a = action.unwrap_or("");
        user_only(&format!("{a} the huddle"))?;
        let out = match a {
            "stop" => hs.stop_all(slug, &hid)?,
            "resume" => {
                let b = body(r)?;
                let add = match get(&b, "addBudgetUsd") {
                    None | Some(Value::Null) => 0.0,
                    v => number(v).unwrap_or(f64::NAN),
                };
                hs.resume(slug, &hid, add)?
            }
            _ => hs.close(slug, &hid, None, true)?,
        };
        return Ok((200, hs.view(slug, &out)));
    }
    if m == "POST" && action == Some("seen") && handle.is_none() {
        user_only("mark the huddle seen")?;
        let b = body(r)?;
        let seq = number(get(&b, "seq")).or(Some(f64::NAN));
        let h = hs.mark_seen(slug, &hid, seq)?;
        return Ok((200, hs.view(slug, &h)));
    }
    if m == "POST" && action == Some("teammates") && handle.is_none() {
        let b = body(r)?;
        return Ok((201, Value::Object(hs.propose_teammate(slug, &hid, &me, &b)?)));
    }
    if m == "POST" && action == Some("squads") && handle.is_none() {
        let b = body(r)?;
        return Ok((201, Value::Object(hs.propose_squad(slug, &hid, &me, &b)?)));
    }
    if m == "POST" && action == Some("generic-squad") && handle.is_none() {
        user_only("make a squad from a huddle")?;
        return Err(Fail::new(503, format!("\"Save as squad…\" is {NOT_YET}")));
    }
    if action == Some("learnings")
        && let Some(id) = handle
    {
        user_only("save, edit or discard learnings")?;
        if m == "POST" && sub == Some("discard") {
            return Ok((200, hs.discard_learning(slug, &hid, id)?));
        }
        let patch = || -> Result<Obj, Fail> {
            let raw = String::from_utf8_lossy(r.body);
            let b = if crate::prompts::js::trim(&raw).is_empty() {
                Value::Object(Map::new())
            } else {
                ckanban_core::datafile::parse_json(&raw).map(ckanban_core::jsnum::normalize).ok_or_else(|| Fail::new(400, "invalid JSON body"))?
            };
            let mut out = Map::new();
            for k in ["text", "scope", "target", "replace"] {
                if let Some(v) = get(&b, k) {
                    out.insert(k.into(), v.clone());
                }
            }
            Ok(out)
        };
        if m == "PATCH" && sub.is_none() {
            return Ok((200, Value::Object(hs.edit_learning(slug, &hid, id, &patch()?)?)));
        }
        if m == "POST" && sub == Some("save") {
            return Ok((200, hs.save_learning(slug, &hid, id, &patch()?)?));
        }
    }
    if m == "POST" && action == Some("invite") && handle.is_none() {
        let b = body(r)?;
        let ticket = match get(&b, "ticketId") {
            None | Some(Value::Null) => String::new(),
            Some(v) => jsv::js_string(Some(v)),
        };
        if ticket.is_empty() {
            return Err(Fail::new(400, "ticketId is required"));
        }
        let p = hs.invite(slug, &hid, &me, &ticket, text_of(&b, "handle").as_deref())?;
        return Ok((201, no_token(&p)));
    }
    if m == "POST" && action == Some("hand-ins") && handle.is_none() {
        let b = body(r)?;
        return Ok((201, hs.hand_in(slug, &hid, &me, &text_of(&b, "summary").unwrap_or_default())?));
    }
    if m == "POST"
        && action == Some("hand-ins")
        && let Some(id) = handle
        && matches!(sub, Some("accept" | "reject"))
        && part.is_none()
    {
        let b = body(r)?;
        return Ok((200, hs.review_hand_in(slug, &hid, &me, id, sub == Some("accept"), &text_of(&b, "reason").unwrap_or_default())?));
    }
    if m == "POST"
        && action == Some("participants")
        && let Some(handle) = handle
        && sub == Some("allow-changes")
        && part.is_none()
    {
        let p = hs.allow_changes(slug, &hid, &me, handle)?;
        return Ok((200, no_token(&p)));
    }
    if m == "POST" && action == Some("findings") && handle.is_none() {
        let b = body(r)?;
        let act = match get(&b, "action").and_then(Value::as_str) {
            Some("add") => "add",
            Some("resolve") => "resolve",
            _ => "list",
        };
        return Ok((200, hs.findings(slug, &hid, &me, act, text_of(&b, "text").as_deref(), text_of(&b, "id").as_deref())?));
    }
    Err(Fail::new(404, "not found"))
}
