// Helpers for the run life cycle contract tests (runs-*.test.ts): per-ticket fake Claude scripts and the event stream.
// Imports nothing from src/ (see daemon.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, until } from "./daemon";
import { readJsonl } from "./files";

/** A fake Claude step (see FAKE_SCRIPT_DIR in test/fixtures/fake-claude.ts). */
export interface Step {
  mode?: string;
  status?: "done" | "blocked" | "questions";
  summary?: string;
  prUrl?: string;
  files?: Record<string, string>;
  sh?: string[];
  outputs?: Record<string, string>;
  calls?: { method: string; path: string; body?: unknown }[];
  waitFile?: string;
}

/** The folder for per-ticket scripts; pass `env: { FAKE_SCRIPT_DIR: dir }` to startDaemon. */
export function scriptDir(root: string): string {
  const dir = join(root, "fake-scripts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class Scripts {
  constructor(readonly dir: string) {}
  /** Sets the steps of script `name` (one per run); a ticket whose body holds `[fake:<name>]` follows it. */
  set(name: string, steps: Step[]): string {
    writeFileSync(join(this.dir, `${name}.json`), JSON.stringify(steps));
    return `[fake:${name}]`;
  }
  /** The board calls the script's runs made, with their answers. */
  out(name: string): { method: string; path: string; status: number; data: any }[] {
    return readJsonl(join(this.dir, `${name}.out.jsonl`));
  }
  /** One line per run that took a step: {cwd, ticket, args}. */
  runs(name: string): { cwd: string; ticket: string; args: string[] }[] {
    return readJsonl(join(this.dir, `${name}.runs.jsonl`));
  }
  /** A file a step can wait for (`waitFile`); `release` creates it. */
  gate(name: string): { file: string; release(): void } {
    const file = join(this.dir, `${name}.gate`);
    return { file, release: () => writeFileSync(file, "go") };
  }
  left(name: string): number {
    const f = join(this.dir, `${name}.json`);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).length : 0;
  }
}

/** Collects the daemon's event stream (GET /api/events) from now on. */
export async function events(d: Daemon): Promise<{ all: any[]; close(): void }> {
  const ac = new AbortController();
  const res = await fetch(`${d.url}/api/events`, { signal: ac.signal });
  if (res.status !== 200) throw new Error(`/api/events answered ${res.status}`);
  const all: any[] = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const msg = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of msg.split("\n")) if (line.startsWith("data: ")) all.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
  })();
  return { all, close: () => ac.abort() };
}

/** GET a ticket's view. */
export async function view(d: Daemon, slug: string, id: string): Promise<any> {
  const r = await d.api("GET", `/api/profiles/${slug}/tickets/${id}`);
  if (r.status !== 200) throw new Error(`GET ticket ${id}: ${r.status} ${r.text}`);
  return r.data;
}

/** Waits until the ticket isn't running and `ok(view)` holds; returns the view. */
export async function settled(d: Daemon, slug: string, id: string, ok: (t: any) => boolean = () => true, ms = 30_000): Promise<any> {
  let last: any;
  try {
    return await until(async () => {
      last = await view(d, slug, id);
      return !last.running && last.status !== "in_progress" && ok(last) ? last : null;
    }, ms, `ticket ${id} to settle`);
  } catch (e) {
    throw new Error(`${(e as Error).message}; last view: ${JSON.stringify({ status: last?.status, running: last?.running, outcome: last?.outcome, error: last?.error, lastActivity: last?.lastActivity })}\n${d.log().slice(-3000)}`);
  }
}

/** Waits until the ticket's run is live. */
export function running(d: Daemon, slug: string, id: string, ms = 30_000): Promise<any> {
  return until(async () => {
    const t = await view(d, slug, id);
    return t.running ? t : null;
  }, ms, `ticket ${id} to run`);
}

/** Runs a command; throws with its output when it fails. */
export function sh(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}: ${r.stderr.toString()}${r.stdout.toString()}`);
  return r.stdout.toString().trim();
}
