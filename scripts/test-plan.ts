// What `bun run test` (scripts/test.ts) runs: the whole suite, nothing (this exact code already passed), or only the
// test files a change can affect (`--related`).
//
// A ticket often runs the full suite several times on code that didn't change in between (after a build, again after
// a review's re-check, again before landing), and each run takes minutes on a busy machine. So a full run that passes
// records a fingerprint of the code it tested, and a later run on the same code says so and stops. While building,
// `--related` runs only the test files that import a changed file (bun's own `--changed`), so a small edit doesn't
// pay for the whole suite; the landing check still runs it in full.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Where passed fingerprints are kept: one empty file per fingerprint, shared by every copy of the repo on the machine. */
export const PASSED_DIR = join(tmpdir(), "ckanban-test-passed");
const KEEP_DAYS = 7;

/**
 * Files a change to which can't change a test result, left out of the fingerprint: docs (no code reads the repo's
 * Markdown) and the timings file (it only orders the files).
 */
const NOT_CODE = ["*.md", "test/timings.json"];

/** A change to one of these can affect any test (setup, runner, dependencies, the fake claude), so `--related` runs them all. */
const FULL_IF_CHANGED = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "scripts/test.ts", "scripts/test-plan.ts", "test/preload.ts"];
const FULL_IF_UNDER = ["test/fixtures/"];

/** Test files that start a source file as a program instead of importing it, so bun's import graph doesn't link them. */
const STARTED_BY_PATH: Record<string, string[]> = {
  "src/cli.ts": ["test/agent-access.test.ts"],
};

function git(cwd: string, args: string[], env?: Record<string, string>): string | null {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/**
 * A fingerprint of the code as it is on disk now (committed or not, new files included, ignored files and docs left
 * out), plus the bun version. Null when the folder has no version history: then nothing is skipped.
 */
export function codeKey(cwd: string): string | null {
  const indexPath = git(cwd, ["rev-parse", "--git-path", "index"]);
  if (indexPath === null) return null;
  // A private copy of the index, so the real one (what the user or Claude staged) is left alone.
  const tmpIndex = join(tmpdir(), `ckanban-test-index-${process.pid}-${Date.now()}`);
  try {
    const real = isAbsolute(indexPath) ? indexPath : join(cwd, indexPath);
    if (existsSync(real)) copyFileSync(real, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    if (git(cwd, ["add", "-A"], env) === null) return null;
    if (git(cwd, ["rm", "--cached", "-q", "-r", "--ignore-unmatch", "--", ...NOT_CODE], env) === null) return null;
    const tree = git(cwd, ["write-tree"], env);
    return tree ? `${tree}-bun${Bun.version}` : null;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

/** When this exact code last passed the full suite (ms since epoch), or null. */
export function passedAt(key: string, dir = PASSED_DIR): number | null {
  try {
    return statSync(join(dir, key)).mtimeMs;
  } catch {
    return null;
  }
}

/** Note that this code passed the full suite, and forget passes older than a week. */
export function recordPass(key: string, dir = PASSED_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, key), "");
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of readdirSync(dir)) {
    try {
      if (statSync(join(dir, f)).mtimeMs < cutoff) rmSync(join(dir, f), { force: true });
    } catch {}
  }
}

/**
 * What this branch's changes are measured against: where it left main (so every change the ticket made counts, not
 * only the uncommitted ones). Falls back to the last commit.
 */
export function relatedBase(cwd: string): string | null {
  for (const main of ["origin/main", "main"]) {
    const base = git(cwd, ["merge-base", "HEAD", main]);
    if (base) return base;
  }
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Files changed since `base`: committed, uncommitted and new. */
export function changedFiles(cwd: string, base: string): string[] {
  const diff = git(cwd, ["diff", "--name-only", base]) ?? "";
  const added = git(cwd, ["ls-files", "--others", "--exclude-standard"]) ?? "";
  return [...new Set([...diff.split("\n"), ...added.split("\n")].filter(Boolean))].sort();
}

export type RelatedPlan = { full: true; reason: string } | { full: false; extra: string[] };

/** For `--related`: run everything (a shared file changed), or bun's affected files plus any started by path. */
export function relatedPlan(changed: string[]): RelatedPlan {
  for (const f of changed) {
    if (FULL_IF_CHANGED.includes(f) || FULL_IF_UNDER.some((d) => f.startsWith(d))) return { full: true, reason: f };
  }
  const extra = new Set<string>();
  for (const f of changed) for (const t of STARTED_BY_PATH[f] ?? []) if (!changed.includes(t)) extra.add(t);
  return { full: false, extra: [...extra].sort() };
}
