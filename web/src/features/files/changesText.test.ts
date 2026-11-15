import { expect, test } from "bun:test";
import { comparedWith, fileCount, showTree, TREE_ABOVE } from "../web/src/changesText";
import { rosterNames } from "../web/src/huddleText";

test("Changes lists files plainly up to 8 and groups them by folder above that", () => {
  expect(TREE_ABOVE).toBe(8);
  expect(showTree(0)).toBe(false);
  expect(showTree(8)).toBe(false);
  expect(showTree(9)).toBe(true);
});

test("Changes bar counts files in plain words", () => {
  expect(fileCount(1)).toBe("1 file");
  expect(fileCount(3)).toBe("3 files");
  expect(fileCount(0)).toBe("0 files");
});

test("the count's tooltip says what the changes are compared with, then the version names", () => {
  expect(comparedWith({ base: "origin/main", branch: "ck/t_1" }, false)).toBe("Compared with the main version.\norigin/main · ck/t_1");
  expect(comparedWith({ base: "origin/main", branch: null, startedFrom: "ck/t_0" }, false))
    .toBe("Compared with the version this ticket's work started from (ck/t_0).\norigin/main");
  const folder = comparedWith({ base: "abc123" }, true);
  expect(folder.startsWith("Compared with this ticket's start")).toBe(true);
  expect(folder.endsWith("\nabc123")).toBe(true);
});

test("the huddle proposal line names its roster in a few words", () => {
  expect(rosterNames([{ preset: "reviewer" }, { preset: "security" }, { preset: "qa" }])).toBe("reviewer, security, QA");
  expect(rosterNames([{ preset: "qa", count: 2 }, { role: "Copy editor" }, { handle: "ux", preset: "designer" }])).toBe("2× QA, Copy editor, UX");
  expect(rosterNames([{ role: "  " }])).toBe("custom role");
  expect(rosterNames([])).toBe("");
});
