// Outside-in contract: the board's passes (keys and services automations use), keys saved for one board (the ask_keys
// box in a ticket chat), the masking of saved values in every answer, check scripts (`loops/test`, `automation-call`),
// key backups (the `backup_file` tool of `ckanban mcp`) and bug reports. See contracts/api.md ("Connections",
// "Automations", "System and misc", ".../key-cards") and contracts/data-files.md (automation-passes.json, .key-backups).
//
// User-only routes refuse this test process on the local port (it is not the user's browser), so the user's own
// actions go through phone access (phone.ts), where the owner's phone is the user.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_CMD, type Daemon, startDaemon, until } from "./daemon";
import { documentedPaths, filesUnder, readJsonl } from "./files";
import { phone, writeRemoteJson } from "./phone";

let d: Daemon;
const SLUG = "keys";
const OTHER = "other";
const dir = mkdtempSync(join(tmpdir(), "ck-contract-keys-"));
const argsFile = join(dir, "claude-args.jsonl");
const ghLog = join(dir, "gh.jsonl");
// Long and unusual, so finding one in an answer can't be an accident.
const AUTOMATION_KEY = "lin_api_AUTOMATION_value_7f3c9e21";
const AUTOMATION_KEY_2 = "lin_api_REPLACED_value_0a8b6d44";
const BOARD_KEY = "sntrys_BOARD_value_5d1e8a90c2";
const LOCAL_ORIGIN = () => ({ origin: `http://127.0.0.1:${d.port}` });
const passesFile = () => join(d.home, "automation-passes.json");
const stored = () => JSON.parse(readFileSync(passesFile(), "utf8"));

beforeAll(async () => {
  d = await startDaemon({
    env: {
      FAKE_ARGS_FILE: argsFile,
      FAKE_ENV_KEYS: "SENTRY_AUTH_TOKEN,LINEAR_KEY",
      // Every run of the fake Claude asks for keys with the ask_keys box (tool use id tu_keys).
      FAKE_ASK_KEYS: JSON.stringify({ keys: [{ envName: "SENTRY_AUTH_TOKEN", label: "Sentry auth token" }, { envName: "OTHER_TOKEN", label: "Other" }], reason: "to upload source maps" }),
      GH_LOG: ghLog,
    },
    // `gh issue create` for bug reports: records its arguments, prints an issue address. Never the real gh.
    stubs: { gh: `#!/bin/sh\n"${process.execPath}" -e 'require("fs").appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(1)) + "\\n")' -- "$@"\necho https://github.com/example/ckanban/issues/42\n` },
    before: ({ home }) => writeRemoteJson(home, true),
  });
  expect((await d.api("POST", "/api/profiles", { name: "Keys", path: d.project })).status).toBe(201);
  const other = mkdtempSync(join(tmpdir(), "ck-contract-other-"));
  expect((await d.api("POST", "/api/profiles", { name: "Other", path: other })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

let automationId = "";
let boardKeyId = "";

test("GET /api/passes on a new data folder", async () => {
  const r = await d.api("GET", "/api/passes");
  expect(r.status).toBe(200);
  expect(r.data).toEqual({ passes: [], automations: 0 });
});

test("adding, replacing and removing a pass is for the user only", async () => {
  const add = { kind: "key", name: "Linear", secret: AUTOMATION_KEY };
  // This test process on the local port: with or without the board's Origin, it isn't the user's browser.
  for (const headers of [{}, LOCAL_ORIGIN()]) {
    const r = await d.api("POST", "/api/passes", add, headers);
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/is for the user only/);
  }
  // A board run, even from the phone listener.
  expect((await phone(d, "POST", "/api/passes", add, { "x-ckanban-run": `${SLUG}/t_x` })).status).toBe(403);
  expect((await phone(d, "POST", "/api/passes", add, { "x-ckanban-huddle-agent": "tok" })).status).toBe(403);
  expect(existsSync(passesFile())).toBe(false);
  // Quirk: under /api/passes/:id the user check runs before the route is matched, so even an unknown action is 403.
  expect((await d.api("POST", "/api/passes/nope/whatever", {})).status).toBe(403);
  expect((await d.api("PATCH", "/api/passes/nope", { secret: "x" }, LOCAL_ORIGIN())).status).toBe(403);
  expect((await d.api("DELETE", "/api/passes/nope", undefined, LOCAL_ORIGIN())).status).toBe(403);
  expect((await d.api("POST", "/api/passes/nope/authorize", {}, LOCAL_ORIGIN())).status).toBe(403);
});

test("a key for automations: saved owner-only, its value never in an answer", async () => {
  const r = await phone(d, "POST", "/api/passes", { kind: "key", name: "Linear", secret: `  ${AUTOMATION_KEY}  ` });
  expect(r.status).toBe(201);
  expect(r.text).not.toContain(AUTOMATION_KEY);
  expect(r.data).toMatchObject({ kind: "key", name: "Linear", claudeName: null, url: null, envName: "LINEAR_KEY", board: null, status: "connected", error: null });
  expect(r.data).not.toHaveProperty("secret");
  expect(r.data.savedAt).toBe(r.data.createdAt);
  automationId = r.data.id;

  // automation-passes.json: { version: 1, passes: Pass[] }, owner-only, pretty with a final newline, value trimmed.
  expect(statSync(passesFile()).mode & 0o777).toBe(0o600);
  expect(readFileSync(passesFile(), "utf8").endsWith("}\n")).toBe(true);
  expect(stored()).toEqual({ version: 1, passes: [expect.objectContaining({ id: automationId, kind: "key", envName: "LINEAR_KEY", secret: AUTOMATION_KEY })] });

  const list = await d.api("GET", "/api/passes");
  expect(list.text).not.toContain(AUTOMATION_KEY);
  expect(list.data).toEqual({ passes: [expect.objectContaining({ id: automationId, usedBy: 0, usedByNames: [], boardName: null })], automations: 0 });
});

test("pass validation", async () => {
  const bad: [Record<string, unknown>, number][] = [
    [{ kind: "key", name: "Empty", secret: "  " }, 400],
    [{ kind: "key", name: "Two lines", secret: "a\nb" }, 400],
    [{ kind: "key", secret: "nameless-1234" }, 400],
    [{ kind: "key", name: "Bad env", envName: "lower", secret: "x-12345678" }, 400],
    [{ kind: "key", name: "Reserved", envName: "PATH", secret: "x-12345678" }, 400],
    // Same envName for automations again.
    [{ kind: "key", name: "Linear 2", envName: "LINEAR_KEY", secret: "x-12345678" }, 409],
    [{ kind: "key", name: "Board", board: "nope", secret: "x-12345678" }, 400],
    // A board's key can't use a name the board or Claude uses itself.
    [{ kind: "key", name: "Board", board: SLUG, envName: "CLAUDE_KEY", secret: "x-12345678" }, 400],
    [{ kind: "key", name: "Board", board: SLUG, url: "https://mcp.example.com", secret: "x-12345678" }, 400],
    [{ kind: "mcp", url: "http://mcp.example.com/mcp" }, 400],
    [{ kind: "local" }, 400],
    [{ kind: "local", claudeName: "not-in-claude-config" }, 404],
    [{ kind: "pigeon" }, 400],
  ];
  for (const [b, status] of bad) {
    const r = await phone(d, "POST", "/api/passes", b);
    expect({ b, status: r.status }).toEqual({ b, status });
  }
  expect(stored().passes).toHaveLength(1);
});

test("replacing a key: PATCH /api/passes/:id {secret}", async () => {
  const before = stored().passes[0];
  await Bun.sleep(5);
  const r = await phone(d, "PATCH", `/api/passes/${automationId}`, { secret: AUTOMATION_KEY_2 });
  expect(r.status).toBe(200);
  expect(r.text).not.toContain(AUTOMATION_KEY_2);
  expect(r.data.createdAt).toBe(before.createdAt);
  expect(Date.parse(r.data.savedAt)).toBeGreaterThan(Date.parse(before.createdAt));
  expect(stored().passes[0].secret).toBe(AUTOMATION_KEY_2);
  expect((await phone(d, "PATCH", `/api/passes/${automationId}`, { secret: "" })).status).toBe(400);
  expect((await phone(d, "PATCH", "/api/passes/missing", { secret: "abc-12345678" })).status).toBe(404);
});

test("an online service (mcp pass): pending until signed in; tools and sign-in errors", async () => {
  // A local "service" that knows no OAuth: discovery fails.
  const svc = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no", { status: 404 }) });
  try {
    const r = await phone(d, "POST", "/api/passes", { kind: "mcp", url: `http://127.0.0.1:${svc.port}/mcp` });
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ kind: "mcp", name: `127.0.0.1:${svc.port}`, status: "pending", url: `http://127.0.0.1:${svc.port}/mcp` });
    const id = r.data.id;
    // Not signed in yet: its tools can't be listed (502 with a masked message).
    const tools = await d.api("GET", `/api/passes/${id}/tools`);
    expect(tools.status).toBe(502);
    expect(tools.data.error).toMatch(/isn't signed in yet/);
    const auth = await phone(d, "POST", `/api/passes/${id}/authorize`, {});
    expect([409, 502]).toContain(auth.status);
    if (auth.status === 409) expect(auth.data.code).toBe("no_registration");
    // A key has no sign-in step.
    expect((await phone(d, "POST", `/api/passes/${automationId}/authorize`, {})).status).toBe(400);
    expect((await phone(d, "DELETE", `/api/passes/${id}`)).status).toBe(204);
  } finally {
    svc.stop(true);
  }
  // A key for scripts is no service to call.
  const t = await d.api("GET", `/api/passes/${automationId}/tools`);
  expect(t.status).toBe(400);
  expect((await d.api("GET", "/api/passes/missing/tools")).status).toBe(404);
});

test("the sign-in callback answers HTML on this Mac and JSON 403 on the phone", async () => {
  const denied = await fetch(`${d.url}/api/passes/oauth/callback?error=access_denied&error_description=${encodeURIComponent("<b>no</b>")}`);
  expect(denied.status).toBe(400);
  expect(denied.headers.get("content-type")).toContain("text/html");
  const html = await denied.text();
  expect(html).toContain("Not connected");
  expect(html).toContain("&#60;b&#62;no&#60;/b&#62;");
  const stale = await fetch(`${d.url}/api/passes/oauth/callback?state=made-up&code=x`);
  expect(stale.status).toBe(400);
  expect(await stale.text()).toContain("not valid any more");
  const fromPhone = await phone(d, "GET", "/api/passes/oauth/callback?state=x&code=y");
  expect(fromPhone.status).toBe(403);
  expect(fromPhone.data.error).toBe("sign in from the computer ckanban runs on");
});

let ticketId = "";

test("the ask_keys box: Save stores the key for the board; the next run gets it as an environment variable", async () => {
  const t = (await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Needs a key", body: "upload maps" })).data;
  ticketId = t.id;
  const base = `/api/profiles/${SLUG}/tickets/${t.id}`;
  expect((await d.api("POST", `${base}/chat`, { text: "go" })).status).toBe(202);
  await until(async () => {
    const r = (await d.api("GET", base)).data;
    return r.runEndedAt && !r.running;
  }, 20_000, "the run that asks for keys");
  const answer = { keys: { SENTRY_AUTH_TOKEN: BOARD_KEY, NOT_ASKED: "ignored-value-123456" } };

  // User only.
  expect((await d.api("POST", `${base}/key-cards/tu_keys`, answer)).status).toBe(403);
  expect((await d.api("POST", `${base}/key-cards/tu_keys`, answer, LOCAL_ORIGIN())).status).toBe(403);
  expect((await phone(d, "POST", `${base}/key-cards/tu_keys`, answer, { "x-ckanban-run": `${SLUG}/${t.id}` })).status).toBe(403);
  // No box with that id; no key given.
  expect((await phone(d, "POST", `${base}/key-cards/tu_none`, answer)).status).toBe(404);
  expect((await phone(d, "POST", `${base}/key-cards/tu_keys`, { keys: { SENTRY_AUTH_TOKEN: "  " } })).status).toBe(400);
  expect(existsSync(passesFile()) && stored().passes.some((p: any) => p.board === SLUG)).toBe(false);

  const runsBefore = readJsonl(argsFile).length;
  const r = await phone(d, "POST", `${base}/key-cards/tu_keys`, answer);
  expect(r.status).toBe(202);
  expect(r.text).not.toContain(BOARD_KEY);
  expect(r.data.keyCards.tu_keys).toMatchObject({ saved: ["SENTRY_AUTH_TOKEN"] });
  // Answered once.
  expect((await phone(d, "POST", `${base}/key-cards/tu_keys`, answer)).status).toBe(409);

  // Saved as a board key in the one pass store; only the names the box asked for.
  const key = stored().passes.find((p: any) => p.board === SLUG);
  expect(key).toMatchObject({ kind: "key", name: "Sentry auth token", envName: "SENTRY_AUTH_TOKEN", board: SLUG, secret: BOARD_KEY, status: "connected" });
  boardKeyId = key.id;
  expect(JSON.stringify(stored())).not.toContain("ignored-value-123456");

  // The ticket goes on in a new run that has the key in its environment; its message names the key, never the value.
  const next = await until(() => readJsonl(argsFile).slice(runsBefore).find((a) => a.env?.SENTRY_AUTH_TOKEN), 20_000, "the run after Save");
  expect(next.env.SENTRY_AUTH_TOKEN).toBe(BOARD_KEY);
  expect(next.prompt).toContain("$SENTRY_AUTH_TOKEN (Sentry auth token)");
  expect(JSON.stringify(next.args) + next.prompt).not.toContain(BOARD_KEY);
  // A key saved for one board never reaches the automations-only key's name in runs.
  expect(next.env.LINEAR_KEY).toBeNull();

  const list = await d.api("GET", "/api/passes");
  expect(list.data.passes.find((p: any) => p.id === boardKeyId)).toMatchObject({ board: SLUG, boardName: "Keys", envName: "SENTRY_AUTH_TOKEN" });
});

test("a saved value is masked in every answer, and in comments as they are saved", async () => {
  // A ticket whose text holds both saved values (as a user might paste them by mistake).
  const text = `board ${BOARD_KEY} and automation ${AUTOMATION_KEY_2}`;
  const made = await d.api("POST", `/api/profiles/${SLUG}/tickets`, { title: "Pasted keys", body: text });
  expect(made.status).toBe(201);
  const base = `/api/profiles/${SLUG}/tickets/${made.data.id}`;
  for (const [what, r] of [
    ["create", made],
    ["read", await d.api("GET", base)],
    ["board list", await d.api("GET", `/api/profiles/${SLUG}/tickets`)],
    ["every board", await d.api("GET", "/api/tickets")],
    ["passes", await d.api("GET", "/api/passes")],
    ["comment", await d.api("POST", `${base}/comments`, { text })],
  ] as const) {
    expect({ what, board: r.text.includes(BOARD_KEY), automation: r.text.includes(AUTOMATION_KEY_2) }).toEqual({ what, board: false, automation: false });
  }
  expect((await d.api("GET", base)).data.body).toBe("board *** and automation ***");
  // comments.jsonl holds the masked text.
  const comments = readFileSync(join(d.home, "profiles", SLUG, "tickets", made.data.id, "comments.jsonl"), "utf8");
  expect(comments).not.toContain(BOARD_KEY);
  expect(comments).toContain("board *** and automation ***");
});

test("check scripts (loops/test): keys arrive as environment variables, output is masked, ckanban call needs the check's token", async () => {
  const script = [
    'echo "seen $LINEAR_KEY" >&2',
    // The token the check got works for automation-call (this service isn't one of its passes).
    'curl -s -X POST -H "content-type: application/json" "http://127.0.0.1:$CKANBAN_PORT/api/automation-call" -d "{\\"token\\":\\"$CKANBAN_CALL_TOKEN\\",\\"service\\":\\"nope\\",\\"tool\\":\\"x\\"}" >&2',
    'echo "[{\\"id\\":\\"1\\",\\"title\\":\\"key $LINEAR_KEY\\"},{\\"id\\":\\"2\\",\\"title\\":\\"plain\\"}]"',
  ].join("\n");
  const r = await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script, passes: ["Linear"] });
  expect(r.status).toBe(200);
  expect(r.text).not.toContain(AUTOMATION_KEY_2);
  expect(r.data).toMatchObject({ found: 2, error: null, toolsUsed: [] });
  expect(r.data.items).toEqual([{ id: "1", title: "key ***" }, { id: "2", title: "plain" }]);
  expect(r.data.stderr).toContain("seen ***");
  expect(r.data.stderr).toContain("This automation can't use");
  // The scratch script is removed afterwards.
  expect(readdirSync(join(d.home, "automation-tests"))).toEqual([]);

  // A board's key reaches only that board's checks.
  const own = await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script: 'echo "[{\\"id\\":\\"k\\",\\"title\\":\\"$SENTRY_AUTH_TOKEN\\"}]"', passes: [boardKeyId] });
  expect(own.status).toBe(200);
  expect(own.data.items).toEqual([{ id: "k", title: "***" }]);
  expect((await d.api("POST", `/api/profiles/${OTHER}/loops/test`, { script: "echo []", passes: [boardKeyId] })).status).toBe(400);

  // Errors.
  expect((await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script: "  " })).status).toBe(400);
  expect((await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script: "echo []", passes: "Linear" })).status).toBe(400);
  expect((await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script: "echo []", passes: ["Unknown"] })).status).toBe(400);
  const failing = await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script: "echo oops >&2; exit 3" });
  expect(failing.status).toBe(200);
  expect(failing.data).toMatchObject({ items: [], found: 0, error: "The check failed (exit 3): oops" });
  const notJson = await d.api("POST", `/api/profiles/${SLUG}/loops/test`, { script: "echo hello" });
  expect(notJson.data.error).toMatch(/isn't JSON/);
  // Outside a check, a call token is refused.
  const call = await d.api("POST", "/api/automation-call", { token: "made-up", service: "Linear", tool: "x" });
  expect(call.status).toBe(403);
  expect(call.data.error).toBe("ckanban call only works inside an automation's check");
}, 30_000);

/** Calls one tool of `ckanban mcp` over stdio (JSON-RPC lines), as Claude Code does, outside a run. */
async function mcpTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const p = Bun.spawn([...CLI_CMD, "mcp"], { env: d.env, cwd: d.project, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const send = (m: unknown) => p.stdin.write(JSON.stringify(m) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  p.stdin.flush();
  const reader = p.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`ckanban mcp ended: ${await new Response(p.stderr).text()}`);
      buf += dec.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 2) return { text: (m.result?.content ?? []).map((c: any) => c.text).join(""), isError: !!m.result?.isError || !!m.error };
      }
    }
  } finally {
    p.kill();
  }
}

test("backup_file: a private copy in the board's .key-backups, never its contents in the answer", async () => {
  const env = join(d.project, ".env");
  writeFileSync(env, `SENTRY_AUTH_TOKEN=${BOARD_KEY}\nOTHER=1\n`);
  const r = await mcpTool("backup_file", { path: ".env", profile: SLUG });
  expect(r.isError).toBe(false);
  expect(r.text).toStartWith("Saved a private copy of ");
  expect(r.text).not.toContain(BOARD_KEY);
  const base = join(d.home, "profiles", SLUG, ".key-backups");
  expect(statSync(base).mode & 0o777).toBe(0o700);
  const [folder] = readdirSync(base);
  // <hash12>-<safe name>
  expect(folder).toMatch(/^[0-9a-f]{12}-\.env$/);
  expect(statSync(join(base, folder)).mode & 0o777).toBe(0o700);
  const [copy] = readdirSync(join(base, folder));
  expect(copy).toMatch(/^\d{8}T\d{9}Z(-\d+)?$/);
  expect(statSync(join(base, folder, copy)).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(base, folder, copy), "utf8")).toBe(readFileSync(env, "utf8"));
  expect(r.text).toContain(join(folder, copy));

  // Five copies kept: the first and the newest.
  for (let i = 0; i < 6; i++) await mcpTool("backup_file", { path: env, profile: SLUG });
  const copies = readdirSync(join(base, folder)).sort();
  expect(copies).toHaveLength(5);
  expect(copies[0]).toBe(copy);

  // A missing file is not an error: nothing copied.
  const missing = await mcpTool("backup_file", { path: "nope.env", profile: SLUG });
  expect(missing.isError).toBe(false);
  expect(missing.text).toContain("doesn't exist: nothing to back up");
  expect(readdirSync(base)).toEqual([folder]);
}, 60_000);

test("bug reports: draft, then `gh issue create`; 201 with the issue, 400 without a title; saved keys are masked in the answers", async () => {
  const draft = await d.api("POST", "/api/bug-report/draft", { profile: SLUG, ticketId });
  expect(draft.status).toBe(200);
  expect(draft.data.blocks.map((b: any) => b.id)).toContain("env");
  expect(draft.data.blocks.map((b: any) => b.id)).toContain("ticket");
  expect(draft.text).not.toContain(BOARD_KEY);
  expect(draft.text).not.toContain(d.home);
  expect((await d.api("POST", "/api/bug-report/draft", { profile: SLUG, ticketId: "t_missing" })).status).toBe(404);
  expect((await d.api("POST", "/api/bug-report/draft", { profile: "nope", ticketId: "t_x" })).status).toBe(404);

  expect((await d.api("POST", "/api/bug-report", { title: "  ", description: "x" })).status).toBe(400);
  expect((await d.api("POST", "/api/bug-report", { title: "x".repeat(201), description: "x" })).status).toBe(400);
  expect(readJsonl(ghLog)).toEqual([]);

  const r = await d.api("POST", "/api/bug-report", { title: "Board froze", description: "It froze.", source: "ai" });
  expect(r.status).toBe(201);
  expect(r.data).toMatchObject({ url: "https://github.com/example/ckanban/issues/42", error: null, screenshots: [] });
  const [gh] = readJsonl(ghLog);
  expect(gh.slice(0, 2)).toEqual(["issue", "create"]);
  expect(gh[gh.indexOf("--title") + 1]).toBe("Board froze");
  expect(gh.filter((a: string, i: number) => gh[i - 1] === "--label")).toEqual(["bug", "from-ai"]);
  expect(gh[gh.indexOf("--body") + 1]).toContain("It froze.");
});

test("every file the passes, keys, backups and scripts tests left in the data folder is one data-files.md lists", () => {
  const patterns = documentedPaths();
  expect(filesUnder(d.home).filter((f) => !patterns.some((re) => re.test(f)))).toEqual([]);
});
