// The Rust helper runner against Bun's, step by step (rust/board/tests/fixtures/helper_runner.json): scenarios of
// waits arriving, wakes with a fixed answer from the helper, urgent alerts and their reminders, summaries and the
// 3-hour gap, failing runs and the pause, the night, the helper switched off, taps and status. Each step records
// Bun's files (waits.json, messages.json, helper-state.json, helper.json, helper-spend.jsonl) and its answer; `cargo
// test -p ckanban-board --test helper_runner` checks Rust writes the same bytes. After a deliberate change to Bun's
// helper: `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-helper-runner-fixtures.test.ts`.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "helper_runner.json");
const RUNNER = resolve(import.meta.dir, "support", "rust-helper-runner.ts");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const TZ = "America/Los_Angeles";
const MIN = 60_000;

const t = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, status: "review", createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z", ...extra });
const BOARD = {
  profiles: [{ slug: "p", name: "Product" }, { slug: "q", name: "Quality" }],
  tickets: {
    p: [t("t1", "Docs copy"), t("t2", "Billing fix"), t("t3", "Pricing page"), t("t4", "Schedule run 2026-11-16 10:00"), t("c1", "Prep: standup at 9:30", { raisedBy: { scheduleId: "s_1", ticketId: "t_9" }, status: "planning", createdAt: "2026-11-17T15:00:00.000Z" })],
    q: [t("u1", "Flaky test", { limit: { resetAt: "2026-11-17T23:00:00.000Z" } }), t("u2", "Slow build", { limit: { resetAt: "2026-11-17T22:00:00.000Z" } })],
  },
};
const wait = (ticketId: string, kind: string, extra: Record<string, unknown> = {}) => ({
  board: ticketId.startsWith("u") ? "q" : "p", ticketId, kind, identity: kind, question: kind === "questions" ? "Stop the old webhook?\nIt runs twice" : "Ready for review",
  label: kind === "questions" ? "Answer 1 question" : "Ready for review", since: "2026-11-17T17:00:00.000Z", ...extra,
});
const send = (level: string, keys: string[], extra: Record<string, unknown> = {}) => ({ level, oneLine: level === "urgent" ? "Billing runs twice: stop the webhook" : "2 tickets wait on you: docs and pricing", why: "money", itemKeys: keys, escalation: [], ...extra });
const decision = (sends: unknown[], o: Record<string, unknown> = {}) => ({ decision: { sends, nextWakeIn: 30, notes: "held docs", log: "sent what mattered", ...o } });
// 18:00 in Los Angeles (daytime), and 23:00 (night).
const DAYTIME = "2026-11-18T02:00:00.000Z";
const NIGHTTIME = "2026-11-18T07:00:00.000Z";

const SCENARIOS = [
  {
    name: "urgent alert, its reminders, Got it", start: DAYTIME, board: BOARD, channels: { mac: { ok: true }, push: { ok: true, devices: 1 } },
    steps: [
      { op: "start" },
      { op: "route", wait: wait("t2", "questions", { identity: "q:abc", urgent: true, why: "customers billed twice" }) },
      { op: "dueAt" },
      { op: "reply", replies: [decision([send("urgent", ["p/t2|q:abc"], { escalation: [{ channel: "push", afterMin: 0 }, { channel: "telegram", afterMin: 10 }, { channel: "push", afterMin: 25 }] })])] },
      { op: "tick" },
      { op: "status" },
      { op: "awake" },
      { op: "advance", ms: 11 * MIN },
      { op: "tick" },
      { op: "channels", results: { mac: { ok: true }, push: { ok: false, error: "push down" } } },
      { op: "advance", ms: 15 * MIN },
      { op: "tick" },
      { op: "gotIt", m: 1 },
      { op: "status" },
      { op: "opened", board: "p", ticketId: "t2" },
      { op: "settled", board: "p", ticketId: "t2" },
      { op: "waiting" },
    ],
  },
  {
    name: "routine waits, a summary, the 3-hour gap, kept quiet", start: DAYTIME, board: BOARD,
    steps: [
      { op: "start" },
      { op: "route", wait: wait("t1", "review") },
      { op: "route", wait: wait("t3", "review") },
      { op: "advance", ms: 61_000 },
      { op: "reply", replies: [decision([send("summary", ["p/t1|review", "p/t3|review", "checkin:p/c1"])])] },
      { op: "tick" },
      { op: "route", wait: wait("t4", "review") },
      { op: "advance", ms: 61_000 },
      { op: "reply", replies: [decision([send("summary", ["p/t4|review"])], { nextWakeIn: 5 })] },
      { op: "tick" },
      { op: "status" },
      { op: "advance", ms: 3 * 60 * MIN },
      { op: "reply", replies: [decision([send("summary", ["p/t4|review"], { oneLine: "" })], { nextWakeIn: 2000 })] },
      { op: "tick" },
      { op: "pinged", board: "p", ticketId: "t1" },
      { op: "status" },
    ],
  },
  {
    name: "failing runs: backoff, the pause message and the digest, then healthy", start: DAYTIME, board: BOARD,
    steps: [
      { op: "start" },
      { op: "route", wait: wait("t1", "review") },
      { op: "route", wait: wait("t2", "failed", { label: "Run failed", question: "Run failed" }) },
      { op: "reply", replies: [{ fail: "claude timed out", costUsd: 0.02 }, { text: "not json" }, { decision: { sends: "x", nextWakeIn: 3 } }] },
      { op: "advance", ms: 61_000 },
      { op: "tick" },
      { op: "advance", ms: 2 * MIN },
      { op: "tick" },
      { op: "advance", ms: 3 * MIN },
      { op: "tick" },
      { op: "status" },
      { op: "route", wait: wait("t3", "review") },
      { op: "coreTick" },
      { op: "advance", ms: 6 * MIN },
      { op: "coreTick" },
      { op: "reply", replies: [decision([])] },
      { op: "advance", ms: 5 * MIN },
      { op: "tick" },
      { op: "status" },
    ],
  },
  {
    name: "night: held for the morning, the morning summary, the night question", start: NIGHTTIME, board: BOARD,
    steps: [
      { op: "start" },
      { op: "route", wait: wait("t2", "questions", { identity: "q:n1", urgent: true, why: "urgent at night" }) },
      { op: "route", wait: wait("t1", "review") },
      { op: "advance", ms: 61_000 },
      { op: "tick" },
      { op: "status" },
      { op: "advance", ms: 8 * 60 * MIN },
      { op: "reply", replies: [decision([send("summary", ["p/t1|review", "p/t2|q:n1"])])] },
      { op: "tick" },
      { op: "night", m: 3, allow: true },
      { op: "advance", ms: 10 * MIN },
      { op: "tick" },
      { op: "status" },
    ],
  },
  {
    name: "helper off: direct sends, usage limits merged, the 4-hour digest, switched on and off", start: DAYTIME, board: BOARD,
    steps: [
      { op: "notify", settings: { helper: false } },
      { op: "start" },
      { op: "route", wait: wait("t1", "review") },
      { op: "route", wait: wait("u1", "limit", { label: "Usage limit", question: "Usage limit" }) },
      { op: "route", wait: wait("u2", "limit", { label: "Usage limit", question: "Usage limit" }) },
      { op: "advance", ms: 61_000 },
      { op: "coreTick" },
      { op: "notify", settings: { helper: true } },
      { op: "switched", on: true },
      { op: "route", wait: wait("t3", "review") },
      { op: "notify", settings: { helper: false } },
      { op: "switched", on: false },
      { op: "status" },
    ],
  },
  {
    name: "after sleep: several reminder steps overdue, only the latest fires; a check-in alone in a summary", start: DAYTIME, board: BOARD,
    steps: [
      { op: "start" },
      { op: "route", wait: wait("t3", "questions", { identity: "q:sl", urgent: true, why: "deadline" }) },
      { op: "reply", replies: [decision([send("urgent", ["p/t3|q:sl"], { escalation: [{ channel: "push", afterMin: 0 }, { channel: "mac", afterMin: 5 }, { channel: "push", afterMin: 10 }, { channel: "mac", afterMin: 40 }] })])] },
      { op: "tick" },
      { op: "advance", ms: 21 * MIN },
      { op: "tick" },
      { op: "status" },
      { op: "advance", ms: 3 * 60 * MIN },
      { op: "reply", replies: [decision([send("summary", ["checkin:p/c1"], { oneLine: "your standup prep" })])] },
      { op: "tick" },
      { op: "tick" },
      { op: "status" },
    ],
  },
  {
    name: "first start with waits: seeded, the hello and the first summary; practice alert", start: DAYTIME, board: BOARD, channels: { mac: { ok: true } },
    steps: [
      { op: "notify", settings: { push: false } },
      { op: "start" },
      { op: "reconcile", board: "p", ticketId: "t1", wait: wait("t1", "review") },
      { op: "reconcile", board: "p", ticketId: "t3", wait: wait("t3", "review") },
      { op: "started" },
      { op: "advance", ms: 61_000 },
      { op: "reply", replies: [decision([])] },
      { op: "tick" },
      { op: "practice" },
      { op: "advance", ms: 61_000 },
      { op: "tick" },
      { op: "notUrgent", m: 4 },
      { op: "feedback", text: "  Pricing is always urgent  " },
      { op: "helperSettings", raw: { model: "haiku", night: { start: "23:00", end: "6:30" } } },
      { op: "status" },
    ],
  },
];

function bunSnapshots(): string[][] {
  const p = Bun.spawnSync(["bun", RUNNER], { stdin: Buffer.from(JSON.stringify(SCENARIOS)), env: { ...process.env, TZ } });
  if (p.exitCode !== 0) throw new Error(`scenario runner failed: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

describe("Rust helper runner fixtures: Bun gives the snapshots they record", () => {
  test("every scenario", () => {
    const snaps = bunSnapshots();
    const doc = { tz: TZ, scenarios: SCENARIOS.map((s, i) => ({ ...s, expect: snaps[i] })) };
    const text = `{"tz":${JSON.stringify(TZ)},"scenarios":[\n${doc.scenarios.map((s) => JSON.stringify(s)).join(",\n")}\n]}\n`;
    if (UPDATE) {
      writeFileSync(FILE, text);
      return;
    }
    const was = JSON.parse(readFileSync(FILE, "utf8"));
    expect(was.scenarios.length).toBe(doc.scenarios.length);
    for (let i = 0; i < doc.scenarios.length; i++) {
      for (let k = 0; k < doc.scenarios[i].expect.length; k++) {
        expect({ scenario: doc.scenarios[i].name, step: k, got: doc.scenarios[i].expect[k] }).toEqual({ scenario: was.scenarios[i].name, step: k, got: was.scenarios[i].expect[k] });
      }
    }
  }, 60_000);
});
