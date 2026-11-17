import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Board } from "../../src/board/board";
import { Bus } from "../../src/core/events";
import { createServer, isAllowedRequest, isAllowedSocket } from "../../src/api/server";
import { chmodSync } from "node:fs";
import { isPhoneListener, parseServe, qrSvg, qrTerminal, RemoteAccess, RemoteError, tailscaleRunner, type RemoteConfig, type TailscaleRunner } from "../../src/integrations/remote";
import { RUN_HEADER } from "../../src/schedules/scheduler";
import { Store } from "../../src/core/store";
import { tempDir } from "../support/helpers";

const HOST = "leos-mbp.tail1234.ts.net";
const LOGIN = "leo@example.com";
const REMOTE: RemoteConfig = { enabled: true, host: HOST, allowedLogin: LOGIN, updatedAt: "" };

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: `${HOST}.`, UserID: 42 },
  User: { "42": { LoginName: LOGIN } },
});

/** Fake `tailscale`: records calls, answers status from `status`, fails commands listed in `fail`. */
function fakeTailscale(status = STATUS, fail: string[] = []) {
  const calls: string[][] = [];
  const fake = { calls, run: null as unknown as TailscaleRunner, status };
  fake.run = async (args) => {
    calls.push(args);
    if (fail.includes(args[0])) return { code: 1, stdout: "", stderr: `${args[0]} broke` };
    if (args[0] === "status") return { code: 0, stdout: fake.status, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return fake;
}

const yes = async () => true;

const req = (url: string, headers: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers });

test("localhost is still allowed, with or without remote access", () => {
  expect(isAllowedRequest(req("http://localhost:7777/api/x"), 7777, REMOTE)).toBe(true);
  expect(isAllowedRequest(req("http://127.0.0.1:7777/api/x"), 7777, null)).toBe(true);
  const post = req("http://localhost:7777/api/x", { origin: "http://localhost:7777" }, "POST");
  expect(isAllowedRequest(post, 7777, REMOTE)).toBe(true);
});

test("remote listener: tailnet host, phone access on, owner's login only", () => {
  const url = `https://${HOST}/api/x`;
  const ok = (r: Request, remote: RemoteConfig | null = REMOTE) => isAllowedRequest(r, 7777, remote, "remote");
  expect(ok(req(url, { "tailscale-user-login": LOGIN }))).toBe(true);
  expect(ok(req(url, { host: `${HOST}:443`, "tailscale-user-login": LOGIN }))).toBe(true);
  expect(ok(req(url, { "tailscale-user-login": "LEO@example.com" }))).toBe(true);
  expect(ok(req(url, { "tailscale-user-login": "mallory@example.com" }))).toBe(false);
  expect(ok(req(url))).toBe(false);
  expect(ok(req(url, { "tailscale-user-login": LOGIN }), null)).toBe(false);
  expect(ok(req(url, { "tailscale-user-login": LOGIN }), { ...REMOTE, host: "other.ts.net" })).toBe(false);
});

test("a forged Host can't cross listeners", () => {
  // serve passes the client's Host through: `Host: localhost` from the tailnet must not count as local.
  const spoof = req(`https://${HOST}/api/x`, { host: "localhost:7777", origin: "http://localhost:7777" }, "POST");
  expect(isAllowedRequest(spoof, 7777, REMOTE, "remote")).toBe(false);
  expect(isAllowedSocket(req(`https://${HOST}/api/x`, { host: "localhost:7777", origin: "http://localhost:7777" }), 7777, REMOTE, "remote")).toBe(false);
  // And the board's own port never takes the tailnet host, login or not.
  expect(isAllowedRequest(req(`https://${HOST}/api/x`, { "tailscale-user-login": LOGIN }), 7777, REMOTE, "local")).toBe(false);
});

test("foreign Origin is refused on remote POST and WebSocket", () => {
  const ok = { "tailscale-user-login": LOGIN };
  const url = `https://${HOST}/api/x`;
  expect(isAllowedRequest(req(url, { ...ok, origin: `https://${HOST}` }, "POST"), 7777, REMOTE, "remote")).toBe(true);
  expect(isAllowedRequest(req(url, { ...ok, origin: "https://evil.com" }, "POST"), 7777, REMOTE, "remote")).toBe(false);
  expect(isAllowedRequest(req(url, { ...ok, origin: "http://localhost:7777" }, "POST"), 7777, REMOTE, "remote")).toBe(false);
  expect(isAllowedSocket(req(url, { ...ok, origin: `https://${HOST}` }), 7777, REMOTE, "remote")).toBe(true);
  expect(isAllowedSocket(req(url, { ...ok, origin: "https://evil.com" }), 7777, REMOTE, "remote")).toBe(false);
  expect(isAllowedSocket(req(url, { origin: `https://${HOST}` }), 7777, REMOTE, "remote")).toBe(false);
  expect(isAllowedSocket(req("http://localhost:7777/api/x", { origin: `https://${HOST}` }), 7777, REMOTE)).toBe(false);
});

test("on: serves the daemon port over HTTPS and saves host + login", async () => {
  const root = tempDir("ck-remote-");
  const ts = fakeTailscale();
  const access = new RemoteAccess(root, () => 7788, ts.run, yes);
  const st = await access.on();
  expect(ts.calls).toEqual([["status", "--json"], ["serve", "--bg", "--https=443", "http://127.0.0.1:7788"]]);
  expect(st).toMatchObject({ enabled: true, url: `https://${HOST}`, host: HOST, allowedLogin: LOGIN });
  expect(JSON.parse(readFileSync(join(root, "remote.json"), "utf8"))).toMatchObject({ enabled: true, host: HOST, allowedLogin: LOGIN });
  expect(access.active()?.host).toBe(HOST);
});

test("on: refuses when the port isn't the daemon's phone listener", async () => {
  const root = tempDir("ck-remote-");
  const ts = fakeTailscale();
  const err = await new RemoteAccess(root, () => 7788, ts.run, async () => false).on().catch((e) => e);
  expect(err).toBeInstanceOf(RemoteError);
  expect(err.message).toContain("phone access listener");
  expect(ts.calls.some((c) => c[0] === "serve")).toBe(false);
  expect(existsSync(join(root, "remote.json"))).toBe(false);
  // No listener at all (port 0) is refused the same way.
  await expect(new RemoteAccess(root, () => 0, ts.run, yes).on()).rejects.toThrow("phone access listener");
});

test("isPhoneListener: only the daemon's phone listener counts", async () => {
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") });
  expect(await isPhoneListener(other.port!)).toBe(false);
  other.stop(true);
});

test("on: clear errors when Tailscale is down, has no DNS name, or serve fails", async () => {
  const root = tempDir("ck-remote-");
  const stopped = fakeTailscale(JSON.stringify({ BackendState: "NeedsLogin" }));
  await expect(new RemoteAccess(root, () => 1, stopped.run, yes).on()).rejects.toThrow("not connected");
  const noDns = fakeTailscale(JSON.stringify({ BackendState: "Running", Self: { DNSName: "", UserID: 1 }, User: {} }));
  await expect(new RemoteAccess(root, () => 1, noDns.run, yes).on()).rejects.toThrow("MagicDNS");
  const serveFails = fakeTailscale(STATUS, ["serve"]);
  const err = await new RemoteAccess(root, () => 1, serveFails.run, yes).on().catch((e) => e);
  expect(err).toBeInstanceOf(RemoteError);
  expect(err.message).toContain("serve broke");
  expect(existsSync(join(root, "remote.json"))).toBe(false);
});

test("on: Serve not enabled on the tailnet gives the enable link", async () => {
  const run: TailscaleRunner = async (args) => args[0] === "status"
    ? { code: 0, stdout: STATUS, stderr: "" }
    : { code: 1, stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n", stderr: "" };
  const err = await new RemoteAccess(tempDir("ck-remote-"), () => 1, run, yes).on().catch((e) => e);
  expect(err).toBeInstanceOf(RemoteError);
  expect(err.message).toContain("https://login.tailscale.com/f/serve?node=abc");
});

test("off: disables first, then removes the serve mapping; warns if tailscale fails", async () => {
  const root = tempDir("ck-remote-");
  const ts = fakeTailscale();
  const access = new RemoteAccess(root, () => 7788, ts.run, yes);
  await access.on();
  let st = await access.off();
  expect(ts.calls.at(-1)).toEqual(["serve", "--https=443", "off"]);
  expect(st.enabled).toBe(false);
  expect(st.warning).toBeUndefined();
  expect(access.active()).toBeNull();

  await access.on();
  st = await new RemoteAccess(root, () => 7788, fakeTailscale(STATUS, ["serve"]).run).off();
  expect(st.enabled).toBe(false);
  expect(st.warning).toContain("serve broke");
  expect(access.active()).toBeNull();
});

test("liveStatus: asks Tailscale only while on; running, stopped or unavailable, never throws", async () => {
  const root = tempDir("ck-remote-");
  const off = fakeTailscale();
  expect((await new RemoteAccess(root, () => 7788, off.run, yes).liveStatus()).tailscale).toBeUndefined();
  expect(off.calls).toEqual([]);

  writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
  const live = (run: TailscaleRunner) => new RemoteAccess(root, () => 7788, run, yes).liveStatus();
  expect(await live(fakeTailscale().run)).toMatchObject({ enabled: true, tailscale: "running", backendState: "Running" });
  const stopped = JSON.stringify({ BackendState: "Stopped" });
  expect(await live(fakeTailscale(stopped).run)).toMatchObject({ enabled: true, tailscale: "stopped", backendState: "Stopped" });
  expect((await live(fakeTailscale(STATUS, ["status"]).run)).tailscale).toBe("unavailable");
  expect((await live(fakeTailscale("{broken").run)).tailscale).toBe("unavailable");
  expect((await live(async () => { throw new RemoteError(424, "tailscale CLI not found"); })).tailscale).toBe("unavailable");
});

const GUI_FAILED = "The Tailscale GUI failed to start: The operation couldn\u2019t be completed. (Tailscale.CLIError error 3.)\n";

test("runner: starts Tailscale with TAILSCALE_BE_CLI=1 and keeps the rest of the environment", async () => {
  const bin = join(tempDir("ck-ts-bin-"), "tailscale");
  writeFileSync(bin, '#!/bin/sh\necho "be_cli=$TAILSCALE_BE_CLI home=$HOME args=$*"\n');
  chmodSync(bin, 0o755);
  const r = await tailscaleRunner(() => bin)(["status", "--json"]);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(`be_cli=1 home=${process.env.HOME} args=status --json`);
});

test("Tailscale opening its app window (exit 0) is a failure, never a success", async () => {
  const gui: TailscaleRunner = async () => ({ code: 0, stdout: GUI_FAILED, stderr: "" });
  const root = tempDir("ck-remote-");
  const err = await new RemoteAccess(root, () => 1, gui, yes).on().catch((e) => e);
  expect(err).toBeInstanceOf(RemoteError);
  expect(err.message).toContain("app window");
  expect(err.message).toContain("Tailscale GUI failed to start");
  expect(existsSync(join(root, "remote.json"))).toBe(false);

  // serve fails the same way after a good status: on() fails, off() warns.
  const serveGui: TailscaleRunner = async (args) => ({ code: 0, stdout: args[0] === "status" ? STATUS : GUI_FAILED, stderr: "" });
  await expect(new RemoteAccess(root, () => 1, serveGui, yes).on()).rejects.toThrow("Tailscale GUI failed to start");
  expect(existsSync(join(root, "remote.json"))).toBe(false);
  writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
  const st = await new RemoteAccess(root, () => 1, serveGui, yes).off();
  expect(st.enabled).toBe(false);
  expect(st.warning).toContain("Tailscale GUI failed to start");

  writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
  expect((await new RemoteAccess(root, () => 1, gui, yes).liveStatus()).tailscale).toBe("unavailable");
});

test("on: status output that isn't JSON shows what Tailscale printed", async () => {
  const run: TailscaleRunner = async () => ({ code: 0, stdout: "something odd\nsecond line\n", stderr: "" });
  const err = await new RemoteAccess(tempDir("ck-remote-"), () => 1, run, yes).on().catch((e) => e);
  expect(err).toBeInstanceOf(RemoteError);
  expect(err.message).toContain("could not read");
  expect(err.message).toContain("something odd\nsecond line");
});

test("config is re-read when remote.json changes (CLI writes, daemon reads)", async () => {
  const root = tempDir("ck-remote-");
  const access = new RemoteAccess(root, () => 1, fakeTailscale().run, yes);
  expect(access.active()).toBeNull();
  writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
  expect(access.active()?.allowedLogin).toBe(LOGIN);
  await Bun.sleep(5);
  writeFileSync(join(root, "remote.json"), JSON.stringify({ ...REMOTE, enabled: false }));
  expect(access.active()).toBeNull();
  writeFileSync(join(root, "remote.json"), "{broken");
  expect(access.config()).toBeNull();
});

test("QR codes render as SVG and terminal blocks", () => {
  expect(qrSvg(`https://${HOST}`)).toStartWith("<svg");
  const lines = qrTerminal(`https://${HOST}`).split("\n");
  expect(lines.length).toBeGreaterThan(10);
  expect(new Set(lines.map((l) => l.length)).size).toBe(1);
});

describe("/api/remote and the phone access listener", () => {
  let server: ReturnType<typeof createServer>;
  let root: string;
  let ts: ReturnType<typeof fakeTailscale>;
  let base: string;
  let tailnet: string;

  beforeAll(() => {
    const store = new Store(tempDir("ck-home-"));
    root = store.root;
    const bus = new Bus();
    ts = fakeTailscale();
    const remote = new RemoteAccess(root, () => server.remoteServer!.port!, ts.run);
    server = createServer({ store, bus, board: new Board(store, bus, { claudeBin: "/bin/false" }), port: 0, remotePort: 0, webDir: tempDir("ck-web-"), remote });
    base = `http://127.0.0.1:${server.port}`;
    tailnet = `http://127.0.0.1:${server.remoteServer!.port}`;
  });
  afterAll(() => {
    server.stop(true);
    server.remoteServer?.stop(true);
  });

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/api/remote`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const owner = { host: HOST, "tailscale-user-login": LOGIN };

  test("turn on, tailnet requests get in with the owner's login only, turn off", async () => {
    let r = await fetch(`${tailnet}/api/profiles`, { headers: owner });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("phone access is off");

    r = await post(base, { enabled: true });
    expect(r.status).toBe(200);
    const st = (await r.json()) as any;
    expect(st).toMatchObject({ enabled: true, url: `https://${HOST}`, allowedLogin: LOGIN, local: true });
    expect(st.qrSvg).toStartWith("<svg");
    expect(ts.calls.at(-1)).toEqual(["serve", "--bg", "--https=443", `http://127.0.0.1:${server.remoteServer!.port}`]);
    expect(await isPhoneListener(server.remoteServer!.port!)).toBe(true);
    expect(await isPhoneListener(server.port!)).toBe(false);

    r = await fetch(`${tailnet}/api/remote`, { headers: owner });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).local).toBe(false);
    r = await fetch(`${tailnet}/api/profiles`, { headers: { ...owner, "tailscale-user-login": "mallory@example.com" } });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("Tailscale");
    // The tailnet host on the board's own port, and Host: localhost on the phone port, are both refused.
    expect((await fetch(`${base}/api/profiles`, { headers: owner })).status).toBe(403);
    r = await post(tailnet, { enabled: "probe" }, { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` });
    expect(r.status).toBe(403);
    // The phone can't flip it, and neither can a board run.
    r = await post(tailnet, { enabled: false }, { ...owner, origin: `https://${HOST}` });
    expect(r.status).toBe(403);
    r = await post(base, { enabled: false }, { [RUN_HEADER]: "x/t_1" });
    expect(r.status).toBe(403);
    expect(((await (await fetch(`${base}/api/remote`)).json()) as any).lastVisit).toBeTruthy();

    // A stopped Tailscale shows on GET even though phone access stays on.
    ts.status = JSON.stringify({ BackendState: "Stopped" });
    expect(await (await fetch(`${base}/api/remote`)).json()).toMatchObject({ enabled: true, tailscale: "stopped", backendState: "Stopped" });
    ts.status = STATUS;
    expect(((await (await fetch(`${base}/api/remote`)).json()) as any).tailscale).toBe("running");

    r = await post(base, { enabled: false });
    expect(((await r.json()) as any).enabled).toBe(false);
    r = await fetch(`${tailnet}/api/profiles`, { headers: owner });
    expect(r.status).toBe(403);
  });
});

/** `tailscale serve status --json` with port 443 sent to `target` (none: nothing on 443), and another app's Funnel on 8443. */
function serveJson(target: string | null, funnel443 = false) {
  const web: Record<string, unknown> = { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } };
  const tcp: Record<string, unknown> = { "8443": { HTTPS: true } };
  if (target) {
    web[`${HOST}:443`] = { Handlers: { "/": { Proxy: target } } };
    tcp["443"] = { HTTPS: true };
  }
  return JSON.stringify({ TCP: tcp, Web: web, AllowFunnel: { [`${HOST}:8443`]: true, ...(funnel443 ? { [`${HOST}:443`]: true } : {}) } });
}

/** Fake `tailscale` that keeps a serve config: `serve --bg --https=443 <url>` sets 443, `serve --https=443 off` clears it. */
function servingTailscale(target: string | null, opts: { funnel443?: boolean; addFails?: boolean } = {}) {
  const calls: string[][] = [];
  const state = { target };
  const run: TailscaleRunner = async (args) => {
    calls.push(args);
    if (args[0] === "status") return { code: 0, stdout: STATUS, stderr: "" };
    if (args.join(" ") === "serve status --json") return { code: 0, stdout: serveJson(state.target, opts.funnel443), stderr: "" };
    if (args[0] === "serve" && args.at(-1) === "off") {
      if (!state.target) return { code: 1, stdout: "", stderr: "error: handler does not exist\n" };
      state.target = null;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "serve" && args[1] === "--bg") {
      if (opts.addFails) return { code: 1, stdout: "", stderr: "serve: permission denied" };
      state.target = args.at(-1)!;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { calls, state, run };
}

const writes = (calls: string[][]) => calls.filter((c) => c[0] === "serve" && c[1] !== "status");

describe("Tailscale's link to the board", () => {
  const onRoot = () => {
    const root = tempDir("ck-remote-");
    writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
    return root;
  };

  test("missing: put back (tailnet only, the board's port), one log line; the other app's Funnel untouched", async () => {
    const ts = servingTailscale(null);
    const lines: string[] = [];
    const access = new RemoteAccess(onRoot(), () => 7778, ts.run, yes);
    expect(await access.checkServe((l) => lines.push(l))).toEqual({ serve: "ok" });
    expect(writes(ts.calls)).toEqual([["serve", "--bg", "--https=443", "http://127.0.0.1:7778"]]);
    expect(ts.calls.flat().some((a) => /funnel|8443|reset/.test(a))).toBe(false);
    expect(lines).toEqual(["phone access: Tailscale's link to the board was missing; put it back (https 443 -> 127.0.0.1:7778)"]);
    // Now there: nothing more to do or log.
    expect(await access.checkServe((l) => lines.push(l))).toEqual({ serve: "ok" });
    expect(writes(ts.calls)).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });

  test("never while off, never at a listener that isn't the board's, never over another link or a Funnel", async () => {
    const offRoot = tempDir("ck-remote-");
    const ts = servingTailscale(null);
    expect(await new RemoteAccess(offRoot, () => 7778, ts.run, yes).checkServe(() => {})).toEqual({});
    expect(ts.calls).toEqual([]);

    const noListener = servingTailscale(null);
    const lines: string[] = [];
    const access = new RemoteAccess(onRoot(), () => 7778, noListener.run, async () => false);
    const r1 = await access.checkServe((l) => lines.push(l));
    expect(r1.serve).toBe("missing");
    expect(r1.serveProblem).toContain("Turn off, then Turn on");
    await access.checkServe((l) => lines.push(l));
    expect(writes(noListener.calls)).toEqual([]);
    expect(lines).toHaveLength(1); // the same problem is logged once

    const other = servingTailscale("http://127.0.0.1:9999");
    expect((await new RemoteAccess(onRoot(), () => 7778, other.run, yes).checkServe(() => {})).serve).toBe("other");
    expect(writes(other.calls)).toEqual([]);

    const pub = servingTailscale(null, { funnel443: true });
    expect((await new RemoteAccess(onRoot(), () => 7778, pub.run, yes).checkServe(() => {})).serve).toBe("public");
    expect(writes(pub.calls)).toEqual([]);
  });

  test("put back fails: liveStatus says so in plain words; unknown answers change nothing", async () => {
    const ts = servingTailscale(null, { addFails: true });
    const st = await new RemoteAccess(onRoot(), () => 7778, ts.run, yes).liveStatus();
    expect(st).toMatchObject({ enabled: true, tailscale: "running", serve: "missing" });
    expect(st.serveProblem).toContain("permission denied");

    const ok = await new RemoteAccess(onRoot(), () => 7778, servingTailscale("http://127.0.0.1:7778").run, yes).liveStatus();
    expect(ok.serve).toBe("ok");
    expect(ok.serveProblem).toBeUndefined();

    // A `tailscale` that prints nothing for serve status (or isn't JSON): no claim either way, nothing changed.
    const quiet = fakeTailscale();
    const q = await new RemoteAccess(onRoot(), () => 7778, quiet.run, yes).liveStatus();
    expect(q.serve).toBeUndefined();
    expect(writes(quiet.calls)).toEqual([]);
  });

  test("off: already gone is plain off; another program's link stays", async () => {
    const gone = servingTailscale(null);
    const st = await new RemoteAccess(onRoot(), () => 7778, gone.run, yes).off();
    expect(st.enabled).toBe(false);
    expect(st.warning).toBeUndefined();
    expect(writes(gone.calls)).toEqual([]);

    // Serve status unreadable, then "handler does not exist": still plain off.
    const odd: TailscaleRunner = async (args) =>
      args.at(-1) === "off" ? { code: 1, stdout: "", stderr: "error: handler does not exist" } : { code: 0, stdout: "", stderr: "" };
    expect((await new RemoteAccess(onRoot(), () => 7778, odd, yes).off()).warning).toBeUndefined();

    const other = servingTailscale("http://127.0.0.1:55123");
    expect((await new RemoteAccess(onRoot(), () => 7778, other.run, yes).off()).warning).toBeUndefined();
    expect(other.state.target).toBe("http://127.0.0.1:55123");

    const mine = servingTailscale("http://127.0.0.1:7778");
    await new RemoteAccess(onRoot(), () => 7778, mine.run, yes).off();
    expect(mine.state.target).toBeNull();
  });
});

test("parseServe: the board's host, TCP forwards and foreground serve/funnel on 443 are another program's", () => {
  const web = (host: string, target: string) => ({ [`${host}:443`]: { Handlers: { "/": { Proxy: target } } } });
  expect(parseServe(JSON.stringify({ Web: web(HOST, "http://127.0.0.1:7778") }), HOST)).toEqual({ kind: "proxy", target: "http://127.0.0.1:7778", funnel: false });
  // An old host's entry isn't the board's link.
  expect(parseServe(JSON.stringify({ Web: web("old.ts.net", "http://127.0.0.1:7778") }), HOST)?.kind).toBe("other");
  expect(parseServe(JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }), HOST)?.kind).toBe("other");
  const fg = { Foreground: { abc: { TCP: { "443": { HTTPS: true } }, Web: web(HOST, "http://127.0.0.1:3000"), AllowFunnel: { [`${HOST}:443`]: true } } } };
  expect(parseServe(JSON.stringify(fg), HOST)).toEqual({ kind: "other", funnel: true });
  expect(parseServe("{}", HOST)).toEqual({ kind: "none" });
  expect(parseServe("null\n", HOST)).toEqual({ kind: "none" });
  expect(parseServe("nope", HOST)).toBeNull();
});

test("off: never removes a TCP forward on 443, nor anything when the board's port is unknown", async () => {
  const root = tempDir("ck-remote-");
  const calls: string[][] = [];
  const tcp: TailscaleRunner = async (args) => {
    calls.push(args);
    return { code: 0, stdout: args[1] === "status" ? JSON.stringify({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }) : "", stderr: "" };
  };
  writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
  expect((await new RemoteAccess(root, () => 7778, tcp, yes).off()).enabled).toBe(false);
  writeFileSync(join(root, "remote.json"), JSON.stringify(REMOTE));
  const ts = servingTailscale("http://127.0.0.1:7778");
  await new RemoteAccess(root, () => 0, ts.run, yes).off();
  expect(ts.state.target).toBe("http://127.0.0.1:7778");
  expect([...calls, ...ts.calls].some((c) => c.at(-1) === "off")).toBe(false);
});
