import { useCallback, useEffect, useRef, useState } from "react";

/** How long a cleared row takes to shrink away, and how long clicks are ignored after the row has gone. */
export const LEAVE_MS = 180;
export const SETTLE_MS = 250;

/**
 * Clears Inbox rows safely: the row shrinks away over LEAVE_MS before the action runs (so the next row slides up
 * instead of jumping under the pointer), and every click is ignored until SETTLE_MS after it has gone.
 * `busy()` tells a click handler to do nothing; `leaving(key)` marks the row that is shrinking.
 */
export function useSafeClear() {
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const lockedUntil = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const busy = useCallback(() => Date.now() < lockedUntil.current, []);
  /** Runs `act` for the row `key` after it has shrunk away; returns false (and does nothing) while clicks are ignored. */
  const clear = useCallback((key: string, act: () => void) => {
    if (Date.now() < lockedUntil.current) return false;
    lockedUntil.current = Date.now() + LEAVE_MS + SETTLE_MS;
    setGone((s) => new Set(s).add(key));
    timers.current.push(window.setTimeout(() => {
      act();
      setGone((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }, LEAVE_MS));
    return true;
  }, []);
  return { clear, busy, leaving: (key: string) => gone.has(key) };
}
