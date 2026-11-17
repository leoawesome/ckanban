//! The family rules of `web/src/features/family/family.ts` the writes need (the read side is `index::family`):
//! loops, levels, where a ticket fits, open features and their groups, rounds, and `linkProblem`, the one check
//! behind every link (create, PATCH partOf, gather, own work).

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Map, Value};

use crate::index::family::{family_below, family_root, feature_root, feature_rows, parent_in};
use crate::index::store::BoardList;
use crate::index::ticket::Tk;

/// Deepest level a new link may make (the feature's top ticket is level 0).
pub const MAX_LEVEL: usize = 2;

/// `wouldLoop`: linking id under parent would make a ticket its own ancestor.
pub fn would_loop(list: &BoardList, id: &str, parent: &str) -> bool {
    let mut seen = HashSet::new();
    let mut cur = list.idx(parent);
    while let Some(c) = cur {
        let t = list.at(c);
        if t.id == id {
            return true;
        }
        if !seen.insert(c) {
            break;
        }
        cur = parent_in(list, t).map(|(p, _)| p);
    }
    parent == id
}

/// `levelOf`: 0 for the top ticket and any main ticket, 1 right under one, and so on (0 when not on the board).
pub fn level_of(list: &BoardList, id: &str) -> usize {
    let mut n = 0;
    let mut seen = HashSet::new();
    let mut cur = list.idx(id);
    while let Some(c) = cur {
        if !seen.insert(c) {
            break;
        }
        let t = list.at(c);
        if t.main {
            return n;
        }
        match parent_in(list, t) {
            Some((p, _)) => cur = Some(p),
            None => return n,
        }
        n += 1;
    }
    n
}

/// `fitParent`: id, or its nearest ancestor that leaves room under it (never past a main ticket).
pub fn fit_parent(list: &BoardList, id: &str) -> String {
    let mut seen = HashSet::new();
    let mut cur = list.idx(id);
    while let Some(c) = cur {
        if seen.contains(&c) || level_of(list, &list.at(c).id) < MAX_LEVEL {
            break;
        }
        seen.insert(c);
        match parent_in(list, list.at(c)) {
            Some((p, _)) => cur = Some(p),
            None => break,
        }
    }
    cur.map(|c| list.at(c).id.clone()).unwrap_or_else(|| id.to_string())
}

/// `isFeature`: a feature's top ticket that isn't Done, with a status or 2+ others in its own feature.
pub fn is_feature(list: &BoardList, top: &Tk) -> bool {
    if top.status == "done" || feature_root(list, &top.id).map(|i| list.at(i).id.as_str()) != Some(top.id.as_str()) {
        return false;
    }
    top.is("statusAt") || feature_rows(list, &top.id).len() >= 3
}

/// `groupsOf`: a feature's level-1 tickets of kind group or round, oldest first.
pub fn groups_of(list: &BoardList, top_id: &str) -> Vec<usize> {
    list.kids().of(top_id).iter().map(|&(i, _)| i).filter(|&i| matches!(list.at(i).kind.as_deref(), Some("group" | "round"))).collect()
}

/// `nextRoundTitle`: "Testing round N", one more than the highest round number in topId's feature.
pub fn next_round_title(list: &BoardList, top_id: Option<&str>) -> String {
    let rows = top_id.map(|t| feature_rows(list, t)).unwrap_or_default();
    let n = rows.iter().map(|r| round_number(&list.at(r.idx).title)).fold(0.0_f64, f64::max);
    format!("Testing round {}", ckanban_core::jsnum::js_string(n + 1.0))
}

/// `/^testing round (\d+)\b/i` on a title: the number, else 0.
fn round_number(title: &str) -> f64 {
    const HEAD: &str = "testing round ";
    let Some(head) = title.get(..HEAD.len()) else { return 0.0 };
    if !head.eq_ignore_ascii_case(HEAD) {
        return 0.0;
    }
    let rest = &title[HEAD.len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return 0.0;
    }
    // `\b` after the digits: the next character isn't a word character.
    if rest[digits.len()..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
        return 0.0;
    }
    digits.parse::<f64>().unwrap_or(0.0)
}

/// `whereInstead`: the feature's top ticket or one of its groups.
fn where_instead(list: &BoardList, parent_id: &str) -> String {
    let Some(top) = feature_root(list, parent_id) else { return "under the feature's top ticket or one of its groups".into() };
    let t = list.at(top);
    let groups: Vec<String> = groups_of(list, &t.id).into_iter().map(|g| format!("\"{}\" ({})", list.at(g).title, list.at(g).id)).collect();
    let more = if groups.is_empty() { String::new() } else { format!(" or one of its groups: {}", groups.join(", ")) };
    format!("under the feature \"{}\" ({}){more}", t.title, t.id)
}

/// The ticket that moves, as it would be: a ticket on the board, or a new one (`main` only for a main ticket).
pub struct Moved<'a> {
    pub id: &'a str,
    pub title: &'a str,
    /// Some: the moved ticket's `main` as it would be (a new ticket, or `{ ...t, main: true }`).
    pub main: Option<bool>,
}

/// `tickets` with `moved` linked under parent by partOf (its plan link cleared), a new one added at the end.
fn simulate(list: &BoardList, moved: &Moved, parent: &str) -> BoardList {
    let set = |mut j: Map<String, Value>| {
        j.insert("title".into(), moved.title.into());
        if let Some(m) = moved.main {
            j.insert("main".into(), m.into());
        }
        j.insert("partOf".into(), parent.into());
        j.insert("parentId".into(), Value::Null);
        Arc::new(Tk::from_json(j, false))
    };
    let mut known = false;
    let mut out: Vec<Arc<Tk>> = list
        .tickets
        .iter()
        .map(|t| {
            if t.id == moved.id {
                known = true;
                set(t.json.clone())
            } else {
                t.clone()
            }
        })
        .collect();
    if !known {
        let mut j = Map::new();
        j.insert("status".into(), "backlog".into());
        j.insert("createdAt".into(), "9999".into());
        j.insert("id".into(), moved.id.into());
        out.push(set(j));
    }
    BoardList::new(&list.slug, out, 0)
}

/// `linkProblem`: why linking `moved` (and everything under it) under parent breaks the family rules, or None.
/// subtree false: only the moved ticket's own depth counts (gather moves deeper ones up itself).
pub fn link_problem(list: &BoardList, moved: &Moved, parent: &str, subtree: bool) -> Option<String> {
    let sim = simulate(list, moved, parent);
    if sim.idx(parent).is_none() || parent == moved.id {
        return None;
    }
    let below = family_below(&sim, moved.id);
    let top = family_root(&sim, moved.id).map(|i| sim.at(i).id.clone());
    // One sub-feature level: a main ticket in the moved part has no main ticket above it but its family's top one.
    for &m in below.iter().filter(|&&i| sim.at(i).main) {
        let mt = sim.at(m);
        let mut seen: HashSet<String> = HashSet::from([mt.id.clone()]);
        let mut cur = parent_in(&sim, mt).map(|(p, _)| p);
        while let Some(c) = cur {
            let ct = sim.at(c);
            if !seen.insert(ct.id.clone()) {
                break;
            }
            if ct.main && Some(&ct.id) != top.as_ref() {
                let holder = family_root(&sim, &ct.id).map(|i| sim.at(i).title.clone()).unwrap_or_else(|| ct.title.clone());
                return Some(if ct.id == moved.id {
                    format!(
                        "\"{}\" has its own sub-feature \"{}\", so it can't become part of \"{holder}\"; a sub-feature can't hold another sub-feature.",
                        moved.title, mt.title
                    )
                } else {
                    format!("\"{}\" is already part of \"{holder}\"; a sub-feature can't hold another sub-feature.", ct.title)
                });
            }
            cur = parent_in(&sim, ct).map(|(p, _)| p);
        }
    }
    // Depth: a sub-feature's own place counts in its parent's feature, every other ticket in its own feature.
    let level_in = |i: usize| {
        let t = sim.at(i);
        match if t.main { parent_in(&sim, t) } else { None } {
            Some((p, _)) => level_of(&sim, &sim.at(p).id) + 1,
            None => level_of(&sim, &t.id),
        }
    };
    let mut deepest: Option<(usize, usize)> = None;
    let scan: &[usize] = if subtree { &below } else { &below[..below.len().min(1)] };
    for &i in scan {
        let level = level_in(i);
        if level > MAX_LEVEL && deepest.is_none_or(|(_, d)| level > d) {
            deepest = Some((i, level));
        }
    }
    let (i, level) = deepest?;
    let t = sim.at(i);
    if t.id == moved.id {
        return Some(format!(
            "That would put \"{}\" {level} levels deep; a feature keeps its tickets at most {MAX_LEVEL} levels deep. Put it {}.",
            moved.title,
            where_instead(&sim, parent)
        ));
    }
    Some(format!(
        "That would put \"{}\" (under \"{}\") {level} levels deep; a feature keeps its tickets at most {MAX_LEVEL} levels deep. Put \"{}\" higher up, {}, or move its deepest tickets up first.",
        t.title,
        moved.title,
        moved.title,
        where_instead(&sim, parent)
    ))
}

/// The listing with one ticket's plan link cleared (`{ ...o, parentId: null }`), as setPartOf checks it.
pub fn without_plan_link(list: &BoardList, id: &str) -> BoardList {
    let tickets = list
        .tickets
        .iter()
        .map(|t| {
            if t.id == id && t.json.get("parentId").is_some_and(|v| !v.is_null()) {
                let mut j = t.json.clone();
                j.insert("parentId".into(), Value::Null);
                Arc::new(Tk::from_json(j, false))
            } else {
                t.clone()
            }
        })
        .collect();
    BoardList::new(&list.slug, tickets, 0)
}

/// `subtreeIds`: id and every ticket below it (all levels).
pub fn subtree_ids(list: &BoardList, id: &str) -> Vec<String> {
    family_below(list, id).into_iter().map(|i| list.at(i).id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::family::tests::board;
    use serde_json::json;

    fn t(id: &str, extra: Value) -> Value {
        let mut m = json!({ "id": id, "title": id.to_uppercase(), "status": "backlog", "createdAt": format!("2026-01-01T00:00:{}Z", &id[1..]) });
        if let (Value::Object(m), Value::Object(e)) = (&mut m, extra) {
            m.extend(e);
        }
        m
    }

    #[test]
    fn levels_loops_and_fit() {
        let b = board(vec![
            t("a01", json!({ "main": true })),
            t("a02", json!({ "partOf": "a01" })),
            t("a03", json!({ "partOf": "a02" })),
            t("a04", json!({ "main": true, "partOf": "a01" })),
        ]);
        assert_eq!(level_of(&b, "a01"), 0);
        assert_eq!(level_of(&b, "a03"), 2);
        assert_eq!(level_of(&b, "a04"), 0);
        assert!(would_loop(&b, "a01", "a03"));
        assert!(!would_loop(&b, "a03", "a01"));
        assert!(would_loop(&b, "a02", "a02"));
        assert_eq!(fit_parent(&b, "a03"), "a02");
        assert_eq!(fit_parent(&b, "a02"), "a02");
        assert!(is_feature(&b, b.get("a01").unwrap()));
    }

    #[test]
    fn link_problems() {
        let b = board(vec![
            t("a01", json!({ "main": true })),
            t("a02", json!({ "partOf": "a01" })),
            t("a03", json!({ "partOf": "a02" })),
            t("a04", json!({ "main": true, "partOf": "a01" })),
            t("a05", json!({})),
            t("a06", json!({ "partOf": "a05" })),
        ]);
        let new = |main| Moved { id: "\u{0}new", title: "New", main: Some(main) };
        assert_eq!(link_problem(&b, &new(false), "a02", true), None);
        assert_eq!(
            link_problem(&b, &new(false), "a03", true).as_deref(),
            Some("That would put \"New\" 3 levels deep; a feature keeps its tickets at most 2 levels deep. Put it under the feature \"A01\" (a01).")
        );
        assert_eq!(
            link_problem(&b, &new(true), "a04", true).as_deref(),
            Some("\"A04\" is already part of \"A01\"; a sub-feature can't hold another sub-feature.")
        );
        let a05 = Moved { id: "a05", title: "A05", main: None };
        assert!(link_problem(&b, &a05, "a03", true).unwrap().starts_with("That would put \"A06\" (under \"A05\") 4 levels deep"));
        assert!(link_problem(&b, &a05, "a03", false).unwrap().starts_with("That would put \"A05\" 3 levels deep"));
        assert!(link_problem(&b, &a05, "a02", true).unwrap().starts_with("That would put \"A06\" (under \"A05\") 3 levels deep"));
        assert_eq!(link_problem(&b, &a05, "a02", false), None);
    }

    #[test]
    fn rounds() {
        let b = board(vec![
            t("a01", json!({ "main": true })),
            t("a02", json!({ "partOf": "a01", "title": "Testing round 2", "kind": "round" })),
            t("a03", json!({ "partOf": "a01", "title": "testing round 7x" })),
        ]);
        assert_eq!(next_round_title(&b, Some("a01")), "Testing round 3");
        assert_eq!(next_round_title(&b, None), "Testing round 1");
        assert_eq!(groups_of(&b, "a01").len(), 1);
    }
}
