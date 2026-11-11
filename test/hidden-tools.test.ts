// Phase 3: tool tickets have no card (one card per feature). Attention rolls up to the main ticket, "with you" tool
// tickets (hidden too) talk to the user in the main ticket's chat and may notify, Stop / Backlog / Delete on the main ticket act on its tool tickets, search finds
// tool tickets through their main card, and the other list readers skip them by default.
import { expect, test } from "bun:test";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { attentionFor, boardTitles, ticketAttention } from "../src/server/attention";
import { createServer } from "../src/server/http";
import { Linker } from "../src/server/linker";
import { familyCard, KIND_DEFAULTS, stepName, stepWait, TOOL_NO_NOTIFY, youWaiting } from "../src/server/main-ticket";
import { statusFacts, statusSections } from "../src/server/feature";
import { pickRelated } from "../src/server/recall";
import type { Ticket } from "../src/server/types";
import { ticketCommand } from "../src/ticket-cli";
import { deleteTitle, parkNeedsConfirm, parkText, parkTitle, stopTitle } from "../web/src/familyActions";
import { hiddenTool, mainTicketOf, TICKET_KINDS, withYouTool } from "../web/src/family";
import { groupByColumn } from "../web/src/columns";
import { searchBoard } from "../web/src/toolTickets";
import { board, setup, store, useBoardEnv } from "./board-env";
import { tempDir } from "./helpers";

useBoardEnv();

const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 10, min)).toISOString();
const tk = (id: string, x: Partial<Ticket> = {}) => ({
  id, title: id, status: "backlog", outcome: null, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null,
  lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: at(0), updatedAt: at(0), mode: "auto", ...x,
}) as Ticket;

/** A feature: main ticket M with a testing round of 6 tests (4 passed, 2 working), a build, a with-you step, a ticket the user added and an old plan child. */
function feature(extra: Partial<Ticket> = {}) {
  const main = tk("M", { title: "AI Outreach", main: true, status: "review", outcome: "done", runEndedAt: at(5), ...extra });
  const round = tk("R", { title: "Testing round 2", parentId: "M", tool: true, kind: "round", status: "in_progress" });
  const tests = [1, 2, 3, 4, 5, 6].map((n) => tk(`T${n}`, {
    title: `Test ${n}`, parentId: "R", tool: true, kind: "test",
    ...(n <= 4 ? { status: "done", outcome: "done", verdict: "passed" } : { status: "in_progress", runStartedAt: at(20 + n) }),
  }));
  const build = tk("B", { title: "Build the queue", parentId: "M", tool: true, kind: "build", status: "done", outcome: "done", runStartedAt: at(2) });
  const withYou = tk("W", { title: "Phone call on Leo's WhatsApp", parentId: "M", tool: true, kind: "with_you", status: "done", outcome: "done" });
  const added = tk("U", { title: "Copy for the landing page", partOf: "M", status: "review", outcome: "done" });
  const old = tk("O", { title: "Old plan child", parentId: "M", status: "review", outcome: "done" });
  return { main, round, tests, build, withYou, added, old, all: [main, round, ...tests, build, withYou, added, old] };
}

test("the with_you kind exists with Sonnet at medium; every tool ticket is hidden, with you ones too", () => {
  expect(TICKET_KINDS).toContain("with_you");
  expect(KIND_DEFAULTS.with_you).toEqual({ model: "sonnet", effort: "medium" });
  expect(hiddenTool(tk("a", { tool: true, kind: "test" }))).toBe(true);
  expect(hiddenTool(tk("a", { tool: true, kind: "with_you" }))).toBe(true);
  expect(withYouTool(tk("a", { tool: true, kind: "with_you" }))).toBe(true);
  expect(withYouTool(tk("a", { tool: true, kind: "test" }))).toBe(false);
  // An old plan child has no tool flag: it keeps its card.
  expect(hiddenTool(tk("a", { parentId: "M" }))).toBe(false);
  expect(stepName({ title: "checkout sign-in", kind: "test" })).toBe("Test: checkout sign-in");
  expect(stepName({ title: "Test: checkout sign-in", kind: "test" })).toBe("Test: checkout sign-in");
});

test("the board shows one card for the feature, plus the added ticket and the old plan child; columns don't count tool tickets", () => {
  const f = feature();
  const { shown, via } = searchBoard(f.all, () => true);
  expect(shown.map((t) => t.id).sort()).toEqual(["M", "O", "U"]);
  expect(via.size).toBe(0);
  const cols = groupByColumn(shown);
  expect(cols.get("in_progress")!.length).toBe(0);
  expect(cols.get("review")!.map((t) => t.id).sort()).toEqual(["M", "O", "U"]);
  expect(mainTicketOf(f.all, "T5")?.id).toBe("M");
});

test("search finds a tool ticket and shows its main card, via that tool ticket", () => {
  const f = feature();
  const q = "test 5";
  const hit = (t: Ticket) => `${t.title}\n${t.body}`.toLowerCase().includes(q);
  const r = searchBoard(f.all, hit, () => true, true);
  expect(r.shown.map((t) => t.id)).toEqual(["M"]);
  expect(r.via.get("M")).toBe("Test 5");
  // The main ticket matching itself: no via.
  const r2 = searchBoard(f.all, (t) => t.title.includes("Outreach") || t.title === "Test 5", () => true, true);
  expect(r2.via.has("M")).toBe(false);
});

test("a tool ticket has no Your turn; its question shows on the main card naming the step", () => {
  const f = feature();
  const ask = tk("Q", { title: "checkout sign-in", parentId: "M", tool: true, kind: "test", status: "review", outcome: "needs_input", runEndedAt: at(30) });
  expect(attentionFor(ask, null, false)).toBeNull();
  const step = stepWait(ask, false)!;
  expect(step.label).toBe("Test: checkout sign-in asks a question");
  // The main ticket hasn't run since the step asked: its card says so (over a plain "Ready for review").
  const a = attentionFor(f.main, null, false, { step })!;
  expect(a).toMatchObject({ kind: "questions", label: "Test: checkout sign-in asks a question" });
  // The main ticket passes the question on to the user: still named after the step.
  const passed = attentionFor({ ...f.main, outcome: "needs_input", runEndedAt: at(40) }, null, false, { step })!;
  expect(passed).toMatchObject({ kind: "questions", label: "Test: checkout sign-in asks a question" });
  // It ran since and moved on (answered the step itself): no step on its card.
  expect(attentionFor({ ...f.main, runEndedAt: at(40) }, null, false, { step })?.kind).toBe("review");
  // A wake is on its way: the main ticket handles it first.
  const waking = { ...f.main, plan: { state: "running", inbox: ["finished: Q"] } as any };
  expect(attentionFor(waking, null, false, { step })).toBeNull();
});

test("ticketAttention: tool tickets need nothing themselves, the main ticket says Needs you for a with-you step, and the paused main ticket rolls up the oldest step", async () => {
  await setup();
  const main = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
  store.updateTicket("p", main.id, { status: "review", outcome: "done", runEndedAt: at(1), plan: { state: "running", wakeups: 0, startedAt: at(0), originalCount: 0, inbox: [], seen: {}, retries: {}, awaiting: null } });
  const mk = async (title: string, kind: Ticket["kind"], x: Partial<Ticket>) => {
    const t = await board.createTicket("p", { title, body: "", status: "backlog", mode: "auto", parentId: main.id, tool: true, kind });
    return store.updateTicket("p", t.id, x);
  };
  const failed = await mk("Build the queue", "build", { status: "review", outcome: "failed", runEndedAt: at(20) });
  const asks = await mk("checkout sign-in", "test", { status: "review", outcome: "needs_input", runEndedAt: at(10) });
  const live = await mk("Phone call", "with_you", { status: "review", outcome: "needs_input", runEndedAt: at(30) });
  const att = (t: Ticket) => ticketAttention(store, "p", store.getTicket("p", t.id)!, null, false);
  expect(att(failed)).toBeNull();
  expect(att(asks)).toBeNull();
  expect(att(live)).toBeNull();
  // A with-you step waits for the user whatever the main ticket does: the main card says so, also while its plan runs.
  expect(att(main)).toMatchObject({ kind: "questions", label: "Phone call needs you" });
  expect(board.waitsOnUser("p", live.id)).toBe(true);
  // Two of them: counted.
  const live2 = await mk("Approve the copy", "with_you", { status: "review", outcome: "needs_input", runEndedAt: at(31) });
  expect(att(main)).toMatchObject({ kind: "questions", label: "2 tasks need you" });
  // Answered (an answer queued or the step running again): no longer waiting.
  store.updateTicket("p", live.id, { status: "in_progress" });
  store.updateTicket("p", live2.id, { status: "done", outcome: "done" });
  expect(board.waitsOnUser("p", live.id)).toBe(false);
  // The plan already queued a wake for the main ticket: it handles the step before the user hears of it.
  expect(att(main)).toBeNull();
  // Paused (the user said Stop here): the step that asks shows on the main card.
  store.updateTicket("p", main.id, { plan: { ...store.getTicket("p", main.id)!.plan!, state: "paused" } });
  expect(att(main)).toMatchObject({ kind: "questions", label: "Test: checkout sign-in asks a question" });
  // Title dedup leaves hidden tool tickets out.
  const titles = boardTitles(store.listTickets("p"), "x");
  expect(titles.has("build the queue")).toBe(false);
  expect(titles.has("phone call")).toBe(false);
});

test("the main card's line: a step that needs you, then failed or stuck, then paused, then the newest working group", () => {
  const f = feature();
  const run = (ids: string[]) => (id: string) => ids.includes(id);
  const family = f.all.filter((t) => t.id !== "M");
  const working = familyCard(f.main, family, f.all, run(["T5", "T6"]), 41.2);
  expect(working.line).toEqual({ text: "Testing round 2: 4 of 6 passed", tone: "work" });
  expect(working.tools).toBe(9);
  expect(working.open).toBe(family.filter((t) => t.tool && t.status !== "done").length);
  // Every tool ticket in Done: nothing open (so Backlog / Done moves without asking).
  const allDone = family.map((t) => (t.tool ? { ...t, status: "done" as const } : t));
  expect(familyCard(f.main, allDone, f.all, run([]), 0).open).toBe(0);
  // One left (failed, not in Done): open again.
  const oneLeft = allDone.map((t, i) => (i === allDone.findIndex((x) => x.tool) ? { ...t, status: "review" as const, outcome: "failed" as const } : t));
  expect(familyCard(f.main, oneLeft, f.all, run([]), 0).open).toBe(1);
  expect(working.running).toEqual(["Testing round 2", "Test 5", "Test 6"]);
  expect(working.costUsd).toBe(41.2);
  // A build ticket started last speaks for itself.
  const b2 = tk("B2", { title: "checkout page", parentId: "M", tool: true, kind: "build", status: "in_progress", runStartedAt: at(50) });
  expect(familyCard(f.main, [...family, b2], [...f.all, b2], run(["T5", "T6", "B2"]), 0).line?.text).toBe("Build: checkout page");
  // Paused on a usage limit beats working.
  const lim = tk("L", { title: "Test 7", parentId: "R", tool: true, kind: "test", status: "review", outcome: "limit", limit: { resetAt: at(300), auto: true, at: at(10), message: "limit" } });
  const paused = familyCard(f.main, [...family, lim], [...f.all, lim], run(["T5"]), 0);
  expect(paused.line).toEqual({ text: "Paused: usage limit", tone: "warn", until: at(300) });
  // A failure the main ticket hasn't moved past beats paused.
  const bad = tk("F", { title: "Build retry", parentId: "M", tool: true, kind: "build", status: "review", outcome: "failed", runEndedAt: at(40) });
  const failed = familyCard({ ...f.main, runEndedAt: at(45) }, [...family, lim, bad], [...f.all, lim, bad], run(["T5"]), 0);
  expect(failed.line).toEqual({ text: "Build retry failed", tone: "fail" });
  // Stuck shows in the line's place; stuck with a failed step names the step (that is what needs the user).
  const stuckMain = { ...f.main, runEndedAt: at(45), plan: { state: "stuck", reason: "3 wakes in a row without any tool ticket changing" } as any };
  expect(familyCard(stuckMain, family, f.all, run(["T5"]), 0).line).toEqual({ text: "Stuck: 3 wakes in a row without any tool ticket changing", tone: "warn" });
  expect(familyCard(stuckMain, [...family, bad], [...f.all, bad], run([]), 0).line?.text).toBe("Build retry failed");
  // A step that needs the user beats everything.
  const ask = tk("A", { title: "checkout sign-in", parentId: "M", tool: true, kind: "test", status: "review", outcome: "needs_input", runEndedAt: at(46) });
  const needs = familyCard({ ...f.main, runEndedAt: at(45) }, [...family, lim, bad, ask], [...f.all, lim, bad, ask], run(["T5"]), 0);
  expect(needs.line).toEqual({ text: "Test: checkout sign-in asks a question", tone: "warn" });
  expect(needs.waiting?.id).toBe("A");
  expect(needs.needsYou).toEqual([]);
  // A with-you step waiting for the user beats that, even when the main ticket ran since: only the user answers it.
  const live = tk("W2", { title: "Staging check", parentId: "M", tool: true, kind: "with_you", status: "review", outcome: "needs_input", runEndedAt: at(30) });
  const you = familyCard({ ...f.main, runEndedAt: at(50) }, [...family, ask, live], [...f.all, ask, live], run(["T5"]), 0);
  expect(you.line).toEqual({ text: "Staging check needs you", tone: "warn" });
  expect(you.needsYou.map((w) => w.id)).toEqual(["W2"]);
  // An answer on its way (queued) or a running step: not waiting.
  const queued = { ...live, queued: [{ id: "q", text: "yes", at: at(51) }] } as any;
  expect(familyCard(f.main, [...family, queued], [...f.all, queued], run([]), 0).needsYou).toEqual([]);
  expect(familyCard(f.main, [...family, live], [...f.all, live], run(["W2"]), 0).needsYou).toEqual([]);
});

test("the confirms name the count and the cost; only main tickets with tool tickets ask before Backlog or Done", () => {
  const t = { title: "AI Outreach", main: true, status: "review", familyCard: { tools: 14, running: ["a", "b"], costUsd: 41.2 } };
  expect(stopTitle(t)).toBe("Stop AI Outreach and its 2 running tasks?");
  expect(deleteTitle(t)).toBe("Delete AI Outreach and its 14 tasks ($41.20 spent)?");
  expect(parkNeedsConfirm(t, "backlog")).toBe(true);
  expect(parkNeedsConfirm(t, "in_progress")).toBe(false);
  expect(parkNeedsConfirm({ ...t, main: false }, "done")).toBe(false);
  // Only unfinished steps count: every tool ticket done moves straight away; one open asks, naming just that one.
  expect(parkNeedsConfirm({ ...t, familyCard: { ...t.familyCard, open: 0 } }, "done")).toBe(false);
  const one = { ...t, familyCard: { ...t.familyCard, open: 1 } };
  expect(parkNeedsConfirm(one, "done")).toBe(true);
  expect(parkTitle(one, "done")).toBe('Move "AI Outreach" and its 1 unfinished task to Done?');
  expect(parkTitle({ ...t, familyCard: { ...t.familyCard, open: 3 } }, "backlog")).toBe('Move "AI Outreach" and its 3 unfinished tasks to Backlog?');
  expect(deleteTitle({ title: "Fix login" })).toBe('Delete "Fix login"?');
  // The words users see say "task", never "tool ticket".
  expect(parkText(t)).toBe("No new tasks start; the 2 running ones finish, and queued ones are kept. Move it back to In progress to let them start again. \$41.20 spent so far.");
  for (const s of [stopTitle(t), deleteTitle(t), parkTitle(t, "done"), parkText(t)]) expect(s).not.toContain("tool ticket");
});

/** A main ticket with tool tickets (one with you), a ticket the user added and an old plan child, on the real board. */
async function realFeature() {
  await setup();
  const main = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
  store.updateTicket("p", main.id, { status: "review", outcome: "done" });
  const tool = async (title: string, kind: Ticket["kind"], x: Partial<Ticket> = {}) => {
    const t = await board.createTicket("p", { title, body: "", status: "backlog", mode: "auto", parentId: main.id, tool: true, kind });
    return store.updateTicket("p", t.id, x);
  };
  const running = await tool("Build the queue", "build", { status: "in_progress" });
  const queued = await tool("Test sign-in", "test", { status: "ready" });
  const waiting = await tool("Test replies", "test");
  const live = await tool("Phone call", "with_you", { status: "in_progress" });
  const added = await board.createTicket("p", { title: "Landing copy", body: "", status: "backlog", mode: "auto", partOf: main.id });
  store.updateTicket("p", added.id, { status: "in_progress" });
  const old = await board.createTicket("p", { title: "Old plan child", body: "", status: "backlog", mode: "auto", parentId: main.id });
  store.updateTicket("p", old.id, { status: "in_progress" });
  return { main, running, queued, waiting, live, added, old };
}

test("Stop on a main ticket stops its tool tickets only; queued ones go back to waiting and the plan pauses", async () => {
  const f = await realFeature();
  board.ensurePlan("p", f.main.id);
  store.updateTicket("p", f.main.id, { plan: { ...store.getTicket("p", f.main.id)!.plan!, state: "running" } });
  const r = board.stopFamily("p", f.main.id);
  expect(r.tools).toBe(2);
  const g = (t: Ticket) => store.getTicket("p", t.id)!;
  expect(g(f.running)).toMatchObject({ status: "review", outcome: "stopped" });
  expect(g(f.live)).toMatchObject({ status: "review", outcome: "stopped" });
  expect(g(f.queued).status).toBe("backlog");
  expect(g(f.waiting).status).toBe("backlog");
  // Other family members keep going.
  expect(g(f.added).status).toBe("in_progress");
  expect(g(f.old).status).toBe("in_progress");
  expect(g(f.main).plan?.state).toBe("paused");
});

test("a main ticket in Backlog or Done starts no new tool tickets; back in progress they start again", async () => {
  await setup();
  const main = await board.createTicket("p", { title: "AI Outreach", body: "", status: "backlog", mode: "auto", main: true });
  const t = await board.createTicket("p", { title: "Look around", body: "", status: "backlog", mode: "auto", parentId: main.id, tool: true, kind: "explore" });
  board.ensurePlan("p", main.id);
  store.updateTicket("p", main.id, { status: "backlog" });
  board.advancePlans("p");
  expect(store.getTicket("p", t.id)!.status).toBe("backlog");
  store.updateTicket("p", main.id, { status: "done" });
  board.advancePlans("p");
  expect(store.getTicket("p", t.id)!.status).toBe("backlog");
  store.updateTicket("p", main.id, { status: "review" });
  board.advancePlans("p");
  expect(["ready", "in_progress"]).toContain(store.getTicket("p", t.id)!.status);
  board.stopFamily("p", main.id);
  await board.whenIdle();
});

test("Delete on a main ticket deletes its tool tickets only (others are unlinked) and is refused while a merge runs", async () => {
  const f = await realFeature();
  const server = createServer({ store, bus: (board as any).bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const url = `http://127.0.0.1:${server.port}/api/profiles/p/tickets/${f.main.id}`;
    // A merge into the main ticket's copy is running.
    let release!: () => void;
    (board as any).mergeLocks.set(`p/${f.main.id}`, new Promise<void>((r) => (release = r)));
    expect(board.merging("p", f.main.id)).toBe(true);
    const refused = await fetch(url, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error).toContain("Wait a moment: a merge is running");
    expect(store.getTicket("p", f.main.id)).toBeTruthy();
    release();
    (board as any).mergeLocks.clear();
    const ok = await fetch(url, { method: "DELETE" });
    expect(ok.status).toBe(204);
    for (const t of [f.main, f.running, f.queued, f.waiting, f.live]) expect(store.getTicket("p", t.id)).toBeNull();
    expect(store.getTicket("p", f.added.id)?.partOf).toBeNull();
    expect(store.getTicket("p", f.old.id)).toBeTruthy();
  } finally {
    board.stopAll();
    server.stop(true);
  }
});

test("notify_user is refused for tool tickets with the plain reason; a with-you tool ticket may notify and ask", async () => {
  const f = await realFeature();
  const server = createServer({ store, bus: (board as any).bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const ctx = (id: string): ToolContext => ({ client: new BoardClient(server.port!), cwd: store.getProfile("p")!.path, env: { CKANBAN_TICKET: `p/${id}` } });
    const no = await callTool("notify_user", { profile: "p", message: "Pick A or B" }, ctx(f.running.id));
    expect(no.isError).toBe(true);
    expect(no.content[0].text).toContain(TOOL_NO_NOTIFY);
    expect(TOOL_NO_NOTIFY).toBe("Tool tickets report to their main ticket; end your run with your question instead.");
    // The endpoint itself refuses too (whatever calls it).
    const direct = await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/tickets/${f.running.id}/notify`, {
      method: "POST", headers: { "content-type": "application/json", "x-ckanban-run": `p/${f.running.id}` }, body: JSON.stringify({ message: "hi" }),
    });
    expect(direct.status).toBe(403);
    expect(((await direct.json()) as any).error).toBe(TOOL_NO_NOTIFY);
    const yes = await callTool("notify_user", { profile: "p", message: "Pick up the call" }, ctx(f.live.id));
    expect(yes.content[0].text).not.toContain(TOOL_NO_NOTIFY);
    const q = await callTool("ask_questions", { questions: [{ question: "Ready?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] }, ctx(f.live.id));
    expect(q.isError).toBeUndefined();
    const q2 = await callTool("ask_questions", { questions: [{ question: "Ready?", options: [{ label: "Yes", recommended: true }, { label: "No" }] }] }, ctx(f.queued.id));
    expect(q2.isError).toBe(true);
    // The main card's view: family summary; a with-you ticket names its feature.
    const list = (await (await fetch(`http://127.0.0.1:${server.port}/api/profiles/p/tickets`)).json()) as any[];
    const main = list.find((t) => t.id === f.main.id);
    expect(main.familyCard.tools).toBe(4);
    expect(list.find((t) => t.id === f.live.id).mainTicket).toEqual({ id: f.main.id, title: "AI Outreach" });
  } finally {
    board.stopAll();
    server.stop(true);
  }
});

test("list_tickets and the CLI skip tool tickets unless asked; recall and the linker skip them too", async () => {
  const f = await realFeature();
  const server = createServer({ store, bus: (board as any).bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const ctx: ToolContext = { client: new BoardClient(server.port!), cwd: store.getProfile("p")!.path, env: {} };
    const plain = (await callTool("list_tickets", { profile: "p" }, ctx)).content[0].text;
    expect(plain).toContain(f.main.id);
    expect(plain).not.toContain(f.live.id);
    expect(plain).not.toContain(f.running.id);
    const all = (await callTool("list_tickets", { profile: "p", includeTool: true }, ctx)).content[0].text;
    expect(all).toContain(f.running.id);
    const cli = async (...argv: string[]) => {
      const lines: string[] = [];
      await ticketCommand(argv, { out: (s) => lines.push(s), client: new BoardClient(server.port!), cwd: store.getProfile("p")!.path, env: {} });
      return lines.join("\n");
    };
    expect(await cli("list", "--profile", "p")).not.toContain(f.running.id);
    expect(await cli("list", "--profile", "p", "--include-tool")).toContain(f.running.id);
  } finally {
    board.stopAll();
    server.stop(true);
  }
  // Recall: a tool ticket on the same topic isn't recalled.
  const row = (t: Partial<Ticket> & { id: string; title: string }) => ({ ticket: { body: "", status: "done", parentId: null, lastRunAt: null, updatedAt: at(0), runCount: 1, ...t } as any, summary: null });
  const got = pickRelated({ id: "me", title: "WhatsApp outreach queue", body: "send outreach queue", parentId: null, madeFrom: null },
    [row({ id: "tool", title: "WhatsApp outreach queue build", tool: true, kind: "build" }), row({ id: "plain", title: "WhatsApp outreach queue retry" })]);
  expect(got.map((r) => r.ticket.id)).toEqual(["plain"]);
  // The linker never offers a tool ticket as a parent.
  let prompt = "";
  const linker = new Linker(store, board, async (i) => {
    prompt = i.prompt;
    return { ok: true, text: "{}", costUsd: 0 } as any;
  });
  const lone = await board.createTicket("p", { title: "Outreach follow-ups", body: "", status: "backlog", mode: "auto" });
  await linker.suggest("p", lone.id);
  expect(prompt).toContain(f.main.id);
  expect(prompt).not.toContain(f.running.id);
});

test("a with-you step waiting for the user doesn't wake its main ticket or make the plan stuck", async () => {
  const { planStep } = await import("../src/server/plan");
  const w = tk("W", { parentId: "M", tool: true, kind: "with_you", status: "review", outcome: "needs_input", runCount: 1 });
  const done = tk("D", { parentId: "M", tool: true, kind: "build", status: "done", outcome: "done", runCount: 1 });
  const plan = { state: "running", wakeups: 0, startedAt: at(0), originalCount: 0, inbox: [], seen: { D: "1:done:" }, retries: {}, awaiting: null } as any;
  const step = planStep(plan, [done, w], () => false, { managed: { summary: () => "", report: () => null } });
  expect(step.events).toEqual([]);
  expect(step.deadEnd).toBeNull();
  expect(step.active).toBe(1);
  // Once it finishes, its result reaches the main ticket as usual.
  const finished = planStep(plan, [done, { ...w, outcome: "done", status: "done", runCount: 2 }], () => false, { managed: { summary: () => "ok", report: () => null } });
  expect(finished.events.map((e) => e.childId)).toEqual(["W"]);
});

test("a working group started last speaks with its summary", () => {
  const f = feature();
  const round = { ...f.round, updatedAt: at(59) };
  const all = f.all.map((t) => (t.id === "R" ? round : t));
  expect(familyCard(f.main, all.filter((t) => t.id !== "M"), all, (id) => id === "T5", 0).line?.text).toBe("Testing round 2: 4 of 6 passed");
});

test("a failed step says why on the main card", () => {
  const t = tk("F", { title: "welcome email sends", kind: "test", tool: true, status: "review", outcome: "failed", error: "Run failed\nSMTP login refused" });
  expect(stepWait(t, false)!.label).toBe("Test: welcome email sends failed: SMTP login refused");
});

test("Where we are lists a with-you step waiting on the user in its board-written waiting line", () => {
  const f = feature();
  const live = tk("W2", { title: "Staging check", parentId: "M", tool: true, kind: "with_you", status: "review", outcome: "needs_input", runEndedAt: at(30) });
  const all = [...f.all, live];
  const facts = statusFacts(all, "M", (t) => youWaiting(t, false));
  expect(facts.needsYou.map((w) => w.title)).toEqual(["Staging check"]);
  const waiting = statusSections(null, facts).find((s) => s.key === "waiting");
  expect(waiting?.text).toBe("[1: Staging check]");
});
