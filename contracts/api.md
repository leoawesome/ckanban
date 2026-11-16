# ckanban daemon web API (contract)

This file describes the daemon's HTTP API as it behaves today (source: `src/api/server.ts`), so another implementation
can answer the same requests. Record types named here live in `src/core/types.ts` unless another file is given.
`src/cli/client.ts` (the CLI and MCP server) and `web/src` (the board UI) are the callers.

## Basics

**Base URL.** `http://localhost:<port>` (also `http://127.0.0.1:<port>`). The port is `CKANBAN_PORT` when set, else
`port` in `~/.claude-kanban/config.json` (default `7777`). The daemon binds `127.0.0.1` only.

**Second listener (phone access).** When `remotePort` is configured (`Config.remotePort`, default port + 1) the daemon
also listens on `127.0.0.1:<remotePort>`. Only `tailscale serve` points there. Every response on that listener carries
the header `x-ckanban-listener: remote`. Routes below that say "local only" refuse requests from this listener.

**Format.** JSON in, JSON out (`content-type: application/json`). Exceptions are named per route (raw uploads, file
bytes, images, the event stream, an HTML OAuth page, the WebSocket).

**Request pipeline, in order:**

1. Host/Origin check (`requestRefusal`). On failure: status 403, `content-type: text/plain`, body `forbidden` (or a
   longer `forbidden: ...` text on the remote listener). Rules:
   - Local listener: `Host` must be exactly `localhost:<port>` or `127.0.0.1:<port>`. For any method other than GET or
     HEAD, an `Origin` header, when present, must be `http://localhost:<port>` or `http://127.0.0.1:<port>`. A
     mutation with no `Origin` is allowed.
   - Remote listener: refused unless phone access is on. `Host` must be the tailnet host (optionally `:443`). Header
     `tailscale-user-login` must equal the allowed login (case-insensitive). Mutations with an `Origin` must use
     `https://<tailnet host>`.
2. Paths not starting with `/api/` serve the web UI: a built file from the web folder (or the embedded assets of the
   binary), else `index.html` (SPA fallback). No UI built: 404 text `UI not built. Run: bun run build:web`.
3. Front desk gate (see header `x-ckanban-frontdesk` below).
4. `/api/attachments/...` is handled next (uploads are raw bytes).
5. Every POST, PATCH or PUT must send `content-type: application/json` (parameters ignored), else
   `415 {"error":"content-type must be application/json"}`. This applies even when the route reads no body.
   DELETE and GET bodies are never checked.
6. Route matching. No match: `404 {"error":"not found"}`.

**Error shape.** `{"error": "<text>"}`, sometimes with extra fields:
- `confirm`: on a 409 from the "work at the same time" check (values `huddle-open` or `run-active`); the UI asks the
  user and resends with `confirmParallel: true`.
- `code`: on errors from passes (`PassError.code`), when set.

Status mapping of thrown errors: `HttpError` its own status; `ConflictError` 409; `McpError`, `AgentError`,
`ScheduleError`, `LoopError`, `PassError`, `JobError`, `SnippetError`, `HuddleError`, `RemoteError`, `QuickChatError`
their own `.status`; `URIError` (bad percent encoding in the path) `400 {"error":"malformed URL"}`; anything else 500
with the error message. Some routes convert module errors (`FileError`, `DeviceError`, `BrowserError`, `ChromeError`,
`AttachmentError`, `BugReportError`, `LearnError`, `SimplifyError`, `HelpError`, `PrError`, `ShareError`, `DiffError`,
`AvatarError`, `HelperError`, `MessageError`) into `HttpError` with that error's status.

Path segments are percent-decoded before matching (`decodeURIComponent`).

**Secret masking.** Every JSON response (and every event-stream message) passes through `maskSavedJson`: any value of a
key saved on this Mac (board keys, passes) is replaced before it leaves the daemon.

### Special headers

| Header | Value | Effect |
|---|---|---|
| `x-ckanban-run` (`RUN_HEADER`) | `<board slug>/<ticket id>` | The caller is a board run or chat of that ticket (sent by the MCP tools inside runs). Many user-only actions refuse it (403). For ticket changes, "run rights" decide what it may touch (see below). Schedule and job edits are credited to that ticket. |
| `x-ckanban-huddle-agent` (`HUDDLE_HEADER`) | the agent's huddle token | The caller is a huddle participant. Used by huddle routes to identify the sender; most board changes refuse it. |
| `x-ckanban-source` (`SOURCE_HEADER`) | `ui` or `mcp` | Where the request comes from. `ui` turns on the "work at the same time" 409 (with `confirm`) on ticket PATCH and huddle start. Recorded on huddle posts (`HuddleSource`; anything else is `none`). |
| `x-ckanban-quick-chat` (`QUICK_CHAT_HEADER`) | `<board>/<chat id>` | Sent by tools inside a quick chat run. Only used to refuse schedule deletes. |
| `x-ckanban-frontdesk` (`FRONT_DESK_HEADER`) | `<board>/<chat id>/<secret>` | The Telegram front desk. See below. |
| `tailscale-user-login` | Tailscale login | Remote listener only: must match the allowed login. |
| `x-file-name` | percent-encoded file name | Attachment upload: the original file name. |
| `origin` | page origin | Needed by user-only actions and the WebSocket (see below). |
| `x-ckanban-listener` (response) | `remote` | Set on every response of the remote listener. |

**Front desk header.** When `x-ckanban-frontdesk` is present:
- With `x-ckanban-run` or `x-ckanban-huddle-agent` too: `403`.
- `POST /api/telegram/front-desk/file` is answered here (see Notifications).
- Otherwise the request is passed to the front desk gate. Its answer, when it holds the request, is returned as is:
  `202 {"confirmation": "..."}` when an action that starts, stops or moves work was held for a Confirm tap in
  Telegram; `403` for an unknown identity, Telegram not taking messages, or a new main ticket; `404` for an unknown
  board, ticket or schedule; `409` when Telegram can't be reached; `400` for an empty chat message. Requests the gate
  doesn't hold continue normally. After the user taps Confirm, the daemon replays the request internally as the user.
- Without the header, `/api/telegram/front-desk/file` answers `403`.

**User-only check (`userOnly`).** Actions marked "user only" are refused with 403 when the request has
`x-ckanban-run` or `x-ckanban-huddle-agent`, or has no `Origin` header. On the remote listener it then passes. On the
local listener the peer TCP port must belong to a web browser the daemon did not start (process lookup in
`integrations/guard.ts`); otherwise 403. The 403 text explains it is for the user only.

**Behind a front server.** A server in front of the daemon (the Rust `ckanban-rs dev`, `rust/README.md`) starts it
with `CKANBAN_PORT` set to an internal port, `CKANBAN_FRONT_PORT` set to the board's port, and the line `<secret> <its own pid>` (a fresh random secret)
first on its stdin (not an env var: same-user processes can read another process's environment). The
front sends every request with `x-ckanban-front: <secret>` and `x-ckanban-peer-port: <the caller's TCP port>`, after
dropping any copies the caller sent. The daemon then answers on the internal port only with the exact secret (else
`403 forbidden`), checks Host and Origin against the board's port, uses the peer header (not the socket) for the
user-only and schedule-delete caller checks, ignores the front's own pid in those lookups, gives runs and scripts the
board's port, and stops when its stdin ends (the front is gone). Without `CKANBAN_FRONT_PORT` both headers are ignored
and stdin is not read. The remote listener (`CKANBAN_REMOTE_PORT`) is never behind the front. Later stdin lines are
notices from the front: `changed automation-passes.json` after the front changed that file itself; the daemon then
sends the `integration.updated` event, as after its own writes.

**Run rights (`runRights`).** Ticket changes sent with `x-ckanban-run` are allowed only for: a Planning chat answering
the user's typed message (any ticket of its board but its own: "requester"); a main ticket or tool group on its own
family ("planner"); an active work run or chat reply on other tickets of its board ("runner"); a chat on another board
answering the user's typed message ("guest"). Everything else is 403. Changes made this way get an `ai` comment on
the changed ticket naming who made them. A run touching its own ticket is 403, except the self move described under
ticket PATCH.

### TicketView

Most ticket routes return a `TicketView`: a `Ticket` plus these fields (built by `view()` in http.ts): `running`,
`holdsSlot`, `resumeCommand`, `session` (`SessionSummary`, session.ts, or null), `links`, `outputDir`, `shareJobs`,
`canCopyFile`, `terminalOpen`, `recovery`, `devices`, `chromeAbove`, `browsersAbove`, `folderWait`, `userWait`,
`attention`, `snoozed`, `huddleBusy`, `huddleLine`, `costUsd`, `runCap`; for a main ticket also `familyWorking`,
`stepsRunning`, `familyCard`; for a sub-feature `subFeatureOf`; for a tool ticket `mainTicket`. Board listings add
`feature: true` on open features. `links` is `{url, label, at, source}[]` newest first (`board/links.ts`): claude.ai
artifact URLs from the ticket's session, its huddle teammates' sessions (`huddle:@<handle>`) and its `ai` comments
(`result`; label from the Markdown link text, else `claude.ai artifact`), plus its share links (`share`).

### Event stream

`GET /api/events` returns `text/event-stream` (`cache-control: no-cache`). It starts with the comment `: connected`
and sends `: ping` every 15 s. Each bus event is one `data: <json>` message. Event `type` values (`src/core/events.ts`):
`ticket.updated`, `ticket.deleted`, `activity`, `profile.updated`, `session.updated`, `draft`, `mcp.updated`,
`schedule.updated`, `loop.updated`, `integration.updated`, `job.updated`, `snippets.updated`, `devices.updated`,
`browsers.updated`, `restart.updated`, `awake.updated`, `helper.updated`, `helper.message`, `messages.updated`,
`learned.updated`, `huddle.updated`, `huddle.message`, `huddle.activity`, `huddle.session`, `chat.updated`,
`chat.draft`, `chat.activity`, `context.updated`.
- `ticket.updated`: `ticket` is replaced by its `TicketView`.
- `session.updated` and `huddle.updated` are followed by an extra `ticket.updated` message for the affected ticket.
- `activity`: long strings inside `event` are cut (`liveCut.ts`).

### WebSocket (terminal)

`GET /api/profiles/:slug/shell?ticket=<id>&cols=<n>&rows=<n>` upgrades to a WebSocket for an interactive shell in the
board folder, or in that ticket's copy of the folder. `cols` default 80, `rows` default 24, both clamped to 1..1000.
The upgrade needs an `Origin` equal to the board's own origin (local) or the tailnet URL (remote).
- Errors before the upgrade, in this order: `501` when the Bun runtime has no PTY support; `403` bad Origin; `400`
  invalid ticket id (`^[A-Za-z0-9_-]{1,80}$`); `404` unknown ticket; `400` not a WebSocket upgrade.
- The shell starts in the ticket's copy of the folder, or the board folder when the ticket has none or no ticket is
  given. A `cols` or `rows` of 0 or not a number means the default; resize messages are clamped the same way.
- Client to server (JSON text): `{"type":"input","data":"..."}`, `{"type":"resize","cols":n,"rows":n}`,
  `{"type":"restart"}`. Other or invalid messages are ignored.
- Server to client: binary frames with terminal output (scrollback first on connect), and JSON text
  `{"type":"exit","code":n}`, `{"type":"error","message":"..."}` (shell couldn't start), `{"type":"reset"}` (before a
  restart). One shell per board/folder is shared between tabs.

## System and misc

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/health` | | 200 `{claude, git, gh, pty}`: paths of the binaries or null, `pty` boolean | |
| POST | `/api/debug/profile` | query `seconds` (default 15) | 200 `profileFor()` result (cpuprof.ts) | 403 with `x-ckanban-run`, Host not localhost/127.0.0.1, or Host on the remote port |
| GET | `/api/events` | | event stream (above) | |
| GET | `/api/version` | | 200 `UpdateChecker.status()` (update.ts) | |
| GET | `/api/usage` | query `fresh=1` asks Anthropic now (still at most one call a minute) | 200 `UsageView` (usage-cache.ts), see "Plan usage" below | |
| GET | `/api/spend` | | 200 `SpendIndex.recent()` (spend.ts): `{ day, costUsd, boards }`, see "Today's spend" below | |
| GET | `/api/team-usage` | | 200 `{teammates: {name: Usage}, templates: {name: Usage}}`, `Usage {huddles, lastUsed, costUsd, recent: [{board, huddle, ticket, title, at, costUsd}]}` (newest first, at most 5), over every board's huddles, closed ones included | |
| GET | `/api/awake` | | 200 `{held: boolean}` | |
| GET | `/api/restart` | | 200 `Board.restartState()` | |
| POST | `/api/restart` | body ignored | 200 `{running, alreadyPending}` | 501 not running as the daemon |
| GET | `/api/claude/projects` | | 200 list of Claude Code projects (`listClaudeProjects`) each with `hasProfile` | |
| GET | `/api/claude/defaults` | | 200 `claudeDefaults()` plus `versions` (learned model versions) | |
| POST | `/api/pick-folder` | body ignored | 200 `{path}` from the native folder picker | |
| GET | `/api/version-history` | query `path` (absolute) | 200 `{git, repo}`: git binary path or null; `repoKind()` or null | 400 path missing or not absolute |
| POST | `/api/version-history` | `{path}` (absolute) | 200 `enableVersionHistory()` result plus `repo` | 400 path, 400 git not installed, 404 folder missing, 409 a run is editing that folder, 500 git failed |
| GET | `/api/cron/preview` | query `expr` | 200 `{valid, error, summary, next: ISO[3]}`; invalid gives `valid:false` with `error` | |
| POST | `/api/bug-report/draft` | `{profile?, ticketId?}` | 200 `draftReport()` (bugreport.ts) | `BugReportError` status |
| POST | `/api/bug-report` | `{title, description, include?: string[], source?: "ui"\|"ai"\|"cli", profile?, ticketId?}` | 201 when an issue URL came back, else 200; `submitReport()` result | `BugReportError` status |
| GET | `/api/inbox` | | 200 array, oldest wait first: `{profile, profileName, id, title, attention, snoozedUntil?}` over every board | |
| GET | `/api/tickets` | query `scope=open` | 200 command bar rows of every open ticket on every board (cmdbar.ts) | 400 other scope |
| GET | `/api/tickets` | query `scope=done`, `q`, `board?`, `limit?` | 200 best-matching Done rows | |
| GET | `/api/tickets` | no scope | 200 one light row per ticket on every board: `{profile, profileName, id, title, status, running, updatedAt, body, summary, prUrl, mainTicket?}` (texts capped at 4000 chars) | |
| POST | `/api/automation-call` | `{token, service, tool, args}` | 200 `{result}` (`LoopManager.call`) | `LoopError`/`PassError` status |

**Plan usage (`GET /api/usage`).** Always status 200; failures are in the body. The answer is one of:
- `{ windows, fetchedAt }`: the last good numbers. `windows` is `{ key, label, percent, resetsAt }[]` (`key` such as
  `five_hour`, `seven_day`, `seven_day_opus`; `percent` 0-100; `resetsAt` ISO or null), only keys starting with
  `five_hour` or `seven_day` that carry a numeric `utilization`, `five_hour` first. With `stale: true` and `error` when
  a later check failed, plus `limited: true` and `retryAt` (ISO) after a 429.
- `{ error, fetchedAt }` when there were never any numbers, plus `limited` and `retryAt` after a 429. No credentials,
  an expired token, an unreachable or failing endpoint all land here.

Caching (`UsageCache`): one call in flight for everyone; a good answer is reused for 4 minutes; never more than one call
a minute, `fresh=1` included; after a 429 a growing wait (1, 2, 4, 10 min, or `retry-after` when longer, capped at
30 min); the state is saved to `usage-last.json`, read at start and again whenever another process changed it (a check either one made counts for both). The request is
`GET <CKANBAN_USAGE_URL>` with `authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`. Environment:
- `CKANBAN_USAGE_URL`: the usage endpoint (default `https://api.anthropic.com/api/oauth/usage`). Tests point it at a local fake.
- `CKANBAN_NO_KEYCHAIN=1`: read the token only from `$CLAUDE_CONFIG_DIR/.credentials.json` (default
  `~/.claude/.credentials.json`), JSON `{ "claudeAiOauth": { "accessToken", "expiresAt" (epoch ms, optional) } }`.
  Unset on macOS: the keychain items `Claude Code-credentials` (the OS user's account, then any) are read too, and the
  login with the latest `expiresAt` (none counts as latest) wins.

**Today's spend (`GET /api/spend`).** `{ day: "YYYY-MM-DD" (local), costUsd, boards: { slug, name, costUsd }[] }`,
one entry per board in board order, then `{ slug: "~helper", name: "Helper", costUsd }` when the helper spent
anything today. A board's cost is today's share of: its tickets' `activity.jsonl` result lines (each line carries the
session's running `total_cost_usd`; the growth counts, on the line's local day), its tickets' `side-spend.jsonl`, its
quick chats' `chats/<id>.activity.jsonl` and `.side-spend.jsonl`, and its entry in `spend-days.json`. Files untouched
since local midnight are skipped. The answer is reused for 5 seconds.

## Attachments

Handled before the JSON content-type rule.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| POST | `/api/attachments` | raw bytes; `content-type` an image type from `IMAGE_TYPES` or `application/octet-stream`; header `x-file-name` | 201 `{url: "/api/attachments/<name>", path}` | 415 other type; `AttachmentError` status (size etc.) |
| GET | `/api/attachments/:name` | query `download` (present), `name` (shown file name) | 200 file bytes with its type, `nosniff`, `content-security-policy: sandbox`, `cache-control: private, max-age=31536000, immutable`; `content-disposition` attachment for downloads and Office files, inline when only `name` is given | 404 not found |
| GET | `/api/attachments/:name/info` | | 200 `{size}` | 404 |

Any other method or shape under `/api/attachments`: `404 {"error":"not found"}`; there is no list or delete route. A
name that isn't a generated one (`<32 hex>.<ext>`, so no `../`) or a missing file: `404 {"error":"attachment not
found"}`, also for `/info`.
- Upload errors (`AttachmentError`): `415` for another content type or a file kind that can't be attached (the
  extension comes from `x-file-name` when it has one, else from the image type), `400 file is empty`,
  `400 file is not a valid <EXT> file` (first bytes don't match: PNG/JPEG/GIF/WebP/PDF magic, a zip for Office files,
  no NUL in the first 8 KB of text), `413 file is larger than 25 MB` (exactly 25 MB is accepted).
- Served types: images with their type, PDF and Office files with theirs, every text or code kind (`.html` too) as
  `text/plain; charset=utf-8`.
- Attachments are files of the data folder, not of a ticket: deleting a ticket deletes the ones its description,
  comments, queued messages and chat transcript refer to; moving a ticket to another board keeps the same names.

## Remote (phone access)

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/remote` | | 200 `RemoteStatus` (remote.ts) plus `qrSvg` (or null) and `local` (request came in on the local listener) | |
| POST | `/api/remote` | `{enabled: boolean}` | 200 same shape, `local: true` | 403 remote listener, 403 `x-ckanban-run`, 400 enabled not boolean, `RemoteError` status |

- Checks run in the order listed, before any Tailscale command. `on` runs `tailscale status --json` and
  `tailscale serve --bg --https=443 http://127.0.0.1:<remote port>`, then writes `remote.json`; `off` writes
  `enabled: false` first (or deletes the file when it held nothing usable), then runs `tailscale serve --https=443 off`
  and reports a failure there as `warning` (still 200). `RemoteError` statuses: 424 Tailscale missing, stopped, not
  signed in or Serve not enabled; 409 the phone access listener isn't answering; 502 Tailscale failed.
- `GET /api/remote` while phone access is on also runs `tailscale status --json` (at most 3 s) and adds `tailscale`
  (`running`, `stopped` or `unavailable`) and `backendState`. While off it runs nothing.
- The `tailscale` command is `/Applications/Tailscale.app/Contents/MacOS/Tailscale` when that exists, else `tailscale`
  on PATH (run with `TAILSCALE_BE_CLI=1`).
- Refusal texts on the phone access listener (403 `text/plain`): `forbidden: phone access is off (run \`ckanban remote
  on\` on the Mac)`; `forbidden` for another Host or a mutation's foreign Origin; `forbidden: open this board signed in
  to Tailscale as its owner` for a missing or other login. `remote.json` is re-read when its mtime changes.

## Browsers and devices

Board browsers (board-browsers.ts) and named Chromes (chromes.ts) share one view, here called `BrowsersView`: the
Chromes view (`browsers.json` as saved: `{browsers, listedAt, connected}`), plus `boardBrowsers` (`BoardBrowserView[]`:
the saved entry plus `state`, `signIn` "Signed in"/"Needs sign-in"/"Not checked", `signInSite`, `checkedAt`, `inUse`
(runs holding it), `windowPending`, `error` (last start or close problem, plain words, or null), `folder`
(`<data>/browsers/<id>`)), `chrome: {installed, message}` (whether Google Chrome is found: `CKANBAN_CHROME_BIN`, then
the usual app paths), and `boards: [{slug, name, chrome, browsers}]` (`browsers` is the board's own picks or null).
`:id` and `:deviceId` are percent-decoded.
- Add: the id is a slug of the name (`work-whatsapp`, then `-2`, `-3` on a clash); the name is trimmed, inner spaces
  squashed, at most 40 characters; empty 400, a name equal to another one ignoring case 409. Makes `browsers/<id>/`
  (mode 0700) and saves `board-browsers.json`; it never starts Chrome. `board-browsers.json` doesn't exist until the
  first change.
- PATCH `startUrl`: a web address with or without `https://` (saved as the full URL), `null` or `""` clears it, any
  other scheme 400; `keepRunning` not boolean 400; unknown id 404.
- Starting Chrome (open, sign-in, ensure, a run's start): a Chrome that exits before it reports its port gives 502,
  too slow 504; the message also shows as the browser's `error`. open and sign-in start it with a window on
  `--user-data-dir=<folder>` and the given URL; ensure and a run's start start it hidden (`--headless=new`).
- A run whose ticket or board picked a board browser holds it (`inUse`) from its start until it ends, even when Chrome
  couldn't start. While held: close and DELETE 409, ensure tries to start it; once let go, ensure 409.
- close on a browser that isn't running: 200 `closed: true`. screen and input: 404 unknown, 409 when it isn't
  running or doesn't need sign-in; input checks its shape first (400 for a tap outside 0..1, an unknown key or type).
- DELETE moves its folder out of `browsers/` at once and deletes it in the background.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/board-browsers` | | 200 `BrowsersView` | |
| POST | `/api/board-browsers/:id/ensure` | body ignored | 200 `{ok: true, port}` | 404 unknown browser, 409 no run is using it |
| POST | `/api/board-browsers` | `{name}`; user only | 200 `BrowsersView` plus `added` (new id) | 403, `BrowserError` status |
| PATCH | `/api/board-browsers/:id` | `{name?, keepRunning?, startUrl?}`; user only | 200 `BrowsersView` | 403, `BrowserError` |
| DELETE | `/api/board-browsers/:id` | user only | 200 `BrowsersView` | 403, `BrowserError` |
| POST | `/api/board-browsers/:id/open` | `{url?}`; user only | 200 `BrowsersView` plus `openWindow()` result | 403, `BrowserError` |
| POST | `/api/board-browsers/:id/sign-in` | same as open | same | same |
| POST | `/api/board-browsers/:id/screen` | user only | 200 `image/jpeg` of the login tab, `cache-control: no-store`, header `x-page-site` | 403, `BrowserError` |
| POST | `/api/board-browsers/:id/input` | tap or typing object passed to `BoardBrowsers.input`; user only | 200 `{ok: true}` | 403, `BrowserError` |
| POST | `/api/board-browsers/:id/close` | user only | 200 `BrowsersView` plus `closed` and `message` | 403, 409 a run uses it, `BrowserError` |
| GET | `/api/browsers` | | 200 `BrowsersView` | |
| PATCH | `/api/browsers/:deviceId` | `{name: string}` | 200 `BrowsersView` | 403 run/huddle header, 400 name not text, `ChromeError` |
| DELETE | `/api/browsers/:deviceId` | | 200 `BrowsersView` | 403 run/huddle header, `ChromeError` |
| GET | `/api/devices` | | 200 `DeviceView[]` (devices.ts), `using` and `waiting` entries with `title` and `board` | |
| POST | `/api/devices` | `{name, description?, capacity?}` (upsert) | 200 device list | 403 run/huddle header, `DeviceError` |
| DELETE | `/api/devices/:name` | | 200 device list | 403, `DeviceError` |
| POST | `/api/devices/:name/free` | `{profile, id}` | 200 device list | 403, `DeviceError` |

Devices (devices.ts): names are 1 to 48 lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit
(input is trimmed and lowercased; anything else 400); `capacity` is clamped to 1..50, `description` trimmed and cut at 300 characters. An upsert by the user
drops `addedByClaude`. DELETE: 404 unknown, 409 while a ticket holds it or waits for it. free: 404 when that ticket
doesn't hold it. Holds and the waiting line live in memory only; `devices.json` keeps the list and `lastUsedAt` (the
time of the last grant). A ticket's run takes and lets go with `POST .../tickets/:id/devices` (Ticket cards):
- take `{names, waitMs?}`: `names` an array or a comma-separated string. Answers `{ok: true, names}` once the ticket
  holds every one (all or nothing; asking again for what it holds is ok). Otherwise it waits up to `waitMs` (clamped
  0..240000, default 240000) and answers `{ok: false, names, place, usedBy: [{slug, id, since, title}]}`; the ticket
  keeps its place, and a waiting call returns as soon as the devices are granted. A ticket that holds something and
  asks for more: 409. A name not on the list is added (capacity 1, `addedByClaude: true`).
- release `{names?}`: lets go of those (all when missing or empty) and drops the ticket's waiting request; answers
  `{released: [names it let go of]}`. Freed devices go to the next in line at once.
- When a ticket's run ends, the board lets go of everything it holds or waits for.
- `x-ckanban-run` must be exactly `<slug>/<id>` of this ticket and no huddle header, else 403; `action` other than
  take or release 400.

## Notifications, messages, helper, push, Telegram

All `/api/notify`, `/api/messages`, `/api/helper` and `/api/push` routes answer 403 to `x-ckanban-run`.

The Telegram Bot API address is `https://api.telegram.org` unless `CKANBAN_TELEGRAM_URL` is set (a trailing `/` is
dropped): a test hook that points the daemon at a local fake Bot API, never set on a real Mac. The public Telegram state
in `Notifier.state()` (`telegram`) is `{paired, tokenSet, tokenMasked ("set ...1234"), status ("no-token", "ok"...),
botName ("@name"), chatName, frontDesk, pairing: {expiresAt} | null, pairError}`, never the token or `chatId`; pairing
from a board sets `frontDesk` to that board.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/notify` | | 200 `Notifier.state()` plus `local` | |
| POST | `/api/notify` | settings patch (`Notifier.update`); user only | 200 new state plus `local` | 403 user only or Mac-only setting from the phone (`MacOnlyError`; a `telegram.token` change from the phone answers `Pair Telegram from the Mac.`), 400 invalid (the typed token is never echoed) |
| POST | `/api/notify/test` | `{profile?}` | 200 `Notifier.test()` result plus `state`; the test is saved in `messages.json` with level `"test"` | |
| POST | `/api/notify/telegram/pair` | `{board?}`; user only; local only | 200 `telegramPair()` result (pairing code) plus `state` | 403, 400 |
| POST | `/api/notify/telegram/unpair` | user only | 200 state plus `local` | 403 |
| POST | `/api/telegram/front-desk/file` | header `x-ckanban-frontdesk`; `{path, caption?}` | status and body from `FrontDesk.sendFile` | 403 without the header or with a run/huddle header |
| GET | `/api/messages` | query `tab` (`needs`\|`all`\|`summaries`\|`quiet`, default all), `limit` (1..100, default 30), `beforeAt`+`beforeId` or `afterAt`+`afterId` | 200 `{rows, hasMore, needs, unread}`; `needs` is a number; rows are `{id, at, level, oneLine, readAt, needsYou?, held?, practice?}` (no ticket id) | |
| POST | `/api/messages/read-all` | body ignored | 200 `{marked, unread}` | |
| GET | `/api/messages/:id` | | 200 message with its states | 404 |
| GET | `/api/messages/:id/near` | query `tab`, `keep` | 200 `nearOf()` result (newer and older message) | 404 |
| POST | `/api/messages/:id/read` | body ignored | 200 `{message, unread}` | 404 |
| POST | `/api/messages/:id/got-it` | `{key?}`; user only | 200 helper result plus `message`, `unread` | 404, 403, 503 helper not running, `HelperError` status, else 400 |
| POST | `/api/messages/:id/not-urgent` | same | same | same |
| GET | `/api/helper` | | 200 `HelperRunner.status()` (the daemon always has a helper, switched on or off) | 503 helper not running (only without one) |
| POST | `/api/helper/settings` | settings patch; user only | 200 status | 403, 503, 400 |
| GET | `/api/helper/feedback` | | 200 `{lines}` | 503 |
| POST | `/api/helper/feedback` | `{text}`; user only | 200 `{line, lines}` | 403, 503, 400 |
| DELETE | `/api/helper/feedback/:lineId` | user only | 200 `{lines}` | 403, 503, 404 |
| POST | `/api/helper/should-have-pinged` | `{profile, ticketId}`; user only | 200 helper result plus `lines` | 400 missing fields, 403, 503 |
| POST | `/api/helper/practice` | user only | 200 practice result | 403, 503, 409 `Turn the helper on first` while it is off, helper error status |
| POST | `/api/helper/notice-seen` | user only | 200 status | 403, 503 |
| GET | `/api/push` | | 200 `{publicKey, devices, dropped}` | |
| POST | `/api/push/subscribe` | `{subscription, label?, replaces?}` | 200 `{id, label, createdAt}` | 400 invalid |
| POST | `/api/push/remove` | `{id}` or `{endpoint}` | 200 `{removed, devices}` | 400 neither |
| POST | `/api/push/visible` | `{endpoint, visible}` | 200 `{ok: true}` | 400 no endpoint |
| POST | `/api/push/test` | `{id, profile?}` | 200 `Notifier.testDevice()` result | 400 no id |

## Avatars

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/avatars` | | 200 the saved avatar set (avatars.ts) | |
| PUT | `/api/avatars/:name` | avatar choice object | 200 the new set | 403 run/huddle header, 400 invalid JSON, `AvatarError` status |
| DELETE | `/api/avatars/:name` | | 200 the new set | 403, `AvatarError` |
| PUT | `/api/avatars/claude/name` | `{name: string \| null}` ("" or "Claude" resets) | 200 the new set | 400 body not `{name}`, 403, `AvatarError` |

## Connections: MCP servers, agents, snippets, passes

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/mcp` | | 200 `McpState` (mcp.ts) | |
| POST | `/api/mcp` | server definition (`McpManager.add`) | 201 `McpState` | `McpError` |
| POST | `/api/mcp/refresh` | body ignored | 202 `McpState` | |
| PUT | `/api/mcp/:name` | server definition | 200 `McpState` | `McpError` |
| DELETE | `/api/mcp/:name` | query `board?` | 200 `McpState` | `McpError` |
| POST | `/api/mcp/:name/move` | `{to: "board"\|"all", board}` | 200 `McpState` | 400 bad `to`, `McpError` |
| POST | `/api/mcp/:name/retry-move` | | 200 `McpState` | `McpError` |
| POST | `/api/mcp/:name/login` | | 202 `McpState` | `McpError` |
| POST | `/api/mcp/:name/login-paste` | `{text}` | 200 `McpState` | `McpError` |
| POST | `/api/mcp/:name/cancel-login` | | 200 `McpState` | |
| POST | `/api/mcp/:name/logout` | | 200 `McpState` | `McpError` |
| POST | `/api/mcp/:name/recheck` | | 200 `McpState` | 502 couldn't check |
| GET | `/api/mcp/:name/config` | query `board?` | 200 `McpManager.config()` | `McpError` |
| GET | `/api/agents` | | 200 `AgentRegistry.status()` (agents.ts) | |
| POST | `/api/agents/:id/install` | `:id` in `AGENT_IDS` | 200 status | 404 unknown id, `AgentError` |
| POST | `/api/agents/:id/uninstall` | same | 200 status | same |
| GET | `/api/snippets` | query `profile?` | 200 `Snippet[]` (global plus that board's) | |
| POST | `/api/snippets` | snippet fields | 201 `Snippet` | `SnippetError` |
| PATCH | `/api/snippets/:id` | snippet fields | 200 `Snippet` | `SnippetError` |
| DELETE | `/api/snippets/:id` | | 204 | `SnippetError` |
| GET | `/api/passes` | | 200 `{passes: (PassView & {usedBy, usedByNames, boardName})[], automations}` | |
| POST | `/api/passes` | pass fields (`Passes.add`), `board?` slug; user only | 201 `PassView` | 403, 400 unknown board, `PassError` |
| GET | `/api/passes/oauth/callback` | query `state`, `code`, or `error`, `error_description`; local only | 200 HTML "Connected" page; 400 HTML when the service refused; `PassError` status as HTML | 403 JSON on the remote listener |
| GET | `/api/passes/:id/tools` | | 200 `Passes.tools()` | `PassError`, else 502 (masked message) |
| PATCH | `/api/passes/:id` | `{secret}`; user only | 200 `PassView` | 403, `PassError` |
| DELETE | `/api/passes/:id` | user only | 204 | 403, `PassError` |
| POST | `/api/passes/:id/authorize` | user only | 200 `{url}` | 403, `PassError` |

- Server definition (`McpAddInput`): `{name, transport: "stdio"|"http"|"sse", command?, args?, env?: {key, value}[],
  url?, headers?: {name, value}[], board?}`. Without `board` the daemon runs `claude mcp add --scope user ...` (edit:
  `claude mcp remove` then `add`; move to all: `claude mcp add-json --scope user`); with `board` (a slug, 404 when
  unknown) the tool is kept in `profiles/<slug>/board-tools.json` and no `claude` command runs. Errors: 400 bad name,
  transport, command, URL (http/https only) or a value with a line break; 409 name taken (also `ckanban` on a board);
  404 unknown server or board; 400 login/logout for a server without OAuth (stdio); 409 a paste while no sign-in runs.
- `GET /api/mcp/:name/config` returns the saved settings unmasked (env values, headers), for the edit form.
- None of the `/api/mcp` and `/api/agents` routes has a user-only or run check (see Quirks).
- Pass creation (`AddPassInput`): `{kind: "key", name, secret, envName?, url?, board?}` (`envName` defaults from the
  name, e.g. `LINEAR_KEY`; 409 when taken on the same board or for automations), `{kind: "mcp", url, name?}` (https,
  or http on localhost; starts `pending`), `{kind: "local", claudeName}` (404 when not in Claude's settings).
  `PassView` never holds the secret. `GET /api/passes/:id/tools`: 404 unknown, 400 a key for scripts, 502 not signed
  in or the service failed. `POST .../authorize`: 400 no sign-in step, 409 with `code: "no_registration"`, 502.

## Profiles (boards)

`:slug` is the board's slug. Every `/api/profiles/:slug/...` route answers `404 {"error":"board <slug> not found"}`
for an unknown board.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/api/profiles` | | 200 `(Profile & {pathExists, running})[]` | |
| POST | `/api/profiles` | `{name, path, baseBranch?, model?, effort?, ultracode?, workspace?: "worktree"\|"folder"}`; `~` expands | 201 `Profile` | 400 name, 400 not a directory, 400 effort, 400 folder used by another board, 400 workspace |
| GET | `/api/profiles/:slug` | | 200 `Profile` | 404 |
| PATCH | `/api/profiles/:slug` | any of `name, path, baseBranch, model, mainModel, taskModels, freshChatTokens, chrome, browsers, checkinOfferDismissed, effort, ultracode, copyFiles, setupCommand, cleanupCommand, autoHuddles, keepAwake, runCapUsd, artifacts, workspace, claudeAiConnectors, stallMinutes, setupDetected` | 200 `Profile` | 400 validation; 403 `chrome`/`browsers` from a run or huddle, `browsers` user only; 403 `runCapUsd` from a run |
| DELETE | `/api/profiles/:slug` | | 204 | 409 board has running tickets |
| POST | `/api/profiles/:slug/detect-setup` | body ignored | 200 `SetupDetection` | |
| GET | `/api/profiles/:slug/commands` | | 200 skills and commands in the board folder | |
| GET | `/api/profiles/:slug/sessions` | | 200 Claude Code sessions of the folder, each with `live` and `ticket` (`{id, title}` or null) | |
| GET | `/api/profiles/:slug/files` | query `path` (relative), `ticket?` | 200 `{path, ...listDirPage()}` | 400 invalid ticket, 404 ticket, `FileError` |
| GET | `/api/profiles/:slug/file` | query `path`, `ticket?` | 200 `readFileForView()` | same |
| POST | `/api/profiles/:slug/open-file` | `{path, ticket?}` | 200 `{ok: true}` | same |
| GET | `/api/profiles/:slug/shell` | WebSocket (above) | 101 | 501, 403, 400, 404 |
| POST | `/api/profiles/:slug/find-links` | user only | 200 `Linker.find()` suggestions | 403, 502 |
| POST | `/api/profiles/:slug/automation-setup` | user only | 201 `TicketView` (new Planning ticket, `automationSetup: true`) | 403 |
| POST | `/api/profiles/:slug/checkin-setup` | user only | 201 `TicketView` (`checkinSetup: true`) | 403 |
| GET | `/api/profiles/:slug/chat/search` | query `ticket` (default: the caller's own run ticket), `q`, `tools=1` | 200 `{text}` | 400 no ticket or bad query, 404 ticket, 403 out of reach |
| GET | `/api/profiles/:slug/chat/read` | query `ref` (`<sessionId>:<n>`), `before?`, `after?` | 200 `{text}` | 400 bad ref, 404 no such chat, 403 out of reach |

Reach for chat search/read: huddle agents are refused; the user (no run header) may read any; a run its own ticket, a
main ticket its family, a chat answering the user's typed message any ticket on any board. Anything else is 403
`<id> is out of reach: ...`; a run of another board answering no typed message is 403 too.

## Quick chats

Prefix `/api/profiles/:slug/chats`. "User only" here is the `userOnly` check. A route with `:cid` answers
`404 chat not found` first for an unknown chat. `QuickChatView` is in quickchat.ts. A huddle helper
(`x-ckanban-huddle-agent`) is refused like a run; the refusal reads `Quick chats is for the user only, from the board in
a browser: ...`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/chats` | query `limit?`, `before?` | no `limit`: 200 `QuickChatView[]`; with `limit`: 200 `{chats, next}` | |
| POST | `/chats` | `{text}`; user only | 201 `QuickChats.send()` result (new chat) | 403, 400 empty message, 413 message too long |
| GET | `/chats/:cid` | | 200 `QuickChatView` | 404 |
| PATCH | `/chats/:cid` | `{title}`; user only | 200 renamed chat | 403 |
| DELETE | `/chats/:cid` | user only | 204 | 403 |
| GET | `/chats/:cid/context` | | 200 cached context usage (`ContextUsage.view`) | |
| POST | `/chats/:cid/context` | user only | 200 fresh context usage | 403, 409 |
| POST | `/chats/:cid/messages` | `{text}`; user only | 200 send result | 403, 400 empty, 413 too long, 409 the chat became a ticket, is being made into one or is being rewound |
| POST | `/chats/:cid/stop` | user only | 200 `QuickChatView` | 403 |
| POST | `/chats/:cid/ticket` | `{partOf?}`; user only | 201 `{ticket: TicketView, chat}` | 403, 400 bad or unknown `partOf`, 409 already a ticket, Claude still replying, no message yet, or the front desk's chat |
| GET | `/chats/:cid/conversation` | query `limit` (1..500, default 100), `before` (index) | 200 `{entries: SessionEntry[], start, total}` | |
| GET | `/chats/:cid/simplified` | | 200 saved plain-words versions | |
| POST | `/chats/:cid/simplify` | `{uuid}`; user only | 200 simplified text | 403, 404 message, `SimplifyError` |
| GET | `/chats/:cid/rewind` | query `uuid` | 200 `{blocked, files: null, filesReason: "quick-chat"}` | 404 not rewindable |
| POST | `/chats/:cid/rewind` | `{uuid}`; user only | 200 `QuickChats.rewind()` result | 403, 404 not a message it can rewind to (or the conversation file is missing), 409 blocked, 400 the cut failed |
| GET | `/chats/:cid/rewind-undo` | | 200 `{available, blocked, messages, files: 0, filesSaved: false}` | |
| POST | `/chats/:cid/rewind-undo` | user only | 200 undo result | 403, `QuickChatError` |
| POST | `/chats/:cid/fork` | `{uuid}`; user only | 201 `{id, text, chat}` | 403, 404 not a message it can fork from, 409 blocked, 400 the copy failed |
| GET | `/chats/:cid/tool/:toolUseId` | | 200 tool call detail | 404 |

## Schedules

Prefix `/api/profiles/:slug/schedules`. A request with `x-ckanban-run` whose ticket id matches `t_...` is credited to
that ticket (`ScheduleEditor`), else to the user. Input fields (`ScheduleInput`): `name, title, body, mode, cron,
enabled, skipIfRunning, tags, quiet, model, partOf`. The view is `Schedule` plus `summary` (cron in words), `active`,
`partOfTitle?`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/schedules` | | 200 views plus `spend7dUsd`, `quietPerDay` (7 numbers), and for paused ones `pausedAt`, `pausedBy` (`"user"` or `{ticketId, title}`) | |
| POST | `/schedules` | `ScheduleInput` | 201 view | `ScheduleError` |
| PATCH | `/schedules/:sid` | partial `ScheduleInput` | 200 view | `ScheduleError` |
| DELETE | `/schedules/:sid` | | 204 | 403 from a run, huddle agent, quick chat, the remote listener without Origin, or a program the daemon started; `ScheduleError` |
| GET | `/schedules/:sid/history` | | 200 `ScheduleHistoryEntry[]` | `ScheduleError` |
| POST | `/schedules/:sid/run` | body ignored | 200 `{entry, schedule}` | 403 huddle agent, 403 run from another board, 404 run ticket, `ScheduleError` |

Who may delete a schedule: a request replayed after a Telegram Confirm; with an `Origin`, the user-only check; without
one, a program on this Mac the daemon did not start (the user's own terminal or Claude).

Firing by itself (see "Work the board starts by itself" for when the daemon looks): a due one first gets its next `nextRunAt` saved, then fires: a ticket in `in_progress` (title with `{date}`/`{time}` filled
in, local time) and a `fired` history line with `trigger: "schedule"`, or `"missed"` when it was due over 90 s ago
(only one catch-up however many slots were missed). Paused ones never fire. With `skipIfRunning`, a fire while the
schedule's last ticket is `ready`, `in_progress` or running writes a `skipped` line instead. Fires and "run now" go one
at a time, so two "run now" calls at once give `fired` then `skipped`.

## Automations (loops)

Prefix `/api/profiles/:slug/loops`. Input fields (`LoopInput`, loops.ts): `name, enabled, service, passes, script,
everyMinutes, column, autoStart, askClaude, instructions, partOf`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/loops` | | 200 `LoopView[]` | |
| POST | `/loops/test` | `LoopInput` (script to try); user only when `passes` holds a key the script would get as a variable | 200 `LoopManager.test()` result | 403, `LoopError` |
| POST | `/loops` | `LoopInput`; user only | 201 `LoopView`; a first check starts in the background | 403, `LoopError` |
| PATCH | `/loops/:lid` | partial `LoopInput`; user only | 200 `LoopView`; a new script or switching it on starts a first check in the background | 403, `LoopError` |
| DELETE | `/loops/:lid` | user only | 204 | 403, `LoopError` |
| POST | `/loops/:lid/check` | user only | 200 `LoopView` after the check (a switched-off loop is not checked) | 403, `LoopError` |
| POST | `/loops/:lid/copy` | `{to}` (board slug); user only | 201 `LoopView` of the copy (switched off, nothing seen yet) | 403, `LoopError` |

`LoopView` is the saved `Loop` plus `state` (`ok`, `unsupported`, `needs_connection`, `script_changed`), `problems`,
`script` (the file's text now), `passViews`, and what the last check found: `seenCount`, `lastFound`, `lastItems`
(each `{id, title, link?, state, ticketId?, note?}`; `state` `new`, `added`, `waiting`, `skipped`, `first`, `seen`).
There is no separate history route: these fields and `lastCheckedAt`, `lastFiredAt`, `lastError` are the history.
The first check after a save or switching on only notes what is there (`first`, no tickets). A failed check sets
`lastError` and a wait (`backoffUntil` in the state file, 2 minutes doubling up to 30). The daemon's timer (see "Work the
board starts by itself") checks each switched-on loop at most every `everyMinutes` (less 5 s); `check` ignores both.

## Jobs (one-time)

Prefix `/api/profiles/:slug/jobs`. Input (`JobInput`): `name, at, action` (`JobAction`). The view is `Job` plus `when`.
Changes from `x-ckanban-run` are credited to that ticket.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/jobs` | query `ticketId?`, `finishedDays?` (1..365) | 200 job views | |
| GET | `/jobs/:jid` | | 200 job view | `JobError` |
| POST | `/jobs` | `JobInput` | 201 job view | 403 huddle agent, 403 run from another board, 404 run ticket, `JobError` |
| PATCH | `/jobs/:jid` | partial `JobInput` | 200 job view | same |
| POST | `/jobs/:jid/cancel` | body ignored | 200 job view | same |
| POST | `/jobs/:jid/run` | body ignored | 200 job view once it started: a ticket job is `done` with `result.ticketId`; a command job may still be `running` | same |

Only a `scheduled` job can be changed, cancelled or run: otherwise `409 {"error":"job <id> is <state>: only a
scheduled job can be changed"}`. `at` must be in the future (400). A PATCH `action` replaces the whole action.
Firing by itself (see "Work the board starts by itself"): a job seen over 10 minutes after its `at` is late: a ticket job still makes its ticket (its body starts with a "This was due ...
because the computer was off" paragraph); a command job is saved `skipped` (`result.message` "skipped: the computer
was off at <Tue 20 Oct 22:00>") unless `ifLate` is `"run"`. A command runs with `/bin/sh -c` in the board folder with
`CKANBAN_BOARD`, `CKANBAN_JOB`, `CKANBAN_SOURCE_TICKET`; its `result` is `{exitCode, durationMs, output, timedOut,
message?}` (`failed` with `message` "exited with code N" or "stopped after N s (time limit)").

## Work the board starts by itself: timers

Four timers look for due work: schedules (every 30 s), one-time jobs (30 s), automations (60 s) and follow-ups (30 s).
Each also looks once right at start, so work that came due while the daemon was off fires then (as `missed` for a
schedule, late for a job, `missedAt` for a follow-up over 12 hours late). There is no test clock: times are the real
clock. **Test hook:** `CKANBAN_TICK_MS` (a whole number of ms, 50 to 60000) sets all four periods, so tests see jobs
and schedules fire within a second of their time; unset or out of range, the periods above apply. It doesn't change
any limit: a job's `at` and a schedule's cron minute still decide when it is due, a follow-up is still at least 1
minute away, and an automation is still checked at most every `everyMinutes`. The daemon logs the period it uses.

## Team: presets, templates, squads, learned, notes

Prefix `/api/profiles/:slug`. Writes here refuse `x-ckanban-run` and `x-ckanban-huddle-agent` with 403. `scope` is
`"board"` (default) or `"global"`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/huddle-presets` | | 200 `Huddles.presets()` (built-in, global and board teammates) | |
| POST | `/huddle-presets` | preset fields plus `scope?` | 201 saved preset | 403, `HuddleError` |
| PUT | `/huddle-presets/:name` | preset fields plus `scope?` (name from the path) | 200 saved preset | 403, `HuddleError` |
| DELETE | `/huddle-presets/:name` | query `scope?` | 200 `{reset, presets}` (`reset: true` when a lower level still has it) | 403, 404 not at this level, 409 a built-in |
| GET | `/huddle-templates` | | 200 `Huddles.templates()` (squads) | |
| POST | `/huddle-templates` | template fields plus `scope?` | 201 | 403, `HuddleError` |
| PUT | `/huddle-templates/:name` | same | 200 | 403, `HuddleError` |
| DELETE | `/huddle-templates/:name` | query `scope?` | 200 `{reset, templates}` | 403, 404 not at this level, 409 a built-in |
| POST | `/squads` | `{squad, scope?, replace?, card?: {ticketId, uuid} \| {huddleId, learningId}}` | 201 `{squad, teammates, ...}`; a ticket card is marked saved | 403, 400 bad card, 404 card ticket, 409 name taken without `replace` |
| GET | `/learned` | query `count=1` | 200 `Learner.view()` `{saved, cleaned, watching, newCount, tidyAt}`, or `{newCount}` with `count=1` | |
| POST | `/learned/seen` | | 200 view (writes `learned/pile.json` `seen[<slug>]`, `newCount` 0) | 403, `LearnError` |
| POST | `/learned/changes/:id/undo` | | 200 result | 403, `LearnError` |
| POST | `/learned/changes/:id/redo` | | 200 result | 403, `LearnError` |
| POST | `/learned/lessons/:id/save` | | 200 result | 403, `LearnError` |
| POST | `/learned/lessons/:id/drop` | | 200 result | 403, `LearnError` |
| POST | `/learned/lessons/:id/keep` | | 200 result | 403, `LearnError` |
| GET | `/huddle-notes` | | 200 `{notes, cap}` | |
| PUT | `/huddle-notes/:role/:scope` | `{notes: [{text, by?, date?, huddle?}]}`; `scope` `general` (root `huddle-notes/<role>.md`) or `repo` (`profiles/<slug>/huddle-notes/<role>.md`) | 200 the saved list `{text, by, date, huddle}` (`by` defaults to `you`; a bad date or huddle id becomes null) | 403, 400 bad role, scope, empty note or notes not a list |

## Huddles

Prefix `/api/profiles/:slug/huddles`. The caller is never taken from the body: `x-ckanban-run` plus
`x-ckanban-huddle-agent` identify a participant, no header means the user (`@you`). `:hid` is resolved by
`Huddles.identify` (`HuddleError` 404/403 when unknown or not allowed). "User only" in this table means: refused with
403 when `x-ckanban-run` or `x-ckanban-huddle-agent` is present (no Origin or browser check here). Returned huddles
are `HuddleView` (huddle.ts); participant objects never include their `token`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| POST | `/huddles/auto` | `{reason?, trigger?, squad?\|template?, roster?, maxCostUsd?, topic?}`; only a run of the host ticket (no huddle header) | 202 `{waiting, template, huddle}` when waiting, else 201 | 403, `HuddleError` |
| GET | `/huddles` | query `ticket?`, `open=1` | 200 huddle list (`listSliced`) | |
| POST | `/huddles` | `{ticketId, roster?, squad?\|template?, maxParticipants?, maxCostUsd?, topic?, confirmParallel?}`; user only | 201 `HuddleView` | 403, 400 no ticketId, 409 with `confirm: "run-active"` (UI source only), `HuddleError` |
| GET | `/huddles/:hid` | query `before?`, `since?`, `limit?` | 200 `{huddle, you, ...messages page}` | `HuddleError` |
| POST | `/huddles/:hid/messages` | `{text, kind?: "finding", status?, reason?, lessons?}` | 201 posted message | `HuddleError` |
| PUT | `/huddles/:hid/brief` | `{text}` | 200 `HuddleView` | `HuddleError` |
| POST | `/huddles/:hid/status` | `{status, reason?, lessons?}` | 200 the caller's participant | `HuddleError` |
| POST | `/huddles/:hid/close-request` | `{reason?}` | 200 `HuddleView` | `HuddleError` |
| POST | `/huddles/:hid/participants` | participants to add | 201 `{added, huddle}` | `HuddleError` |
| PATCH | `/huddles/:hid/participants/:handle` | `{mode}` | 200 `HuddleView` | `HuddleError` |
| POST | `/huddles/:hid/participants/:handle/stop` | user only | 200 `HuddleView` | 403 |
| POST | `/huddles/:hid/participants/:handle/restart` | user only | 200 `HuddleView` | 403 |
| POST | `/huddles/:hid/participants/:handle/allow-changes` | | 200 the participant | `HuddleError` |
| GET | `/huddles/:hid/participants/:handle/session` | query `before?`, `since?`, `limit?`; user only | 200 `participantSession()` page | 403 |
| GET | `/huddles/:hid/participants/:handle/session/tool/:toolId` | user only | 200 tool detail | 403, 404 |
| POST | `/huddles/:hid/participants/:handle/session/reveal` | user only | 200 `{ok: true, file}` (shown in Finder) | 403, 404 no transcript |
| POST | `/huddles/:hid/stop` | user only | 200 `HuddleView` | 403 |
| POST | `/huddles/:hid/resume` | `{addBudgetUsd?}`; user only | 200 `HuddleView` | 403 |
| POST | `/huddles/:hid/close` | user only | 200 `HuddleView` | 403 |
| POST | `/huddles/:hid/seen` | `{seq}`; user only | 200 `HuddleView` | 403 |
| POST | `/huddles/:hid/teammates` | proposed teammate | 201 proposal | `HuddleError` |
| POST | `/huddles/:hid/squads` | proposed squad | 201 proposal | `HuddleError` |
| POST | `/huddles/:hid/generic-squad` | user only | 200 `{proposal, error, setup, costUsd}` | 403 |
| PATCH | `/huddles/:hid/learnings/:lid` | `{text?, scope?, target?, replace?}`; user only | 200 learning | 403, 400 invalid JSON |
| POST | `/huddles/:hid/learnings/:lid/save` | same body | 200 result | 403, 400 |
| POST | `/huddles/:hid/learnings/:lid/discard` | user only | 200 result | 403 |
| POST | `/huddles/:hid/invite` | `{ticketId, handle?}` | 201 the new participant | 400 no ticketId, `HuddleError` |
| POST | `/huddles/:hid/hand-ins` | `{summary?}` | 201 hand-in | `HuddleError` |
| POST | `/huddles/:hid/hand-ins/:handle/accept` | `{reason?}` | 200 review result | `HuddleError` |
| POST | `/huddles/:hid/hand-ins/:handle/reject` | `{reason?}` | 200 review result | `HuddleError` |
| POST | `/huddles/:hid/findings` | `{action?: "add"\|"resolve"\|"list", text?, id?}` | 200 findings result | `HuddleError` |

Details the contract tests check (`test/contract/huddle.test.ts`, `huddle-team.test.ts`):
- `:hid` may be `current`: a helper's own huddle, or a run's newest open huddle (preferring one it hosts); the user
  gets 400 `pass a huddle id`. A wrong helper token, or a helper header naming another huddle, is 403.
- `POST /huddles`: 400 no ticketId, bad roster or bad `maxCostUsd`; 404 unknown ticket or squad; 409 the ticket already
  has an open huddle.
- `POST /huddles/auto`: 403 also for a run that isn't the host ticket's unattended work run, and when auto huddles are
  off without a `## Review huddle` section; 400 no reason, bad trigger, no roster (except `asked` with a squad); 404
  unknown squad; 409 an open huddle or a second start in one run; `maxCostUsd` is capped at $100. Success sets the
  ticket's `autoHuddle {state: "live", reason, trigger, template, at, huddleId}` and adds an `ai` comment.
- `POST .../status`: 400 for the user, a bad status, blocked without a reason, lessons with a status other than done
  or from a non-helper; 409 the participant was stopped.
- `POST .../close-request`: only @main or a lead (403); 409 until `outputs/huddles/<hid>/summary.md` exists in the host
  ticket's folder; sets `closeRequest {by, at, reason}` (a trailing full stop dropped) and tags @you; an auto
  huddle's @main closes it at once.
- Close writes `outputs/huddles/<hid>/summary.md` in the host ticket's folder: the board writes it at once when the
  host can't run (no session yet, or Done), otherwise @main is asked for it.
- Participants: POST by the user, @main or a lead (403 otherwise), 400 bad entry, 409 full; PATCH `{mode}` by the user
  for anyone, a helper only for itself (403), 404 unknown, 400 bad mode; `restart` 409 unless stopped or failed, or
  when the huddle is closed.
- `invite`: the user or @main only (403); 404 unknown ticket; 409 already in it or full. The handle is `<planKey or
  first word of the title>-main`, lower-cased, with `-2`, `-3`... when taken; the invited ticket's run posts as it.
- `seen`: 400 when `seq` isn't a number; the cursor never moves past the last message.
- `POST .../teammates`: helpers only (400 otherwise); 400 invalid or no `why`, or 2 already waiting from this helper;
  201 learning `{id: "l<n>", from, status: "pending", scope: "general", target: "new", teammate}`. Learnings PATCH and
  save: 400 bad scope or a `target` on a teammate or squad proposal; 404 unknown; 409 already saved or discarded;
  saving a teammate with scope `repo` writes the board's presets, `general` the global ones.

## Tickets: list, create, read, change, delete

Prefix `/api/profiles/:slug/tickets`. Ticket ids look like `t_...`. A route with `:id` answers
`404 {"error":"ticket <id> not found"}` first.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/tickets` | query `scope`, see below | 200 | 400 bad scope or status |
| POST | `/tickets` | see below | 201 `TicketView` plus `gather?`, `planPaused?`, `note?` | 400, 403, 409 |
| GET | `/tickets/:id` | | 200 `TicketView` | 404 |
| PATCH | `/tickets/:id` | see below | 200 `TicketView` (plus `selfMove` for a self move) | 400, 403, 409 (with `confirm` for UI source) |
| DELETE | `/tickets/:id` | | 204 | 403 from a run (except a main ticket deleting its own tool ticket), 409 merge running or delete failed |

**GET scopes.**
- none: every ticket as a JSON array of `TicketView` (old clients).
- `scope=count`: `countScope()` counts per column.
- `scope=list`: query `status?` (one of `STATUSES`), `tool=1`, `q`, `tags` (comma list), `limit`, `after`; 200
  `listScope()` page with `tickets: TicketView[]`. Without `status` only open tickets; tool tickets (tasks without a
  card) only with `tool=1`.
- `scope=board`: query `done` (how many Done), `ids` (comma list), `after`.
- `scope=done`: query `offset`, `limit` (default `DONE_PAGE`), `after`.
- `scope=search`: query `q`, `tags`; searches Done tickets only.
- `scope=ids`: query `ids`.
- board, done, search and ids answer `{tickets: TicketView[], doneTotal, doneHead?}`.

**POST body.** `title` (required), `body`, `status` (one of `STATUSES`, default `backlog`), `mode` (`auto` or
`interview`, default interview), `parentId`, `planKey`, `dependsOn: string[]`, `needs: string[]`, `tags: string[]`,
`partOf`, `important`, `kind` (`TICKET_KINDS`), `model`, `effort`, `main: boolean` (the user's own new ticket, with no run header, `parentId`, `partOf` or `sessionId`, is a main ticket even with `main: false`), `gather: {id, group}[]` (only with
`main: true`), `newGroup`, `sessionId` (link an existing Claude session). Rules: `main: true` from a run
needs a run answering the user's typed message (else 403) and refuses `parentId` and `sessionId` (400). A main
ticket's (or tool group's) run adds tool tickets to its own family (400 unknown dependency). `parentId` from anyone
else is 400: planned tickets are retired. From a run, an unsuitable
`partOf` is replaced and explained in `note`. Starting statuses from another ticket's run are checked for loops (409).

**PATCH body.** Any of: `status`, `title`, `body`, `expectedBody`, `mode`, `order`, `notice: null`, `dependsOn`,
`needs`, `tags`, `suggestedTags`, `parentId: null` (only clearing), `partOf` (id or null), `parentSuggestion: null`,
`showOnBoard`, `important`, `pinned`, `runCapUsd` (user only), `model`, `effort`, `ultracode` (user only), `chrome`,
`browsers` (user only), `confirmParallel`. Notes:
- The ticket's own run (header equals `<slug>/<id>`, no huddle header) may set only `important` and `suggestedTags`,
  and may send `{status}` with `done`, `backlog` or `ready` when the user asked in the chat; that answers
  `TicketView` plus `selfMove` and the move happens after the reply.
- A run moving another ticket to `done` gets 409 while it runs or has unsaved changes.
- Moving to `ready`/`in_progress` while a user huddle is live: 409 with `confirm: "huddle-open"` (UI source only).

## Ticket chat, runs and conversation

Prefix `/api/profiles/:slug/tickets/:id`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| POST | `/chat` | `{text, fresh?}` | 202 `TicketView` (while a run works, the message is in `queued` and steers it; `/model` and `/effort` only set the ticket and its `notice`) | 400 no text, 403 run rights, 409 loop or conflict, 500 other refusals (see Quirks) |
| POST | `/queued/:msgId` | body ignored | 202 `TicketView` (sends a queued message now) | 404, 409 |
| PATCH | `/queued/:msgId` | `{text}` | 200 `TicketView` | 400, 404, 409 |
| DELETE | `/queued/:msgId` | | 200 `TicketView` | 404, 409 |
| POST | `/stop` | body ignored | 200 `{stopped}`; the user's Stop on a main ticket gives `{stopped, tools}` | 403 run rights |
| GET | `/context` | | 200 cached context usage | |
| POST | `/context` | user only | 200 fresh context usage | 403, 409 |
| GET | `/activity` | query `before` (byte offset) | 200 `{entries: ActivityEntry[], before}` | 400 bad offset |
| GET | `/conversation` | query `limit` (1..500, default 100), `before` | 200 `{entries: SessionEntry[], start, total, title}` | |
| GET | `/tool/:toolUseId` | | 200 tool call detail (current and earlier sessions) | 404 |
| GET | `/agent/:toolUseId` | | 200 subagent detail | 404 |
| GET | `/workflow/:toolUseId/script` | | 200 `{script}` | 404 |
| GET | `/workflow/:toolUseId/agent/:agentId` | | 200 helper agent detail | 404 |
| POST | `/workflow/:toolUseId/stop` | | 200 `stopWorkflow()` result | 403 run header, 400 not started or not running |
| GET | `/comments` | query `last?`, `before?` | no `last`: 200 `Comment[]`; with `last`: 200 `{comments, earlier, total}` (max 500) | |
| POST | `/comments` | `{text}` | 201 the new `Comment` | 400, 403 run rights |
| GET | `/commands` | | 200 the `/` commands available in this ticket's chat: `{name, kind, source, description}` (built-ins, the project's `.claude/commands`, skills); `local` and `hidden` are not sent | |
| GET | `/rewind` | query `uuid` | 200 `{blocked, ...previewRewind()}` | 403 run header, 404 not rewindable |
| POST | `/rewind` | `{uuid, files?}` (files default true) | 200 `{text, restored, messages, files, undo: true, filesSaved}` | 403, 404, 409 blocked |
| GET | `/rewind-undo` | query `files=0` | 200 `{available, blocked, messages, files, filesSaved}` | 403 run header |
| POST | `/rewind-undo` | `{files?}`; user only | 200 `undoRewind()` result | 403, 409 |
| POST | `/fork` | `{uuid}`; user only | 201 `{id, text, ticket: TicketView, warning}` | 403, 404, 400, 409 |
| POST | `/fresh-chat` | | 200 `TicketView` | 403 run header, 400, 409 |
| POST | `/fresh-session` | | 200 `{ticket, external: false}` | 403 run header, 400, 409 |
| POST | `/take-over` | | 200 `{ticket, external}` | 403 run header, 400, 409 |
| POST | `/link-session` | `{sessionId}` (falsy unlinks) | 200 `TicketView` | 400 |
| POST | `/setup` | | 200 `Board.runSetup()` result | 403 run of another ticket |
| POST | `/planning-command` | | 200 `{command}` | 400 |
| GET | `/simplified` | | 200 saved simplified replies | |
| POST | `/simplify` | `{uuid}` | 200 simplified reply | 403 run header, 404, `SimplifyError` |
| GET | `/help` | | 200 `{cards, busy, recap}` | |
| POST | `/help` | `{kind}` (one of `HELP_KINDS`) | 200 `Helper.ask()` result | 403 run header, 400 kind or nothing to explain, `HelpError` |
| GET | `/usage` | | 200 `ticketUsage()` result (runs, windows, teammates, side spend) | |

## Ticket cards, family, plans and work

Prefix `/api/profiles/:slug/tickets/:id`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| PUT | `/automation-cards/:uuid` | `{loopId}`; user only | 200 `TicketView` | 403, 400 unknown loop |
| POST | `/key-cards/:uuid` | `{keys: {NAME: value}}` or `{self: true}`; user only | 202 `TicketView` | 403, 409 in flight or already answered or saved but not delivered, 404 box gone, 400 no key |
| PUT | `/squad-cards/:uuid` | `{state: "saved"\|"dismissed", name?, scope?}` | 200 `TicketView` | 403 run/huddle header, 400 |
| PUT | `/teammate-cards/:uuid` | `{state: "saved"\|"dismissed", name?, scope?}` | 200 `TicketView` | 403 run/huddle header, 400 |
| PUT | `/closed-forms/:uuid` | body ignored; user only | 200 `TicketView` with `closedForms[uuid] = {at, by: "user", run}`; closing it again answers 200 unchanged | 403, 400 bad id, 409 a run works or the id isn't the open form, 404 unknown ticket |
| PUT | `/schedule-delete-cards/:uuid` | `{state: "deleted"\|"kept", scheduleId?}`; user only | 200 `TicketView` | 403, 400, 409 already answered, 404 schedule gone |
| PUT | `/helper-rule-cards/:uuid` | `{state: "added"\|"dismissed", text?}`; user only | 200 `TicketView` | 403, 400, 404, 409 text changed or already answered or list full, 503 helper |
| GET | `/family` | | 200 rows `{id, title, status, depth, how, parent, subFeature?/task?/showOnBoard?, sessionId, resumeCommand, prUrl, updatedAt, result}` | |
| GET | `/family-view` | | 200 rows `{id, depth, parent, subFeature?, tasks?, model, effort, costUsd, needsYou, summary, finishedAt, report}` | |
| GET | `/status` | | 200 `{topId, title, feature, saved, facts, sections, path}` | |
| POST | `/status` | any `STATUS_FIELDS` (text or null), `prNotes: {url: note}`, `prs: string[]` (GitHub PR URLs) | 200 same plus `markdown` | 403 huddle or not in the family, 400 nothing to update or bad values |
| POST | `/status/notes` | `{text}` | 200 status shape | 403 run/huddle header, 400 |
| POST | `/own-work` | | 200 `TicketView` | 403 run without the user's message, 400 |
| POST | `/gather` | `{tickets: {id, group?}[], newGroup?, hide?}` | 200 `{gathered, movedUp, skipped, group, kept}` | 403, 400 |
| POST | `/plan` | `{action: "start"\|"pause"\|"resume"\|"done"}` | 200 `TicketView` | 403 run rules, 400 (start/resume on a ticket that is neither a main ticket nor a tool group) |
| POST | `/ask` | `{target, question}`; only the run of this ticket | 202 `{message}` | 403, 404 target, 400 |
| POST | `/merge-into-main` | only the tool ticket's own run | 200 `{message}` | 403, 409 |
| POST | `/land` | `{summary}`; the main ticket's own run or the user | 200 `{message}` | 403, 409 |
| POST | `/branch` | | 201 `{ticket: TicketView, warning}` | 403 run header, 400, 409 |
| POST | `/move` | `{board}` | 201 `TicketView` on the target board | 403 run header, 404 board, 400 |
| POST | `/follow-up-work` | `{title, body, start?, important?}` | 201 `TicketView` of the new work | 403 run header, 400 (also on a main ticket: its own plan adds steps) |
| POST | `/follow-up` | `{after?, at?, note?, cancelOnReply?}` | 201 `TicketView` | 403 run of another ticket, 400 |
| POST | `/follow-up/now` | body ignored; user only (no run header) | 202 `TicketView` | 403, 400 |
| DELETE | `/follow-up` | `{reason?}` (optional body) | 200 `TicketView` | 403, 400 |
| POST | `/snooze` | `{hours?}` (default `SNOOZE_MS`, 0..720) or `{forever: true}` | 200 `TicketView` | 403 run header, 400 hours, 409 nothing to snooze |
| DELETE | `/snooze` | | 200 `TicketView` | 403 run header |
| POST | `/seen` | body ignored | 200 `TicketView` | 403 run header |
| POST | `/devices` | `{action: "take"\|"release", names, waitMs?}`; only this ticket's own run | 200 take result (with `usedBy` titles when not ok) or `{released}` | 403, 400, `DeviceError` |
| POST | `/notify` | `{message, urgent?, why?}`; only this ticket's own run | 200 `Notifier.message()` result | 403, 400, `MessageError` |
| POST | `/cap-continue` | `{addUsd}` | 202 `TicketView` | 403 run header, 400, 409 |
| POST | `/stall` | `{action: "stop"\|"wait"\|"restart"}` | 200 `TicketView` | 403 run header, 400, 409 |
| POST | `/limit` | `{action: "continue"}` or `{auto: boolean}` | 202 `TicketView` for continue, 200 for auto | 403 run header, 400, 409 |
| POST | `/check-pr` | | 200 `{state, ticket}` | |
| POST | `/pr/refresh` | `{force?}` | 200 `{pr, ticket}` | `PrError`, 502 |
| POST | `/pr/send-failures` | | 202 `TicketView` | 403 run header, `PrError`, 409, 502 |
| POST | `/pr/resolve-conflicts` | | 202 `TicketView` | same |
| POST | `/pr/merge` | | 200 `TicketView` | same |

## Ticket files and outputs

Prefix `/api/profiles/:slug/tickets/:id`.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/outputs` | | 200 `OutputFile[]` | |
| GET | `/outputs/:path*` | query `download=1` | 200 file bytes: raster images with their type, everything else `text/plain`; `nosniff`, `content-security-policy: sandbox` | 404 |
| POST | `/outputs/:path*` | query `action=reveal\|copy\|publish`, body ignored | 200 `{ok: true}`; publish 202 share job `{file, state, error?, at}` | 403 run header, 404, 400 action, 409 already publishing, `ShareError` |
| POST | `/find-files` | `{paths: string[]}` (max 200) | 200 `{found: {path: {root, rel}}}` | |
| GET | `/file` | query `path`, `raw=1`, `download=1` | 200 `{...readFileForView(), root, dir}`, or raw bytes as for outputs | 404, `FileError` |
| GET | `/diff` | query `w=1` (ignore whitespace) | 200 `TicketDiff` (diff.ts) | 404 no version history, `DiffError` |

## Not detailed

- Response bodies of manager methods (`McpState`, `PassView`, `LoopView`, `HuddleView`, `QuickChatView`,
  `SessionEntry`, `RemoteStatus`, `TicketDiff`, usage, helper status, notifier state, push results, learner view,
  context usage, family status `facts`/`sections`) are named, not expanded: they are large and live in their own
  modules, which a port reads directly.
- Request bodies passed whole to a manager (MCP server definitions, snippets, pass creation, huddle presets, templates,
  roster entries, helper and notification settings patches, board browser `input`) are named by method only, for the
  same reason.
- Front desk hold rules (`heldKind` in `helper/frontdesk.ts`): which requests are held is that module's logic.
- Static web UI serving: not an API.

## Quirks

- `GET /api/cron/preview` answers 200 with `valid: false` and an `error` field for a bad or empty expression.
- `POST /api/huddles/:hid/generic-squad` always answers 200, with any failure in its `error` field.
- `POST /api/bug-report` answers 201 when an issue was filed and 200 otherwise (the result says why).
- `PATCH /api/profiles/:slug` doesn't check `path` (a missing folder is saved) or `name` (an empty name is saved);
  only `POST` checks them.
- `DELETE .../follow-up` answers 200 also when there is no follow-up to stop.
- Status codes for similar actions differ: `POST .../chat`, `queued` POST, `key-cards`, `follow-up/now`,
  `cap-continue`, `limit` continue, `pr/send-failures` and `pr/resolve-conflicts` answer 202; `pr/merge`, `stall`,
  `limit` auto, `plan` answer 200; `ask` answers 202; `move`, `branch`, `follow-up-work` and `follow-up` (set) answer
  201. `POST /api/mcp/refresh` and `/api/mcp/:name/login` answer 202.
- Deletes are inconsistent: profiles, snippets, passes, loops, schedules, quick chats and tickets answer 204; MCP
  servers, devices, browsers, avatars, presets, templates, helper feedback lines, snooze and follow-up answer 200 with
  a body.
- POST, PATCH and PUT routes that read no body still need `content-type: application/json`, or they get 415.
- The JSON content-type rule runs after the attachments routes but before everything else, so a non-JSON POST to an
  unknown path gets 415, not 404.
- Many routes don't check the number of path segments: `/api/claude/projects/x`, `/api/claude/defaults/x`,
  `/api/pick-folder/x`, `/api/events/x`, `/api/version/x`, `/api/usage/x`, `/api/spend/x`, `/api/team-usage/x`,
  `/api/health/x`, `/api/inbox/x`, `/api/notify/test/x`, `/api/push/<anything>/...`, `/api/debug/profile/x`, and ticket
  actions such as `.../tickets/:id/activity/x`, `/family/x`, `/seen/x`, `/chat/x`, `/move/x`, `/stop/x`, `/plan/x`,
  `/comments/x` answer as if the extra segments weren't there.
- `POST /api/bug-report/x` answers 404 only after the draft is built (and a run log may be decompressed).
- In `/api/board-browsers`, the user-only check runs before the method and shape are matched, so any non-GET or
  non-`ensure` request from a run gets 403 even when the route doesn't exist. The same holds for `/api/passes/:id/...`
  (user-only before the 404), `/loops/...` (except list and test) and non-GET `/api/helper/...`.
- A device take's `place` is the request's position in the one waiting line shared by all devices, so requests for
  other devices count too: two tickets each waiting for a different device are told 1 and 2.
- `/api/notify` POST reads the body before the user-only check: invalid JSON gives 400 even for a refused caller.
- `PUT /api/avatars/claude/name` only matches with PUT; other methods on that path fall through to 404.
- `/api/telegram/front-desk/file` reads its body without the JSON content-type rule (it is answered before that check).
- `POST /api/profiles` with a JSON body of `null` throws a TypeError and answers 500 instead of 400; the same for
  `POST /api/bug-report`, `POST .../tickets` and other routes that read `b.<field>` without a null guard.
- `GET /api/passes/oauth/callback` answers HTML, not JSON, for both success and service errors; only the remote
  listener refusal is JSON.
- The user-only check in huddle routes is only "no run or huddle header"; elsewhere it also needs an `Origin` and a
  browser peer.
- `GET /api/profiles/:slug/chats/:cid/context` and `GET /api/profiles/:slug/tickets/:id/context` need no user check,
  while their POSTs do.
- `GET .../tickets/:id/rewind` and `GET .../rewind-undo` refuse `x-ckanban-run` (403) even though they only read.
- `POST .../tickets/:id/chat` answers 500 (with the reason in `error`) for refusals the board raises as plain errors: a
  refused command (`/clear`, `/resume`, `/exit`, `/quit`), a bad `/model` or `/effort` value, a corrupt ticket file.
- A conversation entry's `uuid` is its transcript line's `uuid`, or its position in the conversation (`"0"`, `"1"`...)
  when the line has none; rewind and fork need real uuids.
- `POST .../tickets/:id/queued/:msgId` with an unknown message answers 404 from any other error too (all non-conflict
  errors map to 404).
- `DELETE .../follow-up` reads an optional JSON body; a bad body is ignored.
- `huddles/:hid/learnings/:lid` PATCH and save parse the body by hand: an empty body is allowed (treated as `{}`).
- Ticket `GET` without `scope` returns every ticket on the board (about 13 MB on a 10,000 ticket board); it is kept
  for old clients.
- The `x-ckanban-source` header only matters for the 409 "confirm" checks and huddle message source; a run that also
  sends `x-ckanban-run` never gets the confirm 409.
- A front desk request held for Confirm answers 202 `{confirmation}` instead of the route's own result.
- `/api/mcp/...` and `/api/agents/...` have no user-only or run check: a board run may add, change, move or remove
  MCP servers (including a stdio command later runs start) and read a server's unmasked settings with
  `GET /api/mcp/:name/config` (secret masking covers saved keys and passes only).
- `POST /api/profiles/:slug/loops/test` is not user only, and the masking of its answer replaces exact saved values
  only: a script that changes the value (reverses it, say) returns it readable.
- `POST /api/bug-report` and `/draft` answers are masked, but the issue body and title sent to `gh issue create` are
  only scrubbed for home and data folder paths and token-like patterns: a saved key's value in the description or the
  ticket's text goes to GitHub as is.
- Saved key values are masked in answers, but a ticket's `ticket.md` keeps a pasted value as it was written (comments
  are masked when saved).
- On the phone access listener the user-only check passes for any caller with the tailnet Host and the owner's login;
  both are in `remote.json`, so a local program can pose as the user while phone access is on (t_20261115_v0ip).
