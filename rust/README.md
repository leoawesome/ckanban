# rust

`ckanban-rs`, the ckanban server, CLI and MCP server. Since the Rust port's P4 it is the whole server: `ckanban-rs dev`
(launchd's daemon) listens on the board's port and the phone access port, runs the board (`board/`, the
`ckanban-board` crate), answers every route of `contracts/api.md` and serves the built web page. Bun's server, its
satellite and the front mode that passed requests to it are gone; Bun only builds the web page (`bun run build:web`)
and runs the tests. The last commit with Bun's server is fca356b2 (see "Way back" below).

- `src/main.rs`: the commands' entry; `dev`: settings, the board (`board_mode::prepare`), the two listeners, signals
  and the stop (runs are stopped and marked so the next start resumes them).
- `src/board_mode.rs` (and `board_mode/tg.rs`): the board for this start and every request's route, in Bun's order
  (`route()` and `api()` of Bun's `src/api/server.ts`): the gate (Host, the Origin of a change; on the phone access
  listener phone access on, the tailnet host, the owner's login), the Telegram front desk's gate, the system routes,
  the outside services, the board's routes, then the native routes below, then the web page (`src/web.rs`).
- `src/web.rs`: the last stop. Any path outside `/api/` is a file of the build in `web/dist` with Bun's content type,
  else `index.html` (the UI routes itself), else the hint to run `bun run build:web`. An `/api/` path no route took
  is Bun's JSON `404 {"error":"not found"}` (`415` for a change that isn't JSON). Also the request target as Bun's
  `new URL` reads it (`normalize_target`).
- `src/routes.rs`: `GET /api/usage` (`?fresh=1`, the Refresh button), `GET /api/spend` and `GET /api/agents`, after
  Bun's Host, Origin and JSON checks. `src/passes.rs`: the board's passes and saved keys; `src/agents.rs`: whether
  `ckanban-rs mcp` is registered with Claude Code and Codex; `src/guard.rs`: the user-only caller check (`userOnly`:
  no run headers, an Origin, and every process on the caller's end of the connection is a browser this server didn't
  start); `src/mask.rs`: hiding saved keys in answers; `src/js.rs`: JavaScript string rules the answers copy.
- `src/settings.rs`: the data folder (`CKANBAN_HOME`), the board's port (`CKANBAN_PORT`, else `config.json`, else
  7777), the phone access port, and the source folder whose `web/dist` is served (`CKANBAN_REPO`, else the nearest
  folder above the binary with `web/index.html`).
- `src/phone.rs`: the phone access listener (CKANBAN_REMOTE_PORT, else the board's port + 1); `tailscale serve`
  points at it.
- `core/`: `ckanban-core`, usage, spend and the data folder (files read and written byte for byte as Bun did,
  [README](core/README.md)). `board/`: the board ([README](board/README.md)). One workspace: one `Cargo.lock`, one
  toolchain pin, one `target/`.

The web page is not in the binary: the server reads `web/dist` of its source folder, so `bun run build:web` and a
restart show a new UI. Files are read on each request (a few, small, fixed-size).

## The `ckanban` commands

`ckanban-rs` is also the `ckanban` CLI (`src/cli/`, step 2 of `docs/rust-port.md`): same arguments, output, exit codes
and HTTP calls, as `contracts/cli.md` writes them. The CLI contract tests run it (`CKANBAN_CONTRACT_CLI`).

- `src/cli/mod.rs`: dispatch, the usage text, the version (`CKANBAN_VERSION` at build time, else `dev`).
- `src/cli/board.rs`: `profiles`, `ticket ...`/`tickets ...`, `call`; picking the board; `src/cli/text.rs`: what they
  print; `src/cli/http.rs`: the HTTP calls (always to 127.0.0.1, Host as Bun sends it, no Origin).
- `src/cli/launchd.rs`: `install` (the plist byte for byte; program args are this binary), `restart`, `uninstall`,
  `open`. `src/cli/agents.rs`: `mcp install|uninstall|status` (Claude Code and Codex; the registered command is this
  binary plus `mcp`). `src/cli/args.rs`: argument parsing.
- `dev` and `start` are the server (above); `mcp` alone is the stdio MCP server (`src/mcp/`).
- `src/cli/browser_mcp/`: `browser-mcp`, one run's stdio MCP server for a board browser (its tool list and page
  scripts are Bun's own files, on `ckanban_board::browsers::cdp::Cdp`). `src/cli/remote.rs`: `remote on|off|status`
  on `outside::phone` (the terminal QR code is `qr_terminal`, checked against Bun's). `update` says how to update from
  source (there is no Rust release yet). `uninstall` turns phone access off with this binary's `remote off`.
- `src/cli/artifact.rs`: `artifact publish|read|publish-output` on `src/artifact.rs` (the port of `runArtifactJob`:
  Claude Code on a pty, and the Markdown page with `comrak`). No command hands anything to Bun any more (P3).

## The MCP server (`ckanban-rs mcp`)

The port of `ckanban mcp` (`src/mcp/` in Bun): newline-delimited JSON-RPC 2.0 on stdin/stdout, the same protocol
answers, and the same 69 tools. `src/mcp/tools.json` (what `tools/list` answers) and `tool-flags.json` (which tools a
board run may call) were generated from Bun's `TOOLS`; since P4 they are the source (edit them by hand). The tools call the
daemon over HTTP like Bun's (`client.rs`: same paths, bodies and headers, CKANBAN_PORT or `config.json` for the port)
and build the same answer texts, one file per tool group (`tickets`, `workflow`, `family`, `forms`, `huddles`,
`schedules`); `js.rs` has what the texts need from JavaScript (UTF-16 lengths, number printing, URL encoding, local time).

Every tool runs in Rust since P3 (`keys.rs`: ask_keys and backup_file, `proposals.rs`: propose_automation and
propose_helper_rule, `artifact.rs`: read_artifact and publish_artifact, the team tools in `huddles.rs`); `ckanban-rs
mcp` never starts Bun. `ckanban-rs mcp install` and the Connections panel's "Use the board from Claude Code / Codex"
register `ckanban-rs mcp` (this binary). `test/contract/mcp.test.ts` and `mcp-parity.test.ts` check it.

## Life cycle

- launchd runs `rust/target/release/ckanban-rs dev` (`ckanban-rs install` writes the plist). At start it takes
  `<data>/board.lock` (waiting up to 5 s); if another daemon holds it, it exits 1 with the reason and launchd tries
  again. `rust-board-status.json` records the start and whether the last one stopped cleanly.
- Any start error (the lock held, a folder it can't read, a board with old-style plans) ends the process with the
  reason in `daemon.log`; launchd starts it again about every 10 s and no page is served until the cause is gone.
  With no Bun to fall back to, read `daemon.log` first, then see "Way back" below. (A start that keeps the page up and
  answers `/api/*` with 503 and the reason would be friendlier: not done yet.)
- SIGTERM or SIGINT, or a restart the board asked for (`POST /api/restart`, once its runs are done): the runs stop
  (marked so the next start resumes them), the core stops, the process exits 0 and launchd starts it again.
- An older plist or MCP registration that still runs `bun src/cli.ts ...` reaches this binary through `src/cli.ts`,
  which hands every command over. `ckanban-rs install` and `ckanban-rs mcp install` point them here directly (Leo's
  Claude Code still registers `bun src/cli.ts mcp`: run `rust/target/release/ckanban-rs mcp install` once).

## Way back to Bun's server

Check out fca356b2 (the last commit before P4), then `bun install && bun run build:web && scripts/build-rust.sh`.
On it, `scripts/rust-trial.sh board` runs the Rust board with Bun as its satellite (Leo's Mac from 17 Nov until P4)
and `scripts/rust-trial.sh off` puts Bun alone back. The data files are the same on both sides (written in Bun's
bytes), so going back needs no conversion.

## Build and test

Rust is pinned in `rust-toolchain.toml` (rustup installs it on first use). Use rustup's cargo (`~/.cargo/bin/cargo`).

```sh
scripts/build-rust.sh                # release build: rust/target/release/ckanban-rs, signed on macOS (below)
cd rust
~/.cargo/bin/cargo test              # unit tests of the server and of core/ (fixtures shared with Bun)
cd .. && bun run test:contract      # every test/contract test through ckanban-rs (bun run test runs them too)
```

Build the release binary with `scripts/build-rust.sh` (extra arguments go to `cargo build --release`), not cargo
directly. On macOS it signs the binary with a fixed local certificate, "ckanban local signing" (self-signed, made once
in the login keychain on first use), and the identifier `io.ckanban.rs`. A plain cargo build is only ad-hoc signed, and
macOS privacy settings remember an ad-hoc binary by its exact hash, so after every build launchd's `ckanban-rs` would
ask again for the Desktop or Documents folder. With the fixed signature one "Allow" lasts across builds. If signing
can't be done the build still succeeds, ad-hoc signed, with a warning; `CKANBAN_SIGN=0` skips it. Check with
`codesign -d -r- rust/target/release/ckanban-rs` (it names the certificate, not a hash). `bun run test`,
`bun run dev` and the speed check build through it too.

The contract tests (`test/contract/`) are the tests of the outside behaviour: `bun run test` builds this binary and
runs them all against it. The ones that compared Bun's server with this one side by side now compare this one with
Bun's answers recorded before P4 (`test/contract/golden/`). To try the server by hand, use a temp `CKANBAN_HOME` and
a project folder outside the real repo (a daemon on the real data folder sweeps ticket worktrees):
`CKANBAN_HOME=/tmp/ck-try CKANBAN_PORT=47811 rust/target/release/ckanban-rs dev`.

## Outside services (P2, `src/outside/`)

Ported from `src/integrations/` and the routes of `src/api/connections.ts`, `remote.ts`, `passes.ts` and
`system.ts`. `outside/routes.rs` takes them after the request gate, on both
listeners (the owner's phone is the user after its gate, as in Bun), then the Telegram front desk's gate and the
JSON-only rule, as Bun's `api()`. JSON answers are masked with the saved keys.
- `mcp/`: the Connections window's MCP servers (`claude mcp list|get|add|remove|add-json|login|logout`, the probe
  session, sign-ins on a pseudo-terminal, board-only tools in `board-tools.json`, `mcp-seen.json`,
  `claude-ai-connectors.json` and the runs' connector list), refreshed at start and every 10 minutes; `mcp.updated`
  on the board's stream; the helper hears whether any server is connected for its check-in offer.
- `signin/`: every `/api/passes*` route (keys reuse `src/passes.rs`), the OAuth sign-in (discovery, registration,
  PKCE, renewal) with states in memory, the MCP clients (streamable HTTP, stdio in its own process group) and
  `pass_call` for `automation-call`. Writes to `automation-passes.json` under its lock; the UI hears `integration.updated`.
- `phone.rs`: `GET`/`POST /api/remote` (`tailscale serve`, `remote.json`, the QR code byte for byte as
  `qrcode-generator`), `lastVisit`, and the link check (10 s after start, then every 3 minutes while on).
  `CKANBAN_TAILSCALE` points it at a stand-in; tests never run the real Tailscale.
- `agents_admin.rs`: `POST /api/agents/:id/install|uninstall` (Claude Code through `claude mcp`, Codex's
  `config.toml`), then the MCP list is refreshed.
- `bugreport.rs`: `POST /api/bug-report/draft` and `POST /api/bug-report` (`gh issue create`, the prefilled link
  when gh can't).
- `edge.rs`: the board's `api::Satellite` (the name is from when Bun was its satellite): pass calls, the Share
  menu's publishing (`ckanban_board::git::publish`, which runs this binary's `artifact publish-output`), Telegram's
  turn end and the front desk's gate, all answered here.

