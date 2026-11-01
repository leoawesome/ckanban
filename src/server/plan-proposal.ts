// The plan a plan review huddle checks (outputs/huddles/<id>/proposal.md): the latest ticket and child tickets the
// Planning chat proposed, as written, with no chat text. Reviewers read only this, so they see the plan the way the
// worker will (see PLAN_REVIEW_READ). Pure: Huddles.create reads the chat and writes the file.
import type { NewTicketDraft, SessionEntry, TicketProposal } from "./session";

interface PlanTicket {
  id: string;
  title: string;
  body: string;
}

/** The proposal file's text from the chat's entries (failed tool calls are already left out of them). */
export function planProposal(t: PlanTicket, entries: SessionEntry[]): string {
  const proposal: TicketProposal | undefined = entries.findLast((e) => e.role === "assistant" && e.proposal)?.proposal;
  const children: NewTicketDraft[] | undefined = entries.findLast((e) => e.role === "assistant" && e.newTickets?.length)?.newTickets;
  const head = `# Plan under review (ticket ${t.id})`;
  if (!proposal && !children) {
    return `${head}

Nothing was proposed in the ticket's chat, so this is the ticket's current title and description.

## Ticket: ${t.title}

${t.body.trim() || "(no description)"}
`;
  }
  const parts = [`${head}\n\nThe latest ${[proposal && "ticket", children && "child tickets"].filter(Boolean).join(" and ")} proposed in the ticket's chat, as written.`];
  if (proposal) parts.push(`## Proposed ticket: ${proposal.title || t.title}\n\n${proposal.description || "(no description)"}`);
  if (children) {
    parts.push(`## Child tickets (${children.length})\n\n${children.map((c, i) => `- ${c.key ?? `ticket-${i + 1}`}: ${c.title}`).join("\n")}`);
    children.forEach((c, i) => {
      const deps = c.dependsOn?.length ? `Depends on: ${c.dependsOn.join(", ")}\n\n` : "";
      parts.push(`## Child ticket ${c.key ?? `ticket-${i + 1}`}: ${c.title}\n\n${deps}${c.description || "(no description)"}`);
    });
  }
  return `${parts.join("\n\n---\n\n")}\n`;
}
