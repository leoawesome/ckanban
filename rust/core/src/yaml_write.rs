//! `YAML.stringify(value)` of the `yaml` npm package (v2, default options), for JSON values: what Bun writes as a
//! ticket's front matter (`serializeTicket` in `src/core/store.ts`). Ported line by line from the package's
//! `stringify*.js` and `foldFlowLines.js`, including its quirks (how far a folded line may run after a key, when a
//! multi-line string becomes a `|` or `>` block), so a ticket Rust writes has the bytes Bun would write.
//!
//! Lengths and positions are counted in UTF-16 code units, as in JavaScript: line folding depends on them.
//!
//! Not covered (Bun's writer never meets them in ticket files): aliases for objects used twice (Bun's
//! `aliasDuplicateObjects` needs object identity, which JSON values don't have), `-0`, NaN and infinities, keys
//! over 1024 characters (Bun writes them as explicit `? key` entries).

use crate::jsnum::js_string;
use serde_json::{Map, Value};

const LINE_WIDTH: usize = 80;
const MIN_CONTENT_WIDTH: usize = 20;
const DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH: usize = 40;
const INDENT_STEP: &str = "  ";

type U16s = Vec<u16>;

fn u(s: &str) -> U16s {
    s.encode_utf16().collect()
}
fn s(v: &[u16]) -> String {
    String::from_utf16_lossy(v)
}
fn at(v: &[u16], i: usize) -> Option<u16> {
    v.get(i).copied()
}
const NL: u16 = b'\n' as u16;
const SP: u16 = b' ' as u16;
const TAB: u16 = b'\t' as u16;
const BS: u16 = b'\\' as u16;
const DQ: u16 = b'"' as u16;

#[derive(Clone)]
struct Ctx {
    indent: String,
    implicit_key: bool,
    /// Where the value starts on its line, as Bun counts it (only set for a scalar after `key: `).
    indent_at_start: Option<usize>,
    /// A top-level string with a document marker in it is written as an indented block.
    force_block_indent: bool,
}

/// The YAML document for a JSON object, exactly as `YAML.stringify(object)` writes it (ends with a newline).
pub fn stringify_map(m: &Map<String, Value>) -> String {
    stringify(&Value::Object(m.clone()))
}

/// `YAML.stringify(value)` for any JSON value.
pub fn stringify(v: &Value) -> String {
    // Objects in JS key order (index keys first), as Bun's would be.
    let v = crate::jskeys::ordered(v);
    let v = v.as_ref();
    let ctx = Ctx { indent: String::new(), implicit_key: false, indent_at_start: None, force_block_indent: false };
    format!("{}\n", node(v, &ctx))
}

fn node(v: &Value, ctx: &Ctx) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Number(n) => n.as_f64().map(js_string).unwrap_or_else(|| n.to_string()),
        Value::String(st) => string(st, ctx),
        Value::Array(a) => seq(a, ctx),
        Value::Object(m) => map(m, ctx),
    }
}

fn map(m: &Map<String, Value>, ctx: &Ctx) -> String {
    if m.is_empty() {
        return "{}".into();
    }
    let item = Ctx { indent: ctx.indent.clone(), ..ctx.clone() };
    let lines: Vec<String> = m.iter().map(|(k, v)| pair(k, v, &item)).collect();
    lines.join(&format!("\n{}", ctx.indent))
}

fn seq(a: &[Value], ctx: &Ctx) -> String {
    if a.is_empty() {
        return "[]".into();
    }
    let item = Ctx { indent: format!("{}  ", ctx.indent), ..ctx.clone() };
    let lines: Vec<String> = a.iter().map(|v| format!("- {}", node(v, &item))).collect();
    lines.join(&format!("\n{}", ctx.indent))
}

fn is_collection(v: &Value) -> bool {
    matches!(v, Value::Array(_) | Value::Object(_))
}
fn is_empty_collection(v: &Value) -> bool {
    match v {
        Value::Array(a) => a.is_empty(),
        Value::Object(m) => m.is_empty(),
        _ => false,
    }
}

fn pair(key: &str, value: &Value, ctx: &Ctx) -> String {
    let inner = format!("{}{INDENT_STEP}", ctx.indent);
    let key_ctx = Ctx { indent: inner.clone(), implicit_key: true, ..ctx.clone() };
    let mut str = string(key, &key_ctx);
    let explicit_key = u(&str).len() > 1024;
    str = if explicit_key { format!("? {str}\n{}:", ctx.indent) } else { format!("{str}:") };
    let mut value_ctx = Ctx { indent: inner, implicit_key: false, ..ctx.clone() };
    if !explicit_key && !is_collection(value) {
        value_ctx.indent_at_start = Some(u(&str).len() + 1);
    }
    let value_str = node(value, &value_ctx);
    let mut ws = " ".to_string();
    if !explicit_key && is_collection(value) {
        if value_str.contains('\n') || !is_empty_collection(value) {
            ws = format!("\n{}", value_ctx.indent);
        }
    } else if value_str.is_empty() || value_str.starts_with('\n') {
        ws = String::new();
    }
    format!("{str}{ws}{value_str}")
}

// ---- strings (stringifyString.js) ----

fn has_control(st: &str) -> bool {
    st.chars().any(|c| matches!(c as u32, 0x00..=0x08 | 0x0b..=0x1f | 0x7f..=0x9f))
}

fn string(value: &str, ctx: &Ctx) -> String {
    if has_control(value) {
        return double_quoted(value, ctx);
    }
    plain(value, ctx)
}

/// JavaScript's `^` with the `m` flag: the start, or after \n, \r, U+2028 or U+2029.
fn line_starts(st: &str) -> impl Iterator<Item = &str> {
    std::iter::once(st).chain(st.char_indices().filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')).map(move |(i, c)| &st[i + c.len_utf8()..]))
}

fn contains_document_marker(st: &str) -> bool {
    line_starts(st).any(|l| l.starts_with('%') || l.starts_with("---") || l.starts_with("..."))
}

/// `/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/`
fn plain_not_allowed(v: &str) -> bool {
    let c: Vec<char> = v.chars().collect();
    if let Some(&f) = c.first() {
        if "\n\t ,[]{}#&*!|>'\"%@`".contains(f) {
            return true;
        }
        if (f == '?' || f == '-') && (c.len() == 1 || c[1] == ' ' || c[1] == '\t') {
            return true;
        }
    }
    for w in c.windows(2) {
        let (a, b) = (w[0], w[1]);
        if (a == '\n' || a == ':') && (b == ' ' || b == '\t') {
            return true;
        }
        if (a == ' ' || a == '\t') && b == '\n' {
            return true;
        }
        if (a == '\n' || a == '\t' || a == ' ') && b == '#' {
            return true;
        }
    }
    matches!(c.last(), Some('\n' | '\t' | ' ' | ':'))
}

fn all(st: &str, f: impl Fn(char) -> bool) -> bool {
    !st.is_empty() && st.chars().all(f)
}
fn digits(st: &str) -> bool {
    all(st, |c| c.is_ascii_digit())
}
fn strip_sign(st: &str) -> &str {
    st.strip_prefix(['-', '+']).unwrap_or(st)
}
/// `[0-9]+(?:\.[0-9]*)?` or `\.[0-9]+`; `need_dot`: the dot is required (the float tag).
fn decimal(st: &str, need_dot: bool) -> bool {
    match st.split_once('.') {
        Some(("", frac)) => digits(frac),
        Some((int, frac)) => digits(int) && (frac.is_empty() || digits(frac)),
        None => !need_dot && digits(st),
    }
}

/// Whether a plain scalar would read back as something other than a string (the core schema's tag tests).
pub(crate) fn looks_like_non_string(st: &str) -> bool {
    matches!(st, "" | "~" | "null" | "Null" | "NULL" | "true" | "True" | "TRUE" | "false" | "False" | "FALSE")
        || st.strip_prefix("0o").is_some_and(|r| all(r, |c| ('0'..='7').contains(&c)))
        || digits(strip_sign(st))
        || st.strip_prefix("0x").is_some_and(|r| all(r, |c| c.is_ascii_hexdigit()))
        || matches!(strip_sign(st), ".inf" | ".Inf" | ".INF")
        || matches!(st, ".nan" | ".NaN" | ".NAN")
        || {
            let body = strip_sign(st);
            match body.find(['e', 'E']) {
                Some(i) => decimal(&body[..i], false) && digits(strip_sign(&body[i + 1..])),
                None => false,
            }
        }
        || decimal(strip_sign(st), true)
}

fn plain(value: &str, ctx: &Ctx) -> String {
    let has_nl = value.contains('\n');
    if ctx.implicit_key && has_nl {
        return quoted(value, ctx);
    }
    if plain_not_allowed(value) {
        return if ctx.implicit_key || !has_nl { quoted(value, ctx) } else { block(value, ctx) };
    }
    if !ctx.implicit_key && has_nl {
        return block(value, ctx);
    }
    if contains_document_marker(value) {
        if ctx.indent.is_empty() {
            return block(value, &Ctx { force_block_indent: true, ..ctx.clone() });
        } else if ctx.implicit_key && ctx.indent == INDENT_STEP {
            return quoted(value, ctx);
        }
    }
    if looks_like_non_string(value) {
        return quoted(value, ctx);
    }
    if ctx.implicit_key {
        value.to_string()
    } else {
        s(&fold(&u(value), &ctx.indent, Fold::Flow, ctx.indent_at_start, None))
    }
}

fn quoted(value: &str, ctx: &Ctx) -> String {
    let has_double = value.contains('"');
    let has_single = value.contains('\'');
    if has_double && !has_single { single_quoted(value, ctx) } else { double_quoted(value, ctx) }
}

fn quoted_indent(value: &str, ctx: &Ctx) -> String {
    if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if contains_document_marker(value) {
        "  ".into()
    } else {
        String::new()
    }
}

fn single_quoted(value: &str, ctx: &Ctx) -> String {
    let ws_around_nl = value.as_bytes().windows(2).any(|w| matches!((w[0], w[1]), (b' ' | b'\t', b'\n') | (b'\n', b' ' | b'\t')));
    if (ctx.implicit_key && value.contains('\n')) || ws_around_nl {
        return double_quoted(value, ctx);
    }
    let indent = quoted_indent(value, ctx);
    let escaped = value.replace('\'', "''");
    let res = format!("'{}'", replace_nl_runs(&escaped, |run| format!("{run}\n{indent}")));
    if ctx.implicit_key { res } else { s(&fold(&u(&res), &indent, Fold::Flow, ctx.indent_at_start, None)) }
}

/// Every run of `\n` replaced by `f(run)`.
fn replace_nl_runs(st: &str, f: impl Fn(&str) -> String) -> String {
    let mut out = String::with_capacity(st.len());
    let mut rest = st;
    while let Some(i) = rest.find('\n') {
        out.push_str(&rest[..i]);
        let n = rest[i..].bytes().take_while(|b| *b == b'\n').count();
        out.push_str(&f(&rest[i..i + n]));
        rest = &rest[i + n..];
    }
    out.push_str(rest);
    out
}

/// `JSON.stringify(string)`.
pub(crate) fn json_string(st: &str) -> String {
    serde_json::to_string(st).expect("string to JSON")
}

fn double_quoted(value: &str, ctx: &Ctx) -> String {
    let json = u(&json_string(value));
    let implicit = ctx.implicit_key;
    let indent = quoted_indent(value, ctx);
    let ind = u(&indent);
    let mut out: U16s = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < json.len() {
        let mut ch = json[i];
        if ch == SP && at(&json, i + 1) == Some(BS) && at(&json, i + 2) == Some(b'n' as u16) {
            // A space before a newline is escaped so folding keeps it.
            out.extend_from_slice(&json[start..i]);
            out.extend(u("\\ "));
            i += 1;
            start = i;
            ch = BS;
        }
        if ch == BS {
            match at(&json, i + 1).map(|c| c as u8 as char) {
                Some('u') => {
                    out.extend_from_slice(&json[start..i]);
                    let code = s(&json[i + 2..(i + 6).min(json.len())]);
                    match code.as_str() {
                        "0000" => out.extend(u("\\0")),
                        "0007" => out.extend(u("\\a")),
                        "000b" => out.extend(u("\\v")),
                        "001b" => out.extend(u("\\e")),
                        "0085" => out.extend(u("\\N")),
                        "00a0" => out.extend(u("\\_")),
                        "2028" => out.extend(u("\\L")),
                        "2029" => out.extend(u("\\P")),
                        c if c.starts_with("00") => out.extend(u(&format!("\\x{}", &c[2..]))),
                        _ => out.extend_from_slice(&json[i..(i + 6).min(json.len())]),
                    }
                    i += 5;
                    start = i + 1;
                }
                Some('n') => {
                    if implicit || at(&json, i + 2) == Some(DQ) || json.len() < DOUBLE_QUOTED_MIN_MULTI_LINE_LENGTH {
                        i += 1;
                    } else {
                        // Folding eats the first newline.
                        out.extend_from_slice(&json[start..i]);
                        out.extend(u("\n\n"));
                        while at(&json, i + 2) == Some(BS) && at(&json, i + 3) == Some(b'n' as u16) && at(&json, i + 4) != Some(DQ) {
                            out.push(NL);
                            i += 2;
                        }
                        out.extend_from_slice(&ind);
                        // A space after a newline is escaped so folding keeps it.
                        if at(&json, i + 2) == Some(SP) {
                            out.push(BS);
                        }
                        i += 1;
                        start = i + 1;
                    }
                }
                _ => i += 1,
            }
        }
        i += 1;
    }
    let text = if start > 0 {
        out.extend_from_slice(&json[start.min(json.len())..]);
        out
    } else {
        json
    };
    if implicit { s(&text) } else { s(&fold(&text, &indent, Fold::Quoted, ctx.indent_at_start, None)) }
}

fn line_length_over_limit(st: &[u16], line_width: usize, indent_length: usize) -> bool {
    let limit = line_width as isize - indent_length as isize;
    let len = st.len() as isize;
    if len <= limit {
        return false;
    }
    let mut start = 0isize;
    for (i, &c) in st.iter().enumerate() {
        if c == NL {
            let i = i as isize;
            if i - start > limit {
                return true;
            }
            start = i + 1;
            if len - start <= limit {
                return false;
            }
        }
    }
    true
}

/// JavaScript's `.`: anything but a line terminator.
fn is_line_char(c: u16) -> bool {
    !matches!(c, 0x0a | 0x0d | 0x2028 | 0x2029)
}
fn is_ws_nl(c: u16) -> bool {
    c == NL || c == TAB || c == SP
}

/// `.replace(/\n+/g, f)` on UTF-16 text.
fn replace_nl_runs16(v: &[u16], f: impl Fn(usize) -> U16s) -> U16s {
    let mut out = Vec::with_capacity(v.len());
    let mut i = 0;
    while i < v.len() {
        if v[i] == NL {
            let n = v[i..].iter().take_while(|c| **c == NL).count();
            out.extend(f(n));
            i += n;
        } else {
            out.push(v[i]);
            i += 1;
        }
    }
    out
}

/// `.replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, '$1$2')`: more-indented lines aren't folded.
fn keep_more_indented(v: &[u16]) -> U16s {
    let mut out = Vec::with_capacity(v.len());
    let mut i = 0;
    while i < v.len() {
        // The match starts at the very start or at a \n (dropped), and the line begins with a tab or space.
        let line_start = if i == 0 && (v[0] == TAB || v[0] == SP) {
            0
        } else if v[i] == NL && matches!(at(v, i + 1), Some(TAB | SP)) {
            i + 1
        } else {
            out.push(v[i]);
            i += 1;
            continue;
        };
        let mut j = line_start;
        while j < v.len() && is_line_char(v[j]) {
            j += 1;
        }
        out.extend_from_slice(&v[line_start..j]);
        // The whitespace run after the line: taken (minus its last \n) when it ends in \n.
        let mut k = j;
        while k < v.len() && is_ws_nl(v[k]) {
            k += 1;
        }
        if k > j && v[k - 1] == NL {
            out.extend_from_slice(&v[j..k - 1]);
            i = k;
        } else {
            i = j;
        }
    }
    out
}

/// `/\n[\t ]+$/`
fn ends_with_nl_then_blanks(v: &str) -> bool {
    let t = v.trim_end_matches([' ', '\t']);
    t.len() < v.len() && t.ends_with('\n')
}

fn block(value: &str, ctx: &Ctx) -> String {
    if ends_with_nl_then_blanks(value) {
        return quoted(value, ctx);
    }
    let indent = if !ctx.indent.is_empty() {
        ctx.indent.clone()
    } else if ctx.force_block_indent || contains_document_marker(value) {
        "  ".into()
    } else {
        String::new()
    };
    let ind = u(&indent);
    let mut v = u(value);
    let literal = !line_length_over_limit(&v, LINE_WIDTH, ind.len());
    if v.is_empty() {
        return if literal { "|\n".into() } else { ">\n".into() };
    }
    // Chomping from the whitespace at the end.
    let mut end_start = v.len();
    while end_start > 0 && matches!(v[end_start - 1], NL | TAB | SP) {
        end_start -= 1;
    }
    let mut end: U16s = v[end_start..].to_vec();
    let chomp = match end.iter().position(|c| *c == NL) {
        None => "-",
        Some(p) if end_start == 0 || p != end.len() - 1 => "+",
        Some(_) => "",
    };
    if !end.is_empty() {
        v.truncate(end_start);
        if end.last() == Some(&NL) {
            end.pop();
        }
        // blockEndNewlines: every run of \n not at the very end gets the indent after it.
        let mut e = Vec::with_capacity(end.len());
        let mut i = 0;
        while i < end.len() {
            if end[i] == NL {
                let n = end[i..].iter().take_while(|c| **c == NL).count();
                e.extend_from_slice(&end[i..i + n]);
                if i + n < end.len() {
                    e.extend_from_slice(&ind);
                }
                i += n;
            } else {
                e.push(end[i]);
                i += 1;
            }
        }
        end = e;
    }
    // Indent indicator from the whitespace at the start.
    let mut start_with_space = false;
    let mut start_nl: isize = -1;
    let mut start_end = 0;
    while start_end < v.len() {
        match v[start_end] {
            SP => start_with_space = true,
            NL => start_nl = start_end as isize,
            _ => break,
        }
        start_end += 1;
    }
    let cut = if start_nl < start_end as isize { (start_nl + 1) as usize } else { start_end };
    let mut start: U16s = v[..cut].to_vec();
    if !start.is_empty() {
        v = v[cut..].to_vec();
        start = replace_nl_runs16(&start, |n| [vec![NL; n], ind.clone()].concat());
    }
    let indent_size = if indent.is_empty() { "1" } else { "2" };
    let header = format!("{}{chomp}", if start_with_space { indent_size } else { "" });
    if !literal {
        let folded = replace_nl_runs16(&v, |n| vec![NL; n + 1]);
        let folded = keep_more_indented(&folded);
        let folded = replace_nl_runs16(&folded, |n| [vec![NL; n], ind.clone()].concat());
        let mut overflow = false;
        let text = [start.clone(), folded, end.clone()].concat();
        let body = fold(&text, &indent, Fold::Block, Some(ind.len()), Some(&mut overflow));
        if !overflow {
            return format!(">{header}\n{indent}{}", s(&body));
        }
    }
    let v = replace_nl_runs16(&v, |n| [vec![NL; n], ind.clone()].concat());
    format!("|{header}\n{indent}{}{}{}", s(&start), s(&v), s(&end))
}

// ---- foldFlowLines.js ----

#[derive(Clone, Copy, PartialEq)]
enum Fold {
    Flow,
    Block,
    Quoted,
}

fn fold(text: &[u16], indent: &str, mode: Fold, indent_at_start: Option<usize>, on_overflow: Option<&mut bool>) -> U16s {
    let lw = LINE_WIDTH as isize;
    let mcw = MIN_CONTENT_WIDTH as isize;
    let ind_len = u(indent).len() as isize;
    let end_step = (1 + mcw).max(1 + lw - ind_len);
    let len = text.len() as isize;
    if len <= end_step {
        return text.to_vec();
    }
    let ch_at = |i: isize| if i >= 0 && i < len { Some(text[i as usize]) } else { None };
    let mut folds: Vec<isize> = Vec::new();
    let mut escaped_folds: std::collections::HashSet<isize> = Default::default();
    let mut end = lw - ind_len;
    if let Some(ias) = indent_at_start {
        let ias = ias as isize;
        if ias > lw - 2.max(mcw) {
            folds.push(0);
        } else {
            end = lw - ias;
        }
    }
    let mut split: Option<isize> = None;
    let mut prev: Option<u16> = None;
    let mut overflow = false;
    let mut i: isize = -1;
    let mut esc_start: isize = -1;
    let mut esc_end: isize = -1;
    if mode == Fold::Block {
        i = consume_more_indented_lines(text, i, ind_len);
        if i != -1 {
            end = i + end_step;
        }
    }
    loop {
        i += 1;
        let Some(mut ch) = ch_at(i) else { break };
        if mode == Fold::Quoted && ch == BS {
            esc_start = i;
            match ch_at(i + 1).map(|c| c as u8 as char) {
                Some('x') => i += 3,
                Some('u') => i += 5,
                Some('U') => i += 9,
                _ => i += 1,
            }
            esc_end = i;
        }
        if ch == NL {
            if mode == Fold::Block {
                i = consume_more_indented_lines(text, i, ind_len);
            }
            end = i + ind_len + end_step;
            split = None;
        } else {
            if ch == SP && prev.is_some_and(|p| p != SP && p != NL && p != TAB) {
                // A space between two non-spaces can become a newline and indent.
                let next = ch_at(i + 1);
                if next.is_some_and(|n| n != SP && n != NL && n != TAB) {
                    split = Some(i);
                }
            }
            if i >= end {
                if let Some(sp) = split.filter(|s| *s != 0) {
                    folds.push(sp);
                    end = sp + end_step;
                    split = None;
                } else if mode == Fold::Quoted {
                    // Whitespace collected at the end may run past the line width.
                    let mut cur = Some(ch);
                    while prev == Some(SP) || prev == Some(TAB) {
                        prev = cur;
                        i += 1;
                        cur = ch_at(i);
                        overflow = true;
                    }
                    // Account for the newline escape, but don't break the escape before it.
                    let j = if i > esc_end + 1 { i - 2 } else { esc_start - 1 };
                    if escaped_folds.contains(&j) {
                        return text.to_vec();
                    }
                    folds.push(j);
                    escaped_folds.insert(j);
                    end = j + end_step;
                    split = None;
                    // `prev = ch` with ch undefined ends the loop at its next read.
                    let Some(c) = cur else { break };
                    ch = c;
                } else {
                    overflow = true;
                }
            }
        }
        prev = Some(ch);
    }
    if overflow {
        if let Some(o) = on_overflow {
            *o = true;
        }
    }
    if folds.is_empty() {
        return text.to_vec();
    }
    let ind = u(indent);
    let slice = |a: isize, b: isize| -> &[u16] {
        let a = a.clamp(0, len) as usize;
        let b = b.clamp(0, len) as usize;
        if a < b { &text[a..b] } else { &[] }
    };
    let mut res: U16s = slice(0, folds[0]).to_vec();
    for (k, &f) in folds.iter().enumerate() {
        let e = match folds.get(k + 1) {
            Some(&n) if n != 0 => n,
            _ => len,
        };
        if f == 0 {
            res = [vec![NL], ind.clone(), slice(0, e).to_vec()].concat();
        } else {
            if mode == Fold::Quoted && escaped_folds.contains(&f) {
                if let Some(c) = ch_at(f) {
                    res.push(c);
                }
                res.push(BS);
            }
            res.push(NL);
            res.extend_from_slice(&ind);
            res.extend_from_slice(slice(f + 1, e));
        }
    }
    res
}

/// Presumes `i + 1` is at the start of a line; returns the index of the last newline in a more-indented block.
fn consume_more_indented_lines(text: &[u16], mut i: isize, indent: isize) -> isize {
    let len = text.len() as isize;
    let ch_at = |i: isize| if i >= 0 && i < len { Some(text[i as usize]) } else { None };
    let mut end = i;
    let mut start = i + 1;
    let mut ch = ch_at(start);
    while ch == Some(SP) || ch == Some(TAB) {
        if i < start + indent {
            i += 1;
            ch = ch_at(i);
        } else {
            loop {
                i += 1;
                ch = ch_at(i);
                if !(ch.is_some() && ch != Some(NL)) {
                    break;
                }
            }
            end = i;
            start = i + 1;
            ch = ch_at(start);
        }
    }
    end
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn y(v: Value) -> String {
        stringify_map(v.as_object().unwrap())
    }

    #[test]
    fn plain_and_quoted_scalars() {
        assert_eq!(y(json!({"a": "x", "n": 1, "f": 1.5, "b": true, "z": null})), "a: x\nn: 1\nf: 1.5\nb: true\nz: null\n");
        assert_eq!(y(json!({"num": "123", "empty": "", "yes": "yes", "t": "true"})), "num: \"123\"\nempty: \"\"\nyes: yes\nt: \"true\"\n");
        assert_eq!(y(json!({"title": "Fix: login: \"broken\" on #phone"})), "title: 'Fix: login: \"broken\" on #phone'\n");
        assert_eq!(y(json!({"at": "2026-11-15T08:00:00.000Z"})), "at: 2026-11-15T08:00:00.000Z\n");
    }

    #[test]
    fn collections() {
        assert_eq!(y(json!({"tags": ["ui", "x"], "e": [], "o": {}})), "tags:\n  - ui\n  - x\ne: []\no: {}\n");
        assert_eq!(y(json!({"prs": [{"a": 1, "b": [1, 2]}, [3]]})), "prs:\n  - a: 1\n    b:\n      - 1\n      - 2\n  - - 3\n");
        assert_eq!(y(json!({})), "{}\n");
    }

    #[test]
    fn multi_line_strings_are_blocks() {
        assert_eq!(y(json!({"m": "a\nb"})), "m: |-\n  a\n  b\n");
        assert_eq!(y(json!({"m": "a\nb\n"})), "m: |\n  a\n  b\n");
    }

    #[test]
    fn long_plain_strings_fold() {
        let long = "word ".repeat(30);
        let long = long.trim_end();
        let out = y(json!({ "title": long }));
        assert!(out.lines().all(|l| l.len() <= 80), "{out}");
        assert!(out.starts_with("title: word"));
    }
}
