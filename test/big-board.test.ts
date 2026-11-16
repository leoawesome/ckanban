// The big-board freeze check (test/support/big-board.ts): the daemon's regular jobs on a 10,000-ticket board.
//
// It is opt-in: building that board writes tens of thousands of temp files, which made every full run minutes slower
// on a busy Mac (several suites at once, security software scanning each file), while only changes to daemon jobs that
// go over every ticket, chat or log can fail it. Run it with `bun run test --big-board` (or CKANBAN_BIG_BOARD=1)
// when such a job is added or changed.
import { test } from "bun:test";

if (process.env.CKANBAN_BIG_BOARD === "1") await import("./support/big-board");
else test.skip("big-board freeze check (opt-in: bun run test --big-board)", () => {});
