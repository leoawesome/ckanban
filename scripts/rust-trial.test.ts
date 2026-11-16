// scripts/rust-trial.sh on a temp launchd file with a stand-in launchctl: never the real plist, label or launchd.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plistXml } from "../src/cli/launchd";

const SCRIPT = join(import.meta.dir, "rust-trial.sh");
const root = mkdtempSync(join(tmpdir(), "ck-rust-trial-"));
const LABEL = "io.ckanban.trialtest";
let waiting = 0;
/** POST /api/restart calls the stand-in board got (the `board` action's graceful restart). */
let restarts = 0;
const board = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch: (req) => {
    if (req.method === "POST") restarts++;
    return Response.json({ pending: req.method === "POST", waiting, running: waiting });
  },
});
afterAll(() => {
  board.stop(true);
  rmSync(root, { recursive: true, force: true });
});

let dir = "";
const paths = () => ({
  plist: join(dir, "LaunchAgents", `${LABEL}.plist`),
  backup: join(dir, "LaunchAgents", `${LABEL}.plist.before-rust-trial`),
  repo: join(dir, "repo"),
  bin: join(dir, "repo", "rust", "target", "release", "ckanban-rs"),
  calls: join(dir, "launchctl.log"),
});

beforeEach(() => {
  dir = mkdtempSync(join(root, "case-"));
  const p = paths();
  mkdirSync(join(dir, "LaunchAgents"), { recursive: true });
  mkdirSync(join(p.repo, "src"), { recursive: true });
  mkdirSync(join(p.repo, "rust", "target", "release"), { recursive: true });
  writeFileSync(join(p.repo, "src", "cli.ts"), "");
  writeFileSync(p.bin, "#!/bin/sh\nexit 0\n");
  chmodSync(p.bin, 0o755);
  // A launchctl that logs its calls; `print` says the job isn't loaded; bootstrap fails when FAIL_BOOTSTRAP is set.
  writeFileSync(join(dir, "launchctl"), `#!/bin/sh\necho "$@" >> "${p.calls}"\n[ "$1" = print ] && exit 113\n[ "$1" = bootstrap ] && [ -n "$FAIL_BOOTSTRAP" ] && exit 5\nexit 0\n`);
  chmodSync(join(dir, "launchctl"), 0o755);
  const xml = plistXml({ programArgs: ["/opt/bun", join(p.repo, "src", "cli.ts")], path: "/usr/bin:/a&b", logFile: "/h/daemon.log", home: "/h" });
  writeFileSync(p.plist, xml.replace("<string>io.ckanban.daemon</string>", `<string>${LABEL}</string>`));
  waiting = 0;
  restarts = 0;
});

async function run(action: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["/bin/bash", SCRIPT, action], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir,
      CKANBAN_TRIAL_PLIST: paths().plist, CKANBAN_TRIAL_LABEL: LABEL, CKANBAN_TRIAL_LAUNCHCTL: join(dir, "launchctl"),
      CKANBAN_TRIAL_URL: `http://127.0.0.1:${board.port}`, CKANBAN_TRIAL_WAIT: "0", ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
}

async function plistJson(file: string): Promise<any> {
  return JSON.parse(await new Response(Bun.spawn(["/usr/bin/plutil", "-convert", "json", "-o", "-", file]).stdout).text());
}

test("on points launchd at `ckanban-rs dev` with the same env, keeps a backup, and reloads the temp label; off puts it back exactly", async () => {
  const p = paths();
  const original = readFileSync(p.plist, "utf8");
  const on = await run("on");
  expect(on.out).toContain("now runs on the Rust server");
  expect(on.code).toBe(0);
  expect(readFileSync(p.backup, "utf8")).toBe(original);
  const now = await plistJson(p.plist);
  const before = await plistJson(p.backup);
  expect(now.ProgramArguments).toEqual([p.bin, "dev"]);
  expect(now.EnvironmentVariables).toEqual({ ...before.EnvironmentVariables, CKANBAN_BUN: "/opt/bun", CKANBAN_REPO: p.repo });
  expect({ ...now, ProgramArguments: null, EnvironmentVariables: null }).toEqual({ ...before, ProgramArguments: null, EnvironmentVariables: null });
  const uid = process.getuid!();
  expect(readFileSync(p.calls, "utf8")).toContain(`bootout gui/${uid}/${LABEL}\nprint gui/${uid}/${LABEL}\nbootstrap gui/${uid} ${p.plist}\n`);

  // A second `on` starts again from the backup (the Bun version), never backs up the Rust version.
  expect((await run("on")).code).toBe(0);
  expect(readFileSync(p.backup, "utf8")).toBe(original);

  const off = await run("off");
  expect(off.out).toContain("runs on Bun again");
  expect(off.code).toBe(0);
  expect(readFileSync(p.plist, "utf8")).toBe(original);
  expect(existsSync(p.backup)).toBe(false);
  expect((await run("off")).out).toContain("already runs on Bun");
});

test("on refuses while board tasks run, and changes nothing", async () => {
  const p = paths();
  const original = readFileSync(p.plist, "utf8");
  waiting = 2;
  const r = await run("on");
  expect(r.code).toBe(1);
  expect(r.out).toContain("2 board task(s) are running");
  expect(readFileSync(p.plist, "utf8")).toBe(original);
  expect(existsSync(p.backup)).toBe(false);
  expect(existsSync(p.calls)).toBe(false);
});

test("on refuses when the Rust server isn't there and there is nothing to build", async () => {
  const p = paths();
  rmSync(join(p.repo, "rust"), { recursive: true });
  const r = await run("on");
  expect(r.code).toBe(1);
  expect(r.out).toContain("isn't in");
  expect(existsSync(p.backup)).toBe(false);
});

test("off works after an on that launchd wouldn't load, even with the board not answering", async () => {
  const p = paths();
  const original = readFileSync(p.plist, "utf8");
  const on = await run("on", { FAIL_BOOTSTRAP: "1" });
  expect(on.code).toBe(1);
  expect(on.out).toContain("launchd wouldn't load it");
  const off = await run("off", { CKANBAN_TRIAL_URL: "http://127.0.0.1:9" });
  expect(off.out).toContain("going back to Bun anyway");
  expect(off.code).toBe(0);
  expect(readFileSync(p.plist, "utf8")).toBe(original);
});

test("board with the front installed writes the switch file and asks the board to restart when idle; on and off remove it", async () => {
  const p = paths();
  const sw = join(dir, ".claude-kanban", "rust-board");
  expect((await run("on")).code).toBe(0);
  const calls = readFileSync(p.calls, "utf8");
  waiting = 1;
  const b = await run("board");
  expect(b.code).toBe(0);
  expect(b.out).toContain("Switching to the Rust board at the board's next idle moment");
  expect(readFileSync(sw, "utf8")).toBe("on\n");
  expect(restarts).toBe(1);
  // No launchd reload: the board's own restart waits for the running task.
  expect(readFileSync(p.calls, "utf8")).toBe(calls);
  waiting = 0;
  expect((await run("on")).code).toBe(0);
  expect(existsSync(sw)).toBe(false);
  expect((await run("board")).code).toBe(0);
  expect((await run("off")).code).toBe(0);
  expect(existsSync(sw)).toBe(false);
});

test("board without the front installs it with the switch already on, in one reload", async () => {
  const p = paths();
  const sw = join(dir, "data", "rust-board");
  const b = await run("board", { CKANBAN_HOME: join(dir, "data") });
  expect(b.code).toBe(0);
  expect(b.out).toContain("The Rust board is on");
  expect(readFileSync(sw, "utf8")).toBe("on\n");
  expect((await plistJson(p.plist)).ProgramArguments).toEqual([p.bin, "dev"]);
  expect(readFileSync(p.calls, "utf8").match(/bootstrap/g)).toHaveLength(1);
  expect(restarts).toBe(0);
});

test("board refuses like on while tasks run when the front isn't installed, and leaves no switch file", async () => {
  waiting = 1;
  const r = await run("board");
  expect(r.code).toBe(1);
  expect(r.out).toContain("1 board task(s) are running");
  expect(existsSync(join(dir, ".claude-kanban", "rust-board"))).toBe(false);
});
