/**
 * The side panel column's state, kept per board in the browser (SidePanels.tsx): which panels are open and in what
 * order, which are folded, how they share the column's height, the column's width and whether it shows. Pure, so it
 * is tested (test/panelState.test.ts).
 */

export type PanelId = "terminal" | "files" | "changes" | "team" | "claude";

export const PANELS: { id: PanelId; label: string; keys?: string }[] = [
  { id: "terminal", label: "Terminal", keys: "Ctrl+`" },
  { id: "files", label: "Files", keys: "F" },
  { id: "changes", label: "Changes" },
  { id: "team", label: "Team", keys: "T" },
  { id: "claude", label: "Claude", keys: "C" },
];
export const panelLabel = (id: PanelId) => PANELS.find((p) => p.id === id)!.label;
const isPanel = (v: unknown): v is PanelId => typeof v === "string" && PANELS.some((p) => p.id === v);

export interface PanelsState {
  /** Open panels, top to bottom. */
  open: PanelId[];
  /** The column shows (the Panels button hides it without closing its panels). */
  shown: boolean;
  /** Open panels showing only their header. */
  folded: PanelId[];
  /** Each panel's share of the column's height (flex-grow); missing: 1. */
  shares: Partial<Record<PanelId, number>>;
  /** The column's wanted width; null: the default. */
  width: number | null;
}

export const NO_PANELS: PanelsState = { open: [], shown: false, folded: [], shares: {}, width: null };

export const panelsKey = (slug: string) => `ckanban.panels.${slug}`;
/** Set once the old bottom panel and side chat state was moved over (to the first board opened after the upgrade). */
export const MIGRATED_KEY = "ckanban.panels.migrated";
/** The old bottom panel's and side chat's keys, removed by the move. */
export const OLD_KEYS = [
  "ckanban.dock.open", "ckanban.dock.tab", "ckanban.dock.height",
  ...["terminal", "files", "team", "claude", "huddles"].map((t) => `ckanban.dock.height.${t}`),
  "ckanban.sideChat.open", "ckanban.sideChat.width",
];

const MIN_SHARE = 0.05;
const MAX_SHARE = 20;

/** A saved state, cleaned up (unknown panels, duplicates and broken numbers dropped); null when missing or unreadable. */
export function parsePanels(raw: string | null): PanelsState | null {
  if (!raw) return null;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const open = Array.isArray(v.open) ? [...new Set(v.open.filter(isPanel))] as PanelId[] : [];
  const folded = Array.isArray(v.folded) ? (v.folded as unknown[]).filter((p): p is PanelId => isPanel(p) && open.includes(p)) : [];
  const shares: PanelsState["shares"] = {};
  if (v.shares && typeof v.shares === "object") {
    for (const [k, n] of Object.entries(v.shares)) {
      if (isPanel(k) && typeof n === "number" && Number.isFinite(n) && n > 0) shares[k] = Math.min(MAX_SHARE, Math.max(MIN_SHARE, n));
    }
  }
  const width = typeof v.width === "number" && Number.isFinite(v.width) && v.width > 0 ? v.width : null;
  return { open, shown: v.shown === true && open.length > 0, folded: [...new Set(folded)], shares, width };
}

/**
 * The old bottom panel (one item at a time) and the old side chat, as panels in the column: a bottom panel left open
 * on an item opens that item, an open side chat opens Claude, and the chat's width becomes the column's.
 */
export function migrateOldPanels(get: (key: string) => string | null): PanelsState | null {
  const open: PanelId[] = [];
  if (get("ckanban.dock.open") === "1") {
    const tab = get("ckanban.dock.tab");
    const id = tab === "huddles" ? "team" : isPanel(tab) ? tab : "terminal";
    open.push(id);
  }
  if (get("ckanban.sideChat.open") === "1" && !open.includes("claude")) open.push("claude");
  const w = Number(get("ckanban.sideChat.width"));
  const width = Number.isFinite(w) && w > 0 ? w : null;
  if (!open.length && width === null) return null;
  return { ...NO_PANELS, open, shown: open.length > 0, width };
}

type Storage = { get: (k: string) => string | null; set: (k: string, v: string) => void; remove: (k: string) => void };

/** The board's saved state; the first board read after the upgrade takes over the old bottom panel and side chat once. */
export function loadPanels(store: Storage, slug: string): PanelsState {
  const saved = parsePanels(store.get(panelsKey(slug)));
  if (store.get(MIGRATED_KEY)) return saved ?? NO_PANELS;
  const moved = migrateOldPanels(store.get);
  store.set(MIGRATED_KEY, "1");
  for (const k of OLD_KEYS) store.remove(k);
  if (saved) return saved;
  if (moved) store.set(panelsKey(slug), JSON.stringify(moved));
  return moved ?? NO_PANELS;
}

/** Opens the panel (at the bottom when it wasn't open), unfolded, and shows the column. */
export function openPanel(s: PanelsState, id: PanelId): PanelsState {
  return { ...s, open: s.open.includes(id) ? s.open : [...s.open, id], folded: s.folded.filter((p) => p !== id), shown: true };
}

/** Closes the panel; the column hides with its last panel. Its height share is kept for next time. */
export function closePanel(s: PanelsState, id: PanelId): PanelsState {
  const open = s.open.filter((p) => p !== id);
  return { ...s, open, folded: s.folded.filter((p) => p !== id), shown: s.shown && open.length > 0 };
}

/** A Panels menu checkbox. */
export const togglePanel = (s: PanelsState, id: PanelId) => (s.open.includes(id) ? closePanel(s, id) : openPanel(s, id));

export function toggleFold(s: PanelsState, id: PanelId): PanelsState {
  return { ...s, folded: s.folded.includes(id) ? s.folded.filter((p) => p !== id) : [...s.folded, id] };
}

/** Moves an open panel one place up (-1) or down (1). */
export function movePanel(s: PanelsState, id: PanelId, dir: -1 | 1): PanelsState {
  const i = s.open.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= s.open.length) return s;
  const open = s.open.slice();
  [open[i], open[j]] = [open[j], open[i]];
  return { ...s, open };
}

/** The Panels button: hides the column, or shows it again (only when it has panels). */
export const toggleColumn = (s: PanelsState): PanelsState => ({ ...s, shown: !s.shown && s.open.length > 0 });

export const shareOf = (s: PanelsState, id: PanelId) => s.shares[id] ?? 1;

/**
 * Dragging the divider between two panels by `delta` px (down: the upper one grows). They share their combined height
 * (`aPx` + `bPx`) and their combined share; neither goes under `minPx`. Returns their new shares.
 */
export function resizePair(a: number, b: number, aPx: number, bPx: number, delta: number, minPx: number): [number, number] {
  const total = aPx + bPx;
  const sum = a + b;
  if (total <= 0 || sum <= 0) return [a, b];
  const lo = Math.min(minPx, total / 2);
  const nextA = Math.min(total - lo, Math.max(lo, aPx + delta));
  const shareA = (nextA / total) * sum;
  return [shareA, sum - shareA];
}

/** The "where" hint in a panel's header: the folder its Terminal or Files work in, or the ticket its Changes are from. */
export function whereHint(id: PanelId, ticket: { worktree: string | null } | null): string {
  if (id === "terminal" || id === "files") return ticket?.worktree ? "ticket copy" : "board folder";
  if (id === "changes") return ticket ? (ticket.worktree ? "ticket copy" : "board folder") : "";
  if (id === "claude") return "board folder";
  return "";
}
