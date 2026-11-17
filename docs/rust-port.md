# Rust port: trial results and go or no-go

TL;DR: **Go.** The Rust front adds about 0.03 ms per request (the limit was 5 ms), nothing in the trial blocks the rest
of the port, and the part that runs in Rust is small (a 7.4 MB binary using 6.5 MB of memory) and faster where it does
real work (today's spend 122 ms instead of 173 ms). The catch: users will not feel a speed change until the board itself
(tickets, runs, chat) moves to Rust, because the freezes come from Bun loading the board, and that move is one big
step, not many small ones.

**Update, 18 Nov 2026 (P4):** the port is done for Leo's Mac. Bun's server, CLI and MCP code under `src/` is deleted;
`ckanban-rs dev` is the whole server and serves the web page from `web/dist`. Bun only builds the web page and runs the
tests. See "P4: Bun's server removed" at the end, including the way back.

Measured on 2026-11-16 on the same Mac as the baseline (Bun 1.4.2, 10 cores). The Mac's load was about 7 (the
baseline ran at 13.5), so the Bun baseline was run again right before the Rust run, and both sets below come from that
pair. Every number is the median of 5 fresh server starts.

## Numbers side by side

From `bun scripts/rust-trial-bench.ts --runs 5` (Bun alone, then `ckanban-rs dev` release build with its Bun child) on
the 10,000-ticket test board. Raw runs: `docs/rust-trial-bun-rerun.json` and `docs/rust-trial-rust.json` (the first
baseline from step 4a is in `docs/rust-trial-baseline.json`).

| Measure (median of 5 runs) | Bun alone | Rust front + Bun child |
|---|---|---|
| Memory, idle (empty board) | 90 MB | 97 MB |
| Memory, big board settled | 394 MB | 396 MB |
| Memory, big board after the route calls | 462 MB | 436 MB |
| Start until the first answer (big board) | 277 ms | 384 ms |
| Start until the board's tickets answer | 2216 ms | 2338 ms |
| Longest stall while the big board loads | 148 ms | 123 ms |
| GET /api/usage, first call (Rust answers it) | 2.6 ms | 1.7 ms |
| GET /api/usage, repeat call | 0.2 ms | 0.1 ms |
| GET /api/spend, first call (Rust answers it) | 173 ms | 122 ms |
| GET /api/spend, repeat call | 0.2 ms | 0.1 ms |
| GET /api/profiles/:slug/tickets?scope=board, first call | 68.3 ms | 69.0 ms |
| GET /api/profiles/:slug/tickets?scope=board, repeat call | 64.7 ms | 66.7 ms |
| GET /api/tickets (every ticket, light rows), first call | 134 ms | 146 ms |
| GET /api/tickets (every ticket, light rows), repeat call | 113 ms | 111 ms |
| GET /api/inbox, first call | 2.4 ms | 2.7 ms |
| GET /api/inbox, repeat call | 1.0 ms | 1.1 ms |

The three board routes are the heaviest a board page load hits (the budgets in `scripts/bench.ts`): the board's
tickets, the light list of every ticket on every board (the command bar) and the inbox. Through the Rust front they
are Bun's answers passed along.

What the proxy adds, measured directly with `bun scripts/rust-trial-overhead.ts` (500 calls in a row per start, 5
starts each, empty board, so the server's own work is near zero and only the extra hop shows):

| Measure (median of 5 starts) | Bun alone | Rust front + Bun child | Added |
|---|---|---|---|
| GET /api/awake, typical call | 0.077 ms | 0.109 ms | 0.03 ms |
| GET /api/awake, slowest 5% | 0.171 ms | 0.223 ms | 0.05 ms |
| GET /api/profiles, typical call | 0.092 ms | 0.125 ms | 0.03 ms |
| GET /api/profiles, slowest 5% | 0.129 ms | 0.164 ms | 0.04 ms |
| Memory of the process itself | 84 MB | 6.5 MB (Rust) + 84 MB (Bun child) | 6.5 MB |

Size of the program: `ckanban-rs` release build is 7.4 MB (6.0 MB with symbols stripped). The released Bun binary
`ckanban-darwin-arm64` (v0.18.1) is 94.6 MB. A Rust-only ckanban would grow past 7.4 MB as areas move over, but it
would stay far below the Bun binary, which carries the whole Bun runtime.

### Reading the numbers

- The proxy cost is about 0.03 ms on a small answer and does not grow with big answers: the list of every ticket on the
  10,000-ticket board took 111 ms through Rust and 113 ms on Bun alone. That is about 150 times under the 5 ms limit.
- The two routes Rust answers itself are faster: spend's first call (it reads every board's spend files) is 30% faster,
  usage's first call 35% faster. Both are cached, so repeat calls are near zero either way.
- Memory: the pair uses about 7 MB more than Bun alone, the size of the Rust process. The big-board numbers move by
  ±30 MB from run to run (418 to 469 MB), so 436 against 462 MB is noise, not a saving.
- Start time: the Rust front starts the Bun child and waits until it answers before it opens the board's port, so its
  first answer comes about 100 ms later. Once the board loads the gap is within the run to run spread.
- Stalls: the longest stall (123 against 148 ms, spread 112 to 186 ms over the runs) is Bun loading the board in both
  cases. The Rust front does not cause stalls and cannot remove them; only moving the board's loading to Rust can.

## Go or no-go

**Go**, by the rule set for the trial: the proxy adds about 0.03 ms per request (limit 5 ms) and nothing found in the
trial blocks the rest of the port. Supporting evidence: the Rust program is 7.4 MB against Bun's 94.6 MB, uses 6.5 MB
of memory, and the work ported so far runs 30% faster with the same answers (checked byte for byte by the parity test).

What a go does not promise: the freezes users feel on big boards are Bun reading and sorting tickets. They go away only
when the board, runs and chat areas move to Rust, and those share the daemon's in-memory state, so they move together
(see the order below). Until then the Rust front changes nothing users can see, which is the point of the safe switch,
but it is also why the next step is large.

## What was hard

- **Knowing who is calling.** The daemon refuses some actions to board runs by finding the process behind the caller's
  TCP port. Behind a proxy every caller looks like the proxy. The fix (step 2) sends the real caller's port with a
  per-start secret that reaches Bun on stdin, since any process of the same user can read another's environment. It
  took the longest review of the trial and touched Bun's guard code.
- **Two processes sharing files.** Usage keeps a cache file that both Rust and Bun's own usage code (helper, limits)
  write. Bun had to learn to read it again when another process changed it, or the pair would ask Anthropic twice as
  often. Every later area that both sides write has the same problem, and it gets harder for ticket files, which Bun
  keeps in memory.
- **Byte-for-byte answers.** JavaScript writes numbers its own way (`42`, `0.0000015`, `1e+21`); Rust needed its own
  number writer (`rust/core/src/jsnum.rs`) and key order kept as written, so the parity test could compare raw bytes.
  Spend first came out 0.000001 off because of the order money was added in.
- **Safe measuring.** A test daemon started on the real repo sweeps ticket worktrees, so the bench copies the code and
  board to /tmp. The Rust server finds the Bun source from its own location, so measurements must set `CKANBAN_REPO` to
  the copy.
- **Contract tests first.** Only tickets, boards, schedules, usage and spend had outside-in tests before the trial. The
  port is only as safe as these tests, and most areas have none yet (table below).

## Effort spent

Six tickets: 1 contract tests, 2 the Rust front, 3a usage and spend in Rust, 3b connecting them, 4a the Bun baseline and
switch script, 4b this report. Steps 1 to 4a ran on 2026-11-15 and 16 between about 01:30 and 04:00 (local time),
partly side by side. Claude run time was about 80 minutes and about $21 for steps 1 to 4a, summed from the tickets' run
logs (an estimate: summed per turn, so it may count some turns twice), plus this ticket.

Code: about 2,400 lines of Rust (790 in the front server, 1,620 in `rust/core`, unit tests included), about 1,000 lines
of bench and switch scripts, and contract and parity tests in TypeScript.

Rough estimate for the rest, scaled from the trial (an estimate, not a measurement): usage was 1,470 lines of TypeScript
and took two tickets and about $7 to port. The rest of `src/` is about 54,500 lines, about 37 times more: on the order
of 60 to 80 tickets, $250 to $400 of runs and a few weeks of elapsed time, plus writing the missing contract tests
first, which may cost as much again.

## Proposed order for the rest

"Side by side" means the area can move to Rust while the rest stays on Bun, through the front, as usage and spend did.
"Together" means it shares the daemon's in-memory board, event bus and run state, so it moves in one step with the
others marked the same way.

| Order | Area (`src/`) | TS lines | How | Contract-test gap |
|---|---|---|---|---|
| 1 | `core/` (data folder store, types, event bus, atomic writes) | 3,700 | Library first, side by side (part is in `rust/core`) | `data-files.test.ts` checks the schemas of profile.json, ticket.md, activity.jsonl and the schedule file only; every other file in `contracts/data-files.md` has no schema check |
| 2 | `cli/` (the `ckanban` commands, HTTP client) | 1,800 | Side by side any time: it only talks HTTP to the daemon | Ticket and board commands are tested; `start`, `restart`, `install`, launchd and the rest are not |
| 3 | `mcp/` (the stdio MCP server) | 2,700 | Side by side any time: it only talks HTTP to the daemon | No contract test at all; needs a stdio test that lists tools and calls each group |
| 4 | `integrations/` (MCP servers, passes, keys, remote access, scripts) | 3,500 | Side by side: mostly its own config files | Only the caller checks (`callers.test.ts`); no tests for connections, passes, keys or phone access |
| 5 | `browser/` (board browsers, devices, terminals) | 3,000 | With step 7: every route answers from Bun's memory (device holds and waits, running Chromes, run leases) and run ends free them (see `rust/README.md`, step 5b) | Covered by `test/contract/browsers.test.ts`, except what needs a real Chrome (screen, input, sign-in) |
| 6 | `schedules/` (schedules, one-time jobs, automations) | 2,000 | Edits side by side (Bun must reload changed schedule files, as with the usage cache); firing them waits for the board step | Create, list, pause, resume, delete and validation are tested; one-time jobs, automations and firing on time are not |
| 7 | `board/` + `runs/` + `chat/` (tickets, the Board, runs, worktrees, chat, quick chat) | 19,500 | Together: one step. This is the step that removes the freezes | Ticket CRUD, moves, chat message to one fake run, and comments are tested; families, links, tags, attachments, cards, files and outputs, resume and stop, worktrees and landing, drafts, slash commands and quick chats are not |
| 8 | `huddle/` and `helper/` (huddles, teammates; what waits on the user, notifications, push, Telegram) | 13,700 | Together with step 7, or right after if they reach the board over HTTP (today they call it in memory) | No contract tests |
| 9 | `usage/` rest (limit waits and auto-continue, ticket Usage tabs) | about 600 | With step 7: it starts runs and reads run logs | Only plan usage and spend are tested |
| 10 | `api/` (the web server routes) | 4,500 | Not an area of its own: each route moves with the area it serves | The Host and origin checks are tested; each route's gap is its area's |

Steps 2 to 5 can run as parallel tickets. Each needs its contract tests written and green against Bun before any Rust,
as step 1 of the trial did for usage and spend. Step 7 is where the go pays off and also where the risk is: about
19,500 lines that must move at once, so its contract tests should be complete before it starts, and it is worth a
second short trial (the board's ticket list in Rust, reading the same files, compared against Bun) before committing
to it.

## The Rust board: ready to switch? (F1, 17 Nov 2026)

The board, runs and chat now run in Rust behind board mode (`docs/rust-port-board-plan.md`). F1 checked it against Bun
before the switch on Leo's Mac (F2).

| Check | Result |
|---|---|
| Every contract test file in board mode (`bun run test:contract:rust-board`: all 44 files listed in `rust/board/contract-files.txt`, none filtered) | all 44 pass |
| Board parity (`test/contract/board-parity.test.ts`: one script on Bun's full mode and on the Rust board, answers and files compared with ids, times and session ids masked) | the same, after the masks |
| Dry run on a copy of Leo's data folder (`scripts/rust-board-dryrun.ts`: 8 boards, 1,916 tickets, 14,309 page reads per server) | the same pages and start-up writes, except the differences below; two real differences found and fixed |
| Report-only deletes against Bun's own deletes on the same copy | the same 8 copy-of-the-folder decisions (6 removed, 2 kept with changes); with deleting on, the same 135 files removed |
| 10,000-ticket bench | below |

Differences the dry run found, and what became of them:
- **Fixed:** with deleting on, the worktree sweep removed a Done ticket's copy of the folder but left the ticket pointing
  at it (R6's start job still used a read-only stand-in from before ticket writes existed). It now runs on the board's
  own git object after `recover()`, clears `worktree` like Bun, and never treats a ticket file it couldn't load as gone.
- **Fixed:** at start the Rust board gave Bun's helper no session summaries, so the helper closed every "Claude
  replied", question and proposal wait it had open. The start snapshot now carries the summaries of every ticket that
  can wait on the user (read from the saved summaries or the transcript when the watcher hasn't got there yet).
- Expected: prompts name `ckanban-rs` as the `ckanban` command instead of `bun src/cli.ts` (both are the CLI).
- Rust is right where Bun shows a number late: a fresh Bun counts big run logs in the background, so its first answers
  show $0 or a few cents for those tickets and families (and plan usage shares built on them); Rust counts them at once
  (Leo's running board, after warming up, gives Rust's numbers).
- Bun's bug, not Rust's: Bun cuts one long tool line in the middle of an emoji (a lone surrogate); Rust cuts before it.
- Timing only: a feature's saved-changes list fills a moment after its first view (both), an automation check, a run
  log reaching 30 days Done, and status files rewritten at a different second between the two runs; tickets with the
  same `order` value in different columns come out in another order in the all-tickets list.
- Copy only: the copy rewrites paths in the data folder but not in Claude's transcripts, and Rust rebuilds Bun's
  session summaries (their tag differs), so on the copy one proposal looked changed. On the real Mac both name the
  same paths.

Bench (`scripts/rust-trial-bench.ts --runs 3`, 10,000 tickets, Mac load 7 to 8; raw: `docs/rust-board-bench-bun.json`,
`docs/rust-board-bench-rust.json`):

| Measure (median of 3 runs) | Bun alone | Rust board (Bun as satellite) |
|---|---|---|
| Longest stall while the big board loads | 213 ms (123 to 218) | 7.6 ms (4.5 to 25) |
| Start until the first answer | 293 ms | 1022 ms |
| Start until the board's tickets answer | 2184 ms | 1322 ms |
| Memory, idle / big board settled / after the route calls | 89 / 373 / 447 MB | 158 / 472 / 514 MB |
| GET tickets?scope=board, first / repeat | 68.9 / 64.6 ms | 91.5 / 86.5 ms |
| GET /api/tickets (every ticket), first / repeat | 142 / 111 ms | 62.9 / 46.2 ms |
| GET /api/spend, first call | 163 ms | 113 ms |
| GET /api/inbox, first / repeat | 2.6 / 1.0 ms | 1.8 / 0.7 ms |

The freezes are gone: the board answers within 25 ms while 10,000 tickets load (Bun: up to 218 ms), and its tickets
come 0.9 s sooner. It answers its first request later (it loads the board before it serves) and uses about 100 MB more
(Rust plus the Bun satellite). The board page's ticket list is about 20 ms slower than Bun's, a follow-up worth a look.
On the copy of Leo's data the longest wait during start was 51 to 135 ms against Bun's 137 to 237 ms.

## Trying it on the real board (before P4; the script is gone)

From Terminal, not from a board chat (the switch restarts the board, and the script refuses while board runs are
active):

    cd ~/dev/github/leoawesome/kanban && scripts/rust-trial.sh on

and to go back:

    cd ~/dev/github/leoawesome/kanban && scripts/rust-trial.sh off

`on` builds `ckanban-rs` if it is missing, keeps a copy of the launchd file
(`~/Library/LaunchAgents/io.ckanban.daemon.plist.before-rust-trial`), points it at `ckanban-rs dev` and reloads.
`off` puts the copy back and reloads.

**Warning:** `ckanban install` (and anything that runs it, such as updating with the installer) writes the launchd file
again and silently puts the board back on Bun alone, undoing the switch. The trial's copy of the old launchd file stays
behind and is now out of date (it may name an older Bun), so after an install delete it before anything else:
`rm ~/Library/LaunchAgents/io.ckanban.daemon.plist.before-rust-trial`. Then run `scripts/rust-trial.sh on` again if you
want to keep trying Rust. Don't run `off` after an install without deleting the copy first: it would put the old file
back.

## P4: Bun's server removed (18 Nov 2026)

- `ckanban-rs dev` runs the board itself with no Bun child: no satellite, no front mode, no shadow mode. A route no
  Rust code takes gets Bun's JSON 404; any path outside `/api/` is the built web page (`web/dist`, Bun's content
  types, `index.html` for the UI's own routes). The page is read from the source folder (`CKANBAN_REPO`, else the
  folder above the binary), so `bun run build:web` and a restart show a new UI.
- Deleted: `src/` (Bun's server, CLI, MCP server and their unit tests) except `src/cli.ts`, which now only hands every
  command to `rust/target/release/ckanban-rs` (old launchd files and `bun src/cli.ts mcp` registrations keep working);
  `test/integration/`, `test/big-board.test.ts`, the Bun-checked fixture generators (`test/rust-*-fixtures.test.ts`;
  their fixtures stay in `rust/` and are checked by `cargo test`), `test/support/`; the trial scripts
  (`rust-trial.sh`, the bench, the overhead check, the dry run, `test-contract-rust*.ts`, `mcp-tools-json.ts`).
- Tests: `bun run test` builds the Rust binary and runs every contract test against it, plus the UI and script tests.
  The five tests that compared Bun's server with Rust side by side check Rust against Bun's answers and files recorded
  before the deletion (`test/contract/golden/`). The Rust unit tests are `cargo test`.
- Not done (outside this step's limits): the release workflow and `scripts/build-bin.ts` still build Bun's binary
  from `src/cli.ts`, so a release would ship only the hand-off; CI (`.github/workflows/ci.yml`) has no Rust toolchain
  step for the contract tests. A Rust release (binary with the web page, installer, `ckanban update`) is its own step.
- Way back: check out fca356b2 (the last commit before P4), `bun install && bun run build:web && scripts/build-rust.sh`,
  then `scripts/rust-trial.sh board` (Rust board with Bun's satellite, as on Leo's Mac from 17 Nov) or
  `scripts/rust-trial.sh off` (Bun alone). The data files are the same on both sides.
