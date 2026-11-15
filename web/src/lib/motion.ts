// Small helpers for motion that explains a change (card moves, closing panels).

/** The user asked the system for less motion. */
export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The motion tokens in ms, for timers that wait for a transition (match --dur-fast and --dur-base in styles.css). */
export const DUR_FAST_MS = 120;
export const DUR_BASE_MS = 180;

/** How long the ticket panel takes to slide out (matches `.panel.leaving` in styles.css). */
export const PANEL_LEAVE_MS = 120;
