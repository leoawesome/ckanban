// Start-up clean-ups of files nothing else removes: temp files a crash left behind, and the daemon's own log.
import { copyFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import { pauser } from "./lag";

/** atomicWrite's temp files: `<file>.tmp-<8 letters or digits>`. */
const TMP = /\.tmp-[a-z0-9]{8}$/;
/**
 * The data folder's own folders the sweep goes into; others (browser profiles, uploads) hold many files that aren't
 * the board's. Inside them it skips folders that hold copies of a project.
 */
const DATA_DIRS = new Set(["profiles", "learned", "huddle-notes"]);
const SKIP = new Set(["node_modules", ".git", ".ckanban-worktrees"]);

/**
 * Removes temp files of atomic writes (atomic.ts) older than maxAgeMs under the data folder: a crash between the write
 * and the rename leaves one behind. Listing is off the event loop and the walk pauses every ~30ms, so a data folder
 * with thousands of tickets doesn't freeze the daemon. Ticket outputs folders are looked at but not gone into (they
 * can hold whole copies of a project). Returns how many it removed.
 */
export async function sweepTempFiles(root: string, o: { maxAgeMs?: number; now?: () => number; maxDepth?: number } = {}): Promise<number> {
  const maxAge = o.maxAgeMs ?? 86_400_000;
  const now = o.now ?? Date.now;
  const maxDepth = o.maxDepth ?? 6;
  const pause = pauser();
  let removed = 0;
  const walk = async (dir: string, depth: number, descend: boolean) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      await pause();
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        const ours = depth === 0 ? DATA_DIRS.has(e.name) : !SKIP.has(e.name);
        if (descend && ours && depth < maxDepth) await walk(path, depth + 1, e.name !== "outputs");
      } else if (e.isFile() && TMP.test(e.name)) {
        try {
          if (now() - (await stat(path)).mtimeMs < maxAge) continue;
          await rm(path, { force: true });
          removed++;
        } catch {}
      }
    }
  };
  await walk(root, 0, true);
  return removed;
}

/**
 * Keeps the daemon log (written by launchd, which nothing else trims) under maxBytes: when it is bigger, its lines
 * move to `<file>.1` (the older `.1` to `.2`, and so on up to `keep` files) and the log starts empty. launchd keeps
 * the log open for appending, so the file is copied and emptied in place instead of renamed (a renamed file would
 * keep getting the daemon's lines). A line written between the copy and the emptying is lost; this runs at start.
 */
export async function trimDaemonLog(file: string, o: { maxBytes?: number; keep?: number } = {}): Promise<boolean> {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024;
  const keep = Math.max(1, o.keep ?? 2);
  try {
    if ((await stat(file)).size <= maxBytes) return false;
  } catch {
    return false;
  }
  await rm(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
  await copyFile(file, `${file}.1`);
  await truncate(file, 0);
  return true;
}
