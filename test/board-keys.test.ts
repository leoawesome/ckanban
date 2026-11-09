import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, symlinkSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keysAnswerText, keysAsk, parseKeysAsk } from "../src/server/ask-keys";
import { claudeSessionFile } from "../src/server/board";
import { boardKeyEnv, keyNameError, maskSaved } from "../src/server/board-keys";
import { Bus } from "../src/server/events";
import { backupFile, backupFolderName, BACKUPS_DIR, BACKUPS_KEPT } from "../src/server/file-backup";
import { KEYS_RULE } from "../src/server/prompts";
import { createServer } from "../src/server/http";
import { Passes, PassError } from "../src/server/integrations/passes";
import { parseSession } from "../src/server/session";
import { Store } from "../src/server/store";
import { callTool, TOOL_NO_KEYS, type ToolContext } from "../src/mcp-server";
import { argsFile, board, bus, setup, store, untilSpawned, useBoardEnv } from "./board-env";
import { readJsonl, tempDir, until } from "./helpers";

const SECRET = "sntrys_live_0123456789abcdef";
const OTHER = "ghp_otherboard_9876543210";

function passesAt(root: string) {
  return new Passes(root, new Bus(), { fetch, now: () => new Date("2026-11-09T10:00:00Z") }, () => "http://localhost/cb");
}

test("board keys: kept per board, owner-only file, replace in place, gone once deleted; the view never has a value", () => {
  const root = tempDir("ck-keys-");
  const passes = passesAt(root);
  expect(passes.saveBoardKeys("a", [{ envName: "SENTRY_AUTH_TOKEN", name: "Sentry auth token", secret: ` ${SECRET} ` }])).toEqual(["SENTRY_AUTH_TOKEN"]);
  passes.saveBoardKeys("b", [{ envName: "NETLIFY_AUTH_TOKEN", name: "GitHub", secret: OTHER }]);
  expect(statSync(join(root, "automation-passes.json")).mode & 0o777).toBe(0o600);
  // Each board's runs get only its own keys.
  expect(boardKeyEnv(root, "a")).toEqual({ SENTRY_AUTH_TOKEN: SECRET });
  expect(boardKeyEnv(root, "b")).toEqual({ NETLIFY_AUTH_TOKEN: OTHER });
  expect(boardKeyEnv(root, "c")).toEqual({});
  // The same name on two boards is two keys.
  passes.saveBoardKeys("b", [{ envName: "SENTRY_AUTH_TOKEN", name: "Sentry", secret: "b-sentry-value" }]);
  expect(boardKeyEnv(root, "a").SENTRY_AUTH_TOKEN).toBe(SECRET);
  // Saving again replaces that board's key (one entry, savedAt moves).
  passes.saveBoardKeys("a", [{ envName: "SENTRY_AUTH_TOKEN", name: "Sentry auth token", secret: "new-sentry-value" }]);
  expect(passes.boardKeys("a")).toHaveLength(1);
  expect(boardKeyEnv(root, "a")).toEqual({ SENTRY_AUTH_TOKEN: "new-sentry-value" });
  const view = passes.view(passes.boardKeys("a")[0]);
  expect(view).toMatchObject({ board: "a", envName: "SENTRY_AUTH_TOKEN", kind: "key" });
  expect(JSON.stringify(view)).not.toContain("new-sentry-value");
  // Deleted: new runs no longer get it.
  passes.remove(passes.boardKeys("a")[0].id);
  expect(boardKeyEnv(root, "a")).toEqual({});
  // Bad names and values are refused before anything is written.
  expect(() => passes.saveBoardKeys("a", [{ envName: "OK_KEY", name: "x", secret: "v1234567" }, { envName: "PATH", name: "x", secret: "v" }])).toThrow(PassError);
  expect(() => passes.saveBoardKeys("a", [{ envName: "ANTHROPIC_API_KEY", name: "x", secret: "v" }])).toThrow(/uses itself/);
  expect(() => passes.saveBoardKeys("a", [{ envName: "X_KEY", name: "x", secret: "a\nb" }])).toThrow(/one line/);
  expect(boardKeyEnv(root, "a")).toEqual({});
});

test("key names: capitals, digits and _, never the board's or Claude's own variables", () => {
  expect(keyNameError("SENTRY_AUTH_TOKEN")).toBeNull();
  expect(keyNameError("NETLIFY_AUTH_TOKEN")).toBeNull();
  expect(keyNameError("AWS_ACCESS_KEY_ID")).toBeNull();
  for (const bad of ["GITHUB_TOKEN", "GH_TOKEN", "ZDOTDIR", "PROMPT_COMMAND", "sentry", "1KEY", "PATH", "HOME", "CKANBAN_PORT", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "GIT_SSH_COMMAND"]) {
    expect(keyNameError(bad)).not.toBeNull();
  }
});

test("automations: another board's key is never found nor handed to a script", () => {
  const root = tempDir("ck-keys-");
  const passes = passesAt(root);
  passes.saveBoardKeys("a", [{ envName: "LINEAR_KEY", name: "Linear", secret: "lin_aaaaaaaa" }]);
  const id = passes.boardKeys("a")[0].id;
  expect(passes.find("LINEAR_KEY", undefined, "a")?.id).toBe(id);
  expect(passes.find("LINEAR_KEY", undefined, "b")).toBeNull();
  expect(passes.envFor([id], "a")).toEqual({ LINEAR_KEY: "lin_aaaaaaaa" });
  expect(passes.envFor([id], "b")).toEqual({});
});

test("saved keys are masked in what the board stores: comments, activity, huddle messages", () => {
  const root = tempDir("ck-keys-");
  passesAt(root).saveBoardKeys("p", [{ envName: "SENTRY_AUTH_TOKEN", name: "Sentry", secret: SECRET }]);
  expect(maskSaved(root, `token is ${SECRET}.`)).toBe("token is ***.");
  const s = new Store(root);
  s.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  const t = s.createTicket("p", { title: "T", body: "", status: "backlog" });
  s.addComment("p", t.id, "ai", `printed ${SECRET} by mistake`);
  s.appendActivity("p", t.id, 1, { type: "user", message: { content: [{ type: "tool_result", content: `SENTRY_AUTH_TOKEN=${SECRET}\n` }] } });
  const files = ["comments.jsonl", "activity.jsonl"].map((f) => readFileSync(join(dirname(s.ticketPath("p", t.id)), f), "utf8"));
  for (const f of files) {
    expect(f).not.toContain(SECRET);
    expect(f).toContain("***");
  }
  // Still valid JSON.
  expect(s.readActivity("p", t.id)).toHaveLength(1);
});

test("ask_keys input: names checked, labels required, https links only, at most 8", () => {
  const ok = keysAsk({ keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token", help: "needs project:releases", createUrl: "https://sentry.io/settings/account/api/auth-tokens/" }], reason: "upload source maps" });
  expect(ok).toEqual({ keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token", help: "needs project:releases", createUrl: "https://sentry.io/settings/account/api/auth-tokens/" }], reason: "upload source maps", replace: false });
  expect(() => keysAsk({ keys: [], reason: "x" })).toThrow(/non-empty/);
  expect(() => keysAsk({ keys: [{ envName: "bad", label: "x" }], reason: "x" })).toThrow(/capital letters/);
  expect(() => keysAsk({ keys: [{ envName: "A_KEY" }], reason: "x" })).toThrow(/label/);
  expect(() => keysAsk({ keys: [{ envName: "A_KEY", label: "A", createUrl: "javascript:alert(1)" }], reason: "x" })).toThrow(/https/);
  expect(() => keysAsk({ keys: [{ envName: "A_KEY", label: "A" }, { envName: "A_KEY", label: "B" }], reason: "x" })).toThrow(/twice/);
  expect(() => keysAsk({ keys: Array.from({ length: 9 }, (_, i) => ({ envName: `K${i}`, label: "k" })), reason: "x" })).toThrow(/at most 8/);
  expect(() => keysAsk({ keys: [{ envName: "A_KEY", label: "A" }] })).toThrow(/reason/);
  expect(parseKeysAsk({ keys: "nope" })).toBeNull();
});

test("the message Claude gets after Save names the keys, never a value", () => {
  const ask = keysAsk({ keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token" }, { envName: "NETLIFY_AUTH_TOKEN", label: "Netlify token" }], reason: "deploy" });
  const saved = keysAnswerText(ask, ["SENTRY_AUTH_TOKEN"], false);
  expect(saved).toContain("$SENTRY_AUTH_TOKEN (Sentry auth token)");
  expect(saved).toContain("Left empty, not saved: $NETLIFY_AUTH_TOKEN");
  expect(saved).toContain("never print");
  expect(keysAnswerText(ask, [], true)).toContain("myself");
});

test("the chat shows ask_keys as a key box that waits until the user answers", () => {
  const L = (o: unknown) => JSON.stringify(o);
  const s = parseSession([
    L({ type: "user", uuid: "u1", timestamp: "2026-11-09T10:00:00Z", message: { role: "user", content: "Set up Sentry" } }),
    L({ type: "assistant", uuid: "a1", timestamp: "2026-11-09T10:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "k1", name: "mcp__ckanban__ask_keys", input: { keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token" }], reason: "source maps" } }] } }),
  ].join("\n"));
  const box = s.entries.find((e) => e.keys);
  expect(box?.keys?.keys[0].envName).toBe("SENTRY_AUTH_TOKEN");
  expect(s.pendingKeys).toEqual([box!.uuid]);
  // A call the tool refused ("No box shown", bad input) draws no box and waits for nothing.
  const refused = parseSession([
    L({ type: "assistant", uuid: "a1", timestamp: "2026-11-09T10:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "k1", name: "mcp__ckanban__ask_keys", input: { keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token" }], reason: "source maps" } }] } }),
    L({ type: "user", uuid: "u2", timestamp: "2026-11-09T10:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "k1", is_error: true, content: "No box shown. $SENTRY_AUTH_TOKEN is already saved" }] } }),
  ].join("\n"));
  expect(refused.entries.some((e) => e.keys)).toBe(false);
  expect(refused.pendingKeys).toEqual([]);
});

// --- The MCP tool -------------------------------------------------------------------------------------------------

function toolCtx(o: { passes?: any[]; ticket?: any; env?: Record<string, string> } = {}): ToolContext {
  const client = {
    getTicket: async () => o.ticket ?? { id: "t_1", title: "T" },
    listPasses: async () => ({ passes: o.passes ?? [], automations: 0 }),
  } as unknown as ToolContext["client"];
  return { client, cwd: "/", env: { CKANBAN_TICKET: "a/t_1", ...o.env } } as ToolContext;
}
const ASK = { keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token" }], reason: "upload source maps" };
const saved = (board: string, envName = "SENTRY_AUTH_TOKEN") => ({ id: "x", kind: "key", name: "S", claudeName: null, url: null, envName, board, status: "connected", error: null, usedBy: 0 });

test("ask_keys: shows a box, or says a key is already saved for this board unless replace", async () => {
  const shown = await callTool("ask_keys", ASK, toolCtx());
  expect(shown.isError).toBeUndefined();
  expect(shown.content[0].text).toContain("Shown to the user as a key box");
  // Another board's key doesn't count.
  expect((await callTool("ask_keys", ASK, toolCtx({ passes: [saved("b")] }))).content[0].text).toContain("Shown to the user");
  // Saved here, and in this run's environment.
  const here = await callTool("ask_keys", ASK, toolCtx({ passes: [saved("a")], env: { SENTRY_AUTH_TOKEN: "x" } }));
  expect(here.content[0].text).toContain("No box shown");
  // An error result, so the chat draws no box for the call.
  expect(here.isError).toBe(true);
  expect(here.content[0].text).toContain("in your environment now");
  // Saved after this run started.
  expect((await callTool("ask_keys", ASK, toolCtx({ passes: [saved("a")] }))).content[0].text).toContain("the next run, not this one");
  // Partly saved: ask again for the rest only.
  const two = { ...ASK, keys: [...ASK.keys, { envName: "NETLIFY_AUTH_TOKEN", label: "GitHub" }] };
  expect((await callTool("ask_keys", two, toolCtx({ passes: [saved("a")] }))).content[0].text).toContain("only the keys not saved yet ($NETLIFY_AUTH_TOKEN)");
  // replace: the box shows and says it replaces.
  expect((await callTool("ask_keys", { ...ASK, replace: true }, toolCtx({ passes: [saved("a")] }))).content[0].text).toContain("replaces the saved key");
});

test("ask_keys: refused outside a ticket chat, in huddles and in tool tickets; bad input comes back to fix", async () => {
  const outside = await callTool("ask_keys", ASK, { ...toolCtx(), env: {} } as ToolContext);
  expect(outside.isError).toBe(true);
  expect((await callTool("ask_keys", ASK, toolCtx({ env: { CKANBAN_HUDDLE_AGENT: "h/x/y" } }))).isError).toBe(true);
  const tool = await callTool("ask_keys", ASK, toolCtx({ ticket: { id: "t_1", title: "T", tool: true, parentId: "t_0" } }));
  expect(tool.isError).toBe(true);
  expect(tool.content[0].text).toBe(TOOL_NO_KEYS);
  const bad = await callTool("ask_keys", { keys: [{ envName: "PATH", label: "x" }], reason: "x" }, toolCtx());
  expect(bad.content[0].text).toContain("call ask_keys again");
});

// --- The whole path: box → Save → the next run has the key; deleted → gone -----------------------------------------

useBoardEnv();
let server: ReturnType<typeof createServer> | null = null;
beforeEach(() => {
  process.env.FAKE_ENV_KEYS = "SENTRY_AUTH_TOKEN,NETLIFY_AUTH_TOKEN";
});
afterEach(() => {
  server?.stop(true);
  server = null;
  delete process.env.FAKE_ENV_KEYS;
});

test("Save stores the key for the board and resumes the ticket in a new run that has it; the value goes nowhere else", async () => {
  await setup({ git: false });
  store.saveProfile({ name: "Other", slug: "other", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  server = createServer({ store, bus, board, port: 0, webDir: tempDir("ck-web-"), isUserBrowser: async () => true });
  const base = `http://127.0.0.1:${server.port}/api`;
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json", origin: `http://127.0.0.1:${server!.port}`, ...headers } });
  // Another board's key never reaches this board's runs.
  passesAt(store.root).saveBoardKeys("other", [{ envName: "NETLIFY_AUTH_TOKEN", name: "GitHub", secret: OTHER }]);

  const t = await board.createTicket("p", { title: "Sentry", body: "", status: "planning" });
  await board.chat("p", t.id, "Set up Sentry");
  await untilSpawned(1);
  await until(() => !board.isRunning("p", t.id) && !!store.getTicket("p", t.id)?.sessionId && !!claudeSessionFile(store.getTicket("p", t.id)!.sessionId!));
  const sessionId = store.getTicket("p", t.id)!.sessionId!;
  appendFileSync(claudeSessionFile(sessionId)!, JSON.stringify({
    type: "assistant", uuid: "a-keys", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_keys", name: "mcp__ckanban__ask_keys", input: { ...ASK, keys: [...ASK.keys, { envName: "NETLIFY_AUTH_TOKEN", label: "GitHub" }] } }] },
  }) + "\n");

  // Only the user, from the board's page.
  expect((await send("POST", `/profiles/p/tickets/${t.id}/key-cards/toolu_keys`, { keys: { SENTRY_AUTH_TOKEN: SECRET } }, { "x-ckanban-run": "p/t_x" })).status).toBe(403);
  expect((await send("POST", `/profiles/p/tickets/${t.id}/key-cards/nope`, { keys: { SENTRY_AUTH_TOKEN: SECRET } })).status).toBe(404);
  expect((await send("POST", `/profiles/p/tickets/${t.id}/key-cards/toolu_keys`, { keys: {} })).status).toBe(400);
  const r = await send("POST", `/profiles/p/tickets/${t.id}/key-cards/toolu_keys`, { keys: { SENTRY_AUTH_TOKEN: SECRET, PATH: "/evil" } });
  expect(r.status).toBe(202);
  expect(await r.text()).not.toContain(SECRET);
  expect((await send("POST", `/profiles/p/tickets/${t.id}/key-cards/toolu_keys`, { keys: { SENTRY_AUTH_TOKEN: SECRET } })).status).toBe(409);

  // The next run has the key in its environment (and not the other board's); its message names it, no value.
  await untilSpawned(2);
  const run2 = readJsonl(argsFile)[1];
  expect(run2.env).toEqual({ SENTRY_AUTH_TOKEN: SECRET, NETLIFY_AUTH_TOKEN: null });
  expect(run2.prompt).toContain("$SENTRY_AUTH_TOKEN");
  expect(run2.prompt).not.toContain(SECRET);
  expect(store.getTicket("p", t.id)!.keyCards?.toolu_keys).toMatchObject({ saved: ["SENTRY_AUTH_TOKEN"] });
  await until(() => !board.isRunning("p", t.id));
  const dir = dirname(store.ticketPath("p", t.id));
  for (const f of ["ticket.md", "comments.jsonl", "activity.jsonl"]) {
    try {
      expect(readFileSync(join(dir, f), "utf8")).not.toContain(SECRET);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  // The passes list (Connections) has no values, and names the board.
  const list = await (await fetch(`${base}/passes`)).text();
  expect(list).not.toContain(SECRET);
  expect(list).not.toContain(OTHER);
  const key = (JSON.parse(list).passes as any[]).find((p) => p.board === "p");
  expect(key).toMatchObject({ envName: "SENTRY_AUTH_TOKEN", boardName: "P", usedByNames: [] });

  // Claude printed the key by mistake: the chat the UI gets hides it.
  appendFileSync(claudeSessionFile(sessionId)!, JSON.stringify({
    type: "assistant", uuid: "a-leak", timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: `Your token is ${SECRET}` }] },
  }) + "\n");
  const chat = await (await fetch(`${base}/profiles/p/tickets/${t.id}/conversation`)).text();
  expect(chat).toContain("Your token is ***");
  expect(chat).not.toContain(SECRET);
  // Deleted in Connections: the next run doesn't get it.
  expect((await send("DELETE", `/passes/${key.id}`)).status).toBe(204);
  await board.chat("p", t.id, "Go on");
  await untilSpawned(3);
  expect(readJsonl(argsFile)[2].env).toEqual({ SENTRY_AUTH_TOKEN: null, NETLIFY_AUTH_TOKEN: null });
});

// --- backup_file: a private copy before a key goes into a file ---------------------------------------------------

function backupCtx(root: string, cwd: string, env: Record<string, string> = { CKANBAN_TICKET: "a/t_1" }, now = () => Date.parse("2026-11-09T10:00:00Z")): ToolContext {
  const client = { listProfiles: async () => [{ slug: "a", name: "A", path: cwd }] } as unknown as ToolContext["client"];
  return { client, cwd, env, now, dataRoot: root } as ToolContext;
}

function backupRoot(): { root: string; project: string } {
  const root = tempDir("ck-bkroot-");
  mkdirSync(join(root, "profiles", "a"), { recursive: true });
  return { root, project: tempDir("ck-bkproj-") };
}

test("backup_file: copies the file into the board's private folder, 700 folders and 600 file, never the contents in the reply", async () => {
  const { root, project } = backupRoot();
  const env = join(project, ".env");
  writeFileSync(env, `KEEP=1\nSENTRY_AUTH_TOKEN=${SECRET}\n`, { mode: 0o644 });
  const r = await callTool("backup_file", { path: ".env" }, backupCtx(root, project));
  expect(r.isError).toBeUndefined();
  const text = r.content[0].text;
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("KEEP=1");
  const base = join(root, "profiles", "a", BACKUPS_DIR);
  const [folder] = readdirSync(base);
  expect(folder).toBe(backupFolderName(env));
  const [copy] = readdirSync(join(base, folder));
  expect(text).toContain(join(base, folder, copy));
  expect(readFileSync(join(base, folder, copy), "utf8")).toBe(`KEEP=1\nSENTRY_AUTH_TOKEN=${SECRET}\n`);
  expect(statSync(base).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, folder)).mode & 0o777).toBe(0o700);
  expect(statSync(join(base, folder, copy)).mode & 0o777).toBe(0o600);
  // Nothing landed in the project folder.
  expect(readdirSync(project)).toEqual([".env"]);
});

test("backup_file: keeps the last 5 copies per file; a same-named file elsewhere has its own", async () => {
  const { root, project } = backupRoot();
  const file = join(project, "config.yml");
  let t = Date.parse("2026-11-09T10:00:00Z");
  for (let i = 0; i < 7; i++) {
    writeFileSync(file, `v${i}\n`);
    const r = await callTool("backup_file", { path: file }, backupCtx(root, project, undefined, () => (t += 1000)));
    expect(r.isError).toBeUndefined();
  }
  const dir = join(root, "profiles", "a", BACKUPS_DIR, backupFolderName(file));
  const copies = readdirSync(dir).sort();
  expect(copies.length).toBe(BACKUPS_KEPT);
  // The first copy (the file before Claude's edits) stays, with the newest ones.
  expect(copies.map((c) => readFileSync(join(dir, c), "utf8"))).toEqual(["v0\n", "v3\n", "v4\n", "v5\n", "v6\n"]);
  // Two calls in the same millisecond don't overwrite each other.
  const same = () => Date.parse("2026-11-09T11:00:00Z");
  await callTool("backup_file", { path: file }, backupCtx(root, project, undefined, same));
  await callTool("backup_file", { path: file }, backupCtx(root, project, undefined, same));
  expect(readdirSync(dir).length).toBe(BACKUPS_KEPT);
  expect(readdirSync(dir).filter((f) => f.startsWith("20261109T110000000Z")).length).toBe(2);
  // Many in one millisecond ("-10" sorts after "-2"), and a clock gone back: the copy just made always stays.
  for (let i = 0; i < 12; i++) {
    writeFileSync(file, `same${i}\n`);
    const r = backupFile(root, "a", file, project, new Date("2026-11-09T12:00:00Z"));
    expect(r.ok && readFileSync(r.copy, "utf8")).toBe(`same${i}\n`);
  }
  writeFileSync(file, "back\n");
  const back = backupFile(root, "a", file, project, new Date("2020-01-01T00:00:00Z"));
  expect(back.ok && readFileSync(back.copy, "utf8")).toBe("back\n");
  expect(readdirSync(dir).length).toBe(BACKUPS_KEPT);
  const other = join(tempDir("ck-bkother-"), "config.yml");
  writeFileSync(other, "x\n");
  await callTool("backup_file", { path: other }, backupCtx(root, project));
  expect(readdirSync(dir).length).toBe(BACKUPS_KEPT);
  expect(readdirSync(join(root, "profiles", "a", BACKUPS_DIR)).length).toBe(2);
});

test("backup_file: a missing file is reported and nothing is made; folders and crafted paths stay inside the backups folder", async () => {
  const { root, project } = backupRoot();
  const r = await callTool("backup_file", { path: "nope/.env" }, backupCtx(root, project));
  expect(r.isError).toBeUndefined();
  expect(r.content[0].text).toContain("doesn't exist");
  expect(existsSync(join(root, "profiles", "a", BACKUPS_DIR))).toBe(false);
  expect((await callTool("backup_file", { path: project }, backupCtx(root, project))).content[0].text).toContain("is not a file");
  // The folder name comes from a hash and the cleaned file name only.
  expect(backupFolderName("/x/../../etc/passwd")).toMatch(/^[0-9a-f]{12}-passwd$/);
  expect(backupFolderName("/x/a b;$(rm)")).toMatch(/^[0-9a-f]{12}-a_b___rm_$/);
  // A run always backs up into its own board; a bad board name is refused before anything is written.
  expect(() => backupFile(root, "../escape", join(project, "x"), project)).toThrow("not a board name");
});

test("backup_file: ~ and $HOME mean the home folder; an unreadable file is not called missing; a linked file is copied", () => {
  const { root, project } = backupRoot();
  const home = tempDir("ck-bkhome-");
  writeFileSync(join(home, ".sentryclirc"), "[auth]\ntoken=old\n");
  for (const p of ["~/.sentryclirc", "$HOME/.sentryclirc", "${HOME}/.sentryclirc"]) {
    const r = backupFile(root, "a", p, project, new Date(), home);
    expect(r.ok && r.source).toBe(join(home, ".sentryclirc"));
  }
  expect(() => backupFile(root, "a", "~other/.env", project, new Date(), home)).toThrow("full path");
  const locked = join(project, "locked.env");
  writeFileSync(locked, "A=1\n");
  chmodSync(locked, 0o000);
  try {
    if (process.getuid?.() !== 0) expect(() => backupFile(root, "a", locked, project)).toThrow();
  } finally {
    chmodSync(locked, 0o600);
  }
  const target = join(project, "real.env");
  writeFileSync(target, "B=2\n");
  symlinkSync(target, join(project, "link.env"));
  const r = backupFile(root, "a", "link.env", project);
  expect(r.ok && r.source).toBe(target);
  expect(r.ok && readFileSync(r.copy, "utf8")).toBe("B=2\n");
});

test("the key rule asks for a backup and a one-line change", () => {
  expect(KEYS_RULE).toContain("`backup_file`");
  expect(KEYS_RULE).toContain("change only that key's line");
});
