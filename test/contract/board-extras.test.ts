// Outside-in contract for the board extras on files written before the start (no runs), so the same file runs on any
// server, the Rust board in board mode included (Rust port R12, docs/rust-port-board-plan.md): what the board learned
// (`/learned`: the view, seen, save, drop and keep, undo and redo), Find links (`POST /find-links`, the fake Claude's
// side call answers), a ticket's Usage tab (`GET .../usage` from its run log and side calls) and `GET /api/team-usage`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";
import { asUser } from "./user-browser";

const SLUG = "extras";
const A = "t_20261101_aaaa";
const B = "t_20261101_bbbb";
const C = "t_20261101_cccc";
const RUN = "x-ckanban-run";
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const base = `/api/profiles/${SLUG}`;
const LINKS = JSON.stringify({ links: [{ id: B, parent: A, reason: "  Same   piece of work  " }, { id: C, parent: A, reason: "a tool ticket" }, { id: A, parent: "t_nope" }] });

function ticket(home: string, id: string, f: Record<string, unknown>, body = ""): string {
  const dir = join(home, "profiles", SLUG, "tickets", id);
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = {
    id, title: `Ticket ${id}`, status: "backlog", mode: "interview", order: 1, sessionId: null, worktree: null, runCount: 0,
    parentChecked: true, createdAt: ago(60), updatedAt: ago(30), ...f,
  };
  const yaml = Object.entries(meta).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : String(v)}`).join("\n");
  writeFileSync(join(dir, "ticket.md"), `---\n${yaml}\n---\n${body}`);
  return dir;
}

const rulesMd = (lines: string[]) =>
  "# Lessons learned on this board\n<!-- Newest first. Every run on this board gets these. Undo them from the Team tab's Learned view. -->\n\n" + lines.map((l) => `- ${l} <!-- from @board, 2026-11-01 -->\n`).join("");

function seed(home: string, project: string): void {
  mkdirSync(join(home, "profiles", SLUG), { recursive: true });
  // The board's folder doesn't exist, so no run starts.
  writeFileSync(join(home, "profiles", SLUG, "profile.json"), JSON.stringify({ name: "Extras", slug: SLUG, path: join(project, "gone"), baseBranch: "", model: null, createdAt: "2026-10-01T00:00:00.000Z" }, null, 2) + "\n");
  const a = ticket(home, A, { title: "Login page", status: "done", runCount: 2 }, "Fix the login page");
  ticket(home, B, { title: "Login button", order: 2 }, "The login button");
  ticket(home, C, { title: "A task", order: 3, tool: true });
  const ev = (run: number, at: string, event: object) => JSON.stringify({ run, at, event }) + "\n";
  writeFileSync(join(a, "activity.jsonl"), [
    ev(1, "2026-11-01T09:00:00.000Z", { type: "system", subtype: "init", permissionMode: "plan" }),
    ev(1, "2026-11-01T09:01:00.000Z", { type: "assistant", message: { content: [{ type: "text", text: "x".repeat(5000) }] } }),
    ev(1, "2026-11-01T09:10:00.000Z", { type: "result", session_id: "s1", total_cost_usd: 0.4, modelUsage: { "claude-opus-5-5": { inputTokens: 100, outputTokens: 20, costUSD: 0.4 } } }),
    ev(2, "2026-11-01T10:00:00.000Z", { type: "ckanban_run", kind: "work" }),
    ev(2, "2026-11-01T10:30:00.000Z", { type: "result", session_id: "s1", total_cost_usd: 1.5, modelUsage: { "claude-opus-5-5": { inputTokens: 300, outputTokens: 50, costUSD: 1.5 } } }),
  ].join(""));
  writeFileSync(join(a, "side-spend.jsonl"), JSON.stringify({ at: "2026-11-01T11:00:00.000Z", kind: "simplify", costUsd: 0.25 }) + "\n");
  mkdirSync(join(home, "profiles", SLUG, "huddles"), { recursive: true });
  writeFileSync(join(home, "profiles", SLUG, "huddles", "h_x1.json"), JSON.stringify({
    id: "h_x1", hostTicket: A, createdAt: "2026-11-01T12:00:00.000Z", status: "closed", template: "review",
    participants: [
      { kind: "human", handle: "you", role: "you" },
      { kind: "agent", handle: "qa", role: "QA", preset: "qa", joinedAt: "2026-11-01T12:01:00.000Z", costUsd: 0.5 },
    ],
  }, null, 2));
  // What the board learned: a rule saved by an earlier change, lessons seen once.
  mkdirSync(join(home, "learned"), { recursive: true });
  const before = rulesMd(["Old rule"]);
  const after = rulesMd(["Run the tests first", "Old rule"]);
  writeFileSync(join(home, "profiles", SLUG, "learned-rules.md"), after);
  const src = { kind: "ticket", slug: SLUG, id: A, title: "Login page", by: "you", at: ago(20), quote: "run the tests", key: `ticket:${SLUG}/${A}` };
  const cand = (id: string, text: string, general: boolean, state = "watching", lastAt = ago(10)) =>
    ({ id, kind: "ticket", text, general, dest: { kind: "rules", slug: SLUG }, sources: [src], firstAt: lastAt, lastAt, state });
  writeFileSync(join(home, "learned", "pile.json"), JSON.stringify({
    candidates: [cand("c_save", "Ask before deleting files", true), cand("c_raw", "the user said no", false, "watching", ago(5)), cand("c_saved", "Run the tests first", true, "saved")],
    scanned: {}, since: ago(10_000),
  }, null, 2) + "\n");
  writeFileSync(join(home, "learned", "changes.json"), JSON.stringify([{
    id: "ch_1", at: ago(15), kind: "saved", slug: SLUG,
    edits: [{ file: join(home, "profiles", SLUG, "learned-rules.md"), role: "rules", scope: "repo", slug: SLUG, before, after }],
    text: "Run the tests first", old: [], where: "Rule for this board", candidateId: "c_saved", sources: [src],
  }], null, 2) + "\n");
}

let d: Daemon;
beforeAll(async () => {
  d = await startDaemon({ before: ({ home, project }) => seed(home, project), env: { FAKE_SIDE_JSON: "1", FAKE_SIDE_TEXT: LINKS } });
}, 60_000);
afterAll(async () => {
  await d?.stop();
});

const rules = () => readFileSync(join(d.home, "profiles", SLUG, "learned-rules.md"), "utf8");
const pile = () => JSON.parse(readFileSync(join(d.home, "learned", "pile.json"), "utf8"));

describe("learned", () => {
  test("the view: this week's saved lessons, lessons seen once newest first, the new count; seen clears it", async () => {
    const v = await d.api("GET", `${base}/learned`);
    expect(v.status).toBe(200);
    expect(v.data.saved.map((c: any) => c.id)).toEqual(["ch_1"]);
    expect(v.data.watching.map((c: any) => c.id)).toEqual(["c_raw", "c_save"]);
    expect(v.data).toMatchObject({ cleaned: [], newCount: 1, tidyAt: null });
    expect((await d.api("GET", `${base}/learned?count=1`)).data).toEqual({ newCount: 1 });
    expect((await d.api("POST", `${base}/learned/seen`, {})).data.newCount).toBe(0);
    expect(pile().seen[SLUG]).toEqual(expect.any(String));
    expect((await d.api("GET", "/api/profiles/nope/learned")).status).toBe(404);
  });

  test("save now, drop and keep: the user's only; a lesson not in general words waits", async () => {
    expect((await d.api("POST", `${base}/learned/lessons/c_save/save`, {}, { [RUN]: `${SLUG}/${A}` })).status).toBe(403);
    expect((await d.api("POST", `${base}/learned/lessons/c_raw/save`, {})).status).toBe(409);
    expect((await d.api("POST", `${base}/learned/lessons/gone/save`, {})).status).toBe(404);
    const saved = await d.api("POST", `${base}/learned/lessons/c_save/save`, {});
    expect(saved.status).toBe(200);
    expect(saved.data).toMatchObject({ id: "c_save", state: "saved", changeId: expect.any(String) });
    expect(rules()).toStartWith("# Lessons learned on this board\n");
    expect(rules()).toContain("\n\n- Ask before deleting files <!-- from @board, ");
    expect((await d.api("POST", `${base}/learned/lessons/c_save/drop`, {})).status).toBe(409);
    expect((await d.api("POST", `${base}/learned/lessons/c_raw/drop`, {})).data.state).toBe("dropped");
    expect((await d.api("POST", `${base}/learned/lessons/c_raw/keep`, {})).data.state).toBe("watching");
    expect((await d.api("GET", `${base}/learned/lessons/c_raw/keep`)).status).toBe(404);
    expect((await d.api("POST", `${base}/learned/lessons/c_raw/whatever`, {})).status).toBe(404);
  });

  test("undo and redo a saved lesson: the file goes back, the lesson is marked undone", async () => {
    const was = rules();
    const undone = await d.api("POST", `${base}/learned/changes/ch_1/undo`, {});
    expect(undone.status).toBe(200);
    expect(undone.data.undoneAt).toEqual(expect.any(String));
    expect(rules()).not.toContain("Run the tests first");
    expect(rules()).toContain("Ask before deleting files");
    expect(pile().candidates.find((c: any) => c.id === "c_saved").state).toBe("undone");
    expect((await d.api("POST", `${base}/learned/changes/ch_1/undo`, {})).status).toBe(409);
    const redone = await d.api("POST", `${base}/learned/changes/ch_1/redo`, {});
    expect(redone.data.undoneAt).toBeNull();
    expect(rules()).toBe(was);
    expect((await d.api("POST", `${base}/learned/changes/nope/undo`, {})).status).toBe(404);
  });
});

describe("find links", () => {
  test("Claude's links that can be made, tool tickets left out; a board run is refused", async () => {
    expect((await d.api("POST", `${base}/find-links`, {}, { origin: d.url, [RUN]: `${SLUG}/${A}` })).status).toBe(403);
    const r = await asUser(d.url, "POST", `${base}/find-links`, {});
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ links: [{ id: B, parent: A, reason: "Same piece of work" }], checked: 2 });
  });
});

describe("usage", () => {
  test("a ticket's runs, side calls and huddle teammates", async () => {
    const r = await d.api("GET", `${base}/tickets/${A}/usage`);
    expect(r.status).toBe(200);
    expect(r.data.runs).toEqual([
      { run: 1, kind: "planning", startedAt: "2026-11-01T09:00:00.000Z", model: "claude-opus-5-5", tokens: 120, costUsd: 0.4, pct5h: null },
      { run: 2, kind: "work", startedAt: "2026-11-01T10:00:00.000Z", model: "claude-opus-5-5", tokens: 230, costUsd: 1.1, pct5h: null },
    ]);
    expect(r.data.totals).toEqual({ costUsd: 2.25, tokens: 350, pctCurrentWindow: null, pctLifetime: null });
    expect(r.data.sideCostUsd).toBe(0.25);
    expect(r.data.teammates).toEqual({ costUsd: 0.5, huddles: [{ id: "h_x1", status: "closed", createdAt: "2026-11-01T12:00:00.000Z", costUsd: 0.5, teammates: [{ handle: "qa", role: "QA", costUsd: 0.5 }] }] });
    expect(r.data.window).toBeNull();
    expect("windowError" in r.data).toBe(true);
    const empty = await d.api("GET", `${base}/tickets/${B}/usage`);
    expect(empty.data).toMatchObject({ runs: [], totals: { costUsd: 0, tokens: 0 }, teammates: null, sideCostUsd: 0 });
    expect((await d.api("GET", `${base}/tickets/t_20261101_zzzz/usage`)).status).toBe(404);
  });

  test("GET /api/team-usage counts each teammate's and squad's huddles on every board", async () => {
    const r = await d.api("GET", "/api/team-usage");
    expect(r.status).toBe(200);
    const recent = { board: SLUG, huddle: "h_x1", ticket: A, title: "Login page" };
    expect(r.data).toEqual({
      teammates: { qa: { huddles: 1, lastUsed: "2026-11-01T12:01:00.000Z", costUsd: 0.5, recent: [{ ...recent, at: "2026-11-01T12:01:00.000Z", costUsd: 0.5 }] } },
      templates: { review: { huddles: 1, lastUsed: "2026-11-01T12:00:00.000Z", costUsd: 0.5, recent: [{ ...recent, at: "2026-11-01T12:00:00.000Z", costUsd: 0.5 }] } },
    });
    expect(existsSync(join(d.home, "learned"))).toBe(true);
  });
});
