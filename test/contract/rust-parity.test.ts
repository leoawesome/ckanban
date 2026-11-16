// Parity of the Rust front server's own routes (GET /api/usage, GET /api/spend, the passes routes, GET /api/agents) with Bun's: the same data folder
// contents, given to the Bun daemon alone and to `ckanban-rs dev`, must give the same answers after JSON parsing and
// the same usage-last.json / usage-windows.json. Times taken from the clock (fetchedAt, retryAt, attemptAt...) only
// have to be close. Runs only under `bun run test:contract:rust`, which sets CKANBAN_PARITY_RS to the Rust server's
// command; `bun run test` skips it (it needs cargo).
//
// Both daemons keep running through the scenarios: each step rewrites usage-last.json (both sides read it again when
// it changes) and the fake's reply, so the one-minute gap between checks doesn't need a new daemon per step.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// ---- Passes and saved keys (rust/src/passes.rs) and GET /api/agents (rust/src/agents.rs) ----

/**
 * A request from "the user's browser": the guard (src/integrations/guard.ts, rust/src/guard.rs) lets through only a
 * process whose executable path looks like a browser's and that the board didn't start. A Bun started through a link
 * named Firefox, by this test, is that. Prints `{ status, type, text }`.
 */
let browserDir = "";
function browserBin(): string {
  if (!browserDir) {
    browserDir = mkdtempSync(join(tmpdir(), "ck-parity-browser-"));
    mkdirSync(join(browserDir, "Firefox.app"));
    symlinkSync(process.execPath, join(browserDir, "Firefox.app", "Firefox"));
    writeFileSync(join(browserDir, "req.ts"), `
const [url, method, body, headers] = process.argv.slice(2);
const r = await fetch(url, { method, headers: JSON.parse(headers), body: body === "-" ? undefined : body });
console.log(JSON.stringify({ status: r.status, type: r.headers.get("content-type"), text: await r.text() }));
`);
  }
  return join(browserDir, "Firefox.app", "Firefox");
}
async function asBrowser(d: Daemon, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h = { origin: d.url.replace("127.0.0.1", "localhost"), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers };
  const raw = body === undefined ? "-" : typeof body === "string" ? body : JSON.stringify(body);
  const p = Bun.spawn([browserBin(), join(browserDir, "req.ts"), d.url + path, method, raw, JSON.stringify(h)], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (!out.trim()) throw new Error(`browser request failed: ${err}`);
  return JSON.parse(out) as { status: number; type: string | null; text: string };
}

/** Raw answers of both sides for the same request. */
async function rawBoth(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const one = async (d: Daemon) => {
    const r = await fetch(d.url + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
  };
  return Promise.all([one(bun), one(rs)]);
}

const SECRETS = ["sk-board-key-1234567890", "sk-automation-key-abcdef", "tok-access-zyxwvut-987", "sk-replaced-value-5555", "sk-new-board-key-0000"];
/** Ids and times each side makes itself: the same shape, not the same value. */
const scrub = (text: string) =>
  text.replace(/"id":"[a-z0-9]{8}"/g, '"id":"<id>"').replace(/"(createdAt|savedAt)":"[0-9T:.Z-]{24}"/g, '"$1":"<time>"');

function seedPasses(d: Daemon) {
  const at = "2026-11-01T10:00:00.000Z";
  const passes = [
    { id: "p1board", kind: "key", name: "Sentry token", claudeName: null, envName: "SENTRY_AUTH_TOKEN", board: "keys", secret: SECRETS[0], status: "connected", error: null, createdAt: at, savedAt: at },
    { id: "p2auto", kind: "key", name: "Linear", claudeName: "linear", envName: "LINEAR_API_KEY", secret: SECRETS[1], status: "connected", error: null, createdAt: at },
    {
      id: "p3mcp", kind: "mcp", name: `Has ${SECRETS[0]} in its name`, claudeName: null, url: "https://mcp.example.com/sse", status: "needs_reconnect",
      error: `refused Bearer ${SECRETS[2]} and ${SECRETS[1]} --token abc`, tokens: { access: SECRETS[2], refresh: "r-1234567" }, createdAt: at,
    },
    { id: "p4gone", kind: "key", name: "Old board key", claudeName: null, envName: "OLD_KEY", board: "gone-board", secret: "short", status: "connected", error: null, createdAt: at },
  ];
  writeFileSync(join(d.home, "automation-passes.json"), JSON.stringify({ version: 1, passes }, null, 2) + "\n", { mode: 0o600 });
  const loops = join(d.home, "profiles", "keys", "loops");
  mkdirSync(loops, { recursive: true });
  const loop = (id: string, name: string, passes: string[], createdAt: string) => ({
    version: 1, id, name, enabled: false, service: "Linear", passes, scriptHash: "", everyMinutes: 60, column: "backlog", autoStart: false,
    askClaude: { on: false, prompt: "" }, instructions: "", allowedTools: null, createdAt, updatedAt: createdAt, lastCheckedAt: null, lastFiredAt: null, lastError: null,
  });
  writeFileSync(join(loops, "bbb.json"), JSON.stringify(loop("bbb", "Second watcher", ["p2auto"], "2026-11-02T00:00:00.000Z")));
  writeFileSync(join(loops, "aaa.json"), JSON.stringify(loop("aaa", "First watcher", ["p2auto", "p1board", "nope"], "2026-11-01T00:00:00.000Z")));
}

describe.skipIf(!enabled)("Rust and Bun give the same passes and keys answers", () => {
  beforeAll(async () => {
    for (const [, d] of both()) {
      mkdirSync(join(d.project, "Keys"), { recursive: true });
      const p = await d.api("POST", "/api/profiles", { name: "Keys", path: join(d.project, "Keys") });
      expect(p.data.slug).toBe("keys");
      seedPasses(d);
    }
  });
  afterAll(() => {
    if (browserDir) rmSync(browserDir, { recursive: true, force: true });
  });

  test("the list: byte for byte, secrets masked, usage by automations, board names", async () => {
    const [b, r] = await rawBoth("GET", "/api/passes");
    expect(r).toEqual(b);
    expect(b.status).toBe(200);
    for (const s of SECRETS) expect(b.text).not.toContain(s);
    const list = JSON.parse(b.text);
    expect(list.automations).toBe(2);
    const p2 = list.passes.find((p: any) => p.id === "p2auto");
    expect([p2.usedBy, p2.usedByNames]).toEqual([2, ["First watcher", "Second watcher"]]);
    expect(list.passes.find((p: any) => p.id === "p1board").boardName).toBe("Keys");
    expect(list.passes.find((p: any) => p.id === "p4gone").boardName).toBe("gone-board");
    expect(list.passes.find((p: any) => p.id === "p3mcp").error).toBe("refused Bearer *** and *** --token ***");
  });

  test("refusals: no Origin, a run, a program that isn't a browser, a foreign Origin or Host, not JSON", async () => {
    const origin = { origin: bun.url.replace("127.0.0.1", "localhost") };
    const cases: [string, string, unknown, (d: Daemon) => Record<string, string>][] = [
      ["POST", "/api/passes", { kind: "key", name: "X", secret: "abcdefgh" }, () => ({ "content-type": "application/json" })],
      ["PATCH", "/api/passes/p2auto", { secret: "x" }, (d) => ({ "content-type": "application/json", origin: d.url })],
      ["DELETE", "/api/passes/p2auto", undefined, (d) => ({ origin: d.url, "x-ckanban-run": "t_1" })],
      ["DELETE", "/api/passes/p2auto", undefined, (d) => ({ origin: d.url, "x-ckanban-huddle-agent": "a" })],
      ["POST", "/api/passes", { kind: "key" }, () => ({ "content-type": "application/json", origin: "http://evil.example" })],
      ["PATCH", "/api/passes/p2auto", { secret: "x" }, () => ({ "content-type": "text/plain", ...origin })],
      ["GET", "/api/passes", undefined, () => ({ host: "evil.example" })],
      ["GET", "/api/agents", undefined, () => ({ host: "localhost" })],
    ];
    for (const [method, path, body, headers] of cases) {
      const one = async (d: Daemon) => {
        const h = headers(d);
        // Each side's own port in its Origin and Host.
        for (const k of Object.keys(h)) h[k] = h[k].replace(String(bun.port), String(d.port));
        const res = await fetch(d.url + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, type: res.headers.get("content-type"), text: (await res.text()).replaceAll(String(d.port), "PORT") };
      };
      const [b, r] = await Promise.all([one(bun), one(rs)]);
      expect([method, path, r]).toEqual([method, path, b]);
      expect(b.status).toBeGreaterThanOrEqual(400);
    }
    // Nothing changed on either side.
    expect(readFileSync(join(rs.home, "automation-passes.json"), "utf8")).toBe(readFileSync(join(bun.home, "automation-passes.json"), "utf8"));
  });

  test("the user's browser: add, refuse, replace and delete keys, with the same answers and the same file", async () => {
    const steps: [string, string, unknown?][] = [
      ["POST", "/api/passes", { kind: "key", name: "  New   board key ", envName: "NEW_BOARD_KEY", board: "keys", secret: ` ${SECRETS[4]} ` }],
      ["POST", "/api/passes", { kind: "key", name: "Again", envName: "NEW_BOARD_KEY", board: "keys", secret: "abcdefgh1" }],
      ["POST", "/api/passes", { kind: "key", name: "Gh", envName: "GITHUB_TOKEN", board: "keys", secret: "abcdefgh1" }],
      ["POST", "/api/passes", { kind: "key", name: "Bad", board: "no-such-board", secret: "abcdefgh1" }],
      ["POST", "/api/passes", { kind: "key", name: "Two\nlines", secret: "a\nb" }],
      ["POST", "/api/passes", { kind: "key", name: "", secret: "abcdefgh1" }],
      ["POST", "/api/passes", { kind: "key", name: "Linear API", secret: "abcdefgh2" }],
      ["POST", "/api/passes", { kind: "key", name: "Path", envName: "PATH", secret: "abcdefgh3" }],
      ["POST", "/api/passes", "{not json"],
      ["POST", "/api/passes", "null"],
      // Kinds Rust leaves to Bun: the answer is Bun's either way.
      ["POST", "/api/passes", { kind: "mcp", name: "Online", url: "https://mcp.example.org/mcp" }],
      ["POST", "/api/passes", { kind: "key", name: "Server key", url: "https://mcp.example.org/x", secret: "abcdefgh4" }],
      ["PATCH", "/api/passes/p2auto", { secret: `  ${SECRETS[3]}  ` }],
      ["PATCH", "/api/passes/p3mcp", { secret: "abcdefgh5" }],
      ["PATCH", "/api/passes/p2auto", { secret: "" }],
      ["PATCH", "/api/passes/missing1", { secret: "abcdefgh6" }],
      ["DELETE", "/api/passes/p4gone"],
      ["DELETE", "/api/passes/p4gone"],
    ];
    for (const [method, path, body] of steps) {
      const [b, r] = await Promise.all([asBrowser(bun, method, path, body), asBrowser(rs, method, path, body)]);
      expect([method, path, body, { ...r, text: scrub(r.text) }]).toEqual([method, path, body, { ...b, text: scrub(b.text) }]);
      for (const s of SECRETS) expect(b.text).not.toContain(s);
    }
    const file = (d: Daemon) => scrub(JSON.stringify(JSON.parse(readFileSync(join(d.home, "automation-passes.json"), "utf8"))));
    expect(file(rs)).toBe(file(bun));
    expect(file(bun)).toContain(SECRETS[3]);
    expect(statSync(join(rs.home, "automation-passes.json")).mode & 0o777).toBe(0o600);
    const [b, r] = await rawBoth("GET", "/api/passes");
    expect({ ...r, text: scrub(r.text) }).toEqual({ ...b, text: scrub(b.text) });
  }, 60_000);

  test("Rust answers these itself, and its change reaches the UI's event stream", async () => {
    const child = Number(Bun.spawnSync(["pgrep", "-P", String(rs.pid)]).stdout.toString().trim().split("\n")[0]);
    expect(child).toBeGreaterThan(1);
    const ctl = new AbortController();
    const events = await fetch(`${rs.url}/api/events`, { signal: ctl.signal });
    const reader = events.body!.getReader();
    let seen = "";
    // Bun child paused: only Rust can answer.
    process.kill(child, "SIGSTOP");
    try {
      const quick = (p: Promise<Response | { status: number }>) => Promise.race([p, Bun.sleep(3_000).then(() => ({ status: -1 }))]);
      expect((await quick(fetch(`${rs.url}/api/passes`))).status).toBe(200);
      expect((await quick(fetch(`${rs.url}/api/agents`))).status).toBe(200);
      const patched = await Promise.race([asBrowser(rs, "PATCH", "/api/passes/p2auto", { secret: SECRETS[3] }), Bun.sleep(5_000).then(() => null)]);
      expect(patched?.status).toBe(200);
    } finally {
      process.kill(child, "SIGCONT");
    }
    const end = Date.now() + 5_000;
    while (!seen.includes('"integration.updated"') && Date.now() < end) {
      const r = await Promise.race([reader.read(), Bun.sleep(end - Date.now()).then(() => null)]);
      if (!r || r.done) break;
      seen += new TextDecoder().decode(r.value);
    }
    ctl.abort();
    expect(seen).toContain('"integration.updated"');
  }, 30_000);

  test("Rust waits for the lock Bun takes around its own changes", async () => {
    const lock = openSync(join(rs.home, "automation-passes.json.lock"), constants.O_RDWR | constants.O_CREAT | 0x20, 0o600);
    let done = false;
    const pending = asBrowser(rs, "PATCH", "/api/passes/p2auto", { secret: "abcdefgh7" }).then((r) => ((done = true), r));
    await Bun.sleep(1_000);
    expect(done).toBe(false);
    closeSync(lock);
    expect((await pending).status).toBe(200);
  }, 30_000);

  test("GET /api/agents: the same, with nothing registered and with ckanban registered in Claude Code and Codex", async () => {
    const [b0, r0] = await rawBoth("GET", "/api/agents");
    expect(r0).toEqual(b0);
    const argv = JSON.parse(b0.text)[0];
    expect(argv.installed).toBe(false);
    for (const [, d] of both()) {
      const cmd = [realpathSync(process.execPath), realpathSync(join(import.meta.dir, "..", "..", "src", "cli.ts"))];
      writeFileSync(join(d.env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ mcpServers: { ckanban: { command: cmd[0], args: [cmd[1], "mcp"] } } }));
      mkdirSync(join(d.env.HOME, ".codex"), { recursive: true });
      writeFileSync(join(d.env.HOME, ".codex", "config.toml"), `[mcp_servers.ckanban]\ncommand = "/old/ckanban"\nargs = ['mcp']\n`);
    }
    const [b, r] = await rawBoth("GET", "/api/agents");
    expect(r.text.replaceAll(rs.env.HOME, "HOME").replaceAll(rs.env.CLAUDE_CONFIG_DIR, "CFG")).toBe(b.text.replaceAll(bun.env.HOME, "HOME").replaceAll(bun.env.CLAUDE_CONFIG_DIR, "CFG"));
    const [claude, codex] = JSON.parse(b.text);
    expect([claude.installed, claude.current, codex.installed, codex.current, codex.available]).toEqual([true, true, true, false, true]);
  });
});
