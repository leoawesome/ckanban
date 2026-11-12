import type { TeammateProposal } from "./teammate-proposal";
import type { SquadCardState, SquadProposal } from "./squad";
import type { RewindUndo } from "./rewind";

import type { TicketKind } from "../../web/src/family";
import type { ClosedForms } from "../../web/src/family";
import type { TaskModels } from "../../web/src/models";
export type { TicketKind };
export type Status = "backlog" | "planning" | "ready" | "in_progress" | "review" | "done";
/** limit: the run ended because the Claude usage/spend limit was hit (see Ticket.limit). */
export type Outcome = null | "done" | "blocked" | "failed" | "stopped" | "needs_input" | "limit";
/** interview: Claude asks clarifying questions before doing the work. auto: just do it. */
export type TicketMode = "interview" | "auto";

export const STATUSES: Status[] = ["backlog", "planning", "ready", "in_progress", "review", "done"];
/** Columns a ticket's own chat may move its card to when the user asks in that chat (see Board.requestSelfMove). */
export type SelfMove = "done" | "backlog" | "ready";
export const SELF_MOVES: SelfMove[] = ["done", "backlog", "ready"];

export interface Profile {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  /** No longer used: runs start as soon as they are ready. Older profile files may still have it; it is ignored. */
  maxParallel?: number;
  model?: string | null;
  /** Default reasoning effort (low, medium, high, xhigh, max); empty: Claude's own. */
  effort?: string | null;
  /** Ultracode by default: tickets' work runs plan a workflow (many helper agents) for every substantial task. */
  ultracode?: boolean;
  /** Default Chrome for this board's runs: a deviceId from More → Browsers (chromes.ts), "ask" (ask each time), or none. */
  chrome?: string | null;
  createdAt: string;
  /** Git-ignored files (paths or globs relative to the board folder) copied into each new worktree. */
  copyFiles?: string[];
  /** Installs dependencies in a ticket's worktree (user's shell), only when its Claude asks (`ckanban ticket setup`). */
  setupCommand?: string;
  /** Runs in a worktree before the board removes it. */
  cleanupCommand?: string;
  /** What auto-detection last found; missing: detection never ran (the board runs it on start). */
  setupDetected?: SetupDetection | null;
  /**
   * Unattended runs may start a review huddle by themselves (start_huddle) before landing important or risky work.
   * Missing: on (see autoHuddlesOn).
   */
  autoHuddles?: boolean;
  /** While this board has work going, keep the Mac from idle sleep (awake.ts). Missing: on (see keepAwakeOn). */
  keepAwake?: boolean;
  /** Spending cap per run in USD (claude --max-budget-usd) for its tickets' work runs. Missing/null: none. */
  runCapUsd?: number | null;
  /** Runs are taught the claude.ai artifact helper (publish/read artifacts). Missing: off, except for runs whose ticket or messages hold an artifact link. */
  artifacts?: boolean;
  /** The user dismissed the board's one-time offer to set up proactive check-ins (Schedules → Proactive check-ins). */
  checkinOfferDismissed?: boolean;
  /** Minutes without stream output before a run counts as stalled (the Inbox asks what to do). 0: off. Missing: 20. */
  stallMinutes?: number;
  /**
   * Where new runs work: "worktree", a copy of the repo per ticket on its own branch (parallel); "folder", the board's
   * folder itself on its current branch (one ticket at a time). Missing: worktree. Only new runs follow a change.
   */
  workspace?: Workspace;
  /**
   * Which connectors from the user's claude.ai account this board's runs get (they cost tokens on every turn):
   * "all", "none", or the names to keep ("Slack"). Missing or unknown: all. See connectors.ts.
   */
  claudeAiConnectors?: "all" | "none" | string[];
  /** Board setting "Main ticket model": model for main tickets' runs (their own /model still wins). Missing/null: the board's model. */
  mainModel?: string | null;
  /**
   * A main ticket's or feature's chat that has gone cold starts its next turn as a fresh chat seeded from the status once
   * it would re-read more than this many tokens. Missing: 150,000.
   */
  freshChatTokens?: number | null;
  /**
   * Board setting "Task models": model and effort per kind of tool ticket, only the kinds the user changed (the rest
   * use KIND_DEFAULTS in web/src/models.ts). A model or effort create_ticket passes for one task still wins.
   */
  taskModels?: TaskModels | null;
}

export type Workspace = "worktree" | "folder";

/** Board setting "Workspace": a worktree per ticket unless set to the project folder. */
export const workspaceOf = (p: Pick<Profile, "workspace"> | null | undefined): Workspace => (p?.workspace === "folder" ? "folder" : "worktree");

/** Board setting "Keep this Mac awake while Claude is working": on unless turned off. */
export const keepAwakeOn = (p: Pick<Profile, "keepAwake"> | null | undefined): boolean => p?.keepAwake !== false;

/** Board setting "Auto huddles": on unless turned off. */
export const autoHuddlesOn = (p: Pick<Profile, "autoHuddles"> | null | undefined): boolean => p?.autoHuddles !== false;

/**
 * A review huddle the ticket's unattended run started by itself (start_huddle). waiting: another auto huddle is live
 * on the board, so the ticket waits in In Progress and the board wakes it when that one ends. live: huddleId runs.
 */
/**
 * Why a run started its auto huddle: a risk it found (security, data, payments), the ticket is ⭐ (important) or its
 * "## Review huddle" section asks for one (asked).
 */
export const AUTO_HUDDLE_TRIGGERS = ["security", "data", "payments", "important", "asked"] as const;
export type AutoHuddleTrigger = (typeof AUTO_HUDDLE_TRIGGERS)[number];
export const isAutoHuddleTrigger = (v: unknown): v is AutoHuddleTrigger => AUTO_HUDDLE_TRIGGERS.includes(v as AutoHuddleTrigger);
/**
 * start_huddle's trigger when the user's own chat message asked for a huddle now: it starts like the user's Start on a
 * proposal card (not an auto huddle), so it needs no board setting and takes no auto-huddle slot.
 */
export const USER_HUDDLE_TRIGGER = "user";

export interface AutoHuddle {
  state: "waiting" | "live";
  reason: string;
  /** Missing on huddles started before triggers were named. */
  trigger?: AutoHuddleTrigger;
  /** The template's name, or "custom" for a roster the run built. */
  template: string;
  at: string;
  huddleId?: string | null;
  /** Budget the run asked for (already capped); the slot wake passes it back to start_huddle. */
  maxCostUsd?: number;
  /** Topic the run asked for (a waiting request keeps it); the slot wake passes it back to start_huddle. */
  topic?: string;
}

/** Worktree setup values detected from the board folder (see worktree-setup.ts). */
export interface SetupDetection {
  at: string;
  copyFiles: string[];
  setupCommand: string;
  /** Lockfiles the setup command came from, e.g. "bun.lock", "web/bun.lock". */
  setupFrom: string[];
}

/** A tool Claude left running in the background (a long Bash call, a subagent). */
export interface BackgroundTask {
  id: string;
  description: string;
  /** When the board first saw it. */
  startedAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  /** Missing on tickets created before modes existed: treated as "auto". */
  mode?: TicketMode;
  /** True once Claude has asked the user a round of questions on this ticket. */
  interviewed?: boolean;
  /** True once any claude run used this ticket's sessionId (so later runs must --resume). */
  sessionStarted?: boolean;
  /** The board tools' fingerprint (mcp-server toolsVersion) at its last run: a resumed session hears when they changed. */
  toolsVersion?: string;
  /** The next run starts a new session that picks up from the worktree (Start fresh session after a lost session). */
  freshSession?: boolean;
  /** The fresh chat freshSession starts was started by the board (a cold, large main or feature chat), not the user. */
  freshAuto?: boolean | null;
  /**
   * Chats this ticket left behind with "Send in a fresh chat", oldest first: the ticket chat still shows them (above a
   * note), but Claude doesn't see them.
   */
  earlierSessions?: { sessionId: string; endedAt: string }[];
  /** What the last Rewind changed, so Undo can put it back (rewind.ts undoBlocked says when it may). */
  rewindUndo?: RewindUndo | null;
  /** True once a refine conversation began (auto-start on entering Planning happens only once). */
  refineStarted?: boolean;
  order: number;
  sessionId: string | null;
  worktree: string | null;
  /** The worktree was made but the board's setup command hasn't succeeded in it yet (runs on demand, see Board.runSetup). */
  setupPending?: boolean;
  /** Folder of a linked pre-existing Claude session (runs happen here instead of a worktree). */
  workdir?: string | null;
  branch: string | null;
  /** HEAD of the board's folder when the ticket first ran there in place (the Changes tab's base without a worktree). */
  baseSha?: string | null;
  /** The main PR (prs.ts mainPr): the newest open one, else the newest. The Merge button and the PR box work on it. */
  prUrl: string | null;
  /** Every PR the ticket's runs reported, oldest first (prs.ts). Missing on old tickets: prUrl is their only PR. */
  prs?: TicketPr[] | null;
  /** Last fetched state of prUrl's PR (checks, conflicts, reviews); stale once pr.url differs from prUrl. */
  pr?: PrStatus | null;
  outcome: Outcome;
  lastActivity: string | null;
  /** When lastActivity last changed (the run's latest step); null with it. Missing on old tickets. */
  lastActivityAt?: string | null;
  lastRunAt: string | null;
  /** When the last run or chat reply ended (the Family tab's "finished … ago"). Missing on old tickets. */
  runEndedAt?: string | null;
  /** When the current run or chat reply started; null when Claude is not working. Missing on old tickets. */
  runStartedAt?: string | null;
  /**
   * The current run has sent no output for the board's stallMinutes (and waits on no background task): the Inbox asks
   * the user to Stop, Keep waiting or Restart. Cleared when output resumes or the run ends.
   */
  stalled?: { at: string; minutes: number } | null;
  /** Claude ended its turn and waits for these background tasks; it resumes when they finish. */
  waitingOn?: BackgroundTask[] | null;
  runCount: number;
  error: string | null;
  /** Non-fatal heads-up about how the ticket runs (e.g. no worktree yet); the user can dismiss it. */
  notice?: string | null;
  /** Model for this ticket's runs, set with /model in its chat; overrides the board's model. */
  model?: string | null;
  /** Reasoning effort for this ticket's runs, set with /effort in its chat; overrides the board's effort. */
  effort?: string | null;
  /** Ultracode for this ticket's work runs (/effort ultracode, or the Ultracode chip); null: the board's. */
  ultracode?: boolean | null;
  /** Chrome for this ticket's runs: a deviceId from More → Browsers, "ask", or null: its main ticket's, else the board's. */
  chrome?: string | null;
  /** Set on tickets created by a schedule (see Schedule). */
  scheduleId?: string | null;
  /**
   * Set on tickets a schedule's run created (create_ticket from inside the run of ticket ticketId): what that schedule
   * raised for the user. A quiet schedule's next runs are told which of these are still open.
   */
  raisedBy?: { scheduleId: string; ticketId: string } | null;
  /** Set on tickets created by a one-time scheduled job (see Job). */
  jobId?: string | null;
  /** Set on tickets an automation loop made from an event in another service (see TicketSource). */
  source?: TicketSource | null;
  /**
   * A task an automation put in a feature without starting it (autoStart off): it waits in Backlog and its main
   * ticket's plan doesn't start it on its own; the user or the main ticket moving it starts it (cleared then).
   */
  waitsForStart?: boolean;
  /** Planner ticket whose Planning chat proposed this one. Missing on most tickets. */
  parentId?: string | null;
  /** Short name siblings use in dependsOn (from the planner's proposal). */
  planKey?: string | null;
  /** Title of the chat proposal (a propose_tickets draft or a follow-up card) it was created from, so that card still finds it after a rename. */
  proposedAs?: string | null;
  /** Siblings (ticket id or planKey) that must be done before a running plan starts this ticket. */
  dependsOn?: string[];
  /**
   * Exclusive resources this ticket's runs use (e.g. "emulator"), lowercase. Tickets that need the same one never
   * run at the same time, on any board of this machine; it adds no order (that is dependsOn).
   */
  needs?: string[];
  /** The user's short labels for finding related tickets (e.g. "post"), normalized by normalizeTags. */
  tags?: string[];
  /** Tags Claude suggested for this ticket (suggest_tags); the user keeps (moves to tags) or drops each one. */
  suggestedTags?: string[];
  /** Ticket this one was branched from (a copy of its conversation and committed code). Not a plan parent. */
  branchedFrom?: string | null;
  /** When the branch was made: conversation entries before this are the copied history. */
  branchPoint?: BranchPoint | null;
  /**
   * The ticket whose chat card made this one: follow-up work asked for there after it ran (web/src/followUp.ts), or an
   * old add-on ticket (store.ts loads addOnOf as partOf plus madeFrom). Not a family link: the learner reads it as a
   * correction of that ticket, and the card finds what it made by it.
   */
  madeFrom?: string | null;
  /**
   * Ticket this one is part of (its family's parent, see web/src/family.ts): a plain link, set by the user or by the
   * chat that created it. It changes nothing about how work runs.
   */
  partOf?: string | null;
  /** What the ticket is for, set when it is created (see web/src/family.ts TicketKind). Missing on old tickets. */
  kind?: TicketKind | null;
  /** A test ticket's result ("verdict" on its result line); a test that ended done without one counts as passed. */
  verdict?: "passed" | "problem" | null;
  /** On a feature's top ticket: when its "Where we are" status last changed (status.json in its outputs, see feature.ts). */
  statusAt?: string | null;
  /** "chat": the ticket's chat created this one as part of it (create_ticket's partOfThisTicket). */
  partOfVia?: "chat" | null;
  /** A parent the board suggests for a ticket the user created (see linker.ts); the panel offers Link / Not related. */
  parentSuggestion?: { id: string; reason: string } | null;
  /** The board already looked for a parent (or the user said Not related): it doesn't suggest one again. */
  parentChecked?: boolean;
  /** Branch the first worktree starts from instead of the base branch (a step: its main ticket's copy). */
  startFrom?: string | null;
  /** When the ticket last moved into Done (the store sets it): its huddles from before then close. */
  doneAt?: string | null;
  /** Where the ticket was before a chat or the user moved it from Review/Done back to Planning or Backlog. */
  reopenedFrom?: Pick<Ticket, "status" | "outcome"> | null;
  /**
   * Another ticket's run started this ticket's latest run (move to Ready or Planning, a chat message, create): which
   * ticket and how deep the chain of runs started by runs is (1 = started by a run the user started). The user starting
   * it again clears it; slug is set when that ticket is on another board. See Board.runStart.
   */
  startedBy?: { ticketId: string; depth: number; slug?: string; chain?: string[] } | null;
  /** Set on a planner ticket once its plan was started: the board runs its children unattended. */
  plan?: Plan | null;
  /**
   * A main ticket: the conversation the user started for a piece of work. It talks, decides and keeps the status; its
   * tool tickets do the work (main-ticket.ts). Its runs never edit files. Set when the user creates a ticket on its own.
   */
  main?: boolean;
  /** A tool ticket: made by Claude inside a main ticket's family; runs unattended and reports to its parent. */
  tool?: boolean;
  /**
   * "Show on board": a tool ticket (task) that also gets a card on the board. Its Your turn and needs-you still go to its
   * main ticket's chat. Old tickets have none: hidden.
   */
  showOnBoard?: boolean | null;
  /** Tool tickets' results, shown in this ticket's chat as result cards (oldest first, the last RESULTS_KEEP kept). */
  results?: ResultCard[];
  /** Board notes in this (main) ticket's chat, e.g. a "with you" step started waiting (oldest first, the last BOARD_NOTES_KEEP kept). */
  boardNotes?: BoardNote[];
  /** A tool ticket's merge_into_main calls that failed since its last merge (3 end it blocked). */
  mergeFails?: number;
  /** A tool ticket's commit last fast-forwarded into its main ticket's copy. */
  merged?: string | null;
  /**
   * A main ticket's copy started from this commit: its Changes tab shows everything its tool tickets merged since, also
   * after milestones landed it in the base branch.
   */
  startSha?: string | null;
  /** Chat messages Claude has not read yet, oldest first: sent while it was working, or the one that started its reply. */
  queued?: QueuedMessage[];
  /** Chat messages that came from Telegram (a reply to an alert), newest last, at most TELEGRAM_KEEP: the chat marks them "via Telegram". */
  telegramIn?: TelegramIn[];
  /** This ticket's replies sent back to Telegram, newest last: the chat marks them "sent to Telegram". */
  telegramOut?: TelegramOut[];
  /** A message from Telegram waits for this ticket's next reply: when its turn ends, the reply goes back as an answer to it. */
  telegramReport?: { tg: number; chatId: number; at: string } | null;
  /** A chat reply the daemon cut off by restarting (or held back while a restart waited); recover() resumes it. */
  interrupted?: Interrupted | null;
  /**
   * A chat reply waiting for the folder (another ticket edits it in place): the card shows In Progress, queued, and dispatch() starts it before
   * Ready tickets. from: where the card was, so Stop puts it back.
   */
  slotWait?: { at: string; from: Pick<Ticket, "status" | "outcome"> } | null;
  /**
   * Snoozed from the Inbox until a time: it doesn't need the user (no Inbox entry, no counts) until then, or until
   * its state changes (key: snoozeKey when snoozed, see attention.ts).
   */
  snooze?: { until: string; key: string } | null;
  /** ⭐ Important: set by the user (or Claude when the user says so); unattended runs review it in an auto huddle before landing. */
  important?: boolean;
  /**
   * 📌 Pinned by the user: the card sits at the top of whatever column it is in (newest pin first) until unpinned or
   * moved to Done (the store clears it then). Missing or null: not pinned.
   */
  pinnedAt?: string | null;
  /** The auto huddle this ticket's run started or waits for; the card stays In Progress until it ends. */
  autoHuddle?: AutoHuddle | null;
  /** Claude comes back to this ticket at followUp.dueAt: the board wakes the same conversation (see followup.ts). */
  followUp?: FollowUp | null;
  /** Follow-ups set, woken, cancelled and replied to, oldest first (last FOLLOW_UP_LOG_KEEP kept); Claude sees it on every wake. */
  followUpLog?: FollowUpLogEntry[];
  /** A follow-up wake is running: a restart that cuts it off resumes it as a follow-up and puts the card back in returnTo. */
  followUpRun?: { returnTo: Status } | null;
  /** Claude decided to stop following up (cancel_follow_up with a reason): the card says so until a new follow-up is set. */
  followUpStopped?: { at: string; reason: string } | null;
  /** When the user last opened this ticket on the board (the follow-up wake prompt tells Claude). */
  seenAt?: string | null;
  /** Set with outcome "limit": when the limit resets and whether the board sends "continue" then (see limit.ts). */
  limit?: LimitHit | null;
  /** Per-run spending cap for this ticket, overriding the board's: a positive amount, 0 for none. Missing/null: the board's. */
  runCapUsd?: number | null;
  /** The last run stopped at its spending cap (outcome "blocked"); cleared when the next run starts. */
  capHit?: { capUsd: number; at: string } | null;
  /** Cap for the next run only ("Continue with +$Y"), then cleared. */
  capNextUsd?: number | null;
  /** false: the user turned automatic continues off for this ticket ("Don't auto-continue"). Missing: on. */
  autoContinue?: boolean;
  /** Automatic continues sent on day (local YYYY-MM-DD), for the per-day cap. */
  autoContinued?: { day: string; count: number } | null;
  /** Output files the user published as claude.ai pages from the Outputs tab, one link per file. */
  shareLinks?: ShareLink[];
  /** Teammate cards in this ticket's chat (propose_teammate) the user answered, by entry uuid (the tool_use id). */
  teammateCards?: Record<string, TeammateCardState>;
  /** Squad cards in this ticket's chat (propose_squad) the user answered, by entry uuid (the tool_use id). */
  squadCards?: Record<string, SquadCardState>;
  /** Automation cards in this ticket's chat (propose_automation) the user saved, by entry uuid: the automation made. */
  automationCards?: Record<string, { loopId: string; at: string }>;
  /**
   * Key boxes in this ticket's chat (ask_keys) the user answered, by entry uuid (the tool_use id): the names saved, or
   * self when they chose to do it themselves. Never the values.
   */
  keyCards?: Record<string, KeyCardState>;
  /**
   * Question forms in this ticket's chat closed without an answer, by entry uuid (only the form open at the time): the
   * user's Close question, or by: "task" when they answered in the task the form was about. A close made for the last
   * run (run: its runEndedAt) means the ticket no longer waits on the user (askClosed).
   */
  closedForms?: ClosedForms;
  /** Made by Automations → Set up with Claude: its Planning chat sets up an automation instead of shaping a ticket. */
  automationSetup?: boolean;
  /** Made by Schedules → Proactive check-ins: its Planning chat sets up a quiet check-in schedule (checkin-guides.ts). */
  checkinSetup?: boolean;
  createdAt: string;
  updatedAt: string;
  body: string;
}

/** A tool ticket's result as a card in its parent's chat (see main-ticket.ts). */
/** A grey note the board adds to a main ticket's chat without waking its Claude. */
export interface BoardNote {
  at: string;
  /** The tool ticket it is about. */
  ticketId: string;
  text: string;
}

/** How many board notes a ticket keeps. */
export const BOARD_NOTES_KEEP = 30;

export interface ResultCard {
  at: string;
  ticketId: string;
  title: string;
  kind?: string | null;
  outcome: string;
  verdict?: "passed" | "problem" | null;
  summary: string;
  /** Its outputs/report.md, or null when it wrote none. */
  report: string | null;
  model?: string | null;
  costUsd?: number | null;
  /** Files it changed in the project folder itself (a folder without version history). */
  folderFiles?: number | null;
}

/** A pending follow-up: at dueAt the board wakes the ticket's conversation with the note (followup.ts). */
export interface FollowUp {
  dueAt: string;
  /** Why, and what to do then; written by Claude for its future self, shown on the card. */
  note: string;
  /** A message the user types in the ticket chat cancels it. */
  cancelOnReply: boolean;
  setAt: string;
  /** Seen more than FOLLOW_UP_LATE_MS late (computer asleep, board off): not woken; it waits for the user. */
  missedAt?: string | null;
}

export interface FollowUpLogEntry {
  at: string;
  /** set / woke: Claude set one / the board woke it. cancelled: the user stopped it or Claude stopped following up.
   *  replied: the user wrote in the chat while one was pending. missed: it was too late to wake. */
  kind: "set" | "woke" | "cancelled" | "replied" | "missed";
  /** set: due time. woke: when it was due. */
  dueAt?: string;
  note?: string;
  /** Who cancelled it, and why. */
  by?: "user" | "claude" | "reply";
  /** woke: the run's number in the activity log, and its cost once it ended. */
  run?: number;
  costUsd?: number;
}

/** A run hit the Claude usage/spend limit. */
export interface LimitHit {
  /** When the limit resets (from the message, else the next full hour). */
  resetAt: string;
  /** The board sends "continue" at resetAt + 1 minute. */
  auto: boolean;
  /** Auto is off because the ticket already used its automatic continues today. */
  capped?: boolean;
  /** When the run hit it. */
  at: string;
  /** Claude's limit message, as shown in the run. */
  message: string;
}

export interface PrCheck {
  name: string;
  state: "pass" | "fail" | "pending" | "skipped";
  /** Details page (an Actions job log for GitHub Actions checks). */
  url: string | null;
  /** When it finished, or started while running. */
  at: string | null;
}

/** One of a ticket's PRs, with its last known state (null: not fetched yet) and target branch. */
export interface TicketPr {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  base?: string | null;
}

/** A ticket's pull request as `gh pr view` last reported it (see prstatus.ts). */
export interface PrStatus {
  url: string;
  number: number | null;
  state: "OPEN" | "MERGED" | "CLOSED" | null;
  checks: PrCheck[];
  failing: number;
  pending: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  conflicts: boolean;
  mergeStateStatus: string | null;
  /** The branch it merges into; missing on statuses cached before the board read it. */
  base?: string | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or null when no review is required. */
  reviewDecision: string | null;
  comments: number;
  fetchedAt: string;
}

/** What the user did with a proposed teammate: saved it (as `name`, for all boards or this board) or dismissed it. */
export interface TeammateCardState {
  state: "saved" | "dismissed";
  name?: string;
  scope?: "global" | "board";
  at: string;
}

export interface ShareLink {
  /** Path relative to the outputs folder. */
  file: string;
  url: string;
  at: string;
}

export interface BranchPoint {
  at: string;
  /** Source title at branch time (shown if the source is deleted later). */
  sourceTitle: string;
}

/** Where a ticket came from: the item in the other service (e.g. a Linear issue) and the automation that made it. */
export interface TicketSource {
  /** Display name of the service. */
  provider: string;
  label: string;
  /** "" when the item had no link. */
  url: string;
  loopId: string;
}

/** Columns an automation may put its tickets in. Planning and Ready start Claude by themselves (see Loop.autoStart). */
export type LoopColumn = "backlog" | "planning" | "ready";

/**
 * An automation of one board: a check script the board runs on a timer, without Claude. Each item it finds for the
 * first time becomes a ticket. The script file sits next to this one (loops/<id>.sh), pinned by its hash.
 */
export interface Loop {
  /** Format of this file; a loop with a newer one is shown as unsupported and left alone. */
  version: number;
  id: string;
  name: string;
  enabled: boolean;
  /** Display name of what it watches ("Linear"): the card's link and the outside-content label say it. */
  service: string;
  /** Board passes (automation-passes.json) its script may use. */
  passes: string[];
  /** sha256 of the script when the user saved it: a script changed since then doesn't run. */
  scriptHash: string;
  everyMinutes: number;
  column: LoopColumn;
  /** The user switched on that its tickets start Claude by themselves (Planning or Ready). */
  autoStart: boolean;
  /** Claude looks at each new item first (a side call with no tools) and decides whether it needs a ticket. */
  askClaude: { on: boolean; prompt: string };
  /** Ticket description with {{title}}, {{link}}, {{service}}; the copied text is added below as a fenced block. */
  instructions: string;
  /** The tools `ckanban call` may use, learned from the first check after a save. Null: not learned yet. */
  allowedTools: string[] | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  lastFiredAt: string | null;
  /** Why the last check failed (cleared by the next good one). */
  lastError: string | null;
  /**
   * The feature each new ticket goes into as a task: a main ticket's id or one of its groups'. Null/missing: each gets
   * its own card (older automations). A gone feature, or one that isn't a feature: its own card, and the check says why.
   */
  partOf?: string | null;
}

/** An item of the last check, for the editor's "Last check found". */
export interface LoopSeenItem {
  id: string;
  title: string;
  link?: string;
  /**
   * new: became a ticket; added: went into the ticket of its thread (Item.thread); waiting: its thread's ticket can't
   * take it now, it stays unseen and goes in at a later check; skipped: Claude said no ticket; seen: found before;
   * first: found by the first check.
   */
  state: "new" | "added" | "waiting" | "skipped" | "seen" | "first";
  ticketId?: string;
  note?: string;
}

/** What a loop remembers between checks (loops/<id>.state.json). */
export interface LoopState {
  /** Every item id it has found, kept for good: the same item never makes a second ticket, also after a restart. */
  seen: string[];
  /** False until the first check after it was switched on: that check only notes what is already there. */
  primed: boolean;
  failures: number;
  backoffUntil: string | null;
  lastFound: number;
  lastItems: LoopSeenItem[];
  /**
   * Thread (Item.thread) -> the ticket its first item made; later items of the thread go into that ticket. An entry
   * whose ticket was deleted is dropped (its next item makes a new ticket). Missing in state saved before threads: {}.
   */
  threads?: Record<string, string>;
}

/** Recurring ticket template: on each cron tick the board creates a ticket from it and runs it. */
export interface Schedule {
  id: string;
  name: string;
  /** Ticket title; `{date}` and `{time}` are filled in when it fires. */
  title: string;
  /** Ticket description (the prompt). */
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  /** Skip a fire while the previous ticket from this schedule is still queued or running. */
  skipIfRunning: boolean;
  /**
   * Quiet when nothing needs the user: a run that ends with "quiet": true in its result line (and made no ticket) is
   * removed by the board and leaves one "quiet" line in the history. Its runs are told which tickets it raised are
   * still open. Missing on older schedules (off).
   */
  quiet?: boolean;
  /** Model for the tickets it creates (e.g. "sonnet"); null/missing: the board's model. */
  model?: string | null;
  /** Tags every ticket it creates gets. Missing on older schedules. */
  tags?: string[];
  /**
   * The feature each run goes into as a task: a main ticket's id or one of its groups'. Null/missing: each run gets
   * its own card (older schedules). A gone or finished feature: the run gets its own card and the history says why.
   */
  partOf?: string | null;
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  /** Null while paused. */
  nextRunAt: string | null;
  /** Why the last fire could not create its ticket (cleared by the next successful fire). */
  lastError: string | null;
}

/** What a one-time job does when it fires. */
export type JobAction =
  /** Create a ticket and start it right away (like a schedule's fire). */
  | { kind: "ticket"; title: string; body: string; mode: TicketMode }
  /** Run a shell command in the board folder: no ticket, no Claude. */
  /** ifLate: what to do when the board sees it more than 10 min late (computer off): skip it (default) or run it anyway. */
  | { kind: "command"; command: string; timeoutSec?: number; ifLate?: "skip" | "run" };

/** scheduled → running → done | failed; or cancelled, skipped (a command job that was due while the computer was off). */
export type JobState = "scheduled" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface JobResult {
  /** Ticket the job created (ticket action). */
  ticketId?: string;
  /** Command action: exit code (null when it was killed), how long it took, the last 4 KB of its output. */
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  timedOut?: boolean;
  /** Why it failed, in plain words. */
  message?: string;
}

/** Fires once at `at`: creates and starts a ticket, or runs a command (jobs.ts). */
export interface Job {
  id: string;
  name: string;
  /** ISO time it is due. */
  at: string;
  action: JobAction;
  state: JobState;
  /** Ticket whose board run scheduled it; null when the user or CLI did. */
  sourceTicketId: string | null;
  createdAt: string;
  updatedAt: string;
  firedAt: string | null;
  result: JobResult | null;
}

export type ScheduleTrigger = "schedule" | "missed" | "manual";

/** Who changed a schedule: the user (board UI, CLI, Claude outside a run) or the board run of a ticket. */
export type ScheduleEditor = "user" | { ticketId: string };

export type ScheduleEditAction = "created" | "updated" | "paused" | "resumed";

/** Fields whose old value an "updated" entry keeps, so a bad edit (e.g. a run rewriting its own prompt) can be undone. */
export type SchedulePrevious = Partial<Pick<Schedule, "title" | "body" | "cron">>;

export type ScheduleHistoryEntry =
  /** note: why the run went somewhere else than the schedule says (e.g. its feature is gone, so it got its own card). */
  | { at: string; kind: "fired"; trigger: ScheduleTrigger; ticketId: string; note?: string }
  | { at: string; kind: "skipped"; trigger: ScheduleTrigger; ticketId: string | null }
  | { at: string; kind: "error"; trigger: ScheduleTrigger; message: string }
  /** A quiet schedule's run found nothing for the user: the board removed its ticket (ticketId, now gone). */
  | { at: string; kind: "quiet"; ticketId: string; summary: string; costUsd: number }
  | { at: string; kind: "edited"; action: ScheduleEditAction; fields: string[]; by: ScheduleEditor; previous?: SchedulePrevious };

export interface Interrupted {
  at: string;
  mode: "refine" | "act";
  /** A reply to another ticket's Claude: the card stays as it was. */
  quiet?: boolean;
  /** What Claude had written of its reply when it was cut off (shown greyed until the resumed reply arrives). */
  partial?: string;
  /** Claude never got this prompt (cut off during setup, or held while a restart waited): send it again as is. */
  prompt?: { text: string; raw?: boolean };
  /** Held back while a restart waited, not cut off: resumed without the interruption note. */
  held?: boolean;
  /** The reply answers a message the user typed (see ActiveRun.chat.user); the resumed run keeps its rights. */
  user?: boolean;
}

/** A chat message that came from Telegram. */
export interface TelegramIn {
  updateId: number;
  /** The user's Telegram message (a reply to it answers them). */
  tg: number;
  chatId: number;
  at: string;
  /** What was sent (the chat matches it to the conversation's message). */
  text: string;
  /** The wait it answered, if any. */
  key?: string | null;
}

/** A ticket's reply sent back to Telegram. */
export interface TelegramOut {
  at: string;
  /** The start of the reply (the chat matches it to Claude's message). */
  text: string;
  replyTo: number;
}

/** A key box (ask_keys) the user answered: what was saved (names only). */
export interface KeyCardState {
  saved: string[];
  /** "I'll do it myself". */
  self?: boolean;
  at: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  at: string;
  /** queued: Claude reads it at its next step. unsent: the run was stopped first; the user sends or discards it. */
  state: "queued" | "unsent";
  /**
   * From another session (a huddle's messages): sent as-is, without the ticket-chat note, and
   * a reply run it starts leaves the card, outcome and run count alone.
   */
  peer?: boolean;
  /** Sent by a planner's run (chat_ticket), not typed by the user: the reply run gets no planner rights of its own. */
  fromPlanner?: boolean;
  /** Sent by another ticket's Claude (chat_ticket): which one. The chat shows it with that ticket's name, not as the user's. */
  from?: { ticketId: string; title: string };
  /** A later item of an automation's thread (Board.automationItem): which automation. Never the user's; shown with its name. */
  automation?: { loopId: string; name: string };
  /**
   * The text is a slash command Claude Code runs itself (see commands.ts): sent alone, without the board's note.
   * local: a built-in that runs without a model turn (/compact), so Claude never echoes it back.
   */
  slash?: "prompt" | "local";
  /** From the ticket's own auto huddle (findings, the budget brake) or a freed auto-huddle slot: sent as-is, run as its work. */
  hostWake?: boolean;
  /** The board's follow-up wake (followup.ts): sent as-is; the card goes back to its column afterwards. */
  followUp?: boolean;
  /** Came from Telegram (a reply to an alert): the update, so a restart never sends it twice. */
  telegram?: { updateId: number; tg: number };
  /**
   * Never handed to a run already going: it starts the next one (a new claude process). Keys saved in the ask_keys box
   * reach Claude this way, since a running process keeps the environment it started with.
   */
  nextRun?: boolean;
}

export interface Comment {
  id: string;
  author: "user" | "ai";
  text: string;
  at: string;
  /** A note another ticket's run left (author ai): that ticket's id. The next run of this ticket gets it, labelled. */
  from?: string;
}

export interface Config {
  port: number;
  prPollMinutes: number;
  /** Loopback port `tailscale serve` points at for phone access (default port + 1, see remote.ts). */
  remotePort?: number;
}

export interface OutputFile {
  name: string;
  size: number;
  updatedAt: string;
}

export interface ActivityEntry {
  run: number;
  at: string;
  event: any;
}

export type PlanState = "running" | "paused" | "finishing" | "done" | "stuck";

/** A planner's unattended run of its child tickets (see plan.ts and Board.advancePlans). */
export interface Plan {
  state: PlanState;
  /** Old plan files may still carry maxConcurrent (a past "at once" limit); it is ignored: every ready child starts. */
  /** Times the planner's Claude session was woken up (capped, see plan.ts). */
  wakeups: number;
  startedAt: string;
  finishedAt?: string | null;
  /** Children when the plan started; the planner may add up to the same number again. */
  originalCount: number;
  /** Child events waiting for the planner's next wake-up, so several arrive as one message. */
  inbox?: string[];
  /** Last child state the planner was told about, per child id, so it is told once. */
  seen?: Record<string, string>;
  /** Planner restarts of a child that already ran, per child id (capped). */
  retries?: Record<string, number>;
  /** The planner was woken and its reply decides what happens next. */
  awaiting?: "event" | "final" | null;
  /** Why the plan is stuck. */
  reason?: string | null;
  /** A main ticket's plan (main-ticket.ts): the family at the last wake, and wakes in a row since it last changed. */
  progressSig?: string | null;
  noProgress?: number;
}

// ---- Huddles: several Claude sessions working on one ticket in a shared message room (see huddle.ts) ----

export type HuddleStatus = "live" | "stopped" | "closed";
/**
 * Why a huddle stopped by itself (none: the user stopped it). budget: maxCostUsd spent. messages: maxMessages posted.
 * loop: too many messages without the user (routing paused, runs keep going).
 */
export type HuddleStopReason = "budget" | "messages" | "loop";
/** tagged: sleeps until @mentioned. monitor: every new message reaches its live session at its next turn boundary. */
export type HuddleMode = "tagged" | "monitor";
/** shared: the host ticket's folder (read-only agents: a snapshot of it). own: a copy of its own (see huddle-copies.ts). */
export type HuddleWorkspace = "shared" | "own";

/**
 * A helper's own copy of the host ticket's folder: a git worktree on its own branch (a repo with commits) or a plain
 * copy of the folder. fresh: make it again from the host folder at the next run (after a conflict).
 */
export interface HelperCopy {
  kind: "git" | "folder";
  dir: string;
  /** git: the repo the worktree belongs to, and its branch. */
  repo?: string | null;
  branch?: string | null;
  at: string;
  fresh?: boolean;
}

/** One file of a hand-in, with the sha1 of its bytes when the copy was made (base) and as handed in (hash); null: no such file. */
export interface HandInFile {
  path: string;
  change: "added" | "changed" | "removed";
  base: string | null;
  hash: string | null;
}

/**
 * Changes a helper handed in from its copy (huddle_hand_in). A lead, @main or the user accepts them (into the host
 * ticket's folder) or rejects them; conflict: the host folder changed some of the same files, nothing was applied.
 */
export interface HandIn {
  id: string;
  from: string;
  summary: string;
  files: HandInFile[];
  status: "waiting" | "accepted" | "rejected" | "conflict";
  at: string;
  /** Who accepted or rejected it, when, and why (reject). */
  by?: string | null;
  decidedAt?: string | null;
  reason?: string | null;
  conflicts?: string[];
}
/** done: finished its job, only a lead, @main or the user wakes it again. blocked: waiting on something (statusReason). */
export type HuddleParticipantStatus = "working" | "idle" | "stopped" | "failed" | "done" | "blocked";
/** agent: a headless session the huddle runs. ticket-main: a ticket's own session (the host's is @main). human: the user (@you). */
export type HuddleParticipantKind = "agent" | "ticket-main" | "human";

export interface HuddleParticipant {
  /** Unique in the huddle, used in @mentions: main, reviewer, qa-1, api-main, you. */
  handle: string;
  role: string;
  /** Preset it was made from (see huddle-presets.ts) and that preset's prompt. */
  preset: string | null;
  prompt: string;
  /** What this participant should look at (from the roster). */
  focus?: string;
  model: string | null;
  mode: HuddleMode;
  /** May add participants and manage findings. The coordinator (@main) always may. */
  lead: boolean;
  /** May change files: the coordinator in the host's folder; an agent in its own copy (workspace own), handing them in. */
  canEdit: boolean;
  workspace: HuddleWorkspace;
  /**
   * workspace own: its worktree and branch, once made. A read-only agent in the shared workspace: its detached
   * snapshot worktree at the host branch's HEAD (branch stays null), refreshed at every wake.
   */
  worktree?: string | null;
  branch?: string | null;
  /** Read-only snapshot: the host branch and the commit it shows (see huddle.ts snapshot()). */
  snapshot?: { branch: string | null; sha: string } | null;
  /** May change files: its own copy of the host's folder, once made (older huddles: worktree and branch above). */
  copy?: HelperCopy | null;
  /** Its own Claude session (agents only; a ticket-main uses its ticket's session). */
  sessionId: string | null;
  sessionStarted?: boolean;
  status: HuddleParticipantStatus;
  /** done / blocked: why, as the participant said it (huddle_status or huddle_post). */
  statusReason?: string | null;
  kind: HuddleParticipantKind;
  /** ticket-main: the ticket whose session this is. */
  ticketId?: string | null;
  /** seq of the last message it was given (or posted); later ones are unread. */
  cursor: number;
  joinedAt: string;
  lastActivity?: string | null;
  /**
   * What its runs cost so far, and the session's running total at its last result (results carry running totals).
   * Agents: every run. The coordinator (@main): the runs the huddle woke it for.
   */
  costUsd?: number;
  sessionCostUsd?: number;
  /**
   * Its conversation's size at its latest step (input + cache read + cache write tokens of the last assistant
   * message): what Claude re-reads every step. Agents: their own session; a ticket-main: its ticket's session.
   */
  contextTokens?: number;
  error?: string | null;
  /** When its last run or turn ended (the huddle's idleSince). */
  idleAt?: string | null;
  /** A daemon restart cut its turn off (or held it back while a restart was pending): recover() resumes it. */
  interrupted?: boolean;
  /** Secret the agent's run proves its identity with (CKANBAN_HUDDLE_AGENT); never sent to clients. */
  token?: string;
}

export interface HuddleFinding {
  id: string;
  text: string;
  by: string;
  status: "open" | "resolved";
  resolvedBy: string | null;
  at: string;
}

export interface Huddle {
  id: string;
  /** Ticket whose work the huddle is about; its session is @main, the coordinator. */
  hostTicket: string;
  status: HuddleStatus;
  maxParticipants: number;
  participants: HuddleParticipant[];
  findings: HuddleFinding[];
  /** Other tickets (same board) whose main session was invited. */
  invited: string[];
  /** Highest message seq so far. */
  seq: number;
  /** Spending limit (all participants' costUsd): at 80% the leads are warned, at 100% the huddle stops (default 20). */
  maxCostUsd?: number;
  /** Non-system messages before the huddle stops (default 150). */
  maxMessages?: number;
  /** Non-system messages so far, and since the user last posted or resumed (agent-only stretch). */
  posts?: number;
  sinceUser?: number;
  /** The 80% budget warning went out. */
  budgetWarned?: boolean;
  /** Two participants who kept answering each other: they no longer wake each other until a lead, @main or the user tags them, or Resume. */
  held?: string[] | null;
  /** Tags that didn't wake their target (done, blocked or stopped), noted once each: target handle -> senders. Cleared when the target wakes. */
  unwoken?: Record<string, string[]>;
  /** Seq of the last non-system message the idle watchdog already woke @main about. */
  idleNudged?: number;
  stopReason?: HuddleStopReason | null;
  /** The budget stopped it after its work was finished (a close request was open, or it was quiet): Close is the next step, not Resume. */
  finishedAtStop?: boolean;
  /** @main or a lead asked the user to close the huddle (huddle_close); only the user closes it. */
  closeRequest?: { by: string; at: string; reason: string } | null;
  /** Pinned brief (goal, decisions) the leads, @main and the user keep current; it heads every digest. */
  brief?: { text: string; by: string; at: string } | null;
  /** Template (squad) the huddle was started from (see huddle-templates.ts). */
  template?: string | null;
  /** What this huddle is about, as given when a squad was started (else the host ticket's title and description). */
  topic?: string | null;
  /** The squad's host rules when it started (later edits to the squad don't change a running huddle). */
  hostRules?: string | null;
  /** Started by the host ticket's unattended run (start_huddle), with its reason; @main may close it itself. */
  auto?: { reason: string } | null;
  /**
   * Handle of the lead that runs the huddle (the host): it gets the idle watchdog, the "wasn't woken" notes, the budget
   * warnings and the hand-ins instead of @main, while it isn't stopped, blocked, failed or done (see activeHost).
   * Null or missing: @main runs it.
   */
  host?: string | null;
  /** Lessons agents proposed when they turned done; only the user saves them as role notes (see huddle-notes.ts). */
  learnings?: HuddleLearning[];
  /** Changes helpers handed in from their copies, oldest first. */
  handIns?: HandIn[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
}

/**
 * A lesson an agent proposed with huddle_status done. target: where it goes when saved, "_all" (every role), a preset
 * name, or "new" (a new board preset made from the agent's ad-hoc role); once saved, the preset it went to.
 */
export interface HuddleLearning {
  id: string;
  from: string;
  role: string;
  preset: string | null;
  text: string;
  evidence: string;
  scope: "general" | "repo";
  status: "pending" | "saved" | "discarded";
  target: string;
  at: string;
  /** Saved as the first note of a new preset made from the ad-hoc role. */
  newRole?: boolean;
  /**
   * A teammate the agent proposed (propose_teammate) instead of a lesson: text is its why, scope general saves it for
   * all boards, repo for this board; once saved, target is its name.
   */
  teammate?: TeammateProposal;
  /** A squad the agent proposed (propose_squad): text is its why; once saved, target is the squad's name. */
  squad?: SquadProposal;
}

/** handin: a helper handed in changes (handIn: its id); the chat shows it as a card. */
export type HuddleMessageKind = "message" | "finding" | "system" | "handin";
/** Where a post came in from: the board UI, the MCP server or CLI (BoardClient), or a request with neither header (e.g. curl). */
export type HuddleSource = "ui" | "mcp" | "none";

export interface HuddleMessage {
  id: string;
  seq: number;
  ts: string;
  /** Handle of the sender, stamped by the daemon from the calling run's identity (never from tool input). "system" for system messages. */
  from: string;
  text: string;
  /** Handles mentioned with @handle; "all" for @all. */
  mentions: string[];
  kind: HuddleMessageKind;
  /** Posts only (system messages have none). */
  source?: HuddleSource;
  /** kind handin: the hand-in's id. */
  handIn?: string;
}

/** The spending cap a ticket's next work run gets (claude --max-budget-usd), or null for none. */
export function runCapFor(t: Pick<Ticket, "runCapUsd" | "capNextUsd">, p: Pick<Profile, "runCapUsd"> | null | undefined): number | null {
  const pos = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
  if (pos(t.capNextUsd)) return t.capNextUsd!;
  if (t.runCapUsd === 0) return null;
  return pos(t.runCapUsd) ?? pos(p?.runCapUsd);
}
