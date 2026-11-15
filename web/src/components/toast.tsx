import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { CloseIcon } from "./icons";
import { KeyHint } from "./KeyHint";
import { reducedMotion } from "../lib/motion";

type Tone = "info" | "ok" | "error";
interface Toast {
  id: number;
  text: ReactNode;
  tone: Tone;
  action?: { label: string; run: () => void };
  /** How long it stays (ms): the bar under an Undo shrinks over this time. */
  ms: number;
  /** Fading out; removed after LEAVE_MS. */
  leaving?: boolean;
}

/** The fade-out before a toast is removed (matches `.toast.leaving` in styles.css). */
const LEAVE_MS = 120;

let toasts: Toast[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
// When each toast goes, and the time it had left while the pointer pauses it.
const deadlines = new Map<number, number>();
const paused = new Map<number, number>();
const emit = () => subs.forEach((f) => f());
let touch: { x: number; y: number } | null = null;

function forget(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  deadlines.delete(id);
  paused.delete(id);
}

export function dismissToast(id: number) {
  const t = toasts.find((x) => x.id === id);
  if (!t || t.leaving) return;
  forget(id);
  if (reducedMotion()) {
    toasts = toasts.filter((x) => x.id !== id);
  } else {
    toasts = toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x));
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      toasts = toasts.filter((x) => x.id !== id);
      emit();
    }, LEAVE_MS));
  }
  emit();
}

function arm(id: number, ms: number) {
  clearTimeout(timers.get(id));
  deadlines.set(id, Date.now() + ms);
  timers.set(id, setTimeout(() => dismissToast(id), ms));
}

/** Hovering or focusing stops the clock (and the bar); leaving carries on with the time that was left. */
function pause(id: number) {
  if (paused.has(id) || !deadlines.has(id)) return;
  clearTimeout(timers.get(id));
  timers.delete(id);
  paused.set(id, Math.max(0, deadlines.get(id)! - Date.now()));
}
function resume(id: number) {
  const left = paused.get(id);
  if (left === undefined) return;
  paused.delete(id);
  arm(id, Math.max(left, 1000));
}

/** Small message at the bottom of the screen. Info goes after 4s, one with Undo after 8s; errors stay until closed. */
export function toast(text: ReactNode, opts: { tone?: Tone; action?: Toast["action"]; ms?: number } = {}): number {
  const tone = opts.tone ?? "info";
  const id = nextId++;
  // 0 = stays until closed (errors, MASTER §9 Toasts).
  const ms = opts.ms ?? (tone === "error" ? 0 : opts.action ? 8000 : 4000);
  // Same text twice in a row (e.g. a retry that fails again): replace instead of stacking.
  const replaced = toasts.filter((t) => typeof text === "string" && t.text === text);
  for (const t of replaced) forget(t.id);
  toasts = [...toasts.filter((t) => !replaced.includes(t)), { id, text, tone, action: opts.action, ms }].slice(-3);
  emit();
  if (ms > 0) arm(id, ms);
  return id;
}

/** The newest toast still showing an action (e.g. Undo): the one U runs. */
const newestWithAction = (list: Toast[]) => [...list].reverse().find((t) => t.action && !t.leaving);

/** U: run the newest toast's Undo and dismiss it. False when no toast offers one. */
export function undoLatest(): boolean {
  const t = newestWithAction(toasts);
  if (!t) return false;
  t.action!.run();
  dismissToast(t.id);
  return true;
}

/**
 * Always mounted, so screen readers hear a new toast (a live region added together with its text is often skipped):
 * the stack is a polite region, and errors are also spoken at once through the assertive region beside it.
 */
export function Toaster() {
  const list = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => toasts);
  const keyed = newestWithAction(list);
  const errors = list.filter((t) => t.tone === "error" && !t.leaving);
  return (
    <>
      <div className="sr-only" aria-live="assertive" aria-atomic="true">{errors.length ? errors[errors.length - 1].text : null}</div>
      <div className="toaster" aria-live="polite" aria-relevant="additions text">
        {list.map((t) => (
          <div key={t.id} className={`toast ${t.tone}${t.leaving ? " leaving" : ""}${t.action ? " has-life" : ""}`}
            onMouseEnter={() => pause(t.id)} onMouseLeave={(e) => { if (!e.currentTarget.contains(document.activeElement)) resume(t.id); }}
            onFocus={() => pause(t.id)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) resume(t.id); }}
            // Phone: swipe it up (or sideways) to dismiss.
            onTouchStart={(e) => { touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
            onTouchEnd={(e) => {
              const p = e.changedTouches[0];
              if (touch && (touch.y - p.clientY > 24 || Math.abs(p.clientX - touch.x) > 60)) dismissToast(t.id);
              touch = null;
            }}>
            {/* An error is spoken by the assertive region above, so the polite stack doesn't say it twice. */}
            <span className="toast-text" aria-hidden={t.tone === "error" || undefined}>{t.text}</span>
            {t.action && (
              <button className="toast-action" onClick={() => { t.action!.run(); dismissToast(t.id); }} title={t === keyed ? `${t.action.label} (U)` : undefined}>
                {t.action.label}{t === keyed && <KeyHint keys="U" />}
              </button>
            )}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><CloseIcon size={12} /></button>
            {/* How long Undo is still there: shrinks over the toast's life, stops while hovered. */}
            {t.action && t.ms > 0 && <span className="toast-life" aria-hidden style={{ "--life": `${t.ms}ms` } as CSSProperties} />}
          </div>
        ))}
      </div>
    </>
  );
}
