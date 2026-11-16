// Child of test/rust-board-gate-fixtures.test.ts: nextRuns for the cases on stdin, in the time zone of its TZ (set
// by the parent, so the parent's own tests keep theirs). Prints one JSON array of answers.
import { nextRuns, parseCron } from "../../src/schedules/cron";

const cases: { expr: string; after: string; n: number }[] = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(cases.map((c) => nextRuns(parseCron(c.expr), new Date(c.after), c.n).map((d) => d.toISOString()))));
