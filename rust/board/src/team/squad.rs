//! Squads (`src/huddle/squad.ts`): what the user and Claude call huddle templates. A squad card (propose_squad, or
//! "Save as squad…") saves the squad and each person with no preset as a teammate at the same scope; a teammate of
//! that name that already exists is used as is (`squad_save_plan`). Plain helpers.

use std::collections::HashSet;
use std::sync::LazyLock;

use ckanban_core::datafile::{Layout, parse_json, to_text};
use regex::Regex;
use serde_json::Value;

use super::jsv::{self, Obj, clip};
use super::presets::{MAIN_PRESET, preset_from_input, preset_name};
use super::templates::template_from_input;
use crate::prompts::js;

pub const SQUAD_WHY_MAX: usize = 400;
/// Most text of the summary file, or of the end of the chat, the "Save as squad…" call reads.
pub const GENERIC_SQUAD_SOURCE_MAX: usize = 16_000;
const FIELD_MAX: usize = 3_000;
/// Names a teammate made from a squad can't take.
const TAKEN: [&str; 5] = ["you", "all", "system", "current", "main"];
const MAIN_HANDLE: &str = "main";
const USER_HANDLE: &str = "you";

/// `GENERIC_SQUAD_SYSTEM`, `GENERIC_SQUAD_MODEL`, `GENERIC_SQUAD_TIMEOUT_MS`.
pub fn generic_squad_system() -> &'static str {
    &super::builtins().texts.generic_squad_system
}
pub fn generic_squad_model() -> &'static str {
    &super::builtins().texts.generic_squad_model
}
pub fn generic_squad_timeout_ms() -> u64 {
    super::builtins().texts.generic_squad_timeout_ms
}

fn trimmed<'a>(e: &'a Obj, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).map(js::trim).unwrap_or("")
}

/// `teammateNameFor`: the teammate name a person with no preset is saved as (its handle, else its role).
pub fn teammate_name_for(e: &Obj) -> String {
    let h = trimmed(e, "handle");
    let n = preset_name(if h.is_empty() { trimmed(e, "role") } else { h });
    if !n.is_empty() && TAKEN.contains(&n.as_str()) { format!("{n}-role") } else { n }
}

/// `withNewTeammates`: the card for a checked squad, marking the people with no preset.
pub fn with_new_teammates(squad: &Obj, why: &str) -> Obj {
    let roster = squad.get("roster").and_then(Value::as_array).cloned().unwrap_or_default();
    let fresh: Vec<Value> = roster
        .iter()
        .enumerate()
        .filter_map(|(index, e)| {
            let e = e.as_object().cloned().unwrap_or_default();
            if !trimmed(&e, "preset").is_empty() {
                return None;
            }
            let mut o = Obj::new();
            o.insert("index".into(), jsv::number(index as f64));
            o.insert("name".into(), Value::from(teammate_name_for(&e)));
            o.insert("role".into(), Value::from(trimmed(&e, "role")));
            Some(Value::Object(o))
        })
        .collect();
    let mut out = Obj::new();
    out.insert("squad".into(), Value::Object(squad.clone()));
    out.insert("why".into(), Value::from(why));
    out.insert("newTeammates".into(), Value::Array(fresh));
    out
}

/// `squadProposal`: the card from propose_squad's input (the squad's fields plus `why`).
pub fn squad_proposal(input: Option<&Value>, presets: Option<&[String]>) -> Result<Obj, String> {
    let mut fields = jsv::obj_like(input).ok_or("the squad must be an object")?;
    let w = fields.shift_remove("why");
    fields.shift_remove("profile");
    fields.shift_remove("scope");
    let squad = template_from_input(Some(&Value::Object(fields)), None, presets)?;
    let why = jsv::str_of(w.as_ref()).map(js::trim).unwrap_or("");
    if why.is_empty() {
        return Err("why is required: one line on why this squad (what it is good for)".into());
    }
    if js::len16(why) > SQUAD_WHY_MAX {
        return Err(format!("why is too long (max {SQUAD_WHY_MAX} characters)"));
    }
    Ok(with_new_teammates(&squad, why))
}

/// `parseSquadProposal`: None for input that can't be read.
pub fn parse_squad_proposal(input: Option<&Value>) -> Option<Obj> {
    squad_proposal(input, None).ok()
}

/// How saving a squad goes, worked out before anything is written.
#[derive(Clone, Debug)]
pub struct SavePlan {
    /// The squad with every person who had no preset pointed at its teammate.
    pub squad: Obj,
    /// The teammates to make.
    pub create: Vec<Obj>,
    /// Existing teammates used as they are.
    pub reused: Vec<String>,
}

/// `squadSavePlan`. `presets`: the teammates every board the squad reaches has (for all boards: built-in and global
/// only); `taken`: every teammate name at any level (None: `presets`), so a new teammate never takes the name of one
/// this board has. The error is Bun's message.
pub fn squad_save_plan(input: Option<&Value>, presets: &[String], taken: Option<&[String]>) -> Result<SavePlan, String> {
    let draft = template_from_input(input, None, Some(presets))?;
    let mut create: Vec<Obj> = Vec::new();
    let mut reused: Vec<String> = Vec::new();
    let used: HashSet<&str> = taken.unwrap_or(presets).iter().map(String::as_str).collect();
    let mut roster: Vec<Value> = Vec::new();
    for e in draft["roster"].as_array().cloned().unwrap_or_default() {
        let e = e.as_object().cloned().unwrap_or_default();
        if !trimmed(&e, "preset").is_empty() {
            roster.push(Value::Object(e));
            continue;
        }
        let base = teammate_name_for(&e);
        if base.is_empty() {
            let role = jsv::or(e.get("role"), None).map(|r| jsv::js_string(Some(r))).unwrap_or_default();
            return Err(format!("can't make a teammate name from \"{role}\"; give the person a handle"));
        }
        let mut rest = e.clone();
        rest.shift_remove("role");
        rest.shift_remove("prompt");
        let label = Some(trimmed(&e, "role")).filter(|s| !s.is_empty()).unwrap_or(&base).to_string();
        let job = Some(trimmed(&e, "prompt")).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| format!("Help with the ticket as {label}."));
        let mut name = base.clone();
        if presets.contains(&name) {
            // An existing teammate is used as is: its own prompt and label, never this person's.
            if !reused.contains(&name) {
                reused.push(name.clone());
            }
        } else {
            // The same person twice (same role and prompt) shares one new teammate; anyone else gets a free name.
            let same = create.iter().any(|p| p["name"] == name.as_str() && p["prompt"] == job.as_str() && p["role"] == label.as_str());
            if !same {
                let mut n = 2;
                while used.contains(name.as_str()) || create.iter().any(|p| p["name"] == name.as_str()) {
                    name = format!("{base}-{n}");
                    n += 1;
                }
                let mut p = Obj::new();
                p.insert("name".into(), Value::from(name.clone()));
                p.insert("role".into(), Value::from(label.clone()));
                p.insert("prompt".into(), Value::from(job.clone()));
                p.insert("model".into(), jsv::or(e.get("model"), None).cloned().unwrap_or(Value::Null));
                if jsv::truthy(e.get("mode")) {
                    p.insert("mode".into(), e["mode"].clone());
                }
                if jsv::truthy(e.get("workspace")) {
                    p.insert("workspace".into(), e["workspace"].clone());
                }
                if let Some(c) = e.get("canEdit") {
                    p.insert("canEdit".into(), c.clone());
                }
                p.insert("lead".into(), Value::Bool(jsv::truthy(e.get("lead"))));
                create.push(preset_from_input(Some(&Value::Object(p)), None)?);
            }
        }
        // The handle stays, so the squad's people keep the names its host rules and focus use.
        let handle = Some(trimmed(&rest, "handle")).filter(|s| !s.is_empty()).unwrap_or(&name).to_string();
        rest.insert("preset".into(), Value::from(name));
        rest.insert("handle".into(), Value::from(handle));
        roster.push(Value::Object(rest));
    }
    let mut next = draft.clone();
    next.insert("roster".into(), Value::Array(roster));
    let mut known: Vec<String> = presets.to_vec();
    known.extend(create.iter().map(|p| p["name"].as_str().unwrap_or("").to_string()));
    let squad = template_from_input(Some(&Value::Object(next)), None, Some(&known))?;
    Ok(SavePlan { squad, create, reused })
}

/// A participant's own prompt, without its preset's (the preset is kept by name).
fn own_prompt(prompt: &str, preset: &Obj) -> String {
    let p = js::trim(prompt);
    let base = js::trim(preset.get("prompt").and_then(Value::as_str).unwrap_or(""));
    if base.is_empty() {
        return p.to_string();
    }
    if p == base {
        String::new()
    } else if let Some(rest) = p.strip_prefix(base) {
        js::trim(rest).to_string()
    } else {
        p.to_string()
    }
}

/// `squadSetup`: the huddle's setup as a squad (the roster as it was): its helpers only, without @main, @you and
/// invited tickets. `presets`: the board's teammates.
pub fn squad_setup(h: &Value, presets: &[Obj], template: Option<&Obj>) -> Obj {
    let f = |v: &Value, k: &str| jsv::field(Some(v), k).cloned();
    let host = f(h, "host");
    let participants = f(h, "participants").and_then(|p| p.as_array().cloned()).unwrap_or_default();
    let roster: Vec<Value> = participants
        .iter()
        .filter(|p| {
            let handle = jsv::str_of(jsv::field(Some(p), "handle"));
            jsv::str_of(jsv::field(Some(p), "kind")) == Some("agent") && handle != Some(MAIN_HANDLE) && handle != Some(USER_HANDLE)
        })
        .map(|p| {
            let get = |k: &str| jsv::field(Some(p), k);
            let preset = if jsv::truthy(get("preset")) {
                let name = jsv::js_string(get("preset"));
                presets.iter().rev().find(|x| x.get("name").and_then(Value::as_str) == Some(name.as_str()))
            } else {
                None
            };
            let raw = jsv::str_of(get("prompt")).unwrap_or("");
            let prompt = match preset {
                Some(pr) => own_prompt(raw, pr),
                None => js::trim(raw).to_string(),
            };
            let mut e = Obj::new();
            if let Some(v) = get("handle") {
                e.insert("handle".into(), v.clone());
            }
            if let Some(pr) = preset {
                e.insert("preset".into(), pr["name"].clone());
            }
            if (preset.is_none() || get("role") != preset.and_then(|pr| pr.get("role")))
                && let Some(v) = get("role")
            {
                e.insert("role".into(), v.clone());
            }
            if !prompt.is_empty() {
                e.insert("prompt".into(), Value::from(prompt));
            }
            let focus = jsv::str_of(get("focus")).map(js::trim).unwrap_or("");
            if !focus.is_empty() {
                e.insert("focus".into(), Value::from(focus));
            }
            if let Some(v) = get("mode") {
                e.insert("mode".into(), v.clone());
            }
            if jsv::truthy(get("model")) {
                e.insert("model".into(), get("model").cloned().unwrap_or(Value::Null));
            }
            if jsv::truthy(get("lead")) {
                e.insert("lead".into(), Value::Bool(true));
            }
            // `h.host === p.handle`.
            if host.as_ref() == get("handle") {
                e.insert("host".into(), Value::Bool(true));
            }
            if jsv::truthy(get("canEdit")) {
                e.insert("canEdit".into(), Value::Bool(true));
            }
            Value::Object(e)
        })
        .collect();
    let t = |k: &str| template.and_then(|t| t.get(k));
    let or_str = |k: &str, d: &str| jsv::or(t(k), None).cloned().unwrap_or_else(|| Value::from(d));
    let mut out = Obj::new();
    out.insert("name".into(), or_str("name", "new-squad"));
    out.insert("label".into(), or_str("label", "New squad"));
    out.insert("description".into(), or_str("description", ""));
    out.insert("roster".into(), Value::Array(roster));
    out.insert("rounds".into(), jsv::or(t("rounds"), None).cloned().unwrap_or(Value::Null));
    out.insert("maxCostUsd".into(), jsv::or(jsv::or(jsv::field(Some(h), "maxCostUsd"), t("maxCostUsd")), None).cloned().unwrap_or(Value::Null));
    out.insert("report".into(), or_str("report", ""));
    out.insert("hostRules".into(), or_str("hostRules", ""));
    out
}

/// `chatTail`: the end of the chat for the call: the newest messages that fit in `max`, oldest first.
pub fn chat_tail(msgs: &[Value], max: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut len = 0;
    for m in msgs.iter().rev() {
        let g = |k: &str| jsv::field(Some(m), k);
        let who = if jsv::str_of(g("kind")) == Some("system") { "(system)".to_string() } else { format!("@{}", jsv::js_string(g("from"))) };
        let line = format!("[#{}] {who}: {}", jsv::js_string(g("seq")), clip(jsv::str_of(g("text")).unwrap_or(""), 1500));
        let l = js::len16(&line);
        if len + l > max {
            break;
        }
        out.push(line);
        len += l + 1;
    }
    out.reverse();
    out.join("\n")
}

/// The input of the "Save as squad…" prompt (`genericSquadPrompt`).
pub struct GenericInput<'a> {
    pub setup: &'a Obj,
    pub brief: Option<&'a str>,
    pub learnings: &'a [String],
    /// ("summary" or "chat", text).
    pub source: Option<(&'a str, &'a str)>,
}

/// `genericSquadPrompt`: the call's prompt, the huddle's setup and what it learned.
pub fn generic_squad_prompt(i: &GenericInput) -> String {
    let people: Vec<Value> = i
        .setup
        .get("roster")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|e| {
            let mut x = e.as_object().cloned().unwrap_or_default();
            for k in ["prompt", "focus"] {
                if let Some(Value::String(s)) = x.get(k) {
                    let c = clip(s, FIELD_MAX);
                    x.insert(k.into(), Value::from(c));
                }
            }
            Value::Object(x)
        })
        .collect();
    let text_of = |k: &str| i.setup.get(k).and_then(Value::as_str).unwrap_or("");
    let mut setup = Obj::new();
    setup.insert("people".into(), Value::Array(people));
    if let Some(v) = i.setup.get("maxCostUsd") {
        setup.insert("maxCostUsd".into(), v.clone());
    }
    if let Some(v) = i.setup.get("rounds") {
        setup.insert("rounds".into(), v.clone());
    }
    setup.insert("report".into(), Value::from(clip(text_of("report"), FIELD_MAX)));
    setup.insert("hostRules".into(), Value::from(clip(text_of("hostRules"), FIELD_MAX)));
    let brief = i.brief.map(js::trim).filter(|b| !b.is_empty()).map(|b| clip(b, FIELD_MAX)).unwrap_or_else(|| "(none)".into());
    let learnings =
        if i.learnings.is_empty() { "(none)".to_string() } else { i.learnings.iter().map(|l| format!("- {}", clip(l, 500))).collect::<Vec<_>>().join("\n") };
    let (head, src) = match i.source {
        Some(("summary", t)) => ("# The huddle's summary", Some(t)),
        Some((_, t)) => ("# The end of the huddle's chat", Some(t)),
        None => ("# The end of the huddle's chat", None),
    };
    let src = src.map(js::trim).filter(|t| !t.is_empty()).map(|t| clip(t, GENERIC_SQUAD_SOURCE_MAX)).unwrap_or_else(|| "(none)".into());
    [
        "# The huddle's setup".to_string(),
        to_text(&Value::Object(setup), Layout::Indent(2)),
        String::new(),
        "# Pinned brief at the end".into(),
        brief,
        String::new(),
        "# Lessons the huddle's people proposed".into(),
        learnings,
        String::new(),
        head.into(),
        src,
        String::new(),
        "Write the generic squad now, as one JSON object.".into(),
    ]
    .join("\n")
}

static FENCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"```(?:json)?[{}]*((?s:.)*?)```", js::JS_SPACE_CLASS)).expect("fence pattern")
});

/// `parseGenericSquad`: the squad in the call's answer, checked like a saved one. JSON errors are worded by Rust's
/// parser (Bun's are its engine's); the rest is Bun's text.
pub fn parse_generic_squad(text: &str, presets: Option<&[String]>) -> Result<Obj, String> {
    let mut t = js::trim(text).to_string();
    if let Some(c) = FENCE.captures(&t) {
        t = js::trim(&c[1]).to_string();
    }
    let (Some(start), Some(end)) = (t.find('{'), t.rfind('}')) else { return Err("the answer had no JSON object".into()) };
    if end <= start {
        return Err("the answer had no JSON object".into());
    }
    let slice = &t[start..=end];
    let v = match serde_json::from_str::<Value>(slice) {
        Ok(_) => parse_json(slice).unwrap_or(Value::Null),
        Err(e) => return Err(format!("the answer wasn't valid JSON ({e})")),
    };
    template_from_input(Some(&v), None, presets)
}

/// The board's preset names without the coordinator (for messages).
pub fn roster_names(presets: &[String]) -> Vec<String> {
    presets.iter().filter(|n| *n != MAIN_PRESET).cloned().collect()
}
