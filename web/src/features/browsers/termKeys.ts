/** Minimal slice of KeyboardEvent that keyToInput looks at (keeps it testable without a DOM). */
export type KeyLike = {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing: boolean;
};

/**
 * Custom key handling for the embedded terminal, on top of xterm.js.
 * xterm sends a plain `\r` for Shift+Enter, so Claude Code can't tell it from Enter;
 * `ESC CR` is what Claude Code's `/terminal-setup` makes other terminals send for a newline.
 * Returns `undefined` to let xterm handle the key, `null` to swallow it, or the data to send instead.
 */
export function keyToInput(ev: KeyLike): string | null | undefined {
  if (ev.isComposing || ev.key !== "Enter" || !ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return undefined;
  return ev.type === "keydown" ? "\x1b\r" : null;
}

/** The phone key row above the keyboard (TerminalView): what each key sends. */
export const KEY_ROW: { label: string; aria: string; data: string }[] = [
  { label: "Esc", aria: "Escape", data: "\x1b" },
  { label: "Tab", aria: "Tab", data: "\t" },
  { label: "↑", aria: "Up arrow", data: "\x1b[A" },
  { label: "↓", aria: "Down arrow", data: "\x1b[B" },
  { label: "←", aria: "Left arrow", data: "\x1b[D" },
  { label: "→", aria: "Right arrow", data: "\x1b[C" },
];

/**
 * Typed input with the row's Ctrl armed: a single letter (or @ [ \ ] ^ _ ?) becomes its control code (c -> ^C),
 * anything else goes as typed. Returns the data to send.
 */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  if (c === 63) return "\x7f";
  if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f);
  if (data === " ") return "\x00";
  return data;
}
