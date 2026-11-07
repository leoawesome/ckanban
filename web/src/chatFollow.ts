/** How the chat follows new content at the bottom, like a chat app. Pure, so it can be tested without a browser. */

/** Within this many pixels of the bottom the chat counts as "at the bottom" and follows new content. */
export const NEAR_BOTTOM = 150;
/** Scrolled up further than this, the "Jump to latest" button shows even with nothing new. */
export const SHOW_JUMP = 240;

export type Box = { scrollHeight: number; scrollTop: number; clientHeight: number };

/** Pixels between the bottom of the view and the bottom of the content. */
export const gapOf = (b: Box) => Math.max(0, b.scrollHeight - b.scrollTop - b.clientHeight);

/**
 * After the user (or the chat) scrolled: does the chat still follow new content?
 * Near the bottom it does. Moving down while it followed keeps following (a smooth scroll to the bottom, or content
 * growing under a downward scroll, passes through gaps above NEAR_BOTTOM); only moving up away from the bottom stops it.
 */
export function stickAfterScroll(o: { gap: number; stuck: boolean; movedDown: boolean }): boolean {
  return o.gap < NEAR_BOTTOM || (o.stuck && o.movedDown);
}

/** The jump button after a scroll: gone near the bottom, shown once well up, otherwise unchanged. */
export function jumpAfterScroll<J extends { fresh: boolean }>(gap: number, jump: J | null): J | { fresh: false } | null {
  if (gap < NEAR_BOTTOM) return null;
  if (gap > SHOW_JUMP) return jump ?? { fresh: false };
  return jump;
}

export type Follow = "none" | "scroll" | "hold" | "button";

/**
 * The chat's content or size changed. `before`/`after` are the bottom gaps before and after the change.
 * - nothing new below the view (gap didn't grow): "none";
 * - following, and the user isn't pressing (selecting text, dragging, touching): "scroll" to the new bottom;
 * - following, but the user is pressing: "hold" and scroll once they let go;
 * - scrolled up to read: "button" ("New messages"), never yank them down;
 * - the user's own click just changed it (opened details, "Show more"): "none", so what they opened stays in view.
 */
export function onContentChange(o: { before: number; after: number; stuck: boolean; pressing: boolean; userCaused?: boolean }): Follow {
  if (o.after <= o.before + 1 || o.userCaused) return "none";
  if (!o.stuck) return "button";
  return o.pressing ? "hold" : "scroll";
}

/** A change this soon after the user let go of a click or touch counts as theirs. */
export const USER_CHANGE_MS = 400;
