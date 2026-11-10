// Tasks (a main ticket's helpers) have no card unless shown on the board: the board shows one card per feature. Search
// still finds a hidden task and shows its main ticket's card with "via <task title>"; a task shown on the board is a
// card like any other (onBoard). No imports from api.ts, so tests load it.
import { mainTicketOf, onBoard, type FamilyTicket } from "./family";

type Searchable = FamilyTicket & { body: string; main?: boolean; tool?: boolean; kind?: string | null; showOnBoard?: boolean | null };

/**
 * The cards a board search shows. hit: the text match (empty query: every ticket); keep: tags and filter chips.
 * via: main ticket id to the title of the tool ticket that matched, when the main ticket didn't match itself.
 */
export function searchBoard<T extends Searchable>(tickets: T[], hit: (t: T) => boolean, keep: (t: T) => boolean = () => true, query = true): { shown: T[]; via: Map<string, string> } {
  const via = new Map<string, string>();
  if (query) {
    for (const t of tickets) {
      if (onBoard(t) || !hit(t)) continue;
      const main = mainTicketOf(tickets, t.id);
      if (main && onBoard(main) && !hit(main) && !via.has(main.id)) via.set(main.id, t.title);
    }
  }
  const shown = tickets.filter((t) => onBoard(t) && (hit(t) || via.has(t.id)) && keep(t));
  return { shown, via };
}
