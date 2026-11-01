// The phone ticket header's one status button (web/src/phoneStatus.ts): its label and colour.
import { expect, test } from "bun:test";
import { phoneStatus } from "../web/src/phoneStatus";

const t = (o: Record<string, unknown> = {}) => ({ status: "backlog" as const, outcome: null, ...o }) as Parameters<typeof phoneStatus>[0];

test("no outcome: the column name in grey", () => {
  expect(phoneStatus(t(), null, null)).toEqual({ label: "Backlog", tone: "neutral" });
  expect(phoneStatus(t({ status: "ready" }), null, null)).toEqual({ label: "In Progress", tone: "neutral" });
  expect(phoneStatus(t({ status: "done", outcome: "failed" }), null, null)).toEqual({ label: "Done", tone: "neutral" });
});

test("the reason Claude needs you wins over the outcome", () => {
  expect(phoneStatus(t({ status: "review", outcome: "done" }), null, { kind: "review", label: "Ready for review" })).toEqual({ label: "Ready for review", tone: "ok" });
  expect(phoneStatus(t({ outcome: "needs_input" }), null, { kind: "questions", label: "Answer 2 questions" })).toEqual({ label: "Answer 2 questions", tone: "warn" });
  expect(phoneStatus(t({ outcome: "blocked" }), null, { kind: "blocked", label: "Blocked" }).tone).toBe("err");
  expect(phoneStatus(t({ outcome: "limit" }), null, { kind: "limit", label: "Limit hit · resets 14:00" }).label).toBe("Limit hit");
});

test("outcomes and runs", () => {
  expect(phoneStatus(t({ status: "review", outcome: "done" }), null, null)).toEqual({ label: "Ready for review", tone: "ok" });
  expect(phoneStatus(t({ outcome: "blocked" }), null, null)).toEqual({ label: "Blocked", tone: "warn" });
  expect(phoneStatus(t({ outcome: "failed" }), null, null)).toEqual({ label: "Failed", tone: "err" });
  expect(phoneStatus(t({ status: "in_progress" }), null, null)).toEqual({ label: "Running", tone: "info", busy: true });
  expect(phoneStatus(t({ status: "in_progress", slotWait: { at: "x" } }), null, null)).toEqual({ label: "Queued", tone: "warn" });
  expect(phoneStatus(t({ status: "planning", running: true }), null, null)).toEqual({ label: "Replying", tone: "info", busy: true });
  expect(phoneStatus(t({ status: "review", outcome: "done", huddleBusy: true }), null, null)).toEqual({ label: "Review", tone: "neutral" });
});

test("the just-finished mark shows first", () => {
  expect(phoneStatus(t({ outcome: "failed" }), { icon: "✕", tone: "failed", label: "Failed" }, { kind: "failed", label: "Run failed" }))
    .toEqual({ label: "Failed", tone: "err", icon: "✕" });
});
