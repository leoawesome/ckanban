import { expect, test } from "bun:test";
import { startLagMonitor, track } from "./lag";

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

test("a lag line tells work from waiting: CPU time and heap size during the freeze", async () => {
  const lines: string[] = [];
  const stop = startLagMonitor({ thresholdMs: 200, intervalMs: 20, log: (l) => lines.push(l) });
  try {
    await wait(60);
    busy(300);
    await wait(60);
    // A sync wait (like a write on a busy disk): the process uses almost no CPU.
    Bun.sleepSync(300);
    await wait(60);
    // On a loaded Mac the busy loop may get less CPU than its length, so only the waiting one's cause is checked.
    expect(lines.length).toBe(2);
    const cpu = lines.map((l) => Number(/; cpu (\d+)ms, heap \d+→\d+MB: likely /.exec(l)![1]));
    expect(cpu[0]).toBeGreaterThan(cpu[1]);
    expect(lines[1]).toContain("likely waiting (little CPU: disk or the Mac busy)");
  } finally {
    stop();
  }
});

test("a lag line adds up the short jobs it doesn't name: many small requests make a freeze too", async () => {
  const lines: string[] = [];
  const stop = startLagMonitor({ thresholdMs: 200, intervalMs: 20, log: (l) => lines.push(l) });
  try {
    await wait(60);
    for (let i = 0; i < 30; i++) track(i % 3 ? "GET /api/inbox" : "events: ticket.updated", () => busy(10));
    await wait(60);
    expect(lines.length).toBe(1);
    // On a loaded Mac a few may take 20ms or more and be named on their own.
    expect(lines[0]).toMatch(/\d+ shorter jobs \d+ms in all \(GET \/api\/inbox ×\d+, events: ticket\.updated ×\d+\)/);
  } finally {
    stop();
  }
});
