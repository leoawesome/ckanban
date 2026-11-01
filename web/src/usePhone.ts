import { useSyncExternalStore } from "react";

/** Phone layout breakpoint; keep in step with the `max-width: 720px` rules in styles.css. */
export const PHONE_QUERY = "(max-width: 720px)";
/** Mid width (tablet, split screen): Terminal, Files, Claude and Team move into ⋯; keep in step with the `max-width: 900px` top bar rule in styles.css. */
export const TOOLS_IN_MENU_QUERY = "(max-width: 900px)";

function mediaStore(q: string) {
  const query = typeof window !== "undefined" ? window.matchMedia(q) : null;
  return {
    subscribe: (fn: () => void) => {
      query?.addEventListener("change", fn);
      return () => query?.removeEventListener("change", fn);
    },
    get: () => !!query?.matches,
  };
}

const stores = new Map<string, ReturnType<typeof mediaStore>>();

/** True while the media query matches (re-renders when it changes). */
export function useMedia(q: string): boolean {
  let s = stores.get(q);
  if (!s) stores.set(q, (s = mediaStore(q)));
  return useSyncExternalStore(s.subscribe, s.get);
}

/** True on a phone-sized screen (re-renders when the window crosses the breakpoint). */
export function usePhone(): boolean {
  return useMedia(PHONE_QUERY);
}
