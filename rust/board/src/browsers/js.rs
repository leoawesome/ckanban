//! The few JavaScript conversions the browser code relies on (`Number(x)`, `String(x)`, `/\s+/g` and WHATWG URLs), so
//! answers and saved files match Bun's for the same input.

use serde_json::Value;
use url::Url;

use crate::prompts::js::{is_js_space, num};

/// `Number(v)` for a JSON value: text is read as a number (blank is 0), `true` 1, `null` 0, anything else NaN.
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        Value::String(s) => text_number(s),
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => number(&Value::String(string(&a[0]))),
        _ => f64::NAN,
    }
}

/// `Number("...")`: trimmed; "" is 0; decimal, `0x`/`0o`/`0b` and `Infinity`; anything else NaN.
fn text_number(s: &str) -> f64 {
    let t = crate::prompts::js::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| u64::from_str_radix(p, r).map(|n| n as f64).unwrap_or(f64::NAN);
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(h, 16);
    }
    if let Some(o) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(o, 8);
    }
    if let Some(b) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(b, 2);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also reads "inf" and "nan", which JavaScript doesn't.
    if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(v)`: text as is, numbers as JavaScript prints them, `null`, `true`/`false`, `[object Object]`.
pub fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(num).unwrap_or_else(|| n.to_string()),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `s.replace(/\s+/g, " ")`.
pub fn squash_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// `/^[a-z][a-z0-9+.-]*:/i`: the text starts with a scheme.
pub fn has_scheme(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || !b[0].is_ascii_alphabetic() {
        return false;
    }
    for &c in &b[1..] {
        if c == b':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == b'+' || c == b'.' || c == b'-') {
            return false;
        }
    }
    false
}

/// `new URL(s)`; None where it throws.
pub fn parse_url(s: &str) -> Option<Url> {
    Url::parse(s).ok()
}

/// `URL.hostname`: the host without a port ("" when there is none).
pub fn hostname(u: &Url) -> String {
    match u.host() {
        Some(url::Host::Ipv6(a)) => format!("[{a}]"),
        Some(h) => h.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_and_string_like_javascript() {
        assert_eq!(number(&json!(" 3 ")), 3.0);
        assert_eq!(number(&json!("")), 0.0);
        assert_eq!(number(&json!(null)), 0.0);
        assert_eq!(number(&json!(true)), 1.0);
        assert!(number(&json!("inf")).is_nan());
        assert!(number(&json!({})).is_nan());
        assert_eq!(number(&json!("0x10")), 16.0);
        assert_eq!(number(&json!("1e2")), 100.0);
        assert_eq!(string(&json!(2.5)), "2.5");
        assert_eq!(string(&json!(null)), "null");
        assert_eq!(string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(squash_spaces("  a \t\n b  "), " a b ");
        assert!(has_scheme("https://x"));
        assert!(has_scheme("ftp:x"));
        assert!(!has_scheme("example.com/login"));
        assert!(!has_scheme("localhost"));
    }
}
