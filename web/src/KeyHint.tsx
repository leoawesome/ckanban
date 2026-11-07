import { useEffect } from "react";
import { hintParts, hintStep } from "./keynav";
import { isMac } from "./Shortcuts";

const REVEAL_MS = 300;
const CLASS = "show-hints";

/** Hold ⌘ (Ctrl off Mac) for a moment: every <KeyHint> shows its key. Mount once, in App. */
export function useHintReveal() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      document.body.classList.remove(CLASS);
    };
    const onKey = (e: KeyboardEvent) => {
      const step = hintStep({ type: e.type as "keydown" | "keyup", key: e.key, repeat: e.repeat }, isMac);
      if (step === "hide") hide();
      else if (step === "arm") {
        hide();
        timer = setTimeout(() => document.body.classList.add(CLASS), REVEAL_MS);
      }
    };
    const onVisibility = () => document.hidden && hide();
    // Capture: a handler that stops the key (e.g. Esc layers) must not leave the hints stuck on.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", hide);
    window.addEventListener("pointerdown", hide, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      hide();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}

/**
 * Key badge on the control it sits in, shown only while ⌘ is held (see useHintReveal). Write ⌘ in `keys`;
 * off Mac it reads Ctrl+. Keys with ⌘ or Ctrl get a dark badge (hold ⌘ and press), plain keys an outlined one
 * (just press); "⌘⇧↵ · R" shows one of each. `inset` keeps the badge inside the control (for ones in a clipping scroll area).
 */
export function KeyHint({ keys, inset, className }: { keys: string; inset?: boolean; className?: string }) {
  const parts = hintParts(keys);
  const show = (text: string) => (isMac ? text : text.replace(/⌘/g, "Ctrl+"));
  const cls = (extra: string) => `key-hint ${extra}${inset ? " inset" : ""}${className ? ` ${className}` : ""}`;
  if (parts.length === 1) return <span className={cls(parts[0].combo ? "kh-combo" : "kh-plain")} aria-hidden>{show(keys)}</span>;
  return (
    <span className={cls("kh-split")} aria-hidden>
      {parts.map((p, i) => <span key={i} className={p.combo ? "kh-combo" : "kh-plain"}>{show(p.text)}</span>)}
    </span>
  );
}

/** Shown at the bottom while the hints are up (desktop): what the two badge styles mean. Mount once, in App. */
export function HintLegend() {
  const mod = isMac ? "⌘" : "Ctrl";
  return (
    <div className="hint-legend" aria-hidden>
      <span className="kh-combo">{isMac ? "⌘B" : "Ctrl+B"}</span> keep {mod} held and press the letter
      <span className="kh-plain">N</span> press the key on its own
      <span className="muted">· Press ? to see every shortcut</span>
    </div>
  );
}
