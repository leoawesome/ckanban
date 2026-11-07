// A main ticket in Done kept falling back to Done after the user asked it for more (t_20261106_uvjg, seen on AI
// Outreach): its replies and wakes never move its card, so it stayed in the (collapsed) Done column. Now the user's
// message brings it back to Review, where it stays until the user parks it again.
import { expect, test } from "bun:test";
import { Board } from "../src/server/board";
import type { Ticket } from "../src/server/types";
import { board, bus, FAKE, setBoard, setup, store, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();

const get = (id: string) => store.getTicket("p", id)!;
const notes = (id: string) => store.listComments("p", id).map((c) => c.text);

async function mkMain(status: Ticket["status"], plan = true): Promise<Ticket> {
  await setup();
  setBoard(new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, planWakeDelayMs: 30 }));
  const t = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
  if (plan) board.ensurePlan("p", t.id);
  return store.updateTicket("p", t.id, { status, outcome: "done" });
}

const mkTool = (parent: string, status: Ticket["status"]) => board.createTicket("p", { title: "Live calls", body: "", status: "backlog", mode: "auto", parentId: parent, tool: true, kind: "test" })
  .then((t) => store.updateTicket("p", t.id, { status, outcome: status === "done" ? "done" : null }));

test("a main ticket in Done: the user asks for more, it moves to Review and stays there after the reply", async () => {
  const main = await mkMain("done");
  await board.chat("p", main.id, "continue testing");
  expect(get(main.id).status).toBe("review");
  await untilSpawned(1);
  await board.whenIdle();
  expect(get(main.id).status).toBe("review");
  expect(notes(main.id)).toContain("Moved back from Done: you wrote in its chat.");
  // The user's own move parks it again, and a later wake with nothing at work leaves it there.
  await board.updateTicket("p", main.id, { status: "done" }, { byUser: true });
  expect(get(main.id).status).toBe("done");
}, 30_000);

test("a main ticket parked in Backlog after its family started goes to Review; a new one is shaped in Planning", async () => {
  const main = await mkMain("backlog");
  await board.chat("p", main.id, "go on");
  expect(get(main.id).status).toBe("review");
  await board.whenIdle();
  expect(get(main.id).status).toBe("review");
  const fresh = await board.createTicket("p", { title: "New feature", body: "", status: "backlog", mode: "auto", main: true });
  await board.chat("p", fresh.id, "let's shape it");
  expect(get(fresh.id).status).toBe("planning");
  await board.whenIdle();
}, 30_000);

test("messages from other tickets don't undo the user's park", async () => {
  const main = await mkMain("done");
  await board.chat("p", main.id, "status?", { fromPlanner: true, from: { ticketId: "t_x", title: "Other" } });
  expect(get(main.id).status).toBe("done");
  await board.whenIdle();
  expect(get(main.id).status).toBe("done");
}, 30_000);

test("a follow-up on a main ticket in Done with a step at work brings it to Review; with nothing at work it stays in Done", async () => {
  const main = await mkMain("done");
  const followUp = { dueAt: new Date().toISOString(), note: "Check the calls", setAt: new Date().toISOString() };
  store.updateTicket("p", main.id, { followUp } as Partial<Ticket>);
  await board.wakeFollowUp("p", main.id, { manual: true });
  await board.whenIdle();
  expect(get(main.id).status).toBe("done");

  await mkTool(main.id, "in_progress");
  store.updateTicket("p", main.id, { followUp } as Partial<Ticket>);
  await board.wakeFollowUp("p", main.id, { manual: true });
  expect(get(main.id).status).toBe("review");
  await board.whenIdle();
  expect(get(main.id).status).toBe("review");
  expect(notes(main.id).some((n) => n.startsWith("Moved back from Done: its follow-up came"))).toBe(true);
}, 30_000);

test("a plan wake of a main ticket in Done with a step at work doesn't leave it in Done", async () => {
  const main = await mkMain("done");
  const tool = await mkTool(main.id, "review");
  store.updateTicket("p", tool.id, { outcome: "needs_input" });
  const t = get(main.id);
  (board as any).wake("p", t, t.plan, "event", ["Live calls needs you"], [get(tool.id)]);
  expect(get(main.id).status).toBe("review");
  await board.whenIdle();
  expect(get(main.id).status).toBe("review");
}, 30_000);

test("a plan wake of a main ticket in Done whose steps are all done leaves it in Done", async () => {
  const main = await mkMain("done");
  const tool = await mkTool(main.id, "done");
  const t = get(main.id);
  (board as any).wake("p", t, t.plan, "event", ["Live calls finished"], [get(tool.id)]);
  await board.whenIdle();
  expect(get(main.id).status).toBe("done");
}, 30_000);

test("an ordinary ticket in Done: the user's message that asks for work ends in Review (unchanged)", async () => {
  await setup();
  const t = await board.createTicket("p", { title: "Plain", body: "", status: "backlog", mode: "auto" });
  store.updateTicket("p", t.id, { status: "done", outcome: "done" });
  await board.chat("p", t.id, "fix one more thing");
  await untilSpawned(1);
  await board.whenIdle();
  expect(get(t.id).status).toBe("review");
}, 30_000);

// t_20261107_4gsl, seen on spendshare t_20261107_6tqm: the main ticket in Done got a message (Review), its run made a
// fix step and ended done, and minutes later the PR poller saw its milestone PR (merged long before) and moved the card
// to Done while the step still ran. Parked in Done, its wake for the finished step never came either.
test("a Done main ticket with a merged PR: a message, a new step, the poller: In progress until the step ends, then Review", async () => {
  const { checkPr } = await import("../src/server/prpoller");
  const { groupByColumn } = await import("../web/src/columns");
  const main = await mkMain("done");
  store.updateTicket("p", main.id, { prUrl: "https://github.com/x/y/pull/12" });
  await board.chat("p", main.id, "three more fixes please");
  expect(get(main.id).status).toBe("review");
  await untilSpawned(1);
  // The run makes a step (queued) and ends done.
  const step = await mkTool(main.id, "ready");
  await board.whenIdle();
  // (The fake Claude would finish the step at once; hold it as waiting to start.)
  store.updateTicket("p", step.id, { status: "ready", outcome: null });
  const column = () => {
    const t = get(main.id);
    const placed = { ...t, familyWorking: board.familyWorking("p", main.id), stepsRunning: board.stepsRunning("p", main.id) };
    return [...groupByColumn([placed])].find(([, l]) => l.length)![0];
  };
  const merged = async () => "MERGED" as const;
  // The poller sees the old merge while the step waits or runs: the card stays put and shows In progress.
  await checkPr(board, store, "p", main.id, merged);
  expect(get(main.id).status).toBe("review");
  expect(column()).toBe("in_progress");
  store.updateTicket("p", step.id, { status: "in_progress" });
  await checkPr(board, store, "p", main.id, merged);
  expect(column()).toBe("in_progress");
  // The last step finishes: Review (the user wrote after Done), and the poller doesn't send it back to Done.
  store.updateTicket("p", step.id, { status: "done", outcome: "done" });
  await checkPr(board, store, "p", main.id, merged);
  expect(get(main.id).status).toBe("review");
  expect(column()).toBe("review");
  // Only the user's own move parks it again.
  await board.updateTicket("p", main.id, { status: "done" }, { byUser: true });
  expect(column()).toBe("done");
}, 30_000);

test("a main ticket never in Done with no open steps still goes to Done when its PR merges", async () => {
  const { checkPr } = await import("../src/server/prpoller");
  const main = await mkMain("review");
  store.updateTicket("p", main.id, { prUrl: "https://github.com/x/y/pull/12" });
  await checkPr(board, store, "p", main.id, async () => "MERGED");
  expect(get(main.id).status).toBe("done");
}, 30_000);

test("a main card in Done shows In progress while one of its steps runs, not for a ticket the user added", async () => {
  const { groupByColumn } = await import("../web/src/columns");
  const { cardFamily } = await import("../web/src/cardState");
  const main = await mkMain("done");
  const step = await mkTool(main.id, "in_progress");
  const added = await board.createTicket("p", { title: "Landing copy", body: "", status: "backlog", mode: "auto", partOf: main.id });
  store.updateTicket("p", added.id, { status: "in_progress" });
  const running = new Set<string>([added.id]);
  (board as any).isRunning = (_s: string, id: string) => running.has(id);
  const col = () => {
    const placed = { ...get(main.id), familyWorking: board.familyWorking("p", main.id), stepsRunning: board.stepsRunning("p", main.id) };
    return [...groupByColumn([placed])].find(([, l]) => l.length)![0];
  };
  expect(board.stepsRunning("p", main.id)).toBe(0);
  expect(col()).toBe("done");
  running.add(step.id);
  expect(board.stepsRunning("p", main.id)).toBe(1);
  expect(col()).toBe("in_progress");
  const fc = { tools: 1, running: ["Live calls"], working: ["Live calls"] };
  expect(cardFamily({ status: "done", main: true, familyCard: fc, stepsRunning: 1 }, false).working).toBe(true);
  expect(cardFamily({ status: "done", main: true, familyCard: fc }, false).working).toBe(false);
}, 30_000);
