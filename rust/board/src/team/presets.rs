//! Huddle role presets, "teammates" in the UI (`src/huddle/huddle-presets.ts`): the built-ins (`builtins.json`,
//! written by Bun's fixture test), the user's global ones in `<home>/huddle-presets.json` and a board's own in
//! `profiles/<slug>/huddle-presets.json`, merged built-in, then global, then board. Plain helpers; files are in
//! `store.rs`.

use serde_json::Value;

use super::jsv::{self, Obj};
use super::layers;
use crate::prompts::js;

/// The coordinator's preset: the host ticket's own session.
pub const MAIN_PRESET: &str = "main";
/// Preset names that would clash with special handles.
const RESERVED_NAMES: [&str; 4] = ["you", "all", "system", "current"];
const MAX_NAME: usize = 24;
pub const MAX_PROMPT: usize = 8000;

/// `BUILTIN_PRESETS`.
pub fn builtins() -> &'static [Obj] {
    &super::builtins().presets
}

pub fn is_builtin(name: &str) -> bool {
    layers::find(builtins(), name).is_some()
}

/// `presetName`: "QA Lead" -> "qa-lead" (lowercase letters, digits and dashes, at most 24).
pub fn preset_name(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::new();
    let mut gap = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if gap {
                out.push('-');
                gap = false;
            }
            out.push(c);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('-');
    }
    let trimmed = out.trim_matches('-');
    trimmed.chars().take(MAX_NAME).collect()
}

/// "fixer-lead" -> "Fixer lead": the first word capitalised, dashes as spaces.
pub fn label_of(name: &str) -> String {
    name.split('-')
        .enumerate()
        .map(|(i, w)| {
            if i > 0 {
                return w.to_string();
            }
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `text(k)` of the input checkers: missing or null is None, a string is trimmed, anything else is an error.
pub(crate) fn text_field(m: &Obj, k: &str, max: Option<usize>) -> Result<Option<String>, String> {
    match m.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            if let Some(max) = max
                && js::len16(s) > max
            {
                return Err(format!("{k} is too long (max {max} characters)"));
            }
            Ok(Some(js::trim(s).to_string()))
        }
        Some(_) => Err(format!("{k} must be text")),
    }
}

/// `flag(k)`: missing is None, a boolean is itself, anything else (null too) is an error.
fn flag(m: &Obj, k: &str) -> Result<Option<bool>, String> {
    match m.get(k) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("{k} must be true or false")),
    }
}

fn some_text(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

fn base_str<'a>(base: Option<&'a Obj>, k: &str) -> Option<&'a str> {
    base.and_then(|b| b.get(k)).and_then(Value::as_str)
}

/// `presetFromInput`: a preset to save, filled in from `input` over `base` (the preset it overrides or edits); the
/// error is the readable message Bun throws. Checks run in Bun's order, so the first problem named is the same.
pub fn preset_from_input(input: Option<&Value>, base: Option<&Obj>) -> Result<Obj, String> {
    let m = jsv::obj_like(input).filter(|_| jsv::truthy(input)).ok_or("preset must be an object")?;
    let name = preset_name(jsv::str_of(m.get("name")).unwrap_or(""));
    if name.is_empty() {
        return Err("name is required (letters, digits and dashes)".into());
    }
    if RESERVED_NAMES.contains(&name.as_str()) {
        return Err(format!("\"{name}\" is reserved; pick another name"));
    }
    let prompt = some_text(text_field(&m, "prompt", None)?).or_else(|| base_str(base, "prompt").filter(|s| !s.is_empty()).map(String::from));
    let Some(prompt) = prompt else { return Err("prompt is required: what this role does in the huddle".into()) };
    if js::len16(&prompt) > MAX_PROMPT {
        return Err(format!("prompt is too long (max {MAX_PROMPT} characters)"));
    }
    let base_lead = jsv::truthy(base.and_then(|b| b.get("lead")));
    let lead = match flag(&m, "lead")? {
        Some(b) => b,
        None => match base.and_then(|b| b.get("lead")) {
            Some(Value::Null) | None => false,
            Some(v) => jsv::truthy(Some(v)),
        },
    };
    // A lead watches every message unless a mode is given: a new lead, or one just made a lead, starts in monitor mode.
    let mode = if jsv::nullish(m.get("mode")) {
        if lead && !base_lead {
            Value::from("monitor")
        } else {
            jsv::or(base.and_then(|b| b.get("mode")), None).cloned().unwrap_or_else(|| Value::from("tagged"))
        }
    } else {
        m["mode"].clone()
    };
    if mode != "tagged" && mode != "monitor" {
        return Err("mode must be tagged or monitor".into());
    }
    let asked = jsv::or(jsv::or(m.get("workspace"), base.and_then(|b| b.get("workspace"))), None).cloned().unwrap_or_else(|| Value::from("shared"));
    if asked != "shared" && asked != "own" {
        return Err("workspace must be shared or own".into());
    }
    let can_edit = match flag(&m, "canEdit")? {
        Some(b) => b,
        None => {
            let from_base = if m.contains_key("workspace") { None } else { base.and_then(|b| b.get("canEdit")).filter(|v| !v.is_null()) };
            match from_base {
                Some(v) => jsv::truthy(Some(v)),
                None => asked == "own",
            }
        }
    };
    // One that changes files always works in its own copy of the folder.
    let workspace = if can_edit && name != MAIN_PRESET { Value::from("own") } else { asked };
    // Omitted: keep the base's model; null or "": the board's.
    let model = if m.contains_key("model") {
        some_text(text_field(&m, "model", None)?).map(Value::from).unwrap_or(Value::Null)
    } else {
        jsv::or(base.and_then(|b| b.get("model")), None).cloned().unwrap_or(Value::Null)
    };
    let role = some_text(text_field(&m, "role", None)?)
        .or_else(|| base_str(base, "role").filter(|s| !s.is_empty()).map(String::from))
        .unwrap_or_else(|| label_of(&name));
    let mut out = Obj::new();
    out.insert("name".into(), Value::from(name));
    out.insert("role".into(), Value::from(role));
    out.insert("prompt".into(), Value::from(prompt));
    out.insert("model".into(), model);
    out.insert("mode".into(), mode);
    out.insert("workspace".into(), workspace);
    out.insert("lead".into(), Value::Bool(lead));
    out.insert("canEdit".into(), Value::Bool(can_edit));
    Ok(out)
}

/// The name an input saves under (`presetName(typeof input?.name === "string" ? input.name : "")`).
pub fn input_name(input: Option<&Value>) -> String {
    preset_name(jsv::str_of(jsv::field(input, "name")).unwrap_or(""))
}

/// `savePreset`: one level's presets after saving `input` (replaces its preset of that name, or adds an override or a
/// new one). `lower`: the presets under this level, which an edit starts from.
pub fn save_preset(list: &[Obj], input: Option<&Value>, lower: &[Obj]) -> Result<(Vec<Obj>, Obj), String> {
    let name = input_name(input);
    let base = layers::find(list, &name).or_else(|| layers::find(lower, &name));
    let preset = preset_from_input(input, base)?;
    Ok((layers::with_item(list, preset.clone()), preset))
}

/// `deletePreset`: one level's presets after deleting `name`; `reset`: a lower level has it, so it falls back to that.
pub fn delete_preset(list: &[Obj], name: &str, lower: &[Obj]) -> Result<(Vec<Obj>, bool), String> {
    let n = preset_name(name);
    if layers::find(list, &n).is_none() {
        if is_builtin(&n) {
            return Err(format!("\"{n}\" is a built-in teammate; it can only be changed (save_huddle_preset), not deleted"));
        }
        return Err(format!("no teammate \"{name}\" at this level"));
    }
    let out = list.iter().filter(|p| p.get("name").and_then(Value::as_str) != Some(n.as_str())).cloned().collect();
    Ok((out, layers::find(lower, &n).is_some()))
}

/// `cleanPresets`: only the well-formed entries of a hand-edited or old `huddle-presets.json`, first of each name.
pub fn clean_presets(v: Option<&Value>) -> Vec<Obj> {
    let Some(Value::Array(items)) = v else { return Vec::new() };
    let mut out: Vec<Obj> = Vec::new();
    for x in items {
        if let Ok(p) = preset_from_input(Some(x), None)
            && layers::find(&out, p["name"].as_str().unwrap_or("")).is_none()
        {
            out.push(p);
        }
    }
    out
}

/// `mergePresets`.
pub fn merge_presets(global: &[Obj], board: &[Obj]) -> Vec<Obj> {
    layers::merge_layers(builtins(), global, board)
}

/// `presetSourceText`: "built-in", "built-in, changed on this board", "all boards", "this board only"...
pub fn source_text(p: &Obj) -> String {
    let source = p.get("source").and_then(Value::as_str);
    let base = p.get("base");
    let kind = if jsv::truthy(p.get("builtin")) {
        "built-in"
    } else if base.and_then(Value::as_str) == Some("global") || source == Some("global") {
        "all boards"
    } else {
        "this board only"
    };
    if source == Some("board") && jsv::truthy(base) {
        return format!("{kind}, changed on this board");
    }
    if source == Some("global") && jsv::truthy(base) {
        return format!("{kind}, changed for all boards");
    }
    kind.to_string()
}

/// `presetLine`: one line per preset, for list_huddle_presets and tool descriptions.
pub fn preset_line(p: &Obj) -> String {
    let name = jsv::js_string(p.get("name"));
    let access = if name == MAIN_PRESET {
        "changes files in the ticket's folder"
    } else if jsv::truthy(p.get("canEdit")) {
        "changes files in its own copy, hands them in"
    } else if p.get("workspace").and_then(Value::as_str) == Some("own") {
        "own copy, reads only"
    } else {
        "reads only"
    };
    let mut tags: Vec<String> = Vec::new();
    if jsv::truthy(p.get("mode")) {
        tags.push(jsv::js_string(p.get("mode")));
    }
    tags.push(access.into());
    if jsv::truthy(p.get("lead")) {
        tags.push("lead".into());
    }
    if jsv::truthy(p.get("model")) {
        tags.push(format!("model {}", jsv::js_string(p.get("model"))));
    }
    let main = if name == MAIN_PRESET { " [the coordinator, @main; not for rosters]" } else { "" };
    format!("- {name}: {} ({}; {}){main}\n  {}", jsv::js_string(p.get("role")), tags.join(", "), source_text(p), jsv::js_string(p.get("prompt")))
}
