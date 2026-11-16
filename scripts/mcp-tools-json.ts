// Writes rust/src/mcp/tools.json from Bun's TOOLS (src/mcp/server.ts): exactly what `ckanban-rs mcp` answers to
// tools/list (names, descriptions, input schemas, read-only hints, in Bun's key order), and rust/src/mcp/tool-flags.json:
// what it checks before a call (changes, allowInRun, plannerScope).
// Run it after changing any tool: `bun scripts/mcp-tools-json.ts`. src/mcp/tools-json.test.ts fails while the file is stale.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "../src/mcp/server";

const DIR = join(import.meta.dir, "..", "rust", "src", "mcp");
export const TOOLS_JSON = join(DIR, "tools.json");
export const FLAGS_JSON = join(DIR, "tool-flags.json");

/** tools.json: the tools/list array as Bun's handleMessage builds it, one tool per line. */
export function toolsJson(): string {
  const rows = TOOLS.map(({ name, description, inputSchema, annotations }) => JSON.stringify({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }));
  return `[\n${rows.join(",\n")}\n]\n`;
}

/** tool-flags.json: per tool, in the same order. */
export function flagsJson(): string {
  const rows = TOOLS.map((t) => JSON.stringify({ name: t.name, changes: t.changes, allowInRun: t.allowInRun === true, plannerScope: t.plannerScope === true }));
  return `[\n${rows.join(",\n")}\n]\n`;
}

if (import.meta.main) {
  writeFileSync(TOOLS_JSON, toolsJson());
  writeFileSync(FLAGS_JSON, flagsJson());
  console.log(`Wrote ${TOOLS.length} tools to ${TOOLS_JSON} and ${FLAGS_JSON}`);
}
