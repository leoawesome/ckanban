import { expect, test } from "bun:test";
import { findCycle, isComplete, planProblem, planStep as rawStep, resolveDeps, type PlanStepOptions } from "./plan";
import type { Plan, Ticket } from "../core/types";

let n = 0;
const T = (p: Partial<Ticket>): Ticket => ({
  id: `t_${++n}`, title: "x", status: "backlog", order: n, sessionId: null, worktree: null, branch: null, prUrl: null,
  outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`,
  updatedAt: "", body: "", parentId: "t_plan", tool: true, ...p,
} as Ticket);
const plan = (p: Partial<Plan> = {}): Plan => ({ state: "running", wakeups: 0, startedAt: "", originalCount: 5, ...p });
const idle = () => false;
const managed = { summary: (t: Ticket) => `did ${t.title}`, report: () => null };
const planStep = (p: Plan, kids: Ticket[], running: (id: string) => boolean, o: Partial<PlanStepOptions> = {}) => rawStep(p, kids, running, { managed, ...o });

function abcde() {
  const a = T({ title: "A", planKey: "a" });
  const b = T({ title: "B", planKey: "b", dependsOn: ["a"] });
  const c = T({ title: "C", planKey: "c", dependsOn: [a.id] });
  const d = T({ title: "D", planKey: "d", dependsOn: ["b", "c"] });
  const e = T({ title: "E", planKey: "e" });
  return { a, b, c, d, e, all: [a, b, c, d, e] };
}

test("dependencies resolve by key or id; unknown ones are reported", () => {
  const { a, b, c, all } = abcde();
  expect(resolveDeps(b, all).deps).toEqual([a]);
  expect(resolveDeps(c, all).deps).toEqual([a]);
  expect(resolveDeps(T({ dependsOn: ["nope"] }), all).missing).toEqual(["nope"]);
  expect(planProblem(all)).toBeNull();
  expect(planProblem([])).toContain("no tool tickets");
  expect(planProblem([...all, T({ title: "Z", dependsOn: ["ghost"] })])).toContain('"Z" depends on unknown ticket "ghost"');
});

test("cycles are found", () => {
  const x = T({ title: "X", planKey: "x", dependsOn: ["y"] });
  const y = T({ title: "Y", planKey: "y", dependsOn: ["x"] });
  expect(findCycle([x, y])).toEqual(["X", "Y", "X"]);
  expect(planProblem([x, y])).toContain("dependency cycle: X → Y → X");
  expect(findCycle(abcde().all)).toBeNull();
});

test("planStep starts every child whose dependencies are done, in order", () => {
  const { a, b, c, d, e, all } = abcde();
  expect(planStep(plan(), all, idle).start).toEqual([a.id, e.id]);
  // An old plan file's "at once" limit is ignored.
  expect(planStep({ ...plan(), maxConcurrent: 1 } as Plan, all, idle).start).toEqual([a.id, e.id]);
  // A done, E running: B and C both start.
  a.status = "done";
  e.status = "in_progress";
  const s = planStep(plan(), all, idle);
  expect(s.start).toEqual([b.id, c.id]);
  expect(s.active).toBe(1);
  b.status = "review";
  b.outcome = "done";
  c.status = "done";
  e.status = "done";
  expect(planStep(plan(), all, idle).start).toEqual([d.id]);
  d.status = "done";
  expect(planStep(plan(), all, idle).allComplete).toBe(true);
});

test("every result becomes a finished event once; dead ends are reported", () => {
  const f = T({ title: "F", status: "review", outcome: "failed", runCount: 1, error: "tests failed" });
  const q = T({ title: "Q", status: "review", outcome: "needs_input", runCount: 1 });
  const p = T({ title: "P", status: "review", outcome: "done", runCount: 1, prUrl: "https://x/pull/1" });
  const s = planStep(plan(), [f, q, p], idle);
  expect(s.events.map((e) => e.line)).toEqual([
    `finished: ${f.id} "F"; outcome failed; summary: did F; report: no report`,
    `finished: ${q.id} "Q"; outcome questions; summary: did Q; report: no report`,
    `finished: ${p.id} "P"; outcome done; summary: did P; report: no report`,
  ]);
  expect(s.events.every((e) => e.result)).toBe(true);
  const seen = Object.fromEntries(s.events.map((e) => [e.childId, e.sig]));
  const again = planStep(plan({ seen }), [f, q, p], idle);
  expect(again.events).toEqual([]);
  // The PR waits to be merged, so it's not a dead end yet.
  expect(again.awaitingMerge).toBe(1);
  expect(again.deadEnd).toBeNull();
  expect(planStep(plan({ seen }), [f, q], idle).deadEnd).toContain('"F" (review, failed)');
  // A retry that fails again is a new event.
  expect(planStep(plan({ seen }), [{ ...f, runCount: 2 }], idle).events).toHaveLength(1);
});

test("isComplete", () => {
  expect(isComplete(T({ status: "done" }))).toBe(true);
  expect(isComplete(T({ status: "review", outcome: "done" }))).toBe(true);
  expect(isComplete(T({ status: "review", outcome: "done", prUrl: "u" }))).toBe(false);
  expect(isComplete(T({ status: "review", outcome: "failed" }))).toBe(false);
});

test("needs is only a hint: children that list the same device start together", () => {
  const e1 = T({ title: "E1", needs: ["emulator"] });
  const e2 = T({ title: "E2", needs: ["emulator"] });
  const free = T({ title: "Free" });
  const s = planStep(plan(), [e1, e2, free], idle);
  expect(s.start).toEqual([e1.id, e2.id, free.id]);
});

test("plain children (not tool tickets) waiting on the user are never started; alone they end the plan with a reason naming them", () => {
  const asks = T({ title: "Asks", tool: false });
  const ok = T({ title: "Ok", tool: false });
  const why = (t: Ticket) => (t.id === asks.id ? "2 questions for you" : null);
  const s = planStep(plan(), [asks, ok], idle, { waitingOnUser: why });
  expect(s.start).toEqual([ok.id]);
  expect(s.userWait).toEqual([{ id: asks.id, reason: "2 questions for you" }]);
  expect(s.deadEnd).toBeNull();
  const done = { ...ok, status: "done" as const };
  const end = planStep(plan(), [asks, done], idle, { waitingOnUser: why });
  expect(end.start).toEqual([]);
  expect(end.deadEnd).toBe('waiting for you: "Asks" (2 questions for you)');
  // A child that depends on it is listed too.
  const after = T({ title: "After", dependsOn: [asks.id], tool: false });
  expect(planStep(plan(), [asks, done, after], idle, { waitingOnUser: why }).deadEnd)
    .toBe('waiting for you: "Asks" (2 questions for you); also not done: "After" (backlog)');
});

test("a plan with 6 ready children starts all 6 together", () => {
  const kids = [1, 2, 3, 4, 5, 6].map((n) => T({ title: `K${n}` }));
  const s = planStep({ ...plan({ originalCount: 6 }), maxConcurrent: 2 } as Plan, kids, idle);
  expect(s.start).toEqual(kids.map((k) => k.id));
});
