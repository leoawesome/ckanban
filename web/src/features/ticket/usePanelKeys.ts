import { useEffect, useRef } from "react";
import { inDock, isTyping, panelStep } from "../../app/keynav";

/** The ticket panel's plain-key shortcuts for previous / next ticket (moved from TicketDrawer.tsx). */
export function usePanelKeys({ isTopLayer, nav, step }: {
  isTopLayer: () => boolean;
  nav: { prev: string | null; next: string | null; go: (id: string, fresh?: boolean | undefined) => void; afterDone?: ((id: string) => string | null) | undefined; } | undefined;
  step: (id: string | null | undefined, fresh?: boolean) => void;
}) {
  // Latest prev/next for the key handler below, which is bound once.
  const stepRef = useRef((_to: "prev" | "next") => {});
  stepRef.current = (to) => step(nav?.[to]);
  // Plain-key shortcuts (↑↓ J K, E) only when the panel itself has the keyboard: not typing, no menu, popup or dialog above it.
  // Not from the bottom panel either (Files, Team, Claude): its keys are its own.
  const panelKeys = (e: KeyboardEvent) => !e.isComposing && !e.defaultPrevented && !isTyping(e) && !inDock(e) && isTopLayer() && !document.querySelector(".overlay");
  const panelKeysRef = useRef(panelKeys);
  panelKeysRef.current = panelKeys;
  useEffect(() => {
    // Alt+↑ / Alt+↓ open the previous / next ticket, also while typing; plain ↑/↓ and K/J when not typing.
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      let dir: "prev" | "next" | null = null;
      if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) dir = e.key === "ArrowUp" ? "prev" : "next";
      else if (panelKeysRef.current(e)) dir = panelStep(e);
      if (!dir) return;
      e.preventDefault();
      stepRef.current(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { panelKeysRef };
}
