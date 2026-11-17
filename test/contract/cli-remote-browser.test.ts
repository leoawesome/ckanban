// Outside-in contract for `ckanban remote on|off|status` with a stand-in Tailscale (never the Mac's real one) and for
// `ckanban browser-mcp`, the stdio MCP server a run gets for one board browser, against a fake browser speaking enough
// of the DevTools protocol (no real Chrome). See contracts/cli.md sections 2 and 4. Imports nothing from src/.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { CLI_CMD } from "./daemon";
import { type FakeBoard, fakeBoard, type Sandbox, sandbox } from "./cli-support";

setDefaultTimeout(60_000);

const HOST = "ckmac.tail0000.ts.net";
const LOGIN = "owner@example.com";

let sb: Sandbox;
let fb: FakeBoard;
let listener: ReturnType<typeof Bun.serve>;
let tsDir: string;

/** Tailscale that keeps its serve config in files: ts-443 (the https 443 link), ts-state (BackendState). */
const TAILSCALE = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/tailscale-calls.log"
state=Running; [ -f "$dir/ts-state" ] && state=$(cat "$dir/ts-state")
case "$*" in
  "status --json") echo '{"BackendState":"'"$state"'","Self":{"DNSName":"${HOST}.","UserID":1},"User":{"1":{"LoginName":"${LOGIN}"}}}' ;;
  "serve status --json")
    if [ -f "$dir/ts-443" ]; then printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${HOST}:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}' "$(cat "$dir/ts-443")"; else echo '{}'; fi ;;
  "serve --bg --https=443 "*) echo "$4" > "$dir/ts-443" ;;
  "serve --https=443 off")
    if [ -f "$dir/ts-443" ]; then rm "$dir/ts-443"; else echo "error: handler does not exist" >&2; exit 1; fi ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

beforeAll(() => {
  sb = sandbox("ck-cli-rb-");
  fb = fakeBoard();
  tsDir = join(sb.root, "ts");
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(join(tsDir, "tailscale"), TAILSCALE);
  chmodSync(join(tsDir, "tailscale"), 0o755);
  // The daemon's phone access listener, as `remote on` checks it (its x-ckanban-listener header).
  listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("{}", { headers: { "x-ckanban-listener": "remote" } }) });
});

afterAll(() => {
  listener?.stop(true);
  fb?.stop();
  sb?.cleanup();
});

describe("remote on, status and off", () => {
  const env = () => ({ CKANBAN_TAILSCALE: join(tsDir, "tailscale"), CKANBAN_REMOTE_PORT: String(listener.port) });
  const link = () => (existsSync(join(tsDir, "ts-443")) ? readFileSync(join(tsDir, "ts-443"), "utf8").trim() : null);
  const remoteJson = () => JSON.parse(readFileSync(join(sb.data, "remote.json"), "utf8"));
  /** Phone access is on: the two lines, a blank line, then the QR code (block characters, a square). */
  const expectOn = (stdout: string, middle: string[] = []) => {
    const lines = stdout.replace(/\n$/, "").split("\n");
    expect(lines.slice(0, 2)).toEqual([`Phone access is on: https://${HOST}`, `Only ${LOGIN} can open it, from devices on your tailnet (never public).`]);
    const qr = lines.slice(2 + middle.length + 1);
    expect(lines.slice(2, 2 + middle.length + 1)).toEqual([...middle, ""]);
    expect(qr.length).toBeGreaterThan(10);
    for (const l of qr) {
      expect(l).toMatch(/^[█▀▄ ]+$/);
      expect(l.length).toBe(qr[0].length);
    }
  };

  test("on points Tailscale at the phone listener and saves the login", async () => {
    const r = await sb.run(["remote", "on"], { env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expectOn(r.stdout);
    expect(link()).toBe(`http://127.0.0.1:${listener.port}`);
    expect(remoteJson()).toMatchObject({ enabled: true, host: HOST, allowedLogin: LOGIN });
  });

  test("status while on: the same; another program on 443 is shown as a problem", async () => {
    const r = await sb.run(["remote", "status"], { env: env() });
    expect(r.code).toBe(0);
    expectOn(r.stdout);
    writeFileSync(join(tsDir, "ts-443"), "http://127.0.0.1:9\n");
    const other = await sb.run(["remote"], { env: env() });
    expect(other.code).toBe(0);
    const lines = other.stdout.split("\n");
    expect(lines).toContain("phone access: Tailscale's https port 443 goes to http://127.0.0.1:9, not the board; left as it is");
    expect(other.stdout).toContain("\n\nThe phone can't reach the board: ");
    expect(link()).toBe("http://127.0.0.1:9");
    writeFileSync(join(tsDir, "ts-443"), `http://127.0.0.1:${listener.port}\n`);
  });

  test("status with Tailscale stopped says so; on refuses", async () => {
    writeFileSync(join(tsDir, "ts-state"), "Stopped");
    try {
      const r = await sb.run(["remote", "status"], { env: env() });
      expect(r.code).toBe(0);
      expectOn(r.stdout, ["", `Tailscale is off on this Mac (state: Stopped): phone can't connect. Open the Tailscale app; turn on "Launch Tailscale at login" in its Settings.`]);
      expect(await sb.run(["remote", "on"], { env: env() })).toEqual({
        code: 1, stdout: "", stderr: "Tailscale is not connected (state: Stopped). Install Tailscale (https://tailscale.com/download) and sign in, then try again.\n",
      });
    } finally {
      rmSync(join(tsDir, "ts-state"));
    }
  });

  test("off removes the board's link; off again is plain off", async () => {
    expect(await sb.run(["remote", "off"], { env: env() })).toEqual({ code: 0, stdout: "Phone access is off.\n", stderr: "" });
    expect(link()).toBeNull();
    expect(remoteJson()).toMatchObject({ enabled: false, host: HOST, allowedLogin: LOGIN });
    expect(await sb.run(["remote", "off"], { env: env() })).toEqual({ code: 0, stdout: "Phone access is off.\n", stderr: "" });
  });

  test("on with no phone listener refuses before touching Tailscale's link", async () => {
    const r = await sb.run(["remote", "on"], { env: { ...env(), CKANBAN_REMOTE_PORT: "9" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toStartWith("the daemon's phone access listener isn't on 127.0.0.1:9: restart the daemon");
    expect(link()).toBeNull();
  });
});

/** A fake board browser: /json/version names its WebSocket, which answers the DevTools calls the tools make. */
function fakeBrowser() {
  const uuid = crypto.randomUUID();
  const targets = [{ targetId: "user-tab", type: "page", title: "WhatsApp", url: "https://web.whatsapp.com/" }];
  const calls: string[] = [];
  let n = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/${uuid}` });
      if (srv.upgrade(req, { data: undefined })) return;
      return new Response("no", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw));
        calls.push(m.method);
        const reply = (result: unknown) => void ws.send(JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }));
        const tab = targets.find((x) => `s-${x.targetId}` === m.sessionId);
        switch (m.method) {
          case "Target.createTarget": {
            const targetId = `own-${++n}`;
            targets.push({ targetId, type: "page", title: "", url: m.params.url });
            return reply({ targetId });
          }
          case "Target.attachToTarget":
            return reply({ sessionId: `s-${m.params.targetId}` });
          case "Target.getTargets":
            return reply({ targetInfos: targets });
          case "Target.getTargetInfo":
            if (targets.some((t) => t.targetId === m.params.targetId)) return reply({ targetInfo: {} });
            ws.send(JSON.stringify({ id: m.id, error: { message: "No target" } }));
            return;
          case "Target.closeTarget": {
            const i = targets.findIndex((t) => t.targetId === m.params.targetId);
            if (i >= 0) targets.splice(i, 1);
            return reply({ success: true });
          }
          case "Page.navigate":
            if (tab) tab.url = m.params.url;
            return reply({ frameId: "f" });
          case "Page.captureScreenshot":
            return reply({ data: Buffer.from("fake png").toString("base64") });
          case "Runtime.evaluate": {
            const e = String(m.params.expression);
            if (e === "document.readyState") return reply({ result: { value: "complete" } });
            if (e.startsWith("({ t: document.title")) return reply({ result: { value: { t: "Example", u: tab?.url ?? "" } } });
            if (e === "(() => [1, {a: 'x'}])()") return reply({ result: { value: [1, { a: "x" }] } });
            if (e === "(() => { throw 1 })()") return reply({ exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom\n    at <anonymous>" } } });
            return reply({ result: { value: "- heading \"Example\" [level=1]" } });
          }
          default:
            return reply({});
        }
      },
    },
  });
  return { server, targets, calls, path: `/devtools/browser/${uuid}` };
}

/** `ckanban browser-mcp` as a run starts it: JSON-RPC lines on stdin, answers by id from stdout. */
function browserMcp(args: string[]) {
  const p = Bun.spawn([...CLI_CMD, "browser-mcp", ...args], { env: { ...sb.env, CKANBAN_PORT: String(fb.port) }, cwd: sb.home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const waiting = new Map<number, (v: any) => void>();
  const all: any[] = [];
  void (async () => {
    let buf = "";
    for await (const chunk of p.stdout as any as AsyncIterable<Uint8Array>) {
      buf += new TextDecoder().decode(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        all.push(msg);
        waiting.get(msg.id)?.(msg);
      }
    }
  })();
  let id = 0;
  const ask = (method: string, params?: unknown): Promise<any> => {
    const n = ++id;
    const answer = new Promise((r) => waiting.set(n, r));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, ...(params === undefined ? {} : { params }) }) + "\n");
    p.stdin.flush();
    return answer;
  };
  const call = async (name: string, args: unknown) => (await ask("tools/call", { name, arguments: args })).result;
  return { p, ask, call, all, send: (line: string) => (p.stdin.write(line), p.stdin.flush()) };
}

const text = (r: { content: any[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("browser-mcp", () => {
  test("a run's browser tools work in a tab of their own and never close someone else's tab", async () => {
    const f = fakeBrowser();
    const dir = join(sb.root, "chrome-biz");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "DevToolsActivePort"), `${f.server.port}\n${f.path}`);
    const out = join(sb.root, "shots");
    const m = browserMcp(["--id", "biz", "--name", "Fatt WhatsApp", "--dir", dir, "--out", out]);
    try {
      const init = await m.ask("initialize", { protocolVersion: "2025-03-26" });
      expect(init.result.protocolVersion).toBe("2025-03-26");
      expect(init.result.serverInfo.name).toBe("browser-biz");
      expect(init.result.instructions).toStartWith('Tools for the board browser "Fatt WhatsApp": ');
      const list = (await m.ask("tools/list")).result.tools;
      expect(list.map((t: any) => t.name)).toEqual([
        "browser_tabs", "browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_press_key",
        "browser_select_option", "browser_evaluate", "browser_wait_for", "browser_take_screenshot", "browser_file_upload",
      ]);
      expect(list[1].description).toEndWith(' (Board browser "Fatt WhatsApp".)');
      expect(list[1].inputSchema).toEqual({ type: "object", properties: { url: { type: "string" } }, required: ["url"] });
      expect((await m.ask("ping")).result).toEqual({});
      expect((await m.ask("nope")).error).toEqual({ code: -32601, message: "method not found: nope" });

      const nav = await m.call("browser_navigate", { url: "example.com" });
      expect(nav).toEqual({ content: [{ type: "text", text: "Page: Example\nAddress: https://example.com/" }] });
      expect(await m.call("browser_navigate", { url: "file:///etc/passwd" })).toEqual({ content: [{ type: "text", text: "only http and https pages can be opened" }], isError: true });
      expect(text(await m.call("browser_tabs", { action: "list" }))).toBe("0: WhatsApp - https://web.whatsapp.com/\n1: (no title) - https://example.com/ (yours) (current)");
      expect(await m.call("browser_tabs", { action: "close", index: 0 })).toEqual({ content: [{ type: "text", text: "That tab wasn't opened by this task: leave it open." }], isError: true });
      expect(text(await m.call("browser_tabs", { action: "select", index: 7 }))).toBe("no tab with that number: call browser_tabs with action list");
      expect(text(await m.call("browser_snapshot", {}))).toBe('Page: Example\nAddress: https://example.com/\n\n- heading "Example" [level=1]');
      expect(text(await m.call("browser_evaluate", { function: "() => [1, {a: 'x'}]" }))).toBe('[\n 1,\n {\n  "a": "x"\n }\n]');
      expect(await m.call("browser_evaluate", { function: "() => { throw 1 }" })).toEqual({ content: [{ type: "text", text: "Error: boom" }], isError: true });
      expect(text(await m.call("browser_press_key", { key: "Hyper+x" }))).toBe("unknown modifier Hyper (use Alt, Control, Meta or Shift)");
      expect(text(await m.call("browser_press_key", { key: "Meta+a" }))).toBe("Pressed Meta+a.");
      expect(text(await m.call("browser_wait_for", { time: 0 }))).toBe("Waited 0s.");
      expect(text(await m.call("browser_wait_for", { text: "x" }))).toBe("Ready.\nPage: Example\nAddress: https://example.com/");
      expect(text(await m.call("browser_file_upload", { paths: ["relative.txt"] }))).toBe("no file at relative.txt");
      const shot = await m.call("browser_take_screenshot", { filename: "../My Shot!.PNG" });
      expect(shot.content[0]).toEqual({ type: "image", data: Buffer.from("fake png").toString("base64"), mimeType: "image/png" });
      expect(shot.content[1]).toEqual({ type: "text", text: `Saved to ${join(out, "My-Shot-.png")}` });
      expect(readFileSync(join(out, "My-Shot-.png"), "utf8")).toBe("fake png");
      expect(await m.call("browser_nope", {})).toEqual({ content: [{ type: "text", text: "unknown tool browser_nope" }], isError: true });
      m.send("not json\n");
      await Bun.sleep(300);
      expect(m.all.at(-1)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });

      // The run ends (its input closes): only its own tab closes.
      m.p.stdin.end();
      expect(await m.p.exited).toBe(0);
      expect(f.targets.map((t) => t.targetId)).toEqual(["user-tab"]);
    } finally {
      m.p.kill();
      f.server.stop(true);
    }
  });

  test("a browser that isn't running: the board is asked to start it, then a plain answer; a stale port file isn't trusted", async () => {
    const f = fakeBrowser();
    const dir = join(sb.root, "chrome-me");
    mkdirSync(dir, { recursive: true });
    fb.reset();
    const m = browserMcp(["--id", "me two", "--name", "Personal WhatsApp", "--dir", dir]);
    try {
      const r = await m.call("browser_snapshot", {});
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(`The board browser "Personal WhatsApp" isn't running and couldn't be started. Tell the user it isn't available right now; don't use another browser in its place.`);
      expect(fb.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/board-browsers/me%20two/ensure"]);
      // The port answers, but as another Chrome: not used.
      writeFileSync(join(dir, "DevToolsActivePort"), `${f.server.port}\n/devtools/browser/someone-else-0000`);
      expect((await m.call("browser_snapshot", {})).isError).toBe(true);
      expect(f.calls).toEqual([]);
    } finally {
      m.p.kill();
      f.server.stop(true);
    }
  });
});
