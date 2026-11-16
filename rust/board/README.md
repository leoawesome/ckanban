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
  `sessions` (R5), `git` (R6), `runloop` (R7a), `chat` (R7b), `quickchat` (R8), `browsers` (R9), `schedules` (R10),
  `huddles` (R11a), `team` (R11b), `huddle_agents` (R11c), `extras` (R12), `gate` (R13).

Every dependency the tasks are expected to need is already in `Cargo.toml` (referenced in `lib.rs` until used), so
parallel tasks don't clash on `Cargo.toml` and `Cargo.lock`.

## Sessions and transcripts (R5, `src/sessions/`)

Claude's transcripts as the chat shows them, ported from `src/runs/session-*.ts`, `subagents.ts`, `workflows.ts`,
`src/chat/chat-cache.ts`, `tooldetail.ts`, `chat-search.ts` and `src/core/changefeed.ts`. Shapes Bun keeps as objects
are `serde_json` maps with Bun's key order.
- Parsing: `parser.rs` (`SessionParser`: fed new bytes, cut anywhere), with `markers.rs`, `cards.rs`, `text.rs` (text,
  forms and cards inside a line), `chat_cache.rs`, `subagents.rs`, `workflows.rs`.
- `cache.rs`: `SessionCache`. Reads only what a transcript gained (by size, mtime and inode; a shrunk or replaced file
  is parsed again), keeps 30 parses plus running ones, and keeps summaries in `session-summaries.json` (tag
  `2:rust:<hash of this code>`; Bun's summaries are shown as stale until made again). Blocking: callers use
  `spawn_blocking`; no shared lock is held across a read or a parse.
- `feed.rs`: the projects folder change feed on FSEvents (`notify`); `watcher.rs`: `session.updated` for the tickets
  written and the sessions the feed reported, a full pass every minute (Done tickets every 10), the first pass only
  takes stock.
- `routes.rs`: in board mode Rust answers `GET` conversation, tool, agent, workflow script and helper agent,
  `chat/search`, `chat/read` and `sessions`. Bun still answers a workflow stop and a chat search or read from another
  ticket's run (family and "asked by the user" reach need R2b).
- `ticket_files.rs`: `TicketSource`, read from the ticket files until the ticket store (R1/R2a) replaces it.
- `service.rs`: `Sessions`, the `SessionInfo` the other modules use (summaries from the watcher, no file read).

Parity with Bun: `tests/sessions_markers.rs`, `sessions_agents.rs`, `sessions_parse.rs` read the fixtures in
`tests/fixtures/sessions/` (inputs with Bun's answers, filled by `test/rust-board-*-fixtures.test.ts`; after a
deliberate change to Bun's code: `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-<name>-fixtures.test.ts`). Parse
speed: `R5_BENCH=<transcript> cargo test --release -p ckanban-board --test sessions_parse -- --ignored --nocapture`.

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

## Tests

```sh
cd rust && ~/.cargo/bin/cargo test -p ckanban-board   # this crate's unit tests
bun run test:contract:rust-board                       # the files in contract-files.txt, board mode on
bun run test:contract:rust-board tickets.test.ts       # any contract file in board mode, listed or not
```

`contract-files.txt` lists the contract test files (or `file | test name pattern`) that pass in board mode; a listed
one that fails, fails the run. Each task adds what it makes pass; the flip needs every file listed whole.
`test/contract/rust-board-mode.test.ts` covers the switch and the three fallbacks (only in this run).
