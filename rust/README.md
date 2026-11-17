# rust

The Rust front server `ckanban-rs` of the Rust port trial. `ckanban-rs dev` listens on the board's port and starts
the Bun daemon (`bun src/cli.ts dev`) as a child on an internal port. It answers two routes itself (below, with the
`ckanban-core` library in `core/`) and passes every other request to the child unchanged: method, path, query,
headers (Host and Origin as sent; only hop-by-hop headers are dropped), body and status, streamed both ways (the event
stream goes out as Bun writes it) and WebSocket upgrades (the terminal). The real board's daemon is never switched to
it during the trial.

- `src/mcp/`: `ckanban-rs mcp`, the port of the `ckanban mcp` stdio server (below).
- `src/main.rs`: the `dev` and `mcp` commands; `dev`: settings, starting the child, waiting until it answers (`GET /api/profiles`, 30 s,
  then it exits naming the child's log), serving, signals and the exit code.
- `src/routes.rs`: which routes Rust answers itself (below) and the checks Bun makes before any route (Host, Origin of
  a change, JSON content type).
- `src/passes.rs`: the board's passes and saved keys; `src/agents.rs`: `GET /api/agents`; `src/guard.rs`: the
  user-only caller check; `src/mask.rs`: hiding saved keys in answers; `src/js.rs`: JavaScript string rules the
  answers must copy.
- `src/proxy.rs`: passing one request and its answer, hop-by-hop headers, upgrades.
- `core/`: `ckanban-core`, the usage and spend logic ported from `src/usage/` ([README](core/README.md)). One
  workspace: one `Cargo.lock`, one toolchain pin, one `target/`.
- `board/`: `ckanban-board`, the board, runs and chat in Rust, behind board mode (off by default; [README](board/README.md)).
  `src/board_mode.rs` decides at start whether it owns the board (`CKANBAN_RUST_BOARD=1` or `<data>/rust-board`),
  falls back to Bun's full mode when it can't, and answers the routes it owns (`GET /api/events` so far) before the
  ones below.
- `src/settings.rs`: the board's port (`CKANBAN_PORT`, else `config.json` in the data folder, else 7777), the phone
  access port, finding Bun (`CKANBAN_BUN`, else the Bun that started this process, else `bun` on `PATH`) and the repo
  (`CKANBAN_REPO`, else the nearest folder above the binary with `src/cli.ts`), the free internal port, the secret.

## The `ckanban` commands

`ckanban-rs` is also the `ckanban` CLI (`src/cli/`, step 2 of `docs/rust-port.md`): same arguments, output, exit codes
and HTTP calls, as `contracts/cli.md` writes them. `bun run test:contract:rust` runs every CLI contract test with it
(`CKANBAN_CONTRACT_CLI`). Bun's CLI stays the one launchd and the MCP configs run for now.

- `src/cli/mod.rs`: dispatch, the usage text, the version (`CKANBAN_VERSION` at build time, else `dev`), handing a
  command to Bun.
- `src/cli/board.rs`: `profiles`, `ticket ...`/`tickets ...`, `call`; picking the board; `src/cli/text.rs`: what they
  print; `src/cli/http.rs`: the HTTP calls (always to 127.0.0.1, Host as Bun sends it, no Origin).
- `src/cli/launchd.rs`: `install` (the plist byte for byte; program args are this binary), `restart`, `uninstall`,
  `open`. `src/cli/agents.rs`: `mcp install|uninstall|status` (Claude Code and Codex; the registered command is this
  binary plus `mcp`). `src/cli/args.rs`: argument parsing.
- `dev` and `start` are the front server below; `mcp` alone is the stdio MCP server (`src/mcp/`).
- `src/cli/browser_mcp/`: `browser-mcp`, one run's stdio MCP server for a board browser (its tool list and page
  scripts are Bun's own files, on `ckanban_board::browsers::cdp::Cdp`). `src/cli/remote.rs`: `remote on|off|status`
  on `outside::phone` (the terminal QR code is `qr_terminal`, checked against Bun's). `update` answers as Bun does from
  source until the release binary is Rust (P4). `uninstall` turns phone access off with this binary's `remote off`.
- `src/cli/artifact.rs`: `artifact publish|read|publish-output` on `src/artifact.rs` (the port of `runArtifactJob`:
  Claude Code on a pty, and the Markdown page with `comrak`). No command hands anything to Bun any more (P3).

## Routes Rust answers

| Route | Answer |
| --- | --- |
| `GET /api/usage` (`?fresh=1`, the Refresh button) | Claude plan usage, as `src/usage/usage-cache.ts` gives it; always 200 |
| `GET /api/spend` | What every board spent today, as `SpendIndex.recent()` in `src/usage/spend.ts` gives it; 500 `{"error"}` if it can't count |

| `GET /api/passes` | Every pass as the UI sees it (no secrets, errors masked), with the automations using it and board names |
| `POST /api/passes` with `kind: "key"` and no `url` | Saves a key (for automations, or for one board's runs); user only |
| `PATCH /api/passes/<id>`, `DELETE /api/passes/<id>` | A new value for a key; removing a pass; user only |
| `GET /api/agents` | Whether `ckanban mcp` is registered with Claude Code and Codex (only when the Bun child's command line is known: a wrapper script as `CKANBAN_BUN` leaves it to Bun) |

Pass routes answer only these exact paths with ids of letters, digits, `_` and `-`. Other kinds of pass and keys for an
online server, `tools`, `authorize` and the OAuth callback go to Bun, and so does any request Rust can't answer exactly
as Bun would: a body or passes file only JavaScript can parse, a field of an unexpected type, a name that JavaScript
would cut in the middle of a character. The user-only check is Bun's (`userOnly` with `fromUserBrowser`): no
`x-ckanban-run` or `x-ckanban-huddle-agent`, an Origin, and every process on the caller's end of the connection is a
browser this server didn't start (not a descendant of `ckanban-rs`, so not the Bun child or any board run) and not one
driven by a program. Every JSON answer of these routes goes through Bun's `maskSavedJson` (`src/mask.rs`). A body declared
over 1 MB goes to Bun unread; one over 1 MB sent without a length gets 413 (Bun accepts up to 128 MB).

In board mode (P2, `src/outside/`) Rust also answers everything below that front mode leaves to Bun: `/api/mcp*`,
`/api/agents*`, `/api/remote`, every `/api/passes*` route (sign-in, callback, `tools`, every kind of pass), the
automations' pass calls and `/api/bug-report*`; see "Outside services" below.

Still on Bun in front mode, and why: `/api/mcp/*` (Bun keeps the servers' state, background checks and sign-in terminals in memory),
`POST /api/agents/*/install|uninstall` (refreshes that in-memory list), `/api/remote` (phone access: Tailscale state
and live checks; the phone port is Bun's), the passes sign-in and `tools` (sign-in states and token renewal in memory),
`/api/automation-call` and `loops/test` (check tokens and the scheduler), the ask_keys box (`key-cards`, a ticket
route), `/api/bug-report` (reads tickets). `backup_file` is not a daemon route: the `ckanban mcp` process does it.

Usage and spend: only these exact paths with GET. Everything else goes to Bun: other methods (Bun's 404), other spellings Bun also
accepts (`/api/usage/`, `/api/usage/x`), WebSocket upgrades and any request from the Telegram front desk
(`x-ckanban-frontdesk`, which goes through Bun's gate). Rust answers with `content-type: application/json` and no
caching headers, as Bun does, and makes the same Host check (`localhost` or `127.0.0.1` on the board's port, else a
plain-text 403 `forbidden`). The phone access port stays on Bun, so phone requests always get Bun's answers. Waiting
on Anthropic happens in that request's own task, so other requests through the proxy never wait for it; spend is
counted on a blocking-pool thread.

Every JSON answer Rust makes (usage, spend, passes, agents, errors) is masked like Bun's.

### Browsers and devices stay on Bun (step 5b)

Every `src/browser/` route still goes to Bun, on purpose: each one reads or changes state that only Bun's memory holds,
and every answer includes it, so Rust can't give the same answer from the files.

| Routes | Why Bun keeps them |
| --- | --- |
| `/api/devices` (list, add or change, remove, free) and the ticket `POST .../devices` (take, release) | Who holds and who waits live in memory (`devices.ts`), takes wait up to 4 minutes for a release, the board frees a ticket's devices when its run ends, ticket cards show them, and each change sends a UI event |
| `/api/board-browsers` (list, add, change, remove, open, sign-in, screen, input, close, ensure) | Each answer has the running Chrome, which run holds it, errors and the sign-in check, all in memory (`board-browsers.ts`); most routes start or stop Chrome |
| `/api/browsers` (list, rename, remove) | Bun keeps `browsers.json` in memory and rewrites it from every run's output (`ChromeWatch`), and the answer includes the board browsers above |
| `/api/terminal` (WebSocket) | The shells are Bun's child processes |

Moving them now would mean Rust owning device holds and Bun asking it over HTTP on every ticket view and run end, a
link step 7 would throw away. They move with the board, runs and chat (step 7 of `docs/rust-port.md`): in board mode
Rust answers all of them (R9, `rust/board/src/browsers/`, see `rust/board/README.md`); in front mode they still go to
Bun.
`bun run test:contract:rust` runs `test/contract/browsers.test.ts` through `ckanban-rs`, so the pass-through is tested.

### Files shared with Bun

Both processes use the same data folder (`CKANBAN_HOME`, default `~/.claude-kanban`); the Bun child keeps running its
own usage code (helper, limits, ticket Usage tabs).

- `usage-last.json` (the usage cache): both read it again when its size or change time moves and both write it by
  atomic rename (`<file>.tmp-<8 chars>`, then rename) in the same format. A check either side made counts for both
  (the one-minute gap, the four-minute reuse, the wait after a 429), so the pair never asks Anthropic more often than
  Bun alone.
- `usage-windows.json`: each check either side makes records its five-hour window there, same format.
- Spend files (activity logs, side-spend ledgers, `spend-days.json`, quick chat logs, `helper-spend.jsonl`): Rust only
  reads them.
- `automation-passes.json` (owner-only, holds keys): both change it read-modify-write while holding an exclusive
  `flock` on `automation-passes.json.lock` (Bun opens it with `O_EXLOCK`), and write it by atomic rename (`0600`), so
  neither loses the other's change or sees half a file. Bun reads the file on every use. After a change Rust writes
  `changed automation-passes.json` on the child's stdin and Bun sends the UI `integration.updated`.
- Read only by Rust: `profiles/*/profile.json`, `profiles/*/loops/*.json` (read on each `GET /api/passes`; a few small
  files per board), Claude's `.claude.json` and Codex's `config.toml`.

Bun sends no event to the UI when usage changes (the header pill and phone box ask `/api/usage` themselves), so a
check Rust makes reaches the UI the same way; there is no event gap.

Log lines: each call to Anthropic prints Bun's `[usage] asked Anthropic: ...` line on this process's output (the same
`daemon.log` under launchd).

## The MCP server (`ckanban-rs mcp`)

The port of `ckanban mcp` (`src/mcp/` in Bun): newline-delimited JSON-RPC 2.0 on stdin/stdout, the same protocol
answers, and the same 69 tools. `src/mcp/tools.json` (what `tools/list` answers) and `tool-flags.json` (which tools a
board run may call) are generated from Bun's `TOOLS` with `bun scripts/mcp-tools-json.ts`; `src/mcp/tools-json.test.ts`
in `bun run test` fails while they are stale, so names, descriptions and input schemas can't drift. The tools call the
daemon over HTTP like Bun's (`client.rs`: same paths, bodies and headers, CKANBAN_PORT or `config.json` for the port)
and build the same answer texts, one file per tool group (`tickets`, `workflow`, `family`, `forms`, `huddles`,
`schedules`); `js.rs` has what the texts need from JavaScript (UTF-16 lengths, number printing, URL encoding, local time).

Every tool runs in Rust since P3 (`keys.rs`: ask_keys and backup_file, `proposals.rs`: propose_automation and
propose_helper_rule, `artifact.rs`: read_artifact and publish_artifact, the team tools in `huddles.rs`); `ckanban-rs
mcp` never starts Bun. `ckanban-rs mcp install` registers `ckanban-rs mcp`, and in board mode so does the Connections
panel's "Use the board from Claude Code / Codex". `bun run test:contract:rust` runs `test/contract/mcp.test.ts` and
`mcp-parity.test.ts` against `ckanban-rs mcp`.

## Who is calling

The daemon tells the user from board runs by looking up the process behind the caller's TCP port
(`src/integrations/guard.ts`). Behind a proxy every caller would look like the proxy, so `ckanban-rs` sends the real
caller's port in `x-ckanban-peer-port` with this start's random secret in `x-ckanban-front`, and drops any copies a
caller sent. The secret (and `ckanban-rs`'s pid, so a bun wrapper between them changes nothing) goes to the child as the first line of its stdin, not in its environment (any process of the
same user can read another's environment with `ps eww`). The child answers on its internal port only with the
secret. See `src/core/front.ts` and "Behind a front server" in `contracts/api.md`.

## Life cycle

- Same env as the Bun daemon. The child gets `CKANBAN_PORT` (internal) and `CKANBAN_FRONT_PORT` (the board's port)
  on top, and gives its own runs and scripts the board's port.
- The child exits: `ckanban-rs` exits with the same code (128 + signal if a signal ended it), so launchd and
  `ckanban restart` work as with Bun alone.
- SIGTERM or SIGINT: the child gets SIGTERM first (SIGKILL after 30 s), then `ckanban-rs` exits with its code.
- `ckanban-rs` killed hard: the child's stdin ends and it shuts down by itself.
- The phone access port (`CKANBAN_REMOTE_PORT`) stays on the Bun child directly.

## Build and test

Rust is pinned in `rust-toolchain.toml` (rustup installs it on first use). Use rustup's cargo (`~/.cargo/bin/cargo`).

```sh
scripts/build-rust.sh                # release build: rust/target/release/ckanban-rs, signed on macOS (below)
cd rust
~/.cargo/bin/cargo test              # unit tests of the server and of core/ (fixtures shared with Bun)
cd .. && bun run test:contract:rust  # every test/contract test through ckanban-rs, plus the parity test
```

Build the release binary with `scripts/build-rust.sh` (extra arguments go to `cargo build --release`), not cargo
directly. On macOS it signs the binary with a fixed local certificate, "ckanban local signing" (self-signed, made once
in the login keychain on first use), and the identifier `io.ckanban.rs`. A plain cargo build is only ad-hoc signed, and
macOS privacy settings remember an ad-hoc binary by its exact hash, so after every build launchd's `ckanban-rs` would
ask again for the Desktop or Documents folder. With the fixed signature one "Allow" lasts across builds. If signing
can't be done the build still succeeds, ad-hoc signed, with a warning; `CKANBAN_SIGN=0` skips it. Check with
`codesign -d -r- rust/target/release/ckanban-rs` (it names the certificate, not a hash). The test scripts
(`test:contract:rust`, `test:contract:rust-board`) and `scripts/rust-trial.sh` build through it too.

Board mode has its own checks (`bun run test:contract:rust-board`, the board parity test and the dry run on a copy of
the data folder): see `board/README.md`, "F1".

The parity test (`test/contract/rust-parity.test.ts`) starts Bun alone and `ckanban-rs` on the same data, walks
both through the same usage scenarios (a fake Anthropic) and spend data, and checks the answers and the shared files
match; `bun run test` skips it. `bun run test` never runs cargo. To try it by hand, use a temp `CKANBAN_HOME` and a project folder outside the real
repo (a daemon on the real data folder sweeps ticket worktrees):
`CKANBAN_HOME=/tmp/ck-try CKANBAN_PORT=47811 rust/target/release/ckanban-rs dev`.

## Outside services in board mode (P2, `src/outside/`)

Ported from `src/integrations/` and the routes of `src/api/connections.ts`, `remote.ts`, `passes.ts` and
`system.ts`; the satellite answered them until P2. `outside/routes.rs` takes them after the request gate, on both
listeners (the owner's phone is the user after its gate, as in Bun), then the Telegram front desk's gate and the
JSON-only rule, as Bun's `api()`. JSON answers are masked with the saved keys.
- `mcp/`: the Connections window's MCP servers (`claude mcp list|get|add|remove|add-json|login|logout`, the probe
  session, sign-ins on a pseudo-terminal, board-only tools in `board-tools.json`, `mcp-seen.json`,
  `claude-ai-connectors.json` and the runs' connector list), refreshed at start and every 10 minutes; `mcp.updated`
  on the board's stream. The satellite runs no MCP checks in board mode; it hears `runtime {"mcpConnected": …}` for
  the helper's check-in offer.
- `signin/`: every `/api/passes*` route (keys reuse `src/passes.rs`), the OAuth sign-in (discovery, registration,
  PKCE, renewal) with states in memory, the MCP clients (streamable HTTP, stdio in its own process group) and
  `pass_call` for `automation-call`. Writes to `automation-passes.json` under the same lock; Bun hears of them.
- `phone.rs`: `GET`/`POST /api/remote` (`tailscale serve`, `remote.json`, the QR code byte for byte as
  `qrcode-generator`), `lastVisit`, and the link check (10 s after start, then every 3 minutes while on).
  `CKANBAN_TAILSCALE` points it at a stand-in; tests never run the real Tailscale.
- `agents_admin.rs`: `POST /api/agents/:id/install|uninstall` (Claude Code through `claude mcp`, Codex's
  `config.toml`), then the MCP list is refreshed.
- `bugreport.rs`: `POST /api/bug-report/draft` and `POST /api/bug-report` (`gh issue create`, the prefilled link
  when gh can't).
- `edge.rs`: the board's `Satellite` with pass calls and the Share menu's publishing done here
  (`ckanban_board::git::publish`, which runs this binary's `artifact publish-output`).
  Still asked of the satellite: the front desk gate and Telegram's turn end (the helper, P1).

