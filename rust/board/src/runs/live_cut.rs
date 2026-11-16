//! The live copy of a run's raw events (`src/runs/live-cut.ts`): the `activity` event every open tab gets carries no
//! long strings. The stored log keeps everything; the tool detail route serves a call's full output.

use serde_json::Value;

use super::js;
use crate::api::ActivityCut;

pub const LIVE_STRING_MAX: usize = 2000;

/// `liveJson`: JSON of `value` with every string longer than `max` UTF-16 units cut to its first `max` and a note of
/// how much was left out. `mask` hides saved keys in a string before it is cut, so a cut can't leave half a key.
pub fn live_json(value: &Value, mask: &dyn Fn(&str) -> String, max: usize) -> String {
    js::stringify_with(value, &mut |s, out| {
        if js::len16(s) <= max {
            return js::push_str(out, s);
        }
        let m = mask(s);
        let n = js::len16(&m);
        if n <= max {
            return js::push_str(out, &m);
        }
        let units: Vec<u16> = m.encode_utf16().collect();
        let mut head = &units[..max];
        // A cut through a surrogate pair: JS keeps the lone half, which JSON.stringify writes as an escape.
        let lone = head.last().copied().filter(|u| (0xD800..0xDC00).contains(u));
        if lone.is_some() {
            head = &head[..max - 1];
        }
        let text = String::from_utf16_lossy(head);
        let mut quoted = String::new();
        js::push_str(&mut quoted, &text);
        quoted.pop(); // the closing quote
        out.push_str(&quoted);
        if let Some(u) = lone {
            out.push_str(&format!("\\u{u:04x}"));
        }
        let mut rest = String::new();
        js::push_str(&mut rest, &format!("… ({} more characters, not sent live)", n - max));
        out.push_str(&rest[1..]);
    })
}

/// The run engine's `ActivityCut` for the event stream (fills R0's stand-in).
pub struct LiveCut;

impl ActivityCut for LiveCut {
    fn live_json(&self, event: &Value, mask: &dyn Fn(&str) -> String) -> String {
        live_json(event, mask, LIVE_STRING_MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cuts_long_strings_only() {
        let long = "a".repeat(10);
        let out = live_json(&json!({"k": long, "s": "short", "n": 1.5}), &|s| s.to_string(), 5);
        assert_eq!(out, r#"{"k":"aaaaa… (5 more characters, not sent live)","s":"short","n":1.5}"#);
        let emoji = format!("abc{}", "😀".repeat(3));
        let out = live_json(&json!(emoji), &|s| s.to_string(), 4);
        assert_eq!(out, "\"abc\\ud83d… (5 more characters, not sent live)\"");
    }
}
