// The plan a plan review huddle checks (outputs/huddles/<id>/proposal.md): the latest ticket the Planning chat proposed,
// as written, with no chat text. Reviewers read only this, so they see the plan the way the worker will (see
// PLAN_REVIEW_READ). Pure: Huddles.create reads the chat and writes the file.
import type { SessionEntry, TicketProposal } from "../runs/session";

interface PlanTicket {
  id: string;
  title: string;
  body: string;
}

/** The proposal file's text from the chat's entries (failed tool calls are already left out of them). */
export function planProposal(t: PlanTicket, entries: SessionEntry[]): string {
  const proposal: TicketProposal | undefined = entries.findLast((e) => e.role === "assistant" && e.proposal)?.proposal;
  const head = `# Plan under review (ticket ${t.id})`;
  if (!proposal) {
    return `${head}

Nothing was proposed in the ticket's chat, so this is the ticket's current title and description.

## Ticket: ${t.title}

${t.body.trim() || "(no description)"}
`;
  }
  return `${head}

The latest ticket proposed in the ticket's chat, as written.

---

## Proposed ticket: ${proposal.title || t.title}

${proposal.description || "(no description)"}
`;
}
