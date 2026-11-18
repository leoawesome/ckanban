import { expect, test } from "bun:test";
import { capMap, keepSame, laterCounts, sameDeps, sameJson } from "./chatMemo";
import { byIdOf, mainTicketOf } from "../family/family";

const e = (uuid: string, role = "assistant", kind = "text", text = uuid, extra: object = {}) => ({ uuid, role, kind, text, at: "", ...extra });

test("sameDeps compares in order with Object.is; null never matches", () => {
  const o = {};
  expect(sameDeps([1, "a", o, NaN], [1, "a", o, NaN])).toBe(true);
  expect(sameDeps([1, {}], [1, {}])).toBe(false);
  expect(sameDeps([1], [1, 2])).toBe(false);
  expect(sameDeps(null, null)).toBe(false);
});

test("sameJson: deep equality of parsed JSON", () => {
  expect(sameJson({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
  expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  expect(sameJson([1, 2], { 0: 1, 1: 2 })).toBe(false);
  expect(sameJson({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
});

test("keepSame keeps the objects of unchanged entries, and the old array when nothing changed", () => {
  const old = [e("a"), e("b"), e("c")];
  const same = JSON.parse(JSON.stringify(old));
  expect(keepSame(old, same)).toBe(old);
  // A changed entry and a new one: the others keep their objects.
  const fresh = JSON.parse(JSON.stringify([...old, e("d")]));
  fresh[1].text = "changed";
  const out = keepSame(old, fresh);
  expect(out).not.toBe(old);
  expect(out[0]).toBe(old[0]);
  expect(out[1]).toBe(fresh[1]);
  expect(out[2]).toBe(old[2]);
  expect(out[3]).toBe(fresh[3]);
  // A shorter tail (an entry left out) is a change.
  expect(keepSame(old, JSON.parse(JSON.stringify(old.slice(0, 2))))).toHaveLength(2);
  expect(keepSame([], fresh)).toBe(fresh);
});

test("laterCounts: text messages after each index and the last answering message, in one pass", () => {
  const list = [
    e("q", "assistant", "text"),
    e("t", "assistant", "tool"),
    e("u1", "user", "text"),
    e("h", "user", "text", "digest", { huddleId: "h1" }),
    e("c", "assistant", "text", "out", { commandOutput: true }),
    e("empty", "assistant", "text", ""),
    e("r", "assistant", "text"),
  ];
  const { textAfter, lastAnswer } = laterCounts(list);
  // The old code: entries.slice(i + 1).filter(text && !commandOutput).length
  const slow = list.map((_, i) => list.slice(i + 1).filter((x) => x.kind === "text" && !!x.text && !(x as { commandOutput?: boolean }).commandOutput).length);
  expect([...textAfter]).toEqual(slow);
  expect(lastAnswer).toBe(2);
  expect(laterCounts([]).lastAnswer).toBe(-1);
});

test("laterCounts: a key box isn't old after a later user message, only once a newer key box exists", () => {
  const box = (uuid: string) => e(uuid, "assistant", "text", "", { keys: { keys: [{ envName: "API_KEY" }] } });
  const list = [box("k1"), e("u1", "user", "text", "how do I get it?"), e("r1")];
  // KeysBox gets old = lastKeys > its index.
  expect(laterCounts(list).lastKeys > 0).toBe(false);
  expect(laterCounts(list).lastAnswer > 0).toBe(true);
  const { lastKeys } = laterCounts([...list, box("k2"), e("u2", "user")]);
  expect(lastKeys > 0).toBe(true);
  expect(lastKeys > 3).toBe(false);
  expect(laterCounts([]).lastKeys).toBe(-1);
});

test("capMap drops the oldest entries", () => {
  const m = new Map([[1, "a"], [2, "b"], [3, "c"]]);
  capMap(m, 2);
  expect([...m.keys()]).toEqual([2, 3]);
});

test("byIdOf builds one map per tickets list; mainTicketOf uses it", () => {
  const tickets = [
    { id: "m", title: "Main", status: "backlog", createdAt: "1", main: true },
    { id: "t", title: "Task", status: "backlog", createdAt: "2", partOf: "m" },
  ];
  expect(byIdOf(tickets)).toBe(byIdOf(tickets));
  expect(byIdOf(tickets).get("t")?.title).toBe("Task");
  expect(mainTicketOf(tickets, "t")?.id).toBe("m");
  expect(byIdOf([...tickets])).not.toBe(byIdOf(tickets));
});
