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
