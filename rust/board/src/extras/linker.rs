//! `src/board/linker.ts`: parent suggestions. A side call picks the ticket a new one is part of (shown in its panel as
//! Link / Not related), and the one-off Find links goes through the board once for tickets without a parent. Nothing
//! links by itself: the user confirms every link.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Map, Value};

use super::learn::json_object;
use super::SideFn;
use crate::index::store::Index;
use crate::index::ticket::Tk;
use crate::prompts::js::{len16, slice16, trim, trim_end};
use crate::runs::side_call::{add_side_spend, SideCallInput, SideCallResult};
use crate::tickets::writer::Tickets;

pub const RECENT_DAYS: f64 = 30.0;
pub const MAX_CANDIDATES: usize = 120;
pub const SUGGEST_MODEL: &str = "haiku";
pub const FIND_MODEL: &str = "sonnet";
const BODY_CHARS: usize = 200;
const REASON_CHARS: usize = 160;

/// A ticket as the linker reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkTicket {
    pub id: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub updated_at: String,
    pub part_of: Option<String>,
    pub part_of_chat: bool,
    pub parent_id: Option<String>,
}

impl LinkTicket {
    pub fn of(t: &Tk) -> LinkTicket {
        LinkTicket {
            id: t.id.clone(),
            title: t.title.clone(),
            body: t.body.clone(),
            status: t.status.clone(),
            updated_at: t.json.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string(),
            part_of: t.part_of.clone(),
            part_of_chat: t.part_of_chat,
            parent_id: t.parent_id.clone(),
        }
    }
    /// `parentLink(t)?.id`.
    fn parent(&self) -> Option<&str> {
        self.part_of.as_deref().or(self.parent_id.as_deref())
    }
}

/// `candidates`: open tickets and Done ones touched in the last RECENT_DAYS days, newest first.
pub fn candidates(tickets: Vec<LinkTicket>, now_ms: f64) -> Vec<LinkTicket> {
    let since = ckanban_core::time::iso(now_ms - RECENT_DAYS * 86_400_000.0);
    let mut out: Vec<LinkTicket> = tickets.into_iter().filter(|t| t.status != "done" || t.updated_at.as_str() >= since.as_str()).collect();
    out.sort_by(|a, b| crate::runs::js::locale_compare(&b.updated_at, &a.updated_at));
    out.truncate(MAX_CANDIDATES);
    out
}

/// `oneLine`.
fn one_line(s: &str, n: usize) -> String {
    let t = trim(&crate::runs::js::squash_ws(s)).to_string();
    if len16(&t) > n { format!("{}…", trim_end(slice16(&t, n))) } else { t }
}

fn ticket_line(t: &LinkTicket) -> String {
    let body = one_line(&t.body, BODY_CHARS);
    format!(
        "- {} [{}] \"{}\"{}{}",
        t.id,
        t.status,
        one_line(&t.title, 200),
        t.parent().map(|p| format!(" (part of {p})")).unwrap_or_default(),
        if body.is_empty() { String::new() } else { format!(": {body}") }
    )
}

pub const SUGGEST_SYSTEM: &str = "You sort tickets on a kanban board into families: a ticket can be part of one earlier ticket, so all the tickets of one piece of work (a project, a feature, a \"flight\") hang together.
You get a new ticket and a list of other tickets. Pick the ticket the new one is part of: the same piece of work, a next step, a fix or a follow-up of it. When a family already exists, pick its top ticket or the member the new one belongs under most closely. Same tool, area or tag alone is not enough. When nothing clearly fits, answer null: a wrong link is worse than none.
Answer with JSON only: {\"parent\": \"<ticket id from the list>\" or null, \"reason\": \"<one short plain sentence why, under 20 words, naming no ticket ids>\"}";

/// `suggestPrompt`.
pub fn suggest_prompt(t: &LinkTicket, list: &[LinkTicket]) -> String {
    let body = one_line(&t.body, 1200);
    format!(
        "NEW TICKET\n{} \"{}\"\n{}\n\nOTHER TICKETS\n{}",
        t.id,
        t.title,
        if body.is_empty() { "(no description)" } else { &body },
        list.iter().map(ticket_line).collect::<Vec<_>>().join("\n")
    )
}

fn str_trim(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).map(|s| trim(s).to_string()).unwrap_or_default()
}

/// `parseSuggestion`: (parent id, reason), or None.
pub fn parse_suggestion(text: &str, ids: &[String]) -> Option<(String, String)> {
    let v = json_object(text);
    let parent = str_trim(v.as_ref().and_then(|v| v.get("parent")));
    if parent.is_empty() || !ids.contains(&parent) {
        return None;
    }
    let reason = v.as_ref().and_then(|v| v.get("reason")).and_then(Value::as_str).unwrap_or("");
    Some((parent, one_line(reason, REASON_CHARS)))
}

pub const FIND_SYSTEM: &str = "You sort tickets on a kanban board into families: a ticket can be part of one other ticket, so all the tickets of one piece of work (a project, a feature, a \"flight\") hang together under a top ticket.
You get the board's tickets; \"(part of X)\" marks links that already exist. For tickets without a parent that clearly belong to the same piece of work as another ticket, say which ticket they are part of. Group a family under one top ticket (usually its first or main ticket); a member may also go under a closer member. Same tool, area or tag alone is not enough. Leave out everything that doesn't clearly fit: a wrong link is worse than none.
Answer with JSON only: {\"links\": [{\"id\": \"<ticket without a parent>\", \"parent\": \"<ticket id>\", \"reason\": \"<one short plain sentence, under 20 words, naming no ticket ids>\"}]}";

/// `findPrompt`.
pub fn find_prompt(list: &[LinkTicket]) -> String {
    format!("TICKETS\n{}", list.iter().map(ticket_line).collect::<Vec<_>>().join("\n"))
}

/// `wouldLoop` on (id → parent link) of the simulated board.
fn would_loop(by_id: &HashMap<String, LinkTicket>, id: &str, parent: &str) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut cur = by_id.get(parent);
    while let Some(c) = cur {
        if seen.contains(&c.id) {
            break;
        }
        if c.id == id {
            return true;
        }
        seen.insert(c.id.clone());
        cur = c.parent().filter(|p| *p != c.id).and_then(|p| by_id.get(p));
    }
    parent == id
}

/// `parseFound`: links that can be made, as `{ id, parent, reason }`; None when the answer isn't the JSON asked for.
pub fn parse_found(text: &str, list: &[LinkTicket]) -> Option<Vec<Value>> {
    let v = json_object(text)?;
    let links = v.get("links")?.as_array()?;
    let mut by_id: HashMap<String, LinkTicket> = list.iter().map(|t| (t.id.clone(), t.clone())).collect();
    let mut out = Vec::new();
    for l in links {
        let id = str_trim(l.get("id"));
        let parent = str_trim(l.get("parent"));
        let Some(child) = by_id.get(&id) else { continue };
        if !by_id.contains_key(&parent) || child.parent().is_some() || would_loop(&by_id, &id, &parent) {
            continue;
        }
        by_id.get_mut(&id).expect("child").part_of = Some(parent.clone());
        let reason = l.get("reason").and_then(Value::as_str).unwrap_or("");
        out.push(json!({ "id": id, "parent": parent, "reason": one_line(reason, REASON_CHARS) }));
    }
    Some(out)
}

/// `Linker`.
pub struct Linker {
    pub index: Arc<Index>,
    pub tickets: Arc<Tickets>,
    pub side: SideFn,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

impl Linker {
    fn board(&self, slug: &str, skip: Option<&str>) -> Vec<LinkTicket> {
        let list = self.index.list(slug);
        list.tickets.iter().filter(|o| Some(o.id.as_str()) != skip && !o.tool).map(|t| LinkTicket::of(t)).collect()
    }

    /// `suggest`: looks for a parent for a ticket the user just created and puts it on the ticket. Errors are logged.
    pub async fn suggest(self: &Arc<Self>, slug: &str, id: &str) {
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        let prep = tokio::task::spawn_blocking(move || {
            let t = me.index.ticket(&s, &i)?;
            let j = &t.json;
            if ckanban_core::jsnum::truthy(j.get("parentChecked")) || t.part_of.is_some() || t.parent_id.is_some() || ckanban_core::jsnum::truthy(j.get("branchedFrom")) {
                return None;
            }
            Some((LinkTicket::of(&t), candidates(me.board(&s, Some(&i)), (me.now)())))
        })
        .await
        .ok()
        .flatten();
        let Some((t, list)) = prep else { return };
        if list.is_empty() {
            self.suggest_parent(slug, id, None).await;
            return;
        }
        let r = (self.side)(SideCallInput {
            system: SUGGEST_SYSTEM.into(),
            prompt: suggest_prompt(&t, &list),
            model: Some(SUGGEST_MODEL.into()),
            timeout_ms: Some(90_000),
            ..Default::default()
        })
        .await;
        if self.index.ticket(slug, id).is_none() {
            return;
        }
        match r {
            SideCallResult::Err { error, .. } => eprintln!("suggesting a parent for {slug}/{id}: {error}"),
            SideCallResult::Ok { text, cost_usd, .. } => {
                let file = ckanban_core::DataDir::new(self.index.root()).side_spend_path(slug, id);
                let _ = add_side_spend(&file, "link", cost_usd, None);
                let ids: Vec<String> = list.iter().map(|o| o.id.clone()).collect();
                self.suggest_parent(slug, id, parse_suggestion(&text, &ids)).await;
            }
        }
    }

    /// `Board.suggestParent`: unless the ticket got a parent or was settled meanwhile.
    async fn suggest_parent(self: &Arc<Self>, slug: &str, id: &str, suggestion: Option<(String, String)>) {
        let me = self.clone();
        let (s, i) = (slug.to_string(), id.to_string());
        let _ = tokio::task::spawn_blocking(move || {
            let Some(t) = me.index.ticket(&s, &i) else { return };
            if ckanban_core::jsnum::truthy(t.json.get("parentChecked")) || t.part_of.is_some() || t.parent_id.is_some() {
                return;
            }
            let suggestion = suggestion.filter(|(p, _)| me.index.ticket(&s, p).is_some());
            let mut patch = Map::new();
            patch.insert("parentSuggestion".into(), suggestion.map_or(Value::Null, |(p, r)| json!({ "id": p, "reason": r })));
            patch.insert("parentChecked".into(), Value::Bool(true));
            if let Err(e) = me.tickets.patch(&s, &i, patch) {
                eprintln!("suggesting a parent for {s}/{i}: {e:?}");
            }
        })
        .await;
    }

    /// `find`: suggested parents for the board's open and recent tickets that have none. Changes nothing.
    pub async fn find(self: &Arc<Self>, slug: &str) -> Result<Value, String> {
        let me = self.clone();
        let s = slug.to_string();
        let list = tokio::task::spawn_blocking(move || candidates(me.board(&s, None), (me.now)())).await.map_err(|e| e.to_string())?;
        if list.len() < 2 {
            return Ok(json!({ "links": [], "checked": list.len() }));
        }
        let r = (self.side)(SideCallInput {
            system: FIND_SYSTEM.into(),
            prompt: find_prompt(&list),
            model: Some(FIND_MODEL.into()),
            timeout_ms: Some(240_000),
            ..Default::default()
        })
        .await;
        let text = match r {
            SideCallResult::Err { error, .. } => return Err(error),
            SideCallResult::Ok { text, .. } => text,
        };
        let links = parse_found(&text, &list).ok_or_else(|| "Claude's answer wasn't in the expected form; try again".to_string())?;
        Ok(json!({ "links": links, "checked": list.len() }))
    }
}
