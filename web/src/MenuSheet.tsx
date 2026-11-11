import type { ReactNode } from "react";
import { usePhone } from "./usePhone";
import { useBackdropClose } from "./sheet";

/**
 * Wrap a dropdown menu so it opens as a bottom sheet on a phone: dimmed backdrop (a tap on it closes),
 * grip, full width, scrolls when tall (`.menu-sheet` in styles.css). Elsewhere the menu renders as is.
 * The backdrop closes it only when the press started and ended on it (a scroll that overshoots doesn't).
 * Rendered in place (not portaled), so the menu's own "click outside closes" checks keep treating the
 * sheet as inside.
 */
export function MenuSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const phone = usePhone();
  const backdrop = useBackdropClose(onClose);
  if (!phone) return <>{children}</>;
  return (
    <div className="sheet-wrap menu-sheet" onPointerDown={backdrop.onPointerDown}
      onClick={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); backdrop.onClick(e); } }}>
      {children}
    </div>
  );
}
