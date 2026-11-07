import { useEffect, useRef, type RefObject } from "react";

/**
 * One stack for everything Esc can close (panel, dialogs, menus). Esc only closes the topmost
 * layer, so a confirm on top of a dialog on top of the ticket panel closes one at a time.
 */
type Layer = { close: () => void; skipInInputs: boolean; base: boolean };
const stack: Layer[] = [];
let bound = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || !stack.length) return;
  const top = stack[stack.length - 1];
  const target = e.target as HTMLElement | null;
  if (top.skipInInputs && target?.closest?.("input, textarea, [contenteditable='true']")) return;
  // Esc in the bottom panel or the side chat belongs to it (Dock.tsx, SideChat.tsx), not to the ticket panel; a card
  // picked up on the board (Space) drops it.
  if (top.base && target?.closest?.(".dock, .side-chat, .sortable-card[aria-pressed='true']")) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}

/**
 * Returns isTop(): true while this layer is the topmost one (nothing opened above it).
 * `base`: the ticket panel or the side chat, which the board's own keys (⌘K, ⌘B, N, ?, B) may open things over.
 * `under`: joins at the bottom of the stack, so whatever opens later or earlier closes first (the side chat sits
 * under the ticket panel: Esc closes the ticket, then the chat).
 */
export function useLayer(onEscape: () => void, opts: { active?: boolean; skipInInputs?: boolean; base?: boolean; under?: boolean } = {}) {
  const fn = useRef(onEscape);
  fn.current = onEscape;
  const mine = useRef<Layer | null>(null);
  const active = opts.active ?? true;
  useEffect(() => {
    if (!active) return;
    if (!bound) {
      window.addEventListener("keydown", onKey, true);
      bound = true;
    }
    const layer: Layer = { close: () => fn.current(), skipInInputs: !!opts.skipInInputs, base: !!opts.base };
    if (opts.under) stack.unshift(layer);
    else stack.push(layer);
    mine.current = layer;
    return () => {
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      mine.current = null;
    };
  }, [active, opts.skipInInputs, opts.base, opts.under]);
  return () => !!mine.current && stack[stack.length - 1] === mine.current;
}

/** True while any panel, dialog or menu is open (board shortcuts stay quiet then). */
export function anyLayerOpen(): boolean {
  return stack.length > 0;
}

/** Nothing is open but the ticket panel (or nothing at all): ⌘K, ⌘B, N, ? and B may open their dialog on top. */
export function onlyBaseLayers(): boolean {
  return stack.every((l) => l.base);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
}

/**
 * Keeps Tab inside `ref`, focuses it on open (unless something inside already has focus) and gives focus back on close.
 * `focusContainer`: focus the container itself, not its first control (e.g. so Esc still closes the panel).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, focusContainer = false) {
  // What had focus when this opened, read on the first render: by the time effects run, an autoFocus field inside
  // has already taken focus, and giving focus back to that (now gone) field would leave it nowhere.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = opener.current && !el.contains(opener.current) ? opener.current : null;
    if (!el.contains(document.activeElement)) {
      const first = focusContainer ? null : focusables(el).find((x) => !x.classList.contains("icon-btn"));
      (first ?? el).focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const f = focusables(el);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || !el.contains(at))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !el.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("keydown", onKey);
      if (prev && prev.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);
}
