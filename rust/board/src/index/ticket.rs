//! `Tk`: one ticket as the board's listing holds it. The JSON object is exactly what Bun's `parseTicket` gives (front
//! matter in file order, then `body`), so answers carry every field, known or not. The fields the listing, families,
//! scopes and columns read for every ticket are pulled out once at parse time (a 10,000-ticket board walks them on each
//! page).

use ckanban_core::jsnum::truthy;
use ckanban_core::ticket::{self, TicketError};
use serde_json::{Map, Value};

/// How a ticket hangs on its parent (`LinkHow` in family.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum How {
    Linked,
    Chat,
    Plan,
}

impl How {
    pub fn word(self) -> &'static str {
        match self {
            How::Linked => "linked",
            How::Chat => "chat",
            How::Plan => "plan",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Tk {
    /// The ticket as the API sends it: `{...frontMatter, body}`.
    pub json: Map<String, Value>,
    pub id: String,
    pub title: String,
    pub status: String,
    /// NaN when missing or not a number (JS `undefined - n`).
    pub order: f64,
    pub created_at: String,
    pub updated_at: String,
    /// `partOf` when truthy.
    pub part_of: Option<String>,
    /// `partOfVia === "chat"`.
    pub part_of_chat: bool,
    /// `parentId` when truthy.
    pub parent_id: Option<String>,
    pub main: bool,
    pub tool: bool,
    /// `!!showOnBoard`.
    pub show_true: bool,
    /// `showOnBoard === false`.
    pub show_false: bool,
    pub kind: Option<String>,
    /// `pinnedAt` when truthy.
    pub pinned_at: Option<String>,
    /// `slotWait.at` when `slotWait` is truthy ("" without `at`).
    pub slot_wait: Option<String>,
    pub tags: Vec<String>,
    pub body: String,
    /// A file that didn't parse: Bun's placeholder (`readTicketOrCorrupt`), never cached by Bun.
    pub corrupt: bool,
}

fn text(m: &Map<String, Value>, k: &str) -> Option<String> {
    match m.get(k) {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `String(v)` for the fields read as text (`title`, `status`, times): a non-string shows as Bun would print it.
fn plain(m: &Map<String, Value>, k: &str) -> String {
    match m.get(k) {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => String::new(),
        Some(v) => v.to_string(),
    }
}

impl Tk {
    pub fn from_json(json: Map<String, Value>, corrupt: bool) -> Tk {
        let order = json.get("order").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let tags = match json.get("tags") {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            _ => Vec::new(),
        };
        let slot_wait = if truthy(json.get("slotWait")) {
            Some(json.get("slotWait").and_then(|s| s.get("at")).and_then(Value::as_str).unwrap_or("").to_string())
        } else {
            None
        };
        Tk {
            id: plain(&json, "id"),
            title: plain(&json, "title"),
            status: plain(&json, "status"),
            order,
            created_at: plain(&json, "createdAt"),
            updated_at: plain(&json, "updatedAt"),
            part_of: text(&json, "partOf"),
            part_of_chat: json.get("partOfVia").and_then(Value::as_str) == Some("chat"),
            parent_id: text(&json, "parentId"),
            main: truthy(json.get("main")),
            tool: truthy(json.get("tool")),
            show_true: truthy(json.get("showOnBoard")),
            show_false: json.get("showOnBoard") == Some(&Value::Bool(false)),
            kind: json.get("kind").and_then(Value::as_str).map(str::to_string),
            pinned_at: text(&json, "pinnedAt"),
            slot_wait,
            tags,
            body: plain(&json, "body"),
            corrupt,
            json,
        }
    }

    /// `parseTicket` of a file's text; a file that doesn't parse gives Bun's placeholder with the error.
    pub fn parse(id: &str, raw: &str, now_iso: &str) -> Tk {
        match ticket::parse(raw) {
            Ok(t) => match t.to_json() {
                Value::Object(m) => Tk::from_json(m, false),
                _ => unreachable!("to_json gives an object"),
            },
            Err(e) => Tk::corrupt(id, &e, now_iso),
        }
    }

    pub fn corrupt(id: &str, e: &TicketError, now_iso: &str) -> Tk {
        match ticket::Ticket::corrupt(id, e, now_iso).to_json() {
            Value::Object(m) => Tk::from_json(m, true),
            _ => unreachable!("to_json gives an object"),
        }
    }

    pub fn get(&self, k: &str) -> Option<&Value> {
        self.json.get(k)
    }
    /// The field as text when it is a string.
    pub fn s(&self, k: &str) -> Option<&str> {
        self.json.get(k).and_then(Value::as_str)
    }
    /// JS truthiness of the field.
    pub fn is(&self, k: &str) -> bool {
        truthy(self.json.get(k))
    }
    /// `t.outcome === x`.
    pub fn outcome_is(&self, x: &str) -> bool {
        self.s("outcome") == Some(x)
    }
    /// `t.plan?.state`.
    pub fn plan_state(&self) -> Option<&str> {
        self.get("plan").and_then(|p| p.get("state")).and_then(Value::as_str)
    }

    /// `parentLink`: partOf wins over a plan.
    pub fn parent_link(&self) -> Option<(&str, How)> {
        if let Some(p) = &self.part_of {
            return Some((p, if self.part_of_chat { How::Chat } else { How::Linked }));
        }
        self.parent_id.as_deref().map(|p| (p, How::Plan))
    }

    /// `hiddenTool`: a tool ticket (task).
    pub fn hidden_tool(&self) -> bool {
        self.tool
    }

    /// `hideableCard`.
    pub fn hideable_card(&self) -> bool {
        let kind = self.kind.as_deref();
        !self.tool && !self.main && kind != Some("group") && kind != Some("round") && (self.part_of.is_some() || self.parent_id.is_some())
    }

    /// `hiddenCard` (a ticket from a file has no `running` unless the file says so).
    pub fn hidden_card(&self) -> bool {
        self.show_false && self.hideable_card() && !self.is("running") && self.status != "in_progress" && self.status != "review"
    }

    /// `onBoard`: the board shows a card for it.
    pub fn on_board(&self) -> bool {
        if self.tool { self.show_true } else { !self.hidden_card() }
    }

    /// `hasTags`: no tags asked, or any of them.
    pub fn has_tags(&self, tags: &[String]) -> bool {
        tags.is_empty() || tags.iter().any(|g| self.tags.contains(g))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_like_bun() {
        let t = Tk::parse(
            "t_1",
            "---\nid: t_1\ntitle: A\nstatus: done\norder: 2.5\npartOf: t_0\npartOfVia: chat\ntool: true\nshowOnBoard: true\nslotWait:\n  at: x\ntags:\n  - a\n---\nhello",
            "now",
        );
        assert_eq!(t.parent_link(), Some(("t_0", How::Chat)));
        assert_eq!(t.order, 2.5);
        assert!(t.on_board());
        assert_eq!(t.slot_wait.as_deref(), Some("x"));
        assert_eq!(t.body, "hello");
        assert_eq!(t.json.keys().last().map(String::as_str), Some("body"));
        let c = Tk::parse("t_2", "nope", "2026-01-01T00:00:00.000Z");
        assert!(c.corrupt);
        assert_eq!(c.title, "t_2");
        assert_eq!(c.s("error"), Some("corrupt ticket file: missing frontmatter"));
    }
}
