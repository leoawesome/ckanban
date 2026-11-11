// The Context panel's hooks on the Board: /context runs with the chat's own flags, on a copy, refreshed when a run ends.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeSessionFile } from "../src/server/board";
import { ContextUsage } from "../src/server/context-usage";
import { createServer } from "../src/server/http";
import { readJsonl, tempDir, until } from "./helpers";
import { board, bus, readArgs, setup, store, untilSpawned, useBoardEnv } from "./board-env";

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

test("a run end checks a chat nobody opened the panel on, saves the result, and a restarted daemon shows it", async () => {
  await setup();
  const argsFile = join(tempDir("ck-ctx-"), "a.jsonl");
  const prevBin = process.env.CKANBAN_CLAUDE_BIN;
  process.env.CKANBAN_CLAUDE_BIN = FAKE_CTX;
  process.env.FAKE_CTX_ARGS = argsFile;
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    const start = () => {
      const s = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-") });
      servers.push(s);
      return `http://127.0.0.1:${s.port}`;
    };
    const base = start();
    const t = await board.createTicket("p", { title: "x", body: "", status: "ready" });
    // Nobody asked for a check: the run ending starts one.
    await until(() => existsSync(store.contextPath("p", t.id)), 20_000);
    const saved = JSON.parse(readFileSync(store.contextPath("p", t.id), "utf8"));
    expect(Object.keys(saved).sort()).toEqual(["result", "sessionId"]);
    expect(saved.sessionId).toBe(board.contextSpec("p", t.id)!.sessionId);
    expect(saved.result.report.window).toBe(1_000_000);
    expect(readJsonl(argsFile)).toHaveLength(1);
    const view = async (b: string) => (await (await fetch(`${b}/api/profiles/p/tickets/${t.id}/context`)).json()) as any;
    expect((await view(base)).result.checkedAt).toBe(saved.result.checkedAt);
    // A new daemon (fresh cache) reads it from disk, without running a check.
    servers.shift()!.stop(true);
    const v = await view(start());
    expect(v.result.report.percent).toBe(saved.result.report.percent);
    expect(v.stale).toBeUndefined();
    expect(readJsonl(argsFile)).toHaveLength(1);
    // Deleting the ticket takes the saved result with it.
    store.deleteTicket("p", t.id);
    expect(existsSync(store.contextPath("p", t.id))).toBe(false);
  } finally {
    for (const s of servers) s.stop(true);
    if (prevBin === undefined) delete process.env.CKANBAN_CLAUDE_BIN;
    else process.env.CKANBAN_CLAUDE_BIN = prevBin;
    delete process.env.FAKE_CTX_ARGS;
  }
}, 30_000);
