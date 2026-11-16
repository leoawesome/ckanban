//! Ticket families, the part of `web/src/features/family/family.ts` the read routes use: parents and children,
//! a family's rows, features and their rows, tasks and their tally, what works in a family, and a row's state.
//! Indices point into one `BoardList`; children are worked out once per listing (`Kids`).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::store::BoardList;
use super::ticket::{How, Tk};

/// Direct children of every ticket, oldest first (by `createdAt`, ties in board order), with how each hangs.
pub struct Kids(HashMap<String, Vec<(usize, How)>>);

impl Kids {
    pub fn build(list: &BoardList) -> Kids {
        let mut order: Vec<usize> = (0..list.tickets.len()).collect();
        order.sort_by(|&a, &b| list.at(a).created_at.cmp(&list.at(b).created_at));
        let mut out: HashMap<String, Vec<(usize, How)>> = HashMap::new();
        for i in order {
            if let Some((p, how)) = parent_in(list, list.at(i)) {
                out.entry(list.at(p).id.clone()).or_default().push((i, how));
            }
        }
        Kids(out)
    }
    pub fn of(&self, id: &str) -> &[(usize, How)] {
        self.0.get(id).map(Vec::as_slice).unwrap_or(&[])
    }
}

/// A ticket's parent when it is still on the board (`parentIn`).
pub fn parent_in(list: &BoardList, t: &Tk) -> Option<(usize, How)> {
    let (id, how) = t.parent_link()?;
    if id == t.id {
        return None;
    }
    list.idx(id).map(|p| (p, how))
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub idx: usize,
    pub depth: usize,
    pub how: Option<How>,
}

/// The top ticket of id's family (`familyRoot`).
pub fn family_root(list: &BoardList, id: &str) -> Option<usize> {
    let mut cur = list.idx(id)?;
    let mut seen = HashSet::new();
    while seen.insert(cur) {
        match parent_in(list, list.at(cur)) {
            Some((p, _)) if !seen.contains(&p) => cur = p,
            _ => break,
        }
    }
    Some(cur)
}

fn walk(list: &BoardList, root: usize, stop_at_main: bool) -> Vec<Row> {
    let kids = list.kids();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![(root, 0usize, None)];
    while let Some((i, depth, how)) = stack.pop() {
        if !seen.insert(i) {
            continue;
        }
        out.push(Row { idx: i, depth, how });
        if stop_at_main && depth > 0 && list.at(i).main {
            continue;
        }
        for &(c, h) in kids.of(&list.at(i).id).iter().rev() {
            stack.push((c, depth + 1, Some(h)));
        }
    }
    out
}

/// id's whole family from its top, depth first, children oldest first (`familyOf`).
pub fn family_of(list: &BoardList, id: &str) -> Vec<Row> {
    family_root(list, id).map(|r| walk(list, r, false)).unwrap_or_default()
}

/// id and everything below it at any depth (`familyBelow`).
pub fn family_below(list: &BoardList, id: &str) -> Vec<usize> {
    list.idx(id).map(|i| walk(list, i, false).into_iter().map(|r| r.idx).collect()).unwrap_or_default()
}

/// The top of id's own feature: up to the nearest main ticket, else the family's top (`featureRoot`).
pub fn feature_root(list: &BoardList, id: &str) -> Option<usize> {
    let mut cur = list.idx(id)?;
    let mut seen = HashSet::new();
    while seen.insert(cur) {
        if list.at(cur).main {
            return Some(cur);
        }
        match parent_in(list, list.at(cur)) {
            Some((p, _)) if !seen.contains(&p) => cur = p,
            _ => break,
        }
    }
    Some(cur)
}

/// id's own feature from its top down; a sub-feature inside is one row (`featureRows`).
pub fn feature_rows(list: &BoardList, id: &str) -> Vec<Row> {
    feature_root(list, id).map(|r| walk(list, r, true)).unwrap_or_default()
}

/// Every open feature's top ticket (`openFeatures`): not Done, a family top or a sub-feature, with a status or 2+ others.
pub fn open_features(list: &BoardList) -> Vec<usize> {
    (0..list.tickets.len())
        .filter(|&i| {
            let t = list.at(i);
            if t.status == "done" || (parent_in(list, t).is_some() && !t.main) {
                return false;
            }
            t.is("statusAt") || walk(list, i, true).len() >= 3
        })
        .collect()
}

/// The tasks among feature rows (`featureTasks`): below the top, not main, not a group or round, holding nothing.
pub fn feature_tasks(list: &BoardList, rows: &[Row]) -> Vec<usize> {
    rows.iter()
        .enumerate()
        .filter(|(i, r)| {
            let t = list.at(r.idx);
            let kind = t.kind.as_deref();
            r.depth > 0 && !t.main && kind != Some("group") && kind != Some("round") && rows.get(i + 1).map(|n| n.depth).unwrap_or(0) <= r.depth
        })
        .map(|(_, r)| r.idx)
        .collect()
}

/// Finished tasks of all of them (`taskTally`).
pub fn task_tally(list: &BoardList, rows: &[Row]) -> (usize, usize) {
    let tasks = feature_tasks(list, rows);
    let done = tasks.iter().filter(|&&i| settled(family_state(list.at(i), false, false))).count();
    (done, tasks.len())
}

/// `askClosed`: the user closed what the ticket's last run asked.
pub fn ask_closed(t: &Tk) -> bool {
    let ended = t.s("runEndedAt").unwrap_or("");
    match t.get("closedForms") {
        Some(Value::Object(m)) => m.values().any(|c| match c.get("run") {
            Some(Value::String(r)) => r == ended,
            _ => c.get("at").and_then(Value::as_str).is_some_and(|at| at >= ended),
        }),
        _ => false,
    }
}

/// `familyState`; running: the ticket's run is going (`t.running`).
pub fn family_state(t: &Tk, running: bool, needs_you: bool) -> &'static str {
    if t.status == "done" {
        return if t.kind.as_deref() == Some("test") { if t.s("verdict") == Some("problem") { "problem" } else { "passed" } } else { "done" };
    }
    if running || t.status == "ready" || t.status == "in_progress" {
        return if t.outcome_is("limit") { "paused" } else { "working" };
    }
    if t.outcome_is("limit") {
        return "paused";
    }
    if t.outcome_is("failed") || t.outcome_is("blocked") {
        return "failed";
    }
    if needs_you {
        return "needs_you";
    }
    if t.outcome_is("needs_input") && ask_closed(t) {
        return "waiting";
    }
    if t.status == "review" {
        return "in_review";
    }
    if t.status == "backlog" || t.status == "planning" {
        return "waiting";
    }
    "needs_you"
}

pub fn settled(s: &str) -> bool {
    s == "done" || s == "passed" || s == "problem"
}

/// A group's short summary (`groupSummary`): "5 of 6 passed" for tests, else "4 of 6 done".
pub fn group_summary(states: &[(Option<&str>, &str)]) -> String {
    if states.is_empty() {
        return "empty".into();
    }
    let tests = states.iter().filter(|(k, _)| *k == Some("test")).count();
    if tests > 0 && tests == states.len() {
        return format!("{} of {} passed", states.iter().filter(|(_, s)| *s == "passed").count(), states.len());
    }
    format!("{} of {} done", states.iter().filter(|(_, s)| settled(s)).count(), states.len())
}

/// The items of a main ticket's family working now (`workingInFamily`): a sub-feature counts once.
pub fn working_in_family(list: &BoardList, family: &[usize], main_id: &str, running: &dyn Fn(&Tk) -> bool) -> Vec<usize> {
    let in_family: HashMap<&str, usize> = family.iter().map(|&i| (list.at(i).id.as_str(), i)).collect();
    let item_of = |t: usize| -> Option<usize> {
        let mut sub = None;
        let mut seen = HashSet::new();
        let mut cur = Some(t);
        while let Some(c) = cur {
            let ct = list.at(c);
            if !seen.insert(ct.id.as_str()) {
                return None;
            }
            if ct.main {
                sub = Some(c);
            }
            let (up, _) = ct.parent_link()?;
            if up == main_id {
                return Some(sub.unwrap_or(t));
            }
            cur = in_family.get(up).copied();
        }
        None
    };
    let mut out: Vec<usize> = Vec::new();
    for &i in family {
        let t = list.at(i);
        if t.id == main_id || !(running(t) || t.status == "ready" || t.status == "in_progress") {
            continue;
        }
        if let Some(item) = item_of(i) {
            if !out.iter().any(|&o| list.at(o).id == list.at(item).id) {
                out.push(item);
            }
        }
    }
    out
}

/// The main ticket a ticket belongs to: up its links to the first main ticket (`Board.mainOf`).
pub fn main_of(list: &BoardList, t: &Tk) -> Option<usize> {
    let mut seen = HashSet::new();
    let mut cur = list.idx(&t.id);
    // A ticket not in the listing (just read from its file) starts from itself.
    if cur.is_none() {
        if t.main {
            return None;
        }
        cur = t.parent_link().and_then(|(p, _)| list.idx(p));
    }
    while let Some(c) = cur {
        let ct = list.at(c);
        if !seen.insert(ct.id.as_str()) {
            break;
        }
        if ct.main {
            return Some(c);
        }
        cur = ct.parent_link().and_then(|(p, _)| list.idx(p));
    }
    None
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::index::ticket::Tk;
    use serde_json::{Map, json};
    use std::sync::Arc;

    pub fn tk(v: Value) -> Arc<Tk> {
        let mut m: Map<String, Value> = v.as_object().cloned().unwrap();
        m.entry("body").or_insert(json!(""));
        Arc::new(Tk::from_json(m, false))
    }

    pub fn board(tickets: Vec<Value>) -> BoardList {
        BoardList::new("b", tickets.into_iter().map(tk).collect(), 0)
    }

    #[test]
    fn families_and_features() {
        let l = board(vec![
            json!({"id": "m", "title": "Main", "status": "review", "createdAt": "1", "main": true}),
            json!({"id": "a", "title": "A", "status": "done", "createdAt": "3", "parentId": "m", "tool": true}),
            json!({"id": "g", "title": "G", "status": "review", "createdAt": "2", "parentId": "m", "tool": true, "kind": "group"}),
            json!({"id": "g1", "title": "G1", "status": "ready", "createdAt": "4", "parentId": "g", "tool": true}),
            json!({"id": "s", "title": "Sub", "status": "planning", "createdAt": "5", "partOf": "m", "main": true}),
            json!({"id": "s1", "title": "S1", "status": "in_progress", "createdAt": "6", "partOf": "s"}),
            json!({"id": "x", "title": "Loner", "status": "backlog", "createdAt": "0"}),
        ]);
        let ids = |rows: Vec<Row>| rows.into_iter().map(|r| (l.at(r.idx).id.clone(), r.depth)).collect::<Vec<_>>();
        assert_eq!(ids(family_of(&l, "s1")), [("m".into(), 0), ("g".into(), 1), ("g1".into(), 2), ("a".into(), 1), ("s".into(), 1), ("s1".into(), 2)]);
        assert_eq!(ids(feature_rows(&l, "g1")), [("m".into(), 0), ("g".into(), 1), ("g1".into(), 2), ("a".into(), 1), ("s".into(), 1)]);
        assert_eq!(l.at(feature_root(&l, "s1").unwrap()).id, "s");
        assert_eq!(task_tally(&l, &feature_rows(&l, "m")), (1, 2));
        let feats: Vec<_> = open_features(&l).into_iter().map(|i| l.at(i).id.clone()).collect();
        assert_eq!(feats, ["m"]);
        let fam = family_below(&l, "m");
        let w: Vec<_> = working_in_family(&l, &fam, "m", &|_| false).into_iter().map(|i| l.at(i).id.clone()).collect();
        assert_eq!(w, ["g1", "s"]);
        assert_eq!(l.at(main_of(&l, l.at(l.idx("g1").unwrap())).unwrap()).id, "m");
        assert_eq!(group_summary(&[(Some("test"), "passed"), (Some("test"), "problem")]), "1 of 2 passed");
    }
}
