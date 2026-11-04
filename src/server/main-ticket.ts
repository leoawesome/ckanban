// Main tickets and tool tickets: pure decisions the board applies (Board in board.ts runs them).
// A main ticket is the conversation the user started: it talks, decides and keeps the feature's status, and never edits
// files. Tool tickets in its family (made by Claude, `tool: true`) explore, build, test and review, unattended, and
// report back to their parent as events and result cards.
import { familyState, groupSummary, type TicketKind } from "../../web/src/family";
import type { CheckIn, Plan, Ticket } from "./types";

/** Model and effort a tool ticket gets from its kind when create_ticket leaves them out. */
export const KIND_DEFAULTS: Record<TicketKind, { model: string; effort: string }> = {
  explore: { model: "claude-sonnet-5-5", effort: "medium" },
  test: { model: "claude-sonnet-5-5", effort: "medium" },
  review: { model: "claude-sonnet-5-5", effort: "medium" },
  build: { model: "claude-opus-5-5", effort: "medium" },
  fix: { model: "claude-opus-5-5", effort: "medium" },
  group: { model: "claude-sonnet-5-5", effort: "low" },
  round: { model: "claude-sonnet-5-5", effort: "low" },
};

export function kindDefaults(kind: string | null | undefined): { model: string; effort: string } | null {
  return kind && kind in KIND_DEFAULTS ? KIND_DEFAULTS[kind as TicketKind] : null;
}

/** Kinds that change files: at most BUILD_LIMIT of one family run at once. */
export const BUILD_KINDS = new Set<string>(["build", "fix"]);
export const BUILD_LIMIT = 2;
/** merge_into_main tries before the tool ticket ends blocked. */
export const MERGE_TRIES = 3;
/** ask_ticket waits this long for an answer, then reports "no answer". */
export const ASK_TIMEOUT_MS = 5 * 60_000;
/** Result cards kept per ticket. */
export const RESULTS_KEEP = 60;
/** No-progress wakes in a row before a main ticket's plan is stuck. */
export const NO_PROGRESS_WAKES = 3;
/** Check-in defaults (board settings checkinUsd / checkinTickets), and the round count that triggers one. */
export const CHECKIN_USD = 25;
export const CHECKIN_TICKETS = 30;
export const CHECKIN_ROUNDS = 3;
/** The tool ticket's report, in its outputs folder. */
export const REPORT_FILE = "report.md";

/**
 * A ticket that runs a family of tool tickets with the plan engine: a main ticket, or a tool ticket that groups others
 * (kind group or round). Its runs may manage that family whoever started them.
 */
export function isManager(t: Pick<Ticket, "main" | "tool" | "kind"> | null | undefined): boolean {
  return !!t && (!!t.main || (!!t.tool && (t.kind === "group" || t.kind === "round")));
}

/** A plan the main-ticket engine runs (finished events, build limit, no-progress and check-in rules). */
export function managedPlan(t: Pick<Ticket, "main" | "tool" | "kind">): boolean {
  return isManager(t);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The "finished" event a parent gets for a tool ticket's result. */
export function finishedLine(t: Pick<Ticket, "id" | "title" | "outcome" | "verdict" | "kind">, summary: string, report: string | null): string {
  const outcome = t.outcome === "needs_input" ? "questions" : t.outcome ?? "done";
  return `finished: ${t.id} "${t.title}"; outcome ${outcome}${t.kind === "test" && t.verdict ? `; verdict ${t.verdict}` : ""}; ` +
    `summary: ${clip(oneLine(summary) || "(none)", 1200)}; report: ${report ?? "no report"}`;
}

/** At most n sentences (ask_ticket's answers). */
export function sentences(text: string, n = 5): string {
  const flat = oneLine(text);
  const parts = flat.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [flat];
  return clip(parts.slice(0, n).join("").trim(), 1500);
}

/**
 * The family table for a main ticket's wake, collapsed: only tool tickets that work, failed or wait, plus one row per
 * group ("Testing round 1: 6 done"). Finished ones are counted in the last line.
 */
export function wakeTable(kids: Ticket[], all: Ticket[], running: (id: string) => boolean): string {
  const lines: string[] = [];
  let finished = 0;
  for (const t of kids) {
    const own = all.filter((c) => c.parentId === t.id || c.partOf === t.id);
    if (own.length || t.kind === "group" || t.kind === "round") {
      const states = own.map((c) => ({ kind: c.kind, state: familyState({ ...c, running: running(c.id) } as any) }));
      const parts = [groupSummary(states)];
      const working = states.filter((s) => s.state === "working").length;
      const failed = states.filter((s) => s.state === "failed").length;
      if (working) parts.push(`${working} working`);
      if (failed) parts.push(`${failed} failed`);
      lines.push(`- ${t.id} ${t.title}: ${parts.join(", ")}${running(t.id) || t.status === "ready" || t.status === "in_progress" ? " (group working)" : ""}`);
      continue;
    }
    const state = familyState({ ...t, running: running(t.id) } as any);
    if (state === "done" || state === "passed" || state === "problem") {
      finished++;
      continue;
    }
    const why = t.outcome === "needs_input" ? "asking a question" : state === "waiting" ? (t.dependsOn?.length ? `waiting for ${t.dependsOn.join(", ")}` : "waiting to start") : state.replace("_", " ");
    lines.push(`- ${t.id} "${t.title}"${t.kind ? ` (${t.kind})` : ""}: ${why}`);
  }
  if (finished) lines.push(`- ${finished} other tool ticket${finished === 1 ? "" : "s"} finished (get_family lists them)`);
  return lines.length ? lines.join("\n") : "- (no tool tickets yet)";
}

/** What the family has: cost so far, tool tickets made and testing rounds. */
export interface FamilyCounts {
  costUsd: number;
  tools: number;
  rounds: number;
}

export interface CheckinLimits {
  usd: number;
  tickets: number;
}

export function checkinLimits(p: { checkinUsd?: number | null; checkinTickets?: number | null } | null | undefined): CheckinLimits {
  const pos = (n: number | null | undefined, d: number) => (typeof n === "number" && n > 0 ? n : d);
  return { usd: pos(p?.checkinUsd, CHECKIN_USD), tickets: pos(p?.checkinTickets, CHECKIN_TICKETS) };
}

const money = (n: number) => `$${n >= 10 ? Math.round(n) : n.toFixed(2)}`;

/** The card's line for a check-in, naming what triggered it ("Round 4 of testing, $25 so far"). */
export function checkinLine(c: FamilyCounts, why: "usd" | "tickets" | "rounds"): string {
  if (why === "rounds" || (c.rounds > 0 && why === "usd")) return `Round ${c.rounds} of testing, ${money(c.costUsd)} so far`;
  if (why === "tickets") return `${c.tools} tool tickets, ${money(c.costUsd)} so far`;
  return `${money(c.costUsd)} so far`;
}

/** A check-in that is now due, or null. base: what the family had at the last check-in (none: nothing). */
export function checkinDue(base: CheckIn | null | undefined, c: FamilyCounts, limits: CheckinLimits): "usd" | "tickets" | "rounds" | null {
  const b = base ?? { costBase: 0, ticketsBase: 0, roundsBase: 0 };
  if (c.rounds - b.roundsBase >= CHECKIN_ROUNDS) return "rounds";
  if (c.costUsd - b.costBase >= limits.usd) return "usd";
  if (c.tools - b.ticketsBase >= limits.tickets) return "tickets";
  return null;
}

/**
 * A main ticket's plan is about to wake it: count wakes in a row with nothing new in the family (sig: familySig of its
 * tool tickets). stuck: the plan has had NO_PROGRESS_WAKES of them.
 */
export function progressStep(plan: Pick<Plan, "progressSig" | "noProgress">, sig: string): { progressSig: string; noProgress: number; stuck: boolean } {
  const same = plan.progressSig != null && plan.progressSig === sig;
  const noProgress = same ? (plan.noProgress ?? 0) + 1 : 0;
  return { progressSig: sig, noProgress, stuck: noProgress >= NO_PROGRESS_WAKES };
}
