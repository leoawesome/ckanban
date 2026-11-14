import type { QuietContext } from "./prompts";
import type { Schedule, ScheduleHistoryEntry, Ticket } from "./types";

// Quiet schedules (Schedule.quiet): a run that finds nothing for the user ends with "quiet": true and the board
// removes its ticket, leaving one line in the schedule's history. Its runs are told what they raised that is still open.

/** Links shown per open ticket. */
const MAX_LINKS = 3;

/** The first few http(s) links in a ticket's description: where the item it raised lives. */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'`\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** What a quiet schedule's run (ticket runId) is told: its previous check and the tickets it raised that are still open. */
export function quietContext(tickets: Ticket[], history: readonly ScheduleHistoryEntry[], scheduleId: string, runId: string): QuietContext {
  const runs = history.filter((e) => (e.kind === "fired" || e.kind === "quiet") && e.ticketId !== runId);
  const open = tickets
    .filter((t) => t.raisedBy?.scheduleId === scheduleId && t.status !== "done")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => ({ id: t.id, title: t.title, status: t.status, createdAt: t.createdAt, links: linksIn(t.body) }));
  return { lastCheckAt: runs.filter((e) => e.kind === "fired").at(-1)?.at ?? null, open };
}

/**
 * Whether a finished run of a schedule's ticket may be removed as quiet: the schedule is quiet, the run said so, and
 * nothing about it needs the user (no ticket it raised, no PR, no auto huddle, no message waiting for it).
 */
export function canEndQuietly(o: {
  schedule: Schedule | null; ticket: Ticket; tickets: Ticket[]; quietResult: boolean; prUrls: string[]; waiting: number;
}): boolean {
  if (!o.schedule?.quiet || !o.quietResult) return false;
  if (o.ticket.scheduleId !== o.schedule.id) return false;
  if (o.prUrls.length || o.ticket.prUrl || o.ticket.autoHuddle || o.waiting > 0) return false;
  return !o.tickets.some((t) => t.raisedBy?.ticketId === o.ticket.id);
}

/** Local day key (YYYY-MM-DD) of an ISO time. */
export const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Quiet checks per local day, newest day first. */
export function quietPerDay(history: readonly ScheduleHistoryEntry[]): { day: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of history) if (e.kind === "quiet") counts.set(day(e.at), (counts.get(day(e.at)) ?? 0) + 1);
  return quietDays(counts);
}

/** quietPerDay from counts already made per day (schedule-history.ts keeps them). */
export function quietDays(counts: ReadonlyMap<string, number>): { day: string; count: number }[] {
  return [...counts].sort((a, b) => b[0].localeCompare(a[0])).map(([d, count]) => ({ day: d, count }));
}

/**
 * A schedule's spend since `since`: its quiet runs (their cost is kept in the history, the tickets are gone) plus the
 * tickets it fired that still exist (costOf reads their logs).
 */
export function scheduleSpend(history: readonly ScheduleHistoryEntry[], since: Date, costOf: (ticketId: string) => number): number {
  const from = since.toISOString();
  let total = 0;
  const seen = new Set<string>();
  for (const e of history) {
    if (e.at < from) continue;
    if (e.kind === "quiet") {
      total += e.costUsd > 0 ? e.costUsd : 0;
      seen.add(e.ticketId);
    }
  }
  for (const e of history) {
    if (e.at < from || e.kind !== "fired" || seen.has(e.ticketId)) continue;
    seen.add(e.ticketId);
    total += costOf(e.ticketId);
  }
  return Math.round(total * 100) / 100;
}

/**
 * When and by whom a paused schedule was paused: its last "paused" edit, unless a later "resumed" undid it.
 * null when the history has no such edit (paused before edits were logged, or created paused).
 */
export function lastPause(history: readonly ScheduleHistoryEntry[]): { at: string; by: "user" | { ticketId: string } } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e.kind !== "edited") continue;
    if (e.action === "resumed") return null;
    if (e.action === "paused") return { at: e.at, by: e.by };
  }
  return null;
}
