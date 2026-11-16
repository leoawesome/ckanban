// One owner of a data folder's board (docs/rust-port-board-plan.md 3.1): the Bun daemon in full mode and the Rust
// board (`rust/board/src/lock.rs`) both hold an exclusive lock on <data>/board.lock while they own the board, and
// refuse to start without it, so two daemons never write tickets in one data folder. The file stays empty. The lock
// goes with the process: files are opened close-on-exec, so board runs and detached Chromes don't keep it.
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export const BOARD_LOCK_FILE = "board.lock";
/** O_EXLOCK (macOS open(2)): an exclusive flock taken by open itself; not in Node's constants. */
const O_EXLOCK = 0x20;

/**
 * Takes the lock, trying again for up to `waitMs` (an owner that is stopping lets go in a moment). Returns the file
 * descriptor to keep open while the board runs; throws when another daemon keeps it.
 */
export async function takeBoardLock(root: string, waitMs = 10_000): Promise<number> {
  mkdirSync(root, { recursive: true });
  const file = join(root, BOARD_LOCK_FILE);
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      return openSync(file, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw new Error(`can't lock ${file}: ${(e as Error).message}`);
      if (Date.now() >= end) throw new Error(`another ckanban daemon owns this data folder (${file} is locked)`);
      await Bun.sleep(100);
    }
  }
}

export function releaseBoardLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {}
}
