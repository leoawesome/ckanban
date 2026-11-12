import { afterEach, beforeEach, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { resultWakesMain } from "../src/server/main-ticket";
import { planStep } from "../src/server/plan";
import { Scheduler } from "../src/server/scheduler";
import { Store } from "../src/server/store";
import type { Plan, Ticket } from "../src/server/types";
import { tempDir } from "./helpers";

// Schedules that put each run in a feature (Schedule.partOf): the run is a task of the feature's main ticket.

let store: Store;
let board: Board;
let now: Date;
let scheduler: Scheduler;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  now = new Date(2026, 9, 1, 8, 30);
  scheduler = new Scheduler(board, store, new Bus(), () => now);
});

afterEach(() => board.whenIdle());

const mainTicket = (extra: Partial<Ticket> = {}) =>
  store.createTicket("p", { title: "X + Threads", body: "", status: "review", main: true, ...extra } as any);
const create = (extra: Record<string, unknown> = {}) =>
  scheduler.create("p", { name: "Replies", title: "Replies {date}", body: "reply", cron: "0 9 * * *", tags: ["x"], model: "sonnet", ...extra });

test("a schedule with partOf fires its run as a task of the feature's main ticket", async () => {
  const main = mainTicket();
  const s = create({ partOf: main.id });
  expect(s.partOf).toBe(main.id);
  expect(scheduler.view("p", s).partOfTitle).toBe("X + Threads");
  const entry = await scheduler.runNow("p", s.id);
  expect(entry).toMatchObject({ kind: "fired" });
  expect((entry as any).note).toBeUndefined();
  const t = store.getTicket("p", (entry as any).ticketId)!;
  expect(t).toMatchObject({ parentId: main.id, tool: true, scheduleId: s.id, tags: ["x"], model: "sonnet", mode: "auto" });
  expect(t.main).toBeFalsy();
  // Started right away by the schedule, not held for the plan.
  expect(["ready", "in_progress"]).toContain(t.status);
  expect(store.getTicket("p", main.id)!.plan?.state).toBe("running");
  // The main card stays where it was.
  expect(store.getTicket("p", main.id)!.status).toBe("review");
});

test("a group of the feature takes the run under the main ticket's plan", async () => {
  const main = mainTicket();
  const group = store.createTicket("p", { title: "Posting", body: "", status: "backlog", kind: "group", partOf: main.id } as any);
  const s = create({ partOf: group.id });
  const entry = await scheduler.runNow("p", s.id);
  const t = store.getTicket("p", (entry as any).ticketId)!;
  expect(t).toMatchObject({ parentId: main.id, partOf: group.id, tool: true });
});

test("a gone or finished feature: the run gets its own card and the history says why", async () => {
  const main = mainTicket();
  const s = create({ partOf: main.id, skipIfRunning: false });
  store.deleteTicket("p", main.id);
  const e1 = await scheduler.runNow("p", s.id);
  expect(e1.kind).toBe("fired");
  expect((e1 as any).note).toContain("no longer exists, so this run got its own card");
  const t1 = store.getTicket("p", (e1 as any).ticketId)!;
  expect(t1.parentId ?? null).toBeNull();
  expect(t1.tool).toBeFalsy();
  expect(t1.scheduleId).toBe(s.id);
  expect(scheduler.view("p", store.getSchedule("p", s.id)!).partOfTitle).toBeNull();

  const done = mainTicket({ status: "done" });
  store.saveSchedule("p", { ...store.getSchedule("p", s.id)!, partOf: done.id });
  const e2 = await scheduler.runNow("p", s.id);
  expect((e2 as any).note).toContain("is done");
  expect(store.getTicket("p", (e2 as any).ticketId)!.parentId ?? null).toBeNull();
  expect(scheduler.history("p", s.id).find((h) => h.kind === "fired" && h.ticketId === (e2 as any).ticketId)).toMatchObject({ note: expect.stringContaining("is done") });
});

test("partOf is checked when set, cleared with \"\" and logged as an edit; old schedules have none", () => {
  const plain = store.createTicket("p", { title: "plain", body: "", status: "backlog" });
  expect(() => create({ partOf: "t_nope" })).toThrow("no longer exists");
  expect(() => create({ partOf: plain.id })).toThrow("isn't a feature's main ticket");
  const old = create();
  expect(old.partOf).toBeNull();
  const main = mainTicket();
  const s = scheduler.update("p", old.id, { partOf: main.id });
  expect(s.partOf).toBe(main.id);
  expect(scheduler.update("p", s.id, { name: "Renamed" }).partOf).toBe(main.id);
  expect(scheduler.update("p", s.id, { partOf: "" }).partOf).toBeNull();
  const edits = scheduler.history("p", s.id).filter((e) => e.kind === "edited" && e.action === "updated").map((e) => (e as any).fields);
  expect(edits).toContainEqual(["partOf"]);
});

test("resultWakesMain: a schedule's task wakes its main ticket only when it needs attention", () => {
  for (const outcome of ["done", "needs_input", "blocked", "failed", "limit"] as const) expect(resultWakesMain({ outcome })).toBe(true);
  expect(resultWakesMain({ scheduleId: "s", outcome: "done" })).toBe(false);
  expect(resultWakesMain({ scheduleId: "s", outcome: null })).toBe(false);
  for (const outcome of ["needs_input", "blocked", "failed", "limit"] as const) expect(resultWakesMain({ scheduleId: "s", outcome })).toBe(true);
});

test("the main ticket's plan gets no event for a schedule's task that just finished", () => {
  let n = 0;
  const T = (p: Partial<Ticket>): Ticket => ({
    id: `t_${++n}`, title: "x", status: "done", order: n, runCount: 1, tool: true, parentId: "t_main", createdAt: "", updatedAt: "", body: "", ...p,
  } as Ticket);
  const plan: Plan = { state: "running", wakeups: 0, startedAt: "", originalCount: 3 };
  const managed = { summary: () => "ok", report: () => null };
  const done = T({ scheduleId: "s", outcome: "done" });
  const asks = T({ scheduleId: "s", outcome: "needs_input", status: "review" });
  const failed = T({ scheduleId: "s", outcome: "failed", status: "review" });
  const normal = T({ outcome: "done" });
  const step = planStep(plan, [done, asks, failed, normal], () => false, { managed });
  expect(step.events.map((e) => e.childId).sort()).toEqual([asks.id, failed.id, normal.id].sort());
});
