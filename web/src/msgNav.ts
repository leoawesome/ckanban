// Going back on the Messages screens (no React here, so tests can drive it with a pretend history).
//
// Every message page sits on a history entry with the Messages list right under it, and the list sits on an entry
// with the board under it. So the phone's back gesture (or browser Back) on a message always lands on the list, and
// Back on the list lands on the board, however the message was opened: a row, a notification, a toast, the Now tab,
// or a fresh page load. Prev/next replaces the entry, so it never piles up steps.
import { MESSAGES_HASH, messageHash, messagesRoute } from "./helperText";

/** The marker in history.state: "list" for the Messages list, "msg" for a message page with the list under it. */
export const MSG_STATE = "ckMsgs";

/** The bits of window.history this uses. */
export interface Hist {
  readonly state: unknown;
  readonly length: number;
  replaceState(state: unknown, unused: string, url: string): void;
  pushState(state: unknown, unused: string, url: string): void;
  back(): void;
}

export const marker = (state: unknown): "list" | "msg" | null => {
  const v = (state as Record<string, unknown> | null)?.[MSG_STATE];
  return v === "list" || v === "msg" ? v : null;
};
const mark = (state: unknown, v: "list" | "msg") => ({ ...((state as object | null) ?? {}), [MSG_STATE]: v });

/**
 * Called when the address becomes a Messages route. prevHash: the address before (a hashchange's old one; null on the
 * first load, when nothing of the board's may be under this entry). Puts the entries Back needs under this one.
 */
export function settleMessagesEntry(h: Hist, hash: string, prevHash: string | null, boardHash: string): void {
  const route = messagesRoute(hash);
  if (!route) return;
  const now = marker(h.state);
  if (route.id === null ? now === "list" : now === "msg") return;
  const prev = prevHash === null ? null : messagesRoute(prevHash);
  // Only the list itself was under it (a toast's Open on the list): just mark this entry.
  if (route.id !== null && prev && prev.id === null) {
    h.replaceState(mark(h.state, "msg"), "", hash);
    return;
  }
  // A fresh load (nothing of ours under it), or a link from a message page ("✉ 1 new", a toast): what is under this
  // entry is a message, so marking it would make Back (and ‹ Board) land there. Put the board here first instead.
  if (prevHash === null || (prev !== null && prev.id !== null)) {
    h.replaceState(null, "", boardHash);
    h.pushState(mark(null, "list"), "", MESSAGES_HASH);
  } else {
    h.replaceState(mark(route.id === null ? h.state : null, "list"), "", MESSAGES_HASH);
  }
  if (route.id !== null) h.pushState(mark(null, "msg"), "", messageHash(route.id));
}

/** A row on the list opens its message on a new entry (the list stays under it). */
export function openFromList(h: Hist, id: string): void {
  h.pushState(mark(null, "msg"), "", messageHash(id));
}

/** Prev/next on a message page: the same entry, now on the other message. */
export function stepTo(h: Hist, id: string): void {
  h.replaceState(mark(h.state, "msg"), "", messageHash(id));
}

/**
 * The page's own back (‹ Messages, the sideways swipe): Back when the list is under this entry, else (an old entry
 * from before this) put the list here. Returns "back" or "replace" (the caller then shows the list).
 */
export function backToList(h: Hist): "back" | "replace" {
  if (marker(h.state) === "msg") {
    h.back();
    return "back";
  }
  h.replaceState(mark(null, "list"), "", MESSAGES_HASH);
  return "replace";
}

/** ‹ Board on the list: Back when the board is under it, else go to the board on this entry. */
export function backToBoard(h: Hist, boardHash: string): "back" | "replace" {
  if (marker(h.state) === "list") {
    h.back();
    return "back";
  }
  h.replaceState(null, "", boardHash);
  return "replace";
}

/** The first moves of a touch decide what it is: "back" (mostly sideways, to the right), "scroll" (anything else), or not yet. */
export function swipeIntent(dx: number, dy: number): "back" | "scroll" | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < 10 && ay < 10) return null;
  return dx > 0 && ax > ay * 2 ? "back" : "scroll";
}

/** Whether a sideways drag this far (px) in this long (ms) closes the page: past 90px, or a quick 40px flick. */
export const swipeCloses = (dx: number, ms: number) => dx > 90 || (dx > 40 && ms < 250);
