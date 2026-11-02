/**
 * What every board run leaves out of Claude's context: built-in tools board runs never use, and the claude.ai
 * connectors its board turned off (board setting "claude.ai connectors for this board's runs").
 * Both are sent again on every turn, so each one cut makes every run cheaper.
 */

/**
 * Claude Code tools board runs never use. Workflow stays for ultracode runs (see runDisallowed). AskUserQuestion:
 * runs are headless, the board's prompts use ask_questions. Cron*, ScheduleWakeup: they stop with the run, the prompts
 * use follow_up. ReportFindings stays: the code-review skill huddle reviewers use needs it.
 */
export const UNUSED_TOOLS = ["Workflow", "ScheduleWakeup", "AskUserQuestion", "ShareOnboardingGuide", "CronCreate", "CronDelete", "CronList"] as const;

/** A run's --disallowedTools: its own list plus the unused tools, without repeats. Ultracode keeps Workflow. */
export function runDisallowed(own: readonly string[], ultracode = false): string[] {
  const unused = UNUSED_TOOLS.filter((t) => !(ultracode && t === "Workflow"));
  return [...new Set([...own, ...unused])];
}

/** "all" (the default), "none", or the connector names to keep ("Slack", without the "claude.ai " prefix). */
export type ClaudeAiConnectors = "all" | "none" | string[];

export const CLAUDE_AI_PREFIX = "claude.ai ";

/** "claude.ai Slack" and "Slack" both become "Slack". */
export const shortConnectorName = (name: string): string =>
  (name.startsWith(CLAUDE_AI_PREFIX) ? name.slice(CLAUDE_AI_PREFIX.length) : name).trim();

/** The board's setting; anything missing or unknown counts as "all" so nothing changes for boards that never set it. */
export function connectorSetting(p: { claudeAiConnectors?: unknown } | null | undefined): ClaudeAiConnectors {
  const v = p?.claudeAiConnectors;
  if (v === "none") return "none";
  if (Array.isArray(v)) return [...new Set(v.filter((x): x is string => typeof x === "string").map(shortConnectorName).filter(Boolean))];
  return "all";
}

/** Checks a PATCH value; null when it isn't one of the three forms. */
export function parseConnectorSetting(v: unknown): ClaudeAiConnectors | null {
  if (v === "all" || v === "none") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return connectorSetting({ claudeAiConnectors: v });
  return null;
}

/**
 * The tool name prefix Claude Code gives a connector's tools: "claude.ai Claude Docs" → "mcp__claude_ai_Claude_Docs"
 * (characters other than letters, digits, _ and - become _). As a --disallowedTools entry it hides all its tools.
 */
export function connectorToolPrefix(name: string): string {
  const full = name.startsWith(CLAUDE_AI_PREFIX) ? name : CLAUDE_AI_PREFIX + name;
  return `mcp__${full.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Turns every claude.ai connector off for one run. */
export const NO_CONNECTORS_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } as const;

/**
 * What a run adds for its board's setting. known: the account's claude.ai connector names as last listed (null: not
 * listed yet). A keep-list hides every other known connector; without a list to hide from, or with nothing to keep,
 * the run gets none, so the cheap setting never turns into "all".
 */
export function connectorRunOptions(setting: ClaudeAiConnectors, known: readonly string[] | null): { disallowed: string[]; env: Record<string, string> } {
  if (setting === "all") return { disallowed: [], env: {} };
  if (setting === "none" || !setting.length || !known?.length) return { disallowed: [], env: { ...NO_CONNECTORS_ENV } };
  const keep = new Set(setting.map(shortConnectorName));
  const knownShort = [...new Set(known.map(shortConnectorName))];
  if (!knownShort.some((n) => keep.has(n))) return { disallowed: [], env: { ...NO_CONNECTORS_ENV } };
  return { disallowed: knownShort.filter((n) => !keep.has(n)).map(connectorToolPrefix), env: {} };
}

/** The account's claude.ai connectors, as the Connections list last saw them (McpManager keeps this current). */
let known: string[] | null = null;
export const knownConnectors = (): string[] | null => known;
export function setKnownConnectors(names: readonly string[] | null) {
  known = names ? [...new Set(names.map(shortConnectorName))].sort() : null;
}

/** For a run of this board: extra --disallowedTools entries and environment. */
export const boardConnectorOptions = (p: { claudeAiConnectors?: unknown } | null | undefined) =>
  connectorRunOptions(connectorSetting(p), knownConnectors());
