// Project copies review helpers leave in a ticket's outputs: copies and dependency folders go, results and unclear folders stay.
import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { committedElsewhere, looksLikeCopy, projectNames, removeOutputCopies } from "../src/server/output-copies";

const PROJECT = ["package.json", "README.md", "src", "test", "web", "tsconfig.json", "docs"];

function put(dir: string, files: string[]) {
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
}

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};

/** A project folder (a git repository with one commit) and a ticket outputs folder, each in its own temp folder. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), "ck-outcopies-"));
  const project = join(base, "project");
  put(project, ["package.json", "README.md", "src/a.ts", "test/a.test.ts", "web/index.html", "tsconfig.json", "docs/x.md"]);
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  git(project, "init", "-q", "-b", "main");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "first");
  const outputs = join(base, "ticket", "outputs");
  mkdirSync(outputs, { recursive: true });
  return { base, project, outputs };
}

/** A clone of the project at `dir`, untouched (what a helper's `git clone` leaves). */
const clone = (project: string, dir: string) => (mkdirSync(join(dir, ".."), { recursive: true }), git(project, "clone", "-q", project, dir));
const PROJECT_FILES = ["package.json", "README.md", "src/a.ts", "test/a.test.ts", "web/index.html", "tsconfig.json", "docs/x.md"];

test("looksLikeCopy needs a checkout or installed dependencies, most of the project's names and few others", () => {
  const p = new Set(PROJECT);
  expect(looksLikeCopy([...PROJECT, ".git", "node_modules"], p)).toBe(true);
  expect(looksLikeCopy(["package.json", "src", "test", "web", "README.md", ".git"], p)).toBe(true);
  expect(looksLikeCopy(["src", "test", "report.md", ".git"], p)).toBe(false);
  expect(looksLikeCopy([...PROJECT, ".git", "a.png", "b.png", "c.png", "d.png", "e.png", "f.png"], p)).toBe(false);
  // Same names without .git or installed dependencies: a helper's own work, kept.
  expect(looksLikeCopy(PROJECT, p)).toBe(false);
  expect(looksLikeCopy(["notes.md", "budget.xlsx", "report.docx"], new Set(["notes.md", "budget.xlsx", "report.docx"]))).toBe(false);
  expect(looksLikeCopy(["index.html", "styles.css", "app.js", "shots"], new Set(["index.html", "styles.css", "app.js", "README.md"]))).toBe(false);
  // Installed dependencies alone as the sign: most of the names are needed.
  expect(looksLikeCopy([...PROJECT, "node_modules"], p)).toBe(true);
  expect(looksLikeCopy(["src", "package.json", "README.md", "tsconfig.json", "node_modules"], p)).toBe(false);
  // A project too small to tell a copy from a results folder: nothing counts.
  expect(looksLikeCopy(["a", "b"], new Set(["a", "b"]))).toBe(false);
});

test("a clean clone of the project and installed files go; reports, screenshots and unclear folders stay", async () => {
  const { base, project, outputs } = setup();
  put(join(outputs, "qa"), ["report.md", "checks.txt", "shots/home.png", "scratch/notes.md", "scratch/node_modules/dep/index.js"]);
  clone(project, join(outputs, "qa", "copy"));
  put(join(outputs, "qa", "copy"), ["node_modules/x/y.js"]);
  clone(project, join(outputs, "qa", "run1", "main"));
  // Same names, but nothing checked out or installed: a helper's own files (a rewrite, a mockup) stay.
  put(join(outputs, "qa", "rewrite"), ["package.json", "README.md", "src/a.ts", "test/b.ts", "web/i.html", "docs/x.md", "tsconfig.json"]);
  // Unclear: some project names, mostly its own files.
  put(join(outputs, "qa", "partial"), ["src/a.ts", "test/a.ts", "result1.txt", "result2.txt", "result3.txt", "result4.txt"]);
  // Another helper not in the list, and the main ticket's own deliverable, are never looked at.
  clone(project, join(outputs, "other", "copy"));
  put(join(outputs, "site"), ["package.json", "node_modules/a.js"]);
  // A symlink out of the outputs folder, pointing at a project-looking folder, is not followed.
  const outside = join(base, "outside");
  put(outside, PROJECT_FILES.concat("node_modules/z.js"));
  symlinkSync(outside, join(outputs, "qa", "linked"));
  symlinkSync(join(outside, "node_modules"), join(outputs, "qa", "node_modules"));

  const { removed, failed } = await removeOutputCopies(outputs, ["qa", "../ticket", "."], await projectNames(project), project);
  expect(failed).toEqual([]);
  expect(removed.sort()).toEqual(["qa/copy", "qa/run1/main", "qa/scratch/node_modules"]);
  for (const f of ["qa/report.md", "qa/checks.txt", "qa/shots/home.png", "qa/scratch/notes.md", "qa/partial/result1.txt", "qa/partial/src/a.ts", "qa/rewrite/package.json",
    "other/copy/package.json", "site/node_modules/a.js", "qa/linked", "qa/node_modules"]) expect(existsSync(join(outputs, f))).toBe(true);
  expect(existsSync(join(outside, "package.json"))).toBe(true);
  expect(existsSync(join(outside, "node_modules", "z.js"))).toBe(true);
  expect(existsSync(join(outputs, "qa", "run1"))).toBe(true);
});

test("a clone with a helper's changes, new files, own commits or a stash stays; only its installed files go", async () => {
  const { project, outputs } = setup();
  const q = (n: string) => join(outputs, "qa", n);
  clone(project, q("edited"));
  appendFileSync(join(q("edited"), "src", "a.ts"), "// changed by the helper\n");
  clone(project, q("added"));
  put(q("added"), ["src/new-check.ts"]);
  clone(project, q("committed"));
  put(q("committed"), ["src/fix.ts"]);
  git(q("committed"), "add", "-A");
  git(q("committed"), "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "helper's fix");
  clone(project, q("branch"));
  git(q("branch"), "checkout", "-qb", "side");
  put(q("branch"), ["src/side.ts"]);
  git(q("branch"), "add", "-A");
  git(q("branch"), "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "side work");
  git(q("branch"), "checkout", "-q", "main");
  clone(project, q("stashed"));
  appendFileSync(join(q("stashed"), "README.md"), "more\n");
  git(q("stashed"), "-c", "user.name=T", "-c", "user.email=t@example.com", "stash", "-q");
  // Kept out of git by its .gitignore: a result, not installed files.
  clone(project, q("ignored"));
  appendFileSync(join(q("ignored"), ".git", "info", "exclude"), "results/\n");
  put(q("ignored"), ["results/run.log"]);
  for (const n of ["edited", "added", "committed", "branch", "stashed", "ignored"]) put(q(n), ["node_modules/dep/index.js"]);

  const { removed, failed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  expect(failed).toEqual([]);
  expect(removed.sort()).toEqual(["added", "branch", "committed", "edited", "ignored", "stashed"].map((n) => `qa/${n}/node_modules`));
  for (const f of ["edited/src/a.ts", "added/src/new-check.ts", "committed/src/fix.ts", "branch/.git", "stashed/.git", "ignored/results/run.log"]) {
    expect(existsSync(q(f))).toBe(true);
  }
});

test("a git worktree of the project goes once its branch holds its commits; one with changes stays", async () => {
  const { project, outputs } = setup();
  const clean = join(outputs, "qa", "wt");
  mkdirSync(join(outputs, "qa"), { recursive: true });
  git(project, "worktree", "add", "-q", "-b", "helper-wt", clean);
  put(clean, ["src/done.ts"]);
  git(clean, "add", "-A");
  git(clean, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "helper commit on its branch");
  const dirty = join(outputs, "qa", "wt2");
  git(project, "worktree", "add", "-q", "-b", "helper-wt2", dirty);
  appendFileSync(join(dirty, "README.md"), "unsaved\n");
  // A detached checkout with a commit no branch has: only there.
  const detached = join(outputs, "qa", "wt3");
  git(project, "worktree", "add", "-q", "--detach", detached);
  put(detached, ["src/lost.ts"]);
  git(detached, "add", "-A");
  git(detached, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "detached commit");

  const { removed, worktree } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  expect(removed).toEqual(["qa/wt"]);
  expect(worktree).toBe(true);
  // The commit is still on its branch in the project.
  expect(git(project, "log", "-1", "--format=%s", "helper-wt")).toBe("helper commit on its branch");
  expect(existsSync(join(dirty, "README.md"))).toBe(true);
  expect(existsSync(join(detached, "src", "lost.ts"))).toBe(true);
});

test("a copy without .git loses only its installed files; one whose .git isn't a repository keeps everything", async () => {
  const { project, outputs } = setup();
  // Dependencies installed, the project's names, a helper's edit inside src: nothing tells it from a plain copy.
  put(join(outputs, "qa", "copy"), [...PROJECT_FILES, "src/helper-fix.ts", "node_modules/a.js", ".next/BUILD_ID", ".cache/x", "venv/lib/x.py"]);
  put(join(outputs, "qa", "fake"), [...PROJECT_FILES, ".git", "node_modules/b.js"]);
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  // A .git git can't read: nothing there is removed, not even installed files (git can't say they aren't tracked).
  expect(removed.sort()).toEqual(["qa/copy/.cache", "qa/copy/.next", "qa/copy/node_modules", "qa/copy/venv"]);
  expect(existsSync(join(outputs, "qa", "copy", "src", "helper-fix.ts"))).toBe(true);
  expect(existsSync(join(outputs, "qa", "fake", "package.json"))).toBe(true);
});

test("folders named venv, .cache or .next outside a copy stay unless they clearly are a Python venv", async () => {
  const { project, outputs } = setup();
  put(join(outputs, "qa"), ["report.md", "venv/notes.md", ".cache/results.json", ".next/plan.md", "py/venv/pyvenv.cfg", "py/venv/lib/x.py", "py/.venv/lib/y.py"]);
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  expect(removed.sort()).toEqual(["qa/py/.venv", "qa/py/venv"]);
  for (const f of ["venv/notes.md", ".cache/results.json", ".next/plan.md"]) expect(existsSync(join(outputs, "qa", f))).toBe(true);
});

test("without the project folder's version history, checked-out copies stay", async () => {
  const { project, outputs } = setup();
  clone(project, join(outputs, "qa", "copy"));
  put(join(outputs, "qa", "copy"), ["node_modules/a.js"]);
  const plain = mkdtempSync(join(tmpdir(), "ck-plainproj-"));
  put(plain, PROJECT_FILES);
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames(plain), plain);
  expect(removed).toEqual(["qa/copy/node_modules"]);
  expect(await committedElsewhere(join(outputs, "qa", "copy"), null)).toBe(false);
  expect(await committedElsewhere(join(outputs, "qa", "copy"), project)).toBe(true);
});

test("a helper folder that is itself a copy is kept (it may hold the report); only its dependencies go", async () => {
  const { project, outputs } = setup();
  clone(project, join(outputs, "qa"));
  put(join(outputs, "qa"), ["node_modules/a.js", ".cache/c"]);
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  expect(removed.sort()).toEqual(["qa/.cache", "qa/node_modules"]);
  expect(existsSync(join(outputs, "qa", "src", "a.ts"))).toBe(true);
});

test("without a readable project folder only dependency folders go", async () => {
  const { project, outputs } = setup();
  clone(project, join(outputs, "qa", "copy"));
  put(join(outputs, "qa", "copy"), ["node_modules/a.js"]);
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames("/no/such/folder"), "/no/such/folder");
  expect(removed).toEqual(["qa/copy/node_modules"]);
  expect(existsSync(join(outputs, "qa", "copy", "package.json"))).toBe(true);
});

test("a symlinked outputs folder's copies are only removed through its real path, never outside it", async () => {
  const { base, project, outputs } = setup();
  clone(project, join(outputs, "qa", "copy"));
  const link = join(base, "outputs-link");
  symlinkSync(outputs, link);
  const { removed } = await removeOutputCopies(link, ["qa"], await projectNames(project), project);
  expect(removed).toEqual(["qa/copy"]);
  expect(existsSync(join(outputs, "qa"))).toBe(true);
});

test("a copy that can't be removed is reported and the rest still goes", async () => {
  const { project, outputs } = setup();
  clone(project, join(outputs, "qa", "a-stuck"));
  clone(project, join(outputs, "qa", "b-copy"));
  chmodSync(join(outputs, "qa", "a-stuck", "src"), 0o555);
  try {
    const { removed, failed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
    expect(removed).toEqual(["qa/b-copy"]);
    expect(failed.length).toBe(1);
    expect(failed[0]).toStartWith("qa/a-stuck");
  } finally {
    chmodSync(join(outputs, "qa", "a-stuck", "src"), 0o755);
  }
});

test("a clone whose work is only on a tag, in the reflog, in venv/ or .cache/, or hidden by skip-worktree stays", async () => {
  const { project, outputs } = setup();
  const q = (n: string) => join(outputs, "qa", n);
  const commit = (dir: string, file: string) => {
    put(dir, [file]);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", `add ${file}`);
  };
  clone(project, q("tagged"));
  commit(q("tagged"), "src/wip.ts");
  git(q("tagged"), "tag", "wip");
  git(q("tagged"), "reset", "-q", "--hard", "HEAD~1");
  clone(project, q("reflog"));
  commit(q("reflog"), "src/gone.ts");
  git(q("reflog"), "reset", "-q", "--hard", "HEAD~1");
  clone(project, q("venv-notes"));
  put(q("venv-notes"), ["venv/notes.md"]);
  clone(project, q("cache-report"));
  appendFileSync(join(q("cache-report"), ".git", "info", "exclude"), ".cache/\n");
  put(q("cache-report"), [".cache/results.md"]);
  clone(project, q("skip"));
  git(q("skip"), "update-index", "--skip-worktree", "README.md");
  appendFileSync(join(q("skip"), "README.md"), "hidden edit\n");
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  // venv-notes and cache-report are kept copies with work, so their venv and .cache count as installed there.
  expect(removed.sort()).toEqual(["qa/cache-report/.cache", "qa/venv-notes/venv"]);
  for (const n of ["tagged", "reflog", "skip"]) expect(existsSync(join(q(n), ".git"))).toBe(true);
  expect(git(q("tagged"), "log", "-1", "--format=%s", "wip")).toBe("add src/wip.ts");
});

test("in a kept clone, a dependency folder git tracks stays", async () => {
  const { project, outputs } = setup();
  const dir = join(outputs, "qa", "copy");
  clone(project, dir);
  put(dir, ["node_modules/patched/index.js"]);
  git(dir, "add", "-f", "node_modules");
  git(dir, "commit", "-qm", "vendor a patched dependency");
  const { removed } = await removeOutputCopies(outputs, ["qa"], await projectNames(project), project);
  expect(removed).toEqual([]);
  expect(existsSync(join(dir, "node_modules", "patched", "index.js"))).toBe(true);
});
