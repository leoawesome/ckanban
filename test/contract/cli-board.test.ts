// Outside-in contract for the board commands of `ckanban` that tickets.test.ts doesn't reach: the exact routes,
// bodies and headers they send, what they print for each answer, exit codes, argument parsing, picking the board,
// the read-only rule inside runs, `call`, and the stdio MCP server's protocol. A fake board server (cli-support.ts)
// stands in for the daemon, so every answer shape (setup failed, device busy, bug report fallback, 202 confirm...)
// can be tested without a real run, GitHub or devices. See contracts/cli.md sections 1, 3, 4 and 6.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contractBlock, type FakeBoard, fakeBoard, REPO, type Sandbox, type Seen, sandbox } from "./cli-support";

let sb: Sandbox;
let fb: FakeBoard;
let projA: string;
let projB: string;
let outside: string;

const ID = "t_20261116_abcd";
const ticket = (over: Record<string, unknown> = {}) => ({
  id: ID, title: "Fix it", status: "backlog", mode: "interview", body: "", outcome: null, prUrl: null, branch: null,
  lastActivity: null, error: null, createdAt: "2026-11-16T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", ...over,
});
const profiles = () => [
  { name: "Alpha", slug: "alpha", path: projA, baseBranch: "" },
  // Inside Alpha's folder: the deepest folder wins.
  { name: "Beta Board", slug: "beta", path: projB, baseBranch: "main" },
];

/** Answers /api/profiles, then `rest`. */
function serve(rest: (r: Seen) => ReturnType<FakeBoard["answer"]> = () => undefined) {
  fb.reset((r) => (r.method === "GET" && r.path === "/api/profiles" ? { json: profiles() } : rest(r)));
}
const run = (args: string[], o: Parameters<Sandbox["run"]>[1] = {}) =>
  sb.run(args, { ...o, cwd: o.cwd ?? projA, env: { CKANBAN_PORT: String(fb.port), ...o.env } });
/** Requests other than the profile lookup. */
const calls = () => fb.seen.filter((r) => r.path !== "/api/profiles");

beforeAll(() => {
  sb = sandbox();
  fb = fakeBoard();
  projA = join(sb.root, "alpha");
  projB = join(projA, "packages", "beta");
  outside = join(sb.root, "elsewhere");
  for (const d of [projB, join(projB, "deep"), outside]) mkdirSync(d, { recursive: true });
});

afterAll(() => {
  fb?.stop();
  sb?.cleanup();
});

describe("profiles", () => {
  test("empty board list, and --json prints the answer", async () => {
    fb.reset(() => ({ json: [] }));
    expect(await run(["profiles"])).toEqual({ code: 0, stdout: "No profiles yet; add one on the board first.\n", stderr: "" });
    serve();
    const r = await run(["profiles", "--json"]);
    expect(r.stdout).toBe(JSON.stringify(profiles(), null, 2) + "\n");
    expect(fb.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /api/profiles"]);
    expect(fb.seen[0].headers.host).toBe(`127.0.0.1:${fb.port}`);
  });
});

describe("picking the board", () => {
  const list = () => `Profiles:\n  alpha  (Alpha, ${projA})\n  beta  (Beta Board, ${projB})`;

  test("the deepest board folder containing the cwd; --profile by slug or name; CKANBAN_TICKET's board", async () => {
    serve(() => ({ json: { tickets: [], total: 0, doneLeft: 0, next: null } }));
    const path = (slug: string) => `/api/profiles/${slug}/tickets?scope=list`;
    await run(["ticket", "list"]);
    await run(["ticket", "list"], { cwd: join(projB, "deep") });
    await run(["ticket", "list", "--profile", "beta"]);
    await run(["ticket", "list", "--profile", "ALPHA"], { cwd: projB });
    await run(["ticket", "list"], { cwd: projA, env: { CKANBAN_TICKET: `beta/${ID}` } });
    expect(calls().map((s) => s.path)).toEqual([path("alpha"), path("beta"), path("beta"), path("alpha"), path("beta")]);
  });

  test("no match: the error lists the boards", async () => {
    serve();
    const a = await run(["ticket", "list"], { cwd: outside });
    expect(a).toEqual({ code: 1, stdout: "", stderr: `no profile matches ${outside}; pass a profile. ${list()}\n` });
    const b = await run(["ticket", "list", "--profile", "gamma"]);
    expect(b).toEqual({ code: 1, stdout: "", stderr: `no profile "gamma". ${list()}\n` });
  });
});

describe("read-only inside board runs", () => {
  test("changing commands fail before any HTTP call", async () => {
    serve(() => ({ json: ticket() }));
    const env = { CKANBAN_TICKET: `alpha/${ID}` };
    const msg = `changing the board is disabled inside a board run (CKANBAN_TICKET=alpha/${ID}), so runs can't create or start other runs. Reading tickets still works; ask the user to make this change on the board.\n`;
    for (const args of [
      ["ticket", "create", "--title", "x"], ["ticket", "update", ID, "--title", "x"], ["ticket", "move", ID, "done"], ["ticket", "chat", ID, "hi"],
      ["ticket", "comment", ID, "hi"], ["ticket", "stop", ID], ["ticket", "delete", ID],
    ]) {
      expect(await run(args, { env })).toEqual({ code: 1, stdout: "", stderr: msg });
    }
    expect(fb.seen).toEqual([]);
  });
});

describe("ticket chat, comment, stop, delete", () => {
  const T = `/api/profiles/alpha/tickets/${ID}`;

  test("chat sends { text } and says whether Claude is working", async () => {
    let running = true;
    serve((r) => (r.method === "POST" && r.path === `${T}/chat` ? { json: ticket({ running }) } : undefined));
    expect(await run(["ticket", "chat", ID, "hello", "there "])).toEqual({ code: 0, stdout: `Sent to ${ID}; Claude is working on it.\n`, stderr: "" });
    running = false;
    expect((await run(["ticket", "chat", ID, "--message", "via flag"])).stdout).toBe(`Sent to ${ID}.\n`);
    expect(calls().map((s) => s.body)).toEqual([{ text: "hello there" }, { text: "via flag" }]);
    expect(calls()[0].headers["content-type"]).toBe("application/json");
    expect(calls()[0].headers["x-ckanban-run"]).toBeUndefined();
    expect(await run(["ticket", "chat", ID])).toEqual({ code: 1, stdout: "", stderr: "usage: ckanban ticket chat <id> <message>\n" });
    expect(await run(["ticket", "chat"])).toEqual({ code: 1, stdout: "", stderr: "usage: ckanban ticket chat <id> <message>\n" });
  });

  test("comment sends { text }", async () => {
    const cm = { id: "c1", author: "user", text: "note this", at: "2026-11-16T01:00:00.000Z" };
    serve((r) => (r.method === "POST" && r.path === `${T}/comments` ? { status: 201, json: cm } : undefined));
    expect(await run(["ticket", "comment", ID, "note", "this"])).toEqual({ code: 0, stdout: `Commented on ${ID}.\n`, stderr: "" });
    expect((await run(["ticket", "comment", ID, "--text", "flag text", "--json"])).stdout).toBe(JSON.stringify(cm, null, 2) + "\n");
    expect(calls().map((s) => s.body)).toEqual([{ text: "note this" }, { text: "flag text" }]);
    expect((await run(["ticket", "comment", ID])).stderr).toBe("usage: ckanban ticket comment <id> <text>\n");
  });

  test("stop sends {} and reports whether a run was stopped", async () => {
    let stopped = true;
    serve((r) => (r.method === "POST" && r.path === `${T}/stop` ? { json: { stopped } } : undefined));
    expect((await run(["ticket", "stop", ID])).stdout).toBe(`Stopped the run on ${ID}.\n`);
    stopped = false;
    expect((await run(["ticket", "stop", ID])).stdout).toBe(`${ID} had no run to stop.\n`);
    expect(calls().map((s) => s.body)).toEqual([{}, {}]);
    expect((await run(["ticket", "stop"])).stderr).toBe("usage: ckanban ticket stop <id>\n");
  });

  test("delete sends no body; a 204 is fine; --json prints { deleted }", async () => {
    serve((r) => (r.method === "DELETE" && r.path === T ? { status: 204 } : undefined));
    expect(await run(["ticket", "delete", ID])).toEqual({ code: 0, stdout: `Deleted ${ID}.\n`, stderr: "" });
    expect((await run(["ticket", "delete", ID, "--json"])).stdout).toBe(JSON.stringify({ deleted: ID }, null, 2) + "\n");
    expect(calls().every((s) => s.body === undefined && s.headers["content-type"] === undefined)).toBe(true);
    expect((await run(["ticket", "delete"])).stderr).toBe("usage: ckanban ticket delete <id>\n");
  });
});

describe("ticket list, show, create, update: what is sent", () => {
  test("list: the query string in URLSearchParams order, and the More line repeats the flags", async () => {
    serve(() => ({ json: { tickets: [ticket({ status: "done", tags: ["ui"] })], total: 5, doneLeft: 0, next: ID } }));
    const r = await run(["ticket", "list", "--status", "Done", "--query", "  fix it ", "--limit", "2.7", "--after", "t_x", "--include-tool"]);
    expect(calls()[0].path).toBe("/api/profiles/alpha/tickets?scope=list&status=done&tool=1&q=fix+it&limit=2&after=t_x");
    expect(r.stdout).toBe([
      `Board alpha, matching "fix it" in done, newest first: 1 of 5 (after t_x).`,
      `${ID}  [done]  Fix it  (#ui)`,
      `More: ckanban ticket list --status Done --query "  fix it " --limit 2 --include-tool --after ${ID}.`,
    ].join("\n") + "\n");
    serve(() => ({ json: { tickets: [], total: 0, doneLeft: 1, next: null } }));
    const e = await run(["ticket", "list", "--limit", "0"]);
    expect(calls()[0].path).toBe("/api/profiles/alpha/tickets?scope=list");
    expect(e.stdout).toBe("Board alpha: no open tickets (not Done).\n1 Done ticket not listed: use --status done, or --query.\n");
  });

  test("show: both routes, --comments-before, and the earlier-comments hint", async () => {
    serve((r) => {
      if (r.path === `/api/profiles/alpha/tickets/${ID}`) return { json: ticket({ body: "  Body text \n", mode: undefined }) };
      if (r.path.startsWith(`/api/profiles/alpha/tickets/${ID}/comments`)) {
        return { json: { comments: [{ id: "c9", author: "claude", text: "done", at: "2026-11-16T02:00:00.000Z" }], earlier: 7, total: 8 } };
      }
    });
    const r = await run(["ticket", "show", ID, "--comments-before", "7.5"]);
    expect(calls().map((s) => s.path).sort()).toEqual([`/api/profiles/alpha/tickets/${ID}`, `/api/profiles/alpha/tickets/${ID}/comments?last=50&before=7`]);
    expect(r.stdout).toBe([
      "Fix it", `id: ${ID}`, "status: backlog", "mode: auto", "", "Body text", "",
      `Comments (the last 1; 7 earlier not shown: ckanban ticket show ${ID} --comments-before 7):`,
      "- claude (2026-11-16T02:00:00.000Z): done",
    ].join("\n") + "\n");
    serve((r) => (r.path.includes("/comments") ? { json: { comments: [], earlier: 0, total: 0 } } : { json: ticket() }));
    await run(["ticket", "show", ID, "--comments-before", "-1"]);
    expect(calls().map((s) => s.path)).toContain(`/api/profiles/alpha/tickets/${ID}/comments?last=50`);
  });

  test("create: body defaults, title from the words, --needs and --tags cleaned, stdin body", async () => {
    serve((r) => (r.method === "POST" ? { status: 201, json: ticket({ ...r.body, id: ID }) } : undefined));
    const a = await run(["ticket", "create", "Fix", "the", "login"]);
    expect(a.stdout).toBe(`Created ${ID} on alpha in backlog (interview mode): Fix the login\n`);
    await run(["ticket", "create", "--title", " T ", "--body", "-", "--status", "In Progress", "--mode", "AUTO", "--needs", " Emulator, ,GPU", "--tags", "Post,xhs"], { stdin: "from stdin\n" });
    const file = join(sb.root, "body.md");
    writeFileSync(file, "from a file");
    await run(["ticket", "create", "--title=Eq", "--body-file", file, "--needs", ""]);
    expect(calls().map((s) => s.body)).toEqual([
      { title: "Fix the login", body: "", status: "backlog", mode: "interview" },
      { title: "T", body: "from stdin\n", status: "in_progress", mode: "auto", needs: ["emulator", "gpu"], tags: ["post", "xhs"] },
      { title: "Eq", body: "from a file", status: "backlog", mode: "interview" },
    ]);
  });

  test("update: the patch has only what was given", async () => {
    serve((r) => (r.method === "PATCH" ? { json: ticket({ ...r.body }) } : undefined));
    await run(["ticket", "update", ID, "--title", "  ", "--body", "", "--needs", "", "--show-on-board", "false"]);
    await run(["ticket", "update", ID, "--tags", "", "--status", "review", "--mode", "interview"]);
    await run(["ticket", "move", ID, "--status", "ready"]);
    expect(calls().map((s) => [s.method, s.path, s.body])).toEqual([
      ["PATCH", `/api/profiles/alpha/tickets/${ID}`, { body: "", needs: [], showOnBoard: false }],
      ["PATCH", `/api/profiles/alpha/tickets/${ID}`, { status: "review", mode: "interview", tags: [] }],
      ["PATCH", `/api/profiles/alpha/tickets/${ID}`, { status: "ready" }],
    ]);
  });
});

describe("argument errors", () => {
  test("each error is one stderr line and exit 1, before any ticket call", async () => {
    serve(() => ({ json: ticket() }));
    const cases: [string[], string][] = [
      [["ticket", "create", "--title"], "--title needs a value"],
      [["ticket", "create", "--title", "x", "--body", "a", "--body-file", "b"], "use --body or --body-file, not both"],
      [["ticket", "create", "--title", "x", "--status", "later"], `invalid status "later"; use one of: backlog, planning, ready, in_progress, review, done`],
      [["ticket", "create", "--title", "x", "--mode", "fast"], `invalid mode "fast"; use interview or auto`],
      [["ticket", "create"], "usage: ckanban ticket create --title <t> [--body <md>]"],
      [["ticket", "update", ID], "nothing to change: pass --title, --body, --status, --mode, --needs, --tags or --show-on-board"],
      [["ticket", "update", ID, "--show-on-board", "yes"], "--show-on-board must be true or false"],
      [["ticket", "update"], "usage: ckanban ticket update <id> [--title ...]"],
      [["ticket", "move", ID], "usage: ckanban ticket move <id> <status>"],
      [["ticket", "show"], "usage: ckanban ticket show <id>"],
    ];
    for (const [args, err] of cases) expect(await run(args)).toEqual({ code: 1, stdout: "", stderr: err + "\n" });
    expect(calls()).toEqual([]);
  });

  test("`ticket` alone or an unknown action prints the usage block; `tickets` is the same command", async () => {
    const usage = `usage:\n${contractBlock("### Ticket usage block")}\n`;
    for (const args of [["ticket"], ["ticket", "frobnicate"], ["tickets"], ["ticket", "--json"]]) {
      expect(await run(args)).toEqual({ code: 1, stdout: "", stderr: usage });
    }
    serve(() => ({ json: { tickets: [], total: 0, doneLeft: 0, next: null } }));
    expect((await run(["tickets", "list"])).stdout).toBe("Board alpha: no open tickets (not Done).\n");
  });
});

describe("HTTP errors and identity headers", () => {
  test("daemon down, an error field, a bare status, and a 202 confirmation", async () => {
    const down = await sb.run(["ticket", "list"], { cwd: projA, env: { CKANBAN_PORT: "9" } });
    expect(down).toEqual({ code: 1, stdout: "", stderr: "ckanban daemon not running, run `ckanban install` or `ckanban dev`\n" });
    serve(() => ({ status: 409, json: { error: "ticket is running" } }));
    expect((await run(["ticket", "move", ID, "done"])).stderr).toBe("ticket is running\n");
    serve(() => ({ status: 500, text: "oops" }));
    expect((await run(["ticket", "stop", ID])).stderr).toBe(`POST /api/profiles/alpha/tickets/${ID}/stop failed: 500\n`);
    serve(() => ({ status: 202, json: { confirmation: "Asked the user to confirm in Telegram." } }));
    expect(await run(["ticket", "stop", ID])).toEqual({ code: 1, stdout: "", stderr: "Asked the user to confirm in Telegram.\n" });
  });

  test("CKANBAN_FRONTDESK and CKANBAN_QUICK_CHAT go on every request", async () => {
    serve(() => ({ json: { tickets: [], total: 0, doneLeft: 0, next: null } }));
    await run(["ticket", "list"], { env: { CKANBAN_FRONTDESK: "alpha/t1/tok", CKANBAN_QUICK_CHAT: "alpha/q1" } });
    expect(fb.seen).toHaveLength(2);
    for (const s of fb.seen) {
      expect(s.headers["x-ckanban-frontdesk"]).toBe("alpha/t1/tok");
      expect(s.headers["x-ckanban-quick-chat"]).toBe("alpha/q1");
      expect(s.headers.origin).toBeUndefined();
    }
  });
});

describe("ticket setup", () => {
  const result = (over: Record<string, unknown> = {}) => ({
    copied: [], missing: [], command: "bun install", ok: true, exitCode: 0, timedOut: false, output: "<done>", durationMs: 2400, ...over,
  });

  test("route, board from <board>/<id>, run header, and each answer's text", async () => {
    let answer: unknown = { status: "ran", result: result() };
    serve((r) => (r.method === "POST" && r.path.endsWith("/setup") ? { json: answer } : undefined));
    const ok = await run(["ticket", "setup", `beta/${ID}`], { env: { CKANBAN_TICKET: `alpha/${ID}` } });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("Installed the project's dependencies in 2s (`bun install`).\n" +
      `<ckanban-setup>${JSON.stringify(result()).replace(/</g, "\\u003c")}</ckanban-setup>\n`);
    expect(calls()[0]).toMatchObject({ method: "POST", path: `/api/profiles/beta/tickets/${ID}/setup`, body: {} });
    expect(calls()[0].headers["x-ckanban-run"]).toBe(`alpha/${ID}`);

    for (const [status, text] of [
      ["already-done", "Already done: this ticket's dependencies are installed."],
      ["no-command", "Nothing to install: this board has no setup command."],
      ["no-worktree", "Nothing to install: this ticket works in the project folder itself, not a separate copy."],
    ]) {
      answer = { status };
      expect(await run(["ticket", "setup", ID])).toEqual({ code: 0, stdout: text + "\n", stderr: "" });
    }
    expect(calls().at(-1)!.path).toBe(`/api/profiles/alpha/tickets/${ID}/setup`);
    expect(calls().at(-1)!.headers["x-ckanban-run"]).toBeUndefined();
  });

  test("a failed or timed-out setup prints its output, then fails with exit 1", async () => {
    const failed = result({ ok: false, exitCode: 2, output: "err line" });
    let answer: unknown = { status: "ran", result: failed };
    serve((r) => (r.path.endsWith("/setup") ? { json: answer } : undefined));
    expect(await run(["ticket", "setup", ID])).toEqual({
      code: 1,
      stdout: `\`bun install\` failed (exit 2) after 2s. Last lines of its output:\nerr line\n<ckanban-setup>${JSON.stringify(failed)}</ckanban-setup>\n`,
      stderr: "Setup failed (exit 2).\n",
    });
    const timed = result({ ok: false, exitCode: null, timedOut: true, output: "slow" });
    answer = { status: "ran", result: timed };
    expect(await run(["ticket", "setup", ID])).toEqual({
      code: 1,
      stdout: `\`bun install\` timed out after 2s. Last lines of its output:\nslow\n<ckanban-setup>${JSON.stringify(timed)}</ckanban-setup>\n`,
      stderr: "Setup timed out.\n",
    });
    const killed = result({ ok: false, exitCode: null, output: "" });
    answer = { status: "ran", result: killed };
    const k = await run(["ticket", "setup", ID]);
    expect(k.stdout).toBe(`\`bun install\` failed (exit signal) after 2s. Last lines of its output:\n<ckanban-setup>${JSON.stringify(killed)}</ckanban-setup>\n`);
    expect(k.stderr).toBe("Setup failed (exit signal).\n");
    expect((await run(["ticket", "setup"])).stderr).toBe("usage: ckanban ticket setup [<board>/]<id>\n");
  });
});

describe("ticket take-device and release-device", () => {
  const env = { CKANBAN_TICKET: `alpha/${ID}` };

  test("only inside a run, with no profile lookup", async () => {
    serve(() => ({ json: { ok: true, names: ["x"] } }));
    expect(await run(["ticket", "take-device", "phone"])).toEqual({ code: 1, stdout: "", stderr: "ckanban ticket take-device works inside a board run, for its own ticket\n" });
    expect(await run(["ticket", "release-device"])).toEqual({ code: 1, stdout: "", stderr: "ckanban ticket release-device works inside a board run, for its own ticket\n" });
    expect(await run(["ticket", "take-device"], { env })).toEqual({ code: 1, stdout: "", stderr: "usage: ckanban ticket take-device <name> [<name>...]\n" });
    expect(fb.seen).toEqual([]);
  });

  test("take: body, run header, and the ok and waiting texts (exit 0 both)", async () => {
    let answer: unknown = { ok: true, names: ["phone", "chrome"] };
    serve((r) => (r.path === `/api/profiles/alpha/tickets/${ID}/devices` ? { json: answer } : undefined));
    const ok = await run(["ticket", "take-device", "phone", "chrome"], { env });
    expect(ok).toEqual({ code: 0, stdout: "You have phone, chrome now. Use it, then let go with release_devices as soon as you are done, so the next ticket can have it.\n", stderr: "" });
    expect(fb.seen).toHaveLength(1);
    expect(fb.seen[0]).toMatchObject({ method: "POST", body: { action: "take", names: ["phone", "chrome"] } });
    expect(fb.seen[0].headers["x-ckanban-run"]).toBe(`alpha/${ID}`);

    answer = { ok: false, names: ["phone"], place: 2, usedBy: [{ id: "t_a", slug: "other", title: "Post it" }, { id: "t_b", title: null }] };
    const wait = await run(["ticket", "take-device", "phone"], { env });
    expect(wait.code).toBe(0);
    expect(wait.stdout).toBe(`Still waiting for phone: "Post it" (other), "t_b" has it; you are #2 in line and keep that place. Do other work that doesn't need it if there is some, then call take_devices again with the same names (each call waits up to 4 minutes).\n`);
    answer = { ok: false, names: ["phone"], place: 1, usedBy: [] };
    expect((await run(["ticket", "take-device", "phone"], { env })).stdout).toContain("Still waiting for phone: other tickets are ahead of you; you are #1 in line");
  });

  test("release: names or [] for all", async () => {
    let released = ["phone"];
    serve(() => ({ json: { released } }));
    expect((await run(["ticket", "release-device", "phone"], { env })).stdout).toBe("Let go of phone.\n");
    released = [];
    expect((await run(["ticket", "release-device"], { env })).stdout).toBe("Nothing to let go of.\n");
    expect(fb.seen.map((s) => s.body)).toEqual([{ action: "release", names: ["phone"] }, { action: "release", names: [] }]);
  });
});

describe("ticket report-bug", () => {
  test("body sent, source cli or ai, and both texts", async () => {
    let answer: unknown = { url: "https://github.com/o/r/issues/1", fallbackUrl: "https://x", error: null, screenshots: [] };
    serve((r) => (r.path === "/api/bug-report" ? { json: answer } : undefined));
    expect(await run(["ticket", "report-bug", "--title", " Broken ", "--body", "It broke"])).toEqual({ code: 0, stdout: "Created https://github.com/o/r/issues/1\n", stderr: "" });
    // No id: no profile lookup.
    expect(fb.seen.map((s) => s.path)).toEqual(["/api/bug-report"]);
    expect(fb.seen[0].body).toEqual({ title: "Broken", description: "It broke", include: ["env", "ticket", "log"], source: "cli" });

    answer = { url: null, fallbackUrl: "https://github.com/o/r/issues/new?title=x", error: "gh not found", screenshots: ["a.png", "b.png"] };
    fb.seen.length = 0;
    const r = await run(["ticket", "report-bug", ID, "--title", "T", "--no-logs"], { env: { CKANBAN_TICKET: `beta/${ID}` } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Could not create the issue: gh not found\nOpen this link to file it in the browser instead (title and body are prefilled):\n" +
      "https://github.com/o/r/issues/new?title=x\n2 screenshot(s) from the ticket were not uploaded; ask the user to drag them into a comment on the issue.\n");
    expect(fb.seen.map((s) => s.path)).toEqual(["/api/profiles", "/api/bug-report"]);
    expect(fb.seen[1].body).toEqual({ title: "T", description: "", profile: "beta", ticketId: ID, include: ["env", "ticket"], source: "ai" });

    expect(await run(["ticket", "report-bug", "--body", "x"])).toEqual({
      code: 1, stdout: "", stderr: "usage: ckanban ticket report-bug [<id>] --title <t> [--body <md> | --body-file <f>] [--no-logs]\n",
    });
  });
});

describe("call", () => {
  test("errors in order: usage, token, JSON", async () => {
    fb.reset(() => ({ json: { result: 1 } }));
    expect(await run(["call"])).toEqual({ code: 1, stdout: "", stderr: "usage: ckanban call <service> <tool> ['<json arguments>']\n" });
    expect(await run(["call", "gmail"], { env: { CKANBAN_CALL_TOKEN: "tok" } })).toEqual({ code: 1, stdout: "", stderr: "usage: ckanban call <service> <tool> ['<json arguments>']\n" });
    expect(await run(["call", "gmail", "search"])).toEqual({ code: 1, stdout: "", stderr: "ckanban call only works inside an automation's check script\n" });
    expect(await run(["call", "gmail", "search", "{bad"], { env: { CKANBAN_CALL_TOKEN: "tok" } })).toEqual({
      code: 1, stdout: "", stderr: `The arguments must be JSON, e.g. '{"limit": 20}'\n`,
    });
    expect(fb.seen).toEqual([]);
  });

  test("POST /api/automation-call with the token in the body; prints text as is, else compact JSON", async () => {
    let result: unknown = "plain text\nline 2";
    fb.reset((r) => (r.path === "/api/automation-call" ? { json: { result } } : undefined));
    const env = { CKANBAN_CALL_TOKEN: "tok-1" };
    expect(await run(["call", "gmail", "search"], { env })).toEqual({ code: 0, stdout: "plain text\nline 2\n", stderr: "" });
    result = { items: [{ id: 1 }], n: 2 };
    expect((await run(["call", "gmail", "search", '{"limit": 20}'], { env })).stdout).toBe('{"items":[{"id":1}],"n":2}\n');
    expect(fb.seen.map((s) => [s.method, s.body])).toEqual([
      ["POST", { token: "tok-1", service: "gmail", tool: "search", args: {} }],
      ["POST", { token: "tok-1", service: "gmail", tool: "search", args: { limit: 20 } }],
    ]);
    fb.reset(() => ({ status: 403, json: { error: "this check may not use gmail" } }));
    expect(await run(["call", "gmail", "search"], { env })).toEqual({ code: 1, stdout: "", stderr: "this check may not use gmail\n" });
  });
});

describe("ckanban mcp (stdio)", () => {
  /** Sends the lines, closes stdin, and returns the replies by id (the server may answer out of order). */
  async function mcp(lines: string[], env: Record<string, string> = {}) {
    const r = await run(["mcp"], { stdin: lines.join("\n") + "\n", env });
    expect(r.code).toBe(0);
    return r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  test("initialize, ping, tools/list, batches, notifications, bad JSON, unknown method", async () => {
    const replies = await mcp([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }),
      "not json",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "nope" }),
      JSON.stringify([{ jsonrpc: "2.0", id: 4, method: "ping" }, { jsonrpc: "2.0", id: 5, method: "tools/list" }]),
    ]);
    const byId = new Map(replies.map((m) => [m.id, m]));
    expect(replies).toHaveLength(6);
    expect(byId.get(1).result).toMatchObject({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ckanban" } });
    expect(typeof byId.get(1).result.instructions).toBe("string");
    expect(byId.get(2).result.protocolVersion).toBe("2025-06-18");
    expect(byId.get(null)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    expect(byId.get(3)).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "method not found: nope" } });
    expect(byId.get(4)).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
    const names = byId.get(5).result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(69);
    // Every tool the contract's table lists, and no other.
    expect([...names].sort()).toEqual(contractTools().sort());
  });

  test("tools/call: a read goes to the board; a changing tool is refused inside a run; unknown tool", async () => {
    serve();
    const call = (id: number, name: string, args: unknown = {}) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    let replies = await mcp([call(1, "list_profiles"), call(2, "no_such_tool")]);
    const byId = new Map(replies.map((m) => [m.id, m]));
    expect(byId.get(1).result).toEqual({ content: [{ type: "text", text: `Profiles:\n  alpha  (Alpha, ${projA})\n  beta  (Beta Board, ${projB})` }] });
    expect(byId.get(2).result).toEqual({ content: [{ type: "text", text: "unknown tool no_such_tool" }], isError: true });

    fb.seen.length = 0;
    replies = await mcp([call(3, "delete_ticket", { id: ID })], { CKANBAN_TICKET: `alpha/${ID}` });
    expect(replies[0].result.isError).toBe(true);
    expect(replies[0].result.content[0].text).toContain("changing the board is disabled inside a board run");
    expect(fb.seen).toEqual([]);
  });
});

/** Tool names from the table in contracts/cli.md section 6. */
function contractTools(): string[] {
  const text = readFileSync(join(REPO, "contracts", "cli.md"), "utf8");
  const sec = text.slice(text.indexOf("## 6. `ckanban mcp`"), text.indexOf("## 7."));
  return [...sec.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
}
