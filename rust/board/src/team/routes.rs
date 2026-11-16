//! The team routes in board mode, as `huddleConfigRoutes` in `src/api/huddle-config.ts` answers them (the
//! `/learned` part is R12's): `/api/profiles/:p/huddle-presets[/:name]`, `/huddle-templates[/:name]`, `POST /squads`
//! and `/huddle-notes[/:role/:scope]`. Anyone reads; only the user changes them (a board run or huddle helper, which
//! sends `x-ckanban-run` or `x-ckanban-huddle-agent`, gets 403 and proposes instead).
//!
//! HTTP stays in the server (`rust/src/board_mode.rs`: the Host, Origin and JSON type checks, the body, masking);
//! here a request is its method, decoded path parts, `?scope=`, whether a run sent it, and its body text.

use serde_json::{Value, json};

use super::jsv;
use super::notes::NOTES_CAP;
use super::store::{Fail, Team};
use ckanban_core::datafile::parse_json;

/// One request to a team route.
pub struct Call<'a> {
    pub method: &'a str,
    /// The decoded path parts after `/api` (`["profiles", slug, "huddle-presets", ...]`).
    pub parts: &'a [String],
    /// `url.searchParams.get("scope")`.
    pub scope: Option<String>,
    /// A board run or huddle helper sent it (`x-ckanban-run` or `x-ckanban-huddle-agent` not empty).
    pub from_run: bool,
    /// The body as sent (read only for POST, PUT and PATCH).
    pub body: &'a [u8],
}

/// The answer: status, JSON value, and whether it is a success (masked with the saved keys, as Bun's `ctx.json`).
pub struct Answer {
    pub status: u16,
    pub value: Value,
    pub success: bool,
}

fn ok(status: u16, value: Value) -> Answer {
    Answer { status, value, success: true }
}

fn fail(f: Fail) -> Answer {
    Answer { status: f.status, value: json!({ "error": f.message }), success: false }
}

fn err(status: u16, msg: &str) -> Answer {
    fail(Fail::new(status, msg))
}

/// Whether the team routes answer this request (Bun's `huddleConfigRoutes` takes it, `/learned` aside).
pub fn claims(method: &str, parts: &[String]) -> bool {
    parts.len() >= 3
        && parts[0] == "profiles"
        && (matches!(parts[2].as_str(), "huddle-presets" | "huddle-templates" | "huddle-notes") || (parts[2] == "squads" && parts.len() == 3 && method == "POST"))
}

/// `body(req)`: the JSON body, or 400 "invalid JSON body" (an empty body too).
fn body(call: &Call) -> Result<Value, Answer> {
    let text = String::from_utf8_lossy(call.body);
    parse_json(&text).ok_or_else(|| err(400, "invalid JSON body"))
}

/// `b?.[k]`.
fn get<'a>(b: &'a Value, k: &str) -> Option<&'a Value> {
    jsv::field(Some(b), k)
}

/// `b?.scope ?? "board"`.
fn scope_of(b: &Value) -> Value {
    jsv::or(get(b, "scope"), None).cloned().unwrap_or_else(|| Value::from("board"))
}

/// `{ ...b, name }`: the body's fields with the name from the path.
fn with_name(b: &Value, name: &str) -> Value {
    let mut m = match b {
        Value::Object(m) => m.clone(),
        _ => Default::default(),
    };
    m.insert("name".into(), Value::from(name));
    Value::Object(m)
}

/// Answers a request `claims` took. Blocking (files): run it off the async runtime.
pub fn answer(team: &Team, call: &Call) -> Answer {
    let p = call.parts;
    let slug = p[1].as_str();
    if !team.has_board(slug) {
        return err(404, &format!("board {slug} not found"));
    }
    let m = call.method;
    match p[2].as_str() {
        "huddle-presets" => {
            if p.len() == 3 && m == "GET" {
                return ok(200, objs(team.presets(slug)));
            }
            if call.from_run {
                return err(
                    403,
                    if m == "DELETE" {
                        "a board or huddle run can't delete or reset teammates; ask the user"
                    } else {
                        "a board or huddle run can't save teammates; propose one with propose_teammate and the user saves it with one click"
                    },
                );
            }
            if p.len() == 3 && m == "POST" {
                let b = match body(call) {
                    Ok(b) => b,
                    Err(a) => return a,
                };
                return done(201, team.save_preset(slug, Some(&b), Some(&scope_of(&b))).map(Value::Object));
            }
            if p.len() == 4 && m == "PUT" {
                let b = match body(call) {
                    Ok(b) => b,
                    Err(a) => return a,
                };
                return done(200, team.save_preset(slug, Some(&with_name(&b, &p[3])), Some(&scope_of(&b))).map(Value::Object));
            }
            if p.len() == 4 && m == "DELETE" {
                return done(200, team.delete_preset(slug, &p[3], call.scope.as_deref()));
            }
            err(404, "not found")
        }
        "huddle-templates" => {
            if p.len() == 3 && m == "GET" {
                return ok(200, objs(team.templates(slug)));
            }
            if call.from_run {
                return err(403, "only the user changes squads (the Team tab); propose one with propose_squad and the user saves it with one click");
            }
            if p.len() == 3 && m == "POST" {
                let b = match body(call) {
                    Ok(b) => b,
                    Err(a) => return a,
                };
                return done(201, team.save_template(slug, Some(&b), Some(&scope_of(&b))).map(Value::Object));
            }
            if p.len() == 4 && m == "PUT" {
                let b = match body(call) {
                    Ok(b) => b,
                    Err(a) => return a,
                };
                return done(200, team.save_template(slug, Some(&with_name(&b, &p[3])), Some(&scope_of(&b))).map(Value::Object));
            }
            if p.len() == 4 && m == "DELETE" {
                return done(200, team.delete_template(slug, &p[3], call.scope.as_deref()));
            }
            err(404, "not found")
        }
        "squads" => squads(team, call, slug),
        "huddle-notes" => {
            if p.len() == 3 && m == "GET" {
                return match team.notes(slug) {
                    Ok(n) => ok(200, json!({ "notes": n, "cap": NOTES_CAP })),
                    Err(f) => fail(f),
                };
            }
            if call.from_run {
                return err(403, "only the user changes huddle role notes (the Team tab)");
            }
            if p.len() == 5 && m == "PUT" {
                let b = match body(call) {
                    Ok(b) => b,
                    Err(a) => return a,
                };
                return done(200, team.set_notes(slug, &p[3], &p[4], get(&b, "notes")).map(|ns| serde_json::to_value(ns).unwrap_or(Value::Null)));
            }
            err(404, "not found")
        }
        _ => err(404, "not found"),
    }
}

/// `POST /profiles/:p/squads`: the user saves a squad card. Body `{ squad, scope, replace?, card? }`; `card` is
/// `{ ticketId, uuid }` (a ticket chat's card) or `{ huddleId, learningId }` (a huddle's proposed squad).
fn squads(team: &Team, call: &Call, slug: &str) -> Answer {
    if call.from_run {
        return err(403, "a board or huddle run can't save squads or teammates; propose one with propose_squad and the user saves it with one click");
    }
    let b = match body(call) {
        Ok(b) => b,
        Err(a) => return a,
    };
    let scope = scope_of(&b);
    // `b?.card && typeof b.card === "object"`.
    let card = get(&b, "card").filter(|c| c.is_object() || c.is_array());
    let cf = |k: &str| jsv::str_of(card.and_then(|c| jsv::field(Some(c), k)));
    let ticket_card = match (cf("ticketId"), cf("uuid")) {
        (Some(id), Some(uuid)) if !uuid.is_empty() => Some((id, uuid)),
        _ => None,
    };
    let huddle_card = match (cf("huddleId"), cf("learningId")) {
        (Some(h), Some(l)) => Some((h, l)),
        _ => None,
    };
    if card.is_some() && ticket_card.is_none() && huddle_card.is_none() {
        return err(400, "card must be { ticketId, uuid } or { huddleId, learningId }");
    }
    if let Some((id, _)) = ticket_card
        && !team.ticket_exists(slug, id)
    {
        return err(404, &format!("ticket {id} not found"));
    }
    done(201, team.save_squad(slug, get(&b, "squad"), Some(&scope), huddle_card, jsv::is_true(get(&b, "replace")), ticket_card))
}

fn objs(list: Vec<jsv::Obj>) -> Value {
    Value::Array(list.into_iter().map(Value::Object).collect())
}

fn done(status: u16, r: Result<Value, Fail>) -> Answer {
    match r {
        Ok(v) => ok(status, v),
        Err(f) => fail(f),
    }
}
