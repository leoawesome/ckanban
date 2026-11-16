# contracts/

What the ckanban daemon promises to the outside world: its web API, the files it keeps in the data folder and its
command line. The server is going to be ported to Rust piece by piece; each piece must answer the same API and read and
write the same files, so the web UI, the CLI, the MCP server and existing boards keep working unchanged.

These documents describe the server **as it behaves today** (v0.18.1). Where it does something odd, the document says
so (see the "Quirks" sections) instead of describing what it should do. When the behaviour changes on purpose, change
the document and the contract tests in the same commit.

## Files

| File | What it covers |
| --- | --- |
| `api.md` | Every route under `/api/`: method, path, query, body, answer, errors; grouped by feature. Also the Host/Origin rule, special headers, the event stream and the shell WebSocket. |
| `data-files.md` | Every file and folder under the data folder (`~/.claude-kanban`, or `$CKANBAN_HOME`): path, format, who writes it, an example. Says which files a port must keep byte-compatible and which are caches it may rebuild. |
| `cli.md` | Every `ckanban` command: arguments, output, exit codes, the routes it calls and the environment variables it reads. Also the `ckanban mcp` tools and the routes behind them. |
| `schemas/*.schema.json` | JSON Schema (draft 2020-12) for the main saved records: profile, ticket, ticket run log line and schedule. Unknown fields are allowed: a port must keep fields it doesn't know. |

The source of truth is still the code (`src/core/types.ts`, `src/api/server.ts`, `src/core/store.ts`,
`src/cli/cli.ts`, `src/cli/ticket-cli.ts`, `src/cli/client.ts`, `src/mcp/server.ts`). If a document and the code disagree, the
code wins and the document is the bug.

## Contract tests

`test/contract/` checks the contract from the outside only: it starts the daemon as its own process and then uses only
HTTP, the CLI and reading the data folder. The tests import nothing from `src/` or `web/`
(`test/contract/no-src-imports.test.ts` fails if one does), so the same tests can later check the Rust server.

- `daemon.ts` starts a daemon: a free port, a temp data folder (`CKANBAN_HOME`), a temp `HOME`, a temp Claude config
  folder, a temp plain project folder (no git), the fake Claude from `test/fixtures/fake-claude.ts`, and stub
  `osascript`, `caffeinate`, `open` and `tailscale` commands on `PATH` (no Mac banners, no keep-awake). It never touches
  the real `~/.claude-kanban` or the real repo. `DAEMON_CMD` and `CLI_CMD` at its top say what program is the server
  and the CLI; env vars `CKANBAN_CONTRACT_DAEMON` and `CKANBAN_CONTRACT_CLI` (each a JSON array of strings) override
  them, and bad JSON stops the run. The daemon gets the test's time zone (`TZ`), `CKANBAN_NO_KEYCHAIN=1` and a
  `CKANBAN_USAGE_URL` on a closed local port, so it never reaches the keychain or Anthropic.
- `files.ts` reads the data files (ticket front matter, JSONL) the way `data-files.md` describes them.
- `tickets.test.ts`: boards (create, list, read, errors, the Origin check, `ckanban profiles`); tickets over HTTP and
  the CLI (create, read, update, move between columns and to another board, list, delete, validation errors); the
  ticket chat (a message starts a run on the fake Claude; the conversation, the run log and `activity.jsonl` read back);
  comments and `comments.jsonl`.
- `schedules.test.ts`: create, list, pause, resume, history and delete a schedule, its `<id>.json` and
  `<id>.history.jsonl`, validation errors.
- `usage.test.ts`: `GET /api/usage` against a local fake of Anthropic's endpoint (first call, cache hits counted on
  the fake, `fresh=1`, the one-call-a-minute gap, Anthropic failing with and without saved numbers, a 429, no
  credentials) and `GET /api/spend` (an empty board; runs, side calls, huddle agents, quick chats and the helper).
- `callers.test.ts`: a board run (the fake Claude in `call` mode, calling the API without the run header) gets 403 on
  user-only routes while a program outside the board may delete a schedule; behind a front server its internal port
  refuses requests without the secret; the event stream delivers events while it stays open; the terminal's WebSocket.
- `mcp.test.ts`: `ckanban mcp` started as its own program (`mcp.ts`; `MCP_CMD` is the contract CLI plus `mcp`, and
  `CKANBAN_CONTRACT_MCP`, a JSON array, overrides it): the handshake and JSON-RPC errors, `tools/list` against the
  "Tool arguments" table in `cli.md` (names, order, argument names, types, required, enums, read-only hints), and calls
  into every tool group, checking the answer and its effect over HTTP. Calls "in a run" set `CKANBAN_TICKET` like the
  board does, to reach the run-only tools and the refusals a run gets. The daemon's `gh` is a stub that is never logged
  in, so `report_bug` never reaches GitHub.
- `mcp-parity.test.ts`: with `CKANBAN_PARITY_MCP` (a JSON array naming a port of the MCP server), Bun's `ckanban mcp`
  and the port run side by side against one daemon and must give the same answers: `initialize`, `tools/list` byte
  for byte, and about 100 calls across every group, in and outside a run, refusals and argument errors included (ids and
  times masked where each call creates its own). Skipped without it.
- `data-files.test.ts`: after a mix of actions, every file in the data folder matches a path listed in
  `data-files.md`, and the profile, ticket and schedule files hold the fields their schemas require.

Run them with `bun test test/contract` (each file starts its own daemon, about half a second); `bun run test` runs them
with everything else.

To test another server: build it and run
`CKANBAN_CONTRACT_DAEMON='["/path/to/server","dev"]' bun test test/contract` (add `CKANBAN_CONTRACT_CLI` if the CLI
moves too, and `CKANBAN_CONTRACT_MCP` for the MCP server). The server must take its port from `CKANBAN_PORT`, its data folder from `CKANBAN_HOME`, the Claude
program from `CKANBAN_CLAUDE_BIN`, the Claude config folder from `CLAUDE_CONFIG_DIR`, and honour `CKANBAN_USAGE_URL`
and `CKANBAN_NO_KEYCHAIN` (see "Plan usage" in `api.md`).

`bun run test:contract:rust` does this for the Rust front server (`rust/`): it builds `ckanban-rs` (release) and runs
every contract test with it as the daemon, and `ckanban-rs mcp` as the MCP server (`mcp.test.ts`, `mcp-parity.test.ts`). It needs cargo, so `bun run test` leaves it out.
