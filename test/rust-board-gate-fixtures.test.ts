// The R13 gate's shared fixtures (rust/board/tests/fixtures/gate.json): inputs for the request gate
// (`requestRefusal`, `isAllowedSocket` in src/api/context.ts), cron (`cronError`, `describeCron`, `nextRuns` in
// src/schedules/cron.ts, in the time zone the file names) and the update check (`isNewer`), with Bun's answer in
// `expect` (JSON text). This test checks Bun still gives exactly those answers; `cargo test -p ckanban-board` checks
// Rust gives them too (rust/board/tests/gate.rs). After a deliberate change to that Bun code, run
// `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-gate-fixtures.test.ts` to rewrite `expect`, then make
// `cargo test` pass again.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isAllowedSocket, requestRefusal } from "../src/api/context";
import { cronError, describeCron } from "../src/schedules/cron";
import { isNewer } from "../src/core/update";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "gate.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const doc = JSON.parse(readFileSync(FILE, "utf8"));
const before = JSON.stringify(doc);
const j = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));

/** A request as the gate sees it: the URL's host is the internal port's (behind the front), never the board's. */
function request(c: any): Request {
  const h = new Headers();
  if (c.host !== null) h.set("host", c.host);
  if (c.origin !== null) h.set("origin", c.origin);
  if (c.login !== null) h.set("tailscale-user-login", c.login);
  const r = new Request("http://127.0.0.1:1/api/x", { method: c.method });
  // Request() drops a Host header; the gate reads it through headers.get, so give it these headers.
  return { method: c.method, url: r.url, headers: h } as unknown as Request;
}

const fill: Record<string, (c: any) => unknown> = {
  refusal: (c) => requestRefusal(request(c), doc.port, c.remote, c.via),
  socket: (c) => isAllowedSocket(request(c), doc.port, c.remote, c.via),
  cronError: (c) => cronError(c.expr),
  describeCron: (c) => describeCron(c.expr),
  isNewer: (c) => isNewer(c.latest, c.current),
};

describe("Rust board gate fixtures: Bun gives the answers they record", () => {
  for (const [group, cases] of Object.entries(doc.groups as Record<string, any[]>)) {
    if (group === "nextRuns") continue;
    test(group, () => {
      const f = fill[group];
      expect(f).toBeDefined();
      for (const c of cases) c.expect = j(f(c));
    });
  }
  test("nextRuns (in the file's time zone)", () => {
    const cases = doc.groups.nextRuns.map(({ expr, after, n }: any) => ({ expr, after, n }));
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "support", "cron-fixture-child.ts")], {
      stdin: Buffer.from(JSON.stringify(cases)), env: { ...process.env, TZ: doc.tz },
    });
    expect(p.exitCode).toBe(0);
    const out: string[][] = JSON.parse(p.stdout.toString());
    doc.groups.nextRuns.forEach((c: any, i: number) => (c.expect = j(out[i])));
  });
  test("the file is up to date", () => {
    expect([...Object.keys(fill), "nextRuns"].sort()).toEqual(Object.keys(doc.groups).sort());
    if (UPDATE) {
      // One case per line: the file stays readable in a diff.
      const groups = Object.entries(doc.groups as Record<string, any[]>)
        .map(([g, cases]) => `  ${JSON.stringify(g)}: [\n${cases.map((c) => `   ${JSON.stringify(c)}`).join(",\n")}\n  ]`).join(",\n");
      const head = Object.entries(doc).filter(([k]) => k !== "groups").map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n");
      writeFileSync(FILE, `{\n${head},\n "groups": {\n${groups}\n }\n}\n`);
      return;
    }
    expect(JSON.parse(JSON.stringify(doc))).toEqual(JSON.parse(before));
  });
});
