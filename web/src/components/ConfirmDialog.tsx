import { useId, useRef, useState, type ReactNode } from "react";
import { useFocusTrap, useLayer } from "../lib/layers";
import { useBackdropClose } from "../lib/sheet";
import { KeyHint } from "./KeyHint";
import { useBackEntry } from "../app/backEntry";
import { usePhone } from "../hooks/usePhone";
import { FormError } from "./formParts";

export function ConfirmDialog({ title, children, confirmLabel, busyLabel = "Working…", tone = "danger", onConfirm, onCancel, backEntry = true, confirmDisabled }: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel?: string;
  tone?: "danger" | "primary";
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
  /** On a phone, Back cancels it (its own history entry). Off for the "Discard draft?" a dialog asks on Back. */
  backEntry?: boolean;
  /** The confirm button stays off (e.g. until the board name is typed). */
  confirmDisabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayer(onCancel);
  useBackEntry(usePhone() && backEntry, onCancel);
  useFocusTrap(box);
  const backdrop = useBackdropClose(onCancel);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="overlay confirm-overlay" {...backdrop}>
      <div ref={box} className="modal confirm" role="alertdialog" aria-modal="true" aria-labelledby={id}>
        <div className="confirm-body">
          <h3 id={id}>{title}</h3>
          <div className="confirm-text">{children}</div>
          <FormError>{err}</FormError>
        </div>
        <div className="form-actions confirm-actions">
          {/* A primary (non-destructive) confirm takes the focus, so Enter confirms (e.g. ⌘⇧Enter then Enter starts work). */}
          <button ref={cancelRef} className="btn ghost" onClick={onCancel} autoFocus={tone !== "primary"}>Cancel<KeyHint keys="Esc" /></button>
          <button className={`btn ${tone}`} onClick={confirm} disabled={busy || confirmDisabled} autoFocus={tone === "primary"}>{busy ? busyLabel : confirmLabel}{tone === "primary" && <KeyHint keys="↵" />}</button>
        </div>
      </div>
    </div>
  );
}
