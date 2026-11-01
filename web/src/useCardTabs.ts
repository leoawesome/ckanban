import { useEffect, type RefObject } from "react";
import { lockCardTabs, unlockCardTabs } from "./cardTabs";
import { isTyping } from "./keynav";

/** Keeps the card's inner controls out of the Tab order unless focus is on or inside the card. `ref` is the focusable card. */
export function useCardTabs(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const sync = () => (card.contains(document.activeElement) ? unlockCardTabs(card) : lockCardTabs(card));
    sync();
    // Chips come and go while the card stays (a PR opens, a tag is added): new ones start skipped too.
    const watch = new MutationObserver(sync);
    watch.observe(card, { childList: true, subtree: true });
    const onIn = () => unlockCardTabs(card);
    const onOut = (e: FocusEvent) => {
      if (!card.contains(e.relatedTarget as Node | null)) lockCardTabs(card);
    };
    // Capture: chips stop their keys from reaching the card (so they don't start a drag).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.target === card || e.isComposing || isTyping(e)) return;
      e.preventDefault();
      e.stopPropagation();
      card.focus();
    };
    card.addEventListener("focusin", onIn);
    card.addEventListener("focusout", onOut);
    card.addEventListener("keydown", onKey, true);
    return () => {
      watch.disconnect();
      card.removeEventListener("focusin", onIn);
      card.removeEventListener("focusout", onOut);
      card.removeEventListener("keydown", onKey, true);
    };
  }, [ref]);
}
