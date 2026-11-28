import type { AutomationProposal, Loop, LoopInput, LoopTest, Pass } from "../../../features/schedules/automationTypes";
import type { Status } from "../../../features/board/columns";
import type { JobState } from "../../../features/schedules/jobText";
import type { Outcome, TicketMode } from "./ticket";

/** What the user did with a teammate card. */
export interface ScheduleDeleteCardState {
  state: "deleted" | "kept";
  at: string;
  /** The schedule's name when it was deleted. */
  name?: string;
  /** The schedule it deleted (another card for the same schedule names it from here once it is gone). */
  scheduleId?: string;
}

export type { AutomationProposal, Loop, LoopColumn, LoopInput, LoopSeenItem, LoopTest, Pass } from "../../../features/schedules/automationTypes";

export interface Schedule {
  id: string;
  name: string;
  title: string;
  body: string;
  mode: TicketMode;
  cron: string;
  enabled: boolean;
  skipIfRunning: boolean;
  /** Tags every ticket it creates gets. */
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  lastFiredAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  /** Plain-English cron, e.g. "Weekdays at 09:00". */
  summary: string;
  /** Its previous ticket is still queued or running. */
  active: boolean;
  /** Quiet when nothing needs the user: runs that find nothing are removed, leaving a line in the history. */
  quiet?: boolean;
  /** Model for its runs (e.g. "sonnet"); null: the board's. */
  model?: string | null;
  /** The feature (main ticket or one of its groups) each run goes into as a task; null: each run gets its own card. */
  partOf?: string | null;
  /** That ticket's title (null: it no longer exists). */
  partOfTitle?: string | null;
  /** What it spent over the last 7 days, in USD (list only). */
  spend7dUsd?: number;
  /** Quiet checks per local day, newest first (list only). */
  quietPerDay?: { day: string; count: number }[];
  /** Paused only, from its last "paused" edit (list only): when, and by the user or Claude in a ticket (title null: deleted). */
  pausedAt?: string;
  pausedBy?: "user" | { ticketId: string; title: string | null };
}

/** What a one-time scheduled job does when it runs (src/schedules/jobs.ts). */
export type JobAction =
  | { kind: "ticket"; title: string; body: string; mode: TicketMode }
  | { kind: "command"; command: string; timeoutSec?: number; ifLate?: "skip" | "run" };

export type { JobState } from "../../../features/schedules/jobText";

export interface JobResult {
  ticketId?: string;
  exitCode?: number | null;
  durationMs?: number;
  output?: string;
  timedOut?: boolean;
  message?: string;
}

/** Runs once at `at`: starts a ticket or runs a command. sourceTicketId: the ticket whose run scheduled it (null: the user). */
export interface Job {
  id: string;
  name: string;
  at: string;
  action: JobAction;
  state: JobState;
  sourceTicketId: string | null;
  /** The scheduling ticket's title (saved with the job, so it stays once that ticket is deleted). */
  sourceTicketTitle?: string;
  /** In views: the scheduling ticket was deleted since (the job still runs at its time). */
  sourceGone?: boolean;
  /** The last change, cancel or run now, when a board run (not the user) made it. */
  changedBy?: { ticketId: string; action: "changed" | "cancelled" | "run now"; at: string };
  createdAt: string;
  updatedAt: string;
  firedAt: string | null;
  result: JobResult | null;
}

export type ScheduleInput = Pick<Schedule, "name" | "title" | "body" | "mode" | "cron" | "skipIfRunning" | "tags" | "quiet" | "model" | "partOf">;

export type ScheduleTrigger = "schedule" | "missed" | "manual";

export type ScheduleHistoryItem = { at: string } & (
  /** note (fired): why the run went somewhere else than set, e.g. its feature is gone so it got its own card. */
  | { kind: "fired" | "skipped"; trigger: ScheduleTrigger; ticketId: string | null; note?: string }
  | { kind: "error"; trigger: ScheduleTrigger; message: string }
  /** A quiet run found nothing: the board removed its ticket. */
  | { kind: "quiet"; ticketId: string; summary: string; costUsd: number }
  /** by: who changed it (a ticket = Claude in that ticket's run). previous: old title/prompt/cron. */
  | {
      kind: "edited"; action: "created" | "updated" | "paused" | "resumed"; fields: string[];
      by: "user" | { ticketId: string }; previous?: { title?: string; body?: string; cron?: string };
    }
) & { ticket: { id: string; title: string; status: Status; outcome: Outcome; running: boolean } | null };

export interface CronPreview {
  valid: boolean;
  error: string | null;
  summary: string | null;
  next: string[];
}
