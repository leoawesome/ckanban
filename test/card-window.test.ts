import { expect, test } from "bun:test";

// useCardWindow.ts: the range for a scroll position, and the limit on range fixes from the after-draw effect. The
// board crashed (React's "Maximum update depth exceeded", 50 nested updates) when each fix moved the scroll position
// (the browser's scroll anchoring), so the next draw's fix gave another range, and so on in one chain.
// A path tsc doesn't follow: the root typecheck has no DOM types (web/ has its own tsconfig).
const windowPath = "../web/src/useCardWindow";
const { rangeFor, SyncLimit } = await import(windowPath);

const offsets = (n: number, h = 100) => Array.from({ length: n + 1 }, (_, i) => i * h);

test("the range covers the visible part plus a margin on both ends", () => {
  const o = offsets(1000);
  expect(rangeFor(o, 0, 800)).toEqual({ start: 0, end: 17 });
  const mid = rangeFor(o, 50_000, 800);
  expect(mid.start).toBe(491);
  expect(mid.end).toBe(517);
  expect(rangeFor(o, 99_500, 800)).toEqual({ start: 986, end: 1000 });
  expect(rangeFor([0], 0, 800)).toEqual({ start: 0, end: 0 });
});

/**
 * One layout pass chain as React runs it: each draw's after-draw effect computes the range; a changed range draws
 * again at once (nested). `anchor` moves the scroll position after each draw, as scroll anchoring did when the
 * spacers changed. Returns the nested draws and whether React would have given up.
 */
function chain(limit: { take(): boolean; reset(): void } | null, anchor: (r: { start: number; end: number }) => number) {
  const o = offsets(8000);
  let range = { start: 0, end: 30 };
  let draws = 0;
  for (;;) {
    draws++;
    if (draws > 50) return { draws, crashed: true };
    if (limit && !limit.take()) return { draws, crashed: false };
    const next = rangeFor(o, anchor(range), 800);
    if (next.start === range.start && next.end === range.end) {
      limit?.reset();
      return { draws, crashed: false };
    }
    range = next;
  }
}

// Scroll anchoring flipping the position between two spots as the spacers change: every draw gets a new range.
const flipping = (r: { start: number }) => (r.start > 100 ? 1000 : 400_000);

test("without a limit, a scroll position that moves with the range chains draws past React's limit", () => {
  expect(chain(null, flipping).crashed).toBe(true);
});

test("the limit stops the chain after a few draws; the rest waits for the next frame", () => {
  const limit = new SyncLimit(3);
  const first = chain(limit, flipping);
  expect(first.crashed).toBe(false);
  expect(first.draws).toBeLessThanOrEqual(4);
  // The next frame resets it: again only a few draws, never a crash.
  limit.reset();
  expect(chain(limit, flipping).draws).toBeLessThanOrEqual(4);
});

test("a steady scroll position settles at once and frees the limit", () => {
  const limit = new SyncLimit(3);
  expect(chain(limit, () => 20_000)).toEqual({ draws: 2, crashed: false });
  expect(limit.take()).toBe(true);
  expect(limit.take()).toBe(true);
  expect(limit.take()).toBe(true);
  expect(limit.take()).toBe(false);
});
