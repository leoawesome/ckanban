// Ticket families: "part of" links, the family tree and the New ticket feature choice.
// The server side (parent suggestions, linking over HTTP, get_family) is the Rust binary now and is tested there.
import { expect, test } from "bun:test";
import { familyNearby, newestFirst, partOfFor, familyOf, parentLink, wouldLoop, type FamilyTicket } from "./family";

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

test("newestFirst keeps the top ticket first and lists each ticket's children newest first", () => {
  const r = (id: string, depth: number) => ({ ticket: { id } as any, depth, how: null });
  const out = newestFirst([r("top", 0), r("a", 1), r("a1", 2), r("a2", 2), r("b", 1), r("c", 1), r("c1", 2)] as any);
  expect(out.map((x) => x.ticket.id)).toEqual(["top", "c", "c1", "b", "a", "a2", "a1"]);
});
