import { expect, test } from "bun:test";
import { checkedText, chipText, contextRows, phoneRows, shortPath, tokenText, type ContextCategory, type ContextReport } from "./contextText";

// The server is the Rust binary now, so these are the parsed reports of test/fixtures/context/long-chat.md and
// unknown-row.md as the old Bun parser returned them (the lists the UI's rows are built from).
const cat = (name: string, tokens: number, percent: number | null, deferred = false): ContextCategory => ({ name, tokens, percent, deferred });
const REPORTS: Record<string, ContextReport> = {
  "long-chat.md": {
    model: "claude-sonnet-5-5", used: 154_200, window: 1_000_000, percent: 15, mcpServers: [], builtinTools: [], memoryFiles: [], skills: [],
    categories: [
      cat("System prompt", 10_500, 1.1), cat("System tools", 21_700, 2.2), cat("MCP tools", 21_100, 2.1), cat("MCP server instructions", 201, 0),
      cat("MCP tools (deferred)", 257_800, 25.8, true), cat("System tools (deferred)", 29_300, 2.9, true), cat("Memory files", 2200, 0.2),
      cat("Skills", 6100, 0.6), cat("Messages", 92_100, 9.2), cat("Free space", 813_000, 81.3), cat("Autocompact buffer", 33_000, 3.3),
    ],
  },
  "unknown-row.md": {
    model: "claude-opus-5-5", used: 1_200_000, window: 2_000_000, percent: 60, mcpServers: [], builtinTools: [], memoryFiles: [], skills: [],
    categories: [cat("System prompt", 2500, 0.1), cat("Messages", 1_100_000, 55), cat("Plugin hooks", 4321, 0.2), cat("Free space", 767_000, 38.4)],
  },
};
const report = (name: string) => REPORTS[name];

test("rows get plain names, the original term in the hover text, and on-demand rows last with no percent", () => {
  const rows = contextRows(report("long-chat.md").categories);
  expect(rows.map((r) => r.label)).toEqual(["Messages", "Built-in tools", "Connected app tools", "System prompt", "Skills", "Memory files",
    "Connected app instructions", "Room to summarise", "Free space", "Connected app tools (on demand)", "Built-in tools (on demand)"]);
  const room = rows.find((r) => r.label === "Room to summarise")!;
  expect(room.title).toBe("Autocompact buffer: Kept free so the chat can be summarised when it gets long");
  expect(rows.find((r) => r.label === "Built-in tools")!.title.startsWith("System tools:")).toBe(true);
  expect(rows.filter((r) => r.deferred).map((r) => r.percent)).toEqual([null, null]);
});

test("an unknown row keeps its own label", () => {
  const rows = contextRows(report("unknown-row.md").categories);
  expect(rows.map((r) => r.label)).toEqual(["Messages", "System prompt", "Plugin hooks", "Free space"]);
});

test("the phone merges skills, memory and app instructions, and the on-demand rows", () => {
  const rows = phoneRows(contextRows(report("long-chat.md").categories));
  expect(rows.map((r) => r.label)).toEqual(["Messages", "Built-in tools", "Connected app tools", "System prompt", "Skills, memory, app instructions",
    "Room to summarise", "Free space", "On-demand tools"]);
  const small = rows.find((r) => r.key === "small")!;
  expect([small.tokens, small.percent]).toEqual([6100 + 2200 + 201, 0.8]);
  expect(rows.at(-1)!.tokens).toBe(257_800 + 29_300);
  expect(rows.at(-1)!.percent).toBeNull();
});

test("chip, token and time words", () => {
  expect(chipText(null)).toBe("Context");
  expect(chipText({ state: "idle", result: null, error: "x" })).toBe("Context");
  expect(chipText({ state: "idle", result: { report: report("long-chat.md"), checkedAt: "" }, error: null })).toBe("15%");
  expect([tokenText(154_200), tokenText(1_000_000), tokenText(92_100), tokenText(201), tokenText(1_500_000)]).toEqual(["154k", "1M", "92.1k", "201", "1.5M"]);
  const now = Date.parse("2026-11-11T10:00:00Z");
  expect(checkedText("2026-11-11T09:58:00Z", now)).toBe("Checked 2 min ago");
  expect(checkedText("2026-11-11T09:59:30Z", now)).toBe("Checked just now");
  expect(shortPath("/Users/me/.claude/CLAUDE.md")).toBe("~/.claude/CLAUDE.md");
});
