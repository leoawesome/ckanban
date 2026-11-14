import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/server/board";
import { folderDiff, MAX_DIFF_FILES, MAX_DIFF_LINES, MAX_FILE_LINES, parseDiff, REWRITTEN_NOTE, ticketDiff, type DiffFile } from "../src/server/diff";
import { Bus } from "../src/server/events";
import { run } from "../src/server/git";
import { createServer } from "../src/server/http";
import { Store } from "../src/server/store";
import { makeRepo, tempDir } from "./helpers";

const git = (dir: string, ...args: string[]) => run(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], dir);

let repo: string;

/** A repo with main + a ticket branch carrying committed, staged, unstaged and untracked changes. */
beforeAll(async () => {
  repo = await makeRepo();
  writeFileSync(join(repo, "keep.ts"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.ts"), "bye\n");
  writeFileSync(join(repo, "old-name.ts"), "a\nb\nc\nd\ne\nf\n");
  writeFileSync(join(repo, "ws.ts"), "x = 1\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "checkout", "-qb", "ck/t1");
  // Committed on the branch.
  writeFileSync(join(repo, "keep.ts"), "one\nTWO\nthree\nfour\n");
  await git(repo, "commit", "-qam", "edit keep");
  // main moves on afterwards: its new commit must not show in the ticket's diff.
  await git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "main-only.ts"), "later\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "main moves");
  await git(repo, "checkout", "-q", "ck/t1");
  // Staged delete + rename, unstaged whitespace edit, untracked and ignored files.
  await git(repo, "rm", "-q", "gone.ts");
  renameSync(join(repo, "old-name.ts"), join(repo, "new name.ts"));
  writeFileSync(join(repo, "ws.ts"), "x  =  1\n");
  writeFileSync(join(repo, "fresh.ts"), "hello\nworld\n");
  writeFileSync(join(repo, "pic.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
  writeFileSync(join(repo, "ignored.log"), "noise\n");
});

const byPath = (files: DiffFile[]) => Object.fromEntries(files.map((f) => [f.path, f]));

test("diff covers committed, uncommitted and untracked changes against the merge-base", async () => {
  const d = await ticketDiff(repo, "main");
  expect(d.base).toBe("main");
  expect(d.branch).toBe("ck/t1");
  const f = byPath(d.files);
  expect(Object.keys(f).sort()).toEqual(["fresh.ts", "gone.ts", "keep.ts", "new name.ts", "pic.bin", "ws.ts"]);

  expect(f["keep.ts"]).toMatchObject({ status: "M", additions: 2, deletions: 1, binary: false });
  const lines = f["keep.ts"].hunks[0].lines;
  expect(lines).toEqual([
    { type: "ctx", text: "one", old: 1, new: 1 },
    { type: "del", text: "two", old: 2, new: null },
    { type: "add", text: "TWO", old: null, new: 2 },
    { type: "ctx", text: "three", old: 3, new: 3 },
    { type: "add", text: "four", old: null, new: 4 },
  ]);
  expect(f["keep.ts"].hunks[0].header).toStartWith("@@ -1,3 +1,4 @@");

  expect(f["gone.ts"]).toMatchObject({ status: "D", additions: 0, deletions: 1 });
  expect(f["new name.ts"]).toMatchObject({ status: "R", oldPath: "old-name.ts", additions: 0, deletions: 0 });
  expect(f["fresh.ts"]).toMatchObject({ status: "A", additions: 2, deletions: 0 });
  expect(f["fresh.ts"].hunks[0].lines.map((l) => l.new)).toEqual([1, 2]);
  expect(f["pic.bin"]).toMatchObject({ status: "A", binary: true, hunks: [] });
  expect(f["ws.ts"]).toMatchObject({ status: "M", additions: 1, deletions: 1 });
  expect(d.additions).toBe(5);
  expect(d.deletions).toBe(3);
});

test("the real index is left alone", async () => {
  const st = await run(["git", "status", "--porcelain"], repo);
  expect(st.stdout).toContain("?? fresh.ts");
  expect(st.stdout).toContain(" M ws.ts");
  expect(readdirSync(tmpdir()).some((n) => n.startsWith(`ckanban-diff-${process.pid}-`))).toBe(false);
});

test("ignore whitespace drops whitespace-only hunks", async () => {
  const d = await ticketDiff(repo, "main", { ignoreWhitespace: true });
  const ws = byPath(d.files)["ws.ts"];
  expect(ws?.hunks ?? []).toEqual([]);
  expect(byPath(d.files)["keep.ts"].additions).toBe(2);
});

test("an origin/ copy ahead of the local base branch wins", async () => {
  const r = await makeRepo();
  await git(r, "checkout", "-qb", "ck/t2");
  // Pretend origin/main moved and the ticket branch was rebased onto it, while local main stayed behind.
  writeFileSync(join(r, "upstream.ts"), "u\n");
  await git(r, "add", ".");
  await git(r, "commit", "-qm", "upstream work");
  await git(r, "update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(r, "mine.ts"), "m\n");
  await git(r, "add", ".");
  await git(r, "commit", "-qm", "ticket work");
  const d = await ticketDiff(r, "main");
  expect(d.base).toBe("origin/main");
  expect(d.files.map((f) => f.path)).toEqual(["mine.ts"]);
});

test("missing worktree and unknown base fail clearly", async () => {
  await expect(ticketDiff(join(repo, "nope"), "main")).rejects.toThrow("no longer exists");
  await expect(ticketDiff(repo, "no-such-branch")).rejects.toThrow("no common ancestor");
});

test("folderDiff: commits and uncommitted work in the folder since the ticket's first run", async () => {
  const dir = await makeRepo();
  const start = (await run(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
  writeFileSync(join(dir, "README.md"), "hi\nthere\n");
  await git(dir, "commit", "-qam", "edit readme");
  writeFileSync(join(dir, "new.ts"), "x\n");
  const d = await folderDiff(dir, start);
  expect(d.note).toBeUndefined();
  expect(d.mergeBase).toBe(start);
  expect(d.base).toBe(start.slice(0, 7));
  expect(d.branch).toBe("main");
  expect(d.files.map((f) => f.path).sort()).toEqual(["README.md", "new.ts"]);
});

test("folderDiff: a start commit no longer in the folder's history gives a plain note, not an error", async () => {
  const dir = await makeRepo();
  writeFileSync(join(dir, "a.ts"), "a\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "a");
  const start = (await run(["git", "rev-parse", "HEAD"], dir)).stdout.trim();
  await git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(dir, "b.ts"), "b\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "b");
  const d = await folderDiff(dir, start);
  expect(d.note).toBe(REWRITTEN_NOTE);
  expect(d.files).toEqual([]);
});

test("parseDiff marks long files too large and drops their content", () => {
  const body = Array.from({ length: MAX_FILE_LINES + 5 }, (_, i) => `+l${i}`).join("\n");
  const out = `diff --git a/big.txt b/big.txt\nnew file mode 100644\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,${MAX_FILE_LINES + 5} @@\n${body}\n`;
  const [f] = parseDiff(out);
  expect(f).toMatchObject({ path: "big.txt", status: "A", tooLarge: true, hunks: [], additions: MAX_FILE_LINES + 5 });
});

test("parseDiff unquotes paths and skips no-newline markers", () => {
  const out = [
    'diff --git "a/t\\303\\251st.txt" "b/t\\303\\251st.txt"',
    "--- \"a/t\\303\\251st.txt\"",
    "+++ \"b/t\\303\\251st.txt\"",
    "@@ -1 +1 @@",
    "-a",
    "\\ No newline at end of file",
    "+b",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const [f] = parseDiff(out);
  expect(f.path).toBe("tést.txt");
  expect(f.hunks[0].lines).toEqual([
    { type: "del", text: "a", old: 1, new: null },
    { type: "add", text: "b", old: null, new: 1 },
  ]);
});

// The HTTP endpoint, against a board whose ticket points at the repo above.
let server: ReturnType<typeof createServer>;
let base: string;
let store: Store;

beforeAll(() => {
  store = new Store(tempDir("ck-home-"));
  const bus = new Bus();
  const board = new Board(store, bus, { claudeBin: "/bin/false" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("GET /tickets/:id/diff", async () => {
  const path = await makeRepo();
  let r = await fetch(`${base}/api/profiles`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Diff", path, baseBranch: "main" }),
  });
  const p = (await r.json()) as any;
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", status: "backlog" }),
  });
  const t = (await r.json()) as any;

  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}/diff`);
  expect(r.status).toBe(404);

  store.updateTicket(p.slug, t.id, { worktree: repo, branch: "ck/t1" });
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}/diff`);
  expect(r.status).toBe(200);
  const d = (await r.json()) as any;
  expect(d.files.length).toBe(6);
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}/diff?w=1`);
  const dw = (await r.json()) as any;
  expect(dw.files.find((f: any) => f.path === "ws.ts")?.hunks ?? []).toEqual([]);

  rmSync(path, { recursive: true, force: true });
  store.updateTicket(p.slug, t.id, { worktree: join(path, "gone") });
  r = await fetch(`${base}/api/profiles/${p.slug}/tickets/${t.id}/diff`);
  expect(r.status).toBe(404);
});

/**
 * A board whose base branch is "master" while a run moved its ticket branch onto origin/feature, which is
 * far ahead of master: the Changes tab must compare with feature, not list everything feature has.
 */
async function movedRepo() {
  const origin = await makeRepo();
  await git(origin, "branch", "-m", "master");
  await git(origin, "checkout", "-qb", "feature");
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(origin, `feature-${i}.ts`), `f${i}\n`);
    await git(origin, "add", ".");
    await git(origin, "commit", "-qm", `feature ${i}`);
  }
  await git(origin, "checkout", "-q", "master");
  const clone = tempDir("ck-clone-");
  await git(clone, "clone", "-q", origin, ".");
  const wt = (name: string) => join(clone, "..", `${name}-${Math.random().toString(36).slice(2)}`);
  return { clone, wt };
}

test("a ticket branch reset onto another branch is compared with that branch", async () => {
  const { clone, wt } = await movedRepo();
  const dir = wt("moved");
  await git(clone, "worktree", "add", "-q", "--no-track", "-b", "ck/t2", dir, "origin/master");
  await git(dir, "checkout", "-q", "-B", "ck/t2", "origin/feature");
  let d = await ticketDiff(dir, "master");
  expect(d.files).toEqual([]);
  expect(d.startedFrom).toBe("feature");

  writeFileSync(join(dir, "mine.ts"), "mine\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "ticket work");
  d = await ticketDiff(dir, "master");
  expect(d.files.map((f) => f.path)).toEqual(["mine.ts"]);
  expect(d.startedFrom).toBe("feature");
  rmSync(dir, { recursive: true, force: true });
});

test("git reset --hard onto another branch counts as a move too", async () => {
  const { clone, wt } = await movedRepo();
  const dir = wt("reset");
  await git(clone, "worktree", "add", "-q", "--no-track", "-b", "ck/t3", dir, "origin/master");
  await git(dir, "reset", "-q", "--hard", "origin/feature");
  const d = await ticketDiff(dir, "master");
  expect(d.files).toEqual([]);
  expect(d.startedFrom).toBe("feature");
  rmSync(dir, { recursive: true, force: true });
});

test("a ticket that stayed on the board's base branch is compared with it, as before", async () => {
  const { clone, wt } = await movedRepo();
  const dir = wt("stay");
  await git(clone, "worktree", "add", "-q", "--no-track", "-b", "ck/t4", dir, "origin/master");
  writeFileSync(join(dir, "mine.ts"), "mine\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "ticket work");
  const d = await ticketDiff(dir, "master");
  expect(d.base).toBe("master");
  expect(d.files.map((f) => f.path)).toEqual(["mine.ts"]);
  expect(d.startedFrom).toBeUndefined();
  rmSync(dir, { recursive: true, force: true });
});

test("the pull request's base branch wins over the board's base branch", async () => {
  const { clone, wt } = await movedRepo();
  const dir = wt("pr");
  // Merged rather than reset, so the reflog names no other branch: only the PR says where the work lands.
  await git(clone, "worktree", "add", "-q", "--no-track", "-b", "ck/t5", dir, "origin/master");
  await git(dir, "merge", "-q", "--ff-only", "origin/feature");
  expect((await ticketDiff(dir, "master")).files.length).toBe(5);
  const d = await ticketDiff(dir, "master", { prBase: "feature" });
  expect(d.files).toEqual([]);
  expect(d.startedFrom).toBe("feature");
  rmSync(dir, { recursive: true, force: true });
});

test("a ticket that copied a whole project in: the first MAX_DIFF_FILES files, then a row naming how many more", async () => {
  const dir = await makeRepo();
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  const { stdout } = await git(dir, "rev-parse", "HEAD");
  // A renamed file sorts first, so its old and new paths both reach the limited patch.
  await git(dir, "mv", "seed.txt", "0-seed.txt");
  for (let i = 0; i < MAX_DIFF_FILES + 150; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.ts`), Array.from({ length: 200 }, (_, k) => `line ${k}`).join("\n") + "\n");
  const d = await folderDiff(dir, stdout.trim());
  expect(d.moreFiles).toBe(151);
  expect(d.files).toHaveLength(MAX_DIFF_FILES + 1);
  expect(d.files[0]).toMatchObject({ path: "0-seed.txt", oldPath: "seed.txt", status: "R" });
  expect(d.files.at(-1)).toMatchObject({ path: "… and 151 more changed files (not shown)", more: true, hunks: [] });
  // MAX_DIFF_LINES patch lines in all: files past it are listed without content.
  const kept = d.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  expect(kept).toBeLessThanOrEqual(MAX_DIFF_LINES);
  expect(d.files.filter((f) => f.tooLarge).length).toBeGreaterThan(100);
  expect(d.additions).toBe(d.files.reduce((n, f) => n + f.additions, 0));
}, 60_000);
