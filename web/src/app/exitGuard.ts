// The installed app (Android's back swipe) closes at once on the board's main screen. This puts one guard entry in
// history under the main screen's entry: Back from the main screen lands on the guard and shows "Swipe back again to
// close ckanban"; a second Back within GUARD_MS leaves the app.
//
// History, once armed: [..., G (ckGuard), M (ckGuardTop), whatever opens on top (tickets, layers, Messages)].
// - The guard is (re)added only from a real tap or key press: Chrome on Android skips history entries pushed without a
//   user gesture, which would make the guard do nothing.
// - `onTop` remembers that M sits on G, so a tap never stacks a second pair, and landing on G counts as "Back from the
//   main screen" only when M was there (a ticket opened over G during the window and closed again lands on G too: no note).
// - Layers (backEntry.ts), tickets (ckDepth) and Messages (msgNav.ts) all sit on M, so their counts don't change; the
//   guard is armed only with none of them open.
// Kept free of DOM types (history and window come from globalThis) so the root typecheck and bun tests can load it.
import { backLayersOpen } from "./backEntry";

type HistoryLike = { readonly state: unknown; pushState(state: unknown, unused: string): void; replaceState(state: unknown, unused: string): void };
type Listen = (type: string, fn: (e: unknown) => void, capture?: boolean) => void;
type WindowLike = { addEventListener: Listen; removeEventListener: Listen };
const nav = () => (globalThis as unknown as { history: HistoryLike }).history;
const win = () => (globalThis as unknown as { window: WindowLike }).window;

/** How long after the note a second Back leaves the app (and the note stays). */
export const GUARD_MS = 2000;
export const GUARD_NOTE = "Swipe back again to close ckanban";

const GUARD = "ckGuard";
const TOP = "ckGuardTop";
const has = (state: unknown, key: string) => !!(state as Record<string, unknown> | null)?.[key];

export interface GuardOpts {
  /** Installed-app mode (display-mode: standalone); a normal browser tab keeps plain Back. Checked on every event. */
  enabled: () => boolean;
  /** The board's main screen: no ticket, not Messages, no dialog, panel or menu open. */
  atMain: () => boolean;
  /** Show the note (a toast for GUARD_MS). */
  warn: () => void;
  now?: () => number;
}

let onTop = false;
/** Until when a second Back leaves (no re-arming before then). */
let until = 0;

/** Adds the guard under the main screen's entry, if it isn't there. Called from a tap or key press only. */
function arm(o: GuardOpts) {
  if (onTop || !o.enabled() || !o.atMain() || backLayersOpen()) return;
  if ((o.now ?? Date.now)() < until) return;
  const s = nav().state;
  // A reload on M: the guard is already under it.
  if (has(s, TOP)) {
    onTop = true;
    return;
  }
  // On the guard itself (after the note, or a reload there): only M goes back on top. Else this entry becomes the guard.
  if (!has(s, GUARD)) nav().replaceState({ [GUARD]: true }, "");
  nav().pushState({ [TOP]: true }, "");
  onTop = true;
}

function landed(o: GuardOpts) {
  const s = nav().state;
  // Forward from the guard back onto M (desktop Forward).
  if (has(s, TOP)) {
    onTop = true;
    return;
  }
  if (!has(s, GUARD)) return;
  const fromMain = onTop;
  onTop = false;
  if (!fromMain || !o.enabled() || !o.atMain()) return;
  until = (o.now ?? Date.now)() + GUARD_MS;
  o.warn();
}

/** Starts the guard; returns what stops it. */
export function startExitGuard(o: GuardOpts): () => void {
  const onPop = () => landed(o);
  const onTap = () => arm(o);
  // Esc doesn't count as a user gesture for Chrome, so it can't add the guard.
  const onKey = (e: unknown) => {
    if ((e as { key?: string } | null)?.key !== "Escape") arm(o);
  };
  const w = win();
  w.addEventListener("popstate", onPop);
  w.addEventListener("pointerup", onTap, true);
  w.addEventListener("keydown", onKey, true);
  return () => {
    w.removeEventListener("popstate", onPop);
    w.removeEventListener("pointerup", onTap, true);
    w.removeEventListener("keydown", onKey, true);
  };
}

/** For tests: forget the guard's place. */
export function resetExitGuard() {
  onTop = false;
  until = 0;
}
