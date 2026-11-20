// Outside-in contract: Claude Code's own sign-in from the board (`/api/claude-signin*`, contracts/api.md "Claude's
// sign-in"). The fake `claude` answers `auth status` from FAKE_AUTH_STATE_FILE and `auth login` with a link and a code
// prompt (test/fixtures/fake-claude.ts). Start, paste and cancel are for the user only: the owner's phone (phone.ts)
// stands in for the user; a board run, a huddle helper and a plain local caller (the MCP server, `ckanban call`) are
// refused. The pasted code must never show up in an answer, the daemon's log or a data file.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Daemon, startDaemon, until } from "./daemon";
import { filesUnder } from "./files";
import { phone, writeRemoteJson } from "./phone";

let d: Daemon;
const dir = mkdtempSync(join(tmpdir(), "ck-contract-claude-signin-"));
const stateFile = join(dir, "auth-state");
const GOOD = "good_SECRET_code_4f1a9c#state_77e2";
const BAD = "bad_SECRET_code_0b3d2e#state_19a4";

beforeAll(async () => {
  writeFileSync(stateFile, "out");
  d = await startDaemon({ env: { FAKE_AUTH_STATE_FILE: stateFile }, before: ({ home }) => writeRemoteJson(home, true) });
}, 60_000);

afterAll(async () => {
  await d?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

const status = async () => (await d.api("GET", "/api/claude-signin")).data;

test("the status is checked in the background: signed out shows the red strip", async () => {
  const s = await until(async () => {
    const v = await status();
    return v.status.checked ? v : null;
  });
  expect(s.status).toMatchObject({ checked: true, loggedIn: false, warning: "signed-out" });
  expect(s.login).toBeNull();
});

test("start, paste and cancel are for the user only", async () => {
  for (const sub of ["start", "paste", "cancel"]) {
    const body = sub === "paste" ? { id: 1, code: GOOD } : sub === "cancel" ? { id: 1 } : {};
    // This test process on the local port, as the MCP server and `ckanban call` reach it (no Origin), and with the Origin.
    for (const headers of [{}, { origin: `http://127.0.0.1:${d.port}` }] as Record<string, string>[]) {
      const r = await d.api("POST", `/api/claude-signin/${sub}`, body, headers);
      expect(r.status).toBe(403);
      expect(r.data.error).toMatch(/is for the user only/);
    }
    // A board run's token, and a huddle helper's, even from the phone listener.
    expect((await phone(d, "POST", `/api/claude-signin/${sub}`, body, { "x-ckanban-run": "kanban/t_x" })).status).toBe(403);
    expect((await phone(d, "POST", `/api/claude-signin/${sub}`, body, { "x-ckanban-huddle-agent": "tok" })).status).toBe(403);
  }
  expect((await status()).login).toBeNull();
});

test("the user signs in from the phone: link, a code without # refused, a wrong code, then the right one", async () => {
  const start = await phone(d, "POST", "/api/claude-signin/start", {});
  expect(start.status).toBe(200);
  expect(start.data.login).toMatchObject({ state: "waiting", error: null });
  expect(start.data.login.url).toStartWith("https://claude.com/cai/oauth/authorize?");
  // The link is only in the user's own answer, not in what anyone can read.
  expect((await status()).login.url).toBeNull();

  const id = start.data.login.id;
  const half = await phone(d, "POST", "/api/claude-signin/paste", { id, code: "no-hash-here" });
  expect(half.status).toBe(400);
  expect(half.data.error).toContain("# in the middle");

  const bad = await phone(d, "POST", "/api/claude-signin/paste", { id, code: BAD });
  expect(bad.status).toBe(200);
  expect(bad.data.login.state).toBe("failed");
  expect(bad.data.login.error).toStartWith("Claude didn't accept that code.");
  expect(bad.text).not.toContain("SECRET");

  const again = await phone(d, "POST", "/api/claude-signin/start", {});
  expect(again.data.login.state).toBe("waiting");
  const good = await phone(d, "POST", "/api/claude-signin/paste", { id: again.data.login.id, code: ` ${GOOD} ` });
  expect(good.status).toBe(200);
  expect(good.data.login.state).toBe("done");
  expect(good.text).not.toContain("SECRET");
  // The status is checked again right away: signed in, no strip.
  const after = await until(async () => {
    const v = await status();
    return v.status.loggedIn === true ? v : null;
  });
  expect(after.status.warning).toBeNull();
});

test("a sheet left open on another device can't cancel or fill in a newer sign-in; cancel stops its own", async () => {
  const old = (await phone(d, "POST", "/api/claude-signin/start", {})).data.login;
  const cur = (await phone(d, "POST", "/api/claude-signin/start", {})).data.login;
  expect(cur.state).toBe("waiting");
  expect((await phone(d, "POST", "/api/claude-signin/cancel", { id: old.id })).status).toBe(200);
  const stale = await phone(d, "POST", "/api/claude-signin/paste", { id: old.id, code: BAD });
  expect(stale.status).toBe(409);
  expect(stale.data.error).toStartWith("This sign-in was replaced");
  expect((await status()).login).toMatchObject({ id: cur.id, state: "waiting" });
  expect((await phone(d, "POST", "/api/claude-signin/cancel", {})).status).toBe(400);
  const r = await phone(d, "POST", "/api/claude-signin/cancel", { id: cur.id });
  expect(r.status).toBe(200);
  expect(r.data.login).toBeNull();
  const late = await phone(d, "POST", "/api/claude-signin/paste", { id: cur.id, code: GOOD });
  expect(late.status).toBe(409);
});

test("the pasted codes are in no log or data file", () => {
  expect(d.log()).not.toContain("SECRET");
  for (const f of filesUnder(d.home)) {
    let text = "";
    try {
      text = readFileSync(join(d.home, f), "utf8");
    } catch {
      continue;
    }
    expect(text.includes("SECRET")).toBe(false);
  }
  // What was told is kept: one note for being signed out.
  expect(JSON.parse(readFileSync(join(d.home, "claude-signin.json"), "utf8"))).toMatchObject({ signedOutTold: false });
});
