// A run log's digest (changed files, runs, session totals) read only as far as the log grew, matches reading it whole.
import { expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityDigests } from "../src/server/activity-digest";
import { readFileSync } from "node:fs";
import { ticketRuns } from "../src/server/ticket-usage";
import { tempDir } from "./helpers";

const L = (run: number, event: unknown) => JSON.stringify({ run, at: `2026-10-01T00:00:${String(run).padStart(2, "0")}.000Z`, event }) + "\n";
const edit = (run: number, file: string) => L(run, { type: "assistant", message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Edit", input: { file_path: file } }] } });
const result = (run: number, sid: string, total: number) => L(run, { type: "result", session_id: sid, total_cost_usd: total, usage: { input_tokens: 10, output_tokens: 2 } });

test("the digest gives the same runs and edited files as the whole log, and reads appended parts as they come", async () => {
  const file = join(tempDir("ck-digest-"), "activity.jsonl");
  writeFileSync(file, [
    L(1, { type: "system", subtype: "init", permissionMode: "plan" }),
    L(1, { type: "user", message: { content: "x".repeat(3000) } }),
    result(1, "s1", 0.5),
    // An old log without markers: a new run number starts a run.
    L(2, { type: "user", message: { content: "hi" } }),
    edit(2, "/p/a.ts"),
    result(2, "s1", 0.8),
    L(3, { type: "ckanban_run", kind: "follow-up" }),
    L(3, { type: "system", subtype: "init" }),
    edit(3, "/p/b.ts"),
    result(3, "s2", 0.2),
  ].join(""));
  const digests = new ActivityDigests();
  const whole = () => readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  let d = await digests.get(file);
  expect(ticketRuns(d.runEntries)).toEqual(ticketRuns(whole()));
  expect([...d.edited]).toEqual(["/p/a.ts", "/p/b.ts"]);
  expect(d.sessionTotals.get("s1")).toEqual([0.5, 0.8]);
  // Appended, with a line still being written at the end.
  const tail = result(4, "s2", 0.9);
  appendFileSync(file, L(4, { type: "ckanban_run", kind: "run" }) + edit(4, "/p/c.ts") + edit(4, "/p/a.ts") + tail.slice(0, 20));
  d = digests.getNow(file);
  expect([...d.edited]).toEqual(["/p/a.ts", "/p/b.ts", "/p/c.ts"]);
  expect(ticketRuns(d.runEntries)).toEqual(ticketRuns(whole().filter(Boolean)));
  appendFileSync(file, tail.slice(20));
  d = digests.getNow(file);
  expect(ticketRuns(d.runEntries)).toEqual(ticketRuns(whole()));
  expect(d.sessionTotals.get("s2")).toEqual([0.2, 0.9]);
  // Replaced by a shorter file: read again from the start.
  writeFileSync(file, edit(1, "/p/z.ts"));
  expect([...digests.getNow(file).edited]).toEqual(["/p/z.ts"]);
});

test("a big log is read in slices", async () => {
  const file = join(tempDir("ck-digest-"), "activity.jsonl");
  writeFileSync(file, Array.from({ length: 3000 }, (_, i) => (i % 100 ? L(1, { type: "user", message: { content: "y".repeat(1000) } }) : edit(1, `/p/${i}.ts`))).join(""));
  let pauses = 0;
  const d = await new ActivityDigests().get(file, async () => void pauses++);
  expect(d.edited.size).toBe(30);
  expect(pauses).toBeGreaterThan(1);
});
