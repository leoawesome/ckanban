//! The board's read routes (`GET` only), answered from the index: `/api/profiles`, `/api/profiles/:p`,
//! `/api/profiles/:p/tickets?scope=…`, `/api/profiles/:p/tickets/:id`, `/api/tickets` and `/api/inbox`
//! (`src/api/tickets-list.ts`, `tickets.ts`, `profiles.ts`, `inbox.ts`). Blocking (file stats and reads): call
//! `answer` off the async runtime. Answers are JSON values; the server masks saved keys in their text, as Bun's
//! `json()` does.

use std::sync::Arc;

use ckanban_core::home::DataDir;
use serde_json::{Map, Value, json};

use super::cmdbar::{CMD_SEARCH_LIMIT, CmdRow, DoneSearch, with_main};
use super::family::{feature_root, main_of};
use super::links::Comments;
use super::scope::{DONE_PAGE, ListQuery, board_scope, count_scope, done_page, done_search, ids_scope, list_scope};
use super::store::{BoardList, Index};
use super::text::js_trim;
use super::ticket::Tk;
use super::view::{Live, Viewer, attention_of};

pub const STATUSES: [&str; 6] = ["backlog", "planning", "ready", "in_progress", "review", "done"];

/// An answer: status and JSON body.
pub type Answer = (u16, Value);

fn error(status: u16, msg: impl Into<String>) -> Answer {
    (status, json!({ "error": msg.into() }))
}

/// `URLSearchParams.get`: the first value, form-decoded.
pub fn param(query: &str, name: &str) -> Option<String> {
    query.split('&').filter(|p| !p.is_empty()).find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (form_decode(k) == name).then(|| form_decode(v))
    })
}

fn form_decode(s: &str) -> String {
    let s = s.replace('+', " ");
    percent_encoding::percent_decode_str(&s).decode_utf8_lossy().into_owned()
}

/// `Number(x) || 0`.
pub fn js_number(s: Option<&str>) -> f64 {
    let Some(s) = s else { return 0.0 };
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let n = match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if t.len() > 2 && (t.starts_with("0x") || t.starts_with("0X")) => u64::from_str_radix(&t[2..], 16).map(|n| n as f64).unwrap_or(f64::NAN),
        _ if t.len() > 2 && (t.starts_with("0o") || t.starts_with("0O")) => u64::from_str_radix(&t[2..], 8).map(|n| n as f64).unwrap_or(f64::NAN),
        _ if t.len() > 2 && (t.starts_with("0b") || t.starts_with("0B")) => u64::from_str_radix(&t[2..], 2).map(|n| n as f64).unwrap_or(f64::NAN),
        _ if t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-')) => t.parse::<f64>().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if n.is_nan() || n == 0.0 { 0.0 } else { n }
}

/// `(get(k) ?? "").split(",").map(trim).filter(Boolean)`.
fn list_param(query: &str, k: &str) -> Vec<String> {
    param(query, k).unwrap_or_default().split(',').map(|s| js_trim(s).to_string()).filter(|s| !s.is_empty()).collect()
}

/// `pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent)`; None when a part doesn't decode.
pub fn path_parts(path: &str) -> Option<Vec<String>> {
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    parts.next()?;
    parts.map(|p| percent_encoding::percent_decode_str(p).decode_utf8().ok().map(|c| c.into_owned())).collect()
}

/// The read routes over the index, with live state from `live`.
pub struct Reads {
    pub index: Arc<Index>,
    pub viewer: Viewer,
    pub live: Arc<dyn Live>,
}

impl Reads {
    pub fn new(index: Arc<Index>, live: Arc<dyn Live>) -> Reads {
        Reads { viewer: Viewer::new(index.clone()), index, live }
    }

    fn data(&self) -> DataDir {
        DataDir::new(self.index.root().to_path_buf())
    }

    fn comments(&self) -> &Comments {
        &self.viewer.comments
    }

    /// The answer to `GET <path>?<query>` when it is one of these routes; None: it goes on (to Bun).
    pub fn answer(&self, path: &str, query: &str) -> Option<Answer> {
        if !path.starts_with("/api/") {
            return None;
        }
        let parts = path_parts(path)?;
        match parts.first().map(String::as_str) {
            Some("inbox") => Some(self.inbox()),
            Some("tickets") if parts.len() == 1 => Some(self.tickets(query)),
            Some("profiles") => self.profiles(&parts, query),
            _ => None,
        }
    }

    fn profiles(&self, parts: &[String], query: &str) -> Option<Answer> {
        if parts.len() == 1 {
            return Some(self.profile_list());
        }
        let slug = parts[1].as_str();
        if parts.len() > 2 && parts[2] != "tickets" {
            return None;
        }
        if parts.len() > 4 {
            return None;
        }
        let Some(profile) = self.data().profile(slug) else { return Some(error(404, format!("board {slug} not found"))) };
        let p = profile.record.0;
        match parts.len() {
            2 => Some((200, Value::Object(p))),
            3 => Some(self.ticket_list(slug, &p, query)),
            _ => {
                let id = parts[3].as_str();
                let list = self.index.list(slug);
                let Some(t) = self.index.ticket(slug, id) else { return Some(error(404, format!("ticket {id} not found"))) };
                let list = if list.get(id).is_some_and(|x| !Arc::ptr_eq(x, &t)) { self.index.list(slug) } else { list };
                Some((200, Value::Object(self.viewer.view(slug, &p, &list, &t, &*self.live))))
            }
        }
    }

    fn profile_list(&self) -> Answer {
        let profiles = self.data().list_profiles().unwrap_or_default();
        let out = profiles
            .into_iter()
            .map(|p| {
                let slug = p.slug().unwrap_or("").to_string();
                let mut m = p.record.0;
                let exists = m.get("path").and_then(Value::as_str).is_some_and(|x| std::path::Path::new(x).exists());
                m.insert("pathExists".into(), exists.into());
                m.insert("running".into(), self.live.board_running(&slug).into());
                Value::Object(m)
            })
            .collect();
        (200, Value::Array(out))
    }

    /// One row of a list answer: the view, with `feature: true` for an open feature's top ticket.
    fn row(&self, slug: &str, p: &Map<String, Value>, list: &BoardList, t: &Tk) -> Value {
        let mut v = self.viewer.view(slug, p, list, t, &*self.live);
        if list.features().contains(&t.id) {
            v.insert("feature".into(), true.into());
        }
        Value::Object(v)
    }

    fn rows(&self, slug: &str, p: &Map<String, Value>, list: &BoardList, idx: &[usize]) -> Value {
        Value::Array(idx.iter().map(|&i| self.row(slug, p, list, list.at(i))).collect())
    }

    /// `GET /api/profiles/:p/tickets`.
    pub fn ticket_list(&self, slug: &str, p: &Map<String, Value>, query: &str) -> Answer {
        let list = self.index.list(slug);
        let scope = param(query, "scope").filter(|s| !s.is_empty());
        let Some(scope) = scope else {
            let all: Vec<usize> = (0..list.tickets.len()).collect();
            return (200, self.rows(slug, p, &list, &all));
        };
        let num = |k: &str| js_number(param(query, k).as_deref());
        match scope.as_str() {
            "count" => {
                let (total, open, done_total) = count_scope(&list);
                (200, json!({ "total": total, "open": open, "doneTotal": done_total }))
            }
            "list" => {
                let status = param(query, "status");
                if let Some(s) = status.as_deref().filter(|s| !s.is_empty()) {
                    if !STATUSES.contains(&s) {
                        return error(400, format!("status must be one of {}", STATUSES.join(", ")));
                    }
                }
                let tags = list_param(query, "tags");
                let q = param(query, "q");
                let after = param(query, "after");
                let page = list_scope(&list, &ListQuery {
                    status: status.as_deref(),
                    tool: param(query, "tool").as_deref() == Some("1"),
                    q: q.as_deref(),
                    tags: &tags,
                    limit: num("limit"),
                    after: after.as_deref(),
                });
                let mut m = Map::new();
                m.insert("tickets".into(), self.rows(slug, p, &list, &page.tickets));
                m.insert("total".into(), page.total.into());
                m.insert("matched".into(), page.matched.into());
                m.insert("doneLeft".into(), page.done_left.into());
                m.insert("next".into(), page.next.map(Value::String).unwrap_or(Value::Null));
                (200, Value::Object(m))
            }
            "board" | "done" | "search" | "ids" => {
                let after = param(query, "after");
                let picked = match scope.as_str() {
                    "board" => board_scope(&list, num("done"), &list_param(query, "ids"), after.as_deref().filter(|a| !a.is_empty())),
                    "done" => {
                        let limit = num("limit");
                        done_page(&list, num("offset"), if limit == 0.0 { DONE_PAGE as f64 } else { limit }, after.as_deref().filter(|a| !a.is_empty()))
                    }
                    "search" => done_search(&list, &param(query, "q").unwrap_or_default(), &list_param(query, "tags")),
                    _ => ids_scope(&list, &list_param(query, "ids")),
                };
                let mut m = Map::new();
                m.insert("tickets".into(), self.rows(slug, p, &list, &picked.tickets));
                m.insert("doneTotal".into(), picked.done_total.into());
                if let Some(h) = picked.done_head {
                    m.insert("doneHead".into(), h.map(Value::String).unwrap_or(Value::Null));
                }
                (200, Value::Object(m))
            }
            _ => error(400, "scope must be board, done, search, ids, list or count"),
        }
    }

    /// `GET /api/inbox`: every board's tickets that need the user, oldest first.
    pub fn inbox(&self) -> Answer {
        let mut out: Vec<(String, Value)> = Vec::new();
        for profile in self.data().list_profiles().unwrap_or_default() {
            let Some(slug) = profile.slug().map(str::to_string) else { continue };
            let name = profile.name();
            let list = self.index.list(&slug);
            for &i in list.inboxable() {
                let t = list.at(i);
                let session = match t.s("sessionId") {
                    Some(s) if !s.is_empty() => self.live.session(s),
                    _ => None,
                };
                let (attention, snoozed) = attention_of(self.index.root(), &slug, &list, t, &*self.live, session.as_ref());
                let base = |a: Value| {
                    let mut m = Map::new();
                    m.insert("profile".into(), slug.clone().into());
                    m.insert("profileName".into(), name.clone());
                    m.insert("id".into(), t.id.clone().into());
                    m.insert("title".into(), t.json.get("title").cloned().unwrap_or(Value::Null));
                    m.insert("attention".into(), a);
                    m
                };
                if !attention.is_null() {
                    let since = attention.get("since").and_then(Value::as_str).unwrap_or("").to_string();
                    out.push((since, Value::Object(base(attention))));
                } else if !snoozed.is_null() {
                    let a = snoozed.get("attention").cloned().unwrap_or(Value::Null);
                    let since = a.get("since").and_then(Value::as_str).unwrap_or("").to_string();
                    let mut m = base(a);
                    m.insert("snoozedUntil".into(), snoozed.get("until").cloned().unwrap_or(Value::Null));
                    out.push((since, Value::Object(m)));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        (200, Value::Array(out.into_iter().map(|x| x.1).collect()))
    }

    fn cmd_row(&self, slug: &str, name: &Value, t: &Tk) -> CmdRow {
        let summary = self.comments().last_ai(&self.index.ticket_dir(slug, &t.id));
        CmdRow::new(slug, name, t, self.live.running(slug, &t.id), summary)
    }

    /// `GET /api/tickets`: the command bar's rows (scope=open, scope=done&q=…) or a light row per ticket.
    pub fn tickets(&self, query: &str) -> Answer {
        let profiles = self.data().list_profiles().unwrap_or_default();
        let boards: Vec<(String, Value)> = profiles.iter().filter_map(|p| p.slug().map(|s| (s.to_string(), p.name()))).collect();
        match param(query, "scope").filter(|s| !s.is_empty()).as_deref() {
            Some("open") => {
                let mut out = Vec::new();
                for (slug, name) in &boards {
                    let list = self.index.list(slug);
                    for &i in list.open() {
                        let t = list.at(i);
                        out.push(with_main(self.cmd_row(slug, name, t), t, &list).to_json());
                    }
                }
                (200, Value::Array(out))
            }
            Some("done") => {
                let q = param(query, "q").unwrap_or_default();
                let current = param(query, "board");
                let query_text = js_trim(&q).to_string();
                if query_text.is_empty() {
                    return (200, json!([]));
                }
                let lim = js_number(param(query, "limit").as_deref()).floor();
                let lim = if lim.is_nan() || lim == 0.0 { CMD_SEARCH_LIMIT as f64 } else { lim };
                let n = lim.clamp(1.0, 50.0) as usize;
                let mut search = DoneSearch { query: &query_text, current: current.as_deref(), n, best: Vec::new() };
                for (slug, name) in &boards {
                    let list = self.index.list(slug);
                    let mut chunk: Vec<(CmdRow, &Tk)> = Vec::new();
                    for t in list.tickets.iter().filter(|t| t.status == "done") {
                        chunk.push((self.cmd_row(slug, name, t), t));
                        if chunk.len() >= DoneSearch::chunk_size() {
                            search.flush(std::mem::take(&mut chunk), &list);
                        }
                    }
                    search.flush(chunk, &list);
                }
                (200, Value::Array(search.best.iter().map(CmdRow::to_json).collect()))
            }
            Some(_) => error(400, "scope must be open or done"),
            None => {
                let mut out = Vec::new();
                for (slug, name) in &boards {
                    let list = self.index.list(slug);
                    for t in &list.tickets {
                        let mut row = self.cmd_row(slug, name, t);
                        if t.tool {
                            let main = main_of(&list, t).or_else(|| feature_root(&list, &t.id));
                            row.main_ticket = Some(main.filter(|&m| list.at(m).id != t.id).map(|m| (list.at(m).id.clone(), list.at(m).title.clone())));
                        }
                        out.push(row.to_json());
                    }
                }
                (200, Value::Array(out))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_and_numbers_like_js() {
        assert_eq!(param("scope=board&ids=a%2Cb,+c", "ids").as_deref(), Some("a,b, c"));
        assert_eq!(list_param("ids=a%2Cb,+c,,", "ids"), ["a", "b", "c"]);
        assert_eq!(js_number(Some(" 5 ")), 5.0);
        assert_eq!(js_number(Some("abc")), 0.0);
        assert_eq!(js_number(Some("0x10")), 16.0);
        assert_eq!(js_number(Some("inf")), 0.0);
        assert_eq!(js_number(None), 0.0);
        assert_eq!(path_parts("/api/profiles//b%20x/tickets").unwrap(), ["profiles", "b x", "tickets"]);
        assert!(path_parts("/api/profiles/%E0%A4").is_none());
    }
}
