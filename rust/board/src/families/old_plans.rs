//! Old-style plans (planned tickets from before main tickets) are migrated by Bun once at its start
//! (`retire-plans.ts`). Board mode doesn't port that migration: a board that still has one refuses board mode
//! (fallback 2 of `mode.rs`), Bun takes the board, migrates it, and the next start in board mode finds none.

use std::collections::HashSet;

use crate::index::store::BoardList;

/// An old child: linked to a plan by parentId, and neither a tool ticket nor a main ticket.
fn old_child(t: &crate::index::ticket::Tk) -> bool {
    t.parent_id.is_some() && !t.tool && !t.main
}

/// The old planners on a board (`retirePlanPatches`' planners): not main, not tool, with an old child.
pub fn old_planners(list: &BoardList) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for t in list.tickets.iter().filter(|t| old_child(t)) {
        let Some(p) = t.parent_id.as_deref().and_then(|p| list.get(p)) else { continue };
        if !p.main && !p.tool && seen.insert(p.id.clone()) {
            out.push(p.id.clone());
        }
    }
    out
}

/// Why board mode can't start on these boards (the first board with an old plan), or None.
pub fn refusal(boards: &[(String, std::sync::Arc<BoardList>)]) -> Option<String> {
    for (slug, list) in boards {
        let planners = old_planners(list);
        if let Some(first) = planners.first() {
            return Some(format!(
                "board {slug} has {} old-style plan{} (planned tickets, e.g. {first}) that only Bun's one-time migration turns into main tickets; Bun keeps the board this time",
                planners.len(),
                if planners.len() == 1 { "" } else { "s" }
            ));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::family::tests::board;
    use serde_json::json;

    #[test]
    fn finds_old_planners_only() {
        let b = board(vec![
            json!({ "id": "p", "title": "P", "status": "backlog", "createdAt": "1" }),
            json!({ "id": "c", "title": "C", "status": "backlog", "createdAt": "2", "parentId": "p" }),
            json!({ "id": "m", "title": "M", "status": "backlog", "createdAt": "3", "main": true }),
            json!({ "id": "t", "title": "T", "status": "backlog", "createdAt": "4", "parentId": "m", "tool": true }),
        ]);
        assert_eq!(old_planners(&b), vec!["p".to_string()]);
        let b = board(vec![
            json!({ "id": "m", "title": "M", "status": "backlog", "createdAt": "3", "main": true }),
            json!({ "id": "t", "title": "T", "status": "backlog", "createdAt": "4", "parentId": "m", "tool": true }),
        ]);
        assert!(old_planners(&b).is_empty());
    }
}
