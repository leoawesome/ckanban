// A ticket's PRs: every PR its runs reported (Ticket.prs, oldest first) and the main one (Ticket.prUrl) that the
// Merge button, the PR box and the plan work on. Old tickets have only prUrl.
import type { Ticket, TicketPr } from "./types";

/** Merged or closed: the board stops watching it. */
export function prFinal(state: TicketPr["state"]): boolean {
  return state === "MERGED" || state === "CLOSED";
}

/** The ticket's PRs, oldest first; an old ticket's prUrl is its only one. */
export function ticketPrs(t: Pick<Ticket, "prUrl" | "prs" | "pr">): TicketPr[] {
  if (t.prs?.length) return t.prs;
  if (!t.prUrl) return [];
  const cached = t.pr?.url === t.prUrl ? t.pr : null;
  return [{ url: t.prUrl, state: cached?.state ?? null, ...(cached?.base ? { base: cached.base } : {}) }];
}

/** The main PR: the newest one not known to be merged or closed, else the newest. */
export function mainPr(prs: TicketPr[]): string | null {
  return (prs.findLast((p) => !prFinal(p.state)) ?? prs.at(-1))?.url ?? null;
}

/** The patch that adds these PRs to the ticket (new ones at the end, no duplicates), or {} when none is new. */
export function addPrs(t: Pick<Ticket, "prUrl" | "prs" | "pr">, urls: string[]): Pick<Ticket, "prs" | "prUrl"> | Record<string, never> {
  const prs = ticketPrs(t);
  const known = new Set(prs.map((p) => p.url));
  const added = [...new Set(urls)].filter((u) => !known.has(u)).map((url): TicketPr => ({ url, state: null }));
  if (!added.length) return {};
  const next = [...prs, ...added];
  return { prs: next, prUrl: mainPr(next) };
}

/** The patch that records fetched states (and target branches) of the ticket's PRs, re-picking the main one. */
export function updatePrs(t: Pick<Ticket, "prUrl" | "prs" | "pr">, seen: Map<string, Pick<TicketPr, "state" | "base">>): Pick<Ticket, "prs" | "prUrl"> {
  const prs = ticketPrs(t).map((p) => {
    const s = seen.get(p.url);
    return s ? { ...p, state: s.state, ...(s.base ? { base: s.base } : {}) } : p;
  });
  return { prs, prUrl: mainPr(prs) };
}
