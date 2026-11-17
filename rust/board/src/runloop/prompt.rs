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
        let status = self.families.refresh_status_file(slug, &t.id).filter(|p| p.exists()).and_then(|p| std::fs::read_to_string(p).ok());
        let list = self.tickets.list(slug);
        let kids: Vec<Arc<Tk>> = list.tickets.iter().filter(|c| c.parent_id.as_deref() == Some(&t.id) || c.part_of.as_deref() == Some(&t.id)).cloned().collect();
        let table = crate::families::plan::wake_table(&kids, &list, &|id| self.is_running(slug, id));
        let f = pt::FreshFeature { status, table, auto: t.is("freshAuto") };
        crate::prompts::chat::fresh_chat_note(&prompt_ticket(t), last.as_deref(), &recent, Some(&f))
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
        let sid = ts(&t, "sessionId").map(str::to_string);
        let mut earlier = t.get("earlierSessions").filter(|v| !v.is_null()).cloned();
        if let Some(s) = &sid
            && (t.is("sessionStarted") || self.session_exists(s))
        {
            let mut list = earlier.and_then(|e| e.as_array().cloned()).unwrap_or_default();
            list.push(json!({ "sessionId": s, "endedAt": now_iso() }));
            earlier = Some(Value::Array(list));
        }
        let text = if auto {
            crate::runloop::rules::AUTO_FRESH_NOTE
        } else if self.seeds_from_status(slug, &t) {
            "Started a fresh chat: Claude starts from the status and can look up earlier messages."
        } else {
            "Started a fresh chat: Claude no longer sees the earlier messages; it gets the ticket, its last result and recent comments instead."
        };
        self.note(slug, id, text);
        let mut p = obj(json!({ "sessionId": uuid(), "sessionStarted": false, "freshSession": true, "freshAuto": if auto { Value::Bool(true) } else { Value::Null } }));
        if let Some(e) = earlier {
            p.insert("earlierSessions".into(), e);
        }
        self.patch(slug, id, p)
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

    /// `scheduleContext`: which schedule a schedule's ticket comes from. STAND-IN (R10): a quiet schedule's open
    /// items aren't listed yet.
    pub(super) fn schedule_context(&self, slug: &str, t: &Tk) -> Option<pt::ScheduleRef> {
        let sid = ts(t, "scheduleId")?.to_string();
        let file = ckanban_core::DataDir::new(self.root.clone()).profile_dir(slug).join("schedules").join(format!("{sid}.json"));
        let s = std::fs::read_to_string(file).ok().and_then(|t| crate::runs::js::parse(&t));
        Some(pt::ScheduleRef { id: sid, name: s.as_ref().and_then(|s| s.get("name")).and_then(Value::as_str).map(str::to_string), board: slug.into(), quiet: None })
    }

    /// The board's own tool servers (`board-tools.json`'s `mcpServers`), not ours.
    fn board_tools(&self, slug: &str) -> Map<String, Value> {
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
    pub(super) fn mcp_config(&self, servers: Map<String, Value>) -> String {
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

    /// `browserServers`: tool servers for the board browsers in a list (without starting them).
    pub(super) fn browser_servers(&self, picks: Option<&Value>, out_dir: Option<&std::path::Path>) -> Map<String, Value> {
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
                servers.extend(self.browser_servers(picks.as_ref(), Some(&out)));
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

    /// `runBrowsers`: each chosen board browser started and held for the run (`lease`); one that can't start is left
    /// out and the run told so. Nothing chosen: nothing changes.
    pub(super) async fn run_browsers(&self, slug: &str, id: &str, lease: &str, out_dir: &std::path::Path) -> RunBrowsers {
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
            let ids: Vec<String> = own.iter().map(|(i, _)| i.clone()).collect();
            let got = b.board_browsers.acquire(lease, &ids).await;
            let up: Vec<Value> = own.iter().filter(|(i, _)| got.get(i).is_some_and(|r| r.is_ok())).map(|(i, _)| json!({ "kind": "board", "id": i })).collect();
            servers = self.browser_servers(Some(&Value::Array(up)), Some(out_dir));
            for (pid, note) in own {
                let Some(bb) = b.board_browsers.get(&pid) else { continue };
                let r = got.get(&pid);
                board.push(BoardBrowserChoice {
                    id: bb.id.clone(),
                    name: bb.name.clone(),
                    note,
                    server: crate::browsers::board_browsers::server_name(&bb.id),
                    available: r.is_some_and(|r| r.is_ok()),
                    why: r.and_then(|r| r.as_ref().err().cloned()),
                });
            }
        }
        let choice: Option<pt::ChromeChoice> = chrome.and_then(|c| serde_json::from_value(c.to_json()).ok());
        let note = crate::prompts::rules::chrome_choice_note(choice.as_ref(), &board);
        RunBrowsers { servers, note, no_chrome: !board.is_empty() && choice.is_none() }
    }
}
