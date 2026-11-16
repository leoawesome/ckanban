//! The bits of JavaScript semantics the run engine needs to give Bun's exact answers: string lengths and slices in
//! UTF-16 units, `trim()` and `\s`, `Number(x)`, `String(x)`, strict equality, `JSON.parse` of lines Claude writes
//! (lone surrogate escapes included) and `JSON.stringify` (key order, number text, a string hook for `liveJson`).

use ckanban_core::jskeys;
use ckanban_core::jsnum::js_string;
use serde_json::Value;

/// `s.length`.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` (n in UTF-16 units). A cut through a surrogate pair drops the half character (JS would keep a
/// lone surrogate, which a Rust string can't hold).
pub fn head16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if units + w > n {
            return &s[..i];
        }
        units += w;
    }
    s
}

/// `s.slice(-n)` (n in UTF-16 units), with the same rule for a cut pair.
pub fn tail16(s: &str, n: usize) -> &str {
    let total = len16(s);
    if total <= n {
        return s;
    }
    let skip = total - n;
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units >= skip {
            return &s[i..];
        }
        units += c.len_utf16();
    }
    ""
}

/// What JS's `trim()` and `\s` count as white space.
pub fn is_ws(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// A regex class for JS's `\s` (Rust's `\s` differs on U+0085 and U+FEFF).
pub const WS: &str = r"[\t\n\x0B\x0C\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_ws)
}

/// `s.replace(/\s+/g, " ")`.
pub fn squash_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for c in s.chars() {
        if is_ws(c) {
            if !in_ws {
                out.push(' ');
            }
            in_ws = true;
        } else {
            out.push(c);
            in_ws = false;
        }
    }
    out
}

/// `s.split(/\s+/).filter(Boolean)`.
pub fn words(s: &str) -> Vec<String> {
    s.split(is_ws).filter(|w| !w.is_empty()).map(str::to_string).collect()
}

/// `Number(s)` for a string.
pub fn number_of_str(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        if p.is_empty() || !p.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        p.chars().fold(0.0, |acc, c| acc * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0)))
    };
    let lower = t.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // A JS decimal literal: digits, one dot, an exponent; Rust's parser also takes "inf" and "nan", JS doesn't.
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let (mant, exp) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let mant_ok = !mant.is_empty() && mant != "." && mant.chars().all(|c| c.is_ascii_digit() || c == '.') && mant.matches('.').count() <= 1;
    let exp_ok = exp.is_none_or(|e| {
        let d = e.strip_prefix(['+', '-']).unwrap_or(e);
        !d.is_empty() && d.chars().all(|c| c.is_ascii_digit())
    });
    if !mant_ok || !exp_ok {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(v)` for a JSON value (undefined is None: NaN).
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_of_str(s),
        Some(Value::Array(a)) => match a.as_slice() {
            [] => 0.0,
            [one] => number_of_str(&to_string(one)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `String(v)`.
pub fn to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(js_string).unwrap_or_else(|| n.to_string()),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { to_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `a === b` for values read from JSON (objects and arrays are never equal: they are different objects).
pub fn strict_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x == y,
        _ => false,
    }
}

/// JS truthiness of a value (undefined is None).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `JSON.parse(text)` as JS reads it: numbers and key order as JS keeps them. JS takes `\ud83d` escapes on their own
/// (a cut emoji in tool output); serde_json refuses them, so they are read as U+FFFD instead of losing the line.
pub fn parse(text: &str) -> Option<Value> {
    let v = match serde_json::from_str::<Value>(text) {
        Ok(v) => v,
        Err(_) if text.contains("\\u") || text.contains("\\U") => serde_json::from_str::<Value>(&fix_surrogates(text)).ok()?,
        Err(_) => return None,
    };
    Some(jskeys::order(ckanban_core::jsnum::normalize(v)))
}

/// Rewrites `\uD8xx` escapes that aren't half of a pair to `�`.
fn fix_surrogates(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let hex_at = |i: usize| -> Option<u16> {
        if i + 6 <= b.len() && b[i] == b'\\' && b[i + 1] == b'u' {
            std::str::from_utf8(&b[i + 2..i + 6]).ok().and_then(|h| u16::from_str_radix(h, 16).ok())
        } else {
            None
        }
    };
    let mut last = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            // Count the backslashes: an escaped backslash isn't the start of an escape.
            if let Some(u) = hex_at(i) {
                let high = (0xD800..0xDC00).contains(&u);
                let low = (0xDC00..0xE000).contains(&u);
                if high && hex_at(i + 6).is_some_and(|n| (0xDC00..0xE000).contains(&n)) {
                    i += 12;
                    continue;
                }
                if high || low {
                    out.push_str(&text[last..i]);
                    out.push_str("\\ufffd");
                    i += 6;
                    last = i;
                    continue;
                }
                i += 6;
                continue;
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    out.push_str(&text[last..]);
    out
}

/// `JSON.stringify(v)`: keys in JS order, numbers as JS writes them.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write(&mut out, v, &mut |s, out| push_str(out, s));
    out
}

/// `JSON.stringify(v)` with every string value (not keys) written by `hook` (which appends its JSON text).
pub fn stringify_with(v: &Value, hook: &mut dyn FnMut(&str, &mut String)) -> String {
    let mut out = String::new();
    write(&mut out, v, hook);
    out
}

/// A string as JSON text (JS and serde_json escape the same characters, lowercase hex).
pub fn push_str(out: &mut String, s: &str) {
    out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()));
}

fn write(out: &mut String, v: &Value, hook: &mut dyn FnMut(&str, &mut String)) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x.is_finite() => out.push_str(&js_string(x)),
            Some(_) => out.push_str("null"),
            None => out.push_str(&n.to_string()),
        },
        Value::String(s) => hook(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, x, hook);
            }
            out.push(']');
        }
        Value::Object(_) => {
            let ordered = jskeys::ordered(v);
            let Value::Object(m) = ordered.as_ref() else { return };
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_str(out, k);
                out.push(':');
                write(out, x, hook);
            }
            out.push('}');
        }
    }
}

/// `a.localeCompare(b)` for the ASCII text it is used on here (paths): ICU's root order, where punctuation sorts
/// before digits and digits before letters, letters ignore case first and lowercase wins a tie.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    const PUNCT: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    let primary = |c: char| -> (u32, u32) {
        if let Some(i) = PUNCT.find(c) {
            (0, i as u32)
        } else if c.is_ascii_digit() {
            (1, c as u32)
        } else if c.is_alphabetic() {
            (2, c.to_lowercase().next().unwrap_or(c) as u32)
        } else {
            (3, c as u32)
        }
    };
    let pa: Vec<_> = a.chars().map(primary).collect();
    let pb: Vec<_> = b.chars().map(primary).collect();
    pa.cmp(&pb).then_with(|| {
        // Tertiary: lowercase before uppercase at the first difference.
        for (x, y) in a.chars().zip(b.chars()) {
            if x != y {
                return match (x.is_lowercase(), y.is_lowercase()) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => x.cmp(&y),
                };
            }
        }
        a.len().cmp(&b.len())
    })
}

/// JS's default `sort()` order (UTF-16 code units).
pub fn cmp16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_cuts() {
        assert_eq!(len16("a😀b"), 4);
        assert_eq!(head16("a😀b", 2), "a");
        assert_eq!(head16("a😀b", 3), "a😀");
        assert_eq!(tail16("abcdef", 2), "ef");
        assert_eq!(tail16("ab", 5), "ab");
    }

    #[test]
    fn numbers_like_js() {
        assert_eq!(number_of_str(" 12 "), 12.0);
        assert_eq!(number_of_str("0x10"), 16.0);
        assert!(number_of_str("inf").is_nan());
        assert!(number_of_str("1.2.3").is_nan());
        assert_eq!(number_of_str(""), 0.0);
        assert_eq!(number(Some(&json!([" 7 "]))), 7.0);
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert!(number(None).is_nan());
    }

    #[test]
    fn parse_keeps_lone_surrogates_readable() {
        let v = parse(r#"{"t":"cut \ud83d","ok":"😀","esc":"\\ud83d"}"#).unwrap();
        assert_eq!(v["t"], "cut \u{fffd}");
        assert_eq!(v["ok"], "😀");
        assert_eq!(v["esc"], "\\ud83d");
    }

    #[test]
    fn stringify_like_js() {
        let v = parse(r#"{"b":1.50,"2":true,"1":[1e21,0.0000015,"x\u0001"]}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"1":[1e+21,0.0000015,"x\u0001"],"2":true,"b":1.5}"#);
    }
}
