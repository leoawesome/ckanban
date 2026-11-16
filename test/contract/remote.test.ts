// Outside-in contract: phone access. `GET/POST /api/remote` and the checks on the phone access listener (the second
// port, CKANBAN_REMOTE_PORT): off unless remote.json says on, the tailnet Host, the owner's Tailscale login, the Origin
// on changes, the x-ckanban-listener header. See contracts/api.md ("Basics", "Remote") and data-files.md (remote.json).
//
// Turning phone access on or off runs Tailscale. The daemon prefers /Applications/Tailscale.app's own binary over
// PATH, so on a Mac with Tailscale installed a stub on PATH would not stop it: these tests never reach that code (no
// `POST /api/remote` that gets past its checks, no `GET /api/remote` while it is on). remote.json is written here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, startDaemon } from "./daemon";
import { PHONE_HOST, PHONE_LOGIN, phone, writeRemoteJson } from "./phone";

let d: Daemon;
const SLUG = "phone";

beforeAll(async () => {
  d = await startDaemon();
  expect((await d.api("POST", "/api/profiles", { name: "Phone", path: d.project })).status).toBe(201);
}, 60_000);

afterAll(async () => {
  await d?.stop();
}, 30_000);

const remoteFile = () => join(d.home, "remote.json");

test("never set up: GET /api/remote says off; the phone listener refuses everything", async () => {
  expect(existsSync(remoteFile())).toBe(false);
  const r = await d.api("GET", "/api/remote");
  expect(r.status).toBe(200);
  expect(r.data).toEqual({ enabled: false, url: null, host: null, allowedLogin: null, lastVisit: null, qrSvg: null, local: true });

  const p = await phone(d, "GET", "/api/profiles");
  expect(p.status).toBe(403);
  expect(p.headers.get("content-type")).toContain("text/plain");
  expect(p.text).toBe("forbidden: phone access is off (run `ckanban remote on` on the Mac)");
  expect(p.headers.get("x-ckanban-listener")).toBe("remote");
});

test("POST /api/remote refusals come before any Tailscale command", async () => {
  // Not a boolean.
  for (const b of [{}, { enabled: "yes" }, { enabled: 1 }]) {
    const r = await d.api("POST", "/api/remote", b);
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("enabled must be true or false");
  }
  // A board run.
  const run = await d.api("POST", "/api/remote", { enabled: true }, { "x-ckanban-run": `${SLUG}/t_x` });
  expect(run.status).toBe(403);
  expect(run.data.error).toBe("board runs can't change phone access");
  // Nothing was written.
  expect(existsSync(remoteFile())).toBe(false);
});

test("saved but off: GET /api/remote shows the address and its QR code; the phone listener still refuses", async () => {
  writeRemoteJson(d.home, false);
  const r = await d.api("GET", "/api/remote");
  expect(r.status).toBe(200);
  expect(r.data).toMatchObject({ enabled: false, url: `https://${PHONE_HOST}`, host: PHONE_HOST, allowedLogin: PHONE_LOGIN, lastVisit: null, local: true });
  expect(r.data.qrSvg).toStartWith("<svg");
  expect((await phone(d, "GET", "/api/profiles")).status).toBe(403);
});

test("on: the phone listener checks Host, the Tailscale login and the Origin of changes", async () => {
  writeRemoteJson(d.home, true);
  const ok = await phone(d, "GET", "/api/profiles");
  expect(ok.status).toBe(200);
  expect(ok.headers.get("x-ckanban-listener")).toBe("remote");
  expect(ok.data.some((p: any) => p.slug === SLUG)).toBe(true);
  // Host with :443 and the login in another case are the same caller.
  expect((await phone(d, "GET", "/api/profiles", undefined, { host: `${PHONE_HOST}:443`, "tailscale-user-login": PHONE_LOGIN.toUpperCase() })).status).toBe(200);

  const refused: [string, Record<string, string>, string][] = [
    ["Host localhost", { host: `localhost:${d.port}` }, "forbidden"],
    ["Host 127.0.0.1", { host: `127.0.0.1:${d.remotePort}` }, "forbidden"],
    ["another tailnet host", { host: "other.tail0000.ts.net" }, "forbidden"],
    ["no login", { "tailscale-user-login": "" }, "forbidden: open this board signed in to Tailscale as its owner"],
    ["another login", { "tailscale-user-login": "stranger@example.com" }, "forbidden: open this board signed in to Tailscale as its owner"],
  ];
  for (const [what, headers, text] of refused) {
    const r = await phone(d, "GET", "/api/profiles", undefined, headers);
    expect({ what, status: r.status, text: r.text }).toEqual({ what, status: 403, text });
    expect(r.headers.get("x-ckanban-listener")).toBe("remote");
  }

  // A change needs the tailnet Origin when it sends one; none at all passes the listener check.
  const make = (origin: string) => phone(d, "POST", `/api/profiles/${SLUG}/tickets`, { title: "From the phone" }, { origin });
  expect((await make(`http://127.0.0.1:${d.port}`)).status).toBe(403);
  expect((await make("https://evil.example")).status).toBe(403);
  expect((await make("")).status).toBe(201);
  expect((await make(`https://${PHONE_HOST}`)).status).toBe(201);

  // Phone access can't be changed from the phone.
  const flip = await phone(d, "POST", "/api/remote", { enabled: false });
  expect(flip.status).toBe(403);
  expect(flip.data.error).toBe("phone access can only be changed on this Mac");
  expect(JSON.parse(readFileSync(remoteFile(), "utf8")).enabled).toBe(true);

  // The local listener is unaffected by phone access: the board's Host only.
  expect((await d.api("GET", "/api/profiles", undefined, { host: PHONE_HOST })).status).toBe(403);
});

test("on: a user-only action from the phone passes the user check", async () => {
  // find-links is user only (contracts/api.md); the phone's own browser is the user. 502 or 200 is the action itself
  // (the fake Claude), 403 would be the user check.
  const r = await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {});
  expect(r.status).not.toBe(403);
  // A board run's header is refused there as everywhere.
  const run = await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {}, { "x-ckanban-run": `${SLUG}/t_x` });
  expect(run.status).toBe(403);
  // No Origin: refused by the user check (not by the listener).
  const bare = await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {}, { origin: "" });
  expect(bare.status).toBe(403);
  expect(bare.data.error).toMatch(/for the user only/);
});

test("quirk (t_20261115_v0ip): any local program that sends the tailnet Host and the owner's login is the user", async () => {
  // Both values are in remote.json, readable by every program of this macOS user. Nothing checks that the caller is
  // `tailscale serve`: this test process passes the user-only check above the same way a board run's shell could.
  const cfg = JSON.parse(readFileSync(remoteFile(), "utf8"));
  const r = await phone(d, "POST", `/api/profiles/${SLUG}/find-links`, {}, { host: cfg.host, "tailscale-user-login": cfg.allowedLogin });
  expect(r.status).not.toBe(403);
});

test("off again: the phone listener refuses at once (remote.json re-read on change)", async () => {
  writeRemoteJson(d.home, false);
  expect((await phone(d, "GET", "/api/profiles")).status).toBe(403);
  rmSync(remoteFile());
  expect((await d.api("GET", "/api/remote")).data.url).toBeNull();
});
