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
| `schemas/*.schema.json` | JSON Schema (draft 2020-12) for every saved JSON file and JSONL line in the data folder (`data-files.md`, "Schemas and checks", lists which file uses which). Unknown fields are allowed: a port must keep fields it doesn't know, except where `data-files.md` says the Bun daemon drops them. |

The source of truth is still the code (`src/core/types.ts`, `src/api/server.ts`, `src/core/store.ts`,
`src/cli/cli.ts`, `src/cli/ticket-cli.ts`, `src/cli/client.ts`, `src/mcp/server.ts`). If a document and the code disagree, the
code wins and the document is the bug.

## Contract tests

`test/contract/` checks the contract from the outside only: it starts the daemon as its own process and then uses only
HTTP, the CLI and reading the data folder. The tests import nothing from `src/` or `web/`
(`test/contract/no-src-imports.test.ts` fails if one does), so the same tests can later check the Rust server.

- `daemon.ts` starts a daemon: a free port, a temp data folder (`CKANBAN_HOME`), a temp `HOME`, a temp Claude config
  folder, a temp plain project folder (no git), the fake Claude from `test/fixtures/fake-claude.ts`, and stub
  `osascript`, `caffeinate`, `open` and `tailscale` commands on `PATH` (no Mac banners, no keep-awake); a test can add
  its own (`stubs`, e.g. a `gh` that records its arguments). It never touches
  the real `~/.claude-kanban` or the real repo. `DAEMON_CMD` and `CLI_CMD` at its top say what program is the server
  and the CLI; env vars `CKANBAN_CONTRACT_DAEMON` and `CKANBAN_CONTRACT_CLI` (each a JSON array of strings) override
  them, and bad JSON stops the run. The daemon gets the test's time zone (`TZ`), `CKANBAN_NO_KEYCHAIN=1` and a
  `CKANBAN_USAGE_URL` on a closed local port, so it never reaches the keychain or Anthropic.
- `files.ts` reads the data files (ticket front matter, JSONL) the way `data-files.md` describes them.
- `schema.ts` checks a value against a schema in `contracts/schemas/` (the keywords those schemas use, no package);
  `schema.test.ts` checks the checker and that every schema uses only keywords it knows.
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
- `connections.test.ts`: MCP servers in the Connections window: add, read settings, edit, recheck, sign-in errors and
  remove a user-wide server (against `fake-claude-mcp.ts`, a fake of `claude mcp`), a board-only tool and its
  `board-tools.json` (owner-only), moving it to all projects and back, validation, the missing user check (a quirk);
  registering `ckanban mcp` with Codex and Claude Code.
- `remote.test.ts`: phone access: `GET /api/remote` off and saved-but-off, the refusals of `POST /api/remote`, and the
  phone access listener's checks (off, Host, Tailscale login, Origin, its header, the user check, the known hole as a
  quirk). It writes `remote.json` itself and never lets the daemon run Tailscale (the daemon prefers the Tailscale
  app's own binary over the PATH stub). `phone.ts` makes requests as the owner's phone.
- `passes.test.ts`: passes (user only, so made from the phone listener): keys for automations and for one board,
  `automation-passes.json` (owner-only), replace, remove, an online service that can't be signed in to, the sign-in
  callback; the ask_keys box (`key-cards`) and the next run getting the key as an environment variable; saved values
  masked in every answer and in comments; check scripts (`loops/test`, `automation-call`); `backup_file` through
  `ckanban mcp` and `.key-backups`; bug reports through a stub `gh`.
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
- `data-files.test.ts`: after a mix of actions (tickets, chats, side calls, schedules, jobs, automations, quick
  chats, huddles, settings, plan usage), every file in the data folder matches a path listed in `data-files.md`, and
  every saved file with a schema matches it and is written in its documented style. User-only actions go through the
  phone access listener (`remote.json` seeded as on); `FAKE_SIDE_JSON` lets the fake Claude answer side calls.
- `cli-support.ts`: the CLI sandbox (temp `HOME`, `CKANBAN_HOME`, Claude and Codex config folders; stub `launchctl`,
  `open`, `claude`, `osascript`, `tailscale` first on a `PATH` of only `/usr/bin:/bin` besides; each stub logs its
  calls) and a fake board server that records every request (method, path, headers, body) and answers as a test says.
  `contractBlock()` reads a fenced block from `cli.md`, so tests compare output with the contract's own text.
- `cli-daemon.test.ts`: usage text, version, `install` (the plist byte for byte, the `launchctl` calls, bootstrap
  failing), `restart` (each answer, `--now`, not installed, kickstart failing), `uninstall`, `open`, `update` from
  source, `remote status`, `mcp install|uninstall|status` (the `claude` calls, the Codex `config.toml` block), usage
  errors of `artifact` and `browser-mcp`, and `start`. Tests that reach `launchctl` first check that `PATH` finds the stub.
- `cli-board.test.ts`: against the fake board: picking the board, the read-only rule in runs, `ticket chat|comment|stop|
  delete|setup|take-device|release-device|report-bug`, the routes, query strings and bodies of `list|show|create|update`,
  argument errors, HTTP errors and identity headers, `call`, and the stdio `ckanban mcp` protocol (the tool list
  against `cli.md` section 6).
- `chat.test.ts`: the ticket chat beyond one message: questions forms (the `ask_questions` tool and the older
  `<ckanban-questions>` block, a broken block), answers (one run for the same answer twice), Close question, proposals
  (`propose_ticket`) and Apply, follow-up work, mockup blocks saved to `outputs/mockups`, a message that steers a working
  run, `draft` events, the `/` commands (list, `/model`, `/effort`, refused ones, a project command) and the Planning
  chat's tool limits. The fake Claude's `FAKE_PLAN_FILE` makes a turn call tools or add text when its message holds a
  marker.
- `chat-session.test.ts`: conversation paging, tool, agent and workflow details, simplify and "help me understand"
  (`FAKE_SIDE_JSON`), context, the usage summary, rewind with its preview and undo, and fork (`FAKE_UUIDS` gives the
  fake Claude's transcript lines uuids, as the real CLI's).
- `quickchat.test.ts`: every quick chat route (start, list pages, read, reply, rename, context, stop, make ticket,
  conversation, simplify, rewind, undo, fork, delete), its user-only checks, `chat.draft`, `chat.updated` and
  `chat.activity` events and its files; chat search and read and who may reach which chat.
- `huddle.test.ts`: teammates and squads (files byte for byte, scopes, refusals), a huddle from a roster and from a
  squad, posts by the user, a helper and @main, findings, hand-ins (reject, accept into the plain folder), close and
  its summary, the budget stop, resume, and `huddle.*` events (tokens never leave `huddles/<id>.json`).
- `helper.test.ts`: what waits on the user (inbox, cards, the webhook send), notify settings and `notify.json`, the
  helper's status, settings and feedback, messages pages and buttons, a ticket's own notify, phone push against a
  local https fake push service, and Telegram (token, pairing, `/waiting`, an urgent alert and its buttons, a reply
  into a ticket's chat, the front desk with a held move and its Confirm) against a local fake Bot API
  (`CKANBAN_TELEGRAM_URL`). Nothing reaches a real service; a `Google Chrome` symlink to bun passes the daemon's
  browser check for the routes only the Mac's browser may use.
- `huddle-team.test.ts`: brief, status, adding participants, mode, stop and restart one, invite, seen, close request,
  learnings, an auto huddle started from a work run (fake Claude in `call` mode), `learned`, role notes and
  `/api/team-usage`.

Run them with `bun test test/contract` (each file starts its own daemon, about half a second); `bun run test` runs them
with everything else.

To test another server: build it and run
`CKANBAN_CONTRACT_DAEMON='["/path/to/server","dev"]' bun test test/contract` (add `CKANBAN_CONTRACT_CLI` if the CLI
moves too, and `CKANBAN_CONTRACT_MCP` for the MCP server). The server must take its port from `CKANBAN_PORT`, its data folder from `CKANBAN_HOME`, the Claude
program from `CKANBAN_CLAUDE_BIN`, the Claude config folder from `CLAUDE_CONFIG_DIR`, and honour `CKANBAN_USAGE_URL`
`CKANBAN_NO_KEYCHAIN` (see "Plan usage" in `api.md`) and `CKANBAN_TELEGRAM_URL` (see "Notifications" in `api.md`).

`bun run test:contract:rust` does this for the Rust front server (`rust/`): it builds `ckanban-rs` (release) and runs
every contract test with it as the daemon, and `ckanban-rs mcp` as the MCP server (`mcp.test.ts`, `mcp-parity.test.ts`). It needs cargo, so `bun run test` leaves it out.
