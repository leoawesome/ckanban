//! Follow-ups, the pure part (`src/schedules/followup.ts`), and the local date parsing and printing they share with
//! one-time jobs (`parseAt`, `formatAt` of `src/schedules/jobs.ts`). Times are epoch ms; local time is this
//! process's `TZ`, as Bun's.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

use super::limit::{clip, local_fields, local_ms, naive_ms};
use crate::runs::js;

/// A follow-up sooner than this is refused as a probable mistake.
pub const FOLLOW_UP_MIN_MS: f64 = 60_000.0;
/// Seen later than this past its time: not woken, the user decides (`FollowUp.missedAt`).
pub const FOLLOW_UP_LATE_MS: f64 = 12.0 * 3_600_000.0;
/// Longest follow-up note and stop reason (UTF-16 units, as JS `.length`).
pub const FOLLOW_UP_NOTE_MAX: usize = 1000;
pub const FOLLOW_UP_REASON_MAX: usize = 300;
/// Furthest ahead a follow-up may be.
pub const FOLLOW_UP_MAX_MS: f64 = 366.0 * 24.0 * 3_600_000.0;
/// Entries kept in `Ticket.followUpLog`.
pub const FOLLOW_UP_LOG_KEEP: usize = 50;

const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `parseDelay`: "30m", "4h", "2d", "1d 6h", "90 minutes" as ms; None when it isn't a delay.
pub fn parse_delay(v: &str) -> Option<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^([0-9]+(?:\.[0-9]+)?)\s*(minutes?|mins|min|m|hours?|hrs|hr|h|days?|d|weeks?|w)\s*(?:,|and)?\s*").expect("delay regex")
    });
    let s = js::trim(v).to_lowercase();
    if s.is_empty() {
        return None;
    }
    let mut total = 0.0;
    let mut rest = s.as_str();
    while !rest.is_empty() {
        let m = re.captures(rest)?;
        let unit = match &m[2][..1] {
            "m" => 60_000.0,
            "h" => 3_600_000.0,
            "d" => 86_400_000.0,
            _ => 7.0 * 86_400_000.0,
        };
        total += js::number_of_str(&m[1]) * unit;
        rest = &rest[m[0].len()..];
    }
    (total > 0.0).then_some(total)
}

/// JavaScriptCore's reading of an ISO date with a zone (`new Date(s)` for `2026-10-20T10:00+02:00`), NaN when it
/// refuses it: days 1-31 (a day past the month's end carries), hour 24 only as 24:00, offsets up to 23:59.
fn iso_with_zone(s: &str) -> f64 {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|([+-])([0-9]{2}):?([0-9]{2}))$").expect("iso regex")
    });
    let Some(c) = re.captures(s) else { return f64::NAN };
    let n = |i: usize| c.get(i).map(|x| x.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let (y, mo, d, h, mi, sec) = (n(1), n(2), n(3), n(4), n(5), n(6));
    let ms = c.get(7).map(|x| format!("{:0<3}", &x.as_str()[..x.as_str().len().min(3)]).parse::<i64>().unwrap_or(0)).unwrap_or(0);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi > 0 || sec > 0 || ms > 0)) {
        return f64::NAN;
    }
    let off = if &c[8] == "Z" {
        0
    } else {
        let (oh, om) = (n(10), n(11));
        if oh > 23 || om > 59 {
            return f64::NAN;
        }
        (if &c[9] == "-" { -1 } else { 1 }) * (oh * 60 + om)
    };
    // A four-digit year is read as it is (no 1900 for 0050), unlike the Date constructor.
    clip(naive_ms(y, mo - 1, d, h, mi, sec, ms) - off as f64 * 60_000.0)
}

/// `parseAt`: "2026-10-20 22:00" (this computer's local time, seconds optional) or an ISO time with a zone; Err is
/// Bun's message (a `JobError`, status 400). `v` is the value as given (its JSON text goes in the message).
pub fn parse_at(v: &Value) -> Result<f64, String> {
    static LOCAL: OnceLock<Regex> = OnceLock::new();
    static ZONED: OnceLock<Regex> = OnceLock::new();
    let local = LOCAL.get_or_init(|| Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?$").expect("local regex"));
    let zoned = ZONED.get_or_init(|| {
        Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})$").expect("zoned regex")
    });
    let s = match v {
        Value::String(s) => js::trim(s),
        _ => "",
    };
    let mut d = f64::NAN;
    if let Some(c) = local.captures(s) {
        let n = |i: usize| c.get(i).map(|x| x.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
        let (y, mo, day, h, mi, sec) = (n(1), n(2), n(3), n(4), n(5), n(6));
        let t = local_ms(y, mo - 1, day, h, mi, sec, 0);
        // Rejects 2026-02-31 and 25:00 instead of rolling over.
        if t.is_finite() {
            let f = local_fields(t);
            if f.y == y && f.mon == mo - 1 && f.d == day && f.h == h && f.mi == mi {
                d = t;
            }
        }
    } else if zoned.is_match(s) {
        d = iso_with_zone(s);
    }
    if d.is_nan() {
        let shown = if v.is_null() { "\"\"".to_string() } else { js::stringify(v) };
        return Err(format!("at must be a date and time like \"2026-10-20 22:00\" (this computer's local time), got {shown}"));
    }
    Ok(d)
}

/// `formatAt`: "Tue 20 Oct 22:00", in this computer's local time.
pub fn format_at(iso: &str) -> String {
    let t = iso_ms(iso);
    if t.is_nan() {
        return "undefined NaN undefined NaN:NaN".into();
    }
    let f = local_fields(t);
    format!("{} {} {} {:02}:{:02}", DAYS[f.wday as usize], f.d, MONTHS[f.mon as usize], f.h, f.mi)
}

/// `new Date(iso).getTime()` for the ISO times the board writes (`toISOString`, or a time with a zone).
pub fn iso_ms(iso: &str) -> f64 {
    let t = iso_with_zone(iso);
    if !t.is_nan() {
        return t;
    }
    // `toISOString` of years past 9999 or before 0 (+/-YYYYYY).
    chrono::DateTime::parse_from_rfc3339(iso).map(|d| d.timestamp_millis() as f64).unwrap_or(f64::NAN)
}

/// `followUpTime`: when a follow_up call wants Claude back, after a delay ("4h") or at a time ("2026-10-20 09:00",
/// local). Err is Bun's message (a `FollowUpError`, status 400).
pub fn follow_up_time(after: Option<&str>, at: Option<&str>, now: f64) -> Result<f64, String> {
    let after = after.map(js::trim).filter(|s| !s.is_empty());
    let at = at.map(js::trim).filter(|s| !s.is_empty());
    if after.is_some() == at.is_some() {
        return Err("give either after (e.g. \"4h\", \"2d\") or at (e.g. \"2026-10-20 09:00\"), not both".into());
    }
    let due = match (after, at) {
        (Some(after), _) => match parse_delay(after) {
            Some(ms) => clip(now + ms),
            None => return Err(format!("after must be a delay like \"30m\", \"4h\" or \"2d\", got {}", js::stringify(&Value::String(after.to_string())))),
        },
        (None, Some(at)) => parse_at(&Value::String(at.to_string()))?,
        (None, None) => unreachable!("checked above"),
    };
    if !due.is_finite() {
        return Err("that time is out of range".into());
    }
    if due - now < FOLLOW_UP_MIN_MS {
        return Err("a follow-up must be at least 1 minute away".into());
    }
    if due - now > FOLLOW_UP_MAX_MS {
        return Err("a follow-up can be at most a year away".into());
    }
    Ok(due)
}

/// `logFollowUp`: the log with one more entry, trimmed to the last `FOLLOW_UP_LOG_KEEP`.
pub fn log_follow_up(log: &[Value], e: Value) -> Vec<Value> {
    let mut out: Vec<Value> = log.to_vec();
    out.push(e);
    let cut = out.len().saturating_sub(FOLLOW_UP_LOG_KEEP);
    out.split_off(cut)
}

/// `followUpSpend`: follow-up wakes so far and what they cost (the ones whose run has ended).
pub fn follow_up_spend(log: &[Value]) -> (usize, f64) {
    let woke: Vec<&Value> = log.iter().filter(|e| e.get("kind").and_then(Value::as_str) == Some("woke")).collect();
    let cost = woke.iter().fold(0.0, |n, e| n + e.get("costUsd").map(|c| js::number(Some(c))).unwrap_or(0.0));
    (woke.len(), cost)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays() {
        assert_eq!(parse_delay("30m"), Some(1_800_000.0));
        assert_eq!(parse_delay("1d 6h"), Some(30.0 * 3_600_000.0));
        assert_eq!(parse_delay("5ms"), None);
        assert_eq!(parse_delay(""), None);
    }

    #[test]
    fn iso_times_like_jsc() {
        assert_eq!(iso_with_zone("2026-10-20T10:00+0530"), 1792470600000.0);
        assert_eq!(iso_with_zone("2026-02-31T10:00Z"), 1772532000000.0);
        assert_eq!(iso_with_zone("0000-01-01T00:00Z"), -62167219200000.0);
        assert!(iso_with_zone("2026-10-20T24:30Z").is_nan());
        assert_eq!(iso_with_zone("2026-10-20T10:00:00.9999Z"), 1792490400999.0);
    }

    #[test]
    fn log_keeps_the_last_ones() {
        let log: Vec<Value> = (0..60).map(Value::from).collect();
        let out = log_follow_up(&log, Value::from(60));
        assert_eq!(out.len(), FOLLOW_UP_LOG_KEEP);
        assert_eq!(out[0], Value::from(11));
    }
}
