import { useRef, type ReactNode } from "react";
import { usePhone } from "./usePhone";
import { useBackdropClose, useSwipeClose } from "./sheet";

/**
 * Wrap a dropdown menu so it opens as a bottom sheet on a phone: dimmed backdrop (a tap on it closes),
 * grip, full width, scrolls when tall (`.menu-sheet` in styles.css). Elsewhere the menu renders as is.
 * The backdrop closes it only when the press started and ended on it (a scroll that overshoots doesn't).
 * It draws a grip, so a swipe down on the sheet (not on its buttons) closes it too.
 * Rendered in place (not portaled), so the menu's own "click outside closes" checks keep treating the
 * sheet as inside.
 */
export function MenuSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const phone = usePhone();
  const wrap = useRef<HTMLDivElement>(null);
  // The sheet is the menu itself (the wrapper's only child): that is what slides down with the finger.
  const box = useRef<HTMLElement | null>(null);
  const swipe = useSwipeClose(box, onClose);
  const backdrop = useBackdropClose(onClose);
  if (!phone) return <>{children}</>;
  return (
    <div ref={wrap} className="sheet-wrap menu-sheet"
      onPointerDown={(e) => {
        backdrop.onPointerDown(e);
        const sheet = wrap.current?.firstElementChild as HTMLElement | null;
        box.current = sheet;
        if (sheet && e.target !== e.currentTarget && sheet.contains(e.target as Node)) swipe.onPointerDown(e);
      }}
      onPointerMove={swipe.onPointerMove} onPointerUp={swipe.onPointerUp} onPointerCancel={swipe.onPointerCancel}
      onClick={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); backdrop.onClick(e); } }}>
      {children}
    </div>
  );
}
