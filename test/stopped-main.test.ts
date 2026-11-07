// Stop on a main ticket holds its steps only until the user acts on it again (moves it to ready, writes in its chat),
// a Stop that only cut off its own reply doesn't pause at all, and a still-paused main ticket's Claude is told so.
import { expect, test } from "bun:test";
import { createServer } from "../src/server/http";
import { familyCard } from "../src/server/main-ticket";
import { MAIN_PAUSED, mainTicketRules } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { board, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { tempDir } from "./helpers";

useBoardEnv();

const g = (id: string) => store.getTicket("p", id)!;

/** A main ticket in Review with a running plan and one running build step. */
async function stoppedMain(opts: { running?: boolean } = { running: true }) {
  await setup();
  const main = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
  store.updateTicket("p", main.id, { status: "review", outcome: "done" });
  board.ensurePlan("p", main.id);
  let step: Ticket | null = null;
  if (opts.running) {
    step = await board.createTicket("p", { title: "Build it", body: "", status: "backlog", mode: "auto", parentId: main.id, tool: true, kind: "build" });
    store.updateTicket("p", step.id, { status: "in_progress" });
  }
  board.stopFamily("p", main.id);
  return { main, step };
}

/** A new step the main ticket's Claude creates now. */
async function newStep(mainId: string) {
  const t = await board.createTicket("p", { title: "Next step", body: "", status: "backlog", mode: "auto", parentId: mainId, tool: true, kind: "explore" });
  board.ensurePlan("p", mainId);
  board.advancePlans("p");
  return g(t.id);
}

test("Stop that only cuts off the main ticket's own reply doesn't pause its steps", async () => {
  const { main } = await stoppedMain({ running: false });
  expect(g(main.id).plan?.state).toBe("running");
  expect(["ready", "in_progress"]).toContain((await newStep(main.id)).status);
  board.stopFamily("p", main.id);
  await board.whenIdle();
});

test("Stop with a running step pauses; the user moving the main ticket to ready resumes it and new steps start", async () => {
  const { main } = await stoppedMain();
  expect(g(main.id).plan?.state).toBe("paused");
  expect((await newStep(main.id)).status).toBe("backlog");
  const server = createServer({ store, bus: (board as any).bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/tickets/${main.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "ready" }),
    });
    expect(res.status).toBe(200);
    expect(g(main.id).plan?.state).toBe("running");
    expect(store.listComments("p", main.id).some((c) => c.text.includes("Plan resumed: you moved it to ready"))).toBe(true);
    const waiting = store.listTickets("p").filter((t) => t.tool && t.title === "Next step")[0];
    expect(["ready", "in_progress"]).toContain(g(waiting.id).status);
  } finally {
    server.stop(true);
    board.stopFamily("p", main.id);
    await board.whenIdle();
  }
});

test("a message the user types in a stopped main ticket's chat resumes its steps; a step created in that reply starts", async () => {
  const { main } = await stoppedMain();
  expect(g(main.id).plan?.state).toBe("paused");
  await board.chat("p", main.id, "Build the outreach queue next");
  expect(g(main.id).plan?.state).toBe("running");
  expect(["ready", "in_progress"]).toContain((await newStep(main.id)).status);
  board.stopFamily("p", main.id);
  await board.whenIdle();
});

test("a still-paused main ticket's run is told its steps are paused, and its card says Paused", async () => {
  const { main } = await stoppedMain();
  // A message from another ticket's run is not the user acting: the pause holds.
  await board.chat("p", main.id, "status?", { fromPlanner: true });
  expect(g(main.id).plan?.state).toBe("paused");
  await untilSpawned(1);
  await board.whenIdle();
  const args = readArgs().at(-1)!.args.join("\n");
  expect(args).toContain("Your tasks are paused because the user pressed Stop");
  expect(MAIN_PAUSED).toContain("Never say a task is queued");
  expect(mainTicketRules({ kind: "main", repo: "local", branch: null, inPlace: true })).not.toContain("Your tasks are paused");
  const card = familyCard(g(main.id), store.listTickets("p").filter((t) => t.parentId === main.id), store.listTickets("p"), () => false, 0);
  expect(card.line).toEqual({ text: "Paused: new tasks wait until you press Resume", tone: "warn" });
}, 60_000);

test("plan_control: a main ticket's own chat reply may resume its own paused plan", async () => {
  const { main } = await stoppedMain();
  expect(g(main.id).plan?.state).toBe("paused");
  // A reply from the main ticket's own run (any non-quiet run of a manager has planner rights).
  (board as any).runs.set(`p/${main.id}`, { slug: "p", id: main.id, stopRequested: false, chat: { text: "go on", mode: "act", user: true } });
  try {
    expect(board.plannerRights("p", main.id)?.id).toBe(main.id);
  } finally {
    (board as any).runs.delete(`p/${main.id}`);
  }
  board.startPlan("p", main.id, { byPlanner: true });
  expect(g(main.id).plan?.state).toBe("running");
});
