//! A summary's text and the rows its page shows (`src/helper/summary.ts`), and the weekly recap line. Pure.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::local;
use super::text::cut;
use crate::index::text::fixed2;
use crate::runs::js::{self, trim};

pub const STALE_MS: f64 = 3.0 * 24.0 * 3600_000.0;
pub const ROW_MAX: usize = 100;
pub const LABEL_MAX: usize = 80;

/// One item as the runner hands it in.
#[derive(Clone, Debug)]
pub struct SummaryInput {
    pub key: Option<String>,
    pub board: String,
    pub board_name: String,
    pub ticket_id: String,
    pub title: String,
    pub label: String,
    pub since: String,
}

static STAMP: LazyLock<Regex> = LazyLock::new(|| {
    let w = js::WS;
    Regex::new(&format!(r"^(.*[^{inner}]){w}+[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}(?:[ T][0-9]{{1,2}}:[0-9]{{2}})?$", inner = &w[1..w.len() - 1])).expect("stamp")
});

/// A repeating schedule's title without its date and time, or None.
pub fn title_stem(title: &str) -> Option<String> {
    STAMP.captures(trim(title)).map(|c| c[1].to_string())
}

fn row(i: &SummaryInput, count: Option<usize>) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("key".into(), i.key.clone().map(Value::String).unwrap_or(Value::Null));
    m.insert("board".into(), i.board.clone().into());
    m.insert("boardName".into(), i.board_name.clone().into());
    m.insert("ticketId".into(), i.ticket_id.clone().into());
    m.insert("title".into(), i.title.clone().into());
    m.insert("label".into(), cut(&i.label, LABEL_MAX).into());
    m.insert("since".into(), i.since.clone().into());
    if let Some(n) = count.filter(|n| *n > 0) {
        m.insert("count".into(), (n as u64).into());
    }
    m
}

fn lower(s: &str) -> String {
    let mut c = s.chars();
    match (c.next(), c.next()) {
        (Some(a), Some(b)) if a.is_ascii_uppercase() && b.is_ascii_lowercase() => format!("{}{}", a.to_ascii_lowercase(), &s[1..]),
        _ => s.to_string(),
    }
}

/// New items as rows, runs of one repeating schedule on one board merged.
pub fn collapse_runs(items: &[SummaryInput]) -> Vec<Map<String, Value>> {
    let mut groups: HashMap<String, Vec<&SummaryInput>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (n, it) in items.iter().enumerate() {
        let k = match title_stem(&it.title) {
            Some(stem) => format!("{}\u{0}{stem}", it.board),
            None => format!("#{n}"),
        };
        if !groups.contains_key(&k) {
            order.push(k.clone());
        }
        groups.entry(k).or_default().push(it);
    }
    let mut out = Vec::new();
    for k in order {
        let g = &groups[&k];
        let mut tickets: Vec<&str> = Vec::new();
        for i in g {
            if !tickets.contains(&i.ticket_id.as_str()) {
                tickets.push(&i.ticket_id);
            }
        }
        if tickets.len() < 2 {
            out.extend(g.iter().map(|i| row(i, None)));
            continue;
        }
        let mut sorted = g.clone();
        sorted.sort_by(|a, b| b.since.cmp(&a.since));
        let newest = sorted[0];
        let mut labels: Vec<String> = Vec::new();
        for i in g {
            let l = trim(&i.label).to_lowercase();
            if !labels.contains(&l) {
                labels.push(l);
            }
        }
        let n = tickets.len();
        let what = if labels.len() == 1 { format!("{n} runs {}", lower(trim(&g[0].label))) } else { format!("{n} runs wait on you") };
        let mut r = row(newest, Some(n));
        r.insert("title".into(), title_stem(&newest.title).unwrap_or_default().into());
        r.insert("label".into(), what.into());
        out.push(r);
    }
    out
}

/// "12 Oct" (this Mac's time zone).
pub fn short_date(iso: &str) -> String {
    let ms = ckanban_core::time::parse_date(iso).unwrap_or(f64::NAN);
    if ms.is_nan() {
        return "NaN Invalid Date".into();
    }
    let p = local::parts(ms);
    format!("{} {}", p.day, local::month_short(p.month0))
}

pub fn still_line(count: usize, oldest_at: Option<&str>, more: bool) -> String {
    let verb = if count == 1 { "waits" } else { "wait" };
    let oldest = oldest_at.map(|o| format!(", oldest from {}", short_date(o))).unwrap_or_default();
    format!("{count}{} still {verb} on you{oldest}.", if more { " more" } else { "" })
}

pub fn older_line(count: usize) -> String {
    format!("+{count} older in Inbox")
}

pub struct SummaryBuild {
    pub headline: String,
    pub fresh: Vec<SummaryInput>,
    pub still: Vec<SummaryInput>,
    pub checkins: Vec<SummaryInput>,
    pub older_checkins: usize,
    pub notes: Vec<String>,
    pub boards: bool,
    pub now: f64,
}

fn since_ms(s: &str) -> f64 {
    ckanban_core::time::parse_date(s).unwrap_or(f64::NAN)
}

fn rs<'a>(r: &'a Map<String, Value>, k: &str) -> &'a str {
    r.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The summary's text and its page view.
pub fn build_summary(b: &SummaryBuild) -> (String, Value) {
    let is_stale = |i: &SummaryInput| b.now - since_ms(&i.since) > STALE_MS;
    let stale: Vec<SummaryInput> = b.fresh.iter().filter(|i| is_stale(i)).cloned().collect();
    let listed: Vec<SummaryInput> = b.fresh.iter().filter(|i| !is_stale(i)).cloned().collect();
    let fresh = collapse_runs(&listed);
    let mut all: Vec<Map<String, Value>> = stale.iter().chain(b.still.iter()).map(|i| row(i, None)).collect();
    all.sort_by(|a, c| rs(a, "since").cmp(rs(c, "since")));
    let still: Vec<Map<String, Value>> = all.iter().filter(|r| !(b.now - since_ms(rs(r, "since")) > STALE_MS)).cloned().collect();
    let older_count = all.len() - still.len();
    let oldest_at = still.iter().map(|r| rs(r, "since")).find(|s| !s.is_empty() && since_ms(s).is_finite()).map(str::to_string);
    let checkins: Vec<Map<String, Value>> = b.checkins.iter().map(|i| row(i, None)).collect();
    let arr = |v: &[Map<String, Value>]| Value::Array(v.iter().cloned().map(Value::Object).collect());
    let mut view = Map::new();
    view.insert("new".into(), arr(&fresh));
    view.insert("still".into(), arr(&still));
    view.insert("stillCount".into(), (still.len() as u64).into());
    view.insert("oldestAt".into(), oldest_at.clone().map(Value::String).unwrap_or(Value::Null));
    view.insert("olderCount".into(), (older_count as u64).into());
    view.insert("checkins".into(), arr(&checkins));
    view.insert("olderCheckins".into(), (b.older_checkins as u64).into());
    view.insert("notes".into(), Value::Array(b.notes.iter().cloned().map(Value::String).collect()));
    view.insert("grouped".into(), b.boards.into());
    let line = |r: &Map<String, Value>| format!("- {}", cut(&format!("{}: {}", rs(r, "title"), rs(r, "label")), ROW_MAX));
    let block = |rows: &[Map<String, Value>]| -> Vec<String> {
        if b.boards {
            let mut groups: Vec<(String, String, Vec<&Map<String, Value>>)> = Vec::new();
            for r in rows {
                match groups.iter_mut().find(|g| g.0 == rs(r, "board")) {
                    Some(g) => g.2.push(r),
                    None => groups.push((rs(r, "board").into(), rs(r, "boardName").into(), vec![r])),
                }
            }
            groups.into_iter().map(|(_, name, rows)| std::iter::once(name).chain(rows.into_iter().map(line)).collect::<Vec<_>>().join("\n")).collect()
        } else {
            vec![rows.iter().map(line).collect::<Vec<_>>().join("\n")]
        }
    };
    let mut parts: Vec<String> = vec![b.headline.clone()];
    if !fresh.is_empty() {
        parts.extend(block(&fresh));
    }
    let mut waiting = Vec::new();
    if !still.is_empty() {
        waiting.push(still_line(still.len(), oldest_at.as_deref(), !fresh.is_empty()));
    }
    if older_count > 0 {
        waiting.push(older_line(older_count));
    }
    if !waiting.is_empty() {
        parts.push(waiting.join("\n"));
    }
    if !checkins.is_empty() || b.older_checkins > 0 {
        let mut rows: Vec<String> = checkins.iter().map(line).collect();
        if b.older_checkins > 0 {
            rows.push(format!("+{} older from check-ins", b.older_checkins));
        }
        parts.push(std::iter::once("From your check-ins:".to_string()).chain(rows).collect::<Vec<_>>().join("\n"));
    }
    parts.extend(b.notes.iter().cloned());
    let text = parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n");
    (text, Value::Object(view))
}

/// Monday 00:00 (local time) of the week `now` is in.
pub fn week_start(now: f64) -> f64 {
    let p = local::parts(now);
    let back = (p.weekday + 6) % 7;
    local::make(p.year, p.month0 as i64, p.day as i64 - back as i64, 0, 0)
}

fn truthy_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// "Last week: 2 urgent alerts, 31 held into summaries, helper $6.10", or None.
pub fn week_recap_line(records: &[Value], helper_days: &HashMap<String, f64>, now: f64) -> Option<String> {
    let end = week_start(now);
    let ws = local::parts(end);
    let start = local::make(ws.year, ws.month0 as i64, ws.day as i64 - 7, 0, 0);
    let in_week = |t: f64| t.is_finite() && t >= start && t < end;
    let (mut urgent, mut held) = (0usize, 0usize);
    for r in records {
        let reached: Vec<f64> = r
            .get("reminders")
            .and_then(Value::as_array)
            .map(|a| a.as_slice())
            .unwrap_or(&[])
            .iter()
            .filter(|x| truthy_str(x.get("sentAt")).is_some() && !js::truthy(x.get("failed")) && !js::truthy(x.get("skipped")))
            .map(|x| since_ms(truthy_str(x.get("sentAt")).unwrap_or("")))
            .filter(|t| t.is_finite())
            .collect();
        if !reached.is_empty() {
            if in_week(reached.iter().cloned().fold(f64::INFINITY, f64::min)) {
                urgent += 1;
            }
        } else if matches!(r.get("toldVia").and_then(Value::as_str), Some("helper" | "digest"))
            && let Some(t) = truthy_str(r.get("toldAt"))
            && in_week(since_ms(t))
        {
            held += 1;
        }
    }
    let mut spend = 0.0;
    for i in 0..7 {
        let day = ckanban_core::time::day_key(local::make(ws.year, ws.month0 as i64, ws.day as i64 - 7 + i, 0, 0));
        spend += helper_days.get(&day).copied().unwrap_or(0.0);
    }
    let paid = spend >= 0.005;
    if urgent == 0 && held == 0 && !paid {
        return None;
    }
    let mut parts = vec![format!("{urgent} urgent alert{}", if urgent == 1 { "" } else { "s" }), format!("{held} held into summaries")];
    if paid {
        parts.push(format!("helper ${}", fixed2(spend)));
    }
    Some(format!("Last week: {}", parts.join(", ")))
}
