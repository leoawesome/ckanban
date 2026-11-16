//! JavaScript value behaviour the team code depends on: `undefined` (a missing key) apart from `null`, truthiness,
//! `typeof v === "object"`, `Number.isInteger` and `String(v)`, over `serde_json` values in Bun's key order.

use serde_json::{Map, Value};

use crate::prompts::js;

/// A JSON object in insertion order (`preserve_order`), as Bun builds and writes it.
pub type Obj = Map<String, Value>;

/// `typeof v === "object" && v`: the object's fields; an array counts but has no named fields here.
pub fn obj_like(v: Option<&Value>) -> Option<Obj> {
    match v {
        Some(Value::Object(m)) => Some(m.clone()),
        Some(Value::Array(_)) => Some(Obj::new()),
        _ => None,
    }
}

/// `v?.[k]` on any value: only objects have fields.
pub fn field<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(m)) => m.get(k),
        _ => None,
    }
}

/// `v === undefined || v === null`.
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `a ?? b` over values.
pub fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if nullish(a) { b } else { a }
}

/// JS truthiness.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The value when it is a string.
pub fn str_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `typeof v === "string" && !!v.trim()`.
pub fn is_text(v: Option<&Value>) -> bool {
    str_of(v).is_some_and(|s| !js::trim(s).is_empty())
}

/// The number when it is one.
pub fn num_of(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// `Number.isInteger(v)`.
pub fn is_integer(v: Option<&Value>) -> bool {
    num_of(v).is_some_and(|x| x.is_finite() && x.fract() == 0.0)
}

/// `v === true`.
pub fn is_true(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Bool(true)))
}

/// `String(v)` as a template literal writes it (`undefined` for a missing value).
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js::num(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `s.length > max ? s.slice(0, max) + "…" : s` in UTF-16 units.
pub fn clip(s: &str, max: usize) -> String {
    if js::len16(s) > max { format!("{}…", js::slice16(s, max)) } else { s.to_string() }
}

/// A JS number value (`jsnum` form: whole numbers without a fraction).
pub fn number(x: f64) -> Value {
    ckanban_core::jsnum::num(x)
}
