import { expect, test } from "bun:test";
import type { Status } from "../web/src/columns";
import { boardColumnOf, columnNeighbours, columnOrder, dropOrder, groupByColumn, menuPick, regroupByColumn, STATUS_MENU } from "../web/src/columns";
import { opensNewTab } from "../web/src/links";

const tk = (id: string, status: Status, order: number, extra: { slotWait?: { at: string }; pinnedAt?: string | null } = {}) => ({ id, status, order, ...extra });

const board = [
  tk("b1", "backlog", 0), tk("p2", "planning", 1), tk("p1", "planning", 0), tk("p3", "planning", 2),
  tk("q1", "ready", 0), tk("r1", "in_progress", 0), tk("d1", "done", 0),
];

test("columnOrder lists one board column top to bottom; In Progress includes the queue", () => {
  expect(columnOrder(board, "planning")).toEqual(["p1", "p2", "p3"]);
  expect(columnOrder(board, "in_progress")).toEqual(["r1", "q1"]);
  expect(columnOrder(board, "review")).toEqual([]);
});

test("boardColumnOf puts queued tickets under In Progress", () => {
  expect(boardColumnOf(tk("q", "ready", 0))).toBe("in_progress");
  expect(boardColumnOf(tk("p", "planning", 0))).toBe("planning");
});

test("the status menu has no Queued entry; picking In Progress queues a ticket that isn't there yet", () => {
  expect(STATUS_MENU.map((c) => c.label)).toEqual(["Backlog", "Planning", "In Progress", "Review", "Done"]);
  expect(STATUS_MENU.find((c) => c.id === "in_progress")!.hint).toBe("Claude starts the work now, or as soon as a slot is free");
  expect(menuPick(tk("b", "backlog", 0), "in_progress")).toBe("ready");
  expect(menuPick(tk("q", "ready", 0), "in_progress")).toBe("ready");
  expect(menuPick(tk("r", "in_progress", 0), "in_progress")).toBe("in_progress");
  expect(menuPick(tk("r", "in_progress", 0), "review")).toBe("review");
});

test("columnNeighbours stays in the column and stops at its ends", () => {
  const order = columnOrder(board, "planning");
  expect(columnNeighbours(order, "planning", "p1", board)).toEqual({ prev: null, next: "p2" });
  expect(columnNeighbours(order, "planning", "p3", board)).toEqual({ prev: "p2", next: null });
});

test("columnNeighbours keeps the open ticket's place after it moves, and skips others that left", () => {
  const order = columnOrder(board, "planning");
  const moved = board.map((t) => (t.id === "p2" ? { ...t, status: "done" as Status } : t));
  expect(columnNeighbours(order, "planning", "p2", moved)).toEqual({ prev: "p1", next: "p3" });
  // Stepped on to p3: p2 is now in Done, so Prev skips it.
  expect(columnNeighbours(order, "planning", "p3", moved)).toEqual({ prev: "p1", next: null });
  const deleted = board.filter((t) => t.id !== "p2");
  expect(columnNeighbours(order, "planning", "p1", deleted)).toEqual({ prev: null, next: "p3" });
});

test("opensNewTab: every link but same-page hash links", () => {
  expect(opensNewTab("https://example.com")).toBe(true);
  expect(opensNewTab("/api/attachments/x.png")).toBe(true);
  expect(opensNewTab("mailto:a@b.c")).toBe(true);
  expect(opensNewTab("#/kanban/t_1")).toBe(false);
  expect(opensNewTab(null)).toBe(false);
  expect(opensNewTab("")).toBe(false);
});

const pins = [
  tk("r1", "review", 0), tk("r2", "review", 1), tk("old", "review", 5, { pinnedAt: "2026-11-10T10:00:00.000Z" }),
  tk("new", "review", 9, { pinnedAt: "2026-11-11T10:00:00.000Z" }), tk("r3", "review", 2, { pinnedAt: null }),
];

test("pinned cards come first in their column, newest pin first, then the usual order", () => {
  expect(columnOrder(pins, "review")).toEqual(["new", "old", "r1", "r2", "r3"]);
});

test("a pinned ticket that moves to another column shows at the top there among the pinned cards", () => {
  const moved = pins.map((t) => (t.id === "old" ? { ...t, status: "backlog" as Status } : t));
  const backlog = [...moved, tk("b1", "backlog", -3), tk("b2", "backlog", -2, { pinnedAt: "2026-11-09T00:00:00.000Z" })];
  expect(columnOrder(backlog, "backlog")).toEqual(["old", "b2", "b1"]);
  expect(columnOrder(backlog, "review")).toEqual(["new", "r1", "r2", "r3"]);
});

test("in the queue pinned cards come first, then replies waiting for a slot (oldest first), then order", () => {
  const q = [
    tk("q1", "ready", 0), tk("w2", "in_progress", 0, { slotWait: { at: "2026-11-11T02:00:00.000Z" } }),
    tk("w1", "in_progress", 0, { slotWait: { at: "2026-11-11T01:00:00.000Z" } }), tk("qp", "ready", 7, { pinnedAt: "2026-11-11T00:00:00.000Z" }),
  ];
  expect(groupByColumn(q).get("ready")!.map((t) => t.id)).toEqual(["qp", "w1", "w2", "q1"]);
});

test("columnNeighbours follows the pinned order", () => {
  const order = columnOrder(pins, "review");
  expect(columnNeighbours(order, "review", "old", pins)).toEqual({ prev: "new", next: "r1" });
  expect(columnNeighbours(order, "review", "r1", pins)).toEqual({ prev: "old", next: "r2" });
});

test("dropOrder: an unpinned card dropped onto the pinned cards lands at the top of the unpinned ones", () => {
  const list = groupByColumn(pins).get("review")!.filter((t) => t.id !== "r2");
  const r2 = pins.find((t) => t.id === "r2")!;
  // Dropped on "new" (index 0) or "old" (index 1): above r1 (order 0).
  expect(dropOrder(r2, "review", list, 0)).toBe(-1);
  expect(dropOrder(r2, "review", list, 1)).toBe(-1);
  // Between r1 (0) and r3 (2).
  expect(dropOrder(r2, "review", list, 3)).toBe(1);
  // At the end.
  expect(dropOrder(r2, "review", list, list.length)).toBe(3);
});

test("dropOrder: a pinned card keeps its pin place in its column, and goes on top of the unpinned cards in a new one", () => {
  const list = groupByColumn(pins).get("review")!.filter((t) => t.id !== "old");
  const old = pins.find((t) => t.id === "old")!;
  expect(dropOrder(old, "review", list, 3)).toBeNull();
  const backlog = [tk("b1", "backlog", 4), tk("b2", "backlog", 8)];
  expect(dropOrder(old, "backlog", backlog, 2)).toBe(3);
  expect(dropOrder(old, "done", [], 0)).toBe(1);
});

test("regroupByColumn keeps the lists of columns whose cards didn't change", () => {
  const first = regroupByColumn(board, null);
  const changed = board.map((t) => (t.id === "p1" ? { ...t } : t));
  const next = regroupByColumn(changed, first);
  expect(next.get("backlog")).toBe(first.get("backlog")!);
  expect(next.get("done")).toBe(first.get("done")!);
  expect(next.get("planning")).not.toBe(first.get("planning")!);
  expect(next.get("planning")!.map((t) => t.id)).toEqual(["p1", "p2", "p3"]);
});
