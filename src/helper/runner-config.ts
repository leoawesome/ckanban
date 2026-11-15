// The helper runner's constants, state and status types, and small time helpers (split from runner.ts; runner.ts re-exports them).
import type { BusEvent } from "../core/events";
import type { NotifySettings } from "./notify";
import { type SideCaller } from "../runs/side-call";
import { type Store } from "../core/store";
import { type HelperCore } from "./core";
import { type ItemState } from "./decide";
import { inNight, MORNING_GRACE_MS, nightEnd, type HelperSettings, type Night } from "./settings";
import { type WaitRecord } from "./waits";

/** A new wait waits this long for others before the helper wakes (an asker's urgent mark wakes it at once). */
export const BATCH_MS = 60_000;
/** Waits the helper can only put in a summary unless the asker marks them urgent: no paid wake while it can't send one. */
export const ROUTINE_KINDS: ReadonlySet<string> = new Set(["review", "reply", "proposal", "huddle"]);
/** No wake sooner than this after the last run. */
export const LOOP_GUARD_MS = 60_000;
/** Failed runs in a row before waits go out directly with one pause message. */
export const FAIL_LIMIT = 3;
/** Retry after a failed run: 1, 2, 4, 8, 16, then 30 minutes. */
export const backoffMs = (failures: number) => Math.min(30, 2 ** Math.max(0, failures - 1)) * 60_000;
/** A run that takes longer is killed and counts as failed. */
export const RUN_TIMEOUT_MS = 90_000;
/** Keep the Mac awake when a wake or a reminder is due within this long. */
export const AWAKE_AHEAD_MS = 15 * 60_000;
/** An urgent alert that reached no channel and has no later step: the helper looks again this soon. */
export const URGENT_RETRY_MS = 5 * 60_000;
export const RUNS_KEEP = 50;
/** A wait whose snooze ended early with its safety-net times further off than this gets them back from now. */
export const UNSNOOZED_MAX_MS = 24 * 3600_000;
/** The helper looks at held items this long before the board's 4-hour digest would send them. */
export const DIGEST_LEAD_MS = 5 * 60_000;

/**
 * When the helper looks at held items due a digest soon (`before`: 5 minutes before it). At night, or within the
 * morning grace after a night (a digest the night moved), it looks when the night ends: the morning summary goes
 * first, and the user isn't woken.
 */
export function lookBeforeDigest(before: number, night: Night): number {
  if (inNight(before, night)) return nightEnd(before, night);
  const graceStart = before - MORNING_GRACE_MS;
  return inNight(graceStart, night) ? nightEnd(graceStart, night) : before;
}
export const REACTIONS_KEEP = 20;
/** The practice alert's one reminder comes this long after it. */
export const PRACTICE_REMIND_MS = 60_000;
/** A night wake-up older than this isn't asked about any more. */
export const NIGHT_ASK_MAX_MS = 24 * 3600_000;
/** What Got it / Not urgent on a practice alert says. */
export const PRACTICE_STOPPED = "That stopped the reminder. Real alerts work the same way.";

/** Why an item's reminders had stopped before a Got it, in plain words. */
export const STOPPED_WHY: Record<string, string> = {
  opened: "you opened it", answered: "it was answered", "got-it": "you tapped Got it", "not-urgent": "you tapped Not urgent",
  expired: "their time ran out", off: "the helper was turned off", deleted: "the ticket was deleted", cleared: "it no longer waits on you", closed: "it no longer waits on you",
};

/** Plain names of channels, for the user. */
export const CHANNEL_LABEL: Record<string, string> = { mac: "this Mac", push: "phone", webhook: "ntfy", telegram: "Telegram" };
export const label = (c: string) => CHANNEL_LABEL[c] ?? c;

/** One wake in the helper's log. */
export interface RunLog {
  at: string;
  ok: boolean;
  /** Nothing waited: no model call. */
  skipped?: boolean;
  costUsd?: number;
  model?: string;
  sends?: number;
  log?: string;
  error?: string | null;
  fixes?: string[];
}

export interface RunnerState {
  nextWakeAt: string | null;
  /** When the last model run started, succeeded (start time), failed; when the helper last looked (skips included). */
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastCheckAt: string | null;
  failures: number;
  failReason: string | null;
  pauseSentAt: string | null;
  notes: string;
  helloSentAt: string | null;
  /** The one-time "notifications now come grouped" notice was seen (the screens show it until then). */
  noticeSeenAt: string | null;
  firstUrgentAsked: boolean;
  /** Check-in items already named in a message (key -> when). */
  named: Record<string, string>;
  reactions: { at: string; text: string }[];
  /** The last urgent alert sent at night (the morning message asks whether it was right). */
  nightWokeAt: string | null;
  nightWokeFor: string | null;
  /** The one-time night question went out (the hello asks new installs; an existing install gets its own message). */
  nightNoticeAt: string | null;
  /** The practice alert running now: its one reminder is due at dueAt (reminderId once sent). Never a wait. */
  practice: { messageId: string; dueAt: string; reminderId?: string | null } | null;
  /** Non-urgent board messages stored during the night: they go out when the night ends (oldest first). */
  heldSends: HeldSend[];
  /** The week (its Monday, local day) whose first summary carried the "Last week: ..." recap line. */
  recapWeek?: string | null;
  runs: RunLog[];
}

/** A stored message whose send waits for the end of the night. */
export interface HeldSend {
  messageId: string;
  title: string;
  body: string;
  tag: string;
  /** "pause": dropped instead of sent when the helper works again by then. */
  kind?: "pause";
  /** Carries the night question: Telegram takes it with Yes / Not at night. */
  nightAsk?: boolean;
}

export const emptyState = (): RunnerState => ({
  nextWakeAt: null, lastRunAt: null, lastOkAt: null, lastFailAt: null, lastCheckAt: null, failures: 0, failReason: null, pauseSentAt: null,
  notes: "", helloSentAt: null, noticeSeenAt: null, firstUrgentAsked: false, named: {}, reactions: [], nightWokeAt: null, nightWokeFor: null, nightNoticeAt: null, practice: null, heldSends: [], runs: [],
});

export const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** The helper's log note for what it kept quiet: "Kept quiet: 2 tickets, nothing urgent. They'll be in the next summary, by 12:41." */
export function keptQuietLine(n: number, by: string): string {
  return n === 1
    ? `Kept quiet: 1 ticket, nothing urgent. It'll be in the next summary, by ${by}.`
    : `Kept quiet: ${n} tickets, nothing urgent. They'll be in the next summary, by ${by}.`;
}

/** An urgent alert or one of its reminder steps reached the user about this wait. */
/** What a told mark replaces, to give it back (WaitStore.unclaim). */
export const claimOf = (r: WaitRecord) => ({ key: r.key, toldAt: r.toldAt, toldVia: r.toldVia, fallbackAt: r.fallbackAt, digestAt: r.digestAt });
export const alerted = (r: WaitRecord) => r.reminders.some((x) => x.sentAt && !x.failed && !x.skipped);
/** Steps this wait has used so far (every alert on it counts): the 6-step cap is per wait. */
export const stepsUsed = (r: WaitRecord) => (r.stepsUsed ?? 0) + r.reminders.filter((x) => x.sentAt && !x.skipped).length;

/** A check-in's meeting prep title: "Prep: <meeting> at HH:MM". */
const PREP = /^prep:.*\bat\s+(\d{1,2})[:.](\d{2})\b/i;

/**
 * When a prep item's meeting starts: the day it was raised at HH:MM, or the next day when that is earlier than when
 * it was raised. null when the title names no time.
 */
export function meetingTime(title: string, createdAt: string): number | null {
  const m = PREP.exec(title.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const c = new Date(createdAt);
  let at = new Date(c.getFullYear(), c.getMonth(), c.getDate(), h, min).getTime();
  if (at < c.getTime()) at = new Date(c.getFullYear(), c.getMonth(), c.getDate() + 1, h, min).getTime();
  return at;
}

export interface HelperRunnerDeps {
  root: string;
  store: Store;
  core: HelperCore;
  /** Notification settings (helper on/off, channels). */
  notifySettings: () => NotifySettings;
  sideCall: SideCaller;
  /** Link to a ticket, and to a message's page. */
  link: (slug: string, id?: string) => string;
  messageLink: (id: string) => string;
  /** Until when the ticket is snoozed in the Inbox (null: not snoozed). */
  snoozedUntil?: (slug: string, id: string) => string | null;
  /** The board is on screen on some device. */
  onScreen?: () => boolean;
  /** Phones or other computers phone push reaches (not this Mac). */
  phoneDevices?: () => number;
  /** Offer the calendar and messages check-in (a connection exists and no check-in is set up). */
  checkinOffer?: () => boolean;
  emit?: (e: BusEvent) => void;
  now?: () => number;
}

/** A check-in item the helper may name. */
export interface CheckinItem {
  key: string;
  board: string;
  ticketId: string;
  title: string;
  boardName: string;
  meetingAt: number | null;
  createdAt: string;
}

/** What one wake sees. */
export interface Gathered {
  now: number;
  open: WaitRecord[];
  snoozed: Set<string>;
  checkins: CheckinItem[];
  olderCheckins: number;
  states: Map<string, ItemState>;
  newFeedback: string[];
  anything: boolean;
}

/** The status the screens show (GET /api/helper). */
export interface HelperStatus {
  on: boolean;
  model: HelperSettings["model"];
  night: HelperSettings["night"];
  nightOptIn: boolean | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  nextWakeAt: string | null;
  /** Failing: runs failed in a row and why; paused once that reaches 3 (waits go out directly). */
  failures: number;
  failReason: string | null;
  paused: boolean;
  /** No phone channel works: "I can only reach you on this Mac". */
  onlyMac: boolean;
  /** Show the one-time "notifications now come grouped" notice. */
  notice: boolean;
  /** The status line: "Helper on, checked 2:41, nothing waits on you". */
  line: string;
  /** Problem with the line (red on screen). */
  problem: boolean;
  /** Waiting items the helper tracks (not snoozed). */
  waiting: number;
  /** A helper line per waiting ticket, keyed "<board>/<ticketId>". */
  lines: Record<string, string>;
  /** The message a ticket's line is about (its alert, newest reminder or summary), same keys: the line links to it. */
  lineMsg: Record<string, string>;
  /** What the helper's paid checks cost today (local day): the helper card's "Today: 12 checks, $0.21". */
  today: { checks: number; costUsd: number };
  runs: RunLog[];
}
