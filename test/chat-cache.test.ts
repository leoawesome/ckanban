import { expect, test } from "bun:test";
import { ChatCacheTracker, coldCost } from "../src/server/chat-cache";
import { parseSession } from "../src/server/session";
import { priceFor } from "../src/server/ticket-usage";
import { cacheNote, coldNoteKey, COLD_NOTE_MIN_TOKENS, costText, nextNoteChange, tokensText, type ChatCacheInfo } from "../web/src/cacheNote";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const min = 60_000;

const assistant = (at: string, usage: any, model = "claude-opus-5-5", extra: any = {}) => ({
  type: "assistant", timestamp: at, uuid: `a-${at}`, message: { model, role: "assistant", content: [{ type: "text", text: "ok" }], usage }, ...extra,
});
const usage1h = (read: number, write: number, input = 3) =>
  ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 } });
const usage5m = (read: number, write: number, input = 3) =>
  ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: write } });

const info = (x: Partial<ChatCacheInfo> = {}): ChatCacheInfo =>
  ({ tokens: 169_000, at: new Date(T0).toISOString(), ttl: "1h", model: "claude-opus-5-5", costUsd: coldCost("claude-opus-5-5", 169_000, "1h"), ...x });

// ---------- cost ----------

test("coldCost: a cache write at 2x input (1 hour) or 1.25x (5 minutes), from priceFor", () => {
  const p = priceFor("claude-opus-5-5").input;
  expect(coldCost("claude-opus-5-5", 169_000, "1h")).toBeCloseTo((169_000 * p * 2) / 1e6, 10);
  expect(coldCost("claude-opus-5-5", 169_000, "5m")).toBeCloseTo((169_000 * p * 1.25) / 1e6, 10);
  expect(coldCost("claude-opus-5-5", 169_000, "1h")).toBeCloseTo(1.352, 3);
  const s = priceFor("claude-sonnet-5-5").input;
  expect(coldCost("claude-sonnet-5-5[1m]", 100_000, "1h")).toBeCloseTo((100_000 * s * 2) / 1e6, 10);
});

// ---------- server: reading the transcript ----------

test("tracker: size, time and model of the last reply; cache time from the latest cache write", () => {
  const t = new ChatCacheTracker();
  expect(t.result()).toBeNull();
  t.add(assistant("2026-11-01T09:00:00Z", usage5m(0, 40_000)));
  t.add(assistant("2026-11-01T09:10:00Z", usage1h(40_000, 20_000)));
  // A reply that only read the cache keeps the latest cache-write choice.
  t.add(assistant("2026-11-01T09:20:00Z", { input_tokens: 5, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0, output_tokens: 9 }));
  const r = t.result()!;
  expect(r).toMatchObject({ tokens: 60_005, coldTokens: 60_005, at: "2026-11-01T09:20:00Z", ttl: "1h", model: "claude-opus-5-5" });
  expect(r.costUsd).toBeCloseTo(coldCost("claude-opus-5-5", 60_005, "1h"), 10);
});

test("tracker: the opening the first reply found cached (shared with other chats) isn't counted as a full-price re-read", () => {
  // Numbers from a real ticket: its first reply read 16,466 cached tokens (Claude Code's own instructions), the last
  // reply was 83,245 tokens; resumed cold, Claude wrote 69,175 at full price and read the same 16,466 from cache.
  const t = new ChatCacheTracker();
  t.add(assistant("2026-11-01T09:12:18Z", usage1h(16_466, 36_968, 2)));
  t.add(assistant("2026-11-01T09:25:18Z", usage1h(82_936, 307, 2)));
  const r = t.result()!;
  expect(r).toMatchObject({ tokens: 83_245, coldTokens: 66_779 });
  expect(Math.abs(r.coldTokens - 69_175) / 69_175).toBeLessThan(0.1);
  expect(r.costUsd).toBeCloseTo(coldCost("claude-opus-5-5", 66_779, "1h"), 10);
});

test("tracker: a session that switched to the 5-minute cache uses the latest choice", () => {
  const t = new ChatCacheTracker();
  t.add(assistant("2026-11-01T09:00:00Z", usage1h(0, 40_000)));
  t.add(assistant("2026-11-01T09:10:00Z", usage5m(40_000, 10_000)));
  expect(t.result()!.ttl).toBe("5m");
});

test("tracker: unknown cache time counts as 1 hour; synthetic and usage-less messages are skipped", () => {
  const t = new ChatCacheTracker();
  t.add(assistant("2026-11-01T09:00:00Z", { input_tokens: 10, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 500 }));
  t.add(assistant("2026-11-01T09:30:00Z", { input_tokens: 0, output_tokens: 0 }, "<synthetic>"));
  t.add({ type: "assistant", timestamp: "2026-11-01T09:40:00Z", message: { model: "claude-opus-5-5", content: [] } });
  expect(t.result()).toMatchObject({ tokens: 70_510, at: "2026-11-01T09:00:00Z", ttl: "1h" });
});

test("parseSession: cache comes from the main conversation, not subagents' sidechains", () => {
  const lines = [
    { type: "user", timestamp: "2026-11-01T08:59:00Z", uuid: "u1", message: { role: "user", content: "hi" } },
    assistant("2026-11-01T09:00:00Z", usage1h(80_000, 2_000)),
    assistant("2026-11-01T09:05:00Z", usage5m(1_000, 3_000), "claude-haiku-4-5", { isSidechain: true }),
  ];
  const p = parseSession(lines.map((l) => JSON.stringify(l)).join("\n"));
  expect(p.cache).toMatchObject({ tokens: 82_003, coldTokens: 2_003, at: "2026-11-01T09:00:00Z", ttl: "1h", model: "claude-opus-5-5" });
  expect(parseSession("").cache).toBeNull();
});

// ---------- web: the note ----------

test("cacheNote: warm, counting down by the minute, with the chat size", () => {
  const n = cacheNote({ cache: info(), running: false, now: T0 + 20 * min })!;
  expect(n.kind).toBe("warm");
  expect(n.text).toBe("Chat ready for 40 more minutes. Replying before then is cheap (169k chat size).");
  expect(n.title).toContain("List price; on a Claude plan this counts against your usage instead");
  expect(cacheNote({ cache: info(), running: false, now: T0 + 59 * min + 30_000 })).toMatchObject({ kind: "warm", minutesLeft: 1 });
  expect(cacheNote({ cache: info(), running: false, now: T0 + 59 * min + 30_000 })!.text).toStartWith("Chat ready for 1 more minute.");
});

test("cacheNote: cold after 1 hour, with tokens, cost and the cache time", () => {
  const n = cacheNote({ cache: info(), running: false, now: T0 + 3 * 60 * min })!;
  expect(n.kind).toBe("cold");
  expect(n.text).toBe("Your next message makes Claude re-read the whole chat: about 169k tokens, around $1.35. Claude only keeps a chat ready for 1 hour after its last reply.");
  expect(n.title).toStartWith("List price; on a Claude plan this counts against your usage instead.");
  expect(cacheNote({ cache: info(), running: false, now: T0 + 60 * min })!.kind).toBe("cold");
});

test("cacheNote: the cold note counts only what is re-read at full price; the hover gives the chat size", () => {
  const c = info({ tokens: 83_245, coldTokens: 66_779, costUsd: coldCost("claude-opus-5-5", 66_779, "1h") });
  const n = cacheNote({ cache: c, running: false, now: T0 + 3 * 60 * min })!;
  expect(n.text).toContain("about 67k tokens, around $0.53.");
  expect(n.title).toContain("chat size 83k tokens");
  expect(n.title).toContain("The first 16k tokens (Claude Code's own instructions) are usually still ready from your other chats.");
  // The warm note still shows the chat size, and the size limit uses it too.
  expect(cacheNote({ cache: c, running: false, now: T0 + 10 * min })!.text).toContain("(83k chat size)");
  expect(cacheNote({ cache: { ...c, tokens: 55_000, coldTokens: 40_000 }, running: false, now: T0 + 3 * 60 * min })?.kind).toBe("cold");
});

test("cacheNote: 5-minute chats go cold after 5 minutes and say so", () => {
  const c = info({ ttl: "5m", costUsd: coldCost("claude-opus-5-5", 169_000, "5m") });
  expect(cacheNote({ cache: c, running: false, now: T0 + 2 * min })).toMatchObject({ kind: "warm", minutesLeft: 3 });
  const cold = cacheNote({ cache: c, running: false, now: T0 + 6 * min })!;
  expect(cold.kind).toBe("cold");
  expect(cold.text).toContain("around $0.84");
  expect(cold.text).toEndWith("ready for 5 minutes after its last reply.");
});

test("cacheNote: nothing below 50k tokens, while Claude works, before a fresh chat, or without a reply", () => {
  const late = T0 + 3 * 60 * min;
  expect(cacheNote({ cache: info({ tokens: COLD_NOTE_MIN_TOKENS - 1 }), running: false, now: late })).toBeNull();
  expect(cacheNote({ cache: info({ tokens: COLD_NOTE_MIN_TOKENS }), running: false, now: late })?.kind).toBe("cold");
  expect(cacheNote({ cache: info({ tokens: COLD_NOTE_MIN_TOKENS - 1 }), running: false, now: T0 })).toBeNull();
  expect(cacheNote({ cache: info(), running: true, now: late })).toBeNull();
  expect(cacheNote({ cache: info(), running: false, freshSession: true, now: late })).toBeNull();
  expect(cacheNote({ cache: null, running: false, now: late })).toBeNull();
  expect(cacheNote({ cache: info({ at: "" }), running: false, now: late })).toBeNull();
});

test("cacheNote: hidden cold note stays hidden until Claude replies again", () => {
  const late = T0 + 3 * 60 * min;
  const c = info();
  expect(cacheNote({ cache: c, running: false, hiddenAt: c.at, now: late })).toBeNull();
  // A newer reply brings it back once that one goes cold too.
  const newer = info({ at: new Date(T0 + 60 * min).toISOString() });
  expect(cacheNote({ cache: newer, running: false, hiddenAt: c.at, now: T0 + 3 * 60 * min })?.kind).toBe("cold");
  // Hiding doesn't touch the warm note.
  expect(cacheNote({ cache: c, running: false, hiddenAt: c.at, now: T0 + 10 * min })?.kind).toBe("warm");
  expect(coldNoteKey("kanban", "t_1")).toBe("ckanban.coldNoteHidden.kanban.t_1");
});

test("nextNoteChange: the next countdown minute, then the moment it goes cold, then nothing", () => {
  expect(nextNoteChange(info(), T0 + 20 * min + 15_000)).toBe(T0 + 21 * min);
  expect(nextNoteChange(info(), T0 + 59 * min + 40_000)).toBe(T0 + 60 * min);
  expect(nextNoteChange(info(), T0 + 61 * min)).toBeNull();
  expect(nextNoteChange(null, T0)).toBeNull();
});

test("text helpers: token and cost wording", () => {
  expect(tokensText(168_700)).toBe("169k tokens");
  expect(tokensText(1_200_000)).toBe("1.2M tokens");
  expect(costText(1.3524)).toBe("$1.35");
  expect(costText(0.001)).toBe("under $0.01");
});
