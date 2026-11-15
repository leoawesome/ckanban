// Follow-up work asked for in the chat of a ticket that already ran (replaces the old add-on tickets). The proposal
// card there makes it a step that reports to the feature's main ticket, so the user keeps talking where they are.
// No imports from ./api: the server and its tests import this file too.
import { fitParent, levelOf, MAX_LEVEL, parentLink, type FamilyTicket } from "./family";

export interface FollowUpTicket extends FamilyTicket {
  main?: boolean;
  tool?: boolean;
  kind?: string | null;
  /** The ticket whose chat card made this one. */
  madeFrom?: string | null;
  proposedAs?: string | null;
}

/**
 * A proposal on this ticket is follow-up work (see ProposalCard's FollowUp) when the ticket already did its work: it is
 * in Review or Done, came back to Planning/Backlog from there, or ran before. Returns how the card names its state
 * ("Done", "In review", null when it only ran), or undefined when Apply works as usual: a ticket that never ran, a main
 * ticket (its card updates its own plan; new work goes to its steps) and a step.
 */
export function followUpState(t: { status: string; runCount: number; main?: boolean; tool?: boolean; reopenedFrom?: { status: string; outcome?: string | null } | null }): string | null | undefined {
  if (t.main || t.tool) return undefined;
  const shaping = t.status === "planning" || t.status === "backlog";
  const was = shaping && t.reopenedFrom ? t.reopenedFrom.status : t.status;
  if (was === "done") return "Done";
  if (was === "review") return "In review";
  return t.runCount > 0 ? null : undefined;
}

/**
 * Where follow-up work on a ticket goes:
 * - step: the ticket belongs to a feature (a main ticket above it). The work is a step run by `manager` (the nearest
 *   group or round above it with room, else the main ticket), so its result reaches the main ticket; it shows under
 *   the ticket itself (`partOf`), or beside it when the family would get too deep (null: right under the manager).
 * - main: the ticket stands alone (no parent): it becomes a main ticket and the work its first step.
 * - ticket: an old ticket under others but without a main ticket above it: a new ticket next to it (partOf).
 */
export type FollowUpPlace =
  | { as: "step"; main: { id: string; title: string }; manager: string; partOf: string | null }
  | { as: "main" }
  | { as: "ticket"; partOf: string };

const runsSteps = (t: FollowUpTicket) => !!t.main || (!!t.tool && (t.kind === "group" || t.kind === "round"));

export function followUpPlace<T extends FollowUpTicket>(tickets: T[], id: string): FollowUpPlace | null {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const t = byId.get(id);
  if (!t) return null;
  // Its ancestors, nearest first (a deleted parent or a loop in old data ends the walk).
  const up: T[] = [];
  const seen = new Set([t.id]);
  for (let p = byId.get(parentLink(t)?.id ?? ""); p && !seen.has(p.id); p = byId.get(parentLink(p)?.id ?? "")) {
    seen.add(p.id);
    up.push(p);
  }
  const main = up.find((p) => p.main);
  if (main) {
    const manager = up.slice(0, up.indexOf(main)).find((p) => runsSteps(p) && levelOf(tickets, p.id) + 1 <= MAX_LEVEL) ?? main;
    const spot = fitParent(tickets, t.id);
    return { as: "step", main: { id: main.id, title: main.title }, manager: manager.id, partOf: spot === manager.id ? null : spot };
  }
  if (!up.length) return { as: "main" };
  return { as: "ticket", partOf: fitParent(tickets, t.id) };
}

/** The ticket a proposal card on `of` already made: by the title it was proposed with (its run may rename it). */
export function followUpFor<T extends Pick<FollowUpTicket, "title" | "madeFrom" | "proposedAs">>(tickets: T[], of: string, title: string): T | undefined {
  const own = tickets.filter((t) => t.madeFrom === of);
  return own.find((t) => t.proposedAs === title.trim()) ?? own.find((t) => t.title === title.trim());
}
