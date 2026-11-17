//! Claude usage and spend limits (`src/usage/limit.ts`, the pure part): when a limit in a run's message resets, the
//! local day key of the daily auto-continue cap, and the clock text the card shows. `isLimitText`/`limitMessage` are
//! in `runs::retry`. Times are epoch ms (`f64`, as JS `Date.getTime()`); local time is this process's `TZ`, as Bun's.
//!
//! Also the JavaScript `Date` arithmetic the run loop's rules need (`local_fields`, `local_ms`, `utc_ms`), and named
//! time zones read from `/usr/share/zoneinfo` (`zone_offset`), standing in for `Intl.DateTimeFormat`.

use std::sync::OnceLock;

use regex::Regex;

/// Sent to the session once the limit has reset.
pub const CONTINUE_TEXT: &str = "continue";
/// How long after the reset time the automatic continue goes out.
pub const CONTINUE_DELAY_MS: f64 = 60_000.0;
/// Automatic continues per ticket per (local) day.
pub const AUTO_CONTINUE_PER_DAY: u32 = 3;

const HOUR_MS: f64 = 3_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
/// The largest time a JS `Date` holds (`TimeClip`).
pub const MAX_TIME: f64 = 8.64e15;

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_SHORT: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---- JS Date arithmetic ----

/// A local (or UTC) date and time as JS `Date` getters give it; `mon` is 0-11, `wday` 0 (Sunday) to 6.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fields {
    pub y: i64,
    pub mon: i64,
    pub d: i64,
    pub h: i64,
    pub mi: i64,
    pub s: i64,
    pub ms: i64,
    pub wday: i64,
}

unsafe extern "C" {
    fn tzset();
}

/// `localtime_r` at an instant: the local fields and the offset from UTC in seconds.
fn local_tm(ms: f64) -> (Fields, i64) {
    let secs = (ms / 1000.0).floor();
    let rest = (ms - secs * 1000.0) as i64;
    let t = secs as libc::time_t;
    // SAFETY: localtime_r writes into the tm we own; tzset reads TZ again (as JS does).
    let tm = unsafe {
        tzset();
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&t, &mut tm);
        tm
    };
    let f = Fields {
        y: tm.tm_year as i64 + 1900,
        mon: tm.tm_mon as i64,
        d: tm.tm_mday as i64,
        h: tm.tm_hour as i64,
        mi: tm.tm_min as i64,
        s: tm.tm_sec as i64,
        ms: rest,
        wday: tm.tm_wday as i64,
    };
    (f, tm.tm_gmtoff as i64)
}

/// The local fields at an instant (`getFullYear()`, `getMonth()`...).
pub fn local_fields(ms: f64) -> Fields {
    local_tm(ms).0
}

/// The UTC fields at an instant (`getUTCFullYear()`...).
pub fn utc_fields(ms: f64) -> Fields {
    let days = (ms / DAY_MS).floor();
    let in_day = ms - days * DAY_MS;
    let (y, m, d) = civil_from_days(days as i64);
    let t = in_day as i64;
    Fields { y, mon: m - 1, d, h: t / 3_600_000, mi: t / 60_000 % 60, s: t / 1000 % 60, ms: t % 1000, wday: (days as i64 + 4).rem_euclid(7) }
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

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `MakeDate(MakeDay(y, mon, d), MakeTime(h, mi, s, ms))` read as UTC: fields may overflow and carry.
pub(crate) fn naive_ms(y: i64, mon: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> f64 {
    let yy = y + mon.div_euclid(12);
    let m = mon.rem_euclid(12) + 1;
    ((days_from_civil(yy, m, 1) + d - 1) * 86_400 + h * 3600 + mi * 60 + s) as f64 * 1000.0 + ms as f64
}

/// `Date.UTC(y, mon, d, h, mi, s, ms)` (a year 0-99 is 1900-1999, as JS does; NaN outside `Date`'s range).
pub fn utc_ms(y: i64, mon: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> f64 {
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    clip(naive_ms(y, mon, d, h, mi, s, ms))
}

/// `new Date(y, mon, d, h, mi, s, ms).getTime()` in local time: fields carry, a time in a DST gap moves forward (the
/// offset before the change), a repeated time takes its first occurrence; a year 0-99 is 1900-1999.
pub fn local_ms(y: i64, mon: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> f64 {
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    clip(local_naive(naive_ms(y, mon, d, h, mi, s, ms)))
}

/// The instant whose local time reads `naive` (local time written as if it were UTC).
fn local_naive(naive: f64) -> f64 {
    let before = local_tm(naive - 12.0 * HOUR_MS).1;
    let after = local_tm(naive + 12.0 * HOUR_MS).1;
    let fits = |off: i64| {
        let t = naive - off as f64 * 1000.0;
        (local_tm(t).1 == off).then_some(t)
    };
    let mut hits: Vec<f64> = [before, after].into_iter().filter_map(fits).collect();
    hits.sort_by(|a, b| a.total_cmp(b));
    hits.first().copied().unwrap_or(naive - before as f64 * 1000.0)
}

/// `TimeClip`: NaN outside the range a `Date` holds.
pub fn clip(t: f64) -> f64 {
    if t.is_finite() && t.abs() <= MAX_TIME { t } else { f64::NAN }
}

/// The same local fields with some changed (a JS setter): `set(ms, |f| f.h += 1)`.
pub fn set_local(ms: f64, change: impl FnOnce(&mut Fields)) -> f64 {
    let mut f = local_fields(ms);
    change(&mut f);
    clip(local_naive(naive_ms(f.y, f.mon, f.d, f.h, f.mi, f.s, f.ms)))
}

// ---- Named time zones (`Intl.DateTimeFormat`'s `timeZone`) ----

/// A zone's offset from UTC in ms at an instant (`zoneOffset`), or None when the zone isn't known (Bun's `Intl`
/// throws then). IANA names are read from `/usr/share/zoneinfo` (case as the Mac's file system allows); `+08:00`,
/// `-0530` are fixed offsets, as JavaScriptCore takes them.
pub fn zone_offset(tz: &str, at: f64) -> Option<f64> {
    if let Some(off) = fixed_offset(tz) {
        return Some(off);
    }
    let zone = read_zone(tz)?;
    Some(zone.offset_at((at / 1000.0).floor() as i64) as f64 * 1000.0)
}

fn fixed_offset(tz: &str) -> Option<f64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^([+-])([0-9]{2}):?([0-9]{2})$").expect("offset regex"));
    let c = re.captures(tz)?;
    let (h, m): (i64, i64) = (c[2].parse().ok()?, c[3].parse().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let sign = if &c[1] == "-" { -1.0 } else { 1.0 };
    Some(sign * (h * 3600 + m * 60) as f64 * 1000.0)
}

/// A TZif file's transitions and offsets.
struct Zone {
    times: Vec<i64>,
    idx: Vec<u8>,
    offsets: Vec<i32>,
}

impl Zone {
    fn offset_at(&self, secs: i64) -> i32 {
        let first = self.offsets.first().copied().unwrap_or(0);
        match self.times.partition_point(|t| *t <= secs) {
            0 => first,
            n => self.offsets.get(self.idx[n - 1] as usize).copied().unwrap_or(first),
        }
    }
}

/// Names ICU doesn't know although the zone folder holds a file for them.
const NOT_ZONES: [&str; 10] = ["est5edt", "cst6cdt", "mst7mdt", "pst8pdt", "posixrules", "factory", "localtime", "+version", "leapseconds", "tzdata.zi"];

fn read_zone(tz: &str) -> Option<Zone> {
    let ok = !tz.is_empty()
        && tz.chars().all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
        && !tz.starts_with('/')
        && !tz.split('/').any(|p| p.is_empty() || p.starts_with('.'))
        && !NOT_ZONES.contains(&tz.to_ascii_lowercase().as_str());
    if !ok {
        return None;
    }
    let bytes = std::fs::read(std::path::Path::new("/usr/share/zoneinfo").join(tz)).ok()?;
    parse_tzif(&bytes)
}

fn parse_tzif(b: &[u8]) -> Option<Zone> {
    let u32_at = |i: usize| -> Option<usize> { Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?) as usize) };
    if b.get(0..4)? != b"TZif" {
        return None;
    }
    let version = *b.get(4)?;
    let counts = |at: usize| -> Option<[usize; 6]> { Some([u32_at(at + 20)?, u32_at(at + 24)?, u32_at(at + 28)?, u32_at(at + 32)?, u32_at(at + 36)?, u32_at(at + 40)?]) };
    let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0)?;
    let (start, wide) = if version >= b'2' {
        // Skip the 32-bit block to the second header.
        let v1 = 44 + timecnt * 4 + timecnt + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
        (v1, true)
    } else {
        (0, false)
    };
    let [_, _, _, timecnt, typecnt, _] = counts(start)?;
    let mut at = start + 44;
    let size = if wide { 8 } else { 4 };
    let mut times = Vec::with_capacity(timecnt);
    for i in 0..timecnt {
        let p = at + i * size;
        times.push(if wide { i64::from_be_bytes(b.get(p..p + 8)?.try_into().ok()?) } else { i32::from_be_bytes(b.get(p..p + 4)?.try_into().ok()?) as i64 });
    }
    at += timecnt * size;
    let idx = b.get(at..at + timecnt)?.to_vec();
    at += timecnt;
    let mut offsets = Vec::with_capacity(typecnt);
    for i in 0..typecnt {
        let p = at + i * 6;
        offsets.push(i32::from_be_bytes(b.get(p..p + 4)?.try_into().ok()?));
    }
    if offsets.is_empty() {
        return None;
    }
    Some(Zone { times, idx, offsets })
}

// ---- limit.ts ----

/// The next full hour after now: the reset when the message gives none.
pub fn next_full_hour(now: f64) -> f64 {
    let d = set_local(now, |f| {
        f.mi = 0;
        f.s = 0;
        f.ms = 0;
    });
    set_local(d, |f| f.h += 1)
}

/// Wall-clock fields in `tz` (or local time when None) as an instant (`wallTime`).
fn wall_time(y: i64, mo: i64, d: i64, h: i64, mi: i64, tz: Option<&str>) -> f64 {
    let Some(tz) = tz else { return local_ms(y, mo, d, h, mi, 0, 0) };
    let guess = utc_ms(y, mo, d, h, mi, 0, 0);
    let off1 = zone_offset(tz, guess).unwrap_or(0.0);
    let off2 = zone_offset(tz, guess - off1).unwrap_or(off1);
    clip(guess - off2)
}

/// Today's (year, month, day) as seen in `tz` (or local time).
fn today(now: f64, tz: Option<&str>) -> (i64, i64, i64) {
    match tz {
        None => {
            let f = local_fields(now);
            (f.y, f.mon, f.d)
        }
        Some(tz) => {
            let f = utc_fields(now + zone_offset(tz, now).unwrap_or(0.0));
            (f.y, f.mon, f.d)
        }
    }
}

/// `parseReset`: when the limit in this message resets, in epoch ms: "resets 4am (Asia/Kuala_Lumpur)", "resets
/// 12:30am", "resets 16:00", "resets Oct 14, 9am", or "|<epoch seconds>". The time is in the zone the message names,
/// else local time, and the next such time after now. Without a time: the next full hour.
pub fn parse_reset(text: &str, now: f64) -> f64 {
    static EPOCH: OnceLock<Regex> = OnceLock::new();
    static RESET: OnceLock<Regex> = OnceLock::new();
    let epoch = EPOCH.get_or_init(|| Regex::new(r"\|\s*([0-9]{10})(?-u:\b)").expect("epoch regex"));
    if let Some(c) = epoch.captures(text) {
        return c[1].parse::<f64>().unwrap_or(0.0) * 1000.0;
    }
    let reset = RESET.get_or_init(|| {
        Regex::new(concat!(
            r"(?-u:\b)(?i-u:resets?)\s+(?:(?i-u:at)\s+)?",
            r"(?:(?:(?i-u:on)\s+)?((?i-u:[a-z]){3})(?i-u:[a-z])*\.?\s+([0-9]{1,2}),?\s+(?:(?i-u:at)\s+)?)?",
            r"([0-9]{1,2})(?::([0-9]{2}))?\s*((?i-u:am|pm))?(?:\s*\(([^)]+)\))?",
        ))
        .expect("reset regex")
    });
    let Some(m) = reset.captures(text) else { return next_full_hour(now) };
    let mut h: i64 = m[3].parse().unwrap_or(0);
    let mi: i64 = m.get(4).map(|x| x.as_str().parse().unwrap_or(0)).unwrap_or(0);
    let ampm = m.get(5).map(|x| x.as_str().to_ascii_lowercase());
    if ampm.is_none() && m.get(4).is_none() {
        // A bare number ("resets 5") isn't a time.
        return next_full_hour(now);
    }
    if ampm.as_deref() == Some("pm") && h < 12 {
        h += 12;
    }
    if ampm.as_deref() == Some("am") && h == 12 {
        h = 0;
    }
    if h > 23 || mi > 59 {
        return next_full_hour(now);
    }
    let mut tz: Option<String> = m.get(6).map(|x| crate::runs::js::trim(x.as_str()).to_string());
    if tz.as_deref().is_some_and(|z| zone_offset(z, now).is_none()) {
        tz = None;
    }
    let tz = tz.as_deref();
    let (by, bmo, bd) = today(now, tz);
    let month = m.get(1).and_then(|x| MONTHS.iter().position(|n| *n == x.as_str().to_ascii_lowercase()));
    if let Some(month) = month {
        let day: i64 = m[2].parse().unwrap_or(0);
        let mut at = wall_time(by, month as i64, day, h, mi, tz);
        // "Jan 2" seen in late December is next year.
        if at < now - 24.0 * HOUR_MS {
            at = wall_time(by + 1, month as i64, day, h, mi, tz);
        }
        return at;
    }
    let mut at = wall_time(by, bmo, bd, h, mi, tz);
    if at <= now {
        at = wall_time(by, bmo, bd + 1, h, mi, tz);
    }
    at
}

/// Local calendar day (YYYY-MM-DD) for the per-day cap on automatic continues (`dayKey`).
pub fn day_key(ms: f64) -> String {
    let f = local_fields(ms);
    format!("{}-{:02}-{:02}", f.y, f.mon + 1, f.d)
}

/// "4:00", "16:30" (local time); with the date ("Oct 14, 9:00") when it isn't within the next 20 hours
/// (`clockTime`).
pub fn clock_time(at: f64, now: f64) -> String {
    let f = local_fields(at);
    let t = format!("{}:{:02}", f.h, f.mi);
    if at - now < 20.0 * HOUR_MS {
        return t;
    }
    format!("{} {}, {t}", MONTHS_SHORT[f.mon as usize], f.d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_round_trip() {
        for days in [-800_000i64, -1, 0, 1, 19_000, 20_000, 60_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn fixed_offsets_like_jsc() {
        assert_eq!(fixed_offset("+08:00"), Some(8.0 * HOUR_MS));
        assert_eq!(fixed_offset("-0530"), Some(-5.5 * HOUR_MS));
        assert_eq!(fixed_offset("+24:00"), None);
        assert_eq!(fixed_offset("+8"), None);
    }

    #[test]
    fn named_zones_from_the_zone_folder() {
        if !std::path::Path::new("/usr/share/zoneinfo/Asia/Kuala_Lumpur").exists() {
            return;
        }
        assert_eq!(zone_offset("Asia/Kuala_Lumpur", 1.79e12), Some(8.0 * HOUR_MS));
        assert_eq!(zone_offset("PST8PDT", 1.79e12), None);
        assert_eq!(zone_offset("../etc/passwd", 1.79e12), None);
        assert_eq!(zone_offset("Nowhere/Else", 1.79e12), None);
    }
}
