// A new tool ticket starts on its own (t_20261106_1045): seen on AI Outreach, whose card sat in Done while the user kept
// chatting with it, so the plan was parked and every new step waited in Backlog until the main ticket moved it by hand.
import { expect, test } from "bun:test";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { createServer } from "../src/server/http";
import { planStep } from "../src/server/plan";
import type { Plan, Ticket } from "../src/server/types";
import { board, bus, FAKE, setBoard, setup, store, useBoardEnv } from "./board-env";
import { tempDir } from "./helpers";

useBoardEnv();

const get = (id: string) => store.getTicket("p", id)!;
const started = (id: string) => get(id).status !== "backlog";

/** A main ticket in `status` with a running plan, a server, and create_ticket as the main ticket's own run (or `asId`'s). */
async function withMain(status: Ticket["status"], f: (x: { main: Ticket; create: (args: Record<string, unknown>, asId?: string) => Promise<Ticket> }) => Promise<void>) {
  const p = await setup();
  setBoard(new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, planWakeDelayMs: 30 }));
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const made = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
    const main = store.updateTicket("p", made.id, { status, outcome: "done" });
    board.ensurePlan("p", main.id);
    // Runs of these tickets are going (the main ticket's chat reply, a round's work run).
    const real = board.plannerRights.bind(board);
    board.plannerRights = (slug, id) => (store.getTicket(slug, id)?.main || store.getTicket(slug, id)?.tool ? store.getTicket(slug, id)! : real(slug, id));
    const create = async (args: Record<string, unknown>, asId = main.id) => {
      const ctx: ToolContext = { client: new BoardClient(server.port!), cwd: p.path, env: { CKANBAN_TICKET: `p/${asId}` } };
      const r = await callTool("create_ticket", { profile: "p", ...args }, ctx);
      expect(r.isError).toBeUndefined();
      return store.listTickets("p").find((t) => t.title === args.title)!;
    };
    await f({ main, create });
  } finally {
    board.stopAll();
    await board.whenIdle();
    server.stop(true);
  }
}

test("a main ticket in Done whose own run makes a tool ticket goes back to Review, and the step starts", async () => {
  await withMain("done", async ({ main, create }) => {
    const t = await create({ title: "Does Optimize work for Outbound?", kind: "explore" });
    expect(started(t.id)).toBe(true);
    expect(get(main.id).status).toBe("review");
    expect(store.listComments("p", main.id).some((c) => c.text.startsWith("Moved back from Done"))).toBe(true);
  });
});

test("the same from Backlog", async () => {
  await withMain("backlog", async ({ main, create }) => {
    const t = await create({ title: "Look around", kind: "explore" });
    expect(started(t.id)).toBe(true);
    expect(get(main.id).status).toBe("review");
  });
});

test("a step made by a tool ticket's run doesn't undo the user's park", async () => {
  await withMain("review", async ({ main, create }) => {
    const round = await create({ title: "Testing round 1", kind: "round" });
    store.updateTicket("p", main.id, { status: "done" });
    const t = await create({ title: "Test sign-in", kind: "test" }, round.id);
    expect(get(t.id).parentId).toBe(round.id);
    expect(get(main.id).status).toBe("done");
  });
});

test("a main ticket with 2 running tool tickets (same device) and a round in Review makes a 3rd, and it starts", async () => {
  await withMain("review", async ({ main, create }) => {
    const a = await create({ title: "No-call lines", kind: "test", needs: ["chrome-respondio"] });
    const b = await create({ title: "Live calls", kind: "with_you", needs: ["leo-phone"] });
    const r = await create({ title: "Testing round 1", kind: "round" });
    board.stopAll();
    await board.whenIdle();
    store.updateTicket("p", a.id, { status: "in_progress", outcome: null });
    store.updateTicket("p", b.id, { status: "in_progress", outcome: null });
    store.updateTicket("p", r.id, { status: "review", outcome: "needs_input" });
    const c = await create({ title: "Optimize on staging", kind: "test", needs: ["chrome-respondio"] });
    expect(started(c.id)).toBe(true);
    expect(get(main.id).status).toBe("review");
  });
});

// ---- the next-step picker itself (pure) ----
const at = (m: number) => new Date(Date.UTC(2026, 10, 6, 7, m)).toISOString();
const tk = (id: string, x: Partial<Ticket> = {}) => ({
  id, title: id, status: "backlog", outcome: null, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: at(Number(id.replace(/\D/g, "") || 0)), updatedAt: at(0),
  mode: "auto", parentId: "M", tool: true, ...x,
}) as Ticket;
const plan = { state: "running", maxConcurrent: 2, wakeups: 0, startedAt: at(0), originalCount: 0, inbox: [], seen: {}, retries: {}, awaiting: null } as Plan;
const managed = { managed: { summary: () => "", report: () => null } };
const step = (kids: Ticket[], running: string[] = []) => planStep(plan, kids, (id) => running.includes(id), managed);

test("picker: device needs, a round in Review, a with-you step waiting on the user and done steps take no slot", () => {
  const kids = [
    tk("t1", { kind: "test", needs: ["chrome-respondio"], status: "in_progress" }),
    tk("t2", { kind: "with_you", needs: ["leo-phone"], status: "review", outcome: "needs_input" }),
    tk("t3", { kind: "round", status: "review", outcome: "needs_input" }),
    tk("t4", { kind: "explore", status: "done", outcome: "done" }),
    tk("t5", { kind: "test", needs: ["chrome-respondio"] }),
    tk("t6", { kind: "explore" }),
    tk("t7", { kind: "test" }),
  ];
  expect(step(kids, ["t1"]).start).toEqual(["t5", "t6", "t7"]);
});

test("picker: no build/fix cap and no per-plan limit for a main ticket's family; dependsOn order holds", () => {
  const kids = [
    tk("b1", { kind: "build", status: "in_progress" }),
    tk("b2", { kind: "fix", status: "ready" }),
    tk("b3", { kind: "build" }),
    tk("f4", { kind: "fix" }),
    tk("e5", { kind: "explore" }),
    tk("t6", { kind: "test", dependsOn: ["b1"] }),
  ];
  expect(step(kids, ["b1"]).start).toEqual(["b3", "f4", "e5"]);
  // b1 finishes: its dependent starts.
  const done = kids.map((k) => (k.id === "b1" ? { ...k, status: "done" as const, outcome: "done" as const } : k));
  expect(step(done).start).toContain("t6");
});

test("a main ticket with 4 tool tickets and no dependencies starts all 4 (plan maxConcurrent 2 doesn't apply)", async () => {
  await withMain("review", async ({ main, create }) => {
    expect(get(main.id).plan?.maxConcurrent).toBe(2);
    const ts = [];
    for (const [title, kind] of [["Build A", "build"], ["Build B", "build"], ["Fix C", "fix"], ["Look D", "explore"]] as const) ts.push(await create({ title, kind }));
    for (const t of ts) expect(started(t.id)).toBe(true);
  });
});

test("two tool tickets with the same needs both start (they take the device in turn at run time)", async () => {
  await withMain("review", async ({ create }) => {
    const a = await create({ title: "Test A", kind: "test", needs: ["chrome-respondio"] });
    const b = await create({ title: "Test B", kind: "test", needs: ["chrome-respondio"] });
    expect(started(a.id)).toBe(true);
    expect(started(b.id)).toBe(true);
  });
});

test("a tool ticket's dependent starts right after it finishes, also when the main ticket's plan is stuck", async () => {
  await withMain("review", async ({ main, create }) => {
    const a = await create({ title: "Build the queue", kind: "build" });
    board.stopAll();
    await board.whenIdle();
    store.updateTicket("p", a.id, { status: "in_progress", outcome: null });
    const b = await create({ title: "Test the queue", kind: "test", dependsOn: [a.id] });
    expect(get(b.id).status).toBe("backlog");
    // Its stopped run left the plan stuck ("nothing can run"): it still starts steps, it just isn't woken.
    expect(get(main.id).plan?.state).toBe("stuck");
    await board.updateTicket("p", a.id, { status: "done" });
    expect(started(b.id)).toBe(true);
  });
});
