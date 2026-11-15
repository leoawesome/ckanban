import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Board } from "./board";
import { Bus } from "../core/events";
import { Store } from "../core/store";
import type { Profile } from "../core/types";
import { makeRepo, tempDir } from "../../test/support/helpers";

const FAKE = join(import.meta.dir, "..", "..", "test", "fixtures", "fake-claude.ts");

let store: Store;
let bus: Bus;
let board: Board;
let notes: string[];

beforeEach(async () => {
  store = new Store(tempDir("ck-home-"));
  bus = new Bus();
  notes = [];
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, notify: (t) => notes.push(t), planWakeDelayMs: 300 });
  const p: Profile = { name: "P", slug: "p", path: await makeRepo(), baseBranch: "main", maxParallel: 5, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p);
  // Fake claude saves its sessions here, so runs can resume them.
  process.env.CLAUDE_CONFIG_DIR = tempDir("ck-claude-");
  process.env.FAKE_MODE = "ok";
  process.env.FAKE_ARGS_FILE = join(tempDir("ck-args-"), "args.jsonl");
  delete process.env.FAKE_PR;
});

afterEach(async () => {
  await board.shutdown();
  delete process.env.FAKE_BLOCK_MATCH;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.FAKE_STEP_MS;
}, 60_000);

/** Wait until no run is left and no wake-up is pending. */
async function settle(ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    await board.whenIdle();
    await Bun.sleep(500);
    if (!(board as any).runs.size && !(board as any).wakeDue.size) return;
    if (Date.now() > end) throw new Error("plan did not settle");
  }
}

test("a tool group runs its tickets in dependency order, every ready child at once, then the final check", async () => {
  process.env.FAKE_STEP_MS = "40";
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog", tool: true, kind: "group" });
  const mk = (title: string, planKey: string, dependsOn?: string[]) =>
    board.createTicket("p", { title, body: "", status: "backlog", parentId: planner.id, tool: true, planKey, dependsOn });
  const a = await mk("A", "a");
  const b = await mk("B", "b", ["a"]);
  const c = await mk("C", "c", ["a"]);
  const d = await mk("D", "d", ["b", "c"]);
  const e = await mk("E", "e");
  const order: string[] = [];
  const live = new Set<string>();
  let peak = 0;
  bus.on((ev) => {
    if (ev.type !== "ticket.updated" || ev.ticket.parentId !== planner.id) return;
    if (ev.ticket.status === "in_progress" && !live.has(ev.ticket.id)) {
      live.add(ev.ticket.id);
      order.push(ev.ticket.title);
      peak = Math.max(peak, live.size);
    } else if (ev.ticket.status !== "in_progress") live.delete(ev.ticket.id);
  });

  board.startPlan("p", planner.id);
  expect(store.getTicket("p", b.id)!.mode).toBe("auto");
  await settle();

  expect(order.slice(0, 2).sort()).toEqual(["A", "E"]);
  expect(order.slice(2, 4).sort()).toEqual(["B", "C"]);
  expect(order.at(-1)).toBe("D");
  expect(order.indexOf("B")).toBeLessThan(order.indexOf("D"));
  expect(order.indexOf("C")).toBeLessThan(order.indexOf("D"));
  expect(peak).toBeGreaterThanOrEqual(2);
  for (const k of [a, b, c, d, e]) expect(store.getTicket("p", k.id)!.outcome).toBe("done");
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("done");
  // The group's final wake finished it, and its own PR link is left alone.
  expect(p.status).toBe("done");
  expect(p.prUrl).toBeNull();
  // A group hears its tickets' results (batched), then the final wake.
  expect(p.plan?.wakeups).toBeGreaterThanOrEqual(2);
  expect(notes).toEqual(["Plan done: Plan"]);
});

test("children failing together wake the planner once; an unresolved dead end makes the plan stuck", async () => {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog", tool: true, kind: "group" });
  await board.createTicket("p", { title: "X-fail", body: "", status: "backlog", parentId: planner.id, tool: true });
  await board.createTicket("p", { title: "Y-fail", body: "", status: "backlog", parentId: planner.id, tool: true });
  // Both children end within the batching window even on a busy machine (default here is 300ms).
  await board.shutdown();
  board = new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, notify: (t) => notes.push(t), planWakeDelayMs: 3000 });
  // Child runs (their prompt has "# Ticket: <title>") end blocked; the planner answers "done", so the dead end shows.
  process.env.FAKE_BLOCK_MATCH = "# Ticket: ";
  board.startPlan("p", planner.id);
  await settle();
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.wakeups).toBe(1);
  expect(p.plan?.state).toBe("stuck");
  expect(p.plan?.reason).toContain("nothing can run");
  // A stuck plan needs the user: the Notifier (notify.ts) tells them, not a board banner.
  expect(notes).toEqual([]);
  const wake = store.listComments("p", planner.id).find((c) => c.text.startsWith("Stuck:"));
  expect(wake).toBeDefined();
});

test("startPlan refuses cycles and plans without children", async () => {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog", tool: true, kind: "group" });
  expect(() => board.startPlan("p", planner.id)).toThrow(/no tool tickets/);
  await board.createTicket("p", { title: "X", body: "", status: "backlog", parentId: planner.id, tool: true, planKey: "x", dependsOn: ["y"] });
  await board.createTicket("p", { title: "Y", body: "", status: "backlog", parentId: planner.id, tool: true, planKey: "y", dependsOn: ["x"] });
  expect(() => board.startPlan("p", planner.id)).toThrow(/dependency cycle/);
  expect(store.getTicket("p", planner.id)!.plan).toBeUndefined();
});

/** A planner whose plan is stuck, with children in the given columns. */
async function stuckPlan(...statuses: ("backlog" | "review" | "done")[]) {
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "review", tool: true, kind: "group" });
  const kids = [];
  for (const [i, s] of statuses.entries()) kids.push(await board.createTicket("p", { title: `K${i}`, body: "", status: s, parentId: planner.id, tool: true }));
  store.updateTicket("p", planner.id, {
    plan: { state: "stuck", wakeups: 1, startedAt: "", originalCount: kids.length, inbox: [], seen: {}, retries: {}, awaiting: null, reason: "the planner's run is blocked" },
  });
  return { planner, kids };
}

test("a stuck plan closes without a run once its last child is done", async () => {
  const { planner, kids } = await stuckPlan("done", "review");
  board.advancePlans("p");
  expect(store.getTicket("p", planner.id)!.plan?.state).toBe("stuck");
  await board.updateTicket("p", kids[1].id, { status: "done" });
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("done");
  expect(p.plan?.reason).toBeNull();
  expect(p.runCount).toBe(0);
  expect(store.listComments("p", planner.id).at(-1)!.text).toContain("stuck plan was closed");
});

test("startup clears a stuck plan whose children are all done", async () => {
  const { planner } = await stuckPlan("done", "done");
  board.recover();
  expect(store.getTicket("p", planner.id)!.plan?.state).toBe("done");
  expect(store.getTicket("p", planner.id)!.runCount).toBe(0);
});

test("Mark plan done closes a stuck plan with open children, without waking the planner", async () => {
  const { planner, kids } = await stuckPlan("done", "backlog");
  const t = board.markPlanDone("p", planner.id);
  expect(t.plan?.state).toBe("done");
  expect(t.plan?.finishedAt).toBeTruthy();
  expect(t.runCount).toBe(0);
  expect(store.getTicket("p", kids[1].id)!.status).toBe("backlog");
  expect(store.listComments("p", planner.id).at(-1)!.text).toBe("Plan marked done.");
  expect(() => board.markPlanDone("p", kids[0].id)).toThrow(/no plan/);
});

test("tickets that list the same device all start at once: needs is only a hint", async () => {
  process.env.FAKE_STEP_MS = "40";
  const p2: Profile = { name: "Q", slug: "q", path: await makeRepo(), baseBranch: "main", maxParallel: 5, model: null, createdAt: new Date().toISOString() };
  store.saveProfile(p2);
  const a = await board.createTicket("p", { title: "A", body: "", status: "ready", needs: ["Emulator "] });
  const b = await board.createTicket("q", { title: "B", body: "", status: "ready", needs: ["emulator"] });
  expect(a.needs).toEqual(["emulator"]);
  expect(board.isRunning("p", a.id)).toBe(true);
  expect(board.isRunning("q", b.id)).toBe(true);
  await settle();
  expect(store.getTicket("p", a.id)!.outcome).toBe("done");
  expect(store.getTicket("q", b.id)!.outcome).toBe("done");
}, 60_000);

test("a plan starts children that list the same device together", async () => {
  process.env.FAKE_STEP_MS = "40";
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog", tool: true, kind: "group" });
  const mk = (title: string) => board.createTicket("p", { title, body: "", status: "backlog", parentId: planner.id, tool: true, needs: ["emulator"] });
  const kids = [await mk("E1"), await mk("E2")];
  board.startPlan("p", planner.id);
  for (const k of kids) expect(store.getTicket("p", k.id)!.status).not.toBe("backlog");
  await settle();
  expect(store.getTicket("p", planner.id)!.plan?.state).toBe("done");
}, 60_000);

test("a run's end frees the devices it still holds and hands them to the next in line", async () => {
  process.env.FAKE_STEP_MS = "200";
  const a = await board.createTicket("p", { title: "A", body: "", status: "ready" });
  expect(board.isRunning("p", a.id)).toBe(true);
  expect((await board.devices.take("p", a.id, ["leo-phone"])).ok).toBe(true);
  expect(board.deviceState("p", a.id)?.using.map((u) => u.name)).toEqual(["leo-phone"]);
  const next = board.devices.take("p", "t_other", ["leo-phone"], 20_000);
  await settle();
  expect((await next).ok).toBe(true);
  expect(board.deviceState("p", a.id)).toBeNull();
}, 60_000);

test("a plan never starts a child waiting on the user, and stops naming it once nothing else is left", async () => {
  (board as any).sessionSummary = (sid: string) => (sid === "s-asks" ? { openQuestions: 2, pendingProposal: null } : null);
  const planner = await board.createTicket("p", { title: "Plan", body: "", status: "backlog", tool: true, kind: "group" });
  const asks = await board.createTicket("p", { title: "Asks", body: "", status: "backlog", parentId: planner.id });
  store.updateTicket("p", asks.id, { sessionId: "s-asks" });
  const ok = await board.createTicket("p", { title: "Ok", body: "", status: "backlog", parentId: planner.id });
  board.startPlan("p", planner.id);
  await settle();
  expect(store.getTicket("p", asks.id)!.status).toBe("backlog");
  expect(store.getTicket("p", ok.id)!.outcome).toBe("done");
  const p = store.getTicket("p", planner.id)!;
  expect(p.plan?.state).toBe("stuck");
  expect(p.plan?.reason).toBe('waiting for you: "Asks" (2 questions for you)');
}, 60_000);

test("planner rights: only a main ticket or tool group, in its own runs (not a quiet reply)", async () => {
  process.env.FAKE_STEP_MS = "100";
  // A plain ticket has no family to manage (planned tickets are retired), even in a reply to the user.
  const plain = await board.createTicket("p", { title: "Plain", body: "", status: "review" });
  await board.chat("p", plain.id, "manage tickets A and B");
  expect(board.userChatRun("p", plain.id)).toBe(true);
  expect(board.plannerRights("p", plain.id)).toBeNull();
  await settle();
  const mgr = await board.createTicket("p", { title: "Manager", body: "", status: "review", main: true });
  expect(board.plannerRights("p", mgr.id)).toBeNull();
  await board.chat("p", mgr.id, "manage tickets A and B");
  expect(board.userChatRun("p", mgr.id)).toBe(true);
  expect(board.plannerRights("p", mgr.id)?.id).toBe(mgr.id);
  await settle();
  // An ordinary work run doesn't either.
  const w = await board.createTicket("p", { title: "Work", body: "", status: "ready" });
  expect(board.isRunning("p", w.id)).toBe(true);
  expect(board.plannerRights("p", w.id)).toBeNull();
  await settle();
}, 60_000);

test("user-request rights: only a Planning chat's reply to the user's own message", async () => {
  process.env.FAKE_STEP_MS = "100";
  const t = await board.createTicket("p", { title: "Shape me", body: "", status: "backlog" });
  expect(board.userRequestRights("p", t.id)).toBeNull();
  await board.chat("p", t.id, "move X to done");
  expect(board.userRequestRights("p", t.id)?.id).toBe(t.id);
  await settle();
  expect(board.userRequestRights("p", t.id)).toBeNull();
  // A message from another run (chat_ticket) doesn't hand the user's rights on.
  await board.chat("p", t.id, "from a run", { fromPlanner: true });
  expect(board.isRunning("p", t.id)).toBe(true);
  expect(board.userRequestRights("p", t.id)).toBeNull();
  await settle();
  // A chat outside Backlog/Planning acts (bypassPermissions) and keeps the planner-only rights.
  const r = await board.createTicket("p", { title: "Reviewed", body: "", status: "review" });
  await board.chat("p", r.id, "move X to done");
  expect(board.userChatRun("p", r.id)).toBe(true);
  expect(board.userRequestRights("p", r.id)).toBeNull();
  await settle();
}, 60_000);
