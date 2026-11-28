// A file asked for by name in the outputs folder (web/src/features/files/outputFind.ts): found where it really is, or
// reported missing, never swapped for another file.
import { expect, test } from "bun:test";
import { findOutput } from "./outputFind";

const names = new Set(["report.md", "header-a.html", "mockups/b.html", "notes/c.md"]);

test("the exact path wins", () => {
  expect(findOutput(names, "mockups/b.html")).toBe("mockups/b.html");
  expect(findOutput(names, "notes/c.md")).toBe("notes/c.md");
});

test("a mockup saved at the outputs root, and a bare name inside mockups/", () => {
  expect(findOutput(names, "mockups/header-a.html")).toBe("header-a.html");
  expect(findOutput(names, "b.html")).toBe("mockups/b.html");
});

test("a missing file is null, not another file", () => {
  expect(findOutput(names, "mockups/header-c.html")).toBeNull();
  expect(findOutput(names, "c.md")).toBeNull(); // only mockups/ is tried for a bare name
  expect(findOutput(new Set(), "report.md")).toBeNull();
});
