import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newId } from "./util";

/**
 * Writes a file in one step (a temp file, then a rename), so a reader never sees half of it. On its own so that code
 * that only needs this (session.ts, whose saved summaries are dropped when a file it imports changes: summaryTag)
 * doesn't import the whole Store. A write or rename that fails takes its temp file with it (housekeeping.ts sweeps
 * what a crash leaves).
 */
export function atomicWrite(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
