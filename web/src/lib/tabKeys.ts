import type { KeyboardEvent } from "react";

/**
 * Arrow keys on a role="tablist" (WAI-ARIA tabs): Left/Right move to the previous/next tab (wrapping), Home/End to the
 * first/last; the new tab is picked and focused. `idPrefix` + tab id is each tab button's DOM id.
 */
export function tabKeys<T extends string>(order: readonly T[], current: T, pick: (t: T) => void, idPrefix: string) {
  return (e: KeyboardEvent) => {
    const at = order.indexOf(current);
    const n = order.length;
    const to = e.key === "ArrowRight" ? (at + 1) % n : e.key === "ArrowLeft" ? (at - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (to === null || to === at) return;
    e.preventDefault();
    pick(order[to]);
    requestAnimationFrame(() => document.getElementById(`${idPrefix}${order[to]}`)?.focus());
  };
}
