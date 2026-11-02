import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfig } from "../src/server/agents";
import { entryFromInput, inputFromEntry, readBoardTools, writeBoardTools } from "../src/server/board-tools";
import { Bus } from "../src/server/events";
import { boardToolsSource, McpManager, type BoardToolsSource } from "../src/server/mcp";
import { Store } from "../src/server/store";
import { tempDir, until } from "./helpers";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude-mcp.ts");

test("mcpConfig: the board's own tool alone, or merged with the board's tools", () => {
  const own = ["/bin/bun", "/src/cli.ts", "mcp"];
  expect(JSON.parse(mcpConfig(own))).toEqual({ mcpServers: { ckanban: { command: "/bin/bun", args: ["/src/cli.ts", "mcp"] } } });
  const merged = JSON.parse(mcpConfig(own, {
    cloudwatch: { type: "stdio", command: "uvx", args: ["cw"], env: { AWS_PROFILE: "x" } },
    docs: { type: "http", url: "https://d.dev/mcp", headers: { Authorization: "Bearer t" } },
    // A board entry can never replace the board's own tool.
    ckanban: { type: "stdio", command: "evil" },
  }));
  expect(Object.keys(merged.mcpServers).sort()).toEqual(["ckanban", "cloudwatch", "docs"]);
  expect(merged.mcpServers.ckanban.command).toBe("/bin/bun");
  expect(merged.mcpServers.docs.headers.Authorization).toBe("Bearer t");
});

test("board tools file: owner-only, round trip, odd content reads as empty", () => {
  const f = join(tempDir("ck-bt-"), "p", "board-tools.json");
  expect(readBoardTools(f)).toEqual({});
  writeBoardTools(f, { a: { type: "stdio", command: "x", args: [] } });
  expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: { a: { type: "stdio", command: "x", args: [] } } });
  expect(readBoardTools(f)).toEqual({ a: { type: "stdio", command: "x", args: [] } });
  writeFileSync(f, "{not json");
  expect(readBoardTools(f)).toEqual({});
});

test("entries convert to form input and back; odd shapes can't be read back", () => {
  const stdio = { name: "fs", transport: "stdio" as const, command: "npx", args: ["-y", "fs"], env: [{ key: "K", value: "v" }] };
  expect(inputFromEntry("fs", entryFromInput(stdio))).toEqual(stdio);
  const http = { name: "d", transport: "http" as const, url: "https://d.dev/mcp", headers: [{ name: "X-Key", value: "k" }] };
  expect(inputFromEntry("d", entryFromInput(http))).toEqual(http);
  expect(inputFromEntry("w", { type: "ws", url: "wss://x" })).toBeNull();
  expect(inputFromEntry("n", { command: 3 })).toBeNull();
  expect(inputFromEntry("e", { command: "x", env: ["A=1"] })).toBeNull();
});

test("the store keeps a board's tools in its own folder and deletes them with the board", () => {
  const store = new Store(tempDir("ck-bt-store-"));
  store.saveProfile({ slug: "p", name: "P", path: tempDir("ck-bt-proj-") } as any);
  store.saveBoardTools("p", { t: { type: "stdio", command: "/usr/bin/true", args: [] } });
  expect(store.boardToolsPath("p")).toBe(join(store.root, "profiles", "p", "board-tools.json"));
  expect(store.boardTools("p")).toEqual({ t: { type: "stdio", command: "/usr/bin/true", args: [] } });
  store.deleteProfile("p");
  expect(existsSync(store.boardToolsPath("p"))).toBe(false);
});

let dir: string;
let store: Store;
let mgr: McpManager;
let argsFile: string;
let cfgFile: string;

function setup(user: Record<string, unknown> = {}, source?: (s: Store) => BoardToolsSource) {
  dir = tempDir("ck-bt-mgr-");
  argsFile = join(dir, "args.log");
  cfgFile = join(dir, "claude.json");
  writeFileSync(argsFile, "");
  const state = Object.fromEntries(Object.entries(user).map(([n, e]: [string, any]) => [n, { target: e.url ? `${e.url} (HTTP)` : e.command, status: "✔ Connected" }]));
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(cfgFile, JSON.stringify({ mcpServers: user }));
  process.env.FAKE_MCP_STATE = join(dir, "state.json");
  process.env.FAKE_ARGS_FILE = argsFile;
  process.env.FAKE_CLAUDE_JSON = cfgFile;
  delete process.env.FAKE_REMOVE;
  delete process.env.FAKE_ADD;
  delete process.env.FAKE_SESSION;
  delete process.env.FAKE_LIST_MS;
  store = new Store(join(dir, "home"));
  store.saveProfile({ slug: "a", name: "Alpha", path: join(dir, "proj-a"), createdAt: "2026-01-01" } as any);
  store.saveProfile({ slug: "b", name: "Beta", path: join(dir, "proj-b"), createdAt: "2026-01-02" } as any);
  mgr = new McpManager(new Bus(), {
    claudeBin: FAKE, cwd: dir, configFile: cfgFile, probeTimeoutMs: 5000, boards: (source ?? boardToolsSource)(store),
  });
}

const calls = () => readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
const find = (name: string) => mgr.state().servers.find((s) => s.name === name);
const TRUE = { name: "probe", transport: "stdio" as const, command: "/usr/bin/true", args: [] };

beforeEach(() => setup());

test("a board-only tool goes in the board's file, shows with its board, and Claude's config is untouched", async () => {
  await mgr.refresh();
  await mgr.add({ ...TRUE, board: "a" });
  expect(store.boardTools("a")).toEqual({ probe: { type: "stdio", command: "/usr/bin/true", args: [] } });
  expect(store.boardTools("b")).toEqual({});
  expect(calls().some((c) => c[0] === "mcp" && c[1] === "add")).toBe(false);
  expect(find("probe")).toMatchObject({ scope: "board", boards: [{ slug: "a", name: "Alpha" }], move: { can: true, why: null } });
  // The probe session gets the board tools inline, so their status shows.
  await until(() => !mgr.state().checking);
  expect(find("probe")?.status).toBe("connected");
  expect(calls().some((c) => c[0] === "-p" && c.includes("--mcp-config"))).toBe(true);
});

test("name clashes: a user-wide tool or ckanban is refused, the same tool on two boards is fine", async () => {
  setup({ github: { type: "stdio", command: "npx", args: ["gh"] } });
  await mgr.refresh();
  await expect(mgr.add({ ...TRUE, name: "github", board: "a" })).rejects.toThrow("A tool called github is already on for all projects.");
  await expect(mgr.add({ ...TRUE, name: "ckanban", board: "a" })).rejects.toThrow(/belongs to the board's own tool/);
  await mgr.add({ ...TRUE, board: "a" });
  await expect(mgr.add({ ...TRUE, board: "a" })).rejects.toThrow(/already has a tool called probe/);
  await mgr.add({ ...TRUE, board: "b" });
  expect(find("probe")?.boards.map((b) => b.slug)).toEqual(["a", "b"]);
  // A user-wide tool can't take a board-only tool's name either.
  await expect(mgr.add({ ...TRUE })).rejects.toThrow(/already on Alpha, Beta only/);
  await expect(mgr.add({ ...TRUE, board: "nope" })).rejects.toThrow(/not found/);
});

test("edit and remove a board-only tool touch only that board's entry", async () => {
  await mgr.refresh();
  await mgr.add({ ...TRUE, board: "a" });
  await mgr.add({ ...TRUE, board: "b" });
  await mgr.update("probe", { ...TRUE, args: ["x"], env: [{ key: "TOKEN", value: "s3cret" }], board: "a" });
  expect(store.boardTools("a").probe).toEqual({ type: "stdio", command: "/usr/bin/true", args: ["x"], env: { TOKEN: "s3cret" } });
  expect(mgr.config("probe", "a")).toMatchObject({ scope: "board", args: ["x"], commandLine: "TOKEN=s3cret /usr/bin/true x" });
  expect(store.boardTools("b").probe.args).toEqual([]);
  // The list never shows the secret.
  expect(JSON.stringify(mgr.state())).not.toContain("s3cret");
  await mgr.remove("probe", "a");
  expect(store.boardTools("a")).toEqual({});
  expect(find("probe")?.boards.map((b) => b.slug)).toEqual(["b"]);
});

test("move to this board: board entry first (as it was), then the user-wide one is removed", async () => {
  const entry = { type: "http", url: "https://d.dev/mcp", headers: { Authorization: "Bearer t" }, oauth: { clientId: "c" } };
  setup({ docs: entry });
  await mgr.refresh();
  expect(find("docs")).toMatchObject({ scope: "user", move: { can: true } });
  await mgr.moveToBoard("docs", "a");
  // Kept exactly, so a sign-in made for it still matches (Claude keys it by name + address + headers).
  expect(store.boardTools("a").docs).toEqual(entry);
  expect(calls().some((c) => c.join(" ") === "mcp remove docs --scope user")).toBe(true);
  await until(() => !mgr.state().checking);
  expect(find("docs")).toMatchObject({ scope: "board", boards: [{ slug: "a", name: "Alpha" }], leftover: null });
});

test("move to this board whose second step fails leaves both copies, then Try again finishes it", async () => {
  setup({ fs: { type: "stdio", command: "npx", args: ["fs"] } });
  await mgr.refresh();
  process.env.FAKE_REMOVE = "fail";
  await mgr.moveToBoard("fs", "a");
  expect(store.boardTools("a").fs).toBeDefined();
  expect(find("fs")).toMatchObject({ scope: "user", boards: [{ slug: "a", name: "Alpha" }] });
  expect(find("fs")?.leftover).toContain("config is locked");
  await expect(mgr.retryMove("fs")).rejects.toThrow(/still couldn't be removed/);
  delete process.env.FAKE_REMOVE;
  await mgr.retryMove("fs");
  await until(() => !mgr.state().checking);
  expect(find("fs")).toMatchObject({ scope: "board", leftover: null });
});

test("move to all projects: added user-wide as it is first, then dropped from every board", async () => {
  await mgr.refresh();
  await mgr.add({ ...TRUE, env: [{ key: "API_KEY", value: "k" }], board: "a" });
  await mgr.add({ ...TRUE, board: "b" });
  await mgr.moveToUser("probe", "a");
  const add = calls().find((c) => c[1] === "add-json")!;
  expect(add.slice(0, 5)).toEqual(["mcp", "add-json", "--scope", "user", "probe"]);
  expect(JSON.parse(add[5])).toEqual({ type: "stdio", command: "/usr/bin/true", args: [], env: { API_KEY: "k" } });
  expect(store.boardTools("a")).toEqual({});
  expect(store.boardTools("b")).toEqual({});
  expect(JSON.parse(readFileSync(cfgFile, "utf8")).mcpServers.probe).toBeDefined();
  await until(() => !mgr.state().checking);
  expect(find("probe")).toMatchObject({ scope: "user", boards: [], leftover: null });
});

test("move to all projects whose second step fails leaves both copies, then Try again finishes it", async () => {
  let failing = true;
  setup({}, (s) => {
    const base = boardToolsSource(s);
    return { ...base, write: (slug, servers) => {
      if (failing && !servers.probe) throw new Error("disk full");
      base.write(slug, servers);
    } };
  });
  await mgr.refresh();
  await mgr.add({ ...TRUE, board: "a" });
  await mgr.moveToUser("probe", "a");
  expect(store.boardTools("a").probe).toBeDefined();
  expect(find("probe")?.leftover).toBe("disk full");
  failing = false;
  await mgr.retryMove("probe");
  expect(store.boardTools("a")).toEqual({});
  expect(find("probe")?.leftover ?? null).toBeNull();
});

test("a failed first step of a move changes nothing", async () => {
  await mgr.refresh();
  await mgr.add({ ...TRUE, board: "a" });
  process.env.FAKE_ADD = "fail";
  await expect(mgr.moveToUser("probe", "a")).rejects.toThrow(/add failed/);
  expect(store.boardTools("a").probe).toBeDefined();
  expect(find("probe")?.leftover).toBeNull();
});

test("a tool whose setup can't be read back can't move, and says why", async () => {
  setup({ odd: { type: "ws", url: "wss://x.dev" }, ckanban: { command: "ck", args: ["mcp"] } });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ odd: { target: "wss://x.dev", status: "✔ Connected" }, ckanban: { target: "ck mcp", status: "✔ Connected" } }));
  await mgr.refresh();
  expect(find("odd")?.move).toEqual({ can: false, why: "Can't move: the board can't read back how this tool was set up." });
  await expect(mgr.moveToBoard("odd", "a")).rejects.toThrow(/can't read back/);
  // The board's own tool never moves.
  expect(find("ckanban")?.move).toEqual({ can: false, why: null });
  await expect(mgr.moveToBoard("ckanban", "a")).rejects.toThrow(/can't be moved/);
});

test("signing in to a board-only tool runs in the board's sign-in folder with a temporary copy", async () => {
  await mgr.refresh();
  await mgr.add({ name: "docs", transport: "http", url: "https://d.dev/mcp", board: "a" });
  writeFileSync(process.env.FAKE_MCP_STATE!, JSON.stringify({ docs: { target: "https://d.dev/mcp (HTTP)", status: "! Needs authentication" } }));
  mgr.login("docs");
  await until(() => calls().some((c) => c.join(" ") === "mcp remove docs --scope local") && calls().filter((c) => c[1] === "remove").length >= 2);
  const c = calls().map((x) => x.slice(0, 5).join(" "));
  expect(c).toContain("mcp add-json --scope local docs");
  expect(c.some((x) => x.startsWith("mcp login docs"))).toBe(true);
  mgr.cancelLogin("docs");
});
