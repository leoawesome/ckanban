import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserDeps } from "../src/server/board-browsers";

/** A fake Chrome: answers /json/version and /json/list on 127.0.0.1 and quits on Browser.close (no real Chrome in tests). */
export class FakeChrome {
  readonly uuid = crypto.randomUUID();
  closed = false;
  closeCalls = 0;
  pages: { id: string; type: string; title: string; url: string }[] = [{ id: "p1", type: "page", title: "", url: "about:blank" }];
  /** What Runtime.evaluate answers in each tab (the sign-in check), by tab id. */
  answers = new Map<string, unknown>();
  /** Every call made to a tab: [tab id, method, params]. */
  pageCalls: [string, string, any][] = [];
  server: ReturnType<typeof Bun.serve>;
  constructor(public pid: number, quit = true) {
    const self = this;
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req, srv) {
        const u = new URL(req.url);
        if (u.pathname === "/json/version") return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/${self.uuid}` });
        if (u.pathname === "/json/list") return Response.json(self.pages);
        if (u.pathname === `/devtools/browser/${self.uuid}` && srv.upgrade(req, { data: { tab: null } })) return;
        const tab = u.pathname.match(/^\/devtools\/page\/(.+)$/)?.[1];
        if (tab && self.pages.some((p) => p.id === tab) && srv.upgrade(req, { data: { tab } })) return;
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          const m = JSON.parse(String(msg));
          const tab = (ws.data as { tab: string | null } | undefined)?.tab;
          if (tab) {
            self.pageCalls.push([tab, m.method, m.params]);
            const result = m.method === "Runtime.evaluate" ? { result: { type: "string", value: self.answers.get(tab) ?? "unknown" } }
              : m.method === "Page.captureScreenshot" ? { data: Buffer.from("fake-jpeg").toString("base64") }
              : m.method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } }
              : {};
            ws.send(JSON.stringify({ id: m.id, result }));
            return;
          }
          if (m.method === "Browser.close") {
            self.closeCalls++;
            ws.send(JSON.stringify({ id: m.id, result: {} }));
            if (quit) setTimeout(() => self.quit(), 20);
          }
        },
      },
    });
  }
  get port() {
    return this.server.port!;
  }
  get path() {
    return `/devtools/browser/${this.uuid}`;
  }
  quit() {
    this.closed = true;
    this.server.stop(true);
  }
}

/** Every fake started; a test's afterEach quits the ones still running. */
export const fakes: FakeChrome[] = [];

/** Deps where spawn starts a FakeChrome and writes its DevToolsActivePort, like Chrome does. */
export function harness(_root: string, extra: Partial<BrowserDeps> & { quit?: boolean } = {}) {
  let pid = 1000;
  let clock = 1_000_000;
  const spawned: string[][] = [];
  const byPid = new Map<number, FakeChrome>();
  const headless = new Set<number>();
  const deps: BrowserDeps = {
    chromeBin: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    spawn: (argv) => {
      spawned.push(argv);
      const dir = argv.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      const f = new FakeChrome(++pid, extra.quit ?? true);
      fakes.push(f);
      byPid.set(f.pid, f);
      if (argv.includes("--headless=new")) headless.add(f.pid);
      writeFileSync(join(dir, "DevToolsActivePort"), `${f.port}\n${f.path}`);
      return { pid: f.pid };
    },
    owner: async (port) => {
      const f = [...byPid.values()].find((x) => x.port === port && !x.closed);
      return f ? { pid: f.pid, headless: headless.has(f.pid) } : { error: "nothing listens on its port" };
    },
    alive: (p) => !!byPid.get(p) && !byPid.get(p)!.closed,
    chromeMajor: async () => "157",
    log: () => {},
    now: () => clock,
    pollMs: 5,
    closeTimeoutMs: 2000,
    startTimeoutMs: 2000,
    ...extra,
  };
  return { deps, spawned, byPid, advance: (ms: number) => (clock += ms) };
}

