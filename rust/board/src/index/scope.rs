//! Which tickets a board answer carries (`src/board/ticket-scope.ts`), with the Done column's order from
//! `web/src/features/board/columns.ts` and its fingerprint from `donePaging.ts`: the board's first load (unfinished
//! work with whole families), Done pages, the Done search, tickets by id, list_tickets' pages and the count.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use super::store::BoardList;
use super::ticket::Tk;

pub const DONE_PAGE: usize = 20;
pub const SEARCH_LIMIT: usize = 100;
pub const LIST_PAGE: usize = 100;
pub const LIST_MAX: usize = 500;

/// Each ticket's family key and the Done column, worked out once per listing (`scopeIndex`).
pub struct ScopeIndex {
    /// Family key (its top ticket's id) by ticket index.
    pub keys: Vec<String>,
    /// The Done column, in its order (indices).
    pub column: Vec<usize>,
}

impl ScopeIndex {
    pub fn build(list: &BoardList) -> ScopeIndex {
        ScopeIndex { keys: family_keys(list), column: done_column(list) }
    }
}

/// `familyKeys`: each ticket's top ticket id; a loop in old data stops the walk.
fn family_keys(list: &BoardList) -> Vec<String> {
    let n = list.tickets.len();
    let mut out: Vec<Option<String>> = vec![None; n];
    for start in 0..n {
        if out[start].is_some() {
            continue;
        }
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = start;
        let root;
        loop {
            if let Some(hit) = &out[cur] {
                root = hit.clone();
                break;
            }
            path.push(cur);
            seen.insert(cur);
            let t = list.at(cur);
            let up = t.parent_link().filter(|(id, _)| *id != t.id).and_then(|(id, _)| list.idx(id));
            match up {
                Some(u) if !seen.contains(&u) => cur = u,
                _ => {
                    root = list.at(cur).id.clone();
                    break;
                }
            }
        }
        for p in path {
            out[p] = Some(root.clone());
        }
    }
    out.into_iter().map(|k| k.unwrap_or_default()).collect()
}

/// `waitsForSlot` for a ticket from its file.
fn waits_for_slot(t: &Tk) -> bool {
    t.status == "in_progress" && t.slot_wait.is_some() && !t.is("running")
}

/// `byPlace`: pinned first (newest pin first), then replies waiting for a slot (oldest first), then `order`.
pub fn by_place(a: &Tk, b: &Tk) -> Ordering {
    if a.pinned_at.is_some() || b.pinned_at.is_some() {
        match (&a.pinned_at, &b.pinned_at) {
            (None, _) => return Ordering::Greater,
            (_, None) => return Ordering::Less,
            (Some(x), Some(y)) => {
                let newer = y.cmp(x);
                if newer != Ordering::Equal {
                    return newer;
                }
            }
        }
    }
    match (&a.slot_wait, &b.slot_wait) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        _ => a.order.partial_cmp(&b.order).unwrap_or(Ordering::Equal),
    }
}

/// The column a ticket from its file sits in (`groupByColumn`'s pick; files carry no live family counts).
pub fn column_of(t: &Tk) -> &str {
    if waits_for_slot(t) {
        return "ready";
    }
    let family_busy = t.main
        && ((t.is("familyWorking") && (t.status == "review" || t.status == "planning")) || (t.is("stepsRunning") && (t.status == "done" || t.status == "backlog")));
    if family_busy { "in_progress" } else { &t.status }
}

/// `doneColumn`: finished tickets with a card, in the column's order.
fn done_column(list: &BoardList) -> Vec<usize> {
    let mut v: Vec<usize> = (0..list.tickets.len())
        .filter(|&i| {
            let t = list.at(i);
            t.status == "done" && t.on_board() && column_of(t) == "done"
        })
        .collect();
    v.sort_by(|&a, &b| by_place(list.at(a), list.at(b)));
    v
}

/// `doneIdsHash`: FNV-1a over the ids' UTF-16 units, a newline after each.
pub fn done_ids_hash<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    let mut h: u32 = 0x811c9dc5;
    let mut n = 0;
    for id in ids {
        n += 1;
        for u in id.encode_utf16() {
            h = (h ^ u as u32).wrapping_mul(0x01000193);
        }
        h = (h ^ 10).wrapping_mul(0x01000193);
    }
    format!("{n}:{}", radix36(h))
}

fn radix36(mut x: u32) -> String {
    if x == 0 {
        return "0".into();
    }
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while x > 0 {
        out.push(digits[(x % 36) as usize]);
        x /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// A scope's answer: tickets (indices, board order) and the Done column's size.
pub struct Picked {
    pub tickets: Vec<usize>,
    pub done_total: usize,
    /// scope=board with `after`: Some(None) when that card isn't in Done now.
    pub done_head: Option<Option<String>>,
}

/// These tickets and everyone in their families, in board order.
fn with_families(list: &BoardList, wanted: impl Iterator<Item = usize>) -> Vec<usize> {
    let keys = &list.scope().keys;
    let fams: HashSet<&str> = wanted.map(|i| keys[i].as_str()).collect();
    (0..list.tickets.len()).filter(|&i| fams.contains(keys[i].as_str())).collect()
}

/// The board's first load (`boardScope`).
pub fn board_scope(list: &BoardList, done: f64, ids: &[String], after: Option<&str>) -> Picked {
    let column = &list.scope().column;
    let done_head = after.map(|a| column.iter().position(|&i| list.at(i).id == a).map(|h| done_ids_hash(column[..=h].iter().map(|&i| list.at(i).id.as_str()))));
    let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let wanted = (0..list.tickets.len()).filter(|&i| list.at(i).status != "done" || ids.contains(list.at(i).id.as_str()));
    let mut picked: HashSet<usize> = with_families(list, wanted).into_iter().collect();
    let take = if done.is_finite() && done > 0.0 { done.floor() as usize } else if done == f64::INFINITY { usize::MAX } else { 0 };
    for &i in column.iter().take(take) {
        picked.insert(i);
    }
    Picked { tickets: (0..list.tickets.len()).filter(|i| picked.contains(i)).collect(), done_total: column.len(), done_head }
}

/// A page of the Done column (`donePage`).
pub fn done_page(list: &BoardList, offset: f64, limit: f64, after: Option<&str>) -> Picked {
    let column = &list.scope().column;
    let at = after.and_then(|a| column.iter().position(|&i| list.at(i).id == a));
    let from = match at {
        Some(a) => a + 1,
        None => {
            let f = offset.floor();
            if f.is_finite() && f > 0.0 { f as usize } else { 0 }
        }
    };
    // slice(from, from + max(1, min(limit, 200))): the end is cut to a whole number.
    let n = if limit.is_nan() { 1 } else { limit.clamp(1.0, 200.0).floor() as usize };
    let tickets = column.iter().skip(from).take(n).copied().collect();
    Picked { tickets, done_total: column.len(), done_head: None }
}

/// The Done search (`doneSearch`): text in the title or description, any of the tags; newest matches first.
pub fn done_search(list: &BoardList, text: &str, tags: &[String]) -> Picked {
    let q = crate::index::text::js_trim(text).to_lowercase();
    let column = &list.scope().column;
    if q.is_empty() && tags.is_empty() {
        return Picked { tickets: vec![], done_total: column.len(), done_head: None };
    }
    let hit = |t: &Tk| (q.is_empty() || format!("{}\n{}", t.title, t.body).to_lowercase().contains(&q)) && t.has_tags(tags);
    let found: Vec<usize> = (0..list.tickets.len()).filter(|&i| list.at(i).status == "done" && hit(list.at(i))).collect();
    let found = &found[found.len().saturating_sub(SEARCH_LIMIT)..];
    let hidden: Vec<usize> = found.iter().copied().filter(|&i| !list.at(i).on_board()).collect();
    let shown: HashSet<usize> = found.iter().copied().filter(|&i| list.at(i).on_board()).collect();
    let families: HashSet<usize> = if hidden.is_empty() { HashSet::new() } else { with_families(list, hidden.into_iter()).into_iter().collect() };
    Picked { tickets: (0..list.tickets.len()).filter(|i| shown.contains(i) || families.contains(i)).collect(), done_total: column.len(), done_head: None }
}

/// These tickets with their families (`idsScope`).
pub fn ids_scope(list: &BoardList, ids: &[String]) -> Picked {
    let want: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let found: Vec<usize> = (0..list.tickets.len()).filter(|&i| want.contains(list.at(i).id.as_str())).collect();
    let tickets = if found.is_empty() { vec![] } else { with_families(list, found.into_iter()) };
    Picked { tickets, done_total: list.scope().column.len(), done_head: None }
}

pub struct ListQuery<'a> {
    pub status: Option<&'a str>,
    pub tool: bool,
    pub q: Option<&'a str>,
    pub tags: &'a [String],
    pub limit: f64,
    pub after: Option<&'a str>,
}

pub struct ListPage {
    pub tickets: Vec<usize>,
    pub total: usize,
    pub matched: usize,
    pub done_left: usize,
    pub next: Option<String>,
}

/// list_tickets' and `ticket list`'s page (`listScope`): newest first by id, going on after the last id.
pub fn list_scope(list: &BoardList, query: &ListQuery) -> ListPage {
    let q = crate::index::text::js_trim(query.q.unwrap_or("")).to_lowercase();
    let searching = !q.is_empty() || !query.tags.is_empty();
    let max = if searching { SEARCH_LIMIT } else { LIST_MAX };
    let lim = query.limit.floor();
    let limit = if lim.is_finite() && lim != 0.0 { lim } else { LIST_PAGE as f64 };
    let limit = limit.clamp(1.0, max as f64) as usize;
    let mut done_left = 0;
    let mut matched = Vec::new();
    let status = query.status.filter(|s| !s.is_empty());
    for &i in list.newest() {
        let t = list.at(i);
        if !query.tool && t.tool {
            continue;
        }
        let skip = match status {
            Some(s) => t.status != s,
            None => !searching && t.status == "done",
        };
        if skip {
            if status.is_none() && t.status == "done" {
                done_left += 1;
            }
            continue;
        }
        if !q.is_empty() && !format!("{}\n{}\n{}", t.id, t.title, t.body).to_lowercase().contains(&q) {
            continue;
        }
        if !query.tags.is_empty() && !t.has_tags(query.tags) {
            continue;
        }
        matched.push(i);
    }
    let pool: &[usize] = if searching { &matched[..matched.len().min(SEARCH_LIMIT)] } else { &matched };
    let after = query.after.filter(|a| !a.is_empty());
    let from = match after {
        Some(a) => pool.iter().position(|&i| list.at(i).id.as_str() < a),
        None => Some(0),
    };
    let (page, more) = match from {
        None => (vec![], false),
        Some(f) => (pool.iter().skip(f).take(limit).copied().collect::<Vec<_>>(), f + limit < pool.len()),
    };
    let next = if more { page.last().map(|&i| list.at(i).id.clone()) } else { None };
    ListPage { tickets: page, total: pool.len(), matched: matched.len(), done_left, next }
}

/// The board settings' count (`countScope`).
pub fn count_scope(list: &BoardList) -> (usize, usize, usize) {
    let open = list.tickets.iter().filter(|t| t.status != "done").count();
    (list.tickets.len(), open, list.scope().column.len())
}

/// Indices by id, for answers that look tickets up.
pub fn by_id(list: &BoardList, idx: &[usize]) -> HashMap<String, usize> {
    idx.iter().map(|&i| (list.at(i).id.clone(), i)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::family::tests::board;
    use serde_json::json;

    #[test]
    fn hash_like_bun() {
        // doneIdsHash(["a", "b"]) and doneIdsHash([]) as Bun computes them.
        assert_eq!(done_ids_hash(["a", "b"].into_iter()), "2:xw31f2");
        assert_eq!(done_ids_hash(std::iter::empty()), "0:ztntfp");
        assert_eq!(done_ids_hash(["t_20261116_abcd", "é😀"].into_iter()), "2:1a8wjdy");
    }

    #[test]
    fn scopes() {
        let mut v = vec![
            json!({"id": "t_1", "title": "Open", "status": "review", "order": 1, "createdAt": "1"}),
            json!({"id": "t_2", "title": "Step", "status": "done", "order": 2, "createdAt": "2", "parentId": "t_1", "tool": true}),
        ];
        for i in 0..30 {
            v.push(json!({"id": format!("t_d{i:02}"), "title": format!("Done {i}"), "status": "done", "order": i, "createdAt": "3"}));
        }
        v.push(json!({"id": "t_p", "title": "Pinned", "status": "done", "order": 99, "createdAt": "4", "pinnedAt": "2026"}));
        let l = board(v);
        let ids = |p: &[usize]| p.iter().map(|&i| l.at(i).id.clone()).collect::<Vec<_>>();
        let b = board_scope(&l, 2.0, &[], Some("t_d00"));
        assert_eq!(ids(&b.tickets), ["t_1", "t_2", "t_d00", "t_p"]);
        assert_eq!(b.done_total, 31);
        assert!(matches!(b.done_head, Some(Some(_))));
        let p = done_page(&l, 0.0, 20.0, Some("t_d00"));
        assert_eq!(l.at(p.tickets[0]).id, "t_d01");
        assert_eq!(p.tickets.len(), 20);
        assert_eq!(ids(&done_search(&l, "pinned", &[]).tickets), ["t_p"]);
        assert_eq!(ids(&ids_scope(&l, &["t_2".into()]).tickets), ["t_1", "t_2"]);
        let page = list_scope(&l, &ListQuery { status: None, tool: false, q: None, tags: &[], limit: 0.0, after: None });
        assert_eq!(ids(&page.tickets), ["t_1"]);
        assert_eq!(page.done_left, 31);
        assert_eq!(count_scope(&l), (33, 1, 31));
    }
}
