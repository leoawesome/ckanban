# rust

The Rust front server `ckanban-rs` (step 2 of the Rust port trial). `ckanban-rs dev` listens on the board's port and
starts the Bun daemon (`bun src/cli.ts dev`) as a child on an internal port, then passes every request to it
unchanged: method, path, query, headers (Host and Origin as sent; only hop-by-hop headers are dropped), body and
status, streamed both ways (the event stream goes out as Bun writes it) and WebSocket upgrades (the terminal). Later
steps move routes to Rust one at a time; anything not moved keeps going to Bun. The real board's daemon is never
switched to it during the trial.

- `src/main.rs`: the `dev` command: settings, starting the child, waiting until it answers (`GET /api/profiles`, 30 s,
  then it exits naming the child's log), serving, signals and the exit code.
- `src/proxy.rs`: passing one request and its answer, hop-by-hop headers, upgrades.
- `src/settings.rs`: the board's port (`CKANBAN_PORT`, else `config.json` in the data folder, else 7777), the phone
  access port, finding Bun (`CKANBAN_BUN`, else the Bun that started this process, else `bun` on `PATH`) and the repo
  (`CKANBAN_REPO`, else the nearest folder above the binary with `src/cli.ts`), the free internal port, the secret.

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
~/.cargo/bin/cargo test              # unit tests
cd .. && bun run test:contract:rust  # every test/contract test through ckanban-rs
```

`bun run test` never runs cargo. To try it by hand, use a temp `CKANBAN_HOME` and a project folder outside the real
repo (a daemon on the real data folder sweeps ticket worktrees):
`CKANBAN_HOME=/tmp/ck-try CKANBAN_PORT=47811 rust/target/release/ckanban-rs dev`.
