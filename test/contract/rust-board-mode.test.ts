// The Rust board's switch (docs/rust-port-board-plan.md 3.1): board mode on with CKANBAN_RUST_BOARD=1 or the
// `rust-board` file, and its three fallbacks to Bun's full mode, each written to the log and rust-board-status.json.
// Runs only under `bun run test:contract:rust-board` (CKANBAN_RUST_BOARD=1 and a ckanban-rs daemon command); `bun run
// test` and `test:contract:rust` skip it.
import { expect, test } from "bun:test";
import { closeSync, constants, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";

const ON = process.env.CKANBAN_RUST_BOARD === "1" && !!process.env.CKANBAN_CONTRACT_DAEMON;
const t = ON ? test : test.skip;
/** O_EXLOCK (macOS): the same lock the daemons take on board.lock. */
const O_EXLOCK = 0x20;

const status = (d: { home: string }) => JSON.parse(readFileSync(join(d.home, "rust-board-status.json"), "utf8"));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function board(d: Daemon): Promise<{ slug: string; ticketStatus: number }> {
  const p = await d.api("POST", "/api/profiles", { name: "Switch", path: d.project });
  expect(p.status).toBe(201);
  const r = await d.api("POST", `/api/profiles/${p.data.slug}/tickets`, { title: "Who writes me" });
  return { slug: p.data.slug, ticketStatus: r.status };
}

t("CKANBAN_RUST_BOARD=1: the Rust board owns the data folder, Bun runs as its satellite, a clean stop is recorded", async () => {
  const d = await startDaemon();
  try {
    expect(d.log()).toContain("board mode: the Rust board owns this data folder");
    expect(d.log()).toContain("as the Rust board's satellite");
    expect(status(d)).toMatchObject({ mode: "rust", reason: null, running: true, crashes: [] });
    expect(existsSync(join(d.home, "board.lock"))).toBe(true);
    // Stopped as launchd stops it (SIGTERM): a clean stop, not a crash.
    process.kill(d.pid, "SIGTERM");
    await until(() => !alive(d.pid), 15_000, "ckanban-rs to stop");
    expect(status(d)).toMatchObject({ mode: "rust", running: false });
  } finally {
    await d.stop();
  }
}, 60_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

t("the rust-board file turns board mode on when the variable is unset", async () => {
  const d = await startDaemon({ env: { CKANBAN_RUST_BOARD: "" }, before: ({ home }) => writeFileSync(join(home, "rust-board"), "on\n") });
  try {
    expect(d.log()).toContain("board mode: the Rust board owns this data folder");
    expect(status(d).mode).toBe("rust");
  } finally {
    await d.stop();
  }
}, 60_000);

t("fallback 1: without the switch Bun runs the whole board, and the status file says board mode is off", async () => {
  // As after `rm <data>/rust-board && ckanban restart` from board mode.
  const before = ({ home }: { home: string }) =>
    writeFileSync(join(home, "rust-board-status.json"), JSON.stringify({ mode: "rust", reason: null, at: iso(60_000), pid: 1, running: false, crashes: [] }));
  const d = await startDaemon({ env: { CKANBAN_RUST_BOARD: "" }, before });
  try {
    expect(d.log()).not.toContain("board mode: the Rust board");
    expect(d.log()).not.toContain("satellite");
    expect(status(d)).toMatchObject({ mode: "bun", reason: "board mode is off", running: false });
    // Bun in full mode writes tickets.
    expect((await board(d)).ticketStatus).toBe(201);
  } finally {
    await d.stop();
  }
}, 60_000);

t("fallback 2: the data lock is held, so Bun runs the whole board once it is free", async () => {
  let fd: number | null = null;
  const before = ({ home }: { home: string }) => {
    fd = openSync(join(home, "board.lock"), constants.O_RDWR | constants.O_CREAT | O_EXLOCK, 0o600);
    // Held past Rust's wait (5 s) and let go within Bun's (10 s more).
    setTimeout(() => closeSync(fd!), 8_000);
  };
  const d = await startDaemon({ before });
  try {
    expect(d.log()).toContain("board mode is off for this start, Bun runs the whole board: another ckanban daemon owns this data folder");
    expect(d.log()).not.toContain("satellite");
    expect(status(d)).toMatchObject({ mode: "bun", running: false });
    expect(status(d).reason).toContain("board.lock is locked");
    expect((await board(d)).ticketStatus).toBe(201);
  } finally {
    await d.stop();
  }
}, 60_000);

t("fallback 2, lock never freed: neither the Rust board nor Bun starts the board", async () => {
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
  expect(err).toContain("not starting");
}, 60_000);

t("fallback 3: a third unclean end within 10 minutes hands the board to Bun until the switch is written again", async () => {
  // The last start was board mode and never stopped cleanly; two earlier crashes are within the window.
  const before = ({ home }: { home: string }) =>
    writeFileSync(join(home, "rust-board-status.json"), JSON.stringify({ mode: "rust", reason: null, at: iso(60_000), pid: 1, running: true, crashes: [iso(300_000), iso(120_000)] }));
  const d = await startDaemon({ before });
  try {
    expect(d.log()).toContain("board mode stopped unexpectedly 3 times within 10 minutes");
    const s = status(d);
    expect(s).toMatchObject({ mode: "bun", running: false });
    expect(s.crashes).toHaveLength(3);
    expect((await board(d)).ticketStatus).toBe(201);
  } finally {
    await d.stop();
  }
}, 60_000);

t("an unclean end is counted; old ones drop out of the 10 minutes", async () => {
  const before = ({ home }: { home: string }) =>
    writeFileSync(join(home, "rust-board-status.json"), JSON.stringify({ mode: "rust", reason: null, at: iso(60_000), pid: 1, running: true, crashes: [iso(20 * 60_000)] }));
  const d = await startDaemon({ before });
  try {
    expect(d.log()).toContain("board mode: the Rust board owns this data folder");
    expect(status(d)).toMatchObject({ mode: "rust", running: true });
    expect(status(d).crashes).toHaveLength(1);
  } finally {
    await d.stop();
  }
}, 60_000);
