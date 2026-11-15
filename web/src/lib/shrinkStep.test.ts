import { expect, test } from "bun:test";
import { isUserScroll, NO_INPUT, shrinkStep, type ShrinkState } from "../web/src/shrinkStep";

const run = (steps: [number, boolean][], from: ShrinkState = { slim: false, down: 0, up: 0 }) => {
  let s = from;
  let y = 0;
  for (const [to, user] of steps) {
    s = shrinkStep(s, { y: to, dy: to - y, user });
    y = to;
  }
  return s;
};

test("shrinkStep: the user's scroll down past the top shrinks the header; scrolling up or reaching the top brings it back", () => {
  expect(run([[70, false], [80, true]]).slim).toBe(false); // 10px is a jitter
  expect(run([[80, true], [120, true]]).slim).toBe(true);
  expect(run([[30, true], [50, true]]).slim).toBe(false); // still near the top
  const slim = run([[80, true], [120, true]]);
  expect(run([[120, true], [110, true]], slim).slim).toBe(true); // a small jitter up
  expect(run([[120, true], [90, true]], slim).slim).toBe(false);
  expect(run([[120, true], [2, false]], slim).slim).toBe(false); // back at the top, whoever scrolled
});

test("shrinkStep: scrolls the user didn't make (new messages, the feed resizing) never change the header", () => {
  expect(run([[80, false], [400, false]]).slim).toBe(false);
  const slim = run([[80, true], [120, true]]);
  expect(run([[120, false], [20, false]], slim).slim).toBe(true);
});

test("isUserScroll: scrolls right after page load, before any input, are not the user's (the chat's jump to the bottom)", () => {
  expect(isUserScroll(150, NO_INPUT, 0, 600)).toBe(false);
  expect(isUserScroll(5, NO_INPUT, 0, 600)).toBe(false);
  expect(isUserScroll(1000, 800, 0, 600)).toBe(true);
  expect(isUserScroll(1500, 800, 0, 600)).toBe(false);
  expect(isUserScroll(1000, 800, 1100, 600)).toBe(false); // header still settling
});
