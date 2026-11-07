// A feature's "Saved changes": the board lists the version history entries that carry the feature's line (newest
// first), or the files its tickets changed in a folder without history; sections Claude writes say where they were cut.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch, CUT_SHORT, clipText, readStatus, STATUS_FIELD_MAX, statusFacts, statusFiles, statusMarkdown, statusSections } from "../src/server/feature";
import { run } from "../src/server/git";
import { featureMemberNote, featureTrailerRule } from "../src/server/prompts";
import { board, setup, store, useBoardEnv } from "./board-env";
import { tempDir, until } from "./helpers";

useBoardEnv();

const mk = (title: string, extra: Record<string, unknown> = {}) =>
  board.createTicket("p", { title, body: "", status: "backlog", mode: "auto", ...extra } as any);

async function commit(dir: string, file: string, ...message: string[]) {
  writeFileSync(join(dir, file), `${file}\n`);
  await run(["git", "add", "."], dir);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", ...message.flatMap((m) => ["-m", m])], dir);
}

test("clipText cuts at a word break and says it was cut short", () => {
  expect(clipText("short", 100)).toBe("short");
  const long = "word ".repeat(600).trim();
  const cut = clipText(long, STATUS_FIELD_MAX);
  expect(cut.length).toBeLessThanOrEqual(STATUS_FIELD_MAX);
  expect(cut.endsWith(`word${CUT_SHORT}`)).toBe(true);
});

test("update_status keeps a long section with a cut short mark; an old one cut at the limit gets the mark when read", () => {
  const saved = applyPatch(null, { done: `${"a, ".repeat(1000)}end` }, "2026-11-08T00:00:00Z", "");
  expect(saved.done!.length).toBeLessThanOrEqual(STATUS_FIELD_MAX);
  expect(saved.done!.endsWith(CUT_SHORT)).toBe(true);
  expect(saved.done).not.toMatch(/,…/);
  const dir = tempDir("ck-status-");
  writeFileSync(statusFiles(dir).json, JSON.stringify({ updatedAt: "x", done: `${"93ad01a (the main chat sho".repeat(100)}`.slice(0, STATUS_FIELD_MAX), goal: "Short." }));
  const read = readStatus(dir)!;
  expect(read.done!.endsWith(CUT_SHORT)).toBe(true);
  expect(read.goal).toBe("Short.");
});

test("the Saved changes section shows the first 30 and says how many more and where the full list is", () => {
  const items = Array.from({ length: 35 }, (_, i) => ({ id: `abc${i}`, text: `change ${i}` }));
  const f = { ...statusFacts([], "x", () => false), changes: { kind: "history" as const, items, file: "/o/saved-changes.md" } };
  const s = statusSections(null, f).find((x) => x.key === "changes")!;
  expect(s.label).toBe("Saved changes (newest first; undo in this order)");
  const lines = s.text.split("\n");
  expect(lines).toHaveLength(31);
  expect(lines[0]).toBe("abc0 change 0");
  expect(lines[30]).toBe("…and 5 more: the full list is in /o/saved-changes.md");
  expect(statusMarkdown({ id: "x", title: "X" }, null, f)).toContain("- abc0 change 0");
});

test("every run in a feature is told to end its commits with the feature's line", () => {
  expect(featureTrailerRule("t_1")).toContain("`Ckanban-Feature: t_1`");
  expect(featureMemberNote({ id: "t_1", title: "F" }, "/s.md")).toContain("Ckanban-Feature: t_1");
});

test("the board lists the feature's saved changes from the version history, newest first", async () => {
  const p = await setup();
  const top = await mk("Feature");
  await mk("Step one", { partOf: top.id });
  await mk("Step two", { partOf: top.id });
  await commit(p.path, "a.txt", "fix: first", `Ckanban-Feature: ${top.id}`);
  await commit(p.path, "b.txt", "chore: other work");
  await commit(p.path, "c.txt", "fix: other feature", "Ckanban-Feature: t_other");
  await commit(p.path, "d.txt", "feat: second", `Co-Authored-By: X <x@y>\nCkanban-Feature: ${top.id}`);
  board.featureStatus("p", top.id);
  await until(() => !!board.featureStatus("p", top.id).facts.changes);
  const c = board.featureStatus("p", top.id).facts.changes!;
  expect(c.kind).toBe("history");
  expect(c.items.map((i) => i.text)).toEqual(["feat: second", "fix: first"]);
  expect(c.items[0]!.id).toMatch(/^[0-9a-f]{7,}$/);
  await until(() => readFileSync(statusFiles(store.outputsDir("p", top.id)).md, "utf8").includes("feat: second"));
  expect(store.getTicket("p", top.id)!.statusAt).toBeTruthy();
}, 60_000);

test("a feature in a folder without version history lists the files its tickets changed, and never fails", async () => {
  const p = await setup({ git: false });
  const top = await mk("Feature");
  const s1 = await mk("Step one", { partOf: top.id });
  await mk("Step two", { partOf: top.id });
  store.appendActivity("p", s1.id, 1, { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(p.path, "notes", "plan.md") } }] } });
  board.featureStatus("p", top.id);
  await until(() => !!board.featureStatus("p", top.id).facts.changes);
  const c = board.featureStatus("p", top.id).facts.changes!;
  expect(c).toEqual({ kind: "files", items: [{ text: "notes/plan.md" }] });
  expect(statusSections(null, board.featureStatus("p", top.id).facts).find((x) => x.key === "changes")!.label).toBe("Files changed in your folder");
}, 60_000);
