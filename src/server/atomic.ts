import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newId } from "./util";

/**
 * Writes a file in one step (a temp file, then a rename), so a reader never sees half of it. On its own so that code
 * that only needs this (session.ts, whose saved summaries are dropped when a file it imports changes: summaryTag)
 * doesn't import the whole Store.
 */
export function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
