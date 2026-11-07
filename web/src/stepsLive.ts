// The live line at the bottom of a main ticket's chat while steps of its feature work: "Working: Build the login page",
// "2 steps working: Build the login page, Test the signup". Live state only: never saved as a chat message.
import { familyOf, workingInFamily, type FamilyTicket } from "./family";

/** Names the line spells out before "and N more". */
export const STEPS_NAMED = 2;

/** The steps (and tickets the user added) of main's feature working now, in family order; [] for other tickets. */
export function stepsWorking<T extends FamilyTicket & { running?: boolean }>(tickets: T[], main: { id: string; main?: boolean }): T[] {
  if (!main.main) return [];
  return workingInFamily(familyOf(tickets, main.id).map((r) => r.ticket), main.id, (t) => !!t.running);
}

/** The line's parts: its lead ("Working:" or "3 steps working:"), the names it shows and how many it leaves out. */
export function stepsLine<T>(steps: T[], max = STEPS_NAMED): { lead: string; shown: T[]; more: number } | null {
  if (!steps.length) return null;
  const shown = steps.slice(0, max);
  return { lead: steps.length === 1 ? "Working:" : `${steps.length} steps working:`, shown, more: steps.length - shown.length };
}

/** The line as plain text (its tooltip and tests). */
export function stepsLineText(names: string[], max = STEPS_NAMED): string {
  const l = stepsLine(names, max);
  if (!l) return "";
  return `${l.lead} ${l.shown.join(", ")}${l.more ? ` and ${l.more} more` : ""}`;
}
