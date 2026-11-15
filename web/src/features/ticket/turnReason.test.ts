import { expect, test } from "bun:test";
import { turnReason } from "../web/src/phoneStatus";

test("turnReason: the reason after 'Your turn ·' in plain lower-case words", () => {
  expect(turnReason(null)).toBe("");
  expect(turnReason({ kind: "review", label: "Ready for review" })).toBe("review the result");
  expect(turnReason({ kind: "questions", label: "Answer 2 questions" })).toBe("answer 2 questions");
  expect(turnReason({ kind: "limit", label: "x" }, "Usage limit until 14:00")).toBe("usage limit until 14:00");
});
