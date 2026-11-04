// Tool tickets (a main ticket's hidden helpers) have no card: the board shows one card per feature. Search still finds
// them and shows their main ticket's card with "via <tool ticket title>". No imports from api.ts, so tests load it.
import { hiddenTool, mainTicketOf, type FamilyTicket } from "./family";

type Searchable = FamilyTicket & { body: string; main?: boolean; tool?: boolean; kind?: string | null };

/**
 * The cards a board search shows. hit: the text match (empty query: every ticket); keep: tags and filter chips.
 * via: main ticket id to the title of the tool ticket that matched, when the main ticket didn't match itself.
 */
export function searchBoard<T extends Searchable>(tickets: T[], hit: (t: T) => boolean, keep: (t: T) => boolean = () => true, query = true): { shown: T[]; via: Map<string, string> } {
  const via = new Map<string, string>();
  if (query) {
    for (const t of tickets) {
      if (!hiddenTool(t) || !hit(t)) continue;
      const main = mainTicketOf(tickets, t.id);
      if (main && !hiddenTool(main) && !hit(main) && !via.has(main.id)) via.set(main.id, t.title);
    }
  }
  const shown = tickets.filter((t) => !hiddenTool(t) && (hit(t) || via.has(t.id)) && keep(t));
  return { shown, via };
}
