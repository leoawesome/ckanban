// Plain helpers for the Schedules window's On / Paused / Finished sections (no React, so tests can import them).

/** A next run further away than this means a one-date schedule would only run again next year. */
export const FINISHED_GAP_DAYS = 300;

export type ScheduleGroup = "on" | "paused" | "finished";

type Groupable = { cron: string; enabled: boolean; lastFiredAt: string | null; nextRunAt: string | null };

/** The cron sets both day of month and month to fixed values (e.g. "45 23 11 11 *" or "0 * 8-9 11 *"). */
export function isOneDateCron(cron: string): boolean {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return false;
  const fixed = (v: string) => v !== "" && !v.includes("*") && v !== "?";
  return fixed(f[2]) && fixed(f[3]);
}

/**
 * Finished: set for one date (day of month and month fixed), has already run, and would only run again in about a year
 * (next run more than FINISHED_GAP_DAYS away, or none, e.g. while paused).
 */
export function isFinished(s: Groupable, now = Date.now()): boolean {
  if (!s.lastFiredAt || !isOneDateCron(s.cron)) return false;
  if (!s.nextRunAt) return true;
  return new Date(s.nextRunAt).getTime() - now > FINISHED_GAP_DAYS * 86_400_000;
}

export function scheduleGroup(s: Groupable, now = Date.now()): ScheduleGroup {
  if (isFinished(s, now)) return "finished";
  return s.enabled ? "on" : "paused";
}
