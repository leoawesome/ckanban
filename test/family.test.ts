// Ticket families: "part of" links, parent suggestions, the family tree and get_family.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { BoardClient } from "../src/client";
import { callTool, proposalError, type ToolContext } from "../src/mcp-server";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { createServer } from "../src/server/http";
import { candidates, Linker, parseFound, parseSuggestion } from "../src/server/linker";
import { RUN_HEADER } from "../src/server/scheduler";
import { parseProposal } from "../src/server/session";
import type { SideCallInput, SideCallResult } from "../src/server/side-call";
import { Store } from "../src/server/store";
import type { Ticket } from "../src/server/types";
import { familyNearby, partOfFor, familyOf, looksLikeQuestion, parentLink, wouldLoop, type FamilyTicket } from "../web/src/family";
import { tempDir, until } from "./helpers";

const at = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const tk = (id: string, n: number, links: Partial<FamilyTicket> = {}): FamilyTicket => ({ id, title: id.toUpperCase(), status: "backlog", createdAt: at(n), ...links });

test("parentLink: part of wins over a plan; chat-made links say so", () => {
  expect(parentLink({ partOf: "a", parentId: "c" })).toEqual({ id: "a", how: "linked" });
  expect(parentLink({ partOf: "a", partOfVia: "chat" })).toEqual({ id: "a", how: "chat" });
  expect(parentLink({ parentId: "c" })).toEqual({ id: "c", how: "plan" });
  expect(parentLink({})).toBeNull();
});

test("familyOf: the whole family from the top ticket down over every link kind, from any member", () => {
  const tickets = [
    tk("top", 1),
    tk("map", 3, { partOf: "top" }),
    tk("audit", 2, { partOf: "top", partOfVia: "chat" }),
    tk("sched", 4, { partOf: "top" }),
    tk("discuss", 5, { partOf: "sched" }),
    tk("child", 6, { parentId: "discuss" }),
    tk("other", 7),
  ];
  const rows = familyOf(tickets, "child");
  expect(rows.map((r) => [r.ticket.id, r.depth, r.how])).toEqual([
    ["top", 0, null], ["audit", 1, "chat"], ["map", 1, "linked"], ["sched", 1, "linked"], ["discuss", 2, "linked"], ["child", 3, "plan"],
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

test("familyNearby: parents up to the top, the ticket and its own children", () => {
  const tickets = [
    tk("top", 1), tk("a", 2, { partOf: "top" }), tk("a1", 3, { partOf: "a" }), tk("b", 4, { partOf: "top" }),
    tk("me", 5, { partOf: "b" }), tk("k1", 6, { partOf: "me" }), tk("g1", 7, { partOf: "k1" }), tk("k2", 8, { partOf: "me" }), tk("c", 9, { partOf: "top" }),
  ];
  expect(familyNearby(familyOf(tickets, "me"), "me").map((r) => r.ticket.id)).toEqual(["top", "b", "me", "k1", "k2"]);
  expect(familyNearby(familyOf(tickets, "top"), "top").map((r) => r.ticket.id)).toEqual(["top", "a", "b", "c"]);
});

test("wouldLoop: a ticket can't go under itself or anything below it", () => {
  const tickets = [tk("a", 1), tk("b", 2, { partOf: "a" }), tk("c", 3, { partOf: "b" }), tk("d", 4)];
  expect(wouldLoop(tickets, "a", "c")).toBe(true);
  expect(wouldLoop(tickets, "a", "a")).toBe(true);
  expect(wouldLoop(tickets, "c", "a")).toBe(false);
  expect(wouldLoop(tickets, "a", "d")).toBe(false);
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
  expect(((await loop.json()) as any).error).toBe(`"Lonely" is already inside "Also lonely", so "Also lonely" can't go under it.`);
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

    // A run's partOf outside its own family and any open feature doesn't block it: the ticket goes under the run's own ticket.
    const r = await post("/tickets", { title: "Sneaky", partOf: other.id }, { [RUN_HEADER]: `f/${chatT.id}` });
    expect(r.status).toBe(201);
    const sneaky = (await r.json()) as any;
    expect([sneaky.partOf, sneaky.note]).toEqual([chatT.id, expect.stringContaining(`under this run's own ticket ${chatT.id}`)]);
    await board.deleteTicket("f", sneaky.id);

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

test("moving a plan ticket or an old add-on in its family ends the wrong link; a plan sibling that depends on it blocks the move", async () => {
  const planner = store.createTicket("f", { title: "Hotfix: create call permission templates", body: "", status: "review" });
  const outbound = store.createTicket("f", { title: "AI outreach: outbound calls", body: "", status: "review" });
  const kid = store.createTicket("f", { title: "AI Agent: send templates that have variables", body: "", status: "planning", parentId: planner.id, planKey: "vars" });
  let moved = (await (await patch(kid.id, { partOf: outbound.id })).json()) as Ticket;
  expect(moved).toMatchObject({ partOf: outbound.id, parentId: null, planKey: null });
  expect(familyOf(store.listTickets("f"), kid.id).map((r) => r.ticket.id)).toEqual([outbound.id, kid.id]);

  const src = store.createTicket("f", { title: "Original", body: "", status: "done" });
  const addOn = store.createTicket("f", { title: "Add-on", body: "", status: "backlog" });
  // An old add-on loads as partOf + madeFrom (store.ts withoutAddOn).
  store.updateTicket("f", addOn.id, { partOf: src.id, madeFrom: src.id, startFrom: "ck/original" });
  moved = (await (await patch(addOn.id, { partOf: null })).json()) as Ticket;
  expect(moved).toMatchObject({ startFrom: null, partOf: null, madeFrom: src.id });

  const a = store.createTicket("f", { title: "Plan step a", body: "", status: "backlog", parentId: planner.id, planKey: "a" });
  store.createTicket("f", { title: "Plan step b", body: "", status: "backlog", parentId: planner.id, planKey: "b", dependsOn: ["a"] });
  const r = await patch(a.id, { partOf: outbound.id });
  expect(r.status).toBe(400);
  expect(((await r.json()) as any).error).toContain("depends on this ticket");
  expect(store.getTicket("f", a.id)).toMatchObject({ parentId: planner.id });
  expect(store.getTicket("f", a.id)!.partOf ?? null).toBeNull();
});

test("propose_ticket can carry a family move: a ticket id, or none to take it out", () => {
  expect(parseProposal({ title: "T", description: "D", partOf: "t_abc" })).toMatchObject({ partOf: "t_abc" });
  expect(parseProposal({ title: "T", description: "D", partOf: "none" })).toMatchObject({ partOf: null });
  expect(parseProposal({ title: "T", description: "D" })!.partOf).toBeUndefined();
  expect(proposalError({ title: "T", description: "D", partOf: 5 })).toContain("partOf");
  expect(proposalError({ title: "T", description: "D", partOf: "t_abc" })).toBeNull();
});

test("looksLikeQuestion: a question mark at the end or a question word first, no AI call", () => {
  expect(looksLikeQuestion("why does this chat show Old chat")).toBe(true);
  expect(looksLikeQuestion("The chat shows Old chat?")).toBe(true);
  expect(looksLikeQuestion("How do I add a tag")).toBe(true);
  expect(looksLikeQuestion("Is the daemon running")).toBe(true);
  expect(looksLikeQuestion("Can we ship today")).toBe(true);
  expect(looksLikeQuestion("Old chat label", "Why is it there?")).toBe(true);
  expect(looksLikeQuestion("", "what does Make ticket do")).toBe(true);
  // Work, not questions: words that only start like one don't count.
  expect(looksLikeQuestion("Add a login page")).toBe(false);
  expect(looksLikeQuestion("Issue with the board")).toBe(false);
  expect(looksLikeQuestion("Document the API", "Cover every route.")).toBe(false);
  expect(looksLikeQuestion("Cannot log in")).toBe(false);
  expect(looksLikeQuestion("")).toBe(false);
});

test("partOfFor: a new ticket stays on its own until the user picks a feature that is still open", () => {
  const open = ["t_a", "t_b"];
  expect(partOfFor("own", "", "", open)).toBeUndefined();
  expect(partOfFor("own", "t_a", "t_b", open)).toBeUndefined();
  expect(partOfFor("other", "", "", open)).toBeUndefined();
  expect(partOfFor("other", "", "t_b", open)).toBe("t_b");
  // "add" keeps the id tapped, whatever the suggestion turns into later.
  expect(partOfFor("add", "t_a", "", open)).toBe("t_a");
  // The picked feature closed: nothing is sent.
  expect(partOfFor("add", "t_a", "", ["t_b"])).toBeUndefined();
  expect(partOfFor("other", "", "t_b", ["t_a"])).toBeUndefined();
});
