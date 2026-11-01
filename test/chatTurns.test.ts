import { expect, test } from "bun:test";
import { dividerLabel, layoutTurns, plainStep, shortStep, stepsSummary } from "../web/src/chatTurns";

const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 6, 0) + min * 60_000).toISOString();
const NOW = Date.UTC(2026, 9, 25, 8, 0);

test("layoutTurns: a new turn on speaker change, after a board note and after a 10 minute pause", () => {
  const l = layoutTurns([
    { speaker: "user", at: at(0) },
    { speaker: "claude", at: at(1), reply: true },
    { speaker: "claude", at: at(2) },
    { speaker: "claude", at: at(3), reply: true },
    { speaker: "board", at: at(4) },
    { speaker: "claude", at: at(5), reply: true },
    { speaker: "peer:t_1", at: at(6) },
    { speaker: "claude", at: at(7), reply: true },
    { speaker: "claude", at: at(20), reply: true },
  ], NOW);
  expect(l.map((x) => x.start)).toEqual([true, true, false, false, true, true, true, true, true]);
  // Only the turn's last reply keeps its actions on a phone.
  expect(l.map((x) => x.lastReply)).toEqual([false, false, false, true, false, true, false, true, true]);
});

test("layoutTurns: a time divider after an hour's pause or a day change, which also starts a new turn", () => {
  const l = layoutTurns([
    { speaker: "claude", at: at(0) },
    { speaker: "claude", at: at(30) },
    { speaker: "claude", at: at(95) },
    { speaker: "claude", at: "" },
  ], NOW);
  expect(l.map((x) => !!x.divider)).toEqual([false, false, true, false]);
  expect(l[2].start).toBe(true);
  expect(l[3].start).toBe(false);
  const days = layoutTurns([{ speaker: "user", at: "2026-10-24T22:00:00" }, { speaker: "user", at: "2026-10-25T00:10:00" }], NOW);
  expect(days[1].divider).toMatch(/^(Today|Yesterday|\w)/);
  expect(days[1].start).toBe(true);
});

test("dividerLabel: Today and Yesterday, else the date", () => {
  const now = new Date(2026, 9, 25, 15, 0).getTime();
  expect(dividerLabel(new Date(2026, 9, 25, 14, 5).toISOString(), now)).toStartWith("Today ");
  expect(dividerLabel(new Date(2026, 9, 24, 9, 12).toISOString(), now)).toStartWith("Yesterday ");
  expect(dividerLabel(new Date(2026, 9, 20, 21, 0).toISOString(), now)).not.toMatch(/Today|Yesterday/);
});

test("stepsSummary: running, done and failed steps", () => {
  const items = [{ text: "Read: a.ts" }, { text: "Bash: bun test", error: true as const }, { text: "Edit: b.ts" }];
  expect(stepsSummary(items, true)).toEqual({ text: "Step 3 · Edited b.ts", failed: 1 });
  expect(stepsSummary(items, false)).toEqual({ text: "Did 3 steps · Edited b.ts", failed: 1 });
  expect(stepsSummary([{ text: "Read: a.ts" }], false).text).toBe("Did 1 step · Read a.ts");
});

test("stepsSummary: the running step counts once and uses the live activity when there is one", () => {
  const items = [{ text: "Bash: gh workflow run release.yml" }, { text: "Bash: for i in 1 2" }, { text: "Bash: gh run view 4128 --log" }];
  expect(stepsSummary(items, true, "Running gh").text).toBe("Step 3 · Running gh");
  expect(stepsSummary(items, true, null).text).toBe("Step 3 · Ran a command");
  expect(stepsSummary(items, true, "").text).toBe("Step 3 · Ran a command");
  // Done: the plain name, never the live activity.
  expect(stepsSummary(items, false, "Running gh").text).toBe("Did 3 steps · Ran a command");
});

test("shortStep: a file tool's path becomes its file name; other steps stay as they are", () => {
  expect(shortStep("Read: /Users/leo/.claude-kanban/attachments/a8418c183597423b947f9bfe86c6a56c.png")).toBe("Read: a8418c183597423b947f9bfe86c6a56c.png");
  expect(shortStep("Edit: ~/dev/app/src/api.ts")).toBe("Edit: api.ts");
  expect(shortStep("Write: /tmp/out.md")).toBe("Write: out.md");
  expect(shortStep("Bash: ls /Users/leo/dev")).toBe("Bash: ls /Users/leo/dev");
  expect(shortStep("Grep: /api/attachments/")).toBe("Grep: /api/attachments/");
  expect(shortStep("Read: notes.md")).toBe("Read: notes.md");
  expect(stepsSummary([{ text: "Bash: ls" }, { text: "Read: /a/b/c.png" }], false).text).toBe("Did 2 steps · Read c.png");
});

test("plainStep: tool names become plain verbs for the summary line", () => {
  expect(plainStep("mcp__linear-server__get_document: abc")).toBe("Linear: read document");
  expect(plainStep("mcp__ckanban__ask_questions")).toBe("Board: ask questions");
  expect(plainStep("mcp__claude-in-chrome__navigate: https://x")).toBe("Chrome: navigate");
  expect(plainStep("mcp__claude_ai_Gmail__search_threads: q")).toBe("Gmail: search threads");
  expect(plainStep("ToolSearch: select:mcp__ckanban__ask_questions")).toBe("Got tools ready");
  expect(plainStep("Bash: git push origin HEAD:main")).toBe("Ran a command");
  expect(plainStep("Read: /Users/leo/dev/app/src/api.ts")).toBe("Read api.ts");
  expect(plainStep("WebSearch: bun release notes")).toBe("Searched the web for bun release notes");
  expect(plainStep("Thinking about it")).toBe("Thinking about it");
  // The summary never shows a raw tool name.
  for (const t of ["mcp__linear-server__get_document: x", "ToolSearch: select:mcp__a__b", "Bash: ls", "Grep: foo", "TodoWrite"]) {
    expect(stepsSummary([{ text: t }], false).text).not.toMatch(/mcp__|ToolSearch|Bash|Grep|TodoWrite/);
  }
});
