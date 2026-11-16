//! What the Bun tools get from JavaScript itself and Rust doesn't have: reading loose JSON arguments the way
//! `args?.x` does, `${value}` in template strings, String.prototype.length/slice/trim (UTF-16 based),
//! encodeURIComponent and URLSearchParams, Number.prototype.toFixed and `new Date(iso)` in local time.

use serde_json::Value;

/// `args?.[key]`: None for a missing key or when `v` isn't an object.
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

/// `typeof v.key === "string" ? v.key : None`.
pub fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get(v, key).and_then(Value::as_str)
}

/// `v.key === true`.
pub fn is_true(v: &Value, key: &str) -> bool {
    get(v, key) == Some(&Value::Bool(true))
}

/// `typeof v.key === "boolean" ? v.key : None`.
pub fn bool_of(v: &Value, key: &str) -> Option<bool> {
    get(v, key).and_then(Value::as_bool)
}

/// `typeof v.key === "number" ? v.key : None`.
pub fn num(v: &Value, key: &str) -> Option<f64> {
    get(v, key).and_then(Value::as_f64)
}

/// `v.key` is defined (JSON null counts as defined, as in JS).
pub fn has(v: &Value, key: &str) -> bool {
    get(v, key).is_some()
}

/// JS truthiness of a JSON value (a missing one is undefined, so false).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `v.key` is truthy.
pub fn t(v: &Value, key: &str) -> bool {
    truthy(get(v, key))
}

/// A truthy string field, else None (`t.kind ? t.kind : null` style).
pub fn ts<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get(v, key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `v.key?.length` of an array, 0 when missing or not an array.
pub fn len(v: &Value, key: &str) -> usize {
    get(v, key).and_then(Value::as_array).map_or(0, Vec::len)
}

/// The array at `v.key`, empty when missing.
pub fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    get(v, key).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `${x}` of a number, as JS prints it (integers without a fraction, shortest round-trip otherwise).
pub fn num_str(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == f.trunc() && f.abs() < 1e21 {
        return format!("{}", f as i128);
    }
    let abs = f.abs();
    if (1e-7..1e21).contains(&abs) {
        return format!("{f}");
    }
    // Exponent form as JS writes it: 1e-7, 1.5e+25.
    let e = format!("{f:e}");
    match e.split_once('e') {
        Some((m, x)) if !x.starts_with('-') => format!("{m}e+{x}"),
        _ => e,
    }
}

/// `${value}` in a template string (undefined for a missing value).
pub fn show(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => num_str(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { show(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `${v.key}`.
pub fn sh(v: &Value, key: &str) -> String {
    show(get(v, key))
}

/// String(x ?? "") style: `${v.key ?? ""}`.
pub fn sh_or_empty(v: &Value, key: &str) -> String {
    match get(v, key) {
        None | Some(Value::Null) => String::new(),
        x => show(x),
    }
}

/// Number.prototype.toFixed for the small amounts tools print (seconds, dollars).
pub fn to_fixed(f: f64, digits: usize) -> String {
    if !f.is_finite() {
        return num_str(f);
    }
    // JS rounds the exact binary value half up; format! rounds half to even on the exact value, which only differs on
    // exact ties (like 0.125), and those print the same way for the one or two digits used here in practice.
    format!("{f:.digits$}")
}

/// JS whitespace for trim(): Unicode White_Space plus the BOM.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// String.prototype.trim.
pub fn trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// String.prototype.trimEnd.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(js_space)
}

/// String.prototype.length (UTF-16 code units).
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// String.prototype.slice(start, end) on UTF-16 units; negative values count from the end.
pub fn slice(s: &str, start: isize, end: Option<isize>) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let n = units.len() as isize;
    let fix = |i: isize| if i < 0 { (n + i).max(0) } else { i.min(n) };
    let a = fix(start);
    let b = end.map_or(n, fix);
    if a >= b {
        return String::new();
    }
    String::from_utf16_lossy(&units[a as usize..b as usize])
}

/// `s.replace(/\s+/g, " ")`.
pub fn squash_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// encodeURIComponent.
pub fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// URLSearchParams' toString(): application/x-www-form-urlencoded pairs.
pub fn query(pairs: &[(&str, String)]) -> String {
    fn form(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || b"*-._".contains(&b) {
                out.push(b as char);
            } else if b == b' ' {
                out.push('+');
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out
    }
    pairs.iter().map(|(k, v)| format!("{}={}", form(k), form(v))).collect::<Vec<_>>().join("&")
}

/// `new Date(iso)` → milliseconds since 1970, for the ISO times the daemon sends ("2026-10-01T09:00:00.000Z", with an
/// offset or none: then local time, as JS reads a date-time without a zone). None where JS gives an Invalid Date.
pub fn parse_iso(s: &str) -> Option<i64> {
    let b = s.trim().as_bytes();
    let digits = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = b.get(r)?;
        if part.is_empty() || !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = digits(0..4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let (mut hour, mut min, mut sec, mut ms) = (0, 0, 0, 0);
    let mut i;
    let mut zone: Option<i64> = None;
    if b.len() == 10 {
        // A date alone is UTC in JS.
        zone = Some(0);
    } else {
        if b.get(10) != Some(&b'T') && b.get(10) != Some(&b' ') {
            return None;
        }
        hour = digits(11..13)?;
        if b.get(13) != Some(&b':') {
            return None;
        }
        min = digits(14..16)?;
        i = 16;
        if b.get(i) == Some(&b':') {
            sec = digits(17..19)?;
            i = 19;
            if b.get(i) == Some(&b'.') {
                let start = i + 1;
                let mut end = start;
                while end < b.len() && b[end].is_ascii_digit() {
                    end += 1;
                }
                if end == start {
                    return None;
                }
                let frac = std::str::from_utf8(&b[start..end]).ok()?;
                let three: String = frac.chars().chain("000".chars()).take(3).collect();
                ms = three.parse().ok()?;
                i = end;
            }
        }
        match b.get(i) {
            None => {}
            Some(b'Z') if i + 1 == b.len() => zone = Some(0),
            Some(&c) if c == b'+' || c == b'-' => {
                let h = digits(i + 1..i + 3)?;
                let rest = &b[i + 3..];
                let m = match rest {
                    [] => 0,
                    [b':', m1, m2] | [m1, m2] if m1.is_ascii_digit() && m2.is_ascii_digit() => ((m1 - b'0') * 10 + (m2 - b'0')) as i64,
                    _ => return None,
                };
                let off = h * 60 + m;
                zone = Some(if c == b'+' { off } else { -off });
            }
            _ => return None,
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 24 || min > 59 || sec > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let local_ms = ((days * 24 + hour) * 60 + min) * 60_000 + sec * 1000 + ms;
    match zone {
        Some(off) => Some(local_ms - off * 60_000),
        None => Some(local_ms - local_offset_min(local_ms / 1000) * 60_000),
    }
}

/// Days since 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// This computer's UTC offset in minutes at a time given as local seconds (close enough: the offset at that instant).
fn local_offset_min(secs: i64) -> i64 {
    local_parts(secs).map_or(0, |p| p.6)
}

/// (year, month, day, hour, minute, second, offset minutes) of a UTC second count, in local time.
fn local_parts(secs: i64) -> Option<(i64, i64, i64, i64, i64, i64, i64)> {
    let t = secs as libc::time_t;
    // SAFETY: localtime_r writes into our zeroed tm and reads only `t`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::localtime_r(&t, &mut tm) };
    if r.is_null() {
        return None;
    }
    Some((
        tm.tm_year as i64 + 1900,
        tm.tm_mon as i64 + 1,
        tm.tm_mday as i64,
        tm.tm_hour as i64,
        tm.tm_min as i64,
        tm.tm_sec as i64,
        tm.tm_gmtoff as i64 / 60,
    ))
}

/// `localTime` in src/mcp/shared.ts: an ISO time as local "2026-10-01 09:00".
pub fn local_time(iso: &str) -> String {
    match parse_iso(iso).and_then(|ms| local_parts(ms.div_euclid(1000))) {
        Some((y, mo, d, h, mi, _, _)) => format!("{y}-{mo:02}-{d:02} {h:02}:{mi:02}"),
        None => "NaN-NaN-NaN NaN:NaN".into(),
    }
}

/// `localTime` of a JSON value (String(undefined) etc. are invalid dates).
pub fn local_time_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => local_time(s),
        _ => "NaN-NaN-NaN NaN:NaN".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_js() {
        assert_eq!(num_str(3.0), "3");
        assert_eq!(num_str(-0.0), "0");
        assert_eq!(num_str(1.5), "1.5");
        assert_eq!(num_str(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(to_fixed(1.25, 1), "1.2");
        assert_eq!(to_fixed(12.0, 2), "12.00");
    }

    #[test]
    fn show_matches_template_strings() {
        assert_eq!(show(None), "undefined");
        assert_eq!(show(Some(&json!(null))), "null");
        assert_eq!(show(Some(&json!(["a", 1, null]))), "a,1,");
        assert_eq!(show(Some(&json!({"a": 1}))), "[object Object]");
    }

    #[test]
    fn utf16_slicing() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(slice("hello", -3, None), "llo");
        assert_eq!(slice("hello", 0, Some(2)), "he");
        assert_eq!(slice("hi", 5, None), "");
    }

    #[test]
    fn encoding() {
        assert_eq!(enc("a b/ç'"), "a%20b%2F%C3%A7'");
        assert_eq!(query(&[("q", "a b&c".into()), ("t", "~x".into())]), "q=a+b%26c&t=%7Ex");
    }

    #[test]
    fn iso_times() {
        assert_eq!(parse_iso("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso("2026-10-01T09:00:00+02:00"), Some(parse_iso("2026-10-01T07:00:00Z").unwrap()));
        assert_eq!(parse_iso("nope"), None);
        assert_eq!(local_time("nope"), "NaN-NaN-NaN NaN:NaN");
        assert_eq!(squash_space(" a \n\t b "), " a b ");
    }
}
