/** Keyboard moves between cards: J/K/↑/↓ in a column, H/L/←/→ to the neighbouring non-empty column. */
export type CardDir = "up" | "down" | "left" | "right";
export type CardPos = { col: number; row: number };

/** Key (ignoring modifiers) → direction, or null for keys that don't move between cards. */
export function cardDir(key: string): CardDir | null {
  switch (key) {
    case "j": case "J": case "ArrowDown": return "down";
    case "k": case "K": case "ArrowUp": return "up";
    case "h": case "H": case "ArrowLeft": return "left";
    case "l": case "L": case "ArrowRight": return "right";
    default: return null;
  }
}

/**
 * Next selected card, given the card count of each column. With nothing selected, any move picks the first
 * card of the first non-empty column. Moves clamp at the edges; sideways moves skip empty columns and keep
 * the row (or the last card when the column is shorter). Null when the board has no cards.
 */
export function stepCard(cols: number[], at: CardPos | null, dir: CardDir): CardPos | null {
  const first = cols.findIndex((n) => n > 0);
  if (first < 0) return null;
  if (!at || !cols[at.col]) return { col: first, row: 0 };
  const row = Math.min(at.row, cols[at.col] - 1);
  if (dir === "down") return { col: at.col, row: Math.min(cols[at.col] - 1, row + 1) };
  if (dir === "up") return { col: at.col, row: Math.max(0, row - 1) };
  const step = dir === "right" ? 1 : -1;
  for (let c = at.col + step; c >= 0 && c < cols.length; c += step) {
    if (cols[c] > 0) return { col: c, row: Math.min(row, cols[c] - 1) };
  }
  return { col: at.col, row };
}

/** Board `delta` steps away from the current one, wrapping around; the first board when the current one isn't listed. */
export function stepBoard(count: number, current: number, delta: number): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return (((current + delta) % count) + count) % count;
}

/** 1…9 → board index 0…8, by physical key so numpad digits work and the keyboard layout doesn't matter. */
export function boardDigit(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) - 1 : null;
}

/** Focus is in a text field (input, textarea, contenteditable): single-letter and arrow shortcuts stay quiet. */
export function isTyping(e: { target: EventTarget | null }): boolean {
  const el = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || !!el.isContentEditable);
}

/** Plain ↑/K and ↓/J in the ticket panel: previous / next ticket. Null for other keys or with a modifier held. */
export function panelStep(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): "prev" | "next" | null {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  switch (e.key) {
    case "ArrowUp": case "k": case "K": return "prev";
    case "ArrowDown": case "j": case "J": return "next";
    default: return null;
  }
}

/** A proposal can be applied and started in one go only from Backlog or Planning, while Claude isn't working on it. */
export function canStartFromProposal(t: { status: string; working: boolean }): boolean {
  return !t.working && (t.status === "backlog" || t.status === "planning");
}

/**
 * ⌘⇧Enter in the ticket panel does the ticket's next step: apply a pending proposal first (and start work when it can),
 * then the column's action. A planner whose plan is finished moves to Done.
 */
export type NextStep = "apply" | "apply-start" | "start" | "done" | null;
export function nextStep(t: { status: string; working: boolean; proposalPending: boolean; planFinished?: boolean }): NextStep {
  if (t.working) return null;
  if (t.proposalPending) return canStartFromProposal(t) ? "apply-start" : "apply";
  if (t.planFinished && t.status !== "done") return "done";
  if (t.status === "backlog" || t.status === "planning") return "start";
  if (t.status === "review") return "done";
  return null;
}

/**
 * Hold ⌘ (Ctrl off Mac) to show key hints. "arm" starts the short reveal timer, "hide" cancels it and hides
 * the hints. Any other key hides them, so ⌘C / ⌘K never flash hints; key repeat of the held key changes nothing.
 */
export function hintStep(e: { type: "keydown" | "keyup"; key: string; repeat?: boolean }, mac: boolean): "arm" | "hide" | "none" {
  const hold = e.key === (mac ? "Meta" : "Control");
  if (e.type === "keyup") return hold ? "hide" : "none";
  if (!hold) return "hide";
  return e.repeat ? "none" : "arm";
}

/** A key badge's text needs ⌘ (Ctrl off Mac) held: it gets the dark badge. Plain keys ("N", "↵ open") get the outlined one. */
export function isComboKeys(keys: string): boolean {
  return /⌘|Ctrl/.test(keys);
}

/**
 * A badge's text split at " · " into parts, each marked combo or not, so "⌘⇧↵ · R" shows a dark ⌘⇧↵ and an outlined R
 * (one dark badge would read as ⌘R). Parts of one kind stay one part.
 */
export function hintParts(keys: string): { text: string; combo: boolean }[] {
  const parts = keys.split(" · ").map((text) => ({ text, combo: isComboKeys(text) }));
  return parts.every((p) => p.combo === parts[0].combo) ? [{ text: keys, combo: parts[0].combo }] : parts;
}

/** ⌘B (Ctrl+B off Mac): open or close the board picker. */
export function isBoardPickerKey(e: Keys): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing && e.key.toLowerCase() === "b";
}

type Keys = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean };

/** ⌘ (Ctrl off Mac) + one key in the New ticket dialog: ↵ start, S create in Backlog, I switch how Claude works, D star. */
export type NewTicketKey = "start" | "create" | "mode" | "star";
export function newTicketKey(e: Keys): NewTicketKey | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.isComposing) return null;
  switch (e.key) {
    case "Enter": return "start";
    case "s": case "S": return "create";
    case "i": case "I": return "mode";
    case "d": case "D": return "star";
    default: return null;
  }
}

/** ⌘. / Ctrl+. in the ticket panel: stop Claude (after a confirm). */
export function isStopKey(e: Keys): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing && e.key === ".";
}

export type DrawerTab = "ticket" | "chat" | "family" | "huddle" | "changes" | "outputs" | "usage";

/** The ticket panel's tabs, in order. Phones get a Ticket tab first (details and description), which the sidebar shows elsewhere. */
/**
 * The ticket panel's tabs, in order. Family only when the ticket has a family (it holds the plan controls too); Huddle and Changes only once they have something to show; Usage is reached from
 * the cost chip, so it is a tab only while open (usage).
 */
export function drawerTabs({ phone, family, changes, huddle = true, usage = true }: {
  phone: boolean; family: boolean; changes: boolean; huddle?: boolean; usage?: boolean;
}): DrawerTab[] {
  const on: Record<DrawerTab, boolean> = { ticket: phone, chat: true, family, huddle, changes, outputs: true, usage };
  return (["ticket", "chat", "family", "huddle", "changes", "outputs", "usage"] as const).filter((t) => on[t]);
}

/** [ / ] in the ticket panel: the visible tab `delta` steps away from the current one, wrapping around. */
export function stepTab<T>(tabs: T[], current: T, delta: number): T | null {
  const at = stepBoard(tabs.length, tabs.indexOf(current), delta);
  return at < 0 ? null : tabs[at];
}

type PlainKeys = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean };
const plain = (e: PlainKeys) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;

/** Focus is inside the bottom panel (Terminal, Files, Team) or the side chat: the board's single keys stay quiet there. */
export function inDock(e: { target: EventTarget | null }): boolean {
  const el = e.target as { closest?: (sel: string) => unknown } | null;
  return !!el?.closest?.(".dock, .side-chat");
}

/** N, ? and B also work while a ticket panel has the keyboard (not while typing): new ticket, this list, board picker. */
export type PanelBoardKey = "new" | "shortcuts" | "boards";
export function panelBoardKey(e: PlainKeys): PanelBoardKey | null {
  if (!plain(e)) return null;
  switch (e.key) {
    case "n": case "N": return "new";
    case "?": return "shortcuts";
    case "b": case "B": return "boards";
    default: return null;
  }
}

/** Single keys on a focused board card: S star, M move to a column, D mark done (Review cards). */
export type CardKey = "star" | "move" | "done";
export function cardKey(e: PlainKeys & { shiftKey: boolean }): CardKey | null {
  if (!plain(e) || e.shiftKey) return null;
  switch (e.key) {
    case "s": case "S": return "star";
    case "m": case "M": return "move";
    case "d": case "D": return "done";
    default: return null;
  }
}

/** U (when not typing): run the Undo of the newest toast that has one. */
export function isUndoKey(e: PlainKeys & { shiftKey: boolean }): boolean {
  return plain(e) && !e.shiftKey && (e.key === "u" || e.key === "U");
}

/** I on the board: open the Inbox with its first entry focused. */
export function isInboxKey(e: PlainKeys & { shiftKey: boolean }): boolean {
  return plain(e) && !e.shiftKey && (e.key === "i" || e.key === "I");
}

/**
 * Esc in a text box (the chat box, the title, a tag field) that nothing else used: leave the box for the panel around it.
 * The draft stays; a second Esc then closes the panel.
 */
export function escLeavesField(e: { key: string; isComposing?: boolean; defaultPrevented: boolean; target: EventTarget | null }): boolean {
  return e.key === "Escape" && !e.isComposing && !e.defaultPrevented && isTyping(e);
}

/** The item `delta` steps from `at` in a list of `count`, stopping at the ends (no wrap). -1 for an empty list. */
export function stepIndex(count: number, at: number, delta: number): number {
  if (count <= 0) return -1;
  if (at < 0) return delta < 0 ? count - 1 : 0;
  return Math.max(0, Math.min(count - 1, at + delta));
}

/** Keys in a list picker (Move to column): ↑/K and ↓/J move, Enter picks, 1…9 picks that row. */
export type ListKey = { move: number } | { pick: number | "active" } | null;
export function listKey(e: PlainKeys & { shiftKey: boolean; code?: string }): ListKey {
  if (!plain(e) || e.shiftKey) return null;
  if (e.key === "ArrowDown" || e.key === "j" || e.key === "J") return { move: 1 };
  if (e.key === "ArrowUp" || e.key === "k" || e.key === "K") return { move: -1 };
  if (e.key === "Enter") return { pick: "active" };
  const digit = e.code ? boardDigit(e.code) : null;
  return digit === null ? null : { pick: digit };
}
