//! `src/schedules/cron.ts`: standard 5-field cron (`min hour dom month dow`) in this Mac's local time; parsing with
//! Bun's error messages, the next fire times (JS `Date` setter arithmetic, so DST gaps and overlaps land where Bun's
//! do) and the plain-English summary. Brought in by R13 for `GET /api/cron/preview`; R10 builds the scheduler on it.
//! Checked against Bun on `tests/fixtures/gate.json` (group `cron`).

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

/// A parsed expression; sets of allowed values per field.
#[derive(Debug, Clone, PartialEq)]
pub struct Cron {
    pub minute: BTreeSet<i64>,
    pub hour: BTreeSet<i64>,
    pub dom: BTreeSet<i64>,
    pub month: BTreeSet<i64>,
    pub dow: BTreeSet<i64>,
    /// The field was `*` (or `*/n`): matters for the day-of-month / day-of-week OR rule.
    pub dom_any: bool,
    pub dow_any: bool,
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

fn macro_of(s: &str) -> Option<&'static str> {
    Some(match s {
        "@hourly" => "0 * * * *",
        "@daily" | "@midnight" => "0 0 * * *",
        "@weekly" => "0 0 * * 0",
        "@monthly" => "0 0 1 * *",
        "@yearly" | "@annually" => "0 0 1 1 *",
        _ => return None,
    })
}

struct Field {
    name: &'static str,
    min: i64,
    max: i64,
    names: &'static [&'static str],
    names_from: i64,
}

const FIELDS: [Field; 5] = [
    Field { name: "minute", min: 0, max: 59, names: &[], names_from: 0 },
    Field { name: "hour", min: 0, max: 23, names: &[], names_from: 0 },
    Field { name: "day of month", min: 1, max: 31, names: &[], names_from: 0 },
    Field { name: "month", min: 1, max: 12, names: &MONTHS, names_from: 1 },
    // 7 is accepted as Sunday too.
    Field { name: "day of week", min: 0, max: 7, names: &DAYS, names_from: 0 },
];

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
}

/// `Number(s)` of a digit string (big ones become huge, as in JS; never in range).
fn num_of(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::INFINITY)
}

/// JS `String(n)` of a whole number read from digits.
fn n_text(n: f64) -> String {
    crate::runs::js::to_string(&serde_json::Value::from(n))
}

fn parse_field(raw: &str, f: &Field) -> Result<(BTreeSet<i64>, bool), String> {
    let num = |s: &str| -> Result<i64, String> {
        let lower = s.to_lowercase();
        if let Some(i) = f.names.iter().position(|n| *n == lower) {
            return Ok(i as i64 + f.names_from);
        }
        if !digits(s) {
            return Err(format!("invalid {} value \"{s}\"", f.name));
        }
        let n = num_of(s);
        if n < f.min as f64 || n > f.max as f64 {
            return Err(format!("{} {} is out of range ({}-{})", f.name, n_text(n), f.min, f.max));
        }
        Ok(n as i64)
    };
    let mut values = BTreeSet::new();
    let mut any = false;
    for part in raw.split(',') {
        let mut it = part.split('/');
        let range = it.next().unwrap_or("");
        let step_raw = it.next();
        if it.next().is_some() || range.is_empty() {
            return Err(format!("invalid {} \"{part}\"", f.name));
        }
        let mut step = 1i64;
        if let Some(s) = step_raw {
            if !digits(s) || num_of(s) == 0.0 {
                return Err(format!("invalid {} step \"{s}\"", f.name));
            }
            // A step past every field's range just gives the first value.
            step = num_of(s).min(1000.0) as i64;
        }
        let (lo, hi);
        if range == "*" {
            (lo, hi) = (f.min, f.max);
            if raw == part {
                any = true;
            }
        } else if range.contains('-') {
            let mut r = range.split('-');
            let (a, b) = (r.next().unwrap_or(""), r.next().unwrap_or(""));
            if r.next().is_some() {
                return Err(format!("invalid {} range \"{range}\"", f.name));
            }
            (lo, hi) = (num(a)?, num(b)?);
            if lo > hi {
                return Err(format!("{} range \"{range}\" goes backwards", f.name));
            }
        } else {
            lo = num(range)?;
            // `5/15` means 5, 20, 35, 50 (from 5 to the end).
            hi = if step_raw.is_some() { f.max } else { lo };
        }
        let mut n = lo;
        while n <= hi {
            values.insert(n);
            n += step;
        }
    }
    Ok((values, any))
}

/// JS `\s+` split of a trimmed string, empty pieces dropped.
fn fields(s: &str) -> Vec<&str> {
    s.split(crate::runs::js::is_ws).filter(|p| !p.is_empty()).collect()
}

/// `parseCron`: the expression, or Bun's error message.
pub fn parse(expr: &str) -> Result<Cron, String> {
    let key = crate::runs::js::trim(expr).to_lowercase();
    let src = macro_of(&key).unwrap_or(expr);
    let parts = fields(crate::runs::js::trim(src));
    if parts.len() != 5 {
        return Err(format!("expected 5 fields (minute hour day-of-month month day-of-week), got {}", parts.len()));
    }
    let mut out = Vec::with_capacity(5);
    for (p, f) in parts.iter().zip(FIELDS.iter()) {
        out.push(parse_field(p, f)?);
    }
    let mut it = out.into_iter();
    let (minute, hour, dom, month, mut dow) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
    if dow.0.remove(&7) {
        dow.0.insert(0);
    }
    let c = Cron { minute: minute.0, hour: hour.0, dom: dom.0, month: month.0, dow: dow.0, dom_any: dom.1, dow_any: dow.1 };
    if next_run(&c, ckanban_core::time::now_ms()).is_none() {
        return Err("this schedule never fires".into());
    }
    Ok(c)
}

/// `cronError`: the message, or None when the expression is fine.
pub fn error(expr: &str) -> Option<String> {
    parse(expr).err()
}

/// A local date and time as JS `Date` keeps it while its setters run: fields that may overflow.
#[derive(Clone, Copy)]
struct Parts {
    y: i64,
    mon: i64,
    d: i64,
    h: i64,
    mi: i64,
}

unsafe extern "C" {
    fn tzset();
}

/// `localtime_r`: the local fields and the offset from UTC (seconds) at an instant.
fn local_at(ms: f64) -> (Parts, i64, i64) {
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes into the tm we own; tzset reads TZ again (as JS does).
    let tm = unsafe {
        tzset();
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&secs, &mut tm);
        tm
    };
    let p = Parts { y: tm.tm_year as i64 + 1900, mon: tm.tm_mon as i64, d: tm.tm_mday as i64, h: tm.tm_hour as i64, mi: tm.tm_min as i64 };
    (p, tm.tm_gmtoff as i64, tm.tm_wday as i64)
}

fn parts_of(ms: f64) -> Parts {
    local_at(ms).0
}

/// Days from 1970-01-01 to a proleptic Gregorian date (month 1-12).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// JS `MakeDate(MakeDay(y, mon, d), MakeTime(h, mi, 0, 0))` in local time, then `UTC()`: overflowing fields carry, a
/// time in a DST gap moves forward (the offset before the change), a repeated time takes its first occurrence.
fn ms_of(p: Parts) -> f64 {
    let y = p.y + p.mon.div_euclid(12);
    let m = p.mon.rem_euclid(12) + 1;
    // The local time as if it were UTC, in ms.
    let naive = ((days_from_civil(y, m, 1) + p.d - 1) * 86_400 + p.h * 3600 + p.mi * 60) as f64 * 1000.0;
    let before = local_at(naive - 12.0 * 3600_000.0).1;
    let after = local_at(naive + 12.0 * 3600_000.0).1;
    let fits = |off: i64| {
        let t = naive - off as f64 * 1000.0;
        (local_at(t).1 == off).then_some(t)
    };
    let mut hits: Vec<f64> = [before, after].into_iter().filter_map(fits).collect();
    hits.sort_by(|a, b| a.total_cmp(b));
    hits.first().copied().unwrap_or(naive - before as f64 * 1000.0)
}

fn day_matches(c: &Cron, ms: f64) -> bool {
    let (p, _, wday) = local_at(ms);
    let dom = c.dom.contains(&p.d);
    let dow = c.dow.contains(&wday);
    // Classic cron: when both day fields are restricted, either one matching is enough.
    if !c.dom_any && !c.dow_any { dom || dow } else { dom && dow }
}

/// `nextRun`: the first fire time strictly after `after` (to the minute), in epoch ms, or None within ~5 years.
pub fn next_run(c: &Cron, after: f64) -> Option<f64> {
    // d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1)
    let mut p = parts_of(after);
    p.mi += 1;
    let mut t = ms_of(p);
    let limit = after + 5.0 * 366.0 * 86_400_000.0;
    while t <= limit {
        let p = parts_of(t);
        if !c.month.contains(&(p.mon + 1)) {
            t = ms_of(Parts { mon: p.mon + 1, d: 1, ..p });
            // setMonth(m + 1, 1) then setHours(0, 0, 0, 0): two steps, the second on the result of the first.
            t = ms_of(Parts { h: 0, mi: 0, ..parts_of(t) });
            continue;
        }
        if !day_matches(c, t) {
            t = ms_of(Parts { d: p.d + 1, ..p });
            t = ms_of(Parts { h: 0, mi: 0, ..parts_of(t) });
            continue;
        }
        if !c.hour.contains(&p.h) {
            t = ms_of(Parts { h: p.h + 1, mi: 0, ..p });
            continue;
        }
        if !c.minute.contains(&p.mi) {
            t = ms_of(Parts { mi: p.mi + 1, ..p });
            continue;
        }
        return Some(t);
    }
    None
}

/// `nextRuns`: the next `n` fire times after `after`.
pub fn next_runs(c: &Cron, after: f64, n: usize) -> Vec<f64> {
    let mut out = Vec::new();
    let mut cur = after;
    while out.len() < n {
        match next_run(c, cur) {
            Some(t) => {
                out.push(t);
                cur = t;
            }
            None => break,
        }
    }
    out
}

fn pad(s: &str) -> String {
    let n = n_text(num_of(s));
    if n.len() < 2 { format!("0{n}") } else { n }
}

static DAYS_LIST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-7](,[0-7])*$").unwrap());

/// `describeCron`: a plain-English summary for the common shapes, else `Cron: <expression>`.
pub fn describe(expr: &str) -> String {
    let trimmed = crate::runs::js::trim(expr);
    let src = macro_of(&trimmed.to_lowercase()).unwrap_or(trimmed).to_string();
    // `src.split(/\s+/)` of a trimmed string: runs of whitespace are one separator; "" gives [""]. Missing fields
    // are undefined (never equal to anything here).
    let f: Vec<&str> = if src.is_empty() { vec![""] } else { fields(&src) };
    let get = |k: usize| f.get(k).copied();
    let (m, h, dom, mon, dow) = (get(0).unwrap_or(""), get(1), get(2), get(3), get(4));
    let is = |v: Option<&str>, s: &str| v == Some(s);
    let step = |s: Option<&str>| s.and_then(|s| s.strip_prefix("*/")).filter(|d| digits(d)).map(str::to_string);
    let at = if digits(m) && h.is_some_and(digits) { Some(format!("{}:{}", pad(h.unwrap()), pad(m))) } else { None };
    let days = |s: &str| -> Option<String> {
        if s == "1-5" {
            return Some("Weekdays".into());
        }
        if s == "0,6" || s == "6,0" {
            return Some("Weekends".into());
        }
        if !DAYS_LIST.is_match(s) {
            return None;
        }
        Some(format!("Every {}", s.split(',').map(|d| DAY_NAMES[(d.parse::<usize>().unwrap_or(0)) % 7]).collect::<Vec<_>>().join(", ")))
    };
    let rest_any = is(dom, "*") && is(mon, "*") && is(dow, "*");
    if src == "* * * * *" {
        return "Every minute".into();
    }
    if let Some(s) = step(Some(m))
        && is(h, "*")
        && rest_any
    {
        return if s == "1" { "Every minute".into() } else { format!("Every {s} minutes") };
    }
    if digits(m) && is(h, "*") && rest_any {
        return if m == "0" { "Every hour".into() } else { format!("Every hour at :{}", pad(m)) };
    }
    if digits(m)
        && let Some(s) = step(h)
        && rest_any
    {
        return format!("Every {s} hours at :{}", pad(m));
    }
    if let Some(at) = &at
        && is(dom, "*")
        && is(mon, "*")
    {
        if is(dow, "*") {
            return format!("Every day at {at}");
        }
        if let Some(d) = dow.and_then(days) {
            return format!("{d} at {at}");
        }
    }
    if let Some(at) = &at
        && dom.is_some_and(digits)
        && is(mon, "*")
        && is(dow, "*")
    {
        return format!("Monthly on day {} at {at}", dom.unwrap());
    }
    format!("Cron: {src}")
}

/// `GET /api/cron/preview?expr=...`: whether the expression is valid, its summary and its next three fire times.
pub fn preview(expr_param: Option<&str>) -> serde_json::Value {
    use serde_json::json;
    let expr = crate::runs::js::trim(expr_param.unwrap_or("")).to_string();
    let error = if expr.is_empty() { Some("cron expression is required".to_string()) } else { error(&expr) };
    if let Some(e) = error {
        return json!({ "valid": false, "error": e, "summary": null, "next": [] });
    }
    let next: Vec<String> = match parse(&expr) {
        Ok(c) => next_runs(&c, ckanban_core::time::now_ms(), 3).into_iter().map(ckanban_core::time::iso).collect(),
        Err(_) => Vec::new(),
    };
    json!({ "valid": true, "error": null, "summary": describe(&expr), "next": next })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_describes() {
        assert!(parse("*/15 * * * *").is_ok());
        assert_eq!(error("* * *").unwrap(), "expected 5 fields (minute hour day-of-month month day-of-week), got 3");
        assert_eq!(error("61 * * * *").unwrap(), "minute 61 is out of range (0-59)");
        assert_eq!(error("0 0 31 2 *").unwrap(), "this schedule never fires");
        assert_eq!(describe("0 9 * * 1-5"), "Weekdays at 09:00");
        assert_eq!(describe("@daily"), "Every day at 00:00");
        assert_eq!(describe("5 */2 * * *"), "Every 2 hours at :05");
        assert_eq!(describe("0 9 1 * *"), "Monthly on day 1 at 09:00");
        assert_eq!(describe("0 9 * * 1,3"), "Every Monday, Wednesday at 09:00");
    }
}
