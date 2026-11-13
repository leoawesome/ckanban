import { expect, test } from "bun:test";
import { isFinished, isOneDateCron, scheduleGroup } from "../web/src/scheduleGroups";
import { lastPause } from "../src/server/quiet";
import type { ScheduleHistoryEntry } from "../src/server/types";

const NOW = new Date("2026-11-13T12:00:00Z").getTime();
const days = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const base = { cron: "45 23 11 11 *", enabled: true, lastFiredAt: days(-2), nextRunAt: days(363) };

test("one-date cron needs both day of month and month fixed", () => {
  expect(isOneDateCron("45 23 11 11 *")).toBe(true);
  expect(isOneDateCron("0 * 8-9 11 *")).toBe(true);
  expect(isOneDateCron("0 9 * * *")).toBe(false);
  expect(isOneDateCron("0 9 1 * *")).toBe(false);
  expect(isOneDateCron("0 9 * 11 *")).toBe(false);
  expect(isOneDateCron("0 9 */2 11 *")).toBe(false);
  expect(isOneDateCron("bad")).toBe(false);
});

test("finished: one date, already ran, next run about a year away", () => {
  expect(isFinished(base, NOW)).toBe(true);
  expect(scheduleGroup(base, NOW)).toBe("finished");
});

test("finished when there is no next run (paused after it ran)", () => {
  const s = { ...base, enabled: false, nextRunAt: null };
  expect(isFinished(s, NOW)).toBe(true);
  expect(scheduleGroup(s, NOW)).toBe("finished");
});

test("not finished before its first run", () => {
  const s = { ...base, lastFiredAt: null, nextRunAt: days(5) };
  expect(isFinished(s, NOW)).toBe(false);
  expect(scheduleGroup(s, NOW)).toBe("on");
  expect(scheduleGroup({ ...s, enabled: false, nextRunAt: null }, NOW)).toBe("paused");
});

test("not finished while a fixed date's next run is close (hourly on launch day, still going)", () => {
  const s = { ...base, cron: "0 * 8-9 11 *", nextRunAt: days(0.05) };
  expect(isFinished(s, NOW)).toBe(false);
  expect(scheduleGroup(s, NOW)).toBe("on");
});

test("recurring schedules are never finished", () => {
  const s = { ...base, cron: "0 9 * * *", nextRunAt: null, enabled: false };
  expect(isFinished(s, NOW)).toBe(false);
  expect(scheduleGroup(s, NOW)).toBe("paused");
  expect(scheduleGroup({ ...s, enabled: true, nextRunAt: days(1) }, NOW)).toBe("on");
});

test("the 300-day line", () => {
  expect(isFinished({ ...base, nextRunAt: days(299) }, NOW)).toBe(false);
  expect(isFinished({ ...base, nextRunAt: days(301) }, NOW)).toBe(true);
});

test("lastPause: the last pause, unless resumed after it", () => {
  const edit = (at: string, action: "paused" | "resumed" | "updated", by: "user" | { ticketId: string } = "user"): ScheduleHistoryEntry =>
    ({ at, kind: "edited", action, fields: ["enabled"], by });
  expect(lastPause([])).toBeNull();
  expect(lastPause([edit("a", "paused", { ticketId: "t_1" }), { at: "b", kind: "fired", trigger: "schedule", ticketId: "t_2" }]))
    .toEqual({ at: "a", by: { ticketId: "t_1" } });
  expect(lastPause([edit("a", "paused"), edit("b", "resumed")])).toBeNull();
  expect(lastPause([edit("a", "paused"), edit("b", "resumed"), edit("c", "paused"), edit("d", "updated")])).toEqual({ at: "c", by: "user" });
});
