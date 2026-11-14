import { expect, test } from "bun:test";
import { fileFinder } from "../web/src/fileLinkContext";
import { codePath, textPaths } from "../web/src/filePaths";

test("codePath takes relative, absolute and home paths", () => {
  expect(codePath("applications/sierra/swe-agent/review-for-leo.md")).toBe("applications/sierra/swe-agent/review-for-leo.md");
  expect(codePath("/Users/leo/notes/a.txt")).toBe("/Users/leo/notes/a.txt");
  expect(codePath("~/docs/plan.md")).toBe("~/docs/plan.md");
  expect(codePath("./README.md")).toBe("./README.md");
  expect(codePath("README.md")).toBe("README.md");
  expect(codePath("web/src/Transcript.tsx")).toBe("web/src/Transcript.tsx");
});

test("codePath joins a path wrapped across lines inside the backticks", () => {
  expect(codePath("applications/sierra/swe-\nagent-mandarin/review-for-\nleo.md")).toBe("applications/sierra/swe-agent-mandarin/review-for-leo.md");
  expect(codePath("docs/\n  plan.md")).toBe("docs/plan.md");
});

test("codePath skips commands, urls, flags and plain words", () => {
  expect(codePath("bun run test")).toBeNull();
  expect(codePath("https://example.com/a.md")).toBeNull();
  expect(codePath("--no-verify")).toBeNull();
  expect(codePath("useState")).toBeNull();
  expect(codePath("src/")).toBeNull();
  expect(codePath("..")).toBeNull();
  expect(codePath("")).toBeNull();
});

test("textPaths finds paths in prose, not urls or trailing dots", () => {
  expect(textPaths("Please read applications/sierra/review.md. It lists the form.")).toEqual([{ at: 12, path: "applications/sierra/review.md" }]);
  expect(textPaths("Saved to /Users/leo/out/report.pdf and ~/x/y.json")).toEqual([
    { at: 9, path: "/Users/leo/out/report.pdf" },
    { at: 39, path: "~/x/y.json" },
  ]);
  expect(textPaths("See https://example.com/docs/a.html for more")).toEqual([]);
  expect(textPaths("and/or the plan.md file")).toEqual([]);
  expect(textPaths("no paths here")).toEqual([]);
});

test("fileFinder remembers found paths and rechecks missing ones after a while", async () => {
  let clock = 0;
  const asked: string[][] = [];
  const exists = new Set(["a.md"]);
  const find = fileFinder(async (paths) => { asked.push(paths); return paths.filter((p) => exists.has(p)); }, () => clock);
  expect([...await find(["a.md", "b.md"])]).toEqual(["a.md"]);
  expect([...await find(["a.md", "b.md"])]).toEqual(["a.md"]);
  expect(asked).toEqual([["a.md", "b.md"]]);
  exists.add("b.md");
  clock = 20_000;
  expect([...await find(["a.md", "b.md"])]).toEqual(["a.md", "b.md"]);
  expect(asked[1]).toEqual(["b.md"]);
});

test("fileFinder: calls made together share one request, and a path on its way is not asked twice", async () => {
  const asked: string[][] = [];
  const find = fileFinder(async (paths) => { asked.push(paths); return paths.filter((p) => p !== "b.md"); });
  const [one, two] = await Promise.all([find(["a.md", "b.md"]), find(["b.md", "c.md"])]);
  expect([...one]).toEqual(["a.md"]);
  expect([...two]).toEqual(["c.md"]);
  expect(asked).toEqual([["a.md", "b.md", "c.md"]]);
  // Later calls start a new batch; the answers are remembered.
  expect([...await find(["c.md", "d.md"])]).toEqual(["c.md", "d.md"]);
  expect(asked[1]).toEqual(["d.md"]);
});

test("fileFinder: more paths than one request takes go in chunks, and all of them can be found", async () => {
  const asked: string[][] = [];
  const find = fileFinder(async (paths) => { asked.push(paths); return paths.slice(0, 200).filter((p) => p.startsWith("y")); });
  const paths = Array.from({ length: 450 }, (_, i) => `${i % 2 ? "y" : "n"}${i}.md`);
  const hit = await find(paths);
  expect(asked.map((a) => a.length)).toEqual([200, 200, 50]);
  expect(hit.size).toBe(225);
  // Nothing marked missing without an answer: a failed chunk is asked again next time.
  let fail = true;
  const asked2: string[][] = [];
  const find2 = fileFinder(async (p) => { asked2.push(p); if (fail && p[0] === "y200.md") throw new Error("down"); return p; });
  const all = Array.from({ length: 250 }, (_, i) => `y${i}.md`);
  expect((await find2(all)).size).toBe(200);
  fail = false;
  expect((await find2(all)).size).toBe(250);
  expect(asked2[2]).toEqual(all.slice(200));
});
