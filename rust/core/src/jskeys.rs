//! JavaScript's own key order for objects: keys that are array indexes ("0", "1", "42", not "01" or "-1") come
//! first in number order, then every other key in insertion order. `JSON.parse`, `YAML.parse` and every object Bun
//! builds follow it, so a file Bun writes always has it. Rust maps keep plain insertion order; these helpers put a
//! value in JS order after reading and before writing, so both sides give the same bytes.

use serde_json::{Map, Value};

/// An array index as JS sees it: a canonical decimal integer below 2^32 - 1.
pub fn is_index(k: &str) -> bool {
    !k.is_empty() && k.len() <= 10 && k.bytes().all(|b| b.is_ascii_digit()) && (k == "0" || !k.starts_with('0')) && k.parse::<u64>().is_ok_and(|n| n < u32::MAX as u64)
}

fn map_in_order(m: &Map<String, Value>) -> bool {
    let mut seen_other = false;
    let mut last: Option<u64> = None;
    for k in m.keys() {
        if is_index(k) {
            let n: u64 = k.parse().unwrap_or(0);
            if seen_other || last.is_some_and(|l| l > n) {
                return false;
            }
            last = Some(n);
        } else {
            seen_other = true;
        }
    }
    true
}

/// Whether every object in the value already has JS key order (no copy needed).
pub fn in_order(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.iter().all(in_order),
        Value::Object(m) => map_in_order(m) && m.values().all(in_order),
        _ => true,
    }
}

/// The value with every object in JS key order.
pub fn order(v: Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.into_iter().map(order).collect()),
        Value::Object(m) => Value::Object(order_map(m)),
        other => other,
    }
}

pub fn order_map(m: Map<String, Value>) -> Map<String, Value> {
    let ordered = map_in_order(&m);
    let m: Map<String, Value> = m.into_iter().map(|(k, v)| (k, order(v))).collect();
    if ordered {
        return m;
    }
    let mut idx: Vec<(u64, String, Value)> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in m {
        if is_index(&k) {
            idx.push((k.parse().unwrap_or(0), k, v));
        } else {
            rest.push((k, v));
        }
    }
    idx.sort_by_key(|(n, _, _)| *n);
    idx.into_iter().map(|(_, k, v)| (k, v)).chain(rest).collect()
}

/// A borrowed value in JS order: as is when it already is, else an ordered copy.
pub fn ordered(v: &Value) -> std::borrow::Cow<'_, Value> {
    if in_order(v) { std::borrow::Cow::Borrowed(v) } else { std::borrow::Cow::Owned(order(v.clone())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_keys_first_in_number_order() {
        let v: Value = serde_json::from_str(r#"{"b":1,"10":2,"a":{"2":0,"1":0},"01":3,"1":4,"4294967295":5,"-1":6}"#).unwrap();
        assert!(!in_order(&v));
        let o = order(v);
        assert_eq!(serde_json::to_string(&o).unwrap(), r#"{"1":4,"10":2,"b":1,"a":{"1":0,"2":0},"01":3,"4294967295":5,"-1":6}"#);
        assert!(in_order(&o));
    }
}
