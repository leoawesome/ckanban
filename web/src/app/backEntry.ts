// The phone's Back gesture (and browser Back) closes the window on top instead of leaving the app.
// Each open layer (a dialog, the file viewer, the Outputs reader, a phone detail screen) adds one history entry with
// the same URL; its token goes into the entry's state (ckLayers, copied up so the entry knows every layer under it).
// Back pops the top entry: every layer whose token is no longer in the current entry closes, others stay.
// Closing a layer any other way (its ×, Esc, swipe down, Save) goes back over its entry, so none is left behind;
// several layers closing at once (a confirm and the dialog under it) go back over all of theirs in one step. A layer
// that opens as another closes (a More sheet item opening its dialog) reuses the closing layer's entry.
// Kept free of DOM types (history and window come from globalThis) so the root typecheck and bun tests can load it.
import { useEffect, useRef, useState } from "react";

type HistoryLike = { readonly state: unknown; pushState(state: unknown, unused: string): void; replaceState(state: unknown, unused: string): void; go(delta: number): void };
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

/** Work waiting for this module's own back steps to land (afterBackSteps). */
const waiting: (() => void)[] = [];

function settle() {
  if (queued || ignore > 0) return;
  for (const fn of waiting.splice(0)) fn();
}

function onPop() {
  if (ignore > 0) {
    ignore--;
    settle();
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
  settle();
}

/** How long afterBackSteps waits at most for a back step's popstate (a browser that never sends one). */
const SETTLE_MAX_MS = 1000;

/**
 * Runs `fn` once the layers closing now (a sheet whose pick also changes the URL) have gone back over their history
 * entries. A pick that replaces the current entry's URL (stepping to the next ticket) must wait for that: done at
 * once, it lands on the closing layer's entry, and the back step then returns to the old URL and reopens the old
 * ticket. With no layer open (desktop) it runs at once. Otherwise it looks after this task, when React has unmounted
 * the closing layer and queued its back step, and waits for that step's popstate (at most SETTLE_MAX_MS).
 */
export function afterBackSteps(fn: () => void) {
  if (!live.length && !queued && ignore === 0) return fn();
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    const i = waiting.indexOf(once);
    if (i >= 0) waiting.splice(i, 1);
    fn();
  };
  setTimeout(() => {
    waiting.push(once);
    settle();
    setTimeout(once, SETTLE_MAX_MS);
  }, 0);
}

function push(l: Layer) {
  if (!listening) {
    win().addEventListener("popstate", onPop);
    listening = true;
  }
  const s = (nav().state ?? {}) as Record<string, unknown>;
  live.push(l);
  // A layer closing in this same moment (a menu item closes its sheet and opens a dialog): the new layer takes over
  // the closing one's entry instead of stacking on it, which would leave a dead entry under the dialog that the
  // going-back flush can no longer reach (it only goes back over closed layers at the top).
  const chain = layersOf(s);
  if (chain.length && closing.has(chain[chain.length - 1])) {
    closing.delete(chain[chain.length - 1]);
    nav().replaceState({ ...s, ckLayers: [...chain.slice(0, -1), l.token] }, "");
    return;
  }
  // One more entry for ticketHistory.ts to go back over when the open ticket closes.
  const depth = typeof s.ckDepth === "number" ? { ckDepth: s.ckDepth + 1 } : {};
  nav().pushState({ ...s, ...depth, ckLayers: [...chain, l.token] }, "");
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

/** Whether any layer has a history entry now (exitGuard.ts adds its guard only with none). */
export function backLayersOpen(): boolean {
  return live.length > 0 || queued || ignore > 0;
}

/** For tests: forget every layer. */
export function resetBackEntries() {
  live.length = 0;
  closing.clear();
  waiting.length = 0;
  ignore = 0;
  queued = false;
  listening = false;
}
