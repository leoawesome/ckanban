// Done can hold thousands of loaded cards: drawing them all made the page heavy (2,000 cards: 13,000 elements, 173 MB)
// and drags stutter. A long column draws only the cards in view plus a margin; two spacers stand in for the rest,
// sized from the heights the cards had when they were drawn (cards have a few heights; unseen ones use the average).
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

/** Columns with at most this many cards draw them all (the window only pays off on long lists). */
export const WINDOW_MIN = 60;
/** Drawn above and below the visible part, in pixels: fast scrolls and the keyboard's J/K find cards there. */
const MARGIN = 900;
/** A card's height before it was ever drawn, until some are measured. */
const GUESS = 96;
/** Cards drawn before the column has been measured. */
const FIRST = 30;

/** Range fixes in a row from the after-draw effect before the next one waits for a frame. */
const SYNC_MAX = 3;

/**
 * The cards to draw for a scroll position: offsets[i] is where card i starts (offsets[n]: the end), top the scroll
 * position inside the list, height the visible height. Both ends get MARGIN pixels more.
 */
export function rangeFor(o: readonly number[], top: number, height: number): { start: number; end: number } {
  const n = o.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const y0 = top - MARGIN;
  const y1 = top + height + MARGIN;
  // First card whose bottom is below y0, then the first card starting at or below y1.
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (o[mid + 1] > y0) hi = mid;
    else lo = mid + 1;
  }
  const start = Math.min(lo, n - 1);
  lo = start + 1;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (o[mid] >= y1) hi = mid;
    else lo = mid + 1;
  }
  return { start, end: Math.max(lo, start + 1) };
}

/** Counts synchronous fixes in a row: take() is false once `max` were taken since the last reset(). */
export class SyncLimit {
  private used = 0;
  constructor(private max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  reset() {
    this.used = 0;
  }
}

export interface CardWindow {
  start: number;
  end: number;
  /** Spacer heights above and below the drawn cards (0: no spacer). */
  top: number;
  bottom: number;
}

/**
 * ids: the column's cards top to bottom. on: window them (else every card is drawn). keep: a card that must stay drawn
 * (the one being dragged), however far it is scrolled. body: the column's scrolling element; its direct children carry
 * `data-ticket` for the cards.
 */
export function useCardWindow(body: RefObject<HTMLElement>, ids: string[], on: boolean, keep: string | null): CardWindow {
  const heights = useRef(new Map<string, number>());
  // The height used for cards never drawn: the average of the first ones measured, then fixed. An average that kept
  // moving would shift every unseen card at each measure, and the window would chase itself.
  const guess = useRef(0);
  const frame = useRef(0);
  const gap = useRef(8);
  // Bumped when measured heights change, so the spacers follow.
  const [measured, setMeasured] = useState(0);
  const [range, setRange] = useState({ start: 0, end: FIRST });

  // Where each card starts if all were drawn (offsets[i]), each followed by the column's gap; offsets[n]: the end.
  const offsets = useMemo(() => {
    if (!on) return [];
    const h = heights.current;
    const g = guess.current || GUESS;
    const out = new Array<number>(ids.length + 1);
    out[0] = 0;
    for (let i = 0; i < ids.length; i++) out[i + 1] = out[i] + (h.get(ids[i]) ?? g) + gap.current;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, on, measured]);
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;
  // Where the list starts inside the scrolling element (cards' y = listTop + offsets[i]).
  const listTop = useRef(0);

  const rangeRef = useRef(range);
  rangeRef.current = range;
  const sync = useRef(new SyncLimit(SYNC_MAX));
  const settle = useRef(0);

  /** Sets the range for the scroll position now; true if it changed (so React draws again). */
  const recompute = useCallback((): boolean => {
    const el = body.current;
    const o = offsetsRef.current;
    if (!el || o.length <= 1) return false;
    const next = rangeFor(o, el.scrollTop - listTop.current, el.clientHeight);
    const r = rangeRef.current;
    if (r.start === next.start && r.end === next.end) return false;
    rangeRef.current = next;
    setRange(next);
    return true;
  }, [body]);

  // Follow the scroll (once a frame) and size changes of the column.
  useLayoutEffect(() => {
    const el = body.current;
    if (!on || !el) return;
    gap.current = parseFloat(getComputedStyle(el).rowGap) || 0;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync.current.reset();
        recompute();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [on, body, recompute]);

  const n = ids.length;
  let start = Math.min(range.start, Math.max(0, n - 1));
  let end = Math.min(Math.max(range.end, start + 1), n);
  if (keep) {
    const k = ids.indexOf(keep);
    if (k >= 0 && k < start) start = k;
    if (k >= end) end = k + 1;
  }

  // After each draw: measure the drawn cards and where the list starts, then fix the range if that moved anything.
  useLayoutEffect(() => {
    const el = body.current;
    if (!on || !el) return;
    let changed = false;
    let first: HTMLElement | null = null;
    let sum = 0, count = 0;
    for (const child of el.children) {
      const id = (child as HTMLElement).dataset?.ticket;
      if (!id) continue;
      first ??= child as HTMLElement;
      const h = (child as HTMLElement).offsetHeight;
      if (h > 0) { sum += h; count++; }
      if (h > 0 && Math.abs((heights.current.get(id) ?? -10) - h) > 1) {
        heights.current.set(id, h);
        changed = true;
      }
    }
    if (first) {
      const at = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const idx = ids.indexOf(first.dataset.ticket!);
      if (idx >= 0) listTop.current = at - (offsetsRef.current[idx] ?? 0);
    }
    if (!guess.current && count) guess.current = sum / count;
    // New heights apply on the next frame, so a long jump settles over a few frames instead of in one chain of draws.
    if (changed) {
      if (!frame.current) frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        sync.current.reset();
        setMeasured((v) => v + 1);
      });
    } else if (sync.current.take()) {
      if (!recompute()) sync.current.reset();
    } else if (!settle.current) {
      // The range changed in each of the last few draws without a frame between: the scroll position keeps moving with
      // the spacers (the browser's scroll anchoring did this). Fixing it from here again would chain draws until React
      // gives up (a blank board), so the rest waits for the next frame.
      settle.current = requestAnimationFrame(() => {
        settle.current = 0;
        sync.current.reset();
        recompute();
      });
    }
  });
  useLayoutEffect(() => () => {
    cancelAnimationFrame(frame.current);
    cancelAnimationFrame(settle.current);
  }, []);

  // Forget heights of cards that left the column now and then (the map would otherwise only grow).
  useLayoutEffect(() => {
    if (heights.current.size <= n * 2 + 200) return;
    const live = new Set(ids);
    for (const id of heights.current.keys()) if (!live.has(id)) heights.current.delete(id);
  }, [ids, n]);

  if (!on || !n) return { start: 0, end: n, top: 0, bottom: 0 };
  const g = gap.current;
  return {
    start, end,
    top: start > 0 ? Math.max(0, offsets[start] - g) : 0,
    bottom: end < n ? Math.max(0, offsets[n] - offsets[end] - g) : 0,
  };
}
