// Main tickets and tool tickets (main-ticket.ts): roles, results and result cards, ask_ticket, questions, the engine in
// every column, restarts, slots, merging into the main ticket's copy, milestones, kind defaults, the collapsed wake,
// no spend hold, and the no-progress rule. Runs use the fake claude (test/fixtures/fake-claude.ts).
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { folderDiff } from "../src/server/diff";
import { run as git } from "../src/server/git";
import { createServer } from "../src/server/http";
import { KIND_DEFAULTS, progressStep, wakeTable } from "../src/server/main-ticket";
import { isComplete, planStep } from "../src/server/plan";
import { mainWakePrompt } from "../src/server/prompts";
import type { Ticket } from "../src/server/types";
import { argsFile, board, bus, FAKE, readArgs, setBoard, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { tempDir, until } from "./helpers";

useBoardEnv();

/** A board with quick wakes (and a short ask_ticket wait) instead of the env's default. */
function quickBoard(extra: Partial<ConstructorParameters<typeof Board>[2]> = {}): Board {
  return setBoard(new Board(store, bus, { claudeBin: FAKE, isSessionLive: async () => false, planWakeDelayMs: 30, askTimeoutMs: 15_000, ...extra }));
}

const get = (id: string) => store.getTicket("p", id)!;
const mkMain = (title = "Outreach", status: Ticket["status"] = "planning") => board.createTicket("p", { title, body: "Goal: send messages.", status: "backlog", mode: "auto", main: true })
  .then((t) => (status === "backlog" ? t : store.updateTicket("p", t.id, { status, refineStarted: true })));
const mkTool = (parent: string, title: string, kind: Ticket["kind"] = "explore", extra: Partial<Parameters<typeof board.createTicket>[1]> = {}) =>
  board.createTicket("p", { title, body: "## Objective\nLook.", status: "backlog", mode: "auto", parentId: parent, tool: true, kind, ...extra });
const promptsOf = (cwdPart: string | null, text: string) => readArgs().filter((a) => a.prompt?.includes(text) && (!cwdPart || a.cwd.includes(cwdPart)));
const disallowed = (a: { args: string[] }) => a.args[a.args.indexOf("--disallowedTools") + 1].split(",");
const runKinds = (id: string) => store.readActivity("p", id).map((a: any) => a.event).filter((e: any) => e?.type === "ckanban_run").map((e: any) => e.kind);

test("a main ticket's runs can't edit files and get its rules in the system prompt; a normal ticket's can", async () => {
  await setup();
  quickBoard();
  const main = await mkMain("Main", "review");
  const plain = await board.createTicket("p", { title: "Plain", body: "", status: "review", mode: "auto" });
  await board.chat("p", main.id, "what is left?");
  await board.chat("p", plain.id, "fix it");
  await untilSpawned(2);
  await board.whenIdle();
  const [m, n] = [readArgs().find((a) => a.prompt.includes("what is left?"))!, readArgs().find((a) => a.prompt.includes("fix it"))!];
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
    expect(disallowed(m)).toContain(tool);
    expect(disallowed(n)).not.toContain(tool);
  }
  expect(m.args[m.args.indexOf("--append-system-prompt") + 1]).toContain("This ticket is a main ticket");
  expect(m.prompt).toContain("Act on the message through tool tickets");
  expect(m.prompt).not.toContain("as you would in an interactive session");
  // A reply leaves the main card where the user put it.
  expect(get(main.id).status).toBe("review");
}, 60_000);

test("Main ticket model: the board setting picks main tickets' model; their own /model still wins", async () => {
  const p = await setup();
  store.saveProfile({ ...p, model: "opus", mainModel: "sonnet" });
  quickBoard();
  const main = await mkMain("Main", "review");
  await board.chat("p", main.id, "one");
  await untilSpawned(1);
  await board.whenIdle();
  const a = readArgs()[0].args;
  expect(a[a.indexOf("--model") + 1]).toBe("sonnet");
  store.updateTicket("p", main.id, { model: "haiku" });
  await board.chat("p", main.id, "two");
  await untilSpawned(2);
  await board.whenIdle();
  const b = readArgs()[1].args;
  expect(b[b.indexOf("--model") + 1]).toBe("haiku");
}, 60_000);

test("a tool ticket ending done without a PR wakes its main ticket (in Planning) with its summary and report; a result card shows; the card stays put", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  process.env.FAKE_OUTPUT = "## Changed and why\nNothing.\n## Tried\n-\n## Decided against\n-\n## Files\n-";
  try {
    const main = await mkMain("Main", "planning");
    const tool = await mkTool(main.id, "Explore the inbox");
    board.ensurePlan("p", main.id);
    board.advancePlans("p");
    await until(() => promptsOf(null, "finished: ").length > 0, 30000);
    const wake = promptsOf(null, "finished: ")[0].prompt;
    const report = join(store.outputsPath("p", tool.id), "report.md");
    expect(wake).toContain(`finished: ${tool.id} "Explore the inbox"; outcome done; summary: fake done; report: ${report}`);
    // The tool ticket's own first prompt had the board's header.
    const first = readArgs().find((a) => a.prompt.includes("# Your place in the feature"))!.prompt;
    expect(first).toContain("Report to your parent, the main ticket, never the user");
    expect(first).toContain("report.md");
    await board.whenIdle();
    await until(() => !board.isRunning("p", main.id));
    const m = get(main.id);
    expect(m.status).toBe("planning");
    expect(m.results?.length).toBe(1);
    expect(m.results![0]).toMatchObject({ ticketId: tool.id, outcome: "done", summary: "fake done", report });
    // The wake ran without moving the card, as a chat run of its own.
    expect(runKinds(main.id)).toContain("chat");
  } finally {
    delete process.env.FAKE_OUTPUT;
  }
}, 60_000);

test("without a report the event says so and the card has none", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  const main = await mkMain("Main", "review");
  const tool = await mkTool(main.id, "Look around");
  board.ensurePlan("p", main.id);
  board.advancePlans("p");
  await until(() => promptsOf(null, "finished: ").length > 0, 30000);
  expect(promptsOf(null, "finished: ")[0].prompt).toContain("report: no report");
  await until(() => (get(main.id).results?.length ?? 0) > 0);
  expect(get(main.id).results![0].report).toBeNull();
  expect(get(main.id).status).toBe("review");
  expect(tool.mode).toBe("auto");
}, 60_000);

test("a group whose children still run is not complete; its children's events stay with it", () => {
  const at = new Date().toISOString();
  const base = { body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null, lastActivity: null, lastRunAt: null, runCount: 1, error: null, createdAt: at, updatedAt: at };
  const group = { ...base, id: "g", title: "Round", status: "review", outcome: "done", tool: true, kind: "round", parentId: "m",
    plan: { state: "running", maxConcurrent: 2, wakeups: 1, startedAt: at, originalCount: 2 } } as Ticket;
  expect(isComplete(group)).toBe(false);
  expect(isComplete({ ...group, plan: { ...group.plan!, state: "done" } })).toBe(true);
  const step = planStep({ state: "running", maxConcurrent: 2, wakeups: 0, startedAt: at, originalCount: 1, seen: {} }, [group], () => false,
    { managed: { summary: () => "s", report: () => null } });
  expect(step.events).toEqual([]);
  expect(step.active).toBe(1);
  expect(step.allComplete).toBe(false);
}, 60_000);

test("a family's build and fix tickets aren't limited either: every step without waiting dependencies starts", () => {
  const at = new Date().toISOString();
  const kid = (id: string, kind: Ticket["kind"]) => ({ id, title: id, status: "backlog", outcome: null, kind, tool: true, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: at, updatedAt: at }) as Ticket;
  const kids = [kid("b1", "build"), kid("b2", "build"), kid("f1", "fix"), kid("e1", "explore"), kid("e2", "explore"), kid("t1", "test")];
  const step = planStep({ state: "running", maxConcurrent: 1, wakeups: 0, startedAt: at, originalCount: 6, seen: {} }, kids, () => false,
    { managed: { summary: () => "", report: () => null } });
  expect(step.start).toEqual(["b1", "b2", "f1", "e1", "e2", "t1"]);
}, 60_000);

test("ask_ticket: a fork of the tool ticket's session answers as an event; no answer after the timeout", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  const main = await mkMain("Main", "review");
  const tool = await mkTool(main.id, "Build the queue");
  board.ensurePlan("p", main.id);
  board.advancePlans("p");
  await until(() => promptsOf(null, "finished: ").length > 0, 30000);
  await board.whenIdle();
  await until(() => !board.isRunning("p", main.id) && !(board as any).wakeDue.size);
  const before = readArgs().length;
  const msg = board.askTicket("p", main.id, tool.id, "Why 20 at a time?");
  expect(msg).toContain("comes back as an event");
  // The fork runs read-only, in a session of its own, without a slot.
  await until(() => readArgs().length > before);
  const fork = readArgs()[before];
  expect(fork.prompt).toContain("Question: Why 20 at a time?");
  expect(disallowed(fork)).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit", "Bash"]));
  expect(fork.args[fork.args.indexOf("--resume") + 1]).not.toBe(get(tool.id).sessionId);
  await until(() => promptsOf(null, `answer from ${tool.id} "Build the queue" to "Why 20 at a time?": Work complete.`).length > 0, 30000);
  await board.whenIdle();
  await until(() => !board.isRunning("p", main.id) && !(board as any).wakeDue.size);

  process.env.FAKE_MODE = "slow";
  (board as any).opts.askTimeoutMs = 400;
  board.askTicket("p", main.id, tool.id, "Still there?");
  await until(() => promptsOf(null, `no answer from ${tool.id} "Build the queue" to "Still there?"`).length > 0, 30000);
}, 60_000);

test("a tool ticket's question reaches its parent, it waits, and chat_ticket from the parent resumes it", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  const main = await mkMain("Main", "review");
  const tool = await mkTool(main.id, "Pick a sender");
  process.env.FAKE_MODE = "questions";
  board.ensurePlan("p", main.id);
  board.advancePlans("p");
  await until(() => readArgs().length >= 1);
  process.env.FAKE_MODE = "ok";
  await until(() => promptsOf(null, "outcome questions").length > 0, 30000);
  expect(promptsOf(null, "outcome questions")[0].prompt).toContain(`"Pick a sender"`);
  expect(get(tool.id).outcome).toBe("needs_input");
  await board.whenIdle();
  // It waits: the plan doesn't start it again, and it doesn't wait on the user.
  expect(get(tool.id).status).toBe("review");
  const runs = get(tool.id).runCount;
  await board.chat("p", tool.id, "Use WhatsApp.", { fromPlanner: true, from: { ticketId: main.id, title: "Main" } });
  await until(() => get(tool.id).runCount > runs && !board.isRunning("p", tool.id), 30000);
  expect(get(tool.id).outcome).toBe("done");
  expect(readArgs().some((a) => a.prompt.startsWith("Use WhatsApp.") && a.prompt.includes("message for tool ticket"))).toBe(true);
}, 60_000);

test("a with-you step that ends asking puts a grey note in the main chat without waking it; the user's answer goes straight to the step", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  const main = await mkMain("Main", "review");
  const step = await mkTool(main.id, "Staging check", "with_you");
  process.env.FAKE_MODE = "questions";
  board.ensurePlan("p", main.id);
  board.advancePlans("p");
  await until(() => get(step.id).outcome === "needs_input" && !board.isRunning("p", step.id), 30000);
  process.env.FAKE_MODE = "ok";
  await board.whenIdle();
  board.advancePlans("p");
  await Bun.sleep(100);
  // A grey note in the main chat, first line of what it asks.
  expect(get(main.id).boardNotes).toEqual([{ at: expect.any(String), ticketId: step.id, text: "Staging check needs you: Work complete." }]);
  // The main ticket isn't woken for it: no run, no event waiting.
  expect(get(main.id).runCount).toBe(0);
  expect(promptsOf(null, "outcome questions")).toEqual([]);
  expect(get(main.id).plan?.inbox ?? []).toEqual([]);
  expect(board.waitsOnUser("p", step.id)).toBe(true);
  expect(board.familyCard("p", main.id)?.needsYou.map((w) => w.id)).toEqual([step.id]);
}, 60_000);

test("recover() wakes a main ticket from its saved events instead of starting a work run", async () => {
  await setup();
  const main = await mkMain("Main", "in_progress");
  store.updateTicket("p", main.id, { plan: { state: "running", maxConcurrent: 2, wakeups: 1, startedAt: new Date().toISOString(), originalCount: 0, inbox: ["finished: t_x \"X\"; outcome done; summary: ok; report: no report"], seen: {} } });
  quickBoard();
  board.recover();
  await until(() => promptsOf(null, "The board restarted while your last run was going").length > 0, 30000);
  const wake = promptsOf(null, "The board restarted")[0].prompt;
  expect(wake).toContain("finished: t_x");
  await board.whenIdle();
  expect(runKinds(main.id)).not.toContain("work");
  expect(get(main.id).status).toBe("review");
}, 60_000);

test("a main ticket's reply starts while every run slot is busy; a normal ticket's waits", async () => {
  await setup({ maxParallel: 1 });
  quickBoard();
  const busy = await board.createTicket("p", { title: "Busy", body: "", status: "backlog", mode: "auto" });
  process.env.FAKE_MODE = "slow";
  await board.updateTicket("p", busy.id, { status: "ready" });
  await until(() => board.isRunning("p", busy.id));
  const main = await mkMain("Main", "review");
  const other = await board.createTicket("p", { title: "Other", body: "", status: "review", mode: "auto" });
  await board.chat("p", main.id, "status?");
  await board.chat("p", other.id, "go");
  expect(board.isRunning("p", main.id)).toBe(true);
  expect(board.holdsSlot("p", main.id)).toBe(false);
  expect(get(main.id).slotWait ?? null).toBeNull();
  expect(board.isRunning("p", other.id)).toBe(false);
  expect(get(other.id).slotWait).toBeTruthy();
}, 60_000);

test("a pending restart still holds a main ticket's reply", async () => {
  await setup();
  quickBoard();
  const main = await mkMain("Main", "review");
  board.requestRestart(() => {}, 60_000);
  await board.chat("p", main.id, "later please");
  expect(board.isRunning("p", main.id)).toBe(false);
  expect(get(main.id).queued?.[0]?.text).toBe("later please");
}, 60_000);

/** A git board with a main ticket that has its own copy, and tool tickets starting from it. */
async function gitFamily() {
  const p = await setup({ maxParallel: 3 });
  const main = await mkMain("Main", "review");
  await board.ensureSession("p", main.id);
  const branch = get(main.id).branch!;
  const tool = async (title: string) => {
    const t = await mkTool(main.id, title, "build", { startFrom: branch });
    await board.ensureSession("p", t.id);
    return get(t.id);
  };
  const commit = async (t: Ticket, file: string) => {
    writeFileSync(join(t.worktree!, file), `${file}\n`);
    await git(["git", "add", "."], t.worktree!);
    await git(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file], t.worktree!);
  };
  return { p, main: get(main.id), tool, commit };
}

test("merge_into_main fast-forwards the main copy, one at a time; fails cleanly when the main copy moved; ends blocked after 3 tries", async () => {
  quickBoard();
  const { p, main, tool, commit } = await gitFamily();
  const a = await tool("A");
  const b = await tool("B");
  await commit(a, "a.txt");
  await commit(b, "b.txt");
  // Two merges at once: they run one after the other, so the second sees the main copy moved.
  let live = 0;
  let peak = 0;
  const real = (board as any).mergeNow.bind(board);
  (board as any).mergeNow = async (...xs: any[]) => {
    peak = Math.max(peak, ++live);
    try {
      return await real(...xs);
    } finally {
      live--;
    }
  };
  const [ra, rb] = await Promise.allSettled([board.mergeIntoMain("p", a.id), board.mergeIntoMain("p", b.id)]);
  expect(peak).toBe(1);
  expect(ra.status).toBe("fulfilled");
  expect((ra as PromiseFulfilledResult<string>).value).toContain("Merged 1 commit");
  expect(existsSync(join(main.worktree!, "a.txt"))).toBe(true);
  expect(rb.status).toBe("rejected");
  expect(String((rb as PromiseRejectedResult).reason.message)).toContain("merge again and retry");
  expect(get(b.id).mergeFails).toBe(1);
  await expect(board.mergeIntoMain("p", b.id)).rejects.toThrow("try 2 of 3");
  await expect(board.mergeIntoMain("p", b.id)).rejects.toThrow('end your run with status "blocked"');
  expect(get(main.id).plan?.inbox?.some((l) => l.includes(`merge failed: ${b.id}`)) || promptsOf(null, `merge failed: ${b.id}`).length > 0).toBe(true);
  // Merging the main copy in first makes it a fast-forward again.
  await git(["git", "merge", "--no-edit", main.branch!], b.worktree!);
  expect(await board.mergeIntoMain("p", b.id)).toContain("Merged");
  expect(get(b.id).mergeFails).toBe(0);
  expect(existsSync(join(main.worktree!, "b.txt"))).toBe(true);
  expect(p.path).toBeTruthy();
}, 60_000);

test("land_milestone merges the main copy into the project folder once (no remote) and records it in the status", async () => {
  quickBoard();
  const { p, main, tool, commit } = await gitFamily();
  const a = await tool("A");
  await commit(a, "feature.txt");
  await board.mergeIntoMain("p", a.id);
  const msg = await board.landMilestone("p", main.id, "Send queue works");
  expect(msg).toContain("merged your copy into main");
  // Its Changes tab still shows the family's work after it landed in the base branch.
  expect(main.startSha).toBeTruthy();
  const diff = await folderDiff(main.worktree!, main.startSha!);
  expect(diff.files.map((f) => f.path)).toEqual(["feature.txt"]);
  expect(existsSync(join(p.path, "feature.txt"))).toBe(true);
  const status = JSON.parse(readFileSync(join(store.outputsPath("p", main.id), "status.json"), "utf8"));
  expect(status.milestones).toHaveLength(1);
  expect(status.milestones[0].summary).toBe("Send queue works");
  expect(readFileSync(join(store.outputsPath("p", main.id), "status.md"), "utf8")).toContain("Send queue works");
  // A clash with the project folder is refused, and the folder is left as it was.
  const b = await tool("B");
  writeFileSync(join(b.worktree!, "README.md"), "from the tool\n");
  await git(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "tool readme"], b.worktree!);
  await board.mergeIntoMain("p", b.id);
  writeFileSync(join(p.path, "README.md"), "from the user\n");
  await git(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "user readme"], p.path);
  await expect(board.landMilestone("p", main.id, "Clash")).rejects.toThrow("clashed");
  expect((await git(["git", "status", "--porcelain"], p.path)).stdout.trim()).toBe("");
  expect(readFileSync(join(p.path, "README.md"), "utf8")).toBe("from the user\n");
  // A dirty project folder is refused with the reason.
  writeFileSync(join(p.path, "README.md"), "changed\n");
  await expect(board.landMilestone("p", main.id, "Again")).rejects.toThrow("uncommitted changes");
}, 60_000);

test("land_milestone pushes the main copy and opens one pull request, then updates it", async () => {
  const opened: { branch: string; base: string; body: string }[] = [];
  quickBoard({ openPr: async (_dir, o) => (opened.push(o), "https://github.com/x/y/pull/42") });
  const { p, main, tool, commit } = await gitFamily();
  const remote = tempDir("ck-remote-");
  await git(["git", "init", "-q", "--bare", remote], remote);
  await git(["git", "remote", "add", "origin", remote], p.path);
  await git(["git", "push", "-q", "origin", "main"], p.path);
  const a = await tool("A");
  await commit(a, "one.txt");
  await board.mergeIntoMain("p", a.id);
  expect(await board.landMilestone("p", main.id, "First part")).toContain("opened a pull request: https://github.com/x/y/pull/42");
  expect(get(main.id).prUrl).toBe("https://github.com/x/y/pull/42");
  const b = await tool("B");
  await commit(b, "two.txt");
  await board.mergeIntoMain("p", b.id);
  expect(await board.landMilestone("p", main.id, "Second part")).toContain("updated the open pull request");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ branch: main.branch, base: "main", body: "First part" });
  const pushed = await git(["git", "log", "--oneline", main.branch!], remote);
  expect(pushed.stdout).toContain("two.txt");
}, 60_000);

test("on a plain folder tool tickets edit the folder one at a time and land_milestone only records the milestone", async () => {
  await setup({ git: false, maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  process.env.FAKE_STEP_MS = "60";
  try {
    const main = await mkMain("Main", "review");
    const a = await mkTool(main.id, "A", "build");
    const b = await mkTool(main.id, "B", "explore");
    let both = false;
    bus.on((ev) => {
      if (ev.type === "ticket.updated" && board.isRunning("p", a.id) && board.isRunning("p", b.id)) both = true;
    });
    board.ensurePlan("p", main.id);
    board.advancePlans("p");
    await until(() => (get(main.id).results?.length ?? 0) >= 2, 30000);
    expect(both).toBe(false);
    expect(get(main.id).results![0].folderFiles).toBe(1);
    expect(await board.landMilestone("p", main.id, "Done")).toContain("Recorded the milestone");
  } finally {
    delete process.env.FAKE_STEP_MS;
  }
}, 60_000);

test("create_ticket inside a main ticket makes tool tickets with the kind's model and effort, or the ones it passes", async () => {
  const p = await setup();
  quickBoard();
  const server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const base = `http://127.0.0.1:${server.port}/api/profiles/p/tickets`;
    // The user's own ticket on its own is a main ticket; one under another ticket isn't.
    const main = (await (await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Outreach" }) })).json()) as Ticket;
    expect(main.main).toBe(true);
    const under = (await (await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Part", partOf: main.id }) })).json()) as Ticket;
    expect(under.main).toBeUndefined();
    // Its runs manage its family (a run is going).
    const real = board.plannerRights.bind(board);
    board.plannerRights = (slug, id) => (id === main.id ? store.getTicket(slug, id)! : real(slug, id));
    const ctx: ToolContext = { client: new BoardClient(server.port!), cwd: p.path, env: { CKANBAN_TICKET: `p/${main.id}` } };
    const r1 = await callTool("create_ticket", { profile: "p", title: "Build the queue", kind: "build" }, ctx);
    expect(r1.content[0].text).toContain("Created tool ticket");
    const r2 = await callTool("create_ticket", { profile: "p", title: "Look at replies", kind: "explore", model: "haiku", effort: "high" }, ctx);
    expect(r2.isError).toBeUndefined();
    const r3 = await callTool("create_ticket", { profile: "p", title: "Round", kind: "round" }, ctx);
    expect(r3.isError).toBeUndefined();
    const kids = store.listTickets("p").filter((t) => t.parentId === main.id);
    const by = (title: string) => kids.find((k) => k.title === title || (title === "Round" && k.kind === "round"))!;
    expect(by("Build the queue")).toMatchObject({ tool: true, kind: "build", model: KIND_DEFAULTS.build.model, effort: "medium", mode: "auto" });
    expect(by("Look at replies")).toMatchObject({ tool: true, kind: "explore", model: "haiku", effort: "high" });
    expect(by("Round")).toMatchObject({ tool: true, kind: "round", model: "claude-sonnet-5-5", effort: "low" });
    expect(get(main.id).plan?.state).toBe("running");
    // ask_questions is refused for tool tickets.
    const toolCtx: ToolContext = { ...ctx, env: { CKANBAN_TICKET: `p/${by("Build the queue").id}` } };
    const q = await callTool("ask_questions", { questions: [{ question: "A or B?", options: [{ label: "A", recommended: true }, { label: "B" }] }] }, toolCtx);
    expect(q.isError).toBe(true);
    expect(q.content[0].text).toContain('End your run with status "questions"');
    // The user writing in a tool ticket: the main ticket gets the whole message as an event.
    board.plannerRights = real;
    await board.pausePlan("p", main.id);
    const tool = by("Look at replies");
    await fetch(`${base}/${tool.id}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Also check the spam folder, please." }) });
    expect(get(main.id).plan?.inbox?.some((l) => l === `the user wrote in tool ticket ${tool.id} "Look at replies": Also check the spam folder, please.`)).toBe(true);
  } finally {
    server.stop(true);
  }
}, 60_000);

test("the wake prompt lists only working, failed and waiting tool tickets, plus one row per group", () => {
  const at = new Date().toISOString();
  const tk = (id: string, x: Partial<Ticket>) => ({ id, title: id, status: "backlog", outcome: null, body: "", order: 0, sessionId: null, worktree: null, branch: null, prUrl: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt: at, updatedAt: at, tool: true, ...x }) as Ticket;
  const kids = [
    tk("done1", { status: "review", outcome: "done", kind: "build" }), tk("done2", { status: "done", outcome: "done" }),
    tk("busy", { status: "in_progress", kind: "build" }), tk("bad", { status: "review", outcome: "failed" }), tk("ask", { status: "review", outcome: "needs_input" }),
    tk("next", { dependsOn: ["busy"] }), tk("round", { kind: "round", title: "Testing round 1", status: "review", outcome: "done" }),
  ];
  const all = [...kids, ...[1, 2, 3, 4, 5, 6].map((n) => tk(`t${n}`, { parentId: "round", kind: "test", status: "review", outcome: "done" }))];
  const table = wakeTable(kids, all, () => false);
  expect(table).toContain('- busy "busy" (build): working');
  expect(table).toContain('- bad "bad": failed');
  expect(table).toContain('- ask "ask": asking a question');
  expect(table).toContain('- next "next": waiting for busy');
  expect(table).toContain("- round Testing round 1: 6 of 6 passed");
  expect(table).toContain("- 2 other tool tickets finished");
  expect(table).not.toContain("done1");
  const prompt = mainWakePrompt(kids[0], { kind: "event", events: ["finished: x"], table, board: "p" });
  // The fixed rules go through the system prompt, not every wake.
  expect(prompt).not.toContain("You never change the project's files");
  expect(prompt.length).toBeLessThan(3000);
}, 60_000);

test("spend never holds a main ticket's tool tickets, even with a check-in saved before it was removed", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  delete process.env.FAKE_PR;
  // Far past the old $25 / 30 tickets threshold.
  board.onCost(() => 100);
  const main = await mkMain("Main", "review");
  await mkTool(main.id, "One");
  await mkTool(main.id, "Two");
  board.ensurePlan("p", main.id);
  // An old plan whose check-in was waiting for Keep going (as saved before the check-in was removed).
  const old = { costBase: 0, ticketsBase: 0, roundsBase: 0, due: { at: new Date().toISOString(), line: "$83 so far" } };
  store.updateTicket("p", main.id, { plan: { ...get(main.id).plan!, checkin: old } as any });
  board.advancePlans("p");
  await until(() => store.listTickets("p").filter((t) => t.tool).every((t) => t.status !== "backlog"));
  expect(board.waitsOnUser("p", main.id)).toBe(false);
  expect(store.listComments("p", main.id).some((c) => c.text.startsWith("Check-in"))).toBe(false);
}, 60_000);

test("3 wakes in a row with no tool ticket changing mark the plan stuck", async () => {
  await setup({ maxParallel: 3 });
  quickBoard();
  expect(progressStep({}, "a")).toEqual({ progressSig: "a", noProgress: 0, stuck: false });
  expect(progressStep({ progressSig: "a", noProgress: 2 }, "a").stuck).toBe(true);
  expect(progressStep({ progressSig: "a", noProgress: 2 }, "b").noProgress).toBe(0);
  const main = await mkMain("Main", "review");
  const t = await mkTool(main.id, "Done one");
  store.updateTicket("p", t.id, { status: "review", outcome: "done", runCount: 1 });
  board.ensurePlan("p", main.id);
  const wakes = () => promptsOf(null, "Nudge ").length;
  for (let i = 1; i <= 4; i++) {
    board.pushEvent("p", main.id, `Nudge ${i}`);
    if (i < 4) {
      await until(() => wakes() >= i, 30000);
      await board.whenIdle();
      await until(() => !board.isRunning("p", main.id) && !(board as any).wakeDue.size);
    }
  }
  await until(() => get(main.id).plan?.state === "stuck", 30000);
  expect(get(main.id).plan!.reason).toContain("wakes in a row without any tool ticket changing");
  expect(wakes()).toBe(3);
  expect(board.waitsOnUser("p", main.id)).toBe(true);
  // The user's answer starts it again.
  await board.chat("p", main.id, "Try the other approach.");
  expect(get(main.id).plan!.state).toBe("running");
  expect(argsFile).toBeTruthy();
}, 60_000);
