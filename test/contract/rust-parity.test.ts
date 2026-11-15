// Parity of the Rust front server's own routes (GET /api/usage, GET /api/spend) with Bun's: the same data folder
// contents, given to the Bun daemon alone and to `ckanban-rs dev`, must give the same answers after JSON parsing and
// the same usage-last.json / usage-windows.json. Times taken from the clock (fetchedAt, retryAt, attemptAt...) only
// have to be close. Runs only under `bun run test:contract:rust`, which sets CKANBAN_PARITY_RS to the Rust server's
// command; `bun run test` skips it (it needs cargo).
//
// Both daemons keep running through the scenarios: each step rewrites usage-last.json (both sides read it again when
// it changes) and the fake's reply, so the one-minute gap between checks doesn't need a new daemon per step.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_DAEMON_CMD, commandFromEnv, type Daemon, startDaemon } from "./daemon";

const RS_CMD = commandFromEnv("CKANBAN_PARITY_RS", []);
const enabled = RS_CMD.length > 0;

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
let reply: Reply = { status: 500 };
const calls: Record<string, number> = { bun: 0, rs: 0 };
/**
 * Which code made each call, per side: Bun's fetch always sends accept-encoding, the Rust client (no compression
 * features) never does. Proves the rs side's checks came from Rust, not from the Bun child behind it.
 */
const askedBy: Record<string, string[]> = { bun: [], rs: [] };
const fake = enabled
  ? Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const side = new URL(req.url).pathname.split("/")[2] ?? "";
      calls[side] = (calls[side] ?? 0) + 1;
      (askedBy[side] ??= []).push(req.headers.has("accept-encoding") ? "bun" : "rust");
      return Response.json(reply.body ?? {}, { status: reply.status, headers: reply.headers });
    },
  })
  : null;

const RESETS = new Date(Date.now() + 3 * 3600_000).toISOString();
const GOOD = { five_hour: { utilization: 42, resets_at: RESETS }, seven_day: { utilization: 17.5, resets_at: null }, seven_day_opus: { utilization: 3 }, extra_usage: { is_enabled: false } };

/** Keys whose values come from the clock at the time of the request: compared within a few seconds. */
const TIME_KEYS = new Set(["fetchedAt", "retryAt", "attemptAt", "blockedUntil", "at", "seenAt"]);
const asMs = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);

/** Deep equality, except clock times (within 5 s) and "about N min" (within 1). */
function same(a: unknown, b: unknown, path = "$"): void {
  if (a && b && typeof a === "object" && typeof b === "object") {
    expect(Array.isArray(a)).toBe(Array.isArray(b));
    expect(Object.keys(a as object).sort()).toEqual(Object.keys(b as object).sort());
    for (const k of Object.keys(a as object)) {
      const x = (a as any)[k];
      const y = (b as any)[k];
      if (TIME_KEYS.has(k) && x !== null && y !== null && typeof x !== "object") {
        expect(typeof x).toBe(typeof y);
        if (x === 0 || y === 0) expect([path, k, x]).toEqual([path, k, y]);
        else expect(Math.abs(asMs(x) - asMs(y))).toBeLessThan(5_000);
      } else same(x, y, `${path}.${k}`);
    }
    return;
  }
  if (typeof a === "string" && typeof b === "string" && /about \d+ min/.test(a)) {
    expect(a.replace(/\d+ min/, "N min")).toBe(b.replace(/\d+ min/, "N min"));
    return;
  }
  expect([path, a]).toEqual([path, b]);
}

let bun: Daemon, rs: Daemon;
const both = () => [["bun", bun], ["rs", rs]] as const;

function credentials(d: Daemon, expiresAt: number | null) {
  const dir = d.env.CLAUDE_CONFIG_DIR;
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", ...(expiresAt !== null && { expiresAt }) } }));
}

/** Puts the same usage-last.json in both data folders (no file: a cache that never asked). */
function saved(s: { percent: number; fetchedAgoMs: number } | null) {
  const now = Date.now();
  for (const [, d] of both()) {
    const f = join(d.home, "usage-last.json");
    rmSync(f, { force: true });
    if (!s) {
      // Never asked: zero times, so the next GET asks.
      writeFileSync(f, JSON.stringify({ last: null, lastError: null, attemptAt: 0, blockedUntil: 0, failures: 0 }));
      continue;
    }
    writeFileSync(f, JSON.stringify({
      last: { windows: [{ key: "five_hour", label: "Current session (5h)", percent: s.percent, resetsAt: RESETS }], fetchedAt: new Date(now - s.fetchedAgoMs).toISOString() },
      lastError: null,
      attemptAt: now - 120_000,
      blockedUntil: 0,
      failures: 0,
    }));
  }
}

async function usage(fresh = false): Promise<[any, any]> {
  const out: any[] = [];
  for (const [, d] of both()) {
    const r = await d.api("GET", `/api/usage${fresh ? "?fresh=1" : ""}`);
    expect(r.status).toBe(200);
    out.push(r.data);
  }
  same(out[0], out[1]);
  return out as [any, any];
}

function readJson(d: Daemon, name: string): unknown {
  const f = join(d.home, name);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}
function sameFiles() {
  for (const f of ["usage-last.json", "usage-windows.json"]) same(readJson(bun, f), readJson(rs, f), f);
}

beforeAll(async () => {
  if (!enabled) return;
  const env = (side: string) => ({ CKANBAN_USAGE_URL: `http://127.0.0.1:${fake!.port}/s/${side}/api/oauth/usage` });
  [bun, rs] = await Promise.all([startDaemon({ cmd: BUN_DAEMON_CMD, env: env("bun") }), startDaemon({ cmd: RS_CMD, env: env("rs") })]);
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await Promise.all([bun?.stop(), rs?.stop()]);
  fake?.stop(true);
}, 30_000);

describe.skipIf(!enabled)("Rust and Bun give the same usage answers", () => {
  test("no login: the same error, Anthropic never asked", async () => {
    saved(null);
    const [b] = await usage();
    expect(b.error).toBeString();
    expect(calls).toEqual({ bun: 0, rs: 0 });
    sameFiles();
  });

  test("a good answer: asked once, then the cache, fresh=1 inside the minute too", async () => {
    for (const [, d] of both()) credentials(d, Date.now() + 3600_000);
    saved(null);
    reply = { status: 200, body: GOOD };
    const [b] = await usage();
    expect(b.windows.map((w: any) => w.key)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    await usage();
    await usage(true);
    expect(calls).toEqual({ bun: 1, rs: 1 });
    sameFiles();
  });

  test("a saved answer from the other process is reused as is", async () => {
    saved({ percent: 7, fetchedAgoMs: 60_000 });
    const [b, r] = await usage();
    expect(r).toEqual(b);
    expect(b.windows[0].percent).toBe(7);
    expect(calls).toEqual({ bun: 1, rs: 1 });
  });

  test("fresh=1 after the minute asks now", async () => {
    const [b] = await usage(true);
    expect(b.windows[0].percent).toBe(42);
    expect(calls).toEqual({ bun: 2, rs: 2 });
    sameFiles();
  });

  test("Anthropic failing with old saved numbers: stale with the error", async () => {
    saved({ percent: 9, fetchedAgoMs: 3600_000 });
    reply = { status: 500, body: { error: "boom" } };
    const [b] = await usage();
    expect(b.stale).toBe(true);
    expect(calls).toEqual({ bun: 3, rs: 3 });
    sameFiles();
  });

  test("Anthropic failing with nothing saved: the error alone", async () => {
    saved(null);
    const [b] = await usage();
    expect(b.windows).toBeUndefined();
    expect(b.error).toBe("Anthropic answered HTTP 500");
    sameFiles();
  });

  test("rate limited: limited with a retry time, no call until then", async () => {
    saved(null);
    reply = { status: 429, body: {}, headers: { "retry-after": "120" } };
    const [b] = await usage();
    expect(b.limited).toBe(true);
    expect(b.retryAt).toBeString();
    await usage(true);
    expect(calls).toEqual({ bun: 5, rs: 5 });
    sameFiles();
  });

  test("an unexpected body and an expired login", async () => {
    saved(null);
    reply = { status: 200, body: { nothing: 1 } };
    expect((await usage())[0].error).toBe("Unexpected answer from the usage endpoint");
    saved(null);
    for (const [, d] of both()) credentials(d, Date.now() - 1000);
    expect((await usage())[0].error).toStartWith("Token expired");
    expect(calls).toEqual({ bun: 6, rs: 6 });
    expect(askedBy).toEqual({ bun: Array(6).fill("bun"), rs: Array(6).fill("rust") });
  });
});

describe.skipIf(!enabled)("Rust shares the usage cache with its Bun child", () => {
  test("a check made by Rust is reused by Bun's own usage code", async () => {
    for (const [, d] of both()) credentials(d, Date.now() + 3600_000);
    saved(null);
    reply = { status: 200, body: GOOD };
    const native = await rs.api("GET", "/api/usage");
    expect(calls.rs).toBe(7);
    expect(askedBy.rs.at(-1)).toBe("rust");
    // The trailing slash is not one of Rust's routes: the Bun child answers, from usage-last.json Rust wrote.
    const child = await rs.api("GET", "/api/usage/");
    expect(child.status).toBe(200);
    expect(child.data).toEqual(native.data);
    expect(calls.rs).toBe(7);
  });
});

describe.skipIf(!enabled)("Rust and Bun give the same spend answers", () => {
  /** Today's local day key. */
  const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  async function spend() {
    const [b, r] = await Promise.all([bun.api("GET", "/api/spend"), rs.api("GET", "/api/spend")]);
    expect(r.status).toBe(b.status);
    expect(r.data).toEqual(b.data);
    return b.data;
  }

  test("an empty data folder, then two boards with runs, side calls, huddle agents, quick chats and the helper", async () => {
    const empty = await spend();
    expect(empty).toEqual({ day: dayKey(new Date()), costUsd: 0, boards: [] });

    const now = new Date();
    const iso = now.toISOString();
    const yesterdayAt = new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - 12 * 3600_000);
    const result = (at: string, session: string, total: number) =>
      JSON.stringify({ run: 1, at, event: { type: "result", subtype: "success", total_cost_usd: total, session_id: session } }) + "\n";
    for (const [, d] of both()) {
      for (const name of ["Spender", "Other"]) {
        mkdirSync(join(d.project, name), { recursive: true });
        const p = await d.api("POST", "/api/profiles", { name, path: join(d.project, name) });
        expect(p.status).toBe(201);
        expect(p.data.slug).toBe(name.toLowerCase());
        const t = await d.api("POST", `/api/profiles/${p.data.slug}/tickets`, { title: "Costs money", body: "b" });
        const dir = join(d.home, "profiles", p.data.slug, "tickets", t.data.id);
        const k = name === "Spender" ? 1 : 3;
        appendFileSync(join(dir, "activity.jsonl"), result(yesterdayAt.toISOString(), "old", 1) + result(iso, "a", 0.1 * k) + result(iso, "a", 0.25 * k) + result(iso, "b", 0.05) + result(iso, "c", 0.3) + result(iso, "c", 0.1));
        appendFileSync(join(dir, "side-spend.jsonl"), JSON.stringify({ at: iso, kind: "simplify", costUsd: 0.02 * k }) + "\n");
        const chats = join(d.home, "profiles", p.data.slug, "chats");
        mkdirSync(chats, { recursive: true });
        appendFileSync(join(chats, "q1.activity.jsonl"), result(iso, "q", 0.07));
      }
      writeFileSync(join(d.home, "spend-days.json"), JSON.stringify({ [dayKey(yesterdayAt)]: { spender: 9 }, [dayKey(now)]: { spender: 0.4, other: 1.25 } }) + "\n");
      appendFileSync(join(d.home, "helper-spend.jsonl"), JSON.stringify({ at: iso, kind: "helper", costUsd: 0.011 }) + "\n");
    }
    // Both sides keep a counted spend for 5 s.
    await Bun.sleep(5_200);
    const full = await spend();
    expect(full.boards.map((b: any) => b.slug).sort()).toEqual(["other", "spender", "~helper"]);
  }, 30_000);
});

describe.skipIf(!enabled)("requests Rust doesn't answer itself", () => {
  test("other methods, other spellings and a foreign Host get Bun's answers", async () => {
    for (const [method, path] of [["POST", "/api/usage"], ["DELETE", "/api/spend"], ["GET", "/api/usage/x"], ["GET", "/api/spending"]]) {
      const [b, r] = await Promise.all([bun.api(method, path), rs.api(method, path)]);
      // /api/usage/x is Bun's usage answer: its check ran at another time on each side.
      const untimed = (v: any) => (v && typeof v === "object" ? { ...v, fetchedAt: typeof v.fetchedAt } : v);
      expect([method, path, r.status, untimed(r.data)]).toEqual([method, path, b.status, untimed(b.data)]);
    }
    for (const path of ["/api/usage", "/api/spend"]) {
      const [b, r] = await Promise.all([bun, rs].map((d) => fetch(d.url + path, { headers: { host: "evil.example" } })));
      expect([path, r.status, await r.text(), r.headers.get("content-type")]).toEqual([path, b.status, await b.text(), b.headers.get("content-type")]);
    }
  });

  test("Rust's answers carry Bun's content type", async () => {
    for (const path of ["/api/usage", "/api/spend"]) {
      const [b, r] = await Promise.all([bun, rs].map((d) => fetch(d.url + path)));
      expect(r.status).toBe(b.status);
      expect(r.headers.get("content-type")).toBe(b.headers.get("content-type"));
      expect(r.headers.get("cache-control")).toBe(b.headers.get("cache-control"));
      await Promise.all([r.text(), b.text()]);
    }
  });
});
