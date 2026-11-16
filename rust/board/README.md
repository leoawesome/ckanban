# rust/board

`ckanban-board`: the board, runs and chat of ckanban in Rust, built behind **board mode** so each task can land on
`main` without changing the running board. The plan, the order of tasks and the rules every task follows are in
`docs/rust-port-board-plan.md` (sections 2, 3, 7, 8). The server (`rust/src/board_mode.rs`) calls into this crate.

## Board mode

Off by default. On when `CKANBAN_RUST_BOARD=1`, or when that variable is unset and `<data>/rust-board` holds `on`
(`scripts/rust-trial.sh board` writes it; `on`/`off` remove it). Then `ckanban-rs dev` takes `<data>/board.lock`,
starts the `Core`, and starts Bun as its satellite (`CKANBAN_SATELLITE=1`, `src/core/satellite.ts`): Bun keeps the
helper and the outside services, starts no runs, timers or watchers, and refuses every ticket write.

Fallbacks to Bun's full mode (as with board mode off), each logged and written to `<data>/rust-board-status.json`:
1. the switch is off (`rm <data>/rust-board && ckanban restart`);
2. the Rust core can't start (the lock is held, a folder it can't read; later: an old-style plan);
3. board mode ended uncleanly three times within 10 minutes; Bun then keeps the board until `rust-board` is written
   again (or the status file is removed).

Bun in full mode takes the same `board.lock` (`src/core/board-lock.ts`), so two daemons never own one data folder.

## What is here (R0)

- `src/api.rs`: the interfaces between modules (plan 2.6) with stand-ins ("nothing running", "no session", "no
  huddle", "no devices"...). A task replaces its stand-in in `Services` (`core.rs`) when it lands:
  - `RunControl` (R7a): is a ticket running, its run key and slot, start, stop, chat, active work, busy boards, running tickets.
  - `SessionInfo` (R5): a session's summary, version and entries.
  - `HuddleInfo` (R11a): each board's huddles by host ticket, what a restart waits for.
  - `DeviceInfo` (R9): a ticket's devices, letting go at a run's end, browser picks.
  - `Landing` (R6): merge into main, land, clean up a copy, the folder's repo state.
  - `Satellite` (R13): Telegram chat, notify, pass calls, the front desk gate, publishing.
  - `TicketViews` (R1): a ticket's `TicketView` for events and answers.
  - `ActivityCut` (R3): `liveJson`, run events without their long strings.
- `src/core.rs`: `Core` (root, bus, services); start steps in Bun's order (load tickets, load lists, recover,
  huddles, quick chats, timers), each empty until its task fills it; `on_stop` hooks run newest first.
- `src/bus.rs`: the bus (broadcast channel, capacity 4096, plus in-process subscribers); events from the satellite
  keep the text Bun built.
- `src/events.rs`: `GET /api/events` (connected, ping every 15 s, one `data:` per event, views, `liveJson`, masking,
  a slow connection closed).
- `src/mode.rs`: the switch, the fallbacks and the status file. `src/lock.rs`: `board.lock`.
- `src/satellite.rs`: `event`/`runtime` lines to the satellite's stdin; its event stream re-emitted on the bus.
- One empty folder per later task (filled as each lands): `index` (R1), `tickets` (R2a), `families` (R2b), `runs` (R3), `prompts` (R4, done),
  `sessions` (R5), `git` (R6, done), `runloop` (R7a), `chat` (R7b), `quickchat` (R8), `browsers` (R9), `schedules` (R10),
  `huddles` (R11a), `team` (R11b), `huddle_agents` (R11c), `extras` (R12), `gate` (R13).

Every dependency the tasks are expected to need is already in `Cargo.toml` (referenced in `lib.rs` until used), so
parallel tasks don't clash on `Cargo.toml` and `Cargo.lock`.

## Prompts (R4)

`src/prompts/`: the run prompts of `src/runs/prompts-*.ts` (`rules`, `chat`, `planning`, `huddle`, `main_role`) and
`web/src/features/ticket/questionForms.ts` (`question_forms`), the same bytes as Bun's. `deps` holds the helpers
they need from other areas (helper command, review huddle section, digest lines, huddle topic, check-in setup chat,
Task models line, automation label), `js` the JavaScript string behaviours (`trim`, UTF-16 lengths, `toFixed`,
`path.join`), `types` the fields of Bun's types they read (same JSON names). The helper command a prompt names is this
program unless `deps::set_helper_command` sets it.

`tests/fixtures/prompts.json` is the parity table: about 800 cases over tickets, boards, roles, huddles and forms,
each with Bun's answer (texts as SHA-1 and length). `test/rust-prompt-fixtures.test.ts` (in `bun run test`) checks
Bun still gives them; `tests/prompts.rs` checks Rust does. After a deliberate prompt change in Bun:
`UPDATE_RUST_FIXTURES=1 bun test test/rust-prompt-fixtures.test.ts`, then change the Rust text until
`cargo test -p ckanban-board --test prompts` passes (it writes its differing texts to `rust/target/prompt-fixtures/`;
`DUMP_PROMPTS=<dir>` makes the Bun test write Bun's, numbered the same).

## R6: git, copies of the folder, landing, files (`src/git/`)

- `cmd`, `repo`: git and gh as child processes; repo kind (plain, empty, local, remote) cached 10 s; ticket copies
  (worktrees), the shared fetch of the latest base, turning version history on.
- `setup`: setup detection (.env files, lockfiles), copying `copyFiles`, the setup command, `detect_missing`.
- `diff`: the Changes tab. `pr`: a ticket's PRs, `gh` status, Merge & done, send failures, resolve conflicts, the poller
  (`start_poller`, started by R7a). `share`: Show in Finder, Copy file, download headers. `files`: Files panel, files a
  chat mentions, outputs.
- `landing::Git`: where a ticket's runs work (`ensure_session`, the plain-folder path included), `run_setup`, merge
  into main, `land_milestone`, `branch_folder` (Branch/Fork), the Done cleanup and the worktree sweep; implements
  `api::Landing`. It reaches the board through `ops::BoardOps`, which R2a/R7a implement (`fileops::FileOps` is a
  read-only stand-in for the start-up sweep).
- `routes`: what board mode answers now (files alone, no ticket writes): a ticket's `outputs`, `find-files`, `file`,
  `diff`; the board's `files`, `file`, `open-file`, `detect-setup`; `/api/version-history`. Anything unusual goes to
  the satellite. The write routes (`merge-into-main`, `land`, `branch`, `setup`, `pr/*`, `check-pr`) come with R7a.
- At start (`start_jobs`): setup detection, and the worktree sweep in report-only mode.
- Background deletes are report-only (`src/dryrun.rs`): the sweep and the Done cleanup append their decisions to
  `<data>/rust-board-dryrun.log` and delete nothing until `CKANBAN_RUST_DELETE=1` (plan 5.3).
- Pure logic is checked against Bun: `tests/fixtures/git.json` (written by `test/rust-git-fixtures.test.ts`,
  `UPDATE_RUST_FIXTURES=1`).

## Tests

```sh
cd rust && ~/.cargo/bin/cargo test -p ckanban-board   # this crate's unit tests
bun run test:contract:rust-board                       # the files in contract-files.txt, board mode on
bun run test:contract:rust-board tickets.test.ts       # any contract file in board mode, listed or not
```

`contract-files.txt` lists the contract test files (or `file | test name pattern`) that pass in board mode; a listed
one that fails, fails the run. Each task adds what it makes pass; the flip needs every file listed whole.
`test/contract/rust-board-mode.test.ts` covers the switch and the three fallbacks (only in this run).
