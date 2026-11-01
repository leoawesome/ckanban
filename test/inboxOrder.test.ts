import { expect, test } from "bun:test";
import { groupInbox, OLDER_MS } from "../web/src/inboxOrder";

type AttentionKind = Parameters<typeof groupInbox>[0][number]["attention"]["kind"];
interface InboxItem { profile: string; profileName: string; id: string; title: string; attention: { kind: AttentionKind; label: string; since: string } }

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR = 3600_000;
const item = (id: string, kind: AttentionKind, agoMs: number): InboxItem => ({
  profile: "demo", profileName: "Demo", id, title: id,
  attention: { kind, label: kind, since: new Date(NOW - agoMs).toISOString() },
});
const ids = (l: InboxItem[]) => l.map((i) => i.id);

test("a fresh question leads, above old review items", () => {
  const g = groupInbox([
    item("review-22d", "review", 22 * 24 * HOUR),
    item("review-16d", "review", 16 * 24 * HOUR),
    item("review-3d", "review", 3 * 24 * HOUR),
    item("question-now", "questions", 60_000),
  ], NOW);
  expect(ids(g.waiting)).toEqual(["question-now"]);
  expect(ids(g.check)).toEqual(["review-3d"]);
  expect(ids(g.older)).toEqual(["review-16d", "review-22d"]);
});

test("waiting kinds go first, review and reply are ready to check", () => {
  const kinds: AttentionKind[] = ["questions", "blocked", "proposal", "failed", "stalled", "limit", "huddle", "review", "reply"];
  const g = groupInbox(kinds.map((k, n) => item(k, k, (n + 1) * HOUR)), NOW);
  expect(ids(g.waiting)).toEqual(["questions", "blocked", "proposal", "failed", "stalled", "limit", "huddle"]);
  expect(ids(g.check)).toEqual(["review", "reply"]);
  expect(g.older).toEqual([]);
});

test("each group is newest first", () => {
  const g = groupInbox([
    item("b-5h", "blocked", 5 * HOUR), item("q-1h", "questions", HOUR), item("f-2d", "failed", 2 * 24 * HOUR),
    item("r-6d", "review", 6 * 24 * HOUR), item("r-1h", "review", HOUR), item("reply-3h", "reply", 3 * HOUR),
  ], NOW);
  expect(ids(g.waiting)).toEqual(["q-1h", "b-5h", "f-2d"]);
  expect(ids(g.check)).toEqual(["r-1h", "reply-3h", "r-6d"]);
});

test("over a week folds into Older: waiting ones first, then newest first", () => {
  const g = groupInbox([
    item("r-8d", "review", 8 * 24 * HOUR), item("q-30d", "questions", 30 * 24 * HOUR),
    item("r-20d", "review", 20 * 24 * HOUR), item("edge", "review", OLDER_MS), item("q-9d", "blocked", 9 * 24 * HOUR),
  ], NOW);
  expect(ids(g.older)).toEqual(["q-9d", "q-30d", "r-8d", "r-20d"]);
  // Exactly a week is not older yet.
  expect(ids(g.check)).toEqual(["edge"]);
});

test("the input list is left as it was", () => {
  const list = [item("a", "review", HOUR), item("b", "questions", 2 * HOUR)];
  groupInbox(list, NOW);
  expect(ids(list)).toEqual(["a", "b"]);
});
