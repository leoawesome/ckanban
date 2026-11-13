import { describe, expect, test } from "bun:test";
import { inTab, nearOf, needsShown, needsYouIds, neighboursIn, pageOf, rowLines, stepTab, toRow, type StoredMessage } from "../src/server/helper/messages";
import {
  appendRows, entryLines, foldByDay, foldRows, loadingMoreLine, messageHash, MESSAGES_HASH, pageQuery, prependRows, rowIcon, type MessageRow,
} from "../web/src/helperText";
import { backToBoard, backToList, marker, openFromList, settleMessagesEntry, stepTo, swipeCloses, swipeIntent, type Hist } from "../web/src/msgNav";

const T0 = Date.parse("2026-11-13T12:00:00Z");
const at = (min: number) => new Date(T0 - min * 60_000).toISOString();

/** Stored messages, oldest first, one a minute; newest() gives them newest first as listNewest does. */
function store(n: number, over: (i: number) => Partial<StoredMessage> = () => ({})): StoredMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m_${String(i).padStart(3, "0")}`, at: at(n - i), level: "direct", oneLine: `Ready for review: T${i}`, text: "x".repeat(2000), why: null,
    items: [{ key: `b/t${i}|review`, board: "b", boardName: "B", ticketId: `t${i}`, title: `T${i}`, question: "Ready for review" }],
    sends: [{ channel: "push", at: at(n - i), ok: true }], readAt: at(0), ...over(i),
  } as StoredMessage));
}
const newest = (l: StoredMessage[]) => l.slice().reverse();
const none = new Set<string>();

describe("the list API: pages and cursor", () => {
  test("pages of 30 walk the whole list once, in order, and stop with hasMore false", () => {
    const list = newest(store(280));
    const seen: string[] = [];
    let before: StoredMessage | null = null;
    let pages = 0;
    for (;;) {
      const p = pageOf(list, { tab: "all", limit: 30, before: before && { at: before.at, id: before.id } }, none);
      seen.push(...p.rows.map((r) => r.id));
      pages++;
      if (!p.hasMore) break;
      before = p.rows.at(-1)!;
    }
    expect(pages).toBe(10);
    expect(seen).toEqual(list.map((m) => m.id));
  });

  test("a cursor whose row was trimmed away still continues by its time", () => {
    const list = newest(store(10));
    // Half a minute older than list[3]: list[4] and older follow it, list[0..3] are newer.
    const gone = { at: new Date(Date.parse(list[3].at) - 30_000).toISOString(), id: "m_gone" };
    expect(pageOf(list, { tab: "all", limit: 3, before: gone }, none).rows.map((r) => r.id)).toEqual([list[4].id, list[5].id, list[6].id]);
    expect(pageOf(list, { tab: "all", limit: 30, after: gone }, none).rows.map((r) => r.id)).toEqual(list.slice(0, 4).map((m) => m.id));
  });

  test("after: only what is newer than the top row shown", () => {
    const list = newest(store(40));
    const top = list[5];
    const p = pageOf(list, { tab: "all", limit: 100, after: { at: top.at, id: top.id } }, none);
    expect(p.rows.map((r) => r.id)).toEqual(list.slice(0, 5).map((m) => m.id));
    expect(p.hasMore).toBe(false);
    expect(pageOf(list, { tab: "all", limit: 2, after: { at: top.at, id: top.id } }, none).hasMore).toBe(true);
  });

  test("rows are light: about 280 realistic messages make a first page well under 30 KB", () => {
    const list = newest(store(280));
    const p = pageOf(list, { tab: "all", limit: 30 }, none);
    const body = JSON.stringify({ rows: p.rows.map((m) => toRow(m, none)), hasMore: p.hasMore, needs: 0, unread: 0 });
    expect(p.rows).toHaveLength(30);
    expect(body.length).toBeLessThan(30_000);
    expect(JSON.stringify(list).length).toBeGreaterThan(500_000);
    const row = toRow(list[0], none) as any;
    expect(row.text).toBeUndefined();
    expect(row.sends).toBeUndefined();
    expect(row.items).toBeUndefined();
  });
});

describe("tabs", () => {
  const list = newest([
    ...store(1, () => ({ id: "sum", level: "summary", oneLine: "6 new for you: Developer API search question" })),
    ...store(1, () => ({ id: "held", level: "routine", held: true, oneLine: "Kept quiet: 3 tickets" })),
    ...store(1, () => ({ id: "unread", readAt: null })),
    ...store(1, () => ({ id: "plain" })),
  ]);
  test("All leaves out held rows; Summaries and Kept quiet take their own; Needs you takes the ids it is given", () => {
    const needs = new Set(["unread"]);
    const ids = (tab: any) => list.filter((m) => inTab(m, tab, needs)).map((m) => m.id);
    expect(ids("all")).toEqual(["plain", "unread", "sum"]);
    expect(ids("summaries")).toEqual(["sum"]);
    expect(ids("quiet")).toEqual(["held"]);
    expect(ids("needs")).toEqual(["unread"]);
  });

  test("Needs you: unread, or an open wait no newer message names; tapped, held and practice ones don't count", () => {
    const l = newest([
      ...store(1, () => ({ id: "old", items: [{ key: "w1", board: "b", boardName: "B", ticketId: "t", title: "T", question: "" }] })),
      ...store(1, () => ({ id: "new", items: [{ key: "w1", board: "b", boardName: "B", ticketId: "t", title: "T", question: "" }] })),
      ...store(1, () => ({ id: "tapped", tapped: { how: "got-it", at: at(0) }, items: [{ key: "w2", board: "b", boardName: "B", ticketId: "t", title: "T", question: "" }] })),
      ...store(1, () => ({ id: "closed", items: [{ key: "w3", board: "b", boardName: "B", ticketId: "t", title: "T", question: "" }] })),
      ...store(1, () => ({ id: "held", held: true, readAt: null })),
      ...store(1, () => ({ id: "practice", practice: true, readAt: null })),
      ...store(1, () => ({
        id: "sum", level: "summary", items: [{ key: "w4", board: "b", boardName: "B", ticketId: "t", title: "T", question: "" }],
        summary: { new: [], still: [{ key: "w4", board: "b", boardName: "B", ticketId: "t", title: "T", label: "" }], stillCount: 1, oldestAt: null, checkins: [], olderCheckins: 0, notes: [], grouped: false },
      })),
      ...store(1, () => ({ id: "unread", readAt: null, items: [] })),
    ]);
    const open = new Set(["w1", "w2", "w4"]);
    const ids = needsYouIds(l, (k) => (open.has(k) ? k : null));
    expect([...ids].sort()).toEqual(["new", "unread"]);
  });

  test("a message page walks its list's tab, by place in the whole list even when it left the tab", () => {
    const l = newest(store(6, (i) => (i % 2 ? { held: true, level: "routine" } : {})));
    // ids newest first: m_005(h) m_004 m_003(h) m_002 m_001(h) m_000
    expect(neighboursIn(l, "m_002", "all", none)).toEqual({ newer: "m_004", older: "m_000" });
    expect(neighboursIn(l, "m_003", "quiet", none)).toEqual({ newer: "m_005", older: "m_001" });
    // Needs you: the opened one was just read and left it; its neighbours still come from its place.
    expect(neighboursIn(l, "m_002", "needs", new Set(["m_004", "m_000"]))).toEqual({ newer: "m_004", older: "m_000" });
    expect(stepTab(l.find((m) => m.id === "m_003")!, "all", none)).toBe("quiet");
    expect(stepTab(l.find((m) => m.id === "m_002")!, "quiet", none)).toBe("all");
    expect(stepTab(l.find((m) => m.id === "m_002")!, "needs", none)).toBe("needs");
    expect(stepTab(l.find((m) => m.id === "m_002")!, "summaries", none)).toBe("all");
  });

  test("Needs you: after reading as it steps down, it still steps back up (keep: the ids the tab showed)", () => {
    const l = newest(store(6, (i) => (i === 4 ? { held: true, level: "routine" } : {})));
    // ids newest first: m_005 m_004(h) m_003 m_002 m_001 m_000; m_005, m_003, m_002 and m_000 needed you when the list opened.
    const shown = ["m_005", "m_003", "m_002", "m_000"];
    const needs = new Set(shown);
    let keep = shown.join(",");
    const near = (id: string) => nearOf(l, l.find((m) => m.id === id)!, "needs", needs, keep);
    // Open the top one, then step down twice; each is read (leaves the tab) as it opens.
    let at = "m_005";
    for (const next of ["m_003", "m_002"]) {
      needs.delete(at);
      expect(near(at).older).toBe(next);
      at = next;
    }
    needs.delete(at);
    expect(near("m_002")).toEqual({ tab: "needs", newer: "m_003", older: "m_000" });
    expect(near("m_003")).toEqual({ tab: "needs", newer: "m_005", older: "m_002" });
    // Without keep it was stuck: nothing newer once those were read.
    keep = "";
    expect(near("m_002").newer).toBeNull();
    // keep never brings a held message (or another tab's) in, and is capped.
    expect(nearOf(l, l.find((m) => m.id === "m_003")!, "needs", new Set(), "m_004,m_005").newer).toBe("m_005");
    expect(nearOf(l, l.find((m) => m.id === "m_003")!, "all", new Set(), "m_005")).toEqual({ tab: "all", newer: "m_005", older: "m_002" });
  });

  test("the Needs you badge counts a pause and its missed message once, as the tab folds them", () => {
    const l = newest(store(5, (i) => (i === 1 ? { level: "pause" } : i === 2 ? { level: "fallback" } : {})));
    const all = new Set(l.map((m) => m.id));
    expect(needsShown(l, all)).toBe(4);
    // Not next to each other in the tab (something between): two rows.
    const far = newest(store(3, (i) => (i === 0 ? { level: "pause" } : i === 2 ? { level: "fallback", at: new Date(T0 - 3 * 3600_000).toISOString() } : {})));
    expect(needsShown(far, new Set(far.map((m) => m.id)))).toBe(3);
    expect(needsShown(l, new Set())).toBe(0);
  });

  test("a row never shows raw ticket ids: titles, else how many tickets on which boards", () => {
    const it = (ticketId: string, title: string, boardName = "rocketbots") => ({ key: null, board: "rb", boardName, ticketId, title, question: "" });
    const kept = { level: "routine" as const, held: true, oneLine: "Kept quiet: 2 tickets, nothing urgent." };
    expect(rowLines({ ...kept, items: [it("t_20261105_ytb0", "t_20261105_ytb0"), it("t_20261113_sabc", "t_20261113_sabc")] }).sub).toBe("2 tickets on rocketbots");
    expect(rowLines({ ...kept, items: [it("t_20261105_ytb0", "t_20261105_ytb0"), it("t_2", "Chrome issue", "kanban")] }).sub).toBe("Chrome issue");
    expect(rowLines({ ...kept, items: [it("t_1", "t_1"), it("t_2", "", "kanban")] }).sub).toBe("2 tickets on rocketbots and kanban");
    expect(rowLines({ level: "direct", oneLine: "Ready for review: t_20261105_ytb0", items: [it("t_20261105_ytb0", "t_20261105_ytb0")] }).sub).toBe("1 ticket on rocketbots");
  });

  test("a row's two lines", () => {
    const item = (title: string) => [{ key: null, board: "b", boardName: "B", ticketId: "t", title, question: "" }];
    expect(rowLines({ level: "direct", oneLine: "Ready for review: Squads list", items: item("Squads list") })).toEqual({ title: "Ready for review", sub: "Squads list" });
    expect(rowLines({ level: "summary", oneLine: "6 new for you: Developer API search", items: [] })).toEqual({ title: "6 new for you", sub: "Developer API search" });
    expect(rowLines({ level: "pause", oneLine: "The helper can't run right now: you get each wait directly", items: [] }).title).toBe("Helper paused");
    expect(rowLines({ level: "urgent", oneLine: "Billing twice", items: item("Watcher") })).toEqual({ title: "Billing twice", sub: "Watcher" });
  });
});

describe("folding", () => {
  const row = (id: string, min: number, over: Partial<MessageRow> = {}): MessageRow => ({
    id, at: at(min), level: "direct", oneLine: "", title: "Ready for review", sub: `T ${id}`, readAt: at(0), ...over,
  });

  test("a pause and its missed waits within a minute and a half become one row; further apart they stay two", () => {
    const e = foldRows([row("p", 10, { level: "pause", title: "Helper paused", sub: "It can't run" }), row("f", 10.5, { level: "fallback", title: "4 tickets wait on you" }), row("s", 30, { level: "summary" })]);
    expect(e.map((x) => x.kind)).toEqual(["pair", "one"]);
    expect(entryLines(e[0])).toEqual({ title: "Helper paused · 4 tickets wait on you", sub: "It can't run" });
    expect(rowIcon(e[0])).toEqual({ tone: "warn", glyph: "!" });
    expect(foldRows([row("p", 10, { level: "pause" }), row("f", 15, { level: "fallback" })]).map((x) => x.kind)).toEqual(["one", "one"]);
  });

  test("runs of two or more updates fold into N updates; one alone stays; held rows never fold", () => {
    const e = foldRows([row("a", 1), row("b", 2), row("c", 3), row("s", 4, { level: "summary" }), row("d", 5), row("h1", 6, { held: true, level: "routine" }), row("h2", 7, { held: true, level: "routine" })]);
    expect(e.map((x) => x.kind)).toEqual(["group", "one", "one", "one", "one"]);
    expect(entryLines(e[0])).toEqual({ title: "3 updates", sub: "T a, T b, T c" });
    expect(rowIcon(e[0]).glyph).toBe("3");
  });

  test("folding runs over everything loaded, so a run crossing a page boundary is one group; days split it", () => {
    const page1 = [row("a", 1), row("b", 2)];
    const page2 = [row("c", 3), row("d", 4)];
    const now = T0;
    expect(foldByDay(appendRows(page1, page2), now)[0].entries.map((x) => x.kind)).toEqual(["group"]);
    const yesterday = row("y", 60 * 30);
    const days = foldByDay([row("a", 1), yesterday], now);
    expect(days.length).toBe(2);
    expect(days.every((d) => d.entries[0].kind === "one")).toBe(true);
    expect(loadingMoreLine(row("a", 1), now)).toBe("Loading more of today…");
  });

  test("new rows go on top once; pages below add only rows not shown", () => {
    const l = [row("b", 2), row("c", 3)];
    expect(prependRows(l, [row("a", 1), row("b", 2, { readAt: null })]).map((r) => [r.id, !!r.readAt])).toEqual([["a", true], ["b", false], ["c", true]]);
    expect(appendRows(l, [row("c", 3), row("d", 4)]).map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(pageQuery("needs", { before: row("c", 3) })).toBe(`tab=needs&limit=30&beforeAt=${encodeURIComponent(at(3))}&beforeId=c`);
  });
});

/** A pretend browser history: entries with a hash and state; back() moves down one. */
function fakeHistory(first: string) {
  const entries: { hash: string; state: unknown }[] = [{ hash: first, state: null }];
  let i = 0;
  const h: Hist & { hash: () => string; entries: typeof entries; go: (hash: string) => string } = {
    get state() { return entries[i].state; },
    get length() { return entries.length; },
    replaceState: (state, _u, url) => { entries[i] = { hash: url, state }; },
    pushState: (state, _u, url) => { entries.splice(i + 1); entries.push({ hash: url, state }); i++; },
    back: () => { if (i > 0) i--; },
    hash: () => entries[i].hash,
    entries,
    // location.hash = x: a new entry with no state, then the app's hashchange handler.
    go: (hash) => { const prev = entries[i].hash; h.pushState(null, "", hash); settleMessagesEntry(h, hash, prev, "#/kanban"); return h.hash(); },
  };
  return h;
}

describe("going back from a message", () => {
  test("opened from the list, then Back: the list; Back again: the board", () => {
    const h = fakeHistory("#/kanban");
    h.go(MESSAGES_HASH);
    expect(marker(h.state)).toBe("list");
    openFromList(h, "m1");
    settleMessagesEntry(h, h.hash(), MESSAGES_HASH, "#/kanban");
    expect(h.length).toBe(3);
    h.back();
    expect(h.hash()).toBe(MESSAGES_HASH);
    h.back();
    expect(h.hash()).toBe("#/kanban");
  });

  test("a fresh load of a message (a notification, a link) gets the list and the board under it", () => {
    const h = fakeHistory(messageHash("m1"));
    settleMessagesEntry(h, h.hash(), null, "#/kanban");
    expect(h.entries.map((e) => e.hash)).toEqual(["#/kanban", MESSAGES_HASH, messageHash("m1")]);
    // A reload of that page changes nothing.
    settleMessagesEntry(h, h.hash(), null, "#/kanban");
    expect(h.length).toBe(3);
    expect(backToList(h)).toBe("back");
    expect(h.hash()).toBe(MESSAGES_HASH);
    expect(backToBoard(h, "#/kanban")).toBe("back");
    expect(h.hash()).toBe("#/kanban");
  });

  test("a toast or the Now tab on the board: the list goes between the board and the message", () => {
    const h = fakeHistory("#/kanban");
    h.go(messageHash("m1"));
    expect(h.entries.map((e) => e.hash)).toEqual(["#/kanban", MESSAGES_HASH, messageHash("m1")]);
    h.back();
    expect(h.hash()).toBe(MESSAGES_HASH);
  });

  test("a toast's Open while on the list adds no second list", () => {
    const h = fakeHistory("#/kanban");
    h.go(MESSAGES_HASH);
    h.go(messageHash("m9"));
    expect(h.entries.map((e) => e.hash)).toEqual(["#/kanban", MESSAGES_HASH, messageHash("m9")]);
  });

  test("next twice, then Back once: the list", () => {
    const h = fakeHistory("#/kanban");
    h.go(MESSAGES_HASH);
    openFromList(h, "m1");
    stepTo(h, "m2");
    stepTo(h, "m3");
    expect(h.hash()).toBe(messageHash("m3"));
    expect(h.length).toBe(3);
    h.back();
    expect(h.hash()).toBe(MESSAGES_HASH);
  });

  test("✉ 1 new (or any link) from a message page to the list: ‹ Board and Back land on the board", () => {
    const h = fakeHistory("#/kanban");
    h.go(MESSAGES_HASH);
    openFromList(h, "m1");
    settleMessagesEntry(h, h.hash(), MESSAGES_HASH, "#/kanban");
    h.go(MESSAGES_HASH);
    expect(marker(h.state)).toBe("list");
    expect(backToBoard(h, "#/kanban")).toBe("back");
    expect(h.hash()).toBe("#/kanban");
    // The phone's back gesture from that list: the board too.
    h.go(MESSAGES_HASH);
    openFromList(h, "m1");
    h.go(MESSAGES_HASH);
    h.back();
    expect(h.hash()).toBe("#/kanban");
  });

  test("a link from one message page to another: Back lands on the list, then the board", () => {
    const h = fakeHistory("#/kanban");
    h.go(MESSAGES_HASH);
    openFromList(h, "m1");
    h.go(messageHash("m2"));
    expect(backToList(h)).toBe("back");
    expect(h.hash()).toBe(MESSAGES_HASH);
    expect(backToBoard(h, "#/kanban")).toBe("back");
    expect(h.hash()).toBe("#/kanban");
  });

  test("the page's own back on an entry from before (no marker) puts the list in place", () => {
    const h = fakeHistory(messageHash("m1"));
    expect(backToList(h)).toBe("replace");
    expect(h.hash()).toBe(MESSAGES_HASH);
    const b = fakeHistory(MESSAGES_HASH);
    expect(backToBoard(b, "#/kanban")).toBe("replace");
    expect(b.hash()).toBe("#/kanban");
  });

  test("the sideways swipe: mostly sideways to the right only, and far or quick enough", () => {
    expect(swipeIntent(4, 3)).toBeNull();
    expect(swipeIntent(30, 5)).toBe("back");
    expect(swipeIntent(-30, 5)).toBe("scroll");
    expect(swipeIntent(20, 15)).toBe("scroll");
    expect(swipeIntent(2, 40)).toBe("scroll");
    expect(swipeCloses(100, 600)).toBe(true);
    expect(swipeCloses(50, 120)).toBe(true);
    expect(swipeCloses(50, 400)).toBe(false);
  });
});
