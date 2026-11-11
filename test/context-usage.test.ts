import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeProjectDir } from "../src/server/claude";
import { contextArgs, ContextUsage, parseContextReport, parseTokens } from "../src/server/context-usage";
import { readJsonl, tempDir } from "./helpers";

const FIX = join(import.meta.dir, "fixtures", "context");
const FAKE = join(import.meta.dir, "fixtures", "fake-claude-context.ts");
const sample = (name: string) => readFileSync(join(FIX, name), "utf8");

test("parseTokens reads k, m, plain, approximate and comma numbers", () => {
  expect(parseTokens("2.5k")).toBe(2500);
  expect(parseTokens("1.2m")).toBe(1_200_000);
  expect(parseTokens("201")).toBe(201);
  expect(parseTokens("~130")).toBe(130);
  expect(parseTokens("4,321")).toBe(4321);
  expect(parseTokens("1M")).toBe(1_000_000);
  expect(parseTokens("")).toBe(0);
  expect(parseTokens("n/a")).toBe(0);
});

test("parses the plain-resume sample", () => {
  const r = parseContextReport(sample("plain-resume.md"));
  expect(r.model).toBe("claude-opus-5-5");
  expect([r.used, r.window, r.percent]).toEqual([20_500, 1_000_000, 2]);
  expect(r.categories.map((c) => c.name)).toEqual(["System prompt", "System tools", "MCP server instructions", "MCP tools (deferred)", "System tools (deferred)", "Memory files", "Skills", "Messages", "Free space", "Autocompact buffer"]);
  expect(r.categories.find((c) => c.name === "Messages")).toEqual({ name: "Messages", tokens: 6400, percent: 0.6, deferred: false });
  expect(r.categories.filter((c) => c.deferred).map((c) => c.name)).toEqual(["MCP tools (deferred)", "System tools (deferred)"]);
  expect(r.memoryFiles).toEqual([
    { type: "User", path: "/Users/me/.claude/CLAUDE.md", tokens: 103 },
    { type: "Project", path: "/private/tmp/ctxcheck/CLAUDE.md", tokens: 20 },
  ]);
  expect(r.skills.length).toBeGreaterThan(5);
  expect(r.skills[0]).toEqual({ name: "ponytail-review", source: "User", tokens: 130 });
  expect(r.builtinTools).toEqual([]);
});

test("parses the board-flags sample with MCP tools grouped by server", () => {
  const r = parseContextReport(sample("board-flags-mcp.md"));
  expect([r.used, r.window, r.percent]).toEqual([22_200, 1_000_000, 2]);
  expect(r.mcpServers.map((s) => [s.server, s.tools.length])).toEqual([["ckanban", 70], ["claude-in-chrome", 20]]);
  const ck = r.mcpServers[0];
  expect(ck.tools.find((t) => t.name === "create_ticket")).toEqual({ name: "create_ticket", tokens: 2100 });
  expect(ck.tokens).toBe(ck.tools.reduce((s, t) => s + t.tokens, 0));
  expect(r.mcpServers[1].tools[1]).toEqual({ name: "computer", tokens: 2200 });
});

test("an unknown category row is kept under its own label", () => {
  const r = parseContextReport(sample("unknown-row.md"));
  expect([r.used, r.window, r.percent]).toEqual([1_200_000, 2_000_000, 60]);
  expect(r.categories.find((c) => c.name === "Plugin hooks")).toEqual({ name: "Plugin hooks", tokens: 4321, percent: 0.2, deferred: false });
  expect(r.mcpServers).toEqual([]);
  expect(r.memoryFiles).toEqual([]);
  expect(r.skills).toEqual([]);
});

test("missing sections give empty lists", () => {
  const r = parseContextReport(sample("missing-sections.md"));
  expect(r.model).toBe("claude-haiku-5-5");
  expect([r.used, r.window, r.percent]).toEqual([12_000, 200_000, 6]);
  expect(r.categories).toHaveLength(4);
  expect([r.mcpServers, r.memoryFiles, r.skills, r.builtinTools]).toEqual([[], [], [], []]);
  // Nothing at all: zeros and empty lists, never a throw.
  expect(parseContextReport("")).toEqual({ model: null, used: 0, window: 0, percent: 0, categories: [], mcpServers: [], builtinTools: [], memoryFiles: [], skills: [] });
});

test("a long chat with several memory files", () => {
  const r = parseContextReport(sample("long-chat.md"));
  expect([r.used, r.window, r.percent]).toEqual([154_200, 1_000_000, 15]);
  expect(r.categories.find((c) => c.name === "Messages")?.tokens).toBe(92_100);
  expect(r.categories.find((c) => c.name === "MCP tools")).toEqual({ name: "MCP tools", tokens: 21_100, percent: 2.1, deferred: false });
  expect(r.memoryFiles.map((f) => [f.type, f.tokens])).toEqual([["User", 180], ["Project", 1600], ["AutoMem", 420]]);
  // Biggest server first.
  expect(r.mcpServers.map((s) => s.server)).toEqual(["claude-in-chrome", "ckanban"]);
});

test("contextArgs keeps the chat's flags, drops the stream ones and resumes the copy", () => {
  const chat = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--include-partial-messages",
    "--permission-mode", "bypassPermissions", "--disallowedTools", "A,B", "--resume", "orig", "--model", "opus", "--mcp-config", "{}", "--append-system-prompt", "x",
    "--max-budget-usd", "5", "--chrome", "--permission-prompt-tool", "stdio", "--strict-mcp-config", "--tools", "Read"];
  expect(contextArgs(chat, "fork")).toEqual(["-p", "/context", "--output-format", "json", "--resume", "fork",
    "--permission-mode", "bypassPermissions", "--disallowedTools", "A,B", "--model", "opus", "--mcp-config", "{}", "--chrome", "--strict-mcp-config", "--tools", "Read"]);
});

// ---- The runner, on a fake claude that appends to whatever session it resumes ----

let config: string;
let cwd: string;
let argsFile: string;
let srcFile: string;
const SID = "11111111-2222-3333-4444-555555555555";

const sessionFile = (id: string): string | null => {
  const root = join(config, "projects");
  const d = existsSync(root) ? readdirSync(root).find((x) => existsSync(join(root, x, `${id}.jsonl`))) : undefined;
  return d ? join(root, d, `${id}.jsonl`) : null;
};
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const newUsage = (o: { timeoutMs?: number; changed?: (k: string) => void; file?: (k: string) => string | null; maxBackground?: number } = {}) =>
  new ContextUsage({ claudeBin: FAKE, sessionFile, configDir: () => config, ...o });
const spec = () => ({ sessionId: SID, cwd, args: ["--model", "opus", "--resume", SID, "--chrome"], env: { CLAUDE_CONFIG_DIR: config, FAKE_CTX_ARGS: argsFile } });

beforeEach(() => {
  config = tempDir("ck-claude-");
  cwd = realpathSync(tempDir("ck-cwd-"));
  argsFile = join(tempDir("ck-args-"), "args.jsonl");
  const dir = join(config, "projects", encodeProjectDir(cwd));
  mkdirSync(join(dir, SID, "tool-results"), { recursive: true });
  writeFileSync(join(dir, SID, "tool-results", "a.txt"), "x");
  srcFile = join(dir, `${SID}.jsonl`);
  writeFileSync(srcFile, [JSON.stringify({ type: "user", sessionId: SID, cwd }), JSON.stringify({ type: "assistant", sessionId: SID, cwd })].join("\n") + "\n");
  delete process.env.FAKE_CTX_MODE;
});
afterEach(() => {
  delete process.env.FAKE_CTX_MODE;
});

test("a check never changes the chat history: the original session's bytes are the same, and the copy is gone", async () => {
  const before = sha(srcFile);
  const changed: string[] = [];
  const u = newUsage({ changed: (k) => changed.push(k) });
  expect(u.view("ticket/p/t1", SID)).toEqual({ state: "idle", result: null, error: null });
  await u.refresh("ticket/p/t1", spec());
  expect(sha(srcFile)).toBe(before);
  const runs = readJsonl(argsFile) as { args: string[]; cwd: string; file: string }[];
  expect(runs).toHaveLength(1);
  const forkId = runs[0].args[runs[0].args.indexOf("--resume") + 1];
  expect(forkId).not.toBe(SID);
  expect(runs[0].args.slice(0, 2)).toEqual(["-p", "/context"]);
  expect(runs[0].args).toContain("--chrome");
  expect(runs[0].cwd).toBe(cwd);
  // The fake really appended to the copy it resumed; the copy and its side folder are deleted afterwards.
  expect(runs[0].file).toBe(join(config, "projects", encodeProjectDir(cwd), `${forkId}.jsonl`));
  expect(existsSync(runs[0].file)).toBe(false);
  expect(existsSync(join(config, "projects", encodeProjectDir(cwd), forkId))).toBe(false);
  expect(existsSync(join(config, "projects", encodeProjectDir(cwd), SID, "tool-results", "a.txt"))).toBe(true);
  const v = u.view("ticket/p/t1", SID);
  expect(v.state).toBe("idle");
  expect(v.error).toBeNull();
  expect(v.result?.report.used).toBe(22_200);
  expect(changed).toEqual(["ticket/p/t1"]);
  expect(u.checked("ticket/p/t1")).toBe(true);
});

test("concurrent requests for one session share a single /context process", async () => {
  process.env.FAKE_CTX_MODE = "slow";
  const u = newUsage();
  const a = u.refresh("ticket/p/t1", spec());
  expect(u.view("ticket/p/t1", SID).state).toBe("running");
  const b = u.refresh("ticket/p/t1", spec());
  expect(b).toBe(a);
  await Promise.all([a, b]);
  expect(readJsonl(argsFile)).toHaveLength(1);
});

test("failures give a plain error and keep the last result; the copy is still deleted", async () => {
  const u = newUsage();
  await u.refresh("chat/p/c1", spec());
  const first = u.view("chat/p/c1", SID).result;
  for (const [mode, text] of [["error", "something broke inside Claude Code"], ["garbage", "exit code 0"]] as const) {
    process.env.FAKE_CTX_MODE = mode;
    await u.refresh("chat/p/c1", spec());
    const v = u.view("chat/p/c1", SID);
    expect(v.error).toContain(text);
    expect(v.result).toEqual(first);
  }
  const dir = join(config, "projects", encodeProjectDir(cwd));
  expect(readdirSync(dir).sort()).toEqual([SID, `${SID}.jsonl`]);
});

test("a check that takes too long is stopped with a plain error", async () => {
  process.env.FAKE_CTX_MODE = "hang";
  const u = newUsage({ timeoutMs: 300 });
  await u.refresh("ticket/p/t1", spec());
  expect(u.view("ticket/p/t1", SID).error).toContain("took longer than");
  expect(readdirSync(join(config, "projects", encodeProjectDir(cwd))).sort()).toEqual([SID, `${SID}.jsonl`]);
});

test("no session: the 'no chat yet' state; a missing file is a plain error", async () => {
  const u = newUsage();
  expect(u.view("ticket/p/t1", null)).toEqual({ state: "none", result: null, error: null });
  await u.refresh("ticket/p/t2", { ...spec(), sessionId: "nope" });
  expect(u.view("ticket/p/t2", "nope").error).toBe("This chat has no saved conversation yet.");
  // A result belongs to its session: a new session shows it marked stale until the next check.
  await u.refresh("ticket/p/t1", spec());
  expect(u.view("ticket/p/t1", "other-session").stale).toBe(true);
});

test("results are saved and a new ContextUsage reads them; another session's result shows as stale", async () => {
  const dir = tempDir("ck-saved-");
  const file = (k: string) => join(dir, `${k.replace(/\//g, "_")}.json`);
  const u = newUsage({ file });
  await u.refresh("ticket/p/t1", spec());
  const saved = JSON.parse(readFileSync(file("ticket/p/t1"), "utf8"));
  expect(Object.keys(saved).sort()).toEqual(["result", "sessionId"]);
  // A failure isn't saved and keeps the saved result.
  process.env.FAKE_CTX_MODE = "error";
  await u.refresh("ticket/p/t1", spec());
  expect(JSON.parse(readFileSync(file("ticket/p/t1"), "utf8"))).toEqual(saved);
  const fresh = newUsage({ file });
  expect(fresh.checked("ticket/p/t1")).toBe(true);
  expect(fresh.view("ticket/p/t1", SID)).toEqual({ state: "idle", result: saved.result, error: null });
  expect(fresh.view("ticket/p/t1", "newer-session")).toEqual({ state: "idle", result: saved.result, error: null, stale: true });
  // No folder for it (the chat was deleted): nothing is written.
  const gone = newUsage({ file: () => join(dir, "deleted", "x.json") });
  delete process.env.FAKE_CTX_MODE;
  await gone.refresh("ticket/p/t2", spec());
  expect(existsSync(join(dir, "deleted"))).toBe(false);
  // A file that isn't a result is ignored.
  writeFileSync(file("ticket/p/t3"), "{not json");
  expect(fresh.view("ticket/p/t3", SID).result).toBeNull();
});

test("background checks: at most maxBackground at once, one queued per chat with the newest spec", async () => {
  process.env.FAKE_CTX_MODE = "slow";
  const u = newUsage({ maxBackground: 2 });
  const ids = ["a", "b", "c", "d"].map((x) => `${x}${SID.slice(1)}`);
  const dir = join(config, "projects", encodeProjectDir(cwd));
  for (const id of ids) writeFileSync(join(dir, `${id}.jsonl`), readFileSync(srcFile));
  const s = (id: string) => ({ ...spec(), sessionId: id });
  for (const id of ids) u.schedule(`chat/p/${id}`, s(id));
  expect(u.pending).toEqual({ running: 2, queued: 2 });
  // The same chat again while it waits: still one place in the queue.
  u.schedule(`chat/p/${ids[3]}`, s(ids[3]));
  u.schedule(`chat/p/${ids[3]}`, s(ids[3]));
  expect(u.pending).toEqual({ running: 2, queued: 2 });
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, u.pending.running)), 5);
  await u.idle();
  clearInterval(timer);
  expect(peak).toBeLessThanOrEqual(2);
  expect(u.pending).toEqual({ running: 0, queued: 0 });
  expect(readJsonl(argsFile)).toHaveLength(4);
  for (const id of ids) expect(u.view(`chat/p/${id}`, id).result?.report.used).toBe(22_200);
});
