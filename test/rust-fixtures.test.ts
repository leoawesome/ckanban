// The shared fixtures of the Rust port (rust/core/tests/fixtures): inputs for plan usage and today's spend, with the
// answer Bun gives in `expect`. This test checks Bun still gives exactly those answers; `cargo test` in rust/
// checks Rust gives them too, so both sides are held to the same JSON. After a deliberate change to Bun's usage or
// spend code, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-fixtures.test.ts` to rewrite `expect`, then make
// `cargo test` pass again.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pickCredentials, normalizeUsage, fetchUsage, type UsageResult } from "../src/usage/usage";
import { UsageCache } from "../src/usage/usage-cache";
import { SpendIndex } from "../src/usage/spend";
import { Store } from "../src/core/store";
import { tempDir } from "./support/helpers";

const DIR = resolve(import.meta.dir, "..", "rust", "core", "tests", "fixtures");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";

/** Compares (or, when updating, rewrites) a fixture file's `expect` fields. */
function fixture(rel: string, fill: (doc: any) => Promise<void>) {
  return async () => {
    const file = join(DIR, rel);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const before = JSON.stringify(doc);
    const want = JSON.parse(before);
    await fill(doc);
    if (UPDATE) {
      writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
      return;
    }
    expect(JSON.parse(JSON.stringify(doc))).toEqual(want);
  };
}

const credsOf = (c: ReturnType<typeof pickCredentials>) =>
  "error" in c ? { error: c.error } : { token: c.token, expiresAt: c.expiresAt };

describe("Rust port fixtures: Bun gives the answers they record", () => {
  test("normalizeUsage", fixture("usage/normalize.json", async (doc) => {
    for (const c of doc.cases) c.expect = normalizeUsage(c.body);
  }));

  test("pickCredentials", fixture("usage/credentials.json", async (doc) => {
    for (const c of doc.cases) c.expect = credsOf(pickCredentials(c.raws));
  }));

  test("fetchUsage", fixture("usage/fetch.json", async (doc) => {
    for (const c of doc.cases) {
      let sent: { authorization: string; "anthropic-beta": string } | null = null;
      const fetchFn = (async (_url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        sent = { authorization: h.authorization, "anthropic-beta": h["anthropic-beta"] };
        if (!c.reply) throw new Error("asked without a reply");
        const status = c.reply.status;
        return new Response(status === 204 ? null : c.reply.body, { status, headers: c.reply.headers ?? {} });
      }) as unknown as typeof fetch;
      const result = await fetchUsage({ credentials: async () => pickCredentials(c.raws), fetchFn, now: () => doc.now });
      c.expect = { result, sent };
    }
  }));

  test("UsageCache", fixture("usage/cache.json", async (doc) => {
    for (const c of doc.cases) {
      const file = join(tempDir("ck-rust-cache-"), "usage-last.json");
      if (c.saved !== null) writeFileSync(file, c.saved);
      let now = doc.start;
      let reply: UsageResult | "hang" | undefined;
      let asked = false;
      const fetcher = (): Promise<UsageResult> => {
        asked = true;
        if (reply === undefined) throw new Error(`${c.name}: asked at a step without a reply`);
        return reply === "hang" ? new Promise<never>(() => {}) : Promise.resolve(reply);
      };
      const cache = new UsageCache(fetcher, () => {}, () => now, file, () => {}, c.timeoutMs ?? 10_000);
      const steps = [];
      for (const s of c.steps) {
        now = doc.start + s.t;
        reply = s.reply;
        asked = false;
        const view = await cache.get({ fresh: !!s.fresh });
        if (s.reply !== undefined && !asked) throw new Error(`${c.name}: a reply at t=${s.t} was not asked for`);
        steps.push({ asked, view });
      }
      c.expect = { steps, file: existsSync(file) ? readFileSync(file, "utf8") : null };
    }
  }));

  test("SpendIndex.today", fixture("spend/case.json", async (doc) => {
    const home = tempDir("ck-rust-spend-");
    cpSync(join(DIR, "spend", "home"), home, { recursive: true });
    for (const [rel, at] of Object.entries(doc.mtimes as Record<string, string>)) {
      const t = new Date(at);
      utimesSync(join(home, rel), t, t);
    }
    const spend = new SpendIndex(new Store(home), () => new Date(doc.now));
    doc.expect = spend.today();
  }));
});
