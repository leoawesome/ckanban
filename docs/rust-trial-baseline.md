# Rust trial: Bun speed baseline

TL;DR: on a 10,000-ticket board the Bun daemon uses about 91 MB idle and 477 MB once the board is loaded and its
big routes were called, its slowest board route takes about 114 ms (148 ms on the first call), and while the board
loads it never stops answering for longer than about 150 ms. These are the numbers step 4b compares `ckanban-rs`
against.

Measured on 2026-11-15 with `bun scripts/rust-trial-bench.ts --runs 5 --out docs/rust-trial-baseline.json` (Bun
1.4.2, Mac with 10 cores). The Mac was busy with other work while it ran (load average 13.5 at the start), so times
are slower than on an idle Mac; run 4b the same way and, if you can, at a similar load. Every number is the median of 5
fresh server starts. The raw numbers, each run included, are in `docs/rust-trial-baseline.json`.

## Results

| Measure (median of 5 runs) | Value |
|---|---|
| Memory, idle (empty board) | 91 MB |
| Memory, big board settled | 389 MB |
| Memory, big board after the route calls | 477 MB |
| Start until the first answer (big board) | 283 ms |
| Start until the board's tickets answer | 2454 ms |
| Longest stall while the big board loads (outside probe) | 151 ms |
| Longest stall in the server's own [lag] lines (Bun only) | none |
| GET /api/usage, first call | 2.9 ms |
| GET /api/usage, repeat call (median of 5) | 0.1 ms |
| GET /api/spend, first call | 174 ms |
| GET /api/spend, repeat call (median of 5) | 0.2 ms |
| GET /api/profiles/:slug/tickets?scope=board, first call | 71.9 ms |
| GET /api/profiles/:slug/tickets?scope=board, repeat call (median of 5) | 66.3 ms |
| GET /api/tickets (every ticket, light rows), first call | 148 ms |
| GET /api/tickets (every ticket, light rows), repeat call (median of 5) | 114 ms |
| GET /api/inbox, first call | 2.6 ms |
| GET /api/inbox, repeat call (median of 5) | 0.9 ms |

## What was measured

- **The board**: `scripts/speedcheck/gen-board.ts` at 10,000 tickets (about 9,250 Done, 300 Backlog, 150 Review, a
  feature with 300 tasks, two chats of 6,250 entries, 3,000 quick chats, 2,000 closed huddles, 3,000 finished jobs).
  It is built once in `/tmp/ckanban-rust-trial/board-template` and copied fresh before every server start.
- **Memory**: resident memory of the server process and every process under it (so a Rust front plus its Bun child
  counts as one). Idle is an empty board 5 seconds after start. "Settled" is the big board once its tickets, huddles
  and jobs answer fast three times in a row.
- **Routes**: `/api/usage` and `/api/spend` (the two routes the trial moves to Rust) and the three heaviest routes a
  board page load hits (the same ones `scripts/bench.ts` gives the biggest budgets): the board's tickets
  (`scope=board`), the light list of every ticket on every board (`/api/tickets`, used by the command bar), and the
  inbox. "First call" is the first request after the board settled; "repeat call" the median of 5 more. Usage is
  answered from a local fake of Anthropic's endpoint and is cached for 4 minutes; spend is cached for 5 seconds, so
  their repeat calls show the cache, and the first call shows the real work.
- **Longest stall**: from the server's first answer until the board settled, `/api/awake` (a route that does no work)
  is called every 10 ms from outside; its slowest answer is the longest time the server couldn't answer anyone. It
  is measured from outside so it works the same for any server. The Bun daemon logs freezes of 200 ms or more as
  `[lag]` lines; it logged none.

## Running it again (step 4b)

    bun scripts/rust-trial-bench.ts --server '["/path/to/rust/target/release/ckanban-rs","dev"]' --name rust --out docs/rust-trial-rust.json

`{code}` in `--server` is replaced by the bench's copy of the code in `/tmp/ckanban-rust-trial/code` (with its
dependencies installed), for a server that needs the Bun source next to it. Each server gets its own temp data folder,
home folder and Claude settings folder, free ports, a fake `claude`, do-nothing Mac commands and a local fake of
Anthropic's usage endpoint, so the real board, its data and Anthropic are never touched. `--fresh-board` rebuilds the
board; `--runs` and `--tickets` change the counts.

## Switching the real board (for Leo, after step 4b)

`scripts/rust-trial.sh on` builds `ckanban-rs` if it is missing, refuses while board tasks run, keeps a copy of the
launchd file next to it (`io.ckanban.daemon.plist.before-rust-trial`), points it at `ckanban-rs dev` with the same
settings (plus `CKANBAN_BUN` and `CKANBAN_REPO`, so the Rust server finds Bun and the source folder) and reloads it.
`scripts/rust-trial.sh off` puts the copy back and reloads; it works even if `on` stopped half way. Run both from
Terminal, not from a board chat: the switch restarts the board.
