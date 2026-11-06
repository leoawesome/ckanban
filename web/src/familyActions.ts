// Stop, Backlog / Done and Delete on a main ticket act on its tool tickets too: one confirm each, with the count and
// the cost. Other family members (tickets the user added or gathered, old plan children) are left alone.
// No imports from api.ts, so tests load it.

interface FamilyTicketLike {
  title: string;
  main?: boolean;
  familyCard?: { tools: number; open?: number; running: string[]; costUsd: number } | null;
}

const money = (usd: number) => (usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;

/** Its tool tickets, or 0 for any other ticket. */
export const toolCount = (t: FamilyTicketLike): number => (t.main ? t.familyCard?.tools ?? 0 : 0);
/** Its tool tickets not finished yet (an older server without the count: all of them, as before). */
export const openTools = (t: FamilyTicketLike): number => (t.main ? t.familyCard?.open ?? t.familyCard?.tools ?? 0 : 0);
/** Its tool tickets working or queued to start now. */
export const runningTools = (t: FamilyTicketLike): number => (t.main ? t.familyCard?.running.length ?? 0 : 0);

/** "Stop AI Outreach and its 2 running tool tickets?" */
export function stopTitle(t: FamilyTicketLike): string {
  const k = runningTools(t);
  return k ? `Stop ${t.title} and its ${n(k, "running tool ticket")}?` : "Stop Claude?";
}

/** "Delete AI Outreach and its 14 tool tickets ($41.20 spent)?" */
export function deleteTitle(t: FamilyTicketLike): string {
  const k = toolCount(t);
  if (!k) return `Delete "${t.title}"?`;
  return `Delete ${t.title} and its ${n(k, "tool ticket")} (${money(t.familyCard!.costUsd)} spent)?`;
}

/** Moving a main ticket to Backlog or Done needs a confirm only when a tool ticket isn't finished: it would hold that back. */
export const parkNeedsConfirm = (t: FamilyTicketLike & { status: string }, to: string): boolean =>
  openTools(t) > 0 && (to === "backlog" || to === "done") && t.status !== to;

export function parkTitle(t: FamilyTicketLike, to: "backlog" | "done"): string {
  return `Move "${t.title}" and its ${n(openTools(t), "unfinished step")} to ${to === "done" ? "Done" : "Backlog"}?`;
}

export function parkText(t: FamilyTicketLike): string {
  const k = runningTools(t);
  return `No new tool tickets start${k ? `; the ${n(k, "running one")} ${k === 1 ? "finishes" : "finish"}` : ""}, and queued ones are kept. ` +
    `Move it back to In progress to let them start again. ${money(t.familyCard?.costUsd ?? 0)} spent so far.`;
}
