// Project copies review helpers left in a ticket's outputs (outputs/<handle>/copy, .../main, installed dependencies).
//
// Helpers are told to make scratch copies in a temp folder (prompts.ts), but some made them in their outputs folder,
// where nothing removed them (about 1 GB and 50,000 files on one board). When a huddle closes or its ticket moves to
// Done, removeOutputCopies looks only inside that huddle's helpers' folders of that one ticket's outputs and removes:
// - dependency folders (node_modules and the like): installed files, never results. `venv`, `.cache` and `.next` are
//   common names for other things too: they go only inside a copy of the project (or a venv with its pyvenv.cfg);
// - a checked-out copy of the project (its own .git, holding most of the project folder's top-level names), only when
//   git says nothing in it is uncommitted or untracked and every commit it has (HEAD, its branches, a stash) is also
//   in the project's own version history. A helper's edits or commits in a copy are its work: such a copy stays.
// A copy without .git (dependencies installed, the project's names) loses only its dependency folders: nothing tells
// a plain copy from one the helper changed. A copy that also holds names the project lacks (a report saved in it)
// loses only the project's own entries, .git and dependency folders.
// Anything else stays (reports, check outputs, screenshots, scripts, unclear folders). A helper's folder itself is
// never removed, symlinks are never followed, and every removal is checked to be inside the ticket's outputs folder by
// real path. The walk is shallow (MAX_DEPTH) and stops at what it removes; removal runs off the event loop (fs.promises).
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { run } from "./git";
import { pauser } from "./lag";

/** Installed or cached files: removed wherever they sit in a helper's folder. */
export const DEPENDENCY_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", ".turbo", ".pnpm-store"]);
/** Dependency names also used for other folders (a results cache, a site): removed only inside a copy of the project. */
const LOOSE_DEPENDENCY_DIRS = new Set(["venv", ".cache", ".next"]);
/** How deep under a helper's folder copies are looked for (outputs/qa/copy is depth 1, outputs/qa/run1/main depth 2). */
const MAX_DEPTH = 3;
/** Share of the project's top-level names a folder must hold to count as a copy of it. */
const MATCH_SHARE = 0.6;
/** Fewest matching names: a project with fewer top-level names is too small to tell a copy from a results folder. */
const MIN_MATCH = 3;
/** Share needed when installed dependencies are the only sign of a copy (no .git). */
const DEPS_ONLY_SHARE = 0.8;

/** The project folder's own top-level names (hidden and dependency ones left out); empty when it can't be read. */
export async function projectNames(projectDir: string | null | undefined): Promise<Set<string>> {
  if (!projectDir) return new Set();
  try {
    return new Set((await readdir(projectDir)).filter((n) => !n.startsWith(".") && !DEPENDENCY_DIRS.has(n)));
  } catch {
    return new Set();
  }
}

/** Signs a folder was checked out or installed, not written by hand: version history, or installed dependencies. */
const GIT_MARK = ".git";
const DEP_MARKS = ["node_modules", ".venv", "venv"];

/**
 * True when `names` (a folder's entries) clearly are a copy of the project whose top-level names are `project`: it
 * holds most of the project's names and few of its own, and it was checked out (.git) or had dependencies installed.
 * Same names alone are not enough: a helper's revised files or mockup can share them, and those are results.
 */
export function looksLikeCopy(names: readonly string[], project: ReadonlySet<string>): boolean {
  if (project.size < MIN_MATCH) return false;
  const git = names.includes(GIT_MARK);
  const deps = DEP_MARKS.some((n) => names.includes(n));
  if (!git && !deps) return false;
  let matched = 0;
  let other = 0;
  for (const n of names) {
    if (project.has(n)) matched++;
    else if (!n.startsWith(".") && !DEPENDENCY_DIRS.has(n)) other++;
  }
  // A checkout needs most of the project's names; a folder with only installed dependencies as its sign needs more.
  const share = git ? MATCH_SHARE : DEPS_ONLY_SHARE;
  return matched >= Math.max(git ? MIN_MATCH : MIN_MATCH + 1, Math.ceil(project.size * share)) && other <= Math.max(3, matched / 2);
}

const SAFE_HANDLE = /^[\w-][\w.-]*$/;

/** Git in a folder a helper made: its own fsmonitor hook never runs, no lock is taken, and a hung call gives up. */
const gitIn = (cwd: string, args: string[]) =>
  run(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], cwd, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, 30_000);

/** An ignored path that is only installed or cached files (node_modules/..., .DS_Store), not a result kept out of git. */
// venv, .cache and .next are left out: a folder with those names may hold a result (venv/notes.md, .cache/results.md).
const installedOnly = (path: string) => path.split("/").some((x) => DEPENDENCY_DIRS.has(x) && !LOOSE_DEPENDENCY_DIRS.has(x)) || /(^|\/)\.DS_Store$/.test(path);
/** Most commits a copy may point at (refs and reflog) for the check; more and the copy stays (each costs a git call). */
const MAX_SHAS = 200;

/**
 * True only when nothing in the checkout at `copy` would be lost by removing it: it is a repository of its own, git
 * lists nothing changed, untracked or ignored there (except installed files), and every commit it points at (HEAD,
 * its branches, a stash) can be reached from a branch, tag or remote branch of the project's own repository. Anything
 * else, a failure included (no git, no project repository, a fake .git), says no.
 */
export async function committedElsewhere(copy: string, projectDir: string | null | undefined): Promise<boolean> {
  if (!projectDir) return false;
  const top = await gitIn(copy, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return false;
  try {
    if ((await realpath(top.stdout.trim())) !== (await realpath(copy))) return false;
  } catch {
    return false;
  }
  const status = await gitIn(copy, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"]);
  if (status.code !== 0) return false;
  for (const line of status.stdout.split("\n")) {
    if (!line) continue;
    // Untracked or ignored installed files (a node_modules git doesn't ignore) are fine; anything else is work.
    if (!(line.startsWith("!! ") || line.startsWith("?? ")) || !installedOnly(line.slice(3).replace(/^"|"$/g, "").replace(/\/$/, ""))) return false;
  }
  // An edit git is told not to look at (skip-worktree, assume-unchanged) doesn't show in status: such a copy stays.
  const flags = await gitIn(copy, ["ls-files", "-v"]);
  if (flags.code !== 0 || flags.stdout.split("\n").some((l) => l && (l[0] === "S" || l[0] !== l[0].toUpperCase()))) return false;
  // Every commit the copy points at: HEAD, every ref (branches, tags, stash, notes...) and HEAD's reflog (reset away).
  const head = await gitIn(copy, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const refs = await gitIn(copy, ["for-each-ref", "--format=%(objectname)"]);
  const reflog = await gitIn(copy, ["reflog", "--format=%H"]);
  if (head.code !== 0 || refs.code !== 0) return false;
  const shas = new Set([head.stdout, refs.stdout, reflog.code === 0 ? reflog.stdout : ""].flatMap((o) => o.split("\n").map((x) => x.trim()).filter(Boolean)));
  if (shas.size > MAX_SHAS) return false;
  for (const sha of shas) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) return false;
    // A ref may point at a tag object or a blob: peel it to its commit in the copy first; no commit there: keep.
    const commit = await gitIn(copy, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (commit.code !== 0) return false;
    const has = await gitIn(projectDir, ["for-each-ref", "--count=1", "--contains", commit.stdout.trim(), "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"]);
    if (has.code !== 0 || !has.stdout.trim()) return false;
  }
  return true;
}

export interface CopyCleanup {
  /** Removed folders, relative to the outputs folder ("qa/copy", "qa-2/main/node_modules"). */
  removed: string[];
  /** Folders that couldn't be removed (fully), with why. */
  failed: string[];
  /** A removed folder was a git worktree: run `git worktree prune` in the project so its branch is free again. */
  worktree: boolean;
}

/**
 * Removes project copies and dependency folders from outputs/<handle>/ for each of `handles` (see the file comment).
 * `project` is projectNames() of the host's project folder; without it only dependency folders go. `projectDir`: that
 * folder, whose version history a checked-out copy's commits must be in before the copy goes (none: copies stay).
 */
export async function removeOutputCopies(outputsDir: string, handles: Iterable<string>, project: ReadonlySet<string>, projectDir?: string | null): Promise<CopyCleanup> {
  const removed: string[] = [];
  const failed: string[] = [];
  let worktree = false;
  let root: string;
  try {
    root = await realpath(outputsDir);
  } catch {
    return { removed, failed, worktree };
  }
  const pause = pauser();
  // Only a real folder whose real path is exactly where it should be: no symlink anywhere on the way.
  const realDir = async (path: string): Promise<boolean> => {
    try {
      const st = await lstat(path);
      return st.isDirectory() && !st.isSymbolicLink() && (await realpath(path)) === path;
    } catch {
      return false;
    }
  };
  const remove = async (path: string, rel: string) => {
    // Checked again right before: inside this ticket's outputs, under a helper's folder (never that folder itself),
    // in a real folder; a folder must be real itself, anything else (a file, a symlink) is removed as itself.
    if (!path.startsWith(root + sep) || rel.split("/").length < 2 || !(await realDir(dirname(path)))) return;
    try {
      const st = await lstat(path);
      if (st.isDirectory() && !(await realDir(path))) return;
    } catch {
      return;
    }
    try {
      // A `git worktree add` copy (its .git is a file) stays registered in the user's repo until git prunes it.
      const gitFile = rel.endsWith(`/${GIT_MARK}`) ? path : join(path, GIT_MARK);
      if (!worktree) worktree = await lstat(gitFile).then((x) => x.isFile(), () => false);
      await rm(path, { recursive: true, force: true });
      removed.push(rel);
    } catch (e) {
      // Read-only or busy files: what's left stays, and the rest of the walk goes on.
      failed.push(`${rel} (${(e as Error).message})`);
    }
  };
  /** inCopy: dir is (inside) a copy of the project, where `venv`, `.cache` and `.next` are installed or built files too. */
  /** repo: the checkout (kept, with work of its own) dir is in, whose tracked folders are never removed as installed. */
  const visit = async (dir: string, rel: string, depth: number, inCopy: boolean, repo: string | null = null): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      await pause();
      const path = join(dir, n);
      if (!(await realDir(path))) continue;
      const r = `${rel}/${n}`;
      if (DEPENDENCY_DIRS.has(n) && (!LOOSE_DEPENDENCY_DIRS.has(n) || inCopy || (n === "venv" && (await isFile(join(path, "pyvenv.cfg")))))) {
        if (!repo || (await untracked(repo, path))) await remove(path, r);
        continue;
      }
      let inner: string[];
      try {
        inner = await readdir(path);
      } catch {
        continue;
      }
      if (!looksLikeCopy(inner, project)) {
        if (depth < MAX_DEPTH) await visit(path, r, depth + 1, inCopy, repo);
        continue;
      }
      // A checkout whose every change and commit is safe in the project's history goes; names the project doesn't
      // have may be results the helper saved in it (ignored by git): those stay, the rest goes.
      if (inner.includes(GIT_MARK) && (await committedElsewhere(path, projectDir))) {
        const extras = inner.filter((x) => !project.has(x) && !x.startsWith(".") && !DEPENDENCY_DIRS.has(x));
        if (!extras.length) await remove(path, r);
        else for (const x of inner) if (project.has(x) || x === GIT_MARK || DEPENDENCY_DIRS.has(x)) await remove(join(path, x), `${r}/${x}`);
        continue;
      }
      // No .git, or work that is only here (changes, untracked files, its own commits): only its installed files go.
      await visit(path, r, depth + 1, true, inner.includes(GIT_MARK) ? path : repo);
    }
  };
  const isFile = (path: string) => lstat(path).then((x) => x.isFile(), () => false);
  /** git tracks nothing in this folder of the checkout (a failure counts as tracked: it stays). */
  const untracked = async (repo: string, path: string) => {
    const r = await gitIn(repo, ["ls-files", "--", path]);
    return r.code === 0 && !r.stdout.trim();
  };
  for (const handle of new Set(handles)) {
    if (!SAFE_HANDLE.test(handle)) continue;
    const dir = join(root, handle);
    if (!(await realDir(dir))) continue;
    // A helper's folder that is itself a copy is never removed (it holds the helper's report): its installed files go.
    const own = await readdir(dir).catch(() => [] as string[]);
    await visit(dir, handle, 1, looksLikeCopy(own, project), own.includes(GIT_MARK) ? dir : null);
  }
  return { removed, failed, worktree };
}
