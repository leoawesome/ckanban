// The board loads its finished tickets in pieces (server: ticketScope.ts): Done's pages, search finds and tickets
// opened directly. These keep the board's one list of tickets and the Done count right as the pieces arrive.
import { groupByColumn, type Status } from "./columns";
import { onBoard } from "./family";

type Countable = { id: string; status: string; tool?: boolean; showOnBoard?: boolean | null };

/** Finished tickets with a Done card in this list. */
export const doneCards = (tickets: Countable[]): number => tickets.filter((t) => t.status === "done" && onBoard(t)).length;

type Dated = { id: string; updatedAt?: string };

/**
 * The copy to hold: the fresh one, unless the held one was saved later. An answer the server worked out before a move
 * can arrive after that move's live update (two connections): its older copy would put the card back where it was.
 */
const newest = <T extends Dated>(held: T, fresh: T): T => (held.updatedAt && fresh.updatedAt && held.updatedAt > fresh.updatedAt ? held : fresh);

/** The fresh copies replace the held ones (unless a held one is newer); new ones go at the end. */
export function mergeTickets<T extends Dated>(held: T[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((t) => [t.id, t]));
  const have = new Set(held.map((t) => t.id));
  return [...held.map((t) => {
    const f = byId.get(t.id);
    return f ? newest(t, f) : t;
  }), ...fresh.filter((t) => !have.has(t.id))];
}

/** Done cards the server has that this list doesn't (doneTotal: the server's count when `tickets` arrived). */
export const unseenDone = (doneTotal: number, tickets: Countable[]): number => Math.max(0, doneTotal - doneCards(tickets));

/**
 * A ticket.updated event for a ticket this list doesn't hold: a new ticket joins the board, but a finished one stays
 * out (it is one of Done's not-yet-loaded cards, and loads with its page).
 */
export const joinsBoard = (t: { status: string }): boolean => t.status !== "done";

/** Done cards per page (the server sends this many: ticketScope.ts DONE_PAGE). */
export const DONE_PAGE = 20;

/** Same content (a fresh copy from the server that changed nothing): keep the held object, so its card doesn't redraw. */
const sameTicket = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A reload's answer (unfinished work, Done's first page and extra ids) merged into the held list: fresh copies replace
 * held ones (unchanged ones keep the held object), held finished tickets the answer didn't include stay (Done's later
 * pages, search finds), and held unfinished ones it didn't include are gone (deleted, or finished beyond the first page).
 */
export function reloadTickets<T extends Dated & { status: string }>(held: T[], fresh: T[], gone?: (t: T) => boolean): T[] {
  const heldById = new Map(held.map((t) => [t.id, t]));
  const freshIds = new Set(fresh.map((t) => t.id));
  const out = fresh.map((t) => {
    const h = heldById.get(t.id);
    return h && (sameTicket(h, t) || newest(h, t) === h) ? h : t;
  });
  // gone: a held finished ticket the answer should have had (the reload asked for every page held): it was deleted,
  // or moved down past them (its page brings it back).
  for (const t of held) if (!freshIds.has(t.id) && t.status === "done" && !gone?.(t)) out.push(t);
  return out;
}

type Paged = Countable & { status: Status; order: number; pinnedAt?: string | null };

/**
 * Held finished tickets with a Done card, in the Done column's order as the server sorts it (ticketScope.ts doneColumn).
 * The server groups its raw tickets, which carry no live run fields: a Done main ticket with a running step stays in
 * its Done list there (the board shows it in In progress), so these fields are left out here too.
 */
export const heldDoneColumn = <T extends Paged>(tickets: T[]): T[] => {
  const raw = tickets.filter((t) => t.status === "done" && onBoard(t)).map((t) => ({ ...t, stepsRunning: 0, familyWorking: 0, slotWait: null, held: t }));
  return (groupByColumn(raw).get("done") ?? []).map((r) => r.held);
};

/**
 * Where Done's next page starts: after the last held card that came by page (the server pages by this id, so a card
 * leaving Done or joining it above between two pages skips nothing), and how many cards came by page (offset, for a
 * daemon that doesn't know the id). paged: ids of the cards Done's pages brought.
 */
export function doneCursor<T extends Paged>(held: T[], paged: Set<string>): { after: string | null; offset: number } {
  const mine = heldDoneColumn(held).filter((t) => paged.has(t.id));
  return { after: mine.length ? mine[mine.length - 1].id : null, offset: mine.length };
}

/**
 * The Done cards a reload asked for by count (`done`: the first n of the column): the first n Done cards of its answer
 * in the column's order. The answer's other Done cards (finished steps of open families, asked ids) are all further
 * down the column than those n, so they never come first.
 */
export function donePrefix<T extends Paged>(answer: T[], n: number): string[] {
  return n > 0 ? heldDoneColumn(answer).slice(0, n).map((t) => t.id) : [];
}

/**
 * A short fingerprint of Done card ids in order (FNV-1a with the count). The server sends one for its column up to the
 * board's cursor, the page works it out for the cards it holds: different means Done changed above the cursor while the
 * page wasn't looking (deleted, finished, dropped or reordered there).
 */
export function doneIdsHash(ids: string[]): string {
  let h = 0x811c9dc5;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 10, 0x01000193);
  }
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/** The fingerprint of the held Done cards from the top down to `after` (null: that card isn't a held Done card). */
export function heldDoneHead<T extends Paged>(held: T[], after: string): string | null {
  const column = heldDoneColumn(held);
  const at = column.findIndex((t) => t.id === after);
  return at < 0 ? null : doneIdsHash(column.slice(0, at + 1).map((t) => t.id));
}

/**
 * What a reload asks for. done: Done cards by count, at most the first page's worth (a board scrolled down 9,500
 * cards would be megabytes), all of them when `full`. full: the answer covers every card that came by page, so held
 * ones it lacks are gone. ids: finished tickets fetched outside the pages (kept), plus `touched` (a failed move's card,
 * so its rollback finds it wherever it sits in Done). after: the cursor, when not full: the server answers with the
 * fingerprint of its Done column down to it (doneHead), to check the held cards above it.
 */
export function reloadAsk<T extends Paged>(held: T[], paged: Set<string>, extras: Set<string>, touched: string[] = [], full = false): { done: number; ids: string[]; full: boolean; after: string | null } {
  const at = doneCursor(held, paged);
  const done = full ? at.offset : Math.min(at.offset, DONE_PAGE);
  const all = full || at.offset <= DONE_PAGE;
  return { done, ids: [...new Set([...[...extras].slice(-150), ...touched])], full: all, after: all ? null : at.after };
}

/**
 * A reload's answer applied: the tickets to hold, and the ids that came by page now. When the answer covers every paged
 * card (`ask.full`), a held finished ticket it lacks is dropped, unless it is an extra the reload didn't ask for. Either
 * way an asked id the answer lacks is gone (deleted).
 */
export function takeReload<T extends Paged>(held: T[], answer: T[], paged: Set<string>, extras: Set<string>, ask: { done: number; ids: string[]; full: boolean }): { tickets: T[]; paged: Set<string> } {
  const prefix = donePrefix(answer, ask.done);
  const asked = new Set(ask.ids);
  if (!ask.full) {
    const next = new Set(paged);
    for (const id of prefix) next.add(id);
    return { tickets: reloadTickets(held, answer, (t) => asked.has(t.id)), paged: next };
  }
  const gone = (t: T) => !extras.has(t.id) || asked.has(t.id);
  return { tickets: reloadTickets(held, answer, gone), paged: new Set(prefix) };
}

/**
 * After a reload that asked for Done's first page only: did Done change above the cursor while the board wasn't
 * looking (a reconnect)? The server's fingerprint of its column down to the cursor (doneHead) against the held cards'
 * (heldHead, after the answer is applied); then reload once more with every paged card (reloadAsk full). A daemon
 * without doneHead: the unseen count (the server's Done cards not held) moving is the sign.
 */
export function doneDrifted(ask: { full: boolean; after: string | null }, doneHead: string | null | undefined, heldHead: string | null, unseenBefore: number, unseenAfter: number): boolean {
  if (ask.full || !ask.after) return false;
  if (doneHead === undefined) return unseenBefore !== unseenAfter;
  return doneHead === null || doneHead !== heldHead;
}
