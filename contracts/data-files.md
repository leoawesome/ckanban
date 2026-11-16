# Data files

Every file and folder the daemon keeps under its data folder, as of v0.18.1. Paths below are relative to the data
folder (`root`), which is `defaultRoot()` in `src/core/store.ts`: `$CKANBAN_HOME` if set, else `~/.claude-kanban`.
`Store` creates `root/profiles/` when it starts; every other file and folder is created on its first write.

## Conventions

### Tiers

Each entry is marked with one of:

- **CORE**: user data. A port must read and write it byte-compatibly (same path, same format, same field names,
  same serialisation details listed here). Losing or reshaping it loses the user's work.
- **STATE**: the daemon's own memory between restarts. Keep the format so an upgrade or downgrade between the Bun and
  Rust daemons keeps working, but losing it only costs a little (a re-sent alert, a re-done scan).
- **CACHE**: can be deleted and rebuilt. A port may use another format or none, but it must not choke on (or
  delete) the existing file, since the Bun daemon may run again on the same folder.

### Write styles

- **atomic** (`atomicWrite` in `src/core/atomic.ts`): `mkdir -p` the parent, write `<file>.tmp-<8 base36 chars>`,
  `rename` it over `<file>`. On a failed write or rename the temp file is removed. No file mode is set (umask).
- **fixed-tmp**: write `<file>.tmp` (always the same name), then `rename`. Atomic, but two writers at once can collide.
- **plain**: `writeFileSync` straight over the file (not atomic).
- **append**: `appendFileSync` of one line ending in `\n` (one write call per line, no lock, no fsync).

### JSON serialisation

- "pretty" means `JSON.stringify(v, null, 2)`; "compact" means `JSON.stringify(v)`; "+nl" means a final `\n` is added.
- Key order is JavaScript insertion order (the order the code builds the object). A port that rewrites a file must
  keep the keys it doesn't know, and should keep the order. Exceptions, where the Bun daemon rebuilds the object on
  read and so drops unknown keys on its next save: `notify.json`, `remote.json`, `helper.json`, `avatars.json`,
  `devices.json` and each entry of the huddle preset and template files (all keys), and the top level of
  `push.json`, `automation-passes.json` and `waits.json`. A port may do the same there.
- Non-ASCII text is written as raw UTF-8 (no `\u` escapes, except what `JSON.stringify` always escapes).

### Outside edits

"Outside edits" says whether a change made to the file by another process (the user, a Claude run, a second daemon)
is noticed:

- **every read**: the file is read and parsed on every use.
- **mtime/size**: a cache keyed by the file's `mtimeMs` and `size` (and for folders, the folder's mtime); a changed
  file is read again on its next use or at the next background recheck.
- **once**: read once (at start or on first use) and then held in memory; the daemon's next save overwrites outside
  edits.

### Ids and times

| What | Format | Made by |
| --- | --- | --- |
| Ticket id | `t_<YYYYMMDD>_<4 base36>`, e.g. `t_20261115_qjnt`. The date is the **UTC** date of creation. Regex: `^t_\d{8}_[0-9a-z]{4}$` | `newTicketId()` in `src/core/util.ts` |
| Short id | 8 chars of `[0-9a-z]`, e.g. `k3x9a2bq` (comments, schedules, jobs, automations, quick chats, temp file suffixes) | `newId()` in `util.ts` |
| Huddle id | `h_` + short id, e.g. `h_4f2kq9zb`. Files are matched with `^h_[a-z0-9_]+\.json$` (case-insensitive) | `huddle.ts` |
| Board slug | `slugify(name)`: Unicode NFKD, lowercase, every run of chars outside `[a-z0-9]` becomes `-`, leading and trailing `-` trimmed, cut to 40 chars, trailing `-` trimmed again; empty result becomes `task`. A taken slug gets `-2`, `-3`, ... (`slugify(name) + "-" + i`) | `POST /api/profiles` in `src/api/server.ts` |
| Ticket branch | `ck/<ticket id>-<slugify(title)>` (40 chars max for the title part) | `board.ts` |
| Attachment name | `randomUUID()` without dashes + extension: `^[0-9a-f]{32}\.[a-z0-9]+$` | `attachments.ts` |
| Timestamps | ISO 8601 UTC with milliseconds, from `new Date().toISOString()`: `2026-11-15T08:01:02.345Z`. Some state files store epoch milliseconds instead; noted where so | `nowIso()` in `util.ts` |
| Local day keys | `YYYY-MM-DD` in the Mac's local time zone (spend ledgers, `autoContinued.day`) | `spend.ts` |

The id checks the Store applies before building a path: schedule, job and automation ids must match `^[a-z0-9]+$`;
huddle ids `^h_[a-z0-9_]+$` (case-insensitive). Ticket ids are not checked by the Store (the HTTP layer only uses ids
it listed).

## Layout at a glance

```
<root>/
  config.json                       CORE   (read only; never written by the daemon)
  profiles/<slug>/
    profile.json                    CORE
    board-tools.json                CORE   (secrets)
    huddle-presets.json             CORE
    huddle-templates.json           CORE
    learned-rules.md                CORE
    huddle-notes/<role>.md          CORE
    run-logs-compressed.jsonl       CACHE
    .key-backups/...                CORE   (secrets)
    tickets/<ticket id>/
      ticket.md                     CORE
      comments.jsonl                CORE
      activity.jsonl                CORE   (or activity.jsonl.gz once compressed)
      side-spend.jsonl              CORE
      help.json                     CORE
      simplified.json               CACHE
      context.json                  CACHE
      outputs/...                   CORE   (the run's deliverables; any files)
    chats/<id>.json                 CORE   (quick chats)
    chats/<id>.activity.jsonl       CORE
    chats/<id>.side-spend.jsonl     CORE
    chats/<id>.simplified.json      CACHE
    chats/<id>.context.json         CACHE
    schedules/<id>.json             CORE
    schedules/<id>.history.jsonl    CORE
    jobs/<id>.json                  CORE
    loops/<id>.json                 CORE   (automations)
    loops/<id>.sh                   CORE
    loops/<id>.state.json           STATE
    huddles/<h_id>.json             CORE
    huddles/<h_id>.messages.jsonl   CORE
  attachments/<32 hex>.<ext>        CORE
  avatars.json  snippets.json  huddle-presets.json  huddle-templates.json  huddle-notes/<role>.md   CORE
  learned/pile.json  learned/changes.json                                                         CORE
  learned/scanned-at.json                                                                         CACHE
  notify.json  push.json  remote.json  automation-passes.json  helper.json                        CORE (some secrets)
  automation-passes.json.lock                                                                     STATE (empty lock file)
  devices.json  browsers.json  board-browsers.json  browsers/<id>/                                CORE
  spend-days.json  telegram-spend.json  telegram-desk-spend.json  helper-spend.jsonl  usage-windows.json   CORE (history)
  messages.json  waits.json  helper-state.json  telegram-*.json                                   STATE
  session-summaries.json  usage-last.json  mcp-seen.json  claude-ai-connectors.json
  claude-commands.json  model-versions.json  automation-bin/ckanban                               CACHE
  daemon.log(.1,.2)  debug/  share-tmp/  side-calls/  artifact-helper/  signin/
  automation-tests/  browsers-removed/  browser-files/                                            scratch
```

### Machine-readable path list

Every file path (relative to the data folder) the daemon may write, one pattern per line: `<name>` matches one path
segment, `*` part of one, `**` any number of segments. `test/contract/data-files.test.ts` fails when the daemon writes
a file that no line here matches, so a new file needs a line here (and a section below) first.

```paths
config.json                       # the user writes it; the daemon only reads it
profiles/<slug>/profile.json
profiles/<slug>/board-tools.json
profiles/<slug>/huddle-presets.json
profiles/<slug>/huddle-templates.json
profiles/<slug>/learned-rules.md
profiles/<slug>/huddle-notes/<role>.md
profiles/<slug>/run-logs-compressed.jsonl
profiles/<slug>/.key-backups/**
profiles/<slug>/tickets/<id>/ticket.md
profiles/<slug>/tickets/<id>/comments.jsonl
profiles/<slug>/tickets/<id>/activity.jsonl
profiles/<slug>/tickets/<id>/activity.jsonl.gz
profiles/<slug>/tickets/<id>/side-spend.jsonl
profiles/<slug>/tickets/<id>/help.json
profiles/<slug>/tickets/<id>/simplified.json
profiles/<slug>/tickets/<id>/context.json
profiles/<slug>/tickets/<id>/outputs/**
profiles/<slug>/chats/<id>.json
profiles/<slug>/chats/<id>.activity.jsonl
profiles/<slug>/chats/<id>.side-spend.jsonl
profiles/<slug>/chats/<id>.simplified.json
profiles/<slug>/chats/<id>.context.json
profiles/<slug>/schedules/<id>.json
profiles/<slug>/schedules/<id>.history.jsonl
profiles/<slug>/jobs/<id>.json
profiles/<slug>/loops/<id>.json
profiles/<slug>/loops/<id>.sh
profiles/<slug>/loops/<id>.state.json
profiles/<slug>/huddles/<id>.json
profiles/<slug>/huddles/<id>.messages.jsonl
attachments/<name>
avatars.json
snippets.json
huddle-presets.json
huddle-templates.json
huddle-notes/<role>.md
learned/pile.json
learned/changes.json
learned/scanned-at.json
notify.json
push.json
remote.json
automation-passes.json
automation-passes.json.lock
helper.json
devices.json
browsers.json
board-browsers.json
browsers/**
spend-days.json
telegram-spend.json
telegram-desk-spend.json
helper-spend.jsonl
usage-windows.json
messages.json
waits.json
waits.json.corrupt-<ms>
helper-state.json
telegram-*.json
session-summaries.json
usage-last.json
mcp-seen.json
claude-ai-connectors.json
claude-commands.json
model-versions.json
automation-bin/ckanban
daemon.log
daemon.log.1
daemon.log.2
debug/<file>
share-tmp/<file>
side-calls/**
artifact-helper/**
signin/**
automation-tests/<file>
browsers-removed/**
browser-files/**
```

### Schemas and checks

`contracts/schemas/` has a JSON Schema for each saved JSON file below. `test/contract/data-files.test.ts` makes them
with a mix of actions (a ticket with a chat, comments, help and simplify answers, a feature status and a huddle; a
schedule run and paused; two jobs; an automation; a quick chat; presets, templates, notes, snippets, an avatar, an
attachment, a device, a board tool, a push device, notification, helper and phone access settings, a key; plan
usage), then checks every one against its schema and its write style (pretty or compact, final newline or not).

| Path | Schema | Made by the contract test |
| --- | --- | --- |
| `config.json` | `config.schema.json` | written by the test (the user's file) |
| `profiles/<slug>/profile.json` | `profile.schema.json` | yes |
| `profiles/<slug>/board-tools.json` | `board-tools.schema.json` | yes |
| `tickets/<id>/ticket.md` | `ticket.schema.json` (front matter plus `body`) | yes |
| `tickets/<id>/comments.jsonl` (per line) | `comment.schema.json` | yes |
| `tickets/<id>/activity.jsonl`, `chats/<id>.activity.jsonl` (per line) | `activity-entry.schema.json` | yes |
| `tickets/<id>/side-spend.jsonl`, `chats/<id>.side-spend.jsonl`, `helper-spend.jsonl` (per line) | `side-spend-entry.schema.json` | yes, except `helper-spend.jsonl` |
| `tickets/<id>/help.json` | `help-cards.schema.json` | yes |
| `tickets/<id>/outputs/status.json` | `feature-status.schema.json` | yes |
| `chats/<id>.json` | `quick-chat.schema.json` | yes |
| `schedules/<id>.json` | `schedule.schema.json` | yes |
| `schedules/<id>.history.jsonl` (per line) | `schedule-history-entry.schema.json` | yes (created, fired, paused) |
| `jobs/<id>.json` | `job.schema.json` | yes (a ticket job and a command job that ran) |
| `loops/<id>.json`, `loops/<id>.state.json` | `loop.schema.json`, `loop-state.schema.json` | yes |
| `huddles/<h_id>.json`, `huddles/<h_id>.messages.jsonl` (per line) | `huddle.schema.json`, `huddle-message.schema.json` | yes |
| `huddle-presets.json`, `huddle-templates.json` (root and per board) | `huddle-presets.schema.json`, `huddle-templates.schema.json` | yes |
| `learned/pile.json` | `learned-pile.schema.json` | yes |
| `avatars.json`, `snippets.json`, `devices.json` | `avatars.schema.json`, `snippets.schema.json`, `devices.schema.json` | yes |
| `notify.json`, `push.json`, `remote.json`, `automation-passes.json`, `helper.json` | `notify`, `push`, `remote`, `automation-passes`, `helper-settings` `.schema.json` | yes |
| `spend-days.json` | `spend-days.schema.json` | yes (a huddle agent's cost) |
| `telegram-spend.json`, `telegram-desk-spend.json` | `spend-by-day.schema.json` | no: needs a Telegram bot |
| `usage-windows.json`, `usage-last.json` | `usage-windows.schema.json`, `usage-last.schema.json` | yes (a local fake of Anthropic) |
| `waits.json` | `waits.schema.json` | yes |

Checked without a JSON Schema: the attachment's bytes and name, the automation's `.sh` script, and both
`huddle-notes/_all.md` files (exact Markdown layout).

Saved files with no schema or check yet, and why: `activity.jsonl.gz` (only for tickets Done for 30 days),
`learned/changes.json` and `profiles/<slug>/learned-rules.md` (need the learner to find a lesson in a real run),
`.key-backups/` (raw file copies written by the `ckanban mcp` process's `backup_file` tool, not by the daemon), `outputs/` files other than `status.json` (made by runs or the
board on events the test doesn't cause), `browsers.json`, `board-browsers.json` and `browsers/` (start Chrome),
`helper-spend.jsonl`, `messages.json` and `helper-state.json` (the helper's first check waits a minute and needs a
real Claude answer), and the `telegram-*.json` files (need a Telegram bot). Caches (`simplified.json`,
`context.json`, `session-summaries.json`, `mcp-seen.json` and the others in "Caches") have no schema: a port may
rebuild them in its own format; `usage-last.json` is the exception because the Bun daemon and the Rust front share
it.

Folders in `profiles/<slug>/` that are not listed (seen on real boards: `whatsapp/`, `rednote/`) are not written by
the daemon; Claude runs or the user put them there. A port must leave unknown files and folders alone.

## Core: config and boards

### `config.json`

- **Format:** JSON object. **Type:** `Config` (`src/core/types.ts`): `{ port: number, prPollMinutes: number,
  remotePort?: number }`. Nothing reads `prPollMinutes` today. Schema: `schemas/config.schema.json` (every key
  optional).
- **Writer:** none. The daemon and CLI only read it; the user creates it by hand.
- **Reader:** `Store.config()`. Missing or unparseable: the defaults `{ "port": 7777, "prPollMinutes": 5 }`. Present:
  the defaults with the file's keys merged over them.
- **Outside edits:** read at daemon start (`src/cli/daemon.ts`) and on every CLI call (`client.ts` port lookup); `CKANBAN_PORT`
  wins over `port`.
- **Tier:** CORE.

```json
{ "port": 7777, "prPollMinutes": 5, "remotePort": 7778 }
```

### `profiles/<slug>/profile.json`

- **Format:** JSON object, pretty +nl. **Type:** `Profile` (`types.ts`). Schema: `schemas/profile.schema.json`.
- **Writer:** `Store.saveProfile` (atomic). Called from `POST /api/profiles` and `PATCH /api/profiles/:slug`
  (`http.ts`), `worktree-setup.ts` (setup detection) and `board.ts` (base branch fix).
- **Created by** `POST /api/profiles` with, in this order: `name`, `slug`, `path`, `baseBranch` (detected; `""` for a
  folder without version history), `model` (always written, `null` when not given), `effort` and `ultracode` (only if
  given), `createdAt`, `workspace` (only if given), then setup detection may add `setupDetected`, `copyFiles`,
  `setupCommand`.
- **Reader:** `Store.getProfile` / `listProfiles`: **every read** (no cache). An unparseable file makes the board
  disappear from the list. `listProfiles` sorts by `createdAt` (string compare).
- **Delete:** `Store.deleteProfile` removes the whole `profiles/<slug>/` folder.
- **Tier:** CORE.

```json
{
  "name": "My App",
  "slug": "my-app",
  "path": "/Users/sam/code/my-app",
  "baseBranch": "main",
  "model": null,
  "createdAt": "2026-11-15T08:00:00.000Z"
}
```

### `profiles/<slug>/board-tools.json`

- **Format:** JSON object, pretty +nl: `{ "mcpServers": Record<name, ToolEntry> }` (`board-tools.ts`). An entry is
  `{ type: "stdio", command, args, env? }` or `{ type: "http" | "sse", url, headers? }` as the board's form writes
  it; an entry moved from the user's Claude Code config (`McpManager.moveToBoard`) is copied as it was, so it may
  have no `type` (readers take a `url` as http, else stdio) or other fields. Schema: `schemas/board-tools.schema.json`.
- **Writer:** `writeBoardTools` via `Store.saveBoardTools`: temp file with a random suffix, mode `0600` plus `chmod`,
  then rename.
- **Outside edits:** every read. **Secrets:** yes (headers, env values). **Tier:** CORE.

```json
{ "mcpServers": { "sentry": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer xxx" } } } }
```

### `profiles/<slug>/.key-backups/<hash12>-<safeName>/<YYYYMMDDTHHMMSSmmmZ>[-n]`

- Raw byte copies of a user's file (e.g. `.env`) taken before Claude changes it (`backupFile` in `file-backup.ts`,
  the `backup_file` MCP tool). `<hash12>` is the first 12 hex chars of sha256 of the real path.
- Folders `0700` (checked to be real folders, not links); files created exclusively (`wx`), mode `0600` plus `chmod`.
  Keeps the first copy plus the newest, 5 in all.
- **Secrets:** yes. **Tier:** CORE.

## Core: tickets

One folder per ticket: `profiles/<slug>/tickets/<ticket id>/`. The folder name is the ticket id. Deleting a ticket
removes the whole folder (`Store.deleteTicket`).

### `tickets/<id>/ticket.md`

- **Format:** Markdown with YAML front matter. The exact bytes are

  ```
  ---\n<YAML of every field except body>---\n<body>
  ```

  i.e. `"---\n" + YAML.stringify(meta) + "---\n" + body` (`serializeTicket` in `store.ts`). `YAML.stringify` always
  ends with `\n`, so the closing `---` is on its own line. The body follows the closing line with nothing added or
  trimmed (it may be empty, and it may or may not end in a newline).
- **YAML details** (the `yaml` npm package, v2.x, default options; a port must match these to stay byte-identical):
  - YAML 1.2 core schema. ISO times are written unquoted (`createdAt: 2026-11-15T08:00:00.000Z`) and read back as
    **strings**, not dates. A YAML 1.1 parser would turn them into timestamps: don't use one.
  - Strings that would read as something else are double-quoted (`num: "123"`, `empty: ""`); strings with `: ` or a
    leading special char are single-quoted (`title: 'Fix: login: "broken"'`); `yes`/`no`/`on` stay plain (they are
    strings in YAML 1.2).
  - Plain strings longer than 80 columns are folded onto indented continuation lines; multi-line strings use a
    `|-` (or `|`) block.
  - Lists are block style with two-space indent (`tags:\n  - ui`); empty lists and objects are `[]` and `{}`; `null`
    is `null`.
  - Key order is insertion order: new tickets follow the `createTicket` order below; `updateTicket` writes
    `{...current, ...patch}`, so new keys are appended at the end.
- **Parse:** `^---\n([\s\S]*?)\n---\n?([\s\S]*)$`; the front matter must be an object with `id`. A ticket that fails
  to parse is shown as a placeholder (`title` = id, `status: backlog`, `error: "corrupt ticket file: ..."`) and the
  file is left as is.
- **Load-time migration** (nothing written): an old `addOnOf` or `followUpOf` key is dropped and becomes `partOf`
  (unless set) and `madeFrom` (unless set) (`withoutAddOn`). The file changes on the ticket's next save.
- **Startup migration: planned tickets retired** (written once, `board/retire-plans.ts`, run by the daemon after the
  tickets load, in slices). An old planner is a ticket with neither `main` nor `tool` that has at least one child by
  `parentId` with neither `main` nor `tool`. It gets `main: true`, or `tool: true, kind: group` when it has a
  `parentId` itself (a plan inside a plan). Each such child gets `tool: true` and `kind` (its own when set, else
  `explore` for titles starting Explore/Investigate/Research, `review` for Review, otherwise `build`); a child in
  Backlog whose planner's plan isn't `running`, `finishing`, `paused` or `stuck` also gets `waitsForStart: true`.
  Nothing else changes: every other field, unknown keys, `plan` state, `dependsOn`, chats and outputs stay, and so
  does `updatedAt`. An open planner gets one `ai` comment saying it became a main ticket. Main tickets, tool tickets
  and their families are never touched. Idempotent: a migrated board has no old planner, so later starts write
  nothing.
- **Type:** `Ticket` (`types.ts`). Schema: `schemas/ticket.schema.json` (the front matter fields plus `body`).
- **Writer:** `Store.createTicket`, `Store.updateTicket` (atomic). `updateTicket` re-reads and re-parses the file,
  merges the patch, sets `updatedAt` to now, sets `doneAt` when the status becomes `done` and clears `pinnedAt` then;
  a status change without an explicit `order` gets the column's entry order (top of the column, except Ready, which
  appends).
- **Created** with, in this order: `id, title, status, mode, order, sessionId: null, worktree: null, branch: null,
  prUrl: null, outcome: null, lastActivity: null, lastRunAt: null, runCount: 0, error: null, createdAt, updatedAt`,
  then only the optional fields that were given (`scheduleId, jobId, source, parentId, planKey, proposedAs, madeFrom,
  dependsOn, needs, tags, important, partOf, partOfVia, model, raisedBy, kind, effort, main, waitsForStart, tool,
  startFrom`). `body` is not in the front matter.
- **Outside edits:** **mtime/size**. `getTicket` stats the file on every call; board listings re-stat every ticket file
  in the background every 30 s (`TICKET_RECHECK_MS`) and re-read the folder when its mtime changes. Planning chats are
  given this file's path and may rewrite the body directly; that is expected.
- **Tier:** CORE.

```
---
id: t_20261115_a3uu
title: 'Fix: login: "broken" on #phone'
status: done
mode: interview
order: 1
sessionId: null
worktree: null
branch: null
prUrl: null
outcome: done
lastActivity: null
lastRunAt: null
runCount: 0
error: null
createdAt: 2026-11-15T07:50:46.825Z
updatedAt: 2026-11-15T07:50:46.837Z
tags:
  - ui
doneAt: 2026-11-15T07:50:46.837Z
---
## Goal
Fix it.
```

### `tickets/<id>/comments.jsonl`

- **Format:** JSONL, one compact `Comment` per line (`types.ts`): `{ id, author: "user" | "ai", text, at, from? }`.
  Schema: `schemas/comment.schema.json`. These are the ticket's result summaries (author `ai`), board notes ("Run
  failed: ..."), user comments and notes from other tickets' runs (`from` = that ticket's id).
- **Writer:** `Store.addComment` (append). Saved keys are masked in `text` before writing (`maskSaved`).
- **Reader:** whole file (`listComments`); bad lines are skipped. The "last summary" cache is keyed by mtime/size.
  A card's links (artifact URLs in `ai` comments) are rebuilt only after the daemon's own next comment write
  (`commentStamp`), so a line appended from outside shows there after that.
- **Tier:** CORE.

```json
{"id":"v2odddnh","author":"ai","text":"Done. Fixed the login.","at":"2026-11-15T07:50:46.838Z"}
```

### `tickets/<id>/activity.jsonl` (the run log)

- **Format:** JSONL, one compact `ActivityEntry` per line (`types.ts`): `{ run: number, at: ISO, event: object }`.
  Schema: `schemas/activity-entry.schema.json`.
  - `run` is the ticket's run number (1, 2, ...). A retried or restarted attempt continues the same number.
  - `event` is either the board's own marker `{ "type": "ckanban_run", "kind": "work" | "planning" | "chat" |
    "reply" | "follow-up" }`, written first for each run, or one event of `claude -p --output-format stream-json`
    exactly as Claude Code printed it (`system`, `assistant`, `user`, `result`, `control_*` and others). Partial
    `stream_event` deltas are not stored.
- **Writer:** `Store.appendActivity` (append). Saved keys are masked in the line (`maskSavedJson`). If a compressed
  copy exists, it is decompressed back first (see below).
- **Reader:** paged from the end (`readJsonlPage`, about 512 KB per page); incomplete or bad lines are skipped. The
  digest (changed files, cost) reads only bytes appended since last time (memory only).
- **Size:** can reach tens of MB per ticket. Never read the whole file on the daemon's event loop.
- **Tier:** CORE (spend, the Usage tab and the run history come from it).

```json
{"run":1,"at":"2026-11-15T07:50:46.838Z","event":{"type":"ckanban_run","kind":"work"}}
{"run":1,"at":"2026-11-15T07:50:49.102Z","event":{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.042,"session_id":"9f1c2a7e-...","result":"Done."}}
```

### `tickets/<id>/activity.jsonl.gz`

- The same log, gzip-compressed (one gzip member, level 6) by `RunLogCompressor` (`run-log-compress.ts`), for tickets
  in Done for more than 30 days whose log is at least 8 KB and that aren't running. Off with
  `CKANBAN_NO_LOG_COMPRESS`.
- Written as `activity.jsonl.gz.tmp-<id>` (exclusive create, fsync), verified by decompressing and comparing size and
  sha256, given the original's atime/mtime, renamed to `.gz`, then the plain file is removed.
- Before any append, the `.gz` is decompressed back to `activity.jsonl` (temp + rename). If both exist, the plain
  file wins. A `.gz` that won't decompress is renamed `activity.jsonl.gz.unreadable-<id>`.
- **Tier:** CORE (a port must read both forms).

### `tickets/<id>/side-spend.jsonl`

- **Format:** JSONL, compact `{ at, kind, costUsd }` per line; `kind` is `simplify`, `help-recap`, `help-changes`,
  `learn`, `link` or `squad`. Only calls that cost something are written.
- **Writer:** `addSideSpend` (`side-call.ts`, append). **Reader:** mtime/size cache. **Tier:** CORE (spend).

```json
{"at":"2026-11-15T09:05:00.000Z","kind":"simplify","costUsd":0.0031}
```

### `tickets/<id>/help.json`

- **Format:** JSON array, pretty +nl, of `{ id: "h_<base36 time><4 chars>", kind: "recap" | "changes", at, text,
  costUsd, model }` (`explain.ts`), the last 50.
- **Writer:** `explain.ts` (re-read, append, atomic). **Outside edits:** every read. **Tier:** CORE (shown in chat).

### `tickets/<id>/simplified.json`

- **Format:** JSON object, pretty +nl, by message uuid: `{ text, version?: 2, source: <16 hex of sha256 of the
  reply>, at, costUsd, model }` (`simplify.ts`).
- **Writer:** `Simplifier` (re-read, merge, atomic). **Outside edits:** every read. **Tier:** CACHE (rebuilding costs
  money).

### `tickets/<id>/context.json`

- **Format:** compact JSON `{ sessionId, result: { report: ContextReport, checkedAt } }` (`context-usage.ts`).
- **Writer:** `ContextUsage.save`: `<file>.tmp-<randomUUID>` then rename; only if the folder exists.
  **Outside edits:** once. **Tier:** CACHE.

### `tickets/<id>/outputs/`

- The run's deliverables: any files and folders Claude (or the user) saves there. Listed newest first, at most 2000,
  skipping `node_modules`, `.git`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.venv`, `venv`, `__pycache__`; symlinks
  are not followed.
- Files the daemon itself writes there:
  - `status.json` (feature status, `SavedStatus` in `feature.ts`): pretty JSON, **no** final newline, fixed-tmp
    (`status.json.tmp`). Written by `update_status` (`POST .../status`), status notes and their delivery
    (`board-features.ts`) and `landMilestone` (`board-main.ts`). Only `updatedAt` is always there; a section Claude
    clears is removed, not set to null. Schema: `schemas/feature-status.schema.json`. Every read. CORE.
  - `status.md`: Markdown made from `status.json` (`# Where we are: <title>` + `##` sections), plain write, only when
    the text changed. CACHE.
  - `saved-changes.md`: `# <label>: <title>` + `- <shortsha> <subject>` lines (`board.ts`), plain write. CACHE.
  - `mockups/<name>.html`: mockups from a planning reply (`mockups.ts`), plain write. CORE.
  - `huddles/<h_id>/proposal.md` and `huddles/<h_id>/summary.md` (`huddle.ts`), plain write; an older
    `huddle-summary.md` is still read. CORE.
  - `<handle>/`: a huddle participant's own outputs (`Store.huddleOutputsDir`).
  - `report.md`: written by tool tickets' runs (read by `main-ticket.ts` for result cards).
- **Tier:** CORE.

## Core: quick chats

`profiles/<slug>/chats/`. The chat id is a short id. Deleting a chat removes all five files.

### `chats/<id>.json`

- **Format:** JSON object, pretty +nl. **Type:** `QuickChat` (`src/chat/quickchat.ts`): `{ id, sessionId, title,
  firstMessage, createdAt, updatedAt, started, ticketId, error, pending?, interrupted?, frontDesk?, rewindUndo? }`.
  Always set at creation: `id`, `sessionId` (a random UUID), `title` (or null), `firstMessage`, `createdAt`,
  `updatedAt`, `started: false`, `ticketId: null`, `error: null`. A fork (`QuickChats.fork`) starts with
  `firstMessage: null` and a made-up title, then copies the source's `firstMessage` and sets `started: true` once the
  copied transcript is there. Schema: `schemas/quick-chat.schema.json`.
- **Writer:** `QuickChats.save` (atomic). **Outside edits:** `get` reads every call; the list is an mtime/size cache
  over files matching `^[a-z0-9]+\.json$`. **Tier:** CORE.

```json
{
  "id": "k3x9a2bq",
  "sessionId": "9f1c2a7e-3b1d-4c55-8a0e-2f6d1b7c9e10",
  "title": null,
  "firstMessage": "Why is the build red?",
  "createdAt": "2026-11-15T09:00:00.000Z",
  "updatedAt": "2026-11-15T09:01:10.000Z",
  "started": true,
  "ticketId": null,
  "error": null
}
```

### `chats/<id>.activity.jsonl`, `.side-spend.jsonl`, `.simplified.json`, `.context.json`

- Same formats as the ticket files of the same name. The chat's activity log holds only `result` events, all with
  `run: 1` (it exists for spend). Activity append errors are swallowed.
- **Tier:** CORE (activity, side-spend), CACHE (simplified, context).

The conversation text of a ticket or quick chat is **not** in the data folder: it is Claude Code's own session
transcript, `$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<sessionId>.jsonl` (default `~/.claude/projects/...`), found
by the ticket's `sessionId`. The daemon reads it, and writes it only to fork (`fork.ts`) or rewind (`rewind.ts`) a
chat.

## Core: schedules

`profiles/<slug>/schedules/`.

### `schedules/<id>.json`

- **Format:** JSON object, pretty +nl. **Type:** `Schedule` (`types.ts`). Schema: `schemas/schedule.schema.json`.
- **Writer:** `Store.saveSchedule` (atomic), from `Scheduler.create/update/...` (`scheduler.ts`).
- **Created** with, in this order: `id, name, title, cron, mode, body, enabled, skipIfRunning, tags, quiet, model,
  partOf, createdAt, updatedAt, lastFiredAt: null, lastError: null, nextRunAt` (null when disabled). Older files may
  lack `tags`, `quiet`, `model`, `partOf`. `cron` has its whitespace collapsed to single spaces.
- **Reader:** `JsonDir` (`json-dir.ts`): files matching `^[a-z0-9]+\.json$`, parsed once and kept by mtime/size; the
  folder's mtime is checked on every list, and every file is re-stat'ed every 5 min (`JSON_DIR_RECHECK_MS`) in the
  background. `getSchedule` reads the file every call. An unparseable file is left out of the list.
- **Delete:** removes `<id>.json` and `<id>.history.jsonl`.
- **Tier:** CORE.

```json
{
  "id": "q8w3n2xk",
  "name": "Morning inbox",
  "title": "Inbox check {date}",
  "cron": "0 9 * * 1-5",
  "mode": "auto",
  "body": "Check my inbox and list what needs me.",
  "enabled": true,
  "skipIfRunning": true,
  "tags": ["inbox"],
  "quiet": false,
  "model": null,
  "partOf": null,
  "createdAt": "2026-11-15T08:00:00.000Z",
  "updatedAt": "2026-11-15T08:00:00.000Z",
  "lastFiredAt": null,
  "lastError": null,
  "nextRunAt": "2026-11-16T09:00:00.000Z"
}
```

### `schedules/<id>.history.jsonl`

- **Format:** JSONL, compact `ScheduleHistoryEntry` per line (`types.ts`), a union by `kind`:
  - `{ at, kind: "fired", trigger: "schedule" | "missed" | "manual", ticketId, note?, by?: { ticketId } }`
  - `{ at, kind: "skipped", trigger, ticketId: string | null, by? }`
  - `{ at, kind: "error", trigger, message, by? }`
  - `{ at, kind: "quiet", ticketId, summary, costUsd }`
  - `{ at, kind: "edited", action: "created" | "updated" | "paused" | "resumed", fields: string[], by: "user" |
    { ticketId }, previous?: { title?, body?, cron? } }`
- The first line of a new schedule is `{"at":...,"kind":"edited","action":"created","fields":[],"by":"user"}`, or
  `"by":{"ticketId":"..."}` when a board run created it.
- **Writer:** `Store.appendScheduleHistory` (append). **Reader:** paged from the end; the digest reads only appended
  bytes (memory only). Grows for years. **Tier:** CORE.

## Core: one-time jobs

### `profiles/<slug>/jobs/<id>.json`

- **Format:** JSON object, pretty +nl. **Type:** `Job` (`types.ts`).
- **Created** (`jobs.ts`) with `id, name, at, action, state: "scheduled", sourceTicketId, createdAt, updatedAt,
  firedAt: null, result: null`. `action` is `{ kind: "ticket", title, body, mode }` or `{ kind: "command", command,
  timeoutSec?, ifLate?: "skip" | "run" }`. `state`: `scheduled`, `running`, `done`, `failed`, `cancelled`, `skipped`.
- **Load-time migration:** an old `state: "missed"` reads as `skipped` with `result.message` "was due while the
  computer was off" (nothing written).
- **Writer:** `Store.saveJob` (atomic). **Reader:** `JsonDir` like schedules; jobs that are `scheduled` or `running`
  are re-stat'ed on every list, so an outside edit to them shows at once. Jobs are never deleted by the Store.
- **Tier:** CORE.

```json
{
  "id": "m4p0c7rt",
  "name": "Deploy check",
  "at": "2026-11-15T18:00:00.000Z",
  "action": { "kind": "command", "command": "./scripts/check.sh", "timeoutSec": 300 },
  "state": "scheduled",
  "sourceTicketId": null,
  "createdAt": "2026-11-15T08:00:00.000Z",
  "updatedAt": "2026-11-15T08:00:00.000Z",
  "firedAt": null,
  "result": null
}
```

## Core: automations (loops)

`profiles/<slug>/loops/`.

- `loops/<id>.json`: JSON object, pretty +nl, type `Loop` (`types.ts`): `{ version, id, name, enabled, service,
  passes, scriptHash, everyMinutes, column, autoStart, askClaude: { on, prompt }, instructions, allowedTools,
  createdAt, updatedAt, lastCheckedAt, lastFiredAt, lastError, partOf? }`. Atomic (`Store.saveLoop`). `JsonDir`
  reader like schedules. A loop whose `version` is newer than the code knows is shown as unsupported and left alone.
  Files of an older version may lack fields (`passes` reads as `[]`). Schema: `schemas/loop.schema.json`. CORE.
- `loops/<id>.sh`: the check script, text, atomic (`Store.saveLoopScript`). It only runs while its sha256 equals the
  loop's `scriptHash`. CORE.
- `loops/<id>.state.json`: compact JSON +nl, type `LoopState`: `{ seen: string[], primed, failures, backoffUntil,
  lastFound, lastItems, threads? }`. Atomic. Read every call, merged over defaults. STATE, but `seen` must survive:
  it stops the same item making a second ticket.
- Delete removes all three files.

## Core: huddles

`profiles/<slug>/huddles/`.

- `huddles/<h_id>.json`: JSON object, pretty +nl, type `Huddle` (`types.ts`). Atomic (`Store.saveHuddle`).
  `JsonDir` reader; open huddles (`status` not `closed`) are re-stat'ed on every list. Participant `token` values are
  secrets (never sent to clients). CORE.
- `huddles/<h_id>.messages.jsonl`: append-only JSONL of `HuddleMessage` `{ id, seq, ts, from, text, mentions, kind,
  source?, handIn? }`; saved keys masked. Read incrementally from the last byte offset; a shorter file is read again
  in full; a missing `mentions` reads as `[]`. CORE.

## Core: board knowledge (global and per board)

| Path | Format | Writer | Outside edits |
| --- | --- | --- | --- |
| `huddle-presets.json`, `profiles/<slug>/huddle-presets.json` | JSON array, pretty +nl, of `HuddlePreset` `{ name, role, prompt, model, mode, lead, canEdit, workspace }` (`huddle-presets.ts`). Global then board, merged over built-ins. Schema: `schemas/huddle-presets.schema.json` | `Store.saveHuddlePresets` (atomic) | every read; bad entries and repeated names dropped and each entry rebuilt by `cleanPresets` (unknown fields are lost on the next save) |
| `huddle-templates.json`, `profiles/<slug>/huddle-templates.json` | JSON array, pretty +nl, of `HuddleTemplate` `{ name, label, description, roster, rounds, maxCostUsd, report, hostRules }` (`huddle-templates.ts`); older files may lack `hostRules` (reads as `""`). Schema: `schemas/huddle-templates.schema.json` | `Store.saveHuddleTemplates` (atomic) | every read; bad entries and repeated names dropped and top-level fields rebuilt by `cleanTemplates` |
| `huddle-notes/<role>.md` (general), `profiles/<slug>/huddle-notes/<role>.md` (this repo) | Markdown: `# Huddle notes: role <role>, all repos` (or `all roles` / `this repo`), a `<!-- Newest first. ... -->` line, a blank line, then `- <text> <!-- from @qa-1, 2026-11-10, huddle h_abc -->` or `<!-- by you, 2026-11-10 -->` per note; the date and huddle parts are left out when the note has none (`- <text> <!-- by you -->`). The file ends with one newline. `<role>` is `_all` or a preset name | `Store.writeHuddleNotes`, `Learner` (atomic) | every read |
| `profiles/<slug>/learned-rules.md` | Markdown: `# Lessons learned on this board`, a `<!-- ... -->` line, a blank line, then `- <text> <!-- by you, 2026-11-10 -->` lines. Every run on the board gets them. Deleted when empty | `Learner.put` (atomic) | every read |
| `learned/pile.json` | JSON object, pretty +nl: `Pile` `{ candidates, scanned, since?, tidyAt?, seen? }` (`learn.ts`) | `Learner` (atomic) | every read |
| `learned/changes.json` | JSON array, pretty +nl, of `LearnChange` (last 500); what Undo uses | `Learner` (atomic) | every read |
| `avatars.json` | JSON object, pretty +nl: name -> `SavedLook` (`avatars.ts`), cleaned on read and write (unknown fields dropped), at most 500. Schema: `schemas/avatars.schema.json` | `Store.saveAvatars` (atomic) | every read |
| `snippets.json` | JSON array, pretty +nl, of `Snippet` `{ id, name, text, scope: "global" \| <slug>, createdAt, updatedAt }` | `Snippets` (atomic) | every read |
| `attachments/<32 hex>.<ext>` | The pasted or uploaded file's bytes. Types: png, jpg, gif, webp, pdf, docx, xlsx, pptx and common text/code extensions; at most 25 MB; magic bytes checked. Shared by all boards; tickets link to them in Markdown | `saveAttachment` (`attachments.ts`, plain write) | n/a |

All CORE.

## Core: settings and connections (root)

| Path | Format | Writer, write style | Outside edits | Secrets |
| --- | --- | --- | --- | --- |
| `notify.json` | JSON object, pretty +nl, `NotifySettings` (`notify.ts`) incl. `telegram: TelegramSettings` | `writeNotifySettings`, fixed-tmp, `0600` + chmod | every read | yes (bot token, webhook URL) |
| `push.json` | JSON object, pretty +nl, `PushFile` `{ vapid: { publicKey, privateKey }, devices, dropped? }` (`push.ts`); VAPID keys made on first read | `PushService.write`, fixed-tmp, `0600` on create | every read | yes |
| `remote.json` | JSON object, pretty +nl, `RemoteConfig` `{ enabled, host, allowedLogin, updatedAt }` (`remote.ts`); turning phone access off writes `enabled: false` and keeps the file (it is removed only when it can't be read). Schema: `schemas/remote.schema.json` | `RemoteAccess.write` (daemon and CLI), fixed-tmp | mtime | no |
| `automation-passes.json` | JSON object, pretty +nl, `{ version: 1, passes: Pass[] }` (`integrations/passes.ts`) | `Passes.write` (and `ckanban-rs`, `rust/src/passes.rs`, same format), random tmp, `0600` + chmod; every read-modify-write holds an exclusive `flock` on `automation-passes.json.lock` (macOS) | every read (`board-keys.ts`: mtime/size/inode cache) | yes (API keys, OAuth tokens) |
| `automation-passes.json.lock` | empty file, `0600`; only its `flock` matters (Bun opens it with `O_EXLOCK`, `ckanban-rs` uses `flock(LOCK_EX)`) | made by the first locked write; never removed | n/a | no |
| `helper.json` | JSON object, pretty +nl, `HelperSettings` `{ model, night, nightOptIn, feedback }` (`helper/settings.ts`) | atomic | every read | no |
| `devices.json` | JSON **array**, pretty, **no** final newline, `Device[]` `{ name, description, capacity, addedByClaude?, lastUsedAt }` (`lastUsedAt` is always written, `null` until first used; each entry is rebuilt on load, so unknown fields are lost). Schema: `schemas/devices.schema.json` | `Devices.save`, fixed-tmp | once | no |
| `browsers.json` | JSON object, pretty, no final newline, `ChromesState` `{ browsers, listedAt, connected }` (`chromes.ts`) | fixed-tmp | once | no |
| `board-browsers.json` | JSON object, pretty, no final newline, `{ browsers: BoardBrowser[], running: Record<id, Runtime> }` (`board-browsers.ts`) | fixed-tmp | once | no |
| `browsers/<id>/` | Chrome's own `--user-data-dir` for a board browser (cookies, logins, `DevToolsActivePort`). Folder `0700` | Chrome | n/a | yes |

All CORE (for `board-browsers.json`, `running` is state that is rebuilt).

## Core: spend history (root)

| Path | Format | Writer | Notes |
| --- | --- | --- | --- |
| `spend-days.json` | compact JSON +nl: `{ "YYYY-MM-DD": { <slug>: usd } }`, huddle agents' spend, last 60 days | `addHuddleSpend` (`spend.ts`), atomic, read-modify-write | every read |
| `telegram-spend.json` | compact JSON +nl: `{ "YYYY-MM-DD": usd }`, last 60 days | `addTelegramSpend`, atomic | every read |
| `telegram-desk-spend.json` | same shape (front desk; also added to `telegram-spend.json`) | `addDeskSpend`, atomic | every read |
| `helper-spend.jsonl` | JSONL `{ at, kind: "helper", costUsd }` | `addSideSpend` from `helper/runner.ts`, append | mtime/size cache |
| `usage-windows.json` | compact JSON array of `{ start, end, utilization, seenAt }`, sorted by `end`, last 500, no final newline | `recordWindow` (`ticket-usage.ts`), atomic | every read |

All CORE: none of them can be rebuilt.

## State (root)

Read once and held in memory; the daemon's next save overwrites outside edits.

| Path | Format | Writer |
| --- | --- | --- |
| `messages.json` | compact JSON +nl `{ version: 1, messages: StoredMessage[] }` (helper's sent and held alerts) | `MessageStore.save` (`helper/messages.ts`), fixed-tmp |
| `waits.json` | JSON (indent 1) +nl `{ version: 1, records, notifyUserAt, firstSummaryPending? }`; unreadable file renamed `waits.json.corrupt-<ms>` | `WaitStore.save` (`helper/waits.ts`), fixed-tmp |
| `helper-state.json` | JSON (indent 1) +nl `RunnerState` (`helper/runner.ts`) | atomic |
| `telegram-links.json` | compact JSON +nl `{ version: 1, links }` | `helper/tgstores.ts`, fixed-tmp, `0600` on create |
| `telegram-pending.json` | compact JSON +nl `{ version: 1, actions }` | same |
| `telegram-updates.json` | compact JSON +nl `{ bot, items, seen }` | same |
| `telegram-offset.json` | compact JSON +nl `{ bot, offset }` | `helper/telegram.ts`, fixed-tmp |
| `telegram-frontdesk.json` | compact JSON +nl `DeskState` without `token` | `helper/frontdesk.ts`, atomic |

## Caches (rebuildable)

| Path | Format | Writer | Notes |
| --- | --- | --- | --- |
| `session-summaries.json` | compact JSON `{ tag, items, stale? }` (`session.ts`) | atomic, at most every 30 s and at shutdown | read once; entries checked against the transcript's size and mtime |
| `usage-last.json` | compact JSON, no final newline, `{ last, lastError, attemptAt, blockedUntil, failures }` (times in epoch ms) | `UsageCache` (`usage-cache.ts`), atomic | read at start, again when its size or mtime changes (shared with the Rust server) |
| `mcp-seen.json` | compact JSON array of server names | `mcp.ts`, plain write | read once |
| `claude-ai-connectors.json` | compact JSON array of connector names | `mcp.ts`, plain write | read once |
| `claude-commands.json` | pretty JSON `{ "bundledSkills": string[] }` | `commands.ts`, atomic | read once |
| `model-versions.json` | pretty JSON `{ "versions": { "<family>": "5.5" } }` | `model-versions.ts`, atomic | read once |
| `learned/scanned-at.json` | compact JSON +nl `{ "<slug>/<id>": updatedAt }` | `learner.ts`, atomic, 2 s after a change | read once |
| `profiles/<slug>/run-logs-compressed.jsonl` | JSONL `{ id, key }` with `key` = `` `${doneAt ?? updatedAt}|${runCount ?? 0}` `` | `RunLogCompressor`, append | read once per board |
| `automation-bin/ckanban` | `#!/bin/sh` + `exec '<ckanban argv>' "$@"`, mode `0755` | `integrations/script.ts`, plain write when it differs | |

## Scratch and logs

| Path | What |
| --- | --- |
| `daemon.log`, `daemon.log.1`, `daemon.log.2` | The daemon's stdout and stderr (launchd sends them there; `ckanban install`). At start, over 5 MB: `.2` removed, `.1` -> `.2`, the log copied to `.1`, then truncated in place (launchd keeps it open). Lines tagged `[lag]` name slow jobs |
| `debug/daemon-<ISO with : and . as ->.cpuprofile` | V8 CPU profiles from `POST /api/debug/profile` |
| `share-tmp/<uuid>.html` | Page made from a Markdown output while it is published; removed afterwards |
| `side-calls/`, `artifact-helper/`, `signin/` | Empty working folders for short Claude calls (side calls, the artifact helper, MCP sign-in) |
| `automation-tests/<id>.sh` | A script being tested; removed after the run |
| `browsers-removed/<id>-<ms>/` | A removed board browser's folder, deleted in the background |
| `browser-files/` | Files a board browser's tools save when no run folder is given |

Temp files: `atomicWrite` leaves `<file>.tmp-<8 base36>` only on a crash. At start `sweepTempFiles` removes such files
older than 24 h, but only under `profiles/`, `learned/` and `huddle-notes/` (6 levels deep; not inside `outputs/`
subfolders). Fixed-tmp writers can leave `<file>.tmp`. A port must ignore names containing `.tmp`.

## Outside the data folder

Written by the daemon but not under `root`, listed so a port knows they exist:

- Ticket copies (worktrees): `<parent of the board folder>/.ckanban-worktrees/<slug>/<ticket id>/` (`worktreeDir` in
  `git.ts`), on branch `ck/<ticket id>-<title slug>`.
- Claude session transcripts: `$CLAUDE_CONFIG_DIR/projects/...` (default `~/.claude`), written only by fork and rewind.
- The launchd job: `~/Library/LaunchAgents/<label>.plist` (`launchd.ts`, `ckanban install`).
