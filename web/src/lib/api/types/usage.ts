/** What every board spent today (src/usage/spend.ts). */
export interface TodaySpend {
  day: string;
  costUsd: number;
  boards: { slug: string; name: string; costUsd: number }[];
}

/** One huddle a teammate or template took part in (src/huddle/huddle-usage.ts). */
export interface UsageHuddle {
  board: string;
  huddle: string;
  ticket: string;
  title: string | null;
  at: string;
  costUsd: number;
}

export interface TeamUsage {
  huddles: number;
  lastUsed: string | null;
  costUsd: number;
  /** Newest first. */
  recent: UsageHuddle[];
}
