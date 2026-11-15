import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type RepoKind } from "../runs/git";
import { type BrowserDeps } from "../browser/board-browsers";
import type { SessionSummary } from "../runs/session";
import { familyOf } from "../../web/src/features/family/family";
import { type ChatMode } from "../runs/prompts";
import { run as runCmd } from "../runs/git";
import { workflowDirCost } from "../runs/workflows";
import { DraftTracker } from "../chat/draft";
import { type RunHandle } from "../runs/runner";
import { commandText } from "../chat/commands";
import type { OwnedSession } from "../browser/shell";
import { type QueuedMessage, type SelfMove, type Status, type Ticket } from "../core/types";

export const INSTALLING = "Installing project dependencies…";
/** The live line right after a message is sent, while Claude thinks (no step yet). A fixed marker: the UI shows it as
 * "<the name the user gave Claude> is thinking…" (web/src/features/avatar/avatarMood.ts liveLine); old tickets may still hold "Claude is replying…". */
export const THINKING_LINE = "Claude is thinking…";

/** Where a schedule's run or an automation's new ticket goes as a task (Board.taskPlaceFor). */
export interface TaskPlace {
  /** The ticket that runs it as a task (its parentId): a tool group or the main ticket. */
  managerId: string;
  mainId: string;
  /** The group it hangs under when that group doesn't run tasks itself. */
  partOf?: string;
  startFrom?: string;
}

/** What made a task in a feature (Board.createFeatureTask): it names it in the comments. */
export type TaskMaker = { kind: "schedule" | "automation"; name: string };

/** A run's board browsers (Board.runBrowsers): tool servers for --mcp-config, the prompt note, and whether to leave out Claude in Chrome. */
export interface RunBrowsers {
  servers: Record<string, unknown>;
  note: string | null;
  noChrome: boolean;
}

export interface BoardOptions {
  claudeBin: string;
  /** Board browsers' Chrome launcher and checks (tests pass fakes; see board-browsers.ts). */
  browserDeps?: BrowserDeps;
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
  /** A ticket's run ended with this final text (Telegram sends it back to a message that came from there). */
  turnEnded?: (slug: string, id: string, text: string) => void;
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

export interface ActiveRun {
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
  /** Its promise runs (execute): the promise's end unregisters it. Without it the run never got going (see stopRun). */
  started?: boolean;
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
  /** The current attempt's spending so far (executeOnce), so a steer can note where Telegram's part starts. */
  spend?: RunSpend;
  /**
   * A Telegram message started this run or was steered into it: what the attempt had spent by then (0: Telegram
   * started it). At the attempt's end the rest counts as "Spent from Telegram today" (spend.ts addTelegramSpend).
   */
  telegramFrom?: number;
  /** The user chose Restart on a stalled run: once it is stopped, it resumes in the same session. */
  restartRequested?: boolean;
  /** Workflows pushed this run past its spending cap: the board stopped it (what the run had spent, in $). */
  workflowCapHit?: number;
  /** This run started an auto huddle (start_huddle): one per run. */
  autoHuddleStarted?: boolean;
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
export function hasText(ev: any): boolean {
  if (ev?.type !== "assistant" || ev.parent_tool_use_id) return false;
  const c = ev.message?.content;
  return Array.isArray(c) && c.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
}

export function replayText(ev: any): string | null {
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
export function chatFor(
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
export function flags(o: ChatOptions): Pick<QueuedMessage, "peer" | "fromPlanner" | "from" | "automation" | "slash" | "hostWake" | "followUp" | "telegram" | "nextRun"> {
  return {
    ...(o.automation ? { automation: o.automation } : {}),
    ...(o.nextRun ? { nextRun: true } : {}),
    ...(o.from ? { from: o.from } : {}), ...(o.telegram ? { telegram: o.telegram } : {}),
    ...(o.peer ? { peer: true } : {}), ...(o.fromPlanner ? { fromPlanner: true } : {}), ...(o.slash ? { slash: o.slash } : {}),
    ...(o.hostWake ? { hostWake: true } : {}), ...(o.followUp ? { followUp: true } : {}),
  };
}

/** ChatOptions.still said no: nothing was queued. */
export class StillRefused extends Error {
  constructor() {
    super("not taking this message any more");
    this.name = "StillRefused";
  }
}

/** Telegram marks kept per ticket (telegramIn, telegramOut). */
export const TELEGRAM_KEEP = 30;

/** Board.chat options; hostWake: the ticket's own auto huddle (or a free auto-huddle slot) wakes it; followUp: its follow-up is due. */
export interface ChatOptions {
  /**
   * Checked right before the message is queued (after any wait, such as the rewind snapshot): false refuses it with a
   * StillRefused error and nothing is queued (Telegram: "Take messages" turned off meanwhile).
   */
  still?: () => boolean;
  peer?: boolean;
  fromPlanner?: boolean;
  /** Sent by another ticket's Claude: which one (shown with the message instead of "You"). */
  from?: { ticketId: string; title: string };
  slash?: "prompt" | "local";
  hostWake?: boolean;
  followUp?: boolean;
  /** The user's "Send in a fresh chat": this message starts a new chat; the old one stays visible above it. */
  fresh?: boolean;
  /** The user sent it from Telegram (a reply to an alert): kept on the queued message so a restart never sends it twice. */
  telegram?: { updateId: number; tg: number };
  /** Start a new run for it rather than steering a run already going (see QueuedMessage.nextRun). */
  nextRun?: boolean;
  /**
   * A later item of this automation's thread (Board.automationItem): never the user's (send it with fromPlanner), shown
   * with the automation's name, and it resumes the ticket's session even when it is cold and large (no automatic fresh chat).
   */
  automation?: { loopId: string; name: string };
}

/** What the card says while the ticket waits for its auto huddle. */
export function autoHuddleActivity(a: NonNullable<Ticket["autoHuddle"]>): string {
  return a.state === "waiting" ? "Waiting for huddle slot" : "Auto huddle: waiting for the review";
}

/** Statuses whose ticket already did its work: moving it back to Planning or Backlog remembers it (Ticket.reopenedFrom). */
export function reopenable(s: Status): boolean {
  return s === "review" || s === "done";
}

/**
 * Runs that do the ticket's work: work runs, and chat replies that act on the ticket. Planning interviews, replies to
 * another ticket's Claude (its asker waits on them) and planner wake-ups are short housekeeping and don't count. There
 * is no limit on them (the board starts every run as soon as it is ready); the count shows on the board and decides
 * whether a reply waits for a folder that another ticket edits in place.
 */
export function takesSlot(chat?: ActiveRun["chat"], noEdit?: boolean): boolean {
  // A main ticket's runs can't edit (they only talk and decide): they never wait for a slot.
  if (noEdit) return false;
  return !chat || (chat.mode === "act" && !chat.quiet && (!chat.returnTo || !!chat.followUp));
}

/** What the chat says about a message held back by a pending restart. */
export const RESTART_HOLD_TEXT = "The board restarts soon; your message is sent right after (at most 10 minutes).";

export const ACTIVITY_THROTTLE_MS = 1000;
/** A form answer ("My answers: …") identical to one taken this recently isn't sent again (two tabs, a double tap). */
export const ANSWER_REPEAT_MS = 30_000;
export const ANSWER_PREFIX = "My answers:";
/** How long a board folder's cached version history (see Board.repoState) is trusted. */
export const REPO_TTL_MS = 10_000;
/** How long a feature's saved changes list (see Board.savedChanges) is trusted when its family didn't change. */
export const CHANGES_TTL_MS = 60_000;
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
export const STALL_RESTART_TEXT = "Your previous run stopped responding and the user restarted it. Continue where you left off.";
/** A requested restart waits this long for active runs to finish, then restarts anyway (recover() resumes them). */
export const RESTART_MAX_WAIT_MS = 10 * 60_000;
export const DRAFT_THROTTLE_MS = 120;
/** What a run spent: its own messages plus its workflows' helper agents. */
export type RunSpend = { main: Map<string, number>; workflowDirs: Set<string>; files: Map<string, { key: string; cost: number }> };

export function spentWith(spend: RunSpend): number {
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

/** Why a message or a second rewind waits while a rewind, undo or fork runs. */
export const REWINDING = "The chat is being rewound, undone or forked right now. Try again in a moment.";

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

/** The chat note when a cold, large main or feature chat starts its next turn fresh (Board.autoFresh). */
export const AUTO_FRESH_NOTE = "Started a fresh chat to keep this cheap: Claude starts from the status and can look up earlier messages.";

export class ConflictError extends Error {}

/** Every ticket below id in its family (not id itself). */
export function subtreeIds(tickets: Ticket[], id: string): string[] {
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


/** What the card says when a run couldn't even start. */
export function startError(e: unknown): string {
  if ((e as NodeJS.ErrnoException)?.code === "ENOSPC") return "Couldn't start: no space left on the disk";
  return String((e as Error)?.message ?? e);
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Opens a pull request with the GitHub CLI; returns its URL (land_milestone). */
export async function openPrWithGh(dir: string, o: { branch: string; base: string; title: string; body: string }): Promise<string> {
  const r = await runCmd(["gh", "pr", "create", "--head", o.branch, "--base", o.base, "--title", o.title, "--body", o.body], dir);
  const url = /https:\/\/\S+\/pull\/\d+/.exec(r.stdout)?.[0];
  if (r.code !== 0 || !url) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ") || "gh pr create failed");
  return url;
}
