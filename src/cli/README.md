# cli

The `ckanban` command: `cli.ts` (commands: dev, start, install, restart, ticket, mcp, call ...), `ticket-cli.ts`, the HTTP `client.ts` the CLI and MCP tools use, `daemon.ts` (what `ckanban start`/`dev` runs), `launchd.ts`, `uninstall-extras.ts` and `checksum.ts`.
`src/cli.ts` stays as the public entry (it only imports `cli/cli.ts`): docs, `package.json`, installed launchd plists and MCP configs run `bun src/cli.ts`.
Top layer: it may import every folder; only `api/`, `mcp/` and `browser/browser-mcp.ts` import from here (the client).
