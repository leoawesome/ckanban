//! What a run is told and started with: `roleOf`, `chatArgs`, `chatEnv`, `runBrowsers`, `featureNote`,
//! `takeStatusNotes`, `freshPrompt`, `freshChatContext`, `seedsFromStatus`, `autoFresh`, `startFreshChat`,
//! `withSetupNote`, `scheduleContext` (`board-main.ts`, `board-features.ts`, `board-recovery.ts`, `board-repo.ts`,
//! `board-tickets.ts`), and `followUpPlace` (`web/src/features/ticket/followUp.ts`).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use super::board::{RunError, RunLoop, now_iso, obj, ts, uuid};
use crate::families::rules::{fit_parent, is_feature};
use crate::families::status::{read_status, write_status};
use crate::index::family::{feature_root, feature_rows, main_of};
use crate::index::store::BoardList;
use crate::index::ticket::Tk;
use crate::prompts::types::{self as pt, BoardBrowserChoice, Comment, FollowUpPlace, IdTitle, MainRole, RunRole, ToolRole};
use crate::runs::runner::{self, BuildArgs, NO_EDIT_TOOLS};

/// `BOARD_NOTE_RE` of `src/core/store.ts`: the board's own notes, not a result.
pub const BOARD_NOTES: [&str; 8] = [
    "Run failed",
    "Could not start",
    "Run stopped",
    "Planner stopped",
    "Started a fresh session",
    "Started a fresh chat",
    "Took over the session",
    "This ticket's Claude session is still open",
];

pub fn board_note(text: &str) -> bool {
    BOARD_NOTES.iter().any(|n| text.starts_with(n))
}

/// `FRESH_CHAT_TOKENS` of `src/chat/chat-cache.ts`.
pub const FRESH_CHAT_TOKENS: f64 = 150_000.0;

/// A ticket moved from Planning (or Backlog) to work starts the work in a fresh chat when its planning chat is longer
/// than this (the size Claude re-reads, from the session summary). A long planning chat (discussion, mockups) lowers the
/// work's quality and is re-read in full every time the work wakes on a cold cache; a short one is kept, so the work
/// still sees what was said. Not a board setting on purpose.
pub const PLANNING_FRESH_TOKENS: f64 = 50_000.0;

/// Whether the work after Planning starts in a fresh chat: the user's tick on "Apply & start work" wins; otherwise a
/// planning chat over `PLANNING_FRESH_TOKENS` starts fresh, and a short or unknown one is kept.
pub fn planning_fresh(choice: Option<bool>, tokens: Option<f64>) -> bool {
    choice.unwrap_or_else(|| tokens.is_some_and(|n| n > PLANNING_FRESH_TOKENS))
}

/// The size of a chat Claude re-reads, from a session summary's `cache` (what `autoFresh` uses); None: unknown.
pub fn chat_tokens(summary: Option<&Value>) -> Option<f64> {
    let cache = summary?.get("cache").filter(|c| c.is_object())?;
    cache.get("coldTokens").filter(|v| !v.is_null()).or_else(|| cache.get("tokens")).and_then(Value::as_f64)
}

/// "86k" (rounded to the nearest thousand, at least 1k).
pub fn k_tokens(n: f64) -> String {
    format!("{}k", ((n / 1000.0).round() as i64).max(1))
}

/// A run's board browsers (`RunBrowsers`): tool servers, the prompt note, whether to leave out Claude in Chrome.
#[derive(Default)]
pub struct RunBrowsers {
    pub servers: Map<String, Value>,
    pub note: Option<String>,
    pub no_chrome: bool,
}

/// The prompt's view of a ticket.
pub fn prompt_ticket(t: &Tk) -> pt::Ticket {
    serde_json::from_value(Value::Object(t.json.clone())).unwrap_or_default()
}

pub fn comment(v: &Value) -> Comment {
    serde_json::from_value(v.clone()).unwrap_or_default()
}

/// `folderTurns`: tickets that edit the board's folder in place take turns. Missing: off (they run together).
pub fn folder_turns_on(p: Option<&Map<String, Value>>) -> bool {
    p.and_then(|p| p.get("folderTurns")) == Some(&Value::Bool(true))
}

/// Adds the shared folder rule inside the prompt's last board context (or in a context of its own).
pub fn shared_folder_note(prompt: String) -> String {
    let text = format!("# Shared folder\n{}", crate::prompts::rules::SHARED_FOLDER_RULE);
    match prompt.rfind("\n</ckanban-context>") {
        Some(at) => format!("{}\n\n{text}{}", &prompt[..at], &prompt[at..]),
        None => crate::git::setup::with_board_text(&prompt, &text, "Shared folder"),
    }
}

/// `autoHuddlesOn`.
pub fn auto_huddles_on(p: Option<&Map<String, Value>>) -> bool {
    p.and_then(|p| p.get("autoHuddles")) != Some(&Value::Bool(false))
}

/// `workspaceOf(p) === "folder"`.
pub fn folder_workspace(p: Option<&Map<String, Value>>) -> bool {
    p.and_then(|p| p.get("workspace")).and_then(Value::as_str) == Some("folder")
}

/// `runCapFor`: the ticket's cap for this run, else the board's; None: no cap.
pub fn run_cap_for(t: &Tk, p: Option<&Map<String, Value>>) -> Option<f64> {
    let pos = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0);
    if let Some(n) = pos(t.get("capNextUsd")) {
        return Some(n);
    }
    if t.get("runCapUsd").and_then(Value::as_f64) == Some(0.0) {
        return None;
    }
    pos(t.get("runCapUsd")).or_else(|| pos(p.and_then(|p| p.get("runCapUsd"))))
}

/// `runOptions(t, p, workflows)`: (effort, ultracode).
pub fn run_options(t: Option<&Tk>, p: Option<&Map<String, Value>>, workflows: bool) -> (Option<String>, bool) {
    let level = |e: Option<&str>| match e {
        Some("ultracode") => Some("xhigh".to_string()),
        Some(e) if !e.is_empty() => Some(e.to_string()),
        _ => None,
    };
    let legacy = |e: Option<&str>| (e == Some("ultracode")).then_some(true);
    let te = t.and_then(|t| t.s("effort"));
    let pe = p.and_then(|p| p.get("effort")).and_then(Value::as_str);
    let effort = level(te).or_else(|| level(pe));
    let tu = t.and_then(|t| t.get("ultracode")).and_then(Value::as_bool);
    let pu = p.and_then(|p| p.get("ultracode")).and_then(Value::as_bool);
    let on = tu.or_else(|| legacy(te)).or(pu).or_else(|| legacy(pe)).unwrap_or(false);
    (effort, workflows && on)
}

/// `followUpPlace`: where follow-up work on a ticket goes.
pub fn follow_up_place(list: &BoardList, id: &str) -> Option<FollowUpPlace> {
    let t = list.get(id)?;
    let mut up: Vec<Arc<Tk>> = Vec::new();
    let mut seen = std::collections::HashSet::from([t.id.clone()]);
    let mut p = t.parent_link().and_then(|(p, _)| list.get(p)).cloned();
    while let Some(x) = p {
        if !seen.insert(x.id.clone()) {
            break;
        }
        p = x.parent_link().and_then(|(q, _)| list.get(q)).cloned();
        up.push(x);
    }
    if let Some(main) = up.iter().find(|p| p.main) {
        return Some(FollowUpPlace::Step { main: IdTitle { id: main.id.clone(), title: main.title.clone() } });
    }
    if up.is_empty() {
        return Some(FollowUpPlace::Main);
    }
    let _ = fit_parent(list, &t.id);
    Some(FollowUpPlace::Ticket {})
}

impl RunLoop {
    /// `roleOf`: the main or tool rules a run of `t` gets.
    pub(super) fn role_of(&self, slug: &str, t: &Tk, repo: &str, in_place: bool) -> Option<RunRole> {
        let list = self.tickets.list(slug);
        if t.main {
            let now = list.get(&t.id).cloned().unwrap_or_else(|| Arc::new(t.clone()));
            let planned = if feature_rows(&list, &now.id).len() > 1 {
                Some("it already has tickets in its family".to_string())
            } else if now.is("statusAt") {
                Some("its \"Where we are\" status is already written".to_string())
            } else {
                None
            };
            let above = now.parent_link().map(|(p, _)| p.to_string()).filter(|p| list.get(p).is_some()).and_then(|p| feature_root(&list, &p)).map(|i| list.at(i));
            let profile = self.profile(slug);
            return Some(RunRole::Main(MainRole {
                repo: repo.into(),
                branch: if in_place { None } else { ts(&now, "branch").map(str::to_string) },
                in_place,
                paused: (now.plan_state() == Some("paused")).then_some(true),
                planned,
                sub_feature_of: above.map(|a| IdTitle { id: a.id.clone(), title: a.title.clone() }),
                task_models: profile.as_ref().and_then(|p| p.get("taskModels")).filter(|v| !v.is_null()).cloned(),
            }));
        }
        if !t.tool {
            return None;
        }
        let main = main_of(&list, t).map(|i| list.tickets[i].clone()).or_else(|| feature_root(&list, &t.id).map(|i| list.tickets[i].clone())).unwrap_or_else(|| Arc::new(t.clone()));
        let parent = t.parent_id.as_deref().and_then(|p| list.get(p)).cloned().unwrap_or_else(|| main.clone());
        let saved = read_status(&self.tickets.ticket_dir(slug, &main.id).join("outputs"));
        let status_path = self.families.refresh_status_file(slug, &main.id).map(|p| p.to_string_lossy().into_owned());
        let siblings: Vec<Arc<Tk>> = crate::tickets::writer::children_of(&list, &parent.id).into_iter().cloned().collect();
        let deps = crate::tickets::writer::resolve_deps(t, &siblings).0;
        let dep_reports = deps.iter().map(|d| pt::DepReport { id: d.id.clone(), title: d.title.clone(), path: self.families.report_of(slug, &d.id) }).collect();
        let goal = saved.as_ref().and_then(|s| s.get("goal")).and_then(Value::as_str).map(crate::runs::js::trim).filter(|g| !g.is_empty()).map(str::to_string).unwrap_or_else(|| main.title.clone());
        let out = self.outputs_dir(slug, &t.id);
        let v = json!({
            "kind": "tool", "repo": repo, "parent": { "id": parent.id, "title": parent.title }, "main": { "id": main.id, "title": main.title },
            "goal": goal, "statusPath": status_path, "depReports": [], "mainBranch": if in_place { Value::Null } else { ts(&main, "branch").map(Value::from).unwrap_or(Value::Null) },
            "outputDir": out.to_string_lossy(), "withYou": (t.kind.as_deref() == Some("with_you")).then_some(true),
        });
        let mut role: ToolRole = serde_json::from_value(v).ok()?;
        role.dep_reports = dep_reports;
        Some(RunRole::Tool(role))
    }

    /// `outputsDir`: made if missing.
    pub fn outputs_dir(&self, slug: &str, id: &str) -> PathBuf {
        self.families.outputs_dir(slug, id)
    }

    /// `featureNote`: what a run in a feature is told about the status.
    pub(super) fn feature_note(&self, slug: &str, t: &Tk) -> Option<String> {
        let list = self.tickets.list(slug);
        let top = list.tickets[feature_root(&list, &t.id)?].clone();
        if !is_feature(&list, &top) {
            return None;
        }
        let path = self.families.refresh_status_file(slug, &top.id)?;
        let path = path.to_string_lossy();
        Some(if top.id == t.id {
            crate::prompts::planning::feature_main_note(&path)
        } else {
            crate::prompts::planning::feature_member_note(&top.id, &top.title, &path)
        })
    }

    /// `takeStatusNotes`: the user's status notes the top ticket's Claude hasn't had yet (marked delivered).
    pub(super) fn take_status_notes(&self, slug: &str, id: &str) -> Option<String> {
        let dir = self.tickets.ticket_dir(slug, id).join("outputs");
        let mut saved = read_status(&dir)?;
        let notes = saved.get("notes").and_then(Value::as_array).cloned().unwrap_or_default();
        let fresh: Vec<crate::prompts::planning::StatusNote> = notes.iter().filter(|n| !crate::runs::js::truthy(n.get("delivered"))).filter_map(|n| serde_json::from_value(n.clone()).ok()).collect();
        if fresh.is_empty() {
            return None;
        }
        let t = self.get(slug, id)?;
        let marked: Vec<Value> = notes
            .into_iter()
            .map(|mut n| {
                if let Value::Object(m) = &mut n {
                    m.insert("delivered".into(), Value::Bool(true));
                }
                n
            })
            .collect();
        saved.insert("notes".into(), Value::Array(marked));
        let list = self.tickets.list(slug);
        let pr = saved.get("prNotes").and_then(Value::as_object).cloned().unwrap_or_default();
        let f = self.families.facts(slug, &list, id, &pr);
        if let Err(e) = write_status(&dir, &t.id, &t.title, Some(&saved), &f, true) {
            eprintln!("[board] status notes of {slug}/{id}: {e}");
        }
        Some(crate::prompts::planning::status_notes_block(&fresh))
    }

    /// The ticket's comments (the board's notes and the rest).
    pub(super) fn comments(&self, slug: &str, id: &str) -> Vec<Value> {
        self.tickets.comments(slug, id)
    }

    fn last_and_recent(&self, slug: &str, id: &str) -> (Option<String>, Vec<Comment>) {
        let all = self.comments(slug, id);
        let text = |c: &Value| c.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        let last = all.iter().rposition(|c| c.get("author").and_then(Value::as_str) == Some("ai") && !board_note(&text(c)));
        let recent: Vec<Comment> = all.iter().enumerate().filter(|(i, c)| !board_note(&text(c)) && Some(*i) != last).map(|(_, c)| comment(c)).collect();
        let keep = recent.len().saturating_sub(10);
        (last.map(|i| text(&all[i])), recent[keep..].to_vec())
    }

    /// `freshPrompt`: the first prompt of a fresh session.
    pub(super) fn fresh_prompt(&self, slug: &str, t: &Tk, repo: &str, in_place: bool, output_dir: &str, recall: &str) -> String {
        let (last, recent) = self.last_and_recent(slug, &t.id);
        let profile = self.profile(slug);
        let p = profile.as_ref();
        let ps = |k: &str| p.and_then(|p| p.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
        let mut texts: Vec<Option<&str>> = vec![Some(&t.body), last.as_deref()];
        texts.extend(recent.iter().map(|c| Some(c.text.as_str())));
        let artifacts = p.is_some_and(|p| crate::runs::js::truthy(p.get("artifacts"))) || crate::prompts::rules::mentions_artifact(&texts);
        let base = ps("baseBranch");
        let ctx = pt::FreshContext {
            repo: repo.into(),
            in_place: Some(in_place),
            home: p.map(|_| pt::Home { folder: ps("path"), base_branch: base.clone() }),
            linked: t.is("workdir"),
            base_branch: if base.is_empty() { "main".into() } else { base },
            last_result: last,
            comments: recent,
            output_dir: output_dir.into(),
            auto_huddles: Some(auto_huddles_on(p)),
            artifacts: Some(artifacts),
            recall: Some(recall.into()),
        };
        crate::prompts::chat::fresh_session_prompt(&prompt_ticket(t), &ctx)
    }

    /// `freshChatContext`.
    pub(super) fn fresh_chat_context(&self, slug: &str, t: &Tk) -> String {
        let (last, recent) = self.last_and_recent(slug, &t.id);
        if !self.seeds_from_status(slug, t) {
            return crate::prompts::chat::fresh_chat_note(&prompt_ticket(t), last.as_deref(), &recent, None);
        }
        let f = self.fresh_feature(slug, t);
        crate::prompts::chat::fresh_chat_note(&prompt_ticket(t), last.as_deref(), &recent, Some(&f))
    }

    /// A main ticket's or feature's status and tool tickets, for a chat that starts fresh.
    fn fresh_feature(&self, slug: &str, t: &Tk) -> pt::FreshFeature {
        let status = self.families.refresh_status_file(slug, &t.id).filter(|p| p.exists()).and_then(|p| std::fs::read_to_string(p).ok());
        let list = self.tickets.list(slug);
        let kids: Vec<Arc<Tk>> = list.tickets.iter().filter(|c| c.parent_id.as_deref() == Some(&t.id) || c.part_of.as_deref() == Some(&t.id)).cloned().collect();
        let table = crate::families::plan::wake_table(&kids, &list, &|id| self.is_running(slug, id));
        pt::FreshFeature { status, table, auto: t.is("freshAuto") }
    }

    /// The first work prompt after a fresh start from Planning: where the planning chat is, and (main ticket or
    /// feature, outside a chat that already got its status) where the feature stands.
    pub(super) fn planning_fresh_context(&self, slug: &str, t: &Tk, with_status: bool) -> String {
        let f = (with_status && self.seeds_from_status(slug, t)).then(|| self.fresh_feature(slug, t));
        crate::prompts::chat::planning_fresh_note(f.as_ref())
    }

    /// `seedsFromStatus`: a main ticket or a feature's top: its fresh chats start from the status.
    pub fn seeds_from_status(&self, slug: &str, t: &Tk) -> bool {
        t.main || is_feature(&self.tickets.list(slug), t)
    }

    /// `autoFresh`: a cold, large main or feature chat starts its next turn fresh. The ticket as it is now.
    pub(super) fn auto_fresh(&self, slug: &str, t: Arc<Tk>) -> Arc<Tk> {
        if t.is("freshSession") || !t.is("sessionId") || !self.seeds_from_status(slug, &t) {
            return t;
        }
        let Some(cache) = ts(&t, "sessionId").and_then(|s| self.sessions.summary(s)).and_then(|s| s.get("cache").cloned()).filter(|c| c.is_object()) else { return t };
        let at = cache.get("at").and_then(Value::as_str).and_then(ckanban_core::time::parse_date);
        let ttl = match cache.get("ttl").and_then(Value::as_str) {
            Some("5m") => 300_000.0,
            _ => 3_600_000.0,
        };
        let cold = at.is_some_and(|at| self.now() - at > ttl);
        if !cold {
            return t;
        }
        let limit = self.profile(slug).and_then(|p| p.get("freshChatTokens").and_then(Value::as_f64)).filter(|n| *n != 0.0).unwrap_or(FRESH_CHAT_TOKENS);
        let tokens = cache.get("coldTokens").filter(|v| !v.is_null()).or_else(|| cache.get("tokens")).and_then(Value::as_f64).unwrap_or(0.0);
        if tokens <= limit {
            return t;
        }
        self.start_fresh_chat(slug, &t.id, true).unwrap_or(t)
    }

    /// `startFreshChat`: the next message starts a new session seeded with the ticket (the old one stays shown).
    pub fn start_fresh_chat(&self, slug: &str, id: &str, auto: bool) -> Result<Arc<Tk>, RunError> {
        let t = self.get(slug, id).ok_or_else(|| RunError::other(format!("ticket {id} not found")))?;
        let text = if auto {
            crate::runloop::rules::AUTO_FRESH_NOTE
        } else if self.seeds_from_status(slug, &t) {
            "Started a fresh chat: Claude starts from the status and can look up earlier messages."
        } else {
            "Started a fresh chat: Claude no longer sees the earlier messages; it gets the ticket, its last result and recent comments instead."
        };
        let extra = obj(json!({ "freshAuto": if auto { Value::Bool(true) } else { Value::Null }, "freshFromPlanning": null }));
        self.begin_fresh_chat(slug, &t, text, extra)
    }

    /// A ticket moved from Planning (or Backlog) to work: its work starts in a fresh chat when `planning_fresh` says so
    /// (`choice`: the tick sent with "Apply & start work"). Called by every move before the status is written, so the
    /// first work run already uses the new session. Only the session summary is read (no transcript parse).
    pub fn fresh_for_work(&self, slug: &str, id: &str, choice: Option<bool>) -> Option<Arc<Tk>> {
        let t = self.get(slug, id)?;
        // No planning chat to leave (never started), or the next run already starts fresh.
        if t.is("freshSession") || !t.is("sessionStarted") {
            return None;
        }
        let sid = ts(&t, "sessionId")?;
        let tokens = chat_tokens(self.sessions.summary(sid).as_ref());
        if !planning_fresh(choice, tokens) {
            return None;
        }
        let text = match tokens.filter(|n| *n > PLANNING_FRESH_TOKENS && choice.is_none()) {
            Some(n) => format!(
                "Started a fresh chat for the work: the planning chat was long ({}), so Claude starts from the ticket and can look back at the planning chat when it needs to.",
                k_tokens(n)
            ),
            None => "Started a fresh chat for the work, as chosen: Claude starts from the ticket and can look back at the planning chat when it needs to.".into(),
        };
        let extra = obj(json!({ "freshAuto": null, "freshFromPlanning": true }));
        match self.begin_fresh_chat(slug, &t, &text, extra) {
            Ok(t) => Some(t),
            Err(e) => {
                eprintln!("[board] fresh chat for the work of {slug}/{id}: {e:?}");
                None
            }
        }
    }

    /// The old session goes to `earlierSessions` (when Claude had it), the note is written, and a new session id waits.
    fn begin_fresh_chat(&self, slug: &str, t: &Tk, text: &str, extra: Map<String, Value>) -> Result<Arc<Tk>, RunError> {
        let sid = ts(t, "sessionId").map(str::to_string);
        let mut earlier = t.get("earlierSessions").filter(|v| !v.is_null()).cloned();
        if let Some(s) = &sid
            && (t.is("sessionStarted") || self.session_exists(s))
        {
            let mut list = earlier.and_then(|e| e.as_array().cloned()).unwrap_or_default();
            list.push(json!({ "sessionId": s, "endedAt": now_iso() }));
            earlier = Some(Value::Array(list));
        }
        self.note(slug, &t.id, text);
        let mut p = obj(json!({ "sessionId": uuid(), "sessionStarted": false, "freshSession": true }));
        p.extend(extra);
        if let Some(e) = earlier {
            p.insert("earlierSessions".into(), e);
        }
        self.patch(slug, &t.id, p)
    }

    /// `sessionExists`: Claude has a stored session with this id.
    pub fn session_exists(&self, id: &str) -> bool {
        crate::sessions::files::find_session_file(&crate::sessions::files::projects_dir(None), id).is_some()
    }

    /// `withSetupNote`: a work run in a copy whose setup command hasn't run learns how to run it.
    pub(super) fn with_setup_note(&self, slug: &str, t: &Tk, profile: &Map<String, Value>, dir: &std::path::Path, refine: bool, prompt: String) -> String {
        let setup = profile.get("setupCommand").and_then(Value::as_str).map(crate::runs::js::trim).unwrap_or("");
        let wt = ts(t, "worktree");
        if refine || !t.is("setupPending") || wt.is_none() || wt.map(std::path::Path::new) != Some(dir) || setup.is_empty() {
            return prompt;
        }
        crate::git::setup::with_board_text(&prompt, &crate::prompts::chat::setup_note(slug, &t.id), "Setup")
    }

    /// A run that may edit the board's folder in place, on a board where tickets share it (no "One ticket at a time
    /// in my folder"), learns that others may change the same files meanwhile.
    pub(super) fn with_shared_folder_note(&self, t: &Tk, profile: &Map<String, Value>, in_place: bool, refine: bool, role: Option<&RunRole>, prompt: String) -> String {
        let edits = !t.main && !matches!(role, Some(RunRole::Main(_))) && (!refine || t.tool);
        if !in_place || !edits || folder_turns_on(Some(profile)) {
            return prompt;
        }
        shared_folder_note(prompt)
    }

    /// `scheduleContext`: which schedule a schedule's ticket comes from (R10's scheduler: for a quiet one, also what
    /// it raised that is still open).
    pub(super) fn schedule_context(&self, slug: &str, t: &Tk) -> Option<pt::ScheduleRef> {
        let sid = ts(t, "scheduleId")?.to_string();
        if let Some(h) = self.schedules.get() {
            return h.context(slug, t);
        }
        let file = ckanban_core::DataDir::new(self.root.clone()).profile_dir(slug).join("schedules").join(format!("{sid}.json"));
        let s = std::fs::read_to_string(file).ok().and_then(|t| crate::runs::js::parse(&t));
        Some(pt::ScheduleRef { id: sid, name: s.as_ref().and_then(|s| s.get("name")).and_then(Value::as_str).map(str::to_string), board: slug.into(), quiet: None })
    }

    /// The board's own tool servers (`board-tools.json`'s `mcpServers`), not ours.
    pub(crate) fn board_tools(&self, slug: &str) -> Map<String, Value> {
        let file = ckanban_core::DataDir::new(self.root.clone()).profile_dir(slug).join("board-tools.json");
        let mut out = Map::new();
        if let Some(Value::Object(m)) = std::fs::read_to_string(file).ok().and_then(|t| crate::runs::js::parse(&t)).and_then(|v| v.get("mcpServers").cloned()) {
            for (k, v) in m {
                if v.is_object() {
                    out.insert(k, v);
                }
            }
        }
        out
    }

    /// `mcpConfig(helper mcp, servers)`: the board's servers, then ours.
    pub(crate) fn mcp_config(&self, servers: Map<String, Value>) -> String {
        let mut m = Map::new();
        for (k, v) in servers {
            if k != "ckanban" {
                m.insert(k, v);
            }
        }
        let (command, args) = self.opts.mcp_argv.split_first().map(|(c, a)| (c.clone(), a.to_vec())).unwrap_or_else(|| ("ckanban".into(), vec!["mcp".into()]));
        m.insert("ckanban".into(), json!({ "command": command, "args": args }));
        crate::runs::js::stringify(&json!({ "mcpServers": m }))
    }

    /// `browserServers`: tool servers for the board browsers in a list (without starting them). `claim`: the run's
    /// secret from `grant`, so its tools can hold the browser on their first call (None: they can't, e.g. /context).
    pub(super) fn browser_servers(&self, picks: Option<&Value>, out_dir: Option<&std::path::Path>, claim: Option<&str>) -> Map<String, Value> {
        let mut out = Map::new();
        let Some(b) = &self.browsers else { return out };
        for p in picks.and_then(Value::as_array).into_iter().flatten() {
            if p.get("kind").and_then(Value::as_str) != Some("board") {
                continue;
            }
            let Some(id) = p.get("id").and_then(Value::as_str) else { continue };
            let Some(bb) = b.board_browsers.get(id) else { continue };
            let Ok(folder) = b.board_browsers.folder(id) else { continue };
            let dir = out_dir.map(PathBuf::from).unwrap_or_else(|| self.root.join(crate::browsers::board_browsers::BROWSER_FILES_DIR).join(id));
            let (command, args) = self.opts.mcp_argv.split_first().map(|(c, _)| (c.clone(), Vec::<String>::new())).unwrap_or_else(|| ("ckanban".into(), vec![]));
            let mut a = args;
            a.extend(["browser-mcp", "--id", id, "--name", &bb.name, "--dir", &folder.to_string_lossy(), "--out", &dir.to_string_lossy()].map(String::from));
            if let Some(token) = claim {
                a.extend(["--claim".to_string(), token.to_string()]);
            }
            out.insert(crate::browsers::board_browsers::server_name(id), json!({ "command": command, "args": a }));
        }
        out
    }

    /// `chatArgs`: the flags a run of the ticket's chat gets.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn chat_args(&self, slug: &str, t: &Tk, profile: &Map<String, Value>, refine: bool, session_id: &str, resume: bool, system_prompt: Option<String>, cap: Option<f64>, browsers: Option<&RunBrowsers>) -> Vec<String> {
        let (effort, ultracode) = run_options(Some(t), Some(profile), !refine);
        let connectors = crate::runs::connectors::board_connector_options(profile.get("claudeAiConnectors"));
        let mut disallowed = Vec::new();
        if refine {
            disallowed.extend(runner::planning_disallowed_tools());
        }
        if t.main {
            disallowed.extend(NO_EDIT_TOOLS.split(',').map(str::to_string));
        }
        disallowed.extend(connectors.disallowed);
        let mut servers = self.board_tools(slug);
        match browsers {
            Some(b) => servers.extend(b.servers.clone()),
            None => {
                let picks = self.devices.browser_picks(slug, Some(&t.id));
                let out = self.tickets.ticket_dir(slug, &t.id).join("outputs");
                servers.extend(self.browser_servers(picks.as_ref(), Some(&out), None));
            }
        }
        let model = ts(t, "model").map(str::to_string).or_else(|| if t.main { profile.get("mainModel").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string) } else { None }).or_else(|| profile.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string));
        runner::build_args(&BuildArgs {
            session_id: session_id.into(),
            resume,
            model,
            disallowed,
            mcp: Some(self.mcp_config(servers)),
            system_prompt,
            max_budget_usd: cap,
            effort,
            ultracode,
            no_chrome: browsers.is_some_and(|b| b.no_chrome),
            ..Default::default()
        })
    }

    /// `chatEnv`: the environment a run of the ticket gets (saved keys first, the board's variables win).
    pub(super) fn chat_env(&self, slug: &str, id: &str, output_dir: &str) -> BTreeMap<String, String> {
        let profile = self.profile(slug);
        let connectors = crate::runs::connectors::board_connector_options(profile.as_ref().and_then(|p| p.get("claudeAiConnectors")));
        let mut env = (self.opts.key_env)(slug);
        env.extend(connectors.env);
        env.insert("CKANBAN_OUTPUT_DIR".into(), output_dir.into());
        env.insert("CKANBAN_TICKET".into(), format!("{slug}/{id}"));
        env
    }

    /// `runBrowsers`: each chosen board browser's tool server for the run. Nothing starts and nothing is held here:
    /// the run may claim them (`grant`, under `lease`), and its tools hold a browser only from their first browser
    /// call (`claim`) until the run ends or makes no browser call for a while. A removed browser (or no Chrome on the
    /// Mac) is left out and the run told so. Nothing chosen: nothing changes.
    pub(crate) async fn run_browsers(&self, slug: &str, id: &str, lease: &str, out_dir: &std::path::Path) -> RunBrowsers {
        let Some(b) = self.browsers.clone() else { return RunBrowsers::default() };
        let picks = self.devices.browser_picks(slug, Some(id));
        let list: Vec<Value> = picks.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
        let parsed: Vec<crate::browsers::chromes::BrowserPick> = list.iter().filter_map(crate::browsers::chromes::BrowserPick::from_json).collect();
        let chrome = b.chromes.choice_of(picks.as_ref().map(|_| parsed.as_slice()));
        let mut board: Vec<BoardBrowserChoice> = Vec::new();
        let mut own: Vec<(String, Option<String>)> = Vec::new();
        for p in &list {
            if p.get("kind").and_then(Value::as_str) != Some("board") {
                continue;
            }
            let Some(pid) = p.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
            let note = p.get("note").and_then(Value::as_str).map(str::to_string);
            if b.board_browsers.get(pid).is_none() {
                board.push(BoardBrowserChoice { id: pid.into(), name: pid.into(), note, server: crate::browsers::board_browsers::server_name(pid), available: false, why: Some("it was removed from More, Browsers".into()) });
            } else {
                own.push((pid.to_string(), note));
            }
        }
        let mut servers = Map::new();
        if !own.is_empty() {
            let installed = b.board_browsers.chrome_installed();
            let ids: Vec<String> = own.iter().map(|(i, _)| i.clone()).collect();
            let kind = if lease.starts_with("huddle:") { "huddle" } else { "task" };
            let holder = crate::browsers::board_browsers::Holder { kind, slug: slug.to_string(), id: id.to_string() };
            let token = b.board_browsers.grant(lease, &ids, holder);
            if installed {
                let up: Vec<Value> = ids.iter().map(|i| json!({ "kind": "board", "id": i })).collect();
                servers = self.browser_servers(Some(&Value::Array(up)), Some(out_dir), Some(&token));
            }
            for (pid, note) in own {
                let Some(bb) = b.board_browsers.get(&pid) else { continue };
                board.push(BoardBrowserChoice {
                    id: bb.id.clone(),
                    name: bb.name.clone(),
                    note,
                    server: crate::browsers::board_browsers::server_name(&bb.id),
                    available: installed,
                    why: (!installed).then(|| "Google Chrome isn't installed on this Mac".to_string()),
                });
            }
        }
        let choice: Option<pt::ChromeChoice> = chrome.and_then(|c| serde_json::from_value(c.to_json()).ok());
        let note = crate::prompts::rules::chrome_choice_note(choice.as_ref(), &board);
        RunBrowsers { servers, note, no_chrome: !board.is_empty() && choice.is_none() }
    }

    /// `contextSession` (R7b, the Context panel): the session `context_spec` would check, without building the chat's
    /// command; None when the ticket has no saved Claude session or its folder is gone. Blocking (looks for the file).
    pub fn context_session(&self, slug: &str, id: &str) -> Option<String> {
        let t = self.get(slug, id)?;
        let profile = self.profile(slug)?;
        let sid = ts(&t, "sessionId")?.to_string();
        if !self.session_exists(&sid) {
            return None;
        }
        let cwd = ts(&t, "workdir").or_else(|| ts(&t, "worktree")).or_else(|| profile.get("path").and_then(Value::as_str))?;
        std::path::Path::new(cwd).exists().then_some(sid)
    }

    /// `contextSpec`: what the Context panel needs to run `/context` like the ticket's chat runs (same folder, flags
    /// and environment; the per-run system prompt and cap left out). Blocking.
    pub fn context_spec(&self, slug: &str, id: &str) -> Option<crate::chat::context::ContextSpec> {
        let sid = self.context_session(slug, id)?;
        let t = self.get(slug, id)?;
        let profile = self.profile(slug)?;
        let cwd = ts(&t, "workdir").or_else(|| ts(&t, "worktree")).or_else(|| profile.get("path").and_then(Value::as_str)).unwrap_or("").to_string();
        let refine = super::rules::chat_mode_for(&t.status) == "refine";
        let args = self.chat_args(slug, &t, &profile, refine, &sid, true, None, None, None);
        let out = self.outputs_dir(slug, id);
        let env = self.chat_env(slug, id, &out.to_string_lossy());
        Some(crate::chat::context::ContextSpec { session_id: sid, cwd, args, env })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_folder_rule_goes_inside_the_board_context() {
        let p = shared_folder_note("Hi\n\n<ckanban-context note=\"x\">\n# Rules\n- a\n</ckanban-context>".into());
        assert!(p.ends_with(&format!("- a\n\n# Shared folder\n{}\n</ckanban-context>", crate::prompts::rules::SHARED_FOLDER_RULE)), "{p}");
        let raw = shared_folder_note("just text".into());
        assert!(raw.starts_with("just text\n\n<ckanban-context note=\"Shared folder\">\n# Shared folder\n"), "{raw}");
        assert!(folder_turns_on(json!({ "folderTurns": true }).as_object()));
        assert!(!folder_turns_on(json!({}).as_object()));
        assert!(!folder_turns_on(None));
    }

    #[test]
    fn planning_fresh_decides_by_size_unless_the_user_chose() {
        // No choice sent (a drag, the phone's move menu, the CLI, move_ticket): the size decides.
        assert!(planning_fresh(None, Some(86_000.0)), "over 50k starts fresh");
        assert!(!planning_fresh(None, Some(9_000.0)), "under keeps the planning chat");
        assert!(!planning_fresh(None, Some(PLANNING_FRESH_TOKENS)), "exactly 50k keeps it");
        assert!(!planning_fresh(None, None), "unknown size keeps it");
        // The tick sent with Apply & start work wins either way.
        assert!(planning_fresh(Some(true), Some(9_000.0)));
        assert!(planning_fresh(Some(true), None));
        assert!(!planning_fresh(Some(false), Some(200_000.0)));
    }

    #[test]
    fn chat_tokens_reads_the_summary_like_auto_fresh() {
        assert_eq!(chat_tokens(Some(&json!({ "cache": { "tokens": 90_000, "coldTokens": 86_000 } }))), Some(86_000.0));
        assert_eq!(chat_tokens(Some(&json!({ "cache": { "tokens": 9_000, "coldTokens": null } }))), Some(9_000.0));
        assert_eq!(chat_tokens(Some(&json!({ "cache": null }))), None);
        assert_eq!(chat_tokens(Some(&json!({}))), None);
        assert_eq!(chat_tokens(None), None);
        assert_eq!(k_tokens(86_400.0), "86k");
        assert_eq!(k_tokens(200.0), "1k");
    }

    #[test]
    fn the_planning_note_points_to_the_chat_tools_and_a_main_ticket_gets_its_status() {
        let plain = crate::prompts::chat::planning_fresh_note(None);
        assert!(plain.contains("search_chat") && plain.contains("read_chat") && plain.contains("Don't read the planning chat up front"));
        assert!(!plain.contains("status.md"));
        let f = pt::FreshFeature { status: Some("Step 2 of 4 done".into()), table: "| a | done |".into(), auto: false };
        let main = crate::prompts::chat::planning_fresh_note(Some(&f));
        assert!(main.starts_with(&plain));
        assert!(main.contains("# Where we are (the feature's status.md)\nStep 2 of 4 done") && main.contains("| a | done |"));
    }
}
