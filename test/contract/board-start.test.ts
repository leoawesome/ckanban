// The daemon's start and stop: it owns the data folder while it runs (`board.lock`, the same lock Bun's daemon took,
// so two daemons never own one data folder), records in rust-board-status.json whether it stopped cleanly and counts
// unclean ends, and doesn't start while another daemon holds the lock. Bun's satellite and its fallbacks to Bun's
// full mode went with P4.
import { expect, test } from "bun:test";
import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, until } from "./daemon";

/** O_EXLOCK (macOS): the lock the daemon takes on board.lock. */
const O_EXLOCK = 0x20;

const status = (d: { home: string }) => JSON.parse(readFileSync(join(d.home, "rust-board-status.json"), "utf8"));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("the daemon owns the data folder, runs no Bun, and a clean stop is recorded", async () => {
  const d = await startDaemon();
  try {
    expect(d.log()).toContain("the board owns this data folder");
    expect(d.log()).not.toContain("satellite");
    expect(status(d)).toMatchObject({ mode: "rust", reason: null, running: true, crashes: [] });
    expect(existsSync(join(d.home, "board.lock"))).toBe(true);
    // Stopped as launchd stops it (SIGTERM): a clean stop, not a crash.
    process.kill(d.pid, "SIGTERM");
    await until(() => !alive(d.pid), 15_000, "the daemon to stop");
    expect(status(d)).toMatchObject({ mode: "rust", running: false });
  } finally {
    await d.stop();
  }
}, 60_000);

test("the data lock is held by another daemon: this one doesn't start and says why", async () => {
  let fd: number | null = null;
  const before = ({ home }: { home: string }) => {
    fd = openSync(join(home, "board.lock"), constants.O_RDWR | constants.O_CREAT | O_EXLOCK, 0o600);
  };
  let err = "";
  try {
    await startDaemon({ before });
  } catch (e) {
    err = (e as Error).message;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  expect(err).toContain("daemon exited with 1");
  expect(err).toContain("another ckanban daemon owns this data folder");
}, 60_000);

test("an unclean end is counted; old ones drop out of the 10 minutes", async () => {
  const before = ({ home }: { home: string }) =>
    writeFileSync(join(home, "rust-board-status.json"), JSON.stringify({ mode: "rust", reason: null, at: iso(60_000), pid: 1, running: true, crashes: [iso(20 * 60_000)] }));
  const d = await startDaemon({ before });
  try {
    expect(d.log()).toContain("the board owns this data folder");
    expect(status(d)).toMatchObject({ mode: "rust", running: true });
    expect(status(d).crashes).toHaveLength(1);
  } finally {
    await d.stop();
  }
}, 60_000);
