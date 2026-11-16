//! Argument parsing as `parseArgs` in `src/cli/ticket-cli.ts`, plus the few JS conversions the CLI relies on
//! (`Number(s)`, `String(v)`).

use std::collections::HashMap;

use ckanban_core::jsnum;
use serde_json::Value;

/// Flags that take no value.
const BOOLEAN_FLAGS: [&str; 5] = ["json", "claude", "codex", "no-logs", "include-tool"];

#[derive(Debug, Clone, PartialEq)]
pub enum Flag {
    On,
    Str(String),
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub positional: Vec<String>,
    pub flags: HashMap<String, Flag>,
}

impl Parsed {
    /// `flagStr`: the value of a flag that was given a value.
    pub fn str(&self, name: &str) -> Option<&str> {
        match self.flags.get(name) {
            Some(Flag::Str(s)) => Some(s),
            _ => None,
        }
    }

    /// `!!p.flags[name]`.
    pub fn on(&self, name: &str) -> bool {
        match self.flags.get(name) {
            Some(Flag::On) => true,
            Some(Flag::Str(s)) => !s.is_empty(),
            None => false,
        }
    }

    pub fn pos(&self, i: usize) -> Option<&str> {
        self.positional.get(i).map(String::as_str)
    }
}

/// `--name value`, `--name=value` and boolean flags; everything else is positional. `--` ends flags.
pub fn parse(argv: &[String]) -> Result<Parsed, String> {
    let mut p = Parsed::default();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--" {
            p.positional.extend(argv[i + 1..].iter().cloned());
            break;
        }
        if !a.starts_with("--") || a.len() == 2 {
            p.positional.push(a.clone());
            i += 1;
            continue;
        }
        let eq = a.find('=').filter(|&e| e > 0);
        let name = a[2..eq.unwrap_or(a.len())].to_string();
        if let Some(e) = eq {
            p.flags.insert(name, Flag::Str(a[e + 1..].to_string()));
        } else if BOOLEAN_FLAGS.contains(&name.as_str()) {
            p.flags.insert(name, Flag::On);
        } else {
            if i + 1 >= argv.len() {
                return Err(format!("--{name} needs a value"));
            }
            i += 1;
            p.flags.insert(name, Flag::Str(argv[i].clone()));
        }
        i += 1;
    }
    Ok(p)
}

/// `Number(s)` for a string: blank is 0, decimal/exponent, `0x`/`0o`/`0b` integers and `Infinity`; anything else NaN.
pub fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(prefix) {
            return if !rest.is_empty() && rest.chars().all(|c| c.is_digit(radix)) {
                rest.chars().fold(0.0, |acc, c| acc * radix as f64 + c.to_digit(radix).unwrap() as f64)
            } else {
                f64::NAN
            };
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also reads "inf" and "nan"; JS doesn't.
    if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `String(v)` / `${v}` of a JSON value.
pub fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.as_f64().map(jsnum::js_string).unwrap_or_else(|| n.to_string()),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_str(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

pub fn truthy(v: Option<&Value>) -> bool {
    jsnum::truthy(v)
}

/// `JSON.stringify(v, null, 2)`, numbers written as JS writes them.
pub fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(&jsnum::normalize(v.clone())).unwrap_or_default()
}

/// `JSON.stringify(v)`.
pub fn compact(v: &Value) -> String {
    serde_json::to_string(&jsnum::normalize(v.clone())).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_like_bun() {
        let p = parse(&a(&["list", "--status", "--json", "--json", "--x=1=2", "-v", "--", "--a"])).unwrap();
        assert_eq!(p.positional, a(&["list", "-v", "--a"]));
        assert_eq!(p.str("status"), Some("--json"));
        assert!(p.on("json"));
        assert_eq!(p.str("x"), Some("1=2"));
        assert_eq!(parse(&a(&["--title"])).unwrap_err(), "--title needs a value");
        assert!(!parse(&a(&["--json="])).unwrap().on("json"));
    }

    #[test]
    fn numbers_like_js() {
        assert_eq!(js_number(" 2.7 "), 2.7);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e2"), 100.0);
        assert!(js_number("inf").is_nan());
        assert!(js_number("abc").is_nan());
        assert_eq!(js_number("-1"), -1.0);
    }
}
