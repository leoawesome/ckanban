# ckanban-core

The Rust port trial's library for plan usage (`GET /api/usage`) and today's spend (`GET /api/spend`). It has no HTTP
server and no proxy: the `ckanban-rs` front server calls it (step 3b of the trial). Every answer is a
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

Wiring it into a server (3b): `UsageCache::for_daemon(&DataDir::from_env(), UsageClient::from_env())` and
`cache.get(fresh).await` for `/api/usage` (always 200); `Arc::new(SpendIndex::new(DataDir::from_env()))` and
`index.recent().await?.to_json()` for `/api/spend` (an error means `profiles/` is missing, a 500 in Bun too).

## Sharing the data folder with Bun

- Spend: Rust only reads spend files, never writes them.
- Usage: `usage-last.json` is written by atomic rename in Bun's format, and both sides read it again when its size or
  change time moves. A check either side made counts for both (the minute gap, the 4 minute reuse and the 429
  wait), so running both never asks Anthropic more often than Bun alone.

## Testing

```sh
cd rust/core && ~/.cargo/bin/cargo test
```

`tests/fixtures/` holds inputs with Bun's answers in `expect` (usage bodies, logins, HTTP replies, cache scenarios
with a fake clock, a whole data folder for spend). `tests/fixtures.rs` checks Rust gives the same JSON;
`test/rust-fixtures.test.ts` (part of `bun run test`) checks Bun still does. After a deliberate change to Bun's usage
or spend code, run `UPDATE_RUST_FIXTURES=1 bun test test/rust-fixtures.test.ts`, then make `cargo test` pass again.

## Known gaps (edge cases Bun handles by accident)

- `Date.parse` covers ISO 8601 and HTTP dates, not every legacy form V8 accepts.
- A board whose `profile.json` has no `slug` is skipped (Bun would throw); a non-number in `spend-days.json` counts
  as 0 (Bun would concatenate strings).
- Logs are summed in the order the OS lists folders, as in Bun; a different order would only move the last digits.
