//! `YAML.parse(text)` of the `yaml` npm package (v2, YAML 1.2 core schema) into a JSON value: how Bun reads a
//! ticket's front matter. The `yaml-rust2` parser gives the events; plain scalars are resolved here with the `yaml`
//! package's own core-schema rules, so `2026-11-15T08:00:00.000Z`, `yes` and `1_000` stay strings, `0o17` and `0x1F`
//! are numbers, and keys keep their order.
//!
//! Differences from Bun, all on files Bun never writes: error messages are worded differently; `.nan` and `.inf`
//! read as null (JSON has no such numbers); a key that is itself a list or map gets a JSON text key.

use crate::jsnum::num;
use serde_json::{Map, Value};
use std::collections::HashMap;
use yaml_rust2::parser::{Event, MarkedEventReceiver, Parser, Tag};
use yaml_rust2::scanner::{Marker, TScalarStyle};

#[derive(Debug, Clone, PartialEq)]
pub struct YamlError(pub String);

impl std::fmt::Display for YamlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for YamlError {}

enum Frame {
    Seq(Vec<Value>, usize),
    Map(Map<String, Value>, Option<String>, usize),
}

#[derive(Default)]
struct Builder {
    stack: Vec<Frame>,
    anchors: HashMap<usize, Value>,
    root: Option<Value>,
    docs: usize,
    error: Option<String>,
}

impl Builder {
    fn put(&mut self, v: Value, anchor: usize) {
        if anchor != 0 {
            self.anchors.insert(anchor, v.clone());
        }
        match self.stack.last_mut() {
            None => self.root = Some(v),
            Some(Frame::Seq(items, _)) => items.push(v),
            Some(Frame::Map(m, pending, _)) => match pending.take() {
                None => {
                    let k = key_string(&v);
                    if m.contains_key(&k) && self.error.is_none() {
                        self.error = Some(format!("Map keys must be unique: {k}"));
                    }
                    *pending = Some(k);
                }
                Some(k) => {
                    m.insert(k, v);
                }
            },
        }
    }
}

/// `stringifyKey` in the yaml package: how a parsed key becomes a JS object key.
fn key_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

impl MarkedEventReceiver for Builder {
    fn on_event(&mut self, ev: Event, _mark: Marker) {
        match ev {
            Event::DocumentStart => self.docs += 1,
            Event::Scalar(text, style, anchor, tag) => {
                let v = resolve(&text, style, tag.as_ref());
                self.put(v, anchor);
            }
            Event::Alias(id) => {
                let v = self.anchors.get(&id).cloned().unwrap_or(Value::Null);
                self.put(v, 0);
            }
            Event::SequenceStart(anchor, _) => self.stack.push(Frame::Seq(Vec::new(), anchor)),
            Event::MappingStart(anchor, _) => self.stack.push(Frame::Map(Map::new(), None, anchor)),
            Event::SequenceEnd | Event::MappingEnd => {
                let (v, anchor) = match self.stack.pop() {
                    Some(Frame::Seq(items, a)) => (Value::Array(items), a),
                    Some(Frame::Map(m, _, a)) => (Value::Object(m), a),
                    None => return,
                };
                self.put(v, anchor);
            }
            _ => {}
        }
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}
fn strip_sign(s: &str) -> &str {
    s.strip_prefix(['-', '+']).unwrap_or(s)
}
fn decimal(s: &str, need_dot: bool) -> bool {
    match s.split_once('.') {
        Some(("", frac)) => digits(frac),
        Some((int, frac)) => digits(int) && (frac.is_empty() || digits(frac)),
        None => !need_dot && digits(s),
    }
}
fn float(s: &str) -> Value {
    s.parse::<f64>().map(num).unwrap_or(Value::Null)
}
fn radix(s: &str, r: u32) -> Value {
    let x = s.chars().fold(0f64, |acc, c| acc * r as f64 + c.to_digit(r).unwrap_or(0) as f64);
    num(x)
}

/// A plain scalar by the core schema's tags, in the yaml package's order.
pub fn resolve_plain(s: &str) -> Value {
    match s {
        "" | "~" | "null" | "Null" | "NULL" => return Value::Null,
        "true" | "True" | "TRUE" => return Value::Bool(true),
        "false" | "False" | "FALSE" => return Value::Bool(false),
        _ => {}
    }
    if let Some(r) = s.strip_prefix("0o").filter(|r| !r.is_empty() && r.bytes().all(|b| (b'0'..=b'7').contains(&b))) {
        return radix(r, 8);
    }
    if digits(strip_sign(s)) {
        return float(s);
    }
    if let Some(r) = s.strip_prefix("0x").filter(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_hexdigit())) {
        return radix(r, 16);
    }
    if matches!(strip_sign(s), ".inf" | ".Inf" | ".INF") || matches!(s, ".nan" | ".NaN" | ".NAN") {
        return Value::Null;
    }
    let body = strip_sign(s);
    if let Some(i) = body.find(['e', 'E']) {
        if decimal(&body[..i], false) && digits(strip_sign(&body[i + 1..])) {
            return float(s);
        }
    }
    if decimal(body, true) {
        return float(s);
    }
    Value::String(s.to_string())
}

fn resolve(text: &str, style: TScalarStyle, tag: Option<&Tag>) -> Value {
    if let Some(t) = tag {
        let core = t.handle == "!!" || t.handle == "tag:yaml.org,2002:";
        return match (core, t.suffix.as_str()) {
            (true, "null" | "bool" | "int" | "float") => resolve_plain(text),
            _ => Value::String(text.to_string()),
        };
    }
    if style == TScalarStyle::Plain { resolve_plain(text) } else { Value::String(text.to_string()) }
}

/// The document's value (null for an empty document); an error for invalid YAML, several documents or a repeated key.
pub fn parse(text: &str) -> Result<Value, YamlError> {
    let mut b = Builder::default();
    let mut p = Parser::new_from_str(text);
    p.load(&mut b, true).map_err(|e| YamlError(e.to_string()))?;
    if b.docs > 1 {
        return Err(YamlError("Source contains multiple documents".into()));
    }
    if let Some(e) = b.error {
        return Err(YamlError(e));
    }
    Ok(crate::jskeys::order(b.root.unwrap_or(Value::Null)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn core_schema_scalars() {
        let v = parse("a: 2026-11-15T08:00:00.000Z\nb: yes\nc: 1_000\nd: 0o17\ne: 0x1F\nf: -1.5\ng: ~\nh: \"12\"\ni: True\nj: 1e3\nk: .5\n").unwrap();
        assert_eq!(v, json!({"a": "2026-11-15T08:00:00.000Z", "b": "yes", "c": "1_000", "d": 15, "e": 31, "f": -1.5, "g": null, "h": "12", "i": true, "j": 1000, "k": 0.5}));
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
    }

    #[test]
    fn blocks_lists_and_errors() {
        assert_eq!(parse("m: |-\n  a\n  b\nt:\n  - x\n  - y: 1\n").unwrap(), json!({"m": "a\nb", "t": ["x", {"y": 1}]}));
        assert!(parse("a: 1\na: 2\n").is_err());
        assert!(parse("a: [1\n").is_err());
        assert_eq!(parse("").unwrap(), Value::Null);
    }
}
