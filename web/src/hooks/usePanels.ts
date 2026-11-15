import { useEffect, useState } from "react";
import {
  closePanel, loadPanels, movePanel, NO_PANELS, openPanel, panelsKey, toggleColumn, toggleFold, togglePanel, type PanelId, type PanelsState,
} from "./panelState";

const browser = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

/**
 * The side panel column's state for the board shown (panelState.ts), saved per board in this browser: which panels
 * are open, their order, folds and height shares, the column's width and whether it shows.
 */
export function usePanels(slug: string | null) {
  const [state, setState] = useState<{ slug: string | null; s: PanelsState }>(() => ({ slug, s: slug ? loadPanels(browser, slug) : NO_PANELS }));
  // Another board: its own panels (read during render, so the old board's never flash on the new one).
  const s = state.slug === slug ? state.s : slug ? loadPanels(browser, slug) : NO_PANELS;
  if (state.slug !== slug) setState({ slug, s });
  useEffect(() => {
    if (state.slug) browser.set(panelsKey(state.slug), JSON.stringify(state.s));
  }, [state]);
  const update = (f: (s: PanelsState) => PanelsState) => setState((cur) => ({ slug: cur.slug, s: f(cur.s) }));
  return {
    state: s,
    open: (id: PanelId) => update((x) => openPanel(x, id)),
    close: (id: PanelId) => update((x) => closePanel(x, id)),
    toggle: (id: PanelId) => update((x) => togglePanel(x, id)),
    fold: (id: PanelId) => update((x) => toggleFold(x, id)),
    move: (id: PanelId, dir: -1 | 1) => update((x) => movePanel(x, id, dir)),
    toggleColumn: () => update(toggleColumn),
    hide: () => update((x) => ({ ...x, shown: false })),
    setShares: (shares: PanelsState["shares"]) => update((x) => ({ ...x, shares: { ...x.shares, ...shares } })),
    setWidth: (width: number | null) => update((x) => ({ ...x, width })),
  };
}

export type Panels = ReturnType<typeof usePanels>;

/** The window's width, kept current. */
export function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}
