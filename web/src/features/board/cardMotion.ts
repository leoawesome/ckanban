// Card motion only where someone can see it. A board with hundreds of cards waiting on the user, or a few running,
// has hundreds of looping faces, spinners and pulses; even off screen or under an open ticket they cost the page
// time every frame. One shared IntersectionObserver marks the moving cards that are out of view (scrolled away in
// their column, or under the open ticket) with `data-still`, and styles.css pauses every animation inside them
// (animation-play-state: paused, so a card scrolled back into view carries on where it was, with no jump).
// Only cards that have something moving are watched (Card.tsx `moving`), so a board of still cards costs nothing.

const watched = new Set<Element>();
let io: IntersectionObserver | null = null;
/** Pixels of the window's right side the open ticket covers (0: none). */
let covered = 0;

function onChange(entries: IntersectionObserverEntry[]) {
  for (const e of entries) e.target.toggleAttribute("data-still", !e.isIntersecting);
}

function build() {
  io?.disconnect();
  // A negative right margin shrinks the viewport to the part the ticket leaves showing; a ticket over the whole
  // width (a phone) pauses the whole board through the `ck-board-covered` class instead.
  io = new IntersectionObserver(onChange, { rootMargin: `0px -${covered}px 0px 0px` });
  for (const el of watched) io.observe(el);
}

/** Watch one moving card; returns the unwatch. */
export function watchMotion(el: Element): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (!io) build();
  watched.add(el);
  io!.observe(el);
  return () => {
    watched.delete(el);
    io?.unobserve(el);
    el.removeAttribute("data-still");
  };
}

/**
 * The open ticket covers the window from `left` (its left edge, in px) to the right side; null when it closes.
 * Called on open, resize and close (TicketDrawer.tsx).
 */
export function setCoveredFrom(left: number | null) {
  const w = window.innerWidth;
  const px = left == null ? 0 : Math.max(0, Math.min(w, Math.round(w - left)));
  const full = px >= w - 1;
  document.documentElement.classList.toggle("ck-board-covered", full);
  // Fully covered: the class pauses everything, and the observer keeps its last margin.
  if (full || px === covered) return;
  covered = px;
  if (io) build();
}
