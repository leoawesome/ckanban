//! Roster checks (`rosterEntryError`, `rosterError`, `handleBase` in `src/huddle/huddle-roster.ts`): the shape of a
//! squad's people, and their preset names against the board's.

use serde_json::Value;

use super::jsv;
use super::presets::MAIN_PRESET;
use crate::prompts::js;

/// `DEFAULT_MAX_PARTICIPANTS`.
pub const DEFAULT_MAX_PARTICIPANTS: usize = 8;
/// Handles no participant can take (`RESERVED_HANDLES`).
pub const RESERVED_HANDLES: [&str; 5] = ["main", "you", "all", "system", "current"];
const MAX_COUNT: f64 = 8.0;

/// `handleBase`: lowercase letters, digits and dashes, at most 24; "agent" when nothing is left.
pub fn handle_base(s: &str) -> String {
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
    let cut: String = out.trim_matches('-').chars().take(24).collect();
    if cut.is_empty() { "agent".into() } else { cut }
}

/// `rosterEntryError`: what's wrong with one entry, or None. `presets`: the board's preset names (built-ins included);
/// without them only the shape is checked.
pub fn roster_entry_error(e: &Value, at: &str, presets: Option<&[String]>) -> Option<String> {
    let m = match e {
        Value::Object(m) => m.clone(),
        Value::Array(_) => Default::default(),
        _ => return Some(format!("{at}each entry must be an object")),
    };
    let preset = m.get("preset");
    if preset.is_some() && !jsv::is_text(preset) {
        return Some(format!("{at}preset must be a preset name"));
    }
    if let Some(p) = jsv::str_of(preset).filter(|_| jsv::is_text(preset)) {
        let p = js::trim(p);
        if p == MAIN_PRESET {
            return Some(format!("{at}\"{MAIN_PRESET}\" is the coordinator's preset (the host ticket's session joins as @main by itself)"));
        }
        if let Some(names) = presets
            && !names.iter().any(|n| n == p)
        {
            let list = names.iter().filter(|n| *n != MAIN_PRESET).cloned().collect::<Vec<_>>().join(", ");
            return Some(format!(
                "{at}unknown preset \"{}\" (presets: {list}; or give a role and a prompt instead)",
                jsv::js_string(preset)
            ));
        }
    }
    let role = m.get("role");
    if preset.is_none() && !jsv::is_text(role) {
        return Some(format!("{at}give a preset or a role"));
    }
    if role.is_some() && !jsv::is_text(role) {
        return Some(format!("{at}role must be text"));
    }
    let count = m.get("count");
    if count.is_some() && (!jsv::is_integer(count) || jsv::num_of(count).is_some_and(|c| !(1.0..=MAX_COUNT).contains(&c))) {
        return Some(format!("{at}count must be a whole number from 1 to {MAX_COUNT}"));
    }
    if let Some(v) = m.get("mode")
        && v != "tagged"
        && v != "monitor"
    {
        return Some(format!("{at}mode must be tagged or monitor"));
    }
    if let Some(v) = m.get("workspace")
        && v != "shared"
        && v != "own"
    {
        return Some(format!("{at}workspace must be shared or own"));
    }
    for k in ["focus", "model", "handle", "prompt"] {
        if matches!(m.get(k), Some(v) if !v.is_null() && !v.is_string()) {
            return Some(format!("{at}{k} must be text"));
        }
    }
    for k in ["lead", "canEdit", "host"] {
        if matches!(m.get(k), Some(v) if !v.is_boolean()) {
            return Some(format!("{at}{k} must be true or false"));
        }
    }
    let handle = m.get("handle");
    if jsv::is_text(handle) {
        let h = jsv::str_of(handle).unwrap_or("");
        if RESERVED_HANDLES.contains(&handle_base(h).as_str()) {
            return Some(format!("{at}handle \"{h}\" is reserved"));
        }
    }
    if jsv::truthy(m.get("host")) && count_of(&m) > 1.0 {
        return Some(format!("{at}the host is one participant: count must be 1"));
    }
    None
}

fn count_of(m: &jsv::Obj) -> f64 {
    if jsv::nullish(m.get("count")) { 1.0 } else { jsv::num_of(m.get("count")).unwrap_or(f64::NAN) }
}

/// `rosterError`: what's wrong with a roster, or None. The coordinator (@main) counts towards `max`.
pub fn roster_error(roster: Option<&Value>, max: usize, presets: Option<&[String]>) -> Option<String> {
    let Some(Value::Array(entries)) = roster else { return Some("roster must be a non-empty list".into()) };
    if entries.is_empty() {
        return Some("roster must be a non-empty list".into());
    }
    for (i, e) in entries.iter().enumerate() {
        if let Some(err) = roster_entry_error(e, &format!("entry {}: ", i + 1), presets) {
            return Some(err);
        }
    }
    let field = |e: &Value, k: &str| e.as_object().and_then(|m| m.get(k).cloned());
    if entries.iter().filter(|e| jsv::truthy(field(e, "host").as_ref())).count() > 1 {
        return Some("a huddle has one host: set host on one entry only".into());
    }
    let total = 1.0 + entries.iter().map(|e| e.as_object().map(count_of).unwrap_or(1.0)).sum::<f64>();
    if total > max as f64 {
        return Some(format!("that is {} participants with @main, over the limit of {max}", js::num(total)));
    }
    None
}
