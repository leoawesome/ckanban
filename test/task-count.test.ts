// One rule behind every "N of M done" (audit B24): the status's count (taskProgress over statusFacts), the Tasks tab
// badge (taskTally over featureRows) and the Tasks list head (featureTasks over the tab's newest-first rows) agree.
import { expect, test } from "bun:test";
import { featureRows, featureTasks, newestFirst, taskTally } from "../web/src/family";
import { taskProgress } from "../web/src/tasksText";
import { statusFacts } from "../src/board/feature";
import type { Ticket } from "../src/core/types";

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
