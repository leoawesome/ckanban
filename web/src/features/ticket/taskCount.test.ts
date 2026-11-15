// One rule behind every "N of M done" (audit B24): the status's count (taskProgress over statusFacts), the Tasks tab
// badge (taskTally over featureRows) and the Tasks list head (featureTasks over the tab's newest-first rows) agree.
import { expect, test } from "bun:test";
import { featureRows, featureTasks, newestFirst, taskTally, tasksUnder } from "../family/family";
import { planDone } from "../family/planText";
import { familyCard } from "../../../../src/board/main-ticket";
import { stepsText } from "../board/cardState";
import { taskProgress } from "./tasksText";
import { statusFacts } from "../../../../src/board/feature";
import type { Ticket } from "../../../../src/core/types";

let n = 0;
const tk = (id: string, x: Partial<Ticket> = {}) => ({
  id, title: id, status: "backlog", outcome: null, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: new Date(Date.UTC(2026, 10, 15, 10, n++)).toISOString(),
  updatedAt: "2026-11-15T10:00:00.000Z", mode: "auto", ...x,
}) as Ticket;

/**
 * M with: a loose done task; group G holding a done task, a waiting task and nested group G2 (two tasks, one passed
 * test); a task P that holds a task of its own; sub-feature S with a task (S's, not M's); an empty group E.
 */
function family() {
  return [
    tk("M", { main: true, status: "in_progress" }),
    tk("T1", { parentId: "M", tool: true, kind: "build", status: "done" }),
    tk("G", { parentId: "M", tool: true, kind: "group" }),
    tk("G1", { parentId: "G", tool: true, kind: "build", status: "done" }),
    tk("G2", { parentId: "G", tool: true, kind: "group", status: "done" }),
    tk("G21", { parentId: "G2", tool: true, kind: "test", status: "done", verdict: "passed" }),
    tk("G22", { parentId: "G2", tool: true, kind: "build", status: "in_progress" }),
    tk("G3", { parentId: "G", tool: true, kind: "build", status: "review" }),
    tk("P", { parentId: "M", tool: true, kind: "build", status: "done" }),
    tk("P1", { parentId: "P", tool: true, kind: "build" }),
    tk("S", { main: true, partOf: "M", status: "review" }),
    tk("S1", { parentId: "S", tool: true, kind: "build", status: "done" }),
    tk("E", { parentId: "M", tool: true, kind: "group" }),
    tk("X", { status: "done" }),
  ];
}

test("the status, the Tasks tab badge and the list head count the same tasks", () => {
  const ts = family();
  const status = taskProgress(statusFacts(ts, "M", () => false));
  const badge = taskTally(featureRows(ts, "M"));
  const head = featureTasks(newestFirst(featureRows(ts, "M"))).length;
  // Tasks: T1, G1, G21, G22, G3, P1. Done: T1, G1, G21 (a passed test is finished).
  expect(status).toEqual({ done: 3, total: 6 });
  expect(badge).toEqual(status);
  expect(head).toBe(status.total);
  expect(featureTasks(featureRows(ts, "M")).map((t) => t.id).sort()).toEqual(["G1", "G21", "G22", "G3", "P1", "T1"]);
  // A task's badge counts its whole feature too; a sub-feature counts only its own tasks.
  expect(taskTally(featureRows(ts, "G22"))).toEqual(status);
  expect(taskTally(featureRows(ts, "S"))).toEqual(taskProgress(statusFacts(ts, "S", () => false)));
  expect(taskTally(featureRows(ts, "S"))).toEqual({ done: 1, total: 1 });
});

test("a ticket with no tasks counts none", () => {
  const ts = family();
  expect(taskTally(featureRows(ts, "X"))).toEqual({ done: 0, total: 0 });
});

/**
 * An old plan moved over (t_20261029_y7ug's shape): five loose tasks, a group that did its own work holding three tasks
 * and a nested group (one task), and a card the user linked. Every count reads 9 tasks: the groups don't count, the
 * tasks inside them each count once.
 */
test("nested groups: the badge, the list head, the plan, Plan finished and the card all count the same tasks", () => {
  const ts = [
    tk("Y", { main: true, status: "done" }),
    ...["A", "B", "C", "D"].map((id) => tk(id, { parentId: "Y", tool: true, kind: "build", status: "done" })),
    tk("K", { parentId: "Y", tool: true, kind: "group", status: "done" }),
    tk("K1", { parentId: "K", partOf: "K", tool: true, kind: "build", status: "done" }),
    tk("K2", { parentId: "K", tool: true, kind: "build", status: "done" }),
    tk("V", { parentId: "K", tool: true, kind: "group", status: "review", outcome: "needs_input" }),
    tk("V1", { parentId: "V", tool: true, kind: "review", status: "done" }),
    tk("K3", { parentId: "K", tool: true, kind: "build", status: "done" }),
    tk("L", { partOf: "Y", status: "done" }),
  ];
  const rows = featureRows(ts, "Y");
  const want = { done: 9, total: 9 };
  expect(taskTally(rows)).toEqual(want);
  expect(featureTasks(newestFirst(rows)).length).toBe(9);
  expect(planDone(tasksUnder(rows, "Y"))).toEqual({ finished: true, ...want });
  const fc = familyCard(ts[0], rows.slice(1).map((r) => r.ticket), ts, () => false, 0);
  expect({ done: fc.tasksDone, total: fc.tasks }).toEqual(want);
  expect(stepsText(fc)).toBe("9 of 9 tasks");
  // A group's own plan counts only the tasks inside it.
  expect(planDone(tasksUnder(rows, "K"))).toEqual({ finished: true, done: 4, total: 4 });
  expect(tasksUnder(rows, "V").map((t) => t.id)).toEqual(["V1"]);
});
