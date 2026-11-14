// Which tickets the board's first load gets, and the Done column's pages (GET /profiles/:p/tickets?scope=…).
// A board keeps hundreds of finished tickets: the first load sends only the work that isn't finished, with whole
// families (a ticket's steps, its main ticket and their links), so family chips, the Family tab and the search's
// "via" all still find their tickets. Done arrives 20 at a time when the user opens the column, or by search.
import { groupByColumn } from "../../web/src/columns";
import { onBoard, parentLink, type FamilyTicket } from "../../web/src/family";
import { hasTags } from "../../web/src/tagText";
import { doneIdsHash } from "../../web/src/donePaging";

type Scoped = FamilyTicket & { status: string; order: number; pinnedAt?: string | null; tool?: boolean; showOnBoard?: boolean | null; body?: string | null; tags?: string[] };

/**
 * What every scope works out from the whole board: each ticket's family key and the Done column in its order. The
 * daemon keeps one per board while its ticket listing holds the very same tickets, so a load or a page
 * doesn't walk the families and sort thousands of Done tickets again.
 */
export interface ScopeIndex<T> {
  keys: Map<string, string>;
  column: T[];
}

export function scopeIndex<T extends Scoped>(tickets: T[]): ScopeIndex<T> {
  return { keys: familyKeys(tickets), column: doneColumn(tickets) };
}

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
export function boardScope<T extends Scoped>(tickets: T[], opts: { done?: number; ids?: string[]; after?: string | null } = {}, idx = scopeIndex(tickets)): { tickets: T[]; doneTotal: number; doneHead?: string | null } {
  const { keys, column } = idx;
  // after: the page's Done cursor. doneHead: the fingerprint of the column down to it (null: it isn't in Done now), so
  // a reload after a reconnect can tell whether Done changed above it (donePaging.ts doneDrifted).
  const head = opts.after ? column.findIndex((t) => t.id === opts.after) : -1;
  const doneHead = !opts.after ? undefined : head < 0 ? null : doneIdsHash(column.slice(0, head + 1).map((t) => t.id));
  const ids = new Set(opts.ids ?? []);
  const wanted = tickets.filter((t) => t.status !== "done" || ids.has(t.id));
  const picked = new Set(withFamilies(tickets, keys, wanted));
  for (const t of column.slice(0, Math.max(0, opts.done ?? 0))) picked.add(t);
  return { tickets: tickets.filter((t) => picked.has(t)), doneTotal: column.length, ...(doneHead === undefined ? {} : { doneHead }) };
}

/**
 * A page of the Done column, in its order. after: the id of the last card the page before ended with (the board's
 * cursor): the page starts right after it, so a card that left Done, or joined it above, between two pages neither
 * skips a card nor sends one twice. Without it, or when that card isn't in Done any more, offset counts cards of the
 * column (older pages, and the fallback).
 */
export function donePage<T extends Scoped>(tickets: T[], offset: number, limit = DONE_PAGE, column = doneColumn(tickets), after?: string | null): { tickets: T[]; doneTotal: number } {
  const at = after ? column.findIndex((t) => t.id === after) : -1;
  const from = at >= 0 ? at + 1 : Math.max(0, Math.floor(offset) || 0);
  return { tickets: column.slice(from, from + Math.max(1, Math.min(limit, 200))), doneTotal: column.length };
}

/**
 * Finished tickets matching the board's search (text in the title or the description, and any of the tags), with the
 * families of hidden steps that match so the search can show their main ticket's card. The newest matches first.
 */
export function doneSearch<T extends Scoped>(tickets: T[], text: string, tags: string[], idx?: ScopeIndex<T>): { tickets: T[]; doneTotal: number } {
  const q = text.trim().toLowerCase();
  const column = idx?.column ?? doneColumn(tickets);
  if (!q && !tags.length) return { tickets: [], doneTotal: column.length };
  const hit = (t: T) => (!q || `${t.title}\n${t.body ?? ""}`.toLowerCase().includes(q)) && hasTags(t, tags);
  const found = tickets.filter((t) => t.status === "done" && hit(t)).slice(-SEARCH_LIMIT);
  const hidden = found.filter((t) => !onBoard(t));
  const shown = new Set(found.filter((t) => onBoard(t)));
  const families = new Set(hidden.length ? withFamilies(tickets, idx?.keys ?? familyKeys(tickets), hidden) : []);
  return { tickets: tickets.filter((t) => shown.has(t) || families.has(t)), doneTotal: column.length };
}

/** These tickets with their families (a finished ticket opened from a link, the Inbox or ⌘K, and its Family tab). */
export function idsScope<T extends Scoped>(tickets: T[], ids: string[], idx?: ScopeIndex<T>): { tickets: T[]; doneTotal: number } {
  const want = new Set(ids);
  const found = tickets.filter((t) => want.has(t.id));
  return { tickets: found.length ? withFamilies(tickets, idx?.keys ?? familyKeys(tickets), found) : [], doneTotal: (idx?.column ?? doneColumn(tickets)).length };
}

/** list_tickets' and `ticket list`'s page size when they don't name one, and the most one page holds. */
export const LIST_PAGE = 100;
export const LIST_MAX = 500;

/** What list_tickets and `ticket list` ask for (scope=list). */
export interface ListQuery {
  /** One column; none: every column but Done (open work), or every column for a search (q, tags). */
  status?: string | null;
  /** Also tool tickets (they have no card; get_family lists one feature's). */
  tool?: boolean;
  /** Words in the title, the description or the id (one phrase, any case); at most SEARCH_LIMIT matches. */
  q?: string | null;
  tags?: string[];
  limit?: number;
  /** The id the previous page ended with: the page goes on after it. */
  after?: string | null;
}

/**
 * A page of tickets for Claude's list_tickets and `ckanban ticket list`, filtered here instead of in the client.
 * Newest first by id (ids start with their creation day and never change), and a page goes on after the last id
 * of the one before: a ticket made, moved or deleted between two pages never shows twice and never pushes another
 * one out of view, as an offset would. total: tickets matching; doneLeft: Done tickets this answer leaves out
 * because no column was asked for (the "use status done, or query" line).
 */
/** The tickets newest first by id, the order listScope pages in (the daemon keeps it per board while nothing changes). */
export const byIdNewest = <T extends { id: string }>(tickets: T[]): T[] => [...tickets].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/** newest: the same tickets already in byIdNewest order (skips the sort). */
export function listScope<T extends Scoped>(tickets: T[], query: ListQuery = {}, newest = byIdNewest(tickets)): { tickets: T[]; total: number; matched: number; doneLeft: number; next: string | null } {
  const q = (query.q ?? "").trim().toLowerCase();
  const tags = query.tags ?? [];
  const searching = !!q || tags.length > 0;
  const max = searching ? SEARCH_LIMIT : LIST_MAX;
  const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 0) || LIST_PAGE, max));
  let doneLeft = 0;
  const matched: T[] = [];
  for (const t of newest) {
    if (!query.tool && t.tool) continue;
    // A search looks in every column (Done too) unless one is asked for; a plain listing skips Done.
    if (query.status ? t.status !== query.status : !searching && t.status === "done") {
      if (!query.status && t.status === "done") doneLeft++;
      continue;
    }
    if (q && !`${t.id}\n${t.title}\n${t.body ?? ""}`.toLowerCase().includes(q)) continue;
    if (tags.length && !hasTags(t, tags)) continue;
    matched.push(t);
  }
  // A search answers its best SEARCH_LIMIT (the newest) and no further pages, like the board's search.
  const pool = searching ? matched.slice(0, SEARCH_LIMIT) : matched;
  // matched: every match, so a search capped at SEARCH_LIMIT can say how many there were.
  const after = query.after ?? null;
  const from = after ? pool.findIndex((t) => t.id < after) : 0;
  const page = from < 0 ? [] : pool.slice(from, from + limit);
  const more = from >= 0 && from + limit < pool.length;
  return { tickets: page, total: pool.length, matched: matched.length, doneLeft, next: more ? page[page.length - 1].id : null };
}

/** The board settings' count: tickets in all, open ones (not Done), and the Done column's cards. */
export function countScope<T extends Scoped>(tickets: T[], column: T[] = doneColumn(tickets)): { total: number; open: number; doneTotal: number } {
  let open = 0;
  for (const t of tickets) if (t.status !== "done") open++;
  return { total: tickets.length, open, doneTotal: column.length };
}
