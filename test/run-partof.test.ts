import { afterAll, beforeAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir, until } from "./helpers";

// create_ticket's partOf from a board run: any ticket of the run's own feature (rounds, groups, other steps, at any
// depth, also while the main ticket sits in Done), another open feature's top ticket or group, and otherwise a fallback
// under the run's own ticket instead of a refusal. A ticket made inside a main ticket's family becomes its tool ticket.
let server: ReturnType<typeof createServer>;
let store: Store;
let board: Board;
let base: string;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false", planWakeDelayMs: 30 });
  server = createServer({ store, bus: new Bus(), board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const send = async (u: string, b: unknown, headers: Record<string, string> = {}) =>
  fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const profile = async (name: string) => (await (await send(`${base}/api/profiles`, { name, path: tempDir("ck-p-") })).json()) as any;

/** Pretend these tickets' work runs are live (they may change their own board). */
const withRuns = async (live: string[], fn: () => Promise<void>) => {
  const realRunner = board.runnerRights.bind(board);
  board.runnerRights = (slug, id) => (live.includes(id) ? store.getTicket(slug, id) : null);
  try {
    await fn();
  } finally {
    board.runnerRights = realRunner;
  }
};

/** The rocketbots case: main ticket "AI Outreach" in Done, a testing round and a with_you step under it, a fix step made from the with_you step's chat. */
async function outreach(name: string) {
  const p = await profile(name);
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const main = (await (await send(tickets, { title: "AI Outreach" })).json()) as any;
  expect(main.main).toBe(true);
  const round = await board.createTicket(p.slug, { title: "x", body: "", status: "review", mode: "auto", parentId: main.id, tool: true, kind: "round" });
  const withYou = await board.createTicket(p.slug, { title: "Live calls with Leo", body: "", status: "review", mode: "auto", parentId: main.id, tool: true, kind: "with_you" });
  const fix = await board.createTicket(p.slug, { title: "Find and fix: call drops", body: "", status: "in_progress", mode: "auto", parentId: withYou.id, partOf: withYou.id, partOfVia: "chat", kind: "fix" });
  store.updateTicket(p.slug, main.id, { status: "done" });
  return { p, tickets, main, round, withYou, fix };
}

test("a fix step under a with_you step creates a ticket partOf the testing round (main ticket in Done): a tool ticket of the round that starts", async () => {
  const { p, tickets, main, round, fix } = await outreach("Outreach Round");
  await withRuns([fix.id], async () => {
    const r = await send(tickets, { title: "Root-cause and fix", kind: "fix", partOf: round.id }, { "x-ckanban-run": `${p.slug}/${fix.id}` });
    expect(r.status).toBe(201);
    const t = (await r.json()) as any;
    const saved = store.getTicket(p.slug, t.id)!;
    expect(saved.tool).toBe(true);
    expect(saved.parentId).toBe(round.id);
    expect(saved.mode).toBe("auto");
    expect(t.note).toContain(`tool ticket of ${round.id}`);
    // The round's plan starts the new step; the user's park of the main ticket in Done stays.
    expect(store.getTicket(p.slug, main.id)!.status).toBe("done");
    expect(store.getTicket(p.slug, round.id)!.plan).toBeTruthy();
    await until(() => store.readActivity(p.slug, t.id).some((a: any) => a.event?.type === "ckanban_run"));
  });
  await board.whenIdle();
});

test("partOf the feature's top ticket while it sits in Done, and partOfThisTicket too deep, both become tool tickets of the main ticket", async () => {
  const { p, tickets, main, fix } = await outreach("Outreach Top");
  await withRuns([fix.id], async () => {
    const r1 = await send(tickets, { title: "Under the top", kind: "fix", partOf: main.id }, { "x-ckanban-run": `${p.slug}/${fix.id}` });
    expect(r1.status).toBe(201);
    const a = store.getTicket(p.slug, ((await r1.json()) as any).id)!;
    expect([a.tool, a.parentId]).toEqual([true, main.id]);
    // partOfThisTicket: the fix step is 2 levels deep, so the ticket goes up to the with_you step, whose main ticket runs it.
    const r2 = await send(tickets, { title: "Next part", kind: "fix", partOf: fix.id }, { "x-ckanban-run": `${p.slug}/${fix.id}` });
    expect(r2.status).toBe(201);
    const j = (await r2.json()) as any;
    const b = store.getTicket(p.slug, j.id)!;
    expect([b.tool, b.parentId]).toEqual([true, main.id]);
    expect(j.note).toContain("levels deep");
  });
  await board.whenIdle();
});

test("partOf another open feature's group still works from a run; partOf an unrelated ticket falls back under the run's own ticket; an unknown id fails", async () => {
  const p = await profile("Other Feature");
  const tickets = `${base}/api/profiles/${p.slug}/tickets`;
  const plain = async (title: string, extra: Record<string, unknown> = {}) => {
    const t = (await (await send(tickets, { title, ...extra })).json()) as any;
    store.updateTicket(p.slug, t.id, { main: false });
    return t;
  };
  const top = await plain("Billing");
  const group = await plain("Invoices", { partOf: top.id, kind: "group" });
  await plain("Invoice PDF", { partOf: group.id });
  const work = await plain("Some work");
  const loose = await plain("Unrelated ticket");
  await withRuns([work.id], async () => {
    const run = { "x-ckanban-run": `${p.slug}/${work.id}` };
    const r1 = await send(tickets, { title: "Invoice emails", partOf: group.id }, run);
    expect(r1.status).toBe(201);
    const a = (await r1.json()) as any;
    expect(a.partOf).toBe(group.id);
    expect(a.tool ?? false).toBe(false);
    expect(a.note).toBeUndefined();

    const r2 = await send(tickets, { title: "Follow-up", partOf: loose.id }, run);
    expect(r2.status).toBe(201);
    const b = (await r2.json()) as any;
    expect(b.partOf).toBe(work.id);
    expect(store.getTicket(p.slug, b.id)!.partOfVia).toBe("chat");
    expect(b.note).toContain(`under this run's own ticket ${work.id}`);

    const r3 = await send(tickets, { title: "Nope", partOf: "t_00000000_none" }, run);
    expect(r3.status).toBe(400);
  });
});
