/**
 * Rust trial bench: measures one server (the Bun daemon by default, `ckanban-rs` in step 4b) on an empty board and on a
 * 10,000-ticket board, the same way each time, so the two can be compared.
 *
 *   bun scripts/rust-trial-bench.ts                                    the Bun daemon (from a copy of this checkout in /tmp)
 *   bun scripts/rust-trial-bench.ts --server '["/path/ckanban-rs","dev"]' --name rust
 *   bun scripts/rust-trial-bench.ts --out docs/rust-trial-baseline.json  also write the JSON there (always printed as a table)
 *   bun scripts/rust-trial-bench.ts --runs 5 --tickets 10000 --fresh-board
 *   CKANBAN_RUST_BOARD=1 bun scripts/rust-trial-bench.ts --server '["/path/ckanban-rs","dev"]' --name rust-board
 *                                                                      the Rust board (board mode, F1), Bun as its satellite
 *
 * `--server` is a JSON array; `{code}` in it is replaced by the /tmp copy of this checkout (with its dependencies
 * installed), e.g. '["/path/ckanban-rs","dev"]' or '["bun","{code}/src/cli.ts","dev"]' (the default).
 *
 * Everything runs in /tmp/ckanban-rust-trial: a copy of the code (the daemon never runs from the real checkout, whose
 * ticket copies a temp daemon would sweep), the generated board (built once by scripts/speedcheck/gen-board.ts and
 * reused; --fresh-board rebuilds it), and a run folder copied fresh from it before every server start. Each server gets
 * a temp CKANBAN_HOME, HOME and CLAUDE_CONFIG_DIR inside that folder, free ports, a fake `claude`, do-nothing Mac
 * commands, and a local fake of Anthropic's usage endpoint: nothing reaches the real board, its data or Anthropic.
 *
 * What is measured, each over `--runs` fresh server starts (median of the runs):
 * - Memory (RSS, server process and all its children): idle on an empty board, and on the big board once it settled
 *   and again after the route calls below.
 * - Response time of /api/usage, /api/spend and the three biggest board routes (the board page's tickets, the light
 *   list of every ticket, the inbox): the first call after the board settled, and the median of 5 repeat calls.
 * - The longest stall while the big board loads: from the server's first answer until it settled, a cheap route
 *   (/api/awake) is called every 10 ms from outside; its slowest answer is how long the server could not answer anyone.
 *   Measured from outside so any server can be compared (the Bun daemon's own [lag] lines are reported too).
 */
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
  process.exit(0);
}

const SRC = resolve(import.meta.dir, "..");
const BUN = process.execPath;
const ROOT = "/tmp/ckanban-rust-trial";
const CODE = join(ROOT, "code");
const TEMPLATE = join(ROOT, "board-template");
const RUN = join(ROOT, "run");
const SLUG = "big";
const RUNS = Math.max(1, Number(arg("--runs")) || 5);
const TICKETS = Math.max(500, Number(arg("--tickets")) || 10_000);
const NAME = arg("--name") ?? (arg("--server") ? "server" : "bun");
const OUT = arg("--out");
const REPEATS = 5;

let serverCmd: string[] = [BUN, "{code}/src/cli.ts", "dev"];
if (arg("--server")) {
  const v = JSON.parse(arg("--server")!);
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x)) throw new Error("--server must be a JSON array of strings");
  serverCmd = v;
}
const usesCode = serverCmd.some((x) => x.includes("{code}"));
const cmdFor = () => serverCmd.map((x) => x.replaceAll("{code}", CODE));

/** The routes timed on the big board. The three board routes are the heaviest a page load hits (see scripts/bench.ts budgets). */
export const ROUTES: { name: string; path: string }[] = [
  { name: "GET /api/usage", path: "/api/usage" },
  { name: "GET /api/spend", path: "/api/spend" },
  { name: "GET /api/profiles/:slug/tickets?scope=board", path: `/api/profiles/${SLUG}/tickets?scope=board` },
  { name: "GET /api/tickets (every ticket, light rows)", path: "/api/tickets" },
  { name: "GET /api/inbox", path: "/api/inbox" },
];

const started = performance.now();
const say = (s: string) => console.log(`${((performance.now() - started) / 1000).toFixed(0).padStart(4)}s  ${s}`);
export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function sh(cmd: string[], cwd: string, what: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${what} failed (exit ${code}):\n${(err || out).trim().split("\n").slice(-15).join("\n")}`);
  return out;
}

/** This checkout's files as they are now (uncommitted edits too) into CODE; node_modules there is kept between benches. */
async function copyCode(): Promise<void> {
  mkdirSync(CODE, { recursive: true });
  const out = await sh(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], SRC, "git ls-files");
  for (const f of out.split("\0").filter(Boolean)) {
    const from = join(SRC, f);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(CODE, f)), { recursive: true });
    cpSync(from, join(CODE, f));
  }
  await sh([BUN, "install"], CODE, "bun install");
}

/** The paths every server start uses; the big board's data files name these exact paths, so they never move. */
const dirs = (root: string) => ({ home: join(root, "data"), claude: join(root, "claude"), project: join(root, "project"), userHome: join(root, "home") });

async function ensureBoard(): Promise<{ tickets: number }> {
  const meta = join(TEMPLATE, "board.json");
  if (!args.includes("--fresh-board") && existsSync(meta)) {
    const m = JSON.parse(readFileSync(meta, "utf8"));
    if (m.requested === TICKETS) {
      say(`Reusing the ${m.tickets.toLocaleString("en-US")}-ticket board in ${TEMPLATE}`);
      return m;
    }
  }
  say(`Generating a ${TICKETS.toLocaleString("en-US")}-ticket board (once; later benches reuse it)...`);
  rmSync(TEMPLATE, { recursive: true, force: true });
  rmSync(RUN, { recursive: true, force: true });
  const d = dirs(RUN);
  // gen-board.ts imports from src/: run it from the copy, so it matches the code being measured.
  const out = await sh([BUN, join(CODE, "scripts/speedcheck/gen-board.ts"), "--home", d.home, "--claude", d.claude, "--folder", d.project, "--tickets", String(TICKETS)], CODE, "board generator");
  const gen = { ...JSON.parse(out.trim().split("\n").at(-1)!), requested: TICKETS };
  cpSync(RUN, TEMPLATE, { recursive: true, preserveTimestamps: true });
  writeFileSync(meta, JSON.stringify(gen));
  return gen;
}

/** A fresh run folder: the big board copied from the template, or an empty board for the idle measure. */
function freshRun(big: boolean): ReturnType<typeof dirs> {
  rmSync(RUN, { recursive: true, force: true });
  if (big) cpSync(TEMPLATE, RUN, { recursive: true, preserveTimestamps: true });
  rmSync(join(RUN, "board.json"), { force: true });
  const d = dirs(RUN);
  for (const p of Object.values(d)) mkdirSync(p, { recursive: true });
  mkdirSync(join(d.claude, "projects"), { recursive: true });
  // A logged-in Claude for the usage route; the token only ever goes to the local fake below.
  writeFileSync(join(d.claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "bench-token", expiresAt: Date.now() + 3600_000 } }));
  if (!big) writeFileSync(join(d.project, "README.md"), "Bench project folder.\n");
  return d;
}

/** Stand-ins first on PATH: a fake claude (no real runs) and no-ops for banners, keep-awake, browser, keychain, gh. */
function fakeBins(): string {
  const bin = join(ROOT, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, code] of [["security", 44], ["osascript", 0], ["caffeinate", 0], ["tmux", 1], ["gh", 1], ["open", 0], ["tailscale", 0], ["terminal-notifier", 0]] as const) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${BUN}" "${join(CODE, "scripts/speedcheck/fake-claude.ts")}" "$@"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  return bin;
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
}

/** RSS in KB of `pid` and every process under it. */
export function treeRssKb(psOut: string, pid: number): number {
  const kids = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of psOut.split("\n")) {
    const [p, pp, r] = line.trim().split(/\s+/).map(Number);
    if (!p) continue;
    rss.set(p, r);
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  let total = 0;
  const todo = [pid];
  const seen = new Set<number>();
  while (todo.length) {
    const p = todo.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    total += rss.get(p) ?? 0;
    todo.push(...(kids.get(p) ?? []));
  }
  return total;
}
async function memMb(pid: number): Promise<number> {
  return treeRssKb(await sh(["ps", "-A", "-o", "pid=,ppid=,rss="], "/", "ps"), pid) / 1024;
}

const usageFake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: () => Response.json({ five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: { utilization: 17.5, resets_at: null } }),
});

interface Server { proc: Subprocess; url: string; log: string; stop(): Promise<void> }
/** The server running now, stopped on Ctrl-C so none is left behind. */
let current: Server | null = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    console.log(`\nStopped (${sig}); stopping the server.`);
    void (current?.stop() ?? Promise.resolve()).finally(() => process.exit(130));
  });
}

async function startServer(d: ReturnType<typeof dirs>, bin: string): Promise<Server> {
  const port = freePort();
  let remotePort = freePort();
  while (remotePort === port) remotePort = freePort();
  const log = join(RUN, "server.log");
  const fd = openSync(log, "a");
  const env: Record<string, string> = {
    PATH: `${bin}:${dirname(BUN)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: d.userHome,
    CKANBAN_HOME: d.home,
    CLAUDE_CONFIG_DIR: d.claude,
    CKANBAN_CLAUDE_BIN: join(bin, "claude"),
    CKANBAN_OSASCRIPT_BIN: join(bin, "osascript"),
    CKANBAN_TAILSCALE: "/usr/bin/false",
    CKANBAN_OPEN_BIN: join(bin, "open"),
    CKANBAN_PORT: String(port),
    CKANBAN_REMOTE_PORT: String(remotePort),
    CKANBAN_USAGE_URL: `http://127.0.0.1:${usageFake.port}/api/oauth/usage`,
    CKANBAN_NO_KEYCHAIN: "1",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Board mode (`CKANBAN_RUST_BOARD=1 bun scripts/rust-trial-bench.ts --server ...`): passed on, and the Bun satellite
    // runs from the /tmp copy of the code, never from this checkout.
    ...(process.env.CKANBAN_RUST_BOARD ? { CKANBAN_RUST_BOARD: process.env.CKANBAN_RUST_BOARD, CKANBAN_REPO: CODE, CKANBAN_BUN: BUN } : {}),
  };
  const proc = Bun.spawn(cmdFor(), { cwd: d.project, env, stdout: fd, stderr: fd, stdin: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    if (!(await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]))) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  };
  current = { proc, url, log, stop };
  return current;
}

/** Waits for the first answer; returns ms since the start. */
async function firstAnswer(s: Server, t0: number): Promise<number> {
  while (performance.now() - t0 < 180_000) {
    if (s.proc.exitCode !== null) throw new Error(`the server exited with ${s.proc.exitCode}:\n${tail(s.log)}`);
    try {
      if ((await fetch(`${s.url}/api/awake`)).ok) return performance.now() - t0;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error(`the server did not answer within 180 s:\n${tail(s.log)}`);
}
const tail = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").slice(-15).join("\n") : "");

/** Settled: the board, huddles and jobs (read at start-up after the tickets) all answer fast 3 times in a row. Returns ms when the board first answered. */
async function settle(s: Server, t0: number): Promise<number> {
  const board = `${s.url}/api/profiles/${SLUG}/tickets?scope=board`;
  let boardAt = NaN;
  while (performance.now() - t0 < 180_000) {
    try {
      if ((await fetch(board)).ok) {
        boardAt = performance.now() - t0;
        break;
      }
    } catch {}
    await Bun.sleep(50);
  }
  const urls = [board, `${s.url}/api/profiles/${SLUG}/huddles`, `${s.url}/api/profiles/${SLUG}/jobs`];
  for (let quiet = 0, i = 0; quiet < 3 && i < 240; i++) {
    const t = performance.now();
    await Promise.all(urls.map((u) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null)));
    quiet = performance.now() - t < 300 ? quiet + 1 : 0;
    await Bun.sleep(500);
  }
  return boardAt;
}

async function timed(url: string): Promise<number> {
  const t = performance.now();
  const r = await fetch(url);
  await r.arrayBuffer();
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return performance.now() - t;
}

interface RunResult {
  idleMb: number;
  bigSettledMb: number;
  bigAfterRoutesMb: number;
  firstAnswerMs: number;
  boardAnswersMs: number;
  longestStallMs: number;
  lagLines: number;
  longestLagMs: number;
  routes: Record<string, { firstMs: number; repeatMs: number }>;
}

async function idleRun(bin: string): Promise<number> {
  const s = await startServer(freshRun(false), bin);
  try {
    const t0 = performance.now();
    await firstAnswer(s, t0);
    await Bun.sleep(5000); // start-up jobs finish; then the server is idle
    return await memMb(s.proc.pid);
  } finally {
    await s.stop();
  }
}

async function bigRun(bin: string): Promise<Omit<RunResult, "idleMb">> {
  const d = freshRun(true);
  const s = await startServer(d, bin);
  try {
    const t0 = performance.now();
    const firstAnswerMs = await firstAnswer(s, t0);
    let probing = true;
    let longestStallMs = 0;
    const probe = (async () => {
      while (probing) {
        const t = performance.now();
        try {
          await (await fetch(`${s.url}/api/awake`)).arrayBuffer();
        } catch {}
        longestStallMs = Math.max(longestStallMs, performance.now() - t);
        await Bun.sleep(10);
      }
    })();
    const boardAnswersMs = await settle(s, t0);
    probing = false;
    await probe;
    const bigSettledMb = await memMb(s.proc.pid);
    const routes: RunResult["routes"] = {};
    for (const r of ROUTES) {
      const firstMs = await timed(s.url + r.path);
      const reps: number[] = [];
      for (let i = 0; i < REPEATS; i++) reps.push(await timed(s.url + r.path));
      routes[r.name] = { firstMs, repeatMs: median(reps) };
    }
    const bigAfterRoutesMb = await memMb(s.proc.pid);
    // The usage route must have reached the local fake (numbers, not an error), or its time measures nothing.
    const usage = (await (await fetch(`${s.url}/api/usage`)).json()) as { windows?: unknown };
    if (!Array.isArray(usage?.windows)) throw new Error(`/api/usage did not get plan numbers from the local fake: ${JSON.stringify(usage)}`);
    const lag = readFileSync(s.log, "utf8").split("\n").filter((l) => l.includes("[lag]"));
    const longestLagMs = Math.max(0, ...lag.map((l) => Number(/blocked (\d+)ms/.exec(l)?.[1] ?? 0)));
    return { bigSettledMb, bigAfterRoutesMb, firstAnswerMs, boardAnswersMs, longestStallMs, lagLines: lag.length, longestLagMs, routes };
  } finally {
    await s.stop();
  }
}

/** Medians of every number over the runs, same shape as one run. */
export function summarize(runs: RunResult[]): RunResult {
  const m = (f: (r: RunResult) => number) => median(runs.map(f));
  const routes: RunResult["routes"] = {};
  for (const name of Object.keys(runs[0].routes)) routes[name] = { firstMs: m((r) => r.routes[name].firstMs), repeatMs: m((r) => r.routes[name].repeatMs) };
  return {
    idleMb: m((r) => r.idleMb), bigSettledMb: m((r) => r.bigSettledMb), bigAfterRoutesMb: m((r) => r.bigAfterRoutesMb),
    firstAnswerMs: m((r) => r.firstAnswerMs), boardAnswersMs: m((r) => r.boardAnswersMs), longestStallMs: m((r) => r.longestStallMs),
    lagLines: m((r) => r.lagLines), longestLagMs: m((r) => r.longestLagMs), routes,
  };
}

export function table(s: RunResult, runs: number): string {
  const ms = (x: number) => (x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : x >= 100 ? `${Math.round(x)} ms` : `${x.toFixed(1)} ms`);
  const mb = (x: number) => `${Math.round(x)} MB`;
  const rows: [string, string][] = [
    ["Memory, idle (empty board)", mb(s.idleMb)],
    ["Memory, big board settled", mb(s.bigSettledMb)],
    ["Memory, big board after the route calls", mb(s.bigAfterRoutesMb)],
    ["Start until the first answer (big board)", ms(s.firstAnswerMs)],
    ["Start until the board's tickets answer", ms(s.boardAnswersMs)],
    ["Longest stall while the big board loads (outside probe)", ms(s.longestStallMs)],
    ["Longest stall in the server's own [lag] lines (Bun only)", s.lagLines ? ms(s.longestLagMs) : "none"],
  ];
  for (const [name, r] of Object.entries(s.routes)) {
    rows.push([`${name}, first call`, ms(r.firstMs)]);
    rows.push([`${name}, repeat call (median of ${REPEATS})`, ms(r.repeatMs)]);
  }
  return [`| Measure (median of ${runs} runs) | Value |`, "|---|---|", ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join("\n");
}

if (import.meta.main) {
  let exit = 0;
  try {
    mkdirSync(ROOT, { recursive: true });
    const [l1] = loadavg();
    say(`Server: ${JSON.stringify(serverCmd)}; ${RUNS} runs; Mac load ${l1.toFixed(1)} on ${availableParallelism()} cores`);
    say("Copying the code to /tmp and installing its dependencies...");
    await copyCode();
    const gen = await ensureBoard();
    const bin = fakeBins();
    const runs: RunResult[] = [];
    for (let i = 1; i <= RUNS; i++) {
      say(`Run ${i} of ${RUNS}: empty board...`);
      const idleMb = await idleRun(bin);
      say(`Run ${i} of ${RUNS}: big board...`);
      const big = await bigRun(bin);
      runs.push({ idleMb, ...big });
      say(`  idle ${Math.round(idleMb)} MB, big ${Math.round(big.bigAfterRoutesMb)} MB, board answers after ${Math.round(big.boardAnswersMs)} ms, longest stall ${Math.round(big.longestStallMs)} ms`);
    }
    const summary = summarize(runs);
    const md = table(summary, RUNS);
    console.log(`\n${md}\n`);
    const result = {
      name: NAME, server: serverCmd, usesCode, at: new Date().toISOString(), runs: RUNS, tickets: gen.tickets,
      mac: { loadAvg1: l1, cores: availableParallelism(), bun: Bun.version },
      routes: ROUTES, summary, perRun: runs, table: md,
    };
    const out = OUT ? resolve(OUT) : join(ROOT, `result-${NAME}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
    say(`Wrote ${out}`);
  } catch (e) {
    console.error(`\nBench stopped: ${(e as Error).message ?? e}`);
    exit = 2;
  }
  usageFake.stop(true);
  process.exit(exit);
}
