// Shared fixtures of the Rust board's R6 port (rust/board/tests/fixtures/git.json): Bun's answers for the pure logic of
// copies, diffs, pull requests and files over a table of inputs. This test checks Bun still gives exactly those
// answers; `cargo test -p ckanban-board` checks the Rust port gives them too (rust/board/tests/git_fixtures.rs). After a
// deliberate change to one of these functions, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-git-fixtures.test.ts`,
// then make `cargo test` pass again.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addPrs, ticketPrs, updatePrs } from "../src/board/prs";
import { attachmentHeader, markdownTitle } from "../src/board/share";
import { slugify } from "../src/core/util";
import { parseDiff } from "../src/runs/diff";
import { conflictMessage, failureMessage, mergeBlock, parsePrStatus, tail } from "../src/runs/prstatus";
import { applyDetection, parseSetupBlock, setupBlock, tailLines, withBoardText } from "../src/runs/worktree-setup";

const FILE = resolve(import.meta.dir, "..", "rust", "board", "tests", "fixtures", "git.json");
const UPDATE = process.env.UPDATE_RUST_FIXTURES === "1";
const NOW = "2026-11-17T08:00:00.000Z";

const PATCHES = [
  "diff --git a/x.txt b/x.txt\nindex 1..2 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n\\ No newline at end of file\n",
  "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
  "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n",
  "diff --git a/old name.txt b/new name.txt\nsimilarity index 90%\nrename from old name.txt\nrename to new name.txt\n--- a/old name.txt\t\n+++ b/new name.txt\t\n@@ -1 +1 @@\n-a\n+b\n",
  "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n",
  "diff --git \"a/t\\303\\251st \\\"q\\\".txt\" \"b/t\\303\\251st \\\"q\\\".txt\"\nnew file mode 100644\n--- /dev/null\n+++ \"b/t\\303\\251st \\\"q\\\".txt\"\n@@ -0,0 +1 @@\n+é\n",
  "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -10,2 +12,3 @@ fn x() {\n ctx\n+add\n ctx2\n@@ -40 +43 @@\n-x\n+y\n",
  `diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,3001 @@\n${Array.from({ length: 3001 }, (_, i) => `+${i}`).join("\n")}\n`,
  "",
];

const PR_RAWS = [
  {
    number: 7, state: "OPEN", baseRefName: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", comments: [{}, {}],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/1/job/2", completedAt: "2026-01-01T00:00:00Z" },
      { __typename: "StatusContext", context: "ci/x", state: "PENDING", targetUrl: "" },
      { name: "lint", status: "COMPLETED", conclusion: "SKIPPED", completedAt: "0001-01-01T00:00:00Z", startedAt: "2026-01-01T00:00:00Z" },
      { context: "deploy", state: "SUCCESS", targetUrl: "https://ci.example/d" },
      { name: "slow", status: "IN_PROGRESS", conclusion: "" },
      { name: "neutral", status: "COMPLETED", conclusion: "NEUTRAL" },
    ],
  },
  { state: "OPEN", mergeable: "MERGEABLE" },
  { number: "12", state: "MERGED", mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED", comments: 3 },
  { state: "CLOSED", mergeStateStatus: "DIRTY", baseRefName: "dev" },
  { state: "weird", mergeable: "maybe", statusCheckRollup: "nope" },
  {},
];

const TICKETS = [
  {},
  { prUrl: "u1" },
  { prUrl: "u1", pr: { url: "u1", state: "OPEN", base: "main" } },
  { prUrl: "u1", pr: { url: "u0", state: "MERGED" } },
  { prs: [{ url: "a", state: "MERGED" }, { url: "b", state: null }], prUrl: "b" },
  { prs: [{ url: "a", state: "CLOSED" }, { url: "b", state: "MERGED", base: "x" }], prUrl: "b" },
];

const NAMES = ["report.md", "a b.txt", "résumé \"x\".pdf", "😀.md", "tab\there", "back\\slash", "100%.csv", "(paren)'s*~!.txt"];

const TITLES = ["Rust board R6: git, copies!", "Résumé café", "!!!", "", "a".repeat(60), `${"a".repeat(39)} b`, "Ünïcödé ÀÉÎÕÜ ñ ç", "--x--", "MixedCASE 123"];

const MARKDOWN: [string, string][] = [
  ["intro\n## The *Plan* ##\n", "x.md"],
  ["# Title `code`\n# Second", "a.md"],
  ["no heading", "/d/Notes.Markdown"],
  ["### deep\n", "/x/y/report.md"],
  ["#not a heading", "plain.txt"],
];

const LISTS = [
  ["b", "B", "a", "A", "_z", "10", "2", "é", "_x", ".gitignore", "A.txt", "b.txt", "-a", "a-b", "a_b", "a.b", "a b", "Zeta", "zeta", "ä", "README.md", "readme.md", "#x", "$y", "~t", "x1", "x10", "x2"],
  ["src", "Cargo.toml", "cargo.lock", "README", "readme.txt", ".env", ".env.local", "node_modules", "__tests__", "test", "Test", "tests"],
];

function build() {
  const setupResults = [
    { copied: [".env"], missing: [], command: "npm ci", ok: false, exitCode: 1, timedOut: false, output: "error: </ckanban-setup> oops", durationMs: 1200 },
    { copied: [], missing: ["x"], command: "", ok: null, exitCode: null, timedOut: true, output: "", durationMs: 0 },
  ];
  const pr = parsePrStatus("https://github.com/o/r/pull/7", PR_RAWS[0], NOW);
  return {
    parseDiff: PATCHES.map((p) => ({ in: p, out: parseDiff(p) })),
    parsePrStatus: PR_RAWS.map((raw, i) => {
      const url = i === 1 ? "https://github.com/o/r/pull/9" : "https://github.com/o/r/pull/7";
      const out = parsePrStatus(url, raw, NOW);
      return { url, raw, now: NOW, out, mergeBlock: mergeBlock(out) };
    }),
    mergeBlockNull: mergeBlock(null),
    failureMessage: [
      { pr, logs: [{ name: "a", log: "x".repeat(9000), url: null }, { name: "b", log: null, url: "L" }], out: "" },
      { pr, logs: [{ name: "a", log: "y".repeat(20000), url: null }, { name: "b", log: "z".repeat(10), url: "M" }, { name: "c", log: "  \n", url: null }], out: "" },
    ].map((c) => ({ ...c, out: failureMessage(c.pr, c.logs) })),
    conflictMessage: [["main"], [""]].map(([base]) => ({ pr, base, out: conflictMessage(pr, base) })),
    tail: [["short\n\n", 10], ["0123456789abcdef", 6], ["é".repeat(20), 5]].map(([log, max]) => ({ log, max, out: tail(log as string, max as number) })),
    prs: TICKETS.map((t) => ({
      ticket: t,
      ticketPrs: ticketPrs(t as any),
      addPrs: addPrs(t as any, ["b", "c", "c"]),
      updatePrs: updatePrs(t as any, new Map([["b", { state: "CLOSED" as const, base: "dev" }], ["u1", { state: "MERGED" as const, base: null }]])),
    })),
    attachmentHeader: NAMES.map((name) => ({ name, out: attachmentHeader(name) })),
    markdownTitle: MARKDOWN.map(([md, file]) => ({ md, file, out: markdownTitle(md, file) })),
    slugify: TITLES.map((title) => ({ title, out: slugify(title) })),
    tailLines: [["a\nb\nc\n\n  ", 2], ["one", 40], ["", 3]].map(([text, n]) => ({ text, n, out: tailLines(text as string, n as number) })),
    setupBlock: setupResults.map((r) => ({ result: r, block: setupBlock(r as any), parsed: parseSetupBlock(`before\n${setupBlock(r as any)}\nafter`) })),
    withBoardText: [["p", "t", "Setup"], ["p <ckanban-context note=\"x\">", "t", "Setup"]].map(([prompt, text, note]) => ({ prompt, text, note, out: withBoardText(prompt, text, note) })),
    applyDetection: [
      [{ slug: "p" }, false],
      [{ slug: "p", setupCommand: "make", copyFiles: null }, false],
      [{ slug: "p", setupCommand: "make" }, true],
    ].map(([p, overwrite]) => {
      const d = { at: "t", copyFiles: [".env"], setupCommand: "bun install", setupFrom: ["bun.lock"] };
      return { profile: p, detected: d, overwrite, out: applyDetection(p as any, d, overwrite as boolean) };
    }),
    localeSort: LISTS.map((names) => ({ names, out: [...names].sort((a, b) => a.localeCompare(b)) })),
  };
}

test("Bun's answers for the R6 fixtures are unchanged (UPDATE_RUST_FIXTURES=1 rewrites them)", () => {
  const text = `${JSON.stringify(build(), null, 2)}\n`;
  if (UPDATE || !existsSync(FILE)) {
    mkdirSync(join(FILE, ".."), { recursive: true });
    writeFileSync(FILE, text);
  }
  expect(readFileSync(FILE, "utf8")).toBe(text);
});
