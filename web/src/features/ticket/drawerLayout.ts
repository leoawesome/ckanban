import { useEffect, useRef, useState } from "react";

// v2: widths saved under the old 80% default are dropped once so the new default shows.
const WIDTH_KEY = "ckanban.panelWidth.v2";
const MIN_WIDTH = 640;

/** Backdrop left visible beside the panel, so clicking it can always close the panel. */
const BACKDROP_MIN = 64;
/** Artifact and share link chips in the header; the rest are behind "+N more" (the Outputs tab). */
export const LINK_CHIPS = 3;

/** The width the panel may use (the window, or the window minus the side panel column beside it) and what it leaves on its left. */
type Room = { width: number; keep: number };
export const windowRoom = (): Room => ({ width: window.innerWidth, keep: BACKDROP_MIN });
/** Beside the side panel column: the room left of it; whether the board shows beside the ticket is ticketBeside's call (sideChatLayout.ts). */
export const besideRoom = (columnWidth: number): Room => ({ width: window.innerWidth - columnWidth, keep: 0 });

const defaultWidth = (room: Room) => Math.round(Math.min(1120, room.width * 0.72));

/** Until the user resizes the panel, the Changes tab opens it this wide (clamped to the window): file list plus diff. */
export const CHANGES_WIDTH = 1280;

/** Chat room for the default width: a comfortable reading column plus side padding. Dragging can go wider. */
export const CHAT_ROOM = 800;

export function clampWidth(w: number, room: Room = windowRoom()): number {
  const vw = room.width;
  // Narrow windows can't fit the minimum width plus the strip: the panel goes full width there.
  const max = vw >= MIN_WIDTH + room.keep ? vw - room.keep : vw;
  return Math.round(Math.min(Math.max(w, Math.min(MIN_WIDTH, max)), max));
}

const SIDE_KEY = "ckanban.sidebarWidth";
const SIDE_DEFAULT = 340;
const SIDE_MIN = 260;
/** The chat column always keeps at least this much room. */
const CHAT_MIN = 420;

const clampSide = (w: number, bodyWidth: number) =>
  Math.round(Math.max(SIDE_MIN, Math.min(w, bodyWidth ? bodyWidth - CHAT_MIN : w)));

/**
 * Drag the line between the details sidebar and the chat; double-click resets to 340px.
 * The preference persists per browser and is clamped to the panel's current width when shown.
 */
export function useSidebarWidth(bodyRef: React.RefObject<HTMLDivElement | null>) {
  const [pref, setPref] = useState(() => {
    try {
      return Number(localStorage.getItem(SIDE_KEY)) || SIDE_DEFAULT;
    } catch {
      return SIDE_DEFAULT;
    }
  });
  const [bodyWidth, setBodyWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const width = clampSide(pref, bodyWidth);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const persist = (w: number) => {
    try {
      localStorage.setItem(SIDE_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampSide(w, bodyRef.current?.clientWidth ?? 0);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const left = bodyRef.current?.getBoundingClientRect().left ?? 0;
    if (dragging) set(e.clientX - left);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => persist(set(SIDE_DEFAULT));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowRight" ? step : -step)));
    }
  };
  return { width, pref, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

const SPLIT_KEY = "ckanban.detailsSplit";
/** Room each side of the details' drag bar keeps: a few rows on top, the Description heading and some text below. */
const PINNED_MIN = 56;
const DESC_MIN = 96;

/** The top part's height in px for a saved share of the sidebar's height, kept inside both minimums. */
export function splitHeight(share: number, total: number): number {
  return Math.round(Math.max(PINNED_MIN, Math.min(share * total, total - DESC_MIN)));
}

/**
 * Drag the bar between the details' top part (status, PRs, family) and the description; double-click resets to the
 * natural layout (the top part as tall as its content, up to 65%). The height persists per browser as a share of the
 * sidebar's height.
 */
export function useDetailsSplit(detailsRef: React.RefObject<HTMLDivElement | null>, pinnedRef: React.RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [share, setShare] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY));
      return v > 0 && v < 1 ? v : null;
    } catch {
      return null;
    }
  });
  const [total, setTotal] = useState(0);
  const [dragging, setDragging] = useState(false);
  const shareRef = useRef(share);
  shareRef.current = share;
  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTotal(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const persist = (v: number | null) => {
    try {
      if (v === null) localStorage.removeItem(SPLIT_KEY);
      else localStorage.setItem(SPLIT_KEY, String(v));
    } catch {}
  };
  const setPx = (px: number) => {
    const h = detailsRef.current?.clientHeight ?? total;
    if (!h) return null;
    const v = splitHeight(px / h, h) / h;
    setShare(v);
    return v;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) setPx(e.clientY - (detailsRef.current?.getBoundingClientRect().top ?? 0));
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(shareRef.current);
  };
  const reset = () => {
    setShare(null);
    persist(null);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const step = e.shiftKey ? 96 : 24;
    const now = pinnedRef.current?.offsetHeight ?? 0;
    persist(setPx(now + (e.key === "ArrowDown" ? step : -step)));
  };
  const height = enabled && share !== null && total ? splitHeight(share, total) : null;
  return { height, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}

/** The width the user dragged to, or null when they never resized (or reset). */
function savedWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (v) return v;
  } catch {}
  return null;
}

/**
 * Drag the panel's left edge to resize, up to the window minus the backdrop strip; double-click resets.
 * Width persists per browser. Until the user resizes, the default is min(1120px, 72%) but no wider than
 * `fit` (sidebar + chat reading room), so the panel doesn't open with empty space beside the chat.
 */
export function usePanelWidth(fit: number, room: Room) {
  const [pref, setPref] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);
  // Re-render on window resize; the width is clamped to the window on every render.
  const [, setVw] = useState(window.innerWidth);
  const width = clampWidth(pref ?? Math.min(defaultWidth(room), fit), room);
  const widthRef = useRef(width);
  widthRef.current = width;

  const persist = (w: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {}
  };
  const set = (w: number) => {
    const c = clampWidth(w, room);
    setPref(c);
    return c;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging) set(room.width - e.clientX);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    persist(widthRef.current);
  };
  const reset = () => {
    setPref(null);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {}
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      persist(set(widthRef.current + (e.key === "ArrowLeft" ? step : -step)));
    }
  };
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { width, want: pref ?? Math.min(defaultWidth(room), fit), custom: pref !== null, dragging, handle: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset, onKeyDown } };
}
