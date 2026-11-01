import { expect, test } from "bun:test";
import { startLagMonitor, track } from "../src/server/lag";

const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {}
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the lag monitor logs a 300ms block with what ran, and stays quiet for 50ms", async () => {
  const lines: string[] = [];
  const stop = startLagMonitor({ thresholdMs: 200, intervalMs: 20, log: (l) => lines.push(l) });
  try {
    await wait(60);
    track("test: short block", () => busy(50));
    await wait(100);
    expect(lines).toEqual([]);
    track("GET /api/inbox", () => busy(300));
    await wait(100);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\[lag\] event loop blocked \d+ms/);
    expect(lines[0]).toContain("ran: GET /api/inbox 3");
    expect(Number(lines[0].match(/blocked (\d+)ms/)![1])).toBeGreaterThanOrEqual(250);
  } finally {
    stop();
  }
});

test("the lag monitor names pending async work and skips gaps that look like sleep", async () => {
  const lines: string[] = [];
  const stop = startLagMonitor({ thresholdMs: 200, intervalMs: 20, sleepMs: 1000, log: (l) => lines.push(l) });
  try {
    await wait(40);
    let release = () => {};
    const pending = track("startup: board.recover", () => new Promise<void>((r) => (release = r)));
    busy(300);
    await wait(60);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("still running: startup: board.recover");
    release();
    await pending;
    lines.length = 0;
    busy(1100);
    await wait(60);
    expect(lines).toEqual([]);
  } finally {
    stop();
  }
});

test("a request that does all its work before its first await is named once", async () => {
  const lines: string[] = [];
  const stop = startLagMonitor({ thresholdMs: 200, intervalMs: 20, log: (l) => lines.push(l) });
  try {
    await wait(40);
    await track("GET /api/inbox", async () => busy(300));
    await wait(60);
    expect(lines.length).toBe(1);
    expect(lines[0].match(/GET \/api\/inbox/g)?.length).toBe(1);
  } finally {
    stop();
  }
});
