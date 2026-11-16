//! A ticket's `ticket.md`: YAML front matter plus a Markdown body, read and written like `parseTicket` /
//! `serializeTicket` and `createTicket` / `updateTicket` in `src/core/store.ts`.
//!
//! The front matter is kept as a JSON object in Bun's key order, so fields this code doesn't know (and their place)
//! survive a rewrite. Where a new ticket lands in its column (`entryOrder`) needs the whole board, so callers pass
//! the order in.

use crate::atomic::atomic_write;
use crate::jsnum::{num, truthy};
use crate::yaml_read::{self, YamlError};
use crate::yaml_write::stringify_map;
use serde_json::{Map, Value};
use std::io;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    /// Every front matter field, in file order (never `body`).
    pub meta: Map<String, Value>,
    /// Everything after the closing `---` line, unchanged.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TicketError {
    MissingFrontmatter,
    InvalidFrontmatter,
    Yaml(YamlError),
}

impl std::fmt::Display for TicketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingFrontmatter => f.write_str("missing frontmatter"),
            Self::InvalidFrontmatter => f.write_str("invalid frontmatter"),
            Self::Yaml(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for TicketError {}

/// `parseTicket`: `^---\n([\s\S]*?)\n---\n?([\s\S]*)$`, the front matter must be an object with a truthy `id`;
/// an old add-on link is turned into a family link on the way (`withoutAddOn`).
pub fn parse(raw: &str) -> Result<Ticket, TicketError> {
    let rest = raw.strip_prefix("---\n").ok_or(TicketError::MissingFrontmatter)?;
    // The front matter ends at the first "\n---" (lazy match); the body starts after it and one optional \n.
    let cut = rest.find("\n---").ok_or(TicketError::MissingFrontmatter)?;
    let front = &rest[..cut];
    let after = &rest[cut + 4..];
    let body = after.strip_prefix('\n').unwrap_or(after);
    let meta = match yaml_read::parse(front).map_err(TicketError::Yaml)? {
        Value::Object(m) if m.get("id").is_some_and(|v| truthy(Some(v))) => m,
        _ => return Err(TicketError::InvalidFrontmatter),
    };
    let mut meta = without_add_on(meta);
    meta.shift_remove("body");
    Ok(Ticket { meta, body: body.to_string() })
}

/// `serializeTicket`: `"---\n" + YAML.stringify(meta) + "---\n" + body`.
pub fn serialize(t: &Ticket) -> String {
    let mut meta = t.meta.clone();
    meta.shift_remove("body");
    format!("---\n{}---\n{}", stringify_map(&meta), t.body)
}

/// `withoutAddOn`: an old `addOnOf` (or `followUpOf`) link loads as `partOf` (unless set) and `madeFrom` (unless set).
pub fn without_add_on(meta: Map<String, Value>) -> Map<String, Value> {
    if !meta.contains_key("addOnOf") && !meta.contains_key("followUpOf") {
        return meta;
    }
    let link = |v: Option<&Value>| v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let from = link(meta.get("addOnOf")).or_else(|| link(meta.get("followUpOf")));
    let mut rest = meta;
    rest.shift_remove("addOnOf");
    rest.shift_remove("followUpOf");
    let Some(from) = from else { return rest };
    if !truthy(rest.get("partOf")) {
        let via = truthy(rest.get("partOfVia"));
        rest.insert("partOf".into(), Value::String(from.clone()));
        if via {
            rest.insert("partOfVia".into(), Value::Null);
        }
    }
    if !truthy(rest.get("madeFrom")) {
        rest.insert("madeFrom".into(), Value::String(from));
    }
    rest
}

impl Ticket {
    pub fn id(&self) -> Option<&str> {
        self.meta.get("id").and_then(Value::as_str)
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        self.meta.get(key).and_then(Value::as_str)
    }

    /// The ticket as one JSON object (`{...meta, body}`), the shape the API sends.
    pub fn to_json(&self) -> Value {
        let mut m = self.meta.clone();
        m.insert("body".into(), Value::String(self.body.clone()));
        Value::Object(m)
    }

    /// The placeholder Bun shows for a ticket file that doesn't parse (`readTicketOrCorrupt`); the file is left as is.
    pub fn corrupt(id: &str, err: &TicketError, at: &str) -> Ticket {
        let mut m = Map::new();
        for (k, v) in [
            ("id", Value::from(id)),
            ("title", Value::from(id)),
            ("status", "backlog".into()),
            ("order", num(0.0)),
            ("sessionId", Value::Null),
            ("worktree", Value::Null),
            ("branch", Value::Null),
            ("prUrl", Value::Null),
            ("outcome", Value::Null),
            ("lastActivity", Value::Null),
            ("lastRunAt", Value::Null),
            ("runCount", num(0.0)),
            ("error", Value::String(format!("corrupt ticket file: {err}"))),
            ("createdAt", at.into()),
            ("updatedAt", at.into()),
        ] {
            m.insert(k.into(), v);
        }
        Ticket { meta: m, body: String::new() }
    }
}

/// The optional fields `createTicket` takes, written only when given, in this order.
#[derive(Clone, Debug, Default)]
pub struct NewTicket {
    pub title: String,
    pub body: String,
    pub status: String,
    /// Default "auto".
    pub mode: Option<String>,
    pub schedule_id: Option<String>,
    pub job_id: Option<String>,
    pub source: Option<Value>,
    pub parent_id: Option<String>,
    pub plan_key: Option<String>,
    pub proposed_as: Option<String>,
    pub made_from: Option<String>,
    pub depends_on: Vec<String>,
    pub needs: Vec<String>,
    pub tags: Vec<String>,
    pub important: bool,
    pub part_of: Option<String>,
    pub part_of_via: Option<String>,
    pub model: Option<String>,
    pub raised_by: Option<Value>,
    pub kind: Option<String>,
    pub effort: Option<String>,
    pub main: bool,
    pub waits_for_start: bool,
    pub tool: bool,
    pub start_from: Option<String>,
}

/// `createTicket`'s ticket (not written): `id`, `order` (the column's entry order) and `at` (now) come from the caller.
pub fn new_ticket(input: NewTicket, id: &str, order: f64, at: &str) -> Ticket {
    let mut m = Map::new();
    let mut put = |k: &str, v: Value| {
        m.insert(k.into(), v);
    };
    let some = |s: &Option<String>| s.as_deref().filter(|s| !s.is_empty()).map(Value::from);
    let list = |l: &Vec<String>| (!l.is_empty()).then(|| Value::Array(l.iter().map(|s| Value::from(s.as_str())).collect()));
    put("id", id.into());
    put("title", input.title.as_str().into());
    put("status", input.status.as_str().into());
    put("mode", input.mode.as_deref().unwrap_or("auto").into());
    put("order", num(order));
    for k in ["sessionId", "worktree", "branch", "prUrl", "outcome", "lastActivity", "lastRunAt"] {
        put(k, Value::Null);
    }
    put("runCount", num(0.0));
    put("error", Value::Null);
    put("createdAt", at.into());
    put("updatedAt", at.into());
    let obj = |v: &Option<Value>| v.clone().filter(|v| truthy(Some(v)));
    let fields: Vec<(&str, Option<Value>)> = vec![
        ("scheduleId", some(&input.schedule_id)),
        ("jobId", some(&input.job_id)),
        ("source", obj(&input.source)),
        ("parentId", some(&input.parent_id)),
        ("planKey", some(&input.plan_key)),
        ("proposedAs", some(&input.proposed_as)),
        ("madeFrom", some(&input.made_from)),
        ("dependsOn", list(&input.depends_on)),
        ("needs", list(&input.needs)),
        ("tags", list(&input.tags)),
        ("important", input.important.then_some(Value::Bool(true))),
    ];
    for (k, v) in fields {
        if let Some(v) = v {
            put(k, v);
        }
    }
    if let Some(p) = some(&input.part_of) {
        put("partOf", p);
        if let Some(via) = some(&input.part_of_via) {
            put("partOfVia", via);
        }
    }
    let fields: Vec<(&str, Option<Value>)> = vec![
        ("model", some(&input.model)),
        ("raisedBy", obj(&input.raised_by)),
        ("kind", some(&input.kind)),
        ("effort", some(&input.effort)),
        ("main", input.main.then_some(Value::Bool(true))),
        ("waitsForStart", input.waits_for_start.then_some(Value::Bool(true))),
        ("tool", input.tool.then_some(Value::Bool(true))),
        ("startFrom", some(&input.start_from)),
    ];
    for (k, v) in fields {
        if let Some(v) = v {
            put(k, v);
        }
    }
    Ticket { meta: m, body: input.body }
}

/// `updateTicket`'s merge (not written): `{...current, ...patch, id, updatedAt}`; `body` in the patch replaces the
/// body. `entry_order`: the new column's entry order, used when the status changes without an `order` in the patch.
pub fn apply_patch(current: &Ticket, patch: &Map<String, Value>, now: &str, keep_updated_at: bool, entry_order: impl FnOnce(&str) -> f64) -> Ticket {
    let mut meta = current.meta.clone();
    let mut body = current.body.clone();
    for (k, v) in patch {
        if k == "body" {
            if let Some(b) = v.as_str() {
                body = b.to_string();
            }
            continue;
        }
        meta.insert(k.clone(), v.clone());
    }
    if let Some(id) = current.meta.get("id") {
        meta.insert("id".into(), id.clone());
    }
    let updated = if keep_updated_at { current.meta.get("updatedAt").cloned().unwrap_or(Value::Null) } else { Value::from(now) };
    meta.insert("updatedAt".into(), updated.clone());
    let cur_status = current.meta.get("status");
    if let Some(st) = patch.get("status") {
        if Some(st) != cur_status && !patch.contains_key("order") {
            let o = entry_order(st.as_str().unwrap_or(""));
            meta.insert("order".into(), num(o));
        }
    }
    let done = |s: Option<&Value>| s.and_then(Value::as_str) == Some("done");
    if done(meta.get("status")) && !done(cur_status) {
        meta.insert("doneAt".into(), updated);
    }
    if done(meta.get("status")) && truthy(meta.get("pinnedAt")) {
        meta.insert("pinnedAt".into(), Value::Null);
    }
    Ticket { meta, body }
}

/// Reads and parses a ticket file: Ok(None) when it is missing; Ok(Some(Err)) when it doesn't parse.
pub fn read(file: &Path) -> io::Result<Option<Result<Ticket, TicketError>>> {
    match std::fs::read_to_string(file) {
        Ok(raw) => Ok(Some(parse(&raw))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Writes the ticket file atomically, as Bun does.
pub fn write(file: &Path, t: &Ticket) -> io::Result<()> {
    atomic_write(file, serialize(t))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DOC_EXAMPLE: &str = "---\nid: t_20261115_a3uu\ntitle: 'Fix: login: \"broken\" on #phone'\nstatus: done\nmode: interview\norder: 1\nsessionId: null\nworktree: null\nbranch: null\nprUrl: null\noutcome: done\nlastActivity: null\nlastRunAt: null\nrunCount: 0\nerror: null\ncreatedAt: 2026-11-15T07:50:46.825Z\nupdatedAt: 2026-11-15T07:50:46.837Z\ntags:\n  - ui\ndoneAt: 2026-11-15T07:50:46.837Z\n---\n## Goal\nFix it.\n";

    #[test]
    fn round_trips_the_documented_example() {
        let t = parse(DOC_EXAMPLE).unwrap();
        assert_eq!(t.str("title"), Some("Fix: login: \"broken\" on #phone"));
        assert_eq!(t.meta["createdAt"], json!("2026-11-15T07:50:46.825Z"));
        assert_eq!(t.body, "## Goal\nFix it.\n");
        assert_eq!(serialize(&t), DOC_EXAMPLE);
    }

    #[test]
    fn parse_rules() {
        assert_eq!(parse("no front"), Err(TicketError::MissingFrontmatter));
        assert_eq!(parse("---\ntitle: x\n---\n"), Err(TicketError::InvalidFrontmatter));
        let t = parse("---\nid: t_1\nbody: ignored\n---").unwrap();
        assert_eq!(t.body, "");
        assert!(!t.meta.contains_key("body"));
        let t = parse("---\nid: t_1\naddOnOf: t_2\npartOfVia: chat\n---\nb").unwrap();
        assert_eq!(Value::Object(t.meta), json!({"id": "t_1", "partOfVia": null, "partOf": "t_2", "madeFrom": "t_2"}));
    }

    #[test]
    fn create_and_update() {
        let t = new_ticket(NewTicket { title: "A".into(), body: "b".into(), status: "backlog".into(), tags: vec!["x".into()], part_of: Some("t_p".into()), tool: true, ..Default::default() }, "t_20261116_abcd", -1.0, "2026-11-16T00:00:00.000Z");
        let keys: Vec<_> = t.meta.keys().map(String::as_str).collect();
        assert_eq!(keys, ["id", "title", "status", "mode", "order", "sessionId", "worktree", "branch", "prUrl", "outcome", "lastActivity", "lastRunAt", "runCount", "error", "createdAt", "updatedAt", "tags", "partOf", "tool"]);
        let mut patch = Map::new();
        patch.insert("status".into(), json!("done"));
        patch.insert("pinnedAt".into(), json!("2026-11-16T00:00:00.000Z"));
        patch.insert("newField".into(), json!(1));
        let n = apply_patch(&t, &patch, "2026-11-16T01:00:00.000Z", false, |_| 7.0);
        assert_eq!(n.meta["order"], json!(7));
        assert_eq!(n.meta["doneAt"], json!("2026-11-16T01:00:00.000Z"));
        assert_eq!(n.meta["pinnedAt"], Value::Null);
        assert_eq!(n.meta.keys().last().map(String::as_str), Some("doneAt"));
        assert_eq!(n.body, "b");
    }
}
