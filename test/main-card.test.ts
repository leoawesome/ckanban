// The main ticket's card tells the truth while its feature works: any family ticket working (tool tickets from the
// first one, tickets the user added) keeps it working, a failed step says "Step failed" in red, progress is in words.
import { expect, test } from "bun:test";
import { attentionFor } from "../src/server/attention";
import { familyCard, stepWait } from "../src/server/main-ticket";
import type { Ticket } from "../src/server/types";
import { attentionLabel, cardFamily, stepsText } from "../web/src/cardState";
import { groupByColumn } from "../web/src/columns";
import { board, setup, store, useBoardEnv } from "./board-env";

useBoardEnv();

const at = (min: number) => new Date(Date.UTC(2026, 10, 6, 10, min)).toISOString();
const tk = (id: string, x: Partial<Ticket> = {}) => ({
  id, title: id, status: "backlog", outcome: null, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: at(0), updatedAt: at(0), mode: "auto", ...x,
}) as Ticket;
const none = () => false;

test("a ticket the user added to the feature keeps the main card working: line, stripe, no Your turn or D done", () => {
  const main = tk("M", { title: "AI Outreach", main: true, status: "review", outcome: "done", runEndedAt: at(1) });
  const done = tk("B", { title: "the queue", parentId: "M", tool: true, kind: "build", status: "done", outcome: "done" });
  const added = tk("U", { title: "Landing copy", partOf: "M", status: "in_progress", runStartedAt: at(5) });
  const fc = familyCard(main, [done, added], [main, done, added], none, 3);
  expect(fc.working).toEqual(["Landing copy"]);
  // Stop's count stays tool tickets only (it leaves added tickets alone).
  expect(fc.running).toEqual([]);
  expect(fc.line).toEqual({ text: "Landing copy", tone: "work" });
  // The card: working stripe and line; its "check the result" strip and the D done hint wait until the feature rests.
  const card = { ...main, familyCard: fc, attention: { kind: "review", label: "Check the result", since: at(1) } };
  const v = cardFamily(card, false);
  expect(v).toMatchObject({ familyWorks: true, working: true, att: null, doneHint: false });
  // A strip that needs the user stays, and says "Needs you", never "Your turn".
  const asks = cardFamily({ ...card, attention: { kind: "questions", label: "Which plan?", since: at(1) } }, false);
  expect(asks.att?.kind).toBe("questions");
  expect(attentionLabel(asks.att!, 0, asks.familyWorks)).toBe("Needs you");
  // At rest: Your turn and D done again.
  const rest = cardFamily({ ...card, familyCard: { ...fc, working: [] } }, false);
  expect(rest).toMatchObject({ working: false, doneHint: true });
  expect(attentionLabel(rest.att!, 0, false)).toBe("Your turn");
  // Parked in Done it stays parked and quiet (columns.ts familyBusy only moves Review and Planning).
  expect(cardFamily({ ...card, status: "done" }, false).working).toBe(false);
  expect(groupByColumn([{ id: "M", status: "done", order: 0, main: true, familyWorking: 1 }]).get("done")!.map((t) => t.id)).toEqual(["M"]);
  expect(groupByColumn([{ id: "M", status: "review", order: 0, main: true, familyWorking: 1 }]).get("in_progress")!.map((t) => t.id)).toEqual(["M"]);
});

test("board.familyWorking counts tickets the user added, not the main ticket itself", async () => {
  await setup();
  const main = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
  store.updateTicket("p", main.id, { status: "in_progress" });
  expect(board.familyWorking("p", main.id)).toBe(0);
  const added = await board.createTicket("p", { title: "Landing copy", body: "", status: "backlog", mode: "auto", partOf: main.id });
  store.updateTicket("p", added.id, { status: "in_progress" });
  expect(board.familyWorking("p", main.id)).toBe(1);
  expect(board.familyCard("p", main.id)?.working).toEqual(["Landing copy"]);
});

test("one tool ticket is enough for the card's working line and step count", () => {
  const main = tk("M", { title: "AI Outreach", main: true, status: "review", outcome: "done" });
  const one = tk("E", { title: "Look around", parentId: "M", tool: true, kind: "explore", status: "in_progress", runStartedAt: at(2) });
  const fc = familyCard(main, [one], [main, one], (id) => id === "E", 0);
  expect(fc.tools).toBe(1);
  expect(fc.line?.tone).toBe("work");
  const v = cardFamily({ ...main, familyCard: fc }, false);
  expect(v.fc).toBe(fc);
  expect(v.working).toBe(true);
  expect(stepsText(fc)).toBe("0 of 1 task");
  // No family at all: no feature summary on the card.
  expect(cardFamily({ ...main, familyCard: { ...fc, tools: 0, working: [], running: [] } }, false).fc).toBeNull();
});

test("progress in words: finished tool tickets of all of them", () => {
  const main = tk("M", { title: "AI Outreach", main: true, status: "review" });
  const tools = Array.from({ length: 16 }, (_, i) => tk(`T${i}`, { parentId: "M", tool: true, kind: "build", status: i < 7 ? "done" : "backlog" }));
  const added = tk("U", { partOf: "M", status: "done" });
  const fc = familyCard(main, [...tools, added], [main, ...tools, added], none, 41);
  expect(fc).toMatchObject({ tools: 16, toolsDone: 7 });
  expect(stepsText(fc)).toBe("7 of 16 tasks");
});

test("a failed step reads Step failed with its reason, and the card's line is red", () => {
  const main = tk("M", { title: "AI Outreach", main: true, status: "review", outcome: "done", runEndedAt: at(1) });
  const bad = tk("F", { title: "staging check", parentId: "M", tool: true, kind: "test", status: "review", outcome: "failed", error: "Run failed\ncouldn't log in to staging", runEndedAt: at(9) });
  const step = stepWait(bad, false)!;
  const att = attentionFor(main, null, false, { step })!;
  expect(att).toMatchObject({ kind: "failed", step: "failed", label: "Test: staging check failed: couldn't log in to staging" });
  expect(attentionLabel(att, 0, false)).toBe("Task failed");
  expect(familyCard(main, [bad], [main, bad], none, 0).line).toEqual({ text: "Test: staging check failed: couldn't log in to staging", tone: "fail" });
  // The main ticket's own failure stays "Your turn"; a step asking a question is amber.
  expect(attentionLabel({ kind: "failed" }, 0, false)).toBe("Your turn");
  const ask = { ...bad, outcome: "needs_input" } as Ticket;
  expect(familyCard(main, [ask], [main, ask], none, 0).line?.tone).toBe("warn");
});
