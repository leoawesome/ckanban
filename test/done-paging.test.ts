// The Done column pages by a cursor: cards leaving, joining or being deleted between pages, a failed move and a
// reconnect leave no gaps and no doubles. A small model of App.tsx's paging (same helpers) against the server's scopes.
import { describe, expect, test } from "bun:test";
import { boardScope, donePage, doneColumn } from "../src/server/ticketScope";
import { doneCursor, doneDrifted, heldDoneColumn, heldDoneHead, mergeTickets, reloadAsk, takeReload, unseenDone } from "../web/src/donePaging";

type T = { id: string; title: string; status: any; order: number; createdAt: string; pinnedAt?: string | null; updatedAt?: string };

function board(done: number, open = 10) {
  const server: T[] = [];
  for (let i = 0; i < done; i++) server.push({ id: `d${String(i).padStart(4, "0")}`, title: `done ${i}`, status: "done", order: i, createdAt: "2026-01-01" });
  for (let i = 0; i < open; i++) server.push({ id: `o${i}`, title: `open ${i}`, status: "review", order: i, createdAt: "2026-01-01" });
  return server;
}

/** The page's side: held tickets, paged ids, extras and the unseen count, moved like App.tsx moves them. */
class Page {
  held: T[] = [];
  paged = new Set<string>();
  extras = new Set<string>();
  unseen = 0;
  requests = 0;
  constructor(public server: T[]) {}
  reload(touched: string[] = [], full = false): void {
    const ask = reloadAsk(this.held, this.paged, this.extras, touched, full);
    const before = this.unseen;
    const ans = boardScope(structuredClone(this.server), { done: ask.done, ids: ask.ids, after: ask.after });
    this.requests++;
    const r = takeReload(this.held, ans.tickets, this.paged, this.extras, ask);
    this.held = r.tickets;
    this.paged = r.paged;
    this.unseen = unseenDone(ans.doneTotal, this.held);
    const heldHead = ask.after ? heldDoneHead(this.held, ask.after) : null;
    if (doneDrifted(ask, ans.doneHead, heldHead, before, this.unseen)) this.reload(touched, true);
  }
  more(): boolean {
    if (this.unseen <= 0) return false;
    const at = doneCursor(this.held, this.paged);
    const page = donePage(structuredClone(this.server), at.offset, 20, undefined, at.after);
    this.requests++;
    for (const t of page.tickets) this.paged.add(t.id);
    this.held = mergeTickets(this.held, page.tickets);
    this.unseen = unseenDone(page.doneTotal, this.held);
    if (!page.tickets.length && this.unseen > 0) this.reload([], true);
    return true;
  }
  all(): void {
    for (let i = 0; i < 500 && this.more(); i++);
  }
  // Live events (App.tsx subscribe): an update replaces a held copy (a finished one not held stays out), a delete drops.
  event(t: T | null, id = t?.id): void {
    const i = this.held.findIndex((h) => h.id === id);
    if (!t) this.held = this.held.filter((h) => h.id !== id);
    else if (i >= 0) this.held = this.held.map((h) => (h.id === id ? { ...t } : h));
    else if (t.status !== "done") this.held = [...this.held, { ...t }];
  }
  doneIds(): string[] {
    return heldDoneColumn(this.held).map((t) => t.id);
  }
}

const server = {
  set(s: T[], id: string, patch: Partial<T>): T {
    const t = s.find((x) => x.id === id)!;
    Object.assign(t, patch);
    return t;
  },
  del(s: T[], id: string): void {
    s.splice(s.findIndex((x) => x.id === id), 1);
  },
};

const columnIds = (s: T[]) => doneColumn(s).map((t) => t.id);
const noDoubles = (p: Page) => expect(new Set(p.held.map((t) => t.id)).size).toBe(p.held.length);

describe("Done paging by cursor", () => {
  test("deleting, moving out and moving in between pages: no gaps, no doubles", () => {
    const s = board(400);
    const p = new Page(s);
    p.reload();
    p.more(); p.more(); p.more();
    // Two deleted from page 1, one dragged out of page 2, one dragged in at the top, one reordered in the unpaged part.
    for (const id of ["d0001", "d0005"]) { server.del(s, id); p.event(null, id); }
    p.event(server.set(s, "d0030", { status: "review" }));
    p.event(server.set(s, "o3", { status: "done", order: -1 }));
    server.set(s, "d0200", { order: 45.5 });
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
    expect(p.unseen).toBe(0);
    noDoubles(p);
  });

  test("a failed move of a Done card past page 1 comes back", () => {
    const s = board(300);
    const p = new Page(s);
    p.reload();
    p.more(); p.more(); p.more();
    // The move shows at once, the server refuses, the rollback reload asks for that card by id.
    p.held = p.held.map((t) => (t.id === "d0045" ? { ...t, status: "review" } : t));
    const n = p.requests;
    p.reload(["d0045"]);
    expect(p.requests).toBe(n + 1);
    expect(p.held.find((t) => t.id === "d0045")?.status).toBe("done");
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
    noDoubles(p);
  });

  test("a reconnect drops Done cards deleted meanwhile and fills more than a page of newly finished ones", () => {
    const s = board(500);
    const p = new Page(s);
    p.reload();
    for (let i = 0; i < 5; i++) p.more();
    // While away (no events): 3 paged cards and 1 unpaged one deleted, 30 open tickets finished at the top, 1 moved out.
    for (const id of ["d0002", "d0050", "d0099", "d0300"]) server.del(s, id);
    for (let i = 0; i < 30; i++) s.push({ id: `n${String(i).padStart(2, "0")}`, title: "new", status: "done", order: -100 + i, createdAt: "2026-01-02" });
    server.set(s, "d0010", { status: "review" });
    p.reload();
    expect(p.held.some((t) => ["d0002", "d0050", "d0099"].includes(t.id))).toBe(false);
    expect(p.held.find((t) => t.id === "d0010")?.status).toBe("review");
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
    expect(p.unseen).toBe(0);
    noDoubles(p);
  });

  test("a reconnect after changes that cancel out in the count (1 deleted, 21 finished) still heals", () => {
    const s = board(400, 30);
    const p = new Page(s);
    p.reload();
    for (let i = 0; i < 4; i++) p.more();
    server.del(s, "d0050");
    for (let i = 0; i < 21; i++) server.set(s, `o${i}`, { status: "done", order: -1 - i });
    p.reload();
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
    noDoubles(p);
  });

  test("a reconnect after 1 deleted past page 1 and 1 dropped into the middle of Done heals", () => {
    const s = board(200, 5);
    const p = new Page(s);
    p.reload();
    for (let i = 0; i < 3; i++) p.more();
    server.del(s, "d0040");
    server.set(s, "o0", { status: "done", order: 30.5 });
    p.reload();
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
    noDoubles(p);
  });

  test("a held search find deleted while away goes on the next reload", () => {
    const s = board(300);
    const p = new Page(s);
    p.reload();
    for (let i = 0; i < 3; i++) p.more();
    p.held = mergeTickets(p.held, [structuredClone(s.find((t) => t.id === "d0250")!)]);
    p.extras.add("d0250");
    server.del(s, "d0250");
    p.reload();
    expect(p.held.some((t) => t.id === "d0250")).toBe(false);
  });

  test("a quiet reconnect asks for one page only, and an unchanged Done costs no second request", () => {
    const s = board(300);
    const p = new Page(s);
    p.reload();
    for (let i = 0; i < 6; i++) p.more();
    const n = p.requests;
    expect(reloadAsk(p.held, p.paged, p.extras).done).toBe(20);
    p.reload();
    expect(p.requests).toBe(n + 1);
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
  });

  test("an extra (search find) deep in Done stays held and isn't loaded twice", () => {
    const s = board(200);
    const p = new Page(s);
    p.reload();
    p.more();
    p.held = mergeTickets(p.held, [structuredClone(s.find((t) => t.id === "d0150")!)]);
    p.extras.add("d0150");
    p.reload();
    expect(p.held.some((t) => t.id === "d0150")).toBe(true);
    p.all();
    expect(p.doneIds()).toEqual(columnIds(s));
    noDoubles(p);
  });

  test("the server pages after the cursor, and by offset when the cursor's card left Done", () => {
    const s = board(60);
    expect(donePage(s, 0, 20, undefined, "d0019").tickets[0].id).toBe("d0020");
    expect(donePage(s, 20, 20, undefined, "gone").tickets[0].id).toBe("d0020");
    expect(donePage(s, 20).tickets[0].id).toBe("d0020");
  });

  test("the cursor is the last card that came by page, in the column's order", () => {
    const s = board(50);
    const held = s.filter((t) => ["d0000", "d0001", "d0002", "d0040"].includes(t.id));
    expect(doneCursor(held, new Set(["d0000", "d0001", "d0002"]))).toEqual({ after: "d0002", offset: 3 });
  });
});

test("a Done main ticket with a running step above the cursor doesn't make every reload a full one", () => {
  const s = board(100).map((t) => (t.id === "d0003" ? { ...t, main: true } : t)) as any[];
  const p = new Page(s);
  p.reload();
  for (let i = 0; i < 3; i++) p.more();
  // The page's copy carries the live run count (views()), the server's raw ticket doesn't.
  p.held = p.held.map((t: any) => (t.id === "d0003" ? { ...t, stepsRunning: 1 } : t));
  const n = p.requests;
  p.reload();
  expect(p.requests).toBe(n + 1);
});

test("a page worked out before a move, arriving after the move's live update, doesn't put the card back in Done", () => {
  const s = board(100).map((t) => ({ ...t, updatedAt: "2026-01-01T00:00:00.000Z" })) as (T & { updatedAt: string })[];
  const p = new Page(s);
  p.reload();
  p.more();
  // The next page is answered (a card on it still Done) ...
  const at = doneCursor(p.held, p.paged);
  const stale = donePage(structuredClone(s), at.offset, 20, undefined, at.after);
  const id = stale.tickets[5].id;
  expect(p.held.some((t) => t.id === id)).toBe(false);
  // ... then that card moves to Review and its live update arrives before that answer.
  const moved = { ...s.find((t) => t.id === id)!, status: "review", updatedAt: "2026-01-02T00:00:00.000Z" };
  s.splice(s.findIndex((t) => t.id === id), 1, moved);
  p.event(moved);
  for (const t of stale.tickets) p.paged.add(t.id);
  p.held = mergeTickets(p.held, stale.tickets);
  expect(p.held.find((t) => t.id === id)!.status).toBe("review");
  expect(p.doneIds()).not.toContain(id);
  // A reload's answer older than the held copy doesn't either; a newer one wins.
  const r = takeReload(p.held, [{ ...moved, status: "done", updatedAt: "2026-01-01T12:00:00.000Z" }], p.paged, p.extras, { done: 0, ids: [], full: false });
  expect(r.tickets.find((t) => t.id === id)!.status).toBe("review");
  const r2 = takeReload(p.held, [{ ...moved, status: "done", updatedAt: "2026-01-03T00:00:00.000Z" }], p.paged, p.extras, { done: 0, ids: [], full: false });
  expect(r2.tickets.find((t) => t.id === id)!.status).toBe("done");
});
