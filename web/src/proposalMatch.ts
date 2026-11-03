/** Which ticket a card's proposal already became, so the card shows it as created and Create can't make it twice. */
interface Matchable { id: string; title: string; parentId?: string | null; planKey?: string | null; proposedAs?: string | null }

/** Two titles name the same ticket: case and spacing don't count (the server's titleKey). */
export const sameTitle = (a: string, b: string) => norm(a) === norm(b);
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The ticket a proposed draft in `parentId`'s chat became. Its own child first, by the title it was proposed with (that
 * survives a rename, a start or a move), or for a child made before cards saved that title, by the draft's key; then by
 * its current title; else any other ticket on the board with that title (made by hand or from another chat), which
 * counts as handled too. A key alone never matches a child that has a proposed title: a later card may reuse the key.
 */
export function createdFromDraft<T extends Matchable>(tickets: T[], parentId: string, d: { title: string; key?: string }): T | undefined {
  const kids = tickets.filter((t) => t.parentId === parentId);
  return kids.find((t) => !!t.proposedAs && sameTitle(t.proposedAs, d.title))
    ?? (d.key ? kids.find((t) => !t.proposedAs && t.planKey === d.key) : undefined)
    ?? kids.find((t) => sameTitle(t.title, d.title))
    ?? tickets.find((t) => t.id !== parentId && sameTitle(t.title, d.title));
}
