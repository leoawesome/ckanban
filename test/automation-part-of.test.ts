import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { automationProposal } from "../src/server/automation-proposal";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { Passes } from "../src/server/integrations/passes";
import { runScript } from "../src/server/integrations/script";
import { LoopManager, type LoopInput } from "../src/server/loops";
import { resultWakesMain } from "../src/server/main-ticket";
import { planStep, planTable } from "../src/server/plan";
import { Store } from "../src/server/store";
import type { Plan, Ticket } from "../src/server/types";
import { featureChoices } from "../web/src/featureChoices";
import { tempDir } from "./helpers";

// Automations that put each new ticket in a feature (Loop.partOf): a task of the feature's main ticket, as schedules do.

let store: Store;
let board: Board;
let loops: LoopManager;
let now: Date;
let items: string;

const add = (...list: { id: string; title: string; link?: string }[]) => {
  for (const i of list) appendFileSync(items, JSON.stringify(i) + "\n");
};
const input = (extra: Partial<LoopInput> = {}): Partial<LoopInput> => ({ name: "Mentions", service: "X", script: `cat '${items}'\n`, everyMinutes: 5, ...extra });
const mainTicket = (extra: Partial<Ticket> = {}) =>
  store.createTicket("p", { title: "X + Threads", body: "", status: "review", main: true, ...extra } as any);
/** Saves the loop, primes it (the first check makes nothing), adds one new item and checks again: that item's ticket. */
const fire = async (extra: Partial<LoopInput>, id = "n1") => {
  const l = await loops.create("p", input(extra));
  await loops.checkNow("p", l.id);
  add({ id, title: `Item ${id}`, link: `https://x.test/${id}` });
  await loops.checkNow("p", l.id);
  const view = loops.list("p").find((v) => v.id === l.id)!;
  const shown = view.lastItems.find((i) => i.id === id)!;
  return { l, view, shown, t: store.getTicket("p", shown.ticketId!)! };
};

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  now = new Date("2026-11-12T08:00:00Z");
  items = join(tempDir(), "items.jsonl");
  writeFileSync(items, "");
  const passes = new Passes(store.root, bus, { fetch, now: () => now }, () => "http://localhost:1/cb", { configFile: join(store.root, "none.json") });
  loops = new LoopManager(store, bus, board, passes, {
    now: () => now, shimDir: () => tempDir(), port: () => 1,
    sideCall: async () => ({ ok: true, text: "{}", costUsd: 0, model: "haiku" }),
    run: (file, cwd, env) => runScript(file, cwd, env),
  });
});

afterEach(() => board.whenIdle());

test("autoStart off: each new item becomes a task of the feature that waits, and the plan doesn't start it", async () => {
  const main = mainTicket();
  const { t, view, shown } = await fire({ partOf: main.id });
  expect(view.partOf).toBe(main.id);
  expect(view.partOfTitle).toBe("X + Threads");
  expect(t).toMatchObject({ parentId: main.id, tool: true, status: "backlog", waitsForStart: true, title: "Item n1" });
  expect(t.source).toMatchObject({ provider: "X", url: "https://x.test/n1", loopId: view.id });
  expect(shown.note).toBeUndefined();
  expect(store.getTicket("p", main.id)!.plan?.state).toBe("running");
  board.advancePlans("p");
  await board.whenIdle();
  const after = store.getTicket("p", t.id)!;
  expect(after.status).toBe("backlog");
  expect(after.runCount ?? 0).toBe(0);
  // Waiting on purpose: not a dead end, so the main ticket isn't marked stuck.
  expect(store.getTicket("p", main.id)!.plan?.state).toBe("running");
  expect(store.getTicket("p", main.id)!.status).toBe("review");
  expect(store.aiComments("p", t.id).map((c) => c.text).join("\n")).toContain('made by the automation "Mentions". It waits in Backlog');
});

test("the user or the main ticket moving the waiting task starts it", async () => {
  const main = mainTicket();
  const { t } = await fire({ partOf: main.id });
  const moved = await board.updateTicket("p", t.id, { status: "ready" });
  expect(moved.waitsForStart).toBe(false);
  expect(["ready", "in_progress", "review"]).toContain(moved.status);
});

test("autoStart on: the task starts right away", async () => {
  const main = mainTicket();
  const { t } = await fire({ partOf: main.id, column: "ready", autoStart: true });
  expect(t).toMatchObject({ parentId: main.id, tool: true });
  expect(t.waitsForStart).toBeFalsy();
  expect(["ready", "in_progress"]).toContain(t.status);
});

test("a Done main ticket takes the task and goes back to Review, with no run and no wake", async () => {
  const main = mainTicket({ status: "done", outcome: "done" } as any);
  const { t } = await fire({ partOf: main.id });
  expect(t).toMatchObject({ parentId: main.id, tool: true });
  const after = store.getTicket("p", main.id)!;
  expect(after.status).toBe("review");
  expect(after.runCount ?? 0).toBe(0);
  expect(board.isRunning("p", main.id)).toBe(false);
  expect(after.plan?.awaiting ?? null).toBeNull();
  expect(store.aiComments("p", main.id).map((c) => c.text)).toContainEqual('Back to Review: the automation "Mentions" added a task.');
});

test("a group of the feature takes the task under the main ticket", async () => {
  const main = mainTicket();
  const group = store.createTicket("p", { title: "Replies", body: "", status: "backlog", kind: "group", partOf: main.id } as any);
  const { t } = await fire({ partOf: group.id });
  expect(t).toMatchObject({ parentId: main.id, partOf: group.id, tool: true });
});

test("a gone target: the item gets its own card, the check notes why and doesn't fail", async () => {
  const main = mainTicket();
  const l = await loops.create("p", input({ partOf: main.id }));
  await loops.checkNow("p", l.id);
  store.deleteTicket("p", main.id);
  add({ id: "n1", title: "Item" });
  await loops.checkNow("p", l.id);
  const view = loops.list("p")[0];
  expect(view.lastError).toBeNull();
  expect(view.partOfTitle).toBeNull();
  const shown = view.lastItems.find((i) => i.id === "n1")!;
  expect(shown.note).toContain("no longer exists, so it got its own card");
  const t = store.getTicket("p", shown.ticketId!)!;
  expect(t.parentId ?? null).toBeNull();
  expect(t.tool).toBeFalsy();
  expect(t.status).toBe("backlog");

  // No longer a main ticket: its own card too.
  const plain = store.createTicket("p", { title: "plain", body: "", status: "backlog" });
  store.saveLoop("p", { ...store.getLoop("p", l.id)!, partOf: plain.id });
  add({ id: "n2", title: "Item 2" });
  await loops.checkNow("p", l.id);
  const n2 = loops.list("p")[0].lastItems.find((i) => i.id === "n2")!;
  expect(n2.note).toContain("isn't a feature's main ticket");
  expect(store.getTicket("p", n2.ticketId!)!.parentId ?? null).toBeNull();
});

test("partOf is checked on create and edit, \"\" clears it, old automations have none, copies don't take it", async () => {
  const plain = store.createTicket("p", { title: "plain", body: "", status: "backlog" });
  await expect(loops.create("p", input({ partOf: "t_nope" }))).rejects.toThrow("no longer exists");
  await expect(loops.create("p", input({ partOf: plain.id }))).rejects.toThrow("isn't a feature's main ticket");
  await expect(loops.create("p", input({ partOf: "bad id!" }))).rejects.toThrow("isn't a ticket id");
  const old = await loops.create("p", input());
  expect(old.partOf).toBeNull();
  const main = mainTicket();
  const set = await loops.update("p", old.id, { partOf: main.id });
  expect(set.partOf).toBe(main.id);
  expect((await loops.update("p", old.id, { name: "Renamed" })).partOf).toBe(main.id);
  await expect(loops.update("p", old.id, { partOf: plain.id })).rejects.toThrow("isn't a feature's main ticket");
  expect((await loops.update("p", old.id, { partOf: "" })).partOf).toBeNull();
  // A file saved before partOf existed reads as its own card.
  const { partOf: _, ...legacy } = store.getLoop("p", old.id)!;
  store.saveLoop("p", legacy as any);
  expect(loops.list("p")[0].partOf ?? null).toBeNull();
});

test("an automation's task wakes its main ticket only when it needs attention; a waiting one is no dead end", () => {
  const src = { provider: "X", label: "x", url: "", loopId: "l" };
  expect(resultWakesMain({ source: src, outcome: "done" })).toBe(false);
  for (const outcome of ["needs_input", "blocked", "failed", "limit"] as const) expect(resultWakesMain({ source: src, outcome })).toBe(true);
  expect(resultWakesMain({ source: { ...src, loopId: "" }, outcome: "done" })).toBe(true);

  let n = 0;
  const T = (p: Partial<Ticket>): Ticket => ({
    id: `t_${++n}`, title: "x", status: "done", order: n, runCount: 1, tool: true, parentId: "t_main", createdAt: "", updatedAt: "", body: "", ...p,
  } as Ticket);
  const plan: Plan = { state: "running", wakeups: 0, startedAt: "", originalCount: 2 };
  const managed = { summary: () => "ok", report: () => null };
  const waiting = T({ status: "backlog", waitsForStart: true, runCount: 0, outcome: null });
  const plainBacklog = T({ status: "backlog", runCount: 0, outcome: null });
  const step = planStep(plan, [waiting, plainBacklog], () => false, { managed });
  expect(step.start).toEqual([plainBacklog.id]);
  const alone = planStep(plan, [waiting, T({ source: src, outcome: "done" })], () => false, { managed });
  expect(alone.start).toEqual([]);
  expect(alone.events).toEqual([]);
  expect(alone.deadEnd).toBeNull();
  expect(planTable([waiting])).toContain("waits to be started");
});

test("the setup chat's proposal takes partOf; the picker words it for new tickets", () => {
  const base = { name: "A", summary: "s", script: "echo" };
  expect(automationProposal({ ...base, partOf: "t_1" }).partOf).toBe("t_1");
  expect(automationProposal(base).partOf).toBeUndefined();
  expect(() => automationProposal({ ...base, partOf: "no spaces" })).toThrow("partOf");
  const done = mainTicket({ title: "Old", status: "done" } as any);
  const rows = featureChoices(store.listTickets("p"), "", "automation");
  expect(rows.find((r) => r.value === done.id)!.label).toBe("Put each new ticket in: Old (done: new tickets move it back to Review)");
});
