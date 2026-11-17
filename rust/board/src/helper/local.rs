//! This Mac's local time the way JavaScript's `Date` reads and builds it: `getHours()`, `new Date(y, m, d, h, min)`
//! (months and days that run over roll into the next, a time in a spring-forward gap moves forward, an ambiguous one
//! takes the earlier instant), `toString()`.

use chrono::{Datelike, Duration, Local, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike};

/// The local parts of an instant: year, month (0-11), day, hours, minutes, weekday (0 = Sunday).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Parts {
    pub year: i32,
    pub month0: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub weekday: u32,
}

pub fn parts(ms: f64) -> Parts {
    let d = Local.timestamp_millis_opt(ms as i64).single().unwrap_or_else(|| Local.timestamp_millis_opt(0).unwrap());
    Parts { year: d.year(), month0: d.month0(), day: d.day(), hour: d.hour(), minute: d.minute(), weekday: d.weekday().num_days_from_sunday() }
}

/// `new Date(year, month0, day, hour, minute).getTime()`; day may be 0 or run past the month's end, month0 past 11.
pub fn make(year: i32, month0: i64, day: i64, hour: u32, minute: u32) -> f64 {
    let y = year as i64 + month0.div_euclid(12);
    let m = month0.rem_euclid(12) as u32 + 1;
    let Some(first) = NaiveDate::from_ymd_opt(y as i32, m, 1) else { return f64::NAN };
    let date = first + Duration::days(day - 1);
    let Some(mut naive) = date.and_hms_opt(hour.min(23), minute.min(59), 0) else { return f64::NAN };
    for _ in 0..4 {
        match Local.from_local_datetime(&naive) {
            LocalResult::Single(t) => return t.timestamp_millis() as f64,
            LocalResult::Ambiguous(a, b) => return a.timestamp_millis().min(b.timestamp_millis()) as f64,
            // In a spring-forward gap: JS moves the wall time forward by the gap (an hour almost everywhere).
            LocalResult::None => naive += Duration::hours(1),
        }
    }
    f64::NAN
}

/// `new Date(ms).toString()`, without the zone's long name: "Tue Nov 17 2026 14:05:00 GMT+0100". Only the helper's
/// model reads it (the input's local times).
pub fn to_string(ms: f64) -> String {
    match Local.timestamp_millis_opt(ms as i64).single() {
        Some(d) => {
            let off = d.offset().local_minus_utc() / 60;
            let sign = if off < 0 { '-' } else { '+' };
            let naive: NaiveDateTime = d.naive_local();
            format!("{} GMT{sign}{:02}{:02}", naive.format("%a %b %d %Y %H:%M:%S"), off.abs() / 60, off.abs() % 60)
        }
        None => "Invalid Date".into(),
    }
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// `toLocaleString("en-GB", { month: "short" })` (as Bun gives it).
pub fn month_short(month0: u32) -> &'static str {
    MONTHS[(month0 as usize).min(11)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_roll_over() {
        let a = make(2026, 0, 32, 10, 0);
        let b = make(2026, 1, 1, 10, 0);
        assert_eq!(a, b);
        let p = parts(make(2026, 2, 0, 9, 30));
        assert_eq!((p.month0, p.day, p.hour, p.minute), (1, 28, 9, 30));
    }
}
