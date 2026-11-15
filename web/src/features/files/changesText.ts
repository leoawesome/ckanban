/** Above this many changed files the Changes tab groups them by folder; up to it, a plain list. */
export const TREE_ABOVE = 8;

export const showTree = (files: number) => files > TREE_ABOVE;

/** "3 files", "1 file". */
export const fileCount = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * What the changes are compared with, for the count's tooltip: a plain sentence, then the version names
 * (origin/main, ck/t_…), which users don't need to read but Leo checks.
 */
export function comparedWith(d: { base: string; branch?: string | null; startedFrom?: string | null }, inFolder: boolean): string {
  if (inFolder) {
    return `Compared with this ticket's start: everything changed in the project folder since its first run, including edits made there by others.\n${d.base}`;
  }
  const head = d.startedFrom ? `Compared with the version this ticket's work started from (${d.startedFrom}).` : "Compared with the main version.";
  return `${head}\n${d.base}${d.branch ? ` · ${d.branch}` : ""}`;
}
