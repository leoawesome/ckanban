import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Tap buttons that type `@` (snippet) or `/` (skill) at the caret, for phones where those keys are awkward. After the
 * render that adds it, the caret moves past it and `after` runs (the pickers look at the caret then and open).
 */
export function useTypeTrigger(ref: RefObject<HTMLTextAreaElement>, setValue: (v: string) => void, after: () => void) {
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (pending.current === null || !el) return;
    el.setSelectionRange(pending.current, pending.current);
    pending.current = null;
    after();
  });
  return (ch: "@" | "/") => {
    const el = ref.current;
    if (!el) return;
    el.focus(); // inside the tap, so phones open the keyboard
    const start = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, start);
    const lead = before && !/[\s([{"'`]$/.test(before) ? " " : "";
    pending.current = start + lead.length + 1;
    setValue(before + lead + ch + el.value.slice(el.selectionEnd ?? start));
  };
}
