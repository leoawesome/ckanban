// The helper runner's error type and text helpers: helper lines, summary lines, reminder text, fail-over order (split from runner.ts; runner.ts re-exports them).
import { cut } from "./core";
import { type WaitRecord } from "./waits";

export class HelperError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const unique = (xs: string[]) => [...new Set(xs)];

/** The message a wait's helper line is about: its newest sent reminder, else the alert or summary that told it. */
export function lineMessage(r: Pick<WaitRecord, "messageId" | "reminders">): string | null {
  const sent = r.reminders.filter((x) => x.messageId && x.sentAt && !x.skipped);
  return sent.at(-1)?.messageId ?? r.messageId ?? null;
}

/** A count the helper put at the start of a summary line: "6 tickets wait on you: ", "5 wait on you - ", "3 need you, ", "2 new for you: ". */
const LEADING_COUNT = /^\s*\d+\s+(?:[\p{L}-]+\s+){0,3}?(?:waits?|are\s+waiting|is\s+waiting|needs?\s+you|need\s+your\s+\w+|new\s+for\s+you)(?:\s+on\s+you|\s+for\s+you)?\s*(?:[:,.;\u2014\u2013-]\s*)?/iu;

/**
 * A summary's one line with the board's own count of new items: "N new for you", then what the helper said is new
 * (its own leading count, if any, dropped). No count when nothing new waits (check-ins only).
 */
export function summaryLine(total: number, line: string): string {
  const rest = line.replace(LEADING_COUNT, "").trim();
  if (!total) return cut(rest || line.trim());
  const head = `${total} new for you`;
  return cut(rest ? `${head}: ${rest}` : head);
}

/** The urgent alert's own plan and question lines (a reminder leaves them out: it says its own next step). */
export const NEXT_PREFIX = "Next: I'll remind you";
export const NO_REMINDERS = "No reminders planned: this is the only alert.";
export const ASK_PREFIX = "Right call?";

/**
 * "Reminder n of of" for the step at index: step 0 is the alert itself, not a reminder, and steps skipped (overdue
 * after sleep, never sent) don't count. of = reminders sent or about to be, plus the ones still planned after it.
 */
export function reminderCount(steps: { sentAt?: string | null; skipped?: boolean }[], index: number): { n: number; of: number } {
  const n = steps.slice(1, index + 1).filter((x) => !x.skipped).length;
  return { n: Math.max(1, n), of: Math.max(1, n) + Math.max(0, steps.length - index - 1) };
}

/** A reminder's text from the alert's: the alert without its closing "Next: ..." and "Right call?" lines. */
export function reminderBody(text: string): string {
  const parts = text.split("\n\n");
  const plan = (p: string) => p.startsWith(NEXT_PREFIX) || p === NO_REMINDERS || p.startsWith(ASK_PREFIX);
  while (parts.length > 1 && plan(parts.at(-1)!)) parts.pop();
  return parts.join("\n\n");
}

/**
 * The fail-over order for one step: its own channel, then the later planned ones, then any other that is on. A step
 * meant for the phone (any channel but this Mac) tries every other phone channel before falling back to this Mac.
 */
export function stepChain(channel: string, later: string[], on: string[]): string[] {
  const chain = unique([channel, ...later, ...on]);
  return channel === "mac" ? chain : [...chain.filter((c) => c !== "mac"), ...chain.filter((c) => c === "mac")];
}

/** What went wrong on each channel, for the log. */
export const failures = (results: { channel: string; error?: string | null }[]) =>
  results.length ? results.map((r) => `${r.channel}: ${r.error ?? "not reached"}`).join("; ") : "no channel is on";
