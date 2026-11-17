// The R2b families fixtures (rust/board/tests/fixtures/families.json): inputs for the family rules
// (`linkProblem`, `fitParent`, `levelOf`, `nextRoundTitle`, `isFeature` in web/src/features/family/family.ts), the plan
// engine (`planStep`, `planProblem` in src/board/plan.ts, `wakeTable`, `finishedLine`, `progressStep` in
// src/board/main-ticket.ts) and the feature status (`clipText`, `applyPatch`, `familySig`, `statusFacts`,
// `statusMarkdown` in src/board/feature.ts), with Bun's answer in `expect` (JSON text). This test checks Bun still gives
// exactly those answers; `cargo test -p ckanban-board` checks Rust gives them too (rust/board/tests/families.rs).
// After a deliberate change to that Bun code, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-families-fixtures.test.ts`
// to rewrite the file, then make `cargo test` pass again.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fitParent, isFeature, levelOf, linkProblem, nextRoundTitle } from "../web/src/features/family/family";
import { childrenOf, planProblem, planStep } from "../src/board/plan";
import { finishedLine, progressStep, wakeTable } from "../src/board/main-ticket";
import { applyPatch, clipText, familySig, statusFacts, statusMarkdown } from "../src/board/feature";
import type { Ticket } from "../src/core/types";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "families.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

let n = 0;
const tk = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title: id.toUpperCase(), status: "backlog", createdAt: `2026-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`, updatedAt: "2026-01-02T00:00:00.000Z", ...extra,
});

/** One board with features, groups, rounds, a sub-feature, tasks in every state, and a loose tree. */
const board = [
  tk("m1", { main: true, statusAt: "2026-01-03T00:00:00.000Z", results: [{ at: "2026-01-02T00:00:00.000Z", ticketId: "b", summary: "It broke\nbecause of the thing" }] }),
  tk("g1", { title: "Phase one", kind: "group", partOf: "m1", tool: true }),
  tk("a", { title: "Build: login", kind: "build", parentId: "g1", tool: true, status: "done", outcome: "done", prs: [{ url: "https://github.com/o/r/pull/7", state: "OPEN" }] }),
  tk("b", { title: "Fix it", kind: "fix", parentId: "g1", tool: true, status: "review", outcome: "failed", error: "trace\n  at x\nlast error line", runCount: 2 }),
  tk("c", { kind: "explore", parentId: "g1", tool: true, status: "review", outcome: "needs_input", dependsOn: ["a"] }),
  tk("r1", { title: "Testing round 2", kind: "round", partOf: "m1", tool: true }),
  tk("t1", { kind: "test", parentId: "r1", tool: true, status: "done", verdict: "passed" }),
  tk("t2", { kind: "test", parentId: "r1", tool: true, status: "done", verdict: "problem", outcome: "done" }),
  tk("t3", { kind: "test", parentId: "r1", tool: true, status: "in_progress" }),
  tk("l1", { title: "Loose card", partOf: "m1", status: "review", outcome: "done", prUrl: "https://github.com/o/r/pull/9" }),
  tk("p1", { title: "Paused one", partOf: "m1", tool: true, status: "review", outcome: "limit", limit: { auto: true, resetAt: "2026-01-05T10:00:00.000Z" } }),
  tk("cap", { title: "Capped", partOf: "m1", tool: true, status: "review", outcome: "blocked", capHit: { capUsd: 2.5 } }),
  tk("s1", { title: "Sub feature", main: true, partOf: "m1" }),
  tk("s1a", { partOf: "s1", tool: true, status: "in_progress" }),
  tk("x1", { title: "Loose top" }),
  tk("x2", { partOf: "x1" }),
  tk("x3", { partOf: "x2" }),
  tk("m2", { main: true, title: "Small" }),
  tk("m2a", { partOf: "m2" }),
  tk("done1", { main: true, status: "done" }),
  tk("done1a", { partOf: "done1" }),
  tk("done1b", { partOf: "done1" }),
] as unknown as Ticket[];

/** A plan's children in every state the engine reads. */
const kids = (extra: Record<string, Record<string, unknown>> = {}) => [
  tk("k1", { planKey: "one", tool: true, parentId: "pl", ...extra.k1 }),
  tk("k2", { tool: true, parentId: "pl", dependsOn: ["one"], ...extra.k2 }),
  tk("k3", { tool: true, parentId: "pl", ...extra.k3 }),
] as unknown as Ticket[];

const cases: Record<string, any[]> = {
  linkProblem: [
    { moved: { id: "\u0000new", title: "New", main: false }, parent: "g1", subtree: true },
    { moved: { id: "\u0000new", title: "New", main: false }, parent: "a", subtree: true },
    { moved: { id: "\u0000new", title: "Main", main: true }, parent: "s1", subtree: true },
    { moved: { id: "\u0000new", title: "Main", main: true }, parent: "g1", subtree: true },
    { moved: { id: "\u0000new", title: "Main", main: true }, parent: "m1", subtree: true },
    { moved: { id: "x1", title: "Loose top" }, parent: "g1", subtree: true },
    { moved: { id: "x1", title: "Loose top" }, parent: "g1", subtree: false },
    { moved: { id: "x1", title: "Loose top" }, parent: "m1", subtree: true },
    { moved: { id: "m2", title: "Small" }, parent: "s1", subtree: true },
    { moved: { id: "s1", title: "Sub feature" }, parent: "m2", subtree: true },
    { moved: { id: "m2", title: "Small", main: true }, parent: "m1", subtree: true },
    { moved: { id: "x1", title: "Loose top" }, parent: "x3", subtree: true },
    { moved: { id: "x1", title: "Loose top" }, parent: "nope", subtree: true },
  ],
  fitParent: ["m1", "g1", "a", "x3", "x2", "s1a", "nope"].map((id) => ({ id })),
  levelOf: ["m1", "g1", "a", "s1", "s1a", "x3", "nope"].map((id) => ({ id })),
  nextRoundTitle: [{ top: "m1" }, { top: "m2" }, { top: null }],
  isFeature: ["m1", "m2", "s1", "done1", "x1", "g1"].map((id) => ({ id })),
  familySig: [{ top: "m1" }, { top: "x1" }],
  wakeTable: [{ parent: "m1", running: ["s1a"] }, { parent: "g1", running: [] }, { parent: "x3", running: [] }],
  finishedLine: [
    { id: "a", summary: "  did   it\nall ", report: "/r/report.md" },
    { id: "c", summary: "", report: null },
    { id: "t2", summary: "x".repeat(1300), report: null },
  ],
  progressStep: [
    { plan: {}, sig: "s" },
    { plan: { progressSig: "s", noProgress: 2 }, sig: "s" },
    { plan: { progressSig: "s", noProgress: 1 }, sig: "t" },
  ],
  planProblem: [
    { kids: [] },
    { kids: kids() },
    { kids: kids({ k3: { dependsOn: ["ghost"] } }) },
    { kids: kids({ k1: { dependsOn: ["k2"] } }) },
  ],
  planStep: [
    { plan: {}, kids: kids(), running: [], waiting: {}, summary: {} },
    { plan: {}, kids: kids({ k1: { status: "done", outcome: "done", runCount: 1 } }), running: [], waiting: {}, summary: { k1: "did one" } },
    { plan: { seen: { k1: "1:done:" } }, kids: kids({ k1: { status: "done", outcome: "done", runCount: 1 }, k2: { status: "review", outcome: "failed", runCount: 1 } }), running: ["k3"], waiting: {}, summary: {} },
    {
      plan: { seen: { k1: "1:done:", k2: "1:failed:" } },
      kids: kids({ k1: { status: "done", outcome: "done", runCount: 1 }, k2: { status: "review", outcome: "failed", runCount: 1 }, k3: { status: "planning", tool: false } }),
      running: [], waiting: { k3: "in Planning" }, summary: {},
    },
    { plan: {}, kids: kids({ k1: { status: "review", outcome: "done", runCount: 1, prUrl: "https://github.com/o/r/pull/1" } }), running: [], waiting: {}, summary: {} },
    { plan: { seen: { k1: "1:done:https://github.com/o/r/pull/1" } }, kids: kids({ k1: { status: "review", outcome: "done", runCount: 1, prUrl: "https://github.com/o/r/pull/1" }, k2: { waitsForStart: true }, k3: { status: "done" } }), running: [], waiting: {}, summary: {} },
    { plan: {}, kids: kids({ k1: { status: "review", outcome: "needs_input", kind: "with_you" }, k2: { outcome: "limit", limit: { auto: true } }, k3: { scheduleId: "s1", status: "review", outcome: "done", runCount: 1 } }), running: [], waiting: {}, summary: {} },
    { plan: {}, kids: kids({ k1: { status: "done" }, k2: { status: "done" }, k3: { status: "done" } }), running: [], waiting: {}, summary: {} },
  ],
  clipText: [
    { s: "short", max: 50 },
    { s: "word ".repeat(30), max: 40 },
    { s: "a".repeat(100), max: 40 },
    { s: `${"x".repeat(30)}, (and; more: words here`, max: 40 },
    { s: `héllo wörld ${"ü".repeat(60)} end`, max: 50 },
  ],
  applyPatch: [
    { saved: null, patch: { goal: " Goal ", done: "" }, prNotes: null },
    { saved: { goal: "g", updatedAt: "old", done: "d", prNotes: { u1: "n1" } }, patch: { done: null, next: "n" }, prNotes: { u1: null, u2: " two " } },
  ],
  status: [
    { top: "m1", needsYou: ["c"], saved: null, prNotes: {}, subs: {} },
    {
      top: "m1", needsYou: [], prNotes: { "https://github.com/o/r/pull/7": "on staging" },
      subs: { s1: { working: true, headline: "  Sub's   next\nstep  " } },
      saved: {
        goal: "Ship", done: "Most of it", broken: "One thing", waiting: "Your call", next: "Land it", updatedAt: "2026-01-04T00:00:00.000Z",
        notes: [{ at: "2026-01-03T05:00:00.000Z", text: "Remember the phone", delivered: false }],
        milestones: [{ at: "2026-01-02T00:00:00.000Z", summary: "First", landed: "already in the project folder" }],
      },
    },
    { top: "x1", needsYou: [], saved: { updatedAt: "2026-01-01T00:00:00.000Z" }, prNotes: {}, subs: {} },
    { top: "s1", needsYou: [], saved: null, prNotes: {}, subs: {} },
  ],
};

const fill: Record<string, (c: any) => unknown> = {
  linkProblem: (c) => linkProblem(board, c.moved, c.parent, { subtree: c.subtree }),
  fitParent: (c) => fitParent(board, c.id),
  levelOf: (c) => levelOf(board, c.id),
  nextRoundTitle: (c) => nextRoundTitle(board, c.top),
  isFeature: (c) => isFeature(board, board.find((t) => t.id === c.id)!),
  familySig: (c) => familySig(board.filter((t) => t.id === c.top || t.partOf === c.top || t.parentId === c.top)),
  wakeTable: (c) => wakeTable(childrenOf(board, c.parent).concat(board.filter((t) => t.partOf === c.parent && !t.parentId)), board, (id) => c.running.includes(id)),
  finishedLine: (c) => finishedLine(board.find((t) => t.id === c.id)!, c.summary, c.report),
  progressStep: (c) => progressStep(c.plan, c.sig),
  planProblem: (c) => planProblem(c.kids),
  planStep: (c) => planStep(c.plan, c.kids, (id) => c.running.includes(id), {
    waitingOnUser: (t) => c.waiting[t.id] ?? null,
    managed: { summary: (t) => c.summary[t.id] ?? "", report: () => null },
  }),
  clipText: (c) => clipText(c.s, c.max),
  applyPatch: (c) => applyPatch(c.saved, c.patch, "NOW", "SIG"),
  status: (c) => {
    const f = statusFacts(board, c.top, (t) => c.needsYou.includes(t.id), c.prNotes, (t) => c.subs[t.id] ?? { working: false });
    return { facts: f, markdown: statusMarkdown(board.find((t) => t.id === c.top)!, c.saved, f) };
  },
};
// applyPatch's prNotes ride in the patch, as update_status sends them.
for (const c of cases.applyPatch) if (c.prNotes) c.patch.prNotes = c.prNotes;

describe("Rust board families fixtures: Bun gives the answers they record", () => {
  const doc = { board, groups: {} as Record<string, any[]> };
  for (const [group, list] of Object.entries(cases)) {
    test(group, () => {
      doc.groups[group] = list.map((c) => ({ ...c, expect: j(fill[group](c)) }));
    });
  }
  test("the file is up to date", () => {
    const groups = Object.entries(doc.groups).map(([g, list]) => `  ${JSON.stringify(g)}: [\n${list.map((c) => `   ${JSON.stringify(c)}`).join(",\n")}\n  ]`).join(",\n");
    const text = `{\n "board": [\n${board.map((t) => `  ${JSON.stringify(t)}`).join(",\n")}\n ],\n "groups": {\n${groups}\n }\n}\n`;
    if (UPDATE || !existsSync(FILE)) {
      writeFileSync(FILE, text);
      return;
    }
    expect(readFileSync(FILE, "utf8")).toBe(text);
  });
});
