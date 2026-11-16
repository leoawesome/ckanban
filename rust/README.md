# rust

The Rust front server `ckanban-rs` of the Rust port trial. `ckanban-rs dev` listens on the board's port and starts
the Bun daemon (`bun src/cli.ts dev`) as a child on an internal port. It answers two routes itself (below, with the
`ckanban-core` library in `core/`) and passes every other request to the child unchanged: method, path, query,
headers (Host and Origin as sent; only hop-by-hop headers are dropped), body and status, streamed both ways (the event
stream goes out as Bun writes it) and WebSocket upgrades (the terminal). The real board's daemon is never switched to
it during the trial.

- `src/main.rs`: the `dev` command: settings, starting the child, waiting until it answers (`GET /api/profiles`, 30 s,
  then it exits naming the child's log), serving, signals and the exit code.
- `src/routes.rs`: which routes Rust answers itself (below) and the checks Bun makes before any route (Host, Origin of
  a change, JSON content type).
- `src/passes.rs`: the board's passes and saved keys; `src/agents.rs`: `GET /api/agents`; `src/guard.rs`: the
  user-only caller check; `src/mask.rs`: hiding saved keys in answers; `src/js.rs`: JavaScript string rules the
  answers must copy.
- `src/proxy.rs`: passing one request and its answer, hop-by-hop headers, upgrades.
- `core/`: `ckanban-core`, the usage and spend logic ported from `src/usage/` ([README](core/README.md)). One
  workspace: one `Cargo.lock`, one toolchain pin, one `target/`.
- `src/settings.rs`: the board's port (`CKANBAN_PORT`, else `config.json` in the data folder, else 7777), the phone
  access port, finding Bun (`CKANBAN_BUN`, else the Bun that started this process, else `bun` on `PATH`) and the repo
  (`CKANBAN_REPO`, else the nearest folder above the binary with `src/cli.ts`), the free internal port, the secret.

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
driven by a program. Every JSON answer of these routes goes through Bun's `maskSavedJson` (`src/mask.rs`). A body over
1 MB gets 413 (Bun accepts up to 128 MB).

Still on Bun, and why: `/api/mcp/*` (Bun keeps the servers' state, background checks and sign-in terminals in memory),
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

Usage and spend answers hold only fixed texts, numbers, board slugs and board names, so Rust doesn't mask them; the
pass and agent answers are masked like Bun's.

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
