// Outside-in contract for plan usage (GET /api/usage) and today's spend (GET /api/spend).
// Usage: the daemon asks a local fake of Anthropic's usage endpoint (CKANBAN_USAGE_URL) with the token from
// $CLAUDE_CONFIG_DIR/.credentials.json (CKANBAN_NO_KEYCHAIN=1 keeps the Mac keychain out). Cache hits are proven by
// counting the fake's calls. Each scenario gets its own daemon (the cache is per daemon) and its own path on the fake.
// Spend: activity logs, side-spend ledgers, spend-days.json, quick chat logs and helper-spend.jsonl, as
// contracts/data-files.md describes them, written by the test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";

// ---------- a fake of Anthropic's usage endpoint ----------

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
interface Seen {
  auth: string | null;
  beta: string | null;
}
const replies = new Map<string, Reply>();
const seen = new Map<string, Seen[]>();
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const name = new URL(req.url).pathname.split("/")[2] ?? "";
    seen.set(name, [...(seen.get(name) ?? []), { auth: req.headers.get("authorization"), beta: req.headers.get("anthropic-beta") }]);
    const r = replies.get(name) ?? { status: 404, body: { error: "unknown scenario" } };
    return Response.json(r.body ?? {}, { status: r.status, headers: r.headers });
  },
});
const calls = (name: string) => seen.get(name)?.length ?? 0;

const RESETS = new Date(Date.now() + 3 * 3600_000).toISOString();
const GOOD_BODY = {
  five_hour: { utilization: 42, resets_at: RESETS },
  seven_day: { utilization: 17.5, resets_at: null },
  extra_usage: { is_enabled: false },
};

function credentials(claudeDir: string, token: string) {
  writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 3600_000 } }));
}

/** usage-last.json as data-files.md describes it (times in epoch ms). */
function savedUsage(home: string, s: { percent: number; fetchedAgoMs: number; attemptAgoMs: number }) {
  const now = Date.now();
  writeFileSync(join(home, "usage-last.json"), JSON.stringify({
    last: { windows: [{ key: "five_hour", label: "Current session (5h)", percent: s.percent, resetsAt: RESETS }], fetchedAt: new Date(now - s.fetchedAgoMs).toISOString() },
    lastError: null,
    attemptAt: now - s.attemptAgoMs,
    blockedUntil: 0,
    failures: 0,
  }));
}

async function usageDaemon(name: string, reply: Reply | null, setup: (dirs: { home: string; claudeDir: string }) => void): Promise<Daemon> {
  if (reply) replies.set(name, reply);
  return startDaemon({ env: { CKANBAN_USAGE_URL: `http://127.0.0.1:${fake.port}/s/${name}/api/oauth/usage` }, before: setup });
}

const isIso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

function expectWindows(data: any) {
  expect(Array.isArray(data.windows)).toBe(true);
  for (const w of data.windows) {
    expect(typeof w.key).toBe("string");
    expect(typeof w.label).toBe("string");
    expect(typeof w.percent).toBe("number");
    expect(w.resetsAt === null || isIso(w.resetsAt)).toBe(true);
  }
  expect(isIso(data.fetchedAt)).toBe(true);
}

async function getUsage(d: Daemon, fresh = false) {
  const r = await d.api("GET", `/api/usage${fresh ? "?fresh=1" : ""}`);
  expect(r.status).toBe(200);
  return r.data;
}

const daemons: Daemon[] = [];
let cached: Daemon, fresh: Daemon, failing: Daemon, failingStale: Daemon, limited: Daemon, noCreds: Daemon;

beforeAll(async () => {
  [cached, fresh, failing, failingStale, limited, noCreds] = await Promise.all([
    usageDaemon("cached", { status: 200, body: GOOD_BODY }, ({ claudeDir }) => credentials(claudeDir, "tok-cached")),
    // Saved numbers a minute old, last call two minutes ago: a plain GET reuses them, fresh=1 may ask.
    usageDaemon("fresh", { status: 200, body: GOOD_BODY }, ({ home, claudeDir }) => {
      credentials(claudeDir, "tok-fresh");
      savedUsage(home, { percent: 7, fetchedAgoMs: 60_000, attemptAgoMs: 120_000 });
    }),
    usageDaemon("failing", { status: 500, body: { error: "boom" } }, ({ claudeDir }) => credentials(claudeDir, "tok-failing")),
    // Saved numbers too old to reuse: the daemon asks, fails, and serves them marked stale.
    usageDaemon("stale", { status: 500, body: { error: "boom" } }, ({ home, claudeDir }) => {
      credentials(claudeDir, "tok-stale");
      savedUsage(home, { percent: 9, fetchedAgoMs: 3600_000, attemptAgoMs: 3600_000 });
    }),
    usageDaemon("limited", { status: 429, body: { error: "slow down" }, headers: { "retry-after": "120" } }, ({ claudeDir }) => credentials(claudeDir, "tok-limited")),
    usageDaemon("nocreds", { status: 200, body: GOOD_BODY }, () => {}),
  ]);
  daemons.push(cached, fresh, failing, failingStale, limited, noCreds);
}, 60_000);

afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
  fake.stop(true);
}, 30_000);

describe("GET /api/usage", () => {
  test("asks Anthropic once with the stored token, then answers from its cache", async () => {
    const first = await getUsage(cached);
    expectWindows(first);
    expect(first.windows.map((w: any) => [w.key, w.percent, w.resetsAt])).toEqual([["five_hour", 42, RESETS], ["seven_day", 17.5, null]]);
    expect(first.error).toBeUndefined();
    expect(first.stale).toBeUndefined();
    expect(calls("cached")).toBe(1);
    expect(seen.get("cached")![0]).toEqual({ auth: "Bearer tok-cached", beta: "oauth-2025-04-20" });

    const again = await getUsage(cached);
    expect(again).toEqual(first);
    // fresh=1 inside a minute of the last call still answers from the cache: at most one call a minute.
    expect(await getUsage(cached, true)).toEqual(first);
    expect(calls("cached")).toBe(1);

    // The answer is saved for the next start (usage-last.json, data-files.md).
    const saved = JSON.parse(readFileSync(join(cached.home, "usage-last.json"), "utf8"));
    expect(saved.last.windows.map((w: any) => w.percent)).toEqual([42, 17.5]);
    expect(saved.lastError).toBeNull();
    for (const k of ["attemptAt", "blockedUntil", "failures"]) expect(typeof saved[k]).toBe("number");
  });

  test("fresh=1 asks Anthropic now; a plain GET reuses the saved answer", async () => {
    const plain = await getUsage(fresh);
    expectWindows(plain);
    expect(plain.windows.map((w: any) => w.percent)).toEqual([7]);
    expect(calls("fresh")).toBe(0);

    const now = await getUsage(fresh, true);
    expectWindows(now);
    expect(now.windows.map((w: any) => w.percent)).toEqual([42, 17.5]);
    expect(calls("fresh")).toBe(1);
    expect(seen.get("fresh")![0].auth).toBe("Bearer tok-fresh");

    expect((await getUsage(fresh)).windows.map((w: any) => w.percent)).toEqual([42, 17.5]);
    expect(calls("fresh")).toBe(1);
  });

  test("Anthropic failing with no saved numbers: the error alone, and no retry inside the minute", async () => {
    const r = await getUsage(failing);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
    expect(isIso(r.fetchedAt)).toBe(true);
    expect(r.windows).toBeUndefined();
    expect(calls("failing")).toBe(1);
    expect((await getUsage(failing, true)).error).toBe(r.error);
    expect(calls("failing")).toBe(1);
  });

  test("Anthropic failing with saved numbers: the last good numbers, marked stale with the error", async () => {
    const r = await getUsage(failingStale);
    expectWindows(r);
    expect(r.windows.map((w: any) => w.percent)).toEqual([9]);
    expect(r.stale).toBe(true);
    expect(typeof r.error).toBe("string");
    expect(calls("stale")).toBe(1);
  });

  test("Anthropic rate limiting: limited with a retry time, and no call until then", async () => {
    const r = await getUsage(limited);
    expect(typeof r.error).toBe("string");
    expect(r.limited).toBe(true);
    expect(isIso(r.retryAt)).toBe(true);
    // retry-after was 120 s: the next try is about two minutes away.
    expect(Date.parse(r.retryAt) - Date.now()).toBeGreaterThan(60_000);
    expect(calls("limited")).toBe(1);
    expect((await getUsage(limited, true)).limited).toBe(true);
    expect(calls("limited")).toBe(1);
  });

  test("no credentials: an error, and Anthropic is never asked", async () => {
    const r = await getUsage(noCreds);
    expect(typeof r.error).toBe("string");
    expect(isIso(r.fetchedAt)).toBe(true);
    expect(r.windows).toBeUndefined();
    expect(calls("nocreds")).toBe(0);
  });
});

// ---------- GET /api/spend ----------

/** Local day key (YYYY-MM-DD), as spend files use it. */
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function expectSpendShape(s: any) {
  expect(s.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof s.costUsd).toBe("number");
  expect(Array.isArray(s.boards)).toBe(true);
  for (const b of s.boards) {
    expect(typeof b.slug).toBe("string");
    expect(typeof b.name).toBe("string");
    expect(typeof b.costUsd).toBe("number");
  }
}

describe("GET /api/spend", () => {
  test("an empty board spent nothing today", async () => {
    const p = await noCreds.api("POST", "/api/profiles", { name: "Empty", path: noCreds.project });
    expect(p.status).toBe(201);
    const r = await noCreds.api("GET", "/api/spend");
    expect(r.status).toBe(200);
    expectSpendShape(r.data);
    expect(r.data).toEqual({ day: dayKey(new Date()), costUsd: 0, boards: [{ slug: p.data.slug, name: "Empty", costUsd: 0 }] });
  });

  test("adds up today's runs, side calls, huddle agents, quick chats and the helper", async () => {
    const d = cached;
    const p = await d.api("POST", "/api/profiles", { name: "Spender", path: d.project });
    expect(p.status).toBe(201);
    const slug = p.data.slug;
    const t = await d.api("POST", `/api/profiles/${slug}/tickets`, { title: "Costs money", body: "b" });
    expect(t.status).toBe(201);
    const now = new Date();
    const today = dayKey(now);
    const yesterdayAt = new Date(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - 12 * 3600_000);
    const yesterday = dayKey(yesterdayAt);
    const iso = now.toISOString();
    const result = (at: Date | string, session: string, total: number) =>
      JSON.stringify({ run: 1, at: typeof at === "string" ? at : at.toISOString(), event: { type: "result", subtype: "success", is_error: false, total_cost_usd: total, session_id: session, result: "ok" } }) + "\n";

    const ticketDir = join(d.home, "profiles", slug, "tickets", t.data.id);
    expect(existsSync(ticketDir)).toBe(true);
    // Result lines carry the session's running total: session a cost 0.25 in all, session b 0.05; yesterday's doesn't count.
    appendFileSync(join(ticketDir, "activity.jsonl"),
      JSON.stringify({ run: 1, at: iso, event: { type: "ckanban_run", kind: "work" } }) + "\n" +
      result(yesterdayAt, "old", 1) + result(iso, "a", 0.1) + result(iso, "a", 0.25) + result(iso, "b", 0.05));
    appendFileSync(join(ticketDir, "side-spend.jsonl"),
      JSON.stringify({ at: yesterdayAt.toISOString(), kind: "simplify", costUsd: 0.5 }) + "\n" + JSON.stringify({ at: iso, kind: "simplify", costUsd: 0.02 }) + "\n");
    writeFileSync(join(d.home, "spend-days.json"), JSON.stringify({ [yesterday]: { [slug]: 9 }, [today]: { [slug]: 0.4 } }) + "\n");
    const chats = join(d.home, "profiles", slug, "chats");
    mkdirSync(chats, { recursive: true });
    appendFileSync(join(chats, "q1.activity.jsonl"), result(iso, "q", 0.07));
    appendFileSync(join(d.home, "helper-spend.jsonl"), JSON.stringify({ at: iso, kind: "helper", costUsd: 0.011 }) + "\n");

    const r = await d.api("GET", "/api/spend");
    expect(r.status).toBe(200);
    expectSpendShape(r.data);
    expect(r.data.day).toBe(today);
    const boards = Object.fromEntries(r.data.boards.map((b: any) => [b.slug, b]));
    expect(Object.keys(boards).sort()).toEqual([slug, "~helper"].sort());
    expect(boards[slug].name).toBe("Spender");
    // 0.25 + 0.05 (runs) + 0.02 (side call) + 0.4 (huddle agents) + 0.07 (quick chat)
    expect(boards[slug].costUsd).toBeCloseTo(0.79, 9);
    expect(boards["~helper"]).toEqual({ slug: "~helper", name: "Helper", costUsd: 0.011 });
    expect(r.data.costUsd).toBeCloseTo(0.801, 9);
  });
});
