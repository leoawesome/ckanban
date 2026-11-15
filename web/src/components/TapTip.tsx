import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Text that carries extra detail: the detail shows as the hover tooltip on a computer and opens under the text on a
 * tap or click (phones have no hover). A tap anywhere else or Escape closes it.
 */
export function TapTip({ tip, label, className, children }: {
  /** The detail; newlines are kept. */
  tip: string;
  /** Accessible name for the button (defaults to its text). */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  // Where the detail opens: under the text, kept on screen. Fixed, so a card or bar that clips its overflow can't cut it off.
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const open = !!at;
  const ref = useRef<HTMLSpanElement>(null);
  const toggle = () => {
    if (open) return setAt(null);
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const w = Math.min(360, window.innerWidth - 32);
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), top: r.bottom + 4 });
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(null);
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  return (
    <span className={`tap-tip${className ? ` ${className}` : ""}`} ref={ref}>
      <button type="button" className="tap-tip-btn" title={open ? undefined : tip} aria-label={label} aria-expanded={open} onClick={toggle}>
        {children}
      </button>
      {at && <span className="tap-tip-pop" role="tooltip" style={at}>{tip}</span>}
    </span>
  );
}
