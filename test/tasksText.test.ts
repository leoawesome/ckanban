// The feature status at the top of the Tasks tab and the chat's "Waiting on you" line (web/src/tasksText.ts).
import { expect, test } from "bun:test";
import { namesText, taskProgress, waitingLine } from "../web/src/tasksText";

test("progress counts loose tasks and the tasks inside groups, not the groups", () => {
  expect(taskProgress({
    loose: { total: 2, counts: { done: 1, working: 1 } },
    groups: [{ total: 3, counts: { passed: 1, problem: 1, waiting: 1 } }],
  })).toEqual({ done: 3, total: 5 });
  expect(taskProgress({ loose: { total: 0, counts: {} }, groups: [] })).toEqual({ done: 0, total: 0 });
});

test("Now names up to two tasks", () => {
  expect(namesText(["Build"])).toBe("Build");
  expect(namesText(["A", "B", "C", "D"])).toBe("A, B and 2 more");
});

test("the chat line shows only while the status has Waiting on you text", () => {
  expect(waitingLine({ waiting: "pick a chat style" })).toBe("Waiting on you: pick a chat style");
  expect(waitingLine({ waiting: "  line one\n line two " })).toBe("Waiting on you: line one line two");
  expect(waitingLine({ waiting: "  " })).toBe("");
  expect(waitingLine({})).toBe("");
  expect(waitingLine(null)).toBe("");
});
