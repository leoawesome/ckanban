import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { PHONE_QUERY } from "./usePhone";

/**
 * Backdrop handlers: close only when the press both started and ended on the dim area itself, so a scroll or a
 * drag that begins inside the dialog (or overshoots past its edge) never closes it.
 */
export function useBackdropClose(close: () => void) {
  const down = useRef(false);
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => { down.current = e.target === e.currentTarget; },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      const on = e.target === e.currentTarget;
      if (on && down.current) close();
      down.current = false;
    },
  };
}

const FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=button]):not([type=submit]), textarea, select, [contenteditable='true']";

/** A touch screen (the on-screen keyboard opens when a field gets focus). */
export function isTouch(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}

/** The text fields a person can see in `el`. */
export function visibleFields(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FIELD)].filter((x) => x.offsetParent !== null);
}

/**
 * On a touch screen, don't open the keyboard by focusing the first field (it would cover half the dialog before it is
 * read), unless the dialog is a one-field form; and don't ring the first button either. Focus the dialog itself instead.
 * Runs after the dialog's own autoFocus and focus trap.
 */
export function useCalmTouchFocus(box: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = box.current;
    // Phone width counts too: a phone browser can report a fine pointer (a stylus, some emulators).
    if (!el || !(isTouch() || window.matchMedia?.(PHONE_QUERY).matches)) return;
    const at = document.activeElement as HTMLElement | null;
    if (!at || at === el || !el.contains(at)) return;
    if (at.matches(FIELD) && visibleFields(el).length === 1) return;
    el.focus({ preventScroll: true });
  }, []);
}

/**
 * Phone keyboard: fit the dialog's overlay to the part of the screen the keyboard leaves (visualViewport), so the
 * dialog's own scroll and its pinned buttons stay above the keyboard, and keep the focused field in view.
 */
export function useKeyboardFit(overlay: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = window.visualViewport;
    const o = overlay.current;
    if (!vv || !o) return;
    const phone = window.matchMedia(PHONE_QUERY);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const at = document.activeElement as HTMLElement | null;
        if (at && box.current?.contains(at) && at.matches(FIELD)) at.scrollIntoView({ block: "nearest" });
      }, delay);
    };
    const fit = () => {
      const keyboard = phone.matches && vv.height < window.innerHeight - 40;
      if (keyboard) {
        o.style.top = `${vv.offsetTop}px`;
        o.style.height = `${vv.height}px`;
        o.style.bottom = "auto";
        o.classList.add("kb-open");
        reveal(50);
      } else {
        o.style.top = o.style.height = o.style.bottom = "";
        o.classList.remove("kb-open");
      }
    };
    // The keyboard slides in after focus; look again once it has settled.
    const onFocus = () => reveal(320);
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    o.addEventListener("focusin", onFocus);
    return () => {
      clearTimeout(timer);
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
      o.removeEventListener("focusin", onFocus);
    };
  }, []);
}

/**
 * Swipe down on the sheet's handle or title bar to close it (phone). The sheet follows the finger; past 90px, or a
 * quick flick, it closes, else it springs back.
 */
export function useSwipeClose(box: RefObject<HTMLElement | null>, close: () => void) {
  const start = useRef<{ y: number; t: number; id: number } | null>(null);
  const reset = () => {
    const el = box.current;
    start.current = null;
    if (!el) return;
    el.style.transition = "transform 160ms ease-out";
    el.style.transform = "";
    setTimeout(() => { if (el) el.style.transition = ""; }, 170);
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse" || !window.matchMedia(PHONE_QUERY).matches) return;
      if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
      if (box.current && box.current.scrollTop > 0) return;
      start.current = { y: e.clientY, t: Date.now(), id: e.pointerId };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId || !box.current) return;
      const dy = Math.max(0, e.clientY - s.y);
      box.current.style.transform = dy ? `translateY(${dy}px)` : "";
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      const dy = e.clientY - s.y;
      const flick = dy > 40 && Date.now() - s.t < 250;
      reset();
      if (dy > 90 || flick) close();
    },
    onPointerCancel: reset,
  };
}
