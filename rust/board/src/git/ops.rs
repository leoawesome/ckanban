//! What R6's board steps (ticket copies, merge into main, land, the PR poller and routes, the sweep) need from the
//! board itself. Bun reaches into `Board` and `Store` for these; here they are one trait, so this module builds and is
//! tested before the board exists. The board's write API (R2a) and run loop (R7a) implement it; tests use an
//! in-memory board. Tickets and profiles are their JSON (the ticket file's front matter, `profile.json`).

use futures_util::future::BoxFuture;
use serde_json::{Map, Value};

use crate::api::Failure;

pub trait BoardOps: Send + Sync {
    /// `store.getProfile(slug)`.
    fn profile(&self, slug: &str) -> Option<Value>;
    /// `store.listProfiles()`.
    fn profiles(&self) -> Vec<Value>;
    /// `store.saveProfile` and the `profile.updated` event.
    fn save_profile(&self, profile: Value);
    /// `store.getTicket(slug, id)`.
    fn ticket(&self, slug: &str, id: &str) -> Option<Value>;
    /// `store.listTickets(slug)`: the board's current snapshot.
    fn tickets(&self, slug: &str) -> Vec<Value>;
    /// `board.patch`: merges the fields into the ticket file and emits `ticket.updated`; the ticket after it.
    fn patch(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Result<Value, Failure>;
    /// `board.updateTicket(slug, id, {status})`: a column move with its side effects (Done cleans up the copy...).
    fn move_to(&self, slug: &str, id: &str, status: &str) -> BoxFuture<'_, Result<(), Failure>>;
    /// `store.listComments`.
    fn comments(&self, slug: &str, id: &str) -> Vec<Value>;
    /// `store.addComment(slug, id, author, text)`.
    fn add_comment(&self, slug: &str, id: &str, author: &str, text: &str);
    /// `board.pushEvent`: queue a line for a main ticket's next wake.
    fn push_event(&self, slug: &str, planner_id: &str, line: &str);
    /// `board.emitTicket`: a `ticket.updated` event for the ticket as it is now.
    fn emit_ticket(&self, slug: &str, id: &str);
    /// `board.mainOf`: the first main ticket up the ticket's links (itself included).
    fn main_of(&self, slug: &str, id: &str) -> Option<Value>;
    /// A run, a setup or a copy being made for the ticket right now (the sweep leaves it alone).
    fn busy(&self, slug: &str, id: &str) -> bool;
    /// `board.isRunning`.
    fn is_running(&self, slug: &str, id: &str) -> bool;
    /// The card still needs the user (`waitsOnUser`, an open huddle, `holdsReview`): a merged PR keeps it in Review.
    fn holds_review(&self, slug: &str, id: &str) -> bool;
    /// `board.chat(slug, id, text)` from the board itself; the ticket after it.
    fn chat(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<Value, Failure>>;
    /// A Claude session file exists for this id (`sessionExists`).
    fn session_exists(&self, session_id: &str) -> bool;
    /// `land_milestone`'s record: the milestone in the feature's status file, `statusAt`, and its comment.
    fn record_milestone(&self, slug: &str, id: &str, summary: &str, landed: &str) -> Result<(), Failure>;
    /// The package trim's candidates (`trim.rs`): Done tickets that still have a copy and weren't trimmed. The board
    /// answers from its index; this default goes over `tickets`. Blocking: call it on the blocking pool.
    fn trim_candidates(&self, slug: &str) -> Vec<super::trim::Candidate> {
        self.tickets(slug).iter().filter_map(|t| t.as_object().and_then(super::trim::candidate)).collect()
    }
}

/// A string field of a ticket or profile.
pub fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// A non-empty string field (`t.branch && ...`).
pub fn set<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    s(v, key).filter(|x| !x.is_empty())
}

/// JS truthiness of a field.
pub fn truthy(v: &Value, key: &str) -> bool {
    ckanban_core::jsnum::truthy(v.get(key))
}

/// A one-field patch.
pub fn patch1(key: &str, v: Value) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(key.into(), v);
    m
}

#[cfg(test)]
pub(crate) mod mem {
    //! An in-memory board for the tests of this module.
    use super::*;
    use parking_lot::Mutex;
    use std::collections::HashMap;

    #[derive(Default)]
    pub struct MemBoard {
        pub profiles: Mutex<Vec<Value>>,
        pub tickets: Mutex<HashMap<(String, String), Value>>,
        pub order: Mutex<Vec<(String, String)>>,
        pub comments: Mutex<Vec<(String, String, String, String)>>,
        pub events: Mutex<Vec<(String, String, String)>>,
        pub chats: Mutex<Vec<(String, String, String)>>,
        pub moves: Mutex<Vec<(String, String, String)>>,
        pub milestones: Mutex<Vec<(String, String, String, String)>>,
        pub running: Mutex<Vec<String>>,
        pub holds: Mutex<Vec<String>>,
        pub sessions: Mutex<Vec<String>>,
    }

    impl MemBoard {
        pub fn add_profile(&self, p: Value) {
            self.profiles.lock().push(p);
        }
        pub fn add(&self, slug: &str, t: Value) {
            let id = t["id"].as_str().unwrap().to_string();
            self.order.lock().push((slug.into(), id.clone()));
            self.tickets.lock().insert((slug.into(), id), t);
        }
        pub fn get(&self, slug: &str, id: &str) -> Value {
            self.ticket(slug, id).unwrap()
        }
        pub fn comment_texts(&self, id: &str) -> Vec<String> {
            self.comments.lock().iter().filter(|c| c.1 == id).map(|c| c.3.clone()).collect()
        }
    }

    impl BoardOps for MemBoard {
        fn profile(&self, slug: &str) -> Option<Value> {
            self.profiles.lock().iter().find(|p| p["slug"] == slug).cloned()
        }
        fn profiles(&self) -> Vec<Value> {
            self.profiles.lock().clone()
        }
        fn save_profile(&self, profile: Value) {
            let mut ps = self.profiles.lock();
            if let Some(p) = ps.iter_mut().find(|p| p["slug"] == profile["slug"]) {
                *p = profile;
            }
        }
        fn ticket(&self, slug: &str, id: &str) -> Option<Value> {
            self.tickets.lock().get(&(slug.to_string(), id.to_string())).cloned()
        }
        fn tickets(&self, slug: &str) -> Vec<Value> {
            let order = self.order.lock().clone();
            order.iter().filter(|(s, _)| s == slug).filter_map(|(s, i)| self.ticket(s, i)).collect()
        }
        fn patch(&self, slug: &str, id: &str, patch: Map<String, Value>) -> Result<Value, Failure> {
            let mut ts = self.tickets.lock();
            let t = ts.get_mut(&(slug.to_string(), id.to_string())).ok_or("not found")?;
            for (k, v) in patch {
                t[k] = v;
            }
            Ok(t.clone())
        }
        fn move_to(&self, slug: &str, id: &str, status: &str) -> BoxFuture<'_, Result<(), Failure>> {
            self.moves.lock().push((slug.into(), id.into(), status.into()));
            let r = self.patch(slug, id, patch1("status", Value::from(status))).map(|_| ());
            Box::pin(async move { r })
        }
        fn comments(&self, _slug: &str, id: &str) -> Vec<Value> {
            self.comments.lock().iter().filter(|c| c.1 == id).map(|c| serde_json::json!({ "author": c.2, "text": c.3 })).collect()
        }
        fn add_comment(&self, slug: &str, id: &str, author: &str, text: &str) {
            self.comments.lock().push((slug.into(), id.into(), author.into(), text.into()));
        }
        fn push_event(&self, slug: &str, planner_id: &str, line: &str) {
            self.events.lock().push((slug.into(), planner_id.into(), line.into()));
        }
        fn emit_ticket(&self, _: &str, _: &str) {}
        fn main_of(&self, slug: &str, id: &str) -> Option<Value> {
            let mut cur = self.ticket(slug, id);
            let mut seen = Vec::new();
            while let Some(t) = cur {
                let tid = t["id"].as_str().unwrap_or_default().to_string();
                if seen.contains(&tid) {
                    return None;
                }
                seen.push(tid);
                if truthy(&t, "main") {
                    return Some(t);
                }
                cur = s(&t, "parentId").and_then(|p| self.ticket(slug, p));
            }
            None
        }
        fn busy(&self, _: &str, id: &str) -> bool {
            self.running.lock().iter().any(|r| r == id)
        }
        fn is_running(&self, _: &str, id: &str) -> bool {
            self.running.lock().iter().any(|r| r == id)
        }
        fn holds_review(&self, _: &str, id: &str) -> bool {
            self.holds.lock().iter().any(|r| r == id)
        }
        fn chat(&self, slug: &str, id: &str, text: &str) -> BoxFuture<'_, Result<Value, Failure>> {
            self.chats.lock().push((slug.into(), id.into(), text.into()));
            let t = self.ticket(slug, id).ok_or_else(|| "not found".to_string());
            Box::pin(async move { t })
        }
        fn session_exists(&self, session_id: &str) -> bool {
            self.sessions.lock().iter().any(|s| s == session_id)
        }
        fn record_milestone(&self, slug: &str, id: &str, summary: &str, landed: &str) -> Result<(), Failure> {
            self.milestones.lock().push((slug.into(), id.into(), summary.into(), landed.into()));
            self.add_comment(slug, id, "ai", &format!("Milestone landed: {summary} ({landed})."));
            Ok(())
        }
    }
}
