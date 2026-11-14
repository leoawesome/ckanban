/**
 * Speed check: `bun run speedcheck`. On demand only (never part of `bun run test`, CI or a release): run it when the
 * board feels slow, to find why, and again to check a fix.
 *
 * 1. Copies this checkout (uncommitted changes included) into /tmp, installs its dependencies and builds its UI.
 * 2. Fills a temp data folder with a big board (gen-board.ts) and starts a daemon from the copy on free ports, with a
 *    fake `claude` (no real Claude runs) and no login (no Anthropic calls), so the real board, its data folder and
 *    its ticket copies are never touched.
 * 3. Drives headless Chrome through the same steps as the 10,000-ticket test, at 1280x800 and at 390x844 (phone).
 * 4. Prints each step's time against its limit, the daemon's `[lag]` lines (freezes of 200 ms or more) and any page
 *    crash.
 * 5. Stops Chrome and the daemon and deletes the temp folder, also on Ctrl-C or a failure.
 *
 *   bun run speedcheck                     10,000 tickets, desktop and phone
 *   bun run speedcheck --tickets 3000      a smaller board (500 at least)
 *   bun run speedcheck --only desktop      or --only phone
 *   bun run speedcheck --keep              keep the temp folder (data, daemon.log, screenshots) to look at; delete it by hand
 *   bun run speedcheck --shots             a screenshot after every step (kept with the temp folder, path printed)
 *   CHROME_PATH=/path/to/chrome bun run speedcheck
 *
 * Exits 1 when a step is slow, fails or crashes, or the daemon logged a freeze of 1 s or more.
 */
import { chmodSync, cpSync, existsSync, openSync, readdirSync, statSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { findChrome, launchChrome, Page, type Chrome } from "./cdp";
import { DESKTOP, PHONE, runSteps, type Ctx, type Result } from "./steps";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^\/\*\*\n?/, "").replace(/^ \* ?/gm, ""));
  process.exit(0);
}
const tickets = Math.max(500, Number(arg("--tickets")) || 10_000);
const keep = args.includes("--keep");
const shots = args.includes("--shots");
const only = arg("--only");
const SRC = resolve(import.meta.dir, "..", "..");
const BUN = process.execPath;
const SLUG = "big";
const started = performance.now();
const say = (s: string) => console.log(`${((performance.now() - started) / 1000).toFixed(0).padStart(4)}s  ${s}`);

const chromeBin = findChrome();
if (!chromeBin) {
  console.error("Google Chrome (or Chromium) not found. Install it, or set CHROME_PATH to its binary.");
  process.exit(2);
}

const base = existsSync("/tmp") ? "/tmp" : tmpdir();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A run killed hard (kill -9, a closed terminal) can't clean up after itself: its pids.json names its runner, daemon
// and Chrome. Stop what is left of runs whose runner is gone and delete their folders. A run still going is left alone.
for (const name of readdirSync(base)) {
  if (!name.startsWith("ckanban-speedcheck-")) continue;
  const dir = join(base, name);
  let pids: { runner?: number; daemon?: number; chrome?: number; kept?: boolean } = {};
  try {
    pids = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8"));
  } catch {}
  if (pids.kept || (pids.runner && alive(pids.runner))) continue;
  if (!pids.runner && Date.now() - statSync(dir).mtimeMs < 600_000) continue; // being made by a run just starting
  for (const pid of [pids.daemon, pids.chrome]) if (pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {}
  rmSync(dir, { recursive: true, force: true });
  console.log(`Removed what a stopped earlier speed check left: ${dir}`);
}
const ROOT = mkdtempSync(join(base, "ckanban-speedcheck-"));
const PIDS = join(ROOT, "pids.json");
const savePids = () => writeFileSync(PIDS, JSON.stringify({ runner: process.pid, daemon: daemon?.pid, chrome: chrome?.proc.pid }));
const CODE = join(ROOT, "code");
const HOME = join(ROOT, "data");
const CLAUDE = join(ROOT, "claude");
const FOLDER = join(ROOT, "project");
const BIN = join(ROOT, "bin");
const SHOTS = join(ROOT, "shots");
const LOG = join(HOME, "daemon.log");
// Never the real data folder or this checkout: every path the daemon gets is inside ROOT.
const real = join(homedir(), ".claude-kanban");
for (const p of [CODE, HOME, CLAUDE, FOLDER]) {
  if (!p.startsWith(ROOT + "/") || p.startsWith(real) || p.startsWith(SRC + "/")) throw new Error(`refusing to use ${p}`);
}

let daemon: Subprocess | null = null;
let chrome: Chrome | null = null;
let cleaned = false;
savePids();
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  try {
    chrome?.proc.kill();
  } catch {}
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGTERM");
    const done = await Promise.race([daemon.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    if (!done) daemon.kill("SIGKILL");
  }
  if (keep || shots) writeFileSync(PIDS, JSON.stringify({ kept: true }));
  if (keep || shots) console.log(`\nKept: ${ROOT}${shots ? `\nScreenshots: ${SHOTS}` : ""}\nDaemon log: ${LOG}`);
  else rmSync(ROOT, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    console.log(`\nStopped (${sig}); cleaning up.`);
    void cleanup().finally(() => process.exit(130));
  });
}

async function sh(cmd: string[], cwd: string, what: string, env?: Record<string, string | undefined>): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env ?? process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${what} failed (exit ${code}):\n${(err || out).trim().split("\n").slice(-15).join("\n")}`);
  return out;
}

/** This checkout's files as they are now (uncommitted edits too), without node_modules, builds or version history. */
async function copyCode(): Promise<void> {
  mkdirSync(CODE, { recursive: true });
  let files: string[] | null = null;
  try {
    const out = await sh(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], SRC, "git ls-files");
    files = out.split("\0").filter(Boolean);
  } catch {}
  if (files) {
    for (const f of files) {
      const from = join(SRC, f);
      if (!existsSync(from)) continue; // deleted, not yet committed
      mkdirSync(dirname(join(CODE, f)), { recursive: true });
      cpSync(from, join(CODE, f));
    }
  } else {
    const skip = new Set(["node_modules", ".git", "dist"]);
    cpSync(SRC, CODE, { recursive: true, filter: (p) => !p.slice(SRC.length).split("/").some((x) => skip.has(x)) });
  }
}

/** Stand-ins on PATH: a fake claude, and no-ops for the login lookup (security), banners, tmux, gh and open. */
function fakeBins(): Record<string, string> {
  mkdirSync(BIN, { recursive: true });
  const claude = join(BIN, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${BUN}" "${join(CODE, "scripts/speedcheck/fake-claude.ts")}" "$@"\n`);
  for (const [name, code] of [["security", 44], ["osascript", 0], ["tmux", 1], ["gh", 1], ["open", 0], ["terminal-notifier", 0]] as const) {
    writeFileSync(join(BIN, name), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(BIN, name), 0o755);
  }
  chmodSync(claude, 0o755);
  return {
    PATH: `${BIN}:${dirname(BUN)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    CKANBAN_HOME: HOME,
    CLAUDE_CONFIG_DIR: CLAUDE,
    CKANBAN_CLAUDE_BIN: claude,
    CKANBAN_OSASCRIPT_BIN: join(BIN, "osascript"),
    CKANBAN_OPEN_BIN: join(BIN, "open"),
  };
}

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port;
  s.stop(true);
  return port as number;
}

function table(rows: Result[]): string {
  const fmt = (ms: number | null) => (ms === null ? "-" : ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
  const head = ["View", "Step", "Time", "Limit", "Result", "Note"];
  const body = rows.map((r) => [r.view, r.step, fmt(r.ms), r.limitMs === null ? "-" : fmt(r.limitMs), r.status.toUpperCase(), r.note ?? ""]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => (i === 5 ? 0 : b[i].length))));
  const line = (c: string[]) => c.map((x, i) => (i === 5 ? x : x.padEnd(w[i]))).join("  ").trimEnd();
  return [line(head), line(w.map((n, i) => "-".repeat(i === 5 ? 4 : n))), ...body.map(line)].join("\n");
}

const results: Result[] = [];
const lagLines = () => (existsSync(LOG) ? readFileSync(LOG, "utf8") : "").split("\n").filter((l) => l.includes("[lag]"));
/** How many [lag] lines the daemon's start-up logged, before the browser steps. */
let startLagLines = 0;
let exitCode = 0;
try {
  say(`Temp folder ${ROOT}`);
  const [l1] = loadavg();
  say(`Mac load ${l1.toFixed(1)} on ${availableParallelism()} cores${l1 > availableParallelism() ? " (busy: times will be slower than usual)" : ""}`);
  say("Copying the code...");
  await copyCode();
  say("Installing dependencies and building the UI in the copy...");
  await sh([BUN, "install"], CODE, "bun install");
  await sh([BUN, "run", "build:web"], CODE, "UI build");
  say(`Generating a ${tickets.toLocaleString("en-US")}-ticket board...`);
  const gen = JSON.parse((await sh([BUN, "scripts/speedcheck/gen-board.ts", "--home", HOME, "--claude", CLAUDE, "--folder", FOLDER, "--tickets", String(tickets)], CODE, "board generator")).trim().split("\n").at(-1)!);
  say(`Board: ${gen.tickets} tickets (${gen.done} Done, ${gen.backlog} Backlog, ${gen.review} Review), 2 chats of 6,250 entries, huddles, jobs, quick chats`);
  const env = fakeBins();
  const port = freePort();
  const remotePort = freePort();
  say(`Starting the daemon on port ${port} (fake Claude)...`);
  // One file handle for both streams, so log lines don't overwrite each other.
  const logFd = openSync(LOG, "a");
  daemon = Bun.spawn([BUN, "src/cli.ts", "dev"], {
    cwd: CODE,
    env: { ...process.env, ...env, CKANBAN_PORT: String(port), CKANBAN_REMOTE_PORT: String(remotePort) },
    stdout: logFd,
    stderr: logFd,
    stdin: "ignore",
  });
  savePids();
  const t0 = performance.now();
  let up = false;
  while (performance.now() - t0 < 180_000 && daemon.exitCode === null) {
    try {
      if ((await fetch(`http://localhost:${port}/api/profiles`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await Bun.sleep(250);
  }
  if (!up) throw new Error(`the daemon did not start (see ${LOG}):\n${existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").slice(-15).join("\n") : ""}`);
  // Start-up reads every ticket in slices; time it until the board's first page answers, then let it settle so the
  // browser steps measure a running daemon, not its start.
  const boardUrl = `http://localhost:${port}/api/profiles/${SLUG}/tickets?scope=board`;
  while (performance.now() - t0 < 180_000) {
    try {
      if ((await fetch(boardUrl)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  const startMs = performance.now() - t0;
  results.push({ view: "Daemon", step: "Start until the board answers", ms: startMs, limitMs: 15_000, status: startMs > 15_000 ? "slow" : "pass" });
  say(`Daemon answers the board after ${(startMs / 1000).toFixed(1)} s; waiting for it to settle...`);
  // Settled: the ticket list, huddles and jobs (read at start-up after the tickets) all answer fast 3 times in a row.
  const settleUrls = [boardUrl, `http://localhost:${port}/api/profiles/${SLUG}/huddles`, `http://localhost:${port}/api/profiles/${SLUG}/jobs`];
  for (let quiet = 0, i = 0; quiet < 3 && i < 240; i++) {
    const t = performance.now();
    await Promise.all(settleUrls.map((u) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null)));
    quiet = performance.now() - t < 300 ? quiet + 1 : 0;
    await Bun.sleep(500);
  }
  startLagLines = lagLines().length;
  say("Starting headless Chrome...");
  chrome = await launchChrome(chromeBin, join(ROOT, "chrome"));
  savePids();
  const baseUrl = `http://localhost:${port}`;
  const api = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${baseUrl}${path}`, init && { ...init, headers: { "content-type": "application/json", origin: baseUrl } });
    return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
  };
  // Far down Done: about 95% of the way (Done 0 is the newest).
  const farDone = Math.floor((gen.done - 280) * 0.95);
  for (const [view, steps, w, h, phone] of [["Desktop", DESKTOP, 1280, 800, false], ["Phone", PHONE, 390, 844, true]] as const) {
    if (only && only.toLowerCase() !== view.toLowerCase()) continue;
    say(`${view} ${w}x${h}...`);
    const page = await Page.open(chrome);
    await page.size(w, h, phone);
    const ctx: Ctx = {
      page, base: baseUrl, slug: SLUG, farDone, api,
      shot: async (name) => {
        if (!shots) return;
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot(join(SHOTS, `${view.toLowerCase()}-${String(results.length).padStart(2, "0")}-${name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`));
      },
    };
    await runSteps(view, steps as any, ctx, (r) => {
      results.push(r);
      say(`  ${r.step}: ${r.ms === null ? "-" : Math.round(r.ms) + " ms"} ${r.status.toUpperCase()}`);
    });
    page.close();
  }
  await Bun.sleep(1500);
} catch (e) {
  console.error(`\nSpeed check stopped: ${(e as Error).message ?? e}`);
  exitCode = 2;
}

const lag = lagLines();
const longest = Math.max(0, ...lag.map((l) => Number(/blocked (\d+)ms/.exec(l)?.[1] ?? 0)));
if (results.length) console.log(`\n${table(results)}`);
const show = (title: string, lines: string[]) => {
  console.log(`\n${title}: ${lines.length ? `${lines.length}, longest ${Math.max(...lines.map((l) => Number(/blocked (\d+)ms/.exec(l)?.[1] ?? 0)))} ms` : "none"}`);
  for (const l of lines.slice(0, 20)) console.log(`  ${l.replace(/^.*?\[lag\] event loop /, "").replace(/; rss .*$/, "")}`);
  if (lines.length > 20) console.log(`  ...and ${lines.length - 20} more (--keep keeps the daemon log)`);
};
show("Daemon freezes of 200 ms or more during start-up", lag.slice(0, startLagLines));
show("Daemon freezes of 200 ms or more during the steps", lag.slice(startLagLines));
const bad = results.filter((r) => r.status !== "pass");
const total = ((performance.now() - started) / 1000).toFixed(0);
if (results.length) console.log(`\n${bad.length ? `${bad.length} of ${results.length} steps need a look` : `All ${results.length} steps passed`}; took ${total} s.`);
if (bad.length || longest >= 1000) exitCode ||= 1;
await cleanup();
process.exit(exitCode);
