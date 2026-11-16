import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_LOCK_FILE, releaseBoardLock, takeBoardLock } from "./board-lock";

test("one owner at a time; letting go frees it; a child process doesn't keep it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-board-lock-"));
  try {
    const a = await takeBoardLock(root, 0);
    // A second taker (another daemon) is refused, after waiting a little.
    const t0 = Date.now();
    await expect(takeBoardLock(root, 200)).rejects.toThrow(/another ckanban daemon owns this data folder/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    // A process started while the lock is held (a board run, a detached Chrome) doesn't inherit it.
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    releaseBoardLock(a);
    const b = await takeBoardLock(root, 0);
    child.kill();
    releaseBoardLock(b);
    expect(readFileSync(join(root, BOARD_LOCK_FILE), "utf8")).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
