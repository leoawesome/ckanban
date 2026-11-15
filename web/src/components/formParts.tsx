import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { EyeIcon, EyeOffIcon, RefreshIcon } from "./icons";

/** A save or load error: announced by screen readers when it appears (MASTER §9 Forms). */
export function FormError({ children, id, className }: { children: ReactNode; id?: string; className?: string }) {
  if (children === null || children === undefined || children === false || children === "") return null;
  return <div id={id} className={`form-error${className ? ` ${className}` : ""}`} role="alert">{children}</div>;
}

/** How long a settings window waits before it says the load is slow and offers Retry. */
export const SLOW_MS = 15_000;

/**
 * What a settings window shows before its list arrives (MASTER §9 Settings windows, Empty and loading states):
 * nothing for 300ms, then skeleton rows the size of real rows; past SLOW_MS "Taking longer than usual" with Retry.
 * A failed load shows the error with Retry.
 */
export function LoadState({ error, onRetry, rows = 3, className }: { error?: string | null; onRetry: () => void; rows?: number; className?: string }) {
  const [phase, setPhase] = useState<"quiet" | "loading" | "slow">("quiet");
  useEffect(() => {
    if (error) return;
    setPhase("quiet");
    const a = setTimeout(() => setPhase("loading"), 300);
    const b = setTimeout(() => setPhase("slow"), SLOW_MS);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [error]);
  if (error) {
    return (
      <div className={`load-state${className ? ` ${className}` : ""}`}>
        <div className="load-banner err" role="alert">
          <span>Couldn't load this: {error}</span>
          <button type="button" className="btn small" onClick={onRetry}><RefreshIcon size={14} aria-hidden /> Retry</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`load-state${className ? ` ${className}` : ""}`} aria-busy="true">
      <span className="sr-only" role="status">{phase === "slow" ? "Taking longer than usual" : "Loading"}</span>
      {phase !== "quiet" && Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row" aria-hidden><i /><i /></div>
      ))}
      {phase === "slow" && (
        <div className="load-banner">
          <span>Taking longer than usual.</span>
          <button type="button" className="btn small" onClick={onRetry}><RefreshIcon size={14} aria-hidden /> Retry</button>
        </div>
      )}
    </div>
  );
}

/** An empty list: what goes here, an example, and the action (MASTER §9 Empty and loading states). */
export function EmptyState({ icon, title, children, actions }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon" aria-hidden>{icon}</div>}
      <div className="empty-state-title">{title}</div>
      {children && <div className="empty-state-text">{children}</div>}
      {actions && <div className="empty-state-actions">{actions}</div>}
    </div>
  );
}

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

/** Shows "Saved" for a moment after `flash()` (settings that save by themselves, MASTER §9). */
export function useSavedFlash(ms = 2000) {
  const [at, setAt] = useState(0);
  useEffect(() => {
    if (!at) return;
    const t = setTimeout(() => setAt(0), ms);
    return () => clearTimeout(t);
  }, [at, ms]);
  return { shown: at > 0, flash: () => setAt(Date.now()) };
}

/** The little "✓ Saved" note beside a setting that saves by itself. */
export function SavedNote({ shown, className }: { shown: boolean; className?: string }) {
  return <span className={`saved-note${shown ? " on" : ""}${className ? ` ${className}` : ""}`} role="status">{shown ? "✓ Saved" : ""}</span>;
}

/** A pasted key or token: hidden by default, with an eye button (44px on touch) to check what was pasted. */
export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <span className="secret-field">
      <input {...props} type={shown ? "text" : "password"} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button type="button" className="icon-btn secret-eye" aria-label={shown ? "Hide" : "Show"} aria-pressed={shown} title={shown ? "Hide" : "Show"}
        onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
      </button>
    </span>
  );
}
