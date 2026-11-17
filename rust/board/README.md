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
  - `Satellite` (R13, `gate::edge::SatelliteClient`): turn ended, pass calls, the front desk gate, publishing.
  - `BoardActions` (R2a, R7a): what the satellite asks of the board (Telegram chat and fields, comments).
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
- `src/index/` (R1): every board's ticket files parsed once and kept by mtime and size, each board's listing shared as
  one `Arc<BoardList>`; the start-up load on a few threads in the background (a board's first listing waits for it);
  the 30 s re-check; families, scopes and Done paging, a main ticket's card, attention, links, the command bar;
  `TicketView` with live state through `Live` (the services' stand-ins until their tasks land); the read routes
  `GET /api/profiles`, `/api/profiles/:p`, `/api/profiles/:p/tickets` (every scope), `/api/profiles/:p/tickets/:id`,
  `/api/tickets`, `/api/inbox`. `api::TicketViews` is filled from it (`core.rs` `IndexViews`).
- Shadow mode (`src/index/shadow.rs`, `rust/src/shadow.rs`): with `CKANBAN_RUST_SHADOW=1` and board mode off, Bun's
  answers to the ticket list reads are served as they are and compared in the background with what the index works
  out (live fields taken from Bun's answer, Inbox sessions from `session-summaries.json`); differences, ids and field
  names only, go to `<data>/rust-shadow.log`, counts to `<data>/rust-shadow.json`. Read only. To run it on the real
  board: add `CKANBAN_RUST_SHADOW=1` to the front's launchd environment and `ckanban restart`; remove it to stop.
- One empty folder per later task (filled as each lands): `index` (R1, done), `tickets` (R2a, done), `families` (R2b, done), `runs` (R3), `prompts` (R4, done),
  `sessions` (R5), `git` (R6, done), `runloop` (R7a), `chat` (R7b), `quickchat` (R8), `browsers` (R9), `schedules` (R10),
  `huddles` (R11a, done), `team` (R11b, done), `huddle_agents` (R11c), `extras` (R12, done), `gate` (R13).

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
`debug/profile`), each after the front desk's gate (asked of the satellite) and the JSON-only rule; then the other
tasks' routes (R1, R5, R8, R6, R9, R11b); then the front's native routes and Bun, which checks the gate again. Before
any of it the request target is read as Bun's `new URL` reads it (`proxy::normalize_target`: `..`, `.` and their
`%2e` forms resolved), so a path like `/api/x/../profiles/...` can't reach Bun's stale copy of a Rust-owned route.
On the phone listener the other tasks' routes see the phone request with this Mac's Host and Origin (their own
checks); their user-only checks look at the caller (`tailscale serve`) and refuse the phone.

- The phone access listener is Rust's (`rust/src/phone.rs`, on CKANBAN_REMOTE_PORT, which Rust passes to the
  satellite so `ckanban remote on` points `tailscale serve` at it). A phone request Rust passes on carries
  `x-ckanban-front-via: remote`; Bun then treats it as a phone request (`listener: "remote"`, user-only routes pass
  for the owner's phone). Every answer there carries `x-ckanban-listener: remote`. Rust tells the satellite of
  phone visits to its own routes (`remote-visit <time>` on stdin) for `lastVisit`.
- The satellite's edge (`gate/edge.rs`, `src/core/satellite-edge.ts`), `POST /api/internal/<name>` with
  `x-ckanban-satellite: <the front's secret>` (the proxy drops callers' copies of it and of the two marks above):
  Rust asks Bun `frontdesk-gate`, `pass-call` (R10's automation calls), `publish` (share to claude.ai),
  `turn-ended` (R7a); Bun asks Rust `chat-from-telegram`, `patch-telegram`, `drop-telegram-queued`, `comment`
  (`api::BoardActions`, stand-ins refuse with 501 until R2a/R7a) and `replay` (a front desk request confirmed in
  Telegram, run as the user: Rust's own routes, else Bun with `x-ckanban-front-confirmed: 1`).
- Housekeeping (`gate/housekeeping.rs`): the temp file sweep and the daemon.log trim run at start, report-only
  (`rust-board-dryrun.log`) unless `CKANBAN_RUST_DELETE=1`; the satellite skips them.
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
also counts `restart_busy()` among what a restart waits for), board browsers for the runs (R9), the Telegram front desk
hooks (R13/P1: a front desk chat refuses to run, as Bun does without them), and the routes Context panel, Say it
simpler, Rewind, Undo rewind, Fork (R7b) and Make ticket (R2a, R7b), which answer 501 for now (the satellite has no
quick chats to hand them to). User actions from the phone come through the phone access port, which Bun still holds
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
- What runs is not here: helpers' runs and copies of the folder (R11c) and the ticket sessions' huddle replies (R7a)
  go through `HuddleRunner`, whose stand-in runs nothing. A wake then leaves the messages unread (the cursor stays),
  so the first board that can run them delivers them (`wake_if_owed` at the next start, as Bun after a restart).
  Until then a closed huddle gets the board's own summary (`fallbackSummary`) instead of asking @main.
- Hand-ins (`copies.rs`): saving what changed in a helper's copy and bringing it into the host's folder, all or
  nothing, a file both changed being a conflict. Making the copies is R11c's.
- Answered 503 until their step: `POST /huddles/auto` (R7a, R11c), a participant's session (R11c), "Save as
  squad…" (`generic-squad`). Lessons a helper proposes with done go to R12's learner (`Huddles::set_learn`); until
  then they are dropped, as Bun does without a learner.
- `tests/huddles.rs` drives the routes on a temp data folder; `huddle.test.ts` and `huddle-team.test.ts` check the
  same answers against Bun (the room tests that need no helper run are in `contract-files.txt`).

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
  deleted ticket (both report-only until `CKANBAN_RUST_DELETE=1`), R9's browser picks and terminal shells.
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
- At start (`start_jobs`): setup detection, and the worktree sweep in report-only mode.
- Background deletes are report-only (`src/dryrun.rs`): the sweep and the Done cleanup append their decisions to
  `<data>/rust-board-dryrun.log` and delete nothing until `CKANBAN_RUST_DELETE=1` (plan 5.3).
- Pure logic is checked against Bun: `tests/fixtures/git.json` (written by `test/rust-git-fixtures.test.ts`,
  `UPDATE_RUST_FIXTURES=1`).

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

## Tests

```sh
cd rust && ~/.cargo/bin/cargo test -p ckanban-board   # this crate's unit tests
bun run test:contract:rust-board                       # the files in contract-files.txt, board mode on
bun run test:contract:rust-board tickets.test.ts       # any contract file in board mode, listed or not
```

`contract-files.txt` lists the contract test files (or `file | test name pattern`) that pass in board mode; a listed
one that fails, fails the run. Each task adds what it makes pass; the flip needs every file listed whole.
`test/contract/rust-board-mode.test.ts` covers the switch and the three fallbacks (only in this run).
