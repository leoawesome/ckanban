// The board loads its finished tickets in pieces (server: ticketScope.ts): Done's pages, search finds and tickets
// opened directly. These keep the board's one list of tickets and the Done count right as the pieces arrive.
import { onBoard } from "./family";

type Countable = { id: string; status: string; tool?: boolean; showOnBoard?: boolean | null };

/** Finished tickets with a Done card in this list. */
export const doneCards = (tickets: Countable[]): number => tickets.filter((t) => t.status === "done" && onBoard(t)).length;

/** The fresh copies replace the held ones; new ones go at the end. */
export function mergeTickets<T extends { id: string }>(held: T[], fresh: T[]): T[] {
  const byId = new Map(fresh.map((t) => [t.id, t]));
  const have = new Set(held.map((t) => t.id));
  return [...held.map((t) => byId.get(t.id) ?? t), ...fresh.filter((t) => !have.has(t.id))];
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
