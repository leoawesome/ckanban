import { type CardPos } from "./keynav";

/**
 * URL hash is the source of truth for what's open: #/<profile> or #/<profile>/<ticketId>. Pages that aren't a board
 * start with "~" (#/~messages, helper.ts) and leave the board and ticket as they are.
 */
export function parseHash(): { slug: string | null; ticket: string | null } {
  if (location.hash.startsWith("#/~")) return { slug: null, ticket: null };
  let path = location.hash.replace(/^#/, "").replace(/\?.*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {}
  const [, slug, ticket] = path.split("/");
  return { slug: slug || null, ticket: ticket || null };
}

export function hashFor(slug: string | null, ticket?: string | null): string {
  if (!slug) return "#/";
  return `#/${encodeURIComponent(slug)}${ticket ? `/${encodeURIComponent(ticket)}` : ""}`;
}

/** Cards on screen, per expanded column, in board order. */
export function cardGrid(): HTMLElement[][] {
  return [...document.querySelectorAll<HTMLElement>(".board > .column:not(.collapsed)")]
    .map((c) => [...c.querySelectorAll<HTMLElement>(".column-body > .sortable-card")]);
}

export function focusedCard(grid: HTMLElement[][]): CardPos | null {
  const el = (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card");
  for (let col = 0; col < grid.length; col++) {
    const row = grid[col].findIndex((c) => c === el);
    if (row >= 0) return { col, row };
  }
  return null;
}

/** The board card that has the keyboard, if any (its ticket id). */
export function focusedCardId(): string | null {
  return (document.activeElement as HTMLElement | null)?.closest?.(".sortable-card")?.getAttribute("data-ticket") ?? null;
}

/** Give a card the keyboard again by ticket id (after it moved to another column, its element is a new one). */
export function refocusCard(id: string) {
  setTimeout(() => {
    const el = [...document.querySelectorAll<HTMLElement>(".sortable-card")].find((c) => c.dataset.ticket === id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

export function focusCard(pos: CardPos | null, grid = cardGrid()) {
  const col = pos && grid[pos.col];
  const el = col && col[Math.min(pos.row, col.length - 1)];
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}
