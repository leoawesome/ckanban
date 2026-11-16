//! Three levels of named settings (`src/core/layers.ts`): built-ins shipped in code, the user's global ones
//! (`<home>/<file>.json`, every board) and one board's own (`profiles/<slug>/<file>.json`). The highest level that has
//! a name wins: built-in, then global, then board. Deleting at one level falls back to the level below.

use serde_json::Value;

use super::jsv::Obj;

/// Where a saved entry lives (`Level`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Global,
    Board,
}

impl Level {
    /// `isLevel(v)`: exactly "global" or "board".
    pub fn of(v: Option<&Value>) -> Option<Level> {
        match v.and_then(Value::as_str) {
            Some("global") => Some(Level::Global),
            Some("board") => Some(Level::Board),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Level::Global => "global",
            Level::Board => "board",
        }
    }
}

fn name_of(o: &Obj) -> &str {
    o.get("name").and_then(Value::as_str).unwrap_or("")
}

/// `mergeLayers`: built-ins first in their usual order, then every other name in alphabetical order; each at its
/// highest level, with `source`, `base` and `builtin` added. Names are lowercase letters, digits and dashes, where
/// `localeCompare` and a plain compare agree.
pub fn merge_layers(builtins: &[Obj], global: &[Obj], board: &[Obj]) -> Vec<Obj> {
    let find = |list: &[Obj], n: &str| list.iter().rev().find(|x| name_of(x) == n).cloned();
    let is_builtin = |n: &str| builtins.iter().any(|b| name_of(b) == n);
    let mut own: Vec<String> = Vec::new();
    for x in global.iter().chain(board) {
        let n = name_of(x);
        if !is_builtin(n) && !own.iter().any(|o| o == n) {
            own.push(n.to_string());
        }
    }
    own.sort();
    let mut names: Vec<String> = builtins.iter().map(|b| name_of(b).to_string()).collect();
    names.extend(own);
    names
        .into_iter()
        .map(|name| {
            // A Map keeps the last entry of a name.
            let found: Vec<(&str, Obj)> = [("builtin", builtins), ("global", global), ("board", board)]
                .into_iter()
                .filter_map(|(src, list)| find(list, &name).map(|o| (src, o)))
                .collect();
            let (source, item) = found.last().cloned().expect("a merged name comes from some level");
            let mut out = item;
            out.insert("source".into(), Value::from(source));
            out.insert("base".into(), if found.len() > 1 { Value::from(found[found.len() - 2].0) } else { Value::Null });
            out.insert("builtin".into(), Value::Bool(is_builtin(&name)));
            out
        })
        .collect()
}

/// `lowerLevels`: the entries a level sits on: built-ins for global, built-ins (with global overrides) and global
/// for a board.
pub fn lower_levels(builtins: &[Obj], global: &[Obj], level: Level) -> Vec<Obj> {
    if level == Level::Global {
        return builtins.to_vec();
    }
    let g = |n: &str| global.iter().rev().find(|x| name_of(x) == n);
    let mut out: Vec<Obj> = builtins.iter().map(|b| g(name_of(b)).unwrap_or(b).clone()).collect();
    out.extend(global.iter().filter(|x| !builtins.iter().any(|b| name_of(b) == name_of(x))).cloned());
    out
}

/// `withItem`: the level after saving `item` (replaces an entry of the same name, or adds it).
pub fn with_item(list: &[Obj], item: Obj) -> Vec<Obj> {
    let n = name_of(&item).to_string();
    let mut out: Vec<Obj> = list.iter().filter(|x| name_of(x) != n).cloned().collect();
    out.push(item);
    out
}

/// The entry of a name in a list (`list.find`): the first.
pub fn find<'a>(list: &'a [Obj], name: &str) -> Option<&'a Obj> {
    list.iter().find(|x| name_of(x) == name)
}

pub fn names(list: &[Obj]) -> Vec<String> {
    list.iter().map(|x| name_of(x).to_string()).collect()
}
