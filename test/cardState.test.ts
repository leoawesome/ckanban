// Card state rules (web/src/cardState.ts): which "Your turn" dots pulse, sign-in errors, finish marks, chip folding.
import { expect, test } from "bun:test";
import { cardHuddleLine, finishMark, foldChips, huddleLineText, overCap, previewShown, shouldPulse, signInError, stepAge, stepsShown } from "../web/src/cardState";

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

test("a running card shows the time since its last step and goes quiet after 3 minutes", () => {
  const sec = (s: number) => new Date(now - s * 1000).toISOString();
  expect(stepAge(null, now)).toBeNull();
  expect(stepAge("not a date", now)).toBeNull();
  expect(stepAge(sec(4), now)).toEqual({ text: "4s", quiet: false });
  expect(stepAge(sec(59), now)).toEqual({ text: "59s", quiet: false });
  expect(stepAge(sec(150), now)).toEqual({ text: "2m", quiet: false });
  expect(stepAge(sec(179), now)!.quiet).toBe(false);
  expect(stepAge(sec(180), now)).toEqual({ text: "3m", quiet: true });
  expect(stepAge(sec(3900), now)).toEqual({ text: "1h 5m", quiet: true });
  // A clock a little ahead on the server: never a negative time.
  expect(stepAge(sec(-2), now)).toEqual({ text: "0s", quiet: false });
});

test("the card's muted line names steps only part way through", () => {
  expect(stepsShown({ tools: 16, toolsDone: 7, running: [] })).toBe(true);
  expect(stepsShown({ tools: 16, toolsDone: 0, running: [] })).toBe(false);
  expect(stepsShown({ tools: 16, running: [] })).toBe(false);
  expect(stepsShown({ tools: 16, toolsDone: 16, running: [] })).toBe(false);
  expect(stepsShown({ tools: 0, toolsDone: 0, running: [] })).toBe(false);
});

test("cost turns red only when the last run stopped at its cap, never from the total of all runs", () => {
  expect(overCap({ capHit: { capUsd: 5, at: "2026-11-07T00:00:00Z" } })).toBe(true);
  expect(overCap({ capHit: null })).toBe(false);
  expect(overCap({})).toBe(false);
});

test("Backlog and Done cards skip the Claude preview; Planning and Review keep it", () => {
  expect(previewShown("backlog")).toBe(false);
  expect(previewShown("done")).toBe(false);
  expect(previewShown("planning")).toBe(true);
  expect(previewShown("review")).toBe(true);
  expect(previewShown("in_progress")).toBe(true);
});

test("huddle line: helpers working and open findings, in plain words", () => {
  expect(huddleLineText({ working: 6, helpers: 6, findings: 4 })).toBe("Huddle: 6 helpers working, 4 findings so far");
  expect(huddleLineText({ working: 2, helpers: 6, findings: 1 })).toBe("Huddle: 2 of 6 helpers working, 1 finding so far");
  expect(huddleLineText({ working: 1, helpers: 1, findings: 0 })).toBe("Huddle: 1 helper working");
  // A wake on its way, nobody mid-reply yet: the helpers in the huddle.
  expect(huddleLineText({ working: 0, helpers: 3, findings: 0 })).toBe("Huddle: 3 helpers working");
  expect(huddleLineText({ working: 0, helpers: 0, findings: 0 })).toBe("Huddle: 1 helper working");
});

test("huddle line on the card: only while the huddle works, its own run doesn't and nothing needs the user", () => {
  const line = { working: 6, helpers: 6, findings: 4 };
  expect(cardHuddleLine({ huddleBusy: true, huddleLine: line }, { working: false, needsYou: false })).toBe("Huddle: 6 helpers working, 4 findings so far");
  // Asks the user something: "Needs you" wins.
  expect(cardHuddleLine({ huddleBusy: true, huddleLine: line }, { working: false, needsYou: true })).toBeNull();
  // Its own run (or its feature) working: that line wins.
  expect(cardHuddleLine({ huddleBusy: true, huddleLine: line }, { working: true, needsYou: false })).toBeNull();
  // Idle or closed huddle: back to normal.
  expect(cardHuddleLine({ huddleBusy: false, huddleLine: null }, { working: false, needsYou: false })).toBeNull();
  expect(cardHuddleLine({}, { working: false, needsYou: false })).toBeNull();
  // An older server without the counts still shows a line.
  expect(cardHuddleLine({ huddleBusy: true }, { working: false, needsYou: false })).toBe("Huddle: 1 helper working");
});
