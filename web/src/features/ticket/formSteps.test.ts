import { describe, expect, test } from "bun:test";
import { autoNext, backStep, isEmpty, nextLabel, nextStep, progressText, segments, stepped, waitingChip } from "./formSteps";
import { pickAnswer } from "./formPreview";
import type { Answer } from "./questionForms";

const none: Answer = { picked: [], otherOn: false, other: "" };

describe("one question at a time (phone)", () => {
  test("only on a phone, and only with two or more questions", () => {
    expect(stepped(true, 3)).toBe(true);
    expect(stepped(true, 1)).toBe(false);
    expect(stepped(false, 3)).toBe(false);
  });

  test("a pick-one tap moves to the next question, and the last one to Check your answers", () => {
    expect(autoNext(0, 3, false, pickAnswer(none, "A"), "A")).toBe(1);
    expect(autoNext(2, 3, false, pickAnswer(none, "A"), "A")).toBe(3);
    // Tapping the option already picked confirms it and moves on too.
    expect(autoNext(1, 3, false, pickAnswer({ ...none, picked: ["A"] }, "A"), "A")).toBe(2);
  });

  test("multi-select and an unpicking tap stay on the question", () => {
    expect(autoNext(0, 3, true, pickAnswer(none, "A", true), "A")).toBeNull();
    expect(autoNext(0, 3, true, pickAnswer({ ...none, picked: ["A"] }, "A", true), "A")).toBeNull();
    expect(autoNext(3, 3, false, pickAnswer(none, "A"), "A")).toBeNull();
  });

  test("Skip when nothing is picked or typed, Next otherwise", () => {
    expect(nextLabel(none)).toBe("Skip");
    expect(nextLabel({ ...none, other: "typed but set aside" })).toBe("Skip");
    expect(nextLabel({ ...none, other: "mine", otherOn: true })).toBe("Next");
    expect(nextLabel({ ...none, picked: ["A"] })).toBe("Next");
    expect(isEmpty({ ...none, other: "  ", otherOn: true })).toBe(true);
  });

  test("Next/Skip goes on to Check your answers and no further; Back stops at the first question", () => {
    expect(nextStep(0, 3)).toBe(1);
    expect(nextStep(2, 3)).toBe(3);
    expect(nextStep(3, 3)).toBe(3);
    expect(backStep(3)).toBe(2);
    expect(backStep(0)).toBe(0);
  });

  test("progress bar and words, including Check your answers", () => {
    expect(segments(1, 3)).toEqual(["done", "cur", "todo"]);
    expect(segments(3, 3)).toEqual(["done", "done", "done"]);
    expect(progressText(1, 3)).toBe("2 of 3");
    expect(progressText(3, 3)).toBe("Check");
  });
});

describe("waiting form chip", () => {
  test("shows while an open form is off screen, with the question count", () => {
    expect(waitingChip(3, false)).toBe("Answer 3 questions");
    expect(waitingChip(1, false)).toBe("Answer 1 question");
  });
  test("hides when the form is on screen or there is no open form", () => {
    expect(waitingChip(3, true)).toBeNull();
    expect(waitingChip(null, false)).toBeNull();
    expect(waitingChip(0, false)).toBeNull();
  });
});
