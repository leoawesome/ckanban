// Helpers for the CLI contract tests (cli-*.test.ts): run the `ckanban` command as a program (CLI_CMD, so a port can
// be checked with CKANBAN_CONTRACT_CLI) in a sandbox, and a fake board server that records what the CLI asks it.
//
// The sandbox: a temp HOME, temp CKANBAN_HOME, temp Claude and Codex config folders, and a PATH of stub commands
// (launchctl, open, claude) plus /usr/bin:/bin only, so nothing reaches the real LaunchAgents folder, the real
// ~/.claude-kanban, the real Claude Code or Codex config, or opens a browser. Like daemon.ts, nothing here imports
// from src/ or web/.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_CMD } from "./daemon";

export const REPO = resolve(import.meta.dir, "..", "..");

/** True when CLI_CMD is the Bun CLI run from source (`bun src/cli.ts`), not a built binary or a port. */
export const CLI_FROM_SOURCE = CLI_CMD.length === 2 && CLI_CMD[1].endsWith(join("src", "cli.ts"));

/** A fenced block from contracts/cli.md: the one right after the line that contains `marker`. */
export function contractBlock(marker: string): string {
  const md = readFileSync(join(REPO, "contracts", "cli.md"), "utf8");
  const at = md.indexOf(marker);
  if (at < 0) throw new Error(`contracts/cli.md has no "${marker}"`);
  const open = md.indexOf("```", at);
  const start = md.indexOf("\n", open) + 1;
  const end = md.indexOf("\n```", start);
  return md.slice(start, end);
}

export interface Sandbox {
  root: string;
  /** The user's home folder for the CLI (HOME). */
  home: string;
  /** CKANBAN_HOME. */
  data: string;
  /** Stub commands, first on PATH. */
  bin: string;
  claudeDir: string;
  codexDir: string;
  env: Record<string, string>;
  /** Lines the stubs logged: `launchctl <args>`, `open <args>`, `claude <args>`. */
  calls(): string[];
  run(args: string[], o?: { env?: Record<string, string | undefined>; cwd?: string; stdin?: string; timeoutMs?: number }): Promise<CliResult>;
  cleanup(): void;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function script(dir: string, name: string, body: string) {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
}

/**
 * A sandbox for one test file. `rootPrefix` may hold characters the plist must escape. Stubs log each call to
 * $STUB_LOG and exit with $LAUNCHCTL_<VERB> (launchctl), $OPEN_EXIT (open) or $CLAUDE_EXIT (claude, which also prints
 * $CLAUDE_STDERR to stderr). launchctl print fails unless LAUNCHCTL_PRINT says otherwise (no job loaded).
 */
export function sandbox(rootPrefix = "ck-cli-"): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), rootPrefix)));
  const home = join(root, "home");
  const data = join(root, "data");
  const claudeDir = join(root, "claude-config");
  const codexDir = join(root, "codex");
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "ck-cli-bin-")));
  for (const d of [home, data, claudeDir]) mkdirSync(d, { recursive: true });
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  script(bin, "launchctl", `echo "launchctl $*" >> "$STUB_LOG"
case "$1" in
  print) exit "\${LAUNCHCTL_PRINT:-113}";;
  bootstrap) exit "\${LAUNCHCTL_BOOTSTRAP:-0}";;
  kickstart) exit "\${LAUNCHCTL_KICKSTART:-0}";;
  bootout) exit "\${LAUNCHCTL_BOOTOUT:-0}";;
esac
exit 0`);
  // Never a Mac banner, keep-awake or Tailscale change from a sandboxed command.
  for (const name of ["osascript", "caffeinate", "terminal-notifier", "tailscale"]) script(bin, name, `echo "${name} $*" >> "$STUB_LOG"\nexit 0`);
  script(bin, "open", `echo "open $*" >> "$STUB_LOG"\nexit "\${OPEN_EXIT:-0}"`);
  script(bin, "claude", `echo "claude $*" >> "$STUB_LOG"\n[ -n "$CLAUDE_STDERR" ] && printf '%s\\n' "$CLAUDE_STDERR" >&2\nexit "\${CLAUDE_EXIT:-0}"`);
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    CKANBAN_HOME: data,
    // A closed port unless a test starts a fake board.
    CKANBAN_PORT: "9",
    CKANBAN_CLAUDE_BIN: join(bin, "claude"),
    // Never the Mac's real Tailscale (/Applications/Tailscale.app wins over PATH without it).
    CKANBAN_TAILSCALE: join(bin, "tailscale"),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: codexDir,
    STUB_LOG: log,
    TMPDIR: tmpdir(),
    LANG: "en_US.UTF-8",
  };
  const run: Sandbox["run"] = async (args, o = {}) => {
    const merged: Record<string, string> = { ...env };
    for (const [k, v] of Object.entries(o.env ?? {})) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    const p = Bun.spawn([...CLI_CMD, ...args], {
      env: merged, cwd: o.cwd ?? home, stdout: "pipe", stderr: "pipe", stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), o.timeoutMs ?? 30_000);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  return {
    root, home, data, bin, claudeDir, codexDir, env, run,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

export interface Seen {
  method: string;
  /** Path and query, as sent. */
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body, the raw text when it isn't JSON, or undefined when there is none. */
  body: any;
}

export type Answer = { status?: number; json?: unknown; text?: string } | undefined;

export interface FakeBoard {
  port: number;
  seen: Seen[];
  /** Answers per request; return undefined for a 404 `{ error: "not found" }`. */
  answer: (r: Seen) => Answer | Promise<Answer>;
  reset(answer?: FakeBoard["answer"]): void;
  stop(): void;
}

/** A stand-in for the daemon on 127.0.0.1: records every request and answers with `answer`. */
export function fakeBoard(answer: FakeBoard["answer"] = () => undefined): FakeBoard {
  const fb: FakeBoard = {
    port: 0, seen: [], answer,
    reset(a) {
      fb.seen.length = 0;
      if (a) fb.answer = a;
    },
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const text = await req.text();
      let body: any = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const seen: Seen = { method: req.method, path: u.pathname + u.search, headers, body };
      fb.seen.push(seen);
      const a = await fb.answer(seen);
      if (!a) return Response.json({ error: "not found" }, { status: 404 });
      if (a.text !== undefined) return new Response(a.text, { status: a.status ?? 200 });
      if (a.status === 204) return new Response(null, { status: 204 });
      return Response.json(a.json ?? null, { status: a.status ?? 200 });
    },
  });
  fb.port = server.port!;
  return fb;
}
