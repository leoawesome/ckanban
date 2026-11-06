import { boardConnectorOptions } from "./connectors";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { extractFinalText, summarizeEvent } from "./activity";
import { copyAttachments, deleteAttachments, localizeAttachments, localizeUrls, referencedAttachments } from "./attachments";
import type { Bus } from "./events";
import { isSessionLive as psSessionLive, sessionTitle } from "./claude";
import { addWorktree, branchesWithPrefix, branchExists, FetchError, isGitRepo, latestBase, listWorktrees, removeWorktree, repoKind, resolveBaseBranch, worktreeDir, type RepoKind } from "./git";
import { MOVE_TO_PLANNING_RE, STAY_RE } from "./session";
import { forkSessionFile } from "./fork";
import { saveMockups } from "./mockups";
import { Devices, type DeviceTicketState } from "./devices";
import { macBanner } from "./notify";
import { type HostHuddle, ticketAttention, userWaitReason } from "./attention";
import type { Question, SessionSummary } from "./session";
import { recallBlock } from "./recall";
import { familyOf, familyRoot, groupsOf, isFeature, levelOf, MAX_LEVEL, nextRoundTitle, parentLink, tooDeepMessage, wouldLoop, withYouTool, type TicketKind } from "../../web/src/family";
import { chatIsCold, FRESH_CHAT_TOKENS } from "./chat-cache";
import { applyPatch, familySig, readStatus, statusFacts, statusFiles, statusSections, STATUS_NOTE_MAX, writeStatus, type SavedStatus, type StatusFacts, type StatusPatch } from "./feature";
import { addOnFor } from "../../web/src/addOn";
import { learnedRulesBlock } from "./learn";
import { lessonsBlock } from "./lessons";
import { canEndQuietly, quietContext } from "./quiet";
import { addHuddleSpend } from "./spend";
import { featureMainNote, featureMemberNote, statusNotesBlock, statusNudgePrompt } from "./prompts";
import { mainTicketRules, mainWakePrompt, toolFirstPrompt, type MainRole, type RunRole, type ToolRole } from "./prompts";
import { ASK_TIMEOUT_MS, familyCard, type FamilyCard, finishedLine, isManager, kindDefaults, managedPlan, MERGE_TRIES, progressStep, REPORT_FILE, RESULTS_KEEP, sentences, wakeTable, youWaiting, stepName } from "./main-ticket";
import { NO_EDIT_TOOLS } from "./huddle-roster";
import { chatPrompt, devicesNote, freshChatNote, firstRunPrompt, followUpWakePrompt, freshSessionPrompt, interruptedPrompt, mentionsArtifact, orchestratorPrompt, planningCommand, planningPrompt, resumePrompt, setupNote, steerPrompt, type ChatMode, type PlanWake, type PromptContext } from "./prompts";
import {
  childrenOf, DEFAULT_MAX_CONCURRENT, findCycle, isComplete, MAX_RUN_CHAIN, MAX_RUN_STARTS, normalizeNeeds, planActive, planProblem, planStep, planTable,
  resolveDeps, wakeupCap,
} from "./plan";
import { run as runCmd } from "./git";
import { addPrs, ticketPrs } from "./prs";
import { deleteSnapshots, takeSnapshot } from "./rewind";
import { parseResult } from "./result";
import { FOLLOW_UP_LATE_MS, FOLLOW_UP_NOTE_MAX, FOLLOW_UP_REASON_MAX, FollowUpError, followUpTime, logFollowUp } from "./followup";
import { formatAt } from "./jobs";
import { messageCost, ticketRuns } from "./ticket-usage";
import { transcriptDirOf, workflowDirCost } from "./workflows";
import { AUTO_CONTINUE_PER_DAY, clockTime, CONTINUE_TEXT, dayKey, limitMessage, parseReset } from "./limit";
import { DraftTracker } from "./draft";
import { buildArgs, DEFAULT_STALL_MINUTES, PLANNING_DISALLOWED_TOOLS, startRun, type RunHandle } from "./runner";
import { RETRY_DELAY_MS, RETRY_TEXT, transientError } from "./retry";
import { BOARD_COMMANDS, commandText, EFFORT_HELP, runOptions, ultracodeOn, validEffort, listCommands, MODEL_HELP, parseSlash, REFUSED_COMMANDS, rememberInit, slashMessage, useBundledFile, validModel, type SlashCommand } from "./commands";
import { mcpConfig } from "./agents";
import type { OwnedSession } from "./shell";
import type { Store } from "./store";
import { normalizeTags } from "./tags";
import { autoHuddlesOn, runCapFor, workspaceOf, BOARD_NOTES_KEEP, type BoardNote, type ResultCard, type FollowUp, type Interrupted, type LimitHit, type Plan, type PrStatus, type Profile, type QueuedMessage, type SelfMove, type Status, type Ticket, type TicketMode, type TicketSource } from "./types";
import { CLEANUP_TIMEOUT_MS, copySetupFiles, prepareWorktree, runShell, SETUP_TIMEOUT_MS, withBoardText, type SetupOutcome, type SetupResult } from "./worktree-setup";

const INSTALLING = "Installing project dependencies…";
import { nowIso, slugify, starredTitle } from "./util";

export interface BoardOptions {
  claudeBin: string;
  /** Whether Claude has a stored session with this id (used to pick --resume vs --session-id). */
  sessionExists?: (sessionId: string) => boolean;
  /** Whether an interactive claude process currently has this session open. */
  isSessionLive?: (sessionId: string, title: string | null) => Promise<boolean>;
  /** The ticket's session open in one of the board's own terminals (the dock), which the board can close (Take over here). */
  findOwnedSession?: (sessionId: string) => Promise<OwnedSession | null>;
  /**
   * Tells the user about board events that aren't "needs you", e.g. a plan done, about ticket `id` on board `slug`
   * (default: a macOS banner, see notify.ts).
   */
  notify?: (title: string, body: string, slug: string, id: string) => void;
  /** Child events that arrive within this window wake the planner once (default 3s). */
  planWakeDelayMs?: number;
  /** How long ask_ticket waits for an answer (default ASK_TIMEOUT_MS; tests pass a short one). */
  askTimeoutMs?: number;
  /** Opens a pull request for land_milestone (default: `gh pr create`); returns its URL. Tests pass a fake. */
  openPr?: (dir: string, o: { branch: string; base: string; title: string; body: string }) => Promise<string>;
  /** The ticket's Claude session as the board UI sees it (open questions, pending proposal); a plan skips children waiting on the user. */
  sessionSummary?: (sessionId: string) => SessionSummary | null;
  /** The clock for usage-limit resets and the daily auto-continue cap (tests pass a fake one). */
  now?: () => Date;
  /** Pause before the one automatic retry after a passing API error (default RETRY_DELAY_MS; tests pass a short one). */
  retryDelayMs?: number;
  /** How often a capped run with workflows adds up what it spent (default WORKFLOW_CAP_POLL_MS; tests pass a short one). */
  capPollMs?: number;
  /** Stall watchdog time in ms, overriding the board's stallMinutes (tests). */
  stallMs?: number;
}

interface ActiveRun {
  slug: string;
  id: string;
  /** A main ticket's run: it can't edit files, so it holds no run slot and never waits on the folder. */
  noEdit?: boolean;
  handle: RunHandle | null;
  promise: Promise<void>;
  /** Status to land on when the run ends because the user moved the card. */
  targetStatus: Status | null;
  /** The user asked this run, in its own chat, to move its card: the board moves it once the run ends (see requestSelfMove). */
  selfMove?: SelfMove;
  /** A quiet schedule's run found nothing for the user: once it is over, the board removes the ticket (endQuietly). */
  quietEnd?: { summary: string; costUsd: number };
  stopRequested: boolean;
  /**
   * Set for runs started from the ticket chat (not the Ready queue). raw: text is the full prompt (planner wake-ups);
   * returnTo: the column such a run goes back to, since a wake-up is housekeeping, not new work to review.
   * quiet: a reply to another ticket's Claude; the card, outcome and run count stay as they were.
   * from: the column the card was in when the message was sent (a reply that only proposed tickets goes back there).
   * user: answers a message the user typed in this ticket's chat, so the run may manage the ticket's own children
   * (see plannerRights); plan wake-ups, peer replies and messages from a planner's run don't.
   */
  chat?: {
    text: string; mode: ChatMode; raw?: boolean; returnTo?: Status; quiet?: boolean; from?: Pick<Ticket, "status" | "outcome">; user?: boolean;
    /** text is a slash command (see QueuedMessage.slash). */
    slash?: "prompt" | "local";
    /** A wake for the ticket's own auto huddle (see QueuedMessage.hostWake): a full prompt, run as the ticket's work. */
    hostWake?: boolean;
    /** The board's follow-up wake (see Board.wakeFollowUp): a full prompt; afterwards the card goes back to returnTo. */
    followUp?: boolean;
    /** The board's one status nudge (see Board.nudgeStatus): a quiet turn that changes nothing on the card. */
    nudge?: boolean;
  };
  /** This message's run already got its one automatic retry after a passing API error. */
  retried?: boolean;
  /** The user chose Restart on a stalled run: once it is stopped, it resumes in the same session. */
  restartRequested?: boolean;
  /** Workflows pushed this run past its spending cap: the board stopped it (what the run had spent, in $). */
  workflowCapHit?: number;
  /** This run started an auto huddle (start_huddle): one per run. */
  autoHuddleStarted?: boolean;
  /** Other tickets' runs this run started (see runStart). */
  runStarts?: number;
  /** The user typed a message in the ticket's chat that was handed to this run while it worked (see userAskedRun). */
  userSteered?: boolean;
  /** Queued messages (ticket.queued) written to this claude process, keyed by id, with the text it was given. */
  inFlight: Map<string, string>;
  /** Queued message this chat run was started with; it leaves the queue once Claude reads the prompt. */
  promptMsgId?: string;
  /** Reply text streaming in right now; kept on the ticket if a restart cuts the run off. */
  draft?: DraftTracker;
  /** A chat reply or plan wake was part of this run: on a feature's top ticket it may get the status nudge. */
  statusEligible?: boolean;
  /** This run already got its one status nudge. */
  nudged?: boolean;
}

/** A finished assistant message with text in it (not just thinking or a tool call). */
function hasText(ev: any): boolean {
  if (ev?.type !== "assistant" || ev.parent_tool_use_id) return false;
  const c = ev.message?.content;
  return Array.isArray(c) && c.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
}

function replayText(ev: any): string | null {
  if (ev?.type !== "user" || !ev.isReplay) return null;
  const c = ev.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : null;
  // A slash command comes back as Claude Code's command tags: match it with the `/name args` the board sent.
  return text === null ? null : commandText(text) ?? text;
}

/** Backlog/Planning chats refine the ticket (no file edits); everywhere else Claude acts on the message. */
export function chatModeFor(status: Status): ChatMode {
  return status === "backlog" || status === "planning" ? "refine" : "act";
}

/** How a chat run handles a queued message: a peer message (from another ticket's Claude) is sent as-is, quietly. */
function chatFor(
  t: Pick<Ticket, "status" | "outcome"> & { tool?: boolean }, msg: { text: string; peer?: boolean; fromPlanner?: boolean; slash?: "prompt" | "local"; hostWake?: boolean; followUp?: boolean },
): NonNullable<ActiveRun["chat"]> {
  // A follow-up comes back to the ticket's own work, wherever the card is; afterwards the card goes back there.
  if (msg.followUp) return { text: msg.text, mode: "act", raw: true, returnTo: t.status === "in_progress" ? "review" : t.status, followUp: true };
  // The ticket's auto huddle wakes it: unattended work on its own ticket, so it ends like a work run (result line, column).
  if (msg.hostWake) return { text: msg.text, mode: "act", raw: true, hostWake: true };
  // A tool ticket's messages come from its parent: they continue its work, in any column.
  const mode = t.tool ? "act" : chatModeFor(t.status);
  if (msg.peer) return { text: msg.text, mode, raw: true, quiet: true };
  const chat: NonNullable<ActiveRun["chat"]> = { text: msg.text, mode, from: { status: t.status, outcome: t.outcome }, ...(msg.fromPlanner ? {} : { user: true }) };
  if (!msg.slash) return chat;
  // A local command (/compact) gets no reply from Claude: like a peer reply, the card and outcome stay as they were.
  return { ...chat, slash: msg.slash, ...(msg.slash === "local" ? { quiet: true } : {}) };
}

/** Queued-message flags from Board.chat options. */
function flags(o: ChatOptions): Pick<QueuedMessage, "peer" | "fromPlanner" | "from" | "slash" | "hostWake" | "followUp"> {
  return {
    ...(o.from ? { from: o.from } : {}),
    ...(o.peer ? { peer: true } : {}), ...(o.fromPlanner ? { fromPlanner: true } : {}), ...(o.slash ? { slash: o.slash } : {}),
    ...(o.hostWake ? { hostWake: true } : {}), ...(o.followUp ? { followUp: true } : {}),
  };
}

/** Board.chat options; hostWake: the ticket's own auto huddle (or a free auto-huddle slot) wakes it; followUp: its follow-up is due. */
export interface ChatOptions {
  peer?: boolean;
  fromPlanner?: boolean;
  /** Sent by another ticket's Claude: which one (shown with the message instead of "You"). */
  from?: { ticketId: string; title: string };
  slash?: "prompt" | "local";
  hostWake?: boolean;
  followUp?: boolean;
  /** The user's "Send in a fresh chat": this message starts a new chat; the old one stays visible above it. */
  fresh?: boolean;
}

/** What the card says while the ticket waits for its auto huddle. */
export function autoHuddleActivity(a: NonNullable<Ticket["autoHuddle"]>): string {
  return a.state === "waiting" ? "Waiting for huddle slot" : "Auto huddle: waiting for the review";
}

/** Statuses whose ticket already did its work: moving it back to Planning or Backlog remembers it (Ticket.reopenedFrom). */
function reopenable(s: Status): boolean {
  return s === "review" || s === "done";
}

/**
 * Runs that do the ticket's work: work runs, and chat replies that act on the ticket. Planning interviews, replies to
 * another ticket's Claude (its asker waits on them) and planner wake-ups are short housekeeping and don't count. There
 * is no limit on them (the board starts every run as soon as it is ready); the count shows on the board and decides
 * whether a reply waits for a folder that another ticket edits in place.
 */
function takesSlot(chat?: ActiveRun["chat"], noEdit?: boolean): boolean {
  // A main ticket's runs can't edit (they only talk and decide): they never wait for a slot.
  if (noEdit) return false;
  return !chat || (chat.mode === "act" && !chat.quiet && (!chat.returnTo || !!chat.followUp));
}

/** What the chat says about a message held back by a pending restart. */
export const RESTART_HOLD_TEXT = "The board restarts soon; your message is sent right after (at most 10 minutes).";

const ACTIVITY_THROTTLE_MS = 1000;
/** How long a board folder's cached version history (see Board.repoState) is trusted. */
const REPO_TTL_MS = 10_000;
/** A run that would edit the board's folder while another ticket does waits with this on its card. */
export const FOLDER_WAIT = "waiting: another ticket is using the folder";

/** Where a ticket's runs work (see Board.ensureSession). */
export interface Session {
  dir: string;
  sessionId: string;
  existed: boolean;
  isGit: boolean;
  /** The board folder's version history. */
  repo: RepoKind;
  /** The run edits the board's folder itself (no worktree, not a linked session). */
  inPlace: boolean;
}
/** What a stalled run's session is told when the user restarts it. */
const STALL_RESTART_TEXT = "Your previous run stopped responding and the user restarted it. Continue where you left off.";
/** A requested restart waits this long for active runs to finish, then restarts anyway (recover() resumes them). */
export const RESTART_MAX_WAIT_MS = 10 * 60_000;
const DRAFT_THROTTLE_MS = 120;
/** What a run spent: its own messages plus its workflows' helper agents. */
/**
 * Tools a Planning chat doesn't get. The check-in setup chat (Schedules → Proactive check-ins, which the user opened to
 * make a schedule) may create and change schedules; it still can't run, delete or edit files.
 */
function planningDisallowed(t: Ticket): string[] {
  if (!t.checkinSetup) return PLANNING_DISALLOWED_TOOLS;
  return PLANNING_DISALLOWED_TOOLS.filter((x) => x !== "mcp__ckanban__create_schedule" && x !== "mcp__ckanban__update_schedule");
}

function spentWith(spend: { main: Map<string, number>; workflowDirs: Set<string>; files: Map<string, { key: string; cost: number }> }): number {
  let total = 0;
  for (const c of spend.main.values()) total += c;
  for (const dir of spend.workflowDirs) total += workflowDirCost(dir, spend.files);
  return total;
}

/** What Claude is told when the user stops one of its workflows from the board. */
export const WORKFLOW_STOPPED_TEXT = "The user stopped your workflow from the board. Don't start it again; finish the task with the results you already have and say which parts the workflow didn't get to.";
/** How often a capped run with workflows running adds up its spending (see executeOnce). */
export const WORKFLOW_CAP_POLL_MS = 5_000;

/** The session's transcript file under Claude's projects folder, if any. */
export function claudeSessionFile(sessionId: string): string | null {
  const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return null;
  try {
    const d = readdirSync(root).find((d) => existsSync(join(root, d, `${sessionId}.jsonl`)));
    return d ? join(root, d, `${sessionId}.jsonl`) : null;
  } catch {
    return null;
  }
}

export function claudeSessionExists(sessionId: string): boolean {
  return claudeSessionFile(sessionId) !== null;
}

/** Claude's answer to `--resume` with a session it has no transcript for. */
export function sessionMissing(error: string, events: any[]): boolean {
  const re = /No conversation found with session ID/i;
  return re.test(error) || events.some((e) => e?.type === "result" && Array.isArray(e.errors) && e.errors.some((m: unknown) => typeof m === "string" && re.test(m)));
}

/**
 * A run that failed because Claude Code itself isn't ready (not installed, or not signed in): what to do, in plain
 * words, instead of Claude's raw error. Null for any other failure.
 */
export function claudeSetupHint(error: string): string | null {
  if (/failed to start .*claude|Executable not found in \$PATH: "?claude"?/i.test(error)) {
    return "Claude Code isn't installed, or the board can't find it. Install it from https://claude.com/claude-code and sign in, then start the ticket again. If it still fails, run `ckanban install` in Terminal so the board finds Claude Code.";
  }
  if (/Please run \/login/i.test(error)) {
    return "Claude Code isn't signed in. Open Terminal, type `claude`, sign in, then start the ticket again.";
  }
  return null;
}

export const SESSION_OPEN_MSG = "This ticket's Claude session is still open in a terminal. Exit it there (Ctrl+D or /exit), then try again.";

/** Run errors the board offers a one-click fix for: Start fresh session, or Take over here. */
export type Recovery = "session_missing" | "session_open";

export function recoveryFor(error: string | null | undefined): Recovery | null {
  if (!error) return null;
  if (sessionMissing(error, [])) return "session_missing";
  if (error === SESSION_OPEN_MSG) return "session_open";
  return null;
}

/** Board comments that aren't Claude's result (a fresh session's prompt skips them for "Last result"). */
/** The chat note when a cold, large main or feature chat starts its next turn fresh (Board.autoFresh). */
export const AUTO_FRESH_NOTE = "Started a fresh chat to keep this cheap: Claude starts from the status and can look up earlier messages.";
const BOARD_NOTE_RE = /^(Run failed|Could not start|Run stopped|Planner stopped|Started a fresh session|Started a fresh chat|Took over the session|This ticket's Claude session is still open)/;

export class ConflictError extends Error {}

/** Every ticket below id in its family (not id itself). */
function subtreeIds(tickets: Ticket[], id: string): string[] {
  const rows = familyOf(tickets, id);
  const at = rows.findIndex((r) => r.ticket.id === id);
  const out: string[] = [];
  for (let i = at + 1; i < rows.length && rows[i].depth > rows[at].depth; i++) out.push(rows[i].ticket.id);
  return out;
}

/** What changed in a feature's family between two familySig values, as short lines for the status nudge. */
export function sigChanges(before: string, after: string, rows: Ticket[]): string[] {
  const parse = (sig: string) => new Map(sig.split("|").filter(Boolean).map((e) => [e.slice(0, e.indexOf(":")), e.slice(e.indexOf(":") + 1)]));
  const [a, b] = [parse(before), parse(after)];
  const title = (id: string) => rows.find((r) => r.id === id)?.title ?? id;
  const out: string[] = [];
  for (const [id, v] of b) {
    if (!a.has(id)) out.push(`"${title(id)}" joined the feature`);
    else if (a.get(id) !== v) {
      const [status, outcome, verdict] = v.split(":");
      out.push(`"${title(id)}" is now ${status}${outcome ? ` (${outcome})` : ""}${verdict ? `, verdict ${verdict}` : ""}`);
    }
  }
  for (const id of a.keys()) if (!b.has(id)) out.push(`${id} left the feature`);
  return out;
}

export class Board {
  private runs = new Map<string, ActiveRun>();
  /** Latest live progress of each workflow (stream task_progress: every agent, waiting ones too), by ticket and Workflow call. */
  private workflowLive = new Map<string, any[]>();
  /** Shared devices every board's runs take and let go (devices.ts); a run's end frees what it still holds. */
  readonly devices: Devices;
  /** Setup commands running now (`ckanban ticket setup`; stopping the ticket's run aborts them), per ticket key. */
  private setups = new Map<string, { done: Promise<SetupOutcome>; abort: AbortController }>();
  private shuttingDown = false;
  /** A restart waits for active runs to finish: no new run starts until then (see requestRestart). */
  private restartPending = false;
  /** Other work a restart waits for besides board runs (huddle agents mid-turn), see onRestartBusy. */
  private restartBusy: (() => string[])[] = [];
  /** Each board's open huddles by host ticket (see onHostHuddles); none until Huddles registers. */
  private hostHuddleStates: (slug: string) => Map<string, HostHuddle> = () => new Map();
  private sessionExists: (id: string) => boolean;
  private isSessionLive: (id: string, title: string | null) => Promise<boolean>;
  private notify: (title: string, body: string, slug: string, id: string) => void;

  private sessionSummary: (sessionId: string) => SessionSummary | null;

  constructor(private store: Store, private bus: Bus, private opts: BoardOptions) {
    this.sessionSummary = opts.sessionSummary ?? (() => null);
    this.sessionExists = opts.sessionExists ?? claudeSessionExists;
    this.isSessionLive = opts.isSessionLive ?? psSessionLive;
    this.notify = opts.notify ?? ((title, body) => macBanner(title, body));
    useBundledFile(join(store.root, "claude-commands.json"));
    this.devices = new Devices(store.root, (owners) => this.devicesChanged(owners));
  }

  private key(slug: string, id: string) {
    return `${slug}/${id}`;
  }

  private emitTicket(slug: string, t: Ticket) {
    this.bus.emit({ type: "ticket.updated", profile: slug, ticket: t });
  }

  private patch(slug: string, id: string, patch: Partial<Ticket>): Ticket {
    // Every new activity line is stamped, so the card can show how long ago the last step was (W7).
    if ("lastActivity" in patch && !("lastActivityAt" in patch)) patch = { ...patch, lastActivityAt: patch.lastActivity ? nowIso() : null };
    const t = this.store.updateTicket(slug, id, patch);
    this.emitTicket(slug, t);
    // Done: nothing will be rewound any more, so its saved copies of the folder go (in the background).
    if (patch.status === "done") void this.dropRewindCopies(slug, t);
    return t;
  }

  /** Deletes the ticket's saved copies for Rewind, wherever its Claude worked (the board's folder or a linked one). */
  private async dropRewindCopies(slug: string, t: Ticket): Promise<void> {
    const profile = this.store.getProfile(slug);
    const dirs = new Set([profile?.path, t.workdir].filter((d): d is string => !!d && existsSync(d)));
    for (const dir of dirs) await deleteSnapshots(dir, t.id).catch(() => {});
  }

  /** Cache the ticket's PR status (prpoller.ts) and tell the UI. */
  setPr(slug: string, id: string, pr: PrStatus): Ticket {
    return this.patch(slug, id, { pr });
  }

  /** Record the ticket's PR list and main PR (prs.ts) and tell the UI. */
  patchPrs(slug: string, id: string, prs: Pick<Ticket, "prs" | "prUrl">): Ticket {
    return this.patch(slug, id, prs);
  }

  // ---- Shared devices (devices.ts): taken by a run only while it uses them; Ticket.needs is just a hint ----

  /** Who holds or waits for devices changed: refresh those tickets' cards and the Devices screen. */
  private devicesChanged(owners: string[]): void {
    if (this.shuttingDown) return;
    for (const o of owners) {
      const i = o.indexOf("/");
      const t = this.store.getTicket(o.slice(0, i), o.slice(i + 1));
      if (t) this.emitTicket(o.slice(0, i), t);
    }
    this.bus.emit({ type: "devices.updated" });
  }

  /** For the card: the devices the ticket's run uses now, and the ones it waits for. */
  deviceState(slug: string, id: string): DeviceTicketState | null {
    return this.devices.ticketState(slug, id);
  }

  /** Why a plan child waits on the user (questions, a proposal to apply, in Planning), or null. */
  userWait(t: Ticket): string | null {
    return userWaitReason(t, t.sessionId ? this.sessionSummary(t.sessionId) : null);
  }

  /** The card still needs the user (questions, a proposal or new tickets to apply, a failed run), not just a look. */
  waitsOnUser(slug: string, id: string): boolean {
    const t = this.store.getTicket(slug, id);
    if (!t) return false;
    // A "with you" step has no card of its own: it waits on the user while its question is unanswered.
    if (withYouTool(t)) return youWaiting(t, this.isRunning(slug, id));
    const a = ticketAttention(this.store, slug, t, t.sessionId ? this.sessionSummary(t.sessionId) ?? null : null, this.isRunning(slug, id),
      this.hostHuddles(slug).get(id), (x) => this.isRunning(slug, x));
    return !!a && a.kind !== "review";
  }

  /** Snooze the ticket from the Inbox until a time (null: unsnooze); key: snoozeKey of what it waits for now. */
  setSnooze(slug: string, id: string, snooze: { until: string; key: string } | null): Ticket {
    return this.patch(slug, id, { snooze });
  }

  /** Working runs on the board (see takesSlot). */
  running(slug: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.slug === slug && takesSlot(r.chat, r.noEdit)) n++;
    return n;
  }

  /** The ticket's run is a working run (see takesSlot). */
  holdsSlot(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    return !!r && takesSlot(r.chat, r.noEdit);
  }


  isRunning(slug: string, id: string): boolean {
    return this.runs.has(this.key(slug, id));
  }

  /** Live progress of a workflow in this ticket's run (the latest task_progress agent list), if any came in. */
  workflowProgress(slug: string, id: string, toolUseId: string): any[] | null {
    return this.workflowLive.get(`${slug}/${id}/${toolUseId}`) ?? null;
  }

  /** Keep a run's workflow progress for the chat, and what it spends for the cap. */
  private watchWorkflows(slug: string, id: string, ev: any, spend: { main: Map<string, number>; workflowDirs: Set<string> }): void {
    if (ev?.type === "system" && ev.subtype === "task_progress" && typeof ev.tool_use_id === "string" && Array.isArray(ev.workflow_progress)) {
      this.workflowLive.set(`${slug}/${id}/${ev.tool_use_id}`, ev.workflow_progress);
    } else if (ev?.type === "assistant" && ev.message?.usage) {
      const mid = typeof ev.message.id === "string" ? ev.message.id : `#${spend.main.size}`;
      spend.main.set(mid, messageCost(String(ev.message.model ?? ""), ev.message.usage));
    } else if (ev?.type === "user" && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join("\n") : "";
        const dir = text.startsWith("Workflow launched") ? transcriptDirOf(text) : null;
        if (dir) spend.workflowDirs.add(dir);
      }
    }
  }

  /**
   * Stop one workflow of the ticket's run and let the run go on. Claude Code answers the stop request; if it can't
   * stop just the workflow, the whole run stops instead (the result says which).
   */
  async stopWorkflow(slug: string, id: string, taskId: string): Promise<{ stopped: "workflow" | "run"; error?: string }> {
    const r = this.runs.get(this.key(slug, id));
    if (!r?.handle) throw new Error("this ticket isn't running");
    const res = await r.handle.stopTask(taskId);
    if (res.ok) {
      // Claude only hears "killed": tell it the user did it, so it doesn't report the workflow as still running.
      r.handle.send(WORKFLOW_STOPPED_TEXT);
      this.store.addComment(slug, id, "ai", "Workflow stopped by user. The run goes on.");
      this.emitTicket(slug, this.store.getTicket(slug, id)!);
      return { stopped: "workflow" };
    }
    this.stopRun(r);
    return { stopped: "run", error: res.error };
  }

  /** The ticket's current run is a quiet reply to another session's message (a peer run, e.g. a huddle's). */
  isPeerRun(slug: string, id: string): boolean {
    return !!this.runs.get(this.key(slug, id))?.chat?.quiet;
  }

  dispatch(slug: string): void {
    if (this.restartPending || this.shuttingDown) return; // Ready tickets start after the restart
    const profile = this.store.getProfile(slug);
    if (!profile || !existsSync(profile.path)) return;
    const idle = this.store.listTickets(slug).filter((t) => !t.error?.startsWith("corrupt") && !this.isRunning(slug, t.id));
    // Chat replies waiting for a slot go first, oldest first: they continue work that is already underway.
    for (const t of idle.filter((t) => t.slotWait).sort((a, b) => a.slotWait!.at.localeCompare(b.slotWait!.at))) {
      const next = this.waiting(slug, t.id)[0];
      if (!next) {
        this.cancelSlotWait(slug, t.id);
        continue;
      }
      const chat = next.peer || next.hostWake ? chatFor(t, next) : next.followUp ? chatFor(t.slotWait!.from, next) : { ...chatFor(t, next), mode: "act" as const, from: t.slotWait!.from };
      if (chat.mode === "act" && this.folderBusy(slug, t)) continue;
      this.patch(slug, t.id, { slotWait: null });
      this.start(slug, t.id, chat, next.id);
    }
    const ready = idle.filter((t) => t.status === "ready").sort((a, b) => a.order - b.order);
    for (const t of ready) {
      // It would edit the board's folder in place while another ticket does: it waits its turn the same way.
      if (this.folderBusy(slug, t)) continue;
      this.start(slug, t.id);
    }
  }

  /** All slots are busy (or the folder is): the card waits in In Progress with its queued message(s) until dispatch() starts it. */
  private waitForSlot(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, {
      status: "in_progress", outcome: null, error: null, lastActivity: FOLDER_WAIT,
      slotWait: t.slotWait ?? { at: nowIso(), from: { status: t.status, outcome: t.outcome } },
    });
  }

  /** Stop (or a move) before a waiting reply started: its messages stay for the user to send or discard. */
  private cancelSlotWait(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id)!;
    const from = t.slotWait?.from ?? { status: "review" as Status, outcome: t.outcome };
    return this.patch(slug, id, {
      status: from.status, outcome: from.outcome, slotWait: null, lastActivity: null,
      queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)),
    });
  }

  /**
   * Send a chat message: resumes the ticket's session right away, like typing in the terminal.
   * While Claude is working the message steers the run instead: Claude reads it at its next step.
   * peer: the message comes from another session (a huddle) and is already a full prompt.
   */
  async chat(slug: string, id: string, text: string, opts: ChatOptions = {}): Promise<Ticket> {
    // Rewind needs the folder as it is right before this message: saved quietly, the user's own history is untouched.
    // Done first, so everything below still runs in one go (a message can't slip in between the checks and the start).
    // Only when Claude is idle: a message sent while it works steers the run and can't be rewound to anyway, and
    // waiting on the copy there would let the run finish or stop in between.
    if (!opts.peer && !opts.hostWake && !opts.followUp && text.trim() && !this.runs.has(this.key(slug, id))) {
      const dir = this.rewindDir(slug, id);
      if (dir) await takeSnapshot(dir, id, text);
    }
    return this.chatNow(slug, id, text, opts);
  }

  private async chatNow(slug: string, id: string, text: string, opts: ChatOptions): Promise<Ticket> {
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!text.trim()) throw new Error("message is empty");
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    const active = this.runs.get(this.key(slug, id));
    if (opts.fresh) {
      if (active) throw new ConflictError("Claude is working on this ticket; send it once Claude is done");
      t = this.startFreshChat(slug, id);
    }
    if (!opts.peer && !opts.slash && !opts.hostWake && !opts.followUp) {
      const refused = parseSlash(text)?.name;
      if (refused && REFUSED_COMMANDS.has(refused)) {
        throw new Error(`/${refused} isn't available here: start a new ticket for a fresh conversation.`);
      }
      const slash = slashMessage(text, this.commands(slug, id));
      if (slash && BOARD_COMMANDS.has(slash.command.name)) return this.boardCommand(slug, id, slash.command.name, slash.args);
      if (slash) [text, opts] = [slash.text, { ...opts, slash: slash.command.local ? "local" : "prompt" }];
    }
    // The user chats on a Backlog card: it is being shaped now, so it shows in Planning (a running plan's children stay put).
    const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
    if (t.status === "backlog" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp && opts.slash !== "local" && !planActive(parent?.plan)) {
      t = this.patch(slug, id, { status: "planning", refineStarted: true });
    }
    // The user (or the board's automatic continue) picks the conversation up again: the limit wait is over.
    if (t.limit && !opts.peer && !opts.hostWake && !opts.followUp) this.patch(slug, id, { limit: null });
    // The user answers a main ticket whose plan got stuck (it asked them something, or went round in circles): its
    // family's engine goes on, and the no-progress count starts over.
    if (t.main && t.plan?.state === "stuck" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp) {
      t = this.patch(slug, id, { plan: { ...t.plan, state: "running", reason: null, awaiting: null, noProgress: 0 } });
    }
    // The user writes (or answers a form) in a stopped main ticket's chat: Stop held its steps only until now.
    if (t.main && t.plan?.state === "paused" && !opts.peer && !opts.fromPlanner && !opts.hostWake && !opts.followUp && opts.slash !== "local") {
      if (this.resumeStoppedPlan(slug, id, "you wrote in its chat")) t = this.store.getTicket(slug, id)!;
    }
    if (active) {
      if (active.stopRequested || this.shuttingDown) throw new ConflictError("Claude is stopping; send your message once it has stopped");
      // Saved on the ticket until Claude reads it, so closing the chat, Stop or a restart can't lose it.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      this.steer(active, msg);
      return this.store.getTicket(slug, id)!;
    }
    if (this.restartPending) {
      // Starts after the restart: recover() answers queued messages.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      return this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
    }
    // A cold, large main or feature chat: this turn starts fresh from the status (not for a reply to another session).
    if (!opts.peer && !opts.fresh) t = this.autoFresh(slug, t);
    const chat = chatFor(t, { text, ...opts });
    // A reply that may edit files (not a read-only Planning one) waits while another ticket edits the folder in place.
    const folderBusy = chat.mode === "act" && this.folderBusy(slug, t);
    const slot = takesSlot(chat, t.main);
    if (!slot && (folderBusy || t.slotWait)) {
      // A reply to another session (a huddle) holds no slot: it waits on the ticket without moving the card.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, {
        queued: [...(t.queued ?? []), msg], lastActivity: FOLDER_WAIT,
        slotWait: t.slotWait ?? { at: nowIso(), from: { status: t.status, outcome: t.outcome } },
      });
      this.dispatch(slug);
      return this.store.getTicket(slug, id)!;
    }
    if (slot && (t.slotWait || folderBusy)) {
      // Another ticket edits the folder in place: the reply waits on the ticket like a Ready ticket, but starts before them.
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.patch(slug, id, { queued: [...(t.queued ?? []), msg] });
      this.waitForSlot(slug, id);
      this.dispatch(slug);
      return this.store.getTicket(slug, id)!;
    }
    // The user's message is saved until Claude reads it: Stop before then leaves it unsent, not lost.
    if (opts.peer || opts.hostWake || opts.followUp) this.start(slug, id, chat);
    else {
      const msg: QueuedMessage = { id: crypto.randomUUID(), text, at: nowIso(), state: "queued", ...flags(opts) };
      this.start(slug, id, chat, msg.id);
      // Added once the run is registered, so the chat never shows it as waiting with no run behind it.
      this.patch(slug, id, { queued: [...(this.store.getTicket(slug, id)!.queued ?? []), msg] });
    }
    return this.store.getTicket(slug, id)!;
  }

  /**
   * The folder a ticket's Claude edits, once it is known (its own copy, a linked folder, or the project folder after
   * the first run edited it in place); null before that, so rewind never snapshots the wrong folder.
   */
  rewindDir(slug: string, id: string): string | null {
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (!t || !profile) return null;
    if (t.workdir || t.worktree) return t.workdir ?? t.worktree ?? null;
    return t.baseSha ? profile.path : null;
  }

  /** Why the chat can't be rewound right now, or null when it can. */
  rewindBlocked(slug: string, id: string): string | null {
    const t = this.store.getTicket(slug, id);
    if (!t) return "ticket not found";
    if (this.isRunning(slug, id)) return "Claude is working. Stop it or wait until it has replied.";
    if (t.queued?.length) return "A message is still waiting to be sent. Send or discard it first.";
    // In the project folder itself, another ticket's run edits the same files: putting them back would undo its work too.
    if (!t.workdir && !t.worktree && this.folderBusy(slug, t)) return "Another ticket is editing this folder right now. Try again when it has finished.";
    return null;
  }

  /** The conversation was cut by a rewind: with nothing left of it, the next message starts a new session. */
  rewound(slug: string, id: string, emptied: boolean): Ticket {
    this.recoverable(slug, id);
    return this.patch(slug, id, emptied
      ? { sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true, lastActivity: null }
      : { lastActivity: null });
  }

  /** What `/` can run in this ticket's chat (the composer's picker lists the same). */
  commands(slug: string, id: string): SlashCommand[] {
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (!t || !profile) return [];
    return listCommands(t.workdir ?? t.worktree ?? profile.path, { projects: [profile.path] });
  }

  /** /model: the board's own command. Claude Code's version only lasts for one run (see commands.ts). */
  private boardCommand(slug: string, id: string, name: string, args: string): Ticket {
    const t = this.store.getTicket(slug, id)!;
    if (name === "model") {
      const profile = this.store.getProfile(slug)!;
      const fallback = profile.model ? `the board's model (${profile.model})` : "Claude Code's default model";
      if (!args) {
        return this.patch(slug, id, { notice: t.model ? `This ticket uses model ${t.model}. Change it with /model <name>, or /model default.` : `This ticket uses ${fallback}. Change it with /model <name>, e.g. /model sonnet.` });
      }
      const reset = args === "default" || args === "reset";
      if (!reset && !validModel(args)) throw new Error(`"${args}" is not a model name. Use ${MODEL_HELP}.`);
      const when = this.isRunning(slug, id) ? "from the next run (the current one keeps its model)" : "from the next run";
      return this.patch(slug, id, { model: reset ? null : args, notice: reset ? `Model reset: this ticket uses ${fallback} ${when}.` : `Model set to ${args} for this ticket, ${when}.` });
    }
    if (name === "effort") {
      const profile = this.store.getProfile(slug)!;
      const level = (e: string | null | undefined) => (e === "ultracode" ? "xhigh" : e || null);
      const boardUltra = !!runOptions(null, profile, true).ultracode;
      const fallback = level(profile.effort) ? `the board's effort (${level(profile.effort)})` : "Claude Code's default effort";
      const ultraText = (on: boolean) => (on ? ", ultracode on" : "");
      const when = this.isRunning(slug, id) ? "from the next run (the current one keeps its settings)" : "from the next run";
      if (!args) {
        const mine = level(t.effort);
        const ultra = ultracodeOn(t, profile);
        return this.patch(slug, id, {
          notice: `${mine ? `This ticket uses effort ${mine}` : `This ticket uses ${fallback}`}${ultraText(ultra)}. Change it with /effort <level>, /effort ultracode (on or off), or /effort default.`,
        });
      }
      const words = args.toLowerCase().split(/\s+/);
      // Ultracode is a switch next to the effort level, like Claude Code's: /effort ultracode, /effort ultracode off.
      if (words[0] === "ultracode") {
        const on = words[1] !== "off";
        // The first version saved ultracode as the effort level: keep its level (xhigh) when switching it separately.
        const effort = t.effort === "ultracode" ? "xhigh" : t.effort;
        return this.patch(slug, id, {
          ultracode: on, effort: effort ?? null,
          notice: `Ultracode ${on ? "on" : "off"} for this ticket, ${when}.${on ? " Claude runs a workflow of helper agents for every substantial task, which uses much more of your plan." : ""}`,
        });
      }
      const reset = args === "default" || args === "reset";
      if (!reset && !validEffort(args)) throw new Error(`"${args}" is not an effort level. Use ${EFFORT_HELP}.`);
      if (reset) {
        return this.patch(slug, id, { effort: null, ultracode: null, notice: `Effort reset: this ticket uses ${fallback}${ultraText(boardUltra)} ${when}.` });
      }
      // A level set over the old "ultracode" effort keeps ultracode on.
      const keep = t.effort === "ultracode" && t.ultracode == null ? { ultracode: true } : {};
      const ultra = ultracodeOn({ ...t, ...keep, effort: args }, profile);
      return this.patch(slug, id, { effort: args, ...keep, notice: `Effort set to ${args}${ultraText(ultra)} for this ticket, ${when}.` });
    }
    return t;
  }

  /** Send a message that was left unsent by Stop, as if the user typed it now. */
  async sendQueued(slug: string, id: string, msgId: string): Promise<Ticket> {
    const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
    if (!msg) throw new Error("message not found");
    if (msg.state !== "unsent") throw new ConflictError("message is already on its way to Claude");
    this.dropQueued(slug, id, [msgId]);
    return this.chat(slug, id, msg.text, { peer: msg.peer, fromPlanner: msg.fromPlanner, from: msg.from, slash: msg.slash, hostWake: msg.hostWake, followUp: msg.followUp });
  }

  discardQueued(slug: string, id: string, msgId: string): Ticket {
    const msg = this.held(slug, id, msgId);
    const t = this.dropQueued(slug, id, [msgId]);
    // The last reply waiting for a slot is gone: nothing is left to start, so the card goes back.
    return t.slotWait && !this.waiting(slug, id).length ? this.cancelSlotWait(slug, id) : t;
  }

  /** Fix a message Claude hasn't received yet: it keeps its place in the queue. */
  editQueued(slug: string, id: string, msgId: string, text: string): Ticket {
    if (!text.trim()) throw new Error("message is empty");
    const msg = this.held(slug, id, msgId);
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, { queued: (t.queued ?? []).map((m) => (m.id === msg.id ? { ...m, text } : m)) });
  }

  /**
   * A queued message the user can still change: left unsent by Stop, or waiting for the folder or a restart.
   * With a run going it was written to Claude's stdin at once (peer messages included), so it is delivered.
   */
  private held(slug: string, id: string, msgId: string): QueuedMessage {
    const msg = this.store.getTicket(slug, id)?.queued?.find((m) => m.id === msgId);
    if (!msg) throw new Error("message not found");
    if (msg.state === "unsent") return msg;
    if (msg.peer || this.isRunning(slug, id)) throw new ConflictError("message is already on its way to Claude");
    return msg;
  }

  private dropQueued(slug: string, id: string, ids: string[]): Ticket {
    const t = this.store.getTicket(slug, id)!;
    return this.patch(slug, id, { queued: (t.queued ?? []).filter((m) => !ids.includes(m.id)) });
  }

  /** Hand a queued message to the live claude process; false when there is none to take it yet. */
  private steer(run: ActiveRun, msg: QueuedMessage): boolean {
    if (run.inFlight.has(msg.id) || run.promptMsgId === msg.id) return true;
    // A slash command goes alone: anything after it would become the command's arguments.
    const text = msg.slash ? localizeUrls(msg.text, this.store.attachmentsDir) : localizeAttachments(msg.peer || msg.hostWake || msg.followUp ? msg.text : steerPrompt(msg.text), this.store.attachmentsDir);
    if (!run.handle?.send(text, { local: msg.slash === "local" })) return false;
    // Claude never echoes a local command back: it is read once it is written.
    if (msg.slash === "local") this.dropQueued(run.slug, run.id, [msg.id]);
    else run.inFlight.set(msg.id, text);
    if (!msg.peer && !msg.fromPlanner && !msg.hostWake && !msg.followUp && !msg.slash) run.userSteered = true;
    return true;
  }

  /** Messages Claude has not read yet, waiting to be handed to a run. */
  private waiting(slug: string, id: string): QueuedMessage[] {
    return (this.store.getTicket(slug, id)?.queued ?? []).filter((m) => m.state === "queued");
  }

  /** Claude echoed a user message back: it has read it, so it leaves the queue. */
  private delivered(run: ActiveRun, text: string) {
    let msgId = [...run.inFlight].find(([, sent]) => sent === text)?.[0];
    if (msgId) run.inFlight.delete(msgId);
    // Anything else echoed back is the run's own prompt.
    else if (run.promptMsgId) [msgId, run.promptMsgId] = [run.promptMsgId, undefined];
    if (msgId) this.dropQueued(run.slug, run.id, [msgId]);
  }

  /** Entering Planning means "shape this with Claude": start the interview once, without a click. */
  private autoRefine(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t || t.status !== "planning" || t.refineStarted || this.isRunning(slug, id) || this.shuttingDown) return;
    if (t.error?.startsWith("corrupt")) return;
    // A linked session is already a conversation about work underway; an interview would be noise.
    // A run stopped before Claude saved its session left nothing to talk over: interview as if new.
    if (t.workdir || (t.sessionStarted && t.sessionId && this.sessionExists(t.sessionId))) return;
    if (this.restartPending) {
      this.patch(slug, id, { refineStarted: true, interrupted: { at: nowIso(), mode: "refine", prompt: { text: "" }, held: true } });
      return;
    }
    this.start(slug, id, { text: "", mode: "refine" });
  }

  private start(slug: string, id: string, chat?: ActiveRun["chat"], promptMsgId?: string) {
    const run: ActiveRun = {
      slug, id, handle: null, promise: Promise.resolve(), targetStatus: null, stopRequested: false, chat, inFlight: new Map(), promptMsgId,
      noEdit: !!this.store.getTicket(slug, id)?.main,
    };
    this.runs.set(this.key(slug, id), run);
    this.begin(run);
    run.promise = this.execute(run)
      .catch((e) => {
        console.error(`run ${slug}/${id} crashed`, e);
        try {
          this.patch(slug, id, { ...this.endStatus(run), outcome: "failed", error: String(e?.message ?? e) });
        } catch {}
      })
      .finally(async () => {
        this.runs.delete(this.key(slug, id));
        // Whatever devices the run still holds or waits for go to the next ticket in line.
        this.devices.releaseAll(slug, id);
        if (run.quietEnd && !this.shuttingDown && await this.endQuietly(slug, id, run.quietEnd)) {
          if (this.restartPending) this.emitRestart();
          this.dispatch(slug);
          return;
        }
        // Before a pending restart, so the move the user asked for isn't lost.
        await this.applySelfMove(run);
        if (this.restartPending) this.emitRestart();
        // Tell the UI the run is over (earlier updates were sent while it was still registered).
        const now = this.store.getTicket(slug, id);
        if (now && !this.shuttingDown) {
          if (now.runStartedAt || now.interrupted || now.waitingOn || now.stalled || now.followUpRun) this.patch(slug, id, { runStartedAt: null, interrupted: null, waitingOn: null, stalled: null, followUpRun: null });
          else this.emitTicket(slug, now);
        }
        // When the user moved the card, updateTicket() writes the new status and dispatches itself.
        if (!this.shuttingDown && !run.targetStatus) this.dispatch(slug);
        if (!this.shuttingDown) this.advancePlans(slug);
      });
  }

  /** The move the user asked the run for, now that its reply is over; not when the user stopped or moved it meanwhile. */
  private async applySelfMove(run: ActiveRun): Promise<void> {
    const status = run.selfMove;
    if (!status || run.stopRequested || run.targetStatus || this.shuttingDown || this.isRunning(run.slug, run.id)) return;
    const t = this.store.getTicket(run.slug, run.id);
    if (!t || t.status === status) return;
    try {
      await this.updateTicket(run.slug, run.id, { status }, { byUser: true });
      this.store.addComment(run.slug, run.id, "ai", `Moved it to ${status} by its own chat (user request).`);
    } catch (e) {
      this.store.addComment(run.slug, run.id, "ai", `Couldn't move it to ${status} as asked in the chat: ${(e as Error).message}`);
    }
  }

  private begin(run: ActiveRun) {
    if (run.chat && !run.chat.quiet && (run.chat.mode !== "refine" || run.chat.text.trim())) run.statusEligible = true;
    const t = this.store.getTicket(run.slug, run.id);
    const followUpRun = run.chat?.followUp && run.chat.returnTo ? { returnTo: run.chat.returnTo } : null;
    if (followUpRun || t?.followUpRun) this.patch(run.slug, run.id, { followUpRun });
    // A main ticket's replies and wakes don't move its card: it stays where the user put it.
    this.patch(run.slug, run.id, run.chat?.quiet || (run.chat && run.noEdit && run.chat.mode === "act" && !run.chat.hostWake)
      ? { error: null, lastActivity: "Claude is replying…", runStartedAt: nowIso(), waitingOn: null, stalled: null }
      : run.chat?.mode === "refine"
      ? { error: null, lastActivity: "Claude is replying…", refineStarted: true, runStartedAt: nowIso(), waitingOn: null, stalled: null }
      : { status: "in_progress", outcome: null, error: null, limit: null, capHit: null, lastActivity: "Starting…", runStartedAt: nowIso(), waitingOn: null, stalled: null });
  }

  /** One claude run, then a chat reply for each message that came in too late for it. */
  private async execute(run: ActiveRun): Promise<void> {
    const startedAt = nowIso();
    await this.executeOnce(run);
    if (run.chat?.followUp) this.followUpCost(run.slug, run.id);
    await this.drainQueue(run);
    if (await this.nudgeStatus(run, startedAt)) await this.drainQueue(run);
  }

  /** A chat reply for each message that came in too late for the run's last turn. */
  private async drainQueue(run: ActiveRun): Promise<void> {
    for (;;) {
      if (this.shuttingDown || this.restartPending) return; // queue stays on the ticket; recover() delivers it
      const t = this.store.getTicket(run.slug, run.id);
      if (!t) return;
      const next = this.waiting(run.slug, run.id)[0];
      if (!next) return;
      // Stopped, or the last reply could not even start: keep them for the user to send or discard.
      if (run.stopRequested || run.promptMsgId === next.id) {
        this.patch(run.slug, run.id, { queued: (t.queued ?? []).map((m) => (m.state === "queued" ? { ...m, state: "unsent" } : m)) });
        return;
      }
      const chat = chatFor(t, next);
      // A Planning or peer reply run that would now edit waits while another ticket edits the folder in place.
      if (takesSlot(chat, run.noEdit) && !takesSlot(run.chat, run.noEdit) && chat.mode === "act" && this.folderBusy(run.slug, t)) {
        this.waitForSlot(run.slug, run.id);
        return;
      }
      run.chat = chat;
      // A message came in after a quiet run: the user is talking to this ticket now, so it stays.
      run.quietEnd = undefined;
      run.retried = false;
      run.restartRequested = false;
      run.promptMsgId = next.id;
      run.inFlight = new Map();
      run.handle = null;
      this.begin(run);
      await this.executeOnce(run);
      if (run.chat?.followUp) this.followUpCost(run.slug, run.id);
    }
  }

  /** Where the card lands after a run: refine chats and replies to other tickets never move it. */
  private endStatus(run: ActiveRun): Partial<Ticket> {
    if (run.chat?.mode === "refine" || run.chat?.quiet) return run.targetStatus ? { status: run.targetStatus } : {};
    // A main ticket's reply or wake leaves its card where it was (a wake never sends it to Review).
    if (run.chat && run.noEdit && !run.chat.hostWake) return run.targetStatus ? { status: run.targetStatus } : {};
    const status = run.targetStatus ?? run.chat?.returnTo ?? "review";
    // Done would close the ticket's open huddle: the card waits in Review until the user closes it.
    return { status: status === "done" && !run.targetStatus && this.huddleOpen(run.slug, run.id) ? "review" : status };
  }

  /** The ticket hosts a huddle that isn't closed. */
  private huddleOpen(slug: string, id: string): boolean {
    return this.hostHuddles(slug).has(id);
  }

  /**
   * healed: this is the one retry in a new session after Claude could not find the old one.
   * resume: the board continues this run's own work in its session (a passing API error, a stall restart) with this
   * text as the whole prompt; the run otherwise ends as the one it continues (result line, column, card). Without a
   * saved session (it hung before Claude saved one) there is nothing to continue: the run starts over with its prompt.
   */
  private async executeOnce(run: ActiveRun, healed = false, resumeText?: string): Promise<void> {
    const { slug, id } = run;
    const startedAt = nowIso();
    let session: Session;
    try {
      session = await this.ensureSession(slug, id);
    } catch (e) {
      const msg = (e as Error).message;
      this.store.addComment(slug, id, "ai", `Could not start: ${msg}`);
      // refineStarted back off: moving the card into Planning again retries the interview.
      // Offline or signed out (FetchError): nothing is wrong with the ticket; the user fixes it and sends a message.
      this.patch(slug, id, { ...this.endStatus(run), outcome: e instanceof FetchError ? "blocked" : "failed", error: msg, lastActivity: null, ...(run.chat?.mode === "refine" ? { refineStarted: false } : {}) });
      return;
    }
    if (this.shuttingDown) return;
    // Unattended runs refuse to share a session with an open terminal; chat messages are the user's call (UI warns).
    if (session.existed && !run.stopRequested && !run.chat) {
      const t0 = this.store.getTicket(slug, id)!;
      const title = t0.workdir ? sessionTitle(t0.workdir, session.sessionId) : null;
      if (await this.isSessionLive(session.sessionId, title)) {
        const msg = SESSION_OPEN_MSG;
        this.store.addComment(slug, id, "ai", msg);
        this.patch(slug, id, { ...this.endStatus(run), outcome: "blocked", error: msg, lastActivity: null });
        return;
      }
    }
    if (run.stopRequested) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...this.endStatus(run), outcome: "stopped", lastActivity: null });
      return;
    }

    const t = this.store.getTicket(slug, id)!;
    const resume = session.existed ? resumeText : undefined;
    const refine = run.chat?.mode === "refine";
    // A reply to another ticket's Claude: not a run of this ticket's own work.
    const quiet = !!run.chat?.quiet;
    const profile = this.store.getProfile(slug)!;
    const runNo = t.runCount + 1;
    const newComments = this.store.listComments(slug, id).filter((c) => (c.author === "user" || c.from) && (!t.lastRunAt || c.at > t.lastRunAt));
    const outputDir = this.store.outputsDir(slug, id);
    // Start fresh session: a work run in a new session that picks up from the branch (until that session exists).
    const fresh = !!t.freshSession && !run.chat;
    // "Send in a fresh chat": the new chat's first message carries the ticket and its last result (until that chat exists).
    // A main ticket's or feature's fresh chat also seeds a wake (raw) with the status, and whatever it starts with.
    const freshChat = !!t.freshSession && !!run.chat && !session.existed && (!run.chat.raw || this.seedsFromStatus(slug, t));
    const artifacts = !!profile.artifacts || mentionsArtifact(t.body, run.chat?.text, ...newComments.map((c) => c.text));
    // Main and tool tickets get their own rules (main-ticket.ts); a failure to work them out never stops the run.
    let role: RunRole | undefined;
    try {
      role = this.roleOf(slug, t, session);
    } catch (e) {
      console.error(`role of ${slug}/${id}:`, e);
    }
    let prompt = resume ?? this.withSetupNote(slug, t, profile, session, refine, localizeAttachments(run.chat?.raw
      ? run.chat.text + (freshChat ? `\n\n${this.freshChatContext(slug, t)}` : "")
      : run.chat
      ? chatPrompt(t, run.chat.text, run.chat.mode, outputDir, artifacts, session.repo, session.inPlace, refine && !session.existed ? this.recall(slug, t) : "", role)
        + (freshChat ? `\n\n${this.freshChatContext(slug, t)}` : "")
      : fresh
      ? this.freshPrompt(slug, t, session, outputDir)
      : role?.kind === "tool" && (t.runCount === 0 || !session.existed)
      ? toolFirstPrompt(t, role, {
        comments: newComments, autoHuddles: autoHuddlesOn(profile), artifacts, recall: this.recall(slug, t),
      })
      : t.runCount === 0 || !session.existed
      ? firstRunPrompt(t, {
        repo: session.repo, inPlace: session.inPlace, home: { folder: profile.path, baseBranch: profile.baseBranch }, linked: !!t.workdir,
        // Notes other tickets' runs left reach even a ticket's first run: nobody else passes them on.
        comments: t.workdir || t.runCount > 0 ? newComments : newComments.filter((c) => c.from), outputDir,
        schedule: t.scheduleId ? this.scheduleContext(slug, t) : undefined,
        autoHuddles: autoHuddlesOn(profile), artifacts, recall: this.recall(slug, t), ...(role?.kind === "main" ? { main: role } : {}),
      })
      : resumePrompt(t, newComments, outputDir, autoHuddlesOn(profile), artifacts, session.repo, session.inPlace, { folder: profile.path, baseBranch: profile.baseBranch }, role), this.store.attachmentsDir));
    // A slash command only runs when it is the whole message: Claude Code passes everything after the name to
    // it as arguments (the board's note too). So the command goes alone and the board's instructions go in
    // the system prompt for this run.
    let systemPrompt: string | undefined;
    if (run.chat?.slash && !resume) {
      const cut = prompt.indexOf("\n\n<ckanban-context");
      if (cut >= 0) {
        systemPrompt = `The user's message in this turn is a slash command sent from the kanban board's ticket chat. The board's instructions for this run:\n\n${prompt.slice(cut + 2)}`;
        prompt = prompt.slice(0, cut);
      }
    }
    // Runs that may act learn the shared device list here, so it is current on every turn (Planning chats don't use devices).
    const deviceNote = refine ? null : devicesNote(this.devices.devices(), t.needs);
    if (deviceNote) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${deviceNote}` : deviceNote;
    // A main ticket's fixed rules go once per run here, not in every message the chat shows.
    if (role?.kind === "main" && !quiet) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${mainTicketRules(role)}` : mainTicketRules(role);
    // A feature's main chat reads its status first and keeps it current; the family's other runs may update it too.
    if (!run.chat?.nudge && !quiet) {
      let featureNote: string | null = null;
      try {
        featureNote = this.featureNote(slug, t);
      } catch (e) {
        // The status is a help, never a reason for a run to fail.
        console.error(`feature status for ${slug}/${id}:`, e);
      }
      if (featureNote) systemPrompt = systemPrompt ? `${systemPrompt}\n\n${featureNote}` : featureNote;
      // Notes the user added to the status reach the main chat at its next turn (they never start a run themselves).
      const notes = resume ? null : this.takeStatusNotes(slug, id);
      if (notes) prompt += `\n\n${notes}`;
    }

    let lastWrite = 0;
    let pendingActivity: string | null = null;
    const draft = new DraftTracker();
    run.draft = draft;
    // A reply cut off by a restart stays on screen until this run's reply replaces it.
    let showsInterrupted = !!t.interrupted;
    let draftTimer: ReturnType<typeof setTimeout> | null = null;
    const emitDraft = () => {
      draftTimer = null;
      this.bus.emit({ type: "draft", profile: slug, id, text: draft.text });
    };
    // The spending cap applies to the ticket's own work (not Planning chats or replies to other tickets).
    const cap = refine || quiet ? null : runCapFor(t, profile);
    if (!refine && !quiet && t.capNextUsd) this.patch(slug, id, { capNextUsd: null });
    // Workflow helper agents' spending doesn't count toward claude's own --max-budget-usd: the board adds it up
    // (this run's messages + its workflows' agents) and stops the run once the total reaches the cap.
    const spend = { main: new Map<string, number>(), workflowDirs: new Set<string>(), files: new Map<string, { key: string; cost: number }>() };
    const capWatch = cap === null ? null : setInterval(() => {
      if (!spend.workflowDirs.size || run.stopRequested || run.workflowCapHit !== undefined || !run.handle) return;
      const total = spentWith(spend);
      if (total < cap) return;
      run.workflowCapHit = total;
      this.patch(slug, id, { lastActivity: "Stopping: spending cap reached" });
      run.handle.stop();
    }, this.opts.capPollMs ?? WORKFLOW_CAP_POLL_MS);
    // Marks where this run starts in the log and what it was (the Usage tab lists runs by kind).
    // A resumed attempt (retry, stall restart) continues the same run in the log.
    if (!resumeText) this.store.appendActivity(slug, id, runNo, { type: "ckanban_run", kind: refine ? "planning" : quiet ? "reply" : run.chat?.followUp ? "follow-up" : run.chat ? "chat" : "work" });
    const effortNow = runOptions(t, profile, !refine);
    // The board's claude.ai connector setting: hidden connectors join --disallowedTools, "none" turns them all off.
    const connectors = boardConnectorOptions(profile);
    run.handle = startRun({
      bin: this.opts.claudeBin,
      cwd: session.dir,
      args: buildArgs(session.sessionId, session.existed, t.model ?? (t.main ? profile.mainModel : null) ?? profile.model,
        // A main ticket never edits: every change goes to a tool ticket.
        [...(refine ? planningDisallowed(t) : []), ...(t.main ? NO_EDIT_TOOLS.split(",") : []), ...connectors.disallowed], mcpConfig(undefined, this.store.boardTools(slug)), systemPrompt, cap, effortNow.effort, effortNow.ultracode),
      input: prompt,
      inputLocal: run.chat?.slash === "local" && !resume,
      planning: refine,
      // CKANBAN_TICKET marks board runs: the ckanban MCP/CLI refuses board changes there (no runs starting runs).
      env: { ...connectors.env, CKANBAN_OUTPUT_DIR: outputDir, CKANBAN_TICKET: `${slug}/${id}` },
      onEvent: (ev) => {
        const changed = draft.feed(ev);
        if (changed !== null) {
          // Clears go out at once with the finished text (the batched tail may not have gone out yet);
          // growing text is batched (~8 updates/s).
          if (changed === "") {
            if (draftTimer) clearTimeout(draftTimer);
            draftTimer = null;
            this.bus.emit({ type: "draft", profile: slug, id, text: "", ...(draft.finished ? { final: draft.finished } : {}) });
          } else if (!draftTimer) draftTimer = setTimeout(emitDraft, DRAFT_THROTTLE_MS);
        }
        if (ev?.type === "stream_event") return;
        this.watchWorkflows(slug, id, ev, spend);
        rememberInit(session.dir, ev, { projects: [profile.path] });
        if (refine && ev?.type === "assistant") this.saveMockups(slug, id, outputDir, ev);
        if (showsInterrupted && !this.shuttingDown && hasText(ev)) {
          showsInterrupted = false;
          this.patch(slug, id, { interrupted: null });
        }
        const read = replayText(ev);
        if (read !== null) this.delivered(run, read);
        this.store.appendActivity(slug, id, runNo, ev);
        this.bus.emit({ type: "activity", profile: slug, id, run: runNo, event: ev });
        const s = summarizeEvent(ev);
        // Keep "Stopping…" on the card until the process is gone.
        if (!s || run.stopRequested) return;
        pendingActivity = s;
        const now = Date.now();
        if (now - lastWrite >= ACTIVITY_THROTTLE_MS) {
          lastWrite = now;
          pendingActivity = null;
          this.patch(slug, id, { lastActivity: s });
        }
      },
      stallMs: this.stallMs(profile),
      onStall: (stalled) => {
        if (this.shuttingDown || !this.store.getTicket(slug, id)) return;
        if (!stalled) {
          if (this.store.getTicket(slug, id)?.stalled) this.patch(slug, id, { stalled: null });
          return;
        }
        if (run.stopRequested) return;
        const minutes = Math.max(1, Math.round(this.stallMs(profile) / 60_000));
        // The Notifier sees the new "stalled" attention and tells the user (webhook / macOS banner).
        this.patch(slug, id, { stalled: { at: nowIso(), minutes } });
      },
      onWaiting: (tasks) => {
        if (run.stopRequested || this.shuttingDown) return;
        const what = !tasks ? null : tasks.length === 1 ? `Waiting for background task: ${tasks[0].description}` : `Waiting for ${tasks.length} background tasks`;
        if (what) pendingActivity = null;
        this.patch(slug, id, { waitingOn: tasks, ...(what ? { lastActivity: what } : {}) });
      },
    });

    // A local command is never echoed back: it was read once it was written.
    if (run.chat?.slash === "local" && !resume && run.promptMsgId) {
      this.dropQueued(slug, id, [run.promptMsgId]);
      run.promptMsgId = undefined;
    }
    // Messages sent while the run was starting up, or left over from a run the daemon restarted.
    for (const msg of this.waiting(slug, id)) this.steer(run, msg);

    const out = await run.handle.done;
    if (capWatch) clearInterval(capWatch);
    if (draftTimer) clearTimeout(draftTimer);
    // A reply cut off before its message ended (Stop, a crash): the chat keeps it until it knows what was saved.
    if (draft.text) this.bus.emit({ type: "draft", profile: slug, id, text: "", final: draft.text });
    // Daemon is exiting: leave the ticket in_progress so recover() resumes it on next start.
    if (this.shuttingDown) return;
    const finalText = extractFinalText(out.events);
    // A steering message can get its own turn after the result line; the ticket outcome is still the last one given.
    const result = parseResult(finalText) ?? out.events
      .filter((e) => e?.type === "result" && typeof e.result === "string")
      .map((e) => parseResult(e.result))
      .findLast((r) => r !== null) ?? null;
    // Stopped before Claude got going: there is no session to resume, so the next run starts a new one.
    const started = session.existed || this.sessionExists(session.sessionId)
      || out.events.some((e) => (e?.type === "system" && e.subtype === "init") || e?.type === "assistant");
    const base: Partial<Ticket> = {
      ...this.endStatus(run),
      stalled: null,
      sessionStarted: started,
      runEndedAt: nowIso(),
      ...((fresh || freshChat) && started ? { freshSession: false, freshAuto: null } : {}),
      ...(refine || quiet ? {} : { lastRunAt: startedAt, runCount: runNo }),
      lastActivity: pendingActivity ?? this.store.getTicket(slug, id)?.lastActivity ?? null,
    };

    // Restart on a stalled run: the stuck process is gone, now the same session picks the work up again.
    if (run.handle.stopped && run.restartRequested && !run.stopRequested) {
      run.restartRequested = false;
      this.store.addComment(slug, id, "ai", "Restarted the stalled run: it continues in the same session.");
      this.patch(slug, id, { sessionStarted: started, stalled: null, lastActivity: "Restarting…" });
      return this.executeOnce(run, healed, STALL_RESTART_TEXT);
    }
    if (run.workflowCapHit !== undefined && cap !== null) {
      this.capReached(slug, id, base, cap, run.workflowCapHit);
      return;
    }
    if (run.handle.stopped) {
      this.store.addComment(slug, id, "ai", "Run stopped by user.");
      this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null, ...this.dropAutoWait(slug, id) });
      return;
    }
    if (cap !== null && out.events.some((e) => e?.type === "result" && e.subtype === "error_max_budget_usd")) {
      // Claude Code's own cap counts only this conversation: with workflows, say what they added on top.
      this.capReached(slug, id, base, cap, spend.workflowDirs.size ? spentWith(spend) : undefined);
      return;
    }
    // The account hit its usage limit: not a failure of the work, it continues once the limit resets.
    const limited = quiet || result ? null : limitMessage(out.events, out.code !== 0 ? out.stderr : "");
    if (limited) {
      this.limitHit(slug, id, base, limited);
      return;
    }
    if (out.code !== 0) {
      const error = out.stderr.trim() || finalText.trim() || `claude exited with code ${out.code}`;
      // Claude can't find the session (stopped before it was saved, cleaned up, or saved for another folder):
      // retry once in a new session instead of failing every run from now on.
      if (!healed && !this.store.getTicket(slug, id)?.workdir && sessionMissing(error, out.events)) {
        console.log(`ticket ${slug}/${id}: session ${session.sessionId} not found, starting a new one`);
        this.patch(slug, id, { sessionId: crypto.randomUUID(), sessionStarted: false, error: null });
        return this.executeOnce(run, true);
      }
      // A passing API problem (overloaded, a 5xx, a dropped connection): resume the same session once after a pause.
      const transient = run.retried || run.stopRequested ? null : transientError(out.events, out.stderr);
      if (transient) {
        run.retried = true;
        const delay = this.opts.retryDelayMs ?? RETRY_DELAY_MS;
        const line = transient.split("\n").findLast((l) => l.trim())?.trim().slice(0, 200) ?? transient;
        this.store.addComment(slug, id, "ai", `Run hit a temporary API error (${line}). Retrying once in ${Math.max(1, Math.round(delay / 1000))}s in the same session.`);
        this.patch(slug, id, { sessionStarted: started, error: null, lastActivity: "Temporary API error, retrying shortly…" });
        await Bun.sleep(delay);
        if (this.shuttingDown) return;
        if (run.stopRequested) {
          this.store.addComment(slug, id, "ai", "Run stopped by user.");
          this.patch(slug, id, { ...base, outcome: "stopped", error: null, lastActivity: null, ...this.dropAutoWait(slug, id) });
          return;
        }
        return this.executeOnce(run, healed, RETRY_TEXT);
      }
      // Claude reports a lost session only in its result event: keep it in the error so the UI offers Start fresh session.
      const shown = sessionMissing(error, out.events) && !sessionMissing(error, []) ? `No conversation found with session ID: ${session.sessionId}` : claudeSetupHint(error) ?? error;
      this.store.addComment(slug, id, "ai", `Run failed (exit ${out.code}): ${shown.split("\n").slice(-3).join("\n")}`);
      this.patch(slug, id, { ...base, outcome: "failed", error: shown });
      return;
    }
    const body = finalText.replace(/^.*CKANBAN_RESULT:.*$/gm, "").replace(MOVE_TO_PLANNING_RE, "").trim();
    // A reply to the ticket's huddle can land the work and report it: keep its PRs, summary and outcome. The card
    // stays where it is, and a ticket waiting for its auto huddle keeps waiting.
    if (quiet && result && !refine && !run.chat?.nudge) {
      const current = this.store.getTicket(slug, id)!;
      this.store.addComment(slug, id, "ai", (result.status === "questions" ? body : result.summary) || body || "(no output)");
      this.patch(slug, id, {
        ...base, lastActivity: null, error: null,
        ...(current.autoHuddle ? {} : { outcome: result.status === "questions" ? "needs_input" : result.status, ...(result.status === "questions" ? { interviewed: true } : {}) }),
        // A planner's PRs are its own work only when its own run reports them (see below).
        ...(current.plan ? {} : addPrs(current, result.prUrls)),
        ...(current.kind === "test" && !current.autoHuddle && result.status === "done" ? { verdict: result.verdict ?? null } : {}),
      });
      return;
    }
    if (refine || quiet) {
      this.patch(slug, id, { ...base, lastActivity: null, error: null });
      return;
    }
    // A Review/Done message that only asked for planning: show the ticket where it really is.
    if (run.chat?.mode === "act" && !run.targetStatus && result?.status !== "blocked" && MOVE_TO_PLANNING_RE.test(finalText)) {
      this.store.addComment(slug, id, "ai", result?.summary || body || "(no output)");
      this.patch(slug, id, {
        ...base, status: "planning",
        outcome: null, error: null, refineStarted: true, lastActivity: null,
        ...(run.chat.from && reopenable(run.chat.from.status) ? { reopenedFrom: run.chat.from } : {}),
      });
      return;
    }
    // A Review/Done message that only asked for new tickets: the card goes back where it was, outcome unchanged.
    // Not while the ticket hosts an open huddle: back in Done would close it, so the card goes to Review.
    const from = run.chat?.from;
    if (run.chat?.mode === "act" && !run.chat.raw && !run.targetStatus && from && from.status !== "in_progress" && result?.status !== "blocked" && STAY_RE.test(finalText) && !this.huddleOpen(slug, id)) {
      this.patch(slug, id, { ...base, status: from.status, outcome: from.outcome, error: null, lastActivity: null });
      return;
    }
    const current = this.store.getTicket(slug, id)!;
    // A quiet schedule's run that found nothing: Done without a word to the user; the ticket goes once the run is over.
    if (!run.chat && !run.targetStatus && result && current.scheduleId && canEndQuietly({
      schedule: this.store.getSchedule(slug, current.scheduleId), ticket: current, tickets: this.store.listTickets(slug),
      quietResult: !!result.quiet, prUrls: result.prUrls, waiting: this.waiting(slug, id).length,
    }) && !this.huddleOpen(slug, id)) {
      run.quietEnd = { summary: result.summary || body || "Nothing new.", costUsd: spentWith(spend) };
      this.store.addComment(slug, id, "ai", run.quietEnd.summary);
      this.patch(slug, id, { ...base, status: "done", outcome: "done", error: null, lastActivity: null });
      return;
    }
    // Questions must reach the user verbatim; otherwise the short summary is enough.
    const summary = (result?.status === "questions" ? body : result?.summary) || body || "(no output)";
    this.store.addComment(slug, id, "ai", summary);
    // Its auto huddle reviews the work (or it waits for the slot): the card stays In Progress until the huddle wakes it.
    const auto = current.autoHuddle;
    if (auto && !run.targetStatus && result?.status !== "blocked" && result?.status !== "questions") {
      this.patch(slug, id, {
        ...base, status: "in_progress", outcome: null, error: null, lastActivity: autoHuddleActivity(auto),
        ...addPrs(current, result?.prUrls ?? []),
      });
      return;
    }
    // A follow-up on a Done or Backlog card that needs the user: Review, where the user sees it (those columns never ask).
    const asks = result?.status === "questions" || result?.status === "blocked";
    if (run.chat?.followUp && asks && (base.status === "done" || base.status === "backlog")) base.status = "review";
    // A tool ticket whose merges into the main ticket's copy failed MERGE_TRIES times hasn't landed anything: blocked.
    const unmerged = !!current.tool && (current.mergeFails ?? 0) >= MERGE_TRIES && (result?.status ?? "done") === "done";
    // A tool ticket whose work is finished (and merged, where it merges) is Done: it has no card to review.
    const toolDone = !!current.tool && !unmerged && (result?.status ?? "done") === "done" && !run.targetStatus && !this.huddleOpen(slug, id);
    this.patch(slug, id, {
      ...base,
      ...(toolDone ? { status: "done" } : {}),
      outcome: unmerged ? "blocked" : result?.status === "questions" ? "needs_input" : result?.status ?? "done",
      ...(result?.status === "questions" ? { interviewed: true } : {}),
      // A planner wake-up reports its children's PRs; the planner keeps its own.
      ...(run.chat?.raw && !run.chat.hostWake ? {} : addPrs(current, result?.prUrls ?? [])),
      // A test ticket's result: the newest run's verdict (none: a done test counts as passed).
      ...(current.kind === "test" && result ? { verdict: result.verdict ?? null } : {}),
      error: null,
    });
    if (unmerged) this.store.addComment(slug, id, "ai", `Ended blocked: merging into the main ticket's copy failed ${MERGE_TRIES} times.`);
    // A ticket the user added to a feature (not one of its tool tickets): its result also reaches the main ticket.
    try {
      this.reportToMain(slug, id, summary);
      this.noteStepWaiting(slug, id, summary);
    } catch (e) {
      console.error(`report ${slug}/${id} to its main ticket:`, e);
    }
  }

  /** The watchdog time for this board's runs in ms (0: off). */
  private stallMs(profile: Profile): number {
    if (this.opts.stallMs !== undefined) return this.opts.stallMs;
    const m = profile.stallMinutes ?? DEFAULT_STALL_MINUTES;
    return m > 0 ? m * 60_000 : 0;
  }

  /**
   * The Inbox's answer to a stalled run. stop: as Stop. wait: clear the flag, the watchdog counts again. restart: stop the
   * stuck process and resume the same session.
   */
  stallAction(slug: string, id: string, action: "stop" | "wait" | "restart"): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const run = this.runs.get(this.key(slug, id));
    if (!run?.handle) {
      if (t.stalled) return this.patch(slug, id, { stalled: null });
      throw new Error("this ticket has no running run");
    }
    // A stale card (or a second click) must not stop or restart a run that is working again.
    if (!t.stalled || run.restartRequested) throw new Error("this run is not stalled anymore");
    if (action === "stop") {
      this.stopRun(run);
    } else if (action === "wait") {
      run.handle.keepWaiting();
      this.store.addComment(slug, id, "ai", "Kept waiting on the stalled run.");
      if (t.stalled) this.patch(slug, id, { stalled: null });
    } else {
      run.restartRequested = true;
      this.patch(slug, id, { lastActivity: "Restarting…" });
      run.handle.stop();
    }
    return this.store.getTicket(slug, id)!;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** A run stopped at its spending cap: blocked until the user continues it with more budget (continueAfterCap). */
  private capReached(slug: string, id: string, base: Partial<Ticket>, cap: number, withWorkflows?: number): void {
    const msg = `Stopped at $${cap.toFixed(2)} cap`;
    const why = withWorkflows === undefined
      ? "this run spent its budget before it finished"
      : `this run and its workflow's helper agents spent $${withWorkflows.toFixed(2)}, so the board stopped the run and its workflow`;
    this.store.addComment(slug, id, "ai", `${msg}: ${why}. Continue it with more budget, or change the ticket's cap in its ⋯ menu.`);
    this.patch(slug, id, { ...base, outcome: "blocked", error: msg, capHit: { capUsd: cap, at: nowIso() } });
  }

  /** "Continue with +$Y" after a run stopped at its cap: "continue" in the same session, with a cap of addUsd for that run. */
  async continueAfterCap(slug: string, id: string, addUsd: number): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!(Number.isFinite(addUsd) && addUsd > 0)) throw new Error("addUsd must be a positive amount");
    if (this.isRunning(slug, id)) throw new Error("this ticket is already running");
    this.patch(slug, id, { capNextUsd: addUsd });
    try {
      return await this.chat(slug, id, CONTINUE_TEXT);
    } catch (e) {
      this.patch(slug, id, { capNextUsd: null });
      throw e;
    }
  }

  /** A run ended on the usage limit: wait for the reset, then continue on its own unless turned off or capped. */
  private limitHit(slug: string, id: string, base: Partial<Ticket>, message: string): void {
    const t = this.store.getTicket(slug, id)!;
    const now = this.now();
    const resetAt = parseReset(message, now);
    const used = t.autoContinued?.day === dayKey(now) ? t.autoContinued.count : 0;
    const capped = used >= AUTO_CONTINUE_PER_DAY;
    const auto = t.autoContinue !== false && !capped;
    const limit: LimitHit = { resetAt: resetAt.toISOString(), auto, at: now.toISOString(), message, ...(capped && t.autoContinue !== false ? { capped: true } : {}) };
    const when = clockTime(resetAt, now);
    const next = auto ? `It continues automatically at ${when}.`
      : limit.capped ? `It resets at ${when}; it already continued automatically ${AUTO_CONTINUE_PER_DAY} times today, so continue it yourself.`
      : `It resets at ${when}.`;
    this.store.addComment(slug, id, "ai", `Usage limit hit: ${message}\n${next}`);
    this.patch(slug, id, { ...base, outcome: "limit", error: message, limit });
  }

  /**
   * Continue a ticket that hit the usage limit: "continue" to the same session through the normal chat path (run
   * slots, restart hold). auto: the board's own continue at the reset; it counts toward the daily cap.
   */
  async continueAfterLimit(slug: string, id: string, opts: { auto?: boolean } = {}): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (opts.auto) {
      if (t.outcome !== "limit" || !t.limit?.auto || this.isRunning(slug, id)) return t;
      const day = dayKey(this.now());
      const count = (t.autoContinued?.day === day ? t.autoContinued.count : 0) + 1;
      this.patch(slug, id, { autoContinued: { day, count } });
      this.store.addComment(slug, id, "ai", "The usage limit has reset: sent \"continue\".");
    }
    return this.chat(slug, id, CONTINUE_TEXT);
  }

  /** "Don't auto-continue" / "Auto-continue": for the current wait and later limit hits of this ticket. */
  setAutoContinue(slug: string, id: string, auto: boolean): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const limit = t.limit ? { ...t.limit, auto, capped: undefined } : t.limit;
    const out = this.patch(slug, id, { autoContinue: auto, ...(limit ? { limit } : {}) });
    if (t.parentId) this.advancePlans(slug);
    return out;
  }

  /** Tickets waiting for a usage limit to reset whose automatic continue is due (see LimitWatcher). */
  dueContinues(slug: string, delayMs: number): string[] {
    const now = this.now().getTime();
    return this.store.listTickets(slug)
      .filter((t) => t.outcome === "limit" && t.limit?.auto && !this.isRunning(slug, t.id) && t.status !== "done"
        && new Date(t.limit.resetAt).getTime() + delayMs <= now)
      .map((t) => t.id);
  }

  // ---- Follow-ups (followup.ts): Claude comes back to this ticket later ----

  /** follow_up: when Claude (or the user) wants the ticket's conversation woken again; replaces the pending one. */
  setFollowUp(slug: string, id: string, input: { after?: string | null; at?: string | null; note?: string | null; cancelOnReply?: boolean }): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const note = input.note?.trim();
    if (!note) throw new FollowUpError("note is required: why you come back, and what to check then");
    if (note.length > FOLLOW_UP_NOTE_MAX) throw new FollowUpError(`note is too long (max ${FOLLOW_UP_NOTE_MAX} characters): keep it to why and what to check`);
    const now = this.now();
    const due = followUpTime(input, now);
    const followUp: FollowUp = { dueAt: due.toISOString(), note, cancelOnReply: input.cancelOnReply !== false, setAt: now.toISOString() };
    this.store.addComment(slug, id, "ai", `Follow-up set for ${formatAt(followUp.dueAt)}: ${note}`);
    return this.patch(slug, id, {
      followUp, followUpStopped: null,
      followUpLog: logFollowUp(t.followUpLog, { at: followUp.setAt, kind: "set", dueAt: followUp.dueAt, note }),
    });
  }

  /**
   * Stop following up. by "claude": cancel_follow_up, with the reason the card shows ("Stopped following up: …").
   * by "user": Stop following up on the card; it also clears a stopped note.
   */
  cancelFollowUp(slug: string, id: string, by: "user" | "claude", reason?: string | null): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const why = reason?.trim();
    if (by === "claude" && !why) throw new FollowUpError("reason is required: one line on why you stop following up");
    if (why && why.length > FOLLOW_UP_REASON_MAX) throw new FollowUpError(`reason is too long (max ${FOLLOW_UP_REASON_MAX} characters): one line`);
    if (by === "user" && !t.followUp) return t.followUpStopped ? this.patch(slug, id, { followUpStopped: null }) : t;
    const at = this.now().toISOString();
    this.store.addComment(slug, id, "ai", by === "user" ? "Follow-up stopped by user." : `Stopped following up: ${why}`);
    return this.patch(slug, id, {
      followUp: null, followUpStopped: by === "claude" ? { at, reason: why! } : null,
      followUpLog: logFollowUp(t.followUpLog, { at, kind: "cancelled", by, ...(why ? { note: why } : {}) }),
    });
  }

  /** The user wrote in the ticket chat: Claude hears about it on its next wake, and it cancels a cancel-on-reply follow-up. */
  userReplied(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t?.followUp) return;
    const at = this.now().toISOString();
    if (!t.followUp.cancelOnReply) {
      this.patch(slug, id, { followUpLog: logFollowUp(t.followUpLog, { at, kind: "replied" }) });
      return;
    }
    this.store.addComment(slug, id, "ai", "Follow-up cancelled: you replied.");
    this.patch(slug, id, { followUp: null, followUpLog: logFollowUp(logFollowUp(t.followUpLog, { at, kind: "replied" }), { at, kind: "cancelled", by: "reply" }) });
  }

  /** The user opened the ticket: the follow-up wake prompt tells Claude when (at most one write per 5 minutes). */
  markSeen(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const now = this.now();
    if (t.seenAt && now.getTime() - new Date(t.seenAt).getTime() < 5 * 60_000) return t;
    return this.patch(slug, id, { seenAt: now.toISOString() });
  }

  /** Tickets whose follow-up is due and that are free to take it: not running, queued or waiting (FollowUpWatcher). */
  dueFollowUps(slug: string): string[] {
    const now = this.now().getTime();
    return this.store.listTickets(slug)
      .filter((t) => t.followUp && !t.followUp.missedAt && new Date(t.followUp.dueAt).getTime() <= now
        && !this.isRunning(slug, t.id) && t.status !== "in_progress" && !t.slotWait && !this.waiting(slug, t.id).length
        && !(t.outcome === "limit" && t.limit)
        && !t.error?.startsWith("corrupt"))
      .map((t) => t.id);
  }

  /**
   * Wake the ticket's conversation for its follow-up. A follow-up seen more than FOLLOW_UP_LATE_MS late waits for the
   * user instead (missedAt). manual: the user pressed Follow up now (any time, also when missed).
   */
  async wakeFollowUp(slug: string, id: string, opts: { manual?: boolean } = {}): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const f = t.followUp;
    if (!f) throw new FollowUpError("this ticket has no follow-up");
    if (this.isRunning(slug, id) || t.slotWait) {
      if (opts.manual) throw new ConflictError("Claude is working on this ticket; follow up once it has finished");
      return t;
    }
    const now = this.now();
    const late = now.getTime() - new Date(f.dueAt).getTime();
    if (!opts.manual && late > FOLLOW_UP_LATE_MS) {
      if (f.missedAt) return t;
      this.store.addComment(slug, id, "ai", `Missed follow-up: it was due ${formatAt(f.dueAt)}, while the computer was asleep or the board was off. Press Follow up now to let Claude check, or stop it.`);
      return this.patch(slug, id, { followUp: { ...f, missedAt: now.toISOString() }, followUpLog: logFollowUp(t.followUpLog, { at: now.toISOString(), kind: "missed", dueAt: f.dueAt }) });
    }
    const text = followUpWakePrompt(t, now, opts.manual);
    // Cleared before the run starts, so the next tick can't wake it twice; a follow_up call in the run sets the next one.
    this.patch(slug, id, { followUp: null, followUpLog: logFollowUp(t.followUpLog, { at: now.toISOString(), kind: "woke", dueAt: f.dueAt, note: f.note }) });
    try {
      return await this.chat(slug, id, text, { followUp: true });
    } catch (e) {
      const cur = this.store.getTicket(slug, id);
      if (cur && !cur.followUp) this.patch(slug, id, { followUp: f, followUpLog: t.followUpLog ?? [] });
      throw e;
    }
  }

  /** A follow-up run ended: its cost goes on its "woke" log entry (the menu and the next wake prompt show the total). */
  private followUpCost(slug: string, id: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t?.followUpLog?.length) return;
    const run = ticketRuns(this.store.readActivity(slug, id)).findLast((r) => r.kind === "follow-up");
    const i = t.followUpLog.findLastIndex((e) => e.kind === "woke");
    if (!run || i < 0 || t.followUpLog[i].costUsd !== undefined) return;
    const log = t.followUpLog.map((e, j) => (j === i ? { ...e, run: run.run, costUsd: Math.round(run.costUsd * 10_000) / 10_000 } : e));
    // Claude set no next follow-up and didn't say it stopped (it forgot, the run failed or was stopped): the card says so.
    const said = t.followUp || (t.followUpStopped && t.followUpStopped.at >= t.followUpLog[i].at);
    this.patch(slug, id, { followUpLog: log, ...(said ? {} : { followUpStopped: { at: this.now().toISOString(), reason: "no next follow-up was set" } }) });
  }

  /** Planning replies carry mockups as blocks (they can't write files); save them for the Outputs tab. */
  private saveMockups(slug: string, id: string, outputDir: string, ev: any) {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    const text = content.map((b: any) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
    try {
      const names = saveMockups(outputDir, text);
      if (names.length) this.patch(slug, id, { lastActivity: `Saved mockup${names.length > 1 ? "s" : ""} ${names.join(", ")}` });
    } catch (e) {
      this.store.addComment(slug, id, "ai", `Couldn't save mockups: ${(e as Error).message}`);
    }
  }

  private sessionLocks = new Map<string, Promise<unknown>>();

  /** Each board folder's version history as last seen, by folder path (see repoState); re-checked after REPO_TTL_MS. */
  private repos = new Map<string, { kind: RepoKind; at: number }>();
  private repoChecks = new Set<string>();

  /**
   * The board folder's version history, from the cache (undefined until first checked). A stale or missing entry is
   * re-checked in the background; a change re-runs dispatch, so tickets held back by an unknown state start then.
   */
  repoState(slug: string): RepoKind | undefined {
    const c = this.repos.get(this.store.getProfile(slug)?.path ?? "");
    if (!c || Date.now() - c.at > REPO_TTL_MS) void this.checkRepo(slug);
    return c?.kind;
  }

  /** Before the first check (just after a restart): guessed from the folder's .git (config names an origin or not). */
  private guessRepo(slug: string): RepoKind {
    const path = this.store.getProfile(slug)?.path;
    if (!path || !existsSync(join(path, ".git"))) return "plain";
    try {
      return readFileSync(join(path, ".git", "config"), "utf8").includes('[remote "origin"]') ? "remote" : "local";
    } catch {
      return "remote";
    }
  }

  /** The board folder has commits (so huddle reviewers get snapshots of committed code); true until known. */
  committed(slug: string): boolean {
    const k = this.repoState(slug);
    return k === undefined || k === "local" || k === "remote";
  }

  private async checkRepo(slug: string): Promise<void> {
    const profile = this.store.getProfile(slug);
    if (!profile || this.repoChecks.has(profile.path)) return;
    this.repoChecks.add(profile.path);
    try {
      this.noteRepo(slug, await repoKind(profile.path));
    } finally {
      this.repoChecks.delete(profile.path);
    }
  }

  /** Records what the folder is now (e.g. version history was just turned on); a change re-runs dispatch. */
  noteRepo(slug: string, kind: RepoKind): void {
    const path = this.store.getProfile(slug)?.path;
    if (!path) return;
    const prev = this.repos.get(path)?.kind;
    this.repos.set(path, { kind, at: Date.now() });
    if (prev !== kind && !this.shuttingDown) this.dispatch(slug);
  }

  /**
   * The ticket's runs edit the board's folder itself rather than a copy of their own: a plain folder or a repo with
   * no commits (no worktree can be made), or a ticket that already ran there. Null: not known yet (the folder's
   * version history is still being checked). Linked sessions (workdir) are the user's own and don't count.
   * Such tickets run one at a time per board (see folderBusy), as do new tickets on a board set to work in the folder.
   */
  runsInFolder(slug: string, t: Ticket): boolean | null {
    if (t.workdir || t.worktree || t.branch) return false;
    if (t.sessionStarted || t.runCount > 0) return true;
    if (workspaceOf(this.store.getProfile(slug)) === "folder") return true;
    const kind = this.repoState(slug);
    return kind === undefined ? null : kind === "plain" || kind === "empty";
  }

  /**
   * Another ticket on the board is editing the folder `t` would edit in place: its run (not a read-only Planning
   * chat) is going, or its auto huddle reviews the work there. An unknown side counts as in place, so nothing starts
   * on a guess; the version-history check re-runs dispatch.
   */
  folderBusy(slug: string, t: Ticket): boolean {
    // A main ticket never edits, so it never waits for the folder.
    if (t.main) return false;
    if (this.runsInFolder(slug, t) === false) return false;
    for (const r of this.runs.values()) {
      if (r.slug !== slug || r.id === t.id || !this.runMayEdit(r)) continue;
      const o = this.store.getTicket(slug, r.id);
      if (o && this.runsInFolder(slug, o) !== false) return true;
    }
    // Only boards whose tickets edit the folder get here, so listing them stays rare.
    return this.store.listTickets(slug).some((o) => o.id !== t.id && !!o.autoHuddle && !this.isRunning(slug, o.id) && this.runsInFolder(slug, o) !== false);
  }

  /**
   * The run may edit files: not a main ticket's (its edit tools are off), and not a Planning chat's (same), except a
   * tool ticket's, whose runs always work.
   */
  private runMayEdit(r: ActiveRun): boolean {
    if (r.noEdit) return false;
    if (r.chat?.mode !== "refine") return true;
    return !!this.store.getTicket(r.slug, r.id)?.tool;
  }

  /** For the card: it would start now (Ready, a reply waiting for a slot, a running plan's next child) but the folder is in use. */
  folderWait(slug: string, t: Ticket): boolean {
    if (this.isRunning(slug, t.id)) return false;
    const parent = t.parentId ? this.store.getTicket(slug, t.parentId) : null;
    const next = t.status === "ready" || !!t.slotWait || (t.status === "backlog" && planActive(parent?.plan));
    return next && this.folderBusy(slug, t);
  }

  /** Serialized per ticket: a run and a "copy command" click must not both create the worktree. */
  ensureSession(slug: string, id: string): Promise<Session> {
    const key = this.key(slug, id);
    const prev = this.sessionLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.ensureSessionNow(slug, id));
    this.sessionLocks.set(key, next);
    next.finally(() => {
      if (this.sessionLocks.get(key) === next) this.sessionLocks.delete(key);
    }).catch(() => {});
    return next;
  }

  private async ensureSessionNow(slug: string, id: string): Promise<Session> {
    const profile = this.store.getProfile(slug);
    if (!profile) throw new Error(`board ${slug} not found`);
    if (!existsSync(profile.path)) throw new Error(`board folder does not exist: ${profile.path}`);
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const repo = await repoKind(profile.path);
    this.noteRepo(slug, repo);
    const isGit = repo !== "plain";
    const patch: Partial<Ticket> = {};
    if (t.workdir && !existsSync(t.workdir)) throw new Error(`linked session folder no longer exists: ${t.workdir}`);
    // A ticket that already ran in the folder itself stays there: its Claude session belongs to that folder.
    // One with a branch had a worktree (removed on Done): it gets it back at the same path, so its session resumes.
    const ranInPlace = !t.worktree && !t.branch && (!!t.sessionStarted || t.runCount > 0);
    // Board set to "Work in the project folder": new tickets run there; one that already has a worktree keeps it.
    const folderMode = workspaceOf(profile) === "folder" && !t.worktree && !t.branch;
    if (isGit && !t.workdir && !ranInPlace && !folderMode && (!t.worktree || !existsSync(t.worktree))) {
      const dir = worktreeDir(profile, id);
      let branch = t.branch ?? `ck/${id}-${slugify(t.title)}`;
      if (t.branch && !existsSync(dir) && !(await branchExists(profile.path, t.branch))) {
        // Claude may have renamed the branch in its worktree: take the ticket's newest one, else start over from base.
        const renamed = (await branchesWithPrefix(profile.path, `ck/${id}-`))[0];
        if (renamed) branch = renamed;
        else patch.notice = `Branch "${t.branch}" was not found, so this ticket's worktree starts again from the base branch.`;
      }
      const base = existsSync(dir) ? profile.baseBranch : await resolveBaseBranch(profile.path, profile.baseBranch);
      if (base === null) {
        // Fresh `git init` with no commits: nothing to branch from, so run in the folder rather than fail.
        patch.notice = "This repo has no commits yet, so Claude works directly in your folder instead of an isolated worktree. Make a first commit to give new tickets their own worktree.";
      } else {
        if (base !== profile.baseBranch) {
          console.log(`profile ${slug}: base branch "${profile.baseBranch}" not found, using "${base}"`);
          const fixed = { ...profile, baseBranch: base };
          this.store.saveProfile(fixed);
          this.bus.emit({ type: "profile.updated", slug, profile: fixed });
          if (profile.baseBranch) patch.notice = `Base branch "${profile.baseBranch}" was not found in this repo, so the board now uses "${base}".`;
        }
        const fresh = !existsSync(dir);
        if (fresh) {
          // A new branch starts from the remote's latest base (other tickets push there); an existing one keeps its history.
          // An add-on to a ticket still in Review builds on that ticket's branch, while it exists.
          const from = t.startFrom && (await branchExists(profile.path, t.startFrom)) ? t.startFrom
            : repo === "remote" && !(await branchExists(profile.path, branch)) ? await latestBase(profile.path, base) : base;
          await addWorktree(profile.path, dir, branch, from);
          // Only the cheap part now; the setup command runs when Claude asks for it (runSetup).
          this.copyWorktreeFiles(slug, id, profile, dir);
          patch.setupPending = true;
          // A main ticket's Changes tab shows its whole family's work since here, landed milestones included.
          if (t.main && !t.startSha) {
            const head = await runCmd(["git", "rev-parse", "HEAD"], dir);
            if (head.code === 0 && head.stdout.trim()) patch.startSha = head.stdout.trim();
          }
        }
        if (t.startFrom) patch.startFrom = null;
        patch.worktree = dir;
        patch.branch = branch;
      }
    }
    // In place on a repo with commits: the folder's HEAD at the first run is what the Changes tab diffs against.
    if (!t.workdir && !t.worktree && !patch.worktree && !t.baseSha && (repo === "local" || repo === "remote")) {
      const head = await runCmd(["git", "rev-parse", "HEAD"], profile.path);
      if (head.code === 0 && head.stdout.trim()) patch.baseSha = head.stdout.trim();
    }
    if (!t.sessionId) patch.sessionId = crypto.randomUUID();
    if (Object.keys(patch).length) t = this.patch(slug, id, patch);
    const sessionId = t.sessionId!;
    return {
      dir: t.workdir ?? t.worktree ?? profile.path,
      sessionId,
      // Only a saved session can be resumed (a run stopped in its first second leaves none); a linked one is the user's.
      existed: (!!t.workdir && !t.freshSession) || this.sessionExists(sessionId),
      isGit,
      repo,
      inPlace: !t.workdir && !t.worktree,
    };
  }

  /** Work runs in a worktree whose setup command hasn't run yet learn how to run it; planning chats never do. */
  private withSetupNote(slug: string, t: Ticket, profile: Profile, session: Session, refine: boolean, prompt: string): string {
    if (refine || !t.setupPending || !t.worktree || session.dir !== t.worktree || !profile.setupCommand?.trim()) return prompt;
    return withBoardText(prompt, setupNote(slug, t.id), "Setup");
  }

  /** Copies the board's git-ignored files (.env) into a new worktree. Quiet: missing ones are only logged. */
  private copyWorktreeFiles(slug: string, id: string, profile: Profile, dir: string): void {
    if (!profile.copyFiles?.length) return;
    try {
      const { missing } = copySetupFiles(profile.path, dir, profile.copyFiles);
      if (missing.length) console.log(`ticket ${slug}/${id}: files to copy not found: ${missing.join(", ")}`);
    } catch (e) {
      console.error(`ticket ${slug}/${id}: copying files into the worktree failed: ${(e as Error).message}`);
    }
  }

  /**
   * Runs the board's setup command in the ticket's worktree, when its Claude asks (`ckanban ticket setup`). Calls while
   * one runs share it; after a success it isn't run again for this worktree. Never throws for a failed command: the
   * result carries its output, and Claude decides what to do.
   */
  runSetup(slug: string, id: string): Promise<SetupOutcome> {
    const profile = this.store.getProfile(slug);
    const t = this.store.getTicket(slug, id);
    if (!profile || !t) return Promise.reject(new Error(`ticket ${id} not found`));
    const key = this.key(slug, id);
    const running = this.setups.get(key);
    if (running) return running.done;
    const command = profile.setupCommand?.trim() ?? "";
    if (!t.worktree || !existsSync(t.worktree)) return Promise.resolve({ status: "no-worktree" });
    if (!command) return Promise.resolve({ status: "no-command" });
    if (!t.setupPending) return Promise.resolve({ status: "already-done" });
    const dir = t.worktree;
    const abort = new AbortController();
    const done = (async (): Promise<SetupOutcome> => {
      this.patch(slug, id, { lastActivity: INSTALLING });
      let r: SetupResult | null = null;
      try {
        r = (await prepareWorktree(profile.path, dir, { setupCommand: command }, {
          signal: abort.signal, timeoutMs: SETUP_TIMEOUT_MS, env: { CKANBAN_TICKET: `${slug}/${id}` },
        }))!;
      } finally {
        // The worktree may have been removed or replaced meanwhile: only mark the one it ran in.
        const now = this.store.getTicket(slug, id);
        if (now) {
          this.patch(slug, id, {
            ...(r?.ok && now.worktree === dir ? { setupPending: false } : {}),
            ...(now.lastActivity === INSTALLING ? { lastActivity: null } : {}),
          });
        }
      }
      if (!r.ok) console.log(`ticket ${slug}/${id}: setup failed (${r.command}): ${r.output.split("\n").slice(-3).join(" | ")}`);
      return { status: "ran", result: r };
    })();
    this.setups.set(key, { done, abort });
    done.finally(() => {
      if (this.setups.get(key)?.done === done) this.setups.delete(key);
    }).catch(() => {});
    return done;
  }

  /** Removes a ticket's worktree, running the board's cleanup command in it first (its failure never blocks). */
  private removeTicketWorktree(profile: Profile, dir: string): ReturnType<typeof removeWorktree> {
    const cleanup = profile.cleanupCommand?.trim();
    return removeWorktree(profile.path, dir, cleanup ? async () => {
      const r = await runShell(dir, cleanup, { timeoutMs: CLEANUP_TIMEOUT_MS });
      if (!r.ok) console.error(`worktree cleanup failed in ${dir} (${cleanup}): ${r.output.split("\n").slice(-5).join(" | ")}`);
    } : undefined);
  }

  async planningCommand(slug: string, id: string): Promise<string> {
    const s = await this.ensureSession(slug, id);
    const t = this.store.getTicket(slug, id)!;
    return planningCommand(s.dir, s.sessionId, localizeAttachments(planningPrompt(t, this.store.ticketPath(slug, id)), this.store.attachmentsDir), s.existed);
  }

  async createTicket(
    slug: string,
    input: {
      title: string; body: string; status: Status; mode?: TicketMode; scheduleId?: string; jobId?: string; source?: TicketSource; parentId?: string; planKey?: string; dependsOn?: string[];
      needs?: string[]; tags?: string[]; important?: boolean; partOf?: string; partOfVia?: "chat";
      model?: string | null; raisedBy?: { scheduleId: string; ticketId: string } | null; proposedAs?: string; kind?: TicketKind | null;
      effort?: string | null; main?: boolean; tool?: boolean; startFrom?: string | null;
    },
  ): Promise<Ticket> {
    const status = input.status === "in_progress" ? "ready" : input.status;
    input = this.placeInFeature(slug, input);
    const star = starredTitle(input.title);
    const t = this.store.createTicket(slug, {
      ...input, status, needs: normalizeNeeds(input.needs), tags: normalizeTags(input.tags),
      ...(star.important && star.title.trim() ? { title: star.title, important: true } : {}),
    });
    this.emitTicket(slug, t);
    // The planner's "Review proposal" badge depends on which of its proposed tickets exist.
    const parent = input.parentId ? this.store.getTicket(slug, input.parentId) : null;
    if (parent) this.emitTicket(slug, parent);
    if (status === "ready") this.dispatch(slug);
    if (status === "planning") this.autoRefine(slug, t.id);
    if (parent) this.advancePlans(slug);
    return this.store.getTicket(slug, t.id)!;
  }

  /**
   * Where a new ticket goes in its family: a round is titled "Testing round N" by the board and always hangs right under
   * the feature's top ticket (also when created under a group); any other link below level 2 is refused with a hint.
   */
  private placeInFeature<T extends { title: string; kind?: TicketKind | null; partOf?: string; partOfVia?: "chat"; parentId?: string }>(slug: string, input: T): T {
    const tickets = this.store.listTickets(slug);
    const parent = input.partOf ?? input.parentId ?? null;
    if (input.kind === "round") {
      const top = parent ? familyRoot(tickets, parent) : undefined;
      const out = { ...input, title: nextRoundTitle(tickets, top?.id ?? null) };
      if (top && top.id !== parent) Object.assign(out, { partOf: top.id, partOfVia: undefined });
      return out;
    }
    if (parent && tickets.some((t) => t.id === parent) && levelOf(tickets, parent) + 1 > MAX_LEVEL) throw new Error(tooDeepMessage(tickets, parent));
    return input;
  }

  async updateTicket(
    slug: string,
    id: string,
    patch: Partial<Pick<Ticket, "title" | "body" | "status" | "order" | "mode" | "notice" | "dependsOn" | "needs" | "tags" | "suggestedTags" | "important" | "runCapUsd" | "model" | "effort" | "ultracode">> & {
      expectedBody?: string;
      /** null: take the ticket out of its plan (only clearing is allowed here; adoptTickets sets it). */
      parentId?: null;
    },
    /** byUser: the user's own move (on the board, or asked for in the ticket's chat), not a run's or a planner's. */
    opts: { byUser?: boolean } = {},
  ): Promise<Ticket> {
    let current = this.store.getTicket(slug, id);
    if (!current) throw new Error(`ticket ${id} not found`);
    if (patch.body !== undefined && patch.expectedBody !== undefined && patch.expectedBody !== current.body) {
      throw new ConflictError("description changed since you started editing (Claude may have updated it); reload and retry");
    }
    const clean: Partial<Ticket> = {};
    if (patch.title !== undefined) {
      const star = starredTitle(patch.title);
      clean.title = star.important && star.title.trim() ? star.title : patch.title;
      if (clean.title !== patch.title) clean.important = true;
    }
    if (patch.body !== undefined) clean.body = patch.body;
    if (patch.order !== undefined) clean.order = patch.order;
    if (patch.mode !== undefined) clean.mode = patch.mode;
    if (patch.notice !== undefined) clean.notice = patch.notice;
    if (patch.runCapUsd !== undefined) clean.runCapUsd = patch.runCapUsd;
    if (patch.model !== undefined) clean.model = patch.model;
    if (patch.effort !== undefined) clean.effort = patch.effort;
    if (patch.ultracode !== undefined) clean.ultracode = patch.ultracode;
    if (patch.needs !== undefined) clean.needs = normalizeNeeds(patch.needs);
    if (patch.tags !== undefined) clean.tags = normalizeTags(patch.tags);
    if (patch.suggestedTags !== undefined || patch.tags !== undefined) {
      // A suggestion that is now a tag is no longer a suggestion.
      const tags = clean.tags ?? current.tags ?? [];
      clean.suggestedTags = normalizeTags(patch.suggestedTags ?? current.suggestedTags).filter((s) => !tags.includes(s));
    }
    if (patch.important !== undefined) clean.important = !!patch.important;
    if (patch.parentId === null && current.parentId) {
      const plannerId = current.parentId;
      const me = current;
      const users = childrenOf(this.store.listTickets(slug), plannerId).filter((s) => s.id !== id && resolveDeps(s, [s, me]).deps.length);
      if (users.length) {
        throw new Error(`${users.map((u) => `"${u.title}"`).join(", ")} ${users.length === 1 ? "depends" : "depend"} on this ticket; change their dependsOn first`);
      }
      // Its dependencies and key named siblings of the plan it leaves.
      Object.assign(clean, { parentId: null, planKey: null, dependsOn: [] });
    }
    if (patch.dependsOn !== undefined && clean.parentId !== null) {
      clean.dependsOn = patch.dependsOn;
      if (current.parentId) {
        const siblings = childrenOf(this.store.listTickets(slug), current.parentId).map((s) => (s.id === id ? { ...s, dependsOn: patch.dependsOn } : s));
        const me = siblings.find((s) => s.id === id)!;
        const { missing } = resolveDeps(me, siblings);
        if (missing.length) throw new Error(`unknown dependency ${missing.map((m) => `"${m}"`).join(", ")}: use a sibling's ticket id or key`);
        const cycle = findCycle(siblings);
        if (cycle) throw new Error(`dependency cycle: ${cycle.join(" → ")}`);
      }
    }
    let status = patch.status;
    // A reply waiting for a slot stays put when reordered; moved elsewhere, it stops waiting.
    if (current.slotWait && status === "in_progress") status = undefined;
    if (status === "in_progress" && !this.isRunning(slug, id)) status = "ready";
    if (current.slotWait && status) current = this.cancelSlotWait(slug, id);

    const active = this.runs.get(this.key(slug, id));
    if (active && status && status !== "in_progress") {
      active.targetStatus = status;
      this.stopRun(active);
      await active.promise;
      current = this.store.getTicket(slug, id)!;
    }
    // The store places the ticket in its new column unless the patch carries a drop position.
    if (status && status !== current.status) clean.status = status;
    // Moved by hand: the user takes it from here, no automatic continue, and the card no longer waits for an auto huddle.
    if (clean.status && current.limit) clean.limit = null;
    if (clean.status && current.autoHuddle) clean.autoHuddle = null;
    if (clean.status && current.snooze) clean.snooze = null;
    // Back to Planning/Backlog from Review/Done: remember where it was, so an add-on can put it back there.
    const shaping = clean.status === "planning" || clean.status === "backlog";
    if (shaping && reopenable(current.status)) clean.reopenedFrom = { status: current.status, outcome: current.outcome };
    else if (clean.status && !shaping && current.reopenedFrom) clean.reopenedFrom = null;
    let t = this.patch(slug, id, clean);

    if (clean.status === "done") t = await this.cleanupWorktree(slug, t);
    if (clean.status === "planning") this.autoRefine(slug, id);
    // The user moving a stopped main ticket back to work resumes its paused plan (before its run starts and reads it).
    if (opts.byUser && t.main && (clean.status === "ready" || clean.status === "in_progress")) this.resumeStoppedPlan(slug, id, "you moved it to " + clean.status.replace("_", " "));
    if (active || clean.status === "ready" || (clean.order !== undefined && t.status === "ready")) this.dispatch(slug);
    this.advancePlans(slug);
    return this.store.getTicket(slug, id)!;
  }

  // ---- Plans: a planner ticket runs its children unattended (see plan.ts) ----

  /** Start (or resume) the planner's plan: children switch to auto mode and start in dependency order. */
  startPlan(slug: string, id: string, opts: { maxConcurrent?: number; byPlanner?: boolean; why?: string } = {}): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    const kids = childrenOf(this.store.listTickets(slug), id);
    const problem = planProblem(kids);
    if (problem) throw new Error(`can't start the plan: ${problem}`);
    const prev = t.plan;
    const resuming = prev && prev.state !== "done";
    const plan: Plan = resuming
      ? {
        ...prev,
        state: prev.awaiting === "final" || prev.state === "finishing" ? "finishing" : "running",
        reason: null,
        // A stuck plan starts fresh: its last wake-up is over and the planner looks at every open child again.
        ...(prev.state === "stuck" ? { wakeups: 0, awaiting: null, seen: {} } : {}),
      }
      : { state: "running", maxConcurrent: DEFAULT_MAX_CONCURRENT, wakeups: 0, startedAt: nowIso(), originalCount: kids.length, inbox: [], seen: {}, retries: {}, awaiting: null };
    if (opts.maxConcurrent !== undefined) plan.maxConcurrent = clampConcurrency(opts.maxConcurrent);
    // Unattended: children must not stop to interview the user.
    for (const k of kids) if (k.status === "backlog" && k.mode !== "auto") this.patch(slug, k.id, { mode: "auto" });
    const out = this.patch(slug, id, { plan, ...(t.outcome && t.outcome !== "done" ? { outcome: null } : {}) });
    const by = opts.byPlanner ? " by the planner" : "";
    this.store.addComment(slug, id, "ai", resuming ? `Plan resumed${by}${opts.why ? `: ${opts.why}` : ""}.` : `Plan started${by}: ${kids.length} child tickets, ${plan.maxConcurrent} at a time.`);
    this.advancePlans(slug);
    return this.store.getTicket(slug, id) ?? out;
  }

  /**
   * Stop on a main ticket pauses its plan only until the user acts on it again: moving it to ready (or In progress),
   * or writing or answering a form in its chat, resumes it (see updateTicket and chat). Any paused main ticket counts,
   * also ones paused before this rule existed. True when a paused plan resumed.
   */
  resumeStoppedPlan(slug: string, id: string, why: string): boolean {
    const t = this.store.getTicket(slug, id);
    if (!t?.main || t.plan?.state !== "paused") return false;
    try {
      this.startPlan(slug, id, { why });
      return true;
    } catch (e) {
      this.store.addComment(slug, id, "ai", `Couldn't resume the paused plan: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * A main ticket's own run made a new tool ticket while its card was parked in Done or Backlog: the user asked it for
   * this work, so the card goes back to Review and its plan runs the step (parked, it would sit in Backlog for good).
   * Only for the main ticket's own runs: a tool ticket making steps doesn't undo the user's park. True when it moved.
   */
  unparkForNewStep(slug: string, id: string): boolean {
    const t = this.store.getTicket(slug, id);
    if (!t?.main || (t.status !== "done" && t.status !== "backlog")) return false;
    const from = t.status === "done" ? "Done" : "Backlog";
    // patch, not updateTicket: the main ticket's run that made the step is still going and must not be stopped.
    this.patch(slug, id, { status: "review", reopenedFrom: null });
    this.store.addComment(slug, id, "ai", `Moved back from ${from}: it made a new step, so its steps run again.`);
    return true;
  }

  /** Pause: no new children start and the planner isn't woken; running children finish. */
  pausePlan(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    if (t.plan.state === "done") return t;
    this.store.addComment(slug, id, "ai", "Plan paused.");
    return this.patch(slug, id, { plan: { ...t.plan, state: "paused" } });
  }

  /** Mark the plan done as it stands, without waking the planner (e.g. a stuck plan the user resolved by hand). */
  markPlanDone(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    if (t.plan.state === "done") return t;
    return this.closePlan(slug, t, t.plan, "Plan marked done.");
  }

  setPlanConcurrency(slug: string, id: string, n: number): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t?.plan) throw new Error("this ticket has no plan");
    const out = this.patch(slug, id, { plan: { ...t.plan, maxConcurrent: clampConcurrency(n) } });
    this.advancePlans(slug);
    return out;
  }

  /**
   * The ticket's current run works unattended on its own ticket (a Ready / In Progress run, a plan child, a schedule
   * run, or its auto huddle waking it), not a Planning chat, a reply to the user's message or to another ticket.
   */
  unattendedRun(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r || r.stopRequested) return false;
    if (!r.chat) return true;
    return !!r.chat.hostWake;
  }

  /** start_huddle in this run: false when the run already started an auto huddle (one per run). */
  claimAutoHuddle(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r || r.autoHuddleStarted) return false;
    r.autoHuddleStarted = true;
    return true;
  }

  /** Set or clear the ticket's auto huddle state (Huddles drives it). */
  setAutoHuddle(slug: string, id: string, autoHuddle: Ticket["autoHuddle"], extra: Partial<Ticket> = {}): Ticket | null {
    if (!this.store.getTicket(slug, id)) return null;
    return this.patch(slug, id, { autoHuddle, ...extra });
  }

  /** A stopped ticket no longer waits for an auto-huddle slot (a live auto huddle carries on; the user closes it). */
  private dropAutoWait(slug: string, id: string): Partial<Ticket> {
    return this.store.getTicket(slug, id)?.autoHuddle?.state === "waiting" ? { autoHuddle: null } : {};
  }

  /** The ticket's current run answers a message the user typed in its chat (see ActiveRun.chat.user). */
  userChatRun(slug: string, id: string): boolean {
    return !!this.runs.get(this.key(slug, id))?.chat?.user;
  }

  /**
   * The ticket's own chat, answering the user's own words (userAskedRun), asks to move its card: the board moves it
   * once the run ends, so the reply isn't cut off. False when the run doesn't answer the user.
   */
  requestSelfMove(slug: string, id: string, status: SelfMove): boolean {
    const run = this.runs.get(this.key(slug, id));
    if (!run || !this.userAskedRun(slug, id)) return false;
    run.selfMove = status;
    return true;
  }

  /**
   * The ticket's current run acts on the user's own words: it answers a message the user typed in its chat (not a
   * slash command), or the user typed one that was handed to it while it worked. Peer messages, planner messages,
   * huddle wakes and follow-ups don't count. start_huddle with trigger "user" needs this.
   */
  userAskedRun(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (!r || r.stopRequested) return false;
    return (!!r.chat?.user && !r.chat.slash) || !!r.userSteered;
  }

  /**
   * The planner ticket a run belongs to, if that run may manage the ticket's own children: any run of a running
   * plan (wake-ups), or a reply to the user's chat message in any plan state, so the user can still tidy up a finished
   * plan's children (e.g. mark them done). Restarting a done plan stays refused (see plan_control in http.ts).
   */
  plannerRights(slug: string, runTicketId: string): Ticket | null {
    const t = this.store.getTicket(slug, runTicketId);
    if (!t) return null;
    // A main ticket (or a tool group) manages its own family in every run, whoever started it; not in a quiet reply.
    if (isManager(t)) {
      const r = this.runs.get(this.key(slug, runTicketId));
      if (r && !r.stopRequested && !r.chat?.quiet) return t;
    }
    if (planActive(t.plan)) return t;
    return this.userChatRun(slug, runTicketId) ? t : null;
  }

  /**
   * The ticket whose Planning chat (refine mode) is answering a message the user typed: that reply may manage
   * other tickets on the board for the user (see plannerFor in http.ts). Plan wake-ups and peer replies don't count.
   */
  userRequestRights(slug: string, runTicketId: string): Ticket | null {
    const chat = this.runs.get(this.key(slug, runTicketId))?.chat;
    return chat?.mode === "refine" && chat.user ? this.store.getTicket(slug, runTicketId) ?? null : null;
  }

  /**
   * The ticket whose run may change other tickets on its board on its own (see runRights in http.ts): a work run or a
   * chat reply that acts on the ticket. Planning chats keep needing the user's message (userRequestRights), and a quiet
   * reply to another session (a peer run) gets nothing, so asking a ticket a question can't hand it a chain of runs.
   */
  runnerRights(slug: string, runTicketId: string): Ticket | null {
    const r = this.runs.get(this.key(slug, runTicketId));
    if (!r || r.stopRequested || r.chat?.mode === "refine" || r.chat?.quiet) return null;
    return this.store.getTicket(slug, runTicketId) ?? null;
  }

  /**
   * A run starts another ticket's run: refused past MAX_RUN_CHAIN or MAX_RUN_STARTS, otherwise counted. Returns what
   * goes in the started ticket's startedBy.
   */
  runStart(slug: string, runTicketId: string): NonNullable<Ticket["startedBy"]> {
    const by = this.store.getTicket(slug, runTicketId)?.startedBy;
    const depth = (by?.depth ?? 0) + 1;
    if (depth > MAX_RUN_CHAIN) {
      throw new Error(`this run was started by another ticket's run (${by!.ticketId}), and a chain of runs started by runs stops at ${MAX_RUN_CHAIN}: ` +
        "it can't start more runs. Ask the user to start it on the board");
    }
    const r = this.runs.get(this.key(slug, runTicketId));
    if (r) {
      if ((r.runStarts ?? 0) >= MAX_RUN_STARTS) {
        throw new Error(`this run already started ${MAX_RUN_STARTS} other tickets' runs, the most one run may start. Ask the user to start it on the board`);
      }
      r.runStarts = (r.runStarts ?? 0) + 1;
    }
    return { ticketId: runTicketId, depth };
  }

  /** Who started the ticket's latest run: another ticket's run (runStart), or null when the user started it. */
  markStartedBy(slug: string, id: string, by: Ticket["startedBy"]): void {
    const t = this.store.getTicket(slug, id);
    if (!t || (!t.startedBy && !by)) return;
    this.patch(slug, id, { startedBy: by ?? null });
  }

  /**
   * Manager mode: make existing tickets children of this one, so its plan runs them. Tickets on another board, the
   * ticket itself or its ancestors (a cycle), tickets in another plan and finished ones are skipped with a reason.
   */
  adoptTickets(slug: string, plannerId: string, ids: string[]): { adopted: Ticket[]; skipped: { id: string; reason: string }[] } {
    const planner = this.store.getTicket(slug, plannerId);
    if (!planner) throw new Error(`ticket ${plannerId} not found`);
    const ancestors = new Set<string>();
    for (let p = planner.parentId; p && !ancestors.has(p); p = this.store.getTicket(slug, p)?.parentId) ancestors.add(p);
    const adopted: Ticket[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(ids.map((x) => x.trim()).filter(Boolean))]) {
      const t = this.store.getTicket(slug, id);
      const reason = !t ? `not found on board ${slug}`
        : t.id === plannerId ? "that is this ticket itself"
        : ancestors.has(t.id) ? "it is a parent of this ticket (that would make a cycle)"
        : t.parentId === plannerId ? "already in this plan"
        : t.parentId ? `belongs to plan ${t.parentId}`
        : t.status === "done" ? "already done"
        : t.error?.startsWith("corrupt") ? "its ticket file is corrupt"
        : !t.partOf && !t.addOnOf && levelOf(this.store.listTickets(slug), plannerId) + 1 > MAX_LEVEL ? tooDeepMessage(this.store.listTickets(slug), plannerId)
        : null;
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      adopted.push(this.patch(slug, id, { parentId: plannerId, ...(t!.main ? { main: false } : {}) }));
      this.store.addComment(slug, id, "ai", `Adopted by plan ${plannerId} ("${planner.title}").`);
    }
    if (adopted.length) {
      this.store.addComment(slug, plannerId, "ai", `Adopted ${adopted.length} ticket${adopted.length === 1 ? "" : "s"}: ${adopted.map((t) => `${t.id} "${t.title}"`).join(", ")}.`);
      const p = this.store.getTicket(slug, plannerId)!;
      // A plan under way grows with its new children: its create cap and wake-up budget count them.
      if (p.plan && p.plan.state !== "done") this.patch(slug, plannerId, { plan: { ...p.plan, originalCount: p.plan.originalCount + adopted.length } });
      else this.emitTicket(slug, p);
      this.advancePlans(slug);
    }
    return { adopted, skipped };
  }

  /** The planner restarts a child that already ran: counted, and refused past MAX_RETRIES. */
  countRetry(slug: string, plannerId: string, childId: string, max: number): void {
    const p = this.store.getTicket(slug, plannerId);
    if (!p?.plan) return;
    const n = (p.plan.retries?.[childId] ?? 0) + 1;
    if (n > max) throw new Error(`retry limit reached: ${childId} was already restarted ${max} times; skip or split it, or end with "blocked" for the user`);
    this.patch(slug, plannerId, { plan: { ...p.plan, retries: { ...p.plan.retries, [childId]: n } } });
  }

  private advancing = new Set<string>();
  /** When a planner with waiting events gets woken, per planner: children that fail together arrive as one message. */
  private wakeDue = new Map<string, number>();
  private advanceAgain = new Set<string>();

  /** Move every running plan on the board forward. Cheap and idempotent: call it after any change. */
  advancePlans(slug: string): void {
    if (this.shuttingDown || this.restartPending) return;
    if (this.advancing.has(slug)) {
      this.advanceAgain.add(slug);
      return;
    }
    this.advancing.add(slug);
    try {
      do {
        this.advanceAgain.delete(slug);
        const all = this.store.listTickets(slug);
        let started = false;
        for (const p of all) {
          if (!p.plan || p.plan.state === "done" || p.plan.state === "paused") continue;
          try {
            started = this.advancePlan(slug, p, childrenOf(all, p.id)) || started;
          } catch (e) {
            console.error(`plan ${slug}/${p.id}:`, e);
          }
        }
        if (started) this.dispatch(slug);
      } while (this.advanceAgain.has(slug));
    } finally {
      this.advancing.delete(slug);
    }
  }

  /** One plan; true when it moved children to Ready. */
  private advancePlan(slug: string, planner: Ticket, kids: Ticket[]): boolean {
    let plan = { ...planner.plan! };
    const plannerBusy = this.isRunning(slug, planner.id);
    // The planner's last wake-up has finished: its outcome decides whether we go on.
    if (plan.awaiting && !plannerBusy) {
      const o = planner.outcome;
      // Waiting for a usage limit to reset: the planner's automatic continue picks the wake-up up again.
      if (o === "limit" && planner.limit?.auto) return false;
      if (o === "limit") {
        this.stuck(slug, planner, plan, "the planner's run hit the usage limit");
        return false;
      }
      if (o === "blocked" || o === "needs_input" || o === "failed" || o === "stopped") {
        this.stuck(slug, planner, plan, o === "needs_input" ? "the planner has questions for you" : `the planner's run ${o === "blocked" ? "is blocked" : o}`);
        return false;
      }
      if (plan.awaiting === "final") {
        this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, finishedAt: nowIso() } });
        this.store.addComment(slug, planner.id, "ai", "Plan done: all child tickets finished and the final check ran.");
        this.notify(`Plan done: ${planner.title}`, "All child tickets finished. Summary in the ticket's outputs.", slug, planner.id);
        return false;
      }
      plan.awaiting = null;
    }
    if (plan.state === "stuck" && !planner.main) {
      // Whatever made it stuck is gone once every child is finished (e.g. its last PR got merged): close it, no run needed.
      if (kids.length && kids.every(isComplete)) this.closePlan(slug, planner, plan, "Plan done: every child ticket finished, so the stuck plan was closed without another run.");
      return false;
    }
    if (plan.state === "finishing") {
      if (!plan.awaiting && !plannerBusy) this.wake(slug, planner, plan, "final", [], kids);
      else if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
      return false;
    }
    const managed = managedPlan(planner);
    const step = planStep(plan, kids, (id) => this.isRunning(slug, id), {
      waitingOnUser: (t) => this.userWait(t),
      ...(managed ? { managed: { summary: (t: Ticket) => this.lastSummary(slug, t.id), report: (t: Ticket) => this.reportOf(slug, t.id) } } : {}),
    });
    // A main ticket parked in Backlog or Done: no new tool ticket starts and it isn't woken (running ones finish, queued
    // ones wait); moving it back to In progress lets them go on.
    const parked = !!planner.main && (planner.status === "backlog" || planner.status === "done");
    // (Plans saved before the spending check-in was removed may still have a "checkin" field: nothing reads it.)
    const held = parked;
    // A stuck main ticket isn't woken until the user acts, but its steps still start once their dependencies are done
    // (their results wait in the inbox for its next wake).
    const quiet = plan.state === "stuck";
    if (!held) for (const cid of step.start) this.patch(slug, cid, { status: "ready", mode: "auto", outcome: null, error: null });
    if (step.events.length) {
      plan.inbox = [...(plan.inbox ?? []), ...step.events.map((e) => e.line)];
      plan.seen = { ...plan.seen, ...Object.fromEntries(step.events.map((e) => [e.childId, e.sig])) };
      // Results also show in the planner's chat as cards.
      const cards = step.events.filter((e) => e.result).map((e) => this.resultCard(slug, e.childId)).filter((c): c is ResultCard => !!c);
      if (cards.length) this.patch(slug, planner.id, { results: [...(this.store.getTicket(slug, planner.id)?.results ?? []), ...cards].slice(-RESULTS_KEEP) });
    }
    if (held || quiet) {
      if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
      return !held && step.start.length > 0;
    }
    const inbox = plan.inbox ?? [];
    if (!plannerBusy && !plan.awaiting) {
      if (inbox.length) {
        if (managed) {
          // Runaway loops: wakes in a row in which no tool ticket changed or was made mean the plan is stuck.
          const p = progressStep(plan, familySig(kids));
          if (p.stuck) {
            this.stuck(slug, planner, plan, `${p.noProgress} wakes in a row without any tool ticket changing; waiting events: ${inbox.join("; ").slice(0, 600)}`);
            return false;
          }
        } else if (plan.wakeups >= wakeupCap(Math.max(plan.originalCount, kids.length))) {
          this.stuck(slug, planner, plan, `wake-up limit reached (${plan.wakeups}); waiting events: ${inbox.join("; ")}`);
          return step.start.length > 0;
        }
        const key = this.key(slug, planner.id);
        const due = this.wakeDue.get(key);
        if (due === undefined) {
          const delay = this.opts.planWakeDelayMs ?? 3000;
          this.wakeDue.set(key, Date.now() + delay);
          setTimeout(() => this.advancePlans(slug), delay + 5);
        } else if (Date.now() >= due) {
          this.wakeDue.delete(key);
          this.wake(slug, planner, plan, "event", inbox, kids);
          return step.start.length > 0;
        }
        if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
        return step.start.length > 0;
      }
      if (step.allComplete || (planner.main && !kids.length)) {
        // A main ticket already heard every result: its plan just rests until a new tool ticket comes (no extra wake).
        if (planner.main) {
          this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, reason: null, finishedAt: nowIso() } });
          return false;
        }
        this.wake(slug, planner, { ...plan, state: "finishing" }, "final", [], kids);
        return false;
      }
      if (step.deadEnd && !step.start.length) {
        this.stuck(slug, planner, plan, step.deadEnd);
        return false;
      }
    }
    if (!sameJson(plan, planner.plan)) this.patch(slug, planner.id, { plan });
    return step.start.length > 0;
  }

  /** The questions form in the ticket's chat still waiting for the user's answers (empty when none). */
  private openForm(t: Ticket): Question[] {
    return (t.sessionId ? this.sessionSummary(t.sessionId)?.openForm : undefined) ?? [];
  }

  /** Resume the planner's session with what happened; several events arrive as one message. */
  private wake(slug: string, planner: Ticket, plan: Plan, kind: PlanWake, events: string[], kids: Ticket[]) {
    const managed = managedPlan(planner);
    // Read before autoFresh: a fresh chat no longer has the form, but Claude still asks it again from this list.
    const open = this.openForm(planner);
    const text = managed
      ? mainWakePrompt(planner, { kind, events, table: wakeTable(kids, this.store.listTickets(slug), (id) => this.isRunning(slug, id)), board: slug, group: !planner.main, open })
      : orchestratorPrompt(planner, { kind, events, table: planTable(kids), board: slug, outputDir: this.store.outputsDir(slug, planner.id), repo: this.repoState(slug) ?? this.guessRepo(slug), open });
    const progress = managed ? progressStep(plan, familySig(kids)) : null;
    this.patch(slug, planner.id, { plan: { ...plan, inbox: [], awaiting: kind, wakeups: plan.wakeups + 1, ...(progress ? { progressSig: progress.progressSig, noProgress: progress.noProgress } : {}) } });
    this.autoFresh(slug, this.store.getTicket(slug, planner.id) ?? planner);
    if (planner.main) {
      // Its card stays where it is (a wake isn't new work to review); no slot, no folder lock (it edits nothing).
      this.start(slug, planner.id, { text, mode: "act", raw: true });
      return;
    }
    // Back to where it was (In progress only if a restart cut a wake-up off).
    const returnTo = planner.status === "in_progress" ? "review" : planner.status;
    this.start(slug, planner.id, { text, mode: "act", raw: true, returnTo });
  }

  private closePlan(slug: string, planner: Ticket, plan: Plan, comment: string): Ticket {
    const out = this.patch(slug, planner.id, { plan: { ...plan, state: "done", awaiting: null, reason: null, inbox: [], finishedAt: nowIso() } });
    this.store.addComment(slug, planner.id, "ai", comment);
    return out;
  }

  private stuck(slug: string, planner: Ticket, plan: Plan, reason: string) {
    this.patch(slug, planner.id, { plan: { ...plan, state: "stuck", awaiting: null, reason } });
    // The stuck planner now needs the user (attention.ts): the Notifier tells them.
    this.store.addComment(slug, planner.id, "ai", `Plan stuck: ${reason}. Fix what's needed, then press Resume plan.`);
  }

  private async cleanupWorktree(slug: string, t: Ticket): Promise<Ticket> {
    const profile = this.store.getProfile(slug);
    if (!profile || !t.worktree) return t;
    const r = await this.removeTicketWorktree(profile, t.worktree);
    if (r.removed) return this.patch(slug, t.id, { worktree: null });
    this.store.addComment(slug, t.id, "ai", `Worktree kept at ${t.worktree}: ${r.reason}`);
    return t;
  }

  /**
   * Removes worktrees left behind by Done or deleted tickets (run once at startup; never throws).
   * Only the board's own worktree folder is looked at; ones with uncommitted changes are kept and logged.
   */
  async sweepWorktrees(): Promise<void> {
    for (const profile of this.store.listProfiles()) {
      try {
        if (!(await isGitRepo(profile.path))) continue;
        const root = dirname(worktreeDir(profile, "x"));
        if (!existsSync(root)) continue;
        const realRoot = realpathSync(root);
        let swept = 0;
        const kept: string[] = [];
        for (const dir of await listWorktrees(profile.path)) {
          if (dirname(dir) !== realRoot && dirname(dir) !== root) continue;
          const id = basename(dir);
          const t = this.store.getTicket(profile.slug, id);
          const key = this.key(profile.slug, id);
          const busy = this.isRunning(profile.slug, id) || this.setups.has(key) || this.sessionLocks.has(key);
          if (t && (t.status !== "done" || busy)) continue;
          const r = await this.removeTicketWorktree(profile, dir);
          if (!r.removed) {
            kept.push(`${id} (${r.reason})`);
            continue;
          }
          swept++;
          if (t?.worktree) this.patch(profile.slug, id, { worktree: null });
        }
        if (swept || kept.length) {
          console.log(`profile ${profile.slug}: swept ${swept} orphan worktree${swept === 1 ? "" : "s"}, kept ${kept.length} with changes${kept.length ? `: ${kept.join(", ")}` : ""}`);
        }
      } catch (e) {
        console.error(`profile ${profile.slug}: worktree sweep failed: ${(e as Error).message}`);
      }
    }
  }

  /** Prompt context of a schedule's ticket: which schedule, and for a quiet one what it raised that is still open. */
  private scheduleContext(slug: string, t: Ticket): PromptContext["schedule"] {
    const s = this.store.getSchedule(slug, t.scheduleId!);
    if (!s) return { id: t.scheduleId!, name: null, board: slug };
    return {
      id: s.id, name: s.name, board: slug,
      ...(s.quiet ? { quiet: quietContext(this.store.listTickets(slug), this.store.readScheduleHistory(slug, s.id), s.id, t.id) } : {}),
    };
  }

  /**
   * Remove a quiet schedule's ticket whose run found nothing for the user, and note it in the schedule's history (with
   * its cost, which also counts in today's spend). Not when something came up meanwhile (a message, a new run, a move).
   */
  private async endQuietly(slug: string, id: string, end: { summary: string; costUsd: number }): Promise<boolean> {
    const t = this.store.getTicket(slug, id);
    if (!t?.scheduleId || t.status !== "done" || this.isRunning(slug, id) || this.waiting(slug, id).length) return false;
    try {
      const scheduleId = t.scheduleId;
      await this.deleteTicket(slug, id);
      addHuddleSpend(this.store.root, slug, end.costUsd);
      const s = this.store.getSchedule(slug, scheduleId);
      if (s) {
        this.store.appendScheduleHistory(slug, scheduleId, { at: nowIso(), kind: "quiet", ticketId: id, summary: end.summary.slice(0, 500), costUsd: Math.round(end.costUsd * 10000) / 10000 });
        this.bus.emit({ type: "schedule.updated", profile: slug, id: scheduleId, schedule: s });
      }
      return true;
    } catch (e) {
      console.error(`ticket ${slug}/${id}: could not remove the quiet schedule run`, e);
      return false;
    }
  }

  /**
   * Delete a ticket. A main ticket takes its tool tickets with it (their runs stop and their copies go, as for any
   * deleted ticket); the rest of its family stays, unlinked. Refused while a merge into its copy runs.
   */
  async deleteTicket(slug: string, id: string): Promise<void> {
    const t0 = this.store.getTicket(slug, id);
    if (t0?.main) {
      if (this.merging(slug, id)) throw new Error("Wait a moment: a merge is running");
      // Deepest first, so a group never outlives its children.
      for (const o of this.toolTickets(slug, id).reverse()) {
        if (this.store.getTicket(slug, o.id)) await this.deleteOne(slug, o.id);
      }
    } else if (t0?.tool) {
      const main = this.mainOf(slug, t0);
      if (main && this.merging(slug, main.id)) throw new Error("Wait a moment: a merge is running");
    }
    await this.deleteOne(slug, id);
  }

  private async deleteOne(slug: string, id: string): Promise<void> {
    const active = this.runs.get(this.key(slug, id));
    if (active) {
      this.stopRun(active);
      await active.promise;
    }
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (t?.worktree && profile) await this.removeTicketWorktree(profile, t.worktree).catch(() => {});
    if (t) await this.dropRewindCopies(slug, t);
    if (t) deleteAttachments(this.store.attachmentsDir, this.attachmentsOf(slug, t));
    this.store.deleteTicket(slug, id);
    this.bus.emit({ type: "ticket.deleted", profile: slug, id });
    // Its family stays, unlinked from it; a suggestion to link under it goes too.
    for (const o of this.store.listTickets(slug)) {
      if (o.partOf === id) this.patch(slug, o.id, { partOf: null, partOfVia: null });
      if (o.parentSuggestion?.id === id) this.patch(slug, o.id, { parentSuggestion: null });
    }
  }

  /**
   * Move a Backlog ticket to another board: a fresh Backlog ticket there with the same title, description and tags
   * (chat, comments and runs stay behind), then the original goes. Refused while it is linked to other tickets.
   */
  async moveTicket(slug: string, id: string, target: string): Promise<Ticket> {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (!this.store.getProfile(target)) throw new Error(`board ${target} not found`);
    if (target === slug) throw new Error("The ticket is already on that board.");
    if (t.status !== "backlog") throw new Error("Only tickets in Backlog can move to another board.");
    if (this.runs.has(this.key(slug, id))) throw new Error("Claude is working on this ticket. Stop it first.");
    if (t.worktree || t.branch) throw new Error("This ticket has work in a copy of the folder. Delete the ticket or finish it instead of moving it.");
    const linked = t.parentId || t.dependsOn?.length || t.branchedFrom || t.addOnOf || t.plan
      || this.store.listTickets(slug).some((o) => o.id !== id && (o.parentId === id || o.branchedFrom === id || o.addOnOf === id
        || o.dependsOn?.some((d) => d === id || (!!t.planKey && d === t.planKey))));
    if (linked) throw new Error("Can't move: this ticket is linked to other tickets. Remove the links first.");
    // Create first, delete second: a failure in between leaves the original in place.
    const copy = await this.createTicket(target, { title: t.title, body: t.body, status: "backlog", tags: t.tags, important: t.important });
    try {
      this.store.deleteTicket(slug, id);
    } catch (e) {
      this.store.deleteTicket(target, copy.id);
      this.bus.emit({ type: "ticket.deleted", profile: target, id: copy.id });
      throw e;
    }
    this.bus.emit({ type: "ticket.deleted", profile: slug, id });
    return copy;
  }

  /** Images pasted into the ticket: its description, comments and chat (the Claude session transcript). */
  private attachmentsOf(slug: string, t: Ticket): string[] {
    const texts = [t.body, ...this.store.listComments(slug, t.id).map((c) => c.text), ...(t.queued ?? []).map((m) => m.text)];
    const file = t.sessionId ? claudeSessionFile(t.sessionId) : null;
    if (file) {
      try {
        texts.push(readFileSync(file, "utf8"));
      } catch {}
    }
    return referencedAttachments(...texts);
  }

  /** Attach a Claude session the user already started in the profile folder (null unlinks). */
  async linkSession(slug: string, id: string, sessionId: string | null): Promise<Ticket> {
    const profile = this.store.getProfile(slug);
    const t = this.store.getTicket(slug, id);
    if (!profile || !t) throw new Error("ticket not found");
    if (this.isRunning(slug, id)) throw new Error("ticket is running; stop it before linking a session");
    if (sessionId !== null && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("invalid session id");
    if (t.worktree && sessionId !== null) {
      const r = await this.removeTicketWorktree(profile, t.worktree);
      if (!r.removed) throw new Error(`ticket already has a worktree with changes (${t.worktree}); cannot switch session`);
    }
    return this.patch(slug, id, sessionId === null
      ? { sessionId: null, workdir: null }
      // Linked work already exists and the next step is the user's: land in Review ("Your turn").
      : { sessionId, workdir: profile.path, worktree: null, runCount: 0, lastRunAt: new Date().toISOString(), status: "review" });
  }

  /**
   * Branch a ticket, like Claude Code's --fork-session: a new "Branch: <title>" ticket in Planning with a copy of
   * the conversation (new session id) and its own git branch off the source's branch. The source is untouched.
   * warning: something the user should know (uncommitted changes weren't copied, the source branch was gone).
   */
  async branchTicket(slug: string, id: string): Promise<{ ticket: Ticket; warning: string | null }> {
    const profile = this.store.getProfile(slug);
    const src = this.store.getTicket(slug, id);
    if (!profile || !src) throw new Error(`ticket ${id} not found`);
    if (src.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    if (this.isRunning(slug, id)) throw new ConflictError("Claude is working on this ticket; branch it once Claude is done");
    const srcFile = src.sessionId ? claudeSessionFile(src.sessionId) : null;
    if (!src.sessionId || !srcFile) throw new Error("this ticket has no Claude conversation to branch yet");
    if (src.workdir && !existsSync(src.workdir)) throw new Error(`linked session folder no longer exists: ${src.workdir}`);

    const title = `Branch: ${src.title}`;
    const t = this.store.createTicket(slug, { title, body: src.body, status: "planning", mode: src.mode });
    const warnings: string[] = [];
    let worktree: string | null = null;
    try {
      const patch: Partial<Ticket> = {
        sessionId: crypto.randomUUID(), sessionStarted: true, refineStarted: true, interviewed: src.interviewed,
        branchedFrom: src.id, branchPoint: { at: nowIso(), sourceTitle: src.title },
      };
      // Same folder setup as the source: its linked folder, its own worktree branch, or the project folder.
      if (src.workdir) patch.workdir = src.workdir;
      else if (src.branch && (await isGitRepo(profile.path))) {
        const dir = worktreeDir(profile, t.id);
        const branch = `ck/${t.id}-${slugify(title)}`;
        const hasBranch = (await runCmd(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${src.branch}`], profile.path)).code === 0;
        let base: string | null = src.branch;
        if (!hasBranch) {
          base = await resolveBaseBranch(profile.path, profile.baseBranch);
          if (base === null) throw new Error(`branch ${src.branch} no longer exists and the repo has nothing to branch from`);
          warnings.push(`The source branch ${src.branch} no longer exists, so the branch starts from ${base}.`);
        } else if (src.worktree && existsSync(src.worktree)) {
          const st = await runCmd(["git", "status", "--porcelain"], src.worktree);
          if (st.code === 0 && st.stdout.trim()) warnings.push("Uncommitted changes in the source were not copied.");
        }
        await addWorktree(profile.path, dir, branch, base);
        worktree = dir;
        this.copyWorktreeFiles(slug, t.id, profile, dir);
        Object.assign(patch, { worktree: dir, branch, setupPending: true });
      } else {
        // The source works in the project folder itself: so does the branch, with the same Changes base.
        if (src.baseSha) patch.baseSha = src.baseSha;
        warnings.push((await isGitRepo(profile.path))
          ? "The original works in the project folder, so the branch edits the same files; they run one at a time."
          : "This folder has no version history, so the branch edits the same files as the original; they run one at a time.");
      }
      const fromCwd = src.workdir ?? src.worktree ?? (src.branch ? worktreeDir(profile, src.id) : profile.path);
      const toCwd = patch.workdir ?? worktree ?? profile.path;
      // The branch gets its own copies of pasted images, so deleting either ticket can't break the other.
      const rename = copyAttachments(this.store.attachmentsDir, referencedAttachments(src.body, readFileSync(srcFile, "utf8")));
      for (const [from, to] of Object.entries(rename)) patch.body = (patch.body ?? src.body).split(from).join(to);
      forkSessionFile(srcFile, { fromId: src.sessionId, toId: patch.sessionId!, fromCwd, toCwd, rename });
      this.store.copyOutputs(slug, src.id, t.id);
      const out = this.patch(slug, t.id, patch);
      return { ticket: out, warning: warnings.join(" ") || null };
    } catch (e) {
      if (worktree) await removeWorktree(profile.path, worktree).catch(() => {});
      this.store.deleteTicket(slug, t.id);
      throw e;
    }
  }

  /**
   * A new requirement on a ticket that already ran becomes its own ticket, linked to the original (addOnOf), so the
   * original keeps its title and description. start: straight to Ready, else Backlog. An add-on to a ticket still in
   * Review builds on its work (startFrom; in the project folder it is there anyway). The original goes back to
   * Review/Done when a chat or the user had moved it to Planning/Backlog for this.
   */
  async addOnTicket(slug: string, id: string, input: { title: string; body: string; start?: boolean; important?: boolean }): Promise<Ticket> {
    const src = this.store.getTicket(slug, id);
    if (!src) throw new Error(`ticket ${id} not found`);
    const title = input.title.trim();
    if (!title) throw new Error("title is required");
    // Clicked again (another tab, a slow reply): the add-on this card already made, even renamed or started since.
    const made = addOnFor(this.store.listTickets(slug), src.id, title);
    if (made) return made;
    const shaping = src.status === "planning" || src.status === "backlog";
    const was = shaping && src.reopenedFrom ? src.reopenedFrom : src;
    const t = await this.createTicket(slug, {
      title, body: input.body, status: "backlog", mode: "auto", proposedAs: title,
      ...(src.tags?.length ? { tags: src.tags } : {}), ...(src.important || input.important ? { important: true } : {}),
    });
    const patch: Partial<Ticket> = { addOnOf: src.id };
    // An add-on of a level-2 ticket would sit at level 3: it shows beside it instead (still building on its work).
    const all = this.store.listTickets(slug);
    const srcParent = parentLink(src)?.id;
    if (srcParent && levelOf(all, src.id) + 1 > MAX_LEVEL) patch.partOf = srcParent;
    if (was.status === "review" && src.branch && !src.workdir) patch.startFrom = src.branch;
    this.patch(slug, t.id, patch);
    if (shaping && src.reopenedFrom && !this.isRunning(slug, id)) {
      // Like a move by hand (Done cleans up its worktree); then its old outcome badge comes back too.
      await this.updateTicket(slug, id, { status: src.reopenedFrom.status });
      this.patch(slug, id, { outcome: src.reopenedFrom.outcome });
    }
    return input.start ? this.updateTicket(slug, t.id, { status: "ready" }) : this.store.getTicket(slug, t.id)!;
  }

  // ---- Families: "part of" links (see web/src/family.ts) ----

  /**
   * Makes id part of parent's family (null unlinks). via "chat": the parent's chat created it. A missing parent or a
   * loop (a ticket under its own descendant) is refused. Any parent suggestion is settled by it.
   * Moving it somewhere else also undoes the link that put it where it was: a plan ticket leaves its plan (refused
   * while siblings depend on it), an add-on stops being one (and stops building on that ticket's work if it hasn't
   * started), so the family shows where the user put it.
   */
  async setPartOf(slug: string, id: string, parent: string | null, via: "chat" | null = null): Promise<Ticket> {
    let t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (parent !== null) {
      if (!this.store.getTicket(slug, parent)) throw new Error(`ticket ${parent} not found`);
      const without = this.store.listTickets(slug).map((o) => (o.id === id ? { ...o, parentId: null, addOnOf: null } : o));
      if (wouldLoop(without, id, parent)) {
        throw new Error(parent === id ? "a ticket can't be part of itself" : `${parent} is already part of ${id}'s family below it; linking would make a loop`);
      }
      if (levelOf(without, parent) + 1 > MAX_LEVEL) throw new Error(tooDeepMessage(without, parent));
    }
    if (t.parentId && t.parentId !== parent) t = await this.updateTicket(slug, id, { parentId: null });
    const patch: Partial<Ticket> = { partOf: parent, partOfVia: parent ? via : null, parentSuggestion: null, parentChecked: true };
    // Linked under another ticket, it is no longer a main ticket of its own: it becomes a normal ticket there.
    if (parent && t.main) patch.main = false;
    if (t.addOnOf && t.addOnOf !== parent) Object.assign(patch, { addOnOf: null }, t.startFrom && !t.worktree ? { startFrom: null } : {});
    // Still in the same plan or an add-on of the same ticket: that link already says it.
    if (parent && (t.parentId === parent || t.addOnOf === parent)) Object.assign(patch, { partOf: null, partOfVia: null });
    return this.patch(slug, id, patch);
  }

  /** Not related: the suggestion goes and the board doesn't suggest a parent for this ticket again. */
  dismissParentSuggestion(slug: string, id: string): Ticket {
    if (!this.store.getTicket(slug, id)) throw new Error(`ticket ${id} not found`);
    return this.patch(slug, id, { parentSuggestion: null, parentChecked: true });
  }

  /** The board's parent suggestion (linker.ts), unless the ticket got a parent or was settled meanwhile. */
  suggestParent(slug: string, id: string, suggestion: { id: string; reason: string } | null): Ticket | null {
    const t = this.store.getTicket(slug, id);
    if (!t || t.parentChecked || t.partOf || t.addOnOf || t.parentId) return null;
    if (suggestion && !this.store.getTicket(slug, suggestion.id)) suggestion = null;
    return this.patch(slug, id, { parentSuggestion: suggestion, parentChecked: true });
  }

  // ---- Main tickets and tool tickets (main-ticket.ts) ----

  /** What the family spent so far (the daemon's spend index; none until it registers). */
  private costOf: (slug: string, id: string) => number = () => 0;
  /** ask_ticket runs in flight (forked sessions, no run slot), stopped on shutdown. */
  private asks = new Set<RunHandle>();
  /** merge_into_main runs one at a time per main ticket. */
  private mergeLocks = new Map<string, Promise<unknown>>();

  onCost(f: (slug: string, id: string) => number): void {
    this.costOf = f;
  }

  private newPlan(children: number): Plan {
    return { state: "running", maxConcurrent: DEFAULT_MAX_CONCURRENT, wakeups: 0, startedAt: nowIso(), originalCount: children, inbox: [], seen: {}, retries: {}, awaiting: null };
  }

  /**
   * A main ticket (or tool group) gets a running plan once it has tool tickets or events: the engine then runs its
   * family in any column. A finished plan starts again and keeps what it already reported (seen).
   */
  ensurePlan(slug: string, id: string): Ticket | null {
    const t = this.store.getTicket(slug, id);
    if (!t) return null;
    if (t.plan && t.plan.state !== "done") return t;
    const kids = childrenOf(this.store.listTickets(slug), id);
    const plan: Plan = t.plan
      ? { ...t.plan, state: "running", awaiting: null, reason: null, finishedAt: null, originalCount: Math.max(t.plan.originalCount, kids.length) }
      : this.newPlan(kids.length);
    return this.patch(slug, id, { plan });
  }

  /** Queue an event for a manager ticket's next wake (saved with it) and move its plan on. */
  pushEvent(slug: string, plannerId: string, line: string): void {
    if (!this.ensurePlan(slug, plannerId)) return;
    const t = this.store.getTicket(slug, plannerId)!;
    this.patch(slug, plannerId, { plan: { ...t.plan!, inbox: [...(t.plan!.inbox ?? []), line] } });
    this.advancePlans(slug);
  }

  /** The main ticket a ticket belongs to: up its links to the first main ticket, or null. */
  mainOf(slug: string, t: Ticket): Ticket | null {
    const all = this.store.listTickets(slug);
    const seen = new Set<string>();
    for (let cur: Ticket | undefined = t; cur && !seen.has(cur.id); cur = all.find((o) => o.id === parentLink(cur!)?.id)) {
      seen.add(cur.id);
      if (cur.main) return cur;
    }
    return null;
  }

  /** The ticket's last result in words (its newest summary comment). */
  lastSummary(slug: string, id: string): string {
    return this.store.aiComments(slug, id).findLast((c) => !BOARD_NOTE_RE.test(c.text))?.text ?? "";
  }

  /** A ticket's outputs/report.md, if it wrote one. */
  reportOf(slug: string, id: string): string | null {
    const file = join(this.store.outputsPath(slug, id), REPORT_FILE);
    return existsSync(file) ? file : null;
  }

  /**
   * Files a tool ticket changed in the project folder itself (a folder without version history): files modified while
   * its last run went (tool tickets there run one at a time), or at least the ones its edit tool calls named.
   */
  private folderFiles(slug: string, id: string): number {
    const t = this.store.getTicket(slug, id);
    const root = this.store.getProfile(slug)?.path;
    const files = new Set<string>();
    const from = t?.lastRunAt ? Date.parse(t.lastRunAt) - 1000 : NaN;
    const to = (t?.runEndedAt ? Date.parse(t.runEndedAt) : Date.now()) + 2000;
    let seen = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || seen > 20_000) return;
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name === ".git" || d.name === "node_modules" || d.name.startsWith(".ckanban")) continue;
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p, depth + 1);
        else if (d.isFile() && ++seen) {
          const m = statSync(p).mtimeMs;
          if (m >= from && m <= to) files.add(p);
        }
      }
    };
    if (root && Number.isFinite(from)) {
      try {
        walk(root, 0);
      } catch {}
    }
    for (const a of this.store.readActivity(slug, id) as any[]) {
      const c = a?.event?.type === "assistant" ? a.event.message?.content : null;
      if (!Array.isArray(c)) continue;
      for (const b of c) if (b?.type === "tool_use" && ["Edit", "Write", "NotebookEdit"].includes(b.name) && typeof b.input?.file_path === "string") files.add(b.input.file_path);
    }
    return files.size;
  }

  /** A tool ticket's result as a card for its parent's chat. */
  private resultCard(slug: string, id: string): ResultCard | null {
    const t = this.store.getTicket(slug, id);
    if (!t) return null;
    const summary = this.lastSummary(slug, id).trim();
    const plain = !t.worktree && !t.branch && !t.workdir && (this.repoState(slug) === "plain" || this.repoState(slug) === "empty");
    let cost: number | null = null;
    try {
      cost = Math.round(this.costOf(slug, id) * 100) / 100;
    } catch {}
    return {
      at: nowIso(), ticketId: t.id, title: t.title, kind: t.kind ?? null, outcome: t.outcome ?? "done", verdict: t.verdict ?? null,
      summary: summary.length > 600 ? `${summary.slice(0, 599)}…` : summary, report: this.reportOf(slug, id), model: t.model ?? null, costUsd: cost,
      ...(plain ? { folderFiles: this.folderFiles(slug, id) } : {}),
    };
  }

  /**
   * A ticket the user added to a main ticket's feature (not one of its tool tickets) finished a run: its result also
   * reaches the main ticket, as an event and a result card.
   */
  private reportToMain(slug: string, id: string, summary: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t || t.tool || t.main) return;
    const main = this.mainOf(slug, t);
    if (!main || main.id === id) return;
    const card = this.resultCard(slug, id);
    if (card) this.patch(slug, main.id, { results: [...(this.store.getTicket(slug, main.id)?.results ?? []), card].slice(-RESULTS_KEEP) });
    this.pushEvent(slug, main.id, finishedLine(t, summary, this.reportOf(slug, id)));
  }

  /**
   * A "with you" step ended waiting for the user: a grey board note in its main ticket's chat says so ("Staging check
   * needs you: <its first question>"). The note doesn't wake the main ticket: only the user answers the step.
   */
  private noteStepWaiting(slug: string, id: string, summary: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t || !youWaiting(t, false)) return;
    const main = this.mainOf(slug, t);
    if (!main || main.id === id) return;
    const ask = this.openForm(t)[0]?.question ?? summary;
    const first = ask.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
    const line = first.length > 160 ? `${first.slice(0, 159)}…` : first;
    const note: BoardNote = { at: nowIso(), ticketId: t.id, text: `${stepName(t)} needs you${line ? `: ${line}` : ""}` };
    this.patch(slug, main.id, { boardNotes: [...(this.store.getTicket(slug, main.id)?.boardNotes ?? []), note].slice(-BOARD_NOTES_KEEP) });
  }

  /** The user wrote in a tool ticket's chat: its parent hears the whole message before its next decision. */
  noteUserMessage(slug: string, id: string, text: string): void {
    const t = this.store.getTicket(slug, id);
    if (!t?.tool) return;
    const parent = t.parentId ?? this.mainOf(slug, t)?.id;
    if (!parent) return;
    this.pushEvent(slug, parent, `the user wrote in tool ticket ${t.id} "${t.title}": ${text}`);
  }

  /** What a main ticket's card shows of its family (main-ticket.ts familyCard). */
  familyCard(slug: string, id: string): FamilyCard | null {
    const all = this.store.listTickets(slug);
    const main = all.find((t) => t.id === id);
    if (!main?.main) return null;
    const family = familyOf(all, id).map((r) => r.ticket).filter((t) => t.id !== id);
    let cost = 0;
    for (const t of [main, ...family]) {
      try {
        cost += this.costOf(slug, t.id);
      } catch {}
    }
    return familyCard(main, family, all, (x) => this.isRunning(slug, x), Math.round(cost * 100) / 100);
  }

  /** How many of a main ticket's tool tickets are working now (its card shows In progress meanwhile). */
  familyWorking(slug: string, id: string, tickets = this.store.listTickets(slug)): number {
    let n = 0;
    for (const r of familyOf(tickets, id)) {
      if (!r.ticket.tool) continue;
      if (this.isRunning(slug, r.ticket.id) || r.ticket.status === "ready" || r.ticket.status === "in_progress") n++;
    }
    return n;
  }

  /** The main or tool rules a run of t gets, or undefined for other tickets. */
  private roleOf(slug: string, t: Ticket, session: Pick<Session, "repo" | "inPlace">): RunRole | undefined {
    if (t.main) {
      const now = this.store.getTicket(slug, t.id) ?? t;
      return { kind: "main", repo: session.repo, branch: session.inPlace ? null : now.branch ?? null, inPlace: session.inPlace, ...(now.plan?.state === "paused" ? { paused: true } : {}) } satisfies MainRole;
    }
    if (!t.tool) return undefined;
    const all = this.store.listTickets(slug);
    const main = this.mainOf(slug, t) ?? familyRoot(all, t.id) ?? t;
    const parent = (t.parentId ? all.find((o) => o.id === t.parentId) : null) ?? main;
    const saved = readStatus(this.store.outputsPath(slug, main.id));
    let statusPath: string | null = null;
    try {
      statusPath = this.refreshStatusFile(slug, main.id);
    } catch {}
    const siblings = childrenOf(all, parent.id);
    const deps = resolveDeps(t, siblings).deps.map((d) => ({ id: d.id, title: d.title, path: this.reportOf(slug, d.id) }));
    return {
      kind: "tool", repo: session.repo, parent: { id: parent.id, title: parent.title }, main: { id: main.id, title: main.title },
      goal: saved?.goal?.trim() || main.title, statusPath, depReports: deps,
      mainBranch: session.inPlace ? null : main.branch ?? null, outputDir: this.store.outputsDir(slug, t.id),
      ...(t.kind === "with_you" ? { withYou: true } : {}),
    } satisfies ToolRole;
  }

  /**
   * ask_ticket: a fork of the tool ticket's session at its latest saved point (its own session is untouched) answers
   * the question in at most 5 sentences with read-only tools. It needs no run slot and works while the ticket runs. The
   * answer reaches the asker as an event, or "no answer" after the timeout.
   */
  askTicket(slug: string, askerId: string, targetId: string, question: string): string {
    const asker = this.store.getTicket(slug, askerId);
    const target = this.store.getTicket(slug, targetId);
    const profile = this.store.getProfile(slug);
    if (!asker || !target || !profile) throw new Error(`ticket ${!target ? targetId : askerId} not found`);
    if (!question.trim()) throw new Error("the question is empty");
    const label = `${target.id} "${target.title}"`;
    const reply = (line: string) => this.pushEvent(slug, askerId, line);
    const src = target.sessionId ? claudeSessionFile(target.sessionId) : null;
    const dir = target.workdir ?? target.worktree ?? profile.path;
    if (!src || !existsSync(dir)) {
      queueMicrotask(() => reply(`no answer from ${label} to "${question}": it has no conversation yet.`));
      return `${target.id} has no conversation yet, so it can't answer; you'll get that as an event.`;
    }
    const forkId = crypto.randomUUID();
    const file = forkSessionFile(src, { fromId: target.sessionId!, toId: forkId, fromCwd: dir, toCwd: dir });
    const prompt = `${asker.title} (${asker.id}) asks you a question about your work on this ticket. This is a copy of your conversation: answer from what you did and know, in at most 5 sentences. You may read files, but don't change anything and don't start new work. Don't write a CKANBAN_RESULT line.\n\nQuestion: ${question.trim()}`;
    let timedOut = false;
    const handle = startRun({
      bin: this.opts.claudeBin, cwd: dir,
      args: buildArgs(forkId, true, target.model ?? profile.model, [...NO_EDIT_TOOLS.split(","), "Bash"], undefined, undefined, null, "low"),
      input: prompt, env: { CKANBAN_OUTPUT_DIR: this.store.outputsPath(slug, target.id) }, onEvent: () => {},
    });
    this.asks.add(handle);
    const timer = setTimeout(() => {
      timedOut = true;
      handle.stop();
    }, this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS);
    void handle.done.then((out) => {
      clearTimeout(timer);
      this.asks.delete(handle);
      try {
        rmSync(file, { force: true });
      } catch {}
      if (this.shuttingDown) return;
      const text = extractFinalText(out.events).replace(/^.*CKANBAN_RESULT:.*$/gm, "").trim();
      const minutes = Math.round((this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS) / 60_000);
      reply(timedOut || !text
        ? `no answer from ${label} to "${question}"${timedOut ? ` within ${minutes || "a few"} minute${minutes === 1 ? "" : "s"}` : ""}.`
        : `answer from ${label} to "${question}": ${sentences(text)}`);
    });
    return `Asked ${label}. Its answer (or "no answer" after ${Math.round((this.opts.askTimeoutMs ?? ASK_TIMEOUT_MS) / 60_000) || 1} minutes) comes back as an event when you are woken; end your run if you have nothing else to do.`;
  }

  /**
   * merge_into_main: fast-forwards the main ticket's copy to the tool ticket's branch, one at a time per main ticket.
   * Refused (and counted) when the main copy moved since the tool ticket merged it; after MERGE_TRIES the tool ticket
   * ends blocked and its parent hears about it.
   */
  mergeIntoMain(slug: string, toolId: string): Promise<string> {
    const tool = this.store.getTicket(slug, toolId);
    if (!tool) return Promise.reject(new Error(`ticket ${toolId} not found`));
    if (!tool.tool) return Promise.reject(new Error("only a tool ticket merges into its main ticket's copy"));
    const main = this.mainOf(slug, tool);
    if (!main) return Promise.reject(new Error("this ticket has no main ticket to merge into"));
    const key = this.key(slug, main.id);
    const next = (this.mergeLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.mergeNow(slug, toolId, main.id));
    this.mergeLocks.set(key, next);
    next.finally(() => {
      if (this.mergeLocks.get(key) === next) this.mergeLocks.delete(key);
    }).catch(() => {});
    return next;
  }

  private async mergeNow(slug: string, toolId: string, mainId: string): Promise<string> {
    const profile = this.store.getProfile(slug)!;
    const tool = this.store.getTicket(slug, toolId)!;
    const main = this.store.getTicket(slug, mainId)!;
    if (!tool.worktree || !tool.branch) return "Nothing to merge: you edit the project folder itself, so your changes are already where the main ticket sees them.";
    if (!main.branch) throw new Error("the main ticket has no copy of its own to merge into; end with your branch as it is and say so in your summary");
    const dirty = await runCmd(["git", "status", "--porcelain"], tool.worktree);
    if (dirty.code === 0 && dirty.stdout.trim()) throw new Error("you have changes that aren't committed yet: commit them, then call merge_into_main again");
    const ancestor = await runCmd(["git", "merge-base", "--is-ancestor", main.branch, tool.branch], profile.path);
    if (ancestor.code !== 0) {
      const fails = (tool.mergeFails ?? 0) + 1;
      this.patch(slug, toolId, { mergeFails: fails });
      if (fails >= MERGE_TRIES) {
        this.pushEvent(slug, tool.parentId ?? mainId, `merge failed: ${tool.id} "${tool.title}" couldn't merge into the main copy ${fails} times, so it ends blocked.`);
        throw new Error(`The main ticket's copy moved again (try ${fails} of ${MERGE_TRIES}). Stop here: end your run with status "blocked" and say what is left to merge; your parent decides what happens next.`);
      }
      throw new Error(`The main ticket's copy moved since you last merged it (try ${fails} of ${MERGE_TRIES}): merge again and retry. Run \`git merge ${main.branch}\`, sort out any clashes, re-run the checks, commit, then call merge_into_main again.`);
    }
    const sha = (await runCmd(["git", "rev-parse", tool.branch], profile.path)).stdout.trim();
    const count = Number((await runCmd(["git", "rev-list", "--count", `${main.branch}..${tool.branch}`], profile.path)).stdout.trim()) || 0;
    if (!count) {
      this.patch(slug, toolId, { merged: sha, mergeFails: 0 });
      return "Nothing new to merge: the main ticket's copy already has your work.";
    }
    const r = main.worktree && existsSync(main.worktree)
      ? await runCmd(["git", "merge", "--ff-only", tool.branch], main.worktree)
      : await runCmd(["git", "branch", "-f", main.branch, tool.branch], profile.path);
    if (r.code !== 0) throw new Error(`couldn't move the main ticket's copy forward: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
    this.patch(slug, toolId, { merged: sha, mergeFails: 0 });
    this.store.addComment(slug, mainId, "ai", `Merged ${count} commit${count === 1 ? "" : "s"} of ${tool.id} "${tool.title}" into this ticket's copy.`);
    this.emitTicket(slug, this.store.getTicket(slug, mainId)!);
    return `Merged ${count} commit${count === 1 ? "" : "s"} into the main ticket's copy (${main.branch}).`;
  }

  /**
   * land_milestone: lands the main ticket's copy as the board lands work (landRule): push and one pull request on a
   * repo with a remote (the open one is updated), a merge into the project folder without one. Plain folders only
   * record it (the work is already there). Refused with the reason when it can't land cleanly.
   */
  async landMilestone(slug: string, id: string, summary: string): Promise<string> {
    const t = this.store.getTicket(slug, id);
    const profile = this.store.getProfile(slug);
    if (!t || !profile) throw new Error(`ticket ${id} not found`);
    if (!t.main) throw new Error("only a main ticket lands milestones");
    const text = summary.trim().slice(0, 500);
    if (!text) throw new Error("say in one line what this milestone is (summary)");
    const record = (landed: string) => {
      const dir = this.store.outputsDir(slug, id);
      const saved = readStatus(dir);
      const next: SavedStatus = { ...(saved ?? {}), updatedAt: nowIso(), milestones: [...(saved?.milestones ?? []), { at: nowIso(), summary: text, landed }].slice(-20) };
      writeStatus(dir, this.store.getTicket(slug, id)!, next, statusFacts(this.store.listTickets(slug), id, (x) => this.waitsOnUser(slug, x.id), next.prNotes), true);
      this.patch(slug, id, { statusAt: nowIso() });
      this.store.addComment(slug, id, "ai", `Milestone landed: ${text} (${landed}).`);
    };
    const repo = await repoKind(profile.path);
    if (repo === "plain" || repo === "empty" || !t.branch || !t.worktree || !existsSync(t.worktree)) {
      record("already in the project folder");
      return "Recorded the milestone: the tool tickets already edited the project folder itself, so there is nothing else to land.";
    }
    const dirty = await runCmd(["git", "status", "--porcelain"], t.worktree);
    if (dirty.code === 0 && dirty.stdout.trim()) throw new Error("the main ticket's copy has uncommitted changes, so it can't land cleanly; start a fix tool ticket to commit or drop them");
    const base = profile.baseBranch || "main";
    if (repo === "remote") {
      const push = await runCmd(["git", "push", "-u", "origin", t.branch], t.worktree);
      if (push.code !== 0) throw new Error(`couldn't push the main ticket's copy: ${(push.stderr || push.stdout).trim().split("\n").slice(-3).join(" ")}. Start a fix tool ticket (for example to merge ${base} in and sort out clashes).`);
      const open = ticketPrs(t).find((p) => p.state !== "MERGED" && p.state !== "CLOSED");
      let url = open?.url ?? null;
      if (!url) {
        try {
          url = await (this.opts.openPr ?? openPrWithGh)(t.worktree, { branch: t.branch, base, title: t.title, body: text });
        } catch (e) {
          throw new Error(`pushed the copy, but couldn't open the pull request: ${(e as Error).message}`);
        }
        this.patch(slug, id, addPrs(this.store.getTicket(slug, id)!, [url]));
      }
      record(`${open ? "updated" : "opened"} ${url}`);
      return `Landed: pushed your copy and ${open ? "updated the open" : "opened a"} pull request: ${url}`;
    }
    // No remote: merge the copy into the project folder, like a ticket's own run would (see localLand in prompts.ts).
    const head = await runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], profile.path);
    if (head.stdout.trim() !== base) throw new Error(`the project folder is on "${head.stdout.trim()}", not ${base}, so the board won't merge into it; ask the user to switch it back`);
    const folderDirty = await runCmd(["git", "status", "--porcelain"], profile.path);
    if (folderDirty.stdout.trim()) throw new Error("the project folder has uncommitted changes, so the board won't merge into it; ask the user to save or discard them first");
    const m = await runCmd(["git", "merge", "--no-edit", t.branch], profile.path);
    if (m.code !== 0) {
      await runCmd(["git", "merge", "--abort"], profile.path);
      throw new Error(`merging into ${base} clashed (${(m.stdout || m.stderr).trim().split("\n").slice(-2).join(" ")}), so nothing was landed. Start a fix tool ticket to merge ${base} into your copy and sort out the clashes`);
    }
    const sha = (await runCmd(["git", "rev-parse", "--short", "HEAD"], profile.path)).stdout.trim();
    record(`merged into ${base} in the project folder at ${sha}`);
    return `Landed: merged your copy into ${base} in the project folder (${sha}).`;
  }

  // ---- Features: the pinned "Where we are" status, gathering tickets (feature.ts, web/src/family.ts) ----

  /** The family's top ticket for id, its saved status and the board's facts. */
  featureStatus(slug: string, id: string): { top: Ticket; feature: boolean; saved: SavedStatus | null; facts: StatusFacts; sections: ReturnType<typeof statusSections>; path: string } {
    const tickets = this.store.listTickets(slug);
    const top = familyRoot(tickets, id);
    if (!top) throw new Error(`ticket ${id} not found`);
    const dir = this.store.outputsDir(slug, top.id);
    const saved = readStatus(dir);
    const facts = statusFacts(tickets, top.id, (t) => this.waitsOnUser(slug, t.id), saved?.prNotes);
    return { top, feature: isFeature(tickets, top), saved, facts, sections: statusSections(saved, facts), path: statusFiles(dir).md };
  }

  /** Rewrites status.md from the saved status and the board's facts now (a feature or a ticket with a status only). */
  refreshStatusFile(slug: string, id: string): string | null {
    const f = this.featureStatus(slug, id);
    if (!f.saved && !f.feature) return null;
    writeStatus(this.store.outputsDir(slug, f.top.id), f.top, f.saved, f.facts, false);
    return f.path;
  }

  /** update_status: replaces only the sections the patch names, on the top ticket of id's family (making it a feature). */
  updateStatus(slug: string, id: string, patch: StatusPatch): ReturnType<Board["featureStatus"]> & { markdown: string } {
    const tickets = this.store.listTickets(slug);
    const top = familyRoot(tickets, id);
    if (!top) throw new Error(`ticket ${id} not found`);
    const dir = this.store.outputsDir(slug, top.id);
    const now = nowIso();
    const saved = applyPatch(readStatus(dir), patch, now, familySig(familyOf(tickets, top.id).slice(1).map((r) => r.ticket)));
    const facts = statusFacts(tickets, top.id, (t) => this.waitsOnUser(slug, t.id), saved.prNotes);
    const markdown = writeStatus(dir, top, saved, facts, true);
    this.patch(slug, top.id, { statusAt: now });
    return { ...this.featureStatus(slug, top.id), markdown };
  }

  /** "Add a note": saved in the status under its date; the main chat gets it at its next turn without a run starting. */
  addStatusNote(slug: string, id: string, text: string): ReturnType<Board["featureStatus"]> {
    const note = text.trim().slice(0, STATUS_NOTE_MAX);
    if (!note) throw new Error("the note is empty");
    const tickets = this.store.listTickets(slug);
    const top = familyRoot(tickets, id);
    if (!top) throw new Error(`ticket ${id} not found`);
    const dir = this.store.outputsDir(slug, top.id);
    const now = nowIso();
    const old = readStatus(dir);
    const saved: SavedStatus = { ...(old ?? {}), updatedAt: now, notes: [...(old?.notes ?? []), { at: now, text: note, delivered: false }] };
    writeStatus(dir, top, saved, statusFacts(tickets, top.id, (t) => this.waitsOnUser(slug, t.id), saved.prNotes), true);
    this.patch(slug, top.id, { statusAt: now });
    return this.featureStatus(slug, top.id);
  }

  /** The user's status notes the top ticket's Claude hasn't had yet, as a prompt block (marked delivered); null for none. */
  private takeStatusNotes(slug: string, id: string): string | null {
    const dir = this.store.outputsPath(slug, id);
    const saved = existsSync(dir) ? readStatus(dir) : null;
    const fresh = saved?.notes?.filter((n) => !n.delivered) ?? [];
    if (!saved || !fresh.length) return null;
    const t = this.store.getTicket(slug, id)!;
    const next = { ...saved, notes: saved.notes!.map((n) => ({ ...n, delivered: true })) };
    const f = statusFacts(this.store.listTickets(slug), id, (x) => this.waitsOnUser(slug, x.id), next.prNotes);
    writeStatus(dir, t, next, f, true);
    return statusNotesBlock(fresh);
  }

  /** What a run in a feature is told about the status: the main chat reads and keeps it; family runs may update it. */
  private featureNote(slug: string, t: Ticket): string | null {
    const tickets = this.store.listTickets(slug);
    const top = familyRoot(tickets, t.id);
    if (!top || !isFeature(tickets, top)) return null;
    const path = this.refreshStatusFile(slug, top.id);
    if (!path) return null;
    return top.id === t.id ? featureMainNote(path) : featureMemberNote(top, path);
  }

  /**
   * After a chat reply or plan wake of a feature's top ticket that didn't call update_status while the family changed
   * since the status was last updated: one short quiet turn asking Claude to update it. At most once per run.
   */
  private async nudgeStatus(run: ActiveRun, startedAt: string): Promise<boolean> {
    if (run.nudged || !run.statusEligible || run.stopRequested || this.shuttingDown || this.restartPending) return false;
    if (this.waiting(run.slug, run.id).length) return false;
    const tickets = this.store.listTickets(run.slug);
    const top = familyRoot(tickets, run.id);
    if (!top || top.id !== run.id || !isFeature(tickets, top)) return false;
    const saved = readStatus(this.store.outputsPath(run.slug, run.id));
    if (!saved || (saved.claudeAt && saved.claudeAt >= startedAt)) return false;
    const rows = familyOf(tickets, top.id).slice(1).map((r) => r.ticket);
    const sig = familySig(rows);
    if (saved.familySig === sig) return false;
    run.nudged = true;
    const path = this.refreshStatusFile(run.slug, run.id)!;
    // Same mode as the reply it follows: a Planning chat's nudge can't change files either.
    const mode = run.chat?.mode ?? "act";
    const t = this.store.getTicket(run.slug, run.id);
    run.chat = { text: statusNudgePrompt(path, sigChanges(saved.familySig ?? "", sig, rows), t ? this.openForm(t) : []), mode, raw: true, quiet: true, nudge: true };
    run.promptMsgId = undefined;
    run.inFlight = new Map();
    run.handle = null;
    run.retried = false;
    run.restartRequested = false;
    this.begin(run);
    await this.executeOnce(run);
    return true;
  }

  /**
   * Gather tickets into the feature: each picked one links under its group (an existing group of the feature, "new" for
   * a new group named newGroup, or none: under the feature itself). Chats, work and pull requests stay; running tickets
   * keep running. A ticket in another family moves (setPartOf rules). Its own tickets that would sit deeper than level 2
   * move up beside it (still in their plan, if any). by: who to credit, for a chat outside the feature ("by the chat of ...").
   */
  async gather(slug: string, featureId: string, items: { id: string; group?: string | null }[], newGroup?: string | null, by?: string | null): Promise<{
    gathered: Ticket[]; movedUp: { id: string; title: string; to: string }[]; skipped: { id: string; reason: string }[]; group: Ticket | null;
  }> {
    const top = familyRoot(this.store.listTickets(slug), featureId);
    if (!top) throw new Error(`ticket ${featureId} not found`);
    let group: Ticket | null = null;
    if (items.some((i) => i.group === "new")) {
      group = await this.createTicket(slug, { title: newGroup?.trim() || "New group", body: "", status: "backlog", mode: "auto", kind: "group", partOf: top.id });
    }
    const groups = new Set(groupsOf(this.store.listTickets(slug), top.id).map((g) => g.id));
    const gathered: Ticket[] = [];
    const skipped: { id: string; reason: string }[] = [];
    const movedUp: { id: string; title: string; to: string }[] = [];
    for (const item of items) {
      const target = item.group === "new" ? group!.id : item.group || top.id;
      const t = this.store.getTicket(slug, item.id);
      if (!t) {
        skipped.push({ id: item.id, reason: "not found" });
        continue;
      }
      if (t.id === top.id) {
        skipped.push({ id: t.id, reason: "that is the feature itself" });
        continue;
      }
      if (target !== top.id && !groups.has(target)) {
        skipped.push({ id: t.id, reason: `${target} is not a group of this feature` });
        continue;
      }
      // Its own tickets (all levels), to keep within the depth limit once it has moved.
      const own = new Set(subtreeIds(this.store.listTickets(slug), t.id));
      try {
        if (parentLink(t)?.id !== target) await this.setPartOf(slug, t.id, target);
        gathered.push(this.store.getTicket(slug, t.id)!);
        this.store.addComment(slug, t.id, "ai", `Gathered into the feature "${top.title}" (${top.id})${target !== top.id ? `, under "${this.store.getTicket(slug, target)?.title}"` : ""}${by ? ` ${by}` : ""}.`);
      } catch (e) {
        skipped.push({ id: t.id, reason: (e as Error).message });
        continue;
      }
      // Its own tickets deeper than level 2 move up beside it: linked to its ancestor at level 1.
      for (let guard = 0; guard < 500; guard++) {
        const rows = familyOf(this.store.listTickets(slug), top.id);
        const deep = rows.findIndex((r) => own.has(r.ticket.id) && r.depth > MAX_LEVEL);
        if (deep < 0) break;
        const anc = rows.slice(0, deep).findLast((r) => r.depth === 1)!;
        const d = rows[deep].ticket;
        this.patch(slug, d.id, { partOf: anc.ticket.id, partOfVia: null });
        movedUp.push({ id: d.id, title: d.title, to: anc.ticket.id });
        this.store.addComment(slug, d.id, "ai", `Moved up under "${anc.ticket.title}" so the feature "${top.title}" stays at most ${MAX_LEVEL} levels deep.`);
      }
    }
    if (gathered.length) this.store.addComment(slug, top.id, "ai", `Gathered ${gathered.length} ticket${gathered.length === 1 ? "" : "s"} into this feature${by ? ` ${by}` : ""}: ${gathered.map((t) => `"${t.title}"`).join(", ")}.`);
    this.emitTicket(slug, this.store.getTicket(slug, top.id)!);
    return { gathered, movedUp, skipped, group };
  }

  // ---- One-click recovery from a lost or busy session ----

  /** The first prompt of a fresh session: ticket, last result, recent comments, and where to look for the work so far. */
  private freshPrompt(slug: string, t: Ticket, session: Pick<Session, "repo" | "inPlace">, outputDir: string): string {
    const comments = this.store.listComments(slug, t.id);
    const last = comments.findLast((c) => c.author === "ai" && !BOARD_NOTE_RE.test(c.text));
    const recent = comments.filter((c) => !BOARD_NOTE_RE.test(c.text) && c !== last).slice(-10);
    const profile = this.store.getProfile(slug);
    return freshSessionPrompt(t, {
      repo: session.repo, inPlace: session.inPlace, home: profile ? { folder: profile.path, baseBranch: profile.baseBranch } : undefined, linked: !!t.workdir, baseBranch: profile?.baseBranch || "main",
      lastResult: last?.text ?? null, comments: recent, outputDir, autoHuddles: autoHuddlesOn(profile), artifacts: !!profile?.artifacts || mentionsArtifact(t.body, last?.text, ...recent.map((c) => c.text)),
      recall: this.recall(slug, t),
    });
  }

  private freshChatContext(slug: string, t: Ticket): string {
    const comments = this.store.listComments(slug, t.id);
    const last = comments.findLast((c) => c.author === "ai" && !BOARD_NOTE_RE.test(c.text));
    const recent = comments.filter((c) => !BOARD_NOTE_RE.test(c.text) && c !== last).slice(-10);
    if (!this.seedsFromStatus(slug, t)) return freshChatNote(t, last?.text ?? null, recent);
    // A main ticket or feature starts from its status and its collapsed family table; search_chat finds the rest.
    let status: string | null = null;
    try {
      const path = this.refreshStatusFile(slug, t.id);
      status = path && existsSync(path) ? readFileSync(path, "utf8") : null;
    } catch (e) {
      console.error(`status of ${slug}/${t.id}:`, e);
    }
    const all = this.store.listTickets(slug);
    const kids = all.filter((c) => c.parentId === t.id || c.partOf === t.id);
    const table = wakeTable(kids, all, (id) => this.isRunning(slug, id));
    return freshChatNote(t, last?.text ?? null, recent, { status, table, auto: !!t.freshAuto });
  }

  /** A main ticket, or the top ticket of a feature: its fresh chats start from the status (and may start by themselves). */
  private seedsFromStatus(slug: string, t: Ticket): boolean {
    if (t.main) return true;
    try {
      return isFeature(this.store.listTickets(slug), t);
    } catch {
      return false;
    }
  }

  /**
   * The next turn of a main ticket's or feature's chat that has gone cold and is large (over the board's freshChatTokens)
   * starts as a fresh chat seeded from the status, instead of re-reading the whole conversation. Returns the ticket as it
   * is now (unchanged when not).
   */
  private autoFresh(slug: string, t: Ticket): Ticket {
    if (t.freshSession || !t.sessionId || !this.seedsFromStatus(slug, t)) return t;
    const cache = this.sessionSummary(t.sessionId)?.cache;
    if (!cache || !chatIsCold(cache, (this.opts.now?.() ?? new Date()).getTime())) return t;
    const limit = this.store.getProfile(slug)?.freshChatTokens || FRESH_CHAT_TOKENS;
    if ((cache.coldTokens ?? cache.tokens) <= limit) return t;
    return this.startFreshChat(slug, t.id, true);
  }

  /**
   * "What we did before on this board": related past tickets for t's first prompt (see recall.ts), the rules the board
   * learned from the user's corrections (learn.ts), and the project's saved lessons a run in a worktree can't see yet
   * (lessons.ts); "" for none.
   */
  private recall(slug: string, t: Ticket): string {
    const rows = this.store.listTickets(slug).map((o) => ({
      ticket: o,
      summary: this.store.aiComments(slug, o.id).findLast((c) => !BOARD_NOTE_RE.test(c.text))?.text ?? null,
    }));
    const profile = this.store.getProfile(slug);
    const now = this.store.getTicket(slug, t.id) ?? t;
    const lessons = profile ? lessonsBlock(profile.path, now.worktree ?? now.workdir ?? null) : "";
    return [recallBlock(t, rows), learnedRulesBlock(this.store, slug), lessons].filter(Boolean).join("\n\n");
  }

  /** Queues the ticket's work run: it starts now if a slot is free (dispatch), otherwise when one frees up. */
  private requeue(slug: string, id: string): Ticket {
    this.patch(slug, id, { status: "ready", outcome: null, error: null });
    this.dispatch(slug);
    return this.store.getTicket(slug, id)!;
  }

  private recoverable(slug: string, id: string): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new Error(`ticket ${id} not found`);
    if (t.error?.startsWith("corrupt")) throw new Error("ticket file is corrupt");
    if (this.isRunning(slug, id)) throw new ConflictError("Claude is already working on this ticket");
    return t;
  }

  /**
   * Start fresh session: drops the ticket's Claude session (its conversation can't be resumed) but keeps the
   * worktree and branch, then queues a work run whose prompt tells Claude to continue from the branch's state.
   */
  startFresh(slug: string, id: string): Ticket {
    this.recoverable(slug, id);
    this.patch(slug, id, { sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true });
    this.store.addComment(slug, id, "ai", "Started a fresh session: the previous conversation is gone, so Claude continues from the ticket, its last result and the branch as it is now.");
    return this.requeue(slug, id);
  }

  /**
   * "Send in a fresh chat" (an old chat would be re-read in full): the next message starts a new session that gets the
   * ticket, its last result and recent comments instead of the old conversation. Unlike startFresh, nothing is queued
   * and the card stays where it is; the old session is kept so the ticket chat still shows it.
   */
  private startFreshChat(slug: string, id: string, auto = false): Ticket {
    const t = this.store.getTicket(slug, id)!;
    const earlier = t.sessionId && (t.sessionStarted || this.sessionExists(t.sessionId))
      ? [...(t.earlierSessions ?? []), { sessionId: t.sessionId, endedAt: nowIso() }]
      : t.earlierSessions;
    this.store.addComment(slug, id, "ai", auto
      ? AUTO_FRESH_NOTE
      : this.seedsFromStatus(slug, t)
      ? "Started a fresh chat: Claude starts from the status and can look up earlier messages."
      : "Started a fresh chat: Claude no longer sees the earlier messages; it gets the ticket, its last result and recent comments instead.");
    return this.patch(slug, id, {
      sessionId: crypto.randomUUID(), sessionStarted: false, freshSession: true, freshAuto: auto || null, ...(earlier ? { earlierSessions: earlier } : {}),
    });
  }

  /**
   * Take over here: the ticket's session is open in a terminal. If that's the board's own (dock) terminal, it is
   * closed and the run resumes here; one in an external terminal can't be closed (external: the UI offers
   * Start fresh session instead).
   */
  async takeOver(slug: string, id: string): Promise<{ ticket: Ticket; external: boolean }> {
    const t = this.recoverable(slug, id);
    if (t.sessionId) {
      const owned = await this.opts.findOwnedSession?.(t.sessionId) ?? null;
      if (owned) {
        if (!(await owned.close())) throw new Error("Couldn't close the session in the board's terminal. Exit it there (Ctrl+D or /exit), then try again.");
        this.store.addComment(slug, id, "ai", "Took over the session: closed it in the board's terminal and resumed the run here.");
        return { ticket: this.requeue(slug, id), external: false };
      }
      const title = t.workdir ? sessionTitle(t.workdir, t.sessionId) : null;
      if (await this.isSessionLive(t.sessionId, title)) return { ticket: t, external: true };
    }
    this.store.addComment(slug, id, "ai", "Took over the session: it was no longer open in a terminal, so the run resumed here.");
    return { ticket: this.requeue(slug, id), external: false };
  }

  /** A comment: the user's (or a planner's), or with from, a note another ticket's run left (shown as Claude's). */
  addComment(slug: string, id: string, text: string, from?: string) {
    const c = this.store.addComment(slug, id, from ? "ai" : "user", text, from);
    this.emitTicket(slug, this.store.getTicket(slug, id)!);
    return c;
  }

  private stopRun(run: ActiveRun) {
    // Show the stop at once: setup (worktree, session checks) or SIGTERM can take a while to finish.
    if (!run.stopRequested && this.store.getTicket(run.slug, run.id)) this.patch(run.slug, run.id, { lastActivity: "Stopping…" });
    run.stopRequested = true;
    run.handle?.stop();
    this.setups.get(this.key(run.slug, run.id))?.abort.abort();
  }

  /** A main ticket's tool tickets (hidden and with you), from familyOf. */
  toolTickets(slug: string, mainId: string, tickets = this.store.listTickets(slug)): Ticket[] {
    return familyOf(tickets, mainId).map((r) => r.ticket).filter((t) => t.id !== mainId && t.tool);
  }

  /** Stop a main ticket and its running tool tickets (other family members are left alone). How many tool tickets stopped. */
  stopFamily(slug: string, id: string): { stopped: boolean; tools: number } {
    const stopped = this.stop(slug, id);
    let tools = 0;
    const t = this.store.getTicket(slug, id);
    if (t?.main) {
      let queued = 0;
      for (const o of this.toolTickets(slug, id)) {
        if (this.isRunning(slug, o.id) || o.status === "in_progress") {
          if (this.stop(slug, o.id)) tools++;
        } else if (o.status === "ready") {
          // Queued to start: back to waiting (Backlog), so nothing new starts behind the user's Stop.
          this.patch(slug, o.id, { status: "backlog" });
          queued++;
        }
      }
      // Nothing new starts behind the user's Stop: the plan pauses until the user acts on the ticket again (moves it to
      // ready, writes or answers in its chat: resumeStoppedPlan). A Stop that only cut off the main ticket's own reply
      // held no step back, so it doesn't pause at all.
      const now = this.store.getTicket(slug, id);
      if ((tools > 0 || queued > 0) && now?.plan && (now.plan.state === "running" || now.plan.state === "finishing")) {
        this.patch(slug, id, { plan: { ...now.plan, state: "paused", awaiting: null } });
        this.store.addComment(slug, id, "ai", `Stopped by you with ${tools} running tool ticket${tools === 1 ? "" : "s"}; new steps wait until you move this ticket to ready, write in its chat or press Resume.`);
      }
    }
    return { stopped: stopped || tools > 0, tools };
  }

  /** A merge_into_main into this main ticket's copy is running. */
  merging(slug: string, mainId: string): boolean {
    return this.mergeLocks.has(this.key(slug, mainId));
  }

  stop(slug: string, id: string): boolean {
    const r = this.runs.get(this.key(slug, id));
    if (r) {
      this.stopRun(r);
      return true;
    }
    const t = this.store.getTicket(slug, id);
    if (t?.slotWait) {
      this.cancelSlotWait(slug, id);
      return true;
    }
    // In Progress with no run behind it (e.g. the daemon lost it, or it waits for its auto huddle): clear the card.
    if (t?.status !== "in_progress") return false;
    this.store.addComment(slug, id, "ai", t.autoHuddle ? "Stopped by user while waiting for its auto huddle." : "Run stopped by user.");
    this.patch(slug, id, { status: "review", outcome: "stopped", error: null, lastActivity: null, ...(t.autoHuddle ? { autoHuddle: null } : {}) });
    return true;
  }

  stopAll(): void {
    for (const r of this.runs.values()) this.stopRun(r);
  }

  /** Kill all runs without recording an outcome; tickets stay in_progress for recover(). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const r of this.runs.values()) this.markInterrupted(r);
    for (const r of this.runs.values()) {
      r.stopRequested = true;
      r.handle?.stop();
    }
    for (const s of this.setups.values()) s.abort.abort();
    for (const a of this.asks) a.stop();
    await Promise.race([this.whenIdle(), Bun.sleep(6000)]);
  }

  /** A chat reply is being cut off by shutdown: remember it so recover() resumes it (work runs stay in_progress). */
  private markInterrupted(r: ActiveRun): void {
    const t = this.store.getTicket(r.slug, r.id);
    if (!t || !r.chat || r.stopRequested || t.status === "in_progress") return;
    // Not spawned yet with a queued message: it is still in the queue, and recover() answers it.
    if (!r.handle && r.promptMsgId) return;
    const i: Interrupted = { at: nowIso(), mode: r.chat.mode };
    if (r.chat.quiet) i.quiet = true;
    if (r.chat.user) i.user = true;
    if (r.draft?.text) i.partial = r.draft.text;
    // Claude never got the prompt: send it again rather than asking it to continue.
    if (!r.handle) i.prompt = r.chat.raw ? { text: r.chat.text, raw: true } : { text: r.chat.text };
    this.patch(r.slug, r.id, { interrupted: i, lastActivity: null, runStartedAt: null });
  }

  /** Huddles tells the board about its host tickets' huddles, which change whether those tickets need the user. */
  onHostHuddles(f: (slug: string) => Map<string, HostHuddle>): void {
    this.hostHuddleStates = f;
  }

  /** Open huddles by host ticket on a board. */
  hostHuddles(slug: string): Map<string, HostHuddle> {
    return this.hostHuddleStates(slug);
  }

  /** Count more active work a restart waits for: busy() lists the board of each piece of work active now. */
  onRestartBusy(busy: () => string[]): void {
    this.restartBusy.push(busy);
  }

  /** Board runs plus other active work a restart waits for. */
  private activeWork(): number {
    return this.busyBoards().length;
  }

  /** The board of each piece of active work (runs, chat replies, huddle agents mid-turn, job commands), repeats included. */
  busyBoards(): string[] {
    return [...[...this.runs.values()].map((r) => r.slug), ...this.restartBusy.flatMap((f) => f())];
  }

  /**
   * Restart once no run is active. Until then nothing new starts: Ready tickets wait, chat messages queue and
   * Planning interviews are held; recover() starts them after the restart. After maxWaitMs it restarts anyway.
   */
  requestRestart(onIdle: () => void, maxWaitMs = RESTART_MAX_WAIT_MS): { running: number; alreadyPending: boolean } {
    const running = this.activeWork();
    if (this.restartPending) return { running, alreadyPending: true };
    this.restartPending = true;
    this.emitRestart();
    void (async () => {
      const deadline = Date.now() + maxWaitMs;
      // Always yield first, so the caller's HTTP response goes out before the daemon exits.
      do await Bun.sleep(200);
      while (this.activeWork() && Date.now() < deadline);
      const left = this.activeWork();
      if (left) console.log(`restart: ${left} run(s) still active after ${Math.round(maxWaitMs / 1000)}s; restarting anyway`);
      onIdle();
    })();
    return { running, alreadyPending: false };
  }

  isRestartPending(): boolean {
    return this.restartPending;
  }

  /** pending: a restart holds new runs; waiting: active runs it waits for. */
  restartState(): { pending: boolean; waiting: number } {
    return { pending: this.restartPending, waiting: this.activeWork() };
  }

  /** Other active work (see onRestartBusy) changed: update the pending restart's count. */
  restartWorkChanged(): void {
    if (this.restartPending) this.emitRestart();
  }

  private emitRestart(): void {
    this.bus.emit({ type: "restart.updated", ...this.restartState() });
  }

  recover(): void {
    for (const p of this.store.listProfiles()) {
      for (const t of this.store.listTickets(p.slug)) {
        // Replies waiting for a slot keep waiting: dispatch() below starts them first.
        // Tickets waiting for their auto huddle stay put: the huddle (or a freed slot) wakes them.
        if (t.status !== "in_progress" || t.slotWait || t.autoHuddle || this.isRunning(p.slug, t.id)) continue;
        if (t.followUpRun) {
          // A follow-up wake was cut off: continue it as a follow-up, and the card goes back where it was.
          this.store.addComment(p.slug, t.id, "ai", "Follow-up interrupted by daemon restart; resuming.");
          const returnTo = t.followUpRun.returnTo;
          this.patch(p.slug, t.id, { status: returnTo, lastActivity: null });
          this.start(p.slug, t.id, { text: interruptedPrompt(), mode: "act", raw: true, returnTo, followUp: true });
          continue;
        }
        if (t.main) {
          // A main ticket never gets a work run from a restart: it is woken again from its saved events.
          this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; waking it again from its saved events.");
          const plan = t.plan ?? this.newPlan(0);
          this.patch(p.slug, t.id, {
            status: "review", outcome: null, lastActivity: null,
            plan: {
              ...plan, state: plan.awaiting === "final" || plan.state === "done" || plan.state === "finishing" ? "running" : plan.state, awaiting: null,
              inbox: [...(plan.inbox ?? []), "The board restarted while your last run was going; check where things stand before you continue."],
            },
          });
          continue;
        }
        if (t.plan?.awaiting && planActive(t.plan)) {
          // A planner wake-up was cut off: wake it again with the children's current state.
          this.store.addComment(p.slug, t.id, "ai", "Planner interrupted by daemon restart; waking it again.");
          this.patch(p.slug, t.id, {
            status: "review", outcome: null, lastActivity: null,
            plan: { ...t.plan, state: t.plan.awaiting === "final" ? "finishing" : t.plan.state, awaiting: null, seen: {} },
          });
          continue;
        }
        this.store.addComment(p.slug, t.id, "ai", "Interrupted by daemon restart; resuming.");
        this.patch(p.slug, t.id, { status: "ready" });
      }
      this.dispatch(p.slug);
      this.advancePlans(p.slug);
      // Chat replies a restart cut off (or held back): continue them in the same session and mode.
      for (const t of this.store.listTickets(p.slug)) {
        const i = t.interrupted;
        if (!i || this.isRunning(p.slug, t.id) || t.status === "in_progress" || t.error?.startsWith("corrupt")) continue;
        if (!i.held) this.store.addComment(p.slug, t.id, "ai", "Reply interrupted by daemon restart; resuming.");
        const user = i.user ? { user: true } : {};
        if (i.prompt) this.start(p.slug, t.id, { text: i.prompt.text, mode: i.mode, raw: i.prompt.raw, quiet: i.quiet, ...user });
        // With a queued message waiting, the pass below answers it instead (one reply, not two).
        else if (!this.waiting(p.slug, t.id).length) this.start(p.slug, t.id, { text: interruptedPrompt(), mode: i.mode, raw: true, quiet: i.quiet, ...user });
      }
      // Messages a restarted chat run never got to: answer them in a chat reply now.
      for (const t of this.store.listTickets(p.slug)) {
        const next = this.waiting(p.slug, t.id)[0];
        if (!next || this.isRunning(p.slug, t.id) || t.status === "ready" || t.slotWait || t.error?.startsWith("corrupt")) continue;
        const chat = chatFor(t, next);
        if (takesSlot(chat, t.main) && chat.mode === "act" && this.folderBusy(p.slug, t)) this.waitForSlot(p.slug, t.id);
        else this.start(p.slug, t.id, chat, next.id);
      }
    }
  }

  async whenIdle(): Promise<void> {
    while (this.runs.size) {
      await Promise.all([...this.runs.values()].map((r) => r.promise));
    }
  }
}

function clampConcurrency(n: number): number {
  return Math.max(1, Math.min(10, Math.round(Number(n) || DEFAULT_MAX_CONCURRENT)));
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Opens a pull request with the GitHub CLI; returns its URL (land_milestone). */
async function openPrWithGh(dir: string, o: { branch: string; base: string; title: string; body: string }): Promise<string> {
  const r = await runCmd(["gh", "pr", "create", "--head", o.branch, "--base", o.base, "--title", o.title, "--body", o.body], dir);
  const url = /https:\/\/\S+\/pull\/\d+/.exec(r.stdout)?.[0];
  if (r.code !== 0 || !url) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "gh pr create failed");
  return url;
}
