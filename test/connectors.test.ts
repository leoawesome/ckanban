import { afterEach, expect, test } from "bun:test";
import {
  connectorRunOptions, connectorSetting, connectorToolPrefix, parseConnectorSetting, runDisallowed, setKnownConnectors,
  boardConnectorOptions, UNUSED_TOOLS,
} from "../src/server/connectors";
import { buildArgs, PLANNING_DISALLOWED_TOOLS } from "../src/server/runner";

const off = (args: string[]) => args[args.indexOf("--disallowedTools") + 1].split(",");
const KNOWN = ["claude.ai Claude Docs", "claude.ai Gmail", "claude.ai Slack", "claude.ai Custom MCP (Notion, Google Sheets etc.)"];

afterEach(() => setKnownConnectors(null));

test("every run leaves out the unused tools, ultracode keeps Workflow", () => {
  expect(off(buildArgs("u1", false, null))).toEqual([...UNUSED_TOOLS]);
  expect(UNUSED_TOOLS).toHaveLength(7);
  expect(UNUSED_TOOLS).not.toContain("ReportFindings" as any);
  const ultra = off(buildArgs("u1", false, null, [], undefined, undefined, null, null, true));
  expect(ultra).not.toContain("Workflow");
  expect(ultra).toContain("ScheduleWakeup");
});

test("a run's own list adds to the unused tools, without repeats", () => {
  const planning = off(buildArgs("u1", false, null, PLANNING_DISALLOWED_TOOLS));
  for (const t of [...PLANNING_DISALLOWED_TOOLS, ...UNUSED_TOOLS]) expect(planning).toContain(t);
  expect(new Set(planning).size).toBe(planning.length);
  // Naming an unused tool itself can't bring it back, even with ultracode on.
  expect(runDisallowed(["Workflow", "Edit", "Edit"], true)).toEqual(["Workflow", "Edit", ...UNUSED_TOOLS.filter((t) => t !== "Workflow")]);
});

test("a missing or unknown setting counts as all", () => {
  expect(connectorSetting(undefined)).toBe("all");
  expect(connectorSetting({})).toBe("all");
  expect(connectorSetting({ claudeAiConnectors: "some" })).toBe("all");
  expect(connectorSetting({ claudeAiConnectors: 3 })).toBe("all");
  expect(connectorSetting({ claudeAiConnectors: ["claude.ai Slack", "Slack", " "] })).toEqual(["Slack"]);
  expect(parseConnectorSetting("all")).toBe("all");
  expect(parseConnectorSetting(["Slack"])).toEqual(["Slack"]);
  expect(parseConnectorSetting("some")).toBeNull();
  expect(parseConnectorSetting([1])).toBeNull();
});

test("tool prefixes follow Claude Code's server name rule", () => {
  expect(connectorToolPrefix("claude.ai Claude Docs")).toBe("mcp__claude_ai_Claude_Docs");
  expect(connectorToolPrefix("Slack")).toBe("mcp__claude_ai_Slack");
  expect(connectorToolPrefix("Custom MCP (Notion, Google Sheets etc.)")).toBe("mcp__claude_ai_Custom_MCP__Notion__Google_Sheets_etc__");
});

test("run options for all, none, an empty keep-list and a keep-list", () => {
  expect(connectorRunOptions("all", KNOWN)).toEqual({ disallowed: [], env: {} });
  expect(connectorRunOptions("none", KNOWN)).toEqual({ disallowed: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
  expect(connectorRunOptions([], KNOWN)).toEqual({ disallowed: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
  expect(connectorRunOptions(["Slack"], KNOWN)).toEqual({
    disallowed: ["mcp__claude_ai_Claude_Docs", "mcp__claude_ai_Gmail", "mcp__claude_ai_Custom_MCP__Notion__Google_Sheets_etc__"], env: {},
  });
  // Kept connectors the account no longer has: nothing to keep, so none.
  expect(connectorRunOptions(["Linear"], KNOWN).env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
});

test("a keep-list without a connector list runs with none", () => {
  expect(connectorRunOptions(["Slack"], null)).toEqual({ disallowed: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
  expect(connectorRunOptions(["Slack"], [])).toEqual({ disallowed: [], env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
  expect(boardConnectorOptions({ claudeAiConnectors: ["Slack"] }).env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" });
  setKnownConnectors(KNOWN);
  expect(boardConnectorOptions({ claudeAiConnectors: ["Slack"] }).disallowed).toContain("mcp__claude_ai_Gmail");
  expect(boardConnectorOptions({}).env).toEqual({});
});
