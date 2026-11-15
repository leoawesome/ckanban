# usage

What runs cost and how close the account is to its limits: plan usage from Anthropic (`usage.ts`, the main entry, with its cache `usage-cache.ts`), today's spend across boards, side calls and the helper (`spend.ts`), usage-limit waits and auto-continue (`limit.ts`), and per-ticket token and cost totals (`ticket-usage.ts`).
Depends on `core/` and `runs/` (side-call spend files, run logs); `limit.ts` uses the `Board` type from `src/server/board.ts` (type only).
Unit tests sit next to the file they test (`*.test.ts`).
