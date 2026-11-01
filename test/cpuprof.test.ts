import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { hottest, profileFor } from "../src/server/cpuprof";
import { tempDir } from "./helpers";

test("hottest: self and total time by function", () => {
  const nodes = [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, hitCount: 0, children: [2] },
    { id: 2, callFrame: { functionName: "outer", url: "/x/src/server/a.ts", lineNumber: 9 }, hitCount: 1, children: [3] },
    { id: 3, callFrame: { functionName: "inner", url: "/x/src/server/b.ts", lineNumber: 4 }, hitCount: 3 },
  ];
  expect(hottest(nodes, 4, 40)).toEqual([
    { fn: "inner", where: "src/server/b.ts:5", selfMs: 30, totalMs: 30 },
    { fn: "outer", where: "src/server/a.ts:10", selfMs: 10, totalMs: 40 },
  ]);
});

test("profileFor writes a profile file", async () => {
  const dir = tempDir();
  const r = await profileFor(1, dir);
  expect(existsSync(r.file)).toBe(true);
  expect(Array.isArray(r.hot)).toBe(true);
});
