//! propose_teammate (`src/huddle/teammate-proposal.ts`): Claude proposes a teammate and the user saves it with one
//! click. In a ticket chat it is a card built from the tool call in the transcript; a huddle agent's goes to the
//! huddle's Learnings. Nothing is saved until the user clicks.

use serde_json::Value;

use super::jsv::{self, Obj};
use super::presets::{preset_from_input, preset_name};
use crate::prompts::js;

pub const WHY_MAX: usize = 400;

/// `teammateProposal`: the fields Claude gave (ones left out keep an existing teammate's values), with `why`.
pub fn teammate_proposal(input: Option<&Value>) -> Result<Obj, String> {
    preset_from_input(input, None)?;
    let f = |k: &str| jsv::field(input, k);
    let why = jsv::str_of(f("why")).map(js::trim).unwrap_or("");
    if why.is_empty() {
        return Err("why is required: one line on why no existing teammate fits".into());
    }
    if js::len16(why) > WHY_MAX {
        return Err(format!("why is too long (max {WHY_MAX} characters)"));
    }
    let mut out = Obj::new();
    out.insert("name".into(), Value::from(preset_name(jsv::str_of(f("name")).unwrap_or(""))));
    out.insert("prompt".into(), Value::from(js::trim(jsv::str_of(f("prompt")).unwrap_or(""))));
    out.insert("why".into(), Value::from(why));
    if let Some(role) = jsv::str_of(f("role")).map(js::trim).filter(|r| !r.is_empty()) {
        out.insert("role".into(), Value::from(role));
    }
    if let Some(m) = f("model") {
        let model = m.as_str().map(js::trim).filter(|s| !s.is_empty());
        out.insert("model".into(), model.map(Value::from).unwrap_or(Value::Null));
    }
    for k in ["mode", "workspace", "canEdit", "lead"] {
        if let Some(v) = f(k) {
            out.insert(k.into(), v.clone());
        }
    }
    Ok(out)
}

/// `parseTeammateProposal`: None for input that can't be read (an old or broken tool call in a transcript).
pub fn parse_teammate_proposal(input: Option<&Value>) -> Option<Obj> {
    teammate_proposal(input).ok()
}

/// `proposalPreset`: the preset fields to save (without `why`).
pub fn proposal_preset(p: &Obj) -> Obj {
    let mut out = p.clone();
    out.shift_remove("why");
    out
}
