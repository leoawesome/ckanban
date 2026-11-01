import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { CloseIcon } from "./icons";
import { reducedMotion } from "./motion";

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

/** Hovering stops the clock (and the bar); leaving carries on with the time that was left. */
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

/** Small message at the bottom of the screen that goes away on its own. Errors stay longer. */
export function toast(text: ReactNode, opts: { tone?: Tone; action?: Toast["action"]; ms?: number } = {}): number {
  const tone = opts.tone ?? "info";
  const id = nextId++;
  const ms = opts.ms ?? (tone === "error" ? 8000 : opts.action ? 7000 : 4000);
  // Same text twice in a row (e.g. a retry that fails again): replace instead of stacking.
  const replaced = toasts.filter((t) => typeof text === "string" && t.text === text);
  for (const t of replaced) forget(t.id);
  toasts = [...toasts.filter((t) => !replaced.includes(t)), { id, text, tone, action: opts.action, ms }].slice(-4);
  emit();
  arm(id, ms);
  return id;
}

export function Toaster() {
  const list = useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => toasts);
  if (!list.length) return null;
  return (
    <div className="toaster">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.tone}${t.leaving ? " leaving" : ""}${t.action ? " has-life" : ""}`} role={t.tone === "error" ? "alert" : "status"}
          onMouseEnter={() => pause(t.id)} onMouseLeave={() => resume(t.id)}
          // Phone: swipe it up (or sideways) to dismiss.
          onTouchStart={(e) => { touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
          onTouchEnd={(e) => {
            const p = e.changedTouches[0];
            if (touch && (touch.y - p.clientY > 24 || Math.abs(p.clientX - touch.x) > 60)) dismissToast(t.id);
            touch = null;
          }}>
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button className="toast-action" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}><CloseIcon size={12} /></button>
          {/* How long Undo is still there: shrinks over the toast's life, stops while hovered. */}
          {t.action && <span className="toast-life" aria-hidden style={{ "--life": `${t.ms}ms` } as CSSProperties} />}
        </div>
      ))}
    </div>
  );
}
