// The ticket routes and Claude's board tools on a big board: they ask the board for a filtered page, never the whole
// board, and the board's cached views and Inbox answers never show stale data.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { countScope, LIST_PAGE, listScope, SEARCH_LIMIT } from "../src/server/ticketScope";
import { ticketCommand } from "../src/ticket-cli";
import { tempDir } from "./helpers";

const BIG = 10_000;
const OPEN = 500;
const fid = (i: number) => `t_20261001_${i.toString(36).padStart(4, "0")}`;

let store: Store;
let board: Board;
let server: ReturnType<typeof createServer>;
let base: string;
let ctx: ToolContext;
let feature: { main: string; steps: string[] };

beforeAll(async () => {
  store = new Store(tempDir("ck-scale-"));
  store.saveProfile({ name: "Big", slug: "big", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
  // One ticket through the Store, then copies of its file (much faster than BIG Store writes).
  const first = store.createTicket("big", { title: "Ticket 0", body: "", status: "done" });
  const template = readFileSync(join(store.root, "profiles", "big", "tickets", first.id, "ticket.md"), "utf8");
  for (let i = 0; i < BIG; i++) {
    const dir = join(store.root, "profiles", "big", "tickets", fid(i));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ticket.md"), template
      .replace(`id: ${first.id}`, `id: ${fid(i)}`)
      .replace("title: Ticket 0", `title: Ticket ${i}${i % 1000 === 7 ? " zebra" : ""}`)
      .replace("status: done", `status: ${i < BIG - OPEN ? "done" : "backlog"}`));
  }
  rmSync(join(store.root, "profiles", "big", "tickets", first.id), { recursive: true, force: true });
  const fresh = new Store(store.root);
  store = fresh;
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  server = createServer({ store, bus: (board as any).bus, board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}/api/profiles/big`;
  ctx = { client: new BoardClient(server.port!), cwd: "/elsewhere", env: {} };
  // An open feature: a main ticket with three tool tickets.
  const main = await board.createTicket("big", { title: "Feature main", body: "", status: "backlog", mode: "auto", main: true });
  const steps: string[] = [];
  for (const k of [1, 2, 3]) steps.push((await board.createTicket("big", { title: `Step ${k}`, body: "", status: "backlog", mode: "auto", parentId: main.id, tool: true, kind: "build" })).id);
  feature = { main: main.id, steps };
}, 120_000);

afterAll(() => {
  board?.stopAll();
  server?.stop(true);
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  expect(r.status).toBe(200);
  return r.json() as Promise<any>;
};

test("listScope on 10,000 tickets: open work by default, Done in pages, search capped, tool tickets on request", () => {
  const tickets = Array.from({ length: BIG }, (_, i) => ({ id: fid(i), title: `T ${i}`, body: i % 10 === 0 ? "find me" : "", status: i < BIG - OPEN ? "done" : "backlog", order: i, parentId: null, createdAt: "", tool: i % 100 === 1 }));
  const open = listScope(tickets);
  expect(open.tickets).toHaveLength(LIST_PAGE);
  expect(open.tickets.every((t) => t.status === "backlog" && !t.tool)).toBe(true);
  expect(open.total).toBe(OPEN - 5);
  expect(open.doneLeft).toBe(BIG - OPEN - 95);
  expect(open.tickets[0].id > open.tickets[1].id).toBe(true);
  const search = listScope(tickets, { q: "FIND me", status: "done", limit: 1000 });
  expect(search.tickets).toHaveLength(SEARCH_LIMIT);
  expect(search.next).toBeNull();
  expect(listScope(tickets, { tool: true, status: "done" }).total).toBe(BIG - OPEN);
  expect(countScope(tickets)).toMatchObject({ total: BIG, open: OPEN });
});

test("Done pages have no gaps or doubles while tickets change between pages", () => {
  type Row = { id: string; title: string; status: string; order: number; parentId: null; createdAt: string };
  let tickets: Row[] = Array.from({ length: 3000 }, (_, i) => ({ id: fid(i), title: `T ${i}`, status: "done", order: i, parentId: null, createdAt: "" }));
  const want = new Set(tickets.map((t) => t.id));
  const seen: string[] = [];
  let after: string | null = null;
  for (let round = 0; ; round++) {
    const page: { tickets: Row[]; next: string | null } = listScope(tickets, { status: "done", limit: 200, after });
    seen.push(...page.tickets.map((t) => t.id));
    if (!page.next) break;
    after = page.next;
    // Between pages: a new Done ticket, one taken out of Done, one deleted, one dragged to the top (new order).
    tickets = [{ id: `t_20261120_n${round}`, title: "new", status: "done", order: -round, parentId: null, createdAt: "" }, ...tickets];
    const moved = tickets.find((t) => t.id === fid(2900 - round * 10))!;
    tickets = tickets.map((t) => (t === moved ? { ...t, status: "backlog" } : t));
    want.delete(moved.id);
    const gone = fid(1000 + round);
    tickets = tickets.filter((t) => t.id !== gone);
    want.delete(gone);
    tickets = tickets.map((t) => (t.id === fid(5) ? { ...t, order: -1000 } : t));
  }
  expect(new Set(seen).size).toBe(seen.length);
  // Every ticket that stayed in Done the whole time was listed once (new ones started after the cursor: left out).
  for (const id of want) if (!/^t_20261120/.test(id)) expect(seen).toContain(id);
});

test("list_tickets asks for open work only, marks open features and says how many Done it left out", async () => {
  const text = (await callTool("list_tickets", { profile: "big" }, ctx)).content[0].text;
  const lines = text.split("\n");
  expect(lines[0]).toBe(`Board big, open work (not Done), newest first: 100 of ${OPEN + 1}.`);
  expect(text).toContain(`${feature.main}  [backlog]  Feature main  (open feature)`);
  expect(text).not.toContain(feature.steps[0]);
  expect(text).not.toContain("[done]");
  expect(lines.at(-2)).toMatch(/^More: call list_tickets again with the same arguments and after: "t_20261001_\w+"\.$/);
  expect(lines.at(-1)).toBe(`${BIG - OPEN} Done tickets not listed: list_tickets with status "done" pages through them, or query finds one.`);
  // The next page goes on where this one ended.
  const after = /after: "(\w+)"/.exec(lines.at(-2)!)![1];
  const next = (await callTool("list_tickets", { profile: "big", after, limit: 500 }, ctx)).content[0].text;
  expect(next.split("\n")[0]).toBe(`Board big, open work (not Done), newest first: ${OPEN + 1 - 100} of ${OPEN + 1} (after ${after}).`);
  expect(next).not.toContain("More:");
  // Done a page at a time; a query uses the board's search.
  const done = (await callTool("list_tickets", { profile: "big", status: "done", limit: 20 }, ctx)).content[0].text;
  expect(done.split("\n")[0]).toBe(`Board big, in done, newest first: 20 of ${BIG - OPEN}.`);
  const zebra = (await callTool("list_tickets", { profile: "big", status: "done", query: "zebra" }, ctx)).content[0].text;
  expect(zebra.split("\n").filter((l) => l.startsWith("t_"))).toHaveLength(BIG / 1000);
  // Without a column, a search looks in every column, Done included.
  const anywhere = (await callTool("list_tickets", { profile: "big", query: "zebra" }, ctx)).content[0].text;
  expect(anywhere.split("\n")[0]).toBe(`Board big, matching "zebra" in any column, newest first: ${BIG / 1000}.`);
  expect(anywhere).not.toContain("Done tickets not listed");
  const tools = (await callTool("list_tickets", { profile: "big", includeTool: true, query: "Step" }, ctx)).content[0].text;
  for (const id of feature.steps) expect(tools).toContain(id);
});

test("ticket list pages the same way", async () => {
  const lines: string[] = [];
  const cli = async (...argv: string[]) => {
    lines.length = 0;
    await ticketCommand(argv, { out: (s) => lines.push(s), client: new BoardClient(server.port!), cwd: "/elsewhere", env: {} });
    return lines.join("\n");
  };
  const out = await cli("list", "--profile", "big", "--limit", "10");
  expect(out.split("\n")[0]).toBe(`Board big, open work (not Done), newest first: 10 of ${OPEN + 1}.`);
  expect(out).toMatch(/More: ckanban ticket list --limit 10 --after t_\w+\./);
  expect(out).toContain(`${BIG - OPEN} Done tickets not listed: use --status done, or --query.`);
  const page = JSON.parse(await cli("list", "--profile", "big", "--status", "done", "--limit", "5", "--json"));
  expect(page.tickets).toHaveLength(5);
  expect(page.total).toBe(BIG - OPEN);
});

test("board settings get a count, not the board", async () => {
  expect(await get("/tickets?scope=count")).toEqual({ total: BIG + 4, open: OPEN + 4, doneTotal: BIG - OPEN });
});

test("comments come 50 at a time, newest first, with how many come earlier", async () => {
  const id = fid(BIG - 1);
  for (let n = 0; n < 120; n++) store.addComment("big", id, n % 2 ? "ai" : "user", `comment ${n}`);
  const last = await get(`/tickets/${id}/comments?last=50`);
  expect(last.comments.map((c: any) => c.text)).toEqual(Array.from({ length: 50 }, (_, k) => `comment ${70 + k}`));
  expect(last).toMatchObject({ earlier: 70, total: 120 });
  const back = await get(`/tickets/${id}/comments?last=50&before=20`);
  expect(back.comments.map((c: any) => c.text)).toEqual(Array.from({ length: 20 }, (_, k) => `comment ${k}`));
  expect(back.earlier).toBe(0);
  // Old clients still get every comment.
  expect(await get(`/tickets/${id}/comments`)).toHaveLength(120);
  const text = (await callTool("get_ticket", { profile: "big", id }, ctx)).content[0].text;
  expect(text).toContain("Comments (the last 50; 70 earlier not shown: call get_ticket with commentsBefore: 70):");
  expect(text).toContain("comment 119");
  expect(text).not.toContain("comment 69\n");
  const older = (await callTool("get_ticket", { profile: "big", id, commentsBefore: 70 }, ctx)).content[0].text;
  expect(older).toContain("20 earlier not shown: call get_ticket with commentsBefore: 20");
  expect(older).toContain("- ai (");
});

test("propose_delete checks only the ids it names", async () => {
  const ask = { ...ctx, env: { CKANBAN_TICKET: `big/${fid(0)}` } };
  const r = await callTool("propose_delete", { ids: [fid(1), "t_ghost"], reason: "old" }, ask);
  expect(r.content[0].text).toContain("shown as skipped: t_ghost");
});

test("a cached card never shows stale data: a ticket change, a run start and stop, a huddle change", async () => {
  const id = fid(BIG - 2);
  const card = async () => (await get("/tickets?scope=board")).tickets.find((t: any) => t.id === id);
  const inbox = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox`)).json() as any[]).find((x) => x.id === id);
  expect((await card()).running).toBe(false);
  expect(await inbox()).toBeUndefined();
  // The ticket changes.
  store.updateTicket("big", id, { title: "Renamed now", status: "review" });
  expect((await card()).title).toBe("Renamed now");
  // A run starts and stops.
  (board as any).runs.set(`big/${id}`, { slug: "big", id, stopRequested: false, promise: Promise.resolve() });
  expect((await card()).running).toBe(true);
  (board as any).runs.delete(`big/${id}`);
  expect((await card()).running).toBe(false);
  // Its huddle tags the user, then that is read.
  const asks = new Map<string, any>();
  board.onHostHuddles(() => asks);
  asks.set(id, { working: 0, queued: false, tagged: 1, learnings: 0, closeRequest: false, since: "2026-11-01T00:00:00.000Z", latest: "2026-11-01T00:00:00.000Z" });
  expect((await card()).attention?.kind).toBe("huddle");
  expect((await inbox())?.attention.kind).toBe("huddle");
  asks.delete(id);
  expect((await card()).attention?.kind).toBe("review");
  expect((await inbox())?.attention.kind).toBe("review");
  // A new Claude comment shows in its links (a result summary with a link).
  expect((await card()).links).toEqual([]);
  store.addComment("big", id, "ai", "Published https://claude.ai/artifact/abc-123");
  expect(JSON.stringify((await card()).links)).toContain("claude.ai/artifact/abc-123");
}, 60_000);
