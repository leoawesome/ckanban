import { followUpWakePrompt } from "../runs/prompts";
import { run as runCmd } from "../runs/git";
import { FOLLOW_UP_LATE_MS, FOLLOW_UP_NOTE_MAX, FOLLOW_UP_REASON_MAX, FollowUpError, followUpTime, logFollowUp } from "../schedules/followup";
import { formatAt } from "../schedules/jobs";
import { ticketRuns } from "../usage/ticket-usage";
import { type FollowUp, type Ticket } from "../core/types";
import type { Board } from "./board";
import { ConflictError } from "./board-types";

/** follow_up: when Claude (or the user) wants the ticket's conversation woken again; replaces the pending one. */
export function setFollowUp(this: Board, slug: string, id: string, input: { after?: string | null; at?: string | null; note?: string | null; cancelOnReply?: boolean }): Ticket {
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
export function cancelFollowUp(this: Board, slug: string, id: string, by: "user" | "claude", reason?: string | null): Ticket {
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
export function userReplied(this: Board, slug: string, id: string): void {
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

/**
 * The user opened the ticket: the follow-up wake prompt tells Claude when (at most one write per 5 minutes, unless
 * `force`: a helper reminder is pending for it, so this open must count).
 */
export function markSeen(this: Board, slug: string, id: string, force = false): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  const now = this.now();
  if (!force && t.seenAt && now.getTime() - new Date(t.seenAt).getTime() < 5 * 60_000) return t;
  return this.patch(slug, id, { seenAt: now.toISOString() });
}

/** Tickets whose follow-up is due and that are free to take it: not running, queued or waiting (FollowUpWatcher). */
export function dueFollowUps(this: Board, slug: string): string[] {
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
export async function wakeFollowUp(this: Board, slug: string, id: string, opts: { manual?: boolean } = {}): Promise<Ticket> {
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
export async function followUpCost(this: Board, slug: string, id: string): Promise<void> {
  if (!this.store.getTicket(slug, id)?.followUpLog?.length) return;
  const runs = ticketRuns((await this.store.activityDigest(slug, id)).runEntries);
  const t = this.store.getTicket(slug, id);
  if (!t?.followUpLog?.length) return;
  const run = runs.findLast((r) => r.kind === "follow-up");
  const i = t.followUpLog.findLastIndex((e) => e.kind === "woke");
  if (!run || i < 0 || t.followUpLog[i].costUsd !== undefined) return;
  const log = t.followUpLog.map((e, j) => (j === i ? { ...e, run: run.run, costUsd: Math.round(run.costUsd * 10_000) / 10_000 } : e));
  // Claude set no next follow-up and didn't say it stopped (it forgot, the run failed or was stopped): the card says so.
  const said = t.followUp || (t.followUpStopped && t.followUpStopped.at >= t.followUpLog[i].at);
  this.patch(slug, id, { followUpLog: log, ...(said ? {} : { followUpStopped: { at: this.now().toISOString(), reason: "no next follow-up was set" } }) });
}
