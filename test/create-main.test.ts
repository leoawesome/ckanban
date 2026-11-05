import { afterAll, beforeAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

// create_ticket's main: true (and gather): a chat answering the user's typed message makes a new main ticket.
let server: ReturnType<typeof createServer>;
let store: Store;
let board: Board;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  server = createServer({ store, bus: new Bus(), board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const send = async (u: string, b: unknown, headers: Record<string, string> = {}) =>
  fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const profile = async (name: string) => (await (await send(`${base}/api/profiles`, { name, path: tempDir("ck-p-") })).json()) as any;
const errorOf = async (r: Response) => ((await r.json()) as any).error as string;

/** Pretend these runs are live: `asked` answer the user's typed message; every one may change its own board. */
const withRuns = async (asked: string[], live: string[], fn: () => Promise<void>) => {
  const realAsked = board.userAskedRun.bind(board);
  const realRunner = board.runnerRights.bind(board);
  const realPlanner = board.plannerRights.bind(board);
  board.userAskedRun = (_slug, id) => asked.includes(id);
  board.runnerRights = (slug, id) => (live.includes(id) ? store.getTicket(slug, id) : null);
  // A main ticket manages its family from every run (see Board.plannerRights).
  board.plannerRights = (slug, id) => {
    const t = store.getTicket(slug, id);
    return t && live.includes(id) && (t.main || t.tool) ? t : realPlanner(slug, id);
  };
  try {
    await fn();
  } finally {
    board.userAskedRun = realAsked;
    board.runnerRights = realRunner;
    board.plannerRights = realPlanner;
  }
};

test("a chat answering the user's message creates a top-level main ticket, also from a main ticket's own chat", async () => {
  const p = await profile("Main Home");
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const chat = (await (await send(tickets, { title: "Chat", body: "" })).json()) as any;
  store.updateTicket(p.slug, chat.id, { main: false });
  const mainChat = (await (await send(tickets, { title: "Main chat" })).json()) as any;
  expect(mainChat.main).toBe(true);
  await withRuns([chat.id, mainChat.id], [chat.id, mainChat.id], async () => {
    for (const caller of [chat, mainChat]) {
      const r = await send(tickets, { title: `New feature from ${caller.title}`, main: true }, { "x-ckanban-run": `${p.slug}/${caller.id}` });
      expect(r.status).toBe(201);
      const t = (await r.json()) as any;
      const saved = store.getTicket(p.slug, t.id)!;
      expect(saved.main).toBe(true);
      expect(saved.tool ?? false).toBe(false);
      expect(saved.parentId ?? null).toBeNull();
      expect(saved.partOf ?? null).toBeNull();
      expect([saved.status, saved.mode]).toEqual(["backlog", "interview"]);
      expect(store.listComments(p.slug, t.id).some((c) => c.text === "Created as a main ticket at the user's request.")).toBe(true);
    }
  });
});

test("main: true is refused outside a reply to the user's typed message, and no ticket is made", async () => {
  const p = await profile("Main Refuse");
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const work = (await (await send(tickets, { title: "Work run" })).json()) as any;
  const chat = (await (await send(tickets, { title: "Chat" })).json()) as any;
  await withRuns([chat.id], [work.id, chat.id], async () => {
    // A work run, follow-up or planner wake (live but not answering the user), and a huddle helper of the chat.
    for (const headers of [{ "x-ckanban-run": `${p.slug}/${work.id}` } as Record<string, string>, { "x-ckanban-run": `${p.slug}/${chat.id}`, "x-ckanban-huddle-agent": "reviewer" }]) {
      const r = await send(tickets, { title: "Nope", main: true }, headers);
      expect(r.status).toBe(403);
      expect(await errorOf(r)).toContain("main: true needs a message the user typed in this chat");
    }
    // Not top level: partOf (also what partOfThisTicket sends), parentId, sessionId.
    const asChat = { "x-ckanban-run": `${p.slug}/${chat.id}` };
    for (const extra of [{ partOf: chat.id }, { partOf: work.id }, { parentId: work.id }]) {
      const r = await send(tickets, { title: "Nope", main: true, ...extra }, asChat);
      expect(r.status).toBe(400);
      expect(await errorOf(r)).toContain("a main ticket is top level");
    }
    let r = await send(tickets, { title: "Nope", main: true, sessionId: "abc" }, asChat);
    expect(r.status).toBe(400);
    // gather needs main.
    r = await send(tickets, { title: "Nope", gather: [{ id: work.id }] }, asChat);
    expect(r.status).toBe(400);
    expect(await errorOf(r)).toContain("gather only works with main: true");
  });
  expect(store.listTickets(p.slug).some((t) => t.title === "Nope")).toBe(false);
});

test("main: true with gather on another board makes the main ticket there and gathers the tickets into it", async () => {
  const home = await profile("Kanban Home");
  const far = await profile("Rocket Far");
  const farTickets = `${base}/api/profiles/${far.slug}/tickets`;
  const chat = (await (await send(`${base}/api/profiles/${home.slug}/tickets`, { title: "Board chat" })).json()) as any;
  const a = (await (await send(farTickets, { title: "Outreach A" })).json()) as any;
  const b = (await (await send(farTickets, { title: "Outreach B" })).json()) as any;
  store.updateTicket(far.slug, a.id, { prUrl: "https://example.com/pr/1" });
  await withRuns([chat.id], [chat.id], async () => {
    const r = await send(farTickets, {
      title: "AI Outreach", main: true, newGroup: "Old plans",
      gather: [{ id: a.id }, { id: b.id, group: "new" }, { id: "t_missing" }],
    }, { "x-ckanban-run": `${home.slug}/${chat.id}` });
    expect(r.status).toBe(201);
    const t = (await r.json()) as any;
    expect(store.getTicket(far.slug, t.id)!.main).toBe(true);
    expect(t.gather.gathered.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(t.gather.skipped).toEqual([{ id: "t_missing", reason: "not found" }]);
    expect(t.gather.group.title).toBe("Old plans");
    expect(store.getTicket(far.slug, a.id)!.partOf).toBe(t.id);
    expect(store.getTicket(far.slug, a.id)!.prUrl).toBe("https://example.com/pr/1");
    expect(store.getTicket(far.slug, b.id)!.partOf).toBe(t.gather.group.id);
  });
});

test("without main, creating a ticket from a run is unchanged: not a main ticket", async () => {
  const p = await profile("Main Plain");
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const chat = (await (await send(tickets, { title: "Chat" })).json()) as any;
  store.updateTicket(p.slug, chat.id, { main: false });
  await withRuns([chat.id], [chat.id], async () => {
    const r = await send(tickets, { title: "Plain" }, { "x-ckanban-run": `${p.slug}/${chat.id}` });
    expect(r.status).toBe(201);
    expect(store.getTicket(p.slug, ((await r.json()) as any).id)!.main ?? false).toBe(false);
  });
});
