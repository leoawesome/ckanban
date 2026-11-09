import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageStore } from "../src/server/helper/messages";
import { groupByDay, isHeldLine, levelLabel, levelTone, messageHash, messagesRoute, sendTrail, type Message } from "../web/src/helperText";

const msg = (over: Partial<Message>): Message => ({
  id: "m_1", at: "2026-11-09T14:10:00", level: "urgent", oneLine: "Stop the old webhook?", text: "full", why: null, items: [], sends: [], readAt: null, ...over,
});

test("message pages live under #/~messages, apart from board slugs", () => {
  expect(messagesRoute("#/~messages")).toEqual({ id: null });
  expect(messagesRoute("#/~messages/")).toEqual({ id: null });
  expect(messagesRoute("#/~messages/m_abc")).toEqual({ id: "m_abc" });
  expect(messagesRoute(messageHash("m a/b"))).toEqual({ id: "m a/b" });
  expect(messagesRoute("#/kanban")).toBeNull();
  expect(messagesRoute("#/kanban/t_1")).toBeNull();
  expect(messagesRoute("#/~messagesx")).toBeNull();
  expect(messagesRoute("")).toBeNull();
});

test("history groups newest first by day: Today, Yesterday, then dates", () => {
  const now = new Date(2026, 10, 9, 15, 0).getTime();
  const list = [
    msg({ id: "a", at: new Date(2026, 10, 9, 14, 30).toISOString() }),
    msg({ id: "b", at: new Date(2026, 10, 9, 9, 2).toISOString() }),
    msg({ id: "c", at: new Date(2026, 10, 8, 16, 0).toISOString() }),
    msg({ id: "d", at: new Date(2026, 10, 3, 8, 0).toISOString() }),
  ];
  const g = groupByDay(list, now);
  expect(g.map((x) => x.day).slice(0, 2)).toEqual(["Today", "Yesterday"]);
  expect(g.map((x) => x.messages.map((m) => m.id))).toEqual([["a", "b"], ["c"], ["d"]]);
});

test("badges name each kind of message in plain words", () => {
  expect(levelLabel("urgent")).toBe("Urgent");
  expect(levelLabel("summary")).toBe("Summary");
  expect(levelLabel("hello")).toBe("Hello");
  expect(levelLabel("summary", true)).toBe("Kept quiet");
  expect(levelTone("reminder")).toBe("urgent");
  expect(levelTone("digest")).toBe("sum");
  expect(levelTone("urgent", true)).toBe("warn");
});

test("the trail lists each channel and when it was opened, without repeats", () => {
  const m = msg({
    sends: [
      { channel: "push", at: "2026-11-09T14:10:00", ok: true, devices: 1 },
      { channel: "telegram", at: "2026-11-09T14:15:00", ok: false, error: "x" },
    ],
    readAt: "2026-11-09T14:17:00",
  });
  const t = sendTrail(m);
  expect(t).toMatch(/^Phone .+ · Telegram .+ \(failed\) · opened .+$/);
  expect(t).not.toMatch(/push|webhook/);
});

test("Should have pinged me only on items the helper held for a summary", () => {
  expect(isHeldLine("Held for the 16:00 summary: small text change")).toBe(true);
  expect(isHeldLine("In the 16:00 summary: small text change")).toBe(true);
  // A told item's line has no colon after "summary": it went out, so no "Should have pinged me".
  expect(isHeldLine("In the 16:00 summary")).toBe(false);
  expect(isHeldLine("Urgent: Phone 14:10, Telegram 14:15")).toBe(false);
  expect(isHeldLine("With the helper: it looks within a minute or two")).toBe(false);
  expect(isHeldLine(undefined)).toBe(false);
});

test("the message store reports the unread count when a message is added or read (live Messages, N new)", () => {
  const root = mkdtempSync(join(tmpdir(), "ck-msgs-"));
  const seen: number[] = [];
  const s = new MessageStore(root, Date.now, (n) => seen.push(n));
  const a = s.add({ level: "summary", oneLine: "2 wait", text: "2 wait" });
  s.add({ level: "summary", oneLine: "held", text: "held", held: true });
  s.markRead(a.id);
  s.markRead(a.id); // already read: no news
  expect(seen).toEqual([1, 1, 0]);
});

test("helper screens use plain words: no watcher agent, no webhook outside the JSON option", () => {
  for (const f of ["Messages.tsx", "Inbox.tsx", "NowView.tsx", "helper.ts"]) {
    const src = readFileSync(join(import.meta.dir, "../web/src", f), "utf8");
    expect(src).not.toMatch(/watcher/i);
  }
  const settings = readFileSync(join(import.meta.dir, "../web/src/NotificationsDialog.tsx"), "utf8");
  // Text the user reads (between > and <, or in quotes after label=/title=/placeholder=) never says webhook.
  const shown = [...settings.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]).join(" ");
  expect(shown).not.toMatch(/webhook|watcher/i);
});
