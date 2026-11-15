import { run as runCmd } from "../runs/git";
import { AUTO_CONTINUE_PER_DAY, clockTime, CONTINUE_TEXT, dayKey, parseReset } from "../usage/limit";
import { DEFAULT_STALL_MINUTES } from "../runs/runner";
import { type LimitHit, type Profile, type Ticket } from "../core/types";
import { nowIso } from "../core/util";
import type { Board } from "./board";

/** The watchdog time for this board's runs in ms (0: off). */
export function stallMs(this: Board, profile: Profile): number {
  if (this.opts.stallMs !== undefined) return this.opts.stallMs;
  const m = profile.stallMinutes ?? DEFAULT_STALL_MINUTES;
  return m > 0 ? m * 60_000 : 0;
}

/**
 * The Inbox's answer to a stalled run. stop: as Stop. wait: clear the flag, the watchdog counts again. restart: stop the
 * stuck process and resume the same session.
 */
export function stallAction(this: Board, slug: string, id: string, action: "stop" | "wait" | "restart"): Ticket {
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

export function now(this: Board): Date {
  return this.opts.now?.() ?? new Date();
}

/** A run stopped at its spending cap: blocked until the user continues it with more budget (continueAfterCap). */
export function capReached(this: Board, slug: string, id: string, base: Partial<Ticket>, cap: number, withWorkflows?: number): void {
  const msg = `Stopped at $${cap.toFixed(2)} cap`;
  const why = withWorkflows === undefined
    ? "this run spent its budget before it finished"
    : `this run and its workflow's helper agents spent $${withWorkflows.toFixed(2)}, so the board stopped the run and its workflow`;
  this.store.addComment(slug, id, "ai", `${msg}: ${why}. Continue it with more budget, or change the ticket's cap in its ⋯ menu.`);
  this.patch(slug, id, { ...base, outcome: "blocked", error: msg, capHit: { capUsd: cap, at: nowIso() } });
}

/** "Continue with +$Y" after a run stopped at its cap: "continue" in the same session, with a cap of addUsd for that run. */
export async function continueAfterCap(this: Board, slug: string, id: string, addUsd: number): Promise<Ticket> {
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
export function limitHit(this: Board, slug: string, id: string, base: Partial<Ticket>, message: string): void {
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
export async function continueAfterLimit(this: Board, slug: string, id: string, opts: { auto?: boolean } = {}): Promise<Ticket> {
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
export function setAutoContinue(this: Board, slug: string, id: string, auto: boolean): Ticket {
  const t = this.store.getTicket(slug, id);
  if (!t) throw new Error(`ticket ${id} not found`);
  const limit = t.limit ? { ...t.limit, auto, capped: undefined } : t.limit;
  const out = this.patch(slug, id, { autoContinue: auto, ...(limit ? { limit } : {}) });
  if (t.parentId) this.advancePlans(slug);
  return out;
}

/** Tickets waiting for a usage limit to reset whose automatic continue is due (see LimitWatcher). */
export function dueContinues(this: Board, slug: string, delayMs: number): string[] {
  const now = this.now().getTime();
  return this.store.listTickets(slug)
    .filter((t) => t.outcome === "limit" && t.limit?.auto && !this.isRunning(slug, t.id) && t.status !== "done"
      && new Date(t.limit.resetAt).getTime() + delayMs <= now)
    .map((t) => t.id);
}
