//! Numbers written the way `JSON.stringify` writes them, so Rust's answers are byte-for-byte Bun's: `42` not `42.0`,
//! `0.0000015` not `1.5e-6`, `1e+21` for big ones. serde_json's `arbitrary_precision` keeps the text we give it.

use serde_json::{Map, Number, Value};

/// `String(x)` for a finite number (Number::prototype.toString, radix 10).
pub fn js_string(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if !x.is_finite() {
        return if x.is_nan() { "NaN".into() } else if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    // Rust's `{:e}` gives the shortest digits that read back to the same number, like JS: "d.ddde-N".
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').expect("exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("exponent number") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// A JSON number as `JSON.stringify` writes it; NaN and ±Infinity become null, as in JS.
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    Value::Number(js_string(x).parse::<Number>().expect("valid JSON number"))
}

/// Rewrites every number in a value read from a file the way JS would after `JSON.parse` (e.g. `42.50` → `42.5`).
pub fn normalize(v: Value) -> Value {
    match v {
        Value::Number(n) => n.as_f64().map(num).unwrap_or(Value::Number(n)),
        Value::Array(a) => Value::Array(a.into_iter().map(normalize).collect()),
        Value::Object(m) => Value::Object(normalize_map(m)),
        other => other,
    }
}

pub fn normalize_map(m: Map<String, Value>) -> Map<String, Value> {
    m.into_iter().map(|(k, v)| (k, normalize(v))).collect()
}

/// A JSON value as a finite f64 (`typeof v === "number" && Number.isFinite(v)`).
pub fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// JS truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_numbers_like_json_stringify() {
        let cases: &[(f64, &str)] = &[
            (42.0, "42"),
            (17.5, "17.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (0.0000015, "0.0000015"),
            (0.0000001, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (-3.25, "-3.25"),
            (-0.0, "0"),
            (1794736800000.0, "1794736800000"),
        ];
        for (x, want) in cases {
            assert_eq!(serde_json::to_string(&num(*x)).unwrap(), *want, "{x}");
        }
        assert_eq!(num(f64::NAN), Value::Null);
    }

    #[test]
    fn normalizes_file_numbers() {
        let v: Value = serde_json::from_str(r#"{"a":42.50,"b":[1.0,2e2]}"#).unwrap();
        assert_eq!(serde_json::to_string(&normalize(v)).unwrap(), r#"{"a":42.5,"b":[1,200]}"#);
    }
}
