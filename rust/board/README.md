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
- One empty folder per later task: `index` (R1), `tickets` (R2a), `families` (R2b), `runs` (R3), `prompts` (R4),
  `sessions` (R5), `git` (R6), `runloop` (R7a), `chat` (R7b), `quickchat` (R8), `browsers` (R9), `schedules` (R10),
  `huddles` (R11a), `team` (R11b), `huddle_agents` (R11c), `extras` (R12), `gate` (R13).

## The run engine (R3, `src/runs/`)

A library for the run loop (R7a); nothing calls it at run time yet except `LiveCut` (the event stream's
`ActivityCut`). One file per Bun file, listed in `src/runs/mod.rs`. What R7a calls:

- `runner::build_args(&BuildArgs { session_id, resume, model, disallowed, mcp, system_prompt, max_budget_usd, effort,
  ultracode, settings, tools, strict_mcp, no_chrome })`, then `runner::start_run(RunOptions { bin, cwd, args, env,
  input, input_local, planning, on_event, on_waiting, grace_ms, idle_ms, stall_ms, on_stall })` → `RunHandle`:
  `send(text, local) -> bool`, `stop_task(id).await`, `end_when_idle()`, `keep_waiting()`, `stop()`, `stopped()`,
  `pid()`, `wait().await -> Arc<RunOutput { code, stderr, events }>`. One task per run owns the child and its timers;
  callbacks run on it in order and must not block. Exit codes are Bun's (`128 + signal` when killed). Unlike Bun, a
  `stop()` before Claude has started counts (it is stopped as soon as it starts).
- After a run: `activity::extract_final_text`, `result::parse_result`, `retry::transient_error` (resume once after
  `RETRY_DELAY_MS` with `RETRY_TEXT`), `retry::limit_message` / `is_limit_text` (the plan-limit wait),
  `activity::summarize_event` for the card line, `model_versions::ModelVersions::learn` on each event.
- Run logs: `run_log::append_line` (holds the log's lock, restores a compressed log first; masking saved keys stays
  the caller's job, as in `store.appendActivity`), `restore_log` before a run starts, `log_stat`, `open_log`,
  `read_log`; `activity_digest::ActivityDigests::get` for edited files, run entries and session totals.
- `run_log_compress::RunLogCompressor::new(root, board, options).start()` with a `CompressBoard` (ticket lists, running,
  `activity_compressed`). Report-only unless `CKANBAN_RUST_DELETE=1`: it writes what it would do to
  `<data>/rust-board-dryrun.log` and keeps its handled list in memory (`run-logs-compressed.jsonl` stays Bun's).
- `side_call::SideCaller::call(SideCallInput)` and `add_side_spend` / `read_side_spend`; `connectors::board_connector_options`
  (and `set_known_connectors` from the Connections list); `awake::StayAwake::new(..).start()`; `claude::find_claude`,
  `list_sessions`, `list_claude_projects`, `claude_defaults`, `pick_folder`, `is_session_live`.
- `js`: the JavaScript rules the ports need to give Bun's exact bytes (UTF-16 lengths and cuts, `trim`, `Number`,
  `String`, `JSON.parse` with lone surrogates, `JSON.stringify` key order and numbers).

Checked against Bun: `tests/fixtures/runs.json` holds 252 inputs with Bun's answers (written by
`test/rust-board-runs-fixtures.test.ts`, part of `bun run test`; `UPDATE_RUST_FIXTURES=1` rewrites them) and
`tests/runs.rs` checks Rust gives the same JSON text. `tests/runner_fake.rs` runs `start_run` against the fake Claude
(`test/fixtures/fake-claude.ts`, needs Bun; skipped without it), never the real `claude`.

Every dependency the tasks are expected to need is already in `Cargo.toml` (referenced in `lib.rs` until used), so
parallel tasks don't clash on `Cargo.toml` and `Cargo.lock`.

## Tests

```sh
cd rust && ~/.cargo/bin/cargo test -p ckanban-board   # this crate's unit tests
bun run test:contract:rust-board                       # the files in contract-files.txt, board mode on
bun run test:contract:rust-board tickets.test.ts       # any contract file in board mode, listed or not
```

`contract-files.txt` lists the contract test files (or `file | test name pattern`) that pass in board mode; a listed
one that fails, fails the run. Each task adds what it makes pass; the flip needs every file listed whole.
`test/contract/rust-board-mode.test.ts` covers the switch and the three fallbacks (only in this run).
