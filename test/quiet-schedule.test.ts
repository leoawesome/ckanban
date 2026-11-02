import { afterEach, beforeEach, expect, test } from "bun:test";
import { GUIDES, checkinSetupPrompt } from "../src/server/checkin-guides";
import { quietSection } from "../src/server/prompts";
import { canEndQuietly, linksIn, quietContext, quietPerDay, scheduleSpend } from "../src/server/quiet";
import { parseResult } from "../src/server/result";
import { Scheduler } from "../src/server/scheduler";
import type { Schedule, ScheduleHistoryEntry, Ticket } from "../src/server/types";
import { board, bus, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { until } from "./helpers";

useBoardEnv();

let scheduler: Scheduler;
beforeEach(() => {
  scheduler = new Scheduler(board, store, bus);
  delete process.env.FAKE_PR;
});
afterEach(() => {
  delete process.env.FAKE_QUIET;
});

const runs = (sid: string) => store.listTickets("p").filter((t) => t.scheduleId === sid);
const quietLines = (sid: string) => store.readScheduleHistory("p", sid).filter((e) => e.kind === "quiet");

test("a quiet run that finds nothing leaves no ticket, three times in a row, and a history line each time", async () => {
  await setup();
  process.env.FAKE_QUIET = "1";
  const s = scheduler.create("p", { name: "Check-ins", title: "Check-in {time}", body: "check slack", cron: "0 9-19 * * 1-5", quiet: true, model: "sonnet" });
  for (let i = 1; i <= 3; i++) {
    await scheduler.runNow("p", s.id);
    await until(() => quietLines(s.id).length === i);
    await board.whenIdle();
    expect(runs(s.id)).toHaveLength(0);
  }
  const h = scheduler.history("p", s.id).filter((e) => e.kind !== "edited");
  // Each quiet run shows once, as its "quiet" line (its fire line is left out).
  expect(h.map((e) => e.kind)).toEqual(["quiet", "quiet", "quiet"]);
  expect(h[0]).toMatchObject({ kind: "quiet", summary: "fake done" });
  // The schedule's model reached the run.
  expect(readArgs()[0].args.join(" ")).toContain("--model sonnet");
  // And its prompt told it how to end quietly.
  expect(readArgs()[0].prompt).toContain("# Quiet check-in");
});

test("a schedule that isn't quiet keeps its ticket even when the run says quiet", async () => {
  await setup();
  process.env.FAKE_QUIET = "1";
  const s = scheduler.create("p", { name: "Audit", title: "Audit", body: "audit", cron: "0 9 * * *" });
  await scheduler.runNow("p", s.id);
  await until(() => runs(s.id)[0]?.status === "review");
  await board.whenIdle();
  expect(runs(s.id)).toHaveLength(1);
  expect(quietLines(s.id)).toHaveLength(0);
});

test("a failed run of a quiet schedule is never removed", async () => {
  await setup();
  process.env.FAKE_QUIET = "1";
  process.env.FAKE_MODE = "fail";
  const s = scheduler.create("p", { name: "Check-ins", title: "Check-in", body: "check", cron: "0 9 * * *", quiet: true });
  await scheduler.runNow("p", s.id);
  await until(() => runs(s.id)[0]?.outcome === "failed");
  await board.whenIdle();
  expect(runs(s.id)).toHaveLength(1);
  expect(quietLines(s.id)).toHaveLength(0);
});

test("a run that reports something (no quiet flag) stays in Review", async () => {
  await setup();
  const s = scheduler.create("p", { name: "Check-ins", title: "Check-in", body: "check", cron: "0 9 * * *", quiet: true });
  await scheduler.runNow("p", s.id);
  await untilSpawned();
  await until(() => runs(s.id)[0]?.status === "review");
  await board.whenIdle();
  expect(runs(s.id)[0].outcome).toBe("done");
  expect(quietLines(s.id)).toHaveLength(0);
});

test("a quiet run that raised a ticket is kept", async () => {
  await setup();
  const s = scheduler.create("p", { name: "Check-ins", title: "Check-in", body: "check", cron: "0 9 * * *", quiet: true });
  const run = store.createTicket("p", { title: "Check-in", body: "", status: "done", scheduleId: s.id });
  const raised = store.createTicket("p", { title: "Reply to Ana", body: "https://slack.com/x", status: "review", raisedBy: { scheduleId: s.id, ticketId: run.id } });
  const sched = store.getSchedule("p", s.id);
  const base = { schedule: sched, ticket: run, quietResult: true, prUrls: [], waiting: 0 };
  expect(canEndQuietly({ ...base, tickets: [run, raised] })).toBe(false);
  expect(canEndQuietly({ ...base, tickets: [run] })).toBe(true);
  expect(canEndQuietly({ ...base, tickets: [run], quietResult: false })).toBe(false);
  expect(canEndQuietly({ ...base, tickets: [run], prUrls: ["https://github.com/x/y/pull/1"] })).toBe(false);
  expect(canEndQuietly({ ...base, tickets: [run], waiting: 1 })).toBe(false);
  expect(canEndQuietly({ ...base, tickets: [run], schedule: { ...sched!, quiet: false } })).toBe(false);
});

test("the next run is told what the schedule raised that is still open, and when it last checked", () => {
  const t = (id: string, extra: Partial<Ticket>): Ticket => ({
    id, title: id, status: "review", body: "", createdAt: "2026-11-02T09:00:00.000Z", ...extra,
  } as Ticket);
  const tickets = [
    t("a", { raisedBy: { scheduleId: "s1", ticketId: "r1" }, body: "See https://slack.com/archives/C1/p1. and https://slack.com/archives/C1/p1" }),
    t("b", { raisedBy: { scheduleId: "s1", ticketId: "r1" }, status: "done" }),
    t("c", { raisedBy: { scheduleId: "s2", ticketId: "r9" } }),
  ];
  const history: ScheduleHistoryEntry[] = [
    { at: "2026-11-02T09:00:00.000Z", kind: "fired", trigger: "schedule", ticketId: "r1" },
    { at: "2026-11-02T10:00:00.000Z", kind: "fired", trigger: "schedule", ticketId: "r2" },
  ];
  const q = quietContext(tickets, history, "s1", "r2");
  expect(q.lastCheckAt).toBe("2026-11-02T09:00:00.000Z");
  expect(q.open.map((o) => o.id)).toEqual(["a"]);
  expect(q.open[0].links).toEqual(["https://slack.com/archives/C1/p1"]);
  const text = quietSection(q);
  expect(text).toContain('"quiet":true');
  expect(text).toContain("- a \"a\" (review");
});

test("links, quiet counts per day and 7-day spend", () => {
  expect(linksIn("a https://x.io/1, b (https://y.io/2) c https://z.io/3 d https://w.io/4")).toEqual(["https://x.io/1", "https://y.io/2", "https://z.io/3"]);
  const day = new Date(2026, 10, 2, 10).toISOString();
  const old = new Date(2026, 9, 1, 10).toISOString();
  const h: ScheduleHistoryEntry[] = [
    { at: old, kind: "quiet", ticketId: "q0", summary: "", costUsd: 5 },
    { at: day, kind: "fired", trigger: "schedule", ticketId: "q1" },
    { at: day, kind: "quiet", ticketId: "q1", summary: "", costUsd: 0.1 },
    { at: day, kind: "fired", trigger: "schedule", ticketId: "t2" },
  ];
  expect(quietPerDay(h)).toEqual([{ day: "2026-11-02", count: 1 }, { day: "2026-10-01", count: 1 }]);
  // q1's cost is in its quiet line (the ticket is gone); t2 still exists; the old quiet run is out of range.
  expect(scheduleSpend(h, new Date(2026, 9, 27), (id) => (id === "t2" ? 0.25 : 99))).toBe(0.35);
});

test("the result line's quiet flag only counts with status done", () => {
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":null,"quiet":true,"summary":"nothing"}')?.quiet).toBe(true);
  expect(parseResult('CKANBAN_RESULT: {"status":"blocked","prUrl":null,"quiet":true,"summary":"x"}')?.quiet).toBeUndefined();
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"x"}')?.quiet).toBeUndefined();
});

test("schedules keep quiet and model, and reject a bad model", () => {
  const s = scheduler.create("p", { name: "C", title: "C", body: "", cron: "0 9 * * *", quiet: true, model: "sonnet" });
  expect(s).toMatchObject({ quiet: true, model: "sonnet" });
  const u = scheduler.update("p", s.id, { model: "" });
  expect(u.model).toBeNull();
  expect(scheduler.history("p", s.id).find((e) => e.kind === "edited" && e.action === "updated")).toMatchObject({ fields: ["model"] });
  expect(() => scheduler.update("p", s.id, { model: "bad model; rm" })).toThrow("invalid model");
  expect((scheduler.create("p", { name: "D", title: "D", body: "", cron: "0 9 * * *" }) as Schedule).quiet).toBe(false);
});

test("the setup chat offers every guide and creates a quiet Sonnet schedule", () => {
  const text = checkinSetupPrompt();
  for (const g of GUIDES) expect(text).toContain(g.label);
  expect(text).toContain("quiet true");
  expect(text).toContain('model "sonnet"');
  expect(text).toContain("0 9-19 * * 1-5");
});
