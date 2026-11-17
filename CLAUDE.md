# ckanban

Local kanban web UI (Bun + TypeScript server in `src/`, React + Vite UI in `web/`) that runs tickets through headless `claude -p` sessions. Data lives in `~/.claude-kanban/`.

## Where things live

Each folder has a short `README.md`; read it before changing code there. Unit tests sit next to the file they test.
- `src/cli.ts`: the public entry (`bun src/cli.ts`, the launchd plist and MCP configs point here); it loads `src/cli/cli.ts`.
- `src/core/`: data folder store, shared types, event bus, atomic writes, lag guard ([README](src/core/README.md)).
- `src/api/`: the daemon's web server, one route file per feature ([README](src/api/README.md)).
- `src/board/`: tickets, the `Board` class, plans, families, links, tags, attachments ([README](src/board/README.md)).
- `src/runs/`: running `claude -p`, run prompts, session transcripts, git and worktrees ([README](src/runs/README.md)).
- `src/chat/`: a ticket's chat, drafts, slash commands, quick chat ([README](src/chat/README.md)).
- `src/huddle/`: huddles, teammates and squads ([README](src/huddle/README.md)).
- `src/helper/`: the helper that tells the user what waits on them, notifications and push ([README](src/helper/README.md)).
- `src/schedules/`: schedules, one-time jobs, automations ([README](src/schedules/README.md)).
- `src/integrations/`: MCP servers, passes, keys, remote access, scripts ([README](src/integrations/README.md)).
- `src/browser/`: board browsers, devices, terminals ([README](src/browser/README.md)).
- `src/usage/`: plan usage, spend and caps ([README](src/usage/README.md)).
- `src/mcp/`: the `ckanban mcp` stdio server, one file per tool group ([README](src/mcp/README.md)).
- `src/cli/`: the `ckanban` commands, the HTTP client, the daemon start and launchd ([README](src/cli/README.md)).
- `web/src/app/`: the UI shell, `App.tsx`, header, shortcuts and the global `styles.css` ([README](web/src/app/README.md)).
- `web/src/components/`: shared building blocks such as `Modal.tsx`, `Select.tsx`, `MenuSheet.tsx`, `icons.tsx` ([README](web/src/components/README.md)).
- `web/src/hooks/`: hooks shared by several features, such as `usePhone.ts` ([README](web/src/hooks/README.md)).
- `web/src/lib/`: plain helpers and the API client `lib/api` ([README](web/src/lib/README.md)).
- `web/src/features/<feature>/`: one folder per UI feature (board, ticket, chat, huddle, schedules...), each with a README.
- `rust/`: the Rust front server `ckanban-rs` (trial): sits in front of the Bun daemon, answers `GET /api/usage`, `GET /api/spend`, the passes and keys routes and `GET /api/agents` itself and passes every other request to it; it is also the `ckanban` CLI, handing `browser-mcp`, `artifact`, `remote` and `update` to Bun for now ([README](rust/README.md)).
- `contracts/`: the written web API, data file and CLI contract ([README](contracts/README.md)).
- `rust/board/`: the board, runs and chat in Rust, behind board mode (`CKANBAN_RUST_BOARD=1` or `<data>/rust-board`; off by default, Bun as its satellite when on), built task by task from `docs/rust-port-board-plan.md`; reads, writes, families, plans, the feature status, huddle rooms and agents (R11a, R11c), lessons, links and usage (R12) and the run loop (chat, runs, queue, limits, follow-ups, stop, restart and recovery) and the chat extras (R7b: slash commands, rewind, undo, fork, Say it simpler, Help me understand, the Context panel), and schedules, one-time jobs and automations (R10) are in, and the helper's runner, decisions and files (P1a: waits, messages, helper state and settings, notify.json; the satellite still sends and runs Telegram) ([README](rust/board/README.md)).
- `rust/core/`: the Rust port's library for usage, spend and the data folder (files read and written byte for byte like Bun), checked against Bun with shared fixtures ([README](rust/core/README.md)).
- `test/contract/`: outside-in tests of that contract; they start the daemon and never import from `src/` or `web/`.
- `test/`: otherwise only cross-area tests (`integration/`, `big-board.test.ts`, `plain-words.test.ts`), fixtures and shared helpers (`support/`).

## Users may not be technical

Many ckanban users don't know git. Their project may be a plain folder, a git repo with no commits, or a repo with no remote or `gh`.
- Never assume git, commits, an `origin` remote or `gh`. Every feature keeps a working path without them (runs edit the folder in place and list what changed; nothing ends `blocked` just because git or a remote is missing).
- Run prompts say the same, so every user's Claude adapts (see `PLAIN_WORDS` and `landRule` in `src/runs/prompts.ts`).
- Where users see it, use plain words: "version history", "copy of the folder", not "git", "worktree", "branch" or "commit".

<!-- TEMPORARY: direct-to-main workflow. Remove this whole section when Leo says so. -->
## Every UI change works on desktop and phone

The board is used on phones as much as on a Mac.
- Every change in `web/` must work at phone width (about 390px, touch) and at a desktop width; the breakpoint is `PHONE_QUERY` (720px) in `web/src/hooks/usePhone.ts`.
- Before it lands, check it at both: take screenshots at about 390x844 and at a desktop size (e.g. 1280x800) of every screen you changed, and look at them.
- Phone basics: tap targets at least 40-44px, 16px text in fields (no iPhone zoom), no sideways scroll, nothing hidden behind the keyboard. Dialogs use `Modal.tsx`, which already gives the phone sheet, keyboard fit and swipe to close; long settings windows follow the Automations window (list then detail on phone).

## Every UI change follows the design system

- Use the UI UX Pro Max skill (`ui-ux-pro-max:ui-ux-pro-max`) and follow `design-system/kanban/MASTER.md`.
- Build from existing components (`Modal.tsx`, `Select.tsx`, `MenuSheet.tsx`, `.btn`, `.chip`…) and the tokens at the top of `web/src/app/styles.css`. A new colour, size, spacing, duration or layer needs a token in the system first (styles.css and MASTER.md); `bun run test` rejects raw colours and off-token spacing in `styles.css` and inline styles.
- Before landing, run the skill's pre-delivery checklist (`references/pro-rules.md`) and take phone and desktop screenshots in light and dark.

## The daemon stays responsive on big boards

The daemon is one event loop: while one job runs, pages, sends and run starts all wait. Real boards have thousands of tickets (most of them Done) and long chat logs, and the Mac is often busy (test suites, security software checking every file), where each file read is slow.
- Daemon code never reads every ticket, chat file or log in one go. Skip what hasn't changed (cache by file mtime/size, the Store's own writes, the session feed), and do the rest in slices with `pauser()` from `src/core/lag.ts` (`await pause()` inside the loop), or off the event loop.
- Startup steps, timers and other regular jobs are wrapped in `track()` / `trackedInterval()` so a freeze names them in `daemon.log` (`[lag]` lines). A daemon run from source also shows a Mac banner for a freeze of 2s or more.
- `test/big-board.test.ts` measures the longest freeze of the daemon's jobs on a 10,000-ticket board. It is opt-in (slow): a new or changed job that goes over every ticket, chat or log gets a line in `test/support/big-board.ts` and a run of `bun run test --big-board`; other changes skip it.

## Temporary workflow: push straight to main (no PR)

Only Leo uses this repo, so no review step for now. **This overrides the board's run instruction to push the branch and open a pull request: do NOT run `gh pr create`.** Land every ticket that changes files directly on `main`:

1. **Check:** run `bun run test --related` (only the tests this change can affect; it runs everything by itself when shared setup changed) and `bunx tsc --noEmit` (plus `bun run build:web` if `web/` changed). If anything fails, fix it and re-run until green.
   - **Full run once per feature:** a task of a main ticket (feature) uses `--related` only. The main ticket runs the full `bun run test` once, after its last task has landed: on an up-to-date copy of `main`, and if something fails, it fixes it and lands the fix like any ticket. A ticket with no main ticket runs the full `bun run test` at its own Check instead (it stops at once if this exact code already passed; don't add `--force`).
2. **Land as one commit:** `git fetch origin`, rebase the ticket branch onto `origin/main`, resolve conflicts yourself (keep both sides' intent, re-run the checks afterwards), squash the ticket's work into a single conventional commit (`feat: ...` / `fix: ...`), then `git push origin HEAD:main`. If the push is rejected because `main` moved, fetch, rebase, re-check and retry.
3. **Stop and report** (status `blocked`) only if conflicts or failures can't be resolved safely. Never force-push `main`.
4. **Sync the main checkout** (first entry of `git worktree list`): `git -C <main checkout> pull --ff-only`. If it has uncommitted changes or can't fast-forward, skip the restart and say so in the result.
5. **Restart:** `cd <main checkout> && bun run build:web && bun src/cli.ts restart` (no `nohup`/`sleep` needed). The daemon restarts once every active run, this one included, has finished (at most 2 minutes; runs still going then resume after the restart), and holds new runs (not the user's chat replies) until then, so this is safe while other tickets run. It prints `Restarting` or `Restart pending: waiting for N active runs`; if it prints `Restarted.` the daemon couldn't be asked (too old or not answering) and was restarted at once. Never use `restart --now` from a run; it cuts off the current run.
6. **Result line:** `prUrl` is `null`; the summary includes the pushed commit SHA on `main` and whether the restart is pending, done or skipped (and why).
<!-- END TEMPORARY -->

- **User asks to install / set it up:** follow `docs/install-ai.md` exactly (uses the release binary; no need to build from source).
- **Developing:** see README → Development. Tests: `bun run test` (all test files in parallel; `bun test test/<file>` runs one file). While building or fixing, use `bun run test --related` (only the tests your changes can affect); when the full run happens is in Check above. Typecheck: `bunx tsc --noEmit`. UI build: `bun run build:web`.
- **After changing code while the daemon runs from source:** `bun run build:web && bun src/cli.ts restart`.
- **Releasing:** in `CHANGELOG.md`, rename `## Unreleased` to `## [X.Y.Z] - <date>` (first check it covers every user-facing `feat:`/`fix:` since the last tag: `git log vPREV..HEAD --oneline`; write plain user-facing lines, not commit subjects), add a fresh empty `## Unreleased` and the compare link at the bottom; bump `package.json` version; commit `chore: release vX.Y.Z`, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`. GitHub Actions builds and publishes the GitHub release and the `npx ckanban` installer on npm (if npm stages it, approve it on npmjs.com), using that CHANGELOG section as the release notes (the release fails early if the section is missing).
- **Changelog:** tickets don't edit `CHANGELOG.md` (parallel tickets would conflict); it is written at release time from the commits.
- `src/api/web-assets.gen.ts` is a stub; `scripts/build-bin.ts` overwrites it during binary builds and restores it. Never commit a generated version.
