import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/runs/git";
import { changedFiles, codeKey, fixtureUsers, passedAt, recordPass, relatedBase, relatedPlan } from "./test-plan";
import { makeRepo, tempDir } from "../test/support/helpers";

test("the code fingerprint follows code changes, new files included, and ignores docs and timings", async () => {
  const dir = await makeRepo();
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  const k1 = codeKey(dir)!;
  expect(k1).toBeTruthy();
  expect(codeKey(dir)).toBe(k1);

  // Docs and the timings file don't change it.
  writeFileSync(join(dir, "README.md"), "edited\n");
  writeFileSync(join(dir, "notes.md"), "new doc\n");
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test/timings.json"), "{}\n");
  expect(codeKey(dir)).toBe(k1);

  // An edit or a new code file does, committed or not.
  writeFileSync(join(dir, "src/a.ts"), "export const a = 2;\n");
  const k2 = codeKey(dir)!;
  expect(k2).not.toBe(k1);
  writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
  const k3 = codeKey(dir)!;
  expect(k3).not.toBe(k2);
  await run(["git", "add", "."], dir);
  await run(["git", "commit", "-qm", "two"], dir);
  expect(codeKey(dir)).toBe(k3);
});

test("working out the fingerprint leaves what is staged alone", async () => {
  const dir = await makeRepo();
  writeFileSync(join(dir, "x.ts"), "1\n");
  codeKey(dir);
  expect((await run(["git", "status", "--porcelain"], dir)).stdout).toContain("?? x.ts");
});

test("a folder without version history has no fingerprint, so nothing is skipped", () => {
  const dir = tempDir("ck-plain-");
  writeFileSync(join(dir, "a.ts"), "1\n");
  expect(codeKey(dir)).toBeNull();
});

test("a recorded pass is found again, and passes older than a week are forgotten", () => {
  const dir = tempDir("ck-passed-");
  expect(passedAt("k1", dir)).toBeNull();
  recordPass("old", dir);
  const weekAgo = (Date.now() - 8 * 86_400_000) / 1000;
  utimesSync(join(dir, "old"), weekAgo, weekAgo);
  recordPass("k1", dir);
  expect(passedAt("k1", dir)).toBeGreaterThan(Date.now() - 60_000);
  expect(existsSync(join(dir, "old"))).toBe(false);
});

test("changed files count the branch's commits since main plus uncommitted and new files", async () => {
  const dir = await makeRepo();
  await run(["git", "checkout", "-qb", "ticket"], dir);
  writeFileSync(join(dir, "committed.ts"), "1\n");
  await run(["git", "add", "."], dir);
  await run(["git", "commit", "-qm", "c"], dir);
  writeFileSync(join(dir, "README.md"), "edited\n");
  writeFileSync(join(dir, "new.ts"), "1\n");
  const base = relatedBase(dir)!;
  expect(base).toBe((await run(["git", "rev-parse", "main"], dir)).stdout.trim());
  expect(changedFiles(dir, base)).toEqual(["README.md", "committed.ts", "new.ts"]);
});

test("--related runs everything when shared setup changes, and adds tests that start a changed file by path", () => {
  expect(relatedPlan(["src/board/board.ts"])).toEqual({ full: false, extra: [] });
  expect(relatedPlan(["src/board/board.ts", "package.json"])).toEqual({ full: true, reason: "package.json" });
  expect(relatedPlan(["test/preload.ts"]).full).toBe(true);
  expect(relatedPlan(["src/cli/cli.ts"])).toEqual({ full: false, extra: ["test/integration/agent-access.test.ts"] });
  expect(relatedPlan(["src/cli/cli.ts", "test/integration/agent-access.test.ts"])).toEqual({ full: false, extra: [] });
});

test("--related runs the tests that use a changed fixture, directly or through a helper in test/", () => {
  const files = new Map([
    ["test/fixtures/fake-claude.ts", `import { ctx } from "./fake-claude-context";`],
    ["test/fixtures/fake-claude-context.ts", "export const ctx = 1;"],
    ["test/support/board-env.ts", `export const FAKE = join(import.meta.dir, "..", "fixtures", "fake-claude.ts");`],
    ["test/contract/daemon.ts", `const FAKE = join(REPO, "test", "fixtures", "fake-claude.ts");`],
    ["src/board/a.test.ts", `import { FAKE } from "../../test/support/board-env";`],
    ["test/contract/b.test.ts", `import { start } from "./daemon";`],
    ["test/integration/c.test.ts", `import { x } from "../../src/cli/daemon";`],
    ["src/chat/d.test.ts", `readFileSync(join(dir, "fixtures", "context", "x.txt"))`],
    ["src/other.test.ts", `const y = 2;`],
  ]);
  expect(fixtureUsers(["fake-claude.ts"], files)).toEqual(["src/board/a.test.ts", "test/contract/b.test.ts"]);
  // A fixture another fixture imports reaches that fixture's users too; a folder fixture is named as a path part.
  expect(fixtureUsers(["fake-claude-context.ts"], files)).toEqual(["src/board/a.test.ts", "test/contract/b.test.ts"]);
  expect(fixtureUsers(["context"], files)).toEqual(["src/chat/d.test.ts"]);
  expect(fixtureUsers([], files)).toEqual([]);
  // In this repo: a change to the fake claude runs its users, not the whole suite.
  const plan = relatedPlan(["test/fixtures/fake-claude.ts"]);
  expect(plan.full).toBe(false);
  if (!plan.full) expect(plan.extra).toContain("src/board/watchdog.test.ts");
});
