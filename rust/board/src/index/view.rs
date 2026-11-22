//! `TicketView` (`view()` in `src/api/context.ts`): the ticket's file fields plus what the board works out for its
//! card. Live state (runs, sessions, huddles, devices, publishing, spending) comes through `Live`: in board mode from
//! the services (`ServicesLive`, stand-ins until their tasks land), in shadow mode from Bun's own answer.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use ckanban_core::home::DataDir;
use ckanban_core::jsnum::{num, truthy};
use ckanban_core::spend::SpendIndex;
use ckanban_core::time::now_ms;
use regex::Regex;
use serde_json::{Map, Value, json};

use super::attention::{huddle_ask, huddle_busy, is_complete, ticket_attention, user_wait_reason, with_snooze};
use super::card::{family_card, family_working, steps_running};
use super::family::{family_below, feature_root, feature_rows, main_of, parent_in};
use super::links::{Comments, collect_links};
use super::store::{BoardList, Index};
use super::ticket::Tk;
use crate::core::Services;

/// The live state a view needs, per ticket.
pub trait Live: Send + Sync {
    fn running(&self, slug: &str, id: &str) -> bool;
    fn holds_slot(&self, slug: &str, id: &str) -> bool;
    /// The board's working runs now (`Board.running(slug)`), for the boards list.
    fn board_running(&self, slug: &str) -> usize;
    /// The session's summary (`SessionSummary`), None when unknown.
    fn session(&self, session_id: &str) -> Option<Value>;
    /// The ticket's open huddle (`HostHuddle`), None without one.
    fn host(&self, slug: &str, id: &str) -> Option<Value>;
    fn devices(&self, slug: &str, id: &str) -> Value;
    fn share_jobs(&self, slug: &str, id: &str) -> Vec<Value>;
    fn terminal_open(&self, slug: &str, id: &str) -> bool;
    fn folder_wait(&self, slug: &str, ticket: &Tk) -> bool;
    /// `folderShare`: `{others, offer}` while its run shares the folder with other running tickets, else null.
    fn folder_share(&self, _slug: &str, _ticket: &Tk) -> Value {
        Value::Null
    }
    /// The ticket's own runs and side calls so far (`spend.ticketSoon`).
    fn cost(&self, slug: &str, id: &str) -> f64;
    /// Its huddles' teammates' spend (`huddles.ticketSpend`).
    fn huddle_spend(&self, slug: &str, id: &str) -> f64;
    /// Its huddle teammates' session artifacts, by handle.
    fn teammate_artifacts(&self, slug: &str, id: &str) -> Vec<(String, Vec<Value>)>;
}

/// Live state from the board's services (board mode).
pub struct ServicesLive {
    pub services: Services,
    pub spend: Arc<SpendIndex>,
}

impl ServicesLive {
    pub fn new(root: &Path, services: Services) -> ServicesLive {
        ServicesLive { services, spend: Arc::new(SpendIndex::new(DataDir::new(root.to_path_buf()))) }
    }
}

impl Live for ServicesLive {
    fn running(&self, slug: &str, id: &str) -> bool {
        self.services.runs.is_running(slug, id)
    }
    fn holds_slot(&self, slug: &str, id: &str) -> bool {
        self.services.runs.holds_slot(slug, id)
    }
    fn board_running(&self, slug: &str) -> usize {
        let runs = &self.services.runs;
        runs.running_tickets().iter().filter(|(s, id)| s == slug && runs.holds_slot(s, id)).count()
    }
    fn session(&self, session_id: &str) -> Option<Value> {
        self.services.sessions.summary(session_id)
    }
    fn host(&self, slug: &str, id: &str) -> Option<Value> {
        self.services.huddles.host_states(slug).remove(id)
    }
    fn devices(&self, slug: &str, id: &str) -> Value {
        self.services.devices.device_state(slug, id).unwrap_or(Value::Null)
    }
    fn share_jobs(&self, slug: &str, id: &str) -> Vec<Value> {
        self.services.satellite.share_jobs(slug, id)
    }
    fn terminal_open(&self, slug: &str, id: &str) -> bool {
        self.services.devices.terminal_open(slug, id)
    }
    fn folder_wait(&self, slug: &str, ticket: &Tk) -> bool {
        self.services.runs.folder_wait(slug, &Value::Object(ticket.json.clone()))
    }
    fn folder_share(&self, slug: &str, ticket: &Tk) -> Value {
        self.services.runs.folder_share(slug, &Value::Object(ticket.json.clone()))
    }
    fn cost(&self, slug: &str, id: &str) -> f64 {
        self.spend.ticket(slug, id).cost_usd
    }
    fn huddle_spend(&self, slug: &str, id: &str) -> f64 {
        self.services.huddles.ticket_spend(slug, id)
    }
    fn teammate_artifacts(&self, slug: &str, id: &str) -> Vec<(String, Vec<Value>)> {
        self.services
            .huddles
            .teammates(slug, id)
            .into_iter()
            .map(|(handle, sid)| {
                let arts = match self.services.sessions.summary(&sid).and_then(|s| s.get("artifacts").cloned()) {
                    Some(Value::Array(a)) => a,
                    _ => Vec::new(),
                };
                (handle, arts)
            })
            .collect()
    }
}

/// Builds views; one per server (board mode) or per shadow check.
pub struct Viewer {
    pub index: Arc<Index>,
    pub comments: Arc<Comments>,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `t.workdir ?? t.worktree ?? p.path` as text.
fn coalesce(vals: &[Option<&Value>]) -> String {
    for v in vals {
        match v {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) => return s.clone(),
            Some(x) => return x.to_string(),
        }
    }
    "undefined".into()
}

/// `recoveryFor`: run errors the board offers a one-click fix for.
fn recovery_for(error: Option<&str>) -> Value {
    const SESSION_OPEN_MSG: &str = "This ticket's Claude session is still open in a terminal. Exit it there (Ctrl+D or /exit), then try again.";
    let Some(e) = error.filter(|e| !e.is_empty()) else { return Value::Null };
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)No conversation found with session ID").expect("valid regex"));
    if re.is_match(e) {
        return "session_missing".into();
    }
    if e == SESSION_OPEN_MSG {
        return "session_open".into();
    }
    Value::Null
}

fn valid_chrome_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// `ownPicks`: a ticket's own browser list, else its old single Chrome setting.
fn own_picks(t: &Tk) -> Option<Value> {
    if let Some(Value::Array(a)) = t.get("browsers") {
        if !a.is_empty() {
            return Some(Value::Array(a.clone()));
        }
    }
    let chrome = t.s("chrome").filter(|c| !c.is_empty())?;
    if chrome == "ask" {
        return Some(json!([{ "kind": "ask" }]));
    }
    valid_chrome_id(chrome).then(|| json!([{ "kind": "chrome", "id": chrome }]))
}

/// `resolveBrowserPicks({id, parentId}, all, null)`: the nearest ticket above it (by plan links) that set browsers.
fn browsers_above(list: &BoardList, t: &Tk) -> Value {
    let mut seen = HashSet::new();
    seen.insert(t.id.clone());
    let mut up = t.parent_id.clone();
    while let Some(id) = up {
        let Some(cur) = list.get(&id) else { break };
        if let Some(p) = own_picks(cur) {
            return p;
        }
        if !seen.insert(cur.id.clone()) {
            break;
        }
        up = cur.parent_id.clone();
    }
    Value::Null
}

/// `legacyChrome`: the first Claude in Chrome pick of a list.
fn legacy_chrome(picks: &Value) -> Value {
    let Value::Array(a) = picks else { return Value::Null };
    match a.iter().find(|p| matches!(p.get("kind").and_then(Value::as_str), Some("ask") | Some("chrome"))) {
        None => Value::Null,
        Some(p) if p.get("kind").and_then(Value::as_str) == Some("ask") => "ask".into(),
        Some(p) => p.get("id").cloned().unwrap_or(Value::Null),
    }
}

/// `runCapFor`: the spending cap its next work run gets.
fn run_cap(t: &Tk, p: &Map<String, Value>) -> Value {
    let pos = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0);
    if pos(t.get("capNextUsd")).is_some() {
        return t.get("capNextUsd").cloned().unwrap_or(Value::Null);
    }
    if t.get("runCapUsd").and_then(Value::as_f64) == Some(0.0) {
        return Value::Null;
    }
    match pos(t.get("runCapUsd")) {
        Some(_) => t.get("runCapUsd").cloned().unwrap_or(Value::Null),
        None => match pos(p.get("runCapUsd")) {
            Some(_) => p.get("runCapUsd").cloned().unwrap_or(Value::Null),
            None => Value::Null,
        },
    }
}

/// `Math.round(x * 100) / 100`.
pub fn cents(x: f64) -> f64 {
    (x * 100.0 + 0.5).floor() / 100.0
}

/// The schedules' ids of a board (only asked when a session waits on deleting one).
pub fn schedule_ids(root: &Path, slug: &str) -> HashSet<String> {
    std::fs::read_dir(root.join("profiles").join(slug).join("schedules"))
        .map(|d| {
            d.flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| ckanban_core::json_dir::id_json(n))
                .map(|n| n.trim_end_matches(".json").to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// A task of main ticket `t` that has no card of its own (and no card between it and `t`) would start now but waits
/// for the folder ("One ticket at a time in my folder"). Walks `t`'s own feature only (a sub-feature is its own card);
/// `folder_wait` answers at once for a task that isn't about to start, so a big family costs index lookups.
fn task_waits_for_folder(slug: &str, list: &BoardList, t: &Tk, live: &dyn Live) -> bool {
    feature_rows(list, &t.id).iter().any(|r| {
        let x = list.at(r.idx);
        if x.id == t.id || x.on_board() || x.status == "done" || !live.folder_wait(slug, x) {
            return false;
        }
        // Its card is `t`: no shown ticket between them.
        let mut cur = x;
        for _ in 0..8 {
            match parent_in(list, cur) {
                Some((p, _)) if list.at(p).id == t.id => return true,
                Some((p, _)) if !list.at(p).on_board() => cur = list.at(p),
                _ => return false,
            }
        }
        false
    })
}

/// What a ticket waits on the user for, before and after its snooze: (attention, snoozed).
pub fn attention_of(root: &Path, slug: &str, list: &BoardList, t: &Tk, live: &dyn Live, session: Option<&Value>) -> (Value, Value) {
    let running = live.running(slug, &t.id);
    let host = live.host(slug, &t.id);
    let is_running = |x: &str| live.running(slug, x);
    let a = ticket_attention(list, t, session, running, host.as_ref(), &is_running, &|| schedule_ids(root, slug));
    let (a, z) = with_snooze(t, session, a, now_ms(), host.as_ref());
    (
        a.map(|a| a.to_json()).unwrap_or(Value::Null),
        z.map(|(a, until)| json!({ "attention": a.to_json(), "until": until })).unwrap_or(Value::Null),
    )
}

impl Viewer {
    pub fn new(index: Arc<Index>) -> Viewer {
        Viewer { index, comments: Arc::new(Comments::default()) }
    }

    /// The family's spend so far, rounded to cents (`Board.familyCard`'s cost).
    fn family_cost(&self, slug: &str, list: &BoardList, id: &str, live: &dyn Live) -> f64 {
        let cost: f64 = family_below(list, id).into_iter().map(|i| live.cost(slug, &list.at(i).id) + live.huddle_spend(slug, &list.at(i).id)).sum();
        cents(cost)
    }

    /// The ticket's `TicketView`. profile: the board's `profile.json`; list: the board's listing (families).
    pub fn view(&self, slug: &str, profile: &Map<String, Value>, list: &BoardList, t: &Tk, live: &dyn Live) -> Map<String, Value> {
        let root = self.index.root();
        let id = t.id.as_str();
        let running = live.running(slug, id);
        let sid = t.s("sessionId").filter(|s| !s.is_empty());
        let session = if truthy(t.get("sessionId")) { sid.and_then(|s| live.session(s)) } else { None };
        let host = live.host(slug, id);
        let (attention, snoozed) = attention_of(root, slug, list, t, live, session.as_ref());
        let dir = self.index.ticket_dir(slug, id);
        let results = self.comments.ai(&dir);
        let links = collect_links(session.as_ref().and_then(|s| s.get("artifacts")), &live.teammate_artifacts(slug, id), &results, t.get("shareLinks"));
        let resume = match sid {
            Some(s) if truthy(t.get("sessionId")) => {
                Value::String(format!("cd {} && claude --resume {s}", shell_quote(&coalesce(&[t.get("workdir"), t.get("worktree"), profile.get("path")]))))
            }
            _ => Value::Null,
        };
        let huddle_works = !running && t.status != "in_progress" && huddle_busy(host.as_ref()) && huddle_ask(host.as_ref()).is_none();
        let above = if t.parent_id.is_some() { browsers_above(list, t) } else { Value::Null };
        let mut m = t.json.clone();
        m.insert("running".into(), running.into());
        m.insert("holdsSlot".into(), (running && live.holds_slot(slug, id)).into());
        m.insert("resumeCommand".into(), resume);
        m.insert("session".into(), session.clone().unwrap_or(Value::Null));
        m.insert("links".into(), links);
        m.insert("outputDir".into(), dir.join("outputs").to_string_lossy().into_owned().into());
        m.insert("shareJobs".into(), Value::Array(live.share_jobs(slug, id)));
        m.insert("canCopyFile".into(), (cfg!(target_os = "macos") || std::env::var("CKANBAN_OSASCRIPT_BIN").is_ok_and(|v| !v.is_empty())).into());
        m.insert("terminalOpen".into(), live.terminal_open(slug, id).into());
        m.insert("recovery".into(), if running { Value::Null } else { recovery_for(t.s("error")) });
        m.insert("devices".into(), live.devices(slug, id));
        m.insert("chromeAbove".into(), legacy_chrome(&above));
        m.insert("browsersAbove".into(), above);
        m.insert("folderWait".into(), live.folder_wait(slug, t).into());
        // On every card, null when it doesn't share the folder: the board merges each update into the card it has, so
        // the pill goes once its sharing ends. A main ticket shares through its tasks' runs too, while not running
        // itself. A finished ticket with no run is skipped at once (most of a big board).
        let share = if t.status == "done" && !running { Value::Null } else { live.folder_share(slug, t) };
        m.insert("folderShare".into(), share);
        let user_wait = if t.parent_id.is_some() && !is_complete(t) { user_wait_reason(t, session.as_ref()).map(Value::String).unwrap_or(Value::Null) } else { Value::Null };
        m.insert("userWait".into(), user_wait);
        m.insert("attention".into(), attention);
        m.insert("snoozed".into(), snoozed);
        m.insert("huddleBusy".into(), huddle_works.into());
        let line = match (&host, huddle_works) {
            (Some(h), true) => {
                let n = |k: &str| h.get(k).filter(|v| !v.is_null()).cloned();
                json!({
                    "working": n("helpersWorking").or(n("working")).unwrap_or(Value::Null),
                    "helpers": n("helpers").or(n("working")).unwrap_or(Value::Null),
                    "findings": n("findings").unwrap_or(json!(0)),
                })
            }
            _ => Value::Null,
        };
        m.insert("huddleLine".into(), line);
        let cost = if running || t.status == "in_progress" || t.status == "review" { num(live.cost(slug, id) + live.huddle_spend(slug, id)) } else { Value::Null };
        m.insert("costUsd".into(), cost);
        m.insert("runCap".into(), run_cap(t, profile));
        let run = |x: &str| live.running(slug, x);
        if t.main {
            // A hidden task of this card waits for the folder: the card the user sees says so.
            let wait = t.status != "done" && t.on_board() && task_waits_for_folder(slug, list, t, live);
            m.insert("taskFolderWait".into(), wait.into());
            m.insert("familyWorking".into(), family_working(list, id, &run).into());
            m.insert("stepsRunning".into(), steps_running(list, id, &run).into());
            let card = if list.get(id).is_some_and(|x| x.main) { family_card(list, id, &run, self.family_cost(slug, list, id, live)) } else { None };
            m.insert("familyCard".into(), card.unwrap_or(Value::Null));
            if let Some((up, _)) = t.parent_link() {
                let sub = self.index.ticket(slug, up).and_then(|u| feature_root(list, &u.id)).map(|i| json!({ "id": list.at(i).id, "title": list.at(i).title }));
                m.insert("subFeatureOf".into(), sub.unwrap_or(Value::Null));
            }
        }
        if t.tool {
            let main = main_of(list, t).map(|i| json!({ "id": list.at(i).id, "title": list.at(i).title }));
            m.insert("mainTicket".into(), main.unwrap_or(Value::Null));
        }
        m
    }
}
