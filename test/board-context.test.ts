// The Context panel's hooks on the Board: /context runs with the chat's own flags, on a copy, refreshed when a run ends.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionFile } from "../src/server/board";
import { ContextUsage } from "../src/server/context-usage";
import { tempDir, until } from "./helpers";
import { board, readArgs, setup, untilSpawned, useBoardEnv } from "./board-env";

useBoardEnv();
const FAKE_CTX = join(import.meta.dir, "fixtures", "fake-claude-context.ts");

test("contextSpec copies the chat run's folder and flags; a check leaves the ticket's session file as it was", async () => {
  await setup();
  const ended: string[] = [];
  board.onRunEnd((_s, id) => ended.push(id));
  const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
  expect(board.contextSpec("p", t.id)).toBeNull();
  await untilSpawned();
  await board.whenIdle();
  await until(() => ended.includes(t.id));
  const run = readArgs()[0];
  const spec = board.contextSpec("p", t.id)!;
  expect(spec.cwd).toBe(run.cwd);
  for (const flag of ["--mcp-config", "--disallowedTools", "--permission-mode", "--chrome"]) {
    expect(spec.args[spec.args.indexOf(flag) + 1]).toBe(run.args[run.args.indexOf(flag) + 1]);
  }
  expect(spec.env.CKANBAN_TICKET).toBe(`p/${t.id}`);
  const file = claudeSessionFile(spec.sessionId)!;
  const sha = () => createHash("sha256").update(readFileSync(file)).digest("hex");
  const before = sha();
  const argsFile = join(tempDir("ck-ctx-"), "a.jsonl");
  const u = new ContextUsage({ claudeBin: FAKE_CTX, sessionFile: claudeSessionFile });
  await u.refresh(`ticket/p/${t.id}`, { ...spec, env: { ...spec.env, FAKE_CTX_ARGS: argsFile } });
  expect(u.view(`ticket/p/${t.id}`, spec.sessionId).result?.report.window).toBe(1_000_000);
  expect(sha()).toBe(before);
});
