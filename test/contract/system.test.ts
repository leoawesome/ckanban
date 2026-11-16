// Outside-in contract: the daemon's own routes (contracts/api.md "System"): health, version (against a local stand-in
// for GitHub's releases API, CKANBAN_RELEASES_URL), Claude Code's defaults and projects, the cron preview, the debug
// profile's "this Mac only" check, the JSON-only rule for changes and the Telegram front desk's identity check in
// front of them; the same routes from the phone access listener. `POST /api/pick-folder` opens the Mac's folder
// chooser, so only its refusal is tested. Imports nothing from src/.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";
import { PHONE_HOST, PHONE_LOGIN, phone, writeRemoteJson } from "./phone";

let d: Daemon;
let github: ReturnType<typeof Bun.serve>;
let asked = 0;
const SLUG = "sys";
let projectA = "";

beforeAll(async () => {
  github = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      asked++;
      if (req.headers.get("user-agent") !== "ckanban") return new Response("no agent", { status: 400 });
      return Response.json({ tag_name: "v999.1.0", html_url: "https://example.invalid/releases/v999.1.0", assets: [] });
    },
  });
  d = await startDaemon({
    env: { CKANBAN_RELEASES_URL: `http://127.0.0.1:${github.port}/repos/latest` },
    before: ({ claudeDir, home }) => {
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "opus", effortLevel: "high" }));
      projectA = join(home, "..", "proj-a");
      mkdirSync(projectA, { recursive: true });
      writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ projects: { [projectA]: {} } }));
    },
  });
  expect((await d.api("POST", "/api/profiles", { name: "Sys", path: projectA })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
  github?.stop(true);
}, 30_000);

test("GET /api/health says what can be found", async () => {
  const r = await d.api("GET", "/api/health");
  expect(r.status).toBe(200);
  expect(Object.keys(r.data).sort()).toEqual(["claude", "gh", "git", "pty"]);
  // The fake claude (CKANBAN_CLAUDE_BIN) is there.
  expect(r.data.claude).toBe(true);
  for (const k of ["gh", "git", "pty"]) expect(typeof r.data[k]).toBe("boolean");
  // Any path under health is health too (Bun's route checks the first part only).
  expect((await d.api("GET", "/api/health/x")).status).toBe(200);
  expect((await d.api("POST", "/api/health", {})).status).toBe(404);
});

test("GET /api/version: the latest release, asked once and kept", async () => {
  const r = await d.api("GET", "/api/version");
  expect(r.status).toBe(200);
  expect(r.data).toEqual({ version: "dev", latest: "999.1.0", updateAvailable: false, url: "https://example.invalid/releases/v999.1.0" });
  const n = asked;
  expect((await d.api("GET", "/api/version")).data.latest).toBe("999.1.0");
  expect(asked).toBe(n);
});

test("GET /api/claude/defaults and /api/claude/projects", async () => {
  const def = await d.api("GET", "/api/claude/defaults");
  expect(def.status).toBe(200);
  expect(def.data).toEqual({ model: "opus", effort: "high", versions: {} });
  // Folders under the temp folder are left out (scratch sessions), and every test folder is one: only the answer's
  // form is checked here (the list itself is checked against Bun's fixtures in rust/board/tests/runs.rs).
  const p = await d.api("GET", "/api/claude/projects");
  expect(p.status).toBe(200);
  expect(Array.isArray(p.data)).toBe(true);
});

test("GET /api/cron/preview: valid or not, the summary and the next three times", async () => {
  const ok = await d.api("GET", `/api/cron/preview?expr=${encodeURIComponent("0 9 * * 1-5")}`);
  expect(ok.status).toBe(200);
  expect(ok.data).toMatchObject({ valid: true, error: null, summary: "Weekdays at 09:00" });
  expect(ok.data.next).toHaveLength(3);
  for (const t of ok.data.next) expect(t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/);
  expect((await d.api("GET", "/api/cron/preview")).data).toEqual({ valid: false, error: "cron expression is required", summary: null, next: [] });
  expect((await d.api("GET", "/api/cron/preview?expr=61+*+*+*+*")).data).toEqual({ valid: false, error: "minute 61 is out of range (0-59)", summary: null, next: [] });
  expect((await d.api("GET", "/api/cron/preview?expr=@daily")).data.summary).toBe("Every day at 00:00");
  // Only exactly /cron/preview.
  expect((await d.api("GET", "/api/cron/preview/x?expr=@daily")).status).toBe(404);
});

test("POST /api/debug/profile: this Mac only, never a board run; a short profile gives the hottest functions", async () => {
  const run = await d.api("POST", "/api/debug/profile?seconds=1", {}, { "x-ckanban-run": `${SLUG}/t_x` });
  expect(run.status).toBe(403);
  expect(run.data.error).toBe("profiles are taken from this Mac only");
  const r = await d.api("POST", "/api/debug/profile?seconds=1", {});
  expect(r.status).toBe(200);
  expect(Array.isArray(r.data.hot)).toBe(true);
  expect(existsSync(r.data.file)).toBe(true);
  expect(r.data.file.startsWith(join(d.home, "debug"))).toBe(true);
}, 30_000);

test("changes need a JSON body; the board's Host and Origin come first", async () => {
  const pick = await fetch(`${d.url}/api/pick-folder`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
  expect(pick.status).toBe(415);
  expect(await pick.json()).toEqual({ error: "content-type must be application/json" });
  const evil = await d.api("POST", "/api/pick-folder", {}, { origin: "https://evil.example" });
  expect(evil.status).toBe(403);
  expect(evil.text).toBe("forbidden");
  expect((await d.api("GET", "/api/health", undefined, { host: "evil.example" })).status).toBe(403);
});

test("the Telegram front desk's identity is checked before these routes too", async () => {
  for (const path of ["/api/health", "/api/version", "/api/cron/preview?expr=@daily"]) {
    const r = await d.api("GET", path, undefined, { "x-ckanban-frontdesk": `${SLUG}/nope/nope` });
    expect({ path, status: r.status }).toEqual({ path, status: 403 });
    expect(r.data.error).toMatch(/front desk identity isn't valid/);
  }
  const both = await d.api("GET", "/api/health", undefined, { "x-ckanban-frontdesk": `${SLUG}/nope/nope`, "x-ckanban-run": `${SLUG}/t_x` });
  expect(both.status).toBe(403);
  expect(both.data.error).toBe("a board run can't also be the front desk");
});

test("from the phone: refused while phone access is off, answered with the listener's mark while on", async () => {
  const off = await phone(d, "GET", "/api/health");
  expect(off.status).toBe(403);
  expect(off.headers.get("x-ckanban-listener")).toBe("remote");
  writeRemoteJson(d.home, true);
  try {
    for (const path of ["/api/health", "/api/cron/preview?expr=@daily", "/api/claude/defaults"]) {
      const r = await phone(d, "GET", path);
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
      expect(r.headers.get("x-ckanban-listener")).toBe("remote");
    }
    // Caller identity on the phone: the owner's phone passes the user-only check (find-links: 403 would be the check);
    // a board run's header and a request without an Origin don't.
    const user = await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {});
    expect(user.status).not.toBe(403);
    expect((await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {}, { "x-ckanban-run": `${SLUG}/t_x` })).status).toBe(403);
    const bare = await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {}, { origin: "" });
    expect(bare.status).toBe(403);
    expect(bare.data.error).toMatch(/for the user only/);
    // The same from this Mac with no browser behind it: refused by the user check.
    expect((await d.api("POST", `/api/profiles/${SLUG}/find-links`, {}, { origin: d.url })).status).toBe(403);
    // The terminal's WebSocket from the phone needs the tailnet page as its Origin (isAllowedSocket).
    const base = { host: PHONE_HOST, "tailscale-user-login": PHONE_LOGIN };
    expect(await upgrade(d.remotePort, { ...base, origin: "https://evil.example" })).toContain(" 403 ");
    expect(await upgrade(d.remotePort, base)).toContain(" 403 ");
    expect(await upgrade(d.remotePort, { ...base, origin: `https://${PHONE_HOST}` })).toContain(" 101 ");
    // A user-only change answered by the board itself (board browsers) lets the owner's phone in, as Bun does.
    const bb = await phone(d, "POST", "/api/board-browsers", { name: "From the phone" });
    expect(bb.status).toBe(200);
    expect((await phone(d, "POST", "/api/board-browsers", { name: "Run" }, { "x-ckanban-run": `${SLUG}/t_x` })).status).toBe(403);
    // The debug profile is this Mac's only.
    const prof = await phone(d, "POST", "/api/debug/profile?seconds=1", {});
    expect(prof.status).toBe(403);
    // A change from another page is refused by the listener.
    const evil = await phone(d, "POST", "/api/pick-folder", {}, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.text).toBe("forbidden");
  } finally {
    writeRemoteJson(d.home, false);
  }
});

/** One request written as is on a socket (fetch would resolve `..` itself): the status and the body. */
async function raw(port: number, method: string, target: string, headers: Record<string, string | string[]> = {}): Promise<{ status: number; body: string }> {
  const { connect } = await import("node:net");
  return new Promise((done, fail) => {
    const s = connect(port, "127.0.0.1");
    let buf = "";
    s.on("data", (c) => (buf += c.toString()));
    s.on("error", fail);
    s.on("end", () => {
      const status = Number(buf.split(" ")[1]);
      const body = buf.slice(buf.indexOf("\r\n\r\n") + 4);
      done({ status, body });
    });
    const h = { host: `127.0.0.1:${port}`, connection: "close", ...headers };
    s.write(`${method} ${target} HTTP/1.1\r\n${Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`)).join("\r\n")}\r\n\r\n`);
  });
}

test("dot segments in the path are resolved before routing, as a browser's URL would be", async () => {
  // Answered as /api/cron/preview, whichever server owns it, never as another route.
  for (const target of ["/api/x/../cron/preview?expr=@daily", "/api/x/%2e%2e/cron/preview?expr=@daily", "/api/./x/.%2E/cron/preview?expr=@daily"]) {
    const r = await raw(d.port, "GET", target);
    expect({ target, status: r.status }).toEqual({ target, status: 200 });
    expect(r.body).toContain('"summary":"Every day at 00:00"');
  }
  // The debug profile's run check holds through a dot path too.
  const run = await raw(d.port, "POST", "/api/x/../debug/profile?seconds=1", { "x-ckanban-run": `${SLUG}/t_x`, "content-type": "application/json", "content-length": "0" });
  expect(run.status).toBe(403);
  // Two run header lines, the first empty, are a board run (Fetch joins them): find-links refuses.
  const two = await raw(d.port, "POST", `/api/profiles/${SLUG}/find-links`, { origin: d.url, "content-type": "application/json", "content-length": "0", "x-ckanban-run": ["", `${SLUG}/t_x`] });
  expect(two.status).toBe(403);
});

/** A WebSocket upgrade to the board folder's terminal, written raw: the status line of the answer. */
function upgrade(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise(async (done, fail) => {
    const { connect } = await import("node:net");
    const s = connect(port, "127.0.0.1");
    let buf = "";
    const fin = () => {
      s.destroy();
      done(buf.split("\r\n")[0]);
    };
    s.on("data", (c) => {
      buf += c.toString("latin1");
      if (buf.includes("\r\n\r\n")) fin();
    });
    s.on("error", fail);
    s.on("end", fin);
    const h = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers };
    s.write(`GET /api/profiles/${SLUG}/shell?cols=80&rows=24 HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
  });
}
