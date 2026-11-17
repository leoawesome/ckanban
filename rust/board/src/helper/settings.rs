//! The helper's settings (`src/helper/settings.ts`): `<root>/helper.json` (its model, "My night", whether it may wake
//! the user at night, "What the helper knows about you") and the night rules every part of the helper uses.

use std::path::{Path, PathBuf};

use ckanban_core::datafile;
use serde_json::{Map, Value, json};

use super::local;
use crate::runs::js::{len16, squash_ws, trim};

pub const HELPER_MODELS: [&str; 2] = ["sonnet", "haiku"];
pub const FEEDBACK_MAX: usize = 300;
pub const FEEDBACK_LINES_MAX: usize = 100;
/// A digest held by the night goes this long after it ends (the helper's morning summary first).
pub const MORNING_GRACE_MS: f64 = 30.0 * 60_000.0;

/// "My night" in this Mac's time, HH:MM to HH:MM (may wrap past midnight).
#[derive(Clone, Debug, PartialEq)]
pub struct Night {
    pub start: String,
    pub end: String,
}

impl Default for Night {
    fn default() -> Self {
        Night { start: "22:00".into(), end: "07:00".into() }
    }
}

impl Night {
    pub fn to_json(&self) -> Value {
        json!({ "start": self.start, "end": self.end })
    }
}

#[derive(Clone, Debug)]
pub struct HelperSettings {
    pub model: String,
    pub night: Night,
    pub night_opt_in: Option<bool>,
    /// Feedback lines as read (each has id, text, at, source).
    pub feedback: Vec<Value>,
}

impl Default for HelperSettings {
    fn default() -> Self {
        HelperSettings { model: "sonnet".into(), night: Night::default(), night_opt_in: None, feedback: Vec::new() }
    }
}

impl HelperSettings {
    pub fn to_json(&self) -> Value {
        json!({ "model": self.model, "night": self.night.to_json(), "nightOptIn": self.night_opt_in, "feedback": self.feedback })
    }
    pub fn feedback_texts(&self) -> Vec<String> {
        self.feedback.iter().map(|f| f.get("text").and_then(Value::as_str).unwrap_or("").to_string()).collect()
    }
}

/// `nightAllowed`: only once the user said yes.
pub fn night_allowed(s: &HelperSettings) -> bool {
    s.night_opt_in == Some(true)
}

pub fn night_question(n: &Night) -> String {
    format!("Should urgent alerts wake you at night ({}-{})? I'd only do it when harm keeps growing, like customers billed twice.", n.start, n.end)
}

pub fn night_answer_text(allow: bool, n: &Night) -> String {
    if allow {
        format!("Done: urgent alerts may wake you at night ({}-{}). Change it any time in Settings.", n.start, n.end)
    } else {
        format!("Done: nothing wakes you at night ({}-{}); urgent things wait for the morning. Change it any time in Settings.", n.start, n.end)
    }
}

/// Minutes after midnight of "HH:MM" (`/^([01]?\d|2[0-3]):([0-5]\d)$/` after trim), or None.
pub fn hm(v: &str) -> Option<u32> {
    let t = trim(v);
    let (h, m) = t.split_once(':')?;
    let ok_h = matches!(h.len(), 1 | 2) && h.bytes().all(|b| b.is_ascii_digit());
    let ok_m = m.len() == 2 && m.bytes().all(|b| b.is_ascii_digit());
    if !ok_h || !ok_m {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    // `[01]?\d` takes 0-19, `2[0-3]` 20-23: two digits from "0" to "23".
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

fn hm_text(v: Option<&Value>, what: &str) -> Result<String, String> {
    let n = v.and_then(Value::as_str).and_then(hm).ok_or_else(|| format!("{what} must be a time like 22:00"))?;
    Ok(format!("{:02}:{:02}", n / 60, n % 60))
}

fn minute_of_day(ms: f64) -> u32 {
    let p = local::parts(ms);
    p.hour * 60 + p.minute
}

/// The time is inside "My night" (this Mac's time zone).
pub fn in_night(ms: f64, n: &Night) -> bool {
    if !ms.is_finite() {
        return false;
    }
    let s = hm(&n.start).unwrap_or(22 * 60);
    let e = hm(&n.end).unwrap_or(7 * 60);
    let m = minute_of_day(ms);
    if s == e {
        return false;
    }
    if s < e { m >= s && m < e } else { m >= s || m < e }
}

/// When the night that holds `ms` ends, or `ms` itself when it isn't night.
pub fn night_end(ms: f64, n: &Night) -> f64 {
    if !in_night(ms, n) {
        return ms;
    }
    let e = hm(&n.end).unwrap_or(7 * 60);
    let p = local::parts(ms);
    let end = local::make(p.year, p.month0 as i64, p.day as i64, e / 60, e % 60);
    if end > ms { end } else { local::make(p.year, p.month0 as i64, p.day as i64 + 1, e / 60, e % 60) }
}

pub fn morning_digest_at(ms: f64, n: &Night) -> f64 {
    if in_night(ms, n) { night_end(ms, n) + MORNING_GRACE_MS } else { ms }
}

/// `<root>/helper.json`.
pub struct HelperSettingsStore {
    pub file: PathBuf,
    now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl HelperSettingsStore {
    pub fn new(root: &Path, now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>) -> Self {
        HelperSettingsStore { file: root.join("helper.json"), now }
    }

    pub fn get(&self) -> HelperSettings {
        let mut out = HelperSettings::default();
        let text = match std::fs::read_to_string(&self.file) {
            Ok(t) => t,
            Err(_) => return out,
        };
        let Some(v) = datafile::parse_json(&text) else {
            eprintln!("helper: helper.json could not be read (not JSON); using defaults");
            return out;
        };
        if let Some(m) = v.get("model").and_then(Value::as_str).filter(|m| HELPER_MODELS.contains(m)) {
            out.model = m.to_string();
        }
        if let Some(n) = v.get("night").filter(|n| n.is_object() || n.is_array()) {
            let text_of = |k: &str| match n.get(k) {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(x) => crate::runs::js::to_string(x),
            };
            if hm(&text_of("start")).is_some() && hm(&text_of("end")).is_some() {
                // Kept as written (`{ start: v.night.start, end: v.night.end }`).
                out.night = Night { start: text_of("start"), end: text_of("end") };
            }
        }
        if let Some(b) = v.get("nightOptIn").and_then(Value::as_bool) {
            out.night_opt_in = Some(b);
        }
        if let Some(Value::Array(a)) = v.get("feedback") {
            out.feedback = a.iter().filter(|f| f.get("id").is_some_and(Value::is_string) && f.get("text").is_some_and(Value::is_string)).cloned().collect();
        }
        out
    }

    fn save(&self, s: &HelperSettings) -> Result<(), String> {
        datafile::write_json(&self.file, &s.to_json(), datafile::formats::HELPER).map_err(|e| format!("can't write helper.json: {e}"))
    }

    /// Changes model, night and nightOptIn; Err with a plain message on bad input.
    pub fn update(&self, raw: &Value) -> Result<HelperSettings, String> {
        let mut s = self.get();
        let Some(r) = raw.as_object() else { return Ok(s) };
        if let Some(m) = r.get("model") {
            match m.as_str().filter(|m| HELPER_MODELS.contains(m)) {
                Some(m) => s.model = m.to_string(),
                None => return Err(format!("model must be one of {}", HELPER_MODELS.join(", "))),
            }
        }
        if let Some(n) = r.get("night") {
            let start = hm_text(n.get("start"), "night start")?;
            let end = hm_text(n.get("end"), "night end")?;
            if start == end {
                return Err("night start and end must differ".into());
            }
            s.night = Night { start, end };
        }
        if let Some(o) = r.get("nightOptIn") {
            match o {
                Value::Bool(b) => s.night_opt_in = Some(*b),
                Value::Null => s.night_opt_in = None,
                _ => return Err("nightOptIn must be true or false".into()),
            }
        }
        self.save(&s)?;
        Ok(s)
    }

    pub fn add_feedback(&self, text: Option<&Value>, source: &str) -> Result<Value, String> {
        let t = match text {
            Some(Value::String(t)) => trim(&squash_ws(t)).to_string(),
            _ => String::new(),
        };
        if t.is_empty() {
            return Err("text is required".into());
        }
        if len16(&t) > FEEDBACK_MAX {
            return Err(format!("text is too long ({} characters, max {FEEDBACK_MAX})", len16(&t)));
        }
        let mut s = self.get();
        let now = (self.now)();
        let id = format!("f_{}{}", base36(now as u64), hex(2));
        let mut line = Map::new();
        line.insert("id".into(), id.into());
        line.insert("text".into(), t.into());
        line.insert("at".into(), ckanban_core::time::iso(now).into());
        line.insert("source".into(), source.into());
        let line = Value::Object(line);
        s.feedback.push(line.clone());
        let n = s.feedback.len();
        if n > FEEDBACK_LINES_MAX {
            s.feedback.drain(..n - FEEDBACK_LINES_MAX);
        }
        self.save(&s)?;
        Ok(line)
    }

    pub fn remove_feedback(&self, id: &str) -> bool {
        let mut s = self.get();
        let before = s.feedback.len();
        s.feedback.retain(|f| f.get("id").and_then(Value::as_str) != Some(id));
        if s.feedback.len() == before {
            return false;
        }
        self.save(&s).is_ok()
    }
}

/// `n.toString(36)`.
pub fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `randomBytes(n).toString("hex")`.
pub fn hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hm_reads_times() {
        assert_eq!(hm("7:00"), Some(420));
        assert_eq!(hm(" 22:30 "), Some(1350));
        assert_eq!(hm("24:00"), None);
        assert_eq!(hm("7:0"), None);
        assert_eq!(hm("007:00"), None);
    }
}
