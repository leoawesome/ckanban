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
  model: string;
  /** API list price of re-reading `coldTokens` once the cache is gone (a cache write at the TTL's rate). */
  costUsd: number;
}

/** What a cache write of `tokens` costs at list price, for the model and cache time. */
export function coldCost(model: string, tokens: number, ttl: CacheTtl): number {
  return (tokens * priceFor(model).input * (ttl === "1h" ? 2 : 1.25)) / 1e6;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Reads assistant events in transcript order; `result()` gives the state at the last one with usage. */
export class ChatCacheTracker {
  private last: { tokens: number; at: string; model: string } | null = null;
  private ttl: CacheTtl | null = null;
  /** Cache read on the session's first reply: the opening shared with other chats (null until a reply is seen). */
  private shared: number | null = null;

  /** One main-conversation assistant event from the transcript (subagents' sidechains are not passed in). */
  add(ev: any): void {
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
    this.last = { tokens, at: typeof ev.timestamp === "string" ? ev.timestamp : this.last?.at ?? "", model };
  }

  result(): ChatCache | null {
    if (!this.last?.at) return null;
    // Unknown (no cache write seen): Claude Code's default for the main conversation on a subscription.
    const ttl = this.ttl ?? "1h";
    const coldTokens = Math.max(0, this.last.tokens - Math.min(this.shared ?? 0, this.last.tokens));
    return { ...this.last, coldTokens, ttl, costUsd: coldCost(this.last.model, coldTokens, ttl) };
  }
}
