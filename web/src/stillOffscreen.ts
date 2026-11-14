// Chat avatars move only where someone can see them. Each Claude turn has its avatar, and its eyes blink forever
// (styles.css av-blink); a long chat with "Load earlier" pressed a few dozen times has thousands of them, and every
// one costs the page style and paint work each frame, even scrolled far out of view. One shared IntersectionObserver
// marks those out of view with `data-still`, and styles.css pauses their animation (animation-play-state: paused, so
// an avatar scrolled back into view carries on where it was). Board cards have their own (cardMotion.ts), which also
// knows what the open ticket covers.

let io: IntersectionObserver | null = null;

/** Watch one element whose animations may pause while out of view; returns the unwatch. */
export function stillOffscreen(el: Element): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) e.target.toggleAttribute("data-still", !e.isIntersecting);
  }, { rootMargin: "200px 0px" });
  io.observe(el);
  return () => {
    io?.unobserve(el);
    el.removeAttribute("data-still");
  };
}
