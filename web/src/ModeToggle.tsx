import type { TicketMode } from "./api";
import { KeyHint } from "./KeyHint";

const OPTIONS: { value: TicketMode; label: string; hint: string }[] = [
  { value: "interview", label: "Interview me first", hint: "Claude asks questions first, then does the work." },
  { value: "auto", label: "Just do it", hint: "Claude works on its own and reports back." },
];

/** The one short sentence for a mode (shown under the toggle, so it needs no label). */
export const modeHint = (m: TicketMode) => OPTIONS.find((o) => o.value === m)?.hint ?? "";

/** `keyHint`: the key that switches between the two (shown while ⌘ is held). */
export function ModeToggle({ value, onChange, disabled, keyHint }: { value: TicketMode; onChange: (m: TicketMode) => void; disabled?: boolean; keyHint?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="How Claude works on this ticket">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.hint} disabled={disabled}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
      {keyHint && <KeyHint keys={keyHint} />}
    </div>
  );
}
