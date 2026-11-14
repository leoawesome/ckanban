import { useEffect, useRef, type RefObject } from "react";
import { gapOf, NEAR_BOTTOM, onContentChange, stickAfterScroll, USER_CHANGE_MS } from "./chatFollow";

/**
 * Keeps a chat log pinned to the bottom while it was at the bottom, like a chat app. Shared by the ticket chat and the
 * Ask (quick) chat. Anything that changes the log's content or size is caught: Claude's reply, cards, the Working line,
 * a picture finishing loading, and the log getting shorter because the message box grew (typing several lines).
 * Scrolled up to read, nothing moves: `onNew` is called instead (the "New messages" button).
 * While the user presses in the log (selecting text, dragging, touching), new content waits until they let go.
 */
export function useChatFollow(scroller: RefObject<HTMLDivElement | null>, onNew: () => void) {
  const stickToBottom = useRef(true);
  // Bottom gap and scroll position as last seen, to tell new content below the view from a scroll.
  const lastGap = useRef(0);
  const lastTop = useRef(0);
  const pressing = useRef(false);
  const held = useRef(false);
  const releasedAt = useRef(0);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => {
      const after = gapOf(el);
      const userCaused = Date.now() - releasedAt.current < USER_CHANGE_MS;
      const what = onContentChange({ before: lastGap.current, after, stuck: stickToBottom.current, pressing: pressing.current, userCaused });
      if (userCaused && after > lastGap.current) stickToBottom.current = after < NEAR_BOTTOM;
      if (what === "scroll") el.scrollTop = el.scrollHeight;
      else if (what === "hold") held.current = true;
      else if (what === "button") onNewRef.current();
      lastGap.current = gapOf(el);
      lastTop.current = el.scrollTop;
    };
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("load", check, true);
    const press = () => { pressing.current = true; };
    const release = () => {
      if (!pressing.current) return;
      pressing.current = false;
      releasedAt.current = Date.now();
      if (held.current && stickToBottom.current) el.scrollTop = el.scrollHeight;
      held.current = false;
      lastGap.current = gapOf(el);
    };
    el.addEventListener("mousedown", press);
    el.addEventListener("touchstart", press, { passive: true });
    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    return () => {
      mo.disconnect();
      ro.disconnect();
      el.removeEventListener("load", check, true);
      el.removeEventListener("mousedown", press);
      el.removeEventListener("touchstart", press);
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
    };
  }, []);

  /** Call from the log's onScroll: updates whether it follows. Returns the bottom gap and whether it moved up. */
  const noteScroll = (el: HTMLElement) => {
    const gap = gapOf(el);
    const movedUp = el.scrollTop < lastTop.current - 2;
    stickToBottom.current = stickAfterScroll({ gap, stuck: stickToBottom.current, movedDown: el.scrollTop > lastTop.current });
    lastTop.current = el.scrollTop;
    lastGap.current = gap;
    return { gap, movedUp };
  };

  return { stickToBottom, lastGap, pressing, noteScroll };
}
