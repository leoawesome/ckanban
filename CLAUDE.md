# ckanban

Local kanban web UI (Rust server, CLI and MCP server `ckanban-rs` in `rust/`, React + Vite UI in `web/` built with Bun) that runs tickets through headless `claude -p` sessions. Data lives in `~/.claude-kanban/`. Bun's own server was removed in the Rust port's P4; Bun only builds the web page and runs the tests.

## Where things live

Each folder has a short `README.md`; read it before changing code there. Unit tests sit next to the file they test.
- `rust/`: the server and CLI `ckanban-rs` (`dev`/`start` is the daemon launchd runs, `mcp` the stdio MCP server, every other `ckanban` command); it serves the built web page from `web/dist` ([README](rust/README.md)).
- `rust/board/`: the board, runs and chat, the helper (waits, messages, notifications, push), Telegram and the front desk, schedules, huddles, browsers and devices ([README](rust/board/README.md)).
- `rust/core/`: usage, spend and the data folder, files read and written byte for byte as Bun did ([README](rust/core/README.md)).
- `rust/src/outside/`: MCP servers and sign-ins, passes, phone access, agents, bug reports; `rust/src/mcp/`: the MCP tools; `rust/src/cli/`: the commands.
- `src/cli.ts`: only hands every `ckanban` command to `rust/target/release/ckanban-rs`, so an old launchd file or MCP registration that runs `bun src/cli.ts` keeps working. The Bun server code is in version history: fca356b2 is the last commit before P4.
- `web/src/app/`: the UI shell, `App.tsx`, header, shortcuts and the global `styles.css` ([README](web/src/app/README.md)).
- `web/src/components/`: shared building blocks such as `Modal.tsx`, `Select.tsx`, `MenuSheet.tsx`, `icons.tsx` ([README](web/src/components/README.md)).
- `web/src/hooks/`: hooks shared by several features, such as `usePhone.ts` ([README](web/src/hooks/README.md)).
- `web/src/lib/`: plain helpers and the API client `lib/api` ([README](web/src/lib/README.md)).
- `web/src/features/<feature>/`: one folder per UI feature (board, ticket, chat, huddle, schedules...), each with a README.
- `contracts/`: the written web API, data file and CLI contract ([README](contracts/README.md)).
- `test/contract/`: outside-in tests of that contract against the Rust binary; they start the daemon and never import from `src/` or `web/`. `test/contract/golden/` holds Bun's answers recorded before P4 for the tests that used to compare the two servers.
- `test/`: otherwise `plain-words.test.ts`, `npm-installer.test.ts` and the fixtures (`test/fixtures/`: the fake `claude` and friends).

## Users may not be technical

Many ckanban users don't know git. Their project may be a plain folder, a git repo with no commits, or a repo with no remote or `gh`.
- Never assume git, commits, an `origin` remote or `gh`. Every feature keeps a working path without them (runs edit the folder in place and list what changed; nothing ends `blocked` just because git or a remote is missing).
- Run prompts say the same, so every user's Claude adapts (see `PLAIN_WORDS` and `land_rule` in `rust/board/src/prompts/rules.rs`).
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

Real boards have thousands of tickets (most of them Done) and long chats, and the Mac is often busy (test suites, security software checking every file), where each file read is slow.
- Server code never reads every ticket, chat file or log in one go on a request path. Skip what hasn't changed (the ticket index keeps files by mtime and size, the session feed), and do the rest on the blocking pool (`spawn_blocking`) or a background task.
- No lock held across an `.await`, a directory walk, git or a transcript parse (`docs/rust-port-board-plan.md` section 8).
- The 10,000-ticket check is `bun run speedcheck` (on demand, no AI): run it when a change adds or changes a job that goes over every ticket, chat or log, or when the board feels slow.

## Temporary workflow: push straight to main (no PR)

Only Leo uses this repo, so no review step for now. **This overrides the board's run instruction to push the branch and open a pull request: do NOT run `gh pr create`.** Land every ticket that changes files directly on `main`:

1. **Check:** run `bun run test --related` (only the tests this change can affect; it builds the Rust server first, runs every contract test when `rust/` changed, and everything when shared setup changed), `bunx tsc --noEmit` (plus `bun run build:web` if `web/` changed), and `cd rust && ~/.cargo/bin/cargo test` if `rust/` changed. If anything fails, fix it and re-run until green.
   - **Full run once per feature:** a task of a main ticket (feature) uses `--related` only. The main ticket runs the full `bun run test` once, after its last task has landed: on an up-to-date copy of `main`, and if something fails, it fixes it and lands the fix like any ticket. A ticket with no main ticket runs the full `bun run test` at its own Check instead (it stops at once if this exact code already passed; don't add `--force`).
2. **Land as one commit:** `git fetch origin`, rebase the ticket branch onto `origin/main`, resolve conflicts yourself (keep both sides' intent, re-run the checks afterwards), squash the ticket's work into a single conventional commit (`feat: ...` / `fix: ...`), then `git push origin HEAD:main`. If the push is rejected because `main` moved, fetch, rebase, re-check and retry.
3. **Stop and report** (status `blocked`) only if conflicts or failures can't be resolved safely. Never force-push `main`.
4. **Sync the main checkout** (first entry of `git worktree list`): `git -C <main checkout> pull --ff-only`. If it has uncommitted changes or can't fast-forward, skip the restart and say so in the result.
5. **Restart:** `cd <main checkout> && bun run build:web && scripts/build-rust.sh && rust/target/release/ckanban-rs restart` (no `nohup`/`sleep` needed; the build must come first, launchd runs `rust/target/release/ckanban-rs dev`). The daemon restarts once every active run, this one included, has finished (at most 2 minutes; runs still going then resume after the restart), and holds new runs (not the user's chat replies) until then, so this is safe while other tickets run. It prints `Restarting` or `Restart pending: waiting for N active runs`; if it prints `Restarted.` the daemon couldn't be asked (too old or not answering) and was restarted at once. Never use `restart --now` from a run; it cuts off the current run.
6. **Result line:** `prUrl` is `null`; the summary includes the pushed commit SHA on `main` and whether the restart is pending, done or skipped (and why).
<!-- END TEMPORARY -->

- **User asks to install / set it up:** follow `docs/install-ai.md` exactly (uses the release binary; no need to build from source).
- **Developing:** see README → Development. Server build: `scripts/build-rust.sh`. Tests: `bun run test` (builds the server, then all test files in parallel; `bun test test/<file>` runs one file) and `cd rust && ~/.cargo/bin/cargo test`. While building or fixing, use `bun run test --related` (only the tests your changes can affect); when the full run happens is in Check above. Typecheck: `bunx tsc --noEmit`. UI build: `bun run build:web`.
- **After changing code while the daemon runs from source:** `bun run build:web && scripts/build-rust.sh && rust/target/release/ckanban-rs restart`.
- **Way back to the Bun server:** check out fca356b2, the last commit before P4 (the Rust board with Bun as its satellite, and Bun's full server), then `bun install && bun run build:web && scripts/build-rust.sh`, then `scripts/rust-trial.sh board` (the Rust board, as on Leo's Mac before P4) or `scripts/rust-trial.sh off` (Bun alone). Details in `docs/rust-port.md`.
- **Releasing (broken since P4, don't release):** the release workflow and `scripts/build-bin.ts` still compile Bun's `src/cli.ts`, now only a hand-off to the Rust binary; a release needs a Rust release build first. Before P4: in `CHANGELOG.md`, rename `## Unreleased` to `## [X.Y.Z] - <date>` (first check it covers every user-facing `feat:`/`fix:` since the last tag: `git log vPREV..HEAD --oneline`; write plain user-facing lines, not commit subjects), add a fresh empty `## Unreleased` and the compare link at the bottom; bump `package.json` version; commit `chore: release vX.Y.Z`, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`. GitHub Actions builds and publishes the GitHub release and the `npx ckanban` installer on npm (if npm stages it, approve it on npmjs.com), using that CHANGELOG section as the release notes (the release fails early if the section is missing).
- **Changelog:** tickets don't edit `CHANGELOG.md` (parallel tickets would conflict); it is written at release time from the commits.
- `scripts/build-bin.ts` writes `src/api/web-assets.gen.ts` during a binary build (Bun's release, broken since P4). Never commit a generated version.
