import { useCallback, useEffect, useState } from "react";
import { api, subscribe, type TodaySpend } from "./api";
import type { UsageResult } from "./usage";

/** How often today's spend refreshes at most while runs report costs. */
const SPEND_THROTTLE_MS = 15_000;

export interface UsageState {
  usage: UsageResult | null;
  loading: boolean;
  /** Ask for plan usage now (the Refresh button; the server allows one check a minute). */
  load: () => void;
  spend: TodaySpend | null;
  loadSpend: () => void;
}

/**
 * Claude plan usage (loads once on page open, then only on Refresh) and what all boards spent today
 * (refreshed as tickets and huddles change, at most every 15 s). Shared by the header pill and the phone More sheet.
 */
export function useUsage(): UsageState {
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchUsage = useCallback((fresh: boolean) => {
    setLoading(true);
    api.usage(fresh)
      .then(setUsage)
      // Keep numbers already shown when the board server can't be reached.
      .catch((e: Error) => setUsage((u) => {
        const error = e.message || "Could not reach the board server";
        return u && "windows" in u ? { ...u, stale: true, error, limited: false } : { error, fetchedAt: new Date().toISOString() };
      }))
      .finally(() => setLoading(false));
  }, []);
  const load = useCallback(() => fetchUsage(true), [fetchUsage]);
  // Page open: the server's cached answer (it asks Anthropic only when that is a few minutes old).
  useEffect(() => fetchUsage(false), [fetchUsage]);

  const [spend, setSpend] = useState<TodaySpend | null>(null);
  const loadSpend = useCallback(() => {
    api.spend().then(setSpend).catch(() => {});
  }, []);
  useEffect(() => {
    loadSpend();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last = Date.now();
    const off = subscribe((e) => {
      if (e.type !== "ticket.updated" && e.type !== "huddle.updated") return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        loadSpend();
      }, Math.max(0, last + SPEND_THROTTLE_MS - Date.now()));
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [loadSpend]);

  return { usage, loading, load, spend, loadSpend };
}
