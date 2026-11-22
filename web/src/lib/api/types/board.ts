import type { Loop } from "../../../features/schedules/automationTypes";
import type { Status } from "../../../features/board/columns";
import type { TaskModels } from "../../models";
import type { BrowserPick } from "./browsers";
import type { QuickChat, SessionSummary } from "./chat";
import type { McpState } from "./connections";
import type { Huddle, HuddleMessage } from "./huddle";
import type { Job, Schedule } from "./schedules";
import type { Ticket, Workspace } from "./ticket";
import type { DiskSpace, FreeUp } from "./disk";
import type { ClaudeSignInState } from "./claudeSignin";

export type { Status } from "../../../features/board/columns";

export { BOARD_COLUMNS, COLUMNS, waitsForSlot } from "../../../features/board/columns";

export interface Health {
  claude: boolean;
  git: boolean;
  gh: boolean;
  /** Server can run the embedded terminal (Bun ≥ 1.3.5). */
  pty?: boolean;
}

/** A folder's version history: none (plain), git without commits (empty), commits without a remote (local), or a remote. */
export type RepoKind = "plain" | "empty" | "local" | "remote";

export interface VersionHistory {
  /** git is installed (the offer is hidden without it). */
  git: boolean;
  /** Null: the folder doesn't exist or git isn't installed. */
  repo: RepoKind | null;
}

export interface Profile {
  name: string;
  slug: string;
  path: string;
  baseBranch: string;
  /** Ignored (older profiles may still have it): runs start as soon as they are ready. */
  maxParallel?: number;
  model?: string | null;
  /** "Main ticket model": main tickets' runs (their own /model still wins); null: the board's model. */
  mainModel?: string | null;
  /** A cold main or feature chat over this many tokens starts its next turn fresh. Missing: 150,000. */
  freshChatTokens?: number | null;
  effort?: string | null;
  /** Ultracode by default: tickets' work runs plan a workflow of helper agents for every substantial task. */
  ultracode?: boolean;
  /** Default Chrome for its runs: a deviceId from More → Browsers, "ask", or none. */
  chrome?: string | null;
  /** The browsers its runs may use, with notes (wins over chrome when set; see BrowserPick). */
  browsers?: BrowserPick[] | null;
  createdAt: string;
  /** Git-ignored files copied into each new worktree (paths or globs relative to the folder). */
  copyFiles?: string[];
  /** Installs dependencies in a ticket's worktree, only when its Claude asks for it. */
  setupCommand?: string;
  /** Runs in a worktree before it is removed. */
  cleanupCommand?: string;
  /** What auto-detection last found (values equal to it show an "Auto-detected" badge). */
  setupDetected?: SetupDetection | null;
  /** Unattended runs start a review huddle themselves before landing important or risky work. Missing: on. */
  autoHuddles?: boolean;
  /** While this board has work going, the daemon keeps the Mac from idle sleep. Missing: on. */
  keepAwake?: boolean;
  /** Tickets that change the board's folder in place take turns (one at a time). Missing: off, they run at the same time. */
  folderTurns?: boolean;
  /** Spending cap per run in USD for its tickets' work runs; missing/null: none. */
  runCapUsd?: number | null;
  artifacts?: boolean;
  /** The user dismissed the one-time offer to set up proactive check-ins. */
  checkinOfferDismissed?: boolean;
  /** Minutes without output before a run counts as stalled; 0: off. Missing: 20. */
  stallMinutes?: number;
  /** Where new runs work: a worktree per ticket (missing: this) or the project folder itself. */
  workspace?: Workspace;
  /** Connectors from the claude.ai account this board's runs get: "all" (missing), "none" or the names to keep ("Slack"). */
  claudeAiConnectors?: "all" | "none" | string[];
  /** "Task models": model and effort per kind of task, only the kinds changed from the defaults (models.ts KIND_DEFAULTS). */
  taskModels?: TaskModels | null;
  pathExists?: boolean;
  running?: number;
}

export interface SetupDetection {
  at: string;
  copyFiles: string[];
  setupCommand: string;
  setupFrom: string[];
}

/** What the board did to prepare a new worktree before Claude started. */
export interface SetupResult {
  copied: string[];
  missing: string[];
  command: string;
  ok: boolean | null;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  durationMs: number;
}

/** Reusable prompt text, inserted by typing `@name` in a composer. scope: "global" or a board slug. */
export interface Snippet {
  id: string;
  name: string;
  text: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export type SnippetInput = Pick<Snippet, "name" | "text" | "scope">;

export type BusEvent =
  | { type: "ticket.updated"; profile: string; ticket: Ticket }
  | { type: "ticket.deleted"; profile: string; id: string }
  | { type: "activity"; profile: string; id: string; run: number; event: any }
  | { type: "profile.updated"; slug: string; profile: Profile | null }
  | { type: "session.updated"; profile: string; id: string; session: SessionSummary }
  | { type: "draft"; profile: string; id: string; text: string; final?: string }
  | { type: "mcp.updated"; state: McpState }
  | { type: "snippets.updated" }
  | { type: "devices.updated" }
  | { type: "browsers.updated" }
  | { type: "schedule.updated"; profile: string; id: string; schedule: Omit<Schedule, "summary" | "active"> | null }
  | { type: "loop.updated"; profile: string; id: string; loop: Loop | null }
  | { type: "integration.updated" }
  | { type: "job.updated"; profile: string; id: string; job: Job | null }
  | { type: "restart.updated"; pending: boolean; waiting: number }
  | { type: "awake.updated"; held: boolean }
  | { type: "disk.space"; space: DiskSpace }
  | { type: "disk.freeup"; status: FreeUp }
  | { type: "claude-signin.updated"; state: ClaudeSignInState }
  | { type: "helper.updated" }
  | { type: "helper.message"; id: string; level: string; oneLine: string }
  | { type: "messages.updated"; unread: number }
  | { type: "learned.updated"; profile: string | null }
  | { type: "huddle.updated"; profile: string; huddle: Huddle }
  | { type: "huddle.message"; profile: string; huddleId: string; message: HuddleMessage }
  | { type: "huddle.activity"; profile: string; huddleId: string; handle: string; lastActivity: string | null; liveCostUsd?: number; contextTokens?: number }
  | { type: "huddle.session"; profile: string; huddleId: string; handle: string }
  | { type: "chat.updated"; profile: string; id: string; chat: QuickChat | null }
  | { type: "chat.draft"; profile: string; id: string; text: string; final?: string }
  | { type: "chat.activity"; profile: string; id: string; activity: string | null }
  | { type: "context.updated"; profile: string; kind: "ticket" | "chat"; id: string };

/** A ticket on any board, as the ⌘K command bar lists it. */
export interface TicketRow {
  profile: string;
  profileName: string;
  id: string;
  title: string;
  status: Status;
  running: boolean;
  updatedAt: string;
  body: string;
  /** Its last result summary (Claude's last comment), capped. */
  summary: string;
  prUrl: string | null;
  /** A hidden tool ticket: its main ticket, whose card the bar shows instead ("via" this one). */
  mainTicket?: { id: string; title: string } | null;
  via?: string;
}

/** Some of a board's tickets and how many cards the Done column has in all. */
export interface TicketPage { tickets: Ticket[]; doneTotal: number; /** Asked with after: Done's fingerprint down to it (null: not in Done). */ doneHead?: string | null }
