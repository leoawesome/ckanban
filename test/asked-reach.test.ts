import { afterAll, beforeAll, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

// update_status, gather_tickets, search_chat and read_chat from a chat answering the user's typed message: any feature
// and any ticket, on its own board or another. Every other run keeps its old reach.
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
const get = (u: string, headers: Record<string, string> = {}) => fetch(u, { headers });
const profile = async (name: string) => (await (await send(`${base}/api/profiles`, { name, path: tempDir("ck-p-") })).json()) as any;
const errorOf = async (r: Response) => ((await r.json()) as any).error as string;
const make = async (slug: string, title: string, extra: Record<string, unknown> = {}) =>
  (await (await send(`${base}/api/profiles/${slug}/tickets`, { title, body: "", ...extra })).json()) as any;
const comments = (slug: string, id: string) => store.listComments(slug, id).map((c) => c.text);

/** Pretend `asked` runs answer the user's typed message; every other run is a work run, follow-up or plan wake-up. */
const withAsked = async (asked: string[], fn: () => Promise<void>) => {
  const real = board.userAskedRun.bind(board);
  board.userAskedRun = (_slug, id) => asked.includes(id);
  try {
    await fn();
  } finally {
    board.userAskedRun = real;
  }
};

/** A board with a feature (top ticket, one ticket under it) and a loose ticket to gather. */
const feature = async (name: string) => {
  const p = await profile(name);
  const top = await make(p.slug, `${name} feature`);
  const member = await make(p.slug, `${name} member`, { partOf: top.id });
  const loose = await make(p.slug, `${name} loose`);
  return { slug: p.slug as string, name: p.name as string, top, member, loose };
};

test("a chat answering the user's typed message updates status, gathers and reads chats on another board, credited there", async () => {
  const home = await feature("Kanban Reach");
  const far = await feature("Rocket Reach");
  const asChat = { "x-ckanban-run": `${home.slug}/${home.loose.id}` };
  await withAsked([home.loose.id], async () => {
    let r = await send(`${base}/api/profiles/${far.slug}/tickets/${far.top.id}/status`, { next: "Write to the old leads" }, asChat);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).markdown).toContain("Write to the old leads");
    const credit = `by the chat of ${home.loose.id} on ${home.name} (user request)`;
    expect(comments(far.slug, far.top.id)).toContain(`Status updated ${credit}.`);

    r = await send(`${base}/api/profiles/${far.slug}/tickets/${far.top.id}/gather`, { tickets: [{ id: far.loose.id }] }, asChat);
    expect(r.status).toBe(200);
    expect(store.getTicket(far.slug, far.loose.id)!.partOf).toBe(far.top.id);
    expect(comments(far.slug, far.loose.id).some((c) => c.startsWith("Gathered into the feature") && c.includes(credit))).toBe(true);
    expect(comments(far.slug, far.top.id).some((c) => c.startsWith(`Gathered 1 ticket into this feature ${credit}`))).toBe(true);

    r = await get(`${base}/api/profiles/${far.slug}/chat/search?q=leads&ticket=${far.member.id}`, asChat);
    expect(r.status).toBe(200);
    store.updateTicket(far.slug, far.member.id, { sessionId: "bbbbbbbb-0000-0000-0000-000000000001" });
    r = await get(`${base}/api/profiles/${far.slug}/chat/read?ref=bbbbbbbb-0000-0000-0000-000000000001:0`, asChat);
    // Allowed through: its transcript just isn't there in this test.
    expect(r.status).toBe(404);
    expect(await errorOf(r)).toContain("can't be read any more");
  });
});

test("work runs, follow-ups, plan wake-ups and huddle helpers can't reach another board, and nothing changes", async () => {
  const home = await feature("Kanban Stay");
  const far = await feature("Rocket Stay");
  store.updateTicket(far.slug, far.member.id, { sessionId: "cccccccc-0000-0000-0000-000000000001" });
  const callers: Record<string, string>[] = [
    { "x-ckanban-run": `${home.slug}/${home.loose.id}` },
    { "x-ckanban-run": `${home.slug}/${home.member.id}`, "x-ckanban-huddle-agent": "reviewer" },
  ];
  // home.member answers the user, but only as a huddle helper here; home.loose is a work run.
  await withAsked([home.member.id], async () => {
    for (const h of callers) {
      const before = comments(far.slug, far.top.id).length;
      let r = await send(`${base}/api/profiles/${far.slug}/tickets/${far.top.id}/status`, { next: "Nope" }, h);
      expect(r.status).toBe(403);
      r = await send(`${base}/api/profiles/${far.slug}/tickets/${far.top.id}/gather`, { tickets: [{ id: far.loose.id }] }, h);
      expect(r.status).toBe(403);
      r = await get(`${base}/api/profiles/${far.slug}/chat/search?q=x&ticket=${far.member.id}`, h);
      expect(r.status).toBe(403);
      r = await get(`${base}/api/profiles/${far.slug}/chat/read?ref=cccccccc-0000-0000-0000-000000000001:0`, h);
      expect(r.status).toBe(403);
      expect(comments(far.slug, far.top.id).length).toBe(before);
    }
    const r = await send(`${base}/api/profiles/${far.slug}/tickets/${far.top.id}/status`, { next: "Nope" }, callers[0]);
    expect(await errorOf(r)).toContain(`updating a feature's status on another board (${far.slug}) only works in a chat reply to a message the user typed`);
  });
  expect(store.getTicket(far.slug, far.loose.id)!.partOf ?? null).toBeNull();
  const status = await (await get(`${base}/api/profiles/${far.slug}/tickets/${far.top.id}/status`)).json() as any;
  expect(JSON.stringify(status.saved ?? {})).not.toContain("Nope");
});

test("on one board, a chat answering the user reaches another feature; without the user's message it is refused as before", async () => {
  const b = await feature("Same Board");
  const other = await make(b.slug, "Other feature");
  const otherMember = await make(b.slug, "Other member", { partOf: other.id });
  const asOther = { "x-ckanban-run": `${b.slug}/${otherMember.id}` };
  const status = `${base}/api/profiles/${b.slug}/tickets/${b.top.id}/status`;
  const gather = `${base}/api/profiles/${b.slug}/tickets/${b.top.id}/gather`;
  const search = `${base}/api/profiles/${b.slug}/chat/search?q=x&ticket=${b.member.id}`;
  await withAsked([], async () => {
    let r = await send(status, { next: "Nope" }, asOther);
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toContain(`only runs of tickets in this feature may update its status (${otherMember.id} is not in ${b.top.id}'s family)`);
    r = await send(gather, { tickets: [{ id: b.loose.id }] }, asOther);
    expect(r.status).toBe(403);
    expect(await errorOf(r)).toContain("in a reply to a message the user typed there");
    expect((await get(search, asOther)).status).toBe(403);
    // A feature's own runs still update its status at any time, without crediting.
    r = await send(status, { done: "Member's part" }, { "x-ckanban-run": `${b.slug}/${b.member.id}` });
    expect(r.status).toBe(200);
    expect(comments(b.slug, b.top.id).some((c) => c.startsWith("Status updated"))).toBe(false);
  });
  expect(store.getTicket(b.slug, b.loose.id)!.partOf ?? null).toBeNull();
  await withAsked([otherMember.id], async () => {
    const credit = `by the chat of ${otherMember.id} ("Other member") (user request)`;
    let r = await send(status, { next: "Gather the loose one" }, asOther);
    expect(r.status).toBe(200);
    expect(comments(b.slug, b.top.id)).toContain(`Status updated ${credit}.`);
    r = await send(gather, { tickets: [{ id: b.loose.id }] }, asOther);
    expect(r.status).toBe(200);
    expect(store.getTicket(b.slug, b.loose.id)!.partOf).toBe(b.top.id);
    expect(comments(b.slug, b.loose.id).some((c) => c.includes(credit))).toBe(true);
    expect((await get(search, asOther)).status).toBe(200);
  });
  // The feature's own chat gathering for the user: as before, no extra credit.
  const loose2 = await make(b.slug, "Loose two");
  await withAsked([b.top.id], async () => {
    const r = await send(gather, { tickets: [{ id: loose2.id }] }, { "x-ckanban-run": `${b.slug}/${b.top.id}` });
    expect(r.status).toBe(200);
    expect(comments(b.slug, loose2.id).some((c) => c.includes("(user request)"))).toBe(false);
  });
});
