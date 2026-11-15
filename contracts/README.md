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

The source of truth is still the code (`src/server/types.ts`, `src/server/http.ts`, `src/server/store.ts`,
`src/cli.ts`, `src/ticket-cli.ts`, `src/client.ts`, `src/mcp-server.ts`). If a document and the code disagree, the
code wins and the document is the bug.

## Contract tests

`test/contract/` checks the contract from the outside only: it starts the daemon as its own process and then uses only
HTTP, the CLI and reading the data folder. The tests import nothing from `src/` or `web/`
(`test/contract/no-src-imports.test.ts` fails if one does), so the same tests can later check the Rust server.

- `daemon.ts` starts a daemon: a free port, a temp data folder (`CKANBAN_HOME`), a temp `HOME`, a temp Claude config
  folder, a temp plain project folder (no git), the fake Claude from `test/fixtures/fake-claude.ts`, and stub
  `osascript`, `caffeinate`, `open` and `tailscale` commands on `PATH` (no Mac banners, no keep-awake). It never touches
  the real `~/.claude-kanban` or the real repo. `DAEMON_CMD` and `CLI_CMD` at its top are the only lines that say what
  program is the server and the CLI: point them at another build to test it.
- `files.ts` reads the data files (ticket front matter, JSONL) the way `data-files.md` describes them.
- `tickets.test.ts`: boards (create, list, read, errors, the Origin check, `ckanban profiles`); tickets over HTTP and
  the CLI (create, read, update, move between columns and to another board, list, delete, validation errors); the
  ticket chat (a message starts a run on the fake Claude; the conversation, the run log and `activity.jsonl` read back);
  comments and `comments.jsonl`.
- `schedules.test.ts`: create, list, pause, resume, history and delete a schedule, its `<id>.json` and
  `<id>.history.jsonl`, validation errors.
- `data-files.test.ts`: after a mix of actions, every file in the data folder matches a path listed in
  `data-files.md`, and the profile, ticket and schedule files hold the fields their schemas require.

Run them with `bun test test/contract` (each file starts its own daemon, about half a second); `bun run test` runs them
with everything else.

To test another server: build it, set `DAEMON_CMD` (and `CLI_CMD` if the CLI moves too) in `test/contract/daemon.ts`,
and run `bun test test/contract`. The server must take its port from `CKANBAN_PORT`, its data folder from
`CKANBAN_HOME` and the Claude program from `CKANBAN_CLAUDE_BIN`.
