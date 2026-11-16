// rust/src/mcp/tools.json and tool-flags.json are what `ckanban-rs mcp` lists: they must match Bun's TOOLS exactly.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FLAGS_JSON, flagsJson, TOOLS_JSON, toolsJson } from "../../scripts/mcp-tools-json";

test("rust/src/mcp/tools.json and tool-flags.json match TOOLS (run `bun scripts/mcp-tools-json.ts` after changing a tool)", () => {
  expect(readFileSync(TOOLS_JSON, "utf8")).toBe(toolsJson());
  expect(readFileSync(FLAGS_JSON, "utf8")).toBe(flagsJson());
});
