// What `bun run test` (scripts/test.ts) runs: the whole suite, nothing (this exact code already passed), or only the
// test files a change can affect (`--related`).
//
// A ticket often runs the full suite several times on code that didn't change in between (after a build, again after
// a review's re-check, again before landing), and each run takes minutes on a busy machine. So a full run that passes
// records a fingerprint of the code it tested, and a later run on the same code says so and stops. While building,
// `--related` runs only the test files that import a changed file (bun's own `--changed`), so a small edit doesn't
// pay for the whole suite; the landing check still runs it in full.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";

/** Where passed fingerprints are kept: one empty file per fingerprint, shared by every copy of the repo on the machine. */
export const PASSED_DIR = join(tmpdir(), "ckanban-test-passed");
const KEEP_DAYS = 7;

/**
 * Files a change to which can't change a test result, left out of the fingerprint: docs (no code reads the repo's
 * Markdown) and the timings file (it only orders the files).
 */
const NOT_CODE = ["*.md", "test/timings.json"];

/** A change to one of these can affect any test (setup, runner, dependencies), so `--related` runs them all. */
const FULL_IF_CHANGED = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "scripts/test.ts", "scripts/test-plan.ts", "test/preload.ts"];
/**
 * Fixtures (the fake claude, sample files) are started or read by path, so bun's import graph doesn't link them to
 * their tests. A change here runs the test files that name the fixture, directly or through a helper in test/.
 */
const FIXTURES = "test/fixtures/";
const TEST_FILE = /\.test\.tsx?$/;

/** Test files that start a source file as a program instead of importing it, so bun's import graph doesn't link them. */
const STARTED_BY_PATH: Record<string, string[]> = {
  "src/cli/cli.ts": ["test/integration/agent-access.test.ts"],
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
export function relatedPlan(changed: string[], cwd = process.cwd()): RelatedPlan {
  for (const f of changed) if (FULL_IF_CHANGED.includes(f)) return { full: true, reason: f };
  const extra = new Set<string>();
  for (const f of changed) for (const t of STARTED_BY_PATH[f] ?? []) if (!changed.includes(t)) extra.add(t);
  const fixtures = [...new Set(changed.filter((f) => f.startsWith(FIXTURES)).map((f) => f.slice(FIXTURES.length).split("/")[0]))];
  for (const t of fixtureUsers(fixtures, sourceFiles(cwd))) if (!changed.includes(t)) extra.add(t);
  return { full: false, extra: [...extra].sort() };
}

/** Every .ts/.tsx file the suite can reach, with its text (about 900 small files: a fixed-size scan, done once per run). */
export function sourceFiles(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const path = join(dir, n);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(n)) out.set(relative(cwd, path), readFileSync(path, "utf8"));
    }
  };
  for (const root of ["src", "web/src", "scripts", "test"]) walk(join(cwd, root));
  return out;
}

/**
 * Test files that use one of these fixtures (names right under test/fixtures/, e.g. "fake-claude.ts" or "context"):
 * they name it in a path or import, or use a helper in test/ (support, contract, other fixtures) that does.
 */
export function fixtureUsers(fixtures: string[], files: Map<string, string>): string[] {
  if (!fixtures.length) return [];
  const stem = (name: string) => basename(name).replace(/\.tsx?$/, "");
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A fixture is named by its file name in a path or path part ("fake-claude.ts", "fixtures/context/x").
  const fixturePattern = (f: string) => ({ re: new RegExp(`["'/]${esc(stem(f))}(\\.tsx?)?["'/]`), dir: null as string | null });
  const patterns = fixtures.map(fixturePattern);
  // A helper by an import of it: "./board-env" from its own folder, or ".../support/board-env" from anywhere.
  const helperPattern = (h: string) => {
    const dir = h.split("/").slice(-2, -1)[0];
    return { re: new RegExp(`["'](\\./|.*/${esc(dir)}/)${esc(stem(h))}(\\.tsx?)?["']`), dir: h.slice(0, h.lastIndexOf("/")) };
  };
  const uses = (file: string, p: { re: RegExp; dir: string | null }) => {
    const m = files.get(file)!.match(p.re);
    return !!m && (p.dir === null || !m[1]!.startsWith("./") || file.startsWith(p.dir + "/"));
  };
  // Until nothing new: helpers in test/ (support, contract, other fixtures) that use what changed count as changed too.
  const helpers = [...files.keys()].filter((f) => f.startsWith("test/") && !TEST_FILE.test(f));
  const reached = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const h of helpers) {
      if (!reached.has(h) && patterns.some((p) => uses(h, p))) {
        reached.add(h);
        patterns.push(h.startsWith(FIXTURES) ? fixturePattern(h) : helperPattern(h));
        grew = true;
      }
    }
  }
  return [...files.keys()].filter((f) => TEST_FILE.test(f) && patterns.some((p) => uses(f, p))).sort();
}

