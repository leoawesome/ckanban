//! Whole-huddle templates, "squads" to the user (`src/huddle/huddle-templates.ts`): a named roster plus the rules the
//! huddle runs by. Built-ins come from `builtins.json`; the user's global ones live in `<home>/huddle-templates.json`
//! and a board's own in `profiles/<slug>/huddle-templates.json`, merged like presets. Plain helpers.

use serde_json::Value;

use super::jsv::{self, Obj};
use super::layers;
use super::presets::{self, label_of, preset_name, text_field};
use super::roster::roster_error;
use crate::prompts::js;

/// Longest text field (label, description, report, host rules).
pub const MAX_TEXT: usize = 4000;
/// Longest topic a squad starts with.
pub const TOPIC_MAX: usize = 2000;
const MAX_ROUNDS: f64 = 20.0;
/// Most people a template's roster may have (with @main).
const MAX_ROSTER: usize = 32;

/// `BUILTIN_TEMPLATES`.
pub fn builtins() -> &'static [Obj] {
    &super::builtins().templates
}

pub fn is_builtin(name: &str) -> bool {
    layers::find(builtins(), name).is_some()
}

/// `templateFromInput`: a template to save, filled in from `input` over `base`; the error is Bun's message.
/// `presets`: the board's preset names, to check the roster against (None: shape only).
pub fn template_from_input(input: Option<&Value>, base: Option<&Obj>, presets: Option<&[String]>) -> Result<Obj, String> {
    let m = jsv::obj_like(input).ok_or("template must be an object")?;
    let name = preset_name(jsv::str_of(m.get("name")).unwrap_or(""));
    if name.is_empty() {
        return Err("name is required (letters, digits and dashes)".into());
    }
    let bf = |k: &str| base.and_then(|b| b.get(k));
    let roster = if m.contains_key("roster") { m.get("roster") } else { bf("roster") };
    let Some(roster) = roster else { return Err("roster is required: the participants this huddle starts with".into()) };
    if let Some(e) = roster_error(Some(roster), MAX_ROSTER, presets) {
        return Err(e);
    }
    let rounds = if m.contains_key("rounds") { m["rounds"].clone() } else { jsv::or(bf("rounds"), None).cloned().unwrap_or(Value::Null) };
    if !rounds.is_null() && (!jsv::is_integer(Some(&rounds)) || !(1.0..=MAX_ROUNDS).contains(&rounds.as_f64().unwrap_or(0.0))) {
        return Err(format!("rounds must be a whole number from 1 to {MAX_ROUNDS}, or null"));
    }
    let cost = if m.contains_key("maxCostUsd") { m["maxCostUsd"].clone() } else { jsv::or(bf("maxCostUsd"), None).cloned().unwrap_or(Value::Null) };
    if !cost.is_null() && !cost.as_f64().is_some_and(|c| c.is_finite() && c > 0.0) {
        return Err("maxCostUsd must be a positive amount, or null".into());
    }
    let base_text = |k: &str| bf(k).filter(|v| !v.is_null()).cloned();
    let label = text_field(&m, "label", Some(MAX_TEXT))?
        .filter(|s| !s.is_empty())
        .or_else(|| bf("label").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from))
        .unwrap_or_else(|| label_of(&name));
    let mut rest = Vec::new();
    for k in ["description", "report", "hostRules"] {
        let v = match text_field(&m, k, Some(MAX_TEXT))? {
            Some(s) => Value::from(s),
            None => base_text(k).unwrap_or_else(|| Value::from("")),
        };
        rest.push(v);
    }
    let roster: Vec<Value> = roster.as_array().cloned().unwrap_or_default();
    let mut out = Obj::new();
    out.insert("name".into(), Value::from(name));
    out.insert("label".into(), Value::from(label));
    out.insert("description".into(), rest[0].clone());
    out.insert("roster".into(), Value::Array(roster));
    out.insert("rounds".into(), rounds);
    out.insert("maxCostUsd".into(), cost);
    out.insert("report".into(), rest[1].clone());
    out.insert("hostRules".into(), rest[2].clone());
    Ok(out)
}

/// `saveTemplate`: one level's templates after saving `input`. `lower`: the templates under this level.
pub fn save_template(list: &[Obj], input: Option<&Value>, presets: Option<&[String]>, lower: &[Obj]) -> Result<(Vec<Obj>, Obj), String> {
    let name = presets::input_name(input);
    let base = layers::find(list, &name).or_else(|| layers::find(lower, &name));
    let t = template_from_input(input, base, presets)?;
    Ok((layers::with_item(list, t.clone()), t))
}

/// `deleteTemplate`: one level's templates after deleting `name`; `reset`: a lower level has it.
pub fn delete_template(list: &[Obj], name: &str, lower: &[Obj]) -> Result<(Vec<Obj>, bool), String> {
    let n = preset_name(name);
    if layers::find(list, &n).is_none() {
        if is_builtin(&n) {
            return Err(format!("\"{n}\" is a built-in template; it can only be changed, not deleted"));
        }
        return Err(format!("no template \"{name}\" at this level"));
    }
    let out = list.iter().filter(|t| t.get("name").and_then(Value::as_str) != Some(n.as_str())).cloned().collect();
    Ok((out, layers::find(lower, &n).is_some()))
}

/// `cleanTemplates`: only the well-formed entries of a hand-edited or old `huddle-templates.json`.
pub fn clean_templates(v: Option<&Value>) -> Vec<Obj> {
    let Some(Value::Array(items)) = v else { return Vec::new() };
    let mut out: Vec<Obj> = Vec::new();
    for x in items {
        if let Ok(t) = template_from_input(Some(x), None, None)
            && layers::find(&out, t["name"].as_str().unwrap_or("")).is_none()
        {
            out.push(t);
        }
    }
    out
}

/// `mergeTemplates`.
pub fn merge_templates(global: &[Obj], board: &[Obj]) -> Vec<Obj> {
    layers::merge_layers(builtins(), global, board)
}

fn s<'a>(t: &'a Obj, k: &str) -> &'a str {
    t.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `templateBrief`: the squad's rules as the huddle's pinned brief.
pub fn template_brief(t: &Obj, budget: f64, topic: Option<&str>) -> String {
    let desc = s(t, "description");
    let mut lines = vec![format!("{} (squad {}){}", jsv::js_string(t.get("label")), jsv::js_string(t.get("name")), if desc.is_empty() { String::new() } else { format!(": {desc}") })];
    if let Some(topic) = topic.map(js::trim).filter(|x| !x.is_empty()) {
        lines.push(format!("Topic: {topic}"));
    }
    let rules = js::trim(s(t, "hostRules"));
    if !rules.is_empty() {
        lines.push(format!("Host rules (how this huddle runs):\n{rules}"));
    }
    if jsv::truthy(t.get("rounds")) {
        lines.push(format!(
            "Rounds: at most {}. A round: everyone posts, the lead challenges and de-duplicates, each answers once. After the last round the lead wraps up.",
            jsv::js_string(t.get("rounds"))
        ));
    }
    lines.push(format!("Budget: ${}.", js::num(budget)));
    let report = s(t, "report");
    if !report.is_empty() {
        lines.push(format!("Report format: {report}"));
    }
    lines.join("\n")
}

/// `topicInput`: a topic from a request or tool call, trimmed, None when empty; an error when it isn't text or is
/// too long.
pub fn topic_input(v: Option<&Value>) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(x)) => {
            let t = js::trim(x);
            if js::len16(t) > TOPIC_MAX {
                return Err(format!("topic is too long (max {TOPIC_MAX} characters)"));
            }
            Ok(Some(t.to_string()).filter(|t| !t.is_empty()))
        }
        Some(_) => Err("topic must be text".into()),
    }
}

/// `customReviewBrief`: the pinned brief of an auto huddle whose run built its own roster.
pub fn custom_review_brief(budget: f64) -> String {
    let texts = &super::builtins().texts;
    [
        "Custom review (roster built by the ticket's run for this change).".to_string(),
        format!("Budget: ${}.", js::num(budget)),
        format!(
            "Report format: {} With a lead, helpers report to the lead, who sends @main one list; without one, they report to @main.",
            texts.auto_review_findings
        ),
        format!("Reviewers: {}", texts.auto_review_read_only),
    ]
    .join("\n")
}

/// `templateLine`: one line per squad, for list_huddle_presets and tool descriptions.
pub fn template_line(t: &Obj) -> String {
    let roster = t.get("roster").and_then(Value::as_array).cloned().unwrap_or_default();
    let who = roster
        .iter()
        .map(|e| {
            let f = |k: &str| jsv::field(Some(e), k);
            let count = f("count");
            let times = if jsv::truthy(count) && jsv::num_of(count).is_some_and(|c| c > 1.0) { format!("{}× ", jsv::js_string(count)) } else { String::new() };
            format!("{times}{}", jsv::js_string(jsv::or(jsv::or(f("handle"), f("preset")), f("role"))))
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut rules: Vec<String> = Vec::new();
    if jsv::truthy(t.get("rounds")) {
        rules.push(format!("{} rounds", jsv::js_string(t.get("rounds"))));
    }
    if jsv::truthy(t.get("maxCostUsd")) {
        rules.push(format!("${} budget", jsv::js_string(t.get("maxCostUsd"))));
    }
    if !js::trim(s(t, "hostRules")).is_empty() {
        rules.push("host rules".into());
    }
    let rules = rules.join(", ");
    let desc = s(t, "description");
    format!(
        "- {}: {} ({who}{}{}){}",
        jsv::js_string(t.get("name")),
        jsv::js_string(t.get("label")),
        if rules.is_empty() { String::new() } else { format!("; {rules}") },
        if t.get("source").and_then(Value::as_str) == Some("builtin") { "; built-in" } else { "" },
        if desc.is_empty() { String::new() } else { format!("\n  {desc}") }
    )
}
