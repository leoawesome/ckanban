import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";

/**
 * "Discard changes?" before leaving a form with unsaved edits (switching items, the phone back arrow).
 * `leave(fn)` runs fn at once when nothing is unsaved, else asks first; render `dialog`.
 */
export function useDiscardAsk(dirty: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const leave = (fn: () => void) => (dirty ? setPending(() => fn) : fn());
  const dialog = pending && (
    <ConfirmDialog title="Discard changes?" confirmLabel="Discard" backEntry={false} onCancel={() => setPending(null)}
      onConfirm={() => { const fn = pending; setPending(null); fn(); }}>
      <p>Your changes here aren't saved yet.</p>
    </ConfirmDialog>
  );
  return { leave, dialog };
}
