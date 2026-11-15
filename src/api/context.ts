// The routes' shared context: the services createServer starts once (sessions, scheduler, huddles, notifier ...)
// and the helpers several route files use (view, profileOr404, runRights ...). Moved verbatim from http.ts.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pauser, track } from "../core/lag";
import { CommandRows } from "../board/cmdbar";
import { runArtifactJob, type ArtifactJob, type ArtifactOutcome } from "../runs/artifact";
import { claudeSessionFile, ConflictError, recoveryFor, type Board } from "../board/board";
import { ContextUsage, type ContextSpec } from "../chat/context-usage";
import type { Bus, BusEvent } from "../core/events";
import { isManager } from "../board/main-ticket";
import type { PrDeps } from "../runs/prpoller";
import { resumeCommand } from "../runs/prompts";
import { fromUserBrowser, outsideBoard } from "../integrations/guard";
import { Passes } from "../integrations/passes";
import { maskSaved, maskSavedJson } from "../integrations/board-keys";
import { liveJson } from "../runs/live-cut";
import { ckanbanShim } from "../integrations/script";
import { LoopManager } from "../schedules/loops";
import { QUICK_CHAT_HEADER, RUN_HEADER, Scheduler } from "../schedules/scheduler";
import { JobRunner } from "../schedules/jobs";
import { Snippets } from "../board/snippets";
import { Huddles } from "../huddle/huddle";
import { HuddleSessionCache } from "../huddle/huddle-session";
import { HUDDLE_HEADER, SOURCE_HEADER } from "../huddle/huddle-roster";
import { huddleAsk, huddleBusy, ticketAttention, userWaitReason, withSnooze } from "../helper/attention";
import { isComplete } from "../board/plan";
import type { GhRunner } from "../integrations/bugreport";
import { IMAGE_TYPES } from "../board/attachments";
import { ticketFolder, type FileRoot } from "../core/files";
import { boardToolsSource, McpManager } from "../integrations/mcp";
import { Notifier } from "../helper/notify";
import { HelperError, type HelperRunner } from "../helper/runner";
import type { DeviceUser } from "../browser/devices";
import { legacyChrome, ownPicks, resolveBrowserPicks } from "../browser/chromes";
import { PushService } from "../helper/push";
import { LOGIN_HEADER, RemoteAccess, remoteUrl, type RemoteConfig } from "../integrations/remote";
import { AgentRegistry } from "../integrations/agents";
import { collectLinks } from "../board/links";
import { findSessionFile, SessionCache, type SessionEntry, type SessionSummary } from "../runs/session";
import { toolOutputs, type ChatSource } from "../chat/chat-search";
import { ShellManager, type Shell } from "../browser/shell";
import { settleWorkflow, withRun, type WorkflowInfo } from "../runs/workflows";
import { QuickChats } from "../chat/quickchat";
import type { TerminalWatcher } from "../browser/terminals";
import { attachmentHeader, canCopyFile, markdownPage, markdownTitle } from "../board/share";
import { UpdateChecker } from "../core/update";
import { SpendIndex } from "../usage/spend";
import { makeSideCaller, type SideCaller } from "../runs/side-call";
import { Learner } from "../board/learner";
import { Simplifier } from "../chat/simplify";
import { Helper } from "../chat/explain";
import { ClaudeLogIndex, RunLogIndex, recordWindow } from "../usage/ticket-usage";
import { UsageCache } from "../usage/usage-cache";
import { fetchUsage, type UsageResult } from "../usage/usage";
import { Linker } from "../board/linker";
import { familyOf, featureRoot, openFeatures, parentLink } from "../../web/src/features/family/family";
import type { Store } from "../core/store";
import { byIdNewest, scopeIndex, type ScopeIndex } from "../board/ticket-scope";
import { runCapFor, type Profile, type Ticket, type Workspace } from "../core/types";
import { nowIso } from "../core/util";
import { frontInfo } from "../core/front";
import type { Server } from "bun";


/** A chat on another board acting for the user here (see runRights): its board and ticket. */
export interface Guest {
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
  /**
   * Whether a local request comes from a program the daemon didn't start (the user's own Claude or terminal): only
   * that, or the user's browser, may delete a schedule (integrations/guard.ts outsideBoard). Tests pass a fake.
   */
  isOutsideBoard?: (peerPort: number) => Promise<boolean>;
  jobs?: JobRunner;
  agents?: AgentRegistry;
  huddles?: Huddles;
  /** What the board learns on its own (learner.ts); the daemon passes its started one. */
  learner?: Learner;
  quickChats?: QuickChats;
  /** The Context panel's checks (tests pass one on a fake claude). */
  contexts?: ContextUsage;
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
  /** The helper runner (helper/runner.ts): its status, settings, feedback list and the message buttons. */
  helper?: HelperRunner;
  /** Parent suggestions and Find links (linker.ts); tests pass one on a fake side call. */
  linker?: Pick<Linker, "suggest" | "find">;
}

/** A Share menu publish in progress, or the error of the last one, per output file. Not persisted. */
export interface ShareJob {
  file: string;
  state: "publishing" | "failed";
  error?: string;
  at: string;
}

export interface ShellSocket {
  slug: string;
  /** The ticket whose copy of the folder the shell runs in; null: the board folder. */
  folder: string | null;
  cwd: string;
  cols: number;
  rows: number;
  shell?: Shell;
  unsubscribe?: () => void;
}

export class HttpError extends Error {
  /** confirm: the UI asks the user and resends with `confirmParallel: true` (see parallelWork). */
  constructor(public status: number, message: string, public confirm?: string) {
    super(message);
  }
}

/**
 * The UI is about to make a run and a huddle work the same ticket at once: refused with a question the UI asks
 * ("Start anyway?"), unless the user already said yes (confirmParallel). Other callers (runs, CLI) aren't asked.
 */
export function parallelWork(req: Request, b: any, what: "huddle-open" | "run-active"): void {
  if (req.headers.get(SOURCE_HEADER) !== "ui" || req.headers.get(RUN_HEADER) || b?.confirmParallel === true) return;
  throw new HttpError(409, what === "huddle-open"
    ? "A huddle is already working on this ticket."
    : "This ticket's run is already working on it.", what);
}

export const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
/** Output extensions served with their image type (raster only) so the Outputs tab can preview them. */
export const OUTPUT_IMAGE_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t])),
  jpeg: "image/jpeg",
};

/** Plain text + sandbox: files are written by Claude and must never run as HTML on this origin.
 * Only raster images get their real type so a viewer can preview them; SVG stays text (it can carry scripts). */
export function rawFile(file: string, download: boolean): Response {
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
export function fileRoots(profile: Profile, t: Ticket, outputs: string): FileRoot[] {
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

/** The `name` of a PUT /api/avatars/claude/name body; anything but {name: text or null} is a 400. */
export function claudeNameOf(b: unknown): unknown {
  if (!b || typeof b !== "object" || Array.isArray(b) || !("name" in b)) throw new HttpError(400, "send {\"name\": \"...\"}");
  return (b as { name: unknown }).name;
}

export async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

/** A folder as the OS sees it (symlinks, trailing slash, letter case); the path as written when it doesn't exist. */
export function realFolder(path: string): string {
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


/** A spending cap from a request: a positive amount, 0 for none (allowZero), null for the default. */
export function capValue(v: unknown, allowZero: boolean): number | null {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) throw new HttpError(400, `spending cap must be a positive amount${allowZero ? ", 0 for none" : ""}, or null`);
  return n;
}

/** The board's Workspace setting from a request. */
export function workspaceValue(v: unknown): Workspace {
  if (v !== "worktree" && v !== "folder") throw new HttpError(400, 'workspace must be "worktree" or "folder"');
  return v;
}


/** A route file's answer when the request isn't one of its routes: the next route file gets it. */
export const NEXT = Symbol("next route");
export type RouteResult = Response | undefined | typeof NEXT;

export function createContext(deps: ServerDeps) {
  // Set by createServer once it has them (Bun.serve's servers, its dispatcher); only read while answering requests.
  let server!: Server<ShellSocket>;
  /** The board's port as callers see it: the Rust front server's when the daemon runs behind it (core/front.ts). */
  const publicPort = () => frontInfo()?.publicPort ?? server.port ?? deps.port;
  let remoteServer: Server<ShellSocket> | null = null;
  let api!: (req: Request, url: URL) => Promise<Response | undefined>;
  const { store, bus, board } = deps;
  // Every JSON reply hides the keys saved on this Mac (a run that printed one, a pasted key): tool rows, subagents,
  // workflows, chat search and the rest, not only the conversation.
  /** Key boxes being saved right now ("<board>/<ticket>/<box>"). */
  const keyCardsInFlight = new Set<string>();
  const json = (data: unknown, status = 200): Response =>
    new Response(maskSavedJson(store.root, JSON.stringify(data)), { status, headers: { "content-type": "application/json" } });
  const sessions = deps.sessions ?? new SessionCache();
  const huddleSessions = new HuddleSessionCache();
  const updates = deps.updates ?? new UpdateChecker();
  const shells = deps.shells ?? new ShellManager();
  const mcp = deps.mcp ?? new McpManager(bus, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", boards: boardToolsSource(store) });
  const scheduler = deps.scheduler ?? new Scheduler(board, store, bus);
  const jobs = deps.jobs ?? new JobRunner(board, store, bus);
  // The address a service sends the user back to after signing in: always localhost, on this board's port.
  const callbackUrl = () => `http://localhost:${publicPort()}/api/passes/oauth/callback`;
  const passes = deps.passes ?? new Passes(store.root, bus, { fetch: globalThis.fetch, now: () => new Date() }, callbackUrl);
  const agents = deps.agents ?? new AgentRegistry();
  /**
   * More → Browsers, one state for both kinds: the Claude in Chrome Chromes (chromes.ts), the board's own browsers
   * (board-browsers.ts) with whether Google Chrome is installed, and each board's list.
   */
  const browsersView = () => {
    const own = board.boardBrowsers.view();
    return {
      ...board.chromes.view(),
      boardBrowsers: own.browsers, chrome: own.chrome,
      boards: store.listProfiles().map((p) => ({ slug: p.slug, name: p.name, chrome: p.chrome ?? null, browsers: ownPicks(p) })),
    };
  };
  const knownBrowsers = { chrome: (id: string) => !!board.chromes.get(id), board: (id: string) => !!board.boardBrowsers.get(id) };
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
    prepare: async (t) => void (t.sessionId && (await sessions.readIn(t.sessionId, pauser(), { parse: true }))),
  });
  const huddles = deps.huddles ?? new Huddles(store, board, bus, {
    claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", learn: (slug, h, p, role, lessons) => void learner.addHuddleLessons(slug, h, p, role, lessons),
    entries: (t) => (t.sessionId ? sessions.get(t.sessionId)?.entries : null) ?? [],
  });
  const quickChats = deps.quickChats ?? new QuickChats(store, bus, board, { claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude" });
  // The Context panel (context-usage.ts): `/context` on a throwaway copy of the chat's session, cached per chat.
  const contexts = deps.contexts ?? new ContextUsage({
    claudeBin: process.env.CKANBAN_CLAUDE_BIN ?? "claude", sessionFile: claudeSessionFile,
    // Saved next to the ticket's or chat's own files, only while it exists (a delete takes the file with it).
    file: (key) => {
      const [kind, profile, id] = key.split("/") as ["ticket" | "chat", string, string];
      if (kind === "chat") return quickChats.exists(profile, id) ? quickChats.contextPath(profile, id) : null;
      return store.getTicket(profile, id) ? store.contextPath(profile, id) : null;
    },
    changed: (key) => {
      const [kind, profile, id] = key.split("/") as ["ticket" | "chat", string, string];
      bus.emit({ type: "context.updated", profile, kind, id });
    },
  });
  /** After every run of a chat with a session, the panel's numbers are checked in the background (a few at a time). */
  const contextAfterRun = (kind: "ticket" | "chat", spec: (slug: string, id: string) => ContextSpec | null) => (slug: string, id: string) => {
    const key = `${kind}/${slug}/${id}`;
    let s: ContextSpec | null = null;
    try {
      s = spec(slug, id);
    } catch {}
    if (s) contexts.schedule(key, s);
  };
  board.onRunEnd(contextAfterRun("ticket", (s, id) => board.contextSpec(s, id)));
  quickChats.onRunEnd(contextAfterRun("chat", (s, id) => quickChats.contextSpec(s, id)));
  /** GET: the cached result; POST: a fresh check (shared with one already running), answered once it is over. */
  /** session: the session spec() would name, when that is cheaper to find than the whole spec (a GET needs only it). */
  const contextRoute = async (req: Request, kind: "ticket" | "chat", slug: string, id: string, spec: () => ContextSpec | null, what: string, session?: () => string | null): Promise<Response> => {
    const key = `${kind}/${slug}/${id}`;
    if (req.method === "POST") {
      await userOnly(req, what);
      let s: ContextSpec | null;
      try {
        s = spec();
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
      if (s) await contexts.refresh(key, s);
      return json(contexts.view(key, s?.sessionId ?? null));
    }
    let sessionId: string | null = null;
    try {
      sessionId = session ? session() : spec()?.sessionId ?? null;
    } catch {}
    return json(contexts.view(key, sessionId));
  };
  const snippets = new Snippets(store, bus);
  const windowsFile = join(store.root, "usage-windows.json");
  // Saved last good answer and backoff, so a restart neither forgets the numbers nor asks Anthropic again at once.
  const usage = new UsageCache(deps.usage ?? fetchUsage, (r) => recordWindow(windowsFile, r), Date.now, join(store.root, "usage-last.json"),
    deps.usage ? undefined : (line) => console.log(line));
  const spend = new SpendIndex(store);
  // A main ticket's card and result cards count what its family spent.
  board.onCost((s, id) => spend.ticket(s, id).costUsd + huddles.ticketSpend(s, id).costUsd);
  // A main ticket's card: a family ticket whose log isn't counted yet (after a restart) is read in the background, and
  // the main tickets above it are sent again once it is (batched: a family's tickets finish one after another).
  const costed = new Map<string, Set<string>>();
  let costTimer: ReturnType<typeof setTimeout> | null = null;
  const sendCosted = () => {
    costTimer = null;
    for (const [slug, ids] of costed) {
      const mains = new Set<string>();
      for (const id of ids) {
        if (own.delete(`${slug}/${id}`)) mains.add(id);
        const seen = new Set<string>();
        for (let t = store.getTicket(slug, id); t && !seen.has(t.id); ) {
          seen.add(t.id);
          const up = parentLink(t);
          t = up ? store.getTicket(slug, up.id) : null;
          if (t?.main) mains.add(t.id);
        }
      }
      for (const id of mains) {
        const t = store.getTicket(slug, id);
        if (t) board.emitTicket(slug, t);
      }
    }
    costed.clear();
  };
  const counted = (s: string, id: string) => {
    let ids = costed.get(s);
    if (!ids) costed.set(s, (ids = new Set()));
    ids.add(id);
    costTimer ??= setTimeout(() => track("spend: send family costs", sendCosted), 300);
  };
  board.familyCostOf = (s, id) => spend.ticketSoon(s, id, () => counted(s, id)) + huddles.ticketSpend(s, id).costUsd;
  // A Review or In Progress card's own cost: the same, and that card is sent again once its log is counted.
  const own = new Set<string>();
  const cardCost = (s: string, id: string) => spend.ticketSoon(s, id, () => {
    own.add(`${s}/${id}`);
    counted(s, id);
  });
  const loops = deps.loops ?? new LoopManager(store, bus, board, passes, {
    now: () => new Date(), sideCall, shimDir: () => ckanbanShim(store.root), port: () => publicPort(),
  });
  const isUserBrowser = deps.isUserBrowser ?? ((peerPort: number) => fromUserBrowser(peerPort));
  const isOutsideBoard = deps.isOutsideBoard ?? ((peerPort: number) => outsideBoard(peerPort));
  /** Requests the front desk replays after the user's Confirm tap in Telegram: they act as the user. */
  const confirmedInTelegram = new WeakSet<Request>();
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
    if (!(await isUserBrowser(v?.peer ?? 0))) throw new HttpError(403, refusal);
  };
  /**
   * Who may really delete a schedule: the user, from the Schedules window (their browser, as userOnly checks), their
   * own Claude or terminal outside the board (a program the daemon didn't start), or a front desk request they
   * confirmed in Telegram. Not a board run or chat, a quick chat, a huddle helper, a run's shell or a job's command:
   * Claude's delete_schedule in a ticket's chat shows the user a card instead (the schedule-delete-cards route). A
   * process a run detached from the daemon can't be told apart (integrations/guard.ts).
   */
  const scheduleDeleter = async (req: Request) => {
    if (confirmedInTelegram.has(req)) return;
    if (req.headers.get(RUN_HEADER) || req.headers.get(HUDDLE_HEADER)) {
      throw new HttpError(403, "a board run or chat can't delete a schedule: call delete_schedule, which shows the user a card to confirm, " +
        "or pause it with update_schedule enabled=false");
    }
    const refusal = "only the user deletes a schedule (in the board's Schedules window): a quick chat, a run's shell or a job's command can't. " +
      "Pause it with update_schedule enabled=false, or ask the user to delete it in Schedules.";
    if (req.headers.get(QUICK_CHAT_HEADER)) throw new HttpError(403, refusal);
    // From a page: the user's browser (or their phone over remote access), as for every user-only action.
    if (req.headers.get("origin")) return userOnly(req, "Deleting a schedule");
    const v = via.get(req);
    if (v?.listener === "remote") throw new HttpError(403, refusal);
    if (!(await isOutsideBoard(v?.peer ?? 0))) throw new HttpError(403, refusal);
  };  const simplifier = new Simplifier(store, sideCall);
  const helper = new Helper(store, sideCall);
  const linker = deps.linker ?? new Linker(store, board, sideCall);
  /** Looks for a parent for a ticket the user made, in the background (it never holds up saving). */
  const suggestParent = (slug: string, id: string) => {
    linker.suggest(slug, id).catch((e) => console.error(`suggesting a parent for ${slug}/${id}: ${(e as Error).message}`));
  };
  const claudeLogs = deps.claudeLogs ?? new ClaudeLogIndex();
  const runLogs = new RunLogIndex();
  const publishArtifact = deps.publishArtifact ?? ((job: ArtifactJob) => runArtifactJob(job));
  // No listener (not bound): 0, so `on` refuses instead of pointing serve at whatever holds the port.
  const remote = deps.remote ?? new RemoteAccess(store.root, () => remoteServer?.port ?? 0);
  // The listener each request came in on, for the routes that care (WebSocket upgrades, /api/remote).
  // `peer`: the caller's TCP port on the local listener (the front server's header behind it, core/front.ts); 0 on remote.
  const via = new WeakMap<Request, { listener: Listener; srv: import("bun").Server<ShellSocket>; peer: number }>();
  const listenerOf = (req: Request): Listener => via.get(req)?.listener ?? "local";
  /** Notification settings plus whether this request is from this Mac (phone access can't turn Telegram back on or pair). */
  const notifyView = <T extends object>(req: Request, st: T): T & { local: boolean } => ({ ...st, local: listenerOf(req) === "local" });
  const push = deps.push ?? new PushService(store.root);
  const notifier = deps.notifier ?? new Notifier(store, bus, {
    root: store.root, push, sessionSummary: (id) => sessions.summary(id), isRunning: (s, id) => board.isRunning(s, id),
    hostHuddles: (s) => board.hostHuddles(s), baseUrl: () => (remote.active() ? remoteUrl(remote.active()!.host) : `http://localhost:${publicPort()}`),
  });
  if (!deps.notifier) notifier.plugBoard(board);
  // The front desk lives in the quick chats; a tap on its Confirm runs the held request here, as the user.
  notifier.frontDesk.plug({
    chats: quickChats,
    replay: async (method, path, b) => {
      const u = new URL(`http://127.0.0.1${path}`);
      const replayed = new Request(u.href, { method, ...(b === null || b === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(b) }) });
      confirmedInTelegram.add(replayed);
      const r = await api(replayed, u).catch((e) => {
        const status = e instanceof ConflictError ? 409 : typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 500;
        return json({ error: (e as Error).message }, status);
      });
      if (!r) return { status: 404, body: { error: "not found" } };
      const text = await r.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      return { status: r.status, body: data };
    },
  });
  const helperRunner = deps.helper ?? null;
  const helperOr503 = (): HelperRunner => {
    if (!helperRunner) throw new HttpError(503, "the helper isn't running");
    return helperRunner;
  };
  const helperCall = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof HelperError) throw new HttpError(e.status, e.message);
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  };
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
   * - a main ticket (or tool group) on its own family: any of its runs but a quiet reply (Board.plannerRights):
   *   returned as `planner`;
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
      throw new HttpError(403, `${target!.id} is not in the family of ${planner.id}; a main ticket may only change its own tool tickets`);
    }
    throw new HttpError(403, "changing the board is disabled inside a board run that isn't working right now (or is a Planning chat " +
      "without the user's message, a reply to another ticket's question or a huddle helper): only a ticket's active run or chat reply, " +
      "a Planning chat answering the user's message, and a main ticket on its own tool tickets may change other tickets");
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
  /**
   * Reads these transcripts in slices (a chunk, then a pause) before a route parses them with sessions.get(): opening a
   * chat whose transcript isn't parsed yet (tens of MB) otherwise froze the daemon for as long as the whole parse.
   */
  const readSessionsIn = async (ids: (string | null | undefined)[]) => {
    const pause = pauser();
    for (const id of ids) if (id) await sessions.readIn(id, pause, { parse: true });
  };
  /** readSessionsIn for a ticket's chat: every session left behind with "Send in a fresh chat", then the current one. */
  const readChatIn = (t: Ticket) => readSessionsIn([...(t.earlierSessions ?? []).map((s) => s.sessionId), t.sessionId]);
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
  /** A run's start of another ticket's run (target; null for a new ticket), refused only for a loop (Board.runStart). */
  const runStart = (slug: string, runner: Ticket, target: string | null = null): NonNullable<Ticket["startedBy"]> => {
    try {
      return board.runStart(slug, runner.id, target);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  };
  /** A guest's start of a run here: counted against the guest's ticket on its own board (Board.runStart). */
  const guestStart = (g: Guest, target: string | null = null): NonNullable<Ticket["startedBy"]> => ({ ...runStart(g.slug, g.ticket, target), slug: g.slug });
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
  /**
   * What the ticket routes and the Inbox work out from a board's whole ticket list (families, the Done column's order,
   * open features, the tickets the Inbox looks at), kept while the listing holds the very same tickets: they are
   * shared and frozen, so any change is a new object or a new order. Rebuilding it walked and sorted every ticket,
   * thousands of them Done, on each load, page and Inbox poll.
   */
  type BoardIndex = { tickets: Ticket[]; scope: ScopeIndex<Ticket>; features: Set<string>; inboxable: Ticket[]; newest: Ticket[] };
  const boardIndexes = new Map<string, BoardIndex>();
  const cmdRows = new CommandRows(store, (slug, id) => board.isRunning(slug, id));
  /** Each part is worked out the first time it is asked for: the Inbox needs only its filter, not the Done sort. */
  const boardIndex = (slug: string, tickets = store.listTickets(slug)): BoardIndex => {
    const hit = boardIndexes.get(slug);
    if (hit && hit.tickets.length === tickets.length && hit.tickets.every((t, i) => t === tickets[i])) return hit;
    let scope: ScopeIndex<Ticket> | undefined;
    let features: Set<string> | undefined;
    let inboxable: Ticket[] | undefined;
    let newest: Ticket[] | undefined;
    const built: BoardIndex = {
      tickets,
      // list_tickets' order (newest first by id), sorted once per listing instead of per page.
      get newest() {
        return (newest ??= byIdNewest(tickets));
      },
      get scope() {
        return (scope ??= scopeIndex(tickets));
      },
      // Open features (feature.ts) are marked, so list_tickets can show which work to add new tickets to.
      get features() {
        return (features ??= new Set(openFeatures(tickets).map((f) => f.top.id)));
      },
      // Done waits on the user only for a missed follow-up (see ownAttention).
      get inboxable() {
        return (inboxable ??= tickets.filter((t) => t.status !== "done" || !!t.followUp?.missedAt));
      },
    };
    boardIndexes.set(slug, built);
    return built;
  };
  /**
   * Most entries the per-ticket caches below keep (least recently used go first): well over a board's open tickets
   * plus the Done pages a user opens, so a board of any size stays a few MB.
   */
  const VIEW_CACHE_MAX = 3000;
  const remember = <V>(m: Map<string, V>, k: string, v: V): V => {
    m.delete(k);
    m.set(k, v);
    if (m.size > VIEW_CACHE_MAX) m.delete(m.keys().next().value!);
    return v;
  };
  /** Its card can show other tickets (its plan, its main ticket, the feature above it, a Chrome picked above it). */
  const crossTicket = (t: Ticket) => !!(t.parentId || t.partOf || t.tool || t.main || t.plan);
  /**
   * Each ticket's waiting-on-the-user state before a snooze, kept while nothing it is worked out from changed: the
   * ticket (frozen: a change is a new object), its session summary, its run, its huddle, and for a ticket that looks
   * at others (plan, steps, feature) the board's tickets and runs. The Inbox polls this every few seconds per tab
   * while runs work; recomputing all of it was most of that poll.
   */
  const attentionMemo = new Map<string, { t: Ticket; key: string; a: ReturnType<typeof ticketAttention> }>();
  /** hosts: the board's open huddles by host ticket, when the caller already has them (one read per board). */
  /** Whether the ticket waits on the user ("Your turn", the Inbox) and whether that is snoozed. */
  /** sessionKey: the summary as JSON when the caller has it (the caches' key). */
  const attentionOf = (p: Profile, t: Ticket, hosts: ReturnType<typeof board.hostHuddles>, running: boolean, session: SessionSummary | null, sessionKey = session ? JSON.stringify(session) : "") => {
    const huddle = hosts.get(t.id);
    const raw = () => ticketAttention(store, p.slug, t, session, running, huddle, (x) => board.isRunning(p.slug, x));
    let a: ReturnType<typeof ticketAttention>;
    // Waiting on a schedule delete reads the board's schedules: rare, worked out each time.
    if (session?.pendingScheduleDeletes?.length) a = raw();
    else {
      const cross = crossTicket(t);
      const key = [sessionKey, running ? 1 : 0, huddle ? JSON.stringify(huddle) : "", cross ? `${store.ticketsVersion(p.slug)}|${board.runningKey(p.slug)}` : ""].join("\u0000");
      const id = `${p.slug}/${t.id}`;
      const hit = attentionMemo.get(id);
      a = hit && hit.t === t && hit.key === key ? hit.a : remember(attentionMemo, id, { t, key, a: raw() }).a;
    }
    return withSnooze(t, session, a, Date.now(), huddle);
  };
  /**
   * The parts of each ticket's card that cost reads (Claude's comments for its links, the tickets above it), kept
   * while nothing they come from changed: the ticket, its session summary, its huddles' teammates, Claude's comments
   * (Store.commentStamp), and the board's tickets for a ticket that shows others. Everything about runs, devices,
   * spending and the time is worked out for every view. A board's first load built every open card from scratch on
   * each load and reconnect.
   */
  /**
   * The tickets above a card (its plan's, its main ticket's and feature's chain, by parentId and by partOf), from the
   * listing without a file stat: what its cross-ticket parts are worked out from. Frozen, so a change is a new object.
   */
  const ticketsAbove = (slug: string, t: Ticket): Ticket[] => {
    const out: Ticket[] = [];
    for (const next of [(x: Ticket) => parentLink(x)?.id, (x: Ticket) => x.parentId]) {
      const seen = new Set([t.id]);
      for (let cur: Ticket | undefined = t, up = next(t); up && !seen.has(up); up = cur && next(cur)) {
        seen.add(up);
        cur = store.peekTicket(slug, up);
        if (cur) out.push(cur);
      }
    }
    return out;
  };
  const viewParts = new Map<string, { t: Ticket; key: string; above: Ticket[]; links: ReturnType<typeof ticketLinks>; resume: string | null;
    browsersAbove: ReturnType<typeof resolveBrowserPicks> | null; subFeatureOf?: { id: string; title: string } | null; mainTicket?: { id: string; title: string } | null }>();
  const partsOf = (p: Profile, t: Ticket, session: SessionSummary | null, sessionKey: string) => {
    const mates = teammatesOf(p.slug, t.id);
    const build = () => ({
      links: ticketLinks(p.slug, t, session),
      resume: t.sessionId ? resumeCommand(t.workdir ?? t.worktree ?? p.path, t.sessionId) : null,
      /** The browsers a ticket above it set (an old single Chrome reads as a list of one); null: the board's. */
      browsersAbove: t.parentId ? resolveBrowserPicks({ id: t.id, parentId: t.parentId }, store.listTickets(p.slug), null) : null,
      subFeatureOf: t.main && parentLink(t) ? (() => {
        const up = store.getTicket(p.slug, parentLink(t)!.id);
        const top = up ? featureRoot(store.listTickets(p.slug), up.id) : undefined;
        return top ? { id: top.id, title: top.title } : null;
      })() : undefined,
      mainTicket: t.tool ? (() => {
        const m = board.mainOf(p.slug, t);
        return m ? { id: m.id, title: m.title } : null;
      })() : undefined,
    });
    // Huddle teammates' artifacts come from their own sessions: those cards are built each time (few tickets host one).
    if (mates.length) return build();
    // A card that shows other tickets is keyed on the tickets above it, not on the whole board: a write to any other
    // ticket made every such card rebuild and read its comment file again on the next Inbox poll and board load.
    const key = [sessionKey, store.commentStamp(p.slug, t.id), p.path].join("\u0000");
    const above = crossTicket(t) ? ticketsAbove(p.slug, t) : [];
    const id = `${p.slug}/${t.id}`;
    const hit = viewParts.get(id);
    if (hit && hit.t === t && hit.key === key && hit.above.length === above.length && hit.above.every((x, i) => x === above[i])) return remember(viewParts, id, hit);
    return remember(viewParts, id, { t, key, above, ...build() });
  };
  const view = (p: Profile, t: Ticket, hosts = board.hostHuddles(p.slug)) => {
    const running = board.isRunning(p.slug, t.id);
    const session = t.sessionId ? sessions.summary(t.sessionId) : null;
    const sessionKey = session ? JSON.stringify(session) : "";
    const huddle = hosts.get(t.id);
    const { attention, snoozed } = attentionOf(p, t, hosts, running, session, sessionKey);
    const parts = partsOf(p, t, session, sessionKey);
    // Its own huddle works on it while its own run doesn't, and asks nothing of the user ("Needs you" wins).
    const huddleWorks = !running && t.status !== "in_progress" && huddleBusy(huddle) && !huddleAsk(huddle);
    // The browsers a ticket above it set (worked out once per card in partsOf, for both fields).
    const above = parts.browsersAbove;
    return {
      ...t,
      running,
      /** Its run is a working run (Planning and peer replies aren't). */
      holdsSlot: running && board.holdsSlot(p.slug, t.id),
      resumeCommand: parts.resume,
      session,
      /** Artifacts and share links, newest first: the Outputs tab's Links, the header chips and the card's ↗ chip. */
      links: parts.links,
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
      /** The Chrome a ticket above it picked (a tool step follows its main ticket's), shown as its default; null: the board's. */
      chromeAbove: legacyChrome(above),
      /** The browser list a ticket above it set (a tool step follows its main ticket's), shown as its default; null: the board's. */
      browsersAbove: above,
      /** It would start now but another ticket is editing the board's folder in place (see Board.folderBusy). */
      folderWait: board.folderWait(p.slug, t),
      /** A plan child waiting on the user (never started by the plan until then). */
      userWait: t.parentId && !isComplete(t) ? userWaitReason(t, session) : null,
      attention,
      /** Snoozed from the Inbox: what it waits for and until when (attention is null meanwhile). */
      snoozed,
      /** Its own huddle is working on it: the card shows its huddle line instead of an outcome badge. */
      huddleBusy: huddleWorks,
      /** What the card's huddle line counts while huddleBusy (helpers working and in the huddle, open findings); null otherwise. */
      huddleLine: huddleWorks && huddle ? { working: huddle.helpersWorking ?? huddle.working, helpers: huddle.helpers ?? huddle.working, findings: huddle.findings ?? 0 } : null,
      /** API-equivalent $ so far (the Usage tab's total: its runs and its huddles' teammates), for In Progress and Review cards. */
      costUsd: running || t.status === "in_progress" || t.status === "review" ? cardCost(p.slug, t.id) + huddles.ticketSpend(p.slug, t.id).costUsd : null,
      /** Spending cap its next work run gets (null: none). */
      runCap: runCapFor(t, p),
      /** A main ticket: its tool tickets working now (the card shows In progress meanwhile, wherever the user put it). */
      ...(t.main ? { familyWorking: board.familyWorking(p.slug, t.id), stepsRunning: board.stepsRunning(p.slug, t.id), familyCard: board.familyCard(p.slug, t.id) } : {}),
      /** A sub-feature (a main ticket linked under another): the feature it is part of, for its "Part of …" chip. */
      ...(t.main && parentLink(t) ? { subFeatureOf: parts.subFeatureOf } : {}),
      /** A "with you" tool ticket's main ticket: its card's "↳ feature" chip; any tool ticket's chat names it. */
      ...(t.tool ? { mainTicket: parts.mainTicket } : {}),
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

  /** What an event sends to the board's pages, built once per event and shared by every open tab. */
  const ssePayloads = new WeakMap<BusEvent, string>();
  const ssePayload = (e: BusEvent): string => {
    const hit = ssePayloads.get(e);
    if (hit !== undefined) return hit;
    // Tracked, so a slow card build here is named in a freeze's [lag] line (it runs inside the event, not a request).
    return track(`events: ${e.type}`, () => ssePayloadOf(e));
  };
  const ssePayloadOf = (e: BusEvent): string => {
    let out: unknown = e;
    if (e.type === "ticket.updated") {
      const p = store.getProfile(e.profile);
      if (p) out = { ...e, ticket: view(p, e.ticket) };
    }
    // A run's raw event goes out without its long strings (big tool results): see liveCut.ts.
    let msg = `data: ${e.type === "activity" ? liveJson(out, (t) => maskSaved(store.root, t)) : JSON.stringify(out)}\n\n`;
    // Session changes (terminal chat, new questions) and the host's huddle change the ticket's "your turn" state too.
    const changed = e.type === "session.updated" ? { profile: e.profile, id: e.id }
      : e.type === "huddle.updated" ? { profile: e.profile, id: e.huddle.hostTicket } : null;
    if (changed) {
      const p = store.getProfile(changed.profile);
      const t = p && store.getTicket(changed.profile, changed.id);
      if (p && t) msg += `data: ${JSON.stringify({ type: "ticket.updated", profile: changed.profile, ticket: view(p, t) })}\n\n`;
    }
    // Live events (run activity, drafts, huddle messages) carry run output: saved keys are hidden there too.
    msg = maskSavedJson(store.root, msg);
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

  /**
   * The folder a Terminal or Files panel works in: with a ticket id, that board ticket's own copy of the folder when it
   * still exists, else the board folder. The path always comes from the board's records, never from the request.
   */
  function panelFolder(slug: string, boardPath: string, ticketId: string | null): { root: string; ticket: string | null } {
    if (!ticketId) return { root: boardPath, ticket: null };
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(ticketId)) throw new HttpError(400, "invalid ticket");
    const t = store.getTicket(slug, ticketId);
    if (!t) throw new HttpError(404, "ticket not found");
    return ticketFolder(boardPath, t);
  }

  return {
    deps,
    store,
    bus,
    board,
    keyCardsInFlight,
    json,
    sessions,
    huddleSessions,
    updates,
    shells,
    mcp,
    scheduler,
    jobs,
    callbackUrl,
    passes,
    agents,
    browsersView,
    knownBrowsers,
    sideCall,
    chatEntries,
    learner,
    huddles,
    quickChats,
    contexts,
    contextAfterRun,
    contextRoute,
    snippets,
    windowsFile,
    usage,
    spend,
    loops,
    isUserBrowser,
    isOutsideBoard,
    confirmedInTelegram,
    workflowView,
    userOnly,
    scheduleDeleter,
    simplifier,
    helper,
    linker,
    suggestParent,
    claudeLogs,
    runLogs,
    publishArtifact,
    remote,
    via,
    publicPort,
    listenerOf,
    notifyView,
    push,
    notifier,
    helperRunner,
    helperOr503,
    helperCall,
    shareJobs,
    profileOr404,
    ticketOr404,
    runRights,
    otherBoard,
    askedBy,
    runBoard,
    ownRun,
    chatReach,
    readSessionsIn,
    readChatIn,
    chatSources,
    inFamily,
    byRequest,
    byRun,
    byGuest,
    byChat,
    startsRun,
    runStart,
    guestStart,
    runTicket,
    strings,
    teammates,
    teammatesOf,
    ticketLinks,
    boardIndexes,
    cmdRows,
    boardIndex,
    VIEW_CACHE_MAX,
    remember,
    crossTicket,
    attentionMemo,
    attentionOf,
    ticketsAbove,
    viewParts,
    partsOf,
    view,
    deviceViews,
    emitTicket,
    startPublish,
    ssePayloads,
    ssePayload,
    sse,
    panelFolder,
    get server() { return server; },
    get remoteServer() { return remoteServer; },
    bind(o: { server?: Server<ShellSocket>; remoteServer?: Server<ShellSocket> | null; api?: (req: Request, url: URL) => Promise<Response | undefined> }) {
      if (o.server) server = o.server;
      if ("remoteServer" in o) remoteServer = o.remoteServer ?? null;
      if (o.api) api = o.api;
    },
  };
}

export type ApiContext = ReturnType<typeof createContext>;
