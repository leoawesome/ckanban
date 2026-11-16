# ckanban CLI contract

What the `ckanban` command does today (Bun + TypeScript), written so a Rust port can match it. Sources: `src/cli/cli.ts` (dispatch, daemon management, artifact, remote, call), `src/cli/ticket-cli.ts` (profiles, ticket, mcp subcommands), `src/cli/client.ts` (HTTP client and text formatters), `src/mcp/server.ts` (stdio MCP server), `src/browser/browser-mcp.ts`.

Where something can't be told from the code, this file says so.

## 1. Basics

### Invocation and dispatch

`process.argv[2]` is the command. Unknown or missing command: prints the usage text (section 1.6) to **stdout**; exit 0 when no command was given, exit 1 for an unknown one (this includes `--help` and `-h`, which are not recognized).

| Command | Handler |
|---|---|
| `dev`, `start` | run the daemon in the foreground (`startDaemon()` in `src/cli/daemon.ts`) |
| `install` | write the launchd plist and start it |
| `restart [--now]` | graceful or forced daemon restart |
| `uninstall` | remove phone access, MCP registrations and launchd job |
| `open` | open the board in the browser |
| `update` | self-update the release binary |
| `remote on\|off\|status` | phone access over Tailscale |
| `artifact publish\|read ...` | claude.ai artifacts via a local Claude Code session |
| `profiles` | list boards |
| `ticket ...`, `tickets ...` | ticket subcommands (both spellings are identical) |
| `call <service> <tool> [json]` | automation check scripts only |
| `mcp` (no further args) | stdio MCP server |
| `mcp install\|uninstall\|status` | register the MCP server with Claude Code / Codex |
| `browser-mcp --id ... --dir ...` | internal: one run's browser MCP server (not in usage text) |
| `--version`, `-v`, `version` | print the version |

### How the CLI finds the daemon

- Port: `Number(process.env.CKANBAN_PORT) || config.port`, where `config` is `<root>/config.json` merged over the default `{ "port": 7777, "prPollMinutes": 5 }`. A missing or unparsable `config.json` gives the default. `CKANBAN_PORT=0` or a non-number falls through to the config.
- Data root `<root>`: `process.env.CKANBAN_HOME ?? ~/.claude-kanban`.
- Base URL for `BoardClient` (profiles, ticket, call, mcp tools): `http://127.0.0.1:<port>` (IPv4 literal, because the daemon only listens on 127.0.0.1 and checks the Host header).
- `restart`, `update`, `open`, `install` output and `browser-mcp` use `http://localhost:<port>` instead.
- The daemon accepts a local request only when `Host` is `localhost:<port>` or `127.0.0.1:<port>`, and, for non GET/HEAD requests, when `Origin` is absent or is `http://localhost:<port>` / `http://127.0.0.1:<port>`. The CLI never sends `Origin`.

### Auth and identity headers

There is no auth token for local requests. The client adds these headers when the matching env var is set (all optional):

| Header | Value from | Sent on |
|---|---|---|
| `content-type: application/json` | always when there is a body | every request with a body |
| `x-ckanban-frontdesk` | env `CKANBAN_FRONTDESK` | every request |
| `x-ckanban-quick-chat` | env `CKANBAN_QUICK_CHAT` | every request |
| `x-ckanban-run` | env `CKANBAN_TICKET` (`<slug>/<ticket id>`) | calls that pass `run` (most changing calls from MCP tools; `ticket setup`, `take-device`, `release-device` from the CLI) |
| `x-ckanban-source: mcp` | constant | huddle, huddle preset, schedule run and job calls (`as()` in client.ts) |
| `x-ckanban-huddle-agent` | env `CKANBAN_HUDDLE_AGENT` | same calls as `x-ckanban-source` |

`ckanban call` sends its secret in the JSON body (`token`), not a header.

### HTTP error handling (BoardClient.req)

- `fetch` throws (daemon down, refused): error text `ckanban daemon not running, run \`ckanban install\` or \`ckanban dev\`` (constant `DAEMON_DOWN`).
- Status 204: result is `undefined`.
- Non-2xx: error text is the JSON body's `error` field, else `<METHOD> <path> failed: <status>`.
- Status 202 with a string `confirmation` field: a `ConfirmPending` error (subclass of `ClientError`) carrying that text. Only happens for Telegram front desk callers. In the CLI this is printed to stderr with exit 1 like any other error; in MCP it is returned as a normal (non-error) tool result.
- "Long" calls (setup, take-device, merge-into-main, land, automation-call, loops/test, telegram file) pass `timeout: false` to Bun's fetch so they can wait minutes.

### Errors and exit codes

- `profiles`, `ticket`, `tickets`, `call` and `mcp <sub>` run inside `board()`: a `ClientError` or `AgentError` prints its message alone (no stack) to **stderr** and exits **1**.
- Any other exception is uncaught: Bun prints it with a stack trace and exits non-zero (1 in practice; not pinned by code).
- Success exits 0 (implicit).
- Other per-command exit codes are listed with each command.

### Usage text (exact, printed for an unknown or missing command)

The first line contains an em dash in the source. `${TICKET_USAGE}` is the block in section 3.

```
ckanban — kanban board for Claude Code

Usage:
  ckanban dev          Run the server in the foreground
  ckanban start        Same as dev (used by launchd)
  ckanban install      Install and start the launchd background daemon (macOS)
  ckanban restart      Restart the daemon once active runs finish (after pulling or building changes)
                       --now: restart at once (cut-off replies resume after the restart)
  ckanban uninstall    Stop and remove the launchd daemon, turn off phone access and remove the MCP
                       from Claude Code and Codex (your boards stay)
  ckanban open         Open the board in your browser
  ckanban update       Update to the latest release and restart the daemon
  ckanban remote on|off|status
                       Phone access over Tailscale (tailnet only, your login only)
  ckanban artifact publish <file> [--url <artifact url>] [--title <title>]
                       Publish a page to claude.ai (works from headless board runs)
  ckanban artifact read <url> [--out <file>]
                       Save an artifact's page source to a local file
  ckanban call <service> <tool> ['<json arguments>']
                       From an automation's check script: call a tool of a service connected for automations
${TICKET_USAGE}
  ckanban --version    Print the version

```

(`console.log` adds one more newline after the template's trailing newline.)

## 2. Daemon management commands (src/cli/cli.ts)

### `ckanban dev` / `ckanban start`

Runs `startDaemon()` in the foreground. No args. Port as in section 1, listens on 127.0.0.1. launchd runs `start` (via the plist's program args). Output: daemon logs on stdout/stderr (under launchd they go to `<root>/daemon.log`).

### `ckanban install`

1. `mkdir -p <root>` and the plist's folder.
2. Writes `~/Library/LaunchAgents/io.ckanban.daemon.plist` (label `io.ckanban.daemon`). Program args: `[execPath]` for the release binary, `[execPath, <src>/cli.ts]` from source, and `plistXml` (`src/cli/launchd.ts`) appends `start`. `PATH` in the plist is the current `PATH` entries plus `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, de-duplicated, in that order. Log file `<root>/daemon.log`. `HOME` = home dir.
3. `launchctl bootout gui/<uid>/io.ckanban.daemon` (silent), waits up to 5 s (50 x 100 ms) for `launchctl print` to fail, then `launchctl bootstrap gui/<uid> <plist>` up to 5 tries, 500 ms apart.
4. On failure: stderr `launchctl bootstrap failed`, exit with bootstrap's exit code.
5. On success, stdout:

```
Installed /Users/<you>/Library/LaunchAgents/io.ckanban.daemon.plist
Board: http://localhost:<port>
Logs: <root>/daemon.log
```

The plist (`plistXml` in `src/cli/launchd.ts`), exact. `{ARG}` stands for one line per program argument; `{PATH}`, `{HOME}` and `{LOG}` (used twice) for the values above. Every value is XML-escaped: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` (quotes are left as they are). The file ends with one newline after `</plist>`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.ckanban.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>{ARG}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{PATH}</string>
    <key>HOME</key>
    <string>{HOME}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{LOG}</string>
  <key>StandardErrorPath</key>
  <string>{LOG}</string>
</dict>
</plist>
```

The plist is written before `launchctl` runs, so it stays in place when bootstrap fails.

### `ckanban restart [--now]`

`--now` is detected anywhere in argv.

1. `launchctl print gui/<uid>/io.ckanban.daemon`; if non-zero: stderr `daemon not installed; run: ckanban install`, exit 1.
2. Without `--now`: `POST http://localhost:<port>/api/restart`, body `{}`, `content-type: application/json`, 5 s timeout. Reply JSON `{ running: number }`. A network error or non-2xx means "can't ask" (null).
3. Result:
   - null (or `--now`): `launchctl kickstart -k gui/<uid>/io.ckanban.daemon` (output inherited); non-zero exit is passed through as the exit code. Then stdout `Restarted. Board: http://localhost:<port>`.
   - `running == 0`: stdout `Restarting. Board: http://localhost:<port>`.
   - `running == N > 0`: stdout (two lines):

```
Restart pending: waiting for N active run(s) to finish (at most 2 min).
New runs, huddle wakes and Planning interviews start after the restart; your chat messages are answered as usual. Use `ckanban restart --now` to restart at once.
```

  ("run" when N is 1, "runs" otherwise; 2 is `RESTART_MAX_WAIT_MS / 60000`.)

### `ckanban uninstall`

1. If phone access is on: turns it off (15 s limit). Failure: stderr `Couldn't turn off phone access (<reason>); run "ckanban remote off" later.`
2. Checks Claude Code and Codex registrations (15 s limit); failure: stderr `Couldn't check Claude Code and Codex (<reason>); run "ckanban mcp uninstall" later.` For each registered agent (skipping Claude when its CLI isn't found) removes it; failure: stderr `Couldn't remove ckanban from <Claude Code|Codex> (<reason>); run "ckanban mcp uninstall --<claude|codex>" later.`
3. `launchctl bootout gui/<uid>/io.ckanban.daemon` (output inherited, exit code ignored), deletes the plist.
4. stdout `Uninstalled ckanban daemon`, then `process.exit(0)`. Board data is kept.

### `ckanban open`

Runs `open http://localhost:<port>`. Exit code: always 0 (the `open` exit code is not used).

### `ckanban update`

- From source (`IS_BINARY` false): stdout ``Running from source: use `git pull && bun install && bun run build:web && ckanban restart`.``, exit 0.
- Gets the latest release from `https://api.github.com/repos/leoawesome/ckanban/releases/latest`. Unreachable: stderr `Could not reach GitHub to check for updates.`, exit 1.
- Same version: stdout `Already on the latest version (v<VERSION>).`
- Needs assets `ckanban-darwin-<arch>` and `SHA256SUMS`; missing: stderr `No build for darwin-<arch> in release v<ver>.` or `Release v<ver> has no SHA256SUMS, so the download can't be verified. Not updated.`, exit 1.
- stdout `Updating v<old> → v<new>…` (arrow and ellipsis characters in the source).
- Download error: stderr `Download failed: <status> <statusText>`, exit 1. Checksum mismatch: stderr `Checksum mismatch for <asset>: expected <a>, got <b>. The download may be corrupt or tampered with. Not updated.`; no entry: `SHA256SUMS has no entry for <asset>. Not updated.`, exit 1.
- Writes `<execPath>.new`, chmod 755, renames over `execPath`. If the launchd job exists: graceful restart as in `restart` (falls back to `kickstart -k`).
- stdout `Updated to v<new>.` plus one of: nothing (daemon not installed), ` Daemon restarts once N active run(s) finish; then refresh the board.`, or ` Daemon restarted; refresh the board.`

### `ckanban --version` / `-v` / `version`

stdout: `VERSION` alone, e.g. `0.18.1`. From source it prints `dev` (the build defines `CKANBAN_VERSION`; unset means `dev`).

## 3. Board commands (src/cli/ticket-cli.ts)

### Ticket usage block (`TICKET_USAGE`, exact)

```
  ckanban profiles     List boards (profiles) and their folders
  ckanban ticket list [--status <s>] [--query <words>] [--limit <n>] [--after <id>] [--include-tool]
                       Open work (not Done) newest first, 100 at a time; --status done pages
                       through Done, --query finds tickets by words in any column (at most 100)
  ckanban ticket show <id> [--comments-before <n>]
  ckanban ticket create --title <t> [--body <md> | --body-file <f>] [--status <s>] [--mode interview|auto] [--needs <r1,r2>] [--tags <t1,t2>]
  ckanban ticket update <id> [--title <t>] [--body <md> | --body-file <f>] [--status <s>] [--mode <m>] [--needs <r1,r2>] [--tags <t1,t2>] [--show-on-board true|false]
  ckanban ticket move <id> <status>
  ckanban ticket chat <id> <message>
  ckanban ticket comment <id> <text>
  ckanban ticket stop <id>
  ckanban ticket delete <id>
  ckanban ticket setup [<board>/]<id>
                       Install a ticket's project dependencies (the board's setup command)
                       in its copy of the folder; waits until done. Runs ask for this.
  ckanban ticket take-device <name> [<name>...]
                       Inside a board run: take shared devices for this ticket just before
                       using them (all at once; waits up to 4 minutes, then call again).
  ckanban ticket release-device [<name>...]
                       Let go of them (all of this run's devices when no name is given).
  ckanban ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]
                       File a ckanban bug as a GitHub issue (with <id>: attach that
                       ticket's details and last run log). Needs gh, else prints a link.
                       Ticket commands act on the board whose folder contains the current
                       directory; --profile <slug> picks another. --json prints raw JSON.
                       --body - / --body-file - read the description from stdin.
  ckanban mcp          Run the board's MCP server on stdio (for Claude Code, Codex, ...)
  ckanban mcp install [--claude] [--codex]
                       Register the MCP server with Claude Code and/or Codex (default: both)
  ckanban mcp uninstall [--claude] [--codex]
  ckanban mcp status   Show where the MCP server is registered
```

### Argument parsing (`parseArgs`)

- `--name value` and `--name=value` set a flag. `--` ends flags (the rest is positional). A lone `--` or any arg not starting with `--` is positional. Single-dash args (`-x`) are positional.
- Boolean flags (take no value): `json`, `claude`, `codex`, `no-logs`, `include-tool`.
- Any other `--name` as the last arg: error `--<name> needs a value` (exit 1).
- The value after a non-boolean flag is taken even if it starts with `--`.
- Unknown flags are accepted and ignored.
- A flag given twice: the last one wins.
- `--body` / `--body-file`: both given: error `use --body or --body-file, not both`. Value `-` reads all of stdin (UTF-8). `--body-file <path>` reads that file.
- `--needs a,b`: split on commas, trimmed, lowercased, empty dropped. `--needs ""` gives an empty list.
- `--tags a,b`: split on commas, then `normalizeTags` (`src/board/tags.ts`).
- Status values (`parseStatus`): trimmed, lowercased, runs of spaces/dashes become `_`; must be one of `backlog, planning, ready, in_progress, review, done`. Else error `invalid status "<s>"; use one of: backlog, planning, ready, in_progress, review, done`.
- Mode values (`parseMode`): `interview` or `auto` (case-insensitive). Else error `invalid mode "<s>"; use interview or auto`.
- A missing required positional: error `usage: ckanban <usage>` with the usage shown per command below.

### Picking the board (profile)

For every ticket subcommand except `report-bug` without an id, `take-device` and `release-device`:

1. `GET /api/profiles` (one call per command).
2. Explicit name: `--profile <slug>`, else the profile part of `CKANBAN_TICKET` (`<slug>/<id>`). Matched by exact slug, then by name case-insensitively. No match: error `no profile "<x>". <profile list text>`.
3. Else the profile whose `path` (realpath) is the deepest folder containing the realpath of the current directory.
4. Else, if the cwd is inside a git worktree, the same lookup on the main checkout (`git rev-parse --path-format=absolute --git-common-dir`, then its parent).
5. Else error `no profile matches <cwd>; pass a profile. <profile list text>`.

### Read-only inside board runs

When `CKANBAN_TICKET` is set, every ticket subcommand except `list`, `show`, `report-bug`, `setup`, `take-device`, `release-device` fails before any HTTP call with:

```
changing the board is disabled inside a board run (CKANBAN_TICKET=<value>), so runs can't create or start other runs. Reading tickets still works; ask the user to make this change on the board.
```

### `--json`

Every board command accepts `--json`: it prints `JSON.stringify(data, null, 2)` of the daemon's answer (shape noted per command) instead of the text.

### `ckanban profiles [--json]`

- Route: `GET /api/profiles`. Answer: `[{ name, slug, path, baseBranch, running? }]`.
- Text (`profileList`):

```ts
if (!profiles.length) return "No profiles yet; add one on the board first.";
return "Profiles:\n" + profiles.map((p) => `  ${p.slug}  (${p.name}, ${p.path})`).join("\n");
```

Example:

```
Profiles:
  kanban  (kanban, /Users/leo/dev/github/leoawesome/kanban)
  notes  (Notes, /Users/leo/Documents/notes)
```

### `ckanban ticket list [--status <s>] [--query <words>] [--limit <n>] [--after <id>] [--include-tool] [--profile <slug>] [--json]`

- Route: `GET /api/profiles/<slug>/tickets?scope=list[&status=<s>][&tool=1][&q=<trimmed query>][&limit=<n>][&after=<id>]` (`URLSearchParams` order: scope, status, tool, q, tags, limit, after; the CLI never sends `tags`). `--limit` is sent only when it is a number > 0 (floored).
- Daemon side (`listScope` in `src/board/ticket-scope.ts`): newest first by id. Default page 100; max 500 without a query, 100 with a query. No status and no query: every column except Done, with `doneLeft` counting the skipped Done tickets. A query matches lowercase substring of `id\ntitle\nbody` in every column (or only `status`), capped to the newest 100 (no further pages). Tool tickets are skipped unless `tool=1`.
- Answer (`TicketListPage`): `{ tickets: TicketInfo[], total, matched?, doneLeft, next: string | null }`. `--json` prints this.
- Text (`ticketListText`, exact code):

```ts
const what = q.query?.trim() || q.tags?.length
  ? `matching ${[q.query?.trim() ? `"${q.query.trim()}"` : "", ...(q.tags ?? []).map((g) => `#${g}`)].filter(Boolean).join(" ")}${q.status ? ` in ${q.status}` : " in any column"}`
  : q.status ? `in ${q.status}` : "open work (not Done)";
const lines: string[] = [];
if (!page.tickets.length) lines.push(`Board ${slug}: no ${what === "open work (not Done)" ? "open tickets (not Done)" : `tickets ${what}`}${q.after ? ` after ${q.after}` : ""}.`);
else {
  const shown = page.tickets.length < page.total ? `${page.tickets.length} of ${page.total}` : `${page.total}`;
  lines.push(`Board ${slug}, ${what}, newest first: ${shown}${q.after ? ` (after ${q.after})` : ""}.`, ...page.tickets.map(ticketLine));
}
if (page.next) lines.push(`More: ${more(page.next)}.`);
if (page.matched && page.matched > page.total) lines.push(`${page.matched} tickets match; only the newest ${page.total} are listed: narrow the query or add a status.`);
if (page.doneLeft) lines.push(`${page.doneLeft} Done ticket${page.doneLeft === 1 ? "" : "s"} not listed: ${doneHint}.`);
return lines.join("\n");
```

  For the CLI, `doneHint` is `use --status done, or --query`, and `more(after)` is:

```ts
`ckanban ticket list ${again ? `${again} ` : ""}--after ${after}`
// again = ["--status <raw status as typed>", "--query <JSON-quoted query>", "--limit <n>", "--include-tool"] (those given), joined by spaces
```

- One ticket line (`ticketLine`, shared with `ticket update` and `ticket move`):

```ts
function state(t) {
  const bits = [t.status];
  if (t.running) bits.push("running");
  else if (t.outcome) bits.push(t.outcome);           // done | blocked | failed | stopped | needs_input | limit
  if (t.attention?.kind && !t.running) bits.push(`waiting: ${t.attention.kind}`);
  return bits.join(", ");
}
const extra = [
  t.feature ? "open feature" : null, t.kind ? t.kind : null,
  t.parentId ? `in plan ${t.parentId}` : null, t.needs?.length ? `needs ${t.needs.join(", ")}` : null,
  t.tags?.length ? t.tags.map((g) => `#${g}`).join(" ") : null,
].filter(Boolean);
return `${t.id}  [${state(t)}]  ${t.important ? "⭐ " : ""}${t.title}${extra.length ? `  (${extra.join("; ")})` : ""}`;
```

  Separators are two spaces. `⭐ ` (star plus one space) prefixes important tickets.

Example (`ckanban ticket list --limit 3` on a board with more open work):

```
Board kanban, open work (not Done), newest first: 3 of 41.
t_20261115_cot1  [in_progress, running]  Write the API and data contract  (open feature; build; #rust)
t_20261114_k2m9  [review, needs_input]  ⭐ Phone Move to opens the next card  (needs emulator; #ui)
t_20261114_a7qz  [backlog]  Explore a Rust port of the daemon
More: ckanban ticket list --limit 3 --after t_20261114_a7qz.
1204 Done tickets not listed: use --status done, or --query.
```

Empty example: `Board kanban: no open tickets (not Done).` With a query: `Board kanban: no tickets matching "rust" in any column.`

### `ckanban ticket show <id> [--comments-before <n>] [--profile <slug>] [--json]`

- Routes (in parallel): `GET /api/profiles/<slug>/tickets/<id>` and `GET /api/profiles/<slug>/tickets/<id>/comments?last=50[&before=<n>]`. `before` is sent only when `--comments-before` is a number >= 0 (floored).
- Comments answer: `{ comments: [{ id, author, text, at }], earlier, total }`.
- `--json` prints `{ ...ticket, comments, earlierComments: earlier }`.
- Text (`ticketText`, exact code):

```ts
const lines = [
  `${t.title}`,
  `id: ${t.id}`,
  `status: ${state(t)}`,
  `mode: ${t.mode ?? "auto"}`,
];
if (t.jobId) lines.push(`job: ${t.jobId} (created by this one-time job; see list_jobs)`);
if (t.scheduleId) lines.push(`schedule: ${t.scheduleId} (created by this schedule; see list_schedules)`);
if (t.parentId) lines.push(`plan: child of ${t.parentId}${t.planKey ? ` (key ${t.planKey})` : ""}`);
if (t.partOf) lines.push(`part of: ${t.partOf} (get_family lists its whole family)`);
if (t.madeFrom) lines.push(`asked for in the chat of: ${t.madeFrom}`);
if (t.dependsOn?.length) lines.push(`depends on: ${t.dependsOn.join(", ")}`);
if (t.needs?.length) {
  const r = t.resources;
  const now = r?.holding ? " (in use by this ticket)" : r?.waitingFor.length ? ` (waiting for ${r.waitingFor.join(", ")})` : "";
  lines.push(`needs: ${t.needs.join(", ")}${now}`);
}
if (t.tags?.length) lines.push(`tags: ${t.tags.join(", ")}`);
if (t.suggestedTags?.length) lines.push(`suggested tags (not kept yet): ${t.suggestedTags.join(", ")}`);
if (t.userWait) lines.push(`waiting on the user: ${t.userWait}`);
if (t.branch) lines.push(`branch: ${t.branch}`);
if (t.prUrl) lines.push(`pr: ${t.prUrl}`);
if (t.lastActivity) lines.push(`activity: ${t.lastActivity}`);
if (t.error) lines.push(`error: ${t.error}`);
lines.push("", t.body.trim() || "(no description)");
if (comments.length) {
  lines.push("", earlier?.count ? `Comments (the last ${comments.length}; ${earlier.count} earlier not shown: ${earlier.how}):` : "Comments:");
  for (const c of comments) lines.push(`- ${c.author} (${c.at}): ${c.text}`);
}
return lines.join("\n");
```

  For the CLI, `earlier.how` is `ckanban ticket show <id> --comments-before <earlier>`. `state(t)` is the same as in `ticket list`. Note `mode` falls back to `auto` when the ticket has none.

Example:

```
Write the API and data contract
id: t_20261115_cot1
status: in_progress, running
mode: auto
part of: t_20261110_rst0 (get_family lists its whole family)
tags: rust
branch: ck/t_20261115_cot1-write-the-api-and-data-contract-plus-out
activity: Writing contracts/cli.md

## Goal
Write the contracts a Rust port needs.

Comments (the last 50; 3 earlier not shown: ckanban ticket show t_20261115_cot1 --comments-before 3):
- user (2026-11-15T09:12:03.000Z): Keep it exact.
- claude (2026-11-15T09:40:11.000Z): First draft is in contracts/.
```

  (The `at` value is printed as the daemon sends it; the code doesn't reformat it. The example's ISO form is an assumption about the daemon's comment format.)

### `ckanban ticket create --title <t> [--body <md> | --body-file <f>] [--status <s>] [--mode interview|auto] [--needs <r1,r2>] [--tags <t1,t2>]`

- Title: `--title`, else the positional args after `create` joined by spaces (so `ticket create Fix the login` works). Trimmed. Empty: error `usage: ckanban ticket create --title <t> [--body <md>]`.
- Route: `POST /api/profiles/<slug>/tickets` body `{ title, body (default ""), status (default "backlog"), mode (default "interview"), needs? (only when non-empty), tags? (only when non-empty) }`. No `x-ckanban-run` (the CLI refuses inside runs anyway).
- Text: `Created <id> on <slug> in <status> (<mode> mode): <title>`.

### `ckanban ticket update <id> [--title <t>] [--body ...] [--status <s>] [--mode <m>] [--needs ...] [--tags ...] [--show-on-board true|false]`

- Builds a patch: `title` (only if non-blank, trimmed), `body` (if given, even empty), `status`, `mode`, `needs` (if given, even empty), `tags` (if given), `showOnBoard` (must be literally `true` or `false`, else error `--show-on-board must be true or false`).
- Empty patch: error `nothing to change: pass --title, --body, --status, --mode, --needs, --tags or --show-on-board`.
- Missing id: error `usage: ckanban ticket update <id> [--title ...]`.
- Route: `PATCH /api/profiles/<slug>/tickets/<id>` with the patch.
- Text: `Updated <ticketLine>`.

### `ckanban ticket move <id> <status>`

- Status from the second positional or `--status`. Missing: error `usage: ckanban ticket move <id> <status>`.
- Route: `PATCH /api/profiles/<slug>/tickets/<id>` body `{ status }`.
- Text: `Updated <ticketLine>`.

### `ckanban ticket chat <id> <message>`

- Message: remaining positionals joined by spaces (trimmed), else `--message`. Missing: error `usage: ckanban ticket chat <id> <message>`.
- Route: `POST /api/profiles/<slug>/tickets/<id>/chat` body `{ text }`. Answer: the ticket.
- Text: `Sent to <id>; Claude is working on it.` when the answer has `running: true`, else `Sent to <id>.`

### `ckanban ticket comment <id> <text>`

- Text: remaining positionals joined, else `--text`. Missing: error `usage: ckanban ticket comment <id> <text>`.
- Route: `POST /api/profiles/<slug>/tickets/<id>/comments` body `{ text }`. Answer: the comment `{ id, author, text, at }`.
- Text: `Commented on <id>.`

### `ckanban ticket stop <id>`

- Route: `POST /api/profiles/<slug>/tickets/<id>/stop` body `{}`. Answer `{ stopped: boolean }`.
- Text: `Stopped the run on <id>.` or `<id> had no run to stop.`

### `ckanban ticket delete <id>`

- Route: `DELETE /api/profiles/<slug>/tickets/<id>` (no body).
- Text: `Deleted <id>.`; `--json` prints `{ "deleted": "<id>" }`.

### `ckanban ticket setup [<board>/]<id>`

- Allowed inside runs. Board: the part before `/`, else `--profile`, else the run's profile, else the cwd lookup.
- Route: `POST /api/profiles/<slug>/tickets/<id>/setup` body `{}`, header `x-ckanban-run` when `CKANBAN_TICKET` is set; long wait.
- Answer `SetupOutcome`: `{ status: "ran", result: SetupResult }` or `{ status: "already-done" | "no-command" | "no-worktree" }`. `SetupResult` = `{ copied: string[], missing: string[], command, ok: boolean|null, exitCode: number|null, timedOut, output, durationMs }`.
- Text (`setupText`):
  - `already-done`: `Already done: this ticket's dependencies are installed.`
  - `no-command`: `Nothing to install: this board has no setup command.`
  - `no-worktree`: `Nothing to install: this ticket works in the project folder itself, not a separate copy.`
  - ran ok: ``Installed the project's dependencies in <secs>s (`<command>`).`` then a line `<ckanban-setup>{SetupResult JSON with every "<" written as the six characters \u003c}</ckanban-setup>` (the `result` object re-serialized compactly, keys in the order the daemon sent them).
  - ran and failed: ``\`<command>\` failed (exit <code or "signal">) after <secs>s. Last lines of its output:`` (or `timed out after <secs>s.`), then the output, then the `<ckanban-setup>` line.
- Exit: after printing, a failed run raises `Setup timed out.` or `Setup failed (exit <code|signal>).` on stderr, exit 1.

### `ckanban ticket take-device <name> [<name>...]` / `ckanban ticket release-device [<name>...]`

- Only inside a run: `CKANBAN_TICKET` must be `<slug>/<id>`, else error `ckanban ticket take-device works inside a board run, for its own ticket` (or `release-device`). No profile lookup.
- take: no names: error `usage: ckanban ticket take-device <name> [<name>...]`. Route `POST /api/profiles/<slug>/tickets/<id>/devices` body `{ action: "take", names }`, header `x-ckanban-run`, long wait (the daemon waits up to about 4 minutes). Answer `{ ok: true, names }` or `{ ok: false, names, place, usedBy: [{ id, slug?, title|null, ... }] }`. Text (`deviceTakeText`):
  - ok: `You have <names, comma-joined> now. Use it, then let go with release_devices as soon as you are done, so the next ticket can have it.`
  - not ok: `Still waiting for <names>: <"title" (slug), ...> has it; you are #<place> in line and keep that place. Do other work that doesn't need it if there is some, then call take_devices again with the same names (each call waits up to 4 minutes).` (when `usedBy` is empty the middle reads `other tickets are ahead of you`).
- release: Route same path, body `{ action: "release", names: [] }` (empty means all of this run's devices). Answer `{ released: string[] }`. Text `Let go of <a, b>.` or `Nothing to let go of.`
- Both always exit 0 on a daemon answer (a not-ok take is not an error).

### `ckanban ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]`

- Allowed inside runs. `--title` required (trimmed); else error `usage: ckanban ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]`.
- With an id, the profile is resolved as usual; without, no profile call.
- Route: `POST /api/bug-report` body `{ title, description (body or ""), profile?, ticketId?, include: ["env","ticket","log"] (or ["env","ticket"] with --no-logs), source: "ai" when CKANBAN_TICKET is set else "cli" }`. Answer `{ url|null, fallbackUrl, error|null, screenshots: string[] }`.
- Text (`bugReportText`): `Created <url>` or

```
Could not create the issue: <error>
Open this link to file it in the browser instead (title and body are prefilled):
<fallbackUrl>
```

  plus, when screenshots is non-empty, a line `<n> screenshot(s) from the ticket were not uploaded; ask the user to drag them into a comment on the issue.` Exit 0 in both cases.

### Unknown or missing ticket action

`ckanban ticket` alone or with an unknown action: stderr `usage:\n` + the ticket usage block, exit 1. Known actions: `list, show, create, update, move, chat, comment, stop, delete, report-bug, setup, take-device, release-device`.

## 4. Other commands

### `ckanban call <service> <tool> ['<json arguments>']`

- Checked in this order. Missing service or tool: stderr `usage: ckanban call <service> <tool> ['<json arguments>']`, exit 1.
- Only inside an automation check script: needs env `CKANBAN_CALL_TOKEN` (the daemon sets it, with `CKANBAN_PORT`, in the script's clean environment). Missing: stderr `ckanban call only works inside an automation's check script`, exit 1.
- Third arg defaults to `{}`; bad JSON: stderr `The arguments must be JSON, e.g. '{"limit": 20}'`, exit 1.
- Route: `POST /api/automation-call` body `{ token, service, tool, args }`, long wait. Answer `{ result }`.
- stdout: `result` as is when it is a string, else `JSON.stringify(result)` (compact, one line).

### `ckanban artifact publish <file> [--url <artifact url>] [--title <title>]` / `ckanban artifact read <url> [--out <file>]`

No HTTP and no daemon. Runs a Claude Code session in a pseudo-terminal (or tmux when a pty isn't available) in `<root>/artifact-helper`, model `CKANBAN_ARTIFACT_MODEL` or `haiku`, binary `CKANBAN_CLAUDE_BIN` or `claude`, 180 s timeout. The helper's env is the caller's env minus Claude Code parent markers (`CLAUDE_CODE_ENTRYPOINT`, `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_EXECPATH`). Flags are read by simple `indexOf(name)`, not `parseArgs`.

- publish: file must exist, else stderr `no such file: <abs path>`, exit 1. Failure: stderr `artifact publish failed: <error>`, exit 1. Success stdout: the Artifact tool's own line, matched by `/Published (\S+) at (https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+)/`, e.g. `Published /tmp/page.html at https://claude.ai/artifact/AbC123` (fallback `Published <file> at <url>`).
- read: failure stderr `artifact read failed: <error>`, exit 1. Writes the HTML to `--out` or `<tmpdir>/artifact-<last url segment>.html`; stdout `Saved <url> to <path>`.
- Anything else: stderr (two lines) `usage: ckanban artifact publish <file> [--url <artifact url>] [--title <title>]` / `       ckanban artifact read <url> [--out <file>]`, exit 1.

### `ckanban remote on|off|status`

No HTTP. Reads and writes `<root>/remote.json` (the daemon re-reads it) and drives the `tailscale` CLI (the Tailscale app's own binary when present, else `tailscale` on PATH) with `tailscale serve` to proxy to the phone listener on 127.0.0.1. Phone listener port: `CKANBAN_REMOTE_PORT`, else `config.json` `remotePort`, else board port + 1. No action means `status`.

- Off: stdout `Phone access is off.`; a warning goes to stderr as `Warning: <text>`.
- On: stdout

```
Phone access is on: <url>
Only <login> can open it, from devices on your tailnet (never public).

<QR code drawn in the terminal>
```

  When Tailscale is stopped or can't be checked, a blank line and `Tailscale is off on this Mac (state: <backendState>): phone can't connect. Open the Tailscale app; turn on "Launch Tailscale at login" in its Settings.` (or `Can't check Tailscale on this Mac: ...`) are inserted before the blank line and QR.
- Bad action: stderr `usage: ckanban remote on|off|status`, exit 1. A `RemoteError` (Tailscale missing, not signed in, port taken...): message on stderr, exit 1. Exact Tailscale command lines and error texts live in `src/integrations/remote.ts`; not repeated here.

### `ckanban mcp install|uninstall [--claude] [--codex]` and `ckanban mcp status`

No HTTP. Neither flag means both agents. The registered command (`serverArgv`) is `[execPath, "mcp"]` for the binary or `[execPath, <src>/cli.ts, "mcp"]` from source.

- install, Claude Code: if `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) already has `mcpServers.ckanban` with the same argv, nothing; else runs `claude mcp remove ckanban --scope user` (when an entry exists) and `claude mcp add --scope user ckanban -- <serverArgv...>` (binary `CKANBAN_CLAUDE_BIN` or `claude`, cwd home, 60 s timeout). Codex: edits `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) atomically, keeping the file's permissions; nothing when the entry already has the same argv. The old `[mcp_servers.ckanban]` table (and its sub-tables) is dropped, trailing whitespace trimmed, and this block appended after one blank line (or written alone when nothing else is left). Values are JSON strings; the args array has `", "` between items:

```toml
[mcp_servers.ckanban]
command = "<serverArgv[0]>"
args = ["<serverArgv[1]>", "mcp"]
```

  The file ends with one newline after the block. stdout per agent: `Claude Code: registered "ckanban" → <serverArgv joined by spaces>` / `Codex: registered "ckanban" → ...` (arrow character in the source).
- uninstall: Claude Code: `claude mcp remove ckanban --scope user` only when an entry exists. Codex: when an entry exists, the table is dropped, trailing whitespace trimmed and one newline added. stdout `Claude Code: removed "ckanban"` / `Codex: removed "ckanban"` (printed whether or not there was an entry).
- An agent counts as available (status) when its CLI is on PATH (`CKANBAN_CLAUDE_BIN` or `claude`; `codex`), and for Codex also when the config folder exists. "Registered" means an entry exists; "current" means its argv equals `serverArgv`.
- Errors (`AgentError`, stderr, exit 1): `Claude CLI not found (<bin>). Is Claude Code installed and on PATH?`, `claude mcp add failed: <last 3 lines>`.
- status: one line per agent: `<Claude Code|Codex>: <state><" (CLI not found)" when unavailable>  [<config path>]`, state is `not registered`, `registered`, or `registered with another command (<command>)`.
- Unknown or missing action (`ckanban mcp` with any other first argument): stderr `usage:` followed by the four `ckanban mcp` lines and the `Register...` line of the ticket usage block (in that block's order), exit 1.

### `ckanban browser-mcp --id <id> --dir <data folder> [--name <name>] [--out <folder>]`

Internal, not in the usage text: the board passes it in a run's `--mcp-config`. Missing `--id`/`--dir`: stderr `usage: ckanban browser-mcp --id <id> --dir <data folder> [--name <name>] [--out <folder>]`, exit 1. Stdio JSON-RPC server (one JSON message per line) with tools `browser_tabs`, `browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_evaluate`, `browser_wait_for`, `browser_take_screenshot`, `browser_file_upload`. Before driving the browser it calls `POST http://localhost:<port>/api/board-browsers/<id>/ensure` (45 s timeout). `--out` defaults to `<dir>/../../browser-files/<id>`. Ends on SIGTERM, SIGINT or SIGHUP (closes its tabs, at most 4 s), exit 0.

## 5. Environment variables

### Read by the CLI

| Var | Used by | Effect |
|---|---|---|
| `CKANBAN_PORT` | all daemon-talking commands | board port; overrides `config.json` `port` (default 7777) |
| `CKANBAN_HOME` | all | data root (default `~/.claude-kanban`): `config.json`, `remote.json`, `daemon.log`, `artifact-helper/` |
| `CKANBAN_TICKET` | ticket, mcp tools | `<slug>/<ticket id>` of the board run this process is in: picks the profile, makes changing commands refuse, sent as `x-ckanban-run` |
| `CKANBAN_HUDDLE_AGENT` | mcp tools | huddle participant identity (`<huddle>/<handle>/<token>`), sent as `x-ckanban-huddle-agent` |
| `CKANBAN_FRONTDESK` | every BoardClient request | Telegram front desk identity, sent as `x-ckanban-frontdesk`; the daemon may answer 202 with a confirmation |
| `CKANBAN_QUICK_CHAT` | every BoardClient request | quick chat identity, sent as `x-ckanban-quick-chat` |
| `CKANBAN_CALL_TOKEN` | `call` | automation check script token (required) |
| `CKANBAN_CLAUDE_BIN` | artifact, mcp install/uninstall/status, MCP artifact tools | Claude Code binary (default `claude`) |
| `CKANBAN_ARTIFACT_MODEL` | artifact, MCP artifact tools | model for the artifact helper session (default `haiku`) |
| `CKANBAN_OUTPUT_DIR` | MCP `publish_artifact` | folder for published pages (`<dir>/artifacts`; default `<tmpdir>/ckanban-artifacts/artifacts`) |
| `CKANBAN_REMOTE_PORT` | remote, uninstall | phone access listener port |
| `MCP_TOOL_TIMEOUT` | MCP artifact tools | when set (ms, >= 1000), artifact jobs wait at most that minus 5 s (and never over 180 s) |
| `CLAUDE_CONFIG_DIR` | mcp install/status, artifact | where `.claude.json` is (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`); passed to the artifact helper |
| `CODEX_HOME` | mcp install/status | Codex config folder (default `~/.codex`) |
| `PATH` | install, artifact | copied into the plist; tmux lookup for the artifact helper |

### Read by the daemon (`ckanban dev`/`start`, `src/**`)

From a full grep of `process.env` and env-object reads under `src/`:

| Var | Effect |
|---|---|
| `CKANBAN_HOME` | data root (default `~/.claude-kanban`); also listed as an internal folder runs must not treat as a project |
| `CKANBAN_PORT` | listen port on 127.0.0.1; overrides `config.json` `port` (default 7777). The daemon also sets it in automation scripts' environment |
| `CKANBAN_REMOTE_PORT` | phone access listener port (else `config.json` `remotePort`, else port + 1) |
| `CKANBAN_CLAUDE_BIN` | Claude Code binary for runs, chats, huddles, quick chats, side calls, MCP checks (default `claude`) |
| `CKANBAN_CHROME_BIN` | Chrome binary for board browsers, tried before `/Applications/Google Chrome.app/...` and `~/Applications/...` |
| `CKANBAN_OPEN_BIN` | replaces `open` when revealing or opening files |
| `CKANBAN_OSASCRIPT_BIN` | replaces `osascript` when copying a file to the clipboard; when set the UI reports file copy as available |
| `CKANBAN_NO_LOG_COMPRESS` | any non-empty value turns off the background run log compression job |
| `CKANBAN_SNAPSHOT_LIMIT_MS` | how long saving the folder before a message may take (default 2000 ms); tests raise it |
| `CKANBAN_UNDO_SAVE_LIMIT_MS` | how long saving the folder before a rewind may take (default 60000 ms) |
| `CKANBAN_TICKET`, `CKANBAN_HUDDLE_AGENT`, `CKANBAN_OUTPUT_DIR`, `CKANBAN_FRONTDESK` | run identity vars: removed from the env children inherit (`inheritedEnv`), then set per run by the daemon (`CKANBAN_TICKET=<slug>/<id>`, `CKANBAN_OUTPUT_DIR=<ticket outputs>`, huddle agent `<hid>/<handle>/<token>`, front desk `<slug>/<id>/<token>`); `CKANBAN_QUICK_CHAT=<slug>/<chat id>` is set for quick chat runs. Terminals opened by the board drop `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CKANBAN_TICKET` |
| `CLAUDE_CONFIG_DIR` | Claude Code config folder (default `~/.claude`): `projects/` session files, usage, forks, commands; `.claude.json` is `$CLAUDE_CONFIG_DIR/.claude.json` else `~/.claude.json` |
| `CODEX_HOME` | Codex config folder for MCP registration (default `~/.codex`) |
| `HOME` | `~` expansion in paths typed in the UI; board browser Chrome lookup |
| `USER` | fallback user name for usage lookups when `os.userInfo()` fails |
| `SHELL` | shell for board terminals (default `/bin/zsh`) and for the worktree setup command |
| `PATH` | inherited by children; automation scripts get a small PATH built from it plus a shim folder, `/opt/homebrew/bin`, `/usr/local/bin` |
| `LANG`, `LC_ALL` | at startup, if `LANG` isn't UTF-8 and `LC_ALL` isn't a non-UTF-8 override, the daemon sets `LANG=en_US.UTF-8` in its own env (children inherit it) |
| `DEVELOPER_DIR` | when set, `/usr/bin/git` on macOS is treated as usable without checking for the Xcode command line tools |
| `GIT_SSH_COMMAND` | when set (or `core.sshCommand` is), git fetches keep the user's ssh command; else they use `ssh -o BatchMode=yes` |
| `TMPDIR` | used indirectly through `os.tmpdir()`; kept in automation script envs |

Automation check scripts get a clean env: only `HOME, USER, LOGNAME, LANG, LC_ALL, TMPDIR, SHELL, TZ` from the daemon, plus the built `PATH`, the board keys, `CKANBAN_PORT` and `CKANBAN_CALL_TOKEN`. Key names `PATH, HOME, USER, SHELL, LANG, TMPDIR, CKANBAN_PORT, CKANBAN_CALL_TOKEN` are reserved.

## 6. `ckanban mcp` (stdio MCP server, src/mcp/server.ts)

- Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. A line may hold one message or a batch array (each reply is written as its own line). Bad JSON: `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}`. Unknown method with an id: error -32601 `method not found: <method>`; notifications get no reply. A handler crash: -32603.
- Methods: `initialize` (echoes the client's `protocolVersion` if it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, else `2025-06-18`; `capabilities: { tools: {} }`, `serverInfo: { name: "ckanban", version }`, plus an `instructions` string), `ping`, `tools/list`, `tools/call`.
- A tool result is `{ content: [{ type: "text", text }] }`, with `isError: true` on failure. Unknown tool: `unknown tool <name>` as an error result.
- Runs: a tool with `changes: true` and neither `allowInRun` nor `plannerScope` is refused when `CKANBAN_TICKET` is set (same message as the CLI). `allowInRun` tools work in runs; `plannerScope` tools are left for the daemon to decide (only a running plan's planner on its own children).
- Board: `profile` argument, else the run's profile, else the cwd lookup; this costs one `GET /api/profiles` per call. Paths below start at `/api/profiles/{slug}` as `{p}`; `{t}` = `{p}/tickets`; `{h}` = `{p}/huddles/{hid}` where `hid` is the `huddle` argument or `current` inside a run (outside a run without `huddle`: error `huddle is required outside a board run`). `{own}` is the run's own ticket id from `CKANBAN_TICKET`.
- Checked from the outside by `test/contract/mcp.test.ts` (it starts `ckanban mcp` as a program; `CKANBAN_CONTRACT_MCP` points it at another MCP server).
- "Card" tools only validate and return text; the board draws the form or card by reading the tool call from the session transcript, so they make no change over HTTP.

| Tool | HTTP route(s) | Purpose |
|---|---|---|
| `list_profiles` | GET `/api/profiles` | list boards and their folders (same text as `ckanban profiles`) |
| `list_tickets` | GET `{t}?scope=list&...` | a page of tickets (same text as `ticket list`, MCP wording for More/Done hints) |
| `get_ticket` | GET `{t}/{id}`, GET `{t}/{id}/comments?last=50[&before=]` | one ticket with its newest comments (same text as `ticket show`) |
| `get_family` | GET `{t}/{id}/family` | a ticket's whole family tree with sessions and last results |
| `search_chat` | GET `{p}/chat/search?q=&ticket=&tools=1` | search earlier chat messages of a ticket |
| `read_chat` | GET `{p}/chat/read?ref=&before=&after=` | messages around a `search_chat` hit |
| `create_ticket` | POST `{t}` | create a ticket (optionally a main ticket that gathers others) |
| `update_ticket` | PATCH `{t}/{id}` | change title, body, status, mode, deps, needs, tags, important, pinned, plan link, showOnBoard |
| `move_ticket` | PATCH `{t}/{id}` body `{status}` | move a ticket to a column |
| `suggest_tags` | GET `{t}/{id}`, PATCH `{t}/{id}` body `{suggestedTags}` | suggest tags the user keeps or drops |
| `chat_ticket` | POST `{t}/{id}/chat` | send a chat message to a ticket (may start a run) |
| `comment_ticket` | POST `{t}/{id}/comments` | add a comment |
| `stop_ticket` | POST `{t}/{id}/stop` | stop a ticket's run |
| `delete_ticket` | DELETE `{t}/{id}` | delete a ticket |
| `plan_control` | POST `{t}/{id}/plan` body `{action: start\|resume}` | start or resume a main ticket's tool tickets |
| `gather_tickets` | POST `{t}/{id}/gather` | gather tickets into a feature (optionally a new group, hide) |
| `update_status` | POST `{t}/{id}/status` | update a feature's status sections, returns its markdown |
| `ask_ticket` | POST `{t}/{own}/ask` | ask another ticket's session (a fork) a question; answer arrives later as an event |
| `merge_into_main` | POST `{t}/{own}/merge-into-main` (long) | bring a tool ticket's work into its main ticket's copy |
| `land_milestone` | POST `{t}/{own}/land` (long) | land the main ticket's copy (push and PR, or merge into the folder) |
| `follow_up` | POST `{t}/{own}/follow-up` | set when Claude comes back to this ticket |
| `cancel_follow_up` | DELETE `{t}/{own}/follow-up` body `{reason}` | cancel that |
| `notify_user` | GET `{t}/{own}`, POST `{t}/{own}/notify` | message the user (phone, browser, webhook, Mac banner or helper) |
| `take_devices` | POST `{t}/{own}/devices` `{action:"take"}` (long) | take shared devices, waits up to about 4 min |
| `release_devices` | POST `{t}/{own}/devices` `{action:"release"}` | let go of devices |
| `send_file` | POST `/api/telegram/front-desk/file` (long) | Telegram front desk only: send a file to the user's Telegram |
| `report_bug` | POST `/api/bug-report` | file a ckanban bug on GitHub (source `ai`) |
| `list_schedules` | GET `{p}/schedules` | list schedules |
| `create_schedule` | POST `{p}/schedules`, GET `/api/cron/preview?expr=` | create a cron schedule and show its next runs |
| `update_schedule` | PATCH `{p}/schedules/{id}` | change, pause or resume a schedule |
| `delete_schedule` | outside a run: DELETE `{p}/schedules/{id}`; in a run: GET `{p}/schedules`, GET `{t}/{own}` only | delete (outside runs) or ask the user with a card (in runs); refused in quick chats and for huddle agents |
| `run_schedule` | POST `{p}/schedules/{id}/run` | run a schedule now |
| `schedule_history` | GET `{p}/schedules`, GET `{p}/schedules/{id}/history` | a schedule's run and edit history |
| `schedule_job` | POST `{p}/jobs` | run a ticket or a command once at a set time |
| `list_jobs` | GET `{p}/jobs[?ticketId=]` | list one-time jobs |
| `update_job` | PATCH `{p}/jobs/{id}` | change a job |
| `cancel_job` | POST `{p}/jobs/{id}/cancel` | cancel a job |
| `run_job_now` | POST `{p}/jobs/{id}/run` | run a job now |
| `propose_helper_rule` | GET `{t}/{own}` (in a run) | card: suggest a line for the helper's notes; refused outside a run |
| `ask_questions` | GET `{t}/{own}` (in a run) | form: ask the user questions in the ticket chat |
| `ask_keys` | GET `{t}/{own}`, GET `/api/passes` | form: ask the user for keys (secrets) the work needs |
| `propose_ticket` | none | card: improved title and description for this ticket |
| `propose_branch` | none | card: start a branch ticket from this chat |
| `propose_delete` | GET `{t}?scope=ids&ids=...` | card: ask the user to delete tickets |
| `propose_automation` | none | card: an automation (check script) to save |
| `propose_teammate` | POST `{h}/teammates` (hid `current`) | propose a huddle role preset; waits under the huddle's Learnings |
| `propose_squad` | GET `{p}/huddle-presets`, POST `{h}/squads` | propose a huddle squad; waits under Learnings |
| `propose_huddle` | GET `{t}/{own}`, GET `{p}/huddle-presets`, GET `{p}/huddle-templates` (validation only) | card: propose a huddle to the user |
| `backup_file` | none (GET `/api/profiles` only outside a run) | copy a file into the board's private folder before changing it |
| `list_connections` | GET `/api/passes`, GET `/api/mcp`, GET `/api/profiles` | list services connected for automations and Claude Code's MCP servers |
| `connection_tools` | GET `/api/passes`, GET `/api/passes/{id}/tools` | list one connection's tools |
| `test_automation_script` | POST `{p}/loops/test` (long) | trial run of an unsaved check script |
| `start_huddle` | POST `{p}/huddles/auto` | the host ticket's run starts its auto huddle (or waits for a slot) |
| `huddle_read` | GET `{h}?since=&limit=60` | read huddle messages |
| `huddle_post` | POST `{h}/messages` | post a message or finding (optionally with a status change) |
| `huddle_status` | POST `{h}/status` | mark yourself done, blocked or active (with lessons) |
| `huddle_close` | POST `{h}/close-request` | ask to close the huddle |
| `huddle_brief` | PUT `{h}/brief` | set or clear the pinned brief |
| `huddle_mode` | GET `{h}?limit=1`, PATCH `{h}/participants/{you}` | switch your own mode (tagged or monitor) |
| `huddle_add_participant` | POST `{h}/participants` | add a participant |
| `huddle_findings` | POST `{h}/findings` body `{action: add\|resolve\|list}` | manage the findings list |
| `huddle_hand_in` | POST `{h}/hand-ins` | hand in changes made in your own copy |
| `huddle_review_changes` | POST `{h}/hand-ins/{id}/accept` or `/reject` | accept or reject a hand-in |
| `huddle_allow_changes` | POST `{h}/participants/{handle}/allow-changes` | let a helper change files |
| `list_huddle_presets` | GET `{p}/huddle-presets`, GET `{p}/huddle-templates` | list role presets and squads |
| `save_huddle_preset` | POST `{p}/huddle-presets` | save a role preset |
| `delete_huddle_preset` | DELETE `{p}/huddle-presets/{name}[?scope=board\|global]` | delete or reset a preset |
| `read_artifact` | none (local Claude Code helper session) | read a claude.ai artifact's HTML |
| `publish_artifact` | none (writes the page under `CKANBAN_OUTPUT_DIR`, local helper session) | publish an HTML page as a claude.ai artifact |

69 tools in total (the table above lists every one). Huddle, huddle preset, schedule run and job calls carry `x-ckanban-source: mcp` plus `x-ckanban-run` / `x-ckanban-huddle-agent` when set; most other changing calls carry `x-ckanban-run` when in a run.

### Tool arguments (`tools/list`)

Each tool's `inputSchema` is `{"type": "object", "properties": {...}, "required": [...]}` (`required` left out when nothing is required). The table gives every property in order: its name, `*` when it is required, its JSON type (`T[]` is an array of `T`, `a\|b` a list of types) and its `enum` values in brackets. "Read-only" tools carry `annotations: {"readOnlyHint": true}`; the others have no `annotations`. Rows are in `tools/list` order. Descriptions are not part of the contract (each is a non-empty string). `test/contract/mcp.test.ts` checks this table against `tools/list`.

| Tool | Arguments | Read-only |
|---|---|---|
| `list_profiles` | none | yes |
| `list_tickets` | `profile` string, `status` string (backlog\|planning\|ready\|in_progress\|review\|done), `query` string, `limit` number, `after` string, `includeTool` boolean | yes |
| `get_ticket` | `profile` string, `id`* string, `commentsBefore` number | yes |
| `get_family` | `profile` string, `id`* string | yes |
| `search_chat` | `profile` string, `query`* string, `ticket` string, `includeTools` boolean | yes |
| `read_chat` | `profile` string, `ref`* string, `before` number, `after` number | yes |
| `create_ticket` | `profile` string, `title`* string, `body` string, `status` string (backlog\|planning\|ready\|in_progress\|review\|done), `mode` string (interview\|auto), `key` string, `dependsOn` string[], `needs` string[], `tags` string[], `kind` string (explore\|build\|test\|review\|fix\|group\|round\|with_you), `partOf` string, `model` string, `effort` string (low\|medium\|high\|xhigh\|max), `partOfThisTicket` boolean, `main` boolean, `gather` object[], `newGroup` string |  |
| `update_ticket` | `profile` string, `id`* string, `title` string, `body` string, `status` string (backlog\|planning\|ready\|in_progress\|review\|done), `mode` string (interview\|auto), `dependsOn` string[], `needs` string[], `tags` string[], `important` boolean, `release` boolean, `showOnBoard` boolean |  |
| `suggest_tags` | `tags`* string[], `profile` string, `id` string |  |
| `follow_up` | `after` string, `at` string, `note`* string, `cancelOnReply` boolean, `profile` string |  |
| `cancel_follow_up` | `reason`* string, `profile` string |  |
| `notify_user` | `message`* string, `urgent` boolean, `why` string, `profile` string |  |
| `take_devices` | `names`* string[], `profile` string |  |
| `release_devices` | `names` string[], `profile` string |  |
| `move_ticket` | `profile` string, `id`* string, `status`* string (backlog\|planning\|ready\|in_progress\|review\|done) |  |
| `update_status` | `profile` string, `id` string, `goal` string, `done` string, `broken` string, `waitingOnYou` string, `nextStep` string, `prNotes` object, `prs` string[] |  |
| `gather_tickets` | `profile` string, `id` string, `tickets`* object[], `newGroup` string, `hide` boolean |  |
| `plan_control` | `profile` string, `action`* string (start\|resume), `id` string |  |
| `chat_ticket` | `profile` string, `id`* string, `message`* string |  |
| `ask_ticket` | `profile` string, `id`* string, `question`* string |  |
| `merge_into_main` | `profile` string |  |
| `land_milestone` | `profile` string, `summary`* string |  |
| `send_file` | `path`* string, `caption` string |  |
| `stop_ticket` | `profile` string, `id`* string |  |
| `comment_ticket` | `profile` string, `id`* string, `text`* string |  |
| `delete_ticket` | `profile` string, `id`* string |  |
| `report_bug` | `title`* string, `description`* string, `ticketId` string, `includeLogs` boolean, `profile` string |  |
| `ask_questions` | `questions`* object[], `urgent` boolean, `why` string, `about` string[] | yes |
| `ask_keys` | `keys`* object[], `reason`* string, `replace` boolean | yes |
| `backup_file` | `path`* string, `profile` string |  |
| `propose_ticket` | `title`* string, `description`* string, `important` boolean, `partOf` string | yes |
| `propose_branch` | `reason` string | yes |
| `propose_delete` | `ids`* string[], `reason`* string | yes |
| `propose_teammate` | `name`* string, `prompt`* string, `role` string, `model` string, `mode` string (tagged\|monitor), `lead` boolean, `canEdit` boolean, `workspace` string (shared\|own), `why`* string | yes |
| `propose_squad` | `name`* string, `label` string, `description` string, `hostRules` string, `roster`* object[], `rounds` integer\|null, `maxCostUsd` number\|null, `report` string, `why`* string | yes |
| `list_connections` | `profile` string | yes |
| `connection_tools` | `name`* string, `profile` string | yes |
| `test_automation_script` | `script`* string, `passes` string[], `profile` string | yes |
| `propose_automation` | `name`* string, `summary`* string, `service` string, `passes` object[], `script`* string, `everyMinutes` number, `instructions` string, `askClaude` object, `partOf` string, `autoStart` boolean | yes |
| `huddle_post` | `text`* string, `kind` string (message\|finding), `status` string (done\|blocked), `reason` string, `lessons` object[], `huddle` string, `profile` string |  |
| `huddle_status` | `status`* string (done\|blocked\|active), `reason` string, `lessons` object[], `huddle` string, `profile` string |  |
| `huddle_close` | `reason`* string, `huddle` string, `profile` string |  |
| `huddle_read` | `since` integer, `huddle` string, `profile` string | yes |
| `huddle_brief` | `text`* string, `huddle` string, `profile` string |  |
| `huddle_mode` | `mode`* string (tagged\|monitor), `huddle` string, `profile` string |  |
| `huddle_add_participant` | `preset` string, `role` string, `count` integer, `focus`* string, `model` string, `mode` string (tagged\|monitor), `workspace` string (shared\|own), `lead` boolean, `host` boolean, `canEdit` boolean, `prompt` string, `handle` string, `huddle` string, `profile` string |  |
| `huddle_findings` | `action`* string (add\|resolve\|list), `text` string, `id` string, `huddle` string, `profile` string |  |
| `huddle_hand_in` | `summary`* string, `huddle` string, `profile` string |  |
| `huddle_review_changes` | `id`* string, `accept`* boolean, `reason` string, `huddle` string, `profile` string |  |
| `huddle_allow_changes` | `handle`* string, `huddle` string, `profile` string |  |
| `propose_huddle` | `roster` object[], `squad` string, `template` string, `topic` string, `reason` string, `maxCostUsd` number | yes |
| `start_huddle` | `trigger`* string (security\|data\|payments\|important\|asked\|user), `reason`* string, `squad` string, `template` string, `topic` string, `roster` object[], `maxCostUsd` number, `profile` string |  |
| `list_huddle_presets` | `profile` string | yes |
| `save_huddle_preset` | `name`* string, `prompt`* string, `role` string, `model` string, `mode` string (tagged\|monitor), `lead` boolean, `canEdit` boolean, `workspace` string (shared\|own), `scope` string (board\|global), `profile` string |  |
| `delete_huddle_preset` | `name`* string, `scope` string (board\|global), `profile` string |  |
| `read_artifact` | `url`* string | yes |
| `publish_artifact` | `html`* string, `url` string, `title` string | yes |
| `list_schedules` | `profile` string | yes |
| `create_schedule` | `profile` string, `name`* string, `title`* string, `body`* string, `cron`* string, `mode` string (auto\|interview), `enabled` boolean, `skipIfRunning` boolean, `tags` string[], `quiet` boolean, `partOf` string, `model` string |  |
| `update_schedule` | `profile` string, `id`* string, `name` string, `title` string, `body` string, `cron` string, `mode` string (auto\|interview), `enabled` boolean, `skipIfRunning` boolean, `tags` string[], `quiet` boolean, `partOf` string, `model` string |  |
| `delete_schedule` | `profile` string, `id`* string, `reason` string |  |
| `propose_helper_rule` | `text`* string, `reason` string | yes |
| `run_schedule` | `profile` string, `id`* string |  |
| `schedule_history` | `profile` string, `id`* string, `limit` number | yes |
| `schedule_job` | `profile` string, `name`* string, `at`* string, `action`* object |  |
| `list_jobs` | `profile` string, `ticketId` string | yes |
| `update_job` | `profile` string, `id`* string, `name` string, `at` string, `action` object |  |
| `cancel_job` | `profile` string, `id`* string |  |
| `run_job_now` | `profile` string, `id`* string |  |

## 7. Not covered here

- Request and response body shapes beyond what is quoted (see `src/cli/client.ts` interfaces such as `TicketInfo`, `ScheduleInfo`, `JobInfo`, `HuddleInfo`) and each MCP tool's descriptions, nested argument shapes and text output (see the group files in `src/mcp/`).
- The Tailscale command lines (`src/integrations/remote.ts`).
- Daemon HTTP routes the CLI and MCP don't call.
