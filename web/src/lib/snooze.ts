// Inbox snooze lengths and how a snooze's end reads (no browser APIs, so tests can load it).
import { timeUntil } from "./time";

/** Snooze (1 day, the s key), Snooze for a week, Snooze until I unsnooze. Any of them ends when the ticket changes. */
export type SnoozeLength = "day" | "week" | "forever";

/** "Until I unsnooze" is stored as this far-off end (src/server/attention.ts SNOOZE_FOREVER). */
export const SNOOZE_FOREVER = "9999-12-31T23:59:59.000Z";
const DAY_MS = 24 * 3600_000;

export const snoozeForever = (until: string | null | undefined) => !!until && Date.parse(until) >= Date.parse("9000-01-01T00:00:00.000Z");

/** When a snooze of this length that starts now ends. */
export function snoozeUntil(len: SnoozeLength, now = Date.now()): string {
  if (len === "forever") return SNOOZE_FOREVER;
  return new Date(now + (len === "week" ? 7 : 1) * DAY_MS).toISOString();
}

/** What the request body says: nothing for a day, hours for a week, forever for no end. */
export function snoozeBody(len: SnoozeLength): Record<string, unknown> {
  return len === "forever" ? { forever: true } : len === "week" ? { hours: 7 * 24 } : {};
}

/** "Snoozed X for a day" / "for a week" / "until you unsnooze". */
export const snoozeWords = (len: SnoozeLength) => (len === "forever" ? "until you unsnooze" : len === "week" ? "for a week" : "for a day");

/** The Snoozed section's end: "until you unsnooze", "until 16 Nov" (over a day away), else "back in 5h". */
export function snoozeEndText(until: string, now = Date.now()): string {
  if (snoozeForever(until)) return "until you unsnooze";
  const t = Date.parse(until);
  if (t - now > DAY_MS) {
    const d = new Date(t);
    return `until ${d.getDate()} ${d.toLocaleString("en-GB", { month: "short" })}`;
  }
  return `back ${timeUntil(until)}`;
}
