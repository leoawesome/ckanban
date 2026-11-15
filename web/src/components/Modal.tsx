import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { KeyHint } from "./KeyHint";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIcon } from "./icons";
import { useFocusTrap, useLayer } from "../lib/layers";
import { useBackdropClose, useCalmTouchFocus, useKeyboardFit, useSwipeClose } from "../lib/sheet";
import { useBackEntry } from "../app/backEntry";
import { usePhone } from "../hooks/usePhone";

/** Inside a Modal: close it the same way × and Esc do (asks first when the dialog has a `guard`). For Cancel buttons. */
const CloseCtx = createContext<() => void>(() => {});
export const useModalClose = () => useContext(CloseCtx);
/** A form's Cancel: closes like × does, so unsaved work is asked about the same way. */
export function ModalCancel({ label = "Cancel", className = "btn ghost", disabled }: { label?: string; className?: string; disabled?: boolean }) {
  const close = useModalClose();
  return <button type="button" className={className} onClick={close} disabled={disabled}>{label}</button>;
}

/** Forms inside a Modal report unsaved edits here; the Modal then asks before closing (as with `guard`). */
const DirtyCtx = createContext<((key: string, dirty: boolean) => void) | null>(null);
/** A form inside a Modal: while `dirty`, closing the dialog asks "Discard changes?" first. */
export function useFormDirty(dirty: boolean) {
  const report = useContext(DirtyCtx);
  const key = useId();
  useEffect(() => { report?.(key, dirty); }, [report, key, dirty]);
  useEffect(() => () => report?.(key, false), [report, key]);
}

/**
 * Dialog with focus trap and Esc (topmost layer only). `guard` = there is typed work to lose:
 * Esc, the × and clicking outside ask before closing.
 * On a phone it is a bottom sheet (sheet.ts): grab handle, swipe down to close, sized to what the keyboard leaves,
 * and it doesn't open the keyboard by itself unless it has a single field. The phone's Back gesture closes it (backEntry.ts).
 */
export function Modal({ title, onClose, children, wide, guard, guardKind = "draft", focusDialog, onKeys, className, bare, action }: {
  title: string;
  /** Shown at the title bar's right instead of the × (e.g. a Done button that closes it). */
  action?: ReactNode;
  /** Extra class on the dialog box. */
  className?: string;
  /** No title bar (the content draws its own, e.g. a phone screen with a back arrow); `title` stays its accessible name. */
  bare?: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  guard?: boolean;
  /** What `guard` protects: a typed draft ("Discard draft?") or edited settings ("Discard changes?"). */
  guardKind?: "draft" | "changes";
  /** Focus the dialog itself, not its first field (so a stray key can't edit a saved value). */
  focusDialog?: boolean;
  /**
   * Keys anywhere in this dialog (its fields, its frame, its × button), but not in a dialog opened on top of it.
   * For ⌘ combos that must never reach the browser (⌘S save page, ⌘D bookmark).
   */
  onKeys?: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const [dirtyForms, setDirtyForms] = useState<ReadonlySet<string>>(new Set());
  const report = useCallback((key: string, dirty: boolean) => setDirtyForms((s) => {
    if (s.has(key) === dirty) return s;
    const next = new Set(s);
    if (dirty) next.add(key);
    else next.delete(key);
    return next;
  }), []);
  const guarded = guard || dirtyForms.size > 0;
  const kind = guard ? guardKind : "changes";
  const tryClose = () => (guarded ? setAsking(true) : onClose());
  useLayer(tryClose);
  useBackEntry(usePhone(), tryClose);
  useFocusTrap(box, focusDialog);
  useCalmTouchFocus(box);
  useKeyboardFit(overlay, box);
  const backdrop = useBackdropClose(tryClose);
  const swipe = useSwipeClose(box, tryClose);
  return (
    <div ref={overlay} className="overlay modal-overlay" {...backdrop}>
      <div ref={box} className={`modal ${wide ? "wide" : ""} ${className ?? ""}`} role="dialog" aria-modal="true"
        aria-labelledby={bare ? undefined : id} aria-label={bare ? title : undefined} tabIndex={-1}
        onKeyDown={onKeys && ((e) => { if ((e.target as HTMLElement).closest(".modal") === e.currentTarget) onKeys(e); })}>
        {!bare && <div className="modal-grip" aria-hidden {...swipe} />}
        {!bare && (
          <header className="modal-head" {...swipe}>
            <h3 id={id}>{title}</h3>
            {action ?? <button className="icon-btn" onClick={tryClose} aria-label="Close" title="Close (Esc)"><CloseIcon /><KeyHint keys="Esc" /></button>}
          </header>
        )}
        <CloseCtx.Provider value={tryClose}><DirtyCtx.Provider value={report}>{children}</DirtyCtx.Provider></CloseCtx.Provider>
      </div>
      {asking && (
        <ConfirmDialog title={kind === "changes" ? "Discard changes?" : "Discard draft?"} confirmLabel="Discard" backEntry={false} onCancel={() => setAsking(false)} onConfirm={onClose}>
          <p>{kind === "changes" ? "Your changes here aren't saved yet." : "What you typed here will be lost."}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
