import { expect, test } from "bun:test";
import { checkInsText, complete, finishedLabel, planFinished, waitPhrase } from "../web/src/planText";
import { attentionGoal } from "../web/src/attentionGoal";

const kid = (status: string, outcome: string | null = null, prUrl: string | null = null) => ({ status, outcome, prUrl });

test("planFinished needs at least one child and every child done", () => {
  expect(planFinished([])).toBe(false);
  expect(planFinished([kid("done"), kid("done")])).toBe(true);
  expect(planFinished([kid("done"), kid("review", "done")])).toBe(true);
  expect(planFinished([kid("done"), kid("review", "done", "https://github.com/o/r/pull/1")])).toBe(false);
  // A child added later brings the normal plan UI back.
  expect(planFinished([kid("done"), kid("done"), kid("backlog")])).toBe(false);
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

test("finished children in Review read as to check, not Done", () => {
  expect(finishedLabel({ status: "review" })).toBe("Finished · to check");
  expect(finishedLabel({ status: "done" })).toBe("Done");
});

test("Your turn leads to the thing to do, and the main button says so", () => {
  expect(attentionGoal({ kind: "questions", label: "Answer 4 questions" })).toMatchObject({ button: "Answer questions", tab: "chat", targets: [".qcard:not(.answered)", ".reply-text"] });
  expect(attentionGoal({ kind: "proposal", label: "Review proposed tickets" })).toMatchObject({ button: "Review proposed tickets", tab: "chat" });
  expect(attentionGoal({ kind: "blocked", label: "Blocked" })).toMatchObject({ button: "See what Claude needs", tab: "chat" });
  expect(attentionGoal({ kind: "blocked", label: "Stopped at $1.00 cap" }, { capHit: { capUsd: 1 } })!.targets[0]).toBe(".cap-banner");
  expect(attentionGoal({ kind: "blocked", label: "Plan stuck" })).toMatchObject({ button: "Open plan", tab: "plan" });
  expect(attentionGoal({ kind: "huddle", label: "Huddle: 2 for you" })).toMatchObject({ tab: "huddle" });
  expect(attentionGoal({ kind: "review", label: "Ready for review" })).toBeNull();
  expect(attentionGoal(null)).toBeNull();
});
