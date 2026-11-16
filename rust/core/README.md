# ckanban-core

The Rust port's library: plan usage (`GET /api/usage`) and today's spend (`GET /api/spend`), and the data folder
(every saved file of `contracts/data-files.md`, read and written byte for byte like Bun; nothing wired to routes yet). It has no HTTP
server and no proxy: the `ckanban-rs` front server in `rust/` calls it (`src/routes.rs`), as a member of that workspace. Every answer is a
`serde_json::Value` with Bun's keys, key order and number formatting, so the server sends it as is.

## What it matches in `src/`

| Rust | Bun |
| --- | --- |
| `home.rs` (`DataDir`, `Profile`) | `defaultRoot()`, profile and ticket paths, `listProfiles`/`getProfile` in `src/core/store.ts` |
| `atomic.rs` | `atomicWrite` in `src/core/atomic.ts` (`<file>.tmp-<8 chars>`, then rename) |
| `record.rs` (`JsonRecord`) | `JSON.parse` + rewrite: fields Rust doesn't know stay, in place |
| `usage.rs` (`UsageClient`) | `src/usage/usage.ts`: credentials (keychain unless `CKANBAN_NO_KEYCHAIN=1`, then `$CLAUDE_CONFIG_DIR/.credentials.json`), `CKANBAN_USAGE_URL`, the async request (reqwest, 10 s timeout) |
| `usage_cache.rs` (`UsageCache`) | `src/usage/usage-cache.ts`: 4 min reuse, 1 min gap, 429 backoff, `usage-last.json` in Bun's exact format |
| `usage_windows.rs` | `recordWindow` in `src/usage/ticket-usage.ts` (`usage-windows.json`) |
| `spend.rs` (`SpendIndex`) | `SpendIndex.today()`/`recent()` in `src/usage/spend.ts`, `readSideSpend` in `src/runs/side-call.ts`, compressed logs from `src/runs/run-log.ts` |
| `time.rs`, `jsnum.rs` | `toISOString`, `Date.parse`, `dayKey`, and how `JSON.stringify` writes numbers |
| `jskeys.rs` | JavaScript's key order: index keys (`"1"`, `"42"`) first in number order, then insertion order |
| `datafile.rs` | Each JSON file's format (`formats::*`: pretty or compact, final newline, atomic / fixed `.tmp` / plain, `0600`), `read_json`, `write_json` |
| `jsonl.rs` | `appendFileSync` of one line, `readJsonl`, `readJsonlPage` (pages from the end, plain or `.gz` run log), the huddle log's read-since-offset |
| `yaml_write.rs`, `yaml_read.rs` | `YAML.stringify` / `YAML.parse` of the `yaml` package (v2, core schema), for ticket front matter |
| `ticket.rs` | `parseTicket`, `serializeTicket`, `withoutAddOn`, `createTicket`'s field order, `updateTicket`'s merge, the corrupt-ticket placeholder |
| `layout.rs` | Every data file's path, the id checks, `newTicketId` |
| `json_dir.rs` (`JsonDir`) | `src/core/json-dir.ts`: a folder of JSON files cached by mtime and size, live entries re-stat'ed |

How the server uses it: `UsageCache::for_daemon(&DataDir::from_env(), UsageClient::from_env())` and
`cache.get(fresh).await` for `/api/usage` (always 200); `Arc::new(SpendIndex::new(DataDir::from_env()))` and
`index.recent().await?.to_json()` for `/api/spend` (an error means `profiles/` is missing, a 500 in Bun too).

## The data folder

Values are `serde_json::Value` in Bun's key order with JS number text, so fields Rust doesn't know survive a rewrite
in place. Everything is plain blocking file work: a server runs it with `spawn_blocking` (or a background thread)
instead of Bun's `pauser()` slices. Left to the areas that need them: masking saved keys before an append
(`maskSaved`), a board's ticket listing and its order (`entryOrder`), restoring and compressing run logs, the
activity and schedule history digests, and the Claude session change feed.

## Sharing the data folder with Bun

- Spend: Rust only reads spend files, never writes them.
- Usage: `usage-last.json` is written by atomic rename in Bun's format, and both sides read it again when its size or
  change time moves. A check either side made counts for both (the minute gap, the 4 minute reuse and the 429
  wait), so running both never asks Anthropic more often than Bun alone.

## Testing

```sh
cd rust && ~/.cargo/bin/cargo test   # the whole workspace (or -p ckanban-core)
```

`tests/fixtures/` holds inputs with Bun's answers in `expect` (usage bodies, logins, HTTP replies, cache scenarios
with a fake clock, a whole data folder for spend). `tests/fixtures.rs` checks Rust gives the same JSON;
`test/rust-fixtures.test.ts` (part of `bun run test`) checks Bun still does. After a deliberate change to Bun's usage
or spend code, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-fixtures.test.ts`, then make `cargo test` pass again.

`tests/fixtures/data/` is the same for the data folder: `yaml.json` (YAML cases, many of them random, with Bun's
output) and `home/` (a data folder written by Bun's Store and writers). `tests/data.rs` checks Rust parses and writes
them back byte for byte; `test/rust-data-fixtures.test.ts` checks Bun still writes those bytes (update with
`UPDATE_RUST_FIXTURES=1 bun test test/rust-data-fixtures.test.ts`). To check a real data folder, read only:
`CKANBAN_PARITY_HOME=~/.claude-kanban cargo test -p ckanban-core --test data -- --ignored --nocapture`.

## Known gaps (edge cases Bun handles by accident)

- `Date.parse` covers ISO 8601 and HTTP dates, not every legacy form V8 accepts.
- A board whose `profile.json` has no `slug` is skipped (Bun would throw); a non-number in `spend-days.json` counts
  as 0 (Bun would concatenate strings).
- Logs are summed in the order the OS lists folders, as in Bun; a different order would only move the last digits.
