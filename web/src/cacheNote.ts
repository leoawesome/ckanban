/**
 * The ticket chat's old-chat line and Send ask (kept DOM-free for tests). The server sends the conversation size and
 * cache time at Claude's last reply (src/server/chat-cache.ts); this works out whether the chat is old and what to say.
 * Nothing shows while the chat is still ready: no countdown, so a reply never feels rushed.
 */
import { contextText } from "./huddleText";

export interface ChatCacheInfo {
  /** Chat size at Claude's last reply. */
  tokens: number;
  /** What an old chat re-reads at full price (all but the opening other chats keep cached). */
  coldTokens?: number;
  at: string;
  ttl: "1h" | "5m";
  /** With ttl "5m": the opening part still cached for 1 hour after the last reply (the chat switched mid-way); 0 or absent otherwise. */
  hourTokens?: number;
  /** When that 1-hour part was last written or hit: it stays ready until an hour after this. */
  hourAt?: string | null;
  model: string;
  costUsd: number;
}

/** Below this size re-reading is cheap, so the chat never counts as old. */
export const COLD_NOTE_MIN_TOKENS = 50_000;

export const TTL_MS = { "1h": 3600_000, "5m": 300_000 } as const;

export interface OldChat {
  /** Claude's last reply (cache.at): one ask per old period, keyed by it. */
  at: string;
  /** Input tokens the next message re-reads at full price. */
  tokens: number;
  /** The muted line in the message box's footer. */
  line: string;
  /** The same, short enough for a phone. */
  phoneLine: string;
  /** The ask shown when the user presses Send. */
  ask: string;
  /** Hover: why, and the list price. */
  title: string;
}

/** "169k tokens" (the same rounding as contextText's "169k chat size"). */
export const tokensText = (tokens: number) => contextText(tokens).replace(/ chat size$/, " tokens");

/** "$1.36", "under $0.01". */
export const costText = (usd: number) => (usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`);

/**
 * The chat is old: Claude replied longer ago than it keeps a chat ready, so the next message re-reads it (only the newer
 * part, within the hour, for a chat that switched from the 1-hour to the 5-minute cache). null
 * when not: no reply yet, a small chat, Claude working (the message steers it), or the next message starts a fresh chat.
 */
export function oldChat(i: { cache: ChatCacheInfo | null | undefined; running: boolean; freshSession?: boolean; now: number }): OldChat | null {
  const c = i.cache;
  if (!c || i.running || i.freshSession || c.tokens < COLD_NOTE_MIN_TOKENS) return null;
  const last = Date.parse(c.at);
  if (!Number.isFinite(last) || last + (TTL_MS[c.ttl] ?? TTL_MS["1h"]) > i.now) return null;
  const full = c.coldTokens ?? c.tokens;
  // A chat that switched to the 5-minute cache keeps its earlier part for 1 hour after that part was last written or
  // hit: within that hour only the newer part is re-read, so a small newer part needs no note at all.
  const hourAt = c.hourAt ? Date.parse(c.hourAt) : NaN;
  const hour = c.ttl === "5m" && (c.hourTokens ?? 0) > 0 && hourAt + TTL_MS["1h"] > i.now ? Math.min(c.hourTokens!, c.tokens) : 0;
  const cold = hour ? Math.min(full, c.tokens - hour) : full;
  if (hour && cold < COLD_NOTE_MIN_TOKENS) return null;
  const cost = full > 0 ? (c.costUsd * cold) / full : 0;
  const keep = hour ? `5 minutes (the first ${tokensText(hour)} for 1 hour)` : c.ttl === "5m" ? "5 minutes" : "1 hour";
  const size = tokensText(cold).replace(/ tokens$/, "");
  const shared = !hour && c.tokens - cold >= 1000 ? ` The first ${tokensText(c.tokens - cold)} (Claude Code's own instructions) are usually still ready from your other chats.` : "";
  return {
    at: c.at,
    tokens: cold,
    line: `Old chat · next message re-reads about ${size} input tokens`,
    phoneLine: `Old chat · ~${size} tokens to re-read`,
    ask: `Old chat: sending makes Claude re-read about ${size} input tokens.`,
    title: `Claude keeps a chat ready for ${keep} after its last reply; after that, the next message re-reads ${hour ? "the newer part of the chat" : "the whole chat"} (chat size ${tokensText(c.tokens)}).${shared} List price around ${costText(cost)}; on a Claude plan this counts against your usage instead.`,
  };
}
