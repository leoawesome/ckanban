// No imports from ./api: the server's tests import this file, and api.ts needs the browser's types.
interface Linkable { id: string; title: string; status: string; addOnOf?: string | null; createdAt: string }

/**
 * A proposal on this ticket becomes an add-on ticket (see ProposalCard's AddOn) when the ticket already did its work:
 * it is in Review or Done, came back to Planning/Backlog from there, or ran before. Returns how the card names its
 * state ("Done", "In review", null when it only ran), or undefined for a ticket that never ran (Apply as usual).
 * Never for a main ticket: its card updates its own plan, and new work goes to its tool tickets.
 */
export function addOnState(t: { status: string; runCount: number; main?: boolean; reopenedFrom?: { status: string; outcome?: string | null } | null }): string | null | undefined {
  if (t.main) return undefined;
  const shaping = t.status === "planning" || t.status === "backlog";
  const was = shaping && t.reopenedFrom ? t.reopenedFrom.status : t.status;
  if (was === "done") return "Done";
  if (was === "review") return "In review";
  return t.runCount > 0 ? null : undefined;
}

/** The add-on made from a proposal: a ticket linked to this one with the proposed title. */
export function addOnFor<T extends Pick<Linkable, "title" | "addOnOf"> & { proposedAs?: string | null }>(tickets: T[], of: string, title: string): T | undefined {
  const own = tickets.filter((t) => t.addOnOf === of);
  // The title it was proposed with first: the add-on's own run may have renamed it.
  return own.find((t) => t.proposedAs === title.trim()) ?? own.find((t) => t.title === title.trim());
}

