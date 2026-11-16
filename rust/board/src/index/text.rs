//! Small JavaScript string behaviours the ported code copies: `trim()`, `\s`, `.length` and `.slice()` in UTF-16
//! units, `toFixed(2)`.

/// JS's `\s` (WhiteSpace and LineTerminator).
pub fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_space)
}

/// `s.replace(/\s+/g, " ")`.
pub fn squash_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_space = false;
    for c in s.chars() {
        if is_space(c) {
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

/// `s.length`.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 units; a cut inside a surrogate pair keeps the whole character out.
pub fn slice16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        if units + c.len_utf16() > n {
            return &s[..i];
        }
        units += c.len_utf16();
    }
    s
}

/// `clip` of main-ticket.ts: at most n units, the last one an ellipsis.
pub fn clip(s: &str, n: usize) -> String {
    if len16(s) > n { format!("{}…", slice16(s, n.saturating_sub(1))) } else { s.to_string() }
}

/// `x.toFixed(2)`.
pub fn fixed2(x: f64) -> String {
    format!("{x:.2}")
}
