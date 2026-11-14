import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserMcp, keyEvent } from "../src/browser-mcp";
import { tempDir } from "./helpers";

/** A fake browser endpoint speaking enough of the DevTools protocol for the tools (no real Chrome in tests). */
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
          case "Page.navigate": {
            const t = targets.find((x) => `s-${x.targetId}` === m.sessionId);
            if (t) t.url = m.params.url;
            return reply({ frameId: "f" });
          }
          case "Runtime.evaluate": {
            const e = String(m.params.expression);
            const t = targets.find((x) => `s-${x.targetId}` === m.sessionId);
            if (e === "document.readyState") return reply({ result: { value: "complete" } });
            if (e.startsWith("({ t: document.title")) return reply({ result: { value: { t: "Example", u: t?.url ?? "" } } });
            return reply({ result: { value: "- heading \"Example\" [level=1]" } });
          }
          default:
            return reply({});
        }
      },
    },
  });
  return { server, uuid, targets, calls, path: `/devtools/browser/${uuid}` };
}

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

const text = (r: { content: any[] }) => r.content.map((c) => c.text ?? "").join("\n");

test("a run's browser tools work in a tab of their own and never close someone else's tab", async () => {
  const f = fakeBrowser();
  servers.push(f.server);
  const dir = tempDir("ck-bmcp-");
  writeFileSync(join(dir, "DevToolsActivePort"), `${f.server.port}\n${f.path}`);
  const mcp = new BrowserMcp({ id: "biz", name: "Fatt Interior WhatsApp", dir, out: join(dir, "out") });
  const list: any = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = list.result.tools.map((t: any) => t.name);
  expect(names).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_tabs", "browser_wait_for", "browser_click", "browser_type", "browser_take_screenshot"]));
  const init: any = await mcp.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  expect(init.result.serverInfo.name).toBe("browser-biz");

  const nav = await mcp.call("browser_navigate", { url: "example.com" });
  expect(nav.isError).toBeUndefined();
  expect(text(nav)).toContain("Address: https://example.com/");
  expect(f.calls).toContain("Target.createTarget");
  expect(text(await mcp.call("browser_navigate", { url: "file:///etc/passwd" }))).toContain("only http and https");

  const tabs = text(await mcp.call("browser_tabs", { action: "list" }));
  expect(tabs).toContain("0: WhatsApp - https://web.whatsapp.com/");
  expect(tabs).toMatch(/1: .*\(yours\) \(current\)/);
  const refuse = await mcp.call("browser_tabs", { action: "close", index: 0 });
  expect(refuse.isError).toBe(true);
  expect(text(refuse)).toContain("wasn't opened by this task");

  const snap = text(await mcp.call("browser_snapshot", {}));
  expect(snap).toContain('heading "Example"');

  // The run ends: only its own tab closes.
  await mcp.end();
  expect(f.targets.map((t) => t.targetId)).toEqual(["user-tab"]);
});

test("a browser that isn't running gives a plain answer, and a stale port file isn't trusted", async () => {
  const f = fakeBrowser();
  servers.push(f.server);
  const dir = tempDir("ck-bmcp-");
  mkdirSync(dir, { recursive: true });
  let ensured = 0;
  const mcp = new BrowserMcp({ id: "me", name: "Personal WhatsApp", dir, out: dir, ensure: async () => void ensured++ });
  const r = await mcp.call("browser_snapshot", {});
  expect(r.isError).toBe(true);
  expect(text(r)).toContain(`"Personal WhatsApp" isn't running`);
  expect(ensured).toBe(1);
  // The port answers, but as another Chrome: not used.
  writeFileSync(join(dir, "DevToolsActivePort"), `${f.server.port}\n/devtools/browser/someone-else-0000`);
  expect((await mcp.call("browser_snapshot", {})).isError).toBe(true);
  expect(f.calls).toEqual([]);
});

test("keys", () => {
  expect(keyEvent("Enter")).toEqual({ modifiers: 0, key: "Enter", code: 13, text: "\r" });
  expect(keyEvent("Meta+a")).toEqual({ modifiers: 4, key: "a", code: 65 });
  expect(keyEvent("x")).toEqual({ modifiers: 0, key: "x", code: 88, text: "x" });
  expect(() => keyEvent("Hyper+x")).toThrow();
});
