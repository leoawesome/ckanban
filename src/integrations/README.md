# integrations

How the board reaches outside services and tools. Claude's MCP servers and their logins (`mcp.ts`, `mcp-client.ts`, `stdio-client.ts`, `oauth.ts`), each board's own tools (`board-tools.ts`), the board's passes for services it calls without Claude (`passes.ts`, `types.ts`), saved keys (`ask-keys.ts`, `board-keys.ts`, `file-backup.ts`), and registering `ckanban mcp` with Claude Code and Codex (`agents.ts`).
Automation parts: check scripts (`script.ts`), the "ask Claude first" filter (`ask-claude.ts`), fencing copied text in tickets (`ticket-text.ts`) and the check that saving an automation or pass comes from the user (`guard.ts`).
Also here: phone access over Tailscale (`remote.ts`) and bug reports to GitHub (`bugreport.ts`).
Tests sit next to the code (`*.test.ts`); tests that boot the server are in `test/`.
