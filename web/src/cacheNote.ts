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
  model: string;
  costUsd: number;
}

/** Below this size re-reading is cheap, so the chat never counts as old. */
export const COLD_NOTE_MIN_TOKENS = 50_000;

export const TTL_MS = { "1h": 3600_000, "5m": 300_000 } as const;

export interface OldChat {
  /** Claude's last reply (cache.at): one ask per old period, keyed by it. */
  at: string;
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
 * The chat is old: Claude replied longer ago than it keeps a chat ready, so the next message re-reads all of it. null
 * when not: no reply yet, a small chat, Claude working (the message steers it), or the next message starts a fresh chat.
 */
export function oldChat(i: { cache: ChatCacheInfo | null | undefined; running: boolean; freshSession?: boolean; now: number }): OldChat | null {
  const c = i.cache;
  if (!c || i.running || i.freshSession || c.tokens < COLD_NOTE_MIN_TOKENS) return null;
  const last = Date.parse(c.at);
  if (!Number.isFinite(last) || last + (TTL_MS[c.ttl] ?? TTL_MS["1h"]) > i.now) return null;
  const keep = c.ttl === "5m" ? "5 minutes" : "1 hour";
  const cold = c.coldTokens ?? c.tokens;
  const size = tokensText(cold).replace(/ tokens$/, "");
  const shared = c.tokens - cold >= 1000 ? ` The first ${tokensText(c.tokens - cold)} (Claude Code's own instructions) are usually still ready from your other chats.` : "";
  return {
    at: c.at,
    line: `Old chat · next message re-reads about ${size} input tokens`,
    phoneLine: `Old chat · ~${size} tokens to re-read`,
    ask: `Old chat: sending makes Claude re-read about ${size} input tokens.`,
    title: `Claude keeps a chat ready for ${keep} after its last reply; after that, the next message re-reads the whole chat (chat size ${tokensText(c.tokens)}).${shared} List price around ${costText(c.costUsd)}; on a Claude plan this counts against your usage instead.`,
  };
}
