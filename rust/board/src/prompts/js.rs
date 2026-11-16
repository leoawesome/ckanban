//! Small JavaScript string behaviours the prompts depend on, so Rust's text is Bun's byte for byte: `trim()` (JS's
//! whitespace set, which has U+FEFF and lacks U+0085), lengths and cuts in UTF-16 units, `toFixed`, `String(n)`,
//! `JSON.stringify` of a string and `path.join`.

/// A character JS's `\s` and `trim()` count as white space (WhiteSpace and LineTerminator).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}'
            | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// JS `\s` as a Rust regex class body (inside `[...]`).
pub const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.trimEnd()`.
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}

/// `s.length` (UTF-16 code units).
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 units. A cut through a surrogate pair drops the pair (JS would keep half of it, which no
/// Rust string can hold); the prompts never cut text that short of a pair in practice.
pub fn slice16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if units + w > n {
            return &s[..i];
        }
        units += w;
    }
    s
}

/// `String(x)` for a number.
pub fn num(x: f64) -> String {
    ckanban_core::jsnum::js_string(x)
}

/// `x.toFixed(digits)` for a finite x below 1e21: the nearest decimal, ties to the larger value (JS), where Rust's
/// `{:.n}` would pick the even one.
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return num(x);
    }
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let keep = &frac[..digits.min(frac.len())];
    let rest = &frac[digits.min(frac.len())..];
    let up = match rest.as_bytes().first() {
        Some(b) if *b > b'5' => true,
        Some(b'5') => {
            // A tie (exactly ...5000...) rounds up for positives (larger n); for negatives, larger n is toward zero.
            let tie = rest[1..].bytes().all(|b| b == b'0');
            !tie || x > 0.0
        }
        _ => false,
    };
    let mut digits_s: Vec<u8> = format!("{int}{keep}").into_bytes();
    if up {
        let mut i = digits_s.len();
        loop {
            if i == 0 {
                digits_s.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits_s[i] == b'9' {
                digits_s[i] = b'0';
            } else {
                digits_s[i] += 1;
                break;
            }
        }
    }
    let s = String::from_utf8(digits_s).expect("ascii digits");
    let (i, f) = s.split_at(s.len() - digits);
    let body = if digits == 0 { i.to_string() } else { format!("{i}.{f}") };
    let zero = body.bytes().all(|b| b == b'0' || b == b'.');
    if x < 0.0 && !zero { format!("-{body}") } else { body }
}

/// `JSON.stringify(s)` for a string.
pub fn json_str(s: &str) -> String {
    serde_json::to_string(s).expect("string to JSON")
}

/// `path.join(a, b)` (POSIX): joined and normalised (`.`/`..` resolved, repeated slashes collapsed).
pub fn path_join(a: &str, b: &str) -> String {
    let joined = if a.is_empty() { b.to_string() } else if b.is_empty() { a.to_string() } else { format!("{a}/{b}") };
    normalize(&joined)
}

fn normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let abs = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else if !abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if abs {
        s = format!("/{s}");
    }
    if s.is_empty() {
        s = ".".into();
    }
    if trailing && s != "/" {
        s.push('/');
    }
    s
}

/// JS truthiness of an optional string: present and not empty.
pub fn some_text(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// `n === 1 ? one : many`.
pub fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// Builds a String from pieces (each `&str` or `String`), the way a JS template literal joins its parts.
#[macro_export]
macro_rules! cat {
    ($($e:expr),* $(,)?) => {{
        let mut s = ::std::string::String::new();
        $( s.push_str(::core::convert::AsRef::<str>::as_ref(&$e)); )*
        s
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_ties_round_up() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(0.375, 2), "0.38");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 is just below in binary
        assert_eq!(to_fixed(0.0, 2), "0.00");
        assert_eq!(to_fixed(9.999, 2), "10.00");
        assert_eq!(to_fixed(12.3, 2), "12.30");
    }

    #[test]
    fn utf16_cuts() {
        assert_eq!(len16("a😀"), 3);
        assert_eq!(slice16("ab😀c", 3), "ab");
        assert_eq!(slice16("ab😀c", 4), "ab😀");
        assert_eq!(trim("\u{FEFF} x \u{85}"), "x \u{85}");
    }

    #[test]
    fn joins_like_node() {
        assert_eq!(path_join("/a/b/", "mockups"), "/a/b/mockups");
        assert_eq!(path_join("/a/./b/../c", "m"), "/a/c/m");
        assert_eq!(path_join("rel", "m"), "rel/m");
    }
}
