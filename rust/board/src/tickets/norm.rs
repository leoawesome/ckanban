//! Small rules the ticket writes share, the same as Bun's: tags (`src/board/tags.ts`), resource names
//! (`normalizeNeeds` in `src/board/plan.ts`), a ⭐ at the start of a title (`starredTitle`) and slugs (`slugify` in
//! `src/core/util.ts`), task kinds and their default models (`web/src/lib/models.ts`), model and effort names
//! (`src/chat/commands.ts`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::index::text::{is_space, js_trim, len16, slice16};

/// Longest tag kept, and most tags on one ticket.
pub const TAG_MAX_LEN: usize = 24;
pub const TAGS_MAX: usize = 10;

pub const STATUSES: [&str; 6] = ["backlog", "planning", "ready", "in_progress", "review", "done"];
/// Moves a ticket's own chat may ask for (`SELF_MOVES`).
pub const SELF_MOVES: [&str; 3] = ["done", "backlog", "ready"];
pub const TICKET_KINDS: [&str; 8] = ["explore", "build", "test", "review", "fix", "group", "round", "with_you"];
/// A planner restarts a child at most this often (`MAX_RETRIES`).
pub const MAX_RETRIES: f64 = 3.0;

/// `KIND_DEFAULTS`: the kinds with their default model and effort, in Bun's order.
pub const KIND_DEFAULTS: [(&str, &str, &str); 8] = [
    ("explore", "sonnet", "medium"),
    ("build", "opus", "medium"),
    ("fix", "opus", "medium"),
    ("test", "opus", "medium"),
    ("review", "fable", "high"),
    ("with_you", "sonnet", "medium"),
    ("group", "sonnet", "low"),
    ("round", "sonnet", "low"),
];

const MODEL_ALIASES: [&str; 5] = ["fable", "opus", "sonnet", "haiku", "opusplan"];
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `MODEL_HELP`.
pub fn model_help() -> String {
    format!("{}, a full model id (claude-…), or default", MODEL_ALIASES.join(", "))
}

/// `EFFORT_HELP`.
pub fn effort_help() -> String {
    format!("{}, or default (turn ultracode on or off with /effort ultracode, /effort ultracode off)", EFFORTS.join(", "))
}

static MODEL_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^claude-[a-z0-9][a-z0-9.-]*$").unwrap());

/// `validModel`.
pub fn valid_model(name: &str) -> bool {
    let lower = name.to_lowercase();
    let base = lower.strip_suffix("[1m]").unwrap_or(&lower);
    MODEL_ALIASES.contains(&base) || MODEL_ID.is_match(base)
}

/// `validEffort`.
pub fn valid_effort(name: &str) -> bool {
    EFFORTS.contains(&name)
}

/// `kindDefaults(kind, profile)`: a tool ticket's model and effort from its kind (the board's Task models override,
/// else the default). None for no kind or an unknown one.
pub fn kind_defaults(kind: Option<&str>, task_models: Option<&Value>) -> Option<(String, String)> {
    let kind = kind.filter(|k| !k.is_empty())?;
    let (_, model, effort) = KIND_DEFAULTS.iter().find(|(k, _, _)| *k == kind)?;
    let o = task_models.and_then(|v| v.get(kind));
    let text = |k: &str| o.and_then(|o| o.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty());
    Some(match (text("model"), text("effort")) {
        (Some(m), Some(e)) => (m.to_string(), e.to_string()),
        _ => (model.to_string(), effort.to_string()),
    })
}

/// `s.replace(/\s+/g, sep)` with JavaScript's `\s`.
fn squash(s: &str, sep: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_space {
                out.push_str(sep);
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `normalizeTag`: trimmed, lowercase, no leading #, spaces become dashes, at most 24 characters; "" when nothing is left.
pub fn normalize_tag(v: &str) -> String {
    let t = js_trim(v).trim_start_matches('#');
    let t = js_trim(t).to_lowercase();
    let t = squash(&t, "-");
    let cut = if len16(&t) > TAG_MAX_LEN { slice16(&t, TAG_MAX_LEN).to_string() } else { t };
    cut.trim_end_matches('-').to_string()
}

/// `normalizeTags`: normalized, no blanks or repeats, at most 10.
pub fn normalize_tags(v: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(a)) = v else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for t in a.iter().filter_map(Value::as_str).map(normalize_tag) {
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out.truncate(TAGS_MAX);
    out
}

/// `normalizeNeeds`: trimmed, lowercase, no blanks or repeats.
pub fn normalize_needs(v: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(a)) = v else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for t in a.iter().filter_map(Value::as_str).map(|s| js_trim(s).to_lowercase()) {
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// The route helper `strings`: a list's non-blank strings, trimmed; None when it isn't a list.
pub fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    let Some(Value::Array(a)) = v else { return None };
    Some(a.iter().filter_map(Value::as_str).filter(|s| !js_trim(s).is_empty()).map(|s| js_trim(s).to_string()).collect())
}

/// `starredTitle`: a ⭐ typed at the start of a title marks the ticket Important; the title keeps the rest.
pub fn starred_title(title: &str) -> (String, bool) {
    let mut rest = title.trim_start_matches(is_space);
    if !rest.starts_with('⭐') {
        return (title.to_string(), false);
    }
    while let Some(r) = rest.strip_prefix('⭐') {
        rest = r.strip_prefix('\u{FE0F}').unwrap_or(r).trim_start_matches(is_space);
    }
    (rest.to_string(), true)
}

/// `slugify(s, max)`: lowercase letters and digits joined by dashes, at most `max` characters, "task" when empty.
/// Accented Latin letters lose their accent as with `normalize("NFKD")` (the accent becomes a dash); other
/// characters NFKD would change (ligatures, full-width forms outside ASCII letters) are not decomposed here.
pub fn slugify(s: &str, max: usize) -> String {
    let mut decomposed = String::with_capacity(s.len());
    for c in s.chars() {
        match base_letter(c) {
            Some(b) => {
                decomposed.push(b);
                decomposed.push('\u{301}');
            }
            None => decomposed.push(c),
        }
    }
    let lower = decomposed.to_lowercase();
    let mut out = String::new();
    let mut dash = false;
    for c in lower.chars() {
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
    let cut: String = out.chars().take(max).collect();
    let cut = cut.trim_end_matches('-').to_string();
    if cut.is_empty() { "task".into() } else { cut }
}

/// The base letter of an accented Latin letter (what NFKD keeps before the combining mark); full-width ASCII
/// letters and digits map to ASCII.
fn base_letter(c: char) -> Option<char> {
    const TABLE: &[(&str, char)] = &[
        ("ÀÁÂÃÄÅĀĂĄǍ", 'A'),
        ("àáâãäåāăąǎ", 'a'),
        ("ÇĆĈĊČ", 'C'),
        ("çćĉċč", 'c'),
        ("ĎḌ", 'D'),
        ("ďḍ", 'd'),
        ("ÈÉÊËĒĔĖĘĚ", 'E'),
        ("èéêëēĕėęě", 'e'),
        ("ĜĞĠĢ", 'G'),
        ("ĝğġģ", 'g'),
        ("ĤḤ", 'H'),
        ("ĥḥ", 'h'),
        ("ÌÍÎÏĨĪĬĮİǏ", 'I'),
        ("ìíîïĩīĭįǐ", 'i'),
        ("Ĵ", 'J'),
        ("ĵ", 'j'),
        ("Ķ", 'K'),
        ("ķ", 'k'),
        ("ĹĻĽ", 'L'),
        ("ĺļľ", 'l'),
        ("ÑŃŅŇ", 'N'),
        ("ñńņň", 'n'),
        ("ÒÓÔÕÖŌŎŐǑ", 'O'),
        ("òóôõöōŏőǒ", 'o'),
        ("ŔŖŘ", 'R'),
        ("ŕŗř", 'r'),
        ("ŚŜŞŠȘ", 'S'),
        ("śŝşšș", 's'),
        ("ŢŤȚ", 'T'),
        ("ţťț", 't'),
        ("ÙÚÛÜŨŪŬŮŰŲǓ", 'U'),
        ("ùúûüũūŭůűųǔ", 'u'),
        ("Ŵ", 'W'),
        ("ŵ", 'w'),
        ("ÝŸŶ", 'Y'),
        ("ýÿŷ", 'y'),
        ("ŹŻŽ", 'Z'),
        ("źżž", 'z'),
    ];
    if ('\u{FF10}'..='\u{FF19}').contains(&c) || ('\u{FF21}'..='\u{FF3A}').contains(&c) || ('\u{FF41}'..='\u{FF5A}').contains(&c) {
        return char::from_u32(c as u32 - 0xFEE0);
    }
    TABLE.iter().find(|(set, _)| set.contains(c)).map(|(_, b)| *b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tags_like_bun() {
        assert_eq!(normalize_tag("  ##Big Thing  "), "big-thing");
        assert_eq!(normalize_tag("a-very-long-tag-name-that-goes-on"), "a-very-long-tag-name-tha");
        assert_eq!(normalize_tag("abcdefghijklmnopqrstuvw-x"), "abcdefghijklmnopqrstuvw");
        let many: Vec<Value> = (0..12).map(|i| json!(format!("t{i}"))).collect();
        assert_eq!(normalize_tags(Some(&Value::Array(many))).len(), 10);
        assert_eq!(normalize_tags(Some(&json!(["A", "a", " ", 3, "#b"]))), vec!["a", "b"]);
        assert_eq!(normalize_needs(Some(&json!([" Phone ", "phone", ""]))), vec!["phone"]);
    }

    #[test]
    fn stars_and_slugs() {
        assert_eq!(starred_title("⭐️ ⭐ Ship it"), ("Ship it".to_string(), true));
        assert_eq!(starred_title("Ship ⭐"), ("Ship ⭐".to_string(), false));
        assert_eq!(slugify("Other board", 40), "other-board");
        assert_eq!(slugify("Café Résumé", 40), "cafe-re-sume");
        assert_eq!(slugify("!!!", 40), "task");
        assert_eq!(slugify("abc-def", 4), "abc");
    }

    #[test]
    fn models_and_kinds() {
        assert!(valid_model("opus") && valid_model("Opus[1m]") && valid_model("claude-opus-5-5"));
        assert!(!valid_model("gpt") && !valid_model("claude-"));
        assert_eq!(kind_defaults(Some("review"), None), Some(("fable".into(), "high".into())));
        let o = json!({ "build": { "model": "sonnet", "effort": "low" } });
        assert_eq!(kind_defaults(Some("build"), Some(&o)), Some(("sonnet".into(), "low".into())));
        assert_eq!(kind_defaults(Some("nope"), None), None);
    }
}
