// The phone's Back gesture (and browser Back) closes the window on top instead of leaving the app.
// Each open layer (a dialog, the file viewer, the Outputs reader, a phone detail screen) adds one history entry with
// the same URL; its token goes into the entry's state (ckLayers, copied up so the entry knows every layer under it).
// Back pops the top entry: every layer whose token is no longer in the current entry closes, others stay.
// Closing a layer any other way (its ×, Esc, swipe down, Save) goes back over its entry, so none is left behind;
// several layers closing at once (a confirm and the dialog under it) go back over all of theirs in one step.
// Kept free of DOM types (history and window come from globalThis) so the root typecheck and bun tests can load it.
import { useEffect, useRef, useState } from "react";

type HistoryLike = { readonly state: unknown; pushState(state: unknown, unused: string): void; go(delta: number): void };
type WindowLike = { addEventListener(type: "popstate", fn: () => void): void };
const nav = () => (globalThis as unknown as { history: HistoryLike }).history;
const win = () => (globalThis as unknown as { window: WindowLike }).window;

type Layer = { token: string; onBack: () => void };

/** Layers with an entry, bottom first. */
const live: Layer[] = [];
/** Layers closed by the page (not by Back) since the last flush. */
const closing = new Set<string>();
/** Back steps this module took itself: their popstate is not the user's. */
let ignore = 0;
let queued = false;
let listening = false;
let seq = 0;

export function layersOf(state: unknown): string[] {
  const l = (state as { ckLayers?: unknown } | null)?.ckLayers;
  return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
}

function drop(l: Layer) {
  const i = live.indexOf(l);
  if (i >= 0) live.splice(i, 1);
}

function onPop() {
  if (ignore > 0) {
    ignore--;
    return;
  }
  const now = new Set(layersOf(nav().state));
  for (const l of [...live].reverse()) {
    if (now.has(l.token)) continue;
    drop(l);
    l.onBack();
  }
}

/** Goes back over the entries of the layers the page closed, when they are the top of the current entry's stack. */
function flush() {
  queued = false;
  const chain = layersOf(nav().state);
  let i = chain.length;
  while (i > 0 && closing.has(chain[i - 1])) i--;
  closing.clear();
  const n = chain.length - i;
  if (n > 0) {
    ignore++;
    nav().go(-n);
  }
}

function push(l: Layer) {
  if (!listening) {
    win().addEventListener("popstate", onPop);
    listening = true;
  }
  const s = (nav().state ?? {}) as Record<string, unknown>;
  // One more entry for ticketHistory.ts to go back over when the open ticket closes.
  const depth = typeof s.ckDepth === "number" ? { ckDepth: s.ckDepth + 1 } : {};
  nav().pushState({ ...s, ...depth, ckLayers: [...layersOf(s), l.token] }, "");
  live.push(l);
}

/**
 * Adds a history entry for a layer: Back (popping it) calls `onBack`. Returns what to call when the layer closes any
 * other way; that goes back over its entry (batched with other layers closing in the same moment).
 */
export function openBackEntry(onBack: () => void): () => void {
  const layer: Layer = { token: `l${++seq}`, onBack };
  push(layer);
  return () => {
    if (!live.includes(layer)) return; // closed by Back: its entry is already gone
    drop(layer);
    closing.add(layer.token);
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };
}

/**
 * While `active`, the layer has its own history entry: Back calls `onBack` (which normally closes it). If the layer is
 * still open afterwards (onBack asked "Discard draft?" instead), it gets a fresh entry, so the next Back works too.
 * When it closes another way, its entry is gone from history right after.
 */
export function useBackEntry(active: boolean, onBack: () => void) {
  const fn = useRef(onBack);
  fn.current = onBack;
  const [gen, setGen] = useState(0);
  useEffect(() => {
    if (!active) return;
    return openBackEntry(() => {
      fn.current();
      setGen((g) => g + 1);
    });
  }, [active, gen]);
}

/** For tests: forget every layer. */
export function resetBackEntries() {
  live.length = 0;
  closing.clear();
  ignore = 0;
  queued = false;
  listening = false;
}
