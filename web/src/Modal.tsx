import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { KeyHint } from "./KeyHint";
import { ConfirmDialog } from "./ConfirmDialog";
import { CloseIcon } from "./icons";
import { useFocusTrap, useLayer } from "./layers";

/**
 * Dialog with focus trap and Esc (topmost layer only). `guard` = there is typed work to lose:
 * Esc, the × and clicking outside ask before closing.
 */
export function Modal({ title, onClose, children, wide, guard, focusDialog, onKeys, className, bare }: {
  title: string;
  /** Extra class on the dialog box. */
  className?: string;
  /** No title bar (the content draws its own, e.g. a phone screen with a back arrow); `title` stays its accessible name. */
  bare?: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  guard?: boolean;
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
  const [asking, setAsking] = useState(false);
  const tryClose = () => (guard ? setAsking(true) : onClose());
  useLayer(tryClose);
  useFocusTrap(box, focusDialog);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && tryClose()}>
      <div ref={box} className={`modal ${wide ? "wide" : ""} ${className ?? ""}`} role="dialog" aria-modal="true"
        aria-labelledby={bare ? undefined : id} aria-label={bare ? title : undefined} tabIndex={-1}
        onKeyDown={onKeys && ((e) => { if ((e.target as HTMLElement).closest(".modal") === e.currentTarget) onKeys(e); })}>
        {!bare && (
          <header className="modal-head">
            <h3 id={id}>{title}</h3>
            <button className="icon-btn" onClick={tryClose} aria-label="Close" title="Close (Esc)"><CloseIcon /><KeyHint keys="Esc" /></button>
          </header>
        )}
        {children}
      </div>
      {asking && (
        <ConfirmDialog title="Discard draft?" confirmLabel="Discard" onCancel={() => setAsking(false)} onConfirm={onClose}>
          <p>What you typed here will be lost.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
