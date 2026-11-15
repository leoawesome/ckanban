// Words for the feature status at the top of the Tasks tab (StatusBlock.tsx) and the chat's "Waiting on you" line.
// No React and no api.ts, so tests can import it.

type Counts = Record<string, number>;
const sum = (c: Counts, ...keys: string[]) => keys.reduce((s, k) => s + (c[k] ?? 0), 0);
const FINISHED = ["done", "passed", "problem"];

/** Finished tasks of all of them: loose tickets and the tickets inside groups (a group itself doesn't count). */
export function taskProgress(f: { groups: { total: number; counts: Counts }[]; loose: { total: number; counts: Counts } }): { done: number; total: number } {
  let done = sum(f.loose.counts, ...FINISHED);
  let total = f.loose.total;
  for (const g of f.groups) {
    done += sum(g.counts, ...FINISHED);
    total += g.total;
  }
  return { done, total };
}

/** "Build the login page", "A, B and 2 more": the tasks working now, by name. */
export function namesText(names: string[], max = 2): string {
  const shown = names.slice(0, max);
  const more = names.length - shown.length;
  return `${shown.join(", ")}${more ? ` and ${more} more` : ""}`;
}

/** The chat's one line while the status says something waits on the user ("" when nothing does). */
export function waitingLine(saved: { waiting?: string } | null | undefined): string {
  const w = saved?.waiting?.trim();
  return w ? `Waiting on you: ${w.replace(/\s+/g, " ")}` : "";
}
