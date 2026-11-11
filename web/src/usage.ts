// Pure helpers for the header usage pill (kept out of the component so tests can import them).
import { aliasLabel } from "./models";

export interface UsageWindow {
  key: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

/**
 * GET /api/usage (src/server/usage-cache.ts UsageView): the last good numbers, with `stale` and the error when a later
 * check failed, or the error alone when there are no numbers.
 */
export type UsageResult =
  | { windows: UsageWindow[]; fetchedAt: string; stale?: boolean; error?: string; limited?: boolean; retryAt?: string }
  | { error: string; fetchedAt: string; limited?: boolean; retryAt?: string };

/** The windows to draw (empty when the answer is an error alone). */
export function usageWindows(u: UsageResult | null): UsageWindow[] {
  return u && "windows" in u ? u.windows : [];
}

/** The red error, only when there are no numbers to show. */
export function usageError(u: UsageResult | null): string | null {
  return u && !("windows" in u) ? u.error : null;
}

/** The note under kept numbers when the latest check failed. */
export function staleNote(u: UsageResult | null): string | null {
  if (!u || !("windows" in u) || !u.stale) return null;
  const why = u.limited ? "Anthropic is limiting checks" : u.error || "the check failed";
  return `Couldn't update just now (${why}). Showing the last numbers.`;
}

export type UsageTone = "ok" | "warn" | "err";

/** Amber from 80%, red from 95%. */
export function usageTone(percent: number): UsageTone {
  if (percent >= 95) return "err";
  if (percent >= 80) return "warn";
  return "ok";
}

/** The pill takes the colour of the fullest window. */
export function worstTone(windows: UsageWindow[]): UsageTone {
  return usageTone(Math.max(0, ...windows.map((w) => w.percent)));
}

const pct = (n: number) => `${Math.round(n)}%`;

/** The status pill's limit part, only once a window is near its limit (80%): "5h 92%". Null while all are fine. */
export function limitNote(windows: UsageWindow[]): string | null {
  if (!windows.length || worstTone(windows) === "ok") return null;
  const w = windows.reduce((a, b) => (b.percent > a.percent ? b : a));
  return `${shortLabel(w)} ${pct(w.percent)}`;
}

/** "5h", "Week", or the window's own label for the others (phone usage box rows). */
export function shortLabel(w: UsageWindow): string {
  return ({ five_hour: "5h", seven_day: "Week" } as Record<string, string>)[w.key] ?? w.label;
}

function inWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** "Resets 4:10 PM (in 2h 15m)" within a day, "Resets Thu 9:00 AM" further out. */
export function resetText(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "Resets now";
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (ms < 24 * 3600_000) return `Resets ${time} (in ${inWords(ms)})`;
  return `Resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** "Resets at 23:10, in 2h 13m" within a day, "Resets Sat 09:00, in 2d 12h" further out (phone usage box). */
export function resetLine(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const ms = at.getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return "Resets now";
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (ms < 24 * 3600_000) return `Resets at ${time}, in ${inWords(ms)}`;
  return `Resets ${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}, in ${inWords(ms)}`;
}

// ---------- per-ticket usage (Usage tab) ----------

export type RunKind = "work" | "planning" | "chat" | "reply" | "follow-up" | "run";

/** What the agents of a ticket's huddles spent (src/server/ticket-usage.ts TeammateUsage). */
export interface TeammateUsage {
  costUsd: number;
  huddles: { id: string; status: string; createdAt: string; costUsd: number; teammates: { handle: string; role: string; costUsd: number }[] }[];
}

export interface TicketUsage {
  runs: { run: number; kind: RunKind; startedAt: string; model: string | null; tokens: number; costUsd: number; pct5h: number | null }[];
  /** costUsd includes the huddle teammates and side calls; tokens and % are the ticket's runs only. */
  totals: { costUsd: number; tokens: number; pctCurrentWindow: number | null; pctLifetime: number | null };
  teammates?: TeammateUsage | null;
  /** "Say it simpler" rewrites and "Help me understand" answers (side calls outside the ticket's session). */
  sideCostUsd?: number;
  window: { utilization: number; resetsAt: string; seenAt: string } | null;
  windowError: string | null;
}

/** "≈ 6%", "≈ <1%", "–" when unknown. */
export function approxPct(p: number | null): string {
  if (p === null) return "–";
  if (p > 0 && p < 1) return "≈ <1%";
  return `≈ ${Math.round(p)}%`;
}

/** "$4.12", "<$0.01". */
export function costText(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "2.1M", "340k", "820". */
export function tokenText(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

/** "claude-opus-5-5[1m]" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5". */
export function modelName(id: string | null): string {
  if (!id) return "–";
  const alias = aliasLabel(id);
  if (alias) return alias;
  const m = /(opus|sonnet|haiku|fable|mythos)(?:-(\d+))?(?:-(\d{1,2}))?(?=$|[-[])/i.exec(id.replace(/\[.*\]$/, ""));
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return [name, [m[2], m[3]].filter(Boolean).join(".")].filter(Boolean).join(" ");
}

export const RUN_KIND_LABEL: Record<RunKind, string> = {
  work: "Work run", planning: "Planning chat", chat: "Chat", reply: "Reply to a ticket", "follow-up": "Follow-up", run: "Run",
};
