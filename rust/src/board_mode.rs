//! Board mode in the server (`docs/rust-port-board-plan.md` 3.1): decides at start whether the Rust board
//! (`ckanban-board`, `rust/board/`) owns the board this time, and holds it while it does. Off by default: without
//! `CKANBAN_RUST_BOARD=1` or `<data>/rust-board` holding `on`, nothing here runs and `ckanban-rs dev` is the front
//! server it was.
//!
//! On: take `<data>/board.lock`, start the Rust core, then start Bun as the satellite (`CKANBAN_SATELLITE=1`). If the
//! lock is held or the core can't start, or board mode ended uncleanly three times in 10 minutes, Bun runs the whole
//! board instead (full mode, as with board mode off) and the reason goes to this process's output (`daemon.log`
//! under launchd) and `<data>/rust-board-status.json`.
//!
//! Every request in board mode goes through `handle` (R13), in Bun's order (`route()` and `api()` in
//! `src/api/server.ts`): the satellite's own calls (`/api/internal/...` with the edge header,
//! `ckanban_board::gate::edge`); the request gate (`requestRefusal`: Host, the Origin of a change; on the phone access
//! listener phone access on, the tailnet host and the owner's login), a plain-text 403 as Bun sends it; the system
//! routes (R13: `health`, `version`, `claude/*`, `pick-folder`, `cron/preview`, `debug/profile`), each after the
//! Telegram front desk's gate (asked of the satellite) and the JSON-only rule; then the other tasks' routes below; on
//! this Mac's listener the front's native routes (usage, spend, passes, agents), then Bun; on the phone access
//! listener Bun, told it is a phone request. Bun checks the gate again on its side.
//!
//! Routes the Rust board answers itself (more with each task): `GET /api/events`; R1's reads from the ticket index
//! (`GET /api/profiles`, `/api/profiles/:p`, `/api/profiles/:p/tickets`, `/api/profiles/:p/tickets/:id`,
//! `/api/tickets`, `/api/inbox`); the session routes (R5: a ticket's conversation, tool, agent and workflow details,
//! chat search and read, the board folder's sessions); a ticket's outputs, the files its chat mentions, its Changes
//! tab, the board's Files panel, `detect-setup` and `/api/version-history` (R6, `ckanban_board::git::routes`); the browsers,
//! devices and terminal routes (R9, `ckanban_board::browsers::routes`); the team routes (R11b:
//! `/api/profiles/:p/huddle-presets`, `/huddle-templates`, `POST /squads`, `/huddle-notes`, after the same Host,
//! Origin and JSON type checks Bun makes); the quick chat routes (R8: `/api/profiles/:p/chats...`; quick chats
//! replying when board mode stops are continued at the next start); the ticket and board writes (R2a,
//! `ckanban_board::tickets::routes`: create, change, delete, move, comments, snooze, seen, the chat's cards, boards
//! POST/PATCH/DELETE, attachments, avatars, snippets); the huddle rooms (R11a, `ckanban_board::huddles::routes`:
//! `/api/profiles/:p/huddles...`, after the team routes' gate).
//! The outside services (P2, `crate::outside`): `/api/mcp*`, `/api/agents*`, `/api/remote`, `/api/passes*` and
//! `/api/bug-report*`, on both listeners, right after the system routes.
//! Everything else goes on to the usage, spend, passes and agents routes, then to Bun, as in front mode.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use ckanban_board::browsers::{self, Browsers, FileLookup};
use ckanban_board::core::{Core, Services};
use ckanban_board::events::{self, EventHooks};
use ckanban_board::gate::edge::{self, SATELLITE_HEADER, SatelliteClient};
use ckanban_board::gate::remote::RemoteFile;
use ckanban_board::gate::request::{self, LISTENER_HEADER, Listener, Seen};
use ckanban_board::gate::{housekeeping, system, update::UpdateChecker};
use ckanban_board::runs::js;
use ckanban_board::runs::model_versions::ModelVersions;
use ckanban_board::schedules::cron;
use ckanban_board::git::{self, routes::GitRoutes};
pub use ckanban_board::git::routes::Next;
use ckanban_board::lock::{self, BoardLock};
use ckanban_board::mode::{self, Decision};
use ckanban_board::quickchat::routes::{self as chat_routes, ChatReq, UserCheck};
use ckanban_board::quickchat::{QuickChatOptions, QuickChats};
use ckanban_board::satellite;
use ckanban_board::sessions::routes::{self as session_routes, HUDDLE_HEADER, RUN_HEADER};
use ckanban_board::sessions::service::Sessions;
use ckanban_board::huddles::{self as huddle_mod, AgentOptions, Agents, Huddles};
use ckanban_board::team::{self, Team};
use ckanban_board::tickets::routes::{self as write_routes, Reply, Writes};
use ckanban_board::tickets::wiring::{TicketOps, Wired};
use ckanban_board::runloop::wiring::{RunActions, RunHooks};
use ckanban_board::runloop::{RunLoop, RunLoopDeps, RunLoopOptions};
use ckanban_core::time::{iso, now_ms};
use serde_json::{Value, json};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::{CONTENT_TYPE, HOST, HeaderMap, HeaderValue, ORIGIN};
use hyper::{Method, Request, Response, StatusCode};

mod tg;

use crate::guard;
use crate::mask;
use crate::passes;
use crate::proxy::{Body, Proxy, full, plain, wants_upgrade};
use crate::routes::{Native, json_type, local_host, local_origin, query_param};

/// The largest quick chat request body Rust reads (a message is at most 100,000 characters; Bun takes up to 128 MB).
const CHAT_BODY_LIMIT: usize = 8 << 20;

/// The Telegram front desk's header: its requests go through Bun's gate (as in routes.rs).
const FRONT_DESK_HEADER: &str = "x-ckanban-frontdesk";
/// How long board mode waits for the data lock (an owner that is stopping lets go in a moment).
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// The largest request body the board's own routes read (a squad with every field full is well under 1 MB).
const MAX_BODY: usize = 8 << 20;

pub struct BoardMode {
    pub core: Arc<Core>,
    /// Teammates, squads and role notes (R11b).
    pub team: Arc<Team>,
    /// Huddle rooms (R11a).
    pub huddles: Arc<Huddles>,
    /// What runs for the huddles (R11c).
    pub agents: Arc<Agents>,
    /// Lessons, links finder, recall, ticket and team usage (R12).
    pub extras: Arc<ckanban_board::extras::Extras>,
    /// Schedules, one-time jobs and automations, and their timers (R10).
    pub schedules: Arc<ckanban_board::schedules::Schedules>,
    /// R9: devices, board browsers, named Chromes and the terminal.
    browsers: Arc<Browsers>,
    browser_routes: browsers::routes::RouteCtx,
    /// The same for a phone request: `userOnly` lets the owner's phone in after the header checks (Bun's
    /// `listener === "remote"`; the phone listener's gate already checked the login).
    phone_routes: browsers::routes::RouteCtx,
    sessions: Arc<Sessions>,
    chats: Arc<QuickChats>,
    hooks: Arc<EventHooks>,
    git: Arc<GitRoutes>,
    /// R2a: the ticket and board writes.
    writes: Arc<Writes>,
    /// R7a: the run loop.
    pub runs: Arc<RunLoop>,
    /// What the satellite asks of the board (R7a: Telegram messages and marks, comments).
    actions: Arc<dyn ckanban_board::api::BoardActions>,
    /// Notified when a requested restart may go ahead (no work left, or 2 minutes passed): `dev()` then stops.
    pub exit: Arc<tokio::sync::Notify>,
    /// Keep-awake while boards with "Keep this Mac awake" have work going (`GET /api/awake`).
    awake: Arc<ckanban_board::runs::awake::StayAwake>,
    /// The pass store, for key cards (set once the satellite answers: it hears of the passes file changing).
    passes: Arc<std::sync::OnceLock<Arc<passes::Passes>>>,
    public_port: u16,
    remote_port: u16,
    root: PathBuf,
    secret: String,
    remote: RemoteFile,
    updates: UpdateChecker,
    /// `learnedVersions` for `claude/defaults` (`<data>/model-versions.json`; R7a's runs will share one).
    versions: ModelVersions,
    /// P2: the outside services (MCP servers, passes and sign-ins, phone access, agents, bug reports), once the server
    /// knows its Bun (`connect_outside`); until then their requests go to the satellite.
    outside: OnceLock<Arc<crate::outside::routes::Outside>>,
    outside_sat: Arc<crate::outside::edge::OutsideSatellite>,
    publish_run: Arc<OnceLock<ckanban_board::git::publish::PublishRun>>,
    /// Lines to the satellite's stdin, once it runs (`connect_satellite`).
    tell: OnceLock<tokio::sync::mpsc::UnboundedSender<String>>,
    /// P1a: the helper (what waits on the user, its messages and decisions); the satellite still sends.
    pub helper: Arc<ckanban_board::helper::Helper>,
    /// P1c: Telegram and the front desk (`connect_telegram`, once the server has its routes and Bun).
    telegram: Arc<OnceLock<Arc<ckanban_board::telegram::Telegram>>>,
    /// The satellite's stdin for the helper's notices (waits closed): kept until it runs, then sent.
    helper_tell: Arc<Mutex<HelperTell>>,
    /// True once the satellite runs: the helper's sends wait for it.
    satellite_ready: Arc<tokio::sync::watch::Sender<bool>>,
    _lock: BoardLock,
}

/// The satellite's stdin as the helper uses it: the lines from before it ran, then the sender.
#[derive(Default)]
struct HelperTell {
    tell: Option<tokio::sync::mpsc::UnboundedSender<String>>,
    early: Vec<String>,
    /// Waits closed before Telegram runs (P1c): their alerts are edited once it does.
    early_closed: Vec<ckanban_board::helper::waits::Rec>,
}

/// Board mode for this start, or None: Bun runs the whole board (off, or a fallback, already logged and recorded).
/// `internal_port` and `secret` are the satellite's, for the calls the board makes to it.
pub async fn prepare(root: &Path, public_port: u16, remote_port: u16, internal_port: u16, secret: &str) -> Option<Arc<BoardMode>> {
    let wanted = mode::wanted(std::env::var(mode::ENV).ok().as_deref(), root);
    let last = mode::read_status(root);
    let crashes = match mode::decide(&wanted, last.as_ref(), mode::switch_written(root), now_ms()) {
        Decision::Off => {
            mode::record_off(root);
            return None;
        }
        Decision::Fallback { reason, crashes } => return fall_back(root, &reason, crashes),
        Decision::Try { crashes } => crashes,
    };
    let r = root.to_path_buf();
    let taken = tokio::task::spawn_blocking(move || lock::take(&r, LOCK_WAIT)).await.unwrap_or_else(|e| Err(e.to_string()));
    let lock = match taken {
        Ok(l) => l,
        Err(e) => return fall_back(root, &e, crashes),
    };
    let sessions = Sessions::new(root, text_masker(root));
    let mut services = Services::stand_ins();
    services.sessions = sessions.clone();
    // R7a: the run loop, made once the ticket writes and families exist; services made before it ask it through this.
    let late_runs = ckanban_board::runloop::wiring::LateRuns::new();
    services.runs = late_runs.clone();
    let browsers = Browsers::new(root, Arc::new(FileLookup::new(root)), services.sessions.clone());
    services.devices = browsers.clone();
    // P2: pass calls and publishing are the board's own; the helper's calls still go to the satellite.
    let outside_sat = crate::outside::edge::OutsideSatellite::new(Arc::new(SatelliteClient::new(internal_port, public_port, secret)));
    services.satellite = outside_sat.clone();
    // R11a: huddle rooms (their live state goes into every ticket view).
    let team = Arc::new(Team::new(root));
    let huddles = Huddles::new(root, team.clone());
    huddles.files.set_mask(masker(root));
    services.huddles = huddles.clone();
    let core = Core::new(root, services);
    browsers.attach(core.bus.clone());
    browsers.set_linked(browsers::linked_from_index(core.index.clone(), browsers.lookup.clone()));
    if let Err(e) = core.start(Core::steps()).await {
        // Let go first: Bun's full mode takes the lock next.
        drop(lock);
        return fall_back(root, &e, crashes);
    }
    // The session watcher and the projects folder feed (R5): `session.updated` on the board's event stream.
    sessions.start(&core);
    // Quick chats (R8): replies a stop cut off are continued and held messages sent (`quickChats.recover`); at the
    // stop, replies in progress are marked for the next start.
    let chats = QuickChats::new(root, core.bus.clone(), QuickChatOptions::from_env());
    let c = chats.clone();
    let _ = tokio::task::spawn_blocking(move || c.recover()).await;
    let c = chats.clone();
    core.on_stop("quick chats", move || c.shutdown());
    if let Err(e) = mode::record_board(root, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    eprintln!("ckanban-rs: board mode: the Rust board owns this data folder; Bun runs as its satellite");
    // Start-up clean-ups, report-only (plan 5.3); the satellite skips its own.
    let r = root.to_path_buf();
    tokio::spawn(async move { housekeeping::at_start(&r).await });
    // Board browsers adopted (Bun's Chromes included), their upkeep and the terminal watcher, in the background.
    browsers.start(&core);
    let mask = masker(root);
    let hooks = Arc::new(EventHooks { views: core.services.views.clone(), cut: core.services.cut.clone(), mask: mask.clone() });
    let browser_routes = browsers::routes::RouteCtx {
        public_port,
        mask: mask.clone(),
        user_only: Arc::new(|h, peer| Box::pin(async move { crate::guard::user_only(&h, peer).await })),
    };
    let phone_routes = browsers::routes::RouteCtx {
        public_port,
        mask: mask.clone(),
        user_only: Arc::new(|h, _peer| Box::pin(async move { crate::guard::headers_allow(&h) })),
    };
    // P2: the Share menu's Publish; the helper command is known once the server has its Bun (`connect_outside`).
    let publish_run: Arc<OnceLock<ckanban_board::git::publish::PublishRun>> = Arc::new(OnceLock::new());
    let pr = publish_run.clone();
    let publisher = ckanban_board::git::publish::Publisher::new(
        core.tickets.clone(),
        Arc::new(move |ask: Value| match pr.get() {
            Some(run) => run(ask),
            None => Box::pin(async { json!({ "ok": false, "error": "the board is still starting; try again in a moment" }) }),
        }),
    );
    let _ = outside_sat.publisher.set(publisher.clone());
    let git = GitRoutes::new(root, public_port, mask, core.services.runs.clone()).with_publisher(publisher);
    git::start_jobs(&core);
    // R2a: ticket writes, with comments masked as they are saved and the steps already in Rust plugged in.
    core.tickets.set_mask(text_masker(root));
    let s = sessions.clone();
    core.tickets.on_written(move |slug, id| s.ticket_changed(slug, id));
    let ops = Arc::new(TicketOps { tickets: core.tickets.clone(), families: Default::default(), runs: Default::default() });
    let landing = git::landing::Git::new(root, ops.clone());
    // R2b: families, plans and the feature status; what needs a run waits for the run loop (R7a).
    let families = ckanban_board::families::Families::new(core.tickets.clone(), core.reads.clone());
    let _ = ops.families.set(families.clone());
    families.set_landing(landing.clone());
    let f = families.clone();
    core.on_stop("plans", move || f.shutdown());
    // R7a: the run loop (chat, runs, queue, slots, limits, follow-ups, stop, the restart gate, recovery).
    let mut opts = RunLoopOptions::from_env();
    let key_root = root.to_path_buf();
    opts.key_env = Arc::new(move |slug: &str| passes::board_key_env(&key_root, slug));
    opts.mask = text_masker(root);
    let json_mask = masker(root);
    opts.mask_json = Arc::new(move |t: &str| json_mask(t));
    opts.tools_version = crate::mcp::tools_version();
    // R7b: Claude Code's bundled skills (learned from a run's init event) are kept in Bun's file.
    ckanban_board::chat::commands::use_bundled_file(Some(root.join("claude-commands.json")));
    let runs = RunLoop::new(RunLoopDeps {
        root: root.to_path_buf(),
        tickets: core.tickets.clone(),
        bus: core.bus.clone(),
        families: families.clone(),
        git: landing.clone(),
        sessions: sessions.clone(),
        huddles: core.services.huddles.clone(),
        browsers: Some(browsers.clone()),
        devices: browsers.clone(),
        satellite: core.services.satellite.clone(),
        opts,
    });
    late_runs.set(runs.clone());
    let _ = ops.runs.set(runs.clone());
    runs.set_ops(ops.clone());
    families.set_runs(runs.clone());
    // R10: schedules, one-time jobs and automations; their timers start once the runs are recovered (below).
    let pass_secrets = secrets_of(root);
    let schedules = ckanban_board::schedules::Schedules::new(ckanban_board::schedules::Deps {
        root: root.to_path_buf(),
        tickets: core.tickets.clone(),
        bus: core.bus.clone(),
        families: families.clone(),
        runs: runs.clone(),
        satellite: core.services.satellite.clone(),
        side: ckanban_board::extras::side_caller(),
        passes: ckanban_board::schedules::passbook::PassBook::new(root, Arc::new(move |t: &str| mask::mask_text(t, &pass_secrets()[..]))),
        port: public_port,
    });
    runs.set_schedules(schedules.clone());
    let helper_runner: Arc<OnceLock<Arc<ckanban_board::helper::runner::HelperRunner>>> = Arc::new(OnceLock::new());
    core.tickets.set_hooks(Arc::new(Wired {
        git: Some(landing.clone()),
        families: Some(families.clone()),
        browsers: Some(browsers.clone()),
        huddles: Some(huddles.clone()),
        root: root.to_path_buf(),
        runs: Some(Arc::new(RunHooks { runs: runs.clone() })),
        schedules: Some(schedules.clone()),
        helper: helper_runner.clone(),
    }));
    // R11c: what runs for a huddle (helpers' runs, ticket sessions' replies, auto huddles, the session viewer), set
    // before recover() so helpers cut off by the last stop carry on.
    let agents = Agents::new(&huddles, runs.clone(), Some(sessions.clone()), AgentOptions::from_env(&runs.opts.claude_bin));
    huddles.set_runner(agents.clone());
    // R11a: huddles see ticket changes (a host moved to Done closes its huddles), wakes owed from before the start are
    // delivered, and the idle watchdog looks at the live ones every 30 s, off the runtime.
    huddles.attach(core.tickets.clone(), sessions.clone());
    team.set_learning_cards(huddles.clone());
    let h = huddles.clone();
    let watchdog = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(ckanban_board::huddles::model::IDLE_SWEEP_MS));
        tick.tick().await;
        loop {
            tick.tick().await;
            let h = h.clone();
            let _ = tokio::task::spawn_blocking(move || h.idle_sweep()).await;
        }
    });
    core.on_stop("huddle idle sweep", move || watchdog.abort());
    // A helper's session changed: `huddle.session` tells an open session viewer to refetch (every 2 s, off the runtime).
    let (h, s) = (huddles.clone(), sessions.clone());
    let viewer = tokio::spawn(async move {
        let state = Arc::new(std::sync::Mutex::new((std::collections::HashMap::new(), true)));
        let mut tick = tokio::time::interval(ckanban_board::sessions::service::WATCH_EVERY);
        loop {
            tick.tick().await;
            let (h, s, state) = (h.clone(), s.clone(), state.clone());
            let _ = tokio::task::spawn_blocking(move || {
                let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
                let first = st.1;
                let version = |sid: &str| s.cache.version(sid);
                ckanban_board::huddles::session::poll_sessions(&h, &version, &mut st.0, first, ckanban_core::time::now_ms());
                st.1 = false;
            })
            .await;
        }
    });
    core.on_stop("huddle session watcher", move || viewer.abort());
    let h = huddles.clone();
    core.on_stop("huddles", move || h.shutting_down.store(true, std::sync::atomic::Ordering::Relaxed));
    let passes: Arc<std::sync::OnceLock<Arc<passes::Passes>>> = Arc::new(std::sync::OnceLock::new());
    let p = passes.clone();
    let save_keys: write_routes::SaveKeys = Arc::new(move |slug, keys| match p.get() {
        Some(p) => p.save_board_keys(slug, keys),
        None => Err((503, "the board is still starting; try again in a moment".into())),
    });
    let writes = Arc::new(Writes::new(core.tickets.clone(), core.reads.clone(), sessions.clone(), save_keys));
    writes.set_families(families);
    writes.set_runs(runs.clone());
    // R7b: Say it simpler, Help me understand and the Context panel (tickets and quick chats); a Context check runs
    // in the background after each run.
    let chat_extras = ckanban_board::chat::extras::ChatExtras::new(
        core.tickets.clone(),
        sessions.clone(),
        huddles.clone(),
        chats.clone(),
        core.bus.clone(),
        ckanban_board::extras::side_caller(),
    );
    chat_extras.set_runs(runs.clone());
    writes.set_chat_extras(chat_extras.clone());
    // Quick chats hold their messages while a restart waits, and the restart waits for their replies.
    let (r1, r2) = (runs.clone(), runs.clone());
    chats.set_gate(ckanban_board::quickchat::service::RestartGate { pending: Arc::new(move || r1.restart_pending()), work_changed: Arc::new(move || r2.restart_work_changed()) });
    // R7b: Make ticket from a quick chat goes through the ticket writes and the run loop's link-session.
    chats.set_make_ticket(ckanban_board::chat::quick::make_ticket_hook(runs.clone(), writes.clone()));
    let c = chats.clone();
    runs.on_restart_busy(Arc::new(move || c.restart_busy()));
    let h = core.services.huddles.clone();
    runs.on_restart_busy(Arc::new(move || h.restart_busy()));
    // recover(): what the last daemon left (Bun's or Rust's), once every board's tickets are loaded.
    let r = runs.clone();
    let index = core.index.clone();
    let _ = tokio::task::spawn_blocking(move || {
        index.wait_loaded(Duration::from_secs(600));
        r.recover();
    })
    .await;
    // Then the huddles' (Bun's order): helpers cut off carry on, wakes owed are delivered, the auto-huddle slot.
    let h = huddles.clone();
    let _ = tokio::task::spawn_blocking(move || h.op(|h| h.recover())).await;
    let awake = start_run_timers(&core, &runs, ops.clone(), root, helper_runner.clone());
    // The worktree sweep, after recover() like Bun's (which starts it once recover has begun).
    git::sweep_after_recover(landing.clone());
    // After recover(): a missed run's ticket must not be mistaken for an interrupted one. Only this owner of the
    // board fires schedules, jobs and automations (the satellite starts none of its timers).
    let stop = schedules.start();
    core.on_stop("schedules", stop);
    team.set_ticket_cards(Arc::new(ckanban_board::tickets::wiring::SquadCards { tickets: core.tickets.clone() }));
    // R12: the learner watches tickets settle; new tickets get a parent suggestion.
    let extras = ckanban_board::extras::Extras::new(&core, ckanban_board::extras::side_caller());
    extras.start();
    let x = extras.clone();
    runs.set_recall(Arc::new(move |slug: &str, t: &serde_json::Map<String, Value>| x.recall(slug, t)));
    // A huddle agent's lessons go to the learner's pile (Bun's `learn` option of Huddles).
    let learner = extras.learner.clone();
    huddles.set_learn(Arc::new(move |slug, h, p, role, lessons| {
        let text = |v: &serde_json::Value, k: &str| v.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let lessons: Vec<ckanban_board::team::notes::Lesson> = lessons
            .iter()
            .map(|l| ckanban_board::team::notes::Lesson {
                text: text(l, "text"),
                evidence: text(l, "evidence"),
                scope: if l.get("scope").and_then(serde_json::Value::as_str) == Some("repo") { "repo" } else { "general" },
            })
            .collect();
        let get = |o: &serde_json::Map<String, serde_json::Value>, k: &str| o.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let (l, slug, hid, host, handle, role) = (learner.clone(), slug.to_string(), get(h, "id"), get(h, "hostTicket"), get(p, "handle"), role.to_string());
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                l.add_huddle_lessons(&slug, &hid, &host, &handle, &role, lessons).await;
            });
        }
    }));
    // P1a: the helper. It owns waits.json, messages.json, helper-state.json and helper.json and is notify.json's only
    // writer; the satellite still sends (push, ntfy, the Mac banner, Telegram) and runs Telegram and the front desk.
    let helper_tell: Arc<Mutex<HelperTell>> = Arc::new(Mutex::new(HelperTell::default()));
    let satellite_ready = Arc::new(tokio::sync::watch::channel(false).0);
    // P1c: waits closed: their Telegram alerts say so and lose their buttons (Rust's Telegram, once it runs; closed
    // before that at start-up are kept for it).
    let telegram: Arc<OnceLock<Arc<ckanban_board::telegram::Telegram>>> = Arc::new(OnceLock::new());
    let (tgc, rt) = (telegram.clone(), tokio::runtime::Handle::current());
    let early_closed = helper_tell.clone();
    let on_closed: ckanban_board::helper::waits::Closed = Arc::new(move |recs| match tgc.get() {
        Some(t) => {
            let t = t.clone();
            rt.spawn(async move { t.waits_closed(recs).await });
        }
        None => early_closed.lock().unwrap_or_else(|e| e.into_inner()).early_closed.extend(recs),
    });
    let helper = ckanban_board::helper::Helper::new(
        root,
        Arc::new(ckanban_board::helper::wired::BoardSide { tickets: core.tickets.clone(), reads: core.reads.clone(), sessions: sessions.clone(), root: root.to_path_buf(), port: public_port, remote: RemoteFile::new(root) }),
        Arc::new(ckanban_board::helper::wired::SplitSender {
            sat: ckanban_board::helper::wired::SatelliteSender(Arc::new(SatelliteClient::new(internal_port, public_port, secret)), satellite_ready.subscribe()),
            telegram: telegram.clone(),
        }),
        ckanban_board::extras::side_caller(),
        core.bus.clone(),
        Some(on_closed),
    );
    let _ = helper_runner.set(helper.runner.clone());
    let (w, broot) = (helper.watch.clone(), root.to_path_buf());
    browsers.board_browsers.set_on_logged_out(Arc::new(move |bid: &str, name: &str, site: Option<&str>| {
        let (w, bid, name, site) = (w.clone(), bid.to_string(), name.to_string(), browsers::sign_in::site_name(site));
        let root = broot.clone();
        let using: Vec<(String, String)> = {
            let dd = ckanban_core::DataDir::new(root);
            let mut slugs = boards(&dd.root);
            slugs.sort();
            slugs
                .into_iter()
                .filter_map(|slug| dd.profile(&slug).map(|p| (slug, p.record.0)))
                .filter(|(_, p)| browsers::chromes::own_picks(Some(&Value::Object(p.clone()))).unwrap_or_default().iter().any(|x| x.kind == "board" && x.id.as_deref() == Some(bid.as_str())))
                .map(|(slug, p)| {
                    let n = p.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or(&slug).to_string();
                    (slug, n)
                })
                .collect()
        };
        tokio::spawn(async move {
            let names: Vec<String> = using.iter().map(|(_, n)| n.clone()).collect();
            let err = w.browser_logged_out(&name, &site, using.first().map(|(s, _)| s.as_str()), &names).await;
            eprintln!("[browsers] {name} ({bid}): logged-out alert sent{}", if err.is_some() { " (one channel failed; see Settings, Notifications)" } else { "" });
        });
    }));
    let index = core.index.clone();
    let stop = helper.start(core.bus.clone(), ckanban_board::helper::Timing::default(), Arc::new(move || {
        index.wait_loaded(Duration::from_secs(600));
    }));
    core.on_stop("helper", stop);
    let hc = helper.core.clone();
    writes.set_opened(Arc::new(move |slug: &str, id: &str| hc.opened(slug, id)));
    let runs_for_actions = runs.clone();
    Some(Arc::new(BoardMode {
        core,
        team,
        huddles,
        agents,
        extras,
        schedules,
        sessions,
        chats,
        browsers,
        browser_routes,
        phone_routes,
        hooks,
        git,
        writes,
        runs,
        actions: Arc::new(RunActions { runs: runs_for_actions }),
        exit: Arc::new(tokio::sync::Notify::new()),
        awake,
        passes,
        public_port,
        remote_port,
        root: root.to_path_buf(),
        secret: secret.to_string(),
        remote: RemoteFile::new(root),
        updates: UpdateChecker::new(),
        versions: ModelVersions::new(Some(root.join("model-versions.json"))),
        tell: OnceLock::new(),
        helper,
        telegram,
        helper_tell,
        satellite_ready,
        outside: OnceLock::new(),
        outside_sat,
        publish_run,
        _lock: lock,
    }))
}

/// The run loop's timers (Bun's `startDaemon` after `recover()`): automatic continues after a usage limit, due
/// follow-ups (`CKANBAN_TICK_MS` shortens their period for tests), the PR poller, keep-awake. Each stops with the core.
fn start_run_timers(core: &Arc<Core>, runs: &Arc<RunLoop>, ops: Arc<TicketOps>, root: &Path, helper: Arc<OnceLock<Arc<ckanban_board::helper::runner::HelperRunner>>>) -> Arc<ckanban_board::runs::awake::StayAwake> {
    let every = |name: &'static str, ms: u64, f: Arc<dyn Fn() + Send + Sync>| {
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(ms.max(10)));
            loop {
                tick.tick().await;
                let f = f.clone();
                if tokio::task::spawn_blocking(move || f()).await.is_err() {
                    eprintln!("[board] {name} tick failed");
                }
            }
        });
        core.on_stop(name, move || task.abort());
    };
    let tick_ms = std::env::var("CKANBAN_TICK_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|n| *n > 0);
    let r = runs.clone();
    every("limit-watcher", 30_000, Arc::new(move || r.limit_tick()));
    let r = runs.clone();
    every("followups", tick_ms.unwrap_or(30_000), Arc::new(move || r.follow_up_tick()));
    let minutes = std::fs::read_to_string(root.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("prPollMinutes").and_then(Value::as_f64))
        .unwrap_or(5.0);
    let poller = ckanban_board::git::pr::start_poller(ops, Arc::new(ckanban_board::git::pr::GhCli), minutes.max(0.0) as u64);
    core.on_stop("pr-poller", move || poller.abort());
    // Run logs of tickets Done for over 30 days are compressed a few at a time (report-only until
    // CKANBAN_RUST_DELETE=1, plan 5.3).
    let compressor = ckanban_board::runs::run_log_compress::RunLogCompressor::new(root, runs.clone(), Default::default());
    let stop = compressor.start();
    core.on_stop("run-log-compress", stop);
    let (r, root2, bus) = (runs.clone(), root.to_path_buf(), core.bus.clone());
    let awake = ckanban_board::runs::awake::StayAwake::new(ckanban_board::runs::awake::StayAwakeOptions {
        wanted: Box::new(move || {
            r.busy_boards().iter().any(|slug| {
                let p = ckanban_core::DataDir::new(root2.clone()).profile(slug).map(|p| p.record.0);
                p.and_then(|p| p.get("keepAwake").cloned()) != Some(Value::Bool(false))
            }) || helper.get().is_some_and(|h| h.wants_awake())
        }),
        on_change: Some(Box::new(move |held| bus.emit_json(json!({ "type": "awake.updated", "held": held })))),
        platform: None,
        pid: None,
        spawn: None,
        interval_ms: None,
    });
    let stop = awake.start();
    core.on_stop("keep-awake", stop);
    awake
}

fn fall_back(root: &Path, reason: &str, crashes: Vec<String>) -> Option<Arc<BoardMode>> {
    eprintln!("ckanban-rs: board mode is off for this start, Bun runs the whole board: {reason}");
    if let Err(e) = mode::record_fallback(root, reason, crashes) {
        eprintln!("ckanban-rs: can't write {}: {e}", mode::status_path(root).display());
    }
    None
}

/// The pass store's secrets, read again only when the passes file changes.
fn secrets_of(root: &Path) -> impl Fn() -> Arc<Vec<String>> + Send + Sync + 'static {
    let file = root.join(passes::PASSES_FILE);
    let root = root.to_path_buf();
    let cache: Mutex<Option<((Option<SystemTime>, u64), Arc<Vec<String>>)>> = Mutex::new(None);
    move || {
        let stamp = std::fs::metadata(&file).map(|m| (m.modified().ok(), m.len())).unwrap_or((None, 0));
        let mut c = cache.lock().unwrap_or_else(|p| p.into_inner());
        match &*c {
            Some((s, v)) if *s == stamp => v.clone(),
            _ => {
                let v = Arc::new(passes::current_secrets(&root));
                *c = Some((stamp, v.clone()));
                v
            }
        }
    }
}

/// `maskSaved` (plain text, a stored chat preview) with the pass store's secrets.
fn text_masker(root: &Path) -> Arc<dyn Fn(&str) -> String + Send + Sync> {
    let secrets = secrets_of(root);
    Arc::new(move |text: &str| {
        let mut out = text.to_string();
        for s in secrets().iter() {
            if out.contains(s.as_str()) {
                out = out.replace(s.as_str(), "***");
            }
        }
        out
    })
}

/// `maskSavedJson` with the pass store's secrets, read again only when the passes file changes.
fn masker(root: &Path) -> events::Mask {
    let secrets = secrets_of(root);
    Arc::new(move |text: &str| mask::mask_saved_json(&secrets(), text))
}

/// A route the Rust board answers itself (Bun's conditions on the decoded path parts, `src/api/system.ts`).
#[derive(Debug, Clone, PartialEq)]
pub enum Own {
    Events,
    Health,
    Version,
    Profile,
    CronPreview,
    ClaudeProjects,
    ClaudeDefaults,
    PickFolder,
    /// `GET`/`POST /api/restart` (R7a: the restart gate).
    Restart,
    /// `GET /api/awake`.
    Awake,
}


/// Which own route a request is, if any.
pub fn own_route(method: &Method, path: &str) -> Option<Own> {
    let parts = api_parts(path.strip_prefix("/api/")?)?;
    let p = |i: usize| parts.get(i).map(String::as_str);
    let get = *method == Method::GET;
    let post = *method == Method::POST;
    Some(match (p(0)?, p(1)) {
        ("health", _) if get => Own::Health,
        ("debug", Some("profile")) if post => Own::Profile,
        ("events", _) if get => Own::Events,
        ("version", _) if get => Own::Version,
        ("cron", Some("preview")) if get && parts.len() == 2 => Own::CronPreview,
        ("claude", Some("projects")) if get => Own::ClaudeProjects,
        ("claude", Some("defaults")) if get => Own::ClaudeDefaults,
        ("pick-folder", _) if post => Own::PickFolder,
        ("restart", None) if (get || post) && parts.len() == 1 => Own::Restart,
        ("awake", None) if get && parts.len() == 1 => Own::Awake,
        _ => return None,
    })
}

/// `URLSearchParams.get(name)` of a query.
fn query_value(query: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
}

/// A phone request's own Host and Origin lines, put back before it goes to Bun (`as_local`).
struct Sent {
    host: Vec<HeaderValue>,
    origin: Vec<HeaderValue>,
}

impl Sent {
    fn restore(self, h: &mut HeaderMap) {
        h.remove(HOST);
        h.remove(ORIGIN);
        for v in self.host {
            h.append(HOST, v);
        }
        for v in self.origin {
            h.append(ORIGIN, v);
        }
    }
}

/// Shows a phone request that passed the gate to the routes that check this Mac's Host and Origin: Host
/// `127.0.0.1:<port>`, and an Origin (when it sent one) of the board's page here.
fn as_local(h: &mut HeaderMap, port: u16) -> Sent {
    let sent = Sent { host: h.get_all(HOST).iter().cloned().collect(), origin: h.get_all(ORIGIN).iter().cloned().collect() };
    let had_origin = sent.origin.iter().any(|o| !o.is_empty());
    h.remove(HOST);
    h.remove(ORIGIN);
    if let Ok(v) = HeaderValue::from_str(&format!("127.0.0.1:{port}")) {
        h.insert(HOST, v.clone());
        if had_origin && let Ok(o) = HeaderValue::from_str(&format!("http://127.0.0.1:{port}")) {
            h.insert(ORIGIN, o);
        }
    }
    sent
}

/// A request on to Bun; a phone request (its own Host and Origin back) marked as one.
async fn to_bun(mut req: Request<Body>, peer: SocketAddr, sent: Option<Sent>, proxy: &Proxy) -> Response<Body> {
    match sent {
        Some(sent) => {
            sent.restore(req.headers_mut());
            proxy.forward_as(req, peer, &[(edge::VIA_HEADER, "remote")]).await
        }
        None => proxy.forward(req, peer).await,
    }
}

/// A body read whole, up to `MAX_BODY`.
async fn read_body(body: Body) -> Result<Bytes, String> {
    Limited::new(body, MAX_BODY).collect().await.map(|c| c.to_bytes()).map_err(|e| format!("can't read the request body: {e}"))
}

/// The text Bun's gate sends: 403, plain text.
fn refused(text: &str) -> Response<Body> {
    plain(StatusCode::FORBIDDEN, text)
}

impl BoardMode {
    /// The answer when the Rust board answers this request itself; None: it goes on (Rust's other routes, then Bun).
    /// The event stream, and the board's read routes (R1: boards, ticket lists and scopes, one ticket, the command
    /// bar's rows, the Inbox), worked out on the blocking pool.
    pub async fn answer(&self, req: &Request<Incoming>) -> Option<Response<Body>> {
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || h.get_all(HOST).iter().count() > 1 {
            return None;
        }
        if req.method() != Method::GET {
            return None;
        }
        let path = req.uri().path().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        let events = path == "/api/events";
        if !events && !is_read_route(&path) {
            return None;
        }
        if !local_host(h, self.public_port) {
            return Some(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        if events {
            return Some(events::stream(&self.core.bus, self.hooks.clone(), events::PING_EVERY));
        }
        let reads = self.core.reads.clone();
        let (status, body) = tokio::task::spawn_blocking(move || reads.answer(&path, &query)).await.ok()??;
        let text = (self.hooks.mask)(&serde_json::to_string(&body).unwrap_or_else(|_| "null".into()));
        Some(json_text(status, text))
    }

    /// The session routes (R5), answered from Claude's transcripts; None: the request goes on (to Bun).
    pub async fn answer_sessions(&self, req: &Request<Incoming>) -> Option<Response<Body>> {
        let h = req.headers();
        let path = req.uri().path();
        if !session_routes::wanted(req.method().as_str(), path) {
            return None;
        }
        // Anything Bun's gate treats specially (the Telegram front desk, odd Host headers) stays with Bun.
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || h.get_all(HOST).iter().count() > 1 || !local_host(h, self.public_port) {
            return None;
        }
        let r = session_routes::Req {
            method: req.method().as_str().to_string(),
            path: path.to_string(),
            query: req.uri().query().map(str::to_string),
            // Every line of the header, as Bun's `headers.get` reads it.
            run: request::header_text(h, RUN_HEADER),
            huddle: request::has(h, HUDDLE_HEADER),
        };
        let reply = self.sessions.answer(r).await?;
        let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Some(passes::json_answer(status, &reply.body, &passes::current_secrets(&self.root)))
    }

    /// The quick chat routes (R8); Err hands the request on (to Rust's other routes, then Bun).
    pub async fn answer_chats(&self, req: Request<Incoming>, peer_port: u16, via: Listener) -> Result<Response<Body>, Request<Incoming>> {
        let path = req.uri().path().to_string();
        if !chat_routes::wanted(&path) {
            return Err(req);
        }
        let h = req.headers();
        // Anything Bun's gate treats specially (the Telegram front desk, odd or doubled headers) stays with Bun, whose
        // gate answers it before any route.
        if h.contains_key(FRONT_DESK_HEADER)
            || wants_upgrade(h)
            || [HOST, hyper::header::ORIGIN, hyper::header::CONTENT_TYPE].iter().any(|n| h.get_all(n).iter().count() > 1)
            || !local_host(h, self.public_port)
        {
            return Err(req);
        }
        let secrets = passes::current_secrets(&self.root);
        let method = req.method().as_str().to_string();
        let mutation = method != "GET" && method != "HEAD";
        if mutation && !local_origin(h, self.public_port) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        if matches!(method.as_str(), "POST" | "PATCH" | "PUT") && !json_type(h) {
            return Ok(passes::json_answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, &serde_json::json!({ "error": "content-type must be application/json" }), &secrets));
        }
        let headers = h.clone();
        // The owner's phone (its gate passed) is the user after the header checks, as in Bun's `userOnly`.
        let user: UserCheck = match via {
            Listener::Remote => Box::new(move || Box::pin(async move { guard::headers_allow(&headers) })),
            Listener::Local => Box::new(move || Box::pin(async move { guard::user_only(&headers, peer_port).await })),
        };
        let query = req.uri().query().map(str::to_string);
        let body = if chat_routes::reads_body(&method) {
            match Limited::new(req.into_body(), CHAT_BODY_LIMIT).collect().await {
                Ok(b) => {
                    let bytes: Bytes = b.to_bytes();
                    match std::str::from_utf8(&bytes).ok().and_then(ckanban_board::runs::js::parse) {
                        Some(v) => Ok(Some(ckanban_core::jsnum::normalize(v))),
                        None => Err(()),
                    }
                }
                Err(_) => return Ok(passes::json_answer(StatusCode::PAYLOAD_TOO_LARGE, &serde_json::json!({ "error": "message is too long" }), &secrets)),
            }
        } else {
            Ok(None)
        };
        let reply = self.chats.answer(&self.sessions, ChatReq { method, path, query, body }, user).await;
        let status = StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Ok(match reply.body {
            Some(v) => passes::json_answer(status, &v, &secrets),
            None => {
                let mut r = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
                *r.status_mut() = status;
                r
            }
        })
    }

    /// The team routes (`ckanban_board::team::routes`), or the request back when they don't take it. Bun's gate
    /// first, as `src/api/server.ts` runs it: the Host (403), the Origin of a change (403), then a JSON body type for
    /// POST, PATCH and PUT (415). Headers sent twice are joined, as Bun's `headers.get` does.
    #[allow(clippy::result_large_err)] // the request goes back whole, as `Native::answer` does
    pub async fn answer_team(&self, req: Request<Incoming>) -> Result<Response<Body>, Request<Incoming>> {
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) {
            return Err(req);
        }
        let path = req.uri().path();
        // A path Bun can't decode gets its "malformed URL" answer from Bun.
        let Some(parts) = path.strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        let method = req.method().as_str().to_string();
        if !team::routes::claims(&method, &parts) {
            return Err(req);
        }
        let host_ok = joined(h, HOST.as_str()).is_some_and(|host| ["localhost", "127.0.0.1"].iter().any(|l| host == format!("{l}:{}", self.public_port)));
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        let origin_ok = match joined(h, ORIGIN.as_str()) {
            None => true,
            Some(o) if o.is_empty() => true,
            Some(o) => ["localhost", "127.0.0.1"].iter().any(|l| o == format!("http://{l}:{}", self.public_port)),
        };
        if !host_ok || (mutation && !origin_ok) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let wants_body = matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT);
        let ctype = joined(h, CONTENT_TYPE.as_str()).unwrap_or_default();
        if wants_body && crate::js::trim(ctype.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
            return Ok(self.json(415, &serde_json::json!({ "error": "content-type must be application/json" }), false));
        }
        let has = |n: &str| request::has(h, n);
        let from_run = has(RUN_HEADER) || has(HUDDLE_HEADER);
        let scope = query_param(req.uri().query().unwrap_or(""), "scope");
        let body: Bytes = if wants_body {
            match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) if e.is::<http_body_util::LengthLimitError>() => {
                    return Ok(self.json(413, &serde_json::json!({ "error": "request body too large" }), false));
                }
                Err(_) => return Ok(plain(StatusCode::BAD_REQUEST, "bad request")),
            }
        } else {
            Bytes::new()
        };
        let t = self.team.clone();
        let answer = tokio::task::spawn_blocking(move || {
            let call = team::routes::Call { method: &method, parts: &parts, scope, from_run, body: &body };
            team::routes::answer(&t, &call)
        })
        .await;
        Ok(match answer {
            Ok(a) => self.json(a.status, &a.value, a.success),
            Err(e) => self.json(500, &serde_json::json!({ "error": e.to_string() }), false),
        })
    }

    /// The huddle routes (R11a, `ckanban_board::huddles::routes`), after the same gate as the team routes: the Host
    /// (403), the Origin of a change (403), a JSON body type for POST, PATCH and PUT (415).
    #[allow(clippy::result_large_err)]
    pub async fn answer_huddles(&self, req: Request<Incoming>) -> Result<Response<Body>, Request<Incoming>> {
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) {
            return Err(req);
        }
        let Some(parts) = req.uri().path().strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        if !huddle_mod::routes::claims(&parts) {
            return Err(req);
        }
        let host_ok = joined(h, HOST.as_str()).is_some_and(|host| ["localhost", "127.0.0.1"].iter().any(|l| host == format!("{l}:{}", self.public_port)));
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        let origin_ok = match joined(h, ORIGIN.as_str()) {
            None => true,
            Some(o) if o.is_empty() => true,
            Some(o) => ["localhost", "127.0.0.1"].iter().any(|l| o == format!("http://{l}:{}", self.public_port)),
        };
        if !host_ok || (mutation && !origin_ok) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let wants_body = matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT);
        let ctype = joined(h, CONTENT_TYPE.as_str()).unwrap_or_default();
        if wants_body && crate::js::trim(ctype.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
            return Ok(self.json(415, &serde_json::json!({ "error": "content-type must be application/json" }), false));
        }
        let text = |n: &str| request::header_text(h, n).filter(|v| !v.is_empty());
        let (run, agent, source) = (text(RUN_HEADER), text(HUDDLE_HEADER), text(write_routes::SOURCE_HEADER));
        let method = req.method().as_str().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        let body: Bytes = if wants_body {
            match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) if e.is::<http_body_util::LengthLimitError>() => {
                    return Ok(self.json(413, &serde_json::json!({ "error": "request body too large" }), false));
                }
                Err(_) => return Ok(plain(StatusCode::BAD_REQUEST, "bad request")),
            }
        } else {
            Bytes::new()
        };
        let hs = self.huddles.clone();
        let answer = tokio::task::spawn_blocking(move || {
            let r = huddle_mod::routes::Req { method: &method, parts: &parts, query: &query, run, agent, source, body: &body };
            huddle_mod::routes::answer(&hs, &r)
        })
        .await;
        Ok(match answer {
            Ok((status, v)) => self.json(status, &v, status < 400),
            Err(e) => self.json(500, &serde_json::json!({ "error": e.to_string() }), false),
        })
    }

    /// The R12 routes (`ckanban_board::extras::routes`): learned, find-links, a ticket's usage, team usage. Bun's gate
    /// first, as for the team routes; find-links is the user's only (on the phone listener, the owner's phone that
    /// passed the gate, as Bun lets it in).
    #[allow(clippy::result_large_err)]
    pub async fn answer_extras(&self, req: Request<Incoming>, peer: SocketAddr, via: Listener, native: &Native) -> Result<Response<Body>, Request<Incoming>> {
        use ckanban_board::extras::routes as xr;
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) {
            return Err(req);
        }
        let Some(parts) = req.uri().path().strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        let method = req.method().as_str().to_string();
        if !xr::claims(&method, &parts) {
            return Err(req);
        }
        let host_ok = joined(h, HOST.as_str()).is_some_and(|host| ["localhost", "127.0.0.1"].iter().any(|l| host == format!("{l}:{}", self.public_port)));
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        let origin_ok = match joined(h, ORIGIN.as_str()) {
            None => true,
            Some(o) if o.is_empty() => true,
            Some(o) => ["localhost", "127.0.0.1"].iter().any(|l| o == format!("http://{l}:{}", self.public_port)),
        };
        if !host_ok || (mutation && !origin_ok) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT) {
            let ctype = joined(h, CONTENT_TYPE.as_str()).unwrap_or_default();
            if crate::js::trim(ctype.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
                return Ok(self.json(415, &json!({ "error": "content-type must be application/json" }), false));
            }
        }
        let has = |n: &str| request::has(h, n);
        let from_run = has(RUN_HEADER) || has(HUDDLE_HEADER);
        let count_only = query_param(req.uri().query().unwrap_or(""), "count").as_deref() == Some("1");
        let headers = h.clone();
        let user = move || -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> {
            let headers = headers.clone();
            Box::pin(async move {
                if via == Listener::Remote { crate::guard::headers_allow(&headers) } else { crate::guard::user_only(&headers, peer.port()).await }
            })
        };
        // Only a ticket's Usage tab reads the plan's numbers (cached; the first ask may go out to Anthropic).
        let plan_value = if parts.get(2).map(String::as_str) == Some("tickets") { native.plan_usage().await } else { Value::Null };
        let plan = move || -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
            let v = plan_value.clone();
            Box::pin(async move { v })
        };
        let call = xr::Call { method: &method, parts: &parts, count_only, from_run, user: &user, plan: &plan };
        let a = xr::answer(&self.extras, &call).await;
        Ok(self.json(a.status, &a.value, a.status < 400))
    }

    /// The schedules, one-time jobs and automations routes and `POST /api/automation-call` (R10,
    /// `ckanban_board::schedules::routes`). Bun's gate first, as for the team routes; a Telegram front desk request
    /// goes through the satellite's front desk gate first (as the own routes do).
    #[allow(clippy::result_large_err)]
    pub async fn answer_schedules(&self, req: Request<Incoming>, peer: SocketAddr, via: Listener) -> Result<Response<Body>, Request<Incoming>> {
        use ckanban_board::schedules::routes as sr;
        let h = req.headers();
        let Some(parts) = req.uri().path().strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        if !sr::claims(&parts) {
            return Err(req);
        }
        // These routes are the board owner's alone: an upgrade request on them never goes on to the satellite.
        if wants_upgrade(h) {
            return Ok(self.json(400, &json!({ "error": "not a WebSocket route" }), false));
        }
        let host_ok = joined(h, HOST.as_str()).is_some_and(|host| ["localhost", "127.0.0.1"].iter().any(|l| host == format!("{l}:{}", self.public_port)));
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        let origin_ok = match joined(h, ORIGIN.as_str()) {
            None => true,
            Some(o) if o.is_empty() => true,
            Some(o) => ["localhost", "127.0.0.1"].iter().any(|l| o == format!("http://{l}:{}", self.public_port)),
        };
        if !host_ok || (mutation && !origin_ok) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let method = req.method().as_str().to_string();
        let desk = request::header_text(h, FRONT_DESK_HEADER);
        let (run, huddle) = (request::header_text(h, RUN_HEADER).filter(|v| !v.is_empty()), request::has(h, HUDDLE_HEADER));
        if desk.is_some() && (run.is_some() || huddle) {
            return Ok(self.error(StatusCode::FORBIDDEN, "a board run can't also be the front desk"));
        }
        if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT) {
            let ctype = joined(h, CONTENT_TYPE.as_str()).unwrap_or_default();
            if crate::js::trim(ctype.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
                return Ok(self.json(415, &json!({ "error": "content-type must be application/json" }), false));
            }
        }
        let quick_chat = request::has(h, "x-ckanban-quick-chat");
        let origin = request::has(h, "origin");
        let headers = h.clone();
        let query = req.uri().query().unwrap_or("").to_string();
        let body: Bytes = if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT | Method::DELETE) {
            match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) if e.is::<http_body_util::LengthLimitError>() => return Ok(self.json(413, &json!({ "error": "request body too large" }), false)),
                Err(_) => return Ok(plain(StatusCode::BAD_REQUEST, "bad request")),
            }
        } else {
            Bytes::new()
        };
        if let Some(desk) = desk {
            let b = js::parse(&String::from_utf8_lossy(&body)).unwrap_or(Value::Null);
            let path = format!("/api/{}", parts.join("/"));
            let ask = json!({ "desk": desk, "method": method, "path": path, "body": b });
            match self.core.services.satellite.frontdesk_gate(ask).await {
                Ok(Some(held)) => {
                    let status = held.get("status").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::OK);
                    return Ok(self.json_at(status, held.get("body").unwrap_or(&Value::Null)));
                }
                Ok(None) => {}
                Err(e) => return Ok(self.error(StatusCode::INTERNAL_SERVER_ERROR, &e)),
            }
        }
        // `userOnly` and `isOutsideBoard` look at the caller (the phone that passed its gate is the user).
        let (port, phone) = (peer.port(), via == Listener::Remote);
        let (uh, oh) = (headers.clone(), headers);
        let user = move |what: &str| -> Result<(), (u16, String)> {
            let allowed = if phone { crate::guard::headers_allow(&uh) } else { ckanban_board::tickets::writer::block(crate::guard::user_only(&uh, port)) };
            if allowed { Ok(()) } else { Err((403, crate::guard::refusal(what))) }
        };
        let outside = move || !phone && !request::has(&oh, "origin") && ckanban_board::tickets::writer::block(crate::guard::outside_board(port, std::process::id()));
        let (s, writes) = (self.schedules.clone(), self.writes.clone());
        let answer = tokio::task::spawn_blocking(move || {
            let view = |slug: &str, id: &str| writes.view_now_pub(slug, id);
            let r = sr::Req { method: &method, parts: &parts, query: &query, run, huddle, quick_chat, confirmed: false, phone, origin, body: &body, user: &user, outside: &outside, view: &view };
            sr::answer(&s, &r)
        })
        .await;
        Ok(match answer {
            Ok(Some((status, Some(v)))) => self.json(status, &v, status < 400),
            Ok(Some((status, None))) => {
                let mut r = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
                *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::NO_CONTENT);
                r
            }
            Ok(None) => plain(StatusCode::NOT_FOUND, "not found"),
            Err(e) => self.json(500, &json!({ "error": e.to_string() }), false),
        })
    }

    /// The helper's routes (P1a): `/api/messages...`, `/api/helper...`, a ticket's `POST .../notify`, after Bun's Host,
    /// Origin, JSON type and front desk checks (as the schedules routes). Err gives the request back.
    pub async fn answer_helper(&self, req: Request<Incoming>, peer: SocketAddr, via: Listener) -> Result<Response<Body>, Request<Incoming>> {
        use ckanban_board::helper::routes as hr;
        let Some(parts) = req.uri().path().strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        if !hr::claims(&parts) {
            return Err(req);
        }
        let h = req.headers();
        if wants_upgrade(h) {
            return Ok(self.json(400, &json!({ "error": "not a WebSocket route" }), false));
        }
        let host_ok = joined(h, HOST.as_str()).is_some_and(|host| ["localhost", "127.0.0.1"].iter().any(|l| host == format!("{l}:{}", self.public_port)));
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        let origin_ok = match joined(h, ORIGIN.as_str()) {
            None => true,
            Some(o) if o.is_empty() => true,
            Some(o) => ["localhost", "127.0.0.1"].iter().any(|l| o == format!("http://{l}:{}", self.public_port)),
        };
        if !host_ok || (mutation && !origin_ok) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let method = req.method().as_str().to_string();
        let desk = request::header_text(h, FRONT_DESK_HEADER);
        let (run, huddle) = (request::header_text(h, RUN_HEADER).filter(|v| !v.is_empty()), request::has(h, HUDDLE_HEADER));
        if desk.is_some() && (run.is_some() || huddle) {
            return Ok(self.error(StatusCode::FORBIDDEN, "a board run can't also be the front desk"));
        }
        if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT) {
            let ctype = joined(h, CONTENT_TYPE.as_str()).unwrap_or_default();
            if crate::js::trim(ctype.split(';').next().unwrap_or("")).to_lowercase() != "application/json" {
                return Ok(self.json(415, &json!({ "error": "content-type must be application/json" }), false));
            }
        }
        let headers = h.clone();
        let query = req.uri().query().unwrap_or("").to_string();
        let body: Bytes = if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT | Method::DELETE) {
            match Limited::new(req.into_body(), MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) if e.is::<http_body_util::LengthLimitError>() => return Ok(self.json(413, &json!({ "error": "request body too large" }), false)),
                Err(_) => return Ok(plain(StatusCode::BAD_REQUEST, "bad request")),
            }
        } else {
            Bytes::new()
        };
        if let Some(desk) = desk {
            let b = js::parse(&String::from_utf8_lossy(&body)).unwrap_or(Value::Null);
            let ask = json!({ "desk": desk, "method": method, "path": format!("/api/{}", parts.join("/")), "body": b });
            match self.core.services.satellite.frontdesk_gate(ask).await {
                Ok(Some(held)) => {
                    let status = held.get("status").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::OK);
                    return Ok(self.json_at(status, held.get("body").unwrap_or(&Value::Null)));
                }
                Ok(None) => {}
                Err(e) => return Ok(self.error(StatusCode::INTERNAL_SERVER_ERROR, &e)),
            }
        }
        let (port, phone) = (peer.port(), via == Listener::Remote);
        let user: hr::UserCheck = Arc::new(move |what: String| {
            let headers = headers.clone();
            Box::pin(async move {
                let allowed = if phone { crate::guard::headers_allow(&headers) } else { crate::guard::user_only(&headers, port).await };
                if allowed { Ok(()) } else { Err((403, crate::guard::refusal(&what))) }
            })
        });
        let r = hr::Req { method, parts, query, run, huddle, body: body.to_vec(), user };
        Ok(match hr::answer(&self.helper, &r).await {
            Some(Ok(v)) => self.json(200, &v, true),
            Some(Err((status, e))) => self.json(status, &json!({ "error": e }), false),
            None => plain(StatusCode::NOT_FOUND, "not found"),
        })
    }

    /// A JSON answer as Bun writes it (`JSON.stringify`); a success is masked with the saved keys (`ctx.json`).
    fn json(&self, status: u16, v: &serde_json::Value, success: bool) -> Response<Body> {
        let text = ckanban_core::datafile::to_text(v, ckanban_core::datafile::Layout::Compact);
        let text = if success { mask::mask_saved_json(&passes::current_secrets(&self.root), &text) } else { text };
        let mut r = Response::new(Full::new(Bytes::from(text)).map_err(|never| match never {}).boxed());
        *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        r.headers_mut().insert(CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
        r
    }

    /// The routes the Rust board answers that need the request itself (its body, an upgrade, the caller): the
    /// browsers, devices and terminal routes (R9). Err gives the request back: it goes on (Rust's other routes, then
    /// Bun).
    #[allow(clippy::result_large_err)]
    pub async fn answer_request(&self, req: Request<Incoming>, peer: std::net::SocketAddr, via: Listener) -> Result<Response<Body>, Request<Incoming>> {
        if browsers::routes::owns(req.method(), req.uri().path(), req.headers()) {
            let ctx = if via == Listener::Remote { &self.phone_routes } else { &self.browser_routes };
            return Ok(self.browsers.answer(req, peer.port(), ctx).await);
        }
        if write_routes::wanted(req.method().as_str(), req.uri().path()) {
            return self.answer_write(req, peer, via).await;
        }
        Err(req)
    }

    /// The ticket and board writes (R2a). Bun's gate first (Host, the Origin of a change, a JSON body for POST, PATCH
    /// and PUT except uploads), then the route on the blocking pool; the answer masked like every JSON answer.
    #[allow(clippy::result_large_err)]
    async fn answer_write(&self, req: Request<Incoming>, peer: std::net::SocketAddr, via: Listener) -> Result<Response<Body>, Request<Incoming>> {
        use http_body_util::{BodyExt, Limited};
        use hyper::header::{CONTENT_TYPE, ORIGIN};
        let h = req.headers();
        if h.contains_key(FRONT_DESK_HEADER) || wants_upgrade(h) || [HOST, ORIGIN, CONTENT_TYPE].iter().any(|n| h.get_all(n).iter().count() > 1) {
            return Err(req);
        }
        let mutation = req.method() != Method::GET && req.method() != Method::HEAD;
        if !local_host(h, self.public_port) || (mutation && !crate::routes::local_origin(h, self.public_port)) {
            return Ok(plain(StatusCode::FORBIDDEN, "forbidden"));
        }
        let path = req.uri().path().to_string();
        let upload = req.method() == Method::POST && path == "/api/attachments";
        if matches!(*req.method(), Method::POST | Method::PATCH | Method::PUT) && !upload && !crate::routes::json_type(h) {
            return Ok(passes::json_answer(StatusCode::UNSUPPORTED_MEDIA_TYPE, &serde_json::json!({ "error": "content-type must be application/json" }), &passes::current_secrets(&self.root)));
        }
        let header = |n: &str| h.get(n).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).filter(|v| !v.is_empty());
        let content_type = header("content-type").map(|t| t.split(';').next().unwrap_or("").trim().to_lowercase()).unwrap_or_default();
        let file_name = header("x-file-name").and_then(|n| ckanban_board::tickets::files::decode_uri_component(&n));
        let (run, huddle, source) = (header(RUN_HEADER), header(HUDDLE_HEADER).is_some(), header(write_routes::SOURCE_HEADER));
        let headers = h.clone();
        let method = req.method().as_str().to_string();
        let query = req.uri().query().unwrap_or("").to_string();
        // Uploads may be 25 MB; anything bigger is refused by the route (413) without reading it all.
        let limit = if upload { ckanban_board::tickets::files::MAX_ATTACHMENT_BYTES + 1 } else { 16 << 20 };
        let body = match Limited::new(req.into_body(), limit).collect().await {
            Ok(b) => b.to_bytes().to_vec(),
            Err(_) if upload => vec![0; limit],
            Err(_) => return Ok(passes::json_answer(StatusCode::PAYLOAD_TOO_LARGE, &serde_json::json!({ "error": "request body too large" }), &passes::current_secrets(&self.root))),
        };
        let port = peer.port();
        // The owner's phone (its gate passed on the phone listener) is the user after the header checks, as Bun's
        // `userOnly` lets `listener === "remote"` in.
        let user: Arc<dyn Fn() -> bool + Send + Sync> = match via {
            Listener::Remote => Arc::new(move || crate::guard::headers_allow(&headers)),
            Listener::Local => Arc::new(move || ckanban_board::tickets::writer::block(crate::guard::user_only(&headers, port))),
        };
        let r = write_routes::Req { method, path, query, run, huddle, source, content_type, file_name, body, user };
        let writes = self.writes.clone();
        let reply = match tokio::task::spawn_blocking(move || writes.answer(&r)).await {
            Ok(Some(reply)) => reply,
            Ok(None) => return Ok(plain(StatusCode::NOT_FOUND, "not found")),
            Err(e) => {
                eprintln!("ckanban-rs: a write route failed: {e}");
                Reply::Json(500, serde_json::json!({ "error": "internal error" }))
            }
        };
        Ok(match reply {
            Reply::Json(status, v) => {
                let text = (self.hooks.mask)(&serde_json::to_string(&v).unwrap_or_else(|_| "null".into()));
                json_text(status, text)
            }
            Reply::Empty(status) => {
                use http_body_util::Full;
                let mut r = Response::new(Full::new(bytes::Bytes::new()).map_err(|never| match never {}).boxed());
                *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::NO_CONTENT);
                r
            }
            Reply::File(file, headers) => match tokio::fs::read(&file).await {
                Ok(bytes) => {
                    use http_body_util::Full;
                    let mut r = Response::new(Full::new(bytes::Bytes::from(bytes)).map_err(|never| match never {}).boxed());
                    for (k, v) in headers {
                        if let (Ok(k), Ok(v)) = (hyper::header::HeaderName::from_bytes(k.as_bytes()), hyper::header::HeaderValue::from_str(&v)) {
                            r.headers_mut().insert(k, v);
                        }
                    }
                    r
                }
                Err(_) => json_text(404, r#"{"error":"attachment not found"}"#.into()),
            },
        })
    }

    /// The routes the Rust board answers that need a request's body or slow work (R6's files, outputs and Changes
    /// routes): the answer, or the request for the next routes (as it came) or for Bun (its body already read).
    pub async fn answer_async(&self, req: Request<Incoming>) -> Result<Response<Body>, Next> {
        self.git.answer(req).await
    }

    fn secrets(&self) -> Vec<String> {
        passes::current_secrets(&self.root)
    }

    fn json_at(&self, status: StatusCode, v: &Value) -> Response<Body> {
        passes::json_answer(status, v, &self.secrets())
    }

    fn error(&self, status: StatusCode, msg: &str) -> Response<Body> {
        self.json_at(status, &json!({ "error": msg }))
    }

    /// Every request in board mode, from this Mac's listener (`via` Local) or the phone access listener (Remote).
    pub async fn handle(self: &Arc<Self>, req: Request<Incoming>, peer: SocketAddr, via: Listener, native: &Native, proxy: &Proxy) -> Response<Body> {
        let mut res = self.route(req, peer, via, native, proxy).await;
        if via == Listener::Remote {
            res.headers_mut().insert(LISTENER_HEADER, HeaderValue::from_static("remote"));
        }
        res
    }

    async fn route(self: &Arc<Self>, req: Request<Incoming>, peer: SocketAddr, via: Listener, native: &Native, proxy: &Proxy) -> Response<Body> {
        // 1. The satellite's calls (only on this Mac's listener, only with this start's secret).
        if via == Listener::Local
            && let Some(name) = req.uri().path().strip_prefix(edge::INTERNAL_PREFIX)
            && req.method() == Method::POST
            && req.headers().get(SATELLITE_HEADER).is_some_and(|v| edge::secret_matches(v.as_bytes(), &self.secret))
        {
            let name = name.to_string();
            return self.internal(&name, req).await;
        }
        // 2. The gate.
        let remote = self.remote.active();
        let seen = Seen::of(req.method().as_str(), req.headers());
        if let Some(why) = request::refusal(&seen, self.public_port, remote.as_ref(), via) {
            return refused(why);
        }
        // A WebSocket upgrade (a GET, so no Origin check above) also needs the board's own page as its Origin
        // (`isAllowedSocket`); on this Mac the route checks it, on the phone it must be checked before `as_local`
        // gives the request this Mac's Origin.
        if via == Listener::Remote && wants_upgrade(req.headers()) && !request::socket_allowed(&seen, self.public_port, remote.as_ref(), via) {
            return refused(request::FORBIDDEN);
        }
        if via == Listener::Remote {
            self.note_visit();
        }
        // 2b. The Telegram front desk (P1c): its gate before any route, as in Bun's `api()`.
        if let Some(desk) = request::header_text(req.headers(), FRONT_DESK_HEADER) {
            return self.desk_request(desk, req, via).await;
        }
        if req.uri().path() == "/api/telegram/front-desk/file" && self.tg().is_some() {
            return self.error(StatusCode::FORBIDDEN, "send_file only works in the Telegram front desk's chat");
        }
        // 3. Own routes.
        if !wants_upgrade(req.headers())
            && let Some(own) = own_route(req.method(), req.uri().path())
        {
            return self.own(own, req.map(|b| b.boxed()), via).await;
        }
        // 3b. The outside services (P2), on both listeners: the phone is the user after its gate, as in Bun.
        let req = match self.answer_outside(req, peer, via).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        // 4. The other tasks' routes. They check this Mac's Host and Origin themselves; a phone request that passed
        // the gate above is shown to them with this Mac's Host and Origin, and given back as it came. Their
        // user-only checks look at the caller, which for the phone is `tailscale serve`: they refuse the phone
        // (stricter than Bun, which lets the owner's phone in).
        let mut req = req;
        let sent = (via == Listener::Remote).then(|| as_local(req.headers_mut(), self.public_port));
        if let Some(res) = self.answer(&req).await {
            return res;
        }
        if let Some(res) = self.answer_sessions(&req).await {
            return res;
        }
        let req = match self.answer_helper(req, peer, via).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_chats(req, peer.port(), via).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_request(req, peer, via).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_team(req).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_huddles(req).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_schedules(req, peer, via).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_extras(req, peer, via, native).await {
            Ok(res) => return res,
            Err(r) => r,
        };
        let req = match self.answer_async(req).await {
            Ok(res) => return res,
            Err(Next::Untouched(r)) => r,
            // Its body already read: straight to Bun.
            Err(Next::Bun(r)) => return to_bun(r, peer, sent, proxy).await,
        };
        // P1c: Telegram pairing, and the satellite's notification settings with Telegram's live state.
        if self.tg().is_none() && tg::pair_claims(req.method(), req.uri().path()) {
            return self.error(StatusCode::SERVICE_UNAVAILABLE, "Telegram is still starting; try again in a moment");
        }
        if self.tg().is_some() && tg::notify_claims(req.method(), req.uri().path()) {
            return self.notify_route(req.map(|b| b.boxed()), peer, via, sent, proxy).await;
        }
        // 5. Bun (and the front's native routes on this Mac).
        match sent {
            Some(_) => to_bun(req.map(|b| b.boxed()), peer, sent, proxy).await,
            None => match native.answer(req, peer).await {
                Ok(res) => res,
                Err(req) => proxy.forward(req, peer).await,
            },
        }
    }

    /// The outside services (P2), once the server knows how the Bun child runs (`bun`, `repo`): the helper command for
    /// publishing, `ckanban mcp`'s command line for the agents, and `notify` (Bun hears of the passes file changing).
    pub fn connect_outside(self: &Arc<Self>, bun: &Path, repo: &Path, notify: passes::Notify) {
        use crate::outside::{self, routes::Outside};
        let cli = repo.join("src").join("cli.ts");
        let _ = self.publish_run.set(outside::edge::publish_run(bun.to_path_buf(), cli));
        let bus = self.core.bus.clone();
        let emit: outside::Emit = Arc::new(move |v: Value| bus.emit_json(v));
        let home = ckanban_core::home::home_dir();
        let claude_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.clone());
        let claude_config = claude_dir.join(".claude.json");
        let mcp = outside::mcp::Mcp::new(outside::mcp::McpOptions::new(&self.root), emit.clone());
        let signin = outside::signin::SignIn::new(
            self.root.clone(),
            format!("http://localhost:{}/api/passes/oauth/callback", self.public_port),
            notify,
            home.clone(),
            claude_config.clone(),
        );
        let phone = outside::phone::Phone::new(self.root.clone(), self.remote_port);
        let agents = crate::agents::Agents::new(bun, repo).map(|a| outside::agents_admin::AgentsAdmin::new(Arc::new(a)));
        let bun_version = std::process::Command::new(bun).arg("--version").output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        let bugs = outside::bugreport::BugReports::new(self.root.clone(), bun_version);
        let _ = self.outside_sat.signin.set(signin.clone());
        let o = Arc::new(Outside { mcp: mcp.clone(), signin, phone: phone.clone(), agents, bugs });
        if self.outside.set(o).is_ok() {
            mcp.start();
            phone.watch();
            // The satellite's helper offers a check-in only when some MCP server works (`checkinOffer`).
            self.mirror_mcp(mcp);
        }
    }

    /// Tells the satellite whether any MCP server is connected, at start and when that changes.
    fn mirror_mcp(&self, mcp: Arc<crate::outside::mcp::Mcp>) {
        let Some(tell) = self.tell.get().cloned() else { return };
        let mut rx = self.core.bus.subscribe();
        tokio::spawn(async move {
            let mut last: Option<bool> = None;
            loop {
                let now = mcp.any_connected();
                if last != Some(now) {
                    last = Some(now);
                    if tell.send(satellite::runtime_line(&json!({ "mcpConnected": now }))).is_err() {
                        return;
                    }
                }
                loop {
                    match rx.recv().await {
                        Ok(e) if e.ty == "mcp.updated" => break,
                        Ok(_) => {}
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => break,
                        Err(_) => return,
                    }
                }
            }
        });
    }

    /// The outside services' routes (P2, `crate::outside`): after the request gate, the Telegram front desk's gate and
    /// the JSON-only rule, as Bun's `api()` runs them before its routes. Err gives the request back.
    #[allow(clippy::result_large_err)]
    async fn answer_outside(&self, req: Request<Incoming>, peer: SocketAddr, via: Listener) -> Result<Response<Body>, Request<Incoming>> {
        use crate::outside::{Answer, Call, routes};
        let Some(outside) = self.outside.get() else { return Err(req) };
        if wants_upgrade(req.headers()) {
            return Err(req);
        }
        let Some(parts) = req.uri().path().strip_prefix("/api/").and_then(api_parts) else { return Err(req) };
        let method = req.method().as_str().to_string();
        if !routes::claims(&method, &parts, outside.agents.is_some()) {
            return Err(req);
        }
        let (head, body) = req.into_parts();
        let h = &head.headers;
        let bytes = if head.method != Method::GET && head.method != Method::HEAD {
            match Limited::new(body, MAX_BODY).collect().await {
                Ok(b) => b.to_bytes(),
                Err(e) if e.is::<http_body_util::LengthLimitError>() => return Ok(self.error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large")),
                Err(_) => return Ok(plain(StatusCode::BAD_REQUEST, "bad request")),
            }
        } else {
            Bytes::new()
        };
        if let Some(desk) = request::header_text(h, FRONT_DESK_HEADER) {
            if request::has(h, RUN_HEADER) || request::has(h, HUDDLE_HEADER) {
                return Ok(self.error(StatusCode::FORBIDDEN, "a board run can't also be the front desk"));
            }
            let b = if bytes.is_empty() { Value::Null } else { js::parse(&String::from_utf8_lossy(&bytes)).unwrap_or(Value::Null) };
            let ask = json!({ "desk": desk, "method": method, "path": head.uri.path(), "body": b });
            match self.core.services.satellite.frontdesk_gate(ask).await {
                Ok(Some(held)) => {
                    let status = held.get("status").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::OK);
                    return Ok(self.json_at(status, held.get("body").unwrap_or(&Value::Null)));
                }
                Ok(None) => {}
                Err(e) => return Ok(self.error(StatusCode::INTERNAL_SERVER_ERROR, &e)),
            }
        }
        let ctype = request::header_text(h, CONTENT_TYPE.as_str());
        if request::needs_json(&method) && !request::json_type(ctype.as_deref()) {
            return Ok(self.error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json"));
        }
        // `userOnly`: the phone that passed its gate is the user after the header checks; on this Mac, the user's own
        // browser. Asked only where a route may need it (the check runs lsof).
        let is_user = if routes::may_ask_user(&method, &parts) {
            match via {
                Listener::Remote => crate::guard::headers_allow(h),
                Listener::Local => crate::guard::user_only(h, peer.port()).await,
            }
        } else {
            false
        };
        let user = move |what: &str| -> Result<(), Answer> { if is_user { Ok(()) } else { Err(Answer::error(403, crate::guard::refusal(what))) } };
        let query = head.uri.query().unwrap_or("").to_string();
        let call = Call {
            method: &method,
            parts: &parts,
            query: &query,
            body: &bytes,
            local: via == Listener::Local,
            from_run: request::header_text(h, RUN_HEADER).is_some_and(|v| !v.is_empty()),
            user: &user,
        };
        Ok(match outside.answer(&call).await {
            Some(Answer::Json(status, v)) => self.json_at(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), &v),
            Some(Answer::Html(status, page)) => {
                let mut r = Response::new(Full::new(Bytes::from(page)).map_err(|never| match never {}).boxed());
                *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
                r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
                r.headers_mut().insert(hyper::header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                r
            }
            Some(Answer::Empty(status)) => {
                let mut r = Response::new(Full::new(Bytes::new()).map_err(|never| match never {}).boxed());
                *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::NO_CONTENT);
                r
            }
            None => self.error(StatusCode::NOT_FOUND, "not found"),
        })
    }

    /// Phone access saw a visit (`noteVisit`): Bun keeps the time for `GET /api/remote`; requests it answers note
    /// it themselves.
    fn note_visit(&self) {
        if let Some(o) = self.outside.get() {
            o.phone.note_visit(iso(now_ms()));
        }
        if let Some(t) = self.tell.get() {
            let _ = t.send(format!("remote-visit {}\n", iso(now_ms())));
        }
    }

    /// An own route after the gate: the front desk's gate and the JSON-only rule first, as Bun's `api()` does.
    async fn own(self: &Arc<Self>, own: Own, req: Request<Body>, via: Listener) -> Response<Body> {
        let (parts, body) = req.into_parts();
        let h = &parts.headers;
        if let Some(desk) = request::header_text(h, FRONT_DESK_HEADER) {
            if request::has(h, RUN_HEADER) || request::has(h, HUDDLE_HEADER) {
                return self.error(StatusCode::FORBIDDEN, "a board run can't also be the front desk");
            }
            let mut b = Value::Null;
            if parts.method != Method::GET && parts.method != Method::HEAD {
                match read_body(body).await {
                    Ok(bytes) => b = js::parse(&String::from_utf8_lossy(&bytes)).unwrap_or(Value::Null),
                    Err(e) => return self.error(StatusCode::BAD_REQUEST, &e),
                }
            }
            let ask = json!({ "desk": desk, "method": parts.method.as_str(), "path": parts.uri.path(), "body": b });
            match self.core.services.satellite.frontdesk_gate(ask).await {
                Ok(Some(held)) => {
                    let status = held.get("status").and_then(Value::as_u64).and_then(|s| StatusCode::from_u16(s as u16).ok()).unwrap_or(StatusCode::OK);
                    return self.json_at(status, held.get("body").unwrap_or(&Value::Null));
                }
                Ok(None) => {}
                Err(e) => return self.error(StatusCode::INTERNAL_SERVER_ERROR, &e),
            }
        }
        let ctype = request::header_text(h, CONTENT_TYPE.as_str());
        if request::needs_json(parts.method.as_str()) && !request::json_type(ctype.as_deref()) {
            return self.error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "content-type must be application/json");
        }
        let query = parts.uri.query();
        match own {
            Own::Events => events::stream(&self.core.bus, self.hooks.clone(), events::PING_EVERY),
            Own::Health => self.json_at(StatusCode::OK, &system::health().await),
            Own::Version => self.json_at(StatusCode::OK, &self.updates.status().await),
            Own::CronPreview => {
                let expr = query_value(query, "expr");
                let v = tokio::task::spawn_blocking(move || cron::preview(expr.as_deref())).await.unwrap_or(Value::Null);
                self.json_at(StatusCode::OK, &v)
            }
            Own::ClaudeProjects => {
                let root = self.root.clone();
                let v = tokio::task::spawn_blocking(move || system::claude_projects(&root)).await.unwrap_or(Value::Array(vec![]));
                self.json_at(StatusCode::OK, &v)
            }
            Own::ClaudeDefaults => self.json_at(StatusCode::OK, &system::claude_defaults(&self.versions)),
            Own::PickFolder => self.json_at(StatusCode::OK, &system::pick_folder().await),
            Own::Awake => self.json_at(StatusCode::OK, &json!({ "held": self.awake.held() })),
            Own::Restart if parts.method == Method::GET => self.json_at(StatusCode::OK, &self.runs.restart_state()),
            Own::Restart => {
                let exit = self.exit.clone();
                let (running, pending) = self.runs.request_restart(Arc::new(move || exit.notify_one()), ckanban_board::runloop::rules::RESTART_MAX_WAIT_MS);
                self.json_at(StatusCode::OK, &json!({ "running": running, "alreadyPending": pending }))
            }
            Own::Profile => {
                let host = request::header_text(h, "host");
                let port = if via == Listener::Remote { 0 } else { self.remote_port };
                if via == Listener::Remote || !request::profile_allowed(request::has(h, RUN_HEADER), host.as_deref(), port) {
                    return self.error(StatusCode::FORBIDDEN, "profiles are taken from this Mac only");
                }
                match system::profile(query_value(query, "seconds").as_deref(), &self.root).await {
                    Ok(v) => self.json_at(StatusCode::OK, &v),
                    Err(e) => self.error(StatusCode::INTERNAL_SERVER_ERROR, &e),
                }
            }
        }
    }

    /// `/api/internal/<name>` from the satellite (the edge header checked).
    async fn internal(self: &Arc<Self>, name: &str, req: Request<Incoming>) -> Response<Body> {
        let b = match read_body(req.into_body().boxed()).await {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null),
            Err(e) => return self.error(StatusCode::BAD_REQUEST, &e),
        };
        if let Some((status, v)) = self.helper.internal(name, &b).await {
            return self.json_at(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), &v);
        }
        match edge::inbound(&*self.actions, name, &b).await {
            Some((status, v)) => {
                if !status.is_success() {
                    eprintln!("ckanban-rs: the satellite's {name}: {}", v.get("error").and_then(Value::as_str).unwrap_or(""));
                }
                self.json_at(status, &v)
            }
            None => self.error(StatusCode::NOT_FOUND, "not found"),
        }
    }

    /// A held front desk request after the user's Confirm, run as the user (Bun's `replay`: no gate, no front desk
    /// header): an own route here, else Bun with the confirmed mark. The answer is `{status, body}`.
    async fn replay(self: &Arc<Self>, b: &Value, native: &Native, proxy: &Proxy) -> Response<Body> {
        let method = b.get("method").and_then(Value::as_str).unwrap_or("GET");
        let path = b.get("path").and_then(Value::as_str).unwrap_or("/");
        let body = b.get("body").filter(|v| !v.is_null());
        let Ok(m) = Method::from_bytes(method.as_bytes()) else { return self.json_at(StatusCode::OK, &json!({ "status": 400, "body": { "error": "bad method" } })) };
        if !path.starts_with('/') {
            return self.json_at(StatusCode::OK, &json!({ "status": 404, "body": { "error": "not found" } }));
        }
        let mut rb = Request::builder().method(m.clone()).uri(path).header("host", format!("127.0.0.1:{}", self.public_port));
        let bytes = match body {
            Some(v) => {
                rb = rb.header("content-type", "application/json");
                Bytes::from(serde_json::to_vec(v).unwrap_or_default())
            }
            None => Bytes::new(),
        };
        let Ok(mut req) = rb.body(full(bytes)) else { return self.json_at(StatusCode::OK, &json!({ "status": 404, "body": { "error": "not found" } })) };
        // The path Bun's `new URL` would route on, as for every other request.
        crate::proxy::normalize_target(&mut req);
        let path = req.uri().path().to_string();
        let path = path.as_str();
        let peer = SocketAddr::from(([127, 0, 0, 1], 0));
        // The board's ticket writes (R2a, and R7a's run routes inside them) run here, as the user who confirmed.
        if own_route(&m, path).is_none() && write_routes::wanted(m.as_str(), path) {
            let body = body.map(|v| serde_json::to_vec(v).unwrap_or_default()).unwrap_or_default();
            let r = write_routes::Req {
                method: m.as_str().to_string(),
                path: path.to_string(),
                query: req.uri().query().unwrap_or("").to_string(),
                run: None,
                huddle: false,
                source: None,
                content_type: "application/json".into(),
                file_name: None,
                body,
                // Bun's replayed request has no Origin, so its user-only checks refuse: a confirmed front desk
                // request never saves keys, automation cards or helper rules, here either.
                user: Arc::new(|| false),
            };
            let writes = self.writes.clone();
            let (status, data) = match tokio::task::spawn_blocking(move || writes.answer(&r)).await {
                Ok(Some(Reply::Json(status, v))) => (status, v),
                Ok(Some(Reply::Empty(status))) => (status, Value::Null),
                Ok(Some(Reply::File(..))) | Ok(None) => (404, json!({ "error": "not found" })),
                Err(e) => (500, json!({ "error": e.to_string() })),
            };
            return self.json_at(StatusCode::OK, &json!({ "status": status, "body": data }));
        }
        // Schedules, jobs and automations (R10): as the user who confirmed (a schedule's delete goes ahead; user-only
        // actions still refuse, as Bun's replay has no Origin).
        if own_route(&m, path).is_none()
            && let Some(parts) = path.strip_prefix("/api/").and_then(api_parts)
            && ckanban_board::schedules::routes::claims(&parts)
        {
            use ckanban_board::schedules::routes as sr;
            let body = body.map(|v| serde_json::to_vec(v).unwrap_or_default()).unwrap_or_default();
            let query = req.uri().query().unwrap_or("").to_string();
            let method = m.as_str().to_string();
            let (s, writes) = (self.schedules.clone(), self.writes.clone());
            let answer = tokio::task::spawn_blocking(move || {
                let view = |slug: &str, id: &str| writes.view_now_pub(slug, id);
                let user = |what: &str| -> Result<(), (u16, String)> { Err((403, crate::guard::refusal(what))) };
                let outside = || false;
                let r = sr::Req { method: &method, parts: &parts, query: &query, run: None, huddle: false, quick_chat: false, confirmed: true, phone: false, origin: false, body: &body, user: &user, outside: &outside, view: &view };
                sr::answer(&s, &r)
            })
            .await;
            let (status, data) = match answer {
                Ok(Some((status, v))) => (status, v.unwrap_or(Value::Null)),
                Ok(None) => (404, json!({ "error": "not found" })),
                Err(e) => (500, json!({ "error": e.to_string() })),
            };
            return self.json_at(StatusCode::OK, &json!({ "status": status, "body": data }));
        }
        // The outside services (P2), as the user who confirmed on this Mac: user-only actions still refuse (Bun's
        // replay has no Origin).
        if own_route(&m, path).is_none()
            && let Some(outside) = self.outside.get()
            && let Some(parts) = path.strip_prefix("/api/").and_then(api_parts)
            && crate::outside::routes::claims(m.as_str(), &parts, outside.agents.is_some())
        {
            use crate::outside::{Answer, Call};
            let bytes = body.map(|v| serde_json::to_vec(v).unwrap_or_default()).unwrap_or_default();
            let query = req.uri().query().unwrap_or("").to_string();
            let user = |what: &str| -> Result<(), Answer> { Err(Answer::error(403, crate::guard::refusal(what))) };
            let call = Call { method: m.as_str(), parts: &parts, query: &query, body: &bytes, local: true, from_run: false, user: &user };
            let (status, data) = match outside.answer(&call).await {
                Some(Answer::Json(status, v)) => (status, v),
                Some(Answer::Html(status, page)) => (status, Value::String(page)),
                Some(Answer::Empty(status)) => (status, Value::Null),
                None => (404, json!({ "error": "not found" })),
            };
            return self.json_at(StatusCode::OK, &json!({ "status": status, "body": data }));
        }
        // Everything else through this server's own order (Rust's routes, then Bun): Bun's confirmed mark only
        // ever let a schedule's delete through, which runs above.
        let _ = (native, proxy, peer);
        let res = match own_route(&m, path) {
            Some(own) => self.own(own, req, Listener::Local).await,
            None => self.send_again(req).await,
        };
        let status = res.status().as_u16();
        let text = match res.into_body().collect().await {
            Ok(c) => c.to_bytes(),
            Err(_) => Bytes::new(),
        };
        let data = serde_json::from_slice::<Value>(&text).unwrap_or(Value::Null);
        self.json_at(StatusCode::OK, &json!({ "status": status, "body": data }))
    }

    /// After the satellite answers: follow its event stream, give it the live state, and send it the board's events.
    pub async fn connect_satellite(&self, internal_port: u16, secret: &str, tell: tokio::sync::mpsc::UnboundedSender<String>) {
        if let Err(e) = satellite::follow(self.core.bus.clone(), internal_port, self.public_port, secret.to_string()).await {
            eprintln!("ckanban-rs: the satellite's event stream: {e}");
        }
        let s = &self.core.services;
        // With the summaries of every session the notifier's start-up stock-take reads (it waits for this snapshot),
        // worked out off the async threads: the index may still be loading and summaries may need a transcript read.
        let (runs, huddles, sessions, index, root) = (s.runs.clone(), s.huddles.clone(), s.sessions.clone(), self.core.index.clone(), self.root.clone());
        let snapshot = tokio::task::spawn_blocking(move || {
            let slugs = boards(&root);
            let lists: Vec<_> = slugs.iter().map(|slug| index.list(slug)).collect();
            let ids = satellite::waiting_sessions(lists.iter().flat_map(|l| l.tickets.iter().map(|t| (t.status.as_str(), t.s("sessionId")))));
            satellite::runtime_snapshot(&*runs, &*huddles, &*sessions, &slugs, &ids)
        })
        .await
        .unwrap_or_else(|_| json!({ "running": [], "hostHuddles": {}, "sessions": {} }));
        eprintln!("[board] the satellite's start snapshot: {} session summaries", snapshot["sessions"].as_object().map_or(0, |m| m.len()));
        let _ = tell.send(satellite::runtime_line(&snapshot));
        let _ = self.tell.set(tell.clone());
        {
            let mut t = self.helper_tell.lock().unwrap_or_else(|e| e.into_inner());
            for line in std::mem::take(&mut t.early) {
                let _ = tell.send(line);
            }
            t.tell = Some(tell.clone());
        }
        self.satellite_ready.send_replace(true);
        // The pass store for key cards: Bun hears of each change to the passes file on its stdin.
        let notify_tell = tell.clone();
        let notify: passes::Notify = Arc::new(move |file: &str| {
            let _ = notify_tell.send(format!("changed {file}\n"));
        });
        let _ = self.passes.set(Arc::new(passes::Passes::new(self.root.clone(), notify)));
        // A huddle changed: the helper's mirror gets that board's host states again (worked out off the bus, a
        // board at a time, several changes in a row at once).
        let (hx, mut hrx) = tokio::sync::mpsc::unbounded_channel::<String>();
        self.core.bus.on(move |e| {
            // A ticket's run starting or ending changes who works in its huddle too.
            if (e.ty == "huddle.updated" || e.ty == "huddle.message" || e.ty == "ticket.updated")
                && let Some(p) = e.body.get("profile").and_then(Value::as_str)
            {
                let _ = hx.send(p.to_string());
            }
        });
        let (huddles, htell) = (self.huddles.clone(), tell.clone());
        tokio::spawn(async move {
            // What the satellite has per board: only a board whose states changed is sent again.
            let sent: Arc<Mutex<std::collections::HashMap<String, Value>>> = Arc::default();
            while let Some(first) = hrx.recv().await {
                let mut slugs = vec![first];
                while let Ok(s) = hrx.try_recv() {
                    if !slugs.contains(&s) {
                        slugs.push(s);
                    }
                }
                let (h, sent) = (huddles.clone(), sent.clone());
                let line = tokio::task::spawn_blocking(move || {
                    let mut by = serde_json::Map::new();
                    let mut sent = sent.lock().unwrap_or_else(|e| e.into_inner());
                    for s in slugs {
                        let states = Value::Object(h.host_states(&s).iter().map(|(k, v)| (k.clone(), v.clone())).collect());
                        if sent.get(&s) != Some(&states) {
                            sent.insert(s.clone(), states.clone());
                            by.insert(s, states);
                        }
                    }
                    (!by.is_empty()).then(|| satellite::runtime_line(&json!({ "hostHuddles": by })))
                })
                .await;
                if let Ok(Some(line)) = line {
                    let _ = htell.send(line);
                }
            }
        });
        let views = s.views.clone();
        // The live state the helper reads goes first, so it applies before the event that tells of the change: the
        // tickets running now (when that changed) and a ticket's new session summary.
        let runs = s.runs.clone();
        let tickets = self.core.tickets.clone();
        let last_running = std::sync::Mutex::new(Vec::<(String, String)>::new());
        self.core.bus.on(move |e| {
            if e.origin == ckanban_board::bus::Origin::Board && e.ty == "ticket.updated" {
                let now = runs.running_tickets();
                let mut last = last_running.lock().unwrap_or_else(|p| p.into_inner());
                if *last != now {
                    let list: Vec<String> = now.iter().map(|(s, i)| format!("{s}/{i}")).collect();
                    let _ = tell.send(satellite::runtime_line(&json!({ "running": list })));
                    *last = now;
                }
            }
            if e.origin == ckanban_board::bus::Origin::Board
                && e.ty == "session.updated"
                && let (Some(p), Some(i), Some(sum)) = (e.body.get("profile").and_then(Value::as_str), e.body.get("id").and_then(Value::as_str), e.body.get("session"))
                && let Some(sid) = tickets.get(p, i).and_then(|t| t.s("sessionId").filter(|x| !x.is_empty()).map(str::to_string))
            {
                let mut m = serde_json::Map::new();
                m.insert(sid, sum.clone());
                let _ = tell.send(satellite::runtime_line(&json!({ "sessions": m })));
            }
            if let Some(line) = satellite::event_line(e, &*views) {
                let _ = tell.send(line);
            }
        });
    }

    /// Before the process ends: every run is stopped without an outcome (chat replies cut off are marked) so the next
    /// start resumes them; waits at most 6 s (Bun's `board.shutdown()`).
    pub async fn shutdown(&self) {
        // Huddle helpers mid-turn are marked for recover() too (Bun's `huddles.shutdown()`), at the same time.
        self.huddles.shutting_down.store(true, std::sync::atomic::Ordering::Relaxed);
        tokio::join!(self.runs.shutdown(), self.agents.shutdown());
    }

    /// Board mode ended with `code`: stop the core; a clean stop (0) is not counted as a crash.
    pub fn stop(&self, code: u8) {
        self.core.stop();
        mode::record_stop(&self.root, code == 0);
    }
}

/// Paths the board's read routes may answer (`ckanban_board::index::routes`); the rest of `/api/profiles/...` goes
/// on to Bun without a trip to the blocking pool.
fn is_read_route(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        ["api", "inbox", ..] | ["api", "tickets"] | ["api", "profiles"] | ["api", "profiles", _] => true,
        ["api", "profiles", _, "tickets"] | ["api", "profiles", _, "tickets", _] => true,
        _ => false,
    }
}

fn json_text(status: u16, text: String) -> Response<Body> {
    use http_body_util::{BodyExt, Full};
    let mut r = Response::new(Full::new(bytes::Bytes::from(text)).map_err(|never| match never {}).boxed());
    *r.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    r.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
    r
}

/// The boards (folders under `profiles/`): a few names, read once at start.
fn boards(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root.join("profiles"))
        .map(|d| d.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// A header as Bun's `headers.get` gives it: every value joined with ", "; None when it isn't sent.
fn joined(h: &HeaderMap, name: &str) -> Option<String> {
    let vals: Vec<String> = h.get_all(name).iter().map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect();
    (!vals.is_empty()).then(|| vals.join(", "))
}

/// The path parts after `/api/` as Bun splits them (`split("/").filter(Boolean)`, then `decodeURIComponent`); None
/// when one can't be decoded (Bun answers "malformed URL").
fn api_parts(rest: &str) -> Option<Vec<String>> {
    rest.split('/').filter(|p| !p.is_empty()).map(decode_component).collect()
}

/// `decodeURIComponent`: `%XX` bytes must make UTF-8, and a `%` must start one.
fn decode_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let (h, l) = (hex(*b.get(i + 1)?)?, hex(*b.get(i + 2)?)?);
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_parts_decode_like_bun() {
        assert_eq!(api_parts("profiles/my%20board//huddle-notes/_all/general"), Some(vec!["profiles".into(), "my board".into(), "huddle-notes".into(), "_all".into(), "general".into()]));
        assert_eq!(api_parts("profiles/a%2Fb/x"), Some(vec!["profiles".into(), "a/b".into(), "x".into()]));
        assert_eq!(api_parts("profiles/%zz"), None);
        assert_eq!(api_parts("profiles/%E2%82"), None);
        assert_eq!(api_parts("profiles/a+b"), Some(vec!["profiles".into(), "a+b".into()]));
    }

    #[test]
    fn repeated_headers_are_joined() {
        let mut h = HeaderMap::new();
        h.append(HOST, "localhost:1".parse().unwrap());
        h.append(HOST, "localhost:1".parse().unwrap());
        assert_eq!(joined(&h, "host").as_deref(), Some("localhost:1, localhost:1"));
        assert_eq!(joined(&h, "origin"), None);
    }
}
