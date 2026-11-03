import { expect, test } from "bun:test";
import { ChatCacheTracker, coldCost } from "../src/server/chat-cache";
import { parseSession } from "../src/server/session";
import { priceFor } from "../src/server/ticket-usage";
import { COLD_NOTE_MIN_TOKENS, costText, oldChat, tokensText, type ChatCacheInfo } from "../web/src/cacheNote";

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
  expect(t.result()).toMatchObject({ ttl: "5m", hourTokens: 40_000, hourAt: "2026-11-01T09:10:00Z" }); // its read hit the 1-hour part, restarting its timer
});

const user = (n = 1) => ({ type: "user", message: { role: "user", content: Array.from({ length: n }, () => ({ type: "tool_result", content: "x" })) } });

test("tracker: the 1-hour part only counts while it is within Claude's 20-block look-back", () => {
  const t = new ChatCacheTracker();
  t.add(assistant("2026-11-01T09:00:00Z", usage1h(0, 300_000)));
  t.add(user(9));
  t.add(assistant("2026-11-01T09:01:00Z", usage5m(300_000, 5_000)));
  expect(t.result()).toMatchObject({ hourTokens: 300_000 }); // 10 blocks since the 1-hour write
  t.add(user(10));
  t.add(assistant("2026-11-01T09:02:00Z", usage5m(305_000, 5_000)));
  expect(t.result()).toMatchObject({ hourTokens: 0, hourAt: null }); // 21 blocks: out of reach
});

test("tracker: chats with one cache time have no 1-hour part; compacting drops it", () => {
  const h = new ChatCacheTracker();
  h.add(assistant("2026-11-01T09:00:00Z", usage1h(0, 100_000)));
  h.add(assistant("2026-11-01T09:01:00Z", usage1h(100_000, 5_000)));
  expect(h.result()).toMatchObject({ ttl: "1h", hourTokens: 0, hourAt: null });
  const f = new ChatCacheTracker();
  f.add(assistant("2026-11-01T09:00:00Z", usage5m(0, 100_000)));
  expect(f.result()).toMatchObject({ ttl: "5m", hourTokens: 0, hourAt: null });
  const c = new ChatCacheTracker();
  c.add(assistant("2026-11-01T09:00:00Z", usage1h(0, 200_000)));
  c.add(assistant("2026-11-01T09:01:00Z", usage5m(10_000, 20_000)));
  expect(c.result()).toMatchObject({ hourTokens: 0 });
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

test("oldChat: nothing while Claude still has the chat ready, no countdown", () => {
  expect(oldChat({ cache: info(), running: false, now: T0 + 20 * min })).toBeNull();
  expect(oldChat({ cache: info(), running: false, now: T0 + 59 * min + 59_000 })).toBeNull();
});

test("oldChat: after 1 hour, input tokens in the line and the ask; money only in the hover", () => {
  const n = oldChat({ cache: info(), running: false, now: T0 + 3 * 60 * min })!;
  expect(n.at).toBe(info().at);
  expect(n.line).toBe("Old chat · next message re-reads about 169k input tokens");
  expect(n.phoneLine).toBe("Old chat · ~169k tokens to re-read");
  expect(n.ask).toBe("Old chat: sending makes Claude re-read about 169k input tokens.");
  for (const t of [n.line, n.phoneLine, n.ask]) expect(t).not.toContain("$");
  expect(n.title).toContain("ready for 1 hour after its last reply");
  expect(n.title).toContain("List price around $1.35; on a Claude plan this counts against your usage instead.");
  expect(oldChat({ cache: info(), running: false, now: T0 + 60 * min })).not.toBeNull();
});

test("oldChat: counts only what is re-read at full price; the hover gives the chat size", () => {
  const c = info({ tokens: 83_245, coldTokens: 66_779, costUsd: coldCost("claude-opus-5-5", 66_779, "1h") });
  const n = oldChat({ cache: c, running: false, now: T0 + 3 * 60 * min })!;
  expect(n.line).toEndWith("about 67k input tokens");
  expect(n.title).toContain("chat size 83k tokens");
  expect(n.title).toContain("The first 16k tokens (Claude Code's own instructions) are usually still ready from your other chats.");
  expect(n.title).toContain("around $0.53");
});

test("oldChat: 5-minute chats are old after 5 minutes and say so", () => {
  const c = info({ ttl: "5m", costUsd: coldCost("claude-opus-5-5", 169_000, "5m") });
  expect(oldChat({ cache: c, running: false, now: T0 + 2 * min })).toBeNull();
  const n = oldChat({ cache: c, running: false, now: T0 + 6 * min })!;
  expect(n.title).toContain("ready for 5 minutes after its last reply");
  expect(n.title).toContain("around $0.84");
});

test("oldChat: never below 50k tokens, while Claude works, before a fresh chat, or without a reply", () => {
  const late = T0 + 3 * 60 * min;
  expect(oldChat({ cache: info({ tokens: COLD_NOTE_MIN_TOKENS - 1 }), running: false, now: late })).toBeNull();
  expect(oldChat({ cache: info({ tokens: COLD_NOTE_MIN_TOKENS }), running: false, now: late })).not.toBeNull();
  expect(oldChat({ cache: info(), running: true, now: late })).toBeNull();
  expect(oldChat({ cache: info(), running: false, freshSession: true, now: late })).toBeNull();
  expect(oldChat({ cache: null, running: false, now: late })).toBeNull();
  expect(oldChat({ cache: info({ at: "" }), running: false, now: late })).toBeNull();
});

// Re-read size at gaps of 3, 20 and 90 minutes, for each kind of chat (tracker plus note, as the board runs them).
function reread(build: (t: ChatCacheTracker) => void, gapMin: number): number {
  const t = new ChatCacheTracker();
  build(t);
  const c = t.result()!;
  return oldChat({ cache: c, running: false, now: Date.parse(c.at) + gapMin * min })?.tokens ?? 0;
}

test("oldChat: re-read sizes for 1-hour, 5-minute and switched chats at 3, 20 and 90 minutes", () => {
  const only1h = (t: ChatCacheTracker) => { t.add(assistant("2026-11-01T09:00:00Z", usage1h(10_000, 190_000, 0))); t.add(assistant("2026-11-01T09:10:00Z", usage1h(200_000, 30_000, 0))); };
  const only5m = (t: ChatCacheTracker) => { t.add(assistant("2026-11-01T09:00:00Z", usage5m(10_000, 190_000, 0))); t.add(assistant("2026-11-01T09:10:00Z", usage5m(200_000, 30_000, 0))); };
  const switched = (t: ChatCacheTracker) => { t.add(assistant("2026-11-01T09:00:00Z", usage1h(10_000, 190_000, 0))); t.add(user(3)); t.add(assistant("2026-11-01T09:10:00Z", usage5m(200_000, 80_000, 0))); };
  // 1 hour only: ready for an hour, then all but the 10k opening.
  expect([3, 20, 90].map((g) => reread(only1h, g))).toEqual([0, 0, 220_000]);
  // 5 minutes only: all but the opening after 5 minutes.
  expect([3, 20, 90].map((g) => reread(only5m, g))).toEqual([0, 220_000, 220_000]);
  // Switched: within the hour only the 80k written after the 1-hour part; after it, all but the opening.
  expect([3, 20, 90].map((g) => reread(switched, g))).toEqual([0, 80_000, 270_000]);
  // Small newer part: no note within the hour.
  const smallTail = (t: ChatCacheTracker) => { t.add(assistant("2026-11-01T09:00:00Z", usage1h(10_000, 190_000, 0))); t.add(assistant("2026-11-01T09:10:00Z", usage5m(200_000, 20_000, 0))); };
  expect([3, 20, 90].map((g) => reread(smallTail, g))).toEqual([0, 0, 210_000]);
});

test("oldChat: a switched chat's hover names both cache times and prices only the newer part", () => {
  const t = new ChatCacheTracker();
  t.add(assistant("2026-11-01T09:00:00Z", usage1h(10_000, 190_000, 0)));
  t.add(assistant("2026-11-01T09:10:00Z", usage5m(200_000, 80_000, 0)));
  const c = t.result()!;
  const n = oldChat({ cache: c, running: false, now: Date.parse(c.at) + 20 * min })!;
  expect(n.line).toBe("Old chat · next message re-reads about 80k input tokens");
  expect(n.title).toContain("ready for 5 minutes (the first 200k tokens for 1 hour) after its last reply");
  expect(n.title).toContain("re-reads the newer part of the chat (chat size 280k tokens)");
  expect(n.title).toContain(`around ${costText(coldCost("claude-opus-5-5", 80_000, "5m"))}`);
});

test("text helpers: token and cost wording", () => {
  expect(tokensText(168_700)).toBe("169k tokens");
  expect(tokensText(1_200_000)).toBe("1.2M tokens");
  expect(costText(1.3524)).toBe("$1.35");
  expect(costText(0.001)).toBe("under $0.01");
});
