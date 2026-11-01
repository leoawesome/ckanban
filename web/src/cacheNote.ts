/**
 * The ticket chat's note about how cold its Claude conversation is (kept DOM-free for tests). The server sends the
 * conversation size and cache time at Claude's last reply (src/server/chat-cache.ts); this works out what to show.
 */
import { contextText } from "./huddleText";

export interface ChatCacheInfo {
  /** Chat size at Claude's last reply. */
  tokens: number;
  /** What a cold chat re-reads at full price (all but the opening other chats keep cached). */
  coldTokens?: number;
  at: string;
  ttl: "1h" | "5m";
  model: string;
  costUsd: number;
}

/** Below this size re-reading is cheap, so no note. */
export const COLD_NOTE_MIN_TOKENS = 50_000;

export const TTL_MS = { "1h": 3600_000, "5m": 300_000 } as const;

export type CacheNote =
  | { kind: "warm"; minutesLeft: number; text: string; title: string }
  | { kind: "cold"; text: string; title: string };

/** "169k tokens" (the same rounding as contextText's "169k chat size"). */
export const tokensText = (tokens: number) => contextText(tokens).replace(/ chat size$/, " tokens");

/** "$1.36", "under $0.01". */
export const costText = (usd: number) => (usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`);

const LIST_PRICE = "List price; on a Claude plan this counts against your usage instead.";

/**
 * The note for the chat now; null when there is none: no reply yet, a small chat, Claude working (the cache is in use),
 * the next message starts a fresh chat, or the user hid this cold note (hiddenAt: the reply it was hidden for).
 */
export function cacheNote(i: {
  cache: ChatCacheInfo | null | undefined; running: boolean; freshSession?: boolean; hiddenAt?: string | null; now: number;
}): CacheNote | null {
  const c = i.cache;
  if (!c || i.running || i.freshSession || c.tokens < COLD_NOTE_MIN_TOKENS) return null;
  const last = Date.parse(c.at);
  if (!Number.isFinite(last)) return null;
  const ttl = TTL_MS[c.ttl] ?? TTL_MS["1h"];
  const left = last + ttl - i.now;
  const keep = c.ttl === "5m" ? "5 minutes" : "1 hour";
  const cold = c.coldTokens ?? c.tokens;
  const shared = c.tokens - cold >= 1000 ? ` The first ${tokensText(c.tokens - cold)} (Claude Code's own instructions) are usually still ready from your other chats.` : "";
  if (left > 0) {
    const minutesLeft = Math.max(1, Math.ceil(left / 60_000));
    return {
      kind: "warm", minutesLeft,
      text: `Chat ready for ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"}. Replying before then is cheap (${contextText(c.tokens)}).`,
      title: `Claude keeps this chat ready for ${keep} after its last reply. After that, the next message re-reads the whole chat: about ${tokensText(cold)}, around ${costText(c.costUsd)}.${shared} ${LIST_PRICE}`,
    };
  }
  if (i.hiddenAt && i.hiddenAt === c.at) return null;
  return {
    kind: "cold",
    text: `Your next message makes Claude re-read the whole chat: about ${tokensText(cold)}, around ${costText(c.costUsd)}. Claude only keeps a chat ready for ${keep} after its last reply.`,
    title: `${LIST_PRICE} Claude's prompt cache for this chat ran out; sending re-reads it at full price (chat size ${tokensText(c.tokens)}).${shared}`,
  };
}

/** When the note changes next (the warm countdown's next minute, or going cold); null when it won't change on its own. */
export function nextNoteChange(cache: ChatCacheInfo | null | undefined, now: number): number | null {
  if (!cache) return null;
  const end = Date.parse(cache.at) + (TTL_MS[cache.ttl] ?? TTL_MS["1h"]);
  if (!Number.isFinite(end) || end <= now) return null;
  const toMinute = (end - now) % 60_000 || 60_000;
  return now + Math.min(toMinute, end - now);
}

/** localStorage key for the reply a ticket's cold note was hidden for. */
export const coldNoteKey = (slug: string, ticketId: string) => `ckanban.coldNoteHidden.${slug}.${ticketId}`;
