# mcp

`ckanban mcp`: the stdio MCP server that gives Claude Code and Codex the board as tools.
`server.ts` holds the JSON-RPC loop, `TOOLS` (the groups in a fixed order: it is what `toolsVersion()` fingerprints) and `callTool`.
One file per tool group (`ticket-tools`, `workflow-tools`, `family-tools`, `form-tools`, `connection-tools`, `huddle-tools`, `artifact-tools`, `schedule-tools`, `helper-tools`); `shared.ts` has the `ToolContext`, shared schemas and helpers.
Tools talk to the daemon only over HTTP, through `cli/client.ts`.
The Rust port (`ckanban-rs mcp`, `rust/src/mcp/`) lists the same tools from `rust/src/mcp/tools.json` and `tool-flags.json`: after changing a tool's name, description, input schema or flags, run `bun scripts/mcp-tools-json.ts` (`tools-json.test.ts` fails until you do). A changed answer text needs the same change in the Rust group file, or `bun run test:contract:rust` (the parity test) fails.
