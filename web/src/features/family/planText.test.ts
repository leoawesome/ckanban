import { expect, test } from "bun:test";
import { checkInsText, complete, planDone, waitPhrase } from "./planText";
import { attentionGoal } from "../board/attentionGoal";

const kid = (status: string, outcome: string | null = null, prUrl: string | null = null) => ({ status, outcome, prUrl });

const task = (id: string, status: string, x: object = {}) => ({ id, title: id, status, createdAt: "", ...x });

test("planDone needs at least one task and every task finished, counted like the Tasks tab badge", () => {
  expect(planDone([])).toEqual({ finished: false, done: 0, total: 0 });
  expect(planDone([task("a", "done"), task("b", "done")])).toEqual({ finished: true, done: 2, total: 2 });
  // A task in Review is still open (as on the Tasks tab), however its last run ended.
  expect(planDone([task("a", "done"), task("b", "review", { outcome: "done" })]).finished).toBe(false);
  // A test that found a problem is finished; a task added later brings the normal plan UI back.
  expect(planDone([task("a", "done", { kind: "test", verdict: "problem" })]).finished).toBe(true);
  expect(planDone([task("a", "done"), task("b", "backlog")])).toEqual({ finished: false, done: 1, total: 2 });
  expect(complete(kid("in_progress"))).toBe(false);
});

test("checkInsText says the wake-up count in plain words", () => {
  expect(checkInsText(0)).toBe("Claude checked in 0 times");
  expect(checkInsText(1)).toBe("Claude checked in once");
  expect(checkInsText(4)).toBe("Claude checked in 4 times");
});

test("a stuck plan names what its child waits on", () => {
  expect(waitPhrase("5 questions for you")).toBe("has 5 questions");
  expect(waitPhrase("1 question for you")).toBe("has 1 question");
  expect(waitPhrase("has questions for you")).toBe("has questions");
  expect(waitPhrase("proposal to apply")).toBe("has a proposal to apply");
  expect(waitPhrase("in Planning")).toBe("is waiting in Planning");
});

test("Your turn leads to the thing to do, and the main button says so", () => {
  expect(attentionGoal({ kind: "questions", label: "Answer 4 questions" })).toMatchObject({ button: "Answer questions", tab: "chat", targets: [".qcard:not(.answered)", ".task-card", ".reply-text"] });
  expect(attentionGoal({ kind: "proposal", label: "Review proposal" })).toMatchObject({ button: "Review proposal", tab: "chat" });
  expect(attentionGoal({ kind: "blocked", label: "Blocked" })).toMatchObject({ button: "See what Claude needs", tab: "chat" });
  expect(attentionGoal({ kind: "blocked", label: "Stopped at $1.00 cap" }, { capHit: { capUsd: 1 } })!.targets[0]).toBe(".cap-banner");
  expect(attentionGoal({ kind: "blocked", label: "Plan stuck" })).toMatchObject({ button: "Open plan", tab: "family" });
  expect(attentionGoal({ kind: "huddle", label: "Huddle: 2 for you" })).toMatchObject({ tab: "huddle" });
  expect(attentionGoal({ kind: "review", label: "Ready for review" })).toBeNull();
  expect(attentionGoal(null)).toBeNull();
});
