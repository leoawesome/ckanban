import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseList } from "./test-contract-rust-board";

const REPO = resolve(import.meta.dir, "..");

test("contract-files.txt: files with an optional test name pattern, comments skipped", () => {
  expect(parseList("# c\n\na.test.ts\n b.test.ts | event stream  # why\nc.test.ts |\n")).toEqual([
    { file: "a.test.ts", pattern: null },
    { file: "b.test.ts", pattern: "event stream" },
    { file: "c.test.ts", pattern: null },
  ]);
  expect(() => parseList("../x.ts\n")).toThrow(/not a test file name/);
});

test("every file rust/board/contract-files.txt lists exists in test/contract", () => {
  const list = parseList(readFileSync(join(REPO, "rust", "board", "contract-files.txt"), "utf8"));
  expect(list.length).toBeGreaterThan(0);
  for (const e of list) expect(existsSync(join(REPO, "test", "contract", e.file))).toBe(true);
});
