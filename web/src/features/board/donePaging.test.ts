// The Done column pages by a cursor: cards leaving, joining or being deleted between pages, a failed move and a
// reconnect leave no gaps and no doubles. A small model of App.tsx's paging (same helpers) against a copy of the server's scopes.
import { describe, expect, test } from "bun:test";
import { groupByColumn } from "./columns";
import { onBoard, parentLink, type FamilyTicket } from "../family/family";
import { doneCursor, doneDrifted, doneIdsHash, doneNotDrawn, heldDoneColumn, heldDoneHead, mergeTickets, reloadAsk, takeReload, unseenDone } from "./donePaging";

// The server is the Rust binary now. This is a copy of the Bun server's Done scopes (src/board/ticket-scope.ts:
// the first load, the Done column and its pages) as the model the page is paged against.
type Scoped = FamilyTicket & { status: string; order: number; pinnedAt?: string | null; tool?: boolean; showOnBoard?: boolean | null };

function familyKeys<S extends Scoped>(tickets: S[]): Map<string, string> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  for (const t of tickets) {
    if (out.has(t.id)) continue;
    const path: S[] = [];
    const seen = new Set<string>();
    let cur: S = t;
    let root: string;
    for (;;) {
      const hit = out.get(cur.id);
      if (hit) { root = hit; break; }
      path.push(cur);
      seen.add(cur.id);
      const l = parentLink(cur);
      const up = l && l.id !== cur.id ? byId.get(l.id) : undefined;
      if (!up || seen.has(up.id)) { root = cur.id; break; }
      cur = up;
    }
    for (const p of path) out.set(p.id, root);
  }
  return out;
}

function doneColumn<S extends Scoped>(tickets: S[]): S[] {
  return groupByColumn(tickets.filter((t) => t.status === "done" && onBoard(t)) as (S & { status: "done" })[]).get("done") ?? [];
}

function boardScope<S extends Scoped>(tickets: S[], opts: { done?: number; ids?: string[]; after?: string | null } = {}): { tickets: S[]; doneTotal: number; doneHead?: string | null } {
  const keys = familyKeys(tickets);
  const column = doneColumn(tickets);
  const head = opts.after ? column.findIndex((t) => t.id === opts.after) : -1;
  const doneHead = !opts.after ? undefined : head < 0 ? null : doneIdsHash(column.slice(0, head + 1).map((t) => t.id));
  const ids = new Set(opts.ids ?? []);
  const families = new Set<string>();
  for (const t of tickets) if (t.status !== "done" || ids.has(t.id)) families.add(keys.get(t.id) ?? t.id);
  const picked = new Set(tickets.filter((t) => families.has(keys.get(t.id) ?? t.id)));
  for (const t of column.slice(0, Math.max(0, opts.done ?? 0))) picked.add(t);
  return { tickets: tickets.filter((t) => picked.has(t)), doneTotal: column.length, ...(doneHead === undefined ? {} : { doneHead }) };
}

function donePage<S extends Scoped>(tickets: S[], offset: number, limit = 20, column = doneColumn(tickets), after?: string | null): { tickets: S[]; doneTotal: number } {
  const at = after ? column.findIndex((t) => t.id === after) : -1;
  const from = at >= 0 ? at + 1 : Math.max(0, Math.floor(offset) || 0);
  return { tickets: column.slice(from, from + Math.max(1, Math.min(limit, 200))), doneTotal: column.length };
}

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

// The fattinterior board: an open run step (Review) brings its whole family to the first load, the main ticket and its
// finished runs, whose orders sit all through Done. Drawn among a partial column they showed above cards not loaded yet.
test("Done draws exactly the top of its column, and each page only adds below, with a family of open work held", () => {
  const s = board(70, 0) as any[];
  s.push({ id: "zbno", title: "Rednote scheduled runs", status: "done", order: -155, createdAt: "2026-01-01", main: true });
  for (const [id, order] of [["r1", 4.5], ["r2", 18.5], ["r3", 33.5], ["r4", 51.5], ["r5", 66.5]] as const) {
    s.push({ id, title: `Rednote run ${id}`, status: "done", order, createdAt: "2026-01-01", partOf: "zbno" });
  }
  s.push({ id: "open-run", title: "Rednote run (open)", status: "review", order: -10, createdAt: "2026-01-01", parentId: "zbno", tool: true });
  const full = doneColumn(structuredClone(s)).map((t) => t.id);
  const p = new Page(s);
  p.reload();
  const drawn = () => {
    const wait = p.unseen > 0 ? doneNotDrawn(p.held, p.paged) : new Set<string>();
    return p.doneIds().filter((id) => !wait.has(id));
  };
  // The cause: the first load holds the family's finished runs from deep in Done.
  expect(p.doneIds()).toEqual(["zbno", "r1", "r2", "r3", "r4", "r5"]);
  expect(drawn()).toEqual([]);
  let before: string[] = [];
  while (p.more()) {
    const now = drawn();
    expect(now).toEqual(full.slice(0, now.length));
    expect(now.slice(0, before.length)).toEqual(before);
    expect(now.length).toBeGreaterThan(before.length);
    before = now;
  }
  expect(drawn()).toEqual(full);
});

test("a Done main ticket with a running step below the cursor still shows (in In progress)", () => {
  const held = [{ id: "a", status: "done", order: 1 }, { id: "b", status: "done", order: 2, main: true, stepsRunning: 1 }, { id: "c", status: "done", order: 3 }] as any[];
  expect([...doneNotDrawn(held, new Set(["a"]))]).toEqual(["c"]);
});
