// Starts a real ckanban daemon as a separate process for the contract tests, and talks to it from the outside only:
// HTTP, the CLI and the data folder's files. Nothing here (or in any test/contract file) imports from src/ or web/,
// so the same tests can check another server (a Rust port): set CKANBAN_CONTRACT_DAEMON / CKANBAN_CONTRACT_CLI (below).
//
// Each daemon gets its own temp data folder (CKANBAN_HOME), temp HOME, temp Claude config folder, a fake `claude`
// (test/fixtures/fake-claude.ts) and stub osascript/caffeinate/open/tailscale on PATH, so it never touches the real
// ~/.claude-kanban, the real repo, or shows Mac banners. The board's project folder is a plain temp folder (no git).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..", "..");

/** A command from an env var holding a JSON array of strings; unset or empty gives `fallback`. Bad JSON stops the run. */
export function commandFromEnv(name: string, fallback: string[], env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name} must be a JSON array of strings, e.g. ["/path/to/server","dev"]; could not parse it: ${(e as Error).message}`);
  }
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== "")) {
    throw new Error(`${name} must be a non-empty JSON array of non-empty strings, e.g. ["/path/to/server","dev"]; got ${raw}`);
  }
  return v as string[];
}

/**
 * The one place that says how to start the server and run the CLI. Another server (a port) is tested by setting
 * CKANBAN_CONTRACT_DAEMON and CKANBAN_CONTRACT_CLI to JSON arrays, e.g. '["/tmp/ckanban-rs","dev"]'.
 */
/** The Bun daemon alone, whatever CKANBAN_CONTRACT_DAEMON says (the parity test runs it next to the other server). */
export const BUN_DAEMON_CMD = [process.execPath, join(REPO, "src", "cli.ts"), "dev"];
export const DAEMON_CMD = commandFromEnv("CKANBAN_CONTRACT_DAEMON", BUN_DAEMON_CMD);
export const CLI_CMD = commandFromEnv("CKANBAN_CONTRACT_CLI", [process.execPath, join(REPO, "src", "cli.ts")]);
export const FAKE_CLAUDE = join(REPO, "test", "fixtures", "fake-claude.ts");

export interface Daemon {
  port: number;
  url: string;
  /** The data folder (what ~/.claude-kanban is for a real install). */
  home: string;
  /** The board's project folder. */
  project: string;
  env: Record<string, string>;
  /** fetch against the daemon; JSON bodies are encoded, the answer parsed when it is JSON. */
  api<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: T; text: string }>;
  /** Runs the ckanban CLI against this daemon (cwd defaults to the project folder). */
  cli(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }>;
  log(): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A folder of do-nothing commands put first on PATH: no Mac banners, no keep-awake, no browser, no Tailscale. */
function stubBin(): string {
  const dir = tmp("ck-contract-bin-");
  for (const name of ["osascript", "caffeinate", "open", "tailscale", "terminal-notifier"]) {
    const f = join(dir, name);
    writeFileSync(f, "#!/bin/sh\nexit 0\n");
    chmodSync(f, 0o755);
  }
  // The board runs `claude`; this is the fake one.
  const claude = join(dir, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(claude, 0o755);
  return dir;
}

export interface StartOptions {
  /** The server to start; DAEMON_CMD when unset. */
  cmd?: string[];
  fakeMode?: string;
  /** Extra env for the daemon and the CLI (wins over the defaults below). */
  env?: Record<string, string>;
  /** Runs after the temp folders exist and before the daemon starts: seed data files or Claude credentials here. */
  before?: (dirs: { home: string; claudeDir: string; project: string }) => void;
}

export async function startDaemon(opts: StartOptions = {}): Promise<Daemon> {
  const root = tmp("ck-contract-");
  const home = join(root, "data");
  const userHome = join(root, "home");
  const project = join(root, "project");
  const claudeDir = join(root, "claude-config");
  // claude-config/projects: where Claude keeps transcripts; the daemon watches it as on a real Mac.
  for (const d of [home, userHome, project, join(claudeDir, "projects")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, "README.md"), "# Contract test project\n");
  const bin = stubBin();
  const port = await freePort();
  let remotePort = await freePort();
  while (remotePort === port) remotePort = await freePort();
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: userHome,
    CKANBAN_HOME: home,
    CKANBAN_PORT: String(port),
    CKANBAN_REMOTE_PORT: String(remotePort),
    CKANBAN_CLAUDE_BIN: join(bin, "claude"),
    CLAUDE_CONFIG_DIR: claudeDir,
    FAKE_MODE: opts.fakeMode ?? "ok",
    FAKE_ARGS_FILE: join(root, "claude-args.jsonl"),
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
    // The test's own time zone (bun test runs in UTC), so local day keys (spend) agree on both sides.
    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Plan usage never reaches Anthropic or the Mac keychain: a closed local port unless a test starts its own fake.
    CKANBAN_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage",
    CKANBAN_NO_KEYCHAIN: "1",
    ...opts.env,
  };
  opts.before?.({ home, claudeDir, project });
  const logFile = join(root, "daemon.log");
  const proc = Bun.spawn(opts.cmd ?? DAEMON_CMD, { env, cwd: project, stdout: Bun.file(logFile), stderr: Bun.file(join(root, "daemon.err.log")) });
  const url = `http://127.0.0.1:${port}`;
  const log = () => {
    let out = "";
    for (const f of ["daemon.log", "daemon.err.log"]) {
      try {
        out += readFileSync(join(root, f), "utf8");
      } catch {}
    }
    return out;
  };

  const api: Daemon["api"] = async (method, path, body, headers = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, data, text };
  };

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`daemon exited with ${proc.exitCode}:\n${log()}`);
    try {
      if ((await fetch(`${url}/api/profiles`)).ok) break;
    } catch {}
    if (Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`daemon did not answer on ${url} within 30s:\n${log()}`);
    }
    await Bun.sleep(100);
  }

  const cli: Daemon["cli"] = async (args, cwd = project) => {
    const p = Bun.spawn([...CLI_CMD, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  };

  const stop = async () => {
    proc.kill("SIGTERM");
    const killed = await Promise.race([proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!killed) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  };

  return { port, url, home, project, env, api, cli, log, stop };
}

/** Polls `fn` until it returns a truthy value (or throws after `ms`). */
export async function until<T>(fn: () => T | Promise<T>, ms = 15_000, what = "condition"): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}
