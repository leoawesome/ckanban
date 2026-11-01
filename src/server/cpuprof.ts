import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";

// On-demand CPU profile of the running daemon (POST /api/debug/profile), for finding what holds the board up without
// restarting it under a profiler. Writes a .cpuprofile (Chrome DevTools can open it) and returns the hottest functions.

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}

export interface HotFunction {
  fn: string;
  where: string;
  selfMs: number;
  totalMs: number;
}

let active = false;

function post<T>(s: Session, method: string): Promise<T> {
  return new Promise((ok, fail) => s.post(method, (err: unknown, r: unknown) => (err ? fail(err) : ok(r as T))));
}

export async function profileFor(seconds: number, dir: string): Promise<{ file: string; hot: HotFunction[] }> {
  if (active) throw new Error("a profile is already being taken");
  active = true;
  const s = new Session();
  try {
    s.connect();
    await post(s, "Profiler.enable");
    await post(s, "Profiler.start");
    await new Promise((r) => setTimeout(r, Math.min(120, Math.max(1, seconds)) * 1000));
    const { profile } = await post<{ profile: { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[] } }>(s, "Profiler.stop");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `daemon-${new Date().toISOString().replace(/[:.]/g, "-")}.cpuprofile`);
    writeFileSync(file, JSON.stringify(profile));
    return { file, hot: hottest(profile.nodes, profile.samples?.length ?? 0, (profile.endTime - profile.startTime) / 1000) };
  } finally {
    s.disconnect();
    active = false;
  }
}

/** Self and total time by function, from the profile's hit counts. */
export function hottest(nodes: ProfileNode[], samples: number, durationMs: number, top = 30): HotFunction[] {
  const msPerHit = samples ? durationMs / samples : 0;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const totals = new Map<number, number>();
  const total = (id: number): number => {
    const hit = totals.get(id);
    if (hit !== undefined) return hit;
    const n = byId.get(id)!;
    const t = (n.hitCount ?? 0) + (n.children ?? []).reduce((a, c) => a + total(c), 0);
    totals.set(id, t);
    return t;
  };
  const agg = new Map<string, HotFunction>();
  for (const n of nodes) {
    const { functionName, url, lineNumber } = n.callFrame;
    if (functionName === "(root)" || functionName === "(idle)" || functionName === "(program)") continue;
    const key = `${functionName}@${url}:${lineNumber}`;
    const a = agg.get(key) ?? { fn: functionName || "(anonymous)", where: url ? `${url.replace(/^.*\/src\//, "src/")}:${lineNumber + 1}` : "native", selfMs: 0, totalMs: 0 };
    a.selfMs += (n.hitCount ?? 0) * msPerHit;
    a.totalMs += total(n.id) * msPerHit;
    agg.set(key, a);
  }
  return [...agg.values()]
    .map((a) => ({ ...a, selfMs: Math.round(a.selfMs), totalMs: Math.round(a.totalMs) }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, top);
}
