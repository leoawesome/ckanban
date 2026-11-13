// Which tickets the board's first load gets, and the Done column's pages (GET /profiles/:p/tickets?scope=…).
// A board keeps hundreds of finished tickets: the first load sends only the work that isn't finished, with whole
// families (a ticket's steps, its main ticket and their links), so family chips, the Family tab and the search's
// "via" all still find their tickets. Done arrives 20 at a time when the user opens the column, or by search.
import { groupByColumn } from "../../web/src/columns";
import { onBoard, parentLink, type FamilyTicket } from "../../web/src/family";
import { hasTags } from "../../web/src/tagText";

type Scoped = FamilyTicket & { status: string; order: number; pinnedAt?: string | null; tool?: boolean; showOnBoard?: boolean | null; body?: string | null; tags?: string[] };

/** The Done column's size per page. */
export const DONE_PAGE = 20;
/** Most finished tickets one search sends. */
export const SEARCH_LIMIT = 100;

/** Each ticket's family key (its top ticket's id). A loop in old data stops the walk. */
export function familyKeys<T extends Scoped>(tickets: T[]): Map<string, string> {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  const rootOf = (t: T): string => {
    const known = out.get(t.id);
    if (known) return known;
    const path: T[] = [];
    const seen = new Set<string>();
    let cur: T = t;
    let root: string | undefined;
    for (;;) {
      const hit = out.get(cur.id);
      if (hit) { root = hit; break; }
      path.push(cur);
      seen.add(cur.id);
      const l = parentLink(cur);
      const up = l && l.id !== cur.id ? byId.get(l.id) : undefined;
      if (!up || seen.has(up.id)) { root = cur.id; break; }
      cur = up;
    }
    for (const p of path) out.set(p.id, root);
    return root;
  };
  for (const t of tickets) rootOf(t);
  return out;
}

/** Finished tickets with a card in the Done column, in the column's order (📌 first, then the user's order). */
export function doneColumn<T extends Scoped>(tickets: T[]): T[] {
  return groupByColumn(tickets.filter((t) => t.status === "done" && onBoard(t)) as (T & { status: "done" })[]).get("done") ?? [];
}

/** These tickets and everyone in their families, in board order. */
function withFamilies<T extends Scoped>(tickets: T[], keys: Map<string, string>, wanted: Iterable<T>): T[] {
  const families = new Set<string>();
  for (const t of wanted) families.add(keys.get(t.id) ?? t.id);
  return tickets.filter((t) => families.has(keys.get(t.id) ?? t.id));
}

/**
 * The board's first load: every family with a ticket that isn't finished (whole: its finished steps too), plus the
 * first `done` tickets of the Done column and the asked `ids` with their families (tickets the user has open).
 * doneTotal: cards in the Done column, so it shows its count before any of them load.
 */
export function boardScope<T extends Scoped>(tickets: T[], opts: { done?: number; ids?: string[] } = {}): { tickets: T[]; doneTotal: number } {
  const keys = familyKeys(tickets);
  const ids = new Set(opts.ids ?? []);
  const column = doneColumn(tickets);
  const wanted = tickets.filter((t) => t.status !== "done" || ids.has(t.id));
  const picked = new Set(withFamilies(tickets, keys, wanted));
  for (const t of column.slice(0, Math.max(0, opts.done ?? 0))) picked.add(t);
  return { tickets: tickets.filter((t) => picked.has(t)), doneTotal: column.length };
}

/** A page of the Done column (offset counts cards of the column, in its order). */
export function donePage<T extends Scoped>(tickets: T[], offset: number, limit = DONE_PAGE): { tickets: T[]; doneTotal: number } {
  const column = doneColumn(tickets);
  const from = Math.max(0, Math.floor(offset) || 0);
  return { tickets: column.slice(from, from + Math.max(1, Math.min(limit, 200))), doneTotal: column.length };
}

/**
 * Finished tickets matching the board's search (text in the title or the description, and any of the tags), with the
 * families of hidden steps that match so the search can show their main ticket's card. The newest matches first.
 */
export function doneSearch<T extends Scoped>(tickets: T[], text: string, tags: string[]): { tickets: T[]; doneTotal: number } {
  const q = text.trim().toLowerCase();
  const column = doneColumn(tickets);
  if (!q && !tags.length) return { tickets: [], doneTotal: column.length };
  const hit = (t: T) => (!q || `${t.title}\n${t.body ?? ""}`.toLowerCase().includes(q)) && hasTags(t, tags);
  const found = tickets.filter((t) => t.status === "done" && hit(t)).slice(-SEARCH_LIMIT);
  const hidden = found.filter((t) => !onBoard(t));
  const shown = new Set(found.filter((t) => onBoard(t)));
  const families = new Set(hidden.length ? withFamilies(tickets, familyKeys(tickets), hidden) : []);
  return { tickets: tickets.filter((t) => shown.has(t) || families.has(t)), doneTotal: column.length };
}

/** These tickets with their families (a finished ticket opened from a link, the Inbox or ⌘K, and its Family tab). */
export function idsScope<T extends Scoped>(tickets: T[], ids: string[]): { tickets: T[]; doneTotal: number } {
  const want = new Set(ids);
  const found = tickets.filter((t) => want.has(t.id));
  return { tickets: found.length ? withFamilies(tickets, familyKeys(tickets), found) : [], doneTotal: doneColumn(tickets).length };
}
