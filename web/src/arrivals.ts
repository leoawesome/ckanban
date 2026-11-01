// Cards that Claude moved to another column (a run finished, a plan child started), so the board can show the move:
// the card travels from its old spot (FLIP, 250ms), arrives with a ring that fades over 1.5s, and keeps a small
// "new" dot until it is hovered or opened. Drag and drop and the board's own moves are animated by dnd-kit instead.
import { useSyncExternalStore } from "react";
import { reducedMotion } from "./motion";

export const TRAVEL_MS = 250;
export const RING_MS = 1500;

/** Where each moved card was on screen just before the move (null: it wasn't visible, so it only fades in). */
const from = new Map<string, { rect: DOMRect | null; at: number }>();
/** A move whose card doesn't show up by then (filtered out, collapsed column) isn't played later. */
const STALE_MS = 1000;
/** Cards that arrived and haven't been hovered or opened yet: when they arrived. */
let arrived: ReadonlyMap<string, number> = new Map();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** A ticket.updated put this card in another column: remember where it was, and mark it new (except in Done). */
export function noteServerMove(id: string, toColumn: string) {
  const el = document.querySelector<HTMLElement>(`[data-ticket="${CSS.escape(id)}"] > .card`);
  from.set(id, { rect: el ? el.getBoundingClientRect() : null, at: Date.now() });
  if (toColumn === "done") return queueMicrotask(() => clearArrival(id));
  const next = new Map(arrived);
  next.set(id, Date.now());
  arrived = next;
  // Called while the board works out its new state: the cards redraw after that.
  queueMicrotask(emit);
  // The ring has faded: draw the card again without it.
  setTimeout(() => {
    arrived = new Map(arrived);
    emit();
  }, RING_MS + 50);
}

/** Hovered or opened: the card is no longer new. */
export function clearArrival(id: string) {
  if (!arrived.has(id)) return;
  const next = new Map(arrived);
  next.delete(id);
  arrived = next;
  emit();
}

/** Whether a card shows the "new" dot, and whether its arrival ring is still showing. */
export function useArrival(id: string): { isNew: boolean; ring: boolean } {
  const m = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => arrived);
  const at = m.get(id);
  if (at === undefined) return { isNew: false, ring: false };
  // With reduced motion the ring is a still outline that stays until the card is hovered or opened.
  return { isNew: true, ring: reducedMotion() || Date.now() - at < RING_MS };
}

/**
 * Called once the moved card is drawn in its new column: slide it there from where it was (or fade it in), unless
 * the user asked for reduced motion. el: the card element.
 */
export function playMove(id: string, el: HTMLElement | null) {
  if (!from.has(id)) return;
  const { rect: was, at } = from.get(id)!;
  from.delete(id);
  if (!el || Date.now() - at > STALE_MS || reducedMotion() || typeof el.animate !== "function") return;
  const now = el.getBoundingClientRect();
  if (!was || (was.left === now.left && was.top === now.top)) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TRAVEL_MS, easing: "ease-out" });
    return;
  }
  // The card travels as a copy on top of the page: the columns' scrolling would clip the card itself.
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("card-ghost");
  Object.assign(ghost.style, {
    position: "fixed", left: `${now.left}px`, top: `${now.top}px`, width: `${now.width}px`, height: `${now.height}px`,
    margin: "0", zIndex: "30", pointerEvents: "none",
  });
  document.body.appendChild(ghost);
  el.style.visibility = "hidden";
  // The lifted card wears the shared floating shadow (--shadow-pop), read as a value for the keyframe.
  const lift = getComputedStyle(document.documentElement).getPropertyValue("--shadow-pop").trim() || "none";
  const a = ghost.animate(
    [
      { transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)`, boxShadow: lift },
      { transform: "none" },
    ],
    { duration: TRAVEL_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  );
  const done = () => {
    ghost.remove();
    el.style.visibility = "";
  };
  a.onfinish = done;
  a.oncancel = done;
}

