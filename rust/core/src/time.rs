//! Times the way the Bun code handles them: epoch milliseconds as f64 (`Date.now()`), `toISOString()`,
//! the parts of `Date.parse` the data files use, and local day keys (`dayKey` in `src/usage/limit.ts`).

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()`.
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// A file time in epoch ms, like Node's `mtimeMs` (fractional).
pub fn system_ms(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64() * 1000.0,
        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
    }
}

/// `new Date(ms)` is valid: JS time values are whole ms within ±8.64e15.
fn clip(ms: f64) -> Option<i64> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    Some(ms.trunc() as i64)
}

fn utc(ms: f64) -> Option<DateTime<Utc>> {
    clip(ms).and_then(|m| Utc.timestamp_millis_opt(m).single())
}

/// `new Date(ms).toISOString()`: always milliseconds and `Z`. Years outside 0..=9999 use JS's extended form.
pub fn iso(ms: f64) -> String {
    let Some(d) = utc(ms) else { return String::new() };
    let y = d.year();
    let year = if (0..=9999).contains(&y) { format!("{y:04}") } else if y < 0 { format!("-{:06}", -y) } else { format!("+{y:06}") };
    format!("{year}{}", d.format("-%m-%dT%H:%M:%S%.3fZ"))
}

/// `Date.parse` for the forms that reach this code: ISO 8601 (with or without zone; date-only is UTC, a date-time
/// without a zone is local, as in JS) and HTTP dates (RFC 2822 / RFC 7231, for `retry-after`). None is NaN.
pub fn parse_date(s: &str) -> Option<f64> {
    let t = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return Some(d.timestamp_millis() as f64);
    }
    // JS also accepts a lowercase z and offsets without seconds, which rfc3339 covers; a space for T is not ISO.
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(t, f) {
            return Local.from_local_datetime(&n).earliest().map(|d| d.timestamp_millis() as f64);
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64);
    }
    if let Ok(d) = DateTime::parse_from_rfc2822(t) {
        return Some(d.timestamp_millis() as f64);
    }
    // RFC 7231's "Sun, 06 Nov 1994 08:49:37 GMT" is RFC 2822 with GMT, which chrono reads above.
    None
}

/// `new Date(v).getTime()` for a JSON value (a line's `at`): numbers are ms, strings are parsed, null is 0.
pub fn value_ms(v: Option<&Value>) -> Option<f64> {
    let ms = match v? {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => parse_date(s)?,
        _ => return None,
    };
    clip(ms).map(|m| m as f64)
}

/// `dayKey(new Date(ms))`: the local day, YYYY-MM-DD.
pub fn day_key(ms: f64) -> String {
    match clip(ms).and_then(|m| Local.timestamp_millis_opt(m).single()) {
        Some(d) => format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day()),
        None => String::new(),
    }
}

/// Local midnight of the day holding `ms`, in epoch ms.
pub fn local_midnight(ms: f64) -> f64 {
    let Some(d) = clip(ms).and_then(|m| Local.timestamp_millis_opt(m).single()) else { return ms };
    let midnight = d.date_naive().and_hms_opt(0, 0, 0).expect("midnight exists");
    Local.from_local_datetime(&midnight).earliest().map(|x| x.timestamp_millis() as f64).unwrap_or(ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_763_200_000_123.9), "2025-11-15T09:46:40.123Z");
    }

    #[test]
    fn parses_iso_and_http_dates() {
        assert_eq!(parse_date("2026-11-15T10:00:00.000Z"), Some(1_794_736_800_000.0));
        assert_eq!(parse_date("2026-11-15T12:00:00+02:00"), Some(1_794_736_800_000.0));
        assert_eq!(parse_date("Sun, 15 Nov 2026 10:00:00 GMT"), Some(1_794_736_800_000.0));
        assert_eq!(parse_date("2026-11-15"), Some(1_794_700_800_000.0));
        assert_eq!(parse_date("soon"), None);
    }
}
