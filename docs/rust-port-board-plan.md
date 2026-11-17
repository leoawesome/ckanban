# Rust port step 7 and after: the board, runs and chat in Rust

Plan for moving `src/board/`, `src/runs/` and `src/chat/` (about 19,500 lines of TypeScript), then `huddle/`,
`schedules/` firing, the rest of `usage/`, `browser/` and the routes left in `api/`, from Bun to Rust. Written
2026-11-17 for the main ticket t_20261116_g100. Background: `docs/rust-port.md` (trial results and the area order),
`rust/README.md` (the front server), `rust/core/README.md` (the data folder library).

TL;DR: the board's in-memory state must flip from Bun to Rust in one restart, but it does not have to be built in one
piece. The Rust core is built as separate modules behind a board mode (`CKANBAN_RUST_BOARD=1`) that nobody uses until
every contract test passes in it, so each task lands on `main` without changing the running board. At the flip Bun
stays as a small "satellite" child for the helper (notifications, push, Telegram) and the outside-service parts of
`integrations/`, which touch the board through a narrow, event-driven edge. Going back is one file and a normal
`ckanban restart`. 7 contract-test tasks and 20 Rust tasks; the first two waves can run side by side tonight, the flip
needs waves 1 to 5 done and Leo's go.

## 1. Why the board can't move in pieces

The trial moved usage, spend, passes and the CLI side by side because Rust could answer them from files alone. The
board can't do that, for three reasons found in the code:

- **Every ticket answer mixes files and live state.** `TicketView` (`view()` in `src/api/context.ts`) adds `running`,
  `holdsSlot`, `session`, `devices`, `folderWait`, `attention`, `huddleBusy`, `huddleLine`, `terminalOpen`,
  `shareJobs` and more to the ticket file. These come from `Board.runs`, the `SessionCache`, `Devices`, the huddles'
  `hostStates()` and the terminal watcher, all in Bun's memory. The same view goes out on every `ticket.updated`
  event. A Rust read route would have to ask Bun for that state on every call: the link step 5b already refused for
  browsers, at a much larger scale.
- **Two writers of `ticket.md` race.** Bun's `Store.updateTicket` reads the file, merges and writes it; its cache
  (`ticketCache`, keyed by mtime and size, re-checked every 30 s) would pick up Rust's writes, but two read-merge-write
  cycles at once lose one change, and plans, queues and run state depend on the order of changes.
- **Runs are children of the process that owns the board.** `startRun` (`src/runs/runner.ts`) pipes Claude's stdout
  into the board's run loop. A run can't be handed from Bun to Rust while it runs; it can only end and be resumed
  (`recover()` in `src/board/board-recovery.ts`), which is what a restart already does.

What can safely happen before the flip is reading: Rust computes the same answers from the same files and compares
them with Bun's, without serving them (shadow mode, section 4). That catches file, ordering, paging and family
differences on Leo's real board with no risk.

## 2. The Rust core

All of it builds on `rust/core` (`ckanban-core`: every data file read and written byte for byte like Bun, `JsonRecord`
keeping unknown fields, the YAML front matter, `JsonDir`, JSONL pages). New code goes into one new workspace crate,
`rust/board` (`ckanban-board`), one folder per area so parallel tasks don't touch each other's files; the server
(`rust/src/`) only gains a `board_mode` route table that calls into it.

### 2.1 Process model

- One tokio runtime. `Core` holds every service (`Store`, `Bus`, `Board`, `Runs`, `Sessions`, `Huddles`, `Devices`,
  `BoardBrowsers`, `Scheduler`, `Jobs`, `Loops`, `QuickChats`, `Learner`) as `Arc`s, built once at start like
  `startDaemon()` in `src/cli/daemon.ts`, in the same start order (load tickets, load lists, recover, huddles, quick
  chats, then the timers).
- **State and locks.** Board state lives in plain structs behind `parking_lot::Mutex`es, one per board for tickets and
  one for run state. The rule every task follows: never hold a lock across an `.await`, a directory walk, a git call or
  a transcript parse. Writing one ticket file (a few KB, atomic rename) is allowed under the board's lock, so file
  order equals state order, as in Bun's synchronous `updateTicket`.
- **Readers never wait on writers.** Each board's listing is an `Arc<BoardList>` (all tickets, open tickets, by id,
  a version) swapped on every write (`arc-swap`). List pages, the inbox and the command bar read the current snapshot.
- **Slow work off the runtime.** Directory walks, transcript parsing, run log compression, git and `gh` run in
  `spawn_blocking` or child processes. This is what removes the freezes: Bun did the same work on its one event loop
  with `pauser()` slices.
- **Lag log.** A 100 ms ticker measures its own delay and prints Bun's `[lag]` line format into `daemon.log`, naming
  the job that was running (each timer and start step registers a name, like `track()`).

### 2.2 Board in memory (port of `core/store.ts`, `board/`)

- `Ticket` is a typed view over a `JsonRecord`: getters and setters for the fields the board uses, the raw map kept,
  so fields Rust doesn't know survive a rewrite. Serialization goes through `ckanban_core::ticket`.
- `Store`: per board, ticket files parsed once and kept by mtime and size; a listing kept sorted and patched in place on
  each write (`placeTicket`); outside edits found by a background re-check every 30 s (`recheckTickets`) and when the
  tickets folder's mtime moves; the start-up load spread over a thread pool, all boards at once. Same for huddles, jobs,
  schedules and automations (`JsonDir`, already in `rust/core`).
- Families, plans and features are computed, not stored: the Rust port of `web/src/features/family/family.ts` (661
  lines, used 35 times by the server) works on a board snapshot. `ticket-scope.ts`, `cmdbar.ts`, `donePaging.ts`,
  `cardState.ts` and `columns.ts` are ported with it. Fixtures generated by Bun keep them equal.
- The board's write API (`Board::patch`, `create_ticket`, `update_ticket`, `delete_ticket`, `move_ticket`,
  `add_comment`) is the only way anything changes a ticket; each call writes the file, swaps the snapshot and emits
  the event, in that order.

### 2.3 Event stream (`/api/events`)

- `Bus` is a `tokio::sync::broadcast` channel of `Arc<BusEvent>` (capacity 4096) plus in-process subscribers (the
  notifier mirror, huddle watchers, the restart gate).
- The SSE route sends `: connected`, `: ping` every 15 s, then one `data:` line per event, masked with `mask.rs`, with
  `liveCut` applied to `activity` events. `ticket.updated` events carry the ticket's `TicketView`, built once per event
  and shared by all connections (Bun builds it per connection). `session.updated` and `huddle.updated` are followed by
  the extra `ticket.updated`, as `contracts/api.md` says.
- A connection that falls behind the channel (`Lagged`) is closed. The UI already reopens it and refetches when it
  may have missed events (`web/src/app/liveEvents.ts`), so a slow tab can't hold memory or slow others.
- In board mode the stream also carries the satellite's events (section 3.3).

### 2.4 Run manager (port of `runs/` and the run loop in `board/board.ts`)

- `RunHandle` as in `runner.ts`: `tokio::process::Command` in its own process group (`process_group(0)`), stdout read
  line by line as stream-json, stdin open for `--input-format stream-json` (`send`, `endWhenIdle`), control requests
  (`stop_task` with its 10 s answer timeout), background tasks with the 10 s grace, the stall watchdog (board's "Stall
  after", default 20 min), stop as TERM to the group then KILL after 5 s, `--max-budget-usd`.
- `buildArgs`, the MCP config, connectors and model versions as in `claude.ts`, `connectors.ts`, `model-versions.ts`.
- Run logs (`activity.jsonl`, `run-log.ts`, compression of Done tickets after 30 days), side calls (`side-call.ts`,
  `side-spend.jsonl`), keep-awake (`awake.ts`, `caffeinate`), results and retries (`result.ts`, `retry.ts`).
- The board run loop (`chat`, `start`, `begin`, `executeOnce`, `dropRun`, `endStatus`), slots and dispatch
  (`board-devices.ts`), the message queue (`board-queue.ts`), caps, stalls and plan-limit waits (`board-limits.ts`,
  `usage/limit.ts`), follow-ups (`board-followups.ts`, `schedules/followup.ts`), recovery, stop and the restart gate
  (`board-recovery.ts`).
- Prompts (`prompts-*.ts`, about 1,450 lines of text) are a pure module checked against fixtures Bun generates: every
  prompt builder over a table of inputs, byte for byte, like the usage fixtures.
- Sessions and transcripts: `session-cache/markers/parser/files.ts`, the Claude projects change feed (`changefeed.ts`,
  FSEvents through the `notify` crate), `session-summaries.json`, subagents and workflows.
- Git, copies of the folder and landing: `git.ts`, `worktree-setup.ts`, `diff.ts`, `board-repo.ts`, the PR poller,
  merge into main, land, branch, the worktree sweep. Every git call stays a child process (`git`, `gh`), as in Bun.
- Plain folders: every path in `PLAIN_WORDS`/`landRule` (no git, no commits, no remote, no `gh`) works the same, and
  C3 tests it.

### 2.5 Chat

Messages and the conversation (from transcripts, section 2.4), drafts (`chat/draft.ts`, `chat.draft` events, the
throttle), slash commands (`chat/commands.ts`, `claude-commands.json`), rewind, undo and fork, simplify and "help me
understand" (side calls), the Context panel (`context-usage.ts`), chat search and read with their reach rules, and
quick chats (`quickchat.ts`, its index and log files). All on the run manager above; quick chats are runs with a chat
id instead of a ticket.

### 2.6 Interfaces that let tasks build in parallel

The skeleton task (R0) defines these traits in `rust/board/src/api.rs` with stand-in implementations ("nothing
running", "no session", "no huddle", "no devices"), so a task can build and test its module before the module it calls
exists; the real implementation replaces the stand-in when its task lands:

| Trait | Methods (Bun source) | Implemented by |
| --- | --- | --- |
| `RunControl` | `is_running`, `running_key`, `holds_slot`, `start`, `stop`, `chat`, `active_work` (`Board`) | R7a |
| `SessionInfo` | `summary`, `version`, `entries` (`SessionCache`) | R5 |
| `HuddleInfo` | `host_states(slug)`, `restart_busy()` (`Huddles`) | R11a |
| `DeviceInfo` | `device_state`, `release_all(lease)`, `browser_picks` (`Devices`, `BoardBrowsers`) | R9 |
| `Landing` | `merge_into_main`, `land`, `cleanup_worktree`, `repo_state` (`board-main.ts`, `board-repo.ts`) | R6 |
| `Satellite` | `chat_from_telegram`, `notify_message`, `pass_call`, `frontdesk_gate`, `publish_artifact` | R13 |

## 3. The switch

### 3.1 Board mode

- `ckanban-rs dev` runs as today (front server, Bun does everything) unless board mode is on. Board mode is on when
  `CKANBAN_RUST_BOARD=1`, or when that variable is unset and the file `<data>/rust-board` contains `on`. The file is
  how the real board switches: writing it and running `ckanban restart` flips at the next idle moment through the
  existing restart gate (runs finish first, at most 2 minutes, see 5.2), with no launchd reload. `scripts/rust-trial.sh
  board` writes it (after `on` if the front isn't installed yet); `scripts/rust-trial.sh on` and `off` remove it.
- In board mode Rust owns the board, runs, chat, quick chats, sessions, huddles, schedules, jobs, automations,
  follow-ups, limits, devices, board browsers, named Chromes, the terminal, the PR poller and the phone access
  listener. Bun runs as the satellite (3.3).
- **Instant fallback, three ways.** (1) `rm <data>/rust-board && ckanban restart` (or `scripts/rust-trial.sh on`):
  Bun takes the whole board again at the next idle moment. (2) If the Rust core fails to start (a file it can't read,
  an old-style plan only Bun's one-time migration handles, the data lock held), `ckanban-rs` starts Bun in full mode
  instead and writes why into `daemon.log` and `<data>/rust-board-status.json`. (3) If the process dies three times
  within 10 minutes in board mode (counted in that status file), the next start falls back to Bun the same way.
  Every fallback is safe because Rust writes every file in Bun's exact format (`rust/core`), so Bun reads Rust's state
  as its own, including interrupted runs to resume.
- **One owner of the data folder.** Board mode and Bun's full mode both take an exclusive `flock` on
  `<data>/board.lock` before loading the board, and refuse to start the board without it. Today nothing stops two
  daemons on one data folder; a mistake while testing board mode on Leo's folder could otherwise write tickets from two
  processes. Test daemons use temp data folders and are unaffected.

### 3.2 Building it behind the flag

- Each task lands on `main` with board mode off by default, so the real board keeps running exactly as before. The
  usual checks stay green: `bun run test`, `bun run test:contract:rust` (front mode).
- `bun run test:contract:rust-board` (added by R0) runs the contract tests against `ckanban-rs dev` with
  `CKANBAN_RUST_BOARD=1`. Only the files listed in `rust/board/contract-files.txt` are expected to pass; each task adds
  the files it makes pass, and a listed file that fails, fails the run. The flip needs every contract test file in the
  list.
- Every Rust module with logic Bun has (families, scopes, prompts, transcript parsing, cron, attention) is checked
  against fixtures Bun generates (`UPDATE_RUST_FIXTURES=1`), as `rust/core` does today; a Bun change that alters a
  fixture fails `bun run test` until the Rust side follows.
- Bun changes for board mode (satellite mode, the data lock, the read-only store guard, the test hooks of C6 and C7)
  are inert unless their variable is set, so full mode behaves as before.

### 3.3 The Bun satellite (helper and outside services)

At the flip Bun keeps the parts whose link to the board is narrow and already event-driven, and which Rust doesn't
need in memory: the helper (`helper/`: notifications, push, Telegram, front desk, the helper runner, messages) and
the outside services of `integrations/` that already pass through the front (MCP servers and their sign-ins, agents
install, phone access on and off, pass sign-in and `tools`, bug reports, artifact publishing). They move to Rust
after the flip (P1, P2), one at a time, the same side-by-side way the trial moved usage.

`ckanban-rs dev` starts the child as `bun src/cli.ts dev` with `CKANBAN_SATELLITE=1` added. In that mode
`startDaemon()` builds no `Board`, scheduler, jobs, loops, huddles, quick chats, session watcher or ticket re-check;
its `Store` reads files but any ticket write throws (and is logged), so it can never write `ticket.md` behind Rust's
back. The edge, all of it:

| Direction | What | How |
| --- | --- | --- |
| Rust to satellite | Bus events (`ticket.updated` with its view, `ticket.deleted`, `activity`, `session.updated`, `profile.updated`) | Lines `event <json>` on the child's stdin, after the existing secret line ("later stdin lines are notices from the front") |
| Rust to satellite | Live state the helper asks synchronously: `isRunning`, `hostHuddles`, `sessionSummary` | A snapshot line `runtime <json>` at start, then one `runtime <json>` line per change; the satellite answers from this mirror |
| Satellite to Rust | Its events (`helper.updated`, `helper.message`, `messages.updated`, `mcp.updated`, `integration.updated`) | Rust subscribes to the child's own `/api/events` and re-emits each message into its stream (no Bun change) |
| Satellite to Rust | Board actions: the notifier's `addComment` (Telegram's `chatFromTelegram`, `patchTelegram`, `dropTelegramQueued` and the Confirm replay ended with P1c) | HTTP to Rust's port on `/api/internal/...`, with the front secret the child already has |
| Rust to satellite | Front desk gate (requests with `x-ckanban-frontdesk`), pass tool calls for automations (`automation-call` after Rust checks the script's token), share-to-claude.ai publishing | HTTP to the child's internal port on `/api/internal/...` with the secret |
| Rust to satellite | Routes it still owns: `/api/notify*`, `/api/push*`, `/api/telegram/*`, `/api/mcp*`, `POST /api/agents/*`, `POST /api/remote`, pass sign-in, `tools` and OAuth callback, `/api/bug-report*` (`/api/messages*`, `/api/helper*` and a ticket's `notify` are Rust's since P1a) | Passed through as today, with `x-ckanban-peer-port` |
| Both ways (P1a to P1c) | The helper, its sending, Telegram and the front desk run in Rust | The satellite asks `helper-send-message`; Rust no longer asks it anything for the helper |

The satellite is about 500 lines of throw-away code on each side. The alternative, porting the helper (8,600 lines)
before the flip, would delay the step that removes the freezes by that much. Huddles are not on this list: their live
state (agents mid-turn, wakes queued) is in every ticket view and they start ticket runs, so they move with the core.

### 3.4 Shadow mode (before the flip, read only)

With `CKANBAN_RUST_SHADOW=1` (front mode, Bun answers as usual), Rust also computes its own answer to
`GET .../tickets?scope=board|done|ids|search|list|count`, `GET /api/tickets` and `GET /api/inbox` from the files,
taking the live fields (`running`, `session`, `devices`, `huddleBusy`...) from Bun's answer, and appends any
difference (ids and field names only, no text) to `<data>/rust-shadow.log`. Never served, never writes data. R1
builds it; it can run on Leo's board as soon as the front is on, and shows real-board differences days before the flip.

## 4. Where the other areas attach

| Area | At the flip | How it reaches the core |
| --- | --- | --- |
| Huddles (`huddle/`) | In Rust (R11a to R11c) | Calls `RunControl::chat` and `ensure_session` to wake ticket participants; its agents are runs of the run manager with a huddle lease; registers `host_states` and `restart_busy`; emits `huddle.*` events; holds board browsers through `DeviceInfo` |
| Helper, notifications, push, Telegram, front desk | Bun satellite (3.3), Rust later (P1) | Mirror of events and live state; actions over `/api/internal` |
| Schedules firing, one-time jobs, automations, follow-ups (`schedules/`) | In Rust (R10; follow-ups in R7a) | Timers on the runtime; `create_ticket`, `create_feature_task`, `task_place_for`, `RunControl::start`, the restart gate; automation pass calls go to the satellite until P2 |
| Usage limits and auto-continue (`usage/limit.ts`) | In Rust (R7a) | `due_continues`/`continue_after_limit` on the board; plan usage from the existing `UsageCache` (already Rust) |
| Ticket Usage tab, team usage (`usage/ticket-usage.ts`) | In Rust (R12) | Reads run logs and `usage-windows.json` (already shared) |
| Devices, board browsers, named Chromes, terminal (`browser/`) | In Rust (R9) | `DeviceInfo`; a run's end releases its lease; `ChromeWatch` reads run output from the run manager; the shell WebSocket on a pty (`portable-pty`); Chromes of board browsers are detached and adopted on start, as Bun does |
| `browser-mcp`, `artifact`, `remote`, `update` commands | Bun commands, as today | Started as `bun src/cli.ts <cmd>` (the CLI handoff already exists); later P3 |
| Routes left in `api/` | Each with its area; system routes, the request gate and the phone listener in R13 | The route table of board mode |

## 5. Risks to Leo's real board

### 5.1 Data written by both processes

| Data | Who writes it in board mode | How the risk is avoided |
| --- | --- | --- |
| `ticket.md`, `comments.jsonl`, `activity.jsonl`, chats, plans, outputs | Rust only | Satellite store throws on ticket writes; the notifier's comments go through `/api/internal`; `board.lock` keeps a second full daemon out |
| `usage-last.json`, `usage-windows.json`, `automation-passes.json` | Both, as today | Already shared safely (re-read on change, atomic rename, `flock`) |
| `session-summaries.json` | Rust only | The satellite runs no `SessionCache`; it gets summaries from the mirror |
| Helper files: `waits.json`, `messages.json`, `helper-state.json`, `helper.json`, `notify.json` | Rust only (since P1a) | The satellite's stores only read them (again when they change) and send their writes to Rust (`notify-write`, `wait-seen`, `helper-send-message`); any other write throws |
| Push devices | Satellite only | Rust never opens them until P1b |
| Telegram stores (`telegram-links.json`, `-pending`, `-updates`, `-offset`, `-frontdesk`, `-desk-spend`) | Rust only (since P1c) | The satellite's notifier never polls the bot and leaves them alone |
| `board-tools.json`, `mcp-seen.json`, `remote.json` | Satellite only | Rust reads them (run MCP config, the phone listener re-reads `remote.json` on mtime change) |
| Huddles, schedules, jobs, automations, devices, browsers files | Rust only | Moved together with their in-memory owners |
| Every file on a flip back | Bun | Rust writes Bun's bytes (`rust/core` fixtures), keeps unknown fields (`JsonRecord`) and never adds fields Bun doesn't know |

### 5.2 Runs in flight during a switch

- The flip and every fallback go through `POST /api/restart` (`requestRestart`): no new run starts, active runs,
  huddle agents mid-turn and quick chats get up to 2 minutes, then the process exits and launchd starts it again.
  Runs cut off then are marked interrupted (`markInterrupted`) and resumed by `recover()` in the new process. Rust's
  `recover()` must take exactly Bun's leftovers and leave exactly Bun's, which C2 tests both ways (Bun stops a run,
  Rust resumes it, and the reverse).
- `scripts/rust-trial.sh` keeps refusing while runs are active; the file switch never reloads launchd.
- Board browsers are detached Chromes the next daemon adopts; R9 adopts Bun's and leaves state Bun can adopt.
  Terminal shells end on any restart today; that stays the same.

### 5.3 Deleting things

A bug in a background job that deletes could lose work no restart can bring back. In board mode the background
deleters (worktree sweep, run log compression, temp file sweep, dropping rewind copies of Done tickets, huddle helper
copies, a removed board browser's folder) start in report-only mode: they log what they would delete to
`<data>/rust-board-dryrun.log` and delete nothing. F1 compares that list with Bun's own decisions on a copy of the
real data folder; only then are they switched on (`CKANBAN_RUST_DELETE=1`, then the default). User-started deletes
(a ticket, a schedule, a board) work from the start, covered by contract tests.

### 5.4 Other risks

- **Testing on the real data folder.** A daemon started on the real repo or data folder sweeps ticket worktrees.
  Every task tests in a temp data folder and a `/tmp` clone; the real-board checks of F1 run on a copy.
- **Transcripts.** Claude's session files are external and private. Fixtures are made by the fake Claude, and a
  read-only check over the real `~/.claude/projects` prints only counts of mismatches (like
  `CKANBAN_PARITY_HOME`), never content.
- **Prompt drift.** Runs behave differently if a prompt changes by a word; prompt fixtures catch it in `bun run test`.
- **`ckanban install` undoes the front.** As in `docs/rust-port.md`: an install rewrites the launchd file to Bun. The
  `rust-board` file then does nothing (Bun alone ignores it), which is safe.
- **Two copies of the logic while both exist.** Until Bun is removed, a board change must be made in both. Fixture
  and parity tests make a one-sided change fail; tickets touching board logic during the port should be few.

## 6. Contract tests needed first (Bun only, TypeScript)

These run against Bun today, then against board mode. They import nothing from `src/` (`no-src-imports.test.ts`).
Each starts now, side by side with each other and with R0.

| Task | Covers (gap list of `docs/rust-port.md` plus what the flip needs) | Needed by |
| --- | --- | --- |
| C1 tickets and families | Families: `partOf`, main tickets, tool tickets, sub-features, `gather`, `own-work`, `family`, `family-view`, `status` and `status/notes`; links; tags and `suggestedTags`; attachments (upload, serve, info, headers); all card routes; snooze, seen, follow-up set and cancel; profile PATCH and DELETE; ticket list scopes and paging on a board with many Done tickets; `ticket.updated` events carry the view | R1, R2a, R2b, R12 |
| C2 runs | Stop and resume; queued messages (send, edit, delete); fresh chat, fresh session, take-over, link-session; stall, cap and limit actions (fake modes `silent`, `budget`, `limit`); restart with a run in flight and its resume, both from Bun to Rust and back; a follow-up and a main ticket cut by a restart; devices let go at a run's end; activity paging; ticket `/usage` | R3, R5, R7a |
| C3 copies of the folder and landing | A git board in a temp folder: copies per ticket, `diff`, `merge-into-main`, `land`, `branch`, `move`, the sweep; a plain-folder board doing the same work with no git; `outputs`, `file`, `find-files`, `files`; `version-history` routes; PR routes with a stub `gh` | R2b, R6 |
| C4 chat and quick chats | Drafts (`chat.draft` events); `/` commands list and sending one; conversation paging; tool, agent and workflow details; rewind preview, rewind, undo; fork; simplify and help with `FAKE_SIDE_JSON`; chat search and read and their reach; context GET and POST; every quick chat route | R5, R7b, R8 |
| C5 huddles and team | Start, post, brief, status, add participants, mode, stop, restart, hand-ins, findings, close-request, close, seen, learnings, invite; an auto huddle started from a run; presets, templates, squads, learned, notes; `team-usage` | R11a, R11b, R11c |
| C6 work the board starts by itself | One-time jobs firing a few seconds ahead; `schedules/:sid/run` and a schedule firing on time; automations (`check`, `copy`, column and auto start, `automation-call` with a script token); follow-ups firing. Needs a test hook for the timer period (`CKANBAN_TICK_MS`), added to Bun and to `contracts/api.md` | R10 |
| C7 helper side | Notify settings, messages pages and buttons, push subscribe, remove, visible and test against a local fake push endpoint; Telegram pair, a message in, a reply out, a held front desk request and its Confirm, against a fake Bot API (`CKANBAN_TELEGRAM_URL`, a new test hook: the URL is fixed in `helper/telegram.ts` today); inbox | R13, the satellite check in F1, P1 |

## 7. Rust tasks

Sizes are the TypeScript ported; the Rust is usually 1.2 to 1.5 times that with tests (the trial: usage 1,470 lines
of TypeScript became about 1,620 of Rust). Every task: code in its own folder of `rust/board/src/`, Bun fixtures for
pure logic, its contract files added to `contract-files.txt`, board mode still off by default.

| Task | What | TS ported | Needs first | Contract files to pass in board mode |
| --- | --- | --- | --- | --- |
| R0 skeleton and switch | `rust/board` crate with empty module folders for every task below and all expected dependencies added once (fewer `Cargo.lock` clashes); the traits of 2.6 with stand-ins; `Core` start and stop order; `Bus` and `/api/events`; board mode, the `rust-board` file, the three fallbacks and `rust-board-status.json`; `board.lock` in Rust and in Bun; Bun satellite mode with the read-only store guard and the stdin mirror; re-emitting the satellite's events; `bun run test:contract:rust-board` and `contract-files.txt`; `scripts/rust-trial.sh board` | about 600 (daemon start, events route, store guard) | nothing | `callers.test.ts` (event stream part) |
| R1 board index and read routes | Ticket cache and listings, background re-check, start-up load on a thread pool; family, scope, command bar, done paging, card state, columns, links, tags; attention (`helper/attention.ts`, pure part); `TicketView`; ticket GET scopes, `/api/tickets`, `/api/inbox`, `/api/profiles` GETs; shadow mode | about 3,000 | R0, C1 | `tickets.test.ts` (reads), C1 (reads) |
| R2a ticket writes | Create, update, delete, move; comments; run rights; masking saved keys in answers and comments as `contracts/api.md` says at the time; attachments; avatars; snippets; all card routes; profiles POST, PATCH, DELETE, detect-setup | about 2,200 | R1 | `tickets.test.ts`, C1 (writes), `passes.test.ts` (key cards, masking), `data-files.test.ts` (ticket files) |
| R2b families, plans, main tickets | `board-families`, `board-plans`, `board-main` (without git), `board-features`, `feature.ts`, `main-ticket.ts`, `plan.ts`, status file; old-style plans refuse board mode (fallback 2) instead of porting `retire-plans.ts` | about 2,600 | R2a | C1 (families, status), C3 (merge and land rules) |
| R3 run engine | `runner.ts`, `claude.ts`, `side-call.ts`, `result.ts`, `retry.ts`, `activity.ts`, `activity-digest.ts`, `run-log.ts`, `run-log-compress.ts` (report-only first), `connectors.ts`, `model-versions.ts`, `awake.ts`, `live-cut.ts`; tested against the fake Claude | about 2,100 | R0 | none alone (library) |
| R4 prompts | `prompts-rules/-chat/-planning/-huddle/-main.ts`, `questionForms.ts`; Bun fixture table, byte for byte | about 1,600 | R0 | none (fixtures) |
| R5 sessions and transcripts | `session-*.ts`, change feed on FSEvents, `session-summaries.json`, subagents, workflows, chat cache, tool details, chat search and read; routes `conversation`, `tool`, `agent`, `workflow`, `chat/search`, `chat/read`, `sessions` | about 2,900 | R0 | C4 (conversation, details, search) |
| R6 git, copies and landing | `git.ts`, `worktree-setup.ts`, `diff.ts`, `board-repo.ts`, `prstatus.ts`, `prpoller.ts`, `prs.ts`, `share.ts`, `core/files.ts`; merge into main, land, branch; the sweep (report-only first); file and output routes, `version-history`, PR routes; `detectMissing` | about 2,200 | R0, C3 | C3 |
| R7a run loop | `board.ts` run loop, `board-queue`, `board-devices` (slots, dispatch), `board-limits` and `usage/limit.ts`, `board-followups` and `schedules/followup.ts`, `board-recovery` (recover, stop, stop family, restart gate, shutdown), `board-types`; routes `chat`, `queued`, `stop`, `restart`, `awake`, `stall`, `cap-continue`, `limit`, `follow-up/now`, `merge-into-main`, `land`, `ask`, `plan` | about 2,800 | R2b, R3, R4, R5, R6 | C2, `tickets.test.ts` (chat part), `browsers.test.ts` (devices at run end) |
| R7b chat extras | Slash commands, drafts, rewind and undo, fork, simplify, explain, Context panel, fresh chat, fresh session, take-over, link-session, `help`, `planning-command` | about 2,100 | R7a | C4 (ticket chat) |
| R8 quick chats | `quickchat.ts`, `quickchat-index.ts`, chats routes | about 1,100 | R3, R4, R5 (R7a for the restart gate) | C4 (quick chats) |
| R9 browsers, devices, terminal | `devices.ts`, `chromes.ts`, `board-browsers.ts`, `cdp.ts`, `sign-in-signs.ts`, `shell.ts` (pty), `terminals.ts`; adopting Bun's running Chromes; browsers and devices routes, the shell WebSocket | about 2,600 | R0 | `browsers.test.ts`, `callers.test.ts` (terminal) |
| R10 schedules, jobs, automations | `scheduler.ts`, `cron.ts` (fixtures), `jobs.ts`, `loops.ts`, `schedule-history.ts`, `quiet.ts`, `checkin-guides.ts`, `automation-proposal.ts`, `integrations/script.ts` and `ask-claude.ts`; schedules, loops, jobs, cron preview, `automation-call` (pass calls to the satellite) | about 2,400 | R7a, C6 | `schedules.test.ts`, C6, `passes.test.ts` (scripts) |
| R11a huddle rooms | `huddle.ts`, types, roster, routing, messages, changing, hand-ins, the `huddles` routes, `host_states` | about 2,200 | R2a, R5 | C5 (rooms) |
| R11b team | Presets, templates, notes, squads, teammate proposals, plan review file, the team routes | about 1,400 | R0 | C5 (team) |
| R11c huddle agents | `huddle-session.ts`, `huddle-agents.ts`, copies and output copies (report-only cleanup), auto huddles, lifecycle and watchdog, huddle usage | about 1,800 | R7a, R11a | C5 (agents, auto huddle) |
| R12 board extras | `learner.ts`, `learn.ts`, `lessons.ts`, `linker.ts`, `recall.ts`, `mockups.ts`, `ticket-usage.ts`, `team-usage` | about 2,200 | R2a, R3 | C1 (`find-links`), C5 (learned), C2 (`/usage`) |
| R13 gate, system routes, satellite edge | The request gate (`api/server.ts`: Host, Origin, JSON type, front desk header) in board mode; the phone access listener in Rust; system routes (`health`, `version`, `claude/*`, `pick-folder`, `cron/preview` if R10 isn't in, `debug/profile`); update checker; housekeeping (report-only deletes); the satellite edge of 3.3 (front desk gate, Telegram actions, comments, replay, pass calls, publish) | about 1,200 plus about 500 in Bun | R0, C7 | `remote.test.ts`, `connections.test.ts`, `passes.test.ts`, C7, `data-files.test.ts`, `usage.test.ts` |
| F1 ready to flip | Every contract file in board mode; a board parity test (same script on Bun full and Rust board, files and answers compared, ids and times masked, like `rust-parity.test.ts`); a dry run on a `/tmp` copy of Leo's data folder with the fake Claude and a stub `gh` (every board's pages and ticket views compared with Bun on the same copy, start-up writes compared, the report-only deleters' lists compared with Bun's, then deleting switched on); the 10,000-ticket bench (`scripts/rust-trial-bench.ts`): longest stall and start time against Bun; README and `docs/rust-port.md` updated | tests and docs | all of R0 to R13 | all |
| F2 the flip | With Leo's go: `scripts/rust-trial.sh board`, the restart at an idle moment, `daemon.log` and the UI on desktop and phone checked for 30 minutes, then the result reported; how to go back in one line | none | F1, Leo | none |

### 7.1 Order and what runs side by side

- **Wave 0 (now):** C1 to C7 and R0, all side by side (eight tickets). C tasks touch only `test/contract/` plus the two
  small Bun test hooks; R0 touches `rust/`, `src/cli/daemon.ts` and `src/core/store.ts`.
- **Wave 1 (after R0):** R1, R3, R4, R5, R6, R9, R11b, R13. Eight side by side; each owns its folder. R6 and R13 also
  wait for C3 and C7 before they call themselves done.
- **Wave 2 (after R1):** R2a; then R2b, R11a and R12 (after R2a).
- **Wave 3 (after R2b, R3, R4, R5, R6):** R7a, with R8 side by side.
- **Wave 4 (after R7a):** R7b, R10, R11c side by side.
- **Wave 5:** F1, then F2 on Leo's go.

The critical path is R0, R1, R2a, R2b, R7a, then R7b/R10/R11c, then F1: seven steps one after another. At about
2 to 4 hours per task including review, that is more than a night. Realistic for tomorrow morning: wave 0 and most of
wave 1 landed, shadow mode running on the real board. The flip itself is likely one to three days out.

### 7.2 After the flip

- **P1 helper to Rust:** `helper/` (8,600 lines) in two or three tasks (runner and decisions; notifications and push
  with the `web-push` crate; Telegram and the front desk), against C7. Removes most of the satellite. P1a (runner,
  decisions, waits, messages, settings files, the Messages and helper routes) is in: `rust/board/src/helper/`. P1b
  (sending: the Mac banner, phone push on aws-lc-rs instead of the `web-push` crate, which needs OpenSSL; push.json;
  `/api/notify...` and `/api/push...`) is in. P1c
  (Telegram: the poller, pairing, alerts, replies, forms, a ticket's answer back; the front desk: its chats' rights
  and cap, the request gate, Confirm cards and their replay, send_file) is in: `rust/board/src/telegram/`, wired in
  `rust/src/board_mode/tg.rs`; the satellite keeps no Telegram.
- **P2 integrations to Rust:** MCP servers and sign-ins, agents install, phone access on and off, pass sign-in and
  `tools`, bug reports, artifact publishing. Removes the satellite. Done 17 Nov (`rust/src/outside/`, see
  `rust/README.md`): the satellite keeps only the helper's routes, the front desk gate and Telegram's turn end (P1);
  publishing runs `ckanban artifact publish-output` until P3 ports that helper.
- **P3 the last Bun commands:** `browser-mcp`, `artifact`, `remote`, `update`; the last 13 MCP tools in `ON_BUN`. Done
  17 Nov: the CLI and `ckanban-rs mcp` never start Bun; `update` answers as from source until P4 ports the release download.
- **P4 Bun gone:** the release binary built from Rust (with the web UI embedded), the installer and `ckanban update`
  on it, Bun's server code deleted, the contract tests kept as the only tests of the outside behaviour. Done 18 Nov
  for Leo's Mac only (no release): `src/` deleted but for a hand-off in `src/cli.ts`, the server serves `web/dist`,
  the contract tests run against the binary, the side-by-side tests check Bun's recorded answers
  (`test/contract/golden/`). The release binary, installer and `ckanban update` stay to do (`docs/rust-port.md`, P4).

## 8. Rules every Rust task follows

- Board mode stays off by default until F2; `bun run test` and `bun run test:contract:rust` stay green on every landing.
- No lock held across an await, a directory walk, git or a transcript parse; slow work in `spawn_blocking` or a child.
- Every file read and written through `rust/core`; no new file formats, no new fields.
- Pure logic Bun also has gets Bun-generated fixtures; answers get contract tests in board mode.
- Background deletes start report-only (5.3).
- Tests use temp data folders and `/tmp` clones, never the real data folder or repo.
- Plain words for anything a user sees, and the plain-folder path (no git) works for every feature.
