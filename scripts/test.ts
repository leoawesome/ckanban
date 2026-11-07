// `bun run test`: runs the test files in parallel, sharing the machine with other suites that run at the same time.
//
// Several board steps often run the whole suite at once on one machine (one per ticket copy). `bun test --parallel`
// starts one worker per core, and each worker spawns fake claudes and git: five suites meant ~50 workers on 10 cores
// (load average near 100), tests took minutes instead of seconds and timed out. Past two suites a busy machine gets no
// more work done, only slower, so at most two suites run at once (CKANBAN_TEST_SLOTS, default 2); a later one waits for
// a free slot and says so. A suite that shares the machine with another uses half the cores. CKANBAN_TEST_WORKERS=<n>
// sets the worker count by hand. Extra arguments go to `bun test`.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const dir = join(tmpdir(), "ckanban-test-slots");
mkdirSync(dir, { recursive: true });
const slots = Math.max(1, Math.floor(Number(process.env.CKANBAN_TEST_SLOTS) || 2));
const cores = availableParallelism();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Who holds slot `i`: a pid, -1 while a suite is taking it, or null when it is free (a dead suite's slot is freed). */
function holder(i: number): number | null {
  const slot = join(dir, `slot-${i}`);
  let since: number;
  try {
    since = statSync(slot).mtimeMs;
  } catch {
    return null;
  }
  let pid = 0;
  try {
    pid = Number(readFileSync(join(slot, "pid"), "utf8"));
  } catch {}
  // No pid yet: another suite is taking it right now, unless it died doing so (an old folder).
  const dead = pid > 0 ? !alive(pid) : Date.now() - since > 10_000;
  if (dead) {
    rmSync(slot, { recursive: true, force: true });
    return null;
  }
  return pid || -1;
}

/** Take a free slot (mkdir is atomic, so two suites never share one); null when all are taken. */
function take(): string | null {
  for (let i = 0; i < slots; i++) {
    if (holder(i) !== null) continue;
    const slot = join(dir, `slot-${i}`);
    try {
      mkdirSync(slot);
    } catch {
      continue;
    }
    writeFileSync(join(slot, "pid"), String(process.pid));
    return slot;
  }
  return null;
}

let mine = take();
if (!mine) {
  console.error(`${slots} other test runs are going on: waiting for one to finish…`);
  const t0 = Date.now();
  while (!(mine = take())) await Bun.sleep(1000);
  console.error(`Waited ${Math.round((Date.now() - t0) / 1000)}s; starting.`);
}
const release = () => rmSync(mine!, { recursive: true, force: true });

let others = 0;
for (let i = 0; i < slots; i++) if (join(dir, `slot-${i}`) !== mine && holder(i) !== null) others++;
const fromEnv = Number(process.env.CKANBAN_TEST_WORKERS);
const workers = fromEnv > 0 ? Math.floor(fromEnv) : Math.max(2, Math.floor(cores / (others + 1)));
if (workers < cores) console.error(`Another test run is going on: using ${workers} of ${cores} cores.`);

const args = ["test", "test", `--parallel=${workers}`, "--timeout=60000", "--timings=test/timings.json", ...process.argv.slice(2)];
const child = Bun.spawn([process.execPath, ...args], { stdio: ["inherit", "inherit", "inherit"] });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
const code = await child.exited;
release();
process.exit(code);
