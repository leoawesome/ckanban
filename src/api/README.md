# api

The daemon's web server: every `/api/...` route the board's pages, the CLI and the MCP tools call, plus the UI files.
`server.ts` (`createServer`) checks each request (local or phone access), then hands `/api/...` to the route files in order; each answers or returns `NEXT`.
`context.ts` starts the services once (sessions, scheduler, huddles, notifier ...) and holds the helpers several routes share (`view`, `profileOr404`, `runRights` ...).
One route file per area: `tickets*.ts` and `ticket-*.ts` for boards' tickets, `chats`, `schedules`, `huddles`, `huddle-config`, `notify`, `browsers`, `passes`, `connections`, `system` and the rest. `web-assets.gen.ts` is a stub that `scripts/build-bin.ts` fills for the binary.
Entry point layer: it may import any feature folder; nothing outside `api/` and `cli/` imports it.
