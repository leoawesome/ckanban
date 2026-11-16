// Outside-in contract: the Connections window's MCP servers (Claude's own, user-wide, and each board's "only this
// board" tools) and registering `ckanban mcp` with Claude Code and Codex. See contracts/api.md ("Connections") and
// contracts/data-files.md (`board-tools.json`). Claude's `claude mcp` commands are faked by fake-claude-mcp.ts, which
// keeps user-wide servers in the temp Claude config folder's `.claude.json`, as Claude Code does.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, FAKE_CLAUDE, startDaemon, until } from "./daemon";
import { documentedPaths, filesUnder, readJsonl } from "./files";
import { asUser } from "./user-browser";

// Each user request starts a short-lived "browser" and the daemon looks it up with lsof and ps: slow on a busy Mac.
setDefaultTimeout(60_000);

let d: Daemon;
const SLUG = "conn";
const dir = mkdtempSync(join(tmpdir(), "ck-contract-mcp-"));
const mcpLog = join(dir, "mcp.jsonl");
const FAKE_MCP = join(import.meta.dir, "fake-claude-mcp.ts");
let claudeJson = "";

beforeAll(async () => {
  d = await startDaemon({
    env: { FAKE_MCP_LOG: mcpLog },
    // `claude mcp ...` goes to the MCP fake; everything else (runs, the status probe) to the usual fake Claude.
    stubs: { claude: `#!/bin/sh\nif [ "$1" = mcp ]; then exec "${process.execPath}" "${FAKE_MCP}" "$@"; fi\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n` },
  });
  claudeJson = join(d.env.CLAUDE_CONFIG_DIR, ".claude.json");
  expect((await d.api("POST", "/api/profiles", { name: "Conn", path: d.project })).status).toBe(201);
  // The first `claude mcp list` (at start) has finished.
  await until(async () => (await d.api("GET", "/api/mcp")).data.checkedAt, 15_000, "the first MCP list");
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

/** Changing Claude's tools and reading their settings is for the user only: sent as the user's browser. */
const user = (method: string, path: string, body?: unknown) => asUser(d.url, method, path, body);
const server = (state: any, name: string) => state.servers.find((s: any) => s.name === name);
const userServers = () => (existsSync(claudeJson) ? JSON.parse(readFileSync(claudeJson, "utf8")).mcpServers ?? {} : {});
const boardToolsFile = () => join(d.home, "profiles", SLUG, "board-tools.json");
const boardTools = () => JSON.parse(readFileSync(boardToolsFile(), "utf8"));

test("GET /api/mcp answers McpState", async () => {
  const r = await d.api("GET", "/api/mcp");
  expect(r.status).toBe(200);
  expect(r.data).toMatchObject({ servers: [], unparsed: [], error: null, checking: expect.any(Boolean) });
  expect(Date.parse(r.data.checkedAt)).not.toBeNaN();
  expect(readJsonl(mcpLog).some((a) => a[0] === "mcp" && a[1] === "list")).toBe(true);
});

test("a user-wide server: add, read its settings, edit, recheck, remove", async () => {
  const input = { name: "notes", transport: "stdio", command: "/bin/echo", args: ["hi there"], env: [{ key: "NOTES_TOKEN", value: "env-value-123456" }] };
  const add = await user("POST", "/api/mcp", input);
  expect(add.status).toBe(201);
  expect(server(add.data, "notes")).toMatchObject({ name: "notes", scope: "user", transport: "stdio", status: "connected", boards: [] });
  // `claude mcp add --scope user --transport stdio <name> -e K=V -- <command> <args>`
  expect(readJsonl(mcpLog)).toContainEqual(["mcp", "add", "--scope", "user", "--transport", "stdio", "notes", "-e", "NOTES_TOKEN=env-value-123456", "--", "/bin/echo", "hi there"]);
  expect(userServers().notes).toEqual({ type: "stdio", command: "/bin/echo", args: ["hi there"], env: { NOTES_TOKEN: "env-value-123456" } });

  expect((await user("POST", "/api/mcp", input)).status).toBe(409);
  // The saved settings come back unmasked to the user's browser (env values included): the edit form fills them in.
  const cfg = await user("GET", "/api/mcp/notes/config");
  expect(cfg.status).toBe(200);
  expect(cfg.data).toMatchObject({ name: "notes", scope: "user", transport: "stdio", command: "/bin/echo", args: ["hi there"], env: [{ key: "NOTES_TOKEN", value: "env-value-123456" }] });
  expect(cfg.data.commandLine).toBe("NOTES_TOKEN=env-value-123456 /bin/echo 'hi there'");

  // Edit = remove then add with the new settings.
  const put = await user("PUT", "/api/mcp/notes", { name: "notes", transport: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "X-Team", value: "a" }] });
  expect(put.status).toBe(200);
  expect(server(put.data, "notes")).toMatchObject({ transport: "http", scope: "user" });
  expect(userServers().notes).toEqual({ type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Team": "a" } });

  expect((await user("POST", "/api/mcp/notes/recheck", {})).status).toBe(200);
  // A pasted sign-in address must be a full URL, and is refused while no sign-in is running.
  expect((await user("POST", "/api/mcp/notes/login-paste", { text: "not a url" })).status).toBe(400);
  expect((await user("POST", "/api/mcp/notes/login-paste", { text: "http://localhost:1/cb?code=x" })).status).toBe(409);
  expect((await user("POST", "/api/mcp/notes/cancel-login", {})).status).toBe(200);
  // Nothing left over from a move.
  expect((await user("POST", "/api/mcp/notes/retry-move", {})).status).toBe(404);

  const del = await user("DELETE", "/api/mcp/notes");
  expect(del.status).toBe(200);
  expect(server(del.data, "notes")).toBeUndefined();
  expect(userServers().notes).toBeUndefined();
  expect(readJsonl(mcpLog)).toContainEqual(["mcp", "remove", "notes", "--scope", "user"]);
});

test("validation and unknown servers", async () => {
  expect((await user("POST", "/api/mcp", { name: "bad name", transport: "stdio", command: "x" })).status).toBe(400);
  expect((await user("POST", "/api/mcp", { name: "x", transport: "stdio" })).status).toBe(400);
  expect((await user("POST", "/api/mcp", { name: "x", transport: "http", url: "ftp://x" })).status).toBe(400);
  expect((await user("POST", "/api/mcp", { name: "x", transport: "pigeon" })).status).toBe(400);
  expect((await user("POST", "/api/mcp", { name: "x", transport: "stdio", command: "a\nb" })).status).toBe(400);
  expect((await user("POST", "/api/mcp", { name: "x", transport: "stdio", command: "a", board: "nope" })).status).toBe(404);
  for (const [m, path] of [["GET", "/api/mcp/ghost/config"], ["DELETE", "/api/mcp/ghost"], ["POST", "/api/mcp/ghost/login"], ["POST", "/api/mcp/ghost/logout"]]) {
    const r = await user(m, path, m === "POST" ? {} : undefined);
    expect({ path, status: r.status }).toEqual({ path, status: 404 });
  }
  expect((await user("POST", "/api/mcp/ghost/move", { to: "sideways" })).status).toBe(400);
  expect((await d.api("GET", "/api/mcp/a/b/c")).status).toBe(404);
  // A stdio server has no sign-in.
  await user("POST", "/api/mcp", { name: "plain", transport: "stdio", command: "/bin/cat" });
  expect((await user("POST", "/api/mcp/plain/login", {})).status).toBe(400);
  expect((await user("POST", "/api/mcp/plain/logout", {})).status).toBe(400);
  expect((await user("DELETE", "/api/mcp/plain")).status).toBe(200);
});

test("a board-only tool: add, edit, move to all projects and back, remove; board-tools.json is owner-only", async () => {
  const input = { name: "sentry", transport: "http", url: "https://mcp.example.com/sentry", headers: [{ name: "Authorization", value: "Bearer board-tool-token-123" }], board: SLUG };
  const add = await user("POST", "/api/mcp", input);
  expect(add.status).toBe(201);
  expect(server(add.data, "sentry")).toMatchObject({ scope: "board", transport: "http", boards: [{ slug: SLUG, name: "Conn" }] });
  // No `claude mcp add` for a board tool: the board keeps it.
  expect(readJsonl(mcpLog).some((a) => a[1] === "add" && a.includes("sentry"))).toBe(false);
  expect(boardTools()).toEqual({ mcpServers: { sentry: { type: "http", url: "https://mcp.example.com/sentry", headers: { Authorization: "Bearer board-tool-token-123" } } } });
  expect(statSync(boardToolsFile()).mode & 0o777).toBe(0o600);
  expect(readFileSync(boardToolsFile(), "utf8").endsWith("}\n")).toBe(true);
  expect((await user("POST", "/api/mcp", input)).status).toBe(409);
  // The board's own tool name is taken.
  expect((await user("POST", "/api/mcp", { ...input, name: "ckanban" })).status).toBe(409);

  const cfg = await user("GET", `/api/mcp/sentry/config?board=${SLUG}`);
  expect(cfg.status).toBe(200);
  expect(cfg.data).toMatchObject({ name: "sentry", scope: "board", transport: "http", url: "https://mcp.example.com/sentry", headers: [{ name: "Authorization", value: "Bearer board-tool-token-123" }], commandLine: null });

  const put = await user("PUT", "/api/mcp/sentry", { ...input, url: "https://mcp.example.com/sentry2" });
  expect(put.status).toBe(200);
  expect(boardTools().mcpServers.sentry.url).toBe("https://mcp.example.com/sentry2");

  // "Use in all projects": `claude mcp add-json --scope user`, then gone from the board.
  const toAll = await user("POST", "/api/mcp/sentry/move", { to: "all", board: SLUG });
  expect(toAll.status).toBe(200);
  expect(readJsonl(mcpLog)).toContainEqual(["mcp", "add-json", "--scope", "user", "sentry", JSON.stringify({ type: "http", url: "https://mcp.example.com/sentry2", headers: { Authorization: "Bearer board-tool-token-123" } })]);
  expect(boardTools().mcpServers.sentry).toBeUndefined();
  expect(userServers().sentry.url).toBe("https://mcp.example.com/sentry2");
  expect(server(toAll.data, "sentry")).toMatchObject({ scope: "user" });

  // "Only this board": copied back as it is, the user-wide one removed.
  const toBoard = await user("POST", "/api/mcp/sentry/move", { to: "board", board: SLUG });
  expect(toBoard.status).toBe(200);
  expect(boardTools().mcpServers.sentry).toEqual({ type: "http", url: "https://mcp.example.com/sentry2", headers: { Authorization: "Bearer board-tool-token-123" } });
  expect(userServers().sentry).toBeUndefined();

  const del = await user("DELETE", `/api/mcp/sentry?board=${SLUG}`);
  expect(del.status).toBe(200);
  expect(server(del.data, "sentry")).toBeUndefined();
  expect(boardTools()).toEqual({ mcpServers: {} });
  expect((await user("DELETE", `/api/mcp/sentry?board=${SLUG}`)).status).toBe(404);
});

test("POST /api/mcp/refresh answers 202 and lists again", async () => {
  const before = readJsonl(mcpLog).filter((a) => a[1] === "list").length;
  const r = await user("POST", "/api/mcp/refresh", {});
  expect(r.status).toBe(202);
  expect(r.data).toHaveProperty("servers");
  await until(() => readJsonl(mcpLog).filter((a) => a[1] === "list").length > before, 10_000, "another claude mcp list");
});

test("changing Claude's tools and reading their settings is for the user only: runs and other programs get 403", async () => {
  const origin = { origin: d.url };
  const run = { "x-ckanban-run": `${SLUG}/t_x` };
  const huddle = { "x-ckanban-huddle-agent": "h_x/reviewer" };
  // A tool the user added, with a key in its settings.
  expect((await user("POST", "/api/mcp", { name: "keyed", transport: "stdio", command: "/bin/cat", env: [{ key: "KEYED_TOKEN", value: "keyed-secret-987654" }], board: SLUG })).status).toBe(201);
  const tries: [string, string, unknown?][] = [
    ["POST", "/api/mcp", { name: "fromrun", transport: "stdio", command: "/bin/sh", board: SLUG }],
    ["PUT", "/api/mcp/keyed", { name: "keyed", transport: "stdio", command: "/bin/sh", board: SLUG }],
    ["POST", "/api/mcp/keyed/move", { to: "all", board: SLUG }],
    ["POST", "/api/mcp/keyed/login", {}],
    ["POST", "/api/mcp/refresh", {}],
    ["DELETE", `/api/mcp/keyed?board=${SLUG}`],
    ["GET", `/api/mcp/keyed/config?board=${SLUG}`],
    ["POST", "/api/agents/codex/install", {}],
  ];
  for (const [m, path, body] of tries) {
    // A run's header, a huddle helper's header, and a program that isn't a browser (with or without the board's Origin).
    for (const headers of [{ ...run, ...origin }, { ...huddle, ...origin }, origin, {}]) {
      const r = await d.api(m, path, body, headers);
      expect({ m, path, headers, status: r.status }).toEqual({ m, path, headers, status: 403 });
      expect(r.text).not.toContain("keyed-secret-987654");
      expect(JSON.parse(r.text).error).toMatch(/user only/);
    }
  }
  // Nothing changed, and the list (which holds no settings) stays open to runs: the MCP tools read it.
  expect(boardTools().mcpServers.fromrun).toBeUndefined();
  expect(boardTools().mcpServers.keyed).toEqual({ type: "stdio", command: "/bin/cat", args: [], env: { KEYED_TOKEN: "keyed-secret-987654" } });
  const list = await d.api("GET", "/api/mcp", undefined, run);
  expect(list.status).toBe(200);
  expect(list.text).not.toContain("keyed-secret-987654");
  expect((await d.api("GET", "/api/agents", undefined, run)).status).toBe(200);
  // The user's browser reads it without an Origin, as a same-origin GET is sent.
  const cfg = await asUser(d.url, "GET", `/api/mcp/keyed/config?board=${SLUG}`, undefined, { noOrigin: true });
  expect(cfg.data.env).toEqual([{ key: "KEYED_TOKEN", value: "keyed-secret-987654" }]);
  expect((await user("DELETE", `/api/mcp/keyed?board=${SLUG}`)).status).toBe(200);
});

test("agents: register `ckanban mcp` with Codex (config.toml) and Claude Code (claude mcp add), and remove it", async () => {
  const st = await d.api("GET", "/api/agents");
  expect(st.status).toBe(200);
  expect(st.data.map((a: any) => a.id)).toEqual(["claude", "codex"]);
  for (const a of st.data) expect(a).toMatchObject({ installed: false, current: false, command: null });
  const codex = join(d.env.HOME, ".codex", "config.toml");
  expect(String(st.data[1].configPath)).toEndWith("/home/.codex/config.toml");

  const inst = await user("POST", "/api/agents/codex/install", {});
  expect(inst.status).toBe(200);
  expect(inst.data[1]).toMatchObject({ installed: true, current: true });
  expect(readFileSync(codex, "utf8")).toMatch(/^\[mcp_servers\.ckanban\]\ncommand = ".+"\nargs = \[.*"mcp"\]\n$/);
  expect((await user("POST", "/api/agents/codex/uninstall", {})).data[1].installed).toBe(false);
  expect(readFileSync(codex, "utf8")).not.toContain("ckanban");

  const c = await user("POST", "/api/agents/claude/install", {});
  expect(c.status).toBe(200);
  expect(c.data[0]).toMatchObject({ installed: true, current: true });
  expect(userServers().ckanban.args.at(-1)).toBe("mcp");
  expect((await user("POST", "/api/agents/claude/uninstall", {})).data[0].installed).toBe(false);
  expect(userServers().ckanban).toBeUndefined();

  expect((await user("POST", "/api/agents/gemini/install", {})).status).toBe(404);
  expect((await user("POST", "/api/agents/codex/reinstall", {})).status).toBe(404);
});

test("every file the connections tests left in the data folder is one data-files.md lists", () => {
  const patterns = documentedPaths();
  expect(filesUnder(d.home).filter((f) => !patterns.some((re) => re.test(f)))).toEqual([]);
});
