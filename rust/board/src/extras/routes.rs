//! The R12 routes in board mode, after Bun's gate (Host, Origin, JSON body type: `rust/src/board_mode.rs`):
//! - `GET /api/profiles/:p/learned[?count=1]`, `POST .../learned/seen`, `.../learned/changes/:id/undo|redo`,
//!   `.../learned/lessons/:id/save|drop|keep` (`src/api/huddle-config.ts`): anyone reads, only the user changes.
//! - `POST /api/profiles/:p/find-links` (`src/api/profiles.ts`): the user only.
//! - `GET /api/profiles/:p/tickets/:id/usage` (`src/api/ticket-info.ts`).
//! - `GET /api/team-usage` (`src/api/system.ts`).

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::{json, Value};

use super::Extras;
use crate::runs::side_call::read_side_spend;

/// Whether these routes answer the request (`parts`: the decoded path after `/api/`).
pub fn claims(method: &str, parts: &[String]) -> bool {
    let p = |i: usize| parts.get(i).map(String::as_str);
    if p(0) == Some("team-usage") {
        return method == "GET";
    }
    if p(0) != Some("profiles") || parts.len() < 3 {
        return false;
    }
    match p(2) {
        Some("learned") => true,
        Some("find-links") => parts.len() == 3 && method == "POST",
        Some("tickets") => parts.len() == 5 && p(4) == Some("usage") && method == "GET",
        _ => false,
    }
}

pub struct Call<'a> {
    pub method: &'a str,
    pub parts: &'a [String],
    /// `?count=1`.
    pub count_only: bool,
    /// A board run's or huddle agent's header is on the request.
    pub from_run: bool,
    /// Whether the caller passes the user-only check (asked only for find-links).
    pub user: &'a (dyn Fn() -> BoxFuture<'static, bool> + Send + Sync),
    /// The plan usage answer (`usage.get()`), for a ticket's Usage tab.
    pub plan: &'a (dyn Fn() -> BoxFuture<'static, Value> + Send + Sync),
}

pub struct Answer {
    pub status: u16,
    pub value: Value,
}

fn ok(v: Value) -> Answer {
    Answer { status: 200, value: v }
}

fn fail(status: u16, m: impl Into<String>) -> Answer {
    Answer { status, value: json!({ "error": m.into() }) }
}

pub async fn answer(x: &Arc<Extras>, c: &Call<'_>) -> Answer {
    if c.parts[0] == "team-usage" {
        let x = x.clone();
        return match tokio::task::spawn_blocking(move || x.team_usage()).await {
            Ok(v) => ok(v),
            Err(e) => fail(500, e.to_string()),
        };
    }
    let slug = c.parts[1].as_str();
    let dir = ckanban_core::DataDir::new(x.root());
    if dir.profile(slug).is_none() {
        return fail(404, format!("board {slug} not found"));
    }
    match c.parts[2].as_str() {
        "learned" => learned(x, c, slug).await,
        "find-links" => {
            if !(c.user)().await {
                return fail(
                    403,
                    "Finding links is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board.",
                );
            }
            match x.linker.find(slug).await {
                Ok(v) => ok(v),
                Err(e) => fail(502, format!("Couldn't find links: {e}")),
            }
        }
        _ => ticket_usage(x, c, slug, &c.parts[3]).await,
    }
}

async fn learned(x: &Arc<Extras>, c: &Call<'_>, slug: &str) -> Answer {
    let l = &x.learner;
    let n = c.parts.len();
    if n == 3 && c.method == "GET" {
        let (l2, s2) = (l.clone(), slug.to_string());
        let v = tokio::task::spawn_blocking(move || l2.view(&s2)).await.unwrap_or(Value::Null);
        return ok(if c.count_only { json!({ "newCount": v["newCount"] }) } else { v });
    }
    if c.method != "POST" {
        return fail(404, "not found");
    }
    if c.from_run {
        return fail(403, "only the user changes what the board learned (Team, Learned)");
    }
    if n == 4 && c.parts[3] == "seen" {
        l.mark_seen(slug).await;
        let (l2, s2) = (l.clone(), slug.to_string());
        return ok(tokio::task::spawn_blocking(move || l2.view(&s2)).await.unwrap_or(Value::Null));
    }
    if n != 6 {
        return fail(404, "not found");
    }
    let (what, id, act) = (c.parts[3].as_str(), c.parts[4].as_str(), c.parts[5].as_str());
    let r = match (what, act) {
        ("changes", "undo" | "redo") => l.undo(id, act == "redo").await,
        ("lessons", "save") => l.save_now(id).await,
        ("lessons", "drop" | "keep") => l.drop_lesson(id, act == "keep").await,
        _ => return fail(404, "not found"),
    };
    match r {
        Ok(v) => ok(v),
        Err(e) => fail(e.0, e.1),
    }
}

async fn ticket_usage(x: &Arc<Extras>, c: &Call<'_>, slug: &str, id: &str) -> Answer {
    if x.core.index.ticket(slug, id).is_none() {
        return fail(404, format!("ticket {id} not found"));
    }
    let plan = (c.plan)().await;
    let window_error = if plan.get("windows").is_some() { None } else { plan.get("error").map(crate::runs::js::to_string) };
    let (x2, s2, i2) = (x.clone(), slug.to_string(), id.to_string());
    let read = tokio::task::spawn_blocking(move || {
        let dir = ckanban_core::DataDir::new(x2.root());
        let activity = x2.run_logs.entries(&dir.activity_path(&s2, &i2));
        let windows = ckanban_core::usage_windows::read_windows(&dir.usage_windows());
        let teammates = super::usage::teammate_spend(&x2.huddles.list(&s2), &i2);
        let side = read_side_spend(&dir.side_spend_path(&s2, &i2)).cost_usd;
        (activity, windows, teammates, side)
    })
    .await;
    let Ok((activity, windows, teammates, side)) = read else { return fail(500, "couldn't read the ticket's run log") };
    let now = ckanban_core::time::now_ms();
    let runs = super::usage::ticket_runs(&activity);
    let needed = super::usage::windows_needed(&runs, &windows, now);
    let mut machine = std::collections::HashMap::new();
    if !needed.is_empty() {
        let since = needed.iter().map(|&w| super::usage::window_span(&windows[w]).0).fold(f64::INFINITY, f64::min);
        x.claude_logs.refresh(since).await;
        for &w in &needed {
            let (a, b) = super::usage::window_span(&windows[w]);
            machine.insert(w, x.claude_logs.cost_between(a, b).await);
        }
    }
    ok(super::usage::ticket_usage(&activity, &windows, &|w| machine.get(&w).copied().unwrap_or(0.0), now, window_error.as_deref(), &teammates, side))
}

impl Extras {
    /// `Huddles.usage`: every teammate's and template's huddles on every board (blocking).
    pub fn team_usage(&self) -> Value {
        let dir = ckanban_core::DataDir::new(self.root());
        let mut input = Vec::new();
        for p in dir.list_profiles().unwrap_or_default() {
            let Some(slug) = p.slug().map(str::to_string) else { continue };
            for h in self.huddles.list(&slug).iter() {
                let host = h.get("hostTicket").and_then(Value::as_str).unwrap_or("");
                let title = self.core.index.ticket(&slug, host).map(|t| t.title.clone());
                input.push((slug.clone(), h.clone(), title));
            }
        }
        super::usage::huddle_usage(&input)
    }
}
