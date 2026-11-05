import { parseConnectorSetting } from "./connectors";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { routeLabel, track } from "./lag";
import { runArtifactJob, type ArtifactJob, type ArtifactOutcome } from "./artifact";
import { profileFor } from "./cpuprof";
import { ConflictError, recoveryFor, type Board } from "./board";
import { FollowUpError } from "./followup";
import { claudeDefaults, findClaude, listClaudeProjects, listSessions, liveSessionMatch, pickFolder, processCommands } from "./claude";
import type { Bus, BusEvent } from "./events";
import { EFFORT_HELP, listCommands, MODEL_HELP, validEffort, validModel } from "./commands";
import { isManager, kindDefaults, TOOL_NO_NOTIFY } from "./main-ticket";
import { addPrs } from "./prs";
import { DiffError, folderDiff, ticketDiff } from "./diff";
import { detectBaseBranch, enableVersionHistory, hasUncommittedChanges, isGitRepo, repoKind, resolveBaseBranch, which } from "./git";
import { checkPr, mergePr, PrError, REFRESH_MIN_MS, refreshPr, resolveConflicts, sendFailures, type PrDeps } from "./prpoller";
import { resumeCommand } from "./prompts";
import { applyRewind, previewRewind } from "./rewind";
import { cronError, describeCron, nextRuns, parseCron } from "./cron";
import { fromUserBrowser } from "./integrations/guard";
import { PassError, Passes } from "./integrations/passes";
import { ckanbanShim } from "./integrations/script";
import { LoopError, LoopManager } from "./loops";
import { RUN_HEADER, ScheduleError, Scheduler } from "./scheduler";
import { JobError, JobRunner } from "./jobs";
import { SnippetError, Snippets } from "./snippets";
import { HuddleError, Huddles, type Caller } from "./huddle";
import { HuddleSessionCache, participantSession, participantTool } from "./huddle-session";
import { HUDDLE_HEADER, SOURCE_HEADER } from "./huddle-roster";
import { NOTES_CAP } from "./huddle-notes";
import { byWaitingAge, huddleAsk, huddleBusy, SNOOZE_MS, snoozeKey, ticketAttention, userWaitReason, withSnooze } from "./attention";
import { isComplete, MAX_RETRIES, planActive } from "./plan";
import { BugReportError, draftReport, submitReport, type BugBlockId, type BugSource, type GhRunner } from "./bugreport";
import {
  AttachmentError, attachmentFile, attachmentType, cleanFileName, IMAGE_TYPES, opensInline, saveAttachment, UNSUPPORTED, uploadExt,
} from "./attachments";
import { FileError, findInRoots, listDir, openWithSystem, readFileForView, type FileRoot } from "./files";
import { boardToolsSource, McpError, McpManager } from "./mcp";
import { MessageError, Notifier } from "./notify";
import { DeviceError, TAKE_WAIT_MS, type DeviceUser } from "./devices";
import { PushService } from "./push";
import { LISTENER_HEADER, LOGIN_HEADER, qrSvg, RemoteAccess, RemoteError, remoteUrl, type RemoteConfig } from "./remote";
import { AGENT_IDS, AgentError, AgentRegistry, type AgentId } from "./agents";
import { collectLinks } from "./links";
import { findSessionFile, fromTicketText, SessionCache, type SessionEntry, type SessionSummary } from "./session";
import { matchesText, parseRef, readChat, readText, searchChat, toolOutputs, type ChatSource } from "./chat-search";
import { ptySupported, ShellManager, type Shell } from "./shell";
import { AGENT_STEP_TAIL, settleAgent } from "./subagents";
import { settleWorkflow, withRun, workflowAgentDetail, workflowScript, type WorkflowInfo } from "./workflows";
import { QuickChatError, QuickChats } from "./quickchat";
import type { TerminalWatcher } from "./terminals";
import { attachmentHeader, canCopyFile, copyFileToClipboard, markdownPage, markdownTitle, revealFile, ShareError } from "./share";
import { UpdateChecker } from "./update";
import { SpendIndex } from "./spend";
import { quietPerDay, scheduleSpend } from "./quiet";
import { makeSideCaller, readSideSpend, type SideCaller } from "./side-call";
import { LearnError, Learner } from "./learner";
import { Simplifier, SimplifyError } from "./simplify";
import { changesPrompt, HELP_KINDS, Helper, HelpError, newId, recapAvailable, recapPrompt, type HelpKind } from "./explain";
import { ClaudeLogIndex, readWindows, recordWindow, ticketRuns, ticketUsage, UsageCache, windowsNeeded } from "./ticket-usage";
import { fetchUsage, type UsageResult } from "./usage";
import { Linker } from "./linker";
import { familyOf, familyRoot, groupsOf, hiddenTool, withYouTool, isFeature, LINK_WORDS, openFeatures, parentLink, TICKET_KINDS, type TicketKind } from "../../web/src/family";
import { STATUS_FIELDS, type StatusPatch } from "./feature";
import { createdFromDraft } from "../../web/src/proposalMatch";
import type { Store } from "./store";
import { runCapFor, SELF_MOVES, STATUSES, type Profile, type SelfMove, type Schedule, type ScheduleEditor, type Status, type Ticket, type Workspace } from "./types";
import { nowIso, slugify } from "./util";
import { applyDetection, detectSetup } from "./worktree-setup";

/** A chat on another board acting for the user here (see runRights): its board and ticket. */
interface Guest {
  slug: string;
  ticket: Ticket;
}

export interface ServerDeps {
  store: Store;
  bus: Bus;
  board: Board;
  port: number;
  webDir: string;
  /** gh stand-ins for the PR box (tests). */
  pr?: PrDeps;
  /** URL path → embedded file (standalone binary). When non-empty, used instead of webDir. */
  assets?: Record<string, string>;
  sessions?: SessionCache;
  updates?: UpdateChecker;
  terminals?: TerminalWatcher;
  shells?: ShellManager;
  mcp?: McpManager;
  scheduler?: Scheduler;
  /** Automations and the board's own passes (integrations/, loops.ts); the daemon passes the ones it checks with. */
  loops?: LoopManager;
  passes?: Passes;
  /**
   * Whether a local request comes from a web browser the daemon didn't start: only that may save automations or
   * passes (integrations/guard.ts). Tests pass a fake.
   */
  isUserBrowser?: (peerPort: number) => Promise<boolean>;
  jobs?: JobRunner;
  agents?: AgentRegistry;
  huddles?: Huddles;
  /** What the board learns on its own (learner.ts); the daemon passes its started one. */
  learner?: Learner;
  quickChats?: QuickChats;
  /** Restart the daemon once no run is active (POST /api/restart); missing when not running as the daemon. */
  restart?: () => { running: number; alreadyPending: boolean };
  /** The daemon keeps the Mac awake for active work now (GET /api/awake); missing: never. */
  awake?: () => boolean;
  /** Runs `gh` for bug reports (tests pass a fake). */
  gh?: GhRunner;
  /** Claude plan usage for the header pill (tests pass a fake). */
  usage?: () => Promise<UsageResult>;
  /** Machine-wide Claude Code cost, for a ticket's share of the 5h window (tests pass one on a fixture folder). */
  claudeLogs?: ClaudeLogIndex;
  /** Publishes output files as claude.ai pages (tests pass a fake). */
  publishArtifact?: (job: ArtifactJob) => Promise<ArtifactOutcome>;
  /** One-shot cheap Claude answers outside any session, e.g. "Say it simpler" (tests pass a fake). */
  sideCall?: SideCaller;
  /** Phone access over Tailscale (tests pass one with a fake tailscale runner). */
  remote?: RemoteAccess;
  /** Loopback port `tailscale serve` points at (remote.ts); 0 picks a free one; omitted: no phone access listener. */
  remotePort?: number;
  /** "Needs you" notifications (notify.ts); the daemon passes its started one. */
  notifier?: Notifier;
  /** Phone push devices (push.ts), shared with the notifier. */
  push?: PushService;
  /** Parent suggestions and Find links (linker.ts); tests pass one on a fake side call. */
  linker?: Pick<Linker, "suggest" | "find">;
}

/** A Share menu publish in progress, or the error of the last one, per output file. Not persisted. */
interface ShareJob {
  file: string;
  state: "publishing" | "failed";
  error?: string;
  at: string;
}

interface ShellSocket {
  slug: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: Shell;
  unsubscribe?: () => void;
}

class HttpError extends Error {
  /** confirm: the UI asks the user and resends with `confirmParallel: true` (see parallelWork). */
  constructor(public status: number, message: string, public confirm?: string) {
    super(message);
  }
}

/**
 * The UI is about to make a run and a huddle work the same ticket at once: refused with a question the UI asks
 * ("Start anyway?"), unless the user already said yes (confirmParallel). Other callers (runs, CLI) aren't asked.
 */
function parallelWork(req: Request, b: any, what: "huddle-open" | "run-active"): void {
  if (req.headers.get(SOURCE_HEADER) !== "ui" || req.headers.get(RUN_HEADER) || b?.confirmParallel === true) return;
  throw new HttpError(409, what === "huddle-open"
    ? "A huddle is already working on this ticket."
    : "This ticket's run is already working on it.", what);
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_MAX_PARALLEL = 5;
/** Output extensions served with their image type (raster only) so the Outputs tab can preview them. */
const OUTPUT_IMAGE_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  jpeg: "image/jpeg",
};

/** Plain text + sandbox: files are written by Claude and must never run as HTML on this origin.
 * Only raster images get their real type so a viewer can preview them; SVG stays text (it can carry scripts). */
function rawFile(file: string, download: boolean): Response {
  const image = OUTPUT_IMAGE_TYPES[file.slice(file.lastIndexOf(".") + 1).toLowerCase()];
  return new Response(Bun.file(file), {
    headers: {
      "content-type": image ?? "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      ...(download ? { "content-disposition": attachmentHeader(basename(file)) } : {}),
    },
  });
}

/** Folders a ticket's chat may point at files in, in lookup order: its own copy of the project first. */
function fileRoots(profile: Profile, t: Ticket, outputs: string): FileRoot[] {
  const own = t.worktree ?? t.workdir;
  return [
    // A ticket working in the project folder itself has no copy of its own.
    ...(own && resolve(own) !== resolve(profile.path) ? [{ name: "ticket" as const, dir: own }] : []),
    { name: "project", dir: profile.path },
    { name: "outputs", dir: outputs },
    // A main ticket's result cards open its tool tickets' reports (Read report).
    ...[...new Set((t.results ?? []).flatMap((r) => (r.report ? [dirname(r.report)] : [])))].map((dir) => ({ name: "outputs" as const, dir })),
  ];
}

/**
 * Which listener a request came in on. local: the board's own port, for this Mac. remote: a second loopback port that
 * only `tailscale serve` points at (phone access, remote.ts), so a tailnet request can't pass as local by sending
 * `Host: localhost` (serve passes the client's Host header through).
 */
export type Listener = "local" | "remote";

/**
 * Why a request is refused, or null when allowed. Local: Host localhost/127.0.0.1 on our port (DNS rebinding) and,
 * for mutations, a same-origin Origin (CSRF). Remote: only while phone access is on, the tailnet host, from the
 * allowed Tailscale login only (`tailscale serve` sets the header and drops any copy the client sent).
 */
export function requestRefusal(req: Request, port: number, remote?: RemoteConfig | null, via: Listener = "local"): string | null {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const origin = req.headers.get("origin");
  const mutation = req.method !== "GET" && req.method !== "HEAD";
  if (via === "local") {
    if (!LOCAL_HOSTS.some((h) => host === `${h}:${port}`)) return "forbidden";
    if (mutation && origin && !LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`)) return "forbidden";
    return null;
  }
  if (!remote) return "forbidden: phone access is off (run `ckanban remote on` on the Mac)";
  if (host !== remote.host && host !== `${remote.host}:443`) return "forbidden";
  const login = req.headers.get(LOGIN_HEADER)?.trim().toLowerCase();
  if (!login || login !== remote.allowedLogin.toLowerCase()) return "forbidden: open this board signed in to Tailscale as its owner";
  if (mutation && origin && origin !== remoteUrl(remote.host)) return "forbidden";
  return null;
}

export function isAllowedRequest(req: Request, port: number, remote?: RemoteConfig | null, via: Listener = "local"): boolean {
  return requestRefusal(req, port, remote, via) === null;
}

/** WebSocket upgrades are GETs, so they need their own Origin check (browsers always send one). */
export function isAllowedSocket(req: Request, port: number, remote?: RemoteConfig | null, via: Listener = "local"): boolean {
  const origin = req.headers.get("origin");
  if (!isAllowedRequest(req, port, remote, via) || !origin) return false;
  return via === "local" ? LOCAL_HOSTS.some((h) => origin === `http://${h}:${port}`) : origin === remoteUrl(remote!.host);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** A folder as the OS sees it (symlinks, trailing slash, letter case); the path as written when it doesn't exist. */
function realFolder(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** One board per folder: runs in the folder itself take turns only within a board. Boards that already share one keep working. */
export function refuseSharedFolder(others: Profile[], path: string) {
  const want = realFolder(path);
  const owner = others.find((p) => realFolder(p.path) === want);
  if (owner) throw new HttpError(400, `The board "${owner.name || owner.slug}" already uses this folder. Open that board instead.`);
}

export function createServer(deps: ServerDeps) {
  const { store, bus, board } = deps;
  const sessions = deps.sessions ?? new SessionCache();
  const huddleSessions = new HuddleSessionCache();
  const updates = deps.updates ?? new UpdateChecker();
  const shells = deps.shells ?? new ShellManager();
  const mcp = deps.mcp ?? new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", boards: boardToolsSource(store) });
  const scheduler = deps.scheduler ?? new Scheduler(board, store, bus);
  const jobs = deps.jobs ?? new JobRunner(board, store, bus);
  // The address a service sends the user back to after signing in: always localhost, on this board's port.
  const callbackUrl = () => `http://localhost:${server.port ?? deps.port}/api/passes/oauth/callback`;
  const passes = deps.passes ?? new Passes(store.root, bus, { fetch: globalThis.fetch, now: () => new Date() }, callbackUrl);
  const agents = deps.agents ?? new AgentRegistry();
  const sideCall = deps.sideCall ?? makeSideCaller({ cwd: join(store.root, "side-calls") });
  /**
   * The ticket chat's conversation: chats left behind with "Send in a fresh chat" (no rewinding into them), each followed
   * by a note that Claude doesn't see what's above, then the current chat.
   */
  const chatEntries = (t: Ticket): SessionEntry[] => {
    const current = (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [];
    if (!t.earlierSessions?.length) return current;
    const earlier = t.earlierSessions.flatMap((s) => [
      ...(sessions.get(s.sessionId)?.entries ?? []).map(({ rewind: _, ...e }) => e as SessionEntry),
      { uuid: `fresh-chat-${s.sessionId}`, at: s.endedAt, role: "assistant", kind: "board", text: "Fresh chat from here: Claude no longer reads the messages above, but can look them up." } as SessionEntry,
    ]);
    return [...earlier, ...current];
  };
  const learner = deps.learner ?? new Learner(store, bus, {
    sideCall, entries: (t) => (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [], isRunning: (slug, id) => board.isRunning(slug, id),
  });
  const huddles = deps.huddles ?? new Huddles(store, board, bus, {
    claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", learn: (slug, h, p, role, lessons) => void learner.addHuddleLessons(slug, h, p, role, lessons),
    entries: (t) => (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [],
  });
  const quickChats = deps.quickChats ?? new QuickChats(store, bus, board, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  const snippets = new Snippets(store, bus);
  const windowsFile = join(store.root, "usage-windows.json");
  const usage = new UsageCache(deps.usage ?? fetchUsage, (r) => recordWindow(windowsFile, r));
  const spend = new SpendIndex(store);
  // A main ticket's card and result cards count what its family spent.
  board.onCost((s, id) => spend.ticket(s, id).costUsd + huddles.ticketSpend(s, id).costUsd);
  const loops = deps.loops ?? new LoopManager(store, bus, board, passes, {
    now: () => new Date(), sideCall, shimDir: () => ckanbanShim(store.root), port: () => server.port ?? deps.port,
  });
  const isUserBrowser = deps.isUserBrowser ?? ((peerPort: number) => fromUserBrowser(peerPort));
  /**
   * Saving or changing an automation or a pass is for the user only: from the board's page in a browser. Not a board
   * run (RUN_HEADER), and not any other program, header or not: a run's shell, a check script, the board's terminal or
   * a page from elsewhere (no Origin of the board). Fails closed when the caller can't be told.
   */
  /** A workflow as the chat shows it: its files plus the run's live progress, settled once the run is gone, no script. */
  const workflowView = (w: WorkflowInfo, slug: string, id: string, sessionId: string, active: boolean): WorkflowInfo => {
    const live = board.workflowProgress(slug, id, w.toolUseId);
    const merged = live && w.status === "running" && w.runId ? withRun(w, sessions.workflowRun(sessionId, w.runId), live) : w;
    const { script: _script, scriptPath: _path, ...rest } = settleWorkflow(merged, active);
    return rest;
  };
  const userOnly = async (req: Request, what: string) => {
    const refusal = `${what} is for the user only, from the board in a browser: a board run, a check script or another program can't do it. Ask the user to do it in the board.`;
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER) || !req.headers.get("origin")) throw new HttpError(403, refusal);
    const v = via.get(req);
    // Phone access: only the tailnet owner's browser gets here (requestRefusal checks the login and the Origin).
    if (v?.listener === "remote") return;
    const peer = v?.srv.requestIP(req)?.port ?? 0;
    if (!(await isUserBrowser(peer))) throw new HttpError(403, refusal);
  };  const simplifier = new Simplifier(store, sideCall);
  const helper = new Helper(store, sideCall);
  const linker = deps.linker ?? new Linker(store, board, sideCall);
  /** Looks for a parent for a ticket the user made, in the background (it never holds up saving). */
  const suggestParent = (slug: string, id: string) => {
    linker.suggest(slug, id).catch((e) => console.error(`suggesting a parent for ${slug}/${id}: ${(e as Error).message}`));
  };
  const claudeLogs = deps.claudeLogs ?? new ClaudeLogIndex();
  const publishArtifact = deps.publishArtifact ?? ((job: ArtifactJob) => runArtifactJob(job));
  // No listener (not bound): 0, so `on` refuses instead of pointing serve at whatever holds the port.
  const remote = deps.remote ?? new RemoteAccess(store.root, () => remoteServer?.port ?? 0);
  // The listener each request came in on, for the routes that care (WebSocket upgrades, /api/remote).
  const via = new WeakMap<Request, { listener: Listener; srv: import("bun").Server<ShellSocket> }>();
  const listenerOf = (req: Request): Listener => via.get(req)?.listener ?? "local";
  const push = deps.push ?? new PushService(store.root);
  const notifier = deps.notifier ?? new Notifier(store, bus, {
    root: store.root, push, sessionSummary: (id) => sessions.summary(id), isRunning: (s, id) => board.isRunning(s, id),
    hostHuddles: (s) => board.hostHuddles(s), baseUrl: () => (remote.active() ? remoteUrl(remote.active()!.host) : `http://localhost:${server.port ?? deps.port}`),
  });
  // "<profile>/<ticket>" -> jobs by output file.
  const shareJobs = new Map<string, Map<string, ShareJob>>();

  const profileOr404 = (slug: string): Profile => {
    const p = store.getProfile(slug);
    if (!p) throw new HttpError(404, `board ${slug} not found`);
    return p;
  };
  const ticketOr404 = (slug: string, id: string): Ticket => {
    const t = store.getTicket(slug, id);
    if (!t) throw new HttpError(404, `ticket ${id} not found`);
    return t;
  };
  /**
   * Board runs send RUN_HEADER ("<profile>/<ticket id>") with ticket changes. Who may change which ticket:
   * - a Planning chat answering the user's message (Board.userRequestRights) acts for the user on any ticket of its
   *   board but its own: returned as `requester`;
   * - a planner on its own child tickets: any run of a running plan, or a reply to the user's message in the
   *   planner's chat (Board.plannerRights): returned as `planner`;
   * - any other active work run or chat reply (Board.runnerRights) on any other ticket of its board, when its task
   *   calls for it: returned as `runner`. Starting runs that way is limited (Board.runStart), and so is closing work.
   * - a chat on another board answering a message the user typed there (Board.userAskedRun, checked on its own board)
   *   acts for the user on any ticket of this board: returned as `guest`. Other runs stay on their own board.
   * Returns {} for the user. Huddle agents run as their host ticket but get none of these. Deleting stays the user's.
   */
  const runRights = (req: Request, slug: string, target?: Ticket): { planner?: Ticket; requester?: Ticket; runner?: Ticket; guest?: Guest } => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return {};
    const [runSlug, runId] = h.split("/");
    if (runSlug !== slug && runId) {
      const ticket = !req.headers.get(HUDDLE_HEADER) && board.userAskedRun(runSlug, runId) ? store.getTicket(runSlug, runId) : null;
      if (ticket) return { guest: { slug: runSlug, ticket } };
      throw otherBoard("changing tickets", slug, runSlug);
    }
    const mine = runSlug === slug && !!runId && !req.headers.get(HUDDLE_HEADER);
    // A main ticket (or tool group) manages its own family from every run, whoever started it, in any column.
    const self = mine && target?.id !== runId ? store.getTicket(slug, runId) : null;
    if (self && isManager(self)) {
      const planner = board.plannerRights(slug, runId);
      if (planner && (!target || inFamily(slug, planner.id, target.id))) return { planner };
    }
    const requester = mine ? board.userRequestRights(slug, runId) : null;
    if (requester) {
      if (target?.id === requester.id) {
        throw new HttpError(403, `${target.id} is this Planning chat's own ticket: ask the user to edit or stop it themselves ` +
          "(changing it from here would end this reply or start its work). Only moving it to done, backlog or ready works, when the user asks in this chat");
      }
      return { requester };
    }
    if (mine && target?.id === runId) {
      throw new HttpError(403, `${target.id} is this run's own ticket: it may only move it to done, backlog or ready, and only when the ` +
        "user asks for that in a message they typed in this ticket's chat; otherwise ask the user to change it on the board");
    }
    const planner = mine ? board.plannerRights(slug, runId) : null;
    if (planner && (!target || target.parentId === planner.id || (isManager(planner) && inFamily(slug, planner.id, target.id)))) return { planner };
    const runner = mine ? board.runnerRights(slug, runId) : null;
    if (runner) return { runner };
    if (planner) {
      throw new HttpError(403, `${target!.id} is not a child ticket of plan ${planner.id}; the planner may only change its own child tickets`);
    }
    throw new HttpError(403, "changing the board is disabled inside a board run that isn't working right now (or is a Planning chat " +
      "without the user's message, a reply to another ticket's question or a huddle helper): only a ticket's active run or chat reply, " +
      "a Planning chat answering the user's message, and a planner on its own child tickets may change other tickets");
  };
  /** The refusal for a run reaching another board without the user's typed message (see runRights and askedBy). */
  const otherBoard = (what: string, slug: string, runSlug: string) =>
    new HttpError(403, `${what} on another board (${slug}) only works in a chat reply to a message the user typed in ` +
      `that chat (on ${runSlug}); work runs, follow-ups, plan wake-ups, replies to other tickets and huddle helpers stay on their own board`);
  /**
   * A chat answering a message the user typed there (Board.userAskedRun), on this board or another, not a huddle helper:
   * it may update any feature's status, gather tickets into any feature and read any ticket's chat for the user.
   * Returns how its change is credited on the changed ticket, or null for every other caller (and the user).
   */
  const askedBy = (req: Request, slug: string): string | null => {
    const h = req.headers.get(RUN_HEADER);
    if (!h || req.headers.get(HUDDLE_HEADER)) return null;
    const [runSlug, runId] = h.split("/");
    if (!runSlug || !runId || !board.userAskedRun(runSlug, runId)) return null;
    const t = store.getTicket(runSlug, runId);
    if (!t) return null;
    return runSlug === slug ? byChat(t) : byGuest({ slug: runSlug, ticket: t });
  };
  /** The board of the run that sent the request (RUN_HEADER), null outside runs. */
  const runBoard = (req: Request): string | null => req.headers.get(RUN_HEADER)?.split("/")[0] ?? null;
  /** The run's ticket when it runs on this board, else null (a run on another board, or the user). */
  const ownRun = (req: Request, slug: string): string | null => {
    const [runSlug, runId] = req.headers.get(RUN_HEADER)?.split("/") ?? [];
    return runSlug === slug && runId ? runId : null;
  };
  /**
   * search_chat / read_chat: a run reads its own ticket's chat, and a main ticket its family's; a chat answering the
   * user's typed message any ticket's, on any board (askedBy); the user's own Claude any.
   */
  const chatReach = (req: Request, slug: string, target: Ticket) => {
    if (req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "search_chat and read_chat work in a ticket's own runs, not for huddle helpers");
    const from = runBoard(req);
    if (from === null) return;
    const caller = ownRun(req, slug);
    if (caller === target.id) return;
    const manager = !!caller && isManager(store.getTicket(slug, caller));
    if (manager && inFamily(slug, caller!, target.id)) return;
    if (askedBy(req, slug)) return;
    if (!caller) throw otherBoard("reading chats", slug, from);
    throw new HttpError(403, `${target.id} is out of reach: from this run you may search the chat of your own ticket (${caller})` +
      (manager ? " and of its tool tickets (get_family lists them)" : "") +
      "; other tickets' chats only in a reply to a message the user typed in this chat.");
  };
  /** A ticket's chat, oldest session first: every one left behind with "Send in a fresh chat", then the current one. */
  const chatSources = (t: Ticket, tools: boolean): ChatSource[] =>
    [...(t.earlierSessions ?? []).map((s) => s.sessionId), ...(t.sessionId ? [t.sessionId] : [])].flatMap((sid) => {
      const parsed = sessions.get(sid);
      if (!parsed) return [];
      let toolOutput: Map<string, string> | undefined;
      if (tools) {
        const f = findSessionFile(sid);
        try {
          toolOutput = f ? toolOutputs(readFileSync(f, "utf8")) : undefined;
        } catch {}
      }
      return [{ sessionId: sid, entries: parsed.entries, toolOutput }];
    });
  /** target is below id in id's family (any link). */
  const inFamily = (slug: string, id: string, target: string): boolean => {
    const rows = familyOf(store.listTickets(slug), id);
    const at = rows.findIndex((r) => r.ticket.id === id);
    return at >= 0 && rows.some((r, i) => i > at && r.ticket.id === target && rows.slice(at + 1, i + 1).every((x) => x.depth > rows[at].depth));
  };
  /** How a change made for the user from a Planning chat is credited on the changed ticket. */
  const byRequest = (requester: Ticket) => `by the Planning chat of ${requester.id} (user request)`;
  /** How a change another ticket's run made is credited on the changed ticket. */
  const byRun = (runner: Ticket) => `by the run of ${runner.id} ("${runner.title}")`;
  /** How a change a chat on another board made for the user is credited on the changed ticket. */
  const byGuest = (g: Guest) => `by the chat of ${g.ticket.id} on ${store.getProfile(g.slug)?.name ?? g.slug} (user request)`;
  /** How a change a chat on this board made for the user, outside its own feature, is credited on the changed ticket. */
  const byChat = (t: Ticket) => `by the chat of ${t.id} ("${t.title}") (user request)`;
  /** Statuses whose move starts a Claude run: Ready (In progress queues there) and Planning (its interview). */
  const startsRun = (st?: string) => st === "ready" || st === "in_progress" || st === "planning";
  /** A run's start of another ticket's run, refused past the chain limits (Board.runStart). */
  const runStart = (slug: string, runner: Ticket): NonNullable<Ticket["startedBy"]> => {
    try {
      return board.runStart(slug, runner.id);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  };
  /** A guest's start of a run here: counted against the guest's ticket on its own board (Board.runStart). */
  const guestStart = (g: Guest): NonNullable<Ticket["startedBy"]> => ({ ...runStart(g.slug, g.ticket), slug: g.slug });
  /** The board run's ticket (RUN_HEADER), null outside runs; a run may only reach tickets on its own board. */
  const runTicket = (req: Request, slug: string): string | null => {
    const h = req.headers.get(RUN_HEADER);
    if (!h) return null;
    const [runSlug, runId] = h.split("/");
    if (runSlug !== slug || !runId) throw new HttpError(403, `tickets can only talk to tickets on their own board (${runSlug})`);
    return runId;
  };
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : undefined;
  /** Huddle teammates (agents with a session) by host ticket; huddle files are read again only once they change. */
  const teammates = new Map<string, { version: string; byHost: Map<string, { handle: string; sessionId: string }[]> }>();
  const teammatesOf = (slug: string, id: string) => {
    let hit = teammates.get(slug);
    const version = store.huddlesVersion(slug);
    if (hit?.version !== version) {
      const byHost = new Map<string, { handle: string; sessionId: string }[]>();
      for (const h of store.huddleIndex(slug)) {
        const list = byHost.get(h.hostTicket) ?? [];
        for (const p of h.participants) if (p.kind === "agent" && p.sessionId && p.sessionStarted) list.push({ handle: p.handle, sessionId: p.sessionId });
        byHost.set(h.hostTicket, list);
      }
      hit = { version, byHost };
      teammates.set(slug, hit);
    }
    return hit.byHost.get(id) ?? [];
  };
  /** Every artifact and share link of the ticket, newest first (see links.ts). */
  const ticketLinks = (slug: string, t: Ticket, session: SessionSummary | null) => collectLinks({
    ticket: session?.artifacts,
    huddles: teammatesOf(slug, t.id).map((m) => ({ handle: m.handle, artifacts: sessions.summary(m.sessionId)?.artifacts ?? [] })),
    results: store.aiComments(slug, t.id),
    shareLinks: t.shareLinks,
  });
  /** hosts: the board's open huddles by host ticket, when the caller already has them (one read per board). */
  const view = (p: Profile, t: Ticket, hosts = board.hostHuddles(p.slug)) => {
    const running = board.isRunning(p.slug, t.id);
    const session = t.sessionId ? sessions.summary(t.sessionId) : null;
    const huddle = hosts.get(t.id);
    const { attention, snoozed } = withSnooze(t, session, ticketAttention(store, p.slug, t, session, running, huddle, (x) => board.isRunning(p.slug, x)), Date.now(), huddle);
    return {
      ...t,
      running,
      /** Its run takes one of the board's maxParallel slots (Planning and peer replies don't). */
      holdsSlot: running && board.holdsSlot(p.slug, t.id),
      resumeCommand: t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? p.path, t.sessionId) : null,
      session,
      /** Artifacts and share links, newest first: the Outputs tab's Links, the header chips and the card's ↗ chip. */
      links: ticketLinks(p.slug, t, session),
      /** Absolute outputs folder, so the Share menu can show where a file is. */
      outputDir: store.outputsPath(p.slug, t.id),
      shareJobs: [...(shareJobs.get(`${p.slug}/${t.id}`)?.values() ?? [])],
      canCopyFile: canCopyFile() || !!process.env.CKANBAN_OSASCRIPT_BIN,
      /** Linked session is open in a terminal right now (board chat still works, UI warns). */
      terminalOpen: deps.terminals?.isOpen(p.slug, t.id) ?? false,
      /** The last run's error has a one-click fix (Start fresh session / Take over here). */
      recovery: running ? null : recoveryFor(t.error),
      /** Shared devices its run uses now, and the ones it waits for (devices.ts); Ticket.needs is only a hint. */
      devices: board.deviceState(p.slug, t.id),
      /** It would start now but another ticket is editing the board's folder in place (see Board.folderBusy). */
      folderWait: board.folderWait(p.slug, t),
      /** A plan child waiting on the user (never started by the plan until then). */
      userWait: t.parentId && !isComplete(t) ? userWaitReason(t, session) : null,
      attention,
      /** Snoozed from the Inbox: what it waits for and until when (attention is null meanwhile). */
      snoozed,
      /** Its own huddle is working on it: the card shows "Huddle · n working" instead of an outcome badge. */
      huddleBusy: !running && t.status !== "in_progress" && huddleBusy(huddle) && !huddleAsk(huddle),
      /** API-equivalent $ so far (the Usage tab's total: its runs and its huddles' teammates), for In Progress and Review cards. */
      costUsd: running || t.status === "in_progress" || t.status === "review" ? spend.ticket(p.slug, t.id).costUsd + huddles.ticketSpend(p.slug, t.id).costUsd : null,
      /** Spending cap its next work run gets (null: none). */
      runCap: runCapFor(t, p),
      /** A main ticket: its tool tickets working now (the card shows In progress meanwhile, wherever the user put it). */
      ...(t.main ? { familyWorking: board.familyWorking(p.slug, t.id), familyCard: board.familyCard(p.slug, t.id) } : {}),
      /** A "with you" tool ticket's main ticket: its card's "↳ feature" chip; any tool ticket's chat names it. */
      ...(t.tool ? { mainTicket: (() => {
        const m = board.mainOf(p.slug, t);
        return m ? { id: m.id, title: m.title } : null;
      })() } : {}),
    };
  };

  /** The Devices screen: each device with who uses it and who waits, by ticket title and board name. */
  const deviceViews = () => board.devices.views().map((d) => {
    const who = (u: DeviceUser) => ({ ...u, title: store.getTicket(u.slug, u.id)?.title ?? null, board: store.getProfile(u.slug)?.name ?? u.slug });
    return { ...d, using: d.using.map(who), waiting: d.waiting.map(who) };
  });

  const emitTicket = (slug: string, id: string) => {
    const t = store.getTicket(slug, id);
    if (t) bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  };

  /**
   * Publish an output file as a claude.ai page in the background (the helper takes a minute or two).
   * Markdown is rendered to a standalone page first. Publishing the same file again updates its link.
   */
  function startPublish(slug: string, id: string, name: string, file: string): ShareJob {
    const key = `${slug}/${id}`;
    const jobs = shareJobs.get(key) ?? new Map<string, ShareJob>();
    shareJobs.set(key, jobs);
    if (jobs.get(name)?.state === "publishing") throw new HttpError(409, "this file is already being published");
    const job: ShareJob = { file: name, state: "publishing", at: nowIso() };
    jobs.set(name, job);
    emitTicket(slug, id);
    const fail = (error: string) => {
      jobs.set(name, { file: name, state: "failed", error, at: nowIso() });
      emitTicket(slug, id);
    };
    (async () => {
      let tmp: string | null = null;
      try {
        const existing = store.getTicket(slug, id)?.shareLinks?.find((l) => l.file === name)?.url;
        let page = file;
        let title: string | undefined;
        if (/\.(md|markdown)$/i.test(name)) {
          const md = readFileSync(file, "utf8");
          const dir = join(store.root, "share-tmp");
          mkdirSync(dir, { recursive: true });
          tmp = page = join(dir, `${crypto.randomUUID()}.html`);
          writeFileSync(tmp, markdownPage(md, name));
          title = markdownTitle(md, name);
        } else if (!/\.html?$/i.test(name)) {
          return fail("only Markdown and HTML files can be published");
        }
        const r = await publishArtifact({ kind: "publish", file: page, ...(existing ? { url: existing } : {}), ...(title ? { title } : {}) });
        if (!r.ok) return fail(r.error);
        if (r.kind !== "publish") return fail("unexpected helper result");
        const t = store.getTicket(slug, id);
        if (!t) return;
        const links = (t.shareLinks ?? []).filter((l) => l.file !== name);
        jobs.delete(name);
        store.updateTicket(slug, id, { shareLinks: [...links, { file: name, url: r.url, at: nowIso() }] });
        emitTicket(slug, id);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      } finally {
        if (tmp) rmSync(tmp, { force: true });
      }
    })();
    return job;
  }

  async function api(req: Request, url: URL): Promise<Response | undefined> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);
    const m = req.method;
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

    // Uploads send the raw bytes: images with their image/* type, other files as application/octet-stream with
    // the original name in x-file-name. Neither is CORS-safelisted, so they preflight like JSON does.
    if (parts[0] === "attachments") {
      if (m === "POST" && parts.length === 1) {
        if (!IMAGE_TYPES[type] && type !== "application/octet-stream") throw new HttpError(415, UNSUPPORTED);
        let fileName: string | null = null;
        try {
          fileName = decodeURIComponent(req.headers.get("x-file-name") ?? "") || null;
        } catch {}
        try {
          const name = saveAttachment(store.attachmentsDir, uploadExt(type, fileName), new Uint8Array(await req.arrayBuffer()));
          return json({ url: `/api/attachments/${name}`, path: join(store.attachmentsDir, name) }, 201);
        } catch (e) {
          if (e instanceof AttachmentError) throw new HttpError(e.status, e.message);
          throw e;
        }
      }
      if (m === "GET" && parts.length === 3 && parts[2] === "info") {
        const file = attachmentFile(store.attachmentsDir, parts[1]);
        if (!file) throw new HttpError(404, "attachment not found");
        return json({ size: statSync(file).size });
      }
      if (m === "GET" && parts.length === 2) {
        const file = attachmentFile(store.attachmentsDir, parts[1]);
        if (!file) throw new HttpError(404, "attachment not found");
        // Office files and ?download=1 download, under the original name (?name=, the link text) when given.
        const shown = url.searchParams.get("name");
        const download = url.searchParams.has("download") || !opensInline(parts[1]);
        const headers: Record<string, string> = {
          "content-type": attachmentType(parts[1])!,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "private, max-age=31536000, immutable",
        };
        if (download || shown) {
          const disposition = attachmentHeader(shown ? cleanFileName(shown) : parts[1]);
          headers["content-disposition"] = download ? disposition : disposition.replace(/^attachment/, "inline");
        }
        return new Response(Bun.file(file), { headers });
      }
      throw new HttpError(404, "not found");
    }

    // Only JSON mutations: blocks HTML <form> posts (text/plain, urlencoded) that skip CORS preflight.
    if ((m === "POST" || m === "PATCH" || m === "PUT") && type !== "application/json") {
      throw new HttpError(415, "content-type must be application/json");
    }

    // Phone access (remote.ts): anyone allowed in may see it; only this Mac may turn it on or off.
    if (parts[0] === "remote" && parts.length === 1) {
      if (m === "GET") {
        const st = await remote.liveStatus();
        return json({ ...st, qrSvg: st.url ? qrSvg(st.url) : null, local: listenerOf(req) === "local" });
      }
      if (m === "POST") {
        if (listenerOf(req) !== "local") throw new HttpError(403, "phone access can only be changed on this Mac");
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't change phone access");
        const b = await body(req);
        if (typeof b?.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
        const st = b.enabled ? await remote.on() : await remote.off();
        return json({ ...st, qrSvg: st.url ? qrSvg(st.url) : null, local: true });
      }
    }

    // Shared devices (devices.ts): every board's list, who uses each one and who waits. Runs read it; only the user edits or frees.
    if (parts[0] === "devices") {
      try {
        if (parts.length === 1 && m === "GET") return json(deviceViews());
        if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes or frees devices (More, Devices); a run takes and lets go of its own with take_devices and release_devices");
        if (parts.length === 1 && m === "POST") {
          const b = (await body(req)) ?? {};
          board.devices.upsert({
            name: String(b.name ?? ""), description: b.description === undefined ? undefined : String(b.description),
            capacity: b.capacity === undefined ? undefined : Number(b.capacity),
          });
          return json(deviceViews());
        }
        const name = decodeURIComponent(parts[1] ?? "");
        if (parts.length === 2 && m === "DELETE") {
          board.devices.remove(name);
          return json(deviceViews());
        }
        if (parts.length === 3 && parts[2] === "free" && m === "POST") {
          const b = (await body(req)) ?? {};
          board.devices.free(name, String(b.profile ?? ""), String(b.id ?? ""));
          return json(deviceViews());
        }
      } catch (e) {
        if (e instanceof DeviceError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    // "Needs you" notifications (notify.ts). Runs can't read or change them: the webhook URL is the user's channel.
    if (parts[0] === "notify") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't use notification settings");
      if (parts.length === 1 && m === "GET") return json(notifier.state());
      if (parts.length === 1 && m === "POST") {
        try {
          return json(notifier.update(await body(req)));
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (parts[1] === "test" && m === "POST") {
        const b = await body(req);
        return json({ ...(await notifier.test(typeof b?.profile === "string" ? b.profile : undefined)), state: notifier.state() });
      }
    }

    // Phone push (push.ts): this device turns notifications on/off; the page's heartbeat says when its board is on screen.
    if (parts[0] === "push") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "board runs can't use notification settings");
      if (parts.length === 1 && m === "GET") return json({ publicKey: push.publicKey(), devices: push.devices(), dropped: push.dropped() });
      const b = m === "POST" ? await body(req) : null;
      const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
      if (parts[1] === "subscribe" && m === "POST") {
        try {
          // On the board's own port: a browser on this Mac (phone access comes in on the remote listener).
          const d = push.subscribe(b?.subscription, b?.label, listenerOf(req) === "local", typeof b?.replaces === "string" ? b.replaces : undefined);
          return json({ id: d.id, label: d.label, createdAt: d.createdAt });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (parts[1] === "remove" && m === "POST") {
        const key = typeof b?.id === "string" ? b.id : endpoint;
        if (!key) throw new HttpError(400, "id or endpoint is required");
        return json({ removed: push.remove(key), devices: push.devices() });
      }
      if (parts[1] === "visible" && m === "POST") {
        if (!endpoint) throw new HttpError(400, "endpoint is required");
        push.setVisible(endpoint, b?.visible === true);
        if (listenerOf(req) === "local") push.markThisMac(endpoint);
        return json({ ok: true });
      }
      if (parts[1] === "test" && m === "POST") {
        if (typeof b?.id !== "string") throw new HttpError(400, "id is required");
        return json(await notifier.testDevice(b.id, typeof b?.profile === "string" ? b.profile : undefined));
      }
    }

    if (parts[0] === "health" && m === "GET") {
      const [claude, git, gh] = await Promise.all([
        process.env.CKANBAN_CLAUDE_BIN ? which(process.env.CKANBAN_CLAUDE_BIN) : findClaude(), which("git"), which("gh"),
      ]);
      return json({ claude, git, gh, pty: ptySupported() });
    }

    // A CPU profile of this daemon for N seconds (to find what holds the board up): this Mac's own address only.
    if (parts[0] === "debug" && parts[1] === "profile" && m === "POST") {
      const host = req.headers.get("host") ?? "";
      if (req.headers.get(RUN_HEADER) || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) || host.endsWith(`:${deps.remotePort}`)) {
        throw new HttpError(403, "profiles are taken from this Mac only");
      }
      return json(await profileFor(Number(url.searchParams.get("seconds")) || 15, join(store.root, "debug")));
    }

    if (parts[0] === "events" && m === "GET") return sse(req);
    if (parts[0] === "version" && m === "GET") return json(await updates.status());
    if (parts[0] === "usage" && m === "GET") return json(await usage.get(0));
    // What every board spent today (tickets' runs and huddle agents), for the header pill.
    if (parts[0] === "spend" && m === "GET") return json(spend.today());
    // How every teammate (huddle preset) and template was used, from the huddles on every board.
    if (parts[0] === "team-usage" && m === "GET") return json(huddles.usage());
    if (parts[0] === "inbox" && m === "GET") {
      // Every board: tickets that need the user (the same rule as the cards' "Your turn"), oldest first.
      // Right after a start with no saved summaries, wait for the sliced read instead of reading every transcript now.
      await sessions.ready();
      const out = [];
      for (const p of store.listProfiles()) {
        const hosts = board.hostHuddles(p.slug);
        for (const t of store.listTickets(p.slug)) {
          const v = view(p, t, hosts);
          const base = { profile: p.slug, profileName: p.name, id: t.id, title: t.title };
          if (v.attention) out.push({ ...base, attention: v.attention });
          else if (v.snoozed) out.push({ ...base, attention: v.snoozed.attention, snoozedUntil: v.snoozed.until });
        }
      }
      return json(out.sort(byWaitingAge));
    }

    if (parts[0] === "tickets" && parts.length === 1 && m === "GET") {
      // ⌘K command bar: a light row per ticket on every board (search runs in the browser). Long texts are
      // capped: the bar only needs enough to find a word and show a snippet around it.
      const cap = (s: string | null) => (s && s.length > 4000 ? s.slice(0, 4000) : s ?? "");
      const out = [];
      for (const p of store.listProfiles()) {
        for (const t of store.listTickets(p.slug)) {
          out.push({
            profile: p.slug, profileName: p.name, id: t.id, title: t.title, status: t.status,
            running: board.isRunning(p.slug, t.id), updatedAt: t.updatedAt,
            body: cap(t.body), summary: cap(store.lastAiComment(p.slug, t.id)), prUrl: t.prUrl,
            ...(hiddenTool(t) ? { mainTicket: (() => {
              const main = board.mainOf(p.slug, t) ?? familyRoot(store.listTickets(p.slug), t.id);
              return main && main.id !== t.id ? { id: main.id, title: main.title } : null;
            })() } : {}),
          });
        }
      }
      return json(out);
    }

    // Connections panel: Claude Code MCP servers (always from the home dir, user scope for edits).
    if (parts[0] === "mcp") {
      const name = parts[1];
      if (parts.length === 1 && m === "GET") return json(mcp.state());
      if (parts.length === 1 && m === "POST") {
        await mcp.add(await body(req));
        return json(mcp.state(), 201);
      }
      if (parts.length === 2 && name === "refresh" && m === "POST") {
        mcp.refresh();
        return json(mcp.state(), 202);
      }
      if (parts.length === 2 && m === "DELETE") {
        await mcp.remove(name, url.searchParams.get("board") ?? undefined);
        return json(mcp.state());
      }
      // Move between "All projects" and "Only this board": { to: "board" | "all", board: <slug> }.
      if (parts.length === 3 && m === "POST" && parts[2] === "move") {
        const b = (await body(req)) ?? {};
        const board = String(b.board ?? "");
        if (b.to === "board") await mcp.moveToBoard(name, board);
        else if (b.to === "all") await mcp.moveToUser(name, board);
        else throw new HttpError(400, "to must be board or all");
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "retry-move") {
        await mcp.retryMove(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "login") {
        mcp.login(name);
        return json(mcp.state(), 202);
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "login-paste") {
        mcp.paste(name, String((await body(req))?.text ?? ""));
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "cancel-login") {
        mcp.cancelLogin(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "logout") {
        await mcp.logout(name);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "POST" && parts[2] === "recheck") {
        const s = await mcp.recheck(name);
        if (!s) throw new HttpError(502, `couldn't check ${name}; try Refresh`);
        return json(mcp.state());
      }
      if (parts.length === 3 && m === "GET" && parts[2] === "config") return json(mcp.config(name, url.searchParams.get("board") ?? undefined));
      if (parts.length === 2 && m === "PUT") {
        await mcp.update(name, await body(req));
        return json(mcp.state());
      }
      throw new HttpError(404, "not found");
    }

    // Connections panel: is `ckanban mcp` registered with Claude Code / Codex, and (un)register it.
    if (parts[0] === "agents") {
      if (parts.length === 1 && m === "GET") return json(await agents.status());
      const id = parts[1] as AgentId;
      if (parts.length === 3 && m === "POST" && AGENT_IDS.includes(id) && (parts[2] === "install" || parts[2] === "uninstall")) {
        await (parts[2] === "install" ? agents.install(id) : agents.uninstall(id));
        if (id === "claude") mcp.refresh();
        return json(await agents.status());
      }
      throw new HttpError(404, "not found");
    }

    // Prompt snippets: GET ?profile=<slug> returns global ones plus that board's.
    if (parts[0] === "snippets") {
      if (parts.length === 1 && m === "GET") return json(snippets.list(url.searchParams.get("profile") ?? undefined));
      if (parts.length === 1 && m === "POST") return json(snippets.create((await body(req)) ?? {}), 201);
      if (parts.length === 2 && m === "PATCH") return json(snippets.update(parts[1], (await body(req)) ?? {}));
      if (parts.length === 2 && m === "DELETE") {
        snippets.remove(parts[1]);
        return new Response(null, { status: 204 });
      }
      throw new HttpError(404, "not found");
    }

    // Schedule form preview: is the expression valid, what it means, when it fires next.
    if (parts[0] === "cron" && parts[1] === "preview" && parts.length === 2 && m === "GET") {
      const expr = (url.searchParams.get("expr") ?? "").trim();
      const error = expr ? cronError(expr) : "cron expression is required";
      if (error) return json({ valid: false, error, summary: null, next: [] });
      return json({ valid: true, error: null, summary: describeCron(expr), next: nextRuns(parseCron(expr), new Date(), 3).map((d) => d.toISOString()) });
    }

    if (parts[0] === "claude" && parts[1] === "projects" && m === "GET") {
      const taken = new Set(store.listProfiles().map((p) => p.path));
      return json(listClaudeProjects().map((p) => ({ ...p, hasProfile: taken.has(p.path) })));
    }
    if (parts[0] === "claude" && parts[1] === "defaults" && m === "GET") return json(claudeDefaults());
    if (parts[0] === "pick-folder" && m === "POST") return json({ path: await pickFolder() });
    // A folder's version history, for the "Turn on version history" offer (New board, board settings).
    if (parts[0] === "version-history" && parts.length === 1) {
      const path = m === "GET" ? url.searchParams.get("path") ?? "" : String((await body(req))?.path ?? "");
      if (!path.trim() || !isAbsolute(path)) throw new HttpError(400, "an absolute folder path is required");
      const git = await which("git");
      if (m === "GET") return json({ git, repo: git && existsSync(path) ? await repoKind(path) : null });
      if (m === "POST") {
        if (!git) throw new HttpError(400, "git isn't installed on this computer");
        if (!existsSync(path)) throw new HttpError(404, `folder does not exist: ${path}`);
        // A ticket editing the folder in place right now would leave half-done files in the first snapshot.
        const busy = store.listProfiles().filter((p) => p.path === path)
          .flatMap((p) => store.listTickets(p.slug).filter((t) => board.isRunning(p.slug, t.id) && board.runsInFolder(p.slug, t) !== false));
        if (busy.length) throw new HttpError(409, `Wait until "${busy[0].title}" finishes: Claude is changing files in this folder right now.`);
        let r;
        try {
          r = await enableVersionHistory(path);
        } catch (e) {
          throw new HttpError(500, `Couldn't turn on version history: ${(e as Error).message}`);
        }
        const repo = await repoKind(path);
        // Boards on this folder: their next ticket gets a worktree of its own.
        for (const p of store.listProfiles()) if (p.path === path) board.noteRepo(p.slug, repo);
        return json({ ...r, repo });
      }
    }
    if (parts[0] === "awake" && parts.length === 1 && m === "GET") return json({ held: deps.awake?.() ?? false });
    if (parts[0] === "restart" && parts.length === 1) {
      if (m === "GET") return json(board.restartState());
      if (m === "POST") {
        if (!deps.restart) throw new HttpError(501, "restart is only available on the daemon");
        return json(deps.restart());
      }
    }

    // Report bug: context preview, then file a GitHub issue on the ckanban repo.
    if (parts[0] === "bug-report" && m === "POST" && parts.length <= 2) {
      const b = await body(req);
      const ref = b.ticketId ? { slug: String(b.profile ?? ""), id: String(b.ticketId) } : null;
      try {
        const draft = draftReport(store, ref);
        if (parts[1] === "draft") return json(draft);
        if (parts.length !== 1) throw new HttpError(404, "not found");
        const source: BugSource = b.source === "ai" || b.source === "cli" ? b.source : "ui";
        const include = Array.isArray(b.include) ? (b.include.map(String) as BugBlockId[]) : undefined;
        const r = await submitReport(
          { title: String(b.title ?? ""), description: String(b.description ?? ""), blocks: draft.blocks, include, source },
          { dataRoot: store.root, gh: deps.gh },
        );
        return json(r, r.url ? 201 : 200);
      } catch (e) {
        if (e instanceof BugReportError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }

    // /passes — the board's own passes: how automations reach a service without Claude (shared by all boards).
    // Connections shows them next to Claude's servers.
    if (parts[0] === "passes") {
      if (parts.length === 1 && m === "GET") {
        const all = passes.list();
        const used = new Map<string, number>();
        for (const p of store.listProfiles()) for (const l of store.listLoops(p.slug)) for (const id of l.passes ?? []) used.set(id, (used.get(id) ?? 0) + 1);
        return json({ passes: all.map((p) => ({ ...passes.view(p), usedBy: used.get(p.id) ?? 0 })), automations: loops.count() });
      }
      if (parts.length === 1 && m === "POST") {
        await userOnly(req, "Connecting a service for automations");
        return json(passes.view(await passes.add((await body(req)) ?? {})), 201);
      }
      // The service sends the user's browser here after they approve the board. Only on this Mac, and only with a
      // state that authorize made (so a page that makes the browser open this URL can't connect a stranger's account).
      if (parts[1] === "oauth" && parts[2] === "callback" && m === "GET") {
        if (listenerOf(req) !== "local") throw new HttpError(403, "sign in from the computer ckanban runs on");
        const page = (title: string, text: string, status = 200) => new Response(
          `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem"><h2>${title}</h2><p>${text}</p>`,
          { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        const esc = (x: string) => x.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        const denied = url.searchParams.get("error");
        if (denied) return page("Not connected", esc(url.searchParams.get("error_description") ?? denied), 400);
        try {
          const p = await passes.complete(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
          return page("Connected", `${esc(p.name)} is connected for automations. You can close this tab and go back to the board.`);
        } catch (e) {
          if (e instanceof PassError) return page("Not connected", esc(e.message), e.status);
          throw e;
        }
      }
      const pid = parts[1];
      if (parts.length === 3 && parts[2] === "tools" && m === "GET") return json(await passes.tools(pid).catch((e) => {
        throw e instanceof PassError ? e : new HttpError(502, passes.mask((e as Error).message));
      }));
      await userOnly(req, "Changing a service's connection for automations");
      if (parts.length === 2 && m === "PATCH") return json(passes.view(passes.replaceKey(pid, (await body(req))?.secret)));
      if (parts.length === 2 && m === "DELETE") {
        passes.remove(pid);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 3 && parts[2] === "authorize" && m === "POST") return json({ url: await passes.authorizeUrl(pid) });
      throw new HttpError(404, "not found");
    }

    // POST /automation-call — `ckanban call` from a check script: the token its check got says what it may call.
    if (parts[0] === "automation-call" && parts.length === 1 && m === "POST") {
      const b = (await body(req)) ?? {};
      return json({ result: await loops.call(String(b.token ?? ""), String(b.service ?? ""), String(b.tool ?? ""), b.args) });
    }

    if (parts[0] !== "profiles") throw new HttpError(404, "not found");

    // /profiles
    if (parts.length === 1) {
      if (m === "GET") {
        return json(store.listProfiles().map((p) => ({ ...p, pathExists: existsSync(p.path), running: board.running(p.slug) })));
      }
      if (m === "POST") {
        const b = await body(req);
        const name = String(b.name ?? "").trim();
        const path = String(b.path ?? "").trim().replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
        if (!name) throw new HttpError(400, "name is required");
        if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `path is not a directory: ${path}`);
        if (b.effort && !validEffort(String(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
        refuseSharedFolder(store.listProfiles(), path);
        let slug = slugify(name);
        for (let i = 2; store.getProfile(slug); i++) slug = `${slugify(name)}-${i}`;
        const profile: Profile = {
          name, slug, path,
          // Empty when there is nothing to branch from yet (not a repo, or no commits); runs re-detect it.
          baseBranch: b.baseBranch || ((await isGitRepo(path)) ? (await resolveBaseBranch(path, await detectBaseBranch(path))) ?? "" : ""),
          maxParallel: Math.max(1, Number(b.maxParallel) || DEFAULT_MAX_PARALLEL),
          model: b.model || null,
          ...(b.effort ? { effort: String(b.effort) } : {}),
          ...(b.ultracode === true ? { ultracode: true } : {}),
          createdAt: nowIso(),
          ...(b.workspace !== undefined ? { workspace: workspaceValue(b.workspace) } : {}),
        };
        const saved = applyDetection(profile, await detectSetup(path));
        store.saveProfile(saved);
        bus.emit({ type: "profile.updated", slug, profile: saved });
        return json(saved, 201);
      }
    }

    const slug = parts[1];
    const profile = profileOr404(slug);

    // /profiles/:p
    if (parts.length === 2) {
      if (m === "GET") return json(profile);
      if (m === "PATCH") {
        const b = await body(req);
        const next: Profile = { ...profile };
        if (b.name !== undefined) next.name = String(b.name);
        if (b.path !== undefined) next.path = String(b.path);
        if (b.baseBranch !== undefined) next.baseBranch = String(b.baseBranch);
        if (b.maxParallel !== undefined) next.maxParallel = Math.max(1, Number(b.maxParallel) || 1);
        if (b.model !== undefined) next.model = b.model || null;
        if (b.mainModel !== undefined) {
          if (b.mainModel && !(typeof b.mainModel === "string" && validModel(b.mainModel))) throw new HttpError(400, `"${b.mainModel}" is not a model name. Use ${MODEL_HELP}.`);
          next.mainModel = b.mainModel || null;
        }
        if (b.freshChatTokens !== undefined) {
          const v = b.freshChatTokens;
          if (v !== null && (typeof v !== "number" || !(v > 0) || v > 10_000_000)) throw new HttpError(400, "freshChatTokens must be a positive number, or null for the default");
          next.freshChatTokens = v === null ? null : Math.round(v);
        }
        if (b.checkinOfferDismissed !== undefined) next.checkinOfferDismissed = b.checkinOfferDismissed === true;
        if (b.effort !== undefined) {
          if (b.effort && !validEffort(String(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
          next.effort = b.effort || null;
        }
        if (b.ultracode !== undefined) {
          if (typeof b.ultracode !== "boolean") throw new HttpError(400, "ultracode must be true or false");
          next.ultracode = b.ultracode;
          // The first version saved ultracode as the effort level: switching it separately keeps that level (xhigh).
          if (next.effort === "ultracode") next.effort = "xhigh";
        }
        if (b.copyFiles !== undefined) {
          if (!Array.isArray(b.copyFiles)) throw new HttpError(400, "copyFiles must be a list of paths");
          next.copyFiles = [...new Set(b.copyFiles.map((f: unknown) => String(f).trim()).filter(Boolean))] as string[];
        }
        if (b.setupCommand !== undefined) next.setupCommand = String(b.setupCommand ?? "").trim();
        if (b.cleanupCommand !== undefined) next.cleanupCommand = String(b.cleanupCommand ?? "").trim();
        if (b.autoHuddles !== undefined) next.autoHuddles = !!b.autoHuddles;
        if (b.keepAwake !== undefined) next.keepAwake = !!b.keepAwake;
        if (b.runCapUsd !== undefined) {
          if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can change the board's spending cap");
          next.runCapUsd = capValue(b.runCapUsd, true) || null;
        }
        if (b.artifacts !== undefined) next.artifacts = !!b.artifacts;
        if (b.workspace !== undefined) next.workspace = workspaceValue(b.workspace);
        if (b.claudeAiConnectors !== undefined) {
          const v = parseConnectorSetting(b.claudeAiConnectors);
          if (v === null) throw new HttpError(400, 'claudeAiConnectors must be "all", "none" or a list of connector names');
          next.claudeAiConnectors = v;
        }
        if (b.stallMinutes !== undefined) {
          const n = b.stallMinutes;
          if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 1440) throw new HttpError(400, "stallMinutes must be a whole number of minutes from 0 (off) to 1440");
          next.stallMinutes = n;
        }
        if (b.setupDetected !== undefined) next.setupDetected = b.setupDetected && typeof b.setupDetected === "object" ? b.setupDetected : null;
        if (next.path !== profile.path && realFolder(next.path) !== realFolder(profile.path)) {
          refuseSharedFolder(store.listProfiles().filter((p) => p.slug !== slug), next.path);
        }
        if (next.path !== profile.path) shells.kill(slug);
        store.saveProfile(next);
        bus.emit({ type: "profile.updated", slug, profile: next });
        board.dispatch(slug);
        return json(next);
      }
      if (m === "DELETE") {
        if (board.running(slug) > 0) throw new HttpError(409, "board has running tickets");
        store.deleteProfile(slug);
        snippets.dropScope(slug);
        shells.kill(slug);
        bus.emit({ type: "profile.updated", slug, profile: null });
        return new Response(null, { status: 204 });
      }
    }

    // /profiles/:p/detect-setup — what worktree setup detection finds now (the settings dialog decides what to save)
    if (parts[2] === "detect-setup" && parts.length === 3 && m === "POST") return json(await detectSetup(profile.path));

    // /profiles/:p/commands — skills and commands in the profile folder (the `/` picker of new ticket and schedule descriptions)
    if (parts[2] === "commands" && parts.length === 3 && m === "GET") {
      return json(listCommands(profile.path, { projects: [profile.path] }).map(({ local, ...c }) => c));
    }

    // /profiles/:p/sessions — Claude Code sessions started in the profile folder
    if (parts[2] === "sessions" && parts.length === 3 && m === "GET") {
      const commands = await processCommands();
      const linked = new Map(store.listTickets(slug).filter((t) => t.sessionId).map((t) => [t.sessionId!, t]));
      return json(listSessions(profile.path).map((s) => ({
        ...s,
        live: liveSessionMatch(commands, s),
        ticket: linked.has(s.id) ? { id: linked.get(s.id)!.id, title: linked.get(s.id)!.title } : null,
      })));
    }

    // /profiles/:p/files?path= (one directory level) and /profiles/:p/file?path= (read-only contents)
    if ((parts[2] === "files" || parts[2] === "file") && parts.length === 3 && m === "GET") {
      const rel = url.searchParams.get("path") ?? "";
      try {
        if (parts[2] === "files") return json({ path: rel, entries: await listDir(profile.path, rel) });
        return json(readFileForView(profile.path, rel));
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // /profiles/:p/open-file { path } — open a file from the explorer in its default app
    if (parts[2] === "open-file" && parts.length === 3 && m === "POST") {
      const rel = String((await body(req)).path ?? "");
      try {
        openWithSystem(profile.path, rel, process.env.CKANBAN_OPEN_BIN);
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return json({ ok: true });
    }

    // /profiles/:p/shell — WebSocket to the profile's interactive shell
    if (parts[2] === "shell" && parts.length === 3 && m === "GET") {
      if (!ptySupported()) throw new HttpError(501, `terminal needs Bun 1.3.5 or newer (running ${Bun.version})`);
      if (!isAllowedSocket(req, server.port ?? deps.port, remote.active(), listenerOf(req))) throw new HttpError(403, "forbidden");
      const dim = (k: string, d: number) => Math.min(1000, Math.max(1, Number(url.searchParams.get(k)) || d));
      const data: ShellSocket = { slug, cwd: profile.path, cols: dim("cols", 80), rows: dim("rows", 24) };
      if ((via.get(req)?.srv ?? server).upgrade(req, { data })) return undefined;
      throw new HttpError(400, "expected a WebSocket upgrade");
    }

    // /profiles/:p/chats — quick chats with Claude in the board's folder, no ticket (the Ask tab, the Claude panel)
    if (parts[2] === "chats") {
      // Only the user's browser: a board run, huddle agent or other program can't start Claude runs here (no runs starting runs).
      const userAsks = () => userOnly(req, "Quick chats");
      if (parts.length === 3 && m === "GET") return json(quickChats.list(slug).map((c) => quickChats.view(slug, c)));
      // A new chat starts with its first message.
      if (parts.length === 3 && m === "POST") {
        await userAsks();
        return json(quickChats.send(slug, null, String((await body(req))?.text ?? "")), 201);
      }
      const cid = parts[3];
      const chat = quickChats.get(slug, cid);
      if (!chat) throw new HttpError(404, "chat not found");
      if (parts.length === 4 && m === "GET") return json(quickChats.view(slug, chat));
      if (parts.length === 4 && m === "PATCH") {
        await userAsks();
        const b = (await body(req)) ?? {};
        return json(quickChats.rename(slug, cid, typeof b.title === "string" ? b.title : null));
      }
      if (parts.length === 4 && m === "DELETE") {
        await userAsks();
        await quickChats.remove(slug, cid);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 5 && parts[4] === "messages" && m === "POST") {
        await userAsks();
        return json(quickChats.send(slug, cid, String((await body(req))?.text ?? "")));
      }
      if (parts.length === 5 && parts[4] === "stop" && m === "POST") {
        await userAsks();
        quickChats.stop(slug, cid);
        return json(quickChats.view(slug, quickChats.get(slug, cid) ?? chat));
      }
      if (parts.length === 5 && parts[4] === "ticket" && m === "POST") {
        await userAsks();
        const b = (await body(req).catch(() => null)) ?? {};
        if (b.partOf !== undefined && b.partOf !== null && (typeof b.partOf !== "string" || !b.partOf)) throw new HttpError(400, "partOf must be a ticket id");
        const partOf = typeof b.partOf === "string" ? b.partOf : undefined;
        if (partOf && !store.getTicket(slug, partOf)) throw new HttpError(400, `ticket ${partOf} not found (partOf)`);
        const r = await quickChats.makeTicket(slug, cid, partOf);
        if (!partOf) suggestParent(slug, r.ticket.id);
        return json({ ticket: view(profile, store.getTicket(slug, r.ticket.id) ?? r.ticket), chat: r.chat }, 201);
      }
      // The conversation, newest last, paged like a ticket's (see the ticket conversation route).
      if (parts.length === 5 && parts[4] === "conversation" && m === "GET") {
        const parsed = sessions.get(chat.sessionId);
        const all = parsed?.entries ?? [];
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
        const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
        const end = Math.max(0, Math.min(all.length, before));
        const start = Math.max(0, end - limit);
        const active = quickChats.isRunning(slug, cid);
        const entries = all.slice(start, end).map((e) => {
          if (e.workflow) {
            const { script: _script, scriptPath: _path, ...workflow } = settleWorkflow(e.workflow, active);
            return { ...e, workflow };
          }
          if (!e.agent) return e;
          const agent = settleAgent(e.agent, active);
          return { ...e, agent: { ...agent, steps: agent.steps.slice(-AGENT_STEP_TAIL) } };
        });
        return json({ entries, start, total: all.length });
      }
      // "Say it simpler" for the chat's replies, like a ticket's (see the ticket simplify routes).
      if (parts.length === 5 && parts[4] === "simplified" && m === "GET") {
        return json(simplifier.savedIn(quickChats.simplifiedPath(slug, cid), sessions.get(chat.sessionId)?.entries ?? []));
      }
      if (parts.length === 5 && parts[4] === "simplify" && m === "POST") {
        await userAsks();
        const b = await body(req);
        const e = typeof b?.uuid === "string" ? sessions.get(chat.sessionId)?.entries.find((x) => x.uuid === b.uuid) : null;
        if (!e) throw new HttpError(404, "no such message in this chat");
        try {
          return json(await simplifier.simplifyIn({ file: quickChats.simplifiedPath(slug, cid), spend: quickChats.sideSpendPath(slug, cid) }, quickChats.view(slug, chat).title, e));
        } catch (err) {
          if (err instanceof SimplifyError) throw new HttpError(err.status, err.message);
          throw err;
        }
      }
      if (parts.length === 6 && parts[4] === "tool" && m === "GET") {
        const d = sessions.toolDetail(chat.sessionId, parts[5]);
        if (!d) throw new HttpError(404, "tool call not found");
        return json(d);
      }
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/schedules — recurring ticket templates
    if (parts[2] === "schedules") {
      // Set by the ckanban MCP tools inside a board run ("<profile>/<ticket id>"): the edit is credited to that ticket.
      const run = req.headers.get(RUN_HEADER)?.split("/")[1] ?? "";
      const by: ScheduleEditor = /^t_[a-z0-9_]+$/i.test(run) ? { ticketId: run } : "user";
      // The list also shows each schedule's spend over 7 days and its quiet checks per day (quiet.ts).
      const view7 = (s: Schedule) => {
        const h = store.readScheduleHistory(slug, s.id);
        const costOf = (tid: string) => (store.getTicket(slug, tid) ? spend.ticket(slug, tid).costUsd : 0);
        return { ...scheduler.view(slug, s), spend7dUsd: scheduleSpend(h, new Date(Date.now() - 7 * 86_400_000), costOf), quietPerDay: quietPerDay(h).slice(0, 7) };
      };
      if (parts.length === 3 && m === "GET") return json(store.listSchedules(slug).map(view7));
      if (parts.length === 3 && m === "POST") return json(scheduler.view(slug, scheduler.create(slug, (await body(req)) ?? {}, by)), 201);
      const sid = parts[3];
      if (parts.length === 4 && m === "PATCH") return json(scheduler.view(slug, scheduler.update(slug, sid, (await body(req)) ?? {}, by)));
      if (parts.length === 4 && m === "DELETE") {
        scheduler.remove(slug, sid, by);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 5 && parts[4] === "history" && m === "GET") return json(scheduler.history(slug, sid));
      if (parts.length === 5 && parts[4] === "run" && m === "POST") {
        const entry = await scheduler.runNow(slug, sid);
        return json({ entry, schedule: scheduler.view(slug, scheduler.get(slug, sid)) });
      }
      throw new HttpError(404, "not found");
    }

    // POST /profiles/:p/find-links — Find links: Claude suggests parents for tickets without one. Nothing changes here;
    // the user's Link selected sets each one (PATCH partOf).
    if (parts[2] === "find-links" && parts.length === 3 && m === "POST") {
      await userOnly(req, "Finding links");
      try {
        return json(await linker.find(slug));
      } catch (e) {
        throw new HttpError(502, `Couldn't find links: ${(e as Error).message}`);
      }
    }

    // POST /profiles/:p/automation-setup — Automations → Set up with Claude: a Planning ticket whose chat sets one up.
    if (parts[2] === "automation-setup" && parts.length === 3 && m === "POST") {
      await userOnly(req, "Setting up an automation");
      const t = await board.createTicket(slug, {
        title: "Set up an automation", status: "planning",
        body: "Set up an automation for this board with Claude: say what to watch (for example \"new Linear issues assigned to me\") and how often to check.",
      });
      store.updateTicket(slug, t.id, { automationSetup: true });
      emitTicket(slug, t.id);
      return json(view(profileOr404(slug), store.getTicket(slug, t.id)!), 201);
    }

    // POST /profiles/:p/checkin-setup — Schedules → Proactive check-ins: a Planning ticket whose chat sets up a quiet
    // check-in schedule (checkin-guides.ts). Nothing runs or costs anything until that chat creates the schedule.
    if (parts[2] === "checkin-setup" && parts.length === 3 && m === "POST") {
      await userOnly(req, "Setting up check-ins");
      const t = await board.createTicket(slug, {
        title: "Set up proactive check-ins", status: "planning",
        body: "Set up proactive check-ins with Claude: every work hour, Claude checks what needs you (messages, reviews, meetings coming up) and raises only that in Review. Pick what to check, your hours and what counts as urgent.",
      });
      store.updateTicket(slug, t.id, { checkinSetup: true });
      emitTicket(slug, t.id);
      return json(view(profileOr404(slug), store.getTicket(slug, t.id)!), 201);
    }

    // /profiles/:p/chat/search and /chat/read: search_chat and read_chat, earlier messages of a ticket's chat (chat-search.ts).
    // A run reads its own ticket's chat; a main ticket also its tool tickets'. Huddle helpers don't.
    if (parts[2] === "chat" && parts.length === 4 && m === "GET") {
      if (parts[3] === "search") {
        const id = url.searchParams.get("ticket") || ownRun(req, slug);
        if (!id) throw new HttpError(400, "say which ticket's chat to search (ticket)");
        const t = ticketOr404(slug, id);
        chatReach(req, slug, t);
        const tools = url.searchParams.get("tools") === "1";
        const q = url.searchParams.get("q") ?? "";
        try {
          return json({ text: matchesText(t.id, q, searchChat(chatSources(t, tools), q, { includeTools: tools }), tools) });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (parts[3] === "read") {
        const ref = parseRef(url.searchParams.get("ref") ?? "");
        if (!ref) throw new HttpError(400, "ref must look like <sessionId>:<message number>, as search_chat gives it");
        const t = store.listTickets(slug).find((x) => x.sessionId === ref.sessionId || x.earlierSessions?.some((s) => s.sessionId === ref.sessionId));
        if (!t) throw new HttpError(404, `no ticket on this board has the chat ${ref.sessionId}`);
        chatReach(req, slug, t);
        const src = chatSources(t, true).find((s) => s.sessionId === ref.sessionId);
        if (!src) throw new HttpError(404, `the chat ${ref.sessionId} can't be read any more (its transcript is gone)`);
        const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
        try {
          return json({ text: readText(t.id, readChat(src, ref.index, { before: num("before"), after: num("after") })) });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      }
    }

    // /profiles/:p/loops — automations: a check script on a timer turns new items into tickets. Anyone lists and
    // test-runs a script (the setup chat does); only the user saves, changes or runs one for real.
    if (parts[2] === "loops") {
      if (parts.length === 3 && m === "GET") return json(loops.list(slug));
      if (parts.length === 4 && parts[3] === "test" && m === "POST") return json(await loops.test(slug, (await body(req)) ?? {}));
      await userOnly(req, "Saving or changing an automation");
      if (parts.length === 3 && m === "POST") {
        const l = await loops.create(slug, (await body(req)) ?? {});
        // Its first check notes what is there already (no tickets) and fills "Last check found".
        void loops.checkNow(slug, l.id).catch(() => {});
        return json(l, 201);
      }
      const lid = parts[3];
      if (parts.length === 4 && m === "PATCH") {
        const b = (await body(req)) ?? {};
        const l = await loops.update(slug, lid, b);
        // A new script or switching it on starts with a check that notes what is there (see create).
        if (l.enabled && l.state === "ok" && (b.script !== undefined || b.enabled === true)) void loops.checkNow(slug, l.id).catch(() => {});
        return json(l);
      }
      if (parts.length === 4 && m === "DELETE") {
        await loops.remove(slug, lid);
        return new Response(null, { status: 204 });
      }
      if (parts.length === 5 && parts[4] === "check" && m === "POST") return json(await loops.checkNow(slug, lid));
      if (parts.length === 5 && parts[4] === "copy" && m === "POST") return json(await loops.copy(slug, lid, String((await body(req))?.to ?? "")), 201);
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/jobs — one-time jobs (jobs.ts). Anyone lists; a board run (RUN_HEADER) schedules jobs as its
    // ticket and may change, run or cancel only the jobs it scheduled.
    if (parts[2] === "jobs") {
      if (parts.length === 3 && m === "GET") {
        // finishedDays (the board UI): every job finished in that many days, not just the last 20.
        const days = Number(url.searchParams.get("finishedDays"));
        const finishedDays = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : undefined;
        return json(jobs.list(slug, url.searchParams.get("ticketId"), finishedDays).map((j) => jobs.view(j)));
      }
      if (parts.length === 4 && m === "GET") return json(jobs.view(jobs.get(slug, parts[3])));
      // Huddle teammates run as their host ticket but only review: jobs run in the board folder.
      if (req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "huddle participants can't schedule or change jobs; ask @main");
      const by = runTicket(req, slug);
      if (by && !store.getTicket(slug, by)) throw new HttpError(404, `ticket ${by} not found`);
      if (parts.length === 3 && m === "POST") return json(jobs.view(jobs.create(slug, (await body(req)) ?? {}, by)), 201);
      const jid = parts[3];
      if (parts.length === 4 && m === "PATCH") return json(jobs.view(await jobs.update(slug, jid, (await body(req)) ?? {}, by)));
      if (parts.length === 5 && m === "POST") {
        if (parts[4] === "cancel") return json(jobs.view(await jobs.cancel(slug, jid, by)));
        if (parts[4] === "run") return json(jobs.view(await jobs.runNow(slug, jid, by)));
      }
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddle-presets[/:name] — huddle role presets ("teammates"): built-ins merged with the global ones and
    // the board's own. Anyone reads; only the user saves or deletes (the Team tab, a proposal card, the CLI). A run (a
    // huddle agent's or a ticket's, the coordinator included) proposes one with propose_teammate instead. Body `scope`:
    // "board" (default) or "global" (every board); DELETE ?scope= defaults to the level in effect.
    if (parts[2] === "huddle-presets") {
      if (parts.length === 3 && m === "GET") return json(huddles.presets(slug));
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) {
        throw new HttpError(403, m === "DELETE"
          ? "a board or huddle run can't delete or reset teammates; ask the user"
          : "a board or huddle run can't save teammates; propose one with propose_teammate and the user saves it with one click");
      }
      if (parts.length === 3 && m === "POST") {
        const b = await body(req);
        return json(huddles.savePreset(slug, b, b?.scope ?? "board"), 201);
      }
      if (parts.length === 4 && m === "PUT") {
        const b = await body(req);
        return json(huddles.savePreset(slug, { ...b, name: parts[3] }, b?.scope ?? "board"));
      }
      if (parts.length === 4 && m === "DELETE") return json(huddles.deletePreset(slug, parts[3], url.searchParams.get("scope") ?? undefined));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddle-templates[/:name] — whole-huddle templates (roster and rules), levels as for presets. Anyone
    // reads; only the user changes them.
    if (parts[2] === "huddle-templates") {
      if (parts.length === 3 && m === "GET") return json(huddles.templates(slug));
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes huddle templates (the Team tab)");
      if (parts.length === 3 && m === "POST") {
        const b = await body(req);
        return json(huddles.saveTemplate(slug, b, b?.scope ?? "board"), 201);
      }
      if (parts.length === 4 && m === "PUT") {
        const b = await body(req);
        return json(huddles.saveTemplate(slug, { ...b, name: parts[3] }, b?.scope ?? "board"));
      }
      if (parts.length === 4 && m === "DELETE") return json(huddles.deleteTemplate(slug, parts[3], url.searchParams.get("scope") ?? undefined));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/learned — what the board learned on its own (learner.ts). Anyone reads; only the user undoes,
    // saves or drops, so no run or agent can change what future runs are told.
    if (parts[2] === "learned") {
      if (parts.length === 3 && m === "GET") return json(learner.view(slug));
      if (m !== "POST") throw new HttpError(404, "not found");
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes what the board learned (Team, Learned)");
      try {
        if (parts.length === 4 && parts[3] === "seen") {
          await learner.markSeen(slug);
          return json(learner.view(slug));
        }
        const [, , , what, id, act] = parts;
        if (parts.length === 6 && what === "changes" && (act === "undo" || act === "redo")) return json(await learner.undo(id, act === "redo"));
        if (parts.length === 6 && what === "lessons" && act === "save") return json(await learner.saveNow(id));
        if (parts.length === 6 && what === "lessons" && (act === "drop" || act === "keep")) return json(await learner.drop(id, act === "keep"));
      } catch (err) {
        if (err instanceof LearnError) throw new HttpError(err.status, err.message);
        throw err;
      }
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddle-notes[/:role/:scope] — role notes from past huddles (huddle-notes.ts). Anyone reads; only the
    // user writes them, so no agent can change what future agents are told.
    if (parts[2] === "huddle-notes") {
      if (parts.length === 3 && m === "GET") return json({ notes: huddles.notes(slug), cap: NOTES_CAP });
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user changes huddle role notes (the Team tab)");
      if (parts.length === 5 && m === "PUT") return json(huddles.setNotes(slug, parts[3], parts[4], (await body(req))?.notes));
      throw new HttpError(404, "not found");
    }

    // /profiles/:p/huddles — shared rooms where several Claude sessions work on a ticket (see huddle.ts)
    if (parts[2] === "huddles") return huddleApi(req, url, slug, parts.slice(3));

    // /profiles/:p/tickets
    if (parts[2] !== "tickets") throw new HttpError(404, "not found");
    if (parts.length === 3) {
      if (m === "GET") {
        await sessions.ready();
        const hosts = board.hostHuddles(slug);
        const tickets = store.listTickets(slug);
        // Open features (feature.ts) are marked, so list_tickets can show which work to add new tickets to.
        const features = new Set(openFeatures(tickets).map((f) => f.top.id));
        return json(tickets.map((t) => ({ ...view(profile, t, hosts), ...(features.has(t.id) ? { feature: true } : {}) })));
      }
      if (m === "POST") {
        const b = await body(req);
        const title = String(b.title ?? "").trim();
        if (!title) throw new HttpError(400, "title is required");
        const fromRun = req.headers.get(RUN_HEADER)?.split("/");
        // create_ticket's main: true: a new main ticket, like the user's own New ticket, made because the user asked for
        // it in a message they typed in the calling chat (on its own board, or this one). Top level only.
        const wantMain = b.main === true;
        if (b.main !== undefined && b.main !== null && typeof b.main !== "boolean") throw new HttpError(400, "main must be true or false");
        if (wantMain) {
          if (b.partOf || b.parentId) throw new HttpError(400, "a main ticket is top level: leave out partOf, partOfThisTicket and parentId");
          if (b.sessionId) throw new HttpError(400, "a main ticket can't be made from a linked session: leave out sessionId");
          if (fromRun && (req.headers.get(HUDDLE_HEADER) || !fromRun[1] || !board.userAskedRun(fromRun[0], fromRun[1]))) {
            throw new HttpError(403, "main: true needs a message the user typed in this chat: work runs, follow-ups, plan wake-ups, " +
              "replies to other tickets and huddle helpers can't create main tickets");
          }
        } else if (b.gather !== undefined && b.gather !== null) {
          throw new HttpError(400, "gather only works with main: true (use gather_tickets to add tickets to an existing feature)");
        }
        let gatherItems: { id: string; group: string | null }[] | null = null;
        if (wantMain && b.gather !== undefined && b.gather !== null) {
          if (!Array.isArray(b.gather)) throw new HttpError(400, "gather must list { id, group } entries");
          gatherItems = b.gather.filter((x: any) => x && typeof x.id === "string" && x.id.trim())
            .map((x: any) => ({ id: x.id.trim(), group: typeof x.group === "string" && x.group.trim() ? x.group.trim() : null }));
        }
        const rights = runRights(req, slug);
        // A main ticket's own chat creating a new main ticket: not a tool ticket of its family.
        const { requester, guest } = rights;
        const planner = wantMain ? undefined : rights.planner;
        const runner = rights.runner ?? (wantMain ? rights.planner : undefined);
        let status: Status = STATUSES.includes(b.status) ? b.status : "backlog";
        let mode: "auto" | "interview" = b.mode === "auto" ? "auto" : "interview";
        let parentId = typeof b.parentId === "string" && b.parentId ? b.parentId : undefined;
        const planKey = typeof b.planKey === "string" && b.planKey.trim() ? b.planKey.trim() : undefined;
        const dependsOn = strings(b.dependsOn);
        const needs = strings(b.needs);
        const tags = strings(b.tags);
        if (planner) {
          // A planner adds children to its own plan; the board starts them when their dependencies are done.
          const kids = store.listTickets(slug).filter((c) => c.parentId === planner.id);
          const running = planActive(planner.plan);
          // Unattended plans are capped; in the user's chat the user is there to stop it. A main ticket's family has no
          // such cap: its no-progress rule stops runaway loops instead.
          const cap = running && !isManager(planner) ? 2 * Math.max(1, planner.plan!.originalCount) : Infinity;
          if (kids.length >= cap) throw new HttpError(409, `child ticket limit reached (${cap}) for this plan`);
          const missing = (dependsOn ?? []).filter((d) => !kids.some((k) => k.id === d || k.planKey === d));
          if (missing.length) throw new HttpError(400, `unknown dependency ${missing.join(", ")}: use a sibling's ticket id or key`);
          // Children wait in Backlog until the plan starts them; a running plan's children skip the interview.
          [parentId, status] = [planner.id, "backlog"];
          if (running || isManager(planner)) mode = "auto";
        }
        // A ticket Claude creates inside a main ticket's family is a tool ticket: unattended, never interviewing.
        const tool = !!planner && isManager(planner);
        if (parentId && !store.getTicket(slug, parentId)) throw new HttpError(400, `parent ticket ${parentId} not found`);
        // Create on a chat's proposed-tickets card: a draft that is already this parent's child (same key or proposed
        // title, even renamed, started or moved since) answers with that ticket instead of making it twice.
        const proposedAs = !planner && parentId && typeof b.proposedAs === "string" && b.proposedAs.trim() ? b.proposedAs.trim() : undefined;
        if (proposedAs) {
          const made = createdFromDraft(store.listTickets(slug), parentId!, { title: proposedAs, ...(planKey ? { key: planKey } : {}) });
          if (made && made.parentId === parentId) return json(view(profile, made), 200);
        }
        // Part of another ticket's family: a run's own ticket (create_ticket's partOfThisTicket, shown as "from chat") or,
        // for the user, any ticket of this board.
        const partOf = typeof b.partOf === "string" && b.partOf ? b.partOf : undefined;
        if (b.kind !== undefined && b.kind !== null && !TICKET_KINDS.includes(b.kind)) throw new HttpError(400, `kind must be one of ${TICKET_KINDS.join(", ")}`);
        const kind: TicketKind | undefined = b.kind ?? undefined;
        // Model and effort for its runs: from create_ticket inside a run, else a tool ticket's kind decides.
        if (b.model !== undefined && b.model !== null && !(typeof b.model === "string" && validModel(b.model))) throw new HttpError(400, `"${b.model}" is not a model name. Use ${MODEL_HELP}.`);
        if (b.effort !== undefined && b.effort !== null && !(typeof b.effort === "string" && validEffort(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
        const defaults = tool ? kindDefaults(kind) : null;
        const model: string | null = (typeof b.model === "string" && b.model) || defaults?.model || null;
        const effort: string | null = (typeof b.effort === "string" && b.effort) || defaults?.effort || null;
        // Made by a schedule's run: what that schedule raised for the user (its next quiet runs follow up on it).
        const runTicket = fromRun?.[0] === slug && fromRun[1] && !req.headers.get(HUDDLE_HEADER) ? store.getTicket(slug, fromRun[1]) : null;
        const raisedBy = runTicket?.scheduleId ? { scheduleId: runTicket.scheduleId, ticketId: runTicket.id } : null;
        const partOfVia = partOf && fromRun?.[0] === slug && fromRun[1] === partOf ? "chat" as const : undefined;
        if (partOf && !store.getTicket(slug, partOf)) throw new HttpError(400, `ticket ${partOf} not found (partOf)`);
        // From a run, partOf is the run's own ticket, or an open feature (its top ticket or one of its groups): work that
        // belongs to a feature joins it.
        if (partOf && fromRun && !partOfVia) {
          const all = store.listTickets(slug);
          const top = familyRoot(all, partOf);
          const ok = !!top && isFeature(all, top) && (top.id === partOf || groupsOf(all, top.id).some((g) => g.id === partOf));
          if (!ok) throw new HttpError(403, "from a board run, partOf can only be the run's own ticket (use partOfThisTicket), an open feature's top ticket or one of its groups");
        }
        const startedBy = runner && startsRun(status) ? runStart(slug, runner) : guest && startsRun(status) ? guestStart(guest) : null;
        // The user's own new ticket, on its own (not under another ticket, not a linked session): a main ticket.
        const main = wantMain || (!fromRun && !parentId && !partOf && !b.sessionId);
        // A tool ticket that changes files starts from its main ticket's copy (git boards), so its work merges back there.
        const mainTicket = tool ? board.mainOf(slug, planner!) : null;
        const startFrom = tool && mainTicket?.branch && mainTicket.worktree ? mainTicket.branch : null;
        let t: Ticket;
        try {
          t = await board.createTicket(slug, {
            title, body: String(b.body ?? ""), status: b.sessionId && !planner ? "backlog" : status, mode, parentId, planKey, dependsOn, needs, tags,
            ...(proposedAs ? { proposedAs } : {}),
            important: b.important === true, ...(partOf && !tool ? { partOf, ...(partOfVia ? { partOfVia } : {}) } : {}),
            ...(raisedBy ? { raisedBy } : {}), ...(kind ? { kind } : {}),
            ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(main ? { main: true } : {}), ...(tool ? { tool: true } : {}),
            ...(startFrom ? { startFrom } : {}),
          });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        if (planner) store.addComment(slug, t.id, "ai", tool ? `Tool ticket of ${planner.id} ("${planner.title}").` : `Created by the planner of plan ${planner.id}.`);
        // Its manager's plan runs it (in any column): started now if the plan was resting.
        let planPaused = false;
        if (tool) {
          // Its main ticket's plan still paused by Stop: the step waits, and the reply tells Claude so (no "queued").
          const top = mainTicket ?? planner!;
          planPaused = store.getTicket(slug, top.id)?.plan?.state === "paused";
          board.ensurePlan(slug, planner!.id);
          board.advancePlans(slug);
        }
        if (requester) store.addComment(slug, t.id, "ai", `Created ${byRequest(requester)}.`);
        if (runner) store.addComment(slug, t.id, "ai", `Created ${byRun(runner)}.`);
        if (guest) store.addComment(slug, t.id, "ai", `Created ${byGuest(guest)}.`);
        if (partOfVia) store.addComment(slug, t.id, "ai", `Linked as part of ${partOf} ("${store.getTicket(slug, partOf!)?.title ?? ""}"), the ticket whose chat created it.`);
        if (startedBy) board.markStartedBy(slug, t.id, startedBy);
        if (wantMain && fromRun) store.addComment(slug, t.id, "ai", "Created as a main ticket at the user's request.");
        // Then the tickets the user asked to move into it (Board.gather: they keep their cards, chats, work and PRs).
        let gathered: { gathered: unknown[]; movedUp: unknown[]; skipped: unknown[]; group: unknown } | null = null;
        if (gatherItems?.length) {
          try {
            const r = await board.gather(slug, t.id, gatherItems, typeof b.newGroup === "string" ? b.newGroup : null);
            gathered = { gathered: r.gathered.map((x) => view(profile, x)), movedUp: r.movedUp, skipped: r.skipped, group: r.group && view(profile, r.group) };
          } catch (e) {
            gathered = { gathered: [], movedUp: [], skipped: gatherItems.map((x) => ({ id: x.id, reason: (e as Error).message })), group: null };
          }
        }
        // A ticket the user made (not a run, plan or linked one) gets a parent suggestion in its panel.
        if (!fromRun && !parentId && !partOf) suggestParent(slug, t.id);
        if (b.sessionId && !planner) {
          try {
            await board.linkSession(slug, t.id, String(b.sessionId));
            t = await board.updateTicket(slug, t.id, { status });
          } catch (e) {
            await board.deleteTicket(slug, t.id);
            throw new HttpError(400, (e as Error).message);
          }
        }
        return json({ ...view(profile, store.getTicket(slug, t.id)!), ...(gathered ? { gather: gathered } : {}), ...(planPaused ? { planPaused: true } : {}) }, 201);
      }
    }

    const id = parts[3];
    ticketOr404(slug, id);

    if (parts.length === 4) {
      if (m === "GET") return json(view(profile, store.getTicket(slug, id)!));
      if (m === "PATCH") {
        const b = await body(req);
        if (b.status !== undefined && !STATUSES.includes(b.status)) throw new HttpError(400, `invalid status ${b.status}`);
        const target = store.getTicket(slug, id)!;
        // ⭐ Important and suggested tags on its own ticket: any of the ticket's runs may set them (the user said the task
        // matters; a suggestion changes nothing until the user keeps it).
        const own = req.headers.get(RUN_HEADER) === `${slug}/${id}` && !req.headers.get(HUDDLE_HEADER);
        const onlyOwn = Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "important" || k === "suggestedTags");
        // Its own card to Done, Backlog or Ready, asked for by the user in this ticket's chat: moved once the reply ends.
        if (own && Object.keys(b).length === 1 && SELF_MOVES.includes(b.status) && board.requestSelfMove(slug, id, b.status as SelfMove)) {
          return json({ ...view(profile, target), selfMove: b.status });
        }
        const { planner, requester, runner, guest } = own && onlyOwn ? {} : runRights(req, slug, target);
        const patch: Parameters<Board["updateTicket"]>[2] = {};
        const deps = strings(b.dependsOn);
        if (deps) patch.dependsOn = deps;
        const needs = strings(b.needs);
        if (needs) patch.needs = needs;
        const tags = strings(b.tags);
        if (tags) patch.tags = tags;
        const suggested = strings(b.suggestedTags);
        if (suggested) patch.suggestedTags = suggested;
        if (b.parentId === null) patch.parentId = null;
        else if (b.parentId !== undefined) throw new HttpError(400, "parentId can only be cleared (null); use adopt to add a ticket to a plan");
        // Family: partOf a ticket id links it (null unlinks); parentSuggestion null is Not related.
        if (b.partOf !== undefined && b.partOf !== null && (typeof b.partOf !== "string" || !b.partOf)) throw new HttpError(400, "partOf must be a ticket id or null");
        if (b.parentSuggestion !== undefined && b.parentSuggestion !== null) throw new HttpError(400, "parentSuggestion can only be cleared (null)");
        const linkOnly = Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "partOf" || k === "parentSuggestion");
        if (b.mode === "auto" || b.mode === "interview") patch.mode = b.mode;
        if (typeof b.expectedBody === "string") patch.expectedBody = b.expectedBody;
        if (typeof b.title === "string") patch.title = b.title;
        if (typeof b.body === "string") patch.body = b.body;
        if (b.status) patch.status = b.status;
        // Starting work while the user's huddle is live on the ticket: both would work on the same thing.
        const working = (st?: string) => st === "ready" || st === "in_progress";
        if (working(patch.status) && !working(target.status) && store.listHuddles(slug).some((h) => h.hostTicket === id && h.status === "live" && !h.auto)) {
          parallelWork(req, b, "huddle-open");
        }
        if (typeof b.order === "number") patch.order = b.order;
        if (b.notice === null) patch.notice = null;
        if (b.important !== undefined) {
          if (typeof b.important !== "boolean") throw new HttpError(400, "important must be true or false");
          patch.important = b.important;
        }
        // Spending cap per run: a positive amount, 0 for none, null for the board's. Only the user sets it.
        if (b.runCapUsd !== undefined) {
          if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can change a ticket's spending cap");
          patch.runCapUsd = capValue(b.runCapUsd, true);
        }
        // Model and effort for this ticket's runs: a name, or null for the board's. Only the user sets them.
        if (b.model !== undefined || b.effort !== undefined || b.ultracode !== undefined) {
          if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can change a ticket's model or effort");
        }
        // Ultracode for this ticket's runs: on, off, or null for the board's.
        if (b.ultracode !== undefined) {
          if (b.ultracode !== null && typeof b.ultracode !== "boolean") throw new HttpError(400, "ultracode must be true, false or null");
          patch.ultracode = b.ultracode;
          if (target.effort === "ultracode" && b.effort === undefined) patch.effort = "xhigh";
        }
        if (b.model !== undefined) {
          if (b.model !== null && !(typeof b.model === "string" && validModel(b.model))) throw new HttpError(400, `"${b.model}" is not a model name. Use ${MODEL_HELP}.`);
          patch.model = b.model;
        }
        if (b.effort !== undefined) {
          if (b.effort !== null && !(typeof b.effort === "string" && validEffort(b.effort))) throw new HttpError(400, `"${b.effort}" is not an effort level. Use ${EFFORT_HELP}.`);
          patch.effort = b.effort;
        }
        if (planner || requester || runner || guest) {
          delete patch.order;
          delete patch.notice;
        }
        let startedBy: Ticket["startedBy"] | undefined;
        if ((runner || guest) && patch.status === "done" && target.status !== "done") {
          // Done removes the ticket's copy of the folder: a run never closes work that is under way or not saved yet.
          if (board.isRunning(slug, id)) {
            throw new HttpError(409, `${id} is working right now: stop it first with stop_ticket, or leave closing it to the user`);
          }
          if (!target.workdir && target.worktree && await hasUncommittedChanges(target.worktree)) {
            throw new HttpError(409, `${id} has changes in its copy of the folder that aren't saved in its version history yet; ` +
              "moving it to done could lose them, so only the user can close it (on the board)");
          }
        }
        if (startsRun(patch.status) && patch.status !== target.status) {
          // Who starts this run: another ticket's run (counted against the chain limits) or the user (clears it).
          if (runner) startedBy = runStart(slug, runner);
          else if (guest) startedBy = guestStart(guest);
          else if (!planner) startedBy = null;
        }
        if (planner) {
          if (patch.status === "ready" && target.status !== "ready" && target.runCount > 0) {
            try {
              board.countRetry(slug, planner.id, id, MAX_RETRIES);
            } catch (e) {
              throw new HttpError(409, (e as Error).message);
            }
          }
        }
        let t: Ticket = target;
        try {
          if (b.partOf !== undefined) t = await board.setPartOf(slug, id, b.partOf);
          else if (b.parentSuggestion === null) t = board.dismissParentSuggestion(slug, id);
          if (!linkOnly) t = await board.updateTicket(slug, id, patch, { byUser: !req.headers.get(RUN_HEADER) });
        } catch (e) {
          if (e instanceof ConflictError) throw e;
          throw new HttpError(400, (e as Error).message);
        }
        if (startedBy !== undefined) board.markStartedBy(slug, id, startedBy);
        const changer = planner ?? requester ?? runner ?? guest;
        if (own && onlyOwn && target.important !== t.important) store.addComment(slug, id, "ai", t.important ? "Claude marked this ticket ⭐ Important." : "Claude cleared ⭐ Important.");
        if (changer) {
          const what = Object.entries(patch)
            .map(([k, v]) => (k === "status" ? `moved it to ${v}` : k === "parentId" ? `released it from plan ${target.parentId}` : k === "important" ? (v ? "marked it ⭐ Important" : "cleared ⭐ Important") : `changed ${k}`)).join(", ");
          const by = planner ? "" : requester ? byRequest(requester) : runner ? byRun(runner) : byGuest(guest!);
          const was = parentLink(target)?.id ?? null;
          const linked = b.partOf === undefined || b.partOf === was ? ""
            : b.partOf ? `linked it as part of ${b.partOf}` : `unlinked it from ${was}`;
          if (linked) store.addComment(slug, id, "ai", planner ? `Planner ${linked}.` : `${linked[0].toUpperCase()}${linked.slice(1)} ${by}.`);
          if (what) store.addComment(slug, id, "ai", planner ? `Planner ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} ${by}.`);
        }
        return json(view(profile, startedBy === undefined ? t : store.getTicket(slug, id)!));
      }
      if (m === "DELETE") {
        if (req.headers.get(RUN_HEADER)) {
          // A main ticket may delete its own tool tickets; every other delete stays the user's.
          const target = store.getTicket(slug, id)!;
          const { planner } = target.tool ? runRights(req, slug, target) : {};
          if (!planner || !isManager(planner)) throw new HttpError(403, "deleting tickets is disabled inside a board run");
        }
        const doomed = store.getTicket(slug, id)!;
        const main = doomed.main ? doomed : doomed.tool ? board.mainOf(slug, doomed) : null;
        if (main && board.merging(slug, main.id)) throw new HttpError(409, "Wait a moment: a merge is running");
        // A main ticket takes its tool tickets with it (Board.deleteTicket): their huddles close too.
        for (const o of doomed.main ? board.toolTickets(slug, id) : []) huddles.closeForTicket(slug, o.id);
        huddles.closeForTicket(slug, id);
        try {
          await board.deleteTicket(slug, id);
        } catch (e) {
          throw new HttpError(409, (e as Error).message);
        }
        return new Response(null, { status: 204 });
      }
    }

    const action = parts[4];
    // The log's newest page; `?before=` (the previous answer's `before`) pages back, null once the first entry is in.
    if (action === "activity" && m === "GET") {
      const raw = url.searchParams.get("before");
      const before = raw === null ? undefined : Number(raw);
      if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new HttpError(400, "before must be a byte offset from a previous page");
      return json(store.readActivityPage(slug, id, before));
    }
    // The ticket's whole family from the top ticket down (web/src/family.ts), with each one's session and last result.
    if (action === "family" && m === "GET") {
      return json(familyOf(store.listTickets(slug), id).map(({ ticket: t, depth, how }) => ({
        id: t.id, title: t.title, status: t.status, depth, how: how && LINK_WORDS[how], parent: depth ? parentLink(t)?.id ?? null : null,
        sessionId: t.sessionId, resumeCommand: t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? profile.path, t.sessionId) : null,
        prUrl: t.prUrl, updatedAt: t.updatedAt, result: store.lastAiComment(slug, t.id),
      })));
    }
    // The Family tab: the whole family from the top with each ticket's model, cost, state and last summary. The family's
    // total cost is worked out here only, never written into a ticket's own spend.
    if (action === "family-view" && m === "GET") {
      const tickets = store.listTickets(slug);
      const hosts = board.hostHuddles(slug);
      return json(familyOf(tickets, id).map(({ ticket: t, depth }) => {
        const v = view(profile, t, hosts);
        const out = store.outputsPath(slug, t.id);
        return {
          id: t.id, depth, parent: depth ? parentLink(t)?.id ?? null : null,
          model: t.model ?? profile.model ?? null, effort: t.effort ?? profile.effort ?? null,
          costUsd: spend.ticket(slug, t.id).costUsd + huddles.ticketSpend(slug, t.id).costUsd,
          needsYou: !!v.attention && v.attention.kind !== "review",
          summary: store.lastAiComment(slug, t.id), finishedAt: v.running ? null : t.runEndedAt ?? t.doneAt ?? null,
          report: existsSync(join(out, "report.md")),
        };
      }));
    }
    // "Where we are": the feature's status (feature.ts). GET reads it; POST is update_status (the user, a run of a
    // ticket in the same family, or a chat answering the user's typed message, on any board: askedBy); POST notes is
    // "Add a note" (the user only).
    if (action === "status" && parts.length === 5 && m === "GET") {
      const f = board.featureStatus(slug, id);
      return json({ topId: f.top.id, title: f.top.title, feature: f.feature, saved: f.saved, facts: f.facts, sections: f.sections, path: f.path });
    }
    if (action === "status" && parts.length === 5 && m === "POST") {
      if (req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "huddle helpers can't change the feature's status; tell @main what to put there");
      const from = runBoard(req);
      const caller = ownRun(req, slug);
      const all = store.listTickets(slug);
      let by: string | null = null;
      if (from !== null && !(caller && familyRoot(all, caller)?.id === familyRoot(all, id)?.id)) {
        by = askedBy(req, slug);
        if (!by && from !== slug) throw otherBoard("updating a feature's status", slug, from);
        if (!by) {
          throw new HttpError(403, `only runs of tickets in this feature may update its status (${caller} is not in ${id}'s family), ` +
            "or a chat replying to a message the user typed there");
        }
      }
      const b = await body(req);
      const patch: StatusPatch = {};
      for (const f of STATUS_FIELDS) {
        if (b[f] === undefined) continue;
        if (b[f] !== null && typeof b[f] !== "string") throw new HttpError(400, `${f} must be text or null`);
        patch[f] = b[f];
      }
      if (b.prNotes !== undefined) {
        if (!b.prNotes || typeof b.prNotes !== "object" || Array.isArray(b.prNotes)) throw new HttpError(400, "prNotes must map pull request URLs to a short note");
        // Only the family's own pull requests get a note.
        const prs = new Set(board.featureStatus(slug, id).facts.prs.map((p) => p.url));
        patch.prNotes = Object.fromEntries(Object.entries(b.prNotes).filter(([u]) => prs.has(u)).slice(0, 100).map(([u, v]) => [u, typeof v === "string" ? v : null]));
      }
      // Pull requests in other repos, by URL: they join the feature's list and the board tracks their state.
      let addedPrs = false;
      if (b.prs !== undefined) {
        if (!Array.isArray(b.prs) || b.prs.some((u: unknown) => typeof u !== "string" || !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(u))) {
          throw new HttpError(400, "prs must be a list of GitHub pull request URLs, e.g. https://github.com/owner/repo/pull/12");
        }
        const top = familyRoot(store.listTickets(slug), id);
        if (top && b.prs.length) {
          const add = addPrs(top, b.prs.slice(0, 20));
          if ("prs" in add) board.patchPrs(slug, top.id, add as Pick<Ticket, "prs" | "prUrl">);
          addedPrs = true;
        }
      }
      if (!Object.keys(patch).length && !addedPrs) throw new HttpError(400, `nothing to update: pass ${STATUS_FIELDS.join(", ")}, prNotes or prs`);
      const f = board.updateStatus(slug, id, patch);
      if (by) store.addComment(slug, f.top.id, "ai", `Status updated ${by}.`);
      return json({ topId: f.top.id, title: f.top.title, feature: f.feature, saved: f.saved, facts: f.facts, sections: f.sections, path: f.path, markdown: f.markdown });
    }
    if (action === "status" && parts[5] === "notes" && m === "POST") {
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user adds notes to the status (Add a note)");
      const b = await body(req);
      try {
        const f = board.addStatusNote(slug, id, String(b.text ?? ""));
        return json({ topId: f.top.id, title: f.top.title, feature: f.feature, saved: f.saved, facts: f.facts, sections: f.sections, path: f.path });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Gather tickets into a feature: the user (Family tab), or a chat answering the user's own message (askedBy): the
    // feature's own, another one on this board or one on another board. Credited when it isn't the feature's own.
    if (action === "gather" && m === "POST") {
      const from = runBoard(req);
      const caller = ownRun(req, slug);
      const all = store.listTickets(slug);
      let by: string | null = null;
      if (from !== null) {
        by = askedBy(req, slug);
        if (!by && from !== slug) throw otherBoard("gathering tickets", slug, from);
        if (!by) throw new HttpError(403, "gathering tickets works from a chat, in a reply to a message the user typed there");
        if (caller && familyRoot(all, caller)?.id === familyRoot(all, id)?.id) by = null;
      }
      const b = await body(req);
      if (!Array.isArray(b.tickets) || !b.tickets.length) throw new HttpError(400, "tickets must list { id, group } entries");
      const items = b.tickets.filter((x: any) => x && typeof x.id === "string" && x.id.trim())
        .map((x: any) => ({ id: x.id.trim(), group: typeof x.group === "string" && x.group.trim() ? x.group.trim() : null }));
      try {
        const r = await board.gather(slug, id, items, typeof b.newGroup === "string" ? b.newGroup : null, by);
        return json({ gathered: r.gathered.map((t) => view(profile, t)), movedUp: r.movedUp, skipped: r.skipped, group: r.group && view(profile, r.group) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Inbox Snooze: hide what the ticket waits for now (1 day, or { hours }); DELETE unsnoozes.
    if (action === "snooze" && (m === "POST" || m === "DELETE")) {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "snoozing is the user's, not a board run's");
      if (m === "DELETE") return json(view(profile, board.setSnooze(slug, id, null)));
      const b = (await body(req)) ?? {};
      const hours = b.hours === undefined ? SNOOZE_MS / 3600_000 : Number(b.hours);
      if (!(hours > 0 && hours <= 24 * 30)) throw new HttpError(400, "hours must be between 0 and 720");
      const t = store.getTicket(slug, id)!;
      const session = t.sessionId ? sessions.summary(t.sessionId) : null;
      const huddle = board.hostHuddles(slug).get(id);
      const att = ticketAttention(store, slug, t, session, board.isRunning(slug, id), huddle, (x) => board.isRunning(slug, x));
      if (!att) throw new HttpError(409, "this ticket doesn't need you, nothing to snooze");
      const until = new Date(Date.now() + hours * 3600_000).toISOString();
      return json(view(profile, board.setSnooze(slug, id, { until, key: snoozeKey(t, session, att, huddle) })));
    }
    // Follow-ups (followup.ts): a ticket's own Claude sets one (follow_up) or stops it (cancel_follow_up, with a reason);
    // the user's card offers Follow up now (POST .../follow-up/now) and Stop following up (DELETE).
    if (action === "follow-up") {
      const caller = req.headers.get(RUN_HEADER);
      if (caller && (caller !== `${slug}/${id}` || req.headers.get(HUDDLE_HEADER))) {
        throw new HttpError(403, "a run can only set or stop follow-ups on its own ticket");
      }
      try {
        if (m === "POST" && parts[5] === "now") {
          if (caller) throw new HttpError(403, "Follow up now is the user's button; set a follow-up with follow_up instead");
          return json(view(profile, await board.wakeFollowUp(slug, id, { manual: true })), 202);
        }
        if (parts.length > 5) throw new HttpError(404, "not found");
        if (m === "POST") {
          const b = (await body(req)) ?? {};
          const opt = (k: string) => (b[k] === undefined || b[k] === null ? null : String(b[k]));
          if (b.cancelOnReply !== undefined && typeof b.cancelOnReply !== "boolean") throw new HttpError(400, "cancelOnReply must be true or false");
          return json(view(profile, board.setFollowUp(slug, id, { after: opt("after"), at: opt("at"), note: opt("note"), cancelOnReply: b.cancelOnReply })), 201);
        }
        if (m === "DELETE") {
          const b = (await body(req).catch(() => ({}))) ?? {};
          return json(view(profile, board.cancelFollowUp(slug, id, caller ? "claude" : "user", b.reason === undefined ? null : String(b.reason))));
        }
      } catch (e) {
        if (e instanceof FollowUpError) throw new HttpError(400, e.message);
        throw e;
      }
    }
    // take_devices / release_devices: the ticket's own Claude takes shared devices just before it uses them (devices.ts).
    if (action === "devices" && m === "POST" && parts.length === 5) {
      const caller = req.headers.get(RUN_HEADER);
      if (caller !== `${slug}/${id}` || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the ticket's own run takes or lets go of devices for it");
      const b = (await body(req)) ?? {};
      try {
        if (b.action === "take") {
          const r = await board.devices.take(slug, id, b.names, Number.isFinite(b.waitMs) ? Math.max(0, Math.min(Number(b.waitMs), TAKE_WAIT_MS)) : TAKE_WAIT_MS);
          return json(r.ok ? r : { ...r, usedBy: r.usedBy.map((u) => ({ ...u, title: store.getTicket(u.slug, u.id)?.title ?? null })) });
        }
        if (b.action === "release") return json({ released: board.devices.release(slug, id, b.names) });
        throw new HttpError(400, "action must be take or release");
      } catch (e) {
        if (e instanceof DeviceError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // notify_user: the ticket's own Claude sends the user a notification in its own words (Notifier.message).
    if (action === "notify" && m === "POST" && parts.length === 5) {
      const caller = req.headers.get(RUN_HEADER);
      if (caller !== `${slug}/${id}` || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the ticket's own Claude sends it a notification, from its run or chat");
      if (hiddenTool(store.getTicket(slug, id)) && !withYouTool(store.getTicket(slug, id))) throw new HttpError(403, TOOL_NO_NOTIFY);
      const b = (await body(req)) ?? {};
      if (typeof b.message !== "string") throw new HttpError(400, "message is required");
      try {
        return json(await notifier.message(slug, id, b.message));
      } catch (e) {
        if (e instanceof MessageError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // The user opened the ticket (the follow-up wake prompt says when).
    if (action === "seen" && m === "POST") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user's board marks a ticket seen");
      return json(view(profile, board.markSeen(slug, id)));
    }
    if (action === "usage" && m === "GET") {
      // The usage endpoint rate-limits: a ticket view reuses an answer up to 5 minutes old.
      const plan = await usage.get(5 * 60_000);
      const activity = store.readActivity(slug, id);
      const windows = readWindows(windowsFile);
      const needed = windowsNeeded(ticketRuns(activity), windows);
      if (needed.length) await claudeLogs.refresh(Math.min(...needed.map((w) => Date.parse(w.start))));
      return json(ticketUsage({
        activity, windows, machineCost: (a, b) => claudeLogs.costBetween(a, b), windowError: "error" in plan ? plan.error : null,
        teammates: huddles.ticketSpend(slug, id), side: readSideSpend(store.sideSpendPath(slug, id)).costUsd,
      }));
    }
    if (action === "outputs" && m === "POST" && parts.length > 5) {
      // Share menu actions; the user's alone, a board run has no business with the clipboard or Finder.
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "sharing outputs is disabled inside a board run");
      const name = parts.slice(5).join("/");
      const file = store.outputPath(slug, id, name);
      if (!file) throw new HttpError(404, "output not found");
      const what = url.searchParams.get("action");
      try {
        if (what === "reveal") await revealFile(file);
        else if (what === "copy") await copyFileToClipboard(file);
        else if (what === "publish") return json(startPublish(slug, id, name, file), 202);
        else throw new HttpError(400, "action must be reveal, copy or publish");
      } catch (e) {
        if (e instanceof ShareError) throw new HttpError(e.status, e.message);
        throw e;
      }
      return json({ ok: true });
    }
    if (action === "outputs" && m === "GET") {
      if (parts.length === 5) return json(store.listOutputs(slug, id));
      const file = store.outputPath(slug, id, parts.slice(5).join("/"));
      if (!file) throw new HttpError(404, "output not found");
      return rawFile(file, url.searchParams.get("download") === "1");
    }
    // /tickets/:id/find-files { paths } — which file paths a chat message mentions exist, so they can be opened.
    // /tickets/:id/file?path= — one of them, read only (?raw=1 the bytes, for images and PDFs). Looked for in the
    // ticket's copy of the folder, then the project folder, then the ticket's outputs; nothing outside them.
    if (action === "find-files" && m === "POST") {
      const roots = fileRoots(profile, store.getTicket(slug, id)!, store.outputsPath(slug, id));
      const paths = strings((await body(req)).paths)?.slice(0, 200) ?? [];
      const found: Record<string, { root: string; rel: string }> = {};
      for (const p of paths) {
        const f = findInRoots(roots, p);
        if (f) found[p] = { root: f.root, rel: f.rel };
      }
      return json({ found });
    }
    if (action === "file" && m === "GET") {
      const f = findInRoots(fileRoots(profile, store.getTicket(slug, id)!, store.outputsPath(slug, id)), url.searchParams.get("path") ?? "");
      if (!f) throw new HttpError(404, "file not found in this ticket's folders");
      if (url.searchParams.get("raw") === "1") return rawFile(f.file, url.searchParams.get("download") === "1");
      try {
        return json({ ...readFileForView(f.dir, f.rel), root: f.root, dir: f.dir });
      } catch (e) {
        if (e instanceof FileError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    // The Changes tab: the worktree (committed, uncommitted and untracked) against its merge-base with the base branch;
    // a ticket working in the board's folder itself, that folder against its HEAD at the ticket's first run.
    const changes = async (t: Ticket, ignoreWhitespace = false) => {
      try {
        if (!t.worktree && t.baseSha && !t.workdir) return await folderDiff(profile.path, t.baseSha, { ignoreWhitespace });
        if (!t.worktree) throw new HttpError(404, "No version history for this folder, so changes can't be shown.");
        // A main ticket: everything its tool tickets merged into its copy since it started, landed milestones included.
        if (t.main && t.startSha) return await folderDiff(t.worktree, t.startSha, { ignoreWhitespace });
        return await ticketDiff(t.worktree, profile.baseBranch || (await detectBaseBranch(t.worktree)), { ignoreWhitespace, prBase: t.pr?.base });
      } catch (e) {
        if (e instanceof DiffError) throw new HttpError(e.status, e.message);
        throw e;
      }
    };
    if (action === "diff" && m === "GET") return json(await changes(store.getTicket(slug, id)!, url.searchParams.get("w") === "1"));
    // What `/` runs in this ticket's chat: skills, custom commands and built-ins (the composer's picker).
    if (action === "commands" && m === "GET") {
      return json(board.commands(slug, id).map(({ local, ...c }) => c));
    }
    if (action === "conversation" && m === "GET") {
      // Read-only view of the ticket's Claude session file (terminal chat + board runs), newest last.
      const t = store.getTicket(slug, id)!;
      const parsed = t.sessionId ? sessions.get(t.sessionId) : null;
      const all = chatEntries(t);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : all.length;
      const end = Math.max(0, Math.min(all.length, before));
      const start = Math.max(0, end - limit);
      const active = board.isRunning(slug, id);
      // Subagent rows carry only their last steps; "show all" fetches the rest (agent endpoint below).
      // Workflows get the run's live progress (waiting agents too); their script loads on "Show script".
      // Rows from chats left behind with "Send in a fresh chat" come first; none of them is live.
      const earlier = all.length - (parsed?.entries.length ?? 0);
      const entries = all.slice(start, end).map((e, i) => {
        if (e.workflow) return { ...e, workflow: workflowView(e.workflow, slug, id, t.sessionId!, active && start + i >= earlier) };
        if (!e.agent) return e;
        const agent = settleAgent(e.agent, active);
        return { ...e, agent: { ...agent, steps: agent.steps.slice(-AGENT_STEP_TAIL) } };
      });
      return json({ entries, start, total: all.length, title: parsed?.title ?? null });
    }
    if (action === "rewind" && (m === "GET" || m === "POST")) {
      // Rewind: cut the chat before one of the user's messages and put the project files back as they were then.
      // GET ?uuid= says what would change; POST { uuid, files } does it. Only the user's click, never a board run.
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Rewind is the user's click, not a board run's");
      const t = store.getTicket(slug, id)!;
      const b = m === "POST" ? await body(req) : {};
      const uuid = m === "POST" ? String(b.uuid ?? "") : url.searchParams.get("uuid") ?? "";
      const entry = (t.sessionId ? sessions.get(t.sessionId)?.entries : null)?.find((e) => e.uuid === uuid && e.rewind);
      if (!t.sessionId || !entry) throw new HttpError(404, "This message can't be rewound to.");
      const blocked = board.rewindBlocked(slug, id);
      const dir = board.rewindDir(slug, id);
      if (m === "GET") return json({ blocked, ...(await previewRewind(dir, id, entry)) });
      if (blocked) throw new ConflictError(blocked);
      const file = sessions.file(t.sessionId);
      if (!file) throw new HttpError(404, "The conversation file is missing.");
      const { restored, cut } = await applyRewind({ dir, ticketId: id, entry, sessionFile: file, files: b.files !== false });
      board.rewound(slug, id, cut.empty);
      return json({ text: entry.text, restored });
    }
    if (action === "simplified" && m === "GET") {
      // Saved plain-words versions of this ticket's Claude replies, by message.
      const t = store.getTicket(slug, id)!;
      return json(simplifier.saved(slug, id, chatEntries(t)));
    }
    if (action === "simplify" && m === "POST") {
      // "Say it simpler": a side call rewrites one reply; the ticket's session and activity log never see it.
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Say it simpler is the user's click, not a board run's");
      const b = await body(req);
      const t = store.getTicket(slug, id)!;
      const e = typeof b?.uuid === "string" ? chatEntries(t).find((x) => x.uuid === b.uuid) : null;
      if (!e) throw new HttpError(404, "no such message in this ticket's conversation");
      try {
        return json(await simplifier.simplify(slug, id, t.title, e));
      } catch (err) {
        if (err instanceof SimplifyError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (action === "help" && m === "GET") {
      // "Help me understand": the saved answer cards, the ones being worked out, and whether a recap has anything to tell.
      const t = store.getTicket(slug, id)!;
      const entries = (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [];
      return json({
        cards: helper.cards(slug, id), busy: helper.busy(slug, id), recap: recapAvailable(entries),
      });
    }
    if (action === "help" && m === "POST") {
      // A side call answers from the conversation and the changes, reading the ticket's folder; the session never sees it.
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Help me understand is the user's click, not a board run's");
      const kind = (await body(req))?.kind as HelpKind;
      if (!HELP_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of: ${HELP_KINDS.join(", ")}`);
      const t = store.getTicket(slug, id)!;
      const entries = (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [];
      let prompt: string;
      if (kind === "recap") {
        if (!recapAvailable(entries)) throw new HttpError(400, "nothing happened since your last message");
        const findings = huddles.list(slug, id).flatMap((h) => h.findings);
        prompt = recapPrompt({ ticket: t, entries, findings, running: board.isRunning(slug, id) });
      } else {
        const diff = await changes(t);
        if (!diff.files.length) throw new HttpError(400, diff.note ?? "this ticket has no changed files");
        prompt = changesPrompt({ ticket: t, entries, diff });
      }
      const cwd = t.worktree ?? t.workdir ?? (t.baseSha ? profile.path : null);
      try {
        return json(await helper.ask(slug, id, kind, prompt, cwd));
      } catch (err) {
        if (err instanceof HelpError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }
    if (action === "agent" && parts.length === 6 && m === "GET") {
      const t = store.getTicket(slug, id)!;
      const e = chatEntries(t).find((x) => x.agent?.toolUseId === parts[5]);
      if (!e?.agent) throw new HttpError(404, "no such subagent in this ticket's conversation");
      return json(settleAgent(e.agent, board.isRunning(slug, id)));
    }
    // A workflow in the ticket's conversation: its script, one helper agent in full, or stopping it (the user's click).
    if (action === "workflow" && parts.length >= 7) {
      const t = store.getTicket(slug, id)!;
      const e = (t.sessionId ? sessions.get(t.sessionId)?.entries : null)?.find((x) => x.workflow?.toolUseId === parts[5]);
      if (!e?.workflow || !t.sessionId) throw new HttpError(404, "no such workflow in this ticket's conversation");
      const w = e.workflow;
      const run = w.runId ? sessions.workflowRun(t.sessionId, w.runId) : null;
      if (parts[6] === "script" && parts.length === 7 && m === "GET") {
        const script = workflowScript(w, run);
        if (script === null) throw new HttpError(404, "the workflow's script wasn't saved");
        return json({ script });
      }
      if (parts[6] === "agent" && parts.length === 8 && m === "GET") {
        const view = workflowView(w, slug, id, t.sessionId, board.isRunning(slug, id));
        const d = workflowAgentDetail(view, run, parts[7]);
        if (!d) throw new HttpError(404, "no such helper agent in this workflow");
        return json(d);
      }
      if (parts[6] === "stop" && parts.length === 7 && m === "POST") {
        if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "Stopping a workflow is the user's click, not a board run's");
        if (!w.taskId) throw new HttpError(400, "this workflow hasn't started yet");
        if (!board.isRunning(slug, id)) throw new HttpError(400, "this ticket isn't running");
        try {
          return json(await board.stopWorkflow(slug, id, w.taskId));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
    }
    if (action === "tool" && parts.length === 6 && m === "GET") {
      // A tool call's full input and output, loaded when the user opens its row in the chat.
      const t = store.getTicket(slug, id)!;
      const d = [t.sessionId, ...(t.earlierSessions ?? []).map((x) => x.sessionId).reverse()]
        .reduce<ReturnType<typeof sessions.toolDetail>>((found, sid) => found ?? (sid ? sessions.toolDetail(sid, parts[5]) : null), null);
      if (!d) throw new HttpError(404, "no such tool call in this ticket's conversation");
      return json(d);
    }
    if (action === "comments") {
      if (m === "GET") return json(store.listComments(slug, id));
      if (m === "POST") {
        const b = await body(req);
        const text = String(b.text ?? "").trim();
        if (!text) throw new HttpError(400, "text is required");
        // The child reads user comments on its next run; mark who wrote this one. Another ticket's run leaves a note:
        // shown as Claude's, and labelled for the next run, so it never reads as the user's.
        const { planner, requester, runner, guest } = runRights(req, slug, store.getTicket(slug, id)!);
        if (runner) return json(board.addComment(slug, id, `Note from ticket ${runner.id} ("${runner.title}"): ${text}`, runner.id), 201);
        const by = planner ? "Planner: " : requester ? `From the Planning chat of ${requester.id} (user request): `
          : guest ? `From the chat of ${guest.ticket.id} on ${store.getProfile(guest.slug)?.name ?? guest.slug} (user request): ` : "";
        return json(board.addComment(slug, id, by + text), 201);
      }
    }
    if (m === "POST" && action === "chat") {
      const { planner, requester, runner, guest } = runRights(req, slug, store.getTicket(slug, id)!);
      const b = await body(req);
      const text = String(b.text ?? "").trim();
      if (!text) throw new HttpError(400, "text is required");
      // A message starts the ticket's run, now or once its current run ends (queued): another ticket's run is counted
      // against the chain limits either way; the user's message to a ticket that isn't working clears it.
      const startedBy = runner ? runStart(slug, runner) : guest ? guestStart(guest)
        : !planner && !requester && !board.isRunning(slug, id) ? null : undefined;
      // A message from a run never hands the user's rights on to the run it starts.
      // Labelled with the sending ticket, so neither Claude nor the chat takes it for the user's own message.
      const sender = runner ?? planner ?? requester ?? guest?.ticket;
      // "Send in a fresh chat" is the user's own choice, never a run's or another ticket's.
      const fresh = b.fresh === true && !sender && !req.headers.get(RUN_HEADER);
      const t = await board.chat(slug, id, sender ? fromTicketText(sender.id, sender.title, text) : text,
        { fromPlanner: !!sender, ...(sender ? { from: { ticketId: sender.id, title: sender.title } } : {}), ...(fresh ? { fresh } : {}) });
      if (startedBy !== undefined) board.markStartedBy(slug, id, startedBy);
      // A message the user typed (not a slash command) reached Claude: a pending follow-up hears about it, and stops if it was set to.
      if (!req.headers.get(RUN_HEADER) && !text.startsWith("/")) board.userReplied(slug, id);
      // The user wrote in a tool ticket: its parent hears the whole message before its next decision.
      // A "with you" ticket is the user's own live step: answers go straight to it (also from the main ticket's chat), and
      // its result reaches the main ticket.
      if (!req.headers.get(RUN_HEADER) && !req.headers.get(HUDDLE_HEADER) && hiddenTool(t) && !withYouTool(t)) board.noteUserMessage(slug, id, text);
      if (requester) store.addComment(slug, id, "ai", `Message sent ${byRequest(requester)}.`);
      if (runner) store.addComment(slug, id, "ai", `Message sent ${byRun(runner)}.`);
      if (guest) store.addComment(slug, id, "ai", `Message sent ${byGuest(guest)}.`);
      return json(view(profile, t), 202);
    }
    // A message Claude hasn't received: POST .../queued/<msgId> sends it (unsent only), PATCH { text } edits it, DELETE discards it.
    if (action === "queued" && parts[5] && (m === "POST" || m === "PATCH" || m === "DELETE")) {
      try {
        let t: Ticket;
        if (m === "PATCH") {
          const text = String((await body(req)).text ?? "").trim();
          if (!text) throw new HttpError(400, "text is required");
          t = board.editQueued(slug, id, parts[5], text);
        } else t = m === "POST" ? await board.sendQueued(slug, id, parts[5]) : board.discardQueued(slug, id, parts[5]);
        return json(view(profile, t), m === "POST" ? 202 : 200);
      } catch (e) {
        if (e instanceof ConflictError || e instanceof HttpError) throw e;
        throw new HttpError(404, (e as Error).message);
      }
    }
    // A teammate card in the chat (propose_teammate) was answered: PUT .../teammate-cards/<entry uuid> { state: "saved",
    // name, scope } after the user saved it (the save itself goes through huddle-presets), or { state: "dismissed" }.
    // An automation card in the chat (propose_automation) was saved: PUT .../automation-cards/<entry uuid> { loopId }.
    if (action === "automation-cards" && parts.length === 6 && m === "PUT") {
      await userOnly(req, "Answering an automation card");
      const b = await body(req);
      const loopId = String(b?.loopId ?? "");
      if (!store.getLoop(slug, loopId)) throw new HttpError(400, "that automation doesn't exist");
      const t = store.getTicket(slug, id)!;
      store.updateTicket(slug, id, { automationCards: { ...t.automationCards, [parts[5]]: { loopId, at: nowIso() } } });
      emitTicket(slug, id);
      return json(view(profile, store.getTicket(slug, id)!));
    }
    if (action === "teammate-cards" && parts.length === 6 && m === "PUT") {
      if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "only the user answers teammate cards");
      const b = await body(req);
      if (b.state !== "saved" && b.state !== "dismissed") throw new HttpError(400, "state must be saved or dismissed");
      if (b.scope !== undefined && b.scope !== "global" && b.scope !== "board") throw new HttpError(400, "scope must be global or board");
      const t = store.getTicket(slug, id)!;
      const card = {
        state: b.state, at: nowIso(),
        ...(b.state === "saved" && typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}),
        ...(b.state === "saved" && b.scope ? { scope: b.scope } : {}),
      };
      store.updateTicket(slug, id, { teammateCards: { ...t.teammateCards, [parts[5]]: card } });
      emitTicket(slug, id);
      return json(view(profile, store.getTicket(slug, id)!));
    }
    if (m === "POST" && action === "link-session") {
      const b = await body(req);
      try {
        const t = await board.linkSession(slug, id, b.sessionId ? String(b.sessionId) : null);
        return json(view(profile, t));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Branch: a new ticket with a copy of this one's conversation and committed code (the user's call, not a run's).
    if (m === "POST" && action === "branch") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "branching is disabled inside a board run; use the propose_branch tool so the user can click Branch");
      try {
        const r = await board.branchTicket(slug, id);
        return json({ ticket: view(profile, r.ticket), warning: r.warning }, 201);
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Move a Backlog ticket to another board (the user's click, not a run's).
    if (m === "POST" && action === "move") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "moving tickets is the user's call, not a run's");
      const b = await body(req);
      const target = String(b.board ?? "");
      if (!store.getProfile(target)) throw new HttpError(404, "board not found");
      try {
        const t = await board.moveTicket(slug, id, target);
        huddles.closeForTicket(slug, id);
        return json(view(store.getProfile(target)!, t), 201);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Add-on: a new ticket for a new requirement on this one, which keeps its title and description (the user's click).
    if (m === "POST" && action === "add-on") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "add-on tickets are created by the user's click on a proposal card; use the propose_ticket tool");
      const b = await body(req);
      try {
        const t = await board.addOnTicket(slug, id, { title: String(b.title ?? ""), body: String(b.body ?? ""), start: !!b.start, important: b.important === true });
        return json(view(profile, t), 201);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // One-click recovery: the session is gone (fresh-session) or open in a terminal (take-over). The user's call.
    if (m === "POST" && (action === "fresh-session" || action === "take-over")) {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "session recovery is the user's call, not a run's");
      try {
        if (action === "fresh-session") return json({ ticket: view(profile, board.startFresh(slug, id)), external: false });
        const r = await board.takeOver(slug, id);
        return json({ ticket: view(profile, r.ticket), external: r.external });
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Installs the worktree's dependencies (the board's setup command) when the ticket's Claude needs them; waits for it.
    if (m === "POST" && action === "setup") {
      // A run may only install its own ticket's dependencies (the command runs the branch's install scripts).
      if (req.headers.get(RUN_HEADER) && runTicket(req, slug) !== id) throw new HttpError(403, "a board run may only run the setup of its own ticket");
      return json(await board.runSetup(slug, id));
    }
    // Main and tool tickets (main-ticket.ts). ask: a run asks a ticket of its family (POST .../<asker>/ask {target, question}).
    if (m === "POST" && action === "ask") {
      const asker = runTicket(req, slug);
      if (!asker || asker !== id || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "ask_ticket works from a board run, for that run's own ticket");
      const b = await body(req);
      const target = store.getTicket(slug, String(b.target ?? ""));
      if (!target) throw new HttpError(404, `ticket ${b.target} not found`);
      if (!inFamily(slug, id, target.id) && familyRoot(store.listTickets(slug), id)?.id !== familyRoot(store.listTickets(slug), target.id)?.id) {
        throw new HttpError(403, `${target.id} is not in this ticket's family`);
      }
      try {
        return json({ message: board.askTicket(slug, id, target.id, String(b.question ?? "")) }, 202);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    // merge_into_main: a tool ticket's own run fast-forwards its main ticket's copy.
    if (m === "POST" && action === "merge-into-main") {
      if (runTicket(req, slug) !== id || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "merge_into_main works only from the tool ticket's own run");
      try {
        return json({ message: await board.mergeIntoMain(slug, id) });
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    }
    // land_milestone: the main ticket's own run (or the user) lands its copy.
    if (m === "POST" && action === "land") {
      const caller = runTicket(req, slug);
      if ((caller && caller !== id) || req.headers.get(HUDDLE_HEADER)) throw new HttpError(403, "land_milestone works only from the main ticket's own run");
      const b = await body(req);
      try {
        return json({ message: await board.landMilestone(slug, id, String(b.summary ?? "")) });
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    }
    if (m === "POST" && action === "stop") {
      const target = store.getTicket(slug, id)!;
      const { planner, requester, runner, guest } = runRights(req, slug, target);
      // The user's Stop on a main ticket stops its running tool tickets too.
      if (target.main && !req.headers.get(RUN_HEADER)) {
        const r = board.stopFamily(slug, id);
        return json({ stopped: r.stopped, tools: r.tools });
      }
      const stopped = board.stop(slug, id);
      if (planner && stopped) store.addComment(slug, id, "ai", "Planner stopped this run.");
      if (requester && stopped) store.addComment(slug, id, "ai", `Run stopped ${byRequest(requester)}.`);
      if (runner && stopped) store.addComment(slug, id, "ai", `Run stopped ${byRun(runner)}.`);
      if (guest && stopped) store.addComment(slug, id, "ai", `Run stopped ${byGuest(guest)}.`);
      return json({ stopped });
    }
    // Start / pause / resume / mark done a planner's plan, or change how many children run at once.
    if (m === "POST" && action === "plan") {
      const b = await body(req);
      // A planner may start or resume its own plan (plan_control) when it has planner rights; the rest is the user's.
      const byPlanner = !!req.headers.get(RUN_HEADER);
      if (byPlanner) {
        if (runTicket(req, slug) !== id || (b.action !== "start" && b.action !== "resume")) {
          throw new HttpError(403, "a board run may only start or resume its own ticket's plan; pausing, finishing and concurrency are the user's");
        }
        if (!board.plannerRights(slug, id)) {
          throw new HttpError(403, "starting the plan from a board run needs the user's go-ahead: only a reply to the user's message in this ticket's chat may do it");
        }
        if (store.getTicket(slug, id)!.plan?.state === "done") throw new HttpError(403, "this ticket's plan is done; the user can start a new one first");
      }
      const n = b.maxConcurrent === undefined || byPlanner ? undefined : Number(b.maxConcurrent);
      try {
        const t = b.action === "pause" ? board.pausePlan(slug, id)
          : b.action === "start" || b.action === "resume" ? board.startPlan(slug, id, { maxConcurrent: n, byPlanner })
          : b.action === "done" ? board.markPlanDone(slug, id)
          : b.action === "concurrency" && n !== undefined ? board.setPlanConcurrency(slug, id, n)
          : null;
        if (!t) throw new HttpError(400, "action must be start, pause, resume, done or concurrency");
        return json(view(profile, store.getTicket(slug, id) ?? t));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Manager mode: make existing tickets children of this one (adopt_tickets). From a run, only when the user asked
    // for it in this ticket's own chat.
    if (m === "POST" && action === "adopt") {
      if (req.headers.get(RUN_HEADER)) {
        if (runTicket(req, slug) !== id || !board.userChatRun(slug, id)) {
          throw new HttpError(403, "adopting tickets from a board run only works in a reply to the user's message in the adopting ticket's own chat");
        }
        if (store.getTicket(slug, id)!.plan?.state === "done") throw new HttpError(403, "this ticket's plan is done; the user can start a new one first");
      }
      const b = await body(req);
      const ids = strings(b.ids);
      if (!ids?.length) throw new HttpError(400, "ids must be a non-empty list of ticket ids");
      const r = board.adoptTickets(slug, id, ids);
      return json({ adopted: r.adopted.map((t) => view(profile, t)), skipped: r.skipped });
    }
    // A run stopped at its spending cap: "Continue with +$Y" ({addUsd}).
    if (m === "POST" && action === "cap-continue") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can continue a ticket past its spending cap");
      const b = await body(req);
      try {
        return json(view(profile, await board.continueAfterCap(slug, id, Number(b.addUsd))), 202);
      } catch (e) {
        if (e instanceof ConflictError) throw e;
        throw new HttpError(400, (e as Error).message);
      }
    }
    // Stalled run (no output for the board's stall time): Stop, Keep waiting or Restart in the same session.
    if (m === "POST" && action === "stall") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can stop, keep waiting on or restart a stalled run");
      const b = await body(req);
      if (b.action !== "stop" && b.action !== "wait" && b.action !== "restart") throw new HttpError(400, "action must be stop, wait or restart");
      try {
        return json(view(profile, board.stallAction(slug, id, b.action)));
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    }
    // Usage limit: "Continue now" (action: continue), or "Don't auto-continue" / "Auto-continue" (auto: boolean).
    if (m === "POST" && action === "limit") {
      if (req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can continue a ticket after the usage limit or change its auto-continue");
      const b = await body(req);
      if (b.action === "continue") {
        try {
          return json(view(profile, await board.continueAfterLimit(slug, id)), 202);
        } catch (e) {
          if (e instanceof ConflictError) throw e;
          throw new HttpError(400, (e as Error).message);
        }
      }
      if (typeof b.auto !== "boolean") throw new HttpError(400, "send {action: \"continue\"} or {auto: true|false}");
      return json(view(profile, board.setAutoContinue(slug, id, b.auto)));
    }
    if (m === "POST" && action === "check-pr") {
      const state = await checkPr(board, store, slug, id);
      return json({ state, ticket: view(profile, store.getTicket(slug, id)!) });
    }
    // Review PR box: refresh (rate-limited unless force), send failing CI logs to Claude, resolve conflicts, Merge & done.
    if (m === "POST" && action === "pr" && ["refresh", "send-failures", "resolve-conflicts", "merge"].includes(parts[5])) {
      if (parts[5] !== "refresh" && req.headers.get(RUN_HEADER)) throw new HttpError(403, "only the user can merge a PR or send its CI failures or conflicts from the board");
      try {
        if (parts[5] === "refresh") {
          const force = !!(await body(req).catch(() => ({} as Record<string, unknown>))).force;
          const pr = await refreshPr(board, store, slug, id, { ...deps.pr, maxAgeMs: force ? 0 : REFRESH_MIN_MS });
          return json({ pr, ticket: view(profile, store.getTicket(slug, id)!) });
        }
        const t = parts[5] === "merge" ? await mergePr(board, store, slug, id, deps.pr)
          : parts[5] === "resolve-conflicts" ? await resolveConflicts(board, store, slug, id, deps.pr)
          : await sendFailures(board, store, slug, id, deps.pr);
        return json(view(profile, t), parts[5] === "merge" ? 200 : 202);
      } catch (e) {
        if (e instanceof PrError) throw new HttpError(e.status, e.message);
        if (e instanceof HttpError || e instanceof ConflictError) throw e;
        throw new HttpError(502, (e as Error).message);
      }
    }
    if (m === "POST" && action === "planning-command") {
      try {
        return json({ command: await board.planningCommand(slug, id) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    throw new HttpError(404, "not found");
  }

  /**
   * Huddle routes. The sender of a message is never taken from the body: a request from a board run is that run's
   * participant (its token for agents), anything else is the user (@you). Stop, resume, close and stopping one
   * participant are the user's alone.
   */
  async function huddleApi(req: Request, url: URL, slug: string, rest: string[]): Promise<Response> {
    const m = req.method;
    const who: Caller = { run: req.headers.get(RUN_HEADER), agent: req.headers.get(HUDDLE_HEADER) };
    const userOnly = (what: string) => {
      if (who.run || who.agent) throw new HttpError(403, `only the user can ${what}; ask them in the huddle (tag @you)`);
    };
    const num = (k: string) => {
      const v = url.searchParams.get(k);
      return v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
    };
    // start_huddle: the host ticket's own unattended run starts its review huddle, or its chat when the user asked (Huddles.startAuto checks the rest).
    if (rest.length === 1 && rest[0] === "auto" && m === "POST") {
      const [runSlug, ticketId] = (who.run ?? "").split("/");
      if (!who.run || who.agent || runSlug !== slug || !ticketId) {
        throw new HttpError(403, "only a board run of the host ticket can start an auto huddle; propose a roster with propose_huddle instead");
      }
      const b = await body(req);
      const out = huddles.startAuto(slug, ticketId, {
        reason: typeof b.reason === "string" ? b.reason : "",
        trigger: typeof b.trigger === "string" ? b.trigger : undefined,
        template: typeof b.template === "string" && b.template.trim() ? b.template.trim() : undefined,
        roster: Array.isArray(b.roster) ? b.roster : undefined,
        maxCostUsd: b.maxCostUsd === undefined || b.maxCostUsd === null ? undefined : Number(b.maxCostUsd),
      });
      return json({ waiting: out.waiting, template: out.template, huddle: out.huddle ? huddles.view(slug, out.huddle) : null }, out.waiting ? 202 : 201);
    }
    if (rest.length === 0) {
      if (m === "GET") return json(huddles.list(slug, url.searchParams.get("ticket") ?? undefined));
      if (m === "POST") {
        userOnly("start a huddle (propose a roster with propose_huddle instead)");
        const b = await body(req);
        const ticketId = String(b.ticketId ?? "");
        if (!ticketId) throw new HttpError(400, "ticketId is required");
        // The ticket's run is doing the work (not a chat reply in Planning or Review): a huddle now would work alongside it.
        const host = store.getTicket(slug, ticketId);
        if (host && (host.status === "ready" || host.status === "in_progress") && board.isRunning(slug, ticketId)) parallelWork(req, b, "run-active");
        const h = huddles.create(slug, ticketId, Array.isArray(b.roster) ? b.roster : [], {
          maxParticipants: Number(b.maxParticipants) || undefined,
          maxCostUsd: b.maxCostUsd === undefined || b.maxCostUsd === null ? undefined : Number(b.maxCostUsd),
          template: typeof b.template === "string" && b.template.trim() ? b.template : undefined,
        });
        return json(huddles.view(slug, h), 201);
      }
      throw new HttpError(404, "not found");
    }
    const { h, me } = huddles.identify(slug, rest[0], who);
    const [, action, handle, sub, part, partId] = rest;
    if (!action && m === "GET") {
      const page = huddles.messages(slug, h.id, { before: num("before"), since: num("since"), limit: num("limit") });
      return json({ huddle: huddles.view(slug, h), you: me.handle, ...page });
    }
    if (m === "POST" && action === "messages" && !handle) {
      const b = await body(req);
      const kind = b.kind === "finding" ? "finding" : "message";
      const status = b.status ? { status: b.status, reason: typeof b.reason === "string" ? b.reason : undefined, lessons: b.lessons } : undefined;
      const src = req.headers.get(SOURCE_HEADER);
      return json(huddles.post(slug, h.id, me, String(b.text ?? ""), kind, status, src === "ui" || src === "mcp" ? src : "none"), 201);
    }
    // The pinned brief (goal, decisions): leads, @main and the user.
    if (m === "PUT" && action === "brief" && !handle) {
      const b = await body(req);
      return json(huddles.view(slug, huddles.setBrief(slug, h.id, me, String(b.text ?? ""))));
    }
    // A participant's own status: done, blocked (reason) or active again.
    if (m === "POST" && action === "status" && !handle) {
      const b = await body(req);
      const { token: _t, ...p } = huddles.setStatus(slug, h.id, me, b.status, typeof b.reason === "string" ? b.reason : undefined, b.lessons);
      return json(p);
    }
    // @main or a lead asks the user to close the huddle (only the user closes it).
    if (m === "POST" && action === "close-request" && !handle) {
      const b = await body(req);
      return json(huddles.view(slug, huddles.requestClose(slug, h.id, me, typeof b.reason === "string" ? b.reason : "")));
    }
    if (action === "participants") {
      if (m === "POST" && !handle) {
        const b = await body(req);
        const added = huddles.addParticipants(slug, h.id, me, b ?? {});
        return json({ added: added.map(({ token: _t, ...p }) => p), huddle: huddles.view(slug, huddles.get(slug, h.id)) }, 201);
      }
      if (m === "PATCH" && handle && !sub) {
        const b = await body(req);
        huddles.setMode(slug, h.id, me, handle, b.mode);
        return json(huddles.view(slug, huddles.get(slug, h.id)));
      }
      if (m === "POST" && handle && sub === "stop") {
        userOnly("stop a participant");
        huddles.stopParticipant(slug, h.id, handle);
        return json(huddles.view(slug, huddles.get(slug, h.id)));
      }
      // A participant's own Claude session, read-only (the Huddle tab's session viewer). The user's alone: agents
      // and runs can't read each other's sessions.
      if (handle && sub === "session") {
        userOnly("read a participant's session");
        if (m === "GET" && !part) {
          return json(participantSession(huddles, store, sessions, huddleSessions, slug, h.id, handle, { before: num("before"), since: num("since"), limit: num("limit") }));
        }
        if (m === "GET" && part === "tool" && partId) {
          const d = participantTool(huddles, sessions, slug, h.id, handle, partId);
          if (!d) throw new HttpError(404, "tool call not found");
          return json(d);
        }
        if (m === "POST" && part === "reveal" && !partId) {
          const file = participantSession(huddles, store, sessions, huddleSessions, slug, h.id, handle, { limit: 1 }).file;
          if (!file) throw new HttpError(404, `@${handle} has no transcript file yet`);
          await revealFile(file);
          return json({ ok: true, file });
        }
      }
      if (m === "POST" && handle && sub === "restart") {
        userOnly("restart a participant");
        huddles.restartParticipant(slug, h.id, handle);
        return json(huddles.view(slug, huddles.get(slug, h.id)));
      }
    }
    if (m === "POST" && !handle && (action === "stop" || action === "resume" || action === "close")) {
      userOnly(`${action} the huddle`);
      const b = action === "resume" ? await body(req) : {};
      const add = b?.addBudgetUsd === undefined || b?.addBudgetUsd === null ? 0 : Number(b.addBudgetUsd);
      const out = action === "stop" ? huddles.stopAll(slug, h.id) : action === "resume" ? huddles.resume(slug, h.id, add) : huddles.close(slug, h.id);
      return json(huddles.view(slug, out));
    }
    // The user viewed the huddle up to message `seq` (scrolled to the latest): what tagged them so far counts as seen.
    if (m === "POST" && action === "seen" && !handle) {
      userOnly("mark the huddle seen");
      const b = await body(req);
      return json(huddles.view(slug, huddles.markSeen(slug, h.id, Number(b?.seq))));
    }
    // A huddle agent proposes a teammate (propose_teammate): it waits under Learnings for the user.
    if (m === "POST" && action === "teammates" && !handle) return json(huddles.proposeTeammate(slug, h.id, me, await body(req)), 201);
    // Lessons agents proposed: only the user edits, saves (as role notes) or discards them.
    if (action === "learnings" && handle) {
      userOnly("save, edit or discard learnings");
      if (m === "POST" && sub === "discard") return json(huddles.discardLearning(slug, h.id, handle));
      const patch = async () => {
        const raw = await req.text();
        let b: any = {};
        try {
          if (raw.trim()) b = JSON.parse(raw) ?? {};
        } catch {
          throw new HttpError(400, "invalid JSON body");
        }
        return { text: b.text, scope: b.scope, target: b.target };
      };
      if (m === "PATCH" && !sub) return json(huddles.editLearning(slug, h.id, handle, await patch()));
      if (m === "POST" && sub === "save") return json(huddles.saveLearning(slug, h.id, handle, await patch()));
    }
    if (m === "POST" && action === "invite" && !handle) {
      const b = await body(req);
      const ticketId = String(b.ticketId ?? "");
      if (!ticketId) throw new HttpError(400, "ticketId is required");
      const { token: _t, ...p } = huddles.invite(slug, h.id, me, ticketId, typeof b.handle === "string" ? b.handle : undefined);
      return json(p, 201);
    }
    // Changes helpers hand in from their own copies: the helper hands in; a lead, @main or the user accepts or rejects.
    if (m === "POST" && action === "hand-ins" && !handle) {
      const b = await body(req);
      return json(await huddles.handIn(slug, h.id, me, typeof b.summary === "string" ? b.summary : ""), 201);
    }
    if (m === "POST" && action === "hand-ins" && handle && (sub === "accept" || sub === "reject") && !part) {
      const b = await body(req);
      return json(await huddles.reviewHandIn(slug, h.id, me, handle, sub === "accept", typeof b.reason === "string" ? b.reason : ""));
    }
    // A lead, @main or the user lets a helper change files (in its own copy of the folder).
    if (m === "POST" && action === "participants" && handle && sub === "allow-changes" && !part) {
      const { token: _t, ...p } = huddles.allowChanges(slug, h.id, me, handle);
      return json(p);
    }
    if (m === "POST" && action === "findings" && !handle) {
      const b = await body(req);
      const act = b.action === "add" || b.action === "resolve" ? b.action : "list";
      return json(huddles.findings(slug, h.id, me, act, { text: typeof b.text === "string" ? b.text : undefined, id: typeof b.id === "string" ? b.id : undefined }));
    }
    throw new HttpError(404, "not found");
  }

  /** What an event sends to the board's pages, built once per event and shared by every open tab. */
  const ssePayloads = new WeakMap<BusEvent, string>();
  const ssePayload = (e: BusEvent): string => {
    const hit = ssePayloads.get(e);
    if (hit !== undefined) return hit;
    let out: unknown = e;
    if (e.type === "ticket.updated") {
      const p = store.getProfile(e.profile);
      if (p) out = { ...e, ticket: view(p, e.ticket) };
    }
    let msg = `data: ${JSON.stringify(out)}\n\n`;
    // Session changes (terminal chat, new questions) and the host's huddle change the ticket's "your turn" state too.
    const changed = e.type === "session.updated" ? { profile: e.profile, id: e.id }
      : e.type === "huddle.updated" ? { profile: e.profile, id: e.huddle.hostTicket } : null;
    if (changed) {
      const p = store.getProfile(changed.profile);
      const t = p && store.getTicket(changed.profile, changed.id);
      if (p && t) msg += `data: ${JSON.stringify({ type: "ticket.updated", profile: changed.profile, ticket: view(p, t) })}\n\n`;
    }
    ssePayloads.set(e, msg);
    return msg;
  };

  function sse(req: Request): Response {
    let unsubscribe = () => {};
    let ping: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (s: string) => {
          try {
            controller.enqueue(enc.encode(s));
          } catch {}
        };
        send(": connected\n\n");
        unsubscribe = bus.on((e: BusEvent) => send(ssePayload(e)));
        ping = setInterval(() => send(": ping\n\n"), 15_000);
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(ping);
          try {
            controller.close();
          } catch {}
        });
      },
      cancel() {
        unsubscribe();
        clearInterval(ping);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  function staticFile(url: URL): Response {
    const assets = deps.assets ?? {};
    if (Object.keys(assets).length) {
      const hit = assets[url.pathname] ?? assets["/index.html"];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(Bun.file(hit));
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(deps.webDir, rel);
    if (file.startsWith(deps.webDir) && existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
    const index = join(deps.webDir, "index.html");
    if (existsSync(index)) return new Response(Bun.file(index));
    return new Response("UI not built. Run: bun run build:web", { status: 404 });
  }

  function attachShell(ws: import("bun").ServerWebSocket<ShellSocket>, restart = false) {
    const d = ws.data;
    d.unsubscribe?.();
    let shell: Shell;
    try {
      shell = shells.get(d.slug, d.cwd, d.cols, d.rows, restart);
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: (e as Error).message }));
      return;
    }
    d.shell = shell;
    const back = shell.scrollback();
    if (back.length) ws.sendBinary(back);
    if (shell.exited) ws.send(JSON.stringify({ type: "exit", code: shell.exitCode }));
    else shell.resize(d.cols, d.rows);
    d.unsubscribe = shell.subscribe((e) => {
      if (e.type === "data") ws.sendBinary(e.data);
      else ws.send(JSON.stringify({ type: "exit", code: e.code }));
    });
  }

  async function handle(req: Request, srv: import("bun").Server<ShellSocket>, listener: Listener): Promise<Response | undefined> {
    const res = await track(routeLabel(req), () => route(req, srv, listener));
    if (res && listener === "remote") res.headers.set(LISTENER_HEADER, "remote");
    return res;
  }

  async function route(req: Request, srv: import("bun").Server<ShellSocket>, listener: Listener): Promise<Response | undefined> {
    const refusal = requestRefusal(req, server.port ?? deps.port, remote.active(), listener);
    if (refusal) return new Response(refusal, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    via.set(req, { listener, srv });
    if (listener === "remote") remote.noteVisit(nowIso());
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return staticFile(url);
    try {
      return (await api(req, url)) as Response;
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.confirm ? { confirm: e.confirm } : {}) }, e.status);
      if (e instanceof ConflictError) return json({ error: e.message }, 409);
      if (e instanceof McpError) return json({ error: e.message }, e.status);
      if (e instanceof AgentError) return json({ error: e.message }, e.status);
      if (e instanceof ScheduleError) return json({ error: e.message }, e.status);
      if (e instanceof LoopError) return json({ error: e.message }, e.status);
      if (e instanceof PassError) return json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, e.status);
      if (e instanceof JobError) return json({ error: e.message }, e.status);
      if (e instanceof SnippetError) return json({ error: e.message }, e.status);
      if (e instanceof HuddleError) return json({ error: e.message }, e.status);
      if (e instanceof RemoteError) return json({ error: e.message }, e.status);
      if (e instanceof QuickChatError) return json({ error: e.message }, e.status);
      if (e instanceof URIError) return json({ error: "malformed URL" }, 400);
      console.error(e);
      return json({ error: (e as Error).message ?? "internal error" }, 500);
    }
  }

  const websocket: import("bun").WebSocketHandler<ShellSocket> = {
    open: (ws) => attachShell(ws),
    message(ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return;
      }
      const shell = ws.data.shell;
      if (msg.type === "input" && typeof msg.data === "string") shell?.write(msg.data);
      else if (msg.type === "resize") {
        ws.data.cols = Math.min(1000, Math.max(1, Number(msg.cols) || 80));
        ws.data.rows = Math.min(1000, Math.max(1, Number(msg.rows) || 24));
        shell?.resize(ws.data.cols, ws.data.rows);
      } else if (msg.type === "restart") {
        // Another tab may already have restarted it: then just join the new shell.
        ws.send(JSON.stringify({ type: "reset" }));
        attachShell(ws, shells.current(ws.data.slug) === shell);
      }
    },
    close: (ws) => ws.data.unsubscribe?.(),
  };

  const server = Bun.serve<ShellSocket>({
    hostname: "127.0.0.1",
    port: deps.port,
    idleTimeout: 0,
    fetch: (req, srv) => handle(req, srv, "local"),
    websocket,
  });
  // Only `tailscale serve` connects here (it runs on this Mac); every request is checked as a tailnet request.
  // A busy port only costs phone access, never the board.
  let remoteServer: import("bun").Server<ShellSocket> | null = null;
  if (deps.remotePort !== undefined) {
    try {
      remoteServer = Bun.serve<ShellSocket>({
        hostname: "127.0.0.1",
        port: deps.remotePort,
        idleTimeout: 0,
        fetch: (req, srv) => handle(req, srv, "remote"),
        websocket,
      });
    } catch (e) {
      console.error(`phone access listener on 127.0.0.1:${deps.remotePort} failed: ${(e as Error).message}`);
    }
  }
  return Object.assign(server, { remoteServer });
}

/** A spending cap from a request: a positive amount, 0 for none (allowZero), null for the default. */
function capValue(v: unknown, allowZero: boolean): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) throw new HttpError(400, `spending cap must be a positive amount${allowZero ? ", 0 for none" : ""}, or null`);
  return n;
}

/** The board's Workspace setting from a request. */
function workspaceValue(v: unknown): Workspace {
  if (v !== "worktree" && v !== "folder") throw new HttpError(400, 'workspace must be "worktree" or "folder"');
  return v;
}
