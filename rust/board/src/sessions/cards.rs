//! The checks behind the chat's tool cards, ported from Bun: teammates (`src/huddle/teammate-proposal.ts`,
//! `huddle-presets.ts`), squads (`src/huddle/squad.ts`, `huddle-templates.ts`), huddle rosters and budgets
//! (`src/huddle/huddle-roster.ts`), automations (`src/schedules/automation-proposal.ts`), key boxes
//! (`src/integrations/ask-keys.ts`, `board-keys.ts`) and helper lines (`src/helper/line.ts`). Only what reading a
//! transcript needs: each parser gives the card's data, or None where Bun's would throw.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::text::js_re;
use super::{Obj, js};

/// Longest topic a squad starts with (start route, propose_huddle).
pub const TOPIC_MAX: usize = 2000;
/// Most a budget Claude proposes for a huddle may be.
pub const PROPOSED_MAX_COST_USD: f64 = 100.0;
pub const DEFAULT_MAX_PARTICIPANTS: usize = 8;
const MAX_COUNT: f64 = 8.0;
const MAX_NAME: usize = 24;
const MAX_PROMPT: usize = 8000;
const WHY_MAX: usize = 400;
const MAX_TEXT: usize = 4000;
const MAX_ROUNDS: f64 = 20.0;
const MAIN_PRESET: &str = "main";
const FEEDBACK_MAX: usize = 300;
const MAX_ASKED_KEYS: usize = 8;

type Res<T> = Result<T, String>;

fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object()?.get(k)
}

/// `typeof v === "string" ? v.trim() : ""`.
fn str_trim(v: Option<&Value>) -> &str {
    v.and_then(Value::as_str).map(js::trim).unwrap_or("")
}

/// `typeof v === "string" && !!v.trim()`.
fn is_text(v: Option<&Value>) -> bool {
    !str_trim(v).is_empty()
}

/// `!!v && typeof v === "object"` (arrays count, as in JS).
fn is_object(v: &Value) -> bool {
    v.is_object() || v.is_array()
}

/// `Number.isInteger(v)`.
fn integer(v: &Value) -> Option<f64> {
    js::finite(Some(v)).filter(|x| x.fract() == 0.0)
}

/// `s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")` (before any length cut).
fn dashed(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    if dash && !out.is_empty() {
        out.push('-');
    }
    out.trim_matches('-').to_string()
}

/// "QA Lead" -> "qa-lead" (huddle-presets.ts presetName).
pub fn preset_name(s: &str) -> String {
    let d = dashed(s);
    d[..d.len().min(MAX_NAME)].to_string()
}

/// A handle's base (huddle-roster.ts handleBase): like a preset name, "agent" when empty.
pub fn handle_base(s: &str) -> String {
    let n = preset_name(s);
    if n.is_empty() { "agent".into() } else { n }
}

/// `name.split("-").map((w, i) => (i ? w : w[0].toUpperCase() + w.slice(1))).join(" ")`.
fn label_of(name: &str) -> String {
    let mut c = name.chars();
    let first: String = c.next().map(|f| f.to_uppercase().collect()).unwrap_or_default();
    format!("{first}{}", c.as_str()).replace('-', " ")
}

/// The JSON number of a value (JS numbers read back as JS writes them).
fn number(v: &Value) -> Value {
    ckanban_core::jsnum::normalize(v.clone())
}

// ---------- rosters ----------

const RESERVED_HANDLES: &[&str] = &["main", "you", "all", "system", "current"];

/// What's wrong with one roster entry, or None (shape only: no preset list).
fn roster_entry_error(e: &Value, at: &str) -> Option<String> {
    if !is_object(e) {
        return Some(format!("{at}each entry must be an object"));
    }
    let f = |k: &str| get(e, k);
    if f("preset").is_some() && !is_text(f("preset")) {
        return Some(format!("{at}preset must be a preset name"));
    }
    if is_text(f("preset")) && str_trim(f("preset")) == MAIN_PRESET {
        return Some(format!(
            "{at}\"{MAIN_PRESET}\" is the coordinator's preset (the host ticket's session joins as @main by itself)"
        ));
    }
    if f("preset").is_none() && !is_text(f("role")) {
        return Some(format!("{at}give a preset or a role"));
    }
    if f("role").is_some() && !is_text(f("role")) {
        return Some(format!("{at}role must be text"));
    }
    if let Some(c) = f("count")
        && integer(c).is_none_or(|n| !(1.0..=MAX_COUNT).contains(&n))
    {
        return Some(format!("{at}count must be a whole number from 1 to 8"));
    }
    if let Some(m) = f("mode")
        && !matches!(m.as_str(), Some("tagged" | "monitor"))
    {
        return Some(format!("{at}mode must be tagged or monitor"));
    }
    if let Some(w) = f("workspace")
        && !matches!(w.as_str(), Some("shared" | "own"))
    {
        return Some(format!("{at}workspace must be shared or own"));
    }
    for k in ["focus", "model", "handle", "prompt"] {
        if f(k).is_some_and(|v| !v.is_null() && !v.is_string()) {
            return Some(format!("{at}{k} must be text"));
        }
    }
    for k in ["lead", "canEdit", "host"] {
        if f(k).is_some_and(|v| !v.is_boolean()) {
            return Some(format!("{at}{k} must be true or false"));
        }
    }
    if is_text(f("handle")) && RESERVED_HANDLES.contains(&handle_base(f("handle").and_then(Value::as_str).unwrap_or("")).as_str()) {
        return Some(format!("{at}handle \"{}\" is reserved", f("handle").and_then(Value::as_str).unwrap_or("")));
    }
    if js::truthy(f("host")) && f("count").and_then(Value::as_f64).unwrap_or(1.0) > 1.0 {
        return Some(format!("{at}the host is one participant: count must be 1"));
    }
    None
}

/// What's wrong with a roster (propose_huddle, starting a huddle), or None. `max`: most participants with @main.
pub fn roster_error(roster: &Value, max: usize) -> Option<String> {
    let list = match roster.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return Some("roster must be a non-empty list".into()),
    };
    for (i, e) in list.iter().enumerate() {
        if let Some(err) = roster_entry_error(e, &format!("entry {}: ", i + 1)) {
            return Some(err);
        }
    }
    if list.iter().filter(|e| js::truthy(get(e, "host"))).count() > 1 {
        return Some("a huddle has one host: set host on one entry only".into());
    }
    let total = 1.0 + list.iter().map(|e| get(e, "count").and_then(Value::as_f64).unwrap_or(1.0)).sum::<f64>();
    if total > max as f64 {
        return Some(format!("that is {} participants with @main, over the limit of {max}", js::string(&js::num(total))));
    }
    None
}

/// propose_huddle's maxCostUsd, capped: None when not given (undefined), Some(null) when it isn't a positive amount.
pub fn proposed_budget(v: Option<&Value>) -> Option<Value> {
    match v {
        None | Some(Value::Null) => None,
        Some(v) => match js::finite(Some(v)).filter(|x| *x > 0.0) {
            Some(x) => Some(js::num(x.min(PROPOSED_MAX_COST_USD))),
            None => Some(Value::Null),
        },
    }
}

// ---------- helper lines ----------

/// A helper line as the helper saves it: spaces folded, trimmed (non-text gives "").
pub fn helper_line_text(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|s| js::trim(&js::squash_spaces(s)).to_string()).unwrap_or_default()
}

static HIDDEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\x{FE00}-\x{FE0F}\x{E0100}-\x{E01EF}\x{2800}]")
        .expect("valid regex")
});

/// Characters a card can't show but a model still reads (controls, format, private-use, unassigned, ignorable, blank).
pub fn has_hidden_chars(text: &str) -> bool {
    HIDDEN.is_match(text)
}

/// Why a suggested line can't be shown on a card, or None when it can.
pub fn suggested_line_error(text: &str) -> Option<String> {
    if text.is_empty() {
        return Some("text is required: the exact line to add.".into());
    }
    let n = js::len16(text);
    if n > FEEDBACK_MAX {
        return Some(format!("text is too long ({n} characters, max {FEEDBACK_MAX})"));
    }
    if has_hidden_chars(text) {
        return Some("text has invisible or control characters the user wouldn't see on the card; use plain visible text only".into());
    }
    None
}

// ---------- teammates (propose_teammate) ----------

/// Checks `input` as huddle-presets.ts presetFromInput does with no base (the result itself isn't needed).
fn check_preset(input: &Value) -> Res<()> {
    if !is_object(input) {
        return Err("preset must be an object".into());
    }
    let f = |k: &str| get(input, k);
    let name = preset_name(f("name").and_then(Value::as_str).unwrap_or(""));
    if name.is_empty() {
        return Err("name is required".into());
    }
    if ["you", "all", "system", "current"].contains(&name.as_str()) {
        return Err("reserved".into());
    }
    let text = |k: &str| -> Res<Option<&str>> {
        match f(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(js::trim(s))),
            Some(_) => Err(format!("{k} must be text")),
        }
    };
    let flag = |k: &str| -> Res<Option<bool>> {
        match f(k) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(format!("{k} must be true or false")),
        }
    };
    let prompt = text("prompt")?.unwrap_or("");
    if prompt.is_empty() || js::len16(prompt) > MAX_PROMPT {
        return Err("prompt".into());
    }
    let lead = flag("lead")?.unwrap_or(false);
    let mode = match f("mode") {
        None | Some(Value::Null) => Value::String(if lead { "monitor" } else { "tagged" }.into()),
        Some(v) => v.clone(),
    };
    if !matches!(mode.as_str(), Some("tagged" | "monitor")) {
        return Err("mode".into());
    }
    let asked = match f("workspace") {
        None | Some(Value::Null) => Value::String("shared".into()),
        Some(v) => v.clone(),
    };
    if !matches!(asked.as_str(), Some("shared" | "own")) {
        return Err("workspace".into());
    }
    flag("canEdit")?;
    if f("model").is_some() {
        text("model")?;
    }
    text("role")?;
    Ok(())
}

/// The teammate card from propose_teammate's input, or None for input Bun would refuse.
pub fn parse_teammate_proposal(input: &Value) -> Option<Value> {
    check_preset(input).ok()?;
    let f = |k: &str| get(input, k);
    let why = str_trim(f("why"));
    if why.is_empty() || js::len16(why) > WHY_MAX {
        return None;
    }
    let mut out = Obj::new();
    out.insert("name".into(), preset_name(f("name")?.as_str()?).into());
    out.insert("prompt".into(), js::trim(f("prompt")?.as_str()?).into());
    out.insert("why".into(), why.into());
    if is_text(f("role")) {
        out.insert("role".into(), str_trim(f("role")).into());
    }
    if f("model").is_some() {
        let m = str_trim(f("model"));
        out.insert("model".into(), if m.is_empty() { Value::Null } else { m.into() });
    }
    for k in ["mode", "workspace", "canEdit", "lead"] {
        if let Some(v) = f(k) {
            out.insert(k.into(), number(v));
        }
    }
    Some(Value::Object(out))
}

// ---------- squads (propose_squad) ----------

/// huddle-templates.ts templateFromInput with no base and no preset list: the squad, or why it can't be one.
fn template_from_input(input: &Value) -> Res<Obj> {
    if !is_object(input) {
        return Err("template must be an object".into());
    }
    let f = |k: &str| get(input, k);
    let name = preset_name(f("name").and_then(Value::as_str).unwrap_or(""));
    if name.is_empty() {
        return Err("name is required".into());
    }
    let text = |k: &str| -> Res<Option<String>> {
        match f(k) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) if js::len16(s) > MAX_TEXT => Err(format!("{k} is too long")),
            Some(Value::String(s)) => Ok(Some(js::trim(s).to_string())),
            Some(_) => Err(format!("{k} must be text")),
        }
    };
    let roster = f("roster").ok_or("roster is required")?;
    if let Some(err) = roster_error(roster, 32) {
        return Err(err);
    }
    let rounds = match f("rounds") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => match integer(v) {
            Some(n) if (1.0..=MAX_ROUNDS).contains(&n) => js::num(n),
            _ => return Err("rounds".into()),
        },
    };
    let cost = match f("maxCostUsd") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => match js::finite(Some(v)) {
            Some(x) if x > 0.0 => js::num(x),
            _ => return Err("maxCostUsd".into()),
        },
    };
    let label = text("label")?.filter(|l| !l.is_empty()).unwrap_or_else(|| label_of(&name));
    let description = text("description")?.unwrap_or_default();
    let report = text("report")?.unwrap_or_default();
    let host_rules = text("hostRules")?.unwrap_or_default();
    let mut out = Obj::new();
    out.insert("name".into(), name.into());
    out.insert("label".into(), label.into());
    out.insert("description".into(), description.into());
    out.insert("roster".into(), number(roster));
    out.insert("rounds".into(), rounds);
    out.insert("maxCostUsd".into(), cost);
    out.insert("report".into(), report.into());
    out.insert("hostRules".into(), host_rules.into());
    Ok(out)
}

/// The teammate name a person with no preset is saved as: its handle, else its role (squad.ts teammateNameFor).
fn teammate_name_for(e: &Value) -> String {
    let handle = str_trim(get(e, "handle"));
    let n = preset_name(if handle.is_empty() { str_trim(get(e, "role")) } else { handle });
    if ["you", "all", "system", "current", "main"].contains(&n.as_str()) { format!("{n}-role") } else { n }
}

/// The squad card from propose_squad's input (`{squad, why, newTeammates}`), or None for input Bun would refuse.
pub fn parse_squad_proposal(input: &Value) -> Option<Value> {
    if !is_object(input) {
        return None;
    }
    let squad = template_from_input(input).ok()?;
    let why = str_trim(get(input, "why"));
    if why.is_empty() || js::len16(why) > WHY_MAX {
        return None;
    }
    let roster = squad.get("roster").and_then(Value::as_array).cloned().unwrap_or_default();
    let new_teammates: Vec<Value> = roster
        .iter()
        .enumerate()
        .filter(|(_, e)| !is_text(get(e, "preset")))
        .map(|(index, e)| {
            let mut t = Obj::new();
            t.insert("index".into(), index.into());
            t.insert("name".into(), teammate_name_for(e).into());
            t.insert("role".into(), str_trim(get(e, "role")).into());
            Value::Object(t)
        })
        .collect();
    let mut out = Obj::new();
    out.insert("squad".into(), Value::Object(squad));
    out.insert("why".into(), why.into());
    out.insert("newTeammates".into(), new_teammates.into());
    Some(Value::Object(out))
}

// ---------- automations (propose_automation) ----------

static DECIMAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").expect("valid regex"));

/// JS `Number(v)` for a JSON value.
pub fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => string_number(s),
        Value::Array(_) => string_number(&js::string(v)),
        Value::Object(_) => f64::NAN,
    }
}

fn string_number(s: &str) -> f64 {
    let t = js::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut x = 0.0;
            for c in digits.chars() {
                match c.to_digit(radix) {
                    Some(d) => x = x * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return x;
        }
    }
    if DECIMAL.is_match(t) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN }
}

static HTTPS_URL: LazyLock<Regex> = LazyLock::new(|| js_re(r"^https://\S+$"));
static TICKET_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,80}$").expect("valid regex"));

/// The automation card from propose_automation's input, or None for input Bun would refuse.
pub fn parse_automation_proposal(input: &Value) -> Option<Value> {
    let f = |k: &str| get(input, k);
    let name = js::cut16(str_trim(f("name")), 80);
    if name.is_empty() {
        return None;
    }
    let script = f("script").and_then(Value::as_str).unwrap_or("");
    if js::trim(script).is_empty() || js::len16(script) > 64_000 {
        return None;
    }
    let every = f("everyMinutes").map(js_number).unwrap_or(15.0);
    if !(every.is_finite() && every.fract() == 0.0 && (1.0..=1440.0).contains(&every)) {
        return None;
    }
    let raw = match f("passes") {
        None => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(_) => return None,
    };
    let mut passes = Vec::new();
    for p in &raw {
        let g = |k: &str| str_trim(get(p, k));
        let n = g("name");
        if n.is_empty() {
            return None;
        }
        let mut o = Obj::new();
        o.insert("name".into(), js::cut16(n, 60).into());
        if !g("from").is_empty() {
            o.insert("from".into(), g("from").into());
        }
        if HTTPS_URL.is_match(g("url")) {
            o.insert("url".into(), g("url").into());
        }
        if !g("envName").is_empty() {
            o.insert("envName".into(), g("envName").into());
        }
        if !g("keyHelp").is_empty() {
            o.insert("keyHelp".into(), js::cut16(g("keyHelp"), 300).into());
        }
        passes.push(o);
    }
    let summary = js::cut16(str_trim(f("summary")), 300);
    if summary.is_empty() {
        return None;
    }
    let part_of = str_trim(f("partOf"));
    if !part_of.is_empty() && !TICKET_REF.is_match(part_of) {
        return None;
    }
    let service = match str_trim(f("service")) {
        "" => passes.first().and_then(|p| p.get("name")).and_then(Value::as_str).unwrap_or("a script").to_string(),
        s => s.to_string(),
    };
    let mut out = Obj::new();
    out.insert("name".into(), name.into());
    out.insert("script".into(), script.into());
    out.insert("everyMinutes".into(), js::num(every));
    out.insert("passes".into(), passes.into_iter().map(Value::Object).collect::<Vec<_>>().into());
    out.insert("summary".into(), summary.into());
    out.insert("service".into(), js::cut16(&service, 60).into());
    let instructions = str_trim(f("instructions"));
    if !instructions.is_empty() {
        out.insert("instructions".into(), js::cut16(instructions, 8000).into());
    }
    if let Some(ask) = f("askClaude").filter(|a| is_object(a)) {
        let mut a = Obj::new();
        a.insert("on".into(), (get(ask, "on") == Some(&Value::Bool(true))).into());
        a.insert("prompt".into(), js::cut16(str_trim(get(ask, "prompt")), 4000).into());
        out.insert("askClaude".into(), Value::Object(a));
    }
    if !part_of.is_empty() {
        out.insert("partOf".into(), part_of.into());
    }
    if f("autoStart") == Some(&Value::Bool(true)) {
        out.insert("autoStart".into(), true.into());
    }
    Some(Value::Object(out))
}

// ---------- key boxes (ask_keys) ----------

static KEY_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z_][A-Z0-9_]{0,63}$").expect("valid regex"));
const RESERVED_KEYS: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TMP", "TEMP", "PWD", "IFS", "PS4", "CDPATH", "BASH_ENV", "ENV", "ZDOTDIR",
    "PROMPT_COMMAND", "EDITOR", "VISUAL", "PAGER", "SSH_AUTH_SOCK", "GNUPGHOME", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
];
const RESERVED_KEY_PREFIXES: &[&str] = &[
    "CKANBAN_", "CLAUDE", "ANTHROPIC_", "AWS_BEARER_TOKEN_BEDROCK", "VERTEX_", "GH_", "DYLD_", "LD_", "NODE_", "BUN_", "npm_", "GIT_", "LC_",
    "XDG_", "SSL_", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "MCP_", "OTEL_", "DISABLE_", "PYTHON",
];

/// Whether `name` can be a saved key's name (board-keys.ts keyNameError is null).
pub fn key_name_ok(name: &str) -> bool {
    KEY_NAME.is_match(name) && !RESERVED_KEYS.contains(&name) && !RESERVED_KEY_PREFIXES.iter().any(|p| name.starts_with(p))
}

static CREATE_URL: LazyLock<Regex> = LazyLock::new(|| js_re(r#"^https://[^\s"<>]+$"#));

/// The key box from ask_keys' input (`{keys, reason, replace}`), or None for input Bun would refuse.
pub fn parse_keys_ask(input: &Value) -> Option<Value> {
    let raw = get(input, "keys")?.as_array().filter(|a| !a.is_empty() && a.len() <= MAX_ASKED_KEYS)?;
    let mut seen: Vec<&str> = Vec::new();
    let mut keys = Vec::new();
    for k in raw {
        let env_name = str_trim(get(k, "envName"));
        if !key_name_ok(env_name) || seen.contains(&env_name) {
            return None;
        }
        seen.push(env_name);
        let label = js::cut16(&js::squash_spaces(str_trim(get(k, "label"))), 80).to_string();
        if label.is_empty() {
            return None;
        }
        let help = js::cut16(&js::squash_spaces(str_trim(get(k, "help"))), 200).to_string();
        let url = str_trim(get(k, "createUrl"));
        if !url.is_empty() && !CREATE_URL.is_match(url) {
            return None;
        }
        let mut o = Obj::new();
        o.insert("envName".into(), env_name.into());
        o.insert("label".into(), label.into());
        if !help.is_empty() {
            o.insert("help".into(), help.into());
        }
        if !url.is_empty() {
            o.insert("createUrl".into(), url.into());
        }
        keys.push(Value::Object(o));
    }
    let reason = js::cut16(&js::squash_spaces(str_trim(get(input, "reason"))), 300).to_string();
    if reason.is_empty() {
        return None;
    }
    let replace = get(input, "replace");
    if replace.is_some_and(|r| !r.is_boolean()) {
        return None;
    }
    let mut out = Obj::new();
    out.insert("keys".into(), keys.into());
    out.insert("reason".into(), reason.into());
    out.insert("replace".into(), (replace == Some(&Value::Bool(true))).into());
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_and_numbers_like_js() {
        assert_eq!(preset_name("  QA Lead!! "), "qa-lead");
        assert_eq!(handle_base("@@"), "agent");
        assert_eq!(js_number(&json!(" 0x1F ")), 31.0);
        assert_eq!(js_number(&json!([7])), 7.0);
        assert!(js_number(&json!("inf")).is_nan());
        assert_eq!(label_of("plan-review"), "Plan review");
        assert!(has_hidden_chars("a\u{200B}b"));
    }
}
