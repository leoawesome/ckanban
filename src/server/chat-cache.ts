import { contextTokens, priceFor } from "./ticket-usage";

// How cold a ticket's Claude conversation is. Claude keeps a conversation's prompt cache for 1 hour (subscription
// within plan usage) or 5 minutes (API key, usage credits, over the plan limit), restarted by every request that
// hits it. After that the next message re-reads the whole conversation as a cache write: 2x the input price for a
// 1-hour write, 1.25x for a 5-minute one (https://code.claude.com/docs/en/prompt-caching). The board shows this
// above the ticket chat's box (web/src/cacheNote.ts).

export type CacheTtl = "1h" | "5m";

/** The conversation's state at Claude's last reply; the web works out warm or cold from `at` and `ttl`. */
export interface ChatCache {
  /** Conversation size at the last reply: what the next message re-reads. */
  tokens: number;
  /**
   * The part of `tokens` a cold chat re-reads at full price: all but the opening (Claude Code's own instructions and
   * tools), which other Claude chats on the machine usually keep cached. Estimated as `tokens` minus what the
   * session's first reply found already cached.
   */
  coldTokens: number;
  /** When Claude last replied (the cache timer restarts then). */
  at: string;
  ttl: CacheTtl;
  /**
   * When `ttl` is "5m" but earlier replies wrote 1-hour cache (Claude Code switches once usage goes past the plan):
   * the opening part of `tokens` cached for 1 hour, which stays ready for an hour after `hourAt` while the rest goes
   * after 5 minutes. 0 otherwise.
   */
  hourTokens: number;
  /** When that 1-hour part was last written or hit: it stays ready until an hour after this. null with hourTokens 0. */
  hourAt: string | null;
  model: string;
  /** API list price of re-reading `coldTokens` once the cache is gone (a cache write at the TTL's rate). */
  costUsd: number;
}

/** What a cache write of `tokens` costs at list price, for the model and cache time. */
export function coldCost(model: string, tokens: number, ttl: CacheTtl): number {
  return (tokens * priceFor(model).input * (ttl === "1h" ? 2 : 1.25)) / 1e6;
}

/** How far back (in content blocks) Claude looks for an earlier cache entry. */
export const LOOKBACK_BLOCKS = 20;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Reads assistant events in transcript order; `result()` gives the state at the last one with usage. */
export class ChatCacheTracker {
  private last: { tokens: number; at: string; model: string } | null = null;
  private ttl: CacheTtl | null = null;
  /** Cache read on the session's first reply: the opening shared with other chats (null until a reply is seen). */
  private shared: number | null = null;
  /** Cached prefix size at the last reply that wrote 1-hour cache, and when that cache entry was last written or hit. */
  private hour = 0;
  private hourAt = "";
  /** Content blocks added to the conversation since that 1-hour write. */
  private hourBlocks = 0;

  /** One main-conversation user or assistant event from the transcript, in order (subagents' sidechains are not passed in). */
  add(ev: any): void {
    const content = ev?.message?.content;
    this.hourBlocks += Array.isArray(content) ? content.length : content ? 1 : 0;
    if (ev?.type !== "assistant") return;
    const usage = ev?.message?.usage;
    const model = ev?.message?.model;
    // Synthetic messages (errors, limit notices) carry no real usage.
    if (!usage || typeof model !== "string" || model === "<synthetic>") return;
    const tokens = contextTokens(usage);
    if (!tokens) return;
    this.shared ??= num(usage.cache_read_input_tokens);
    const split = usage.cache_creation;
    if (split && typeof split === "object") {
      if (num(split.ephemeral_5m_input_tokens) > 0) this.ttl = "5m";
      else if (num(split.ephemeral_1h_input_tokens) > 0) this.ttl = "1h";
    }
    const at = typeof ev.timestamp === "string" ? ev.timestamp : "";
    const w1h = split && typeof split === "object" ? num(split.ephemeral_1h_input_tokens) : 0;
    // A cache entry's timer restarts only when it is written or is the one a request hits (its longest match): a
    // request that hits a longer 5-minute entry beyond it doesn't keep the 1-hour part alive.
    const prefix = num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    if (w1h > 0) [this.hour, this.hourAt, this.hourBlocks] = [num(usage.cache_read_input_tokens) + w1h, at, 0];
    else if (prefix < this.hour) this.hour = 0; // compacted: the old 1-hour part is no longer the chat's opening
    else if (this.hour && num(usage.cache_read_input_tokens) === this.hour) this.hourAt = at;
    this.last = { tokens, at: typeof ev.timestamp === "string" ? ev.timestamp : this.last?.at ?? "", model };
  }

  result(): ChatCache | null {
    if (!this.last?.at) return null;
    // Unknown (no cache write seen): Claude Code's default for the main conversation on a subscription.
    const ttl = this.ttl ?? "1h";
    const coldTokens = Math.max(0, this.last.tokens - Math.min(this.shared ?? 0, this.last.tokens));
    // Claude finds an older cache entry only by looking back up to 20 content blocks from the end of the request
    // (Anthropic's prompt caching docs), so a 1-hour part further back is out of
    // reach even while it is still cached. Replayed transcripts agree: kept up to 21 blocks, lost from 22 on.
    const hourAt = ttl === "5m" && this.hour > 0 && this.hourAt && this.hourBlocks <= LOOKBACK_BLOCKS ? this.hourAt : null;
    const hourTokens = hourAt ? Math.min(this.hour, this.last.tokens) : 0;
    return { ...this.last, coldTokens, ttl, hourTokens, hourAt, costUsd: coldCost(this.last.model, coldTokens, ttl) };
  }
}

const TTL_MS: Record<CacheTtl, number> = { "1h": 3600_000, "5m": 300_000 };

/** The chat has gone cold: Claude last replied longer ago than it keeps the chat ready (the web's rule, cacheNote.ts). */
export function chatIsCold(c: Pick<ChatCache, "at" | "ttl">, now: number): boolean {
  const at = Date.parse(c.at);
  return Number.isFinite(at) && now - at > (TTL_MS[c.ttl] ?? TTL_MS["1h"]);
}

/** Board setting freshChatTokens's default: a cold main or feature chat bigger than this starts its next turn fresh. */
export const FRESH_CHAT_TOKENS = 150_000;
