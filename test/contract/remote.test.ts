// Outside-in contract: phone access. `GET/POST /api/remote` and the checks on the phone access listener (the second
// port, CKANBAN_REMOTE_PORT): off unless remote.json says on, the tailnet Host, the owner's Tailscale login, the Origin
// on changes, the x-ckanban-listener header. See contracts/api.md ("Basics", "Remote") and data-files.md (remote.json).
//
// Turning phone access on or off runs Tailscale: the daemon gets CKANBAN_TAILSCALE pointing at a stub (daemon.ts), so the
// Mac's real Tailscale is never changed. The last tests use a stub that keeps a serve config, to check that the board
// puts its link back when it went missing and that turning off a link that is already gone is plain off.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A `tailscale` that keeps the HTTPS 443 link in a file next to it and logs every call; another app's Funnel on 8443 is
 * always there. `serve --https=443 off` with no link fails the way Tailscale does ("handler does not exist").
 */
const SERVING_TAILSCALE = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/tailscale-calls.log"
case "$*" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"${PHONE_HOST}.","UserID":1},"User":{"1":{"LoginName":"${PHONE_LOGIN}"}}}' ;;
  "serve status --json")
    other='"${PHONE_HOST}:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}'
    if [ -f "$dir/ts-443" ]; then
      printf '{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true}},"Web":{"${PHONE_HOST}:443":{"Handlers":{"/":{"Proxy":"%s"}}},%s},"AllowFunnel":{"${PHONE_HOST}:8443":true}}' "$(cat "$dir/ts-443")" "$other"
    else
      printf '{"TCP":{"8443":{"HTTPS":true}},"Web":{%s},"AllowFunnel":{"${PHONE_HOST}:8443":true}}' "$other"
    fi ;;
  "serve --bg --https=443 "*) echo "$4" > "$dir/ts-443" ;;
  "serve --https=443 off")
    if [ -f "$dir/ts-443" ]; then rm "$dir/ts-443"; else echo "error: handler does not exist" >&2; exit 1; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

describe("Tailscale's link to the board", () => {
  let s: Daemon;
  let tsDir: string;
  beforeAll(async () => {
    s = await startDaemon({ stubs: { tailscale: SERVING_TAILSCALE } });
    tsDir = s.env.CKANBAN_TAILSCALE.replace(/\/tailscale$/, "");
  }, 60_000);
  afterAll(async () => {
    await s?.stop();
  }, 30_000);
  const calls = () => (existsSync(join(tsDir, "tailscale-calls.log")) ? readFileSync(join(tsDir, "tailscale-calls.log"), "utf8").trim().split("\n") : []);
  const link = () => (existsSync(join(tsDir, "ts-443")) ? readFileSync(join(tsDir, "ts-443"), "utf8").trim() : null);

  test("on, link missing: GET /api/remote puts it back at the phone listener (tailnet only) and says ok", async () => {
    writeRemoteJson(s.home, true);
    const r = await s.api("GET", "/api/remote");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ enabled: true, tailscale: "running", serve: "ok" });
    expect(r.data.serveProblem).toBeUndefined();
    expect(link()).toBe(`http://127.0.0.1:${s.remotePort}`);
    expect(calls()).toContain(`serve --bg --https=443 http://127.0.0.1:${s.remotePort}`);
    // Never Funnel, never the other app's port, never a reset.
    expect(calls().some((c) => /funnel|8443|reset/.test(c))).toBe(false);
    expect(s.log()).toContain(`phone access: Tailscale's link to the board was missing; put it back (https 443 -> 127.0.0.1:${s.remotePort})`);
  });

  test("port 443 taken by another program: left alone, and GET /api/remote says the phone can't reach the board", async () => {
    writeFileSync(join(tsDir, "ts-443"), "http://127.0.0.1:9\n");
    const r = await s.api("GET", "/api/remote");
    expect(r.data).toMatchObject({ enabled: true, serve: "other" });
    expect(r.data.serveProblem).toContain("another program");
    expect(link()).toBe("http://127.0.0.1:9");
    rmSync(join(tsDir, "ts-443"));
  });

  test("off: removes the board's link; off when it is already gone is plain off, no warning", async () => {
    writeFileSync(join(tsDir, "ts-443"), `http://127.0.0.1:${s.remotePort}\n`);
    let r = await s.api("POST", "/api/remote", { enabled: false });
    expect(r.status).toBe(200);
    expect(r.data.enabled).toBe(false);
    expect(r.data.warning).toBeUndefined();
    expect(link()).toBeNull();

    writeRemoteJson(s.home, true);
    r = await s.api("POST", "/api/remote", { enabled: false });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ enabled: false });
    expect(r.data.warning).toBeUndefined();
  });
});
