// Ticket families: "part of" links, parent suggestions, the family tree and get_family.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { BoardClient } from "../src/client";
import { callTool, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { candidates, Linker, parseFound, parseSuggestion } from "../src/server/linker";
import { RUN_HEADER } from "../src/server/scheduler";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { cardFamilies, familyOf, parentLink, wouldLoop, type FamilyTicket } from "../web/src/family";
import { tempDir, until } from "./helpers";

const at = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const tk = (id: string, n: number, links: Partial<FamilyTicket> = {}): FamilyTicket => ({ id, title: id.toUpperCase(), status: "backlog", createdAt: at(n), ...links });

test("parentLink: part of wins over an add-on, an add-on over a plan; chat-made links say so", () => {
  expect(parentLink({ partOf: "a", addOnOf: "b", parentId: "c" })).toEqual({ id: "a", how: "linked" });
  expect(parentLink({ partOf: "a", partOfVia: "chat" })).toEqual({ id: "a", how: "chat" });
  expect(parentLink({ addOnOf: "b", parentId: "c" })).toEqual({ id: "b", how: "add-on" });
  expect(parentLink({ parentId: "c" })).toEqual({ id: "c", how: "plan" });
  expect(parentLink({})).toBeNull();
});

test("familyOf: the whole family from the top ticket down over all three link kinds, from any member", () => {
  const tickets = [
    tk("top", 1),
    tk("map", 3, { partOf: "top" }),
    tk("audit", 2, { partOf: "top", partOfVia: "chat" }),
    tk("sched", 4, { partOf: "top" }),
    tk("discuss", 5, { addOnOf: "sched" }),
    tk("child", 6, { parentId: "discuss" }),
    tk("other", 7),
  ];
  const rows = familyOf(tickets, "child");
  expect(rows.map((r) => [r.ticket.id, r.depth, r.how])).toEqual([
    ["top", 0, null], ["audit", 1, "chat"], ["map", 1, "linked"], ["sched", 1, "linked"], ["discuss", 2, "add-on"], ["child", 3, "plan"],
  ]);
  expect(familyOf(tickets, "top").map((r) => r.ticket.id)).toEqual(rows.map((r) => r.ticket.id));
  expect(familyOf(tickets, "other").map((r) => r.ticket.id)).toEqual(["other"]);
  expect(familyOf(tickets, "gone")).toEqual([]);
});

test("familyOf: a deleted parent leaves its children at the top; a loop in old data doesn't hang", () => {
  expect(familyOf([tk("a", 1, { partOf: "deleted" }), tk("b", 2, { partOf: "a" })], "b").map((r) => r.ticket.id)).toEqual(["a", "b"]);
  const loop = [tk("a", 1, { partOf: "b" }), tk("b", 2, { partOf: "a" })];
  expect(familyOf(loop, "a").length).toBeLessThanOrEqual(2);
});

test("wouldLoop: a ticket can't go under itself or anything below it", () => {
  const tickets = [tk("a", 1), tk("b", 2, { partOf: "a" }), tk("c", 3, { addOnOf: "b" }), tk("d", 4)];
  expect(wouldLoop(tickets, "a", "c")).toBe(true);
  expect(wouldLoop(tickets, "a", "a")).toBe(true);
  expect(wouldLoop(tickets, "c", "a")).toBe(false);
  expect(wouldLoop(tickets, "a", "d")).toBe(false);
});

test("cardFamilies: the ticket a card is part of and its direct children of every kind", () => {
  const f = cardFamilies([tk("a", 1), tk("b", 2, { partOf: "a" }), tk("c", 3, { addOnOf: "a" }), tk("d", 4, { parentId: "a" }), tk("e", 5, { partOf: "gone" })]);
  expect(f.get("a")!.children.map((c) => c.id)).toEqual(["b", "c", "d"]);
  expect(f.get("b")!.partOf?.id).toBe("a");
  expect(f.get("e")!.partOf).toBeUndefined();
});

test("parseSuggestion: only a ticket from the list; malformed or unknown answers suggest nothing", () => {
  expect(parseSuggestion('{"parent": "t_a", "reason": "Same outbound call flow."}', ["t_a"])).toEqual({ id: "t_a", reason: "Same outbound call flow." });
  expect(parseSuggestion('Sure! {"parent": "t_zzz", "reason": "x"}', ["t_a"])).toBeNull();
  expect(parseSuggestion('{"parent": null, "reason": "nothing fits"}', ["t_a"])).toBeNull();
  expect(parseSuggestion("I think t_a", ["t_a"])).toBeNull();
  expect(parseSuggestion("{not json", ["t_a"])).toBeNull();
});

test("parseFound: drops unknown tickets, tickets that already have a parent, repeats and loops", () => {
  const list = [tk("a", 1), tk("b", 2), tk("c", 3, { partOf: "a" }), tk("d", 4)] as unknown as Ticket[];
  const found = parseFound(JSON.stringify({ links: [
    { id: "b", parent: "a", reason: "same work" },
    { id: "c", parent: "b", reason: "has a parent already" },
    { id: "x", parent: "a" },
    { id: "d", parent: "zz" },
    { id: "a", parent: "b", reason: "loop: b is under a now" },
    { id: "b", parent: "d", reason: "repeat" },
    { id: "d", parent: "b" },
  ] }), list);
  expect(found).toEqual([{ id: "b", parent: "a", reason: "same work" }, { id: "d", parent: "b", reason: "" }]);
  expect(parseFound("no json here", list)).toBeNull();
});

test("candidates: open tickets and Done ones from the last 30 days, newest first", () => {
  const now = Date.parse("2026-10-27T00:00:00Z");
  const t = (id: string, status: string, updatedAt: string) => ({ id, status, updatedAt }) as Ticket;
  const out = candidates([t("old-done", "done", "2026-09-01T00:00:00Z"), t("old-open", "backlog", "2026-06-01T00:00:00Z"), t("new-done", "done", "2026-10-20T00:00:00Z")], now);
  expect(out.map((x) => x.id)).toEqual(["new-done", "old-open"]);
});

// ---- Over HTTP: create, link, suggest, get_family ----

let server: ReturnType<typeof createServer>;
let store: Store;
let board: Board;
let base: string;
const calls: SideCallInput[] = [];
let answer: SideCallResult = { ok: true, text: "{}", costUsd: 0.001, model: "haiku" };

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  board = new Board(store, bus, { claudeBin: "/bin/false" });
  const sideCall = async (i: SideCallInput) => {
    calls.push(i);
    return answer;
  };
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), linker: new Linker(store, board, sideCall) });
  base = `http://127.0.0.1:${server.port}`;
  store.saveProfile({ name: "F", slug: "f", path: tempDir("ck-plain-"), baseBranch: "main", maxParallel: 1, model: null, createdAt: new Date().toISOString() });
});

afterAll(() => server.stop(true));

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/profiles/f${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const patch = (id: string, body: object) =>
  fetch(`${base}/api/profiles/f/tickets/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a ticket the user makes gets a parent suggestion; Link links it, Not related stops suggesting", async () => {
  const top = store.createTicket("f", { title: "AI outreach: own outbound call settings", body: "Call behavior, voice, recording", status: "review" });
  answer = { ok: true, text: JSON.stringify({ parent: top.id, reason: "Same outbound call flow." }), costUsd: 0.002, model: "haiku" };
  const r = await post("/tickets", { title: "AI outreach: retry a call when the contact is busy" });
  expect(r.status).toBe(201);
  const t = (await r.json()) as Ticket;
  await until(() => !!store.getTicket("f", t.id)!.parentChecked);
  expect(store.getTicket("f", t.id)!.parentSuggestion).toEqual({ id: top.id, reason: "Same outbound call flow." });
  expect(calls.at(-1)!.prompt).toContain(top.id);
  expect(calls.at(-1)!.prompt).not.toContain(`${t.id} [`);

  let linked = (await (await patch(t.id, { partOf: top.id })).json()) as Ticket;
  expect(linked).toMatchObject({ partOf: top.id, parentSuggestion: null, parentChecked: true });
  expect(linked.partOfVia ?? null).toBeNull();

  const fam = (await (await fetch(`${base}/api/profiles/f/tickets/${t.id}/family`)).json()) as any[];
  expect(fam.map((x) => [x.id, x.depth, x.how])).toEqual([[top.id, 0, null], [t.id, 1, "linked"]]);

  linked = (await (await patch(t.id, { partOf: null })).json()) as Ticket;
  expect(linked.partOf).toBeNull();

  // Not related: never suggested again.
  const n = store.createTicket("f", { title: "Other", body: "", status: "backlog" });
  board.suggestParent("f", n.id, { id: top.id, reason: "r" });
  const dismissed = (await (await patch(n.id, { parentSuggestion: null })).json()) as Ticket;
  expect(dismissed).toMatchObject({ parentSuggestion: null, parentChecked: true });
  expect(board.suggestParent("f", n.id, { id: top.id, reason: "again" })).toBeNull();
});

test("a failing or unknown suggestion shows nothing; linking refuses loops and missing tickets", async () => {
  answer = { ok: false, error: "claude exited with code 1" };
  store.createTicket("f", { title: "Something else on the board", body: "", status: "backlog" });
  const before = calls.length;
  const t = (await (await post("/tickets", { title: "Lonely" })).json()) as Ticket;
  await until(() => calls.length > before);
  expect(store.getTicket("f", t.id)!.parentSuggestion ?? null).toBeNull();

  answer = { ok: true, text: '{"parent": "t_nope", "reason": "x"}', costUsd: 0, model: "haiku" };
  const u = (await (await post("/tickets", { title: "Also lonely" })).json()) as Ticket;
  await until(() => !!store.getTicket("f", u.id)!.parentChecked);
  expect(store.getTicket("f", u.id)!.parentSuggestion).toBeNull();

  expect((await patch(t.id, { partOf: u.id })).status).toBe(200);
  const loop = await patch(u.id, { partOf: t.id });
  expect(loop.status).toBe(400);
  expect(((await loop.json()) as any).error).toContain("loop");
  expect((await patch(u.id, { partOf: "t_missing" })).status).toBe(400);
  expect((await patch(u.id, { partOf: 5 })).status).toBe(400);
});

test("deleting a parent unlinks its children and drops suggestions pointing at it", async () => {
  const p = store.createTicket("f", { title: "Parent", body: "", status: "backlog" });
  const c = store.createTicket("f", { title: "Child", body: "", status: "backlog", partOf: p.id });
  const s = store.createTicket("f", { title: "Suggested", body: "", status: "backlog" });
  board.suggestParent("f", s.id, { id: p.id, reason: "r" });
  await board.deleteTicket("f", p.id);
  expect(store.getTicket("f", c.id)!.partOf).toBeNull();
  expect(store.getTicket("f", s.id)!.parentSuggestion).toBeNull();
});

test("create_ticket from a ticket's chat links only with partOfThisTicket, as from chat; get_family lists the family", async () => {
  const chatT = store.createTicket("f", { title: "Own outbound call settings", body: "", status: "review" });
  const real = board.userRequestRights.bind(board);
  board.userRequestRights = (slug, id) => (slug === "f" && id === chatT.id ? store.getTicket(slug, id)! : real(slug, id));
  try {
    const ctx: ToolContext = { client: new BoardClient(server.port!), cwd: "/", env: { CKANBAN_TICKET: `f/${chatT.id}` } };
    const before = calls.length;
    const a = await callTool("create_ticket", { profile: "f", title: "Audit readers against the new table", partOfThisTicket: true }, ctx);
    expect(a.isError).toBeUndefined();
    const b = await callTool("create_ticket", { profile: "f", title: "Unrelated: renew the domain" }, ctx);
    expect(b.isError).toBeUndefined();
    const all = store.listTickets("f");
    const linked = all.find((t) => t.title === "Audit readers against the new table")!;
    const other = all.find((t) => t.title === "Unrelated: renew the domain")!;
    expect(linked).toMatchObject({ partOf: chatT.id, partOfVia: "chat" });
    expect(other.partOf).toBeUndefined();
    expect(store.listComments("f", linked.id).some((c) => c.text.includes(`Linked as part of ${chatT.id}`))).toBe(true);
    // Tickets a chat creates get no suggestion call: the chat decided.
    expect(calls.length).toBe(before);

    // A run can't put a new ticket under some other ticket.
    const r = await post("/tickets", { title: "Sneaky", partOf: other.id }, { [RUN_HEADER]: `f/${chatT.id}` });
    expect(r.status).toBe(403);

    const fam = await callTool("get_family", { profile: "f", id: linked.id }, ctx);
    expect(fam.isError).toBeUndefined();
    const text = fam.content[0].text;
    expect(text).toContain("Family of 2 tickets");
    expect(text).toContain(`${chatT.id} [review] (top) Own outbound call settings`);
    expect(text).toContain(`  - ${linked.id} [backlog] (from chat) Audit readers against the new table`);
    const alone = await callTool("get_family", { profile: "f", id: other.id }, ctx);
    expect(alone.content[0].text).toContain("not part of a family");
  } finally {
    board.userRequestRights = real;
  }
});

test("Find links is for the user only and returns suggestions without changing tickets", async () => {
  const run = await post("/find-links", {}, { [RUN_HEADER]: "f/t_x" });
  expect(run.status).toBe(403);
  const ids = store.listTickets("f").filter((t) => !parentLink(t)).map((t) => t.id);
  answer = { ok: true, text: JSON.stringify({ links: [{ id: ids[1], parent: ids[0], reason: "same work" }] }), costUsd: 0.01, model: "sonnet" };
  const linker = new Linker(store, board, async () => answer);
  const r = await linker.find("f");
  expect(r.links).toEqual([{ id: ids[1], parent: ids[0], reason: "same work" }]);
  expect(store.getTicket("f", ids[1])!.partOf ?? null).toBeNull();
});
