// Card state rules (web/src/cardState.ts): which "Your turn" dots pulse, sign-in errors, finish marks, chip folding.
import { expect, test } from "bun:test";
import { finishMark, foldChips, shouldPulse, signInError } from "../web/src/cardState";

const now = Date.parse("2026-11-01T12:00:00Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const att = (kind: string, min: number) => ({ kind, label: "x", since: ago(min) });

test("only urgent kinds pulse, and only while new", () => {
  for (const kind of ["questions", "blocked", "failed", "limit", "stalled"] as const) {
    expect(shouldPulse(att(kind, 5), now)).toBe(true);
    expect(shouldPulse(att(kind, 31), now)).toBe(false);
  }
  expect(shouldPulse(att("questions", 30), now)).toBe(true);
  // 22 days old: still dot.
  expect(shouldPulse(att("blocked", 22 * 24 * 60), now)).toBe(false);
});

test("review, proposals and other kinds never pulse", () => {
  for (const kind of ["review", "proposal", "reply", "huddle"] as const) expect(shouldPulse(att(kind, 0), now)).toBe(false);
  expect(shouldPulse(null, now)).toBe(false);
  expect(shouldPulse(undefined, now)).toBe(false);
});

test("opening the ticket after it started waiting stops the pulse", () => {
  expect(shouldPulse(att("questions", 10), now, ago(5))).toBe(false);
  expect(shouldPulse(att("questions", 10), now, ago(10))).toBe(false);
  // Opened before it started waiting again: pulses.
  expect(shouldPulse(att("questions", 10), now, ago(60))).toBe(true);
  expect(shouldPulse(att("questions", 10), now, null)).toBe(true);
});

test("a bad since never pulses", () => {
  expect(shouldPulse({ kind: "failed", since: "" }, now)).toBe(false);
});

test("sign-in errors are recognised, ordinary messages aren't", () => {
  expect(signInError("Not logged in · Please run /login")).toBe(true);
  expect(signInError("Invalid API key · Please run /login")).toBe(true);
  expect(signInError("OAuth token has expired")).toBe(true);
  expect(signInError("I logged the results in report.md")).toBe(false);
  expect(signInError(undefined)).toBe(false);
});

test("a finished run leaves ✓, a failed one ✕, one that needs you !", () => {
  expect(finishMark({ outcome: "done" }).icon).toBe("✓");
  expect(finishMark({ outcome: null }).icon).toBe("✓");
  expect(finishMark({ outcome: "failed" }).icon).toBe("✕");
  for (const outcome of ["blocked", "needs_input", "limit", "stopped"] as const) expect(finishMark({ outcome }).icon).toBe("!");
});

test("at most two extra chips, the rest fold into +N", () => {
  expect(foldChips([1, 2])).toEqual({ shown: [1, 2], more: 0 });
  expect(foldChips([1, 2, 3])).toEqual({ shown: [1, 2], more: 1 });
  expect(foldChips([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2], more: 3 });
  expect(foldChips([])).toEqual({ shown: [], more: 0 });
});
