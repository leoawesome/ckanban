/**
 * Event-loop lag monitor. A short timer checks that it fires on time; when it fires late by more than the threshold,
 * the event loop was blocked, and it logs one line naming what ran meanwhile: tracked timers, startup steps and
 * requests (`track`), with how long each took. Nothing tracked = GC or untracked work.
 */

type Record = { label: string; ms: number; async: boolean };

const ran: Record[] = [];
const busy = new Map<number, { label: string; start: number }>();
let nextId = 0;

/** Runs `fn` and notes its label and time; for a promise, also while it is still pending. */
export function track<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const id = nextId++;
  busy.set(id, { label, start });
  let res: T;
  try {
    res = fn();
  } catch (e) {
    busy.delete(id);
    ran.push({ label, ms: performance.now() - start, async: false });
    throw e;
  }
  const syncMs = performance.now() - start;
  if (res instanceof Promise) {
    if (syncMs >= 1) ran.push({ label, ms: syncMs, async: false });
    const done = () => {
      busy.delete(id);
      ran.push({ label, ms: performance.now() - start, async: true });
    };
    res.then(done, done);
  } else {
    busy.delete(id);
    ran.push({ label, ms: syncMs, async: false });
  }
  if (ran.length > 500) ran.splice(0, ran.length - 500);
  return res;
}

/** setInterval whose ticks are tracked under `label`. */
export function trackedInterval(label: string, fn: () => unknown, ms: number): ReturnType<typeof setInterval> {
  return setInterval(() => track(label, fn), ms);
}

export type LagOptions = { thresholdMs?: number; intervalMs?: number; sleepMs?: number; log?: (line: string) => void };

/** Starts the monitor; returns its stop function. Gaps over `sleepMs` look like the Mac sleeping and are skipped. */
export function startLagMonitor(o: LagOptions = {}): () => void {
  const threshold = o.thresholdMs ?? 200;
  const interval = o.intervalMs ?? 100;
  const sleep = o.sleepMs ?? 60_000;
  const log = o.log ?? ((line: string) => console.warn(line));
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - last - interval;
    last = now;
    if (lag > threshold && lag < sleep) log(lagLine(lag, now));
    ran.length = 0;
  }, interval);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}

function lagLine(lag: number, now: number): string {
  const top = ran.filter((r) => r.ms >= 20).sort((a, b) => b.ms - a.ms).slice(0, 5)
    .map((r) => `${r.label} ${Math.round(r.ms)}ms${r.async ? " (async)" : ""}`);
  const pending = [...busy.values()].filter((b) => now - b.start >= 20).slice(0, 5)
    .map((b) => `${b.label} for ${Math.round(now - b.start)}ms`);
  const mem = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  return `[lag] event loop blocked ${Math.round(lag)}ms at ${new Date().toISOString()}` +
    ` (up ${Math.round(process.uptime())}s); ran: ${top.join(", ") || "nothing tracked (GC or untracked work)"}` +
    (pending.length ? `; still running: ${pending.join(", ")}` : "") +
    `; rss ${mb(mem.rss)}MB heap ${mb(mem.heapUsed)}MB`;
}

/** A request's label: method and path, with ids and long parts shortened so lines stay readable. */
export function routeLabel(req: Request): string {
  const path = new URL(req.url).pathname.split("/").map((s) => (/^t_\d{8}_/.test(s) || s.length > 40 ? ":id" : s)).join("/");
  return `${req.method} ${path}`;
}
