# rust

The Rust front server `ckanban-rs` of the Rust port trial. `ckanban-rs dev` listens on the board's port and starts
the Bun daemon (`bun src/cli.ts dev`) as a child on an internal port. It answers two routes itself (below, with the
`ckanban-core` library in `core/`) and passes every other request to the child unchanged: method, path, query,
headers (Host and Origin as sent; only hop-by-hop headers are dropped), body and status, streamed both ways (the event
stream goes out as Bun writes it) and WebSocket upgrades (the terminal). The real board's daemon is never switched to
it during the trial.

- `src/main.rs`: the `dev` command: settings, starting the child, waiting until it answers (`GET /api/profiles`, 30 s,
  then it exits naming the child's log), serving, signals and the exit code.
- `src/routes.rs`: the routes Rust answers itself (below).
- `src/proxy.rs`: passing one request and its answer, hop-by-hop headers, upgrades.
- `core/`: `ckanban-core`, the usage and spend logic ported from `src/usage/` ([README](core/README.md)). One
  workspace: one `Cargo.lock`, one toolchain pin, one `target/`.
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
- `dev` and `start` are the front server below.
- Still on Bun, handed to `bun src/cli.ts` with the same arguments (this process becomes Bun, so its output and exit
  code are Bun's): `mcp` on stdio (step 3), `browser-mcp` (drives a board browser), `artifact` (a Claude Code session
  in a pty), `remote` (Tailscale) and `update` (the release binary is still Bun's). `uninstall` turns phone access off
  through `bun src/cli.ts remote off` too. Bun and the repo are found as for `dev` (below).

## Routes Rust answers

| Route | Answer |
| --- | --- |
| `GET /api/usage` (`?fresh=1`, the Refresh button) | Claude plan usage, as `src/usage/usage-cache.ts` gives it; always 200 |
| `GET /api/spend` | What every board spent today, as `SpendIndex.recent()` in `src/usage/spend.ts` gives it; 500 `{"error"}` if it can't count |

Only these exact paths with GET. Everything else goes to Bun: other methods (Bun's 404), other spellings Bun also
accepts (`/api/usage/`, `/api/usage/x`), WebSocket upgrades and any request from the Telegram front desk
(`x-ckanban-frontdesk`, which goes through Bun's gate). Rust answers with `content-type: application/json` and no
caching headers, as Bun does, and makes the same Host check (`localhost` or `127.0.0.1` on the board's port, else a
plain-text 403 `forbidden`). The phone access port stays on Bun, so phone requests always get Bun's answers. Waiting
on Anthropic happens in that request's own task, so other requests through the proxy never wait for it; spend is
counted on a blocking-pool thread.

Not ported: Bun runs every JSON answer through `maskSavedJson` (hides keys saved on this Mac). Usage and spend answers
hold only fixed texts, numbers, board slugs and board names, so Rust skips it.

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
link step 7 would throw away. They move with the board, runs and chat (step 7 of `docs/rust-port.md`).
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

Bun sends no event to the UI when usage changes (the header pill and phone box ask `/api/usage` themselves), so a
check Rust makes reaches the UI the same way; there is no event gap.

Log lines: each call to Anthropic prints Bun's `[usage] asked Anthropic: ...` line on this process's output (the same
`daemon.log` under launchd).

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
cd rust
~/.cargo/bin/cargo build --release   # target/release/ckanban-rs
~/.cargo/bin/cargo test              # unit tests of the server and of core/ (fixtures shared with Bun)
cd .. && bun run test:contract:rust  # every test/contract test through ckanban-rs, plus the parity test
```

The parity test (`test/contract/rust-parity.test.ts`) starts Bun alone and `ckanban-rs` on the same data, walks
both through the same usage scenarios (a fake Anthropic) and spend data, and checks the answers and the shared files
match; `bun run test` skips it. `bun run test` never runs cargo. To try it by hand, use a temp `CKANBAN_HOME` and a project folder outside the real
repo (a daemon on the real data folder sweeps ticket worktrees):
`CKANBAN_HOME=/tmp/ck-try CKANBAN_PORT=47811 rust/target/release/ckanban-rs dev`.
