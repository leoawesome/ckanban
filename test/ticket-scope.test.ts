import { describe, expect, test } from "bun:test";
import { boardScope, donePage, doneSearch, familyKeys, idsScope } from "../src/server/ticketScope";
import { doneCards, joinsBoard, mergeTickets, reloadTickets, unseenDone } from "../web/src/donePaging";

type T = { id: string; title: string; status: string; createdAt: string; order: number; parentId?: string | null; partOf?: string | null; tool?: boolean; showOnBoard?: boolean | null; pinnedAt?: string | null; body?: string; tags?: string[] };
let n = 0;
const tk = (id: string, status: string, more: Partial<T> = {}): T => ({ id, title: id, status, createdAt: `2026-01-01T00:00:${String(n++ % 60).padStart(2, "0")}Z`, order: n, ...more });
const ids = (r: { tickets: { id: string }[] }) => r.tickets.map((t) => t.id).sort();

describe("ticketScope", () => {
  test("families follow parent and part-of links, and survive a loop", () => {
    const keys = familyKeys([tk("a", "done"), tk("b", "done", { parentId: "a" }), tk("c", "done", { partOf: "b" }), tk("x", "done", { parentId: "y" }), tk("y", "done", { parentId: "x" })]);
    expect(keys.get("c")).toBe("a");
    expect(keys.get("b")).toBe("a");
    expect(keys.get("x")).toBe(keys.get("y")!);
  });

  test("the board's first load: unfinished work with whole families, no other finished tickets", () => {
    const all = [
      tk("main", "review", { }), tk("step1", "done", { parentId: "main", tool: true }), tk("step2", "in_progress", { parentId: "main", tool: true }),
      tk("old", "done"), tk("oldStep", "done", { parentId: "old", tool: true }), tk("idea", "backlog"),
      tk("finishedMain", "done"), tk("liveStep", "ready", { parentId: "finishedMain", tool: true }),
    ];
    const r = boardScope(all);
    expect(ids(r)).toEqual(["finishedMain", "idea", "liveStep", "main", "step1", "step2"]);
    // Done cards: old and finishedMain (hidden steps have no card).
    expect(r.doneTotal).toBe(2);
    expect(ids(boardScope(all, { ids: ["old"] }))).toContain("oldStep");
  });

  test("Done pages follow the column's order: pinned first, then order", () => {
    const all = [tk("d1", "done", { order: 3 }), tk("d2", "done", { order: 1 }), tk("d3", "done", { order: 2, pinnedAt: "2026-01-02" }), tk("s", "done", { tool: true }), tk("b", "backlog")];
    expect(donePage(all, 0, 2).tickets.map((t) => t.id)).toEqual(["d3", "d2"]);
    expect(donePage(all, 2, 2).tickets.map((t) => t.id)).toEqual(["d1"]);
    expect(donePage(all, 0).doneTotal).toBe(3);
    expect(boardScope(all, { done: 1 }).tickets.map((t) => t.id)).toEqual(["d3", "b"]);
  });

  test("search finds finished tickets, and a hidden step brings its main ticket", () => {
    const all = [tk("m", "done", { title: "Login page" }), tk("st", "done", { parentId: "m", tool: true, body: "fix the OAuth callback" }), tk("other", "done", { tags: ["ui"] }), tk("open", "review", { title: "oauth too" })];
    expect(ids(doneSearch(all, "oauth", []))).toEqual(["m", "st"]);
    expect(ids(doneSearch(all, "", ["ui"]))).toEqual(["other"]);
    expect(doneSearch(all, "", []).tickets).toEqual([]);
    expect(ids(idsScope(all, ["st"]))).toEqual(["m", "st"]);
  });
});

describe("donePaging", () => {
  test("a reload keeps loaded Done cards and unchanged objects, drops unfinished ones it no longer has", () => {
    const a = { id: "a", status: "backlog", v: 1 }, b = { id: "b", status: "done", v: 1 }, c = { id: "c", status: "done", v: 1 }, gone = { id: "g", status: "review", v: 1 };
    const freshA = { ...a }, freshB = { id: "b", status: "done", v: 2 }, n = { id: "n", status: "planning", v: 1 };
    const out = reloadTickets([a, b, c, gone], [freshA, freshB, n]);
    expect(out.map((t) => t.id)).toEqual(["a", "b", "n", "c"]);
    expect(out[0]).toBe(a); // same content: the held object stays
    expect(out[1]).toBe(freshB);
    expect(out[3]).toBe(c);
  });
  test("merge replaces held copies and adds new ones at the end", () => {
    expect(mergeTickets([{ id: "a", v: 1 }, { id: "b", v: 1 }], [{ id: "b", v: 2 }, { id: "c", v: 2 }])).toEqual([{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "c", v: 2 }]);
  });
  test("unseen Done cards: the server's count minus the Done cards held", () => {
    const held = [{ id: "a", status: "done" }, { id: "s", status: "done", tool: true }, { id: "b", status: "review" }];
    expect(doneCards(held)).toBe(1);
    expect(unseenDone(10, held)).toBe(9);
    expect(unseenDone(0, held)).toBe(0);
  });
  test("an event for an unloaded finished ticket doesn't put it on the board", () => {
    expect(joinsBoard({ status: "done" })).toBe(false);
    expect(joinsBoard({ status: "backlog" })).toBe(true);
  });
});

describe("list_tickets search cap", () => {
  test("a search past 100 matches says how many matched", async () => {
    const { listScope } = await import("../src/server/ticketScope");
    const { ticketListText } = await import("../src/client");
    const all = Array.from({ length: 130 }, (_, i) => tk(`t_${String(i).padStart(3, "0")}`, "done", { title: `login ${i}` }));
    const page = listScope(all, { q: "login" });
    expect(page.total).toBe(100);
    expect(page.matched).toBe(130);
    const text = ticketListText("b", { ...page, tickets: [] } as any, { query: "login" }, () => "", "");
    expect(text).toContain("130 tickets match; only the newest 100 are listed");
    expect(ticketListText("b", { ...listScope(all.slice(0, 5), { q: "login" }), tickets: [] } as any, { query: "login" }, () => "", "")).not.toContain("match;");
  });
});
