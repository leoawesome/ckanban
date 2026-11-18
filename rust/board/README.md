# rust/board

`ckanban-board`: the board, runs and chat of ckanban in Rust, built behind **board mode** so each task can land on
`main` without changing the running board. The plan, the order of tasks and the rules every task follows are in
`docs/rust-port-board-plan.md` (sections 2, 3, 7, 8). The server (`rust/src/board_mode.rs`) calls into this crate.

## The board (board mode until P4)

Since the Rust port's P4 this crate is the only board: `ckanban-rs dev` takes `<data>/board.lock` (another daemon
holding it stops the start), starts the `Core` and everything below, and runs no Bun. It was built task by task
behind "board mode" (`CKANBAN_RUST_BOARD=1` or `<data>/rust-board`), with Bun's daemon as its satellite for what wasn't
ported yet and fallbacks to Bun's full mode; the switch, the satellite (`src/satellite.rs`, `gate/edge.rs`'s client)
and the fallbacks went with P4. `src/mode.rs` still writes `<data>/rust-board-status.json` (each start, a clean stop,
unclean ends of the last 10 minutes). The sections below were written as each task landed: where they speak of the
satellite, Bun answering a route or board mode being off, that is how it was before P4.

## What is here (R0)

- `src/api.rs`: the interfaces between modules (plan 2.6) with stand-ins ("nothing running", "no session", "no
  huddle", "no devices"...). A task replaces its stand-in in `Services` (`core.rs`) when it lands:
  - `RunControl` (R7a): is a ticket running, its run key and slot, start, stop, chat, active work, busy boards, running tickets.
  - `SessionInfo` (R5): a session's summary, version and entries.
  - `HuddleInfo` (R11a): each board's huddles by host ticket, what a restart waits for.
  - `DeviceInfo` (R9): a ticket's devices, letting go at a run's end, browser picks.
  - `Landing` (R6): merge into main, land, clean up a copy, the folder's repo state.
  - `Satellite` (R13; since P4 the server's `outside::edge::OutsideSatellite`, nothing goes to Bun): turn ended,
    pass calls, the front desk gate, publishing.
  - `BoardActions` (R2a, R7a): Telegram's chat and marks on the run loop, comments.
  - `TicketViews` (R1): a ticket's `TicketView` for events and answers.
  - `ActivityCut` (R3): `liveJson`, run events without their long strings.
- `src/core.rs`: `Core` (root, bus, services); start steps in Bun's order (load tickets, load lists, recover,
  huddles, quick chats, timers), each empty until its task fills it; `on_stop` hooks run newest first.
- `src/bus.rs`: the bus (broadcast channel, capacity 4096, plus in-process subscribers).
- `src/events.rs`: `GET /api/events` (connected, ping every 15 s, one `data:` per event, views, `liveJson`, masking,
  a slow connection closed).
- `src/mode.rs`: the switch, the fallbacks and the status file. `src/lock.rs`: `board.lock`.
- `src/index/` (R1): every board's ticket files parsed once and kept by mtime and size, each board's listing shared as
  one `Arc<BoardList>`; the start-up load on a few threads in the background (a board's first listing waits for it);
  the 30 s re-check; families, scopes and Done paging, a main ticket's card, attention, links, the command bar;
  `TicketView` with live state through `Live` (the services' stand-ins until their tasks land); the read routes
  `GET /api/profiles`, `/api/profiles/:p`, `/api/profiles/:p/tickets` (every scope), `/api/profiles/:p/tickets/:id`,
  `/api/tickets`, `/api/inbox`. `api::TicketViews` is filled from it (`core.rs` `IndexViews`).
- One empty folder per later task (filled as each lands): `index` (R1, done), `tickets` (R2a, done), `families` (R2b, done), `runs` (R3), `prompts` (R4, done),
  `sessions` (R5), `git` (R6, done), `runloop` (R7a, done), `chat` (R7b, done), `quickchat` (R8), `browsers` (R9), `schedules` (R10, done),
  `huddles` (R11a and R11c, done), `team` (R11b, done), `extras` (R12, done), `gate` (R13).

## The run engine (R3, `src/runs/`)

A library for the run loop (R7a); nothing calls it at run time yet except `LiveCut` (the event stream's
`ActivityCut`). One file per Bun file, listed in `src/runs/mod.rs`. What R7a calls:

- A ticket's Claude process (its `CKANBAN_TICKET` set) gets `TMPDIR` = its own folder under
  `<system temp>/ckanban-runs/`, removed when the process ends (`run_temp.rs`).
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
  `activity_compressed`). Report-only with `CKANBAN_RUST_DELETE=0`: it then writes what it would do to
  `<data>/rust-board-dryrun.log` and keeps its handled list in memory.
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
  ticket's run (family and "asked by the user" reach: R2b's rules are in, the run state they read comes with R7a).
- `ticket_files.rs`: `TicketSource`, read from the ticket files until the ticket store (R1/R2a) replaces it.
- `service.rs`: `Sessions`, the `SessionInfo` the other modules use (summaries from the watcher, no file read).

Parity with Bun: `tests/sessions_markers.rs`, `sessions_agents.rs`, `sessions_parse.rs` read the fixtures in
`tests/fixtures/sessions/` (inputs with Bun's answers, filled by `test/rust-board-*-fixtures.test.ts`; after a
deliberate change to Bun's code: `UPDATE_RUST_FIXTURES=1 bun test test/rust-board-<name>-fixtures.test.ts`). Parse
speed: `R5_BENCH=<transcript> cargo test --release -p ckanban-board --test sessions_parse -- --ignored --nocapture`.

## Gate, system routes and the satellite edge (R13, `src/gate/`)

In board mode every request goes through `BoardMode::handle` (`rust/src/board_mode.rs`) in Bun's order: the
satellite's own calls, then the gate (`gate::request::refusal`, Bun's `requestRefusal`: Host, the Origin of a change;
on the phone access listener phone access on in `remote.json`, the tailnet host, the owner's login), then the system
routes (`/api/events`, `health`, `version`, `claude/projects`, `claude/defaults`, `pick-folder`, `cron/preview`,
`debug/profile`), each after the front desk's gate (P1c: Rust's own, `crate::telegram`) and the JSON-only rule; then the other
tasks' routes (R1, R5, R8, R6, R9, R11b); then the front's native routes and Bun, which checks the gate again. Before
any of it the request target is read as Bun's `new URL` reads it (`proxy::normalize_target`: `..`, `.` and their
`%2e` forms resolved), so a path like `/api/x/../profiles/...` can't reach Bun's stale copy of a Rust-owned route.
On the phone listener the other tasks' routes see the phone request with this Mac's Host and Origin (their own
checks); their user-only checks look at the caller (`tailscale serve`) and refuse the phone.

- The phone access listener is Rust's (`rust/src/phone.rs`, on CKANBAN_REMOTE_PORT, which Rust passes to the
  satellite so `ckanban remote on` points `tailscale serve` at it). A phone request Rust passes on carries
  `x-ckanban-front-via: remote`; Bun then treats it as a phone request (`listener: "remote"`, user-only routes pass
  for the owner's phone). Every answer there carries `x-ckanban-listener: remote`. Rust tells the satellite of
  phone visits for `lastVisit` (the server's `outside::phone` since P2).
- Tailscale itself moved to the server in P2 (`rust/src/outside/phone.rs`): `/api/remote` (on, off, status) and the
  link check that puts Tailscale's HTTPS 443 link back at this listener when it goes missing (every 3 minutes while
  phone access is on). The satellite runs no link check in board mode.
- The satellite's edge (`POST /api/internal/<name>`, `gate/edge.rs`'s client) went with P4; `gate/edge.rs` keeps only
  the secret check the front desk header uses. A confirmed front desk request runs as the user through the server's
  own routes.
- Housekeeping (`gate/housekeeping.rs`): the temp file sweep and the daemon.log trim run at start, and delete
  (report-only to `rust-board-dryrun.log` with `CKANBAN_RUST_DELETE=0`).
- `cron/preview` uses `schedules::cron` (brought in here; R10 builds the scheduler on it).
- `tests/fixtures/gate.json`: Bun's answers for `requestRefusal`, `isAllowedSocket`, `cronError`, `describeCron`,
  `nextRuns` (in America/Los_Angeles, DST days included) and `isNewer`, written by
  `test/rust-board-gate-fixtures.test.ts`; `tests/gate.rs` checks Rust gives the same.

## Quick chats (R8, `src/quickchat/`)

Chats with Claude in a board's folder that aren't tickets (the Ask tab, the Claude panel), ported from
`src/chat/quickchat.ts`, `quickchat-index.ts` and `src/api/chats.ts`. Files under `profiles/<slug>/chats/` are written
in Bun's exact format (key order kept), so Bun and Rust read each other's chats.
- `text.rs`: titles, the run note, attachment paths, live drafts, "session missing", the error line.
- `index.rs`: the chat list newest first, kept between lists (a chat file is read again only when it changed; the
  folder isn't walked while its mtime stays the same); pages for "Load older". The lock is taken per file during a walk.
- `service.rs`: `QuickChats`: send (new chat, to a reply in progress, or a new reply), runs on the R3 engine (drafts
  every 120 ms, the activity line every second, result lines in `<id>.activity.jsonl`), stop, rename, delete, a lost
  conversation carried on in a new one, `shutdown` (replies in progress marked `interrupted`) and `recover`.
- `routes.rs`: in board mode Rust answers every `/api/profiles/:p/chats...` route. User actions use the same caller check
  as the passes routes (`guard::user_only`).

Stand-ins, each marked `STAND-IN` in the code: the restart gate (`RestartGate`, R7a: never "pending" until then; R7a
also counts `restart_busy()` among what a restart waits for), board browsers for the runs (R9). The Telegram front
desk plugs its hooks in (`ChatHooks`, P1c: env, note, narrower rights, result lines, unbilled cost). The Context panel, Say it simpler, Rewind,
Undo rewind, Fork and Make ticket are R7b's (`src/chat/`). User actions from the phone come through the phone access port, which Bun still holds
until R13.

Checked: `tests/quickchat_text.rs` against Bun's answers in `tests/fixtures/quickchat.json`
(`test/rust-board-quickchat-fixtures.test.ts`); `tests/quickchat_fake.rs` runs whole chats against the fake Claude;
`test/contract/quickchat-read.test.ts` in board mode. A title cut through an emoji keeps half of it in Bun and drops it
in Rust (the same known gap as R3 and R5).

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

## Team (R11b)

`src/team/`: teammates (huddle role presets), squads (huddle templates), role notes, teammate and squad proposals,
the squad save plan, the "Save as squad…" prompt and the plan review file (`src/huddle/huddle-presets*.ts`,
`huddle-templates*.ts`, `huddle-notes.ts`, `huddle-roster.ts` checks, `squad.ts`, `teammate-proposal.ts`,
`plan-review-file.ts`, `src/core/layers.ts`). `store.rs` (`Team`) reads and writes the files with Bun's checks and
statuses; `routes.rs` answers `/api/profiles/:p/huddle-presets`, `/huddle-templates`, `POST /squads` and
`/huddle-notes` in board mode (`rust/src/board_mode.rs` runs Bun's Host, Origin and JSON type checks first).
`/learned` and `/api/team-usage` are R12's.

- The built-in teammates and squads and the long texts are `src/team/builtins.json`, written by Bun.
- A squad card on a ticket (R2a) and a huddle's proposed squad (R11a) are marked saved through
  `Team::set_ticket_cards` and `set_learning_cards`; without them such a save answers 503 before writing anything.
- `tests/fixtures/team.json` is the parity table (about 400 cases with Bun's answer or error text);
  `test/rust-team-fixtures.test.ts` checks Bun, `tests/team.rs` Rust, `tests/team_store.rs` the files and routes.
  After a deliberate change in Bun: `UPDATE_RUST_FIXTURES=1 bun test test/rust-team-fixtures.test.ts`.

## Huddle rooms (R11a)

`src/huddles/`: `src/huddle/huddle.ts` and its `huddle-*.ts` parts (types, roster, routing, messages, changing,
hand-ins, stop, resume, close) and the routes of `src/api/huddles.ts`, answered by Rust in board mode
(`/api/profiles/:p/huddles...`, after the same Host, Origin and JSON type checks as the team routes). `Huddles`
(`service.rs`) is `api::HuddleInfo` (`hostStates`, a ticket's teammates and their spend) and the team's
`LearningCards` (a huddle's proposed squad saved from `POST /squads`). Files as Bun writes them (`files.rs`: the
huddle JSON pretty with a newline, the message log one masked line each, read only as far as it grew).

- One change at a time, under one lock, like Bun's event loop; what Bun queued for after a change (the host-moved
  note, the note about a file edited outside the board) runs once the change is over. Reads (lists, one huddle) take
  no lock. Calls block: the server runs them on the blocking pool.
- What runs goes through `HuddleRunner`. Its stand-in (tests) runs nothing: a wake leaves the messages unread, so the
  first board that can run them delivers them (`wake_if_owed` at the next start).
- Hand-ins (`copies.rs`): saving what changed in a helper's copy and bringing it into the host's folder, all or
  nothing, a file both changed being a conflict.
- Answered 503: "Save as squad…" (`generic-squad`, a side call, not ported yet). Lessons a helper proposes with done
  go to R12's learner (`Huddles::set_learn`).
- `tests/huddles.rs` drives the routes on a temp data folder; `huddle.test.ts` and `huddle-team.test.ts` check the
  same answers against Bun (the room tests that need no helper run are in `contract-files.txt`).

## Huddle agents (R11c)

In `src/huddles/` too (they need the room's internals). `Agents` (`agents.rs`) is the board's `HuddleRunner`, set in
`rust/src/board_mode.rs` before the huddles' `recover()` (which now runs after the run loop's, Bun's order):
- Helpers' runs (`huddle-agents.ts`, the delivering half of `huddle-routing.ts`): `claude -p` on R3's runner with
  Bun's system prompt, tools, browsers (a lease per helper), saved keys and `CKANBAN_HUDDLE_AGENT`; in their own copy
  of the host's folder (`workspace.rs`: a worktree at a snapshot commit of the folder as it is, or a plain copy), a
  read-only snapshot worktree reset at each wake, or the host's folder. Woken by steering, at a monitor's turn
  boundary, or with a new run; held back while a restart is pending. A run's events write the huddle in order on
  one task per run, off the runtime.
- Ticket sessions (@main, invited tickets) get their unread messages as a peer chat message of their ticket (R7a's
  `chat`; a host's own auto huddle wakes it as unattended work). Their reply runs' cost counts toward the huddle
  (`mainResult`), their conversation size shows on the roster.
- Costs: the roster's live turn cost, the session total on each result line, the board's day ledger
  (`ckanban_core::spend::add_huddle_spend`, `spend-days.json`), then the budget brake.
- Auto huddles (`auto.rs`): `POST /huddles/auto` (start_huddle) with Bun's checks; one live per board, others wait
  for the slot and are woken in turn; an ended one wakes its host (a brake) or sends it to Review (the user).
- The session viewer (`session.rs`): `GET .../participants/:handle/session`, `.../tool/:id`, `POST .../reveal`, and
  `huddle.session` events every 2 s (`rust/src/board_mode.rs`).
- After a close: helpers' copies, snapshots (`removeWorktrees`) and project copies left in their outputs
  (`output_copies.rs`) are removed (only reported to `<data>/rust-board-dryrun.log`, jobs `huddle-copies`,
  `huddle-output-copies`, with `CKANBAN_RUST_DELETE=0`, plan 5.3). A snapshot is removed only from the folder the board
  made for that helper (`agent_dir`). A fresh copy after a conflict is made at once
  (unsent changes saved first), as in Bun.
- Shutdown marks helpers mid-turn `interrupted`; `recover()` carries them on.
- `test/contract/huddle-agents.test.ts` checks the session viewer against Bun and the Rust board; huddle.test.ts and
  huddle-team.test.ts (helpers' copies, hand-ins, the budget stop, the auto huddle) pass whole in board mode.

## Browsers, devices and the terminal (R9)

`src/browsers/`: `src/browser/` in Rust, answered by Rust in board mode (`routes.rs`): `/api/board-browsers`,
`/api/browsers`, `/api/devices` (every method and sub-path, Bun's quirks kept), a ticket's `POST .../devices`
(take_devices / release_devices) and the board's `GET .../shell` WebSocket (the Terminal panel). `Browsers` (`mod.rs`)
holds them and is the board's `DeviceInfo`; `board_mode.rs` builds it and calls `answer_request` before the other
routes.

- `devices.rs`: shared devices, takes all-or-nothing and first come first served, `devices.json` like Bun.
- `chromes.rs`: named Chromes (`browsers.json`), `ChromeWatch` for a run's stream (R7a feeds it), browser picks.
- `board_browsers.rs`, `cdp.rs`, `sign_in.rs`: board browsers on their own Chrome, the debugging port client, the
  sign-in check and screen. Chromes are detached (own session), so they outlive any daemon. At start (`init`) Rust
  adopts every Chrome still running on a board browser's folder, Bun's included: it reads Bun's
  `board-browsers.json` and each folder's `DevToolsActivePort`, and uses a Chrome only when its port answers as that
  very Chrome and is bound to this Mac. It writes `running` back in Bun's format, so Bun adopts Rust's after a switch
  back. Logged-out alerts go to the helper once R13 connects it (logged in `daemon.log` until then).
- `shell.rs`: one shell per folder on a pty (`portable-pty`), scrollback for a new tab; `terminals.rs`: which linked
  tickets are open in a terminal (its linked tickets come from the R1 index, `linked_from_index`).
- What the routes read from the board goes through `BoardLookup` (`FileLookup`: one ticket or board file at a time).

## R2a: ticket and board writes (`src/tickets/`)

The only code that writes `ticket.md` in board mode (plan 2.2). Ported from `src/core/store.ts` (the writing half),
`src/board/board-tickets.ts`, `board.ts` (`patch`, `addComment`), the routes of `src/api/tickets*.ts`,
`ticket-cards.ts`, `ticket-info.ts` (snooze, seen), `ticket-actions.ts` (move), `profiles.ts`, `attachments.ts`,
`avatars.ts`, `snippets.ts`, and `runRights` from `context.ts`.
- `writer::Tickets` (`Core::tickets`): `create`, `update`, `patch`, `delete`, `move_to`, `add_comment`, `note`,
  `mark_started_by`. Each write takes the board's write lock, writes the file through `ckanban_core::ticket`, puts the
  ticket in the index's listing (`Index::saved`, Bun's `placeTicket`) and sends `ticket.updated`/`ticket.deleted`.
  The cached ticket keeps Bun's in-memory key order. Comments are masked with the pass store's secrets as they are
  written (`set_mask`). Blocking: call from the blocking pool; async hooks run through `writer::block`.
- `hooks::BoardHooks`: what later steps plug in (R2b families and plans, R7a runs and run rights, R10 schedules,
  R11a huddles, R12 the linker, R13 the helper). Stand-ins refuse family links (`partOf`, gather, rounds) rather
  than write them unchecked; in board mode `Wired` answers them with R2b's `Families`. `wiring::Wired` plugs in what is already in Rust: R6's Done cleanup and the copy of a
  deleted ticket (both report-only with `CKANBAN_RUST_DELETE=0`), R9's browser picks and terminal shells.
  `wiring::TicketOps` is R6's `BoardOps` over these writes. A step that lands adds its piece to `Wired`.
- `rights`: `runRights`, `runStart`, `inFamily`. `routes::Writes`: the routes (`wanted` lists them); `profiles`:
  boards; `files`: attachments, avatars, snippets; `norm`: tags, needs, ⭐ titles, slugs (accents as NFKD for Latin
  letters only), models and kinds.
- Checked against Bun by `test/contract/board-writes.test.ts`: one script of writes on both, the same answers (by
  value) and the same bytes in the data folder.

## R2b: families, plans, main tickets and the feature status (`src/families/`)

Ported from `src/board/board-families.ts`, `board-plans.ts`, `board-main.ts` (without git and runs),
`board-features.ts`, `feature.ts`, `main-ticket.ts`, `plan.ts`, the family rules of
`web/src/features/family/family.ts` and the routes of `src/api/ticket-info.ts` / `ticket-actions.ts` named below.
- `rules`: `wouldLoop`, `levelOf`, `fitParent`, `isFeature`, `groupsOf`, `nextRoundTitle` and `linkProblem` (one
  sub-feature level, at most `MAX_LEVEL` deep), worked out on a copy of the listing with the moved ticket in place.
- `plan`: `planStep`, `planProblem`, `resultWakesMain`, `finishedLine`, `progressStep`, `familySig`, `wakeTable`.
- `status`: status.json and status.md byte for byte (`clipText`, `applyPatch`, `statusFacts`, `statusSections`,
  `statusMarkdown`, `writeStatus`).
- `board::Families` (made in `rust/src/board_mode.rs`): `set_part_of`, `make_own_work`, `set_show_on_board`,
  `place_in_feature`, `gather`, `ensure_plan`, `start_plan`, `pause_plan`, `mark_plan_done`, `resume_stopped_plan`,
  `unpark_main`, `holds_review`, `open_steps`, `push_event`, `report_to_main`, `note_user_message`, `result_card`,
  `advance_plans` (one pass per board at a time; a wake waits 3 s so results arriving together make one wake),
  `feature_status`, `update_status`, `add_status_note`, `refresh_status_file`, `record_milestone` (R6's land), and the
  saved changes list (git log by the `Ckanban-Feature` trailer, or the files the family's tickets edited) built on a
  thread of its own. status.json is changed under one lock. What needs a run goes through `PlanRuns` (wake, dispatch,
  auto-fresh, the Planning interview, notifications); R7a sets it with `Families::set_runs`. Until then nothing runs:
  a plan moves its tool tickets to Ready and records its wakes, and Ready work waits.
- Running at once (Bun is single-threaded; here routes, hooks and the wake timer run in parallel): every plan write
  goes through `Tickets::update_with` (`Families::change`). Pause, Mark done, start, ensure and a pushed event change
  only their own fields of the plan in the file; a pass writes only while the file still holds the plan it read, and
  moves a task to Ready only while it is still in Backlog and the plan unchanged, otherwise it goes again. A panic in
  one plan's step is caught (the others go on, the board isn't left marked as advancing). Links (`set_part_of`,
  `make_own_work`, `gather`) hold the board's link lock across check and write, taken before the board's write lock.
  `tests/families_race.rs` makes a second thread act in the middle of a pass or a link.
- Plugged into the ticket writes through `tickets::wiring::Wired` (`place_in_feature`, `set_part_of`, `new_step`,
  `gather`, `after_create`, `after_update`, `board_changed`) and `TicketOps` (`push_event`, `holds_review`,
  `record_milestone`). The create route places a run's `partOf` in its feature (Bun's own-feature, open-feature and
  depth rules) and makes a ticket a run creates inside its main ticket's family a tool ticket of the nearest manager.
- `routes`: `GET family`, `GET family-view`, `GET/POST status`, `POST status/notes`, `POST own-work`, `POST gather`,
  `POST plan`, `POST merge-into-main`, `POST land` (through `tickets::routes::Writes`).
- `old_plans`: a board with an old-style plan (a planned ticket that is neither main nor tool) makes the start step
  "old plans" fail, so board mode falls back to Bun (fallback 2), whose one-time migration (`retire-plans.ts`)
  turns it into main tickets; the next start finds none. Only real boards (a readable profile.json) count, and the
  refusal names the ticket file. The step waits for the start-up load.
- Checked against Bun: `tests/fixtures/families.json` (written by `test/rust-board-families-fixtures.test.ts`,
  `UPDATE_RUST_FIXTURES=1`; `tests/families.rs`), and `test/contract/board-family-writes.test.ts` (one script of
  family writes on both servers: the same answers and the same bytes of ticket.md, comments, status.json, status.md).

## R6: git, copies of the folder, landing, files (`src/git/`)

- `cmd`, `repo`: git and gh as child processes; repo kind (plain, empty, local, remote) cached 10 s; ticket copies
  (worktrees), the shared fetch of the latest base, turning version history on.
- `setup`: setup detection (.env files, lockfiles), copying `copyFiles`, the setup command, `detect_missing`.
- `diff`: the Changes tab. `pr`: a ticket's PRs, `gh` status, Merge & done, send failures, resolve conflicts, the poller
  (`start_poller`, started by R7a). `share`: Show in Finder, Copy file, download headers. `files`: Files panel, files a
  chat mentions, outputs.
- `landing::Git`: where a ticket's runs work (`ensure_session`, the plain-folder path included), `run_setup`, merge
  into main, `land_milestone`, `branch_folder` (Branch/Fork), the Done cleanup and the worktree sweep; implements
  `api::Landing`. It reaches the board through `ops::BoardOps` (R2a's `tickets::wiring::TicketOps`; `fileops::FileOps`
  is a read-only stand-in the start-up sweep still uses).
- `routes`: what board mode answers now (files alone, no ticket writes): a ticket's `outputs`, `find-files`, `file`,
  `diff`; the board's `files`, `file`, `open-file`, `detect-setup`; `/api/version-history`. Anything unusual goes to
  the satellite. `merge-into-main` and `land` are answered by R2b's family routes over `landing::Git`; the other
  write routes (`branch`, `setup`, `pr/*`, `check-pr`) come with R7a.
- At start (`start_jobs`): setup detection; after `recover()` the worktree sweep (only folders named like a ticket id
  count as left behind, plus helpers' copies in `<ticket>.huddle` folders, `huddle_sweep.rs`) and the clean-up of run
  temp folders (`runs/run_temp.rs`), then the package trim (`trim.rs`): once, then hourly, kept Done copies lose their
  dependency folders 3 days after Done (`setupPending` brings them back). Each hour also runs a small sweep
  (`sweep_leftovers`, at most `SWEEP_BATCH` copies) and removes run temp folders older than a day; `free_up`
  (`/api/disk/free-up`) runs the full sweep and the trim at once.
- Background deletes delete (`src/dryrun.rs`); with `CKANBAN_RUST_DELETE=0` the sweep, the Done cleanup and the trim
  only append their decisions to `<data>/rust-board-dryrun.log` (plan 5.3).
- Pure logic is checked against Bun: `tests/fixtures/git.json` (written by `test/rust-git-fixtures.test.ts`,
  `UPDATE_RUST_FIXTURES=1`).

## R7a: the run loop (`src/runloop/`)

The board's runs in Rust, ported from `src/board/board.ts` and its parts (`board-queue`, `board-devices`,
`board-limits`, `board-followups`, `board-recovery`, `board-types`), `src/usage/limit.ts`, `src/schedules/followup.ts`,
and what the loop calls from `board-main.ts`, `board-features.ts`, `board-repo.ts`, `board-tickets.ts` and
`board-plans.ts` (roles, chat flags and environment, feature notes, status notes and the status nudge, ask_ticket,
Branch, follow-up work, run rights, Telegram messages). `RunLoop` (`board.rs`) is made in `rust/src/board_mode.rs`
once the ticket writes, families and R6's `landing::Git` exist.
- `board.rs`: `chat`, `start`, `begin`, `execute`, `drainQueue`, `endStatus`, `dropRun`, the end of a run (devices and
  board browsers let go, the move asked for in the chat, dispatch, plans, `onRunEnd`). `once.rs`: `executeOnce` (where
  it works, the prompt, the claude process on R3's runner, its events: drafts, workflows and their spend, the run log,
  the card line; then the result: questions, blocked, done, stall restart, spending cap, usage limit, a passing API
  error retried once, a lost session started over once). `prompt.rs`: roles, `chatArgs`, `chatEnv`, `runBrowsers`,
  feature and status notes, fresh prompts and fresh chats.
- `queue.rs` (steer, delivered, held, send/edit/discard, a repeated form answer, the Planning interview), `slots.rs`
  (running, holds a slot, `dispatch`, the folder wait, stopping a workflow), `limits.rs` (stall actions, caps, usage
  limits and the automatic continue), `followups.rs`, `recovery.rs` (Stop, a main ticket's family Stop, shutdown, the
  restart gate, `recover`, fresh session, fresh chat, take over, link a session, the status nudge), `ask.rs`,
  `branch.rs` (Branch and the PR box), `followwork.rs`, `routes.rs`.
- `rules.rs`, `limit.rs`, `followup.rs`: the pure rules, checked against Bun by `tests/fixtures/runloop.json`
  (written by `test/rust-board-runloop-fixtures.test.ts`, `UPDATE_RUST_FIXTURES=1`; `tests/runloop_rules.rs`).
- `wiring.rs`: `LateRuns` (the `RunControl` the services made before the loop ask), `PlanRuns` for R2b, `RunHooks`
  (the run half of the ticket writes' hooks: run rights, a move asked in the chat, Stop on a move, key cards, Close
  question), `RunActions` (the satellite's Telegram messages, marks and comments), the run log compressor's board.

Threads: the loop's calls are blocking (ticket writes); `decide` (a reentrant lock) is held while a choice is made and
acted on, never across a wait for a run or an await; run state locks are never held across a ticket write (its event's
view asks who runs). Each run is one tokio task; its events are handled on the runner's task in order.

In board mode: the routes `chat`, `queued/:msg`, `stop`, `stall`, `cap-continue`, `limit`, `follow-up` (set, stop,
now), `ask`, `link-session`, `fresh-session`, `take-over`, `fresh-chat`, `setup`, `branch`, `follow-up-work`, `pr/*`,
`check-pr`, `workflow/:tool/stop` (inside `tickets::routes::Writes`), and `GET/POST /api/restart`, `GET /api/awake`
(own routes). A restart the board asked for ends `ckanban-rs` once the work is done (at most 2 minutes), like a
SIGTERM: runs are stopped without an outcome, chat replies marked interrupted, and the next start (Rust or Bun)
resumes them (`test/contract/rust-board-switch.test.ts` checks both directions). Timers: usage-limit continues,
follow-ups (`CKANBAN_TICK_MS`), the PR poller, keep-awake, run log compression (report-only, plan 5.3). The
satellite's mirror gets `runtime` lines when the running tickets or a session summary change. A first prompt gets
R12's "What we did before" block (`RunLoop::set_recall`).

STAND-INs, each marked in the code: the Mac banner of a plan event (the satellite), closing a session
open in the board's own terminal on Take over (R9).

## R12: board extras (`src/extras/`)

What the board learns on its own, Find links, recall, mockups and usage, ported from `src/board/learner.ts`,
`learn.ts`, `lessons.ts`, `linker.ts`, `recall.ts`, `mockups.ts`, `src/usage/ticket-usage.ts` and
`src/huddle/huddle-usage.ts`. `Extras` (`mod.rs`) is built in `board_mode.rs` and started there.
- `learn.rs`, `lessons.rs`: the pile of lessons (matching, promotion, pruning), the board's rules file, undo note by
  note, the side calls' answers and prompts, the user's corrections and the learning prompt (with `transcript` of
  `src/chat/explain.ts`), the CLAUDE.md "## Lessons" bullets. Values kept in Bun's key order: `learned/pile.json` and
  `changes.json` are written like Bun's.
- `learner.rs`: `Learner`: tickets that settle in Review or Done are read after 2 minutes (`CKANBAN_LEARN_SETTLE_MS`)
  with one cheap side call; huddle lessons (`add_huddle_lessons`); the weekly tidy pass; save now,
  drop, keep, undo, redo, seen and the Learned view. One step at a time (one lock held across the side call).
- `linker.rs`: parent suggestions for tickets the user creates (R2a's `suggest_parent` hook calls
  `extras::suggest_parent`) and Find links.
- `recall.rs`: the "What we did before" index per board, scored exactly as Bun; `Extras::recall` gives the whole block
  a run's first prompt gets (recall, learned rules, project lessons), for R7a.
- `mockups.rs`: saving a planning reply's mockup blocks (R7a calls `save_mockups`; stripping is R5's).
- `usage.rs`: a ticket's runs, cost and share of each 5h window (`RunLogIndex` reads a run log from where it stopped,
  `ClaudeLogIndex` prices `~/.claude/projects` per minute), huddle teammates' spend and team usage (huddle files kept
  by mtime and size).
- `routes.rs`: in board mode Rust answers `/api/profiles/:p/learned...`, `POST .../find-links` (the user only; the
  owner's phone too), `GET .../tickets/:id/usage` and `GET /api/team-usage`.

Huddle agents' lessons come from R11a's `Huddles::set_learn` hook (wired in `board_mode.rs`). Checked: `tests/extras.rs` against Bun's
answers in `tests/fixtures/extras.json` (`test/rust-extras-fixtures.test.ts`, `UPDATE_RUST_FIXTURES=1`), and
`test/contract/board-extras.test.ts` in board mode.

## R10: schedules, one-time jobs and automations (`src/schedules/`)

Ported from `src/schedules/scheduler.ts`, `schedule-history.ts`, `quiet.ts`, `jobs.ts`, `loops.ts`,
`src/integrations/script.ts`, `ask-claude.ts`, `ticket-text.ts`, the routes of `src/api/schedules.ts` and
`/api/automation-call`, and `taskPlaceFor`, `createFeatureTask`, `automationItem` of `board-main.ts`. `Schedules`
(`mod.rs`) is built in `rust/src/board_mode.rs`; its timers start after the runs are recovered and stop with the core.
Only the board's owner fires: the satellite starts none of its timers.
- `files.rs`: schedules, history lines, jobs, automations, their scripts and state, written like Bun's `Store` (pretty
  JSON in Bun's key order); lists kept by mtime and size (`JsonDir`). `history.rs`: the digest the list and quiet runs
  read (only what a history file gained), and its newest entries.
- `scheduler.rs`: create, change (history of edits), delete, history, run now, the tick (missed after 90 s, one
  catch-up), skip-if-running, a run as a task of its feature, the list's spend over 7 days, quiet checks per day and
  who paused it; `ScheduleHooks` for the run loop (a quiet schedule's prompt context, a quiet run's history line and
  its cost in `spend-days.json`).
- `jobs.rs`: create, change (the whole action), cancel, run now, the tick (late after 10 minutes, a pending restart
  holds commands), chains, `recover` before the first tick, a deleted ticket's jobs cancelled. A command runs on a
  thread of its own in its own process group (`script::run_command`); a restart waits for it.
- `loops.rs`: automations: view, validate, create, change, delete, copy, test, check (first check notes what is there,
  Ask Claude first through the side call, threads into their ticket, at most 20 new tickets a check, backoff), the
  tick. `ckanban call` reaches `/api/automation-call`: Rust checks the check's token and which tools it may use, and
  the server's `outside::signin` makes the call (`Satellite::pass_call`, P2); the rate limit comes back on the grant.
  `passbook.rs` reads `automation-passes.json` (names, status, keys for scripts); masking uses the server's secrets.
- `routes.rs`: what board mode answers (`board_mode.rs` `answer_schedules`: Bun's gate, then a front desk request
  through the satellite's front desk gate, then the route on the blocking pool; a confirmed front desk replay runs here
  as the user, so a schedule's delete goes ahead). A schedule's delete is the user's (their browser), their own
  program outside the board (`guard::outside_board`) or a confirmed front desk request; a schedule-delete card goes
  through `tickets::wiring::Wired::remove_schedule`.
- `text.rs`: the pure parts, unit tested. The check-in guides are in `prompts::deps`, the automation card in
  `sessions::cards`.

Checked: `schedules.test.ts`, `jobs.test.ts`, `automations.test.ts`, `schedule-firing.test.ts`, `passes.test.ts`
(check scripts) and `mcp.test.ts` in board mode (`contract-files.txt`).

## Tests

```sh
cd rust && ~/.cargo/bin/cargo test -p ckanban-board   # this crate's unit tests
bun run test:contract:rust-board                       # the files in contract-files.txt, board mode on
bun run test:contract:rust-board tickets.test.ts       # any contract file in board mode, listed or not
```

`contract-files.txt` lists the contract test files (or `file | test name pattern`) that pass in board mode; a listed
one that fails, fails the run. Each task adds what it makes pass; the flip needs every file listed whole.
`test/contract/rust-board-mode.test.ts` covers the switch and the three fallbacks (only in this run).

## R7b: chat extras (`src/chat/`)

Ported from `src/chat/commands.ts`, `rewind.ts`, `fork.ts`, `simplify.ts`, `explain.ts`, `context-usage.ts`, the chat
parts of `src/board/board-queue.ts`, `board-rewind.ts`, `board-main.ts` and `quickchat.ts`, and the routes of
`src/api/ticket-files.ts`, `ticket-info.ts` (context), `ticket-actions.ts` (planning-command), `profiles.ts` (commands)
and `chats.ts`. Drafts, fresh chat and session, take-over and link-session came with R7a.
- `commands`: what `/` can run (built-ins, project, user and plugin skills and commands, Claude Code's bundled skills
  learned from a run's init event and kept in `<data>/claude-commands.json`, Bun's file), cached 30 s per folder;
  `parse_slash`, `slash_message`. `slash`: `RunLoop::commands` and the board's /model and /effort. The run loop's
  `chat` refuses /clear, /resume, /exit, /quit, runs /model and /effort itself and sends a known command alone
  (`slash: "local"` or `"prompt"`); the list is read before the board's choice lock is taken.
- `rewind`: hidden snapshots under `refs/ckanban/rewind/<ticket>/` taken before each message to an idle ticket
  (CKANBAN_SNAPSHOT_LIMIT_MS), the cut with a `.before-rewind` copy, Undo with `refs/ckanban/rewind-undo/`.
  `board`: `rewind_dir`, `rewind_blocked`, `begin_rewind` (one at a time, under the choice lock), `rewound`, Undo,
  Fork (`copy_ticket_before` in `runloop/branch.rs`, shared with Branch), `planning_command`; a ticket's rewind copies
  are dropped at Done and on delete, report-only with `CKANBAN_RUST_DELETE=0` (plan 5.3). `quick`: the same for a
  quick chat (the chat only) and Make ticket (board mode plugs in `make_ticket_hook`: create, link-session, back to
  Backlog, note, parent suggestion). `routes`: `commands`, `rewind`, `rewind-undo`, `fork`, `planning-command` and the
  board's `GET commands`.
- `simplify`, `explain`, `context`, `extras` (`ChatExtras`): Say it simpler, Help me understand and the Context panel
  for tickets and quick chats (`simplified`, `simplify`, `help`, `context`), with the side calls' spend logged.
- Branch and Fork make their ticket without the start-of-work hooks (`Tickets::create_quiet`, Bun's
  `store.createTicket`), so no Planning interview starts before the copied chat is in place.
- Checked: `chat.test.ts`, `chat-session.test.ts` and `quickchat.test.ts` whole in board mode; unit tests in the
  modules. Not yet: `data-files.test.ts` waits for a huddle helper's spend (R11c).

## F1: the checks before the switch (tools removed in P4)

F1 ran every contract test in board mode (`test:contract:rust-board`), a board parity script on Bun's full mode and
the Rust board side by side, a dry run on a copy of the real data folder (`scripts/rust-board-dryrun.ts`) and the
10,000-ticket bench (`scripts/rust-trial-bench.ts`). Results: `docs/rust-port.md`, "The Rust board: ready to
switch?". Since P4 `bun run test` runs every contract test against this board, the parity script checks it against
Bun's recorded answers (`test/contract/golden/board-parity.json`), and the big-board check is `bun run speedcheck`;
the dry run and the bench are in version history (fca356b2).

## The helper (P1a, P1b, `src/helper/`)

What waits on the user and how they hear of it, ported from `src/helper/` (`runner*.ts`, `core.ts`, `decide.ts`,
`waits.ts`, `messages.ts`, `settings.ts`, `summary.ts`, `notify.ts`, `channels.ts`, `push.ts`, `webpush.ts`). In board
mode Rust owns `waits.json`, `messages.json`, `helper-state.json`, `helper.json` and `push.json`, and is the only
writer of `notify.json`; every file is written in Bun's bytes, so a switch back to Bun reads them as its own.
- `watch.rs`: the stock-take at start (after the index is loaded, on a blocking thread; no session read for Done or
  Backlog tickets), then bus events mark tickets and a 1-second tick looks at them (`TransitionTracker`, a main
  ticket's steps' questions); notify_user (`POST .../tickets/:id/notify`); the logged-out alert of a board browser.
- `core.rs` (`HelperCore`): routing (helper on: to the runner; off or failing: sent directly), start-up reconcile,
  closes, opens, the 5-minute fallback, the 4-hour digest, usage limits merged, night holds, `switched`. The stores
  sit behind one lock taken per step and never across a send, Bun's interleaving.
- `runner.rs` (`HelperRunner`): wakes (a side call with the decision schema), `decide.rs`'s checks, urgent alerts and
  their reminder steps along a channel chain, summaries and the 3-hour gap, held items, failures with backoff and the
  pause message, the hello, the night question and the morning ask, the practice alert, taps, `wantsAwake` (in the
  board's keep-awake), status.
- `channels.rs` (P1b): sending. The Mac banner (`osascript`, found on PATH), or this Mac's browser when it gets
  notifications; phone push; the web address (ntfy or JSON), each as `channels.ts` builds it; Telegram from the Rust
  Telegram (`wired.rs` `TelegramSender`, P1c). It keeps Settings' last sent / last error, tells the user on this
  Mac when a device's push service drops it, and is the Mac-only notice of a plan done (`RunLoop::set_mac_only`).
- `push.rs`, `webpush.rs` (P1b): `push.json` (the VAPID keys and the devices, owner-only, read whole: a handful of
  devices) and Web Push on aws-lc-rs (already in the build for rustls): VAPID's ES256 JWT and the RFC 8291 aes128gcm
  body, checked against the RFC test vector. `NODE_TLS_REJECT_UNAUTHORIZED=0` is honoured as Bun's fetch does (the
  contract tests' self-signed fake push service).
- `notify.rs` (P1b): Settings' notifications: the view, a change (Bun's rules: a run can't, only the user; from the
  phone no new bot key and no turning Telegram back on), the test sends. What only Telegram's bot knows comes from the
  Rust Telegram (`wired.rs` `RustTelegram`, P1c): `telegram-state`, `telegram-pair`, `telegram-unpair`; a change is
  told to it (`notify-changed`: a new token, stopped taking messages). Before it runs the view shows Telegram from the
  settings, status "error".
- `routes.rs`: `/api/messages...`, `/api/helper...`, `/api/notify...` and `/api/push...` (answered by Rust), a
  ticket's `POST .../notify`. The ticket's `seen` route stops its reminders (`Writes::set_opened`). Adding or removing
  a phone push device is the user's own (`userOnly`, in Bun too since P1b): a program that added its own address
  would get every message.

## Telegram and the front desk (P1c, `src/telegram/`)

Bun's `telegram.ts`, `tgreply.ts`, `tgforms.ts`, `tgstores.ts`, `frontdesk.ts` and the Telegram half of `notify.ts`.
One `Telegram` value (made by `BoardMode::connect_telegram` once the server has its routes) holds it all:
- `stores.rs`: `telegram-links.json`, `telegram-pending.json`, `telegram-updates.json` in Bun's bytes (0600, `.tmp`
  then rename); `telegram-offset.json` and `telegram-frontdesk.json` (`bot.rs`, `desk.rs`), the desk's spend ledger.
- `api.rs`: the Bot API (`CKANBAN_TELEGRAM_URL` points it at a local fake), errors in plain words, the token scrubbed;
  `sendDocument` as multipart.
- `bot.rs`: one getUpdates long poll while paired and on or while a pairing goes on; updates saved before the read
  position moves on; messages one at a time in order, taps and `/lock` at once; pairing (6-digit code, 10 tries);
  `/waiting`; Got it, Not urgent and the night answer (the helper's runner); the helper's `telegram` channel; the
  briefing once; forms taken off the chat as tickets change.
- `replies.rs`: a reply to an alert into its ticket's chat (Send echo or Confirm), "Which one?", "Send anyway", a
  ticket's answer sent back after its turn (`Satellite::turn_ended` now lands here).
- `forms.rs`: a ticket's question form answered with buttons.
- `desk.rs`: the front desk (a quick chat a day, its rights and daily cap through `quickchat::ChatHooks`, answers
  back, waits it named marked seen), the gate, Confirm cards and their taps (the held request replayed as the user
  through the server's routes), `send_file`, alerts edited when their waits close.
- `text.rs`: the pure rules, checked against Bun on `tests/fixtures/telegram.json` (`tests/telegram.rs`,
  `test/rust-board-telegram-fixtures.test.ts`).
In the server (`rust/src/board_mode/tg.rs`): every request with `x-ckanban-frontdesk` goes through the gate right
after the request gate; one that may go ahead is sent to this server again without the header, so every route answers
it as it is. Settings' Telegram part (P1b's `notify.rs`) asks it through `wired.rs` `RustTelegram`; the helper's
`telegram` channel sends through `TelegramSender`. Left out: a reply cut through an emoji drops the half character
(as R3).
- Checked against Bun: `tests/fixtures/helper.json` (about 3,400 cases of the pure rules and two store scripts, in
  America/Los_Angeles; `test/rust-board-helper-fixtures.test.ts`) and `tests/fixtures/helper_runner.json` (six
  scenarios replayed step by step with a fixed clock, fake channels and fake answers; every step's files must be
  Bun's bytes; `test/rust-board-helper-runner-fixtures.test.ts`). `UPDATE_RUST_FIXTURES=1` rewrites them. Known gap:
  a cut through an emoji keeps half of it in Bun and drops it in Rust (as R3 and R5). The helper's input to the model
  writes local times without the zone's long name ("GMT-0800" only); only the model reads them.

## P2: the Share menu's Publish (`src/git/publish.rs`)

`startPublish` of `src/api/context.ts`: an output file published as a claude.ai page in the background, its job in
the ticket's view (`shareJobs`, in memory) until the link is saved in `shareLinks`; publishing again updates the link.
The publishing step is a hook the server fills (the server's own `artifact publish-output`, since P3). Before P2 the
request went to the satellite, whose read-only store couldn't save the link.

