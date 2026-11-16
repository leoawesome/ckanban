//! The ⌘K command bar's ticket rows (`src/board/cmdbar.ts`, ranking from `web/src/lib/fuzzy.ts`): every open ticket on
//! every board, and a search of the Done ones that sends only the best few. Positions and lengths count UTF-16 units,
//! as in JavaScript.

use std::cmp::Ordering;

use serde_json::{Map, Value, json};

use super::store::BoardList;
use super::text::{is_space, len16, slice16};
use super::ticket::Tk;

pub const CMD_SEARCH_LIMIT: usize = 20;
const CHUNK: usize = 250;

/// Long texts are capped at 4000 units.
pub fn cap(s: &str) -> String {
    if len16(s) > 4000 { slice16(s, 4000).to_string() } else { s.to_string() }
}

/// One bar row (`CmdRow`).
#[derive(Clone, Debug)]
pub struct CmdRow {
    pub profile: String,
    pub profile_name: Value,
    pub id: String,
    pub title: String,
    pub status: String,
    pub running: bool,
    pub updated_at: String,
    pub body: String,
    pub summary: String,
    pub pr_url: Value,
    /// Set for a hidden tool ticket: its main ticket (None inside: it has none).
    pub main_ticket: Option<Option<(String, String)>>,
}

impl CmdRow {
    pub fn new(slug: &str, name: &Value, t: &Tk, running: bool, summary: Option<String>) -> CmdRow {
        CmdRow {
            profile: slug.to_string(),
            profile_name: name.clone(),
            id: t.id.clone(),
            title: t.title.clone(),
            status: t.status.clone(),
            running,
            updated_at: t.updated_at.clone(),
            body: cap(&t.body),
            summary: cap(summary.as_deref().unwrap_or("")),
            pr_url: t.get("prUrl").cloned().unwrap_or(Value::Null),
            main_ticket: None,
        }
    }

    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("profile".into(), self.profile.clone().into());
        m.insert("profileName".into(), self.profile_name.clone());
        m.insert("id".into(), self.id.clone().into());
        m.insert("title".into(), self.title.clone().into());
        m.insert("status".into(), self.status.clone().into());
        m.insert("running".into(), self.running.into());
        m.insert("updatedAt".into(), self.updated_at.clone().into());
        m.insert("body".into(), self.body.clone().into());
        m.insert("summary".into(), self.summary.clone().into());
        m.insert("prUrl".into(), self.pr_url.clone());
        if let Some(mt) = &self.main_ticket {
            m.insert("mainTicket".into(), mt.as_ref().map(|(id, title)| json!({ "id": id, "title": title })).unwrap_or(Value::Null));
        }
        Value::Object(m)
    }
}

/// A hidden tool ticket stands for its main ticket's card (`withMain`): up to the first main ticket, else the top.
pub fn with_main(mut row: CmdRow, t: &Tk, list: &BoardList) -> CmdRow {
    if !t.tool {
        return row;
    }
    let mut seen = std::collections::HashSet::new();
    let mut cur: Option<&Tk> = Some(t);
    let mut top: &Tk = t;
    while let Some(c) = cur {
        if !seen.insert(c.id.clone()) {
            break;
        }
        if c.main {
            top = c;
            break;
        }
        top = c;
        cur = c.parent_link().and_then(|(p, _)| list.get(p)).map(|a| &**a);
    }
    row.main_ticket = Some((top.id != t.id).then(|| (top.id.clone(), top.title.clone())));
    row
}

// ---- fuzzy.ts ----

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// JS `toLowerCase()` as UTF-16 units.
fn lower16(s: &str) -> Vec<u16> {
    units(&s.to_lowercase())
}

/// JS `\W` for one UTF-16 unit.
fn non_word(u: u16) -> bool {
    !(u < 128 && ((u as u8).is_ascii_alphanumeric() || u == b'_' as u16))
}

fn index_of(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(hay.len()));
    }
    if needle.len() > hay.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// `fuzzyMatch`: (score, matched positions); None when the letters aren't there in order.
pub fn fuzzy_match(text: &str, query: &str) -> Option<(f64, Vec<usize>)> {
    let t = lower16(text);
    let q: Vec<u16> = units(&query.to_lowercase().chars().filter(|c| !is_space(*c)).collect::<String>());
    if q.is_empty() {
        return Some((0.0, vec![]));
    }
    if let Some(d) = index_of(&t, &q, 0) {
        let at = (0..q.len()).map(|i| d + i).collect();
        let score = if d == 0 || non_word(t[d - 1]) { -1000.0 + d as f64 } else { -500.0 + d as f64 };
        return Some((score, at));
    }
    let mut score = 0.0;
    let mut last: isize = -1;
    let mut at = Vec::new();
    for &ch in &q {
        let from = (last + 1) as usize;
        let i = t.iter().skip(from).position(|&c| c == ch)? + from;
        score += (i as isize - last - 1) as f64;
        at.push(i);
        last = i as isize;
    }
    Some((score, at))
}

fn match_tier(score: f64) -> u8 {
    if score < -500.0 {
        0
    } else if score < 0.0 {
        1
    } else {
        2
    }
}

/// `findSnippet`'s score only (the ranking needs no text): the query's words as a phrase, any whitespace between.
fn snippet_score(text: &str, query: &str) -> Option<f64> {
    let words: Vec<&str> = query.split(is_space).filter(|w| !w.is_empty()).collect();
    if words.is_empty() || text.is_empty() {
        return None;
    }
    let pattern = format!("(?i){}", words.iter().map(|w| regex::escape(w)).collect::<Vec<_>>().join(r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]+"));
    let re = regex::Regex::new(&pattern).ok()?;
    let m = re.find(text)?;
    let start16 = len16(&text[..m.start()]);
    let word_start = start16 == 0 || text[..m.start()].chars().last().is_some_and(|c| !(c.is_ascii_alphanumeric() || c == '_'));
    Some(if word_start { -1000.0 } else { -500.0 } + start16.min(499) as f64)
}

fn pr_number(url: &Value) -> Option<String> {
    let s = url.as_str()?;
    let at = s.find("/pull/")?;
    let digits: String = s[at + 6..].chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty()).then_some(digits)
}

/// `otherMatch`'s score: the PR number, then the result summary, then the description.
fn other_score(row: &CmdRow, query: &str) -> Option<f64> {
    let q = super::text::js_trim(query);
    let num = q.strip_prefix('#').unwrap_or(q);
    if let Some(pr) = pr_number(&row.pr_url) {
        if !num.is_empty() && num.chars().all(|c| c.is_ascii_digit()) && pr == num {
            return Some(-2000.0);
        }
    }
    let mut best: Option<f64> = None;
    for text in [&row.summary, &row.body] {
        if let Some(s) = snippet_score(text, query) {
            if best.is_none_or(|b| match_tier(s) < match_tier(b)) {
                best = Some(s);
            }
        }
    }
    best
}

/// `rankTickets`: the best `limit` rows for the query (title first, then PR, summary, description, then title letters
/// in order; the current board first within a kind).
pub fn rank(rows: Vec<CmdRow>, query: &str, current: Option<&str>, limit: usize) -> Vec<CmdRow> {
    let here = |r: &CmdRow| if Some(r.profile.as_str()) == current { 0 } else { 1 };
    if super::text::js_trim(query).is_empty() {
        let mut v: Vec<CmdRow> = rows.into_iter().filter(|r| r.status != "done").collect();
        v.sort_by(|a, b| here(a).cmp(&here(b)).then((b.running as u8).cmp(&(a.running as u8))).then(b.updated_at.cmp(&a.updated_at)));
        v.truncate(limit);
        return v;
    }
    let mut hits: Vec<(u8, f64, CmdRow)> = Vec::new();
    for row in rows {
        let m = fuzzy_match(&row.title, query);
        let tier = m.as_ref().map(|(s, _)| match_tier(*s));
        if let (Some((s, _)), Some(t)) = (&m, tier) {
            if t != 2 {
                hits.push((t, *s, row));
                continue;
            }
        }
        if let Some(s) = other_score(&row, query) {
            hits.push((2, s, row));
        } else if let Some((s, _)) = m {
            hits.push((3, s, row));
        }
    }
    hits.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(here(&a.2).cmp(&here(&b.2)))
            .then(a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal))
            .then(b.2.updated_at.cmp(&a.2.updated_at))
    });
    hits.truncate(limit);
    hits.into_iter().map(|h| h.2).collect()
}

/// `searchDone`'s chunked ranking over one board's Done rows (each chunk's best join the best so far).
pub struct DoneSearch<'a> {
    pub query: &'a str,
    pub current: Option<&'a str>,
    pub n: usize,
    pub best: Vec<CmdRow>,
}

impl DoneSearch<'_> {
    /// A chunk of rows with their tickets, from one board's listing.
    pub fn flush(&mut self, chunk: Vec<(CmdRow, &Tk)>, list: &BoardList) {
        if chunk.is_empty() {
            return;
        }
        let ids: Vec<String> = chunk.iter().map(|(r, _)| r.id.clone()).collect();
        let rows: Vec<CmdRow> = chunk.iter().map(|(r, _)| r.clone()).collect();
        let top: Vec<CmdRow> = rank(rows, self.query, self.current, self.n * 2)
            .into_iter()
            .filter_map(|r| {
                let at = ids.iter().position(|i| *i == r.id)?;
                let row = with_main(r, chunk[at].1, list);
                (row.main_ticket != Some(None)).then_some(row)
            })
            .collect();
        let mut all = std::mem::take(&mut self.best);
        all.extend(top);
        self.best = rank(all, self.query, self.current, self.n);
    }

    pub fn chunk_size() -> usize {
        CHUNK
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_like_bun() {
        assert_eq!(fuzzy_match("Fix login", "login").map(|m| m.0), Some(-996.0));
        assert_eq!(fuzzy_match("Relogin", "login").map(|m| m.0), Some(-498.0));
        assert_eq!(fuzzy_match("Fix login", "fl").map(|m| m.0), Some(3.0));
        assert_eq!(fuzzy_match("abc", "zz"), None);
        assert_eq!(snippet_score("the quick  brown fox", "quick brown"), Some(-996.0));
        assert_eq!(cap(&"é".repeat(4001)).chars().count(), 4000);
    }
}
