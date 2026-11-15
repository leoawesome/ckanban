import { useSyncExternalStore } from "react";

/**
 * Phones: which of the user's messages shows its row of actions (time, Copy, Fork, Rewind). One at a time, across the
 * page: tapping a message shows its row, tapping it again or another message hides it.
 */
export const nextShown = (current: string | null, tapped: string): string | null => (current === tapped ? null : tapped);

let shown: string | null = null;
const subs = new Set<() => void>();
const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};
const get = () => shown;

/** Whether message `id` shows its actions now, and the tap that toggles it (hiding any other's). */
export function useShownMessage(id: string): [boolean, () => void] {
  const current = useSyncExternalStore(subscribe, get);
  return [current === id, () => {
    shown = nextShown(shown, id);
    subs.forEach((f) => f());
  }];
}
