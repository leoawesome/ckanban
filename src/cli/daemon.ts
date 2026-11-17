import { retireOldPlans } from "../board/retire-plans";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmuxLeftovers } from "../runs/artifact";
import { StayAwake } from "../runs/awake";
import { Board } from "../board/board";
import { Bus } from "../core/events";
import { createServer } from "../api/server";
import { QuickChats } from "../chat/quickchat";
import { Huddles } from "../huddle/huddle";
import { withUtf8Locale } from "../core/locale";
import { boardToolsSource, McpManager } from "../integrations/mcp";
import { startPoller } from "../runs/prpoller";
import { Notifier } from "../helper/notify";
import { ownPicks } from "../browser/chromes";
import { siteName } from "../browser/sign-in-signs";
import { HelperRunner } from "../helper/runner";
import { ticketAttention, withSnooze } from "../helper/attention";
import { PushService } from "../helper/push";
import { RemoteAccess, remoteListenPort, remoteUrl, watchServe } from "../integrations/remote";
import { Passes } from "../integrations/passes";
import { PASSES_FILE } from "../integrations/board-keys";
import { ckanbanShim } from "../integrations/script";
import { RunLogCompressor } from "../runs/run-log-compress";
import { freezeAlarm, pauser, startLagMonitor, track, trackedInterval } from "../core/lag";
import { LoopManager } from "../schedules/loops";
import { makeSideCaller } from "../runs/side-call";
import { Learner } from "../board/learner";
import { Scheduler } from "../schedules/scheduler";
import { tickMs } from "../core/env";
import { JobRunner } from "../schedules/jobs";
import { FollowUpWatcher } from "../schedules/followup";
import { LimitWatcher } from "../usage/limit";
import { startHuddleSessionWatcher } from "../huddle/huddle-session";
import { projectsDir, SessionCache, startSessionWatcher } from "../runs/session";
import { SessionFeed } from "../core/changefeed";
import { ShellManager } from "../browser/shell";
import { TerminalWatcher } from "../browser/terminals";
import { defaultRoot, Store, TICKET_RECHECK_MS } from "../core/store";
import { JSON_DIR_RECHECK_MS } from "../core/json-dir";
import { keepAwakeOn } from "../core/types";
import { VERSION } from "../core/version";
import { WEB_ASSETS } from "../api/web-assets.gen";
import { detectMissing } from "../runs/worktree-setup";
import { onFrontNotice, readFront, setFront, setNoticeLimit } from "../core/front";
import { isSatellite, RuntimeMirror, satelliteNotice } from "../core/satellite";
import { rustComment, rustHelperEdge, rustReplay, rustTelegramBoard } from "../core/satellite-edge";
import { takeBoardLock } from "../core/board-lock";
import { sweepTempFiles, trimDaemonLog } from "../core/housekeeping";

export async function startDaemon(): Promise<void> {
  // Board runs and other children inherit this; an older launchd plist starts the daemon with no locale.
  Object.assign(process.env, withUtf8Locale(process.env));
  // Satellite mode (core/satellite.ts): the Rust board owns the board and sends its events on stdin, a line each.
  const satellite = isSatellite(process.env);
  // A front that drops callers' copies of the phone and replay marks says so (rust/src/main.rs); an older one
  // doesn't, and then this daemon never trusts the marks (src/core/satellite-edge.ts).
  const edge = satellite && process.env.CKANBAN_SATELLITE_EDGE === "1";
  delete process.env.CKANBAN_SATELLITE_EDGE;
  // Runs, scripts and test daemons this one starts are never satellites themselves.
  delete process.env.CKANBAN_SATELLITE;
  if (satellite) setNoticeLimit(256 * 1024 * 1024);
  // Behind the Rust front server (core/front.ts): its secret comes on stdin, and end of stdin means it is gone.
  let frontGone: () => void = () => process.exit(0);
  let front: Awaited<ReturnType<typeof readFront>>;
  try {
    front = await readFront(process.env, Bun.stdin.stream(), () => {
      console.log("ckanban: the front server is gone; stopping");
      frontGone();
    });
  } catch (e) {
    console.error(`ckanban: ${(e as Error).message}`);
    process.exit(1);
  }
  setFront(front);
  if (satellite && !front) {
    console.error("ckanban: CKANBAN_SATELLITE=1 is only for the Rust board (ckanban-rs dev), which starts this daemon behind it");
    process.exit(1);
  }
  // One owner of the data folder's board (core/board-lock.ts); in satellite mode the Rust board holds it.
  if (!satellite) {
    try {
      await takeBoardLock(defaultRoot());
    } catch (e) {
      console.error(`ckanban: ${(e as Error).message}; not starting`);
      process.exit(1);
    }
  }
  const store = new Store(defaultRoot());
  store.readOnlyTickets = satellite;
  /** Satellite mode: the Rust board's live state, from its `runtime` lines. */
  const mirror = new RuntimeMirror();
  const config = store.config();
  /** Where this daemon listens: an internal port behind the front server, else the board's port. */
  const listenPort = Number(process.env.CKANBAN_PORT) || config.port;
  /** The board's port as callers see it; what runs, scripts and links get. */
  const port = front?.publicPort ?? listenPort;
  if (front) {
    // Children (runs, MCP tools, scripts, the CLI) reach the board through the front server.
    process.env.CKANBAN_PORT = String(port);
    delete process.env.CKANBAN_FRONT_PORT;
  }
  const bus = new Bus();
  // The front server changed a file this daemon also uses (rust/src/passes.rs): the UI hears of it as after our own writes.
  /** Satellite mode: phone access as the Rust board's phone listener sees it (it sends `remote-visit <time>`). */
  let phoneRemote: RemoteAccess | null = null;
  onFrontNotice((line) => {
    if (line === `changed ${PASSES_FILE}`) bus.emit({ type: "integration.updated" });
    else if (satellite && line.startsWith("remote-visit ")) phoneRemote?.noteVisit(line.slice("remote-visit ".length));
    // P1a: waits the Rust helper closed: their Telegram alerts say so and lose their buttons.
    else if (satellite && line.startsWith("waits-closed ")) {
      try {
        void notifier.frontDesk.closed(JSON.parse(line.slice("waits-closed ".length))).catch((e) => console.error("telegram: closed alert", e));
      } catch (e) {
        console.error(`satellite: bad waits-closed line: ${(e as Error).message}`);
      }
    }
    else if (satellite) satelliteNotice(line, bus, mirror);
  });
  // Satellite mode: session-summaries.json belongs to the Rust board; this cache only reads transcripts when asked.
  const sessions = new SessionCache({}, Date.now, satellite ? undefined : join(store.root, "session-summaries.json"));
  // One watch on Claude's projects folder: watchers look only at sessions that changed (they poll if it can't start).
  const feed = new SessionFeed(projectsDir());
  if (!satellite && !feed.start()) console.warn("session feed: can't watch Claude's projects folder; watchers poll every ticket");
  const stopFollow = satellite ? () => {} : sessions.follow(feed);
  const shells = new ShellManager();
  void cleanupTmuxLeftovers();
  const board = new Board(store, bus, {
    claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude",
    sessionSummary: (id) => sessions.summary(id),
    findOwnedSession: (id) => shells.findSession(id),
    notify: (title, body, slug, id) => notifier.macOnly(title, body, notifier.link(slug, id)),
    // A ticket that got a message from Telegram sends its reply back there.
    turnEnded: (slug, id, text) => void notifier.turnEnded(slug, id, text).catch((e) => console.error("telegram: report back", e)),
  });
  // Links in notifications open the ticket on the phone when phone access is on (remote.json), else on this Mac.
  const remoteConfig = new RemoteAccess(store.root, () => 0);
  const push = new PushService(store.root);
  // Satellite mode: the Rust board runs the helper and owns its files (P1a); Telegram's taps and settings writes go there.
  let notifierRef: Notifier | null = null;
  const helperEdge = satellite && front ? rustHelperEdge(front, (s) => notifierRef?.settingsWritten(s)) : undefined;
  const notifier: Notifier = new Notifier(store, bus, {
    root: store.root, push,
    ...(satellite ? {
      sessionSummary: (id: string) => mirror.sessionSummary(id), sessionsReady: () => mirror.ready,
      isRunning: (slug: string, id: string) => mirror.isRunning(slug, id), hostHuddles: (slug: string) => mirror.hostHuddles(slug),
    } : {
      sessionSummary: (id: string) => sessions.summary(id), sessionsReady: () => sessions.settled(),
      isRunning: (slug: string, id: string) => board.isRunning(slug, id), hostHuddles: (slug: string) => board.hostHuddles(slug),
    }),
    baseUrl: () => {
      const r = remoteConfig.active();
      return r ? remoteUrl(r.host) : `http://localhost:${port}`;
    },
    // Satellite mode: the notifier's comments are written by the Rust board (core/satellite-edge.ts).
    ...(satellite && front ? { addComment: rustComment(front) } : {}),
    ...(helperEdge ? { helperEdge } : {}),
  });
  notifierRef = notifier;
  notifier.plugBoard(satellite && front ? rustTelegramBoard(front) : board);
  // A board browser seen logged out (its sign-in check): tell the user at once, naming the boards that use it.
  board.boardBrowsers.onLoggedOut = (b, site) => {
    const using = store.listProfiles().filter((p) => (ownPicks(p) ?? []).some((x) => x.kind === "board" && x.id === b.id));
    void notifier.browserLoggedOut(b.name, siteName(site), using[0]?.slug ?? null, using.map((p) => p.name || p.slug))
      .then((err) => console.log(`[browsers] ${b.name} (${b.id}): logged-out alert sent${err ? " (one channel failed; see Settings, Notifications)" : ""}`))
      .catch((e) => console.error(`[browsers] ${b.id}: logged-out alert`, e));
  };
  const webDir = join(import.meta.dir, "..", "..", "web", "dist");
  const embedded = Object.keys(WEB_ASSETS).length > 0;
  if (!embedded && !existsSync(join(webDir, "index.html"))) console.warn("web UI not built yet: run `bun run build:web`");
  const terminals = new TerminalWatcher(store, bus, sessions, undefined, feed);
  const mcp = new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", seenFile: join(store.root, "mcp-seen.json"), connectorsFile: join(store.root, "claude-ai-connectors.json"), boards: boardToolsSource(store) });
  const scheduler = new Scheduler(board, store, bus);
  const jobs = new JobRunner(board, store, bus);
  const passes = new Passes(store.root, bus, { fetch: globalThis.fetch, now: () => new Date() }, () => `http://localhost:${port}/api/passes/oauth/callback`);
  const shimDir = ckanbanShim(store.root);
  const sideCall = makeSideCaller({ cwd: join(store.root, "side-calls") });
  const loops = new LoopManager(store, bus, board, passes, {
    now: () => new Date(), sideCall, shimDir: () => shimDir, port: () => port,
  });
  const learner = new Learner(store, bus, {
    sideCall, entries: (t) => (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [], isRunning: (slug, id) => board.isRunning(slug, id),
    prepare: async (t) => void (t.sessionId && (await sessions.readIn(t.sessionId, pauser(), { parse: true }))),
  });
  const huddles = new Huddles(store, board, bus, {
    claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", learn: (slug, h, p, role, lessons) => void learner.addHuddleLessons(slug, h, p, role, lessons),
    entries: (t) => (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [],
  });
  const quickChats = new QuickChats(store, bus, board, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  // launchd (KeepAlive) starts the daemon again once it exits.
  const restart = () => board.requestRestart(() => void shutdown());
  // The helper (helper/runner.ts): plugged into the notifier before notifier.start, so start-up waits go to it.
  // Satellite mode: the helper runs in the Rust board (P1a); this daemon has none (its routes are Rust's).
  const helper = satellite ? null : new HelperRunner({
    root: store.root, store, core: notifier.helper, notifySettings: () => notifier.settings(), sideCall,
    link: (slug, id) => notifier.link(slug, id), messageLink: (id) => notifier.messageLink(id),
    snoozedUntil: (slug, id) => {
      const t = store.getTicket(slug, id);
      if (!t?.snooze || Date.parse(t.snooze.until) <= Date.now()) return null;
      const s = t.sessionId ? (satellite ? mirror.sessionSummary(t.sessionId) : sessions.summary(t.sessionId)) : null;
      const running = (x: string) => (satellite ? mirror.isRunning(slug, x) : board.isRunning(slug, x));
      const h = (satellite ? mirror.hostHuddles(slug) : board.hostHuddles(slug)).get(id);
      const a = ticketAttention(store, slug, t, s, running(id), h, running);
      return withSnooze(t, s, a, Date.now(), h).snoozed?.until ?? null;
    },
    onScreen: () => push.anyVisible(), phoneDevices: () => push.phoneDevices(),
    checkinOffer: () => mcp.state().servers.some((x) => x.status === "connected")
      && !store.listProfiles().some((p) => store.listSchedules(p.slug).some((x) => x.quiet)),
    emit: (e) => bus.emit(e),
  });
  // Runs keep the Mac awake on boards with "Keep this Mac awake" on; the helper's urgent items and due times on any board.
  const awake = new StayAwake({
    wanted: () => board.busyBoards().some((slug) => keepAwakeOn(store.getProfile(slug))) || !!helper?.wantsAwake(),
    onChange: (held) => bus.emit({ type: "awake.updated", held }),
  });
  const remotePort = remoteListenPort(port, config.remotePort);
  // Satellite mode: the Rust board has the phone access listener (on remotePort, which it passes in
  // CKANBAN_REMOTE_PORT); turning phone access on points `tailscale serve` there. Otherwise this daemon's own listener.
  // No listener (not bound): 0, so `on` refuses instead of pointing serve at whatever holds the port.
  const phone = (phoneRemote = new RemoteAccess(store.root, () => (satellite ? remotePort : (server.remoteServer?.port ?? 0))));
  const server = createServer({ store, bus, board, port: listenPort, remotePort: satellite ? undefined : remotePort, webDir,
    remote: phone,
    ...(edge && front ? { satellite: { replay: rustReplay(front) } } : {}), sessions, terminals, shells, mcp, scheduler, jobs, huddles, learner, quickChats, loops, sideCall, passes, assets: WEB_ASSETS, restart, awake: () => awake.held(), notifier, push, ...(helper ? { helper } : {}) });
  console.log(`ckanban v${VERSION} listening on http://localhost:${front ? port : server.port} (data: ${store.root})${front ? ` behind the front server (internal port ${server.port})` : ""}${satellite ? " as the Rust board's satellite" : ""}`);
  // Running from source (developing ckanban): a freeze of seconds raises a Mac banner naming what ran. Installed
  // copies only log it; their users can't act on it.
  const stopLag = startLagMonitor(VERSION === "dev" ? {
    onLag: freezeAlarm({ send: (title, body) => notifier.macOnly(title, body, `${notifier.link(store.listProfiles()[0]?.slug ?? "")}`) }),
  } : {});
  // Every board's tickets read in slices first: recover() and the first pages then list them from memory instead of
  // reading thousands of ticket files in one go.
  await track("startup: load tickets", () => store.loadAllTickets());
  // Huddles, jobs, schedules and automations too: a board keeps every finished one, so the first read can be big.
  await track("startup: load lists", () => store.loadAllLists());
  // Satellite mode: the Rust board recovers runs, runs the timers and owns every ticket write; this daemon only
  // keeps its file caches fresh (reads) for the helper and the routes it still answers.
  const full = !satellite;
  const off = () => {};
  if (full) {
    // Planned tickets are retired: old plans become main tickets with tool tickets (once; a no-op after that).
    await track("startup: retire old plans", () => retireOldPlans(store)).catch((e) => console.error("retire old plans", e));
    track("startup: board.recover", () => board.recover());
    track("startup: huddles.recover", () => huddles.recover());
    await track("startup: quickChats.recover", () => quickChats.recover());
    huddles.startWatchdog();
    // Board browsers: adopt the data folders and the Chromes still running from before a restart, start keep-running ones.
    void track("startup: board browsers", () => board.boardBrowsers.init().then(() => board.boardBrowsers.start()).catch((e) => console.error("board browsers", e)));
    void track("startup: sweepWorktrees", () => board.sweepWorktrees());
  }
  // Satellite mode: the Rust board runs these clean-ups (report-only at first, rust/board/src/gate/housekeeping.rs).
  if (!satellite) {
    void track("startup: trim daemon.log", () => trimDaemonLog(join(store.root, "daemon.log"))).catch((e) => console.error("daemon.log trim", e));
    void track("startup: sweep temp files", () => sweepTempFiles(store.root)).catch((e) => console.error("temp file sweep", e));
  }
  if (full) void track("startup: detectMissing", () => detectMissing(store, (profile) => bus.emit({ type: "profile.updated", slug: profile.slug, profile })));
  const stopPoller = full ? startPoller(board, store, config.prPollMinutes) : off;
  // After recover(): a missed run's ticket must not be mistaken for an interrupted one.
  // CKANBAN_TICK_MS (tests only) shortens these timers; unset, each keeps its own period.
  const tick = tickMs();
  if (tick !== undefined && full) console.log(`timers: schedules, jobs, automations and follow-ups look every ${tick} ms (CKANBAN_TICK_MS)`);
  const stopScheduler = full ? scheduler.start(tick) : off;
  const stopJobs = full ? jobs.start(tick) : off;
  const stopLoops = full ? loops.start(tick) : off;
  const stopLearner = full ? learner.start() : off;
  const stopLimits = full ? new LimitWatcher(board, store).start() : off;
  const stopFollowUps = full ? new FollowUpWatcher(board, store).start(tick) : off;
  // Run logs of tickets Done for over 30 days are compressed, a few at a time, losing nothing (run-log-compress.ts).
  const stopLogCompress = full ? new RunLogCompressor(store, (slug, id) => board.isRunning(slug, id)).start() : off;
  const stopWatcher = full ? startSessionWatcher(store, bus, sessions, 2000, { feed }) : off;
  // Ticket files edited outside the Store, found in slices in the background instead of inside a listing.
  let rechecking: Promise<void> | null = null;
  const recheck = () => (rechecking ??= store.recheckTickets().catch((e) => console.error("ticket recheck", e)).finally(() => (rechecking = null)));
  void recheck();
  const recheckTimer = trackedInterval("ticket-recheck", recheck, TICKET_RECHECK_MS);
  // The same for huddle, job, schedule and automation files (json-dir.ts), instead of inside the next list read.
  let recheckingLists: Promise<void> | null = null;
  const recheckLists = () => (recheckingLists ??= store.recheckLists().catch((e) => console.error("list recheck", e)).finally(() => (recheckingLists = null)));
  void recheckLists();
  const listRecheckTimer = trackedInterval("list-recheck", recheckLists, JSON_DIR_RECHECK_MS);
  const stopHuddleWatcher = full ? startHuddleSessionWatcher(store, bus, (id) => sessions.version(id), 2000, { feed }) : off;
  const stopTerminals = full ? terminals.start() : off;
  const stopMcp = mcp.start();
  // After recover(): what already waits when the daemon starts doesn't notify again.
  const stopNotifier = notifier.start();
  const stopHelper = helper ? helper.start() : () => {};
  const stopAwake = awake.start();
  // Phone access on: Tailscale's link to the board is checked and put back when something removed it.
  const stopServeWatch = watchServe(phone);

  const shutdown = async () => {
    console.log("ckanban shutting down");
    stopPoller();
    stopScheduler();
    stopJobs();
    stopLoops();
    stopLearner();
    stopLimits();
    stopFollowUps();
    stopWatcher();
    stopLogCompress();
    clearInterval(recheckTimer);
    clearInterval(listRecheckTimer);
    if (full) sessions.flushSummariesNow();
    stopHuddleWatcher();
    stopFollow();
    feed.stop();
    stopTerminals();
    shells.killAll();
    stopMcp();
    stopNotifier();
    stopHelper();
    stopAwake();
    stopServeWatch();
    // Board browsers stay running (detached from the daemon, so nothing can cut a close short and lose logins); the
    // next daemon adopts them again.
    if (full) board.boardBrowsers.shutdown();
    stopLag();
    if (full) await Promise.all([board.shutdown(), huddles.shutdown(), quickChats.shutdown()]);
    server.stop(true);
    server.remoteServer?.stop(true);
    process.exit(0);
  };
  frontGone = () => void shutdown();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
