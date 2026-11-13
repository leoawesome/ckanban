// Issue #29: cards gathered into a feature (gather_tickets) can leave the board like the feature's tasks
// (showOnBoard false, or gather_tickets with hide), keeping their chats, results and run history and staying in the
// feature's Tasks list. Main tickets, sub-features and groups keep their card. MCP, CLI and API agree.
import { expect, test } from "bun:test";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { createServer } from "../src/server/http";
import { ticketCommand } from "../src/ticket-cli";
import { featureRows, onBoard } from "../web/src/family";
import { board, setup, store, useBoardEnv } from "./board-env";
import { tempDir } from "./helpers";

useBoardEnv();

const mk = (title: string, extra: Parameters<typeof board.createTicket>[1] extends infer I ? Partial<I> : never = {}) =>
  board.createTicket("p", { title, body: "", status: "backlog", mode: "auto", ...extra });
const get = (id: string) => store.getTicket("p", id)!;
const tasksOf = (id: string) => featureRows(store.listTickets("p"), id).slice(1).map((r) => r.ticket.id);

/** A schedule's old run card in Done, with a result and run history. */
async function oldRun(title: string) {
  const t = await mk(title, { status: "done" });
  store.updateTicket("p", t.id, { runCount: 3, sessionId: `s-${t.id}` });
  store.addComment("p", t.id, "ai", `Result of ${title}`);
  return get(t.id);
}

test("a gathered card can be hidden from the board and stays in its feature's tasks with its history", async () => {
  await setup();
  const feature = await mk("Rednote scheduled runs", { main: true, status: "review" });
  const run = await oldRun("Rednote run 2026-10-25 12:30");
  expect(onBoard(get(run.id))).toBe(true);

  await board.gather("p", feature.id, [{ id: run.id }]);
  expect(get(run.id).partOf).toBe(feature.id);
  expect(onBoard(get(run.id))).toBe(true);

  board.setShowOnBoard("p", run.id, false);
  const hidden = get(run.id);
  expect(hidden.showOnBoard).toBe(false);
  expect(onBoard(hidden)).toBe(false);
  // Still the feature's: in its Tasks list, with its chat, result and run history.
  expect(tasksOf(feature.id)).toEqual([run.id]);
  expect([hidden.tool ?? false, hidden.main ?? false, hidden.runCount, hidden.sessionId, hidden.status]).toEqual([false, false, 3, `s-${run.id}`, "done"]);
  expect(store.listComments("p", run.id).map((c) => c.text)).toContain("Result of Rednote run 2026-10-25 12:30");

  // It comes back while it works or waits for the user, and when shown again.
  expect(onBoard({ ...hidden, status: "review" })).toBe(true);
  expect(onBoard({ ...hidden, status: "in_progress" })).toBe(true);
  expect(onBoard({ ...hidden, running: true } as any)).toBe(true);
  board.setShowOnBoard("p", run.id, true);
  expect(get(run.id).showOnBoard ?? null).toBeNull();
  expect(onBoard(get(run.id))).toBe(true);

  // Unlinked from the feature, a hidden card shows again (it has no feature to live in).
  board.setShowOnBoard("p", run.id, false);
  await board.setPartOf("p", run.id, null);
  expect(onBoard(get(run.id))).toBe(true);
});

test("main tickets, sub-features, groups and cards outside a feature keep their card", async () => {
  await setup();
  const feature = await mk("Feature", { main: true });
  const sub = await mk("Sub-feature", { main: true, partOf: feature.id });
  const group = await mk("Group", { kind: "group", partOf: feature.id });
  const loose = await mk("Loose card");
  expect(() => board.setShowOnBoard("p", feature.id, false)).toThrow(`"Feature" is a main ticket: it keeps its own card on the board`);
  expect(() => board.setShowOnBoard("p", sub.id, false)).toThrow(`"Sub-feature" is a main ticket (a sub-feature): it keeps its own card on the board`);
  expect(() => board.setShowOnBoard("p", group.id, false)).toThrow(`"Group" is a group of its feature: it keeps its own card on the board`);
  expect(() => board.setShowOnBoard("p", loose.id, false)).toThrow(`"Loose card" isn't part of a feature: only a task or a card gathered into a feature can be hidden from the board`);
  for (const id of [feature.id, sub.id, group.id, loose.id]) expect(get(id).showOnBoard ?? null).toBeNull();
  // A task still works as before.
  const task = await mk("Task", { parentId: feature.id, tool: true, kind: "build" });
  board.setShowOnBoard("p", task.id, true);
  expect(onBoard(get(task.id))).toBe(true);
  board.setShowOnBoard("p", task.id, false);
  expect(onBoard(get(task.id))).toBe(false);
});

test("gather with hide takes gathered cards off the board, also ones gathered before; a main ticket keeps its card", async () => {
  await setup();
  const feature = await mk("Rednote scheduled runs", { main: true });
  const before = await oldRun("Rednote run 1");
  await board.gather("p", feature.id, [{ id: before.id }]);
  const fresh = await oldRun("Rednote run 2");
  const other = await mk("Other feature", { main: true });
  const r = await board.gather("p", feature.id, [{ id: before.id }, { id: fresh.id }, { id: other.id }], null, null, { hide: true });
  expect(r.gathered.map((t) => t.id)).toEqual([before.id, fresh.id, other.id]);
  expect(r.kept).toEqual([{ id: other.id, reason: `"Other feature" is a main ticket (a sub-feature): it keeps its own card on the board` }]);
  expect([onBoard(get(before.id)), onBoard(get(fresh.id)), onBoard(get(other.id))]).toEqual([false, false, true]);
  expect(tasksOf(feature.id).sort()).toEqual([before.id, fresh.id, other.id].sort());
  expect(store.listComments("p", fresh.id).map((c) => c.text)).toContain("Result of Rednote run 2");
});

test("update_ticket, gather_tickets, the CLI and the API agree on hiding a gathered card", async () => {
  await setup();
  const feature = await mk("Feature", { main: true });
  const a = await oldRun("Run A");
  const b = await oldRun("Run B");
  const c = await oldRun("Run C");
  const server = createServer({ store, bus: (board as any).bus, board, port: 0, webDir: tempDir("ck-web-") });
  try {
    const client = new BoardClient(server.port!);
    const ctx: ToolContext = { client, cwd: store.getProfile("p")!.path, env: {} };
    // MCP gather_tickets with hide.
    const text = (await callTool("gather_tickets", { profile: "p", id: feature.id, tickets: [{ id: a.id }, { id: b.id }, { id: c.id }, { id: feature.id }], hide: true }, ctx)).content[0].text;
    expect(text).toContain("Gathered 3");
    expect([a, b, c].map((t) => onBoard(get(t.id)))).toEqual([false, false, false]);
    // MCP update_ticket shows one again, and hides it.
    await callTool("update_ticket", { profile: "p", id: a.id, showOnBoard: true }, ctx);
    expect(onBoard(get(a.id))).toBe(true);
    await callTool("update_ticket", { profile: "p", id: a.id, showOnBoard: false }, ctx);
    expect(onBoard(get(a.id))).toBe(false);
    // A main ticket is refused with the reason.
    const refused = await callTool("update_ticket", { profile: "p", id: feature.id, showOnBoard: false }, ctx);
    expect(JSON.stringify(refused)).toContain("keeps its own card on the board");
    // CLI.
    const cli = (...argv: string[]) => ticketCommand(argv, { out: () => {}, client, cwd: ctx.cwd, env: {} });
    await cli("update", b.id, "--profile", "p", "--show-on-board", "true");
    expect(onBoard(get(b.id))).toBe(true);
    await cli("update", b.id, "--profile", "p", "--show-on-board", "false");
    expect(onBoard(get(b.id))).toBe(false);
    await expect(cli("update", b.id, "--profile", "p", "--show-on-board", "maybe")).rejects.toThrow("--show-on-board must be true or false");
    // API: PATCH (the board's Show on board checkbox) and the family list.
    const base = `http://127.0.0.1:${server.port}/api/profiles/p/tickets`;
    const res = await fetch(`${base}/${c.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ showOnBoard: true }) });
    expect(res.status).toBe(200);
    expect(onBoard(get(c.id))).toBe(true);
    const fam = (await (await fetch(`${base}/${feature.id}/family`)).json()) as any[];
    expect(fam.find((r) => r.id === a.id)?.showOnBoard).toBe(false);
    expect(fam.find((r) => r.id === c.id)?.showOnBoard).toBeUndefined();
  } finally {
    board.stopAll();
    server.stop(true);
  }
});
