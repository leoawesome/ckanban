# mcp

`ckanban mcp`: the stdio MCP server that gives Claude Code and Codex the board as tools.
`server.ts` holds the JSON-RPC loop, `TOOLS` (the groups in a fixed order: it is what `toolsVersion()` fingerprints) and `callTool`.
One file per tool group (`ticket-tools`, `workflow-tools`, `family-tools`, `form-tools`, `connection-tools`, `huddle-tools`, `artifact-tools`, `schedule-tools`, `helper-tools`); `shared.ts` has the `ToolContext`, shared schemas and helpers.
Tools talk to the daemon only over HTTP, through `cli/client.ts`.
