import { expect, test } from "bun:test";
import { gapOf, jumpAfterScroll, NEAR_BOTTOM, onContentChange, SHOW_JUMP, stickAfterScroll } from "../web/src/chatFollow";

test("gapOf: distance from the bottom of the view to the bottom of the content, never negative", () => {
  expect(gapOf({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(0);
  expect(gapOf({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(200);
  expect(gapOf({ scrollHeight: 1000, scrollTop: 610, clientHeight: 400 })).toBe(0);
});

test("onContentChange: near the bottom with a new item, it scrolls", () => {
  expect(onContentChange({ before: 0, after: 80, stuck: true, pressing: false })).toBe("scroll");
  // A reader 100 px up (still near the bottom) follows too.
  expect(onContentChange({ before: 100, after: 400, stuck: true, pressing: false })).toBe("scroll");
});

test("onContentChange: scrolled up, it shows the button instead of yanking the reader down", () => {
  expect(onContentChange({ before: 600, after: 700, stuck: false, pressing: false })).toBe("button");
});

test("onContentChange: while the user is selecting or touching, following waits for them to let go", () => {
  expect(onContentChange({ before: 0, after: 80, stuck: true, pressing: true })).toBe("hold");
});

test("onContentChange: nothing new below the view (a clock tick, content shrinking, older messages above) does nothing", () => {
  expect(onContentChange({ before: 0, after: 0, stuck: true, pressing: false })).toBe("none");
  expect(onContentChange({ before: 100, after: 100, stuck: true, pressing: false })).toBe("none");
  expect(onContentChange({ before: 300, after: 20, stuck: false, pressing: false })).toBe("none");
  expect(onContentChange({ before: 600, after: 600, stuck: false, pressing: false })).toBe("none");
});

test("stickAfterScroll: near the bottom follows; scrolling up away from it stops; moving down while following keeps it", () => {
  expect(stickAfterScroll({ gap: NEAR_BOTTOM - 1, stuck: false, movedDown: false })).toBe(true);
  expect(stickAfterScroll({ gap: NEAR_BOTTOM, stuck: true, movedDown: false })).toBe(false);
  // A smooth "jump to latest" passes through large gaps on its way down.
  expect(stickAfterScroll({ gap: 2000, stuck: true, movedDown: true })).toBe(true);
  // Scrolling down from far up doesn't start following until near the bottom.
  expect(stickAfterScroll({ gap: 2000, stuck: false, movedDown: true })).toBe(false);
});

test("jumpAfterScroll: hidden near the bottom, shown well up, kept in between", () => {
  expect(jumpAfterScroll(0, { fresh: true })).toBeNull();
  expect(jumpAfterScroll(SHOW_JUMP + 1, null)).toEqual({ fresh: false });
  const fresh = { fresh: true };
  expect(jumpAfterScroll(SHOW_JUMP + 1, fresh)).toBe(fresh);
  expect(jumpAfterScroll(NEAR_BOTTOM + 10, null)).toBeNull();
  expect(jumpAfterScroll(NEAR_BOTTOM + 10, fresh)).toBe(fresh);
});

test("jumpAfterScroll: scrolling up drops the New word, the arrow stays", () => {
  const fresh = { fresh: true };
  expect(jumpAfterScroll(SHOW_JUMP + 1, fresh, true)).toEqual({ fresh: false });
  expect(jumpAfterScroll(SHOW_JUMP + 1, fresh, false)).toBe(fresh);
  expect(jumpAfterScroll(0, fresh, true)).toBeNull();
});

test("onContentChange: the user's own click opening something near the bottom doesn't scroll it away", () => {
  expect(onContentChange({ before: 0, after: 500, stuck: true, pressing: false, userCaused: true })).toBe("none");
});
