import { expect, test } from "bun:test";
import { filesByReply } from "../web/src/fileCards";

const e = (uuid: string, at: string, role: "user" | "assistant", kind = "text") => ({ uuid, at, role, kind, text: uuid });
const f = (name: string, updatedAt: string) => ({ name, size: 10, updatedAt });

test("output files go under the last reply of the turn they were written in", () => {
  const entries = [
    e("u1", "2026-10-06T10:00:00Z", "user"),
    e("a1", "2026-10-06T10:00:05Z", "assistant"),
    e("t1", "2026-10-06T10:00:06Z", "assistant", "tool"),
    e("a2", "2026-10-06T10:01:00Z", "assistant"),
    e("u2", "2026-10-06T11:00:00Z", "user"),
    e("a3", "2026-10-06T11:00:30Z", "assistant"),
  ];
  const cards = filesByReply(entries, [
    f("report.md", "2026-10-06T10:00:50Z"),
    f("b/data.csv", "2026-10-06T10:00:40Z"),
    f("later.md", "2026-10-06T11:00:20Z"),
    f("mockups/a-x.html", "2026-10-06T10:00:30Z"),
    f("old.md", "2026-10-05T10:00:00Z"),
  ]);
  expect(cards.get("a2")?.map((x) => x.name)).toEqual(["b/data.csv", "report.md"]);
  expect(cards.get("a3")?.map((x) => x.name)).toEqual(["later.md"]);
  expect(cards.has("a1")).toBe(false);
  expect([...cards.values()].flat().some((x) => x.name === "old.md" || x.name.startsWith("mockups/"))).toBe(false);
});

test("a turn without a reply yet gets no card", () => {
  const cards = filesByReply([e("a0", "2026-10-06T09:00:00Z", "assistant"), e("u1", "2026-10-06T10:00:00Z", "user")], [f("r.md", "2026-10-06T10:00:10Z")]);
  expect(cards.size).toBe(0);
});

test("many files under one reply stay fast", () => {
  const files = Array.from({ length: 50_000 }, (_, i) => f(`dir/${50_000 - i}.js`, "2026-10-06T10:00:10Z"));
  const start = performance.now();
  const cards = filesByReply([e("u1", "2026-10-06T10:00:00Z", "user"), e("a1", "2026-10-06T10:00:05Z", "assistant")], files);
  expect(cards.get("a1")?.length).toBe(50_000);
  expect(cards.get("a1")?.[0].name).toBe("dir/1.js");
  expect(performance.now() - start).toBeLessThan(2000);
});

test("a main ticket's status files never show under a reply (Where we are pins them)", async () => {
  const { STATUS_FILES } = await import("../web/src/fileCards");
  const entries = [e("u1", "2026-10-06T10:00:00Z", "user"), e("a1", "2026-10-06T10:00:05Z", "assistant")];
  const files = [f("status.json", "2026-10-06T10:00:02Z"), f("status.md", "2026-10-06T10:00:03Z"), f("plan.md", "2026-10-06T10:00:04Z")];
  expect(filesByReply(entries, files, STATUS_FILES).get("a1")?.map((x) => x.name)).toEqual(["plan.md"]);
  // Other tickets keep them: a status.md Claude wrote there is its own file.
  expect(filesByReply(entries, files).get("a1")?.map((x) => x.name)).toEqual(["plan.md", "status.json", "status.md"]);
});

test("a paused step's line says when it resumes", async () => {
  const { pausedLine } = await import("../web/src/limitText");
  const at = new Date(2026, 10, 6, 14, 30).toISOString();
  const now = new Date(2026, 10, 6, 12, 0).getTime();
  expect(pausedLine({ resumeAt: at, auto: true }, now)).toBe("Hit the usage limit, resumes at 14:30");
  expect(pausedLine({ resumeAt: at, auto: false }, now)).toBe("Hit the usage limit, resets at 14:30");
  expect(pausedLine({ resumeAt: null, auto: true }, now)).toBe("Hit the usage limit");
});
