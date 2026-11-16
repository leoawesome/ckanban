//! Small JavaScript behaviours the ported routes must copy exactly: `String(x)`, `trim()`, `\s`, truthiness and
//! UTF-16 slicing.

use serde_json::Value;

/// JS's `\s` and what `trim()` removes (WhiteSpace and LineTerminator). Rust's `char::is_whitespace` adds U+0085 and
/// lacks U+FEFF.
pub fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.replace(/\s+/g, " ")`.
pub fn squash_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// `s.slice(0, n)` counting UTF-16 units. None when the cut would split a surrogate pair (JS keeps half a pair,
/// which a Rust string can't hold): the caller lets Bun answer then.
pub fn slice_utf16(s: &str, n: usize) -> Option<&str> {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units == n {
            return Some(&s[..i]);
        }
        units += c.len_utf16();
        if units > n {
            return None;
        }
    }
    Some(s)
}

/// `String(v)` for a JSON value.
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(ckanban_core::jsnum::js_string).unwrap_or_else(|| n.to_string()),
        Value::String(s) => s.clone(),
        // Array.prototype.toString: elements joined by ",", null and undefined as "".
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS truthiness.
pub fn truthy(v: Option<&Value>) -> bool {
    ckanban_core::jsnum::truthy(v)
}

/// `a < b ? -1 : a > b ? 1 : 0` for two values JS compares (strings by UTF-16 units; anything else counts as equal
/// here, which is what JS gives for undefined).
pub fn cmp_str(a: Option<&Value>, b: Option<&Value>) -> std::cmp::Ordering {
    match (a.and_then(Value::as_str), b.and_then(Value::as_str)) {
        (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        _ => std::cmp::Ordering::Equal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn behaves_like_js() {
        assert_eq!(trim("\u{feff} a b \u{3000}"), "a b");
        assert_eq!(trim("\u{85}a"), "\u{85}a");
        assert_eq!(squash_spaces("a \t\n b  c"), "a b c");
        assert_eq!(slice_utf16("abc", 2), Some("ab"));
        assert_eq!(slice_utf16("ab", 5), Some("ab"));
        assert_eq!(slice_utf16("a😀b", 3), Some("a😀"));
        assert_eq!(slice_utf16("a😀b", 2), None);
        assert_eq!(string(&json!(["key"])), "key");
        assert_eq!(string(&json!([1, null, "x"])), "1,,x");
        assert_eq!(string(&json!({})), "[object Object]");
        assert_eq!(string(&json!(1.5)), "1.5");
        assert_eq!(string(&json!(null)), "null");
    }
}
