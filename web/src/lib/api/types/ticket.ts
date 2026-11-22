import type { HuddleLine } from "../../../features/board/cardState";
import type { Status } from "../../../features/board/columns";
import type { TicketKind } from "../../../features/family/family";
import type { PrStatus, TicketPr } from "../../../features/ticket/prText";
import type { BrowserPick, TicketDevices } from "./browsers";
import type { QueuedMessage, SessionSummary } from "./chat";
import type { ResultCard, ShareJob, ShareLink, TicketLink } from "./files";
import type { Attention, HelperRuleCardState } from "./helper";
import type { SquadCardState, TeammateCardState } from "./huddle";
import type { ScheduleDeleteCardState } from "./schedules";

export type { PrCheck, PrStatus, TicketPr } from "../../../features/ticket/prText";
/** limit: the run hit the Claude usage/spend limit (see Ticket.limit). */
export type Outcome = null | "done" | "blocked" | "failed" | "stopped" | "needs_input" | "limit";
export type TicketMode = "interview" | "auto";

/** Start work on a Backlog ticket nobody shaped yet goes through the Planning interview first. */
export function startWorkTarget(t: Ticket): "planning" | "ready" {
  // A task is never shaped in Planning: its main ticket wrote it, and starting it runs it.
  if (t.tool) return "ready";
  const untouched = !t.refineStarted && !t.interviewed && t.runCount === 0 && !t.workdir && !t.sessionStarted;
  return t.status === "backlog" && untouched ? "planning" : "ready";
}

export type Workspace = "worktree" | "folder";

/** What a rewind did: messages and files feed "Rewound: N messages and M files went back."; undo: it can be undone. */
export interface RewindResult { text: string; restored: number; messages: number; files: number; undo: boolean; filesSaved?: boolean }
/** Whether the last rewind can be undone (blocked: why not) and what it would bring back. */
export interface RewindUndoState { available: boolean; blocked: string | null; messages: number; files: number; filesSaved: boolean }
/** What Undo rewind brought back. filesReason: why files didn't come back (the rewind changed none, couldn't save them first, or chat only was asked). */
export interface UndoRewindResult { messages: number; files: number; filesRestored: boolean; filesReason: "unchanged" | "not-saved" | "skipped" | null }

export interface FollowUp { dueAt: string; note: string; cancelOnReply: boolean; setAt: string; missedAt?: string | null }
export interface FollowUpLogEntry {
  at: string;
  kind: "set" | "woke" | "cancelled" | "replied" | "missed";
  dueAt?: string;
  note?: string;
  by?: "user" | "claude" | "reply";
  run?: number;
  costUsd?: number;
}

export interface FeatureStatusNote {
  at: string;
  text: string;
  delivered?: boolean;
}

/** GET …/status: the feature's saved status (Claude's words, the user's notes) and the board's facts, as sections. */
export interface FeatureStatus {
  topId: string;
  title: string;
  feature: boolean;
  saved: { updatedAt: string; claudeAt?: string | null; notes?: FeatureStatusNote[]; prNotes?: Record<string, string>; goal?: string; done?: string; broken?: string; waiting?: string; next?: string } | null;
  facts: {
    size: number;
    groups: { id: string; title: string; kind: string | null; total: number; counts: Record<string, number>; settled: boolean }[];
    loose: { total: number; counts: Record<string, number> };
    rounds: { id: string; title: string; passed: number; problem: number; open: number }[];
    broken: { id: string; title: string; state: string; reason?: string }[];
    /** Missing from an older server. */
    paused?: { id: string; title: string; resumeAt: string | null; auto: boolean }[];
    needsYou: { id: string; title: string }[];
    prs: { url: string; number: number | null; state: "open" | "merged" | "closed" | "unknown"; ticketId: string; ticketTitle: string; note?: string }[];
    /** The feature's saved changes, newest first (history), or the files changed in a folder without one; file: the full list. */
    changes?: { kind: "history" | "files"; items: { id?: string; text: string }[]; file?: string } | null;
    /** Sub-features of this feature, one line each: their own state and status headline. */
    subFeatures?: { id: string; title: string; state: string; headline?: string }[];
  };
  sections: { key: string; label: string; text: string }[];
  path: string;
}

export interface FamilyViewRow {
  id: string;
  depth: number;
  parent: string | null;
  model: string | null;
  effort: string | null;
  costUsd: number;
  needsYou: boolean;
  summary: string | null;
  finishedAt: string | null;
  report: boolean;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  mode?: TicketMode;
  interviewed?: boolean;
  sessionStarted?: boolean;
  /** The next run starts a new chat (Start a fresh chat), so the old one's size doesn't matter. */
  freshSession?: boolean;
  refineStarted?: boolean;
  order: number;
  sessionId: string | null;
  worktree: string | null;
  workdir?: string | null;
  branch: string | null;
  /** HEAD of the board's folder at the ticket's first run there (its Changes base without a worktree). */
  baseSha?: string | null;
  /** The main PR: the newest open one, else the newest. Merge & done and the PR box work on it. */
  prUrl: string | null;
  /** Every PR the ticket's runs reported, oldest first. Missing on old tickets: prUrl is their only PR. */
  prs?: TicketPr[] | null;
  /** Last fetched PR status; stale when pr.url differs from prUrl. */
  pr?: PrStatus | null;
  outcome: Outcome;
  lastActivity: string | null;
  /** When lastActivity last changed (the run's latest step). */
  lastActivityAt?: string | null;
  lastRunAt: string | null;
  /** When the current run or chat reply started (live elapsed time on the card). */
  runStartedAt?: string | null;
  /** Claude ended its turn and waits for these background tasks; it resumes when they finish. */
  waitingOn?: { id: string; description: string; startedAt: string }[] | null;
  runCount: number;
  error: string | null;
  /** Non-fatal heads-up about how the ticket runs (e.g. no worktree yet); dismissible. */
  notice?: string | null;
  /** Model set for this ticket with /model (overrides the board's). */
  model?: string | null;
  /** Reasoning effort set for this ticket (overrides the board's). */
  effort?: string | null;
  /** Ultracode for this ticket (true/false), or null for the board's. */
  ultracode?: boolean | null;
  /** Chrome for its runs: a deviceId from More → Browsers, "ask", or null (the ticket above it, else the board). */
  chrome?: string | null;
  /** The Chrome a ticket above it picked (a tool step follows its main ticket's); null: the board's. */
  chromeAbove?: string | null;
  /** Browsers for its runs with notes (wins over chrome); null: the ticket above it, else the board's. */
  browsers?: BrowserPick[] | null;
  /** The browser list a ticket above it set; null: the board's. */
  browsersAbove?: BrowserPick[] | null;
  /** Created by this schedule. */
  scheduleId?: string | null;
  /** Created by this one-time scheduled job. */
  jobId?: string | null;
  /** Created by an automation from an event in another service: where to open it. */
  source?: { provider: string; label: string; url: string; loopId: string } | null;
  /** Planner ticket whose chat proposed this one. */
  parentId?: string | null;
  /** Ticket this one was branched from (copy of its conversation and committed code). */
  branchedFrom?: string | null;
  /** When it was branched: conversation entries before this are the copied history. */
  branchPoint?: { at: string; sourceTitle: string } | null;
  /** The ticket whose chat card made this one (follow-up work asked for there after it ran). */
  madeFrom?: string | null;
  /** Ticket this one is part of (its family's parent, see family.ts); "chat": that ticket's chat created it. */
  partOf?: string | null;
  /** What the ticket is for (family.ts TicketKind); missing on old tickets. */
  kind?: TicketKind | null;
  /** A main ticket: the user's conversation; tool tickets in its family do the work. */
  main?: boolean;
  /** A tool ticket: made by Claude inside a main ticket's family; reports to its parent. */
  tool?: boolean;
  /** A task waiting in Backlog for the user or its main ticket to start it (its plan doesn't start it on its own). */
  waitsForStart?: boolean;
  /** "Show on board": a task that also gets a card (its Your turn and needs-you still go to its main ticket's chat). */
  showOnBoard?: boolean | null;
  /** Tool tickets' results, shown in this chat as cards. */
  results?: ResultCard[];
  /** Grey board notes in this chat (a "with you" step started waiting); they never wake Claude. */
  boardNotes?: { at: string; ticketId: string; text: string }[];
  /** A main ticket: its tool tickets working now (the card shows In progress meanwhile). */
  familyWorking?: number;
  /** A main ticket: its steps (tool tickets) running now; a card in Done or Backlog shows In progress meanwhile. */
  stepsRunning?: number;
  /** A main ticket: what its card shows of the family (tool tickets have no card). */
  familyCard?: FamilyCardInfo | null;
  /** A tool ticket: the main ticket it works for (a "with you" card's chip, the chat's note). */
  mainTicket?: { id: string; title: string } | null;
  /** A sub-feature (a main ticket linked under another ticket): the feature it is part of, for its "Part of …" chip. */
  subFeatureOf?: { id: string; title: string } | null;
  /** A test ticket's result. */
  verdict?: "passed" | "problem" | null;
  /** On a feature's top ticket: when its "Where we are" status last changed. */
  statusAt?: string | null;
  /** When its last run or chat reply ended. */
  runEndedAt?: string | null;
  partOfVia?: "chat" | null;
  /** A parent the board suggests for this ticket; the panel offers Link / Not related. */
  parentSuggestion?: { id: string; reason: string } | null;
  /** Claude comes back to this ticket at dueAt (follow_up); missedAt: it came due while the board was off, the user decides. */
  followUp?: FollowUp | null;
  /** Follow-ups set, woken, cancelled and replied to, oldest first. */
  followUpLog?: FollowUpLogEntry[];
  /** Claude stopped following up, and why (shown on the card until a new follow-up is set). */
  followUpStopped?: { at: string; reason: string } | null;
  seenAt?: string | null;
  /** Where it was before it moved from Review/Done back to Planning or Backlog. */
  reopenedFrom?: { status: Status; outcome: Outcome } | null;
  /** Short name siblings use in dependsOn. */
  planKey?: string | null;
  /** Title of the chat proposal it was created from: its card still finds it after a rename. */
  proposedAs?: string | null;
  /** Siblings (ticket id or planKey) a running plan finishes before starting this one. */
  dependsOn?: string[];
  /** Shared devices it expects to use (e.g. chrome-whatsapp): a hint only, its run takes them while it uses them. */
  needs?: string[];
  /** The user's labels for finding related tickets (e.g. "post"), lowercase. */
  tags?: string[];
  /** Tags Claude suggested: shown dashed until the user keeps (moves to tags) or drops each one. */
  suggestedTags?: string[];
  /** Shared devices its run uses now (since when) and the ones it waits for; null when neither. */
  devices?: TicketDevices | null;
  /** It would start now, but another ticket is editing the board's folder in place (board setting "One ticket at a time in my folder" on). */
  folderWait?: boolean;
  /**
   * Its run changes the board's folder in place while `others` other running tickets do too (board setting "One ticket
   * at a time in my folder" off). `offer`: the folder has no version history and this is the newest of those cards,
   * so it offers to turn version history on for `path`.
   */
  folderShare?: { others: number; offer: boolean; /** The board turns version history on once these tickets finish. */ pending?: boolean; path?: string } | null;
  /** A plan child waiting on the user (questions, a proposal to apply, in Planning); the plan won't start it. */
  userWait?: string | null;
  /** Set once this ticket's plan was started: the board runs its children unattended. */
  plan?: Plan | null;
  /** Messages Claude has not read yet (sent while it worked, or the one that started its reply); "unsent" ones were cut off by Stop. */
  queued?: QueuedMessage[];
  /** Chat messages that came from Telegram (a reply to an alert): the chat marks them "via Telegram". */
  telegramIn?: { updateId: number; at: string; text: string }[];
  /** This ticket's replies sent back to Telegram: the chat marks them "sent to Telegram". text: the reply's start. */
  telegramOut?: { at: string; text: string }[];
  /** A reply a daemon restart cut off; the board resumes it. partial: what Claude had written so far. */
  interrupted?: { at: string; partial?: string; held?: boolean } | null;
  /** A chat reply waiting for the folder (another ticket edits it in place): shown queued in In Progress. */
  slotWait?: { at: string; from: { status: Status; outcome: Outcome } } | null;
  /** The run has sent no output for the board's stall time: Stop, Keep waiting or Restart. */
  stalled?: { at: string; minutes: number } | null;
  /** Set with outcome "limit": when it resets and whether the board sends "continue" then. */
  limit?: { resetAt: string; auto: boolean; capped?: boolean; at: string; message: string } | null;
  /** false: automatic continues after the usage limit are off for this ticket. */
  autoContinue?: boolean;
  /** Per-run spending cap for this ticket: a positive amount, 0 for none; missing/null: the board's. */
  runCapUsd?: number | null;
  /** The last run stopped at its spending cap. */
  capHit?: { capUsd: number; at: string } | null;
  /** Cap for the next run only ("Continue with +$Y"). */
  capNextUsd?: number | null;
  /** API-equivalent $ so far (In Progress and Review cards; null otherwise). */
  costUsd?: number | null;
  /** Spending cap its next work run gets (null: none). */
  runCap?: number | null;
  /** Its run is a working run (not a Planning chat or a reply). */
  holdsSlot?: boolean;
  /** ⭐ Important: unattended runs review it in an auto huddle before landing. */
  important?: boolean;
  /** 📌 Pinned to the top of its column since then (newest first); the server clears it at Done. */
  pinnedAt?: string | null;
  /** The auto huddle its run started (live) or waits for (waiting, another one has the board's slot). */
  autoHuddle?: { state: "waiting" | "live"; reason: string; template: string; at: string; huddleId?: string | null } | null;
  createdAt: string;
  updatedAt: string;
  body: string;
  running?: boolean;
  /** Linked session currently open in a terminal. */
  terminalOpen?: boolean;
  /** The last run's error has a one-click fix: Start fresh session (session_missing) or Take over here (session_open). */
  recovery?: "session_missing" | "session_open" | null;
  resumeCommand?: string | null;
  session?: SessionSummary | null;
  /** Why the ticket is waiting on you ("Your turn"), computed by the server. */
  attention?: Attention | null;
  /** Snoozed from the Inbox: what it waits for and until when (attention is null meanwhile). */
  snoozed?: { attention: Attention; until: string } | null;
  /** Its own huddle is working (its own run isn't, and it asks nothing of the user): the card shows its huddle line. */
  huddleBusy?: boolean;
  /** While huddleBusy: helpers working now and in the huddle, and its open findings (cardState.ts huddleLineText). */
  huddleLine?: HuddleLine | null;
  /** Output files published as claude.ai pages from the Share menu, one link per file. */
  shareLinks?: ShareLink[];
  /** Artifacts and share links, newest first (src/board/links.ts). */
  links?: TicketLink[];
  /** Teammate cards in the chat the user answered, by entry uuid (src/core/types.ts). */
  teammateCards?: Record<string, TeammateCardState>;
  /** Squad cards in the chat the user answered, by entry uuid. */
  squadCards?: Record<string, SquadCardState>;
  /** Schedule delete cards in the chat the user answered, by entry uuid (src/core/types.ts). */
  scheduleDeleteCards?: Record<string, ScheduleDeleteCardState>;
  /** Helper rule cards (propose_helper_rule) the user answered, by entry uuid (src/core/types.ts). */
  helperRuleCards?: Record<string, HelperRuleCardState>;
  /** Automation cards in the chat the user saved (by entry uuid). */
  automationCards?: Record<string, { loopId: string; at: string }>;
  /** Key boxes (ask_keys) answered, by entry uuid: the names saved, or self for "I'll do it myself". */
  keyCards?: Record<string, { saved: string[]; self?: boolean; at: string }>;
  /** Question forms closed without an answer, by entry uuid (questionForms.ts ClosedForms). */
  closedForms?: Record<string, { at: string; by?: "user" | "task"; taskId?: string }>;
  /** Made by Automations → Set up with Claude. */
  automationSetup?: boolean;
  /** Share menu publishes in progress (or the last one's error), per output file. */
  shareJobs?: ShareJob[];
  /** Absolute path of the ticket's outputs folder. */
  outputDir?: string;
  /** The daemon can put a file on the system clipboard (macOS). */
  canCopyFile?: boolean;
}

export type PlanState = "running" | "paused" | "finishing" | "done" | "stuck";

export interface Plan {
  state: PlanState;
  wakeups: number;
  startedAt: string;
  finishedAt?: string | null;
  originalCount: number;
  awaiting?: "event" | "final" | null;
  reason?: string | null;
}

export interface QuestionOption {
  label: string;
  description?: string;
  recommended: boolean;
  /** Mockup this option stands for (file name in outputs/mockups). */
  mockup?: string;
}

export interface Question {
  question: string;
  /** Background, folded under the question as "Details" (markdown). Older forms have none. */
  context?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface Comment {
  id: string;
  author: "user" | "ai";
  text: string;
  at: string;
}

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}

/** What a main ticket's card shows of its family (src/board/main-ticket.ts familyCard). */
export interface FamilyCardInfo {
  tools: number;
  /** Tool tickets not finished yet (not in Done, or still running). */
  open?: number;
  /** Finished tool tickets, groups included. */
  toolsDone?: number;
  /** Its tasks and the finished ones, counted like the Tasks tab badge (a group isn't a task): "7 of 16 tasks". */
  tasks?: number;
  tasksDone?: number;
  /** Tool tickets working or queued now. */
  running: string[];
  /** Every family ticket working or queued now (tool tickets and tickets the user added). */
  working?: string[];
  costUsd: number;
  line: { text: string; tone: "work" | "warn" | "fail"; until?: string | null } | null;
  waiting: { id: string; label: string; attention: string; since: string } | null;
  /** "With you" steps waiting for the user's answer in this chat, oldest first. */
  needsYou?: { id: string; label: string; attention: string; since: string }[];
  /** Its sub-features (main tickets linked under it), oldest first; working: it or anything under it works. Missing from an older server. */
  subFeatures?: { id: string; title: string; working: boolean }[];
  /** How many sub-features are working now: "· 1 sub-feature running". Counted once each in working. */
  subFeaturesRunning?: number;
}

/** A proposed title and description from propose_ticket; partOf: move it in its family on Apply (null: out of it). */
export interface Proposal {
  title: string;
  description: string;
  important?: true;
  partOf?: string | null;
}
