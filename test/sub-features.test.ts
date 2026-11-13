// Sub-features: a main ticket linked under another main ticket keeps its card, chat and tasks; its tasks report to it;
// family walks for the parent stop at it; one depth rule (linkProblem) on every path; "Show on board" and "Make it its
// own work" for tasks.
import { expect, test } from "bun:test";
import {
  featureRoot, featureRows, levelOf, linkProblem, mainTicketOf, onBoard, shownTool, subFeatureState, subFeaturesWorking, workingInFamily, type FeatureTicket,
} from "../web/src/family";
import { oldestStep } from "../src/server/attention";
import { statusFacts, statusSections } from "../src/server/feature";
import type { Ticket } from "../src/server/types";
import { board, setup, store, useBoardEnv } from "./board-env";

useBoardEnv();

const at = (min: number) => new Date(Date.UTC(2026, 10, 10, 10, min)).toISOString();
let n = 0;
const tk = (id: string, x: Partial<Ticket> = {}) => ({
  id, title: id, status: "backlog", outcome: null, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: at(n++), updatedAt: at(0), mode: "auto", ...x,
}) as Ticket;

/** AI Outreach (A) with a task; Linear mentions (L), a sub-feature of A, with a group and two tasks in it. */
function board1() {
  return [
    tk("A", { title: "AI Outreach", main: true, status: "review" }),
    tk("A1", { title: "Outreach task", parentId: "A", tool: true, kind: "build" }),
    tk("L", { title: "Linear mentions", main: true, partOf: "A", status: "review" }),
    tk("LG", { title: "Analysis", parentId: "L", tool: true, kind: "group" }),
    tk("L1", { title: "Mention 1", parentId: "LG", tool: true, kind: "explore", status: "in_progress" }),
    tk("L2", { title: "Mention 2", parentId: "L", tool: true, kind: "explore", status: "in_progress" }),
  ];
}

test("mainTicketOf: a sub-feature's tasks report to the sub-feature, the parent's to the parent", () => {
  const ts = board1();
  expect(mainTicketOf(ts, "L1")?.id).toBe("L");
  expect(mainTicketOf(ts, "L2")?.id).toBe("L");
  expect(mainTicketOf(ts, "L")?.id).toBe("A");
  expect(mainTicketOf(ts, "A1")?.id).toBe("A");
  expect(featureRoot(ts, "L1")?.id).toBe("L");
  expect(featureRoot(ts, "A1")?.id).toBe("A");
  // The parent's own feature has the sub-feature as one row, none of its tickets.
  expect(featureRows(ts, "A").map((r) => r.ticket.id)).toEqual(["A", "A1", "L"]);
  expect(featureRows(ts, "L1").map((r) => [r.ticket.id, r.depth])).toEqual([["L", 0], ["LG", 1], ["L1", 2], ["L2", 1]]);
  // A sub-feature starts its own depth count.
  expect(levelOf(ts, "L1")).toBe(2);
  expect(levelOf(ts, "L")).toBe(0);
});

test("workingInFamily counts a working sub-feature once and leaves out its tasks", () => {
  const ts = board1();
  const notRunning = () => false;
  // L itself rests in Review, but two of its tasks work: one item, the sub-feature.
  expect(workingInFamily(ts, "A", notRunning).map((t) => t.id)).toEqual(["L"]);
  expect(subFeaturesWorking(ts, "A", notRunning).map((t) => t.id)).toEqual(["L"]);
  // The parent's own task working too: two items.
  ts.find((t) => t.id === "A1")!.status = "ready";
  expect(workingInFamily(ts, "A", notRunning).map((t) => t.id).sort()).toEqual(["A1", "L"]);
  // The sub-feature counts its own tasks (the group is not working, its child is).
  expect(workingInFamily(ts, "L", notRunning).map((t) => t.id).sort()).toEqual(["L1", "L2"]);
  // A family list without the main ticket itself (the card's) still works.
  expect(workingInFamily(ts.filter((t) => t.id !== "A"), "A", notRunning).map((t) => t.id).sort()).toEqual(["A1", "L"]);
  // Nothing under L working: it isn't counted.
  for (const t of ts) if (t.id.startsWith("L")) t.status = "done";
  expect(subFeaturesWorking(ts, "A", notRunning)).toEqual([]);
});

test("linkProblem: one sub-feature level, a sub-feature's place in its parent, and the depth of the whole moved part", () => {
  const ts: FeatureTicket[] = [
    ...board1(),
    tk("G", { title: "Group", partOf: "A", kind: "group" }),
    tk("G1", { title: "Deep", partOf: "G" }),
    tk("X", { title: "Other work", main: true }),
    tk("X1", { title: "Other step", parentId: "X", tool: true }),
    tk("X2", { title: "Other deeper", parentId: "X1", tool: true }),
    tk("Y", { title: "Holder", main: true }),
    tk("Y1", { title: "Held", main: true, partOf: "Y" }),
    tk("P", { title: "Plain one" }),
    tk("P1", { title: "Plain child", partOf: "P" }),
    tk("P2", { title: "Plain grandchild", partOf: "P1" }),
  ];
  // A main ticket under a sub-feature, or under anything inside one.
  expect(linkProblem(ts, ts.find((t) => t.id === "X")!, "L")).toBe(`"Linear mentions" is already part of "AI Outreach"; a sub-feature can't hold another sub-feature.`);
  expect(linkProblem(ts, ts.find((t) => t.id === "X")!, "L1")).toBe(`"Linear mentions" is already part of "AI Outreach"; a sub-feature can't hold another sub-feature.`);
  expect(linkProblem(ts, { id: "new", title: "New", main: true }, "LG")).toContain("a sub-feature can't hold another sub-feature");
  // A main ticket that holds a sub-feature can't become one.
  expect(linkProblem(ts, ts.find((t) => t.id === "Y")!, "A")).toBe(`"Holder" has its own sub-feature "Held", so it can't become part of "AI Outreach"; a sub-feature can't hold another sub-feature.`);
  // A sub-feature under a top-level main ticket: its tasks count from it, so its depth doesn't matter.
  expect(linkProblem(ts, ts.find((t) => t.id === "X")!, "A")).toBeNull();
  expect(linkProblem(ts, ts.find((t) => t.id === "X")!, "G")).toBeNull();
  // The sub-feature itself sits at most 2 levels deep.
  expect(linkProblem(ts, ts.find((t) => t.id === "X")!, "G1")).toBe(
    `That would put "Other work" 3 levels deep; a feature keeps its tickets at most 2 levels deep. Put it under the feature "AI Outreach" (A) or one of its groups: "Group" (G).`,
  );
  // A plain ticket with children: the deepest one counts.
  expect(linkProblem(ts, ts.find((t) => t.id === "P1")!, "A")).toBeNull();
  expect(linkProblem(ts, ts.find((t) => t.id === "P")!, "A")).toContain(`That would put "Plain grandchild" (under "Plain one") 3 levels deep`);
  // gather's own check: only the moved ticket (it moves deeper ones up itself, and says so).
  expect(linkProblem(ts, ts.find((t) => t.id === "P")!, "G", { subtree: false })).toBeNull();
  // Inside a sub-feature, levels count from it.
  expect(linkProblem(ts, ts.find((t) => t.id === "P1")!, "L")).toBeNull();
  expect(linkProblem(ts, ts.find((t) => t.id === "P1")!, "LG")).toContain(`"Plain grandchild" (under "Plain child") 3 levels deep`);
});

test("show on board: a shown task gets a card, old tasks stay hidden", () => {
  expect(onBoard(tk("a", { tool: true }))).toBe(false);
  expect(onBoard(tk("a", { tool: true, showOnBoard: true }))).toBe(true);
  expect(onBoard(tk("a"))).toBe(true);
  expect(shownTool(tk("a", { tool: true, showOnBoard: true }))).toBe(true);
  expect(shownTool(tk("a", { showOnBoard: true }))).toBe(false);
});

test("needs-you and the status stop at a sub-feature", () => {
  const ts = board1();
  // A sub-feature's task fails: it waits on the sub-feature, not the parent.
  Object.assign(ts.find((t) => t.id === "L2")!, { status: "review", outcome: "failed", runEndedAt: at(30) });
  expect(oldestStep(ts, "A", () => false)).toBeNull();
  expect(oldestStep(ts, "L", () => false)?.id).toBe("L2");
  // The parent's status: the sub-feature as one line with its headline; its tasks' failures stay in its own status.
  const f = statusFacts(ts, "A", () => false, {}, (t) => ({ working: t.id === "L", headline: "Review 3 mentions" }));
  expect(f.size).toBe(3);
  expect(f.broken).toEqual([]);
  expect(f.subFeatures).toEqual([{ id: "L", title: "Linear mentions", state: "working", headline: "Review 3 mentions" }]);
  expect(statusSections(null, f).find((s) => s.key === "subfeatures")?.text).toBe("Linear mentions: Working · Review 3 mentions");
  expect(statusFacts(ts, "L", () => false).broken.map((b) => b.id)).toEqual(["L2"]);
});

// ---- On the board ----

const mk = (title: string, extra: Parameters<typeof board.createTicket>[1] extends infer I ? Partial<I> : never = {}) =>
  board.createTicket("p", { title, body: "", status: "backlog", mode: "auto", ...extra });
const get = (id: string) => store.getTicket("p", id)!;

test("setPartOf: a linked main ticket stays main; refusals say why and move nothing", async () => {
  await setup();
  const outreach = await mk("AI Outreach", { main: true });
  const linear = await mk("Linear mentions", { main: true });
  const task = await mk("Mention 1", { parentId: linear.id, tool: true, kind: "explore" });
  await board.setPartOf("p", linear.id, outreach.id);
  expect(get(linear.id).main).toBe(true);
  expect(get(linear.id).partOf).toBe(outreach.id);
  expect(board.mainOf("p", get(task.id))?.id).toBe(linear.id);
  // Its tasks are its own: not the parent's tool tickets, not stopped or deleted with it.
  expect(board.toolTickets("p", outreach.id).map((t) => t.id)).toEqual([]);
  expect(board.toolTickets("p", linear.id).map((t) => t.id)).toEqual([task.id]);
  expect(board.featureStatus("p", task.id).top.id).toBe(linear.id);

  // No sub-feature under a sub-feature.
  const other = await mk("Other work", { main: true });
  await expect(board.setPartOf("p", other.id, linear.id)).rejects.toThrow(`"Linear mentions" is already part of "AI Outreach"; a sub-feature can't hold another sub-feature.`);
  await expect(board.setPartOf("p", other.id, task.id)).rejects.toThrow("a sub-feature can't hold another sub-feature");
  expect(get(other.id).partOf ?? null).toBeNull();
  await expect(mk("New", { main: true, partOf: linear.id })).rejects.toThrow("a sub-feature can't hold another sub-feature");
  // And a ticket that holds a sub-feature can't become one.
  await expect(board.setPartOf("p", outreach.id, other.id)).rejects.toThrow(`"AI Outreach" has its own sub-feature "Linear mentions"`);
  // A loop is refused with the tickets' titles.
  await expect(board.setPartOf("p", outreach.id, linear.id)).rejects.toThrow(`"Linear mentions" is already inside "AI Outreach", so "AI Outreach" can't go under it.`);
  await expect(board.setPartOf("p", outreach.id, outreach.id)).rejects.toThrow(`"AI Outreach" can't be part of itself`);

  // The depth of the whole part that moves.
  const g = await mk("Group", { kind: "group", partOf: other.id });
  const plain = await mk("Plain one");
  store.updateTicket("p", plain.id, { main: false });
  await mk("Plain child", { partOf: plain.id });
  await expect(board.setPartOf("p", plain.id, g.id)).rejects.toThrow(`That would put "Plain child" (under "Plain one") 3 levels deep`);
  expect(get(plain.id).partOf ?? null).toBeNull();
  await board.setPartOf("p", plain.id, other.id);
  expect(get(plain.id).partOf).toBe(other.id);
});

test("unlinking a task or making it its own work gives a ticket that shows on the board", async () => {
  await setup();
  const outreach = await mk("AI Outreach", { main: true });
  const a = await mk("Task A", { parentId: outreach.id, tool: true, kind: "build" });
  const b = await mk("Task B", { parentId: outreach.id, tool: true, kind: "build" });
  const bKid = await mk("Task B's step", { parentId: b.id, tool: true, kind: "explore" });

  // Show on board, then unlink: it becomes its own work (no hidden task without a main ticket).
  board.setShowOnBoard("p", a.id, true);
  expect(get(a.id).showOnBoard).toBe(true);
  board.setShowOnBoard("p", a.id, false);
  expect(get(a.id).showOnBoard ?? null).toBeNull();
  expect(() => board.setShowOnBoard("p", outreach.id, false)).toThrow("is a main ticket: it keeps its own card on the board");
  await board.setPartOf("p", a.id, null);
  expect(get(a.id).tool).toBe(false);
  expect(onBoard(get(a.id))).toBe(true);
  expect(get(a.id).parentId ?? null).toBeNull();

  // Make it its own work, still linked: a sub-feature; its plan link becomes a plain link, its own task reports to it.
  await board.makeOwnWork("p", b.id);
  const nb = get(b.id);
  expect([nb.tool, nb.main, nb.partOf, nb.parentId ?? null]).toEqual([false, true, outreach.id, null]);
  expect(board.mainOf("p", get(bKid.id))?.id).toBe(b.id);
  expect(board.toolTickets("p", outreach.id).map((t) => t.id)).toEqual([]);
  await expect(board.makeOwnWork("p", b.id)).rejects.toThrow("is already its own work");

  // Inside a sub-feature it can't become a sub-feature: unlinking still works.
  await expect(board.makeOwnWork("p", bKid.id)).rejects.toThrow(
    `"Task B's step" can't become its own work here: it is inside the sub-feature "Task B", and a sub-feature can't hold another sub-feature. Unlink it first to make it top-level work.`);
  await board.setPartOf("p", bKid.id, null);
  expect(get(bKid.id).tool).toBe(false);
});

test("a sub-feature's task results reach the sub-feature, not the parent; the parent's card counts it once", async () => {
  await setup();
  (board as any).advancePlans = () => {};
  const outreach = await mk("AI Outreach", { main: true });
  const linear = await mk("Linear mentions", { main: true, partOf: outreach.id });
  const added = await mk("A ticket the user added", { partOf: linear.id });
  const t1 = await mk("Mention 1", { parentId: linear.id, tool: true, kind: "explore" });
  const t2 = await mk("Mention 2", { parentId: linear.id, tool: true, kind: "explore" });
  store.updateTicket("p", added.id, { status: "review", outcome: "done" });
  store.addComment("p", added.id, "ai", "Found 3 mentions.");
  (board as any).reportToMain("p", added.id, "Found 3 mentions.");
  expect(get(linear.id).results?.map((r) => r.ticketId)).toEqual([added.id]);
  expect(get(linear.id).plan?.inbox?.length).toBe(1);
  expect(get(outreach.id).results ?? []).toEqual([]);
  expect(get(outreach.id).plan ?? null).toBeNull();

  // The parent's card: the sub-feature is one working item, its tasks aren't the parent's.
  store.updateTicket("p", t1.id, { status: "in_progress" });
  store.updateTicket("p", t2.id, { status: "ready" });
  const card = board.familyCard("p", outreach.id)!;
  expect(card.subFeaturesRunning).toBe(1);
  expect(card.subFeatures).toEqual([{ id: linear.id, title: "Linear mentions", working: true }]);
  expect(card.working).toEqual(["Linear mentions"]);
  expect(card.tools).toBe(0);
  expect(board.familyWorking("p", outreach.id)).toBe(1);
  expect(board.familyWorking("p", linear.id)).toBe(2);
  // The parent's status shows it as one line.
  const f = board.featureStatus("p", outreach.id);
  expect(f.facts.subFeatures?.map((s) => [s.title, s.state])).toEqual([["Linear mentions", "working"]]);
});

test("stop on the parent reaches into its sub-features; delete leaves them as their own work", async () => {
  await setup();
  const outreach = await mk("AI Outreach", { main: true });
  const linear = await mk("Linear mentions", { main: true, partOf: outreach.id });
  const t1 = await mk("Mention 1", { parentId: linear.id, tool: true, kind: "explore" });
  board.ensurePlan("p", linear.id);
  store.updateTicket("p", t1.id, { status: "ready" });
  board.stopFamily("p", outreach.id);
  expect(get(t1.id).status).toBe("backlog");
  expect(get(linear.id).plan?.state).toBe("paused");
  expect(store.listComments("p", linear.id).some((c) => c.text === `Stopped with the feature "AI Outreach" it is part of.`)).toBe(true);

  await board.deleteTicket("p", outreach.id);
  expect(store.getTicket("p", outreach.id)).toBeFalsy();
  expect(get(linear.id).main).toBe(true);
  expect(get(linear.id).partOf ?? null).toBeNull();
  expect(get(t1.id).parentId).toBe(linear.id);
});

test("a plan never takes in a sub-feature (it would stop being one)", async () => {
  await setup();
  const outreach = await mk("AI Outreach", { main: true });
  const linear = await mk("Linear mentions", { main: true, partOf: outreach.id });
  const task = await mk("Mention 1", { parentId: linear.id, tool: true, kind: "explore" });
  const r = board.adoptTickets("p", outreach.id, [linear.id]);
  expect(r.adopted).toEqual([]);
  expect(r.skipped[0]?.reason).toContain("is a sub-feature with its own chat and tasks");
  expect(get(linear.id).main).toBe(true);
  expect(board.mainOf("p", get(task.id))?.id).toBe(linear.id);
});

test("a sub-feature's row reads Working while one of its tasks works, and its Tasks badge counts its own rows", () => {
  const ts = board1().map((t) => (t.id === "L1" || t.id === "L2" ? { ...t, status: "backlog" } : t));
  // L itself is in Review with nothing working: its own state.
  expect(subFeatureState(ts, "L", "waiting")).toBe("waiting");
  const one = ts.map((t) => (t.id === "L1" ? { ...t, running: true } : t));
  expect(subFeatureState(one, "L", "waiting")).toBe("working");
  expect(subFeatureState(ts.map((t) => (t.id === "L2" ? { ...t, status: "in_progress" } : t)), "L", "waiting")).toBe("working");
  // The badge (featureRows): A, its task and L once; L, its group and its two tasks.
  expect(featureRows(ts, "A").length).toBe(3);
  expect(featureRows(ts, "L").length).toBe(4);
});
