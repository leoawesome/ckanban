import { useSyncExternalStore } from "react";

// Shared tickers for every relative time on screen ("5m ago" keeps moving without a reload): one timer each, however
// many cards or rows use it, and it stops when nothing listens.
function ticker(ms: number) {
  let now = Date.now();
  const subs = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const subscribe = (fn: () => void) => {
    subs.add(fn);
    timer ??= setInterval(() => {
      now = Date.now();
      subs.forEach((f) => f());
    }, ms);
    return () => {
      subs.delete(fn);
      if (!subs.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  };
  return { subscribe, read: () => now };
}

const fast = ticker(30_000);
/** For times over a day old ("3d ago"): they change at most once a day, so an hourly tick is plenty. */
const hourly = ticker(3_600_000);

const noSubscribe = () => () => {};

/**
 * Re-renders the caller every 30s; use around timeAgo(). on=false: no ticks (a board card with nothing to time);
 * "hourly": once an hour (a card whose last activity is days old).
 */
export function useNow(on: boolean | "hourly" = true): number {
  const t = on === "hourly" ? hourly : on ? fast : null;
  return useSyncExternalStore(t ? t.subscribe : noSubscribe, t ? t.read : fast.read);
}
