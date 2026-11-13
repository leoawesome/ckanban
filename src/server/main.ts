import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanupTmuxLeftovers } from "./artifact";
import { StayAwake } from "./awake";
import { Board } from "./board";
import { Bus } from "./events";
import { createServer } from "./http";
import { QuickChats } from "./quickchat";
import { Huddles } from "./huddle";
import { withUtf8Locale } from "./locale";
import { boardToolsSource, McpManager } from "./mcp";
import { startPoller } from "./prpoller";
import { Notifier } from "./notify";
import { HelperRunner } from "./helper/runner";
import { ticketAttention, withSnooze } from "./attention";
import { PushService } from "./push";
import { RemoteAccess, remoteListenPort, remoteUrl } from "./remote";
import { Passes } from "./integrations/passes";
import { ckanbanShim } from "./integrations/script";
import { freezeAlarm, pauser, startLagMonitor, track, trackedInterval } from "./lag";
import { LoopManager } from "./loops";
import { makeSideCaller } from "./side-call";
import { Learner } from "./learner";
import { Scheduler } from "./scheduler";
import { JobRunner } from "./jobs";
import { FollowUpWatcher } from "./followup";
import { LimitWatcher } from "./limit";
import { startHuddleSessionWatcher } from "./huddle-session";
import { projectsDir, SessionCache, startSessionWatcher } from "./session";
import { SessionFeed } from "./changefeed";
import { ShellManager } from "./shell";
import { TerminalWatcher } from "./terminals";
import { defaultRoot, Store, TICKET_RECHECK_MS } from "./store";
import { keepAwakeOn } from "./types";
import { VERSION } from "./version";
import { WEB_ASSETS } from "./web-assets.gen";
import { detectMissing } from "./worktree-setup";

export async function startDaemon(): Promise<void> {
  // Board runs and other children inherit this; an older launchd plist starts the daemon with no locale.
  Object.assign(process.env, withUtf8Locale(process.env));
  const store = new Store(defaultRoot());
  const config = store.config();
  const port = Number(process.env.CKANBAN_PORT) || config.port;
  const bus = new Bus();
  const sessions = new SessionCache({}, Date.now, join(store.root, "session-summaries.json"));
  // One watch on Claude's projects folder: watchers look only at sessions that changed (they poll if it can't start).
  const feed = new SessionFeed(projectsDir());
  if (!feed.start()) console.warn("session feed: can't watch Claude's projects folder; watchers poll every ticket");
  const stopFollow = sessions.follow(feed);
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
  const notifier: Notifier = new Notifier(store, bus, {
    root: store.root, push, sessionSummary: (id) => sessions.summary(id), sessionsReady: () => sessions.settled(), isRunning: (slug, id) => board.isRunning(slug, id),
    hostHuddles: (slug) => board.hostHuddles(slug),
    baseUrl: () => {
      const r = remoteConfig.active();
      return r ? remoteUrl(r.host) : `http://localhost:${server.port}`;
    },
  });
  notifier.plugBoard(board);
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
  const helper = new HelperRunner({
    root: store.root, store, core: notifier.helper, notifySettings: () => notifier.settings(), sideCall,
    link: (slug, id) => notifier.link(slug, id), messageLink: (id) => notifier.messageLink(id),
    snoozedUntil: (slug, id) => {
      const t = store.getTicket(slug, id);
      if (!t?.snooze || Date.parse(t.snooze.until) <= Date.now()) return null;
      const s = t.sessionId ? sessions.summary(t.sessionId) : null;
      const h = board.hostHuddles(slug).get(id);
      const a = ticketAttention(store, slug, t, s, board.isRunning(slug, id), h, (x) => board.isRunning(slug, x));
      return withSnooze(t, s, a, Date.now(), h).snoozed?.until ?? null;
    },
    onScreen: () => push.anyVisible(), phoneDevices: () => push.phoneDevices(),
    checkinOffer: () => mcp.state().servers.some((x) => x.status === "connected")
      && !store.listProfiles().some((p) => store.listSchedules(p.slug).some((x) => x.quiet)),
    emit: (e) => bus.emit(e),
  });
  // Runs keep the Mac awake on boards with "Keep this Mac awake" on; the helper's urgent items and due times on any board.
  const awake = new StayAwake({
    wanted: () => board.busyBoards().some((slug) => keepAwakeOn(store.getProfile(slug))) || helper.wantsAwake(),
    onChange: (held) => bus.emit({ type: "awake.updated", held }),
  });
  const remotePort = remoteListenPort(port, config.remotePort);
  const server = createServer({ store, bus, board, port, remotePort, webDir, sessions, terminals, shells, mcp, scheduler, jobs, huddles, learner, quickChats, loops, sideCall, passes, assets: WEB_ASSETS, restart, awake: () => awake.held(), notifier, push, helper });
  console.log(`ckanban v${VERSION} listening on http://localhost:${server.port} (data: ${store.root})`);
  // Running from source (developing ckanban): a freeze of seconds raises a Mac banner naming what ran. Installed
  // copies only log it; their users can't act on it.
  const stopLag = startLagMonitor(VERSION === "dev" ? {
    onLag: freezeAlarm({ send: (title, body) => notifier.macOnly(title, body, `${notifier.link(store.listProfiles()[0]?.slug ?? "")}`) }),
  } : {});
  // Every board's tickets read in slices first: recover() and the first pages then list them from memory instead of
  // reading thousands of ticket files in one go.
  await track("startup: load tickets", () => store.loadAllTickets());
  track("startup: board.recover", () => board.recover());
  track("startup: huddles.recover", () => huddles.recover());
  track("startup: quickChats.recover", () => quickChats.recover());
  huddles.startWatchdog();
  void track("startup: sweepWorktrees", () => board.sweepWorktrees());
  void track("startup: detectMissing", () => detectMissing(store, (profile) => bus.emit({ type: "profile.updated", slug: profile.slug, profile })));
  const stopPoller = startPoller(board, store, config.prPollMinutes);
  // After recover(): a missed run's ticket must not be mistaken for an interrupted one.
  const stopScheduler = scheduler.start();
  const stopJobs = jobs.start();
  const stopLoops = loops.start();
  const stopLearner = learner.start();
  const stopLimits = new LimitWatcher(board, store).start();
  const stopFollowUps = new FollowUpWatcher(board, store).start();
  const stopWatcher = startSessionWatcher(store, bus, sessions, 2000, { feed });
  // Ticket files edited outside the Store, found in slices in the background instead of inside a listing.
  let rechecking: Promise<void> | null = null;
  const recheck = () => (rechecking ??= store.recheckTickets().catch((e) => console.error("ticket recheck", e)).finally(() => (rechecking = null)));
  void recheck();
  const recheckTimer = trackedInterval("ticket-recheck", recheck, TICKET_RECHECK_MS);
  const stopHuddleWatcher = startHuddleSessionWatcher(store, bus, (id) => sessions.version(id), 2000, { feed });
  const stopTerminals = terminals.start();
  const stopMcp = mcp.start();
  // After recover(): what already waits when the daemon starts doesn't notify again.
  const stopNotifier = notifier.start();
  const stopHelper = helper.start();
  const stopAwake = awake.start();

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
    clearInterval(recheckTimer);
    sessions.flushSummaries();
    stopHuddleWatcher();
    stopFollow();
    feed.stop();
    stopTerminals();
    shells.killAll();
    stopMcp();
    stopNotifier();
    stopHelper();
    stopAwake();
    stopLag();
    await Promise.all([board.shutdown(), huddles.shutdown(), quickChats.shutdown()]);
    server.stop(true);
    server.remoteServer?.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
