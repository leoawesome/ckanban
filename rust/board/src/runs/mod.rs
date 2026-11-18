//! R3: the run engine, a library the run loop (R7a) calls. Ports of `src/runs/`:
//!
//! | Rust | Bun | What |
//! | --- | --- | --- |
//! | `runner` | `runner.ts` | `build_args`, `control_response`, `start_run` → `RunHandle` (send, stop_task, end_when_idle, keep_waiting, stop, wait) |
//! | `claude` | `claude.ts` | Claude's projects and sessions, defaults, live sessions, `find_claude` |
//! | `side_call` | `side-call.ts` | one-shot `claude -p` answers and the ticket's side ledger |
//! | `result` | `result.ts` | the `CKANBAN_RESULT:` line |
//! | `retry` | `retry.ts` (+ `isLimitText`, `limitMessage` of `usage/limit.ts`) | passing API errors, the usage limit |
//! | `activity` | `activity.ts` | one plain line per event, the final text |
//! | `activity_digest` | `activity-digest.ts` | per-log digest read incrementally |
//! | `run_log` | `run-log.ts` | plain or compressed logs, restore, settle, `append_line` under the log's lock |
//! | `run_log_compress` | `run-log-compress.ts` | compressing old Done logs, report-only with `CKANBAN_RUST_DELETE=0` |
//! | `connectors` | `connectors.ts` | unused tools, claude.ai connectors |
//! | `model_versions` | `model-versions.ts` | versions learned from init events |
//! | `awake` | `awake.ts` | `caffeinate` while there is work |
//! | `live_cut` | `live-cut.ts` | `LiveCut`, the event stream's `ActivityCut` |
//! | `js` | (JavaScript itself) | UTF-16 lengths, `trim`, `Number`, `String`, `JSON.parse`/`stringify` as JS does them |

pub mod activity;
pub mod activity_digest;
pub mod awake;
pub mod claude;
pub mod connectors;
pub mod js;
pub mod live_cut;
pub mod model_versions;
pub mod result;
pub mod retry;
pub mod run_log;
pub mod run_log_compress;
pub mod run_temp;
pub mod runner;
pub mod side_call;
