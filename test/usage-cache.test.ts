import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKOFF_MS, GOOD_TTL_MS, MIN_GAP_MS, UsageCache } from "../src/server/usage-cache";
import { fetchUsage, parseRetryAfter, type UsageResult } from "../src/server/usage";
import { resetLine, staleNote, usageError, usageWindows } from "../web/src/usage";
import { tempDir } from "./helpers";

const MIN = 60_000;
const win = (percent: number) => [{ key: "five_hour", label: "5h", percent, resetsAt: "2026-11-11T23:10:00Z" }];

/** A fake Anthropic: answers from a queue (the last one repeats) and counts calls. */
function setup(answers: (UsageResult | ((at: number) => UsageResult))[], file?: string) {
  let now = 1_000_000_000_000;
  const box = { calls: 0, results: [] as UsageResult[] };
  const iso = () => new Date(now).toISOString();
  const cache = new UsageCache(async () => {
    const a = answers[Math.min(box.calls, answers.length - 1)];
    box.calls++;
    const r = typeof a === "function" ? a(now) : a;
    return { ...r, fetchedAt: iso() };
  }, (r) => box.results.push(r), () => now, file);
  return { cache, box, tick: (ms: number) => { now += ms; }, now: () => now };
}

const ok = (p = 40): UsageResult => ({ windows: win(p), fetchedAt: "" });
const limited = (retryAfterMs?: number): UsageResult => ({ error: "Anthropic is limiting usage checks", fetchedAt: "", status: 429, ...(retryAfterMs !== undefined && { retryAfterMs }) });

test("one call in flight is shared and a good answer is reused for every caller", async () => {
  const { cache, box, tick } = setup([ok()]);
  await Promise.all([cache.get(), cache.get(), cache.get({ fresh: true })]);
  expect(box.calls).toBe(1);
  tick(GOOD_TTL_MS - 1000);
  expect(await cache.get()).toMatchObject({ windows: win(40) });
  expect(box.calls).toBe(1);
  tick(2000);
  await cache.get();
  expect(box.calls).toBe(2);
});

test("Refresh asks now, but at most once a minute", async () => {
  const { cache, box, tick } = setup([ok(1), ok(2), ok(3)]);
  await cache.get();
  tick(30_000);
  expect(await cache.get({ fresh: true })).toMatchObject({ windows: win(1) });
  expect(box.calls).toBe(1);
  tick(MIN_GAP_MS - 30_000);
  expect(await cache.get({ fresh: true })).toMatchObject({ windows: win(2) });
  expect(box.calls).toBe(2);
});

test("a 429 keeps the last numbers next to the error", async () => {
  const { cache, box, tick } = setup([ok(40), limited()]);
  await cache.get();
  tick(GOOD_TTL_MS);
  const v = await cache.get();
  expect(v).toMatchObject({ windows: win(40), stale: true, limited: true, error: "Anthropic is limiting usage checks", retryAt: expect.any(String) });
  expect(box.calls).toBe(2);
  expect(box.results.at(-1)).toMatchObject({ status: 429 });
});

test("backoff steps without retry-after", async () => {
  const { cache, box, tick, now } = setup([limited()]);
  const steps: number[] = [];
  for (let i = 0; i < 5; i++) {
    const v = await cache.get();
    expect("windows" in v).toBe(false);
    const retryAt = Date.parse((v as { retryAt: string }).retryAt);
    steps.push(retryAt - now());
    const calls = box.calls;
    tick(retryAt - now() - 1);
    await cache.get({ fresh: true });
    expect(box.calls).toBe(calls);
    tick(1);
  }
  expect(steps).toEqual([MIN, 2 * MIN, 4 * MIN, 10 * MIN, 10 * MIN]);
});

test("retry-after is honored, and a success resets the backoff", async () => {
  const { cache, box, tick, now } = setup([limited(7 * MIN), ok(10), limited()]);
  const v = await cache.get();
  expect(Date.parse((v as { retryAt: string }).retryAt) - now()).toBe(7 * MIN);
  expect(v).toMatchObject({ error: expect.stringContaining("next try in about 7 min"), limited: true });
  tick(7 * MIN - 1);
  await cache.get({ fresh: true });
  expect(box.calls).toBe(1);
  tick(1);
  expect(await cache.get()).toEqual({ windows: win(10), fetchedAt: expect.any(String) });
  tick(GOOD_TTL_MS);
  const after = await cache.get();
  expect(Date.parse((after as { retryAt: string }).retryAt) - now()).toBe(MIN);
});

test("a small retry-after doesn't skip the growing wait", async () => {
  const { cache, box, tick, now } = setup([limited(0)]);
  const steps: number[] = [];
  for (let i = 0; i < 5; i++) {
    const v = await cache.get();
    const retryAt = Date.parse((v as { retryAt: string }).retryAt);
    steps.push(retryAt - now());
    tick(retryAt - now());
  }
  expect(box.calls).toBe(5);
  expect(steps).toEqual([...BACKOFF_MS, BACKOFF_MS.at(-1)!]);
});

test("a huge retry-after is capped at 30 minutes", async () => {
  const { cache, now } = setup([limited(5 * 3600_000)]);
  const v = await cache.get();
  expect(Date.parse((v as { retryAt: string }).retryAt) - now()).toBe(30 * MIN);
});

test("a stuck check gives up after the time limit and doesn't hang later requests", async () => {
  let calls = 0;
  let now = 1_000_000_000_000;
  const cache = new UsageCache(() => { calls++; return new Promise(() => {}); }, () => {}, () => now, undefined, () => {}, 20);
  const v = await cache.get();
  expect(v).toMatchObject({ error: expect.stringContaining("took over") });
  now += MIN_GAP_MS;
  await cache.get();
  expect(calls).toBe(2);
});

test("times saved before the clock was set back don't block checks", async () => {
  const file = join(tempDir("ck-usage-"), "usage-last.json");
  const now = 1_000_000_000_000;
  const year = 365 * 24 * 3600_000;
  writeFileSync(file, JSON.stringify({ last: null, lastError: null, attemptAt: now + year, blockedUntil: now + year, failures: 1 }));
  let t = now;
  let calls = 0;
  const cache = new UsageCache(async () => { calls++; return { ...ok(5), fetchedAt: new Date(t).toISOString() }; }, () => {}, () => t, file);
  await cache.get(); // within a minute of the clamped attempt: still waits the normal gap
  expect(calls).toBe(0);
  t += 30 * MIN; // past the longest wait
  expect(await cache.get()).toMatchObject({ windows: win(5) });
  expect(calls).toBe(1);
});

test("other errors keep the last numbers and retry after a minute", async () => {
  const { cache, box, tick } = setup([ok(33), { error: "Could not reach Anthropic (offline?)", fetchedAt: "" }, ok(34)]);
  await cache.get();
  tick(GOOD_TTL_MS);
  const v = await cache.get();
  expect(v).toMatchObject({ windows: win(33), stale: true, error: "Could not reach Anthropic (offline?)" });
  expect("retryAt" in v).toBe(false);
  tick(MIN_GAP_MS);
  expect(await cache.get()).toMatchObject({ windows: win(34) });
  expect(box.calls).toBe(3);
});

test("the last good answer and the backoff are saved and loaded on start", async () => {
  const file = join(tempDir("ck-usage-"), "usage-last.json");
  const a = setup([ok(61), limited()], file);
  await a.cache.get();
  a.tick(GOOD_TTL_MS);
  await a.cache.get();
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).not.toContain("token");
  // A restart: same clock, new cache from the file.
  let calls = 0;
  const b = new UsageCache(async () => { calls++; return ok(62); }, () => {}, a.now, file);
  expect(await b.get({ fresh: true })).toMatchObject({ windows: win(61), stale: true, limited: true });
  expect(calls).toBe(0);
});

test("a fresh saved answer is served after a restart without asking", async () => {
  const file = join(tempDir("ck-usage-"), "usage-last.json");
  const a = setup([ok(70)], file);
  await a.cache.get();
  a.tick(MIN_GAP_MS);
  let calls = 0;
  const b = new UsageCache(async () => { calls++; return ok(71); }, () => {}, a.now, file);
  expect(await b.get()).toMatchObject({ windows: win(70) });
  expect(calls).toBe(0);
});

test("fetchUsage reports 429 with its retry-after", async () => {
  const creds = async () => ({ token: "t", expiresAt: null });
  const f = (async () => new Response("", { status: 429, headers: { "retry-after": "120" } })) as unknown as typeof fetch;
  expect(await fetchUsage({ credentials: creds, fetchFn: f, now: () => 0 })).toMatchObject({ status: 429, retryAfterMs: 120_000 });
  const g = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
  const r = await fetchUsage({ credentials: creds, fetchFn: g, now: () => 0 });
  expect(r).toMatchObject({ status: 429 });
  expect("retryAfterMs" in r).toBe(false);
  expect(parseRetryAfter("Wed, 11 Nov 2026 10:02:00 GMT", Date.parse("2026-11-11T10:00:00Z"))).toBe(120_000);
  expect(parseRetryAfter("soon")).toBeUndefined();
});

test("web usage helpers: kept numbers get a note, the red error only without numbers", () => {
  const stale = { windows: win(5), fetchedAt: "", stale: true, error: "Anthropic is limiting usage checks", limited: true };
  expect(usageWindows(stale)).toEqual(win(5));
  expect(usageError(stale)).toBeNull();
  expect(staleNote(stale)).toBe("Couldn't update just now (Anthropic is limiting checks). Showing the last numbers.");
  expect(staleNote({ windows: win(5), fetchedAt: "" })).toBeNull();
  expect(usageError({ error: "x", fetchedAt: "" })).toBe("x");
  expect(usageWindows({ error: "x", fetchedAt: "" })).toEqual([]);
  const now = Date.parse("2026-11-11T10:00:00Z");
  expect(resetLine("2026-11-11T12:13:00Z", now)).toMatch(/^Resets at .+, in 2h 13m$/);
  expect(resetLine("2026-11-13T22:00:00Z", now)).toMatch(/^Resets \S+ .+, in 2d 12h$/);
  expect(resetLine(null, now)).toBeNull();
});
