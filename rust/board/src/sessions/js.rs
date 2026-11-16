//! Small JavaScript behaviours the session code must copy exactly: `trim()`, `\s`, `String(x)`, truthiness, numbers
//! and UTF-16 lengths and slices (JS strings count UTF-16 units).

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

/// `s.trimStart()`.
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// `s.trimEnd()`.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
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

/// `s.length`: UTF-16 units.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Byte index of UTF-16 unit `n` (clamped to the end; a cut inside a surrogate pair moves before the pair, where JS
/// would keep half of it).
fn byte_at16(s: &str, n: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units + c.len_utf16() > n {
            return i;
        }
        units += c.len_utf16();
    }
    s.len()
}

/// `s.slice(start, end)` with non-negative UTF-16 indexes (`end` None: to the end).
pub fn slice16(s: &str, start: usize, end: Option<usize>) -> &str {
    let a = byte_at16(s, start);
    let b = end.map(|e| byte_at16(s, e)).unwrap_or(s.len());
    if b <= a { "" } else { &s[a..b] }
}

/// `s.slice(0, n)`.
pub fn cut16(s: &str, n: usize) -> &str {
    slice16(s, 0, Some(n))
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

/// `String(v ?? "")`: undefined and null give "".
pub fn string_or_empty(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => string(v),
    }
}

/// JS truthiness (`!!v`; a missing key is undefined).
pub fn truthy(v: Option<&Value>) -> bool {
    ckanban_core::jsnum::truthy(v)
}

/// A number as JS would print it in JSON (integers without ".0").
pub fn num(x: f64) -> Value {
    ckanban_core::jsnum::num(x)
}

/// `typeof v === "number" && Number.isFinite(v)`.
pub fn finite(v: Option<&Value>) -> Option<f64> {
    ckanban_core::jsnum::finite(v)
}

/// `typeof v === "string" ? v : None`.
pub fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `v?.a?.b...`: a path of object keys; None as soon as one is missing or not an object.
pub fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.as_object()?.get(*k)?;
    }
    Some(cur)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn behaves_like_js() {
        assert_eq!(trim("\u{feff} a b \u{3000}"), "a b");
        assert_eq!(squash_spaces("a \t\n b  c"), "a b c");
        assert_eq!(len16("a😀"), 3);
        assert_eq!(cut16("abc", 2), "ab");
        assert_eq!(cut16("a😀b", 3), "a😀");
        assert_eq!(cut16("a😀b", 2), "a");
        assert_eq!(slice16("abcdef", 2, Some(4)), "cd");
        assert_eq!(slice16("abc", 5, None), "");
        assert_eq!(string(&json!([1, null, "x"])), "1,,x");
        assert_eq!(string_or_empty(None), "");
        assert_eq!(at(&json!({"a": {"b": 1}}), &["a", "b"]), Some(&json!(1)));
    }
}
