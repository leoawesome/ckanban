#!/usr/bin/env bun
// Fake `claude -p "/context" --resume <id> --output-format json` for the Context panel tests. Like the real CLI it
// appends bookkeeping lines to the session it resumes (so a test can tell whether the chat's own file was touched),
// then prints the JSON result with a saved /context report.
// FAKE_CTX_ARGS=<file>: appends {args, cwd, forkFile} per run. FAKE_CTX_MODE=ok|slow|error|garbage|hang.
// FAKE_CTX_SAMPLE=<file>: the report to print (default: the board-flags sample). FAKE_CTX_DELAY_MS: how long ok/slow takes.
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const id = args[args.indexOf("--resume") + 1];
const root = join(process.env.CLAUDE_CONFIG_DIR!, "projects");
const dir = existsSync(root) ? readdirSync(root).find((d) => existsSync(join(root, d, `${id}.jsonl`))) : undefined;
const file = dir ? join(root, dir, `${id}.jsonl`) : null;
if (process.env.FAKE_CTX_ARGS) appendFileSync(process.env.FAKE_CTX_ARGS, JSON.stringify({ args, cwd: process.cwd(), file }) + "\n");
const mode = process.env.FAKE_CTX_MODE ?? "ok";
if (mode === "hang") await new Promise(() => {});
await Bun.sleep(Number(process.env.FAKE_CTX_DELAY_MS ?? (mode === "slow" ? 300 : 0)));
if (!file) {
  console.log(JSON.stringify({ is_error: true, result: `No conversation found with session ID: ${id}` }));
  process.exit(1);
}
for (const type of ["queue-operation", "queue-operation", "user", "user", "system", "last-prompt", "mode", "cost-state"]) {
  appendFileSync(file, JSON.stringify({ type, sessionId: id }) + "\n");
}
if (mode === "error") {
  console.error("Error: something broke inside Claude Code");
  process.exit(1);
}
if (mode === "garbage") {
  console.log("not json at all");
  process.exit(0);
}
const sample = process.env.FAKE_CTX_SAMPLE ?? join(import.meta.dir, "context", "board-flags-mcp.md");
console.log(JSON.stringify({ is_error: false, num_turns: 0, session_id: id, result: readFileSync(sample, "utf8") }));
