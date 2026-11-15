import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * atomicWrite off the event loop: the write and the rename run on Bun's file threads, so a big file on a busy Mac
 * (security software checking every write) doesn't freeze the daemon for the seconds the disk takes. When `keep`
 * says no once the content is written (a newer write took over), the temp file is dropped instead of renamed.
 */
export async function atomicWriteAsync(file: string, content: string, keep: () => boolean = () => true): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${newId()}`;
  try {
    await writeFile(tmp, content);
    if (!keep()) {
      await rm(tmp, { force: true });
      return false;
    }
    await rename(tmp, file);
    return true;
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
