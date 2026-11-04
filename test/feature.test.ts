// Features: the pinned "Where we are" status (update_status, notes, the nudge), test verdicts, flat rounds, the depth
// limit, gathering tickets and the New ticket word match.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { familyOf, familyState, suggestFeature } from "../web/src/family";
import { parseResult } from "../src/server/result";
import type { Ticket } from "../src/server/types";
import { board, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { until } from "./helpers";

useBoardEnv();

const mk = (title: string, extra: Parameters<typeof board.createTicket>[1] extends infer I ? Partial<I> : never = {}) =>
  board.createTicket("p", { title, body: "", status: "backlog", mode: "auto", ...extra });
const get = (id: string) => store.getTicket("p", id)!;

/** A feature: top, a "Builds" group with two builds, a round with two tests, and a fix right under the top. */
async function feature() {
  const top = await mk("AI Outreach");
  const builds = await mk("Builds", { kind: "group", partOf: top.id });
  const b1 = await mk("Campaign screen", { kind: "build", partOf: builds.id });
  const b2 = await mk("Send queue", { kind: "build", partOf: builds.id });
  const round = await mk("anything", { kind: "round", partOf: top.id });
  const t1 = await mk("Test: retry after a failed send", { kind: "test", partOf: round.id });
  const t2 = await mk("Test: WhatsApp window", { kind: "test", partOf: round.id });
  const fix = await mk("Fix retry count", { kind: "fix", partOf: top.id });
  return { top, builds, b1, b2, round, t1, t2, fix };
}

test("update_status writes status.md with the board's counts, verdicts and pull requests, replacing only the sections it names", async () => {
  await setup();
  const f = await feature();
  store.updateTicket("p", f.b1.id, { status: "done", outcome: "done", prUrl: "https://github.com/x/y/pull/37161", prs: [{ url: "https://github.com/x/y/pull/37161", state: "MERGED" }] });
  store.updateTicket("p", f.b2.id, { status: "review", outcome: "done", prUrl: "https://github.com/x/y/pull/37162", prs: [{ url: "https://github.com/x/y/pull/37162", state: "OPEN" }] });
  store.updateTicket("p", f.t1.id, { status: "done", outcome: "done" });
  store.updateTicket("p", f.t2.id, { status: "review", outcome: "done", verdict: "problem" });
  store.updateTicket("p", f.fix.id, { status: "review", outcome: "failed" });

  const r = board.updateStatus("p", f.t1.id, { goal: "Agents reach contacts by WhatsApp.", next: "Fix the window check.", prNotes: { "https://github.com/x/y/pull/37161": "on staging" } });
  expect(r.top.id).toBe(f.top.id);
  expect(get(f.top.id).statusAt).toBeTruthy();
  const md = readFileSync(join(store.outputsPath("p", f.top.id), "status.md"), "utf8");
  expect(md).toContain("Agents reach contacts by WhatsApp.");
  expect(md).toContain("Builds (2 done)");
  expect(md).toContain("Testing round 1 (1 passed, 1 found a problem)");
  expect(md).toContain("Fix retry count (failed)");
  expect(md).toContain("Test: WhatsApp window (found a problem)");
  expect(md).toContain("#37161 Campaign screen · merged · on staging");
  expect(md).toContain("#37162 Send queue · open");
  expect(md).toContain("## Next step\n\nFix the window check.");
  expect(r.facts.rounds).toEqual([{ id: f.round.id, title: "Testing round 1", passed: 1, problem: 1, open: 0 }]);

  // Only the named section changes.
  const r2 = board.updateStatus("p", f.top.id, { next: "Deploy to staging." });
  expect(r2.saved?.goal).toBe("Agents reach contacts by WhatsApp.");
  expect(r2.saved?.next).toBe("Deploy to staging.");
  expect(r2.saved?.prNotes).toEqual({ "https://github.com/x/y/pull/37161": "on staging" });
  expect(r2.sections.map((s) => s.key)).toEqual(["goal", "done", "broken", "prs", "next"]);
  expect(readFileSync(r2.path, "utf8")).toContain("Deploy to staging.");
});

test("update_status on a ticket that isn't a feature yet gives it a status, which makes it one", async () => {
  await setup();
  const solo = await mk("Small thing");
  expect(board.featureStatus("p", solo.id).feature).toBe(false);
  board.updateStatus("p", solo.id, { goal: "Do the small thing." });
  expect(board.featureStatus("p", solo.id).feature).toBe(true);
});

test("a main-chat run that changed the family without calling update_status gets exactly one nudge", async () => {
  await setup();
  const f = await feature();
  board.updateStatus("p", f.top.id, { goal: "G" });
  // The family changes: a test passes.
  store.updateTicket("p", f.t1.id, { status: "done", outcome: "done" });
  await board.chat("p", f.top.id, "where are we?");
  await untilSpawned(2);
  await until(() => !board.isRunning("p", f.top.id));
  await Bun.sleep(300);
  const prompts = readArgs().map((a) => a.prompt);
  expect(prompts.length).toBe(2);
  expect(prompts.filter((p) => p.includes("family changed since its status was last updated")).length).toBe(1);
  expect(prompts[1]).toContain(`"Test: retry after a failed send" is now done (done)`);
  // The main chat was told to read status.md first.
  const sys = readArgs()[0].args;
  expect(sys[sys.indexOf("--append-system-prompt") + 1]).toContain("main chat of a feature");
  // The nudge is quiet: the card stays where the reply left it (a Planning chat here).
  expect(get(f.top.id).status).toBe("planning");

  // Status up to date (as if Claude called update_status): no nudge.
  board.updateStatus("p", f.top.id, { next: "N" });
  await board.chat("p", f.top.id, "thanks");
  await untilSpawned(3);
  await until(() => !board.isRunning("p", f.top.id));
  await Bun.sleep(300);
  expect(readArgs().length).toBe(3);
}, 30000);

test("a test ticket with verdict problem counts as Found a problem; one without a verdict as passed", async () => {
  await setup();
  const f = await feature();
  process.env.FAKE_VERDICT = "problem";
  try {
    await board.updateTicket("p", f.t2.id, { status: "ready" });
    await until(() => get(f.t2.id).status === "review");
  } finally {
    delete process.env.FAKE_VERDICT;
  }
  expect(get(f.t2.id).verdict).toBe("problem");
  expect(familyState(get(f.t2.id))).toBe("problem");
  expect(familyState({ ...get(f.t1.id), status: "done", outcome: "done" })).toBe("passed");
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"x","verdict":"passed"}')?.verdict).toBe("passed");
  expect(parseResult('CKANBAN_RESULT: {"status":"done","prUrl":null,"summary":"x","verdict":"maybe"}')?.verdict).toBeUndefined();
});

test("a round is titled Testing round N and hangs under the top ticket, even when created under a group", async () => {
  await setup();
  const f = await feature();
  const r2 = await mk("Round two please", { kind: "round", partOf: f.builds.id });
  expect(r2.title).toBe("Testing round 2");
  expect(r2.partOf).toBe(f.top.id);
  const r3 = await mk("x", { kind: "round", partOf: f.t1.id });
  expect(r3.title).toBe("Testing round 3");
  expect(r3.partOf).toBe(f.top.id);
  // A round on its own starts a new numbering.
  expect((await mk("y", { kind: "round" })).title).toBe("Testing round 1");
});

test("a new link 3 levels deep is refused with a hint where to put it", async () => {
  await setup();
  const f = await feature();
  await expect(mk("Too deep", { partOf: f.b1.id })).rejects.toThrow(/at most 2 levels deep\. Put it under the feature "AI Outreach" \(.*\) or one of its groups: "Builds"/);
  const loose = await mk("Loose");
  await expect(board.setPartOf("p", loose.id, f.t1.id)).rejects.toThrow(/under the feature "AI Outreach"/);
  // Level 2 is fine.
  expect((await mk("OK", { partOf: f.builds.id })).partOf).toBe(f.builds.id);
});

test("gathering links the picked tickets, moves too-deep children up and leaves running tickets running", async () => {
  await setup({ maxParallel: 2 });
  const f = await feature();
  // Another family: X > Y > Z.
  const x = await mk("Outreach: old work");
  const y = await mk("Outreach: part", { partOf: x.id });
  const z = await mk("Outreach: detail", { partOf: y.id });
  process.env.FAKE_MODE = "slow";
  const running = await mk("Outreach: still running");
  await board.updateTicket("p", running.id, { status: "ready" });
  await until(() => board.isRunning("p", running.id));

  const r = await board.gather("p", f.top.id, [{ id: x.id, group: f.builds.id }, { id: running.id, group: "new" }], "Fixes");
  expect(r.skipped).toEqual([]);
  expect(r.group?.kind).toBe("group");
  expect(r.group?.partOf).toBe(f.top.id);
  expect(get(x.id).partOf).toBe(f.builds.id);
  // Y (level 3 under X) and then Z moved up beside X, under the group.
  expect(get(y.id).partOf).toBe(f.builds.id);
  expect(get(z.id).partOf).toBe(f.builds.id);
  expect(r.movedUp.map((m) => m.id).sort()).toEqual([y.id, z.id].sort());
  expect(Math.max(...familyOf(store.listTickets("p"), f.top.id).map((row) => row.depth))).toBe(2);
  expect(get(running.id).partOf).toBe(r.group!.id);
  expect(board.isRunning("p", running.id)).toBe(true);
});

test("a note from Add a note reaches the main chat's next turn without starting a run", async () => {
  await setup();
  const f = await feature();
  board.addStatusNote("p", f.top.id, "Wilson wants to drop call transfer.");
  await Bun.sleep(200);
  expect(board.isRunning("p", f.top.id)).toBe(false);
  expect(readArgs().length).toBe(0);
  const saved = board.featureStatus("p", f.top.id).saved!;
  expect(saved.notes?.[0].text).toBe("Wilson wants to drop call transfer.");

  await board.chat("p", f.top.id, "what's next?");
  await untilSpawned(1);
  await until(() => !board.isRunning("p", f.top.id));
  expect(readArgs()[0].prompt).toContain("Wilson wants to drop call transfer.");
  // Only once.
  expect(board.featureStatus("p", f.top.id).saved!.notes?.[0].delivered).toBe(true);
});

test("the New ticket word match suggests the feature with the most shared words, ties to the most recently touched", () => {
  const t = (id: string, title: string, extra: Partial<Ticket> = {}): Ticket => ({
    id, title, status: "in_progress", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", body: "", ...extra,
  }) as Ticket;
  const tickets = [
    t("a", "AI Outreach"), t("a1", "Outreach agent booked call", { partOf: "a" }), t("a2", "WhatsApp send queue", { partOf: "a" }),
    t("b", "Billing page", { updatedAt: "2026-11-03T00:00:00Z" }), t("b1", "Billing invoices", { partOf: "b" }), t("b2", "Billing agent call", { partOf: "b" }),
    t("c", "Done feature outreach agent call", { status: "done" }), t("c1", "x", { partOf: "c" }), t("c2", "y", { partOf: "c" }),
  ];
  const s = suggestFeature(tickets, "AI outreach: agent says it can't cancel a booked call", "");
  expect(s?.feature.id).toBe("a");
  expect(s?.words.sort()).toEqual(["agent", "booked", "call", "outreach"]);
  // One shared word is not enough; short and common words don't count.
  expect(suggestFeature(tickets, "the outreach", "")).toBeNull();
  // A tie goes to the most recently touched feature.
  expect(suggestFeature(tickets, "agent call", "")?.feature.id).toBe("b");
});
