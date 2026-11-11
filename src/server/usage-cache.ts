import { readFileSync } from "node:fs";
import { atomicWrite } from "./store";
import { RATE_LIMITED, type UsageAnswer, type UsageResult, type UsageWindow } from "./usage";

/**
 * What the board serves for Claude plan usage: the last good numbers, with the latest error next to them
 * when a later check failed (`stale`), or the error alone when there were never any numbers.
 */
export type UsageView =
  | {
    windows: UsageWindow[];
    fetchedAt: string;
    /** A later check failed; these are the last good numbers. */
    stale?: true;
    error?: string;
    /** The failed check was a 429 (Anthropic limits how often usage can be checked). */
    limited?: true;
    /** No check before this time (backing off after a 429). */
    retryAt?: string;
  }
  | { error: string; fetchedAt: string; limited?: true; retryAt?: string };

/** A good answer is reused this long by every caller (page opens, ticket Usage tabs). */
export const GOOD_TTL_MS = 4 * 60_000;
/** Never ask Anthropic more often than this, Refresh included. */
export const MIN_GAP_MS = 60_000;
/** Waits after 1, 2, 3, 4+ 429s in a row when Anthropic sends no retry-after. */
export const BACKOFF_MS = [60_000, 2 * 60_000, 4 * 60_000, 10 * 60_000];
/** A retry-after longer than this is capped (a bad header must not hide usage for hours). */
const MAX_RETRY_AFTER_MS = 30 * 60_000;
/** A usage check (keychain read + request) that takes longer than this counts as failed, so nobody waits on it. */
export const FETCH_TIMEOUT_MS = 10_000;

interface Saved {
  last: UsageAnswer | null;
  lastError: { error: string; at: number; limited: boolean } | null;
  attemptAt: number;
  blockedUntil: number;
  failures: number;
}

/** Saved times past `now` + the longest wait come from a clock set back; they must not block checks. */
function load(file: string | undefined, now: number): Saved | null {
  if (!file) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    const last = j?.last && Array.isArray(j.last.windows) && typeof j.last.fetchedAt === "string" ? j.last as UsageAnswer : null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const e = j?.lastError;
    const lastError = e && typeof e.error === "string" && typeof e.at === "number" ? { error: e.error, at: e.at, limited: !!e.limited } : null;
    const attemptAt = n(j?.attemptAt) > now ? now : n(j?.attemptAt);
    const blockedUntil = Math.min(n(j?.blockedUntil), now + MAX_RETRY_AFTER_MS);
    return { last, lastError, attemptAt, blockedUntil, failures: n(j?.failures) };
  } catch {
    return null;
  }
}

/**
 * Shares the usage endpoint between the header pill, the phone box and ticket views. The endpoint rate-limits, so:
 * one request in flight for everyone, a good answer reused for GOOD_TTL_MS, at most one call a minute (Refresh too),
 * a growing wait after a 429 (retry-after when sent), and the last good answer kept, and saved to `file`, through errors.
 */
export class UsageCache {
  private last: UsageAnswer | null = null;
  private lastError: { error: string; at: number; limited: boolean } | null = null;
  private attemptAt = 0;
  private blockedUntil = 0;
  private failures = 0;
  private inflight: Promise<UsageView> | null = null;
  /** Times of the calls to Anthropic in the last hour, for the log line. */
  private calls: number[] = [];

  constructor(
    private fetcher: () => Promise<UsageResult>,
    private onResult: (r: UsageResult) => void = () => {},
    private now = Date.now,
    private file?: string,
    private log: (line: string) => void = () => {},
    private timeoutMs = FETCH_TIMEOUT_MS,
  ) {
    const saved = load(file, now());
    if (saved) Object.assign(this, saved);
  }

  /** Cached usage; `fresh` (the Refresh button) asks now unless a call went out in the last minute or we are backing off. */
  async get(opts: { fresh?: boolean } = {}): Promise<UsageView> {
    if (this.inflight) return this.inflight;
    const now = this.now();
    if (now < this.blockedUntil || now - this.attemptAt < MIN_GAP_MS) return this.view();
    const goodAge = this.last ? now - Date.parse(this.last.fetchedAt) : Infinity;
    const failedSince = this.lastError && this.lastError.at >= this.attemptAt;
    if (!opts.fresh && goodAge < GOOD_TTL_MS && !failedSince) return this.view();
    this.attemptAt = now;
    const started = now;
    this.inflight = withTimeout(this.fetcher(), this.timeoutMs)
      .catch((e): UsageResult => ({ error: (e as Error)?.message || "Usage check failed", fetchedAt: new Date(this.now()).toISOString() }))
      .then((r) => {
        this.settle(r, started);
        try {
          this.onResult(r);
        } catch {}
        return this.view();
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private settle(r: UsageResult, started: number): void {
    const now = this.now();
    this.calls = [...this.calls.filter((t) => now - t < 3600_000), started];
    if ("windows" in r) {
      this.last = { windows: r.windows, fetchedAt: r.fetchedAt };
      this.lastError = null;
      this.failures = 0;
      this.blockedUntil = 0;
    } else {
      const limited = r.status === 429;
      this.lastError = { error: r.error, at: now, limited };
      if (limited) {
        this.failures++;
        // retry-after can lengthen the growing wait, never shorten it.
        const step = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1];
        const wait = Math.min(Math.max(r.retryAfterMs ?? 0, step), MAX_RETRY_AFTER_MS);
        this.blockedUntil = now + wait;
      } else {
        this.failures = 0;
        this.blockedUntil = 0;
      }
    }
    // Status and timing only: the token never reaches this module.
    const what = "windows" in r ? "200" : `${r.status ?? "no answer"} (${r.error})`;
    const wait = this.blockedUntil > now ? `; next check after ${Math.round((this.blockedUntil - now) / 1000)}s` : "";
    this.log(`[usage] asked Anthropic: ${what} in ${now - started}ms; ${this.calls.length} checks in the last hour${wait}`);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    const s: Saved = { last: this.last, lastError: this.lastError, attemptAt: this.attemptAt, blockedUntil: this.blockedUntil, failures: this.failures };
    try {
      atomicWrite(this.file, JSON.stringify(s));
    } catch {}
  }

  private view(): UsageView {
    const now = this.now();
    const e = this.lastError;
    const retryAt = this.blockedUntil > now ? new Date(this.blockedUntil).toISOString() : undefined;
    const extra = { ...(e?.limited && { limited: true as const }), ...(retryAt && { retryAt }) };
    if (this.last) {
      if (!e) return { ...this.last };
      return { ...this.last, stale: true, error: e.error, ...extra };
    }
    if (e) {
      const mins = retryAt ? Math.max(1, Math.ceil((this.blockedUntil - now) / 60_000)) : 0;
      const error = e.limited && mins ? `${RATE_LIMITED}; next try in about ${mins} min` : e.error;
      return { error, fetchedAt: new Date(e.at).toISOString(), ...extra };
    }
    // Only reachable while nothing was ever asked and a call is blocked, e.g. right after a restart inside the gap.
    return { error: "Usage not checked yet; try Refresh in a minute", fetchedAt: new Date(now).toISOString() };
  }
}

/** Rejects after `ms` (e.g. a keychain read stuck on a prompt), so one stuck check can't hang every usage request. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Usage check took over ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}
